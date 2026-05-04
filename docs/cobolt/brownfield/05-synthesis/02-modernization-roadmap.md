---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/18-modernization-roadmap.md
pipeline: brownfield
topic: 05-synthesis
title: "Modernization Roadmap"
order: 2
audiences: ["architect", "delivery-lead", "stakeholder"]
source_sha256: a130790bd473beeb14d47ebe11a7f8c29925d4019a2ddc5d7a7f9cd621bdf7bd
source_size: 1150
published_at: 2026-05-04T14:36:58.135Z
published_by: cobolt-publish-docs
---

# 18 — Modernization Roadmap

| Milestone | Goal | Stories (preview) | Risk lift |
|---|---|---|---|
| **M1 — Hostile-content hardening** | Close SEC-001/002/003/007; add CSP; harden rendering trust boundary | MOD-001 (re-sanitize mermaid SVG), MOD-002 (resolveImage containment), MOD-003 (DOMPurify style allowlist), MOD-006 (CSP meta) | High |
| **M2 — Distribution & test foundation** | Code signing on Win + macOS notarization; THIRD_PARTY_LICENSES; OSV scan in CI; Playwright domain test suite | ENH-020 + ENH-021 + MOD-008 + MOD-009 + ENH-014 + ENH-015 | High |
| **M3 — Multi-format editor (Notepad++-class)** | In-flight expansion: tabs, edit mode, multi-format support beyond markdown | (Pre-existing 20-task plan in commit af327fe) | Medium |
| **M4 — Polish & domain extensions** | PDF export, code-split bundle, mermaid theme config, debt cleanup | ENH-006 + ENH-011 + ENH-023 + DEBT-001..014 | Low |

Sequencing rationale: M1 raises the security floor before M3 (multi-format editor) brings new attack surface (write-mode = file-write capability adds new failure modes). M2 unlocks public distribution. M4 is post-MVP polish.

