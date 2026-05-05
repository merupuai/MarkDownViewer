---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/27-modernization-system-architecture.md
pipeline: brownfield
topic: 06-target-state
title: "Modernization System Architecture"
order: 7
audiences: ["architect", "security", "build-agent"]
source_sha256: 1bae3e409ca7f5909e645d6fadc6d67ecc1b7dae4e191e59fa1f3d6353efd8e6
source_size: 6909
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Modernization System Architecture — MarkDownViewer

## 1. Architecture Style

**Two-process Electrobun desktop application** — preserved from current architecture. No replatform.

```
                    ┌────────────────────────────────┐
                    │  Markdown Viewer (.app/.exe)   │
                    │                                │
   user opens .md ─►│  Bun process     ◄══RPC══►   │
                    │  (file IO, watchers,           │
                    │   recents, EULA, menus)        │
                    │                                │
                    │  Mainview (WebKit/WebView2)    │
                    │  ├── markdown-it pipeline      │
                    │  ├── DOMPurify (boundary)      │
                    │  ├── mermaid + post-sanitize  ◄─── NEW (M1)
                    │  ├── KaTeX                     │
                    │  ├── highlight.js              │
                    │  └── CSP (meta tag)           ◄─── NEW (M1)
                    └────────────────────────────────┘
```

## 2. C4 Layers

### L1 System Context (unchanged)

User ─[double-click .md]─► Markdown Viewer ─[reads]─► local filesystem

### L2 Containers

| Container | Purpose | Tech | Changes from current |
|---|---|---|---|
| Bun process | File IO, RPC backend, watchers, native menus, EULA, OS-spawns | Bun + Electrobun + node:fs | M1: portable log path, M3: write-mode RPC handlers |
| Mainview view | UI rendering, markdown pipeline, sanitizer, mermaid, KaTeX | Electroview WebKit/WebView2, vanilla DOM, TypeScript | M1: SVG re-sanitization, hardened DOMPurify config, CSP; M3: editor mode + tabs |
| RPC contract | Cross-process schema | TypeScript types in `src/shared/rpc.ts` | M3: add editor-mode RPC (open with `intent:edit`, save, autosave) |
| Build pipeline | Produces .app + signed installer | electrobun build + Inno Setup + (new) signing/notarization | M2: code signing + notarization in CI |

### L3 Components (mainview, post-M1)

```
mainview/
  index.ts                 (~900 LOC after M1; orchestration + RPC)
    ├── markdown.ts        (markdown-it pipeline; pure)
    ├── sanitize.ts        ◄── NEW (M1) — wraps DOMPurify with hardened config
    ├── mermaid-render.ts  ◄── NEW (M1) — render + post-sanitize SVG
    ├── csp.ts             ◄── NEW (M1) — emit/verify CSP meta
    ├── find-in-doc.ts     (in-doc find controller; unchanged)
    ├── lightbox.ts        (overlay viewer; unchanged)
    └── editor/            ◄── NEW (M3) — multi-format editor
         ├── tabs.ts
         ├── editor-state.ts
         └── format-adapters/
              ├── markdown.ts
              ├── plain-text.ts
              └── ... (per-format adapters)
```

### L3 Components (bun, post-M3)

```
bun/
  index.ts                 (orchestration)
    ├── license-gate.ts    ◄── extract from index.ts
    ├── file-ops.ts        ◄── extract; add write/save (M3)
    ├── folder-ops.ts      ◄── extract; add file-system events for editor mode (M3)
    ├── recents.ts         ◄── extract
    ├── image-resolver.ts  ◄── extract; add path containment (M1)
    ├── log.ts             ◄── NEW (M1) — portable rotating log
    └── rpc.ts             (defineRPC site)
```

## 3. Architecture Decisions

See `28-modernization-architecture-decisions.md`.

## 4. Trust Boundaries

```
External markdown content (HOSTILE)
   │
   ▼ markdown-it parse (html: true permitted)
   │
   ▼ DOMPurify (HARDENED — no url() in style; SVG profile for SVG flow)
   │
   ▼ DOM injection (renderer)
   │     ├── For mermaid blocks: extra DOMPurify pass on the SVG output
   │     └── For images: data-rel-src is resolved via RPC.resolveImage
   │
   ▼ RPC.resolveImage (CONTAINMENT — must be within docDir + image MIME)
   │
   ▼ Bun.file() read (OS file ACL)
   │
   ▼ Returned base64 data URL or {error}
   │
   ▼ Renderer assigns to img.src (data: only)
```

The renderer also runs under a **renderer Content Security Policy** (M1) which blocks `connect-src` (no network egress), `frame-src` (no iframes), `object-src` (no plugins), and `base-uri` (no base-tag URL hijacks).

## 5. Cross-cutting

| Concern | Approach |
|---|---|
| Logging | Portable `os.tmpdir()/mdv-bun.log`, 10 MB rotating (M1) |
| Error reporting | Structured via `dbg(...)` and `rlog(...)`; no empty catches |
| Configuration | `electrobun.config.ts` is single-source; no runtime config files (out of scope) |
| Theming | Auto/light/dark with mermaid theme synchronization. Post-MOD-007: cached parse tree, only mermaid re-renders on theme |
| Telemetry | None unless explicit user opt-in for update-check (M4 / deferred) |

## 6. Distribution Architecture

```
Source (GitHub) ─► CI (GH Actions matrix: macOS-latest + windows-latest) ─►
   ├── bun install --frozen-lockfile
   ├── bun audit (FAIL on HIGH/CRITICAL CVE)
   ├── electrobun build --release
   ├── (mac) codesign + notarize + staple
   ├── (win) signtool + Inno Setup + signtool installer
   ├── playwright tests (golden + hostile)
   └── upload to GitHub Releases
       ├── checksums.txt (SHA-256)
       └── (later) GPG signature
```

## 7. What Stays the Same

- Two-process model
- Electrobun runtime (track GA per DEBT-001)
- markdown-it / DOMPurify / mermaid / KaTeX / highlight.js stack
- File-association registration
- Single-window UX (the M3 editor adds tabs WITHIN the window, not multiple windows)
- License gate (small permission-mode hardening only)

## 8. What Changes

### M1 — Hostile-content hardening
- Renderer CSP meta tag
- DOMPurify config tightening (SR-03)
- Mermaid SVG re-sanitization (SR-01)
- resolveImage path containment + MIME enforcement (SR-02 / SR-05)
- Front-matter parse error visibility (SR-06)
- Portable rotating log (SEC-005)

### M2 — Distribution & test foundation
- Code signing on both platforms
- Notarization on macOS
- THIRD_PARTY_LICENSES.md generation
- OSV scan in CI
- Playwright domain test suite + hostile-content fixtures

### M3 — Multi-format editor
- New editor mode RPC handlers (open-write, save, autosave, format-change)
- Tabbed UI in renderer
- Format adapters (markdown / plain text / others per existing plan)
- Reuse rendering pipeline as preview pane

### M4 — Polish & extensions
- Code-split mermaid + KaTeX bundles
- PDF export
- Auto-update opt-in
- Crash report opt-in
- Mermaid user theme config (after SR-01 lands)
