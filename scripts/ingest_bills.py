"""Feature 1: run every synthetic bill through bill-ingestion.pipe (extract_facts,
not extract_data - see rr_common.build_bill_ingestion_pipeline's docstring),
validate the extracted fields (the "Schema Validate" step - plain Python,
since no pipeline node does generic numeric plausibility checks; see project
notes), and write Bill rows to RocketRide SQL via the foundation-sql pipeline.

Three outcomes per bill, printed in the summary:
  - OK            : all checks passed, written with needs_review = false
  - NEEDS_REVIEW  : meter resolved, written with needs_review = true + reasons
  - REJECTED      : meter_number missing/unknown - no valid FK target, so no
                    Bill row can be written at all (correct relational
                    behavior, not a bug) - reported for human follow-up
"""
import asyncio
import glob
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))

from rocketride import RocketRideClient
from rr_common import BILL_INGESTION_PROJECT_ID, BILL_INGESTION_SOURCE, ensure_foundation_sql_token

BILLS_DIR = os.path.join(os.path.dirname(__file__), "synthetic_bills")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def to_number(value):
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def validate_bill(fields, validation):
    """Plain-Python "Schema Validate": returns (needs_review: bool, reasons: list[str]).

    `validation` is extract_facts' own `_validation` block (changed/reason),
    surfaced here rather than silently trusted - if the extractor needed to
    reconcile a first-pass value against the source text at all, that's worth
    a human glance regardless of which way it went.
    """
    reasons = []

    if validation.get("changed"):
        reasons.append(f"extractor self-corrected a value on reconciliation: {validation.get('reason') or 'no reason given'}")

    anomaly_text = str(fields.get("anomaly_flags") or "").strip()
    if anomaly_text:
        reasons.append(f"extractor-reported anomaly: {anomaly_text}")

    recorded_md = to_number(fields.get("recorded_md"))
    if recorded_md is None:
        reasons.append("recorded_md missing or unparseable")
    elif recorded_md < 0:
        reasons.append(f"recorded_md is negative ({recorded_md})")

    recorded_pf = to_number(fields.get("recorded_pf"))
    if recorded_pf is None:
        reasons.append("recorded_pf missing or unparseable")
    elif not (0 <= recorded_pf <= 1.0):
        reasons.append(f"recorded_pf out of [0,1] range ({recorded_pf})")

    period_start = fields.get("period_start") or ""
    period_end = fields.get("period_end") or ""
    if not DATE_RE.match(str(period_start)):
        reasons.append(f"period_start missing or not ISO date ({period_start!r})")
    if not DATE_RE.match(str(period_end)):
        reasons.append(f"period_end missing or not ISO date ({period_end!r})")
    if DATE_RE.match(str(period_start)) and DATE_RE.match(str(period_end)) and period_end < period_start:
        reasons.append(f"billing period reversed (end {period_end} before start {period_start})")

    total_due = to_number(fields.get("total_due"))
    if total_due is None:
        reasons.append("total_due missing or unparseable")
    elif total_due < 0:
        reasons.append(f"total_due is negative ({total_due})")

    if not fields.get("line_items"):
        reasons.append("line_items missing or empty")

    return (len(reasons) > 0, reasons)


def extract_fields(send_result_entry):
    """Pull the extract_facts answer dict out of one send_files() result entry.

    Returns (fields, validation, error). `validation` is the popped
    `_validation` block (changed/reason); `_provenance` is also popped from
    fields (rich per-fact lineage - page/table/row/col/source_text/confidence
    - not persisted by Feature 1, useful for Feature 5's lineage tracing).
    """
    if send_result_entry.get("action") != "complete":
        return None, {}, send_result_entry.get("error")
    result = send_result_entry.get("result") or {}
    if "error" in result:
        return None, {}, result["error"]
    answers = result.get("answers")
    try:
        raw = answers[0][0]
    except (TypeError, IndexError, KeyError):
        raw = None
    if not raw:
        return {}, {}, None
    fields = dict(raw)
    validation = fields.pop("_validation", None) or {}
    fields.pop("_provenance", None)
    return fields, validation, None


async def main():
    client = RocketRideClient(persist=True)
    await client.connect()
    try:
        sql_token = await ensure_foundation_sql_token(client)
        print("foundation-sql task token:", sql_token)

        from rr_common import build_bill_ingestion_pipeline

        try:
            existing = await client.get_task_token(project_id=BILL_INGESTION_PROJECT_ID, source=BILL_INGESTION_SOURCE)
        except RuntimeError:
            existing = None
        if existing:
            await client.terminate(existing)
        pipeline = build_bill_ingestion_pipeline()
        use_result = await client.use(pipeline=pipeline, source="dropper_1", ttl=1800, name="bill-ingestion")
        bill_token = use_result["token"]
        print("bill-ingestion pipeline started:", bill_token)

        paths = sorted(glob.glob(os.path.join(BILLS_DIR, "*")))
        # NOTE: sent one-at-a-time with a delay, not as one parallel batch, to
        # stay under the free-tier Gemini quota (15 req/min; extract_facts'
        # validate=true pass roughly doubles LLM calls per document versus
        # extract_data, so a full parallel send_files() of 18 bills hit
        # 429 RESOURCE_EXHAUSTED on most of them). Feature 6's "drop a whole
        # folder in, process in parallel" requirement still holds once on
        # paid-tier quota / a self-hosted LLM - this throttle is a free-tier
        # testing accommodation, not a pipeline design change.
        print(f"Sending {len(paths)} bills one at a time (free-tier rate limit)...")
        entries = []
        for path in paths:
            for attempt in range(4):
                result = await client.send_files([path], bill_token)
                entry = result[0]
                err_msg = str((entry.get("result") or {}).get("error", ""))
                if "RESOURCE_EXHAUSTED" in err_msg or "429" in err_msg:
                    wait = 15 * (attempt + 1)
                    print(f"  rate-limited on {os.path.basename(path)}, retrying in {wait}s...")
                    await asyncio.sleep(wait)
                    continue
                break
            entries.append(entry)
            await asyncio.sleep(5)

        summary = []
        for path, entry in zip(paths, entries):
            name = os.path.basename(path)
            fields, validation, err = extract_fields(entry)

            if err is not None:
                summary.append((name, "ERROR", [f"pipeline error: {err}"], None))
                continue

            meter_number = (fields or {}).get("meter_number") or ""
            meter_row = None
            if meter_number:
                r = await client.database.query(
                    token=sql_token,
                    sql="SELECT meter_id FROM meter WHERE meter_id = $1",
                    params=[meter_number],
                )
                if r["rows"]:
                    meter_row = r["rows"][0]["meter_id"]

            needs_review, reasons = validate_bill(fields or {}, validation)

            if not meter_number:
                reasons = ["meter_number missing or unreadable"] + reasons
                summary.append((name, "REJECTED", reasons, None))
                continue
            if not meter_row:
                reasons = [f"unknown meter_number '{meter_number}' (no matching Meter record)"] + reasons
                summary.append((name, "REJECTED", reasons, None))
                continue

            # Deterministic, not uuid.uuid4() - re-running this script against
            # the same synthetic fixture must UPDATE that bill's one row, not
            # accumulate a fresh duplicate every run (a random id let exactly
            # that happen across earlier Feature 1/2 sessions; cleaned up in
            # Feature 3's build - see docs/CLAUDE.md Backlog).
            bill_id = f"bill-{os.path.splitext(name)[0]}"
            import json as _json

            await client.database.query(
                token=sql_token,
                sql=(
                    "INSERT INTO bill (bill_id, meter_id, period_start, period_end, "
                    "recorded_md, recorded_pf, line_items, total_due, source_doc_ref, needs_review) "
                    "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) "
                    "ON CONFLICT (bill_id) DO UPDATE SET "
                    "meter_id = EXCLUDED.meter_id, period_start = EXCLUDED.period_start, "
                    "period_end = EXCLUDED.period_end, recorded_md = EXCLUDED.recorded_md, "
                    "recorded_pf = EXCLUDED.recorded_pf, line_items = EXCLUDED.line_items, "
                    "total_due = EXCLUDED.total_due, needs_review = EXCLUDED.needs_review"
                ),
                params=[
                    bill_id,
                    meter_row,
                    fields.get("period_start") or None,
                    fields.get("period_end") or None,
                    to_number(fields.get("recorded_md")),
                    to_number(fields.get("recorded_pf")),
                    _json.dumps(fields.get("line_items") or []),
                    to_number(fields.get("total_due")),
                    name,
                    needs_review,
                ],
            )
            status = "NEEDS_REVIEW" if needs_review else "OK"
            summary.append((name, status, reasons, bill_id))

        print("\n--- Ingestion summary ---")
        for name, status, reasons, bill_id in summary:
            line = f"{status:12} {name:32} {'bill_id=' + bill_id if bill_id else ''}"
            print(line)
            for reason in reasons:
                print(f"             - {reason}")

        counts = {}
        for _, status, _, _ in summary:
            counts[status] = counts.get(status, 0) + 1
        print("\nCounts:", counts)

        r = await client.database.query(token=sql_token, sql="SELECT count(*) AS n FROM bill")
        print("bill table row count:", r["rows"][0]["n"])
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
