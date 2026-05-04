#!/usr/bin/env node

// CoBolt Dead Ends — Negative knowledge accumulation for fix loops.
//
// CORAL-inspired: records failed fix approaches so subsequent iterations
// (and LOOP_PIVOT strategy shifts) avoid repeating dead-end strategies.
// Append-only JSONL for concurrent safety.

const fs = require('node:fs');
const path = require('node:path');

const { paths: getPaths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

function resolveDeadEndsPath(projectDir, options = {}) {
  if (options.file) return options.file;

  const root = projectDir || process.cwd();
  const pathHelper = typeof getPaths === 'function' ? getPaths(root) : null;
  const fixDir = pathHelper?.latestFix ? pathHelper.latestFix() : path.join(root, '_cobolt-output', 'latest', 'fix');
  return path.join(fixDir, 'dead-ends.jsonl');
}

function record(projectDir, entry, options = {}) {
  const filePath = resolveDeadEndsPath(projectDir, options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const record = {
    id: entry.id || entry.findingId || null,
    approach: entry.approach || '',
    reason: entry.reason || entry.whyFailed || '',
    agent: entry.agent || null,
    iteration: Number.isInteger(entry.iteration) ? entry.iteration : null,
    milestone: entry.milestone || null,
    category: entry.category || null,
    timestamp: new Date().toISOString(),
  };

  if (!record.approach) {
    throw new Error('Dead-end entry requires an "approach" field describing what was tried');
  }

  // v0.16.1: use fd+fsync to guarantee durability on abnormal process exit.
  // Default appendFileSync may buffer on Windows and lose the record.
  const fd = fs.openSync(filePath, 'a');
  try {
    fs.writeSync(fd, `${JSON.stringify(record)}\n`, null, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch {
      /* fsync unsupported on some FS */
    }
  } finally {
    fs.closeSync(fd);
  }
  return { filePath, record };
}

function readAll(projectDir, options = {}) {
  const filePath = resolveDeadEndsPath(projectDir, options);
  if (!fs.existsSync(filePath)) return [];

  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function query(projectDir, filters = {}, options = {}) {
  let entries = readAll(projectDir, options);

  if (filters.milestone) {
    entries = entries.filter((e) => e.milestone === filters.milestone);
  }
  if (filters.category) {
    entries = entries.filter((e) => e.category === filters.category);
  }
  if (filters.id) {
    entries = entries.filter((e) => e.id === filters.id);
  }
  if (filters.agent) {
    entries = entries.filter((e) => e.agent === filters.agent);
  }

  return entries;
}

function summary(projectDir, filters = {}, options = {}) {
  const entries = query(projectDir, filters, options);
  if (entries.length === 0) return '';

  const lines = ['## Dead Ends — Approaches That Failed', ''];
  const byId = {};

  for (const entry of entries) {
    const key = entry.id || 'general';
    if (!byId[key]) byId[key] = [];
    byId[key].push(entry);
  }

  for (const [id, group] of Object.entries(byId)) {
    lines.push(`### ${id}`);
    for (const entry of group) {
      const agentNote = entry.agent ? ` (${entry.agent})` : '';
      const iterNote = entry.iteration != null ? ` iter ${entry.iteration}` : '';
      lines.push(`- **Tried**: ${entry.approach}${agentNote}${iterNote}`);
      if (entry.reason) lines.push(`  **Why failed**: ${entry.reason}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function stats(projectDir, options = {}) {
  const entries = readAll(projectDir, options);
  const byCategory = {};
  const byAgent = {};

  for (const entry of entries) {
    const cat = entry.category || 'uncategorized';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    if (entry.agent) {
      byAgent[entry.agent] = (byAgent[entry.agent] || 0) + 1;
    }
  }

  return {
    total: entries.length,
    byCategory,
    byAgent,
    earliest: entries[0]?.timestamp || null,
    latest: entries[entries.length - 1]?.timestamp || null,
  };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function printUsage() {
  console.log(`
CoBolt Dead Ends — Negative knowledge accumulation

Usage:
  node tools/cobolt-dead-ends.js record --approach "..." --reason "..." [--id SEC-003] [--agent backend-fix] [--iteration 2] [--milestone M1] [--category SEC]
  node tools/cobolt-dead-ends.js query [--milestone M1] [--category SEC] [--id SEC-003] [--json]
  node tools/cobolt-dead-ends.js summary [--milestone M1] [--category SEC]
  node tools/cobolt-dead-ends.js stats [--json]
`);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] || 'help';

  if (command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return 0;
  }

  if (command === 'record') {
    if (!args.approach) {
      console.error('[cobolt-dead-ends] --approach is required');
      return 1;
    }

    let parsedIteration;
    if (args.iteration !== undefined) {
      parsedIteration = Number.parseInt(args.iteration, 10);
      if (!Number.isInteger(parsedIteration)) {
        console.error(`[cobolt-dead-ends] --iteration must be an integer, got "${args.iteration}"`);
        return 1;
      }
    }

    try {
      const result = record(process.cwd(), {
        approach: args.approach,
        reason: args.reason,
        id: args.id,
        agent: args.agent,
        iteration: parsedIteration,
        milestone: args.milestone,
        category: args.category,
      });
      console.log(`[cobolt-dead-ends] Recorded dead end → ${result.filePath}`);
      return 0;
    } catch (error) {
      console.error(`[cobolt-dead-ends] ${error.message}`);
      return 1;
    }
  }

  if (command === 'query') {
    const entries = query(process.cwd(), {
      milestone: args.milestone,
      category: args.category,
      id: args.id,
      agent: args.agent,
    });
    if (args.json) {
      console.log(JSON.stringify(entries, null, 2));
    } else {
      if (entries.length === 0) {
        console.log('[cobolt-dead-ends] No dead ends recorded.');
      } else {
        for (const entry of entries) {
          console.log(`  ${entry.id || '-'}: ${entry.approach} (${entry.reason || 'no reason'})`);
        }
      }
    }
    return 0;
  }

  if (command === 'summary') {
    const text = summary(process.cwd(), {
      milestone: args.milestone,
      category: args.category,
    });
    if (text) {
      process.stdout.write(text);
    } else {
      console.log('[cobolt-dead-ends] No dead ends to summarize.');
    }
    return 0;
  }

  if (command === 'stats') {
    const result = stats(process.cwd());
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`[cobolt-dead-ends] Total: ${result.total}`);
      for (const [cat, count] of Object.entries(result.byCategory)) {
        console.log(`  ${cat}: ${count}`);
      }
    }
    return 0;
  }

  console.error(`[cobolt-dead-ends] Unknown command: ${command}`);
  printUsage();
  return 1;
}

module.exports = {
  record,
  readAll,
  query,
  summary,
  stats,
  resolveDeadEndsPath,
  main,
};

if (require.main === module) {
  process.exit(main());
}
