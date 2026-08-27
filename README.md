# PowerAudit AI

Audits electricity bills for Indian commercial/industrial multi-site businesses: recalculates Maximum Demand (MD) and Power Factor (PF) penalties against DISCOM tariff rules, flags billing errors with their rupee impact, tracks meters toward predicted breaches, and drafts disputes citing the exact tariff clause — with a named-human approval gate before anything is ever filed.

Full build context, formulas, and data model: [docs/CLAUDE.md](docs/CLAUDE.md) (see its **Backlog / known limitations** section for platform issues found during the build).

## Built & Verified

- **Feature 6 foundation — RocketRide SQL schema.** All 7 Section 3 tables (Site, Meter, TariffOrder, Bill, Finding, Alert, Claim) created and verified via `information_schema`.
- **Feature 1 — Smart Bill Reading & Multi-format Parsing.** `pipelines/bill-ingestion.pipe` (dropper → parse → image_cleanup → OCR → extract_facts → response). Verified against 18 synthetic test bills (clean PDFs, degraded "photo" JPEGs, deliberately corrupted) via `scripts/ingest_bills.py`.
- **Feature 2 — deterministic recalculation core.** `calculators/` (`bill_line_parser.py`, `tariff_penalty_calculator.py`, `variance_detector.py`, `dollar_impact_scorer.py`) — zero LLM calls, 60/60 unit tests passing against hand-calculated values. Run via `scripts/recalculate_bills.py`, writing `Finding` rows to RocketRide SQL.
- **Feature 3 — Predictive Alerts & What-If Analytics.** `calculators/trend_classifier.py` — an explainable, documented linear-regression trend model (not a black box). Verified live: correctly predicted a Contract Demand breach ~1.5 months out, then confirmed it against a simulated actual breach bill. `scripts/scan_trend_alerts.py` writes Alerts with a CrewAI-composed plain-language recommendation; `scripts/what_if_scenario.py` runs hypothetical scenarios with no Alert write.
- **Feature 4 — Dispute Assistant & Refund Claim Automation.** `calculators/claim_workflow.py` — a `Claim.status` state machine enforced in code: no claim, regardless of size, can skip the named-approver step. Verified against real Findings, including proving a Rs.53,000 claim can't be silently approved.
- **Feature 5 — Dashboard, Comparisons & Audit Trail, and interactive bill upload.** `apps/poweraudit-ai-ui`: Portfolio Summary, Site Drill-down, and Comparisons views, all reading live RocketRide SQL (`tsc`/`rsbuild` build verified clean). Plus a real **Upload Bill** tab: drag a PDF/photo in, and the app runs the same ingestion → validation → recalculation pipeline the dev scripts do, live, with progress feedback and graceful handling of rejected/flagged bills. Verified end-to-end against the real server with a real file — see `apps/poweraudit-ai-ui/scripts/test-upload-integration.mts`.

## Designed, Stubbed Pending Vector Fix

- **RocketRide Vector.** `rocketride_vector`'s document-store step is confirmed broken on `staging.rocketride.ai` (reproduced with a hand-crafted PDF, plain text, and a real MSEDCL tariff order excerpt; isolated to the store node specifically — `parse`/`preprocessor_langchain`/`embedding_transformer` all work). `pipelines/tariff-vector-ingest.pipe` and `tariff-vector-query.pipe` are built and validate cleanly server-side, but can't be exercised end-to-end until this is fixed (reported to RocketRide support).
- **Tariff retrieval + citation-attacher.** `STUB_TARIFF_PARAMS` (illustrative rates, not sourced from any real tariff order) and a loudly-labeled `STUB_CITATION` string stand in for the Vector lookup these steps depend on, in both the Python scripts and the app's TypeScript port.
- **Feature 5's meter-mismatch review queue** (OCR misreads on meter numbers currently reject rather than queue for reassignment) — logged, not built. See docs/CLAUDE.md's Backlog for this and other known gaps.

## Setup

Copy `.env.example` to `.env` and fill in your own RocketRide credentials (the editor manages `ROCKETRIDE_URI`/`ROCKETRIDE_APIKEY` automatically on connect) and a Gemini API key. See `.rocketride/docs/` for the platform's own setup instructions. For the app, run `pnpm install` at the workspace root, then open `apps/poweraudit-ai-ui`'s App Builder panel (or `pnpm run build` / `pnpm run dev` directly in that folder).
