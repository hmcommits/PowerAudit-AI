"""Feature 4, steps 3-4: claim status machine (Python, deterministic, zero
LLM).

Section 3's Claim.status enum (matches the CHECK constraint in
scripts/setup_schema.py exactly): draft -> pending_approval ->
approved_ready_to_file -> filed -> under_discom_review -> credited/denied.

THE ONE RULE THAT MATTERS: a claim can NEVER move past "draft" without an
explicit approve_claim() call naming a real approver - regardless of claim
size. There is no function in this module that transitions draft (or
pending_approval) straight to approved_ready_to_file without a human name
attached, and every transition function refuses (raises ValueError) on any
status it doesn't apply to. This is enforced structurally, not by
convention - claim size isn't even a parameter to approve_claim().
"""

MATERIALITY_THRESHOLD_RUPEES = 2000

VALID_TRANSITIONS = {
    "draft": {"pending_approval"},
    "pending_approval": {"approved_ready_to_file", "denied"},
    "approved_ready_to_file": {"filed"},
    "filed": {"under_discom_review"},
    "under_discom_review": {"credited", "denied"},
    "credited": set(),
    "denied": set(),
}


def is_material(finding, threshold=MATERIALITY_THRESHOLD_RUPEES):
    """Only a genuine OVERCHARGE (positive rupee_impact) above the
    materiality threshold is refund-claim-eligible - a negative
    rupee_impact means the consumer was undercharged, so there is nothing
    to dispute for a refund."""
    impact = finding.get("rupee_impact")
    return impact is not None and impact > threshold


def submit_for_approval(status):
    """draft -> pending_approval. The first explicit, separate step."""
    if status != "draft":
        raise ValueError(f"Can only submit a 'draft' claim for approval, got '{status}'")
    return "pending_approval"


def approve_claim(status, approver):
    """pending_approval -> approved_ready_to_file. The approval gate: a
    SECOND explicit, separate step (never combined with drafting or
    submission), and it structurally cannot succeed without a named human -
    there is no size-based bypass."""
    if status != "pending_approval":
        raise ValueError(f"Can only approve a 'pending_approval' claim, got '{status}'")
    if not approver or not approver.strip():
        raise ValueError("Approval requires a named approver - no exceptions, regardless of claim size")
    return "approved_ready_to_file"


def deny_claim(status):
    """pending_approval or under_discom_review -> denied."""
    if status not in ("pending_approval", "under_discom_review"):
        raise ValueError(f"Can only deny a 'pending_approval' or 'under_discom_review' claim, got '{status}'")
    return "denied"


def file_claim(status):
    """approved_ready_to_file -> filed."""
    if status != "approved_ready_to_file":
        raise ValueError(f"Can only file an 'approved_ready_to_file' claim, got '{status}'")
    return "filed"


def mark_under_review(status):
    """filed -> under_discom_review."""
    if status != "filed":
        raise ValueError(f"Can only mark a 'filed' claim under review, got '{status}'")
    return "under_discom_review"


def mark_credited(status, credited_amount):
    """under_discom_review -> credited."""
    if status != "under_discom_review":
        raise ValueError(f"Can only credit an 'under_discom_review' claim, got '{status}'")
    if credited_amount is None or credited_amount <= 0:
        raise ValueError("Credited amount must be a positive number")
    return "credited"
