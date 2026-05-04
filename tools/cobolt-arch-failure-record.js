#!/usr/bin/env node

// CoBolt Architecture Failure Record Writer (v0.22.8).
//
// Deterministic failure-record writer for the architecture-diagrams team
// (architecture-diagram-curator + arch-icon-resolver agents). Agents cannot
// be trusted to hand-roll JSON reliably under context pressure, so this tool
// takes structured flags (or stdin JSON), validates the shape, computes the
// correct file path per agent, and writes the record atomically.
//
// The architecture-diagrams team-teardown protocol reads records at:
//   _cobolt-output/audit/architecture-diagram-curator-failure.json
//   _cobolt-output/audit/arch-icon-resolver-failure-<slug>.json
//
// Escalation target is forced to `architect` (L1 per
// source/skills/_shared/escalation-protocol.md row `cobolt-arch`), overriding
// the universal contract's `review-lead` default.
//
// Usage:
//   echo '{...}' | node tools/cobolt-arch-failure-record.js write \
//       --agent <architecture-diagram-curator|arch-icon-resolver> \
//       [--slug <slug>] \
//       [--dir <project-root>]
//
//   # Or inline flags:
//   node tools/cobolt-arch-failure-record.js write \
//       --agent arch-icon-resolver \
//       --slug chronicle-siem \
//       --status failed \
//       --error-class candidate-empty \
//       --error-message "context7 could not disambiguate" \
//       --remediation "User should drop SVG at docs/diagrams/icons/chronicle-siem.svg"
//
// Exit codes:
//   0  — record written
//   2  — usage error (missing --agent, bad agent name, etc.)
//   3  — invalid JSON on stdin
//   4  — invalid field value (bad status/error_class enum)
//   5  — resolver without --slug
//   6  — write failure (filesystem)

const fs = require('node:fs');
const path = require('node:path');

const { atomicWrite } = require('../lib/cobolt-atomic-write');

const VALID_AGENTS = new Set(['architecture-diagram-curator', 'arch-icon-resolver']);
const VALID_STATUS = new Set(['degraded', 'failed']);
const VALID_ERROR_CLASS = new Set([
  'missing-input',
  'malformed-graph',
  'candidate-empty',
  'allowlist-rejected',
  'context7-unreachable',
  'confidence-below-threshold',
  'context-exhausted',
  'tool-failure',
  'schema-failure',
  'runtime-failure',
  'timeout',
  'permission-denied',
  'dependency-failure',
  'verification-gap',
  'other',
]);

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { positional: [], flags: {}, readStdin: false };
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
      'usage: cobolt-arch-failure-record write --agent <name> [--slug <slug>] [options]',
      '',
      '  --agent        architecture-diagram-curator | arch-icon-resolver',
      '  --slug         required when --agent=arch-icon-resolver',
      '  --dir          project root (default: cwd)',
      '  --status       degraded | failed (default: failed)',
      '  --error-class  enum (see tool source)',
      '  --error-message <text>',
      '  --stage <text>',
      '  --remediation <text>',
      '  --escalation-target  architect | review-lead | recovery-advisor (default: architect)',
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

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function defaultRecord(agent, slug) {
  const discriminator = agent === 'arch-icon-resolver' ? `-${slug || 'unknown'}` : '';
  return {
    agent,
    stage: agent === 'architecture-diagram-curator' ? 'arch-curator-pass' : `arch-icon-resolver-pass${discriminator}`,
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
    recovery_attempts: [],
    blocked_by: [],
    phantom_references: [],
    remediation: '',
    escalation_target: 'architect',
    advisor_required: false,
  };
}

function resolveOutputPath(projectRoot, agent, slug) {
  const auditDir = path.join(projectRoot, '_cobolt-output', 'audit');
  const base =
    agent === 'architecture-diagram-curator'
      ? 'architecture-diagram-curator-failure.json'
      : `arch-icon-resolver-failure-${slugify(slug)}.json`;
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
    return { ok: false, code: 4, reason: `invalid status: ${rec.status} (want: degraded | failed)` };
  }
  if (!VALID_ERROR_CLASS.has(rec.error_class)) {
    return {
      ok: false,
      code: 4,
      reason: `invalid error_class: ${rec.error_class} (see VALID_ERROR_CLASS)`,
    };
  }
  if (typeof rec.remediation !== 'string' || rec.remediation.length === 0) {
    return { ok: false, code: 4, reason: 'remediation must be a non-empty string' };
  }
  return { ok: true };
}

function writeCommand(flags, stdinText) {
  const agent = flags.agent || flags.a;
  if (!agent || !VALID_AGENTS.has(agent)) {
    process.stderr.write(`error: --agent must be one of: ${[...VALID_AGENTS].join(', ')}\n`);
    return 2;
  }
  const slug = flags.slug || flags.s || null;
  if (agent === 'arch-icon-resolver' && !slug) {
    process.stderr.write('error: --slug is required when --agent=arch-icon-resolver\n');
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
  const record = mergeRecord(defaultRecord(agent, slug), stdinObj);

  // CLI flags override stdin.
  const cliOverrides = {
    status: flags.status,
    error_class: flags['error-class'] || flags.errorClass,
    error_message: flags['error-message'] || flags.errorMessage,
    stage: flags.stage,
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

  // Sanitize field shapes.
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

  // Force architect as L1 (per escalation-protocol.md cobolt-arch row) when
  // caller didn't explicitly override to a later tier. This corrects the
  // universal contract's `review-lead` default.
  if (!record.escalation_target || record.escalation_target === 'review-lead') {
    if (!flags['escalation-target']) record.escalation_target = 'architect';
  }

  const check = validateRecord(record);
  if (!check.ok) {
    process.stderr.write(`error: ${check.reason}\n`);
    return check.code;
  }

  const { auditDir, filePath } = resolveOutputPath(projectRoot, agent, slug);
  try {
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    writeAtomic(filePath, JSON.stringify(record, null, 2));
  } catch (err) {
    process.stderr.write(`error: write failed: ${err.message}\n`);
    return 6;
  }

  // Also append a jsonl breadcrumb for quick operator visibility.
  try {
    fs.appendFileSync(
      path.join(auditDir, 'architecture-agent-failures.jsonl'),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        agent: record.agent,
        slug: slug || null,
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

  process.stdout.write(`${JSON.stringify({ ok: true, path: filePath, agent: record.agent, status: record.status })}\n`);
  return 0;
}

function showCommand(flags) {
  const agent = flags.agent || flags.a;
  if (!agent || !VALID_AGENTS.has(agent)) {
    process.stderr.write('error: --agent required\n');
    return 2;
  }
  const projectRoot = flags.dir ? path.resolve(flags.dir) : process.cwd();
  const slug = flags.slug || null;
  if (agent === 'arch-icon-resolver' && !slug) {
    process.stderr.write('error: --slug required for arch-icon-resolver\n');
    return 5;
  }
  const { filePath } = resolveOutputPath(projectRoot, agent, slug);
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
  const entries = fs
    .readdirSync(auditDir)
    .filter((f) => /^(?:architecture-diagram-curator|arch-icon-resolver)-failure(?:-[\w-]+)?\.json$/.test(f))
    .map((f) => {
      try {
        const raw = fs.readFileSync(path.join(auditDir, f), 'utf8');
        const rec = JSON.parse(raw);
        return {
          file: f,
          agent: rec.agent,
          status: rec.status,
          error_class: rec.error_class,
          escalation_target: rec.escalation_target,
        };
      } catch {
        return { file: f, error: 'parse-failed' };
      }
    });
  process.stdout.write(`${JSON.stringify({ records: entries }, null, 2)}\n`);
  return 0;
}

function clearCommand(flags) {
  const projectRoot = flags.dir ? path.resolve(flags.dir) : process.cwd();
  const auditDir = path.join(projectRoot, '_cobolt-output', 'audit');
  if (!fs.existsSync(auditDir)) return 0;
  let removed = 0;
  for (const f of fs.readdirSync(auditDir)) {
    if (/^(?:architecture-diagram-curator|arch-icon-resolver)-failure(?:-[\w-]+)?\.json$/.test(f)) {
      try {
        fs.unlinkSync(path.join(auditDir, f));
        removed += 1;
      } catch {
        /* best effort */
      }
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: true, removed })}\n`);
  return 0;
}

function main() {
  const parsed = parseArgs(process.argv);
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
  VALID_AGENTS,
  VALID_STATUS,
  VALID_ERROR_CLASS,
  defaultRecord,
  resolveOutputPath,
  validateRecord,
  slugify,
  main,
};
