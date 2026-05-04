#!/usr/bin/env node

// CoBolt Tools — Unified CLI entry point for all pipeline tools
//
// Usage:
//   node tools/index.js <tool> [args...]
//   node tools/index.js --list
//   node tools/index.js --help
//
// Examples:
//   node tools/index.js scan --category sast
//   node tools/index.js gate --categories lint,test
//   node tools/index.js state get pipeline.currentStage
//   node tools/index.js test --framework node
//   node tools/index.js health

const path = require('node:path');
const { spawnSync } = require('node:child_process');

// ── Tool Registry ────────────────────────────────────────────

const TOOLS = {
  // Core pipeline tools
  state: { file: './cobolt-state.js', desc: 'Read/write/query cobolt-state.json' },
  findings: { file: './cobolt-findings.js', desc: 'Finding lifecycle management (create, update, query)' },
  evidence: { file: './cobolt-evidence.js', desc: 'Collect and verify pipeline evidence' },
  context: { file: './cobolt-context.js', desc: 'Pipeline context handoff between stages' },
  'context-router': {
    file: './cobolt-context-router.js',
    desc: 'Task-shaped context routing — deterministic ranking of path-backed context cells (opt-in via COBOLT_CONTEXT_ROUTER=1 or --context-route)',
  },
  'context-route-usage': {
    file: './cobolt-context-route-usage.js',
    desc: 'Context routing telemetry — record/summary/tail usage signals to audit/context-route-usage.jsonl (fail-open, no gating)',
  },
  'context-route-promote': {
    file: './cobolt-context-route-promote.js',
    desc: 'Context routing promotion recommender — reads usage telemetry and emits GO/WAIT/NO-GO advisory (never flips defaults)',
  },
  'evidence-impact': {
    file: './cobolt-evidence-impact.js',
    desc: 'Advisory impact scoring (0–100) for requirements, findings, failed checks, and carry-forward items — never reorders queues',
  },
  'artifact-freshness': {
    file: './cobolt-artifact-freshness.js',
    desc: 'Warning-only drift detector across PRD/RTM/story-tracker/milestone/architecture/review/fix artifacts — blocks only in --enforce mode',
  },
  paths: {
    file: './cobolt-paths.js',
    desc: 'Canonical _cobolt-output path helpers for current/latest run pointer resolution',
  },
  'protocol-check': {
    file: './cobolt-protocol-check.js',
    desc: 'Inspect/validate Claude Code hook protocol contract (show, pinned, detect, validate, verdict) — see docs/CLAUDE-CODE-PROTOCOL-PINNING.md',
  },
  'runtime-resilience': {
    file: './cobolt-runtime-resilience.js',
    desc: 'RT-01..RT-04 runtime resilience doctor: hook protocol pinning, failure-class registry, fault-injection plan, and closure-class transparency report',
  },
  recovery: {
    file: './cobolt-recovery.js',
    desc: 'Structured recovery orchestration wrapper used by autonomous planning and stage repair ladders',
  },
  'pipeline-replay': {
    file: './cobolt-pipeline-replay.js',
    desc: 'Opt-in record + deterministic replay of stage fixtures for contract/transition/artifact regression coverage (never mutates _cobolt-output/latest/)',
  },
  'context-route-doctor': {
    file: './cobolt-context-route-doctor.js',
    desc: 'Read-only operator visibility for context routing — env enablement, schema presence, telemetry counts, promotion verdicts, route files, impact rollup, freshness report',
  },
  anchor: {
    file: './cobolt-anchor.js',
    desc: 'Per-milestone bounded-context memory file (init/append-round/set-current/add-risk/show)',
  },
  'auto-resume': {
    file: './cobolt-auto-resume.js',
    desc: 'Round-boundary auto-resume: policy check (should-resume) + checkpoint writer',
  },
  'execution-ledger': {
    file: './cobolt-execution-ledger.js',
    desc: 'Canonical execution truth core — append-only events, todo/work ledger, projections, and consistency checks',
  },
  'action-ledger': {
    file: './cobolt-action-ledger.js',
    desc: 'Signed redacted runtime action ledger: record, verify, summarize, and tail observed tool-call attestations',
  },

  // Security and quality tools
  scan: { file: './cobolt-scan.js', desc: 'Security scan orchestrator (18 tools)' },
  gate: { file: './cobolt-gate.js', desc: 'Deterministic quality gate (lint, type, format, test, security, deps)' },
  bypass: {
    file: './cobolt-bypass.js',
    desc: 'Signed gate-bypass ledger CLI (GT-01) — replaces COBOLT_*=off env-var bypasses with HMAC-signed audit entries',
  },
  // CRK Slice 4 (Phase A) — resilience kernel consumer surface
  escalate: {
    file: './cobolt-escalate.js',
    desc: 'CRK CLI — consult the resilience kernel for an escalation decision (route|shadow|census). Skills cannot require lib/ so they invoke this CLI per Inv-14.',
  },
  'escalation-replay': {
    file: './cobolt-escalation-replay.js',
    desc: 'CRK Phase A parity certifier — replays a corpus of historical dispatch-ledger entries through kernel.shadow() and reports legacy/kernel agreement (census, not sampling, per Inv-5).',
  },
  'escalation-report': {
    file: './cobolt-escalation-report.js',
    desc: 'CRK per-milestone rollup — reads escalation-events.jsonl and emits per-class / per-action / per-agent breakdowns as md or json.',
  },
  // ── v0.61 vNext groundwork + agentic-safety + supply-chain (registry catch-up) ──
  // These tools shipped with v0.61.0/v0.61.1 but were not registered in TOOLS.
  // Registering them here makes them discoverable via --list and silences the
  // tools:meta-gates WIRE-04 audit that otherwise blocks pre-push.
  'action-graph': { file: './cobolt-action-graph.js', desc: 'CoBolt Action Graph (P3.1 / v0.66+).' },
  'agentic-threat-model': {
    file: './cobolt-agentic-threat-model.js',
    desc: 'v0.61 vNext agentic-threat-model artifact emitter (planning-control-map family).',
  },
  'agent-replay': { file: './cobolt-agent-replay.js', desc: 'CoBolt Agent-Output Replay Harness (P1.5 / v0.61+).' },
  'agent-sandbox': { file: './cobolt-agent-sandbox.js', desc: 'CoBolt Agent Sandbox CLI (P4.1 / v0.66+).' },
  'aggregate-lint': {
    file: './cobolt-aggregate-lint.js',
    desc: 'CoBolt Aggregate-Boundary Lint Gate (DDD enhancement, v0.59).',
  },
  'build-packet-rank': {
    file: './cobolt-build-packet-rank.js',
    desc: 'CoBolt Build Packet Relevance Ranker (P1.2 / v0.61+).',
  },
  carbon: { file: './cobolt-carbon.js', desc: 'CoBolt Carbon-Aware CI Advisory (P4.3 / v0.64+).' },
  cosign: { file: './cobolt-cosign.js', desc: 'CoBolt Sigstore Signing Wrapper (P2.3 / v0.62+).' },
  'cra-evidence': { file: './cobolt-cra-evidence.js', desc: 'CoBolt EU CRA Readiness Module (P4.6 / v0.64+).' },
  'deferred-follow-on': {
    file: './cobolt-deferred-follow-on.js',
    desc: 'Register/report deferred follow-on items (source/templates/deferred-follow-on-register.json).',
  },
  'flake-ledger': { file: './cobolt-flake-ledger.js', desc: 'CoBolt Flaky-Test Ledger (P3.8 / v0.63+).' },
  'gate-slo': { file: './cobolt-gate-slo.js', desc: 'CoBolt Gate SLO Reporter (P3.7 / v0.63+).' },
  'install-profile': {
    file: './cobolt-install-profile.js',
    desc: 'Install profile inspector — reads transforms / install state for diagnostics.',
  },
  'model-drift': { file: './cobolt-model-drift.js', desc: 'CoBolt Model-Drift Detector (P3.6 / v0.63+).' },
  otel: { file: './cobolt-otel.js', desc: 'CoBolt OpenTelemetry Tracer (P3.2 / v0.66+).' },
  'plan-fix-sweep': {
    file: './cobolt-plan-fix-sweep.js',
    desc: 'CoBolt Plan-Fix Sweep — comprehensive planning verification orchestrator.',
  },
  'fix-repair': {
    file: './cobolt-fix-repair.js',
    desc: 'v0.63+ Cobolt-Fix Pipeline Parity Phase 2 — surgical repair classifier + dispatcher with 25-row FX repair-class table (FX1-FX25). Detects fix-stage failures from gate logs + verdict + finding-tracker, dispatches sub-skill/agent/tool per class with 3-strike escalation. Mirrors cobolt-plan-fix architecture for the fix-stage. Spec: docs/superpowers/specs/2026-05-03-cobolt-fix-parity-design.md §5.',
  },
  'contract-fingerprint': {
    file: './cobolt-contract-fingerprint.js',
    desc: 'v0.64+ Cobolt-Fix Pipeline Parity Phase 3 — SHA-256 fingerprinting for interface-contracts.json + api-contracts/*.yaml. Used by architect-fix-agent (mandatory before proposing arch mutations) and cobolt-fix-arch-mutation-gate (Tier 1 PreToolUse) to detect cross-milestone contract drift. Mirrors plan-stage retroactive-contract-gate logic for fix-stage. Subcommands: fingerprint <milestone>, compare <from> <to>, drift-report --proposal <path>.',
  },
  'planning-control-map': {
    file: './cobolt-planning-control-map.js',
    desc: 'v0.61 vNext planning-control-map artifact emitter.',
  },
  'planning-evidence-signature': {
    file: './cobolt-planning-evidence-signature.js',
    desc: 'v0.61 vNext signed evidence linkage for planning artifacts.',
  },
  'planning-loop-verdict': {
    file: './cobolt-planning-loop-verdict.js',
    desc: 'v0.61 vNext planning-loop close-authority verdict emitter (consumed by cli/lib/planning-finalizer.js).',
  },
  'planning-manifest': {
    file: './cobolt-planning-manifest.js',
    desc: 'CoBolt Planning Manifest — graph-backed planning evidence for build handoff.',
  },
  'planning-performance-profile': {
    file: './cobolt-planning-performance-profile.js',
    desc: 'v0.61 vNext planning-performance-profile artifact emitter.',
  },
  'planning-replay-calibration': {
    file: './cobolt-planning-replay-calibration.js',
    desc: 'v0.61 vNext planning-replay calibration artifact emitter.',
  },
  'planning-risk-model': {
    file: './cobolt-planning-risk-model.js',
    desc: 'v0.61 vNext planning-risk-model artifact emitter.',
  },
  'planning-source-ledger': {
    file: './cobolt-planning-source-ledger.js',
    desc: 'v0.61 vNext planning-external-source-ledger artifact emitter.',
  },
  'repro-verify': { file: './cobolt-repro-verify.js', desc: 'CoBolt Reproducible-Build Verifier (P3.5 / v0.65+).' },
  'rollback-rehearsal': {
    file: './cobolt-rollback-rehearsal.js',
    desc: 'CoBolt Rollback Rehearsal (P3.10 / v0.66+).',
  },
  'slsa-attest': {
    file: './cobolt-slsa-attest.js',
    desc: 'CoBolt SLSA L3 Build Provenance Attester (P2.1 / v0.62+).',
  },
  'surface-map': {
    file: './cobolt-surface-map.js',
    desc: 'cobolt-surface-map — read-only accessor for the Phase-5 plan-stage surface.',
  },
  'task-graph': { file: './cobolt-task-graph.js', desc: 'CoBolt task graph orchestrator.' },
  tia: { file: './cobolt-tia.js', desc: 'CoBolt Test Impact Analysis (P3.4 / v0.65+).' },
  'vuln-scan': {
    file: './cobolt-vuln-scan.js',
    desc: 'CoBolt SBOM-driven Vulnerability Scanner (P2.4 / v0.62+).',
  },
  'wireframe-render': {
    file: './cobolt-wireframe-render.js',
    desc: 'cobolt-wireframe-render — markdown wireframes -> reviewable HTML preview + approval workflow.',
  },
  rbac: {
    file: './cobolt-rbac.js',
    desc: 'EN-01 role and tenant-aware pipeline authorization policy (init, check, whoami)',
  },
  explain: {
    file: './cobolt-explain.js',
    desc: 'GT-06 gate failure-advice explainer — `cobolt-explain <gate-id>` prints rule + evidence + run-this-to-fix command instead of grepping skip-log/state/halt artifacts',
  },
  'why-blocked': {
    file: './cobolt-why-blocked.js',
    desc: 'OB-02 halt explainer — reads HUMAN-REVIEW-REQUIRED.md and recent gate advice to print rule, evidence, and unblock command',
  },
  policy: {
    file: './cobolt-policy.js',
    desc: 'PI-01/GT-07 policy interoperability — export gate semantics and evaluate json|opa bundles with additive-only-deny merging (subcommands: export, schema, verify, evaluate).',
  },
  sbom: { file: './cobolt-sbom.js', desc: 'Software Bill of Materials generation' },
  provenance: {
    file: './cobolt-provenance.js',
    desc: 'SC-06 provenance checksums, in-toto-style attestations, and signature verification for SBOM/release artifacts',
  },
  'verify-install': {
    file: './cobolt-verify-install.js',
    desc: 'SC-09 install trust-chain manifest generation and offline verification',
  },
  airgap: {
    file: './cobolt-airgap.js',
    desc: 'EN-03 air-gapped install readiness verification and runbook pointer',
  },
  'plugin-lock': {
    file: './cobolt-plugin-lock.js',
    desc: 'SC-07 MCP/plugin lockfile generation and drift verification',
  },
  'output-governance': {
    file: './cobolt-output-governance.js',
    desc: 'SC-08 _cobolt-output artifact classification, archive, redaction, encryption, and purge controls',
  },
  'install-tools': { file: './cobolt-install-tools.js', desc: 'Auto-install missing security/quality tools' },
  'install-verify': {
    file: './cobolt-install-verify.js',
    desc: 'Verify deployed install matches source contract (counts, settings, no placeholder leaks, no orphan tmp)',
  },
  'install-quality-tools': {
    file: './cobolt-install-quality-tools.js',
    desc: 'Auto-provision quality tools (linters, formatters, type checkers) per tech stack',
  },
  'stat-source': {
    file: './cobolt-stat-source.js',
    desc: 'Single source of truth for repo-actual stat counts — emits _cobolt-output/stats/current.json and gates README/AGENTS/CLAUDE drift (SF-02)',
  },

  telemetry: {
    file: './cobolt-telemetry.js',
    desc: 'EN-04 telemetry posture certification and network-callsite inventory',
  },
  tenant: {
    file: './cobolt-tenant.js',
    desc: 'EN-02 tenant profile and _cobolt-output tenant path management',
  },
  'evidence-pack': {
    file: './cobolt-evidence-pack.js',
    desc: 'EN-06 compliance evidence pack generator for SOC2, ISO, HIPAA, FedRAMP, and PCI',
  },
  'run-manifest': {
    file: './cobolt-run-manifest.js',
    desc: 'EN-08 signed reproducible pipeline run manifests and deterministic replay verification',
  },
  extension: {
    file: './cobolt-extension.js',
    desc: 'EN-09 customer extension manifest validation and discovery',
  },
  'workflow-integration': {
    file: './cobolt-workflow-integration.js',
    desc: 'EN-11 issue/chat workflow packet and approval request bridge',
  },
  'enterprise-readiness': {
    file: './cobolt-enterprise-readiness.js',
    desc: 'EN-01..EN-11 enterprise readiness control-plane checker',
  },

  // Execution tools
  test: { file: './cobolt-test.js', desc: 'Multi-framework test runner with watchdog' },
  'test-changed': {
    file: './cobolt-test-changed.js',
    desc: 'PF-03 change-aware test selection — git-diff-driven test list (with --run mode)',
  },
  docker: { file: './cobolt-docker.js', desc: 'Docker build, run, verify lifecycle' },
  'deploy-verify': {
    file: './cobolt-deploy-verify.js',
    desc: 'Post-deploy probe gauntlet (k8s/ecs/cloudrun/fly/compose) + auto-rollback; writes health-report.json',
  },
  worktree: { file: './cobolt-worktree.js', desc: 'Git worktree create/remove/list for parallel builds' },
  'git-workflow': { file: './cobolt-git-workflow.js', desc: 'Milestone branch lifecycle, auto-commit, auto-push' },
  git: { file: './cobolt-git.js', desc: 'Git utilities (branches, hotfix, PR operations)' },

  // Agent dispatch
  'agent-ceiling': {
    file: './cobolt-agent-ceiling.js',
    desc: 'Tier 1 gate — caps source/agents/*.md count (PF-04). Configurable via package.json cobolt.agentCeiling',
  },
  'agent-dedup': {
    file: './cobolt-agent-dedup.js',
    desc: 'AD-04 Phase 1 — read-only classifier that clusters agents by (capability + grounding + escalationTarget) and writes a dedup proposal for human-committed aliasing. Never writes to source/agents/.',
  },
  'agent-teams': {
    file: './cobolt-agent-teams.js',
    desc: 'Agent team dispatch detection, availability check, ownership formatting',
  },
  'agent-hub': {
    file: './cobolt-agent-hub.js',
    desc: 'Shared multi-agent notes, attempt leaderboard, and heartbeat checks for worktree-based runs',
  },
  'dispatch-depth': { file: './cobolt-dispatch-depth.js', desc: 'Dispatch depth tracking and agent team state' },

  // Adoption & positioning
  benchmark: {
    file: './cobolt-benchmark.js',
    desc: 'AD-05 Phase 1 — buyer-facing benchmark corpus: list/validate/record/report cases against multi-vendor delivery surfaces. Read-only by default; record appends to _cobolt-output/audit/benchmarks/.',
  },

  // Test orchestration
  'test-suite': {
    file: './cobolt-test-suite.js',
    desc: 'Scenario-based test orchestration (autonomous + normal modes)',
  },
  'flake-hunter': {
    file: './cobolt-flake-hunter.js',
    desc: 'Detect flaky tests, retries, duration regressions, and unstable suites',
  },
  'test-registry': {
    file: './cobolt-test-registry.js',
    desc: 'Persistent test case catalog, cross-run results, lineage tracking',
  },
  'exploit-cache': {
    file: './cobolt-exploit-cache.js',
    desc: 'Verdict cache for security-exploit-verifier — short-circuits real exploit replay when finding evidence files unchanged since prior blocked attempt',
  },
  playwright: {
    file: './cobolt-playwright.js',
    desc: 'Browser testing, route crawling, screenshots, visual regression',
  },
  uat: {
    file: './cobolt-uat.js',
    desc: 'Deterministic UAT planning, persona coverage, evidence, and loop verdicts',
  },
  'uat-evidence': {
    file: './cobolt-uat-evidence-validate.js',
    desc: 'Validate UI visual, Chrome DevTools, raw browser artifacts, and MCP call ledger evidence',
  },
  'browser-evidence': {
    file: './cobolt-browser-evidence-validate.js',
    desc: 'Deterministic Playwright+Chrome DevTools browser evidence validator (build/fix/review/deploy) — freshness + MCP ledger census; Tier 1 gate backend',
  },
  'design-token-extract': {
    file: './cobolt-design-token-extract.js',
    desc: 'Deterministic visual token extraction across CSS, theme files, and design-system hints',
  },
  'ui-detect': {
    file: './cobolt-ui-detection.js',
    desc: 'Deterministic UI/front-end detection for build, review, and browser-test gating',
  },
  'code-index': {
    file: './cobolt-code-index.js',
    desc: 'Structural code search, codebase mapping, dependency graphs, document navigation (ast-grep)',
  },
  'knowledge-graph': {
    file: './cobolt-knowledge-graph.js',
    desc: 'Typed graph over code, docs, requirements, findings, and milestone artifacts',
  },
  'evidence-nav': {
    file: './cobolt-knowledge-graph.js',
    desc: 'Pipeline-native evidence navigation and traceable context packs',
  },
  'embedding-index': {
    file: './cobolt-embedding-index.js',
    desc: 'Project-local chunks and optional OpenAI embeddings for evidence navigation',
  },
  'round-summary': {
    file: './cobolt-round-summary.js',
    desc: 'Per-round bounded-context memory (~500 tokens per round) — emit/show/list',
  },
  'design-cache-slice': {
    file: './cobolt-design-cache-slice.js',
    desc: 'Screen-scoped extract from M{n}-design-cache.md for UI builder dispatch (fallback-safe)',
  },
  'api-contracts-slice': {
    file: './cobolt-api-contracts-slice.js',
    desc: 'Endpoint-scoped extract from api-contracts.md for API builder dispatch (fallback-safe)',
  },
  tracks: {
    file: './cobolt-track.js',
    desc: 'CoBolt-native capability catalog built from source tracks manifests',
  },
  brief: {
    file: './cobolt-brief.js',
    desc: 'Audience-aware stage briefs generated from structured CoBolt outputs',
  },
  'course-export': {
    file: './cobolt-course-export.js',
    desc: 'Generate a codebase walkthrough course from graph, planning, milestone, and review artifacts',
  },
  trust: {
    file: './cobolt-trust.js',
    desc: 'Stage trust reports that explain what is proven, computed, or still pending review',
  },
  'public-surface': {
    file: './cobolt-public-surface-check.js',
    desc: 'Validate public workflow docs, CLI root commands, aliases, and command modules for drift',
  },
  'public-claims': {
    file: './cobolt-public-claims.js',
    desc: 'Verify README/product-copy public claims have evidence (SF-08) — pass | stale | unsupported per claim',
  },
  'output-contract': {
    file: './cobolt-output-contract.js',
    desc: 'Validate _cobolt-output/latest, run pointers, report directories, and schema-backed artifacts',
  },
  'build-packet-freshness': {
    file: './cobolt-build-packet-freshness.js',
    desc: 'Build Step 00/07 packet-source snapshot and stale-plan detector â€” records source digests and blocks when planning artifacts drift after packetization',
  },
  'plan-ingestion-manifest': {
    file: './cobolt-plan-ingestion-manifest.js',
    desc: 'Build Step 00 plan-artifact ingestion contract — enumerates build-required planning artifacts, carriers, and gate tiers',
  },
  'release-readiness': {
    file: './cobolt-release-readiness-check.js',
    desc: 'Run the deterministic release-readiness gate and write durable JSON/Markdown evidence',
  },
  'addon-packs': {
    file: './cobolt-addon-packs.js',
    desc: 'Optional add-on pack catalog, install state, and post-install guidance',
  },

  // Document manifest and archival
  manifest: {
    file: './cobolt-manifest.js',
    desc: 'Document indexing, verification, and milestone archival',
  },
  'manifest-verify': {
    file: './cobolt-manifest-verify.js',
    desc: 'Post-round file completeness checker — verifies story-spec files exist on disk',
  },
  'spec-verify': {
    file: './cobolt-spec-verify.js',
    desc: 'Deterministic impl-spec verification — census check of File Map + Function Signatures against disk',
  },
  'spec-quality': {
    file: './cobolt-spec-quality.js',
    desc: 'Spec content quality gate — detects boilerplate Data Structures / Integration Points, English-not-signatures, File Map ↔ Implementation Order drift, and cloned feature dossiers (C-1 / M-1 fix)',
  },
  'story-specs': {
    file: './cobolt-story-specs.js',
    desc: 'Deterministic Build Step 01A story-spec copy/index/checkpoint tool',
  },
  'promise-census': {
    file: './cobolt-promise-census.js',
    desc: 'Planning-doc ↔ manifest/config/source promise census — detects libraries cited in architecture/standards/pk-base with no dep, UX fonts not loaded, invalid Cargo profile fields, version-claim drift, Tauri capabilities missing, unwired a11y tests (C-3 / C-4 / L-1 / L-3 / M-8 / M-9 / M-11 fix)',
  },
  'tautology-scan': {
    file: './cobolt-tautology-scan.js',
    desc: 'Deterministic tautological-assertion detector — catches x || !x, expect(x).toBe(x), assertEqual(x, x), assert(true) and similar no-op assertions across Rust/JS/TS/Python tests (C-5 fix)',
  },
  // ── v0.65 Reverse-Engineering Wave 2.2 (3 Tier-2 census tools) ──
  // Spec: docs/REVERSE-ENGINEERING-PIPELINE-ENHANCEMENTS.md §5.4.
  // Exit codes follow the standard 0=ok, 1=usage, 2=skipped, 3=findings (advisory) contract.
  'rule-source-coverage': {
    file: './cobolt-rule-source-coverage.js',
    desc: 'RE Wave 2.2 (Tier 2): per-source-file extracted-rule census from 00-source-file-manifest.json. Flags zero-rule files above LOC floor (default 200). Surfaces patterns the aggregate completeness gate cannot.',
  },
  'validation-rule-completeness': {
    file: './cobolt-validation-rule-completeness.js',
    desc: 'RE Wave 2.2 (Tier 2): for every external input catalogued by validation-cataloger-agent (15-validation-and-error-catalog.md), verifies a validation rule exists. Reports inputs with no covering rule.',
  },
  'rule-conflict-detector': {
    file: './cobolt-rule-conflict-detector.js',
    desc: 'RE Wave 2.2 (Tier 2): cross-rule conflict scanner. Detects same subject+verb with different objectOrValue, modality contradictions (prohibition vs obligation), and source-location overlap with divergent SBVR forms. Drift logged to _cobolt-output/audit/rule-conflict-drift.json.',
  },
  // ── v0.65.1 Reverse-Engineering Wave 5 (quality-first closure) ──
  // Two new standards / compliance tools complementing the §5.7 evidence module
  // (which lives at tools/cobolt-re-evidence.js and is invoked indirectly via
  // tools/cobolt-standards.js MODULES). All three follow the canonical exit
  // contract (0=ok, 1=usage, 2=skipped, 3=findings/gaps).
  're-evidence': {
    file: './cobolt-re-evidence.js',
    desc: 'RE Wave 5 §5.7 (Tier 1): five RE-specific evidence checks (SBVR 1.5 conformance, DMN 1.5 hit-policy validity, ISO 14764 maintenance category, NIST SP 800-160 loss-control citation, GDPR Art. 30 records-of-processing). Invoked via the cobolt-standards.js `reverse-engineering` profile; runnable standalone for diagnostics. Skips silently on non-RE projects.',
  },
  'compliance-evidence-pack': {
    file: './cobolt-compliance-evidence-pack.js',
    desc: 'RE Wave 5 §5.12 (Tier 2 advisory): assembles a packaged compliance bundle (GDPR Art. 30 + Art. 35, HIPAA 164.308(a)(8), PCI-DSS scope reduction, SOC 2 TSP-100) from existing brownfield artifacts when personal/health/payment data is detected. Output conforms to source/schemas/compliance-evidence-bundle.schema.json. Never blocks.',
  },
  'test-shape-lint': {
    file: './cobolt-test-shape-lint.js',
    desc: 'Existence-only test-shape detector — catches assert Code.ensure_loaded?(Mod), function_exported?, expect(typeof X).toBe("function"), expect(X).toBeDefined(), hasattr/callable/inspect.is*, reflect.TypeOf().Kind() shape-only checks across Elixir/JS/TS/Python/Go. Closes the RawDrive042026 M1 incident class where 1,572 tests passed against stub modules and Step 03A then found 662 spec-code gaps (2026-04-25).',
  },
  'gap-escalation-router': {
    file: './cobolt-gap-escalation-router.js',
    desc: 'Step 03A escalation router — transforms M{n}-code-gap-report.json (+ optional builder-return-log.jsonl) into a structured dispatch plan grouping critical/high gaps by domain (db, backend, frontend, contract, naming, other), assigning the matching fix-agent (db-fix, backend-fix, frontend-fix, architect-fix-agent), and chunking each domain at --max-per-agent (default 25). Replaces the terminal `auto_fail gate-hard-block` with a fix-and-forward escalation network. Closes RC-3 from the v0.51 plan.',
  },
  'validate-escalation-router': {
    file: './cobolt-validate-escalation-router.js',
    desc: 'Step 07 escalation router — sister to gap-escalation-router. Transforms M{n}-validation-results.json (failed Phase A layers L1/L1b/L2/L2b/L3/L4/L4b/L5*/L6) into a structured dispatch plan grouping by domain (test, backend, frontend, framework, traceability, review), assigning matching fix-agents and per-domain remediation hints. Replaces the `auto_fail validation-layer-failed` at Step 07 line 147 with a fix-and-forward escalation network. Hard-block survives only for infrastructure failures, not failed-layer counts.',
  },
  'naming-normalizer': {
    file: './cobolt-naming-normalizer.js',
    desc: 'Language-aware naming normalizer — to-snake, to-camel, to-pascal, validate-path (detects snake-case drift like signup vs sign_up), expand-tree (returns canonical Elixir context-shape triplet operations.ex/schema.ex/policy.ex). Closes the M1 RawDrive snake-case drift class that contributed to 662 spec-code gaps (2026-04-25).',
  },
  'mcp-audit': {
    file: './cobolt-mcp-audit.js',
    desc: 'Per-agent declared-vs-inferred MCP tool coverage — distinguishes project-MCP servers (registered in runtime config or .mcp.json + env keys in .env.cobolt) from plugin-MCP servers (Claude Code plugin install required); writes _cobolt-output/audit/mcp-coverage-report.json',
  },
  'blocked-tasks': {
    file: './cobolt-blocked-tasks.js',
    desc: 'Cross-milestone task dependency registry — extract, defer, unblock, sweep lifecycle',
  },
  'milestone-dashboard': {
    file: './cobolt-milestone-dashboard.js',
    desc: 'Native project progress — per-milestone task/story completion, deferred work, real-time status',
  },

  // Reporting and metrics
  report: { file: './cobolt-report.js', desc: 'Generate reports (Markdown, JSON, summary)' },
  metrics: { file: './cobolt-metrics.js', desc: 'Pipeline metrics aggregation and display' },
  'production-readiness': {
    file: './cobolt-production-readiness.js',
    desc: 'Production-readiness telemetry — 6 metrics + composite score, emits production-readiness.jsonl',
  },
  'hook-latency': {
    file: './cobolt-hook-latency.js',
    desc: 'Hook latency & failure budget rollup (v0.24) — per-hook p50/p95/p99, class breach detection, crash report',
  },
  'production-quality': {
    file: './cobolt-production-quality.js',
    desc: 'Production quality gate — decomposition, strict gates, real environments, independent verification, human ownership',
  },
  'production-evidence': {
    file: './cobolt-production-evidence.js',
    desc: 'Executable production evidence gate — PRD depth, slices, architecture, boundary contracts, security, resilience, validation, no-stubs',
  },
  'production-evidence-validate': {
    file: './cobolt-production-evidence-validate.js',
    desc: 'Pre-gate schema validator for executable-prd / release-slices / architecture-readiness / boundary-contracts — runs BEFORE production-evidence so shape violations surface with field-level errors, not cryptic business-logic failures',
  },
  'self-audit-stub-pack': {
    file: './cobolt-self-audit-stub-pack.js',
    desc: 'CoBolt self-audit stub packet generator. Writes a fixed-shape evidence packet for CoBolt stabilization runs ONLY — refuses to overwrite canonical planning artifacts produced by real plan pipelines (use --force to override). NEVER invoked by production-readiness-check.',
  },
  'production-evidence-pack': {
    file: './cobolt-self-audit-stub-pack.js',
    desc: '[DEPRECATED] Renamed to self-audit-stub-pack. Kept as alias for backward compatibility; emits deprecation warning on invocation. Will be removed in next major.',
    deprecated: {
      renamedTo: 'self-audit-stub-pack',
      reason:
        'Clarifies that this tool is a CoBolt self-audit stub, not a general-purpose readiness artifact producer. See CHANGELOG for the split.',
    },
  },
  'production-evidence-emit': {
    file: './cobolt-production-evidence-emit.js',
    desc: 'CB-OBS-18 — greenfield counterpart to brownfield-planning-sync. Emits the 4 canonical production-evidence artifacts (executable-prd.json, release-slices.json, architecture-readiness.json, boundary-contracts.json) from rtm.json + story-tracker.json at plan close.',
  },
  'production-readiness-check': {
    file: './cobolt-production-readiness-check.js',
    desc: 'Explicit sidecar production-readiness sequence: tools gate, evidence pack, app runtime verification, reconciliation, and release gates',
  },
  'app-runtime-check': {
    file: './cobolt-app-runtime-check.js',
    desc: 'Deterministic app runtime gate: start command, base URL, HTTP probe, and CLI/library fallback verification',
  },
  'build-integration-smoke': {
    file: './cobolt-build-integration-smoke.js',
    desc: 'Deterministic build Step 03B integration smoke orchestration: wiring, worker lifecycle, API contract, and app runtime checks',
  },
  'build-setup-step': {
    file: './cobolt-build-setup-step.js',
    desc: 'Deterministic build Step 01 setup wrapper: planning context, build packet, task manifest, docs/design cache, and checkpoint',
  },
  'build-spec-validation-step': {
    file: './cobolt-build-spec-validation-step.js',
    desc: 'Deterministic build Step 01B spec validation wrapper: coverage, file ownership, interface consistency, scoped spec-quality, checkpoint, and proof',
  },
  'build-tdd-red-step': {
    file: './cobolt-build-tdd-red-step.js',
    desc: 'Deterministic build Step 02 TDD RED wrapper: UAT inventory, five-round test plan, test manifest, checkpoint, and proof',
  },
  'build-tdd-green-step': {
    file: './cobolt-build-tdd-green-step.js',
    desc: 'Deterministic build Step 03 TDD GREEN wrapper for local code-workflow milestones with docs/module contract evidence',
  },
  'build-code-gap-step': {
    file: './cobolt-build-code-gap-step.js',
    desc: 'Deterministic build Step 03A code-gap wrapper: spec verification, capability-edge proof, report consolidation, checkpoint, and proof',
  },
  'build-refactor-gate': {
    file: './cobolt-build-refactor-gate.js',
    desc: 'Deterministic build Step 04 refactor review and quality-gate orchestration, including .NET build/test evidence',
  },
  'build-deep-verification-step': {
    file: './cobolt-build-deep-verification-step.js',
    desc: 'Deterministic build Step 04A deep verification wrapper: illusion, gap, authz, test-trust, browser-surface, and pre-review evidence',
  },
  'build-issue-registry-step': {
    file: './cobolt-build-issue-registry-step.js',
    desc: 'Deterministic build Step 04B issue-registry wrapper with UTF-8 rollup report output and proof/checkpoint publication',
  },
  'build-review-step': {
    file: './cobolt-build-review-step.js',
    desc: 'Deterministic build Step 05 delegation to the source-backed cobolt-review CLI with checkpoint/proof verification',
  },
  'review-step': {
    file: './cobolt-review-step.js',
    desc: 'Deterministic cobolt-review step runner for Wave 1, Wave 2, cross-validation, coverage, and handoff contracts',
  },
  'build-fix-step': {
    file: './cobolt-build-fix-step.js',
    desc: 'Deterministic build Step 06 fix-loop wrapper with no-blocking-finding evidence and optional cobolt-fix delegation',
  },
  'nfr-enforce': {
    file: './cobolt-nfr-enforce.js',
    desc: 'Deterministic build Step 06D NFR budget enforcement, findings publication, and verdict generation',
  },
  'build-validate-step': {
    file: './cobolt-build-validate-step.js',
    desc: 'Deterministic build Step 07 validation wrapper with phase-B, schema, and capability proof artifacts',
  },
  'fixed-path-coverage': {
    file: './cobolt-fixed-path-coverage.js',
    desc: 'Build Step 07 fixed-path coverage gate — verifies fix-touched source files are exercised by file-level coverage evidence',
  },
  'stack-conformance': {
    file: './cobolt-stack-conformance.js',
    desc: 'v0.42: contract-driven stack conformance — verifies selected-stack-contract.json declarations against shipping tree (entrypoints, requiredFolders, framework keyword, testCommands) + carryover scaffold-only detectors. No framework allowlist.',
  },
  'contract-reachability': {
    file: './cobolt-contract-reachability.js',
    desc: 'v0.42: reachability gate — walks selected-stack-contract + app-surface-contract surfaces through reference/custom/generic dispatch and proves every declared surface is reachable from the shipping entrypoints',
  },
  'harness-only-detector': {
    file: './cobolt-harness-only-detector.js',
    desc: 'v0.42: rejects null-domain implementations — scans shipping tree vs test harness for every stack-contract integration, using domain-primitives.json as the library/symbol signal set',
  },
  'source-write-provenance': {
    file: './cobolt-source-write-provenance.js',
    desc: 'v0.42: shipping-source provenance ledger (record|check|verify) — census-checks every shipping file has an allowlisted writer record in _cobolt-output/audit/source-write-provenance.jsonl',
  },
  'build-cross-smoke-step': {
    file: './cobolt-build-cross-smoke-step.js',
    desc: 'Deterministic build Step 08B cross-milestone smoke wrapper with M1 skip verdict and checkpoint',
  },
  'build-complete-step': {
    file: './cobolt-build-complete-step.js',
    desc: 'Deterministic build Step 08 milestone completion wrapper with deferred-work and build-report artifacts',
  },
  'class-applies': {
    file: './cobolt-class-applies.js',
    desc: 'Process-level skip predicate over the pipeline-class-rules registry; lets step files ask "does this round/step apply for the detected project class?"',
  },
  'agent-failure-review': {
    file: './cobolt-agent-failure-review.js',
    desc: 'Scan agent/runtime failure evidence and write review-lead escalation packets with full context',
  },
  governance: {
    file: './cobolt-governance.js',
    desc: 'Governance advisory layer: preflight, principles, privacy, strategy map, procurement, portal, maturity, next-step, and agent escalation',
  },
  'state-readiness': {
    file: './cobolt-state-readiness-reconcile.js',
    desc: 'Compare cobolt-state.json readiness fields with durable production evidence and quality reports',
  },
  'plateau-rollup': {
    file: './cobolt-plateau-rollup.js',
    desc: 'Summarize fix-loop plateau events and route unresolved cycles to review-lead/advisor escalation',
  },
  'contract-invention': {
    file: './cobolt-contract-invention.js',
    desc: 'Detect INVENTED cross-cutting references (HTTP/SQL/event) with no contract + no local provider; records contractInventions metric',
  },
  'contract-verify': {
    file: './cobolt-contract-verify.js',
    desc: 'Verify codebase against interface-contracts.json (API/DATA/EVT/INFRA/TYPE); records contractViolations metric',
  },
  'contract-semantic-verify': {
    file: './cobolt-contract-semantic-verify.js',
    desc: 'Semantic (L2/L3/L4) contract verifier — JSON Schema payload conformance, example replay evidence, invariant coverage (v0.12.0 WS1)',
  },
  'contract-governance': {
    file: './cobolt-contract-governance.js',
    desc: 'Write-boundary contract governance verifier — pact replay evidence + two-architect renegotiation/ADR ledger checks (paired with cobolt-contract-governance-gate)',
  },
  'contract-testgen': {
    file: './cobolt-contract-testgen.js',
    desc: 'Emit executable contract replay tests from examples[] into tests/contracts/ (JS/Elixir/Python stacks) (v0.12.0 WS1)',
  },
  'domain-ir-pack': {
    file: './cobolt-domain-ir-pack.js',
    desc: 'Detect + inject + verify domain-mandatory IRs (fintech/healthcare/ecommerce/saas-multitenant/realtime-collab) (v0.12.0 WS2)',
  },
  'prd-redteam': {
    file: './cobolt-prd-redteam.js',
    desc: 'Adversarial PRD gap hunter — 9 deterministic probes + 5-axis rubric; merges with prd-redteam-agent verdict (v0.12.0 WS4)',
  },
  'arch-propose': {
    file: './cobolt-arch-propose.js',
    desc: 'Architecture mutation proposals — new/validate/status/apply/list, gated by cobolt-arch-mutation-gate (v0.12.0 WS3)',
  },
  bc: {
    file: './cobolt-bc.js',
    desc: 'Bounded-context decomposition — init/list/validate/assign-milestone/assign-fr/coverage/owner-of (v0.12.0 WS5)',
  },
  'cross-milestone-smoke': {
    file: './cobolt-cross-milestone-smoke.js',
    desc: 'Discover + run cross-milestone regression tests; records crossMilestoneSmokeFailures metric',
  },
  'security-accept': {
    file: './cobolt-security-accept.js',
    desc: 'HMAC-audited acceptance workflow for critical/high security findings (used with cobolt-security-hard-gate)',
  },
  'observability-check': {
    file: './cobolt-observability-check.js',
    desc: 'Pattern-based scan for structured log / metrics / traces / error classification (4 observability primitives)',
  },
  'seed-verify': {
    file: './cobolt-seed-verify.js',
    desc: 'Cumulative seed-shape verifier — asserts M(n) boundary has sufficient rows for every prior milestone contract',
  },
  'behavior-coverage': {
    file: './cobolt-behavior-coverage.js',
    desc: 'Per-FR behavior coverage taxonomy (happy/failure/edge/concurrency) — records behaviorCoverageGaps metric',
  },
  'audit-lite': {
    file: './cobolt-audit-lite.js',
    desc: 'Per-round scoped audit — runs stub/illusion scan on git-changed files after each TDD GREEN turn',
  },
  'architecture-log': {
    file: './cobolt-architecture-log.js',
    desc: 'Living architecture log — snapshot actual endpoints/migrations/events per milestone; feeds next-milestone planning',
  },
  'context-inject': {
    file: './cobolt-context-inject.js',
    desc: 'Signature-only source extraction for late-milestone builders (M3+) — budget-constrained prior-milestone context',
  },
  'uat-regression': {
    file: './cobolt-uat-regression.js',
    desc: 'Save + replay UAT cases across milestones — catches prior-milestone regressions at M(n>1) boundaries',
  },
  'provenance-check': {
    file: './cobolt-provenance-check.js',
    desc: 'Advisory scan for uncited non-trivial decisions in stories + commits (cite-or-die — [PRD]/[ARCH]/[ADR-N]/[M{k}#file:line])',
  },
  'perf-budget': {
    file: './cobolt-perf-budget.js',
    desc: 'Emit perf budget.json (from TRD) and perf-results.json (measured) — activates cobolt-perf-budget-gate',
  },
  'seed-shape': {
    file: './cobolt-seed-shape.js',
    desc: 'Scaffold per-milestone seed-shape.json from migrations — activates cobolt-seed-gate',
  },
  'chaos-verdict': {
    file: './cobolt-chaos-verdict.js',
    desc: 'Record chaos-engineering scenario results and finalize verdict — activates cobolt-chaos-gate',
  },
  'deploy-readiness': {
    file: './cobolt-deploy-readiness.js',
    desc: 'v0.44: BUILD-07 closer — validates deploy-readiness.json against schema (rollback, observability, runbook, ownership, backup/restore). scaffold + check subcommands.',
  },
  'mttr-probe': {
    file: './cobolt-mttr-probe.js',
    desc: 'v0.44: runs declared chaos scenarios via adapter, asserts MTTR SLOs. Framework + contract; adapters stubbed in tools/adapters/ (real impls in v0.44.x packages).',
  },
  'change-register': {
    file: './cobolt-change-register.js',
    desc: 'v0.44: append-only change register at _cobolt-output/audit/change-register.jsonl. append/list/stats. Feeds DORA + dream.',
  },
  'postmortem-sla': {
    file: './cobolt-postmortem-sla.js',
    desc: 'v0.44: enforces postmortem SLA per severity (default P0=48h, P1=120h). audit + config subcommands. Reads change-register for incident-open/postmortem-close.',
  },
  'production-done': {
    file: './cobolt-production-done.js',
    desc: 'v0.44: 8-point production-done checklist (requirement coverage, ambiguity resolution, contracts, build+validate, supply-chain, deploy-readiness, post-deploy verification, DORA+change-register+postmortem-SLA).',
  },
  'risk-acceptance': {
    file: './cobolt-risk-acceptance.js',
    desc: 'v0.45: BUILD-04 closer — project-level risk-acceptance register with HMAC-SHA256 signatures. list/accept/verify/audit subcommands. Peer to cobolt-fix-risk-acceptance (narrower fix-loop scope).',
  },
  'nfr-preflight': {
    file: './cobolt-nfr-preflight.js',
    desc: 'v0.45: BUILD-05 closer — validates nfr-budgets.json declares all four categories (perf/security/chaos/authEdge), populates every perf field, maps every budget to at least one FR/NFR/IR, and is ≤90 days old BEFORE milestone build work begins. Peer to cobolt-nfr-enforce which runs AFTER.',
  },
  health: { file: './cobolt-health.js', desc: 'Project health diagnostics' },
  'change-discipline': {
    file: './cobolt-change-discipline.js',
    desc: 'Diff discipline scan for scope drift, speculative abstractions, TODO debt, and source changes without tests',
  },
  'write-discipline': {
    file: './cobolt-write-discipline.js',
    desc: 'Lint gate enforcing canonical atomic-write helpers for cobolt-state.json + _cobolt-output writes; ratchets against .write-discipline-allowlist.json baseline',
  },
  'project-lessons': {
    file: './cobolt-project-lessons.js',
    desc: 'Project-wide lessons summary from dream reports, memory extracts, fix lessons, and state learnings',
  },
  'dead-ends': {
    file: './cobolt-dead-ends.js',
    desc: 'Negative knowledge accumulation — records failed fix approaches to prevent strategy repetition',
  },
  // v0.65.3 (audit S3-C): removed zombie entries 'evo-bench' and
  // 'surrogate-verifier' — both pointed to files that don't exist on disk
  // (./cobolt-evo-bench.js, ./cobolt-surrogate-verifier.js) and ENOENT'd
  // when dispatched via `node tools/index.js evo-bench`. Re-add when the
  // tools actually ship.

  // Pre-flight and compliance
  preflight: {
    file: './cobolt-preflight.js',
    desc: 'Planning artifact gate — check if required artifacts exist before build/review/deploy',
  },
  'rebalance-apply': {
    file: './cobolt-rebalance-apply.js',
    desc: 'Apply suggestedMoves[] from milestone-rebalance-plan.json to story-tracker.json + rtm.json — non-destructive FR-coverage-preserving alternative to greenfield decompose (v0.52+)',
  },
  'build-ready-gate': {
    file: './cobolt-build-ready-gate.js',
    desc: 'Deterministic plan→build handoff gate — runs preflight, auto-remediates deterministic gaps, emits LLM remediation queue',
  },
  'preflight-self-heal': {
    file: './cobolt-preflight-self-heal.js',
    desc: 'Build preflight self-heal gating + audit log (one-shot recovery budget per trigger)',
  },
  'planning-artifact-audit': {
    file: './cobolt-planning-artifact-audit.js',
    desc: 'Detect planning artifacts written outside the canonical latest planning directory',
  },
  'plan-quality-artifacts': {
    file: './cobolt-plan-quality-artifacts.js',
    desc: 'Generate/check Plan production quality artifacts: scorecard, UX states, examples, fixtures, observability, budgets, operations, abuse cases, fitness checks, launch gate',
  },
  'milestone-execution-obligations': {
    file: './cobolt-milestone-execution-obligations.js',
    desc: 'Generate/check milestone execution obligations plus planning-quality enhancement and escalation context for build handoff',
  },
  'planning-integrity': {
    file: './cobolt-planning-integrity.js',
    desc: 'Tier 1 planning integrity gate — census-validates tracker shape, RTM linkage, spec coverage, diagram quality, version capture, epic-ID consistency (15 contracts, v0.23 defect audit)',
  },
  'planning-context': {
    file: './cobolt-planning-context.js',
    desc: 'Build compact path-based planning context packets for agent dispatch',
  },
  'planning-handoff': {
    file: './cobolt-planning-handoff.js',
    desc: 'Resumable planning handoff summarizing source intake, readiness signals, contradictions, and the next resume/build command',
  },
  'plan-args': {
    file: './cobolt-plan-args.js',
    desc: 'Deterministic /cobolt-plan argument normalizer - expands --auto to imply --enhance --scope enterprise (plan-pipeline only; does NOT affect build/fix/review/deploy --auto semantics)',
  },
  'context-budget': {
    file: './cobolt-context-budget.js',
    desc: 'Prompt/context fan-out budget guard with compact packet enforcement',
  },
  'postmortem-ingest': {
    file: './cobolt-postmortem-ingest.js',
    desc: 'Convert postmortem logs into learning records and replay candidates',
  },
  'replay-harness': {
    file: './cobolt-replay-harness.js',
    desc: 'Replay known pipeline failure scenarios against deterministic controls',
  },
  'artifact-provenance': {
    file: './cobolt-artifact-provenance.js',
    desc: 'Stamp and verify producer/path/input-hash metadata for generated artifacts',
  },
  'branch-topology': {
    file: './cobolt-branch-topology.js',
    desc: 'Check PR branch freshness and sibling branch file-overlap risk',
  },
  'gate-coverage': {
    file: './cobolt-gate-coverage.js',
    desc: 'Verify known failure modes are mapped to deterministic gates and tests',
  },
  'stop-line': {
    file: './cobolt-stop-line.js',
    desc: 'Stop-the-line threshold checks for repeated fix loops, token waste, and PR conflicts',
  },
  audit: {
    file: './cobolt-audit.js',
    desc: 'PRD compliance audit — stub detection, requirement tracing, implementation depth',
  },
  'deploy-marker-audit': {
    file: './cobolt-deploy-marker-audit.js',
    desc: 'Verify {"type":"commonjs"} markers in deployed CoBolt trees (hooks/, cobolt/lib/, cobolt/tools/) — guards against ESM consumer projects',
  },
  'compliance-gate': {
    file: './cobolt-compliance-gate.js',
    desc: 'Compliance framework control coverage gate (SOC2/GDPR/DPDP/HIPAA/PCI planning and release evidence)',
  },
  'standards-gate': {
    file: './cobolt-standards-gate.js',
    desc: 'Always-on secure coding, engineering standards, and quality gate coverage',
  },
  'accuracy-evaluator': {
    file: './cobolt-accuracy-evaluator.js',
    desc: 'Score output quality via RTM coverage, schema conformance, and golden fixtures',
  },
  'illusion-scan': {
    file: './cobolt-illusion-scan.js',
    desc: 'Behavioral illusion detection — facades, mock-data, noop wrappers, async-no-await',
  },
  'authz-probe': {
    file: './cobolt-authz-probe.js',
    desc: 'Runtime authorization probe — verifies admin-only endpoints reject non-admin tokens (prevents privilege escalation)',
  },
  'bare-mount-probe': {
    file: './cobolt-bare-mount-probe.js',
    desc: 'Routing hygiene probe — flags raw 404s on router mount prefixes (/api, /admin, /v1)',
  },
  'scope-fence': {
    file: './cobolt-scope-fence.js',
    desc: 'Classify findings as in-scope vs deferred per milestone — prevents unrelated P0s from blocking delivery',
  },

  // Conversational side-channel (/cobolt-btw)
  'btw-classify': {
    file: './cobolt-btw-classify.js',
    desc: 'Deterministic intent classifier for /cobolt-btw (hint|query|suggest|note|ambiguous)',
  },
  'btw-harvest': {
    file: './cobolt-btw-harvest.js',
    desc: 'Bounded read-only context packet builder for /cobolt-btw (state, milestones, gate skips, memory, git log)',
  },
  'btw-log': {
    file: './cobolt-btw-log.js',
    desc: 'Append-only audit log for /cobolt-btw (_cobolt-output/audit/btw-log.jsonl, Tier 3 advisory)',
  },

  // Release management
  release: { file: './cobolt-release.js', desc: 'Version bump, sync, commit, tag, push (milestone releases)' },
  'project-version': {
    file: './cobolt-project-version.js',
    desc: 'User-project central version manager (.cobolt/project-version.json): show/bump/sync/check/history/init. Greenfield single-source-of-truth starting at 0.0.1; no-op in native mode.',
  },
  repair: {
    file: './cobolt-repair.js',
    desc: 'Diagnose + heal corrupt build checkpoints (phantom GREEN, missing predecessor artifacts). v0.13.4',
  },
  degradation: {
    file: './cobolt-degradation.js',
    desc: 'Pipeline degradation ledger: status, summary, tail, clear, record. v0.14.1',
  },
  advisory: {
    file: './cobolt-advisory.js',
    desc: 'Consume recovery-advisor proposals: pending, response, action, consume, resolve-phantom. v0.14.1',
  },
  'test-obligations': {
    file: './cobolt-test-obligations.js',
    desc: 'CLI wrapper for milestone test-category obligations check. Called from skills so lib/ is not require()d directly (v0.13.7)',
  },
  'plan-proof': {
    file: './cobolt-plan-proof.js',
    desc: 'Record + verify plan phase proofs (sub-skills dispatched, artifacts written, sha256). Phase gate reads these before approving checkpoint writes. v0.13.10',
  },
  'reliability-guard': {
    file: './cobolt-reliability-guard.js',
    desc: 'Release readiness checks for retries, idempotency, queue health, and recovery paths',
  },
  'config-drift': {
    file: './cobolt-config-drift.js',
    desc: 'Detect drift between source templates/hooks, runtime copies, workflows, and toolchain state',
  },
  'runtime-profiler': {
    file: './cobolt-runtime-profiler.js',
    desc: 'Correlate Lighthouse, Autocannon, Node CPU profile, and PromEx signals into one hotspot report',
  },

  // PR security
  'pr-threat-scan': {
    file: './cobolt-pr-threat-scan.js',
    desc: 'Deterministic PR diff threat scanner (75+ patterns, 8 categories)',
  },

  // Reverse engineering tools
  'legacy-scan': { file: './cobolt-legacy-scan.js', desc: 'Legacy technology detection and tech-age scoring' },
  'schema-reverse': {
    file: './cobolt-schema-reverse.js',
    desc: 'Database schema reverse engineering and ERD generation',
  },
  'rule-extract': { file: './cobolt-rule-extract.js', desc: 'Business rule extraction from source code' },
  'parity-test': { file: './cobolt-parity-test.js', desc: 'Parity test generation and legacy/modern comparison' },

  // Doc publishing (canonical → human-readable curator)
  'publish-docs': {
    file: './cobolt-publish-docs.js',
    desc: 'Publish canonical _cobolt-output artifacts to docs/cobolt/ topic folders with drift detection and failure contract',
  },

  // Requirements traceability
  rtm: { file: './cobolt-rtm.js', desc: 'Requirements Traceability Matrix (import, map, scan, check, report)' },
  'framework-versions': {
    file: './cobolt-framework-versions.js',
    desc: 'v0.47 (CB-OBS-07): Security/privacy/regulatory framework versions registry + staleness gate. list/citation/check subcommands. Reads source/data/security-frameworks-versions.json. Prevents LLM-authored security-requirements.md from drifting to outdated framework versions (e.g. OWASP ASVS v4.x when v5.0.0 is current).',
  },
  'line-anchor-verify': {
    file: './cobolt-line-anchor-verify.js',
    desc: 'v0.45.0: census-verifies review-findings.json file:line:codeSnippet citations against source. Emits verdict + line-drift hints. Closes review→fix hallucination cascade.',
  },
  'carry-forward-semantic': {
    file: './cobolt-carry-forward-semantic.js',
    desc: 'v0.45.0: semantic validation of deferred-work carry-forward items against current codebase (files, FR IDs, routes). Emits carry-forward-drift.json. Closes M{n+1} cascade where deferred items are semantically stale.',
  },
  'lesson-fact-check': {
    file: './cobolt-lesson-fact-check.js',
    desc: 'v0.45.0: end-of-milestone lesson fact-check — marks lessons whose citations no longer resolve as veracity=disputed, excluding them from future TF-IDF retrieval. Closes M1→M2 lessons-cascade.',
  },
  'source-coverage': {
    file: './cobolt-source-coverage.js',
    desc: 'Deterministic source document traceability (check, status, report)',
  },
  'planning-count-parity': {
    file: './cobolt-planning-count-parity.js',
    desc: 'v0.29 Tier 1: census check across 7 planning artifacts (epics.md, milestones.md, story-tracker, story-specs-index, sprint-status, stories/, rtm.json). Closes Meru Blocker #4.',
  },
  'fr-split-integrity': {
    file: './cobolt-fr-split-integrity.js',
    desc: 'v0.29 Tier 1: FRs mapped to multiple epics without split_rationale, dangling RTM story refs, landing-on-runtime-FR false attribution. Closes Meru Blocker #5.',
  },
  'referenced-artifacts': {
    file: './cobolt-referenced-artifacts.js',
    desc: 'v0.29 Tier 1: scans planning markdown for .json/.md/.yaml file references and blocks when any referenced artifact is missing on disk. Closes Meru Blocker #9 (authz-matrix.json / compliance-architecture.md).',
  },
  'data-model-completeness': {
    file: './cobolt-data-model-completeness.js',
    desc: 'v0.29 Tier 1: specified-tables + tenant-scoped RLS + RLS-with-policy + PRD-entity completeness. Closes Meru Blocker #7.',
  },
  'adr-resolution': {
    file: './cobolt-adr-resolution.js',
    desc: 'v0.29 Tier 1: non-final ADRs referenced as authoritative + cross-artifact stack drift. Closes Meru Blocker #8.',
  },
  'rtm-mapped-integrity': {
    file: './cobolt-rtm-mapped-integrity.js',
    desc: 'v0.29 Tier 1: canonical RTM story/epic mapping coverage >=85%, legacy mapped_to_* alias drift detection, integrity digest match, traceability-matrix.md coverage sanity. Closes Meru Blocker #2.',
  },
  'openapi-presence': {
    file: './cobolt-openapi-presence.js',
    desc: 'v0.29 Tier 1: blocks api-contracts.md claiming OpenAPI coverage without actual openapi/*.yaml spec files + missing PRD-required endpoints. Closes Meru Blocker #6.',
  },
  // v0.31 — meta-gates: tools that audit the auditors
  'gate-lint': {
    file: './cobolt-gate-lint.js',
    desc: 'v0.31 Tier 1: lints source/hooks and tools for vacuous-pass patterns (tautology-fallback-true, catch-approve-silent, vacuous-max-score-on-empty). The gates now audit themselves.',
  },
  'gate-wiring': {
    file: './cobolt-gate-wiring.js',
    desc: 'v0.31 Tier 1: validates every hook is registered in PRE_HOOKS/POST_HOOKS, classified in gate-tiers.json, and (if Tier 1) in the dispatcher TIER1_HOOKS set. Flags dead hooks + orphan tools.',
  },
  'gate-firerate': {
    file: './cobolt-gate-firerate.js',
    desc: 'v0.31: audit-log telemetry per hook. Classifies ACTIVE / FIRING_OK / DORMANT / DEAD with pruning + consolidation recommendations. Breaks the monotonic-gate-growth pattern.',
  },
  'gate-effectiveness': {
    file: './cobolt-gate-effectiveness.js',
    desc: 'GT-03 (v0.58+): per-gate effectiveness telemetry. Correlates gate-skip-log fires with GT-01 bypass-ledger grants to compute fpRate, firesPer100Runs, medianTimeToResolve. Subcommands: report (writes _cobolt-output/audit/gate-effectiveness.json), review --quarter Q[1-4]-YYYY (writes gate-health-review-*.md), propose-demotions (appends Tier 1 fpRate>0.30 candidates to gate-demotion-proposals.jsonl). Sibling to gate-firerate — that tool answers "is this gate dormant"; this one answers "is this gate accurate when it fires".',
  },
  'fleet-observe': {
    file: './cobolt-fleet-observe.js',
    desc: 'OB-03 opt-in fleet observability payloads and reference dashboard (observe, serve)',
  },
  'readiness-render': {
    file: './cobolt-readiness-render.js',
    desc: 'v0.31: renders readiness-report.md as a pure projection of readiness-deterministic.json with DO-NOT-EDIT banner + content hash. Removes the last prose-escape-hatch from the readiness layer.',
  },
  'feature-coverage': {
    file: './cobolt-feature-coverage.js',
    desc: 'Deterministic feature dossier and per-feature readiness gate',
  },
  'fr-epic-coverage': {
    file: './cobolt-fr-epic-coverage.js',
    desc: 'v0.53+ (F4): census check that every FR in rtm.json appears in epics.md (or stories/*.md). Closes the deeper half of C3 (RawDrive042026 73/177 FR coverage). Exit 0/1/3 contract.',
  },
  'review-fr-coverage': {
    file: './cobolt-review-fr-coverage.js',
    desc: 'v0.62+ (Phase 3 review-pipeline alignment): census check that every FR in rtm.json is cited by at least one finding in review-findings.json (via requirementRefs[] or evidence/description substring). Mirrors fr-epic-coverage for the review surface. Emits review-fr-coverage.json. Exit 0/1/3 contract.',
  },
  'plan-metrics': {
    file: './cobolt-plan-metrics.js',
    desc: 'v0.54+ (Ship 1): read-only planning-health dashboard — critical-debt ratio, coverage score, escalation count per 3-strike rung, phantom rate, plan-fix convergence, phase progression. Aggregates existing audit JSONLs. Exit 0/1/3 contract.',
  },
  'trd-epic-coverage': {
    file: './cobolt-trd-epic-coverage.js',
    desc: 'v0.54+ (Ship 3): Tier 1 census mirroring fr-epic-coverage — every TR-NNN in rtm.json must appear in epics.md or stories/*.md. Bypass COBOLT_TRD_EPIC_COVERAGE_GATE=off. Exit 0/1/3 contract.',
  },
  'dependency-risk': {
    file: './cobolt-dependency-risk.js',
    desc: 'v0.54+ (Ship 4): Tier 3 advisory analyzer — reads cobolt-architecture-graph.js manifest and computes per-milestone blast-radius score, critical-path edges, circular deps. NEW Phase 3.5. Bypass COBOLT_PHASE_3_5=off. Exit 0/1/3 contract.',
  },
  'feature-registry-repair': {
    file: './cobolt-feature-registry-repair.js',
    desc: 'Deterministic repair of feature-registry.json missing required fields (sourceIds, evidenceLevel)',
  },
  'planning-counts': {
    file: './cobolt-planning-counts.js',
    desc: 'Canonical disk-derived counts for epics / stories / milestones / features / requirements — detects milestones.md Summary drift (v0.26)',
  },
  'dossier-depth': {
    file: './cobolt-dossier-depth.js',
    desc: 'Feature dossier depth verifier — rejects hollow FEAT-NNN.md (min 15 sections, 2500 bytes, 1 BDD scenario) (v0.26)',
  },
  'trace-tag-coverage': {
    file: './cobolt-trace-tag-coverage.js',
    desc: 'Cross-doc FR-*/NFR-*/TR-*/IR-*/FEAT-* trace-tag coverage + ID range-shorthand detector (v0.26)',
  },
  'story-census': {
    file: './cobolt-story-census.js',
    desc: 'Story-tracker ↔ disk census — catches null storyFile, orphaned paths, milestone: unknown/drift (v0.26)',
  },
  'story-density-correction': {
    file: './cobolt-story-density-correction.js',
    desc: 'Warning-zone density detector + redispatch planner — emits density-state.json (observability) and density-redispatch.json (correctionPrompt for cobolt-create-epics-and-stories) when milestones/epics are in the warning band (>2, ≤3 FR/story). Plan step 21c consumer.',
  },
  'readiness-aggregate': {
    file: './cobolt-readiness-aggregate.js',
    desc: 'Tier 1 readiness aggregator — downgrades readiness-report.json verdict when any underlying planning gate fails (v0.26)',
  },
  'deploy-aggregate': {
    file: './cobolt-deploy-aggregate.js',
    desc: 'Tier 1 deploy-stage aggregator — cross-checks milestone-validate + audit + uat + pentest + reliability-guard + infra-manifest verdicts (v0.27)',
  },
  'version-census': {
    file: './cobolt-version-census.js',
    desc: 'Version drift detector across all 8+ version-carrying files (package.json, cobolt-state.json, marketplace.json, etc.) (v0.27)',
  },
  'ac-executability': {
    file: './cobolt-ac-executability.js',
    desc: 'Acceptance-criteria executability census — rejects non-testable AC (no Given/When/Then, no MUST/SHALL, stub markers) on mapped/coded/tested/covered requirements (v0.28)',
  },
  'ux-completeness': {
    file: './cobolt-ux-completeness.js',
    desc: 'ux-design-specification.md structural validator — requires 13 sections incl. State Matrix, Data Binding Map, Error Content Spec, Interaction Timing, Responsive Collapse (v0.28)',
  },
  'source-semantic-coverage': {
    file: './cobolt-source-semantic-coverage.js',
    desc: 'Detects citation-only SRC-* coverage via non-stopword term overlap between source intent and downstream artifacts (v0.28)',
  },
  'planning-bootstrap': {
    file: './cobolt-planning-bootstrap.js',
    desc: 'Deterministic bootstrap of source-document-consolidation.md + PRD frontmatter + sidecar files',
  },
  'self-critique': {
    file: './cobolt-self-critique.js',
    desc: 'Verify self-critique protocol output — schema check + disk stub scan for planning sub-skills',
  },
  'plan-redispatch': {
    file: './cobolt-plan-redispatch.js',
    desc: 'Build targeted redispatch payload from phase corrections + self-critique failures; enforces retry budget',
  },
  'human-halt': {
    file: './cobolt-human-halt.js',
    desc: 'Emit HUMAN-REVIEW-REQUIRED.md when interactive recovery exhausts; marks state.planning.status=HUMAN_REVIEW (interactive mode only)',
  },
  'planning-debt': {
    file: './cobolt-planning-debt.js',
    desc: 'Record DEGRADED planning artifacts in auto mode (skip-with-debt flow); convert halt files; list unresolved debt',
  },
  'build-debt': {
    file: './cobolt-build-debt.js',
    desc: 'Record DEGRADED build-stage layer outcomes in auto mode (skip-with-debt at Step 07/08); convert halt+escalation evidence to layer-granular debt entries; list unresolved debt',
  },
  'capability-graph': {
    file: './cobolt-capability-graph.js',
    desc: 'Product capability graph — feature-to-surface impact matrix and build proof gate',
  },
  'capability-contract': {
    file: './cobolt-capability-contract.js',
    desc: 'Per-feature capability behavioral contract gate — operations, invariants, error taxonomy, idempotency, budgets, observability (v0.34)',
  },
  'capability-traceability': {
    file: './cobolt-capability-traceability.js',
    desc: 'Capability-spec census gate — every docs/capabilities/*.md traces to ≥1 contract/epic/story (v0.48, null-capabilities pass)',
  },

  // Environment configuration
  env: {
    file: './cobolt-env.js',
    desc: 'User infrastructure config (.env.cobolt) — init, validate, status, merge',
  },

  // Cost tracking
  cost: {
    file: './cobolt-cost.js',
    desc: 'Multi-agent cost tracking, token counting, cache analysis, and GT-02 cost-budget check/extend governance',
  },
  // Agent and workflow evals (M1 foundation)
  evals: {
    file: './cobolt-evals.js',
    desc: 'Agent and workflow eval runner, scorer, regression checker, and trend reporter',
  },
  // Outer-loop harness optimization (Meta-Harness + GEPA + AlphaEvolve + Reflexion). Phase 1: corpus + scorecard + Pareto.
  evolve: {
    file: './cobolt-evolve.js',
    desc: 'Outer-loop harness optimization: replay corpus, multi-objective scorecard, Pareto front (offline)',
  },
  'evolve-mine': {
    file: './cobolt-evolve-mine.js',
    desc: 'Seed harness-lab Reflexion ledger from _cobolt-output/archive/ dream files',
  },
  'evolve-canary': {
    file: './cobolt-evolve-canary.js',
    desc: 'Post-promotion canary check for cobolt-evolve; auto-revert on tier-1 or tolerance breach',
  },
  // Pre-build validation
  'prebuild-validate': {
    file: './cobolt-prebuild-validate.js',
    desc: 'Pre-build validation (requirement coverage, schema completeness, ambiguity, write-scope, orphan reconciliation)',
  },
  'validate-milestone': {
    file: './cobolt-validate-milestone.js',
    desc: 'Deterministic milestone validation (compile/tests, stubs, FR coverage, RTM, route health, reviewer completeness)',
  },
  'schema-check': {
    file: './cobolt-schema-check.js',
    desc: 'Validate an artifact JSON file against a schema in source/schemas/ (skill-safe wrapper around lib/schema-validator)',
  },
  'contract-synthesize': {
    file: './cobolt-contract-synthesize.js',
    desc: 'Brownfield v0.41 bridge — emits low-confidence synthesis-shim contracts so brownfield projects can pass v0.41 plan-close. Re-run /cobolt-plan afterwards for high-confidence agent-authored contracts.',
  },
  'team-validate': {
    file: './cobolt-team-validate.js',
    desc: 'Validate agent-team subsystem — every skill calling team-active has a team doc; every team doc names a lead and teammates that exist on disk; every team doc references the canonical teardown protocol',
  },

  // Deterministic UX quality tools (replace LLM-driven agents for pattern checks)
  'design-token-lint': {
    file: './cobolt-design-token-linter.js',
    desc: 'Deterministic design token compliance — colors, fonts, components, animations (reads userPreferences)',
  },
  'a11y-lint': {
    file: './cobolt-a11y-linter.js',
    desc: 'WCAG 2.1 AA accessibility checks — aria-labels, headings, semantic HTML, focus, reduced motion',
  },
  'perf-lint': {
    file: './cobolt-perf-linter.js',
    desc: 'Performance budget enforcement — bundle sizes, CWV, image optimization, font loading',
  },
  'component-validate': {
    file: './cobolt-component-validator.js',
    desc: 'Component registry validation — schema, file existence, theme consistency, userPreferences',
  },
  'ux-lint': {
    file: './cobolt-ux-linter.js',
    desc: 'UX pattern detection — loading states, error handling, empty states, form validation',
  },
  'design-checklist': {
    file: './cobolt-design-checklist.js',
    desc: 'Pre-coding design readiness gate — handoff sections, state matrix, preference alignment',
  },

  // Deterministic planning tools (replace LLM-driven skills)
  'tracker-init': {
    file: './cobolt-tracker-init.js',
    desc: 'Deterministic milestone/story/issue tracker JSON generation (replaces cobolt-create-milestone-trackers)',
  },
  'sprint-plan': {
    file: './cobolt-sprint-plan.js',
    desc: 'Deterministic sprint-status.yaml generation (replaces cobolt-sprint-planning)',
  },
  'epic-milestone-parity': {
    file: './cobolt-epic-milestone-parity.js',
    desc: 'Tier 1 parity gate — verifies epics.md (Mn) tags and milestones.md FR clusters agree; catches unassigned stories',
  },
  'plan-refresh': {
    file: './cobolt-plan-refresh.js',
    desc: 'v0.40.9 / v0.48: idempotent plan-close refresh of 6 deterministic renderers (story-tracker, traceability-matrix, readiness-deterministic, readiness-report, sprint-status, master-plan). Closes the Test3 stale-artifact ordering bug and RAID101 class-A drift.',
  },
  'master-plan-reconcile': {
    file: './cobolt-master-plan-reconcile.js',
    desc: 'v0.48: deterministic rewriter for master-plan.md scope-snapshot bullets and "Ready for build" verdict. Invoked by plan-refresh RENDERERS so counts pulled from rtm.json + epics.md + story-tracker.json stay in agreement with canonical sources at plan-close. Closes RAID101 class-A (2026-04-23).',
  },
  'authz-matrix': {
    file: './cobolt-authz-matrix.js',
    desc: 'v0.40.9: deterministic producer of authz-matrix.json from PRD + api-contracts + security-requirements when multi-tenancy/RBAC declared. Closes the missing-producer gate gap.',
  },
  'assumptions-log': {
    file: './cobolt-assumptions-log.js',
    desc: 'v0.40.9: ensures assumptions-log.md exists with extracted PRD assumptions + autonomous-decision entries. Closes the missing producer that planning-provenance-gate expected.',
  },
  'plan-content-depth-gate': {
    file: './cobolt-plan-content-depth-gate.js',
    desc: 'v0.40.9 Tier 2: content-depth gate — verifies system-architecture C4 diagrams, enriched-requirements FR coverage, api-contracts error taxonomy, test-strategy category coverage.',
  },
  'artifact-parity': {
    file: './cobolt-artifact-parity.js',
    desc: 'Tier 1 cross-artifact parity gates: prd↔rtm, ir↔parent-fr, feature-registry, security↔coding-standard, release↔infra, production-evidence triple',
  },
  'fr-surface-census': {
    file: './cobolt-fr-surface-census.js',
    desc: 'v0.39.0 Tier 1: FR-declared HTTP endpoints (verb+path from prd.md) must have a matching route registration in source (Phoenix/Plug, Express, Rails, FastAPI/Flask, Go chi/gin, Axum/Rocket, Spring). Closes Meru M1 HTTP-surface incident.',
  },
  'app-boot-check': {
    file: './cobolt-app-boot-check.js',
    desc: 'v0.39.0: language-appropriate boot smoke (mix compile / cargo check / go build / tsc --noEmit / mvn compile / python compileall) + crash-dump scan. Writes {M}-app-boot-proof.json consumed by cobolt-app-boot-gate.js.',
  },
  'crypto-posture': {
    file: './cobolt-crypto-posture.js',
    desc: 'Deterministic crypto review — weak hashes/ciphers, TLS config, key lengths, insecure PRNGs, hard-coded secrets, JWT alg-none, cookie hardening (CWE-tagged)',
  },
  'cis-benchmarks': {
    file: './cobolt-cis-benchmarks.js',
    desc: 'CIS Docker 1.6 + Kubernetes 1.8 static manifest checks — non-root user, privileged, hostPath, capabilities, resource limits, secrets-in-Dockerfile',
  },
  'attack-path': {
    file: './cobolt-attack-path.js',
    desc: 'Attack-path graph — combines access-audit + api-catalog + data-flows + supply-chain into entry→auth→vuln→exfil paths ranked by risk',
  },
  'agent-dispatch-ledger': {
    file: './cobolt-agent-dispatch-ledger.js',
    desc: 'Append-only census ledger for every agent dispatch — required by escalation-protocol for failure reconstruction and dispatch census verification',
  },
  'lifecycle-ledger': {
    file: './cobolt-lifecycle-ledger.js',
    desc: 'v0.59 Stage-2B verifier for the HMAC-signed lifecycle ledger. Subcommands: verify (chain + HMAC integrity), report (--json totals + agents), rotate-key --confirm (archive ledger + generate new key). Mirrors cobolt-bypass.js audit pattern.',
  },
  'pentest-findings': {
    file: './cobolt-pentest-findings.js',
    desc: 'Pentest markdown report → structured pentest-findings.json (CWE-tagged, CVSS-parsed) — feeds cobolt-fix so pentest findings no longer silently ship',
  },
  'gap-inventory': {
    file: './cobolt-gap-inventory.js',
    desc: 'Consolidate phase-gap-reports + carry-forward + gap-registry into machine-readable gap-inventory.json with schema validation',
  },
  'story-gen': {
    file: './cobolt-story-gen.js',
    desc: 'Deterministic story file discovery — lists missing stories across all milestones for dispatch',
  },
  'validate-prd': {
    file: './cobolt-validate-prd.js',
    desc: 'Deterministic 7-dimension PRD validation (format, density, traceability, leakage, domain, type, completeness)',
  },
  'readiness-check': {
    file: './cobolt-readiness-check.js',
    desc: 'Deterministic 4-dimension readiness scoring (RTM coverage, document presence, story coverage, frontend completeness)',
  },
  'release-checklist': {
    file: './cobolt-release-checklist.js',
    desc: 'Deterministic release readiness checklist from gate config and artifact dependencies',
  },

  // v0.40.5 — pipeline hardening tools (Issues 1, 2, 4, 6)
  'carryforward-ack': {
    file: './cobolt-carryforward-ack.js',
    desc: 'v0.40.5 (Issue 6): record read-receipt for {M}-deferred-work.json so consumer stages (deploy/release/dream/milestone-validate) prove they read carry-forward before advancing',
  },
  'healthcheck-wait': {
    file: './cobolt-healthcheck-wait.js',
    desc: 'v0.40.5 (Issue 4): poll postgres/redis/http/tcp readiness before provisioner agents return "provisioned" — closes the connection-refused deploy-step race',
  },
  'regression-check': {
    file: './cobolt-regression-check.js',
    desc: 'v0.40.5 (Issue 1): cross-milestone regression replay — baseline prior-milestone acceptance criteria, verify current HEAD still satisfies them before closing Mn',
  },
  'tracker-lock': {
    file: './cobolt-tracker-lock.js',
    desc: 'v0.40.5 (Issue 2): exclusive lock CLI for finding-tracker.json mutations — prevents parallel fix agents from last-writer-wins corruption',
  },

  // Deterministic brownfield pipeline tools
  'bf-classify': {
    file: './cobolt-brownfield-classify.js',
    desc: 'Deterministic project classification (brownfield/inflight/legacy/greenfield)',
  },
  'bf-health-score': {
    file: './cobolt-brownfield-health-score.js',
    desc: 'Deterministic weighted health score, grade, and modernization verdict',
  },
  'bf-file-manifest': {
    file: './cobolt-brownfield-file-manifest.js',
    desc: 'Build deterministic source file manifest for brownfield grounding and agent dispatch',
  },
  'bf-evidence-index': {
    file: './cobolt-brownfield-evidence-index.js',
    desc: 'Build evidence-index.json linking artifacts to source tools/agents',
  },
  'bf-gap-review': {
    file: './cobolt-brownfield-gap-review.js',
    desc: 'Deterministic per-phase gap review for brownfield artifacts and cross-references',
  },
  'bf-accuracy-review': {
    file: './cobolt-brownfield-accuracy-review.js',
    desc: 'Deterministic P3 accuracy review for brownfield synthesis artifacts',
  },
  'bf-handoff': {
    file: './cobolt-brownfield-handoff.js',
    desc: 'Build modernization-handoff.json for Phase 4 activation',
  },
  'bf-plan-sync': {
    file: './cobolt-brownfield-planning-sync.js',
    desc: 'Materialize canonical planning artifacts from the brownfield modernization packet',
  },
  'bf-readiness-gate': {
    file: './cobolt-brownfield-readiness-gate.js',
    desc: 'Deterministic P3→P4 readiness gate (10 checks, hard gate)',
  },

  'bf-tool-health': {
    file: './cobolt-brownfield-tool-health.js',
    desc: 'Assess deterministic brownfield tool reliability and noisy verdict risk',
  },
  'bf-tool-rollup': {
    file: './cobolt-brownfield-tool-rollup.js',
    desc: 'Promote deterministic P1 tool sidecars (route-wiring, query-migration, semantic-stub, UI-placeholder) into 16-issues-registry.json with typed prefixes',
  },
  'bf-forensic-merge': {
    file: './cobolt-brownfield-forensic-merge.js',
    desc: 'Deterministic 16a-forensic-findings.json → 16-issues-registry.json merge with census check + priority-matrix assignment + idempotent replay (v0.40.6 — replaces prose-only merge)',
  },
  'bf-planning-sync-validate': {
    file: './cobolt-brownfield-planning-sync-validate.js',
    desc: 'Pre-sync COPY_MAP path validator — verifies every brownfield source path declared in planning-sync exists before sync runs (v0.40.6 — closes issue 13)',
  },
  'bf-roadmap-validate': {
    file: './cobolt-brownfield-roadmap-validate.js',
    desc: 'Cross-check component IDs referenced in 18-modernization-roadmap.md against 04-feature-and-module-inventory.md — detects orphan components (v0.40.6 — closes issue 15)',
  },
  'bf-handoff-contract': {
    file: './cobolt-brownfield-handoff-contract.js',
    desc: 'Generate and validate brownfield-to-build-handoff-contract.md — lists exact canonical artifacts build expects with min-byte thresholds (v0.40.6 — closes issue 16)',
  },
  'bf-semantic-drift': {
    file: './cobolt-brownfield-semantic-drift.js',
    desc: 'Aggregate brownfield discovery drift, contract blockers, semantic stub debt, and escalation context into brownfield-semantic-drift.json',
  },
  'bf-contracts': {
    file: './cobolt-brownfield-contracts.js',
    desc: 'Emit and validate brownfield assessment/readiness JSON contracts for SDLC, parity, migration, risk, supply-chain, operations, and build authorization gates',
  },
  'bf-depth-census': {
    file: './cobolt-brownfield-depth-census.js',
    desc: 'Post-dispatch census verifying --scan minimal|deep|full produced the expected artifact count for the requested depth (v0.40.6 — closes issue 17)',
  },
  'build-tool-rollup': {
    file: './cobolt-build-tool-rollup.js',
    desc: 'Promote deterministic build-stage sidecars (wiring-check, api-contract-check, worker-lifecycle, illusion-report) into M{n}-issues-registry.json with WIRE/APIWIRE/LIFECYCLE/ILL prefixes',
  },
  'review-tool-rollup': {
    file: './cobolt-review-tool-rollup.js',
    desc: 'Consolidate review-findings.json with build-stage registry + phantom-rejection + priority-matrix lookup (v0.20.8)',
  },
  'bf-exec-report': {
    file: './cobolt-brownfield-exec-report.js',
    desc: 'Data-driven brownfield executive report (HTML + PDF + manifest) for end-of-pipeline delivery',
  },
  'bf-forensic-audit-report': {
    file: './cobolt-brownfield-forensic-audit-report.js',
    desc: 'Deterministic producer for 16d-forensic-audit-report.md (synthesizes from 16a/16b/16c/16e) — closes the P2.5→P3 gate orphan-producer gap (v0.40.12)',
  },
  'bf-event-schemas': {
    file: './cobolt-brownfield-event-schemas.js',
    desc: 'Deterministic producer for 30a-modernization-event-schemas.md — synthesizes event catalog when upstream signals event-driven integrations, otherwise emits an explicit N/A stub. Closes the planning-sync orphan-producer gap.',
  },
  'project-class': {
    file: './cobolt-project-class.js',
    desc: 'Classify the project as desktop/saas/service/library/cli/mobile/unknown and emit project-class.json. Read by standards-gate to skip checks that are noise for the detected class.',
  },

  'runtime-truth': {
    file: './cobolt-runtime-truth.js',
    desc: 'Deterministic compile/build/test execution proof for brownfield runtime gating',
  },
  'runtime-contract': {
    file: './cobolt-runtime-contract.js',
    desc: 'Deterministic runtime version contract check between planning docs and manifests',
  },
  'route-wiring-check': {
    file: './cobolt-route-wiring-check.js',
    desc: 'Deterministic domain liveness verifier for imports, routes, and startup wiring',
  },
  'query-migration-contract': {
    file: './cobolt-query-migration-contract.js',
    desc: 'Deterministic query-to-migration contract validation for referenced tables',
  },
  'semantic-stub-check': {
    file: './cobolt-semantic-stub-check.js',
    desc: 'Deterministic semantic stub and no-op marker detection',
  },
  'ui-placeholder-check': {
    file: './cobolt-ui-placeholder-check.js',
    desc: 'Deterministic frontend placeholder and mock-data UI detection',
  },

  'wireframe-diff': {
    file: './cobolt-wireframe-diff.js',
    desc: 'Wireframe-to-UI diff — compares component-registry.json against built code',
  },
  'test-assertion-quality': {
    file: './cobolt-test-assertion-quality.js',
    desc: 'Test assertion quality checker — detects vacuous, empty, and comment-only tests',
  },

  // Deterministic review/fix pipeline tools
  'review-file-manifest': {
    file: './cobolt-review-file-manifest.js',
    desc: 'Build deterministic source file manifest and grounding packet for review dispatch',
  },
  'review-packet': {
    file: './cobolt-review-packet.js',
    desc: 'Build milestone/codebase review packet, categorized scope inventory, and review-manifest bootstrap',
  },
  'review-coverage': {
    file: './cobolt-review-coverage.js',
    desc: 'Check review coverage gaps across scoped files and required reviewer prefixes',
  },
  'review-evidence-index': {
    file: './cobolt-review-evidence-index.js',
    desc: 'Build review-evidence-index.json linking review artifacts to source tools and agents',
  },
  'review-accuracy': {
    file: './cobolt-review-accuracy.js',
    desc: 'Deterministic accuracy review for review-stage artifacts, cross-references, and verification integrity',
  },
  'review-readiness-gate': {
    file: './cobolt-review-readiness-gate.js',
    desc: 'Deterministic review integrity gate before chaining to pentest, fix, or validation',
  },
  'review-handoff-fidelity': {
    file: './cobolt-review-handoff-fidelity.js',
    desc: 'Aggregate build→review continuity, reviewer coverage, line-anchor drift, and escalation context into review-handoff-fidelity.json',
  },
  'review-handoff': {
    file: './cobolt-review-handoff.js',
    desc: 'Build review-handoff.json and review-decision-log.md for downstream chaining',
  },
  'analysis-scope': {
    file: './cobolt-analysis-scope.js',
    desc: 'Deterministic feature-scope discovery for cobolt-analyse (scope + evidence + confidence)',
  },
  'analysis-packet': {
    file: './cobolt-analysis-packet.js',
    desc: 'Build feature analysis packet, feature-map.json, and analysis-manifest.json from analysis-scope.json',
  },
  'analysis-handoff': {
    file: './cobolt-analysis-handoff.js',
    desc: 'Build analysis-handoff.json, analysis report, and consolidated pipeline report for cobolt-analyse',
  },
  'fix-router': {
    file: './cobolt-fix-router.js',
    desc: 'Deterministic finding-to-agent routing (prefix + extension + escalation tier)',
  },
  'fix-args': {
    file: './cobolt-fix-args.js',
    desc: 'Canonical argument normalizer for cobolt-fix entry (milestone, autonomous, build-pipeline, resume, from-step, analysis, error text) with audit trail output.',
  },
  'finding-dedup': {
    file: './cobolt-finding-dedup.js',
    desc: 'First-pass finding deduplication (exact-match, near-match, cross-prefix linking)',
  },
  'finding-verify': {
    file: './cobolt-finding-verifier.js',
    desc: 'Verify review findings against real file evidence and compute phantom rates',
  },
  'fix-verdict': {
    file: './cobolt-fix-verdict.js',
    desc: 'Deterministic verification loop decision (exit/loop/escalate + stall detection)',
  },
  'fix-loop-plateau': {
    file: './cobolt-fix-loop-plateau.js',
    desc: 'Signature-based plateau detection — catches same-bug-reshaped-across-files (v0.13.1)',
  },
  'fix-readiness': {
    file: './cobolt-fix-readiness.js',
    desc: 'Generate and validate mandatory fix remediation packet before dispatch',
  },
  'fix-resolution-fidelity': {
    file: './cobolt-fix-resolution-fidelity.js',
    desc: 'Aggregate fix readiness, replay obligations, line-anchor status, carry-forward semantic drift, and escalation context',
  },
  'fix-surface-gates': {
    file: './cobolt-fix-surface-gates.js',
    desc: 'Classify touched fix surfaces and require extra SDLC evidence for high-risk changes',
  },
  'fix-risk-acceptance': {
    file: './cobolt-fix-risk-acceptance.js',
    desc: 'Create and verify HMAC-signed risk-acceptance.json for unresolved critical/high fix risks',
  },
  'fix-architecture-approval': {
    file: './cobolt-fix-architecture-approval.js',
    desc: 'Summarize gated architecture mutation proposals into architecture-mutation-approval.json',
  },
  'fix-learning-packet': {
    file: './cobolt-fix-learning-packet.js',
    desc: 'Generate and validate post-fix learning packets from tracker, RCA, and memory evidence',
  },
  'hotfix-release-contract': {
    file: './cobolt-hotfix-release-contract.js',
    desc: 'Generate and validate compressed hotfix release controls before emergency ship',
  },
  'fix-task-manifest': {
    file: './cobolt-fix-task-manifest.js',
    desc: 'Build-style fix execution manifest (ownership-safe tasks, waves, and bundle lineage)',
  },
  'fix-evidence': {
    file: './cobolt-fix-evidence.js',
    desc: 'Emit fix teardown evidence expectations from fix-task-manifest.json',
  },
  'output-validator': {
    file: './cobolt-output-validator.js',
    desc: 'Explicit JSON schema validator for pipeline and agent output files',
  },
  'rca-diff': {
    file: './cobolt-rca-diff.js',
    desc: 'Before/after code extraction from git diff for RCA documents',
  },

  // Infrastructure validation
  'infra-check': {
    file: './cobolt-infra-check.js',
    desc: 'Per-milestone infrastructure validation — Docker, user-provided services, auto-provisioned health',
  },
  'infra-liveness': {
    file: './cobolt-infra-liveness.js',
    desc: 'Between-round infra liveness probe — catches mid-build Docker service crashes that infra-check (Step 00 only) misses',
  },

  // Progress and coverage tools
  progress: {
    file: './cobolt-progress.js',
    desc: 'Pipeline progress query — current status, percentage, follow mode, log tail',
  },
  status: {
    file: './cobolt-status.js',
    desc: 'Pipeline status diagnosis — classifies pipeline state and recommends next action',
  },
  tail: {
    file: './cobolt-tail.js',
    desc: 'OB-04 live audit event stream — pretty-prints _cobolt-output/audit/*.jsonl with severity and follow mode',
  },
  'debt-banner': {
    file: './cobolt-debt-banner.js',
    desc: 'One-line banner when planning debt or halt markers are present — called at pipeline entry by build/review/fix/deploy',
  },
  'recovery-stats': {
    file: './cobolt-recovery-stats.js',
    desc: 'Aggregate escalation/failure/debt/gate-skip telemetry across runs — read-only rollup with per-agent, per-pipeline, and per-verdict breakdowns',
  },
  'escalate-guard': {
    file: './cobolt-escalate-guard.js',
    desc: 'Silent one-time retry with bumped redispatch budget before writing a HUMAN-REVIEW-REQUIRED halt file — per-artifact ledger prevents loops',
  },
  estimate: {
    file: './cobolt-estimate.js',
    desc: 'Pipeline ETA and cost estimates — rolling median from attestations, baseline fallback',
  },
  'coverage-ratchet': {
    file: './cobolt-coverage-ratchet.js',
    desc: 'Coverage ratchet — capture thresholds, check regressions, compare milestones (1% tolerance)',
  },

  // Build proof, reporting, and regression tools
  'step-proof': { file: './cobolt-step-proof.js', desc: 'Build step execution proof (record, check, list, verify)' },
  'milestone-drilldown': {
    file: './cobolt-milestone-drilldown.js',
    desc: 'v0.51 Tier 1 validator — every FEAT-NNN listed in a `## M{n}:` section of milestones.md must have a matching `#### FEAT-NNN` drill-down block enumerating ≥1 FR line',
  },
  'milestone-report': {
    file: './cobolt-milestone-report.js',
    desc: 'Milestone report card generation (md + json, grading)',
  },
  'regression-baseline': {
    file: './cobolt-regression-baseline.js',
    desc: 'Cross-milestone regression baseline capture and detection',
  },
  'smoke-test': {
    file: './cobolt-smoke-test.js',
    desc: 'Schema-aware deploy smoke tests with security headers and performance assertions',
  },

  // Enhanced quality tools (zero external deps — pure Node.js analysis)
  'dead-code': {
    file: './cobolt-dead-code-detector.js',
    desc: 'Unused exports, orphaned files, unreachable code detection (import graph analysis)',
  },
  'n-plus-one': {
    file: './cobolt-n-plus-one-detector.js',
    desc: 'N+1 query detection — loop-inside-query, missing preloads, unbounded SELECTs',
  },
  'dep-health': {
    file: './cobolt-dependency-health.js',
    desc: 'Dependency health scoring — typosquat risk, staleness, license compliance',
  },
  'entropy-scan': {
    file: './cobolt-secret-entropy-scanner.js',
    desc: 'High-entropy string detection — finds hardcoded secrets missed by pattern-based tools',
  },
  'api-contract': {
    file: './cobolt-api-contract-validator.js',
    desc: 'API spec vs implementation validation — undocumented endpoints, spec drift, missing schemas',
  },
  'memory-leak': {
    file: './cobolt-memory-leak-detector.js',
    desc: 'Memory leak pattern detection — unremoved listeners, unbounded caches, missing cleanup',
  },
  'migration-safety': {
    file: './cobolt-migration-safety.js',
    desc: 'Database migration risk analysis — locking, data loss, missing rollback, ordering',
  },
  'grounding-lint': {
    file: './cobolt-grounding-lint.js',
    desc: 'Anti-hallucination gate — flags reviewer-class agents missing EVIDENCE-GATED VERIFICATION block',
  },

  // Design token management
  'sync-tokens': {
    file: './cobolt-sync-tokens.js',
    desc: 'Central design token sync — design-tokens.json → component-registry + .stitch/DESIGN.md + CSS/Tailwind export',
  },
  'token-playground': {
    file: './cobolt-token-playground.js',
    desc: 'Self-contained HTML design token preview — colors, typography, spacing, radius, shadows',
  },

  // Documentation generation
  'readme-gen': {
    file: './cobolt-readme-gen.js',
    desc: 'Deterministic README.md generator from planning artifacts (PRD, epics, architecture, design tokens)',
  },
  'frontend-completeness': {
    file: './cobolt-frontend-completeness.js',
    desc: 'Deterministic UI planning completeness gate for UX spec coverage, state completeness, and source-driven UI concepts',
  },
  'frontend-runtime-check': {
    file: './cobolt-frontend-runtime-check.js',
    desc: 'Deterministic frontend runtime wiring check for Tailwind/Phoenix and compiled styling risk',
  },
  'framework-contracts': {
    file: './cobolt-framework-contracts.js',
    desc: 'Framework-specific runtime/build contract checks for Phoenix, Next.js, Rails, and Django',
  },
  'ui-pr-evidence': {
    file: './cobolt-ui-pr-evidence.js',
    desc: 'Require visual/runtime evidence for UI-changing PRs',
  },
  'auth-contract': {
    file: './cobolt-auth-contract.js',
    desc: 'Check auth/session/redirect test obligations for auth milestones',
  },
  'milestone-cost-report': {
    file: './cobolt-milestone-cost-report.js',
    desc: 'Generate milestone token/cost report with waste recommendations',
  },
  'auto-state': {
    file: './cobolt-auto-state.js',
    desc: 'Autonomous build-loop state machine and transition ledger',
  },
  doctor: {
    file: './cobolt-doctor.js',
    desc: 'CoBolt source, tool registry, schema, hook, and runtime readiness doctor',
  },

  // Runtime verification (v0.8.6)
  'entrypoint-wiring-check': {
    file: './cobolt-entrypoint-wiring-check.js',
    desc: 'Entry point wiring verifier — call-graph route registration check (verifies functions are CALLED not just defined)',
  },
  'worker-lifecycle-check': {
    file: './cobolt-worker-lifecycle-check.js',
    desc: 'Background worker lifecycle check — detects workers defined but never started in application lifecycle',
  },
  'channel-wiring-check': {
    file: './cobolt-channel-wiring-check.js',
    desc: 'Realtime channel wiring verifier — pairs Socket.IO/ws emits with handlers; advisory SSE detection. Tier 1 when realtime deps present',
  },
  'queue-topology-check': {
    file: './cobolt-queue-topology-check.js',
    desc: 'Message queue topology verifier — pairs producers with consumers across NATS/Kafka/AMQP/Redis/BullMQ/SQS. Tier 1 when cobolt-queue-manifest.json present, Tier 2 advisory otherwise',
  },
  'orm-parity-check': {
    file: './cobolt-orm-parity-check.js',
    desc: 'ORM code↔schema parity verifier — Prisma + Drizzle (v1 scope). Tier 2 advisory; SQLAlchemy/ActiveRecord/Ecto/TypeORM/Sequelize reported as deterministicBoundary (out of scope)',
  },

  // Lifecycle / removal (v0.10.2)
  reset: {
    file: './cobolt-reset.js',
    desc: 'PROJECT-ONLY CoBolt artifact removal — five lifecycle modes (--list/--complete/--abandon/--fresh/--full). Rejects --global at parse time; use cobolt-uninstall for system-wide removal',
  },
  uninstall: {
    file: './cobolt-uninstall.js',
    desc: 'SYSTEM-WIDE CoBolt removal — composes cobolt-reset (project layer) with executeGlobalUninstall (system layer). Removes ~/.claude/hooks/cobolt-*.js, ~/.claude/cobolt/, settings.json strip, npm uninstall -g',
  },

  // ── 90% plan (rigorous mode) — docs/PLAN-90-PERCENT-PRODUCTION-APPS.md ──────
  'human-review-packet': {
    file: './cobolt-human-review-packet.js',
    desc: 'S1 — Build milestone-boundary human review packet (rigorous mode)',
  },
  'property-test-gen': {
    file: './cobolt-property-test-gen.js',
    desc: 'S2 — Generate property-based tests from IR invariants',
  },
  'cdc-gen': {
    file: './cobolt-cdc-gen.js',
    desc: 'S2 — Emit consumer-driven contract pacts from actual cross-milestone calls',
  },
  'load-chaos': {
    file: './cobolt-load-chaos.js',
    desc: 'S3 — Real load + chaos runner with prior-milestone-live regression',
  },
  'contract-codegen': {
    file: './cobolt-contract-codegen.js',
    desc: 'S4 — Typed client/server codegen from interface-contracts.json',
  },
  'invariant-check': {
    file: './cobolt-invariant-check.js',
    desc: 'S5 — Executable ADR invariant checker (AST + runtime)',
  },
  'threat-test-gen': { file: './cobolt-threat-test-gen.js', desc: 'S6 — STRIDE threat model → negative test stubs' },
  'a11y-keyboard': { file: './cobolt-a11y-keyboard.js', desc: 'S7 — Keyboard navigation Playwright harness' },
  'contrast-matrix': { file: './cobolt-contrast-matrix.js', desc: 'S7 — WCAG contrast matrix across themes × states' },
  'prd-execute': {
    file: './cobolt-prd-execute.js',
    desc: 'S8 — PRD consistency executor; synthetic sessions + contradiction detect',
  },
  'prd-semantic-review': {
    file: './cobolt-prd-semantic-review.js',
    desc: 'S8 — Semantic PRD contradiction pass via LLM (Anthropic/OpenAI); companion --llm-hook for cobolt-prd-execute',
  },
  'fr-ambiguity': { file: './cobolt-fr-ambiguity.js', desc: 'S8 — Multi-model disagreement probe for FR ambiguity' },
  'verify-independent-run': {
    file: './cobolt-verify-independent-run.js',
    desc: 'S2 — Independent verification controller: runs independent tests + merges mutation score into verdict',
  },
  'mutation-run': {
    file: './cobolt-mutation-run.js',
    desc: 'S2 — Mutation testing runner (stryker/mutmut/pitest/mull) writing normalized reports',
  },
  'perf-mandatory': {
    file: './cobolt-perf-mandatory.js',
    desc: 'v0.12.1 — Verify perf verdict exists, fresh (<=72h), matches HEAD, and PASSes (activates cobolt-perf-mandatory-gate)',
  },
  'authz-census': {
    file: './cobolt-authz-census.js',
    desc: 'v0.12.1 — Runtime census for every (endpoint x role x tenant) pair; coverage==1.0 required (activates cobolt-authz-census-gate)',
  },
  'contract-replay': {
    file: './cobolt-contract-replay.js',
    desc: 'v0.12.1 — Consumer-driven contract runtime replay; every (contract x consumer) must execute+pass (activates cobolt-contract-replay-gate)',
  },
  'schema-replay': {
    file: './cobolt-schema-replay.js',
    desc: 'v0.13.0 — Cumulative migration replay M1..Mn on disposable DB + forward/rollback/forward cycle test; diffs vs pinned schema-state/{M}.schema.sql (activates cobolt-migration-replay-gate)',
  },
  'shared-kernel-invariant': {
    file: './cobolt-shared-kernel-invariant.js',
    desc: 'v0.12.1 — Detect invariant contradictions when M(n>1) extends shared kernel (activates cobolt-shared-kernel-invariant-gate)',
  },
  'cross-milestone-integration': {
    file: './cobolt-cross-milestone-integration.js',
    desc: 'v0.12.1 — Growing cross-milestone integration suite verifier; cumulative coverage of M1..M_{n-1} required (activates cobolt-cross-milestone-integration-gate)',
  },
  determinism: {
    file: './cobolt-determinism.js',
    desc: 'v0.12.1 — Determinism harness: snapshot planning output and diff two runs of the same PRD (activates cobolt-determinism-gate when COBOLT_DETERMINISM_HARNESS=1)',
  },

  // Standards compliance. Evidence tools are advisory; standards-gate is blocking for planning/build surfaces.
  'iso-25010': {
    file: './cobolt-iso25010.js',
    desc: 'ISO/IEC 25010:2023 product quality scorecard (8 characteristics, A–F grade)',
  },
  'iso-5055': {
    file: './cobolt-iso5055.js',
    desc: 'ISO/IEC 5055:2021 / CISQ automated source-code measures (CWE-mapped)',
  },
  'ai-rmf': { file: './cobolt-ai-governance.js', desc: 'ISO/IEC 42001:2023 + NIST AI RMF 1.0 AI governance readiness' },
  dora: {
    file: './cobolt-dora.js',
    desc: 'DORA Four Key Metrics from git history (deploy freq, lead time, CFR, MTTR)',
  },
  'iso-29148': {
    file: './cobolt-req-quality.js',
    desc: 'ISO/IEC/IEEE 29148:2018 requirements quality audit (9-criterion rubric)',
  },
  standards: { file: './cobolt-standards.js', desc: 'Run all standards checks and emit consolidated summary' },

  // Architecture diagrams (v0.21.0 — opt-in via --arch on plan/brownfield)
  'architecture-graph': {
    file: './cobolt-architecture-graph.js',
    desc: 'Build/merge/validate the architecture evidence graph from planning/brownfield artifacts',
  },
  'architecture-diagrams': {
    file: './cobolt-architecture-diagrams.js',
    desc: 'Generate diagram viewpoint specs + Mermaid files + index/manifest from an evidence graph',
  },
  'architecture-diagram-validate': {
    file: './cobolt-architecture-diagram-validate.js',
    desc: 'Validate graph/spec/manifest schemas, Mermaid syntax, and evidence backing (Tier 3 / Tier 2 with --gate)',
  },
  'architecture-diagram-render': {
    file: './cobolt-architecture-diagram-render.js',
    desc: 'Best-effort Mermaid → SVG/PNG rendering via mmdc (optional; skipped cleanly when unavailable)',
  },
  'architecture-diagram-report': {
    file: './cobolt-architecture-diagram-report.js',
    desc: 'Assemble executive HTML (Mermaid-inlined, offline) + PDF (Playwright) architecture packet',
  },
  'arch-icon-search': {
    file: './cobolt-arch-icon-search.js',
    desc: 'Deterministic icon search/resolve/ensure for the arch-diagrams rich-rendering pipeline (allowlisted + cached)',
  },
  'arch-bootstrap': {
    file: './cobolt-arch-bootstrap.js',
    desc: 'One-shot arch-pipeline provisioner: detect mmdc/d2/plantuml CLIs, optionally npm-install renderers, pre-warm icon cache. Invoked by cobolt-init.',
  },
  'arch-failure-record': {
    file: './cobolt-arch-failure-record.js',
    desc: 'Structured failure-record writer for the architecture-diagrams agent team (curator + icon-resolver). Forces L1=architect per escalation-protocol; sanitizes; writes atomically.',
  },
  'arch-doctor': {
    file: './cobolt-arch-doctor.js',
    desc: 'Full arch-pipeline health check: tool presence, renderer availability, schema presence, kill-switch state, icon cache, graph/manifest freshness, recent failure records.',
  },
  'planning-failure-record': {
    file: './cobolt-planning-failure-record.js',
    desc: 'Structured failure-record writer for the 18 planning-phase agents. Forces L1=planning-lead per escalation-protocol; sanitizes; writes to audit ledger.',
  },
  'plan-doctor': {
    file: './cobolt-plan-doctor.js',
    desc: 'Full plan-pipeline health check: 15 tools, 4 schemas, 20 agents, 20 sub-skills, 5 hooks, planning artifact freshness, RTM integrity, phase checkpoints, recent failures.',
  },
  'plan-pipeline-audit': {
    file: './cobolt-plan-pipeline-audit.js',
    desc: 'Deterministic source-contract audit for the full cobolt-plan pipeline graph, phases, tools, hooks, agents, ACLs, and artifacts.',
  },
  'plan-output-audit': {
    file: './cobolt-plan-output-audit.js',
    desc: 'Deep deterministic audit of cobolt-plan run outputs across planning artifacts, coverage, readiness, parity, and diagram duplication checks.',
  },
  'plan-review': {
    file: './cobolt-plan-review.js',
    desc: 'Holistic post-plan review wrapper that synthesizes deterministic detectors and semantic findings into plan-review verdicts.',
  },
  'build-pipeline-audit': {
    file: './cobolt-build-pipeline-audit.js',
    desc: 'Deterministic source-contract audit for the full cobolt-build pipeline graph, stages, tools, hooks, gates, agents, ACLs, and artifacts.',
  },
  'build-args': {
    file: './cobolt-build-args.js',
    desc: 'Canonical argument normalizer for cobolt-build entry (milestone, auto, resume, parallel) with audit trail output.',
  },
  'build-audit-lead': {
    file: './cobolt-build-audit-lead.js',
    desc: 'Deterministic build audit orchestrator for Sessions 1-3 - writes static audit, Tier B feasibility, sandbox live-run evidence, and final reports under _cobolt-output/audit/build-audit/.',
  },
  'build-ui-state-check': {
    file: './cobolt-build-ui-state-check.js',
    desc: 'Build Step 07 UI state coverage verdict - consolidates planning UX completeness and validation-layer UI evidence into a milestone-scoped report.',
  },
  'build-config-hygiene-check': {
    file: './cobolt-build-config-hygiene-check.js',
    desc: 'Build Step 07 target-project config hygiene gate - verifies referenced env/config surface is documented and fail-closed gaps are written to a build-scoped report.',
  },
  'build-ir-coverage-gate': {
    file: './cobolt-build-ir-coverage-gate.js',
    desc: 'Build Step 07 implicit-requirements/domain-IR coverage gate - surfaces matched domain IR coverage into the milestone validation packet.',
  },
  'anchor-index': {
    file: './cobolt-anchor-index.js',
    desc: 'TF-IDF retrieval index for anchor sections - build, query, compact, and stats operations.',
  },
  'fr-coverage': {
    file: './cobolt-fr-coverage.js',
    desc: 'Deterministic FR-to-code coverage verifier against planning artifacts and source evidence.',
  },
  'lesson-prefix': {
    file: './cobolt-lesson-prefix.js',
    desc: 'CLI wrapper for pending lesson-prefix read and consume operations.',
  },
  'tdd-gate': {
    file: './cobolt-tdd-gate.js',
    desc: 'CLI wrapper around the canonical TDD gate hook so build steps invoke the same path contract.',
  },
  'worker-lifecycle': {
    file: './cobolt-worker-lifecycle.js',
    desc: 'Runtime worker lifecycle verifier for health, readiness, metrics, workers, and declared integrations.',
  },
  'review-pipeline-audit': {
    file: './cobolt-review-pipeline-audit.js',
    desc: 'Deterministic source-contract audit for the full cobolt-review pipeline graph, stages, tools, hooks, gates, agents, ACLs, and artifacts.',
  },
  'review-governance': {
    file: './cobolt-review-governance.js',
    desc: 'Deterministic review Step 06 governance contracts: risk register, acceptance, reviewer policy, coverage matrix, authz replay, challenge backlog, and release gate.',
  },
  'fix-pipeline-audit': {
    file: './cobolt-fix-pipeline-audit.js',
    desc: 'Deterministic source-contract audit for the full cobolt-fix pipeline graph, stages, tools, hooks, gates, agents, ACLs, loops, and artifacts.',
  },
  'planning-census': {
    file: './cobolt-planning-census.js',
    desc: 'Symmetric cross-artifact census: sprint-status↔story-tracker coverage, milestones.md↔milestone-tracker parity, milestone count floor/ceiling (hard 3 floor, 20 single-BC / 8-per-BC ceiling).',
  },
  'clarification-report': {
    file: './cobolt-clarification-report.js',
    desc: 'Generate clarification-report.md and clarification-report.json from planning-time ambiguity and conflict artifacts.',
  },
  'planning-workspace-index': {
    file: './cobolt-planning-workspace-index.js',
    desc: 'Emit a structured index of planning artifacts (foundation / feature packet / architecture / delivery / quality) for navigation and audit.',
  },
  'build-failure-record': {
    file: './cobolt-build-failure-record.js',
    desc: 'Structured failure-record writer for the 19 build-phase agents. Forces L1=build-lead per escalation-protocol; per-story discriminator; sanitizes; writes to build-agent-failures ledger.',
  },
  'build-doctor': {
    file: './cobolt-build-doctor.js',
    desc: 'Full build-pipeline health check: 25 tools, 4 schemas, 19 agents, 22 checkpoint files, 12 hooks, step-invocation gate tiers, current pipeline state, story tracker, build artifacts, recent failures, kill switches.',
  },
  'fix-failure-record': {
    file: './cobolt-fix-failure-record.js',
    desc: 'Structured failure-record writer for the 16 fix-phase agents. Forces L1=fix-lead per escalation-protocol; per-finding discriminator; supports phantom-fix, plateau-detected, dead-end-hit, architectural-escalation-required error classes.',
  },
  'fix-doctor': {
    file: './cobolt-fix-doctor.js',
    desc: 'Full fix-pipeline health check: 13 tools, 2 schemas, 16 agents, 3 sub-skills, 5 hooks, iteration state, dead-ends ledger, findings coverage, recent failures.',
  },
  'brownfield-failure-record': {
    file: './cobolt-brownfield-failure-record.js',
    desc: 'Structured failure-record writer for the 26 brownfield-phase agents. Forces L1=brownfield-lead per escalation-protocol; per-artifact discriminator; supports source-unavailable, binary-undecompilable, rule-validation-failed, migration-plan-unfeasible, forensic-findings-critical error classes.',
  },
  'brownfield-doctor': {
    file: './cobolt-brownfield-doctor.js',
    desc: 'Full brownfield-pipeline health check: 8 tools, 2 schemas, 26 agents, 1 sub-skill, 3 hooks, scan mode, phase state, artifact sentinels, recent failures.',
  },
  'mcp-doctor': {
    file: './cobolt-mcp-doctor.js',
    desc: 'SF-06: one-shot MCP coverage remediation + ack/snooze. Subcommands check/fix/ack/snooze/reset. Suppresses the SessionStart MCP coverage banner via _cobolt-output/audit/mcp-coverage-acknowledged.json.',
  },
  'runtime-sync': {
    file: './cobolt-runtime-sync.js',
    desc: 'Detect installed CoBolt runtimes (Claude Code + Codex IDE × global + local), auto-sync to current version. Invoked by cobolt-init step 0 for seamless first-run experience.',
  },

  // ── v0.53+ build-pipeline redesign (PR-2 Batch A: deterministic supply-chain + story-contract emitters) ──
  'lockfile-verify': {
    file: './cobolt-lockfile-verify.js',
    desc: 'v0.53+ PR-2: lockfile-vs-manifest drift check (npm/cargo/mix/go/poetry). Composed by cobolt-supply-chain-build-gate at preflight.',
  },
  'license-scan': {
    file: './cobolt-license-scan.js',
    desc: 'v0.53+ PR-2: SPDX policy enforcement against license-policy.schema.json (allow/deny/reviewRequired + family aliases + package waivers). Composed by cobolt-supply-chain-build-gate.',
  },
  'story-contract-emit': {
    file: './cobolt-story-contract-emit.js',
    desc: 'v0.53+ PR-2: emit per-story interface contracts conforming to story-contracts.schema.json. Reads M{n}-story-specs-index.json + S{x}-impl-spec.md; produces M{n}-S{y}-story-contracts.json. Used at build Step 01A (PR-3 wires).',
  },
  'story-dep-map': {
    file: './cobolt-story-dep-map.js',
    desc: 'v0.53+ PR-2: build per-milestone story dependency graph from story-contracts. Detects cycles (advisory). Used by cobolt-story-mock-wire (Step 02a) for safe dispatch order.',
  },
  'file-ownership-claim': {
    file: './cobolt-file-ownership-claim.js',
    desc: 'v0.53+ PR-2: glob-resolve a write target against file-ownership.schema.json. resolve|claim|verify subcommands. Used by cobolt-source-write-ownership-gate (PR-5).',
  },

  // ── v0.53+ build-pipeline redesign (PR-2 Batch B: in-tree analyzers — complexity / duplication / fingerprint) ──
  'cyclomatic-complexity': {
    file: './cobolt-cyclomatic-complexity.js',
    desc: 'v0.53+ PR-2: per-function cyclomatic complexity scan (heuristic, no AST). Composed by cobolt-code-quality-check.',
  },
  'code-duplication-detect': {
    file: './cobolt-code-duplication-detect.js',
    desc: 'v0.53+ PR-2: line-block hash bucket clone detector. Reports dup% across the source tree. Composed by cobolt-code-quality-check.',
  },
  'code-quality-check': {
    file: './cobolt-code-quality-check.js',
    desc: 'v0.53+ PR-2: orchestrates dup + complexity scans against per-language thresholds in code-quality-thresholds.schema.json. Wired into Step 04a0 by PR-4.',
  },
  'ai-author-fingerprint': {
    file: './cobolt-ai-author-fingerprint.js',
    desc: 'v0.53+ PR-2: Tier-3 advisory stylometric scan (tokenEntropy / commentRatio / boilerplateRatio / identifierVariance). Always exits 0 — informational only.',
  },

  // ── v0.53+ build-pipeline redesign (PR-2 Batch C: external-dep-aware tools) ──
  'story-mock-wire': {
    file: './cobolt-story-mock-wire.js',
    desc: 'v0.53+ PR-2: read story-contracts and emit per-contract stub descriptors under build/{M}/mocks/{S}/. wire|status subcommands. PR-4 wires into Step 02a.',
  },
  'story-cumulative-smoke': {
    file: './cobolt-story-cumulative-smoke.js',
    desc: 'v0.53+ PR-2: per-story analogue of cross-milestone-smoke. Replays integration surface against prior-story union within the same milestone. PR-4 wires into Step 04c.',
  },
  'story-visual-diff': {
    file: './cobolt-story-visual-diff.js',
    desc: 'v0.53+ PR-2: per-story screenshot capture + pixel-diff against story-visual-baseline. capture|diff subcommands. Exits 2 when playwright/pngjs/pixelmatch missing. PR-3 wires into Step 03B.',
  },
  'axe-build-runner': {
    file: './cobolt-axe-build-runner.js',
    desc: 'v0.53+ PR-2: per-story axe-core accessibility scan wrapper around @axe-core/playwright. Exits 2 when deps missing. PR-3 wires into Step 04A.',
  },
};

// ── CLI ──────────────────────────────────────────────────────

function printUsage() {
  console.log();
  console.log('  CoBolt Tools — Unified pipeline tool runner');
  console.log('  ══════════════════════════════════════════════');
  console.log();
  console.log('  Usage: node tools/index.js <tool> [args...]');
  console.log();
  console.log('  Available tools:');
  console.log();

  const maxLen = Math.max(...Object.keys(TOOLS).map((k) => k.length));
  for (const [name, info] of Object.entries(TOOLS)) {
    console.log(`    ${name.padEnd(maxLen + 2)} ${info.desc}`);
  }

  console.log();
  console.log('  Options:');
  console.log('    --list     List available tools as JSON');
  console.log('    --help     Show this help message');
  console.log();
}

function listTools() {
  const list = Object.entries(TOOLS).map(([name, info]) => {
    const entry = {
      name,
      description: info.desc,
      file: info.file,
    };
    if (info.deprecated) entry.deprecated = info.deprecated;
    return entry;
  });
  console.log(JSON.stringify(list, null, 2));
}

/**
 * Load a tool module by name.
 * @param {string} name - Tool name from TOOLS registry
 * @returns {object} The tool module exports
 */
function loadTool(name) {
  const entry = TOOLS[name];
  if (!entry) throw new Error(`Unknown tool: ${name}. Run with --list to see available tools.`);
  return require(entry.file);
}

/**
 * Get all registered tool names.
 */
function getToolNames() {
  return Object.keys(TOOLS);
}

/**
 * Check if a tool exists.
 */
function hasTool(name) {
  return name in TOOLS;
}

// ── SF-01 follow-up — meta verb handlers ─────────────────────
//
// `tools/verbs.js` declares `tools.list` and `tools.help` as the sentinel
// '__meta__'. Resolution returns null for meta nouns so the ordinary verb→noun
// dispatcher cannot route them. Without these handlers, `tools list` fell
// through to flat-name dispatch and errored as "Unknown tool 'tools'" (the
// follow-up captured in docs/COBOLT-ENHANCEMENT-PLAN.md §SF-01 line 62).

function formatVerbLine(verb, def) {
  return `  ${verb.padEnd(12)} ${def.desc || ''}`.trimEnd();
}

function printVerbsOverview(VERBS) {
  process.stdout.write('CoBolt Tools — verb-namespaced surface (SF-01)\n\n');
  process.stdout.write('Grammar: cobolt-tools <verb> <noun> [args...]\n\n');
  process.stdout.write('Verbs:\n');
  for (const [verb, def] of Object.entries(VERBS).sort(([a], [b]) => a.localeCompare(b))) {
    process.stdout.write(`${formatVerbLine(verb, def)}\n`);
  }
  process.stdout.write('\nDrill into a verb: cobolt-tools tools help <verb>\n');
  process.stdout.write('List flat-tool registry: node tools/index.js --list\n');
  return 0;
}

function printVerbList(VERBS) {
  process.stdout.write('CoBolt Tools — verb list (SF-01)\n\n');
  for (const [verb, def] of Object.entries(VERBS).sort(([a], [b]) => a.localeCompare(b))) {
    const nouns = Object.keys(def.nouns || {})
      .sort()
      .join(' ');
    process.stdout.write(`${formatVerbLine(verb, def)}\n`);
    if (nouns) process.stdout.write(`    nouns: ${nouns}\n`);
  }
  process.stdout.write('\nUsage: cobolt-tools <verb> <noun> [args...]\n');
  return 0;
}

function printVerbHelp(verb, VERBS) {
  const def = VERBS[verb];
  if (!def) {
    process.stderr.write(`  Error: unknown verb "${verb}"\n`);
    process.stderr.write(`  Available verbs: ${Object.keys(VERBS).sort().join(', ')}\n`);
    return 1;
  }
  process.stdout.write(`Verb: ${verb} — ${def.desc || ''}\n\n`);
  process.stdout.write('Nouns:\n');
  for (const [noun, value] of Object.entries(def.nouns || {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (value === '__meta__') {
      process.stdout.write(`  ${noun.padEnd(20)} (meta)\n`);
    } else if (typeof value === 'string') {
      process.stdout.write(`  ${noun.padEnd(20)} → ${value}\n`);
    } else if (value && typeof value === 'object' && typeof value.target === 'string') {
      const preArgs = Array.isArray(value.preArgs) ? value.preArgs.join(' ') : '';
      process.stdout.write(`  ${noun.padEnd(20)} → ${value.target}${preArgs ? ` (${preArgs})` : ''}\n`);
    }
  }
  process.stdout.write(`\nUsage: cobolt-tools ${verb} <noun> [args...]\n`);
  return 0;
}

function handleMetaVerb(verb, noun, extra, verbsModule) {
  const { VERBS } = verbsModule;
  if (verb === 'tools' && noun === 'list') return printVerbList(VERBS);
  if (verb === 'tools' && noun === 'help') {
    if (extra.length > 0) return printVerbHelp(extra[0], VERBS);
    return printVerbsOverview(VERBS);
  }
  process.stderr.write(`  Error: unhandled meta verb "${verb} ${noun}"\n`);
  return 1;
}

// ── Module exports (for programmatic use) ────────────────────

module.exports = { TOOLS, loadTool, getToolNames, hasTool, handleMetaVerb };

// ── CLI entry point ──────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage();
    process.exit(0);
  }

  if (args[0] === '--list') {
    listTools();
    process.exit(0);
  }

  // SF-01 verb-noun resolver — runs first when args.length >= 2 and the
  // first two tokens form a known verb→noun pair. Falls through to the
  // existing flat-name dispatch otherwise. See spec §3.1.
  //
  // resolve() returns { target, preArgs } on match. preArgs preserves the
  // legacy npm-script subcommand (e.g. `tools:gate-lint` was bodied as
  // 'node tools/cobolt-gate-lint.js check' so verb=gate noun=lint resolves
  // to { target:'gate-lint', preArgs:['check'] } and we spawn cobolt-gate-lint.js
  // with 'check' prepended to user args).
  let toolName = args[0];
  let toolArgs = args.slice(1);
  if (args.length >= 2) {
    const verbs = require('./verbs.js');
    // Meta verbs (e.g. `tools list`, `tools help [<verb>]`) are intercepted
    // BEFORE flat-name dispatch — verbs.resolve() returns null for the
    // '__meta__' sentinel, which would otherwise leak to the unknown-tool
    // branch. See docs/COBOLT-ENHANCEMENT-PLAN.md §SF-01 follow-up.
    const verbDef = verbs.VERBS[args[0]];
    const nounValue = verbDef?.nouns?.[args[1]];
    if (nounValue === '__meta__') {
      process.exit(handleMetaVerb(args[0], args[1], args.slice(2), verbs));
    }
    const resolved = verbs.resolve(args[0], args[1]);
    if (resolved && TOOLS[resolved.target]) {
      toolName = resolved.target;
      toolArgs = [...resolved.preArgs, ...args.slice(2)];
    }
  }

  if (!TOOLS[toolName]) {
    console.error(`  Error: Unknown tool "${toolName}"`);
    console.error(`  Run "node tools/index.js --list" for available tools.`);
    process.exit(1);
  }

  const toolEntry = TOOLS[toolName];
  if (toolEntry.deprecated) {
    const renamedTo = toolEntry.deprecated.renamedTo;
    const reason = toolEntry.deprecated.reason || '';
    console.error(
      `[deprecated] '${toolName}' has been renamed to '${renamedTo}'. Use 'node tools/index.js ${renamedTo}' instead.${reason ? ` ${reason}` : ''}`,
    );
  }

  // Spawn the tool as a real CLI entrypoint so tools guarded by require.main work.
  const toolPath = path.resolve(__dirname, toolEntry.file);
  const result = spawnSync(process.execPath, [toolPath, ...toolArgs], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });

  if (result.error) {
    console.error(`  Error running tool "${toolName}": ${result.error.message}`);
    process.exit(1);
  }

  process.exit(result.status ?? 0);
}
