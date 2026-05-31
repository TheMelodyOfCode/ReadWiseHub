from __future__ import annotations

import sys
from pathlib import Path
from statistics import median

import fitz

import main


def extract_page_text(pdf_path: Path, page_number: int) -> str:
    document = fitz.open(pdf_path)
    try:
        page = document[page_number - 1]
        lines: list[dict] = []
        sizes: list[float] = []
        page_dict = page.get_text("dict", sort=True)
        height = float(page.rect.height)
        width = float(page.rect.width)

        for block in page_dict.get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                spans = line.get("spans", [])
                text = main.clean_text(" ".join(span.get("text", "") for span in spans))
                if not text:
                    continue
                size = max((float(span.get("size", 0)) for span in spans), default=0)
                bbox = line.get("bbox", [0, 0, 0, 0])
                if bbox[1] < 30 or bbox[3] > height - 30:
                    continue
                sizes.append(size)
                lines.append(
                    {
                        "page": page_number,
                        "text": text,
                        "x0": float(bbox[0]),
                        "x1": float(bbox[2]),
                        "y0": float(bbox[1]),
                        "y1": float(bbox[3]),
                        "size": size,
                        "heading": False,
                    }
                )

        ordered = main.order_page_lines(lines, width)
        median_size = median(sizes) if sizes else 10
        for line in ordered:
            line["heading"] = main.is_heading(line["text"], line["size"], median_size, line["y0"])

        paragraphs = main.repair_paragraphs(main.merge_lines(ordered))
        return "\n\n".join(paragraph["text"] for paragraph in paragraphs)
    finally:
        document.close()


def assert_contains(text: str, expected: str) -> None:
    if expected not in text:
        raise AssertionError(f"Missing expected text: {expected!r}")


def main_cli() -> int:
    if len(sys.argv) != 2:
        print("Usage: python regression_elberfelder.py /path/to/elberfelder_1905.pdf", file=sys.stderr)
        return 2

    page_text = extract_page_text(Path(sys.argv[1]), 7)
    assert_contains(page_text, "Chapter 1")
    assert_contains(page_text, "1 Im Anfang schuf Gott die Himmel und die Erde.")
    assert_contains(page_text, "an der Ausdehnung des Himmels, um den")
    assert_contains(page_text, "\n\n15 und sie seien zu Lichtern")
    assert_contains(page_text, "\n\n18 und um zu herrschen")
    assert_contains(page_text, "\n\n21 Und Gott schuf die großen Seeungeheuer")

    print("Elberfelder extractor regression passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main_cli())
