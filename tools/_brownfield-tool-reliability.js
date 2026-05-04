const fs = require('node:fs');
const path = require('node:path');

const { hasProvenanceMetadata, loadJson } = require('./_brownfield-readiness-utils');

const SCAN_ARTIFACTS = new Set([
  'domain-liveness.json',
  'query-migration-contract.json',
  'semantic-stub-findings.json',
  'ui-placeholder-mock-scan.json',
]);

const TOOL_ARTIFACTS = [
  { artifact: 'runtime-truth.json', kind: 'runtime', blocking: true, provenance: true },
  { artifact: 'domain-liveness.json', kind: 'scan', blocking: false, provenance: true },
  { artifact: 'query-migration-contract.json', kind: 'scan', blocking: false, provenance: true },
  { artifact: 'semantic-stub-findings.json', kind: 'scan', blocking: false, provenance: true },
  { artifact: 'ui-placeholder-mock-scan.json', kind: 'scan', blocking: false, provenance: true },
  { artifact: '16-issues-registry-verification.json', kind: 'verification', blocking: true },
  { artifact: '12-security-and-quality-assessment-verification.json', kind: 'verification', blocking: false },
  { artifact: '23-master-assessment-verification.json', kind: 'verification', blocking: false },
];

const SOURCE_TRUTH_FAILURE_FLAGS = ['CITED_FILE_MISSING', 'LINE_OUT_OF_RANGE', 'NO_FILE_LOCATION'];
const TOOL_ONLY_FAILURE_FLAGS = ['CONTENT_MISMATCH', 'WEAK_CONTENT_MATCH', 'MISSING_CLAIM_NO_GREP', 'NO_CODE_SNIPPET'];

function flagPrefix(flag) {
  return String(flag || '')
    .split(':')[0]
    .trim();
}

function isToolOnlyVerificationFailure(result) {
  const flags = Array.isArray(result?.flags) ? result.flags.map(flagPrefix).filter(Boolean) : [];
  if (!result || result.status === 'verified' || flags.length === 0) return false;
  if (flags.some((flag) => SOURCE_TRUTH_FAILURE_FLAGS.includes(flag))) return false;
  return flags.every((flag) => TOOL_ONLY_FAILURE_FLAGS.includes(flag));
}

function clampScore(score) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function statusFromScore(score, issues = []) {
  if (issues.some((issue) => issue.blocking)) return 'untrusted';
  if (score >= 80) return 'trusted';
  if (score >= 60) return 'warning';
  if (score >= 30) return 'noisy';
  return 'untrusted';
}

function countArray(value) {
  return Array.isArray(value) ? value.length : 0;
}

function extractFindingCount(data) {
  const summary = data?.summary || {};
  const values = [
    summary.totalFindings,
    summary.findings,
    summary.violations,
    summary.unwired,
    countArray(data?.findings),
    countArray(data?.violations),
  ].filter((value) => Number.isFinite(Number(value)));

  return values.length > 0 ? Math.max(...values.map((value) => Number(value))) : 0;
}

function hasScanScope(data) {
  return Boolean(data?.scanScope && typeof data.scanScope === 'object');
}

function inspectScanArtifact(data, rule) {
  const warnings = [];
  const issues = [];
  let score = 100;
  const findingCount = extractFindingCount(data);

  if (rule.provenance && !hasProvenanceMetadata(data)) {
    warnings.push('missing provenance metadata');
    score -= 20;
  }

  if (!hasScanScope(data) && SCAN_ARTIFACTS.has(rule.artifact)) {
    warnings.push('missing scan scope metadata');
    score -= findingCount >= 100 ? 35 : 10;
  }

  if (findingCount >= 1000) {
    warnings.push(`very high deterministic finding count (${findingCount})`);
    score -= 25;
  } else if (findingCount >= 250) {
    warnings.push(`high deterministic finding count (${findingCount})`);
    score -= 15;
  }

  return { score, warnings, issues, facts: { findingCount } };
}

function inferVerificationMode(artifact, data) {
  if (data?.verificationMode) return data.verificationMode;
  if (artifact === '16-issues-registry-verification.json') return 'finding';
  return 'legacy-unknown';
}

function inspectVerificationArtifact(data, rule) {
  const warnings = [];
  const issues = [];
  let score = 100;
  const mode = inferVerificationMode(rule.artifact, data);
  const stats = data?.stats || {};
  const results = Array.isArray(data?.results) ? data.results : [];
  const total =
    Number(stats.verified || 0) + Number(stats.unverified || 0) + Number(stats.rejected || 0) || results.length;
  const rejected = Number(stats.rejected || 0);
  const unverified = Number(stats.unverified || 0);
  const rejectedRate = total > 0 ? Math.round((rejected / total) * 100) : 0;
  const suspiciousRate = total > 0 ? Math.round(((rejected + unverified) / total) * 100) : 0;

  if (mode === 'legacy-unknown') {
    warnings.push('legacy verification report without explicit verificationMode');
    score -= 25;
  }

  if (mode === 'finding' && rejected > 0) {
    const blocking = rule.blocking !== false;
    issues.push({ message: `${rejected} structured finding references rejected`, blocking });
    score -= Math.min(80, 30 + rejectedRate);
  }

  if (mode !== 'finding' && rejected > 0) {
    warnings.push(`${rejected} citation references rejected`);
    score -= Math.min(55, 20 + rejectedRate);
  }

  if (unverified > 0) {
    warnings.push(`${unverified} references need manual review`);
    score -= Math.min(35, Math.max(10, Math.round(suspiciousRate / 2)));
  }

  if (Number(data?.phantomRate || 0) >= 50 && mode === 'legacy-unknown') {
    warnings.push(`legacy phantomRate=${data.phantomRate}% treated as tool noise until rerun`);
    score -= 20;
  }

  return {
    score,
    warnings,
    issues,
    facts: { verificationMode: mode, total, rejected, unverified, rejectedRate, suspiciousRate },
  };
}

function inspectRuntimeArtifact(data, rule) {
  const warnings = [];
  const issues = [];
  let score = 100;

  if (rule.provenance && !hasProvenanceMetadata(data)) {
    warnings.push('missing provenance metadata');
    score -= 20;
  }

  if (data?.status === 'unsupported') {
    warnings.push(data.reason || 'runtime proof unsupported in this environment');
    score -= 20;
  } else if (data?.passed === false || Number(data?.summary?.failed || 0) > 0) {
    issues.push({ message: 'runtime proof failed', blocking: true });
    score = 0;
  }

  return { score, warnings, issues, facts: { status: data?.status || 'unknown' } };
}

function inspectArtifact(bfDir, rule) {
  const artifactPath = path.join(bfDir, rule.artifact);
  if (!fs.existsSync(artifactPath)) {
    const blocking = rule.blocking !== false;
    return {
      artifact: rule.artifact,
      kind: rule.kind,
      status: 'missing',
      trustScore: null,
      blocking,
      warnings: ['artifact not generated'],
      issues: blocking ? [{ message: 'required artifact missing', blocking: true }] : [],
      facts: {},
    };
  }

  const data = loadJson(artifactPath);
  if (!data) {
    return {
      artifact: rule.artifact,
      kind: rule.kind,
      status: 'invalid',
      trustScore: 0,
      blocking: rule.blocking !== false,
      warnings: [],
      issues: [{ message: 'invalid JSON', blocking: rule.blocking !== false }],
      facts: {},
    };
  }

  let inspected;
  if (rule.kind === 'verification') {
    inspected = inspectVerificationArtifact(data, rule);
  } else if (rule.kind === 'runtime') {
    inspected = inspectRuntimeArtifact(data, rule);
  } else {
    inspected = inspectScanArtifact(data, rule);
  }

  const trustScore = clampScore(inspected.score);
  const blocking = inspected.issues.some((issue) => issue.blocking);

  return {
    artifact: rule.artifact,
    kind: rule.kind,
    status: statusFromScore(trustScore, inspected.issues),
    trustScore,
    blocking,
    warnings: inspected.warnings,
    issues: inspected.issues,
    facts: inspected.facts,
  };
}

function buildToolReliabilityReport(bfDir) {
  const artifacts = TOOL_ARTIFACTS.map((rule) => inspectArtifact(bfDir, rule));
  const scored = artifacts.filter((artifact) => typeof artifact.trustScore === 'number');
  const trustScore =
    scored.length > 0
      ? clampScore(scored.reduce((sum, artifact) => sum + artifact.trustScore, 0) / scored.length)
      : null;
  const blockingFailures = artifacts.filter((artifact) => artifact.blocking);
  const degradedStatuses = new Set(['missing', 'warning', 'noisy', 'untrusted', 'invalid']);
  const degradedArtifacts = artifacts.filter((artifact) => degradedStatuses.has(artifact.status));
  const status = blockingFailures.length > 0 ? 'fail' : degradedArtifacts.length > 0 ? 'warn' : 'pass';

  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-brownfield-tool-reliability',
    status,
    trustScore,
    summary: {
      total: artifacts.length,
      present: artifacts.filter((artifact) => artifact.status !== 'missing').length,
      trusted: artifacts.filter((artifact) => artifact.status === 'trusted').length,
      warning: artifacts.filter((artifact) => artifact.status === 'warning').length,
      noisy: artifacts.filter((artifact) => artifact.status === 'noisy').length,
      untrusted: artifacts.filter((artifact) => artifact.status === 'untrusted').length,
      missing: artifacts.filter((artifact) => artifact.status === 'missing').length,
      invalid: artifacts.filter((artifact) => artifact.status === 'invalid').length,
      blockingFailures: blockingFailures.length,
    },
    degradedArtifacts: degradedArtifacts.map((artifact) => artifact.artifact),
    blockingFailures: blockingFailures.map((artifact) => artifact.artifact),
    artifacts,
  };
}

function writeToolReliabilityReport(bfDir, report = buildToolReliabilityReport(bfDir)) {
  fs.mkdirSync(bfDir, { recursive: true });
  const outPath = path.join(bfDir, 'brownfield-tool-health.json');
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return outPath;
}

function loadOrBuildToolReliabilityReport(bfDir, options = {}) {
  const reportPath = path.join(bfDir, 'brownfield-tool-health.json');
  const existing = options.refresh ? null : loadJson(reportPath);
  if (existing && typeof existing === 'object') return existing;

  const report = buildToolReliabilityReport(bfDir);
  if (options.write !== false) writeToolReliabilityReport(bfDir, report);
  return report;
}

module.exports = {
  TOOL_ARTIFACTS,
  buildToolReliabilityReport,
  isToolOnlyVerificationFailure,
  loadOrBuildToolReliabilityReport,
  writeToolReliabilityReport,
};
