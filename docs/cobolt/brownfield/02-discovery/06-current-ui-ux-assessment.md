---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/08a-current-ui-ux-assessment.md
pipeline: brownfield
topic: 02-discovery
title: "Current UI/UX Assessment"
order: 6
audiences: ["architect", "security", "build-agent"]
source_sha256: a5e6fdb1f5f4557533738e7c714cf70a2ac2577586ae00b919c144093348de55
source_size: 1928
published_at: 2026-05-04T14:36:58.135Z
published_by: cobolt-publish-docs
---

# 08a — Current UI/UX Assessment

## Overall

The UI is **competent and minimal**. It uses native macOS conventions (hidden inset titlebar, Cmd-keyed shortcuts) while remaining cross-platform. The single-window, sidebar+content layout is a familiar pattern (matches GitHub, Obsidian, VSCode preview).

## Strengths

- Clear three-region layout: sidebar / content / status-bar
- Tab-based sidebar groups Files / Search / Recent / Outline cleanly
- Dropzone overlay during drag is good affordance
- Lightbox with svg-pan-zoom for diagrams is a delightful touch
- Theme switching is instant (mermaid reconfigured + last file re-rendered)
- Status bar shows path / word-count / zoom — good info density

## Pain Points (potential)

| Issue | Severity | Notes |
|---|---|---|
| No multi-document interface | Medium | Single-document only; users browsing a vault must constantly re-open. Addressed by ENH-002 / multi-format-editor plan. |
| No edit mode | High (vs. competitor parity) | Viewer-only today. Multi-format editor (M3) addresses. |
| File-tree filter does not debounce | Low | Every keystroke walks all 5000 rows (SCAN-006 / DEBT-009). |
| Lightbox close: no explicit focus restoration | Low (a11y) | WCAG SC 2.4.3 — focus may scroll out of viewport after close. |
| Some buttons lack `aria-label` | Low (a11y) | `open-btn`, `open-folder-btn` rely on visible text; `#open-btn` actually has visible "File" label so OK. Mostly fine but worth a sweep. |
| No "remove broken entries" affordance in Recent | Low | Recent items pointing to deleted files render as broken — clicking surfaces an error but no auto-cleanup. |
| Color contrast not verified | Unknown | Should be checked against WCAG AA in P5 UX spec. |

## In-flight UX work

`docs/superpowers/specs/2026-05-04-brand-mark-design.md` is a brand-mark spec under design. Multi-format-editor commits (eb17b5b, af327fe) define the next-generation UX direction.

