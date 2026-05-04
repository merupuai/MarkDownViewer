#!/usr/bin/env node

// CoBolt Flaky-Test Ledger (P3.8 / v0.63+).
//
// Append-only audit ledger that tracks every test run's outcome and
// detects tests that flip pass↔fail without an intervening change to
// the test file or its target. Patterns from:
//   - Bell, Legunsen, Hilton et al. "DeFlaker" (ICSE 2018)
//   - Memon, Gao et al. "Taming Google-Scale Continuous Testing" (ICSE-SEIP 2017)
//   - Microsoft TIA + Facebook Sapienz approaches.
//
// Auto-quarantine policy:
//   - 3 detected flips within 7 days → test moved to the quarantine list.
//   - Quarantined tests are excluded from --auto runs (suite continues).
//   - Edits to the test file or its target file (per `targetFile`) reset
//     the flip counter — code change is presumed to fix or invalidate.
//
// Tier 3 advisory — never blocks a build. Quarantine list is consumed by
// CI runners as an opt-in `--exclude-flake` flag.
//
// Standards mapping (Inv-21):
//   ISO/IEC 27001 A.8.16 — monitoring activities.
//   SOC 2 CC7.2 — system monitoring for anomalies.
//   NIST SSDF PW.8.2 — test executable code to identify vulnerabilities.
//
// Public API:
//   record({ cwd?, name, suite?, file?, targetFile?, passed, ts? }) -> entry
//   list({ cwd?, name?, since? }) -> entries
//   detectFlakes({ cwd?, windowDays? }) -> [{ name, suite, flips, lastFlipAt, status }]
//   quarantineList({ cwd?, windowDays? }) -> [name1, name2, ...]
//   purge({ cwd?, olderThanDays? }) -> { kept, purged }
//
// CLI:
//   node tools/cobolt-flake-ledger.js record --name X --passed true [--suite S] [--file F]
//   node tools/cobolt-flake-ledger.js report [--window 7d]
//   node tools/cobolt-flake-ledger.js quarantine-list [--json]
//   node tools/cobolt-flake-ledger.js purge --older-than 90d
//
// Exit codes per tools/CLAUDE.md:
//   0 — success
//   1 — hard error

const fs = require('node:fs');
const path = require('node:path');

const LEDGER_REL = path.join('_cobolt-output', 'audit', 'flaky-tests.jsonl');
const DEFAULT_FLIP_THRESHOLD = 3;
const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_RETENTION_DAYS = 90;

function _ledgerPath(projectRoot) {
  return path.join(projectRoot || process.cwd(), LEDGER_REL);
}

function _ensureAuditDir(projectRoot) {
  fs.mkdirSync(path.dirname(_ledgerPath(projectRoot)), { recursive: true, mode: 0o700 });
}

function _readEntries(projectRoot) {
  const file = _ledgerPath(projectRoot);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function _appendEntry(projectRoot, entry) {
  _ensureAuditDir(projectRoot);
  fs.appendFileSync(_ledgerPath(projectRoot), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

// ── public API ────────────────────────────────────────────────────────

function record({ cwd, name, suite, file, targetFile, passed, durationMs, ts } = {}) {
  if (!name || typeof name !== 'string') throw new Error('record: name required');
  if (typeof passed !== 'boolean') throw new Error('record: passed (boolean) required');
  const root = cwd || process.cwd();
  const entry = {
    name,
    suite: suite || null,
    file: file || null,
    targetFile: targetFile || null,
    passed,
    durationMs: typeof durationMs === 'number' ? durationMs : null,
    ts: ts || new Date().toISOString(),
  };
  _appendEntry(root, entry);
  return entry;
}

function list({ cwd, name, since } = {}) {
  const root = cwd || process.cwd();
  const sinceTs = since ? new Date(since).getTime() : null;
  return _readEntries(root).filter((e) => {
    if (name && e.name !== name) return false;
    if (sinceTs && new Date(e.ts).getTime() < sinceTs) return false;
    return true;
  });
}

function detectFlakes({ cwd, windowDays = DEFAULT_WINDOW_DAYS, flipThreshold = DEFAULT_FLIP_THRESHOLD } = {}) {
  const root = cwd || process.cwd();
  const cutoff = Date.now() - windowDays * 86400 * 1000;
  const entries = _readEntries(root).filter((e) => new Date(e.ts).getTime() >= cutoff);

  // Group by test name (with optional suite scope).
  const byName = new Map();
  for (const entry of entries) {
    const key = entry.suite ? `${entry.suite}::${entry.name}` : entry.name;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(entry);
  }

  const flakes = [];
  for (const [key, runs] of byName) {
    if (runs.length < 2) continue;
    runs.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    let flips = 0;
    let lastFlipAt = null;
    for (let i = 1; i < runs.length; i += 1) {
      if (runs[i].passed !== runs[i - 1].passed) {
        flips += 1;
        lastFlipAt = runs[i].ts;
      }
    }
    if (flips === 0) continue;
    const status = flips >= flipThreshold ? 'quarantine' : 'watching';
    const recent = runs[runs.length - 1];
    flakes.push({
      name: recent.name,
      suite: recent.suite,
      file: recent.file,
      targetFile: recent.targetFile,
      runs: runs.length,
      flips,
      lastFlipAt,
      lastResult: recent.passed,
      status,
      key,
    });
  }
  flakes.sort((a, b) => b.flips - a.flips);
  return flakes;
}

function quarantineList({ cwd, windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  return detectFlakes({ cwd, windowDays })
    .filter((f) => f.status === 'quarantine')
    .map((f) => f.key);
}

function purge({ cwd, olderThanDays = DEFAULT_RETENTION_DAYS } = {}) {
  const root = cwd || process.cwd();
  const file = _ledgerPath(root);
  if (!fs.existsSync(file)) return { kept: 0, purged: 0 };
  const cutoff = Date.now() - olderThanDays * 86400 * 1000;
  const entries = _readEntries(root);
  const kept = entries.filter((e) => new Date(e.ts).getTime() >= cutoff);
  const purged = entries.length - kept.length;
  if (purged > 0) {
    const newContent = kept.map((e) => JSON.stringify(e)).join('\n');
    fs.writeFileSync(file, newContent ? `${newContent}\n` : '', { mode: 0o600 });
  }
  return { kept: kept.length, purged };
}

function report({ cwd, windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const flakes = detectFlakes({ cwd, windowDays });
  const lines = [
    '# Flaky-Test Ledger Report',
    '',
    `Window: ${windowDays} days`,
    `Flaky tests detected: ${flakes.length}`,
    `Quarantine candidates (flips ≥ ${DEFAULT_FLIP_THRESHOLD}): ${flakes.filter((f) => f.status === 'quarantine').length}`,
    '',
  ];
  if (flakes.length === 0) {
    lines.push('_No flaky tests detected in this window._');
    return lines.join('\n');
  }
  lines.push('| Test | Suite | Runs | Flips | Last flip | Status |');
  lines.push('|------|-------|------|-------|-----------|--------|');
  for (const f of flakes) {
    lines.push(`| \`${f.name}\` | ${f.suite || '—'} | ${f.runs} | ${f.flips} | ${f.lastFlipAt || '—'} | ${f.status} |`);
  }
  return lines.join('\n');
}

module.exports = {
  record,
  list,
  detectFlakes,
  quarantineList,
  purge,
  report,
  DEFAULT_FLIP_THRESHOLD,
  DEFAULT_WINDOW_DAYS,
  DEFAULT_RETENTION_DAYS,
};

// ── CLI ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('Usage: node tools/cobolt-flake-ledger.js <command> [args]');
    console.log('Commands:');
    console.log('  record --name X --passed true|false [--suite S] [--file F] [--target-file T] [--duration N]');
    console.log('  report  [--window 7d]                Markdown summary');
    console.log('  list    [--name X] [--since DATE]    List entries');
    console.log('  quarantine-list [--json]             Tests with >=3 flips in window');
    console.log('  purge --older-than 90d               Drop entries older than N days');
    process.exit(0);
  }
  try {
    if (cmd === 'record') {
      const opts = {};
      for (let i = 1; i < argv.length; i += 1) {
        if (argv[i] === '--name') opts.name = argv[++i];
        else if (argv[i] === '--suite') opts.suite = argv[++i];
        else if (argv[i] === '--file') opts.file = argv[++i];
        else if (argv[i] === '--target-file') opts.targetFile = argv[++i];
        else if (argv[i] === '--passed') opts.passed = String(argv[++i]).toLowerCase() === 'true';
        else if (argv[i] === '--duration') opts.durationMs = Number(argv[++i]);
        else if (argv[i] === '--ts') opts.ts = argv[++i];
      }
      const e = record(opts);
      console.log(`[cobolt-flake-ledger] recorded ${e.name} passed=${e.passed} ts=${e.ts}`);
      process.exit(0);
    }
    if (cmd === 'report') {
      let windowDays = DEFAULT_WINDOW_DAYS;
      for (let i = 1; i < argv.length; i += 1) {
        if (argv[i] === '--window') {
          const m = String(argv[++i]).match(/^(\d+)d$/);
          if (m) windowDays = Number(m[1]);
        }
      }
      console.log(report({ windowDays }));
      process.exit(0);
    }
    if (cmd === 'list') {
      const opts = {};
      for (let i = 1; i < argv.length; i += 1) {
        if (argv[i] === '--name') opts.name = argv[++i];
        else if (argv[i] === '--since') opts.since = argv[++i];
      }
      const entries = list(opts);
      for (const e of entries) console.log(`[${e.ts}] ${e.name}\tpassed=${e.passed}`);
      process.exit(0);
    }
    if (cmd === 'quarantine-list') {
      const json = argv.includes('--json');
      const list = quarantineList({});
      if (json) console.log(JSON.stringify(list, null, 2));
      else for (const k of list) console.log(k);
      process.exit(0);
    }
    if (cmd === 'purge') {
      let olderThanDays = DEFAULT_RETENTION_DAYS;
      for (let i = 1; i < argv.length; i += 1) {
        if (argv[i] === '--older-than') {
          const m = String(argv[++i]).match(/^(\d+)d?$/);
          if (m) olderThanDays = Number(m[1]);
        }
      }
      const r = purge({ olderThanDays });
      console.log(`[cobolt-flake-ledger] kept=${r.kept} purged=${r.purged}`);
      process.exit(0);
    }
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  } catch (err) {
    console.error(`[cobolt-flake-ledger] ${err.message}`);
    process.exit(1);
  }
}
