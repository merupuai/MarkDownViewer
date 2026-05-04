#!/usr/bin/env node

// CoBolt Write Discipline — lint gate for state/artifact write sites.
//
// Enforces the "all writes to cobolt-state.json and _cobolt-output/**
// route through a canonical atomic-write helper" invariant. Scans
// `source/hooks/*.js` and `tools/*.js` and reports every raw
// `fs.writeFileSync|appendFileSync|renameSync` whose target looks like a
// state file or pipeline artifact. Offers an explicit allowlist so the
// gate can be wired into CI at today's baseline and ratcheted forward as
// call sites migrate.
//
// The gate is deliberately structural (regex-based) not semantic — it
// accepts any file that imports one of the canonical helpers at the top
// *and* routes the flagged call through it. Ambiguous cases fall into
// the allowlist, not into silent passes.
//
// Usage:
//   node tools/cobolt-write-discipline.js scan            # report violations (exit 1 if any new)
//   node tools/cobolt-write-discipline.js snapshot        # freeze current violations into allowlist
//   node tools/cobolt-write-discipline.js check           # alias for scan
//   node tools/cobolt-write-discipline.js --json          # machine-readable output
//
// Exit codes:
//   0 = no new violations outside allowlist
//   1 = new violations found
//   2 = tool misuse / unreadable input

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJSON } = require('../lib/cobolt-atomic-write');
const REPO_ROOT = path.resolve(__dirname, '..');
const ALLOWLIST_PATH = path.join(REPO_ROOT, '.write-discipline-allowlist.json');

const CANONICAL_HELPERS = [
  // Imports that signal a file is using an atomic helper.
  'atomicWrite',
  'atomicWriteJSON',
  'cobolt-atomic-write',
  'cobolt-state-lock',
  'cobolt-state-boot',
  'updateStateSync',
  'writeAtomic',
  'CoBoltStateLock',
];

const SCAN_DIRS = [path.join(REPO_ROOT, 'tools'), path.join(REPO_ROOT, 'source', 'hooks')];

// Files we never want to scan — they are themselves the canonical implementations.
const SCAN_SKIPLIST = new Set([
  path.join(REPO_ROOT, 'lib', 'cobolt-atomic-write.js'),
  path.join(REPO_ROOT, 'lib', 'cobolt-state-boot.js'),
  path.join(REPO_ROOT, 'source', 'plugins', 'cobolt-state-lock.js'),
  path.join(REPO_ROOT, 'tools', 'cobolt-write-discipline.js'),
]);

// writeFileSync is the only operation we flag: it replaces an entire file
// in one syscall and is NOT crash-safe without a tmp+fsync+rename wrapper.
// renameSync is kernel-atomic so it is always safe.
// appendFileSync on POSIX is atomic for small writes (< PIPE_BUF), which
// covers the JSONL audit-log pattern used throughout hooks — the canonical
// CLAUDE.md-endorsed shape. If someone appends multi-kilobyte payloads or
// uses it on Windows where atomicity is not guaranteed, they should migrate
// to atomicWrite, but that is a separate hardening axis.
const CALL_RX = /\bfs\.writeFileSync\s*\(/g;
const STATE_TARGET_RX = /cobolt-state\.json/;
const OUTPUT_TARGET_RX = /_cobolt-output/;

function listJsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      // source/hooks/dist/ is the build-hooks output — derived, not source.
      // node_modules / vendor dirs are third-party code we do not own.
      if (entry.isDirectory() && (entry.name === 'dist' || entry.name === 'node_modules')) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function relFromRepo(p) {
  return path.relative(REPO_ROOT, p).replace(/\\/g, '/');
}

function lineNumberAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}

// For a given call at offset, grab a window of text after the opening paren so
// we can examine the first argument for target-path evidence.
function callArgsWindow(src, offset, size = 200) {
  // Find the opening paren
  const parenIdx = src.indexOf('(', offset);
  if (parenIdx === -1) return '';
  // Balance parens so we end at the matching close.
  let depth = 0;
  let end = parenIdx;
  for (let i = parenIdx; i < src.length && i < parenIdx + size; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return src.slice(parenIdx, Math.min(end, parenIdx + size));
}

// Pull every variable whose declaration RHS references cobolt-state.json or
// _cobolt-output. Writes to those variables count as writes to the target.
function extractTargetVars(src) {
  const stateVars = new Set();
  const outputVars = new Set();
  // const/let/var NAME = ...cobolt-state.json...
  const declRx = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
  let m;
  while ((m = declRx.exec(src)) !== null) {
    const name = m[1];
    const rhs = m[2];
    if (STATE_TARGET_RX.test(rhs)) stateVars.add(name);
    if (OUTPUT_TARGET_RX.test(rhs)) outputVars.add(name);
  }
  // Parameter destructuring of { stateFile } = opts — treat stateFile,
  // statePath, stateFilePath as state references. Low-false-positive keywords.
  for (const k of ['stateFile', 'statePath', 'stateFilePath', 'STATE_FILE']) {
    if (new RegExp(`\\b${k}\\b`).test(src) && STATE_TARGET_RX.test(src)) stateVars.add(k);
  }
  return { stateVars, outputVars };
}

// Classify whether the call's target is state or pipeline output.
function classifyTarget(window, targetVars) {
  if (STATE_TARGET_RX.test(window)) return 'STATE';
  if (OUTPUT_TARGET_RX.test(window)) return 'OUTPUT';
  if (targetVars) {
    for (const v of targetVars.stateVars) {
      if (new RegExp(`\\b${v}\\b`).test(window)) return 'STATE';
    }
    for (const v of targetVars.outputVars) {
      if (new RegExp(`\\b${v}\\b`).test(window)) return 'OUTPUT';
    }
  }
  return null;
}

function fileImportsHelper(src) {
  for (const marker of CANONICAL_HELPERS) {
    if (src.includes(marker)) return marker;
  }
  return null;
}

// Heuristic: the call is "routed" if the same file imports a canonical
// helper AND the call site is within 200 chars of a helper invocation
// (e.g. `atomicWriteFile(...)`, `writeAtomic(...)`, `updateStateSync(...)`).
// Otherwise we flag it — even if the file imports a helper, mixing raw and
// routed writes in the same file is the exact pattern we want to forbid.
function siteIsRouted(src, offset) {
  if (!fileImportsHelper(src)) return false;
  const window = src.slice(Math.max(0, offset - 400), Math.min(src.length, offset + 200));
  return /\b(atomicWriteFile|atomicWriteJSON|atomicWrite|writeAtomic|updateStateSync)\s*\(/.test(window);
}

// Some raw writes are legitimate: the atomic pattern is "write tmp then
// rename". If a writeFileSync is targeting a path containing `.tmp.` or
// followed within a few lines by an fs.renameSync of that tmp, mark safe.
function looksLikeTmpThenRename(src, offset) {
  // Signals: (1) a `.tmp.` literal somewhere in the 400-char window before
  // OR after the call (captures `const tmp = base + '.tmp.' + pid;
  // writeFileSync(tmp, ...)`), and (2) a renameSync within the forward
  // window (the commit step). Both required.
  const back = src.slice(Math.max(0, offset - 400), offset);
  const fwd = src.slice(offset, Math.min(src.length, offset + 400));
  const hasTmp = /\.tmp\./.test(back) || /\.tmp\./.test(fwd);
  const hasRename = /fs\.renameSync\s*\(/.test(fwd);
  return hasTmp && hasRename;
}

function scanFile(absPath) {
  if (SCAN_SKIPLIST.has(absPath)) return [];
  const src = fs.readFileSync(absPath, 'utf8');
  const rel = relFromRepo(absPath);
  const findings = [];
  const targetVars = extractTargetVars(src);
  let m;
  CALL_RX.lastIndex = 0;
  while ((m = CALL_RX.exec(src)) !== null) {
    const offset = m.index;
    const windowText = callArgsWindow(src, offset);
    const targetClass = classifyTarget(windowText, targetVars);
    if (!targetClass) continue;
    // Exclude tmp→rename safe pattern — write to `*.tmp.*` then renameSync
    // within the next ~500 chars is the manual atomic idiom.
    if (looksLikeTmpThenRename(src, offset)) continue;
    const routed = siteIsRouted(src, offset);
    findings.push({
      file: rel,
      line: lineNumberAt(src, offset),
      op: 'writeFileSync',
      target: targetClass,
      routed,
      snippet: windowText.slice(0, 140).replace(/\s+/g, ' '),
    });
  }
  return findings;
}

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST_PATH)) return { version: 1, entries: [] };
  try {
    return JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  } catch {
    return { version: 1, entries: [] };
  }
}

function fingerprint(f) {
  return `${f.file}:${f.line}:${f.op}:${f.target}`;
}

function scanAll() {
  const files = SCAN_DIRS.flatMap(listJsFiles);
  const all = files.flatMap(scanFile);
  // Deduplicate — the same call site can register twice if someone wraps a
  // write in a helper that the regex sees as two.
  const seen = new Set();
  return all.filter((f) => {
    const k = fingerprint(f);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function diffAgainstAllowlist(findings, allowlist) {
  const allowed = new Set((allowlist.entries || []).map(fingerprint));
  const newViolations = findings.filter((f) => !f.routed && !allowed.has(fingerprint(f)));
  const stillMissing = (allowlist.entries || []).filter((entry) => {
    return !findings.some((f) => fingerprint(f) === fingerprint(entry));
  });
  return { newViolations, stillMissing };
}

function writeAllowlist(findings) {
  // Snapshot only unrouted findings — routed sites never need allowlisting.
  const entries = findings
    .filter((f) => !f.routed)
    .map((f) => ({ file: f.file, line: f.line, op: f.op, target: f.target }))
    .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
  const payload = {
    version: 1,
    description:
      'write-discipline baseline — every entry is a raw fs.writeFileSync/appendFileSync/renameSync targeting cobolt-state.json or _cobolt-output/ that has not yet been migrated to a canonical helper. New violations not in this list fail CI.',
    generatedAt: new Date().toISOString(),
    entries,
  };
  atomicWriteJSON(ALLOWLIST_PATH, payload, { mode: 0o600 });
  return entries.length;
}

function formatFindings(findings, heading) {
  if (findings.length === 0) return `  (none) — ${heading}\n`;
  const lines = [`  ${heading}: ${findings.length}`];
  for (const f of findings) {
    lines.push(`    ${f.file}:${f.line}  ${f.op}  [${f.target}]  ${f.snippet}`);
  }
  return `${lines.join('\n')}\n`;
}

function runScan(opts = {}) {
  const findings = scanAll();
  const allowlist = loadAllowlist();
  const { newViolations, stillMissing } = diffAgainstAllowlist(findings, allowlist);
  const routed = findings.filter((f) => f.routed);
  const allowed = findings.filter((f) => !f.routed && !newViolations.includes(f));

  if (opts.json) {
    const payload = {
      ok: newViolations.length === 0,
      total: findings.length,
      routed: routed.length,
      allowedBaseline: allowed.length,
      newViolations,
      stillMissingFromAllowlist: stillMissing,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const out = [];
    out.push('── CoBolt Write Discipline ─────────────────────────────────');
    out.push(`  Scanned: ${SCAN_DIRS.map(relFromRepo).join(', ')}`);
    out.push(`  Raw state/output writes found: ${findings.length}`);
    out.push(`    Routed through canonical helper: ${routed.length}`);
    out.push(`    In allowlist baseline: ${allowed.length}`);
    out.push(`    New violations (outside allowlist): ${newViolations.length}`);
    out.push('');
    out.push(formatFindings(newViolations, 'New violations'));
    if (stillMissing.length) {
      out.push(formatFindings(stillMissing, 'Allowlist entries no longer present (safe to snapshot)'));
    }
    process.stdout.write(`${out.join('\n')}\n`);
  }
  return newViolations.length === 0 ? 0 : 1;
}

function runSnapshot() {
  const findings = scanAll();
  const n = writeAllowlist(findings);
  process.stdout.write(`wrote ${n} entries to ${relFromRepo(ALLOWLIST_PATH)}\n`);
  return 0;
}

function runHelp() {
  process.stdout.write(
    [
      'cobolt-write-discipline — lint gate for state/artifact writes',
      '',
      'usage:',
      '  node tools/cobolt-write-discipline.js scan [--json]     # report violations',
      '  node tools/cobolt-write-discipline.js check [--json]    # alias for scan',
      '  node tools/cobolt-write-discipline.js snapshot          # refresh allowlist',
      '',
      'exit codes:',
      '  0  no new violations',
      '  1  new violations found',
      '  2  tool misuse',
      '',
    ].join('\n'),
  );
  return 0;
}

function main(argv) {
  const args = argv.slice(2);
  const cmd = (args[0] || 'scan').replace(/^--/, '');
  const json = args.includes('--json');

  try {
    switch (cmd) {
      case 'scan':
      case 'check':
        return runScan({ json });
      case 'snapshot':
      case 'baseline':
        return runSnapshot();
      case 'help':
      case 'h':
        return runHelp();
      default:
        process.stderr.write(`unknown command: ${cmd}\n`);
        runHelp();
        return 2;
    }
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    return 2;
  }
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { scanAll, loadAllowlist, diffAgainstAllowlist, fingerprint };
