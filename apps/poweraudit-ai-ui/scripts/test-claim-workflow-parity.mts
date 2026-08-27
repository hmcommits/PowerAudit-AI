// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Claim workflow parity test: runs the SAME cases as
 * calculators/test_calculators.py's TestClaimWorkflow class against the
 * TypeScript port (src/lib/claimWorkflow.ts), not new TypeScript-only
 * tests - every assertion below has a named Python counterpart. Pure logic,
 * no RocketRide connection needed (same as the Python unittest suite it
 * mirrors).
 *
 * Run: cd apps/poweraudit-ai-ui && pnpm dlx tsx scripts/test-claim-workflow-parity.mts
 */
import { approveClaim, denyClaim, fileClaim, isMaterial, markCredited, markUnderReview, submitForApproval } from '../src/lib/claimWorkflow';

let failures = 0;

function check(condition: boolean, label: string): void {
	if (condition) {
		console.log(`PASS  ${label}`);
	} else {
		console.log(`FAIL  ${label}`);
		failures++;
	}
}

function expectThrows(fn: () => unknown, label: string): void {
	try {
		fn();
		console.log(`FAIL  ${label} (expected a throw, none occurred)`);
		failures++;
	} catch {
		console.log(`PASS  ${label}`);
	}
}

// test_is_material_requires_positive_overcharge_above_threshold
check(isMaterial({ rupee_impact: 4125.0 }) === true, 'isMaterial: Rs.4125 above threshold -> material');
check(isMaterial({ rupee_impact: 1500.0 }) === false, 'isMaterial: Rs.1500 below threshold -> not material');
check(isMaterial({ rupee_impact: -11812.5 }) === false, 'isMaterial: negative (undercharge) -> not material');
check(isMaterial({ rupee_impact: null }) === false, 'isMaterial: null rupee_impact -> not material');

// test_normal_lifecycle
{
	let status: string = 'draft';
	status = submitForApproval(status);
	check(status === 'pending_approval', 'normal lifecycle: draft -> pending_approval');
	status = approveClaim(status, 'Priya Sharma, Facilities Manager');
	check(status === 'approved_ready_to_file', 'normal lifecycle: pending_approval -> approved_ready_to_file');
	status = fileClaim(status);
	check(status === 'filed', 'normal lifecycle: approved_ready_to_file -> filed');
	status = markUnderReview(status);
	check(status === 'under_discom_review', 'normal lifecycle: filed -> under_discom_review');
	status = markCredited(status, 4125.0);
	check(status === 'credited', 'normal lifecycle: under_discom_review -> credited');
}

// test_denial_path
{
	const pending = submitForApproval('draft');
	const denied = denyClaim(pending);
	check(denied === 'denied', 'denial path: pending_approval -> denied');
}

// test_cannot_skip_straight_from_draft_to_approved
expectThrows(() => approveClaim('draft', 'Priya Sharma'), 'cannot approve a draft claim directly (draft -> approved_ready_to_file skipped)');

// test_cannot_approve_without_a_named_approver_regardless_of_size
{
	const pending = submitForApproval('draft');
	expectThrows(() => approveClaim(pending, ''), 'cannot approve with an empty-string approver');
	expectThrows(() => approveClaim(pending, null), 'cannot approve with a null approver');
	expectThrows(() => approveClaim(pending, '   '), 'cannot approve with a whitespace-only approver');
}

// test_cannot_double_submit
{
	const pending = submitForApproval('draft');
	expectThrows(() => submitForApproval(pending), 'cannot submit an already-pending_approval claim again');
}

// test_cannot_file_before_approval
expectThrows(() => fileClaim('pending_approval'), 'cannot file a claim still at pending_approval');

// test_cannot_credit_without_a_positive_amount
{
	const underReview = 'under_discom_review';
	expectThrows(() => markCredited(underReview, 0), 'cannot credit a zero amount');
	expectThrows(() => markCredited(underReview, null), 'cannot credit a null amount');
}

console.log(`\n${failures === 0 ? 'PASSED' : 'FAILED'}: ${failures} of the ported TestClaimWorkflow case(s) disagree with calculators/claim_workflow.py`);
if (failures > 0) process.exit(1);
