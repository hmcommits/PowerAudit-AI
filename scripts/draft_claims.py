"""Feature 4, step 1 orchestration: find materiality-eligible Findings,
classify contract impact (deterministic), compose a dispute packet
(CrewAI + Gemini), and write a Claim row - always starting at status
'draft'. Zero LLM calls except the packet-composing step itself.

Idempotent: skips Findings that already have a Claim (checks finding_id),
so re-running this script doesn't draft duplicate claims - same lesson as
Feature 1/3's bill_id fix (see docs/CLAUDE.md Backlog).
"""
import asyncio
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from rocketride import RocketRideClient
from rocketride.schema import Question
from rr_common import (
    ensure_foundation_sql_token,
    build_claim_composer_pipeline,
    CLAIM_COMPOSER_PROJECT_ID,
    CLAIM_COMPOSER_SOURCE,
)
from recalculate_bills import STUB_CITATION

from calculators.claim_workflow import is_material, MATERIALITY_THRESHOLD_RUPEES
from calculators.contract_impact_classifier import classify_contract_impact


async def ensure_claim_composer_token(client):
    """Same liveness-check fix as scan_trend_alerts.ensure_trend_recommendation_token:
    get_task_status()'s `state` is an undocumented int, not the documented
    string enum - use the `completed` boolean instead (docs/CLAUDE.md Backlog)."""
    token = None
    try:
        token = await client.get_task_token(project_id=CLAIM_COMPOSER_PROJECT_ID, source=CLAIM_COMPOSER_SOURCE)
    except RuntimeError:
        token = None
    if token:
        try:
            status = await client.get_task_status(token)
            if status.get("completed") is False:
                return token
        except Exception:
            pass
    pipeline = build_claim_composer_pipeline()
    result = await client.use(pipeline=pipeline, source="chat_1", ttl=1800, name="claim-composer")
    return result["token"]


async def fetch_all_findings(client, token):
    r = await client.database.query(
        token=token,
        sql=(
            "SELECT f.finding_id, f.bill_id, f.meter_id, f.type, f.rupee_impact, f.confidence, "
            "f.tariff_citation, b.period_start, b.period_end, m.discom, m.tariff_category "
            "FROM finding f JOIN bill b ON b.bill_id = f.bill_id JOIN meter m ON m.meter_id = f.meter_id "
            "ORDER BY f.finding_id"
        ),
    )
    return r["rows"]


async def existing_claim_finding_ids(client, token):
    r = await client.database.query(token=token, sql="SELECT finding_id FROM claim")
    return {row["finding_id"] for row in r["rows"]}


def composer_prompt(finding, citation):
    return (
        f"Finding {finding['finding_id']}: type={finding['type']}, rupee_impact=Rs.{finding['rupee_impact']}, "
        f"confidence={finding['confidence']}. Meter {finding['meter_id']} ({finding['discom']}, "
        f"tariff category {finding['tariff_category']}), billing period {finding['period_start']} to "
        f"{finding['period_end']}. Citation: {citation}"
    )


async def compose_packet(client, composer_token, finding, citation):
    question = Question()
    question.addQuestion(composer_prompt(finding, citation))
    response = await client.chat(token=composer_token, question=question)
    answers = response.get("answers") or []
    return answers[0] if answers else "(no packet generated)"


async def draft_claims():
    client = RocketRideClient(persist=True)
    await client.connect()
    try:
        sql_token = await ensure_foundation_sql_token(client)
        composer_token = await ensure_claim_composer_token(client)
        print("foundation-sql token:", sql_token)
        print("claim-composer token:", composer_token)
        print(f"Materiality threshold: Rs.{MATERIALITY_THRESHOLD_RUPEES} (positive rupee_impact only - see calculators/claim_workflow.py)")

        all_findings = await fetch_all_findings(client, sql_token)
        already_claimed = await existing_claim_finding_ids(client, sql_token)

        by_meter = {}
        for f in all_findings:
            by_meter.setdefault(f["meter_id"], []).append(f)

        eligible = [f for f in all_findings if is_material(f) and f["finding_id"] not in already_claimed]
        print(f"{len(all_findings)} total findings, {len(already_claimed)} already have claims, {len(eligible)} newly eligible (material + no existing claim)")

        summary = []
        for finding in eligible:
            impact = classify_contract_impact(finding, by_meter[finding["meter_id"]])
            packet = await compose_packet(client, composer_token, finding, STUB_CITATION)

            claim_id = f"claim-{uuid.uuid4().hex[:12]}"
            await client.database.query(
                token=sql_token,
                sql=(
                    "INSERT INTO claim (claim_id, finding_id, status, contract_impacting, "
                    "approver, credited_amount, draft_packet) VALUES ($1, $2, 'draft', $3, NULL, NULL, $4)"
                ),
                params=[claim_id, finding["finding_id"], impact["contract_impacting"], packet],
            )
            summary.append((claim_id, finding, impact, packet))

        print("\n--- Drafted claims ---")
        for claim_id, finding, impact, packet in summary:
            print(f"{claim_id}: finding={finding['finding_id']} ({finding['type']}, Rs.{finding['rupee_impact']}, meter {finding['meter_id']})")
            print(f"  contract_impacting={impact['contract_impacting']} ({impact['reason']})")
            print(f"  status=draft")
            print(f"  packet: {packet[:300]}{'...' if len(packet) > 300 else ''}")

        return summary
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(draft_claims())
