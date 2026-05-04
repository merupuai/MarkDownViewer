#!/usr/bin/env node

const { evaluateReliabilityGuard, writeReliabilityGuardReport } = require('../lib/cobolt-reliability-guard');

function printUsage() {
  console.log();
  console.log('  CoBolt Reliability Guard');
  console.log('  ════════════════════════');
  console.log();
  console.log('  Usage: node tools/cobolt-reliability-guard.js check [--save] [--json]');
  console.log();
}

function parseArgs(argv) {
  const args = { _: [] };
  for (const token of argv) {
    if (token.startsWith('--')) args[token.slice(2)] = true;
    else args._.push(token);
  }
  return args;
}

function printReport(report) {
  console.log();
  console.log('  CoBolt Reliability Guard');
  console.log('  ════════════════════════');
  console.log();
  console.log(`  Score: ${report.summary.score}%`);
  console.log(`  Failures: ${report.summary.failures}`);
  console.log(`  Warnings: ${report.summary.warnings}`);
  console.log();

  for (const check of report.checks) {
    console.log(`  [${check.status}] ${check.id} ${check.title}`);
    console.log(`    ${check.detail}`);
  }
  console.log();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || args.help) {
    printUsage();
    process.exit(0);
  }

  if (command !== 'check') {
    console.error(`  Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  const report = evaluateReliabilityGuard(process.cwd());
  if (args.save) {
    writeReliabilityGuardReport(process.cwd(), report);
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  process.exit(report.summary.pass ? 0 : 1);
}

module.exports = {
  evaluateReliabilityGuard,
  writeReliabilityGuardReport,
};

if (require.main === module) {
  main();
}
