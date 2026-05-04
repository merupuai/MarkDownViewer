#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { isAgentFailureReviewStale } = require('./cobolt-agent-failure-review');
const { audit: auditCarryForwardSemantic } = require('./cobolt-carry-forward-semantic');

function defaultFixDir(projectRoot) {
  return path.join(path.resolve(projectRoot || process.cwd()), '_cobolt-output', 'latest', 'fix');
}

function loadJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeText(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, payload, 'utf8');
}

function normalizeRelative(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function detectProjectRoot(fixDir) {
  const resolved = path.resolve(fixDir || defaultFixDir());
  const marker = `${path.sep}_cobolt-output${path.sep}`;
  const markerIndex = resolved.lastIndexOf(marker);
  if (markerIndex !== -1) return resolved.slice(0, markerIndex);
  return path.resolve(resolved, '..', '..', '..');
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

function buildFixResolutionFidelity(fixDir, options = {}) {
  const resolvedFixDir = path.resolve(fixDir || defaultFixDir(options.projectRoot));
  const projectRoot = path.resolve(options.projectRoot || detectProjectRoot(resolvedFixDir));
  const readinessPath = path.join(resolvedFixDir, 'fix-readiness-report.json');
  const caseRegistryPath = path.join(resolvedFixDir, 'fix-case-registry.json');
  const validationPlanPath = path.join(resolvedFixDir, 'fix-validation-plan.json');
  const touchedSurfacePath = path.join(resolvedFixDir, 'fix-touched-surface-gates.json');
  const completenessPath = path.join(resolvedFixDir, 'fix-completeness-report.json');
  const sourceProofPath = path.join(resolvedFixDir, 'fix-source-proof.json');
  const reviewLineAnchorPath = path.join(projectRoot, '_cobolt-output', 'latest', 'review', 'line-anchor-verdict.json');
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
  const carryForwardPath = path.join(resolvedFixDir, 'carry-forward.json');

  const readiness = options.readiness || loadJson(readinessPath);
  const caseRegistry = loadJson(caseRegistryPath);
  const validationPlan = loadJson(validationPlanPath);
  const touchedSurfaceGates = loadJson(touchedSurfacePath);
  const completeness = loadJson(completenessPath);
  const sourceProof = loadJson(sourceProofPath);
  const lineAnchorVerdict = loadJson(reviewLineAnchorPath);
  const agentFailureReview = loadJson(agentFailureReviewPath);
  const reviewLeadPacket = loadJson(reviewLeadPacketPath);
  const agentFailureFreshness = agentFailureReview ? isAgentFailureReviewStale(agentFailureReview, projectRoot) : null;
  const cases = Array.isArray(caseRegistry?.cases) ? caseRegistry.cases : [];
  const validationCases = Array.isArray(validationPlan?.cases) ? validationPlan.cases : [];
  const milestone =
    options.milestone ||
    sourceProof?.milestone ||
    readiness?.milestone ||
    completeness?.milestone ||
    caseRegistry?.milestone ||
    null;

  const validationCaseIds = new Set(validationCases.map((entry) => entry.caseId));
  const casesMissingValidation = cases
    .filter((entry) => !validationCaseIds.has(entry.caseId))
    .map((entry) => entry.caseId);
  const replayRequiredCases = validationCases.map((entry) => ({
    caseId: entry.caseId,
    findingId: entry.findingId,
    requiredChecks: Array.isArray(entry.requiredChecks) ? entry.requiredChecks : [],
  }));
  const highRiskReplayCases = replayRequiredCases.filter((entry) =>
    entry.requiredChecks.some((check) =>
      [
        'originalFailureReplay',
        'minimalReproReplay',
        'securityRetest',
        'integrationContractReplay',
        'migrationOrQueryVerification',
      ].includes(check),
    ),
  );

  const carryForwardAudit = auditCarryForwardSemantic(projectRoot, { milestone });
  const carryForwardPhantoms = Number(carryForwardAudit?.report?.tally?.phantom || 0);
  const carryForwardResolvedInPlace = Number(carryForwardAudit?.report?.tally?.['resolved-in-place'] || 0);
  const lineAnchor = summarizeLineAnchors(lineAnchorVerdict);

  const detectors = [];
  const enhancementQueue = [];

  const structuralIssues = [];
  if (!readiness) structuralIssues.push('fix readiness report missing');
  if (!caseRegistry) structuralIssues.push('fix case registry missing');
  if (!validationPlan) structuralIssues.push('fix validation plan missing');
  if (!sourceProof) structuralIssues.push('fix source proof missing');

  if (structuralIssues.length > 0) {
    detectors.push(
      detector(
        'fix-structural-contract',
        'fix-structural-contract',
        'fail',
        'critical',
        structuralIssues.join('; '),
        readinessPath,
      ),
    );
  } else {
    detectors.push(
      detector(
        'fix-structural-contract',
        'fix-structural-contract',
        'pass',
        'info',
        'Fix readiness, case registry, validation plan, and source proof are present',
        readinessPath,
      ),
    );
  }

  if (readiness?.passed === false) {
    detectors.push(
      detector(
        'fix-readiness-continuity',
        'fix-readiness-continuity',
        'fail',
        'high',
        `Fix readiness failed: blocked=${readiness.summary?.blocked || 0}; draftOnly=${readiness.summary?.draftOnly || 0}; missingContracts=${(readiness.summary?.missingContracts || []).length}`,
        readinessPath,
      ),
    );
  } else if (readiness) {
    detectors.push(
      detector(
        'fix-readiness-continuity',
        'fix-readiness-continuity',
        'pass',
        'info',
        `${readiness.summary?.ready || 0}/${readiness.summary?.totalCases || 0} fix case(s) are READY`,
        readinessPath,
      ),
    );
  } else {
    detectors.push(
      detector(
        'fix-readiness-continuity',
        'fix-readiness-continuity',
        'pending',
        'medium',
        'fix-readiness-report.json has not been generated yet',
        readinessPath,
      ),
    );
  }

  if (sourceProof?.proofStatus === 'fail') {
    detectors.push(
      detector(
        'fix-source-proof',
        'fix-source-proof',
        'fail',
        'high',
        `Fix source proof failed: ${(sourceProof.issues || []).join(', ') || 'unknown issue'}`,
        sourceProofPath,
      ),
    );
  } else if (sourceProof) {
    detectors.push(
      detector(
        'fix-source-proof',
        'fix-source-proof',
        sourceProof.proofStatus === 'waived' ? 'advisory' : 'pass',
        sourceProof.proofStatus === 'waived' ? 'medium' : 'info',
        `source proof status=${sourceProof.proofStatus}; findings=${sourceProof.findingCount || 0}`,
        sourceProofPath,
      ),
    );
    if (sourceProof.proofStatus === 'waived') {
      enhancementQueue.push(
        enhancement(
          'enh-fix-source-proof',
          'Strengthen zero-case or source-proof evidence',
          'Fix is proceeding on waived source proof; attach a fresher finding source or explicit zero-case rationale.',
          sourceProofPath,
        ),
      );
    }
  }

  if (casesMissingValidation.length > 0) {
    detectors.push(
      detector(
        'fix-validation-coverage',
        'fix-validation-coverage',
        'fail',
        'high',
        `${casesMissingValidation.length} fix case(s) are missing validation-plan coverage`,
        validationPlanPath,
      ),
    );
  } else {
    detectors.push(
      detector(
        'fix-validation-coverage',
        'fix-validation-coverage',
        'pass',
        'info',
        `${validationCases.length} fix case(s) have validation-plan coverage`,
        validationPlanPath,
      ),
    );
  }

  if (touchedSurfaceGates) {
    const changedFiles = Array.isArray(touchedSurfaceGates.changedFiles) ? touchedSurfaceGates.changedFiles.length : 0;
    const missingEvidence = Array.isArray(touchedSurfaceGates.missingEvidence)
      ? touchedSurfaceGates.missingEvidence.length
      : 0;
    const status = missingEvidence > 0 || changedFiles === 0 ? 'advisory' : 'pass';
    const detail =
      changedFiles === 0
        ? 'Touched-surface gates are still awaiting actual changed-file evidence'
        : missingEvidence > 0
          ? `${missingEvidence} touched-surface evidence obligation(s) remain open`
          : `${changedFiles} changed file(s) mapped to touched-surface obligations`;
    detectors.push(
      detector(
        'fix-touched-surface-readiness',
        'fix-touched-surface-readiness',
        status,
        status === 'pass' ? 'info' : 'medium',
        detail,
        touchedSurfacePath,
      ),
    );
    if (status !== 'pass') {
      enhancementQueue.push(
        enhancement(
          'enh-fix-touched-surface-readiness',
          'Update touched-surface verification evidence',
          detail,
          touchedSurfacePath,
        ),
      );
    }
  } else {
    detectors.push(
      detector(
        'fix-touched-surface-readiness',
        'fix-touched-surface-readiness',
        'pending',
        'medium',
        'fix-touched-surface-gates.json has not been generated yet',
        touchedSurfacePath,
      ),
    );
  }

  detectors.push(
    detector(
      'review-fix-line-anchor',
      'review-fix-line-anchor',
      lineAnchor.status,
      lineAnchor.status === 'pass' ? 'info' : 'medium',
      lineAnchor.detail,
      reviewLineAnchorPath,
    ),
  );
  if (lineAnchor.status !== 'pass') {
    enhancementQueue.push(
      enhancement(
        'enh-review-fix-line-anchor',
        'Reconcile review line anchors before or during fix dispatch',
        lineAnchor.detail,
        reviewLineAnchorPath,
      ),
    );
  }

  if (carryForwardAudit?.ok && carryForwardAudit.report) {
    const status = carryForwardPhantoms > 0 || carryForwardResolvedInPlace > 0 ? 'advisory' : 'pass';
    const detail = `phantom=${carryForwardPhantoms}; resolvedInPlace=${carryForwardResolvedInPlace}; relevant=${carryForwardAudit.report.tally?.relevant || 0}`;
    detectors.push(
      detector(
        'carry-forward-semantic-drift',
        'carry-forward-semantic-drift',
        status,
        status === 'pass' ? 'info' : 'medium',
        detail,
        carryForwardPath,
      ),
    );
    if (status !== 'pass') {
      enhancementQueue.push(
        enhancement(
          'enh-carry-forward-semantic-drift',
          'Repair carry-forward semantics',
          'Deferred work items reference stale or partially resolved code and should be rewritten before the next consumer stage.',
          carryForwardPath,
        ),
      );
    }
  } else {
    detectors.push(
      detector(
        'carry-forward-semantic-drift',
        'carry-forward-semantic-drift',
        fs.existsSync(carryForwardPath) ? 'pending' : 'not-applicable',
        fs.existsSync(carryForwardPath) ? 'medium' : 'info',
        fs.existsSync(carryForwardPath)
          ? 'carry-forward.json exists but semantic drift audit could not be completed'
          : 'No carry-forward file exists yet for this fix stage',
        carryForwardPath,
      ),
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
        'fix-agent-failure-context',
        'fix-agent-failure-context',
        status,
        status === 'pass' ? 'info' : 'medium',
        detail,
        agentFailureReviewPath,
      ),
    );
    if (status !== 'pass') {
      enhancementQueue.push(
        enhancement(
          'enh-fix-agent-failure-context',
          'Refresh fix-stage failure escalation context',
          detail,
          agentFailureReviewPath,
        ),
      );
    }
  } else {
    detectors.push(
      detector(
        'fix-agent-failure-context',
        'fix-agent-failure-context',
        'not-applicable',
        'info',
        'No agent failure review snapshot is available for this fix run',
        agentFailureReviewPath,
      ),
    );
  }

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
    generatedBy: 'cobolt-fix-resolution-fidelity',
    status,
    advisoryProceed: status === 'advisory',
    projectRoot,
    fixDir: resolvedFixDir,
    milestone,
    packetReferences: {
      fixReadinessReport: fs.existsSync(readinessPath) ? normalizeRelative(readinessPath) : null,
      fixCaseRegistry: fs.existsSync(caseRegistryPath) ? normalizeRelative(caseRegistryPath) : null,
      fixValidationPlan: fs.existsSync(validationPlanPath) ? normalizeRelative(validationPlanPath) : null,
      fixTouchedSurfaceGates: fs.existsSync(touchedSurfacePath) ? normalizeRelative(touchedSurfacePath) : null,
      fixCompletenessReport: fs.existsSync(completenessPath) ? normalizeRelative(completenessPath) : null,
      fixSourceProof: fs.existsSync(sourceProofPath) ? normalizeRelative(sourceProofPath) : null,
      lineAnchorVerdict: fs.existsSync(reviewLineAnchorPath) ? normalizeRelative(reviewLineAnchorPath) : null,
      carryForward: fs.existsSync(carryForwardPath) ? normalizeRelative(carryForwardPath) : null,
      agentFailureReview: agentFailureReview ? normalizeRelative(agentFailureReviewPath) : null,
      reviewLeadEscalationPacket: reviewLeadPacket ? normalizeRelative(reviewLeadPacketPath) : null,
    },
    replayReadiness: {
      totalCases: replayRequiredCases.length,
      highRiskCases: highRiskReplayCases.length,
      casesMissingValidation,
      cases: replayRequiredCases,
    },
    lineAnchor,
    carryForwardSemantic: carryForwardAudit?.report
      ? {
          totalItems: carryForwardAudit.report.totalItems,
          tally: carryForwardAudit.report.tally,
        }
      : null,
    touchedSurfaceSummary: touchedSurfaceGates
      ? {
          changedFiles: Array.isArray(touchedSurfaceGates.changedFiles) ? touchedSurfaceGates.changedFiles.length : 0,
          surfaces: Array.isArray(touchedSurfaceGates.surfaces) ? touchedSurfaceGates.surfaces.length : 0,
          missingEvidence: Array.isArray(touchedSurfaceGates.missingEvidence)
            ? touchedSurfaceGates.missingEvidence
            : [],
        }
      : null,
    completeness: completeness || null,
    agentFailureContexts:
      agentFailureReview?.failures?.map((failure, index) => ({
        id: failure.id || `agent-failure-${index + 1}`,
        agent: failure.agent || 'unknown-agent',
        stage: 'fix',
        reason: failure.summary || failure.message || failure.raw || 'agent failure recorded',
        errorContext: failure,
      })) || [],
    driftDetectors: detectors,
    enhancementQueue,
    escalationPackets: {
      reviewLead: reviewLeadPacket || {
        target: 'review-lead',
        milestone,
        status,
        reasons: detectors.filter((entry) => entry.status !== 'pass' && entry.status !== 'not-applicable'),
      },
      recoveryAdvisor: {
        target:
          agentFailureReview?.escalation?.advisorAgent ||
          (agentFailureReview?.escalation?.advisorRequired ? 'recovery-advisor' : 'recovery-advisor'),
        milestone,
        required: counts.fail > 0 || Boolean(agentFailureReview?.escalation?.advisorRequired),
        reasons: detectors
          .filter((entry) => entry.status === 'fail' || entry.status === 'advisory')
          .map((entry) => entry.detail),
      },
    },
    qualitySummary: {
      detectors: counts,
      caseCount: cases.length,
      enhancementCount: enhancementQueue.length,
      carryForwardPhantoms,
      highRiskReplayCases: highRiskReplayCases.length,
    },
  };

  const outputPath = path.join(resolvedFixDir, 'fix-resolution-fidelity.json');
  const markdownPath = path.join(resolvedFixDir, 'fix-resolution-fidelity.md');

  const lines = [
    '# Fix Resolution Fidelity',
    '',
    `Generated: ${fidelity.generatedAt}`,
    `Status: ${fidelity.status}`,
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
    lines.push('- No active fix fidelity issues detected');
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
  const command = args[0] || 'build';
  const dirIdx = args.indexOf('--dir');
  const fixDir = dirIdx !== -1 && args[dirIdx + 1] ? args[dirIdx + 1] : defaultFixDir();
  const jsonMode = args.includes('--json');

  if (command !== 'build') {
    console.log('CoBolt Fix Resolution Fidelity');
    console.log('');
    console.log('Usage: node tools/cobolt-fix-resolution-fidelity.js build [--dir <path>] [--json]');
    process.exit(command ? 2 : 0);
  }

  const result = buildFixResolutionFidelity(fixDir);
  if (jsonMode) {
    console.log(JSON.stringify(result.fidelity, null, 2));
    return;
  }

  console.log('[cobolt-fix-resolution-fidelity] Fix Resolution Fidelity');
  console.log(`  Milestone: ${result.fidelity.milestone || 'unknown'}`);
  console.log(`  Status: ${result.fidelity.status}`);
  console.log(`  Output: ${result.outputPath}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildFixResolutionFidelity,
  detectProjectRoot,
};
