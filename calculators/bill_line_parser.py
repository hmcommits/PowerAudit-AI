"""Feature 2, step 1: bill-line-parser (Python, deterministic, zero LLM).

Normalizes a Bill's raw `line_items` (as extracted by bill-ingestion.pipe -
free-text descriptions with currency-formatted amount strings) into a clean,
typed, categorized list so downstream deterministic steps (the penalty
calculator, variance-detector, dollar-impact-scorer) can compare billed vs.
recalculated amounts by category rather than by fuzzy string matching.

Stdlib-only (re) - keeps this transplantable into a RocketRide `tool_python`
sandboxed execution environment later (Section 5: "Deterministic calculation:
Python, inside RocketRide Python tool nodes"), which only allows whitelisted
modules.
"""
import re

AMOUNT_RE = re.compile(r"[-+]?[\d,]+(?:\.\d+)?")

# Ordered so more specific keywords are checked before generic ones
# (e.g. "MD Penalty" before a bare "Demand Charge" match).
CATEGORY_KEYWORDS = [
    ("md_penalty", ("md penalty", "maximum demand penalty", "excess demand")),
    ("pf_surcharge", ("pf surcharge", "power factor surcharge", "low pf")),
    ("pf_incentive", ("pf incentive", "power factor incentive", "pf rebate")),
    ("demand_charge", ("demand charge",)),
    ("energy_charge", ("energy charge", "energy cost")),
    ("fuel_adjustment_charge", ("fac", "fuel adjustment")),
    ("wheeling_charge", ("wheeling",)),
    ("electricity_duty", ("electricity duty", "duty")),
    ("tax", ("tax", "gst", "cess")),
]


def parse_amount(raw):
    """Parse a currency-formatted amount string into a float.

    Handles "Rs. 412500", "Rs. 8,200.50", parenthesized negatives
    ("(1,200.00)" -> accounting convention for a credit/negative line),
    and a leading -/+ sign. Returns None if nothing numeric is found.
    """
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    text = str(raw).strip()
    if not text:
        return None

    negative = False
    if text.startswith("(") and text.endswith(")"):
        negative = True
        text = text[1:-1]

    match = AMOUNT_RE.search(text)
    if not match:
        return None

    value_str = match.group(0).replace(",", "")
    try:
        value = float(value_str)
    except ValueError:
        return None

    return -value if negative else value


def classify_line_item(description):
    """Map a free-text line item description to a fixed category key.

    Returns "other" when nothing matches - callers should treat "other"
    line items as present-but-uncategorized, not as an error.
    """
    if not description:
        return "other"
    text = str(description).strip().lower()
    for category, keywords in CATEGORY_KEYWORDS:
        if any(kw in text for kw in keywords):
            return category
    return "other"


def normalize_line_items(line_items):
    """Normalize a Bill's raw line_items (dict of {description: amount_str}
    or a list of [description, amount] / {"description":..., "amount":...}
    pairs) into a list of:
        {"description": str, "raw_amount": original value, "amount": float|None, "category": str}

    Malformed entries (unparseable amount) are kept with amount=None rather
    than dropped or silently coerced to 0 - downstream steps decide how to
    treat that (flag, exclude from totals, etc.).
    """
    pairs = []
    if isinstance(line_items, dict):
        pairs = list(line_items.items())
    elif isinstance(line_items, list):
        for entry in line_items:
            if isinstance(entry, dict):
                desc = entry.get("description") or entry.get("name") or ""
                amt = entry.get("amount")
                pairs.append((desc, amt))
            elif isinstance(entry, (list, tuple)) and len(entry) == 2:
                pairs.append((entry[0], entry[1]))
    else:
        return []

    normalized = []
    for description, raw_amount in pairs:
        normalized.append(
            {
                "description": description,
                "raw_amount": raw_amount,
                "amount": parse_amount(raw_amount),
                "category": classify_line_item(description),
            }
        )
    return normalized


def sum_by_category(normalized_line_items):
    """Sum normalized line items into {category: total_amount}, skipping
    entries whose amount failed to parse."""
    totals = {}
    for item in normalized_line_items:
        if item["amount"] is None:
            continue
        totals[item["category"]] = totals.get(item["category"], 0.0) + item["amount"]
    return totals
