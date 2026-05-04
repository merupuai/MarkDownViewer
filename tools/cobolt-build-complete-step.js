#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { auditMilestoneCheckpointIntegrity } = require('../lib/cobolt-checkpoint-drift');
const { projectExecutionLedger, syncBuildExecutionLedger } = require('../lib/cobolt-execution-ledger');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] || 'run',
    milestone: null,
    json: false,
    timeoutMs: 10 * 60 * 1000,
  };
  if (argv.includes('--help') || argv.includes('-h')) args.command = 'help';
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--milestone' || arg === '-m') args.milestone = normalizeMilestone(argv[++i]);
    else if (arg === '--json') args.json = true;
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i] || args.timeoutMs);
  }
  return args;
}

function normalizeMilestone(value) {
  const match = String(value || '')
    .trim()
    .match(/^M?(\d+)$/i);
  return match ? `M${Number.parseInt(match[1], 10)}` : null;
}

function writeFile(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode });
}

function writeJson(filePath, payload) {
  writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return fallback;
  }
}

function projectPath(projectRoot, ...parts) {
  return path.join(projectRoot, ...parts);
}

function buildDir(projectRoot, milestone) {
  return projectPath(projectRoot, '_cobolt-output', 'latest', 'build', milestone);
}

function reportsDir(projectRoot, milestone) {
  return projectPath(projectRoot, '_cobolt-output', 'reports', milestone);
}

function rel(projectRoot, filePath) {
  return path.relative(projectRoot, filePath).replace(/\\/g, '/');
}

function planningQualityPath(projectRoot, fileName) {
  return projectPath(projectRoot, '_cobolt-output', 'latest', 'planning', 'quality', fileName);
}

function generateSbomEvidence(projectRoot, milestone) {
  const { SBOMGenerator, writeOutput } = require('./cobolt-sbom');
  const generator = new SBOMGenerator(projectRoot);
  generator.scan();
  const bom = generator.toBOM();
  const jsonPath = path.join(buildDir(projectRoot, milestone), `${milestone}-sbom.cyclonedx.json`);
  const mdPath = path.join(buildDir(projectRoot, milestone), `${milestone}-sbom.md`);
  writeOutput(jsonPath, `${JSON.stringify(bom, null, 2)}\n`);
  writeOutput(mdPath, `${generator.toMarkdown()}\n`);

  const manifestCount = Array.isArray(bom?.metadata?.properties)
    ? bom.metadata.properties.filter((property) => property?.name === 'cobolt:manifest').length
    : 0;

  return {
    ok: manifestCount > 0 || (Array.isArray(bom.components) && bom.components.length > 0),
    reason:
      manifestCount > 0 || (Array.isArray(bom.components) && bom.components.length > 0)
        ? 'sbom-generated'
        : 'sbom-empty',
    jsonPath,
    mdPath,
    manifestCount,
    componentCount: Array.isArray(bom.components) ? bom.components.length : 0,
  };
}

function checkLaunchQualityGate(projectRoot) {
  const filePath = planningQualityPath(projectRoot, 'launch-quality-gate.json');
  const document = readJson(filePath, null);
  if (!document) {
    return { ok: false, reason: 'launch-quality-gate-missing', path: null, blockerCount: 0, failedArtifactChecks: [] };
  }
  const blockers = Array.isArray(document.blockers) ? document.blockers : [];
  const failedArtifactChecks = Array.isArray(document.artifactChecks)
    ? document.artifactChecks.filter((check) => check.status !== 'pass').map((check) => check.artifactId || check.path)
    : [];
  return {
    ok: document.status === 'pass' && blockers.length === 0 && failedArtifactChecks.length === 0,
    reason:
      document.status === 'pass' && blockers.length === 0 && failedArtifactChecks.length === 0
        ? 'launch-quality-gate-passed'
        : 'launch-quality-gate-failed',
    path: rel(projectRoot, filePath),
    blockerCount: blockers.length,
    failedArtifactChecks,
  };
}

function synthesizeRuntimeOperationsRunbook(projectRoot, milestone) {
  const filePath = planningQualityPath(projectRoot, 'runtime-operations-pack.json');
  const document = readJson(filePath, null);
  const outputPath = path.join(buildDir(projectRoot, milestone), `${milestone}-runtime-operations-runbook.md`);
  if (!document) {
    return { ok: false, reason: 'runtime-operations-pack-missing', path: null, outputPath: null, runbookCount: 0 };
  }

  const runbooks = Array.isArray(document.runbooks) ? document.runbooks : [];
  const lines = [
    `# ${milestone} Runtime Operations Runbook`,
    '',
    `Source: ${rel(projectRoot, filePath)}`,
    '',
    '## Runbooks',
    ...(runbooks.length > 0
      ? runbooks.flatMap((runbook) => [
          `### ${runbook.id || runbook.name || 'runbook'}`,
          `- Owner: ${runbook.owner || 'unassigned'}`,
          `- Required Inputs: ${(runbook.requiredInputs || []).join(', ') || 'none declared'}`,
          `- Minimum Sections: ${(runbook.minimumSections || []).join(', ') || 'none declared'}`,
          '',
        ])
      : ['- No runbooks were declared.', '']),
    '## Operational SLO Inputs',
    `- ${(document.operationalSloInputs || []).join(', ') || 'none declared'}`,
    '',
    '## Release Controls',
    `- ${(document.releaseControls || []).join(', ') || 'none declared'}`,
    '',
  ];
  writeFile(outputPath, lines.join('\n'));

  return {
    ok: runbooks.length > 0,
    reason: runbooks.length > 0 ? 'runtime-runbook-synthesized' : 'runtime-runbook-empty',
    path: rel(projectRoot, filePath),
    outputPath,
    runbookCount: runbooks.length,
  };
}

function summarizeProductQualityScorecard(projectRoot) {
  const filePath = planningQualityPath(projectRoot, 'product-quality-scorecard.json');
  const document = readJson(filePath, null);
  const categories = Array.isArray(document?.categories) ? document.categories : [];
  return {
    present: Boolean(document),
    path: document ? rel(projectRoot, filePath) : null,
    categoryCount: categories.length,
    failingCategories: categories
      .filter((category) => category.status && category.status !== 'pass')
      .map((category) => category.id),
  };
}

function summarizeDependencyHealth(projectRoot, milestone) {
  const filePath = path.join(buildDir(projectRoot, milestone), `${milestone}-dependency-health-gate.json`);
  const document = readJson(filePath, null);
  return {
    present: Boolean(document),
    path: rel(projectRoot, filePath),
    ok: document ? document.ok !== false && document.passed !== false : null,
    status: document?.status || document?.verdict || null,
    reason: document?.reason || null,
    blockerCount: Array.isArray(document?.blockers) ? document.blockers.length : Number(document?.blockerCount || 0),
  };
}

function defaultRunCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    timeout: options.timeoutMs || 10 * 60 * 1000,
    windowsHide: true,
    env: options.env || process.env,
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? String(result.error.message || result.error) : ''),
  };
}

function smokePassed(projectRoot, milestone) {
  const verdict = readJson(
    projectPath(projectRoot, '_cobolt-output', 'latest', 'cross-milestone', `${milestone}-smoke-verdict.json`),
    null,
  );
  if (!verdict) return false;
  const status = String(verdict.verdict || verdict.status || '').toLowerCase();
  return (
    verdict.ok !== false && verdict.pass !== false && (verdict.skipped === true || ['pass', 'passed'].includes(status))
  );
}

function collectDeferredWork(projectRoot, milestone) {
  const carryForward = readJson(path.join(buildDir(projectRoot, milestone), `${milestone}-carry-forward.json`), null);
  const tracker = readJson(projectPath(projectRoot, '_cobolt-output', 'latest', 'fix', 'finding-tracker.json'), null);
  const techDebt = readJson(path.join(buildDir(projectRoot, milestone), `${milestone}-tech-debt-backlog.json`), null);
  const deferredFindings = Array.isArray(tracker?.findings)
    ? tracker.findings.filter((finding) =>
        ['backlog', 'deferred', 'carry-forward'].includes(String(finding.status || '').toLowerCase()),
      )
    : [];
  const carryForwardFindings = Array.isArray(carryForward?.findings) ? carryForward.findings : [];
  const techDebtItems = Array.isArray(techDebt?.items)
    ? techDebt.items
    : Array.isArray(techDebt?.findings)
      ? techDebt.findings
      : [];

  return {
    milestone,
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-build-complete-step',
    status: 'complete',
    categories: {
      carryForward: carryForwardFindings,
      deferredFindings,
      techDebt: techDebtItems,
      blockedTasks: [],
    },
    totals: {
      carryForward: carryForwardFindings.length,
      deferredFindings: deferredFindings.length,
      techDebt: techDebtItems.length,
      blockedTasks: 0,
    },
    sourceFiles: {
      carryForward: carryForward ? `_cobolt-output/latest/build/${milestone}/${milestone}-carry-forward.json` : null,
      findingTracker: tracker ? '_cobolt-output/latest/fix/finding-tracker.json' : null,
      techDebt: techDebt ? `_cobolt-output/latest/build/${milestone}/${milestone}-tech-debt-backlog.json` : null,
    },
  };
}

function copyReportAlias(projectRoot, milestone, mdPath) {
  const target = path.join(reportsDir(projectRoot, milestone), `${milestone}-build-report.md`);
  if (!mdPath || !fs.existsSync(mdPath)) return { ok: false, reason: 'milestone-report-missing', target };
  const content = fs.readFileSync(mdPath, 'utf8');
  writeFile(target, content.endsWith('\n') ? content : `${content}\n`);
  const bytes = Buffer.byteLength(content, 'utf8');
  return {
    ok: bytes >= 3000,
    reason: bytes >= 3000 ? 'build-report-written' : 'build-report-undersized',
    target,
    bytes,
  };
}

function runGate(toolPath, args, projectRoot, timeoutMs, runCommand) {
  if (!fs.existsSync(toolPath)) return { ok: false, reason: 'tool-missing', toolPath };
  const result = runCommand(process.execPath, [toolPath, ...args], { cwd: projectRoot, timeoutMs });
  return {
    ok: result.status === 0,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    command: `node ${toolPath} ${args.join(' ')}`,
  };
}

async function run(args = parseArgs(), options = {}) {
  if (args.command !== 'run') {
    return {
      ok: args.command === 'help',
      usage: 'node tools/cobolt-build-complete-step.js run --milestone M1 [--json]',
    };
  }

  const projectRoot = options.projectRoot || process.cwd();
  const toolsDir = options.toolsDir || process.env.COBOLT_TOOLS_DIR || process.env.COBOLT_TOOLS || __dirname;
  const milestone = normalizeMilestone(args.milestone);
  if (!milestone) return { ok: false, reason: 'milestone-required' };

  const validationResults = readJson(
    path.join(buildDir(projectRoot, milestone), `${milestone}-validation-results.json`),
    null,
  );
  if (!validationResults || validationResults.overallStatus !== 'PASS') {
    return { ok: false, reason: 'validation-not-passed', milestone };
  }
  if (!smokePassed(projectRoot, milestone)) {
    return { ok: false, reason: 'cross-smoke-not-passed', milestone };
  }

  const checkpointIntegrity = auditMilestoneCheckpointIntegrity(projectRoot, milestone);
  if (!checkpointIntegrity.ok) {
    return { ok: false, reason: checkpointIntegrity.reason, milestone, checkpointIntegrity };
  }

  const runCommand = options.runCommand || defaultRunCommand;
  const gateResults = {};
  if (!options.skipGates) {
    gateResults.frCoverage = runGate(
      path.join(toolsDir, 'cobolt-fr-coverage.js'),
      ['check', '--milestone', milestone, '--threshold', '95', '--json'],
      projectRoot,
      args.timeoutMs,
      runCommand,
    );
    gateResults.rtmValidated = runGate(
      path.join(toolsDir, 'cobolt-rtm.js'),
      ['check', '--milestone', milestone, '--mode', 'validated', '--threshold', '95', '--json'],
      projectRoot,
      args.timeoutMs,
      runCommand,
    );
    // v0.47.4 Tier 1: shipping-source provenance census. Promoted from the
    // v0.42 Tier 2 skip-and-report posture because an absent provenance
    // ledger is a true milestone-grade defect — repair scripts can land
    // code in the shipping tree with no trail. Still invoked via runGate
    // so the JSON verdict remains attached to gateResults for reporting.
    gateResults.sourceWriteProvenance = runGate(
      path.join(toolsDir, 'cobolt-source-write-provenance.js'),
      ['check', '--root', projectRoot, '--milestone', milestone, '--json'],
      projectRoot,
      args.timeoutMs,
      runCommand,
    );
    const blockingGates = ['frCoverage', 'rtmValidated', 'sourceWriteProvenance'];
    const failedGate = Object.entries(gateResults).find(([name, result]) => blockingGates.includes(name) && !result.ok);
    if (failedGate) return { ok: false, reason: `${failedGate[0]}-failed`, milestone, gateResults };
  }

  const releaseEvidence = options.skipEvidenceArtifacts
    ? {
        sbom: { ok: true, reason: 'skipped-by-test' },
        launchQualityGate: { ok: true, reason: 'skipped-by-test' },
        runtimeRunbook: { ok: true, reason: 'skipped-by-test' },
        productQualityScorecard: { present: false, path: null, categoryCount: 0, failingCategories: [] },
        dependencyHealth: { present: false, path: null, ok: null, status: null, reason: 'skipped-by-test' },
      }
    : {
        sbom: generateSbomEvidence(projectRoot, milestone),
        launchQualityGate: checkLaunchQualityGate(projectRoot),
        runtimeRunbook: synthesizeRuntimeOperationsRunbook(projectRoot, milestone),
        productQualityScorecard: summarizeProductQualityScorecard(projectRoot),
        dependencyHealth: summarizeDependencyHealth(projectRoot, milestone),
      };

  if (!releaseEvidence.sbom.ok) {
    return { ok: false, reason: releaseEvidence.sbom.reason, milestone, gateResults, releaseEvidence };
  }
  if (!releaseEvidence.launchQualityGate.ok) {
    return { ok: false, reason: releaseEvidence.launchQualityGate.reason, milestone, gateResults, releaseEvidence };
  }
  if (!releaseEvidence.runtimeRunbook.ok) {
    return { ok: false, reason: releaseEvidence.runtimeRunbook.reason, milestone, gateResults, releaseEvidence };
  }

  const deferredWork = collectDeferredWork(projectRoot, milestone);
  const deferredPath = path.join(buildDir(projectRoot, milestone), `${milestone}-deferred-work.json`);
  writeJson(deferredPath, deferredWork);

  const milestoneReport =
    options.milestoneReport ||
    (() => {
      const modulePath = path.join(toolsDir, 'cobolt-milestone-report.js');
      delete require.cache[require.resolve(modulePath)];
      return require(modulePath);
    })();
  if (!milestoneReport?.generate) return { ok: false, reason: 'milestone-report-tool-missing', milestone };
  const report = await milestoneReport.generate(milestone);
  const alias = copyReportAlias(projectRoot, milestone, report?.mdPath);
  if (!alias.ok) return { ok: false, reason: alias.reason, milestone, report, alias, deferredPath };

  const checkpoint = {
    checkpoint: 'milestone-complete',
    milestone,
    completedAt: new Date().toISOString(),
    generatedBy: 'cobolt-build-complete-step',
    validation: `_cobolt-output/latest/build/${milestone}/${milestone}-validation-results.json`,
    crossMilestoneSmoke: `_cobolt-output/latest/cross-milestone/${milestone}-smoke-verdict.json`,
    deferredWork: `_cobolt-output/latest/build/${milestone}/${milestone}-deferred-work.json`,
    buildReport: `_cobolt-output/reports/${milestone}/${milestone}-build-report.md`,
    gateResults,
    checkpointIntegrity,
    releaseEvidence: {
      sbom:
        releaseEvidence.sbom.ok && releaseEvidence.sbom.jsonPath && releaseEvidence.sbom.mdPath
          ? {
              json: rel(projectRoot, releaseEvidence.sbom.jsonPath),
              markdown: rel(projectRoot, releaseEvidence.sbom.mdPath),
              componentCount: releaseEvidence.sbom.componentCount,
              manifestCount: releaseEvidence.sbom.manifestCount,
            }
          : releaseEvidence.sbom,
      launchQualityGate: releaseEvidence.launchQualityGate,
      runtimeRunbook:
        releaseEvidence.runtimeRunbook.ok && releaseEvidence.runtimeRunbook.outputPath
          ? {
              source: releaseEvidence.runtimeRunbook.path,
              output: rel(projectRoot, releaseEvidence.runtimeRunbook.outputPath),
              runbookCount: releaseEvidence.runtimeRunbook.runbookCount,
            }
          : releaseEvidence.runtimeRunbook,
      productQualityScorecard: releaseEvidence.productQualityScorecard,
      dependencyHealth: releaseEvidence.dependencyHealth,
    },
    overallStatus: 'PASS',
  };
  const checkpointDir = projectPath(projectRoot, '_cobolt-output', 'latest', 'build', 'checkpoints');
  writeJson(path.join(checkpointDir, `${milestone}-08-milestone-complete.json`), checkpoint);
  writeJson(path.join(checkpointDir, '08-milestone-complete.json'), checkpoint);
  syncBuildExecutionLedger(projectRoot, milestone, {
    deferredPath,
    completeCheckpointPath: path.join(checkpointDir, `${milestone}-08-milestone-complete.json`),
    checkpointPath: path.join(checkpointDir, `${milestone}-08-milestone-complete.json`),
    checkpointId: '08-milestone-complete',
  });
  projectExecutionLedger(projectRoot);

  return {
    ok: true,
    reason: 'milestone-complete',
    milestone,
    deferredPath,
    reportPath: alias.target,
    checkpointPath: path.join(checkpointDir, `${milestone}-08-milestone-complete.json`),
    gateResults,
    checkpointIntegrity,
    releaseEvidence,
  };
}

if (require.main === module) {
  const args = parseArgs();
  run(args)
    .then((result) => {
      if (args.json || result.usage) console.log(JSON.stringify(result, null, 2));
      else if (!result.ok) console.error(result.reason || 'milestone completion failed');
      process.exit(result.ok ? 0 : 1);
    })
    .catch((error) => {
      if (args.json) console.log(JSON.stringify({ ok: false, reason: error.message }, null, 2));
      else console.error(error.stack || error.message);
      process.exit(1);
    });
}

module.exports = {
  collectDeferredWork,
  auditMilestoneCheckpointIntegrity,
  normalizeMilestone,
  parseArgs,
  run,
  summarizeDependencyHealth,
};
