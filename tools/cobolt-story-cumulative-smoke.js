#!/usr/bin/env node

// cobolt-story-cumulative-smoke — PR-2 Batch C (v0.53.0).
//
// Per-story analogue of Step 08B cross-milestone-smoke. After each story
// reaches GREEN + REFACTOR, this tool replays the integration smoke against
// the cumulative union of prior-story integration surface within the same
// milestone — catching same-milestone regressions before review.
//
// PR-2 ships a deterministic shell that:
//   1) reads M{n}-S{y}-story-contracts.json and prior-story registry
//   2) builds a list of routes/events/symbols this story is about to add
//   3) emits a verdict file (cumulative-smoke.json) with status=deferred,
//      to be filled by PR-4 step 04c when the orchestration is wired
//   4) when COBOLT_DELEGATE_TO_CROSS_MILESTONE=1 (env-only opt-in for PR-2
//      smoke testing), shells out to cobolt-cross-milestone-smoke with
//      --scope=story
//
// Usage:
//   node tools/cobolt-story-cumulative-smoke.js run --milestone M1 --story S1 [--cwd PATH] [--json]
//   node tools/cobolt-story-cumulative-smoke.js --help
//
// Exit codes: 0 ok, 1 invalid input, 2 no story-contracts present, 3 cross-smoke unavailable.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MILESTONE_RE = /^M\d+$/;
const STORY_ID_RE = /^(S\d+|E\d+-S\d+)$/;

function buildRoot(cwd, milestone) {
  return path.join(cwd, '_cobolt-output', 'latest', 'build', milestone);
}

function checkpointRoot(cwd) {
  return path.join(cwd, '_cobolt-output', 'latest', 'build', 'checkpoints');
}

function relativePath(cwd, filePath) {
  return path.relative(cwd, filePath).replace(/\\/g, '/');
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function writeMilestoneSummary(cwd, milestone, result) {
  const summaryPath = path.join(buildRoot(cwd, milestone), `${milestone}-04c-cumulative-smoke.json`);
  const checkpointPath = path.join(checkpointRoot(cwd), `${milestone}-04c-cumulative-smoke.json`);
  try {
    writeJson(summaryPath, result);
    writeJson(checkpointPath, {
      checkpoint: 'cumulative-smoke',
      milestone,
      status: result.ok === false ? 'failed' : 'completed',
      verdict: result.verdict,
      generatedAt: result.generatedAt,
      generatedBy: 'cobolt-story-cumulative-smoke',
      artifact: relativePath(cwd, summaryPath),
      metrics: {
        storiesProcessed: result.storiesProcessed || 0,
        priorStoriesUnion: Array.isArray(result.priorStoriesUnion) ? result.priorStoriesUnion : [],
        regressions: Array.isArray(result.regressions) ? result.regressions.length : 0,
      },
      nextStep: '05-review',
    });
    return { ...result, summaryPath, checkpointPath };
  } catch (err) {
    return {
      ...result,
      ok: false,
      verdict: 'regressions-found',
      error: `could not write cumulative-smoke records: ${err.message}`,
      _exit: 3,
    };
  }
}

function readContracts(cwd, milestone, story) {
  const file = path.join(buildRoot(cwd, milestone), `${milestone}-${story}-story-contracts.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listPriorStories(cwd, milestone, story) {
  const dir = buildRoot(cwd, milestone);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(`${milestone}-`) && n.endsWith('-story-contracts.json'))
    .map((n) => {
      const m = n.match(/^M\d+-(S\d+|E\d+-S\d+)-story-contracts\.json$/);
      return m ? m[1] : null;
    })
    .filter((s) => s && s !== story);
}

function summarizeSurface(contracts) {
  const surface = { apis: [], events: [], symbols: [], data: [] };
  for (const c of contracts.contracts || []) {
    if (c.type === 'API') surface.apis.push(`${c.spec.method} ${c.spec.path}`);
    else if (c.type === 'EVT') surface.events.push(c.spec.eventName);
    else if (c.type === 'TYPE') surface.symbols.push(c.spec.symbol);
    else if (c.type === 'DATA') surface.data.push(c.spec.entity);
  }
  return surface;
}

function delegateToCrossMilestone(cwd, milestone) {
  const tool = path.join(__dirname, 'cobolt-cross-milestone-smoke.js');
  if (!fs.existsSync(tool)) return { ok: false, error: 'cross-milestone-smoke tool missing', _exit: 3 };
  try {
    const out = execFileSync(process.execPath, [tool, 'run', '--milestone', milestone, '--scope', 'story', '--json'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { ok: true, delegated: true, output: out.trim() };
  } catch (err) {
    return { ok: false, delegated: true, error: err.message, _exit: err.status === 2 ? 3 : 1 };
  }
}

function run({ cwd, milestone, story } = {}) {
  cwd = cwd || process.cwd();
  if (!MILESTONE_RE.test(milestone || '')) {
    return { ok: false, error: 'milestone must match M\\d+', _exit: 1 };
  }
  if (!story) {
    const contractDir = buildRoot(cwd, milestone);
    const files = fs.existsSync(contractDir)
      ? fs
          .readdirSync(contractDir)
          .filter((file) => file.startsWith(`${milestone}-`) && file.endsWith('-story-contracts.json'))
          .sort()
      : [];
    const results = [];
    for (const file of files) {
      const storyId = file.slice(`${milestone}-`.length, -'-story-contracts.json'.length);
      const result = run({ cwd, milestone, story: storyId });
      results.push(result);
    }
    const failed = results.filter((result) => result.ok === false);
    const priorStoriesUnion = [...new Set(results.flatMap((result) => result.priorStories || []))].sort();
    const regressions = failed.map((result) => ({
      storyId: result.storyId || null,
      error: result.error || result.verdict || 'failed',
    }));
    const summary = {
      schema: 'cobolt-story-cumulative-smoke@1',
      milestone,
      generatedAt: new Date().toISOString(),
      storiesProcessed: results.length,
      priorStoriesUnion,
      regressions,
      results,
      verdict:
        failed.length > 0
          ? 'regressions-found'
          : results.some((result) => result.status === 'passed')
            ? 'all-passed'
            : 'deferred',
      ok: failed.length === 0,
      _exit: failed.length > 0 ? failed[0]._exit || 1 : 0,
    };
    return writeMilestoneSummary(cwd, milestone, summary);
  }
  if (!STORY_ID_RE.test(story || '')) {
    return { ok: false, error: 'story must match S\\d+ or E\\d+-S\\d+', _exit: 1 };
  }
  const contracts = readContracts(cwd, milestone, story);
  if (!contracts) {
    return { ok: false, error: `no story-contracts file for ${milestone} / ${story}`, _exit: 2 };
  }
  const prior = listPriorStories(cwd, milestone, story);
  const cumulative = prior.flatMap((s) => {
    const c = readContracts(cwd, milestone, s);
    return c ? c.contracts || [] : [];
  });
  const surface = summarizeSurface(contracts);
  let delegation = null;
  if (process.env.COBOLT_DELEGATE_TO_CROSS_MILESTONE === '1') {
    delegation = delegateToCrossMilestone(cwd, milestone);
    if (delegation && delegation.ok === false) {
      return { ok: false, error: delegation.error, _exit: delegation._exit };
    }
  }
  const verdict = {
    schema: 'cobolt-story-cumulative-smoke@1',
    milestone,
    storyId: story,
    generatedAt: new Date().toISOString(),
    priorStories: prior,
    cumulativeContractCount: cumulative.length,
    surface,
    status: delegation ? 'passed' : 'deferred',
    delegated: Boolean(delegation),
    delegation,
    note: 'PR-2 ships a deterministic shell. Real run logic is wired in PR-4 step 04c.',
  };
  const outPath = path.join(buildRoot(cwd, milestone), `${milestone}-${story}-cumulative-smoke.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(verdict, null, 2)}\n`, { mode: 0o600 });
  return { ...verdict, outPath, ok: true };
}

function printHelp() {
  process.stdout.write(
    `cobolt-story-cumulative-smoke — per-story analogue of cross-milestone smoke\n\n` +
      `Usage: node tools/cobolt-story-cumulative-smoke.js run --milestone M1 --story S1 [--cwd PATH] [--json]\n` +
      `Exit: 0 ok, 1 invalid input, 2 no contracts, 3 cross-smoke unavailable\n`,
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
    process.stderr.write(`error: ${result.error}\n`);
  } else {
    if (result.storyId) {
      process.stdout.write(
        `cumulative-smoke ${result.status} for ${result.milestone}/${result.storyId} (prior=${result.priorStories.length} contracts=${result.cumulativeContractCount})\n`,
      );
    } else {
      process.stdout.write(
        `cumulative-smoke ${result.verdict} for ${result.milestone} (${result.storiesProcessed || 0} stories)\n`,
      );
    }
  }
  if (result._exit) return result._exit;
  return result.ok === false ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { run, summarizeSurface, listPriorStories, readContracts };
