#!/usr/bin/env node

// CoBolt NFR Preflight (v0.45.0, BUILD-05 closer).
//
// Runs BEFORE build step 06D NFR enforcement — production-track milestones
// must declare NFR budgets up-front, not discover them missing mid-build.
// Peer to tools/cobolt-nfr-enforce.js which runs AFTER milestone work to
// compare measured values against declared budgets; preflight checks the
// DECLARATION itself is complete, fresh, and traceable.
//
// Checks (for the requested milestone):
//   1. _cobolt-output/latest/planning/nfr-budgets.json exists + schema-valid
//   2. milestones[M{n}] block exists with all 4 category keys (perf, security,
//      chaos, authEdge)
//   3. Every perf target (p95/p99/minRps/maxErrorRate) carries non-empty value
//   4. Every budget maps to at least one FR / NFR / IR id in rtm.json via its
//      `appliesToRequirements[]` array. Unmapped budgets have no owner and
//      cannot be meaningfully enforced.
//   5. Budgets file generatedAt is within 90 days (stale budgets mean the
//      NFR plan has diverged from product scope)
//
// Exit codes: 0 pass, 1 issues present, 2 missing optional dep (none), 3
// missing infra (nfr-budgets.json absent when --strict).
//
// Master kill switch: COBOLT_V12_GATES=bypass.
// Per-gate bypass:    COBOLT_NFR_PREFLIGHT_GATE=0  (audit-logged).

const fs = require('node:fs');
const path = require('node:path');
const { logDecision } = require('../lib/cobolt-gate-audit');

const MAX_BUDGET_AGE_DAYS = 90;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help',
    root: process.cwd(),
    milestone: null,
    json: false,
    strict: false,
  };
  const start = args.command === argv[0] ? 1 : 0;
  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') args.root = argv[++i] || args.root;
    else if (arg === '--milestone' || arg === '-m') args.milestone = normalizeMilestone(argv[++i]);
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

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function writeJson(p, payload) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function budgetsPath(projectRoot) {
  return path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'nfr-budgets.json');
}

function verdictPath(projectRoot, milestone) {
  return path.join(projectRoot, '_cobolt-output', 'latest', 'build', milestone, `${milestone}-nfr-preflight.json`);
}

function rtmPath(projectRoot) {
  return path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'rtm.json');
}

function isoDaysAgo(iso) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / (1000 * 60 * 60 * 24);
}

function issue(id, severity, message, remediation) {
  return { id, severity, message, remediation };
}

const CATEGORY_KEYS = ['perf', 'security', 'chaos', 'authEdge'];

function validatePerfKeys(perf) {
  const missing = [];
  for (const k of ['p95LatencyMs', 'p99LatencyMs', 'minRps', 'maxErrorRate']) {
    if (perf?.[k] == null) missing.push(k);
  }
  return missing;
}

function extractRequirementIds(rtm) {
  if (!rtm?.requirements) return new Set();
  return new Set(Object.keys(rtm.requirements));
}

function collectReferenceIds(obj, bag) {
  if (!obj) return;
  if (Array.isArray(obj.appliesToRequirements)) {
    for (const id of obj.appliesToRequirements) bag.add(String(id));
  }
  if (typeof obj === 'object') {
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) {
        for (const entry of v) if (entry && typeof entry === 'object') collectReferenceIds(entry, bag);
      } else if (v && typeof v === 'object') {
        collectReferenceIds(v, bag);
      }
    }
  }
}

function evaluate({ projectRoot, milestone, strict }) {
  const root = path.resolve(projectRoot);
  const issues = [];
  const findings = [];

  if (!milestone) {
    issues.push(issue('nfr-preflight-no-milestone', 'critical', '--milestone is required', 'Pass --milestone M1'));
    return { passed: false, issues, findings };
  }

  const budgetsAbs = budgetsPath(root);
  const budgets = readJson(budgetsAbs);
  if (!budgets) {
    issues.push(
      issue(
        'nfr-preflight-budgets-missing',
        'critical',
        `nfr-budgets.json not found at ${path.relative(root, budgetsAbs)}`,
        'Author nfr-budgets.json (TRD-derived or default-template) before build Step 00.',
      ),
    );
    return { passed: false, issues, findings, missingInfra: !!strict };
  }
  findings.push(`budgets file: ${path.relative(root, budgetsAbs)}`);
  findings.push(`budgets source: ${budgets.source || '<absent>'}`);

  // Freshness
  const ageDays = isoDaysAgo(budgets.generatedAt);
  if (ageDays > MAX_BUDGET_AGE_DAYS) {
    issues.push(
      issue(
        'nfr-preflight-budgets-stale',
        'high',
        `nfr-budgets.json is ${Number.isFinite(ageDays) ? `${ageDays.toFixed(0)} days` : 'never'} old; limit is ${MAX_BUDGET_AGE_DAYS} days`,
        'Regenerate the budgets file from the current TRD to keep thresholds aligned with product scope.',
      ),
    );
  }

  const msBudget = budgets.milestones?.[milestone];
  if (!msBudget) {
    issues.push(
      issue(
        'nfr-preflight-milestone-missing',
        'critical',
        `nfr-budgets.json has no entry for ${milestone}`,
        `Add milestones.${milestone} with perf / security / chaos / authEdge blocks.`,
      ),
    );
    return { passed: false, issues, findings };
  }

  // Category completeness
  for (const key of CATEGORY_KEYS) {
    if (!msBudget[key] || typeof msBudget[key] !== 'object') {
      issues.push(
        issue(
          `nfr-preflight-${key}-missing`,
          'critical',
          `${milestone} is missing the ${key} budget block`,
          `Declare milestones.${milestone}.${key}. See source/schemas/nfr-budgets.schema.json for the required shape.`,
        ),
      );
    }
  }
  // Early return only when a CRITICAL category is missing — perf-field /
  // traceability checks below depend on category presence. High-severity
  // issues like staleness accumulate without short-circuiting.
  if (issues.filter((it) => it.severity === 'critical').length > 0) {
    return { passed: false, issues, findings };
  }

  // Perf key completeness
  const perfMissing = validatePerfKeys(msBudget.perf);
  for (const key of perfMissing) {
    issues.push(
      issue(
        `nfr-preflight-perf-${key}-missing`,
        'critical',
        `${milestone}.perf.${key} is not declared`,
        'Every perf budget MUST declare p95LatencyMs, p99LatencyMs, minRps, maxErrorRate.',
      ),
    );
  }

  // Requirement traceability — every budget references at least one requirement id
  const rtm = readJson(rtmPath(root));
  const requirementIds = extractRequirementIds(rtm);
  if (requirementIds.size === 0) {
    findings.push('rtm.json not populated yet; skipping requirement-traceability check');
  } else {
    const referenced = new Set();
    for (const key of CATEGORY_KEYS) {
      const bag = new Set();
      collectReferenceIds(msBudget[key], bag);
      if (bag.size === 0) {
        issues.push(
          issue(
            `nfr-preflight-${key}-untraced`,
            'high',
            `${milestone}.${key} does not reference any FR/NFR/IR via appliesToRequirements[]`,
            'Declare appliesToRequirements:["FR-X","NFR-Y"] on every budget block so enforcement failures map back to requirements.',
          ),
        );
        continue;
      }
      for (const id of bag) referenced.add(id);
    }
    const unknown = [...referenced].filter((id) => !requirementIds.has(id));
    if (unknown.length > 0) {
      issues.push(
        issue(
          'nfr-preflight-unknown-requirement-refs',
          'high',
          `${milestone} budgets reference requirement IDs that do not resolve in rtm.json: ${unknown.slice(0, 10).join(', ')}${unknown.length > 10 ? ` (+${unknown.length - 10} more)` : ''}`,
          'Either update rtm.json with the missing requirement IDs or correct the budget references.',
        ),
      );
    }
  }

  const passed = issues.filter((it) => it.severity === 'critical').length === 0;
  return {
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-nfr-preflight',
    projectRoot: root,
    milestone,
    passed,
    issues,
    findings,
    budgetsPath: path.relative(root, budgetsAbs).replace(/\\/g, '/'),
    budgetsSource: budgets.source || null,
    budgetsGeneratedAt: budgets.generatedAt || null,
  };
}

function run(args = parseArgs()) {
  const v12 = String(process.env.COBOLT_V12_GATES || '').toLowerCase();
  if (v12 === 'bypass' || v12 === 'off') {
    logDecision(args.root || process.cwd(), {
      gate: 'cobolt-nfr-preflight',
      decision: 'bypass',
      env: 'COBOLT_V12_GATES',
    });
    return { ok: true, bypassed: 'COBOLT_V12_GATES', reason: 'master-bypass', passed: true, issues: [] };
  }
  if (process.env.COBOLT_NFR_PREFLIGHT_GATE === '0') {
    logDecision(args.root || process.cwd(), {
      gate: 'cobolt-nfr-preflight',
      decision: 'bypass',
      env: 'COBOLT_NFR_PREFLIGHT_GATE',
    });
    return { ok: true, bypassed: 'COBOLT_NFR_PREFLIGHT_GATE', reason: 'per-gate-bypass', passed: true, issues: [] };
  }
  if (args.command === 'help') {
    return { ok: true, usage: 'node tools/cobolt-nfr-preflight.js check --milestone M1 [--strict] [--json]' };
  }
  if (args.command === 'check') {
    const result = evaluate({ projectRoot: args.root, milestone: args.milestone, strict: args.strict });
    // Persist verdict for the gate to consume.
    try {
      writeJson(verdictPath(args.root, args.milestone || 'unknown'), result);
    } catch {
      // best-effort
    }
    return { ok: result.passed, reason: result.passed ? 'nfr-preflight-pass' : 'nfr-preflight-failed', ...result };
  }
  return { ok: false, reason: 'unknown-command', command: args.command };
}

if (require.main === module) {
  const args = parseArgs();
  const result = run(args);
  if (args.json || result.usage) console.log(JSON.stringify(result, null, 2));
  else if (!result.ok) console.error(`${result.reason}: ${(result.issues || []).map((i) => i.id).join(', ')}`);
  let exit = 0;
  if (!result.ok) {
    if (result.missingInfra) exit = 3;
    else exit = 1;
  }
  process.exit(exit);
}

module.exports = {
  CATEGORY_KEYS,
  MAX_BUDGET_AGE_DAYS,
  budgetsPath,
  collectReferenceIds,
  evaluate,
  extractRequirementIds,
  parseArgs,
  run,
  validatePerfKeys,
  verdictPath,
};
