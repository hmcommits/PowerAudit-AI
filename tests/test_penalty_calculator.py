"""Unit tests for tariff_penalty_calculator.py"""

import sys
import os

# Add nodes directory to path for direct import during testing
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "nodes"))

from tariff_penalty_calculator import (
    run_calculation,
    calculate_md_penalty,
    calculate_pf_penalty,
    DISCOM_TARIFFS,
)

import pytest


#  Helpers
def make_bill(
    discom_id="MSEDCL",
    contract_demand_kva=500.0,
    recorded_max_demand_kva=550.0,
    power_factor=0.88,
    energy_charges=8000.0,
) -> dict:
    return {
        "discom_id":              discom_id,
        "contract_demand_kva":    contract_demand_kva,
        "recorded_max_demand_kva": recorded_max_demand_kva,
        "power_factor":           power_factor,
        "energy_charges":         energy_charges,
    }


#  MSEDCL Tests
class TestMSEDCL:

    def test_md_excess_above_threshold(self):
        """MD = 580 > CD(500) × 1.10 = 550 → EXCESS, penalty = (580-500) × 250 × 2 = ₹40,000"""
        cfg = DISCOM_TARIFFS["MSEDCL"]
        penalty, formula, status = calculate_md_penalty(cfg, 500.0, 580.0)

        assert status == "EXCESS"
        assert penalty == pytest.approx(40_000.0, abs=1.0)
        assert "580" in formula
        assert "500" in formula

    def test_md_exactly_at_threshold(self):
        """MD = 550 = CD(500) × 1.10 exactly → WITHIN_NORMAL (boundary: not strictly greater)"""
        cfg = DISCOM_TARIFFS["MSEDCL"]
        penalty, formula, status = calculate_md_penalty(cfg, 500.0, 550.0)
        assert status == "WITHIN_NORMAL"
        assert penalty == pytest.approx(0.0, abs=1.0)

    def test_md_just_above_threshold(self):
        """MD = 550.1 (just above threshold) → EXCESS"""
        cfg = DISCOM_TARIFFS["MSEDCL"]
        penalty, formula, status = calculate_md_penalty(cfg, 500.0, 550.1)
        assert status == "EXCESS"
        assert penalty > 0

    def test_md_normal_range(self):
        """MD = 480 within [250, 550] → WITHIN_NORMAL, no penalty"""
        cfg = DISCOM_TARIFFS["MSEDCL"]
        penalty, formula, status = calculate_md_penalty(cfg, 500.0, 480.0)
        assert status == "WITHIN_NORMAL"
        assert penalty == pytest.approx(0.0)

    def test_md_minimum_demand(self):
        """MD = 200 < CD(500) × 0.50 = 250 → MINIMUM_DEMAND, charge = 250 × 250 = ₹62,500"""
        cfg = DISCOM_TARIFFS["MSEDCL"]
        penalty, formula, status = calculate_md_penalty(cfg, 500.0, 200.0)
        assert status == "MINIMUM_DEMAND"
        assert penalty == pytest.approx(62_500.0, abs=1.0)

    def test_md_exactly_at_minimum(self):
        """MD = 250 = CD × 0.50 exactly → WITHIN_NORMAL (boundary)"""
        cfg = DISCOM_TARIFFS["MSEDCL"]
        penalty, formula, status = calculate_md_penalty(cfg, 500.0, 250.0)
        assert status == "WITHIN_NORMAL"

    def test_pf_penalty_below_threshold(self):
        """PF = 0.86 < 0.90 → PENALTY = 8000 × (0.90-0.86)/0.90 × 1.0 ≈ ₹355.56"""
        cfg = DISCOM_TARIFFS["MSEDCL"]
        penalty, incentive, formula, status = calculate_pf_penalty(cfg, 0.86, 8000.0)
        assert status == "PENALTY"
        assert penalty == pytest.approx(355.56, abs=1.0)
        assert incentive == pytest.approx(0.0)

    def test_pf_exactly_at_threshold(self):
        """PF = 0.90 exactly → NORMAL (boundary: not strictly less than)"""
        cfg = DISCOM_TARIFFS["MSEDCL"]
        penalty, incentive, formula, status = calculate_pf_penalty(cfg, 0.90, 8000.0)
        assert status == "NORMAL"
        assert penalty == pytest.approx(0.0)
        assert incentive == pytest.approx(0.0)

    def test_pf_incentive_above_threshold(self):
        """PF = 0.97 ≥ 0.95 → INCENTIVE = 8000 × (0.97-0.95)/0.95 × 0.5 ≈ ₹84.21"""
        cfg = DISCOM_TARIFFS["MSEDCL"]
        penalty, incentive, formula, status = calculate_pf_penalty(cfg, 0.97, 8000.0)
        assert status == "INCENTIVE"
        assert incentive == pytest.approx(84.21, abs=1.0)
        assert penalty == pytest.approx(0.0)

    def test_full_run_msedcl(self):
        """Full pipeline: MSEDCL bill with excess MD and low PF → both penalties calculated"""
        bill = make_bill(discom_id="MSEDCL", contract_demand_kva=500.0,
                         recorded_max_demand_kva=580.0, power_factor=0.86, energy_charges=8000.0)
        result = run_calculation(bill)
        assert result.discom_id == "MSEDCL"
        assert result.md_status == "EXCESS"
        assert result.recalculated_md_penalty == pytest.approx(40_000.0, abs=1.0)
        assert result.pf_status == "PENALTY"
        assert result.recalculated_pf_penalty > 0
        assert result.errors == []


#  TSSPDCL Tests
class TestTSSPDCL:

    def test_md_excess_tsspdcl(self):
        """TSSPDCL: MD=480 > CD(400)×1.10=440 → EXCESS, penalty=(480-400)×220×1.5=₹26,400"""
        cfg = DISCOM_TARIFFS["TSSPDCL"]
        penalty, formula, status = calculate_md_penalty(cfg, 400.0, 480.0)
        assert status == "EXCESS"
        assert penalty == pytest.approx(26_400.0, abs=1.0)

    def test_pf_penalty_tsspdcl(self):
        """TSSPDCL: PF=0.85 < 0.90 → PENALTY = 6800 × (0.90-0.85)/0.90 × 0.9 ≈ ₹340"""
        cfg = DISCOM_TARIFFS["TSSPDCL"]
        penalty, incentive, formula, status = calculate_pf_penalty(cfg, 0.85, 6800.0)
        assert status == "PENALTY"
        assert penalty == pytest.approx(340.0, abs=2.0)


#  BESCOM Tests
class TestBESCOM:

    def test_md_excess_bescom(self):
        """BESCOM: MD=700 > CD(600)×1.10=660 → EXCESS, penalty=(700-600)×230×2=₹46,000"""
        cfg = DISCOM_TARIFFS["BESCOM"]
        penalty, formula, status = calculate_md_penalty(cfg, 600.0, 700.0)
        assert status == "EXCESS"
        assert penalty == pytest.approx(46_000.0, abs=1.0)

    def test_md_minimum_demand_bescom(self):
        """BESCOM: MD=290 < CD(600)×0.50=300 → MINIMUM_DEMAND, charge=300×230=₹69,000"""
        cfg = DISCOM_TARIFFS["BESCOM"]
        penalty, formula, status = calculate_md_penalty(cfg, 600.0, 290.0)
        assert status == "MINIMUM_DEMAND"
        assert penalty == pytest.approx(69_000.0, abs=1.0)

    def test_pf_at_exact_threshold_bescom(self):
        """BESCOM: PF=0.90 exactly at threshold → NORMAL"""
        cfg = DISCOM_TARIFFS["BESCOM"]
        penalty, incentive, formula, status = calculate_pf_penalty(cfg, 0.90, 5600.0)
        assert status == "NORMAL"
        assert penalty == pytest.approx(0.0)


#  Edge Case Tests
class TestEdgeCases:

    def test_missing_cd_returns_missing_data(self):
        """Missing contract_demand → md_status = MISSING_DATA, no crash"""
        bill = make_bill(discom_id="MSEDCL")
        bill["contract_demand_kva"] = None
        result = run_calculation(bill)
        assert result.md_status == "MISSING_DATA"
        assert result.recalculated_md_penalty is None
        assert len(result.errors) > 0

    def test_missing_pf_returns_missing_data(self):
        """Missing power_factor → pf_status = MISSING_DATA, no crash"""
        bill = make_bill(discom_id="MSEDCL")
        bill["power_factor"] = None
        result = run_calculation(bill)
        assert result.pf_status == "MISSING_DATA"
        assert result.recalculated_pf_penalty is None

    def test_unknown_discom_falls_back_to_msedcl(self):
        """Unknown DISCOM string → falls back to MSEDCL, adds error message"""
        bill = make_bill(discom_id="UNKNOWN_DISCOM")
        result = run_calculation(bill)
        assert result.discom_id == "MSEDCL"
        assert any("falling back" in e.lower() for e in result.errors)

    def test_pf_zero_edge_case(self):
        """PF = 0 → extreme penalty, should not crash"""
        cfg = DISCOM_TARIFFS["MSEDCL"]
        penalty, incentive, formula, status = calculate_pf_penalty(cfg, 0.0, 8000.0)
        assert status == "PENALTY"
        assert penalty > 0

    def test_pf_exactly_one_edge_case(self):
        """PF = 1.0 → incentive (above 0.95), should not crash"""
        cfg = DISCOM_TARIFFS["MSEDCL"]
        penalty, incentive, formula, status = calculate_pf_penalty(cfg, 1.0, 8000.0)
        assert status == "INCENTIVE"
        assert incentive > 0

    def test_fixture_scenario_a(self):
        """Fixture A: MSEDCL, CD=500, MD=580, PF=0.86, EC=6400"""
        bill = {
            "discom_id": "MSEDCL",
            "contract_demand_kva": 500.0,
            "recorded_max_demand_kva": 580.0,
            "power_factor": 0.86,
            "energy_charges": 6400.0,
        }
        result = run_calculation(bill)
        # MD: excess = 80 kVA × 250 × 2 = ₹40,000
        assert result.recalculated_md_penalty == pytest.approx(40_000.0, abs=1.0)
        # PF: 6400 × (0.90-0.86)/0.90 × 1.0 ≈ ₹284.44
        assert result.recalculated_pf_penalty == pytest.approx(284.44, abs=2.0)

    def test_fixture_scenario_c_minimum_demand(self):
        """Fixture C: BESCOM, CD=600, MD=290 (below 50% = 300) → minimum demand triggered"""
        bill = {
            "discom_id": "BESCOM",
            "contract_demand_kva": 600.0,
            "recorded_max_demand_kva": 290.0,
            "power_factor": 0.90,
            "energy_charges": 5600.0,
        }
        result = run_calculation(bill)
        assert result.md_status == "MINIMUM_DEMAND"
        # Min demand charge = 300 × 230 = ₹69,000
        assert result.recalculated_md_penalty == pytest.approx(69_000.0, abs=1.0)
        # PF = 0.90 exactly → NORMAL
        assert result.pf_status == "NORMAL"
        assert result.recalculated_pf_penalty == pytest.approx(0.0)
