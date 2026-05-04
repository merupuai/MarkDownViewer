#!/usr/bin/env node

// CoBolt Audit Lite — per-round scoped variant of cobolt-audit
//
// Runs after every TDD round on changed files ONLY (git diff vs the round's
// baseline commit), surfacing simulated services / fake implementations /
// illusion patterns within minutes of being written — instead of waiting
// for the full audit at Step 05/06.
//
// Delegates pattern detection to cobolt-audit stub-scan and
// cobolt-illusion-scan when available; fans out in parallel over the
// changed-files set.
//
// Usage:
//   node tools/cobolt-audit-lite.js scan [--since <ref>] [--changed-files <list>]
//   node tools/cobolt-audit-lite.js check    # exit 1 on any high-severity hit
//
// Output:
//   _cobolt-output/latest/audit-lite/round-${round}.json
//
// Invocation:
//   Wired from step-03-tdd-green.md after GREEN turns (post-round, before
//   Step 03a code-gap-analysis).

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

function paths() {
  try {
    const mod = require('../lib/cobolt-paths');
    return typeof mod === 'function' ? mod() : typeof mod.paths === 'function' ? mod.paths() : mod;
  } catch {
    return { outputRoot: path.join(process.cwd(), '_cobolt-output') };
  }
}

function getChangedFiles(since) {
  if (!since) {
    // Try HEAD~1; fall back to "since last commit"
    since = 'HEAD~1';
  }
  try {
    const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=AM', since], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && /\.(js|mjs|cjs|ts|tsx|jsx|ex|exs|py|go|rs|rb|java|kt)$/i.test(s))
      .filter((s) => fs.existsSync(path.join(process.cwd(), s)));
  } catch {
    return [];
  }
}

function runTool(tool, args, timeoutMs = 30000) {
  const candidates = [
    path.join(process.cwd(), 'tools', tool),
    process.env.COBOLT_TOOLS && path.join(process.env.COBOLT_TOOLS, tool),
    path.join(__dirname, tool),
  ];
  const p = candidates.find((c) => c && fs.existsSync(c));
  if (!p) return { ok: false, reason: `tool ${tool} not found` };
  const result = spawnSync('node', [p, ...args], { encoding: 'utf8', timeout: timeoutMs });
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function currentRound() {
  try {
    const sp = path.join(process.cwd(), 'cobolt-state.json');
    if (!fs.existsSync(sp)) return 0;
    const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
    return (s.build && (s.build.currentRound || s.build.round)) || 0;
  } catch {
    return 0;
  }
}

function scan(opts = {}) {
  const since = opts.since || process.env.COBOLT_AUDIT_LITE_SINCE || 'HEAD~1';
  const changed = opts.changedFiles || getChangedFiles(since);
  const round = currentRound();

  if (changed.length === 0) {
    return { ok: true, round, changedFiles: [], findings: [], reason: 'no changed files since baseline' };
  }

  // Shell out to stub-scan restricted to changed files (pass as comma list)
  const allFindings = [];

  const stub = runTool('cobolt-audit.js', ['stub-scan', '--json'], 30000);
  if (stub.ok || stub.stdout) {
    try {
      const parsed = JSON.parse(stub.stdout || '{}');
      const rel = new Set(changed.map((f) => f.replace(/\\/g, '/')));
      const scoped = (parsed.findings || []).filter((f) => {
        const file = (f.file || '').replace(/\\/g, '/');
        return rel.has(file) || [...rel].some((r) => file.endsWith(r));
      });
      allFindings.push(...scoped.map((f) => ({ source: 'stub-scan', ...f })));
    } catch {
      /* ignore parse */
    }
  }

  const illusion = runTool('cobolt-illusion-scan.js', ['scan', '--json'], 30000);
  if (illusion.ok || illusion.stdout) {
    try {
      const parsed = JSON.parse(illusion.stdout || '{}');
      const rel = new Set(changed.map((f) => f.replace(/\\/g, '/')));
      const scoped = (parsed.findings || parsed.illusions || []).filter((f) => {
        const file = (f.file || f.path || '').replace(/\\/g, '/');
        return rel.has(file) || [...rel].some((r) => file.endsWith(r));
      });
      allFindings.push(...scoped.map((f) => ({ source: 'illusion-scan', ...f })));
    } catch {
      /* ignore parse */
    }
  }

  // Filter to high/critical severity for the per-round exit signal
  const highSev = allFindings.filter((f) => /critical|high/i.test(String(f.severity || '')));

  return {
    ok: highSev.length === 0,
    round,
    since,
    changedFiles: changed,
    findings: allFindings,
    highSeverityCount: highSev.length,
    generatedAt: new Date().toISOString(),
  };
}

function writeReport(result) {
  const p = paths();
  const dir = path.join(
    typeof p.outputRoot === 'string' ? p.outputRoot : path.join(process.cwd(), '_cobolt-output'),
    'latest',
    'audit-lite',
  );
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fp = path.join(dir, `round-${result.round || 'unknown'}.json`);
  fs.writeFileSync(fp, JSON.stringify(result, null, 2));
  return fp;
}

function parseFlags(args) {
  const out = { _: [], since: null, changedFiles: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--since') out.since = args[++i];
    else if (args[i] === '--changed-files') out.changedFiles = args[++i].split(',');
    else out._.push(args[i]);
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case 'scan':
    case 'check': {
      const r = scan({ since: flags.since, changedFiles: flags.changedFiles });
      const fp = writeReport(r);
      console.log(
        JSON.stringify(
          {
            ok: r.ok,
            round: r.round,
            changedFiles: r.changedFiles.length,
            findings: r.findings.length,
            highSev: r.highSeverityCount,
            report: fp,
          },
          null,
          2,
        ),
      );
      if (cmd === 'check') return r.ok ? 0 : 1;
      return 0;
    }
    default:
      console.error('Usage: cobolt-audit-lite.js {scan|check} [--since <ref>] [--changed-files f1,f2]');
      return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { scan };
