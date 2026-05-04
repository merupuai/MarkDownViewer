#!/usr/bin/env node

// CoBolt Project-Level Risk Acceptance (v0.45.0, BUILD-04 closer).
//
// Manages _cobolt-output/latest/risk-acceptance.json — project-wide
// register of HMAC-signed risk acceptances that carry forward into deploy
// and release. Peer to the narrower tools/cobolt-fix-risk-acceptance.js
// which handles unresolved fix-loop findings — this project-level register
// additionally covers deploy-time NFR breaches, compliance carve-outs, and
// operational debt. Gate `cobolt-risk-acceptance-gate.js` consumes this
// register at Tier 1 to block deploy / release verdicts when unaccepted
// critical/high findings exist at the project level.
//
// Commands:
//   list   [--json]                            — enumerate active acceptances
//   accept --id RA-X [--severity critical]      — create + sign a new acceptance
//          --category security                   (full flag set in parseArgs)
//          --description "..." --owner "..."
//          --expires 2026-07-01 --compensating "..."
//          --evidence path1,path2
//   verify [--id RA-X]                         — re-verify HMAC on one or all
//   audit  [--since <iso>] [--json]            — aggregate view with expiry ptrs
//   help
//
// HMAC: requires COBOLT_AUDIT_SECRET (refuses the default placeholder). Uses
// SHA-256 over canonical JSON of the acceptance object without the hmac
// field itself, matching cobolt-fix-risk-acceptance.js's scheme so operators
// get one mental model.
//
// Exit codes: 0 pass, 1 error, 2 missing optional dep (none), 3 missing
// infra (register absent when --strict).
//
// Bypass: COBOLT_V12_GATES=bypass | COBOLT_RISK_ACCEPTANCE_GATE=0 (for the
// gate hook only; this tool itself is always callable).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REGISTER_REL_PATH = ['_cobolt-output', 'latest', 'risk-acceptance.json'];
const CATEGORY_SET = new Set([
  'security',
  'authz',
  'compliance',
  'supply-chain',
  'nfr',
  'data',
  'integration',
  'deploy',
  'ops',
  'other',
]);
const SEVERITY_SET = new Set(['critical', 'high', 'medium', 'low']);

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help',
    root: process.cwd(),
    id: null,
    severity: null,
    category: null,
    description: null,
    owner: null,
    expires: null,
    compensating: null,
    evidence: [],
    scopeFindings: [],
    scopeMilestones: [],
    scopeEnvironments: [],
    scopeComponents: [],
    since: null,
    json: false,
    strict: false,
  };
  const start = args.command === argv[0] ? 1 : 0;
  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') args.root = argv[++i] || args.root;
    else if (arg === '--id') args.id = argv[++i];
    else if (arg === '--severity') args.severity = argv[++i];
    else if (arg === '--category') args.category = argv[++i];
    else if (arg === '--description' || arg === '--desc') args.description = argv[++i];
    else if (arg === '--owner') args.owner = argv[++i];
    else if (arg === '--expires' || arg === '--expires-at') args.expires = argv[++i];
    else if (arg === '--compensating' || arg === '--control') args.compensating = argv[++i];
    else if (arg === '--evidence')
      args.evidence = String(argv[++i] || '')
        .split(',')
        .filter(Boolean);
    else if (arg === '--scope-findings')
      args.scopeFindings = String(argv[++i] || '')
        .split(',')
        .filter(Boolean);
    else if (arg === '--scope-milestones')
      args.scopeMilestones = String(argv[++i] || '')
        .split(',')
        .filter(Boolean);
    else if (arg === '--scope-envs')
      args.scopeEnvironments = String(argv[++i] || '')
        .split(',')
        .filter(Boolean);
    else if (arg === '--scope-components')
      args.scopeComponents = String(argv[++i] || '')
        .split(',')
        .filter(Boolean);
    else if (arg === '--since') args.since = argv[++i];
    else if (arg === '--json') args.json = true;
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--help' || arg === '-h') args.command = 'help';
  }
  return args;
}

function registerPath(projectRoot) {
  return path.join(projectRoot, ...REGISTER_REL_PATH);
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function writeRegister(projectRoot, register) {
  const target = registerPath(projectRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(register, null, 2)}\n`, 'utf8');
}

function defaultRegister(projectId = 'unknown') {
  return {
    registerVersion: '1.0.0',
    projectId,
    generatedAt: new Date().toISOString(),
    producedBy: 'cobolt-risk-acceptance/v0.45.0',
    policy: {
      signature: 'HMAC-SHA256 over canonical JSON (no hmac field) with COBOLT_AUDIT_SECRET',
      expired_counts_as_unaccepted: true,
    },
    acceptances: [],
  };
}

function loadRegister(projectRoot) {
  const target = registerPath(projectRoot);
  if (!fs.existsSync(target)) return defaultRegister();
  const parsed = readJson(target);
  if (!parsed) return defaultRegister();
  return parsed;
}

function requireAuditSecret() {
  const secret = String(process.env.COBOLT_AUDIT_SECRET || '').trim();
  if (!secret || secret === 'default-audit-secret-CHANGE-ME') {
    throw new Error(
      'COBOLT_AUDIT_SECRET is required to sign or verify risk acceptances. Generate with `openssl rand -hex 32` and store in your secret manager (not .env.cobolt).',
    );
  }
  return secret;
}

function canonicalAcceptance(acceptance) {
  const clone = { ...acceptance };
  delete clone.hmac;
  // Stable key order for deterministic HMAC.
  return Object.keys(clone)
    .sort()
    .reduce((acc, key) => {
      acc[key] = clone[key];
      return acc;
    }, {});
}

function signAcceptance(acceptance, secret = requireAuditSecret()) {
  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(canonicalAcceptance(acceptance)))
    .digest('hex');
}

function verifyAcceptance(acceptance, secret = requireAuditSecret()) {
  if (!acceptance || typeof acceptance.hmac !== 'string') return { ok: false, reason: 'missing-hmac' };
  const expected = signAcceptance(acceptance, secret);
  if (acceptance.hmac !== expected) return { ok: false, reason: 'hmac-mismatch' };
  return { ok: true };
}

function isExpired(acceptance, now = Date.now()) {
  if (!acceptance?.expiresAt) return false;
  const ts = Date.parse(acceptance.expiresAt);
  if (!Number.isFinite(ts)) return true;
  return ts < now;
}

function validateForAccept(args) {
  const errors = [];
  if (!args.id || !/^RA-[A-Z0-9][A-Z0-9_-]{1,63}$/.test(args.id))
    errors.push('--id must match ^RA-[A-Z0-9][A-Z0-9_-]{1,63}$');
  if (!SEVERITY_SET.has(args.severity)) errors.push(`--severity must be one of: ${[...SEVERITY_SET].join(', ')}`);
  if (!CATEGORY_SET.has(args.category)) errors.push(`--category must be one of: ${[...CATEGORY_SET].join(', ')}`);
  if (!args.description || args.description.length < 20) errors.push('--description required (min 20 chars)');
  if (!args.owner) errors.push('--owner required');
  if (!args.expires) errors.push('--expires required (ISO date or date-time)');
  if (!args.compensating || args.compensating.length < 20)
    errors.push('--compensating required (min 20 chars, describe the mitigation)');
  if (!args.evidence || args.evidence.length === 0) errors.push('--evidence required (comma-separated paths/URLs)');
  if (args.expires) {
    const expiresAt = Date.parse(args.expires);
    if (!Number.isFinite(expiresAt)) errors.push('--expires failed ISO parse');
    else if (expiresAt <= Date.now()) errors.push('--expires must be in the future');
  }
  return errors;
}

function cmdList(args) {
  const register = loadRegister(args.root);
  const now = Date.now();
  const secret = safeSecret();
  const entries = (register.acceptances || []).map((a) => {
    const verify = secret ? verifyAcceptance(a, secret) : { ok: false, reason: 'secret-unset' };
    return {
      id: a.id,
      severity: a.severity,
      category: a.category,
      owner: a.owner,
      acceptedAt: a.acceptedAt,
      expiresAt: a.expiresAt,
      expired: isExpired(a, now),
      hmacValid: verify.ok,
      hmacReason: verify.ok ? null : verify.reason,
      description: a.description,
    };
  });
  return { ok: true, reason: 'ok', count: entries.length, acceptances: entries };
}

function safeSecret() {
  try {
    return requireAuditSecret();
  } catch {
    return null;
  }
}

function cmdAccept(args) {
  const errors = validateForAccept(args);
  if (errors.length > 0) return { ok: false, reason: 'validation-failed', errors };
  const secret = requireAuditSecret();
  const register = loadRegister(args.root);
  if ((register.acceptances || []).some((a) => a.id === args.id)) {
    return { ok: false, reason: 'id-already-exists', id: args.id };
  }
  const acceptance = {
    id: args.id,
    severity: args.severity,
    category: args.category,
    scope: {
      findingIds: args.scopeFindings,
      milestones: args.scopeMilestones,
      environments: args.scopeEnvironments,
      components: args.scopeComponents,
    },
    description: args.description,
    owner: args.owner,
    acceptedAt: new Date().toISOString(),
    expiresAt: new Date(Date.parse(args.expires)).toISOString(),
    compensatingControl: args.compensating,
    evidenceRefs: args.evidence,
    approvals: [],
  };
  acceptance.hmac = signAcceptance(acceptance, secret);
  register.acceptances = [...(register.acceptances || []), acceptance];
  register.generatedAt = new Date().toISOString();
  writeRegister(args.root, register);
  return { ok: true, reason: 'accepted', acceptance, registerPath: registerPath(args.root) };
}

function cmdVerify(args) {
  const secret = requireAuditSecret();
  const register = loadRegister(args.root);
  const acceptances = args.id
    ? (register.acceptances || []).filter((a) => a.id === args.id)
    : register.acceptances || [];
  if (acceptances.length === 0) return { ok: false, reason: 'no-acceptances-matched', id: args.id };
  const results = acceptances.map((a) => {
    const verify = verifyAcceptance(a, secret);
    return {
      id: a.id,
      expired: isExpired(a),
      hmacValid: verify.ok,
      hmacReason: verify.ok ? null : verify.reason,
    };
  });
  const failed = results.filter((r) => !r.hmacValid || r.expired);
  return {
    ok: failed.length === 0,
    reason: failed.length === 0 ? 'all-verified' : 'verification-failed',
    results,
  };
}

function cmdAudit(args) {
  const register = loadRegister(args.root);
  const now = Date.now();
  const acceptances = (register.acceptances || []).filter((a) => {
    if (!args.since) return true;
    const sinceTs = Date.parse(args.since);
    return Number.isFinite(sinceTs) ? Date.parse(a.acceptedAt) >= sinceTs : true;
  });
  const secret = safeSecret();
  const rows = acceptances.map((a) => {
    const verify = secret ? verifyAcceptance(a, secret) : { ok: false, reason: 'secret-unset' };
    return {
      id: a.id,
      severity: a.severity,
      category: a.category,
      owner: a.owner,
      acceptedAt: a.acceptedAt,
      expiresAt: a.expiresAt,
      expired: isExpired(a, now),
      hmacValid: verify.ok,
      hmacReason: verify.ok ? null : verify.reason,
    };
  });
  const active = rows.filter((r) => !r.expired && r.hmacValid);
  const expired = rows.filter((r) => r.expired);
  const invalidSignatures = rows.filter((r) => !r.hmacValid);
  return {
    ok: invalidSignatures.length === 0,
    reason: invalidSignatures.length === 0 ? 'audit-clean' : 'invalid-signatures',
    total: rows.length,
    active: active.length,
    expired: expired.length,
    invalidSignatures: invalidSignatures.length,
    rows,
  };
}

function run(args = parseArgs()) {
  if (args.command === 'help') {
    return {
      ok: true,
      usage: [
        'node tools/cobolt-risk-acceptance.js list [--json]',
        'node tools/cobolt-risk-acceptance.js accept --id RA-X --severity critical|high|medium|low',
        '       --category security|authz|compliance|supply-chain|nfr|data|integration|deploy|ops|other',
        '       --description "..." --owner "..."  --expires 2026-07-01  --compensating "..."',
        '       --evidence path1,path2 [--scope-findings ID1,ID2] [--scope-milestones M1,M2]',
        '       [--scope-envs staging,production] [--scope-components api,web]',
        'node tools/cobolt-risk-acceptance.js verify [--id RA-X]',
        'node tools/cobolt-risk-acceptance.js audit  [--since <iso>] [--json]',
        '',
        'Env: COBOLT_AUDIT_SECRET is required for accept/verify.',
      ].join('\n'),
    };
  }
  if (args.command === 'list') return cmdList(args);
  if (args.command === 'accept') return cmdAccept(args);
  if (args.command === 'verify') return cmdVerify(args);
  if (args.command === 'audit') return cmdAudit(args);
  return { ok: false, reason: 'unknown-command', command: args.command };
}

if (require.main === module) {
  const args = parseArgs();
  try {
    const result = run(args);
    if (args.json || result.usage) console.log(JSON.stringify(result, null, 2));
    else if (!result.ok) console.error(result.reason || 'risk-acceptance failed');
    process.exit(result.ok ? 0 : 1);
  } catch (e) {
    if (args.json) console.log(JSON.stringify({ ok: false, reason: e.message }, null, 2));
    else console.error(e.message);
    process.exit(1);
  }
}

module.exports = {
  CATEGORY_SET,
  SEVERITY_SET,
  canonicalAcceptance,
  cmdAccept,
  cmdAudit,
  cmdList,
  cmdVerify,
  defaultRegister,
  isExpired,
  loadRegister,
  parseArgs,
  registerPath,
  run,
  signAcceptance,
  verifyAcceptance,
  writeRegister,
};
