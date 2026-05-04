#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { atomicWriteJSON } = require('../lib/cobolt-atomic-write');
const telemetry = require('../lib/cobolt-telemetry');

const EN_CHECKS = Object.freeze([
  {
    id: 'EN-01',
    label: 'RBAC inside the pipeline',
    files: ['source/schemas/rbac-policy.schema.json', 'source/hooks/cobolt-rbac-gate.js', 'tools/cobolt-rbac.js'],
  },
  {
    id: 'EN-02',
    label: 'Multi-tenant state isolation',
    files: ['source/schemas/tenant-profile.schema.json', 'tools/cobolt-tenant.js', 'lib/cobolt-paths.js'],
  },
  {
    id: 'EN-03',
    label: 'Air-gapped install path',
    files: ['docs/AIR-GAPPED-INSTALL.md', 'tools/cobolt-airgap.js', 'tools/cobolt-verify-install.js'],
  },
  {
    id: 'EN-04',
    label: 'Telemetry opt-out certification',
    files: ['docs/TELEMETRY.md', 'tools/cobolt-telemetry.js', 'lib/cobolt-telemetry.js'],
  },
  { id: 'EN-05', label: 'SLA/support model', files: ['docs/SUPPORT.md'] },
  {
    id: 'EN-06',
    label: 'Compliance evidence pack generator',
    files: ['tools/cobolt-evidence-pack.js', 'source/schemas/evidence-pack-manifest.schema.json'],
  },
  {
    id: 'EN-07',
    label: 'Disaster recovery for state corruption',
    files: ['tools/cobolt-state.js', 'source/hooks/cobolt-state-recovery-session.js'],
  },
  {
    id: 'EN-08',
    label: 'Reproducible pipeline runs',
    files: ['tools/cobolt-run-manifest.js', 'source/schemas/run-manifest.schema.json'],
  },
  {
    id: 'EN-09',
    label: 'Plugin/extension SDK',
    files: ['tools/cobolt-extension.js', 'source/schemas/cobolt-extension.schema.json'],
  },
  { id: 'EN-10', label: 'License/governance/source escrow', files: ['docs/GOVERNANCE.md'] },
  {
    id: 'EN-11',
    label: 'Native workflow integrations',
    files: ['tools/cobolt-workflow-integration.js', 'source/schemas/workflow-integration.schema.json'],
  },
]);

function argValue(args, name, fallback = null) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] || fallback : fallback;
}

function checkEnterpriseReadiness(root = process.cwd()) {
  const checks = EN_CHECKS.map((check) => {
    const missing = check.files.filter((rel) => !fs.existsSync(path.join(root, rel)));
    return {
      id: check.id,
      label: check.label,
      status: missing.length === 0 ? 'PASS' : 'FAIL',
      missing,
      files: check.files,
    };
  });
  const telemetryCert = telemetry.certifyNoNetwork(root, { env: {}, ignoreLocalConfig: true });
  if (!telemetryCert.ok) {
    const item = checks.find((check) => check.id === 'EN-04');
    item.status = 'FAIL';
    item.telemetryFindings = telemetryCert.findings;
  }
  const failed = checks.filter((check) => check.status === 'FAIL');
  return {
    schema: 'cobolt-enterprise-readiness@1',
    generatedAt: new Date().toISOString(),
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    summary: {
      total: checks.length,
      passed: checks.length - failed.length,
      failed: failed.length,
    },
    checks,
  };
}

function renderMarkdown(result) {
  const lines = [
    '# Enterprise Readiness',
    '',
    `Verdict: ${result.verdict}`,
    `Generated: ${result.generatedAt}`,
    '',
    '| ID | Check | Status | Missing |',
    '| --- | --- | --- | --- |',
  ];
  for (const check of result.checks) {
    lines.push(`| ${check.id} | ${check.label} | ${check.status} | ${check.missing.join('<br>')} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function writeReports(root, result) {
  const dir = path.join(root, '_cobolt-output', 'reports', 'enterprise-readiness');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const jsonPath = path.join(dir, 'latest.json');
  const mdPath = path.join(dir, 'latest.md');
  atomicWriteJSON(jsonPath, result, { mode: 0o600 });
  fs.writeFileSync(mdPath, renderMarkdown(result), 'utf8');
  return { jsonPath, mdPath };
}

function cmdCheck(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const result = checkEnterpriseReadiness(root);
  const reports = args.includes('--no-write') ? null : writeReports(root, result);
  console.log(JSON.stringify({ ...result, reports }, null, 2));
  return result.verdict === 'PASS' ? 0 : 1;
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0] || 'check';
  const args = argv.slice(1);
  if (cmd === 'check' || cmd === 'report') return cmdCheck(args);
  console.log('Usage: node tools/cobolt-enterprise-readiness.js check [--root DIR]');
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { EN_CHECKS, checkEnterpriseReadiness, main };
