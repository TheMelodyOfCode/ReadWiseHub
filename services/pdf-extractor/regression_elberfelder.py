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

    pdf_path = Path(sys.argv[1])
    page_7_text = extract_page_text(pdf_path, 7)
    assert_contains(page_7_text, "Chapter 1")
    assert_contains(page_7_text, "1 Im Anfang schuf Gott die Himmel und die Erde.")
    assert_contains(page_7_text, "schwebte über den Wassern")
    assert_contains(page_7_text, "an der Ausdehnung des Himmels, um den")
    assert_contains(page_7_text, "\n\n15 und sie seien zu Lichtern")
    assert_contains(page_7_text, "\n\n18 und um zu herrschen")
    assert_contains(page_7_text, "\n\n21 Und Gott schuf die großen Seeungeheuer")
    assert_contains(page_7_text, "von all seinem Werk, das Gott geschaffen")
    assert_contains(page_7_text, "nicht regnen lassen auf die Erde")
    assert_contains(page_7_text, "und befeuchtete die ganze Oberfläche des Erdbodens")

    page_8_text = extract_page_text(pdf_path, 8)
    assert_contains(page_8_text, "den Erdboden")
    assert_contains(page_8_text, "achthundertfünfzehn Jahre")

    page_9_text = extract_page_text(pdf_path, 9)
    assert_contains(page_9_text, "Wasserflut über die Erde, um alles Fleisch")
    assert_contains(page_9_text, "in die Arche gehen, du und deine Söhne")
    assert_contains(page_9_text, "Männliches und ein Weibliches von allem")

    page_11_text = extract_page_text(pdf_path, 11)
    assert_contains(page_11_text, "Abram zog nach Ägypten hinab, um sich daselbst aufzuhalten")

    page_30_text = extract_page_text(pdf_path, 30)
    assert_contains(page_30_text, "So spricht Jehova, der Gott Israels: Laß mein Volk ziehen")

    page_56_text = extract_page_text(pdf_path, 56)
    assert_contains(page_56_text, "keinerlei Dienstarbeit")

    print("Elberfelder extractor regression passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main_cli())
