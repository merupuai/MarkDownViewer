---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/08-ui-and-workflow-catalog.md
pipeline: brownfield
topic: 02-discovery
title: "UI & Workflow Catalog"
order: 5
audiences: ["architect", "security", "build-agent"]
source_sha256: 778de08ed947bb3730a1b1a221eaab726edad7002d682469d70d2c73c469b98c
source_size: 9697
published_at: 2026-05-04T14:36:58.135Z
published_by: cobolt-publish-docs
---

# UI & Workflow Catalog — MarkDownViewer

The application is a single-window, single-page WebKit/WebView2 view (`views://mainview/index.html`).

## Window

| Property | Value | Source |
|---|---|---|
| Title | "Markdown Viewer" | `src/bun/index.ts:663` |
| Initial size | 1240 × 840 | `src/bun/index.ts:667` |
| Initial position | x=120, y=80 | `src/bun/index.ts:667` |
| Title bar style | hiddenInset | `src/bun/index.ts:666` |
| URL | `views://mainview/index.html` | `src/bun/index.ts:664` |

## Single-Page Layout

`src/mainview/index.html` defines a single page with the following regions:

```
┌──────────────────────────────────────────────────────────────────┐
│  titlebar-spacer (hidden inset titlebar)                         │
├──────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────┐  ┌──────────────────────────────────┐  │
│ │  sidebar             │  │  content-pane                    │  │
│ │  ┌──────────────┐    │  │  ┌────────────────────────────┐  │  │
│ │  │ open-btn     │    │  │  │ welcome / rendered .md     │  │  │
│ │  │ open-folder  │    │  │  │  (article.markdown-body)   │  │  │
│ │  │ theme-btn    │    │  │  │                            │  │  │
│ │  └──────────────┘    │  │  │ images: click → lightbox   │  │  │
│ │                      │  │  │ mermaid: click → lightbox  │  │  │
│ │  tab-bar:            │  │  │ links: external → openURL │  │  │
│ │  [Files] [Search]    │  │  │ wikilinks: route in folder │  │  │
│ │  [Recent] [Outline]  │  │  │                            │  │  │
│ │                      │  │  └────────────────────────────┘  │  │
│ │  pane-files:         │  │  find-bar (cmd+F, hidden)        │  │
│ │   tree-filter input  │  │                                  │  │
│ │   folder-label       │  │                                  │  │
│ │   file-tree          │  │                                  │  │
│ │                      │  │                                  │  │
│ │  pane-search:        │  │                                  │  │
│ │   folder-search-input│  │                                  │  │
│ │   case + word flags  │  │                                  │  │
│ │   search-status      │  │                                  │  │
│ │   search-results     │  │                                  │  │
│ │                      │  │                                  │  │
│ │  pane-recent:        │  │                                  │  │
│ │   recent-list        │  │                                  │  │
│ │   clear-recent       │  │                                  │  │
│ │                      │  │                                  │  │
│ │  pane-outline:       │  │                                  │  │
│ │   toc                │  │                                  │  │
│ └──────────────────────┘  └──────────────────────────────────┘  │
│  resize-handle (drag to resize sidebar 180-560 px)               │
├──────────────────────────────────────────────────────────────────┤
│  status bar:  status-path     status-stats     status-zoom      │
└──────────────────────────────────────────────────────────────────┘

  dropzone (overlay during drag)
  lightbox (modal overlay)
```

## Components

| Component | DOM ID | Purpose |
|---|---|---|
| Sidebar | `#sidebar` | Container for tabs and pane content |
| Tabs | `.tab-btn[data-tab=…]` | Files / Search / Recent / Outline |
| File-tree filter | `#tree-filter` | Live filter file names (no debounce) |
| File tree | `#file-tree` | Recursive markdown-only tree with lazy folder expand |
| Folder search input | `#folder-search-input` | Debounced regex search trigger (250 ms) |
| Folder search flags | `#search-case`, `#search-word` | Case sensitivity + whole-word toggles |
| Folder search results | `#folder-search-results` | One card per file with up to 12 match previews |
| Recent list | `#recent-list` | Last 20 opened files |
| Outline / TOC | `#toc` | h1-h6 scroll-spy table of contents |
| Find bar | `#find-bar` | In-document find with prev/next |
| Lightbox | `#lightbox` | Full-screen image / mermaid viewer |
| Resize handle | `#resize-handle` | Sidebar width drag |

## Themes

- `auto` — follows `prefers-color-scheme`
- `light`
- `dark`

Toggle via Cmd+D, the theme button, or `View → Toggle Theme` menu. Mermaid theme switches in lockstep.

## Workflows / Use Cases

| Workflow | Trigger | Steps |
|---|---|---|
| Open file via dialog | `Cmd+O`, `File → Open File…`, `Open File` button, or `files-empty-open` button | `pickFile()` → `openDialog` RPC → renderer renders `FilePayload` |
| Open file via drag-and-drop | Drop `.md` on window | `drop` handler reads `file.path` (Bun extension) → `readFile` RPC → render |
| Open file via file association | Double-click `.md` in Finder/Explorer | LaunchServices/Win Shell → app launch → argv recovery via Bun.argv / MV_PENDING_URL / pending-file → `dispatchFile` |
| Open folder | `Cmd+Shift+O`, `File → Open Folder…`, `Folder` button | `pickFolder()` → `openFolderDialog` RPC → folder watch + render tree |
| Switch file via tree | Click file row in sidebar | `readFile` RPC → render; `highlightActiveFile(path)` |
| Folder-wide search | Type in search input | 250 ms debounce → `searchFolder` RPC → render hit cards; click hit → open file + jump to find query |
| Recent files | Cmd-click recent item | `readFile` RPC → render |
| Find in document | `Cmd+F` | Toggle find bar; live highlight, prev/next, count |
| Toggle theme | `Cmd+D`, theme button | `applyTheme` (mermaid reconfigured + last file re-rendered) |
| Toggle sidebar | `Cmd+\\`, View menu | `appEl.classList.toggle('sidebar-collapsed')` |
| Zoom | `Cmd+=`, `Cmd+-`, `Cmd+0` | `setZoom()` (clamped 0.6 - 2.5) |
| Reveal in Finder/Explorer | Right-click file in tree, status bar, or `Cmd+Shift+R` | `revealInFinder` RPC → `open -R` / `explorer /select,` |
| Print | `Cmd+P` | `window.print()` (renderer) |
| Export to HTML | `File → Export to HTML…` | RPC `exportHtml` collects rendered DOM + all CSS rules into a self-contained HTML file in user-chosen folder |
| Open external link | Click any `[external]` link | `openExternal` RPC → OS default browser |
| Lightbox image / mermaid | Click image or mermaid block | Open in modal overlay (svg-pan-zoom for diagrams) |
| Wikilink navigation | Click `[[Target]]` link | If folder is open and target matches a file, open it; else mark `.broken` |
| Internal-md link | Click `*.md` link | Resolve relative to current file's directory; `readFile` RPC |
| First-run EULA | Boot before window create | `ensureEulaAccepted()` → if no marker, show native dialog; on decline, `process.exit(0)` |

## Forms / Validation

There are no input forms. The only user-input fields are:

| Field | Validation |
|---|---|
| `#tree-filter` | Lowercase contains-match; no validation |
| `#folder-search-input` | Regex `escape` is performed (`src/bun/index.ts:287`) before `new RegExp()`; case + whole-word toggles control flags |
| `#find-input` | Find-in-doc query; same regex escaping |

## Reports / Exports

- Export to HTML — produces a single self-contained `.html` file with inline CSS and rendered body. No images embedded as files (existing data URLs are preserved; mermaid SVG is inline).
- Print — uses `window.print()` and the print stylesheet.

## Accessibility (P1 surface scan only — full audit deferred to P2)

Quick observations from `index.html` / `index.ts`:

| Aspect | Observation |
|---|---|
| Keyboard navigation | All major actions have keyboard accelerators (open, find, theme, zoom, reveal, print) |
| ARIA on icons | `theme-btn` has `aria-label="Toggle theme"`; `titlebar-spacer` has `aria-hidden="true"` |
| `aria-label` on buttons | Some buttons (e.g. `Copy code`) have `aria-label`; many do not |
| Focus management | No explicit focus restoration after lightbox close (potential WCAG SC 2.4.3 issue) |
| Color contrast | Not statically verified — depends on CSS in `index.css`. Worth a contrast pass against design tokens. |
| Drag-and-drop alternative | Yes — file/folder buttons + Cmd+O / Cmd+Shift+O |

Defer detailed WCAG 2.1 AA audit to P2 / P5 (UX spec).

## Wireframes

The brand-mark and broader UI direction are described in `docs/superpowers/specs/2026-05-04-brand-mark-design.md` (untracked, in-flight).
