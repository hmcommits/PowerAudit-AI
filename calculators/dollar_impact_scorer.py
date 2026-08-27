"""Feature 2, step 5: dollar-impact-scorer (Python, deterministic, zero LLM).

Turns a variance-detector finding into a rupee_impact + confidence pair
(Section 3's Finding fields).

Sign convention for rupee_impact: POSITIVE means the consumer was
OVERCHARGED (billed_amount > recalculated_amount - a dispute-worthy refund
opportunity); NEGATIVE means the consumer was UNDERCHARGED (the DISCOM
billed less than the recalculation says was actually due).

Stdlib-only - see bill_line_parser.py's docstring for why.
"""

# Each present flag lowers confidence by this much (floor 0.1) - a proxy for
# "how much of the input data was itself uncertain going into this finding".
CONFIDENCE_PENALTY_PER_FLAG = 0.15
MIN_CONFIDENCE = 0.1


def score_finding(variance, data_quality_flags=None):
    """variance: one dict from variance_detector.detect_variances().
    data_quality_flags: e.g. the Bill's own needs_review reasons, or
    "line item amount unparseable" - anything that should reduce confidence
    in this specific finding without invalidating it outright.

    Returns {"rupee_impact": float, "confidence": float} to merge into the
    Finding record alongside variance["type"] and variance["detail"].
    """
    rupee_impact = round(variance["billed_amount"] - variance["recalculated_amount"], 2)

    confidence = 1.0
    if data_quality_flags:
        confidence -= CONFIDENCE_PENALTY_PER_FLAG * len(data_quality_flags)
    confidence = max(MIN_CONFIDENCE, min(1.0, confidence))

    return {"rupee_impact": rupee_impact, "confidence": round(confidence, 2)}


def score_findings(variances, data_quality_flags=None):
    return [dict(v, **score_finding(v, data_quality_flags)) for v in variances]
