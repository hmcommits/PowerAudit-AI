"""Feature #2 Step 4"""

import json
import sys
from typing import Optional

# Materiality threshold
# Findings below this ₹ amount are real but too small to raise a dispute.
MATERIALITY_THRESHOLD_INR = 500.0

# Confidence weight components (must sum to 100)
W_DATA_COMPLETENESS   = 40  # Were all critical fields present?
W_OCR_CONFIDENCE      = 35  # Average OCR confidence from bill extraction
W_FORMULA_CERTAINTY   = 25  # Was formula applicable (no fallbacks/INCONCLUSIVE)?


def _score_data_completeness(line_items: dict) -> tuple[float, list[str]]:
    """
    Score 0–100 based on presence of critical fields.
    Deduct points for null/zero critical fields.
    """
    critical_fields = {
        "contract_demand_kva":      20,   # highest weight
        "recorded_max_demand_kva":  20,
        "power_factor":             15,
        "energy_charges":           15,
        "md_penalty_billed":        10,
        "pf_penalty_billed":        10,
        "total_due":                10,
    }
    score = 0.0
    missing = []

    for field, weight in critical_fields.items():
        val = line_items.get(field)
        if val is not None and val != 0:
            score += weight
        else:
            missing.append(field)

    return round(score, 2), missing


def _score_ocr_confidence(line_items: dict) -> float:
    """
    Extract OCR confidence from confidence_map if present,
    else default to 75 (reasonable assumption for clean PDF).
    """
    confidence_map: Optional[dict] = line_items.get("confidence_map")
    if not confidence_map:
        return 75.0

    critical_fields = [
        "contract_demand_kva",
        "recorded_max_demand_kva",
        "power_factor",
        "energy_charges",
        "md_penalty_billed",
        "pf_penalty_billed",
    ]

    scores = [
        confidence_map.get(f, 75.0)
        for f in critical_fields
        if f in confidence_map
    ]

    if not scores:
        return 75.0

    # confidence_map values expected as 0–1; convert to 0–100
    avg = sum(scores) / len(scores)
    if avg <= 1.0:
        avg *= 100
    return round(avg, 2)


def _score_formula_certainty(variances: list[dict], calculation: dict) -> tuple[float, list[str]]:
    """
    Score 0–100 based on whether formulas ran cleanly.
    """
    score    = 100.0
    warnings = []

    # Deduct for calculator errors
    calc_errors = calculation.get("errors", [])
    if calc_errors:
        score -= 20 * len(calc_errors)
        warnings.extend(calc_errors)

    # Deduct for each INCONCLUSIVE variance
    inconclusives = [v for v in variances if v.get("variance_flag") == "INCONCLUSIVE"]
    if inconclusives:
        score -= 15 * len(inconclusives)
        warnings.append(f"{len(inconclusives)} variance(s) are INCONCLUSIVE due to missing data.")

    # Deduct for DISCOM fallback
    if any("falling back to MSEDCL" in e for e in calc_errors):
        score -= 15
        warnings.append("DISCOM not found; formula used MSEDCL as fallback.")

    return round(max(score, 0.0), 2), warnings


def compute_impact_score(
    variances: list[dict],
    line_items: dict,
    calculation: dict,
) -> dict:
    """
    Aggregate all variances into a single impact + confidence summary.
    """
    # Rupee impact
    overcharge_total   = 0.0
    undercharge_total  = 0.0
    breakdown          = []

    for v in variances:
        flag   = v.get("variance_flag", "INCONCLUSIVE")
        impact = v.get("rupee_impact", 0.0) or 0.0
        ftype  = v.get("finding_type", "UNKNOWN")

        breakdown.append({
            "finding_type":   ftype,
            "variance_flag":  flag,
            "rupee_impact":   impact,
            "billed":         v.get("billed_amount"),
            "recalculated":   v.get("recalculated_amount"),
        })

        if flag == "OVERCHARGED":
            overcharge_total += impact
        elif flag == "UNDERCHARGED":
            undercharge_total += abs(impact)

    total_rupee_impact = round(overcharge_total, 2)

    # Confidence score
    data_score, missing_fields   = _score_data_completeness(line_items)
    ocr_score                    = _score_ocr_confidence(line_items)
    formula_score, formula_warns = _score_formula_certainty(variances, calculation)

    composite_score = round(
        (data_score   * W_DATA_COMPLETENESS  / 100) +
        (ocr_score    * W_OCR_CONFIDENCE     / 100) +
        (formula_score * W_FORMULA_CERTAINTY  / 100),
        2,
    )

    # Materiality
    materiality_flag = total_rupee_impact >= MATERIALITY_THRESHOLD_INR

    return {
        "total_rupee_impact":     total_rupee_impact,
        "overcharge_total":       overcharge_total,
        "undercharge_total":      round(undercharge_total, 2),
        "confidence_score":       composite_score,
        "confidence_breakdown": {
            "data_completeness":  data_score,
            "ocr_confidence":     ocr_score,
            "formula_certainty":  formula_score,
            "weights": {
                "data_completeness": W_DATA_COMPLETENESS,
                "ocr_confidence":    W_OCR_CONFIDENCE,
                "formula_certainty": W_FORMULA_CERTAINTY,
            },
        },
        "materiality_flag":       materiality_flag,
        "materiality_threshold":  MATERIALITY_THRESHOLD_INR,
        "missing_critical_fields": missing_fields,
        "formula_warnings":       formula_warns,
        "breakdown":              breakdown,
        "variance_count":         len(variances),
        "actionable_count":       sum(
            1 for v in variances
            if v.get("variance_flag") in ("OVERCHARGED", "UNDERCHARGED")
        ),
    }


def main():
    raw_input = sys.stdin.read().strip()
    try:
        payload = json.loads(raw_input)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON: {e}"}))
        sys.exit(1)

    variances   = payload.get("variances", [])
    line_items  = payload.get("line_items", {})
    calculation = payload.get("calculation", {})

    result = compute_impact_score(variances, line_items, calculation)
    print(json.dumps(result, default=str))


if __name__ == "__main__":
    main()
