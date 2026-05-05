---
cobolt_published: true
canonical: _cobolt-output/latest/planning/ux-design-specification.md
pipeline: plan
topic: 03-design
title: "UX Design Specification"
order: 1
audiences: ["product", "delivery-lead", "build-agent"]
source_sha256: 11b5c61622017a0040bf8279a0264fc2abb0b8211623639fadfc3e536b3c39af
source_size: 6997
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# UX Design Specification — MarkDownViewer

## 1. Design Principles

1. **Native first** — match each platform's conventions (hidden inset titlebar on macOS, native menu bar, keyboard shortcuts using OS modifiers)
2. **Single window, no chrome bloat** — sidebar + content + status bar; no toolbars unless they materially help
3. **Read first, edit second** — viewer mode is the default; editor mode (M3) is opt-in via menu / shortcut
4. **Privacy by default** — no telemetry, no remote calls, no surprise network egress
5. **Fast over fancy** — startup < 1.5 s; render < 300 ms for typical docs; theme switch < 200 ms

## 2. Personas (per `24-modernization-prd.md`)

- **Vivek** — power user, Obsidian-adjacent
- **Dana** — developer browsing repo READMEs
- **Sam** — receives `.md` files in email

## 3. Key Flows

### 3.1 First-run

```
[Double-click .md OR launch app from icon]
   ↓
[EULA dialog (only if no marker)]
   ↓ (Decline → quit  |  Accept → continue)
   ↓
[Write EULA marker (M1: 0644 on linux/mac)]
   ↓
[Open file argv-resolved | Open welcome screen if no file]
```

### 3.2 Open file (from app, post-first-run)

```
Cmd-O  OR  File Menu → Open File…  OR  drag-drop
   ↓
[Native open-file dialog]
   ↓
[readFile RPC]
   ↓
[Render: parse → DOMPurify (hardened M1) → mermaid+sanitize → KaTeX → highlight]
   ↓
[Push to recent.json]
   ↓
[Watch file for changes (debounced 80ms)]
```

### 3.3 Hostile content path (NEW M1)

```
[Open .md containing hostile mermaid/CSS/image-traversal]
   ↓
[All content goes through hardened pipeline]
   ↓ Mermaid SVG → DOMPurify (SVG profile) → DOM
   ↓ resolveImage(../../etc/passwd) → bun rejects → renderer shows {alt: "[image not found: ...]"}
   ↓ Inline CSS background:url(...) → stripped by DOMPurify allowlist
   ↓
[Renderer shows safe content; no exfil; no injection]
```

### 3.4 Edit mode (M3)

```
Cmd-Shift-E  OR  File Menu → Edit Mode  OR  drag .md with intent=edit (TBD)
   ↓
[Open in editor tab; preview pane on the right]
   ↓ each keystroke → debounced 250ms → preview re-renders via existing pipeline
   ↓ Cmd-S → saveFile RPC
   ↓ autosave every 5s if dirty
```

## 4. Screens

### 4.1 Welcome screen (no file open)

- Big logo (brand mark from `docs/superpowers/specs/2026-05-04-brand-mark-design.md`)
- "Open File" + "Open Folder" buttons
- Recent files (top 5)
- Hint text: "Drag a .md file here, or press ⌘O"

### 4.2 Document view (file open)

- Sidebar (180-560px, drag-resizable)
  - Files / Search / Recent / Outline tabs
- Content pane: rendered markdown
- Status bar: path, word/line count + reading time, zoom

### 4.3 Document edit (M3)

- Sidebar (same)
- Editor pane (left) + Preview pane (right) — split view, drag-resize divider
- Editor: monospace, syntax highlighting for current format
- Status bar: path, dirty indicator, format selector, save indicator

### 4.4 Lightbox (image / mermaid)

- Modal overlay over content
- Pan/zoom for diagrams (svg-pan-zoom)
- ESC or click outside to close
- M1: focus restoration on close

### 4.5 EULA dialog (first run)

- Native OS dialog (osascript / MessageBox / zenity / kdialog)
- Two buttons: "I Agree" (default) / "Decline & Quit"

### 4.6 Find bar (cmd+f)

- Slides in below titlebar
- Input + count + prev / next / close
- Live highlight in content

### 4.7 License info (Help → License…)

- Native OS info dialog (M0 — already implemented)
- M2: add link to `THIRD_PARTY_LICENSES.md` (open in default app)

## 5. Theming

- `auto` (follows system) | `light` | `dark`
- Mermaid theme syncs with body theme
- M1 / MOD-007: cache parsed HTML keyed on file content; only mermaid re-renders on theme change
- M2 / DESIGN-001: align CSS variables with `design-tokens.json`

## 6. Accessibility (WCAG 2.1 AA target)

| Criterion | Status / Action |
|---|---|
| 1.4.3 Color contrast | M1 audit needed (DESIGN-001 alignment); dark theme contrast not verified |
| 2.1.1 Keyboard | All major actions have shortcuts; verify in M1 |
| 2.4.3 Focus order | Restore focus on lightbox close (M1 fix) |
| 2.4.4 Link purpose | External links carry `data-external="true"`; visually distinguished by CSS |
| 2.4.7 Focus visible | Verify focus indicator visibility in both themes (M1 audit) |
| 3.2.1 On focus | No surprise navigation on focus change — verified |
| 4.1.2 Name, role, value | M1 sweep: ensure all icon-only buttons have `aria-label` |

## 7. Visual Style

- Color tokens centralized in `design-tokens.json` (M2 DESIGN-001 alignment)
- Typography: system-ui font for chrome, monospace for code blocks (variables `var(--font-sans)`, `var(--font-mono)`)
- Spacing scale: 4px / 8px / 12px / 16px / 24px / 32px (verify against current CSS in M1 audit)
- Corner radii: 4px small, 8px medium, 12px large
- Brand mark: per `docs/superpowers/specs/2026-05-04-brand-mark-design.md` (in flight)

## 8. UI States Inventory

| Component | States |
|---|---|
| Open buttons | idle, hover, focus, active |
| File tree row | idle, hover, active (current file), filtered-out |
| Search input | idle, focused, with-results, no-results, truncated |
| Recent item | idle, hover, broken (file removed) |
| Theme button | sun (light), moon (dark), auto (system follow) |
| Find bar | hidden, open, query-active (count visible), no-match |
| Lightbox | closed, open, panning, zoomed |
| Editor tab (M3) | idle, active, dirty, saving, error |
| EULA dialog | first-run only |

## 9. Empty States

- Welcome screen: "Open a file to get started" + drag affordance
- Files tab without folder: "Open Folder" button
- Search tab without query: "" / hidden
- Recent tab empty: "No recent files"
- Outline tab empty: "No headings"

## 10. Error States

- File not found: error card with path
- File permission denied: error card with message
- Mermaid parse error: in-place `.mermaid-error` block with source
- KaTeX parse error: KaTeX displays `\textcolor{red}{error}` (already its default with `throwOnError: false`)
- Front-matter parse error (M1): visible warning banner above content
- RPC failure (M2 ENH-013): non-blocking status banner

## 11. Internationalization

Out of scope for M0-M3. Default English. Future i18n requires:
- String externalization
- RTL CSS support
- Date/time/number locale formatting
- Native menu localization via Electrobun's per-locale menu API

<!-- COBOLT_BROWNFIELD_FEATURE_TRACEABILITY:START -->

## Brownfield Feature Traceability

- Feature: FEAT-001 Brownfield modernization access slice
- Requirement IDs: FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, FR-009, FR-010, FR-011, FR-012, FR-013, NFR-001, NFR-002, NFR-003, NFR-004, NFR-005, NFR-006
- Coverage: product intent, user flow, UI states, wireframes, backend, middleware, API, data, integrations, auth, security, privacy, NFRs, observability, tests, rollout, service blueprint, spec contracts, accessibility, and architecture.

<!-- COBOLT_BROWNFIELD_FEATURE_TRACEABILITY:END -->
