#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { getLatestRoot } = require('../lib/cobolt-planning-artifacts');

const STAGE_ORDER = [
  'planning',
  'build',
  'review',
  'pentest',
  'fix',
  'audit',
  'deploy',
  'dream',
  'gap',
  'pr',
  'resolve',
  'health',
  'test-suite',
];

const STAGE_LABELS = {
  planning: 'Planning',
  build: 'Build',
  review: 'Review',
  pentest: 'Pentest',
  fix: 'Fix',
  audit: 'Audit',
  deploy: 'Deploy',
  dream: 'Dream',
  gap: 'Gap',
  pr: 'Pull Request',
  resolve: 'Resolve',
  health: 'Health',
  'test-suite': 'Test Suite',
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function latestRoot(projectDir = process.cwd()) {
  return getLatestRoot(projectDir);
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function detectLatestStage(projectDir = process.cwd()) {
  const root = latestRoot(projectDir);
  for (let index = STAGE_ORDER.length - 1; index >= 0; index -= 1) {
    const stage = STAGE_ORDER[index];
    const stageDir = path.join(root, stage);
    if (!fs.existsSync(stageDir)) continue;
    const files = fs.readdirSync(stageDir);
    if (files.length > 0) return stage;
  }

  for (const stage of STAGE_ORDER) {
    const stageDir = path.join(root, stage);
    if (fs.existsSync(stageDir)) return stage;
  }

  return null;
}

function resolveStageContext(projectDir = process.cwd(), requestedStage) {
  const root = latestRoot(projectDir);
  const stage = requestedStage || detectLatestStage(projectDir);
  if (!stage) {
    return { latestRoot: root, stage: null, stageDir: null };
  }

  return {
    latestRoot: root,
    stage,
    stageDir: path.join(root, stage),
  };
}

function countHallucinationFindings(logData) {
  if (!logData) return 0;
  if (Array.isArray(logData.findings)) return logData.findings.length;
  if (Array.isArray(logData.entries)) return logData.entries.length;
  if (Array.isArray(logData)) return logData.length;
  return 0;
}

function collectStageTrust(projectDir = process.cwd(), requestedStage) {
  const context = resolveStageContext(projectDir, requestedStage);
  const report = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    stage: context.stage,
    stageLabel: STAGE_LABELS[context.stage] || context.stage || 'Unknown',
    stageDir: context.stageDir,
    latestRoot: context.latestRoot,
    files: [],
    trustScore: 50,
    verdict: 'manual-review',
    bands: {
      proven: 0,
      computed: 0,
      signaled: 0,
      conflicted: 0,
      pending: 0,
    },
    entries: [],
    nextChecks: [],
  };

  if (!context.stageDir || !fs.existsSync(context.stageDir)) {
    report.entries.push({
      band: 'pending',
      title: 'No stage output found',
      detail: 'The latest run does not have a populated stage directory to analyze yet.',
      sourceFile: null,
    });
    report.bands.pending += 1;
    return report;
  }

  report.files = fs
    .readdirSync(context.stageDir)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  function addEntry(band, title, detail, sourceFile, scoreDelta, nextCheck) {
    report.entries.push({ band, title, detail, sourceFile });
    report.bands[band] += 1;
    report.trustScore += scoreDelta;
    if (nextCheck) report.nextChecks.push(nextCheck);
  }

  const reviewFindings = readJsonIfExists(path.join(context.stageDir, 'review-findings.json'));
  if (reviewFindings) {
    const total = reviewFindings.summary?.total ?? reviewFindings.findings?.length ?? 0;
    const verified = reviewFindings.verification?.verified ?? 0;
    const unverified = reviewFindings.verification?.unverified ?? 0;
    const rejected = reviewFindings.verification?.rejected ?? 0;
    const hallucinationRate = reviewFindings.verification?.estimatedHallucinationRate ?? null;

    if (total > 0 && unverified === 0 && rejected === 0 && (hallucinationRate === null || hallucinationRate <= 5)) {
      addEntry(
        'proven',
        'Review findings are tightly verified',
        `${verified}/${total} findings are marked verified with no outstanding rejections.`,
        'review-findings.json',
        20,
      );
    } else {
      addEntry(
        'conflicted',
        'Review findings still need trust cleanup',
        `${verified}/${total} verified, ${unverified} unverified, ${rejected} rejected.`,
        'review-findings.json',
        -14,
        'Re-run finding verification before treating review output as release-ready.',
      );
    }
  }

  const sourceCoverage = readJsonIfExists(path.join(context.stageDir, 'source-coverage-report.json'));
  if (sourceCoverage) {
    if (sourceCoverage.passed === true && sourceCoverage.coverage >= 85) {
      const detail = sourceCoverage.skipped
        ? `${sourceCoverage.reason || 'Source packet not required for this run.'}`
        : `${sourceCoverage.coverage}% source coverage with ${sourceCoverage.unmatchedRequirements || 0} unmatched requirements.`;
      addEntry('computed', 'Source coverage is healthy', detail, 'source-coverage-report.json', 10);
    } else {
      addEntry(
        'conflicted',
        'Source coverage is below the desired line',
        `${sourceCoverage.coverage || 0}% coverage and ${sourceCoverage.unmatchedRequirements || 0} unmatched requirements.`,
        'source-coverage-report.json',
        -12,
        'Close traceability gaps before promoting this planning packet downstream.',
      );
    }
  }

  const trustEvidence = readJsonIfExists(path.join(context.stageDir, 'trust-evidence.json'));
  if (trustEvidence) {
    const total = trustEvidence.summary?.totalAttestations ?? 0;
    const failed = trustEvidence.summary?.failed ?? 0;
    const escalated = trustEvidence.summary?.escalated ?? 0;

    if (total > 0 && failed === 0 && escalated === 0) {
      addEntry(
        'proven',
        'Hook attestations are clean',
        `${total} attestations recorded with no failures or escalations.`,
        'trust-evidence.json',
        15,
      );
    } else if (total > 0) {
      addEntry(
        'conflicted',
        'Hook attestations need attention',
        `${failed} failures and ${escalated} escalations across ${total} attestations.`,
        'trust-evidence.json',
        -12,
        'Inspect failing hooks before treating this stage as grounded.',
      );
    } else {
      addEntry(
        'pending',
        'No attestations were recorded',
        'The trust evidence file exists but contains no attestations yet.',
        'trust-evidence.json',
        -6,
      );
    }
  }

  const hallucinationLog = readJsonIfExists(path.join(context.stageDir, 'hallucination-log.json'));
  if (hallucinationLog) {
    const issueCount = countHallucinationFindings(hallucinationLog);
    if (issueCount === 0) {
      addEntry(
        'proven',
        'Hallucination log is clean',
        'No unresolved hallucination incidents were recorded for this stage.',
        'hallucination-log.json',
        12,
      );
    } else {
      addEntry(
        'conflicted',
        'Hallucination incidents were recorded',
        `${issueCount} logged incident(s) still need human review or cleanup.`,
        'hallucination-log.json',
        -18,
        'Resolve or explain hallucination incidents before using this stage for executive reporting.',
      );
    }
  }

  // M5 — fold in eval evidence as a signal (advisory). Deterministic proofs
  // above still drive the primary trust score; judges never override them.
  try {
    const rollupPath = path.join(
      path.dirname(path.dirname(context.stageDir || '')),
      '..',
      'evals',
      'history',
      'score-history.json',
    );
    // More robust: derive from latestRoot -> outputRoot.
    const outputRoot = path.dirname(path.dirname(context.latestRoot || ''));
    const evalsRollup = path.join(outputRoot, 'evals', 'history', 'score-history.json');
    const rollup = readJsonIfExists(fs.existsSync(evalsRollup) ? evalsRollup : rollupPath);
    if (rollup?.overall) {
      const composite = Number(rollup.overall.latest || 0);
      const hardFailures = Number(rollup.overall.hardFailures || 0);
      if (hardFailures === 0 && composite >= 0.85) {
        addEntry(
          'computed',
          'Eval rollup is healthy',
          `composite=${composite.toFixed(3)}, 7-day avg=${(rollup.overall.movingAverage7d ?? 0).toFixed(3)}, hard failures=${hardFailures}`,
          'evals/history/score-history.json',
          6,
        );
      } else {
        addEntry(
          'signaled',
          'Eval rollup is present but below trust threshold',
          `composite=${composite.toFixed(3)}, hard failures=${hardFailures}`,
          'evals/history/score-history.json',
          -4,
          'Review _cobolt-output/reports/evals/eval-summary.md and close hard failures.',
        );
      }
    }
  } catch {
    /* advisory — never break trust generation */
  }

  if (report.entries.length === 0 && report.files.length > 0) {
    addEntry(
      'signaled',
      'Stage produced artifacts but no trust-specific signals',
      `${report.files.length} file(s) exist, but no structured trust signal was found yet.`,
      null,
      4,
      'Add verification artifacts for this stage before treating it as fully grounded.',
    );
  }

  if (report.files.length === 0) {
    addEntry(
      'pending',
      'Stage directory is empty',
      'The stage exists but does not contain any files yet.',
      null,
      -10,
      'Run the stage or confirm that outputs were written to the expected location.',
    );
  }

  const positiveSignals = report.bands.proven + report.bands.computed;
  const negativeSignals = report.bands.conflicted + report.bands.pending;
  if (negativeSignals === 0 && positiveSignals > 0) {
    report.trustScore = Math.max(report.trustScore, 65);
  }

  report.trustScore = clamp(report.trustScore, 0, 100);
  report.verdict = report.trustScore >= 80 ? 'grounded' : report.trustScore >= 60 ? 'watch' : 'manual-review';

  if (report.nextChecks.length === 0) {
    if (negativeSignals === 0) {
      report.nextChecks.push(
        report.verdict === 'grounded'
          ? 'Proceed with the next pipeline gate and keep the trust report as sidecar evidence.'
          : 'Proceed to the next gate, but treat this as an evidence-light stage until stronger verification artifacts land.',
      );
    } else {
      report.nextChecks.push('Keep this stage under review until the conflicted or pending signals are cleared.');
    }
  }

  return report;
}

function renderTrustMarkdown(report) {
  const lines = [
    '# CoBolt Trust Report',
    '',
    `**Stage:** ${report.stageLabel}`,
    `**Trust Score:** ${report.trustScore}/100`,
    `**Verdict:** ${report.verdict}`,
    report.stageDir ? `**Stage Directory:** ${report.stageDir}` : '',
    '',
    '## Evidence Bands',
    '',
    `- Proven: ${report.bands.proven}`,
    `- Computed: ${report.bands.computed}`,
    `- Signaled: ${report.bands.signaled}`,
    `- Conflicted: ${report.bands.conflicted}`,
    `- Pending: ${report.bands.pending}`,
    '',
    '## Key Signals',
    '',
  ];

  if (report.entries.length === 0) {
    lines.push('- No signals were recorded.');
  } else {
    for (const entry of report.entries) {
      lines.push(
        `- [${entry.band}] ${entry.title}: ${entry.detail}${entry.sourceFile ? ` (${entry.sourceFile})` : ''}`,
      );
    }
  }

  lines.push('', '## Next Checks', '');
  for (const item of report.nextChecks) {
    lines.push(`- ${item}`);
  }
  lines.push('');

  return lines.filter(Boolean).join('\n');
}

function writeTrustArtifacts(report) {
  if (!report.stageDir) {
    return { json: null, md: null };
  }

  fs.mkdirSync(report.stageDir, { recursive: true });
  const jsonPath = path.join(report.stageDir, 'trust-report.json');
  const mdPath = path.join(report.stageDir, 'trust-report.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, `${renderTrustMarkdown(report)}\n`, 'utf8');
  return { json: jsonPath, md: mdPath };
}

function generateTrust(projectDir = process.cwd(), requestedStage) {
  const report = collectStageTrust(projectDir, requestedStage);
  const paths = writeTrustArtifacts(report);
  return { report, paths };
}

function printUsage() {
  console.log('Usage: node tools/cobolt-trust.js <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  generate [--stage <name>] [--json]   Generate and save trust artifacts');
  console.log('  show [--stage <name>] [--json]       Render trust output without changing files');
  console.log('');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || 'generate';
  const jsonMode = args.includes('--json');
  const stageIndex = args.indexOf('--stage');
  const stage = stageIndex >= 0 ? args[stageIndex + 1] : null;

  if (command === '--help' || command === '-h' || command === 'help') {
    printUsage();
    process.exit(0);
  }

  if (command === 'generate') {
    const result = generateTrust(process.cwd(), stage);
    console.log(
      jsonMode
        ? JSON.stringify(result.report, null, 2)
        : `Trust report saved to ${result.paths.json || '(not written)'} and ${result.paths.md || '(not written)'}`,
    );
    process.exit(result.report.verdict === 'manual-review' ? 1 : 0);
  }

  if (command === 'show') {
    const report = collectStageTrust(process.cwd(), stage);
    console.log(jsonMode ? JSON.stringify(report, null, 2) : renderTrustMarkdown(report));
    process.exit(report.verdict === 'manual-review' ? 1 : 0);
  }

  printUsage();
  process.exit(2);
}

module.exports = {
  STAGE_ORDER,
  STAGE_LABELS,
  latestRoot,
  detectLatestStage,
  resolveStageContext,
  readJsonIfExists,
  countHallucinationFindings,
  collectStageTrust,
  renderTrustMarkdown,
  writeTrustArtifacts,
  generateTrust,
};
