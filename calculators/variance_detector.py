"""Feature 2, step 4: variance-detector (Python, deterministic, zero LLM).

Compares a Bill's billed line items against the recalculated MD/PF penalty
figures (tariff_penalty_calculator.py) and the bill's own arithmetic, and
reports discrepancies as Findings (Section 3's Finding.type enum).

Stdlib-only - see bill_line_parser.py's docstring for why.
"""

TOLERANCE_RUPEES = 1.0  # amounts within this are treated as "matches", not variances


def detect_math_error(normalized_line_items, billed_total_due):
    """Section 3 Finding type 'math-error': do the billed line items actually
    sum to the bill's stated total_due? Skips items whose amount failed to
    parse (bill_line_parser already flags those separately via needs_review).
    """
    parsed = [item["amount"] for item in normalized_line_items if item["amount"] is not None]
    if not parsed or billed_total_due is None:
        return None
    line_item_sum = round(sum(parsed), 2)
    diff = round(billed_total_due - line_item_sum, 2)
    if abs(diff) <= TOLERANCE_RUPEES:
        return None
    return {
        "type": "math-error",
        "billed_amount": billed_total_due,
        "recalculated_amount": line_item_sum,
        "detail": f"line items sum to {line_item_sum}, bill states total_due {billed_total_due}",
    }


def detect_md_penalty_variance(normalized_line_items, recalculated_md):
    """Section 3 Finding type 'md-penalty': billed MD penalty line item(s)
    vs. the deterministically recalculated penalty for this bill."""
    billed = sum(item["amount"] for item in normalized_line_items if item["category"] == "md_penalty" and item["amount"] is not None)
    recalculated = recalculated_md["penalty"]
    if abs(billed - recalculated) <= TOLERANCE_RUPEES:
        return None
    return {
        "type": "md-penalty",
        "billed_amount": round(billed, 2),
        "recalculated_amount": recalculated,
        "detail": (
            f"billed MD penalty {round(billed, 2)} vs. recalculated {recalculated} "
            f"(excess {recalculated_md['excess_kva']} kVA)"
        ),
    }


def detect_pf_penalty_variance(normalized_line_items, recalculated_pf):
    """Section 3 Finding type 'pf-penalty': billed PF surcharge/incentive
    (net) vs. the deterministically recalculated PF adjustment.

    Sign convention: surcharges are a charge (positive on the bill),
    incentives are a credit (negative on the bill) - net them so "billed"
    and "recalculated_amount" are directly comparable regardless of which
    direction applied.
    """
    billed_surcharge = sum(item["amount"] for item in normalized_line_items if item["category"] == "pf_surcharge" and item["amount"] is not None)
    billed_incentive = sum(item["amount"] for item in normalized_line_items if item["category"] == "pf_incentive" and item["amount"] is not None)
    billed_net = billed_surcharge - abs(billed_incentive)

    if recalculated_pf["type"] == "surcharge":
        recalculated_net = recalculated_pf["amount"]
    elif recalculated_pf["type"] == "incentive":
        recalculated_net = -recalculated_pf["amount"]
    else:
        recalculated_net = 0.0

    if abs(billed_net - recalculated_net) <= TOLERANCE_RUPEES:
        return None
    return {
        "type": "pf-penalty",
        "billed_amount": round(billed_net, 2),
        "recalculated_amount": round(recalculated_net, 2),
        "detail": (
            f"billed PF adjustment (net) {round(billed_net, 2)} vs. recalculated "
            f"{round(recalculated_net, 2)} ({recalculated_pf['type']}, {recalculated_pf['points']} points)"
        ),
    }


def detect_variances(normalized_line_items, billed_total_due, recalculated_md, recalculated_pf):
    """Run all deterministic checks; returns a list of variance dicts
    (possibly empty). Each has type/billed_amount/recalculated_amount/detail -
    dollar_impact_scorer.py turns these into rupee_impact + confidence."""
    checks = [
        detect_math_error(normalized_line_items, billed_total_due),
        detect_md_penalty_variance(normalized_line_items, recalculated_md),
        detect_pf_penalty_variance(normalized_line_items, recalculated_pf),
    ]
    return [c for c in checks if c is not None]
