"""Feature 2, step 3: tariff-penalty-calculator (Python, deterministic, zero
LLM). Recomputes the MD and PF penalties per the build context's Section 2
formulas.

Every rate/threshold/multiplier is a PARAMETER, never a constant - Section 2
is explicit that these vary by DISCOM/state and must come from the loaded
tariff order (RocketRide Vector retrieval, Feature 6), not be hardcoded here.
This module only encodes the formula SHAPE; the numbers come from the caller.

Stdlib-only - keeps this transplantable into a RocketRide `tool_python`
sandboxed execution environment later (see bill_line_parser.py's docstring).
"""


def calculate_md_penalty(recorded_md_kva, contract_demand_kva, demand_charge_rate, penalty_multiplier):
    """MD Penalty = (Recorded MD - Contract Demand) x Demand Charge Rate x
    Penalty Multiplier, per Section 2. Zero when Recorded MD does not exceed
    Contract Demand (no excess to penalize).

    `demand_charge_rate` is currency per kVA; `penalty_multiplier` is the
    DISCOM-specific multiplier (Section 2: 1.5x-2x; MSEDCL uses 1.75x).
    """
    excess_kva = recorded_md_kva - contract_demand_kva
    if excess_kva <= 0:
        return {"excess_kva": 0.0, "penalty": 0.0}
    penalty = excess_kva * demand_charge_rate * penalty_multiplier
    return {"excess_kva": round(excess_kva, 4), "penalty": round(penalty, 2)}


def calculate_pf_adjustment(
    recorded_pf,
    incentive_threshold,
    surcharge_threshold,
    base_amount,
    incentive_rate_per_point,
    surcharge_rate_per_point,
):
    """PF incentive/surcharge per Section 2: PF >= incentive_threshold earns
    an incentive; PF <= surcharge_threshold triggers a surcharge, scaled by
    how far below/above the threshold the recorded PF falls. Between the two
    thresholds, no adjustment applies.

    Rates are expressed "per percentage point" of deviation from the
    threshold (a common real-world tariff-order convention) applied against
    `base_amount` (typically the energy or demand charge total for the
    period) - e.g. `surcharge_rate_per_point=0.01` means a 1% surcharge on
    `base_amount` for every 1 percentage point the PF falls below
    `surcharge_threshold`.

    Returns {"type": "incentive"|"surcharge"|"none", "points": float, "amount": float}.
    `points` and `amount` are always >= 0; `type` tells the caller which
    direction (credit vs. charge) to apply `amount` in.
    """
    if recorded_pf >= incentive_threshold:
        points = (recorded_pf - incentive_threshold) * 100
        amount = points * incentive_rate_per_point * base_amount
        return {"type": "incentive", "points": round(points, 4), "amount": round(amount, 2)}
    if recorded_pf <= surcharge_threshold:
        points = (surcharge_threshold - recorded_pf) * 100
        amount = points * surcharge_rate_per_point * base_amount
        return {"type": "surcharge", "points": round(points, 4), "amount": round(amount, 2)}
    return {"type": "none", "points": 0.0, "amount": 0.0}
