# PowerAudit AI

Audits electricity bills for Indian commercial/industrial multi-site businesses: recalculates Maximum Demand (MD) and Power Factor (PF) penalties against DISCOM tariff rules, flags billing errors with their rupee impact, tracks meters toward predicted breaches, and drafts disputes citing the exact tariff clause — with a named-human approval gate before anything is ever filed.

Full build context, formulas, and data model: `docs/CLAUDE.md`.

Every stateful piece of this system — document ingestion, OCR, LLM extraction, the relational database, trend analysis, dispute drafting, and the UI shell itself — runs on RocketRide. There is no separate backend.

## Built & Verified

- **Feature 6 foundation — RocketRide SQL schema.** All 7 Section 3 tables (Site, Meter, TariffOrder, Bill, Finding, Alert, Claim) created and verified via `information_schema`.
- **Feature 1 — Smart Bill Reading & Multi-format Parsing.** `pipelines/bill-ingestion.pipe` (dropper → parse → image_cleanup → OCR → extract_facts → response). Verified against 18 synthetic test bills (clean PDFs, degraded "photo" JPEGs, deliberately corrupted) via `scripts/ingest_bills.py`.
- **Feature 2 — deterministic recalculation core.** `calculators/` (`bill_line_parser.py`, `tariff_penalty_calculator.py`, `variance_detector.py`, `dollar_impact_scorer.py`) — zero LLM calls, 60/60 unit tests passing against hand-calculated values. Run via `scripts/recalculate_bills.py`, writing `Finding` rows to RocketRide SQL.
- **Feature 3 — Predictive Alerts & What-If Analytics.** `calculators/trend_classifier.py` — an explainable, documented linear-regression trend model. Verified live: correctly predicted a Contract Demand breach ~1.5 months out, then confirmed it against a simulated actual breach bill. `scripts/scan_trend_alerts.py` writes Alerts with a CrewAI-composed plain-language recommendation, running on RocketRide's `agent_crewai` node; `scripts/what_if_scenario.py` runs hypothetical scenarios with no Alert write.
- **Feature 4 — Dispute Assistant & Refund Claim Automation.** `calculators/claim_workflow.py` — a `Claim.status` state machine enforced in code: no claim, regardless of size, can skip the named-approver step. Verified against real Findings, including proving a Rs.53,000 claim can't be silently approved.
- **Feature 5 — Dashboard, Comparisons & Audit Trail, interactive bill upload, and claim approval.** `apps/poweraudit-ai-ui`: Portfolio Summary, Site Drill-down, and Comparisons views, all reading live RocketRide SQL (`tsc`/`rsbuild` build verified clean). Plus a real **Upload Bill** tab: drag a PDF/photo in, and the app runs the same ingestion → validation → recalculation pipeline the dev scripts do, live, with progress feedback. Verified end-to-end against the real server with a real file — see `apps/poweraudit-ai-ui/scripts/test-upload-integration.mts`. The Site Drill-down's **Claims** panel shows each claim's real `draft_packet` dispute text and an Approve action gated by a required approver-name field, enforced by a TypeScript port of `calculators/claim_workflow.py`'s state machine. Verified end-to-end against real claims: `apps/poweraudit-ai-ui/scripts/test-claim-workflow-parity.mts` and `test-claim-approval-integration.mts` (approving the real M001 claim and confirming the real Rs.53,000 M002 claim can't be approved with no name).

## RocketRide Pipelines

Six pipelines, each a graph of RocketRide components wired lane-to-lane:

- **`pipelines/bill-ingestion.pipe`** — `dropper` → `parse` → `image_cleanup` → `ocr` → `preprocessor_langchain` → `extract_facts` → `llm_gemini` → `response_answers`. Takes a raw bill (PDF or photo), cleans and OCRs it, chunks the text, and extracts structured billing facts (meter number, billing period, tariff category, contract demand, recorded MD/PF, line items) as JSON on the `answers` lane.
- **`pipelines/foundation-sql.pipe`** — `tools` → `rocketride_sql` → `llm_gemini`. Exposes the RocketRide SQL database as an LLM-callable tool; this is the single foundation connection every script and the app itself attaches to for all Site/Meter/TariffOrder/Bill/Finding/Alert/Claim reads and writes.
- **`pipelines/trend-recommendation.pipe`** — `chat` → `agent_crewai` → `llm_gemini` → `response_answers`. A CrewAI agent, backed by Gemini, composes a plain-language recommendation for a detected trend or predicted breach.
- **`pipelines/claim-composer.pipe`** — `chat` → `agent_crewai` → `llm_gemini` → `response_answers`. A second CrewAI agent drafts the dispute/refund-claim packet text for a Finding, instructed to quote its tariff citation verbatim and never invent facts.
- **`pipelines/tariff-vector-ingest.pipe`** — `webhook` → `parse` → `preprocessor_langchain` → `embedding_transformer` → `rocketride_vector`. Ingests a DISCOM tariff order document, chunks it, embeds it, and stores it in RocketRide Vector for citation lookup.
- **`pipelines/tariff-vector-query.pipe`** — `chat` → `embedding_transformer` → `rocketride_vector` → `response_documents`. Embeds a query and retrieves the matching tariff passage from RocketRide Vector.

Every LLM node's API key is a `${ROCKETRIDE_GEMINI_KEY}` placeholder, resolved server-side by RocketRide's own environment-substitution mechanism — no key is ever sent to or read by the browser. Pipelines are attached to, not repeatedly recreated: every caller uses `client.use({ pipeline, source, useExisting: true, ... })` keyed by a fixed `project_id`, so one running instance is shared across every script and app session.

## RocketRide SQL

All seven Section 3 tables (Site, Meter, TariffOrder, Bill, Finding, Alert, Claim) live in RocketRide's native SQL service, created and verified via `information_schema`. Every calculator script and the app's own views read and write through `client.database.query()` and `client.database.dialect()`, attached to the single `foundation-sql.pipe` instance so every caller shares one live connection and one schema description (the `rocketride_sql` node's `db_description`) that grounds the platform's own SQL-generation tooling.

## RocketRide SDK usage

**Python** (`scripts/`): `client.connect()` / `client.disconnect()`, `client.use()` (attach-or-start a pipeline by project id), `client.send_files()`, `client.database.query()` / `client.database.dialect()`, `client.get_task_token()` / `client.get_task_status()`, `client.chat()`, `client.terminate()`, and `client.get_services()` / `client.get_service()` for live service introspection.

**TypeScript** (`apps/poweraudit-ai-ui`): the same `RocketRideClient` surface through the app's own `rocketride` and `shell` packages — `client.use()`, `client.sendFiles()`, `client.database.query()` / `client.database.dialect()`, `client.getTaskToken()`, and `client.chat()`.

## RocketRide App Platform

`apps/poweraudit-ai-ui` is a native RocketRide app: an `appManifest` block in its `package.json` (id, publisher, categories, mode, and an `include` list that bundles its pipelines into the deployed app) and an `AppDescriptor` wired into the platform shell. Its UI is built entirely on RocketRide's own `shell` package — `AppLayout`, `SidebarMenu`, `useShellEvent`, `useShellConnection`, `Banner`, `Button`, `Card`, `CardDataGrid`, `ContentHeader`, `DropZone`, `EmptyState`, `InputField`, `MiniCard`, `MiniContainer`, `Question`, `ToggleGroup`. Its Portfolio Summary, Site Drill-down, Comparisons, Upload, and Claims views all run live against RocketRide SQL and the ingestion/trend/claim pipelines above, through the same App Builder-managed connection the platform hands every app on load.

## Setup

Copy `.env.example` to `.env` and fill in your own RocketRide credentials (the editor manages `ROCKETRIDE_URI`/`ROCKETRIDE_APIKEY` automatically on connect) and a Gemini API key. See `.rocketride/docs/` for the platform's own setup instructions. For the app, run `pnpm install` at the workspace root, then open `apps/poweraudit-ai-ui`'s App Builder panel (or `pnpm run build` / `pnpm run dev` directly in that folder).
