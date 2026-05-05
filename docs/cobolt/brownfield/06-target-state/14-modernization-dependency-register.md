---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/33-modernization-dependency-and-integration-register.md
pipeline: brownfield
topic: 06-target-state
title: "Modernization Dependency Register"
order: 14
audiences: ["architect", "security", "build-agent"]
source_sha256: c7b4d0a65a8f28207ddbd1fe8ee59ab41e1345c00710e377fd8fd5a8fc1dfc12
source_size: 4691
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Dependency & Integration Register — MarkDownViewer

## 1. External-System Dependencies (post-modernization)

| Dependency | Type | Direction | SLO | Failure mode | Owner |
|---|---|---|---|---|---|
| (M1+) Apple Notarization Service | Code-signing | CI → Apple | Best-effort, sometimes hours | If service is down, release waits; daily PR builds unaffected | Apple |
| (M1+) Microsoft signtool / cloud signing | Code-signing | CI → Microsoft | Best-effort | Same | Microsoft |
| (M1+) GitHub Releases | Distribution | CI → GitHub | 99.9% | If unavailable, release waits | GitHub |
| (M1+) OSV.dev / `bun audit` data | Vulnerability scan | CI → OSV | 99% | Stale data falls back to package-name heuristics | OSV |
| (M4 deferred) Update manifest endpoint | Self-update | App → cdn (HEAD only, opt-in) | n/a | Silent | self-hosted (GitHub Releases redirect) |

**No runtime backend services.** The application has zero remote runtime dependencies.

## 2. Build-time Tool Dependencies

| Tool | Why | Pinned? | M1 action |
|---|---|---|---|
| Bun | Runtime + package manager | NO (`engines.bun` missing) | Pin (DEBT-003) |
| Electrobun | Desktop runtime | YES (`^1.17.3-beta.12`) | Track GA (DEBT-001) |
| TypeScript | Compile | implicit (electrobun bundles) | None |
| signtool.exe (Windows) | Code signing | n/a (CI image-provided) | Add to CI |
| codesign / notarytool (macOS) | Code signing + notarization | n/a (Xcode-provided) | Add to CI |
| Inno Setup | Windows installer | n/a (CI install step) | Already used |

## 3. Runtime Library Dependencies (npm)

See `09-supply-chain-and-vulnerability-review.md` for the full inventory and `sbom.json` for SBOM.

Critical-path libraries with hardening implications:

| Library | Hardening note |
|---|---|
| isomorphic-dompurify | Security boundary. Upgrades MUST verify the allowlist behavior is preserved (regression test). |
| markdown-it | If you change `html: false → true` or vice versa, security model changes. |
| mermaid | `securityLevel` setting is security-critical (see ADR-004). |
| gray-matter | Verify js-yaml's SAFE_SCHEMA on every upgrade. |
| highlight.js | Verify `ignoreIllegals: true` continues to work. |
| katex | `throwOnError: false` continues to be safe. |

## 4. OS Process Dependencies

| Process | Why | Failure mode |
|---|---|---|
| `osascript` (mac) | EULA / about dialogs | If killed, dialog times out; Bun.spawnSync exits non-zero; we treat as decline (correct) |
| `powershell` (win) | EULA / about dialogs | If killed, dialog times out; treat as decline |
| `zenity` / `kdialog` (linux) | EULA / about dialogs | If absent, fall back to permissive (CLI/headless mode) |
| `open` / `cmd /c start` | External link launching | If the command fails, RPC.openExternal returns `{ ok: false }` |
| `open -R` / `explorer /select,` | Reveal in Finder/Explorer | Same as above |
| `cp` / `plutil` (mac post-build) | Bundle icon install | `scripts/postwrap.ts` warns and continues if not present |

## 5. Filesystem Dependencies

| Path | Purpose | Failure mode |
|---|---|---|
| `<userDataDir>/recent.json` | Recent files | Created on first push; lost recents are non-critical |
| `<userDataDir>/eula-accepted-v1` | EULA marker | Lost = re-prompt (acceptable) |
| `os.tmpdir()` (M1) | Bun debug log | If readonly, fall silent (IR-08-03) |
| `<docDir>/...` | Image resolution | Containment-checked (M1 / SR-02) |

## 6. UX Readiness Per Dependency

For each external dependency that the user can encounter in error paths, the UI MUST reflect the failure:

| Dep | UX response on failure |
|---|---|
| `bun audit` (CI) | Build fails on PR; user sees CI status; not user-visible at runtime |
| GitHub Releases | n/a runtime |
| Apple notarization | If using a non-notarized build, Gatekeeper shows the standard "Cannot be opened" dialog. Recommendation in README. |
| Mermaid render | In-place `.mermaid-error` block; renderer continues |
| KaTeX render | KaTeX renders `\textcolor{red}{error}`; renderer continues |
| `resolveImage` containment failure | `<img>` shows alt text "[image not found: …]"; renderer continues |
| `openExternal` failure | Status banner "Could not open URL" (M2); today fails silently |
| File watcher failure | Renderer shows "File watch unavailable — manual reload (Cmd-R)" (M2); today only logs |

## 7. Dependency Update Policy

| Class | Update cadence |
|---|---|
| Security-critical (DOMPurify, markdown-it, mermaid, gray-matter, highlight.js, katex) | On every CRITICAL/HIGH CVE; otherwise quarterly |
| Runtime (Bun) | Track LTS; pin and bump on major releases |
| Electrobun | Track upstream; bump major when stable; minor on bug-fix |
| Dev tooling | As-needed |
