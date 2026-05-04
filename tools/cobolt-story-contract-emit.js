#!/usr/bin/env node

// cobolt-story-contract-emit — PR-2 of build-pipeline redesign (v0.53.0).
//
// Reads story implementation specs (S{x}-impl-spec.md) plus M{n}-story-specs-index.json
// and emits per-story contracts conforming to story-contracts.schema.json. Each
// contract binds a provider story to one or more consumer stories within the
// same milestone with API/DATA/EVT/TYPE specs concrete enough for
// cobolt-story-mock-wire to generate stubs.
//
// In PR-2 the heuristic is conservative — extracts contracts from spec markdown
// when explicit "## Contracts" / "### API Endpoints" sections are present, and
// emits an empty `contracts: []` registry otherwise. The story-spec
// scaffolding will be tightened in PR-3 when 01A starts emitting structured
// contract blocks.
//
// Usage:
//   node tools/cobolt-story-contract-emit.js emit --milestone M1 [--story S1] [--cwd PATH] [--json]
//   node tools/cobolt-story-contract-emit.js --help
//
// Exit codes: 0 ok, 1 invalid input, 2 missing story-specs index, 3 cannot read planning dir.

const fs = require('node:fs');
const path = require('node:path');

const STORY_ID_RE = /^(S\d+|E\d+-S\d+)$/;
const MILESTONE_RE = /^M\d+$/;

function planningRoot(cwd) {
  return path.join(cwd, '_cobolt-output', 'latest', 'planning');
}

function buildRoot(cwd, milestone) {
  return path.join(cwd, '_cobolt-output', 'latest', 'build', milestone);
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
        return { path: p, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
      } catch (err) {
        return { path: p, error: err.message };
      }
    }
  }
  return null;
}

function readStorySpec(specPath) {
  if (!fs.existsSync(specPath)) return null;
  return fs.readFileSync(specPath, 'utf8');
}

// Extract API contracts from spec markdown. Looks for fenced code blocks or
// table rows that name HTTP method + path. Conservative — false negatives
// preferred over false positives.
function extractApiContracts(md, providerStory) {
  if (!md) return [];
  const contracts = [];
  let counter = 1;
  const apiBlock = md.match(/##+\s*API[^\n]*\n([\s\S]*?)(?=\n##|$)/i);
  if (!apiBlock) return [];
  const block = apiBlock[1];
  const re = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S+)/g;
  const seen = new Set();
  for (const match of block.matchAll(re)) {
    const key = `${match[1]} ${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    contracts.push({
      id: `SC-API-${String(counter).padStart(3, '0')}`,
      type: 'API',
      providerStory,
      consumerStories: [providerStory],
      semanticVersion: '1.0.0',
      stubStrategy: 'in-memory',
      spec: { kind: 'api', method: match[1], path: match[2] },
    });
    counter += 1;
  }
  return contracts;
}

function extractConsumes(md) {
  if (!md) return [];
  const block = md.match(/##+\s*(?:Depends On|Consumes|Inter-Story Dependencies)[^\n]*\n([\s\S]*?)(?=\n##|$)/i);
  if (!block) return [];
  const ids = block[1].match(/\b(S\d+|E\d+-S\d+)\b/g) || [];
  return Array.from(new Set(ids));
}

function emit({ cwd, milestone, story } = {}) {
  cwd = cwd || process.cwd();
  if (!MILESTONE_RE.test(milestone || '')) {
    return { ok: false, error: 'milestone must match M\\d+' };
  }
  const idx = readStoryIndex(cwd, milestone);
  if (!idx) {
    return {
      ok: false,
      error: `no story-specs index found for ${milestone} under ${planningRoot(cwd)} or ${buildRoot(cwd, milestone)}`,
      _exit: 2,
    };
  }
  if (idx.error) {
    return { ok: false, error: idx.error, _exit: 3 };
  }
  const stories = (idx.data?.stories || idx.data?.entries || []).filter((s) =>
    story ? s.id === story || s.storyId === story : true,
  );
  if (stories.length === 0) {
    return { ok: false, error: `no stories matched ${story || 'any'} in ${idx.path}`, _exit: 1 };
  }
  const out = [];
  for (const s of stories) {
    const sid = s.id || s.storyId;
    if (!STORY_ID_RE.test(sid)) {
      out.push({ storyId: sid, ok: false, error: 'malformed story id' });
      continue;
    }
    const specPath = s.specPath || s.path || path.join(planningRoot(cwd), 'story-specs', `${sid}-impl-spec.md`);
    const md = readStorySpec(specPath);
    const contracts = extractApiContracts(md, sid);
    const consumes = extractConsumes(md);
    const registry = {
      version: '1.0.0',
      milestoneId: milestone,
      storyId: sid,
      generatedAt: new Date().toISOString(),
      source: specPath,
      consumes,
      contracts,
    };
    const outPath = path.join(buildRoot(cwd, milestone), `${milestone}-${sid}-story-contracts.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
    out.push({ storyId: sid, ok: true, outPath, contractCount: contracts.length });
  }
  return {
    schema: 'cobolt-story-contract-emit@1',
    milestone,
    generatedAt: new Date().toISOString(),
    storiesProcessed: out.length,
    results: out,
  };
}

function printHelp() {
  process.stdout.write(
    `cobolt-story-contract-emit — emit per-story interface contracts\n\n` +
      `Usage: node tools/cobolt-story-contract-emit.js emit --milestone M1 [--story S1] [--cwd PATH] [--json]\n` +
      `Exit: 0 ok, 1 invalid input, 2 missing story-specs index, 3 cannot read planning dir\n`,
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
  if (argv[0] !== 'emit') {
    process.stderr.write(`unknown command: ${argv[0]}\n`);
    return 1;
  }
  const args = parseArgs(argv.slice(1));
  const result = emit(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok === false) {
    process.stderr.write(`error: ${result.error}\n`);
  } else {
    process.stdout.write(
      `emitted ${result.storiesProcessed} story contract registr${result.storiesProcessed === 1 ? 'y' : 'ies'}\n`,
    );
  }
  if (result._exit) return result._exit;
  return result.ok === false ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { emit, extractApiContracts, extractConsumes };
