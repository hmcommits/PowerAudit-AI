"""Seed Site + Meter rows the synthetic bills reference (M999 deliberately
left unseeded to exercise the "unknown meter" rejection path)."""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from rocketride import RocketRideClient
from rr_common import ensure_foundation_sql_token

SITES = [
    ("site-001", "Mumbai HQ", "Andheri East, Mumbai, Maharashtra", "Manufacturing"),
    ("site-002", "Bangalore Plant", "Peenya Industrial Area, Bangalore, Karnataka", "Manufacturing"),
]

METERS = [
    # meter_id, site_id, discom, tariff_category, contract_demand_kva, pf_threshold
    ("M001", "site-001", "MSEDCL", "HT-II Industrial", 500, 0.95),
    ("M002", "site-001", "MSEDCL", "HT-I Commercial", 300, 0.95),
    ("M003", "site-002", "TATA Power", "HT Industrial", 750, 0.95),
    ("M004", "site-002", "BESCOM", "HT-2 Industrial", 1000, 0.95),
    ("M005", "site-001", "MSEDCL", "HT-II Industrial", 250, 0.95),
    ("M006", "site-001", "Adani Electricity", "LT Commercial", 120, 0.95),
    ("M007", "site-002", "TATA Power", "HT Industrial", 600, 0.95),
    ("M008", "site-002", "BESCOM", "HT-1 Commercial", 400, 0.95),
    ("M009", "site-001", "MSEDCL", "HT-II Industrial", 350, 0.95),
    ("M010", "site-002", "TATA Power", "HT Industrial", 800, 0.95),
    ("M011", "site-002", "BESCOM", "HT-2 Industrial", 550, 0.95),
    ("M012", "site-001", "Adani Electricity", "LT Commercial", 150, 0.95),
]


async def main():
    client = RocketRideClient()
    await client.connect()
    try:
        token = await ensure_foundation_sql_token(client)

        for site_id, name, address, bu in SITES:
            await client.database.query(
                token=token,
                sql=(
                    "INSERT INTO site (site_id, name, address, business_unit) "
                    "VALUES ($1, $2, $3, $4) ON CONFLICT (site_id) DO NOTHING"
                ),
                params=[site_id, name, address, bu],
            )
        print(f"Seeded {len(SITES)} sites.")

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
        print(f"Seeded {len(METERS)} meters (M999 intentionally left unseeded).")

        r = await client.database.query(token=token, sql="SELECT count(*) AS n FROM site")
        print("site count:", r["rows"][0]["n"])
        r = await client.database.query(token=token, sql="SELECT count(*) AS n FROM meter")
        print("meter count:", r["rows"][0]["n"])
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
