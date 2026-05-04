#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { projectExecutionLedger, syncBuildExecutionLedger } = require('../lib/cobolt-execution-ledger');
const { checkFreshness, writeReport: writeArtifactFreshnessReport } = require('./cobolt-artifact-freshness');
const { checkBuildPacketFreshness } = require('./cobolt-build-packet-freshness');
const { runCheck: runConfigHygieneCheck } = require('./cobolt-build-config-hygiene-check');
const { runCheck: runIrCoverageGateCheck } = require('./cobolt-build-ir-coverage-gate');
const { runCheck: runUiStateCheck } = require('./cobolt-build-ui-state-check');
const { checkFixedPathCoverage } = require('./cobolt-fixed-path-coverage');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] || 'run',
    milestone: null,
    json: false,
    timeoutMs: 20 * 60 * 1000,
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

function projectPath(projectRoot, ...parts) {
  return path.join(projectRoot, ...parts);
}

function buildDir(projectRoot, milestone) {
  return projectPath(projectRoot, '_cobolt-output', 'latest', 'build', milestone);
}

function latestBuildPath(projectRoot, milestone, fileName) {
  return path.join(buildDir(projectRoot, milestone), fileName);
}

function defaultRunCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    timeout: options.timeoutMs || 20 * 60 * 1000,
    windowsHide: true,
    env: options.env || process.env,
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? String(result.error.message || result.error) : ''),
    signal: result.signal || null,
  };
}

function isNodeSpawnBlocked(result) {
  return /spawnSync .*node(?:\.exe)? EPERM/i.test(`${result?.stdout || ''}\n${result?.stderr || ''}`);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function loadValidateModule(validateModulePath) {
  delete require.cache[require.resolve(validateModulePath)];
  return require(validateModulePath);
}

function isNativeDesktopValidation(validationResults) {
  const l4b = validationResults?.layers?.L4b_ui_integrity || {};
  const frameworks = Array.isArray(l4b.frameworks) ? l4b.frameworks.map((value) => String(value).toLowerCase()) : [];
  return (
    /native desktop/i.test(String(l4b.detail || '')) ||
    frameworks.some((framework) => /\b(?:wpf|winui|maui|avalonia|windows forms|winforms)\b/i.test(framework))
  );
}

function layerPassed(validationResults, ...layerNames) {
  return layerNames.every((name) => {
    const status = String(validationResults?.layers?.[name]?.status || '').toLowerCase();
    return status === 'passed' || status === 'warning';
  });
}

function buildPhaseBRecord(milestone, validationResults, extraGates = {}) {
  const generatedAt = new Date().toISOString();
  const nativeDesktop = isNativeDesktopValidation(validationResults);
  const uiStatus = nativeDesktop ? 'not_applicable_native_desktop' : 'passed-in-phase-a';
  const browserEngineStatus = nativeDesktop ? 'not_applicable_native_desktop' : 'not_run_deterministic_validation_only';

  return {
    milestone,
    startedAt: generatedAt,
    completedAt: generatedAt,
    generatedBy: 'cobolt-build-validate-step',
    phaseA: validationResults?.overallStatus === 'PASS' ? 'PASSED' : 'FAILED',
    layers: {
      L1_compile_tests: {
        status: layerPassed(validationResults, 'L1_compile_tests') ? 'passed-in-phase-a' : 'failed-in-phase-a',
      },
      L2_prd_audit: {
        status: layerPassed(validationResults, 'L2_stub_detection', 'L2b_illusion_detection', 'L2c_security_invariants')
          ? 'passed-in-phase-a'
          : 'failed-in-phase-a',
      },
      L3_rtm_coverage: {
        status: layerPassed(validationResults, 'L4_rtm_integrity', 'L3_fr_coverage')
          ? 'passed-in-phase-a'
          : 'failed-in-phase-a',
      },
      L4_playwright_ui: {
        status: uiStatus,
        engines: {
          playwright: browserEngineStatus,
          chrome_devtools: browserEngineStatus,
        },
        reason: nativeDesktop
          ? 'Native desktop UI detected; web Playwright and Chrome DevTools browser checks are not applicable to this milestone.'
          : 'Deterministic UI integrity passed in Phase A; browser-specific execution is not required by this wrapper contract.',
      },
      L5_prd_to_reality: {
        status: layerPassed(
          validationResults,
          'L5_route_health',
          'L5b_event_pairing',
          'L5c_framework_bootstrap',
          'L7_fr_distribution',
          'L7b_story_density',
        )
          ? 'passed-in-phase-a'
          : 'failed-in-phase-a',
      },
    },
    extraGates,
    overallStatus: validationResults?.overallStatus === 'PASS' && extraGates.ok !== false ? 'PASS' : 'FAIL',
  };
}

function runSchemaGate(projectRoot, milestone, toolsDir, timeoutMs, runCommand = defaultRunCommand) {
  const toolPath = path.join(toolsDir, 'cobolt-schema-check.js');
  const artifact = latestBuildPath(projectRoot, milestone, `${milestone}-build-artifacts.json`);
  const reportPath = latestBuildPath(projectRoot, milestone, `${milestone}-schema-check-report.json`);
  if (!fs.existsSync(toolPath)) return { ok: false, reason: 'schema-tool-missing', toolPath };
  if (!fs.existsSync(artifact)) return { ok: false, reason: 'build-artifacts-missing', artifact };

  const result = runCommand(
    process.execPath,
    [toolPath, '--schema', 'build-artifacts.schema.json', '--artifact', artifact, '--milestone', milestone],
    { cwd: projectRoot, timeoutMs },
  );
  if (result.status !== 0 && isNodeSpawnBlocked(result)) {
    const cached = readJsonFile(reportPath);
    if (cached) {
      return {
        ok: cached.valid === true,
        reason: cached.valid === true ? 'schema-valid-cached' : 'schema-invalid-cached',
        command: `node ${toolPath} --schema build-artifacts.schema.json --artifact ${artifact} --milestone ${milestone}`,
        exitCode: cached.valid === true ? 0 : 1,
        stdout: JSON.stringify(cached, null, 2),
        stderr: result.stderr,
        reportPath,
      };
    }
  }
  return {
    ok: result.status === 0,
    reason: result.status === 0 ? 'schema-valid' : 'schema-invalid',
    command: `node ${toolPath} --schema build-artifacts.schema.json --artifact ${artifact} --milestone ${milestone}`,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    reportPath,
  };
}

function runCapabilityGate(projectRoot, milestone, toolsDir, timeoutMs, runCommand = defaultRunCommand) {
  const toolPath = path.join(toolsDir, 'cobolt-capability-graph.js');
  if (!fs.existsSync(toolPath)) return { ok: false, reason: 'capability-tool-missing', toolPath };

  const result = runCommand(
    process.execPath,
    [toolPath, 'check', '--stage', 'build', '--milestone', milestone, '--json'],
    { cwd: projectRoot, timeoutMs },
  );
  const reportPath = latestBuildPath(projectRoot, milestone, `${milestone}-capability-edge-proof-report.json`);
  if (result.status !== 0 && isNodeSpawnBlocked(result)) {
    const cached = readJsonFile(reportPath);
    if (cached) {
      return {
        ok: cached.passed !== false,
        reason: cached.passed !== false ? 'capability-proof-valid-cached' : 'capability-proof-invalid-cached',
        command: `node ${toolPath} check --stage build --milestone ${milestone} --json`,
        exitCode: cached.passed !== false ? 0 : 1,
        stdout: JSON.stringify(cached, null, 2),
        stderr: result.stderr,
        reportPath,
      };
    }
  }
  const parsed = readJsonFromText(result.stdout);
  if (parsed) writeJson(reportPath, parsed);
  else if (result.stdout.trim())
    writeFile(reportPath, result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);

  return {
    ok: result.status === 0 && (parsed ? parsed.passed !== false : true),
    reason: result.status === 0 ? 'capability-proof-valid' : 'capability-proof-invalid',
    command: `node ${toolPath} check --stage build --milestone ${milestone} --json`,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    reportPath,
  };
}

function runCapabilityContractGate(projectRoot, milestone, toolsDir, timeoutMs, runCommand = defaultRunCommand) {
  const toolPath = path.join(toolsDir, 'cobolt-capability-contract.js');
  if (!fs.existsSync(toolPath)) return { ok: false, reason: 'capability-contract-tool-missing', toolPath };

  const result = runCommand(process.execPath, [toolPath, 'check', '--stage', 'final', '--json'], {
    cwd: projectRoot,
    timeoutMs,
  });
  const reportPath = latestBuildPath(projectRoot, milestone, `${milestone}-capability-contract-gate.json`);
  if (result.status !== 0 && isNodeSpawnBlocked(result)) {
    const cached = readJsonFile(reportPath);
    if (cached) {
      return {
        ok: cached.ok !== false,
        reason: cached.ok !== false ? 'capability-contracts-valid-cached' : 'capability-contracts-invalid-cached',
        command: `node ${toolPath} check --stage final --json`,
        exitCode: cached.ok !== false ? 0 : 1,
        stdout: JSON.stringify(cached, null, 2),
        stderr: result.stderr,
        reportPath,
      };
    }
  }
  const parsed = readJsonFromText(result.stdout);
  if (parsed) writeJson(reportPath, parsed);
  else if (result.stdout.trim())
    writeFile(reportPath, result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);

  return {
    ok: result.status === 0 && (parsed ? parsed.ok !== false : true),
    reason: result.status === 0 ? 'capability-contracts-valid' : 'capability-contracts-invalid',
    command: `node ${toolPath} check --stage final --json`,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    reportPath,
  };
}

function runAdrResolutionGate(projectRoot, milestone, toolsDir, timeoutMs, runCommand = defaultRunCommand) {
  const toolPath = path.join(toolsDir, 'cobolt-adr-resolution.js');
  if (!fs.existsSync(toolPath)) return { ok: false, reason: 'adr-resolution-tool-missing', toolPath };

  const result = runCommand(process.execPath, [toolPath, 'check', '--json'], { cwd: projectRoot, timeoutMs });
  const reportPath = latestBuildPath(projectRoot, milestone, `${milestone}-adr-resolution.json`);
  if (result.status !== 0 && isNodeSpawnBlocked(result)) {
    const cached = readJsonFile(reportPath);
    if (cached) {
      return {
        ok: Number(cached.exitCode || 0) === 0,
        reason: Number(cached.exitCode || 0) === 0 ? 'adr-resolved-cached' : 'adr-resolution-failed-cached',
        command: `node ${toolPath} check --json`,
        exitCode: Number(cached.exitCode || 1),
        stdout: JSON.stringify(cached, null, 2),
        stderr: result.stderr,
        reportPath,
        violations: cached.violations || [],
      };
    }
  }
  const parsed = readJsonFromText(result.stdout);
  if (parsed) writeJson(reportPath, parsed);
  else if (result.stdout.trim())
    writeFile(reportPath, result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);

  return {
    ok: result.status === 0 && Number(parsed?.exitCode || 0) === 0,
    reason: result.status === 0 ? 'adr-resolved' : 'adr-resolution-failed',
    command: `node ${toolPath} check --json`,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    reportPath,
    violations: parsed?.violations || [],
  };
}

function runStackConformanceGate(projectRoot, milestone, toolsDir, timeoutMs, runCommand = defaultRunCommand) {
  const toolPath = path.join(toolsDir, 'cobolt-stack-conformance.js');
  if (!fs.existsSync(toolPath)) return { ok: false, reason: 'stack-conformance-tool-missing', toolPath };

  const result = runCommand(
    process.execPath,
    [toolPath, 'check', '--root', projectRoot, '--milestone', milestone, '--json'],
    { cwd: projectRoot, timeoutMs },
  );
  const reportPath = latestBuildPath(projectRoot, milestone, `${milestone}-stack-conformance.json`);
  if (result.status !== 0 && isNodeSpawnBlocked(result)) {
    const cached = readJsonFile(reportPath);
    if (cached) {
      return {
        ok: cached.passed !== false,
        reason: cached.passed !== false ? 'stack-conformant-cached' : 'stack-conformance-failed-cached',
        command: `node ${toolPath} check --root ${projectRoot} --milestone ${milestone} --json`,
        exitCode: cached.passed !== false ? 0 : 1,
        stdout: JSON.stringify(cached, null, 2),
        stderr: result.stderr,
        reportPath,
        issues: cached.issues || [],
      };
    }
  }
  const parsed = readJsonFromText(result.stdout);
  return {
    ok: result.status === 0 && (parsed ? parsed.passed !== false : true),
    reason: result.status === 0 ? 'stack-conformant' : 'stack-conformance-failed',
    command: `node ${toolPath} check --root ${projectRoot} --milestone ${milestone} --json`,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    reportPath,
    issues: parsed?.issues || [],
  };
}

function runContractReachabilityGate(projectRoot, milestone, toolsDir, timeoutMs, runCommand = defaultRunCommand) {
  const toolPath = path.join(toolsDir, 'cobolt-contract-reachability.js');
  if (!fs.existsSync(toolPath)) return { ok: false, reason: 'contract-reachability-tool-missing', toolPath };

  const result = runCommand(
    process.execPath,
    [toolPath, 'check', '--root', projectRoot, '--milestone', milestone, '--json'],
    { cwd: projectRoot, timeoutMs },
  );
  const reportPath = latestBuildPath(projectRoot, milestone, `${milestone}-contract-reachability.json`);
  if (result.status !== 0 && isNodeSpawnBlocked(result)) {
    const cached = readJsonFile(reportPath);
    if (cached) {
      return {
        ok: cached.passed !== false,
        reason: cached.passed !== false ? 'all-surfaces-reached-cached' : 'reachability-failed-cached',
        command: `node ${toolPath} check --root ${projectRoot} --milestone ${milestone} --json`,
        exitCode: cached.passed !== false ? 0 : 1,
        stdout: JSON.stringify(cached, null, 2),
        stderr: result.stderr,
        reportPath,
        errors: cached.errors || [],
        unreachedCount: Array.isArray(cached.verdicts) ? cached.verdicts.filter((v) => !v.reached).length : undefined,
      };
    }
  }
  const parsed = readJsonFromText(result.stdout);
  return {
    ok: result.status === 0 && (parsed ? parsed.passed !== false : true),
    reason: result.status === 0 ? 'all-surfaces-reached' : 'reachability-failed',
    command: `node ${toolPath} check --root ${projectRoot} --milestone ${milestone} --json`,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    reportPath,
    errors: parsed?.errors || [],
    unreachedCount: Array.isArray(parsed?.verdicts) ? parsed.verdicts.filter((v) => !v.reached).length : undefined,
  };
}

function runHarnessOnlyGate(projectRoot, milestone, toolsDir, timeoutMs, runCommand = defaultRunCommand) {
  const toolPath = path.join(toolsDir, 'cobolt-harness-only-detector.js');
  if (!fs.existsSync(toolPath)) return { ok: false, reason: 'harness-only-tool-missing', toolPath };

  const result = runCommand(
    process.execPath,
    [toolPath, 'check', '--root', projectRoot, '--milestone', milestone, '--json'],
    { cwd: projectRoot, timeoutMs },
  );
  const reportPath = latestBuildPath(projectRoot, milestone, `${milestone}-harness-only-report.json`);
  if (result.status !== 0 && isNodeSpawnBlocked(result)) {
    const cached = readJsonFile(reportPath);
    if (cached) {
      return {
        ok: cached.passed !== false,
        reason: cached.passed !== false ? 'no-harness-only-cached' : 'harness-only-findings-cached',
        command: `node ${toolPath} check --root ${projectRoot} --milestone ${milestone} --json`,
        exitCode: cached.passed !== false ? 0 : 1,
        stdout: JSON.stringify(cached, null, 2),
        stderr: result.stderr,
        reportPath,
        errors: cached.errors || [],
      };
    }
  }
  const parsed = readJsonFromText(result.stdout);
  return {
    ok: result.status === 0 && (parsed ? parsed.passed !== false : true),
    reason: result.status === 0 ? 'no-harness-only' : 'harness-only-findings',
    command: `node ${toolPath} check --root ${projectRoot} --milestone ${milestone} --json`,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    reportPath,
    errors: parsed?.errors || [],
  };
}

function runFixedPathCoverageGate(projectRoot, milestone) {
  const report = checkFixedPathCoverage(projectRoot, { milestone });
  const reportPath = latestBuildPath(projectRoot, milestone, `${milestone}-fixed-path-coverage.json`);
  writeJson(reportPath, report);
  return {
    ok: report.passed !== false,
    reason:
      report.status === 'pass'
        ? 'fixed-path-covered'
        : report.status === 'not_applicable'
          ? 'fixed-path-not-applicable'
          : 'fixed-path-uncovered',
    reportPath,
    status: report.status,
    uncoveredFiles: report.uncoveredFiles || [],
    coverageArtifacts: report.coverageArtifacts || [],
  };
}

function runArtifactFreshnessGate(projectRoot, milestone) {
  const report = checkFreshness(projectRoot, { enforce: true, currentMilestone: milestone });
  const reportPath = latestBuildPath(projectRoot, milestone, `${milestone}-artifact-freshness.json`);
  writeJson(reportPath, report);
  writeArtifactFreshnessReport(projectRoot, report);
  return {
    ok: Number(report?.verdict?.blockers || 0) === 0,
    reason: Number(report?.verdict?.blockers || 0) === 0 ? 'artifacts-fresh' : 'artifact-freshness-blocked',
    reportPath,
    status: report?.verdict?.status || 'unknown',
    blockers: report?.verdict?.blockers || 0,
    wouldBlock: report?.verdict?.wouldBlock || 0,
  };
}

function runBuildPacketFreshnessGate(projectRoot, milestone) {
  const report = checkBuildPacketFreshness(projectRoot, { milestone });
  const reportPath = latestBuildPath(projectRoot, milestone, `${milestone}-build-packet-freshness.json`);
  writeJson(reportPath, report);
  return {
    ok: report.passed !== false,
    reason: report.passed !== false ? 'build-packet-fresh' : 'build-packet-stale',
    reportPath,
    status: report.status,
    changedSources: report.changedSources || [],
    removedSources: report.removedSources || [],
    addedSources: report.addedSources || [],
    manifestIssues: report.manifestIssues || [],
  };
}

// v0.47.4 Tier 1: Consume Plan-authored quality artifacts at Build Step 07.
// The Plan pipeline emits _cobolt-output/latest/planning/quality/* via
// cobolt-plan-quality-artifacts.js and gates plan-close on them
// (source/hooks/cobolt-plan-complete-gate.js). Those artifacts were
// advisory-in-practice because no Build-side consumer read them. This gate
// closes that seam: Build validation fails closed when the scorecard is missing
// or failing, and when the UX state matrix is missing/failing on a UI-scoped
// milestone. If the matrix declares uiScope:false we treat it as a legitimate
// green path.
function planningQualityPath(projectRoot, fileName) {
  return projectPath(projectRoot, '_cobolt-output', 'latest', 'planning', 'quality', fileName);
}

function readQualityDocument(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/u, ''));
  } catch {
    return null;
  }
}

function summarizeDependencyHealth(projectRoot, milestone) {
  const filePath = latestBuildPath(projectRoot, milestone, `${milestone}-dependency-health-gate.json`);
  const document = readQualityDocument(filePath);
  return {
    present: Boolean(document),
    path: path.relative(projectRoot, filePath).replace(/\\/g, '/'),
    ok: document ? document.ok !== false && document.passed !== false : null,
    status: document?.status || document?.verdict || null,
    reason: document?.reason || null,
    blockerCount: Array.isArray(document?.blockers) ? document.blockers.length : Number(document?.blockerCount || 0),
  };
}

function runPlanQualityArtifactGate(projectRoot, milestone) {
  const scorecardPath = planningQualityPath(projectRoot, 'product-quality-scorecard.json');
  const uxMatrixPath = planningQualityPath(projectRoot, 'ux-state-matrix.json');
  const reportPath = latestBuildPath(projectRoot, milestone, `${milestone}-plan-quality-consumer.json`);
  const relativeScorecard = path.relative(projectRoot, scorecardPath).replace(/\\/g, '/');
  const relativeUx = path.relative(projectRoot, uxMatrixPath).replace(/\\/g, '/');
  const dependencyHealth = summarizeDependencyHealth(projectRoot, milestone);

  const scorecard = readQualityDocument(scorecardPath);
  const uxMatrix = readQualityDocument(uxMatrixPath);

  if (!scorecard) {
    const report = {
      ok: false,
      reason: 'plan-quality-artifact-product-quality-scorecard-missing',
      milestone,
      scorecardPath: relativeScorecard,
      uxMatrixPath: relativeUx,
      dependencyHealth,
      generatedAt: new Date().toISOString(),
    };
    writeJson(reportPath, report);
    return { ...report, reportPath };
  }
  if (scorecard.status !== 'pass') {
    const report = {
      ok: false,
      reason: 'plan-quality-artifact-product-quality-scorecard-failed',
      milestone,
      scorecardStatus: scorecard.status || 'unknown',
      scorecardBlockers: Array.isArray(scorecard.blockers) ? scorecard.blockers : [],
      scorecardScore: typeof scorecard.score === 'number' ? scorecard.score : null,
      scorecardPath: relativeScorecard,
      uxMatrixPath: relativeUx,
      dependencyHealth,
      generatedAt: new Date().toISOString(),
    };
    writeJson(reportPath, report);
    return { ...report, reportPath };
  }

  if (!uxMatrix) {
    const report = {
      ok: false,
      reason: 'plan-quality-artifact-ux-state-matrix-missing',
      milestone,
      scorecardStatus: scorecard.status,
      scorecardPath: relativeScorecard,
      uxMatrixPath: relativeUx,
      dependencyHealth,
      generatedAt: new Date().toISOString(),
    };
    writeJson(reportPath, report);
    return { ...report, reportPath };
  }
  if (uxMatrix.uiScope === false) {
    const report = {
      ok: true,
      reason: 'ux-state-matrix-no-ui-scope',
      milestone,
      scorecardStatus: scorecard.status,
      uxMatrixUiScope: false,
      scorecardPath: relativeScorecard,
      uxMatrixPath: relativeUx,
      dependencyHealth,
      generatedAt: new Date().toISOString(),
    };
    writeJson(reportPath, report);
    return { ...report, reportPath };
  }
  if (uxMatrix.status !== 'pass') {
    const report = {
      ok: false,
      reason: 'plan-quality-artifact-ux-state-matrix-failed',
      milestone,
      uxMatrixStatus: uxMatrix.status || 'unknown',
      uxMatrixBlockers: Array.isArray(uxMatrix.blockers) ? uxMatrix.blockers : [],
      scorecardPath: relativeScorecard,
      uxMatrixPath: relativeUx,
      dependencyHealth,
      generatedAt: new Date().toISOString(),
    };
    writeJson(reportPath, report);
    return { ...report, reportPath };
  }

  const report = {
    ok: true,
    reason: 'plan-quality-artifacts-consumed',
    milestone,
    scorecardStatus: scorecard.status,
    scorecardScore: typeof scorecard.score === 'number' ? scorecard.score : null,
    uxMatrixStatus: uxMatrix.status,
    uxMatrixUiScope: uxMatrix.uiScope !== false,
    scorecardPath: relativeScorecard,
    uxMatrixPath: relativeUx,
    dependencyHealth,
    generatedAt: new Date().toISOString(),
  };
  writeJson(reportPath, report);
  return { ...report, reportPath };
}

function runUiStateGate(projectRoot, milestone) {
  const report = runUiStateCheck(projectRoot, milestone);
  return {
    ok: report.ok === true,
    reason: report.reason,
    reportPath: report.artifactPath,
    skipped: report.skipped === true,
    uiRequired: report.uiRequired === true,
    planningIssues: report.planningVerdict?.issues || [],
  };
}

function runConfigHygieneGate(projectRoot, milestone) {
  const report = runConfigHygieneCheck(projectRoot, milestone);
  return {
    ok: report.ok === true,
    reason: report.reason,
    reportPath: report.artifactPath,
    requiresConfig: report.requiresConfig === true,
    issues: report.issues || [],
  };
}

function runIrCoverageGate(projectRoot, milestone) {
  const report = runIrCoverageGateCheck(projectRoot, milestone);
  return {
    ok: report.ok === true,
    reason: report.reason,
    reportPath: report.artifactPath,
    skipped: report.skipped === true,
    packsMatched: report.packsMatched || [],
    missing: report.missing || [],
  };
}

function runRtmPromotion(projectRoot, milestone, toolsDir, timeoutMs, runCommand = defaultRunCommand) {
  const toolPath = path.join(toolsDir, 'cobolt-rtm.js');
  if (!fs.existsSync(toolPath)) return { ok: false, reason: 'rtm-tool-missing', toolPath };

  const result = runCommand(
    process.execPath,
    [toolPath, 'update', '--milestone', milestone, '--set-status', 'covered'],
    { cwd: projectRoot, timeoutMs },
  );
  if (result.status !== 0 && isNodeSpawnBlocked(result)) {
    const rtmPath = projectPath(projectRoot, '_cobolt-output', 'latest', 'planning', 'rtm.json');
    const cached = readJsonFile(rtmPath);
    const requirements = Object.values(cached?.requirements || {}).filter((req) =>
      Array.isArray(req?.milestones) ? req.milestones.includes(milestone) : req?.milestone === milestone,
    );
    const allCovered = requirements.length > 0 && requirements.every((req) => req?.status === 'covered');
    if (allCovered) {
      return {
        ok: true,
        reason: 'rtm-promoted-cached',
        command: `node ${toolPath} update --milestone ${milestone} --set-status covered`,
        exitCode: 0,
        stdout: JSON.stringify({ milestone, coveredRequirements: requirements.length, source: rtmPath }, null, 2),
        stderr: result.stderr,
      };
    }
  }
  return {
    ok: result.status === 0,
    reason: result.status === 0 ? 'rtm-promoted' : 'rtm-promotion-failed',
    command: `node ${toolPath} update --milestone ${milestone} --set-status covered`,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function readJsonFromText(text) {
  try {
    return JSON.parse(String(text || '').trim());
  } catch {
    return null;
  }
}

function run(args = parseArgs(), options = {}) {
  if (args.command !== 'run') {
    return {
      ok: args.command === 'help',
      usage: 'node tools/cobolt-build-validate-step.js run --milestone M1 [--json]',
    };
  }

  const projectRoot = options.projectRoot || process.cwd();
  const toolsDir = options.toolsDir || process.env.COBOLT_TOOLS_DIR || process.env.COBOLT_TOOLS || __dirname;
  const milestone = normalizeMilestone(args.milestone);
  if (!milestone) return { ok: false, reason: 'milestone-required' };

  const validateModulePath = path.join(toolsDir, 'cobolt-validate-milestone.js');
  if (!options.validateFn && !fs.existsSync(validateModulePath)) {
    return { ok: false, reason: 'validate-tool-missing', toolPath: validateModulePath };
  }

  const validateFn =
    options.validateFn ||
    ((id) => {
      const validateModule = loadValidateModule(validateModulePath);
      return validateModule.validate(id, { frThreshold: 95, json: false, report: false });
    });

  const validationResults = validateFn(milestone);
  const validationResultsPath = latestBuildPath(projectRoot, milestone, `${milestone}-validation-results.json`);
  writeJson(validationResultsPath, validationResults);
  if (!validationResults || validationResults.overallStatus !== 'PASS') {
    return {
      ok: false,
      reason: 'validation-failed',
      milestone,
      validationResultsPath,
      failedLayers: validationResults?.failedLayers || [],
    };
  }

  const runCommand = options.runCommand || defaultRunCommand;
  const rtmPromotion = options.skipExtraGates
    ? { ok: true, reason: 'skipped-by-test' }
    : runRtmPromotion(projectRoot, milestone, toolsDir, args.timeoutMs, runCommand);
  const schemaGate = options.skipExtraGates
    ? { ok: true, reason: 'skipped-by-test' }
    : runSchemaGate(projectRoot, milestone, toolsDir, args.timeoutMs, runCommand);
  const capabilityGate = options.skipExtraGates
    ? { ok: true, reason: 'skipped-by-test' }
    : runCapabilityGate(projectRoot, milestone, toolsDir, args.timeoutMs, runCommand);
  const capabilityContractGate = options.skipExtraGates
    ? { ok: true, reason: 'skipped-by-test' }
    : runCapabilityContractGate(projectRoot, milestone, toolsDir, args.timeoutMs, runCommand);
  const adrResolutionGate = options.skipExtraGates
    ? { ok: true, reason: 'skipped-by-test' }
    : runAdrResolutionGate(projectRoot, milestone, toolsDir, args.timeoutMs, runCommand);
  const stackConformanceGate = options.skipExtraGates
    ? { ok: true, reason: 'skipped-by-test' }
    : runStackConformanceGate(projectRoot, milestone, toolsDir, args.timeoutMs, runCommand);
  const contractReachabilityGate = options.skipExtraGates
    ? { ok: true, reason: 'skipped-by-test' }
    : runContractReachabilityGate(projectRoot, milestone, toolsDir, args.timeoutMs, runCommand);
  const harnessOnlyGate = options.skipExtraGates
    ? { ok: true, reason: 'skipped-by-test' }
    : runHarnessOnlyGate(projectRoot, milestone, toolsDir, args.timeoutMs, runCommand);
  const fixedPathCoverageGate = options.skipExtraGates
    ? { ok: true, reason: 'skipped-by-test' }
    : runFixedPathCoverageGate(projectRoot, milestone);
  const artifactFreshnessGate = options.skipExtraGates
    ? { ok: true, reason: 'skipped-by-test' }
    : runArtifactFreshnessGate(projectRoot, milestone);
  const buildPacketFreshnessGate = options.skipExtraGates
    ? { ok: true, reason: 'skipped-by-test' }
    : runBuildPacketFreshnessGate(projectRoot, milestone);
  const planQualityGate = options.skipExtraGates
    ? { ok: true, reason: 'skipped-by-test' }
    : runPlanQualityArtifactGate(projectRoot, milestone);
  const uiStateGate = options.skipExtraGates
    ? { ok: true, reason: 'skipped-by-test' }
    : runUiStateGate(projectRoot, milestone);
  const configHygieneGate = options.skipExtraGates
    ? { ok: true, reason: 'skipped-by-test' }
    : runConfigHygieneGate(projectRoot, milestone);
  const irCoverageGate = options.skipExtraGates
    ? { ok: true, reason: 'skipped-by-test' }
    : runIrCoverageGate(projectRoot, milestone);
  const extraGates = {
    ok:
      rtmPromotion.ok &&
      schemaGate.ok &&
      capabilityGate.ok &&
      capabilityContractGate.ok &&
      adrResolutionGate.ok &&
      stackConformanceGate.ok &&
      contractReachabilityGate.ok &&
      harnessOnlyGate.ok &&
      fixedPathCoverageGate.ok &&
      artifactFreshnessGate.ok &&
      buildPacketFreshnessGate.ok &&
      planQualityGate.ok &&
      uiStateGate.ok &&
      configHygieneGate.ok &&
      irCoverageGate.ok,
    rtmPromotion,
    schema: schemaGate,
    capability: capabilityGate,
    capabilityContract: capabilityContractGate,
    adrResolution: adrResolutionGate,
    stackConformance: stackConformanceGate,
    contractReachability: contractReachabilityGate,
    harnessOnly: harnessOnlyGate,
    fixedPathCoverage: fixedPathCoverageGate,
    artifactFreshness: artifactFreshnessGate,
    buildPacketFreshness: buildPacketFreshnessGate,
    planQuality: planQualityGate,
    uiState: uiStateGate,
    configHygiene: configHygieneGate,
    irCoverage: irCoverageGate,
  };

  const phaseB = buildPhaseBRecord(milestone, validationResults, extraGates);
  const phaseBPath = latestBuildPath(projectRoot, milestone, `${milestone}-validation-phase-b.json`);
  writeJson(phaseBPath, phaseB);

  const checkpoint = {
    checkpoint: 'validate',
    milestone,
    passedAt: new Date().toISOString(),
    generatedBy: 'cobolt-build-validate-step',
    validationResults: path.relative(projectRoot, validationResultsPath).replace(/\\/g, '/'),
    phaseB: path.relative(projectRoot, phaseBPath).replace(/\\/g, '/'),
    layers: phaseB.layers,
    overallStatus: phaseB.overallStatus,
  };
  const checkpointDir = projectPath(projectRoot, '_cobolt-output', 'latest', 'build', 'checkpoints');
  writeJson(path.join(checkpointDir, `${milestone}-07-validate.json`), checkpoint);
  writeJson(path.join(checkpointDir, '07-validate.json'), checkpoint);
  syncBuildExecutionLedger(projectRoot, milestone, {
    checkpointPath: path.join(checkpointDir, `${milestone}-07-validate.json`),
    checkpointId: '07-validate',
  });
  projectExecutionLedger(projectRoot);

  return {
    ok: phaseB.overallStatus === 'PASS',
    reason: phaseB.overallStatus === 'PASS' ? 'validation-complete' : 'validation-extra-gate-failed',
    milestone,
    validationResultsPath,
    phaseBPath,
    checkpointPath: path.join(checkpointDir, `${milestone}-07-validate.json`),
    extraGates,
  };
}

if (require.main === module) {
  const args = parseArgs();
  const result = run(args);
  if (args.json || result.usage) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.ok) {
    console.error(result.reason || 'validation failed');
  }
  process.exit(result.ok ? 0 : 1);
}

module.exports = {
  buildPhaseBRecord,
  isNativeDesktopValidation,
  normalizeMilestone,
  parseArgs,
  run,
  runBuildPacketFreshnessGate,
  runCapabilityContractGate,
  runConfigHygieneGate,
  runFixedPathCoverageGate,
  runIrCoverageGate,
  runPlanQualityArtifactGate,
  runStackConformanceGate,
  runUiStateGate,
};
