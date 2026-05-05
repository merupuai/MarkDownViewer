---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/36-modernization-epics-and-stories.md
pipeline: brownfield
topic: 07-delivery-plan
title: "Modernization Epics & Stories"
order: 2
audiences: ["delivery-lead", "build-agent"]
source_sha256: 6db4b2f20857e7349b0733eb77d17024ab3b36e8d5436435a4588a7d7bcbc1dc
source_size: 12700
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Epics & Stories — MarkDownViewer Modernization

## Epic M1 — Hostile-content hardening

### Story M1.S1 — Renderer Content Security Policy
**As** a user opening a hostile markdown file
**I want** the renderer to block all unauthorized network egress and embedded frames
**So that** a hostile inline `<style background:url(...)>` cannot exfil data

**Acceptance**:
- `src/mainview/index.html` contains a `<meta http-equiv="Content-Security-Policy">` with at minimum: `connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'`
- Playwright fixture `e2e/tests/hostile/csp-egress.spec.ts` confirms no network requests fire when rendering a hostile fixture
- KaTeX + mermaid + image rendering still work (golden corpus regression-free)

**Closes**: SEC-007, MOD-006, FR-06
**Estimate**: S

### Story M1.S2 — DOMPurify allowlist hardening (style attribute)
**As** a user
**I want** inline `style` attributes to be parsed but `url()` and `@import` to be stripped
**So that** hostile markdown cannot trigger external resource fetches via CSS

**Acceptance**:
- DOMPurify is configured to forbid `url()` and `@import` in `style` (via `ALLOWED_CSS` or post-sanitize string filter)
- Playwright hostile fixture: `<p style="background: url(http://evil.com/track)">` renders WITHOUT the `url()` reaching the DOM
- Legitimate styles (`color`, `font-weight`, `text-align`, etc.) still work in golden corpus

**Closes**: SEC-003, MOD-003, FR-05
**Estimate**: M

### Story M1.S3 — Mermaid SVG re-sanitization
**As** a user
**I want** mermaid diagram SVG output to be re-sanitized before injection
**So that** a hostile mermaid block cannot inject HTML via `securityLevel: "loose"` foreignObjects

**Acceptance**:
- `src/mainview/mermaid-render.ts` (new module) wraps `mermaid.render()` and runs `DOMPurify.sanitize(svg, {USE_PROFILES: {svg: true, svgFilters: true}})` on the result
- Playwright hostile fixture confirms `<foreignObject><script>...</script></foreignObject>` cannot inject
- Mermaid pan/zoom (svg-pan-zoom) still attaches correctly to the sanitized SVG
- All golden mermaid diagrams render unchanged

**Closes**: SEC-001, MOD-001, FR-03
**Estimate**: L

### Story M1.S4 — `resolveImage` path containment
**As** a user opening a hostile markdown file
**I want** the image resolver to refuse paths outside the document's directory
**So that** hostile `![](../../.ssh/id_rsa)` cannot exfil arbitrary local files

**Acceptance**:
- `src/bun/image-resolver.ts` (new module, extracted from `src/bun/index.ts:365-383`) verifies `realpathSync(resolved).startsWith(realpathSync(docDir))`
- Symlinks and Windows junctions are followed via `fs.realpathSync` (NOT just lexical `path.resolve`)
- When a folder is open, allowlist extends to all files in that folder tree
- Returns discriminated-union error: `{error: "out-of-bounds", resolved: ...}`
- Renderer shows alt text "[image not found: …]"
- Playwright hostile fixture confirms no file content leaks

**Closes**: SEC-002, MOD-002, FR-04, IR-04-01..05
**Estimate**: M

### Story M1.S5 — Image MIME enforcement
**As** a security boundary
**I want** `resolveImage` to refuse extensions outside the explicit allowlist
**So that** hostile `![](secrets.pem)` cannot read non-image files

**Acceptance**:
- `resolveImage` returns `{error: "unsupported-type", ext}` for any extension not in `[png, jpg, jpeg, gif, svg, webp, bmp, ico, avif]`
- The `application/octet-stream` fallthrough is removed
- Playwright hostile fixture confirms

**Closes**: SR-05 (part of MOD-002)
**Estimate**: S

### Story M1.S6 — Front-matter parse error visibility
**As** a user with a malformed YAML header
**I want** to see a clear error rather than silent dropping
**So that** I can fix my front-matter

**Acceptance**:
- `src/mainview/markdown.ts::parseDocument` captures the gray-matter error and threads it through `ParsedDoc`
- Renderer shows a dismissible warning banner above the document body
- Banner does NOT echo the offending YAML body (avoid IR-07-02 secret leak)
- Document body still renders

**Closes**: SEC-004, MOD-004, FR-07
**Estimate**: S

### Story M1.S7 — Portable rotating bun debug log
**As** a Windows user
**I want** the debug log to be written to a path that exists on my OS
**So that** diagnostic information is captured

**Acceptance**:
- `src/bun/log.ts` (new module) writes to `path.join(os.tmpdir(), "mdv-bun.log")`
- Rotates at 10 MB → `mdv-bun.log.1` (atomic rename + reopen)
- Concurrent process appends do not corrupt
- If `os.tmpdir()` is read-only, falls silent and renderer shows one-time warning

**Closes**: SEC-005, MOD-005, FR-08
**Estimate**: S

### Story M1.S8 — A11y sweep + lightbox focus restore
**As** a keyboard-only user
**I want** focus to return to the invoking control after the lightbox closes
**So that** I can continue navigating without losing context

**Acceptance**:
- Lightbox close restores focus to the element that opened it
- Color contrast verified WCAG AA in both themes (axe-core or manual)
- All icon-only buttons have `aria-label`
- Resize handle has `role="separator"` and `aria-orientation="vertical"`

**Closes**: UI-002, UI-003, UI-004, DESIGN-003
**Estimate**: M

### Story M1.S9 — EULA marker permission hardening
**As** a security control
**I want** the EULA marker file to be created with mode 0644 on Linux/macOS
**So that** it is not world-writable

**Acceptance**:
- `ensureEulaAccepted` calls `fs.chmodSync(EULA_MARKER, 0o644)` after write on Linux/macOS
- Existing markers are upgraded (one-time chmod on first launch after upgrade)

**Closes**: 26c-modernization-compliance-architecture.md § 4 EULA hardening
**Estimate**: XS

## Epic M2 — Distribution & test foundation

### Story M2.S1 — `engines.bun` pin + lockfile-strict CI install
**Acceptance**: `package.json::engines.bun` is set to a pinned version range; CI runs `bun install --frozen-lockfile`. Closes DEBT-003.
**Estimate**: XS

### Story M2.S2 — `bun audit` in CI on every PR
**Acceptance**: New CI step runs `bun audit` (or OSV scan); fails on HIGH/CRITICAL CVE; waiver mechanism via `.security-waivers.json`.
**Closes**: SCA-002, MOD-009, FR-11, IR-11-01..03. **Estimate**: S

### Story M2.S3 — THIRD_PARTY_LICENSES.md generation
**Acceptance**: Script in `scripts/gen-licenses.ts` reads `bun.lock` and emits `THIRD_PARTY_LICENSES.md`; included in app bundle; surfaced from `Help → License…` (new menu item next to existing).
**Closes**: DEBT-002, MOD-008, FR-10. **Estimate**: M

### Story M2.S4 — macOS code signing + notarization in CI
**Acceptance**: GitHub Actions secrets hold Apple Developer ID; release builds run `codesign` + `xcrun notarytool` + `xcrun stapler`. Tagged releases only.
**Closes**: ENH-021, SR-08 (mac), FR-09 (mac). **Estimate**: L

### Story M2.S5 — Windows code signing in CI
**Acceptance**: GitHub Actions secrets hold Authenticode cert; release builds sign .exe and Inno Setup installer.
**Closes**: ENH-020, SR-08 (win), FR-09 (win). **Estimate**: L

### Story M2.S6 — Playwright domain test suite
**Acceptance**: ≥ 25 tests in `e2e/tests/{golden,hostile,regressions}/`; covers all FRs and SRs; runs in CI on macOS and Windows; visual baseline in `e2e/snapshots/`.
**Closes**: ENH-014, ENH-015, ENH-016, FR-12, SR-09, IR-12-01..04. **Estimate**: XL

### Story M2.S7 — axe-core a11y in Playwright
**Acceptance**: Each test loads the rendered page and runs axe-core; fails on serious/critical violations.
**Closes**: UI-001. **Estimate**: S

### Story M2.S8 — Design-token alignment
**Acceptance**: All `var(--*)` references in `src/mainview/index.css` map to a key in `design-tokens.json`; build-time validator fails if not.
**Closes**: DESIGN-001. **Estimate**: M

## Epic M3 — Multi-format editor

(Per the existing plan in commit `af327fe` — 20 tasks across 4 phases. Reproduced here mapped to RTM.)

### Story M3.S1 — RPC contract: `saveFile` + `intent` on `readFile`
**Acceptance**: `src/shared/rpc.ts` is updated to add `saveFile` request and `intent?: "view"|"edit"` on `readFile`. TypeScript build passes.
**Estimate**: S

### Story M3.S2 — Atomic save (write tmp + rename)
**Acceptance**: `saveFile` writes to `path + ".tmp"` then `rename`; on failure, no partial write. Closes IR-13-02.
**Estimate**: M

### Story M3.S3 — Editor pane component
**Acceptance**: New `src/mainview/editor/editor-pane.ts` with monospace textarea, syntax-highlighted code (re-using highlight.js), keyboard shortcuts.
**Estimate**: L

### Story M3.S4 — Tab bar component
**Acceptance**: New `src/mainview/editor/tabs.ts` with open/close/dirty-indicator/active-state. Cmd-T opens new, Cmd-W closes, Cmd-1..9 switches.
**Estimate**: M

### Story M3.S5 — Per-tab editor state + autosave
**Acceptance**: `src/mainview/editor/editor-state.ts` tracks `EditorTab[]`; autosave fires every 5 s if dirty. `autosaveTick` message carries hash + bytes only (no content).
**Estimate**: M

### Story M3.S6 — Save-conflict detection
**Acceptance**: Before writing, the bun process compares file's mtime with the in-memory `lastReadAt`; if changed, returns `{error: "conflict"}`. Renderer prompts "Save anyway / Reload from disk".
**Closes**: IR-13-03. **Estimate**: M

### Story M3.S7 — Format detection
**Acceptance**: `detectFormat` RPC reads the first KB of the file + extension and returns `{format, confidence}`. Format ∈ {markdown, plain-text}. Confidence ≥ 0.8 = auto, < 0.8 = ask.
**Estimate**: M

### Story M3.S8 — Markdown format adapter
**Acceptance**: `src/mainview/editor/format-adapters/markdown.ts` defines monospace + line-wrap behavior + Cmd-K link / Cmd-B bold shortcuts. Preview = existing pipeline.
**Estimate**: M

### Story M3.S9 — Plain-text format adapter
**Acceptance**: Stub adapter that disables markdown rendering; preview shows plain text. Used as a regression baseline.
**Estimate**: S

### Story M3.S10 — Preview pane reuses rendering pipeline
**Acceptance**: Preview pane subscribes to editor changes (debounced 250 ms) and renders via the M1-hardened pipeline. Same DOMPurify, same CSP.
**Estimate**: M

### Story M3.S11 — Tab close with unsaved changes prompt
**Acceptance**: Closing a dirty tab prompts "Save / Discard / Cancel". Closes IR-13.
**Estimate**: S

### Story M3.S12 — Hostile-content fixtures for edit mode
**Acceptance**: Edit mode fixtures in `e2e/tests/hostile-edit/`: hostile content typed by user, hostile content from disk loaded into edit mode. Same security guarantees as view mode.
**Estimate**: M

## Epic M4 — Polish & extensions

### Story M4.S1 — Lazy-load mermaid + KaTeX bundles
**Acceptance**: Mermaid and KaTeX are dynamic imports gated on placeholder detection in rendered HTML. Bundle size with no diagrams + no math drops > 1 MB.
**Closes**: ENH-011, PERF-001. **Estimate**: M

### Story M4.S2 — Theme cache
**Acceptance**: `parseDocument` result cached by `(content-hash → ParsedDoc)`; theme toggle re-renders mermaid only.
**Closes**: PERF-002, MOD-007, NFR-02. **Estimate**: M

### Story M4.S3 — Code-quality debt sweep
**Acceptance**: All DEBT-004..014 items closed. Constants extracted, escAttr deduped, types tightened, dead code removed, tree-filter debounced.
**Estimate**: M

### Story M4.S4 — PDF export
**Acceptance**: `File → Export to PDF…` exports current document via the print pipeline (mac/linux), or shell-out to a PDF tool (TBD per architecture review).
**Closes**: ENH-006. **Estimate**: M

### Story M4.S5 — Update-check (opt-in)
**Acceptance**: Setting toggle in `Help → Preferences → Updates`. When enabled, single HTTPS HEAD per launch from bun process to update manifest. CSP exception is in bun, not renderer.
**Closes**: ENH-018. **Estimate**: L

### Story M4.S6 — Crash report opt-in
**Acceptance**: `Help → Save crash report…` copies bun debug log + system info to user-chosen path. No network call.
**Closes**: ENH-019. **Estimate**: S

### Story M4.S7 — Mermaid user theme config
**Acceptance**: `<userDataDir>/mermaid-theme.json` overrides default mermaid theme. Validated against schema. Only after SR-01 lands.
**Closes**: ENH-023. **Estimate**: M

### Story M4.S8 — TOC export to clipboard
**Acceptance**: `Edit → Copy Outline` puts a markdown skeleton on clipboard.
**Closes**: ENH-025. **Estimate**: XS

### Story M4.S9 — Image cache
**Acceptance**: `resolveImage` caches data URLs by `(docPath, src, mtime)`; LRU 100 entries.
**Closes**: ENH-024. **Estimate**: S

### Story M4.S10 — Bibtex citations (markdown-it-cite)
**Acceptance**: New plugin enabled in `buildMarkdown`; `[@key]` syntax resolves against a `references.bib` adjacent to the document.
**Closes**: ENH-022. **Estimate**: M
