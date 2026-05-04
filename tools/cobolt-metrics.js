#!/usr/bin/env node

// CoBolt Metrics CLI — pipeline metrics aggregation and display
//
// Reads metrics from cobolt-state.json, escalation logs, and stage outputs.
//
// Usage:
//   node tools/cobolt-metrics.js show                  # Show all metrics
//   node tools/cobolt-metrics.js pipeline              # Pipeline-specific metrics
//   node tools/cobolt-metrics.js agents                 # Agent performance metrics
//   node tools/cobolt-metrics.js quality                # Quality gate metrics
//   node tools/cobolt-metrics.js record <key> <value>   # Record a metric
//   node tools/cobolt-metrics.js export                 # Export as JSON

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJSON } = require('../lib/cobolt-atomic-write');
const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

function metricsFile() {
  const _p = typeof _paths === 'function' ? _paths() : null;
  return _p ? _p.metricsFile() : path.join(process.cwd(), '_cobolt-output/metrics.json');
}

function readMetrics() {
  const fp = metricsFile();
  if (!fs.existsSync(fp)) {
    return {
      pipeline: { stages: {}, totalRuns: 0, totalDurationMs: 0 },
      agents: {},
      quality: { gateRuns: 0, gatePassRate: 0 },
      custom: {},
      lastUpdated: null,
    };
  }
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function writeMetrics(metrics) {
  const fp = metricsFile();
  metrics.lastUpdated = new Date().toISOString();
  // Atomic write: temp file + rename prevents corruption on crash
  try {
    atomicWriteJSON(fp, metrics, { mode: 0o600 });
  } catch (err) {
    console.error(`[cobolt-metrics] Error writing metrics: ${err.message}`);
    throw err;
  }
}

// ── Commands ─────────────────────────────────────────────────

function evalsRollup() {
  // Read-only adapter for the evals history rollup. Non-breaking:
  // returns null when history is absent.
  try {
    const _p = typeof _paths === 'function' ? _paths() : null;
    if (!_p) return null;
    const rollupPath = path.join(_p.outputRoot, 'evals', 'history', 'score-history.json');
    if (!fs.existsSync(rollupPath)) return null;
    const rollup = JSON.parse(fs.readFileSync(rollupPath, 'utf8'));
    return {
      latest: rollup.overall?.latest ?? null,
      movingAverage7d: rollup.overall?.movingAverage7d ?? null,
      trend: rollup.overall?.trend ?? 'unknown',
      lastUpdated: rollup.lastUpdated || null,
      agents: Object.keys(rollup.byAgent || {}).length,
      workflows: Object.keys(rollup.byWorkflow || {}).length,
    };
  } catch {
    return null;
  }
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function doraRollup() {
  try {
    const _p = typeof _paths === 'function' ? _paths() : null;
    const outputRoot = _p ? _p.outputRoot : path.join(process.cwd(), '_cobolt-output');
    const latest = readJsonIfExists(path.join(outputRoot, 'standards', 'dora-metrics.json'));
    if (latest) return latest;

    const auditPath = path.join(outputRoot, 'audit', 'dora-metrics.jsonl');
    if (!fs.existsSync(auditPath)) return null;
    const lines = fs.readFileSync(auditPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) return null;
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

function showAll() {
  const m = readMetrics();
  const evals = evalsRollup();
  if (evals) m.evals = evals;
  const dora = doraRollup();
  if (dora) m.dora = dora;
  return m;
}

function pipelineMetrics() {
  const m = readMetrics();

  // Enrich with cobolt-state.json data if available
  try {
    const stateFile = path.join(process.cwd(), 'cobolt-state.json');
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (state.pipeline) {
        m.pipeline.currentStage = state.pipeline.currentStage || state.pipeline.stage || state.currentStage;
        m.pipeline.currentMilestone = state.pipeline.currentMilestone;
      }
      if (state.resilience) {
        m.pipeline.resilience = state.resilience;
      }
      if (state.metrics) {
        m.pipeline.stateMetrics = state.metrics;
      }
    }
  } catch {}

  // Enrich with escalation log data
  try {
    const _p = typeof _paths === 'function' ? _paths() : null;
    const auditDir = _p ? _p.audit() : path.join(process.cwd(), '_cobolt-output/audit');
    const escLog = path.join(auditDir, 'escalation-log.jsonl');
    if (fs.existsSync(escLog)) {
      const lines = fs.readFileSync(escLog, 'utf8').trim().split('\n').filter(Boolean);
      m.pipeline.escalations = {
        total: lines.length,
        recent: lines
          .slice(-5)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter(Boolean),
      };
    }
  } catch {}

  const dora = doraRollup();
  if (dora) {
    m.pipeline.dora = {
      computedAt: dora.computedAt,
      windowDays: dora.windowDays,
      overallRating: dora.overallRating,
      deploymentFrequency: dora.deploymentFrequency,
      leadTimeForChanges: dora.leadTimeForChanges,
      changeFailureRate: dora.changeFailureRate,
      meanTimeToRestore: dora.meanTimeToRestore,
    };
  }

  return m.pipeline;
}

function agentMetrics() {
  const m = readMetrics();
  return m.agents;
}

function qualityMetrics() {
  const m = readMetrics();

  // Enrich with latest toolgate report
  try {
    const _p = typeof _paths === 'function' ? _paths() : null;
    const reportDir = _p ? _p.review() : path.join(process.cwd(), '_cobolt-output/latest/review');
    const gatePath = path.join(reportDir, 'toolgate-report.json');
    if (fs.existsSync(gatePath)) {
      const gate = JSON.parse(fs.readFileSync(gatePath, 'utf8'));
      m.quality.latestGate = {
        timestamp: gate.timestamp,
        tools: gate.tools,
        passed: gate.passed,
        failed: gate.failed,
        totalErrors: gate.totalErrors,
      };
    }
  } catch {}

  return m.quality;
}

function recordMetric(key, value) {
  const m = readMetrics();
  const keys = key.split('.');
  let target = m.custom;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!target[keys[i]]) target[keys[i]] = {};
    target = target[keys[i]];
  }
  try {
    target[keys[keys.length - 1]] = JSON.parse(value);
  } catch {
    target[keys[keys.length - 1]] = value;
  }
  writeMetrics(m);
  console.log(`  Recorded: ${key} = ${value}`);
}

function recordStageDuration(stage, durationMs) {
  const m = readMetrics();
  if (!m.pipeline.stages[stage]) m.pipeline.stages[stage] = { runs: 0, totalMs: 0, avgMs: 0 };
  const s = m.pipeline.stages[stage];
  s.runs++;
  s.totalMs += durationMs;
  s.avgMs = Math.round(s.totalMs / s.runs);
  s.lastRun = new Date().toISOString();
  m.pipeline.totalRuns++;
  m.pipeline.totalDurationMs += durationMs;
  writeMetrics(m);
}

function recordAgentExecution(agentName, durationMs, success) {
  const m = readMetrics();
  if (!m.agents[agentName]) m.agents[agentName] = { runs: 0, successes: 0, failures: 0, totalMs: 0 };
  const a = m.agents[agentName];
  a.runs++;
  a.totalMs += durationMs;
  if (success) a.successes++;
  else a.failures++;
  a.avgMs = Math.round(a.totalMs / a.runs);
  a.successRate = Math.round((a.successes / a.runs) * 100);
  writeMetrics(m);
}

// ── Module exports ───────────────────────────────────────────

module.exports = {
  showAll,
  pipelineMetrics,
  agentMetrics,
  qualityMetrics,
  recordMetric,
  recordStageDuration,
  recordAgentExecution,
  readMetrics,
  writeMetrics,
  evalsRollup,
  doraRollup,
};

// ── CLI ──────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('  Usage: node tools/cobolt-metrics.js <command> [args]');
    console.log('  Commands: show, pipeline, agents, quality, record, export');
    process.exit(0);
  }

  switch (cmd) {
    case 'show':
      console.log(JSON.stringify(showAll(), null, 2));
      break;
    case 'pipeline':
      console.log(JSON.stringify(pipelineMetrics(), null, 2));
      break;
    case 'agents':
      console.log(JSON.stringify(agentMetrics(), null, 2));
      break;
    case 'quality':
      console.log(JSON.stringify(qualityMetrics(), null, 2));
      break;
    case 'record': {
      if (!args[1] || !args[2]) {
        console.error('  Usage: record <key> <value>');
        process.exit(1);
      }
      recordMetric(args[1], args[2]);
      break;
    }
    case 'export':
      console.log(JSON.stringify(showAll(), null, 2));
      break;
    default:
      console.error(`  Unknown command: ${cmd}`);
      process.exit(1);
  }
}
