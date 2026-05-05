---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/14-business-rules-and-validation.md
pipeline: brownfield
topic: 03-deep-analysis
title: "Business Rules & Validation"
order: 2
audiences: ["architect", "build-agent"]
source_sha256: 681607a515079c6c8ab5a130764becbf67b04bba7735a087f482d509f5ad39d5
source_size: 2571
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# 14 — Business Rules & Validation

The application is a viewer; "business rules" are minimal. The catalog below covers all domain rules detected in source.

## Rules

| ID | Rule | Source |
|---|---|---|
| BR-001 | EULA must be accepted before any window is created. | `src/bun/index.ts:526-529` (process.exit(0) on decline) |
| BR-002 | EULA acceptance is bound to `EULA_VERSION`; bumping the version forces re-acceptance. | `src/bun/index.ts:22, 32` |
| BR-003 | Recent files list is bounded to the last 20 entries, deduplicated by path. | `src/bun/index.ts:355` (`entries.slice(0, 20)`) and `358-359` (filter then unshift) |
| BR-004 | File-tree walk respects depth ≤ 8 and total entries ≤ 5000. | `src/bun/index.ts:177-178` |
| BR-005 | Folder search is bounded by 5000 files / 500 total hits / 20 hits/file / 2 MB/file. | `src/bun/index.ts:179-181` |
| BR-006 | Markdown extension regex is `.(md|markdown|mdown|mkd|mkdn|mdx)` (case-insensitive). | `src/bun/index.ts:170` |
| BR-007 | External URLs (`https?:`, `mailto:`) are routed to the OS default handler via `openExternal` RPC. | `src/mainview/index.ts:680-683` |
| BR-008 | Image src that starts with `https?:`, `data:`, or `file:` is left as-is by `resolveImage`. | `src/bun/index.ts:367` |
| BR-009 | Wikilink `[[Target]]` is resolved against the current open folder; unresolved → marked `.broken`. | `src/mainview/index.ts:316-338` |
| BR-010 | Image extension allowlist for MIME mapping: png/jpg/jpeg/gif/svg/webp/bmp/ico/avif. Unknown → application/octet-stream (today; should reject — see SEC-002). | `src/bun/index.ts:373-378` |
| BR-011 | Filename sanitization for `exportHtml` strips to `[A-Za-z0-9._-]`. | `src/bun/index.ts:488` |
| BR-012 | Zoom is clamped to `[0.6, 2.5]`. | `src/mainview/index.ts:144` |
| BR-013 | Sidebar width is clamped to `[180px, 560px]`. | `src/mainview/index.ts:165-166` |

## Validation Posture

| Surface | Validation | Status |
|---|---|---|
| File path (RPC `readFile`) | None — caller-provided | OK in current threat model (caller is renderer in same bundle) |
| Folder path (RPC `searchFolder`) | Falls back to `currentFolderRoot` if root not provided; otherwise none | OK |
| Image src (`resolveImage`) | Scheme rejection only; no path containment | **Gap — SEC-002** |
| Search query | Regex escape via `replace(...).$&`; case + whole-word toggles control flags | OK |
| URL for `openExternal` | None | Mitigated by array argv (no shell injection); document |
| Front-matter | gray-matter SAFE_SCHEMA + try/catch | OK; surface errors per MOD-004 |

