#!/usr/bin/env node

// CoBolt Production Quality Gate
//
// This is the release-system gate for production-track applications. It is
// deliberately stricter than a per-milestone readiness score: an app only gets
// above a 90% production-readiness bar when decomposition, cross-boundary
// evidence, real environment promotion, independent verification, and human
// release ownership are all present.
//
// Usage:
//   node tools/cobolt-production-quality.js check --milestone M5 --mode release-candidate --json
//   node tools/cobolt-production-quality.js check --milestone M5 --mode production --json

const fs = require('node:fs');
const path = require('node:path');
const { paths: coboltPaths } = require('../lib/cobolt-paths');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const DEFAULT_MIN_SCORE = 90;
const HIGH_SEVERITIES = new Set(['critical', 'high']);
const RESOLVED_STATUSES = new Set(['verified', 'false-positive']);
const READY_REQUIREMENT_STATUSES = new Set(['tested', 'covered']);
const ZERO_METRICS = [
  'contractViolations',
  'contractInventions',
  'behaviorCoverageGaps',
  'behaviorRealismRejects',
  'crossMilestoneSmokeFailures',
  'perfBudgetExceeded',
  'fixLoopPlateaus',
];

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readJsonl(filePath) {
  return readText(filePath)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function rel(cwd, filePath) {
  return filePath ? path.relative(cwd, filePath).replace(/\\/g, '/') : null;
}

function latestDir(cwd) {
  return coboltPaths(cwd).latest();
}

function latestFile(cwd, ...segments) {
  return path.join(latestDir(cwd), ...segments);
}

function outputRoot(cwd) {
  return coboltPaths(cwd).outputRoot;
}

function newestFile(dir, predicate) {
  try {
    return fs
      .readdirSync(dir)
      .filter(predicate)
      .map((name) => path.join(dir, name))
      .sort()
      .reverse()[0];
  } catch {
    return null;
  }
}

function readState(cwd) {
  return readJson(path.join(cwd, 'cobolt-state.json')) || {};
}

function normalizeMilestone(value) {
  const match = String(value || '')
    .trim()
    .match(/^M?(\d+)$/i);
  return match ? `M${Number(match[1])}` : null;
}

function inferMilestone(cwd) {
  const envMilestone = normalizeMilestone(process.env.COBOLT_MILESTONE);
  if (envMilestone) return envMilestone;

  const state = readState(cwd);
  const candidates = [
    state.pipeline?.currentMilestone,
    state.pipeline?.priorMilestone,
    state.currentMilestone,
    state.build?.currentMilestone,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeMilestone(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function validateCheckFlags(flags, cwd) {
  flags.mode = String(flags.mode || '').trim();
  if (!new Set(['release-candidate', 'production']).has(flags.mode)) {
    return {
      ok: false,
      message: 'cobolt-production-quality check requires --mode release-candidate or --mode production.',
    };
  }

  const normalizedMilestone = normalizeMilestone(flags.milestone);
  if (flags.milestoneProvided && !normalizedMilestone) {
    return { ok: false, message: 'cobolt-production-quality check requires a non-empty --milestone M{n} value.' };
  }

  flags.milestone = normalizedMilestone || inferMilestone(cwd);
  if (!flags.milestone) {
    return {
      ok: false,
      message: 'cobolt-production-quality check requires --milestone M{n}; no milestone could be inferred from state.',
    };
  }

  return { ok: true };
}

function metric(state, name) {
  const value = state.metrics?.[name];
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function metricForMilestone(state, name, milestone) {
  const value = state.metrics?.[name];
  if (!value || typeof value !== 'object') return null;
  if (milestone && typeof value[milestone] === 'number') return value[milestone];
  if (typeof value.latest === 'number') return value.latest;
  return null;
}

function control(id, label, passed, evidence = {}, remediation = null, severity = 'critical', scored = true) {
  return {
    id,
    label,
    status: passed ? 'pass' : 'fail',
    severity,
    scored,
    evidence,
    remediation,
  };
}

function warn(id, label, evidence = {}) {
  return {
    id,
    label,
    status: 'warn',
    severity: 'advisory',
    evidence,
    remediation: null,
  };
}

function dimension(id, label, weight, controls) {
  const scored = controls.filter((item) => item.status !== 'warn' && item.scored !== false);
  const passed = scored.filter((item) => item.status === 'pass').length;
  const score = scored.length ? Math.round((passed / scored.length) * 100) : 0;
  const blockers = controls.filter((item) => item.status === 'fail' && HIGH_SEVERITIES.has(item.severity));
  return { id, label, weight, score, controls, blockers };
}

function readRtm(cwd) {
  const fp = latestFile(cwd, 'planning', 'rtm.json');
  const data = readJson(fp);
  const requirements = Object.values(data?.requirements || {});
  const frs = requirements.filter((req) => /^FR[-_]\d+/i.test(String(req.id || '')) || req.type === 'functional');
  const covered = requirements.filter((req) => READY_REQUIREMENT_STATUSES.has(String(req.status || '').toLowerCase()));
  const byMilestone = {};
  for (const req of requirements) {
    const milestone = req.milestone || req.milestones?.[0];
    if (!milestone) continue;
    byMilestone[milestone] = (byMilestone[milestone] || 0) + 1;
  }
  return {
    artifact: fp,
    totalRequirements: requirements.length,
    totalFrs: frs.length,
    coveredRequirements: covered.length,
    coverage: requirements.length ? covered.length / requirements.length : 0,
    byMilestone,
    requirements,
  };
}

function readBoundedContexts(cwd) {
  const fp = latestFile(cwd, 'planning', 'bounded-contexts.json');
  const data = readJson(fp);
  const contexts = Array.isArray(data?.boundedContexts) ? data.boundedContexts : [];
  const assignedFrCounts = {};
  for (const ctx of contexts) {
    for (const fr of ctx.frs || []) assignedFrCounts[fr] = (assignedFrCounts[fr] || 0) + 1;
  }
  const assignedFrs = new Set(Object.keys(assignedFrCounts));
  const assignedMilestones = new Set(contexts.flatMap((ctx) => ctx.milestones || []));
  const crossBcContracts = Array.isArray(data?.crossContextContracts)
    ? data.crossContextContracts
    : Array.isArray(data?.contracts)
      ? data.contracts
      : [];
  return { artifact: fp, data, contexts, assignedFrs, assignedFrCounts, assignedMilestones, crossBcContracts };
}

function readMilestones(cwd) {
  const fp = latestFile(cwd, 'planning', 'milestones.md');
  const text = readText(fp);
  const matches = [...text.matchAll(/\bM\d+\b/g)].map((match) => match[0]);
  return { artifact: fp, count: new Set(matches).size, text };
}

function readInterfaceContracts(cwd) {
  const fp = latestFile(cwd, 'planning', 'interface-contracts.json');
  const data = readJson(fp);
  const contracts = Array.isArray(data?.contracts) ? data.contracts : Array.isArray(data) ? data : [];
  return { artifact: fp, contracts };
}

function openCriticalHighFindings(cwd) {
  const fp = latestFile(cwd, 'review', 'finding-tracker.json');
  const data = readJson(fp);
  const findings = Array.isArray(data?.findings) ? data.findings : [];
  return {
    artifact: fp,
    findings: findings.filter((finding) => {
      const severity = String(finding.severity || '').toLowerCase();
      const status = String(finding.status || 'open').toLowerCase();
      return HIGH_SEVERITIES.has(severity) && !RESOLVED_STATUSES.has(status);
    }),
  };
}

function readSecurityReport(cwd) {
  const fp = latestFile(cwd, 'review', 'security-scan-report.json');
  const data = readJson(fp);
  return {
    artifact: fp,
    found: Boolean(data),
    posture: data?.summary?.posture || null,
    totalFindings: Number(data?.summary?.totalFindings || 0),
  };
}

function readBehaviorReport(cwd) {
  const fp = latestFile(cwd, 'behavior-coverage', 'report.json');
  const data = readJson(fp);
  return {
    artifact: fp,
    found: Boolean(data),
    ok: data?.ok === true,
    gaps: Array.isArray(data?.gaps) ? data.gaps.length : null,
    realismRejectsTotal: Number(data?.realismRejectsTotal || 0),
  };
}

function readProductionEvidence(cwd) {
  const fp = latestFile(cwd, 'production-evidence', 'release-gate.json');
  const data = readJson(fp);
  const blockerDetails = Array.isArray(data?.blockers) ? data.blockers : [];
  const summaryBlockerCount = Number(data?.summary?.blockerCount);
  return {
    artifact: fp,
    found: Boolean(data),
    passed: data?.passed === true,
    score: data?.score ?? null,
    blockers: blockerDetails.length || (Number.isFinite(summaryBlockerCount) ? summaryBlockerCount : null),
    blockerDetails,
  };
}

function readObservabilityReport(cwd) {
  const fp = latestFile(cwd, 'observability', 'check.json');
  const data = readJson(fp);
  return {
    artifact: fp,
    found: Boolean(data),
    passed: data?.passed === true,
    missing: Array.isArray(data?.missing) ? data.missing : [],
  };
}

function readInfraManifest(cwd) {
  const fp = coboltPaths(cwd).infraManifest();
  const manifest = readJson(fp);
  return { artifact: fp, manifest };
}

function isManagedService(service) {
  if (!service || service.type === 'none') return true;
  return service.type === 'managed';
}

function readDeployHealth(cwd, milestone) {
  const fp = milestone
    ? latestFile(cwd, 'deploy', milestone, 'health-report.json')
    : newestFile(coboltPaths(cwd).latestDeploy(), (name) => name === 'health-report.json');
  const report = readJson(fp);
  return { artifact: fp, report };
}

function readVerifyVerdict(cwd) {
  const fp = newestFile(latestFile(cwd, 'verify'), (name) => name.endsWith('-verdict.json'));
  return { artifact: fp, verdict: readJson(fp) || {} };
}

function readLoadChaos(cwd) {
  const root = path.join(outputRoot(cwd), 'load-chaos');
  try {
    const dirs = fs
      .readdirSync(root)
      .map((entry) => path.join(root, entry))
      .sort()
      .reverse();
    for (const dir of dirs) {
      const fp = path.join(dir, 'verdict.json');
      const verdict = readJson(fp);
      if (verdict) return { artifact: fp, verdict };
    }
  } catch {}
  return { artifact: null, verdict: null };
}

function readApproval(cwd, milestone) {
  const fp = path.join(outputRoot(cwd), 'audit', 'human-approvals.jsonl');
  const entries = readJsonl(fp);
  const approval = [...entries].reverse().find((entry) => {
    return (
      entry.event === 'production-ready' &&
      String(entry.verdict || entry.decision || '').toLowerCase() === 'approved' &&
      (!milestone || entry.milestone === milestone)
    );
  });
  return { artifact: fp, approved: Boolean(approval), approval };
}

function readEvalsRollup(cwd) {
  const fp = path.join(outputRoot(cwd), 'evals', 'history', 'score-history.json');
  const data = readJson(fp);
  if (!data?.overall) return { artifact: fp, found: false };
  return {
    artifact: fp,
    found: true,
    composite: Number(data.overall.latest || 0),
    movingAverage7d: data.overall.movingAverage7d ?? null,
    hardFailures: Number(data.overall.hardFailures || 0),
    trend: data.overall.trend || 'unknown',
  };
}

function releaseChecklist(cwd) {
  const fp = latestFile(cwd, 'planning', 'release-readiness-checklist.md');
  const text = readText(fp);
  const checks = {
    rollback: /\brollback|revert|restore|backout/i.test(text),
    smoke: /\bsmoke/i.test(text),
    approval: /\bapproval|sign[- ]off|owner/i.test(text),
    security: /\bsecurity|sast|dependency|secret/i.test(text),
    observability: /\bobservability|monitor|alert|log|metric|trace/i.test(text),
  };
  return {
    artifact: fp,
    exists: text.length >= 300,
    checks,
    passed: text.length >= 300 && Object.values(checks).every(Boolean),
  };
}

function evaluate(options = {}) {
  const cwd = options.cwd || process.cwd();
  const milestone = options.milestone || null;
  const mode = options.mode || 'release-candidate';
  const minScore = Number(options.minScore || DEFAULT_MIN_SCORE);
  const writeState = options.writeState !== false;
  const state = readState(cwd);
  const rtm = readRtm(cwd);
  const bc = readBoundedContexts(cwd);
  const milestones = readMilestones(cwd);
  const contracts = readInterfaceContracts(cwd);
  const findings = openCriticalHighFindings(cwd);
  const security = readSecurityReport(cwd);
  const behavior = readBehaviorReport(cwd);
  const productionEvidence = readProductionEvidence(cwd);
  const observability = readObservabilityReport(cwd);
  const infra = readInfraManifest(cwd);
  const health = readDeployHealth(cwd, milestone);
  const verify = readVerifyVerdict(cwd);
  const chaos = readLoadChaos(cwd);
  const approval = readApproval(cwd, milestone);
  const checklist = releaseChecklist(cwd);
  const evalsSignal = readEvalsRollup(cwd);
  const frIds = rtm.requirements
    .filter((req) => /^FR[-_]\d+/i.test(String(req.id || '')) || req.type === 'functional')
    .map((req) => req.id);
  const duplicateContextFrs = frIds.filter((id) => (bc.assignedFrCounts[id] || 0) > 1);
  const missingContextFrs = frIds.filter((id) => (bc.assignedFrCounts[id] || 0) === 0);
  const projectScope = {
    frCount: rtm.totalFrs,
    milestoneCount: milestones.count,
    highComplexity: rtm.totalFrs > 50 || milestones.count > 5,
  };
  const manifest = infra.manifest || {};
  const nonDevPlatform = manifest.platform?.type && manifest.platform.type !== 'docker-compose';
  const managedServices =
    isManagedService(manifest.services?.database) &&
    isManagedService(manifest.services?.cache) &&
    isManagedService(manifest.services?.queue);
  const targetEnvironment = mode === 'production' ? 'production' : 'staging';

  const dimensions = [
    dimension('decomposition', 'Decomposition and dependency architecture', 20, [
      control(
        'bounded-contexts-required',
        'Every production-track app declares bounded-context ownership',
        bc.contexts.length >= 1 &&
          (!projectScope.highComplexity || (bc.contexts.length >= 3 && bc.contexts.length <= 8)),
        { projectScope, contexts: bc.contexts.length, artifact: rel(cwd, bc.artifact) },
        'Run cobolt-decompose-bounded-contexts. Single-context apps must declare one owner; high-complexity apps must keep 3-8 context owners.',
      ),
      control(
        'frs-assigned-to-contexts',
        'Every FR is assigned to exactly one bounded context',
        frIds.every((id) => bc.assignedFrCounts[id] === 1),
        {
          totalFrs: rtm.totalFrs,
          assignedFrs: bc.assignedFrs.size,
          missing: missingContextFrs,
          duplicates: duplicateContextFrs,
        },
        'Map every FR to a bounded context before milestone decomposition.',
      ),
      control(
        'milestone-size',
        'No milestone carries more than 25 requirements',
        Object.values(rtm.byMilestone).every((count) => count <= 25),
        { byMilestone: rtm.byMilestone },
        'Split oversized milestones until each release slice is independently testable.',
      ),
      control(
        'interface-contracts',
        'Cross-context/interface contracts are explicit',
        contracts.contracts.length > 0,
        { contracts: contracts.contracts.length, artifact: rel(cwd, contracts.artifact) },
        'Produce interface-contracts.json with API/data/event contracts across boundaries.',
      ),
    ]),
    dimension('strict-gates', 'Strict functional, security, and regression gates', 25, [
      control(
        'rtm-coverage',
        'All requirements are tested or covered',
        rtm.coverage === 1 && rtm.totalRequirements > 0,
        { covered: rtm.coveredRequirements, total: rtm.totalRequirements, artifact: rel(cwd, rtm.artifact) },
        'Run milestone validation and RTM update until every requirement is tested/covered.',
      ),
      control(
        'behavior-coverage',
        'Behavior coverage includes happy, failure, and edge paths',
        behavior.found && behavior.ok && behavior.realismRejectsTotal === 0,
        {
          artifact: rel(cwd, behavior.artifact),
          gaps: behavior.gaps,
          realismRejectsTotal: behavior.realismRejectsTotal,
        },
        'Run cobolt-behavior-coverage.js gate and add non-tautological behavior tests.',
      ),
      control(
        'zero-quality-metrics',
        'Tier-1 quality metrics have zero blockers',
        ZERO_METRICS.every((name) => metric(state, name) === 0),
        Object.fromEntries(ZERO_METRICS.map((name) => [name, metric(state, name)])),
        'Fix every Tier-1 metric producer before release gating.',
      ),
      control(
        'security-posture',
        'Security scan is clean/degraded with no core findings',
        security.found && ['CLEAN', 'DEGRADED'].includes(String(security.posture || '').toUpperCase()),
        { artifact: rel(cwd, security.artifact), posture: security.posture, totalFindings: security.totalFindings },
        'Run cobolt-scan and clear findings or scanner errors.',
      ),
      control(
        'no-open-critical-high',
        'No unresolved critical/high findings remain',
        findings.findings.length === 0,
        {
          artifact: rel(cwd, findings.artifact),
          count: findings.findings.length,
          ids: findings.findings.map((f) => f.id),
        },
        'Fix and verify all critical/high findings.',
      ),
      control(
        'production-evidence',
        'Executable PRD, architecture, contracts, security, resilience, validation, no-stubs, and scorecard evidence pass',
        productionEvidence.found && productionEvidence.passed && Number(productionEvidence.score) >= 90,
        {
          artifact: rel(cwd, productionEvidence.artifact),
          score: productionEvidence.score,
          blockers: productionEvidence.blockers,
          blockerDetails: productionEvidence.blockerDetails,
        },
        'Run node tools/cobolt-production-evidence.js check --phase release and fix every upstream evidence blocker.',
      ),
    ]),
    dimension('real-environments', 'Real environment promotion evidence', 20, [
      control(
        'infra-manifest',
        `${targetEnvironment} infra manifest exists and is verified`,
        Boolean(manifest.verified) && manifest.environment === targetEnvironment,
        { artifact: rel(cwd, infra.artifact), environment: manifest.environment, verified: manifest.verified },
        `Run cobolt-infra for ${targetEnvironment} and verify infra-manifest.json.`,
      ),
      control(
        'non-dev-platform',
        'Staging/production platform is not docker-compose',
        Boolean(nonDevPlatform),
        { platform: manifest.platform?.type },
        'Use platform-native staging/production infrastructure, not Docker Compose.',
      ),
      control(
        'managed-services',
        'Databases/caches/queues are managed or explicitly none',
        Boolean(managedServices),
        { services: manifest.services || null },
        'Use managed services for non-dev environments.',
      ),
      control(
        'deploy-health',
        'Deploy health report passed in target environment',
        health.report?.status === 'passed',
        {
          artifact: rel(cwd, health.artifact),
          status: health.report?.status || null,
          target: health.report?.target || null,
        },
        'Run cobolt-deploy-verify after staging/production deploy and fix readiness/smoke/metrics failures.',
      ),
    ]),
    dimension('independent-verification', 'Independent verification and resilience', 20, [
      control(
        'mutation-score',
        'Mutation score is >= 75%',
        Number(verify.verdict.mutationScore) >= 0.75,
        { artifact: rel(cwd, verify.artifact), mutationScore: verify.verdict.mutationScore ?? null },
        'Run mutation tests and add assertions for surviving mutants.',
      ),
      control(
        'independent-test-pass-rate',
        'Independent test pass rate is >= 95%',
        Number(verify.verdict.independentTestPassRate) >= 0.95,
        {
          artifact: rel(cwd, verify.artifact),
          independentTestPassRate: verify.verdict.independentTestPassRate ?? null,
        },
        'Run cobolt-verify-independent and fix tests generated from PRD without code visibility.',
      ),
      control(
        'contract-runtime-conformance',
        'Runtime contract conformance is >= 95%',
        Number(verify.verdict.contractRuntimeConformance) >= 0.95,
        {
          artifact: rel(cwd, verify.artifact),
          contractRuntimeConformance: verify.verdict.contractRuntimeConformance ?? null,
        },
        'Run contract replay/semantic verification and fix boundary drift.',
      ),
      control(
        'load-chaos',
        'Load/chaos verdict passes',
        chaos.verdict?.verdict === 'pass',
        { artifact: rel(cwd, chaos.artifact), verdict: chaos.verdict?.verdict || null },
        'Run load/chaos scenarios against the release candidate.',
      ),
      control(
        'observability',
        'Observability primitives pass',
        observability.found && observability.passed,
        { artifact: rel(cwd, observability.artifact), missing: observability.missing },
        'Add structured logs, metrics, traces, and error classification.',
      ),
    ]),
    dimension('release-ownership', 'Human release ownership and rollback readiness', 15, [
      control(
        'production-rigorous-mode',
        'Production-track release uses rigorous mode',
        state.mode === 'rigorous',
        { mode: state.mode || 'auto', autoImpliesRigorous: state.productionTrack?.autoImpliesRigorous === true },
        'Use cobolt-cli ... --auto or --autonomous. Auto now persists rigorous mode so human, independent verification, mutation, load/chaos, and invariant gates are active.',
      ),
      control(
        'release-checklist',
        'Release checklist covers rollback, smoke, approval, security, observability',
        checklist.passed,
        { artifact: rel(cwd, checklist.artifact), checks: checklist.checks },
        'Regenerate release-readiness-checklist.md with concrete go/no-go evidence.',
      ),
      mode === 'production'
        ? control(
            'human-production-approval',
            'Human production-ready approval exists',
            approval.approved,
            { artifact: rel(cwd, approval.artifact), signer: approval.approval?.signer || null },
            'Record production-ready approval with bin/cobolt-approve.js after human release review.',
            'critical',
            false,
          )
        : warn('human-production-approval', 'Production approval is required only for production mode', {
            artifact: rel(cwd, approval.artifact),
            approved: approval.approved,
          }),
      // M5 — advisory eval signal. Judge/eval scores NEVER override
      // deterministic production gates. This is an unscored warn only.
      evalsSignal.found
        ? warn('evals-signal', `Eval rollup composite=${evalsSignal.composite.toFixed(3)} (${evalsSignal.trend})`, {
            artifact: rel(cwd, evalsSignal.artifact),
            composite: evalsSignal.composite,
            movingAverage7d: evalsSignal.movingAverage7d,
            hardFailures: evalsSignal.hardFailures,
          })
        : warn('evals-signal', 'No eval rollup available (advisory)', { artifact: rel(cwd, evalsSignal.artifact) }),
      control(
        'rigorous-composite',
        'Rigorous composite score is >= 90',
        Number(metricForMilestone(state, 'rigorousCompositeScore', milestone)) >= 90,
        { score: metricForMilestone(state, 'rigorousCompositeScore', milestone) },
        'Run cobolt-production-readiness compute after all independent evidence is present.',
      ),
    ]),
  ];

  const totalWeight = dimensions.reduce((sum, dim) => sum + dim.weight, 0);
  const score = Math.round(dimensions.reduce((sum, dim) => sum + dim.score * dim.weight, 0) / totalWeight);
  const blockers = dimensions.flatMap((dim) =>
    dim.blockers.map((item) => ({
      dimension: dim.id,
      id: item.id,
      label: item.label,
      evidence: item.evidence,
      remediation: item.remediation,
    })),
  );
  const warnings = dimensions.flatMap((dim) =>
    dim.controls
      .filter((item) => item.status === 'warn')
      .map((item) => ({ dimension: dim.id, id: item.id, label: item.label, evidence: item.evidence })),
  );
  const autonomousBlockers = blockers.filter((blocker) => blocker.id !== 'human-production-approval');
  const autonomousComplete = score >= minScore && autonomousBlockers.length === 0;
  const productionReady = autonomousComplete && approval.approved && mode === 'production';
  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode,
    milestone,
    targetEnvironment,
    projectScope,
    minScore,
    score,
    passed: mode === 'production' ? productionReady : autonomousComplete,
    readiness: productionReady ? 'production-ready' : autonomousComplete ? 'autonomous-complete' : 'incomplete',
    summary: {
      blockerCount: blockers.length,
      warningCount: warnings.length,
      dimensionsPassed: dimensions.filter((dim) => dim.score >= 90 && dim.blockers.length === 0).length,
      dimensionsTotal: dimensions.length,
    },
    dimensions,
    blockers,
    warnings,
  };
  writeResult(cwd, result, { writeState });
  return result;
}

function writeResult(cwd, result, options = {}) {
  const outDir = path.join(latestDir(cwd), 'production-quality');
  const fp = path.join(outDir, `${result.mode}-gate.json`);
  atomicWrite(fp, JSON.stringify(result, null, 2), { encoding: 'utf8', mode: 0o600 });

  if (options.writeState === false) return;

  const statePath = path.join(cwd, 'cobolt-state.json');
  const state = readState(cwd);
  state.metrics ||= {};
  state.metrics.productionQualityScore ||= {};
  state.metrics.productionQualityScore.latest = result.score;
  if (result.milestone) state.metrics.productionQualityScore[result.milestone] = result.score;
  state.metrics.productionReadiness ||= {};
  state.metrics.productionReadiness.latest = result.readiness;
  if (result.milestone) state.metrics.productionReadiness[result.milestone] = result.readiness;
  atomicWrite(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function parseArgs(args) {
  const flags = {
    mode: 'release-candidate',
    milestone: null,
    milestoneProvided: false,
    json: false,
    minScore: DEFAULT_MIN_SCORE,
    writeState: true,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--mode') flags.mode = args[++i] || flags.mode;
    else if (arg === '--milestone') {
      flags.milestoneProvided = true;
      flags.milestone = args[++i] || null;
    } else if (arg === '--json') flags.json = true;
    else if (arg === '--min-score') flags.minScore = Number(args[++i] || DEFAULT_MIN_SCORE);
    else if (arg === '--no-state-write') flags.writeState = false;
  }
  return flags;
}

function print(result) {
  console.log(`Production quality gate - ${result.passed ? 'PASS' : 'FAIL'}`);
  console.log(`Mode: ${result.mode}`);
  console.log(`Target environment: ${result.targetEnvironment}`);
  console.log(`Score: ${result.score} (min ${result.minScore})`);
  console.log(`Readiness: ${result.readiness}`);
  if (result.blockers.length) {
    console.log(`\nBlockers (${result.blockers.length}):`);
    for (const blocker of result.blockers.slice(0, 20)) {
      console.log(`- [${blocker.dimension}] ${blocker.label}`);
      if (blocker.remediation) console.log(`  Remediation: ${blocker.remediation}`);
    }
  }
  if (result.warnings.length) {
    console.log(`\nWarnings (${result.warnings.length}):`);
    for (const warning of result.warnings.slice(0, 10)) console.log(`- [${warning.dimension}] ${warning.label}`);
  }
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== 'check') {
    console.error(
      'Usage: cobolt-production-quality.js check [--milestone M5] [--mode release-candidate|production] [--json] [--no-state-write]',
    );
    return 1;
  }
  const flags = parseArgs(rest);
  const validation = validateCheckFlags(flags, process.cwd());
  if (!validation.ok) {
    console.error(validation.message);
    return 2;
  }
  const result = evaluate(flags);
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else print(result);
  return result.passed ? 0 : 1;
}

if (require.main === module) process.exit(main());

module.exports = { evaluate };
