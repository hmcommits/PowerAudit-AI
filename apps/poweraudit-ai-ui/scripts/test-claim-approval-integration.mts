// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Claim approval integration test: exercises the REAL interactive approval
 * path (src/lib/claimActions.ts -> src/lib/claimWorkflow.ts) against real
 * claims already in RocketRide SQL, the same pattern
 * test-upload-integration.mts uses for the upload flow.
 *
 * Three checks, against real data:
 *  1. M001's real draft claim: a direct draft -> approved_ready_to_file
 *     attempt is rejected and leaves the claim at 'draft'; then submit ->
 *     approve with a name succeeds and PERSISTS in RocketRide SQL.
 *  2. M002's real Rs.53,000 claim: approving with no name (empty string,
 *     whitespace-only, and null) is rejected every time, and the claim is
 *     still sitting at pending_approval afterward - never silently
 *     advanced - matching what scripts/claim_actions.py already proved
 *     for this exact claim in an earlier session (see README's "Built &
 *     Verified").
 *
 * M002's claim was already approved_ready_to_file (approver "Rajesh Kumar,
 * Plant Finance Head") from that earlier Python-path demo. To re-run the
 * guard fresh through the TypeScript path, this script resets it to
 * pending_approval/no-approver first (plain SQL - reconstructing its
 * pre-approval state for the test, NOT a state-machine transition) and
 * restores the original approved state + approver afterward, so the real
 * recorded history isn't left altered by this test run.
 *
 * NOT RE-RUNNABLE, BY DESIGN: check 1's M001 approval is a real, persisted
 * state change (draft -> approved_ready_to_file), same as
 * test-upload-integration.mts writing real Bill rows - it isn't undone
 * afterward. A second run will correctly fail at "No 'draft' M001 claim
 * found" because the one draft claim check 1 needs was consumed by the
 * first run's real approval; that failure means the first run worked, not
 * that something regressed. To re-run check 1 from scratch, draft a new
 * material M001 finding (e.g. via scripts/draft_claims.py against a fresh
 * bill) first. Check 2 IS safe to re-run any number of times - it restores
 * M002's claim to its original state every time.
 *
 * Run: cd apps/poweraudit-ai-ui && pnpm dlx tsx scripts/test-claim-approval-integration.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RocketRideClient } from 'rocketride';
import { getFoundationToken, sqlQuery } from '../src/lib/db';
import { approveClaimAction, submitClaimAction } from '../src/lib/claimActions';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

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

interface ClaimSummaryRow {
	claim_id: string;
	status: string;
	approver: string | null;
	rupee_impact: number;
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

async function fetchClaim(client: any, token: string, claimId: string): Promise<{ status: string; approver: string | null }> {
	const rows = await sqlQuery<{ status: string; approver: string | null }>(client, token, 'SELECT status, approver FROM claim WHERE claim_id = $1', [claimId]);
	if (rows.length === 0) throw new Error(`claim not found: ${claimId}`);
	return rows[0];
}

async function setStatusDirect(client: any, token: string, claimId: string, status: string, approver: string | null): Promise<void> {
	await sqlQuery(client, token, 'UPDATE claim SET status = $1, approver = $2 WHERE claim_id = $3', [status, approver, claimId]);
}

async function main() {
	const env = loadEnv();
	const client: any = new RocketRideClient({ uri: env.ROCKETRIDE_URI, auth: env.ROCKETRIDE_APIKEY });
	await client.connect();

	try {
		const token = await getFoundationToken(client);
		if (!token) throw new Error('foundation-sql pipeline is not running');

		const m001Claims = await sqlQuery<ClaimSummaryRow>(
			client,
			token,
			`SELECT c.claim_id, c.status, c.approver, f.rupee_impact
			 FROM claim c JOIN finding f ON f.finding_id = c.finding_id
			 WHERE f.meter_id = 'M001' ORDER BY c.created_at`,
		);
		const m001Draft = m001Claims.find((c) => c.status === 'draft');
		if (!m001Draft) throw new Error("No 'draft' M001 claim found to test approval against - re-run scripts/draft_claims.py");

		const m002Claims = await sqlQuery<ClaimSummaryRow>(
			client,
			token,
			`SELECT c.claim_id, c.status, c.approver, f.rupee_impact
			 FROM claim c JOIN finding f ON f.finding_id = c.finding_id
			 WHERE f.meter_id = 'M002' ORDER BY c.created_at`,
		);
		const m002 = m002Claims.find((c) => Math.abs(c.rupee_impact - 53000) < 0.01);
		if (!m002) throw new Error('No Rs.53,000 M002 claim found to test rejection against');

		console.log(`M001 draft claim under test: ${m001Draft.claim_id} (Rs.${m001Draft.rupee_impact})`);
		console.log(`M002 claim under test: ${m002.claim_id} (Rs.${m002.rupee_impact}), currently status=${m002.status}, approver=${m002.approver}`);

		// --- 1a. draft -> approved_ready_to_file directly must fail ---
		let directAttemptThrew = false;
		try {
			await approveClaimAction(client, m001Draft.claim_id, 'Someone');
		} catch {
			directAttemptThrew = true;
		}
		check(directAttemptThrew, 'M001: direct draft -> approved_ready_to_file attempt is rejected');
		const afterDirectAttempt = await fetchClaim(client, token, m001Draft.claim_id);
		check(afterDirectAttempt.status === 'draft', 'M001: still status=draft after the rejected direct-approve attempt');

		// --- 1b. submit -> approve with a name succeeds and persists ---
		const submitResult = await submitClaimAction(client, m001Draft.claim_id);
		check(submitResult.status === 'pending_approval', 'M001: submitClaimAction moved draft -> pending_approval');
		const afterSubmit = await fetchClaim(client, token, m001Draft.claim_id);
		check(afterSubmit.status === 'pending_approval', 'M001: pending_approval persisted in RocketRide SQL');

		const approverName = 'Priya Sharma, Facilities Manager';
		const approveResult = await approveClaimAction(client, m001Draft.claim_id, approverName);
		check(approveResult.status === 'approved_ready_to_file', 'M001: approveClaimAction returned approved_ready_to_file');
		const afterApprove = await fetchClaim(client, token, m001Draft.claim_id);
		check(afterApprove.status === 'approved_ready_to_file', 'M001: approved_ready_to_file persisted in RocketRide SQL');
		check(afterApprove.approver === approverName, 'M001: approver name persisted in RocketRide SQL');

		// --- 2. M002's Rs.53,000 claim cannot be approved with no name ---
		const m002Original = { status: m002.status, approver: m002.approver };
		await setStatusDirect(client, token, m002.claim_id, 'pending_approval', null);
		const m002Reset = await fetchClaim(client, token, m002.claim_id);
		check(m002Reset.status === 'pending_approval' && m002Reset.approver === null, 'M002: test fixture reset to pending_approval/no-approver');

		for (const badApprover of ['', '   ', null]) {
			let rejected = false;
			try {
				await approveClaimAction(client, m002.claim_id, badApprover as unknown as string);
			} catch {
				rejected = true;
			}
			check(rejected, `M002: approve with approver=${JSON.stringify(badApprover)} is rejected`);
		}
		const afterRejectedAttempts = await fetchClaim(client, token, m002.claim_id);
		check(afterRejectedAttempts.status === 'pending_approval', 'M002: still sitting at pending_approval after all rejected attempts, not silently advanced');
		check(afterRejectedAttempts.approver === null, 'M002: approver still unset after all rejected attempts');

		// --- restore M002's real recorded history ---
		await setStatusDirect(client, token, m002.claim_id, m002Original.status, m002Original.approver);
		const restored = await fetchClaim(client, token, m002.claim_id);
		check(restored.status === m002Original.status && restored.approver === m002Original.approver, "M002: original approval history restored after the test (status + approver unchanged from before this run)");
	} finally {
		await client.disconnect();
	}

	console.log(`\n${failures === 0 ? 'PASSED' : 'FAILED'}: ${failures} failing check(s)`);
	if (failures > 0) process.exit(1);
}

main().catch((e) => {
	console.error('FATAL:', e);
	process.exit(1);
});
