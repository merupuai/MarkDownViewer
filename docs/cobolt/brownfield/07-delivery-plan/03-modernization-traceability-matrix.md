---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/37-modernization-traceability-matrix.md
pipeline: brownfield
topic: 07-delivery-plan
title: "Modernization Traceability Matrix"
order: 3
audiences: ["delivery-lead", "build-agent"]
source_sha256: cd9b812a2872e631042c0887e6326cc4ca4d41ee8a1cacd364a66a05f55f9af4
source_size: 3943
published_at: 2026-05-04T14:36:58.135Z
published_by: cobolt-publish-docs
---

# Traceability Matrix — MarkDownViewer Modernization

Each FR/NFR is mapped to its source finding, owning milestone, owning story, and the test fixture that validates it.

| FR/NFR | Finding(s) | Milestone | Story | Test Fixture(s) |
|---|---|---|---|---|
| FR-01 (render markdown) | (existing) | (M0 baseline) | n/a | `e2e/tests/golden/*.spec.ts` |
| FR-02 (DOMPurify on all HTML) | (existing) | M0 + M1 | M1.S2 | `e2e/tests/golden/sanitizer.spec.ts` |
| FR-03 (mermaid SVG re-sanitize) | SEC-001, FOR-001 | M1 | M1.S3 | `e2e/tests/hostile/mermaid-foreignobject.spec.ts` |
| FR-04 (image path containment) | SEC-002, FOR-002 | M1 | M1.S4 + M1.S5 | `e2e/tests/hostile/image-traversal.spec.ts` |
| FR-05 (DOMPurify style allowlist) | SEC-003, FOR-003 | M1 | M1.S2 | `e2e/tests/hostile/style-url.spec.ts` |
| FR-06 (renderer CSP) | SEC-007 | M1 | M1.S1 | `e2e/tests/hostile/csp-egress.spec.ts` |
| FR-07 (front-matter error visible) | SEC-004 | M1 | M1.S6 | `e2e/tests/regressions/front-matter-error.spec.ts` |
| FR-08 (rotating log) | SEC-005, FOR-004, FOR-005 | M1 | M1.S7 | `e2e/tests/regressions/log-rotation.spec.ts` |
| FR-09 (code signing) | ENH-020, ENH-021 | M2 | M2.S4 + M2.S5 | CI signed-build job |
| FR-10 (THIRD_PARTY_LICENSES.md) | DEBT-002 | M2 | M2.S3 | `e2e/tests/regressions/license-menu.spec.ts` |
| FR-11 (CI vuln scan) | SCA-002 | M2 | M2.S2 | CI `bun audit` step |
| FR-12 (Playwright suite) | ENH-014, ENH-015 | M2 | M2.S6 + M2.S7 | the suite itself |
| FR-13 (multi-format editor) | ENH-001, ENH-002 | M3 | M3.S1..S12 | `e2e/tests/editor/*.spec.ts` |
| NFR-01 (50 KB doc + 20 mermaid ≤ 1.5s) | PERF baseline | M1 | covered by M1.S3 perf budget | `e2e/tests/perf/render-budget.spec.ts` |
| NFR-02 (theme toggle ≤ 200ms with cache) | PERF-002 | M4 | M4.S2 | `e2e/tests/perf/theme-toggle.spec.ts` |
| NFR-03 (mem ≤ 250 MB) | (target) | M4 | (cross-cutting; check in CI on M4 close) | `e2e/tests/perf/memory.spec.ts` |
| NFR-04 (no network egress) | SEC-007 | M1 | M1.S1 (CSP) | `e2e/tests/hostile/csp-egress.spec.ts` |
| NFR-05 (close all medium+ before public) | (gate) | M2 close | n/a | release-readiness checklist |
| NFR-06 (license attribution visible) | DEBT-002 | M2 | M2.S3 | `e2e/tests/regressions/license-menu.spec.ts` |
| SR-01 | SEC-001 | M1 | M1.S3 | hostile-mermaid fixture |
| SR-02 | SEC-002 | M1 | M1.S4 | image-traversal fixture |
| SR-03 | SEC-003 | M1 | M1.S2 | style-url fixture |
| SR-04 | SEC-007 | M1 | M1.S1 | csp-egress fixture |
| SR-05 | (sub of SR-02) | M1 | M1.S5 | image-mime-type fixture |
| SR-06 | SEC-004 | M1 | M1.S6 | front-matter-error fixture |
| SR-07 | SCA-002 | M2 | M2.S2 | CI |
| SR-08 | (signing) | M2 | M2.S4 + M2.S5 | CI |
| SR-09 | (fixture corpus) | M2 | M2.S6 | suite |
| ADR-001..008 | architecture | (cross-cut) | (informational) | n/a |

## Reverse Traceability — every story has at least one FR/NFR/SR

| Story | Closes |
|---|---|
| M1.S1 | FR-06, NFR-04, SR-04 |
| M1.S2 | FR-02, FR-05, SR-03 |
| M1.S3 | FR-03, SR-01 |
| M1.S4 | FR-04, SR-02 |
| M1.S5 | SR-05 |
| M1.S6 | FR-07, SR-06 |
| M1.S7 | FR-08 |
| M1.S8 | UI-002, UI-003, UI-004, DESIGN-003 |
| M1.S9 | 26c § 4 EULA hardening |
| M2.S1 | DEBT-003 |
| M2.S2 | FR-11, SR-07 |
| M2.S3 | FR-10, NFR-06, DEBT-002 |
| M2.S4 | FR-09 (mac), SR-08 |
| M2.S5 | FR-09 (win), SR-08 |
| M2.S6 | FR-12, SR-09 |
| M2.S7 | UI-001 |
| M2.S8 | DESIGN-001 |
| M3.S1..S12 | FR-13 + IR-13-* |
| M4.S1 | PERF-001, ENH-011 |
| M4.S2 | PERF-002, MOD-007, NFR-02 |
| M4.S3 | DEBT-004..014 |
| M4.S4 | ENH-006 |
| M4.S5 | ENH-018 |
| M4.S6 | ENH-019 |
| M4.S7 | ENH-023 |
| M4.S8 | ENH-025 |
| M4.S9 | ENH-024 |
| M4.S10 | ENH-022 |

## Coverage

- **Findings without owning story**: ARCH-001, ARCH-003, FOR-010 (all `note-only` — not addressed). ILL-001, ILL-002 (closed as false-positive). OPS-001 (note-only-upstream).
- **Stories without FR/NFR/SR**: none — all 39 stories are anchored to a closed finding or FR.
