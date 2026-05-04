#!/usr/bin/env node

// CoBolt Brownfield Readiness Gate — Deterministic P3→P4 gate check
//
// Verifies all prerequisites for Phase 4 (Target-State Design):
//   - Master assessment exists (>= 2000 bytes)
//   - Issues registry exists (>= 100 bytes)
//   - Health grade >= D (score >= 50)
//   - Zero P0 issues (or explicit override)
//   - Core artifacts, runtime truth, P3 accuracy, evidence integrity, forensic audit,
//     and deterministic verifier coverage
//
// Usage:
//   node tools/cobolt-brownfield-readiness-gate.js check [--dir <path>]
//   node tools/cobolt-brownfield-readiness-gate.js check --json
//   node tools/cobolt-brownfield-readiness-gate.js check --allow-p0   # Override P0 block
//
// Exit codes:
//   0 = gate PASS (safe to proceed to Phase 4)
//   1 = gate FAIL (must fix issues first)
//   2 = usage error

const fs = require('node:fs');
const path = require('node:path');
const { buildAccuracyReport } = require('./cobolt-brownfield-accuracy-review');
const { emitBrownfieldContracts, validateBrownfieldContracts } = require('./cobolt-brownfield-contracts');
const { loadOrBuildToolReliabilityReport } = require('./_brownfield-tool-reliability');
const {
  detectBrownfieldAssessmentMode,
  isForensicAuditRequired,
  loadJson,
  validateDeterministicCoverage,
  validateEvidenceIndex,
} = require('./_brownfield-readiness-utils');

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

function checkGate(bfDir, allowP0) {
  const checks = [];
  let allPass = true;

  // Check 1: Master assessment exists and meets minimum size
  const masterPath = path.join(bfDir, '23-master-assessment.md');
  if (!fs.existsSync(masterPath)) {
    checks.push({ id: 'G1', name: 'Master Assessment', pass: false, detail: 'File not found' });
    allPass = false;
  } else {
    const size = fs.statSync(masterPath).size;
    const pass = size >= 2000;
    checks.push({ id: 'G1', name: 'Master Assessment', pass, detail: `${size} bytes (min 2000)` });
    if (!pass) allPass = false;
  }

  // Check 2: Issues registry exists and meets minimum size
  const issuesPath = path.join(bfDir, '16-issues-registry.json');
  if (!fs.existsSync(issuesPath)) {
    checks.push({ id: 'G2', name: 'Issues Registry', pass: false, detail: 'File not found' });
    allPass = false;
  } else {
    const size = fs.statSync(issuesPath).size;
    const pass = size >= 100;
    checks.push({ id: 'G2', name: 'Issues Registry', pass, detail: `${size} bytes (min 100)` });
    if (!pass) allPass = false;
  }

  // Check 3: Health grade >= D (score >= 50)
  const healthPath = path.join(bfDir, 'health-score.json');
  const healthData = loadJson(healthPath);
  if (!healthData) {
    // Try computing on the fly
    checks.push({
      id: 'G3',
      name: 'Health Grade',
      pass: false,
      detail: 'health-score.json not found. Run: node tools/cobolt-brownfield-health-score.js compute',
    });
    allPass = false;
  } else {
    const score = healthData.healthScore || 0;
    const grade = healthData.grade || 'F';
    const pass = score >= 50;
    checks.push({ id: 'G3', name: 'Health Grade', pass, detail: `Grade ${grade} (score ${score}, min 50)` });
    if (!pass) allPass = false;
  }

  // Check 4: Zero P0 (critical) issues
  const issuesData = loadJson(issuesPath);
  let p0Count = 0;
  if (issuesData) {
    const items = Array.isArray(issuesData.issues)
      ? issuesData.issues
      : Array.isArray(issuesData)
        ? issuesData
        : Object.values(issuesData).filter((v) => typeof v === 'object' && v.priority);

    p0Count = items.filter((i) => (i.priority || '').toUpperCase() === 'P0').length;
  }
  const p0Pass = p0Count === 0 || allowP0;
  checks.push({
    id: 'G4',
    name: 'Zero P0 Issues',
    pass: p0Pass,
    detail: p0Count === 0 ? 'No P0 issues' : `${p0Count} P0 issues${allowP0 ? ' (override active)' : ''}`,
  });
  if (!p0Pass) allPass = false;

  // Check 5: Minimum artifact coverage (at least P0 + P1 core artifacts)
  const coreArtifacts = [
    '01-intake-and-classification.md',
    '02-baseline-health-and-scan-summary.md',
    '04-feature-and-module-inventory.md',
    '12-security-and-quality-assessment.md',
  ];
  const corePresent = coreArtifacts.filter((a) => fs.existsSync(path.join(bfDir, a))).length;
  const corePct = Math.round((corePresent / coreArtifacts.length) * 100);
  const corePass = corePresent >= 3; // Allow 1 missing
  checks.push({
    id: 'G5',
    name: 'Core Artifacts',
    pass: corePass,
    detail: `${corePresent}/${coreArtifacts.length} present (${corePct}%)`,
  });
  if (!corePass) allPass = false;

  // Check 6: Runtime truth must exist and pass
  const runtimeTruth = loadJson(path.join(bfDir, 'runtime-truth.json'));
  const runtimePass =
    !!runtimeTruth &&
    (((runtimeTruth.summary?.executed || 0) > 0 &&
      runtimeTruth.passed !== false &&
      (runtimeTruth.summary?.failed || 0) === 0) ||
      runtimeTruth.status === 'unsupported');
  checks.push({
    id: 'G6',
    name: 'Runtime Truth',
    pass: runtimePass,
    detail: runtimeTruth
      ? runtimeTruth.status === 'unsupported'
        ? runtimeTruth.reason || 'Unsupported stack; runtime proof skipped'
        : `${runtimeTruth.summary?.executed || 0} commands executed`
      : 'runtime-truth.json missing',
  });
  if (!runtimePass) allPass = false;

  // Check 7: Accuracy review must exist and pass
  let accuracy = loadJson(path.join(bfDir, 'phase-P3-accuracy-report.json'));
  if (!accuracy) {
    try {
      accuracy = buildAccuracyReport(bfDir);
    } catch {
      accuracy = null;
    }
  }
  const accuracyPass = !!accuracy && accuracy.passed !== false;
  checks.push({
    id: 'G7',
    name: 'P3 Accuracy Report',
    pass: accuracyPass,
    detail: accuracy
      ? `status=${accuracy.passed === false ? 'failed' : 'passed'} (${accuracy.generatedBy || 'precomputed'})`
      : 'phase-P3-accuracy-report.json missing',
  });
  if (!accuracyPass) allPass = false;

  // Check 8: Evidence index integrity
  const evidenceCheck = validateEvidenceIndex(bfDir);
  checks.push({ id: 'G8', name: 'Evidence Index Integrity', pass: evidenceCheck.pass, detail: evidenceCheck.detail });
  if (!evidenceCheck.pass) allPass = false;

  // Check 9: Forensic audit is required only for agent-based assessments.
  const issuesDataForMode = issuesData || loadJson(issuesPath);
  const forensicRequired = isForensicAuditRequired(bfDir, issuesDataForMode, accuracy);
  const assessmentMode = detectBrownfieldAssessmentMode(bfDir, issuesDataForMode, accuracy);
  const forensicPath = path.join(bfDir, '16d-forensic-audit-report.md');
  if (!forensicRequired) {
    checks.push({
      id: 'G9',
      name: 'Forensic Audit',
      pass: true,
      detail: `Optional in ${assessmentMode} mode; readiness does not require P2.5 artifacts`,
    });
  } else if (!fs.existsSync(forensicPath)) {
    checks.push({ id: 'G9', name: 'Forensic Audit', pass: false, detail: 'File not found' });
    allPass = false;
  } else {
    const size = fs.statSync(forensicPath).size;
    const pass = size >= 500;
    checks.push({ id: 'G9', name: 'Forensic Audit', pass, detail: `${size} bytes (min 500)` });
    if (!pass) allPass = false;
  }

  // Check 10: deterministic verifier artifacts must exist, carry provenance, and be surfaced in the registry
  const deterministicCoverage = validateDeterministicCoverage(bfDir, issuesData);
  checks.push({
    id: 'G10',
    name: 'Deterministic Finding Coverage',
    pass: deterministicCoverage.pass,
    detail: deterministicCoverage.detail,
  });
  if (!deterministicCoverage.pass) allPass = false;

  // Check 11: tool verdict reliability distinguishes source truth from noisy tool outputs
  const toolReliability = loadOrBuildToolReliabilityReport(bfDir, { refresh: true, write: true });
  const toolReliabilityPass = toolReliability.status !== 'fail';
  checks.push({
    id: 'G11',
    name: 'Tool Verdict Reliability',
    pass: toolReliabilityPass,
    detail: `status=${toolReliability.status}, trust=${toolReliability.trustScore ?? 'n/a'}/100, degraded=${toolReliability.degradedArtifacts.length}, blocking=${toolReliability.summary.blockingFailures}`,
  });
  if (!toolReliabilityPass) allPass = false;

  // Check 12: assessment contract layer must exist and validate.
  // The P3 gate validates only assessment-scope contracts; planning/full
  // readiness is enforced later by the brownfield-to-build handoff contract.
  let contracts;
  try {
    emitBrownfieldContracts(bfDir);
    contracts = validateBrownfieldContracts(bfDir, { scope: 'assessment', write: true });
  } catch (err) {
    contracts = {
      ok: false,
      blockers: [{ detail: String(err?.message || err) }],
    };
  }
  checks.push({
    id: 'G12',
    name: 'Brownfield Assessment Contracts',
    pass: contracts.ok === true,
    detail:
      contracts.ok === true
        ? `scope=assessment, contracts=${contracts.requiredContracts.length}`
        : (contracts.blockers || [])
            .slice(0, 3)
            .map((blocker) => blocker.detail)
            .join('; ') || 'contract validation failed',
  });
  if (contracts.ok !== true) allPass = false;

  return {
    passed: allPass,
    checks,
    context: {
      analysisMode: detectBrownfieldAssessmentMode(bfDir, issuesData || loadJson(issuesPath), accuracy),
      forensicAuditRequired: isForensicAuditRequired(bfDir, issuesData || loadJson(issuesPath), accuracy),
      toolReliability: {
        status: toolReliability.status,
        trustScore: toolReliability.trustScore,
        degradedArtifacts: toolReliability.degradedArtifacts,
        blockingFailures: toolReliability.blockingFailures,
      },
    },
    timestamp: new Date().toISOString(),
    generatedBy: 'cobolt-brownfield-readiness-gate',
  };
}

// ── CLI ─────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'check') {
    const dirIdx = args.indexOf('--dir');
    const bfDir = dirIdx !== -1 && args[dirIdx + 1] ? args[dirIdx + 1] : brownfieldDir();
    const jsonMode = args.includes('--json');
    const allowP0 = args.includes('--allow-p0');

    const result = checkGate(bfDir, allowP0);

    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('[cobolt-brownfield-readiness-gate] P3→P4 Readiness Gate');
      console.log('');
      for (const c of result.checks) {
        const icon = c.pass ? 'PASS' : 'FAIL';
        console.log(`  [${icon}] ${c.id} ${c.name}: ${c.detail}`);
      }
      console.log('');
      console.log(
        `  Verdict: ${result.passed ? 'GATE PASS — proceed to Phase 4' : 'GATE FAIL — fix issues before proceeding'}`,
      );
    }

    process.exit(result.passed ? 0 : 1);
  } else {
    console.log('CoBolt Brownfield Readiness Gate — P3→P4 deterministic gate check');
    console.log('');
    console.log('Usage:');
    console.log('  node tools/cobolt-brownfield-readiness-gate.js check [--dir <path>] [--json] [--allow-p0]');
    console.log('');
    console.log(
      'Checks: Master assessment, Issues registry, Health grade, P0 issues, Core artifacts, runtime truth, accuracy report, evidence integrity, forensic audit, deterministic verifier coverage, tool verdict reliability',
    );
    process.exit(cmd ? 2 : 0);
  }
}

module.exports = { checkGate };
