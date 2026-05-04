#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { checkPhaseGap } = require('./cobolt-brownfield-gap-review');
const { verifyBrownfieldArtifacts } = require('./cobolt-finding-verifier');
const { isToolOnlyVerificationFailure, loadOrBuildToolReliabilityReport } = require('./_brownfield-tool-reliability');
const {
  detectBrownfieldAssessmentMode,
  detectSourceRoot,
  extractIssueIds,
  isForensicAuditRequired,
  listIssues,
  loadJson,
  loadText,
  readLines,
  resolveSourceFile,
  selectTopIssuesForReverification,
  validateDeterministicCoverage,
  validateEvidenceIndex,
} = require('./_brownfield-readiness-utils');

function inspectIssueLocations(issues, sourceRoot) {
  const failures = [];

  for (const issue of issues) {
    const issueId = issue.id || 'unknown-issue';
    const file = issue.location?.file;
    const line = Number(issue.location?.line || 0);

    if (!file) {
      failures.push(`${issueId}: missing location.file`);
      continue;
    }

    const resolved = resolveSourceFile(sourceRoot, file);
    if (!resolved) {
      failures.push(`${issueId}: source file not found (${file})`);
      continue;
    }

    const lines = readLines(resolved);
    if (lines.length === 0) {
      failures.push(`${issueId}: source file unreadable (${file})`);
      continue;
    }

    if (!Number.isFinite(line) || line <= 0 || line > lines.length) {
      failures.push(`${issueId}: invalid line ${line} for ${file} (${lines.length} lines)`);
    }
  }

  return {
    pass: failures.length === 0,
    detail: failures.length === 0 ? 'All issue references point at real files and valid lines' : failures.join('; '),
    failures,
  };
}

function inspectAssessmentCrossRefs(bfDir, issues) {
  const assessment = loadText(path.join(bfDir, '23-master-assessment.md'));
  const issueIds = new Set(issues.map((issue) => String(issue.id || '').trim()).filter(Boolean));
  const referenced = extractIssueIds(assessment);

  if (referenced.length === 0) {
    return {
      pass: true,
      detail: 'No explicit issue IDs referenced in 23-master-assessment.md',
      missingIds: [],
      referencedIds: [],
    };
  }

  const missingIds = referenced.filter((id) => !issueIds.has(id));
  return {
    pass: missingIds.length === 0,
    detail:
      missingIds.length === 0
        ? `All ${referenced.length} assessment issue references resolve in the registry`
        : `Assessment references missing issue IDs: ${missingIds.slice(0, 5).join(', ')}`,
    missingIds,
    referencedIds: referenced,
  };
}

function issueHasValidSourceLocation(issue, sourceRoot) {
  const file = issue?.location?.file;
  const line = Number(issue?.location?.line || 0);
  if (!file) return false;

  const resolved = resolveSourceFile(sourceRoot, file);
  if (!resolved) return false;

  if (!Number.isFinite(line) || line <= 0) return true;
  const lines = readLines(resolved);
  return lines.length > 0 && line <= lines.length;
}

function ensureBrownfieldVerification(bfDir, sourceRoot, candidateIssueIds = []) {
  const verificationPath = path.join(bfDir, '16-issues-registry-verification.json');
  const existing = loadJson(verificationPath);
  const existingResults = Array.isArray(existing?.results) ? existing.results : [];
  const needsRefresh =
    !existing ||
    !Array.isArray(existing.results) ||
    candidateIssueIds.some((issueId) => !existingResults.some((result) => String(result.id || '').trim() === issueId));
  if (!needsRefresh) return verificationPath;

  verifyBrownfieldArtifacts({ brownfieldDir: bfDir, projectRoot: sourceRoot });
  return verificationPath;
}

function inspectRegistryVerification(bfDir, issuesData, sourceRoot) {
  const candidateIssues = selectTopIssuesForReverification(issuesData, { limit: 5, priorities: ['P0', 'P1', 'P2'] });
  const candidateIssueIds = candidateIssues.map((issue) => String(issue.id || '').trim()).filter(Boolean);
  const verificationPath = ensureBrownfieldVerification(bfDir, sourceRoot, candidateIssueIds);
  const verification = loadJson(verificationPath);

  if (candidateIssues.length === 0) {
    return {
      pass: true,
      detail: 'No high-priority brownfield issues with file locations were available for re-verification',
      mode: detectBrownfieldAssessmentMode(bfDir, issuesData),
      required: isForensicAuditRequired(bfDir, issuesData),
      sampledIssueIds: [],
      failingIssueIds: [],
    };
  }

  if (!verification || !Array.isArray(verification.results)) {
    return {
      pass: false,
      detail: '16-issues-registry-verification.json missing or invalid',
      mode: detectBrownfieldAssessmentMode(bfDir, issuesData),
      required: isForensicAuditRequired(bfDir, issuesData),
      sampledIssueIds: candidateIssues.map((issue) => issue.id).filter(Boolean),
      failingIssueIds: candidateIssues.map((issue) => issue.id).filter(Boolean),
    };
  }

  const resultById = new Map(verification.results.map((result) => [String(result.id || '').trim(), result]));
  const failures = [];
  const warnings = [];

  for (const issue of candidateIssues) {
    const issueId = String(issue.id || '').trim();
    const verificationResult = resultById.get(issueId);
    const status = verificationResult?.status || 'missing';
    if (status !== 'verified') {
      if (isToolOnlyVerificationFailure(verificationResult) && issueHasValidSourceLocation(issue, sourceRoot)) {
        warnings.push(`${issueId}: ${status} (source location valid; verifier signals are non-source-truth)`);
        continue;
      }
      failures.push(`${issueId}: ${status}`);
    }
  }

  return {
    pass: failures.length === 0,
    detail:
      failures.length === 0 && warnings.length === 0
        ? `Top ${candidateIssues.length} high-priority issues are verified against live source files`
        : failures.length === 0
          ? `Top ${candidateIssues.length} high-priority issues have valid source locations; verifier warnings: ${warnings.join(', ')}`
          : `High-priority issues failed re-verification: ${failures.join(', ')}`,
    mode: detectBrownfieldAssessmentMode(bfDir, issuesData),
    required: isForensicAuditRequired(bfDir, issuesData),
    sampledIssueIds: candidateIssues.map((issue) => issue.id).filter(Boolean),
    failingIssueIds: failures.map((failure) => failure.split(':')[0]),
    warningIssueIds: warnings.map((warning) => warning.split(':')[0]),
  };
}

function buildAccuracyReport(bfDir, options = {}) {
  const issuesData = loadJson(path.join(bfDir, '16-issues-registry.json'));
  const issues = listIssues(issuesData);
  const sourceRoot = detectSourceRoot(bfDir);

  const phaseGap = checkPhaseGap(bfDir, 'P3', { write: options.writeGapReport !== false });
  const issueLocations = inspectIssueLocations(issues, sourceRoot);
  const crossRefs = inspectAssessmentCrossRefs(bfDir, issues);
  const evidence = validateEvidenceIndex(bfDir);
  const deterministicCoverage = validateDeterministicCoverage(bfDir, issuesData);
  const registryVerification = inspectRegistryVerification(bfDir, issuesData, sourceRoot);
  const toolReliability = loadOrBuildToolReliabilityReport(bfDir, {
    refresh: true,
    write: options.write !== false,
  });
  const assessmentMode = detectBrownfieldAssessmentMode(bfDir, issuesData);
  const forensicAuditRequired = isForensicAuditRequired(bfDir, issuesData);

  const checks = [
    {
      id: 'A1',
      name: 'P3 Gap Review',
      pass: phaseGap.result !== 'fail',
      severity: phaseGap.result === 'fail' ? 'high' : 'low',
      detail: `phase-${phaseGap.phase}-gap-report.json => ${phaseGap.result}`,
    },
    {
      id: 'A2',
      name: 'Issue Evidence Locations',
      pass: issueLocations.pass,
      severity: 'high',
      detail: issueLocations.detail,
    },
    {
      id: 'A3',
      name: 'Master Assessment Cross-References',
      pass: crossRefs.pass,
      severity: crossRefs.missingIds.length > 0 ? 'high' : 'low',
      detail: crossRefs.detail,
    },
    {
      id: 'A4',
      name: 'Evidence Index Integrity',
      pass: evidence.pass,
      severity: 'high',
      detail: evidence.detail,
    },
    {
      id: 'A5',
      name: 'Deterministic Finding Coverage',
      pass: deterministicCoverage.pass,
      severity: 'high',
      detail: deterministicCoverage.detail,
    },
    {
      id: 'A6',
      name: 'High-Priority Issue Re-Verification',
      pass: registryVerification.pass,
      severity: 'high',
      detail: registryVerification.detail,
    },
    {
      id: 'A7',
      name: 'Tool Verdict Reliability',
      pass: toolReliability.status !== 'fail',
      severity: toolReliability.status === 'fail' ? 'high' : 'low',
      detail: `status=${toolReliability.status}, trust=${toolReliability.trustScore ?? 'n/a'}/100, degraded=${toolReliability.degradedArtifacts.length}`,
    },
  ];

  const failingChecks = checks.filter(
    (check) => !check.pass && (check.severity === 'critical' || check.severity === 'high'),
  );
  const warnings = checks.filter((check) => !check.pass && check.severity !== 'critical' && check.severity !== 'high');

  const report = {
    version: '1.1.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-brownfield-accuracy-review',
    sourceRoot,
    context: {
      analysisMode: assessmentMode,
      forensicAuditRequired,
      sampledIssueIds: registryVerification.sampledIssueIds,
      toolReliability: {
        status: toolReliability.status,
        trustScore: toolReliability.trustScore,
        degradedArtifacts: toolReliability.degradedArtifacts,
        blockingFailures: toolReliability.blockingFailures,
      },
    },
    passed: failingChecks.length === 0,
    checks,
    failingChecks: failingChecks.map((check) => check.id),
    warnings: warnings.map((check) => check.id),
    totals: {
      issuesReviewed: issues.length,
      failingChecks: failingChecks.length,
      warnings: warnings.length,
    },
  };

  if (options.write !== false) {
    fs.mkdirSync(bfDir, { recursive: true });
    fs.writeFileSync(path.join(bfDir, 'phase-P3-accuracy-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  return report;
}

const USAGE = `Usage: node tools/cobolt-brownfield-accuracy-review.js check [--dir <path>] [--json]

Commands:
  check    Run brownfield accuracy review against P3 artifacts (alias: build)

Flags:
  --dir <path>  Brownfield artifact dir (default: _cobolt-output/latest/brownfield)
  --json        Emit machine-readable JSON
  --help, -h    Show this help and exit
`;

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const command = args[0] || 'check';
  const dirIdx = args.indexOf('--dir');
  const bfDir =
    dirIdx !== -1 && args[dirIdx + 1]
      ? path.resolve(args[dirIdx + 1])
      : path.join(process.cwd(), '_cobolt-output', 'latest', 'brownfield');
  const jsonMode = args.includes('--json');

  if (command === 'check' || command === 'build') {
    const report = buildAccuracyReport(bfDir);
    if (jsonMode) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('[cobolt-brownfield-accuracy-review] P3 Accuracy Review');
      console.log(`  Source root: ${report.sourceRoot}`);
      console.log(`  Verdict: ${report.passed ? 'PASS' : 'FAIL'}`);
      for (const check of report.checks) {
        console.log(`  [${check.pass ? 'PASS' : 'FAIL'}] ${check.id} ${check.name}: ${check.detail}`);
      }
    }
    process.exit(report.passed ? 0 : 1);
  }

  console.log('CoBolt Brownfield Accuracy Review');
  console.log('');
  console.log(USAGE);
  process.exit(command ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildAccuracyReport,
  inspectAssessmentCrossRefs,
  inspectIssueLocations,
};
