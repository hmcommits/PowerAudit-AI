"""Feature #2 Step 3"""

import json
import sys
from typing import Optional

# Tolerance: amounts within ₹1 are considered a MATCH
# (handles floating-point rounding in DISCOM billing systems)
MATCH_TOLERANCE_INR = 1.0


def _flag(billed: Optional[float], recalculated: Optional[float]) -> tuple[str, float]:
    """
    Returns (variance_flag, rupee_impact).
    rupee_impact > 0 means overcharged; < 0 means undercharged.
    """
    if billed is None or recalculated is None:
        return "INCONCLUSIVE", 0.0

    diff = round(billed - recalculated, 2)

    if abs(diff) <= MATCH_TOLERANCE_INR:
        return "MATCH", diff
    elif diff > 0:
        return "OVERCHARGED", diff
    else:
        return "UNDERCHARGED", diff


def detect_variances(line_items: dict, calculation: dict) -> list[dict]:
    """
    Compare billed values against recalculated values.
    Returns a list of variance dicts, one per finding type checked.
    """
    variances = []
    bill_id   = line_items.get("bill_id", "UNKNOWN")
    site_id   = line_items.get("site_id", "UNKNOWN")
    month     = line_items.get("billing_month", line_items.get("month", "UNKNOWN"))
    discom_id = calculation.get("discom_id", "UNKNOWN")

    # 1. MD Penalty Variance
    md_billed        = line_items.get("md_penalty_billed")
    md_recalculated  = calculation.get("recalculated_md_penalty")
    md_status        = calculation.get("md_status", "MISSING_DATA")

    if md_status == "MISSING_DATA":
        md_flag, md_impact = "INCONCLUSIVE", 0.0
    else:
        md_flag, md_impact = _flag(md_billed, md_recalculated)

    variances.append({
        "finding_type":         "MD_PENALTY",
        "bill_id":              bill_id,
        "site_id":              site_id,
        "month":                month,
        "discom_id":            discom_id,
        "variance_flag":        md_flag,
        "billed_amount":        md_billed,
        "recalculated_amount":  md_recalculated,
        "rupee_impact":         md_impact,
        "formula_used":         calculation.get("md_formula_used"),
        "formula_inputs":       calculation.get("md_inputs"),
        "clause_ref":           calculation.get("md_clause_ref"),
        "md_status":            md_status,
    })

    # 2. PF Penalty Variance
    pf_billed        = line_items.get("pf_penalty_billed")
    pf_recalculated  = calculation.get("recalculated_pf_penalty")
    pf_status        = calculation.get("pf_status", "MISSING_DATA")

    if pf_status == "MISSING_DATA":
        pf_flag, pf_impact = "INCONCLUSIVE", 0.0
    elif pf_status == "INCENTIVE":
        # DISCOM should have applied a rebate; if they didn't, that's an overcharge
        incentive = calculation.get("pf_incentive", 0.0)
        pf_billed_adj = pf_billed if pf_billed else 0.0
        pf_flag   = "OVERCHARGED" if pf_billed_adj > 0 else "MATCH"
        pf_impact = round(pf_billed_adj + (incentive or 0.0), 2)  # total missed benefit
        pf_recalculated = -(incentive or 0.0)  # negative = expected credit
    else:
        pf_flag, pf_impact = _flag(pf_billed, pf_recalculated)

    variances.append({
        "finding_type":         "PF_PENALTY",
        "bill_id":              bill_id,
        "site_id":              site_id,
        "month":                month,
        "discom_id":            discom_id,
        "variance_flag":        pf_flag,
        "billed_amount":        pf_billed,
        "recalculated_amount":  pf_recalculated,
        "rupee_impact":         pf_impact,
        "formula_used":         calculation.get("pf_formula_used"),
        "formula_inputs":       calculation.get("pf_inputs"),
        "clause_ref":           calculation.get("pf_clause_ref"),
        "pf_status":            pf_status,
    })

    # 3. Total Bill Sanity Check
    # If billed total ≠ sum of all line items, flag tariff_mismatch
    total_due       = line_items.get("total_due")
    energy_charges  = line_items.get("energy_charges") or 0.0
    fixed_charges   = line_items.get("fixed_charges") or 0.0
    taxes           = line_items.get("taxes_and_duties") or 0.0
    md_billed_amt   = md_billed or 0.0
    pf_billed_amt   = pf_billed or 0.0

    expected_total  = round(energy_charges + fixed_charges + taxes + md_billed_amt + pf_billed_amt, 2)

    if total_due is not None and expected_total > 0:
        sanity_flag, sanity_impact = _flag(total_due, expected_total)
        # Only add if it's not a MATCH (avoid noise)
        if sanity_flag != "MATCH":
            variances.append({
                "finding_type":        "TARIFF_MISMATCH",
                "bill_id":             bill_id,
                "site_id":             site_id,
                "month":               month,
                "discom_id":           discom_id,
                "variance_flag":       sanity_flag,
                "billed_amount":       total_due,
                "recalculated_amount": expected_total,
                "rupee_impact":        sanity_impact,
                "formula_used":        f"SUM(energy+fixed+taxes+md+pf) = ₹{expected_total}",
                "formula_inputs": {
                    "energy_charges": energy_charges,
                    "fixed_charges":  fixed_charges,
                    "taxes":          taxes,
                    "md_billed":      md_billed_amt,
                    "pf_billed":      pf_billed_amt,
                },
                "clause_ref": "Internal sanity check — sum of line items vs total due",
            })

    return variances


def main():
    raw_input = sys.stdin.read().strip()
    try:
        payload = json.loads(raw_input)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON: {e}"}))
        sys.exit(1)

    line_items  = payload.get("line_items", {})
    calculation = payload.get("calculation", {})

    variances = detect_variances(line_items, calculation)
    print(json.dumps({"variances": variances, "count": len(variances)}, default=str))


if __name__ == "__main__":
    main()
