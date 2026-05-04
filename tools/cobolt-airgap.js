#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { atomicWriteJSON } = require('../lib/cobolt-atomic-write');

function argValue(args, name, fallback = null) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] || fallback : fallback;
}

function checkFile(root, rel, required = true) {
  const absolute = path.join(root, rel);
  return {
    id: rel,
    path: rel,
    required,
    status: fs.existsSync(absolute) ? 'present' : required ? 'missing' : 'optional-missing',
  };
}

function verifyAirgap(root = process.cwd()) {
  const checks = [
    checkFile(root, 'package.json'),
    checkFile(root, 'package-lock.json'),
    checkFile(root, 'sbom.cdx.json', false),
    checkFile(root, '_cobolt-output/release/install-trust/latest.json', false),
    checkFile(root, 'docs/AIR-GAPPED-INSTALL.md'),
    checkFile(root, 'docs/TELEMETRY.md'),
  ];
  const missingRequired = checks.filter((check) => check.required && check.status === 'missing');
  return {
    schema: 'cobolt-airgap-verify@1',
    generatedAt: new Date().toISOString(),
    ok: missingRequired.length === 0,
    checks,
  };
}

function cmdVerify(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const result = verifyAirgap(root);
  const out = path.join(root, '_cobolt-output', 'reports', 'enterprise-readiness', 'airgap-verify.json');
  atomicWriteJSON(out, result, { mode: 0o600 });
  console.log(JSON.stringify({ ...result, reportPath: out }, null, 2));
  return result.ok ? 0 : 1;
}

function cmdRunbook() {
  console.log('Air-gapped install: see docs/AIR-GAPPED-INSTALL.md');
  console.log(
    'Minimum check: node tools/cobolt-airgap.js verify && node tools/cobolt-verify-install.js verify --allow-unsigned',
  );
  return 0;
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0] || 'verify';
  const args = argv.slice(1);
  if (cmd === 'verify' || cmd === 'check') return cmdVerify(args);
  if (cmd === 'runbook') return cmdRunbook(args);
  console.log('Usage: node tools/cobolt-airgap.js verify|runbook [--root DIR]');
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { main, verifyAirgap, cmdVerify };
