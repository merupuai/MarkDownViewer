#!/usr/bin/env node

// CoBolt Fix Evidence helper.
// Emits machine-readable evidence expectations for the fix team teardown
// protocol. The current contract is intentionally conservative: patched
// source paths from fix-task-manifest.json are the teardown census targets.

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const out = {
    command: argv[0] || 'help',
    manifest: path.join('_cobolt-output', 'latest', 'fix', 'fix-task-manifest.json'),
    iteration: null,
    json: false,
    help: false,
  };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--manifest') {
      out.manifest = argv[i + 1] || out.manifest;
      i += 1;
    } else if (arg.startsWith('--manifest=')) out.manifest = arg.slice('--manifest='.length);
    else if (arg === '--iteration') {
      out.iteration = argv[i + 1] || null;
      i += 1;
    } else if (arg.startsWith('--iteration=')) out.iteration = arg.slice('--iteration='.length);
    else if (arg.startsWith('--')) out.unknown = arg;
  }
  return out;
}

function printUsage() {
  console.log('Usage: node tools/cobolt-fix-evidence.js expected-paths [--manifest <file>] [--json]');
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function expectedPaths({ manifestPath }) {
  const manifest = readJson(manifestPath);
  const paths = new Set();
  for (const task of manifest?.tasks || []) {
    for (const filePath of task.files || []) {
      if (typeof filePath === 'string' && filePath.trim()) {
        paths.add(filePath.trim());
      }
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || args.command === 'help') {
    printUsage();
    return 0;
  }
  if (args.unknown) {
    console.error(`Unknown option: ${args.unknown}`);
    printUsage();
    return 2;
  }
  if (args.command !== 'expected-paths') {
    console.error(`Unknown command: ${args.command}`);
    printUsage();
    return 2;
  }

  const manifestPath = path.resolve(process.cwd(), args.manifest);
  const paths = expectedPaths({ manifestPath });
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          generatedBy: 'cobolt-fix-evidence',
          manifestPath,
          iteration: args.iteration == null ? null : Number(args.iteration),
          expectedPaths: paths,
        },
        null,
        2,
      ),
    );
  } else {
    for (const filePath of paths) console.log(`${filePath}:1`);
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  expectedPaths,
  main,
};
