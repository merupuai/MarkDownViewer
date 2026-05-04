#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const transforms = require('../lib/transforms');
const { InstallCache } = require('../lib/cobolt-install-cache');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'source');
const AGENTS_DIR = path.join(SOURCE_DIR, 'agents');
const DEFAULT_REPORT_DIR = path.join(ROOT, '_cobolt-output', 'reports', 'install-profile');
const DEFAULT_AGENT_COUNT = 500;

const RUNTIMES = Object.freeze({
  claude: {
    globalPath: path.join(os.homedir(), '.claude'),
    localPath: path.join(process.cwd(), '.claude'),
    globalRef: '~/.claude',
    localRef: '.claude',
  },
  codex: {
    globalPath: path.join(os.homedir(), '.codex'),
    localPath: path.join(process.cwd(), '.codex'),
    globalRef: '~/.codex',
    localRef: '.codex',
  },
});

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function loadModelConfig(rootDir = ROOT) {
  const filePath = path.join(rootDir, 'source', 'templates', 'model-config.json');
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function buildSharedIncludeLookup(sourceDir = SOURCE_DIR) {
  const lookup = {};
  function walk(currentDir) {
    if (!fs.existsSync(currentDir)) return;
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      const rel = path.relative(sourceDir, fullPath).replace(/\\/g, '/');
      if (!rel.startsWith('_shared/') && !rel.includes('/_shared/')) continue;
      lookup[rel] = fs.readFileSync(fullPath, 'utf8');
    }
  }
  walk(path.join(sourceDir, '_shared'));
  walk(path.join(sourceDir, 'agents', '_shared'));
  walk(path.join(sourceDir, 'skills', '_shared'));
  return lookup;
}

function collectAgentFixtures(agentsDir = AGENTS_DIR) {
  if (!fs.existsSync(agentsDir)) throw new Error(`agents dir not found: ${agentsDir}`);
  const fixtures = [];
  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    if (entry.name === 'CLAUDE.md') continue;
    const fullPath = path.join(agentsDir, entry.name);
    fixtures.push({
      name: entry.name.replace(/\.md$/, ''),
      fileName: entry.name,
      sourceKey: `agents/${entry.name}`,
      content: fs.readFileSync(fullPath, 'utf8'),
    });
  }
  fixtures.sort((a, b) => a.name.localeCompare(b.name));
  return fixtures;
}

function buildSyntheticWorkload(fixtures, targetCount = DEFAULT_AGENT_COUNT) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    throw new Error('cannot build install profile workload without agent fixtures');
  }
  const count = Number(targetCount);
  if (!Number.isInteger(count) || count < 1) throw new Error(`invalid agent count: ${targetCount}`);
  const workload = [];
  for (let i = 0; i < count; i++) {
    const source = fixtures[i % fixtures.length];
    const suffix = i < fixtures.length ? '' : `-synthetic-${i + 1}`;
    const name = `${source.name}${suffix}`;
    workload.push({
      name,
      sourceKey: i < fixtures.length ? source.sourceKey : `agents/${name}.md`,
      content: source.content,
    });
  }
  return workload;
}

function runTransformPass(workload, context, cache = null) {
  const runtime = RUNTIMES[context.runtimeId] || RUNTIMES.claude;
  const started = process.hrtime.bigint();
  let bytes = 0;
  let transformedCount = 0;
  for (const item of workload) {
    const compute = () =>
      transforms.transformAgent(
        item.content,
        runtime,
        context.runtimeId,
        item.name,
        context.modelConfig,
        context.includeLookup,
      );
    const transformed = cache
      ? cache.getOrCompute(
          item.sourceKey,
          item.content,
          {
            kind: 'agent',
            agentName: item.name,
            runtimeId: context.runtimeId,
            modelConfigDigest: context.modelConfigDigest,
          },
          compute,
        ).value
      : compute();
    bytes += Buffer.byteLength(transformed, 'utf8');
    transformedCount++;
  }
  if (cache) cache.flush();
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    agents: transformedCount,
    durationMs: Number(durationMs.toFixed(3)),
    outputBytes: bytes,
    cache: cache ? cache.summary() : null,
  };
}

function profileAgentTransforms(options = {}) {
  const rootDir = path.resolve(options.rootDir || ROOT);
  const sourceDir = path.join(rootDir, 'source');
  const fixtures = options.fixtures || collectAgentFixtures(path.join(sourceDir, 'agents'));
  const agentCount = Number(options.agentCount || DEFAULT_AGENT_COUNT);
  const workload = buildSyntheticWorkload(fixtures, agentCount);
  const runtimeId = options.runtimeId || 'claude';
  const modelConfig = options.modelConfig || loadModelConfig(rootDir);
  const context = {
    runtimeId,
    modelConfig,
    modelConfigDigest: modelConfig ? sha256(JSON.stringify(modelConfig)) : 'no-model-config',
    includeLookup: options.includeLookup || buildSharedIncludeLookup(sourceDir),
  };
  const cacheRoot = options.cacheRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'cobolt-install-profile-cache-'));
  const cacheOptions = {
    cacheRoot,
    repoRoot: rootDir,
    placeholders: {
      version: options.version || 'profile',
      packageName: 'cobolt',
      runtimeId,
      targetDir: options.targetDir || path.join(os.tmpdir(), 'cobolt-install-profile-target'),
      globalRef: RUNTIMES[runtimeId]?.globalRef || RUNTIMES.claude.globalRef,
      localRef: RUNTIMES[runtimeId]?.localRef || RUNTIMES.claude.localRef,
    },
  };

  const noCache = runTransformPass(workload, context, null);

  const coldCache = new InstallCache(cacheOptions);
  coldCache.ensureLayout();
  const cold = runTransformPass(workload, context, coldCache);

  const warmCache = new InstallCache(cacheOptions);
  warmCache.ensureLayout();
  const warm = runTransformPass(workload, context, warmCache);

  const warmHitRate = warm.cache && workload.length > 0 ? warm.cache.hits / workload.length : 0;
  return {
    schema: 'cobolt-install-profile@1',
    generatedAt: new Date().toISOString(),
    rootDir,
    runtimeId,
    agentCount,
    fixtureAgentCount: fixtures.length,
    syntheticAgentCount: Math.max(0, agentCount - fixtures.length),
    passes: {
      noCache,
      coldCache: cold,
      warmCache: warm,
    },
    summary: {
      warmHitRate: Number(warmHitRate.toFixed(4)),
      warmSpeedupVsNoCache: warm.durationMs > 0 ? Number((noCache.durationMs / warm.durationMs).toFixed(3)) : null,
      coldWrites: cold.cache ? cold.cache.writes : 0,
      warmHits: warm.cache ? warm.cache.hits : 0,
    },
  };
}

function renderMarkdown(result) {
  const lines = [
    '# Install Profile',
    '',
    `Generated: ${result.generatedAt}`,
    `Runtime: ${result.runtimeId}`,
    `Agent count: ${result.agentCount}`,
    `Fixture agents: ${result.fixtureAgentCount}`,
    `Synthetic agents: ${result.syntheticAgentCount}`,
    '',
    '| Pass | Agents | Duration ms | Cache hits | Cache misses | Cache writes | Output bytes |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const [name, pass] of Object.entries(result.passes)) {
    lines.push(
      `| ${name} | ${pass.agents} | ${pass.durationMs} | ${pass.cache?.hits || 0} | ${pass.cache?.misses || 0} | ${pass.cache?.writes || 0} | ${pass.outputBytes} |`,
    );
  }
  lines.push(
    '',
    `Warm hit rate: ${result.summary.warmHitRate}`,
    `Warm speedup vs no-cache: ${result.summary.warmSpeedupVsNoCache}`,
    '',
  );
  return `${lines.join('\n')}\n`;
}

function writeReports(result, reportDir = DEFAULT_REPORT_DIR) {
  fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const jsonPath = path.join(reportDir, 'latest.json');
  const mdPath = path.join(reportDir, 'latest.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(mdPath, renderMarkdown(result), { encoding: 'utf8', mode: 0o600 });
  return { jsonPath, mdPath };
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { sub: null, agentCount: DEFAULT_AGENT_COUNT, json: false, noWrite: false, runtimeId: 'claude' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (i === 0 && !arg.startsWith('--')) opts.sub = arg;
    else if (arg === '--agents') opts.agentCount = Number(argv[++i]);
    else if (arg.startsWith('--agents=')) opts.agentCount = Number(arg.slice('--agents='.length));
    else if (arg === '--runtime') opts.runtimeId = argv[++i] || opts.runtimeId;
    else if (arg.startsWith('--runtime=')) opts.runtimeId = arg.slice('--runtime='.length);
    else if (arg === '--root') opts.rootDir = path.resolve(argv[++i] || ROOT);
    else if (arg.startsWith('--root=')) opts.rootDir = path.resolve(arg.slice('--root='.length));
    else if (arg === '--json') opts.json = true;
    else if (arg === '--no-write') opts.noWrite = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  opts.sub = opts.sub || 'profile';
  return opts;
}

function printHelp() {
  console.log(`Usage: node tools/cobolt-install-profile.js profile [options]

Options:
  --agents <n>       Synthetic workload size. Default: 500.
  --runtime <id>     claude or codex. Default: claude.
  --root <dir>       Repository root.
  --json             Print JSON instead of markdown.
  --no-write         Do not write _cobolt-output/reports/install-profile/.
`);
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    printHelp();
    return 0;
  }
  if (opts.sub !== 'profile') throw new Error(`Unknown subcommand: ${opts.sub}`);
  const result = profileAgentTransforms(opts);
  const reports = opts.noWrite ? null : writeReports(result);
  if (opts.json) console.log(JSON.stringify(reports ? { ...result, reports } : result, null, 2));
  else process.stdout.write(renderMarkdown(result));
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`[cobolt-install-profile] ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_AGENT_COUNT,
  buildSharedIncludeLookup,
  buildSyntheticWorkload,
  collectAgentFixtures,
  main,
  parseArgs,
  profileAgentTransforms,
  renderMarkdown,
  runTransformPass,
  writeReports,
};
