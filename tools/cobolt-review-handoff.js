#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { buildAccuracyReport } = require('./cobolt-review-accuracy');
const { buildEvidenceIndex } = require('./cobolt-review-evidence-index');
const { buildGovernance } = require('./cobolt-review-governance');
const { buildReviewHandoffFidelity } = require('./cobolt-review-handoff-fidelity');
const { checkGate } = require('./cobolt-review-readiness-gate');
const {
  REVIEW_FILES,
  defaultReviewDir,
  detectMilestone,
  detectProjectRoot,
  detectSurfaceSignals,
  findReviewReport,
  listFindings,
  loadJson,
  maybePrintHelpAndExit,
  readCoboltState,
  summarizeFindingStatuses,
  validateSourceManifest,
} = require('./_review-readiness-utils');

const USAGE = `Usage: node tools/cobolt-review-handoff.js build [--dir <path>] [--json] [--build-pipeline]

Commands:
  build    Emit review-handoff.json + review-decision-log.md for downstream chaining

Flags:
  --dir <path>      Review dir (default: _cobolt-output/latest/review)
  --json            Emit machine-readable JSON
  --build-pipeline  Build-pipeline mode (chains to fix/validate)
  --help, -h        Show this help and exit
`;

// v0.20.8 — priority-matrix-aware disposition. Prefers the `priority` field set
// by `cobolt-review-tool-rollup` (which resolves it from finding-prefixes.md).
// Falls back to the pre-v0.20.8 severity-only rule when `priority` is absent so
// older review-findings.json files without rollup still work.
function determineDisposition(finding) {
  const status = String(finding.verification?.status || 'unverified').toLowerCase();
  const priority = String(finding.priority || '').toUpperCase();
  const severity = String(finding.severity || '').toLowerCase();

  if (status === 'rejected') return 'Reject-Phantom';

  // Priority-matrix path (v0.20.8): P0 is always Fix regardless of verification
  // status — a verified-or-unverified P0 (e.g., hardcoded prod secret, unwired
  // protected route) must never slip to Investigate/Backlog.
  if (priority === 'P0') return 'Fix';
  if (priority === 'P1') {
    if (status === 'verified') return 'Fix';
    return 'Investigate';
  }
  if (priority === 'P2') {
    if (status === 'verified') return 'Backlog';
    return 'Investigate';
  }
  if (priority === 'P3' || priority === 'P4') return 'Backlog';

  // Fallback (no priority field): pre-v0.20.8 rule.
  if (status !== 'verified') return 'Investigate';
  if (severity === 'critical' || severity === 'high') return 'Fix';
  return 'Backlog';
}

function buildDecisionLog(findings, handoff) {
  const lines = [
    '# Review Decision Log',
    '',
    `Generated: ${handoff.generatedAt}`,
    '',
    '| ID | Decision | Severity | Status | Rationale |',
    '| --- | --- | --- | --- | --- |',
  ];

  if (!handoff.reviewIntegrity.passed) {
    lines.push(
      '| REVIEW-GATE | Rerun | n/a | blocked | Review integrity gate failed; rerun review verification before chaining. |',
    );
  }

  for (const finding of findings) {
    const decision = determineDisposition(finding);
    const status = String(finding.verification?.status || 'unverified');
    const rationale =
      decision === 'Fix'
        ? 'Verified blocking finding that should enter the fix loop.'
        : decision === 'Reject-Phantom'
          ? 'Verifier rejected this finding as phantom or unsupported.'
          : decision === 'Investigate'
            ? 'Finding is not yet trustworthy enough for automated fixing.'
            : 'Verified non-blocking finding; track as backlog work.';

    lines.push(`| ${finding.id} | ${decision} | ${finding.severity} | ${status} | ${rationale} |`);
  }

  lines.push('');
  lines.push('## Recommended Next Step');
  lines.push('');
  lines.push(`- Skill: \`${handoff.recommendedNextStep.skill}\``);
  lines.push(`- Args: \`${handoff.recommendedNextStep.args}\``);
  lines.push(`- Reason: ${handoff.recommendedNextStep.rationale}`);
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function determineNextStep(handoff, milestone, options = {}) {
  const milestoneArgs = milestone ? `${milestone} ` : '';

  if (!handoff.reviewIntegrity.passed) {
    return {
      skill: 'cobolt-review',
      args: `${milestoneArgs}--autonomous${options.buildPipeline ? ' --build-pipeline' : ''}`.trim(),
      rationale: 'Review artifacts failed the integrity gate and should be regenerated before chaining.',
    };
  }

  if (options.buildPipeline) {
    return {
      skill: 'cobolt-fix',
      args: `${milestoneArgs}--autonomous --build-pipeline`.trim(),
      rationale:
        'Build-pipeline review must return through Step 06. cobolt-fix writes the no-findings sentinel when no fixes are required.',
    };
  }

  if ((handoff.findings.blocking || []).length > 0 && handoff.reviewGovernance?.pendingRiskAcceptances !== 0) {
    return {
      skill: 'cobolt-fix',
      args: `${milestoneArgs}--autonomous`.trim(),
      rationale:
        'Verified blocking review risks exist and have no active risk acceptance, so they must enter the fix loop before release-oriented validation.',
    };
  }

  if (handoff.surfaceSignals.hasExternalSurface) {
    return {
      skill: 'cobolt-pentest',
      args: milestone ? `${milestone} --autonomous` : '--autonomous',
      rationale: 'The project exposes an HTTP or UI surface, so pentest remains the next trust-building stage.',
    };
  }

  if (handoff.findings.blocking.length > 0) {
    return {
      skill: 'cobolt-fix',
      args: `${milestoneArgs}--autonomous`.trim(),
      rationale: 'Verified critical or high findings exist and should enter the fix loop now.',
    };
  }

  return {
    skill: 'cobolt-milestone-validate',
    args: milestone
      ? `${milestone} --mode milestone --autonomous --live-test`
      : '--mode milestone --autonomous --live-test',
    rationale: 'No verified blocking findings remain, so the pipeline can advance to milestone validation.',
  };
}

function normalizeExpertList(value) {
  const raw = Array.isArray(value) ? value : [];
  return [...new Set(raw.map((entry) => String(entry || '').trim()).filter(Boolean))];
}

function toProjectRelative(projectRoot, targetPath) {
  if (!targetPath) return null;
  const absoluteTarget = path.resolve(targetPath);
  const relative = path.relative(projectRoot, absoluteTarget);
  if (!relative || relative.startsWith('..')) {
    return absoluteTarget.replace(/\\/g, '/');
  }
  return relative.replace(/\\/g, '/');
}

function buildExpertGovernanceSnapshot(state) {
  const governance = state?.pipeline?.expertGovernance || {};
  const activeExperts = normalizeExpertList(governance.activeExperts);
  const fixedExpertSet = normalizeExpertList(governance.fixedExpertSet);
  if (activeExperts.length === 0 && fixedExpertSet.length === 0) {
    return null;
  }

  return {
    orchestrator: governance.orchestrator || 'review-lead',
    maxActiveExperts: Number.isFinite(Number(governance.maxActiveExperts))
      ? Math.max(1, Number(governance.maxActiveExperts))
      : null,
    activeExperts,
    fixedExpertSet,
    claimedAt: governance.claimedAt || null,
    updatedAt: governance.updatedAt || null,
  };
}

function buildDistillationRecord(projectRoot, reviewDir, handoff, reportPath) {
  return {
    summary: [
      `Review handoff distilled ${handoff.findings.total} findings`,
      `(${handoff.findings.blocking.length} blocking)`,
      `for ${handoff.milestone || 'codebase'}.`,
      `Next step: ${handoff.recommendedNextStep.skill} ${handoff.recommendedNextStep.args || ''}`.trim(),
    ].join(' '),
    artifactPaths: [
      toProjectRelative(projectRoot, path.join(reviewDir, REVIEW_FILES.reviewFindings)),
      toProjectRelative(projectRoot, path.join(reviewDir, REVIEW_FILES.handoff)),
      toProjectRelative(projectRoot, path.join(reviewDir, REVIEW_FILES.decisionLog)),
      toProjectRelative(projectRoot, reportPath),
    ].filter(Boolean),
    memoryTier: 'L1',
  };
}

function buildHandoff(reviewDir, options = {}) {
  const resolvedReviewDir = path.resolve(reviewDir || defaultReviewDir());
  const projectRoot = detectProjectRoot(resolvedReviewDir);
  buildEvidenceIndex(resolvedReviewDir);

  let accuracy = loadJson(path.join(resolvedReviewDir, REVIEW_FILES.accuracyReport));
  if (!accuracy) accuracy = buildAccuracyReport(resolvedReviewDir);
  const readiness = checkGate(resolvedReviewDir);
  const findings = listFindings(resolvedReviewDir);
  const summary = summarizeFindingStatuses(findings);
  const milestone = detectMilestone(loadJson(path.join(resolvedReviewDir, REVIEW_FILES.reviewFindings)), projectRoot);
  const state = readCoboltState(projectRoot) || {};
  const buildPipeline =
    options.buildPipeline === true ||
    String(state?.review?.buildPipeline || '').toLowerCase() === 'true' ||
    state?.build?.currentStep === '05-review';
  const sourceManifest = validateSourceManifest(resolvedReviewDir);
  const surfaceSignals = detectSurfaceSignals(projectRoot, resolvedReviewDir, sourceManifest.manifest);
  const reportPath = findReviewReport(projectRoot, milestone);
  // v0.20.8 — Blocking = any P0 OR (verified AND critical/high). The pre-v0.20.8
  // rule is preserved as a fallback for findings that carry no priority field.
  const blocking = findings.filter((finding) => {
    const priority = String(finding.priority || '').toUpperCase();
    if (priority === 'P0') return true;
    const status = String(finding.verification?.status || '').toLowerCase();
    const severity = String(finding.severity || '').toLowerCase();
    if (status === 'verified' && (severity === 'critical' || severity === 'high')) return true;
    return false;
  });
  const rejected = findings.filter(
    (finding) => String(finding.verification?.status || '').toLowerCase() === 'rejected',
  );
  const backlog = findings.filter((finding) => determineDisposition(finding) === 'Backlog');
  const investigate = findings.filter((finding) => determineDisposition(finding) === 'Investigate');
  const governance = buildGovernance(resolvedReviewDir, { buildPipeline, readiness, accuracy });
  const fidelity = buildReviewHandoffFidelity(resolvedReviewDir, {
    projectRoot,
    milestone,
    readiness,
    reviewData: loadJson(path.join(resolvedReviewDir, REVIEW_FILES.reviewFindings)),
  });

  const handoff = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-review-handoff',
    reviewDir: resolvedReviewDir,
    sourceRoot: projectRoot,
    milestone,
    mode: buildPipeline ? 'build-pipeline' : 'pipeline',
    buildPipeline,
    reviewIntegrity: {
      passed: readiness.passed,
      failingChecks: readiness.failingChecks,
      hallucinationRate: readiness.context?.hallucinationRate || 0,
      accuracyPassed: accuracy?.passed !== false,
      evidenceIndexPresent: fs.existsSync(path.join(resolvedReviewDir, REVIEW_FILES.evidenceIndex)),
    },
    findings: {
      total: summary.total,
      verified: summary.verified,
      unverified: summary.unverified,
      rejected: summary.rejected,
      bySeverity: summary.bySeverity,
      blocking: blocking.map((finding) => finding.id),
      rejectedPhantoms: rejected.map((finding) => finding.id),
      backlog: backlog.map((finding) => finding.id),
      investigate: investigate.map((finding) => finding.id),
    },
    surfaceSignals,
    reviewGovernance: {
      releaseBlocked: governance.artifacts.releaseGate.blocked,
      releaseRecommendation: governance.artifacts.releaseGate.recommendation,
      blockingRisks: governance.summary.blockingRisks,
      pendingRiskAcceptances: governance.summary.pendingRiskAcceptances,
      missingReviewers: governance.summary.missingReviewers,
      criticalUncoveredSurfaces: governance.summary.criticalUncoveredSurfaces,
      authzReplayPassed: governance.summary.authzReplayPassed,
    },
    reviewHandoffFidelity: {
      status: fidelity.fidelity.status,
      enhancementCount: fidelity.fidelity.qualitySummary.enhancementCount,
      failDetectors: fidelity.fidelity.qualitySummary.detectors.fail,
      advisoryDetectors: fidelity.fidelity.qualitySummary.detectors.advisory,
      fixHandoffReady: fidelity.fidelity.fixHandoffCompleteness.ready,
    },
    inputReferences: {
      reviewFindings: path.join(resolvedReviewDir, REVIEW_FILES.reviewFindings),
      findingVerification: path.join(resolvedReviewDir, REVIEW_FILES.findingVerification),
      failuresSummary: path.join(resolvedReviewDir, REVIEW_FILES.failuresSummary),
      evidenceIndex: path.join(resolvedReviewDir, REVIEW_FILES.evidenceIndex),
      accuracyReport: path.join(resolvedReviewDir, REVIEW_FILES.accuracyReport),
      readinessGate: path.join(resolvedReviewDir, REVIEW_FILES.readinessGate),
      riskRegister: path.join(resolvedReviewDir, REVIEW_FILES.riskRegister),
      riskAcceptance: path.join(resolvedReviewDir, REVIEW_FILES.riskAcceptance),
      reviewerProfilePolicy: path.join(resolvedReviewDir, REVIEW_FILES.reviewerProfilePolicy),
      coverageMatrix: path.join(resolvedReviewDir, REVIEW_FILES.coverageMatrix),
      releaseGate: path.join(resolvedReviewDir, REVIEW_FILES.releaseGate),
      challengeBacklog: path.join(resolvedReviewDir, REVIEW_FILES.challengeBacklog),
      authzReplayGate: path.join(resolvedReviewDir, REVIEW_FILES.authzReplayGate),
      handoffFidelity: fidelity.outputPath,
      report: reportPath,
    },
  };

  handoff.recommendedNextStep = determineNextStep(handoff, milestone, { buildPipeline });
  const expertGovernance = buildExpertGovernanceSnapshot(state);
  if (expertGovernance) {
    handoff.expertGovernance = expertGovernance;
  }
  handoff.distillation = buildDistillationRecord(projectRoot, resolvedReviewDir, handoff, reportPath);

  fs.mkdirSync(resolvedReviewDir, { recursive: true });
  fs.writeFileSync(path.join(resolvedReviewDir, REVIEW_FILES.handoff), `${JSON.stringify(handoff, null, 2)}\n`, 'utf8');
  if (milestone) {
    fs.writeFileSync(
      path.join(resolvedReviewDir, `${milestone}-review-handoff.json`),
      `${JSON.stringify(handoff, null, 2)}\n`,
      'utf8',
    );
  }
  fs.writeFileSync(path.join(resolvedReviewDir, REVIEW_FILES.decisionLog), buildDecisionLog(findings, handoff), 'utf8');
  buildEvidenceIndex(resolvedReviewDir);
  return handoff;
}

function main() {
  const args = process.argv.slice(2);
  maybePrintHelpAndExit(args, USAGE);
  const command = args[0] || 'build';
  const dirIdx = args.indexOf('--dir');
  const reviewDir = dirIdx !== -1 && args[dirIdx + 1] ? args[dirIdx + 1] : defaultReviewDir();
  const jsonMode = args.includes('--json');
  const buildPipeline = args.includes('--build-pipeline');

  if (command !== 'build') {
    console.log('CoBolt Review Handoff');
    console.log('');
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }

  const handoff = buildHandoff(reviewDir, { buildPipeline });
  if (jsonMode) {
    console.log(JSON.stringify(handoff, null, 2));
    return;
  }

  console.log('[cobolt-review-handoff] Review Handoff');
  console.log(`  Milestone: ${handoff.milestone || 'unknown'}`);
  console.log(`  Next skill: ${handoff.recommendedNextStep.skill}`);
  console.log(`  Next args: ${handoff.recommendedNextStep.args}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildHandoff,
  determineDisposition,
  determineNextStep,
};
