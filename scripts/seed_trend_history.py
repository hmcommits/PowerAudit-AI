"""Feature 3 test data: synthetic multi-month Bill histories for 3 meters,
inserted directly into RocketRide SQL (bypassing bill-ingestion.pipe - this
is testing trend detection over already-stored history, not extraction).

- T01 (MSEDCL, CD=530 kVA): recorded_md rises 400 -> 500 kVA over 6 months
  at a perfectly linear 20 kVA/month - SHOULD trigger a cd-breach-risk
  alert (latest 500 is still under CD, but the 2-month projection crosses
  it). A 7th bill (month 7, recorded_md=545, an actual breach) is generated
  separately by make_t01_breach_bill() for the "predict before the bad
  bill arrives" confirmation step - not inserted by this script.
- T02 (MSEDCL, CD=300 kVA): recorded_md fluctuates mildly around 253 kVA
  with no clear trend - SHOULD NOT trigger (the negative-control case).
- T03 (BESCOM, CD=800 kVA - plenty of headroom on demand): recorded_pf
  declines 0.97 -> 0.92 over 6 months at a perfectly linear -0.01/month -
  SHOULD trigger a pf-decline-risk alert (latest 0.92 is still above the
  0.90 surcharge threshold, but the 2-month projection reaches exactly 0.90).
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from rocketride import RocketRideClient
from rr_common import ensure_foundation_sql_token

METERS = [
    # meter_id, site_id, discom, tariff_category, contract_demand_kva, pf_threshold
    ("T01", "site-001", "MSEDCL", "HT-II Industrial", 530, 0.95),
    ("T02", "site-001", "MSEDCL", "HT-I Commercial", 300, 0.95),
    ("T03", "site-002", "BESCOM", "HT Industrial", 800, 0.95),
]

T01_MD = [400, 420, 440, 460, 480, 500]
T01_PF = [0.96] * 6
T02_MD = [250, 262, 245, 258, 251, 254]
T02_PF = [0.96] * 6
T03_MD = [300] * 6
T03_PF = [0.97, 0.96, 0.95, 0.94, 0.93, 0.92]

HISTORIES = {"T01": (T01_MD, T01_PF), "T02": (T02_MD, T02_PF), "T03": (T03_MD, T03_PF)}


def month_bounds(year, month):
    start = f"{year:04d}-{month:02d}-01"
    if month == 12:
        next_year, next_month = year + 1, 1
    else:
        next_year, next_month = year, month + 1
    import datetime

    end = datetime.date(next_year, next_month, 1) - datetime.timedelta(days=1)
    return start, end.isoformat()


def make_bill_row(meter_id, month_offset, recorded_md, recorded_pf, start_year=2026, start_month=1):
    month = start_month + month_offset
    year = start_year + (month - 1) // 12
    month = ((month - 1) % 12) + 1
    period_start, period_end = month_bounds(year, month)
    return {
        "bill_id": f"bill-{meter_id.lower()}-m{month_offset + 1}",
        "meter_id": meter_id,
        "period_start": period_start,
        "period_end": period_end,
        "recorded_md": recorded_md,
        "recorded_pf": recorded_pf,
        "line_items": json.dumps([{"description": "Energy Charge", "amount": 100000}]),
        "total_due": 100000,
        "source_doc_ref": "synthetic-trend-history",
        "needs_review": False,
    }


def make_t01_breach_bill():
    """Month 7 for T01: recorded_md=545, actually breaching CD=530 - used
    separately to confirm the trend classifier's prediction (see
    scripts/confirm_trend_prediction.py), not inserted by seed_history()."""
    return make_bill_row("T01", month_offset=6, recorded_md=545, recorded_pf=0.96)


async def seed_meters(client, token):
    for meter_id, site_id, discom, tariff_category, cd, pf in METERS:
        await client.database.query(
            token=token,
            sql=(
                "INSERT INTO meter (meter_id, site_id, discom, tariff_category, "
                "contract_demand_kva, pf_threshold) VALUES ($1, $2, $3, $4, $5, $6) "
                "ON CONFLICT (meter_id) DO NOTHING"
            ),
            params=[meter_id, site_id, discom, tariff_category, cd, pf],
        )
    print(f"Seeded {len(METERS)} trend-test meters (T01, T02, T03).")


async def insert_bill(client, token, row):
    await client.database.query(
        token=token,
        sql=(
            "INSERT INTO bill (bill_id, meter_id, period_start, period_end, recorded_md, "
            "recorded_pf, line_items, total_due, source_doc_ref, needs_review) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) "
            "ON CONFLICT (bill_id) DO NOTHING"
        ),
        params=[
            row["bill_id"], row["meter_id"], row["period_start"], row["period_end"],
            row["recorded_md"], row["recorded_pf"], row["line_items"], row["total_due"],
            row["source_doc_ref"], row["needs_review"],
        ],
    )


async def seed_history(client, token):
    count = 0
    for meter_id, (md_series, pf_series) in HISTORIES.items():
        for i, (md, pf) in enumerate(zip(md_series, pf_series)):
            row = make_bill_row(meter_id, i, md, pf)
            await insert_bill(client, token, row)
            count += 1
    print(f"Seeded {count} synthetic history bills across {len(HISTORIES)} meters (6 months each).")


async def main():
    client = RocketRideClient()
    await client.connect()
    try:
        token = await ensure_foundation_sql_token(client)
        await seed_meters(client, token)
        await seed_history(client, token)
        r = await client.database.query(
            token=token,
            sql="SELECT meter_id, count(*) AS n FROM bill WHERE meter_id IN ('T01','T02','T03') GROUP BY meter_id ORDER BY meter_id",
        )
        print("Bill counts per trend-test meter:", r["rows"])
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
