#!/usr/bin/env node

// cobolt-story-dep-map — PR-2 of build-pipeline redesign (v0.53.0).
//
// Reads M{n}-story-specs-index.json plus emitted story-contracts to build a
// per-milestone story dependency graph. Output: {storyId, dependsOn[], blockedBy[],
// downstream[]}. Used by cobolt-story-mock-wire (Step 02a) to know which mocks
// must be wired before each story's GREEN phase, and by build-lead to compute
// safe dispatch order.
//
// Usage:
//   node tools/cobolt-story-dep-map.js build --milestone M1 [--cwd PATH] [--json]
//   node tools/cobolt-story-dep-map.js --help
//
// Exit codes: 0 ok, 1 cycle detected (advisory — does NOT block in PR-2),
// 2 missing inputs, 3 unreadable inputs.

const fs = require('node:fs');
const path = require('node:path');

const MILESTONE_RE = /^M\d+$/;
const STORY_ID_RE = /^(S\d+|E\d+-S\d+)$/;

function buildRoot(cwd, milestone) {
  return path.join(cwd, '_cobolt-output', 'latest', 'build', milestone);
}

function planningRoot(cwd) {
  return path.join(cwd, '_cobolt-output', 'latest', 'planning');
}

function listContractFiles(cwd, milestone) {
  const dir = buildRoot(cwd, milestone);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(`${milestone}-`) && n.endsWith('-story-contracts.json'))
    .map((n) => path.join(dir, n));
}

function readContracts(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readStoryIndex(cwd, milestone) {
  const candidates = [
    path.join(buildRoot(cwd, milestone), `${milestone}-story-specs-index.json`),
    path.join(planningRoot(cwd), `${milestone}-story-specs-index.json`),
    path.join(planningRoot(cwd), 'story-specs-index.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function detectCycles(graph) {
  // Tarjan-ish: detect back-edges via DFS with WHITE/GRAY/BLACK coloring.
  const color = new Map(); // 0=white,1=gray,2=black
  const cycles = [];
  function dfs(node, stack) {
    color.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) || []) {
      const c = color.get(next) || 0;
      if (c === 0) {
        dfs(next, stack);
      } else if (c === 1) {
        const i = stack.indexOf(next);
        cycles.push(stack.slice(i).concat([next]));
      }
    }
    color.set(node, 2);
    stack.pop();
  }
  for (const node of graph.keys()) {
    if ((color.get(node) || 0) === 0) dfs(node, []);
  }
  return cycles;
}

function build({ cwd, milestone } = {}) {
  cwd = cwd || process.cwd();
  if (!MILESTONE_RE.test(milestone || '')) {
    return { ok: false, error: 'milestone must match M\\d+', _exit: 1 };
  }
  const idx = readStoryIndex(cwd, milestone);
  const contractFiles = listContractFiles(cwd, milestone);
  if (!idx && contractFiles.length === 0) {
    return {
      ok: false,
      error: `no story-specs index and no story-contracts files found under ${buildRoot(cwd, milestone)}`,
      _exit: 2,
    };
  }
  const stories = new Set();
  if (idx) for (const s of idx.stories || idx.entries || []) stories.add(s.id || s.storyId);
  for (const f of contractFiles) {
    const c = readContracts(f);
    if (c?.storyId) stories.add(c.storyId);
  }
  // Build dependsOn map from contracts.consumes + contracts[].consumerStories
  const dependsOn = new Map();
  for (const sid of stories) dependsOn.set(sid, new Set());
  for (const f of contractFiles) {
    const c = readContracts(f);
    if (!c?.storyId) continue;
    const sid = c.storyId;
    for (const upstream of c.consumes || []) {
      if (STORY_ID_RE.test(upstream) && upstream !== sid) {
        if (!dependsOn.has(sid)) dependsOn.set(sid, new Set());
        dependsOn.get(sid).add(upstream);
      }
    }
    // Each contract's consumerStories[] declares downstream consumers
    for (const contract of c.contracts || []) {
      for (const consumer of contract.consumerStories || []) {
        if (consumer !== sid) {
          if (!dependsOn.has(consumer)) dependsOn.set(consumer, new Set());
          dependsOn.get(consumer).add(sid);
        }
      }
    }
  }
  // Build downstream (inverse) map
  const downstream = new Map();
  for (const sid of dependsOn.keys()) downstream.set(sid, new Set());
  for (const [sid, deps] of dependsOn) {
    for (const d of deps) {
      if (!downstream.has(d)) downstream.set(d, new Set());
      downstream.get(d).add(sid);
    }
  }
  // Detect cycles (advisory)
  const graph = new Map();
  for (const [k, v] of dependsOn) graph.set(k, [...v]);
  const cycles = detectCycles(graph);

  const storiesArr = Array.from(stories).sort();
  const result = {
    schema: 'cobolt-story-dep-map@1',
    milestone,
    generatedAt: new Date().toISOString(),
    stories: storiesArr.map((sid) => ({
      storyId: sid,
      dependsOn: Array.from(dependsOn.get(sid) || []).sort(),
      downstream: Array.from(downstream.get(sid) || []).sort(),
    })),
    cycles,
  };
  const outDir = buildRoot(cwd, milestone);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${milestone}-story-dep-map.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return { ...result, outPath, ok: true };
}

function printHelp() {
  process.stdout.write(
    `cobolt-story-dep-map — emit per-milestone story dependency graph\n\n` +
      `Usage: node tools/cobolt-story-dep-map.js build --milestone M1 [--cwd PATH] [--json]\n` +
      `Exit: 0 ok, 1 invalid input or cycle, 2 missing inputs, 3 unreadable inputs\n`,
  );
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
  if (argv[0] !== 'build') {
    process.stderr.write(`unknown command: ${argv[0]}\n`);
    return 1;
  }
  const cwdIdx = argv.indexOf('--cwd');
  const msIdx = argv.indexOf('--milestone');
  const cwd = cwdIdx >= 0 ? argv[cwdIdx + 1] : process.cwd();
  const milestone = msIdx >= 0 ? argv[msIdx + 1] : null;
  const wantsJson = argv.includes('--json');
  const result = build({ cwd, milestone });
  if (wantsJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok === false) {
    process.stderr.write(`error: ${result.error}\n`);
  } else {
    process.stdout.write(
      `dep-map: ${result.stories.length} stories, ${result.cycles.length} cycle(s) — written to ${result.outPath}\n`,
    );
  }
  if (result._exit) return result._exit;
  return result.ok === false ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { build, detectCycles };
