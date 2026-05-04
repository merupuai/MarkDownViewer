#!/usr/bin/env node

// CoBolt Finding Verifier — CLI wrapper around the source hook implementation.
//
// Keeps the verifier invocable from tools/ while sharing a single source of truth
// with the hook that post-processes review findings.

const verifier = require('../source/hooks/cobolt-finding-verifier');

module.exports = verifier;

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('usage: cobolt-finding-verifier [--findings <path>] [--sample-rate <0-100>] [--strict]\n');
    process.exit(0);
  }
  const result = verifier.run(null);
  if (result?.exitCode) {
    process.exitCode = result.exitCode;
  }
}
