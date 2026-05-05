---
cobolt_published: true
canonical: _cobolt-output/latest/planning/wireframes-and-user-flows.md
pipeline: plan
topic: 03-design
title: "Wireframes and User Flows"
order: 2
audiences: ["product", "delivery-lead", "build-agent"]
source_sha256: 119eba42e4e429b058ddd6fe723038b72df80f4204cbfd40415b7173fe98c20a
source_size: 12410
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Wireframes & User Flows — MarkDownViewer (Modernization)

## 1. Mainview — view mode (M1, post-hardening)

```
┌──────────────────────────────────────────────────────────────────────┐
│ [hidden inset titlebar — drag to move]                              │ ← traffic-light area on macOS
├─────────────────────┬────────────────────────────────────────────────┤
│ ┌─[File][Folder]──┐ │                                                │
│ │  [☀/🌙 Theme ]  │ │  # Document Title                              │
│ ├─────────────────┤ │                                                │
│ │ Files Search     │ │  Body content rendered via:                    │
│ │  Recent Outline  │ │    - markdown-it (html: true)                  │
│ ├─────────────────┤ │    - DOMPurify (HARDENED M1)                   │
│ │ ▾ folder/        │ │    - mermaid (loose) → SVG-sanitize (M1)      │
│ │   ▸ subfolder/  │ │    - KaTeX                                     │
│ │     file1.md ⬛ │ │    - highlight.js                              │
│ │     file2.md    │ │    - CSP meta tag (M1)                        │
│ └─────────────────┘ │                                                │
│ [resize handle]     │  Images resolved via RPC.resolveImage          │
│                     │  with PATH CONTAINMENT (M1)                    │
│                     │                                                │
├─────────────────────┴────────────────────────────────────────────────┤
│  /Users/me/notes/file1.md  ·  1,234 words · 56 lines · 6 min · 100% │ ← status bar
└──────────────────────────────────────────────────────────────────────┘
```

## 2. Mainview — edit mode (M3)

```
┌──────────────────────────────────────────────────────────────────────┐
│  [×] file1.md  [×] file2.md*  [+]                                   │ ← tab bar (NEW M3)
├──────────────────────────┬───────────────────────────────────────────┤
│ Editor pane              │ Preview pane                              │
│ ─────────────────────    │ ───────────────────────────                │
│                          │                                           │
│ # My Document            │ # My Document                             │
│                          │                                           │
│ Some content...|cursor  │ (rendered HTML, debounced 250ms)          │
│                          │                                           │
│ ## Section 1             │ ## Section 1                              │
│                          │                                           │
│ - bullet                 │ • bullet                                  │
│                          │                                           │
├──────────────────────────┴───────────────────────────────────────────┤
│  Edit · file1.md · markdown · Saved 2s ago             100%          │
└──────────────────────────────────────────────────────────────────────┘
```

## 3. EULA dialog (first run)

Native OS dialog. Cross-platform layout:

```
┌─────────────────────────────────────────────────┐
│  License Agreement — Markdown Viewer            │
│                                                 │
│  Markdown Viewer                                │
│  © 2026 MFTLabs · Developed by CoBolt           │
│                                                 │
│  This software is FREE for personal,            │
│  educational, and internal business use under   │
│  the MIT (Non-Resale Variant) license.          │
│                                                 │
│  You MAY: use, copy, modify, and redistribute   │
│  it freely.                                     │
│                                                 │
│  You MAY NOT: sell, resell, sublicense for a    │
│  fee, or bundle it inside a paid commercial     │
│  product without prior written permission from  │
│  MFTLabs.                                       │
│                                                 │
│  By clicking "I Agree" you accept these terms.  │
│                                                 │
│       [Decline & Quit]    [I Agree]             │
└─────────────────────────────────────────────────┘
```

## 4. Lightbox

```
┌───────────────────────────────────────────────────────┐
│ ╳   <Diagram title>                                  │ ← close button + title
├───────────────────────────────────────────────────────┤
│                                                       │
│                                                       │
│              ┌─────────────────┐                     │
│              │                 │                     │
│              │   <SVG / IMG>   │                     │
│              │                 │                     │
│              └─────────────────┘                     │
│                                                       │
│                                                       │
│                                                       │
└───────────────────────────────────────────────────────┘

(svg-pan-zoom enabled for SVG; click-out / ESC closes; M1 restores focus to invoking control)
```

## 5. Find bar

```
┌──────────────────────────────────────────────────────────┐
│ [search input              ]  3 / 17  [ < ] [ > ] [ ╳ ] │
└──────────────────────────────────────────────────────────┘
```

## 6. Folder search results

```
┌──────────────────────────────────────────────────────────┐
│ [search input]  [☐ Case]  [☐ Word]                      │
│                                                          │
│ 23 matches in 5 files                                    │
│                                                          │
│ ▾ file1.md                                          (8)  │
│   12: ...some line with **match** here...                │
│   45: ...another **match** somewhere...                  │
│                                                          │
│ ▾ subfolder/file2.md                                (3)  │
│   ...                                                    │
└──────────────────────────────────────────────────────────┘
```

## 7. Front-matter parse error (NEW M1)

```
┌──────────────────────────────────────────────────────────┐
│ ⚠ Front-matter parse error                              │
│   "yaml: did not find expected key" at line 2           │
│   This file is rendered without front-matter.            │
└──────────────────────────────────────────────────────────┘
```

## 8. User flows

### 8.1 View flow (current + M1 hardening)

```
                  ┌──────────────────┐
                  │ User opens .md   │
                  └────────┬─────────┘
                           ↓
                  ┌────────▼─────────┐
                  │ readFile RPC     │
                  └────────┬─────────┘
                           ↓
                  ┌────────▼─────────┐
                  │ markdown-it parse│
                  └────────┬─────────┘
                           ↓
                  ┌────────▼─────────┐
                  │ DOMPurify (HARDENED)│
                  └────────┬─────────┘
                           ↓
            ┌──────────────┼──────────────┐
            ↓              ↓              ↓
     ┌──────────┐   ┌──────────┐    ┌──────────┐
     │ mermaid  │   │ KaTeX    │    │ highlight│
     │ + SVG-   │   │          │    │ .js      │
     │ sanitize │   └──────────┘    └──────────┘
     └────┬─────┘
          ↓
     ┌────▼──────────┐
     │ resolveImage   │
     │ (containment)  │
     └────┬───────────┘
          ↓
     ┌────▼──────────┐
     │ DOM injection │
     │ (under CSP)   │
     └───────────────┘
```

### 8.2 Edit flow (M3)

```
[Open with intent=edit]
    ↓
[Editor tab created]
    ↓
[User types]
    ↓ (debounced 250ms)
[Re-render preview using current pipeline]
    ↓
[autosaveTick every 5s if dirty]
    ↓
[Cmd-S → saveFile RPC]
    ↓
[Push to recent.json with lastEdit field]
```

<!-- COBOLT_BROWNFIELD_FEATURE_TRACEABILITY:START -->

## Brownfield Feature Traceability

- Feature: FEAT-001 Brownfield modernization access slice
- Requirement IDs: FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, FR-009, FR-010, FR-011, FR-012, FR-013, NFR-001, NFR-002, NFR-003, NFR-004, NFR-005, NFR-006
- Coverage: product intent, user flow, UI states, wireframes, backend, middleware, API, data, integrations, auth, security, privacy, NFRs, observability, tests, rollout, service blueprint, spec contracts, accessibility, and architecture.

<!-- COBOLT_BROWNFIELD_FEATURE_TRACEABILITY:END -->
