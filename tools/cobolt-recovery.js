#!/usr/bin/env node

// CoBolt Recovery — CLI wrapper for lib/cobolt-recovery.js
//
// Usage:
//   node tools/cobolt-recovery.js orchestrate --class <cls> --summary <str> [--evidence-json <json>]
//   node tools/cobolt-recovery.js orchestrate --payload-file <path>
//
// Exists so skills never do `require('./lib/cobolt-recovery')` (CLAUDE.md invariant #14).

const fs = require('node:fs');
const { orchestrateRecovery } = require('../lib/cobolt-recovery');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) {
      const key = k.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

function printUsage() {
  console.error(
    'usage: cobolt-recovery.js orchestrate --class <cls> --summary <str> [--evidence-json <json> | --payload-file <path>]',
  );
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    return 0;
  }

  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  try {
    if (cmd !== 'orchestrate') {
      printUsage();
      return 1;
    }

    let payload;
    if (args['payload-file']) {
      payload = JSON.parse(fs.readFileSync(args['payload-file'], 'utf8'));
    } else {
      payload = {
        class: args.class,
        summary: args.summary,
        evidence: args['evidence-json'] ? JSON.parse(args['evidence-json']) : {},
      };
    }

    const result = orchestrateRecovery(payload);
    console.log(JSON.stringify(result || { requested: true }, null, 2));
    return 0;
  } catch (err) {
    console.error(`cobolt-recovery: ${err.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main, parseArgs };
