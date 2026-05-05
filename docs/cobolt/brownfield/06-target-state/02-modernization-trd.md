---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/25-modernization-trd.md
pipeline: brownfield
topic: 06-target-state
title: "Modernization TRD"
order: 2
audiences: ["architect", "security", "build-agent"]
source_sha256: 3ab73b0ddf2f913b73ba002bc2d395bf9ffc173e1b84b20267668139683b2b13
source_size: 3673
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Modernization TRD — MarkDownViewer

## 1. Operational Requirements

| ID | Requirement |
|---|---|
| TR-OPS-01 | Crash diagnostics: a single combined log file with rotation; user can copy via `Help → Save crash report…` (deferred to ENH-019 / M4). |
| TR-OPS-02 | Telemetry: NONE by default. No external network calls without explicit user opt-in. |
| TR-OPS-03 | Update channel: opt-in. If enabled, single HTTPS HEAD request to a versioned manifest URL once per launch. (Deferred ENH-018.) |
| TR-OPS-04 | Crash recovery: on bun-process exit, renderer shows non-blocking banner "Backend unavailable — restart Markdown Viewer". (ENH-013.) |

## 2. Build / Distribution Requirements

| ID | Requirement |
|---|---|
| TR-BUILD-01 | macOS arm64 + x64 builds via `electrobun build --release`. Notarized + stapled. |
| TR-BUILD-02 | Windows x64 build via `electrobun build --release` then Inno Setup. Code-signed `.exe` + signed installer. |
| TR-BUILD-03 | Linux build (deferred): tar.gz + .deb + AppImage. Out of M1/M2 scope. |
| TR-BUILD-04 | CI matrix: macOS-latest + windows-latest. Both run `bun audit` and the Playwright domain suite. |
| TR-BUILD-05 | Reproducibility: `bun.lock` committed; `engines.bun` pinned in `package.json` (closes DEBT-003). |

## 3. Infrastructure Requirements

| ID | Requirement |
|---|---|
| TR-INFRA-01 | No backend services, no databases, no caches. The app is fully local. |
| TR-INFRA-02 | The CoBolt-generated `_cobolt-docker/docker-compose.yml` is dev-only and is NOT shipped in the distribution. (See OPS-001 — outside-app remediation.) |
| TR-INFRA-03 | Update manifest hosting: GitHub Releases or static CDN, served over HTTPS. (Deferred to ENH-018.) |

## 4. Data Governance

| ID | Requirement |
|---|---|
| TR-DATA-01 | Persistent user data: `recent.json` (max 20 entries), EULA marker, sidebar-w localStorage. NO PII. NO PHI. NO regulated data. |
| TR-DATA-02 | The bun debug log MUST NOT include user file contents — only paths, timestamps, render-counter telemetry, error messages. |
| TR-DATA-03 | EULA marker file MUST be created with `0644` permissions (not world-writable) on Linux/macOS. |
| TR-DATA-04 | `Export to HTML` writes to a user-chosen folder; filename is sanitized to `[A-Za-z0-9._-]`. |

## 5. Performance Targets

| Metric | Target | Method |
|---|---|---|
| Startup time (cold launch with no file) | ≤ 1.5 s | Manual measurement on M1 / Ryzen 5 |
| Open 50 KB doc (no mermaid) | ≤ 300 ms | Performance timing in `renderFile` |
| Open 50 KB doc (with 20 mermaid) | ≤ 1.5 s | Performance timing in `renderFile` |
| Theme toggle on 50 KB doc | ≤ 200 ms (after MOD-007 cache) | Performance timing |
| Folder search on 1000 files | ≤ 1 s | RPC roundtrip + render |
| Memory footprint | ≤ 250 MB resident | Activity Monitor / Task Manager |

## 6. Reliability

| Aspect | Requirement |
|---|---|
| File watcher | Survives ENOENT (file deleted), ENOSPC (network share full); falls back to poll if `fs.watch` fails. (ENH-009 — deferred.) |
| RPC error | Renderer surfaces non-blocking error banner; never throws unhandled rejection. |
| Rendering error | Mermaid parse errors render an in-place `.mermaid-error` block with the source. (Already implemented at `src/mainview/index.ts:283-288`.) |

## 7. Compliance

| Framework | Status |
|---|---|
| GDPR | Out of scope — no personal data processed |
| HIPAA | Out of scope — no PHI |
| SOC2 | Out of scope — no service offering |
| PCI-DSS | Out of scope — no payment data |
| DPDP | Out of scope |
| FedRAMP | Out of scope |
| **License compliance (MIT-Non-Resale + MPL-2.0 attribution)** | In scope; closed by FR-10 / MOD-008 |
