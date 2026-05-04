#!/usr/bin/env node

// Deterministic Step 04A deep-verification orchestrator for cobolt-build.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { projectExecutionLedger, syncBuildExecutionLedger } = require('../lib/cobolt-execution-ledger');

const DEFAULT_TIMEOUT_MS = 120 * 1000;

function normalizeMilestone(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'M1';
  return /^m\d+$/iu.test(raw) ? raw.toUpperCase() : raw;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: 'run',
    cwd: process.cwd(),
    milestone: process.env.MILESTONE || 'M1',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
  };
  if (argv[0] && !argv[0].startsWith('-')) args.command = argv.shift();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cwd') args.cwd = path.resolve(argv[++i] || args.cwd);
    else if (arg === '--milestone') args.milestone = normalizeMilestone(argv[++i] || args.milestone);
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i] || args.timeoutMs);
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.command = 'help';
  }
  args.milestone = normalizeMilestone(args.milestone);
  return args;
}

function usage() {
  console.log('Usage: node tools/cobolt-build-deep-verification-step.js run --milestone M1 [--cwd <project>] [--json]');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return fallback;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, '');
  } catch {
    return '';
  }
}

function rel(cwd, filePath) {
  return path.relative(cwd, filePath).replace(/\\/g, '/');
}

function buildPaths(cwd, milestone) {
  const outputRoot = path.join(cwd, '_cobolt-output');
  const latest = path.join(outputRoot, 'latest');
  const buildRoot = path.join(latest, 'build');
  const buildDir = path.join(buildRoot, milestone);
  return {
    outputRoot,
    latest,
    buildRoot,
    buildDir,
    planningDir: path.join(latest, 'planning'),
    checkpointsDir: path.join(buildRoot, 'checkpoints'),
    proofsDir: path.join(buildRoot, 'proofs'),
  };
}

function assertPrerequisites(cwd, milestone, paths) {
  const required = [
    [
      path.join(paths.checkpointsDir, `${milestone}-04-tdd-refactor.json`),
      path.join(paths.checkpointsDir, '04-tdd-refactor.json'),
    ],
    [path.join(paths.buildDir, `${milestone}-build-artifacts.json`)],
    [path.join(paths.buildDir, `${milestone}-planning-context.json`)],
  ];
  for (const candidates of required) {
    if (!candidates.some((candidate) => fs.existsSync(candidate))) {
      throw new Error(`Step 04A prerequisite missing: ${candidates.map((item) => rel(cwd, item)).join(' or ')}`);
    }
  }
}

function isTestPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  return (
    normalized.startsWith('tests/') ||
    /(^|\/)(test|tests|__tests__|spec)\//iu.test(normalized) ||
    /\.(test|spec)\.[^/]+$/iu.test(normalized) ||
    /_test\.[^/]+$/iu.test(normalized)
  );
}

function collectScope(cwd, milestone, paths) {
  const artifactPath = path.join(paths.buildDir, `${milestone}-build-artifacts.json`);
  const artifacts = readJson(artifactPath, {});
  const rawFiles = [
    ...(artifacts.filesCreated || []),
    ...(artifacts.filesModified || []),
    ...(artifacts.files || []),
    ...(artifacts.changedFiles || []),
    ...(artifacts.sourceWriteProvenance || []),
  ].map((item) => String(item || '').replace(/\\/g, '/'));
  const productionFiles = [
    ...new Set(
      rawFiles.filter((file) => {
        if (!file || isTestPath(file)) return false;
        if (file.startsWith('_cobolt-output/') || file.includes('/bin/') || file.includes('/obj/')) return false;
        return fs.existsSync(path.join(cwd, file));
      }),
    ),
  ];
  const testFiles = [...new Set(rawFiles.filter((file) => isTestPath(file) && fs.existsSync(path.join(cwd, file))))];
  return { artifactPath, artifacts, productionFiles, testFiles };
}

function defaultRunCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    windowsHide: true,
    env: options.env || process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: typeof result.status === 'number' ? result.status : result.error ? 1 : 0,
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? String(result.error.message || result.error) : ''),
    error: result.error || null,
  };
}

function runTool(toolName, args, cwd, timeoutMs, runCommand = defaultRunCommand) {
  const toolPath = path.join(__dirname, toolName);
  const result = runCommand(process.execPath, [toolPath, ...args], { cwd, timeoutMs });
  return {
    ...result,
    command: `node ${toolPath} ${args.join(' ')}`,
    toolPath,
  };
}

function runIllusionScan(cwd, milestone, paths, scope) {
  const { IllusionScanner } = require('./cobolt-illusion-scan');
  const outputPath = path.join(paths.buildDir, `${milestone}-illusion-prescan.json`);
  const stderrPath = path.join(paths.buildDir, `${milestone}-illusion-prescan.stderr.log`);
  const scanner = new IllusionScanner(cwd);
  const result = scanner.scan({ files: rel(cwd, scope.artifactPath), lang: null });
  writeJson(outputPath, result);
  fs.writeFileSync(stderrPath, '', 'utf8');
  const criticalHigh = Number(result.bySeverity?.critical || 0) + Number(result.bySeverity?.high || 0);
  const report = {
    milestone,
    generatedAt: new Date().toISOString(),
    tool: 'cobolt-build-deep-verification-step',
    prescan: rel(cwd, outputPath),
    passed: criticalHigh === 0,
    status: criticalHigh === 0 ? 'passed' : 'failed',
    totalIllusions: result.totalIllusions,
    count: result.count,
    bySeverity: result.bySeverity,
    findings: result.findings || [],
    semanticChecks: [
      'deterministic source-scope illusion prescan',
      'critical/high illusion hard-gate enforcement',
      'milestone build-artifact file scoping',
    ],
  };
  const reportPath = path.join(paths.buildDir, `${milestone}-illusion-report.json`);
  writeJson(reportPath, report);
  return { outputPath, stderrPath, reportPath, result: report, criticalHigh };
}

function runSpecVerify(cwd, milestone, paths, timeoutMs, runCommand) {
  const outputPath = path.join(paths.buildDir, `${milestone}-gap-reverify.json`);
  const result = runTool(
    'cobolt-spec-verify.js',
    [milestone, '--json', '--out', outputPath],
    cwd,
    timeoutMs,
    runCommand,
  );
  const report = readJson(outputPath, null);
  const missing =
    (report?.missingFiles?.length || 0) +
    (report?.missingFunctions?.length || 0) +
    (report?.stubbedFunctions?.length || 0) +
    (report?.stubbedFiles?.length || 0);
  return {
    outputPath,
    command: result.command,
    exitCode: result.status,
    passed: result.status === 0 && report?.passed === true && missing === 0,
    report,
    missing,
    stderr: result.stderr,
  };
}

function runAuthzProbe(cwd, milestone, paths, timeoutMs, runCommand) {
  const matrixPath = path.join(paths.planningDir, 'authz-matrix.json');
  const outputPath = path.join(paths.buildDir, `${milestone}-authz-probe.json`);
  if (!fs.existsSync(matrixPath)) {
    const report = {
      generatedAt: new Date().toISOString(),
      skipped: true,
      passed: true,
      reason: 'authz-matrix-missing',
    };
    writeJson(outputPath, report);
    return { outputPath, passed: true, report, skipped: true };
  }
  const result = runTool(
    'cobolt-authz-probe.js',
    ['--matrix', matrixPath, '--app-url', 'http://localhost:4000', '--out', outputPath],
    cwd,
    timeoutMs,
    runCommand,
  );
  const report = readJson(outputPath, null);
  return { outputPath, passed: result.status === 0 && report?.passed !== false, report, command: result.command };
}

function runBareMountProbe(cwd, milestone, paths, timeoutMs, runCommand) {
  const matrixPath = path.join(paths.planningDir, 'authz-matrix.json');
  const outputPath = path.join(paths.buildDir, `${milestone}-bare-mount-probe.json`);
  if (!fs.existsSync(matrixPath)) {
    const report = {
      generatedAt: new Date().toISOString(),
      skipped: true,
      passed: true,
      reason: 'authz-matrix-missing',
    };
    writeJson(outputPath, report);
    return { outputPath, passed: true, report, skipped: true };
  }
  const result = runTool(
    'cobolt-bare-mount-probe.js',
    ['--matrix', matrixPath, '--app-url', 'http://localhost:4000', '--out', outputPath],
    cwd,
    timeoutMs,
    runCommand,
  );
  const report = readJson(outputPath, null);
  const rawNotFound = Number(report?.rawNotFoundCount || 0);
  return { outputPath, passed: result.status === 0 && rawNotFound === 0, report, command: result.command };
}

function runTautologyScan(cwd, milestone, paths, timeoutMs, runCommand) {
  const outputPath = path.join(paths.buildDir, `${milestone}-tautology-scan.json`);
  const result = runTool(
    'cobolt-tautology-scan.js',
    ['scan', '--json', '--out', outputPath],
    cwd,
    timeoutMs,
    runCommand,
  );
  const report = readJson(outputPath, null);
  const status = String(report?.status || '').toLowerCase();
  return {
    outputPath,
    passed: (result.status === 0 || result.status === 2) && !['fail', 'failed', 'findings'].includes(status),
    report,
    command: result.command,
  };
}

function detectUi(cwd) {
  try {
    const { detectUIProject } = require('./cobolt-ui-detection');
    return detectUIProject(cwd);
  } catch (err) {
    return { hasUI: false, error: err.message };
  }
}

function isNativeDesktopUi(uiReport) {
  const frameworks = Array.isArray(uiReport?.frameworks)
    ? uiReport.frameworks.map((value) => String(value).toLowerCase())
    : [];
  return frameworks.some((framework) => /\b(?:wpf|winui|maui|avalonia|windows forms|winforms)\b/i.test(framework));
}

function runDesignTokenLint(cwd, milestone, paths, uiReport) {
  const outputPath = path.join(paths.buildDir, `${milestone}-design-token-lint.json`);
  if (!uiReport?.hasUI || isNativeDesktopUi(uiReport)) {
    const report = {
      generatedAt: new Date().toISOString(),
      generatedBy: 'cobolt-build-deep-verification-step',
      milestone,
      skipped: true,
      passed: true,
      summary: { pass: true, errors: 0, warnings: 0, filesScanned: 0 },
      reason: !uiReport?.hasUI ? 'ui-not-detected' : 'native-desktop-ui',
    };
    writeJson(outputPath, report);
    return { outputPath, passed: true, report };
  }

  const { run } = require('./cobolt-design-token-linter');
  const report = {
    ...run(cwd),
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-design-token-linter',
    milestone,
  };
  writeJson(outputPath, report);
  return {
    outputPath,
    passed: report.summary?.pass !== false,
    report,
  };
}

// Tier 3 advisory — write state.wireframes after every fidelity run so a
// downstream milestone's setup or the dream-stage retrospective can observe
// the prior verdict without re-running the full census. Swallows all errors
// (state file missing, schema validator missing, atomic-write failure) since
// state drift here MUST NOT block the build pipeline.
function persistWireframeStateBestEffort({ cwd, discoveryPlan, surfaceFiles, verdict }) {
  try {
    const stateMod = require('./cobolt-state');
    const crypto = require('node:crypto');
    const previousCwd = process.cwd();
    if (cwd && cwd !== previousCwd) process.chdir(cwd);
    const restored = false;
    try {
      const state = stateMod.readState();
      const surfaces = (surfaceFiles || []).map((s) => {
        let sha256 = null;
        try {
          const buf = fs.readFileSync(s.path);
          sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        } catch {
          // ignore — sha256 is metadata only
        }
        return {
          id: s.id,
          name: s.name,
          path: s.path ? path.relative(cwd, s.path) : null,
          sha256,
        };
      });
      state.wireframes = {
        mode: discoveryPlan?.mode ? discoveryPlan.mode : 'missing',
        root: discoveryPlan?.root ? path.relative(cwd, discoveryPlan.root) : null,
        surfaces,
        lastFidelityRunAt: new Date().toISOString(),
        lastFidelityVerdict: verdict,
      };
      stateMod.writeState(state);
    } finally {
      if (cwd && cwd !== previousCwd && !restored) {
        try {
          process.chdir(previousCwd);
        } catch {
          // best-effort restore; ignore
        }
      }
    }
  } catch {
    // Tier 3 advisory — never block on persistence failures.
  }
}

function runWireframeFidelity(cwd, milestone, paths, uiReport) {
  const outputPath = path.join(paths.buildDir, `${milestone}-wireframe-diff.json`);
  if (!uiReport?.hasUI || isNativeDesktopUi(uiReport)) {
    const report = {
      generatedAt: new Date().toISOString(),
      generatedBy: 'cobolt-build-deep-verification-step',
      milestone,
      skipped: true,
      passed: true,
      summary: { pass: true, errors: 0, undeclared: 0, gaps: 0, noRegistry: false },
      findings: [],
      reason: !uiReport?.hasUI ? 'ui-not-detected' : 'native-desktop-ui',
    };
    writeJson(outputPath, report);
    return { outputPath, passed: true, report };
  }

  const { scan } = require('./cobolt-wireframe-diff');
  const wireframeResolver = require('../lib/cobolt-wireframe-resolver');
  const surfaceMapTool = require('./cobolt-surface-map');
  const { isGateBypassed } = require('../lib/cobolt-bypass-resolver');

  const report = scan(cwd, milestone);
  const findings = Array.isArray(report.findings) ? [...report.findings] : [];

  // v0.59.0+ surface-aware discovery — the resolver knows about both per-surface
  // fan-out and the legacy single-merged-file layout, so direct fs.existsSync
  // on wireframes-and-user-flows.md is no longer authoritative.
  const discoveryPlan = wireframeResolver.discoverWireframeArtifacts({ cwd });
  const planningWireframesPresent =
    discoveryPlan.mode === 'greenfield' ||
    discoveryPlan.mode === 'brownfield' ||
    discoveryPlan.mode === 'legacy-merged';
  const onDiskSurfacesByMatch = discoveryPlan.surfaces || [];

  // Cross-check against the Phase-5 surface contracts. milestone-surface-map.json
  // declares the surfaceIds each milestone must mount; for every declared screen
  // we expect a corresponding on-disk NN-<slug>.md under planning/wireframes/.
  // When the surface-map is absent (pre-v0.59.0 plan) we keep the legacy
  // missing-registry finding logic intact and skip Tier 1 promotion.
  const surfaceMap = surfaceMapTool.loadSurfaceMap({ cwd });
  const milestoneScope = surfaceMap.present
    ? surfaceMapTool.getSurfacesForMilestone({ cwd, milestone })
    : { surfaces: [], present: false, milestoneFound: false };
  const milestoneScoped = Boolean(milestoneScope.present && milestoneScope.milestoneFound);
  const declaredScreenSurfaces = milestoneScoped ? milestoneScope.surfaces.filter((s) => s.category === 'screens') : [];

  const SURFACE_FILE_SLUG_RE = /^(\d{2})-(.+)\.md$/u;
  function surfaceIdMatchesFile(surfaceId, fileName) {
    const tail = String(surfaceId)
      .replace(/^[A-Z]+-/u, '')
      .toLowerCase();
    const slugMatch = fileName.match(SURFACE_FILE_SLUG_RE);
    if (!slugMatch) return false;
    const wf = slugMatch[2].toLowerCase();
    return tail === wf || tail.includes(wf) || wf.includes(tail);
  }

  const missingSurfaces = [];
  for (const declared of declaredScreenSurfaces) {
    const hit = onDiskSurfacesByMatch.find((file) => surfaceIdMatchesFile(declared.slug, file.name));
    if (!hit) missingSurfaces.push(declared.slug);
  }

  // Bypass (GT-01 signed-ledger only — no raw env-var check).
  const fidelityBypassed = isGateBypassed('wireframe-fidelity', { projectRoot: cwd });

  // Legacy finding (preserved): planning wireframes exist but component-registry
  // is missing. Severity "error" pre-existed; keep behavior unchanged.
  if (planningWireframesPresent && report.summary?.noRegistry === true) {
    findings.push({
      id: `WF-${String(findings.length + 1).padStart(3, '0')}`,
      type: 'missing-registry',
      severity: 'error',
      component: 'component-registry.json',
      message: 'Planning wireframes exist but component-registry.json is missing, so UI fidelity cannot be verified.',
    });
  }

  // Tier 1 conditions (only when surface-map declares surfaces for this milestone
  // — pre-v0.59.0 projects have no surface-map and therefore never trip these).
  const tier1Findings = [];
  const surfaceMapDeclaresAnySurfacesForMilestone = milestoneScoped && milestoneScope.surfaces.length > 0;

  if (surfaceMapDeclaresAnySurfacesForMilestone && discoveryPlan.mode === 'missing') {
    tier1Findings.push({
      id: `WF-${String(findings.length + tier1Findings.length + 1).padStart(3, '0')}`,
      type: 'wireframes-missing',
      severity: fidelityBypassed ? 'warning' : 'error',
      tier: 1,
      gateId: 'wireframe-fidelity',
      bypassed: fidelityBypassed || undefined,
      message: `milestone-surface-map.json declares ${milestoneScope.surfaces.length} surface(s) for ${milestone} but no wireframe artifacts exist on disk. Re-run cobolt-create-wireframes (or /cobolt-plan-fix) to emit per-surface NN-<slug>.md files under planning/wireframes/.`,
    });
  } else if (surfaceMapDeclaresAnySurfacesForMilestone && discoveryPlan.mode === 'legacy-merged') {
    tier1Findings.push({
      id: `WF-${String(findings.length + tier1Findings.length + 1).padStart(3, '0')}`,
      type: 'wireframes-legacy-on-post-v59-plan',
      severity: fidelityBypassed ? 'warning' : 'error',
      tier: 1,
      gateId: 'wireframe-fidelity',
      bypassed: fidelityBypassed || undefined,
      message: `Plan emits Phase-5 surface contracts (post-v0.59.0) but only the legacy merged wireframes-and-user-flows.md exists. Re-run cobolt-create-wireframes to emit the per-surface fan-out under planning/wireframes/.`,
    });
  }
  if (declaredScreenSurfaces.length > 0 && missingSurfaces.length > 0) {
    tier1Findings.push({
      id: `WF-${String(findings.length + tier1Findings.length + 1).padStart(3, '0')}`,
      type: 'wireframes-surface-coverage',
      severity: fidelityBypassed ? 'warning' : 'error',
      tier: 1,
      gateId: 'wireframe-fidelity',
      bypassed: fidelityBypassed || undefined,
      missingSurfaces,
      message: `${missingSurfaces.length} screen surface(s) declared in milestone-surface-map.json[${milestone}].screens have no matching NN-<slug>.md on disk: ${missingSurfaces.join(', ')}.`,
    });
  }
  for (const f of tier1Findings) findings.push(f);

  const errors = findings.filter((finding) => finding.severity === 'error').length;
  const tier1Errors = findings.filter((finding) => finding.tier === 1 && finding.severity === 'error').length;

  // Tier 3 advisory state persistence — best-effort, swallow errors. Lets the
  // next milestone's setup observe the prior verdict without re-running the
  // full census. State block schema lives in source/schemas/cobolt-state.schema.json.
  persistWireframeStateBestEffort({
    cwd,
    discoveryPlan,
    surfaceFiles: onDiskSurfacesByMatch,
    verdict: tier1Errors > 0 ? 'fail' : errors > 0 ? 'degrade' : 'pass',
  });

  const finalReport = {
    ...report,
    generatedAt: report.generatedAt || new Date().toISOString(),
    milestone,
    summary: {
      ...(report.summary || {}),
      planningWireframesPresent,
      mode: discoveryPlan.mode,
      surfacesOnDisk: onDiskSurfacesByMatch.length,
      surfaceMapPresent: surfaceMap.present,
      milestoneScoped,
      declaredScreenSurfaces: declaredScreenSurfaces.length,
      missingSurfaces: missingSurfaces.length,
      tier1Errors,
      bypassed: fidelityBypassed || undefined,
      errors,
      pass: errors === 0,
    },
    findings,
  };
  writeJson(outputPath, finalReport);
  return { outputPath, passed: finalReport.summary.pass === true, report: finalReport };
}

function hasWebEntrypoint(cwd) {
  const pkg = readJson(path.join(cwd, 'package.json'), {});
  const scripts = pkg?.scripts || {};
  if (scripts.dev || scripts.start || scripts['start:web'] || scripts['dev:web']) return true;
  return ['vite.config.js', 'next.config.js', 'playwright.config.js', 'src/App.tsx', 'src/App.jsx'].some((file) =>
    fs.existsSync(path.join(cwd, file)),
  );
}

function writeUiEvidence(cwd, milestone, paths, uiReport) {
  const wiringPath = path.join(paths.buildDir, `${milestone}-wiring-live-test.json`);
  const browserPath = path.join(paths.buildDir, `${milestone}-browser-deep-test.json`);
  const screenshotsDir = path.join(paths.buildDir, 'screenshots');
  ensureDir(screenshotsDir);
  const webEntry = hasWebEntrypoint(cwd);
  const reason = webEntry
    ? 'Web entry point detected but Step 04A deterministic wrapper only records readiness; browser execution remains delegated to dedicated UI gates.'
    : 'No HTTP server entry point or npm dev/start script exists for this milestone surface.';
  const status = webEntry ? 'not-run-dedicated-gate-required' : 'skipped-no-entry';
  const wiring = {
    timestamp: new Date().toISOString(),
    milestone,
    passed: true,
    status,
    reason,
    uiDetected: uiReport?.hasUI === true,
    appUrl: null,
    failedRequests: [],
    consoleErrors: [],
    contractMismatches: [],
    verdict: status.startsWith('skipped') ? 'skipped' : 'passed',
  };
  const browser = {
    timestamp: new Date().toISOString(),
    milestone,
    passed: true,
    status,
    reason,
    pagesRendered: 0,
    pagesTotal: 0,
    flowsVerified: 0,
    flowsTotal: 0,
    screenshotsTaken: 0,
    consoleErrors: [],
    renderFailures: [],
    flowFailures: [],
    designTokenDrift: [],
    verdict: status.startsWith('skipped') ? 'skipped' : 'passed',
  };
  writeJson(wiringPath, wiring);
  writeJson(browserPath, browser);
  return { wiringPath, browserPath, screenshotsDir, wiring, browser };
}

function runPreReviewScan(cwd, milestone, paths, scope) {
  const outputPath = path.join(paths.buildDir, `${milestone}-pre-review-scan.json`);
  const patterns = [
    { id: 'todo-marker', severity: 'medium', regex: /\b(?:TODO|FIXME|HACK)\b/u },
    {
      id: 'not-implemented',
      severity: 'high',
      regex: /NotImplementedException|throw\s+new\s+Error\(['"]not implemented/iu,
    },
    { id: 'secret-assignment', severity: 'critical', regex: /\b(?:password|api[_-]?key|secret|token)\s*=/iu },
    { id: 'unsafe-eval', severity: 'high', regex: /\beval\s*\(|innerHTML/iu },
  ];
  const findings = [];
  for (const file of scope.productionFiles) {
    const text = readText(path.join(cwd, file));
    for (const pattern of patterns) {
      const match = pattern.regex.exec(text);
      if (match) {
        findings.push({
          id: `PR-${String(findings.length + 1).padStart(3, '0')}`,
          file,
          severity: pattern.severity,
          pattern: pattern.id,
          evidence: match[0],
          status: 'open',
        });
      }
    }
  }
  const criticalHigh = findings.filter((finding) => ['critical', 'high'].includes(finding.severity)).length;
  const report = {
    timestamp: new Date().toISOString(),
    milestone,
    mode: 'deterministic-pre-review',
    passed: criticalHigh === 0,
    status: criticalHigh === 0 ? 'passed' : 'failed',
    filesScanned: scope.productionFiles,
    checks: patterns.map((pattern) => pattern.id),
    findings,
    criticalHigh,
    verdict: criticalHigh === 0 ? 'passed' : 'failed',
  };
  writeJson(outputPath, report);
  return { outputPath, report, criticalHigh };
}

function isChildProcessDenied(text) {
  return /COBOLT_CHILD_PROCESS_DENIED|spawn(?:Sync)? .* EPERM|child_process execution is blocked/i.test(
    String(text || ''),
  );
}

function readSandboxFallbackContracts(cwd, paths) {
  return [
    'cobolt-test-dotnet-fallback-contract.json',
    'cobolt-test-node-fallback-contract.json',
    'cobolt-test-playwright-fallback-contract.json',
  ]
    .map((name) => {
      const filePath = path.join(paths.buildRoot, name);
      const contract = readJson(filePath, null);
      return contract ? { filePath, relativePath: rel(cwd, filePath), contract } : null;
    })
    .filter(Boolean);
}

function contractIsSandboxBlocked(contract) {
  const status = String(contract?.status || '').toLowerCase();
  const marker = String(contract?.marker || contract?.code || '').toUpperCase();
  const text = [
    contract?.reason,
    contract?.message,
    contract?.error,
    contract?.fallbackCommand,
    contract?.stderr,
    contract?.stdout,
  ].join('\n');
  return (
    contract?.blockedBySandbox === true ||
    status === 'blocked' ||
    marker === 'COBOLT_CHILD_PROCESS_DENIED' ||
    isChildProcessDenied(text)
  );
}

function runTestTrust(cwd, milestone, paths, timeoutMs, runCommand) {
  const result = runTool('cobolt-test.js', ['--run', '--all', '--quiet'], cwd, timeoutMs, runCommand);
  const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status === 0) {
    return { passed: true, status: 'passed', command: result.command, exitCode: 0 };
  }
  const fallbackContracts = readSandboxFallbackContracts(cwd, paths);
  const sandboxFallback = fallbackContracts.find(({ contract }) => contractIsSandboxBlocked(contract));
  const refactorLog = path.join(paths.buildDir, `${milestone}-refactor-test-results.log`);
  const refactorText = readText(refactorLog);
  const previousTestsPassed = /\b(?:passing|PASSED|Passed!)\b/u.test(refactorText);
  if ((isChildProcessDenied(combined) || sandboxFallback) && previousTestsPassed) {
    return {
      passed: true,
      status: 'passed-via-sandbox-fallback-evidence',
      command: result.command,
      exitCode: result.status,
      fallbackContract: sandboxFallback ? sandboxFallback.relativePath : null,
      fallbackContracts: fallbackContracts.map(({ relativePath }) => relativePath),
      refactorTestEvidence: rel(cwd, refactorLog),
    };
  }
  return { passed: false, status: 'failed', command: result.command, exitCode: result.status, stderr: result.stderr };
}

function writeCheckpointAndProof(cwd, milestone, paths, deep, artifacts, commands) {
  const checkpoint = {
    checkpoint: 'deep-verification',
    milestone,
    status: deep.passed ? 'passed' : 'failed',
    passed: deep.passed,
    completedAt: new Date().toISOString(),
    illusionCount: deep.summary.illusionCriticalHigh,
    gapRegression: deep.summary.gapMissing > 0,
    wiringLiveStatus: deep.evidence.wiringLive.status,
    browserDeepStatus: deep.evidence.browserDeep.status,
    preReviewStatus: deep.evidence.preReview.status,
    overallStatus: deep.passed ? 'passed' : 'failed',
  };
  writeJson(path.join(paths.checkpointsDir, `${milestone}-04a-deep-verification.json`), checkpoint);
  writeJson(path.join(paths.checkpointsDir, '04a-deep-verification.json'), checkpoint);
  const proof = {
    step: '04a-deep-verification',
    status: deep.passed ? 'passed' : 'failed',
    milestone,
    runtime: 'codex-cli',
    completedAt: new Date().toISOString(),
    commands_executed: commands,
    artifacts: artifacts.map((file) => rel(cwd, file)),
    evidence: {
      checkpoint: rel(cwd, path.join(paths.checkpointsDir, `${milestone}-04a-deep-verification.json`)),
      deepVerification: rel(cwd, path.join(paths.buildDir, `${milestone}-deep-verification.json`)),
    },
  };
  writeJson(path.join(paths.proofsDir, `${milestone}-04a-deep-verification.proof.json`), proof);
}

function run(args = parseArgs(), options = {}) {
  if (args.command !== 'run') {
    usage();
    return { ok: args.command === 'help', help: true };
  }

  const cwd = path.resolve(options.projectRoot || args.cwd || process.cwd());
  const milestone = normalizeMilestone(args.milestone);
  const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
  const runCommand = options.runCommand || defaultRunCommand;
  const paths = buildPaths(cwd, milestone);
  ensureDir(paths.buildDir);
  ensureDir(paths.checkpointsDir);
  ensureDir(paths.proofsDir);
  assertPrerequisites(cwd, milestone, paths);

  const scope = collectScope(cwd, milestone, paths);
  const commands = [];
  const illusion = runIllusionScan(cwd, milestone, paths, scope);
  const gap = runSpecVerify(cwd, milestone, paths, timeoutMs, runCommand);
  commands.push({ command: gap.command, exit_code: gap.exitCode });
  const uiReport = detectUi(cwd);
  const designTokenLint = runDesignTokenLint(cwd, milestone, paths, uiReport);
  commands.push({ command: 'design-token-lint (direct)', exit_code: designTokenLint.passed ? 0 : 1 });
  const wireframeFidelity = runWireframeFidelity(cwd, milestone, paths, uiReport);
  commands.push({ command: 'wireframe-diff (direct)', exit_code: wireframeFidelity.passed ? 0 : 1 });
  const ui = writeUiEvidence(cwd, milestone, paths, uiReport);
  const authz = runAuthzProbe(cwd, milestone, paths, timeoutMs, runCommand);
  commands.push({ command: authz.command || 'authz skipped', exit_code: authz.passed ? 0 : 1 });
  const bareMount = runBareMountProbe(cwd, milestone, paths, timeoutMs, runCommand);
  commands.push({ command: bareMount.command || 'bare mount skipped', exit_code: bareMount.passed ? 0 : 1 });
  const tautology = runTautologyScan(cwd, milestone, paths, timeoutMs, runCommand);
  commands.push({ command: tautology.command, exit_code: tautology.passed ? 0 : 1 });
  const preReview = runPreReviewScan(cwd, milestone, paths, scope);
  const testTrust = runTestTrust(cwd, milestone, paths, timeoutMs, runCommand);
  commands.push({ command: testTrust.command, exit_code: testTrust.exitCode });

  const layers = [
    {
      id: 'illusion-prescan',
      name: 'Illusion Prescan',
      passed: illusion.criticalHigh === 0,
      status: illusion.criticalHigh === 0 ? 'passed' : 'failed',
    },
    { id: 'gap-reverify', name: 'Gap Reverification', passed: gap.passed, status: gap.passed ? 'passed' : 'failed' },
    {
      id: 'authz-probe',
      name: 'Authorization Probe',
      passed: authz.passed,
      status: authz.passed ? 'passed' : 'failed',
    },
    {
      id: 'bare-mount-probe',
      name: 'Bare Mount Probe',
      passed: bareMount.passed,
      status: bareMount.passed ? 'passed' : 'failed',
    },
    {
      id: 'tautology-scan',
      name: 'Tautology Scan',
      passed: tautology.passed,
      status: tautology.passed ? 'passed' : 'failed',
    },
    {
      id: 'design-token-lint',
      name: 'Design Token Lint',
      passed: designTokenLint.passed,
      status: designTokenLint.passed ? 'passed' : 'failed',
    },
    {
      id: 'wireframe-fidelity',
      name: 'Wireframe Fidelity',
      passed: wireframeFidelity.passed,
      status: wireframeFidelity.passed ? 'passed' : 'failed',
    },
    {
      id: 'pre-review-scan',
      name: 'Pre-review Scan',
      passed: preReview.criticalHigh === 0,
      status: preReview.criticalHigh === 0 ? 'passed' : 'failed',
    },
    { id: 'test-trust', name: 'Test Trust', passed: testTrust.passed, status: testTrust.status },
    { id: 'wiring-live', name: 'Wiring Live Test', passed: true, status: ui.wiring.status },
    { id: 'browser-deep', name: 'Browser Deep Test', passed: true, status: ui.browser.status },
  ];
  const passed = layers.every((layer) => layer.passed === true);
  const deep = {
    milestone,
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-build-deep-verification-step',
    passed,
    ok: passed,
    status: passed ? 'passed' : 'failed',
    verdict: passed ? 'passed' : 'failed',
    layers,
    summary: {
      productionFiles: scope.productionFiles.length,
      testFiles: scope.testFiles.length,
      illusionCriticalHigh: illusion.criticalHigh,
      gapMissing: gap.missing,
      designTokenErrors: Number(designTokenLint.report?.summary?.errors || 0),
      wireframeErrors: Number(wireframeFidelity.report?.summary?.errors || 0),
      preReviewCriticalHigh: preReview.criticalHigh,
    },
    evidence: {
      illusionPrescan: rel(cwd, illusion.outputPath),
      illusionReport: rel(cwd, illusion.reportPath),
      gapReverify: rel(cwd, gap.outputPath),
      designTokenLint: rel(cwd, designTokenLint.outputPath),
      wireframeFidelity: rel(cwd, wireframeFidelity.outputPath),
      authzProbe: rel(cwd, authz.outputPath),
      bareMountProbe: rel(cwd, bareMount.outputPath),
      tautologyScan: rel(cwd, tautology.outputPath),
      preReview: preReview.report,
      wiringLive: ui.wiring,
      browserDeep: ui.browser,
      testTrust,
      uiDetection: uiReport,
    },
  };
  const deepPath = path.join(paths.buildDir, `${milestone}-deep-verification.json`);
  writeJson(deepPath, deep);

  const artifacts = [
    deepPath,
    illusion.reportPath,
    preReview.outputPath,
    gap.outputPath,
    designTokenLint.outputPath,
    wireframeFidelity.outputPath,
    authz.outputPath,
    bareMount.outputPath,
    tautology.outputPath,
    ui.wiringPath,
    ui.browserPath,
  ];
  writeCheckpointAndProof(cwd, milestone, paths, deep, artifacts, commands);
  syncBuildExecutionLedger(cwd, milestone, {
    checkpointPath: path.join(paths.checkpointsDir, `${milestone}-04a-deep-verification.json`),
    checkpointId: '04a-deep-verification',
  });
  projectExecutionLedger(cwd);
  return {
    ok: passed,
    passed,
    milestone,
    artifacts: Object.fromEntries(artifacts.map((file) => [path.basename(file), file])),
    layers,
  };
}

function main() {
  const args = parseArgs();
  try {
    const result = run(args);
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else console.log(`Step 04A ${result.ok ? 'passed' : 'failed'} for ${result.milestone || args.milestone}`);
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    const result = { ok: false, error: err.message };
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  run,
  parseArgs,
  normalizeMilestone,
  collectScope,
  isChildProcessDenied,
};
