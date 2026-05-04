#!/usr/bin/env node

// CoBolt Planning Failure Record Writer (v0.22.8).
//
// Deterministic failure-record writer for planning-phase agents (analyst,
// architect, ux-designer, security-architect, trd-architect, milestone-architect,
// cross-milestone-analyst, delivery-planner, gap-analyst, rtm-analyst,
// implicit-req-extractor, compliance-architect, prd-redteam-agent,
// enhancement-advisor, engineering-standards-validator, bounded-context-architect,
// spec-architect, localization-specialist).
//
// The planning pipeline's team-teardown / agent-failure-review reads from:
//   _cobolt-output/audit/planning-agent-failures.jsonl           (breadcrumb)
//   _cobolt-output/audit/<agent-name>-failure.json               (per-agent)
//
// **Escalation target is forced to `planning-lead`** (Tier 1 lead for the
// plan pipeline per `source/skills/_shared/escalation-protocol.md` row
// `cobolt-plan`), overriding the universal contract's `review-lead` default.
//
// Usage:
//   echo '{...}' | node tools/cobolt-planning-failure-record.js write \
//       --agent <agent-name> \
//       [--phase plan-phase-1|plan-phase-2|plan-phase-3|plan-phase-4|plan-phase-5] \
//       [--milestone M{n}] \
//       [--dir <project-root>]
//
// Exit codes:
//   0  — record written
//   2  — usage error
//   3  — invalid JSON on stdin
//   4  — invalid enum value
//   5  — agent is not a recognized planning agent
//   6  — write failure

const fs = require('node:fs');
const path = require('node:path');

const { atomicWrite } = require('../lib/cobolt-atomic-write');

const PLANNING_AGENTS = new Set([
  'analyst',
  'architect',
  'ux-designer',
  'security-architect',
  'trd-architect',
  'milestone-architect',
  'cross-milestone-analyst',
  'delivery-planner',
  'gap-analyst',
  'rtm-analyst',
  'implicit-req-extractor',
  'compliance-architect',
  'prd-redteam-agent',
  'enhancement-advisor',
  'engineering-standards-validator',
  'bounded-context-architect',
  'spec-architect',
  'localization-specialist',
]);

const VALID_STATUS = new Set(['degraded', 'failed']);
const VALID_PHASE = new Set([
  'plan-phase-1',
  'plan-phase-2',
  'plan-phase-3',
  'plan-phase-4',
  'plan-phase-5',
  'plan-gap-review',
  'plan-preflight',
]);
const VALID_ERROR_CLASS = new Set([
  'missing-input',
  'malformed-prd',
  'phantom-references',
  'census-violation',
  'evidence-contradiction',
  'tool-failure',
  'schema-failure',
  'runtime-failure',
  'timeout',
  'context-exhausted',
  'context7-unreachable',
  'permission-denied',
  'dependency-failure',
  'verification-gap',
  'stage-ordering-violation',
  'write-once-violation',
  'other',
]);

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { positional: [], flags: {} };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (next != null && !next.startsWith('--')) {
          out.flags[a.slice(2)] = next;
          i += 1;
        } else {
          out.flags[a.slice(2)] = true;
        }
      }
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

function usage() {
  process.stderr.write(
    [
      'usage: cobolt-planning-failure-record <write|show|list|clear> --agent <name> [options]',
      '',
      '  --agent        one of the 18 planning agents (see tool source)',
      '  --phase        plan-phase-1..5 | plan-gap-review | plan-preflight',
      '  --milestone    e.g., M1 (for milestone-specific failures)',
      '  --dir          project root (default: cwd)',
      '  --status       degraded | failed (default: failed)',
      '  --error-class  enum (see tool source)',
      '  --error-message <text>',
      '  --stage <text>',
      '  --command <text>',
      '  --stdout <text>',
      '  --stderr <text>',
      '  --state-snapshot <json>',
      '  --input-packet <json>',
      '  --remediation <text>',
      '  --next-action <text>',
      '  --escalation-target  planning-lead | recovery-advisor (default: planning-lead)',
      '  --advisor-required   true|false (default: false)',
      '',
      'Stdin JSON (optional) merges with CLI flags; CLI flags override stdin.',
      '',
    ].join('\n'),
  );
}

function readStdinSync() {
  try {
    const buf = fs.readFileSync(0, 'utf8');
    return buf.trim() ? buf : '';
  } catch {
    return '';
  }
}

function defaultRecord(agent, phase, milestone) {
  return {
    agent,
    stage: phase || 'plan-unspecified',
    milestone: milestone || null,
    status: 'failed',
    error_class: 'other',
    error_message: '',
    failed_component: 'agent',
    failed_tool: null,
    command: null,
    exit_code: null,
    stdout: '',
    stderr: '',
    stack: '',
    state_snapshot: {},
    input_packet: {},
    upstream_artifacts: [],
    missing_inputs: [],
    expected_artifacts: [],
    artifacts_written: [],
    files_touched: [],
    coverage_gaps: [],
    coverage_census: { expected: 0, produced: 0, orphans: [] },
    phantom_references: [],
    recovery_attempts: [],
    attempted_fixes: [],
    blocked_by: [],
    remediation: '',
    next_action:
      'Escalate to planning-lead with the complete failure record and re-run the originating Plan stage after resolution.',
    escalation_target: 'planning-lead',
    advisor_required: false,
  };
}

function resolveOutputPath(projectRoot, agent) {
  const auditDir = path.join(projectRoot, '_cobolt-output', 'audit');
  const filePath = path.join(auditDir, `${agent}-failure.json`);
  return { auditDir, filePath };
}

function writeAtomic(filePath, data) {
  atomicWrite(filePath, data, { mode: 0o600 });
}

function sanitizeString(v, max = 8000) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

function sanitizeArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String(x))).slice(0, 200);
  if (typeof v === 'string') {
    return v
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200);
  }
  return [String(v)];
}

function sanitizeObject(v, max = 24000) {
  if (v == null || v === '') return {};
  if (typeof v === 'string') {
    try {
      return sanitizeObject(JSON.parse(v), max);
    } catch {
      return { raw: sanitizeString(v, max) };
    }
  }
  if (typeof v !== 'object') return { value: v };
  const encoded = JSON.stringify(v);
  if (encoded.length <= max) return v;
  return {
    truncated: true,
    originalBytes: encoded.length,
    preview: sanitizeString(encoded, max),
  };
}

function mergeRecord(base, overrides) {
  const out = { ...base };
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v == null || v === '') continue;
    out[k] = v;
  }
  return out;
}

function validateRecord(rec) {
  if (!VALID_STATUS.has(rec.status)) {
    return { ok: false, code: 4, reason: `invalid status: ${rec.status}` };
  }
  if (!VALID_ERROR_CLASS.has(rec.error_class)) {
    return { ok: false, code: 4, reason: `invalid error_class: ${rec.error_class}` };
  }
  if (rec.stage && rec.stage !== 'plan-unspecified' && !VALID_PHASE.has(rec.stage)) {
    return { ok: false, code: 4, reason: `invalid stage/phase: ${rec.stage}` };
  }
  if (typeof rec.remediation !== 'string' || rec.remediation.length === 0) {
    return { ok: false, code: 4, reason: 'remediation must be a non-empty string' };
  }
  if (typeof rec.next_action !== 'string' || rec.next_action.length === 0) {
    return { ok: false, code: 4, reason: 'next_action must be a non-empty string' };
  }
  const validTargets = new Set(['planning-lead', 'review-lead', 'recovery-advisor', 'architect', 'brownfield-lead']);
  if (!validTargets.has(rec.escalation_target)) {
    return {
      ok: false,
      code: 4,
      reason: `invalid escalation_target: ${rec.escalation_target}`,
    };
  }
  return { ok: true };
}

function writeCommand(flags, stdinText) {
  const agent = flags.agent || flags.a;
  if (!agent) {
    process.stderr.write('error: --agent is required\n');
    return 2;
  }
  if (!PLANNING_AGENTS.has(agent)) {
    process.stderr.write(
      `error: ${agent} is not a recognized planning agent.\nValid agents:\n  ${[...PLANNING_AGENTS].join('\n  ')}\n`,
    );
    return 5;
  }

  let stdinObj = {};
  if (stdinText) {
    try {
      stdinObj = JSON.parse(stdinText);
      if (stdinObj === null || typeof stdinObj !== 'object') throw new Error('not an object');
    } catch (err) {
      process.stderr.write(`error: invalid JSON on stdin: ${err.message}\n`);
      return 3;
    }
  }

  const projectRoot = flags.dir ? path.resolve(flags.dir) : process.cwd();
  const phase = flags.phase || stdinObj.stage || null;
  const milestone = flags.milestone || stdinObj.milestone || null;
  const record = mergeRecord(defaultRecord(agent, phase, milestone), stdinObj);

  // CLI flag overrides
  const cliOverrides = {
    status: flags.status,
    error_class: flags['error-class'] || flags.errorClass,
    error_message: flags['error-message'] || flags.errorMessage,
    stage: flags.phase || flags.stage,
    milestone: flags.milestone,
    failed_component: flags['failed-component'],
    failed_tool: flags['failed-tool'],
    command: flags.command,
    exit_code: flags['exit-code'] != null ? Number(flags['exit-code']) : undefined,
    stdout: flags.stdout,
    stderr: flags.stderr,
    state_snapshot: flags['state-snapshot'],
    input_packet: flags['input-packet'],
    remediation: flags.remediation,
    next_action: flags['next-action'] || flags.nextAction,
    escalation_target: flags['escalation-target'],
    advisor_required:
      flags['advisor-required'] != null ? String(flags['advisor-required']).toLowerCase() === 'true' : undefined,
  };
  for (const [k, v] of Object.entries(cliOverrides)) {
    if (v != null && v !== '') record[k] = v;
  }

  // Sanitize
  record.error_message = sanitizeString(record.error_message);
  record.stdout = sanitizeString(record.stdout, 16000);
  record.stderr = sanitizeString(record.stderr, 16000);
  record.stack = sanitizeString(record.stack, 16000);
  record.remediation = sanitizeString(record.remediation);
  record.next_action = sanitizeString(record.next_action);
  record.state_snapshot = sanitizeObject(record.state_snapshot);
  record.input_packet = sanitizeObject(record.input_packet);
  record.upstream_artifacts = sanitizeArray(record.upstream_artifacts);
  record.missing_inputs = sanitizeArray(record.missing_inputs);
  record.expected_artifacts = sanitizeArray(record.expected_artifacts);
  record.artifacts_written = sanitizeArray(record.artifacts_written);
  record.files_touched = sanitizeArray(record.files_touched);
  record.coverage_gaps = sanitizeArray(record.coverage_gaps);
  record.blocked_by = sanitizeArray(record.blocked_by);
  record.phantom_references = sanitizeArray(record.phantom_references);
  record.attempted_fixes = sanitizeArray(record.attempted_fixes);

  // Force planning-lead as L1 (per escalation-protocol.md cobolt-plan row)
  // unless caller explicitly set a later tier.
  if (!record.escalation_target || record.escalation_target === 'review-lead') {
    if (!flags['escalation-target']) record.escalation_target = 'planning-lead';
  }

  const check = validateRecord(record);
  if (!check.ok) {
    process.stderr.write(`error: ${check.reason}\n`);
    return check.code;
  }

  const { auditDir, filePath } = resolveOutputPath(projectRoot, agent);
  try {
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    writeAtomic(filePath, JSON.stringify(record, null, 2));
  } catch (err) {
    process.stderr.write(`error: write failed: ${err.message}\n`);
    return 6;
  }

  // Canonical planning ledger (single jsonl — one breadcrumb per failure)
  try {
    fs.appendFileSync(
      path.join(auditDir, 'planning-agent-failures.jsonl'),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        agent: record.agent,
        stage: record.stage,
        milestone: record.milestone || null,
        status: record.status,
        error_class: record.error_class,
        escalation_target: record.escalation_target,
        path: path.relative(projectRoot, filePath).replace(/\\/g, '/'),
      })}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* breadcrumb is advisory */
  }

  process.stdout.write(
    `${JSON.stringify({ ok: true, path: filePath, agent: record.agent, status: record.status, escalation_target: record.escalation_target })}\n`,
  );
  return 0;
}

function showCommand(flags) {
  const agent = flags.agent;
  if (!agent) {
    process.stderr.write('error: --agent required\n');
    return 2;
  }
  const projectRoot = flags.dir ? path.resolve(flags.dir) : process.cwd();
  const { filePath } = resolveOutputPath(projectRoot, agent);
  if (!fs.existsSync(filePath)) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'no-record', path: filePath })}\n`);
    return 0;
  }
  process.stdout.write(fs.readFileSync(filePath, 'utf8'));
  return 0;
}

function listCommand(flags) {
  const projectRoot = flags.dir ? path.resolve(flags.dir) : process.cwd();
  const auditDir = path.join(projectRoot, '_cobolt-output', 'audit');
  if (!fs.existsSync(auditDir)) {
    process.stdout.write(`${JSON.stringify({ records: [] })}\n`);
    return 0;
  }
  const entries = [];
  for (const f of fs.readdirSync(auditDir)) {
    if (!f.endsWith('-failure.json')) continue;
    const base = f.replace(/-failure\.json$/, '');
    if (!PLANNING_AGENTS.has(base)) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(auditDir, f), 'utf8'));
      entries.push({
        file: f,
        agent: rec.agent,
        stage: rec.stage,
        milestone: rec.milestone,
        status: rec.status,
        error_class: rec.error_class,
        escalation_target: rec.escalation_target,
      });
    } catch {
      entries.push({ file: f, error: 'parse-failed' });
    }
  }
  process.stdout.write(`${JSON.stringify({ records: entries }, null, 2)}\n`);
  return 0;
}

function clearCommand(flags) {
  const projectRoot = flags.dir ? path.resolve(flags.dir) : process.cwd();
  const auditDir = path.join(projectRoot, '_cobolt-output', 'audit');
  if (!fs.existsSync(auditDir)) return 0;
  let removed = 0;
  for (const f of fs.readdirSync(auditDir)) {
    if (!f.endsWith('-failure.json')) continue;
    const base = f.replace(/-failure\.json$/, '');
    if (!PLANNING_AGENTS.has(base)) continue;
    try {
      fs.unlinkSync(path.join(auditDir, f));
      removed += 1;
    } catch {
      /* best effort */
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: true, removed })}\n`);
  return 0;
}

function main(argv = process.argv) {
  const parsed = parseArgs(argv);
  const cmd = parsed.positional[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    usage();
    return cmd ? 0 : 2;
  }
  switch (cmd) {
    case 'write': {
      const stdinText = readStdinSync();
      return writeCommand(parsed.flags, stdinText);
    }
    case 'show':
      return showCommand(parsed.flags);
    case 'list':
      return listCommand(parsed.flags);
    case 'clear':
      return clearCommand(parsed.flags);
    default:
      process.stderr.write(`error: unknown subcommand: ${cmd}\n`);
      usage();
      return 2;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  PLANNING_AGENTS,
  VALID_STATUS,
  VALID_PHASE,
  VALID_ERROR_CLASS,
  defaultRecord,
  resolveOutputPath,
  validateRecord,
  main,
};
