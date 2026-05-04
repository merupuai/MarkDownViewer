#!/usr/bin/env node

const path = require('node:path');

const { buildPluginLock, lockfilePath, verifyPluginLock, writePluginLock } = require('../lib/cobolt-plugin-lock');

function argValue(args, name, fallback = null) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] || fallback : fallback;
}

function optionsFromArgs(args) {
  return {
    homeDir: argValue(args, '--home'),
    installedPluginsPath: argValue(args, '--installed-plugins'),
    lockfile: argValue(args, '--lockfile'),
    includeAll: args.includes('--include-all'),
  };
}

function cmdInit(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const lock = buildPluginLock(root, optionsFromArgs(args));
  const filePath = writePluginLock(root, lock);
  console.log(`plugin lockfile written: ${filePath}`);
  return 0;
}

function cmdVerify(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const verdict = verifyPluginLock(root, optionsFromArgs(args));
  console.log(JSON.stringify({ schema: 'cobolt-plugin-lock-verify@1', ...verdict }, null, 2));
  return verdict.ok ? 0 : 1;
}

function cmdShow(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  console.log(lockfilePath(root));
  return 0;
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const args = argv.slice(1);
  if (cmd === 'init') return cmdInit(args);
  if (cmd === 'verify' || cmd === 'doctor') return cmdVerify(args);
  if (cmd === 'path') return cmdShow(args);
  console.log('Usage: node tools/cobolt-plugin-lock.js init|verify|path [--installed-plugins FILE]');
  return cmd ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { main, cmdInit, cmdVerify };
