#!/usr/bin/env node

// CoBolt governance standards gate.
//
// Baseline secure-coding and engineering standards are always required for a
// planned CoBolt build. This is intentionally not tied to SOC2/GDPR/etc.:
// compliance frameworks add obligations, but safe engineering is the floor.

const fs = require('node:fs');
const path = require('node:path');
const { getPlanningDir } = require('../lib/cobolt-planning-artifacts');
const { assessFrameworkRegistryFreshness } = require('../lib/cobolt-framework-versions');
// v0.66.5 (Wave 3a A-3a-4): refactored from inline loadProjectClass() to the
// shared lib/cobolt-project-class-loader so future round/step gating consumers
// reach the same verdict. The local loadProjectClass() below is preserved as
// a thin pass-through for backward compatibility — existing tests import it
// directly from this module's public surface.
const { loadProjectClass: loadProjectClassShared } = require('../lib/cobolt-project-class-loader');

// Per-check `applies` declares which project classes the check is required
// for. Reading project-class.json (when present) lets the gate skip checks
// that are noise for the project's class — e.g., desktop binaries do not have
// auth/PII/rollback prose to enforce. When project-class.json is absent the
// gate behaves exactly as before (all checks apply). The taxonomy:
//   desktop | saas | service | library | cli | mobile | unknown
// Use the literal '*' to mean "all classes" — the default for foundational
// checks (input validation, error handling, dependency hygiene).
const ALL_CLASSES = '*';
const STANDARD_ARTIFACTS = [
  {
    id: 'SECURE-CODING-STANDARD',
    label: 'Secure coding standard',
    fileName: 'secure-coding-standard.md',
    minBytes: 300,
    checks: [
      {
        id: 'input-validation',
        label: 'input validation and sanitization',
        patterns: [/\binput validation\b/i, /\bsanitization\b/i, /\bsanitize\b/i, /\bvalidation\b/i],
        applies: ALL_CLASSES,
      },
      {
        id: 'output-encoding',
        label: 'output encoding and injection/XSS prevention',
        patterns: [/\boutput encoding\b/i, /\bxss\b/i, /\binjection\b/i, /\bescaping\b/i],
        applies: ['saas', 'service', 'mobile'],
      },
      {
        id: 'auth-access-control',
        label: 'authentication and authorization checks',
        patterns: [/\bauthentication\b/i, /\bauthorization\b/i, /\baccess control\b/i, /\brbac\b/i],
        applies: ['saas', 'service', 'mobile'],
      },
      {
        id: 'secrets-keys',
        label: 'secrets and key management',
        patterns: [/\bsecret/i, /\bkey management\b/i, /\bkey rotation\b/i, /\bkms\b/i, /\benvironment variable\b/i],
        applies: ['saas', 'service', 'mobile', 'cli'],
      },
      {
        id: 'dependency-hygiene',
        label: 'dependency and supply-chain hygiene',
        patterns: [/\bdependency\b/i, /\bsupply chain\b/i, /\bsbom\b/i, /\bsca\b/i, /\baudit\b/i],
        applies: ALL_CLASSES,
      },
      {
        id: 'logs-pii',
        label: 'safe logging, PII redaction, and audit trails',
        patterns: [/\blog redaction\b/i, /\bpii\b/i, /\bpersonal data\b/i, /\baudit log\b/i, /\bsafe logging\b/i],
        applies: ['saas', 'service', 'mobile'],
      },
      {
        id: 'error-handling',
        label: 'secure error handling and fail-closed behavior',
        patterns: [/\berror handling\b/i, /\bfail[- ]closed\b/i, /\bexception\b/i, /\bno silent failure\b/i],
        applies: ALL_CLASSES,
      },
    ],
  },
  {
    id: 'ENGINEERING-QUALITY-STANDARDS',
    label: 'Engineering quality standards',
    fileName: 'engineering-quality-standards.md',
    minBytes: 300,
    checks: [
      {
        id: 'naming-style',
        label: 'naming and style conventions',
        patterns: [/\bnaming\b/i, /\bstyle\b/i, /\bconvention\b/i, /\bformat/i],
      },
      {
        id: 'api-contracts',
        label: 'API, schema, and contract rules',
        patterns: [/\bapi\b/i, /\bcontract\b/i, /\bschema\b/i, /\binterface\b/i],
      },
      {
        id: 'testing-coverage',
        label: 'testing and coverage expectations',
        patterns: [/\btest\b/i, /\bcoverage\b/i, /\bunit\b/i, /\bintegration\b/i],
      },
      {
        id: 'error-handling',
        label: 'error handling and observability expectations',
        patterns: [/\berror handling\b/i, /\bobservability\b/i, /\blogging\b/i, /\balert/i],
      },
      {
        id: 'maintainability',
        label: 'maintainability and modularity guidance',
        patterns: [/\bmaintainability\b/i, /\bmodular/i, /\bcomplexity\b/i, /\brefactor/i],
      },
    ],
  },
  {
    id: 'DETERMINISTIC-QUALITY-GATES',
    label: 'Deterministic quality gate configuration',
    fileName: 'deterministic-quality-gates.json',
    minBytes: 50,
    json: true,
    checks: [
      {
        id: 'lint',
        label: 'lint gate',
        patterns: [/\blint\b/i],
      },
      {
        id: 'typecheck',
        label: 'type checking gate',
        patterns: [/\btypecheck\b/i, /\btype-check\b/i, /\btype checking\b/i],
      },
      {
        id: 'security',
        label: 'security gate',
        patterns: [/\bsecurity\b/i, /\bsast\b/i, /\bscan\b/i],
      },
      {
        id: 'dependencies',
        label: 'dependency gate',
        patterns: [/\bdeps\b/i, /\bdependencies\b/i, /\bdependency\b/i],
      },
      {
        id: 'tests',
        label: 'test gate',
        patterns: [/\btest\b/i, /\bcoverage\b/i],
      },
    ],
  },
  {
    id: 'RELEASE-READINESS-CHECKLIST',
    label: 'Release readiness checklist',
    fileName: 'release-readiness-checklist.md',
    minBytes: 300,
    checks: [
      {
        id: 'quality-gates',
        label: 'quality gate verification',
        patterns: [/\bquality gate\b/i, /\blint\b/i, /\btype checking\b/i, /\btest\b/i],
        applies: ALL_CLASSES,
      },
      {
        id: 'security-evidence',
        label: 'security evidence',
        patterns: [/\bsecurity\b/i, /\bsast\b/i, /\bdependency audit\b/i, /\bsecrets\b/i],
        applies: ALL_CLASSES,
      },
      {
        id: 'release-evidence',
        label: 'release evidence and approvals',
        patterns: [/\bevidence\b/i, /\bsign[- ]off\b/i, /\bapproval\b/i, /\bverified\b/i],
        applies: ALL_CLASSES,
      },
      {
        id: 'rollback',
        // Desktop / library / cli "rollback" is "publish prior tag" / "yank
        // package" — mechanically different from a SaaS rollback. SaaS and
        // service tracks need a real rollback procedure documented.
        label: 'rollback procedure',
        patterns: [/\brollback\b/i, /\brevert\b/i, /\brestore\b/i, /\bbackout\b/i, /\byank\b/i, /\bprior tag\b/i],
        applies: ['saas', 'service', 'mobile'],
      },
    ],
  },
];

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function artifactPath(planningDir, artifact) {
  return path.join(planningDir, artifact.fileName);
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function parseJsonIfNeeded(_filePath, artifact, content, missingChecks) {
  if (!artifact.json) return null;
  try {
    return JSON.parse(content);
  } catch (err) {
    missingChecks.push({
      id: 'valid-json',
      label: 'valid JSON',
      reason: `could not parse JSON: ${err.message}`,
    });
    return null;
  }
}

function checkAppliesTo(check, projectClass) {
  if (!check.applies || check.applies === ALL_CLASSES) return true;
  if (Array.isArray(check.applies)) return check.applies.includes(projectClass);
  return true;
}

// v0.66.5 (Wave 3a A-3a-4): thin wrapper preserving the legacy return shape
// (null when no detection, plain {projectClass, source} object on hit) so
// external test importers (`tests/test-project-class-and-standards.js`) and
// the public module export stay backward-compatible. New consumers should
// call lib/cobolt-project-class-loader::loadProjectClass directly to receive
// the richer {projectClass, confidence, evidence, source, generatedAt} shape.
function loadProjectClass(projectRoot, planningDir) {
  const info = loadProjectClassShared(projectRoot, planningDir ? { planningDir } : {});
  if (info.source === null) return null;
  return { projectClass: info.projectClass, source: info.source };
}

function evaluateArtifact(projectRoot, planningDir, artifact, projectClass) {
  const filePath = artifactPath(planningDir, artifact);
  const exists = fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  const content = exists ? readText(filePath) : '';
  const bytes = Buffer.byteLength(content, 'utf8');
  const missingChecks = [];
  const skippedChecks = [];
  const parsedJson = parseJsonIfNeeded(filePath, artifact, content, missingChecks);

  if (!exists) {
    return {
      id: artifact.id,
      label: artifact.label,
      path: path.relative(projectRoot, filePath),
      exists: false,
      bytes: 0,
      minBytes: artifact.minBytes,
      passed: false,
      missingChecks: [{ id: 'artifact-exists', label: 'artifact exists', reason: 'missing required artifact' }],
      skippedChecks,
    };
  }

  if (bytes < artifact.minBytes) {
    missingChecks.push({
      id: 'min-bytes',
      label: `${artifact.minBytes} byte minimum`,
      reason: `${bytes} bytes found`,
    });
  }

  const searchable = artifact.json && parsedJson ? JSON.stringify(parsedJson) : content;
  for (const check of artifact.checks) {
    if (projectClass && !checkAppliesTo(check, projectClass)) {
      skippedChecks.push({
        id: check.id,
        label: check.label,
        reason: `not applicable to project class '${projectClass}'`,
        appliesTo: check.applies,
      });
      continue;
    }
    if (!hasAny(searchable, check.patterns)) {
      missingChecks.push({
        id: check.id,
        label: check.label,
        reason: `missing ${check.label}`,
      });
    }
  }

  return {
    id: artifact.id,
    label: artifact.label,
    path: path.relative(projectRoot, filePath),
    exists,
    bytes,
    minBytes: artifact.minBytes,
    passed: missingChecks.length === 0,
    missingChecks,
    skippedChecks,
  };
}

function evaluateStandardsGate(projectRoot = process.cwd(), options = {}) {
  const frameworkRegistry = assessFrameworkRegistryFreshness({
    registryRoot: options.frameworkRegistryRoot,
    now: options.now,
  });
  const advisories = frameworkRegistry.isStale
    ? [
        {
          id: 'FRAMEWORK-VERSION-REGISTRY-STALENESS',
          severity: 'warn',
          source: 'source/data/security-frameworks-versions.json',
          message: frameworkRegistry.ok
            ? `Security framework registry last reviewed ${frameworkRegistry.lastReviewed} (${frameworkRegistry.ageDays} days old); refresh it before trusting version-specific framework citations.`
            : 'Security framework registry metadata is missing or invalid; refresh source/data/security-frameworks-versions.json before trusting version-specific framework citations.',
        },
      ]
    : [];
  const planningDir = getPlanningDir(projectRoot, { create: false, strict: false, fallbackToLatest: true });
  const mode = options.mode || 'planning';
  if (!planningDir) {
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      mode,
      status: 'failed',
      passed: false,
      planningDir: null,
      frameworkRegistry,
      advisories,
      summary: {
        totalArtifacts: STANDARD_ARTIFACTS.length,
        passedArtifacts: 0,
        failedArtifacts: STANDARD_ARTIFACTS.length,
      },
      artifacts: STANDARD_ARTIFACTS.map((artifact) => ({
        id: artifact.id,
        label: artifact.label,
        path: path.join('_cobolt-output', 'latest', 'planning', artifact.fileName),
        exists: false,
        bytes: 0,
        minBytes: artifact.minBytes,
        passed: false,
        missingChecks: [
          { id: 'planning-dir', label: 'planning directory exists', reason: 'planning artifacts missing' },
        ],
      })),
      missingArtifacts: STANDARD_ARTIFACTS.map((artifact) => artifact.id),
      message:
        'Planning artifacts are missing. Run cobolt plan so baseline security and coding standards are captured before build/review.',
    };
  }

  const projectClassInfo = loadProjectClass(projectRoot, planningDir);
  const projectClass = projectClassInfo ? projectClassInfo.projectClass : null;
  const artifacts = STANDARD_ARTIFACTS.map((artifact) =>
    evaluateArtifact(projectRoot, planningDir, artifact, projectClass),
  );
  const failedArtifacts = artifacts.filter((artifact) => !artifact.passed);
  const totalSkipped = artifacts.reduce((sum, a) => sum + (a.skippedChecks ? a.skippedChecks.length : 0), 0);

  // v0.66.5 (Wave 1 C-1): severity is the gate's own declaration of how its
  // verdict should be interpreted by downstream log readers. The TIER (1/2/3)
  // is decided by the caller's gate-resolver, but the SEVERITY field in the
  // envelope removes the ambiguity that the user-reported confusing logs of
  // {verdict:"failed", passed:false, exit:0} created. Two values:
  //   "blocking"  — caller treats failure as a hard block (exit 1 on fail).
  //   "advisory"  — caller treats failure as informational (exit 0 on fail).
  // Default is "blocking" so the fail-closed behavior is preserved unless an
  // explicit advisory caller opts in. Honors the COBOLT_STANDARDS_SEVERITY env
  // var and the --severity arg so callers can pin semantics without a wrapper.
  const severity = options?.severity || 'blocking';
  const passed = failedArtifacts.length === 0;
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode,
    severity,
    status: passed ? 'passed' : 'failed',
    passed,
    blocking: severity === 'blocking' && !passed,
    planningDir: path.relative(projectRoot, planningDir),
    frameworkRegistry,
    advisories,
    projectClass: projectClassInfo,
    summary: {
      totalArtifacts: artifacts.length,
      passedArtifacts: artifacts.filter((artifact) => artifact.passed).length,
      failedArtifacts: failedArtifacts.length,
      skippedChecks: totalSkipped,
    },
    artifacts,
    missingArtifacts: failedArtifacts.map((artifact) => artifact.id),
    message: passed
      ? `Baseline secure-coding and engineering standards are present${projectClass ? ` (project class: ${projectClass})` : ''}.`
      : severity === 'advisory'
        ? 'Baseline secure-coding and engineering standards are incomplete (advisory — non-blocking).'
        : 'Baseline secure-coding and engineering standards are incomplete.',
  };
}

function writeReport(outputPath, report) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function defaultOutputPath(projectRoot, mode) {
  const planningDir = getPlanningDir(projectRoot, { create: true });
  return path.join(planningDir, `standards-gate-${mode}.json`);
}

function parseArgs(argv) {
  const args = [...argv];
  // v0.65.1 Wave 5 §5.7 — `reverse-engineering` added to mode whitelist for the
  // brownfield P3→P4 boundary call when forensicAuditRequired || reverseEngineeringMode
  // is set. Adding the mode is purely additive: existing planning/build/review/release
  // callers see no behavior change. The baseline-artifact checks below run identically
  // for every mode (they verify the 4 standard planning artifacts exist); the mode is
  // a label propagated to the output filename and the report.mode field.
  const modeArg = args.find((arg) => ['planning', 'build', 'review', 'release', 'reverse-engineering'].includes(arg));
  const options = {
    mode: modeArg || 'planning',
    json: args.includes('--json'),
    output: null,
    // v0.66.5 (Wave 1 C-1): caller declares semantic severity. Env var lets
    // hooks/skills override without threading a flag through every dispatch.
    severity: process.env.COBOLT_STANDARDS_SEVERITY === 'advisory' ? 'advisory' : 'blocking',
  };

  const outputIndex = args.indexOf('--output');
  if (outputIndex !== -1 && args[outputIndex + 1]) {
    options.output = args[outputIndex + 1];
  }

  const severityIndex = args.indexOf('--severity');
  if (severityIndex !== -1 && args[severityIndex + 1]) {
    const value = args[severityIndex + 1];
    if (value === 'advisory' || value === 'blocking') {
      options.severity = value;
    }
  }

  return options;
}

function main() {
  const rawArgv = process.argv.slice(2);
  // v0.46 — explicit --help / -h / help → exit 0 per tools/CLAUDE.md contract.
  // CRITICAL: this check MUST precede evaluateStandardsGate() because the
  // evaluator writes standards-gate-<mode>.json as a side effect. A --help
  // probe MUST NOT write files (memory rule v0.40.2: side-effect-free --help).
  if (rawArgv.includes('--help') || rawArgv.includes('-h') || rawArgv[0] === 'help') {
    process.stdout.write(
      'Usage: cobolt-standards-gate.js [planning|build|review|release|reverse-engineering]\n' +
        '                                [--json] [--output <path>]\n' +
        '                                [--severity blocking|advisory]\n' +
        '\n' +
        'Severity (Wave 1 C-1):\n' +
        '  blocking  (default) — exit 1 on fail; consumer hard-blocks pipeline.\n' +
        '  advisory            — exit 0 on fail; consumer logs the verdict only.\n' +
        '  COBOLT_STANDARDS_SEVERITY=advisory env var sets the default.\n',
    );
    process.exit(0);
  }
  const options = parseArgs(rawArgv);
  const projectRoot = process.cwd();
  const report = evaluateStandardsGate(projectRoot, options);
  const outputPath = options.output || defaultOutputPath(projectRoot, options.mode);
  writeReport(path.resolve(projectRoot, outputPath), report);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `Standards gate: ${report.passed ? 'PASS' : 'FAIL'} ` +
        `(${report.summary.passedArtifacts}/${report.summary.totalArtifacts} artifacts passed) ` +
        `severity=${report.severity}`,
    );
    for (const artifact of report.artifacts.filter((item) => !item.passed)) {
      console.log(`  - ${artifact.id}: ${artifact.missingChecks.map((check) => check.id).join(', ')}`);
    }
  }

  // v0.66.5 (Wave 1 C-1): exit code honors severity. Advisory severity exits 0
  // even on fail so Tier 3 callers see passed:false in the JSON without the
  // pipeline halting. Blocking severity preserves the fail-closed exit-1 behavior.
  if (!report.passed && report.severity === 'advisory') {
    process.exit(0);
  }
  process.exit(report.passed ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  STANDARD_ARTIFACTS,
  ALL_CLASSES,
  evaluateStandardsGate,
  loadProjectClass,
  checkAppliesTo,
  parseArgs,
};
