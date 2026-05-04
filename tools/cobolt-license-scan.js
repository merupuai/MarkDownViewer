#!/usr/bin/env node

// cobolt-license-scan — PR-2 of build-pipeline redesign (v0.53.0).
//
// Scans every dependency declared in package.json (and node_modules when
// present) against a license-policy.schema.json document and emits a verdict.
// Composed by cobolt-supply-chain-build-gate at preflight.
//
// Policy matching:
//   - allow[]   → finding: none
//   - deny[]    → finding: severity=error (blocks at Tier 1)
//   - reviewRequired[] → finding: severity=warn (blocks at Tier 2 unless waived)
//   - familyAliases   → expand a family token into the listed SPDX IDs
//   - packageWaivers[] → exempt a specific (package, spdx) pair if reason+approver present
//
// Usage:
//   node tools/cobolt-license-scan.js check [--policy PATH] [--cwd PATH] [--json]
//   node tools/cobolt-license-scan.js --help
//
// Exit codes: 0 pass, 1 deny/review without waiver, 2 missing policy file,
// 3 cannot read package.json.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_POLICY = {
  version: '1.0.0',
  allow: ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'Unlicense', 'CC0-1.0', '0BSD'],
  deny: ['SSPL-1.0'],
  reviewRequired: ['AGPL-3.0-only', 'AGPL-3.0-or-later', 'LGPL-2.1-only', 'LGPL-3.0-only', 'GPL-3.0-only'],
  familyAliases: {},
  packageWaivers: [],
};

function loadPolicy(policyPath) {
  if (!policyPath) return { policy: DEFAULT_POLICY, source: '<default>' };
  if (!fs.existsSync(policyPath)) {
    return { policy: null, error: `policy file not found: ${policyPath}` };
  }
  try {
    return { policy: JSON.parse(fs.readFileSync(policyPath, 'utf8')), source: policyPath };
  } catch (err) {
    return { policy: null, error: `policy parse error: ${err.message}` };
  }
}

function expandFamily(spdx, aliases) {
  if (!aliases) return [spdx];
  const lower = spdx.toLowerCase();
  if (aliases[lower]) return aliases[lower];
  if (aliases[spdx]) return aliases[spdx];
  return [spdx];
}

function classify(spdx, policy) {
  if (!spdx) return 'unknown';
  const candidates = expandFamily(spdx, policy.familyAliases);
  if (candidates.some((c) => (policy.deny || []).includes(c))) return 'deny';
  if (candidates.some((c) => (policy.reviewRequired || []).includes(c))) return 'review';
  if (candidates.some((c) => (policy.allow || []).includes(c))) return 'allow';
  return 'unknown';
}

function findWaiver(pkg, spdx, policy) {
  for (const w of policy.packageWaivers || []) {
    const [name] = pkg.split('@');
    const [wname, wver] = w.package.split('@');
    if (wname !== name) continue;
    if (wver && wver !== pkg.split('@')[1]) continue;
    if (w.spdx === spdx) return w;
  }
  return null;
}

function readPackageJson(cwd) {
  const p = path.join(cwd, 'package.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readNodeModulesLicenses(cwd) {
  // Best-effort scan: read each node_modules/<name>/package.json's license field.
  const nm = path.join(cwd, 'node_modules');
  if (!fs.existsSync(nm)) return [];
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(nm);
  } catch {
    return [];
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const pkgJson = path.join(nm, name, 'package.json');
    if (name.startsWith('@')) {
      // scoped package — recurse one level
      let scoped;
      try {
        scoped = fs.readdirSync(path.join(nm, name));
      } catch {
        continue;
      }
      for (const sub of scoped) {
        const subPj = path.join(nm, name, sub, 'package.json');
        if (fs.existsSync(subPj)) {
          try {
            const j = JSON.parse(fs.readFileSync(subPj, 'utf8'));
            out.push({ name: `${name}/${sub}`, version: j.version, license: extractSpdx(j) });
          } catch {
            /* ignore */
          }
        }
      }
      continue;
    }
    if (fs.existsSync(pkgJson)) {
      try {
        const j = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
        out.push({ name, version: j.version, license: extractSpdx(j) });
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

function extractSpdx(pj) {
  if (typeof pj.license === 'string') return pj.license;
  if (pj.license && typeof pj.license.type === 'string') return pj.license.type;
  if (Array.isArray(pj.licenses) && pj.licenses[0]?.type) return pj.licenses[0].type;
  return null;
}

function scan({ cwd, policyPath } = {}) {
  cwd = cwd || process.cwd();
  const { policy, source: policySource, error: policyError } = loadPolicy(policyPath);
  if (!policy) {
    return {
      schema: 'cobolt-license-scan@1',
      verdict: 'policy-missing',
      error: policyError,
      findings: [],
    };
  }
  const pj = readPackageJson(cwd);
  if (!pj) {
    return {
      schema: 'cobolt-license-scan@1',
      verdict: 'no-manifest',
      error: 'package.json not found',
      findings: [],
    };
  }
  const installed = readNodeModulesLicenses(cwd);
  const findings = [];
  for (const dep of installed) {
    const verdict = classify(dep.license, policy);
    if (verdict === 'allow') continue;
    if (verdict === 'unknown') {
      findings.push({
        kind: 'unknown-license',
        severity: 'warn',
        package: `${dep.name}@${dep.version}`,
        spdx: dep.license || '<unknown>',
        message: `cannot classify license '${dep.license}' against policy`,
      });
      continue;
    }
    const waiver = findWaiver(`${dep.name}@${dep.version}`, dep.license, policy);
    if (waiver) {
      findings.push({
        kind: 'waived',
        severity: 'info',
        package: `${dep.name}@${dep.version}`,
        spdx: dep.license,
        verdict,
        waiver: { reason: waiver.reason, approver: waiver.approver },
      });
      continue;
    }
    findings.push({
      kind: verdict === 'deny' ? 'license-denied' : 'license-review-required',
      severity: verdict === 'deny' ? 'error' : 'warn',
      package: `${dep.name}@${dep.version}`,
      spdx: dep.license,
      verdict,
      message: `${dep.name}@${dep.version} carries '${dep.license}' which is ${verdict === 'deny' ? 'denied' : 'review-required'} by ${policySource}`,
    });
  }
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warns = findings.filter((f) => f.severity === 'warn').length;
  return {
    schema: 'cobolt-license-scan@1',
    cwd,
    policySource,
    generatedAt: new Date().toISOString(),
    verdict: errors === 0 ? (warns === 0 ? 'pass' : 'review') : 'fail',
    counts: {
      packagesScanned: installed.length,
      errors,
      warnings: warns,
      waived: findings.filter((f) => f.kind === 'waived').length,
    },
    findings,
  };
}

function printHelp() {
  process.stdout.write(
    `cobolt-license-scan — SPDX policy enforcement\n\n` +
      `Usage: node tools/cobolt-license-scan.js check [--policy PATH] [--cwd PATH] [--json]\n` +
      `Exit: 0 pass, 1 deny/unwaived-review, 2 policy missing, 3 no manifest\n`,
  );
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return 0;
  }
  if (!argv[0]) {
    printHelp();
    return 0;
  }
  if (argv[0] !== 'check') {
    process.stderr.write(`unknown command: ${argv[0]}\n`);
    return 1;
  }
  const cwdIdx = argv.indexOf('--cwd');
  const policyIdx = argv.indexOf('--policy');
  const cwd = cwdIdx >= 0 ? argv[cwdIdx + 1] : process.cwd();
  const policyPath = policyIdx >= 0 ? argv[policyIdx + 1] : null;
  const wantsJson = argv.includes('--json');
  const verdict = scan({ cwd, policyPath });
  if (wantsJson) {
    process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  } else {
    process.stdout.write(
      `license-scan: ${verdict.verdict} (${verdict.counts?.packagesScanned ?? 0} packages, ${verdict.counts?.errors ?? 0} errors, ${verdict.counts?.warnings ?? 0} warns)\n`,
    );
    for (const f of verdict.findings.filter((x) => x.severity !== 'info')) {
      process.stdout.write(`  - [${f.severity}] ${f.kind}: ${f.message || `${f.package} ${f.spdx}`}\n`);
    }
  }
  if (verdict.verdict === 'policy-missing') return 2;
  if (verdict.verdict === 'no-manifest') return 3;
  return verdict.verdict === 'fail' ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { scan, classify, expandFamily, DEFAULT_POLICY };
