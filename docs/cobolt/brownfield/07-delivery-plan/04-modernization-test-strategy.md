---
cobolt_published: true
canonical: _cobolt-output/latest/brownfield/38-modernization-test-strategy.md
pipeline: brownfield
topic: 07-delivery-plan
title: "Modernization Test Strategy"
order: 4
audiences: ["delivery-lead", "build-agent"]
source_sha256: 9ec39570da8b01ce3c709aa40031246386e6632b1c57488e71ce5a8583fe277d
source_size: 5990
published_at: 2026-05-04T14:36:58.135Z
published_by: cobolt-publish-docs
---

# Test Strategy — MarkDownViewer Modernization

## 1. Test Categories

| Category | Tool | Scope |
|---|---|---|
| Unit | Bun's built-in test runner (`bun test`) | Pure logic: markdown plugins, sanitize wrapper, path-containment, log rotation, format detection |
| Integration | Playwright | RPC end-to-end via the actual app process tree |
| End-to-end | Playwright | User flows: open file, search, find, lightbox, EULA, edit mode (M3) |
| Security (hostile content) | Playwright | Hostile fixtures for SR-01..SR-06 |
| Accessibility | Playwright + axe-core | WCAG AA on all rendered pages |
| Performance | Playwright timing | Render budget, theme toggle budget, memory budget |
| Visual regression | Playwright snapshots | Per-theme baseline images |
| Distribution / signing | CI shell scripts | Signed-build verification |

## 2. Coverage Targets

| Target | Goal |
|---|---|
| Unit-test line coverage | ≥ 70% on new modules (M1: sanitize.ts, mermaid-render.ts, image-resolver.ts, log.ts) |
| Integration coverage | Every RPC method has at least one test |
| E2E coverage | Every menu action has at least one test |
| Hostile-content coverage | Every SR-01..SR-06 has at least one fixture |
| Visual regression | Welcome screen + document-with-mermaid + document-with-katex + lightbox in both themes |

## 3. Test File Organization

```
tests/                                          ← Bun unit tests (NEW M1)
  unit/
    sanitize.test.ts
    mermaid-render.test.ts
    image-resolver.test.ts
    log.test.ts
    format-detect.test.ts          (M3)
    editor-state.test.ts           (M3)

e2e/                                            ← Playwright (existing config; NEW tests in M1+)
  fixtures/
    golden/
      basic.md
      mermaid-flowchart.md
      katex-inline-display.md
      gfm-alerts-all-five.md
      wikilinks.md
      front-matter-yaml.md
      images-relative-and-absolute.md
    hostile/
      mermaid-foreignobject.md
      mermaid-script-in-label.md
      image-path-traversal.md
      image-non-image-extension.md
      style-url-attempt.md
      style-import-attempt.md
      front-matter-malformed.md
      csp-egress-attempt.md
    regressions/
      large-doc-50kb.md
      large-doc-with-many-images.md

  tests/
    golden/
      *.spec.ts                    ← one per fixture, asserts golden render
    hostile/
      *.spec.ts                    ← one per fixture, asserts mitigation
    regressions/
      front-matter-error.spec.ts
      log-rotation.spec.ts
      eula-marker-mode.spec.ts
      license-menu.spec.ts
    perf/
      render-budget.spec.ts        ← NFR-01
      theme-toggle.spec.ts         ← NFR-02
      memory.spec.ts               ← NFR-03
    editor/                         (M3)
      open-edit-mode.spec.ts
      autosave.spec.ts
      save-conflict.spec.ts
      tab-close-prompt.spec.ts
      hostile-edit-time-content.spec.ts
```

## 4. Test Data Conventions

- All fixtures are committed under `e2e/fixtures/`
- Fixture filenames match their spec filenames
- Hostile fixtures include a comment header noting WHICH attack vector they exercise
- Golden fixtures include expected rendered HTML snippets in their spec assertions, NOT in separate snapshot files (preferred for grep-ability)

## 5. CI Matrix

| Job | OS | Steps |
|---|---|---|
| `lint` | ubuntu-latest | `bun install --frozen-lockfile`, `bun audit`, type-check, format-check |
| `unit` | macOS-latest, windows-latest | `bun install --frozen-lockfile`, `bun test tests/unit/` |
| `e2e` | macOS-latest, windows-latest | `bun install --frozen-lockfile`, `electrobun build`, `bun test e2e/` (Playwright launches the dev build) |
| `release` (tagged only) | macOS-latest, windows-latest | full build + sign + (mac) notarize + upload to GitHub Releases |

## 6. TDD Discipline (per CoBolt build pipeline)

Each story follows RED → GREEN → REFACTOR:

1. **RED**: Write the failing test first
2. **GREEN**: Implement just enough to pass
3. **REFACTOR**: Clean up; tests still pass

Closes story acceptance criteria + leaves no untested code path.

## 7. Performance Budgets

Each `e2e/tests/perf/*.spec.ts` enforces a hard budget. Failures fail CI.

| Test | Budget |
|---|---|
| Cold app start | ≤ 1.5 s on M1 / Ryzen 5 |
| Open 50 KB doc (no mermaid) | ≤ 300 ms |
| Open 50 KB doc (20 mermaid blocks) | ≤ 1.5 s |
| Theme toggle on cached doc | ≤ 200 ms (M4 only — gated by MOD-007) |
| Folder search on 1000 files | ≤ 1 s |
| Memory (5 docs + 1000-file folder) | ≤ 250 MB resident |

## 8. Security Test Discipline

Every hostile-content fixture MUST include in its assertion:

```ts
// 1. The mitigation works
expect(rendered.querySelector("..hostile-marker..")).toBeNull();

// 2. The renderer continues to function
expect(rendered.querySelector(".markdown-body")).not.toBeNull();

// 3. No file content / network egress was leaked
expect(networkRequests).toHaveLength(0);          // CSP check
expect(rendered.innerHTML).not.toContain("BEGIN OPENSSH PRIVATE KEY");  // exfil check
```

## 9. Accessibility Discipline

```ts
import { injectAxe, checkA11y } from 'axe-playwright';

await page.goto('...');
await injectAxe(page);
await checkA11y(page, undefined, { detailedReport: true, tags: ['wcag2a', 'wcag2aa'] });
```

Run on welcome screen, document view (light + dark), edit mode (M3), lightbox.

## 10. Visual Regression Discipline

- Baseline images committed in `e2e/snapshots/`
- Per-OS, per-theme variants
- `bun test --update-snapshots` to refresh on intentional UI changes
- PR diff highlights pixel-diff > 0.1% — manually confirmed by reviewer

## 11. Threat-Test Generator Integration

Once `_cobolt-output/latest/planning/threat-model.md` exists (M1 — derived from `26-modernization-security-requirements.md`), `cobolt-threat-test-gen` produces `tests/security/<threat-id>.spec.ts` stubs that mirror SR-01..SR-06. Stubs are committed; bodies are filled in by the engineer who claims the corresponding M1 story.
