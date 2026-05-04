#!/usr/bin/env node

const path = require('node:path');

const { archiveArtifacts, classifyArtifacts, purgeArtifacts } = require('../lib/cobolt-artifact-governance');

function argValue(args, name, fallback = null) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] || fallback : fallback;
}

function classesFromArgs(args) {
  const raw = argValue(args, '--class') || argValue(args, '--classes');
  return raw
    ? raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function cmdClassify(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const manifest = classifyArtifacts(root, { write: args.includes('--write') || args.includes('--save') });
  console.log(JSON.stringify(manifest, null, 2));
  return 0;
}

function cmdArchive(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const keyEnv = argValue(args, '--key-env');
  const report = archiveArtifacts(root, {
    classes: classesFromArgs(args),
    encryptKey: keyEnv ? process.env[keyEnv] : null,
  });
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

function cmdPurge(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const olderThanDays = Number(argValue(args, '--older-than-days', 0));
  const report = purgeArtifacts(root, {
    classes: classesFromArgs(args),
    olderThanDays,
    dryRun: args.includes('--dry-run'),
  });
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const args = argv.slice(1);
  if (cmd === 'classify') return cmdClassify(args);
  if (cmd === 'archive') return cmdArchive(args);
  if (cmd === 'purge') return cmdPurge(args);
  console.log('Usage: node tools/cobolt-output-governance.js classify|archive|purge [--class secret] [--dry-run]');
  return cmd ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { main, cmdArchive, cmdClassify, cmdPurge };
