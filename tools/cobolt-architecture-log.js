#!/usr/bin/env node

// CoBolt Living Architecture Log
//
// After each milestone, append an "actuals" snapshot to
// _cobolt-output/reports/architecture-log.md:
//   - actually-implemented endpoints (from interface-contracts satisfied set)
//   - actual schema changes (from migrations added this milestone)
//   - actual events (from event publisher/subscriber scans)
//
// Next milestone's planning can then ground on what actually exists, not
// what the original architecture doc said would exist.
//
// Tier 8.1 (v0.11.0).
//
// Usage:
//   node tools/cobolt-architecture-log.js append [--milestone M3]
//   node tools/cobolt-architecture-log.js show

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const USAGE = [
  'Usage:',
  '  node tools/cobolt-architecture-log.js append --milestone M3',
  '  node tools/cobolt-architecture-log.js show',
].join('\n');

function paths() {
  try {
    const mod = require('../lib/cobolt-paths');
    return typeof mod === 'function' ? mod() : typeof mod.paths === 'function' ? mod.paths() : mod;
  } catch {
    return {};
  }
}

function logFile() {
  const p = paths();
  const reportsRoot = p.reports?.() || path.join(process.cwd(), '_cobolt-output', 'reports');
  if (!fs.existsSync(reportsRoot)) fs.mkdirSync(reportsRoot, { recursive: true, mode: 0o700 });
  return path.join(reportsRoot, 'architecture-log.md');
}

function gatherActuals(milestone) {
  const root = process.cwd();
  const result = {
    milestone,
    generatedAt: new Date().toISOString(),
    endpoints: [],
    migrations: [],
    events: [],
    contracts: { satisfied: 0, violating: 0 },
  };

  // Endpoints — from contract verifier
  try {
    const tool = path.join(root, 'tools', 'cobolt-contract-verify.js');
    if (fs.existsSync(tool)) {
      const out = execFileSync('node', [tool, 'verify', '--milestone', milestone], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const parsed = JSON.parse(out || '{}');
      result.contracts.satisfied = (parsed.satisfied || []).length;
      result.contracts.violating = (parsed.violations || []).length;
      for (const s of parsed.satisfied || []) result.endpoints.push({ id: s.id, evidence: (s.evidence || [])[0] });
    }
  } catch {
    /* non-fatal */
  }

  // Migrations — files added this milestone
  try {
    const since = `HEAD~${Number(String(milestone).replace(/^M/, '')) * 3 || 1}`;
    const diff = execFileSync('git', ['diff', '--name-only', '--diff-filter=A', since], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    result.migrations = diff
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => /migrations|migrate/.test(s))
      .filter((s) => /\.(sql|exs|ex|rb)$/i.test(s));
  } catch {
    /* non-fatal */
  }

  // Events — scan code for publish patterns
  const events = new Set();
  const eventPattern = /\b(publish|emit|broadcast)\s*\(\s*['"`]([a-z][a-z0-9_]*\.[a-z0-9_]+\.[a-z0-9_]+)['"`]/gi;
  function walk(d, depth = 0) {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (['node_modules', '.git', '_cobolt-output', 'dist', '.next'].includes(e.name) || e.name.startsWith('.'))
        continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(js|mjs|cjs|ts|tsx|ex|exs|py|go|rs|rb)$/i.test(e.name)) {
        let text;
        try {
          text = fs.readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        let m;
        eventPattern.lastIndex = 0;
        while ((m = eventPattern.exec(text)) !== null) events.add(m[2]);
      }
    }
  }
  walk(root);
  result.events = [...events].sort();

  return result;
}

function renderMarkdown(entry) {
  const lines = [];
  lines.push(`## ${entry.milestone} — ${entry.generatedAt}`);
  lines.push('');
  lines.push(`**Interface contracts:** ${entry.contracts.satisfied} satisfied, ${entry.contracts.violating} violating`);
  lines.push('');
  if (entry.endpoints.length > 0) {
    lines.push('### Endpoints (verified against contracts)');
    lines.push('');
    for (const e of entry.endpoints.slice(0, 30)) {
      lines.push(`- \`${e.id}\`${e.evidence ? ` — ${e.evidence}` : ''}`);
    }
    if (entry.endpoints.length > 30) lines.push(`- _…and ${entry.endpoints.length - 30} more_`);
    lines.push('');
  }
  if (entry.migrations.length > 0) {
    lines.push('### Migrations added');
    lines.push('');
    for (const m of entry.migrations.slice(0, 20)) lines.push(`- \`${m}\``);
    if (entry.migrations.length > 20) lines.push(`- _…and ${entry.migrations.length - 20} more_`);
    lines.push('');
  }
  if (entry.events.length > 0) {
    lines.push('### Events published');
    lines.push('');
    for (const e of entry.events.slice(0, 30)) lines.push(`- \`${e}\``);
    if (entry.events.length > 30) lines.push(`- _…and ${entry.events.length - 30} more_`);
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

function append(milestone) {
  if (!milestone) throw new Error('--milestone required');
  const entry = gatherActuals(milestone);
  const md = renderMarkdown(entry);
  const fp = logFile();
  const header = fs.existsSync(fp)
    ? ''
    : '# Living Architecture Log\n\nAppended after each milestone by `cobolt-architecture-log append`. Input to next milestone planning — reflects what actually exists, not what the original architecture doc said would exist.\n\n---\n\n';
  fs.appendFileSync(fp, header + md);
  console.log(
    JSON.stringify(
      {
        ok: true,
        milestone,
        file: fp,
        endpoints: entry.endpoints.length,
        migrations: entry.migrations.length,
        events: entry.events.length,
      },
      null,
      2,
    ),
  );
  return 0;
}

function show() {
  const fp = logFile();
  if (!fs.existsSync(fp)) {
    console.log('(no architecture log yet)');
    return 0;
  }
  process.stdout.write(fs.readFileSync(fp, 'utf8'));
  return 0;
}

function parseFlags(args) {
  const out = { _: [], milestone: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--milestone') out.milestone = args[++i];
    else out._.push(args[i]);
  }
  return out;
}

function usage(code) {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(`${USAGE}\n`);
  return code;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) return usage(1);

  const [cmd, ...rest] = argv;
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') return usage(0);

  const flags = parseFlags(rest);
  try {
    switch (cmd) {
      case 'append':
        return append(flags.milestone);
      case 'show':
        return show();
      default:
        return usage(1);
    }
  } catch (err) {
    console.error(`[cobolt-architecture-log] ${err.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { append, gatherActuals };
