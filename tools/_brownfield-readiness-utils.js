const fs = require('node:fs');
const path = require('node:path');

const UI_EXTENSIONS = new Set(['.tsx', '.jsx', '.vue', '.svelte', '.heex', '.leex', '.html']);
const UI_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '_cobolt-output',
  '.claude',
  '.codex',
  'dist',
  'build',
  'target',
  '_build',
  'deps',
  'coverage',
]);

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function loadText(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function listIssues(issuesData) {
  if (!issuesData) return [];
  if (Array.isArray(issuesData.issues)) return issuesData.issues;
  if (Array.isArray(issuesData)) return issuesData;
  return Object.values(issuesData).filter((value) => typeof value === 'object' && value && value.priority);
}

const PRIORITY_ORDER = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
  P4: 4,
};

function normalizeIssuePriority(issue) {
  const raw = String(issue?.priority || '')
    .trim()
    .toUpperCase();
  if (PRIORITY_ORDER[raw] !== undefined) return raw;

  const severity = String(issue?.severity || '')
    .trim()
    .toLowerCase();
  if (severity === 'critical') return 'P0';
  if (severity === 'high') return 'P1';
  if (severity === 'medium') return 'P2';
  if (severity === 'low') return 'P3';
  return 'P4';
}

function sortIssuesByPriority(issues) {
  return [...issues]
    .map((issue, index) => ({ issue, index, priority: normalizeIssuePriority(issue) }))
    .sort((left, right) => {
      const delta = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];
      return delta !== 0 ? delta : left.index - right.index;
    })
    .map((entry) => entry.issue);
}

function selectTopIssuesForReverification(issuesData, options = {}) {
  const limit = Math.max(1, Number(options.limit || 5));
  const allowedPriorities = new Set(
    (Array.isArray(options.priorities) && options.priorities.length > 0 ? options.priorities : ['P0', 'P1', 'P2']).map(
      (priority) => String(priority).toUpperCase(),
    ),
  );

  const issues = sortIssuesByPriority(listIssues(issuesData)).filter((issue) => {
    if (!issue?.location?.file) return false;
    return allowedPriorities.has(normalizeIssuePriority(issue));
  });

  if (issues.length > 0) return issues.slice(0, limit);

  return sortIssuesByPriority(listIssues(issuesData))
    .filter((issue) => issue?.location?.file)
    .slice(0, limit);
}

function loadBrownfieldRunContext(bfDir) {
  if (!bfDir) return {};

  const candidates = [
    path.join(bfDir, '00-run-context.json'),
    path.join(bfDir, 'run-context.json'),
    path.join(bfDir, 'progress.json'),
    path.join(bfDir, 'checkpoints', 'brownfield-progress.json'),
  ];

  for (const candidate of candidates) {
    const data = loadJson(candidate);
    if (data && typeof data === 'object') return data;
  }

  return {};
}

function extractAssessmentContext(issuesData, accuracyData, runContextData = null) {
  return {
    ...((runContextData && typeof runContextData === 'object' && runContextData) || {}),
    ...((issuesData && typeof issuesData.meta === 'object' && issuesData.meta) || {}),
    ...((accuracyData && typeof accuracyData.context === 'object' && accuracyData.context) || {}),
  };
}

function extractAssessmentContextForDir(bfDir, issuesData, accuracyData) {
  return extractAssessmentContext(issuesData, accuracyData, loadBrownfieldRunContext(bfDir));
}

function brownfieldModeRequiresForensic(context) {
  const modeValues = [
    context?.modeKey,
    context?.scanLevel,
    context?.scanMode,
    context?.requestedScan,
    context?.brownfieldMode,
  ]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase());

  return modeValues.some((value) =>
    ['deep', 'full', 'analysis-only', 'analysis_only', 'reverse-engineer'].includes(value),
  );
}

function parseBooleanFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return null;

  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(normalized)) return true;
  if (['false', 'no', 'n', '0'].includes(normalized)) return false;
  return null;
}

function detectBrownfieldAssessmentMode(bfDir, issuesData, accuracyData) {
  const accuracy =
    accuracyData ||
    loadJson(path.join(bfDir, 'phase-P3-accuracy-report.json')) ||
    loadJson(path.join(bfDir, 'phase-P3-accuracy.json'));
  const context = extractAssessmentContextForDir(bfDir, issuesData, accuracy);

  const directFlags = [
    context.analysisMode,
    context.assessmentMode,
    context.executionMode,
    context.discoveryMode,
    context.mode,
  ]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase());

  if (directFlags.some((value) => ['main-context', 'main_context', 'orchestrator', 'direct'].includes(value))) {
    return 'main-context';
  }

  const agentDispatchUsed = context.agentDispatch?.used;
  if (agentDispatchUsed === false) return 'main-context';
  if (agentDispatchUsed === true) return 'agent';

  return 'unknown';
}

function isForensicAuditRequired(bfDir, issuesData, accuracyData) {
  const accuracy =
    accuracyData ||
    loadJson(path.join(bfDir, 'phase-P3-accuracy-report.json')) ||
    loadJson(path.join(bfDir, 'phase-P3-accuracy.json'));
  const context = extractAssessmentContextForDir(bfDir, issuesData, accuracy);

  if (brownfieldModeRequiresForensic(context)) return true;
  if (context.forensicAuditRequired === false) return false;
  if (context.forensicAuditRequired === true) return true;

  return detectBrownfieldAssessmentMode(bfDir, issuesData, accuracy) !== 'main-context';
}

function scanForUiSurface(sourceRoot) {
  if (!sourceRoot || !fs.existsSync(sourceRoot)) return false;

  const queue = [sourceRoot];
  let scannedFiles = 0;

  while (queue.length > 0 && scannedFiles < 5000) {
    const currentDir = queue.pop();
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || UI_SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.endsWith('_web')) return true;
        queue.push(entryPath);
        continue;
      }

      if (!entry.isFile()) continue;
      scannedFiles++;

      const ext = path.extname(entry.name).toLowerCase();
      if (UI_EXTENSIONS.has(ext)) return true;
    }
  }

  return false;
}

function detectBrownfieldUiSurface(bfDir, issuesData, accuracyData) {
  const accuracy =
    accuracyData ||
    loadJson(path.join(bfDir, 'phase-P3-accuracy-report.json')) ||
    loadJson(path.join(bfDir, 'phase-P3-accuracy.json'));
  const context = extractAssessmentContextForDir(bfDir, issuesData, accuracy);

  for (const key of ['uiRelevant', 'hasUi', 'requiresUxArtifacts', 'uiSurface']) {
    const parsed = parseBooleanFlag(context[key]);
    if (parsed !== null) return parsed;
  }

  for (const key of ['backendOnly', 'apiOnly', 'headless']) {
    const parsed = parseBooleanFlag(context[key]);
    if (parsed === true) return false;
  }

  const uiPlaceholder = loadJson(path.join(bfDir, 'ui-placeholder-mock-scan.json'));
  if (Array.isArray(uiPlaceholder?.findings) && uiPlaceholder.findings.length > 0) {
    return true;
  }

  const uiCatalogPath = path.join(bfDir, '08-ui-and-workflow-catalog.md');
  if (fs.existsSync(uiCatalogPath) && fs.statSync(uiCatalogPath).size >= 150) {
    return true;
  }

  return scanForUiSurface(detectSourceRoot(bfDir));
}

function getBrownfieldArtifactApplicability(bfDir, issuesData, accuracyData) {
  const accuracy =
    accuracyData ||
    loadJson(path.join(bfDir, 'phase-P3-accuracy-report.json')) ||
    loadJson(path.join(bfDir, 'phase-P3-accuracy.json'));
  const context = extractAssessmentContextForDir(bfDir, issuesData, accuracy);
  const assessmentMode = detectBrownfieldAssessmentMode(bfDir, issuesData, accuracy);
  const forensicAuditRequired = isForensicAuditRequired(bfDir, issuesData, accuracy);
  const uiRelevant = detectBrownfieldUiSurface(bfDir, issuesData, accuracy);
  const modeValues = [
    context?.modeKey,
    context?.scanLevel,
    context?.scanMode,
    context?.requestedScan,
    context?.brownfieldMode,
  ]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase());
  const planningMode = modeValues.some((value) =>
    ['full', 'reverse-engineer', 'add-feature', 'fix-issues', 'continue-plan', 'continue-build'].includes(value),
  );
  const deepPlus =
    planningMode || modeValues.some((value) => ['deep', 'analysis-only', 'analysis_only'].includes(value));

  return {
    assessmentMode,
    forensicAuditRequired,
    uiRelevant,
    planningMode,
    deepPlus,
    context,
    shouldCount(condition) {
      switch (condition) {
        case 'forensicAudit':
          return forensicAuditRequired;
        case 'ui':
          return uiRelevant;
        case 'ui+forensicAudit':
          return forensicAuditRequired && uiRelevant;
        case 'agentDispatch':
          return assessmentMode === 'agent';
        case 'deepPlus':
          return deepPlus;
        case 'planningMode':
          return planningMode;
        default:
          return true;
      }
    },
  };
}

function issueCorpus(issuesData) {
  return listIssues(issuesData)
    .map((issue) =>
      [
        issue.id,
        issue.title,
        issue.description,
        issue.summary,
        issue.details,
        issue.justification,
        issue.rationale,
        issue.location?.file,
        ...(Array.isArray(issue.evidence) ? issue.evidence.map((entry) => JSON.stringify(entry)) : []),
      ]
        .filter(Boolean)
        .join(' '),
    )
    .join('\n')
    .toLowerCase();
}

function stripExtension(filePath) {
  const parsed = path.parse(filePath || '');
  return parsed.name || filePath || '';
}

function findingCoverageKey(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const parsed = path.parse(normalized);
  const base = parsed.name || normalized;
  const parent = path.basename(parsed.dir || '');
  const genericNames = new Set(['index', 'page', 'service', 'handler', 'controller', 'repository', 'repo']);

  if (base && !genericNames.has(base.toLowerCase())) return base;
  if (parent) return parent;
  return stripExtension(path.basename(normalized));
}

function hasProvenanceMetadata(data) {
  return Boolean(
    data &&
      typeof data.sourcePath === 'string' &&
      data.sourcePath &&
      'commitSha' in data &&
      typeof data.inputArtifactsHash === 'string' &&
      data.inputArtifactsHash &&
      typeof data.toolVersion === 'string' &&
      data.toolVersion,
  );
}

function validateDeterministicCoverage(bfDir, issuesData) {
  const corpus = issueCorpus(issuesData);
  const problems = [];
  const artifactChecks = [
    {
      artifact: 'runtime-truth.json',
      label: 'runtime truth',
      extract: () => [],
    },
    {
      artifact: 'domain-liveness.json',
      label: 'domain liveness',
      extract: (data) =>
        (Array.isArray(data?.domains) ? data.domains : [])
          .filter((domain) => domain.status && domain.status !== 'live')
          .map((domain) => ({
            key: String(domain.name || '').toLowerCase(),
            display: String(domain.name || 'unknown-domain'),
          })),
    },
    {
      artifact: 'query-migration-contract.json',
      label: 'query/migration contract',
      extract: (data) =>
        (Array.isArray(data?.violations) ? data.violations : []).map((violation) => ({
          key: String(violation.table || '').toLowerCase(),
          display: String(violation.table || 'unknown-table'),
        })),
    },
    {
      artifact: 'semantic-stub-findings.json',
      label: 'semantic stubs',
      extract: (data) =>
        [
          ...new Set(
            (Array.isArray(data?.findings) ? data.findings : [])
              .map((finding) => findingCoverageKey(finding.file || ''))
              .filter(Boolean),
          ),
        ].map((name) => ({ key: name.toLowerCase(), display: name })),
    },
    {
      artifact: 'ui-placeholder-mock-scan.json',
      label: 'UI placeholders',
      extract: (data) =>
        [
          ...new Set(
            (Array.isArray(data?.findings) ? data.findings : [])
              .map((finding) => findingCoverageKey(finding.file || ''))
              .filter(Boolean),
          ),
        ].map((name) => ({ key: name.toLowerCase(), display: name })),
    },
  ];

  for (const artifactCheck of artifactChecks) {
    const artifactPath = path.join(bfDir, artifactCheck.artifact);
    const data = loadJson(artifactPath);
    if (!data) {
      problems.push(`${artifactCheck.artifact} missing or invalid`);
      continue;
    }

    if (!hasProvenanceMetadata(data)) {
      problems.push(`${artifactCheck.artifact} missing provenance metadata`);
    }

    const uncovered = artifactCheck
      .extract(data)
      .filter((finding) => finding.key && !corpus.includes(finding.key))
      .map((finding) => finding.display);

    if (uncovered.length > 0) {
      problems.push(`${artifactCheck.label} missing from registry: ${uncovered.slice(0, 5).join(', ')}`);
    }
  }

  return {
    pass: problems.length === 0,
    detail:
      problems.length === 0
        ? 'Deterministic verifier artifacts are present and surfaced in the registry'
        : problems.join('; '),
    problems,
  };
}

function validateEvidenceIndex(bfDir) {
  const evidencePath = path.join(bfDir, '19-evidence-index.json');
  const evidence = loadJson(evidencePath);
  if (!evidence) {
    return { pass: false, detail: '19-evidence-index.json not found or invalid JSON', invalidEntries: [] };
  }

  const entries = Array.isArray(evidence.entries) ? evidence.entries : [];
  if (entries.length === 0) {
    return { pass: false, detail: '19-evidence-index.json has no entries', invalidEntries: [] };
  }

  if (evidence.integrity?.valid === false) {
    return { pass: false, detail: '19-evidence-index.json reports invalid integrity', invalidEntries: [] };
  }

  const invalidEntries = entries.filter((entry) => {
    if (!entry.artifact) return true;

    const artifactPath = entry.path && fs.existsSync(entry.path) ? entry.path : path.join(bfDir, entry.artifact);
    if (!fs.existsSync(artifactPath)) return true;

    const actualSize = fs.statSync(artifactPath).size;
    const recordedSizes = [entry.sizeBytes, entry.size].filter((value) => typeof value === 'number');
    if (actualSize <= 0 || recordedSizes.length === 0) return true;

    return recordedSizes.some((size) => size <= 0 || size !== actualSize);
  });

  if (invalidEntries.length > 0) {
    return {
      pass: false,
      detail: `${invalidEntries.length} invalid evidence entr${invalidEntries.length === 1 ? 'y' : 'ies'}`,
      invalidEntries,
    };
  }

  return { pass: true, detail: `${entries.length} evidence entries validated`, invalidEntries: [] };
}

function detectSourceRoot(bfDir) {
  const candidates = [
    path.join(bfDir, 'runtime-truth.json'),
    path.join(bfDir, 'health-score.json'),
    path.join(bfDir, '19-evidence-index.json'),
    path.join(bfDir, 'domain-liveness.json'),
  ];

  for (const candidate of candidates) {
    const data = loadJson(candidate);
    if (typeof data?.sourcePath === 'string' && data.sourcePath) {
      return path.resolve(data.sourcePath);
    }
  }

  const suffix = path.join('_cobolt-output', 'latest', 'brownfield');
  const absolute = path.resolve(bfDir);
  if (absolute.endsWith(suffix)) {
    return path.dirname(path.dirname(path.dirname(absolute)));
  }

  return absolute;
}

function resolveSourceFile(sourceRoot, filePath) {
  if (!filePath) return null;
  if (path.isAbsolute(filePath)) return fs.existsSync(filePath) ? filePath : null;

  const direct = path.join(sourceRoot, filePath);
  if (fs.existsSync(direct)) return direct;

  const normalized = String(filePath).replace(/\\/g, '/');
  const withoutLeadingDot = normalized.replace(/^\.\//, '');
  const alt = path.join(sourceRoot, withoutLeadingDot);
  if (fs.existsSync(alt)) return alt;

  return null;
}

function readLines(filePath) {
  const content = loadText(filePath);
  return content === null ? [] : content.split(/\r?\n/);
}

function extractIssueIds(text) {
  if (!text) return [];
  return [...new Set((text.match(/\b[A-Z]{2,}-\d+\b/g) || []).map((id) => id.trim()))];
}

module.exports = {
  brownfieldModeRequiresForensic,
  detectBrownfieldAssessmentMode,
  detectBrownfieldUiSurface,
  detectSourceRoot,
  extractIssueIds,
  extractAssessmentContext,
  extractAssessmentContextForDir,
  findingCoverageKey,
  getBrownfieldArtifactApplicability,
  hasProvenanceMetadata,
  isForensicAuditRequired,
  issueCorpus,
  listIssues,
  loadJson,
  loadText,
  normalizeIssuePriority,
  readLines,
  resolveSourceFile,
  selectTopIssuesForReverification,
  sortIssuesByPriority,
  validateDeterministicCoverage,
  validateEvidenceIndex,
};
