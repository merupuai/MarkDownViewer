#!/usr/bin/env node

// cobolt-story-visual-diff — PR-2 Batch C (v0.53.0).
//
// Reads M{n}-S{y}-visual-baseline.json and either captures (first-pass when
// baselineSource=prior-render) or compares per-viewport screenshots.
//
// Optional dependencies (per the tools/CLAUDE.md exit-2 contract):
//   - playwright (for actual screenshot capture). Missing → exit 2.
//   - pngjs + pixelmatch (for pixel-level diff). Missing → exit 2.
// PR-2 ships the deterministic harness. PR-3 step 03B wires real captures
// once playwright + pixelmatch are pinned in package.json.
//
// Usage:
//   node tools/cobolt-story-visual-diff.js capture --milestone M1 --story S1 [--cwd PATH] [--json]
//   node tools/cobolt-story-visual-diff.js diff    --milestone M1 --story S1 [--cwd PATH] [--json]
//   node tools/cobolt-story-visual-diff.js --help
//
// Exit codes: 0 pass, 1 diff exceeded threshold, 2 missing dep (playwright /
// pixelmatch / pngjs), 3 missing baseline manifest.

const fs = require('node:fs');
const path = require('node:path');

const MILESTONE_RE = /^M\d+$/;
const STORY_ID_RE = /^(S\d+|E\d+-S\d+)$/;

function buildRoot(cwd, milestone) {
  return path.join(cwd, '_cobolt-output', 'latest', 'build', milestone);
}

function baselineManifestPath(cwd, milestone, story) {
  return path.join(buildRoot(cwd, milestone), `${milestone}-${story}-visual-baseline.json`);
}

function readBaseline(cwd, milestone, story) {
  const p = baselineManifestPath(cwd, milestone, story);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
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
    pngjs: !!tryRequire('pngjs'),
    pixelmatch: !!tryRequire('pixelmatch'),
  };
}

function capture({ cwd, milestone, story } = {}) {
  cwd = cwd || process.cwd();
  if (!MILESTONE_RE.test(milestone || '')) return { ok: false, error: 'invalid milestone', _exit: 1 };
  if (!STORY_ID_RE.test(story || '')) return { ok: false, error: 'invalid story', _exit: 1 };
  const baseline = readBaseline(cwd, milestone, story);
  if (!baseline)
    return { ok: false, error: `no baseline manifest at ${baselineManifestPath(cwd, milestone, story)}`, _exit: 3 };
  const deps = depStatus();
  if (!deps.playwright) {
    return {
      schema: 'cobolt-story-visual-diff@1',
      ok: false,
      verdict: 'missing-dep',
      missingDeps: ['playwright'],
      note: 'install playwright to capture; PR-3 wires this into Step 03B',
      _exit: 2,
    };
  }
  // Capture path is wired in PR-3; for PR-2 we record an intent record.
  const out = {
    schema: 'cobolt-story-visual-diff@1',
    milestone,
    storyId: story,
    generatedAt: new Date().toISOString(),
    baselineSource: baseline.baselineSource,
    viewports: baseline.viewports.map((v) => ({
      route: v.route,
      width: v.width,
      height: v.height,
      baselinePath: v.baselinePath,
      capture: 'pending-step-03b-wiring',
    })),
    status: 'capture-deferred',
  };
  const outPath = path.join(buildRoot(cwd, milestone), `${milestone}-${story}-visual-diff.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  return { ...out, outPath, ok: true };
}

function diff({ cwd, milestone, story } = {}) {
  cwd = cwd || process.cwd();
  if (!MILESTONE_RE.test(milestone || '')) return { ok: false, error: 'invalid milestone', _exit: 1 };
  if (!STORY_ID_RE.test(story || '')) return { ok: false, error: 'invalid story', _exit: 1 };
  const baseline = readBaseline(cwd, milestone, story);
  if (!baseline) return { ok: false, error: `no baseline manifest`, _exit: 3 };
  const deps = depStatus();
  if (!deps.pngjs || !deps.pixelmatch) {
    return {
      schema: 'cobolt-story-visual-diff@1',
      ok: false,
      verdict: 'missing-dep',
      missingDeps: [!deps.pngjs && 'pngjs', !deps.pixelmatch && 'pixelmatch'].filter(Boolean),
      note: 'install pngjs + pixelmatch to compare; PR-3 wires this into Step 03B',
      _exit: 2,
    };
  }
  // Real diff path lands in PR-3. PR-2 emits a deterministic shell verdict.
  const out = {
    schema: 'cobolt-story-visual-diff@1',
    milestone,
    storyId: story,
    generatedAt: new Date().toISOString(),
    baselineSource: baseline.baselineSource,
    viewports: baseline.viewports.map((v) => ({
      route: v.route,
      threshold: v.threshold,
      diffPercent: 0,
      verdict: 'pending-step-03b-wiring',
    })),
    status: 'diff-deferred',
  };
  const outPath = path.join(buildRoot(cwd, milestone), `${milestone}-${story}-visual-diff.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  return { ...out, outPath, ok: true };
}

function printHelp() {
  process.stdout.write(
    `cobolt-story-visual-diff — per-story screenshot capture + diff\n\n` +
      `Usage:\n` +
      `  node tools/cobolt-story-visual-diff.js capture --milestone M1 --story S1 [--cwd PATH] [--json]\n` +
      `  node tools/cobolt-story-visual-diff.js diff    --milestone M1 --story S1 [--cwd PATH] [--json]\n` +
      `Exit: 0 pass, 1 over threshold, 2 missing dep (playwright/pngjs/pixelmatch), 3 baseline missing\n`,
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--milestone') args.milestone = argv[++i];
    else if (a === '--story') args.story = argv[++i];
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
  const cmd = argv[0];
  if (!cmd) {
    printHelp();
    return 0;
  }
  const args = parseArgs(argv.slice(1));
  let result;
  if (cmd === 'capture') result = capture(args);
  else if (cmd === 'diff') result = diff(args);
  else {
    process.stderr.write(`unknown command: ${cmd}\n`);
    return 1;
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok === false) {
    process.stderr.write(`${result.verdict || 'error'}: ${result.error || (result.missingDeps || []).join(',')}\n`);
  } else {
    process.stdout.write(`visual-diff ${cmd} ${result.status} for ${result.milestone}/${result.storyId}\n`);
  }
  if (result._exit) return result._exit;
  return result.ok === false ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { capture, diff, depStatus };
