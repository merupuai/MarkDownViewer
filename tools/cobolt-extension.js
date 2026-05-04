#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function argValue(args, name, fallback = null) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] || fallback : fallback;
}

function validateExtensionManifest(manifest) {
  const findings = [];
  if (!manifest || manifest.schema !== 'cobolt-extension@1') findings.push({ code: 'INVALID_SCHEMA' });
  if (!/^cobolt-ext-[a-z0-9][a-z0-9-]*$/.test(String(manifest?.name || ''))) findings.push({ code: 'INVALID_NAME' });
  if (!manifest?.version) findings.push({ code: 'VERSION_MISSING' });
  if (!Array.isArray(manifest?.permissions?.rbac)) findings.push({ code: 'RBAC_PERMISSIONS_MISSING' });
  const sandbox = manifest?.permissions?.sandbox;
  if (!['read-only', 'workspace-write', 'network', 'privileged'].includes(sandbox))
    findings.push({ code: 'SANDBOX_INVALID' });
  if (sandbox === 'privileged' && !manifest?.permissions?.rbac?.includes('admin')) {
    findings.push({ code: 'PRIVILEGED_EXTENSION_REQUIRES_ADMIN' });
  }
  return { ok: findings.length === 0, findings };
}

function discoverExtensions(root = process.cwd()) {
  const dir = path.join(root, 'extensions');
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function cmdValidate(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const manifestPath = path.resolve(root, argValue(args, '--manifest', args[0] || 'cobolt-extension.json'));
  if (!fs.existsSync(manifestPath)) {
    console.error(`extension manifest missing: ${manifestPath}`);
    return 1;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const verdict = validateExtensionManifest(manifest);
  console.log(JSON.stringify({ schema: 'cobolt-extension-validate@1', manifestPath, manifest, ...verdict }, null, 2));
  return verdict.ok ? 0 : 1;
}

function cmdDiscover(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  console.log(JSON.stringify({ schema: 'cobolt-extension-discovery@1', manifests: discoverExtensions(root) }, null, 2));
  return 0;
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0] || 'validate';
  const args = argv.slice(1);
  if (cmd === 'validate') return cmdValidate(args);
  if (cmd === 'discover' || cmd === 'list') return cmdDiscover(args);
  console.log('Usage: node tools/cobolt-extension.js validate --manifest FILE | discover');
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { main, validateExtensionManifest, discoverExtensions };
