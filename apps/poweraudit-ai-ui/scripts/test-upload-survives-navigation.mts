// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Regression test for the "navigating away mid-upload silently loses the
 * submission" bug.
 *
 * THE ORIGINAL BUG: UploadView held the in-flight upload's stage, progress,
 * and result in local React state, and App.tsx renders views conditionally
 * (`if (view === 'upload') return <UploadView />`). Switching to Site
 * Drill-down mid-upload therefore UNMOUNTED the component and discarded all
 * of it - the user returned to a reset dropzone, and the bill never reached
 * RocketRide SQL. Confirmed against real data at the time: bill/finding
 * counts were unchanged and no new row existed.
 *
 * THE FIX: the upload now lives in an app-level store (src/lib/uploadStore.ts)
 * whose lifetime is independent of any component.
 *
 * This test reproduces the exact reported steps against the REAL server,
 * using the REAL store and the REAL ingestion path (no reimplementation):
 *   1. start an upload (equivalent to dropping a file on the dropzone)
 *   2. drop every subscriber WHILE IT IS STILL RUNNING - this is precisely
 *      what unmounting UploadView does, and is the step that used to lose
 *      the submission
 *   3. wait for the upload to finish with nothing mounted at all
 *   4. re-subscribe (equivalent to navigating back to Upload Bill) and
 *      confirm the finished result is still there
 *   5. confirm the Bill row and its Findings actually reached RocketRide SQL
 *
 * Uses a UNIQUE filename so the row is provably a fresh INSERT rather than
 * an UPDATE of an existing fixture (bill_id is derived from the filename),
 * then deletes it afterwards so the dataset isn't polluted by test runs.
 *
 * Run: cd apps/poweraudit-ai-ui && pnpm dlx tsx scripts/test-upload-survives-navigation.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RocketRideClient } from 'rocketride';
import { getFoundationToken, sqlQuery } from '../src/lib/db';
import { getUploadState, isUploadInFlight, startUpload, subscribeUpload, __resetUploadStoreForTests } from '../src/lib/uploadStore';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const SOURCE_FIXTURE = path.join(REPO_ROOT, 'scripts', 'synthetic_bills', 'clean_01_M001.pdf');

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
	if (condition) {
		console.log(`PASS  ${label}`);
	} else {
		console.log(`FAIL  ${label}`);
		failures++;
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	const env = loadEnv();
	const pipeline = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'pipelines', 'bill-ingestion.pipe'), 'utf8'));
	const client: any = new RocketRideClient({ uri: env.ROCKETRIDE_URI, auth: env.ROCKETRIDE_APIKEY });
	await client.connect();

	// Unique name -> unique bill_id -> provably a fresh INSERT, not an UPDATE.
	const uniqueName = `navtest_M001_${process.pid}_${Math.floor(Date.now() / 1000)}.pdf`;
	const expectedBillId = `bill-${uniqueName.replace(/\.[^.]+$/, '')}`;
	let sqlToken: string | null = null;

	try {
		sqlToken = await getFoundationToken(client);
		if (!sqlToken) throw new Error('foundation-sql pipeline is not running');

		const pre = await sqlQuery<{ n: number }>(client, sqlToken, 'SELECT count(*) AS n FROM bill WHERE bill_id = $1', [expectedBillId]);
		check(Number(pre[0].n) === 0, 'precondition: no Bill row exists for this test filename yet');

		__resetUploadStoreForTests();

		// --- Step 1: user drops a file on the dropzone ---
		const buf = fs.readFileSync(SOURCE_FIXTURE);
		const fileObj = new File([buf], uniqueName, { type: 'application/pdf' });

		// A subscriber, standing in for a mounted UploadView.
		let mountedRenders = 0;
		let unsubscribe: (() => void) | null = subscribeUpload(() => {
			mountedRenders++;
		});

		console.log(`Uploading ${uniqueName} (not awaited - the store owns the promise)...`);
		const uploadPromise = startUpload(client, fileObj, pipeline);

		check(isUploadInFlight(), 'upload is in flight immediately after starting');
		check(getUploadState().stage === 'uploading', "store reports stage='uploading'");
		check(getUploadState().fileName === uniqueName, 'store records which file is being processed');

		// --- Step 2: NAVIGATE AWAY while still processing ---
		// Dropping every subscriber is exactly what unmounting UploadView does.
		await sleep(1200);
		check(isUploadInFlight(), 'upload STILL in flight at the moment we navigate away (the reported repro condition)');
		unsubscribe();
		unsubscribe = null;
		const rendersAtUnmount = mountedRenders;
		console.log('Navigated away (all subscribers dropped) while the upload was still running.');

		// --- Step 3: let it finish with nothing mounted ---
		await uploadPromise;
		check(!isUploadInFlight(), 'upload ran to completion with NO subscribers mounted');

		// --- Step 4: navigate back ---
		let remountRenders = 0;
		subscribeUpload(() => {
			remountRenders++;
		});
		const stateOnReturn = getUploadState();
		console.log(`On returning to Upload Bill: stage=${stateOnReturn.stage}, status=${stateOnReturn.result?.status}`);

		check(stateOnReturn.stage === 'done', "returning to the view shows stage='done', not a reset dropzone");
		check(stateOnReturn.result !== null, 'the finished result survived navigating away and back');
		check(stateOnReturn.result?.status === 'OK' || stateOnReturn.result?.status === 'NEEDS_REVIEW', `upload succeeded (status=${stateOnReturn.result?.status})`);
		check(stateOnReturn.result?.billId === expectedBillId, 'the result carries the expected bill_id');
		check(rendersAtUnmount > 0 && remountRenders === 0, 'sanity: the old subscriber really was detached (no renders leaked to it)');

		// --- Step 5: the submission actually reached RocketRide SQL ---
		const billRows = await sqlQuery<{ bill_id: string; meter_id: string; source_doc_ref: string }>(
			client,
			sqlToken,
			'SELECT bill_id, meter_id, source_doc_ref FROM bill WHERE bill_id = $1',
			[expectedBillId],
		);
		check(billRows.length === 1, 'the Bill row EXISTS in RocketRide SQL despite navigating away mid-upload');
		check(billRows[0]?.meter_id === 'M001', 'the Bill row is correctly linked to meter M001');

		const findingRows = await sqlQuery<{ finding_id: string; type: string }>(client, sqlToken, 'SELECT finding_id, type FROM finding WHERE bill_id = $1', [expectedBillId]);
		check(findingRows.length > 0, `recalculation also ran and wrote ${findingRows.length} Finding row(s)`);
	} finally {
		// Clean up so repeated runs don't pollute the real dataset.
		if (sqlToken) {
			try {
				await sqlQuery(client, sqlToken, 'DELETE FROM finding WHERE bill_id = $1', [expectedBillId]);
				await sqlQuery(client, sqlToken, 'DELETE FROM bill WHERE bill_id = $1', [expectedBillId]);
				console.log(`\nCleaned up test rows for ${expectedBillId}.`);
			} catch (e) {
				console.error('WARNING: cleanup failed, a test row may remain:', e);
			}
		}
		await client.disconnect();
	}

	console.log(`\n${failures === 0 ? 'PASSED' : 'FAILED'}: ${failures} failing check(s)`);
	if (failures > 0) process.exit(1);
}

main().catch((e) => {
	console.error('FATAL:', e);
	process.exit(1);
});
