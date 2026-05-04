#!/usr/bin/env node

// CoBolt Gate Coverage - verify known failure modes map to deterministic controls.

const fs = require('node:fs');
const path = require('node:path');
const { TOOLS } = require('./index');

function readJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function loadGateCoverageMatrix(projectRoot = process.cwd(), explicitPath = null) {
  const candidates = [
    explicitPath,
    path.join(projectRoot, 'cobolt.gate-coverage.json'),
    path.join(projectRoot, 'source', 'templates', 'gate-coverage-matrix.json'),
    path.join(__dirname, '..', 'source', 'templates', 'gate-coverage-matrix.json'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const parsed = readJson(candidate);
    if (Array.isArray(parsed?.failureModes)) return { path: candidate, matrix: parsed };
  }
  return { path: null, matrix: { version: '1.0.0', failureModes: [] } };
}

function controlExists(projectRoot, control) {
  if (TOOLS[control]) return true;
  const toolPath = path.join(projectRoot, 'tools', `cobolt-${control}.js`);
  return fs.existsSync(toolPath);
}

function checkGateCoverage(projectRoot = process.cwd(), options = {}) {
  const { path: matrixPath, matrix } = loadGateCoverageMatrix(projectRoot, options.matrixPath);
  const issues = [];
  const warnings = [];

  for (const mode of matrix.failureModes || []) {
    if (!Array.isArray(mode.controls) || mode.controls.length === 0) {
      issues.push(`${mode.id} has no controls.`);
      continue;
    }
    const missingControls = mode.controls.filter((control) => !controlExists(projectRoot, control));
    if (missingControls.length === mode.controls.length) {
      issues.push(`${mode.id} has no implemented controls. Missing: ${missingControls.join(', ')}`);
    } else if (missingControls.length > 0) {
      warnings.push(`${mode.id} has optional/missing controls: ${missingControls.join(', ')}`);
    }
    for (const testPath of mode.tests || []) {
      if (!fs.existsSync(path.join(projectRoot, testPath))) {
        warnings.push(`${mode.id} references missing test ${testPath}.`);
      }
    }
  }

  return {
    passed: issues.length === 0,
    issues,
    warnings,
    matrixPath,
    summary: {
      failureModes: (matrix.failureModes || []).length,
      issues: issues.length,
      warnings: warnings.length,
    },
  };
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'check';
  const json = argv.includes('--json');
  const matrixIndex = argv.indexOf('--matrix');
  if (command !== 'check') {
    console.error('Usage: node tools/cobolt-gate-coverage.js check [--matrix file] [--json]');
    process.exit(2);
  }
  const report = checkGateCoverage(process.cwd(), {
    matrixPath: matrixIndex !== -1 ? argv[matrixIndex + 1] : null,
  });
  if (json) console.log(JSON.stringify(report, null, 2));
  else if (report.passed) console.log('[cobolt-gate-coverage] Failure-mode gate coverage passed.');
  else for (const issue of report.issues) console.error(`[cobolt-gate-coverage] ${issue}`);
  process.exit(report.passed ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  checkGateCoverage,
  controlExists,
  loadGateCoverageMatrix,
};
