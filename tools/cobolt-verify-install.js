#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { defaultReleaseSubjects, sha256File, verifyAttestation } = require('../lib/cobolt-provenance');

function argValue(args, name, fallback = null) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] || fallback : fallback;
}

function defaultManifestPath(root = process.cwd()) {
  return path.join(root, '_cobolt-output', 'release', 'install-trust', 'latest.json');
}

function defaultAttestationPath(root = process.cwd()) {
  return path.join(root, '_cobolt-output', 'release', 'provenance', 'latest.intoto.json');
}

function createInstallTrustManifest(root = process.cwd(), options = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const files = defaultReleaseSubjects(root).map((file) => ({
    path: path.relative(root, file).replace(/\\/g, '/'),
    sha256: sha256File(file),
  }));
  const attestationPath = options.attestation || defaultAttestationPath(root);
  return {
    schema: 'cobolt-install-trust@1',
    generatedAt: new Date().toISOString(),
    package: {
      name: pkg.name,
      version: pkg.version,
      repository: pkg.repository?.url || null,
    },
    files,
    provenance: fs.existsSync(attestationPath)
      ? {
          path: path.relative(root, attestationPath).replace(/\\/g, '/'),
          sha256: sha256File(attestationPath),
        }
      : null,
  };
}

function verifyInstallTrustManifest(manifest, root = process.cwd(), options = {}) {
  const findings = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.schema !== 'cobolt-install-trust@1') {
    findings.push({ code: 'INVALID_SCHEMA', message: 'install trust manifest schema mismatch' });
  }
  if (manifest.package?.name !== pkg.name) {
    findings.push({ code: 'PACKAGE_NAME_MISMATCH', expected: manifest.package?.name, actual: pkg.name });
  }
  if (manifest.package?.version !== pkg.version) {
    findings.push({ code: 'PACKAGE_VERSION_MISMATCH', expected: manifest.package?.version, actual: pkg.version });
  }
  for (const file of manifest.files || []) {
    const absolute = path.join(root, file.path);
    if (!fs.existsSync(absolute)) {
      findings.push({ code: 'FILE_MISSING', file: file.path });
      continue;
    }
    const actual = sha256File(absolute);
    if (actual !== file.sha256)
      findings.push({ code: 'FILE_DIGEST_MISMATCH', file: file.path, expected: file.sha256, actual });
  }
  if (!manifest.provenance) {
    if (!options.allowUnsigned)
      findings.push({ code: 'PROVENANCE_MISSING', message: 'install manifest has no provenance attestation' });
  } else {
    const attestationPath = path.join(root, manifest.provenance.path);
    if (!fs.existsSync(attestationPath)) {
      findings.push({ code: 'PROVENANCE_FILE_MISSING', file: manifest.provenance.path });
    } else if (sha256File(attestationPath) !== manifest.provenance.sha256) {
      findings.push({ code: 'PROVENANCE_DIGEST_MISMATCH', file: manifest.provenance.path });
    } else {
      const attestation = JSON.parse(fs.readFileSync(attestationPath, 'utf8'));
      const verdict = verifyAttestation(attestation, {
        root,
        key: options.key,
        allowUnsigned: options.allowUnsigned,
      });
      if (!verdict.ok) findings.push(...verdict.findings.map((finding) => ({ ...finding, source: 'provenance' })));
    }
  }
  return { ok: findings.length === 0, findings };
}

function signingKey(args) {
  const key = argValue(args, '--key');
  if (key) return key;
  const keyEnv = argValue(args, '--key-env', 'COBOLT_PROVENANCE_KEY');
  return process.env[keyEnv] || '';
}

function cmdManifest(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const manifest = createInstallTrustManifest(root, { attestation: argValue(args, '--attestation') });
  const out = path.resolve(argValue(args, '--output', defaultManifestPath(root)));
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(`install trust manifest written: ${out}`);
  return 0;
}

function cmdVerify(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const manifestPath = path.resolve(argValue(args, '--manifest', defaultManifestPath(root)));
  if (!fs.existsSync(manifestPath)) {
    if (args.includes('--allow-missing')) {
      console.log(`install verify: skipped (missing ${manifestPath})`);
      return 0;
    }
    console.error(`install verify: missing manifest ${manifestPath}`);
    return 1;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const verdict = verifyInstallTrustManifest(manifest, root, {
    key: signingKey(args),
    allowUnsigned: args.includes('--allow-unsigned'),
  });
  console.log(JSON.stringify({ schema: 'cobolt-install-verify@1', manifest: manifestPath, ...verdict }, null, 2));
  return verdict.ok ? 0 : 1;
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const args = argv.slice(1);
  if (cmd === 'manifest') return cmdManifest(args);
  if (cmd === 'verify') return cmdVerify(args);
  console.log('Usage: node tools/cobolt-verify-install.js manifest|verify [--manifest FILE] [--allow-unsigned]');
  return cmd ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  createInstallTrustManifest,
  verifyInstallTrustManifest,
  cmdManifest,
  cmdVerify,
  main,
};
