#!/usr/bin/env node

const { evaluateConfigDrift, writeConfigDriftReport } = require('../lib/cobolt-config-drift');

function printUsage() {
  console.log();
  console.log('  CoBolt Config Drift');
  console.log('  ═══════════════════');
  console.log();
  console.log('  Usage: node tools/cobolt-config-drift.js check [--save] [--json]');
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
  console.log('  CoBolt Config Drift');
  console.log('  ═══════════════════');
  console.log();
  console.log(`  Score: ${report.summary.score}%`);
  console.log(`  Findings: ${report.summary.findings}`);
  console.log();

  if (report.findings.length === 0) {
    console.log('  No drift detected.');
    console.log();
    return;
  }

  for (const finding of report.findings) {
    console.log(`  [${finding.severity.toUpperCase()}] ${finding.title}`);
    console.log(`    ${finding.detail}`);
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

  const report = evaluateConfigDrift(process.cwd());
  if (args.save) {
    writeConfigDriftReport(process.cwd(), report);
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  process.exit(report.summary.pass ? 0 : 1);
}

module.exports = {
  evaluateConfigDrift,
  writeConfigDriftReport,
};

if (require.main === module) {
  main();
}
