"""Feature 4, step 2: contract-impact classifier (Python, deterministic,
zero LLM).

Flags whether resolving a Finding's claim would require altering a LIVE
contract term - the Meter's tariff_category or contract_demand_kva - as
opposed to simply correcting a one-off billing calculation.

RULES:
1. type == "misclass": ALWAYS contract-impacting. Section 3's 'misclass'
   Finding type means the bill was charged under the wrong tariff category
   - correcting that necessarily means updating what's on file for the
   meter, not just refunding a miscalculated amount.
2. type == "md-penalty": contract-impacting only if it's a RECURRING
   pattern - RECURRING_MD_PENALTY_THRESHOLD or more md-penalty Findings for
   the same meter. A single miscalculated MD penalty is a one-off billing
   correction; a repeated pattern suggests the Contract Demand itself is
   undersized for actual usage and should be renegotiated (matching
   Feature 3's cd-breach-risk recommendation to raise Contract Demand) -
   which IS a contract change, not a refund.
3. Everything else (pf-penalty, math-error, unbilled, double-billed,
   stale-rate): never contract-impacting on its own - corrections to these
   don't require changing the underlying agreement.

Stdlib-only - see bill_line_parser.py's docstring for why.
"""

RECURRING_MD_PENALTY_THRESHOLD = 2


def classify_contract_impact(finding, meter_findings):
    """finding: the Finding dict under dispute (needs "type"). meter_findings:
    ALL Finding dicts for the same meter, including this one - used to
    detect the recurring md-penalty pattern.

    Returns {"contract_impacting": bool, "reason": str}.
    """
    finding_type = finding["type"]

    if finding_type == "misclass":
        return {
            "contract_impacting": True,
            "reason": "misclass findings always require correcting the meter's tariff category on file",
        }

    if finding_type == "md-penalty":
        md_penalty_count = sum(1 for f in meter_findings if f["type"] == "md-penalty")
        if md_penalty_count >= RECURRING_MD_PENALTY_THRESHOLD:
            return {
                "contract_impacting": True,
                "reason": (
                    f"{md_penalty_count} md-penalty findings for this meter - a recurring pattern "
                    "suggests Contract Demand should be renegotiated, not just this bill corrected"
                ),
            }
        return {
            "contract_impacting": False,
            "reason": "a single md-penalty finding is a one-off billing correction, not a contract change",
        }

    return {
        "contract_impacting": False,
        "reason": f"{finding_type} findings are billing corrections, not contract changes",
    }
