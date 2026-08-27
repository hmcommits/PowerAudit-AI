// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Interactive claim approval: the UI's Approve action must go through
 * approveClaim() (claimWorkflow.ts) before it is allowed to write
 * `approved_ready_to_file` to RocketRide SQL - mirrors
 * scripts/claim_actions.py's `approve` verb exactly (fetch current status,
 * run it through the ported state machine, only write on success). A
 * rejected approval never reaches the UPDATE statement, so an invalid
 * approval (no name, or a claim not sitting at pending_approval) cannot
 * silently persist regardless of how the UI is driven.
 */

import type { RocketRideClient } from 'shell';
import { getFoundationToken, sqlQuery } from './db';
import { approveClaim, submitForApproval, type ClaimStatus } from './claimWorkflow';

export interface ClaimActionResult {
	claimId: string;
	previousStatus: ClaimStatus;
	status: ClaimStatus;
}

async function fetchClaimStatus(client: RocketRideClient, sqlToken: string, claimId: string): Promise<ClaimStatus> {
	const rows = await sqlQuery<{ status: ClaimStatus }>(client, sqlToken, 'SELECT status FROM claim WHERE claim_id = $1', [claimId]);
	if (rows.length === 0) throw new Error(`No such claim: ${claimId}`);
	return rows[0].status;
}

/**
 * draft -> pending_approval, for real. Not wired to a UI button yet (the UI
 * only exposes Approve so far), but goes through the same fetch-guard-write
 * shape as approveClaimAction below, and is what
 * scripts/test-claim-approval-integration.mts uses to bring a real draft
 * claim to pending_approval before exercising approval.
 */
export async function submitClaimAction(client: RocketRideClient, claimId: string): Promise<ClaimActionResult> {
	const sqlToken = await getFoundationToken(client);
	if (!sqlToken) throw new Error('foundation-sql pipeline is not running (no task token resolved)');

	const previousStatus = await fetchClaimStatus(client, sqlToken, claimId);
	const status = submitForApproval(previousStatus);

	await sqlQuery(client, sqlToken, 'UPDATE claim SET status = $1 WHERE claim_id = $2', [status, claimId]);

	return { claimId, previousStatus, status };
}

/**
 * Approve a claim for real: reads its current status from RocketRide SQL,
 * runs it through the same guard scripts/claim_actions.py's `approve` verb
 * uses (approveClaim() throws if the claim isn't `pending_approval` or the
 * approver name is empty/whitespace-only), and only then writes the new
 * status + approver. Throws (does not write) on any invalid attempt.
 */
export async function approveClaimAction(client: RocketRideClient, claimId: string, approver: string): Promise<ClaimActionResult> {
	const sqlToken = await getFoundationToken(client);
	if (!sqlToken) throw new Error('foundation-sql pipeline is not running (no task token resolved)');

	const previousStatus = await fetchClaimStatus(client, sqlToken, claimId);
	const status = approveClaim(previousStatus, approver);

	await sqlQuery(client, sqlToken, 'UPDATE claim SET status = $1, approver = $2 WHERE claim_id = $3', [status, approver, claimId]);

	return { claimId, previousStatus, status };
}
