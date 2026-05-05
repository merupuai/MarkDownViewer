---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/23-master-assessment.md
pipeline: brownfield
topic: 05-synthesis
title: "Master Assessment"
order: 4
audiences: ["architect", "delivery-lead", "stakeholder"]
source_sha256: 865d1b31c127b0c860e9dfd9b86b29a3d0573fedd0cf8a97da3e1015fb911db1
source_size: 6489
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Master Assessment — MarkDownViewer

**Mode**: `--scan full` (P0-P6 modernization packet)
**Scope**: Current working directory only (CWD-or-descendant policy)
**Method**: Main-context analysis + 11 deterministic Security Wave 3 tools + Phase 2.5 forensic synthesis
**Generated**: 2026-05-04

## Executive Summary

MarkDownViewer is a **well-engineered, narrow-scope desktop application** — a native macOS / Windows / Linux markdown viewer built on Electrobun (Bun + WebKit/WebView2). The codebase is small (~2000 LOC TypeScript), single-window, and has **no network, no database, no auth, no remote attack surface**.

Health Score: **82/100** (cobolt-health). Net assessment grade: **B+** — the application is production-quality for its current viewing scope. The actionable gaps cluster around:

1. **The markdown rendering pipeline as a security trust boundary** — 3 HIGH/MEDIUM hostile-content findings (SEC-001, SEC-002, SEC-003) and 4 LOW (SEC-004, SEC-005, SEC-006, SEC-007).
2. **Distribution readiness** — code signing (Windows), notarization (macOS), THIRD_PARTY_LICENSES.md, OSV scan in CI.
3. **Test coverage** — Playwright is scaffolded but no domain tests are written.
4. **In-flight expansion** — the planned Notepad++-class multi-format editor is the natural P4-P6 modernization scope.

## Project Profile

| Field | Value |
|---|---|
| Project | MarkDownViewer |
| Type | Desktop application |
| Runtime | Bun 1.x + Electrobun 1.17.3-beta.12 (WebKit/WebView2 view) |
| Languages | TypeScript (9 files), Swift (2 helpers), JavaScript (2 generated), Shell (2 installers) |
| Total LOC | ~1976 (TS source) |
| Code style | Tab indentation, mostly arrow-function callbacks, type-safe RPC |
| License | MIT (Non-Resale Variant), © 2026 MFTLabs · Developed by CoBolt |
| Platforms | macOS arm64+x64 primary; Windows; Linux |
| Distribution | Inno Setup (Windows), .app bundle (macOS), Linux not yet packaged |
| Dependencies | 14 production npm + 4 dev |
| Test scaffolding | Playwright config exists; no domain tests written |
| In-flight work | brand-mark spec, multi-format editor plan (Notepad++-class) |

## Findings Roll-Up

### Severity distribution (`16-issues-registry.json`)

| Severity | Count |
|---|---|
| critical | 0 |
| high | 2 (SEC-001, OPS-001) |
| medium | 3 (SEC-002, SEC-003, DEBT-002) |
| low | 18 |
| info | 4 |

### By category

| Category | Count |
|---|---|
| security | 8 |
| code-quality | 6 |
| supply-chain | 3 |
| performance | 2 |
| architecture | 2 |
| verified-false-positive | 2 (ILL-001, ILL-002) |
| license-compliance | 1 |
| reproducibility | 1 |
| ops | 1 (CIS — outside-app) |
| reliability | 1 |

### CWE coverage

| CWE | Count |
|---|---|
| CWE-79 (XSS / improper neutralization) | 2 (SEC-001, SEC-003) |
| CWE-22 (Path Traversal) | 1 (SEC-002) |
| CWE-87 (Alternate XSS Syntax) | 1 (SEC-001) |
| CWE-200 (Information Exposure) | 1 (SEC-002) |
| CWE-201 (Information Exposure Through Data) | 1 (SEC-003) |
| CWE-209 (Information Exposure via Error Message) | 1 (SEC-004) |
| CWE-377 (Insecure Temporary File) | 1 (SEC-005) |
| CWE-693 (Protection Mechanism Failure) | 1 (SEC-007) |
| CWE-754 (Improper Check for Unusual / Exceptional Conditions) | 1 (SEC-004) |

## Architecture Health (cobolt-arch-reviewer dimensions)

| Dimension | Score | Notes |
|---|---|---|
| Layer separation | 9/10 | Clean: bun (main), mainview (renderer), shared/rpc (contract) |
| Coupling | 9/10 | Single typed RPC interface; no leaky abstractions |
| Dependency direction | 10/10 | No circular imports; rpc.ts is a pure type contract |
| API design | 9/10 | RPC schema clear; consider versioning when schema evolves |
| Data model | n/a | No DB |
| Module surface | 8/10 | A few module-level globals in mainview/index.ts (acceptable scope) |

## Quality Health

| Dimension | Score | Notes |
|---|---|---|
| Naming conventions | 9/10 | Clear; one duplication (`escAttr`) |
| Error handling | 7/10 | A handful of silent `catch {}` (SEC-004, FOR-007/008) |
| Dead code | 9/10 | One small dead increment in `searchInFolder` (SCAN-005) |
| Duplication | 9/10 | Minor (`escAttr`); otherwise factored well |
| Anti-patterns | 9/10 | None significant; six `// @ts-expect-error` are pragmatic but flag-worthy |
| TypeScript hygiene | 8/10 | A few `any`-typed plugin hooks (SCAN-004) |

## Performance Health

No hot-path issues observed. Two LOW recommendations (PERF-001 stylesheet rules, PERF-002 theme re-parse).

## Security Health

| Dimension | Score | Notes |
|---|---|---|
| Network attack surface | n/a | No server |
| Auth / Authz | n/a | No auth model |
| Input validation | 6/10 | DOMPurify is the gate; allowlist needs SEC-003 hardening; `resolveImage` needs SEC-002 containment |
| Secrets | 10/10 | None present in code or env (entropy scan: 0 findings) |
| Crypto | n/a | No crypto code |
| Trust boundaries | 6/10 | Mermaid loose-mode + post-purify SVG injection (SEC-001) is the headline gap |
| Defense in depth | 6/10 | No CSP (SEC-007) |
| Dependency CVEs | 9/10 | None detected; minor pinning gap (SCA-001) |

## Compliance / Standards Posture (advisory at P3; gated at P5.5)

| Standard | Status |
|---|---|
| ISO/IEC 25010 (Quality Attributes) | Advisory pending P5.5 gate; preliminary read indicates B+ overall, with maintainability & functional suitability strong |
| ISO/IEC 5055 (CISQ Source Measures) | Advisory pending |
| ISO/IEC 42001 / NIST AI RMF | Not applicable (no AI components) |
| ISO/IEC 29148 (Requirements Quality) | Will be measured once 24-modernization-prd.md exists |
| DORA readiness baseline | Will be measured once delivery plan exists |
| GDPR / HIPAA / SOC2 / PCI-DSS / DPDP / FedRAMP | Out of scope (no regulated data) |

## Modernization Recommendation

The application is **well-positioned for forward investment, not migration**. Recommended modernization milestones (drives P4-P6 below):

1. **M1 — Hostile-content hardening** (close SEC-001, SEC-002, SEC-003, SEC-007). Ships defensible viewer.
2. **M2 — Distribution & test foundation** (code signing, notarization, OSV scan in CI, Playwright smoke + hostile-content fixtures).
3. **M3 — Multi-format editor (Notepad++-class)** — the in-flight expansion. Builds on top of the rendering pipeline.
4. **M4 — Polish & domain extensions** (PDF export, bibtex, custom mermaid theme, code-split bundle).

This plan keeps the app's "narrow-scope desktop" identity while raising the security floor to match the user's threat model.
