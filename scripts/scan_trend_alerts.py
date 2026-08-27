"""Feature 3, live-scan mode: history-aggregator -> trend-classifier ->
CrewAI recommendation -> write Alert. Zero LLM calls except the one
recommendation-wording step (step 3) - detection itself (steps 1-2) is
pure deterministic Python, per the build context's Section 4 spec.

Reuses STUB_TARIFF_PARAMS from recalculate_bills.py (Feature 2) rather than
duplicating it - same caveat applies: illustrative rates, not sourced from
any real tariff order, pending the rocketride_vector fix (see
docs/CLAUDE.md Backlog).
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
    build_trend_recommendation_pipeline,
    TREND_RECOMMENDATION_PROJECT_ID,
    TREND_RECOMMENDATION_SOURCE,
)
from recalculate_bills import STUB_TARIFF_PARAMS

from calculators.history_aggregator import build_history
from calculators.trend_classifier import classify_cd_trend, classify_pf_trend
from calculators.tariff_penalty_calculator import calculate_md_penalty, calculate_pf_adjustment


async def ensure_trend_recommendation_token(client):
    """Same pattern as rr_common.ensure_foundation_sql_token: get_task_token
    can resolve a project/source mapping to a token whose underlying task
    has already been terminated, so verify liveness before trusting it."""
    token = None
    try:
        token = await client.get_task_token(project_id=TREND_RECOMMENDATION_PROJECT_ID, source=TREND_RECOMMENDATION_SOURCE)
    except RuntimeError:
        token = None
    if token:
        try:
            status = await client.get_task_status(token)
            # Note: despite the docs, `state` here is an integer code, not
            # the documented string enum ('running'/'waiting'/...) - don't
            # match against it. `completed` is a reliable boolean.
            if status.get("completed") is False:
                return token
        except Exception:
            pass
    pipeline = build_trend_recommendation_pipeline()
    result = await client.use(pipeline=pipeline, source="chat_1", ttl=1800, name="trend-recommendation")
    return result["token"]


async def fetch_meters(client, token, meter_ids=None):
    sql = "SELECT meter_id, discom, contract_demand_kva, pf_threshold FROM meter"
    params = None
    if meter_ids:
        placeholders = ", ".join(f"${i+1}" for i in range(len(meter_ids)))
        sql += f" WHERE meter_id IN ({placeholders})"
        params = list(meter_ids)
    r = await client.database.query(token=token, sql=sql, params=params)
    return r["rows"]


async def fetch_bill_rows(client, token, meter_id):
    r = await client.database.query(
        token=token,
        sql="SELECT period_start, recorded_md, recorded_pf FROM bill WHERE meter_id = $1 ORDER BY period_start",
        params=[meter_id],
    )
    return r["rows"]


def cd_trend_recommendation_prompt(meter_id, discom, trend):
    return (
        f"Meter {meter_id} ({discom}): recorded Maximum Demand has been rising at "
        f"{trend['slope_kva_per_month']} kVA/month over the recent billing history, "
        f"latest recorded at {trend['latest_recorded_md']} kVA against a Contract Demand "
        f"of {trend['contract_demand_kva']} kVA. Projected to reach "
        f"{trend['projected_md_at_horizon']} kVA within {trend['warning_horizon_months']} months, "
        f"crossing the Contract Demand in an estimated {trend['months_to_breach']} months."
    )


def pf_trend_recommendation_prompt(meter_id, discom, trend):
    return (
        f"Meter {meter_id} ({discom}): recorded Power Factor has been declining at "
        f"{abs(trend['slope_per_month'])} per month over the recent billing history, "
        f"latest recorded at {trend['latest_recorded_pf']} against a surcharge threshold "
        f"of {trend['pf_threshold']}. Projected to fall to {trend['projected_pf_at_horizon']} "
        f"within {trend['warning_horizon_months']} months, crossing the threshold in an "
        f"estimated {trend['months_to_breach']} months."
    )


async def get_recommendation(client, rec_token, prompt_text):
    question = Question()
    question.addQuestion(prompt_text)
    response = await client.chat(token=rec_token, question=question)
    answers = response.get("answers") or []
    return answers[0] if answers else "(no recommendation generated)"


async def scan(meter_ids=None):
    client = RocketRideClient(persist=True)
    await client.connect()
    try:
        sql_token = await ensure_foundation_sql_token(client)
        rec_token = await ensure_trend_recommendation_token(client)
        print("foundation-sql token:", sql_token)
        print("trend-recommendation token:", rec_token)

        meters = await fetch_meters(client, sql_token, meter_ids)
        print(f"Scanning {len(meters)} meters...")

        summary = []
        for meter in meters:
            meter_id = meter["meter_id"]
            params = STUB_TARIFF_PARAMS.get(meter["discom"])
            rows = await fetch_bill_rows(client, sql_token, meter_id)
            # Note: period_start is a `date` column, not jsonb - the
            # ast.literal_eval() workaround (docs/CLAUDE.md Backlog) only
            # applies to jsonb reads, not needed here.
            history = build_history(rows)

            cd_trend = classify_cd_trend(history, meter["contract_demand_kva"])
            pf_trend = None
            if params:
                pf_trend = classify_pf_trend(history, params["surcharge_threshold"])

            alerts_written = []

            if cd_trend["status"] == "cd-breach-risk":
                projected_penalty = calculate_md_penalty(
                    cd_trend["projected_md_at_horizon"], meter["contract_demand_kva"],
                    params["demand_charge_rate"], params["penalty_multiplier"],
                ) if params else {"penalty": None}
                prompt = cd_trend_recommendation_prompt(meter_id, meter["discom"], cd_trend)
                recommendation = await get_recommendation(client, rec_token, prompt)
                alert_id = f"alert-{uuid.uuid4().hex[:12]}"
                await client.database.query(
                    token=sql_token,
                    sql="INSERT INTO alert (alert_id, meter_id, trend_type, projected_impact, recommendation) VALUES ($1, $2, $3, $4, $5)",
                    params=[alert_id, meter_id, "cd-breach-risk", projected_penalty["penalty"], recommendation],
                )
                alerts_written.append(("cd-breach-risk", cd_trend, recommendation))

            if pf_trend and pf_trend["status"] == "pf-decline-risk":
                projected_adjustment = calculate_pf_adjustment(
                    pf_trend["projected_pf_at_horizon"], params["incentive_threshold"], params["surcharge_threshold"],
                    100000, params["incentive_rate_per_point"], params["surcharge_rate_per_point"],
                )
                prompt = pf_trend_recommendation_prompt(meter_id, meter["discom"], pf_trend)
                recommendation = await get_recommendation(client, rec_token, prompt)
                alert_id = f"alert-{uuid.uuid4().hex[:12]}"
                await client.database.query(
                    token=sql_token,
                    sql="INSERT INTO alert (alert_id, meter_id, trend_type, projected_impact, recommendation) VALUES ($1, $2, $3, $4, $5)",
                    params=[alert_id, meter_id, "pf-decline-risk", projected_adjustment["amount"], recommendation],
                )
                alerts_written.append(("pf-decline-risk", pf_trend, recommendation))

            summary.append((meter_id, cd_trend["status"], pf_trend["status"] if pf_trend else "n/a", alerts_written))

        print("\n--- Trend scan summary ---")
        for meter_id, cd_status, pf_status, alerts in summary:
            print(f"{meter_id}: cd_status={cd_status}, pf_status={pf_status}, alerts_written={len(alerts)}")
            for trend_type, trend, recommendation in alerts:
                print(f"    [{trend_type}] {trend}")
                print(f"    recommendation: {recommendation}")

        return summary
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(scan())
