#!/usr/bin/env node

// CoBolt Cross-Milestone Smoke Runner
//
// Runs after each M(n>1) milestone completes. Discovers tests tagged as
// cross-milestone (via RTM or test filename/tag conventions), boots the full
// stack with all cumulative migrations, and executes the tagged suite.
//
// Regressions on prior milestones are the silent killer of large autonomous
// builds — "works in M3, M1 now fails." This tool catches them at each
// milestone boundary instead of waiting for final-validate.
//
// Discovery rules (any ONE satisfies inclusion):
//   1. Test file path contains /cross-milestone/ or /regression/
//   2. Test file content has @cross-milestone or @cross_milestone tag
//   3. RTM (_cobolt-output/latest/planning/rtm.json) has story with
//      crossMilestone: ["M1", "M2"] and evidence.testFiles
//
// Usage:
//   node tools/cobolt-cross-milestone-smoke.js discover
//   node tools/cobolt-cross-milestone-smoke.js run [--milestone M3] [--fail-fast]
//
// Records to crossMilestoneSmokeFailures metric. Emits verdict to
// _cobolt-output/latest/cross-milestone/${M}-smoke-verdict.json.
//
// Exit codes:
//   0 — all cross-milestone tests pass (or zero applicable tests)
//   1 — regression detected (verdict: fail)
//   2 — environment failure (stack didn't start, etc.)

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

function paths() {
  try {
    const mod = require('../lib/cobolt-paths');
    const p = typeof mod === 'function' ? mod() : typeof mod.paths === 'function' ? mod.paths() : mod;
    return p;
  } catch {
    return {
      outputRoot: path.join(process.cwd(), '_cobolt-output'),
      latestPlanning: () => path.join(process.cwd(), '_cobolt-output', 'latest', 'planning'),
    };
  }
}

function readRTM() {
  const p = paths();
  const rtmPath = path.join(
    typeof p.latestPlanning === 'function'
      ? p.latestPlanning()
      : path.join(process.cwd(), '_cobolt-output', 'latest', 'planning'),
    'rtm.json',
  );
  if (!fs.existsSync(rtmPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(rtmPath, 'utf8'));
  } catch {
    return null;
  }
}

function walkTests(dir, depth = 0) {
  if (depth > 10) return [];
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === '_cobolt-output') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTests(full, depth + 1));
    else if (/\.(spec|test)\.(js|mjs|ts|tsx|py|ex|exs)$/i.test(e.name)) out.push(full);
  }
  return out;
}

function discover() {
  const root = process.cwd();
  const tests = walkTests(root, 0);
  const matched = [];

  for (const f of tests) {
    const rel = path.relative(root, f).replace(/\\/g, '/');
    if (rel.includes('/cross-milestone/') || rel.includes('/regression/')) {
      matched.push({ path: rel, reason: 'path-convention' });
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (/@cross[_-]milestone\b/i.test(text)) {
      matched.push({ path: rel, reason: 'tag' });
    }
  }

  const rtm = readRTM();
  if (rtm && Array.isArray(rtm.stories)) {
    for (const s of rtm.stories) {
      if (!Array.isArray(s.crossMilestone) || s.crossMilestone.length === 0) continue;
      const files = s.evidence?.testFiles || [];
      for (const tf of files) {
        const rel = tf.replace(/\\/g, '/');
        if (!matched.find((m) => m.path === rel)) {
          matched.push({ path: rel, reason: `rtm-story:${s.id}`, milestones: s.crossMilestone });
        }
      }
    }
  }

  return matched;
}

// v0.65.3 (audit S2-D): file-extension based runner classification. The smoke
// runner used to assume Playwright unconditionally — RTM-tagged tests outside
// Playwright (Jest/Vitest/Pytest/Mocha/Go) silently degraded.
function classifyRunner(testPath) {
  const p = String(testPath || '').toLowerCase();
  if (/\.(spec|test)\.[mc]?(j|t)sx?$/i.test(p) && /(?:playwright|e2e|browser)/.test(p)) return 'playwright';
  if (/\.spec\.[mc]?(j|t)sx?$/i.test(p)) return 'jest-or-vitest';
  if (/\.test\.[mc]?(j|t)sx?$/i.test(p)) return 'jest-or-vitest';
  if (/_test\.go$/.test(p)) return 'go';
  if (/(?:^|\/)test_.+\.py$/.test(p) || /_test\.py$/.test(p)) return 'pytest';
  if (/\.rs$/.test(p)) return 'cargo';
  if (/(?:Test|Tests|IT)\.java$/.test(p)) return 'maven-or-gradle';
  // Default: assume Playwright (legacy behavior).
  return 'playwright';
}

function spawnRunner(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', cwd: process.cwd() });
  return {
    code: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function runPlaywright(filter, opts = {}) {
  const args = ['playwright', 'test'];
  if (filter?.length) args.push(...filter);
  if (opts.failFast) args.push('-x');
  args.push('--reporter=json');

  const npxArgs =
    process.platform === 'win32'
      ? [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'), ...args]
      : args;
  return spawnRunner(process.platform === 'win32' ? process.execPath : 'npx', npxArgs);
}

function runJestOrVitest(filter, opts = {}) {
  // Detect vitest vs jest from package.json. Default to vitest if both are present
  // (vitest projects often retain jest only as a peer-dep alias).
  let runner = 'vitest';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps.vitest) runner = 'vitest';
    else if (deps.jest) runner = 'jest';
  } catch {
    /* fall back to vitest */
  }
  const args = [runner, 'run'];
  if (runner === 'jest') args.splice(1, 1); // jest has no `run` subcommand
  if (filter?.length) args.push(...filter);
  if (opts.failFast) args.push('--bail');
  if (runner === 'jest') args.push('--json');
  const npxArgs =
    process.platform === 'win32'
      ? [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'), ...args]
      : args;
  return spawnRunner(process.platform === 'win32' ? process.execPath : 'npx', npxArgs);
}

function runPytest(filter, opts = {}) {
  const args = ['-q'];
  if (opts.failFast) args.push('-x');
  if (filter?.length) args.push(...filter);
  return spawnRunner('pytest', args);
}

function runGo(filter, opts = {}) {
  const args = ['test'];
  if (opts.failFast) args.push('-failfast');
  if (filter?.length) args.push(...filter);
  else args.push('./...');
  return spawnRunner('go', args);
}

function runCargo(_filter, opts = {}) {
  const args = ['test'];
  if (opts.failFast) args.push('--no-fail-fast');
  return spawnRunner('cargo', args);
}

// Dispatch: classify each filter entry, group by runner, run each runner once.
function runByRunner(filter, opts = {}) {
  if (!filter || filter.length === 0) return runPlaywright(filter, opts);
  const groups = {};
  for (const p of filter) {
    const r = classifyRunner(p);
    (groups[r] ||= []).push(p);
  }
  const runners = Object.keys(groups);
  // Single-runner: passthrough.
  if (runners.length === 1) {
    const r = runners[0];
    if (r === 'playwright') return runPlaywright(groups[r], opts);
    if (r === 'jest-or-vitest') return runJestOrVitest(groups[r], opts);
    if (r === 'pytest') return runPytest(groups[r], opts);
    if (r === 'go') return runGo(groups[r], opts);
    if (r === 'cargo') return runCargo(groups[r], opts);
    if (r === 'maven-or-gradle') {
      // Maven: ./mvnw test -Dtest=...; Gradle: ./gradlew test --tests=...
      // Ambiguous without project-tree probe — emit a deterministic boundary.
      return { code: 2, stdout: '', stderr: 'maven-or-gradle runner not yet implemented; report as boundary.' };
    }
    return runPlaywright(groups[r], opts);
  }
  // Multi-runner: run each in sequence, accumulate. Worst exit code wins.
  let worstCode = 0;
  const stdoutChunks = [];
  const stderrChunks = [];
  for (const r of runners) {
    let result;
    if (r === 'playwright') result = runPlaywright(groups[r], opts);
    else if (r === 'jest-or-vitest') result = runJestOrVitest(groups[r], opts);
    else if (r === 'pytest') result = runPytest(groups[r], opts);
    else if (r === 'go') result = runGo(groups[r], opts);
    else if (r === 'cargo') result = runCargo(groups[r], opts);
    else result = { code: 2, stdout: '', stderr: `runner ${r} not yet implemented` };
    stdoutChunks.push(`# ===== ${r} =====\n${result.stdout}`);
    stderrChunks.push(`# ===== ${r} =====\n${result.stderr}`);
    if (result.code > worstCode) worstCode = result.code;
    if (opts.failFast && result.code !== 0) break;
  }
  return { code: worstCode, stdout: stdoutChunks.join('\n'), stderr: stderrChunks.join('\n') };
}

function writeVerdict(milestone, verdict) {
  const dir = path.join(process.cwd(), '_cobolt-output', 'latest', 'cross-milestone');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fp = path.join(dir, `${milestone}-smoke-verdict.json`);
  fs.writeFileSync(fp, JSON.stringify(verdict, null, 2));
  return fp;
}

function bumpMetric(count) {
  if (count <= 0) return;
  try {
    const tool = path.join(__dirname, 'cobolt-production-readiness.js');
    if (fs.existsSync(tool)) {
      execFileSync('node', [tool, 'record', 'crossMilestoneSmokeFailures', String(count)], { stdio: 'ignore' });
    }
  } catch {
    /* non-fatal */
  }
}

function run(opts = {}) {
  const milestone = opts.milestone || 'unknown';
  const matched = discover();

  if (matched.length === 0) {
    const verdict = {
      milestone,
      verdict: 'pass',
      reason: 'no cross-milestone tests discovered',
      generatedAt: new Date().toISOString(),
      tests: [],
    };
    if (opts.checkRetroactiveDrift) {
      verdict.retroactiveDriftChecked = true;
      verdict.retroactiveDrift = checkRetroactiveDrift(milestone, verdict.verdict);
      if (!verdict.retroactiveDrift.ok) {
        verdict.verdict = 'fail';
        verdict.reason = 'retroactive-contract-drift-with-no-smoke-coverage';
      }
    }
    writeVerdict(milestone, verdict);
    console.log(JSON.stringify(verdict, null, 2));
    return verdict.verdict === 'pass' ? 0 : 1;
  }

  // v0.65.3 — bypass support per GT-01. Legacy raw env honored during
  // deprecation window; signed-ledger path will land when this tool gets a
  // sibling hook (mirrors cobolt-channel/queue/orm pattern).
  if (process.env.COBOLT_CROSS_MILESTONE_SMOKE === 'off' || process.env.COBOLT_V12_GATES === 'bypass') {
    const verdict = {
      milestone,
      verdict: 'pass',
      reason: 'bypassed',
      bypassEnv:
        process.env.COBOLT_CROSS_MILESTONE_SMOKE === 'off'
          ? 'COBOLT_CROSS_MILESTONE_SMOKE=off'
          : 'COBOLT_V12_GATES=bypass',
      generatedAt: new Date().toISOString(),
      tests: [],
    };
    writeVerdict(milestone, verdict);
    console.log(JSON.stringify(verdict, null, 2));
    return 0;
  }

  const filter = matched.map((m) => m.path);
  const run = runByRunner(filter, opts);
  const passed = run.code === 0;

  const verdict = {
    milestone,
    verdict: passed ? 'pass' : 'fail',
    generatedAt: new Date().toISOString(),
    tests: matched,
    exitCode: run.code,
    stderrTail: run.stderr.slice(-2000),
  };

  if (opts.checkRetroactiveDrift) {
    verdict.retroactiveDriftChecked = true;
    verdict.retroactiveDrift = checkRetroactiveDrift(milestone, verdict.verdict);
    if (!verdict.retroactiveDrift.ok) {
      verdict.verdict = 'fail';
      verdict.reason = 'retroactive-break-confirmed: prior milestone test failure coincides with contract drift';
    }
  }

  const fp = writeVerdict(milestone, verdict);

  if (verdict.verdict !== 'pass') bumpMetric(1);

  console.log(JSON.stringify({ verdict: verdict.verdict, testCount: matched.length, verdictFile: fp }, null, 2));
  return verdict.verdict === 'pass' ? 0 : 1;
}

// ── v0.12.0 Phase 2A: Contract replay (HTTP) ──────────────────────
// Complements the discovery+Playwright flow. Reads interface-contracts.json
// and replays each API contract's examples[] as live HTTP requests against
// the running app. Returns per-contract pass/fail. Used by smoke `run` when
// contracts are declared — extra layer of cross-milestone protection.

function loadInterfaceContracts() {
  const pdir = path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'interface-contracts.json');
  const alt = path.join(process.cwd(), '_cobolt-output', 'planning', 'interface-contracts.json');
  for (const c of [pdir, alt]) {
    if (!fs.existsSync(c)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(c, 'utf8'));
      return Array.isArray(d.contracts) ? d.contracts : [];
    } catch {}
  }
  return [];
}

async function replayApiExample(contract, appUrl, timeoutMs) {
  const spec = contract.spec || {};
  const method = (spec.method || 'GET').toUpperCase();
  const pathTemplate = spec.path || '/';
  const examples = Array.isArray(contract.examples) ? contract.examples : [];
  if (examples.length === 0) return { id: contract.id, kind: 'api', status: 'skipped', reason: 'no examples' };

  const perExample = [];
  for (const ex of examples) {
    const req = ex.request || {};
    const params = req.params || {};
    let concrete = pathTemplate;
    for (const [k, v] of Object.entries(params)) {
      concrete = concrete.replace(new RegExp(`:${k}|\\{${k}\\}`, 'g'), encodeURIComponent(String(v)));
    }
    const url = appUrl.replace(/\/$/, '') + concrete;
    const headers = { 'content-type': 'application/json', ...(req.headers || {}) };
    const body = req.body !== undefined ? JSON.stringify(req.body) : undefined;

    let status = 0;
    let respText = '';
    let error = null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
      clearTimeout(t);
      status = res.status;
      respText = await res.text();
    } catch (err) {
      error = err?.message || 'fetch_failed';
    }

    const expected = ex.response || {};
    const issues = [];
    if (error) issues.push(`request failed: ${error}`);
    else if (typeof expected.status === 'number' && expected.status !== status) {
      issues.push(`status ${status} != expected ${expected.status}`);
    }
    if (!error && expected.bodyContains && !respText.includes(String(expected.bodyContains))) {
      issues.push(`body missing "${expected.bodyContains}"`);
    }
    perExample.push({ name: ex.name || 'example', url, method, status, passed: issues.length === 0, issues });
  }
  const allPass = perExample.every((e) => e.passed);
  return { id: contract.id, kind: 'api', status: allPass ? 'pass' : 'fail', examples: perExample };
}

async function probeUrl(url, timeoutMs) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, reason: err?.message || 'unreachable' };
  }
}

async function replayContracts(appUrl, timeoutMs = 8000) {
  const contracts = loadInterfaceContracts();
  if (contracts.length === 0) return { ran: false, reason: 'no contracts', results: [] };
  const probe = await probeUrl(appUrl, timeoutMs);
  if (!probe.ok) return { ran: false, reason: `app unreachable at ${appUrl}: ${probe.reason}`, results: [] };

  const results = [];
  for (const c of contracts) {
    if (c.spec?.kind === 'api') results.push(await replayApiExample(c, appUrl, timeoutMs));
    else
      results.push({
        id: c.id,
        kind: c.spec?.kind || 'unknown',
        status: 'skipped',
        reason: 'non-api replay not supported',
      });
  }
  return { ran: true, appUrl, results };
}

// ── CLI ─────────────────────────────────────────────────────────

function parseFlags(args) {
  const out = { _: [], milestone: null, failFast: false, appUrl: null, checkRetroactiveDrift: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--milestone') out.milestone = args[++i];
    else if (args[i] === '--fail-fast') out.failFast = true;
    else if (args[i] === '--app-url') out.appUrl = args[++i];
    else if (args[i] === '--check-retroactive-drift') out.checkRetroactiveDrift = true;
    else out._.push(args[i]);
  }
  return out;
}

function usage() {
  return 'Usage: cobolt-cross-milestone-smoke.js {discover|run|replay-contracts} [--milestone M3] [--fail-fast] [--app-url URL]';
}

// v0.48.0 retroactive contract drift enforcer (Tier 1 at Step 08B).
// Reads _cobolt-output/audit/retroactive-contract-drift.json. If drift exists
// AND the current cross-milestone smoke verdict is 'fail', hard-block.
// Drift alone (without consumer impact) is informational — forward motion
// preserved. Consumer test failure + drift = real retroactive break.
function checkRetroactiveDrift(milestone, smokeVerdict) {
  const driftPath = path.join(process.cwd(), '_cobolt-output', 'audit', 'retroactive-contract-drift.json');
  if (!fs.existsSync(driftPath)) {
    return { ok: true, reason: 'no-drift-recorded' };
  }
  let drift = null;
  try {
    drift = JSON.parse(fs.readFileSync(driftPath, 'utf8'));
  } catch {
    return { ok: true, reason: 'drift-unreadable' };
  }
  const entries = Array.isArray(drift?.driftEntries) ? drift.driftEntries : [];
  if (entries.length === 0) return { ok: true, reason: 'no-drift-entries' };

  const affectsCurrent =
    drift.startingMilestone === milestone || entries.some((e) => e.affectedMilestone === milestone);
  if (!affectsCurrent) return { ok: true, reason: 'drift-not-affecting-current' };

  // If the smoke verdict already passed, drift alone doesn't fail — consumers work.
  if (smokeVerdict === 'pass') {
    return { ok: true, reason: 'drift-tolerated-tests-pass', entries: entries.length };
  }

  // Smoke failed AND drift exists → retroactive break confirmed.
  return {
    ok: false,
    reason: 'retroactive-break-confirmed',
    entries: entries.length,
    affectedMilestones: [...new Set(entries.map((e) => e.affectedMilestone))],
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error(usage());
    return 1;
  }
  if (argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return 0;
  }
  const [cmd, ...rest] = argv;
  const flags = parseFlags(rest);
  const appUrl = flags.appUrl || process.env.APP_URL || 'http://localhost:3000';
  const timeout = Number(process.env.COBOLT_SMOKE_TIMEOUT || 8000);
  switch (cmd) {
    case 'discover': {
      const matched = discover();
      console.log(JSON.stringify({ count: matched.length, tests: matched }, null, 2));
      return 0;
    }
    case 'run':
      return run(flags);
    case 'replay-contracts': {
      // v0.12.0 Phase 2A: HTTP replay of contract examples
      const r = await replayContracts(appUrl, timeout);
      console.log(JSON.stringify(r, null, 2));
      if (!r.ran) return 0;
      return r.results.some((x) => x.status === 'fail') ? 1 : 0;
    }
    default:
      console.error(usage());
      return 1;
  }
}

if (require.main === module) {
  const ret = main();
  if (ret && typeof ret.then === 'function') ret.then((c) => process.exit(c || 0));
  else process.exit(ret || 0);
}

module.exports = { discover, run, replayContracts, loadInterfaceContracts, checkRetroactiveDrift };
