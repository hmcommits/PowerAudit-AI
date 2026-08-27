"""Feature 3, step 5: what-if mode. Same trend-projection logic as
scan_trend_alerts.py, but takes a hypothetical Contract Demand instead of
scanning for a live breach risk, and prints a projected cost/savings
comparison. Writes NOTHING to RocketRide SQL - no Alert record.

Usage: python scripts/what_if_scenario.py <meter_id> <hypothetical_cd_kva>
Example: python scripts/what_if_scenario.py T01 560
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from rocketride import RocketRideClient
from rr_common import ensure_foundation_sql_token
from recalculate_bills import STUB_TARIFF_PARAMS
from scan_trend_alerts import fetch_meters, fetch_bill_rows

from calculators.history_aggregator import build_history
from calculators.what_if import what_if_cd_change


async def run(meter_id, hypothetical_cd):
    client = RocketRideClient()
    await client.connect()
    try:
        token = await ensure_foundation_sql_token(client)
        meters = await fetch_meters(client, token, [meter_id])
        if not meters:
            print(f"No such meter: {meter_id}")
            return
        meter = meters[0]
        params = STUB_TARIFF_PARAMS.get(meter["discom"])
        if not params:
            print(f"No tariff params for DISCOM '{meter['discom']}' (STUB_TARIFF_PARAMS)")
            return

        rows = await fetch_bill_rows(client, token, meter_id)
        history = build_history(rows)
        result = what_if_cd_change(history, meter["contract_demand_kva"], hypothetical_cd, params)

        print(f"What-if: meter {meter_id} ({meter['discom']}), current CD={meter['contract_demand_kva']} kVA, hypothetical CD={hypothetical_cd} kVA")
        if result["status"] != "ok":
            print(f"  {result['status']} - not enough billing history to project a trend")
            return
        print(f"  Projected MD at +{result['warning_horizon_months']} months: {result['projected_md_at_horizon']} kVA")
        print(f"  Projected MD penalty at current CD ({result['current_cd']} kVA): Rs. {result['current_projected_penalty']}")
        print(f"  Projected MD penalty at hypothetical CD ({result['hypothetical_cd']} kVA): Rs. {result['hypothetical_projected_penalty']}")
        print(f"  Projected savings from raising CD: Rs. {result['projected_savings']}")
        print("  (STUB_TARIFF_PARAMS rates - illustrative, not sourced from a real tariff order; see docs/CLAUDE.md Backlog)")
    finally:
        await client.disconnect()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    asyncio.run(run(sys.argv[1], float(sys.argv[2])))
