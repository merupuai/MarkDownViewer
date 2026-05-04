#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  REVIEW_FILES,
  countReviewerCoverage,
  defaultReviewDir,
  detectMilestone,
  detectProjectRoot,
  extractFindingIds,
  findReviewReport,
  inspectFindingLocations,
  listFindings,
  loadJson,
  loadText,
  maybePrintHelpAndExit,
  readReviewData,
  readVerificationData,
  selectTopFindings,
  validateEvidenceIndex,
  validateSourceManifest,
} = require('./_review-readiness-utils');

const USAGE = `Usage: node tools/cobolt-review-accuracy.js check [--dir <path>] [--json]

Commands:
  check    Run accuracy review on review artifacts and emit review-accuracy-report.json

Flags:
  --dir <path>  Review dir (default: _cobolt-output/latest/review)
  --json        Emit machine-readable JSON
  --help, -h    Show this help and exit
`;

function inspectVerificationConsistency(reviewDir) {
  const reviewData = readReviewData(reviewDir);
  const verification = readVerificationData(reviewDir);

  if (!reviewData) {
    return {
      pass: false,
      severity: 'high',
      detail: `${REVIEW_FILES.reviewFindings} missing or invalid JSON`,
      reviewData,
      verification,
    };
  }
  if (!verification) {
    return {
      pass: false,
      severity: 'high',
      detail: `${REVIEW_FILES.findingVerification} missing or invalid JSON`,
      reviewData,
      verification,
    };
  }

  const totalFindings = reviewData.findings.length;
  const resultCount = Array.isArray(verification.results) ? verification.results.length : 0;
  const phantomOnlyRejections =
    totalFindings === 0 &&
    Number(verification.stats?.rejected || 0) > 0 &&
    Number(verification.stats?.verified || 0) === 0 &&
    Number(verification.stats?.unverified || 0) === 0;
  if (totalFindings > 0 && resultCount === 0) {
    return {
      pass: false,
      severity: 'high',
      detail: `Verification has zero results for ${totalFindings} review findings`,
      reviewData,
      verification,
    };
  }

  const statsTotal = Number(verification.stats?.total || 0);
  if (statsTotal > 0 && resultCount > 0 && statsTotal !== resultCount) {
    return {
      pass: false,
      severity: 'high',
      detail: `Verification stats.total (${statsTotal}) does not match results length (${resultCount})`,
      reviewData,
      verification,
    };
  }

  if (totalFindings === 0) {
    if (phantomOnlyRejections) {
      return {
        pass: true,
        severity: 'low',
        detail: `Strict verification auto-stripped ${verification.stats.rejected} phantom finding(s); canonical findings are intentionally empty`,
        reviewData,
        verification,
      };
    }
    return {
      pass: false,
      severity: 'medium',
      detail: 'Review findings contain zero findings; review output is likely incomplete',
      reviewData,
      verification,
    };
  }

  return {
    pass: true,
    severity: 'low',
    detail: `${totalFindings} findings with ${resultCount} verification results`,
    reviewData,
    verification,
  };
}

function inspectFailuresSummary(reviewDir) {
  const summary = loadJson(path.join(reviewDir, REVIEW_FILES.failuresSummary));
  if (!summary) {
    return { pass: false, severity: 'high', detail: `${REVIEW_FILES.failuresSummary} missing or invalid JSON` };
  }

  const valid =
    Array.isArray(summary.gate_failures) &&
    Array.isArray(summary.reviewer_failures) &&
    Array.isArray(summary.blocking_findings) &&
    Array.isArray(summary.verification_failures);

  return {
    pass: valid,
    severity: valid ? 'low' : 'high',
    detail: valid
      ? `${summary.gate_failures.length} gate summaries and ${summary.blocking_findings.length} blocking findings captured`
      : `${REVIEW_FILES.failuresSummary} is missing one or more required arrays`,
    summary,
  };
}

function inspectReportCrossReferences(projectRoot, milestone, findings, options = {}) {
  const reportPath = findReviewReport(projectRoot, milestone);
  if (!reportPath) {
    return { pass: true, severity: 'low', detail: 'No registered review report found yet', reportPath: null };
  }

  const content = loadText(reportPath);
  const referencedIds = extractFindingIds(content);
  if (referencedIds.length === 0) {
    return { pass: true, severity: 'low', detail: 'Review report does not reference explicit finding IDs', reportPath };
  }

  const knownIds = new Set((findings || []).map((finding) => String(finding.id || '').trim()));
  const missingIds = referencedIds.filter((id) => !knownIds.has(id));
  const phantomOnlyRejections =
    options.phantomOnlyRejections === true && Array.isArray(findings) && findings.length === 0;

  if (phantomOnlyRejections && missingIds.length > 0) {
    return {
      pass: true,
      severity: 'low',
      detail: `Review report still references auto-stripped phantom finding IDs: ${missingIds.slice(0, 5).join(', ')}`,
      reportPath,
      missingIds,
      referencedIds,
    };
  }

  return {
    pass: missingIds.length === 0,
    severity: missingIds.length === 0 ? 'low' : 'high',
    detail:
      missingIds.length === 0
        ? `All ${referencedIds.length} report references resolve in review findings`
        : `Review report references unknown finding IDs: ${missingIds.slice(0, 5).join(', ')}`,
    reportPath,
    missingIds,
    referencedIds,
  };
}

function inspectCrossValidation(reviewDir) {
  const report = loadJson(path.join(reviewDir, REVIEW_FILES.crossValidation));
  if (!report) {
    return { pass: false, severity: 'medium', detail: `${REVIEW_FILES.crossValidation} missing or invalid JSON` };
  }

  return {
    pass: true,
    severity: 'low',
    detail: `Cross-validation recorded ${report.afterDedup || 0} deduped findings and phantom rate ${report.phantomRate || 0}`,
    report,
  };
}

function inspectReviewerCoverage(reviewDir, reviewData) {
  const coverage = countReviewerCoverage(reviewDir, reviewData);
  const pass = coverage.total >= 8;
  return {
    pass,
    severity: pass ? 'low' : 'medium',
    detail: `${coverage.total} reviewer categories recorded`,
    reviewers: coverage.reviewers,
  };
}

function buildAccuracyReport(reviewDir, options = {}) {
  const resolvedReviewDir = path.resolve(reviewDir || defaultReviewDir());
  const projectRoot = detectProjectRoot(resolvedReviewDir);
  const verificationCheck = inspectVerificationConsistency(resolvedReviewDir);
  const reviewData = verificationCheck.reviewData || readReviewData(resolvedReviewDir);
  const findings = listFindings(resolvedReviewDir);
  const milestone = detectMilestone(reviewData, projectRoot);
  const sourceManifest = validateSourceManifest(resolvedReviewDir);
  const evidence = validateEvidenceIndex(resolvedReviewDir);
  const failures = inspectFailuresSummary(resolvedReviewDir);
  const coverage = inspectReviewerCoverage(resolvedReviewDir, reviewData);
  const crossValidation = inspectCrossValidation(resolvedReviewDir);
  const phantomOnlyRejections =
    findings.length === 0 &&
    Number(verificationCheck.verification?.stats?.rejected || 0) > 0 &&
    Number(verificationCheck.verification?.stats?.verified || 0) === 0 &&
    Number(verificationCheck.verification?.stats?.unverified || 0) === 0;
  const reportCrossRefs = inspectReportCrossReferences(projectRoot, milestone, findings, { phantomOnlyRejections });
  const topBlocking = selectTopFindings(findings, {
    statuses: ['verified'],
    severities: ['critical', 'high'],
    limit: 5,
  });
  const locationCheck = inspectFindingLocations(topBlocking, projectRoot);

  const checks = [
    {
      id: 'A1',
      name: 'Source Manifest Integrity',
      pass: sourceManifest.pass,
      severity: 'high',
      detail: sourceManifest.detail,
    },
    {
      id: 'A2',
      name: 'Verification Consistency',
      pass: verificationCheck.pass,
      severity: verificationCheck.severity,
      detail: verificationCheck.detail,
    },
    {
      id: 'A3',
      name: 'Evidence Index Integrity',
      pass: evidence.pass,
      severity: 'high',
      detail: evidence.detail,
    },
    {
      id: 'A4',
      name: 'Failures Summary Integrity',
      pass: failures.pass,
      severity: failures.severity,
      detail: failures.detail,
    },
    {
      id: 'A5',
      name: 'Reviewer Coverage',
      pass: coverage.pass,
      severity: coverage.severity,
      detail: coverage.detail,
    },
    {
      id: 'A6',
      name: 'High-Priority Finding Re-Verification',
      pass: locationCheck.pass,
      severity: 'high',
      detail: locationCheck.detail,
    },
    {
      id: 'A7',
      name: 'Review Report Cross-References',
      pass: reportCrossRefs.pass,
      severity: reportCrossRefs.severity,
      detail: reportCrossRefs.detail,
    },
    {
      id: 'A8',
      name: 'Cross-Validation Artifact',
      pass: crossValidation.pass,
      severity: crossValidation.severity,
      detail: crossValidation.detail,
    },
  ];

  const failingChecks = checks.filter(
    (check) => !check.pass && (check.severity === 'critical' || check.severity === 'high'),
  );
  const warnings = checks.filter((check) => !check.pass && check.severity !== 'critical' && check.severity !== 'high');

  const report = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-review-accuracy',
    reviewDir: resolvedReviewDir,
    sourceRoot: projectRoot,
    milestone,
    passed: failingChecks.length === 0,
    checks,
    failingChecks: failingChecks.map((check) => check.id),
    warnings: warnings.map((check) => check.id),
    totals: {
      findingsReviewed: findings.length,
      blockingFindingsRechecked: topBlocking.length,
      failingChecks: failingChecks.length,
      warnings: warnings.length,
    },
  };

  if (options.write !== false) {
    fs.mkdirSync(resolvedReviewDir, { recursive: true });
    fs.writeFileSync(
      path.join(resolvedReviewDir, REVIEW_FILES.accuracyReport),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
  }

  return report;
}

function main() {
  const args = process.argv.slice(2);
  maybePrintHelpAndExit(args, USAGE);
  const command = args[0] || 'check';
  const dirIdx = args.indexOf('--dir');
  const reviewDir = dirIdx !== -1 && args[dirIdx + 1] ? args[dirIdx + 1] : defaultReviewDir();
  const jsonMode = args.includes('--json');

  if (command !== 'check' && command !== 'build') {
    console.log('CoBolt Review Accuracy');
    console.log('');
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }

  const report = buildAccuracyReport(reviewDir);
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('[cobolt-review-accuracy] Review Accuracy');
  console.log(`  Milestone: ${report.milestone || 'unknown'}`);
  console.log(`  Findings: ${report.totals.findingsReviewed}`);
  console.log(`  Status: ${report.passed ? 'passed' : 'failed'}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildAccuracyReport,
};
