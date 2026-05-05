---
cobolt_published: true
canonical: _cobolt-output/latest/planning/source-document-consolidation.md
pipeline: plan
topic: 01-product
title: "Source Document Consolidation"
order: 8
audiences: ["product", "delivery-lead", "stakeholder"]
source_sha256: 8ec70ea950d61c248db999716f3ac4ed655607346b68c23a88b814fe74aeb1f7
source_size: 10292
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Source Document Consolidation

> Canonical planning-side source packet synthesized from brownfield modernization artifacts.

- Primary input document: `_cobolt-output/latest/brownfield/24-modernization-prd.md`
- Brownfield source root: `_cobolt-output/latest/brownfield`
- Supplemental documents reviewed: 17

## Primary Planning Document

- File: `_cobolt-output/latest/brownfield/24-modernization-prd.md`
- Role: Primary product requirements input
- Summary: **Status**: Ready for review **Source assessment**: `23-master-assessment.md` **Scope verdict**: forward-invest (no replatform) Markdown Viewer is a fast, native, file-association-driven markdown reader that becomes the 

## Supplemental Documents

- `_cobolt-output/latest/brownfield/25-modernization-trd.md` â€” Technical and operational requirement input: | ID | Requirement | |---|---| | TR-OPS-01 | Crash diagnostics: a single combined log file with rotation; user can copy via `Help → Save crash report…` (deferred to ENH-019 / M4). | | TR-OPS-02 | Telemetry: NONE by defau
- `_cobolt-output/latest/brownfield/32-modernization-implicit-requirements.md` â€” Implicit and edge-case requirements input: The explicit FRs in `24-modernization-prd.md` need supporting implicit requirements to avoid edge-case regressions. This document enumerates them. | ID | Implicit | Why | |---|---|---| | IR-01-01 | Empty document renders
- `_cobolt-output/latest/brownfield/26-modernization-security-requirements.md` â€” Security and compliance constraints: | STRIDE | Realistic in this app? | |---|---| | Spoofing | NO — single-user desktop app, no identity model | | Tampering | YES — hostile markdown content (the input is attacker-controlled) | | Repudiation | NO — no multi
- `_cobolt-output/latest/brownfield/26c-modernization-compliance-architecture.md` â€” Compliance architecture and control mapping: MarkDownViewer processes **no PII, no PHI, no payment data, no credentials**. The application is OUT OF SCOPE for GDPR / HIPAA / SOC2 / PCI-DSS / DPDP / FedRAMP. The `cobolt-compliance-gate` deterministic tool returned `
- `_cobolt-output/latest/brownfield/27-modernization-system-architecture.md` â€” Existing system architecture and boundaries: **Two-process Electrobun desktop application** — preserved from current architecture. No replatform. ``` ┌────────────────────────────────┐ │ Markdown Viewer (.app/.exe) │ │ │ user opens .md ─►│ Bun process ◄══RPC══► │ │
- `_cobolt-output/latest/brownfield/29-modernization-data-model-spec.md` â€” Data model and persistence constraints: The application has no relational or NoSQL database. Data persistence is entirely filesystem-based via three small JSON / text artifacts. This document codifies their schemas for forward use (and for the M3 multi-format 
- `_cobolt-output/latest/brownfield/30-modernization-api-contracts.md` â€” Integration and API contract details: The application has no HTTP/REST/GraphQL/gRPC API. The only "contract" is the in-process typed RPC between the bun and mainview processes, defined in `src/shared/rpc.ts`. This document is the authoritative source for the
- `_cobolt-output/latest/brownfield/31-modernization-ux-design-specification.md` â€” UX, workflow, and interaction requirements: 1. **Native first** — match each platform's conventions (hidden inset titlebar on macOS, native menu bar, keyboard shortcuts using OS modifiers) 2. **Single window, no chrome bloat** — sidebar + content + status bar; no 
- `_cobolt-output/latest/brownfield/33-modernization-dependency-and-integration-register.md` â€” Dependency and integration inventory: | Dependency | Type | Direction | SLO | Failure mode | Owner | |---|---|---|---|---|---| | (M1+) Apple Notarization Service | Code-signing | CI → Apple | Best-effort, sometimes hours | If service is down, release waits; 
- `_cobolt-output/latest/brownfield/35-modernization-milestones.md` â€” Milestone and sequencing assumptions: **Goal**: Close every HIGH/MEDIUM hostile-content finding before public distribution. Establish DOMPurify, mermaid SVG re-sanitization, image path containment, and a renderer CSP as the security trust boundary. **Closes*
- `_cobolt-output/latest/brownfield/36-modernization-epics-and-stories.md` â€” Epic and story decomposition input: **As** a user opening a hostile markdown file **I want** the renderer to block all unauthorized network egress and embedded frames **So that** a hostile inline `<style background:url(...)>` cannot exfil data **Acceptance
- `_cobolt-output/latest/brownfield/39-modernization-delivery-plan.md` â€” Delivery, rollout, and operational planning input: | Release | Trigger | Audience | Channel | |---|---|---|---| | `dev` | Push to `main` | Internal devs | GitHub Actions artifact (unsigned) | | `canary` | Manual / weekly tag | Power users | GitHub Releases (signed for wi
- `_cobolt-output/latest/brownfield/43-modernization-validation-report.md` â€” Milestone validation readiness input: **Date**: 2026-05-04 (P6 close) **Scope**: P0-P6 — full modernization packet **Verdict**: PASS — packet is internally consistent; ready for handoff to `cobolt-build` | Check | Result | |---|---| | Every FR in `24-moderni
- `_cobolt-output/latest/brownfield/01-intake-and-classification.md` â€” Intake scope and system framing: **Project**: MarkDownViewer **Identifier**: com.local.markdownviewer **Version**: 1.0.0 (per package.json) **License**: MIT (Non-Resale Variant) — © 2026 MFTLabs · Developed by CoBolt **Type**: Desktop application (nativ
- `_cobolt-output/latest/brownfield/02-baseline-health-and-scan-summary.md` â€” Baseline health, risk, and quality findings: **cobolt-health overall score**: 82 **cobolt-scan total findings**: 0 (after Wave 3 deterministic battery) **cobolt-illusion-scan**: 2 high (both verified false-positive — see `16c-illusion-verification.json`) | Pillar |
- `_cobolt-output/latest/brownfield/03-project-context.md` â€” Project context and domain background: MarkDownViewer is a single-purpose desktop application that ships as a native binary on macOS, Windows, and Linux. It opens .md files (and aliases .markdown / .mdown / .mkd / .mkdn / .mdx) and renders them with markdown-
- `_cobolt-output/latest/brownfield/23-master-assessment.md` â€” Brownfield assessment and modernization guidance: **Mode**: `--scan full` (P0-P6 modernization packet) **Scope**: Current working directory only (CWD-or-descendant policy) **Method**: Main-context analysis + 11 deterministic Security Wave 3 tools + Phase 2.5 forensic sy

## Consolidation Guidance

- Use the PRD as the backbone document, but keep brownfield architecture, UX, security, delivery, and operational documents in scope.
- When documents overlap, preserve the more specific brownfield constraint instead of silently dropping it because a PRD exists.
- Resolve conflicts explicitly in downstream planning artifacts and readiness checks.

<!-- COBOLT_BROWNFIELD_SOURCE_REGISTRY:START -->

## Source Requirement Registry

| ID | Source File | Requirement Summary | Category | Status |
|----|-------------|---------------------|----------|--------|
| SRC-001 | _cobolt-output/latest/brownfield/24-modernization-prd.md | The application MUST render any well-formed markdown file the OS user can read, with mermaid, KaTeX, GFM alerts, wikilinks, and code highlighting. | FR | included |
| SRC-002 | _cobolt-output/latest/brownfield/24-modernization-prd.md | The application MUST sanitize markdown-derived HTML through DOMPurify before injecting it into the renderer DOM. | FR | included |
| SRC-003 | _cobolt-output/latest/brownfield/24-modernization-prd.md | The application MUST re-sanitize mermaid SVG output before injecting it into the DOM. *(Closes SEC-001 / MOD-001.)* | FR | included |
| SRC-004 | _cobolt-output/latest/brownfield/24-modernization-prd.md | The application MUST reject image src that resolves outside the document's directory (or a configured allowlist). *(Closes SEC-002 / MOD-002.)* | FR | included |
| SRC-005 | _cobolt-output/latest/brownfield/24-modernization-prd.md | The application MUST scope DOMPurify's `style` attribute to a CSS allowlist that prohibits `url()` and `@import`. *(Closes SEC-003 / MOD-003.)* | FR | included |
| SRC-006 | _cobolt-output/latest/brownfield/24-modernization-prd.md | The renderer MUST set a Content Security Policy that blocks all network egress (`connect-src 'none'`), frames, and external scripts. *(Closes SEC-007 / MOD-006.)* | FR | included |
| SRC-007 | _cobolt-output/latest/brownfield/24-modernization-prd.md | The application MUST emit a clear error affordance when YAML front-matter parsing fails, instead of silently dropping the document. *(Closes SEC-004 / MOD-004.)* | FR | included |
| SRC-008 | _cobolt-output/latest/brownfield/24-modernization-prd.md | The application MUST persist its debug log at `os.tmpdir() / mdv-bun.log` and rotate at 10 MB. *(Closes SEC-005 / MOD-005.)* | FR | included |
| SRC-009 | _cobolt-output/latest/brownfield/24-modernization-prd.md | The Windows installer and macOS .app bundle MUST be code-signed and (macOS) notarized. *(Closes ENH-020 / ENH-021.)* | FR | included |
| SRC-010 | _cobolt-output/latest/brownfield/24-modernization-prd.md | The distribution MUST include a `THIRD_PARTY_LICENSES.md` reachable from `Help → License…`. *(Closes DEBT-002 / MOD-008.)* | FR | included |
| SRC-011 | _cobolt-output/latest/brownfield/24-modernization-prd.md | CI MUST run a dependency vulnerability scan (OSV or `bun audit`) on every PR. *(Closes SCA-002 / MOD-009.)* | FR | included |
| SRC-012 | _cobolt-output/latest/brownfield/24-modernization-prd.md | A Playwright domain test suite MUST exist with at least: (a) golden-render fixtures for mermaid+KaTeX+alerts+wikilinks; (b) hostile-content fixtures for SEC-001..007. *(Closes ENH-014 / ENH-015.)* | FR | included |
| SRC-013 | _cobolt-output/latest/brownfield/24-modernization-prd.md | The application MUST gain a multi-format editor (Notepad++-class) that allows editing markdown and other text formats in tabbed views. | FR | included |

<!-- COBOLT_BROWNFIELD_SOURCE_REGISTRY:END -->
