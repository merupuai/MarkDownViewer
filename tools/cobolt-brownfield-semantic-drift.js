#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { isAgentFailureReviewStale } = require('./cobolt-agent-failure-review');

function defaultBrownfieldDir(projectRoot) {
  return path.join(path.resolve(projectRoot || process.cwd()), '_cobolt-output', 'latest', 'brownfield');
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

function detectProjectRoot(brownfieldDir) {
  const resolved = path.resolve(brownfieldDir || defaultBrownfieldDir());
  const marker = `${path.sep}_cobolt-output${path.sep}`;
  const markerIndex = resolved.lastIndexOf(marker);
  if (markerIndex !== -1) return resolved.slice(0, markerIndex);
  return path.resolve(resolved, '..', '..', '..');
}

function countEntries(payload, summaryField) {
  if (!payload) return 0;
  if (Number.isFinite(Number(payload?.summary?.[summaryField]))) return Number(payload.summary[summaryField]);
  if (Array.isArray(payload.findings)) return payload.findings.length;
  if (Array.isArray(payload.violations)) return payload.violations.length;
  if (Array.isArray(payload.domains)) return payload.domains.filter((entry) => entry?.status === 'unwired').length;
  return 0;
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

function buildBrownfieldSemanticDrift(brownfieldDir, options = {}) {
  const resolvedBrownfieldDir = path.resolve(brownfieldDir || defaultBrownfieldDir(options.projectRoot));
  const projectRoot = path.resolve(options.projectRoot || detectProjectRoot(resolvedBrownfieldDir));
  const issuesPath = path.join(resolvedBrownfieldDir, '16-issues-registry.json');
  const evidenceIndexPath = path.join(resolvedBrownfieldDir, '19-evidence-index.json');
  const domainLivenessPath = path.join(resolvedBrownfieldDir, 'domain-liveness.json');
  const queryMigrationPath = path.join(resolvedBrownfieldDir, 'query-migration-contract.json');
  const semanticStubPath = path.join(resolvedBrownfieldDir, 'semantic-stub-findings.json');
  const uiPlaceholderPath = path.join(resolvedBrownfieldDir, 'ui-placeholder-mock-scan.json');
  const handoffContractPath = path.join(resolvedBrownfieldDir, 'brownfield-to-build-handoff-contract.json');
  const contractValidationPath = path.join(resolvedBrownfieldDir, 'brownfield-contract-validation.json');
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

  const issuesRegistry = loadJson(issuesPath);
  const evidenceIndex = loadJson(evidenceIndexPath);
  const domainLiveness = loadJson(domainLivenessPath);
  const queryMigration = loadJson(queryMigrationPath);
  const semanticStubFindings = loadJson(semanticStubPath);
  const uiPlaceholderScan = loadJson(uiPlaceholderPath);
  const handoffContract = loadJson(handoffContractPath);
  const contractValidation = loadJson(contractValidationPath);
  const agentFailureReview = loadJson(agentFailureReviewPath);
  const reviewLeadPacket = loadJson(reviewLeadPacketPath);
  const agentFailureFreshness = agentFailureReview ? isAgentFailureReviewStale(agentFailureReview, projectRoot) : null;

  const detectors = [];
  const enhancementQueue = [];

  const structuralIssues = [];
  if (!issuesRegistry) structuralIssues.push('issues registry missing');
  if (!evidenceIndex) structuralIssues.push('evidence index missing');

  if (structuralIssues.length > 0) {
    detectors.push(
      detector(
        'brownfield-structural-contract',
        'brownfield-structural-contract',
        'fail',
        'critical',
        structuralIssues.join('; '),
        issuesPath,
      ),
    );
  } else {
    detectors.push(
      detector(
        'brownfield-structural-contract',
        'brownfield-structural-contract',
        'pass',
        'info',
        'Brownfield issues registry and evidence index are present',
        issuesPath,
      ),
    );
  }

  const unwiredDomains = countEntries(domainLiveness, 'unwired');
  if (unwiredDomains > 0) {
    detectors.push(
      detector(
        'brownfield-route-domain-drift',
        'brownfield-route-domain-drift',
        'advisory',
        'medium',
        `${unwiredDomains} brownfield domain(s) remain unwired in domain-liveness.json`,
        domainLivenessPath,
      ),
    );
    enhancementQueue.push(
      enhancement(
        'enh-brownfield-route-domain-drift',
        'Repair route or domain liveness gaps',
        'Carry forward the unwired domain findings into the planning/build packet instead of rediscovering them later.',
        domainLivenessPath,
      ),
    );
  } else {
    detectors.push(
      detector(
        'brownfield-route-domain-drift',
        'brownfield-route-domain-drift',
        domainLiveness ? 'pass' : 'not-applicable',
        'info',
        domainLiveness ? 'No unwired brownfield domains detected' : 'domain-liveness.json is absent',
        domainLivenessPath,
      ),
    );
  }

  const queryViolations = countEntries(queryMigration, 'violations');
  if (queryViolations > 0) {
    detectors.push(
      detector(
        'brownfield-data-migration-drift',
        'brownfield-data-migration-drift',
        'advisory',
        'medium',
        `${queryViolations} query or migration contract violation(s) remain open`,
        queryMigrationPath,
      ),
    );
    enhancementQueue.push(
      enhancement(
        'enh-brownfield-data-migration-drift',
        'Repair brownfield data migration contract gaps',
        'Promote remaining query or migration mismatches into milestone-level obligations before build starts.',
        queryMigrationPath,
      ),
    );
  } else {
    detectors.push(
      detector(
        'brownfield-data-migration-drift',
        'brownfield-data-migration-drift',
        queryMigration ? 'pass' : 'not-applicable',
        'info',
        queryMigration
          ? 'No query or migration contract violations detected'
          : 'query-migration-contract.json is absent',
        queryMigrationPath,
      ),
    );
  }

  const semanticStubCount = countEntries(semanticStubFindings, 'findings');
  if (semanticStubCount > 0) {
    detectors.push(
      detector(
        'brownfield-semantic-stub-drift',
        'brownfield-semantic-stub-drift',
        'advisory',
        'medium',
        `${semanticStubCount} semantic stub finding(s) remain unresolved`,
        semanticStubPath,
      ),
    );
    enhancementQueue.push(
      enhancement(
        'enh-brownfield-semantic-stub-drift',
        'Carry semantic stub findings into planning and build',
        'Brownfield semantic stubs should become explicit execution obligations instead of latent debt.',
        semanticStubPath,
      ),
    );
  } else {
    detectors.push(
      detector(
        'brownfield-semantic-stub-drift',
        'brownfield-semantic-stub-drift',
        semanticStubFindings ? 'pass' : 'not-applicable',
        'info',
        semanticStubFindings ? 'No brownfield semantic stub findings remain' : 'semantic-stub-findings.json is absent',
        semanticStubPath,
      ),
    );
  }

  const uiPlaceholderCount = countEntries(uiPlaceholderScan, 'findings');
  if (uiPlaceholderCount > 0) {
    detectors.push(
      detector(
        'brownfield-ui-placeholder-drift',
        'brownfield-ui-placeholder-drift',
        'advisory',
        'medium',
        `${uiPlaceholderCount} UI placeholder or mock finding(s) remain unresolved`,
        uiPlaceholderPath,
      ),
    );
    enhancementQueue.push(
      enhancement(
        'enh-brownfield-ui-placeholder-drift',
        'Carry UI placeholder findings into build obligations',
        'UI placeholder or mock debt should be explicit in the build packet instead of hiding inside brownfield-only evidence.',
        uiPlaceholderPath,
      ),
    );
  } else {
    detectors.push(
      detector(
        'brownfield-ui-placeholder-drift',
        'brownfield-ui-placeholder-drift',
        uiPlaceholderScan ? 'pass' : 'not-applicable',
        'info',
        uiPlaceholderScan ? 'No UI placeholder findings remain' : 'ui-placeholder-mock-scan.json is absent',
        uiPlaceholderPath,
      ),
    );
  }

  if (handoffContract) {
    const status = handoffContract.ok === false ? 'advisory' : 'pass';
    const detail =
      handoffContract.ok === false
        ? `brownfield build handoff contract still has ${handoffContract.failCount || 0} failing artifact(s)`
        : 'Brownfield build handoff contract passed';
    detectors.push(
      detector(
        'brownfield-handoff-continuity',
        'brownfield-handoff-continuity',
        status,
        status === 'pass' ? 'info' : 'medium',
        detail,
        handoffContractPath,
      ),
    );
    if (status !== 'pass') {
      enhancementQueue.push(
        enhancement(
          'enh-brownfield-handoff-continuity',
          'Repair brownfield handoff continuity',
          detail,
          handoffContractPath,
        ),
      );
    }
  } else {
    detectors.push(
      detector(
        'brownfield-handoff-continuity',
        'brownfield-handoff-continuity',
        'pending',
        'medium',
        'brownfield-to-build-handoff-contract.json has not been generated yet',
        handoffContractPath,
      ),
    );
  }

  if (contractValidation) {
    const blockers = Array.isArray(contractValidation.blockers) ? contractValidation.blockers.length : 0;
    const status = blockers > 0 || contractValidation.ok === false ? 'advisory' : 'pass';
    const detail =
      status === 'pass'
        ? 'Brownfield contract validation is aligned'
        : `${blockers} brownfield contract validation blocker(s) remain open`;
    detectors.push(
      detector(
        'brownfield-contract-validation',
        'brownfield-contract-validation',
        status,
        status === 'pass' ? 'info' : 'medium',
        detail,
        contractValidationPath,
      ),
    );
    if (status !== 'pass') {
      enhancementQueue.push(
        enhancement(
          'enh-brownfield-contract-validation',
          'Repair brownfield contract validation blockers',
          detail,
          contractValidationPath,
        ),
      );
    }
  } else {
    detectors.push(
      detector(
        'brownfield-contract-validation',
        'brownfield-contract-validation',
        'pending',
        'medium',
        'brownfield-contract-validation.json has not been generated yet',
        contractValidationPath,
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
        'brownfield-agent-failure-context',
        'brownfield-agent-failure-context',
        status,
        status === 'pass' ? 'info' : 'medium',
        detail,
        agentFailureReviewPath,
      ),
    );
    if (status !== 'pass') {
      enhancementQueue.push(
        enhancement(
          'enh-brownfield-agent-failure-context',
          'Refresh brownfield failure escalation context',
          detail,
          agentFailureReviewPath,
        ),
      );
    }
  } else {
    detectors.push(
      detector(
        'brownfield-agent-failure-context',
        'brownfield-agent-failure-context',
        'not-applicable',
        'info',
        'No agent failure review snapshot is available for this brownfield run',
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
    generatedBy: 'cobolt-brownfield-semantic-drift',
    status,
    advisoryProceed: status === 'advisory',
    projectRoot,
    brownfieldDir: resolvedBrownfieldDir,
    packetReferences: {
      issuesRegistry: fs.existsSync(issuesPath) ? normalizeRelative(issuesPath) : null,
      evidenceIndex: fs.existsSync(evidenceIndexPath) ? normalizeRelative(evidenceIndexPath) : null,
      domainLiveness: fs.existsSync(domainLivenessPath) ? normalizeRelative(domainLivenessPath) : null,
      queryMigrationContract: fs.existsSync(queryMigrationPath) ? normalizeRelative(queryMigrationPath) : null,
      semanticStubFindings: fs.existsSync(semanticStubPath) ? normalizeRelative(semanticStubPath) : null,
      uiPlaceholderMockScan: fs.existsSync(uiPlaceholderPath) ? normalizeRelative(uiPlaceholderPath) : null,
      brownfieldBuildHandoffContract: fs.existsSync(handoffContractPath)
        ? normalizeRelative(handoffContractPath)
        : null,
      brownfieldContractValidation: fs.existsSync(contractValidationPath)
        ? normalizeRelative(contractValidationPath)
        : null,
      agentFailureReview: agentFailureReview ? normalizeRelative(agentFailureReviewPath) : null,
      reviewLeadEscalationPacket: reviewLeadPacket ? normalizeRelative(reviewLeadPacketPath) : null,
    },
    semanticSignals: {
      unwiredDomains,
      queryViolations,
      semanticStubCount,
      uiPlaceholderCount,
      issueCount: Array.isArray(issuesRegistry?.issues) ? issuesRegistry.issues.length : 0,
    },
    driftDetectors: detectors,
    enhancementQueue,
    agentFailureContexts:
      agentFailureReview?.failures?.map((failure, index) => ({
        id: failure.id || `agent-failure-${index + 1}`,
        agent: failure.agent || 'unknown-agent',
        stage: 'brownfield',
        reason: failure.summary || failure.message || failure.raw || 'agent failure recorded',
        errorContext: failure,
      })) || [],
    escalationPackets: {
      reviewLead: reviewLeadPacket || {
        target: 'review-lead',
        status,
        reasons: detectors.filter((entry) => entry.status !== 'pass' && entry.status !== 'not-applicable'),
      },
      recoveryAdvisor: {
        target:
          agentFailureReview?.escalation?.advisorAgent ||
          (agentFailureReview?.escalation?.advisorRequired ? 'recovery-advisor' : 'recovery-advisor'),
        required: counts.fail > 0 || Boolean(agentFailureReview?.escalation?.advisorRequired),
        reasons: detectors
          .filter((entry) => entry.status === 'fail' || entry.status === 'advisory')
          .map((entry) => entry.detail),
      },
    },
    qualitySummary: {
      detectors: counts,
      enhancementCount: enhancementQueue.length,
      issueCount: Array.isArray(issuesRegistry?.issues) ? issuesRegistry.issues.length : 0,
    },
  };

  const outputPath = path.join(resolvedBrownfieldDir, 'brownfield-semantic-drift.json');
  const markdownPath = path.join(resolvedBrownfieldDir, 'brownfield-semantic-drift.md');

  const lines = [
    '# Brownfield Semantic Drift',
    '',
    `Generated: ${fidelity.generatedAt}`,
    `Status: ${fidelity.status}`,
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
    lines.push('- No active brownfield semantic drift issues detected');
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
  const brownfieldDir = dirIdx !== -1 && args[dirIdx + 1] ? args[dirIdx + 1] : defaultBrownfieldDir();
  const jsonMode = args.includes('--json');

  if (command !== 'build') {
    console.log('CoBolt Brownfield Semantic Drift');
    console.log('');
    console.log('Usage: node tools/cobolt-brownfield-semantic-drift.js build [--dir <path>] [--json]');
    process.exit(command ? 2 : 0);
  }

  const result = buildBrownfieldSemanticDrift(brownfieldDir);
  if (jsonMode) {
    console.log(JSON.stringify(result.fidelity, null, 2));
    return;
  }

  console.log('[cobolt-brownfield-semantic-drift] Brownfield Semantic Drift');
  console.log(`  Status: ${result.fidelity.status}`);
  console.log(`  Output: ${result.outputPath}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildBrownfieldSemanticDrift,
  detectProjectRoot,
};
