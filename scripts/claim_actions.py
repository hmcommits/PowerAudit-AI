"""Feature 4, steps 3-4: explicit, separate claim-status actions. Each verb
is its own script invocation - drafting (draft_claims.py), submitting, and
approving are never combined into one call, so a claim cannot silently
cross from draft to approved in a single step.

Usage:
    python scripts/claim_actions.py submit <claim_id>
    python scripts/claim_actions.py approve <claim_id> "<approver name>"
    python scripts/claim_actions.py deny <claim_id>
    python scripts/claim_actions.py file <claim_id>
    python scripts/claim_actions.py review <claim_id>
    python scripts/claim_actions.py credit <claim_id> <amount>
    python scripts/claim_actions.py show <claim_id>
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from rocketride import RocketRideClient
from rr_common import ensure_foundation_sql_token

from calculators import claim_workflow


async def get_claim(client, token, claim_id):
    r = await client.database.query(
        token=token,
        sql="SELECT claim_id, finding_id, status, contract_impacting, approver, credited_amount FROM claim WHERE claim_id = $1",
        params=[claim_id],
    )
    if not r["rows"]:
        raise ValueError(f"No such claim: {claim_id}")
    return r["rows"][0]


async def set_status(client, token, claim_id, new_status, approver=None, credited_amount=None):
    await client.database.query(
        token=token,
        sql="UPDATE claim SET status = $1, approver = COALESCE($2, approver), credited_amount = COALESCE($3, credited_amount) WHERE claim_id = $4",
        params=[new_status, approver, credited_amount, claim_id],
    )


async def run(action, claim_id, *args):
    client = RocketRideClient()
    await client.connect()
    try:
        token = await ensure_foundation_sql_token(client)
        claim = await get_claim(client, token, claim_id)

        if action == "show":
            print(claim)
            return

        if action == "submit":
            new_status = claim_workflow.submit_for_approval(claim["status"])
            await set_status(client, token, claim_id, new_status)
        elif action == "approve":
            approver = args[0] if args else None
            new_status = claim_workflow.approve_claim(claim["status"], approver)
            await set_status(client, token, claim_id, new_status, approver=approver)
        elif action == "deny":
            new_status = claim_workflow.deny_claim(claim["status"])
            await set_status(client, token, claim_id, new_status)
        elif action == "file":
            new_status = claim_workflow.file_claim(claim["status"])
            await set_status(client, token, claim_id, new_status)
        elif action == "review":
            new_status = claim_workflow.mark_under_review(claim["status"])
            await set_status(client, token, claim_id, new_status)
        elif action == "credit":
            amount = float(args[0])
            new_status = claim_workflow.mark_credited(claim["status"], amount)
            await set_status(client, token, claim_id, new_status, credited_amount=amount)
        else:
            print(__doc__)
            return

        updated = await get_claim(client, token, claim_id)
        print(f"{claim_id}: {claim['status']} -> {updated['status']} (approver={updated['approver']})")
    finally:
        await client.disconnect()


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    asyncio.run(run(sys.argv[1], sys.argv[2], *sys.argv[3:]))
