---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/16g-architecture-quality-review.md
pipeline: brownfield
topic: 04-forensic-audit
title: "Architecture Quality Review"
order: 3
audiences: ["architect", "security", "reviewer"]
source_sha256: b376ebc603c833aeec287a81ceaf944364a35507b466d3eccc8ba189ee724957
source_size: 1366
published_at: 2026-05-04T14:36:58.135Z
published_by: cobolt-publish-docs
---

# 16g — Architecture Quality Review

## Summary

| Dimension | Grade | Notes |
|---|---|---|
| Layer separation | A | bun / mainview / shared boundaries are clear; no leaks |
| Module surface | A- | Renderer has module-level `let` bindings (acceptable scope) |
| Coupling | A | Single typed RPC contract |
| Cohesion | A | Each module has one purpose |
| Dependency direction | A | No circular imports |
| API design | B+ | RPC schema clear; would benefit from versioning when schema evolves (ENH-014) |
| Cross-cutting concerns | B+ | Logging works but is hardcoded path (SEC-005); error handling could surface more user-visible signals (SEC-004, MOD-004) |

## Strengths

- The two-process model maps cleanly to the real trust boundary (filesystem access vs. rendering).
- The typed RPC contract in `src/shared/rpc.ts` is a strong source-of-truth pattern; both ends derive from it.
- Markdown plugin registration is centralized in `buildMarkdown()` — single place to add a plugin.

## Improvement Opportunities

- Mermaid post-render injection bypasses the DOMPurify trust boundary (SEC-001) — a structural fix, not just a config change.
- The renderer relies on module-level `let` bindings for state; a small `class App {}` would scope state and ease unit tests (ENH-012).
- `escAttr` is duplicated with subtly different escape sets (SCAN-003 / DEBT-006).

