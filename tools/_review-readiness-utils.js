const fs = require('node:fs');
const path = require('node:path');

const verifier = require('../source/hooks/cobolt-finding-verifier');
const { normalizeReviewData } = verifier._testOnly;

const REVIEW_FILES = {
  sourceManifest: '00-source-file-manifest.json',
  manifest: 'review-manifest.json',
  rawFindings: 'raw-findings.json',
  allFindings: 'all-findings.json',
  dedupedFindings: 'deduped-findings.json',
  reviewFindings: 'review-findings.json',
  findingVerification: 'finding-verification.json',
  rejectedPhantoms: 'rejected-phantoms.json',
  failuresSummary: 'failures-summary.json',
  coverageGaps: 'coverage-gaps.json',
  crossCategoryConflicts: 'cross-category-conflicts.json',
  crossValidation: 'cross-validation-report.json',
  enhancementAdvisory: 'enhancement-advisory.md',
  evidenceIndex: 'review-evidence-index.json',
  accuracyReport: 'review-accuracy-report.json',
  readinessGate: 'review-readiness-gate.json',
  riskRegister: 'review-risk-register.json',
  riskAcceptance: 'risk-acceptance.json',
  reviewerProfilePolicy: 'reviewer-profile-policy.json',
  coverageMatrix: 'review-coverage-matrix.json',
  releaseGate: 'review-release-gate.json',
  challengeBacklog: 'review-challenge-backlog.json',
  authzReplayGate: 'review-authz-replay-gate.json',
  handoff: 'review-handoff.json',
  decisionLog: 'review-decision-log.md',
};

function defaultReviewDir(projectRoot) {
  return path.join(path.resolve(projectRoot || process.cwd()), '_cobolt-output', 'latest', 'review');
}

function loadJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadText(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function detectProjectRoot(reviewDir) {
  const resolved = path.resolve(reviewDir || defaultReviewDir());
  const marker = `${path.sep}_cobolt-output${path.sep}`;
  const markerIndex = resolved.lastIndexOf(marker);
  if (markerIndex !== -1) return resolved.slice(0, markerIndex);
  return path.resolve(resolved, '..', '..', '..');
}

function readCoboltState(projectRoot) {
  return loadJson(path.join(projectRoot || process.cwd(), 'cobolt-state.json'));
}

function detectMilestone(reviewData, projectRoot) {
  const state = readCoboltState(projectRoot);
  return (
    reviewData?.milestone ||
    state?.currentMilestone ||
    state?.build?.currentMilestone ||
    state?.pipeline?.currentMilestone ||
    null
  );
}

function resolveSourceFile(projectRoot, filePath) {
  if (!filePath) return null;
  if (path.isAbsolute(filePath)) {
    return fs.existsSync(filePath) ? filePath : null;
  }

  const candidate = path.resolve(projectRoot || process.cwd(), filePath);
  if (fs.existsSync(candidate)) return candidate;

  const normalized = String(filePath).replace(/\//g, path.sep);
  const alternate = path.resolve(projectRoot || process.cwd(), normalized);
  if (fs.existsSync(alternate)) return alternate;

  return null;
}

function readReviewData(reviewDir) {
  const payload = loadJson(path.join(reviewDir, REVIEW_FILES.reviewFindings));
  return payload ? normalizeReviewData(payload) : null;
}

function readVerificationData(reviewDir) {
  return loadJson(path.join(reviewDir, REVIEW_FILES.findingVerification));
}

function mergeVerification(reviewData, verificationData) {
  if (!reviewData) return null;
  const resultById = new Map(
    (verificationData?.results || []).map((result) => [String(result.id || '').trim(), result]),
  );

  return {
    ...reviewData,
    findings: (reviewData.findings || []).map((finding) => {
      const match = resultById.get(String(finding.id || '').trim());
      if (!match) return finding;
      return {
        ...finding,
        verification: {
          status: match.status,
          confidence: match.confidence,
          flags: Array.isArray(match.flags) ? match.flags : [],
        },
      };
    }),
  };
}

function listFindings(reviewDir) {
  const reviewData = readReviewData(reviewDir);
  const verificationData = readVerificationData(reviewDir);
  return mergeVerification(reviewData, verificationData)?.findings || [];
}

function extractFindingIds(text) {
  if (!text) return [];
  const matches = text.match(/\b([A-Z]{2,}(?:-)?\d{3,})\b/g) || [];
  const normalized = matches.map((match) => {
    const dashed = match.match(/^([A-Z]+)-(\d+)$/);
    if (!dashed) return match;
    return `${dashed[1]}${String(parseInt(dashed[2], 10)).padStart(3, '0')}`;
  });
  return [...new Set(normalized)];
}

function severityWeight(severity) {
  switch (String(severity || '').toLowerCase()) {
    case 'critical':
      return 0;
    case 'high':
      return 1;
    case 'medium':
      return 2;
    case 'low':
      return 3;
    default:
      return 4;
  }
}

function selectTopFindings(findings, options = {}) {
  const statuses = new Set((options.statuses || []).map((status) => String(status || '').toLowerCase()));
  const severities = new Set((options.severities || []).map((severity) => String(severity || '').toLowerCase()));
  const limit = Math.max(1, Number(options.limit || 5));

  return (findings || [])
    .filter((finding) => {
      const findingStatus = String(finding.verification?.status || 'unverified').toLowerCase();
      const findingSeverity = String(finding.severity || '').toLowerCase();
      const statusMatch = statuses.size === 0 || statuses.has(findingStatus);
      const severityMatch = severities.size === 0 || severities.has(findingSeverity);
      return statusMatch && severityMatch;
    })
    .sort((left, right) => {
      const severityCompare = severityWeight(left.severity) - severityWeight(right.severity);
      if (severityCompare !== 0) return severityCompare;
      return String(left.id || '').localeCompare(String(right.id || ''));
    })
    .slice(0, limit);
}

function inspectFindingLocations(findings, projectRoot) {
  const failures = [];

  for (const finding of findings || []) {
    const filePath = finding.location?.file || finding.file;
    const line = Number(finding.location?.line || finding.line || 0);
    const findingId = String(finding.id || 'unknown');

    if (!filePath) {
      failures.push(`${findingId}: missing file location`);
      continue;
    }

    const resolved = resolveSourceFile(projectRoot, filePath);
    if (!resolved) {
      failures.push(`${findingId}: source file not found (${filePath})`);
      continue;
    }

    const lines = loadText(resolved)?.split(/\r?\n/) || [];
    if (!Number.isFinite(line) || line <= 0 || line > lines.length) {
      failures.push(`${findingId}: invalid line ${line} for ${filePath} (${lines.length} lines)`);
    }
  }

  return {
    pass: failures.length === 0,
    detail:
      failures.length === 0
        ? `All ${Math.max((findings || []).length, 0)} sampled findings resolve to real files and valid lines`
        : failures.join('; '),
    failures,
  };
}

function validateSourceManifest(reviewDir) {
  const manifestPath = path.join(reviewDir, REVIEW_FILES.sourceManifest);
  const manifest = loadJson(manifestPath);
  if (!manifest) {
    return { pass: false, detail: `${REVIEW_FILES.sourceManifest} missing or invalid JSON`, manifest: null };
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    return { pass: false, detail: `${REVIEW_FILES.sourceManifest} has no files`, manifest };
  }
  return { pass: true, detail: `${manifest.files.length} files listed in the source manifest`, manifest };
}

function validateEvidenceIndex(reviewDir) {
  const evidencePath = path.join(reviewDir, REVIEW_FILES.evidenceIndex);
  const evidence = loadJson(evidencePath);
  if (!evidence) {
    return { pass: false, detail: `${REVIEW_FILES.evidenceIndex} missing or invalid JSON`, evidence: null };
  }

  const entries = Array.isArray(evidence.entries)
    ? evidence.entries
    : Array.isArray(evidence.evidence)
      ? evidence.evidence
      : null;

  if (!entries || entries.length === 0) {
    return { pass: false, detail: `${REVIEW_FILES.evidenceIndex} has no entries`, evidence };
  }

  const integrityValid = evidence.integrity?.valid !== false;
  return {
    pass: integrityValid,
    detail: integrityValid
      ? `${entries.length} evidence entries with valid integrity`
      : `${REVIEW_FILES.evidenceIndex} reports integrity issues`,
    evidence,
    entries,
  };
}

function countReviewerCoverage(reviewDir, reviewData) {
  const manifest = loadJson(path.join(reviewDir, REVIEW_FILES.manifest));
  const completed = Array.isArray(manifest?.completed) ? manifest.completed : [];
  const reviewers = new Set([...completed, ...(reviewData?.reviewers || [])].filter(Boolean));
  return {
    total: reviewers.size,
    reviewers: [...reviewers].sort(),
  };
}

function summarizeFindingStatuses(findings) {
  const summary = {
    total: (findings || []).length,
    verified: 0,
    unverified: 0,
    rejected: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  };

  for (const finding of findings || []) {
    const status = String(finding.verification?.status || 'unverified').toLowerCase();
    if (summary[status] !== undefined) summary[status] += 1;
    const severity = String(finding.severity || '').toLowerCase();
    if (summary.bySeverity[severity] !== undefined) summary.bySeverity[severity] += 1;
  }

  return summary;
}

function detectSurfaceSignals(projectRoot, reviewDir, manifest) {
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  const hasUIFiles = files.some((filePath) => /\.(tsx|jsx|vue|svelte|html|heex|leex)$/i.test(filePath));
  const hasHttpSurface = files.some(
    (filePath) =>
      /(^|\/)(api|routes?|routers?|controllers?|handlers?)(\/|$)/i.test(filePath) ||
      /(router|routes?|controller|handler)\.(js|jsx|ts|tsx|go|ex|exs|py|rb|php)$/i.test(path.basename(filePath)),
  );
  const browserSmoke =
    fs.existsSync(path.join(projectRoot, '_cobolt-output', 'latest', 'build', 'browser-smoke.json')) ||
    fs.existsSync(path.join(reviewDir, '..', 'build', 'browser-smoke.json'));

  return {
    hasUI: hasUIFiles || browserSmoke,
    hasHttpSurface,
    hasBrowserEvidence: browserSmoke,
    hasExternalSurface: hasUIFiles || browserSmoke || hasHttpSurface,
  };
}

function findReviewReport(projectRoot, milestone) {
  if (!milestone) return null;
  const reportsDir = path.join(projectRoot, '_cobolt-output', 'reports', milestone);
  if (!fs.existsSync(reportsDir)) return null;

  const explicitCandidates = [
    path.join(reportsDir, `${milestone}-review-report.md`),
    path.join(reportsDir, `${milestone}-P1-review-report.md`),
    path.join(reportsDir, `${milestone}-P7-review-report.md`),
  ];
  const directMatch = explicitCandidates.find((candidate) => fs.existsSync(candidate));
  if (directMatch) return directMatch;

  const fallback = fs.readdirSync(reportsDir).find((fileName) => /review-report\.md$/i.test(fileName));
  return fallback ? path.join(reportsDir, fallback) : null;
}

// Shared --help flag handler for review tools. Honors the no-side-effect
// contract: when --help / -h is present, prints usage and exits 0 BEFORE any
// fs.writeFileSync / fs.mkdirSync runs. Returns true when help was printed
// (the caller should treat that as "stop"); the caller normally passes the
// result of process.argv.slice(2) and a usage string.
function maybePrintHelpAndExit(args, usage) {
  if (!Array.isArray(args)) return false;
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    process.exit(0);
  }
  return false;
}

module.exports = {
  REVIEW_FILES,
  countReviewerCoverage,
  defaultReviewDir,
  detectMilestone,
  detectProjectRoot,
  detectSurfaceSignals,
  extractFindingIds,
  findReviewReport,
  inspectFindingLocations,
  listFindings,
  loadJson,
  loadText,
  maybePrintHelpAndExit,
  mergeVerification,
  readCoboltState,
  readReviewData,
  readVerificationData,
  resolveSourceFile,
  selectTopFindings,
  severityWeight,
  summarizeFindingStatuses,
  validateEvidenceIndex,
  validateSourceManifest,
};
