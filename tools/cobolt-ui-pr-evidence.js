#!/usr/bin/env node

// CoBolt UI PR Evidence - require visual/runtime evidence for UI-changing PRs.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const UI_EXTENSIONS = new Set(['.tsx', '.jsx', '.vue', '.svelte', '.astro', '.heex', '.html', '.htm', '.css', '.scss']);
const UI_PATH_PATTERN = /(?:^|\/)(app|assets|components|pages|routes|screens|templates|ui|views|lib\/.*_web)(?:\/|$)/i;

function normalize(filePath) {
  return String(filePath || '').replaceAll('\\', '/');
}

function isUiFile(filePath) {
  const normalized = normalize(filePath);
  return UI_EXTENSIONS.has(path.extname(normalized).toLowerCase()) || UI_PATH_PATTERN.test(normalized);
}

function detectUiChangedFiles(files = []) {
  return files.map(normalize).filter(isUiFile);
}

function gitChangedFiles(projectRoot, baseRef = 'HEAD~1') {
  try {
    const output = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.split(/\r?\n/).filter(Boolean).map(normalize);
  } catch {
    return [];
  }
}

function readJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function defaultEvidencePaths(projectRoot) {
  return [
    path.join(projectRoot, '_cobolt-output', 'latest', 'pr', 'ui-visual-evidence.json'),
    path.join(projectRoot, '_cobolt-output', 'latest', 'uat', 'ui-visual-evidence.json'),
    path.join(projectRoot, '_cobolt-output', 'latest', 'build', 'ui-visual-evidence.json'),
  ];
}

function loadEvidence(projectRoot, explicitPath = null) {
  const candidates = [explicitPath, ...defaultEvidencePaths(projectRoot)].filter(Boolean);
  for (const candidate of candidates) {
    const parsed = readJson(candidate);
    if (parsed) return { path: candidate, evidence: parsed };
  }
  return { path: null, evidence: null };
}

function evidenceHasScreenshots(evidence) {
  const screenshots = evidence?.screenshots || evidence?.visualEvidence?.screenshots || evidence?.artifacts || [];
  return Array.isArray(screenshots) && screenshots.some((item) => String(item.path || item.file || item).length > 0);
}

function evidenceRuntimePassed(evidence) {
  if (evidence?.runtimeCheck?.passed === false) return false;
  if (evidence?.frontendRuntimeCheck?.passed === false) return false;
  if (evidence?.passed === false) return false;
  return true;
}

function checkUiPrEvidence(projectRoot = process.cwd(), options = {}) {
  const changedFiles = options.changedFiles || gitChangedFiles(projectRoot, options.baseRef || 'HEAD~1');
  const uiFiles = detectUiChangedFiles(changedFiles);
  const issues = [];
  const warnings = [];

  if (uiFiles.length === 0) {
    return {
      passed: true,
      skipped: 'no-ui-changes',
      issues,
      warnings,
      changedFiles,
      uiFiles,
    };
  }

  const { path: evidencePath, evidence } = loadEvidence(projectRoot, options.evidencePath);
  if (!evidence) {
    issues.push('UI files changed but no ui-visual-evidence.json was found.');
  } else {
    if (!evidenceHasScreenshots(evidence)) {
      issues.push('UI visual evidence exists but contains no screenshot artifacts.');
    }
    if (!evidenceRuntimePassed(evidence)) {
      issues.push('UI visual evidence indicates frontend/runtime verification failed.');
    }
  }

  return {
    passed: issues.length === 0,
    issues,
    warnings,
    changedFiles,
    uiFiles,
    evidencePath,
  };
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'check';
  const json = argv.includes('--json');
  const evidenceIndex = argv.indexOf('--evidence');
  const filesIndex = argv.indexOf('--files');
  if (command !== 'check') {
    console.error('Usage: node tools/cobolt-ui-pr-evidence.js check [--files a,b] [--evidence file] [--json]');
    process.exit(2);
  }
  const report = checkUiPrEvidence(process.cwd(), {
    evidencePath: evidenceIndex !== -1 ? argv[evidenceIndex + 1] : null,
    changedFiles:
      filesIndex !== -1
        ? String(argv[filesIndex + 1] || '')
            .split(',')
            .filter(Boolean)
        : null,
  });
  if (json) console.log(JSON.stringify(report, null, 2));
  else if (report.passed) console.log('[cobolt-ui-pr-evidence] UI PR evidence passed.');
  else for (const issue of report.issues) console.error(`[cobolt-ui-pr-evidence] ${issue}`);
  process.exit(report.passed ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  checkUiPrEvidence,
  detectUiChangedFiles,
  evidenceHasScreenshots,
  isUiFile,
};
