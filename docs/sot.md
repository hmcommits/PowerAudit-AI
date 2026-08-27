# PowerAudit AI — Agent Build Context
### Full context for a coding agent (Claude Code or equivalent) to build this app from an empty workspace to a deployed, demoable version on RocketRide staging.

---

## 0. Read this first — how to work

This document is the complete brief. Read it fully before writing any code. Two rules from RocketRide's own hackathon guide apply directly to how you should operate:

1. **Check ground truth before writing a line.** Before generating any pipeline or app code, read `.rocketride/docs/`, `services-catalog.json`, and `schema/` in the workspace. Those are the authoritative source for exact component names, config fields, and SDK signatures. Guessing at a node name or config shape produces code that looks right and fails on the server — always verify against these files first, not against anything in this document if the two ever disagree (this document may be stale relative to the actual workspace).
2. **Treat model output as data, not a contract.** Any Gemini/CrewAI node output must be parsed defensively downstream (validate shape, handle malformed JSON, don't assume a field exists). This matters most for Features 2–4, where a bad parse could silently corrupt a financial calculation or a claim draft.

Build in scoped phases with a clear exit condition per phase (Section 7) — no phase is done until its condition is met, regardless of how long it takes.

---

## 1. What you're building, in one paragraph

**PowerAudit AI** audits electricity bills for Indian commercial/industrial multi-site businesses. It reads bills in any format, independently recalculates two specific penalties almost nobody checks — the Maximum Demand (MD) penalty and the Power Factor (PF) penalty — against the currently published DISCOM tariff order, flags every kind of billing error with its rupee impact, tracks each meter's trend over time to warn before the next penalty happens, and drafts (never auto-files) disputes citing the exact tariff clause. Everything that could touch a live contract or tariff category requires a named human's approval before it goes anywhere.

**The pitch line:** *"Businesses don't lose money because their electricity rate is wrong — they lose money because nobody's watching the 15-minute window where they blew past their contracted demand. We catch that, and tell you what to change before it happens again."*

---

## 2. Domain facts the agent needs (don't invent these — verify against the loaded tariff order PDFs at build time)

- **Contract Demand (CD):** the maximum kVA a site has agreed not to exceed.
- **Maximum Demand (MD) penalty:** if Recorded MD exceeds CD in any 15-minute window, the excess is billed at a **1.5x–2x multiplier** depending on the DISCOM (MSEDCL uses 1.75x). Formula pattern: `MD Penalty = (Recorded MD − Contract Demand) × Demand Charge Rate × Penalty Multiplier`.
- **Power Factor (PF) penalty/incentive:** PF ≥ ~0.95 typically earns an incentive; PF ≤ ~0.90 triggers a surcharge scaled by how far below threshold the average PF falls. Exact slabs vary by state — always retrieve from the loaded tariff order, never hardcode.
- **These formulas change over time and vary by state/DISCOM.** This is why Feature 6's RocketRide Vector store of actual tariff order PDFs exists — never bake a formula into code as a constant.

---

## 3. Data model (build this first — everything else depends on it)

| Entity | Fields | Notes |
|---|---|---|
| **Site** | `site_id`, `name`, `address`, `business_unit` | One row per physical location |
| **Meter** | `meter_id`, `site_id`, `discom`, `tariff_category`, `contract_demand_kva`, `pf_threshold` | Holds the authoritative correct-rate/threshold determination |
| **TariffOrder** | `order_id`, `discom`, `state`, `effective_date`, `terms` (structured + source doc reference) | Versioned — a new order supersedes, never overwrites, the old one |
| **Bill** | `bill_id`, `meter_id`, `period_start`, `period_end`, `recorded_md`, `recorded_pf`, `line_items`, `total_due`, `source_doc_ref` | One row per bill as received, before recalculation |
| **Finding** | `finding_id`, `bill_id`, `meter_id`, `type` (`md-penalty` / `pf-penalty` / `misclass` / `unbilled` / `double-billed` / `stale-rate` / `math-error`), `rupee_impact`, `confidence`, `tariff_citation` | Output of Feature 2 |
| **Alert** | `alert_id`, `meter_id`, `trend_type`, `projected_impact`, `recommendation` | Output of Feature 3; can exist without a confirmed Finding |
| **Claim** | `claim_id`, `finding_id`, `status`, `contract_impacting` (bool), `approver`, `credited_amount` | Tracks a Finding from draft to resolution |

Implement this as **RocketRide SQL** tables (Feature 6) — do not stand up a separate database.

---

## 4. Feature-by-feature build spec

### Feature 1 — Smart Bill Reading & Multi-format Parsing
**Owns:** `bill-ingestion.pipe`
**Trigger:** new file(s) dropped into the ingestion input
**Pipeline:** `Drag & Drop` → `Cleanup` (deskew/denoise) → `OCR` → `Data Extractor` (pulls meter number, billing period, tariff category, CD, recorded MD, recorded PF, all line items, total due) → `Schema Validate` (rejects implausible values, e.g. negative demand, PF > 1.0) → write `Bill` record to RocketRide SQL
**Confidence handling:** anything Schema Validate can't confirm gets a `needs_review` flag on the Bill record instead of being silently accepted.
**Acceptance:** a batch of 20+ synthetic bills (mixed photo/PDF quality) ingests with correct field extraction on the clean ones and correct flagging on the deliberately corrupted ones.

### Feature 2 — Penalty & Error Detection + Automated Recalculation
**Owns:** `recalculation.pipe`
**Trigger:** new validated `Bill` record written
**Pipeline:**
1. `bill-line-parser` (Python) — normalizes line items
2. `RocketRide Vector` search — retrieves the current tariff formula for this Bill's meter's DISCOM/state
3. `tariff-penalty-calculator` (Python, **deterministic — no LLM**) — recomputes MD penalty and PF penalty per Section 2's formulas, using the retrieved (not hardcoded) rate/multiplier
4. `variance-detector` (Python) — compares billed vs. recalculated
5. `dollar-impact-scorer` (Python) — quantifies rupee_impact + confidence
6. `citation-attacher` (Vector search) — attaches the exact tariff clause text supporting the finding
7. Write `Finding` to RocketRide SQL

**Hard rule:** steps 1, 3, 4, 5 must be plain Python, unit-testable in isolation, with zero LLM calls. Only the citation-attacher touches Vector search, and even that's a retrieval operation, not a generation.
**Acceptance:** recalculated findings match hand-audited values within an agreed tolerance on a golden-set of synthetic bills with known-correct figures baked in.

### Feature 3 — Predictive Alerts & What-If Analytics
**Owns:** `trend-alert.pipe`
**Trigger:** new `Finding` written, or a scheduled scan
**Pipeline:**
1. `history-aggregator` (Python) — reads the meter's full CD/PF history from RocketRide SQL
2. `trend-classifier` (Python) — detects a trajectory heading toward a CD or PF breach before it happens
3. CrewAI agent (on Gemini) — turns a detected trend into a plain-language recommendation
4. Write `Alert` to RocketRide SQL, deliver via `HTTP Request`
**What-if mode:** same pipeline, invoked with a hypothetical parameter change (e.g. "CD raised by 20 kVA") instead of live data, returning a projected cost/savings comparison without writing an Alert record.
**Acceptance:** a synthetic multi-period meter history that trends toward a breach correctly fires an Alert before the simulated breach bill.

### Feature 4 — Dispute Assistant & Refund Claim Automation
**Owns:** `claim-drafting.pipe`
**Trigger:** new `Finding` above a materiality threshold
**Pipeline:**
1. CrewAI + Gemini claim-packet composer — drafts the dispute, grounded in the Finding and its tariff citation (never invent a clause not present in the retrieved TariffOrder text)
2. Contract-impact classifier — flags whether this claim would alter a live tariff category or CD agreement
3. `Guardrails` approval gate — holds for a named facilities approver; **no exceptions, regardless of claim size**
4. On approval, `HTTP Request` delivers the drafted packet (for manual filing — this system never submits to a DISCOM automatically)
5. Claim status machine: `Draft` → `Pending Approval` → `Approved — Ready to File` → `Filed` → `Under DISCOM Review` → `Credited` / `Denied`
**Acceptance:** a genuine Finding produces an approvable draft claim citing a real, retrieved tariff clause; rejecting it at the Guardrails gate correctly halts delivery.

### Feature 5 — Dashboard, Comparisons & Audit Trail
**Owns:** the RocketRide **App** (not a pipeline) — see Section 6 for how Apps differ from Pipelines
**Reads:** RocketRide SQL directly (Bill, Finding, Alert, Claim tables)
**Views needed:**
- Portfolio-wide summary: open Findings, active Alerts, Claims in progress
- Per-site drill-down: full history for one meter/site
- Comparisons view: sites ranked by cost-per-unit and penalty frequency, worst outliers first
- Every Finding/Alert/Claim must link back to its full lineage via RocketRide's built-in per-node tracing (source bill → tariff clause → calculation → outcome)
**Acceptance:** dropping a fresh batch of bills through Features 1–4 produces visibly updated dashboard state without a manual refresh/rebuild step.

### Feature 6 — Scale & Intelligence Layer
**This isn't a separate pipeline — it's the shared foundation Features 1–5 all depend on:**
- **RocketRide SQL**: all six tables from Section 3, set up before any other feature's pipeline is built
- **RocketRide Vector**: loaded with the actual published DISCOM tariff order PDFs (start with 2–3 real state tariff orders), indexed for retrieval by DISCOM + state
- **Batch behavior**: a whole folder of bills dropped in at once must trigger Features 1→2→3→4 per bill, in parallel, with no redesign or per-bill manual step
**Build this first, before any of Features 1–5.** Everything else writes to or reads from it.

---

## 5. Tech stack (confirm exact versions against `services-catalog.json` before scaffolding)

| Layer | Technology |
|---|---|
| Pipeline/orchestration | RocketRide (`.pipe` JSON files) |
| Deterministic calculation | Python, inside RocketRide Python tool nodes |
| Agent reasoning/drafting | CrewAI, model provider = Google Gemini (Flash tier, free API key from Google AI Studio) |
| Data/memory | RocketRide SQL + RocketRide Vector (bundled — do not provision a separate database) |
| App/UI | RocketRide's own **App Builder** (`.rrapp`), `src/App.tsx`, stock shell components — **not** a separately hosted Vercel/Render frontend |
| Package manager | **pnpm — never npm.** Confirmed by the hackathon guide: the toolchain (dependency install, watch loop, vendored platform packages) runs pnpm exclusively |
| Dev environment | VS Code + RocketRide staging VSIX + Claude Code |

---

## 6. How RocketRide Apps work (this replaces any earlier assumption of a separately hosted dashboard)

An **App** (`.rrapp`) is a different object from a **Pipeline** (`.pipe`) inside RocketRide, with five sub-tabs:

- **Dashboard** — status, what's deployed, conversation with the review team. Empty until first deploy.
- **Design** — the actual UI code lives here (`src/App.tsx`). Live preview reloads on save. A green "Connected" marker in the footer means the preview is correctly wired to the running app; red means the build is broken.
- **Package** — app id, display name, description, icon, README, and any workspace `include paths` beyond the app's own folder (e.g. `apps/shared`). The **Readiness panel** must be all-green before deploy — a missing include path fails the server build. Leave **Strict type checking** on; it surfaces type errors at deploy time instead of at demo time.
- **Store** — pricing/review requirements for public listings only. **Skip entirely** — `@me` and `@team` deploys never touch the Store.
- **Deploy** — register the team's Developer ID here **once** (letters and underscores only, no hyphens/digits/spaces), then `+ Deploy` to snapshot an immutable version, then publish it to `@me` (just you) or `@team` (everyone on the hackathon table) — both serve instantly. `@public` requires review and is not needed for this hackathon.

Feature 5 (the dashboard) is built as this App. Features 1–4 and 6 are built as Pipelines that the App's UI calls into via the RocketRide SDK.

---

## 7. Build sequence

**Phase 0 — Environment**
Confirm the RocketRide staging VSIX is installed and connected (custom server = `https://staging.rocketride.ai`), the team's hackathon promo code is redeemed, and a Gemini API key is available. Read `.rocketride/docs/`, `services-catalog.json`, and `schema/` before writing anything.
*Exit: `pnpm exec rocketride login` succeeds and `.env` contains non-empty `ROCKETRIDE_URI` / `ROCKETRIDE_APIKEY`.*

**Phase 1 — Foundation (Feature 6)**
Set up RocketRide SQL with the full Section 3 schema. Load 2–3 real tariff order PDFs into RocketRide Vector.
*Exit: a manual test query against RocketRide SQL returns an empty but correctly-shaped table set; a Vector search for a known clause returns it.*

**Phase 2 — Ingestion & Recalculation (Features 1–2)**
Build `bill-ingestion.pipe`, then `recalculation.pipe`. Test the Python calculator in isolation before wiring it into the pipeline.
*Exit: golden-set synthetic bills produce Findings matching hand-audited values within tolerance.*

**Phase 3 — Alerts & Claims (Features 3–4)**
Build `trend-alert.pipe` and `claim-drafting.pipe`, with the Guardrails gate in front of anything contract-impacting.
*Exit: a synthetic multi-period history correctly fires a predictive Alert before a simulated breach; a real Finding produces an approvable draft Claim.*

**Phase 4 — App / Dashboard (Feature 5)**
Scaffold a throwaway scratch App first, register the team's Developer ID on it, **then** create the real `poweraudit-ai` App (registering mid-build on the real app risks a namespace mismatch — see Troubleshooting). Build the dashboard, comparisons, and audit-trail views in Design, calling the pipelines above via the SDK.
*Exit: Package tab Readiness panel is fully green.*

**Phase 5 — Deploy & verify**
Deploy tab → `+ Deploy` → publish to `@team`. Open `staging.rocketride.ai`, sign in, launch the tile, and confirm the deployed build matches the Design tab preview (close the App Builder panel first — an active watch overrides the deployed version with your local build when checking).
*Exit: the published `@team` version, opened fresh from staging.rocketride.ai, runs the full pipeline chain end to end on a batch of test bills.*

---

## 8. Deployment checklist (staging-specific — do not confuse with general RocketRide Cloud instructions)

- [ ] VSIX installed from `https://staging.rocketride.ai/client/vscode` (any prior RocketRide extension removed first)
- [ ] Connection settings → Development → Connection mode → Cloud → **Use custom server** → `https://staging.rocketride.ai`
- [ ] Signed in via the OAuth flow (never paste a token manually)
- [ ] Settings **saved** (unsaved settings silently revert to the default endpoint)
- [ ] Hackathon promo code redeemed at staging.rocketride.ai's "Have a promo code?" bar — try `INDIAHACK1` first, then `INDIAHACK` if rejected (the source guide is inconsistent between its header and Step 9 — confirm the correct one on Discord if both fail)
- [ ] Developer ID registered **once**, on a scratch app, before the real app is created
- [ ] Real app (`poweraudit-ai` or similar) created **after** Developer ID registration, so its Identity block resolves to the team namespace automatically
- [ ] Package tab Readiness panel fully green before attempting deploy
- [ ] Deployed and published to `@team`
- [ ] Verified live on staging.rocketride.ai with the App Builder panel closed (to rule out seeing a stale local build)

---

## 9. Troubleshooting quick table (condensed from the official guide)

| Symptom | Fix |
|---|---|
| "Create App" greyed out | App name must start lowercase, letters/digits/underscores/hyphens only |
| "Register" greyed out | Developer ID: letters and underscores only — no hyphens/digits/spaces |
| New app still shows Developer ID = `local` | Close and reopen the New App tab — it read the profile before you registered |
| Deploy card shows `failed` | Open the card, read the build log — failing phase is named at the top, reason on the last line |
| Readiness panel not all green | Fill the missing Package tab item; a missing include path fails the build |
| "No authorization provided" | `.env`'s `ROCKETRIDE_APIKEY` is empty — run `pnpm exec rocketride login` in the workspace root |
| Signed out again minutes later | Same root cause — rerun the login command; report it if it recurs |
| App preview shows a "Sign in required" wall | Set `"authenticated": false` in the app's `package.json` and handle the signed-out state in-app |
| Deploy tab is read-only | App was scaffolded before Developer ID was claimed — rename `appManifest.id` in `package.json` **and** the `id` field in `src/AppDescriptor.ts` to match (they must be identical) |

---

## 10. Definition of done

- [ ] All six features built and functioning per their acceptance criteria above
- [ ] A batch of 20+ bills processes end-to-end (ingest → recalculate → alert-check → claim-draft-if-applicable) with no manual per-bill steps
- [ ] The deterministic recalculation core has zero LLM involvement, verified by code review
- [ ] Every contract-impacting claim is blocked at the Guardrails gate until a named approval is recorded
- [ ] The App is deployed and published to `@team`, and verified live from a fresh browser session on staging.rocketride.ai
- [ ] `.pipe` files and app source are committed to the team's repo

---

## Reference sources (only what's needed at build time)

- Ground truth for this workspace: `.rocketride/docs/`, `services-catalog.json`, `schema/` — check these first, always
- RocketRide docs: https://docs.rocketride.org · Node reference: https://docs.rocketride.org/nodes · Pipeline JSON reference: https://docs.rocketride.org/pipeline-reference
- Staging client: https://staging.rocketride.ai/client/vscode · Staging console: https://staging.rocketride.ai
- Gemini API key (free tier, no card): Google AI Studio
- Stuck: Discord support channel, `#support` — ask "Rocket Ralph"
