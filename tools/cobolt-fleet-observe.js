#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const { readExecutionProjection } = require('../lib/cobolt-execution-ledger');
const {
  collectTokenBudget,
  eventAction,
  eventTimeMs,
  isBlockEvent,
  readRecentAuditEvents,
  summarizeGateFireRate,
} = require('../lib/cobolt-observability');

const SCHEMA_VERSION = '1';

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    command: 'observe',
    projects: [],
    json: false,
    team: process.env.COBOLT_TEAM || null,
    label: null,
    emitFile: null,
    sink: process.env.COBOLT_FLEET_TELEMETRY_SINK || null,
    telemetryOptIn: process.env.COBOLT_FLEET_TELEMETRY === '1',
    input: null,
    port: 8787,
  };
  if (argv[0] && !argv[0].startsWith('--')) {
    options.command = argv.shift();
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--project') options.projects.push(path.resolve(argv[++i] || '.'));
    else if (arg.startsWith('--project=')) options.projects.push(path.resolve(arg.slice('--project='.length)));
    else if (arg === '--team') options.team = argv[++i] || null;
    else if (arg.startsWith('--team=')) options.team = arg.slice('--team='.length);
    else if (arg === '--label') options.label = argv[++i] || null;
    else if (arg.startsWith('--label=')) options.label = arg.slice('--label='.length);
    else if (arg === '--emit-file') options.emitFile = path.resolve(argv[++i] || '');
    else if (arg.startsWith('--emit-file=')) options.emitFile = path.resolve(arg.slice('--emit-file='.length));
    else if (arg === '--sink') options.sink = argv[++i] || null;
    else if (arg.startsWith('--sink=')) options.sink = arg.slice('--sink='.length);
    else if (arg === '--opt-in') options.telemetryOptIn = true;
    else if (arg === '--input') options.input = path.resolve(argv[++i] || '');
    else if (arg.startsWith('--input=')) options.input = path.resolve(arg.slice('--input='.length));
    else if (arg === '--port') options.port = Number(argv[++i] || options.port);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else options.projects.push(path.resolve(arg));
  }
  if (options.projects.length === 0) options.projects.push(process.cwd());
  return options;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function countAuditSignals(projectRoot) {
  const events = readRecentAuditEvents({
    projectRoot,
    limit: 5000,
    perFileLines: 300,
    maxBytesPerFile: 512 * 1024,
  });
  let tokenSpend = 0;
  let haltEvents = 0;
  let gateBypassEvents = 0;
  let gateBlockEvents = 0;
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  for (const event of events) {
    const raw = event.raw || {};
    const time = eventTimeMs(raw);
    if (time != null && time < weekAgo) continue;
    const action = eventAction(raw);
    tokenSpend += Number(raw.promptTokens || raw.completionTokens || raw.totalTokens || raw.tokens || 0);
    if (action.includes('halt') || /human[-_ ]review/i.test(event.message || '')) haltEvents += 1;
    if (action.includes('bypass') || event.source === 'gate-bypass-ledger.jsonl') gateBypassEvents += 1;
    if (isBlockEvent(raw)) gateBlockEvents += 1;
  }
  return { tokenSpend, haltEvents, gateBypassEvents, gateBlockEvents, recentEvents: events.length };
}

function milestoneThroughput(projectRoot) {
  const projection = readExecutionProjection(projectRoot, 'milestones');
  const milestones = Array.isArray(projection?.milestones) ? projection.milestones : [];
  return {
    total: milestones.length,
    complete: milestones.filter((m) => m.status === 'complete').length,
    partial: milestones.filter((m) => m.status === 'partial').length,
    building: milestones.filter((m) => m.status === 'building').length,
  };
}

function projectPayload(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const audit = countAuditSignals(root);
  const tokenBudget = collectTokenBudget(root);
  const fireRate = summarizeGateFireRate({
    projectRoot: root,
    threshold: 5,
    windowHours: 24,
    perFileLines: 300,
    maxBytesPerFile: 512 * 1024,
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    projectHash: stableHash(root),
    projectLabel: options.label || null,
    team: options.team || null,
    window: '7d',
    metrics: {
      tokenSpend: audit.tokenSpend + Number(tokenBudget?.consumed || 0),
      haltEvents: audit.haltEvents,
      gateBypassEvents: audit.gateBypassEvents,
      gateBlockEvents: audit.gateBlockEvents,
      recentAuditEvents: audit.recentEvents,
      milestoneThroughput: milestoneThroughput(root),
      gateFireRateViolations: fireRate.violatingGates.length,
    },
    gateFireRate: {
      verdict: fireRate.verdict,
      threshold: fireRate.threshold,
      windowHours: fireRate.windowHours,
      violatingGates: fireRate.violatingGates.map((gate) => ({
        gate: gate.gate,
        unresolvedBlockCount: gate.unresolvedBlockCount,
        lastFireAt: gate.lastFireAt,
      })),
    },
  };
}

function observeFleet(options = {}) {
  const projects = (options.projects || [process.cwd()]).map((project) => projectPayload(project, options));
  const totals = projects.reduce(
    (acc, project) => {
      acc.tokenSpend += project.metrics.tokenSpend;
      acc.haltEvents += project.metrics.haltEvents;
      acc.gateBypassEvents += project.metrics.gateBypassEvents;
      acc.gateBlockEvents += project.metrics.gateBlockEvents;
      acc.gateFireRateViolations += project.metrics.gateFireRateViolations;
      acc.milestonesComplete += project.metrics.milestoneThroughput.complete;
      acc.milestonesTotal += project.metrics.milestoneThroughput.total;
      return acc;
    },
    {
      tokenSpend: 0,
      haltEvents: 0,
      gateBypassEvents: 0,
      gateBlockEvents: 0,
      gateFireRateViolations: 0,
      milestonesComplete: 0,
      milestonesTotal: 0,
    },
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    projectCount: projects.length,
    optInRequired: true,
    totals,
    projects,
  };
}

function emitPayload(payload, options = {}) {
  const targets = [];
  if (options.emitFile) targets.push(`file:${options.emitFile}`);
  if (options.sink) targets.push(options.sink);
  if (targets.length === 0 || !options.telemetryOptIn) {
    return { emitted: false, reason: targets.length === 0 ? 'no-sink' : 'not-opted-in', targets: [] };
  }
  const results = [];
  for (const target of targets) {
    if (target.startsWith('file:')) {
      const filePath = path.resolve(target.slice('file:'.length));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      for (const project of payload.projects) fs.appendFileSync(filePath, `${JSON.stringify(project)}\n`, 'utf8');
      results.push({ target, status: 'written', count: payload.projects.length });
    } else if (/^https?:\/\//i.test(target)) {
      postJson(target, payload);
      results.push({ target, status: 'posted' });
    } else {
      results.push({ target, status: 'skipped', reason: 'unsupported-sink' });
    }
  }
  return { emitted: true, targets: results };
}

function postJson(target, payload) {
  const url = new URL(target);
  const body = JSON.stringify(payload);
  const transport = url.protocol === 'https:' ? https : http;
  const req = transport.request(
    {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    },
    (res) => res.resume(),
  );
  req.on('error', () => {});
  req.end(body);
}

function renderText(payload, emission = null) {
  const lines = [];
  lines.push('CoBolt Fleet Observe');
  lines.push('='.repeat(60));
  lines.push(`Projects: ${payload.projectCount}`);
  lines.push(`Token spend: ${payload.totals.tokenSpend}`);
  lines.push(`Halts: ${payload.totals.haltEvents}`);
  lines.push(`Gate bypasses: ${payload.totals.gateBypassEvents}`);
  lines.push(`Gate blocks: ${payload.totals.gateBlockEvents}`);
  lines.push(`Milestones: ${payload.totals.milestonesComplete}/${payload.totals.milestonesTotal} complete`);
  if (payload.totals.gateFireRateViolations > 0) {
    lines.push(`Gate fire-rate violations: ${payload.totals.gateFireRateViolations}`);
  }
  lines.push('');
  for (const project of payload.projects) {
    lines.push(
      `- ${project.projectLabel || project.projectHash}: tokens=${project.metrics.tokenSpend}, halts=${
        project.metrics.haltEvents
      }, bypasses=${project.metrics.gateBypassEvents}, milestones=${project.metrics.milestoneThroughput.complete}/${
        project.metrics.milestoneThroughput.total
      }`,
    );
  }
  if (emission) {
    lines.push('');
    lines.push(`Telemetry emission: ${emission.emitted ? 'emitted' : `not emitted (${emission.reason})`}`);
  }
  return `${lines.join('\n')}\n`;
}

function readPayloads(input) {
  const lines = fs.existsSync(input) ? fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  return lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function serveDashboard(options) {
  const input = options.input || path.resolve(process.cwd(), '_cobolt-output', 'fleet', 'fleet-telemetry.jsonl');
  const server = http.createServer((req, res) => {
    const payloads = readPayloads(input);
    if (req.url === '/data.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ count: payloads.length, payloads }, null, 2));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(renderDashboardHtml(payloads));
  });
  server.listen(options.port, () => {
    const address = server.address();
    process.stdout.write(`Fleet dashboard listening on http://127.0.0.1:${address.port}\n`);
    process.stdout.write(`Input: ${input}\n`);
  });
}

function renderDashboardHtml(payloads) {
  const rows = payloads
    .map(
      (p) =>
        `<tr><td>${escapeHtml(p.team || '')}</td><td>${escapeHtml(p.projectLabel || p.projectHash)}</td><td>${
          p.metrics?.tokenSpend || 0
        }</td><td>${p.metrics?.haltEvents || 0}</td><td>${p.metrics?.gateBypassEvents || 0}</td><td>${
          p.metrics?.milestoneThroughput?.complete || 0
        }/${p.metrics?.milestoneThroughput?.total || 0}</td></tr>`,
    )
    .join('');
  return `<!doctype html><title>CoBolt Fleet</title><style>body{font:14px system-ui;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 8px}</style><h1>CoBolt Fleet Observe</h1><table><thead><tr><th>Team</th><th>Project</th><th>Tokens</th><th>Halts</th><th>Bypasses</th><th>Milestones</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

function printHelp() {
  process.stdout.write(`Usage:
  node tools/cobolt-fleet-observe.js observe [--project <path>] [--json]
  node tools/cobolt-fleet-observe.js observe --opt-in --emit-file <telemetry.jsonl>
  node tools/cobolt-fleet-observe.js serve --input <telemetry.jsonl> [--port 8787]

Fleet telemetry is opt-in. No sink is written unless --opt-in or
COBOLT_FLEET_TELEMETRY=1 is set.
`);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  if (options.command === 'serve') {
    serveDashboard(options);
    return null;
  }
  if (options.command !== 'observe') {
    throw new Error(`Unknown command: ${options.command}`);
  }
  const payload = observeFleet(options);
  const emission = emitPayload(payload, options);
  if (options.json) process.stdout.write(`${JSON.stringify({ ...payload, emission }, null, 2)}\n`);
  else process.stdout.write(renderText(payload, emission));
  return 0;
}

if (require.main === module) {
  try {
    const code = main();
    if (typeof code === 'number') process.exit(code);
  } catch (err) {
    process.stderr.write(`cobolt-fleet-observe: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  emitPayload,
  main,
  observeFleet,
  parseArgs,
  projectPayload,
  renderText,
  stableHash,
};
