#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { getPlanningDir } = require('../lib/cobolt-planning-artifacts');
const { detectUIProject } = require('./cobolt-ui-detection');
const { run: runDesignChecklist } = require('./cobolt-design-checklist');

const REPORT_FILE = 'frontend-completeness-report.json';
const UI_SOURCE_STOP_WORDS = new Set([
  'frontend',
  'design',
  'screen',
  'screens',
  'page',
  'pages',
  'flow',
  'flows',
  'state',
  'states',
  'user',
  'users',
  'system',
  'feature',
  'features',
  'requirement',
  'requirements',
  'document',
  'documents',
  'project',
  'product',
  'spec',
  'specification',
  'mobile',
  'web',
  'admin',
]);

function planningDir(projectRoot) {
  return getPlanningDir(projectRoot || process.cwd(), { strict: true, fallbackToLatest: true });
}

function readJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function readText(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function artifactStatus(filePath, minBytes = 80) {
  try {
    const stat = fs.statSync(filePath);
    return { exists: stat.size >= minBytes, size: stat.size, path: filePath };
  } catch {
    return { exists: false, size: 0, path: filePath };
  }
}

function normalizeTerm(term) {
  return String(term || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function collectUiSourceTerms(sourceIndex) {
  const documents = Array.isArray(sourceIndex?.documents) ? sourceIndex.documents : [];
  const terms = [];

  for (const document of documents) {
    const isUiDoc =
      document.documentType === 'ux' ||
      (document.tags || []).some((tag) => ['frontend', 'web', 'mobile', 'admin'].includes(tag));
    if (!isUiDoc) continue;
    for (const hint of document.keywordHints || []) {
      const normalized = normalizeTerm(hint);
      if (!normalized || normalized.length < 4 || UI_SOURCE_STOP_WORDS.has(normalized)) continue;
      terms.push(normalized);
    }
  }

  return [...new Set(terms)].slice(0, 12);
}

function countScreens(uxTracker, specText) {
  const trackerScreens = Array.isArray(uxTracker?.screens) ? uxTracker.screens.length : 0;
  const trackerSurfaces = Array.isArray(uxTracker?.surfaces) ? uxTracker.surfaces.length : 0;
  const headingScreens = [
    ...String(specText || '').matchAll(/^#{2,4}\s+.*(?:screen|page|view|modal|dashboard|flow)/gim),
  ].length;
  return Math.max(trackerScreens, trackerSurfaces, headingScreens);
}

function uxTrackerDeclaresNonUi(uxTracker) {
  if (!uxTracker || typeof uxTracker !== 'object') return false;
  if (!String(uxTracker.nonUiRationale || '').trim()) return false;

  const screenCount = Array.isArray(uxTracker.screens) ? uxTracker.screens.length : 0;
  const surfaceCount = Array.isArray(uxTracker.surfaces) ? uxTracker.surfaces.length : 0;
  if (screenCount > 0 || surfaceCount > 0) return false;

  const featureCoverage = Array.isArray(uxTracker.featureCoverage) ? uxTracker.featureCoverage : [];
  if (featureCoverage.length === 0) return true;

  return featureCoverage.every(
    (entry) =>
      String(entry?.status || '')
        .trim()
        .toLowerCase() === 'not_applicable',
  );
}

function run(projectRoot = process.cwd(), options = {}) {
  const root = path.resolve(projectRoot);
  const planningRoot = options.planningDir || planningDir(root);
  const writeReport = options.writeReport !== false;

  if (!planningRoot) {
    return {
      generatedAt: new Date().toISOString(),
      passed: false,
      skipped: false,
      score: 0,
      issues: ['No planning directory found.'],
      findings: [],
    };
  }

  const specPath = path.join(planningRoot, 'ux-design-specification.md');
  const wireframesPath = path.join(planningRoot, 'wireframes-and-user-flows.md');
  const uxTrackerPath = path.join(planningRoot, 'ux-tracker.json');
  const sourceIndexPath = path.join(planningRoot, 'source-index.json');

  const uiDetection = detectUIProject(root);
  const sourceIndex = readJson(sourceIndexPath);
  const uxTracker = readJson(uxTrackerPath);
  const sourceUiDocs = (sourceIndex?.documents || []).filter(
    (document) =>
      document.documentType === 'ux' ||
      (document.tags || []).some((tag) => ['frontend', 'web', 'mobile', 'admin'].includes(tag)),
  );
  const nonUiTracker = uxTrackerDeclaresNonUi(uxTracker);
  const uiDetectionSignals = new Set(uiDetection.signals || []);
  const hasStrongUiSignals =
    uiDetectionSignals.has('state.hasUI') ||
    uiDetectionSignals.has('playwright-config') ||
    uiDetectionSignals.has('task-manifest-ui-files') ||
    uiDetectionSignals.has('ui-source-files') ||
    uiDetectionSignals.has('ui-framework');
  const artifactUiSignals = fs.existsSync(specPath) || fs.existsSync(wireframesPath) || fs.existsSync(uxTrackerPath);
  const uiRequired =
    nonUiTracker && !hasStrongUiSignals && sourceUiDocs.length === 0
      ? false
      : hasStrongUiSignals || sourceUiDocs.length > 0 || artifactUiSignals;

  if (!uiRequired) {
    const result = {
      generatedAt: new Date().toISOString(),
      projectRoot: root,
      planningDir: planningRoot,
      uiRequired: false,
      passed: true,
      skipped: true,
      score: 10,
      findings: [
        nonUiTracker
          ? 'Frontend completeness skipped because ux-tracker.json declares the project non-UI.'
          : 'Frontend completeness skipped because no UI planning signals were detected.',
      ],
      issues: [],
      artifacts: {},
    };
    if (writeReport) {
      fs.writeFileSync(path.join(planningRoot, REPORT_FILE), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    }
    return result;
  }

  const specStatus = artifactStatus(specPath, 300);
  const wireframesStatus = artifactStatus(wireframesPath, 150);
  const specText = readText(specPath);
  const designChecklist = runDesignChecklist(root, { spec: specPath });
  const screenCount = countScreens(uxTracker, specText);
  const normalizedSpecText = normalizeTerm(specText);
  const expectedUiTerms = collectUiSourceTerms(sourceIndex);
  const missingUiTerms = expectedUiTerms.filter((term) => !normalizedSpecText.includes(term));

  const findings = [
    `UI required: yes (${[...new Set([...uiDetection.signals, ...(sourceUiDocs.length > 0 ? ['source-ui-docs'] : [])])].join(', ') || 'planning artifacts'})`,
    `UX spec present: ${specStatus.exists ? 'yes' : 'no'}`,
    `Wireframes present: ${wireframesStatus.exists ? 'yes' : 'no'}`,
    `Screen inventory count: ${screenCount}`,
  ];
  const issues = [];
  let score = 10;

  if (!specStatus.exists) {
    issues.push('UX design specification is missing or too small for a UI-planned project.');
    score -= 4;
  }

  if (designChecklist.summary?.errors > 0) {
    issues.push(`UX design checklist has ${designChecklist.summary.errors} blocking section gap(s).`);
    score -= 2;
  }

  const criticalStateWarnings = (designChecklist.findings || []).filter(
    (finding) => finding.id === 'DESIGN003' && /(loading|empty|error|disabled|success)/i.test(finding.message),
  );
  if (criticalStateWarnings.length > 0) {
    issues.push(`UX state matrix is missing ${criticalStateWarnings.length} critical UI state definition(s).`);
    score -= 1.5;
  }

  if (screenCount === 0) {
    issues.push('No screen inventory was found in ux-tracker.json or UX design headings.');
    score -= 2;
  }

  if (!wireframesStatus.exists && !/user flow|navigation|route|journey|step/i.test(specText)) {
    issues.push('No wireframes/user flows artifact or equivalent navigation flow description was found.');
    score -= 1.5;
  }

  if (!/responsive|breakpoint|mobile|tablet|desktop/i.test(specText)) {
    issues.push('Responsive behavior is not described in the UX spec.');
    score -= 1;
  }

  if (!/accessibility|wcag|keyboard|screen reader|focus/i.test(specText)) {
    issues.push('Accessibility expectations are not described in the UX spec.');
    score -= 1;
  }

  if (!/loading|empty|error|disabled|success/i.test(specText)) {
    issues.push('UI states such as loading, empty, error, disabled, or success are missing from the UX spec.');
    score -= 1;
  }

  if (missingUiTerms.length > 0) {
    findings.push(`UI source terms missing from UX spec: ${missingUiTerms.join(', ')}`);
    if (missingUiTerms.length >= Math.max(2, Math.ceil(expectedUiTerms.length / 2))) {
      issues.push('Source-driven UI concepts are not sufficiently represented in UX artifacts.');
      score -= 1.5;
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    projectRoot: root,
    planningDir: planningRoot,
    uiRequired: true,
    passed: issues.length === 0,
    skipped: false,
    score: Math.max(0, Math.round(score * 10) / 10),
    findings,
    issues,
    checklist: {
      errors: designChecklist.summary?.errors || 0,
      warnings: designChecklist.summary?.warnings || 0,
    },
    sourceCoverage: {
      expectedUiTerms,
      missingUiTerms,
    },
    artifacts: {
      spec: specStatus,
      wireframes: wireframesStatus,
      uxTracker: artifactStatus(uxTrackerPath, 40),
      sourceIndex: artifactStatus(sourceIndexPath, 40),
    },
  };

  if (writeReport) {
    fs.writeFileSync(path.join(planningRoot, REPORT_FILE), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  return result;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const result = run(process.cwd());

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.passed ? 0 : 1);
  }

  console.log('[cobolt-frontend-completeness] Frontend completeness report');
  console.log(`  UI required: ${result.uiRequired ? 'yes' : 'no'}`);
  console.log(`  Score: ${result.score}/10`);
  for (const finding of result.findings || []) {
    console.log(`  - ${finding}`);
  }
  for (const issue of result.issues || []) {
    console.log(`  [ISSUE] ${issue}`);
  }
  process.exit(result.passed ? 0 : 1);
}

module.exports = {
  REPORT_FILE,
  run,
};
