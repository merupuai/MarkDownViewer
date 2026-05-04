#!/usr/bin/env node

const path = require('node:path');
const { buildToolReliabilityReport, writeToolReliabilityReport } = require('./_brownfield-tool-reliability');

function defaultBrownfieldDir() {
  return path.join(process.cwd(), '_cobolt-output', 'latest', 'brownfield');
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'check';
  const dirIdx = args.indexOf('--dir');
  const bfDir = dirIdx !== -1 && args[dirIdx + 1] ? path.resolve(args[dirIdx + 1]) : defaultBrownfieldDir();
  const jsonMode = args.includes('--json');
  const write = args.includes('--write') || command === 'build';

  if (command !== 'check' && command !== 'build') {
    console.log('CoBolt Brownfield Tool Health');
    console.log('');
    console.log('Usage:');
    console.log('  node tools/cobolt-brownfield-tool-health.js check [--dir <path>] [--json] [--write]');
    console.log('  node tools/cobolt-brownfield-tool-health.js build [--dir <path>] [--json]');
    process.exit(2);
  }

  const report = buildToolReliabilityReport(bfDir);
  if (write) writeToolReliabilityReport(bfDir, report);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('[cobolt-brownfield-tool-health] Tool Reliability');
    console.log(`  Status: ${report.status.toUpperCase()} | Trust score: ${report.trustScore ?? 'n/a'}/100`);
    console.log(
      `  Present: ${report.summary.present}/${report.summary.total} | Degraded: ${report.degradedArtifacts.length} | Blocking: ${report.summary.blockingFailures}`,
    );
    for (const artifact of report.artifacts.filter((entry) => entry.status !== 'trusted')) {
      const detail = [...(artifact.issues || []).map((issue) => issue.message), ...(artifact.warnings || [])]
        .filter(Boolean)
        .slice(0, 2)
        .join('; ');
      console.log(`  [${artifact.status.toUpperCase()}] ${artifact.artifact}${detail ? `: ${detail}` : ''}`);
    }
  }

  process.exit(report.status === 'fail' ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildToolReliabilityReport,
  writeToolReliabilityReport,
};
