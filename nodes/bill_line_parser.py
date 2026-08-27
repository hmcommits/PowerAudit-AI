"""Feature #2 Step 1"""

import json
import sys
import re

# Canonical output keys
# Every downstream node expects exactly these keys.
CANONICAL_KEYS = [
    "meter_number",
    "tariff_category",
    "discom_id",
    "contract_demand_kva",       # CD agreed with DISCOM
    "recorded_max_demand_kva",   # Actual peak MD recorded
    "power_factor",              # Actual avg PF (0.0 – 1.0)
    "units_consumed_kwh",
    "energy_charges",            # Energy charge line item (₹)
    "md_penalty_billed",         # MD penalty as printed on bill (₹)
    "pf_penalty_billed",         # PF penalty as printed on bill (₹)
    "fixed_charges",
    "taxes_and_duties",
    "total_due",
    "billing_month",
    "site_id",
    "bill_id",
]

# DISCOM alias maps
# Maps every variant spelling → canonical key.
FIELD_ALIAS_MAP = {
    # Contract Demand variants
    "contract_demand_kva":        "contract_demand_kva",
    "contract demand":            "contract_demand_kva",
    "contracted demand":          "contract_demand_kva",
    "cd":                         "contract_demand_kva",
    "sanctioned demand":          "contract_demand_kva",
    "contracted kva":             "contract_demand_kva",

    # Maximum Demand variants
    "recorded_max_demand_kva":    "recorded_max_demand_kva",
    "recorded maximum demand":    "recorded_max_demand_kva",
    "max demand":                 "recorded_max_demand_kva",
    "maximum demand":             "recorded_max_demand_kva",
    "billing demand":             "recorded_max_demand_kva",
    "rmd":                        "recorded_max_demand_kva",
    "md":                         "recorded_max_demand_kva",

    # Power Factor variants
    "power_factor":               "power_factor",
    "power factor":               "power_factor",
    "avg power factor":           "power_factor",
    "average power factor":       "power_factor",
    "pf":                         "power_factor",

    # Energy charge variants
    "energy_charges":             "energy_charges",
    "energy charges":             "energy_charges",
    "consumption charges":        "energy_charges",
    "unit charges":               "energy_charges",
    "kwh charges":                "energy_charges",

    # MD penalty variants
    "md_penalty_billed":          "md_penalty_billed",
    "md penalty":                 "md_penalty_billed",
    "maximum demand penalty":     "md_penalty_billed",
    "excess demand charges":      "md_penalty_billed",
    "demand charges penalty":     "md_penalty_billed",
    "max demand penalty":         "md_penalty_billed",

    # PF penalty variants
    "pf_penalty_billed":          "pf_penalty_billed",
    "pf penalty":                 "pf_penalty_billed",
    "power factor penalty":       "pf_penalty_billed",
    "low pf surcharge":           "pf_penalty_billed",
    "power factor surcharge":     "pf_penalty_billed",
    "pf surcharge":               "pf_penalty_billed",

    # Fixed charges
    "fixed_charges":              "fixed_charges",
    "fixed charges":              "fixed_charges",
    "demand charges":             "fixed_charges",
    "customer charges":           "fixed_charges",

    # Taxes
    "taxes_and_duties":           "taxes_and_duties",
    "taxes and duties":           "taxes_and_duties",
    "electricity duty":           "taxes_and_duties",
    "wheeling charges":           "taxes_and_duties",
    "regulatory charges":         "taxes_and_duties",

    # Other pass-through
    "units_consumed_kwh":         "units_consumed_kwh",
    "units consumed":             "units_consumed_kwh",
    "kwh consumed":               "units_consumed_kwh",
    "total_due":                  "total_due",
    "total due":                  "total_due",
    "net amount":                 "total_due",
    "amount payable":             "total_due",
}


def _normalize_key(raw_key: str) -> str:
    """Lower-case + strip + collapse whitespace → lookup alias."""
    normalized = re.sub(r"\s+", " ", raw_key.strip().lower())
    return FIELD_ALIAS_MAP.get(normalized, normalized)


def _coerce_numeric(value) -> float | None:
    """Convert string like '₹1,234.56' or '1234.56 kVA' → float."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    # Strip currency symbols, commas, unit suffixes
    cleaned = re.sub(r"[₹,\s]", "", str(value))
    cleaned = re.sub(r"(kva|kw|kwh|%|rs\.?)", "", cleaned, flags=re.IGNORECASE)
    try:
        return float(cleaned)
    except ValueError:
        return None


def parse_bill(raw_bill: dict) -> dict:
    """
    Normalise a raw bill dict into canonical line_items.

    Args:
        raw_bill: dict from the bills table (or direct extraction output).

    Returns:
        dict with all CANONICAL_KEYS present (None if missing).
    """
    line_items: dict = {}

    for raw_key, raw_value in raw_bill.items():
        canonical = _normalize_key(raw_key)
        line_items[canonical] = raw_value

    # Coerce all numeric penalty/demand fields
    numeric_fields = [
        "contract_demand_kva",
        "recorded_max_demand_kva",
        "power_factor",
        "units_consumed_kwh",
        "energy_charges",
        "md_penalty_billed",
        "pf_penalty_billed",
        "fixed_charges",
        "taxes_and_duties",
        "total_due",
    ]
    for field in numeric_fields:
        line_items[field] = _coerce_numeric(line_items.get(field))

    # Power factor: if given as percentage (e.g. 86 meaning 0.86), normalise
    pf = line_items.get("power_factor")
    if pf is not None and pf > 1.0:
        line_items["power_factor"] = round(pf / 100.0, 4)

    # Ensure all canonical keys are present
    for key in CANONICAL_KEYS:
        line_items.setdefault(key, None)

    # Pass-through identity fields that don't need aliasing
    for pass_key in ("bill_id", "site_id", "month", "discom_id", "meter_number",
                     "tariff_category", "billing_period_start", "billing_period_end"):
        if pass_key in raw_bill and pass_key not in line_items:
            line_items[pass_key] = raw_bill[pass_key]

    # billing_month from month if not set
    line_items.setdefault("billing_month", raw_bill.get("month"))

    return line_items


def main():
    raw_input = sys.stdin.read().strip()
    try:
        raw_bill = json.loads(raw_input)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON input: {e}"}))
        sys.exit(1)

    line_items = parse_bill(raw_bill)
    print(json.dumps(line_items, default=str))


if __name__ == "__main__":
    main()
