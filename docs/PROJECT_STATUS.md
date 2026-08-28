# PowerAudit AI — Honest Project Status Audit

**Date:** 2026-08-28
**Audited against:** commit `1b41d68`, live RocketRide staging data, and `docs/CLAUDE.md`
**Method:** read the actual source, queried the live database for real row counts, and
checked the live deployment registry. Nothing below is from memory of what was built.

> **Read this first — the two findings that matter most.**
>
> 1. **The deployed app is ~6 commits stale and contains none of the interactive
>    features.** The newest deployed version (v2) was built `2026-08-27 16:12Z`.
>    Bill upload, claim approval, the scroll fixes, the UI polish, and the
>    foundation-sql reconnect fix were all committed *after* that. Anyone opening
>    the app tile from `staging.rocketride.ai` today gets a **read-only dashboard
>    with the known broken scroll and no upload or approval buttons at all** — and
>    without the foundation-sql fix, it will show a raw connection error the first
>    time the host task is idle-reaped. **Everything demoable currently exists only
>    in the local dev preview.** A redeploy is the single highest-impact action
>    available.
> 2. **This is a single-tenant demo with no authentication.** `authenticated: false`,
>    and there is no user, org, or company scoping anywhere in the schema or code.
>    Every viewer sees and can mutate the same global dataset. This is not a
>    hardening gap — it is a missing architectural dimension.

---

## 1. Feature completion

| # | Feature | Status | What's missing |
|---|---------|--------|----------------|
| 1 | Smart Bill Reading & Parsing | **Substantially built** | Extraction fidelity is not reliable (see below). Meter-mismatch review queue not built — OCR misreads reject the bill outright. |
| 2 | Penalty & Error Detection / Recalculation | **Partially built** | Math core is real and tested, but **only 3 of the 7 specified Finding types exist**, and the tariff rates it calculates against are **stubs, not real tariff orders**. |
| 3 | Predictive Alerts & What-If | **Partially built** | Logic is real and tested; **not exposed in the UI at all** (terminal-only), and delivery via `HTTP Request` was never built. 1 Alert row exists in the entire database. |
| 4 | Dispute Assistant & Refund Claims | **Partially built** | Drafting + approval gate are real. **Claim drafting is terminal-only**; step 4 (deliver the approved packet) was never built. Citations in every packet are stub text. |
| 5 | Dashboard, Comparisons & Audit Trail | **Built, but not deployed** | Four views work in dev. Two of five write actions are exposed in the UI. Per-node lineage tracing (Section 4's explicit requirement) was never wired up. |
| 6 | Scale & Intelligence Layer | **Half built** | SQL foundation is real and solid. **RocketRide Vector is entirely non-functional** (server bug) — so the tariff corpus, the whole reason Feature 6 exists, is empty. `tariff_order` table: **0 rows**. Batch parallelism is throttled to serial. |

### Feature 2 — the gap most likely to be missed

`docs/CLAUDE.md` Section 3 specifies seven Finding types. The database `CHECK`
constraint permits all seven. **`calculators/variance_detector.py` produces exactly
three:** `md-penalty`, `pf-penalty`, `math-error`.

Never implemented: **`misclass`, `unbilled`, `double-billed`, `stale-rate`.**

Feature 2's brief says it "flags every kind of billing error." It flags three of
seven. `stale-rate` in particular is unimplementable today because it requires the
versioned `TariffOrder` data that Vector was supposed to hold.

### Feature 3 — real logic, almost no real output

`trend_classifier.py` is genuinely good work: explainable OLS regression, no ML
black box, 60/60 unit tests green, and it was verified live predicting a real
breach ~1.5 months out. But the entire `alert` table contains **one row**. The
detection logic is real; the operational surface around it barely exists.

---

## 2. Static vs Dynamic — honest classification

### DYNAMIC & USER-READY *(a real user could do this in the UI, no terminal)*
- **Upload a bill and see it audited.** Drag a PDF/photo in → real OCR → real
  extraction → real validation → real recalculation → Findings written to real SQL.
  End-to-end, no developer involvement. This is the strongest thing in the project.
- **Approve a refund claim.** Type an approver name → the state machine validates →
  status persists in SQL. The "no claim can skip a named human" guarantee is real
  and enforced server-side of the UI, not just a disabled button.
- **Read all four dashboard views** against live data.

⚠️ **All of the above is true only in the local dev preview. None of it is in the
deployed app.**

### DYNAMIC BUT DEVELOPER-ONLY *(real live data; terminal-only)*
- **Predictive alert scanning** — `scripts/scan_trend_alerts.py`. No UI trigger.
- **What-if scenario analysis** — `scripts/what_if_scenario.py`. No UI at all.
- **Claim drafting** — `scripts/draft_claims.py`. The UI can *approve* claims but
  cannot *create* one. A user who uploads a bill and gets a material Finding has no
  way to turn it into a claim without a developer running a script.
- **Batch ingestion of many bills** — `scripts/ingest_bills.py`. The UI is strictly
  one file at a time.
- **Schema setup / meter seeding** — expected to be developer-only.

### STATIC / STUBBED
- **All tariff rates and thresholds.** Every penalty in the system is calculated
  against `STUB_TARIFF_PARAMS` — invented, illustrative numbers.
- **Every tariff citation on every Finding and every dispute packet** is the literal
  string `[STUB - Vector citation-attacher not wired...]`.
- **`tariff_order` table is empty.** The versioned-tariff entity does not exist in
  practice.
- **Per-meter `pf_threshold` is dead data** (see §3).
- **Bills themselves** are 18 synthetic fixtures we generated. No real DISCOM bill
  has ever been through this system.

**The honest one-line version:** *bill upload and claim approval are genuinely
dynamic and user-ready; every rupee figure they produce is computed against
invented tariff constants and cited to a placeholder string.*

---

## 3. The stub inventory

| Stub | Location | Standing in for | Blocked? |
|---|---|---|---|
| `STUB_TARIFF_PARAMS` | `scripts/recalculate_bills.py:40`, ported to `src/lib/stubTariff.ts:25` | Real per-DISCOM demand rates & PF slabs from a published tariff order, retrieved via Vector | **Blocked by Vector** for the "retrieve from PDF" path — but see note below |
| `STUB_CITATION` | same two files | Vector citation-attacher pulling the exact supporting clause text | **Blocked by Vector** |
| Empty `tariff_order` table | schema exists, never populated | Versioned DISCOM tariff orders | **Partially blocked** — the *table* could be populated by hand today |
| `pf_threshold` column | `meter` table — populated (0.95) but **never read** | Per-meter PF threshold | **Not blocked — fixable now** |
| 18 synthetic bills | `scripts/synthetic_bills/` | Real customer bills | Not blocked |
| Hardcoded `100000` energy-charge fallback | `recalculate_bills.py:135`, `billIngestion.ts:183` | Actual energy charge when line items don't parse | Not blocked |

### The `pf_threshold` finding — a real latent bug, not just a stub

`meter.pf_threshold` is defined `NOT NULL`, seeded with real per-meter values, and
**selected** by `scan_trend_alerts.py:59` — then **never used**. Line 133 passes
`params["surcharge_threshold"]` (the global stub, 0.90) to the classifier instead of
the meter's own 0.95. `recalculate_bills.py` ignores the column entirely.

So even the genuine per-meter data the system already has is being overridden by an
invented global constant. **This is fixable right now with no external dependency**,
and it is the clearest case of "looks done, isn't."

### What could be de-stubbed today, without waiting for RocketRide

1. **Wire `meter.pf_threshold` into the calculators.** Pure code change.
2. **Populate `tariff_order` by hand** from published MSEDCL/BESCOM/TATA orders and
   read rates from SQL instead of a Python dict. This gets ~80% of the real value of
   the Vector work — versioned, auditable, per-DISCOM rates — **without Vector at
   all**. Vector's unique contribution is semantic clause *retrieval* for citations;
   the *numbers* don't need it. This is the single biggest un-blocked credibility win
   available and it is not currently on the plan.
3. **Replace `STUB_CITATION`** with a real clause reference typed alongside those
   tariff rows. Less elegant than Vector retrieval; far more honest than a
   placeholder.

---

## 4. Real-world usability gaps

**Blocking for any real business:**

1. **No authentication or multi-tenancy.** `authenticated: false`; no `org_id`/
   `tenant_id`/`user_id` anywhere. Two companies using this would share one global
   pool of sites, meters, bills, and claims, and could approve each other's refund
   claims. This is a from-scratch architectural addition, not a patch.
2. **Their tariffs don't exist here.** Rates are invented and hardcoded per DISCOM
   name string. A business on a DISCOM not in the four-key dict gets **silently
   skipped** — `STUB_TARIFF_PARAMS.get(discom)` returns `None` and recalculation
   quietly does nothing. No error, no warning, no Finding.
3. **Their meters don't exist here.** Meters must be pre-seeded by a developer
   running a script. There is no UI to add a site or meter, so a new customer
   literally cannot begin.
4. **Extraction is not trustworthy on real bills.** Documented in the Backlog: the
   reversed-billing-period test case was silently accepted as valid **0 out of 2
   times**. On real bills with unfamiliar layouts this will be worse. The
   `needs_review` flag helps but demonstrably does not catch everything.
5. **OCR meter misreads are a dead end.** A misread meter number rejects the bill
   with no queue and no reassignment path. On real scanned bills this will be common.
6. **A material Finding cannot become a claim through the UI.** The workflow
   dead-ends until a developer runs `draft_claims.py`.
7. **Approved claims go nowhere.** Feature 4 step 4 — deliver the packet — was never
   built. A claim reaches `approved_ready_to_file` and stops. The user must copy the
   text out manually.

**Also real, lower severity:**

8. **Free-tier Gemini quota forces serial processing** (~5s/bill + retries),
   directly contradicting Feature 6's parallel-batch requirement.
9. **Stale Findings are never cleaned up** (documented). A corrected re-extraction
   leaves the old wrong Finding in place.
10. **No audit lineage UI.** Section 4 explicitly requires every Finding/Alert/Claim
    to link back through source bill → clause → calculation. We store `bill_id`
    lineage but never surfaced RocketRide's per-node tracing.
11. **Three pieces of logic are hand-duplicated Python↔TypeScript** with only two
    covered by parity tests (documented as a standing risk).

---

## 5. What's genuinely done — claim these without hedging

- **The deterministic recalculation core.** `calculators/` — MD/PF penalty math,
  line-item normalization, variance detection, impact scoring. Zero LLM calls,
  **60/60 unit tests passing** against hand-computed values. Real, correct work.
- **The TypeScript calculator port is provably identical** to the Python original —
  verified across **all 14 comparable real bills, 0 mismatches**, not spot-checked.
- **The claim approval gate genuinely cannot be bypassed.** Enforced structurally in
  both implementations, verified against the real ₹53,000 M002 claim: empty,
  whitespace-only, and null approver names all rejected, claim left at
  `pending_approval`. Also verified `draft → approved_ready_to_file` cannot be
  skipped. **18/18 ported state-machine tests match the Python suite.**
- **End-to-end bill ingestion works on real files** — OCR through to Findings in SQL,
  verified live on OK / NEEDS_REVIEW / REJECTED paths.
- **The trend classifier is real and explainable** — plain OLS, no black box,
  verified predicting a real breach ~1.5 months ahead.
- **The SQL foundation is solid** — all 7 tables, correct FKs and constraints, and
  two genuine FK-violation bugs found and fixed by testing against real data.
- **The foundation-sql reconnect fix is real** — verified by actually terminating the
  live task and confirming recovery.
- **Secrets are clean.** The Gemini key appears in no bundle, no source file, and no
  server response; `.env` verified gitignored across full history.

---

## 6. Prioritized remaining work

### Do now — highest impact, nothing blocking

1. **Redeploy the app.** Everything interactive is missing from what's live. Nothing
   else on this list matters if a judge opens a stale, read-only, broken-scroll build.
2. **Fix the `pf_threshold` override.** Small change; removes a real correctness bug.
3. **Populate `tariff_order` with real published rates and read from it.** The
   biggest credibility gain available without RocketRide fixing anything. Converts
   "invented constants" into "real, versioned, auditable tariff data."
4. **Expose claim drafting in the UI.** Closes the dead end between a Finding and a
   claim — the most visible hole in the user journey.
5. **Handle unknown DISCOMs loudly** instead of silently skipping recalculation.

### Do next — real gaps, larger effort

6. Meter-mismatch review queue (the OCR dead end).
7. A UI to add sites/meters, so onboarding doesn't require a developer.
8. Claim packet delivery/export (Feature 4 step 4).
9. Surface lineage tracing in the UI (an explicit Section 4 requirement).
10. Implement more of the 4 missing Finding types (`misclass`, `unbilled`,
    `double-billed` are feasible; `stale-rate` needs real TariffOrder data first).

### Blocked on external fix

11. **Vector semantic citation retrieval** — blocked on the `rocketride_vector` store
    bug, reported to RocketRide. *Note: only the citation-retrieval half is truly
    blocked. The tariff numbers can and should be de-stubbed via item 3 without it.*
12. **Parallel batch processing** — blocked on Gemini quota, not on code.

### Known-and-accepted for a hackathon; disqualifying for production

13. Authentication and multi-tenancy.
14. Extraction fidelity guarantees on arbitrary real-world bill layouts.

---

## Appendix — live database state (2026-08-28)

```
site            2      tariff_order    0   ← never populated
meter          15      finding        30   (4 with negative/undercharge impact)
bill           33      alert           1   ← Feature 3 barely exercised
claim           9      (6 draft, 3 approved_ready_to_file)
```

No claim has ever reached `filed`, `under_discom_review`, `credited`, or `denied`
against real data — those transitions are covered by unit tests only. 4 of 33 bills
are flagged `needs_review`.
