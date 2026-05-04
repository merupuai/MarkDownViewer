#!/usr/bin/env node

// CoBolt Test Obligations CLI (v0.13.7)
//
// Thin wrapper around lib/cobolt-test-obligations.js so skills invoke it via
// $COBOLT_TOOLS instead of doing path-arithmetic `require()` (CLAUDE.md
// invariant #14: no require('./lib/...') in skills).
//
// The skill step was constructing libRoot = path.join(COBOLT_HOME||'.','lib')
// which on a user project with no COBOLT_HOME and COBOLT_TOOLS="./tools"
// yielded "lib" — a bare module specifier that Node resolves through
// node_modules instead of the filesystem. The skill then failed with
//   "Cannot find module 'lib\cobolt-test-obligations'"
// mid-step 02 (build would then halt).
//
// Usage:
//   node tools/cobolt-test-obligations.js check --milestone M1 [--enforce-plan] [--enforce-files] [--json]
// Exit codes:
//   0 = no blocking failures
//   1 = blocking failures (formatted list on stderr)
//   2 = usage / internal error

const path = require('node:path');

function loadLib() {
  // tools/ and lib/ are siblings in a CoBolt checkout or npm install.
  // This require resolves via Node's file-path rules because the path starts with '..'
  return require(path.resolve(__dirname, '..', 'lib', 'cobolt-test-obligations.js'));
}

function parseArgs(argv) {
  const o = { cmd: argv[0], enforcePlan: false, enforceFiles: false, json: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--milestone' || a === '-m') o.milestone = argv[++i];
    else if (a === '--enforce-plan') o.enforcePlan = true;
    else if (a === '--enforce-files') o.enforceFiles = true;
    else if (a === '--json') o.json = true;
    else if (a === '--cwd') o.cwd = argv[++i];
  }
  return o;
}

function usage(code = 2) {
  console.error(
    'Usage: node tools/cobolt-test-obligations.js check --milestone M{n} [--enforce-plan] [--enforce-files] [--json]',
  );
  process.exit(code);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd !== 'check') return usage(2);
  if (!args.milestone || !/^M\d+$/.test(args.milestone)) return usage(2);

  const cwd = args.cwd || process.cwd();
  const lib = loadLib();
  const report = lib.evaluateTestObligations(cwd, args.milestone, {
    enforcePlan: args.enforcePlan,
    enforceFiles: args.enforceFiles,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  }

  if (Array.isArray(report.blocking) && report.blocking.length > 0) {
    if (!args.json) {
      console.error('ERROR: mandatory milestone test categories are missing from the test plan.');
      for (const failure of lib.formatBlockingFailures(report)) {
        console.error(`  - ${failure}`);
      }
    }
    process.exit(1);
  }

  if (!args.json) console.log(`test-obligations: no blocking failures for ${args.milestone}`);
  process.exit(0);
}

if (require.main === module) main();

module.exports = { loadLib, parseArgs };
