#!/usr/bin/env python3
"""Split a large PDF into parts next to the original (studi0 PDF-split assistant).

Usage: python split_pdf.py <input.pdf> <out_dir> [target_bytes]

Heuristic: the number of parts is ceil(file_bytes / target_bytes) (default
15 MB), and pages are distributed evenly, so every part lands in the ~10-20 MB
band for typical slide/textbook PDFs with roughly uniform page sizes. The
original is only ever read, never written. Parts are named <stem>_pNN.pdf in
<out_dir> and overwrite earlier parts of a previous split (idempotent).

Prints one line of JSON on success: {"parts": ["<absolute path>", ...]}
Exits 1 with a message on stderr on any failure.
"""

import json
import math
import os
import sys

TARGET_BYTES_DEFAULT = 15 * 1024 * 1024


def fail(message: str) -> "None":
    print(message, file=sys.stderr)
    sys.exit(1)


def main() -> None:
    if len(sys.argv) not in (3, 4):
        fail("usage: split_pdf.py <input.pdf> <out_dir> [target_bytes]")
    src, out_dir = sys.argv[1], sys.argv[2]
    target = int(sys.argv[3]) if len(sys.argv) == 4 else TARGET_BYTES_DEFAULT
    if target <= 0:
        fail("target_bytes must be positive")
    if not os.path.isfile(src):
        fail(f"input not found: {src}")

    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError:
        fail("pypdf is not installed — run: pip install pypdf")

    try:
        reader = PdfReader(src)
        total = len(reader.pages)
        if total == 0:
            fail("pdf has no pages")
        n_parts = max(1, math.ceil(os.path.getsize(src) / target))
        pages_per = max(1, math.ceil(total / n_parts))
        n_parts = math.ceil(total / pages_per)
        width = max(2, len(str(n_parts)))
        stem = os.path.splitext(os.path.basename(src))[0]
        parts = []
        for i in range(n_parts):
            writer = PdfWriter()
            for p in range(i * pages_per, min((i + 1) * pages_per, total)):
                writer.add_page(reader.pages[p])
            out = os.path.join(out_dir, f"{stem}_p{i + 1:0{width}d}.pdf")
            with open(out, "wb") as f:
                writer.write(f)
            parts.append(out)
    except SystemExit:
        raise
    except Exception as e:  # encrypted/corrupt pdfs, disk errors — report, never crash ugly
        fail(f"split failed: {e}")

    print(json.dumps({"parts": parts}))


if __name__ == "__main__":
    main()
