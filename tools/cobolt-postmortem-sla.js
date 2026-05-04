#!/usr/bin/env node

// CoBolt Postmortem SLA (v0.44.0).
//
// Enforces "every P0/P1 incident has a postmortem within N hours". The SLA
// window is configurable per project at _cobolt-output/latest/planning/
// postmortem-sla.json (fallback defaults declared below).
//
// Data model: postmortems are incidents recorded in the change-register
// (type=incident-open) that have not yet been closed (type=postmortem-close
// with matching ref). The SLA window is measured from incident-open until
// postmortem-close. A postmortem-open entry ACKs that the team is working on
// it but does NOT satisfy the SLA by itself — only postmortem-close does.
//
// Commands:
//   audit [--root <project>] [--json]       — list overdue postmortems
//   config get|set severity.{P0,P1}.hours   — adjust SLA window
//   help
//
// Exit codes: 0 all postmortems within SLA, 1 at least one overdue.
//
// Master kill switch: COBOLT_V12_GATES=bypass.
// Per-gate bypass:    COBOLT_POSTMORTEM_SLA_GATE=0  (audit-logged).

const fs = require('node:fs');
const path = require('node:path');
const { logDecision } = require('../lib/cobolt-gate-audit');
const changeRegister = require('./cobolt-change-register');

const DEFAULT_SLA_HOURS = Object.freeze({
  P0: 48,
  P1: 120,
  P2: 336, // two weeks
  P3: 0, // no SLA
});

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help',
    subcommand: argv[1] && !argv[1].startsWith('-') ? argv[1] : null,
    key: argv[2] && !argv[2].startsWith('-') ? argv[2] : null,
    value: argv[3] && !argv[3].startsWith('-') ? argv[3] : null,
    root: process.cwd(),
    json: false,
  };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--root') args.root = argv[++i] || args.root;
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.command = 'help';
  }
  return args;
}

function configPath(projectRoot) {
  return path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'postmortem-sla.json');
}

function readConfig(projectRoot) {
  try {
    return JSON.parse(fs.readFileSync(configPath(projectRoot), 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function writeConfig(projectRoot, payload) {
  const target = configPath(projectRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function slaWindowFor(config, severity) {
  if (config?.severity?.[severity]?.hours != null) return config.severity[severity].hours;
  return DEFAULT_SLA_HOURS[severity] ?? 0;
}

function hoursBetween(startIso, endIso) {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso || new Date().toISOString());
  if (Number.isNaN(start) || Number.isNaN(end)) return Infinity;
  return (end - start) / (1000 * 60 * 60);
}

function buildOpenPostmortems(projectRoot) {
  const records = changeRegister.readRegister(projectRoot);
  // Each incident-open carries: { ref, severity:"P0"|"P1"|"P2"|"P3", ...}
  // Postmortem-close carries: { ref, ... }  matching the incident ref.
  const closedRefs = new Set(records.filter((r) => r.type === 'postmortem-close' && r.ref).map((r) => String(r.ref)));
  return records
    .filter((r) => r.type === 'incident-open' && r.ref)
    .filter((r) => !closedRefs.has(String(r.ref)))
    .map((r) => {
      // Severity: prefer explicit severity field, otherwise parse from note.
      const severity =
        r.severity ||
        (typeof r.note === 'string' ? (r.note.match(/\bP[0-3]\b/i)?.[0] || '').toUpperCase() : '') ||
        'P2';
      return {
        ref: String(r.ref),
        openedAt: r.at,
        owner: r.owner || null,
        severity,
        note: r.note || null,
        hoursOpen: hoursBetween(r.at),
      };
    });
}

function cmdAudit(args) {
  const config = readConfig(args.root);
  const openPostmortems = buildOpenPostmortems(args.root);
  const overdue = [];
  const withinSla = [];
  for (const pm of openPostmortems) {
    const sla = slaWindowFor(config, pm.severity);
    if (sla > 0 && pm.hoursOpen > sla) {
      overdue.push({ ...pm, slaHours: sla, overdueByHours: pm.hoursOpen - sla });
    } else {
      withinSla.push({ ...pm, slaHours: sla });
    }
  }
  return {
    ok: overdue.length === 0,
    reason: overdue.length === 0 ? 'all-within-sla' : 'postmortems-overdue',
    configSource: config ? 'project' : 'defaults',
    sla: config?.severity || DEFAULT_SLA_HOURS,
    open: openPostmortems.length,
    overdue,
    withinSla,
  };
}

function cmdConfigGet(args) {
  const config = readConfig(args.root);
  return {
    ok: true,
    reason: 'ok',
    source: config ? 'project' : 'defaults',
    severity: config?.severity || DEFAULT_SLA_HOURS,
  };
}

function cmdConfigSet(args) {
  if (!args.key || !args.value) {
    return { ok: false, reason: 'set-requires-key-value', example: 'config set severity.P0.hours 48' };
  }
  const parts = args.key.split('.');
  if (
    parts.length !== 3 ||
    parts[0] !== 'severity' ||
    !['P0', 'P1', 'P2', 'P3'].includes(parts[1]) ||
    parts[2] !== 'hours'
  ) {
    return { ok: false, reason: 'invalid-key', key: args.key, allowed: 'severity.{P0|P1|P2|P3}.hours' };
  }
  const hours = Number(args.value);
  if (!Number.isFinite(hours) || hours < 0) return { ok: false, reason: 'invalid-hours', value: args.value };

  const existing = readConfig(args.root) || { severity: { ...DEFAULT_SLA_HOURS } };
  if (!existing.severity) existing.severity = { ...DEFAULT_SLA_HOURS };
  existing.severity[parts[1]] = { hours };
  writeConfig(args.root, existing);
  return { ok: true, reason: 'set', severity: existing.severity, configPath: configPath(args.root) };
}

function run(args = parseArgs()) {
  const v12 = String(process.env.COBOLT_V12_GATES || '').toLowerCase();
  if (v12 === 'bypass' || v12 === 'off') {
    logDecision(args.root || process.cwd(), {
      gate: 'cobolt-postmortem-sla',
      decision: 'bypass',
      env: 'COBOLT_V12_GATES',
    });
    return { ok: true, bypassed: 'COBOLT_V12_GATES', reason: 'master-bypass', overdue: [] };
  }
  if (process.env.COBOLT_POSTMORTEM_SLA_GATE === '0') {
    logDecision(args.root || process.cwd(), {
      gate: 'cobolt-postmortem-sla',
      decision: 'bypass',
      env: 'COBOLT_POSTMORTEM_SLA_GATE',
    });
    return { ok: true, bypassed: 'COBOLT_POSTMORTEM_SLA_GATE', reason: 'per-gate-bypass', overdue: [] };
  }
  if (args.command === 'help') {
    return {
      ok: true,
      usage: [
        'node tools/cobolt-postmortem-sla.js audit [--json]',
        'node tools/cobolt-postmortem-sla.js config get',
        'node tools/cobolt-postmortem-sla.js config set severity.<P0|P1|P2|P3>.hours <N>',
      ].join('\n'),
    };
  }
  if (args.command === 'audit') return cmdAudit(args);
  if (args.command === 'config') {
    if (args.subcommand === 'get') return cmdConfigGet(args);
    if (args.subcommand === 'set') return cmdConfigSet(args);
    return { ok: false, reason: 'config-requires-get-or-set' };
  }
  return { ok: false, reason: 'unknown-command', command: args.command };
}

if (require.main === module) {
  const args = parseArgs();
  const result = run(args);
  if (args.json || result.usage) console.log(JSON.stringify(result, null, 2));
  else if (!result.ok) console.error(result.reason || 'postmortem-sla failed');
  process.exit(result.ok ? 0 : 1);
}

module.exports = {
  DEFAULT_SLA_HOURS,
  buildOpenPostmortems,
  cmdAudit,
  cmdConfigGet,
  cmdConfigSet,
  configPath,
  hoursBetween,
  parseArgs,
  readConfig,
  run,
  slaWindowFor,
  writeConfig,
};
