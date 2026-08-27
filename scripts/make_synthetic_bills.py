"""Generate 18 synthetic electricity bills for Feature 1 acceptance testing.

Mix of clean PDFs, degraded "photo" JPEGs (to genuinely exercise
image_cleanup + ocr), and deliberately corrupted bills covering the
failure modes bill-ingestion.pipe's downstream validation must catch.

Output goes to scripts/synthetic_bills/ (gitignored - generated fixtures,
regenerate any time with `python scripts/make_synthetic_bills.py`).
"""
import io
import os
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT_DIR = os.path.join(os.path.dirname(__file__), "synthetic_bills")
FONT_PATH = "C:/Windows/Fonts/arial.ttf"


def build_minimal_pdf(lines, page_size=(612, 792)):
    """Hand-rolled minimal single-page PDF with left-aligned text lines."""
    escaped = [ln.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)") for ln in lines]
    content_parts = ["BT /F1 11 Tf 40 740 Td"]
    for i, ln in enumerate(escaped):
        if i == 0:
            content_parts.append(f"({ln}) Tj")
        else:
            content_parts.append(f"0 -16 Td ({ln}) Tj")
    content_parts.append("ET")
    content_stream = " ".join(content_parts).encode("latin-1", errors="replace")

    objects = [
        b"1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj",
        b"2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj",
        (
            b"3 0 obj<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> "
            b"/MediaBox [0 0 %d %d] /Contents 4 0 R >>endobj" % page_size
        ),
        b"4 0 obj<< /Length " + str(len(content_stream)).encode() + b" >>stream\n" + content_stream + b"\nendstream endobj",
        b"5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj",
    ]
    pdf = b"%PDF-1.4\n"
    offsets = []
    for obj in objects:
        offsets.append(len(pdf))
        pdf += obj + b"\n"
    xref_start = len(pdf)
    pdf += b"xref\n0 " + str(len(objects) + 1).encode() + b"\n0000000000 65535 f \n"
    for off in offsets:
        pdf += ("%010d 00000 n \n" % off).encode()
    pdf += b"trailer<< /Size " + str(len(objects) + 1).encode() + b" /Root 1 0 R >>\nstartxref\n" + str(xref_start).encode() + b"\n%%EOF"
    return pdf


def build_photo_jpeg(lines, seed):
    """Render bill text onto a canvas and degrade it to simulate a phone photo."""
    rng = random.Random(seed)
    img = Image.new("L", (1000, 1300), color=245)
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT_PATH, 26)
    y = 60
    for ln in lines:
        draw.text((50, y), ln, fill=20, font=font)
        y += 42

    # Simulate phone-photo degradation: slight rotation, blur, noise, low-res JPEG.
    img = img.rotate(rng.uniform(-3, 3), expand=True, fillcolor=245)
    img = img.filter(ImageFilter.GaussianBlur(radius=rng.uniform(0.6, 1.4)))

    import numpy as np

    arr = np.array(img).astype(np.int16)
    noise = np.random.default_rng(seed).normal(0, 12, arr.shape).astype(np.int16)
    arr = np.clip(arr + noise, 0, 255).astype("uint8")
    img = Image.fromarray(arr).convert("RGB")

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=rng.randint(45, 65))
    return buf.getvalue()


def bill_lines(meter_number, discom, tariff_category, period_start, period_end,
                contract_demand, recorded_md, recorded_pf, line_items, total_due):
    lines = [
        f"{discom} - Electricity Bill",
        f"Meter Number: {meter_number}",
        f"Tariff Category: {tariff_category}",
        f"Billing Period: {period_start} to {period_end}",
        f"Contract Demand (kVA): {contract_demand}",
        f"Recorded Maximum Demand (kVA): {recorded_md}",
        f"Recorded Power Factor: {recorded_pf}",
        "Line Items:",
    ]
    for desc, amount in line_items:
        lines.append(f"  {desc}: Rs. {amount}")
    lines.append(f"Total Due: Rs. {total_due}")
    return lines


CLEAN_BILLS = [
    dict(meter_number="M001", discom="MSEDCL", tariff_category="HT-II Industrial",
         period_start="2026-06-01", period_end="2026-06-30", contract_demand=500,
         recorded_md=480, recorded_pf=0.97,
         line_items=[("Energy Charge", 412500), ("Demand Charge", 210000), ("FAC", 8200)],
         total_due=630700),
    dict(meter_number="M002", discom="MSEDCL", tariff_category="HT-I Commercial",
         period_start="2026-06-01", period_end="2026-06-30", contract_demand=300,
         recorded_md=340, recorded_pf=0.93,
         line_items=[("Energy Charge", 265000), ("Demand Charge", 156000), ("MD Penalty", 24500)],
         total_due=445500),
    dict(meter_number="M003", discom="TATA Power", tariff_category="HT Industrial",
         period_start="2026-07-01", period_end="2026-07-31", contract_demand=750,
         recorded_md=690, recorded_pf=0.98,
         line_items=[("Energy Charge", 590000), ("Demand Charge", 300000)],
         total_due=890000),
    dict(meter_number="M004", discom="BESCOM", tariff_category="HT-2 Industrial",
         period_start="2026-07-01", period_end="2026-07-31", contract_demand=1000,
         recorded_md=960, recorded_pf=0.91,
         line_items=[("Energy Charge", 812000), ("Demand Charge", 400000), ("PF Surcharge", 15400)],
         total_due=1227400),
    dict(meter_number="M005", discom="MSEDCL", tariff_category="HT-II Industrial",
         period_start="2026-06-01", period_end="2026-06-30", contract_demand=250,
         recorded_md=210, recorded_pf=0.99,
         line_items=[("Energy Charge", 190000), ("Demand Charge", 87500), ("PF Incentive", -4200)],
         total_due=273300),
    dict(meter_number="M006", discom="Adani Electricity", tariff_category="LT Commercial",
         period_start="2026-07-01", period_end="2026-07-31", contract_demand=120,
         recorded_md=118, recorded_pf=0.95,
         line_items=[("Energy Charge", 98000), ("Demand Charge", 36000)],
         total_due=134000),
    dict(meter_number="M007", discom="TATA Power", tariff_category="HT Industrial",
         period_start="2026-06-01", period_end="2026-06-30", contract_demand=600,
         recorded_md=615, recorded_pf=0.89,
         line_items=[("Energy Charge", 505000), ("Demand Charge", 264000), ("MD Penalty", 39375), ("PF Surcharge", 12100)],
         total_due=820475),
    dict(meter_number="M008", discom="BESCOM", tariff_category="HT-1 Commercial",
         period_start="2026-07-01", period_end="2026-07-31", contract_demand=400,
         recorded_md=375, recorded_pf=0.96,
         line_items=[("Energy Charge", 340000), ("Demand Charge", 168000)],
         total_due=508000),
]

PHOTO_BILLS = [
    dict(meter_number="M009", discom="MSEDCL", tariff_category="HT-II Industrial",
         period_start="2026-07-01", period_end="2026-07-31", contract_demand=350,
         recorded_md=330, recorded_pf=0.94,
         line_items=[("Energy Charge", 288000), ("Demand Charge", 147000)],
         total_due=435000),
    dict(meter_number="M010", discom="TATA Power", tariff_category="HT Industrial",
         period_start="2026-06-01", period_end="2026-06-30", contract_demand=800,
         recorded_md=845, recorded_pf=0.90,
         line_items=[("Energy Charge", 690000), ("Demand Charge", 336000), ("MD Penalty", 39375)],
         total_due=1065375),
    dict(meter_number="M011", discom="BESCOM", tariff_category="HT-2 Industrial",
         period_start="2026-07-01", period_end="2026-07-31", contract_demand=550,
         recorded_md=520, recorded_pf=0.97,
         line_items=[("Energy Charge", 470000), ("Demand Charge", 231000)],
         total_due=701000),
    dict(meter_number="M012", discom="Adani Electricity", tariff_category="LT Commercial",
         period_start="2026-06-01", period_end="2026-06-30", contract_demand=150,
         recorded_md=140, recorded_pf=0.98,
         line_items=[("Energy Charge", 121000), ("Demand Charge", 45000)],
         total_due=166000),
]


def write_pdf(name, fields):
    lines = bill_lines(**fields)
    pdf = build_minimal_pdf(lines)
    path = os.path.join(OUT_DIR, name)
    with open(path, "wb") as f:
        f.write(pdf)
    return path


def write_jpeg(name, fields, seed):
    lines = bill_lines(**fields)
    jpeg = build_photo_jpeg(lines, seed)
    path = os.path.join(OUT_DIR, name)
    with open(path, "wb") as f:
        f.write(jpeg)
    return path


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    made = []

    for i, fields in enumerate(CLEAN_BILLS, start=1):
        made.append(write_pdf(f"clean_{i:02d}_{fields['meter_number']}.pdf", fields))

    for i, fields in enumerate(PHOTO_BILLS, start=1):
        made.append(write_jpeg(f"photo_{i:02d}_{fields['meter_number']}.jpg", fields, seed=1000 + i))

    # Deliberately corrupted bills - each exercises one failure mode the
    # post-extraction Python validation (Feature 1's "Schema Validate" step)
    # must catch and flag as needs_review.
    corrupt = []

    negative_md = dict(CLEAN_BILLS[0], meter_number="M001")
    negative_md.update(recorded_md=-45, period_start="2026-08-01", period_end="2026-08-31")
    corrupt.append(("corrupt_negative_md.pdf", negative_md))

    pf_over_one = dict(CLEAN_BILLS[1], meter_number="M002")
    pf_over_one.update(recorded_pf=1.35, period_start="2026-08-01", period_end="2026-08-31")
    corrupt.append(("corrupt_pf_over_one.pdf", pf_over_one))

    missing_pf_fields = bill_lines(
        meter_number="M003", discom="TATA Power", tariff_category="HT Industrial",
        period_start="2026-08-01", period_end="2026-08-31", contract_demand=750,
        recorded_md=700, recorded_pf="",
        line_items=[("Energy Charge", 600000)], total_due=600000,
    )
    missing_pf_fields = [ln for ln in missing_pf_fields if "Power Factor" not in ln]
    with open(os.path.join(OUT_DIR, "corrupt_missing_pf.pdf"), "wb") as f:
        f.write(build_minimal_pdf(missing_pf_fields))
    made.append(os.path.join(OUT_DIR, "corrupt_missing_pf.pdf"))

    bad_dates = dict(CLEAN_BILLS[3], meter_number="M004")
    bad_dates.update(period_start="2026-08-31", period_end="2026-08-01")
    corrupt.append(("corrupt_period_reversed.pdf", bad_dates))

    unknown_meter = dict(CLEAN_BILLS[4], meter_number="M999")
    unknown_meter.update(period_start="2026-08-01", period_end="2026-08-31")
    corrupt.append(("corrupt_unknown_meter.pdf", unknown_meter))

    for name, fields in corrupt:
        made.append(write_pdf(name, fields))

    # Near-blank/garbled bill: almost no extractable content.
    blank_lines = ["###!!! SCAN ERROR !!!###", "(no legible content)"]
    with open(os.path.join(OUT_DIR, "corrupt_blank.pdf"), "wb") as f:
        f.write(build_minimal_pdf(blank_lines))
    made.append(os.path.join(OUT_DIR, "corrupt_blank.pdf"))

    print(f"Generated {len(made)} synthetic bills in {OUT_DIR}")
    for p in made:
        print(" -", os.path.basename(p))


if __name__ == "__main__":
    main()
