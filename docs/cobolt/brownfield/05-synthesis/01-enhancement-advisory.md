---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/17-enhancement-advisory.md
pipeline: brownfield
topic: 05-synthesis
title: "Enhancement Advisory"
order: 1
audiences: ["architect", "delivery-lead", "stakeholder"]
source_sha256: e9424aabf6f587dc263e8aba24701e30fbbc3ae3c672c14297383811f89550bb
source_size: 6943
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Enhancement Advisory — MarkDownViewer

**Method**: Domain-aware scan (desktop markdown viewer with mermaid/KaTeX diagram support, single-window, Electrobun runtime). Gaps are evidenced by absence in the source tree.

## A. UX / Feature Enhancements

### ENH-001 — Markdown editing (write mode), not just viewing — alignment with in-flight `multi-format editor` plan (HIGH leverage)

The repo already contains a planned Notepad++-class editor expansion (commits `eb17b5b`, `af327fe`). The current viewer can render but not edit. Modernization should treat the editor as the **next major milestone**, not a separate project — the rendering pipeline is already there.

### ENH-002 — Multi-tab document interface (HIGH leverage)

A single-document workflow is limiting for users browsing a vault. Tabs + recently-closed-tabs would unlock parallel-document workflows. Already part of the multi-format-editor plan.

### ENH-003 — Outline drag-to-reorder (MEDIUM)

The outline pane (`#toc`) is read-only navigation. Bidirectional editing (drag a heading → reorder underlying markdown) is a power-user differentiator.

### ENH-004 — Wikilink autocomplete in search input (MEDIUM)

`[[Target]]` resolution is implemented; offer fuzzy match suggestions in folder-search.

### ENH-005 — Per-file metadata sidebar (MEDIUM)

Replace the front-matter card (modal-like top of doc) with a collapsible sidebar pane that always shows current file metadata (path, size, mtime, headings count, words, reading time). The status bar already shows a summary.

### ENH-006 — PDF export (in addition to HTML) (MEDIUM)

`Export to HTML` is implemented; PDF is a natural sibling. Use the existing print pipeline (`window.print()`) to a virtual PDF printer, or render via `electrobun` if it gains native PDF export, or shell-out to `wkhtmltopdf`/`weasyprint` (cross-platform packaging concern).

### ENH-007 — Custom CSS / theme variants (LOW-MEDIUM)

Currently 3 hardcoded themes (auto/light/dark). Allow a user CSS file in `<userDataDir>/custom.css` that the renderer imports. Limit by CSP after MOD-006 lands.

### ENH-008 — Reveal-in-Finder for folders (in addition to files) (LOW)

Folder rows in the tree have `contextmenu → revealInFinder(node.path)` already. Verify on Windows (`explorer /select,` on a folder reveals the parent — different UX from macOS `open -R`).

### ENH-009 — File watcher fallback for filesystems without inotify/FSEvents (LOW)

`fs.watch` is unreliable on network shares, NFS, certain Linux filesystems. Add `setInterval`-based stat-poll fallback with explicit user toggle.

### ENH-010 — Export of search results to a Markdown report (LOW)

After folder-search, "Export results as `.md` table" with file:line:preview rows.

## B. Architecture Enhancements

### ENH-011 — Code-split the renderer bundle (MEDIUM)

Mermaid (~1 MB) and KaTeX (~500 KB) are eager-loaded. For a typical document neither is needed. Lazy-load when the rendered HTML contains `.mermaid-pending` or `.katex` placeholders.

### ENH-012 — Move from `let` module globals to a `class App {}` instance (LOW)

`src/mainview/index.ts` declares many module-level `let` bindings. A small App class would scope state, enable explicit resource cleanup on hot-reload, and ease future testing. (Not urgent.)

### ENH-013 — Renderer-process IPC error boundary (MEDIUM)

If the bun process crashes (e.g. permission error in `Bun.file`), the renderer continues with stale state. Add a `bun.process.exited` listener that disables RPC-dependent UI affordances and shows a "Backend unavailable — restart Markdown Viewer" status row.

### ENH-014 — RPC contract test fixture (MEDIUM)

`src/shared/rpc.ts` is the truth for the bun↔mainview contract. Today there is no test that wires both ends to ensure the contract holds. Add a Playwright-driven smoke test that exercises every RPC method through the UI.

## C. Quality / Test Enhancements

### ENH-015 — Domain test suite (HIGH — currently 0 tests)

`e2e/playwright.config.js` and `e2e/tests/smoke.spec.js` exist but contain no domain tests (cobolt-init scaffolded the structure). Recommended priority test cases:

1. Open a `.md` file with mermaid + KaTeX + GFM alerts → verify each renders.
2. Hostile-content fixtures: front-matter trick, mermaid HTML injection, image path traversal.
3. Find-in-doc, find-in-folder, recent files.
4. EULA acceptance gate (with fresh user-data dir).

### ENH-016 — Snapshot tests for the markdown pipeline (MEDIUM)

Use Vitest or Bun's test runner to lock down `parseDocument` output for a corpus of fixture files (`tests/text-io.fixtures/` exists per source-contamination scan — already a testing seed).

### ENH-017 — Visual regression for theme variants (LOW)

Capture per-theme screenshots of a canonical document; diff on PR.

## D. Operational / Distribution

### ENH-018 — Auto-update channel (MEDIUM)

Electrobun's `bspatch.exe` is bundled (per pr-threat-scan output) so a binary-patch update path is technically present. Wire a "check for updates" UI affordance that respects user opt-in (privacy: announce that update checks make a single HTTP request).

### ENH-019 — Crash report opt-in (LOW)

Today `appendFileSync("/tmp/mdv-bun.log", ...)` is the only diagnostic. Offer an explicit "Help → Save crash report…" that copies the log + system info to a user-chosen location.

### ENH-020 — Code signing on Windows (HIGH for distribution)

Inno Setup script exists (`windows/MarkdownViewerSetup.iss`). Without a code-signing cert the installer triggers SmartScreen warnings. Plan for Authenticode signing in CI (with `signtool.exe`) before public distribution.

### ENH-021 — macOS notarization (HIGH for distribution)

Same story for macOS — Gatekeeper will refuse to run an unnotarized .app from outside the Mac App Store after first download. Plan notarization in CI.

## E. Domain-Specific Enhancements (Markdown ecosystem)

### ENH-022 — Citations / bibtex support (LOW)

The KaTeX/texmath stack is in place. Adding `markdown-it-cite` would close the gap with academic-writing tools.

### ENH-023 — Custom mermaid themes / config (LOW)

Today `securityLevel: "loose"` is hardcoded. Once SEC-001 closes (re-sanitize SVG), expose `~/.markdown-viewer/mermaid.config.json` for user-defined mermaid themes.

### ENH-024 — Image lazy-load + caching (LOW)

`resolveImage` reads on every render. For large documents with many images, cache resolved data URLs by `(docPath, src, mtime)`.

### ENH-025 — Table-of-contents export (LOW)

The Outline pane is in-app only. "Copy outline as Markdown" → put a `[[H1]] - [[H2-1]] ...` skeleton on the clipboard.

## Prioritization

| Priority | Items |
|---|---|
| Now (with modernization milestones) | ENH-001, ENH-002, ENH-014, ENH-015, ENH-020, ENH-021 |
| Next (post-modernization) | ENH-006, ENH-011, ENH-013, ENH-016, ENH-018, ENH-022 |
| Backlog | All others |
