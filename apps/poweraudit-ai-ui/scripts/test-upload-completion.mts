// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Regression test for the "Uploading 100% forever" bug.
 *
 * OBSERVED: Server Monitor showed bill-ingestion-app.dropper_1 COMPLETED in
 * 1m59s, yet the UI sat on "Uploading 100%" for 30+ minutes and no Bill row
 * was ever written.
 *
 * ROOT CAUSE: completion is not event-driven at all - the client simply
 * awaits client.sendFiles()'s promise - and the SDK applies NO request
 * timeout by default (`requestTimeout`: "default per-request timeout in ms
 * (default: none)"). If the response is lost (e.g. the socket drops during
 * the ~2 minutes of OCR + LLM work), that promise never settles and the
 * await hangs forever. Because the SQL writes happen in THIS CLIENT after
 * sendFiles returns, a lost response also means the writes are never
 * attempted - which is why the row was missing. One failure, not two.
 *
 * This test covers both halves:
 *   A. HAPPY PATH - a real upload completes, and the client observes
 *      completion promptly and acts on it (stage reaches 'done', the Bill
 *      row lands). Also records how long completion took, so a future
 *      regression to "hangs forever" fails loudly instead of silently.
 *   B. SAFEGUARD - with the timeout forced tiny, a non-responding send is
 *      surfaced as a clear TIMEOUT result with actionable text, rather than
 *      hanging. Confirms it settles fast and reports honestly that nothing
 *      was saved.
 *
 * Run: cd apps/poweraudit-ai-ui && pnpm dlx tsx scripts/test-upload-completion.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RocketRideClient } from 'rocketride';
import { getFoundationToken, sqlQuery } from '../src/lib/db';
import { getUploadState, noteTaskEvent, startUpload, subscribeUpload, TASK_END_GRACE_MS, __resetUploadStoreForTests } from '../src/lib/uploadStore';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const FIXTURE = path.join(REPO_ROOT, 'scripts', 'synthetic_bills', 'clean_01_M001.pdf');

/** Upper bound for a legitimate run, matching billIngestion's SEND_TIMEOUT_MS.
 * Anything beyond this means we are back to a hanging await. Note a real
 * measured run took 175.9s, which is why the production timeout was raised
 * from 180s to 300s - see SEND_TIMEOUT_MS's comment. */
const MAX_ACCEPTABLE_MS = 300_000;

function loadEnv(): Record<string, string> {
	const text = fs.readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
	const env: Record<string, string> = {};
	for (const line of text.split('\n')) {
		// Strip a trailing CR first: JS '.' does not match a carriage return,
		// so a CRLF .env silently parses to zero keys and every call then
		// fails with a confusing 'No authorization provided'.
		const m = line.replace(/\r$/, '').match(/^([A-Z_]+)=(.*)$/);
		if (m) env[m[1]] = m[2].trim();
	}
	return env;
}

let failures = 0;
function check(condition: boolean, label: string): void {
	if (condition) console.log(`PASS  ${label}`);
	else {
		console.log(`FAIL  ${label}`);
		failures++;
	}
}

async function main() {
	const env = loadEnv();
	const pipeline = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'pipelines', 'bill-ingestion.pipe'), 'utf8'));
	const client: any = new RocketRideClient({ uri: env.ROCKETRIDE_URI, auth: env.ROCKETRIDE_APIKEY });
	await client.connect();

	const stamp = `${process.pid}_${Math.floor(Date.now() / 1000)}`;
	const okName = `completiontest_M001_${stamp}.pdf`;
	const timeoutName = `timeouttest_M001_${stamp}.pdf`;
	const okBillId = `bill-${okName.replace(/\.[^.]+$/, '')}`;
	const timeoutBillId = `bill-${timeoutName.replace(/\.[^.]+$/, '')}`;
	let sqlToken: string | null = null;
	const cleanupIds: string[] = [okBillId, timeoutBillId];

	try {
		sqlToken = await getFoundationToken(client);
		if (!sqlToken) throw new Error('foundation-sql pipeline is not running');
		const buf = fs.readFileSync(FIXTURE);

		// ---------- A. HAPPY PATH ----------
		console.log('--- A. Real upload: does the client observe completion and act on it? ---');
		__resetUploadStoreForTests();

		// Record when the store actually transitions to 'done' - i.e. when the
		// client REACTS to completion, not merely when the server finishes.
		let doneAtMs: number | null = null;
		const started = Date.now();
		subscribeUpload(() => {
			if (doneAtMs === null && getUploadState().stage === 'done') doneAtMs = Date.now();
		});

		await startUpload(client, new File([buf], okName, { type: 'application/pdf' }), pipeline);
		const elapsed = Date.now() - started;

		console.log(`  Client reached stage='done' after ${(elapsed / 1000).toFixed(1)}s.`);
		check(getUploadState().stage === 'done', "client acted on completion: stage reached 'done' (not stuck on 'uploading')");
		check(doneAtMs !== null, 'subscribers were notified of completion (the UI would have re-rendered)');
		check(elapsed < MAX_ACCEPTABLE_MS, `completion was observed within ${MAX_ACCEPTABLE_MS / 1000}s (took ${(elapsed / 1000).toFixed(1)}s)`);

		const res = getUploadState().result;
		check(res?.status === 'OK' || res?.status === 'NEEDS_REVIEW', `upload reported a real outcome (status=${res?.status})`);
		check(getUploadState().slow === false, 'the slow-warning flag is cleared once the upload finishes');

		const okRows = await sqlQuery<{ bill_id: string }>(client, sqlToken, 'SELECT bill_id FROM bill WHERE bill_id = $1', [okBillId]);
		check(okRows.length === 1, 'the Bill row actually landed in RocketRide SQL (the writes ran after completion)');

		// ---------- B. SAFEGUARD ----------
		console.log('\n--- B. Lost response: does it surface clearly instead of hanging? ---');
		__resetUploadStoreForTests();
		const tStart = Date.now();
		await startUpload(client, new File([buf], timeoutName, { type: 'application/pdf' }), pipeline, { sendTimeoutMs: 1 });
		const tElapsed = Date.now() - tStart;

		const tResult = getUploadState().result;
		console.log(`  Settled in ${(tElapsed / 1000).toFixed(1)}s with status=${tResult?.status}`);
		check(getUploadState().stage === 'done', 'a lost response still ends in a terminal state, not an endless spinner');
		check(tResult?.status === 'TIMEOUT', 'it is reported as TIMEOUT, distinct from a generic error');
		check(tElapsed < 30_000, 'it settles promptly rather than hanging');
		check((tResult?.reasons.join(' ') ?? '').includes('nothing was saved'), 'the message states plainly that nothing was saved');
		check((tResult?.reasons.join(' ') ?? '').includes('Re-uploading is safe'), 'the message tells the user what to do next');

		const timedOutRows = await sqlQuery<{ bill_id: string }>(client, sqlToken, 'SELECT bill_id FROM bill WHERE bill_id = $1', [timeoutBillId]);
		check(timedOutRows.length === 0, 'and that claim is true: no Bill row was written on the timeout path');
		// ---------- C. THE MISSING WIRE ----------
		// Replays the exact captured console event that used to be discarded:
		//   apaevt_task {"action":"end","name":"bill-ingestion-app.dropper_1"}
		// Before the fix App.tsx early-returned on any event that wasn't
		// apaevt_status_upload, so this reached the browser and nothing
		// consumed it. Now it must be consumed, and must resolve a lost
		// response within the grace window instead of the 300s backstop.
		console.log('\n--- C. apaevt_task "end" is actually consumed ---');
		__resetUploadStoreForTests();
		const lostName = `lostresponse_M001_${stamp}.pdf`;
		const lostBillId = `bill-${lostName.replace(/\.[^.]+$/, '')}`;
		cleanupIds.push(lostBillId);

		const cStart = Date.now();
		// A deliberately huge sendTimeout means the 300s backstop can NOT be
		// what rescues this - only the task-end wire can.
		// taskEndGraceMs is forced tiny so this is deterministic: a real
		// upload can legitimately finish inside the default 20s window, which
		// would make the case race rather than test what it claims to.
		const pending = startUpload(client, new File([buf], lostName, { type: 'application/pdf' }), pipeline, { sendTimeoutMs: 3_600_000, taskEndGraceMs: 1 });

		// Wait for the upload to be genuinely in flight, then replay the event.
		await new Promise((r) => setTimeout(r, 1500));
		check(getUploadState().serverFinished === false, 'before the event: store does not yet think the server finished');

		noteTaskEvent({ action: 'end', name: 'bill-ingestion-app.dropper_1', source: 'dropper_1' });
		check(getUploadState().serverFinished === true, 'apaevt_task "end" WAS consumed - the store reacted to it');

		// An unrelated pipeline's task-end must not hijack our upload.
		__hasNotHijacked(() => noteTaskEvent({ action: 'end', name: 'poweraudit-foundation-sql.tools_1', source: 'tools_1' }));

		await pending;
		const cElapsed = Date.now() - cStart;
		const cResult = getUploadState().result;
		console.log(`  Settled ${(cElapsed / 1000).toFixed(1)}s after start, status=${cResult?.status}`);

		check(getUploadState().stage === 'done', 'the upload reached a terminal state instead of hanging forever');
		check(cResult?.status === 'TIMEOUT', 'a lost response after task-end is reported as TIMEOUT');
		check(cElapsed < TASK_END_GRACE_MS + 20_000, `resolved via the task-end wire (${(cElapsed / 1000).toFixed(1)}s), not the 300s backstop`);
		check(
			(cResult?.reasons.join(' ') ?? '').includes('never reached this browser'),
			'the message explains precisely what happened: server finished, result never arrived'
		);

	} finally {
		if (sqlToken) {
			try {
				for (const id of cleanupIds) {
					await sqlQuery(client, sqlToken, 'DELETE FROM finding WHERE bill_id = $1', [id]);
					await sqlQuery(client, sqlToken, 'DELETE FROM bill WHERE bill_id = $1', [id]);
				}
				console.log('\nCleaned up test rows.');
			} catch (e) {
				console.error('WARNING: cleanup failed:', e);
			}
		}
		await client.disconnect();
	}

	console.log(`\n${failures === 0 ? 'PASSED' : 'FAILED'}: ${failures} failing check(s)`);
	if (failures > 0) process.exit(1);
}

function __hasNotHijacked(fn: () => void): void {
	const before = getUploadState().serverFinished;
	fn();
	check(getUploadState().serverFinished === before, "another pipeline's task-end event is correctly ignored");
}

main().catch((e) => {
	console.error('FATAL:', e);
	process.exit(1);
});
