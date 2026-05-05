---
cobolt_published: true
canonical: _cobolt-output/latest/planning/architecture-decisions.md
pipeline: plan
topic: 02-architecture
title: "Architecture Decisions (ADRs)"
order: 5
audiences: ["architect", "platform-lead", "build-agent"]
source_sha256: 68292a061d66b647ba760a96eee8a3d6ed60b0ac4f48c1850f348426d1ca8fb8
source_size: 5640
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Architecture Decision Records — MarkDownViewer

## ADR-001 — Keep Electrobun (do not replatform to Tauri / Electron)

**Status**: Accepted
**Date**: 2026-05-04 (P3 → P4)
**Context**: Electrobun is in beta (1.17.3-beta.12). Tauri (Rust + WebView) and Electron (Chromium + Node) are mature alternatives.
**Decision**: Stay on Electrobun. Track GA via DEBT-001.
**Alternatives considered**:
- Tauri: would require Rust expertise; bundle size is comparable but build complexity is materially higher; LaunchServices argv recovery would still need a Swift launcher.
- Electron: 150 MB bundle vs. Electrobun's ~30 MB. Functional parity but materially heavier.
**Consequences**:
- We accept the risk of beta API churn
- We continue maintaining `scripts/cocoa-launcher.swift` and `scripts/postwrap.ts` workarounds
- We MUST track Electrobun upstream and re-evaluate at each major release

## ADR-002 — DOMPurify is the security trust boundary

**Status**: Accepted
**Date**: 2026-05-04
**Context**: Without DOMPurify, the markdown-it `html: true` setting would let hostile markdown inject arbitrary HTML.
**Decision**: All HTML injection sites in the renderer MUST go through `DOMPurify.sanitize` with a hardened, project-defined config.
**Consequences**:
- The DOMPurify allowlist (ADD_TAGS / ADD_ATTR / FORBID_TAGS) is a security-critical config — changes require security review
- Mermaid's SVG output requires a SECOND DOMPurify pass (SR-01) because it bypasses the markdown-it stage
- A future plugin SDK (out of scope) would have to render through this same boundary

## ADR-003 — Renderer Content Security Policy

**Status**: Accepted
**Date**: 2026-05-04
**Context**: Today the renderer has no CSP. With `html: true` markdown, a CSP is cheap defense-in-depth.
**Decision**: Add a CSP meta tag with `connect-src 'none'`, `frame-src 'none'`, `object-src 'none'`, `base-uri 'none'`. Allow `'unsafe-inline'` for scripts and styles because the app is local and the assets are app-controlled.
**Consequences**:
- Future "Check for updates" feature (ENH-018) will need a CSP exception or an out-of-renderer fetch (in the bun process)
- Telemetry / analytics SDKs are blocked by default (intentional)
- Mermaid + KaTeX must continue to operate with `'unsafe-inline'` styles

## ADR-004 — Mermaid SVG re-sanitization (do not lower securityLevel)

**Status**: Accepted
**Date**: 2026-05-04
**Context**: Mermaid is configured with `securityLevel: "loose"` because users use HTML in diagram labels.
**Decision**: Keep `securityLevel: "loose"` and sanitize the rendered SVG with DOMPurify before injection (SR-01).
**Alternatives considered**:
- `securityLevel: "strict"` — kills HTML-in-mermaid, breaking real diagrams.
- Sandbox mermaid in iframe — heavier; reconsider in M4 if needed.
**Consequences**:
- Mermaid bundle size is unchanged
- We pay one extra DOMPurify pass per mermaid block (negligible perf impact)

## ADR-005 — `resolveImage` path containment in the bun process

**Status**: Accepted
**Date**: 2026-05-04
**Context**: Today `resolveImage` reads any file the OS user can read.
**Decision**: Containment check enforced in the bun process (the only filesystem actor). Renderer doesn't need to validate paths — defense-in-depth at the privilege boundary.
**Alternatives considered**:
- Containment in renderer only — rejected; renderer is the less-trusted of the two processes.
**Consequences**:
- A markdown file at `~/notes/x.md` containing `![](../../.ssh/id_rsa)` returns `{error: "out-of-bounds"}`
- For `[\[Target]\]`-style cross-folder workflows, the user must explicitly open the parent folder

## ADR-006 — Multi-format editor reuses rendering pipeline as preview

**Status**: Accepted (M3 design)
**Date**: 2026-05-04
**Context**: The Notepad++-class editor expansion (in commit `af327fe` plan) requires a side-by-side edit + preview UX.
**Decision**: The existing rendering pipeline (markdown.ts → DOMPurify → render) becomes the preview-pane backend, called on every keystroke (debounced).
**Alternatives considered**:
- Two separate code paths (one for view-mode, one for editor preview) — rejected as duplication.
- Server-side / process-side rendering — rejected; the renderer process already does this efficiently.
**Consequences**:
- One rendering surface to harden, not two
- M1 hardening directly benefits M3
- Editor must NOT bypass DOMPurify under any circumstance, including "I trust this file because the user just typed it"

## ADR-007 — Code signing as a release-gate, not a build-gate

**Status**: Accepted
**Date**: 2026-05-04
**Context**: Daily builds vs. release builds.
**Decision**: PR-merge builds on `main` are unsigned (faster CI, no secret exposure). Tagged release builds are signed and notarized.
**Alternatives considered**:
- Sign every PR build — rejected; key exposure risk.
- Sign only on the release branch — adopted.
**Consequences**:
- Daily testers can install unsigned dev builds with `--no-quarantine` flag (mac) or admin approval (win)
- End users never install unsigned builds

## ADR-008 — No telemetry; opt-in only (M4 update-check is sole exception)

**Status**: Accepted
**Date**: 2026-05-04
**Context**: Privacy-by-default is a stated value; the app handles user content.
**Decision**: No outbound network calls without explicit user opt-in. The only candidate is the "Check for updates" feature (ENH-018), which when enabled makes a single HTTP HEAD per launch.
**Consequences**:
- Crash diagnostics are local-only (`Help → Save crash report…` writes to user-chosen path)
- The CSP `connect-src 'none'` enforces this at the renderer
