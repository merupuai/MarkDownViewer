#!/usr/bin/env node

// CoBolt Build Failure Record Writer (v0.22.8).
//
// Deterministic failure-record writer for build-phase agents (backend-dev,
// frontend-dev, api-endpoint-builder, db-migration-writer, test-writer,
// test-architect, integration-test-agent, db-test-agent, elixir-component-builder,
// liveview-builder, graphql-builder, ui-component-builder, docker-builder,
// devops-agent, build-agent, cobolt-build-agent).
//
// The build pipeline's team-teardown / builder-return-contract reads from:
//   _cobolt-output/audit/build-agent-failures.jsonl           (canonical ledger)
//   _cobolt-output/audit/<agent-name>-failure.json            (per-agent)
//   _cobolt-output/audit/builder-return-log.jsonl             (legacy path)
//
// **Escalation target is forced to `build-lead`** (Tier 1 lead for the build
// pipeline per `source/skills/_shared/escalation-protocol.md` row `cobolt-build`),
// overriding the universal contract's `review-lead` default.
//
// Per-story discrimination: builders that work on a specific STORY-NNN emit
// `<agent-name>-failure-<story-id>.json` so multi-builder waves don't stomp.
//
// Usage:
//   echo '{...}' | node tools/cobolt-build-failure-record.js write \
//       --agent <agent-name> \
//       [--story STORY-NNN] \
//       [--milestone M{n}] \
//       [--round N] \
//       [--phase tdd-red|tdd-green|tdd-refactor|integration|deep-verify] \
//       [--dir <project-root>]
//
// Exit codes:
//   0  — record written
//   2  — usage error
//   3  — invalid JSON on stdin
//   4  — invalid enum value
//   5  — agent is not a recognized build agent
//   6  — write failure

const fs = require('node:fs');
const path = require('node:path');

const { atomicWrite } = require('../lib/cobolt-atomic-write');

const BUILD_AGENTS = new Set([
  'build-agent',
  'cobolt-build-agent',
  'build-lead',
  'cobolt-build-lead',
  'backend-dev',
  'frontend-dev',
  'api-endpoint-builder',
  'db-migration-writer',
  'test-writer',
  'test-architect',
  'integration-test-agent',
  'db-test-agent',
  'test-team-lead',
  'elixir-component-builder',
  'liveview-builder',
  'graphql-builder',
  'ui-component-builder',
  'docker-builder',
  'devops-agent',
]);

const VALID_STATUS = new Set(['degraded', 'failed']);

const VALID_PHASE = new Set([
  'tdd-red',
  'tdd-green',
  'tdd-refactor',
  'integration',
  'integration-smoke',
  'deep-verify',
  'build-preflight',
  'build-milestone-setup',
  'build-milestone-complete',
  'build-nfr-enforce',
  'build-contract-replay',
  'build-schema-replay',
  'build-review',
  'build-fix',
  'build-validate',
]);

const VALID_ERROR_CLASS = new Set([
  'missing-input',
  'compile-failure',
  'test-failure',
  'red-without-fail',
  'green-without-pass',
  'coverage-below-threshold',
  'stub-detected',
  'illusion-detected',
  'skip-marker-detected',
  'schema-mismatch',
  'contract-replay-failed',
  'entrypoint-unwired',
  'worktree-collision',
  'worktree-checkout-failed',
  'phantom-round',
  'persistence-missing',
  'migration-irreversible',
  'tool-failure',
  'runtime-failure',
  'timeout',
  'context-exhausted',
  'context7-unreachable',
  'permission-denied',
  'dependency-failure',
  'verification-gap',
  'parent-branch-drift',
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
      'usage: cobolt-build-failure-record <write|show|list|clear> --agent <name> [options]',
      '',
      '  --agent        one of the 19 build agents (see tool source)',
      '  --story        e.g., STORY-001 (per-story discriminator)',
      '  --milestone    e.g., M1',
      '  --round        integer round number (for TDD rounds)',
      '  --phase        tdd-red | tdd-green | tdd-refactor | integration | ...',
      '  --dir          project root (default: cwd)',
      '  --status       degraded | failed (default: failed)',
      '  --error-class  enum (see tool source)',
      '  --error-message <text>',
      '  --remediation <text>',
      '  --escalation-target  build-lead | recovery-advisor (default: build-lead)',
      '',
      'Stdin JSON (optional) merges with CLI flags; CLI flags override stdin.',
      '',
    ].join('\n'),
  );
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function readStdinSync() {
  try {
    const buf = fs.readFileSync(0, 'utf8');
    return buf.trim() ? buf : '';
  } catch {
    return '';
  }
}

function defaultRecord(agent, phase, story, milestone, round) {
  return {
    agent,
    stage: phase || 'build-unspecified',
    story: story || null,
    milestone: milestone || null,
    round: round != null ? Number(round) : null,
    status: 'failed',
    error_class: 'other',
    error_message: '',
    failed_component: 'agent',
    failed_tool: null,
    command: null,
    exit_code: null,
    stderr: '',
    stack: '',
    missing_inputs: [],
    expected_artifacts: [],
    artifacts_written: [],
    files_touched: [],
    coverage_gaps: [],
    coverage_census: { expected: 0, produced: 0, orphans: [] },
    test_census: { expected: 0, red: 0, green: 0, skipped: 0, failing: [] },
    recovery_attempts: [],
    blocked_by: [],
    phantom_references: [],
    remediation: '',
    escalation_target: 'build-lead',
    advisor_required: false,
  };
}

function resolveOutputPath(projectRoot, agent, story) {
  const auditDir = path.join(projectRoot, '_cobolt-output', 'audit');
  const base = story ? `${agent}-failure-${slugify(story)}.json` : `${agent}-failure.json`;
  return { auditDir, filePath: path.join(auditDir, base) };
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
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String(x))).slice(0, 500);
  if (typeof v === 'string') {
    return v
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 500);
  }
  return [String(v)];
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
  if (rec.stage && rec.stage !== 'build-unspecified' && !VALID_PHASE.has(rec.stage)) {
    return { ok: false, code: 4, reason: `invalid stage/phase: ${rec.stage}` };
  }
  if (typeof rec.remediation !== 'string' || rec.remediation.length === 0) {
    return { ok: false, code: 4, reason: 'remediation must be a non-empty string' };
  }
  const validTargets = new Set([
    'build-lead',
    'review-lead',
    'recovery-advisor',
    'architect',
    'planning-lead',
    'test-team-lead',
    'fix-lead',
  ]);
  if (!validTargets.has(rec.escalation_target)) {
    return { ok: false, code: 4, reason: `invalid escalation_target: ${rec.escalation_target}` };
  }
  return { ok: true };
}

function writeCommand(flags, stdinText) {
  const agent = flags.agent || flags.a;
  if (!agent) {
    process.stderr.write('error: --agent is required\n');
    return 2;
  }
  if (!BUILD_AGENTS.has(agent)) {
    process.stderr.write(
      `error: ${agent} is not a recognized build agent.\nValid agents:\n  ${[...BUILD_AGENTS].join('\n  ')}\n`,
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
  const story = flags.story || stdinObj.story || null;
  const milestone = flags.milestone || stdinObj.milestone || null;
  const round = flags.round != null ? Number(flags.round) : (stdinObj.round ?? null);

  const record = mergeRecord(defaultRecord(agent, phase, story, milestone, round), stdinObj);

  // CLI flag overrides
  const cliOverrides = {
    status: flags.status,
    error_class: flags['error-class'] || flags.errorClass,
    error_message: flags['error-message'] || flags.errorMessage,
    stage: flags.phase || flags.stage,
    story: flags.story,
    milestone: flags.milestone,
    round: flags.round != null ? Number(flags.round) : undefined,
    failed_component: flags['failed-component'],
    failed_tool: flags['failed-tool'],
    command: flags.command,
    exit_code: flags['exit-code'] != null ? Number(flags['exit-code']) : undefined,
    stderr: flags.stderr,
    remediation: flags.remediation,
    escalation_target: flags['escalation-target'],
    advisor_required:
      flags['advisor-required'] != null ? String(flags['advisor-required']).toLowerCase() === 'true' : undefined,
  };
  for (const [k, v] of Object.entries(cliOverrides)) {
    if (v != null && v !== '') record[k] = v;
  }

  // Sanitize
  record.error_message = sanitizeString(record.error_message);
  record.stderr = sanitizeString(record.stderr, 16000);
  record.stack = sanitizeString(record.stack, 16000);
  record.remediation = sanitizeString(record.remediation);
  record.missing_inputs = sanitizeArray(record.missing_inputs);
  record.expected_artifacts = sanitizeArray(record.expected_artifacts);
  record.artifacts_written = sanitizeArray(record.artifacts_written);
  record.files_touched = sanitizeArray(record.files_touched);
  record.coverage_gaps = sanitizeArray(record.coverage_gaps);
  record.blocked_by = sanitizeArray(record.blocked_by);
  record.phantom_references = sanitizeArray(record.phantom_references);

  // Force build-lead as L1 unless caller explicitly set a later tier.
  if (!record.escalation_target || record.escalation_target === 'review-lead') {
    if (!flags['escalation-target']) record.escalation_target = 'build-lead';
  }

  const check = validateRecord(record);
  if (!check.ok) {
    process.stderr.write(`error: ${check.reason}\n`);
    return check.code;
  }

  const { auditDir, filePath } = resolveOutputPath(projectRoot, agent, record.story);
  try {
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    writeAtomic(filePath, JSON.stringify(record, null, 2));
  } catch (err) {
    process.stderr.write(`error: write failed: ${err.message}\n`);
    return 6;
  }

  // Canonical build-agent ledger (single jsonl — one breadcrumb per failure)
  try {
    fs.appendFileSync(
      path.join(auditDir, 'build-agent-failures.jsonl'),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        agent: record.agent,
        stage: record.stage,
        story: record.story,
        milestone: record.milestone,
        round: record.round,
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
  const { filePath } = resolveOutputPath(projectRoot, agent, flags.story || null);
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
    if (!/-failure(?:-[\w-]+)?\.json$/.test(f)) continue;
    const base = f.replace(/-failure(?:-[\w-]+)?\.json$/, '');
    if (!BUILD_AGENTS.has(base)) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(auditDir, f), 'utf8'));
      entries.push({
        file: f,
        agent: rec.agent,
        stage: rec.stage,
        story: rec.story,
        milestone: rec.milestone,
        round: rec.round,
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
    if (!/-failure(?:-[\w-]+)?\.json$/.test(f)) continue;
    const base = f.replace(/-failure(?:-[\w-]+)?\.json$/, '');
    if (!BUILD_AGENTS.has(base)) continue;
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
  BUILD_AGENTS,
  VALID_STATUS,
  VALID_PHASE,
  VALID_ERROR_CLASS,
  defaultRecord,
  resolveOutputPath,
  validateRecord,
  main,
};
