#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const enterprise = require('../lib/cobolt-enterprise');

function argValue(args, name, fallback = null) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] || fallback : fallback;
}

function signingKey(args) {
  const key = argValue(args, '--key');
  if (key) return key;
  const keyEnv = argValue(args, '--key-env', 'COBOLT_PROVENANCE_KEY');
  return process.env[keyEnv] || '';
}

function cmdCreate(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const manifest = enterprise.buildRunManifest(root, {
    runId: argValue(args, '--run-id', 'latest'),
    tenant: argValue(args, '--tenant'),
    key: signingKey(args),
    keyId: argValue(args, '--key-id', 'local'),
  });
  const out = enterprise.writeRunManifest(root, manifest, argValue(args, '--output'));
  console.log(JSON.stringify({ schema: 'cobolt-run-manifest-create@1', manifestPath: out, manifest }, null, 2));
  return 0;
}

function cmdVerify(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const manifestPath = path.resolve(
    root,
    argValue(args, '--manifest', enterprise.defaultRunManifestPath(root, argValue(args, '--run-id', 'latest'))),
  );
  if (!fs.existsSync(manifestPath)) {
    console.error(`run manifest missing: ${manifestPath}`);
    return 1;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const verdict = enterprise.verifyRunManifest(root, manifest, {
    key: signingKey(args),
    allowUnsigned: args.includes('--allow-unsigned'),
  });
  console.log(JSON.stringify({ schema: 'cobolt-run-manifest-verify@1', manifestPath, ...verdict }, null, 2));
  return verdict.ok ? 0 : 1;
}

function cmdReplay(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const verifyCode = cmdVerify(args);
  if (verifyCode !== 0) return verifyCode;
  console.log(
    JSON.stringify(
      {
        schema: 'cobolt-run-replay@1',
        replayed: 'deterministic-boundaries-only',
        next: 'Use node tools/cobolt-pipeline-replay.js replay for recorded stage fixtures.',
        rootHashOnly: true,
      },
      null,
      2,
    ),
  );
  return root ? 0 : 0;
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0] || 'create';
  const args = argv.slice(1);
  if (cmd === 'create' || cmd === 'manifest') return cmdCreate(args);
  if (cmd === 'verify') return cmdVerify(args);
  if (cmd === 'replay') return cmdReplay(args);
  console.log('Usage: node tools/cobolt-run-manifest.js create|verify|replay [--run-id ID]');
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { main, cmdCreate, cmdVerify, cmdReplay };
