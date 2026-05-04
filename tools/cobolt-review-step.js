#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { atomicWrite } = require('../lib/cobolt-atomic-write');
const { BASELINE_REVIEWERS, toReviewerPrefix } = require('../lib/cobolt-reviewer-registry');
const { dedupFindings } = require('./cobolt-finding-dedup');
const { buildReviewPacket } = require('./cobolt-review-packet');
const { consolidate: consolidateReviewFindings } = require('./cobolt-review-tool-rollup');
const { buildCoverageReport } = require('./cobolt-review-coverage');
const { buildEvidenceIndex } = require('./cobolt-review-evidence-index');
const { buildAccuracyReport } = require('./cobolt-review-accuracy');
const { checkGate } = require('./cobolt-review-readiness-gate');
const { buildHandoff } = require('./cobolt-review-handoff');

const STEP_LABELS = {
  '00': 'preflight',
  '01': 'review-packet',
  '02': 'wave-1',
  '03': 'wave-2',
  '04': 'cross-validation',
  '05': 'coverage-gap',
  '06': 'report-handoff',
};

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] || 'run',
    step: null,
    reviewId: null,
    milestone: null,
    mode: 'pipeline',
    buildPipeline: false,
    allowDeterministicWave: false,
    json: false,
  };

  if (argv.includes('--help') || argv.includes('-h')) {
    args.command = 'help';
  }

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--step') args.step = normalizeStep(argv[++i]);
    else if (arg === '--review-id') args.reviewId = argv[++i];
    else if (arg === '--milestone') args.milestone = normalizeMilestone(argv[++i]);
    else if (arg === '--mode') args.mode = argv[++i] || args.mode;
    else if (arg === '--build-pipeline') args.buildPipeline = true;
    else if (arg === '--allow-deterministic-wave') args.allowDeterministicWave = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.command = 'help';
  }

  return args;
}

function normalizeMilestone(value) {
  const match = String(value || '')
    .trim()
    .match(/^M?(\d+)$/i);
  return match ? `M${Number.parseInt(match[1], 10)}` : null;
}

function normalizeStep(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  const match = raw.match(/^([0-9]{2})/);
  return match ? match[1] : null;
}

function projectPath(projectRoot, ...parts) {
  return path.join(projectRoot, ...parts);
}

function reviewDir(projectRoot) {
  return projectPath(projectRoot, '_cobolt-output', 'latest', 'review');
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function artifactRecord(projectRoot, filePath) {
  return {
    path: path.relative(projectRoot, filePath).replace(/\\/g, '/'),
    size: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
    sha256: fs.existsSync(filePath) ? sha256File(filePath) : null,
  };
}

function writeProof(projectRoot, reviewId, stepId, artifacts, evidence = {}) {
  const label = STEP_LABELS[stepId];
  const proofPath = projectPath(
    projectRoot,
    '_cobolt-output',
    'latest',
    'review',
    'proofs',
    `${reviewId}-${stepId}-${label}.proof.json`,
  );
  const existingArtifacts = artifacts.filter((artifact) => fs.existsSync(artifact));
  writeJson(proofPath, {
    step: `${stepId}-${label}`,
    status: evidence.proofStatus || 'passed',
    milestone: reviewId,
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-review-step',
    artifacts: existingArtifacts.map((artifact) => artifactRecord(projectRoot, artifact)),
    evidence,
  });
  return proofPath;
}

function loadManifest(projectRoot) {
  return readJson(path.join(reviewDir(projectRoot), 'review-manifest.json'), {
    version: '2.0.0',
    generatedAt: new Date().toISOString(),
    updatedAt: null,
    reviewId: null,
    milestone: null,
    mode: 'pipeline',
    phase: 'P0',
    dispatched: [],
    completed: [],
    failed: [],
    reviewedFiles: [],
    findingsFiles: [],
    waves: {},
  });
}

function saveManifest(projectRoot, manifest) {
  manifest.updatedAt = new Date().toISOString();
  writeJson(path.join(reviewDir(projectRoot), 'review-manifest.json'), manifest);
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function normalizeSlash(value) {
  return String(value || '').replace(/\\/g, '/');
}

function loadScopedFiles(projectRoot, reviewId) {
  const dir = reviewDir(projectRoot);
  const packet = readJson(path.join(dir, `${reviewId}-review-packet.json`), {});
  const sourceManifest = readJson(path.join(dir, '00-source-file-manifest.json'), {});
  const candidates = [
    ...(Array.isArray(packet?.scope?.files) ? packet.scope.files : []),
    ...(Array.isArray(packet?.scope?.filesInScope) ? packet.scope.filesInScope : []),
    ...(Array.isArray(packet?.scope?.changedFiles) ? packet.scope.changedFiles : []),
    ...(Array.isArray(sourceManifest?.files) ? sourceManifest.files : []),
    ...(Array.isArray(sourceManifest?.emitted) ? sourceManifest.emitted : []),
  ];
  return unique(
    candidates
      .map((entry) => (typeof entry === 'string' ? entry : entry?.path || entry?.file || entry?.relativePath))
      .map(normalizeSlash)
      .filter((entry) => entry && !entry.includes('/bin/') && !entry.includes('/obj/')),
  );
}

function reviewerWave(wave) {
  return BASELINE_REVIEWERS.filter((reviewer) => reviewer.wave === wave);
}

function summaryForFindings(findings) {
  const summary = {
    total: findings.length,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    byPrefix: {},
  };
  for (const finding of findings) {
    const severity = String(finding.severity || 'medium').toLowerCase();
    if (summary.bySeverity[severity] === undefined) summary.bySeverity[severity] = 0;
    summary.bySeverity[severity] += 1;
    const prefix = String(finding.prefix || finding.id || 'CODE').match(/^[A-Z-]+/u)?.[0] || 'CODE';
    summary.byPrefix[prefix] = (summary.byPrefix[prefix] || 0) + 1;
  }
  return summary;
}

function normalizeFinding(finding, index, fallbackReviewId) {
  const prefix =
    toReviewerPrefix(finding?.prefix || finding?.id || finding?.reviewerAgent) || finding?.prefix || 'CODE';
  return {
    id: finding?.id || `${String(prefix).replace(/-/g, '')}${String(index + 1).padStart(3, '0')}`,
    prefix,
    severity: String(finding?.severity || 'medium').toLowerCase(),
    category: finding?.category || 'quality',
    description: finding?.description || finding?.title || finding?.issue || 'Review finding requires triage.',
    location: {
      file: normalizeSlash(finding?.location?.file || finding?.file || ''),
      line: Number(finding?.location?.line || finding?.line || 0),
      function: finding?.location?.function || finding?.function || null,
    },
    suggestedFix: finding?.suggestedFix || finding?.recommendation || finding?.suggestion || null,
    reviewerAgent: finding?.reviewerAgent || finding?.agent || finding?.reviewer || 'deterministic-reviewer',
    evidence: finding?.evidence || { codeSnippet: finding?.code || null, grepEvidence: null, toolCalls: [] },
    verification: finding?.verification || { status: 'unverified', confidence: 0, flags: [] },
    reviewId: finding?.reviewId || fallbackReviewId,
  };
}

function loadCurrentFindings(projectRoot, reviewId) {
  const data = readJson(path.join(reviewDir(projectRoot), 'review-findings.json'), {});
  const raw = Array.isArray(data?.findings) ? data.findings : Array.isArray(data) ? data : [];
  return raw.map((finding, index) => normalizeFinding(finding, index, reviewId));
}

function writeCanonicalFindings(projectRoot, reviewId, milestone, findings, manifest, phase = 'P2') {
  const reviewers = unique([...(manifest?.completed || []), ...findings.map((finding) => finding.reviewerAgent)]);
  const payload = {
    phase,
    milestone: milestone || reviewId,
    reviewId,
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-review-step',
    reviewers,
    findings,
    summary: summaryForFindings(findings),
    verification: {
      ranAt: null,
      verified: findings.filter((finding) => finding.verification?.status === 'verified').length,
      unverified: findings.filter((finding) => finding.verification?.status === 'unverified').length,
      rejected: findings.filter((finding) => finding.verification?.status === 'rejected').length,
      estimatedHallucinationRate: 0,
    },
  };
  writeJson(path.join(reviewDir(projectRoot), 'review-findings.json'), payload);
  return payload;
}

function writeReviewerDispatchRequest(projectRoot, reviewId, reviewer, scopedFiles) {
  const filePath = path.join(reviewDir(projectRoot), `${reviewId}-dispatch-${reviewer.prefix}.json`);
  if (!fs.existsSync(filePath)) {
    writeJson(filePath, {
      reviewId,
      reviewer: reviewer.agent,
      prefix: reviewer.prefix,
      generatedAt: new Date().toISOString(),
      generatedBy: 'cobolt-review-step',
      status: 'pending-model-review',
      filesInScope: scopedFiles,
      requiredOutput: `${reviewId}-findings-${reviewer.prefix}.json`,
    });
  }
  return filePath;
}

function appendDispatchLedger(projectRoot, stage, reviewer, evidenceRef) {
  const ledgerPath = projectPath(projectRoot, '_cobolt-output', 'audit', 'agent-dispatch-ledger.jsonl');
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const entry = {
    ts: new Date().toISOString(),
    skill: 'cobolt-review',
    stage,
    agent: reviewer.agent,
    team: `review-wave-${reviewer.wave}`,
    attempt: 1,
    verdict: 'queued',
    filesWritten: 1,
    findingsResolved: 0,
    failureArtifact: null,
    escalationTarget: null,
    evidenceRef,
    pid: process.pid,
    contextExecutionMode: 'model-review-required',
  };
  fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8');
  return ledgerPath;
}

function runWave(projectRoot, reviewId, milestone, waveNumber) {
  const dir = reviewDir(projectRoot);
  const reviewers = reviewerWave(waveNumber);
  const scopedFiles = loadScopedFiles(projectRoot, reviewId);
  const manifest = loadManifest(projectRoot);
  manifest.reviewId = manifest.reviewId || reviewId;
  manifest.milestone = manifest.milestone || milestone || reviewId;
  manifest.mode = manifest.mode || 'pipeline';
  manifest.phase = waveNumber === 1 ? 'P1' : 'P2';

  const dispatchFiles = [];
  for (const reviewer of reviewers) {
    const dispatchPath = writeReviewerDispatchRequest(projectRoot, reviewId, reviewer, scopedFiles);
    dispatchFiles.push(path.relative(projectRoot, dispatchPath).replace(/\\/g, '/'));
    appendDispatchLedger(projectRoot, `wave${waveNumber}`, reviewer, dispatchFiles[dispatchFiles.length - 1]);
  }

  const agents = reviewers.map((reviewer) => reviewer.agent);
  manifest.dispatched = unique([...(manifest.dispatched || []), ...agents]);
  manifest.completed = unique(manifest.completed || []);
  manifest.pending = unique([...(manifest.pending || []), ...agents]);
  manifest.failed = manifest.failed || [];
  manifest.reviewedFiles = unique(manifest.reviewedFiles || []);
  manifest.findingsFiles = unique(manifest.findingsFiles || []);
  manifest.dispatchFiles = unique([...(manifest.dispatchFiles || []), ...dispatchFiles]);
  manifest.waves = manifest.waves || {};
  manifest.waves[`wave${waveNumber}`] = {
    status: 'model-review-required',
    proofStatus: 'pending-review',
    executionMode: 'dispatch-scaffold',
    dispatched: agents,
    completed: [],
    pending: agents,
    failed: [],
    reviewedFiles: [],
    dispatchFiles,
    completedAt: new Date().toISOString(),
  };
  saveManifest(projectRoot, manifest);

  const summaryPath = path.join(dir, `${reviewId}-wave-${waveNumber}-summary.json`);
  const summary = {
    reviewId,
    milestone: milestone || reviewId,
    wave: waveNumber,
    generatedAt: new Date().toISOString(),
    executionMode: 'dispatch-scaffold',
    status: 'model-review-required',
    reviewersDispatched: agents.length,
    reviewersCompleted: 0,
    reviewersFailed: 0,
    findingsFilesProduced: 0,
    dispatchFilesProduced: dispatchFiles.length,
    failuresEscalatedToReviewLead: 0,
    reviewedFiles: 0,
    filesInScope: scopedFiles.length,
  };
  writeJson(summaryPath, summary);

  let failuresPath = null;
  if (waveNumber === 2) {
    failuresPath = path.join(dir, 'reviewer-failures.json');
    writeJson(failuresPath, {
      reviewId,
      milestone: milestone || reviewId,
      generatedAt: new Date().toISOString(),
      reviewerFailures: [],
      unresolved: [],
      escalated: [],
    });
  }

  const proofPath = writeProof(
    projectRoot,
    reviewId,
    waveNumber === 1 ? '02' : '03',
    [
      summaryPath,
      path.join(dir, 'review-manifest.json'),
      ...dispatchFiles.map((file) => path.join(projectRoot, file)),
      ...(failuresPath ? [failuresPath] : []),
    ],
    summary,
  );

  return {
    ok: true,
    step: waveNumber === 1 ? '02' : '03',
    status: 'model-review-required',
    summaryPath,
    proofPath,
  };
}

function latestGateLog(projectRoot) {
  const logPath = projectPath(projectRoot, '_cobolt-output', 'audit', 'codex-gate-log.jsonl');
  if (!fs.existsSync(logPath)) return null;
  const lines = fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.stage === 'review') return parsed;
    } catch {
      /* ignore malformed audit lines */
    }
  }
  return null;
}

function runPreflight(projectRoot, reviewId, milestone, mode = 'pipeline') {
  const dir = reviewDir(projectRoot);
  const gates = latestGateLog(projectRoot);
  const preflightPath = path.join(dir, `${reviewId}-preflight.json`);
  const payload = {
    reviewId,
    milestone: milestone || reviewId,
    mode,
    status: 'passed',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-review-step',
    gateCount: Array.isArray(gates?.results) ? gates.results.length : 0,
    gates: Array.isArray(gates?.results)
      ? gates.results.map((gate) => ({ name: gate.name, passed: gate.passed, hard: gate.hard }))
      : [],
    artifacts: [path.relative(projectRoot, preflightPath).replace(/\\/g, '/')],
  };
  writeJson(preflightPath, payload);
  const proofPath = writeProof(projectRoot, reviewId, '00', [preflightPath], payload);
  return { ok: true, step: '00', preflightPath, proofPath };
}

function runPacket(projectRoot, reviewId, milestone, mode = 'pipeline') {
  const dir = reviewDir(projectRoot);
  const packetResult = buildReviewPacket(projectRoot, {
    reviewDir: dir,
    reviewId,
    milestone: milestone || reviewId,
    mode,
  });

  const buildRegistryPath = milestone
    ? projectPath(projectRoot, '_cobolt-output', 'latest', 'build', milestone, `${milestone}-issues-registry.json`)
    : null;
  consolidateReviewFindings({
    reviewDir: dir,
    buildRegistry: buildRegistryPath,
    output: path.join(dir, 'review-findings.json'),
    summaryOutput: path.join(dir, 'review-findings-seed.json'),
    merge: true,
    json: true,
  });

  const artifacts = [
    packetResult.manifestPath,
    packetResult.packetPath,
    packetResult.markdownPath,
    packetResult.reviewManifestPath,
    path.join(dir, 'review-findings.json'),
    path.join(dir, 'review-findings-seed.json'),
  ];
  const proofPath = writeProof(projectRoot, reviewId, '01', artifacts, {
    mode,
    packet: path.relative(projectRoot, packetResult.packetPath).replace(/\\/g, '/'),
    seededFindings: fs.existsSync(path.join(dir, 'review-findings.json')),
  });
  return { ok: true, step: '01', packetPath: packetResult.packetPath, proofPath };
}

function readReviewerFindingFiles(projectRoot, reviewId) {
  const dir = reviewDir(projectRoot);
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`${reviewId}-findings-`) && name.endsWith('.json'))
    .map((name) => path.join(dir, name));
  const findings = [];
  for (const file of files) {
    const data = readJson(file, {});
    const raw = Array.isArray(data?.findings) ? data.findings : Array.isArray(data) ? data : [];
    for (const finding of raw) findings.push(normalizeFinding(finding, findings.length, reviewId));
  }
  return findings;
}

function runFindingVerifier(projectRoot) {
  const script = path.join(__dirname, 'cobolt-finding-verifier.js');
  return spawnSync(
    process.execPath,
    [
      script,
      '--input',
      '_cobolt-output/latest/review/review-findings.json',
      '--output',
      '_cobolt-output/latest/review/finding-verification.json',
      '--strict',
      '--project-root',
      projectRoot,
    ],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
}

function writeZeroFindingVerification(projectRoot) {
  const outputPath = path.join(reviewDir(projectRoot), 'finding-verification.json');
  const payload = {
    generatedAt: new Date().toISOString(),
    version: 3,
    config: {
      sampleRate: 100,
      strict: true,
      autoStrip: true,
    },
    stats: { total: 0, verified: 0, unverified: 0, rejected: 0 },
    agentPhantomRates: {},
    perAgent: {},
    hallucination: {
      estimatedRate: 0,
      pattern: 'No findings to verify.',
    },
    results: [],
  };
  writeJson(outputPath, payload);
  return outputPath;
}

function runCrossValidation(projectRoot, reviewId, milestone) {
  const dir = reviewDir(projectRoot);
  const manifest = loadManifest(projectRoot);
  const seedFindings = loadCurrentFindings(projectRoot, reviewId);
  const reviewerFindings = readReviewerFindingFiles(projectRoot, reviewId);
  const allFindings = [...seedFindings, ...reviewerFindings];

  const allPath = path.join(dir, 'all-findings.json');
  writeJson(allPath, {
    reviewId,
    milestone: milestone || reviewId,
    generatedAt: new Date().toISOString(),
    findings: allFindings,
    summary: summaryForFindings(allFindings),
  });

  const dedup = dedupFindings(allFindings);
  const dedupPath = path.join(dir, 'deduped-findings.json');
  writeJson(dedupPath, {
    reviewId,
    milestone: milestone || reviewId,
    generatedAt: new Date().toISOString(),
    input: allFindings.length,
    output: dedup.unique.length,
    duplicatesRemoved: dedup.duplicates.length,
    findings: dedup.unique,
    duplicates: dedup.duplicates,
    relatedFindings: dedup.related,
  });

  writeCanonicalFindings(projectRoot, reviewId, milestone, dedup.unique, manifest, 'P3');
  const verifier = runFindingVerifier(projectRoot);
  const verificationPath = path.join(dir, 'finding-verification.json');
  if (!fs.existsSync(verificationPath) && dedup.unique.length === 0) {
    writeZeroFindingVerification(projectRoot);
  }
  if (!fs.existsSync(verificationPath)) {
    return {
      ok: false,
      step: '04',
      reason: 'finding-verification-missing',
      stdout: verifier.stdout,
      stderr: verifier.stderr,
      exitCode: verifier.status,
    };
  }

  const verification = readJson(verificationPath, {});
  const canonicalFindings = loadCurrentFindings(projectRoot, reviewId);
  const verifierRecovered =
    verifier.status !== 0 &&
    canonicalFindings.every((finding) => finding.verification?.status !== 'rejected') &&
    Number(verification?.stats?.rejected || 0) > 0;
  if (verifier.status !== 0 && !verifierRecovered) {
    return {
      ok: false,
      step: '04',
      reason: 'finding-verification-failed',
      stdout: verifier.stdout,
      stderr: verifier.stderr,
      exitCode: verifier.status,
    };
  }

  const rejectedPath = path.join(dir, 'rejected-phantoms.json');
  if (!fs.existsSync(rejectedPath)) {
    writeJson(rejectedPath, { generatedAt: new Date().toISOString(), rejected: [] });
  }
  const conflictsPath = path.join(dir, 'cross-category-conflicts.json');
  writeJson(conflictsPath, {
    reviewId,
    generatedAt: new Date().toISOString(),
    conflicts: dedup.related || [],
  });
  const failuresPath = path.join(dir, 'failures-summary.json');
  const reviewerFailures = readJson(path.join(dir, 'reviewer-failures.json'), { reviewerFailures: [] });
  const blockingFindings = canonicalFindings.filter((finding) =>
    ['critical', 'high'].includes(String(finding.severity || '').toLowerCase()),
  );
  writeJson(failuresPath, {
    reviewId,
    generatedAt: new Date().toISOString(),
    gate_failures: [],
    reviewer_failures: reviewerFailures.reviewerFailures || [],
    blocking_findings: blockingFindings,
    verification_failures: [],
    reviewerFailures: reviewerFailures.reviewerFailures || [],
    unresolved: reviewerFailures.unresolved || [],
    escalated: reviewerFailures.escalated || [],
  });

  const reportPath = path.join(dir, 'cross-validation-report.json');
  const report = {
    reviewId,
    milestone: milestone || reviewId,
    generatedAt: new Date().toISOString(),
    passed: true,
    beforeDedup: allFindings.length,
    afterDedup: dedup.unique.length,
    afterVerification: canonicalFindings.length,
    duplicatesRemoved: dedup.duplicates.length,
    relatedFindings: (dedup.related || []).length,
    phantomRate: verification?.hallucination?.estimatedRate || 0,
    verificationStats: verification?.stats || {},
    verifierRecovered,
  };
  writeJson(reportPath, report);

  manifest.phase = 'P3';
  manifest.crossValidation = {
    status: 'completed',
    report: path.relative(projectRoot, reportPath).replace(/\\/g, '/'),
  };
  saveManifest(projectRoot, manifest);

  const proofPath = writeProof(
    projectRoot,
    reviewId,
    '04',
    [
      allPath,
      dedupPath,
      path.join(dir, 'review-findings.json'),
      path.join(dir, 'finding-verification.json'),
      reportPath,
      failuresPath,
    ],
    report,
  );

  return { ok: true, step: '04', reportPath, proofPath };
}

function runCoverage(projectRoot, reviewId) {
  const dir = reviewDir(projectRoot);
  const coverage = buildCoverageReport(dir, { reviewId });
  const manifest = loadManifest(projectRoot);
  manifest.phase = 'P4';
  manifest.coverage = {
    status: coverage.passed ? 'passed' : 'partial',
    coverageRatio: coverage.scope?.coverageRatio,
    missingPrefixes: coverage.prefixes?.missing || [],
  };
  saveManifest(projectRoot, manifest);

  const proofPath = writeProof(
    projectRoot,
    reviewId,
    '05',
    [path.join(dir, 'coverage-gaps.json'), path.join(dir, `${reviewId}-coverage-verdict.json`)],
    {
      passed: coverage.passed,
      filesInScope: coverage.scope?.totalFiles,
      reviewedFiles: coverage.scope?.reviewedFiles,
      missingPrefixes: coverage.prefixes?.missing || [],
    },
  );
  return { ok: true, step: '05', coveragePath: path.join(dir, `${reviewId}-coverage-verdict.json`), proofPath };
}

function buildReviewReport(projectRoot, reviewId, handoff) {
  const dir = reviewDir(projectRoot);
  const findings = readJson(path.join(dir, 'review-findings.json'), { findings: [], summary: {} });
  const verification = readJson(path.join(dir, 'finding-verification.json'), { stats: {} });
  const coverage = readJson(path.join(dir, `${reviewId}-coverage-verdict.json`), {});
  const failures = readJson(path.join(dir, 'failures-summary.json'), {});
  const lines = [
    `# ${reviewId} Review Report`,
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Findings',
    '',
    `- Total: ${findings.summary?.total || 0}`,
    `- Critical: ${findings.summary?.bySeverity?.critical || 0}`,
    `- High: ${findings.summary?.bySeverity?.high || 0}`,
    `- Medium: ${findings.summary?.bySeverity?.medium || 0}`,
    `- Low: ${findings.summary?.bySeverity?.low || 0}`,
    `- Blocking: ${handoff?.findings?.blocking?.length || 0}`,
    '',
    '## Verification',
    '',
    `- Verified: ${verification.stats?.verified || 0}`,
    `- Unverified: ${verification.stats?.unverified || 0}`,
    `- Rejected: ${verification.stats?.rejected || 0}`,
    `- Estimated hallucination rate: ${verification.hallucination?.estimatedRate || 0}%`,
    '',
    '## Scope',
    '',
    `- Review ID: ${reviewId}`,
    `- Mode: ${handoff?.mode || 'pipeline'}`,
    `- Files reviewed: ${coverage.scope?.reviewedFiles ?? 'unknown'} / ${coverage.scope?.totalFiles ?? 'unknown'}`,
    `- Reviewer prefixes covered: ${(coverage.prefixes?.completed || []).join(', ') || 'none'}`,
    '',
    '## Failure Handling',
    '',
    `- Reviewer failures: ${(failures.reviewerFailures || []).length}`,
    `- Unresolved failures: ${(failures.unresolved || []).length}`,
    '',
    '## Recommended Next Step',
    '',
    `- ${handoff?.recommendedNextStep?.skill || 'none'} ${handoff?.recommendedNextStep?.args || ''}`.trim(),
    '',
    '## Finding Details',
    '',
    ...(findings.findings || []).map(
      (finding) =>
        `- ${finding.id} [${String(finding.severity || 'medium').toUpperCase()}] ${finding.location?.file || 'unknown'}:${finding.location?.line || 0} - ${finding.description}`,
    ),
    ...((findings.findings || []).length === 0 ? ['- No findings recorded.'] : []),
    '',
  ];

  const reportPath = projectPath(projectRoot, '_cobolt-output', 'reports', reviewId, `${reviewId}-review-report.md`);
  atomicWrite(reportPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  return reportPath;
}

function runReportHandoff(projectRoot, reviewId, milestone, options = {}) {
  const dir = reviewDir(projectRoot);
  buildEvidenceIndex(dir);
  buildAccuracyReport(dir);
  checkGate(dir);
  let handoff = buildHandoff(dir, { buildPipeline: options.buildPipeline });
  const reportPath = buildReviewReport(projectRoot, reviewId, handoff);
  buildEvidenceIndex(dir);
  buildAccuracyReport(dir);
  checkGate(dir);
  handoff = buildHandoff(dir, { buildPipeline: options.buildPipeline });

  const manifest = loadManifest(projectRoot);
  manifest.phase = 'P5';
  manifest.handoff = {
    status: handoff.reviewIntegrity?.passed === false ? 'partial' : 'passed',
    nextSkill: handoff.recommendedNextStep?.skill || null,
  };
  saveManifest(projectRoot, manifest);

  const proofPath = writeProof(
    projectRoot,
    reviewId,
    '06',
    [
      path.join(dir, 'review-evidence-index.json'),
      path.join(dir, 'review-accuracy-report.json'),
      path.join(dir, 'review-readiness-gate.json'),
      path.join(dir, 'review-handoff.json'),
      path.join(dir, 'review-decision-log.md'),
      reportPath,
    ],
    {
      handoffPassed: handoff.reviewIntegrity?.passed !== false,
      nextStep: handoff.recommendedNextStep || null,
      milestone: milestone || reviewId,
    },
  );

  return { ok: true, step: '06', reportPath, proofPath, handoffPath: path.join(dir, 'review-handoff.json') };
}

function run(args = parseArgs()) {
  if (args.command !== 'run') {
    return {
      ok: args.command === 'help',
      usage:
        'node tools/cobolt-review-step.js run --step 00|01|02|03|04|05|06 --review-id M1 [--milestone M1] [--build-pipeline] [--allow-deterministic-wave] [--json]',
    };
  }

  const stepId = normalizeStep(args.step);
  const reviewId = args.reviewId || args.milestone;
  if (!reviewId) return { ok: false, reason: 'review-id-required' };
  if (!STEP_LABELS[stepId]) return { ok: false, reason: 'unsupported-step', step: args.step };

  const projectRoot = process.cwd();
  if (stepId === '00') return runPreflight(projectRoot, reviewId, args.milestone, args.mode);
  if (stepId === '01') return runPacket(projectRoot, reviewId, args.milestone, args.mode);
  if (stepId === '02' || stepId === '03') {
    const allowed = args.allowDeterministicWave || process.env.COBOLT_REVIEW_ALLOW_DETERMINISTIC_WAVES === '1';
    if (!allowed) {
      return {
        ok: false,
        step: stepId,
        reason: 'review-wave-requires-model-dispatch',
        message:
          'Review waves must run through the cobolt-review step prompt so reviewer agents inspect code and write grounded findings.',
      };
    }
    return runWave(projectRoot, reviewId, args.milestone, stepId === '02' ? 1 : 2);
  }
  if (stepId === '04') return runCrossValidation(projectRoot, reviewId, args.milestone);
  if (stepId === '05') return runCoverage(projectRoot, reviewId);
  if (stepId === '06') {
    return runReportHandoff(projectRoot, reviewId, args.milestone, { buildPipeline: args.buildPipeline });
  }
  return { ok: false, reason: 'unsupported-step', step: stepId };
}

if (require.main === module) {
  const args = parseArgs();
  const result = run(args);
  if (args.json || result.usage) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.ok) {
    console.error(`[cobolt-review-step] FAILED: ${result.reason || 'unknown'}`);
  } else {
    console.log(`[cobolt-review-step] Step ${result.step} completed`);
  }
  process.exit(result.ok ? 0 : 1);
}

module.exports = {
  buildReviewReport,
  loadScopedFiles,
  parseArgs,
  run,
  runCrossValidation,
  runCoverage,
  runPacket,
  runPreflight,
  runReportHandoff,
  runWave,
};
