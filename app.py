"""app.py  —  PowerAudit-AI Local Demo Server"""

import base64
import io
import json
import os
import sqlite3
import subprocess
import sys
import uuid
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_from_directory

# paths
BASE    = Path(__file__).parent
NODES   = BASE / "nodes"
DB      = BASE / "poweraudit.db"
UPLOADS = BASE / "uploads"
UPLOADS.mkdir(exist_ok=True)
ENV     = {**os.environ, "PYTHONIOENCODING": "utf-8"}

# Load .env (if present)
try:
    from dotenv import load_dotenv
    load_dotenv(BASE / ".env")
except ImportError:
    pass  # python-dotenv not installed; fall back to OS env vars

# API keys & model config
GOOGLE_API_KEY      = os.environ.get("GOOGLE_API_KEY", "").strip()
GEMINI_OCR_MODEL    = os.environ.get("GEMINI_OCR_MODEL", "gemini-1.5-pro")
GEMINI_REASON_MODEL = os.environ.get("GEMINI_REASONING_MODEL", "gemini-1.5-pro")
LIVE_OCR            = bool(GOOGLE_API_KEY)          # True → Gemini; False → local simulation

if LIVE_OCR:
    print(f"[PowerAudit] 🔑 GOOGLE_API_KEY detected — OCR mode: Gemini ({GEMINI_OCR_MODEL})")
else:
    print("[PowerAudit] ⚙️  No GOOGLE_API_KEY — OCR mode: local simulation (regex)")

app = Flask(__name__, template_folder="ui/templates", static_folder="ui/static")
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024  # 25 MB

ALLOWED_EXTENSIONS = {"jpg", "jpeg", "png", "tiff", "tif", "webp", "bmp", "pdf"}


#  DATABASE  (SQLite, mirrors the SQL schema structure)
def get_db():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS sites (
            site_id TEXT PRIMARY KEY, site_name TEXT, city TEXT,
            provider_id TEXT, provider_name TEXT, discom_id TEXT, state TEXT
        );
        CREATE TABLE IF NOT EXISTS bills (
            bill_id TEXT PRIMARY KEY, site_id TEXT, month TEXT,
            meter_number TEXT, tariff_category TEXT,
            contract_demand_kva REAL, recorded_max_demand_kva REAL,
            power_factor REAL, units_consumed_kwh REAL,
            energy_charges REAL, md_penalty_billed REAL, pf_penalty_billed REAL,
            fixed_charges REAL, taxes_and_duties REAL, total_due REAL,
            amount_paid REAL, outstanding_amount REAL,
            payment_status TEXT, provider_name TEXT, discom_id TEXT,
            confidence_map TEXT, needs_review INTEGER DEFAULT 0,
            review_flags TEXT,
            -- Feature #1: file ingestion metadata
            source_file TEXT,
            source_type TEXT,
            ocr_raw_text TEXT,
            quality_notes TEXT,
            extraction_model TEXT,
            file_path TEXT,
            reviewed INTEGER DEFAULT 0,
            reviewed_by TEXT,
            review_notes TEXT,
            created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS findings (
            finding_id TEXT PRIMARY KEY, bill_id TEXT, site_id TEXT, month TEXT,
            finding_type TEXT, variance_flag TEXT,
            billed_amount REAL, recalculated_amount REAL, rupee_impact REAL,
            formula_inputs TEXT, formula_used TEXT,
            confidence_score REAL, confidence_breakdown TEXT,
            citation_clause_ref TEXT, citation_clause_text TEXT,
            citation_discom TEXT, citation_tariff_year TEXT,
            citation_source TEXT, created_at TEXT
        );
        INSERT OR IGNORE INTO sites VALUES
          ('S101','Gurgaon Office','Gurgaon','P101','Tata Power','MSEDCL','Maharashtra'),
          ('S102','Delhi Warehouse','Delhi','P102','Adani Electricity','MSEDCL','Maharashtra'),
          ('S103','Noida Branch','Noida','P103','BSES Rajdhani','MSEDCL','Maharashtra'),
          ('S104','Mumbai Office','Mumbai','P104','Torrent Power','MSEDCL','Maharashtra'),
          ('S105','Bangalore Hub','Bangalore','P105','CESC Limited','BESCOM','Karnataka'),
          ('S106','Chennai Center','Chennai','P106','Reliance Energy','TSSPDCL','Telangana'),
          ('S107','Hyderabad Unit','Hyderabad','P107','NTPC Utility','TSSPDCL','Telangana'),
          ('S108','Pune Facility','Pune','P108','Green Energy Corp','MSEDCL','Maharashtra'),
          ('S109','Kolkata Office','Kolkata','P109','State Power Board','BESCOM','Karnataka'),
          ('S110','Ahmedabad Plant','Ahmedabad','P110','Metro Electric','MSEDCL','Maharashtra');
    """)
    conn.commit()
    conn.close()

#  FILE PROCESSING  (local OCR simulation via bill_cleanup.py)
ALLOWED = {"jpg", "jpeg", "png", "tiff", "tif", "webp", "bmp", "pdf"}

def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[-1].lower() in ALLOWED


def extract_text_from_file(file_path: Path, filename: str) -> dict:
    """
    Run bill_cleanup.py on the uploaded file.
    Returns cleanup node output: { output_type, content, quality_notes, source_type, pages }
    """
    payload = {
        "file_path": str(file_path),
        "filename":  filename,
    }
    result = subprocess.run(
        [sys.executable, str(NODES / "bill_cleanup.py")],
        input=json.dumps(payload),
        capture_output=True, text=True, env=ENV,
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError(f"bill_cleanup.py error: {result.stderr.strip()[:300]}")
    return json.loads(result.stdout)


def simulate_ocr_extraction(cleanup_out: dict, discom_hint: str = "") -> dict:
    """
    Local OCR simulation for when no Gemini API is available.
    For PDFs with clean text: parse the text directly.
    For images: generate realistic placeholder fields with lower confidence
    (in production this would call gemini-1.5-pro vision).
    """
    source_type  = cleanup_out.get("source_type", "unknown")
    content      = cleanup_out.get("content", "")
    quality_notes = cleanup_out.get("quality_notes", "")

    if source_type == "pdf" and len(content) > 50:
        # For a PDF with real text, try simple pattern-based extraction
        import re
        raw_text = content

        def find_amount(text, keywords):
            for kw in keywords:
                m = re.search(rf"{kw}[^\n]{{0,30}}[Rs.\s]+(\d+[,\d]*\.?\d*)", text, re.I)
                if m:
                    val = m.group(1).replace(",", "")
                    try: return float(val), 0.88
                    except: pass
            return None, 0.5

        def find_number(text, keywords):
            for kw in keywords:
                m = re.search(rf"{kw}[^\n]{{0,20}}[:\s]+(\d+\.?\d*)", text, re.I)
                if m:
                    try: return float(m.group(1)), 0.85
                    except: pass
            return None, 0.5

        cd,  cd_conf  = find_number(raw_text, ["contract demand", "sanctioned demand", "CD"])
        md,  md_conf  = find_number(raw_text, ["maximum demand", "max demand", "MD recorded"])
        pf,  pf_conf  = find_number(raw_text, ["power factor", "PF"])
        ec,  ec_conf  = find_amount(raw_text, ["energy charge", "units charge"])
        total, t_conf = find_amount(raw_text, ["total amount", "amount payable", "net payable", "total due"])

        extracted = {
            "contract_demand_kva":     cd,
            "recorded_max_demand_kva": md,
            "power_factor":            pf if pf and pf <= 1.0 else None,
            "energy_charges":          ec,
            "total_due":               total,
            "md_penalty_billed":       0.0,
            "pf_penalty_billed":       0.0,
        }
        confidence_map = {
            "contract_demand_kva":     cd_conf,
            "recorded_max_demand_kva": md_conf,
            "power_factor":            pf_conf,
            "energy_charges":          ec_conf,
            "total_due":               t_conf,
            "md_penalty_billed":       0.85,
            "pf_penalty_billed":       0.85,
        }
    else:
        # Image mode: all fields are "extracted" with medium-low confidence
        # In production, Gemini Vision would do this properly
        extracted = {
            "contract_demand_kva":     None,
            "recorded_max_demand_kva": None,
            "power_factor":            None,
            "energy_charges":          None,
            "total_due":               None,
            "md_penalty_billed":       None,
            "pf_penalty_billed":       None,
        }
        confidence_map = {k: 0.0 for k in extracted}
        quality_notes += " | LOCAL MODE: Gemini Vision not called; all fields need manual review."

    return {
        "extracted":      extracted,
        "confidence_map": confidence_map,
        "raw_text":       content if source_type == "pdf" else "[image — OCR via Gemini in production]",
        "quality_notes":  quality_notes,
        "source_type":    source_type,
    }



def run_node(script: str, stdin_data: dict) -> dict:
    """Pipe JSON into a node script, return parsed output."""
    result = subprocess.run(
        [sys.executable, str(NODES / script)],
        input=json.dumps(stdin_data),
        capture_output=True, text=True, env=ENV,
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError(f"{script} error: {result.stderr.strip()[:400]}")
    return json.loads(result.stdout)


#  PIPELINE 1 — BILL INGESTION (JSON structured input)
def run_pipeline_1(bill_data: dict, source_file: str = "", source_type: str = "json",
                   file_path: str = "", quality_notes: str = "", ocr_raw_text: str = "") -> dict:
    """Simulate pipeline 01_bill_ingestion."""

    line_items = run_node("bill_line_parser.py", bill_data)

    CRITICAL      = ["contract_demand_kva", "recorded_max_demand_kva", "power_factor", "energy_charges"]
    confidence_map = bill_data.get("confidence_map", {})
    needs_review   = False
    review_flags   = {}
    for field in CRITICAL:
        val  = line_items.get(field)
        conf = confidence_map.get(field, 1.0)
        if val is None or val == 0:
            needs_review = True
            review_flags[field] = "NULL or zero"
        elif conf < 0.80:
            needs_review = True
            review_flags[field] = f"Low confidence: {conf:.0%}"

    now = datetime.utcnow().isoformat()
    conn = get_db()
    conn.execute("""
        INSERT OR REPLACE INTO bills (
            bill_id, site_id, month, meter_number, tariff_category,
            contract_demand_kva, recorded_max_demand_kva, power_factor,
            units_consumed_kwh, energy_charges, md_penalty_billed, pf_penalty_billed,
            fixed_charges, taxes_and_duties, total_due, amount_paid, outstanding_amount,
            payment_status, provider_name, discom_id,
            confidence_map, needs_review, review_flags,
            source_file, source_type, file_path, quality_notes, ocr_raw_text,
            extraction_model, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, (
        bill_data.get("bill_id"),
        bill_data.get("site_id"),
        bill_data.get("month"),
        line_items.get("meter_number"),
        line_items.get("tariff_category"),
        line_items.get("contract_demand_kva"),
        line_items.get("recorded_max_demand_kva"),
        line_items.get("power_factor"),
        line_items.get("units_consumed_kwh"),
        line_items.get("energy_charges"),
        line_items.get("md_penalty_billed"),
        line_items.get("pf_penalty_billed"),
        line_items.get("fixed_charges"),
        line_items.get("taxes_and_duties"),
        line_items.get("total_due"),
        bill_data.get("amount_paid"),
        bill_data.get("outstanding_amount"),
        bill_data.get("payment_status"),
        bill_data.get("provider_name"),
        bill_data.get("discom_id"),
        json.dumps(confidence_map),
        1 if needs_review else 0,
        json.dumps(review_flags),
        source_file,
        source_type,
        file_path,
        quality_notes,
        ocr_raw_text,
        "gemini-1.5-pro",
        now,
    ))
    conn.commit()
    conn.close()

    return {
        "status":       "success",
        "bill_id":      bill_data.get("bill_id"),
        "needs_review": needs_review,
        "review_flags": review_flags,
        "source_file":  source_file,
        "source_type":  source_type,
        "quality_notes": quality_notes,
    }


#  PIPELINE 2 — PENALTY DETECTION
def run_pipeline_2(bill_id: str) -> dict:
    """Simulate pipeline 02_penalty_detection for a given bill_id."""

    # Fetch bill from DB
    conn = get_db()
    row = conn.execute(
        "SELECT b.*, s.discom_id as s_discom_id FROM bills b "
        "LEFT JOIN sites s ON b.site_id = s.site_id WHERE b.bill_id = ?",
        (bill_id,)
    ).fetchone()
    conn.close()

    if not row:
        raise ValueError(f"Bill {bill_id} not found in database")

    bill = dict(row)
    bill["discom_id"] = bill.get("s_discom_id") or bill.get("discom_id")

    # Step 1: bill_line_parser
    line_items = run_node("bill_line_parser.py", bill)

    # Step 2: tariff_penalty_calculator
    calculation = run_node("tariff_penalty_calculator.py", line_items)

    # Step 3: variance_detector
    vd_out    = run_node("variance_detector.py", {"line_items": line_items, "calculation": calculation})
    variances = vd_out.get("variances", [])

    # Step 4: dollar_impact_scorer
    scored = run_node("dollar_impact_scorer.py", {
        "variances":   variances,
        "line_items":  line_items,
        "calculation": calculation,
    })

    # Step 5: citation_attacher (no Vector in local mode → fallback refs)
    ca_out   = run_node("citation_attacher.py", {
        "variances":      variances,
        "vector_results": [],
        "calculation":    calculation,
    })
    findings = ca_out.get("findings", [])

    # Write findings to DB
    now  = datetime.utcnow().isoformat()
    conn = get_db()
    for f in findings:
        conn.execute("""
            INSERT OR REPLACE INTO findings (
                finding_id, bill_id, site_id, month,
                finding_type, variance_flag,
                billed_amount, recalculated_amount, rupee_impact,
                formula_inputs, formula_used,
                confidence_score, confidence_breakdown,
                citation_clause_ref, citation_clause_text,
                citation_discom, citation_tariff_year,
                citation_source, created_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            f.get("finding_id"),
            bill_id,
            bill.get("site_id"),
            bill.get("month"),
            f.get("finding_type"),
            f.get("variance_flag"),
            f.get("billed_amount"),
            f.get("recalculated_amount"),
            f.get("rupee_impact"),
            json.dumps(f.get("formula_inputs")),
            f.get("formula_used"),
            scored.get("confidence_score"),
            json.dumps(scored.get("confidence_breakdown")),
            f.get("citation_clause_ref"),
            f.get("citation_clause_text"),
            f.get("citation_discom"),
            f.get("citation_tariff_year"),
            f.get("citation_source"),
            now,
        ))
    conn.commit()
    conn.close()

    return {
        "status": "success",
        "bill_id": bill_id,
        "findings_count": len(findings),
        "total_rupee_impact": scored.get("total_rupee_impact"),
        "confidence_score": scored.get("confidence_score"),
        "materiality_flag": scored.get("materiality_flag"),
        "breakdown": scored.get("breakdown"),
        "findings": findings,
    }


#  BATCH RUNNER — process all fixtures at once
def run_batch():
    fixtures_path = BASE / "tests" / "fixtures" / "sample_bills.json"
    with open(fixtures_path, encoding="utf-8") as f:
        bills = json.load(f)

    results = []
    for bill in bills:
        bill = {k: v for k, v in bill.items() if not k.startswith("_comment")}
        try:
            p1 = run_pipeline_1(bill)
            p2 = run_pipeline_2(bill["bill_id"])
            results.append({"bill_id": bill["bill_id"], "pipeline_1": p1, "pipeline_2": p2})
        except Exception as e:
            results.append({"bill_id": bill.get("bill_id"), "error": str(e)})
    return results


#  API ROUTES
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/ingest-bill", methods=["POST"])
def ingest_bill():
    try:
        data = request.get_json(force=True)
        result = run_pipeline_1(data)
        # Auto-trigger penalty detection
        penalty_result = run_pipeline_2(data["bill_id"])
        return jsonify({**result, "penalty_detection": penalty_result})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/detect-penalties/<bill_id>", methods=["POST", "GET"])
def detect_penalties(bill_id):
    try:
        return jsonify(run_pipeline_2(bill_id))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/upload-bill", methods=["POST"])
def upload_bill():
    """Endpoint for Feature #1: Smart Bill Reading."""
    if "file" not in request.files:
        return jsonify({"error": "No file part"}), 400
    
    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No selected file"}), 400

    if file and allowed_file(file.filename):
        # 1. Save uploaded file to disk temporarily
        ext = file.filename.rsplit(".", 1)[-1].lower()
        bill_id = f"bill_{uuid.uuid4().hex[:8]}"
        filename = f"{bill_id}.{ext}"
        file_path = UPLOADS / filename
        file.save(file_path)

        try:
            # 2. Cleanup & Deskew (Feature #1 Step 1)
            cleanup_out = extract_text_from_file(file_path, file.filename)
            
            # 3. OCR & Extraction (Feature #1 Step 2 & 3)
            # (Simulated locally since Gemini API requires keys)
            ocr_out = simulate_ocr_extraction(cleanup_out)
            
            # 4. Prepare data for Schema Validation & DB write
            bill_data = {
                "bill_id": bill_id,
                "site_id": "S101", # Default site for local testing
                "month": datetime.utcnow().strftime("%B %Y"),
                "provider_name": "Unknown",
                "payment_status": "Pending",
                "amount_paid": 0.0,
                "outstanding_amount": ocr_out["extracted"].get("total_due", 0.0),
                "discom_id": "MSEDCL",
                **ocr_out["extracted"],
                "confidence_map": ocr_out["confidence_map"]
            }

            # 5. Schema Validate & Write to DB (Feature #1 Step 4 & 5)
            result = run_pipeline_1(
                bill_data=bill_data,
                source_file=file.filename,
                source_type=ocr_out["source_type"],
                file_path=str(file_path),
                quality_notes=ocr_out["quality_notes"],
                ocr_raw_text=ocr_out["raw_text"]
            )
            
            return jsonify(result)
            
        except Exception as e:
            return jsonify({"error": str(e)}), 500
            
    return jsonify({"error": "File type not allowed"}), 400


@app.route("/api/review-queue")
def get_review_queue():
    """Fetch bills that have needs_review = 1"""
    conn = get_db()
    rows = conn.execute("SELECT * FROM bills WHERE needs_review=1 AND reviewed=0 ORDER BY created_at DESC").fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/submit-review/<bill_id>", methods=["POST"])
def submit_review(bill_id):
    """Save manual corrections for a flagged bill."""
    data = request.json
    if not data:
        return jsonify({"error": "No data provided"}), 400
        
    updates = []
    values = []
    
    # Allow updating these specific fields
    allowed_fields = [
        "contract_demand_kva", "recorded_max_demand_kva", "power_factor", 
        "energy_charges", "total_due", "meter_number", "tariff_category", "discom_id"
    ]
    
    for k, v in data.items():
        if k in allowed_fields:
            updates.append(f"{k} = ?")
            values.append(v)
            
    if not updates:
        return jsonify({"error": "No valid fields to update"}), 400
        
    updates.append("needs_review = 0")
    updates.append("reviewed = 1")
    updates.append("review_notes = ?")
    values.append("Manually reviewed via UI")
    
    values.append(bill_id)
    
    conn = get_db()
    conn.execute(f"UPDATE bills SET {', '.join(updates)} WHERE bill_id = ?", values)
    conn.commit()
    conn.close()
    
    # After review is done, trigger pipeline 2 automatically
    run_pipeline_2(bill_id)
    
    return jsonify({"status": "success", "message": "Bill updated and pipeline 2 triggered."})


@app.route("/api/run-batch", methods=["POST"])
def batch():
    try:
        return jsonify({"results": run_batch()})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/bills")
def get_bills():
    conn = get_db()
    rows = conn.execute("SELECT * FROM bills ORDER BY created_at DESC").fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/bills/<bill_id>")
def get_bill(bill_id):
    """Fetch a single bill by ID (used by Review Queue side-by-side panel)."""
    conn = get_db()
    row = conn.execute("SELECT * FROM bills WHERE bill_id = ?", (bill_id,)).fetchone()
    conn.close()
    if not row:
        return jsonify({"error": f"Bill {bill_id} not found"}), 404
    return jsonify(dict(row))


@app.route("/api/bills/lookup")
def lookup_bill():
    """
    Lookup bills by consumer / meter number.
    GET /api/bills/lookup?consumer_no=MH-GGN-001
    Returns the most recent matching bill + its findings.
    """
    consumer_no = request.args.get("consumer_no", "").strip()
    if not consumer_no:
        return jsonify({"error": "consumer_no query param required"}), 400

    conn = get_db()
    # Search by meter_number (consumer no) — most recent first
    rows = conn.execute(
        "SELECT b.*, s.provider_name AS site_provider FROM bills b "
        "LEFT JOIN sites s ON b.site_id = s.site_id "
        "WHERE b.meter_number LIKE ? ORDER BY b.created_at DESC",
        (f"%{consumer_no}%",)
    ).fetchall()

    if not rows:
        conn.close()
        return jsonify({"found": False, "consumer_no": consumer_no, "bills": []}), 200

    bills = [dict(r) for r in rows]
    # For the most recent bill, also fetch findings
    latest_bill_id = bills[0]["bill_id"]
    findings = conn.execute(
        "SELECT * FROM findings WHERE bill_id = ? ORDER BY created_at DESC",
        (latest_bill_id,)
    ).fetchall()
    conn.close()

    return jsonify({
        "found": True,
        "consumer_no": consumer_no,
        "bills": bills,
        "latest_bill": bills[0],
        "findings": [dict(f) for f in findings],
    })


@app.route("/api/findings")
def get_findings():
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM findings ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/findings/overcharged")
def get_overcharged():
    conn = get_db()
    rows = conn.execute(
        "SELECT f.*, b.provider_name, b.total_due FROM findings f "
        "JOIN bills b ON f.bill_id = b.bill_id "
        "WHERE f.variance_flag = 'OVERCHARGED' AND f.rupee_impact > 0 "
        "ORDER BY f.rupee_impact DESC"
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/sites")
def get_sites():
    conn = get_db()
    rows = conn.execute("SELECT * FROM sites").fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/stats")
def get_stats():
    conn = get_db()
    stats = {
        "total_bills":          conn.execute("SELECT COUNT(*) FROM bills").fetchone()[0],
        "bills_needs_review":   conn.execute("SELECT COUNT(*) FROM bills WHERE needs_review=1").fetchone()[0],
        "total_findings":       conn.execute("SELECT COUNT(*) FROM findings").fetchone()[0],
        "overcharged_count":    conn.execute("SELECT COUNT(*) FROM findings WHERE variance_flag='OVERCHARGED'").fetchone()[0],
        "total_rupee_impact":   conn.execute("SELECT COALESCE(SUM(rupee_impact),0) FROM findings WHERE variance_flag='OVERCHARGED'").fetchone()[0],
        "avg_confidence":       conn.execute("SELECT ROUND(AVG(confidence_score),1) FROM findings").fetchone()[0],
    }
    conn.close()
    return jsonify(stats)


# Static fallback
@app.route("/static/<path:filename>")
def static_files(filename):
    return send_from_directory(BASE / "ui" / "static", filename)


#  STARTUP
if __name__ == "__main__":
    init_db()
    print("\n" + "="*55)
    print("  PowerAudit-AI  —  Local Demo Server")
    print("="*55)
    print("  Dashboard:  http://localhost:5000")
    print("  API:        http://localhost:5000/api/stats")
    print("  Batch run:  POST http://localhost:5000/api/run-batch")
    print("="*55 + "\n")
    app.run(debug=False, host="0.0.0.0", port=5000)
