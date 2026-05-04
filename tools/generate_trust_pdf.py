#!/usr/bin/env python3
"""
Generate a PDF from the CoBolt Trust Architecture Markdown file.

Uses CoBolt PDF Engine from source/tools/cobolt-pdf-engine/.

Usage:
    python generate_trust_pdf.py

Output:
    docs/Technical/TRUST-ARCHITECTURE.pdf
"""

import sys
import os

# Add source/tools to path so we can import the engine
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, os.path.join(PROJECT_DIR, "source", "tools"))

from cobolt_pdf_engine import PDFGenerator  # noqa: E402

INPUT_FILE = os.path.join(SCRIPT_DIR, "Technical", "TRUST-ARCHITECTURE.md")
OUTPUT_FILE = os.path.join(SCRIPT_DIR, "Technical", "TRUST-ARCHITECTURE.pdf")


def main():
    print(f"Reading: {INPUT_FILE}")

    gen = PDFGenerator(theme="executive")
    gen.from_markdown(
        INPUT_FILE,
        OUTPUT_FILE,
        title="CoBolt",
        subtitle="TRUST ARCHITECTURE",
        version="1.0",
        description=[
            "Trust boundary architecture for the autonomous development platform.",
            "Hook-level interception, deterministic evidence verification,",
            "and cryptographic attestation across the 10-stage pipeline.",
        ],
        classification="INTERNAL — ARCHITECTURE",
    )

    size = os.path.getsize(OUTPUT_FILE)
    print(f"PDF generated: {OUTPUT_FILE}")
    print(f"  Size: {size:,} bytes ({size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
