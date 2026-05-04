#!/usr/bin/env node

// CoBolt Fix Verdict - Deterministic verification loop decision.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const plateauSig = require('./cobolt-fix-loop-plateau.js');

const ACTIONABLE_STATUSES = new Set([
  'open',
  'assigned',
  'fix-applied',
  'fix-applied-unverified',
  'fix-applied-failing',
  'fix-applied-no-test',
  'stalled',
]);

const PARTIAL_STATUSES = new Set(['carry-forward', 'deferred']);
const FIX_LOG_CANDIDATES = ['fix-iteration-log.json', 'fix-accountability-log.json'];
// B009 — skip/skipped removed from passing. Skipped required steps are NOT verified.
const PASSING_STEP_STATUSES = new Set(['pass', 'passed', 'resolved']);
const SKIPPED_STEP_STATUSES = new Set(['skip', 'skipped', 'not-applicable']);
const FAILING_STEP_STATUSES = new Set(['fail', 'failed', 'persists', 'partial', 'new-issues']);
const INCOMPLETE_STEP_STATUSES = new Set(['pending', 'incomplete']);
const TROUBLESHOOTING_ARTIFACT_FILES = {
  dossier: 'troubleshooting-dossier.json',
  failureCapture: 'failure-capture.json',
  minimalRepro: 'minimal-repro.json',
  hypothesisLog: 'hypothesis-log.json',
};
const FLOW_LEDGER_FILE = 'flow-ledger.json';
const TERMINAL_HYPOTHESIS_STATUSES = new Set(['confirmed', 'rejected', 'inconclusive']);
const TERMINAL_EXPERIMENT_RESULTS = new Set(['pass', 'fail', 'inconclusive']);
const PLATEAU_METRIC_VERDICTS = new Set([
  'LOOP_PIVOT',
  'LOOP_ARCH_ESCALATE',
  'LOOP_ARCH_MUTATE',
  'LOOP_INTEGRATION_PLATEAU',
]);

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function chainFilePath(trackerPath, iteration) {
  return path.join(path.dirname(trackerPath), 'chains', `fix-artifact-chain-iter-${iteration}.json`);
}

function resolveIterationArtifactPaths(trackerPath, iteration, verificationPath = null) {
  if (!trackerPath) return [];

  const fixDir = path.dirname(trackerPath);
  const candidates = [
    trackerPath,
    path.join(fixDir, `fix-routing-iter-${iteration}.json`),
    verificationPath || path.join(fixDir, `verification-iter-${iteration}.json`),
    path.join(fixDir, 'iteration-scope.json'),
    path.join(fixDir, 'scoped-review-context.json'),
    path.join(fixDir, 'fix-failures.json'),
    path.join(fixDir, FLOW_LEDGER_FILE),
  ];

  return [...new Set(candidates.filter((candidate) => candidate && fs.existsSync(candidate)))];
}

function verifyPreviousArtifactChain(trackerPath, iteration) {
  if (!trackerPath || iteration <= 1) {
    return { passed: true, skipped: !trackerPath ? 'no-tracker-path' : 'no-previous-iteration' };
  }

  const previousChainPath = chainFilePath(trackerPath, iteration - 1);
  if (!fs.existsSync(previousChainPath)) {
    return { passed: true, skipped: 'missing-chain-record', previousIteration: iteration - 1 };
  }

  let chainRecord;
  try {
    chainRecord = JSON.parse(fs.readFileSync(previousChainPath, 'utf8'));
  } catch (error) {
    return {
      passed: false,
      issue: `Previous fix artifact chain is unreadable: ${previousChainPath} (${error.message})`,
      previousIteration: iteration - 1,
    };
  }

  for (const artifact of chainRecord.artifacts || []) {
    if (!fs.existsSync(artifact.path)) {
      return {
        passed: false,
        issue: `Chained fix artifact missing before iteration ${iteration}: ${artifact.path}`,
        previousIteration: iteration - 1,
      };
    }

    const currentHash = sha256File(artifact.path);
    if (currentHash !== artifact.sha256) {
      return {
        passed: false,
        issue:
          `Fix artifact drift detected before iteration ${iteration}: ${artifact.path}\n` +
          `expected ${artifact.sha256}, got ${currentHash}`,
        previousIteration: iteration - 1,
      };
    }
  }

  return { passed: true, previousIteration: iteration - 1, chainPath: previousChainPath };
}

function writeIterationArtifactChain(trackerPath, iteration, artifactPaths) {
  if (!trackerPath) return null;

  const resolvedArtifacts = [...new Set((artifactPaths || []).filter((artifactPath) => fs.existsSync(artifactPath)))];
  if (resolvedArtifacts.length === 0) return null;

  const outputPath = chainFilePath(trackerPath, iteration);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const record = {
    iteration,
    trackerPath,
    recordedAt: new Date().toISOString(),
    previousIteration: iteration > 1 ? iteration - 1 : null,
    artifacts: resolvedArtifacts.map((artifactPath) => ({
      path: artifactPath,
      sha256: sha256File(artifactPath),
      size: fs.statSync(artifactPath).size,
    })),
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return outputPath;
}

// Tier 5.1 (v0.11.0): classify findings for architecture escalation.
// Returns {dominant, count, label} when integration/architecture/contract
// findings comprise >= 50% of actionable findings — the whack-a-mole signal
// that points to a structural, not local, problem.
function classifyForArchitectureEscalation(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return { dominant: null, count: 0 };
  const CATEGORIES = {
    INT: { label: 'integration', pattern: /^(INT|API|CONTRACT)-/i },
    ARCH: { label: 'architecture', pattern: /^ARCH-/i },
  };
  const counts = { INT: 0, ARCH: 0 };
  for (const f of findings) {
    const id = String(f?.id || '');
    for (const [k, c] of Object.entries(CATEGORIES)) if (c.pattern.test(id)) counts[k]++;
  }
  const intArchTotal = counts.INT + counts.ARCH;
  if (intArchTotal === 0) return { dominant: null, count: 0 };
  const ratio = intArchTotal / findings.length;
  if (ratio < 0.5) return { dominant: null, count: intArchTotal };
  const dominant = counts.ARCH >= counts.INT ? 'ARCH' : 'INT';
  return { dominant, count: intArchTotal, label: CATEGORIES[dominant].label };
}

function bumpPlateauMetric() {
  try {
    const fsMod = require('node:fs');
    const pMod = require('node:path');
    const { execFileSync } = require('node:child_process');
    const tool = [
      pMod.join(process.cwd(), 'tools', 'cobolt-production-readiness.js'),
      process.env.COBOLT_TOOLS && pMod.join(process.env.COBOLT_TOOLS, 'cobolt-production-readiness.js'),
      pMod.join(__dirname, 'cobolt-production-readiness.js'),
    ].find((p) => p && fsMod.existsSync(p));
    if (tool) execFileSync('node', [tool, 'record', 'fixLoopPlateaus', '1'], { stdio: 'ignore' });
  } catch {
    /* non-fatal */
  }
}

function detectStall(iterationLog) {
  if (!Array.isArray(iterationLog) || iterationLog.length < 3) return false;

  const last3 = iterationLog.slice(-3);
  const openSets = last3.map((iteration) =>
    (iteration.openFindings || iteration.remaining || iteration.remainingFindings || [])
      .map((finding) => (typeof finding === 'string' ? finding : finding.id))
      .sort()
      .join(','),
  );

  if (openSets[0] === openSets[1] && openSets[1] === openSets[2] && openSets[0] !== '') {
    return true;
  }

  const remainingCounts = last3
    .map((iteration) => iteration.findingsRemaining)
    .filter((count) => Number.isInteger(count));
  return (
    remainingCounts.length === 3 &&
    remainingCounts[0] === remainingCounts[1] &&
    remainingCounts[1] === remainingCounts[2]
  );
}

// CORAL-inspired: detect zero-progress plateau where finding count stays flat or
// increases across consecutive iterations even though specific findings may change.
// Unlike detectStall (same IDs for 3 rounds), this catches the "whack-a-mole"
// pattern where fixes resolve some findings but introduce equally many new ones.
function countPriorVerdict(iterationLog, verdictName) {
  if (!Array.isArray(iterationLog)) return 0;
  return iterationLog.filter((e) => e && e.verdict === verdictName).length;
}

function detectPlateau(iterationLog) {
  if (!Array.isArray(iterationLog) || iterationLog.length < 2) {
    return { detected: false, reason: null };
  }

  const counts = iterationLog
    .map((iteration) => {
      if (Number.isInteger(iteration.findingsRemaining)) return iteration.findingsRemaining;
      const openList = iteration.openFindings || iteration.remaining || iteration.remainingFindings;
      if (Array.isArray(openList)) return openList.length;
      return null;
    })
    .filter((count) => count !== null);

  if (counts.length < 3) {
    return { detected: false, reason: null, droppedEntries: iterationLog.length - counts.length };
  }

  // Check last 3 entries for non-decreasing actionable count.
  // Requires 3 readings (2 non-improving intervals) to avoid false positives
  // from a single hard-to-fix iteration.
  const window = counts.slice(-3);
  let flatOrRising = true;
  for (let i = 1; i < window.length; i++) {
    if (window[i] < window[i - 1]) {
      flatOrRising = false;
      break;
    }
  }

  if (!flatOrRising) return { detected: false, reason: null, droppedEntries: iterationLog.length - counts.length };

  const droppedEntries = iterationLog.length - counts.length;

  // Only signal plateau when at least 2 consecutive non-improving intervals exist
  const delta = window[window.length - 1] - window[0];
  if (delta > 0) {
    return {
      detected: true,
      reason: `Finding count increased from ${window[0]} to ${window[window.length - 1]} across ${window.length} iterations — fixes are introducing new issues`,
      trend: 'increasing',
      window,
      droppedEntries,
    };
  }

  return {
    detected: true,
    reason: `Finding count flat at ${window[0]} across ${window.length} iterations — different findings but no net progress`,
    trend: 'flat',
    window,
    droppedEntries,
  };
}

function normalizeStepStatus(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function coerceIterationLog(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.iterations)) return value.iterations;
  return [];
}

function readJsonArtifact(filePath) {
  if (!fs.existsSync(filePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return { __parseError: error.message };
  }
}

function hasFailureCapturePayload(payload) {
  if (!payload || payload.__parseError) return false;
  return Boolean(
    (typeof payload.command === 'string' && payload.command.trim()) ||
      (typeof payload.logFile === 'string' && payload.logFile.trim()) ||
      (typeof payload.errorText === 'string' && payload.errorText.trim()) ||
      (typeof payload.firstMeaningfulError === 'string' && payload.firstMeaningfulError.trim()),
  );
}

function caseHasValidatedHypothesis(entry) {
  if (!entry || !Array.isArray(entry.hypotheses)) return false;

  return entry.hypotheses.some((hypothesis) => {
    const status = String(hypothesis?.status || '').toLowerCase();
    const experimentResult = String(hypothesis?.experiment?.result || '').toLowerCase();
    return TERMINAL_HYPOTHESIS_STATUSES.has(status) || TERMINAL_EXPERIMENT_RESULTS.has(experimentResult);
  });
}

function inspectTroubleshootingArtifacts(tracker, trackerPath) {
  if (!trackerPath) {
    return {
      reasons: [],
      requirements: {
        requireOriginalFailureReplay: false,
        requireMinimalReproReplay: false,
      },
      artifacts: {},
    };
  }

  const fixDir = path.dirname(trackerPath);
  const findings = Array.isArray(tracker.findings) ? tracker.findings : [];
  const artifactPaths = Object.fromEntries(
    Object.entries(TROUBLESHOOTING_ARTIFACT_FILES).map(([key, fileName]) => [key, path.join(fixDir, fileName)]),
  );
  const artifacts = Object.fromEntries(
    Object.entries(artifactPaths).map(([key, filePath]) => [key, readJsonArtifact(filePath)]),
  );
  const reasons = [];

  const dossierCases = Array.isArray(artifacts.dossier?.cases) ? artifacts.dossier.cases : [];
  const minimalReproCases = Array.isArray(artifacts.minimalRepro?.cases) ? artifacts.minimalRepro.cases : [];
  const hypothesisCases = Array.isArray(artifacts.hypothesisLog?.cases) ? artifacts.hypothesisLog.cases : [];
  const isStandalone =
    artifacts.dossier?.mode === 'standalone' ||
    String(tracker.source || tracker.generatedFrom || '').toLowerCase() === 'recon';

  if (!artifacts.dossier) {
    reasons.push('missing-troubleshooting-dossier');
  } else if (artifacts.dossier.__parseError) {
    reasons.push('troubleshooting-dossier-corrupt');
  } else if (findings.length > 0 && dossierCases.length < findings.length) {
    reasons.push('troubleshooting-dossier-incomplete');
  }

  if (!artifacts.minimalRepro) {
    reasons.push('missing-minimal-repro');
  } else if (artifacts.minimalRepro.__parseError) {
    reasons.push('minimal-repro-corrupt');
  } else if (findings.length > 0 && minimalReproCases.length < findings.length) {
    reasons.push('minimal-repro-incomplete');
  }

  if (!artifacts.hypothesisLog) {
    reasons.push('missing-hypothesis-log');
  } else if (artifacts.hypothesisLog.__parseError) {
    reasons.push('hypothesis-log-corrupt');
  } else if (findings.length > 0 && hypothesisCases.length < findings.length) {
    reasons.push('hypothesis-log-incomplete');
  } else {
    for (const entry of hypothesisCases) {
      if (!Array.isArray(entry.hypotheses) || entry.hypotheses.length < 2) {
        reasons.push(`hypothesis-log-too-thin:${entry.findingId || entry.id || 'unknown'}`);
        continue;
      }

      if (!caseHasValidatedHypothesis(entry)) {
        reasons.push(`hypotheses-unvalidated:${entry.findingId || entry.id || 'unknown'}`);
      }
    }
  }

  if (isStandalone) {
    if (!artifacts.failureCapture) {
      reasons.push('missing-failure-capture');
    } else if (artifacts.failureCapture.__parseError) {
      reasons.push('failure-capture-corrupt');
    } else if (!hasFailureCapturePayload(artifacts.failureCapture)) {
      reasons.push('failure-capture-incomplete');
    }
  }

  return {
    reasons,
    requirements: {
      requireOriginalFailureReplay: hasFailureCapturePayload(artifacts.failureCapture),
      requireMinimalReproReplay:
        Array.isArray(minimalReproCases) &&
        minimalReproCases.some((entry) => entry?.validationPlan?.rerunMinimalCase === true),
    },
    artifacts,
  };
}

function inspectFlowLedger(tracker, trackerPath) {
  if (!trackerPath) {
    return {
      reasons: [],
      path: null,
      summary: {
        totalEntries: 0,
        verifiedWorking: 0,
        broken: 0,
        blocked: 0,
        notYetVerified: 0,
      },
      hasBrokenOrBlocked: false,
    };
  }

  const flowLedgerPath = path.join(path.dirname(trackerPath), FLOW_LEDGER_FILE);
  if (!fs.existsSync(flowLedgerPath)) {
    return {
      reasons: ['missing-flow-ledger'],
      path: flowLedgerPath,
      summary: null,
      hasBrokenOrBlocked: false,
    };
  }

  const payload = readJsonArtifact(flowLedgerPath);
  if (!payload) {
    return {
      reasons: ['missing-flow-ledger'],
      path: flowLedgerPath,
      summary: null,
      hasBrokenOrBlocked: false,
    };
  }
  if (payload.__parseError) {
    return {
      reasons: ['flow-ledger-corrupt'],
      path: flowLedgerPath,
      summary: null,
      hasBrokenOrBlocked: false,
    };
  }

  const flows = Array.isArray(payload.flows) ? payload.flows : [];
  if (Array.isArray(tracker.findings) && tracker.findings.length > 0 && flows.length === 0) {
    return {
      reasons: ['flow-ledger-empty'],
      path: flowLedgerPath,
      summary: {
        totalEntries: 0,
        verifiedWorking: 0,
        broken: 0,
        blocked: 0,
        notYetVerified: 0,
      },
      hasBrokenOrBlocked: false,
    };
  }

  const summary = {
    totalEntries: flows.length,
    verifiedWorking: flows.filter((entry) => entry?.status === 'verified-working').length,
    broken: flows.filter((entry) => entry?.status === 'broken').length,
    blocked: flows.filter((entry) => entry?.status === 'blocked').length,
    notYetVerified: flows.filter((entry) => entry?.status === 'not-yet-verified').length,
  };

  return {
    reasons: [],
    path: flowLedgerPath,
    summary,
    hasBrokenOrBlocked: summary.broken + summary.blocked > 0,
  };
}

function evaluateVerification(verificationResult, options = {}) {
  if (!verificationResult) {
    return {
      passed: false,
      complete: false,
      reasons: ['missing-verification-artifact'],
      incompleteReasons: ['missing-verification-artifact'],
      steps: {},
    };
  }

  const steps = {
    toolGate: normalizeStepStatus(verificationResult.toolGate ?? verificationResult.toolGateResult),
    regression: normalizeStepStatus(
      verificationResult.regressionTests ?? verificationResult.regression ?? verificationResult.testSuiteResult,
    ),
    originalFailureReplay: normalizeStepStatus(
      verificationResult.originalFailureReplay ?? verificationResult.originalFailureReplayResult,
    ),
    minimalReproReplay: normalizeStepStatus(
      verificationResult.minimalReproReplay ?? verificationResult.minimalReproReplayResult,
    ),
    scopedReview: normalizeStepStatus(
      verificationResult.scopedReview ?? verificationResult.reReviewResult ?? verificationResult.scopedReviewResult,
    ),
    browserSmoke: normalizeStepStatus(
      verificationResult.browserSmoke ?? verificationResult.browserSmokeResult ?? verificationResult.uiSmokeResult,
    ),
    uatRegression: normalizeStepStatus(
      verificationResult.uatRegression ?? verificationResult.uatRegressionResult ?? verificationResult.uatResult,
    ),
  };

  const reasons = [];
  const incompleteReasons = [];

  // v0.40.5 Issue 10 — ordered verification-chain guarantee.
  //
  // The verification chain MUST execute in the declared order:
  //   toolGate → regression → (originalFailureReplay/minimalReproReplay) →
  //   scopedReview → browserSmoke → uatRegression
  //
  // If the iteration artifact includes `stepOrder: ["toolGate", ...]`, we
  // verify that no later step was run before an earlier one AND that every
  // required step appears in the sequence. Absence of `stepOrder` is
  // tolerated for back-compat (older iterations); presence is strictly
  // validated. Callers (05-verification.md / run-verification.sh) are
  // instructed to emit `stepOrder` in v0.40.5+.
  //
  // This turns the "ordered chain" from a markdown claim into a verifiable
  // contract, closing the class where a conditional skip silently disabled
  // a later step (browserSmoke run without scopedReview, etc.).
  const CANONICAL_ORDER = [
    'toolGate',
    'regression',
    'originalFailureReplay',
    'minimalReproReplay',
    'scopedReview',
    'browserSmoke',
    'uatRegression',
  ];
  // v0.40.5 Issue 10 — stepOrder may live on the iteration artifact OR on the
  // verification result itself, depending on which emitter produced it.
  // Accept both; caller passes the iteration artifact via options when available.
  const iterationArtifact = options?.iterationArtifact || verificationResult || null;
  const stepOrder = Array.isArray(iterationArtifact?.stepOrder)
    ? iterationArtifact.stepOrder.filter((s) => typeof s === 'string' && CANONICAL_ORDER.includes(s))
    : null;
  if (stepOrder && stepOrder.length > 0) {
    let lastIdx = -1;
    for (const name of stepOrder) {
      const idx = CANONICAL_ORDER.indexOf(name);
      if (idx < 0) continue;
      if (idx < lastIdx) {
        reasons.push(`order-violation:${name}-ran-before-${CANONICAL_ORDER[lastIdx]}`);
        break;
      }
      lastIdx = idx;
    }
  }

  if (FAILING_STEP_STATUSES.has(steps.toolGate)) reasons.push('tool-gate-failed');
  if (FAILING_STEP_STATUSES.has(steps.regression)) reasons.push('regression-tests-failed');
  if (steps.originalFailureReplay && FAILING_STEP_STATUSES.has(steps.originalFailureReplay)) {
    reasons.push('original-failure-replay-failed');
  }
  if (steps.minimalReproReplay && FAILING_STEP_STATUSES.has(steps.minimalReproReplay)) {
    reasons.push('minimal-repro-replay-failed');
  }
  if (FAILING_STEP_STATUSES.has(steps.scopedReview)) reasons.push('scoped-review-failed');
  if (FAILING_STEP_STATUSES.has(steps.browserSmoke)) reasons.push('browser-smoke-failed');
  if (FAILING_STEP_STATUSES.has(steps.uatRegression)) reasons.push('uat-regression-failed');

  const requiredSteps = {
    toolGate: true,
    regression: true,
    originalFailureReplay: Boolean(options.requireOriginalFailureReplay),
    minimalReproReplay: Boolean(options.requireMinimalReproReplay),
    scopedReview: true,
    browserSmoke: true,
    uatRegression: Boolean(options.requireUatRegression),
  };

  for (const [stepName, stepValue] of Object.entries(steps)) {
    if (!requiredSteps[stepName] && !stepValue) continue;

    if (!stepValue || INCOMPLETE_STEP_STATUSES.has(stepValue)) {
      if (!requiredSteps[stepName]) continue;
      incompleteReasons.push(`${stepName}-pending`);
      continue;
    }

    // B009 — skipped required steps are NOT verified, treat as incomplete
    if (SKIPPED_STEP_STATUSES.has(stepValue)) {
      if (requiredSteps[stepName]) {
        incompleteReasons.push(`${stepName}-skipped`);
      }
      continue;
    }

    if (!PASSING_STEP_STATUSES.has(stepValue) && !FAILING_STEP_STATUSES.has(stepValue)) {
      if (!requiredSteps[stepName]) continue;
      incompleteReasons.push(`${stepName}-unknown:${stepValue}`);
    }
  }

  return {
    passed: reasons.length === 0 && incompleteReasons.length === 0,
    complete: incompleteReasons.length === 0,
    reasons,
    incompleteReasons,
    steps,
  };
}

function classifyVerificationReason(reason) {
  if (!reason) return 'verification';
  if (reason.startsWith('tool-gate') || reason.startsWith('toolGate')) return 'tool-gate';
  if (reason.startsWith('regression-tests') || reason.startsWith('regression')) return 'regression-tests';
  if (reason.startsWith('original-failure-replay') || reason.startsWith('originalFailureReplay')) {
    return 'original-failure-replay';
  }
  if (reason.startsWith('minimal-repro-replay') || reason.startsWith('minimalReproReplay')) {
    return 'minimal-repro-replay';
  }
  if (reason.startsWith('uat-regression') || reason.startsWith('uatRegression')) return 'uat-regression';
  if (reason.startsWith('scoped-review') || reason.startsWith('scopedReview')) return 'scoped-review';
  if (reason.startsWith('browser-smoke') || reason.startsWith('browserSmoke')) return 'browser-smoke';
  return 'verification';
}

function buildBlockerSummary({
  verification,
  troubleshootingReasons = [],
  flowLedger = null,
  artifactChain = null,
  totalActionable = 0,
  totalPartial = 0,
  stallDetected = false,
}) {
  const categories = {};

  function add(category, reason) {
    if (!categories[category]) {
      categories[category] = { category, count: 0, reasons: [] };
    }
    categories[category].count += 1;
    if (reason) {
      categories[category].reasons.push(reason);
    }
  }

  for (const reason of verification?.reasons || []) {
    add(classifyVerificationReason(reason), reason);
  }
  for (const reason of verification?.incompleteReasons || []) {
    add(classifyVerificationReason(reason), reason);
  }
  for (const reason of troubleshootingReasons) {
    add('troubleshooting-artifacts', reason);
  }
  for (const reason of flowLedger?.reasons || []) {
    add('flow-ledger', reason);
  }

  if (artifactChain && artifactChain.passed === false) {
    add('artifact-chain', artifactChain.issue);
  }
  if (flowLedger?.hasBrokenOrBlocked) {
    add(
      'flow-ledger',
      `${flowLedger.summary.broken + flowLedger.summary.blocked} flow(s) still marked broken or blocked`,
    );
  }
  if (totalActionable > 0) {
    add('open-findings', `${totalActionable} actionable findings remain`);
  }
  if (totalPartial > 0) {
    add('carry-forward', `${totalPartial} findings remain deferred or carry-forward`);
  }
  if (stallDetected) {
    add('stall-detected', 'Same findings remained open across the last 3 iterations');
  }

  const items = Object.values(categories);
  return {
    items,
    total: items.reduce((sum, item) => sum + item.count, 0),
    byCategory: Object.fromEntries(items.map((item) => [item.category, item.count])),
  };
}

function loadIterationLog(trackerPath, tracker) {
  if (Array.isArray(tracker.iterationLog) && tracker.iterationLog.length > 0) return tracker.iterationLog;
  if (Array.isArray(tracker.iterations) && tracker.iterations.length > 0) return tracker.iterations;

  for (const candidate of FIX_LOG_CANDIDATES) {
    const iterationLogPath = path.join(path.dirname(trackerPath), candidate);
    if (!fs.existsSync(iterationLogPath)) continue;

    try {
      const parsed = JSON.parse(fs.readFileSync(iterationLogPath, 'utf8'));
      const coerced = coerceIterationLog(parsed);
      if (coerced.length > 0 || Array.isArray(parsed) || Array.isArray(parsed?.iterations)) {
        return coerced;
      }
    } catch {
      return [];
    }
  }

  return [];
}

function computeVerdict(
  tracker,
  iteration,
  maxIterations,
  verificationResult,
  iterationLog = [],
  trackerPath = null,
  verificationPath = null,
) {
  const findings = tracker.findings || [];
  const counts = {
    open: 0,
    assigned: 0,
    'fix-applied': 0,
    'fix-applied-unverified': 0,
    'fix-applied-failing': 0,
    'fix-applied-no-test': 0,
    stalled: 0,
    'verified-resolved': 0,
    'carry-forward': 0,
    deferred: 0,
    phantom: 0,
  };

  for (const finding of findings) {
    const status = finding.status || 'open';
    counts[status] = (counts[status] || 0) + 1;
  }

  const totalActionable = [...ACTIONABLE_STATUSES].reduce((sum, status) => sum + (counts[status] || 0), 0);
  const totalResolved = counts['verified-resolved'] || 0;
  const totalPartial = [...PARTIAL_STATUSES].reduce((sum, status) => sum + (counts[status] || 0), 0);
  const total = findings.length;
  const isStalled = detectStall(iterationLog);
  const plateau = detectPlateau(iterationLog);
  const integrationShape = classifyForArchitectureEscalation(findings);
  // v0.13.1 Phase 2A — signature-based plateau (same bug reshaped across files).
  const signaturePlateau = plateauSig.detectSignaturePlateau(iterationLog, findings);
  const bcData = plateauSig.loadBoundedContexts();
  let crossBCSignature = null;
  if (signaturePlateau.detected) {
    for (const sig of signaturePlateau.signatures) {
      const crossing = plateauSig.classifyBCCrossing(sig, bcData);
      const unitAttempts = plateauSig.countSignatureUnitFixIterations(iterationLog, sig.hash);
      if (crossing.crossesBC && unitAttempts >= plateauSig.UNIT_FIX_ATTEMPT_CAP) {
        crossBCSignature = { ...sig, crossing, unitAttempts };
        break;
      }
    }
  }
  const currentSignatureBuckets = plateauSig.bucketSignaturesForFindings(findings);
  const currentSignatureHashes = [...currentSignatureBuckets.keys()];
  const troubleshooting = inspectTroubleshootingArtifacts(tracker, trackerPath);
  const flowLedger = inspectFlowLedger(tracker, trackerPath);
  const requireUatRegression =
    verificationResult?.uatRequired === true ||
    verificationResult?.uatRegressionRequired === true ||
    verificationResult?.uatRegression != null ||
    verificationResult?.uatRegressionResult != null ||
    findings.some(
      (finding) =>
        finding.prefix === 'UAT' ||
        String(finding.id || '').startsWith('UAT-') ||
        Boolean(finding.uatCaseId) ||
        Boolean(finding.uatCaseIds),
    );
  const verification = evaluateVerification(verificationResult, {
    ...troubleshooting.requirements,
    requireUatRegression,
  });
  const artifactChain = verifyPreviousArtifactChain(trackerPath, iteration);

  const cleanTerminalState =
    total > 0 && totalActionable === 0 && totalPartial === 0 && totalResolved + (counts.phantom || 0) === total;

  let verdict;
  let reason;
  let action;

  if (cleanTerminalState && artifactChain.passed === false) {
    verdict = 'LOOP_REVERT';
    reason = `Artifact chain verification failed (${artifactChain.issue})`;
    action = 'Restore or regenerate the prior fix artifacts before exiting the loop';
  } else if (cleanTerminalState && troubleshooting.reasons.length > 0) {
    verdict = 'LOOP_REVERT';
    reason = `Troubleshooting artifacts incomplete (${troubleshooting.reasons.join(', ')})`;
    action = 'Complete the required troubleshooting artifacts and hypothesis validation before exiting the fix loop';
  } else if (cleanTerminalState && flowLedger.reasons.length > 0) {
    verdict = 'LOOP_REVERT';
    reason = `Flow ledger incomplete (${flowLedger.reasons.join(', ')})`;
    action = 'Generate or repair _cobolt-output/latest/fix/flow-ledger.json before exiting the fix loop';
  } else if (cleanTerminalState && flowLedger.hasBrokenOrBlocked) {
    verdict = 'LOOP_REVERT';
    reason = `Flow ledger still marks ${flowLedger.summary.broken + flowLedger.summary.blocked} flow(s) as broken or blocked`;
    action = 'Resolve or reclassify the blocked flows before exiting the fix loop';
  } else if (cleanTerminalState && verification.passed === true) {
    verdict = 'EXIT_SUCCESS';
    reason = `All ${totalResolved} findings resolved and verification passed`;
    action = 'Generate RCA document and complete pipeline';
  } else if (cleanTerminalState && !verification.complete) {
    verdict = 'LOOP_REVERT';
    reason = `Verification incomplete (${verification.incompleteReasons.join(', ')})`;
    action = 'Complete the remaining verification steps before exiting the fix loop';
  } else if (totalActionable === 0 && totalPartial > 0) {
    verdict = 'EXIT_ESCALATE';
    reason = `${totalPartial} findings remain deferred or carry-forward; treat outcome as partial-ship`;
    action = 'Generate RCA, preserve carry-forward items, and continue with partial-ship semantics';
  } else if (iteration >= maxIterations) {
    verdict = 'EXIT_ESCALATE';
    reason = `Max iterations (${maxIterations}) reached with ${totalActionable} unresolved findings`;
    action = 'Mark remaining as carry-forward, generate RCA, escalate to user';
  } else if (isStalled) {
    verdict = 'EXIT_ESCALATE';
    reason = `Stall detected with ${totalActionable} unresolved findings across the last 3 iterations`;
    action = 'Mark remaining as carry-forward, generate RCA with stall analysis';
  } else if (verification.passed === false) {
    verdict = 'LOOP_REVERT';
    reason = `Verification failed (${verification.reasons.join(', ')})`;
    action = 'Fix regressions before continuing with remaining findings';
  } else if (crossBCSignature) {
    // v0.13.1 Phase 2A: signature-based integration plateau — the same bug
    // signature (normalized stack trace + file pair) has persisted across
    // >=3 iterations, its files cross >=2 bounded contexts, and at least 2
    // unit-fix iterations have already been spent on it. Skip further
    // unit-fix retries and dispatch architect-fix-agent directly.
    verdict = 'LOOP_INTEGRATION_PLATEAU';
    const bcIds = (crossBCSignature.crossing.bcs || []).map((b) => b.id).join(', ');
    reason = `Signature-stable bug across bounded contexts [${bcIds}] after ${crossBCSignature.unitAttempts} unit-fix iterations (signature ${crossBCSignature.hash.slice(0, 12)})`;
    action =
      'Dispatch architect-fix-agent directly with cross-component scope for this signature. Skip unit-fix retry — unit-level patches cannot reconcile a cross-BC contract disagreement.';
  } else if (
    plateau.detected &&
    iteration >= 4 &&
    integrationShape.dominant &&
    countPriorVerdict(iterationLog, 'LOOP_ARCH_MUTATE') >= 2
  ) {
    // v0.12.0 fix M5: architect-fix itself plateaued. Two mutation proposals
    // have been tried and the finding set persists — escalate to human
    // instead of looping forever.
    verdict = 'EXIT_ESCALATE';
    reason = `Two LOOP_ARCH_MUTATE iterations did not resolve the plateau. Architecture-level changes are insufficient — likely requirements-level gap. Escalating to human.`;
    action =
      'Record the plateau + finding set to dead-ends.jsonl with strategy="architectural-mutation", write carry-forward.json, generate RCA, and escalate to user. Consider dispatching prd-redteam-agent on the PRD for the affected FRs.';
  } else if (
    plateau.detected &&
    iteration >= 4 &&
    integrationShape.dominant &&
    countPriorVerdict(iterationLog, 'LOOP_ARCH_ESCALATE') >= 2
  ) {
    // Tier 5.2 (v0.12.0 — WS3): plain arch-reviewer escalations have fired twice
    // without resolution. The architecture itself is the constraint. Escalate
    // to architect-fix-agent which can propose mutations to architecture.md
    // (gated by cobolt-arch-mutation-gate — human or two-agent quorum approval).
    verdict = 'LOOP_ARCH_MUTATE';
    reason = `Plateau persists after ${countPriorVerdict(iterationLog, 'LOOP_ARCH_ESCALATE')} LOOP_ARCH_ESCALATE iterations on ${integrationShape.dominant} findings. Architecture-reviewer recommendations cannot be implemented within the current architecture.`;
    action =
      'Dispatch architect-fix-agent to propose an architecture.md mutation (via tools/cobolt-arch-propose.js new). Proposal must pass cobolt-arch-mutation-gate — two-agent quorum (architecture-reviewer + security-reviewer APPROVE) in autonomous mode OR human verdict in interactive mode. On APPROVE, apply via cobolt-arch-propose.js apply. Resume the fix loop afterwards.';
  } else if (plateau.detected && iteration >= 3 && integrationShape.dominant) {
    // Tier 5.1 (v0.11.0): plateau on integration/architecture bugs escalates
    // to architecture-reviewer BEFORE exhausting iterations, instead of
    // looping another pivot at the same code layer.
    verdict = 'LOOP_ARCH_ESCALATE';
    reason = `Plateau on ${integrationShape.dominant} findings (${integrationShape.count}/${findings.length}). Category: ${integrationShape.label}. Unit-level fixes don't resolve cross-component bugs — re-architecture needed.`;
    action =
      'Dispatch architecture-reviewer with the plateau set of findings; incorporate its recommendation, then resume the fix loop from a fresh strategy (not another whack-a-mole iteration).';
  } else if (plateau.detected && iteration >= 3) {
    verdict = 'LOOP_PIVOT';
    reason = `Plateau detected: ${plateau.reason}`;
    action =
      'Strategy shift required — read dead-ends.jsonl to avoid repeating failed approaches, ' +
      'study the root causes holistically, and choose a fundamentally different fix strategy';
  } else {
    verdict = 'LOOP';
    reason = `${totalActionable} actionable findings remain, iteration ${iteration}/${maxIterations}`;
    action = 'Route remaining findings and dispatch fix agents';
  }

  const blockers = buildBlockerSummary({
    verification,
    troubleshootingReasons: troubleshooting.reasons,
    flowLedger,
    artifactChain,
    totalActionable,
    totalPartial,
    stallDetected: isStalled,
  });

  return {
    verdict,
    reason,
    action,
    iteration,
    maxIterations,
    counts: {
      total,
      actionable: totalActionable,
      resolved: totalResolved,
      partial: totalPartial,
      open: counts.open,
      assigned: counts.assigned,
      fixApplied: counts['fix-applied'],
      fixAppliedUnverified: counts['fix-applied-unverified'],
      fixAppliedFailing: counts['fix-applied-failing'],
      fixAppliedNoTest: counts['fix-applied-no-test'],
      stalled: counts.stalled,
      carriedForward: counts['carry-forward'],
      deferred: counts.deferred,
      phantom: counts.phantom,
    },
    stallDetected: isStalled,
    plateauDetected: plateau.detected,
    plateauTrend: plateau.trend || null,
    plateauReason: plateau.reason || null,
    bugSignatures: currentSignatureHashes,
    bugSignatureClusters: [...currentSignatureBuckets.values()].map((entry) => ({
      hash: entry.hash,
      filePair: entry.filePair,
      files: entry.files,
      findingIds: entry.findingIds,
      bcCrossing: plateauSig.classifyBCCrossing(entry, bcData),
    })),
    signaturePlateau: {
      detected: signaturePlateau.detected,
      window: signaturePlateau.window,
      signatures: signaturePlateau.signatures.map((s) => s.hash),
    },
    crossBCEscalation: crossBCSignature
      ? {
          hash: crossBCSignature.hash,
          filePair: crossBCSignature.filePair,
          bcs: crossBCSignature.crossing.bcs,
          unitAttempts: crossBCSignature.unitAttempts,
        }
      : null,
    verificationPassed: verification.passed,
    verificationComplete: verification.complete,
    verificationIncompleteReasons: verification.incompleteReasons,
    verification: verification.steps,
    troubleshootingRequirements: troubleshooting.requirements,
    troubleshootingBlockingReasons: troubleshooting.reasons,
    flowLedger,
    verificationScope: verificationResult?.scope || null,
    artifactChain: {
      ...artifactChain,
      verificationPath: verificationPath || null,
    },
    blockers,
    timestamp: new Date().toISOString(),
    generatedBy: 'cobolt-fix-verdict',
  };
}

function cmdDecide(args) {
  const trackerIdx = args.indexOf('--tracker');
  const trackerPath = trackerIdx !== -1 && args[trackerIdx + 1] ? args[trackerIdx + 1] : null;
  const iterIdx = args.indexOf('--iteration');
  const iteration = iterIdx !== -1 && args[iterIdx + 1] ? Number.parseInt(args[iterIdx + 1], 10) : 1;
  const maxIdx = args.indexOf('--max-iterations');
  // v0.11.0 Tier 5.2: per-category caps. Default 5 for CODE/unit; 10 for
  // integration/architecture/contract findings (which legitimately need
  // more iterations to resolve cross-component disagreement).
  let maxIterations = maxIdx !== -1 && args[maxIdx + 1] ? Number.parseInt(args[maxIdx + 1], 10) : 5;
  if (maxIdx === -1 && trackerPath) {
    try {
      const tracker = JSON.parse(require('node:fs').readFileSync(trackerPath, 'utf8'));
      const findings = Array.isArray(tracker.findings) ? tracker.findings : [];
      const shape = classifyForArchitectureEscalation(findings);
      if (shape.dominant) maxIterations = 10;
    } catch {
      /* default stands */
    }
  }
  const verificationIdx = args.indexOf('--verification');
  const verificationPath = verificationIdx !== -1 && args[verificationIdx + 1] ? args[verificationIdx + 1] : null;
  const jsonMode = args.includes('--json');

  if (!trackerPath) {
    console.error('Usage: node tools/cobolt-fix-verdict.js decide --tracker <path>');
    process.exit(3);
  }

  if (!fs.existsSync(trackerPath)) {
    console.error(`[cobolt-fix-verdict] Tracker not found: ${trackerPath}`);
    process.exit(3);
  }

  let tracker;
  try {
    tracker = JSON.parse(fs.readFileSync(trackerPath, 'utf8'));
  } catch (e) {
    console.error(`[cobolt-fix-verdict] tracker parse failed: ${trackerPath}: ${e.message}`);
    try {
      const auditDir = path.join(path.dirname(trackerPath), '..', '..', 'audit');
      fs.mkdirSync(auditDir, { recursive: true });
      fs.appendFileSync(
        path.join(auditDir, 'fix-parse-failures.jsonl'),
        `${JSON.stringify({ at: new Date().toISOString(), file: trackerPath, error: e.message, stage: 'fix-verdict' })}\n`,
      );
    } catch {
      /* best-effort */
    }
    process.exit(4);
  }
  let verificationResult = null;
  if (verificationPath && fs.existsSync(verificationPath)) {
    try {
      verificationResult = JSON.parse(fs.readFileSync(verificationPath, 'utf8'));
    } catch (e) {
      console.error(
        `[cobolt-fix-verdict] verification parse failed: ${verificationPath}: ${e.message} — treating as null`,
      );
      verificationResult = null;
    }
  }
  const iterationLog = loadIterationLog(trackerPath, tracker);
  const result = computeVerdict(
    tracker,
    iteration,
    maxIterations,
    verificationResult,
    iterationLog,
    trackerPath,
    verificationPath,
  );

  if (PLATEAU_METRIC_VERDICTS.has(result.verdict)) bumpPlateauMetric();

  const outPath = path.join(path.dirname(trackerPath), `fix-verdict-iter-${iteration}.json`);
  // v0.16.1: defer verdict write until artifact chain is resolved, then
  // perform a single atomic write-tmp+rename. Previous code wrote at this
  // point AND again after chain resolution, creating a read-stale race for
  // concurrent readers (verifyPreviousArtifactChain, plateau detector).

  // v0.12.0 WS3 fix (H5): persist the verdict into fix-iteration-log.json so
  // that subsequent cobolt-fix-verdict invocations can detect LOOP_ARCH_MUTATE
  // via countPriorVerdict. Skills previously had to write this manually;
  // now the tool owns it — upsert by iteration number.
  try {
    const logPath = path.join(path.dirname(trackerPath), 'fix-iteration-log.json');
    let log = [];
    if (fs.existsSync(logPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(logPath, 'utf8'));
        log = Array.isArray(raw) ? raw : Array.isArray(raw.iterations) ? raw.iterations : [];
      } catch {
        /* start fresh on parse error */
      }
    }
    const entry = {
      iteration,
      verdict: result.verdict,
      findingsRemaining: result.counts?.actionable ?? 0,
      findingsResolved: result.counts?.resolved ?? 0,
      findingsTotal: result.counts?.total ?? 0,
      bugSignatures: Array.isArray(result.bugSignatures) ? result.bugSignatures : [],
      timestamp: new Date().toISOString(),
    };
    const existingIdx = log.findIndex((e) => e && Number(e.iteration) === Number(iteration));
    if (existingIdx >= 0) log[existingIdx] = { ...log[existingIdx], ...entry };
    else log.push(entry);
    const logTmp = `${logPath}.tmp`;
    fs.writeFileSync(logTmp, JSON.stringify(log, null, 2));
    fs.renameSync(logTmp, logPath);
  } catch {
    /* non-fatal — skill may still write its own richer entry */
  }

  try {
    plateauSig.writeTelemetry({
      iteration: result.iteration,
      verdict: result.verdict,
      findingsRemaining: result.counts?.actionable ?? 0,
      bugSignatureClusters: result.bugSignatureClusters || [],
      signaturePlateau: result.signaturePlateau || null,
      crossBCEscalation: result.crossBCEscalation || null,
    });
  } catch {
    /* telemetry is best-effort */
  }

  const chainArtifacts = resolveIterationArtifactPaths(trackerPath, iteration, verificationPath);
  chainArtifacts.push(outPath);
  const chainPath = writeIterationArtifactChain(trackerPath, iteration, chainArtifacts);
  if (chainPath) {
    result.artifactChain = {
      ...result.artifactChain,
      currentChainPath: chainPath,
      currentArtifacts: [...new Set(chainArtifacts)],
    };
  }
  // Single atomic write after chain resolution. tmp+rename prevents readers
  // (plateau detector, verifyPreviousArtifactChain) from seeing a partially
  // written or chain-less verdict file.
  const tmpPath = `${outPath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, outPath);

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[cobolt-fix-verdict] Iteration ${result.iteration}/${result.maxIterations}`);
    console.log(`  Verdict: ${result.verdict}`);
    console.log(`  Reason: ${result.reason}`);
    console.log(`  Action: ${result.action}`);
    console.log(
      `  Findings: ${result.counts.total} total, ${result.counts.actionable} actionable, ${result.counts.resolved} resolved`,
    );
    if (result.stallDetected) console.log('  WARNING: Stall detected');
    if (result.plateauDetected) console.log(`  WARNING: Plateau detected (${result.plateauTrend})`);
    if (result.verificationPassed === false) console.log('  WARNING: Verification failed');
    if (result.artifactChain?.passed === false) console.log('  WARNING: Artifact chain verification failed');
  }

  switch (result.verdict) {
    case 'EXIT_SUCCESS':
      process.exit(0);
      break;
    case 'LOOP':
    case 'LOOP_REVERT':
    case 'LOOP_PIVOT':
    case 'LOOP_ARCH_ESCALATE':
    case 'LOOP_ARCH_MUTATE':
    case 'LOOP_INTEGRATION_PLATEAU':
      process.exit(1);
      break;
    default:
      process.exit(2);
  }
}

if (require.main === module) {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case 'decide':
      cmdDecide(args);
      break;
    default:
      console.log('CoBolt Fix Verdict - Deterministic verification loop decision');
      console.log('');
      console.log('Usage:');
      console.log(
        '  node tools/cobolt-fix-verdict.js decide --tracker <path> [--iteration N] [--max-iterations 5] [--verification <path>] [--json]',
      );
      console.log('');
      console.log('Verdicts: EXIT_SUCCESS (0), LOOP (1), LOOP_REVERT (1), LOOP_PIVOT (1), EXIT_ESCALATE (2)');
      process.exit(command ? 3 : 0);
  }
}

module.exports = {
  computeVerdict,
  detectStall,
  detectPlateau,
  classifyForArchitectureEscalation,
  evaluateVerification,
  buildBlockerSummary,
  classifyVerificationReason,
  ACTIONABLE_STATUSES,
  loadIterationLog,
  inspectTroubleshootingArtifacts,
  inspectFlowLedger,
  resolveIterationArtifactPaths,
  verifyPreviousArtifactChain,
  writeIterationArtifactChain,
};
