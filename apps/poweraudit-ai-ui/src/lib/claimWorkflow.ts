// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * TypeScript port of calculators/claim_workflow.py (Feature 4's Claim.status
 * state machine). Same transitions, same guard conditions, same materiality
 * threshold.
 *
 * WHY A PORT, NOT A CALL: same constraint calculators.ts hit (see its own
 * header and docs/CLAUDE.md's standing-risk Backlog note) - no RocketRide
 * pipeline node runs arbitrary deterministic Python on demand, and the
 * browser can't execute scripts/claim_actions.py directly. Feature 5's
 * interactive claim-approval UI needs this same logic to run client-side, so
 * it's ported here rather than treated as a new discovery. Keep both files
 * in sync by hand if either changes - see docs/CLAUDE.md's standing-risk
 * note and scripts/test-claim-workflow-parity.mts.
 *
 * THE ONE RULE THAT MATTERS (same as the Python original): a claim can NEVER
 * move past "draft" without an explicit approveClaim() call naming a real
 * approver, regardless of claim size - claim size isn't even a parameter to
 * approveClaim(). This file is the ONLY place the UI's Approve action is
 * allowed to decide whether an approval is valid; the UI must never write
 * `approved_ready_to_file` to RocketRide SQL except as this function's
 * return value.
 */

export const MATERIALITY_THRESHOLD_RUPEES = 2000;

export type ClaimStatus = 'draft' | 'pending_approval' | 'approved_ready_to_file' | 'filed' | 'under_discom_review' | 'credited' | 'denied';

// Matches calculators/claim_workflow.py's VALID_TRANSITIONS exactly.
export const VALID_TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
	draft: ['pending_approval'],
	pending_approval: ['approved_ready_to_file', 'denied'],
	approved_ready_to_file: ['filed'],
	filed: ['under_discom_review'],
	under_discom_review: ['credited', 'denied'],
	credited: [],
	denied: [],
};

/** Only a genuine OVERCHARGE (positive rupee_impact) above the materiality
 * threshold is refund-claim-eligible - a negative rupee_impact means the
 * consumer was undercharged, so there is nothing to dispute for a refund. */
export function isMaterial(finding: { rupee_impact: number | null | undefined }, threshold: number = MATERIALITY_THRESHOLD_RUPEES): boolean {
	const impact = finding.rupee_impact;
	return impact !== null && impact !== undefined && impact > threshold;
}

/** draft -> pending_approval. The first explicit, separate step. */
export function submitForApproval(status: string): ClaimStatus {
	if (status !== 'draft') throw new Error(`Can only submit a 'draft' claim for approval, got '${status}'`);
	return 'pending_approval';
}

/** pending_approval -> approved_ready_to_file. The approval gate: a SECOND
 * explicit, separate step (never combined with drafting or submission), and
 * it structurally cannot succeed without a named human - there is no
 * size-based bypass. */
export function approveClaim(status: string, approver: string | null | undefined): ClaimStatus {
	if (status !== 'pending_approval') throw new Error(`Can only approve a 'pending_approval' claim, got '${status}'`);
	if (!approver || !approver.trim()) throw new Error('Approval requires a named approver - no exceptions, regardless of claim size');
	return 'approved_ready_to_file';
}

/** pending_approval or under_discom_review -> denied. */
export function denyClaim(status: string): ClaimStatus {
	if (status !== 'pending_approval' && status !== 'under_discom_review') {
		throw new Error(`Can only deny a 'pending_approval' or 'under_discom_review' claim, got '${status}'`);
	}
	return 'denied';
}

/** approved_ready_to_file -> filed. */
export function fileClaim(status: string): ClaimStatus {
	if (status !== 'approved_ready_to_file') throw new Error(`Can only file an 'approved_ready_to_file' claim, got '${status}'`);
	return 'filed';
}

/** filed -> under_discom_review. */
export function markUnderReview(status: string): ClaimStatus {
	if (status !== 'filed') throw new Error(`Can only mark a 'filed' claim under review, got '${status}'`);
	return 'under_discom_review';
}

/** under_discom_review -> credited. */
export function markCredited(status: string, creditedAmount: number | null | undefined): ClaimStatus {
	if (status !== 'under_discom_review') throw new Error(`Can only credit an 'under_discom_review' claim, got '${status}'`);
	if (creditedAmount === null || creditedAmount === undefined || creditedAmount <= 0) throw new Error('Credited amount must be a positive number');
	return 'credited';
}
