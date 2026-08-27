"""Feature 3, step 5: what-if mode (Python, deterministic, zero LLM).

Same trend-projection math as trend_classifier.py (reuses its internal
linear fit), but instead of comparing the projection against the CURRENT
contract_demand_kva to decide whether to raise an Alert, it compares the
projected penalty cost under the current CD against a HYPOTHETICAL one -
"what would raising Contract Demand by X kVA have saved us?" - and returns
the comparison directly. Writes nothing (no Alert record - see
scripts/what_if_scenario.py).

Reuses tariff_penalty_calculator.calculate_md_penalty rather than
reimplementing the penalty formula - same Section 2 formula, same
caller-supplied parameters (never hardcoded rates), consistent with
Feature 2's calculators.
"""
from calculators.tariff_penalty_calculator import calculate_md_penalty
from calculators.trend_classifier import LOOKBACK_PERIODS, WARNING_HORIZON_MONTHS, _linear_regression


def what_if_cd_change(history, current_cd, hypothetical_cd, tariff_params, warning_horizon_months=WARNING_HORIZON_MONTHS, lookback=LOOKBACK_PERIODS):
    """Projects recorded_md forward the same way classify_cd_trend does,
    then compares the MD penalty that projection would incur under
    `current_cd` vs. `hypothetical_cd`.

    tariff_params: {"demand_charge_rate": ..., "penalty_multiplier": ...} -
    same shape as tariff_penalty_calculator.calculate_md_penalty's kwargs.

    Returns {"status": "insufficient_data"} if there's not enough history,
    otherwise the full comparison dict.
    """
    points = history[-lookback:]
    if len(points) < 3:
        return {"status": "insufficient_data"}

    xs = [p["month_index"] for p in points]
    ys = [p["recorded_md"] for p in points]
    fit = _linear_regression(xs, ys)
    if fit is None:
        return {"status": "insufficient_data"}
    slope, intercept = fit

    projected_md = slope * (xs[-1] + warning_horizon_months) + intercept
    projected_md = max(projected_md, 0.0)  # a declining trend shouldn't project a negative demand

    current = calculate_md_penalty(
        projected_md, current_cd,
        tariff_params["demand_charge_rate"], tariff_params["penalty_multiplier"],
    )
    hypothetical = calculate_md_penalty(
        projected_md, hypothetical_cd,
        tariff_params["demand_charge_rate"], tariff_params["penalty_multiplier"],
    )
    savings = round(current["penalty"] - hypothetical["penalty"], 2)

    return {
        "status": "ok",
        "projected_md_at_horizon": round(projected_md, 2),
        "warning_horizon_months": warning_horizon_months,
        "current_cd": current_cd,
        "hypothetical_cd": hypothetical_cd,
        "current_projected_penalty": current["penalty"],
        "hypothetical_projected_penalty": hypothetical["penalty"],
        "projected_savings": savings,
    }
