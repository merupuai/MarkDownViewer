#!/usr/bin/env node

// CoBolt Test-Changed (PF-03) — change-aware test selection.
//
// Usage:
//   node tools/cobolt-test-changed.js                # list affected tests, exit 0
//   node tools/cobolt-test-changed.js --run          # node --test the affected list
//   node tools/cobolt-test-changed.js --base main    # diff against main (default: HEAD)
//   node tools/cobolt-test-changed.js --json         # machine-readable
//   node tools/cobolt-test-changed.js --include-deps # also include tests that
//                                                    # require modules touched
//                                                    # by the diff (string scan,
//                                                    # ~70% accurate, advisory)
//
// Selection rules (deterministic, no LLM judgment):
//   1. If a test file changed → include that test directly.
//   2. If a non-test source file under lib/ tools/ source/ changed:
//      a. Heuristic: include tests/test-<basename-no-ext>*.js
//      b. With --include-deps: also include tests that mention the module
//         path or basename in their text.
//   3. If config files changed (package.json, biome.json, scripts/) →
//      conservatively include the smoke lane (cli + bin + install).
//
// Exit codes (per tools/CLAUDE.md):
//   0 — listing succeeded, OR --run mode and the test child exited 0
//   1 — usage error or --run failed

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(ROOT, 'tests');

const CONFIG_PATHS = ['package.json', 'biome.json', 'jsconfig.json', 'scripts/'];
const CONFIG_FALLBACK_TESTS = [
  'tests/test-cli-args.js',
  'tests/test-cli-help.js',
  'tests/test-bin-install.js',
  'tests/test-husky-pre-push.js',
];

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { run: false, base: 'HEAD', json: false, includeDeps: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--run') opts.run = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--include-deps') opts.includeDeps = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--base') opts.base = argv[++i] || 'HEAD';
    else if (arg.startsWith('--base=')) opts.base = arg.slice('--base='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function gitDiff(base) {
  // Uncommitted changes (working tree) PLUS staged.
  // For ranges (e.g., "main..HEAD"), diff between commits.
  try {
    const args = base === 'HEAD' ? ['diff', '--name-only', 'HEAD'] : ['diff', '--name-only', `${base}...HEAD`];
    const out = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    const tracked = out.split(/\r?\n/).filter(Boolean);

    if (base === 'HEAD') {
      // Add untracked working-tree files too — they're often new tests.
      try {
        const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
          cwd: ROOT,
          encoding: 'utf8',
        })
          .split(/\r?\n/)
          .filter(Boolean);
        return Array.from(new Set([...tracked, ...untracked]));
      } catch {
        return tracked;
      }
    }
    return tracked;
  } catch (err) {
    process.stderr.write(`[cobolt-test-changed] git diff failed: ${err.message}\n`);
    return [];
  }
}

function listAllTests() {
  const out = [];
  const walk = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
        continue;
      }
      if (entry.isFile() && /^test-.*\.js$/.test(entry.name)) out.push(rel);
    }
  };
  walk(TESTS_DIR, 'tests');
  return out.sort();
}

function isTestFile(p) {
  return /^tests\/.*test-.*\.js$/.test(p);
}

function isConfigChange(p) {
  return CONFIG_PATHS.some((c) => p === c || p.startsWith(`${c}/`) || p.startsWith(c.replace(/\/$/, '')));
}

function basenameNoExt(p) {
  return path.basename(p).replace(/\.[a-z]+$/i, '');
}

function findTestsForModule(moduleRel, allTests) {
  // Heuristic 1: tests/test-<basename>*.js
  const base = basenameNoExt(moduleRel);
  const candidates = allTests.filter((t) => path.basename(t).startsWith(`test-${base}`));
  return candidates;
}

function findTestsByContentDep(moduleRel, allTests) {
  const base = basenameNoExt(moduleRel);
  const matches = [];
  for (const t of allTests) {
    let body;
    try {
      body = fs.readFileSync(path.join(ROOT, t), 'utf8');
    } catch {
      continue;
    }
    if (body.includes(moduleRel) || body.includes(base)) matches.push(t);
  }
  return matches;
}

function selectTests(diffPaths, opts) {
  const all = listAllTests();
  const selected = new Set();
  let configFallback = false;

  for (const p of diffPaths) {
    if (isTestFile(p)) {
      selected.add(p);
      continue;
    }
    if (isConfigChange(p)) {
      configFallback = true;
      continue;
    }
    if (p.startsWith('lib/') || p.startsWith('tools/') || p.startsWith('source/') || p.startsWith('bin/')) {
      for (const t of findTestsForModule(p, all)) selected.add(t);
      if (opts.includeDeps) {
        for (const t of findTestsByContentDep(p, all)) selected.add(t);
      }
    }
  }

  if (configFallback) {
    for (const t of CONFIG_FALLBACK_TESTS) {
      if (all.includes(t)) selected.add(t);
    }
  }

  return Array.from(selected).sort();
}

function printHelp() {
  console.log(`Usage: node tools/cobolt-test-changed.js [options]

Compute the set of tests affected by the current git diff and either list them
or run them via \`node --test\`.

Options:
  --run             Invoke node --test on the selected files.
  --base <ref>      Diff against <ref> (default: HEAD = working tree changes).
  --include-deps    Also include tests that mention the changed module by name
                    (advisory; ~70% accurate, no AST).
  --json            Machine-readable output: { selected: string[], reasons: ... }.
  --help, -h        Show this help.

Examples:
  node tools/cobolt-test-changed.js
  node tools/cobolt-test-changed.js --run
  node tools/cobolt-test-changed.js --base origin/main
  node tools/cobolt-test-changed.js --include-deps --run
`);
}

if (require.main === module) {
  let opts;
  try {
    opts = parseArgs();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const diffPaths = gitDiff(opts.base);
  const selected = selectTests(diffPaths, opts);

  if (opts.json) {
    console.log(JSON.stringify({ base: opts.base, diffPaths, selected }, null, 2));
    process.exit(0);
  }

  if (selected.length === 0) {
    console.log('[cobolt-test-changed] No affected tests detected from current diff.');
    process.exit(0);
  }

  if (!opts.run) {
    for (const t of selected) console.log(t);
    process.exit(0);
  }

  console.log(`[cobolt-test-changed] Running ${selected.length} affected test file(s):`);
  for (const t of selected) console.log(`  ${t}`);
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...selected], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  process.exit(r.status ?? 1);
}

module.exports = {
  parseArgs,
  selectTests,
  listAllTests,
  isTestFile,
  isConfigChange,
  CONFIG_FALLBACK_TESTS,
};
