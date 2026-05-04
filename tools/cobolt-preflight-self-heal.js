#!/usr/bin/env node

// CoBolt Preflight Self-Heal Helper
//
// Provides the decision + audit-log primitives used by the cobolt-build
// preflight self-healing loop. Recoverable preflight failures (missing infra
// services, missing RTM coverage, missing story files) call into this helper
// so that:
//
//   1. A single recovery attempt is recorded to the build-self-heal audit log.
//   2. The helper enforces the ONE-ATTEMPT cap (fail-closed on retry).
//   3. COBOLT_BUILD_SELF_HEAL=off disables the mechanism entirely.
//
// This is intentionally a thin, side-effect-local module so it can be unit
// tested without spinning the full preflight shell pipeline.
//
// Usage:
//   node tools/cobolt-preflight-self-heal.js should-attempt <trigger> [--project <dir>]
//   node tools/cobolt-preflight-self-heal.js log <trigger> <skill> <verdict> [--project <dir>] [--detail <json>]
//   node tools/cobolt-preflight-self-heal.js attempts <trigger> [--project <dir>]
//   node tools/cobolt-preflight-self-heal.js reset [--project <dir>]
//
// Exit codes:
//   0 = OK (attempt allowed / log written / query succeeded)
//   1 = Retry denied (already attempted, or self-heal disabled)
//   2 = Usage error

const fs = require('node:fs');
const path = require('node:path');

const AUDIT_REL = path.join('_cobolt-output', 'audit', 'build-self-heal-log.jsonl');
const MAX_ATTEMPTS_PER_TRIGGER = 1;

const VALID_TRIGGERS = new Set(['infra-parity', 'infra-unprovisioned', 'rtm-coverage', 'story-missing']);

function isSelfHealDisabled() {
  const v = String(process.env.COBOLT_BUILD_SELF_HEAL || '')
    .trim()
    .toLowerCase();
  return v === 'off' || v === 'false' || v === '0' || v === 'disabled';
}

function auditPath(projectDir) {
  return path.join(projectDir, AUDIT_REL);
}

function readLog(projectDir) {
  const p = auditPath(projectDir);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* ignore malformed rows */
    }
  }
  return entries;
}

function countAttempts(projectDir, trigger) {
  return readLog(projectDir).filter((e) => e.trigger === trigger).length;
}

function appendLog(projectDir, entry) {
  const p = auditPath(projectDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/**
 * Decide whether a self-heal attempt is permitted for `trigger`.
 * Returns {allowed:boolean, reason:string, attempts:number, disabled:boolean}.
 */
function shouldAttempt(projectDir, trigger) {
  if (!VALID_TRIGGERS.has(trigger)) {
    return { allowed: false, reason: `unknown-trigger:${trigger}`, attempts: 0, disabled: false };
  }
  if (isSelfHealDisabled()) {
    return { allowed: false, reason: 'self-heal-disabled', attempts: 0, disabled: true };
  }
  const attempts = countAttempts(projectDir, trigger);
  if (attempts >= MAX_ATTEMPTS_PER_TRIGGER) {
    return { allowed: false, reason: 'max-attempts-reached', attempts, disabled: false };
  }
  return { allowed: true, reason: 'ok', attempts, disabled: false };
}

/**
 * Record one self-heal attempt.
 * `verdict` is one of: recovered | failed | dispatch-error | disabled.
 */
function logAttempt(projectDir, { trigger, skill, verdict, detail }) {
  if (!VALID_TRIGGERS.has(trigger)) {
    throw new Error(`unknown trigger: ${trigger}`);
  }
  if (!['recovered', 'failed', 'dispatch-error', 'disabled'].includes(verdict)) {
    throw new Error(`invalid verdict: ${verdict}`);
  }
  const entry = {
    timestamp: new Date().toISOString(),
    trigger,
    skill: skill || null,
    verdict,
    detail: detail || null,
  };
  appendLog(projectDir, entry);
  return entry;
}

function resetLog(projectDir) {
  const p = auditPath(projectDir);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function parseArgs(argv) {
  const out = { _: [], project: process.cwd(), detail: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') out.project = argv[++i];
    else if (a === '--detail') out.detail = argv[++i];
    else out._.push(a);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = args._;

  if (!cmd) {
    console.error('Usage: cobolt-preflight-self-heal.js <should-attempt|log|attempts|reset> [args] [--project DIR]');
    process.exit(2);
  }

  if (cmd === 'should-attempt') {
    const trigger = rest[0];
    const verdict = shouldAttempt(args.project, trigger);
    console.log(JSON.stringify(verdict));
    process.exit(verdict.allowed ? 0 : 1);
  }

  if (cmd === 'attempts') {
    const trigger = rest[0];
    const n = countAttempts(args.project, trigger);
    console.log(String(n));
    process.exit(0);
  }

  if (cmd === 'log') {
    const [trigger, skill, verdict] = rest;
    let detail = null;
    if (args.detail) {
      try {
        detail = JSON.parse(args.detail);
      } catch {
        detail = args.detail;
      }
    }
    const entry = logAttempt(args.project, { trigger, skill, verdict, detail });
    console.log(JSON.stringify(entry));
    process.exit(0);
  }

  if (cmd === 'reset') {
    resetLog(args.project);
    process.exit(0);
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`cobolt-preflight-self-heal error: ${err.message}`);
    process.exit(2);
  }
}

module.exports = {
  shouldAttempt,
  logAttempt,
  countAttempts,
  resetLog,
  isSelfHealDisabled,
  VALID_TRIGGERS,
  MAX_ATTEMPTS_PER_TRIGGER,
};
