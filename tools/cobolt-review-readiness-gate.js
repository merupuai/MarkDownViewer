#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { CORE_PREFIXES, baselinePrefixesForMode, toReviewerPrefix } = require('../lib/cobolt-reviewer-registry');
const { buildAccuracyReport } = require('./cobolt-review-accuracy');
const { buildEvidenceIndex } = require('./cobolt-review-evidence-index');
const { buildReviewHandoffFidelity } = require('./cobolt-review-handoff-fidelity');
const {
  REVIEW_FILES,
  defaultReviewDir,
  detectMilestone,
  detectProjectRoot,
  loadJson,
  maybePrintHelpAndExit,
  readReviewData,
  readVerificationData,
  validateEvidenceIndex,
  validateSourceManifest,
} = require('./_review-readiness-utils');

const USAGE = `Usage: node tools/cobolt-review-readiness-gate.js check [--dir <path>] [--json] [--allow-high-hallucination]

Commands:
  check    Run readiness gate against review artifacts and emit review-readiness-gate.json

Flags:
  --dir <path>                Review dir (default: _cobolt-output/latest/review)
  --json                      Emit machine-readable JSON
  --allow-high-hallucination  Bypass the hallucination-rate ceiling (advisory)
  --help, -h                  Show this help and exit
`;

const HALLUCINATION_THRESHOLD = 20;

function collectPrefixes(reviewDir, reviewData) {
  const manifest = loadJson(path.join(reviewDir, REVIEW_FILES.manifest));
  const prefixes = new Set(
    Object.keys(reviewData?.summary?.byPrefix || {})
      .map((prefix) => toReviewerPrefix(prefix))
      .filter(Boolean),
  );

  for (const reviewer of manifest?.completed || []) {
    const prefix = toReviewerPrefix(reviewer);
    if (prefix) prefixes.add(prefix);
  }

  for (const reviewer of reviewData?.reviewers || []) {
    const prefix = toReviewerPrefix(reviewer);
    if (prefix) prefixes.add(prefix);
  }

  for (const finding of reviewData?.findings || []) {
    const prefix = toReviewerPrefix(finding.prefix || finding.id);
    if (prefix) prefixes.add(prefix);
  }

  return prefixes;
}

function normalizeFailureEntries(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.failures)) return payload.failures;
  if (Array.isArray(payload.reviewerFailures)) return payload.reviewerFailures;
  if (Array.isArray(payload.reviewer_failures)) return payload.reviewer_failures;
  if (Array.isArray(payload.failed)) return payload.failed;
  return [];
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { malformed: true, raw: line };
        }
      });
  } catch {
    return [];
  }
}

function failureIsResolved(entry) {
  const verdict = String(entry.verdict || entry.status || entry.outcome || '').toLowerCase();
  return ['pass', 'passed', 'resolved', 'recovered', 'completed', 'success'].includes(verdict);
}

function failureHasLeadEscalation(entry) {
  const target = String(
    entry.escalationTarget || entry.escalation_target || entry.escalatedTo || entry.escalated_to || '',
  ).toLowerCase();
  const hasAgent = Boolean(entry.agent || entry.reviewer || entry.reviewerAgent || entry.reviewer_agent);
  const hasErrorContext = Boolean(
    entry.error || entry.message || entry.stderr || entry.stdout || entry.stack || entry.raw || entry.errorPayload,
  );
  return hasAgent && hasErrorContext && target.includes('review-lead');
}

function advisorRequirementMissing(entry) {
  const needsAdvisor =
    entry.requiresAdvisor === true ||
    entry.advisorRequired === true ||
    /advisor/u.test(String(entry.escalationTarget || entry.escalation_target || '').toLowerCase());
  if (!needsAdvisor) return false;
  return !(entry.advisorAgent || entry.advisorResolution || entry.advisorForwardedAt || entry.advisor_forwarded_at);
}

function collectReviewerFailureIssues(projectRoot, reviewDir) {
  const reviewFailures = normalizeFailureEntries(loadJson(path.join(reviewDir, 'reviewer-failures.json')));
  const summaryFailures = normalizeFailureEntries(loadJson(path.join(reviewDir, REVIEW_FILES.failuresSummary)));
  const auditFailures = readJsonl(path.join(projectRoot, '_cobolt-output', 'audit', 'reviewer-failures.jsonl'));
  const failures = [...reviewFailures, ...summaryFailures, ...auditFailures];
  const unresolved = [];

  for (const entry of failures) {
    if (failureIsResolved(entry)) continue;
    if (failureHasLeadEscalation(entry) && !advisorRequirementMissing(entry)) continue;
    const reviewer = entry.agent || entry.reviewer || entry.reviewerAgent || entry.reviewer_agent || 'unknown-reviewer';
    const reason = advisorRequirementMissing(entry)
      ? 'advisor escalation required but not recorded'
      : 'missing review-lead escalation with full error context';
    unresolved.push(`${reviewer}: ${reason}`);
  }

  return {
    total: failures.length,
    unresolved,
    pass: unresolved.length === 0,
  };
}

function checkGate(reviewDir, options = {}) {
  const resolvedReviewDir = path.resolve(reviewDir || defaultReviewDir());
  const projectRoot = detectProjectRoot(resolvedReviewDir);
  const reviewData = readReviewData(resolvedReviewDir);
  const milestone = detectMilestone(reviewData, projectRoot);
  const verification = readVerificationData(resolvedReviewDir);
  let evidence = validateEvidenceIndex(resolvedReviewDir);
  if (!evidence.pass) {
    buildEvidenceIndex(resolvedReviewDir);
    evidence = validateEvidenceIndex(resolvedReviewDir);
  }

  let accuracy = loadJson(path.join(resolvedReviewDir, REVIEW_FILES.accuracyReport));
  if (!accuracy) {
    accuracy = buildAccuracyReport(resolvedReviewDir);
    buildEvidenceIndex(resolvedReviewDir);
    evidence = validateEvidenceIndex(resolvedReviewDir);
  }

  const sourceManifest = validateSourceManifest(resolvedReviewDir);
  const prefixes = collectPrefixes(resolvedReviewDir, reviewData);
  const coreCovered = CORE_PREFIXES.filter((prefix) => prefixes.has(prefix));
  const requiredPrefixes = baselinePrefixesForMode({ milestone });
  const missingRequiredPrefixes = requiredPrefixes.filter((prefix) => !prefixes.has(prefix));
  const reviewerFailures = collectReviewerFailureIssues(projectRoot, resolvedReviewDir);
  const hallucinationRate =
    verification?.hallucination?.estimatedRate != null
      ? Number(verification.hallucination.estimatedRate)
      : verification?.stats?.total > 0
        ? Math.round(
            (((verification.stats.rejected || 0) + (verification.stats.unverified || 0)) / verification.stats.total) *
              100,
          )
        : Number(reviewData?.verification?.estimatedHallucinationRate || 0);
  const rejectedFindings = Number(verification?.stats?.rejected || 0);
  const survivingFindings = Array.isArray(reviewData?.findings) ? reviewData.findings.length : 0;
  const phantomOnlyRejections =
    rejectedFindings > 0 &&
    survivingFindings === 0 &&
    Number(verification?.stats?.verified || 0) === 0 &&
    Number(verification?.stats?.unverified || 0) === 0;
  const strictVerificationFailed =
    !options.allowHighHallucination &&
    verification?.config?.strict !== false &&
    rejectedFindings > 0 &&
    !phantomOnlyRejections;

  const checks = [
    {
      id: 'G1',
      name: 'Review Findings Artifact',
      pass: !!reviewData && !!verification,
      severity: 'high',
      detail:
        reviewData && verification
          ? `${reviewData.findings.length} findings with verification artifact present`
          : `${REVIEW_FILES.reviewFindings} or ${REVIEW_FILES.findingVerification} is missing`,
    },
    {
      id: 'G2',
      name: 'Source Manifest Integrity',
      pass: sourceManifest.pass,
      severity: 'high',
      detail: sourceManifest.detail,
    },
    {
      id: 'G3',
      name: 'Evidence Index Integrity',
      pass: evidence.pass,
      severity: 'high',
      detail: evidence.detail,
    },
    {
      id: 'G4',
      name: 'Accuracy Report',
      pass: !!accuracy && accuracy.passed !== false,
      severity: 'high',
      detail: accuracy ? `status=${accuracy.passed === false ? 'failed' : 'passed'}` : 'accuracy report missing',
    },
    {
      id: 'G5',
      name: 'Reviewer Coverage',
      pass: missingRequiredPrefixes.length === 0,
      severity: 'high',
      detail:
        missingRequiredPrefixes.length === 0
          ? `${prefixes.size}/${requiredPrefixes.length} required prefixes recorded`
          : `Missing required reviewer prefixes: ${missingRequiredPrefixes.join(', ')}`,
    },
    {
      id: 'G6',
      name: 'Hallucination Threshold',
      pass: options.allowHighHallucination
        ? true
        : (phantomOnlyRejections || hallucinationRate < HALLUCINATION_THRESHOLD) && !strictVerificationFailed,
      severity: 'high',
      detail: options.allowHighHallucination
        ? `Estimated hallucination rate ${hallucinationRate}% (override enabled)`
        : phantomOnlyRejections
          ? `Strict verification rejected ${rejectedFindings} phantom finding(s); canonical findings were auto-stripped`
          : strictVerificationFailed
            ? `Strict verification rejected ${rejectedFindings} finding(s)`
            : hallucinationRate < HALLUCINATION_THRESHOLD
              ? `Estimated hallucination rate ${hallucinationRate}%`
              : `Estimated hallucination rate ${hallucinationRate}% exceeds the ${HALLUCINATION_THRESHOLD}% threshold`,
    },
    {
      id: 'G7',
      name: 'Failures Summary',
      pass: fs.existsSync(path.join(resolvedReviewDir, REVIEW_FILES.failuresSummary)),
      severity: 'medium',
      detail: fs.existsSync(path.join(resolvedReviewDir, REVIEW_FILES.failuresSummary))
        ? `${REVIEW_FILES.failuresSummary} present`
        : `${REVIEW_FILES.failuresSummary} missing`,
    },
    {
      id: 'G8',
      name: 'Cross-Validation Artifact',
      pass: fs.existsSync(path.join(resolvedReviewDir, REVIEW_FILES.crossValidation)),
      severity: 'medium',
      detail: fs.existsSync(path.join(resolvedReviewDir, REVIEW_FILES.crossValidation))
        ? `${REVIEW_FILES.crossValidation} present`
        : `${REVIEW_FILES.crossValidation} missing`,
    },
    {
      id: 'G9',
      name: 'Reviewer Failure Escalation',
      pass: reviewerFailures.pass,
      severity: 'high',
      detail: reviewerFailures.pass
        ? `${reviewerFailures.total} reviewer failure record(s) resolved or escalated`
        : reviewerFailures.unresolved.join('; '),
    },
  ];

  const provisionalResult = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-review-readiness-gate',
    reviewDir: resolvedReviewDir,
    sourceRoot: projectRoot,
    milestone,
    passed: null,
    checks,
    failingChecks: [],
    context: {
      hallucinationRate,
      rejectedFindings,
      phantomOnlyRejections,
      reviewerPrefixes: [...prefixes].sort(),
      corePrefixes: coreCovered,
      requiredReviewerPrefixes: requiredPrefixes,
      missingReviewerPrefixes: missingRequiredPrefixes,
      reviewerFailures: {
        total: reviewerFailures.total,
        unresolved: reviewerFailures.unresolved,
      },
    },
  };

  const fidelity = buildReviewHandoffFidelity(resolvedReviewDir, {
    projectRoot,
    milestone,
    readiness: provisionalResult,
    reviewData,
  });

  checks.push({
    id: 'G10',
    name: 'Review Handoff Fidelity',
    pass: fidelity.fidelity.status !== 'fail',
    severity: 'high',
    detail:
      fidelity.fidelity.status === 'fail'
        ? `review-handoff-fidelity failed with ${fidelity.fidelity.qualitySummary.detectors.fail} failing detector(s)`
        : `review-handoff-fidelity status=${fidelity.fidelity.status}; enhancements=${fidelity.fidelity.qualitySummary.enhancementCount}`,
  });

  const failingChecks = checks.filter(
    (check) => !check.pass && (check.severity === 'critical' || check.severity === 'high'),
  );

  const result = {
    ...provisionalResult,
    passed: failingChecks.length === 0,
    checks,
    failingChecks: failingChecks.map((check) => check.id),
    context: {
      ...provisionalResult.context,
      reviewFidelity: {
        status: fidelity.fidelity.status,
        enhancementCount: fidelity.fidelity.qualitySummary.enhancementCount,
        failDetectors: fidelity.fidelity.qualitySummary.detectors.fail,
        advisoryDetectors: fidelity.fidelity.qualitySummary.detectors.advisory,
      },
    },
  };

  fs.mkdirSync(resolvedReviewDir, { recursive: true });
  fs.writeFileSync(
    path.join(resolvedReviewDir, REVIEW_FILES.readinessGate),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
  return result;
}

function main() {
  const args = process.argv.slice(2);
  maybePrintHelpAndExit(args, USAGE);
  const command = args[0] || 'check';
  const dirIdx = args.indexOf('--dir');
  const reviewDir = dirIdx !== -1 && args[dirIdx + 1] ? args[dirIdx + 1] : defaultReviewDir();
  const jsonMode = args.includes('--json');
  const allowHighHallucination = args.includes('--allow-high-hallucination');

  if (command !== 'check') {
    console.log('CoBolt Review Readiness Gate');
    console.log('');
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }

  const result = checkGate(reviewDir, { allowHighHallucination });
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('[cobolt-review-readiness-gate] Review Readiness');
  console.log(`  Milestone: ${result.milestone || 'unknown'}`);
  console.log(`  Verdict: ${result.passed ? 'PASS' : 'FAIL'}`);
  console.log(`  Hallucination rate: ${result.context.hallucinationRate}%`);
}

if (require.main === module) {
  main();
}

module.exports = {
  checkGate,
  _testOnly: {
    collectReviewerFailureIssues,
    normalizeFailureEntries,
  },
};
