"""Unit tests for Feature 2's deterministic calculators, checked against
hand-calculated values (shown in each test's comment) before this module is
wired into recalculation.pipe or Vector retrieval - per the build context's
Section 2 hard rule (zero-LLM, unit-testable in isolation).

Run: python -m unittest calculators.test_calculators -v
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from calculators.bill_line_parser import (
    classify_line_item,
    normalize_line_items,
    parse_amount,
    sum_by_category,
)
from calculators.tariff_penalty_calculator import calculate_md_penalty, calculate_pf_adjustment


class TestParseAmount(unittest.TestCase):
    def test_plain_rupee_string(self):
        self.assertEqual(parse_amount("Rs. 412500"), 412500.0)

    def test_with_thousands_separator_and_decimals(self):
        self.assertEqual(parse_amount("Rs. 8,200.50"), 8200.50)

    def test_parenthesized_is_negative(self):
        # Accounting convention: (1,200.00) means a credit of -1200.00
        self.assertEqual(parse_amount("(1,200.00)"), -1200.00)

    def test_leading_minus_sign(self):
        self.assertEqual(parse_amount("-4200"), -4200.0)

    def test_bare_number(self):
        self.assertEqual(parse_amount(630700), 630700.0)

    def test_unparseable_returns_none(self):
        self.assertIsNone(parse_amount("N/A"))
        self.assertIsNone(parse_amount(""))
        self.assertIsNone(parse_amount(None))


class TestClassifyLineItem(unittest.TestCase):
    def test_energy_charge(self):
        self.assertEqual(classify_line_item("Energy Charge"), "energy_charge")

    def test_demand_charge(self):
        self.assertEqual(classify_line_item("Demand Charge"), "demand_charge")

    def test_md_penalty_before_generic_demand_charge(self):
        # "MD Penalty" must not fall through to the generic demand_charge bucket
        self.assertEqual(classify_line_item("MD Penalty"), "md_penalty")
        self.assertEqual(classify_line_item("Maximum Demand Penalty"), "md_penalty")

    def test_pf_surcharge_vs_incentive(self):
        self.assertEqual(classify_line_item("PF Surcharge"), "pf_surcharge")
        self.assertEqual(classify_line_item("PF Incentive"), "pf_incentive")

    def test_fac(self):
        self.assertEqual(classify_line_item("FAC"), "fuel_adjustment_charge")

    def test_unknown_falls_back_to_other(self):
        self.assertEqual(classify_line_item("Miscellaneous Fee"), "other")
        self.assertEqual(classify_line_item(""), "other")


class TestNormalizeLineItems(unittest.TestCase):
    def test_dict_input(self):
        raw = {"Energy Charge": "Rs. 412500", "Demand Charge": "Rs. 210000", "FAC": "Rs. 8200"}
        result = normalize_line_items(raw)
        self.assertEqual(len(result), 3)
        by_category = {item["category"]: item["amount"] for item in result}
        self.assertEqual(by_category["energy_charge"], 412500.0)
        self.assertEqual(by_category["demand_charge"], 210000.0)
        self.assertEqual(by_category["fuel_adjustment_charge"], 8200.0)

    def test_malformed_amount_kept_with_none_not_dropped(self):
        result = normalize_line_items({"Energy Charge": "N/A"})
        self.assertEqual(len(result), 1)
        self.assertIsNone(result[0]["amount"])
        self.assertEqual(result[0]["category"], "energy_charge")

    def test_sum_by_category_skips_unparseable(self):
        items = normalize_line_items({"Energy Charge": "Rs. 100000", "Demand Charge": "N/A"})
        totals = sum_by_category(items)
        self.assertEqual(totals, {"energy_charge": 100000.0})


class TestMDPenalty(unittest.TestCase):
    def test_within_contract_demand_no_penalty(self):
        # 480 kVA recorded against a 500 kVA contract - no excess.
        result = calculate_md_penalty(480, 500, demand_charge_rate=450, penalty_multiplier=1.75)
        self.assertEqual(result["penalty"], 0.0)
        self.assertEqual(result["excess_kva"], 0.0)

    def test_exactly_at_contract_demand_no_penalty(self):
        # Boundary: recorded == contract is not an excess.
        result = calculate_md_penalty(500, 500, demand_charge_rate=450, penalty_multiplier=1.75)
        self.assertEqual(result["penalty"], 0.0)

    def test_msedcl_multiplier_hand_calculated(self):
        # Hand calc: excess = 550 - 500 = 50 kVA
        #            penalty = 50 * 450 * 1.75 = 39375.0
        result = calculate_md_penalty(550, 500, demand_charge_rate=450, penalty_multiplier=1.75)
        self.assertEqual(result["excess_kva"], 50.0)
        self.assertEqual(result["penalty"], 39375.0)

    def test_upper_end_of_multiplier_range_hand_calculated(self):
        # Hand calc: excess = 1000 - 800 = 200 kVA
        #            penalty = 200 * 500 * 2.0 = 200000.0
        result = calculate_md_penalty(1000, 800, demand_charge_rate=500, penalty_multiplier=2.0)
        self.assertEqual(result["excess_kva"], 200.0)
        self.assertEqual(result["penalty"], 200000.0)


class TestPFAdjustment(unittest.TestCase):
    # Illustrative rates for hand-calculation (real values come from the
    # retrieved tariff order, per Section 2 - never hardcoded in the module).
    INCENTIVE_THRESHOLD = 0.95
    SURCHARGE_THRESHOLD = 0.90
    INCENTIVE_RATE_PER_POINT = 0.005  # 0.5% of base_amount per point above threshold
    SURCHARGE_RATE_PER_POINT = 0.01   # 1% of base_amount per point below threshold

    def _run(self, pf, base_amount=100000):
        return calculate_pf_adjustment(
            pf,
            self.INCENTIVE_THRESHOLD,
            self.SURCHARGE_THRESHOLD,
            base_amount,
            self.INCENTIVE_RATE_PER_POINT,
            self.SURCHARGE_RATE_PER_POINT,
        )

    def test_incentive_hand_calculated(self):
        # Hand calc: points = (0.97 - 0.95) * 100 = 2.0
        #            amount = 2.0 * 0.005 * 100000 = 1000.0
        result = self._run(0.97)
        self.assertEqual(result["type"], "incentive")
        self.assertEqual(result["points"], 2.0)
        self.assertEqual(result["amount"], 1000.0)

    def test_surcharge_hand_calculated(self):
        # Hand calc: points = (0.90 - 0.85) * 100 = 5.0
        #            amount = 5.0 * 0.01 * 100000 = 5000.0
        result = self._run(0.85)
        self.assertEqual(result["type"], "surcharge")
        self.assertEqual(result["points"], 5.0)
        self.assertEqual(result["amount"], 5000.0)

    def test_between_thresholds_no_adjustment(self):
        result = self._run(0.92)
        self.assertEqual(result["type"], "none")
        self.assertEqual(result["amount"], 0.0)

    def test_incentive_threshold_boundary(self):
        # Exactly at 0.95: 0 points, 0 amount, but still classified incentive
        # (Section 2: "PF >= ~0.95 ... earns an incentive").
        result = self._run(0.95)
        self.assertEqual(result["type"], "incentive")
        self.assertEqual(result["points"], 0.0)
        self.assertEqual(result["amount"], 0.0)

    def test_surcharge_threshold_boundary(self):
        # Exactly at 0.90: 0 points, 0 amount, but still classified surcharge
        # (Section 2: "PF <= ~0.90 triggers a surcharge").
        result = self._run(0.90)
        self.assertEqual(result["type"], "surcharge")
        self.assertEqual(result["points"], 0.0)
        self.assertEqual(result["amount"], 0.0)


if __name__ == "__main__":
    unittest.main()
