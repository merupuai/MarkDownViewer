#!/usr/bin/env node

// CoBolt Stop-the-Line - threshold-based pause/escalation signals.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_POLICY = {
  version: '1.0.0',
  thresholds: {
    maxFixLoopsPerFinding: 3,
    maxStageTokens: 250000,
    maxPlanningTokens: 250000,
    maxUiFixTokens: 100000,
    maxPrConflictsPerMilestone: 2,
    maxRepeatedReviewerFinding: 2,
  },
  hardStopSignals: [
    'fix-loop-threshold',
    'planning-token-threshold',
    'pr-conflict-threshold',
    'repeated-finding-threshold',
  ],
  softStopSignals: ['stage-token-threshold', 'ui-fix-token-threshold'],
};

function readJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function loadPolicy(projectRoot = process.cwd(), explicitPath = null) {
  const candidates = [
    explicitPath,
    path.join(projectRoot, 'cobolt.stop-line.json'),
    path.join(projectRoot, 'source', 'templates', 'stop-line-policy.json'),
    path.join(__dirname, '..', 'source', 'templates', 'stop-line-policy.json'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const parsed = readJson(candidate);
    if (parsed?.thresholds) return { path: candidate, policy: parsed };
  }
  return { path: null, policy: DEFAULT_POLICY };
}

function tokenTotal(entry) {
  return (
    Number(entry.tokens || 0) +
    Number(entry.input_tokens || 0) +
    Number(entry.output_tokens || 0) +
    Number(entry.cache_read_tokens || 0) +
    Number(entry.cache_write_tokens || 0)
  );
}

function evaluateStopLineSignals(events = {}, policy = DEFAULT_POLICY) {
  const thresholds = { ...DEFAULT_POLICY.thresholds, ...(policy.thresholds || {}) };
  const signals = [];
  const hardStopIds = new Set(policy.hardStopSignals || DEFAULT_POLICY.hardStopSignals);

  for (const [findingId, count] of Object.entries(events.fixLoopsByFinding || {})) {
    if (Number(count) >= thresholds.maxFixLoopsPerFinding) {
      signals.push({
        id: 'fix-loop-threshold',
        severity: 'hard',
        message: `${findingId} has ${count} fix loop(s), threshold is ${thresholds.maxFixLoopsPerFinding}.`,
      });
    }
  }

  const stageTokens = {};
  for (const entry of events.costEntries || []) {
    const stage = String(entry.stage || 'unknown').toLowerCase();
    stageTokens[stage] = (stageTokens[stage] || 0) + tokenTotal(entry);
  }

  for (const [stage, total] of Object.entries(stageTokens)) {
    if (stage === 'planning' && total >= thresholds.maxPlanningTokens) {
      signals.push({
        id: 'planning-token-threshold',
        severity: hardStopIds.has('planning-token-threshold') ? 'hard' : 'soft',
        message: `Planning used ${total} tokens, threshold is ${thresholds.maxPlanningTokens}.`,
      });
    } else if (stage.includes('fix') && stage.includes('ui') && total >= thresholds.maxUiFixTokens) {
      signals.push({
        id: 'ui-fix-token-threshold',
        severity: hardStopIds.has('ui-fix-token-threshold') ? 'hard' : 'soft',
        message: `UI fix work used ${total} tokens, threshold is ${thresholds.maxUiFixTokens}.`,
      });
    } else if (total >= thresholds.maxStageTokens) {
      signals.push({
        id: 'stage-token-threshold',
        severity: hardStopIds.has('stage-token-threshold') ? 'hard' : 'soft',
        message: `${stage} used ${total} tokens, threshold is ${thresholds.maxStageTokens}.`,
      });
    }
  }

  if (Number(events.prConflicts || 0) >= thresholds.maxPrConflictsPerMilestone) {
    signals.push({
      id: 'pr-conflict-threshold',
      severity: hardStopIds.has('pr-conflict-threshold') ? 'hard' : 'soft',
      message: `${events.prConflicts} PR conflict(s), threshold is ${thresholds.maxPrConflictsPerMilestone}.`,
    });
  }

  for (const [finding, count] of Object.entries(events.repeatedFindings || {})) {
    if (Number(count) >= thresholds.maxRepeatedReviewerFinding) {
      signals.push({
        id: 'repeated-finding-threshold',
        severity: hardStopIds.has('repeated-finding-threshold') ? 'hard' : 'soft',
        message: `${finding} repeated ${count} time(s), threshold is ${thresholds.maxRepeatedReviewerFinding}.`,
      });
    }
  }

  return {
    passed: signals.every((signal) => signal.severity !== 'hard'),
    shouldStop: signals.some((signal) => signal.severity === 'hard'),
    signals,
    summary: {
      hard: signals.filter((signal) => signal.severity === 'hard').length,
      soft: signals.filter((signal) => signal.severity === 'soft').length,
    },
  };
}

function readJsonl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
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

function collectDefaultEvents(projectRoot = process.cwd()) {
  const latest = path.join(projectRoot, '_cobolt-output', 'latest');
  const costEntries = readJsonl(path.join(latest, 'costs', 'cost-ledger.jsonl'));
  const stopLineEvents = readJson(path.join(latest, 'stop-line-events.json')) || {};
  return {
    costEntries,
    ...stopLineEvents,
  };
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'check';
  const json = argv.includes('--json');
  const eventsIndex = argv.indexOf('--events');
  const policyIndex = argv.indexOf('--policy');
  if (command !== 'check') {
    console.error('Usage: node tools/cobolt-stop-line.js check [--events file.json] [--json]');
    process.exit(2);
  }

  const { policy, path: policyPath } = loadPolicy(process.cwd(), policyIndex !== -1 ? argv[policyIndex + 1] : null);
  const events = eventsIndex !== -1 ? readJson(argv[eventsIndex + 1]) || {} : collectDefaultEvents(process.cwd());
  const report = { ...evaluateStopLineSignals(events, policy), policyPath };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.passed) {
    console.log('[cobolt-stop-line] No hard stop signals.');
  } else {
    for (const signal of report.signals) console.error(`[cobolt-stop-line] ${signal.message}`);
  }

  process.exit(report.passed ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY,
  collectDefaultEvents,
  evaluateStopLineSignals,
  loadPolicy,
};
