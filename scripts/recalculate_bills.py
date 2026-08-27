"""Feature 2: recalculate every Bill in RocketRide SQL and write Findings.

Orchestrates the deterministic calculators (calculators/) - zero LLM calls
anywhere in this file, per Section 2's hard rule. Reads Bill+Meter rows via
client.database.query() against the foundation-sql pipeline (same pattern as
scripts/ingest_bills.py), same reasoning as Feature 1: rocketride_sql has no
pipeline dataflow write lane, and (new finding from this build) tool_python
cannot be invoked directly either - bare `tools` hosting doesn't register
its handler, and hosting it under an agent would require the agent to
*decide* to call it, reintroducing non-determinism. So Section 5's "Python
inside RocketRide Python tool nodes" runs here, in this orchestration
script, instead - there's currently no working way to run it as a pipeline
node on this server.

STUBBED, NOT REAL: STUB_TARIFF_PARAMS below stands in for what Section 4
step 2 describes as "RocketRide Vector search - retrieves the current
tariff formula". Vector's document-store step is confirmed broken on this
server (see docs/CLAUDE.md's Backlog section) - once fixed, replace this
dict with an actual per-DISCOM Vector lookup. Likewise `tariff_citation` is
a placeholder string, standing in for step 6's citation-attacher.
"""
import ast
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from rocketride import RocketRideClient
from rr_common import ensure_foundation_sql_token

from calculators.bill_line_parser import normalize_line_items
from calculators.tariff_penalty_calculator import calculate_md_penalty, calculate_pf_adjustment
from calculators.variance_detector import detect_variances
from calculators.dollar_impact_scorer import score_findings

# STUB - see module docstring. Rates are illustrative, not sourced from any
# real tariff order; do not treat these as accurate for any real DISCOM.
STUB_TARIFF_PARAMS = {
    "MSEDCL": {"demand_charge_rate": 450, "penalty_multiplier": 1.75, "incentive_threshold": 0.95, "surcharge_threshold": 0.90, "incentive_rate_per_point": 0.005, "surcharge_rate_per_point": 0.01},
    "TATA Power": {"demand_charge_rate": 480, "penalty_multiplier": 1.5, "incentive_threshold": 0.95, "surcharge_threshold": 0.90, "incentive_rate_per_point": 0.005, "surcharge_rate_per_point": 0.01},
    "BESCOM": {"demand_charge_rate": 420, "penalty_multiplier": 2.0, "incentive_threshold": 0.95, "surcharge_threshold": 0.90, "incentive_rate_per_point": 0.005, "surcharge_rate_per_point": 0.01},
    "Adani Electricity": {"demand_charge_rate": 460, "penalty_multiplier": 1.5, "incentive_threshold": 0.95, "surcharge_threshold": 0.90, "incentive_rate_per_point": 0.005, "surcharge_rate_per_point": 0.01},
}
STUB_CITATION = "[STUB - Vector citation-attacher not wired: rocketride_vector's store step is broken, see docs/CLAUDE.md Backlog]"


async def fetch_bills(client, token):
    r = await client.database.query(
        token=token,
        sql=(
            "SELECT b.bill_id, b.meter_id, b.period_start, b.period_end, "
            "b.recorded_md, b.recorded_pf, b.line_items, b.total_due, b.needs_review, "
            "m.discom, m.contract_demand_kva "
            "FROM bill b JOIN meter m ON m.meter_id = b.meter_id "
            "ORDER BY b.source_doc_ref"
        ),
    )
    return r["rows"]


async def upsert_finding(client, token, bill_id, meter_id, finding):
    """Insert or update the Finding for (bill_id, type) - NOT a blanket
    DELETE FROM finding + fresh INSERT (what this function replaced). Found
    by testing Feature 5's interactive upload against real data: a finding
    that already has a Claim referencing it (claim.finding_id REFERENCES
    finding.finding_id) can't be deleted without an FK violation. Looking
    up the existing row first and UPDATEing it in place preserves whatever
    finding_id it already has (and therefore any Claim's FK reference);
    only a genuinely new (bill_id, type) combination gets a fresh
    deterministic finding_id. See src/lib/billIngestion.ts (Feature 5) for
    the TypeScript port of this same fix."""
    existing = await client.database.query(
        token=token,
        sql="SELECT finding_id FROM finding WHERE bill_id = $1 AND type = $2",
        params=[bill_id, finding["type"]],
    )
    if existing["rows"]:
        await client.database.query(
            token=token,
            sql="UPDATE finding SET rupee_impact = $1, confidence = $2, tariff_citation = $3 WHERE finding_id = $4",
            params=[finding["rupee_impact"], finding["confidence"], STUB_CITATION, existing["rows"][0]["finding_id"]],
        )
        return existing["rows"][0]["finding_id"]
    finding_id = f"finding-{bill_id}-{finding['type']}"
    await client.database.query(
        token=token,
        sql=(
            "INSERT INTO finding (finding_id, bill_id, meter_id, type, rupee_impact, "
            "confidence, tariff_citation) VALUES ($1, $2, $3, $4, $5, $6, $7)"
        ),
        params=[finding_id, bill_id, meter_id, finding["type"], finding["rupee_impact"], finding["confidence"], STUB_CITATION],
    )
    return finding_id


async def main():
    client = RocketRideClient(persist=True)
    await client.connect()
    try:
        token = await ensure_foundation_sql_token(client)
        print("foundation-sql task token:", token)

        bills = await fetch_bills(client, token)
        print(f"Recalculating {len(bills)} bills...")

        summary = []
        for bill in bills:
            params = STUB_TARIFF_PARAMS.get(bill["discom"])
            if params is None:
                summary.append((bill["bill_id"], "SKIPPED", [f"no tariff params for DISCOM '{bill['discom']}'"]))
                continue
            if bill["recorded_md"] is None or bill["recorded_pf"] is None:
                summary.append((bill["bill_id"], "SKIPPED", ["recorded_md or recorded_pf missing - cannot recalculate"]))
                continue

            # client.database.query() returns jsonb columns as Python repr()
            # text ("{'x': 1}"), not valid JSON - confirmed with a bare
            # literal INSERT/SELECT round trip with zero bound parameters,
            # so it's a read-path serialization bug, not something wrong
            # with how we wrote it. ast.literal_eval recovers it; safe here
            # since this is our own application data, not external input.
            line_items_raw = bill["line_items"]
            if isinstance(line_items_raw, str):
                line_items_raw = ast.literal_eval(line_items_raw)
            normalized = normalize_line_items(line_items_raw)

            recalc_md = calculate_md_penalty(
                bill["recorded_md"], bill["contract_demand_kva"],
                params["demand_charge_rate"], params["penalty_multiplier"],
            )
            recalc_pf = calculate_pf_adjustment(
                bill["recorded_pf"], params["incentive_threshold"], params["surcharge_threshold"],
                sum(i["amount"] for i in normalized if i["amount"] and i["category"] == "energy_charge") or 100000,
                params["incentive_rate_per_point"], params["surcharge_rate_per_point"],
            )

            variances = detect_variances(normalized, bill["total_due"], recalc_md, recalc_pf)
            data_quality_flags = ["bill flagged needs_review"] if bill["needs_review"] else []
            findings = score_findings(variances, data_quality_flags)

            written = []
            for finding in findings:
                await upsert_finding(client, token, bill["bill_id"], bill["meter_id"], finding)
                written.append(f"{finding['type']}: rupee_impact={finding['rupee_impact']} confidence={finding['confidence']} ({finding['detail']})")

            status = "FINDINGS" if written else "CLEAN"
            summary.append((bill["bill_id"], status, written))

        print("\n--- Recalculation summary ---")
        for bill_id, status, details in summary:
            print(f"{status:10} {bill_id}")
            for d in details:
                print(f"           - {d}")

        r = await client.database.query(token=token, sql="SELECT count(*) AS n FROM finding")
        print("\nfinding table row count:", r["rows"][0]["n"])
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
