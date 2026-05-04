---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/16h-design-quality-assessment.md
pipeline: brownfield
topic: 04-forensic-audit
title: "Design Quality Assessment"
order: 4
audiences: ["architect", "security", "reviewer"]
source_sha256: dff16168fa611fc622bc5138fe56a8f362f602abd0631d0715084c2be4b31a3b
source_size: 1595
published_at: 2026-05-04T14:36:58.135Z
published_by: cobolt-publish-docs
---

# 16h — Design Quality Assessment

## Visual / brand

- The brand mark is being designed (per `docs/superpowers/specs/2026-05-04-brand-mark-design.md`); brand assets path is wired in `electrobun.config.ts:36-41` (logo SVG + 16/32/180-px PNG icons + CoBolt attribution name logo).
- The CoBolt attribution name logo is shown in the status bar footer (per electrobun.config.ts comment).

## Component design

The UI uses no UI framework — vanilla DOM + TypeScript. Components are small and consistent:

- Buttons: `.btn .btn-primary`, `.btn .btn-icon`, `.btn .btn-ghost`
- Tabs: `.tab-btn[data-tab=…]`
- Tree: `.tree-node > .tree-row + .tree-children`
- Search results: `.search-file > .search-file-head + .search-match*`

Naming is consistent and self-explanatory.

## Token usage

`design-tokens.json` was scaffolded by `/cobolt-init` but the existing CSS in `src/mainview/index.css` predates it. The CSS uses CSS custom properties (`var(--bg)`, `var(--text)`, etc.) — modernization should align CSS variables to design-tokens.json keys.

## Accessibility

See `08a-current-ui-ux-assessment.md` § Pain Points. Quick wins:
1. Restore focus after lightbox close
2. Run axe-core in Playwright smoke test
3. Verify color contrast against WCAG AA for both themes

## Design Debt

| ID | Issue | Severity |
|---|---|---|
| DESIGN-001 | CSS variables and design-tokens.json are not aligned | Medium |
| DESIGN-002 | Brand mark not yet finalized | Medium |
| DESIGN-003 | No accessible name on resize-handle | Low |
| DESIGN-004 | Tree filter triggers full DOM walk on every keystroke | Low |

