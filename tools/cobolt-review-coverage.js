#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { baselinePrefixesForMode, toReviewerPrefix } = require('../lib/cobolt-reviewer-registry');
const {
  REVIEW_FILES,
  defaultReviewDir,
  detectMilestone,
  detectProjectRoot,
  detectSurfaceSignals,
  listFindings,
  loadJson,
  maybePrintHelpAndExit,
  validateSourceManifest,
} = require('./_review-readiness-utils');

const USAGE = `Usage: node tools/cobolt-review-coverage.js check [--dir <path>] [--review-id <id>] [--json]

Commands:
  check    Compare review manifest against required reviewer prefixes and emit coverage verdict

Flags:
  --dir <path>        Review dir (default: _cobolt-output/latest/review)
  --review-id <id>    Override review id used for the verdict file name
  --json              Emit machine-readable JSON
  --help, -h          Show this help and exit
`;

function toPrefix(agentOrPrefix) {
  return toReviewerPrefix(agentOrPrefix);
}

function loadReviewManifest(reviewDir) {
  return loadJson(path.join(reviewDir, REVIEW_FILES.manifest)) || {};
}

function loadPacket(reviewDir, reviewId) {
  const candidates = [
    path.join(reviewDir, `${reviewId}-review-packet.json`),
    path.join(reviewDir, 'codebase-review-packet.json'),
  ];

  for (const candidate of candidates) {
    const payload = loadJson(candidate);
    if (payload) return payload;
  }

  return null;
}

function requiredPrefixes(surfaceSignals, options = {}) {
  return baselinePrefixesForMode({ ...options, surfaceSignals }).sort();
}

function collectCompletedPrefixes(reviewManifest, findings) {
  const prefixes = new Set();

  for (const reviewer of reviewManifest.completed || []) {
    const prefix = toPrefix(reviewer);
    if (prefix) prefixes.add(prefix);
  }

  for (const finding of findings || []) {
    const prefix = toPrefix(finding.prefix || finding.id);
    if (prefix) prefixes.add(prefix);
  }

  return [...prefixes].sort();
}

function collectReviewedFiles(reviewManifest, findings) {
  const files = new Set();

  for (const filePath of reviewManifest.reviewedFiles || []) {
    files.add(String(filePath).replace(/\\/g, '/'));
  }

  for (const finding of findings || []) {
    const filePath = finding.location?.file || finding.file;
    if (filePath) files.add(String(filePath).replace(/\\/g, '/'));
  }

  return [...files].sort();
}

function buildCoverageReport(reviewDir, options = {}) {
  const resolvedReviewDir = path.resolve(reviewDir || defaultReviewDir());
  const projectRoot = detectProjectRoot(resolvedReviewDir);
  const reviewManifest = loadReviewManifest(resolvedReviewDir);
  const reviewData = loadJson(path.join(resolvedReviewDir, REVIEW_FILES.reviewFindings));
  const milestone = options.reviewId || detectMilestone(reviewData, projectRoot) || 'codebase';
  const packet = loadPacket(resolvedReviewDir, milestone);
  const manifestCheck = validateSourceManifest(resolvedReviewDir);
  const findings = listFindings(resolvedReviewDir);
  const surfaceSignals = detectSurfaceSignals(projectRoot, resolvedReviewDir, manifestCheck.manifest);

  const filesInScope = Array.isArray(packet?.scope?.filesInScope)
    ? packet.scope.filesInScope
    : Array.isArray(manifestCheck.manifest?.files)
      ? manifestCheck.manifest.files
      : [];

  const reviewedFiles = collectReviewedFiles(reviewManifest, findings);
  const uncoveredFiles = filesInScope.filter((filePath) => !reviewedFiles.includes(filePath));
  const completedPrefixes = collectCompletedPrefixes(reviewManifest, findings);
  const mustHavePrefixes = requiredPrefixes(surfaceSignals, { reviewId: milestone });
  const missingPrefixes = mustHavePrefixes.filter((prefix) => !completedPrefixes.includes(prefix));
  const coverageRatio = filesInScope.length > 0 ? Math.round((reviewedFiles.length / filesInScope.length) * 100) : 100;

  const coverage = {
    version: '2.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-review-coverage',
    reviewDir: resolvedReviewDir,
    sourceRoot: projectRoot,
    reviewId: milestone,
    passed: missingPrefixes.length === 0 && coverageRatio >= 80,
    scope: {
      totalFiles: filesInScope.length,
      reviewedFiles: reviewedFiles.length,
      coverageRatio,
    },
    prefixes: {
      required: mustHavePrefixes,
      completed: completedPrefixes,
      missing: missingPrefixes,
    },
    gaps: {
      uncoveredFiles,
      findingsWithoutCoverage: Math.max(filesInScope.length - reviewedFiles.length, 0),
    },
    surfaceSignals,
    notes: [],
  };

  if (filesInScope.length === 0) {
    coverage.notes.push('No scoped files were available; treating coverage as informational only.');
  }
  if (reviewedFiles.length === 0) {
    coverage.notes.push(
      'No reviewedFiles were recorded in review-manifest.json; file coverage falls back to findings only.',
    );
  }

  fs.mkdirSync(resolvedReviewDir, { recursive: true });
  fs.writeFileSync(
    path.join(resolvedReviewDir, REVIEW_FILES.coverageGaps),
    `${JSON.stringify(coverage, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(resolvedReviewDir, `${milestone}-coverage-verdict.json`),
    `${JSON.stringify(coverage, null, 2)}\n`,
    'utf8',
  );

  if (!coverage.passed) {
    const targetedReruns = {
      generatedAt: coverage.generatedAt,
      reviewId: milestone,
      missingPrefixes,
      uncoveredFiles,
    };
    fs.writeFileSync(
      path.join(resolvedReviewDir, `${milestone}-targeted-reruns.json`),
      `${JSON.stringify(targetedReruns, null, 2)}\n`,
      'utf8',
    );
  }

  return coverage;
}

function main() {
  const args = process.argv.slice(2);
  maybePrintHelpAndExit(args, USAGE);
  const command = args[0] || 'check';
  const dirIdx = args.indexOf('--dir');
  const reviewDir = dirIdx !== -1 && args[dirIdx + 1] ? args[dirIdx + 1] : defaultReviewDir();
  const reviewIdIdx = args.indexOf('--review-id');
  const jsonMode = args.includes('--json');

  if (command !== 'check') {
    console.log('CoBolt Review Coverage');
    console.log('');
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }

  const coverage = buildCoverageReport(reviewDir, {
    reviewId: reviewIdIdx !== -1 && args[reviewIdIdx + 1] ? args[reviewIdIdx + 1] : undefined,
  });

  if (jsonMode) {
    console.log(JSON.stringify(coverage, null, 2));
    return;
  }

  console.log('[cobolt-review-coverage] Coverage Verdict');
  console.log(`  Review ID: ${coverage.reviewId}`);
  console.log(`  Passed: ${coverage.passed}`);
  console.log(`  Files in scope: ${coverage.scope.reviewedFiles}/${coverage.scope.totalFiles}`);
  console.log(`  Required prefixes: ${coverage.prefixes.required.join(', ')}`);
  console.log(`  Missing prefixes: ${coverage.prefixes.missing.join(', ') || 'none'}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildCoverageReport,
  collectCompletedPrefixes,
  collectReviewedFiles,
  requiredPrefixes,
};
