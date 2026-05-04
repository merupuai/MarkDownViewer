#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { atomicWrite, atomicWriteJSON } = require('../lib/cobolt-atomic-write');
const { buildAuditReport, writeAuditReport } = require('./cobolt-plan-output-audit');
const { getDetectors } = require('./cobolt-plan-review-detectors');
const {
  FINDING_SCHEMA_PATH,
  REPORT_SCHEMA_PATH,
  calculateFingerprints,
  dedupeFindings,
  ensurePlanningDir,
  loadArtifactDependencies,
  loadPlanPhaseArtifacts,
  loadState,
  loadTaxonomyConfig,
  newestPlanningArtifactMtime,
  planningFlagsFromState,
  readJson,
  toPosix,
  validateWithSchema,
} = require('./cobolt-plan-review-detectors/_shared');

function parseArgs(argv) {
  const options = {
    command: 'run',
    projectRoot: process.cwd(),
    json: false,
    refreshAudit: false,
    requireSemanticReviewers: false,
  };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;
    if (!arg.startsWith('-') && options.command === 'run') {
      options.command = arg;
      continue;
    }
    if (arg === '--project' || arg === '--cwd' || arg === '--target' || arg === '--dir') {
      options.projectRoot = args.shift() || options.projectRoot;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--refresh-audit') {
      options.refreshAudit = true;
    } else if (arg === '--require-semantic' || arg === '--require-semantic-reviewers') {
      options.requireSemanticReviewers = true;
    } else if (arg === '--help' || arg === '-h') {
      options.command = 'help';
    }
  }
  return options;
}

function standardPaths(projectRoot, planningDir) {
  return {
    planningDir,
    auditDir: path.join(projectRoot, '_cobolt-output', 'audit', 'plan-review'),
    semanticDir: path.join(projectRoot, '_cobolt-output', 'audit', 'plan-review', 'semantic'),
    reportPath: path.join(projectRoot, '_cobolt-output', 'audit', 'plan-review', 'plan-review-report.json'),
    reportMarkdownPath: path.join(projectRoot, '_cobolt-output', 'audit', 'plan-review', 'plan-review-report.md'),
    verdictPath: path.join(planningDir, 'plan-review-verdict.json'),
    auditReportPath: path.join(projectRoot, '_cobolt-output', 'audit', 'plan-output-audit', 'audit-report.json'),
  };
}

function loadExistingAuditReport(paths, planningDir) {
  const report = readJson(paths.auditReportPath);
  if (!report?.generatedAt || !Array.isArray(report.results)) return null;
  try {
    const reportStat = fs.statSync(paths.auditReportPath);
    const newestPlanningMtime = newestPlanningArtifactMtime(planningDir, {
      excludeRelativePaths: ['plan-review-verdict.json'],
    });
    if (reportStat.mtimeMs < newestPlanningMtime) return null;
  } catch {
    return null;
  }
  return report;
}

function ensureAuditReport(projectRoot, paths, options = {}) {
  if (!options.refreshAudit) {
    const existing = loadExistingAuditReport(paths, paths.planningDir);
    if (existing) return existing;
  }
  const report = buildAuditReport({ target: projectRoot });
  writeAuditReport(report, path.dirname(paths.auditReportPath));
  return report;
}

function loadPreviousPlanReviewReport(paths) {
  return readJson(paths.reportPath);
}

function validateFindings(findings) {
  const errors = [];
  for (const finding of findings) {
    const result = validateWithSchema(FINDING_SCHEMA_PATH, finding);
    if (!result.ok) errors.push(...result.errors.map((error) => `${finding.classId}:${error}`));
  }
  return errors;
}

function determineVerdict(findings) {
  const blockers = findings.filter((finding) => finding.severity === 'critical');
  const advisories = findings.filter((finding) => finding.severity !== 'critical');
  const status = blockers.length > 0 ? 'critical' : findings.length > 0 ? 'advisory' : 'clean';
  return {
    status,
    updatedAt: new Date().toISOString(),
    blockers,
    advisories,
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Plan Review Report');
  lines.push('');
  lines.push(`- Target: \`${report.target}\``);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Taxonomy: \`${report.taxonomyVersion}\``);
  lines.push(`- Verdict: **${report.verdict.status}**`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('| --- | ---: |');
  for (const [key, value] of Object.entries(report.summary || {})) {
    if (typeof value === 'object') continue;
    lines.push(`| ${key} | ${value} |`);
  }
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  if (!report.findings.length) {
    lines.push('_No findings._');
  } else {
    for (const finding of report.findings) {
      lines.push(
        `- **${finding.classId}** (${finding.severity}) \`${finding.artifact}\` via \`${finding.detectorId}\`: ${
          typeof finding.evidence === 'string' ? finding.evidence : JSON.stringify(finding.evidence)
        }`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

function writeOutputs(paths, report) {
  fs.mkdirSync(paths.auditDir, { recursive: true });
  fs.mkdirSync(paths.semanticDir, { recursive: true });
  atomicWriteJSON(paths.reportPath, report, { indent: 2 });
  atomicWrite(paths.reportMarkdownPath, renderMarkdown(report), { encoding: 'utf8', mode: 0o600 });
  atomicWriteJSON(paths.verdictPath, report.verdict, { indent: 2 });
}

function generatePlanReviewReport(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const planningDir = ensurePlanningDir(projectRoot);
  const paths = standardPaths(projectRoot, planningDir);
  const taxonomy = loadTaxonomyConfig();
  const state = loadState(projectRoot);
  const auditReport = ensureAuditReport(projectRoot, { ...paths, planningDir }, options);
  const previousReport = loadPreviousPlanReviewReport(paths);
  const currentFingerprints = calculateFingerprints(projectRoot, planningDir);
  const activeDetectorIds = [...new Set((taxonomy.classes || []).flatMap((entry) => entry.detectors || []))];
  const context = {
    projectRoot,
    planningDir,
    paths,
    taxonomy,
    state,
    flags: planningFlagsFromState(state),
    phaseArtifacts: loadPlanPhaseArtifacts(),
    artifactDependencies: loadArtifactDependencies(),
    auditReport,
    previousReport,
    currentFingerprints,
    requireSemanticReviewers: options.requireSemanticReviewers === true,
  };

  const detectorResults = getDetectors(activeDetectorIds).map((detector) => detector.run(context));
  const findings = dedupeFindings(detectorResults.flatMap((result) => result.findings || []));
  const validationErrors = validateFindings(findings);
  if (validationErrors.length > 0) {
    throw new Error(`Invalid detector output: ${validationErrors.join('; ')}`);
  }

  const classesWithFindings = {};
  for (const finding of findings) {
    classesWithFindings[finding.classId] = (classesWithFindings[finding.classId] || 0) + 1;
  }

  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    target: projectRoot,
    taxonomyVersion: taxonomy.taxonomyVersion,
    summary: {
      configuredClasses: taxonomy.classes.length,
      findingCount: findings.length,
      criticalCount: findings.filter((finding) => finding.severity === 'critical').length,
      advisoryCount: findings.filter((finding) => finding.severity === 'advisory').length,
      cleanClassCount: taxonomy.classes.length - Object.keys(classesWithFindings).length,
      classesWithFindings,
    },
    sources: {
      auditReportPath: toPosix(path.relative(projectRoot, paths.auditReportPath)),
      semanticDir: toPosix(path.relative(projectRoot, paths.semanticDir)),
      detectorIds: activeDetectorIds,
      planningFingerprint: currentFingerprints.planningFingerprint,
      inputFingerprint: currentFingerprints.inputFingerprint,
      previousReportPath: previousReport ? toPosix(path.relative(projectRoot, paths.reportPath)) : null,
    },
    findings,
    verdict: determineVerdict(findings),
  };

  const validation = validateWithSchema(REPORT_SCHEMA_PATH, report, [FINDING_SCHEMA_PATH]);
  if (!validation.ok) {
    throw new Error(`Invalid plan-review report: ${validation.errors.join('; ')}`);
  }

  writeOutputs(paths, report);
  return {
    projectRoot,
    planningDir,
    paths,
    report,
    detectorResults,
  };
}

function checkExistingPlanReview(projectRoot) {
  const planningDir = ensurePlanningDir(projectRoot);
  const paths = standardPaths(projectRoot, planningDir);
  const report = readJson(paths.reportPath);
  const verdict = readJson(paths.verdictPath);
  if (!report || !verdict) {
    return {
      passed: false,
      report: null,
      verdict: verdict || {
        status: 'critical',
        updatedAt: new Date().toISOString(),
        blockers: [],
        advisories: [],
      },
      message: 'plan-review report or verdict is missing',
    };
  }
  return {
    passed: verdict.status !== 'critical',
    report,
    verdict,
    message: verdict.status === 'critical' ? 'plan-review verdict is critical' : null,
  };
}

// Exit-code contract (per tools/CLAUDE.md):
//   0 = success — verdict is clean OR advisory (advisory findings are still a
//       successful run; the verdict body carries the data)
//   1 = hard error — verdict critical, or unhandled exception
function exitCodeForStatus(status) {
  if (status === 'critical') return 1;
  return 0;
}

function printHelp() {
  console.log(
    'Usage: node tools/cobolt-plan-review.js [run|check] [--project <dir>] [--json] [--refresh-audit] [--require-semantic]',
  );
  console.log('Exit codes: 0 clean or advisory, 1 critical or hard error');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') {
    printHelp();
    return 0;
  }

  try {
    if (options.command === 'check') {
      const result = checkExistingPlanReview(path.resolve(options.projectRoot));
      if (options.json) process.stdout.write(JSON.stringify(result.report || result.verdict, null, 2));
      else console.log(result.message || `plan-review status: ${result.verdict.status}`);
      return exitCodeForStatus(result.verdict.status);
    }

    const result = generatePlanReviewReport(options);
    if (options.json) process.stdout.write(JSON.stringify(result.report, null, 2));
    else console.log(`plan-review verdict: ${result.report.verdict.status}`);
    return exitCodeForStatus(result.report.verdict.status);
  } catch (err) {
    const message = String(err.message || err);
    if (options.json) {
      process.stdout.write(
        JSON.stringify(
          {
            version: 1,
            generatedAt: new Date().toISOString(),
            target: path.resolve(options.projectRoot),
            taxonomyVersion: '1.0.0',
            summary: {
              configuredClasses: 0,
              findingCount: 0,
              criticalCount: 0,
              advisoryCount: 0,
              cleanClassCount: 0,
              classesWithFindings: {},
            },
            findings: [],
            verdict: {
              status: 'critical',
              updatedAt: new Date().toISOString(),
              blockers: [],
              advisories: [],
            },
            error: message,
          },
          null,
          2,
        ),
      );
      return 1;
    }
    console.error(message);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  parseArgs,
  determineVerdict,
  renderMarkdown,
  generatePlanReviewReport,
  checkExistingPlanReview,
  main,
};
