#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { validateUatEvidence } = require('../lib/cobolt-uat-evidence');

function printHelp() {
  console.log('CoBolt UAT Evidence Validator');
  console.log('');
  console.log('Usage: node tools/cobolt-uat-evidence-validate.js validate [options]');
  console.log('');
  console.log('Options:');
  console.log('  --json                 Print JSON result');
  console.log('  --output <file>        Write JSON result to file');
  console.log('  --allow-missing-files  Do not require referenced artifact files to exist');
  console.log('  --allow-missing-ledger Do not require Chrome DevTools MCP ledger entries');
  console.log('  --min-lighthouse <n>   Minimum Lighthouse category score (default 80)');
}

function parseArgs(argv) {
  const options = { command: argv[2] || 'validate' };
  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    if (arg === '--allow-missing-files') options.requireArtifactFiles = false;
    if (arg === '--allow-missing-ledger') options.requireMcpLedger = false;
    if (arg === '--output' && argv[i + 1]) options.output = argv[++i];
    if (arg === '--min-lighthouse' && argv[i + 1]) options.minLighthouseScore = Number(argv[++i]);
  }
  return options;
}

function writeOutput(projectRoot, output, result) {
  if (!output) return;
  const filePath = path.isAbsolute(output) ? output : path.join(projectRoot, output);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function main() {
  const options = parseArgs(process.argv);
  if (options.command === '--help' || options.command === 'help') {
    printHelp();
    return;
  }
  if (options.command !== 'validate') {
    console.error(`Unknown command: ${options.command}`);
    printHelp();
    process.exit(2);
  }

  const projectRoot = process.cwd();
  const result = validateUatEvidence(projectRoot, options);
  writeOutput(projectRoot, options.output, result);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.passed) {
    console.log('UAT evidence validation PASSED');
  } else {
    console.log('UAT evidence validation FAILED');
    for (const error of result.errors) console.log(`- ${error}`);
  }

  process.exit(result.passed ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs };
