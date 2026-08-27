"""Phase 1: create the Section 3 data model in RocketRide SQL.

Connects to the already-running foundation-sql pipeline task (started once by
scripts/start_foundation.py) and issues raw DDL via client.database.query(),
which bypasses the rocketride_sql node's LLM-translation layer entirely (see
ROCKETRIDE_python_API.md #13 Database). Run scripts/start_foundation.py first.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from rocketride import RocketRideClient
from rr_common import ensure_foundation_sql_token

DDL = [
    """
    CREATE TABLE IF NOT EXISTS site (
        site_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        address TEXT,
        business_unit TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS meter (
        meter_id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES site(site_id),
        discom TEXT NOT NULL,
        tariff_category TEXT NOT NULL,
        contract_demand_kva NUMERIC NOT NULL,
        pf_threshold NUMERIC NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS tariff_order (
        order_id TEXT PRIMARY KEY,
        discom TEXT NOT NULL,
        state TEXT NOT NULL,
        effective_date DATE NOT NULL,
        terms JSONB NOT NULL DEFAULT '{}'::jsonb,
        source_doc_ref TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS bill (
        bill_id TEXT PRIMARY KEY,
        meter_id TEXT NOT NULL REFERENCES meter(meter_id),
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        recorded_md NUMERIC,
        recorded_pf NUMERIC,
        line_items JSONB NOT NULL DEFAULT '[]'::jsonb,
        total_due NUMERIC,
        source_doc_ref TEXT,
        needs_review BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS finding (
        finding_id TEXT PRIMARY KEY,
        bill_id TEXT NOT NULL REFERENCES bill(bill_id),
        meter_id TEXT NOT NULL REFERENCES meter(meter_id),
        type TEXT NOT NULL CHECK (type IN (
            'md-penalty', 'pf-penalty', 'misclass', 'unbilled',
            'double-billed', 'stale-rate', 'math-error'
        )),
        rupee_impact NUMERIC NOT NULL,
        confidence NUMERIC NOT NULL,
        tariff_citation TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS alert (
        alert_id TEXT PRIMARY KEY,
        meter_id TEXT NOT NULL REFERENCES meter(meter_id),
        trend_type TEXT NOT NULL,
        projected_impact NUMERIC,
        recommendation TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS claim (
        claim_id TEXT PRIMARY KEY,
        finding_id TEXT NOT NULL REFERENCES finding(finding_id),
        status TEXT NOT NULL CHECK (status IN (
            'draft', 'pending_approval', 'approved_ready_to_file',
            'filed', 'under_discom_review', 'credited', 'denied'
        )),
        contract_impacting BOOLEAN NOT NULL DEFAULT false,
        approver TEXT,
        credited_amount NUMERIC,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
]

TABLES = ["site", "meter", "tariff_order", "bill", "finding", "alert", "claim"]


async def main():
    client = RocketRideClient()
    await client.connect()
    try:
        token = await ensure_foundation_sql_token(client)
        print("Using task token:", token)

        # Note: the installed PyPI `rocketride` client lags the server and doesn't
        # expose begin_transaction/commit/rollback (only dialect/query) - see
        # ROCKETRIDE_python_API.md's install note. Each statement below is an
        # idempotent `CREATE TABLE IF NOT EXISTS`, so running them sequentially
        # without a wrapping transaction is safe.
        for ddl in DDL:
            await client.database.query(token=token, sql=ddl)
        print(f"Created/confirmed {len(DDL)} tables.")

        print("\n--- Verifying shape (information_schema) ---")
        # Note: this installed SDK's database.query() has no params/binding support
        # (see the transaction note above) - `table` is drawn from the fixed TABLES
        # list above, never external input, so inlining it here is safe.
        for table in TABLES:
            r = await client.database.query(
                token=token,
                sql=(
                    "SELECT column_name, data_type, is_nullable "
                    "FROM information_schema.columns "
                    f"WHERE table_name = '{table}' ORDER BY ordinal_position"
                ),
            )
            print(f"\n{table} ({len(r['rows'])} columns):")
            for col in r["rows"]:
                print(f"  - {col['column_name']}: {col['data_type']} (nullable={col['is_nullable']})")

            count = await client.database.query(token=token, sql=f"SELECT count(*) AS n FROM {table}")
            print(f"  row count: {count['rows'][0]['n']}")
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
