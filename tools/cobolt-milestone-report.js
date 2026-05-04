#!/usr/bin/env node

// CoBolt Milestone Report — generates honest milestone report cards from step proof records
//
// Usage:
//   node tools/cobolt-milestone-report.js generate <milestone>   # e.g. M1
//   node tools/cobolt-milestone-report.js generate --all         # all milestones in proofs dir

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite: sharedAtomicWrite } = require('../lib/cobolt-atomic-write');
const {
  BUILD_STEP_LABELS,
  BUILD_STEP_WEIGHTS,
  BUILD_STEP_IDS,
  REPORTABLE_BUILD_STEP_LABELS,
  REPORTABLE_BUILD_STEP_WEIGHTS,
  REPORTABLE_BUILD_STEP_IDS,
} = (() => {
  try {
    return require('../source/hooks/cobolt-build-steps');
  } catch (outerErr) {
    try {
      return require('../hooks/cobolt-build-steps');
    } catch (innerErr) {
      // GAP-4: Log when import fails — missing-proof synthesis and weighted grading are DISABLED
      process.stderr.write(
        `[cobolt-milestone-report] WARNING: Cannot load cobolt-build-steps.js — ` +
          `missing-proof synthesis (B006) and weighted grading are DISABLED.\n` +
          `  Outer: ${outerErr.message}\n  Inner: ${innerErr.message}\n`,
      );
      return {
        BUILD_STEP_LABELS: {},
        BUILD_STEP_WEIGHTS: {},
        BUILD_STEP_IDS: [],
        REPORTABLE_BUILD_STEP_LABELS: {},
        REPORTABLE_BUILD_STEP_WEIGHTS: {},
        REPORTABLE_BUILD_STEP_IDS: [],
      };
    }
  }
})();

const STEP_LABELS =
  REPORTABLE_BUILD_STEP_LABELS && Object.keys(REPORTABLE_BUILD_STEP_LABELS).length > 0
    ? REPORTABLE_BUILD_STEP_LABELS
    : BUILD_STEP_LABELS;
const STEP_WEIGHTS =
  REPORTABLE_BUILD_STEP_WEIGHTS && Object.keys(REPORTABLE_BUILD_STEP_WEIGHTS).length > 0
    ? REPORTABLE_BUILD_STEP_WEIGHTS
    : BUILD_STEP_WEIGHTS;
const CANONICAL_STEP_IDS =
  Array.isArray(REPORTABLE_BUILD_STEP_IDS) && REPORTABLE_BUILD_STEP_IDS.length > 0
    ? REPORTABLE_BUILD_STEP_IDS
    : BUILD_STEP_IDS;

// ── cobolt-paths integration (same pattern as other tools) ────────────────────

const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

function getPaths() {
  return typeof _paths === 'function' ? _paths(process.cwd()) : null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_MULTIPLIER = {
  passed: 1.0,
  partial: 0.5,
  skipped: 0.0,
  failed: 0.0,
  missing: 0.0, // B006 — missing proofs count against the grade, not invisible
  not_applicable: null, // excluded from both numerator AND denominator
};

const GRADE_THRESHOLDS = [
  [95, 'A+'],
  [90, 'A'],
  [85, 'A-'],
  [80, 'B+'],
  [75, 'B'],
  [70, 'B-'],
  [65, 'C+'],
  [60, 'C'],
  [55, 'C-'],
  [50, 'D'],
  [0, 'F'],
];

function normalizeProofStatus(proof) {
  const raw = String(proof?.status || '')
    .trim()
    .toLowerCase();
  if (Object.hasOwn(STATUS_MULTIPLIER, raw)) return raw;
  if (['pass', 'complete', 'completed', 'ok', 'no-findings', 'no_findings'].includes(raw)) return 'passed';
  if (['fail', 'error', 'errored', 'blocked'].includes(raw)) return 'failed';
  if (proof?.passed === true || proof?.ok === true || proof?.pass === true) return 'passed';
  if (proof?.passed === false || proof?.ok === false || proof?.pass === false) return 'failed';
  if (proof?.skipped === true) return 'skipped';
  return 'missing';
}

function normalizeProofRecord(proof) {
  if (!proof || typeof proof !== 'object') return proof;
  return {
    ...proof,
    status: normalizeProofStatus(proof),
  };
}

// ── Grade Calculation ─────────────────────────────────────────────────────────

/**
 * Calculate weighted grade from an array of proof records.
 * - not_applicable (null multiplier) → excluded from numerator AND denominator
 * - 03-tdd-green with tests → use tests.passed / tests.planned as multiplier
 * Returns { letter, score, maxWeight, earnedWeight }
 */
function calculateGrade(proofs) {
  if (!proofs || proofs.length === 0) {
    return { letter: 'F', score: 0, maxWeight: 0, earnedWeight: 0 };
  }

  let maxWeight = 0;
  let earnedWeight = 0;

  for (const proof of proofs) {
    const step = proof.step;
    const weight = STEP_WEIGHTS[step];
    if (weight === undefined) continue; // unknown step, skip

    const status = normalizeProofStatus(proof);
    const multiplier = Object.hasOwn(STATUS_MULTIPLIER, status) ? STATUS_MULTIPLIER[status] : 0;

    // not_applicable → excluded entirely
    if (multiplier === null) continue;

    maxWeight += weight;

    // Special case: 03-tdd-green with tests uses ratio multiplier
    if (step === '03-tdd-green' && proof.evidence && proof.evidence.tests) {
      const t = proof.evidence.tests;
      if (t && t.planned > 0) {
        const ratio = Math.min(t.passed / t.planned, 1.0);
        earnedWeight += weight * ratio;
        continue;
      }
    }

    earnedWeight += weight * multiplier;
  }

  if (maxWeight === 0) {
    return { letter: 'F', score: 0, maxWeight: 0, earnedWeight: 0 };
  }

  const score = Math.round((earnedWeight / maxWeight) * 1000) / 10; // 1 decimal

  let letter = 'F';
  for (const [threshold, grade] of GRADE_THRESHOLDS) {
    if (score >= threshold) {
      letter = grade;
      break;
    }
  }

  return { letter, score, maxWeight, earnedWeight };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Format milliseconds to human-readable: "2.1s", "4m 32s", "1h 2m"
 */
function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${Math.round(secs * 10) / 10}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = Math.round(secs % 60);
  if (mins < 60) return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
}

function formatUSD(amount) {
  if (!Number.isFinite(amount)) return '$0.0000';
  return amount >= 1 ? `$${amount.toFixed(2)}` : `$${amount.toFixed(4)}`;
}

function formatTokenCount(tokens) {
  return Number.isFinite(tokens) ? tokens.toLocaleString('en-US') : '0';
}

/**
 * One-line detail from proof evidence.
 */
function stepDetail(proof) {
  const ev = proof.evidence || {};
  const t = ev.tests;
  if (t && t.planned > 0) {
    return `${t.passed}/${t.planned} tests passed`;
  }
  const agents = ev.agents_dispatched;
  if (agents && agents.length > 0) {
    return `${agents.length} agent${agents.length > 1 ? 's' : ''} dispatched`;
  }
  const cmds = ev.commands_executed;
  if (cmds && cmds.length > 0) {
    return `${cmds.length} command${cmds.length > 1 ? 's' : ''} run`;
  }
  if (Array.isArray(proof.commands) && proof.commands.length > 0) {
    return `${proof.commands.length} command${proof.commands.length > 1 ? 's' : ''} run`;
  }
  if (proof.skipReason) return proof.skipReason;
  return normalizeProofStatus(proof);
}

/**
 * Aggregate test totals across all proof records.
 */
function aggregateTests(proofs) {
  const totals = { planned: 0, executed: 0, passed: 0, failed: 0, skipped: 0, coveragePct: null };
  for (const proof of proofs) {
    const t = proof.evidence?.tests;
    if (!t) continue;
    totals.planned += t.planned || 0;
    totals.executed += t.executed || 0;
    totals.passed += t.passed || 0;
    totals.failed += t.failed || 0;
    totals.skipped += t.skipped || 0;
    if (t.coveragePct != null) {
      // average coverage if multiple steps report it
      totals.coveragePct = totals.coveragePct == null ? t.coveragePct : (totals.coveragePct + t.coveragePct) / 2;
    }
  }
  return totals;
}

/**
 * Deduplicate prerequisites across all proofs.
 * Returns [{ id, status: 'met'|'unmet', affectsStep }]
 */
function aggregatePrereqs(proofs) {
  const seen = new Map();
  for (const proof of proofs) {
    const p = proof.prerequisites;
    if (!p) continue;
    for (const id of p.met || []) {
      if (!seen.has(id)) seen.set(id, { id, status: 'met', affectsStep: proof.step });
    }
    for (const id of p.unmet || []) {
      // unmet takes precedence over met
      seen.set(id, { id, status: 'unmet', affectsStep: proof.step });
    }
  }
  return Array.from(seen.values());
}

function collectArtifacts(proofs) {
  const artifacts = [];
  const seen = new Set();
  const pushArtifact = (artifact, proof) => {
    if (!artifact) return;
    const artifactPath = typeof artifact === 'string' ? artifact : artifact.path || artifact.file || artifact.target;
    if (!artifactPath) return;
    const key = `${proof.step || ''}:${artifactPath}`;
    if (seen.has(key)) return;
    seen.add(key);
    let size = typeof artifact === 'object' && Number.isFinite(artifact.size) ? artifact.size : undefined;
    if (size == null) {
      const resolved = path.isAbsolute(artifactPath) ? artifactPath : path.resolve(process.cwd(), artifactPath);
      try {
        if (fs.existsSync(resolved)) size = fs.statSync(resolved).size;
      } catch {
        /* best effort */
      }
    }
    artifacts.push({
      path: artifactPath,
      step: proof.step,
      size,
      hash: typeof artifact === 'object' ? artifact.hash || artifact.sha256 : undefined,
    });
  };
  for (const proof of proofs) {
    const produced = proof.evidence?.artifacts_produced || proof.evidence?.artifacts || [];
    for (const artifact of produced) pushArtifact(artifact, proof);
    const topLevelArtifacts = Array.isArray(proof.artifacts) ? proof.artifacts : [];
    for (const artifact of topLevelArtifacts) pushArtifact(artifact, proof);
  }
  return artifacts;
}

function readJsonl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];

  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function aggregateCostEntries(entries) {
  if (!entries || entries.length === 0) return null;

  let totalTokens = 0;
  let totalCostUsd = 0;
  const byModel = new Map();
  const byStage = new Map();

  for (const entry of entries) {
    const input = entry.input_tokens || 0;
    const output = entry.output_tokens || 0;
    const tokens = input + output;
    const cost = entry.cost_usd || 0;
    const model = entry.model || 'unknown';
    const stage = entry.stage || 'unknown';

    totalTokens += tokens;
    totalCostUsd += cost;

    if (!byModel.has(model)) {
      byModel.set(model, { model, invocations: 0, totalTokens: 0, totalCostUsd: 0 });
    }

    if (!byStage.has(stage)) {
      byStage.set(stage, { stage, invocations: 0, totalCostUsd: 0 });
    }

    const modelRow = byModel.get(model);
    modelRow.invocations += 1;
    modelRow.totalTokens += tokens;
    modelRow.totalCostUsd += cost;

    const stageRow = byStage.get(stage);
    stageRow.invocations += 1;
    stageRow.totalCostUsd += cost;
  }

  return {
    invocations: entries.length,
    totalTokens,
    totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
    byModel: Array.from(byModel.values()).sort((a, b) => b.totalCostUsd - a.totalCostUsd),
    byStage: Array.from(byStage.values()).sort((a, b) => b.totalCostUsd - a.totalCostUsd),
  };
}

function readMilestoneCostSummary(milestone, opts = {}, coboltPaths = null) {
  const projectCostLedgerPath =
    opts.projectCostLedgerPath || path.join(process.cwd(), '_cobolt-output', 'project-costs.jsonl');
  const latestCostLedgerPath =
    opts.latestCostLedgerPath ||
    (coboltPaths
      ? path.join(coboltPaths.latest(), 'costs', 'cost-ledger.jsonl')
      : path.join(process.cwd(), '_cobolt-output', 'latest', 'costs', 'cost-ledger.jsonl'));

  const projectEntries = readJsonl(projectCostLedgerPath).filter((entry) => entry.milestone === milestone);
  if (projectEntries.length > 0) {
    return {
      source: path.relative(process.cwd(), projectCostLedgerPath) || projectCostLedgerPath,
      ...aggregateCostEntries(projectEntries),
    };
  }

  const latestEntries = readJsonl(latestCostLedgerPath).filter(
    (entry) => !entry.milestone || entry.milestone === milestone,
  );
  if (latestEntries.length > 0) {
    return {
      source: path.relative(process.cwd(), latestCostLedgerPath) || latestCostLedgerPath,
      ...aggregateCostEntries(latestEntries),
    };
  }

  return null;
}

function parseManualChecklist(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .replace(/^[-*]\s+/, '')
        .replace(/^\d+\.\s+/, '')
        .trim(),
    )
    .filter(Boolean);
}

function readManualTestChecklist(milestone, reportDir, opts = {}, costSummary = null) {
  const candidates = [
    opts.manualTestFile,
    path.join(reportDir, 'manual-test-checklist.md'),
    path.join(reportDir, `${milestone}-manual-test-checklist.md`),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const items = parseManualChecklist(fs.readFileSync(candidate, 'utf8'));
    if (items.length > 0) return items;
  }

  const fallback = [
    'Start the app stack with `cd app && docker compose up -d app`.',
    'Open `http://localhost:4000` and sign in with a valid session.',
    'Run the milestone happy-path flow and confirm the updated UI renders without server or LiveView errors.',
    'Open the project pipeline view and confirm the milestone status and generated reports are visible.',
  ];

  if (costSummary) {
    fallback.push('Open `/projects/:id/costs` and confirm token and cost metrics match the generated report.');
  }

  return fallback;
}

/**
 * Read gate-skip-log.jsonl for a given milestone (Tier 2 skips).
 */
function readProductionReadiness(milestone) {
  try {
    const stateFp = path.join(process.cwd(), 'cobolt-state.json');
    if (!fs.existsSync(stateFp)) return null;
    const state = JSON.parse(fs.readFileSync(stateFp, 'utf8'));
    const m = state.metrics || {};
    const score = m.productionReadyScore?.[milestone] ?? null;
    return {
      score,
      crossMilestoneSmokeFailures: Number(m.crossMilestoneSmokeFailures || 0),
      contractViolations: Number(m.contractViolations || 0),
      behaviorCoverageGaps: Number(m.behaviorCoverageGaps || 0),
      fixLoopPlateaus: Number(m.fixLoopPlateaus || 0),
      perfBudgetExceeded: Number(m.perfBudgetExceeded || 0),
    };
  } catch {
    return null;
  }
}

function readGateOverrides(milestone, auditDir) {
  const overrides = [];
  const logPath = path.join(auditDir, 'gate-skip-log.jsonl');
  if (!fs.existsSync(logPath)) return overrides;
  try {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.milestone === milestone) overrides.push(entry);
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* best-effort */
  }
  return overrides;
}

/**
 * Read builder-return-log.jsonl and compute per-milestone metrics.
 *
 * Returns null if no entries exist for this milestone.
 *
 * Metrics:
 *   - dispatches: total builder dispatches recorded
 *   - sizeWarn / sizeHard: count of size-based violations
 *   - schemaInvalid: count of schema-based violations (strict mode only)
 *   - schemaValid: count of returns where parsed JSON matched the schema
 *   - schemaMissing: count of returns where no JSON block was found
 *   - sizeStats: { min, max, median } in bytes
 *   - enforcementMode: 'strict' | 'grace' | 'mixed'
 */
function readBuilderReturnSummary(_milestone, auditDir) {
  const logPath = path.join(auditDir, 'builder-return-log.jsonl');
  if (!fs.existsSync(logPath)) return null;

  const entries = [];
  try {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        // The builder-return log doesn't carry an explicit `milestone` field —
        // entries are correlated by their step (`03-tdd-green` etc.) and the
        // milestone the build state was in. Take everything during this build run
        // since the audit log is per-run.
        entries.push(e);
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    return null;
  }

  if (entries.length === 0) return null;

  // Compute metrics
  let sizeWarn = 0;
  let sizeHard = 0;
  let schemaInvalid = 0;
  let schemaValid = 0;
  let schemaMissing = 0;
  const sizes = [];
  const modes = new Set();

  for (const e of entries) {
    if (typeof e.size_bytes === 'number') sizes.push(e.size_bytes);
    if (e.schema_enforcement) modes.add(e.schema_enforcement);

    const violations = Array.isArray(e.violations) ? e.violations : [];
    if (violations.some((v) => typeof v === 'string' && v.startsWith('size_warn:'))) sizeWarn++;
    if (violations.some((v) => typeof v === 'string' && v.startsWith('size_hard:'))) sizeHard++;
    if (violations.some((v) => typeof v === 'string' && v.startsWith('schema:'))) schemaInvalid++;

    if (e.schema_valid === true) schemaValid++;
    else if (e.schema_valid === false) schemaMissing++;
  }

  // Median size
  let sizeStats = null;
  if (sizes.length > 0) {
    const sorted = [...sizes].sort((a, b) => a - b);
    sizeStats = {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      median: sorted[Math.floor(sorted.length / 2)],
    };
  }

  let enforcementMode = 'unknown';
  if (modes.size === 1) enforcementMode = [...modes][0];
  else if (modes.size > 1) enforcementMode = 'mixed';

  return {
    dispatches: entries.length,
    sizeWarn,
    sizeHard,
    schemaInvalid,
    schemaValid,
    schemaMissing,
    sizeStats,
    enforcementMode,
  };
}

/**
 * Build auto-generated recommendations based on proof state.
 */
function buildRecommendations(proofs) {
  const recs = [];
  for (const proof of proofs) {
    const s = normalizeProofStatus(proof);
    if (s !== 'skipped' && s !== 'failed' && s !== 'not_applicable' && s !== 'missing') continue;
    const step = proof.step;
    if (step === '05-review') {
      recs.push('Run `/cobolt-review` to perform a full code review before shipping.');
    } else if (step === '07-validate') {
      recs.push('Run `/cobolt-milestone-validate` to verify milestone acceptance criteria.');
    } else if (step === '06-fix') {
      // Only recommend if there were failures elsewhere
      const hasFailed = proofs.some((p) => normalizeProofStatus(p) === 'failed');
      if (hasFailed) recs.push('Run `/cobolt-fix` to address outstanding failures.');
    } else if (step === '00-preflight') {
      recs.push('Check Docker is running: `docker compose up -d` before next build.');
    } else if (step === '02-tdd-red') {
      recs.push('Ensure failing tests are written first (TDD Red phase) before implementation.');
    } else if (step === '03-tdd-green') {
      const t = proof.evidence?.tests;
      if (t && t.failed > 0) {
        recs.push(`Fix ${t.failed} failing test${t.failed > 1 ? 's' : ''} before shipping.`);
      } else {
        recs.push('Complete TDD Green phase: make all tests pass.');
      }
    }
  }
  // Deduplicate
  return [...new Set(recs)];
}

// ── generateMarkdown ──────────────────────────────────────────────────────────

/**
 * Generate full markdown report string.
 * @param {string} milestone - e.g. 'M1'
 * @param {object[]} proofs - array of step proof records
 * @param {object} context - { grade, gateOverrides? }
 */
function generateMarkdown(milestone, proofs, context) {
  const grade = context.grade;
  const gateOverrides = context.gateOverrides || [];
  const artifacts = context.artifacts || [];
  const costSummary = context.costSummary || null;
  const manualTestChecklist = context.manualTestChecklist || [];
  const now = new Date().toISOString();

  const tests = aggregateTests(proofs);
  const prereqs = aggregatePrereqs(proofs);

  // Step counts
  const statusCounts = { passed: 0, skipped: 0, not_applicable: 0, failed: 0, partial: 0, missing: 0 };
  for (const p of proofs) {
    const status = normalizeProofStatus(p);
    if (statusCounts[status] !== undefined) statusCounts[status]++;
  }

  const totalDurationMs = proofs.reduce((sum, p) => sum + (p.duration || 0), 0);

  // What was verified / not done
  const verified = [];
  const notDone = [];

  for (const proof of proofs) {
    const label = STEP_LABELS[proof.step] || proof.step;
    const status = normalizeProofStatus(proof);
    if (status === 'passed' || status === 'partial') {
      verified.push(label);
    } else if (status === 'skipped' || status === 'not_applicable' || status === 'failed' || status === 'missing') {
      const reason = proof.skipReason ? ` — ${proof.skipReason}` : ` (${status})`;
      notDone.push(`${label}${reason}`);
    }
  }

  const recommendations = buildRecommendations(proofs);

  const lines = [];

  // ── Title ──
  lines.push(`# Milestone Report: ${milestone}`);
  lines.push('');
  lines.push(`> Generated: ${now}`);
  lines.push('');

  // ── Grade ──
  lines.push('## Grade');
  lines.push('');
  lines.push(
    '| Score | Letter | Steps Verified | Steps Skipped | Steps N/A | Steps Failed | Tests Passed | Duration |',
  );
  lines.push(
    '|-------|--------|----------------|---------------|-----------|--------------|--------------|----------|',
  );
  const testSummary = tests.planned > 0 ? `${tests.passed}/${tests.planned}` : '—';
  lines.push(
    `| ${grade.score}% | **${grade.letter}** | ${statusCounts.passed} | ${statusCounts.skipped} | ${statusCounts.not_applicable} | ${statusCounts.failed} | ${testSummary} | ${formatDuration(totalDurationMs)} |`,
  );
  lines.push('');

  // ── Step Execution Matrix ──
  lines.push('## Delivery Summary');
  lines.push('');
  lines.push(`- Verified build steps: ${verified.length}`);
  lines.push(`- Artifacts captured: ${artifacts.length}`);
  lines.push(`- Test result: ${testSummary}`);
  if (costSummary) {
    lines.push(
      `- Token and cost summary: ${formatTokenCount(costSummary.totalTokens)} tokens across ${costSummary.invocations} invocation(s), estimated ${formatUSD(costSummary.totalCostUsd)}`,
    );
  } else {
    lines.push('- Token and cost summary: no milestone cost ledger entries were found.');
  }
  lines.push('');

  lines.push('## Step Execution Matrix');
  lines.push('');
  lines.push('| # | Step | Status | Evidence | Duration | Detail |');
  lines.push('|---|------|--------|----------|----------|--------|');

  for (let i = 0; i < proofs.length; i++) {
    const proof = proofs[i];
    const label = STEP_LABELS[proof.step] || proof.step;
    const statusCell = statusBadge(normalizeProofStatus(proof));
    const hash = proof._hash ? proof._hash.slice(0, 8) : '—';
    const dur = formatDuration(proof.duration);
    const detail = stepDetail(proof);
    lines.push(`| ${i + 1} | ${label} | ${statusCell} | \`${hash}\` | ${dur} | ${detail} |`);
  }
  lines.push('');

  // ── Test Execution ──
  if (tests.planned > 0) {
    lines.push('## Test Execution');
    lines.push('');
    lines.push('| Planned | Executed | Passed | Failed | Skipped | Coverage |');
    lines.push('|---------|----------|--------|--------|---------|----------|');
    const covCell = tests.coveragePct != null ? `${Math.round(tests.coveragePct * 10) / 10}%` : '—';
    lines.push(
      `| ${tests.planned} | ${tests.executed} | ${tests.passed} | ${tests.failed} | ${tests.skipped} | ${covCell} |`,
    );
    lines.push('');
  }

  // ── Prerequisites ──
  lines.push('## Manual Test Checklist');
  lines.push('');
  for (let i = 0; i < manualTestChecklist.length; i++) {
    lines.push(`${i + 1}. ${manualTestChecklist[i]}`);
  }
  lines.push('');

  lines.push('## Token & Cost Summary');
  lines.push('');
  if (costSummary) {
    lines.push('| Source | Invocations | Tokens | Estimated Cost |');
    lines.push('|--------|-------------|--------|----------------|');
    lines.push(
      `| ${costSummary.source} | ${costSummary.invocations} | ${formatTokenCount(costSummary.totalTokens)} | ${formatUSD(costSummary.totalCostUsd)} |`,
    );
    lines.push('');

    if (costSummary.byModel.length > 0) {
      lines.push('### Cost By Model');
      lines.push('');
      lines.push('| Model | Invocations | Tokens | Estimated Cost |');
      lines.push('|-------|-------------|--------|----------------|');
      for (const row of costSummary.byModel) {
        lines.push(
          `| ${row.model} | ${row.invocations} | ${formatTokenCount(row.totalTokens)} | ${formatUSD(row.totalCostUsd)} |`,
        );
      }
      lines.push('');
    }

    if (costSummary.byStage.length > 0) {
      lines.push('### Cost By Stage');
      lines.push('');
      lines.push('| Stage | Invocations | Estimated Cost |');
      lines.push('|-------|-------------|----------------|');
      for (const row of costSummary.byStage) {
        lines.push(`| ${row.stage} | ${row.invocations} | ${formatUSD(row.totalCostUsd)} |`);
      }
      lines.push('');
    }
  } else {
    lines.push('No token or cost ledger entries were available for this milestone.');
    lines.push('');
  }

  if (prereqs.length > 0) {
    lines.push('## Prerequisites');
    lines.push('');
    lines.push('| Prerequisite | Status | Affects Step |');
    lines.push('|-------------|--------|--------------|');
    for (const p of prereqs) {
      const statusCell = p.status === 'met' ? 'MET' : '**UNMET**';
      const stepLabel = STEP_LABELS[p.affectsStep] || p.affectsStep;
      lines.push(`| ${p.id} | ${statusCell} | ${stepLabel} |`);
    }
    lines.push('');
  }

  // ── Builder Return Contract Summary ──
  if (context.builderReturnSummary) {
    const s = context.builderReturnSummary;
    lines.push('## Builder Return Contract');
    lines.push('');
    lines.push(
      `Mode: **${s.enforcementMode}** (set \`COBOLT_BUILDER_CONTRACT_ENFORCE=1\` to enable schema enforcement).`,
    );
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Builder dispatches recorded | ${s.dispatches} |`);
    lines.push(`| Schema-valid returns | ${s.schemaValid} |`);
    lines.push(`| Returns with no JSON block | ${s.schemaMissing} |`);
    lines.push(`| Schema violations (strict mode only) | ${s.schemaInvalid} |`);
    lines.push(`| Size warnings (>8K chars / ~2K tokens) | ${s.sizeWarn} |`);
    lines.push(`| Size hard violations (>16K chars / ~4K tokens) | ${s.sizeHard} |`);
    if (s.sizeStats) {
      lines.push(
        `| Return size (bytes) min / median / max | ${s.sizeStats.min} / ${s.sizeStats.median} / ${s.sizeStats.max} |`,
      );
    }
    lines.push('');
    if (s.sizeHard > 0) {
      lines.push(
        `> **WARNING**: ${s.sizeHard} builder return(s) exceeded the 16K-char hard cap. ` +
          'Verbose returns blow up orchestrator context across rounds. Inspect ' +
          '`_cobolt-output/audit/builder-return-log.jsonl` for the offending agents and ' +
          'verify they are writing verbose content to disk per the contract.',
      );
      lines.push('');
    }
    if (s.enforcementMode === 'grace' && s.schemaMissing > 0) {
      lines.push(
        `> NOTE: ${s.schemaMissing} return(s) had no JSON block matching the contract. ` +
          'The hook is in grace mode (default) so this is informational only. To enforce, ' +
          'set `COBOLT_BUILDER_CONTRACT_ENFORCE=1` and ensure builder dispatch prompts inject ' +
          'the contract block from `source/skills/cobolt-build/steps/03-tdd-green.md`.',
      );
      lines.push('');
    }
  }

  // ── Production Readiness Telemetry ──
  if (context.productionReadiness) {
    const pr = context.productionReadiness;
    lines.push('## Production Readiness');
    lines.push('');
    const scoreStr = pr.score == null ? '_not scored_' : `**${pr.score}/100**`;
    lines.push(`- Composite score: ${scoreStr}`);
    lines.push(`- Contract violations: ${pr.contractViolations}`);
    lines.push(`- Cross-milestone smoke failures: ${pr.crossMilestoneSmokeFailures}`);
    lines.push(`- Behavior coverage gaps: ${pr.behaviorCoverageGaps}`);
    lines.push(`- Fix-loop plateaus: ${pr.fixLoopPlateaus}`);
    lines.push(`- Perf budget exceeded: ${pr.perfBudgetExceeded}`);
    lines.push('');
    lines.push('_Metrics logged to `_cobolt-output/audit/production-readiness.jsonl`._');
    lines.push('');
  }

  // ── Gate Decisions ──
  if (gateOverrides.length > 0) {
    lines.push('## Gate Decisions (Tier 2 Skips)');
    lines.push('');
    lines.push('| Gate | Reason | Timestamp | Autonomous |');
    lines.push('|------|--------|-----------|------------|');
    for (const g of gateOverrides) {
      const auto = g.autonomous ? 'Yes' : 'No';
      lines.push(`| ${g.gate || '—'} | ${g.reason || '—'} | ${g.timestamp || '—'} | ${auto} |`);
    }
    lines.push('');
  }

  // ── Honest Assessment ──
  lines.push('## Honest Assessment');
  lines.push('');
  lines.push('### What Was Verified');
  lines.push('');
  if (verified.length > 0) {
    for (const v of verified) lines.push(`- ${v}`);
  } else {
    lines.push('- Nothing was verified in this milestone.');
  }
  lines.push('');

  lines.push('### What Was NOT Done');
  lines.push('');
  if (notDone.length > 0) {
    for (const nd of notDone) lines.push(`- ${nd}`);
  } else {
    lines.push('- All steps were executed.');
  }
  lines.push('');

  // ── Rigorous-Mode Evidence (append only when state.mode === "rigorous") ──
  try {
    const { isRigorous } = require('../lib/cobolt-mode');
    if (isRigorous(process.cwd())) {
      const pr = (() => {
        try {
          return require('./cobolt-production-readiness');
        } catch {
          return null;
        }
      })();
      const inputs = pr ? pr.collectRigorousInputs() : null;
      const composite = pr && inputs ? pr.computeComposite(inputs) : null;
      lines.push('## Rigorous-Mode Evidence');
      lines.push('');
      lines.push('| Input | Value | Artifact |');
      lines.push('|-------|-------|----------|');
      const fmt = (x) => (x?.available ? String(x.value) : '(missing — 0)');
      const art = (x) => (x?.artifact ? x.artifact.replace(process.cwd() + path.sep, '').replace(/\\/g, '/') : '—');
      if (inputs) {
        lines.push(`| humanApprovalRate | ${fmt(inputs.humanApprovalRate)} | ${art(inputs.humanApprovalRate)} |`);
        lines.push(`| mutationScore | ${fmt(inputs.mutationScore)} | ${art(inputs.mutationScore)} |`);
        lines.push(
          `| independentTestPassRate | ${fmt(inputs.independentTestPassRate)} | ${art(inputs.independentTestPassRate)} |`,
        );
        lines.push(`| loadChaosVerdict | ${fmt(inputs.loadChaosVerdict)} | ${art(inputs.loadChaosVerdict)} |`);
        lines.push(`| invariantPassRate | ${fmt(inputs.invariantPassRate)} | ${art(inputs.invariantPassRate)} |`);
        lines.push(
          `| contractRuntimeConformance | ${fmt(inputs.contractRuntimeConformance)} | ${art(inputs.contractRuntimeConformance)} |`,
        );
        lines.push(`| a11yDepthScore | ${fmt(inputs.a11yDepthScore)} | ${art(inputs.a11yDepthScore)} |`);
      } else {
        lines.push('| (telemetry unavailable) | — | — |');
      }
      lines.push('');
      if (composite) {
        lines.push(`**rigorousCompositeScore:** ${composite.score}/100`);
        if (composite.skippedInputs.length) {
          lines.push('');
          lines.push(`_Skipped inputs (contributed 0):_ ${composite.skippedInputs.join(', ')}`);
        }
        lines.push('');
      }
    }
  } catch (err) {
    // Never let the rigorous section break report generation.
    lines.push(`<!-- rigorous-mode section skipped: ${err.message} -->`);
    lines.push('');
  }

  lines.push('### Recommended Before Shipping');
  lines.push('');
  if (recommendations.length > 0) {
    for (const r of recommendations) lines.push(`- ${r}`);
  } else {
    lines.push('- No additional actions required. All gates passed.');
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Map status to a short badge string for markdown tables.
 */
function statusBadge(status) {
  const normalized = String(status || '').trim();
  switch (normalized) {
    case 'passed':
      return 'PASS';
    case 'failed':
      return 'FAIL';
    case 'skipped':
      return 'SKIP';
    case 'not_applicable':
      return 'N/A';
    case 'partial':
      return 'PARTIAL';
    default:
      return normalized ? normalized.toUpperCase() : 'UNKNOWN';
  }
}

// ── generateJSON ──────────────────────────────────────────────────────────────

/**
 * Generate machine-readable JSON report matching milestone-report.schema.json
 */
function generateJSON(milestone, proofs, context) {
  const grade = context.grade;
  const gateOverrides = context.gateOverrides || [];
  const artifacts = context.artifacts || [];
  const costSummary = context.costSummary || null;
  const manualTestChecklist = context.manualTestChecklist || [];
  const builderReturnSummary = context.builderReturnSummary || null;
  const now = new Date().toISOString();

  const tests = aggregateTests(proofs);
  const prereqs = aggregatePrereqs(proofs);

  // Step counts for summary
  const statusCounts = { passed: 0, skipped: 0, not_applicable: 0, failed: 0, partial: 0, missing: 0 };
  let totalDurationMs = 0;
  for (const p of proofs) {
    const status = normalizeProofStatus(p);
    if (statusCounts[status] !== undefined) statusCounts[status]++;
    totalDurationMs += p.duration || 0;
  }

  // Build steps array
  const steps = proofs.map((proof) => {
    const weight = STEP_WEIGHTS[proof.step] || 0;
    const status = normalizeProofStatus(proof);
    let multiplier = STATUS_MULTIPLIER[status];
    if (multiplier === null) multiplier = 0;

    let earned = weight * multiplier;
    if (proof.step === '03-tdd-green' && proof.evidence && proof.evidence.tests) {
      const t = proof.evidence.tests;
      if (t && t.planned > 0) {
        earned = weight * Math.min(t.passed / t.planned, 1.0);
      }
    }

    const item = {
      step: proof.step,
      label: STEP_LABELS[proof.step] || proof.step,
      status,
      evidenceHash: proof._hash ? proof._hash.slice(0, 8) : null,
      duration: proof.duration || 0,
      detail: stepDetail(proof),
      weight,
      earnedWeight: Math.round(earned * 100) / 100,
    };
    if (proof.skipReason) item.skipReason = proof.skipReason;
    return item;
  });

  // Honest assessment
  const verified = [];
  const notDone = [];
  for (const proof of proofs) {
    const label = STEP_LABELS[proof.step] || proof.step;
    if (proof.status === 'passed' || proof.status === 'partial') {
      verified.push(label);
    } else if (proof.status === 'skipped' || proof.status === 'not_applicable' || proof.status === 'failed') {
      const reason = proof.skipReason ? `${label} — ${proof.skipReason}` : `${label} (${proof.status})`;
      notDone.push(reason);
    }
  }
  const recommendations = buildRecommendations(proofs);

  return {
    milestone,
    generatedAt: now,
    grade: {
      letter: grade.letter,
      score: grade.score,
      maxWeight: grade.maxWeight,
      earnedWeight: grade.earnedWeight,
    },
    summary: {
      total: proofs.length,
      verified: statusCounts.passed + statusCounts.partial,
      skipped: statusCounts.skipped,
      notApplicable: statusCounts.not_applicable,
      failed: statusCounts.failed,
      partial: statusCounts.partial,
      durationMs: totalDurationMs,
    },
    steps,
    tests,
    prerequisites: prereqs,
    artifacts,
    gateOverrides,
    delivery: {
      artifactsCount: artifacts.length,
      manualTestChecklist,
    },
    costs: costSummary
      ? {
          source: costSummary.source,
          invocations: costSummary.invocations,
          totalTokens: costSummary.totalTokens,
          totalCostUsd: costSummary.totalCostUsd,
          byModel: costSummary.byModel,
          byStage: costSummary.byStage,
        }
      : null,
    assessment: {
      verified,
      notDone,
      recommendations,
    },
    builderReturnContract: builderReturnSummary,
    productionReadiness: context.productionReadiness || null,
  };
}

// ── Atomic write helper ───────────────────────────────────────────────────────

function atomicWrite(filePath, content) {
  sharedAtomicWrite(filePath, content, { encoding: 'utf8', mode: 0o600 });
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

// ── generate (main entry) ─────────────────────────────────────────────────────

/**
 * Main entry point.
 * @param {string} milestone - e.g. 'M1'
 * @param {object} opts - optional overrides for testing:
 *   opts.proofDir  - directory to read .proof.json files from
 *   opts.reportDir - directory to write reports to
 * @returns {{ mdPath, jsonPath, grade }}
 */
async function generate(milestone, opts = {}) {
  const coboltPaths = getPaths();

  // Resolve directories
  const proofDir =
    opts.proofDir ||
    (coboltPaths
      ? path.join(coboltPaths.latestBuild(), 'proofs')
      : path.join(process.cwd(), '_cobolt-output', 'latest', 'build', 'proofs'));

  const reportDir =
    opts.reportDir ||
    (coboltPaths ? coboltPaths.reports(milestone) : path.join(process.cwd(), '_cobolt-output', 'reports', milestone));

  const auditDir =
    opts.auditDir || (coboltPaths ? coboltPaths.audit() : path.join(process.cwd(), '_cobolt-output', 'audit'));

  // Read all proof files for this milestone
  const proofs = [];
  if (fs.existsSync(proofDir)) {
    const files = fs
      .readdirSync(proofDir)
      .filter((f) => f.startsWith(`${milestone}-`) && f.endsWith('.proof.json'))
      .sort();

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(proofDir, file), 'utf8');
        proofs.push(normalizeProofRecord(JSON.parse(raw)));
      } catch (err) {
        console.warn(`[cobolt-milestone-report] Warning: could not parse ${file}: ${err.message}`);
      }
    }
  }

  if (Array.isArray(CANONICAL_STEP_IDS) && CANONICAL_STEP_IDS.length > 0) {
    const allowedSteps = new Set(CANONICAL_STEP_IDS);
    for (let i = proofs.length - 1; i >= 0; i--) {
      if (!allowedSteps.has(proofs[i]?.step)) {
        proofs.splice(i, 1);
      }
    }
  }

  // B006 — synthesize 'missing' records for canonical steps that have no proof file.
  // Missing execution must count against the grade, not vanish from the denominator.
  if (CANONICAL_STEP_IDS && CANONICAL_STEP_IDS.length > 0) {
    const existingSteps = new Set(proofs.map((p) => p.step));
    for (const stepId of CANONICAL_STEP_IDS) {
      if (!existingSteps.has(stepId)) {
        proofs.push({
          step: stepId,
          status: 'missing',
          evidence: null,
          synthesized: true,
          reason: 'No proof file found — step may not have executed',
        });
      }
    }
  }

  // Sort proofs by step name for consistent ordering
  proofs.sort((a, b) => (a.step || '').localeCompare(b.step || ''));

  // Calculate grade
  const grade = calculateGrade(proofs);

  // Read gate overrides
  const gateOverrides = readGateOverrides(milestone, auditDir);
  const artifacts = collectArtifacts(proofs);
  const costSummary = readMilestoneCostSummary(milestone, opts, coboltPaths);
  const manualTestChecklist = readManualTestChecklist(milestone, reportDir, opts, costSummary);
  const builderReturnSummary = readBuilderReturnSummary(milestone, auditDir);
  const productionReadiness = readProductionReadiness(milestone);

  const context = {
    grade,
    gateOverrides,
    artifacts,
    costSummary,
    manualTestChecklist,
    builderReturnSummary,
    productionReadiness,
  };

  // Generate content
  const md = generateMarkdown(milestone, proofs, context);
  const json = generateJSON(milestone, proofs, context);

  // Write files
  ensureDir(reportDir);
  const mdPath = path.join(reportDir, 'milestone-report.md');
  const jsonPath = path.join(reportDir, 'milestone-report.json');

  atomicWrite(mdPath, md);
  atomicWrite(jsonPath, JSON.stringify(json, null, 2));

  return { mdPath, jsonPath, grade };
}

// ── generate --all ────────────────────────────────────────────────────────────

async function generateAll(opts = {}) {
  const coboltPaths = getPaths();
  const proofDir =
    opts.proofDir ||
    (coboltPaths
      ? path.join(coboltPaths.latestBuild(), 'proofs')
      : path.join(process.cwd(), '_cobolt-output', 'latest', 'build', 'proofs'));

  if (!fs.existsSync(proofDir)) {
    console.log(`[cobolt-milestone-report] No proofs directory found at: ${proofDir}`);
    return [];
  }

  // Discover all milestones from proof filenames (M1-*.proof.json → M1)
  const milestones = new Set();
  for (const f of fs.readdirSync(proofDir)) {
    const m = f.match(/^(M\d+)-/);
    if (m) milestones.add(m[1]);
  }

  const results = [];
  for (const milestone of [...milestones].sort()) {
    console.log(`[cobolt-milestone-report] Generating report for ${milestone}...`);
    const r = await generate(milestone, opts);
    results.push({ milestone, ...r });
    console.log(`  Grade: ${r.grade.letter} (${r.grade.score}%) → ${r.mdPath}`);
  }
  return results;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(
      `
CoBolt Milestone Report — generate honest report cards from step proof records

Usage:
  node tools/cobolt-milestone-report.js generate <M1>      Generate report for M1
  node tools/cobolt-milestone-report.js generate --all     Generate for all milestones
`.trim(),
    );
    process.exit(0);
  }

  if (cmd === 'generate') {
    const target = rest[0];
    if (!target) {
      console.error('[cobolt-milestone-report] Error: specify a milestone (e.g. M1) or --all');
      process.exit(1);
    }
    if (target === '--all') {
      const results = await generateAll();
      if (results.length === 0) {
        console.log('[cobolt-milestone-report] No milestone proof files found.');
      }
    } else {
      const { mdPath, jsonPath, grade } = await generate(target);
      console.log(`[cobolt-milestone-report] ${target} — Grade: ${grade.letter} (${grade.score}%)`);
      console.log(`  MD:   ${mdPath}`);
      console.log(`  JSON: ${jsonPath}`);
    }
    return;
  }

  console.error(`[cobolt-milestone-report] Unknown command: ${cmd}`);
  process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[cobolt-milestone-report] Fatal:', err.message);
    process.exit(1);
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  generate,
  _testOnly: {
    aggregateCostEntries,
    calculateGrade,
    collectArtifacts,
    generateMarkdown,
    generateJSON,
    normalizeProofStatus,
    readManualTestChecklist,
    readMilestoneCostSummary,
    readBuilderReturnSummary,
    STEP_WEIGHTS,
    GRADE_THRESHOLDS,
  },
};
