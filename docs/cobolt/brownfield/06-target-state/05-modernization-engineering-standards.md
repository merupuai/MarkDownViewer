---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/26b-modernization-engineering-quality-standards.md
pipeline: brownfield
topic: 06-target-state
title: "Modernization Engineering Quality Standards"
order: 5
audiences: ["architect", "security", "build-agent"]
source_sha256: 4613dba8cb24fd4ea8572bad171df0c59f47f970b5eda0e9aa9c3a2160d4a991
source_size: 4016
published_at: 2026-05-04T14:36:58.135Z
published_by: cobolt-publish-docs
---

# Engineering Quality Standards — MarkDownViewer

## A. Naming Conventions

| Surface | Rule |
|---|---|
| TypeScript variables / functions | `camelCase` |
| TypeScript types | `PascalCase` |
| Constants | `UPPER_SNAKE_CASE` for module-level immutable; `camelCase` for inner |
| RPC method names | `camelCase`, action-first verb (`openDialog`, `searchFolder`) |
| Files | kebab-case (`find-in-doc.ts`, `wrap-launcher.sh`) — already followed |
| CSS classes | kebab-case (`.tree-row`, `.search-file-head`) — already followed |
| Data-attributes | `data-` prefix, kebab-case |

## B. TypeScript

| Rule |
|---|
| `strict: true` in tsconfig.json (verify on next pass) |
| No `any` at trust boundaries (RPC handlers, JSON parse output) |
| No `as any` casts unless documented with one-line `// reason: ...` comment |
| Replace `// @ts-expect-error - no types` with ambient module declarations (DEBT-004) |
| Always use full type signatures for renderer rules: `Renderer.RenderRule` instead of `(tokens: any, ...)` (DEBT-007) |

## C. Module Organization

| Rule |
|---|
| Cross-process types live in `src/shared/` (today only `rpc.ts`) |
| Renderer-only modules live in `src/mainview/` |
| Backend-only modules live in `src/bun/` |
| Mainview/index.ts SHOULD be split into smaller modules when it exceeds 1000 LOC (currently 813) |
| Keep markdown.ts pure (no DOM access); render-time DOM work belongs in index.ts |

## D. Constants & Magic Numbers

| Rule |
|---|
| Module-level constants for: debounce timings, size caps, depth/entry caps, zoom range, sidebar size range (DEBT-005) |
| Naming pattern: domain prefix + concept + unit, e.g. `FILE_WATCH_DEBOUNCE_MS`, `MAX_TREE_DEPTH`, `ZOOM_MIN` |

## E. Error Handling

(See `26a-modernization-secure-coding-standard.md` § E. Same rules apply for non-security errors.)

## F. Comments

| Rule |
|---|
| Default to no comments (the system prompt's general rule applies here) |
| Add a one-line comment ONLY when the WHY is non-obvious — hidden constraints, subtle invariants, framework-specific workarounds. The existing comments in `src/bun/index.ts` (e.g. lines 532-540 about Electrobun's launcher dropping argv) are exemplary. |
| Forbidden: end-of-line comments restating the code |

## G. Imports

| Rule |
|---|
| Sort imports: framework / runtime first (`electrobun/bun`, `bun`), then `node:`-prefixed, then `npm:`-style, then relative |
| Type-only imports use `import type` |
| Plugin types live in `types.d.ts` (post-DEBT-004) |

## H. Tests

| Rule |
|---|
| Every FR (FR-01..13) has at least one Playwright test (FR-12 acceptance) |
| Every SR (SR-01..06) has at least one hostile-content fixture |
| Tests live under `e2e/tests/` with subdirs `e2e/tests/golden/` and `e2e/tests/hostile/` |
| Every regression must add a test before the fix lands (TDD-style) |

## I. Build Configuration

| Rule |
|---|
| `electrobun.config.ts` is the source of truth for app metadata; `package.json::version` mirrors it |
| `engines.bun` is pinned in `package.json` (DEBT-003) |
| `bun.lock` is committed |
| CI runs `bun install --frozen-lockfile` |

## J. Performance

| Rule |
|---|
| Every render hot-path SHOULD log start/end timing via `rlog` / `dbg` — already done in `renderFile` |
| For new synchronous loops, document the iteration cap |
| Lazy-load mermaid + KaTeX bundles when render output contains the relevant placeholder (ENH-011, M4) |

## K. UI Standards

| Rule |
|---|
| Every interactive control has a visible focus indicator (CSS, post-design-token alignment) |
| Color contrast meets WCAG 2.1 AA in both light and dark themes |
| Buttons without visible text MUST have `aria-label` |
| Modal close MUST restore focus to the invoking control |
| Drag/drop MUST also be reachable via keyboard / menu |

## L. Distribution

| Rule |
|---|
| Bundles are code-signed before release (FR-09 / SR-08) |
| `THIRD_PARTY_LICENSES.md` is regenerated from `bun.lock` on every release (FR-10 / MOD-008) |
| Release tag matches `package.json::version` |
