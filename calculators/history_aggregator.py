"""Feature 3, step 1: history-aggregator (Python, deterministic, zero LLM).

Turns a meter's raw Bill rows (already fetched from RocketRide SQL by the
caller - see scripts/scan_trend_alerts.py) into a clean, chronologically
ordered time series that trend_classifier.py can fit a trend to.

Stdlib-only - see bill_line_parser.py's docstring for why.
"""
from datetime import date


def _parse_date(value):
    if isinstance(value, date):
        return value
    year, month, day = str(value).split("-")
    return date(int(year), int(month), int(day))


def build_history(bill_rows):
    """bill_rows: list of {"period_start": "YYYY-MM-DD"|date, "recorded_md": float|None,
    "recorded_pf": float|None, ...}. Rows missing period_start, recorded_md,
    or recorded_pf are dropped (can't place them on the trend line) - callers
    that need to know about excluded rows should check len(input) vs.
    len(output) themselves.

    Returns a list sorted by period_start, each entry:
        {"period_start": date, "month_index": int, "recorded_md": float, "recorded_pf": float}
    `month_index` is the number of calendar months elapsed since the
    EARLIEST bill in this list (0-based) - using calendar months rather
    than a raw row count means a skipped billing cycle doesn't silently
    compress the time axis.
    """
    usable = []
    for row in bill_rows:
        if row.get("period_start") is None or row.get("recorded_md") is None or row.get("recorded_pf") is None:
            continue
        usable.append(
            {
                "period_start": _parse_date(row["period_start"]),
                "recorded_md": float(row["recorded_md"]),
                "recorded_pf": float(row["recorded_pf"]),
            }
        )
    usable.sort(key=lambda r: r["period_start"])
    if not usable:
        return []

    first = usable[0]["period_start"]
    for entry in usable:
        d = entry["period_start"]
        entry["month_index"] = (d.year - first.year) * 12 + (d.month - first.month)
    return usable
