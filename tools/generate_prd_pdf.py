#!/usr/bin/env python3
"""
Generate an executive-grade PDF from the CoBolt PRD Markdown file.

Uses CoBolt PDF Engine from source/tools/cobolt-pdf-engine/.

Usage:
    python generate_prd_pdf.py

Output:
    docs/PRD.pdf
"""

import sys
import os

# Add source/tools to path so we can import the engine
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, os.path.join(PROJECT_DIR, "source", "tools"))

from cobolt_pdf_engine import PDFGenerator  # noqa: E402

INPUT_FILE = os.path.join(SCRIPT_DIR, "PRD.md")
OUTPUT_FILE = os.path.join(SCRIPT_DIR, "PRD.pdf")


def main():
    print(f"Reading: {INPUT_FILE}")

    gen = PDFGenerator(theme="executive")
    gen.from_markdown(
        INPUT_FILE,
        OUTPUT_FILE,
        title="CoBolt",
        subtitle="PRODUCT REQUIREMENTS DOCUMENT",
        version="0.8.0",
        description=[
            "Autonomous development platform: 106 agents, 21 workflow skills,",
            "8 IDE runtimes, plus a standalone Elixir/OTP application.",
            "Full lifecycle from PRD to production with deterministic",
            "verification gates and automated PR review.",
        ],
        classification="CONFIDENTIAL",
    )

    size = os.path.getsize(OUTPUT_FILE)
    print(f"PDF generated: {OUTPUT_FILE}")
    print(f"  Size: {size:,} bytes ({size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
