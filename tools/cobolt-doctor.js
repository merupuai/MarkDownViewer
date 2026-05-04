#!/usr/bin/env node

// CoBolt Doctor - source/install/generator drift and tool readiness checks.

const fs = require('node:fs');
const path = require('node:path');
const { TOOLS } = require('./index');

const REQUIRED_DIRS = ['source/agents', 'source/skills', 'source/hooks', 'source/schemas', 'tools'];
const REQUIRED_TOOLS = [
  'postmortem-ingest',
  'replay-harness',
  'context-budget',
  'artifact-provenance',
  'branch-topology',
  'framework-contracts',
  'ui-pr-evidence',
  'auth-contract',
  'milestone-cost-report',
  'auto-state',
  'doctor',
  'gate-coverage',
  'stop-line',
];

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// Phase 3.9 (v0.63+) — local-CI parity probe.
//
// Surfaces environment differences that produce surprising "works on my
// machine, fails in CI" outcomes. Every signal is informational; nothing
// here is blocking. The output is consumed by humans investigating
// reproducibility issues and by the gate-slo / DORA reports as one of
// several inputs into the "is this project healthy" judgment.
//
// Standards mapping:
//   ISO/IEC 27001 A.8.16 — monitoring activities.
//   NIST SSDF PO.5.2     — implement and maintain controls to monitor
//                          security of secure development environments.
function checkLocalCiParity() {
  const probes = [];

  // 1. Line endings — CRLF on a Unix-targeting project produces silent
  //    test diffs and breaks shebangs. Probe by checking how the local FS
  //    is configured for new files.
  let lineEndings = '\n';
  try {
    const sample = fs.readFileSync(__filename, 'utf8');
    if (sample.includes('\r\n')) lineEndings = '\\r\\n (CRLF)';
  } catch {
    /* skip */
  }
  probes.push({
    id: 'line-endings',
    value: lineEndings,
    expected: '\\n (LF)',
    passed: lineEndings === '\n',
  });

  // 2. Filesystem case sensitivity — macOS APFS is case-INSENSITIVE by
  //    default, Linux ext4/xfs is case-SENSITIVE. Importing 'Foo' instead
  //    of 'foo' silently passes on macOS, fails in CI.
  let caseSensitive = null;
  try {
    const tmp = path.join(process.cwd(), `.cobolt-doctor-case-${process.pid}.tmp`);
    fs.writeFileSync(tmp, 'x');
    caseSensitive = !fs.existsSync(tmp.toUpperCase().replace(/\.tmp$/i, '.tmp'));
    // Clean up either way.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  } catch {
    caseSensitive = null;
  }
  probes.push({
    id: 'fs-case-sensitive',
    value: caseSensitive,
    expected: true,
    passed: caseSensitive === true,
  });

  // 3. Locale + timezone — sort orders, date parsing, number formatting
  //    all depend on these and they're a top cause of CI flakes when the
  //    dev's locale differs from the CI runner's.
  const lang = process.env.LANG || process.env.LC_ALL || null;
  const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  probes.push({
    id: 'locale',
    value: lang,
    expected: 'en_US.UTF-8 or C.UTF-8',
    passed: lang === 'C.UTF-8' || /UTF-8/.test(lang || ''),
  });
  probes.push({ id: 'timezone', value: tz, expected: 'UTC', passed: tz === 'UTC' });

  // 4. Node + npm versions — major-version drift between dev and CI is
  //    the single most common reproducibility break.
  probes.push({
    id: 'node-version',
    value: process.versions.node,
    expected: '>=20.0.0',
    passed: Number.parseInt(process.versions.node.split('.')[0], 10) >= 20,
  });

  // 5. Platform/arch — surfaces but doesn't fail; just reports the matrix.
  probes.push({
    id: 'platform-arch',
    value: `${process.platform}-${process.arch}`,
    expected: 'matches CI matrix',
    passed: true,
  });

  return {
    probes,
    summary: {
      total: probes.length,
      passed: probes.filter((p) => p.passed).length,
      failed: probes.filter((p) => !p.passed).length,
    },
  };
}

function checkDoctor(projectRoot = process.cwd()) {
  const issues = [];
  const warnings = [];

  for (const dir of REQUIRED_DIRS) {
    if (!fs.existsSync(path.join(projectRoot, dir))) issues.push(`Missing required directory: ${dir}`);
  }

  for (const tool of REQUIRED_TOOLS) {
    if (!TOOLS[tool]) issues.push(`Tool registry is missing ${tool}.`);
    const file = TOOLS[tool]?.file ? path.join(projectRoot, 'tools', TOOLS[tool].file.replace(/^\.\//, '')) : null;
    if (file && !fs.existsSync(file)) issues.push(`Registered tool file is missing: ${file}`);
  }

  const pkg = readJson(path.join(projectRoot, 'package.json'));
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (major < 18) issues.push(`Node.js ${process.versions.node} is below the supported minimum 18.x.`);
  if (!pkg?.scripts?.test) warnings.push('package.json has no test script.');

  const schemaDir = path.join(projectRoot, 'source', 'schemas');
  if (fs.existsSync(schemaDir)) {
    for (const entry of fs.readdirSync(schemaDir)) {
      if (!entry.endsWith('.json')) continue;
      if (!readJson(path.join(schemaDir, entry))) issues.push(`Schema is not valid JSON: source/schemas/${entry}`);
    }
  }

  const sourceHooks = path.join(projectRoot, 'source', 'hooks');
  const distHooks = path.join(projectRoot, 'dist', 'hooks');
  if (fs.existsSync(sourceHooks) && fs.existsSync(distHooks)) {
    const sourceCount = fs.readdirSync(sourceHooks).filter((entry) => entry.endsWith('.js')).length;
    const distCount = fs.readdirSync(distHooks).filter((entry) => entry.endsWith('.js')).length;
    if (distCount < sourceCount)
      warnings.push(`dist/hooks has ${distCount} JS hooks, source/hooks has ${sourceCount}. Run npm run build:hooks.`);
  }

  // Phase 3.9 — local-CI parity. Failed probes become warnings, not issues
  // (parity checks should never block a build).
  const parity = checkLocalCiParity();
  for (const probe of parity.probes) {
    if (!probe.passed) {
      warnings.push(`local-CI parity (${probe.id}): got "${probe.value}", expected "${probe.expected}"`);
    }
  }

  // Persist parity report so other tools (gate-slo, dora, milestone close)
  // can correlate parity drift with build failures.
  try {
    const auditDir = path.join(projectRoot, '_cobolt-output', 'audit');
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(auditDir, 'doctor-parity.json'),
      `${JSON.stringify({ ts: new Date().toISOString(), ...parity }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch {
    /* best-effort */
  }

  return {
    passed: issues.length === 0,
    issues,
    warnings,
    summary: {
      registeredTools: Object.keys(TOOLS).length,
      issues: issues.length,
      warnings: warnings.length,
      node: process.versions.node,
      parity: parity.summary,
    },
    parity,
  };
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'check';
  const json = argv.includes('--json');
  if (command !== 'check') {
    console.error('Usage: node tools/cobolt-doctor.js check [--json]');
    process.exit(2);
  }
  const report = checkDoctor(process.cwd());
  if (json) console.log(JSON.stringify(report, null, 2));
  else if (report.passed) console.log('[cobolt-doctor] CoBolt source health checks passed.');
  else for (const issue of report.issues) console.error(`[cobolt-doctor] ${issue}`);
  process.exit(report.passed ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  REQUIRED_TOOLS,
  checkDoctor,
  checkLocalCiParity,
};
