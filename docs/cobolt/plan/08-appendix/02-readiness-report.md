---
cobolt_published: true
canonical: _cobolt-output/latest/planning/readiness-report.md
pipeline: plan
topic: 08-appendix
title: "Readiness Report"
order: 2
audiences: ["architect", "delivery-lead"]
source_sha256: 5bffd9879b18258c2ea1eaaeb0951876d88aa104494ab753fb8b0a0ebde47de0
source_size: 1801
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Readiness Report

> Generated from brownfield readiness gate status plus canonical planning sync status.

- Brownfield gate passed: no
- Canonical build contract passed: no
- Source document packet aligned: yes
- UI detected: yes
- UI signals: playwright-config, planning-ux-spec, planning-wireframes, planning-ux-tracker, ui-source-files

## Brownfield Gate Checks

- G1: PASS â€” 6489 bytes (min 2000)
- G2: PASS â€” 20854 bytes (min 100)
- G3: FAIL â€” health-score.json not found. Run: node tools/cobolt-brownfield-health-score.js compute
- G4: PASS â€” No P0 issues
- G5: PASS â€” 4/4 present (100%)
- G6: FAIL â€” 1 commands executed
- G7: FAIL â€” status=failed (cobolt-brownfield-accuracy-review)
- G8: FAIL â€” 19-evidence-index.json has no entries
- G9: PASS â€” 1176 bytes (min 500)
- G10: FAIL â€” query/migration contract missing from registry: contents, every, individual, the, views
- G11: FAIL â€” status=fail, trust=73/100, degraded=4, blocking=2
- G12: PASS â€” scope=assessment, contracts=8

## Canonical Planning Contract

- Missing: `deterministic-quality-gates` at `_cobolt-output/latest/planning/deterministic-quality-gates.json`
- Missing: `agent-grounding` at `_cobolt-output/latest/planning/agent-grounding-and-anti-hallucination.md`
- Missing: `story-file` at `_cobolt-output/latest/planning/stories/*.md`
- Missing: `planning-manifest` at `_cobolt-output/latest/planning/planning-manifest.json`
- Missing: `planning-loop-verdict` at `_cobolt-output/latest/planning/planning-loop-verdict.json`
- Missing: `planning-evidence-signature` at `_cobolt-output/latest/planning/planning-evidence-signature.json`

## Source Document Packet

- PRD frontmatter links to the consolidation packet and primary input document.
