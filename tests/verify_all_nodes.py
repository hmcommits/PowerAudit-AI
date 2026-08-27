"""verify_all_nodes.py  —  PowerAudit-AI Node Verification Script"""

import json
import subprocess
import sys
import os

# Ensure nodes/ is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "nodes"))

FIXTURES_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "sample_bills.json")
NODES_DIR     = os.path.join(os.path.dirname(__file__), "..", "nodes")
ENV           = {**os.environ, "PYTHONIOENCODING": "utf-8"}

PASS = "\033[92mPASSED\033[0m"
FAIL = "\033[91mFAILED\033[0m"
SKIP = "\033[93mSKIPPED\033[0m"


def run_node(script_name: str, stdin_data: dict) -> dict:
    r = subprocess.run(
        [sys.executable, os.path.join(NODES_DIR, script_name)],
        input=json.dumps(stdin_data),
        capture_output=True,
        text=True,
        env=ENV,
    )
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError(f"{script_name} stderr: {r.stderr.strip()}")
    return json.loads(r.stdout)


def check(label: str, condition: bool, detail: str = ""):
    status = PASS if condition else FAIL
    print(f"  [{status}] {label}")
    if not condition:
        print(f"           ^ {detail}")
    return condition


def run_fixture(bill: dict, expected: dict) -> bool:
    label = bill.get("bill_id", "?")
    discom = bill.get("discom_id", "?")
    print(f"\n{'─'*60}")
    print(f"  Fixture: {label}  |  DISCOM: {discom}")
    print(f"{'─'*60}")
    ok = True

    # Step 1: bill_line_parser
    try:
        line_items = run_node("bill_line_parser.py", bill)
        ok &= check(
            "bill_line_parser: contract_demand_kva parsed",
            line_items.get("contract_demand_kva") == bill.get("contract_demand_kva"),
            f"got {line_items.get('contract_demand_kva')}",
        )
        ok &= check(
            "bill_line_parser: power_factor normalised (0.0-1.0 range)",
            0.0 <= (line_items.get("power_factor") or 0) <= 1.0,
            f"got {line_items.get('power_factor')}",
        )
    except Exception as e:
        print(f"  [{FAIL}] bill_line_parser crashed: {e}")
        return False

    # Step 2: tariff_penalty_calculator
    try:
        calculation = run_node("tariff_penalty_calculator.py", line_items)
        ok &= check(
            f"tariff_penalty_calculator: md_status = {expected['md_status']}",
            calculation.get("md_status") == expected["md_status"],
            f"got {calculation.get('md_status')}",
        )
        if expected.get("md_penalty") is not None:
            got_md = calculation.get("recalculated_md_penalty", 0) or 0
            ok &= check(
                f"tariff_penalty_calculator: md_penalty ≈ Rs.{expected['md_penalty']}",
                abs(got_md - expected["md_penalty"]) <= 2.0,
                f"got Rs.{got_md}",
            )
        ok &= check(
            f"tariff_penalty_calculator: pf_status = {expected['pf_status']}",
            calculation.get("pf_status") == expected["pf_status"],
            f"got {calculation.get('pf_status')}",
        )
        ok &= check(
            "tariff_penalty_calculator: no errors",
            calculation.get("errors", []) == [],
            str(calculation.get("errors")),
        )
    except Exception as e:
        print(f"  [{FAIL}] tariff_penalty_calculator crashed: {e}")
        return False

    # Step 3: variance_detector
    try:
        payload   = {"line_items": line_items, "calculation": calculation}
        vd_out    = run_node("variance_detector.py", payload)
        variances = vd_out.get("variances", [])
        md_var    = next((v for v in variances if v["finding_type"] == "MD_PENALTY"), None)
        pf_var    = next((v for v in variances if v["finding_type"] == "PF_PENALTY"), None)

        ok &= check(
            f"variance_detector: MD_PENALTY flag = {expected.get('md_flag','any')}",
            md_var is not None and md_var.get("variance_flag") == expected.get("md_flag"),
            f"got {md_var.get('variance_flag') if md_var else 'None'}",
        )
        ok &= check(
            "variance_detector: rupee_impact is numeric",
            md_var is not None and isinstance(md_var.get("rupee_impact"), (int, float)),
            str(md_var),
        )
    except Exception as e:
        print(f"  [{FAIL}] variance_detector crashed: {e}")
        return False

    # Step 4: dollar_impact_scorer
    try:
        payload2 = {
            "variances":   variances,
            "line_items":  line_items,
            "calculation": calculation,
        }
        scored = run_node("dollar_impact_scorer.py", payload2)
        ok &= check(
            "dollar_impact_scorer: confidence_score > 0",
            (scored.get("confidence_score") or 0) > 0,
            f"got {scored.get('confidence_score')}",
        )
        ok &= check(
            f"dollar_impact_scorer: materiality_flag = {expected.get('materiality')}",
            scored.get("materiality_flag") == expected.get("materiality"),
            f"got {scored.get('materiality_flag')}",
        )
        print(f"\n  SUMMARY  total_rupee_impact=Rs.{scored.get('total_rupee_impact')}  "
              f"confidence={scored.get('confidence_score')}%  "
              f"material={'YES' if scored.get('materiality_flag') else 'NO'}")
    except Exception as e:
        print(f"  [{FAIL}] dollar_impact_scorer crashed: {e}")
        return False

    # Step 5: citation_attacher (no Vector, uses fallback)
    try:
        payload3 = {
            "variances":      variances,
            "vector_results": [],           # no Vector store in local test → fallback mode
            "calculation":    calculation,
        }
        ca_out   = run_node("citation_attacher.py", payload3)
        findings = ca_out.get("findings", [])
        ok &= check(
            "citation_attacher: produces finding records",
            len(findings) >= 2,
            f"got {len(findings)} findings",
        )
        ok &= check(
            "citation_attacher: each finding has citation_clause_ref",
            all(f.get("citation_clause_ref") for f in findings),
            str([f.get("citation_clause_ref") for f in findings]),
        )
    except Exception as e:
        print(f"  [{FAIL}] citation_attacher crashed: {e}")
        return False

    return ok


# FIXTURE EXPECTATIONS
FIXTURES_EXPECTED = [
    {
        # Fixture A: MSEDCL, MD excess, PF penalty
        "md_status":  "EXCESS",
        "md_penalty": 40_000.0,
        "pf_status":  "PENALTY",
        "md_flag":    "OVERCHARGED",
        "materiality": True,
    },
    {
        # Fixture B: TSSPDCL, MD normal, PF incentive (no penalty billed → match)
        "md_status":  "WITHIN_NORMAL",
        "md_penalty": None,            # no penalty expected
        "pf_status":  "INCENTIVE",
        "md_flag":    "MATCH",
        "materiality": False,
    },
    {
        # Fixture C: BESCOM, MD minimum demand, PF at exact threshold
        # DISCOM billed md_penalty=0 but formula says min demand = Rs.69,000
        # -> DISCOM UNDERCHARGED (didn't collect minimum demand charge)
        # materiality=False because total_rupee_impact only sums OVERCHARGED variances
        "md_status":  "MINIMUM_DEMAND",
        "md_penalty": 69_000.0,
        "pf_status":  "NORMAL",
        "md_flag":    "UNDERCHARGED",
        "materiality": False,
    },
]


def main():
    print("\n" + "=" * 60)
    print("  PowerAudit-AI — Node Verification Suite")
    print("  All 5 Python nodes, 3 DISCOM fixtures, no RocketRide needed")
    print("=" * 60)

    with open(FIXTURES_PATH, encoding="utf-8") as f:
        bills = json.load(f)

    bills = [{k: v for k, v in b.items() if not k.startswith("_comment")} for b in bills]

    all_passed = True
    for bill, expected in zip(bills, FIXTURES_EXPECTED):
        passed = run_fixture(bill, expected)
        all_passed = all_passed and passed

    print("\n" + "=" * 60)
    if all_passed:
        print(f"  [{PASS}] ALL CHECKS PASSED  — Python layer is fully operational.")
    else:
        print(f"  [{FAIL}] SOME CHECKS FAILED — review output above.")
    print("=" * 60)
    print()
    print("  NEXT STEPS TO VERIFY (needs RocketRide):")
    print("  1. Open RocketRide Local canvas")
    print("  2. Load: pipelines/01_bill_ingestion.pipe")
    print("  3. POST to /ingest-bill with a sample bill text")
    print("  4. Confirm 'bills' table row appears in RocketRide SQL")
    print("  5. Use returned bill_id to POST /detect-penalties")
    print("  6. Confirm 'findings' table row appears with rupee_impact > 0")
    print()

    sys.exit(0 if all_passed else 1)


if __name__ == "__main__":
    main()
