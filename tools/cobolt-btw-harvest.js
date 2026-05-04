#!/usr/bin/env node

// cobolt-btw-harvest — bounded context packet builder for /cobolt-btw.
//
// Reads project state from disk and emits a compact JSON packet the main
// session injects into the btw response step. Deterministic and read-only.
//
// Reads (all optional, all fail-soft):
//   - cobolt-state.json
//   - _cobolt-output/latest/planning/milestones/*.md (names + headers)
//   - _cobolt-output/audit/gate-skip-log.jsonl (tail)
//   - _cobolt-output/audit/btw-log.jsonl (tail, last 5 for dedupe hints)
//   - memory/MEMORY.md (first 200 lines, already the hard cap)
//   - git log --oneline -10 (via child process)
//
// Usage:
//   node tools/cobolt-btw-harvest.js harvest --request <path>
//   node tools/cobolt-btw-harvest.js harvest --mode query --target-kind milestone --target-value M1
//   node tools/cobolt-btw-harvest.js harvest --json < request.json

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEFAULT_MAX_BYTES = 32 * 1024; // hard cap on packet.data UTF-8 bytes

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const text = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readTextSafe(filePath, maxBytes = 16 * 1024) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    if (buf.length <= maxBytes) return buf.toString('utf8');
    return buf.subarray(buf.length - maxBytes).toString('utf8');
  } catch {
    return null;
  }
}

function readJsonlTail(filePath, lineCount = 20) {
  const text = readTextSafe(filePath, 64 * 1024);
  if (!text) return [];
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lineCount);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }
  return entries;
}

function listMilestoneFiles(cwd) {
  const dir = path.join(cwd, '_cobolt-output', 'latest', 'planning', 'milestones');
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^m\d+.*\.md$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function collectGitLog(cwd, limit = 10) {
  try {
    const out = execFileSync('git', ['log', '--oneline', `-${limit}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 3000,
    });
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function truncateBytes(value, maxBytes) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return `${buf.subarray(0, maxBytes).toString('utf8')}\n…[truncated]`;
}

function harvestContext(request, options = {}) {
  const cwd = options.cwd || process.cwd();
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const mode = request?.mode ? request.mode : 'hint';
  const target = request?.target ? request.target : null;

  const packet = {
    version: '1.0.0',
    cwd,
    mode,
    target,
    sources: {},
  };

  const state = readJsonSafe(path.join(cwd, 'cobolt-state.json'));
  if (state) {
    packet.sources.state = {
      present: true,
      currentStage: state.pipeline?.currentStage || null,
      currentMilestone: state.currentMilestone || null,
      installedVersion: state.installedVersion || null,
      lastUpdated: state.lastUpdated || null,
    };
  } else {
    packet.sources.state = { present: false };
  }

  const milestones = listMilestoneFiles(cwd);
  packet.sources.milestones = {
    present: milestones.length > 0,
    count: milestones.length,
    files: milestones.slice(0, 20),
  };

  const skipLog = readJsonlTail(path.join(cwd, '_cobolt-output', 'audit', 'gate-skip-log.jsonl'), 20);
  packet.sources.recentGateSkips = skipLog.slice(-5).map((entry) => ({
    gate: entry.gate || entry.gateName || null,
    tier: entry.tier || null,
    reason: entry.reason || null,
    stage: entry.stage || null,
    ts: entry.ts || entry.timestamp || null,
  }));

  const btwTail = readJsonlTail(path.join(cwd, '_cobolt-output', 'audit', 'btw-log.jsonl'), 5);
  packet.sources.recentBtw = btwTail.map((entry) => ({
    mode: entry.mode || null,
    summary: entry.summary ? String(entry.summary).slice(0, 120) : null,
    ts: entry.ts || entry.timestamp || null,
  }));

  const memoryPath = resolveMemoryPath(cwd);
  const memory = memoryPath ? readTextSafe(memoryPath, 8 * 1024) : null;
  packet.sources.memory = {
    present: Boolean(memory),
    path: memoryPath ? path.relative(cwd, memoryPath) : null,
    excerpt: memory ? truncateBytes(memory, 6 * 1024) : null,
  };

  const gitLog = collectGitLog(cwd, 10);
  packet.sources.gitLog = {
    present: gitLog.length > 0,
    commits: gitLog,
  };

  // Final byte-budget enforcement: if packet JSON exceeds maxBytes, trim
  // the memory excerpt first, then the git log, then gate skips.
  let serialized = JSON.stringify(packet);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    if (packet.sources.memory.excerpt) {
      packet.sources.memory.excerpt = truncateBytes(packet.sources.memory.excerpt, 2 * 1024);
      serialized = JSON.stringify(packet);
    }
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    packet.sources.gitLog.commits = packet.sources.gitLog.commits.slice(0, 3);
    serialized = JSON.stringify(packet);
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    packet.sources.recentGateSkips = packet.sources.recentGateSkips.slice(0, 1);
  }

  return packet;
}

function resolveMemoryPath(cwd) {
  const envDir = process.env.CLAUDE_MEMORY_DIR || process.env.CLAUDE_CONFIG_DIR;
  const candidates = [
    envDir ? path.join(envDir, 'memory', 'MEMORY.md') : null,
    path.join(cwd, 'memory', 'MEMORY.md'),
    path.join(cwd, '.claude', 'memory', 'MEMORY.md'),
    path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'memory', 'MEMORY.md'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

function parseArgs(argv) {
  const opts = { requestPath: null, mode: null, targetKind: null, targetValue: null, json: false, help: false };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--request') {
      opts.requestPath = argv[++i];
    } else if (arg === '--mode') {
      opts.mode = argv[++i];
    } else if (arg === '--target-kind') {
      opts.targetKind = argv[++i];
    } else if (arg === '--target-value') {
      opts.targetValue = argv[++i];
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
    i += 1;
  }
  return opts;
}

function loadRequest(opts) {
  if (opts.requestPath) {
    const abs = path.resolve(opts.requestPath);
    const data = readJsonSafe(abs);
    if (!data) throw new Error(`Cannot read request file: ${abs}`);
    return data;
  }
  if (opts.mode) {
    const target =
      opts.targetKind && opts.targetValue
        ? { kind: opts.targetKind, value: opts.targetValue, resolvedFrom: 'flag' }
        : null;
    return { version: '1.0.0', mode: opts.mode, target };
  }
  return { version: '1.0.0', mode: 'hint', target: null };
}

function printHelp() {
  console.log('cobolt-btw-harvest — build a bounded context packet for /cobolt-btw');
  console.log('');
  console.log('Usage:');
  console.log('  node tools/cobolt-btw-harvest.js harvest --request <path>');
  console.log('  node tools/cobolt-btw-harvest.js harvest --mode <hint|query|suggest|note>');
  console.log('');
  console.log('Options:');
  console.log('  --request <path>        Path to a btw-request JSON file');
  console.log('  --mode <m>              Force a mode when no request file is supplied');
  console.log('  --target-kind <k>       Target kind when constructing a request inline');
  console.log('  --target-value <v>      Target value when constructing a request inline');
  console.log('  --json                  Emit full packet JSON (default: summary)');
}

function runCli(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    return 0;
  }
  const [subcommand, ...rest] = argv;
  if (subcommand !== 'harvest') {
    console.error(`Unknown subcommand: ${subcommand}`);
    printHelp();
    return 1;
  }
  let opts;
  try {
    opts = parseArgs(rest);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  if (opts.help) {
    printHelp();
    return 0;
  }
  let request;
  try {
    request = loadRequest(opts);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  const packet = harvestContext(request);
  if (opts.json) {
    console.log(JSON.stringify(packet, null, 2));
  } else {
    console.log(`stage=${packet.sources.state.currentStage || 'unknown'}`);
    console.log(`milestone=${packet.sources.state.currentMilestone || 'none'}`);
    console.log(`milestone-files=${packet.sources.milestones.count}`);
    console.log(`gate-skips-tail=${packet.sources.recentGateSkips.length}`);
    console.log(`git-commits=${packet.sources.gitLog.commits.length}`);
  }
  return 0;
}

module.exports = {
  harvestContext,
  resolveMemoryPath,
  runCli,
  DEFAULT_MAX_BYTES,
};

if (require.main === module) {
  const code = runCli(process.argv.slice(2));
  process.exit(code || 0);
}
