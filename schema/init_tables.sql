-- ============================================================
-- PowerAudit-AI Database Schema
-- Feature #1: Bill Ingestion + Feature #2: Penalty Detection
-- ============================================================

-- --------------------------------------------------------
-- 1. SITES
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS sites (
    site_id         TEXT PRIMARY KEY,
    site_name       TEXT NOT NULL,
    city            TEXT NOT NULL,
    provider_id     TEXT NOT NULL,
    provider_name   TEXT NOT NULL,
    discom_id       TEXT NOT NULL,
    state           TEXT NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- --------------------------------------------------------
-- 2. METERS
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS meters (
    meter_id            TEXT PRIMARY KEY,
    site_id             TEXT NOT NULL REFERENCES sites(site_id),
    meter_number        TEXT NOT NULL UNIQUE,
    tariff_category     TEXT NOT NULL,
    contract_demand_kva NUMERIC(10,2),
    discom_id           TEXT NOT NULL,
    state               TEXT NOT NULL,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- --------------------------------------------------------
-- 3. BILLS
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS bills (
    bill_id                     TEXT PRIMARY KEY,
    meter_id                    TEXT REFERENCES meters(meter_id),
    site_id                     TEXT NOT NULL REFERENCES sites(site_id),
    month                       TEXT NOT NULL,
    billing_period_start        DATE,
    billing_period_end          DATE,
    source_file                 TEXT,

    -- Extracted fields
    meter_number                TEXT,
    tariff_category             TEXT,
    contract_demand_kva         NUMERIC(10,2),
    recorded_max_demand_kva     NUMERIC(10,2),
    power_factor                NUMERIC(5,4),
    units_consumed_kwh          NUMERIC(12,2),
    energy_charges              NUMERIC(12,2),
    md_penalty_billed           NUMERIC(12,2),
    pf_penalty_billed           NUMERIC(12,2),
    fixed_charges               NUMERIC(12,2),
    taxes_and_duties            NUMERIC(12,2),
    total_due                   NUMERIC(12,2),
    amount_paid                 NUMERIC(12,2),
    outstanding_amount          NUMERIC(12,2),
    due_date                    DATE,
    payment_status              TEXT,
    provider_name               TEXT,

    -- Confidence and Review
    confidence_map              JSONB,
    needs_review                BOOLEAN DEFAULT FALSE,
    review_flags                JSONB,
    review_resolved_at          TIMESTAMPTZ,
    review_resolved_by          TEXT,

    -- Pipeline metadata
    pipeline_run_id             TEXT,
    extraction_model            TEXT DEFAULT 'gemini-1.5-pro',
    created_at                  TIMESTAMPTZ DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bills_site_id    ON bills(site_id);
CREATE INDEX IF NOT EXISTS idx_bills_meter_id   ON bills(meter_id);
CREATE INDEX IF NOT EXISTS idx_bills_month      ON bills(month);
CREATE INDEX IF NOT EXISTS idx_bills_review     ON bills(needs_review) WHERE needs_review = TRUE;

-- --------------------------------------------------------
-- 4. FINDINGS
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS findings (
    finding_id              TEXT PRIMARY KEY,
    bill_id                 TEXT NOT NULL REFERENCES bills(bill_id),
    site_id                 TEXT NOT NULL REFERENCES sites(site_id),
    meter_id                TEXT REFERENCES meters(meter_id),
    month                   TEXT NOT NULL,

    -- Variance detail
    finding_type            TEXT NOT NULL,
    variance_flag           TEXT NOT NULL,
    billed_amount           NUMERIC(12,2),
    recalculated_amount     NUMERIC(12,2),
    rupee_impact            NUMERIC(12,2),

    -- Formula inputs
    formula_inputs          JSONB,
    formula_used            TEXT,

    -- Scoring
    confidence_score        NUMERIC(5,2),
    confidence_breakdown    JSONB,

    -- Citation (from RocketRide Vector)
    citation_clause_ref     TEXT,
    citation_clause_text    TEXT,
    citation_discom         TEXT,
    citation_tariff_year    TEXT,
    citation_page_ref       TEXT,

    -- Pipeline metadata
    pipeline_run_id         TEXT,
    created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_findings_bill_id     ON findings(bill_id);
CREATE INDEX IF NOT EXISTS idx_findings_site_id     ON findings(site_id);
CREATE INDEX IF NOT EXISTS idx_findings_type        ON findings(finding_type);
CREATE INDEX IF NOT EXISTS idx_findings_flag        ON findings(variance_flag);
CREATE INDEX IF NOT EXISTS idx_findings_overcharged ON findings(rupee_impact) WHERE rupee_impact > 0;

-- --------------------------------------------------------
-- 5. SEED: Sites from Excel (mapped to 3 DISCOMs)
-- --------------------------------------------------------
INSERT INTO sites (site_id, site_name, city, provider_id, provider_name, discom_id, state) VALUES
  ('S101', 'Gurgaon Office',  'Gurgaon',   'P101', 'Tata Power',       'MSEDCL',  'Maharashtra'),
  ('S102', 'Delhi Warehouse', 'Delhi',     'P102', 'Adani Electricity', 'MSEDCL',  'Maharashtra'),
  ('S103', 'Noida Branch',    'Noida',     'P103', 'BSES Rajdhani',     'MSEDCL',  'Maharashtra'),
  ('S104', 'Mumbai Office',   'Mumbai',    'P104', 'Torrent Power',     'MSEDCL',  'Maharashtra'),
  ('S105', 'Bangalore Hub',   'Bangalore', 'P105', 'CESC Limited',      'BESCOM',  'Karnataka'),
  ('S106', 'Chennai Center',  'Chennai',   'P106', 'Reliance Energy',   'TSSPDCL', 'Telangana'),
  ('S107', 'Hyderabad Unit',  'Hyderabad', 'P107', 'NTPC Utility',      'TSSPDCL', 'Telangana'),
  ('S108', 'Pune Facility',   'Pune',      'P108', 'Green Energy Corp', 'MSEDCL',  'Maharashtra'),
  ('S109', 'Kolkata Office',  'Kolkata',   'P109', 'State Power Board', 'BESCOM',  'Karnataka'),
  ('S110', 'Ahmedabad Plant', 'Ahmedabad', 'P110', 'Metro Electric',    'MSEDCL',  'Maharashtra')
ON CONFLICT (site_id) DO NOTHING;
