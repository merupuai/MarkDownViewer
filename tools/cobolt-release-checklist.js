#!/usr/bin/env node

// CoBolt Release Checklist — Deterministic checklist from gate config
//
// Generates release-readiness-checklist.md from existing gate definitions
// and artifact-dependencies.json. No LLM needed.
//
// Usage:
//   node tools/cobolt-release-checklist.js generate                    # Generate checklist
//   node tools/cobolt-release-checklist.js generate --milestone M1     # For specific milestone
//   node tools/cobolt-release-checklist.js check                       # Verify checklist items
//   node tools/cobolt-release-checklist.js check --json                # Machine-readable
//
// Exit codes:
//   0 = all checks pass
//   1 = some checks fail
//   2 = usage error

const fs = require('node:fs');
const path = require('node:path');
const { getLatestRoot, getPlanningDir } = require('../lib/cobolt-planning-artifacts');
const { readJsonVerified } = require('../lib/cobolt-state-integrity');
const { evaluateComplianceControlCoverage } = require('./cobolt-compliance-gate');
const { evaluateStandardsGate } = require('./cobolt-standards-gate');

// ── Path Resolution ─────────────────────────────────────────

function planningDir() {
  return getPlanningDir(process.cwd(), { create: true });
}

function projectRoot() {
  return process.cwd();
}

function latestRoot() {
  return getLatestRoot(process.cwd());
}

// ── Checklist Definition ────────────────────────────────────

const CHECKLIST_CATEGORIES = [
  {
    name: 'Code Quality',
    items: [
      {
        id: 'CQ-1',
        check: 'All lint checks pass',
        verify: 'node tools/cobolt-gate.js lint',
        evidence: 'gate-results.json',
      },
      {
        id: 'CQ-2',
        check: 'Type checking passes',
        verify: 'node tools/cobolt-gate.js typecheck',
        evidence: 'gate-results.json',
      },
      {
        id: 'CQ-3',
        check: 'Code formatting consistent',
        verify: 'node tools/cobolt-gate.js format',
        evidence: 'gate-results.json',
      },
      {
        id: 'CQ-4',
        check: 'No dead code or TODOs in critical paths',
        verify: 'grep -r "TODO\\|FIXME\\|HACK" src/ --count',
        evidence: 'manual',
      },
    ],
  },
  {
    name: 'Testing',
    items: [
      { id: 'TS-1', check: 'All unit tests pass', verify: 'node tools/cobolt-test.js', evidence: 'test-results.json' },
      {
        id: 'TS-2',
        check: 'Integration tests pass',
        verify: 'node tools/cobolt-test.js --type integration',
        evidence: 'test-results.json',
      },
      {
        id: 'TS-3',
        check: 'E2E tests pass (if UI)',
        verify: 'node tools/cobolt-playwright.js test',
        evidence: 'playwright-report/',
      },
      {
        id: 'TS-4',
        check: 'Coverage meets threshold',
        verify: 'node tools/cobolt-gate.js test',
        evidence: 'coverage-report/',
      },
      {
        id: 'TS-5',
        check: 'Flake hunter report is clean',
        verify: 'node tools/cobolt-flake-hunter.js check --save',
        evidence: 'flake-hunter-report.json',
      },
    ],
  },
  {
    name: 'Security',
    items: [
      {
        id: 'SC-1',
        check: 'SAST scan clean (no critical/high)',
        verify: 'node tools/cobolt-scan.js',
        evidence: 'scan-results.json',
      },
      {
        id: 'SC-2',
        check: 'Dependency audit clean',
        verify: 'node tools/cobolt-gate.js deps',
        evidence: 'audit-results.json',
      },
      {
        id: 'SC-3',
        check: 'No secrets in codebase',
        verify: 'node tools/cobolt-scan.js --category secrets',
        evidence: 'secrets-scan.json',
      },
      {
        id: 'SC-4',
        check: 'PR threat scan passed',
        verify: 'node tools/cobolt-pr-threat-scan.js',
        evidence: 'threat-scan.json',
      },
    ],
  },
  {
    name: 'Compliance',
    items: [
      {
        id: 'CM-1',
        check: 'PRD compliance audit passed',
        verify: 'node tools/cobolt-audit.js',
        evidence: 'audit-report.json',
      },
      {
        id: 'CM-2',
        check: 'RTM coverage >= 85%',
        verify: 'node tools/cobolt-rtm.js check --threshold 85',
        evidence: 'rtm.json',
      },
      {
        id: 'CM-3',
        check: 'All planning artifacts present',
        verify: 'node tools/cobolt-preflight.js check cobolt-deploy',
        evidence: 'preflight-report.json',
      },
      { id: 'CM-4', check: 'SBOM generated', verify: 'node tools/cobolt-sbom.js', evidence: 'sbom.json' },
      {
        id: 'CM-5',
        check: 'Accuracy evaluator score >= 85%',
        verify: 'node tools/cobolt-accuracy-evaluator.js check --save',
        evidence: 'accuracy-evaluation.json',
      },
      {
        id: 'CM-6',
        check: 'Named compliance framework controls passed when in scope',
        verify: 'node tools/cobolt-compliance-gate.js release',
        evidence: 'docs/security/ + docs/runbooks/',
      },
      {
        id: 'CM-7',
        check: 'Secure coding and engineering standards are complete',
        verify: 'node tools/cobolt-standards-gate.js release',
        evidence: 'secure-coding-standard.md + engineering-quality-standards.md',
      },
      {
        id: 'CM-8',
        check: 'Audit event stream reviewed for skips, warnings, and approvals',
        verify: 'manual review of _cobolt-output/audit/',
        evidence: '_cobolt-output/audit/',
      },
    ],
  },
  {
    name: 'Performance',
    items: [
      {
        id: 'PF-1',
        check: 'API response time < SLA',
        verify: 'manual or cobolt-test-suite performance',
        evidence: 'perf-results.json',
      },
      { id: 'PF-2', check: 'Bundle size within budget (if frontend)', verify: 'manual', evidence: 'bundle-analysis/' },
      { id: 'PF-3', check: 'No N+1 query patterns', verify: 'manual review', evidence: 'review-findings.json' },
      {
        id: 'PF-4',
        check: 'Runtime profiler correlation report generated',
        verify: 'node tools/cobolt-runtime-profiler.js correlate --save',
        evidence: 'runtime-profiler.json',
      },
    ],
  },
  {
    name: 'Documentation',
    items: [
      { id: 'DC-1', check: 'API documentation up-to-date', verify: 'manual', evidence: 'api-docs/' },
      { id: 'DC-2', check: 'README reflects current state', verify: 'manual', evidence: 'README.md' },
      { id: 'DC-3', check: 'Changelog updated', verify: 'manual', evidence: 'CHANGELOG.md' },
    ],
  },
  {
    name: 'Infrastructure',
    items: [
      {
        id: 'IF-1',
        check: 'Docker build succeeds',
        verify: 'node tools/cobolt-docker.js build',
        evidence: 'docker-build.log',
      },
      {
        id: 'IF-2',
        check: 'Health endpoint responds',
        verify: 'curl -f http://localhost:PORT/health',
        evidence: 'health-check.log',
      },
      {
        id: 'IF-3',
        check: 'Environment variables documented',
        verify: 'node tools/cobolt-env.js validate',
        evidence: '.env.cobolt',
      },
      { id: 'IF-4', check: 'Rollback procedure tested', verify: 'manual', evidence: 'rollback-test.log' },
      {
        id: 'IF-5',
        check: 'Reliability guard passed',
        verify: 'node tools/cobolt-reliability-guard.js check --save',
        evidence: 'reliability-guard.json',
      },
      {
        id: 'IF-6',
        check: 'Config drift check passed',
        verify: 'node tools/cobolt-config-drift.js check --save',
        evidence: 'config-drift.json',
      },
    ],
  },
];

// ── Generator ───────────────────────────────────────────────

function generateChecklist(milestone) {
  const lines = [];
  const now = new Date().toISOString();

  lines.push('# Release Readiness Checklist');
  lines.push('');
  lines.push(`> Auto-generated by \`node tools/cobolt-release-checklist.js\` — ${now}`);
  if (milestone) lines.push(`> Milestone: ${milestone}`);
  lines.push('');
  lines.push('## Instructions');
  lines.push('');
  lines.push('Each item must be verified before release. Run the verify command and confirm the evidence exists.');
  lines.push('Mark items with `[x]` when verified, `[ ]` when pending, `[~]` when N/A.');
  lines.push('');

  // Load quality gates if available
  const gatesPath = path.join(planningDir(), 'deterministic-quality-gates.json');
  if (fs.existsSync(gatesPath)) {
    try {
      JSON.parse(fs.readFileSync(gatesPath, 'utf8'));
      lines.push('> Quality gate thresholds loaded from `deterministic-quality-gates.json`');
      lines.push('');
    } catch (_e) {
      /* use defaults */
    }
  }

  for (const category of CHECKLIST_CATEGORIES) {
    lines.push(`## ${category.name}`);
    lines.push('');
    lines.push('| Status | ID | Check | Verify Command | Evidence |');
    lines.push('|--------|----|-------|----------------|----------|');
    for (const item of category.items) {
      lines.push(`| [ ] | ${item.id} | ${item.check} | \`${item.verify}\` | ${item.evidence} |`);
    }
    lines.push('');
  }

  // Rollback section
  lines.push('## Audit Trail Evidence');
  lines.push('');
  lines.push(
    'Release authorization must surface `_cobolt-output/audit/` so silent skips, warnings, retries, and approvals are visible at go/no-go time.',
  );
  lines.push('');
  lines.push('- [ ] `_cobolt-output/audit/gate-skip-log.jsonl` reviewed or explicitly N/A');
  lines.push('- [ ] `_cobolt-output/audit/planning-integrity.jsonl` reviewed or latest plan-output audit attached');
  lines.push('- [ ] `_cobolt-output/audit/attestations/` reviewed for approval and validation evidence');
  lines.push('');

  // Rollback section
  lines.push('## Rollback Procedure');
  lines.push('');
  lines.push('| Step | Action | Command |');
  lines.push('|------|--------|---------|');
  lines.push('| 1 | Stop new traffic | Load balancer drain / feature flag off |');
  lines.push('| 2 | Rollback deployment | `git revert` or container image tag rollback |');
  lines.push('| 3 | Verify rollback | Health check + smoke test on previous version |');
  lines.push('| 4 | Investigate | Check logs, fix forward or hotfix |');
  lines.push('');

  // Sign-off section
  lines.push('## Sign-off');
  lines.push('');
  lines.push('| Role | Name | Date | Approved |');
  lines.push('|------|------|------|----------|');
  lines.push('| Dev Lead | | | [ ] |');
  lines.push('| QA | | | [ ] |');
  lines.push('| Security | | | [ ] |');
  lines.push('');

  return lines.join('\n');
}

// ── Checker ─────────────────────────────────────────────────

function checkItems() {
  const pd = planningDir();
  const root = projectRoot();
  const latest = latestRoot();
  const results = [];

  // Check which items can be verified automatically
  const autoChecks = [
    {
      id: 'CM-2',
      name: 'RTM coverage',
      check: () => {
        const rtmPath = path.join(pd, 'rtm.json');
        if (!fs.existsSync(rtmPath)) return { pass: false, detail: 'rtm.json not found' };
        const { data: rtm, integrity } = readJsonVerified(rtmPath);
        if (!rtm) return { pass: false, detail: 'rtm.json could not be read' };
        if (!integrity.valid && integrity.reason?.includes('mismatch'))
          return { pass: false, detail: `rtm.json integrity check failed: ${integrity.reason}` };
        const cov = rtm.metadata?.coverageSummary?.percentage || 0;
        return { pass: cov >= 85, detail: `Coverage: ${cov}% (threshold: 85%)` };
      },
    },
    {
      id: 'CM-3',
      name: 'Planning artifacts',
      check: () => {
        const critical = ['prd.md', 'architecture.md', 'epics.md', 'milestones.md', 'rtm.json'];
        const missing = critical.filter((f) => !fs.existsSync(path.join(pd, f)));
        return {
          pass: missing.length === 0,
          detail: missing.length > 0 ? `Missing: ${missing.join(', ')}` : 'All present',
        };
      },
    },
    {
      id: 'CM-4',
      name: 'SBOM exists',
      check: () => {
        const sbomCandidates = ['sbom.json', 'bom.json', 'bom.xml'];
        const found = sbomCandidates.find(
          (f) => fs.existsSync(path.join(root, f)) || fs.existsSync(path.join(pd, '..', f)),
        );
        return { pass: !!found, detail: found ? `Found: ${found}` : 'No SBOM file found' };
      },
    },
    {
      id: 'IF-3',
      name: 'Env config',
      check: () => {
        const envPath = path.join(root, '.env.cobolt');
        return {
          pass: fs.existsSync(envPath),
          detail: fs.existsSync(envPath) ? '.env.cobolt present' : '.env.cobolt not found',
        };
      },
    },
    {
      id: 'TS-5',
      name: 'Flake hunter report',
      check: () => {
        const reportPath = path.join(latest, 'build', 'flake-hunter-report.json');
        const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
        if (!report) return { pass: false, detail: 'flake-hunter-report.json not found' };
        return {
          pass: report.summary?.verdict !== 'FAIL',
          detail: `Verdict: ${report.summary?.verdict || 'unknown'} (${report.summary?.score || 0}%)`,
        };
      },
    },
    {
      id: 'CM-5',
      name: 'Accuracy evaluator',
      check: () => {
        const reportPath = path.join(latest, 'audit', 'accuracy-evaluation.json');
        const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
        if (!report) return { pass: false, detail: 'accuracy-evaluation.json not found' };
        return {
          pass: (report.summary?.score || 0) >= 85,
          detail: `Score: ${report.summary?.score || 0}%`,
        };
      },
    },
    {
      id: 'CM-6',
      name: 'Compliance framework control coverage',
      check: () => {
        const report = evaluateComplianceControlCoverage(root, { mode: 'release' });
        if (report.status === 'not_applicable') {
          return { pass: true, detail: 'No named compliance framework active in planning artifacts' };
        }
        const missing = report.missingControls.map((control) => control.id);
        return {
          pass: report.passed,
          detail: report.passed
            ? `Covered ${report.summary.covered}/${report.summary.totalControls} compliance controls`
            : `Missing: ${missing.join(', ')}`,
        };
      },
    },
    {
      id: 'CM-7',
      name: 'Governance standards coverage',
      check: () => {
        const report = evaluateStandardsGate(root, { mode: 'release' });
        return {
          pass: report.passed,
          detail: report.passed
            ? `Passed ${report.summary.passedArtifacts}/${report.summary.totalArtifacts} standards artifacts`
            : `Missing/incomplete: ${report.missingArtifacts.join(', ')}`,
        };
      },
    },
    {
      id: 'PF-4',
      name: 'Runtime profiler',
      check: () => {
        const reportPath = path.join(latest, 'perf', 'runtime-profiler.json');
        const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
        if (!report) return { pass: false, detail: 'runtime-profiler.json not found' };
        const sourceCount = Object.values(report.summary?.sources || {}).reduce(
          (sum, value) => sum + (typeof value === 'number' ? value : value ? 1 : 0),
          0,
        );
        return {
          pass: sourceCount > 0,
          detail: `Signals available: ${sourceCount}`,
        };
      },
    },
    {
      id: 'IF-5',
      name: 'Reliability guard',
      check: () => {
        const reportPath = path.join(latest, 'deploy', 'reliability-guard.json');
        const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
        if (!report) return { pass: false, detail: 'reliability-guard.json not found' };
        return {
          pass: !!report.summary?.pass,
          detail: `Score: ${report.summary?.score || 0}%`,
        };
      },
    },
    {
      id: 'IF-6',
      name: 'Config drift',
      check: () => {
        const reportPath = path.join(root, '_cobolt-output', 'audit', 'config-drift.json');
        const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
        if (!report) return { pass: false, detail: 'config-drift.json not found' };
        return {
          pass: !!report.summary?.pass,
          detail: `Score: ${report.summary?.score || 0}%`,
        };
      },
    },
    {
      id: 'DC-3',
      name: 'Changelog',
      check: () => {
        const changelog = path.join(root, 'CHANGELOG.md');
        return {
          pass: fs.existsSync(changelog),
          detail: fs.existsSync(changelog) ? 'CHANGELOG.md present' : 'Not found',
        };
      },
    },
  ];

  for (const ac of autoChecks) {
    const result = ac.check();
    results.push({ id: ac.id, name: ac.name, ...result });
  }

  return results;
}

// ── CLI ─────────────────────────────────────────────────────

function cmdGenerate(args) {
  const msIdx = args.indexOf('--milestone');
  const milestone = msIdx !== -1 && args[msIdx + 1] ? args[msIdx + 1] : null;

  const checklist = generateChecklist(milestone);
  const outPath = path.join(planningDir(), 'release-readiness-checklist.md');
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outPath, checklist, 'utf8');

  const totalItems = CHECKLIST_CATEGORIES.reduce((sum, c) => sum + c.items.length, 0);
  console.log(`[cobolt-release-checklist] Generated release-readiness-checklist.md`);
  console.log(`  Categories: ${CHECKLIST_CATEGORIES.length}`);
  console.log(`  Items: ${totalItems}`);
  console.log(`  Output: ${outPath}`);
}

function cmdCheck(args) {
  const jsonMode = args.includes('--json');
  const results = checkItems();
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;

  if (jsonMode) {
    console.log(JSON.stringify({ results, passed, total, allPassed: passed === total }, null, 2));
  } else {
    console.log('[cobolt-release-checklist] Auto-verifiable checks:');
    for (const r of results) {
      const icon = r.pass ? 'PASS' : 'FAIL';
      console.log(`  [${icon}] ${r.id} ${r.name}: ${r.detail}`);
    }
    console.log(`\n  ${passed}/${total} auto-checks passed`);
  }

  process.exit(passed === total ? 0 : 1);
}

const [, , command, ...args] = process.argv;

switch (command) {
  case 'generate':
    cmdGenerate(args);
    break;
  case 'check':
    cmdCheck(args);
    break;
  default: {
    console.log('CoBolt Release Checklist — Deterministic checklist generator');
    console.log('');
    console.log('Usage:');
    console.log('  node tools/cobolt-release-checklist.js generate [--milestone M1]');
    console.log('  node tools/cobolt-release-checklist.js check [--json]');
    console.log('');
    console.log('Generates release-readiness-checklist.md from gate definitions.');
    const isHelpOrEmpty = command === undefined || command === '--help' || command === '-h';
    process.exit(isHelpOrEmpty ? 0 : 1);
  }
}

module.exports = { generateChecklist, checkItems };
