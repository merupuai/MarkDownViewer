#!/usr/bin/env node

// Accuracy evaluator.
// Note: the /evals subsystem (lib/cobolt-evals, tools/cobolt-evals) is
// complementary — not a replacement — for this tool. Where an evals score
// history is available, we surface it here as an additional sub-signal so
// operators can reconcile both views from one report. This reader is
// non-breaking: missing evals history simply hides the subsection.

const path = require('node:path');

const { evaluateAccuracy, writeAccuracyReport } = require('../lib/cobolt-accuracy-evaluator');

function printUsage() {
  console.log();
  console.log('  CoBolt Accuracy Evaluator');
  console.log('  ═════════════════════════');
  console.log();
  console.log('  Usage: node tools/cobolt-accuracy-evaluator.js check [options]');
  console.log();
  console.log('  Options:');
  console.log('    --save                 Save the latest report');
  console.log('    --json                 Print JSON');
  console.log('    --fixtures <dir>       Override golden fixture directory');
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

function printReport(report) {
  console.log();
  console.log('  CoBolt Accuracy Evaluator');
  console.log('  ═════════════════════════');
  console.log();
  console.log(`  Verdict: ${report.summary.verdict} (${report.summary.grade}, ${report.summary.score}%)`);
  console.log(`  Findings: ${report.summary.findings}`);
  console.log();
  for (const [name, component] of Object.entries(report.components)) {
    const label = `${name}`.padEnd(18);
    const score = component.score === null ? 'n/a' : `${component.score}%`;
    console.log(`  ${label} ${score}  ${component.detail}`);
  }
  console.log();

  const evals = report.components.evalsRollup;
  if (evals?.available) {
    console.log(`  Evals rollup: ${evals.score}% (source: ${path.relative(process.cwd(), evals.path)})`);
    console.log();
  }

  if (report.findings.length > 0) {
    console.log('  Findings:');
    for (const finding of report.findings) {
      console.log(`    - [${finding.severity.toUpperCase()}] ${finding.title}`);
    }
    console.log();
  }
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

  const fixtureDirs = args.fixtures ? [args.fixtures] : undefined;
  const report = evaluateAccuracy(process.cwd(), { fixtureDirs });

  if (args.save) {
    writeAccuracyReport(process.cwd(), report);
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  process.exit(report.summary.verdict === 'FAIL' ? 1 : 0);
}

module.exports = {
  evaluateAccuracy,
  writeAccuracyReport,
};

if (require.main === module) {
  main();
}
