"""Feature #2 Step 2"""

import json
import sys
from dataclasses import dataclass, field, asdict
from typing import Optional

#  TARIFF CONSTANTS  (from whitepaper: MSEDCL MYT 2026-27,
#                     TSSPDCL 2024, BESCOM 2024)
@dataclass
class TariffConfig:
    """All constants for one DISCOM's penalty formulas."""
    discom_id: str
    state: str

    # MD Penalty thresholds and multipliers
    md_excess_threshold_pct: float     # penalty if MD > CD * this (e.g. 1.10)
    md_excess_penalty_multiplier: float # penalty = excess_kva * rate * this
    md_base_rate_per_kva: float        # Rs./kVA/month demand charge rate
    md_minimum_demand_pct: float       # min demand = CD * this (e.g. 0.50)

    # PF Penalty/Incentive thresholds
    pf_penalty_threshold: float        # PF below this -> penalty (0.90 all DISCOMs)
    pf_incentive_threshold: float      # PF above this -> incentive (0.95 all DISCOMs)
    pf_penalty_rate_per_unit: float    # penalty = energy_charges * (gap/threshold) * this
    pf_incentive_rate_per_unit: float  # incentive = energy_charges * (gain/threshold) * this

    # EV Charging tariff (separate dedicated meter — single-part in TS & KA)
    ev_tariff_ht: float                # Rs./kWh for HT EV connection
    ev_tariff_lt: float                # Rs./kWh for LT EV connection
    ev_demand_charges: bool            # True = demand charges apply on EV meter

    # ToD (Time-of-Day) metadata
    tod_mandatory_threshold_kva: float  # ToD mandatory above this CD (kVA)
    tod_offpeak_start_hour: int         # 24h format, e.g. 22 = 10 PM
    tod_offpeak_end_hour: int           # 24h format, e.g. 6 = 6 AM

    # Open Access / GEOA
    geoa_threshold_kw: float           # Min load for Green Energy Open Access

    # Citation reference for this tariff block
    md_clause_ref: str
    pf_clause_ref: str
    ev_clause_ref: str
    tariff_year: str
    tariff_order_name: str


DISCOM_TARIFFS: dict[str, TariffConfig] = {
    "MSEDCL": TariffConfig(
        discom_id="MSEDCL",
        state="Maharashtra",
        # MD: penalty if MD > CD * 1.10
        # Penalty = (MD - CD) * MD_rate * 2  [MSEDCL MYT Order 2026-27, Clause 7.2(b)]
        md_excess_threshold_pct=1.10,
        md_excess_penalty_multiplier=2.0,
        md_base_rate_per_kva=250.0,          # Rs.250/kVA/month (HT-I category)
        md_minimum_demand_pct=0.50,
        # PF: penalty < 0.90, incentive >= 0.95 [MSEDCL MYT 2026-27, Clause 8.1]
        pf_penalty_threshold=0.90,
        pf_incentive_threshold=0.95,
        pf_penalty_rate_per_unit=1.0,
        pf_incentive_rate_per_unit=0.5,
        # EV: Rs.9.50/unit for both HT and LT (dedicated meter, demand charges apply)
        ev_tariff_ht=9.50,
        ev_tariff_lt=9.50,
        ev_demand_charges=True,
        # ToD: Highly enforced. No mandatory kVA threshold stated (applies broadly)
        tod_mandatory_threshold_kva=0.0,
        tod_offpeak_start_hour=22,           # 10 PM
        tod_offpeak_end_hour=6,              # 6 AM
        # GEOA: Available >= 100 kW; aggregation (consortium) permitted
        geoa_threshold_kw=100.0,
        md_clause_ref="MSEDCL MYT Order 2026-27, Clause 7.2(b) — Excess Maximum Demand",
        pf_clause_ref="MSEDCL MYT Order 2026-27, Clause 8.1 — Power Factor Surcharge",
        ev_clause_ref="MSEDCL MYT Order 2026-27 — Dedicated EV Charging Tariff Rs.9.50/unit (HT & LT)",
        tariff_year="2026-27",
        tariff_order_name="MSEDCL Multi-Year Tariff Order 2026-27",
    ),
    "TSSPDCL": TariffConfig(
        discom_id="TSSPDCL",
        state="Telangana",
        # MD: penalty if MD > CD * 1.10
        # Penalty = excess_kva * rate * 1.5  [TSERC Schedule of Tariffs 2024, Clause 14]
        md_excess_threshold_pct=1.10,
        md_excess_penalty_multiplier=1.5,
        md_base_rate_per_kva=220.0,          # Rs.220/kVA/month (HT-II category)
        md_minimum_demand_pct=0.50,
        # PF: concessional penalty rate 0.9 vs MSEDCL [TSERC Clause 15.2]
        pf_penalty_threshold=0.90,
        pf_incentive_threshold=0.95,
        pf_penalty_rate_per_unit=0.9,        # concessional vs MSEDCL (1.0)
        pf_incentive_rate_per_unit=0.5,
        # EV: Single-part tariff, ZERO demand charges (most competitive in India)
        ev_tariff_ht=6.10,                   # Rs.6.10/kWh HT (TSERC notified)
        ev_tariff_lt=6.70,                   # Rs.6.70/kWh LT
        ev_demand_charges=False,             # ZERO demand charges on EV meter
        # ToD: Standard HT structure
        tod_mandatory_threshold_kva=0.0,
        tod_offpeak_start_hour=23,           # 11 PM (logistics night charging)
        tod_offpeak_end_hour=6,
        geoa_threshold_kw=100.0,
        md_clause_ref="TSERC Schedule of Tariffs 2024, Clause 14 — Maximum Demand Penalty",
        pf_clause_ref="TSERC Schedule of Tariffs 2024, Clause 15.2 — Power Factor Levy",
        ev_clause_ref="TSERC EV Charging Tariff — Single-part Rs.6.10/kWh (HT), Rs.6.70/kWh (LT), zero demand charges",
        tariff_year="2024",
        tariff_order_name="TSERC Schedule of Tariffs 2024",
    ),
    "BESCOM": TariffConfig(
        discom_id="BESCOM",
        state="Karnataka",
        # MD: 2x normal rate if MD exceeds sanctioned load [BESCOM Tariff Order 2024, Clause 11(a)]
        # Confirmed in whitepaper: 'penal charges apply at 2x the normal rate'
        md_excess_threshold_pct=1.10,
        md_excess_penalty_multiplier=2.0,    # 2x confirmed
        md_base_rate_per_kva=230.0,          # Rs.230/kVA/month (HT-2(a) category)
        md_minimum_demand_pct=0.50,
        # PF: penalty < 0.90, incentive >= 0.95 [BESCOM Tariff Order 2024, Clause 12]
        pf_penalty_threshold=0.90,
        pf_incentive_threshold=0.95,
        pf_penalty_rate_per_unit=1.0,
        pf_incentive_rate_per_unit=0.5,
        # EV: LT-6(a) category, Rs.5.50-6.50/unit, zero demand charges
        # BESCOM also operates EV Land Aggregator Portal (PM E-DRIVE)
        ev_tariff_ht=6.00,                   # midpoint of Rs.5.50-6.50 range
        ev_tariff_lt=5.75,                   # LT-6(a) category
        ev_demand_charges=False,             # ZERO demand charges on EV meter
        # ToD: MANDATORY for HT2(a/b/c) with CD >= 500 kVA; optional below
        tod_mandatory_threshold_kva=500.0,   # mandatory ToD threshold
        tod_offpeak_start_hour=22,           # 10 PM
        tod_offpeak_end_hour=6,              # 6 AM
        # Off-season tariff available up to 6 months/year
        geoa_threshold_kw=100.0,
        md_clause_ref="BESCOM Tariff Order 2024, Clause 11(a) — Excess Maximum Demand (2x penalty)",
        pf_clause_ref="BESCOM Tariff Order 2024, Clause 12 — Power Factor Incentive/Penalty",
        ev_clause_ref="BESCOM Tariff Order 2024 — LT-6(a) EV Charging Rs.5.50-6.50/unit, zero demand charges",
        tariff_year="2024",
        tariff_order_name="BESCOM Tariff Order 2024",
    ),
    # Alias: TGSPDCL = TSSPDCL (same state, interchangeable in filings)
    "TGSPDCL": None,  # resolved at runtime
}

#  CALCULATION ENGINE
@dataclass
class PenaltyResult:
    discom_id: str
    tariff_year: str

    # MD results
    recalculated_md_penalty: Optional[float]
    md_formula_used: str
    md_inputs: dict
    md_clause_ref: str
    md_status: str   # 'EXCESS' | 'MINIMUM_DEMAND' | 'WITHIN_NORMAL' | 'MISSING_DATA'

    # PF results
    recalculated_pf_penalty: Optional[float]
    pf_incentive: Optional[float]
    pf_formula_used: str
    pf_inputs: dict
    pf_clause_ref: str
    pf_status: str   # 'PENALTY' | 'INCENTIVE' | 'NORMAL' | 'MISSING_DATA'

    errors: list = field(default_factory=list)


def calculate_md_penalty(
    cfg: TariffConfig,
    contract_demand_kva: float,
    recorded_max_demand_kva: float,
) -> tuple[float, str, str]:
    """
    Returns (penalty_amount, formula_str, status).
    """
    threshold_kva = contract_demand_kva * cfg.md_excess_threshold_pct
    minimum_kva   = contract_demand_kva * cfg.md_minimum_demand_pct
    rate          = cfg.md_base_rate_per_kva
    multiplier    = cfg.md_excess_penalty_multiplier

    if recorded_max_demand_kva > threshold_kva:
        excess = recorded_max_demand_kva - contract_demand_kva
        penalty = round(excess * rate * multiplier, 2)
        formula = (
            f"MD({recorded_max_demand_kva} kVA) > CD({contract_demand_kva}) * "
            f"{cfg.md_excess_threshold_pct} = {threshold_kva:.1f} kVA -> "
            f"Excess = {excess:.2f} kVA * Rs.{rate}/kVA * {multiplier} = Rs.{penalty}"
        )
        return penalty, formula, "EXCESS"

    elif recorded_max_demand_kva < minimum_kva:
        # Minimum demand charge: billed as if MD = CD * 50%
        penalty = round(minimum_kva * rate, 2)
        formula = (
            f"MD({recorded_max_demand_kva} kVA) < CD * {cfg.md_minimum_demand_pct} = "
            f"{minimum_kva:.1f} kVA -> Minimum demand: {minimum_kva:.1f} * Rs.{rate} = Rs.{penalty}"
        )
        return penalty, formula, "MINIMUM_DEMAND"

    else:
        # Normal range -- no penalty, normal demand charge
        normal_charge = round(recorded_max_demand_kva * rate, 2)
        formula = (
            f"MD({recorded_max_demand_kva} kVA) within normal range "
            f"[{minimum_kva:.1f} - {threshold_kva:.1f}] kVA -> "
            f"Normal demand charge: {recorded_max_demand_kva} * Rs.{rate} = Rs.{normal_charge}"
        )
        return 0.0, formula, "WITHIN_NORMAL"


def calculate_pf_penalty(
    cfg: TariffConfig,
    power_factor: float,
    energy_charges: float,
) -> tuple[float, float, str, str]:
    """
    Returns (penalty_amount, incentive_amount, formula_str, status).
    """
    pf_threshold  = cfg.pf_penalty_threshold
    pf_incentive  = cfg.pf_incentive_threshold
    penalty_rate  = cfg.pf_penalty_rate_per_unit
    incentive_rate = cfg.pf_incentive_rate_per_unit

    if power_factor < pf_threshold:
        pf_gap  = round(pf_threshold - power_factor, 4)
        penalty = round(energy_charges * (pf_gap / pf_threshold) * penalty_rate, 2)
        formula = (
            f"PF({power_factor}) < threshold({pf_threshold}) -> "
            f"Penalty = Rs.{energy_charges} * ({pf_threshold} - {power_factor}) / {pf_threshold} "
            f"* {penalty_rate} = Rs.{penalty}"
        )
        return penalty, 0.0, formula, "PENALTY"

    elif power_factor >= pf_incentive:
        pf_gain    = round(power_factor - pf_incentive, 4)
        incentive  = round(energy_charges * (pf_gain / pf_incentive) * incentive_rate, 2)
        formula = (
            f"PF({power_factor}) >= incentive_threshold({pf_incentive}) -> "
            f"Incentive = Rs.{energy_charges} * ({power_factor} - {pf_incentive}) / {pf_incentive} "
            f"* {incentive_rate} = Rs.{incentive}"
        )
        return 0.0, incentive, formula, "INCENTIVE"

    else:
        formula = (
            f"PF({power_factor}) in normal range [{pf_threshold} - {pf_incentive}] -> "
            f"No penalty, no incentive."
        )
        return 0.0, 0.0, formula, "NORMAL"


def run_calculation(line_items: dict) -> PenaltyResult:
    """
    Main entry point: takes normalized line_items, returns PenaltyResult.
    """
    discom_id = (line_items.get("discom_id") or "").upper().strip()
    errors    = []

    cfg = DISCOM_TARIFFS.get(discom_id)
    # Resolve TGSPDCL alias (same state as TSSPDCL; interchangeable in Telangana filings)
    if cfg is None and discom_id == "TGSPDCL":
        cfg = DISCOM_TARIFFS["TSSPDCL"]
        discom_id = "TSSPDCL"
        errors.append("TGSPDCL resolved to TSSPDCL (same state entity).")
    elif cfg is None:
        # Fallback to MSEDCL if DISCOM not recognised
        errors.append(f"DISCOM '{discom_id}' not found in tariff config; falling back to MSEDCL.")
        discom_id = "MSEDCL"
        cfg = DISCOM_TARIFFS["MSEDCL"]


    cd  = line_items.get("contract_demand_kva")
    md  = line_items.get("recorded_max_demand_kva")
    pf  = line_items.get("power_factor")
    ec  = line_items.get("energy_charges")

    # MD penalty
    if cd is not None and md is not None:
        md_penalty, md_formula, md_status = calculate_md_penalty(cfg, cd, md)
        md_inputs = {
            "contract_demand_kva": cd,
            "recorded_max_demand_kva": md,
            "rate_per_kva": cfg.md_base_rate_per_kva,
            "excess_threshold_pct": cfg.md_excess_threshold_pct,
            "penalty_multiplier": cfg.md_excess_penalty_multiplier,
        }
    else:
        md_penalty, md_formula, md_status = None, "Skipped — missing CD or MD", "MISSING_DATA"
        md_inputs = {"contract_demand_kva": cd, "recorded_max_demand_kva": md}
        errors.append("MD penalty skipped: contract_demand_kva or recorded_max_demand_kva is None.")

    # PF penalty
    if pf is not None and ec is not None:
        pf_penalty, pf_inc, pf_formula, pf_status = calculate_pf_penalty(cfg, pf, ec)
        pf_inputs = {
            "power_factor": pf,
            "energy_charges": ec,
            "penalty_threshold": cfg.pf_penalty_threshold,
            "incentive_threshold": cfg.pf_incentive_threshold,
            "penalty_rate": cfg.pf_penalty_rate_per_unit,
        }
    else:
        pf_penalty, pf_inc, pf_formula, pf_status = None, None, "Skipped — missing PF or energy charges", "MISSING_DATA"
        pf_inputs = {"power_factor": pf, "energy_charges": ec}
        errors.append("PF penalty skipped: power_factor or energy_charges is None.")

    return PenaltyResult(
        discom_id=cfg.discom_id,
        tariff_year=cfg.tariff_year,
        recalculated_md_penalty=md_penalty,
        md_formula_used=md_formula,
        md_inputs=md_inputs,
        md_clause_ref=cfg.md_clause_ref,
        md_status=md_status,
        recalculated_pf_penalty=pf_penalty,
        pf_incentive=pf_inc,
        pf_formula_used=pf_formula,
        pf_inputs=pf_inputs,
        pf_clause_ref=cfg.pf_clause_ref,
        pf_status=pf_status,
        errors=errors,
    )


def main():
    raw_input = sys.stdin.read().strip()
    try:
        line_items = json.loads(raw_input)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON: {e}"}))
        sys.exit(1)

    result = run_calculation(line_items)
    print(json.dumps(asdict(result), default=str))


if __name__ == "__main__":
    main()
