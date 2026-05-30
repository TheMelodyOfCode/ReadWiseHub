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
    maxRenderedPages: int = 600


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
    current_page_start = 0
    current_page_end = 0
    current_title = ""
    previous: dict[str, Any] | None = None

    def flush() -> None:
        nonlocal current, current_title, current_page_start, current_page_end
        text = clean_text(" ".join(current))
        if text:
            paragraphs.append(
                {
                    "page": current_page_start,
                    "pageStart": current_page_start,
                    "pageEnd": current_page_end or current_page_start,
                    "title": current_title,
                    "text": text,
                }
            )
        current = []
        current_title = ""
        current_page_start = 0
        current_page_end = 0

    for line in lines:
        text = clean_text(line["text"])
        if not text or is_page_marker(text):
            continue

        if line["heading"]:
            flush()
            paragraphs.append(
                {
                    "page": line["page"],
                    "pageStart": line["page"],
                    "pageEnd": line["page"],
                    "title": text,
                    "text": text,
                }
            )
            previous = line
            continue

        starts_new = False
        if previous is not None and current:
            vertical_gap = line["y0"] - previous["y1"]
            indent_jump = line["x0"] - previous["x0"]
            previous_text = clean_text(previous["text"])
            starts_new = (
                line["page"] != previous["page"]
                or vertical_gap < -max(8, line["size"] * 0.9)
                or vertical_gap > max(8, line["size"] * 0.9)
                or indent_jump > 22
                or previous_text.endswith((".", "!", "?", ".”", "?”"))
            )

        if starts_new:
            flush()

        if not current:
            current_page_start = line["page"]
        current.append(text)
        current_page_end = line["page"]
        previous = line

    flush()
    return paragraphs


def build_sections(paragraphs: list[dict[str, Any]], target_size: int = 1800) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    title = ""
    parts: list[str] = []
    start_page = 0
    end_page = 0

    def flush() -> None:
        nonlocal parts, title, start_page, end_page
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
                "pageEnd": end_page or start_page,
            }
        )
        parts = []
        title = ""
        start_page = 0
        end_page = 0

    for paragraph in paragraphs:
        paragraph_title = paragraph["title"] if paragraph["title"] == paragraph["text"] else ""
        current_length = len("\n\n".join(parts))
        if parts and (paragraph_title or current_length + len(paragraph["text"]) > target_size):
            flush()
        if not parts:
            start_page = int(paragraph.get("pageStart") or paragraph.get("page") or 0)
        if paragraph_title:
            title = paragraph_title
        parts.append(paragraph["text"])
        end_page = int(paragraph.get("pageEnd") or paragraph.get("page") or start_page)

    if paragraphs:
        flush()

    return sections


def is_toc_text(text: str) -> bool:
    lower = text.lower()
    dot_leader_count = len(re.findall(r"\.{4,}\s*\d+", text))
    return (
        "table of contents" in lower
        or "inhaltsverzeichnis" in lower
        or dot_leader_count >= 5
    )


def build_page_texts(paragraphs: list[dict[str, Any]], page_count: int) -> list[dict[str, Any]]:
    by_page: dict[int, list[str]] = {}
    for paragraph in paragraphs:
        page_number = int(paragraph.get("pageStart") or paragraph.get("page") or 0)
        text = clean_text(str(paragraph.get("text") or ""))
        if page_number <= 0 or not text:
            continue
        by_page.setdefault(page_number, []).append(text)

    page_texts: list[dict[str, Any]] = []
    for page_number in range(1, page_count + 1):
        text = "\n\n".join(by_page.get(page_number, [])).strip()
        if not text:
            continue
        page_texts.append(
            {
                "pageNumber": page_number,
                "text": text,
                "textPreview": text[:300],
                "isTocPage": is_toc_text(text),
            }
        )

    return page_texts


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
    safe_max_pages = min(max(max_pages, 1), 600)
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


def section_for_page(sections: list[dict[str, Any]], page_number: int) -> int:
    for section in sections:
        start = int(section.get("pageStart") or 0)
        end = int(section.get("pageEnd") or start)
        if start <= page_number <= end:
            return int(section.get("sectionIndex") or 0)
    return 0


def extract_inline_media(
    document: fitz.Document,
    bucket_name: str,
    output_prefix: str,
    render_dpi: int,
    sections: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if not output_prefix:
        return []

    safe_dpi = min(max(render_dpi, 96), 180)
    bucket = storage_client.bucket(bucket_name)
    media: list[dict[str, Any]] = []

    for page_index, page in enumerate(document):
        page_number = page_index + 1
        page_area = float(page.rect.width * page.rect.height)
        page_dict = page.get_text("dict", sort=True)
        media_on_page = 0

        for block in page_dict.get("blocks", []):
            if block.get("type") != 1:
                continue

            bbox = block.get("bbox", [0, 0, 0, 0])
            rect = fitz.Rect(float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3]))
            if rect.is_empty or rect.width < 48 or rect.height < 48:
                continue
            if page_area > 0 and rect.get_area() / page_area < 0.01:
                continue

            media_on_page += 1
            storage_path = (
                f"{output_prefix.rstrip('/')}/inline/"
                f"page-{page_number:04d}-image-{media_on_page:02d}.jpg"
            )
            pix = page.get_pixmap(dpi=safe_dpi, colorspace=fitz.csRGB, alpha=False, clip=rect)
            image_bytes = pix.tobytes("jpg")
            blob = bucket.blob(storage_path)
            blob.upload_from_string(image_bytes, content_type="image/jpeg")
            media.append(
                {
                    "pageNumber": page_number,
                    "sectionIndex": section_for_page(sections, page_number),
                    "mediaIndex": media_on_page,
                    "kind": "image",
                    "storagePath": storage_path,
                    "width": pix.width,
                    "height": pix.height,
                    "contentType": "image/jpeg",
                    "sizeBytes": len(image_bytes),
                    "renderDpi": safe_dpi,
                    "bbox": [rect.x0, rect.y0, rect.x1, rect.y1],
                    "confidence": "image_block",
                }
            )

            if media_on_page >= 8:
                break

    return media[:500]


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
        page_texts = build_page_texts(paragraphs, document.page_count)
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
        inline_media = (
            extract_inline_media(
                document,
                request.bucket,
                request.outputPrefix,
                request.renderDpi,
                sections,
            )
            if request.renderPages
            else []
        )

        return {
            "ok": True,
            "text": text,
            "pageCount": document.page_count,
            "sections": sections,
            "pageTexts": page_texts,
            "outline": outline,
            "quality": "layout",
            "renderedPages": rendered_pages,
            "inlineMedia": inline_media,
        }
    finally:
        document.close()
