---
cobolt_published: true
canonical: _cobolt-output/latest/planning/implicit-requirements.md
pipeline: plan
topic: 01-product
title: "Implicit Requirements"
order: 4
audiences: ["product", "delivery-lead", "stakeholder"]
source_sha256: 21bbccea3d97c363ce62421149fc330f2a7c135800239a4b243f70ae3bbec14d
source_size: 7170
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Implicit Requirements — MarkDownViewer

The explicit FRs in `24-modernization-prd.md` need supporting implicit requirements to avoid edge-case regressions. This document enumerates them.

## A. Per-FR Implicit Requirements

### FR-01 (Render markdown) — implicit

| ID | Implicit | Why |
|---|---|---|
| IR-01-01 | Empty document renders an empty content pane (not an error) | Avoid spurious error UI |
| IR-01-02 | UTF-8 BOM at start of file is stripped before render | The fixture `tests/text-io.fixtures/utf8bom-lf.txt` exists |
| IR-01-03 | Files >10 MB render with a "large file" warning + bypass mermaid auto-render | Performance |
| IR-01-04 | Read-only files render without trying to watch (file watch error logged but UI continues) | Reliability |
| IR-01-05 | Network drives / removable media: file watcher MUST fall back to poll if `fs.watch` errors | ENH-009 |

### FR-02 / FR-03 / FR-05 (DOMPurify + mermaid + style) — implicit

| ID | Implicit |
|---|---|
| IR-02-01 | Sanitization MUST NOT break legitimate KaTeX `<span class="katex">...</span>` markup |
| IR-02-02 | Sanitization MUST preserve the `data-mermaid-src-b64` attribute through the markdown→DOMPurify pass (mermaid renders later) |
| IR-02-03 | Sanitization MUST NOT strip relative `<a href="other.md">` links (used by internal-md routing) |
| IR-02-04 | After mermaid SVG sanitize, mermaid pan/zoom (svg-pan-zoom) MUST still attach correctly to the SVG element |
| IR-02-05 | DOMPurify allowlist MUST permit: `<details>`, `<summary>`, `<picture>`, `<source>` (already configured) |

### FR-04 (resolveImage path containment) — implicit

| ID | Implicit |
|---|---|
| IR-04-01 | Containment must work on Windows where `C:\Users\me\notes\` and `C:/Users/me/notes/` are both valid path separators |
| IR-04-02 | Symlinks: the resolved real-path must be under docDir (not just the lexical parent) — use `realpath` or `fs.realpathSync` |
| IR-04-03 | Junction points on Windows: same as symlinks |
| IR-04-04 | When the user opens a folder, ALL files in that folder tree are within the allowlist (so `[](sibling/file.md)` works) |
| IR-04-05 | When the user opens a single file (not via folder), only files in that file's directory are allowed |

### FR-06 (CSP) — implicit

| ID | Implicit |
|---|---|
| IR-06-01 | KaTeX inline `<style>` from `katex.min.css` MUST work (fonts loaded via local `views/mainview/katex/fonts/`) |
| IR-06-02 | mermaid generated styles MUST work (it injects per-diagram CSS) |
| IR-06-03 | The `bun.spawn` calls for `openExternal` are out-of-process and unaffected by renderer CSP |
| IR-06-04 | Future ENH-018 update-check requires CSP exception (or move check to bun process — preferred) |

### FR-07 (front-matter error visibility) — implicit

| ID | Implicit |
|---|---|
| IR-07-01 | Error banner is dismissible (does not occupy permanent space if user clicks away) |
| IR-07-02 | Error message must NOT include the offending YAML body (could contain user secrets they didn't realize were in the file) |
| IR-07-03 | The body of the document still renders (front-matter region treated as not-front-matter on parse failure) |

### FR-08 (rotating log) — implicit

| ID | Implicit |
|---|---|
| IR-08-01 | Concurrent appends from multiple bun processes (if user launches twice) must not corrupt the log; use process-id scoped log files OR rely on append-atomicity of small writes |
| IR-08-02 | Rotation rotates atomically (rename + reopen) — no log lost during rotation |
| IR-08-03 | If `os.tmpdir()` is read-only (rare CI / sandboxed env), bun MUST fall back to silent/in-memory and surface a one-time renderer warning |

### FR-09 (code signing) — implicit

| ID | Implicit |
|---|---|
| IR-09-01 | CI signing keys MUST be stored in encrypted secrets (GitHub Actions secrets); never in repo |
| IR-09-02 | Notarization waits MUST not block dev PR builds (only release tags trigger notarization) |
| IR-09-03 | Signed installers MUST verify chain on the user's machine (Inno Setup auto-verifies on Windows; macOS Gatekeeper auto-verifies the .app) |

### FR-10 (THIRD_PARTY_LICENSES.md) — implicit

| ID | Implicit |
|---|---|
| IR-10-01 | Generation MUST run from `bun.lock` (not `package.json` ranges) so versions are exact |
| IR-10-02 | The file SHOULD link to source for each MIT/BSD/Apache/MPL dep |
| IR-10-03 | Help → License menu opens the file with the user's default `.md` viewer (which may be this app — circular but fine) |

### FR-11 (CI vulnerability scan) — implicit

| ID | Implicit |
|---|---|
| IR-11-01 | The scan MUST run on every PR, not just main |
| IR-11-02 | A new HIGH/CRITICAL CVE on existing deps MUST fail the build (so `--audit` runs in CI even on docs-only PRs) |
| IR-11-03 | A waiver mechanism MUST exist for known false positives (file at `.security-waivers.json` with cve, expiry-date, justification) |

### FR-12 (Playwright suite) — implicit

| ID | Implicit |
|---|---|
| IR-12-01 | Test fixtures live in `e2e/fixtures/` with subdirs `golden/`, `hostile/`, `regressions/` |
| IR-12-02 | Each hostile fixture MUST assert that NO file content is leaked into the rendered DOM |
| IR-12-03 | Visual regression baseline images live in `e2e/snapshots/` and update via `bun test --update-snapshots` |
| IR-12-04 | Tests run in CI on macOS-latest + windows-latest; Linux deferred |

### FR-13 (multi-format editor M3) — implicit

| ID | Implicit |
|---|---|
| IR-13-01 | Editor and preview MUST share the same DOMPurify sanitize boundary |
| IR-13-02 | Save MUST atomically replace the file (write tmp → rename) to avoid partial writes on crash |
| IR-13-03 | If the file changed on disk while editor is open, prompt the user before saving (avoid clobber) |
| IR-13-04 | Autosave does NOT save on crash recovery without explicit user confirm |
| IR-13-05 | Format adapters MUST NOT execute user content as code (no `eval`, no dynamic imports) |

## B. Cross-cutting Implicit Requirements

| ID | Cross-cutting concern |
|---|---|
| IR-X-01 | Every RPC handler MUST log start + end (with duration) for debug builds |
| IR-X-02 | RPC errors MUST be reflected to the renderer, never silently swallowed |
| IR-X-03 | Hot-reload during dev (`electrobun dev --watch`) MUST not leak file watchers (close on hot-reload) |
| IR-X-04 | The bun process exits cleanly on app-quit (release watchers, write recent.json) |
| IR-X-05 | All UI strings are constants in the source (M3 i18n-readiness — strings not yet externalized but isolated in a way that allows future externalization) |

<!-- COBOLT_BROWNFIELD_FEATURE_TRACEABILITY:START -->

## Brownfield Feature Traceability

- Feature: FEAT-001 Brownfield modernization access slice
- Requirement IDs: FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, FR-009, FR-010, FR-011, FR-012, FR-013, NFR-001, NFR-002, NFR-003, NFR-004, NFR-005, NFR-006
- Coverage: product intent, user flow, UI states, wireframes, backend, middleware, API, data, integrations, auth, security, privacy, NFRs, observability, tests, rollout, service blueprint, spec contracts, accessibility, and architecture.

<!-- COBOLT_BROWNFIELD_FEATURE_TRACEABILITY:END -->
