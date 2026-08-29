// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Unit test for src/lib/retry.ts's withRetries() - the actual automatic-
 * retry primitive uploadStore.startUpload() now wraps every upload attempt
 * in. Deliberately zero RocketRide connections and zero tokens spent: this
 * tests the ORCHESTRATION (does it call the right number of times, wait the
 * right amount, give up correctly, succeed on a later attempt) against a
 * fully controllable mock function, which is the one dimension of "does the
 * fix work" that doesn't require a live server at all - and per the
 * explicit token-cost constraint, live uploads are for confirming the real
 * upload path integrates with this (see test-upload-completion.mts), not
 * for re-proving the retry loop itself.
 *
 * Run: cd apps/poweraudit-ai-ui && pnpm dlx tsx scripts/test-retry.mts
 */
import { withRetries } from '../src/lib/retry';

let failures = 0;
function check(condition: boolean, label: string): void {
	if (condition) console.log(`PASS  ${label}`);
	else {
		console.log(`FAIL  ${label}`);
		failures++;
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	// --- A. Succeeds on the first try: no retry machinery engages at all ---
	{
		let calls = 0;
		let retryCalls = 0;
		const result = await withRetries(
			async () => {
				calls++;
				return 'ok';
			},
			{ attempts: 3, delayMs: 10, onRetry: () => retryCalls++ },
		);
		check(result === 'ok', 'A: returns the successful result');
		check(calls === 1, `A: called exactly once (was ${calls})`);
		check(retryCalls === 0, 'A: onRetry never fires when the first attempt succeeds');
	}

	// --- B. Fails twice, succeeds on the third: recovers automatically ---
	{
		let calls = 0;
		const retrySeen: Array<{ next: number; total: number }> = [];
		const start = Date.now();
		const result = await withRetries(
			async () => {
				calls++;
				if (calls < 3) throw new Error(`transient failure #${calls}`);
				return 'recovered';
			},
			{
				attempts: 3,
				delayMs: 200,
				onRetry: (next, total) => retrySeen.push({ next, total }),
			},
		);
		const elapsed = Date.now() - start;
		check(result === 'recovered', 'B: the eventual success is returned, not an error');
		check(calls === 3, `B: made exactly 3 attempts (was ${calls})`);
		check(retrySeen.length === 2, `B: onRetry fired exactly twice (was ${retrySeen.length})`);
		check(JSON.stringify(retrySeen) === JSON.stringify([{ next: 2, total: 3 }, { next: 3, total: 3 }]), 'B: onRetry reports the correct attempt numbers in order');
		check(elapsed >= 400 && elapsed < 1000, `B: respected the delay between attempts (~400ms expected, took ${elapsed}ms)`);
	}

	// --- C. Every attempt fails: gives up after the configured count ---
	{
		let calls = 0;
		let threw: unknown = null;
		try {
			await withRetries(
				async () => {
					calls++;
					throw new Error(`always fails #${calls}`);
				},
				{ attempts: 3, delayMs: 5 },
			);
		} catch (e) {
			threw = e;
		}
		check(calls === 3, `C: stopped after exactly 3 attempts, not fewer or more (was ${calls})`);
		check(threw instanceof Error && threw.message === 'always fails #3', 'C: throws the LAST error, not the first');
	}

	// --- D. attempts: 1 means no retrying at all - a real failure surfaces immediately ---
	{
		let calls = 0;
		let threw: unknown = null;
		const start = Date.now();
		try {
			await withRetries(
				async () => {
					calls++;
					throw new Error('single-attempt failure');
				},
				{ attempts: 1, delayMs: 5000 },
			);
		} catch (e) {
			threw = e;
		}
		const elapsed = Date.now() - start;
		check(calls === 1, 'D: attempts:1 makes exactly one call');
		check(threw instanceof Error, 'D: the failure propagates');
		check(elapsed < 500, `D: no delay is incurred when there is nothing left to retry (took ${elapsed}ms)`);
	}

	// --- E. A successful RESULT (not a thrown error) is never retried, even
	//     if the caller's business logic considers it a "bad" outcome - the
	//     decision of what's retryable lives in what the wrapped function
	//     throws vs. returns, not in withRetries itself. This mirrors
	//     uploadStore: a normal REJECTED/NEEDS_REVIEW IngestResult resolves
	//     normally and must never trigger a retry; only a thrown failure
	//     (billIngestion re-throwing when nothing was saved) does. ---
	{
		let calls = 0;
		const result = await withRetries(
			async () => {
				calls++;
				return { status: 'REJECTED' as const };
			},
			{ attempts: 3, delayMs: 10 },
		);
		check(calls === 1, 'E: a resolved (non-throwing) business outcome is never retried');
		check(result.status === 'REJECTED', 'E: the real outcome is returned as-is');
	}

	await sleep(0); // flush any stray timers before reporting
	console.log(`\n${failures === 0 ? 'PASSED' : 'FAILED'}: ${failures} failing check(s)`);
	if (failures > 0) process.exit(1);
}

main().catch((e) => {
	console.error('FATAL:', e);
	process.exit(1);
});
