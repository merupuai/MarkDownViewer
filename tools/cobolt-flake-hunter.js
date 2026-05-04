#!/usr/bin/env node

const { analyzeFlakes, readHistory, resolveFlakePaths, writeFlakeHunterReport } = require('../lib/cobolt-flake-hunter');

function printUsage() {
  console.log();
  console.log('  CoBolt Flake Hunter');
  console.log('  ═══════════════════');
  console.log();
  console.log('  Usage: node tools/cobolt-flake-hunter.js <command> [options]');
  console.log();
  console.log('  Commands:');
  console.log('    check                 Analyze recent test history for flakiness');
  console.log('    history               Show stored flake score history');
  console.log();
  console.log('  Options:');
  console.log('    --save                Save the latest report');
  console.log('    --json                Print JSON');
  console.log('    --min-runs <n>        Minimum runs before a case is considered flaky (default: 3)');
  console.log('    --max-runs <n>        Number of recent runs to inspect (default: 12)');
  console.log();
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

function printCheckReport(report) {
  console.log();
  console.log('  CoBolt Flake Hunter');
  console.log('  ═══════════════════');
  console.log();
  console.log(`  Verdict: ${report.summary.verdict} (${report.summary.grade}, ${report.summary.score}%)`);
  console.log(`  Unstable cases:      ${report.summary.unstableCases}`);
  console.log(`  Playwright retries:  ${report.summary.playwrightRetries}`);
  console.log(`  Suite flip count:    ${report.summary.suiteFlips}`);
  if (report.summary.durationRegression) {
    console.log(`  Duration regression: +${report.summary.durationRegression.regressionPercent}% vs recent baseline`);
  }
  console.log();

  if (report.findings.length === 0) {
    console.log('  No flake patterns detected.');
    console.log();
    return;
  }

  console.log('  Findings:');
  for (const finding of report.findings.slice(0, 12)) {
    console.log(`    - [${finding.severity.toUpperCase()}] ${finding.title}`);
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

  if (command === 'check') {
    const report = analyzeFlakes(process.cwd(), {
      minRuns: args['min-runs'] ? parseInt(args['min-runs'], 10) : undefined,
      maxRuns: args['max-runs'] ? parseInt(args['max-runs'], 10) : undefined,
    });

    if (args.save) {
      writeFlakeHunterReport(process.cwd(), report);
    }

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printCheckReport(report);
    }

    process.exit(report.summary.verdict === 'FAIL' ? 1 : 0);
  }

  if (command === 'history') {
    const { historyPath } = resolveFlakePaths(process.cwd());
    const history = readHistory(historyPath);

    if (args.json) {
      console.log(JSON.stringify(history, null, 2));
      process.exit(0);
    }

    console.log();
    console.log('  CoBolt Flake Hunter History');
    console.log('  ═══════════════════════════');
    console.log();

    if (history.entries.length === 0) {
      console.log('  No history recorded yet.');
      console.log();
      process.exit(0);
    }

    for (const entry of history.entries.slice(-10).reverse()) {
      console.log(
        `  ${entry.generatedAt}  score=${entry.score} verdict=${entry.verdict} unstable=${entry.unstableCases} retries=${entry.playwrightRetries}`,
      );
    }
    console.log();
    process.exit(0);
  }

  console.error(`  Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}

module.exports = {
  analyzeFlakes,
  readHistory,
  writeFlakeHunterReport,
};

if (require.main === module) {
  main();
}
