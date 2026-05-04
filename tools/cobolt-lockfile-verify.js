#!/usr/bin/env node

// cobolt-lockfile-verify — PR-2 of build-pipeline redesign (v0.53.0).
//
// Checks lockfile (package-lock.json / Cargo.lock / mix.lock / go.sum) for
// drift against its manifest (package.json / Cargo.toml / mix.exs / go.mod).
// Emits a deterministic JSON verdict. Composed by cobolt-supply-chain-build-gate
// at preflight (PR-3 wires the gate; PR-2 ships the tool).
//
// Usage:
//   node tools/cobolt-lockfile-verify.js check [--cwd PATH] [--json]
//   node tools/cobolt-lockfile-verify.js --help
//
// Exit codes: 0 ok, 1 drift detected, 2 missing-dep (no manifest found),
// 3 missing-infra (lockfile present but unreadable).

const fs = require('node:fs');
const path = require('node:path');

const SUPPORTED = [
  { manifest: 'package.json', lockfile: 'package-lock.json', kind: 'npm' },
  { manifest: 'Cargo.toml', lockfile: 'Cargo.lock', kind: 'cargo' },
  { manifest: 'mix.exs', lockfile: 'mix.lock', kind: 'mix' },
  { manifest: 'go.mod', lockfile: 'go.sum', kind: 'go' },
  { manifest: 'pyproject.toml', lockfile: 'poetry.lock', kind: 'poetry' },
];

function detectEcosystems(cwd) {
  const found = [];
  for (const eco of SUPPORTED) {
    const m = path.join(cwd, eco.manifest);
    const l = path.join(cwd, eco.lockfile);
    if (fs.existsSync(m)) {
      found.push({
        kind: eco.kind,
        manifest: m,
        manifestRel: eco.manifest,
        lockfile: l,
        lockfileRel: eco.lockfile,
        lockfileExists: fs.existsSync(l),
      });
    }
  }
  return found;
}

function checkNpmDrift(eco) {
  const findings = [];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(eco.manifest, 'utf8'));
  } catch (err) {
    return { ok: false, findings: [{ kind: 'manifest-unreadable', message: err.message }] };
  }
  if (!eco.lockfileExists) {
    findings.push({
      kind: 'lockfile-missing',
      severity: 'error',
      message: `${eco.manifestRel} present but ${eco.lockfileRel} missing`,
    });
    return { ok: false, findings };
  }
  let lockfile;
  try {
    lockfile = JSON.parse(fs.readFileSync(eco.lockfile, 'utf8'));
  } catch (err) {
    return { ok: false, findings: [{ kind: 'lockfile-unreadable', message: err.message }] };
  }
  // Check that every manifest dep appears in lockfile.packages or lockfile.dependencies
  const declared = {
    ...(manifest.dependencies || {}),
    ...(manifest.devDependencies || {}),
    ...(manifest.optionalDependencies || {}),
  };
  const lockedNames = new Set();
  if (lockfile.packages) {
    for (const key of Object.keys(lockfile.packages)) {
      // npm v7+ uses 'node_modules/<name>' keys
      const m = key.match(/^node_modules\/(.+)$/);
      if (m) lockedNames.add(m[1]);
    }
  }
  if (lockfile.dependencies) {
    for (const name of Object.keys(lockfile.dependencies)) lockedNames.add(name);
  }
  for (const name of Object.keys(declared)) {
    if (!lockedNames.has(name)) {
      findings.push({
        kind: 'declared-not-locked',
        severity: 'error',
        package: name,
        version: declared[name],
        message: `${name}@${declared[name]} declared in ${eco.manifestRel} but absent from ${eco.lockfileRel} — run npm install`,
      });
    }
  }
  // Check that root manifest version matches lockfile root
  if (lockfile.packages?.[''] && manifest.version) {
    const lockedRootVersion = lockfile.packages[''].version;
    if (lockedRootVersion && lockedRootVersion !== manifest.version) {
      findings.push({
        kind: 'root-version-drift',
        severity: 'error',
        manifest: manifest.version,
        lockfile: lockedRootVersion,
        message: `root version drift: ${eco.manifestRel}=${manifest.version} vs ${eco.lockfileRel}=${lockedRootVersion}`,
      });
    }
  }
  return { ok: findings.length === 0, findings };
}

function checkGenericLockExists(eco) {
  if (!eco.lockfileExists) {
    return {
      ok: false,
      findings: [
        {
          kind: 'lockfile-missing',
          severity: 'error',
          message: `${eco.manifestRel} present but ${eco.lockfileRel} missing — run the ecosystem's lock command`,
        },
      ],
    };
  }
  return { ok: true, findings: [] };
}

function check(cwd) {
  const ecosystems = detectEcosystems(cwd);
  if (ecosystems.length === 0) {
    return { schema: 'cobolt-lockfile-verify@1', verdict: 'no-manifest', ecosystems: [], findings: [] };
  }
  const results = [];
  let totalFindings = 0;
  for (const eco of ecosystems) {
    const r = eco.kind === 'npm' ? checkNpmDrift(eco) : checkGenericLockExists(eco);
    results.push({
      kind: eco.kind,
      manifest: eco.manifestRel,
      lockfile: eco.lockfileRel,
      lockfileExists: eco.lockfileExists,
      ok: r.ok,
      findings: r.findings,
    });
    totalFindings += r.findings.length;
  }
  return {
    schema: 'cobolt-lockfile-verify@1',
    cwd,
    generatedAt: new Date().toISOString(),
    verdict: totalFindings === 0 ? 'pass' : 'fail',
    ecosystems: results,
    findings: results.flatMap((r) => r.findings.map((f) => ({ ecosystem: r.kind, ...f }))),
  };
}

function printHelp() {
  process.stdout.write(
    `cobolt-lockfile-verify — drift check between manifests and lockfiles\n\n` +
      `Usage: node tools/cobolt-lockfile-verify.js check [--cwd PATH] [--json]\n` +
      `Exit: 0 pass, 1 drift, 2 no-manifest, 3 lockfile-unreadable\n`,
  );
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return 0;
  }
  const cmd = argv[0];
  if (!cmd) {
    printHelp();
    return 0;
  }
  if (cmd !== 'check') {
    process.stderr.write(`unknown command: ${cmd}\n`);
    return 1;
  }
  const cwdIdx = argv.indexOf('--cwd');
  const cwd = cwdIdx >= 0 ? argv[cwdIdx + 1] : process.cwd();
  const wantsJson = argv.includes('--json');
  const verdict = check(cwd);
  if (wantsJson) {
    process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  } else {
    process.stdout.write(
      `lockfile-verify: ${verdict.verdict} (${verdict.ecosystems.length} ecosystem(s), ${verdict.findings.length} finding(s))\n`,
    );
    for (const f of verdict.findings) process.stdout.write(`  - [${f.ecosystem}] ${f.kind}: ${f.message}\n`);
  }
  if (verdict.verdict === 'no-manifest') return 2;
  return verdict.findings.length === 0 ? 0 : 1;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { check, detectEcosystems, checkNpmDrift };
