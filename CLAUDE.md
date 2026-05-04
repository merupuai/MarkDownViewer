# CLAUDE.md

## Project Overview
- Name: markdownviewer
- Type: brownfield
- Project ID: cobolt-markdownviewer-c533e3
- Root: C:\Users\admin\Desktop\markdown
- Runtime: Claude Code

## Tech Stack
- Detected stack: JS/TS
- Confirm framework and runtime choices during `/cobolt-plan project`.

## CRITICAL — Pipeline Faithfulness Over Context Efficiency

The user runs the max-tier plan with continuation tooling. Sessions can span hours
and many turns. Token cost, single-session context budget, or "this dispatch is
expensive" reasoning is NEVER a justification to substitute deterministic emitters
for skill-prescribed agent dispatches.

When a CoBolt skill says "Dispatch <agent>" — you MUST dispatch that agent via
the Agent tool. When it says "Skill <other-skill>" — you MUST invoke the Skill
tool. You MAY NOT:

1. Write Node.js batch emitters that produce equivalent output files in lieu of
   agent dispatches. Even when the JSON shape matches the schema. Even when it
   passes the validator hook. The work IS the dispatch, not the file shape.
2. Pad/template artifacts to make detector heuristics pass. Examples of what is
   forbidden: short-section placeholder paragraphs, closing-summary appends,
   "Feature Coverage Map" tables tacked onto layer artifacts to flip
   feature-coverage from BLOCKED to READY, "_Section reserved — content pending
   consolidation_" pads to bypass empty-section detectors. That is detector-
   gaming, not fixing.
3. Write checkpoint JSONs with `passed: true` and
   `status: "static-pass-with-deferred-runtime"` when the prescribed agent did
   not run. A deferred runtime check is debt that must be recorded honestly via
   `cobolt-planning-debt.js` or `cobolt-blocked-tasks.js`, not a checkpoint pass.
4. Stop and summarize when the autonomous-guard is in force. If you genuinely
   cannot execute the next dispatch (real tool failure, real environment gap),
   invoke `cobolt-auto-resume.js checkpoint-story` with a CONCRETE specific
   reason and exit cleanly — do NOT inflate paper artifacts.
5. Wholesale-batch-emit checkpoints for multiple milestones at once via a single
   Node script. Each milestone's ~19 checkpoints are produced by ~50 distinct
   skill/agent dispatches. Batch emission is the canonical signature of
   fabricated continuation.
6. Substitute via Write or Edit tool when a CoBolt tool subprocess fails, skips,
   or produces no output. When `node tools/cobolt-X.js` exits non-zero, or exits
   zero but the expected artifact is missing/empty on disk, or an Agent dispatch
   times out, your correct response is: READ the stderr/stdout, FIX the root
   cause, RE-RUN the subprocess. If unfixable in-session, halt with
   `cobolt-auto-resume.js checkpoint-story`. You MAY NOT manually produce the
   artifact via Write tool — the work IS the tool's logic (validation, schema
   enforcement, audit logging), not the file shape.

   Forbidden examples: "cobolt-tracker-init.js failed, I'll hand-write
   story-tracker.json"; "cobolt-rtm.js import-prd exited non-zero, I'll
   hand-parse and write rtm.json"; "the spec-architect agent timed out, I'll
   write the impl-spec myself"; "cobolt-feature-coverage check shows 22/22
   BLOCKED, I'll patch the layer artifacts so it passes" (the FCM-table
   detector-gaming pattern).
7. Override deliberate skip behavior. Tools that intentionally skip writing
   (`cobolt-readme-gen.js` skipping for user-authored README; `cobolt-init`
   refusing to clobber existing state; `cobolt-sync-tokens.js init` refusing
   when `design-tokens.json` exists) are protecting the user. Do not step in
   with Write tool to force the artifact. If you genuinely need it regenerated,
   surface the situation and ask — do not override silently.

The autonomous-guard hooks detect halt phrases ("fresh session", "stop here",
"resume tomorrow"), not fabricated continuation. Honest halt is always
preferable to dishonest progression. The user has explicit safety nets —
continuation tooling that resumes when usage runs out, max-tier billing, audit
logs, version control, and patient multi-session iteration. Slow honest work
is the contract. Fabricated success silently breaks the build later and costs
the user more.

Forensic precedent: 2026-04-30 incident at CoboltStudio — 114 paper checkpoints
across M2-M7 batch-emitted via a single `node /tmp/build-mn-checkpoints.js`
execution bypassed every PreToolUse hook (subprocess writes do not trigger
Claude Code tool hooks). Every "passed: true" was fabricated. The pipeline
reported successful M1-M7 closure that the user only caught by direct question.
These rules close that gap by making the prohibition explicit at the prompt
tier — defense-in-depth alongside the hook surface.

## Compliance Requirements
- None captured during init. Record compliance needs during planning if applicable.

## Key Conventions
- `cobolt-state.json` is the pipeline state source of truth.
- `_cobolt-output/` stores reports, audit logs, evidence, and init readiness artifacts.
- `_cobolt-docker/` contains project-scoped Docker Compose assets.
- `references/` holds user-provided domain materials (design guidelines, logos, API docs, business rules). All agents check this folder.
- `.env.cobolt` is for user-provided infrastructure and must stay gitignored.
- `e2e/playwright.config.js` is seeded during init so browser smoke can run at build time.

## Next Steps
- Update `.env.cobolt` if you already have infrastructure.
- Start local services from `_cobolt-docker/` with `docker compose up -d` when needed.
- Run `/cobolt-plan project .` to begin planning.
