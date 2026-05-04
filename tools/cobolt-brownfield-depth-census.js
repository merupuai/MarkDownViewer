#!/usr/bin/env node

// CoBolt Brownfield Depth-Flag Census
//
// Closes brownfield issue 17 (reverse-eng depth-flag census gap).
//
// `--scan minimal`, `--scan deep`, `--scan full` promise different artifact
// counts (brownfield-artifacts.md documents: ~28 default, ~36 deep, 64 full).
// Nothing currently verifies the produced count matches the requested depth.
// A deep run that silently degraded to default would still emit artifacts but
// fewer than the user was told to expect.
//
// This tool reads `00-run-context.json` to learn the requested depth, then
// censuses the actual artifact set on disk and compares against the expected
// set for that depth. Non-zero exit when the shortfall exceeds a tolerance
// (default 2 artifacts — small variance accounts for `cond` / non-UI runs).
//
// Usage:
//   node tools/cobolt-brownfield-depth-census.js check --dir <bf-dir> [--json]
//
// Exit codes:
//   0 — artifact count meets depth-mode expectation
//   1 — shortfall beyond tolerance
//   2 — usage error
//   3 — required input (00-run-context.json) missing

const fs = require('node:fs');
const path = require('node:path');

// Expected artifact sets per depth. Extracted from brownfield-artifacts.md
// "Artifact Matrix by Phase". Conditional-on-frontend (`cond`) and
// deep-only-frontend artifacts are tracked separately so the census can
// discount them without false-positive failures.
const DEPTH_EXPECTED = Object.freeze({
  default: {
    required: [
      '01-intake-and-classification.md',
      '02-baseline-health-and-scan-summary.md',
      '03-project-context.md',
      '03a-domain-knowledge-base.md',
      '03b-project-knowledge-base.md',
      '03c-project-skills-manifest.md',
      '04-feature-and-module-inventory.md',
      '05-database-and-data-store-report.md',
      '06-integration-map.md',
      '07-configuration-and-access-audit.md',
      '09-supply-chain-and-vulnerability-review.md',
      '10-discovery-tracker.json',
      '11-dependency-tracker.json',
      '12-security-and-quality-assessment.md',
      '16-issues-registry.json',
      '16a-forensic-findings.json',
      '16b-illusion-inventory.json',
      '16c-illusion-verification.json',
      '16d-forensic-audit-report.md',
      '16e-phantom-rejection-log.json',
      '17-enhancement-advisory.md',
      '19-evidence-index.json',
      'brownfield-tool-health.json',
      '23-master-assessment.md',
    ],
    conditionalFrontend: ['08-ui-and-workflow-catalog.md', '08a-current-ui-ux-assessment.md', '11a-ux-tracker.json'],
    expectedMin: 22, // tolerant lower bound for the ~28 default count
  },
  deep: {
    required: [
      // all default artifacts
      '01-intake-and-classification.md',
      '02-baseline-health-and-scan-summary.md',
      '03-project-context.md',
      '03a-domain-knowledge-base.md',
      '03b-project-knowledge-base.md',
      '03c-project-skills-manifest.md',
      '04-feature-and-module-inventory.md',
      '05-database-and-data-store-report.md',
      '06-integration-map.md',
      '07-configuration-and-access-audit.md',
      '09-supply-chain-and-vulnerability-review.md',
      '10-discovery-tracker.json',
      '11-dependency-tracker.json',
      '12-security-and-quality-assessment.md',
      '13-architecture-recovery.md',
      '14-business-rules-and-validation.md',
      '15-feature-triage-matrix.md',
      '16-issues-registry.json',
      '16a-forensic-findings.json',
      '16b-illusion-inventory.json',
      '16c-illusion-verification.json',
      '16d-forensic-audit-report.md',
      '16e-phantom-rejection-log.json',
      '16f-dead-code-inventory.md',
      '16g-architecture-quality-review.md',
      '17-enhancement-advisory.md',
      '18-modernization-roadmap.md',
      '19-evidence-index.json',
      '20-modernization-decision-log.md',
      'brownfield-tool-health.json',
      '23-master-assessment.md',
    ],
    conditionalFrontend: [
      '08-ui-and-workflow-catalog.md',
      '08a-current-ui-ux-assessment.md',
      '11a-ux-tracker.json',
      '16h-design-quality-assessment.md',
    ],
    expectedMin: 29, // tolerant lower bound for the ~36 deep count
  },
  full: {
    required: [
      // everything in deep
      '01-intake-and-classification.md',
      '02-baseline-health-and-scan-summary.md',
      '03-project-context.md',
      '03a-domain-knowledge-base.md',
      '03b-project-knowledge-base.md',
      '03c-project-skills-manifest.md',
      '04-feature-and-module-inventory.md',
      '05-database-and-data-store-report.md',
      '06-integration-map.md',
      '07-configuration-and-access-audit.md',
      '09-supply-chain-and-vulnerability-review.md',
      '10-discovery-tracker.json',
      '11-dependency-tracker.json',
      '12-security-and-quality-assessment.md',
      '13-architecture-recovery.md',
      '14-business-rules-and-validation.md',
      '15-feature-triage-matrix.md',
      '16-issues-registry.json',
      '16a-forensic-findings.json',
      '16b-illusion-inventory.json',
      '16c-illusion-verification.json',
      '16d-forensic-audit-report.md',
      '16e-phantom-rejection-log.json',
      '16f-dead-code-inventory.md',
      '16g-architecture-quality-review.md',
      '17-enhancement-advisory.md',
      '18-modernization-roadmap.md',
      '19-evidence-index.json',
      '20-modernization-decision-log.md',
      '21-modernization-handoff.json',
      '22-modernization-milestone-tracker.json',
      '23-master-assessment.md',
      'brownfield-tool-health.json',
      // P4-P6 planning artifacts
      '24-modernization-prd.md',
      '25-modernization-trd.md',
      '26-modernization-security-requirements.md',
      '26a-modernization-secure-coding-standard.md',
      '26b-modernization-engineering-quality-standards.md',
      '27-modernization-system-architecture.md',
      '28-modernization-architecture-decisions.md',
      '29-modernization-data-model-spec.md',
      '30-modernization-api-contracts.md',
      '31-modernization-ux-design-specification.md',
      '31a-modernization-wireframes-and-user-flows.md',
      '32-modernization-implicit-requirements.md',
      '33-modernization-dependency-and-integration-register.md',
      '34-modernization-dependency-tracker.json',
      '34a-modernization-ux-tracker.json',
      '35-modernization-milestones.md',
      '36-modernization-epics-and-stories.md',
      '37-modernization-traceability-matrix.md',
      '38-modernization-test-strategy.md',
      '39-modernization-delivery-plan.md',
      '40-modernization-milestone-tracker.json',
      '41-modernization-story-tracker.json',
      '42-modernization-issue-and-blocker-tracker.json',
      '43-modernization-validation-report.md',
      '44-modernization-release-readiness-checklist.md',
      '45-modernization-master-plan.md',
    ],
    conditionalFrontend: [
      '08-ui-and-workflow-catalog.md',
      '08a-current-ui-ux-assessment.md',
      '11a-ux-tracker.json',
      '16h-design-quality-assessment.md',
    ],
    expectedMin: 55, // tolerant lower bound for the 64 full count
  },
});

// Map `00-run-context.json.modeKey` (+ scanLevel when set) to a depth bucket.
function resolveDepth(runContext) {
  if (!runContext || typeof runContext !== 'object') return 'default';
  const modeKey = String(runContext.modeKey || '').toLowerCase();
  const scanLevel = String(runContext.scanLevel || '').toLowerCase();

  if (modeKey === 'full' || modeKey === 'scan-full' || modeKey === 'reverse-engineer') return 'full';
  if (
    modeKey === 'add-feature' ||
    modeKey === 'fix-issues' ||
    modeKey === 'continue-plan' ||
    modeKey === 'continue-build'
  )
    return 'full';
  if (modeKey === 'scan-deep' || modeKey === 'analysis-only' || scanLevel === 'deep') return 'deep';
  return 'default';
}

function loadRunContext(bfDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(bfDir, '00-run-context.json'), 'utf8'));
  } catch {
    return null;
  }
}

function fileExistsNonEmpty(p) {
  try {
    const st = fs.statSync(p);
    return st.size > 0;
  } catch {
    return false;
  }
}

function hasFrontend(bfDir) {
  // Frontend detection is derived from run-context.flags.hasUI OR presence of
  // the conditional UI artifacts. If run-context has the flag, trust it.
  const rc = loadRunContext(bfDir);
  if (rc?.flags && typeof rc.flags.hasUI === 'boolean') return rc.flags.hasUI;
  const indicators = [
    '08-ui-and-workflow-catalog.md',
    '08a-current-ui-ux-assessment.md',
    '31-modernization-ux-design-specification.md',
  ];
  return indicators.some((f) => fileExistsNonEmpty(path.join(bfDir, f)));
}

function census(bfDir) {
  if (!fs.existsSync(bfDir)) {
    return { ok: false, reason: 'brownfield-dir-missing', path: bfDir };
  }
  const rc = loadRunContext(bfDir);
  if (!rc) {
    return { ok: false, reason: 'run-context-missing', path: path.join(bfDir, '00-run-context.json') };
  }
  const depth = resolveDepth(rc);
  const spec = DEPTH_EXPECTED[depth];
  if (!spec) return { ok: false, reason: 'unknown-depth', depth };

  const frontend = hasFrontend(bfDir);
  const expectedSet = new Set(spec.required);
  if (frontend) {
    for (const f of spec.conditionalFrontend) expectedSet.add(f);
  }

  const found = [];
  const missing = [];
  for (const f of expectedSet) {
    const full = path.join(bfDir, f);
    if (fileExistsNonEmpty(full)) found.push(f);
    else missing.push(f);
  }

  const meetsMinCount = found.length >= spec.expectedMin;
  const missingTolerance = 2; // small cushion for edge-case conditionals
  const ok = missing.length <= missingTolerance && meetsMinCount;

  return {
    ok,
    depth,
    modeKey: rc.modeKey,
    scanLevel: rc.scanLevel,
    frontend,
    expectedCount: expectedSet.size,
    expectedMin: spec.expectedMin,
    foundCount: found.length,
    missingCount: missing.length,
    missing,
    shortfall: Math.max(0, spec.expectedMin - found.length),
  };
}

function audit(cwd, entry) {
  try {
    const dir = path.join(cwd, '_cobolt-output', 'audit');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(dir, 'brownfield-depth-census.jsonl'),
      `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* best effort */
  }
}

function printHelp() {
  process.stdout.write(
    `cobolt-brownfield-depth-census — verify --scan minimal|deep|full produced expected count\n\n` +
      `USAGE\n` +
      `  node tools/cobolt-brownfield-depth-census.js check [--dir <bf-dir>] [--json]\n` +
      `  node tools/cobolt-brownfield-depth-census.js manifest --depth default|deep|full [--frontend] [--json]\n` +
      `  node tools/cobolt-brownfield-depth-census.js --help\n\n` +
      `MANIFEST\n` +
      `  Front-loads the orchestrator with the expected artifact list for a given depth\n` +
      `  so the producer phase can target the exact set up-front instead of discovering\n` +
      `  shortfalls iteratively. Pass --frontend to include UI-conditional artifacts.\n\n` +
      `EXIT CODES\n` +
      `  0 — artifact count meets depth-mode expectation (or manifest emitted successfully)\n` +
      `  1 — shortfall beyond tolerance (silent depth degrade)\n` +
      `  2 — usage error\n` +
      `  3 — run-context or brownfield dir missing\n`,
  );
}

function buildManifest(depth, includeFrontend) {
  const spec = DEPTH_EXPECTED[depth];
  if (!spec) return null;
  const required = [...spec.required];
  const conditional = [...spec.conditionalFrontend];
  const expected = includeFrontend ? [...required, ...conditional] : required;
  return {
    depth,
    includeFrontend,
    expectedMin: spec.expectedMin,
    expectedCount: expected.length,
    required,
    conditionalFrontend: conditional,
    expected,
  };
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  if (args[0] === 'manifest') {
    const depthIdx = args.indexOf('--depth');
    const depth = depthIdx !== -1 && args[depthIdx + 1] ? args[depthIdx + 1] : null;
    if (!depth || !DEPTH_EXPECTED[depth]) {
      process.stderr.write(
        `manifest requires --depth <default|deep|full>\n` +
          `Recognized depths: ${Object.keys(DEPTH_EXPECTED).join(', ')}\n`,
      );
      return 2;
    }
    const includeFrontend = args.includes('--frontend');
    const manifest = buildManifest(depth, includeFrontend);
    if (!manifest) {
      process.stderr.write(`unknown depth: ${depth}\n`);
      return 2;
    }
    if (args.includes('--json')) {
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    } else {
      process.stdout.write(
        `Depth manifest (${depth}${includeFrontend ? ', +frontend' : ''}): ` +
          `${manifest.expectedCount} artifacts (min ${manifest.expectedMin})\n`,
      );
      for (const f of manifest.expected) process.stdout.write(`  - ${f}\n`);
    }
    return 0;
  }

  if (args[0] !== 'check') {
    process.stderr.write(`Unknown command: ${args[0]}\n`);
    printHelp();
    return 2;
  }
  const dirIdx = args.indexOf('--dir');
  const bfDir =
    dirIdx !== -1 && args[dirIdx + 1]
      ? path.resolve(args[dirIdx + 1])
      : path.join(process.cwd(), '_cobolt-output', 'latest', 'brownfield');
  const wantJson = args.includes('--json');

  const result = census(bfDir);
  audit(process.cwd(), { bfDir, ...result });

  if (wantJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    if (result.reason) process.stderr.write(`FAIL: ${result.reason}\n`);
    else {
      process.stdout.write(
        `Depth census (${result.depth}, modeKey=${result.modeKey || 'n/a'}): ` +
          `found=${result.foundCount}/${result.expectedCount}, ` +
          `min-expected=${result.expectedMin}, missing=${result.missingCount}\n`,
      );
      if (result.missingCount > 0 && !result.ok) {
        for (const m of result.missing.slice(0, 10)) process.stderr.write(`  MISSING: ${m}\n`);
        if (result.missing.length > 10) process.stderr.write(`  …and ${result.missing.length - 10} more\n`);
      }
    }
  }

  if (result.reason === 'brownfield-dir-missing' || result.reason === 'run-context-missing') return 3;
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = {
  census,
  resolveDepth,
  buildManifest,
  DEPTH_EXPECTED,
  _testOnly: { hasFrontend, fileExistsNonEmpty },
};
