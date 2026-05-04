#!/usr/bin/env node

// CoBolt MTTR Probe (v0.44.0).
//
// Orchestrates chaos scenarios declared in the operate-feedback contract and
// measures time-to-recovery against declared SLOs. Framework + contract only:
// the actual fault injection and recovery observation run through adapter
// modules (tools/adapters/*.js) which ship as reference implementations in
// v0.44.0 and as first-party plugin packages in v0.44.x.
//
// Input contract: _cobolt-output/latest/planning/operate-feedback.json
//   {
//     "mttrScenarios": [
//       { "id": "db-primary-down", "action": "kill-process:postgres-primary",
//         "observe": "health-endpoint:/healthz",
//         "recoveredWhen": { "httpStatus": 200, "bodyJsonPath": "$.db.healthy", "equals": true },
//         "sloMinutes": 5 }
//     ],
//     "adapter": "local-docker"   // resolves to tools/adapters/<adapter>.js
//   }
//
// Output: _cobolt-output/latest/operate/{M}-mttr-verdict.json
//
// Commands:
//   run   [--milestone M1]  [--scenario <id>] [--adapter <name>] [--json]
//   help
//
// Exit codes: 0 all scenarios recovered within SLO, 1 at least one breached,
// 2 missing optional dep (adapter module), 3 missing infra
// (operate-feedback.json absent when --strict).
//
// Master kill switch: COBOLT_V12_GATES=bypass.
// Per-gate bypass:    COBOLT_MTTR_PROBE_GATE=0  (audit-logged).

const fs = require('node:fs');
const path = require('node:path');
const { logDecision } = require('../lib/cobolt-gate-audit');

const ADAPTER_DIR = path.join(__dirname, 'adapters');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help',
    root: process.cwd(),
    milestone: null,
    scenario: null,
    adapter: null,
    json: false,
    strict: false,
  };
  const start = args.command === argv[0] ? 1 : 0;
  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') args.root = argv[++i] || args.root;
    else if (arg === '--milestone' || arg === '-m') args.milestone = normalizeMilestone(argv[++i]);
    else if (arg === '--scenario') args.scenario = argv[++i];
    else if (arg === '--adapter') args.adapter = argv[++i];
    else if (arg === '--json') args.json = true;
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--help' || arg === '-h') args.command = 'help';
  }
  return args;
}

function normalizeMilestone(value) {
  const match = String(value || '')
    .trim()
    .match(/^M?(\d+)$/i);
  return match ? `M${Number.parseInt(match[1], 10)}` : null;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function operateFeedbackPath(projectRoot) {
  return path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'operate-feedback.json');
}

function verdictPath(projectRoot, milestone) {
  const file = milestone ? `${milestone}-mttr-verdict.json` : 'mttr-verdict.json';
  return path.join(projectRoot, '_cobolt-output', 'latest', 'operate', file);
}

function loadAdapter(adapterName) {
  const candidate = path.join(ADAPTER_DIR, `${adapterName}.js`);
  if (!fs.existsSync(candidate)) {
    return { ok: false, reason: `adapter module not shipped in v0.44.0: ${adapterName}`, adapterNotShipped: true };
  }
  try {
    const mod = require(candidate);
    if (
      !mod ||
      typeof mod.inject !== 'function' ||
      typeof mod.observe !== 'function' ||
      typeof mod.restore !== 'function'
    ) {
      return { ok: false, reason: `adapter ${adapterName} does not export inject/observe/restore` };
    }
    return { ok: true, adapter: mod };
  } catch (e) {
    return { ok: false, reason: `adapter ${adapterName} load failed: ${e.message}` };
  }
}

async function runScenario(adapter, scenario) {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  let fault;
  try {
    fault = await adapter.inject(scenario);
  } catch (e) {
    return {
      scenarioId: scenario.id,
      outcome: 'inject-failed',
      reason: e.message,
      startedAt,
      elapsedMinutes: null,
      sloMinutes: scenario.sloMinutes,
      breached: true,
    };
  }
  try {
    const result = await adapter.observe(scenario, { timeoutMs: (scenario.sloMinutes || 30) * 60 * 1000 + 60000 });
    const elapsedMinutes = (Date.now() - startMs) / (1000 * 60);
    const recovered = result?.recovered === true;
    // Breached when either: recovery time exceeded SLO, OR the system did not
    // recover at all. A stub adapter that reports `recovered: false` counts
    // as a breach — surfacing "adapter-not-shipped" to the gate verdict
    // rather than silently passing when nothing actually ran.
    const breached = !recovered || elapsedMinutes > scenario.sloMinutes;
    const verdict = {
      scenarioId: scenario.id,
      outcome: recovered ? (elapsedMinutes > scenario.sloMinutes ? 'recovered-late' : 'recovered') : 'not-recovered',
      startedAt,
      endedAt: new Date().toISOString(),
      elapsedMinutes: Number(elapsedMinutes.toFixed(2)),
      sloMinutes: scenario.sloMinutes,
      breached,
      observationDetail: result?.detail || null,
      faultDetail: fault?.detail || null,
      adapterNotImplemented: fault?.notImplemented === true,
    };
    return verdict;
  } finally {
    try {
      await adapter.restore(scenario, fault);
    } catch {
      // restore failures are advisory — scenario verdict still holds
    }
  }
}

async function cmdRun(args) {
  const feedback = readJson(operateFeedbackPath(args.root));
  if (!feedback) {
    return {
      ok: false,
      reason: 'operate-feedback-missing',
      missingInfra: args.strict,
      remediation: 'Author _cobolt-output/latest/planning/operate-feedback.json with mttrScenarios[] and adapter.',
    };
  }
  const scenarios = Array.isArray(feedback.mttrScenarios) ? feedback.mttrScenarios : [];
  if (scenarios.length === 0) {
    return { ok: true, reason: 'no-scenarios-declared', verdicts: [], advisory: true };
  }
  const filtered = args.scenario ? scenarios.filter((s) => s.id === args.scenario) : scenarios;
  if (filtered.length === 0) {
    return { ok: false, reason: 'scenario-not-found', scenarioRequested: args.scenario };
  }
  const adapterName = args.adapter || feedback.adapter || 'local-docker';
  const adapterLoad = loadAdapter(adapterName);
  if (!adapterLoad.ok) {
    return {
      ok: false,
      reason: adapterLoad.adapterNotShipped ? 'adapter-not-shipped' : 'adapter-load-failed',
      adapterNotShipped: adapterLoad.adapterNotShipped === true,
      detail: adapterLoad.reason,
      remediation:
        'Ship an adapter at tools/adapters/<name>.js exporting inject/observe/restore, OR reference a first-party plugin via customPath.',
    };
  }

  const verdicts = [];
  for (const scenario of filtered) {
    verdicts.push(await runScenario(adapterLoad.adapter, scenario));
  }
  const breached = verdicts.filter((v) => v.breached).length;
  const passed = breached === 0;
  const payload = {
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-mttr-probe',
    milestone: args.milestone,
    adapter: adapterName,
    scenariosRun: verdicts.length,
    breached,
    passed,
    verdicts,
  };
  writeJson(verdictPath(args.root, args.milestone), payload);
  return {
    ok: passed,
    reason: passed ? 'all-scenarios-within-slo' : 'mttr-slo-breached',
    verdictPath: verdictPath(args.root, args.milestone),
    ...payload,
  };
}

async function run(args = parseArgs()) {
  const v12 = String(process.env.COBOLT_V12_GATES || '').toLowerCase();
  if (v12 === 'bypass' || v12 === 'off') {
    logDecision(args.root || process.cwd(), { gate: 'cobolt-mttr-probe', decision: 'bypass', env: 'COBOLT_V12_GATES' });
    return { ok: true, bypassed: 'COBOLT_V12_GATES', reason: 'master-bypass', verdicts: [] };
  }
  if (process.env.COBOLT_MTTR_PROBE_GATE === '0') {
    logDecision(args.root || process.cwd(), {
      gate: 'cobolt-mttr-probe',
      decision: 'bypass',
      env: 'COBOLT_MTTR_PROBE_GATE',
    });
    return { ok: true, bypassed: 'COBOLT_MTTR_PROBE_GATE', reason: 'per-gate-bypass', verdicts: [] };
  }
  if (args.command === 'help') {
    return {
      ok: true,
      usage: 'node tools/cobolt-mttr-probe.js run [--milestone M1] [--scenario <id>] [--adapter <name>] [--json]',
    };
  }
  if (args.command === 'run') return cmdRun(args);
  return { ok: false, reason: 'unknown-command', command: args.command };
}

if (require.main === module) {
  (async () => {
    const args = parseArgs();
    const result = await run(args);
    if (args.json || result.usage) console.log(JSON.stringify(result, null, 2));
    else if (!result.ok) console.error(result.reason || 'mttr-probe failed');
    let exit = 0;
    if (!result.ok) {
      if (result.adapterNotShipped) exit = 2;
      else if (result.missingInfra) exit = 3;
      else exit = 1;
    }
    process.exit(exit);
  })();
}

module.exports = {
  cmdRun,
  loadAdapter,
  operateFeedbackPath,
  parseArgs,
  run,
  runScenario,
  verdictPath,
};
