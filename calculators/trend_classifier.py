"""Feature 3, step 2: trend-classifier (Python, deterministic, zero LLM).

Explainable-by-design: a single ordinary-least-squares linear fit over the
recent history, plus a fixed set of named thresholds. No ML libraries, no
black-box model - every number in a classification result is either an
input or derivable by hand from the formulas below.

THE LOGIC, IN FULL:

1. Take the most recent LOOKBACK_PERIODS points from history_aggregator's
   output (default: last 6 bills). Need at least MIN_POINTS (default: 3) -
   below that, there isn't enough signal to fit a trend, so classification
   returns {"status": "insufficient_data"}.

2. Fit y = slope * x + intercept by ordinary least squares, where x is
   `month_index` and y is `recorded_md` (for CD-breach checks) or
   `recorded_pf` (for PF-decline checks):
       slope = sum((x_i - x_mean)(y_i - y_mean)) / sum((x_i - x_mean)^2)
       intercept = y_mean - slope * x_mean
   (If every x_i is identical - all bills on the same month_index, which
   shouldn't happen with real monthly billing - the denominator is 0 and we
   report "insufficient_data" rather than divide by zero.)

3. Project the fitted line forward by WARNING_HORIZON_MONTHS (default: 2)
   past the latest data point:
       projected = slope * (latest_month_index + WARNING_HORIZON_MONTHS) + intercept

4. CD-breach risk: only meaningful if the meter hasn't ALREADY breached
   (latest recorded_md < contract_demand_kva - an actual breach is Feature
   2's job, via a Finding, not a predictive Alert) and the trend is rising
   (slope > 0). If projected >= contract_demand_kva, classify
   "cd-breach-risk", and report months_to_breach = the linear estimate of
   when the fitted line actually crosses contract_demand_kva:
       months_to_breach = (contract_demand_kva - latest_recorded_md) / slope
   (this can be less than WARNING_HORIZON_MONTHS - the horizon just decides
   whether to fire the alert at all, not the reported ETA).

5. PF-decline risk is the mirror image: slope < 0, latest recorded_pf above
   pf_threshold, projected <= pf_threshold.

6. Every other combination (flat/declining MD, flat/rising PF, or already
   past the line) is reported with its own status string so a caller can
   distinguish "checked, nothing to see" from "didn't run".
"""

MIN_POINTS = 3
LOOKBACK_PERIODS = 6
WARNING_HORIZON_MONTHS = 2


def _linear_regression(xs, ys):
    n = len(xs)
    x_mean = sum(xs) / n
    y_mean = sum(ys) / n
    denominator = sum((x - x_mean) ** 2 for x in xs)
    if denominator == 0:
        return None
    numerator = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, ys))
    slope = numerator / denominator
    intercept = y_mean - slope * x_mean
    return slope, intercept


def classify_cd_trend(history, contract_demand_kva, warning_horizon_months=WARNING_HORIZON_MONTHS, min_points=MIN_POINTS, lookback=LOOKBACK_PERIODS):
    """history: history_aggregator.build_history() output. See module
    docstring for the full method. Returns a dict always containing
    "status"; "cd-breach-risk" results additionally carry slope,
    months_to_breach, and projected_md_at_horizon."""
    points = history[-lookback:]
    if len(points) < min_points:
        return {"status": "insufficient_data"}

    xs = [p["month_index"] for p in points]
    ys = [p["recorded_md"] for p in points]
    fit = _linear_regression(xs, ys)
    if fit is None:
        return {"status": "insufficient_data"}
    slope, intercept = fit

    latest_x, latest_y = xs[-1], ys[-1]
    if latest_y >= contract_demand_kva:
        return {"status": "already_breached", "slope_kva_per_month": round(slope, 4)}
    if slope <= 0:
        return {"status": "flat_or_declining", "slope_kva_per_month": round(slope, 4)}

    projected = slope * (latest_x + warning_horizon_months) + intercept
    months_to_breach = (contract_demand_kva - latest_y) / slope

    if projected >= contract_demand_kva:
        return {
            "status": "cd-breach-risk",
            "slope_kva_per_month": round(slope, 4),
            "latest_recorded_md": latest_y,
            "contract_demand_kva": contract_demand_kva,
            "months_to_breach": round(months_to_breach, 2),
            "projected_md_at_horizon": round(projected, 2),
            "warning_horizon_months": warning_horizon_months,
        }
    return {
        "status": "on_track",
        "slope_kva_per_month": round(slope, 4),
        "months_to_breach": round(months_to_breach, 2),
    }


def classify_pf_trend(history, pf_threshold, warning_horizon_months=WARNING_HORIZON_MONTHS, min_points=MIN_POINTS, lookback=LOOKBACK_PERIODS):
    """Mirror image of classify_cd_trend: PF trending DOWN toward
    pf_threshold instead of MD trending UP toward contract_demand_kva."""
    points = history[-lookback:]
    if len(points) < min_points:
        return {"status": "insufficient_data"}

    xs = [p["month_index"] for p in points]
    ys = [p["recorded_pf"] for p in points]
    fit = _linear_regression(xs, ys)
    if fit is None:
        return {"status": "insufficient_data"}
    slope, intercept = fit

    latest_x, latest_y = xs[-1], ys[-1]
    if latest_y <= pf_threshold:
        return {"status": "already_breached", "slope_per_month": round(slope, 4)}
    if slope >= 0:
        return {"status": "flat_or_improving", "slope_per_month": round(slope, 4)}

    projected = slope * (latest_x + warning_horizon_months) + intercept
    months_to_breach = (latest_y - pf_threshold) / (-slope)

    if projected <= pf_threshold:
        return {
            "status": "pf-decline-risk",
            "slope_per_month": round(slope, 4),
            "latest_recorded_pf": latest_y,
            "pf_threshold": pf_threshold,
            "months_to_breach": round(months_to_breach, 2),
            "projected_pf_at_horizon": round(projected, 4),
            "warning_horizon_months": warning_horizon_months,
        }
    return {
        "status": "on_track",
        "slope_per_month": round(slope, 4),
        "months_to_breach": round(months_to_breach, 2),
    }
