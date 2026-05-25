from __future__ import annotations

import re
from statistics import median
from typing import Any

import fitz
from fastapi import FastAPI, HTTPException
from google.cloud import storage
from pydantic import BaseModel


app = FastAPI(title="ReadWiseHub PDF Extractor")
storage_client = storage.Client()


class ExtractRequest(BaseModel):
    bucket: str
    storagePath: str
    maxBytes: int = 20 * 1024 * 1024
    renderPages: bool = False
    outputPrefix: str = ""
    renderDpi: int = 144
    maxRenderedPages: int = 250


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def is_page_marker(text: str) -> bool:
    return bool(re.match(r"^[-\s]*\d+\s+of\s+\d+[-\s]*$", text, re.I))


def is_heading(text: str, size: float, median_size: float, y: float) -> bool:
    if len(text) < 3 or len(text) > 140:
        return False
    if re.match(r"^(chapter|part|section|book|coda|end credits|opening credits)\b", text, re.I):
        return True
    if size >= median_size * 1.18 and y < 260:
        return True
    letters = re.sub(r"[^A-Za-z]", "", text)
    return len(letters) >= 6 and letters.upper() == letters and size >= median_size * 1.05


def merge_lines(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    paragraphs: list[dict[str, Any]] = []
    current: list[str] = []
    current_page = 0
    current_title = ""
    previous: dict[str, Any] | None = None

    def flush() -> None:
        nonlocal current, current_title, current_page
        text = clean_text(" ".join(current))
        if text:
            paragraphs.append(
                {
                    "page": current_page,
                    "title": current_title,
                    "text": text,
                }
            )
        current = []
        current_title = ""

    for line in lines:
        text = clean_text(line["text"])
        if not text or is_page_marker(text):
            continue

        if line["heading"]:
            flush()
            paragraphs.append({"page": line["page"], "title": text, "text": text})
            previous = line
            continue

        starts_new = False
        if previous is not None and current:
            vertical_gap = line["y0"] - previous["y1"]
            indent_jump = line["x0"] - previous["x0"]
            previous_text = clean_text(previous["text"])
            starts_new = (
                vertical_gap > max(8, line["size"] * 0.9)
                or indent_jump > 22
                or previous_text.endswith((".", "!", "?", ".”", "?”"))
            )

        if starts_new:
            flush()

        current.append(text)
        current_page = line["page"]
        previous = line

    flush()
    return paragraphs


def build_sections(paragraphs: list[dict[str, Any]], target_size: int = 1800) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    title = ""
    parts: list[str] = []
    start_page = 0

    def flush(end_page: int) -> None:
        nonlocal parts, title, start_page
        text = "\n\n".join(parts).strip()
        if not text:
            return
        sections.append(
            {
                "sectionIndex": len(sections),
                "title": title,
                "text": text,
                "textPreview": text[:300],
                "pageStart": start_page,
                "pageEnd": end_page,
            }
        )
        parts = []
        title = ""

    for paragraph in paragraphs:
        paragraph_title = paragraph["title"] if paragraph["title"] == paragraph["text"] else ""
        current_length = len("\n\n".join(parts))
        if parts and (paragraph_title or current_length + len(paragraph["text"]) > target_size):
            flush(paragraph["page"])
            start_page = paragraph["page"]
        if paragraph_title:
            title = paragraph_title
        parts.append(paragraph["text"])

    if paragraphs:
        flush(paragraphs[-1]["page"])

    return sections


def render_pdf_pages(
    document: fitz.Document,
    bucket_name: str,
    output_prefix: str,
    render_dpi: int,
    max_pages: int,
) -> list[dict[str, Any]]:
    if not output_prefix:
        return []

    safe_dpi = min(max(render_dpi, 96), 180)
    safe_max_pages = min(max(max_pages, 1), 300)
    bucket = storage_client.bucket(bucket_name)
    pages: list[dict[str, Any]] = []

    for page_index, page in enumerate(document[:safe_max_pages]):
        pix = page.get_pixmap(dpi=safe_dpi, colorspace=fitz.csRGB, alpha=False)
        image_bytes = pix.tobytes("jpg")
        storage_path = f"{output_prefix.rstrip('/')}/page-{page_index + 1:04d}.jpg"
        blob = bucket.blob(storage_path)
        blob.upload_from_string(image_bytes, content_type="image/jpeg")
        pages.append(
            {
                "pageNumber": page_index + 1,
                "storagePath": storage_path,
                "width": pix.width,
                "height": pix.height,
                "contentType": "image/jpeg",
                "sizeBytes": len(image_bytes),
                "renderDpi": safe_dpi,
            }
        )

    return pages


@app.post("/extract")
def extract_pdf(request: ExtractRequest) -> dict[str, Any]:
    blob = storage_client.bucket(request.bucket).blob(request.storagePath)
    if not blob.exists():
        raise HTTPException(status_code=404, detail="PDF was not found.")

    data = blob.download_as_bytes()
    if len(data) > request.maxBytes:
        raise HTTPException(status_code=413, detail="PDF exceeds maximum size.")

    document = fitz.open(stream=data, filetype="pdf")
    try:
        lines: list[dict[str, Any]] = []
        sizes: list[float] = []
        for page_index, page in enumerate(document):
            page_dict = page.get_text("dict", sort=True)
            height = float(page.rect.height)
            for block in page_dict.get("blocks", []):
                if block.get("type") != 0:
                    continue
                for line in block.get("lines", []):
                    spans = line.get("spans", [])
                    text = clean_text(" ".join(span.get("text", "") for span in spans))
                    if not text:
                        continue
                    size = max((float(span.get("size", 0)) for span in spans), default=0)
                    bbox = line.get("bbox", [0, 0, 0, 0])
                    if bbox[1] < 30 or bbox[3] > height - 30:
                        continue
                    sizes.append(size)
                    lines.append(
                        {
                            "page": page_index + 1,
                            "text": text,
                            "x0": float(bbox[0]),
                            "y0": float(bbox[1]),
                            "y1": float(bbox[3]),
                            "size": size,
                            "heading": False,
                        }
                    )

        median_size = median(sizes) if sizes else 10
        for line in lines:
            line["heading"] = is_heading(line["text"], line["size"], median_size, line["y0"])

        paragraphs = merge_lines(lines)
        sections = build_sections(paragraphs)
        text = "\n\n".join(paragraph["text"] for paragraph in paragraphs).strip()
        outline = [
            {"sectionIndex": section["sectionIndex"], "title": section["title"]}
            for section in sections
            if section["title"]
        ][:80]

        rendered_pages = (
            render_pdf_pages(
                document,
                request.bucket,
                request.outputPrefix,
                request.renderDpi,
                request.maxRenderedPages,
            )
            if request.renderPages
            else []
        )

        return {
            "ok": True,
            "text": text,
            "pageCount": document.page_count,
            "sections": sections,
            "outline": outline,
            "quality": "layout",
            "renderedPages": rendered_pages,
        }
    finally:
        document.close()
