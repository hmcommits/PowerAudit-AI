"""Feature #2 Step 5"""

import json
import sys
import re
from typing import Optional

# Minimum cosine similarity score from Vector node to trust the result
VECTOR_SCORE_THRESHOLD = 0.60


def _extract_discom_from_text(text: str) -> Optional[str]:
    """Detect which DISCOM a Vector doc refers to."""
    text_lower = text.lower()
    if "msedcl" in text_lower or "maharashtra" in text_lower:
        return "MSEDCL"
    if "tsspdcl" in text_lower or "telangana" in text_lower:
        return "TSSPDCL"
    if "bescom" in text_lower or "bangalore" in text_lower or "karnataka" in text_lower:
        return "BESCOM"
    return None


def _extract_clause_ref(text: str) -> str:
    """
    Try to pull a clause reference from the document text.
    e.g. 'Clause 7.2(b)' or 'Section 8.1'
    """
    patterns = [
        r"Clause\s+[\d\.]+\(?[a-z]?\)?",
        r"Section\s+[\d\.]+",
        r"Article\s+[\d\.]+",
        r"Para\s+[\d\.]+",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(0)
    return ""


def _extract_page_ref(metadata: dict) -> str:
    """Extract page number from Vector doc metadata if present."""
    for key in ("page", "page_number", "page_ref", "pg"):
        if key in metadata:
            return str(metadata[key])
    return ""


def _extract_tariff_year(text: str, metadata: dict) -> str:
    """Extract tariff year from text or metadata."""
    # Check metadata first
    for key in ("year", "tariff_year", "effective_year"):
        if key in metadata:
            return str(metadata[key])
    # Try pattern in text
    match = re.search(r"20\d{2}[-–]\d{2,4}", text)
    if match:
        return match.group(0)
    return ""


def _best_vector_match(
    vector_results: list[dict],
    finding_type: str,
    discom_id: str,
) -> Optional[dict]:
    """
    Select the highest-scoring Vector result that:
    1. Exceeds VECTOR_SCORE_THRESHOLD
    2. Mentions the correct DISCOM (or is generic)
    3. Is relevant to the finding_type keyword
    """
    keyword_map = {
        "MD_PENALTY":      ["maximum demand", "demand penalty", "md penalty", "excess demand"],
        "PF_PENALTY":      ["power factor", "pf penalty", "surcharge", "pf surcharge"],
        "TARIFF_MISMATCH": ["tariff", "schedule", "billing"],
    }
    keywords = keyword_map.get(finding_type, [])

    candidates = []
    for doc in vector_results:
        score    = doc.get("score", 0.0)
        text     = doc.get("text", "")
        metadata = doc.get("metadata", {})

        if score < VECTOR_SCORE_THRESHOLD:
            continue

        # Prefer docs that match the DISCOM
        doc_discom  = _extract_discom_from_text(text)
        discom_match = (doc_discom is None or doc_discom == discom_id)

        # Check keyword relevance
        text_lower  = text.lower()
        kw_match    = any(kw in text_lower for kw in keywords)

        if discom_match and kw_match:
            candidates.append({
                "score":    score,
                "text":     text,
                "metadata": metadata,
            })

    if not candidates:
        return None

    # Return highest scoring candidate
    return max(candidates, key=lambda x: x["score"])


def attach_citations(
    variances: list[dict],
    vector_results: list[dict],
    calculation: dict,
) -> list[dict]:
    """
    Enrich each variance with citation fields from Vector results
    or fall back to the calculator's built-in clause refs.
    """
    findings = []

    for variance in variances:
        finding_type = variance.get("finding_type", "UNKNOWN")
        discom_id    = variance.get("discom_id", "UNKNOWN")
        bill_id      = variance.get("bill_id", "UNKNOWN")
        month        = variance.get("month", "UNKNOWN")

        # Try to find a matching Vector doc
        best_doc = _best_vector_match(vector_results, finding_type, discom_id)

        if best_doc:
            text      = best_doc["text"]
            metadata  = best_doc["metadata"]
            clause_ref  = _extract_clause_ref(text) or variance.get("clause_ref", "")
            tariff_year = _extract_tariff_year(text, metadata)
            page_ref    = _extract_page_ref(metadata)

            # Build full reference string
            discom_from_doc = _extract_discom_from_text(text) or discom_id
            full_ref        = f"{discom_from_doc} Tariff Order {tariff_year}, {clause_ref}".strip(", ")

            citation = {
                "citation_clause_ref":  full_ref,
                "citation_clause_text": text[:500],   # cap at 500 chars for SQL
                "citation_discom":      discom_from_doc,
                "citation_tariff_year": tariff_year,
                "citation_page_ref":    page_ref,
                "citation_source":      "vector_search",
                "citation_score":       round(best_doc["score"], 4),
            }
        else:
            # Fallback: use the hardcoded clause ref from the calculator
            fallback_ref = variance.get("clause_ref", "")
            if not fallback_ref:
                if finding_type == "MD_PENALTY":
                    fallback_ref = calculation.get("md_clause_ref", "")
                elif finding_type == "PF_PENALTY":
                    fallback_ref = calculation.get("pf_clause_ref", "")

            citation = {
                "citation_clause_ref":  fallback_ref,
                "citation_clause_text": None,
                "citation_discom":      discom_id,
                "citation_tariff_year": calculation.get("tariff_year", ""),
                "citation_page_ref":    None,
                "citation_source":      "calculator_fallback",
                "citation_score":       None,
            }

        # Build full finding record (ready for RocketRide SQL write)
        finding_id = f"F-{bill_id}-{finding_type[:2]}-{month}"

        finding = {
            "finding_id":           finding_id,
            "bill_id":              bill_id,
            "site_id":              variance.get("site_id"),
            "month":                month,
            "finding_type":         finding_type,
            "variance_flag":        variance.get("variance_flag"),
            "billed_amount":        variance.get("billed_amount"),
            "recalculated_amount":  variance.get("recalculated_amount"),
            "rupee_impact":         variance.get("rupee_impact"),
            "formula_inputs":       variance.get("formula_inputs"),
            "formula_used":         variance.get("formula_used"),
            **citation,
        }
        findings.append(finding)

    return findings


def main():
    raw_input = sys.stdin.read().strip()
    try:
        payload = json.loads(raw_input)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON: {e}"}))
        sys.exit(1)

    variances      = payload.get("variances", [])
    vector_results = payload.get("vector_results", [])
    calculation    = payload.get("calculation", {})

    findings = attach_citations(variances, vector_results, calculation)
    print(json.dumps({"findings": findings, "count": len(findings)}, default=str))


if __name__ == "__main__":
    main()
