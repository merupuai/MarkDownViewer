# Tools Directory

CLI tools invocable by agents, skills, and developers. Entry point: `tools/index.js` (unified registry). Run `node tools/index.js --list` for the live count and inventory; `_cobolt-output/stats/current.json` (`tools` field) is the snapshot consumed by the docs/CI pipeline.

## Conventions

- Each tool exposes both CLI (`node tools/cobolt-*.js <command>`) and programmatic `require()` API
- Tools are CommonJS (`require`/`module.exports`), Node.js >= 20.0.0
- Use `execFileSync` — never `execSync` with string interpolation
- Import shared modules from `lib/` (tool-registry, analyzer-base, cobolt-paths, cobolt-ssrf, cobolt-error-classifier, cobolt-state-integrity)
- All tools use `lib/cobolt-paths.js` for output path resolution
- Tool names: `cobolt-<domain>.js` (kebab-case)

## Exit-Code Contract (fail-closed — mandatory for every tool)

| Code | Meaning | Gate interpretation |
|------|---------|---------------------|
| `0`  | Real success — tool actually ran to completion. | Gate may record PASS. |
| `1`  | Hard error — misuse, bug, unhandled exception, failed invariant. | Gate records FAIL. |
| `2`  | Missing optional dependency (e.g. `playwright`, `@axe-core/playwright`, `better-sqlite3`). Tool did NOT do its job. | Tier 2 gate: skip-and-report (degrades grade). Tier 1 gate: FAIL. |
| `3`  | Missing infrastructure (Docker, external service, network unreachable). | Same as `2` for gate tiers. |

**Forbidden pattern — silent stub on missing dep:**
```js
try { require('playwright'); }
catch { writeStub(); process.exit(0); }   // NEVER exit 0 without running
```
Use `process.exit(2)` instead. Agents and skills wire exit-code 2 into Tier 2 skip-and-report paths, so the pipeline degrades the milestone grade deterministically instead of recording a false green.

**Regression test**: `tests/test-tool-exit-contracts.js` runs each declared dep-gated tool with its dep uninstalled and asserts exit 2.

## Key Categories

| Category | Examples | Purpose |
|----------|----------|---------|
| State & proof | cobolt-state, cobolt-step-proof, cobolt-evidence | Pipeline state management |
| Quality gates | cobolt-gate, cobolt-scan, cobolt-test | Deterministic quality enforcement |
| Build support | cobolt-docker, cobolt-worktree, cobolt-infra-check | Infrastructure and build |
| Git workflow | cobolt-git-workflow, cobolt-git, cobolt-release | Version control automation |
| Analysis | cobolt-audit, cobolt-illusion-scan, cobolt-fr-coverage | Code and compliance analysis |
| Brownfield | cobolt-brownfield-*, cobolt-legacy-scan | Legacy system tools |
| Planning | cobolt-preflight, cobolt-rtm, cobolt-validate-prd | Planning artifact management |
| Reporting | cobolt-report, cobolt-metrics, cobolt-milestone-report | Pipeline output |

## Listing All Tools

```bash
node tools/index.js --list
```

## Adding a New Tool

1. Create `tools/cobolt-<name>.js` with CLI interface and `module.exports`
2. Register in `tools/index.js` exported registry
3. Add npm script in `package.json` if user-facing
4. Update root CLAUDE.md counts if significant

## Authoring Scope Discipline (Anti-Drift)

The root `CLAUDE.md` Scope Discipline / Pipeline Faithfulness sections are canonical for any edit under `tools/`. Tool-specific drift to refuse:

1. **Don't change exit-code semantics.** The 0/1/2/3 contract above is a hard interface — every gate consumer wires it into Tier 1/2 paths. Renumbering, collapsing 2 and 3, or reusing 4+ for new error classes silently breaks gates across the pipeline.
2. **Forbidden: silent stub on missing dependency.** A tool that catches `require('playwright')` failure and writes a stub with `process.exit(0)` is fabrication — it claims success without doing its job. Use `process.exit(2)` so Tier 2 gates degrade the milestone grade deterministically.
3. **Don't widen a tool's scope past the ask.** A bug fix in `cobolt-rtm.js parse` does not authorize adding a new `--explain` mode, restructuring command routing, or extracting a shared helper.
4. **`tools/` may import from `lib/`; `lib/` must never import from `tools/`.** Inversion creates circular load order under `npm test` and breaks the published-tarball boundary.
5. **`execFileSync` with argv arrays only — never `execSync` with string interpolation.** Command-injection is a real CWE-78 in CoBolt's history (root CLAUDE.md Code Style).
6. **Don't add tools that duplicate existing tool capability.** Check `node tools/index.js --list` first. Two tools producing overlapping verdicts is a cross-pipeline ambiguity bug waiting to happen.
7. **Programmatic API stability matters.** Tools are `require()`'d by skills, agents, and other tools. Renaming an exported function or changing its signature is a breaking change — bump major or keep the old export as an alias.
8. **Tool failure must be loud, not silently substituted.** When a tool subprocess fails or skips, the correct caller behavior is read stderr → fix root cause → re-run. Skills/agents may NOT manually produce the artifact via Write tool (root CLAUDE.md Architectural Invariant #20, rules 6-7).

End-of-turn discipline: state the user's ask in one sentence before any tool edit. If the planned diff does not serve that sentence, stop and ask.
