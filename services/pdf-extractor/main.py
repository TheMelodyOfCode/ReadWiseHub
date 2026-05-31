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


def detect_column_bands(lines: list[dict[str, Any]], page_width: float) -> list[tuple[float, float]]:
    body_lines = [
        line
        for line in lines
        if float(line.get("x1", 0)) > float(line.get("x0", 0))
        and float(line.get("x1", 0)) - float(line.get("x0", 0)) < page_width * 0.72
        and len(clean_text(str(line.get("text") or ""))) >= 8
    ]
    if len(body_lines) < 18 or page_width <= 0:
        return []

    start_bands = detect_column_bands_from_starts(body_lines, page_width)
    if start_bands:
        return start_bands

    bucket_count = 96
    buckets = [0] * bucket_count
    for line in body_lines:
        start = max(0, min(bucket_count - 1, int(float(line["x0"]) / page_width * bucket_count)))
        end = max(start, min(bucket_count - 1, int(float(line["x1"]) / page_width * bucket_count)))
        for bucket_index in range(start, end + 1):
            buckets[bucket_index] += 1

    threshold = max(2, int(len(body_lines) * 0.045))
    raw_segments: list[tuple[int, int]] = []
    start: int | None = None
    for index, count in enumerate(buckets):
        if count >= threshold and start is None:
            start = index
        elif count < threshold and start is not None:
            raw_segments.append((start, index - 1))
            start = None
    if start is not None:
        raw_segments.append((start, bucket_count - 1))

    merged_segments: list[tuple[int, int]] = []
    for segment_start, segment_end in raw_segments:
        if not merged_segments or segment_start - merged_segments[-1][1] > 2:
            merged_segments.append((segment_start, segment_end))
        else:
            previous_start, _ = merged_segments[-1]
            merged_segments[-1] = (previous_start, segment_end)

    bands: list[tuple[float, float]] = []
    for segment_start, segment_end in merged_segments:
        x0 = segment_start / bucket_count * page_width
        x1 = (segment_end + 1) / bucket_count * page_width
        if x1 - x0 >= page_width * 0.08:
            bands.append((x0, x1))

    if 2 <= len(bands) <= 4:
        return bands

    return detect_column_bands_from_starts(body_lines, page_width)


def detect_column_bands_from_starts(
    lines: list[dict[str, Any]], page_width: float
) -> list[tuple[float, float]]:
    clusters: list[dict[str, float]] = []
    for line in sorted(lines, key=lambda item: float(item.get("x0", 0))):
        x0 = float(line.get("x0", 0))
        matched = False
        for cluster in clusters:
            if abs(x0 - cluster["center"]) <= max(18, page_width * 0.035):
                count = cluster["count"] + 1
                cluster["center"] = ((cluster["center"] * cluster["count"]) + x0) / count
                cluster["count"] = count
                cluster["min"] = min(cluster["min"], x0)
                cluster["max"] = max(cluster["max"], float(line.get("x1", x0)))
                matched = True
                break
        if not matched:
            clusters.append({"center": x0, "count": 1, "min": x0, "max": float(line.get("x1", x0))})

    significant = [
        cluster
        for cluster in clusters
        if cluster["count"] >= max(6, len(lines) * 0.12)
    ]
    significant.sort(key=lambda cluster: cluster["center"])
    if not 2 <= len(significant) <= 4:
        return []

    bands: list[tuple[float, float]] = []
    for index, cluster in enumerate(significant):
        left = (
            0
            if index == 0
            else (significant[index - 1]["max"] + cluster["center"]) / 2
        )
        right = (
            page_width
            if index == len(significant) - 1
            else (cluster["max"] + significant[index + 1]["center"]) / 2
        )
        bands.append((left, right))

    return bands


def order_page_lines(lines: list[dict[str, Any]], page_width: float) -> list[dict[str, Any]]:
    bands = detect_column_bands(lines, page_width)
    if len(bands) < 2:
        for line in lines:
            line["columnIndex"] = 0
            line["columnCount"] = 1
        return sorted(lines, key=lambda line: (line["y0"], line["x0"]))

    ordered: list[dict[str, Any]] = []
    for line in lines:
        x0 = float(line.get("x0", 0))
        x1 = float(line.get("x1", x0))
        center = (x0 + x1) / 2
        column_index = min(
            range(len(bands)),
            key=lambda index: abs(center - ((bands[index][0] + bands[index][1]) / 2)),
        )
        line["columnIndex"] = column_index
        line["columnCount"] = len(bands)
        ordered.append(line)

    return sorted(ordered, key=lambda line: (line["columnIndex"], line["y0"], line["x0"]))


GERMAN_GLUE_REPLACEMENTS = [
    ("anderAusdehnungdesHimmels", "an der Ausdehnung des Himmels"),
    ("AusdehnunginmittenderWasser", "Ausdehnung inmitten der Wasser"),
    ("AusdehnungdesHimmels", "Ausdehnung des Himmels"),
    ("GartenEdenhinaus", "Garten Eden hinaus"),
    ("GartenEden", "Garten Eden"),
    ("Erdbodenzu", "Erdboden zu"),
    ("nichtregnenlassen", "nicht regnen lassen"),
    ("seinWeib", "sein Weib"),
    ("Eva,sein", "Eva, sein"),
    ("welcheunterhalb", "welche unterhalb"),
    ("undkein", "und kein"),
    ("undsie", "und sie"),
    ("umden", "um den"),
    ("warüber", "war über"),
    ("wirdüber", "wird über"),
    ("herrschenüber", "herrschen über"),
    ("tröstenüber", "trösten über"),
]


def repair_extracted_text_spacing(text: str) -> str:
    repaired = clean_text(text)
    if not repaired:
        return ""

    for source, replacement in GERMAN_GLUE_REPLACEMENTS:
        repaired = repaired.replace(source, replacement)

    repaired = re.sub(r"([,;:!?])(?=\S)", r"\1 ", repaired)
    repaired = re.sub(r"\b(an|auf|aus|bei|bis|in|mit|nach|um|von|vor|zu)(der|die|das|den|dem|des|ein|eine|einem|einen)\b", r"\1 \2", repaired, flags=re.I)
    repaired = re.sub(r"\b(und|oder|aber)(der|die|das|den|dem|des|ein|eine|einem|einen|kein|keine|sie|er|es|ich|wir)\b", r"\1 \2", repaired, flags=re.I)
    repaired = re.sub(r"\s+", " ", repaired).strip()
    return repaired


def split_bible_paragraphs(paragraph: dict[str, Any]) -> list[dict[str, Any]]:
    text = repair_extracted_text_spacing(str(paragraph.get("text") or ""))
    if not text:
        return []

    text = re.sub(r"\s+(Chapter\s+\d{1,3})\b", r"\n\n\1", text, flags=re.I)
    text = re.sub(r"([,.;!?])\s+(\d{1,3})\s+(?=[a-zäöüß])", r"\1\n\n\2 ", text)
    text = re.sub(r"(\D)\s+(\d{1,3})\s+Und\b", r"\1\n\n\2 Und", text)

    parts = [clean_text(part) for part in re.split(r"\n{2,}", text) if clean_text(part)]
    if len(parts) <= 1:
        repaired = dict(paragraph)
        repaired["text"] = text
        if repaired.get("title") and str(repaired.get("title")) != str(paragraph.get("text")):
            repaired["title"] = repair_extracted_text_spacing(str(repaired.get("title") or ""))
        return [repaired]

    split_paragraphs: list[dict[str, Any]] = []
    for index, part in enumerate(parts):
        split_part = dict(paragraph)
        split_part["text"] = part
        split_part["title"] = part if re.match(r"^Chapter\s+\d{1,3}$", part, re.I) else ""
        if index > 0:
            split_part["pageStart"] = paragraph.get("pageEnd") or paragraph.get("pageStart") or paragraph.get("page") or 0
        split_paragraphs.append(split_part)

    return split_paragraphs


def repair_paragraphs(paragraphs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    repaired: list[dict[str, Any]] = []
    for paragraph in paragraphs:
        repaired.extend(split_bible_paragraphs(paragraph))
    return repaired


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
            same_baseline = abs(line["y0"] - previous.get("y0", line["y0"])) <= max(2, line["size"] * 0.35)
            starts_new = (
                line["page"] != previous["page"]
                or (
                    not same_baseline
                    and (
                        vertical_gap < -max(8, line["size"] * 0.9)
                        or vertical_gap > max(8, line["size"] * 0.9)
                        or indent_jump > 22
                        or previous_text.endswith((".", "!", "?", ".”", "?”"))
                    )
                )
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


def parse_toc_entries(page_texts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    pattern = re.compile(r"([0-9]?\s?[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß ]{1,40})\s+\.{4,}\s+(\d{1,4})")

    for page in page_texts[:20]:
        text = str(page.get("text") or "")
        if not is_toc_text(text):
            continue

        for title, page_number in pattern.findall(text):
            clean_title = clean_text(title)
            if len(clean_title) < 3:
                continue
            entries.append(
                {
                    "title": clean_title,
                    "pageStart": int(page_number),
                    "tocPage": int(page.get("pageNumber") or 0),
                }
            )

    seen: set[tuple[str, int]] = set()
    unique_entries: list[dict[str, Any]] = []
    for entry in entries:
        key = (entry["title"].lower(), entry["pageStart"])
        if key in seen:
            continue
        seen.add(key)
        unique_entries.append(entry)

    unique_entries.sort(key=lambda entry: entry["pageStart"])
    for index, entry in enumerate(unique_entries):
        next_entry = unique_entries[index + 1] if index + 1 < len(unique_entries) else None
        if next_entry:
            entry["pageEnd"] = max(entry["pageStart"], int(next_entry["pageStart"]) - 1)

    return unique_entries[:120]


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
            width = float(page.rect.width)
            page_lines: list[dict[str, Any]] = []
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
                    page_lines.append(
                        {
                            "page": page_index + 1,
                            "text": text,
                            "x0": float(bbox[0]),
                            "x1": float(bbox[2]),
                            "y0": float(bbox[1]),
                            "y1": float(bbox[3]),
                            "size": size,
                            "heading": False,
                        }
                    )
            lines.extend(order_page_lines(page_lines, width))

        median_size = median(sizes) if sizes else 10
        for line in lines:
            line["heading"] = is_heading(line["text"], line["size"], median_size, line["y0"])

        paragraphs = repair_paragraphs(merge_lines(lines))
        sections = build_sections(paragraphs)
        page_texts = build_page_texts(paragraphs, document.page_count)
        toc_entries = parse_toc_entries(page_texts)
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
            "tocEntries": toc_entries,
            "outline": outline,
            "quality": "layout",
            "renderedPages": rendered_pages,
            "inlineMedia": inline_media,
        }
    finally:
        document.close()
