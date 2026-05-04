#!/usr/bin/env node

// CoBolt Milestone Validator - deterministic 13-layer validation.
//
// Replaces the Step 07 bash specification with an executable tool.
// Each layer is deterministic (no LLM inference).
//
// Layers:
//   L1:  Compile + Tests
//   L2:  Stub + Placeholder Detection
//   L2b: Illusion Detection (behavioral illusions - facades, mock-data, noop wrappers)
//   L3:  Verified FR Coverage
//   L4:  RTM Traceability Coverage
//   L4b: UI Integrity (component registry, a11y, design tokens, perf)
//   L5:  Route Health + Wiring
//   L5b: Event Pairing (publish subjects must have matching subscribers)
//   L5c: Framework Bootstrap (entry-point files for detected frameworks)
//   L6:  Reviewer Completeness
//   L7:  FR Distribution (per-milestone FR count: target 5-8, hard limit 10 — tightened in v0.11.0)
//   L7b: Story Density (per-milestone story shape: target 3-6 stories, hard fail for new coarse plans)

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { evaluateTestObligations, formatBlockingFailures } = require('../lib/cobolt-test-obligations');
const { walkSourceFiles } = require('../lib/cobolt-source-scan');
const { SecurityInvariantScanner } = require('./cobolt-audit');

const TOOLS_DIR = __dirname;
const RTM_TRACEABILITY_THRESHOLD = 95;
const VERIFIED_FR_THRESHOLD = 95;
// F-16 fix: import from shared registry instead of hardcoded list
const { ALL_PREFIXES: REVIEW_EXPECTED_PREFIXES } = require('../lib/cobolt-reviewer-registry');

function runTool(toolName, args, timeout = 30000) {
  const toolPath = path.join(TOOLS_DIR, toolName);
  try {
    const output = execFileSync(process.execPath, [toolPath, ...args], {
      cwd: process.cwd(),
      stdio: 'pipe',
      timeout,
    });
    return { exitCode: 0, stdout: output.toString(), stderr: '' };
  } catch (error) {
    const message = error.message ? String(error.message) : '';
    const stderr = (error.stderr || '').toString();
    return {
      exitCode: error.status || 1,
      stdout: (error.stdout || '').toString(),
      stderr: stderr || message,
    };
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isChildProcessDeniedText(text) {
  return /\bEPERM\b|spawn(?:Sync)?\s+.*\bEPERM\b|operation not permitted|child_process_denied|sandbox/i.test(
    String(text || ''),
  );
}

function isChildProcessDeniedResult(result) {
  return isChildProcessDeniedText(`${result?.stdout || ''}\n${result?.stderr || ''}`);
}

function loadSandboxNodeTestFallbackResult() {
  const logPath = path.join(process.cwd(), '_cobolt-output', 'latest', 'build', 'cobolt-test-node.log');
  if (!fs.existsSync(logPath)) return null;

  const logText = fs.readFileSync(logPath, 'utf8');
  const failMatch = logText.match(/# fail\s+(\d+)/i);
  const passMatch = logText.match(/# pass\s+(\d+)/i);
  const totalMatch = logText.match(/# tests\s+(\d+)/i);
  const compileErrors = (logText.match(/SyntaxError|CompileError|does not compile|type error/gi) || []).length;
  const failed = failMatch ? Number.parseInt(failMatch[1], 10) : (logText.match(/failing|FAILED|Ãƒâ€”/gi) || []).length;
  const passed = passMatch ? Number.parseInt(passMatch[1], 10) : 0;
  const total = totalMatch ? Number.parseInt(totalMatch[1], 10) : passed + failed;

  if (!Number.isFinite(total) || total <= 0) return null;

  return {
    exitCode: failed === 0 && compileErrors === 0 ? 0 : 1,
    stdout: JSON.stringify(
      {
        summary: {
          total,
          passed,
          failed,
        },
        fallbackLog: logPath,
      },
      null,
      2,
    ),
    stderr: logText,
  };
}

function runCoboltTestInProcess(options = {}) {
  const { TestRunner } = require('./cobolt-test');
  const runner = new TestRunner(process.cwd());
  const results = runner.runAuto({ all: true, strict: true, json: true, quiet: true, ...options });
  const report = {
    results,
    summary: {
      total: results.length,
      passed: results.filter((result) => result.success).length,
      failed: results.filter((result) => !result.success).length,
    },
  };
  return {
    exitCode: results.every((result) => result.success) ? 0 : 1,
    stdout: JSON.stringify(report, null, 2),
    stderr: '',
  };
}

function runFRCoverageInProcess(milestone, threshold) {
  const { buildCoverageReportForMilestone } = require('./cobolt-fr-coverage');
  const report = buildCoverageReportForMilestone(milestone, threshold);
  return {
    exitCode: report.passed ? 0 : 1,
    stdout: JSON.stringify(report, null, 2),
    stderr: '',
  };
}

function runRTMCheckInProcess(milestone, threshold, mode = 'mapped') {
  const rtm = require('./cobolt-rtm');
  const data = rtm.readRtm();
  if (!data) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'RTM not initialized',
    };
  }

  const requirements = Object.values(data.requirements || {}).filter(
    (req) => !milestone || rtm.getRequirementMilestones(req).includes(milestone),
  );
  if (requirements.length === 0) {
    return {
      exitCode: 7,
      stdout: JSON.stringify(
        {
          passed: false,
          error: 'empty-scope',
          message: milestone
            ? `0 requirements in scope for milestone=${milestone}. Empty scope cannot satisfy coverage gate.`
            : '0 requirements in RTM. Empty RTM cannot satisfy coverage gate.',
        },
        null,
        2,
      ),
      stderr: '',
    };
  }

  const report = rtm.buildCoverageReport(requirements, threshold, milestone, mode);
  return {
    exitCode: report.passed ? 0 : 1,
    stdout: JSON.stringify(report, null, 2),
    stderr: '',
  };
}

// B007 - explicit stub/illusion allowlist support.
// If an allowlist file exists, only allowlisted items are tolerated as warnings.
// Without an allowlist, ANY stubs or illusions fail the layer.
function loadAllowlist(milestone) {
  const candidates = [
    path.join(process.cwd(), '_cobolt-output', 'latest', 'build', `${milestone}-stub-allowlist.json`),
    path.join(process.cwd(), '_cobolt-output', 'latest', 'build', 'stub-allowlist.json'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return JSON.parse(fs.readFileSync(candidate, 'utf8'));
      }
    } catch (err) {
      // GAP-6: Log the parse error so users know WHY their allowlist isn't working
      process.stderr.write(
        `[cobolt-validate-milestone] WARNING: ${candidate} exists but failed to parse: ${err.message}. ` +
          `Allowlist is NOT active. Fix the JSON syntax or delete the file.\n`,
      );
    }
  }
  return null;
}

function findPlanningDir() {
  const outputRoot = path.join(process.cwd(), '_cobolt-output');
  const candidates = [path.join(outputRoot, 'latest', 'planning'), path.join(outputRoot, 'planning')];
  return candidates.find((dir) => fs.existsSync(dir)) || candidates[0];
}

function findBuildDir(milestone) {
  const outputRoot = path.join(process.cwd(), '_cobolt-output');
  const candidates = [path.join(outputRoot, 'latest', 'build', milestone), path.join(outputRoot, 'build', milestone)];
  return candidates.find((dir) => fs.existsSync(dir)) || candidates[0];
}

function findReviewDir() {
  const outputRoot = path.join(process.cwd(), '_cobolt-output');
  const candidates = [path.join(outputRoot, 'latest', 'review'), path.join(outputRoot, 'review')];
  return candidates.find((dir) => fs.existsSync(dir)) || candidates[0];
}

function validateL1CompileAndTests() {
  if (process.env.COBOLT_LEGACY_L1 !== '1') {
    return validateL1CompileAndTestsDetailed();
  }

  // F-20 fix: log usage of legacy L1 path to audit trail
  try {
    const auditDir = path.join(process.cwd(), '_cobolt-output', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.appendFileSync(
      path.join(auditDir, 'legacy-flag-usage.jsonl'),
      `${JSON.stringify({ timestamp: new Date().toISOString(), flag: 'COBOLT_LEGACY_L1', layer: 'L1' })}\n`,
    );
  } catch {
    /* best-effort */
  }

  const result = runTool('cobolt-test.js', ['--run', '--all', '--strict'], 120000);
  const passed = result.exitCode === 0;
  const failCount = (result.stdout.match(/failing|FAILED|Ã—/gi) || []).length;
  const compileErrors = (result.stdout.match(/SyntaxError|CompileError|does not compile|type error/gi) || []).length;

  return {
    layer: 'L1_compile_tests',
    status: passed ? 'passed' : 'failed',
    compileErrors,
    testFailures: failCount,
    detail: passed
      ? 'All tests pass, zero compile errors'
      : `Exit ${result.exitCode}: ${failCount} failures, ${compileErrors} compile errors`,
  };
}

function validateL1CompileAndTestsDetailed() {
  let result = runTool('cobolt-test.js', ['--run', '--all', '--strict', '--json'], 120000);
  if (result.exitCode !== 0 && isChildProcessDeniedResult(result)) {
    result = loadSandboxNodeTestFallbackResult() || runCoboltTestInProcess();
  }
  if (result.exitCode !== 0 && isChildProcessDeniedResult(result)) {
    result = loadSandboxNodeTestFallbackResult() || result;
  }
  const report = parseJson(result.stdout);
  const passed = result.exitCode === 0;
  const failCount = report?.summary?.failed ?? (result.stdout.match(/failing|FAILED|Ã—/gi) || []).length;
  const passCount = report?.summary?.passed ?? 0;
  const totalCount = report?.summary?.total ?? passCount + failCount;
  const diagnosticText = `${result.stdout}\n${result.stderr}`;
  const compileErrors = (diagnosticText.match(/SyntaxError|CompileError|does not compile|type error/gi) || []).length;

  return {
    layer: 'L1_compile_tests',
    status: passed ? 'passed' : 'failed',
    totalSuites: totalCount,
    passingSuites: passCount,
    compileErrors,
    testFailures: failCount,
    detail: passed
      ? `All tests pass (${passCount}/${totalCount}), zero compile errors`
      : `Exit ${result.exitCode}: ${failCount} failures, ${compileErrors} compile errors`,
  };
}

function validateL1bTestObligations(milestone) {
  const report = evaluateTestObligations(process.cwd(), milestone, {
    enforcePlan: false,
    enforceFiles: true,
  });

  if (report.blocking.length > 0) {
    const failures = formatBlockingFailures(report);
    return {
      layer: 'L1b_test_obligations',
      status: 'failed',
      requiredObligations: report.obligations.map((obligation) => obligation.id),
      missingObligations: report.blocking.map((obligation) => obligation.id),
      detail: `Missing required milestone test coverage: ${failures.join('; ')}`,
    };
  }

  if (report.obligations.length === 0) {
    return {
      layer: 'L1b_test_obligations',
      status: 'passed',
      requiredObligations: [],
      missingObligations: [],
      detail: 'No milestone-scoped E2E/integration/database obligations detected',
    };
  }

  return {
    layer: 'L1b_test_obligations',
    status: 'passed',
    requiredObligations: report.obligations.map((obligation) => obligation.id),
    missingObligations: [],
    detail: `Required test obligations satisfied: ${report.obligations.map((obligation) => obligation.id).join(', ')}`,
  };
}

function validateL2StubDetection(milestone) {
  const result = runTool('cobolt-audit.js', ['stub-scan', '--save', '--json'], 15000);
  const uiPlaceholderResult = runTool('cobolt-ui-placeholder-check.js', ['scan', '--json'], 15000);

  let stubData = parseJson(result.stdout);
  if (!stubData) {
    const buildDir = findBuildDir(milestone);
    const auditDir = path.join(process.cwd(), '_cobolt-output', 'latest', 'audit');
    for (const dir of [auditDir, buildDir]) {
      const stubFile = path.join(dir, 'stub-inventory.json');
      if (!fs.existsSync(stubFile)) continue;
      stubData = parseJson(fs.readFileSync(stubFile, 'utf8'));
      if (stubData) break;
    }
  }
  const uiPlaceholderData = parseJson(uiPlaceholderResult.stdout);

  // Fail-closed: if scanner is missing or crashed, we cannot verify absence of stubs
  if (!stubData && !uiPlaceholderData) {
    return {
      layer: 'L2_stub_detection',
      status: 'failed',
      criticalStubs: 0,
      totalStubs: 0,
      uiPlaceholderFindings: 0,
      detail:
        'Stub/placeholder scan tools failed or unavailable - cannot verify absence of stubs. A missing scanner is NOT a clean scan.',
    };
  }

  const criticalStubs = stubData?.bySeverity?.critical || 0;
  const totalStubs = stubData?.totalFindings || 0;
  const uiPlaceholderFindings = uiPlaceholderData?.summary?.findings || 0;
  const allowlist = loadAllowlist(milestone);

  // B007 - fail-closed: ANY stubs or placeholders fail unless allowlisted
  if (criticalStubs > 0 || uiPlaceholderFindings > 0) {
    return {
      layer: 'L2_stub_detection',
      status: 'failed',
      criticalStubs,
      totalStubs,
      uiPlaceholderFindings,
      detail: `${criticalStubs} critical stubs and ${uiPlaceholderFindings} UI placeholder marker(s) detected - remove placeholder code before review`,
    };
  }

  if (totalStubs > 0 && !allowlist) {
    return {
      layer: 'L2_stub_detection',
      status: 'failed',
      criticalStubs,
      totalStubs,
      uiPlaceholderFindings,
      detail: `${totalStubs} stubs detected. Create a stub-allowlist.json to explicitly permit known stubs, or remove them.`,
    };
  }

  return {
    layer: 'L2_stub_detection',
    status: totalStubs > 0 ? 'warning' : 'passed',
    criticalStubs,
    totalStubs,
    uiPlaceholderFindings,
    detail:
      totalStubs > 0
        ? `${totalStubs} stubs found (allowlisted), 0 critical, ${uiPlaceholderFindings} UI placeholder markers`
        : `0 stubs, 0 UI placeholder markers`,
  };
}

function validateL2bIllusionDetection(milestone) {
  const result = runTool('cobolt-illusion-scan.js', ['scan', '--save', '--json'], 15000);

  let illusionData = parseJson(result.stdout);
  if (!illusionData) {
    // Try to read saved inventory
    const auditDir = path.join(process.cwd(), '_cobolt-output', 'latest', 'audit');
    const inventoryFile = path.join(auditDir, 'illusion-inventory.json');
    if (fs.existsSync(inventoryFile)) {
      illusionData = parseJson(fs.readFileSync(inventoryFile, 'utf8'));
    }
  }

  // Fail-closed: if scanner is missing or crashed, we cannot verify absence of illusions
  if (!illusionData) {
    return {
      layer: 'L2b_illusion_detection',
      status: 'failed',
      criticalIllusions: 0,
      totalIllusions: 0,
      byCategory: {},
      detail:
        'Illusion scan tool failed or unavailable - cannot verify absence of illusions. A missing scanner is NOT a clean scan.',
    };
  }

  const criticalIllusions = illusionData?.bySeverity?.critical || 0;
  const totalIllusions = illusionData?.totalIllusions || 0;

  // B007 - fail-closed: critical illusions always fail
  if (criticalIllusions > 0) {
    return {
      layer: 'L2b_illusion_detection',
      status: 'failed',
      criticalIllusions,
      totalIllusions,
      byCategory: illusionData?.byCategory || {},
      detail: `${criticalIllusions} CRITICAL illusions detected - functions that look complete but aren't doing real work`,
    };
  }

  // B007 - non-critical illusions also fail unless allowlisted
  const allowlist = loadAllowlist(milestone);
  if (totalIllusions > 0 && !allowlist) {
    return {
      layer: 'L2b_illusion_detection',
      status: 'failed',
      criticalIllusions,
      totalIllusions,
      byCategory: illusionData?.byCategory || {},
      detail: `${totalIllusions} illusions detected. Create a stub-allowlist.json to explicitly permit known illusions, or fix them.`,
    };
  }

  return {
    layer: 'L2b_illusion_detection',
    status: totalIllusions > 0 ? 'warning' : 'passed',
    criticalIllusions,
    totalIllusions,
    byCategory: illusionData?.byCategory || {},
    detail: totalIllusions > 0 ? `${totalIllusions} illusions found (allowlisted), 0 critical` : `0 illusions detected`,
  };
}

function validateL2cSecurityInvariants() {
  const scanner = new SecurityInvariantScanner(process.cwd());
  const result = scanner.scan();

  if ((result.totalFindings || 0) > 0) {
    return {
      layer: 'L2c_security_invariants',
      status: 'failed',
      totalFindings: result.totalFindings,
      byCategory: result.byCategory || {},
      detail: `High-signal auth/session invariant violations detected: ${result.totalFindings}`,
    };
  }

  return {
    layer: 'L2c_security_invariants',
    status: 'passed',
    totalFindings: 0,
    byCategory: {},
    detail: 'No high-signal auth/session invariant violations detected',
  };
}

function validateL3FRCoverage(milestone, threshold) {
  let result = runTool(
    'cobolt-fr-coverage.js',
    ['check', '--milestone', milestone, '--threshold', String(threshold), '--json'],
    30000,
  );
  if (result.exitCode !== 0 && isChildProcessDeniedResult(result)) {
    try {
      result = runFRCoverageInProcess(milestone, threshold);
    } catch (error) {
      result = { exitCode: 1, stdout: '', stderr: error.message || String(error) };
    }
  }

  const coverageData = parseJson(result.stdout);
  if (!coverageData) {
    const toolError =
      result.stderr.trim() || result.stdout.trim() || 'No machine-readable output from cobolt-fr-coverage.js';
    return {
      layer: 'L3_fr_coverage',
      status: 'failed',
      coverage: 0,
      totalFRs: 0,
      implemented: 0,
      verified: 0,
      missing: 0,
      stubbed: 0,
      missingRepositories: 0,
      threshold,
      detail: `FR coverage tool failed: ${toolError.slice(0, 200)}`,
      missingFRs: [],
      stubbedFRs: [],
    };
  }

  const coverage = coverageData?.verifiedCoverage ?? coverageData?.coverage ?? 0;
  const totalFRs = coverageData?.totalFRs || 0;
  const missing = coverageData?.missing || 0;
  const stubbed = coverageData?.stubbed || 0;
  const passed = result.exitCode === 0 && coverage >= threshold;

  return {
    layer: 'L3_fr_coverage',
    // GAP-8: totalFRs===0 must fail, not warn - no FRs means coverage gate is meaningless
    status: totalFRs === 0 ? 'failed' : passed ? 'passed' : 'failed',
    coverage,
    totalFRs,
    implemented: coverageData?.implemented ?? coverageData?.coded ?? 0,
    verified: coverageData?.verified ?? coverageData?.tested ?? 0,
    missing,
    stubbed,
    missingRepositories: coverageData?.missingRepositories || 0,
    threshold,
    detail:
      totalFRs === 0
        ? 'FAILED: No FRs found in PRD - use FR-xxx format. Cannot verify coverage without machine-readable requirements.'
        : passed
          ? `${coverage}% verified FR coverage (${totalFRs} FRs, threshold ${threshold}%)`
          : `${coverage}% verified FR coverage BELOW ${threshold}% - ${missing} missing, ${stubbed} stubbed`,
    missingFRs:
      coverageData?.details?.filter((detail) => detail.status === 'missing')?.map((detail) => detail.id) || [],
    stubbedFRs: coverageData?.details?.filter((detail) => detail.status === 'stub')?.map((detail) => detail.id) || [],
  };
}

function validateL4RTMIntegrity(milestone) {
  const planDir = findPlanningDir();
  const rtmFile = path.join(planDir, 'rtm.json');

  if (!fs.existsSync(rtmFile)) {
    return {
      layer: 'L4_rtm_integrity',
      status: 'failed',
      detail: 'RTM file does not exist',
    };
  }

  let result = runTool(
    'cobolt-rtm.js',
    [
      'check',
      '--milestone',
      milestone,
      '--mode',
      'mapped',
      '--threshold',
      String(RTM_TRACEABILITY_THRESHOLD),
      '--json',
    ],
    10000,
  );
  if (result.exitCode !== 0 && isChildProcessDeniedResult(result)) {
    try {
      result = runRTMCheckInProcess(milestone, RTM_TRACEABILITY_THRESHOLD, 'mapped');
    } catch (error) {
      result = { exitCode: 1, stdout: '', stderr: error.message || String(error) };
    }
  }
  const report = parseJson(result.stdout);

  if (!report) {
    const toolError = result.stderr.trim() || result.stdout.trim() || 'No machine-readable output from cobolt-rtm.js';
    return {
      layer: 'L4_rtm_integrity',
      status: 'failed',
      coverage: 0,
      totalRequirements: 0,
      mode: 'mapped',
      detail: `RTM tool failed: ${toolError.slice(0, 200)}`,
    };
  }

  const coverage = report.coverage || 0;
  const totalRequirements = report.totalRequirements || 0;
  const mode = report.mode || 'mapped';
  const passed = result.exitCode === 0 && report.passed === true;

  return {
    layer: 'L4_rtm_integrity',
    status: passed ? 'passed' : 'failed',
    coverage,
    totalRequirements,
    mode,
    counts: report.counts || {},
    detail: passed
      ? `RTM ${mode} coverage ${coverage}% (${totalRequirements} requirements, threshold ${RTM_TRACEABILITY_THRESHOLD}%)`
      : `RTM ${mode} coverage ${coverage}% BELOW ${RTM_TRACEABILITY_THRESHOLD}% (${totalRequirements} requirements) - run cobolt-rtm.js status`,
  };
}

function validateL4bUIIntegrity() {
  const uiDetectionResult = runTool('cobolt-ui-detection.js', ['--json'], 10000);
  const uiDetection = parseJson(uiDetectionResult.stdout);

  if (!uiDetection?.hasUI) {
    return {
      layer: 'L4b_ui_integrity',
      status: 'passed',
      detail: 'No UI detected - UI integrity checks skipped',
    };
  }

  const frameworks = Array.isArray(uiDetection.frameworks)
    ? uiDetection.frameworks.map((value) => String(value).toLowerCase())
    : [];
  const isNativeDesktopUi =
    frameworks.some((framework) => /\b(?:wpf|winui|maui|avalonia|windows forms|winforms)\b/i.test(framework)) &&
    !uiDetection.playwrightConfigPath &&
    (!Array.isArray(uiDetection.uiSourceFiles) || uiDetection.uiSourceFiles.length === 0);
  if (isNativeDesktopUi) {
    return {
      layer: 'L4b_ui_integrity',
      status: 'passed',
      uiSignals: uiDetection.signals || [],
      frameworks: uiDetection.frameworks || [],
      detail: 'Native desktop UI detected - web component registry checks are not applicable',
    };
  }

  const componentResult = runTool('cobolt-component-validator.js', ['--json'], 15000);
  const a11yResult = runTool('cobolt-a11y-linter.js', ['--json'], 15000);
  const tokenResult = runTool('cobolt-design-token-linter.js', ['--json'], 15000);
  const perfResult = runTool('cobolt-perf-linter.js', ['--json'], 15000);
  const frontendRuntimeResult = runTool('cobolt-frontend-runtime-check.js', ['--json'], 15000);

  const componentData = parseJson(componentResult.stdout);
  const a11yData = parseJson(a11yResult.stdout);
  const tokenData = parseJson(tokenResult.stdout);
  const perfData = parseJson(perfResult.stdout);
  const frontendRuntimeData = parseJson(frontendRuntimeResult.stdout);

  const errors = {
    component: componentData?.summary?.errors || 0,
    a11y: a11yData?.summary?.errors || 0,
    designTokens: tokenData?.summary?.errors || 0,
    perf: perfData?.summary?.errors || 0,
    frontendRuntime: frontendRuntimeData?.summary?.errors || 0,
  };
  const warnings = {
    component: componentData?.summary?.warnings || 0,
    a11y: a11yData?.summary?.warnings || 0,
    designTokens: tokenData?.summary?.warnings || 0,
    perf: perfData?.summary?.warnings || 0,
    frontendRuntime: frontendRuntimeData?.summary?.warnings || 0,
  };
  const totalErrors = Object.values(errors).reduce((sum, value) => sum + value, 0);
  const totalWarnings = Object.values(warnings).reduce((sum, value) => sum + value, 0);
  const passed = totalErrors === 0;

  return {
    layer: 'L4b_ui_integrity',
    status: passed ? (totalWarnings > 0 ? 'warning' : 'passed') : 'failed',
    uiSignals: uiDetection.signals || [],
    errors,
    warnings,
    detail: passed
      ? `UI integrity checks passed${totalWarnings > 0 ? ` with ${totalWarnings} warning(s)` : ''}`
      : `UI integrity checks failed - component:${errors.component} a11y:${errors.a11y} design:${errors.designTokens} perf:${errors.perf} frontendRuntime:${errors.frontendRuntime}`,
    frontendRuntimeIssues: frontendRuntimeData?.issues || [],
  };
}

function validateL5RouteHealth(milestone) {
  const buildDir = findBuildDir(milestone);
  const smokeConfig = path.join(buildDir, `${milestone}-smoke-config.json`);
  const smokeTool = path.join(TOOLS_DIR, 'cobolt-smoke-test.js');
  let smokeFailure = null;
  let smokeData = null;

  if (fs.existsSync(smokeTool) && fs.existsSync(smokeConfig)) {
    const result = runTool('cobolt-smoke-test.js', ['--config', smokeConfig, '--json'], 30000);
    smokeData = parseJson(result.stdout);
    if (smokeData && result.exitCode !== 0) {
      smokeFailure = {
        detail: smokeData.detail || 'Configured smoke tests failed',
        data: smokeData,
      };
    }
  }

  const { findMissingRepositories } = require('./cobolt-fr-coverage.js');
  const missingRepos = findMissingRepositories();
  const routeWiringResult = runTool('cobolt-route-wiring-check.js', ['scan', '--json'], 15000);
  const routeWiringData = parseJson(routeWiringResult.stdout);
  const unwiredDomains = routeWiringData?.summary?.unwired || 0;
  const partialDomains = routeWiringData?.summary?.partial || 0;
  const problematicDomains =
    routeWiringData?.domains
      ?.filter((domain) => domain.status === 'unwired' || domain.status === 'partial')
      .slice(0, 10)
      .map((domain) => `${domain.name}:${domain.status}`) || [];

  if (smokeFailure) {
    return {
      layer: 'L5_route_health',
      status: 'failed',
      ...smokeFailure.data,
      detail: smokeFailure.detail,
    };
  }

  if (missingRepos.length > 0) {
    return {
      layer: 'L5_route_health',
      status: 'failed',
      nilRepositories: missingRepos.length,
      detail: `${missingRepos.length} nil-repository pattern(s) found - routes will crash on database calls`,
      files: missingRepos.slice(0, 10).map((item) => `${item.file}:${item.line}`),
    };
  }

  if (unwiredDomains > 0 || partialDomains > 0) {
    return {
      layer: 'L5_route_health',
      status: 'failed',
      unwiredDomains,
      partialDomains,
      problematicDomains,
      detail: `${unwiredDomains} unwired and ${partialDomains} partially wired domain(s) detected - missing router/main/bootstrap wiring will leave features unreachable at runtime`,
    };
  }

  // -- L5b: Entry Point Wiring Audit (call-graph verification) --
  let entrypointWiring = { summary: { unwired: 0, total: 0 } };
  try {
    const { scan: wiringScan } = require('./cobolt-entrypoint-wiring-check');
    entrypointWiring = wiringScan(process.cwd());
  } catch {
    // Tool not available - fall through to regex-based check above
  }

  if (entrypointWiring.summary.unwired > 0) {
    const unwiredNames = entrypointWiring.domains
      .filter((d) => d.status === 'unwired')
      .map((d) => `${d.name}: ${d.evidence}`)
      .slice(0, 10);
    return {
      layer: 'L5_route_health',
      status: 'failed',
      unwiredDomains: entrypointWiring.summary.unwired,
      detail: `${entrypointWiring.summary.unwired} domain(s) have route registration functions that are DEFINED but never CALLED from any entry point: ${unwiredNames.join('; ')}`,
      wiringReport: entrypointWiring,
    };
  }

  // L5c: Worker Lifecycle Audit
  let workerResult = { summary: { definedNotStarted: 0, total: 0 } };
  try {
    const { scan: workerScan } = require('./cobolt-worker-lifecycle-check');
    workerResult = workerScan(process.cwd());
  } catch (err) {
    return {
      layer: 'L5_route_health',
      status: 'failed',
      nilRepositories: 0,
      unwiredDomains: 0,
      partialDomains: 0,
      detail: `Worker lifecycle audit could not run: ${err.message}`,
    };
  }

  if (workerResult.summary.definedNotStarted > 0) {
    const unstartedNames = (workerResult.workers || [])
      .filter((worker) => worker.status === 'defined-not-started')
      .map((worker) => `${worker.name}: ${worker.evidence || worker.file || 'no startup evidence'}`)
      .slice(0, 10);
    return {
      layer: 'L5_route_health',
      status: 'failed',
      nilRepositories: 0,
      unwiredDomains: 0,
      partialDomains: 0,
      unstartedWorkers: workerResult.summary.definedNotStarted,
      wiringReport: entrypointWiring,
      workerReport: workerResult,
      detail: `${workerResult.summary.definedNotStarted} worker(s) are defined but not started: ${unstartedNames.join('; ')}`,
    };
  }

  return {
    layer: 'L5_route_health',
    status: 'passed',
    nilRepositories: 0,
    unwiredDomains: 0,
    partialDomains: 0,
    unstartedWorkers: workerResult.summary.definedNotStarted,
    wiringReport: entrypointWiring,
    workerReport: workerResult,
    detail: `L5 passed: ${entrypointWiring.summary.wired || 0} domain(s) wired, ${workerResult.summary.started || 0} worker(s) started`,
  };
}

function validateL5bEventPairing() {
  // Scan for event publish calls and verify matching subscribe/consumer calls exist.
  // Covers: NATS, RabbitMQ/AMQP, Kafka, Redis PubSub, Go channels, custom event buses.
  const projectDir = process.cwd();
  const { findLineMatches } = require('../lib/cobolt-source-scan');

  // Publish patterns by technology
  const PUBLISH_PATTERNS = [
    // NATS
    { tech: 'nats', pattern: /(?:nats|nc|conn|js)\.Publish\w*\s*\(\s*["'`]([^"'`]+)["'`]/, side: 'publish' },
    { tech: 'nats', pattern: /\.Publish\s*\(\s*(?:ctx,?\s*)?["'`]([^"'`]+)["'`]/, side: 'publish' },
    // RabbitMQ / AMQP
    { tech: 'amqp', pattern: /\.(?:Publish|BasicPublish|SendToQueue)\s*\(\s*["'`]([^"'`),]+)/, side: 'publish' },
    { tech: 'amqp', pattern: /channel\.publish\s*\(\s*["'`]([^"'`]+)["'`]/, side: 'publish' },
    // Kafka
    {
      tech: 'kafka',
      pattern: /\.(?:Produce|Send|ProduceSync)\s*\([\s\S]*?(?:Topic|topic)\s*[:=]\s*["'`]([^"'`]+)/,
      side: 'publish',
    },
    // Redis PubSub
    { tech: 'redis', pattern: /\.Publish\s*\(\s*(?:ctx,?\s*)?["'`]([^"'`]+)["'`]/, side: 'publish' },
    // Generic event bus patterns
    {
      tech: 'eventbus',
      pattern: /\.(?:emit|dispatch|fire|trigger|publish|broadcast)\s*\(\s*["'`]([^"'`]+)["'`]/,
      side: 'publish',
    },
  ];

  const SUBSCRIBE_PATTERNS = [
    // NATS
    { tech: 'nats', pattern: /\.Subscribe\w*\s*\(\s*["'`]([^"'`]+)["'`]/, side: 'subscribe' },
    { tech: 'nats', pattern: /\.QueueSubscribe\w*\s*\(\s*["'`]([^"'`]+)["'`]/, side: 'subscribe' },
    // RabbitMQ / AMQP
    { tech: 'amqp', pattern: /\.(?:Consume|BasicConsume|Subscribe)\s*\(\s*["'`]([^"'`),]+)/, side: 'subscribe' },
    { tech: 'amqp', pattern: /channel\.consume\s*\(\s*["'`]([^"'`]+)["'`]/, side: 'subscribe' },
    // Kafka
    { tech: 'kafka', pattern: /\.(?:Subscribe|Consume)\s*\([\s\S]*?["'`]([^"'`]+)["'`]/, side: 'subscribe' },
    // Redis PubSub
    { tech: 'redis', pattern: /\.(?:Subscribe|PSubscribe)\s*\(\s*(?:ctx,?\s*)?["'`]([^"'`]+)["'`]/, side: 'subscribe' },
    // Generic event bus patterns
    {
      tech: 'eventbus',
      pattern: /\.(?:on|subscribe|listen|addListener|addEventListener)\s*\(\s*["'`]([^"'`]+)["'`]/,
      side: 'subscribe',
    },
  ];

  const includeExtensions = ['.go', '.js', '.ts', '.tsx', '.jsx', '.py', '.ex', '.exs', '.rs', '.java'];
  const publishers = new Map(); // subject -> [{ file, line, tech }]
  const subscribers = new Map(); // subject -> [{ file, line, tech }]

  // Scan for publish patterns
  for (const { tech, pattern } of PUBLISH_PATTERNS) {
    try {
      const matches = findLineMatches(projectDir, pattern, { includeExtensions });
      for (const match of matches) {
        const subjectMatch = match.text?.match(pattern);
        if (!subjectMatch?.[1]) continue;
        const subject = subjectMatch[1].trim();
        if (!publishers.has(subject)) publishers.set(subject, []);
        publishers.get(subject).push({ file: match.file, line: match.line, tech });
      }
    } catch {
      /* scanner error - skip this pattern */
    }
  }

  // Scan for subscribe patterns
  for (const { tech, pattern } of SUBSCRIBE_PATTERNS) {
    try {
      const matches = findLineMatches(projectDir, pattern, { includeExtensions });
      for (const match of matches) {
        const subjectMatch = match.text?.match(pattern);
        if (!subjectMatch?.[1]) continue;
        const subject = subjectMatch[1].trim();
        if (!subscribers.has(subject)) subscribers.set(subject, []);
        subscribers.get(subject).push({ file: match.file, line: match.line, tech });
      }
    } catch {
      /* scanner error - skip this pattern */
    }
  }

  // Find orphaned publishers (publish with no subscribe)
  const orphanedPublishers = [];
  for (const [subject, pubs] of publishers) {
    // Check for exact match or wildcard match (NATS uses . delimiters, * and > wildcards)
    const hasSubscriber =
      subscribers.has(subject) ||
      [...subscribers.keys()].some((sub) => {
        // NATS wildcard: events.* matches events.created, events.> matches events.anything.deep
        const subPattern = sub.replace(/\*/g, '[^.]+').replace(/>/g, '.+');
        try {
          return new RegExp(`^${subPattern}$`).test(subject);
        } catch {
          return false;
        }
      });

    if (!hasSubscriber) {
      orphanedPublishers.push({
        subject,
        tech: pubs[0].tech,
        publishers: pubs.slice(0, 3).map((p) => `${p.file}:${p.line}`),
      });
    }
  }

  // Find orphaned subscribers (subscribe with no publish - less critical but worth noting)
  const orphanedSubscribers = [];
  for (const [subject, subs] of subscribers) {
    const hasPublisher =
      publishers.has(subject) ||
      [...publishers.keys()].some((pub) => {
        const subPattern = subject.replace(/\*/g, '[^.]+').replace(/>/g, '.+');
        try {
          return new RegExp(`^${subPattern}$`).test(pub);
        } catch {
          return false;
        }
      });

    if (!hasPublisher) {
      orphanedSubscribers.push({
        subject,
        tech: subs[0].tech,
        subscribers: subs.slice(0, 3).map((s) => `${s.file}:${s.line}`),
      });
    }
  }

  const totalPublishSubjects = publishers.size;
  const totalSubscribeSubjects = subscribers.size;
  const hasEvents = totalPublishSubjects > 0 || totalSubscribeSubjects > 0;

  if (!hasEvents) {
    return {
      layer: 'L5b_event_pairing',
      status: 'passed',
      totalPublishSubjects: 0,
      totalSubscribeSubjects: 0,
      orphanedPublishers: 0,
      orphanedSubscribers: 0,
      detail: 'No event publish/subscribe patterns detected - skipped',
    };
  }

  const passed = orphanedPublishers.length === 0;

  return {
    layer: 'L5b_event_pairing',
    status: passed ? (orphanedSubscribers.length > 0 ? 'warning' : 'passed') : 'failed',
    totalPublishSubjects,
    totalSubscribeSubjects,
    orphanedPublishers: orphanedPublishers.length,
    orphanedSubscribers: orphanedSubscribers.length,
    orphanedPublisherDetails: orphanedPublishers.slice(0, 10),
    orphanedSubscriberDetails: orphanedSubscribers.slice(0, 5),
    detail: passed
      ? orphanedSubscribers.length > 0
        ? `All ${totalPublishSubjects} publish subjects have subscribers. ${orphanedSubscribers.length} subscriber(s) have no publisher (dead listeners).`
        : `All ${totalPublishSubjects} publish subjects have matching subscribers`
      : `${orphanedPublishers.length} event subject(s) published with NO subscriber: ${orphanedPublishers.map((o) => o.subject).join(', ')}`,
  };
}

function validateL5cFrameworkBootstrap() {
  // Detect framework from project files and verify entry-point/bootstrap files exist.
  // A project can have all pages, passing tests, and wired routes but still not run
  // because layout.tsx, next.config, globals.css, or equivalent is missing.
  const projectDir = process.cwd();

  // Framework detection rules: { detector: file that identifies the framework, required: must-exist files }
  const FRAMEWORKS = [
    {
      name: 'Next.js (App Router)',
      detector: () => {
        const pkg = safeReadJson(path.join(projectDir, 'package.json'));
        const hasNext = pkg?.dependencies?.next || pkg?.devDependencies?.next;
        // App router: check for app/ directory
        const hasAppDir =
          fs.existsSync(path.join(projectDir, 'app')) || fs.existsSync(path.join(projectDir, 'src', 'app'));
        return hasNext && hasAppDir;
      },
      required: [
        {
          patterns: ['app/layout.tsx', 'app/layout.jsx', 'app/layout.js', 'src/app/layout.tsx', 'src/app/layout.jsx'],
          label: 'Root layout (app/layout.tsx)',
        },
        { patterns: ['next.config.ts', 'next.config.js', 'next.config.mjs'], label: 'Next.js config' },
        {
          patterns: [
            'app/globals.css',
            'app/global.css',
            'src/app/globals.css',
            'styles/globals.css',
            'app/layout.css',
          ],
          label: 'Global styles',
        },
      ],
    },
    {
      name: 'Next.js (Pages Router)',
      detector: () => {
        const pkg = safeReadJson(path.join(projectDir, 'package.json'));
        const hasNext = pkg?.dependencies?.next || pkg?.devDependencies?.next;
        const hasPagesDir =
          fs.existsSync(path.join(projectDir, 'pages')) || fs.existsSync(path.join(projectDir, 'src', 'pages'));
        const hasAppDir =
          fs.existsSync(path.join(projectDir, 'app')) || fs.existsSync(path.join(projectDir, 'src', 'app'));
        return hasNext && hasPagesDir && !hasAppDir;
      },
      required: [
        {
          patterns: ['pages/_app.tsx', 'pages/_app.jsx', 'pages/_app.js', 'src/pages/_app.tsx'],
          label: 'Custom App (_app.tsx)',
        },
        { patterns: ['next.config.ts', 'next.config.js', 'next.config.mjs'], label: 'Next.js config' },
        { patterns: ['styles/globals.css', 'pages/globals.css', 'styles/global.css'], label: 'Global styles' },
      ],
    },
    {
      name: 'Vite (React/Vue/Svelte)',
      detector: () => {
        const pkg = safeReadJson(path.join(projectDir, 'package.json'));
        return pkg?.dependencies?.vite || pkg?.devDependencies?.vite;
      },
      required: [
        { patterns: ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'], label: 'Vite config' },
        { patterns: ['index.html'], label: 'HTML entry point' },
        {
          patterns: ['src/main.tsx', 'src/main.jsx', 'src/main.ts', 'src/main.js', 'src/main.svelte', 'src/App.vue'],
          label: 'App entry point',
        },
      ],
    },
    {
      name: 'Create React App',
      detector: () => {
        const pkg = safeReadJson(path.join(projectDir, 'package.json'));
        return pkg?.dependencies?.['react-scripts'];
      },
      required: [
        { patterns: ['public/index.html'], label: 'HTML entry point' },
        { patterns: ['src/index.tsx', 'src/index.jsx', 'src/index.js'], label: 'App entry point' },
        { patterns: ['src/App.tsx', 'src/App.jsx', 'src/App.js'], label: 'Root component' },
      ],
    },
    {
      name: 'Go (HTTP server)',
      detector: () => {
        return findFile(projectDir, 'go.mod', 4);
      },
      required: [
        {
          patterns: ['main.go', 'cmd/*/main.go', 'cmd/server/main.go', 'backend/main.go', 'backend/cmd/*/main.go'],
          label: 'Go main entry point',
        },
      ],
    },
    {
      name: 'Phoenix (Elixir)',
      detector: () => {
        return fs.existsSync(path.join(projectDir, 'mix.exs'));
      },
      required: [
        { patterns: ['mix.exs'], label: 'Mix project file' },
        { patterns: ['config/config.exs'], label: 'Config entry point' },
        { patterns: ['lib/*/application.ex', 'lib/*_web/endpoint.ex'], label: 'Application/Endpoint module' },
      ],
    },
    {
      name: 'Python (Django/Flask/FastAPI)',
      detector: () => {
        return (
          fs.existsSync(path.join(projectDir, 'pyproject.toml')) ||
          fs.existsSync(path.join(projectDir, 'requirements.txt')) ||
          fs.existsSync(path.join(projectDir, 'setup.py'))
        );
      },
      required: [
        {
          patterns: [
            'manage.py',
            'app.py',
            'main.py',
            'wsgi.py',
            'asgi.py',
            'backend/main.py',
            'backend/app.py',
            'src/main.py',
          ],
          label: 'Python entry point',
        },
      ],
    },
  ];

  function safeReadJson(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  function findFile(dir, name, maxDepth, depth = 0) {
    if (depth > maxDepth || !fs.existsSync(dir)) return false;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() && entry.name === name) return true;
        if (entry.isDirectory() && !['node_modules', '.git', '_cobolt-output', 'vendor'].includes(entry.name)) {
          if (findFile(path.join(dir, entry.name), name, maxDepth, depth + 1)) return true;
        }
      }
    } catch {
      /* permission errors */
    }
    return false;
  }

  function matchesGlobPattern(pattern) {
    if (!pattern.includes('*')) {
      return fs.existsSync(path.join(projectDir, pattern));
    }

    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+');
    const matcher = new RegExp(`^${escaped}$`);
    const files = walkSourceFiles(projectDir).map((entry) => entry.relativePath.replace(/\\/g, '/'));
    return files.some((relativePath) => matcher.test(relativePath));
  }

  // Detect which frameworks are in use
  const detectedFrameworks = [];
  for (const fw of FRAMEWORKS) {
    try {
      if (fw.detector()) detectedFrameworks.push(fw);
    } catch {
      /* detector failed - skip */
    }
  }

  if (detectedFrameworks.length === 0) {
    return {
      layer: 'L5c_framework_bootstrap',
      status: 'passed',
      detail: 'No recognized framework detected - bootstrap check skipped',
      frameworks: [],
      missingFiles: [],
    };
  }

  // Check required files for each detected framework
  const allMissing = [];
  const frameworkResults = [];

  for (const fw of detectedFrameworks) {
    const missing = [];
    for (const req of fw.required) {
      const exists = req.patterns.some((p) => matchesGlobPattern(p));
      if (!exists) {
        missing.push({ label: req.label, searchedPatterns: req.patterns });
      }
    }
    frameworkResults.push({ framework: fw.name, missing });
    allMissing.push(...missing.map((m) => `${fw.name}: ${m.label}`));
  }

  const passed = allMissing.length === 0;

  return {
    layer: 'L5c_framework_bootstrap',
    status: passed ? 'passed' : 'failed',
    detectedFrameworks: detectedFrameworks.map((f) => f.name),
    missingFiles: allMissing,
    frameworkDetails: frameworkResults,
    detail: passed
      ? `Framework bootstrap verified for: ${detectedFrameworks.map((f) => f.name).join(', ')}`
      : `${allMissing.length} missing bootstrap file(s): ${allMissing.join('; ')}. App will not run without these entry points.`,
  };
}

function validateL6ReviewerCompleteness(milestone) {
  const reviewDir = findReviewDir();
  const coveragePath = path.join(reviewDir, `${milestone}-coverage-verdict.json`);
  const coverageVerdict = fs.existsSync(coveragePath) ? parseJson(fs.readFileSync(coveragePath, 'utf8')) : null;
  const missingFromCoverage = coverageVerdict?.prefixes?.missing || coverageVerdict?.missingPrefixes || [];
  if (coverageVerdict?.passed === true && Array.isArray(missingFromCoverage) && missingFromCoverage.length === 0) {
    const manifestPath = path.join(reviewDir, 'review-manifest.json');
    const manifest = fs.existsSync(manifestPath) ? parseJson(fs.readFileSync(manifestPath, 'utf8')) : null;
    const completed = Array.isArray(manifest?.completed)
      ? manifest.completed.length
      : coverageVerdict?.completedReviewers || 0;
    return {
      layer: 'L6_reviewer_completeness',
      status: 'passed',
      expectedReviewers: coverageVerdict?.prefixes?.expected?.length || coverageVerdict?.expectedReviewers || completed,
      completedReviewers: completed,
      completeness: 100,
      missingCore: [],
      missingPrefixes: [],
      detail: `${completed} reviewer dispatches completed; review coverage verdict passed with no missing configured prefixes`,
    };
  }

  const rawFindingsPath = path.join(reviewDir, `${milestone}-raw-findings.json`);
  const rawFindings = fs.existsSync(rawFindingsPath) ? parseJson(fs.readFileSync(rawFindingsPath, 'utf8')) : null;
  const rawCompleteness = rawFindings?.reviewerCompleteness || null;

  if (rawCompleteness) {
    const missingCore = rawCompleteness.missingCore || [];
    const missingAll = rawCompleteness.missingAll || [];
    const expected = rawCompleteness.expected || REVIEW_EXPECTED_PREFIXES.length;
    const found = rawCompleteness.found || Math.max(0, expected - missingAll.length);
    const completeness =
      rawCompleteness.completenessPercent || (expected > 0 ? Math.round((found / expected) * 100) : 0);
    const passed = missingCore.length === 0 && missingAll.length <= 3;

    return {
      layer: 'L6_reviewer_completeness',
      status: passed ? 'passed' : 'failed',
      expectedReviewers: expected,
      completedReviewers: found,
      completeness,
      missingCore,
      missingPrefixes: missingAll,
      detail: passed
        ? `${found}/${expected} reviewers completed (${missingAll.length} missing, raw findings contract satisfied)`
        : `${found}/${expected} reviewers completed - missing core: ${missingCore.join(', ') || 'none'}; missing total: ${missingAll.length}`,
    };
  }

  const foundPrefixes = new Set();
  try {
    const files = fs.readdirSync(reviewDir);
    for (const file of files) {
      const match = file.match(new RegExp(`${milestone}-findings-([A-Z0-9]+)\\.json$`));
      if (match) foundPrefixes.add(match[1]);
    }
  } catch {
    /* review dir does not exist */
  }

  const missing = REVIEW_EXPECTED_PREFIXES.filter((prefix) => !foundPrefixes.has(prefix));
  const completeness =
    REVIEW_EXPECTED_PREFIXES.length > 0 ? Math.round((foundPrefixes.size / REVIEW_EXPECTED_PREFIXES.length) * 100) : 0;
  const passed = missing.length <= 3;

  return {
    layer: 'L6_reviewer_completeness',
    status: foundPrefixes.size === 0 ? 'failed' : passed ? 'passed' : 'failed',
    expectedReviewers: REVIEW_EXPECTED_PREFIXES.length,
    completedReviewers: foundPrefixes.size,
    completeness,
    missingPrefixes: missing,
    detail:
      foundPrefixes.size === 0
        ? 'NO reviewers produced findings - review step likely skipped entirely'
        : passed
          ? `${foundPrefixes.size}/${REVIEW_EXPECTED_PREFIXES.length} reviewers completed (${missing.length} missing, within tolerance)`
          : `${foundPrefixes.size}/${REVIEW_EXPECTED_PREFIXES.length} reviewers completed - ${missing.length} missing: ${missing.join(', ')}`,
  };
}

function validateL7FRDistribution() {
  // Tightened from 15→10 in v0.11.0. Target 5-8 FRs/milestone.
  const FR_TARGET_MIN = 5;
  const FR_TARGET_MAX = 8;
  const FR_HARD_LIMIT = 10;

  let getMilestoneFRCounts;
  try {
    getMilestoneFRCounts = require('../lib/cobolt-planning-artifacts').getMilestoneFRCounts;
  } catch {
    return {
      layer: 'L7_fr_distribution',
      status: 'failed',
      detail: 'Could not load cobolt-planning-artifacts - cannot validate FR distribution',
    };
  }

  const frCounts = getMilestoneFRCounts(process.cwd());
  const milestoneIds = Object.keys(frCounts);

  if (milestoneIds.length === 0) {
    return {
      layer: 'L7_fr_distribution',
      status: 'warning',
      detail: 'No milestone FR data found - milestones.md may lack FR references',
    };
  }

  const isLegacyPlan = !readMilestoneValidationMarkers().frDistributionValidated;

  const oversized = [];
  const distribution = {};
  for (const id of milestoneIds) {
    const count = frCounts[id].length;
    distribution[id] = count;
    if (count > FR_HARD_LIMIT) oversized.push({ id, count });
  }

  if (oversized.length > 0) {
    const details = oversized.map((m) => `${m.id}=${m.count} FRs`).join(', ');
    // Legacy plans: Tier 2 (warning + grade degradation) - don't break existing builds
    // New plans: Tier 1 (hard fail) - should never happen if planning gate works
    const status = isLegacyPlan ? 'warning' : 'failed';
    const tierNote = isLegacyPlan
      ? ' (Tier 2: legacy plan - grade degraded, build continues. Re-run /cobolt-plan to enforce FR limits.)'
      : ' (Tier 1: new plan - must split before build.)';
    return {
      layer: 'L7_fr_distribution',
      status,
      distribution,
      oversized: oversized.map((m) => m.id),
      isLegacyPlan,
      hardLimit: FR_HARD_LIMIT,
      target: { min: FR_TARGET_MIN, max: FR_TARGET_MAX },
      detail: `${oversized.length} milestone(s) exceed ${FR_HARD_LIMIT} FR hard limit: ${details}.${tierNote}`,
    };
  }

  return {
    layer: 'L7_fr_distribution',
    status: 'passed',
    distribution,
    isLegacyPlan,
    hardLimit: FR_HARD_LIMIT,
    target: { min: FR_TARGET_MIN, max: FR_TARGET_MAX },
    detail: `All milestones within FR limits (target ${FR_TARGET_MIN}-${FR_TARGET_MAX}, hard limit ${FR_HARD_LIMIT})`,
  };
}

function isModernPlanningVersion(version) {
  return /^0\.(8\.[6-9]|9\.|[1-9]\d)|^[1-9]\d*\./.test(String(version || '').trim());
}

function readMilestoneValidationMarkers() {
  const outputRoot = path.join(process.cwd(), '_cobolt-output');
  const candidates = [
    path.join(outputRoot, 'latest', 'planning', 'milestones.md'),
    path.join(outputRoot, 'planning', 'milestones.md'),
  ];

  try {
    const runsDir = path.join(outputRoot, 'runs');
    if (fs.existsSync(runsDir)) {
      for (const day of fs.readdirSync(runsDir).sort().reverse()) {
        const dayDir = path.join(runsDir, day);
        if (!fs.statSync(dayDir).isDirectory()) continue;
        for (const run of fs.readdirSync(dayDir).sort().reverse()) {
          candidates.push(path.join(dayDir, run, 'planning', 'milestones.md'));
        }
      }
    }
  } catch {
    /* best effort */
  }

  try {
    let frDistributionValidated = false;
    let storyDensityValidated = false;
    let coboltVersion = '';

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      const content = fs.readFileSync(candidate, 'utf8');
      if (!frDistributionValidated && /frDistributionValidated:\s*true/i.test(content)) {
        frDistributionValidated = true;
      }
      if (!storyDensityValidated && /storyDensityValidated:\s*true/i.test(content)) {
        storyDensityValidated = true;
      }
      if (!coboltVersion) {
        const versionMatch = content.match(/coboltVersion:\s*["']?([^\r\n"']+)/i);
        if (versionMatch) coboltVersion = versionMatch[1].trim();
      }
      if (frDistributionValidated && storyDensityValidated && coboltVersion) break;
    }

    return {
      frDistributionValidated: frDistributionValidated || isModernPlanningVersion(coboltVersion),
      storyDensityValidated,
      coboltVersion,
    };
  } catch {
    return {
      frDistributionValidated: false,
      storyDensityValidated: false,
      coboltVersion: '',
    };
  }
}

function validateL7bStoryDensity() {
  let PreflightChecker;
  try {
    ({ PreflightChecker } = require('./cobolt-preflight.js'));
  } catch {
    return {
      layer: 'L7b_story_density',
      status: 'failed',
      detail: 'Could not load cobolt-preflight.js - cannot validate milestone story density',
    };
  }

  const density = new PreflightChecker(process.cwd()).validateMilestoneStoryDensity();
  const isLegacyPlan = !readMilestoneValidationMarkers().storyDensityValidated;

  if (!density.passed) {
    const status = isLegacyPlan ? 'warning' : 'failed';
    const tierNote = isLegacyPlan
      ? ' (Tier 2: legacy plan - grade degraded, build continues. Re-run cobolt plan to enforce story density.)'
      : ' (Tier 1: new plan - split coarse milestones before build.)';
    return {
      layer: 'L7b_story_density',
      status,
      isLegacyPlan,
      failing: density.failing || [],
      warnings: density.warnings || [],
      targets: density.targets || {},
      detail: `${density.message}${tierNote}`,
    };
  }

  if (Array.isArray(density.warnings) && density.warnings.length > 0) {
    return {
      layer: 'L7b_story_density',
      status: 'warning',
      isLegacyPlan,
      failing: [],
      warnings: density.warnings,
      targets: density.targets || {},
      detail: density.message,
    };
  }

  return {
    layer: 'L7b_story_density',
    status: 'passed',
    isLegacyPlan,
    failing: [],
    warnings: [],
    targets: density.targets || {},
    detail: density.message,
  };
}

function validate(milestone, options = {}) {
  const frThreshold = options.frThreshold || VERIFIED_FR_THRESHOLD;
  const jsonOutput = options.json || false;
  const shouldReport = options.report === true || jsonOutput;

  const results = {
    milestone,
    validatedAt: new Date().toISOString(),
    layers: {},
    overallStatus: 'pending',
    failedLayers: [],
    warningLayers: [],
  };

  // Run all validation layers (L1b: milestone test obligations, L2b: illusion detection, L2c: security invariants, L5b: event pairing,
  // L5c: framework bootstrap, L7: FR distribution, L7b: story density)
  const layers = [
    () => validateL1CompileAndTests(),
    () => validateL1bTestObligations(milestone),
    () => validateL2StubDetection(milestone),
    () => validateL2bIllusionDetection(milestone),
    () => validateL2cSecurityInvariants(),
    () => validateL3FRCoverage(milestone, frThreshold),
    () => validateL4RTMIntegrity(milestone),
    () => validateL4bUIIntegrity(),
    () => validateL5RouteHealth(milestone),
    () => validateL5bEventPairing(),
    () => validateL5cFrameworkBootstrap(),
    () => validateL6ReviewerCompleteness(milestone),
    () => validateL7FRDistribution(),
    () => validateL7bStoryDensity(),
  ];

  for (const layerFn of layers) {
    try {
      const result = layerFn();
      results.layers[result.layer] = result;
      if (result.status === 'failed') results.failedLayers.push(result.layer);
      if (result.status === 'warning') results.warningLayers.push(result.layer);
    } catch (error) {
      const name = layerFn.name || 'unknown';
      results.layers[name] = { layer: name, status: 'error', detail: error.message };
      results.failedLayers.push(name);
    }
  }

  results.overallStatus = results.failedLayers.length === 0 ? 'PASS' : 'FAIL';

  try {
    const buildDir = findBuildDir(milestone);
    fs.mkdirSync(buildDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(buildDir, `${milestone}-validation-results.json`), JSON.stringify(results, null, 2), {
      mode: 0o600,
    });
  } catch {
    /* best effort save */
  }

  if (shouldReport && jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
  } else if (shouldReport) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  Milestone Validation Report - ${milestone}`);
    console.log(`${'='.repeat(60)}\n`);

    for (const layer of Object.values(results.layers)) {
      const icon = layer.status === 'passed' ? 'PASS' : layer.status === 'warning' ? 'WARN' : 'FAIL';
      const pad = ' '.repeat(Math.max(0, 30 - layer.layer.length));
      console.log(`  [${icon}] ${layer.layer}${pad}${layer.detail || ''}`);
    }

    console.log(`\n${'-'.repeat(60)}`);
    console.log(`  Overall: ${results.overallStatus}`);
    if (results.failedLayers.length > 0) {
      console.log(`  Failed:  ${results.failedLayers.join(', ')}`);
    }
    if (results.warningLayers.length > 0) {
      console.log(`  Warnings: ${results.warningLayers.join(', ')}`);
    }
    console.log(`${'-'.repeat(60)}\n`);
  }

  return results;
}

function showHelp() {
  console.log(`CoBolt Milestone Validator - deterministic 13-layer validation.

Usage:
  node tools/cobolt-validate-milestone.js --milestone M1 [--fr-threshold 95] [--json]

Layers:
  L1:  Compile + Tests        - cobolt-test.js --strict
  L1b: Test Obligations       - required E2E/integration/database/real-SQL repo coverage
  L2:  Stub + Placeholder     - cobolt-audit.js stub-scan + cobolt-ui-placeholder-check.js
  L2b: Illusion Detection     - cobolt-illusion-scan.js scan (behavioral illusions)
  L3:  FR Coverage            - cobolt-fr-coverage.js check
  L4:  RTM Integrity          - cobolt-rtm.js check --mode mapped
  L4b: UI Integrity           - component-validator + a11y/design/perf linters
  L5:  Route Health + Wiring  - smoke config, nil repositories, and route-wiring-check
  L5b: Event Pairing          - verify publish subjects have matching subscribers (NATS/Kafka/AMQP/Redis)
  L5c: Framework Bootstrap    - verify entry-point files exist for detected frameworks (layout, config, globals)
  L6:  Reviewer Completeness  - verify all expected reviewers produced findings
  L7:  FR Distribution        - enforce milestone FR caps (legacy plans warn, new plans fail)
  L7b: Story Density          - enforce milestone story shape (legacy plans warn, new plans fail)

Options:
  --milestone M1       Milestone to validate (required)
  --fr-threshold 95    Minimum verified FR coverage percentage (default: 95)
  --json               Output as JSON

Exit codes:
  0 = all layers pass (PASS)
  1 = one or more layers failed (FAIL)`);
}

if (require.main === module) {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('help')) {
    showHelp();
    process.exit(0);
  }

  let milestone = null;
  let frThreshold = VERIFIED_FR_THRESHOLD;
  let jsonOutput = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--milestone' && argv[i + 1]) milestone = argv[++i];
    else if (argv[i] === '--fr-threshold' && argv[i + 1]) frThreshold = parseInt(argv[++i], 10);
    else if (argv[i] === '--json') jsonOutput = true;
  }

  if (!milestone) {
    console.error('ERROR: --milestone is required');
    showHelp();
    process.exit(1);
  }

  const results = validate(milestone, { frThreshold, json: jsonOutput, report: true });
  process.exit(results.overallStatus === 'PASS' ? 0 : 1);
}

module.exports = {
  validate,
  parseJson,
  runTool,
  _testOnly: {
    isChildProcessDeniedText,
    runCoboltTestInProcess,
    runFRCoverageInProcess,
    runRTMCheckInProcess,
  },
};
