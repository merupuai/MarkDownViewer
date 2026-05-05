---
cobolt_published: true
canonical: _cobolt-output/latest/planning/master-plan.md
pipeline: plan
topic: 05-delivery
title: "Master Plan"
order: 5
audiences: ["delivery-lead", "build-agent"]
source_sha256: 17323c13c379a7d430a6c1fb4651eb07a946d7f5ebd4fe3c60c0ccffa4ce679a
source_size: 6625
published_at: 2026-05-05T04:08:56.184Z
published_by: cobolt-publish-docs
---

# Master Modernization Plan — MarkDownViewer

Single-page synthesis of the entire P0-P6 packet. For depth, follow the linked artifacts.

## TL;DR

MarkDownViewer is **a well-engineered narrow-scope desktop markdown viewer**. The recommended modernization path is **forward-invest, not replatform**: M1 (security floor) → M2 (signed distribution + tests) → M3 (multi-format editor — already in flight) → M4 (polish). 39 stories total across 4 milestones, sequenced to land the first public-distribution-ready release at M2 close (`v1.2.0`).

## Project at a glance

- Native desktop app, Electrobun runtime (Bun + WebKit/WebView2)
- ~2000 LOC TypeScript, single-window, two-process (bun ↔ mainview)
- No DB, no auth, no network — only local file + markdown rendering
- Health 82/100 (cobolt-health); B+ overall
- 27 findings, 0 critical, 2 high (SEC-001 mermaid SVG; OPS-001 docker-compose — outside-app)

## Modernization Milestones

| # | Milestone | Version | Stories | Focus |
|---|---|---|---|---|
| M1 | Hostile-content hardening | 1.1.0 | 9 | DOMPurify hardening, mermaid SVG re-sanitize, image path containment, CSP, log fixes, a11y |
| M2 | Distribution & test foundation | 1.2.0 | 8 | Code signing, notarization, OSV scan in CI, Playwright suite, axe-core, design tokens |
| M3 | Multi-format editor | 2.0.0 | 12 | Tabbed UI, edit mode, autosave, atomic save, format adapters, conflict detection |
| M4 | Polish & extensions | 2.1.0 | 10 | Lazy bundles, theme cache, PDF export, opt-in update, opt-in crash reports, debt sweep |

## Document Map

### Assessment (P0-P3)
- `01-intake-and-classification.md` — Stakeholders, drivers, lifecycle
- `02-baseline-health-and-scan-summary.md` — All deterministic-tool outputs
- `03-project-context.md` + `03a-domain-knowledge-base.md` + `03b-project-knowledge-base.md` + `03c-project-skills-manifest.md`
- `04-feature-and-module-inventory.md` — Module-level walkthrough
- `05-database-and-data-store-report.md` — JSON files + EULA marker; no DB
- `06-integration-map.md` — Zero remote integrations
- `07-configuration-and-access-audit.md` — No auth model
- `08-ui-and-workflow-catalog.md` + `08a-current-ui-ux-assessment.md` — Single-window UX
- `09-supply-chain-and-vulnerability-review.md` — 14 prod deps; SBOM in `sbom.json`
- `10/11/11a-*-tracker.json` — Discovery, dependency, UX trackers
- `12-security-and-quality-assessment.md` — Threat model + 27 findings
- `13-architecture-recovery.md` — C4-style recovery
- `14-business-rules-and-validation.md` — 13 rules cataloged
- `15-feature-triage-matrix.md` — Value × quality quadrant
- `16-issues-registry.json` — All findings, by severity / category / track
- `16a-16e-forensic-*` — P2.5 forensic outputs
- `16f-dead-code-inventory.md` — 2 dead lines (DEBT-008)
- `16g-architecture-quality-review.md`, `16h-design-quality-assessment.md`
- `17-enhancement-advisory.md` — 25 enhancement opportunities
- `18-modernization-roadmap.md` — Milestone overview (concise)
- `19-evidence-index.json` — Generated index of every artifact
- `20-modernization-decision-log.md` — Cross-cutting DECs
- `21-modernization-handoff.json`, `22-modernization-milestone-tracker.json` (P3 stubs)
- `23-master-assessment.md` — Executive synthesis

### Modernization Plan (P4-P6)
- `24-modernization-prd.md` — 13 FRs + 6 NFRs
- `25-modernization-trd.md` — Operational + build + infra + data + perf + reliability + compliance
- `26-modernization-security-requirements.md` — 9 SRs (mandatory + advisory)
- `26a-modernization-secure-coding-standard.md` — Coding-level rules + their `26b-standards-validation.json`
- `26b-modernization-engineering-quality-standards.md` — Naming, TS, modules, tests
- `26c-modernization-compliance-architecture.md` — License, supply-chain, signing; no regulated frameworks; `26c-validation.json`
- `27-modernization-system-architecture.md` — Two-process, layered trust boundary; `27-architect-review.json`
- `28-modernization-architecture-decisions.md` — 8 ADRs
- `29-modernization-data-model-spec.md` — JSON file schemas + M3 editor state
- `30-modernization-api-contracts.md` — RPC contract + M1/M3 deltas
- `31-modernization-ux-design-specification.md` — Screens, flows, accessibility
- `31-design-token-audit.json`, `31-ui-design-audit.json`, `31a-modernization-wireframes-and-user-flows.md`
- `32-modernization-implicit-requirements.md` — Per-FR IRs
- `33-modernization-dependency-and-integration-register.md` + `34-modernization-dependency-tracker.json` + `34a-modernization-ux-tracker.json`
- `35-modernization-milestones.md` — DoD + sequencing per milestone
- `36-modernization-epics-and-stories.md` — All 39 stories
- `37-modernization-traceability-matrix.md` — Bidirectional FR ↔ story coverage
- `38-modernization-test-strategy.md` — Categories, coverage, organization, budgets
- `39-modernization-delivery-plan.md` — Channels, environments, rollout
- `40-modernization-milestone-tracker.json`, `41-modernization-story-tracker.json`, `42-modernization-issue-and-blocker-tracker.json`
- `43-modernization-validation-report.md` — Internal-consistency report (this run: PASS)
- `44-modernization-release-readiness-checklist.md` — Stable release gate

## Critical Decisions Captured

- **DEC-001** Treat the rendering pipeline as the security trust boundary
- **DEC-002** Forward-invest, don't replatform
- **DEC-003** Multi-format editor is a milestone, not a separate project
- **DEC-004** Don't ship docker-compose; remediate CIS upstream

(Full details in `20-modernization-decision-log.md`; ADRs in `28-modernization-architecture-decisions.md`.)

## Risks Carried Forward

| Risk | Mitigation | Closing milestone |
|---|---|---|
| R-001 hostile mermaid HTML injection | MOD-001 / SR-01 | M1 |
| R-002 path traversal in resolveImage | MOD-002 / SR-02 | M1 |
| R-003 CSS exfil via inline style | MOD-003 + MOD-006 / SR-03 + SR-04 | M1 |
| R-004 unsigned distribution | ENH-020 / ENH-021 | M2 |
| R-005 no domain test coverage | ENH-014/015/016 | M2 |
| R-006 Electrobun beta drift | DEBT-001 (track GA) | ongoing |
| R-007 OS-shell injection (already mitigated) | document + length cap | M4 |

## Build Authorization

This packet is **not yet build-authorized**. Build authorization requires:

1. ✓ P3 assessment contracts validate (DONE)
2. ☐ P5.5 standards gate passes
3. ☐ planning-sync produces canonical `_cobolt-output/latest/planning/` artifacts
4. ☐ brownfield-to-build handoff contract validates

Once steps 2-4 complete with no blockers, run `cobolt-build M1 --auto` to begin implementation.
