# PowerAudit AI

Audits electricity bills for Indian commercial/industrial multi-site businesses: recalculates Maximum Demand (MD) and Power Factor (PF) penalties against DISCOM tariff rules, flags billing errors with their rupee impact, and (planned) drafts disputes citing the exact tariff clause.

Full build context, formulas, and data model: [docs/CLAUDE.md](docs/CLAUDE.md) (see its **Backlog / known limitations** section for platform issues found during the build).

## Built & Verified

- **Feature 6 foundation — RocketRide SQL schema.** All 7 Section 3 tables (Site, Meter, TariffOrder, Bill, Finding, Alert, Claim) created and verified via `information_schema`. `pipelines/foundation-sql.pipe` + `scripts/setup_schema.py`.
- **Feature 1 — Smart Bill Reading & Multi-format Parsing.** `pipelines/bill-ingestion.pipe` (dropper → parse → image_cleanup → OCR → extract_facts → response), run against 18 synthetic test bills (clean PDFs, degraded "photo" JPEGs, deliberately corrupted) via `scripts/ingest_bills.py`: 11 clean, 3 correctly flagged `needs_review`, 4 correctly rejected pre-write (no valid meter). `scripts/make_synthetic_bills.py` regenerates the fixtures.
- **Feature 2 — deterministic recalculation core.** `calculators/` (`bill_line_parser.py`, `tariff_penalty_calculator.py`, `variance_detector.py`, `dollar_impact_scorer.py`) — zero LLM calls, 34/34 unit tests passing against hand-calculated values. Run end-to-end against real Bill data via `scripts/recalculate_bills.py`, writing `Finding` rows to RocketRide SQL.

## Designed, Stubbed Pending Vector Fix

- **RocketRide Vector.** `rocketride_vector`'s document-store step is confirmed broken on `staging.rocketride.ai` (reproduced with a hand-crafted PDF, plain text, and a real MSEDCL tariff order excerpt; isolated to the store node specifically — `parse`/`preprocessor_langchain`/`embedding_transformer` all work). `pipelines/tariff-vector-ingest.pipe` and `tariff-vector-query.pipe` are built and validate cleanly server-side, but can't be exercised end-to-end until this is fixed (reported to RocketRide support).
- **Feature 2 steps 2 & 6 (tariff retrieval + citation-attacher).** `scripts/recalculate_bills.py` uses `STUB_TARIFF_PARAMS` (illustrative rates, not sourced from any real tariff order) and a loudly-labeled `STUB_CITATION` string in place of the Vector lookup these steps depend on.
- **Feature 3 — Predictive Alerts & What-If Analytics.** Scoped per the build context (Section 4); not started.
- **Feature 4 — Dispute Assistant & Refund Claim Automation.** Scoped per the build context (Section 4); not started.
- **Feature 5 — Dashboard, Comparisons & Audit Trail.** Scoped per the build context (Section 6); not started. Also carries a logged backlog item (meter-mismatch review queue) — see docs/CLAUDE.md.

## Setup

Copy `.env.example` to `.env` and fill in your own RocketRide credentials (the editor manages `ROCKETRIDE_URI`/`ROCKETRIDE_APIKEY` automatically on connect) and a Gemini API key. See `.rocketride/docs/` for the platform's own setup instructions.
