#!/usr/bin/env node

// CoBolt Source-Write Provenance (v0.42.0).
//
// Ledger manager for writes into the shipping source tree. Peers with
// cobolt-artifact-provenance.js (which stamps planning artifacts). This tool
// records WHO wrote each shipping-code file and WHEN, and provides a census
// check that every shipping file has an allowlisted writer.
//
// Why: the v0.41 stack-contract-gate rejects contracts whose `producedBy` is a
// repair/generator script. That gate catches contract-level drift. Shipping
// source code (`frontend/src/**`, `backend/app/**`, etc.) has no equivalent
// provenance trail. If a repair script slops code into the shipping tree, no
// gate currently notices. This tool closes that seam at build-close time.
//
// Ledger format: append-only JSONL at
//   _cobolt-output/audit/source-write-provenance.jsonl
//
// Each record:
//   { at, path, writer, dispatchId?, milestone?, tool?, hash? }
//
// Commands:
//   record --path <rel>  --writer <id>  [--milestone M1] [--dispatch <id>]
//                        [--tool <name>] [--no-hash]
//   check  [--root <project>]  [--milestone M1]  [--strict]  [--json]
//   verify [--path <rel>]  [--root <project>]
//   help
//
// Writer classification:
//   - accepted writers match a conservative allowlist regex (e.g. agent IDs
//     like `cobolt-build/v0.42:backend-dev`, `developer@<email>`, named tools).
//   - rejected writers match the same repair/generator patterns as the
//     stack-contract-gate (local-script, codex-plan-repair, repair-*, *-gen.js,
//     phase*-fix/gen/patch*).
//
// Exit codes: 0 pass, 1 census failed, 3 missing infra (missing stack
// contract when --strict). v0.42 has no optional deps — exit 2 is not
// produced by this tool.
//
// Master kill switch: COBOLT_V12_GATES=bypass.
// Per-gate bypass:    COBOLT_SOURCE_WRITE_PROVENANCE_GATE=0  (audit-logged).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const shippingFiles = require('../lib/cobolt-shipping-files');
const { logDecision } = require('../lib/cobolt-gate-audit');

// ---------- args ----------

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help',
    root: process.cwd(),
    milestone: null,
    path: null,
    writer: null,
    tool: null,
    dispatch: null,
    json: false,
    strict: false,
    hash: true,
  };
  const start = args.command === argv[0] ? 1 : 0;
  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' || arg === '--dir') args.root = argv[++i] || args.root;
    else if (arg.startsWith('--root=')) args.root = arg.slice('--root='.length);
    else if (arg === '--milestone' || arg === '-m') args.milestone = normalizeMilestone(argv[++i]);
    else if (arg.startsWith('--milestone=')) args.milestone = normalizeMilestone(arg.slice('--milestone='.length));
    else if (arg === '--path' || arg === '-p') args.path = argv[++i];
    else if (arg === '--writer' || arg === '-w') args.writer = argv[++i];
    else if (arg === '--tool') args.tool = argv[++i];
    else if (arg === '--dispatch') args.dispatch = argv[++i];
    else if (arg === '--json') args.json = true;
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--no-hash') args.hash = false;
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

// ---------- disk ----------

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  } catch {
    return '';
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(readText(filePath));
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function ledgerPath(projectRoot) {
  return path.join(projectRoot, '_cobolt-output', 'audit', 'source-write-provenance.jsonl');
}

function appendLedger(projectRoot, record) {
  const dir = path.join(projectRoot, '_cobolt-output', 'audit');
  ensureDir(dir);
  const target = ledgerPath(projectRoot);
  const preExisting = fs.existsSync(target);
  fs.appendFileSync(target, `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  // Node only honours `mode` on create; chmod explicitly so the 0o600 promise
  // holds even when the ledger already existed with looser perms (test
  // harness, checked-out artifacts, etc.).
  if (preExisting) {
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // Best-effort — perm-hardening failure should not block the record.
    }
  }
}

function readLedger(projectRoot) {
  const p = ledgerPath(projectRoot);
  if (!fs.existsSync(p)) return [];
  const lines = readText(p).split(/\r?\n/).filter(Boolean);
  const records = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // ignore corrupt lines; census will surface ledger malformedness separately
    }
  }
  return records;
}

function hashFile(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    return `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
  } catch {
    return null;
  }
}

// ---------- writer classification ----------

// v0.43 C3: the allowlist lives in source/schemas/writer-allowlist.json
// (seed) and may be overridden per-project at
// _cobolt-output/latest/planning/writer-allowlist.json. The hardcoded
// fallbacks below keep the tool functional when neither file is reachable
// (e.g. link-mode installs where `__dirname` does not land on the seed).
const DEFAULT_DISALLOWED = [
  /^local-script/i,
  /^codex-plan-repair/i,
  /^repair-/i,
  /^[^/]*-gen\.js$/i,
  /^phase\d+-(?:fix|gen|patch)/i,
  /^unknown$/i,
  /^anonymous$/i,
];

const DEFAULT_ACCEPTED = [
  /^cobolt-build\/v[\d.]+:/i,
  /^cobolt-fix\/v[\d.]+:/i,
  /^cobolt-brownfield\/v[\d.]+:/i,
  /^cobolt-resolve\/v[\d.]+:/i,
  /^cobolt-dev-story\/v[\d.]+:/i,
  /^developer@/i,
  /^human@/i,
];

function loadWriterAllowlist(projectRoot) {
  const override = readJson(
    path.join(projectRoot || process.cwd(), '_cobolt-output', 'latest', 'planning', 'writer-allowlist.json'),
  );
  const compileList = (items) => {
    if (!Array.isArray(items)) return null;
    const compiled = [];
    for (const entry of items) {
      const regex = entry?.regex;
      if (typeof regex !== 'string' || !regex.length) continue;
      const flags = typeof entry.flags === 'string' ? entry.flags : 'i';
      try {
        compiled.push(new RegExp(regex, flags));
      } catch {
        // Skip malformed patterns — project override is additive not fatal.
      }
    }
    return compiled.length ? compiled : null;
  };
  if (override?.accepted && override.disallowed) {
    const accepted = compileList(override.accepted);
    const disallowed = compileList(override.disallowed);
    if (accepted && disallowed) {
      return { source: 'project-override', accepted, disallowed };
    }
  }
  const seedCandidates = [
    path.resolve(__dirname, '..', 'source', 'schemas', 'writer-allowlist.json'),
    path.resolve(__dirname, '..', 'schemas', 'writer-allowlist.json'),
    path.resolve(projectRoot || process.cwd(), 'source', 'schemas', 'writer-allowlist.json'),
  ];
  for (const candidate of seedCandidates) {
    const seed = readJson(candidate);
    if (seed?.accepted && seed.disallowed) {
      const accepted = compileList(seed.accepted);
      const disallowed = compileList(seed.disallowed);
      if (accepted && disallowed) {
        return { source: `seed:${path.basename(candidate)}`, accepted, disallowed };
      }
    }
  }
  return { source: 'hardcoded-fallback', accepted: DEFAULT_ACCEPTED, disallowed: DEFAULT_DISALLOWED };
}

// Back-compat exports — prefer loadWriterAllowlist() at call sites from v0.43
// onward so project overrides take effect.
const DISALLOWED_WRITER_PATTERNS = DEFAULT_DISALLOWED;
const ACCEPTED_WRITER_PATTERNS = DEFAULT_ACCEPTED;

function classifyWriter(writer, patterns = null) {
  const value = String(writer || '').trim();
  if (!value) return { accepted: false, reason: 'writer is empty' };
  const disallowed = patterns?.disallowed || DEFAULT_DISALLOWED;
  const accepted = patterns?.accepted || DEFAULT_ACCEPTED;
  for (const pattern of disallowed) {
    if (pattern.test(value)) {
      return {
        accepted: false,
        reason: `writer "${value}" matches disallowed producer pattern ${pattern.source}`,
      };
    }
  }
  for (const pattern of accepted) {
    if (pattern.test(value)) return { accepted: true };
  }
  return {
    accepted: false,
    reason: `writer "${value}" does not match any allowed writer pattern (${accepted.map((p) => p.source).join(', ')})`,
  };
}

// Shipping-tree enumeration lives in lib/cobolt-shipping-files.js so this
// provenance gate and the harness-only detector never drift on what counts
// as "shipping" vs "harness". Re-exports kept for back-compat.
const { enumerateShippingFiles, isHarnessPath } = shippingFiles;

// ---------- commands ----------

// Path containment check: the recorded path MUST resolve inside args.root.
// A path outside the project would let a caller poison the ledger with
// fabricated entries that later confuse `cmdCheck` census. Rejects absolute
// paths outside root AND relative paths that ../ their way out.
function resolveRecordPath(projectRoot, rawPath) {
  const rel = String(rawPath || '').replace(/\\/g, '/');
  if (!rel) return { ok: false, reason: 'path is empty' };
  const abs = path.resolve(projectRoot, rel);
  const rootResolved = path.resolve(projectRoot);
  const relFromRoot = path.relative(rootResolved, abs);
  if (relFromRoot === '' || relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    return {
      ok: false,
      reason: `path "${rel}" resolves outside the project root (${rootResolved}); provenance ledger refuses writes for foreign paths`,
    };
  }
  return { ok: true, absolutePath: abs, normalizedRel: relFromRoot.replace(/\\/g, '/') };
}

function cmdRecord(args) {
  if (!args.path || !args.writer) {
    return {
      ok: false,
      reason: 'record-requires-path-and-writer',
      message:
        'Usage: record --path <rel-path> --writer <writer-id> [--milestone M1] [--dispatch <id>] [--tool <name>]',
    };
  }
  const resolved = resolveRecordPath(args.root, args.path);
  if (!resolved.ok) return { ok: false, reason: 'path-outside-project-root', message: resolved.reason };
  const record = {
    at: new Date().toISOString(),
    path: resolved.normalizedRel,
    writer: args.writer,
    dispatchId: args.dispatch || null,
    milestone: args.milestone || null,
    tool: args.tool || null,
    hash: args.hash ? hashFile(resolved.absolutePath) : null,
  };
  appendLedger(args.root, record);
  return {
    ok: true,
    reason: 'recorded',
    record,
    ledgerPath: path.relative(args.root, ledgerPath(args.root)).replace(/\\/g, '/'),
  };
}

function cmdVerify(args) {
  const records = readLedger(args.root);
  if (!args.path) {
    return { ok: true, reason: 'ledger-summary', records: records.length, ledger: records.slice(-20) };
  }
  const needle = String(args.path).replace(/\\/g, '/');
  const matches = records.filter((r) => r.path === needle);
  if (matches.length === 0) {
    return { ok: false, reason: 'no-records', path: needle };
  }
  const latest = matches[matches.length - 1];
  const patterns = loadWriterAllowlist(args.root);
  const classification = classifyWriter(latest.writer, patterns);
  return {
    ok: classification.accepted,
    reason: classification.accepted ? 'writer-accepted' : 'writer-rejected',
    path: needle,
    writer: latest.writer,
    classification,
    recordCount: matches.length,
    latest,
    allowlistSource: patterns.source,
  };
}

function cmdCheck(args) {
  const planningDir = path.join(args.root, '_cobolt-output', 'latest', 'planning');
  const stack = readJson(path.join(planningDir, 'selected-stack-contract.json'));
  const findings = [];
  const errors = [];

  if (!stack) {
    const err = {
      id: 'stack-contract-missing',
      severity: 'critical',
      message:
        'selected-stack-contract.json not found — provenance census has no shipping-folder manifest to crosswalk against.',
      remediation: 'Run /cobolt-plan so milestone-architect emits selected-stack-contract.json.',
    };
    return {
      ok: false,
      reason: 'stack-contract-missing',
      missingInfra: args.strict,
      passed: false,
      errors: [err],
      findings,
      shippingFiles: [],
      records: readLedger(args.root).length,
    };
  }

  const folders = [
    ...(Array.isArray(stack.frontend?.requiredFolders) ? stack.frontend.requiredFolders : []),
    ...(Array.isArray(stack.backend?.requiredFolders) ? stack.backend.requiredFolders : []),
  ];
  const shippingFiles = enumerateShippingFiles(args.root, folders);
  findings.push(`shipping files discovered: ${shippingFiles.length}`);

  const records = readLedger(args.root);
  findings.push(`ledger records: ${records.length}`);
  const latestByPath = new Map();
  for (const record of records) {
    if (!record.path) continue;
    latestByPath.set(record.path, record);
  }

  const patterns = loadWriterAllowlist(args.root);
  findings.push(`writer allowlist source: ${patterns.source}`);
  const orphans = [];
  const rejected = [];
  const accepted = [];
  for (const rel of shippingFiles) {
    const record = latestByPath.get(rel);
    if (!record) {
      orphans.push({ path: rel });
      continue;
    }
    const classification = classifyWriter(record.writer, patterns);
    if (classification.accepted) accepted.push({ path: rel, writer: record.writer });
    else rejected.push({ path: rel, writer: record.writer, reason: classification.reason });
  }

  if (orphans.length > 0) {
    errors.push({
      id: 'shipping-files-without-provenance',
      severity: 'critical',
      count: orphans.length,
      message: `${orphans.length} shipping file(s) have no record in source-write-provenance.jsonl`,
      remediation:
        'Every shipping file must be accompanied by at least one record via `tools/cobolt-source-write-provenance.js record --path <rel> --writer <agent-id>`. Wire the record call into your build step after each agent/team teardown.',
      orphansPreview: orphans.slice(0, 20),
    });
  }
  if (rejected.length > 0) {
    errors.push({
      id: 'shipping-files-with-rejected-writer',
      severity: 'critical',
      count: rejected.length,
      message: `${rejected.length} shipping file(s) were written by disallowed producers (repair/generator scripts, empty/unknown writers).`,
      remediation:
        'Re-implement these files via an agent dispatch whose identity matches the allowlist, or record an explicit waiver in a signed risk-acceptance.json. Repair-script authorship on shipping code is the failure class v0.42 closes.',
      rejectedPreview: rejected.slice(0, 20),
    });
  }

  const passed = errors.filter((e) => e.severity === 'critical').length === 0;
  return {
    ok: passed,
    reason: passed ? 'provenance-intact' : 'provenance-census-failed',
    passed,
    projectRoot: args.root,
    milestone: args.milestone,
    shippingFiles,
    ledgerRecordCount: records.length,
    accepted,
    rejected,
    orphans,
    findings,
    errors,
    ledgerPath: path.relative(args.root, ledgerPath(args.root)).replace(/\\/g, '/'),
  };
}

// ---------- entrypoint ----------

function run(args = parseArgs()) {
  const v12 = String(process.env.COBOLT_V12_GATES || '').toLowerCase();
  if (v12 === 'bypass' || v12 === 'off') {
    logDecision(args.root || process.cwd(), {
      gate: 'cobolt-source-write-provenance',
      decision: 'bypass',
      env: 'COBOLT_V12_GATES',
    });
    return {
      ok: true,
      bypassed: 'COBOLT_V12_GATES',
      reason: 'master-bypass',
      passed: true,
      findings: ['master bypass active — source-write-provenance skipped'],
    };
  }
  if (process.env.COBOLT_SOURCE_WRITE_PROVENANCE_GATE === '0') {
    logDecision(args.root || process.cwd(), {
      gate: 'cobolt-source-write-provenance',
      decision: 'bypass',
      env: 'COBOLT_SOURCE_WRITE_PROVENANCE_GATE',
    });
    return {
      ok: true,
      bypassed: 'COBOLT_SOURCE_WRITE_PROVENANCE_GATE',
      reason: 'per-gate-bypass',
      passed: true,
      findings: ['per-gate bypass active — source-write-provenance skipped'],
    };
  }
  if (args.command === 'help') {
    return {
      ok: true,
      usage: [
        'node tools/cobolt-source-write-provenance.js record  --path <rel> --writer <id> [--milestone M1] [--dispatch <id>] [--tool <name>] [--no-hash]',
        'node tools/cobolt-source-write-provenance.js check   [--root <project>] [--milestone M1] [--strict] [--json]',
        'node tools/cobolt-source-write-provenance.js verify  --path <rel> [--root <project>]',
      ].join('\n'),
    };
  }
  if (args.command === 'record') return cmdRecord(args);
  if (args.command === 'verify') return cmdVerify(args);
  if (args.command === 'check') return cmdCheck(args);
  return { ok: false, reason: 'unknown-command', command: args.command };
}

if (require.main === module) {
  const args = parseArgs();
  const result = run(args);
  if (args.json || result.usage) console.log(JSON.stringify(result, null, 2));
  else if (!result.ok) console.error(`${result.reason}: ${(result.errors || []).map((e) => e.id).join(', ')}`);
  let exit = 0;
  if (!result.ok) {
    if (result.missingInfra) exit = 3;
    else exit = 1;
  }
  process.exit(exit);
}

module.exports = {
  appendLedger,
  classifyWriter,
  cmdCheck,
  cmdRecord,
  cmdVerify,
  enumerateShippingFiles,
  hashFile,
  isHarnessPath,
  ledgerPath,
  loadWriterAllowlist,
  parseArgs,
  readLedger,
  resolveRecordPath,
  run,
  DISALLOWED_WRITER_PATTERNS,
  ACCEPTED_WRITER_PATTERNS,
};
