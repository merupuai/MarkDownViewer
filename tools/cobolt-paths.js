#!/usr/bin/env node

// CoBolt Paths — CLI wrapper for lib/cobolt-paths.js
//
// Usage:
//   node tools/cobolt-paths.js ensure-latest        # Force _cobolt-output/latest symlink to current run
//   node tools/cobolt-paths.js current              # Print current run path
//   node tools/cobolt-paths.js latest               # Print resolved latest path
//
// Exists so skills never do `require('./lib/cobolt-paths')` (CLAUDE.md invariant #14).

const { CoboltPaths } = require('../lib/cobolt-paths');

function printUsage() {
  console.error('usage: cobolt-paths.js <ensure-latest|current|latest>');
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    return 0;
  }

  const cmd = argv[0];
  const p = new CoboltPaths();

  try {
    switch (cmd) {
      case 'ensure-latest':
        p.ensureLatest();
        console.log('latest pointer ensured');
        return 0;
      case 'current':
        console.log(p.currentRun ? p.currentRun() : p.getCurrentRun?.() || '');
        return 0;
      case 'latest':
        console.log(p.latest ? p.latest() : p.getLatest?.() || '');
        return 0;
      default:
        printUsage();
        return 1;
    }
  } catch (err) {
    console.error(`cobolt-paths: ${err.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main };
