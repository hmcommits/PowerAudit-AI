"""Feature #1 Step 1 (Cleanup)"""

import base64
import io
import json
import os
import sys


def process_pdf(file_bytes: bytes, filename: str) -> dict:
    """Extract text from PDF using pdfminer."""
    try:
        from pdfminer.high_level import extract_text_to_fp
        from pdfminer.layout import LAParams

        out = io.StringIO()
        extract_text_to_fp(
            io.BytesIO(file_bytes),
            out,
            laparams=LAParams(),
            output_type="text",
            codec="utf-8",
        )
        text = out.getvalue().strip()
        pages = text.count("\f") + 1  # form-feed = page break

        quality_notes = ""
        if len(text) < 100:
            quality_notes = "WARNING: Very little text extracted — PDF may be image-only (scanned). Consider re-ingesting as image."
        else:
            quality_notes = f"PDF text extracted cleanly ({len(text)} chars, ~{pages} page(s))."

        return {
            "output_type":   "pdf_text",
            "content":       text,
            "quality_notes": quality_notes,
            "source_type":   "pdf",
            "filename":      filename,
            "pages":         pages,
        }
    except Exception as e:
        return {
            "output_type":   "pdf_text",
            "content":       "",
            "quality_notes": f"PDF extraction failed: {e}. Will need manual OCR.",
            "source_type":   "pdf",
            "filename":      filename,
            "pages":         0,
        }


def process_image(file_bytes: bytes, filename: str) -> dict:
    """
    Deskew + denoise + normalise an image using Pillow.
    Returns base64-encoded cleaned PNG for downstream OCR.
    """
    try:
        from PIL import Image, ImageEnhance, ImageFilter, ImageOps

        img = Image.open(io.BytesIO(file_bytes))
        original_mode = img.mode
        quality_notes_parts = []

        # Convert to RGB
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")

        # Rotate if EXIF orientation present
        try:
            from PIL import ImageOps as _io
            img = _io.exif_transpose(img)
            quality_notes_parts.append("EXIF orientation corrected")
        except Exception:
            pass

        # Convert to greyscale for bill text
        img_grey = img.convert("L")

        # Normalise histogram (auto-levels)
        img_norm = ImageOps.autocontrast(img_grey, cutoff=2)
        quality_notes_parts.append("Contrast normalised")

        # Mild sharpening (helps OCR on blurry photos)
        enhancer = ImageEnhance.Sharpness(img_norm)
        img_sharp = enhancer.enhance(1.5)
        quality_notes_parts.append("Sharpness enhanced (1.5x)")

        # Median filter to reduce noise
        img_clean = img_sharp.filter(ImageFilter.MedianFilter(size=3))
        quality_notes_parts.append("Noise reduced (median filter)")

        # Check for likely low-quality
        import numpy as np
        arr = list(img_grey.getdata())
        # Crude blur estimate: low std = blurry
        mean = sum(arr) / len(arr)
        variance = sum((p - mean) ** 2 for p in arr) / len(arr)
        std = variance ** 0.5
        if std < 30:
            quality_notes_parts.append("WARNING: Image appears blurry (low contrast variance). OCR confidence may be low.")
        elif std > 120:
            quality_notes_parts.append("WARNING: Image may be over-exposed or have heavy noise.")

        # Encode cleaned image as base64 PNG
        buf = io.BytesIO()
        img_clean.save(buf, format="PNG", optimize=True)
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")

        return {
            "output_type":   "image_b64",
            "content":       b64,
            "quality_notes": " | ".join(quality_notes_parts),
            "source_type":   "image",
            "filename":      filename,
            "pages":         1,
        }

    except Exception as e:
        # Fallback: return raw bytes as-is
        b64 = base64.b64encode(file_bytes).decode("ascii")
        return {
            "output_type":   "image_b64",
            "content":       b64,
            "quality_notes": f"Cleanup failed ({e}); using raw input.",
            "source_type":   "image",
            "filename":      filename,
            "pages":         1,
        }


def detect_file_type(filename: str, file_bytes: bytes) -> str:
    """Detect file type from extension and magic bytes."""
    ext = os.path.splitext(filename)[-1].lower()
    if ext == ".pdf":
        return "pdf"
    if ext in (".jpg", ".jpeg", ".png", ".tiff", ".tif", ".webp", ".bmp"):
        return "image"
    # Magic bytes fallback
    if file_bytes[:4] == b"%PDF":
        return "pdf"
    return "image"  # default


def main():
    raw = json.loads(sys.stdin.read())
    filename = raw.get("filename", "unknown")
    file_path = raw.get("file_path", "")
    file_b64 = raw.get("file_b64", "")

    # Load file bytes
    if file_path and os.path.exists(file_path):
        with open(file_path, "rb") as f:
            file_bytes = f.read()
    elif file_b64:
        file_bytes = base64.b64decode(file_b64)
    else:
        result = {
            "output_type":   "error",
            "content":       "",
            "quality_notes": "No file_path or file_b64 provided.",
            "source_type":   "unknown",
            "filename":      filename,
            "pages":         0,
        }
        print(json.dumps(result))
        return

    file_type = detect_file_type(filename, file_bytes)

    if file_type == "pdf":
        result = process_pdf(file_bytes, filename)
    else:
        result = process_image(file_bytes, filename)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
