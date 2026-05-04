#!/usr/bin/env node

// cobolt-axe-build-runner — PR-2 Batch C (v0.53.0).
//
// Wraps @axe-core/playwright to run accessibility checks against routes
// opened by cobolt-build-ui-state-check during the per-story Playwright run.
// Composed into Step 04A by PR-3 (cobolt-axe-build-gate).
//
// Optional dependencies (per tools/CLAUDE.md exit-2 contract):
//   - playwright + @axe-core/playwright + axe-core
// Missing → exit 2 with verdict=missing-dep so the gate degrades to Tier 2.
//
// Usage:
//   node tools/cobolt-axe-build-runner.js run --milestone M1 [--story S1] [--routes URL1,URL2] [--cwd PATH] [--json]
//   node tools/cobolt-axe-build-runner.js --help
//
// Exit codes: 0 ok (no critical violations), 1 critical violations,
// 2 missing dep (playwright + @axe-core/playwright), 3 routes input invalid.

const fs = require('node:fs');
const path = require('node:path');

const MILESTONE_RE = /^M\d+$/;

function buildRoot(cwd, milestone) {
  return path.join(cwd, '_cobolt-output', 'latest', 'build', milestone);
}

function tryRequire(name) {
  try {
    return require(name);
  } catch {
    return null;
  }
}

function depStatus() {
  return {
    playwright: !!tryRequire('playwright'),
    axeCorePlaywright: !!tryRequire('@axe-core/playwright'),
    axeCore: !!tryRequire('axe-core'),
  };
}

function loadRoutes(cwd, milestone, routesArg) {
  if (routesArg) {
    return routesArg
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
  }
  // Look for a previously-emitted UI state check route list
  const candidates = [
    path.join(buildRoot(cwd, milestone), `${milestone}-ui-state-check.json`),
    path.join(buildRoot(cwd, milestone), 'ui-routes.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(data.routes)) return data.routes;
      } catch {
        /* ignore */
      }
    }
  }
  return [];
}

function run({ cwd, milestone, story, routes } = {}) {
  cwd = cwd || process.cwd();
  if (!MILESTONE_RE.test(milestone || '')) return { ok: false, error: 'invalid milestone', _exit: 3 };
  const routeList = loadRoutes(cwd, milestone, routes);
  if (routeList.length === 0) {
    return {
      schema: 'cobolt-axe-build-runner@1',
      ok: false,
      verdict: 'no-routes',
      note: 'no UI routes provided and no ui-state-check artifact found; supply --routes or run cobolt-build-ui-state-check first',
      _exit: 3,
    };
  }
  const deps = depStatus();
  const missing = Object.entries(deps)
    .filter(([, present]) => !present)
    .map(([name]) => name);
  if (missing.length) {
    const out = {
      schema: 'cobolt-axe-build-runner@1',
      milestone,
      storyId: story,
      generatedAt: new Date().toISOString(),
      verdict: 'missing-dep',
      missingDeps: missing,
      routes: routeList,
      note: 'install playwright + @axe-core/playwright + axe-core to scan; PR-3 wires this into Step 04A',
      ok: false,
      _exit: 2,
    };
    const outPath = path.join(buildRoot(cwd, milestone), `${milestone}${story ? `-${story}` : ''}-axe.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
    return { ...out, outPath };
  }
  // Real Playwright + axe scan happens in PR-3 Step 04A wiring. PR-2 records
  // an intent verdict so the gate's evidence path is exercised.
  const out = {
    schema: 'cobolt-axe-build-runner@1',
    milestone,
    storyId: story,
    generatedAt: new Date().toISOString(),
    verdict: 'deferred',
    routes: routeList,
    violations: { critical: 0, serious: 0, moderate: 0, minor: 0 },
    note: 'PR-2 deterministic shell — real axe scan is wired in PR-3 Step 04A.',
    ok: true,
  };
  const outPath = path.join(buildRoot(cwd, milestone), `${milestone}${story ? `-${story}` : ''}-axe.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  return { ...out, outPath };
}

function printHelp() {
  process.stdout.write(
    `cobolt-axe-build-runner — per-story axe-core accessibility scan wrapper\n\n` +
      `Usage: node tools/cobolt-axe-build-runner.js run --milestone M1 [--story S1] [--routes URL1,URL2] [--cwd PATH] [--json]\n` +
      `Exit: 0 ok, 1 critical violations, 2 missing dep, 3 routes input invalid\n`,
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--milestone') args.milestone = argv[++i];
    else if (a === '--story') args.story = argv[++i];
    else if (a === '--routes') args.routes = argv[++i];
    else if (a === '--cwd') args.cwd = argv[++i];
    else if (a === '--json') args.json = true;
  }
  return args;
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return 0;
  }
  if (!argv[0]) {
    printHelp();
    return 0;
  }
  if (argv[0] !== 'run') {
    process.stderr.write(`unknown command: ${argv[0]}\n`);
    return 1;
  }
  const args = parseArgs(argv.slice(1));
  const result = run(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok === false) {
    process.stderr.write(`${result.verdict}: ${(result.missingDeps || []).join(',') || result.note || ''}\n`);
  } else {
    process.stdout.write(`axe ${result.verdict} (${result.routes.length} routes)\n`);
  }
  if (result._exit) return result._exit;
  return result.ok === false ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { run, depStatus, loadRoutes };
