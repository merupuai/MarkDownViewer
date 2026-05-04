---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/01-intake-and-classification.md
pipeline: brownfield
topic: 01-intake
title: "Intake & Classification"
order: 1
audiences: ["architect", "delivery-lead", "stakeholder"]
source_sha256: 530858fb9619a60d4d3360482a86d972e4eaa0de1c4f48e79b3bcd8bacf3454f
source_size: 1167
published_at: 2026-05-04T14:36:58.135Z
published_by: cobolt-publish-docs
---

# 01 — Intake & Classification

**Project**: MarkDownViewer
**Identifier**: com.local.markdownviewer
**Version**: 1.0.0 (per package.json)
**License**: MIT (Non-Resale Variant) — © 2026 MFTLabs · Developed by CoBolt
**Type**: Desktop application (native binary, no server)
**Lifecycle**: Maintained / active development with in-flight multi-format-editor expansion

## Stakeholders

| Role | Identity |
|---|---|
| Copyright holder | MFTLabs |
| Developer | CoBolt |
| User | End user opening a .md file (single-tenant; no remote distribution scenario yet) |

## Drivers

1. Native desktop performance for markdown viewing without a browser
2. Mermaid + KaTeX + GFM alerts + wikilinks in one tool
3. macOS-first (.app bundle), Windows + Linux supported
4. Future: Notepad++-class multi-format editing (in-flight)

## Existing Documentation

- README.md (modified)
- LICENSE (modified)
- docs/superpowers/specs/2026-05-04-brand-mark-design.md (untracked, brand-mark spec)
- Multi-format editor implementation plan in commits af327fe / eb17b5b
- Inno Setup script: windows/MarkdownViewerSetup.iss

See `brownfield-intake-profile.json` for the structured intake.

