# PowerAudit AI — Complete Feature Reference
### Problem → Solution → Workflow → RocketRide → Usage → Installation

---

## How this document is organized

Each of the six features gets the same five-part breakdown: **Problem** (what part of the overall issue it solves), **Solution** (what it actually does), **Workflow** (the exact pipeline steps), **RocketRide Usage** (which nodes), and **How to Use It** (what it looks like in practice). After all six, you'll find RocketRide installation steps and official documentation links.

---

## Feature 1: Smart Bill Reading & Multi-format Parsing

**Problem**
Bills never arrive in one clean format — a photo from a phone, a scanned copy, a PDF export. Most tools assume clean input; real bills are never clean.

**Solution**
A single ingestion pipeline that reads any bill format and pulls out every field the rest of the system needs, flagging anything it isn't confident about instead of guessing.

**Workflow**
1. Batch of bills dropped in (Drag & Drop node)
2. Cleanup node deskews/denoises photographed bills
3. OCR node extracts raw text
4. Data Extractor pulls structured fields: meter number, billing period, tariff category, Contract Demand, Recorded Maximum Demand, Power Factor, all line-item charges, total due
5. Schema Validate checks the extraction is plausible (catches OCR misreads before they corrupt anything downstream)
6. Written to RocketRide SQL as a Bill record; low-confidence extractions flagged for human review

**RocketRide Usage**
`Drag & Drop` → `Cleanup` → `OCR` → `Data Extractor` → `Schema Validate` → `RocketRide SQL` (write)

**How to Use It**
Drop a folder of bill photos/PDFs into the ingestion input (RocketRide Local canvas during dev, or the dashboard's upload button once deployed). Each bill appears in the Bill table within moments, fields pre-filled. Anything flagged shows a "needs review" badge — click it to see the original scan next to what was extracted and correct it by hand if needed.

---

## Feature 2: Penalty & Error Detection + Automated Recalculation

**Problem**
Maximum Demand and Power Factor penalties are calculated from formulas almost nobody checks — plus the ordinary stuff (wrong tariff category, double billing, stale rates) hides inside a bill that looks plausible on its own.

**Solution**
Independently recalculates every bill against the currently published DISCOM tariff order, and flags every kind of variance with its exact rupee impact and the clause it's based on.

**Workflow**
1. Triggered automatically the moment Feature 1 writes a validated Bill record
2. `bill-line-parser` normalizes the line items
3. RocketRide Vector retrieves the current tariff formula for that meter's DISCOM/state
4. `tariff-penalty-calculator` (deterministic Python — not an LLM) recomputes the MD penalty and PF penalty
5. `variance-detector` compares billed vs. recalculated amounts
6. `dollar-impact-scorer` quantifies the gap and a confidence score
7. `citation-attacher` (Vector search) attaches the exact tariff clause supporting the finding
8. Finding record written to RocketRide SQL

**RocketRide Usage**
`Python tool nodes` (×4: parser, calculator, variance-detector, impact-scorer) → `RocketRide Vector` (formula retrieval + citation) → `RocketRide SQL` (write Finding)

**How to Use It**
Fully automatic — no manual trigger. The output appears as a new row in the Findings table: a rupee amount, a confidence percentage, and a clickable citation to the exact tariff clause it's based on.

---

## Feature 3: Predictive Alerts & What-If Analytics

**Problem**
By the time a penalty shows up on a bill, the money is already gone. Nothing warns a facility before it crosses into penalty territory.

**Solution**
Watches each meter's CD and PF trend across every past bill, warns before the next bill crosses a threshold, and answers "what if" questions about fixes.

**Workflow**
1. Triggered by a new Finding, or a scheduled scan
2. `history-aggregator` (Python) reads that meter's full CD/PF history from RocketRide SQL
3. `trend-classifier` (Python) checks whether the trajectory is heading toward a breach
4. If so, a CrewAI agent (running on Gemini) turns that into a plain-language recommendation — "raise Contract Demand," "service the capacitor bank," "stagger equipment startup"
5. Alert record written to RocketRide SQL and delivered via HTTP Request

**RocketRide Usage**
`Python tool nodes` (history-aggregator, trend-classifier) → `CrewAI agent + Gemini node` → `RocketRide SQL` (read history, write Alert) → `HTTP Request` (delivery)

**How to Use It**
Runs automatically in the background after every new bill. Alerts show up on the dashboard ahead of the next billing cycle. A "what if" box lets a facility manager type a hypothetical ("what if we raised CD by 20 kVA?") and get an estimated cost/savings comparison back from the same pipeline in a lightweight simulation mode.

---

## Feature 4: Dispute Assistant & Refund Claim Automation

**Problem**
Even after an error is found, writing a defensible dispute citing the correct clause and tracking it over weeks is a manual chore most teams never finish — so real, identified errors just go unrecovered.

**Solution**
Auto-drafts the dispute citing the exact tariff clause, and tracks it from draft to resolution — but nothing is ever sent without a named human's approval.

**Workflow**
1. Triggered by a new Finding above a materiality threshold
2. CrewAI + Gemini claim-packet composer drafts the dispute, grounded in the Finding and its tariff citation
3. Contract-impact classifier checks whether the claim touches a live tariff category or CD agreement
4. Guardrails approval gate holds it for a named facilities approver — mandatory, no exceptions
5. Once approved, HTTP Request delivers the drafted packet for manual filing with the DISCOM
6. Claim status tracked: Draft → Pending Approval → Filed → Under DISCOM Review → Credited / Denied

**RocketRide Usage**
`CrewAI agent + Gemini node` → `Guardrails` → `HTTP Request` → `RocketRide SQL` (Claim record + status history)

**How to Use It**
A facility manager sees a "Ready for review" claim in their queue, reads the pre-drafted dispute (already citing the correct clause and amount), clicks Approve or Reject. If approved, they download/copy the packet and file it with the DISCOM themselves — the system never submits anything automatically.

---

## Feature 5: Dashboard, Comparisons & Audit Trail

**Problem**
Findings, alerts, and claims mean nothing scattered across separate views — and without comparing sites against each other, obvious problems stay invisible.

**Solution**
One screen for everything, plus a comparison view that surfaces the biggest outliers across your portfolio automatically.

**Workflow**
1. Reads directly from RocketRide SQL (Bill, Finding, Alert, Claim tables)
2. Renders portfolio-wide and per-site dashboard views
3. A comparison query groups by site/DISCOM to compute relative cost-per-unit and penalty frequency, ranking the biggest outliers first
4. Every Finding, Alert, and Claim links back to its full lineage — source bill → tariff clause → calculation → outcome — via RocketRide's built-in per-node tracing

**RocketRide Usage**
`RocketRide SQL` (read) → `TypeScript SDK` (dashboard ↔ pipeline calls) → RocketRide's built-in tracing (audit trail)

**How to Use It**
Open the dashboard to a portfolio-wide summary (open findings, active alerts, claims in progress). Click into any site for its full history, or open the Comparisons tab to see which sites are quietly overpaying relative to the rest of the portfolio.

---

## Feature 6: Scale & Intelligence Layer

**Problem**
None of the above matters if it only works on one test bill. The entire pitch depends on this running across dozens of meters as a real, steady batch — not a one-off demo trick.

**Solution**
The foundational layer everything else is built on: RocketRide's own bundled memory (SQL + Vector), set up so every other feature can run across a whole portfolio at once with no redesign.

**Workflow**
1. RocketRide SQL is set up as the system of record — Site, Meter, Bill, Finding, Alert, and Claim tables
2. RocketRide Vector is loaded with the actual published DISCOM tariff order PDFs, indexed for retrieval by state/DISCOM
3. Every other pipeline (Features 1–5) reads and writes through this shared layer
4. A batch run is triggered by dropping a whole folder of bills at once — the same five pipelines fire per bill, in parallel, with no per-bill manual work

**RocketRide Usage**
`RocketRide SQL` + `RocketRide Vector` — the two bundled nodes every other feature depends on

**How to Use It**
Not user-facing on its own — this is the plumbing everything else runs on top of. Whoever owns this makes sure a batch of 20–30 bills dropped in at once processes cleanly end to end, since that's the single most important thing a judge will actually test live.

---

## RocketRide Installation

1. **Join the Discord** — discord.gg/PMXrtenMsY (support channel, ask "Rocket Ralph" if stuck)
2. **Install the extension**
   - VS Code: search "RocketRide" in the Extensions Marketplace
   - Cursor / Windsurf / VSCodium: install from **Open VSX** instead — these forks can't reach the Microsoft Marketplace
3. **Connect in Local mode** — free, no account needed. The extension downloads and manages the engine for you (Development tab → Connection mode → Local)
4. **Build and run one small test pipeline** just to confirm it works before building anything real
5. **Get a free Gemini API key** from Google AI Studio (no card required) — used as the model provider throughout, both Local and Cloud, so there's no swap later
6. **Do all of the above at home, not at the venue** — many people downloading engine binaries at once on venue wifi is the most common way teams lose their first hour

**To deploy for the live demo:**
1. Sign up at cloud.rocketride.ai
2. Redeem the organizer's promo code (no card needed) — until redeemed, Pipeline Builder stays badged "Payment Required"
3. In the extension: Development tab → Connection mode → **RocketRide Cloud** → sign in → choose your Team → **Save All Settings** (doesn't apply until saved)
4. Same `.pipe` files, now running on a live, shareable link instead of localhost

---

## RocketRide Documentation Sources

| Resource | Link |
|---|---|
| Docs home | https://docs.rocketride.org |
| Node reference | https://docs.rocketride.org/nodes |
| Pipeline JSON reference | https://docs.rocketride.org/pipeline-reference |
| Python SDK | https://docs.rocketride.org/develop/python |
| Troubleshooting | https://docs.rocketride.org/troubleshooting |
| VS Code extension | https://marketplace.visualstudio.com/items?itemName=RocketRide.rocketride |
| Open VSX (Cursor/Windsurf) | https://open-vsx.org/extension/RocketRide/rocketride |
| Cloud console | https://cloud.rocketride.ai |
| Discord | https://discord.gg/PMXrtenMsY |
| Community projects | https://github.com/rocketride-org/awesome-rocketride |
| Quickstart video | https://www.youtube.com/watch?v=bpoNvb8oOxY |
