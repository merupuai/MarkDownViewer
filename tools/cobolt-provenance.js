#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  createAttestation,
  defaultReleaseSubjects,
  sha256File,
  verifyAttestation,
} = require('../lib/cobolt-provenance');

function argValue(args, name, fallback = null) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] || fallback : fallback;
}

function allValues(args, name) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && args[i + 1]) values.push(args[i + 1]);
  }
  return values;
}

function outputPath(root, explicit) {
  return explicit || path.join(root, '_cobolt-output', 'release', 'provenance', 'latest.intoto.json');
}

function signingKey(args) {
  const key = argValue(args, '--key');
  if (key) return key;
  const keyEnv = argValue(args, '--key-env', 'COBOLT_PROVENANCE_KEY');
  return process.env[keyEnv] || '';
}

function cmdChecksum(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const subjects = allValues(args, '--subject');
  const files = subjects.length > 0 ? subjects : defaultReleaseSubjects(root);
  const result = {
    schema: 'cobolt-checksum-manifest@1',
    generatedAt: new Date().toISOString(),
    files: files.map((file) => {
      const absolute = path.isAbsolute(file) ? file : path.join(root, file);
      return {
        path: path.relative(root, absolute).replace(/\\/g, '/'),
        sha256: sha256File(absolute),
      };
    }),
  };
  const out = argValue(args, '--output');
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(path.resolve(out), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  return 0;
}

function cmdAttest(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const subjects = allValues(args, '--subject');
  const key = signingKey(args);
  if (!key && !args.includes('--allow-unsigned')) {
    console.error('provenance attest requires --key, --key-env, or --allow-unsigned');
    return 1;
  }
  const attestation = createAttestation({
    root,
    subjects: subjects.length > 0 ? subjects : defaultReleaseSubjects(root),
    key,
    keyId: argValue(args, '--key-id', 'local'),
  });
  const out = outputPath(root, argValue(args, '--output'));
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  fs.writeFileSync(out, `${JSON.stringify(attestation, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(`provenance attestation written: ${out}`);
  return 0;
}

function cmdVerify(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const attPath = outputPath(root, argValue(args, '--attestation') || argValue(args, '--manifest'));
  if (!fs.existsSync(attPath)) {
    if (args.includes('--allow-missing')) {
      console.log(`provenance verify: skipped (missing ${attPath})`);
      return 0;
    }
    console.error(`provenance verify: missing attestation ${attPath}`);
    return 1;
  }
  const attestation = JSON.parse(fs.readFileSync(attPath, 'utf8'));
  const verdict = verifyAttestation(attestation, {
    root,
    key: signingKey(args),
    allowUnsigned: args.includes('--allow-unsigned'),
  });
  console.log(JSON.stringify({ schema: 'cobolt-provenance-verify@1', attestation: attPath, ...verdict }, null, 2));
  return verdict.ok ? 0 : 1;
}

function printHelp() {
  console.log(`cobolt-provenance

Usage:
  node tools/cobolt-provenance.js checksum [--subject FILE] [--output FILE]
  node tools/cobolt-provenance.js attest [--subject FILE] [--key-env ENV|--key VALUE|--allow-unsigned]
  node tools/cobolt-provenance.js verify [--attestation FILE] [--key-env ENV|--key VALUE|--allow-unsigned]
`);
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const args = argv.slice(1);
  if (!cmd || cmd === '--help' || cmd === '-h') {
    printHelp();
    return 0;
  }
  if (cmd === 'checksum') return cmdChecksum(args);
  if (cmd === 'attest') return cmdAttest(args);
  if (cmd === 'verify') return cmdVerify(args);
  console.error(`unknown command: ${cmd}`);
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { main, cmdAttest, cmdChecksum, cmdVerify };
