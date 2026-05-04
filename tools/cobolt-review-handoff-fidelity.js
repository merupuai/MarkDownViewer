#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { isAgentFailureReviewStale } = require('./cobolt-agent-failure-review');
const {
  REVIEW_FILES,
  defaultReviewDir,
  detectMilestone,
  detectProjectRoot,
  loadJson,
  maybePrintHelpAndExit,
} = require('./_review-readiness-utils');

const USAGE = `Usage: node tools/cobolt-review-handoff-fidelity.js build [--dir <path>] [--json]

Commands:
  build    Aggregate build->review continuity, reviewer coverage, line-anchor drift, and escalation
           context into review-handoff-fidelity.json + .md

Flags:
  --dir <path>  Review dir (default: _cobolt-output/latest/review)
  --json        Emit machine-readable JSON
  --help, -h    Show this help and exit

Exit codes:
  0  fidelity computed (status may still be advisory)
  1  hard error (e.g. review-lead envelope reports findings but missing metadata.findings[])
`;

function normalizeRelative(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeText(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, payload, 'utf8');
}

function findFirstExisting(filePaths) {
  for (const filePath of filePaths) {
    if (filePath && fs.existsSync(filePath)) return filePath;
  }
  return null;
}

function findReviewPacket(reviewDir, reviewId, milestone) {
  const explicit = [reviewId, milestone]
    .filter(Boolean)
    .map((value) => path.join(reviewDir, `${value}-review-packet.json`));
  const existing = findFirstExisting(explicit);
  if (existing) return existing;

  try {
    const match = fs
      .readdirSync(reviewDir)
      .find((entry) => entry.endsWith('-review-packet.json') && !entry.startsWith('review-handoff-fidelity'));
    return match ? path.join(reviewDir, match) : null;
  } catch {
    return null;
  }
}

function findCoverageVerdict(reviewDir, milestone) {
  const explicit = milestone ? path.join(reviewDir, `${milestone}-coverage-verdict.json`) : null;
  const existing = findFirstExisting([explicit]);
  if (existing) return existing;

  try {
    const match = fs.readdirSync(reviewDir).find((entry) => entry.endsWith('-coverage-verdict.json'));
    return match ? path.join(reviewDir, match) : null;
  } catch {
    return null;
  }
}

function loadBuildPacketFidelity(projectRoot, milestone) {
  if (!projectRoot || !milestone) return null;
  const filePath = path.join(
    projectRoot,
    '_cobolt-output',
    'latest',
    'build',
    milestone,
    `${milestone}-build-packet-fidelity.json`,
  );
  const payload = loadJson(filePath);
  return payload ? { path: filePath, payload } : null;
}

// Inspect _cobolt-output/agent-messages.json for the most recent envelope sent
// by cobolt-review-lead. Per the metadata.findings[] mandate, when the lead
// reports totalFindings > 0 it MUST also embed the findings array in
// metadata.findings — otherwise downstream stages have a phantom count with no
// data to act on.
function inspectReviewLeadFindingsEnvelope(projectRoot) {
  if (!projectRoot) return { applicable: false };
  const filePath = path.join(projectRoot, '_cobolt-output', 'agent-messages.json');
  const payload = loadJson(filePath);
  if (!payload) return { applicable: false, path: filePath };
  const envelopes = Array.isArray(payload) ? payload : Array.isArray(payload.messages) ? payload.messages : [];
  if (envelopes.length === 0) return { applicable: false, path: filePath };

  const reviewLeadEnvelopes = envelopes.filter((env) => {
    const from = String(env?.from || '').toLowerCase();
    return from === 'cobolt-review-lead' || from === 'review-lead';
  });
  if (reviewLeadEnvelopes.length === 0) return { applicable: false, path: filePath };

  const sortByTs = (a, b) => {
    const aTs = Date.parse(a?.timestamp || a?.ts || '') || 0;
    const bTs = Date.parse(b?.timestamp || b?.ts || '') || 0;
    return bTs - aTs;
  };
  const latest = [...reviewLeadEnvelopes].sort(sortByTs)[0];
  const metadata = latest?.metadata || {};
  const totalFindings = Number(metadata.totalFindings ?? metadata.findingsCount ?? 0) || 0;
  const findingsArray = Array.isArray(metadata.findings) ? metadata.findings : null;
  const arrayLen = findingsArray ? findingsArray.length : 0;

  // Violation: totalFindings > 0 but metadata.findings missing or empty.
  if (totalFindings > 0 && (!findingsArray || arrayLen === 0)) {
    return {
      applicable: true,
      path: filePath,
      totalFindings,
      arrayLen,
      hasArray: Array.isArray(findingsArray),
      violation: {
        kind: 'missing-findings-array',
        severity: 'critical',
        detail: `review-lead envelope reports metadata.totalFindings=${totalFindings} but metadata.findings is ${
          findingsArray ? 'an empty array' : 'missing'
        }`,
      },
    };
  }
  return {
    applicable: true,
    path: filePath,
    totalFindings,
    arrayLen,
    hasArray: Array.isArray(findingsArray),
  };
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
    unresolved.push({
      reviewer,
      reason,
      entry,
    });
  }

  return {
    total: failures.length,
    unresolved,
  };
}

function summarizeLineAnchors(lineAnchorVerdict) {
  if (!lineAnchorVerdict) {
    return {
      status: 'pending',
      total: 0,
      verified: 0,
      drifted: 0,
      missing: 0,
      detail: 'line-anchor-verdict.json has not been generated yet',
    };
  }

  const summary = lineAnchorVerdict.summary || {};
  if (Number(summary.missing || 0) > 0) {
    return {
      status: 'advisory',
      total: Number(summary.total || 0),
      verified: Number(summary.verified || 0),
      drifted: Number(summary.drifted || 0),
      missing: Number(summary.missing || 0),
      detail: `${summary.missing} finding anchor(s) are missing or fabricated`,
    };
  }
  if (Number(summary.drifted || 0) > 0) {
    return {
      status: 'advisory',
      total: Number(summary.total || 0),
      verified: Number(summary.verified || 0),
      drifted: Number(summary.drifted || 0),
      missing: Number(summary.missing || 0),
      detail: `${summary.drifted} finding anchor(s) drifted and require corrected line hints`,
    };
  }
  return {
    status: 'pass',
    total: Number(summary.total || 0),
    verified: Number(summary.verified || 0),
    drifted: Number(summary.drifted || 0),
    missing: Number(summary.missing || 0),
    detail: `${summary.verified || 0} finding anchor(s) verified`,
  };
}

function detector(id, type, status, severity, detail, sourceArtifact) {
  return {
    id,
    type,
    status,
    severity,
    detail,
    sourceArtifact: sourceArtifact ? normalizeRelative(sourceArtifact) : null,
    advisoryProceed: status === 'advisory' || status === 'pending',
  };
}

function enhancement(id, title, detail, sourceArtifact, escalationTarget = 'review-lead') {
  return {
    id,
    title,
    detail,
    sourceArtifact: sourceArtifact ? normalizeRelative(sourceArtifact) : null,
    escalationTarget,
  };
}

function buildReviewHandoffFidelity(reviewDir, options = {}) {
  const resolvedReviewDir = path.resolve(reviewDir || defaultReviewDir(options.projectRoot));
  const projectRoot = path.resolve(options.projectRoot || detectProjectRoot(resolvedReviewDir));
  const reviewFindings =
    options.reviewData || loadJson(path.join(resolvedReviewDir, REVIEW_FILES.reviewFindings)) || {};
  const milestone = options.milestone || detectMilestone(reviewFindings, projectRoot);
  const reviewId = options.reviewId || reviewFindings.reviewId || reviewFindings.milestone || milestone || 'codebase';
  const reviewPacketPath = findReviewPacket(resolvedReviewDir, reviewId, milestone);
  const reviewPacket = options.reviewPacket || (reviewPacketPath ? loadJson(reviewPacketPath) : null);
  const coverageVerdictPath = findCoverageVerdict(resolvedReviewDir, milestone);
  const coverageVerdict = coverageVerdictPath ? loadJson(coverageVerdictPath) : null;
  const readinessPath = path.join(resolvedReviewDir, REVIEW_FILES.readinessGate);
  const readiness = options.readiness || loadJson(readinessPath);
  const reviewManifestPath = path.join(resolvedReviewDir, REVIEW_FILES.manifest);
  const reviewManifest = loadJson(reviewManifestPath);
  const sourceManifestPath = path.join(resolvedReviewDir, REVIEW_FILES.sourceManifest);
  const sourceManifest = loadJson(sourceManifestPath);
  const lineAnchorPath = path.join(resolvedReviewDir, 'line-anchor-verdict.json');
  const lineAnchorVerdict = loadJson(lineAnchorPath);
  const buildPacketFidelity = loadBuildPacketFidelity(projectRoot, milestone);
  const agentFailureReviewPath = path.join(
    projectRoot,
    '_cobolt-output',
    'latest',
    'production-readiness',
    'agent-failure-review.json',
  );
  const reviewLeadPacketPath = path.join(
    projectRoot,
    '_cobolt-output',
    'latest',
    'production-readiness',
    'review-lead-escalation-packet.json',
  );
  const agentFailureReview = loadJson(agentFailureReviewPath);
  const reviewLeadPacket = loadJson(reviewLeadPacketPath);
  const agentFailureFreshness = agentFailureReview ? isAgentFailureReviewStale(agentFailureReview, projectRoot) : null;
  const reviewerFailures = collectReviewerFailureIssues(projectRoot, resolvedReviewDir);
  const reviewLeadEnvelope = inspectReviewLeadFindingsEnvelope(projectRoot);

  const detectors = [];
  const enhancementQueue = [];

  // Mandatory metadata.findings[] enforcement: if the review-lead envelope
  // reports totalFindings > 0 but no findings array, this is a critical
  // fidelity violation — downstream consumers cannot work from a phantom count.
  if (reviewLeadEnvelope.applicable && reviewLeadEnvelope.violation) {
    detectors.push(
      detector(
        'review-lead-findings-array',
        'review-lead-findings-array',
        'fail',
        reviewLeadEnvelope.violation.severity,
        reviewLeadEnvelope.violation.detail,
        reviewLeadEnvelope.path,
      ),
    );
    enhancementQueue.push(
      enhancement(
        'enh-review-lead-findings-array',
        'Embed metadata.findings[] in review-lead envelope',
        reviewLeadEnvelope.violation.detail,
        reviewLeadEnvelope.path,
      ),
    );
  } else if (reviewLeadEnvelope.applicable) {
    detectors.push(
      detector(
        'review-lead-findings-array',
        'review-lead-findings-array',
        'pass',
        'info',
        `review-lead envelope embeds metadata.findings (${reviewLeadEnvelope.arrayLen} of ${reviewLeadEnvelope.totalFindings})`,
        reviewLeadEnvelope.path,
      ),
    );
  }

  const structuralIssues = [];
  if (!reviewManifest) structuralIssues.push('review manifest missing');
  if (!sourceManifest) structuralIssues.push('source manifest missing');
  if (!Array.isArray(reviewFindings.findings)) structuralIssues.push('review findings missing');

  if (structuralIssues.length > 0) {
    detectors.push(
      detector(
        'review-structural-contract',
        'review-structural-contract',
        'fail',
        'critical',
        structuralIssues.join('; '),
        reviewPacketPath || reviewManifestPath,
      ),
    );
  } else {
    detectors.push(
      detector(
        'review-structural-contract',
        'review-structural-contract',
        'pass',
        'info',
        'Core review packet, source manifest, review manifest, and findings are present',
        reviewPacketPath,
      ),
    );
  }

  if (!reviewPacketPath || !reviewPacket) {
    detectors.push(
      detector(
        'review-packet-presence',
        'review-packet-presence',
        'pending',
        'medium',
        'review packet is missing; fidelity is deriving continuity from direct review artifacts instead',
        reviewPacketPath || reviewManifestPath,
      ),
    );
    enhancementQueue.push(
      enhancement(
        'enh-review-packet-presence',
        'Materialize review packet before downstream chaining',
        'Review can continue, but the review packet should be written so downstream stages inherit a stable handoff bundle.',
        reviewPacketPath || reviewManifestPath,
      ),
    );
  } else {
    detectors.push(
      detector(
        'review-packet-presence',
        'review-packet-presence',
        'pass',
        'info',
        'Review packet is present for downstream handoff',
        reviewPacketPath,
      ),
    );
  }

  if (readiness?.passed === false) {
    detectors.push(
      detector(
        'review-readiness-continuity',
        'review-readiness-continuity',
        'fail',
        'high',
        `Review readiness gate failed: ${(readiness.failingChecks || []).join(', ') || 'unknown failing check'}`,
        readinessPath,
      ),
    );
  } else if (readiness) {
    detectors.push(
      detector(
        'review-readiness-continuity',
        'review-readiness-continuity',
        'pass',
        'info',
        'Review readiness gate passed',
        readinessPath,
      ),
    );
  } else {
    detectors.push(
      detector(
        'review-readiness-continuity',
        'review-readiness-continuity',
        'pending',
        'medium',
        'review-readiness-gate.json has not been generated yet',
        readinessPath,
      ),
    );
  }

  if (buildPacketFidelity?.payload) {
    const payload = buildPacketFidelity.payload;
    const missingStories = Array.isArray(payload.missingStories) ? payload.missingStories.length : 0;
    const missingManifestFields = Array.isArray(payload.missingManifestFields)
      ? payload.missingManifestFields.length
      : 0;
    const missingPacketSignals = Array.isArray(payload.missingPacketSignals) ? payload.missingPacketSignals.length : 0;
    const detail = `valid=${payload.valid !== false}; missingStories=${missingStories}; missingManifestFields=${missingManifestFields}; missingPacketSignals=${missingPacketSignals}`;
    const status =
      payload.valid === false || missingStories > 0 || missingManifestFields > 0 || missingPacketSignals > 0
        ? 'advisory'
        : 'pass';
    detectors.push(
      detector(
        'build-review-continuity',
        'build-review-continuity',
        status,
        status === 'pass' ? 'info' : 'medium',
        detail,
        buildPacketFidelity.path,
      ),
    );
    if (status !== 'pass') {
      enhancementQueue.push(
        enhancement(
          'enh-build-review-continuity',
          'Repair build to review fidelity',
          'Review is continuing with a degraded build packet; restore missing stories, manifest fields, or packet signals.',
          buildPacketFidelity.path,
        ),
      );
    }
  } else {
    detectors.push(
      detector(
        'build-review-continuity',
        'build-review-continuity',
        reviewPacket?.buildArtifacts ? 'advisory' : 'not-applicable',
        reviewPacket?.buildArtifacts ? 'medium' : 'info',
        reviewPacket?.buildArtifacts
          ? 'Build artifacts exist but build packet fidelity is missing'
          : 'Standalone review without milestone build packet continuity requirements',
        reviewPacketPath,
      ),
    );
  }

  const missingPrefixes = readiness?.context?.missingReviewerPrefixes || [];
  const coverageGaps = coverageVerdict?.scope?.unreviewedFiles || coverageVerdict?.gaps || [];
  if (missingPrefixes.length > 0 || (Array.isArray(coverageGaps) && coverageGaps.length > 0)) {
    detectors.push(
      detector(
        'reviewer-coverage-drift',
        'reviewer-coverage-drift',
        'advisory',
        'medium',
        `Missing reviewer prefixes=${missingPrefixes.length}; uncovered files=${Array.isArray(coverageGaps) ? coverageGaps.length : 0}`,
        coverageVerdictPath || readinessPath,
      ),
    );
    enhancementQueue.push(
      enhancement(
        'enh-reviewer-coverage',
        'Increase reviewer coverage',
        `Fill ${missingPrefixes.length} reviewer coverage gap(s) and ${Array.isArray(coverageGaps) ? coverageGaps.length : 0} uncovered file gap(s).`,
        coverageVerdictPath || readinessPath,
      ),
    );
  } else {
    detectors.push(
      detector(
        'reviewer-coverage-drift',
        'reviewer-coverage-drift',
        'pass',
        'info',
        'Reviewer prefix coverage and scoped file coverage look complete',
        coverageVerdictPath || readinessPath,
      ),
    );
  }

  if (reviewerFailures.unresolved.length > 0) {
    detectors.push(
      detector(
        'reviewer-failure-escalation',
        'reviewer-failure-escalation',
        'fail',
        'high',
        reviewerFailures.unresolved.map((entry) => `${entry.reviewer}: ${entry.reason}`).join('; '),
        path.join(resolvedReviewDir, 'reviewer-failures.json'),
      ),
    );
    enhancementQueue.push(
      enhancement(
        'enh-reviewer-failure-escalation',
        'Repair reviewer escalation chain',
        'One or more reviewer failures are missing a complete review-lead or advisor escalation trail.',
        path.join(resolvedReviewDir, 'reviewer-failures.json'),
      ),
    );
  } else {
    detectors.push(
      detector(
        'reviewer-failure-escalation',
        'reviewer-failure-escalation',
        'pass',
        'info',
        `${reviewerFailures.total} reviewer failure record(s) were resolved or escalated correctly`,
        path.join(resolvedReviewDir, 'reviewer-failures.json'),
      ),
    );
  }

  const lineAnchor = summarizeLineAnchors(lineAnchorVerdict);
  detectors.push(
    detector(
      'review-fix-line-anchor',
      'review-fix-line-anchor',
      lineAnchor.status,
      lineAnchor.status === 'pass' ? 'info' : 'medium',
      lineAnchor.detail,
      lineAnchorPath,
    ),
  );
  if (lineAnchor.status !== 'pass') {
    enhancementQueue.push(
      enhancement('enh-review-fix-line-anchor', 'Reconcile review line anchors', lineAnchor.detail, lineAnchorPath),
    );
  }

  if (agentFailureReview) {
    const status =
      agentFailureFreshness?.stale || Number(agentFailureReview.failureCount || 0) > 0 ? 'advisory' : 'pass';
    const detail = agentFailureFreshness?.stale
      ? `agent failure review is stale (${agentFailureFreshness.reason})`
      : `${agentFailureReview.failureCount || 0} agent failure(s) recorded`;
    detectors.push(
      detector(
        'review-agent-failure-context',
        'review-agent-failure-context',
        status,
        status === 'pass' ? 'info' : 'medium',
        detail,
        agentFailureReviewPath,
      ),
    );
    if (status !== 'pass') {
      enhancementQueue.push(
        enhancement(
          'enh-review-agent-failure-context',
          'Refresh agent failure escalation context',
          detail,
          agentFailureReviewPath,
        ),
      );
    }
  } else {
    detectors.push(
      detector(
        'review-agent-failure-context',
        'review-agent-failure-context',
        'not-applicable',
        'info',
        'No agent failure review snapshot is available for this review run',
        agentFailureReviewPath,
      ),
    );
  }

  const agentFailureContexts = [
    ...(reviewerFailures.unresolved || []).map((entry, index) => ({
      id: `reviewer-failure-${index + 1}`,
      agent: entry.reviewer,
      stage: 'review',
      reason: entry.reason,
      errorContext: entry.entry,
    })),
    ...((agentFailureReview?.failures || []).map((failure, index) => ({
      id: failure.id || `agent-failure-${index + 1}`,
      agent: failure.agent || 'unknown-agent',
      stage: 'review',
      reason: failure.summary || failure.message || failure.raw || 'agent failure recorded',
      errorContext: failure,
    })) || []),
  ];

  const counts = {
    pass: detectors.filter((entry) => entry.status === 'pass').length,
    advisory: detectors.filter((entry) => entry.status === 'advisory').length,
    fail: detectors.filter((entry) => entry.status === 'fail').length,
    pending: detectors.filter((entry) => entry.status === 'pending').length,
    notApplicable: detectors.filter((entry) => entry.status === 'not-applicable').length,
  };

  const status = counts.fail > 0 ? 'fail' : counts.advisory > 0 || counts.pending > 0 ? 'advisory' : 'pass';

  const fidelity = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-review-handoff-fidelity',
    status,
    advisoryProceed: status === 'advisory',
    projectRoot,
    reviewDir: resolvedReviewDir,
    reviewId,
    milestone,
    packetReferences: {
      reviewPacket: reviewPacketPath ? normalizeRelative(reviewPacketPath) : null,
      reviewManifest: normalizeRelative(reviewManifestPath),
      sourceManifest: normalizeRelative(sourceManifestPath),
      readinessGate: normalizeRelative(readinessPath),
      coverageVerdict: coverageVerdictPath ? normalizeRelative(coverageVerdictPath) : null,
      buildPacketFidelity: buildPacketFidelity ? normalizeRelative(buildPacketFidelity.path) : null,
      lineAnchorVerdict: fs.existsSync(lineAnchorPath) ? normalizeRelative(lineAnchorPath) : null,
      agentFailureReview: agentFailureReview ? normalizeRelative(agentFailureReviewPath) : null,
      reviewLeadEscalationPacket: reviewLeadPacket ? normalizeRelative(reviewLeadPacketPath) : null,
    },
    buildContinuity: buildPacketFidelity
      ? {
          valid: buildPacketFidelity.payload.valid !== false,
          missingStories: buildPacketFidelity.payload.missingStories || [],
          missingManifestFields: buildPacketFidelity.payload.missingManifestFields || [],
          missingPacketSignals: buildPacketFidelity.payload.missingPacketSignals || [],
          enhancementCount: Array.isArray(buildPacketFidelity.payload.enhancementQueue)
            ? buildPacketFidelity.payload.enhancementQueue.length
            : 0,
        }
      : null,
    reviewerCoverage: {
      missingReviewerPrefixes: missingPrefixes,
      uncoveredFiles: Array.isArray(coverageGaps) ? coverageGaps : [],
      reviewedFiles: Array.isArray(reviewManifest?.reviewedFiles) ? reviewManifest.reviewedFiles.length : 0,
    },
    reviewerFailures: {
      total: reviewerFailures.total,
      unresolved: reviewerFailures.unresolved.map((entry) => ({
        reviewer: entry.reviewer,
        reason: entry.reason,
      })),
    },
    lineAnchor,
    fixHandoffCompleteness: {
      ready: counts.fail === 0 && lineAnchor.status === 'pass' && reviewerFailures.unresolved.length === 0,
      readinessPassed: readiness?.passed !== false,
      pendingAnchors: lineAnchor.status === 'pending',
      advisoryAnchors: lineAnchor.status === 'advisory',
      unresolvedReviewerFailures: reviewerFailures.unresolved.length,
    },
    agentFailureContexts,
    driftDetectors: detectors,
    enhancementQueue,
    escalationPackets: {
      reviewLead: reviewLeadPacket || {
        target: 'review-lead',
        milestone,
        reviewId,
        status,
        reasons: detectors.filter((entry) => entry.status !== 'pass' && entry.status !== 'not-applicable'),
      },
      recoveryAdvisor: {
        target:
          agentFailureReview?.escalation?.advisorAgent ||
          (agentFailureReview?.escalation?.advisorRequired ? 'recovery-advisor' : 'recovery-advisor'),
        milestone,
        reviewId,
        required: counts.fail > 0 || Boolean(agentFailureReview?.escalation?.advisorRequired),
        reasons: detectors
          .filter((entry) => entry.status === 'fail' || entry.status === 'advisory')
          .map((entry) => entry.detail),
      },
    },
    qualitySummary: {
      detectors: counts,
      findings: Array.isArray(reviewFindings.findings) ? reviewFindings.findings.length : 0,
      reviewerAgents: Array.isArray(reviewManifest?.completed) ? reviewManifest.completed.length : 0,
      enhancementCount: enhancementQueue.length,
      agentFailureCount: agentFailureContexts.length,
    },
  };

  const outputPath = path.join(resolvedReviewDir, 'review-handoff-fidelity.json');
  const markdownPath = path.join(resolvedReviewDir, 'review-handoff-fidelity.md');

  const lines = [
    '# Review Handoff Fidelity',
    '',
    `Generated: ${fidelity.generatedAt}`,
    `Status: ${fidelity.status}`,
    `Review ID: ${reviewId}`,
    `Milestone: ${milestone || 'none'}`,
    '',
    '## Detector Summary',
    '',
    `- Pass: ${counts.pass}`,
    `- Advisory: ${counts.advisory}`,
    `- Fail: ${counts.fail}`,
    `- Pending: ${counts.pending}`,
    '',
    '## Active Detectors',
    '',
  ];

  for (const entry of detectors.filter((item) => item.status !== 'pass' && item.status !== 'not-applicable')) {
    lines.push(`- [${entry.status}] ${entry.id}: ${entry.detail}`);
  }
  if (!detectors.some((item) => item.status !== 'pass' && item.status !== 'not-applicable')) {
    lines.push('- No active review handoff fidelity issues detected');
  }

  lines.push('', '## Enhancement Queue', '');
  if (enhancementQueue.length === 0) {
    lines.push('- None');
  } else {
    for (const entry of enhancementQueue) {
      lines.push(`- ${entry.title}: ${entry.detail}`);
    }
  }

  writeJson(outputPath, fidelity);
  writeText(markdownPath, `${lines.join('\n')}\n`);

  return {
    fidelity,
    outputPath,
    markdownPath,
  };
}

function main() {
  const args = process.argv.slice(2);
  maybePrintHelpAndExit(args, USAGE);
  const command = args[0] || 'build';
  const dirIdx = args.indexOf('--dir');
  const reviewDir = dirIdx !== -1 && args[dirIdx + 1] ? args[dirIdx + 1] : defaultReviewDir();
  const jsonMode = args.includes('--json');

  if (command !== 'build') {
    console.log('CoBolt Review Handoff Fidelity');
    console.log('');
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }

  const result = buildReviewHandoffFidelity(reviewDir);
  if (jsonMode) {
    console.log(JSON.stringify(result.fidelity, null, 2));
  } else {
    console.log('[cobolt-review-handoff-fidelity] Review Handoff Fidelity');
    console.log(`  Milestone: ${result.fidelity.milestone || 'unknown'}`);
    console.log(`  Status: ${result.fidelity.status}`);
    console.log(`  Output: ${result.outputPath}`);
  }

  // Hard-exit 1 when the metadata.findings[] enforcement detector failed.
  const findingsArrayDetector = (result.fidelity.driftDetectors || []).find(
    (d) => d.id === 'review-lead-findings-array',
  );
  if (findingsArrayDetector && findingsArrayDetector.status === 'fail') {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildReviewHandoffFidelity,
  inspectReviewLeadFindingsEnvelope,
};
