---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/03c-project-skills-manifest.md
pipeline: brownfield
topic: 01-intake
title: "Project Skills Manifest"
order: 6
audiences: ["architect", "delivery-lead", "stakeholder"]
source_sha256: 028ff0ba61c13b5e4fba3efd24fbde5522afd385a1225062b3a01080e4287128
source_size: 1070
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# 03c — Project Skills Manifest

This manifest names the skills/agents most useful for THIS project's modernization work.

## Active

| Skill | Purpose |
|---|---|
| cobolt-brownfield (this run) | Assessment + modernization packet |
| cobolt-build | Will execute milestones once planning packet is complete |
| cobolt-uat | Hostile-content fixture coverage; Playwright drives the rendered DOM |
| cobolt-pentest | Local file read / XSS / CSP fuzz |

## Per-domain agents the build will lean on

| Agent | Use |
|---|---|
| security-architect | STRIDE on the markdown rendering pipeline |
| frontend-dev | DOMPurify allowlist tightening, CSP meta tag |
| backend-dev | resolveImage path containment |
| test-architect | Hostile-content fixture suite + Playwright smoke |
| ux-designer | Multi-format editor UX (when M3 starts) |

## Skipped / Not Applicable

| Skill | Reason |
|---|---|
| cobolt-stitch-design | Frontend is hand-written; no Stitch dependency |
| cobolt-deploy / cobolt-infra | No backend infrastructure to provision |
| cobolt-data-migrate | No DB |

