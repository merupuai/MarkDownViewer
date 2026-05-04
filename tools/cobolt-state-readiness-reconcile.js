#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { CoboltPaths } = require('../lib/cobolt-paths');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
function parseArgs(argv = process.argv.slice(2)) {
  const flags = {
    cwd: process.cwd(),
    json: false,
    apply: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd') flags.cwd = path.resolve(argv[++i] || flags.cwd);
    else if (arg === '--json') flags.json = true;
    else if (arg === '--apply') flags.apply = true;
  }
  return flags;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  atomicWrite(filePath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function writeText(filePath, value) {
  atomicWrite(filePath, value, { encoding: 'utf8', mode: 0o600 });
}

function rel(cwd, filePath) {
  return path.relative(cwd, filePath).replace(/\\/g, '/');
}

function reconcile(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const paths = new CoboltPaths(cwd);
  const latest = paths.latest();
  const statePath = path.join(cwd, 'cobolt-state.json');
  const state = readJson(statePath, {});
  const evidencePath = path.join(latest, 'production-evidence', 'release-gate.json');
  const qualityPath = path.join(latest, 'production-quality', 'release-candidate-gate.json');
  const evidence = readJson(evidencePath, null);
  const quality = readJson(qualityPath, null);

  const observed = {
    stateCompleted: state.status === 'completed' || state.completed === true,
    stateProductionReadiness: state.productionReadiness || state.metrics?.productionReadiness?.latest || null,
    stateProductionQualityScore: state.productionQualityScore || state.metrics?.productionQualityScore?.latest || null,
    qualityMilestone: quality?.milestone || null,
    stateMilestoneProductionReadiness: quality?.milestone
      ? state.metrics?.productionReadiness?.[quality.milestone] || null
      : null,
    stateMilestoneProductionQualityScore: quality?.milestone
      ? state.metrics?.productionQualityScore?.[quality.milestone] || null
      : null,
    evidencePassed: evidence?.passed === true,
    evidenceScore: evidence?.score ?? null,
    evidenceBlockers: countBlockers(evidence),
    qualityPassed: quality?.passed === true,
    qualityScore: quality?.score ?? null,
    qualityReadiness: quality?.readiness || null,
    qualityBlockers: countBlockers(quality),
  };

  const shouldBeReady =
    observed.evidencePassed &&
    Number(observed.evidenceScore) >= 90 &&
    observed.qualityPassed &&
    Number(observed.qualityScore) >= 90;

  const expectedReadiness = shouldBeReady ? observed.qualityReadiness || 'autonomous-complete' : 'incomplete';
  const drift = [];
  if (observed.stateCompleted && !shouldBeReady) {
    drift.push({
      id: 'completed-with-incomplete-production-evidence',
      message: 'State says completed while production evidence or quality gates still fail.',
    });
  }
  if (observed.stateProductionReadiness && observed.stateProductionReadiness !== expectedReadiness) {
    drift.push({
      id: 'production-readiness-mismatch',
      message: `State readiness is ${observed.stateProductionReadiness}, expected ${expectedReadiness}.`,
    });
  }
  if (
    observed.stateProductionQualityScore !== null &&
    observed.qualityScore !== null &&
    Number(observed.stateProductionQualityScore) !== Number(observed.qualityScore)
  ) {
    drift.push({
      id: 'production-quality-score-mismatch',
      message: `State score is ${observed.stateProductionQualityScore}, latest evidence score is ${observed.qualityScore}.`,
    });
  }
  if (
    observed.qualityMilestone &&
    observed.stateMilestoneProductionQualityScore !== null &&
    observed.qualityScore !== null &&
    Number(observed.stateMilestoneProductionQualityScore) !== Number(observed.qualityScore)
  ) {
    drift.push({
      id: 'milestone-production-quality-score-mismatch',
      message: `State score for ${observed.qualityMilestone} is ${observed.stateMilestoneProductionQualityScore}, latest evidence score is ${observed.qualityScore}.`,
    });
  }
  if (
    observed.qualityMilestone &&
    observed.stateMilestoneProductionReadiness !== null &&
    observed.qualityReadiness !== null &&
    observed.stateMilestoneProductionReadiness !== expectedReadiness
  ) {
    drift.push({
      id: 'milestone-production-readiness-mismatch',
      message: `State readiness for ${observed.qualityMilestone} is ${observed.stateMilestoneProductionReadiness}, expected ${expectedReadiness}.`,
    });
  }

  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    status: drift.length ? 'drift-detected' : 'aligned',
    applied: false,
    observed,
    expected: {
      milestone: observed.qualityMilestone,
      productionReadiness: expectedReadiness,
      productionQualityScore: observed.qualityScore,
      productionEvidenceScore: observed.evidenceScore,
    },
    drift,
    artifacts: {
      state: rel(cwd, statePath),
      productionEvidence: rel(cwd, evidencePath),
      productionQuality: rel(cwd, qualityPath),
    },
  };

  if (options.apply) {
    applyState(cwd, statePath, state, result);
  }

  const outDir = path.join(latest, 'production-readiness');
  writeJson(path.join(outDir, 'state-reconciliation.json'), result);
  writeText(path.join(outDir, 'state-reconciliation.md'), renderMarkdown(result));
  return result;
}

function countBlockers(gate) {
  if (!gate) return null;
  if (Array.isArray(gate.blockers)) return gate.blockers.length;
  if (Number.isFinite(Number(gate.summary?.blockerCount))) return Number(gate.summary.blockerCount);
  return 0;
}

function applyState(cwd, statePath, state, result) {
  state.metrics ||= {};
  state.metrics.productionReadiness ||= {};
  state.metrics.productionReadiness.latest = result.expected.productionReadiness;
  if (result.expected.milestone) {
    state.metrics.productionReadiness[result.expected.milestone] = result.expected.productionReadiness;
  }
  if (result.expected.productionQualityScore !== null) {
    state.metrics.productionQualityScore ||= {};
    state.metrics.productionQualityScore.latest = result.expected.productionQualityScore;
    if (result.expected.milestone) {
      state.metrics.productionQualityScore[result.expected.milestone] = result.expected.productionQualityScore;
    }
  }
  state.productionReadiness = result.expected.productionReadiness;
  state.productionQualityScore = result.expected.productionQualityScore;
  state.lastReadinessReconciliation = {
    generatedAt: result.generatedAt,
    status: result.status,
    artifact: '_cobolt-output/latest/production-readiness/state-reconciliation.json',
  };
  atomicWrite(statePath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  result.applied = true;
  result.artifacts.state = rel(cwd, statePath);
}

function renderMarkdown(result) {
  const lines = [
    '# State Readiness Reconciliation',
    '',
    `- Status: ${result.status}`,
    `- Applied: ${result.applied ? 'yes' : 'no'}`,
    `- Expected readiness: ${result.expected.productionReadiness}`,
    `- Evidence score: ${result.expected.productionEvidenceScore ?? 'missing'}`,
    `- Quality score: ${result.expected.productionQualityScore ?? 'missing'}`,
    '',
  ];

  if (result.drift.length) {
    lines.push('## Drift', '');
    for (const item of result.drift) lines.push(`- ${item.id}: ${item.message}`);
  }

  return `${lines.join('\n')}\n`;
}

function main() {
  const flags = parseArgs();
  const result = reconcile(flags);
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`State readiness reconciliation - ${result.status}`);
    for (const item of result.drift) console.log(`- ${item.id}: ${item.message}`);
  }
  return result.status === 'aligned' || flags.apply ? 0 : 1;
}

if (require.main === module) process.exit(main());

module.exports = { reconcile, parseArgs };
