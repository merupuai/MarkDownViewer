#!/usr/bin/env python3
"""
Convert Markdown report to PDF using reportlab
"""

import re
from reportlab.lib.pagesizes import A4, letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Image, Table, TableStyle, ListFlowable, ListItem
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

def parse_markdown_to_flowables(md_file_path):
    """Parse markdown file and convert to reportlab flowables"""

    with open(md_file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # Create styles
    styles = getSampleStyleSheet()

    # Custom styles
    title_style = ParagraphStyle(
        'CustomTitle',
        parent=styles['Heading1'],
        fontSize=24,
        textColor=colors.HexColor('#1a1a1a'),
        spaceAfter=30,
        alignment=TA_CENTER,
        fontName='Helvetica-Bold'
    )

    h1_style = ParagraphStyle(
        'CustomH1',
        parent=styles['Heading1'],
        fontSize=18,
        textColor=colors.HexColor('#2c3e50'),
        spaceAfter=12,
        spaceBefore=20,
        fontName='Helvetica-Bold'
    )

    h2_style = ParagraphStyle(
        'CustomH2',
        parent=styles['Heading2'],
        fontSize=14,
        textColor=colors.HexColor('#34495e'),
        spaceAfter=10,
        spaceBefore=16,
        fontName='Helvetica-Bold'
    )

    h3_style = ParagraphStyle(
        'CustomH3',
        parent=styles['Heading2'],
        fontSize=12,
        textColor=colors.HexColor('#34495e'),
        spaceAfter=8,
        spaceBefore=12,
        fontName='Helvetica-Bold'
    )

    body_style = ParagraphStyle(
        'CustomBody',
        parent=styles['Normal'],
        fontSize=10,
        alignment=TA_JUSTIFY,
        spaceAfter=12,
        fontName='Helvetica'
    )

    flowables = []
    lines = content.split('\n')
    i = 0

    while i < len(lines):
        line = lines[i].strip()

        # Skip empty lines
        if not line:
            i += 1
            continue

        # Title (first H1)
        if line.startswith('# ') and i < 5:
            title_text = line[2:].strip()
            flowables.append(Paragraph(title_text, title_style))
            flowables.append(Spacer(1, 0.3*inch))
            i += 1
            continue

        # H1
        if line.startswith('# '):
            h1_text = line[2:].strip()
            flowables.append(PageBreak())
            flowables.append(Paragraph(h1_text, h1_style))
            i += 1
            continue

        # H2
        if line.startswith('## '):
            h2_text = line[3:].strip()
            flowables.append(Paragraph(h2_text, h2_style))
            i += 1
            continue

        # H3
        if line.startswith('### '):
            h3_text = line[4:].strip()
            flowables.append(Paragraph(h3_text, h3_style))
            i += 1
            continue

        # H4
        if line.startswith('#### '):
            h4_text = line[5:].strip()
            flowables.append(Paragraph(f'<b>{h4_text}</b>', body_style))
            i += 1
            continue

        # Horizontal rule
        if line.startswith('---'):
            flowables.append(Spacer(1, 0.2*inch))
            i += 1
            continue

        # Images
        if line.startswith('!['):
            # Extract image path
            match = re.search(r'!\[.*?\]\((.*?)\)', line)
            if match:
                img_path = match.group(1)
                # Convert relative path to absolute
                if img_path.startswith('../charts/'):
                    img_path = '/workspace/charts/' + img_path[10:]
                elif img_path.startswith('charts/'):
                    img_path = '/workspace/' + img_path
                elif not img_path.startswith('/'):
                    img_path = '/workspace/' + img_path

                try:
                    # Extract caption
                    caption_match = re.search(r'!\[(.*?)\]', line)
                    caption = caption_match.group(1) if caption_match else ''

                    img = Image(img_path, width=6*inch, height=4*inch)
                    flowables.append(Spacer(1, 0.1*inch))
                    flowables.append(img)
                    if caption:
                        caption_style = ParagraphStyle(
                            'Caption',
                            parent=styles['Normal'],
                            fontSize=9,
                            textColor=colors.HexColor('#666666'),
                            alignment=TA_CENTER,
                            spaceAfter=12
                        )
                        flowables.append(Paragraph(caption, caption_style))
                    flowables.append(Spacer(1, 0.2*inch))
                except Exception as e:
                    print(f"Warning: Could not load image {img_path}: {e}")
            i += 1
            continue

        # Tables (markdown tables)
        if '|' in line and i + 1 < len(lines) and '|' in lines[i+1]:
            table_lines = [line]
            j = i + 1
            while j < len(lines) and '|' in lines[j]:
                table_lines.append(lines[j])
                j += 1

            # Parse table
            table_data = []
            for tline in table_lines:
                if '---' in tline:  # Skip separator line
                    continue
                cells = [cell.strip() for cell in tline.split('|')[1:-1]]
                table_data.append(cells)

            if table_data:
                # Create table
                t = Table(table_data)
                t.setStyle(TableStyle([
                    ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#3498db')),
                    ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
                    ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                    ('FONTSIZE', (0, 0), (-1, 0), 10),
                    ('BOTTOMPADDING', (0, 0), (-1, 0), 12),
                    ('BACKGROUND', (0, 1), (-1, -1), colors.HexColor('#ecf0f1')),
                    ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
                    ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
                    ('FONTSIZE', (0, 1), (-1, -1), 9),
                    ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f8f9fa')])
                ]))
                flowables.append(t)
                flowables.append(Spacer(1, 0.2*inch))

            i = j
            continue

        # Lists
        if line.startswith('- ') or line.startswith('* ') or re.match(r'^\d+\.', line):
            list_items = []
            j = i
            while j < len(lines):
                lline = lines[j].strip()
                if lline.startswith('- ') or lline.startswith('* '):
                    list_items.append(lline[2:])
                    j += 1
                elif re.match(r'^\d+\.', lline):
                    list_items.append(re.sub(r'^\d+\.\s*', '', lline))
                    j += 1
                else:
                    break

            for item in list_items:
                # Process markdown in list items
                item = re.sub(r'\*\*(.*?)\*\*', r'<b>\1</b>', item)
                item = re.sub(r'\*(.*?)\*', r'<i>\1</i>', item)
                item = re.sub(r'\[(.*?)\]\((.*?)\)', r'<link href="\2">\1</link>', item)
                flowables.append(Paragraph(f'• {item}', body_style))

            flowables.append(Spacer(1, 0.1*inch))
            i = j
            continue

        # Code blocks
        if line.startswith('```'):
            code_lines = []
            j = i + 1
            while j < len(lines) and not lines[j].strip().startswith('```'):
                code_lines.append(lines[j])
                j += 1

            code_text = '\n'.join(code_lines)
            code_style = ParagraphStyle(
                'Code',
                parent=styles['Code'],
                fontSize=8,
                fontName='Courier',
                backColor=colors.HexColor('#f5f5f5'),
                leftIndent=20,
                rightIndent=20,
                spaceAfter=12
            )
            flowables.append(Paragraph(f'<pre>{code_text}</pre>', code_style))
            i = j + 1
            continue

        # Bold and italic
        if line.startswith('**') or '*' in line or '[' in line:
            # Process markdown formatting
            line = re.sub(r'\*\*\*(.*?)\*\*\*', r'<b><i>\1</i></b>', line)
            line = re.sub(r'\*\*(.*?)\*\*', r'<b>\1</b>', line)
            line = re.sub(r'\*(.*?)\*', r'<i>\1</i>', line)
            line = re.sub(r'\[(.*?)\]\((.*?)\)', r'<link href="\2">\1</link>', line)
            flowables.append(Paragraph(line, body_style))
            i += 1
            continue

        # Regular paragraph
        if line and not line.startswith('#'):
            # Process markdown formatting
            line = re.sub(r'\*\*\*(.*?)\*\*\*', r'<b><i>\1</i></b>', line)
            line = re.sub(r'\*\*(.*?)\*\*', r'<b>\1</b>', line)
            line = re.sub(r'\*(.*?)\*', r'<i>\1</i>', line)
            line = re.sub(r'\[(.*?)\]\((.*?)\)', r'<link href="\2">\1</link>', line)
            flowables.append(Paragraph(line, body_style))

        i += 1

    return flowables

def create_pdf(md_file, output_pdf):
    """Create PDF from markdown file"""

    # Create PDF
    doc = SimpleDocTemplate(
        output_pdf,
        pagesize=letter,
        rightMargin=72,
        leftMargin=72,
        topMargin=72,
        bottomMargin=72
    )

    # Parse markdown and build flowables
    flowables = parse_markdown_to_flowables(md_file)

    # Build PDF
    doc.build(flowables)
    print(f"PDF generated successfully: {output_pdf}")

if __name__ == "__main__":
    md_file = "/workspace/docs/llm_gateway_research_report.md"
    output_pdf = "/workspace/docs/llm_gateway_research_report.pdf"

    create_pdf(md_file, output_pdf)
