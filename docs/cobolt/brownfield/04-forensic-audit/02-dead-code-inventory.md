---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/16f-dead-code-inventory.md
pipeline: brownfield
topic: 04-forensic-audit
title: "Dead Code Inventory"
order: 2
audiences: ["architect", "security", "reviewer"]
source_sha256: b6a04f582fb6dfda1e0984448138392df3c5f1cd313dd83141696e0d4a34ab55
source_size: 579
published_at: 2026-05-04T14:36:58.135Z
published_by: cobolt-publish-docs
---

# 16f — Dead Code Inventory

| ID | Location | Description | Recommendation |
|---|---|---|---|
| DEAD-001 | `src/bun/index.ts:321` | Inside `searchInFolder`, the `matched++` increment is unreachable in practice — `matched = hits.length` overwrites it after `walk()` returns. | Delete the inner increment. (Tracking SCAN-005 / DEBT-008.) |
| DEAD-002 | `src/bun/index.ts:332` | `matched = 0` immediately before `walk(root, 0)` is also redundant; `matched` is reassigned to `hits.length` afterwards. | Delete. (Same SCAN-005.) |

No other dead code detected via direct read.

