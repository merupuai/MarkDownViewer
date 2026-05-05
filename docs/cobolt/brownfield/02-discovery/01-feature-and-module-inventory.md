---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/04-feature-and-module-inventory.md
pipeline: brownfield
topic: 02-discovery
title: "Feature & Module Inventory"
order: 1
audiences: ["architect", "security", "build-agent"]
source_sha256: b4052874563daa7c8efcfc0ad1a4c856eb10c487a55991430184e24a49381cfd
source_size: 11201
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Feature and Module Inventory — MarkDownViewer

**Generated**: 2026-05-04 (P1 discovery, main-context analysis)
**Scope**: 23 source files, ~1976 LOC TypeScript across 6 modules
**Method**: Direct read of every source file by orchestrator (project small enough to forgo agent dispatch)

## Architecture Overview

Two-process Electrobun desktop app:

```
┌──────────────────────────────────────────┐
│           src/bun/index.ts (main)        │
│  - File / folder I/O via Bun + node:fs   │
│  - File watchers (debounced)             │
│  - Recent-files JSON store               │
│  - Image base64 resolver                 │
│  - License (EULA) gate                   │
│  - Application menu wiring               │
│  - Native dialogs (osascript / PS / zenity)│
└──────────────────────┬───────────────────┘
              defineRPC<AppRPC>
                       │
┌──────────────────────▼───────────────────┐
│  src/mainview/index.ts (Electroview)     │
│  - markdown-it pipeline (markdown.ts)    │
│  - DOMPurify HTML sanitization           │
│  - mermaid 11.x diagram rendering        │
│  - KaTeX math rendering                  │
│  - highlight.js code highlighting        │
│  - Find-in-doc (find-in-doc.ts)          │
│  - Lightbox image viewer (lightbox.ts)   │
│  - File tree, recent files, search UI    │
│  - Theme (auto/light/dark)               │
└──────────────────────────────────────────┘
```

## Modules

### 1. `src/bun/index.ts` (670 LOC) — Backend / main process

| Section | Purpose | Key APIs |
|---|---|---|
| License gate (lines 16-168) | Enforce MIT-no-resale EULA at first run; persist marker file in OS user-data dir | `ensureEulaAccepted()`, `showEulaDialog()`, `showLicenseInfo()` |
| File ops (lines 184-217) | Read markdown file via `Bun.file`, watch for changes (debounced 80ms) | `readMarkdownFile()`, `watchFile()` |
| Folder ops (lines 220-276) | Walk a folder tree (depth ≤ 8, ≤ 5000 entries), watch recursively (debounced 250ms) | `walkFolder()`, `watchFolder()` |
| Folder search (lines 279-336) | Regex search across .md files (case/whole-word), bounded by hits + file-size + total-files | `searchInFolder()` |
| Recent files (lines 339-362) | Load/save last 20 opened files as JSON in `Utils.paths.userData/recent.json` | `loadRecent()`, `saveRecent()`, `pushRecent()` |
| Image resolver (lines 365-383) | Read image file from disk, return base64 data URL | `resolveImage(docPath, src)` |
| RPC dispatch (lines 402-512) | 12 request handlers + 3 message handlers via `BrowserView.defineRPC<AppRPC>` | `openDialog`, `openFolderDialog`, `readFile`, `resolveImage`, `getInitialFile`, `openExternal`, `revealInFinder`, `getRecent`, `clearRecent`, `searchFolder`, `exportHtml`, `ready`, `print`, `log` |
| Boot + argv recovery (lines 514-576) | Recover initial file path from launcher argv, env var `MV_PENDING_URL`, or `/tmp/mdv-pending-url-<pid>` file | `tryReadPendingUrlFile()`, `dispatchFile()` |
| Application menu (lines 578-660) | Native menu with File / Edit / View / Window / Help submenus | `ApplicationMenu.setApplicationMenu([...])` |

### 2. `src/mainview/index.ts` (813 LOC) — Frontend / renderer

| Section | Purpose | Key Symbols |
|---|---|---|
| RPC client (lines 10-23) | `Electroview.defineRPC<AppRPC>`; receive fileOpened / fileChanged / folderOpened / folderUpdated / menuAction | `electroview.rpc` |
| Log piping (lines 26-35) | Forward `console.log/warn/error` to Bun via RPC `log` message | `rlog()` |
| Theme (lines 38-61) | auto / light / dark, persists via prefers-color-scheme; Mermaid theme switches with body theme | `applyTheme()`, `toggleTheme()`, `effectiveTheme()` |
| Mermaid config (lines 63-72) | `securityLevel: "loose"`, `fontFamily: var(--font-sans)` | `configureMermaid()` |
| renderFile (lines 180-246) | Parse → DOMPurify sanitize → inject HTML; resolve images, render mermaid blocks, build TOC | `renderFile(payload, opts)` |
| renderMermaidBlocks (lines 259-290) | For each `.mermaid-pending` div, decode base64 source and call `mermaid.render(id, src)` | `renderMermaidBlocks()` |
| resolveImages (lines 352-398) | For each `<img>` tag with relative src, RPC `resolveImage` and replace src with returned data URL; click-to-lightbox | `resolveImages(docPath)` |
| TOC (lines 400-440) | Generate scroll-spy table of contents from h1-h6 | `buildTOC()`, `updateActiveTOC()` |
| File tree (lines 447-552) | Render folder tree; click → open; right-click → reveal in Finder | `renderFolder()`, `renderTreeNode()`, `applyTreeFilter()` |
| Folder search (lines 555-626) | Debounced (250ms) regex search across folder; click hit → open file + jump to find query | `scheduleFolderSearch()`, `runFolderSearch()`, `highlightInPreview()` |
| Recent files (lines 628-672) | Render recent list in sidebar + welcome screen; clear via RPC | `refreshRecent()`, `renderRecentInto()` |
| Click handler (lines 674-709) | Route external links (open via `Bun.spawn open/start`), wikilinks, internal-md links, anchor links | (anonymous handler) |
| Drag & drop (lines 748-767) | Drop a .md file → read via RPC and render | (window event listeners) |
| Menu actions (lines 770-786) | Dispatch on `menuAction` IPC: open-file, open-folder, reload, toggle-theme, find, etc. | `handleMenuAction(action)` |
| Keyboard shortcuts (lines 789-805) | Cmd-O, Cmd-D, Cmd-F, Cmd-+/-, Cmd-0, Cmd-Shift-O, Cmd-Shift-F, Cmd-Shift-R, Cmd-P, Cmd-\\, Cmd-= | (window keydown) |
| Boot (lines 807-813) | `electroview.rpc.send.ready({})` → fetch recent → fetch initial file | (IIFE) |

### 3. `src/mainview/markdown.ts` (230 LOC) — Markdown pipeline

| Function | Purpose |
|---|---|
| `buildMarkdown()` | Construct the markdown-it instance with html=true, linkify, typographer, custom highlight (mermaid → base64-encoded div, hljs for other langs) |
| `parseDocument(md, raw)` | Strip front-matter via `gray-matter`, render body to HTML |
| `renderFrontMatterCard(fm)` | Render a `<aside class="fm-card">` table of front-matter keys |
| `registerAlertsPlugin(md)` | GitHub-style alerts: `> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]` |
| `registerWikilinksPlugin(md)` | `[[Target]]` and `[[Target\|Alias]]` syntax → `<a class="wikilink" data-wikilink="true" href="Target">` |
| Link-open hook | Tag external links with `target="_blank" data-external="true"`; tag .md links with `data-internal-md` |
| Image hook | Tag relative images with `data-rel-src` so resolver can find them post-render |

### 4. `src/mainview/find-in-doc.ts` (135 LOC) — Find-in-document

In-document find bar with prev/next navigation and highlight (`<mark>`).

### 5. `src/mainview/lightbox.ts` (59 LOC) — Lightbox image viewer

Full-screen image overlay with svg-pan-zoom for diagrams.

### 6. `src/shared/rpc.ts` (69 LOC) — Type-safe RPC schema

Single source of truth for the bun↔mainview RPC contract (12 requests, 3 messages, 5 incoming events).

## Build / Tooling

| Script | Purpose |
|---|---|
| `package.json::dev` | `electrobun dev --watch` |
| `package.json::build` | `electrobun build` |
| `package.json::build:release` | `electrobun build --release` |
| `package.json::gen:icons` | `bun run scripts/gen-icons.ts` (uses `@resvg/resvg-js` + `png2icons`) |
| `scripts/postwrap.ts` | Post-build hook: install Cocoa launcher wrapper, copy `icon.icns`, patch `CFBundleIconFile` in Info.plist |
| `scripts/wrap-launcher.sh` | Bash wrapper for the Cocoa launcher binary |
| `scripts/cocoa-launcher.swift` | Native Swift launcher that captures argv before Bun loads (works around Electrobun launcher hardcoding `["./bun", resources_path]`) |
| `scripts/set-default-handler.swift` | Register .md file association with macOS LaunchServices |
| `scripts/install-macos.sh` / `scripts/install-windows.ps1` | OS installers |
| `windows/MarkdownViewerSetup.iss` | Inno Setup script for Windows installer (collects EULA acceptance click-through) |

## API / Endpoint Inventory

**No HTTP/REST endpoints, no GraphQL, no gRPC, no message queues, no webhooks, no scheduled jobs.**

The only "API surface" is the in-process RPC schema in `src/shared/rpc.ts` (Bun ↔ Electroview).

| RPC method | Direction | Purpose |
|---|---|---|
| `bun.requests.openDialog` | view → bun | Show native open-file dialog |
| `bun.requests.openFolderDialog` | view → bun | Show native open-folder dialog |
| `bun.requests.readFile` | view → bun | Read a markdown file by path |
| `bun.requests.resolveImage` | view → bun | Read image file → base64 data URL |
| `bun.requests.getInitialFile` | view → bun | Pull initial file (from argv/env/launcher) |
| `bun.requests.openExternal` | view → bun | Open URL in default browser |
| `bun.requests.revealInFinder` | view → bun | Reveal path in Finder/Explorer |
| `bun.requests.getRecent` | view → bun | Load recent files JSON |
| `bun.requests.clearRecent` | view → bun | Clear recent files JSON |
| `bun.requests.searchFolder` | view → bun | Regex search across markdown files in a folder |
| `bun.requests.exportHtml` | view → bun | Export current document as HTML to chosen folder |
| `bun.messages.ready` | view → bun | Renderer ready signal |
| `bun.messages.print` | view → bun | Trigger native print |
| `bun.messages.log` | view → bun | Append `[view <level>] <msg>` to `/tmp/mdv-bun.log` |
| `webview.messages.fileOpened` | bun → view | Push opened file payload to renderer |
| `webview.messages.fileChanged` | bun → view | Push file-change payload (preserves scroll) |
| `webview.messages.folderOpened` | bun → view | Push folder tree |
| `webview.messages.folderUpdated` | bun → view | Push updated folder tree (debounced) |
| `webview.messages.menuAction` | bun → view | Forward application menu click |

## Dead Code / Unused Symbols

- None detected by direct read. The illusion scan flagged `resolveImage(docPath, src)` (ILL-001) and `scheduleFolderSearch` (ILL-002) but **both are false positives** — see `12-security-and-quality-assessment.md` § Illusion Findings Triage.

## Complexity Hotspots

| Function | LOC | Cyclomatic (est.) | Notes |
|---|---|---|---|
| `src/bun/index.ts::showEulaDialog` | 50 | ~10 | Three OS branches; each has try/catch; permissive Linux fallback when no GUI tool |
| `src/bun/index.ts::searchInFolder` | 58 | ~12 | Inner walk fn + regex compile + bounded by 5 limits |
| `src/mainview/index.ts::renderFile` | 67 | ~9 | DOMPurify config + four post-render passes (images / mermaid / TOC / counters) |
| `src/mainview/index.ts::resolveImages` | 47 | ~8 | Per-image RPC call; click-handler attachment for lightbox |
| `src/mainview/index.ts::wireWikilinks` | 24 | ~6 | Three lowercase match candidates per link |

Cyclomatic complexity is moderate; nothing exceeds typical thresholds (< 15).
