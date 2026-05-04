#!/usr/bin/env node

const { correlateHotspots, writeRuntimeProfilerReport } = require('../lib/cobolt-runtime-profiler');

function printUsage() {
  console.log();
  console.log('  CoBolt Runtime Profiler');
  console.log('  ═══════════════════════');
  console.log();
  console.log('  Usage: node tools/cobolt-runtime-profiler.js correlate [--save] [--json]');
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
  console.log('  CoBolt Runtime Profiler');
  console.log('  ═══════════════════════');
  console.log();
  console.log(`  Verdict: ${report.summary.verdict} (${report.summary.score}%)`);
  console.log(
    `  Sources: lighthouse=${report.summary.sources.lighthouse} autocannon=${report.summary.sources.autocannon} profiles=${report.summary.sources.profiles} promex=${report.summary.sources.promEx}`,
  );
  console.log(`  Hotspots: ${report.summary.hotspots}`);
  console.log();

  if (report.hotspots.length === 0) {
    console.log('  No correlated hotspots detected.');
    console.log();
    return;
  }

  for (const hotspot of report.hotspots) {
    console.log(`  [${hotspot.severity.toUpperCase()}] ${hotspot.title}`);
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

  if (command !== 'correlate') {
    console.error(`  Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  const report = correlateHotspots(process.cwd());
  if (args.save) {
    writeRuntimeProfilerReport(process.cwd(), report);
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  process.exit(report.summary.verdict === 'FAIL' ? 1 : 0);
}

module.exports = {
  correlateHotspots,
  writeRuntimeProfilerReport,
};

if (require.main === module) {
  main();
}
