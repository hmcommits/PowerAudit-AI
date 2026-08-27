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
from calculators.variance_detector import detect_variances
from calculators.dollar_impact_scorer import score_finding, score_findings
from calculators.history_aggregator import build_history
from calculators.trend_classifier import classify_cd_trend, classify_pf_trend
from calculators.what_if import what_if_cd_change
from calculators.contract_impact_classifier import classify_contract_impact
from calculators.claim_workflow import (
    is_material,
    submit_for_approval,
    approve_claim,
    deny_claim,
    file_claim,
    mark_under_review,
    mark_credited,
)


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


class TestVarianceDetector(unittest.TestCase):
    def test_math_error_hand_calculated(self):
        # Hand calc: line items sum to 412500 + 210000 = 622500, but the bill
        # states total_due = 630700 -> a 8200 discrepancy (e.g. FAC omitted
        # from the printed line items but folded into the total).
        items = normalize_line_items({"Energy Charge": "Rs. 412500", "Demand Charge": "Rs. 210000"})
        recalc_md = calculate_md_penalty(480, 500, demand_charge_rate=450, penalty_multiplier=1.75)
        recalc_pf = calculate_pf_adjustment(0.97, 0.95, 0.90, 100000, 0.005, 0.01)
        variances = detect_variances(items, billed_total_due=630700, recalculated_md=recalc_md, recalculated_pf=recalc_pf)
        math_errors = [v for v in variances if v["type"] == "math-error"]
        self.assertEqual(len(math_errors), 1)
        self.assertEqual(math_errors[0]["recalculated_amount"], 622500.0)
        self.assertEqual(math_errors[0]["billed_amount"], 630700)

    def test_no_math_error_when_totals_match(self):
        items = normalize_line_items({"Energy Charge": "Rs. 100000", "Demand Charge": "Rs. 50000"})
        recalc_md = calculate_md_penalty(480, 500, demand_charge_rate=450, penalty_multiplier=1.75)
        recalc_pf = calculate_pf_adjustment(0.97, 0.95, 0.90, 100000, 0.005, 0.01)
        variances = detect_variances(items, billed_total_due=150000, recalculated_md=recalc_md, recalculated_pf=recalc_pf)
        self.assertEqual([v for v in variances if v["type"] == "math-error"], [])

    def test_md_penalty_unbilled_hand_calculated(self):
        # Recorded MD (550) exceeds Contract Demand (500) by 50 kVA -
        # hand calc: 50 * 450 * 1.75 = 39375 penalty is owed, but the bill's
        # line items contain no MD Penalty charge at all (billed = 0).
        items = normalize_line_items({"Energy Charge": "Rs. 500000", "Demand Charge": "Rs. 250000"})
        recalc_md = calculate_md_penalty(550, 500, demand_charge_rate=450, penalty_multiplier=1.75)
        recalc_pf = calculate_pf_adjustment(0.97, 0.95, 0.90, 100000, 0.005, 0.01)
        variances = detect_variances(items, billed_total_due=750000, recalculated_md=recalc_md, recalculated_pf=recalc_pf)
        md_findings = [v for v in variances if v["type"] == "md-penalty"]
        self.assertEqual(len(md_findings), 1)
        self.assertEqual(md_findings[0]["billed_amount"], 0.0)
        self.assertEqual(md_findings[0]["recalculated_amount"], 39375.0)

    def test_md_penalty_matches_no_finding(self):
        items = normalize_line_items({"Energy Charge": "Rs. 500000", "MD Penalty": "Rs. 39375"})
        recalc_md = calculate_md_penalty(550, 500, demand_charge_rate=450, penalty_multiplier=1.75)
        recalc_pf = calculate_pf_adjustment(0.97, 0.95, 0.90, 100000, 0.005, 0.01)
        variances = detect_variances(items, billed_total_due=539375, recalculated_md=recalc_md, recalculated_pf=recalc_pf)
        self.assertEqual([v for v in variances if v["type"] == "md-penalty"], [])

    def test_pf_penalty_missing_surcharge_hand_calculated(self):
        # PF 0.85 is below the 0.90 surcharge threshold - hand calc:
        # (0.90 - 0.85) * 100 = 5 points * 0.01 * 100000 base = 5000 owed,
        # but the bill has no PF Surcharge line item (billed net = 0).
        items = normalize_line_items({"Energy Charge": "Rs. 100000"})
        recalc_md = calculate_md_penalty(480, 500, demand_charge_rate=450, penalty_multiplier=1.75)
        recalc_pf = calculate_pf_adjustment(0.85, 0.95, 0.90, 100000, 0.005, 0.01)
        variances = detect_variances(items, billed_total_due=100000, recalculated_md=recalc_md, recalculated_pf=recalc_pf)
        pf_findings = [v for v in variances if v["type"] == "pf-penalty"]
        self.assertEqual(len(pf_findings), 1)
        self.assertEqual(pf_findings[0]["billed_amount"], 0.0)
        self.assertEqual(pf_findings[0]["recalculated_amount"], 5000.0)


class TestDollarImpactScorer(unittest.TestCase):
    def test_overcharge_positive_impact_hand_calculated(self):
        # billed 39375, recalculated 0 -> consumer was overcharged by 39375.
        variance = {"type": "md-penalty", "billed_amount": 39375.0, "recalculated_amount": 0.0, "detail": "x"}
        result = score_finding(variance)
        self.assertEqual(result["rupee_impact"], 39375.0)
        self.assertEqual(result["confidence"], 1.0)

    def test_undercharge_negative_impact_hand_calculated(self):
        # billed 0, recalculated 39375 -> consumer was undercharged (owes
        # more than they paid) - impact is negative by this module's
        # convention (positive = overcharge/dispute-worthy).
        variance = {"type": "md-penalty", "billed_amount": 0.0, "recalculated_amount": 39375.0, "detail": "x"}
        result = score_finding(variance)
        self.assertEqual(result["rupee_impact"], -39375.0)

    def test_confidence_reduced_by_data_quality_flags(self):
        # Hand calc: 1.0 - 2 * 0.15 = 0.70
        variance = {"type": "math-error", "billed_amount": 630700, "recalculated_amount": 622500.0, "detail": "x"}
        result = score_finding(variance, data_quality_flags=["flag1", "flag2"])
        self.assertEqual(result["confidence"], 0.70)

    def test_confidence_floor(self):
        variance = {"type": "math-error", "billed_amount": 1, "recalculated_amount": 0, "detail": "x"}
        result = score_finding(variance, data_quality_flags=["a", "b", "c", "d", "e", "f", "g"])
        self.assertEqual(result["confidence"], 0.1)

    def test_score_findings_batch(self):
        variances = [
            {"type": "md-penalty", "billed_amount": 39375.0, "recalculated_amount": 0.0, "detail": "x"},
            {"type": "math-error", "billed_amount": 630700, "recalculated_amount": 622500.0, "detail": "y"},
        ]
        scored = score_findings(variances)
        self.assertEqual(len(scored), 2)
        self.assertEqual(scored[0]["rupee_impact"], 39375.0)
        self.assertEqual(scored[1]["rupee_impact"], 8200.0)


def _rows(md_series=None, pf_series=None, start_year=2026, start_month=1):
    """Build history_aggregator-ready rows: one per month starting at
    (start_year, start_month), for whichever of md_series/pf_series is
    given (missing values default to a fixed placeholder in the other
    field so build_history doesn't drop the row)."""
    n = len(md_series) if md_series is not None else len(pf_series)
    md_series = md_series or [100.0] * n
    pf_series = pf_series or [0.95] * n
    rows = []
    for i in range(n):
        month = start_month + i
        year = start_year + (month - 1) // 12
        month = ((month - 1) % 12) + 1
        rows.append({"period_start": f"{year:04d}-{month:02d}-01", "recorded_md": md_series[i], "recorded_pf": pf_series[i]})
    return rows


class TestHistoryAggregator(unittest.TestCase):
    def test_sorted_and_month_indexed(self):
        rows = _rows(md_series=[400, 420, 440])
        history = build_history(rows)
        self.assertEqual([h["month_index"] for h in history], [0, 1, 2])
        self.assertEqual([h["recorded_md"] for h in history], [400.0, 420.0, 440.0])

    def test_out_of_order_rows_get_sorted(self):
        rows = _rows(md_series=[400, 420, 440])
        shuffled = [rows[2], rows[0], rows[1]]
        history = build_history(shuffled)
        self.assertEqual([h["recorded_md"] for h in history], [400.0, 420.0, 440.0])

    def test_rows_missing_fields_are_dropped(self):
        rows = _rows(md_series=[400, 420, 440])
        rows[1]["recorded_pf"] = None
        history = build_history(rows)
        self.assertEqual(len(history), 2)


class TestCDTrendClassifier(unittest.TestCase):
    def test_insufficient_data(self):
        history = build_history(_rows(md_series=[400, 420]))
        result = classify_cd_trend(history, contract_demand_kva=530)
        self.assertEqual(result["status"], "insufficient_data")

    def test_rising_trend_triggers_breach_risk_hand_calculated(self):
        # Perfectly linear: recorded_md = 400, 420, ..., 500 (slope=20/month).
        # Hand calc: x_mean=2.5, y_mean=450, slope=20.0, intercept=400.0
        #            projected at x=5+2=7: 20*7+400 = 540 >= CD 530 -> risk
        #            months_to_breach = (530-500)/20 = 1.5
        history = build_history(_rows(md_series=[400, 420, 440, 460, 480, 500]))
        result = classify_cd_trend(history, contract_demand_kva=530)
        self.assertEqual(result["status"], "cd-breach-risk")
        self.assertEqual(result["slope_kva_per_month"], 20.0)
        self.assertEqual(result["months_to_breach"], 1.5)
        self.assertEqual(result["projected_md_at_horizon"], 540.0)

    def test_flat_trend_does_not_trigger(self):
        history = build_history(_rows(md_series=[250, 250, 250, 250, 250, 250]))
        result = classify_cd_trend(history, contract_demand_kva=300)
        self.assertEqual(result["status"], "flat_or_declining")
        self.assertEqual(result["slope_kva_per_month"], 0.0)

    def test_already_breached(self):
        history = build_history(_rows(md_series=[480, 490, 510]))
        result = classify_cd_trend(history, contract_demand_kva=500)
        self.assertEqual(result["status"], "already_breached")

    def test_rising_but_not_enough_to_cross_horizon(self):
        # Same slope as the risk case, but CD is far enough away that the
        # 2-month projection doesn't reach it: 20*7+400 = 540 < CD 600.
        history = build_history(_rows(md_series=[400, 420, 440, 460, 480, 500]))
        result = classify_cd_trend(history, contract_demand_kva=600)
        self.assertEqual(result["status"], "on_track")


class TestPFTrendClassifier(unittest.TestCase):
    def test_declining_trend_triggers_decline_risk_hand_calculated(self):
        # Perfectly linear: recorded_pf = 0.98, 0.96, ..., 0.88 (slope=-0.02/month).
        # Hand calc: intercept=0.98, projected at x=7: -0.02*7+0.98 = 0.84 <= 0.85 -> risk
        #            months_to_breach = (0.88-0.85)/0.02 = 1.5
        history = build_history(_rows(pf_series=[0.98, 0.96, 0.94, 0.92, 0.90, 0.88]))
        result = classify_pf_trend(history, pf_threshold=0.85)
        self.assertEqual(result["status"], "pf-decline-risk")
        self.assertEqual(result["slope_per_month"], -0.02)
        self.assertEqual(result["months_to_breach"], 1.5)
        self.assertEqual(result["projected_pf_at_horizon"], 0.84)

    def test_flat_pf_does_not_trigger(self):
        history = build_history(_rows(pf_series=[0.95] * 6))
        result = classify_pf_trend(history, pf_threshold=0.90)
        self.assertEqual(result["status"], "flat_or_improving")

    def test_already_breached(self):
        history = build_history(_rows(pf_series=[0.92, 0.90, 0.87]))
        result = classify_pf_trend(history, pf_threshold=0.90)
        self.assertEqual(result["status"], "already_breached")


class TestWhatIf(unittest.TestCase):
    def test_cd_raise_savings_hand_calculated(self):
        # Same rising series as the breach-risk test: projected_md = 540.0.
        # Hand calc at current CD=530: excess=540-530=10 -> 10*450*1.75=7875.0
        # Hand calc at hypothetical CD=560: excess=540-560=-20 -> no excess -> 0.0
        # Savings = 7875.0 - 0.0 = 7875.0
        history = build_history(_rows(md_series=[400, 420, 440, 460, 480, 500]))
        params = {"demand_charge_rate": 450, "penalty_multiplier": 1.75}
        result = what_if_cd_change(history, current_cd=530, hypothetical_cd=560, tariff_params=params)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["projected_md_at_horizon"], 540.0)
        self.assertEqual(result["current_projected_penalty"], 7875.0)
        self.assertEqual(result["hypothetical_projected_penalty"], 0.0)
        self.assertEqual(result["projected_savings"], 7875.0)

    def test_insufficient_data(self):
        history = build_history(_rows(md_series=[400, 420]))
        result = what_if_cd_change(history, current_cd=530, hypothetical_cd=560, tariff_params={"demand_charge_rate": 450, "penalty_multiplier": 1.75})
        self.assertEqual(result["status"], "insufficient_data")


class TestContractImpactClassifier(unittest.TestCase):
    def test_misclass_always_contract_impacting(self):
        finding = {"type": "misclass"}
        result = classify_contract_impact(finding, [finding])
        self.assertTrue(result["contract_impacting"])

    def test_single_md_penalty_not_contract_impacting(self):
        finding = {"type": "md-penalty", "meter_id": "M999"}
        result = classify_contract_impact(finding, [finding])
        self.assertFalse(result["contract_impacting"])

    def test_recurring_md_penalty_is_contract_impacting(self):
        findings = [{"type": "md-penalty"}, {"type": "md-penalty"}]
        result = classify_contract_impact(findings[0], findings)
        self.assertTrue(result["contract_impacting"])
        self.assertIn("2 md-penalty", result["reason"])

    def test_pf_penalty_never_contract_impacting_even_if_repeated(self):
        findings = [{"type": "pf-penalty"}, {"type": "pf-penalty"}, {"type": "pf-penalty"}]
        result = classify_contract_impact(findings[0], findings)
        self.assertFalse(result["contract_impacting"])

    def test_math_error_not_contract_impacting(self):
        finding = {"type": "math-error"}
        result = classify_contract_impact(finding, [finding])
        self.assertFalse(result["contract_impacting"])


class TestClaimWorkflow(unittest.TestCase):
    def test_is_material_requires_positive_overcharge_above_threshold(self):
        self.assertTrue(is_material({"rupee_impact": 4125.0}))
        self.assertFalse(is_material({"rupee_impact": 1500.0}))  # below threshold
        self.assertFalse(is_material({"rupee_impact": -11812.5}))  # undercharge, not a refund case
        self.assertFalse(is_material({"rupee_impact": None}))

    def test_normal_lifecycle(self):
        status = "draft"
        status = submit_for_approval(status)
        self.assertEqual(status, "pending_approval")
        status = approve_claim(status, "Priya Sharma, Facilities Manager")
        self.assertEqual(status, "approved_ready_to_file")
        status = file_claim(status)
        self.assertEqual(status, "filed")
        status = mark_under_review(status)
        self.assertEqual(status, "under_discom_review")
        status = mark_credited(status, 4125.0)
        self.assertEqual(status, "credited")

    def test_denial_path(self):
        status = submit_for_approval("draft")
        status = deny_claim(status)
        self.assertEqual(status, "denied")

    def test_cannot_skip_straight_from_draft_to_approved(self):
        with self.assertRaises(ValueError):
            approve_claim("draft", "Priya Sharma")

    def test_cannot_approve_without_a_named_approver_regardless_of_size(self):
        # This is THE guarantee: no claim, however large, auto-approves.
        status = submit_for_approval("draft")
        with self.assertRaises(ValueError):
            approve_claim(status, "")
        with self.assertRaises(ValueError):
            approve_claim(status, None)
        with self.assertRaises(ValueError):
            approve_claim(status, "   ")

    def test_cannot_double_submit(self):
        status = submit_for_approval("draft")
        with self.assertRaises(ValueError):
            submit_for_approval(status)

    def test_cannot_file_before_approval(self):
        with self.assertRaises(ValueError):
            file_claim("pending_approval")

    def test_cannot_credit_without_a_positive_amount(self):
        status = "under_discom_review"
        with self.assertRaises(ValueError):
            mark_credited(status, 0)
        with self.assertRaises(ValueError):
            mark_credited(status, None)


if __name__ == "__main__":
    unittest.main()
