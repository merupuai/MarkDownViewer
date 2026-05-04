#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  ARTIFACTS,
  SCHEMA_VERSION,
  artifactPath,
  finding,
  parseArgs,
  printJsonOrHuman,
  resolvePlanningDir,
  resolveProjectRoot,
  writeJson,
} = require('../lib/cobolt-planning-vnext');

const TOOL_ID = 'cobolt-planning-replay-calibration';

function loadAgentReplay(projectRoot) {
  const toolPath = path.join(projectRoot, 'tools', 'cobolt-agent-replay.js');
  if (!fs.existsSync(toolPath)) return null;
  try {
    const replay = require(toolPath);
    if (
      typeof replay.summarise !== 'function' ||
      typeof replay.driftReport !== 'function' ||
      typeof replay.storageReport !== 'function'
    ) {
      return null;
    }
    return replay;
  } catch {
    return null;
  }
}

function buildPlanningReplayCalibration(options = {}) {
  const projectRoot = resolveProjectRoot(options);
  const planningDir = resolvePlanningDir(projectRoot, { create: options.write !== false });
  const replay = loadAgentReplay(projectRoot);
  const findings = [];

  let summary = {
    dispatches: 0,
    success: 0,
    failure: 0,
    successRate: null,
    driftCount: 0,
    storageWithinBudget: true,
  };
  let drift = { threshold: 0.85, totalGroups: 0, drifts: [] };
  let storage = { sizeBytes: 0, sizeMb: 0, withinBudget: true };

  if (!replay) {
    findings.push(
      finding(
        'REPLAY-TOOL-MISSING',
        options.strict ? 'critical' : 'advisory',
        'agent replay harness is missing or unloadable',
        {
          tool: 'tools/cobolt-agent-replay.js',
        },
      ),
    );
  } else {
    const since = options.since || process.env.COBOLT_PLAN_REPLAY_SINCE || null;
    const threshold = Number(options.threshold || process.env.COBOLT_PLAN_REPLAY_THRESHOLD || 0.85);
    const replaySummary = replay.summarise({ projectRoot, since });
    drift = replay.driftReport({ projectRoot, threshold, since });
    storage = replay.storageReport({ projectRoot });
    summary = {
      dispatches: replaySummary.dispatches,
      success: replaySummary.success,
      failure: replaySummary.failure,
      successRate: replaySummary.successRate,
      driftCount: drift.drifts.length,
      storageWithinBudget: storage.withinBudget === true,
    };
    if (replaySummary.failure > 0) {
      findings.push(
        finding('REPLAY-FAILURES', 'advisory', 'agent replay ledger contains failed dispatches', {
          failure: replaySummary.failure,
        }),
      );
    }
    if (drift.drifts.length > 0) {
      findings.push(
        finding(
          'REPLAY-DRIFT',
          options.strict ? 'critical' : 'advisory',
          'agent replay drift is below calibration threshold',
          {
            threshold,
            driftCount: drift.drifts.length,
          },
        ),
      );
    }
    if (storage.withinBudget === false) {
      findings.push(
        finding('REPLAY-STORAGE-BUDGET', 'advisory', 'agent replay ledger exceeds storage budget', storage),
      );
    }
  }

  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy: TOOL_ID,
    projectRoot,
    planningDir,
    summary: {
      ...summary,
      status: findings.some((item) => item.severity === 'critical') ? 'blocked' : findings.length ? 'advisory' : 'pass',
    },
    drift,
    storage,
    findings,
  };

  if (options.write !== false)
    writeJson(artifactPath(projectRoot, ARTIFACTS.replayCalibration, { planningDir }), report);
  return report;
}

function checkPlanningReplayCalibration(options = {}) {
  const report = buildPlanningReplayCalibration(options);
  return {
    ...report,
    passed: options.strict ? !report.findings.length : !report.findings.some((item) => item.severity === 'critical'),
  };
}

function render(report) {
  return `planning-replay-calibration: ${report.summary.status}; dispatches=${report.summary.dispatches} drifts=${report.summary.driftCount}`;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'help') {
    process.stdout.write(
      'usage: cobolt-planning-replay-calibration generate|check [--project <dir>] [--json] [--strict]\n',
    );
    return 0;
  }
  const report =
    options.command === 'check' ? checkPlanningReplayCalibration(options) : buildPlanningReplayCalibration(options);
  printJsonOrHuman(report, options.json, render);
  if (options.command === 'check' && report.passed === false) return 1;
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  TOOL_ID,
  buildPlanningReplayCalibration,
  checkPlanningReplayCalibration,
  main,
};
