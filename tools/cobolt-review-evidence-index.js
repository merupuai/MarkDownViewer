#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { buildProvenance } = require('./_brownfield-provenance');
const {
  REVIEW_FILES,
  defaultReviewDir,
  detectMilestone,
  detectProjectRoot,
  findReviewReport,
  loadJson,
  maybePrintHelpAndExit,
  readReviewData,
} = require('./_review-readiness-utils');

const USAGE = `Usage: node tools/cobolt-review-evidence-index.js build [--dir <path>] [--json]

Commands:
  build    Build review-evidence-index.json linking review artifacts to source tools/agents

Flags:
  --dir <path>  Review dir (default: _cobolt-output/latest/review)
  --json        Emit machine-readable JSON
  --help, -h    Show this help and exit
`;

const ARTIFACT_SOURCES = [
  { pattern: REVIEW_FILES.sourceManifest, source: 'cobolt-review-file-manifest', type: 'tool' },
  { pattern: REVIEW_FILES.manifest, source: 'review-lead', type: 'tracker' },
  { pattern: REVIEW_FILES.rawFindings, source: 'review-lead', type: 'collector' },
  { pattern: REVIEW_FILES.allFindings, source: 'review-lead', type: 'collector' },
  { pattern: REVIEW_FILES.dedupedFindings, source: 'cobolt-finding-dedup', type: 'tool' },
  { pattern: REVIEW_FILES.reviewFindings, source: 'review-lead', type: 'registry' },
  { pattern: REVIEW_FILES.findingVerification, source: 'cobolt-finding-verifier', type: 'tool' },
  { pattern: REVIEW_FILES.rejectedPhantoms, source: 'cobolt-finding-verifier', type: 'audit' },
  { pattern: REVIEW_FILES.failuresSummary, source: 'review-lead', type: 'summary' },
  { pattern: REVIEW_FILES.coverageGaps, source: 'review-lead', type: 'audit' },
  { pattern: REVIEW_FILES.crossCategoryConflicts, source: 'review-lead', type: 'audit' },
  { pattern: REVIEW_FILES.crossValidation, source: 'review-lead', type: 'summary' },
  { pattern: REVIEW_FILES.enhancementAdvisory, source: 'enhancement-advisor', type: 'agent' },
  { pattern: REVIEW_FILES.accuracyReport, source: 'cobolt-review-accuracy', type: 'tool' },
  { pattern: REVIEW_FILES.readinessGate, source: 'cobolt-review-readiness-gate', type: 'tool' },
  { pattern: REVIEW_FILES.handoff, source: 'cobolt-review-handoff', type: 'tool' },
  { pattern: REVIEW_FILES.decisionLog, source: 'cobolt-review-handoff', type: 'summary' },
];

function buildEvidenceIndex(reviewDir) {
  const resolvedReviewDir = path.resolve(reviewDir || defaultReviewDir());
  const projectRoot = detectProjectRoot(resolvedReviewDir);
  const reviewData = readReviewData(resolvedReviewDir);
  const milestone = detectMilestone(reviewData, projectRoot);
  const entries = [];
  const integrity = { valid: true, invalidEntries: 0, issues: [] };
  let found = 0;

  for (const artifact of ARTIFACT_SOURCES) {
    const artifactPath = path.join(resolvedReviewDir, artifact.pattern);
    if (!fs.existsSync(artifactPath)) continue;

    found += 1;
    const stat = fs.statSync(artifactPath);
    const entry = {
      artifact: artifact.pattern,
      path: artifactPath,
      source: artifact.source,
      sourceType: artifact.type,
      sizeBytes: stat.size,
      lastModified: stat.mtime.toISOString(),
      relatedDocs: [],
      relatedIssues: [],
      confidence: artifact.type === 'tool' ? 1.0 : 0.85,
    };

    if (artifact.pattern.endsWith('.json') && stat.size < 5 * 1024 * 1024) {
      const data = loadJson(artifactPath);
      if (Array.isArray(data?.findings)) entry.findingCount = data.findings.length;
      if (Array.isArray(data?.results)) entry.resultCount = data.results.length;
      if (Array.isArray(data?.gates)) entry.gateCount = data.gates.length;
      if (Array.isArray(data?.entries)) entry.entryCount = data.entries.length;
      if (Array.isArray(data?.blockingFindings)) entry.blockingCount = data.blockingFindings.length;
    }

    if (artifact.pattern.endsWith('.md') && stat.size < 2 * 1024 * 1024) {
      const content = fs.readFileSync(artifactPath, 'utf8');
      const matches = content.match(/\b[A-Z]{2,}\d{3,}\b/g);
      if (matches) entry.findingCount = new Set(matches).size;
    }

    if (stat.size <= 0) {
      integrity.valid = false;
      integrity.invalidEntries += 1;
      integrity.issues.push({ artifact: artifact.pattern, issue: 'empty-artifact-size' });
    }

    entries.push(entry);
  }

  const reportArtifact = findReviewReport(projectRoot, milestone);
  if (reportArtifact && fs.existsSync(reportArtifact)) {
    const stat = fs.statSync(reportArtifact);
    entries.push({
      artifact: path.relative(resolvedReviewDir, reportArtifact).replace(/\\/g, '/'),
      path: reportArtifact,
      source: 'review-lead',
      sourceType: 'report',
      sizeBytes: stat.size,
      lastModified: stat.mtime.toISOString(),
      relatedDocs: [],
      relatedIssues: [],
      confidence: 0.9,
    });
  }

  const index = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-review-evidence-index',
    reviewDir: resolvedReviewDir,
    milestone,
    ...buildProvenance(
      projectRoot,
      entries.map((entry) => entry.path),
    ),
    artifactCount: entries.length,
    totalExpected: ARTIFACT_SOURCES.length,
    completeness: ARTIFACT_SOURCES.length === 0 ? 100 : Math.round((found / ARTIFACT_SOURCES.length) * 100),
    integrity,
    entries,
  };

  const outPath = path.join(resolvedReviewDir, REVIEW_FILES.evidenceIndex);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  return index;
}

function main() {
  const args = process.argv.slice(2);
  maybePrintHelpAndExit(args, USAGE);
  const command = args[0] || 'build';
  const dirIdx = args.indexOf('--dir');
  const reviewDir = dirIdx !== -1 && args[dirIdx + 1] ? args[dirIdx + 1] : defaultReviewDir();
  const jsonMode = args.includes('--json');

  if (command !== 'build') {
    console.log('CoBolt Review Evidence Index');
    console.log('');
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }

  const index = buildEvidenceIndex(reviewDir);
  if (jsonMode) {
    console.log(JSON.stringify(index, null, 2));
    return;
  }

  console.log('[cobolt-review-evidence-index] Evidence Index');
  console.log(`  Review dir: ${index.reviewDir}`);
  console.log(`  Milestone: ${index.milestone || 'unknown'}`);
  console.log(`  Artifacts: ${index.artifactCount}`);
  console.log(`  Integrity: ${index.integrity.valid ? 'valid' : 'invalid'}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  ARTIFACT_SOURCES,
  buildEvidenceIndex,
};
