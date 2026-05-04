#!/usr/bin/env node

// cobolt-btw-log — append-only audit logger for /cobolt-btw.
//
// Writes structured entries to _cobolt-output/audit/btw-log.jsonl. Used by
// the cobolt-btw skill Step 04 and as a data source for cobolt-evolve
// classifier tuning (Tier 3, advisory only).
//
// Usage:
//   node tools/cobolt-btw-log.js append --request <path> --response <path>
//   node tools/cobolt-btw-log.js append --inline '<json>'
//   node tools/cobolt-btw-log.js tail [--limit 20]

const fs = require('node:fs');
const path = require('node:path');

function auditDir(cwd = process.cwd()) {
  return path.join(cwd, '_cobolt-output', 'audit');
}

function logFile(cwd = process.cwd()) {
  return path.join(auditDir(cwd), 'btw-log.jsonl');
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

function readJsonFile(p) {
  const abs = path.resolve(p);
  const data = fs.readFileSync(abs, 'utf8');
  return JSON.parse(data);
}

function pickRequestFields(request) {
  if (!request || typeof request !== 'object') return {};
  return {
    requestId: request.requestId || null,
    mode: request.mode || null,
    utterance: typeof request.utterance === 'string' ? request.utterance.slice(0, 400) : null,
    confidence: typeof request.confidence === 'number' ? request.confidence : null,
    target: request.target || null,
    flags: request.flags || null,
  };
}

function pickResponseFields(response) {
  if (!response || typeof response !== 'object') return {};
  return {
    summary: typeof response.summary === 'string' ? response.summary.slice(0, 400) : null,
    handoffStatus: response.handoff ? response.handoff.status : null,
    delegatedTo: response.handoff ? response.handoff.delegatedTo || null : null,
    noteWritten: response.noteWritten || null,
    suggestions: Array.isArray(response.suggestions)
      ? response.suggestions.map((s) => ({
          action: typeof s.action === 'string' ? s.action.slice(0, 200) : null,
          skillHandoff: s.skillHandoff || null,
        }))
      : [],
  };
}

function buildEntry({ request, response, extra = {} }) {
  const now = new Date().toISOString();
  return {
    ts: now,
    ...pickRequestFields(request),
    ...pickResponseFields(response),
    ...extra,
  };
}

function appendEntry(entry, options = {}) {
  const cwd = options.cwd || process.cwd();
  const dir = auditDir(cwd);
  ensureDir(dir);
  const line = `${JSON.stringify(entry)}\n`;
  fs.appendFileSync(logFile(cwd), line, { encoding: 'utf8' });
  return { ok: true, path: logFile(cwd) };
}

function tailEntries(limit = 20, options = {}) {
  const cwd = options.cwd || process.cwd();
  const file = logFile(cwd);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const out = [];
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return out;
}

function parseArgs(argv) {
  const opts = {
    subcommand: null,
    request: null,
    response: null,
    inline: null,
    limit: 20,
    help: false,
  };
  if (argv.length === 0) return opts;
  opts.subcommand = argv[0];
  let i = 1;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--request') opts.request = argv[++i];
    else if (arg === '--response') opts.response = argv[++i];
    else if (arg === '--inline') opts.inline = argv[++i];
    else if (arg === '--limit') opts.limit = Math.max(1, Number(argv[++i]) || 20);
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown flag: ${arg}`);
    i += 1;
  }
  return opts;
}

function printHelp() {
  console.log('cobolt-btw-log — append-only audit log for /cobolt-btw');
  console.log('');
  console.log('Subcommands:');
  console.log('  append --request <path> [--response <path>]');
  console.log("  append --inline '<json entry>'");
  console.log('  tail [--limit N]');
}

function runCli(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    return 0;
  }
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  if (opts.help) {
    printHelp();
    return 0;
  }

  if (opts.subcommand === 'append') {
    let entry;
    try {
      if (opts.inline) {
        entry = JSON.parse(opts.inline);
      } else {
        const request = opts.request ? readJsonFile(opts.request) : null;
        const response = opts.response ? readJsonFile(opts.response) : null;
        entry = buildEntry({ request, response });
      }
    } catch (err) {
      console.error(`Failed to build entry: ${err.message}`);
      return 1;
    }
    try {
      const result = appendEntry(entry);
      console.log(`appended to ${path.relative(process.cwd(), result.path)}`);
      return 0;
    } catch (err) {
      console.error(`Failed to append: ${err.message}`);
      return 1;
    }
  }

  if (opts.subcommand === 'tail') {
    const entries = tailEntries(opts.limit);
    for (const entry of entries) {
      console.log(JSON.stringify(entry));
    }
    return 0;
  }

  console.error(`Unknown subcommand: ${opts.subcommand}`);
  printHelp();
  return 1;
}

module.exports = {
  auditDir,
  logFile,
  buildEntry,
  appendEntry,
  tailEntries,
  runCli,
};

if (require.main === module) {
  const code = runCli(process.argv.slice(2));
  process.exit(code || 0);
}
