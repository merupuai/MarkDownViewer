#!/usr/bin/env node

// CoBolt Brownfield Handoff - Deterministic modernization-handoff.json builder
//
// Builds 21-modernization-handoff.json from assessment scores, artifact paths,
// and issue counts. Replaces P3 Step 3.7 LLM synthesis.
//
// Usage:
//   node tools/cobolt-brownfield-handoff.js build [--dir <path>]
//   node tools/cobolt-brownfield-handoff.js build --json
//
// Exit codes:
//   0 = handoff ready
//   1 = insufficient data

const fs = require('node:fs');
const path = require('node:path');
const { buildBrownfieldSemanticDrift } = require('./cobolt-brownfield-semantic-drift');
const { checkGate } = require('./cobolt-brownfield-readiness-gate');
const { assessPlanningContract } = require('./cobolt-brownfield-planning-sync');

const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

function brownfieldDir() {
  const p = typeof _paths === 'function' ? _paths() : null;
  if (p) return path.join(p.outputRoot, 'latest', 'brownfield');
  return path.join(process.cwd(), '_cobolt-output/latest/brownfield');
}

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function fileExists(fp) {
  return fs.existsSync(fp) ? { exists: true, size: fs.statSync(fp).size } : { exists: false, size: 0 };
}

function milestoneNumber(value) {
  if (value === null || value === undefined) return null;
  const match = String(value).match(/M?(\d+)/i);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function addMilestones(target, values) {
  if (!values) return;
  const source = Array.isArray(values) ? values : [values];
  for (const value of source) {
    const candidate = typeof value === 'object' ? value?.id || value?.milestone : value;
    const num = milestoneNumber(candidate);
    if (num) target.add(num);
  }
}

function parseMilestonesFromMarkdown(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return [...content.matchAll(/^##\s+(?:Milestone\s+)?M(\d+)\b/gm)]
      .map((match) => parseInt(match[1], 10))
      .filter((num) => Number.isFinite(num) && num > 0);
  } catch {
    return [];
  }
}

function parseMilestonesFromTracker(filePath) {
  const data = loadJson(filePath);
  const milestones = Array.isArray(data?.milestones) ? data.milestones : [];
  return milestones
    .map((entry) => milestoneNumber(entry?.id || entry?.milestone))
    .filter((num) => Number.isFinite(num) && num > 0);
}

function collectCompletedMilestones(projectRoot) {
  const completed = new Set();
  const state = loadJson(path.join(projectRoot, 'cobolt-state.json'));
  addMilestones(
    completed,
    state?.milestones?.filter((entry) => String(entry?.status || '').toLowerCase() === 'completed'),
  );
  addMilestones(
    completed,
    state?.pipeline?.milestones?.filter((entry) => String(entry?.status || '').toLowerCase() === 'completed'),
  );

  try {
    const reportsDir = path.join(projectRoot, '_cobolt-output', 'reports');
    for (const entry of fs.readdirSync(reportsDir)) {
      const num = milestoneNumber(entry);
      if (num) completed.add(num);
    }
  } catch {
    /* ignore */
  }

  return [...completed].sort((a, b) => a - b);
}

function detectProjectRoot(bfDir) {
  const absolute = path.resolve(bfDir);
  const parts = absolute.split(path.sep);
  if (parts.length >= 3) {
    const tail = parts.slice(-3);
    if (tail[0] === '_cobolt-output' && tail[1] === 'latest' && tail[2] === 'brownfield') {
      return path.dirname(path.dirname(path.dirname(absolute)));
    }
  }

  return absolute;
}

function detectNextBuildMilestone(bfDir) {
  const planned = new Set();
  const projectRoot = detectProjectRoot(bfDir);
  const state = loadJson(path.join(projectRoot, 'cobolt-state.json'));

  addMilestones(planned, state?.milestones);
  addMilestones(planned, state?.pipeline?.milestones);
  addMilestones(planned, parseMilestonesFromMarkdown(path.join(bfDir, '35-modernization-milestones.md')));
  addMilestones(planned, parseMilestonesFromMarkdown(path.join(bfDir, '35-milestones.md')));
  addMilestones(planned, parseMilestonesFromTracker(path.join(bfDir, '40-modernization-milestone-tracker.json')));
  addMilestones(planned, parseMilestonesFromTracker(path.join(bfDir, '22-modernization-milestone-tracker.json')));

  const sortedPlanned = [...planned].sort((a, b) => a - b);
  if (sortedPlanned.length > 0) {
    const completed = new Set(collectCompletedMilestones(projectRoot));
    const firstUnbuilt = sortedPlanned.find((num) => !completed.has(num));
    return `M${firstUnbuilt || sortedPlanned[0]}`;
  }

  const completed = collectCompletedMilestones(projectRoot);
  if (completed.length > 0) {
    return `M${completed[completed.length - 1]}`;
  }

  return 'M1';
}

function buildHandoff(bfDir) {
  // Load health score
  const healthScore = loadJson(path.join(bfDir, 'health-score.json'));
  // Load issues registry
  const issues = loadJson(path.join(bfDir, '16-issues-registry.json'));
  // Load evidence index
  const evidence = loadJson(path.join(bfDir, '19-evidence-index.json'));

  // Count issues by priority
  const issueSummary = { total: 0, byPriority: { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 } };
  if (issues && Array.isArray(issues.issues)) {
    issueSummary.total = issues.issues.length;
    for (const issue of issues.issues) {
      const prio = (issue.priority || 'P4').toUpperCase();
      if (issueSummary.byPriority[prio] !== undefined) issueSummary.byPriority[prio]++;
    }
  } else if (issues && typeof issues === 'object') {
    // Alternative structure: issues might be keyed by ID
    const entries = Object.values(issues).filter((v) => typeof v === 'object' && v.priority);
    issueSummary.total = entries.length;
    for (const e of entries) {
      const prio = (e.priority || 'P4').toUpperCase();
      if (issueSummary.byPriority[prio] !== undefined) issueSummary.byPriority[prio]++;
    }
  }

  // Check required Phase 4 inputs
  const requiredInputs = {
    masterAssessment: fileExists(path.join(bfDir, '23-master-assessment.md')),
    issuesRegistry: fileExists(path.join(bfDir, '16-issues-registry.json')),
    featureInventory: fileExists(path.join(bfDir, '04-feature-and-module-inventory.md')),
    projectContext: fileExists(path.join(bfDir, '03-project-context.md')),
    enhancementAdvisory: fileExists(path.join(bfDir, '17-enhancement-advisory.md')),
  };

  // Optional inputs that enrich Phase 4-6
  const optionalInputs = {
    architectureRecovery: fileExists(path.join(bfDir, '13-architecture-recovery.md')),
    businessRules: fileExists(path.join(bfDir, '14-business-rules-and-validation.md')),
    featureTriage: fileExists(path.join(bfDir, '15-feature-triage-matrix.md')),
    modernizationRoadmap: fileExists(path.join(bfDir, '18-modernization-roadmap.md')),
    databaseReport: fileExists(path.join(bfDir, '05-database-and-data-store-report.md')),
    integrationMap: fileExists(path.join(bfDir, '06-integration-map.md')),
    securityAssessment: fileExists(path.join(bfDir, '12-security-and-quality-assessment.md')),
  };

  const requiredReady = Object.values(requiredInputs).filter((v) => v.exists).length;
  const requiredTotal = Object.keys(requiredInputs).length;
  const gateResult = checkGate(bfDir, false);
  const deliveryReady = requiredReady === requiredTotal && gateResult.passed;
  const semanticDrift = buildBrownfieldSemanticDrift(bfDir, {
    projectRoot: detectProjectRoot(bfDir),
  });

  const handoff = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-brownfield-handoff',

    assessmentOutcome: {
      healthScore: healthScore ? healthScore.healthScore : null,
      healthGrade: healthScore ? healthScore.grade : null,
      verdict: healthScore ? healthScore.verdict : null,
      issueSummary,
    },

    deliveryReadiness: {
      ready: deliveryReady,
      requiredInputsPresent: requiredReady,
      requiredInputsTotal: requiredTotal,
      gatePassed: gateResult.passed,
      gateChecks: gateResult.checks,
      requiredInputs,
      optionalInputs,
    },

    phaseCompletionStatus: {
      P0: fileExists(path.join(bfDir, '01-intake-and-classification.md')).exists,
      P1: fileExists(path.join(bfDir, '04-feature-and-module-inventory.md')).exists,
      P2: fileExists(path.join(bfDir, '14-business-rules-and-validation.md')).exists,
      P3: fileExists(path.join(bfDir, '23-master-assessment.md')).exists,
    },

    artifactCompleteness: evidence ? evidence.completeness : 0,
    semanticDrift: {
      status: semanticDrift.fidelity.status,
      enhancementCount: semanticDrift.fidelity.qualitySummary.enhancementCount,
      advisoryDetectors: semanticDrift.fidelity.qualitySummary.detectors.advisory,
      failDetectors: semanticDrift.fidelity.qualitySummary.detectors.fail,
    },
    blockersForPhase4:
      issueSummary.byPriority.P0 > 0
        ? `${issueSummary.byPriority.P0} P0 issues must be addressed before proceeding`
        : !gateResult.passed
          ? 'Brownfield readiness gate failed'
          : null,
  };

  return handoff;
}

function checkContinueStatus(bfDir) {
  // Check phase completion by artifact presence
  const phases = {
    P0:
      fileExists(path.join(bfDir, '01-intake-and-classification.md')).exists &&
      fileExists(path.join(bfDir, '02-baseline-health-and-scan-summary.md')).exists,
    P1: fileExists(path.join(bfDir, '04-feature-and-module-inventory.md')).exists,
    P2: fileExists(path.join(bfDir, '14-business-rules-and-validation.md')).exists,
    P3: fileExists(path.join(bfDir, '23-master-assessment.md')).exists,
    P4: fileExists(path.join(bfDir, '24-modernization-prd.md')).exists,
    P5:
      fileExists(path.join(bfDir, '27-modernization-system-architecture.md')).exists ||
      fileExists(path.join(bfDir, '27-system-architecture.md')).exists,
    P6:
      fileExists(path.join(bfDir, '35-modernization-milestones.md')).exists ||
      fileExists(path.join(bfDir, '35-milestones.md')).exists,
  };

  // Minimum for --continue: P0 + P1 + P3 (default scan produces these)
  const gateResult = checkGate(bfDir, false);
  const canContinue = phases.P0 && phases.P1 && phases.P3 && gateResult.passed;

  // Planning is only "done" when the brownfield packet exists AND the canonical
  // planning contract required by build/review is present on disk.
  const planningPacketDone = phases.P4 && phases.P5 && phases.P6;
  // Status checks use the same planning quality gate as build/review so "ready" never means preflight-only.
  const planningContract = assessPlanningContract(detectProjectRoot(bfDir));
  const planningDone = planningPacketDone && planningContract.buildReady;
  const nextBuildMilestone = detectNextBuildMilestone(bfDir);

  // Load health score for display
  const healthScore = loadJson(path.join(bfDir, 'health-score.json'));
  const issues = loadJson(path.join(bfDir, '16-issues-registry.json'));
  const issueCount =
    issues && Array.isArray(issues.issues)
      ? issues.issues.length
      : issues && typeof issues === 'object'
        ? Object.values(issues).filter((v) => typeof v === 'object' && v.priority).length
        : 0;

  return {
    ready: canContinue,
    planningDone,
    planningPacketDone,
    phasesComplete: phases,
    gatePassed: gateResult.passed,
    healthGrade: healthScore ? healthScore.grade : null,
    healthScore: healthScore ? healthScore.healthScore : null,
    issueCount,
    artifactDir: bfDir,
    nextBuildMilestone,
    planningContract,
    suggestion: planningDone
      ? `Planning already complete. Run cobolt-build ${nextBuildMilestone} --auto --autonomous to start building.`
      : planningPacketDone
        ? 'Modernization packet exists, but canonical planning artifacts are incomplete. Run cobolt-brownfield --continue-plan or node tools/cobolt-brownfield-planning-sync.js sync before build.'
        : canContinue
          ? 'Assessment complete. Ready for --continue-plan or --continue-build.'
          : gateResult.passed
            ? 'Assessment incomplete. Run cobolt-brownfield first.'
            : 'Assessment incomplete or failed readiness gate. Re-run brownfield remediation checks first.',
  };
}

// -- CLI -----------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'build') {
    const dirIdx = args.indexOf('--dir');
    const bfDir = dirIdx !== -1 && args[dirIdx + 1] ? path.resolve(args[dirIdx + 1]) : brownfieldDir();
    const jsonMode = args.includes('--json');

    const handoff = buildHandoff(bfDir);

    if (jsonMode) {
      console.log(JSON.stringify(handoff, null, 2));
    } else {
      console.log('[cobolt-brownfield-handoff] Modernization Handoff');
      console.log(
        `  Health: ${handoff.assessmentOutcome.healthScore || 'N/A'} (${handoff.assessmentOutcome.healthGrade || 'N/A'})`,
      );
      console.log(`  Verdict: ${handoff.assessmentOutcome.verdict || 'N/A'}`);
      console.log(
        `  Issues: ${handoff.assessmentOutcome.issueSummary.total} (P0: ${handoff.assessmentOutcome.issueSummary.byPriority.P0}, P1: ${handoff.assessmentOutcome.issueSummary.byPriority.P1})`,
      );
      console.log(
        `  Required inputs: ${handoff.deliveryReadiness.requiredInputsPresent}/${handoff.deliveryReadiness.requiredInputsTotal}`,
      );
      console.log(`  Delivery ready: ${handoff.deliveryReadiness.ready ? 'YES' : 'NO'}`);
      if (handoff.blockersForPhase4) console.log(`  BLOCKER: ${handoff.blockersForPhase4}`);
    }

    // Write
    const outPath = path.join(bfDir, '21-modernization-handoff.json');
    const outDir = path.dirname(outPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(handoff, null, 2)}\n`, 'utf8');
    if (!jsonMode) console.log(`  Written: ${outPath}`);

    process.exit(handoff.deliveryReadiness.ready ? 0 : 1);
  } else if (cmd === 'check') {
    const dirIdx = args.indexOf('--dir');
    const bfDir = dirIdx !== -1 && args[dirIdx + 1] ? path.resolve(args[dirIdx + 1]) : brownfieldDir();
    const jsonMode = args.includes('--json');
    const result = checkContinueStatus(bfDir);

    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('[cobolt-brownfield-handoff] Continue Readiness Check');
      console.log(`  Assessment ready: ${result.ready ? 'YES' : 'NO'}`);
      console.log(`  Planning done: ${result.planningDone ? 'YES' : 'NO'}`);
      console.log(`  Health: ${result.healthScore || 'N/A'} (${result.healthGrade || 'N/A'})`);
      console.log(`  Issues: ${result.issueCount}`);
      console.log(
        `  Phases: P0=${result.phasesComplete.P0} P1=${result.phasesComplete.P1} P2=${result.phasesComplete.P2} P3=${result.phasesComplete.P3} P4=${result.phasesComplete.P4} P5=${result.phasesComplete.P5} P6=${result.phasesComplete.P6}`,
      );
      console.log(`  ${result.suggestion}`);
    }

    process.exit(result.ready ? 0 : 1);
  } else {
    console.log('CoBolt Brownfield Handoff - Deterministic modernization handoff builder');
    console.log('');
    console.log('Usage:');
    console.log('  node tools/cobolt-brownfield-handoff.js build [--dir <path>] [--json]');
    console.log('  node tools/cobolt-brownfield-handoff.js check [--dir <path>] [--json]');
    console.log('');
    console.log('Commands:');
    console.log('  build   Build 21-modernization-handoff.json from assessment artifacts');
    console.log('  check   Check if assessment is ready for --continue (P0+P1+P3 required)');
    process.exit(cmd ? 2 : 0);
  }
}

module.exports = { buildHandoff, checkContinueStatus };
