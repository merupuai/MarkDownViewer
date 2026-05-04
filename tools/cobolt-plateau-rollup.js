#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { CoboltPaths } = require('../lib/cobolt-paths');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
function parseArgs(argv = process.argv.slice(2)) {
  const flags = {
    cwd: process.cwd(),
    json: false,
    resolve: false,
    reason: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd') flags.cwd = path.resolve(argv[++i] || flags.cwd);
    else if (arg === '--json') flags.json = true;
    else if (arg === '--resolve') flags.resolve = true;
    else if (arg === '--reason') flags.reason = argv[++i] || null;
  }
  return flags;
}

function readJsonLines(filePath) {
  try {
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
  } catch {
    return [];
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

function rollup(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const paths = new CoboltPaths(cwd);
  const latest = paths.latest();
  const logPath = paths.productionReadinessLog();
  if (options.resolve) {
    appendResolution(logPath, options.reason || 'Plateau resolved by production-readiness stabilization evidence.');
  }
  const events = readJsonLines(logPath);
  const plateauEvents = events.filter((event) => isPlateauEvent(event));
  const resolvedEvents = events.filter((event) => isResolutionEvent(event));
  const byMilestone = {};
  const byMetric = {};
  const byDay = {};
  let latestEvent = null;

  for (const event of plateauEvents) {
    const milestone = String(event.milestone || event.currentMilestone || 'unknown');
    const metric = String(event.metric || event.name || 'fixLoopPlateaus');
    const day = String(event.timestamp || event.generatedAt || '').slice(0, 10) || 'unknown';
    byMilestone[milestone] = (byMilestone[milestone] || 0) + 1;
    byMetric[metric] = (byMetric[metric] || 0) + 1;
    byDay[day] = (byDay[day] || 0) + 1;
    if (!latestEvent || eventTime(event) > eventTime(latestEvent)) latestEvent = event;
  }

  const latestResolutionTime = resolvedEvents.reduce((max, event) => Math.max(max, eventTime(event)), 0);
  const latestPlateauTime = latestEvent ? eventTime(latestEvent) : 0;
  const unresolved = plateauEvents.length > 0 && latestPlateauTime > latestResolutionTime;

  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    status: unresolved ? 'unresolved-plateaus' : 'clear',
    source: rel(cwd, logPath),
    totalEvents: events.length,
    plateauEvents: plateauEvents.length,
    resolutionEvents: resolvedEvents.length,
    unresolved,
    resolutionWritten: Boolean(options.resolve),
    latestPlateau: latestEvent || null,
    counts: { byMilestone, byMetric, byDay },
    escalation: unresolved
      ? {
          leadAgent: 'review-lead',
          advisorRequired: plateauEvents.length >= 3,
          context:
            'Repeated plateau events indicate the fix loop is cycling without new evidence or a narrower root cause.',
        }
      : null,
  };

  const outDir = path.join(latest, 'production-readiness');
  writeJson(path.join(outDir, 'plateau-rollup.json'), result);
  writeText(path.join(outDir, 'plateau-rollup.md'), renderMarkdown(result));
  if (options.resolve && !result.unresolved) clearStatePlateauMetric(cwd);
  return result;
}

function appendResolution(logPath, reason) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const event = {
    ts: new Date().toISOString(),
    kind: 'plateau-resolved',
    metric: 'fixLoopPlateaus',
    reason,
  };
  fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function isPlateauEvent(event) {
  const haystack = JSON.stringify(event).toLowerCase();
  return haystack.includes('fixloopplateaus') || haystack.includes('plateau');
}

function isResolutionEvent(event) {
  const haystack = JSON.stringify(event).toLowerCase();
  return haystack.includes('plateau-resolved') || haystack.includes('plateau_resolved');
}

function eventTime(event) {
  const value = event.ts || event.timestamp || event.generatedAt || event.time || event.createdAt;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clearStatePlateauMetric(cwd) {
  const statePath = path.join(cwd, 'cobolt-state.json');
  const state = readJson(statePath);
  if (!state || typeof state !== 'object') return;
  state.metrics ||= {};
  state.metrics.fixLoopPlateaus = 0;
  state.lastPlateauResolution = {
    generatedAt: new Date().toISOString(),
    artifact: '_cobolt-output/latest/production-readiness/plateau-rollup.json',
  };
  atomicWrite(statePath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function renderMarkdown(result) {
  const lines = [
    '# Fix Loop Plateau Rollup',
    '',
    `- Status: ${result.status}`,
    `- Plateau events: ${result.plateauEvents}`,
    `- Resolution events: ${result.resolutionEvents}`,
    `- Unresolved: ${result.unresolved ? 'yes' : 'no'}`,
    `- Resolution written: ${result.resolutionWritten ? 'yes' : 'no'}`,
    '',
  ];
  if (result.escalation) {
    lines.push('## Escalation', '');
    lines.push(`- Lead agent: ${result.escalation.leadAgent}`);
    lines.push(`- Advisor required: ${result.escalation.advisorRequired ? 'yes' : 'no'}`);
    lines.push(`- Context: ${result.escalation.context}`);
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const flags = parseArgs();
  const result = rollup(flags);
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Plateau rollup - ${result.status}`);
    if (result.escalation) console.log(`Escalate to ${result.escalation.leadAgent}`);
  }
  return result.unresolved ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { rollup, parseArgs };
