---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/35-modernization-milestones.md
pipeline: brownfield
topic: 07-delivery-plan
title: "Modernization Milestones"
order: 1
audiences: ["delivery-lead", "build-agent"]
source_sha256: f6f2a97967f9fa1ae5eb3e7abfe7add74fde6291239d4de93dbe713f2651e71d
source_size: 5329
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Modernization Milestones — MarkDownViewer

## M1 — Hostile-content hardening (security floor)

**Goal**: Close every HIGH/MEDIUM hostile-content finding before public distribution. Establish DOMPurify, mermaid SVG re-sanitization, image path containment, and a renderer CSP as the security trust boundary.

**Closes**: SEC-001, SEC-002, SEC-003, SEC-004, SEC-005, SEC-007, MOD-001, MOD-002, MOD-003, MOD-004, MOD-005, MOD-006, UI-002, UI-003, UI-004, UI-005

**Definition of Done**:
- All Playwright hostile-content fixtures pass
- Mermaid SVG output is double-sanitized
- `resolveImage` returns `{error: "out-of-bounds"}` for any path outside docDir
- CSP meta tag is in `index.html` and CSP-violation log is empty for the golden corpus
- Front-matter parse errors are visible
- bun debug log uses `os.tmpdir()` and rotates at 10 MB
- Color contrast verified WCAG AA in both themes
- Lightbox close restores focus
- All icon-only buttons have `aria-label`

**Estimated stories**: 9

## M2 — Distribution & test foundation

**Goal**: Make the application releasable without SmartScreen / Gatekeeper friction. Establish a test foundation that prevents regressions.

**Closes**: ENH-014, ENH-015, ENH-016, ENH-020, ENH-021, MOD-008, MOD-009, FR-09, FR-10, FR-11, FR-12, SR-07, SR-08, SR-09, DEBT-002, DEBT-003, SCA-002, DESIGN-001, DESIGN-003, UI-001, UI-006

**Definition of Done**:
- macOS .app code-signed with Apple Developer ID + notarized + stapled
- Windows .exe + Inno Setup installer Authenticode-signed
- THIRD_PARTY_LICENSES.md generated from `bun.lock` and surfaced via `Help → License…`
- CI runs `bun audit` (or OSV) on every PR; fails on HIGH/CRITICAL CVE
- Playwright suite ≥ 25 tests covering golden render + hostile fixtures + UI smoke
- axe-core a11y test in Playwright passes
- Visual regression baseline in place
- `engines.bun` pinned in `package.json`
- Design tokens aligned: every CSS variable maps to a token in `design-tokens.json`

**Estimated stories**: 8

## M3 — Multi-format editor (Notepad++-class)

**Goal**: Add edit-mode with tabs, format adapters, and shared preview pipeline. Build directly on the M1-hardened renderer.

**Closes**: FR-13, ENH-001, ENH-002, IR-13-01..05

**Definition of Done**:
- Tab UI in renderer: open/close, dirty indicator, format selector
- New RPC handlers: `saveFile`, `detectFormat`; `readFile` accepts `intent: "edit"`
- Per-tab editor state with autosave (5 s, signal-only message — no content over RPC)
- Save = write tmp + rename (atomic)
- Save-conflict detection: if the file changed on disk while editing, prompt before save
- Format adapters: markdown (default), plain-text. JSON / YAML / TOML deferred unless quick.
- Editor preview pane reuses the M1-hardened pipeline (same DOMPurify boundary)
- Playwright test coverage for: open in edit mode, edit + autosave, save conflict, tab close with unsaved changes

**Estimated stories**: 12

## M4 — Polish & domain extensions

**Goal**: Code-split the bundle, add PDF export, opt-in update channel, opt-in crash report, code-quality debt sweep.

**Closes**: ENH-006, ENH-011, ENH-018, ENH-019, ENH-022, ENH-023, ENH-024, ENH-025, MOD-007, PERF-001, PERF-002, DEBT-001, DEBT-004, DEBT-005, DEBT-006, DEBT-007, DEBT-008, DEBT-009, DEBT-012, DEBT-013, DEBT-014, FOR-007, SCAN-002, SCAN-003, SCAN-004, SCAN-005, SCAN-006

**Definition of Done**:
- Mermaid + KaTeX bundles lazy-loaded based on placeholder presence
- PDF export via existing print pipeline OR shell-out (TBD per architecture review)
- Update-check opt-in (single HTTPS HEAD per launch when enabled); CSP exception in bun process only
- Crash report opt-in: `Help → Save crash report…` writes log + system info to user-chosen path
- Theme cache: parsed HTML cached by content hash; only mermaid re-renders on theme change
- All DEBT items closed (constants extracted, escAttr deduped, types tightened, dead code removed)

**Estimated stories**: 10

## Sequencing & Dependencies

```
M0 (current state)
    │
    ▼
M1 (security floor) ◄── must complete before public distribution
    │
    ▼
M2 (signing + tests) ◄── enables public distribution
    │
    ▼
M3 (editor) ◄── builds on M1 trust boundary
    │
    ▼
M4 (polish)
```

M1 → M2 → M3 → M4 is the recommended sequence. M2 can overlap with the tail of M1 (Playwright-suite buildout proceeds while M1 stories land). M3 should NOT start before M1 closes — adding write-mode without the hardened read-mode would compound risk.

## Cumulative Story Count

| Milestone | Stories | Cumulative |
|---|---|---|
| M1 | 9 | 9 |
| M2 | 8 | 17 |
| M3 | 12 | 29 |
| M4 | 10 | 39 |

## Risk-by-Milestone

| Milestone | Risk | Mitigation |
|---|---|---|
| M1 | DOMPurify hardening could break legitimate user content | Rich Playwright golden corpus before tightening allowlist |
| M2 | Code-signing infrastructure setup is one-time but can be fiddly | Use cloud-signing services (e.g. SignPath, Apple Developer cloud); document in `28-modernization-architecture-decisions.md` |
| M3 | Editor introduces new write surface — autosave + save-conflict edge cases | TDD for save logic; user-prompt for any potential clobber |
| M4 | Update-check brings the first network egress | Opt-in only; CSP keeps it strictly bun-process; signed manifest |
