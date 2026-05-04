#!/usr/bin/env node

// CoBolt Pre-Build Validator — 5 deterministic checks before build starts
//
// V1: Requirement-to-contract coverage (zero orphan tolerance)
// V2: Contract schema completeness (story spec-kit structure)
// V3: Unresolved-material-ambiguity detection
// V4: Unowned write-scope overlap
// V5: Orphaned code/test delta reconciliation (pre-review)
//
// Usage:
//   node tools/cobolt-prebuild-validate.js                    # Run all checks
//   node tools/cobolt-prebuild-validate.js --check v1,v2      # Run specific checks
//   node tools/cobolt-prebuild-validate.js --check all --json # JSON output
//   node tools/cobolt-prebuild-validate.js --check v3 --verbose

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  discoverStoryFiles,
  getPlanningDir,
  getStoryCoverage,
  normalizeStoryId,
} = require('../lib/cobolt-planning-artifacts');
const { readJsonVerified } = require('../lib/cobolt-state-integrity');
const { verifyBrownfieldArtifacts } = require('./cobolt-finding-verifier');
const { isToolOnlyVerificationFailure } = require('./_brownfield-tool-reliability');
const {
  loadJson,
  normalizeIssuePriority,
  readLines,
  resolveSourceFile,
  selectTopIssuesForReverification,
} = require('./_brownfield-readiness-utils');
const { runSpecChecks } = require('./cobolt-spec-quality');

// ── Path resolution ───────────────────────────────────────

function planningDir(root) {
  return getPlanningDir(root, { strict: true, fallbackToLatest: true });
}

function storyFiles(root) {
  const dir = planningDir(root);
  return discoverStoryFiles(root, { planningDir: dir }).map((story) => ({
    storyId: story.storyId,
    name: story.relativePath,
    path: story.path,
  }));
}

function stripComments(content) {
  return content.replace(/<!--[\s\S]*?-->/g, '').replace(/```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)```/g, '$1');
}

function sectionContent(content, headingPattern) {
  const match = content.match(headingPattern);
  if (!match) return null;
  const startIdx = match.index + match[0].length;
  const rest = content.slice(startIdx);
  const nextHeading = rest.match(/^#{1,4}\s+\S/m);
  const sectionText = nextHeading ? rest.slice(0, nextHeading.index) : rest;
  return stripComments(sectionText).trim();
}

// ── V1: Requirement-to-Contract Coverage ──────────────────

function checkRequirementCoverage(root) {
  const result = { check: 'v1', name: 'Requirement-to-Contract Coverage', passed: true, failures: [] };
  const rtmPath = path.join(planningDir(root), 'rtm.json');

  try {
    const { data, integrity } = readJsonVerified(rtmPath);
    if (!data) throw new Error('rtm.json could not be read');
    if (!integrity.valid && integrity.reason?.includes('mismatch'))
      throw new Error(`rtm.json integrity check failed: ${integrity.reason}`);
    const reqs = data.requirements || {};

    for (const [id, req] of Object.entries(reqs)) {
      const issues = [];
      if (!req.epic) issues.push('no epic mapping');
      if (!req.stories || !Array.isArray(req.stories) || req.stories.length === 0) issues.push('no story mapping');
      if (req.status === 'gap' || req.status === 'pending') issues.push(`status: ${req.status}`);

      if (issues.length > 0) {
        result.failures.push({
          id,
          message: `${id} (${req.title || 'untitled'}): ${issues.join(', ')}`,
          severity: req.type === 'functional' ? 'critical' : 'high',
        });
      }
    }
  } catch (err) {
    result.failures.push({
      id: 'rtm.json',
      message: `Cannot read RTM: ${err.message}`,
      severity: 'critical',
    });
  }

  result.passed = result.failures.length === 0;
  return result;
}

// ── V2: Contract Schema Completeness ──────────────────────

const REQUIRED_SECTIONS = [
  {
    name: 'User Story',
    heading: /^#{1,3}\s+User\s+Story/im,
    alternateHeadings: [/^#{1,3}\s+Context/im, /^#{1,3}\s+Overview/im],
    content: /As\s+a\s+\S.{5,}[\s\S]*?I\s+want\s+\S.{5,}/im,
    minChars: 50,
  },
  {
    name: 'Acceptance Criteria',
    heading: /^#{1,3}\s+Acceptance\s+Criteria/im,
    content: /\*?\*?Given\*?\*?\s+\S.{5,}[\s\S]*?\*?\*?When\*?\*?\s+\S.{5,}[\s\S]*?\*?\*?Then\*?\*?\s+\S.{5,}/im,
    minChars: 50,
  },
  {
    name: 'Tasks',
    heading: /^#{1,3}\s+Tasks/im,
    content: /- \[[ x]\]\s+\S.{3,}/im,
    minChars: 30,
  },
  {
    name: 'Architecture Requirements',
    heading: /^#{1,4}\s+Architecture\s+Requirements/im,
    alternateHeadings: [
      /^#{1,4}\s+Integration\s+Points/im,
      /^#{1,4}\s+API\s+Endpoints/im,
      /^#{1,4}\s+Data\s+Structures/im,
    ],
    content: null,
    minChars: 50,
  },
  {
    name: 'Technical Specifications',
    heading: /^#{1,4}\s+Technical\s+Specifications/im,
    alternateHeadings: [
      /^#{1,4}\s+Function\s+Signatures/im,
      /^#{1,4}\s+Data\s+Structures/im,
      /^#{1,4}\s+API\s+Endpoints/im,
      /^#{1,4}\s+Integration\s+Points/im,
    ],
    content: null,
    minChars: 50,
  },
];

const SCAFFOLD_TASK_RE = /\b(?:scaffold|build it|implement service|add tests|wire up|create page)\b/i;
const CONCRETE_TASK_RE =
  /\b(?:src|app|pages|components|api|routes|server|client|tests|migrations|schemas|services)[\\/]|\/[a-z0-9][a-z0-9/_-]*|\.[a-z0-9]{2,5}\b|\b(?:FR|NFR|TR|IR|FEAT)-[A-Z0-9-]+\b/i;

function readStorySpecIndex(dir) {
  if (!dir) return new Map();
  const candidates = [path.join(dir, 'story-specs-index.json'), path.join(dir, 'stories', 'story-specs-index.json')];
  const byStoryId = new Map();
  for (const indexPath of candidates) {
    try {
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      const specs = Array.isArray(index.specs) ? index.specs : [];
      for (const spec of specs) {
        const storyId = normalizeStoryId(spec.storyId || spec.id);
        const rel = spec.path || spec.file || spec.specPath;
        if (!storyId || !rel) continue;
        const resolved = path.isAbsolute(rel) ? rel : path.join(dir, rel);
        if (fs.existsSync(resolved)) byStoryId.set(storyId, resolved);
      }
    } catch {
      /* index absent or unreadable */
    }
  }
  return byStoryId;
}

function storySpecPathFor(planningDirValue, story, specIndex) {
  const storyId = normalizeStoryId(story.storyId);
  if (!storyId) return null;
  const indexed = specIndex.get(storyId);
  if (indexed) return indexed;
  const candidate = path.join(planningDirValue, 'story-specs', `${storyId}-impl-spec.md`);
  return fs.existsSync(candidate) ? candidate : null;
}

function readOptional(filePath) {
  if (!filePath) return '';
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function sectionContentCandidatesFromSources(sources, section) {
  const candidates = [];
  for (const source of sources) {
    const text = sectionContent(source.content, section.heading);
    if (text !== null) candidates.push({ text, primary: true, source: source.name });
  }
  for (const heading of section.alternateHeadings || []) {
    for (const source of sources) {
      const text = sectionContent(source.content, heading);
      if (text !== null) candidates.push({ text, primary: false, source: source.name });
    }
  }
  return candidates;
}

function sectionCandidatePasses(candidate, section) {
  if (candidate.text.length < section.minChars) return false;
  return !section.content || !candidate.primary || section.content.test(candidate.text);
}

function bestSectionCandidate(candidates, section) {
  return (
    candidates.find((candidate) => sectionCandidatePasses(candidate, section)) ||
    candidates.find((candidate) => candidate.primary) ||
    candidates.reduce((best, candidate) => (candidate.text.length > best.text.length ? candidate : best), candidates[0])
  );
}

function checkScaffoldTaskQuality(storyName, content, failures) {
  const tasks = sectionContent(content, /^#{1,3}\s+Tasks(?:\s*\/\s*Subtasks)?/im);
  if (!tasks) return;
  const taskLines = tasks
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\[[ x]\]/i.test(line));

  for (const line of taskLines) {
    if (!SCAFFOLD_TASK_RE.test(line)) continue;
    if (CONCRETE_TASK_RE.test(line)) continue;
    failures.push({
      id: storyName,
      message: `Task is scaffold-quality without concrete file/route/requirement evidence: "${line.slice(0, 160)}"`,
      severity: 'high',
    });
  }
}

function checkContractSchemaCompleteness(root) {
  const result = { check: 'v2', name: 'Contract Schema Completeness', passed: true, failures: [] };
  const dir = planningDir(root);
  const stories = storyFiles(root);
  const coverage = getStoryCoverage(root, { planningDir: dir });
  const specIndex = readStorySpecIndex(dir);

  if (coverage.expectedStoryIds.length > 0 && stories.length === 0) {
    result.failures.push({
      id: 'story-file',
      message: `No story spec-kits found for ${coverage.expectedStoryIds.length} tracked stories`,
      severity: 'critical',
    });
    result.passed = false;
    return result;
  }
  if (stories.length === 0) return result;

  for (const story of stories) {
    let content;
    try {
      content = fs.readFileSync(story.path, 'utf8');
    } catch {
      continue;
    }
    const specPath = storySpecPathFor(dir, story, specIndex);
    const sources = [
      { name: story.name, content },
      {
        name: specPath ? path.relative(dir, specPath).replace(/\\/g, '/') : 'story-spec',
        content: readOptional(specPath),
      },
    ];

    for (const sec of REQUIRED_SECTIONS) {
      const candidates = sectionContentCandidatesFromSources(sources, sec);
      if (candidates.length === 0) {
        result.failures.push({
          id: story.name,
          message: `Missing section: ${sec.name}`,
          severity: 'critical',
        });
        continue;
      }
      const { text, primary } = bestSectionCandidate(candidates, sec);
      if (text.length < sec.minChars) {
        result.failures.push({
          id: story.name,
          message: `${sec.name}: ${text.length} chars < ${sec.minChars} minimum (likely template stub)`,
          severity: 'high',
        });
        continue;
      }
      if (sec.content && primary && !sec.content.test(text)) {
        result.failures.push({
          id: story.name,
          message: `${sec.name}: missing required content pattern (e.g., Given/When/Then for AC)`,
          severity: 'high',
        });
      }
    }
    checkScaffoldTaskQuality(story.name, content, result.failures);
  }

  const specQuality = runSpecChecks(root, {});
  if (specQuality.status === 'fail') {
    for (const finding of specQuality.findings || []) {
      result.failures.push({
        id: finding.spec || finding.section || finding.class || 'story-spec-quality',
        message: `Story spec quality gate failed: ${finding.message}`,
        severity: finding.severity === 'critical' ? 'critical' : 'high',
      });
    }
  }

  result.passed = result.failures.filter((f) => f.severity === 'critical' || f.severity === 'high').length === 0;
  return result;
}

// ── V3: Unresolved-Material-Ambiguity Detection ───────────

const AMBIGUITY_RE =
  /\b(?:TBD|TODO|TBC|FIXME)\b|(?:to\s+be\s+determined|to\s+be\s+confirmed|to\s+be\s+decided|needs?\s+clarification|needs?\s+discussion|unclear|not\s+yet\s+defined|not\s+yet\s+decided)|\[\?\]|\bPLACEHOLDER\b/gi;

const CRITICAL_PLANNING_FILES = new Set([
  'prd.md',
  'architecture.md',
  'data-model-spec.md',
  'api-contracts.md',
  'system-architecture.md',
  'security-requirements.md',
]);

function checkUnresolvedAmbiguity(root) {
  const result = { check: 'v3', name: 'Unresolved-Material-Ambiguity Detection', passed: true, failures: [] };
  const dir = planningDir(root);
  const stories = storyFiles(root);

  // Scan story files (critical severity)
  for (const story of stories) {
    scanFileForAmbiguity(story.path, story.name, 'critical', result.failures);
  }

  // Scan critical planning files (high severity)
  for (const fname of CRITICAL_PLANNING_FILES) {
    const fpath = path.join(dir, fname);
    if (fs.existsSync(fpath)) {
      scanFileForAmbiguity(fpath, fname, 'high', result.failures);
    }
  }

  // Scan other planning files (medium = warn only, doesn't block)
  try {
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      if (CRITICAL_PLANNING_FILES.has(f)) continue;
      if (/^\d+-\d+-/.test(f)) continue; // Already scanned as story
      const fpath = path.join(dir, f);
      scanFileForAmbiguity(fpath, f, 'medium', result.failures);
    }
  } catch {
    /* dir may not exist */
  }

  result.passed = result.failures.filter((f) => f.severity === 'critical' || f.severity === 'high').length === 0;
  return result;
}

function scanFileForAmbiguity(filePath, fileName, severity, failures) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const content = stripComments(raw);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      AMBIGUITY_RE.lastIndex = 0;
      const match = AMBIGUITY_RE.exec(line);
      if (match) {
        const ctx = line.substring(Math.max(0, match.index - 20), match.index + match[0].length + 20).trim();
        failures.push({
          id: `${fileName}:${i + 1}`,
          message: `"${match[0]}" found: ...${ctx}...`,
          severity,
        });
      }
    }
  } catch {
    /* file unreadable */
  }
}

// ── V4: Unowned Write-Scope Overlap ───────────────────────

const FILE_PATH_RE =
  /(?:^|\s|`)((?:src|lib|app|tests?|config|public|assets|components|pages|routes|api|db|migrations?|schemas?|types?|utils?|hooks?|services?|controllers?|models?|views?|internal|cmd|pkg)\/\S+\.\w{1,10})/gm;
const FILE_LIST_TABLE_RE = /^\|\s*(?:create|modify|delete|update|add|remove|rename)\s*\|\s*`?(\S+?)`?\s*\|/gim;

function extractFilePaths(content) {
  const paths = new Set();

  // From File Structure / File List sections
  FILE_PATH_RE.lastIndex = 0;
  let m;
  while ((m = FILE_PATH_RE.exec(content)) !== null) {
    paths.add(m[1].replace(/^\.\//, '').replace(/\\/g, '/').toLowerCase());
  }

  FILE_LIST_TABLE_RE.lastIndex = 0;
  while ((m = FILE_LIST_TABLE_RE.exec(content)) !== null) {
    paths.add(m[1].replace(/^\.\//, '').replace(/\\/g, '/').toLowerCase());
  }

  return [...paths];
}

function checkWriteScopeOverlap(root) {
  const result = { check: 'v4', name: 'Unowned Write-Scope Overlap', passed: true, failures: [] };
  const stories = storyFiles(root);
  const fileMap = new Map(); // filePath → Set<storyId>

  for (const story of stories) {
    try {
      const content = fs.readFileSync(story.path, 'utf8');
      const paths = extractFilePaths(content);
      for (const p of paths) {
        if (!fileMap.has(p)) fileMap.set(p, new Set());
        fileMap.get(p).add(story.name);
      }
    } catch {
      /* skip unreadable */
    }
  }

  for (const [filePath, storySet] of fileMap) {
    if (storySet.size > 1) {
      result.failures.push({
        id: filePath,
        message: `Claimed by ${storySet.size} stories: ${[...storySet].join(', ')}`,
        severity: 'critical',
      });
    }
  }

  result.passed = result.failures.length === 0;
  return result;
}

// ── V5: Orphaned Code/Test Delta Reconciliation ───────────

function getChangedFiles(root) {
  try {
    const output = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD~20'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    try {
      const output = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}

function isSourceFile(f) {
  const skip = /^(_cobolt-output|node_modules|\.git|\.claude|vendor|dist|build)\//;
  return !skip.test(f) && /\.\w{1,10}$/.test(f);
}

function testToSourcePath(testPath) {
  return testPath
    .replace(/^tests?\//, 'src/')
    .replace(/\.test\.(ts|js|tsx|jsx)$/, '.$1')
    .replace(/\.spec\.(ts|js|tsx|jsx)$/, '.$1')
    .replace(/_test\.go$/, '.go')
    .replace(/_test\.exs$/, '.ex')
    .replace(/\/test\//, '/lib/') // Elixir: app/test/foo → app/lib/foo
    .replace(/^test\//, 'lib/'); // Elixir: test/foo → lib/foo
}

function checkOrphanReconciliation(root) {
  const result = { check: 'v5', name: 'Orphaned Code/Test Delta Reconciliation', passed: true, failures: [] };

  const changedFiles = getChangedFiles(root).filter(isSourceFile);
  if (changedFiles.length === 0) return result; // No changes = pass

  // Build story file-list registry
  const stories = storyFiles(root);
  const trackedFiles = new Set();
  for (const story of stories) {
    try {
      const content = fs.readFileSync(story.path, 'utf8');
      for (const p of extractFilePaths(content)) trackedFiles.add(p);
    } catch {
      /* skip */
    }
  }

  // Check for untracked changed files
  for (const f of changedFiles) {
    const normalized = f.replace(/\\/g, '/').toLowerCase();
    if (!trackedFiles.has(normalized)) {
      result.failures.push({
        id: f,
        message: `Changed file not tracked in any story's File List`,
        severity: 'medium', // warn, don't block — files may be indirect deps
      });
    }
  }

  // Check test-to-source mapping
  const testPatterns = /\.(test|spec)\.(ts|js|tsx|jsx)$|_test\.(go|exs)$|^test\//;
  for (const f of changedFiles) {
    if (testPatterns.test(f)) {
      const sourcePath = testToSourcePath(f);
      if (!fs.existsSync(path.join(root, sourcePath))) {
        result.failures.push({
          id: f,
          message: `Test file has no corresponding source file at ${sourcePath}`,
          severity: 'high',
        });
      }
    }
  }

  result.passed = result.failures.filter((f) => f.severity === 'critical' || f.severity === 'high').length === 0;
  return result;
}

function checkBrownfieldIssueReverification(root) {
  const result = {
    check: 'v6',
    name: 'Brownfield High-Priority Issue Re-Verification',
    passed: true,
    failures: [],
    warnings: [],
  };
  const brownfieldDir = path.join(root, '_cobolt-output', 'latest', 'brownfield');
  const issuesPath = path.join(brownfieldDir, '16-issues-registry.json');

  if (!fs.existsSync(issuesPath)) return result;

  const issuesData = loadJson(issuesPath);
  if (!issuesData) {
    result.failures.push({
      id: '16-issues-registry.json',
      message: 'Brownfield issues registry exists but is invalid JSON',
      severity: 'critical',
    });
    result.passed = false;
    return result;
  }

  const candidateIssues = selectTopIssuesForReverification(issuesData, { limit: 5, priorities: ['P0', 'P1', 'P2'] });
  if (candidateIssues.length === 0) return result;

  const verificationPath = path.join(brownfieldDir, '16-issues-registry-verification.json');
  let verification = loadJson(verificationPath);
  const candidateIds = candidateIssues.map((issue) => String(issue.id || '').trim()).filter(Boolean);
  const verificationResults = Array.isArray(verification?.results) ? verification.results : [];
  const needsRefresh =
    !verification ||
    !Array.isArray(verification.results) ||
    candidateIds.some((issueId) => !verificationResults.some((entry) => entry.id === issueId));
  if (needsRefresh) {
    verifyBrownfieldArtifacts({ brownfieldDir, projectRoot: root });
    verification = loadJson(verificationPath);
  }

  if (!verification || !Array.isArray(verification.results)) {
    result.failures.push({
      id: '16-issues-registry-verification.json',
      message: 'Brownfield issue verification report is missing or incomplete',
      severity: 'critical',
    });
    result.passed = false;
    return result;
  }

  const resultById = new Map(verification.results.map((entry) => [String(entry.id || '').trim(), entry]));

  for (const issue of candidateIssues) {
    const issueId = String(issue.id || '').trim();
    const verificationEntry = resultById.get(issueId);
    const status = verificationEntry?.status || 'missing';

    if (status !== 'verified') {
      if (isToolOnlyVerificationFailure(verificationEntry) && issueHasValidSourceLocation(root, issue)) {
        const detail =
          verificationEntry?.flags?.slice(0, 2).join(', ') || 'verifier confidence warning with valid source location';
        result.warnings.push({
          id: issueId || issue.location?.file || 'unknown-issue',
          message: `${status} during build re-verification, but source location is valid (${detail})`,
          severity: 'medium',
        });
        continue;
      }

      const detail =
        verificationEntry?.flags?.slice(0, 2).join(', ') || 'issue could not be re-verified against source';
      result.failures.push({
        id: issueId || issue.location?.file || 'unknown-issue',
        message: `${status} during build re-verification (${detail})`,
        severity: normalizeIssuePriority(issue) === 'P2' ? 'high' : 'critical',
      });
    }
  }

  result.passed = result.failures.length === 0;
  return result;
}

function issueHasValidSourceLocation(root, issue) {
  const file = issue?.location?.file;
  const line = Number(issue?.location?.line || 0);
  if (!file) return false;

  const resolved = resolveSourceFile(root, file);
  if (!resolved) return false;
  if (!Number.isFinite(line) || line <= 0) return true;

  const lines = readLines(resolved);
  return lines.length > 0 && line <= lines.length;
}

// ── Runner ────────────────────────────────────────────────

const CHECK_MAP = {
  v1: checkRequirementCoverage,
  v2: checkContractSchemaCompleteness,
  v3: checkUnresolvedAmbiguity,
  v4: checkWriteScopeOverlap,
  v5: checkOrphanReconciliation,
  v6: checkBrownfieldIssueReverification,
};

function runChecks(root, checks) {
  const results = [];
  for (const check of checks) {
    const fn = CHECK_MAP[check];
    if (fn) results.push(fn(root));
  }
  const overallPassed = results.every((r) => r.passed);
  return { timestamp: new Date().toISOString(), results, overallPassed };
}

// ── Output ────────────────────────────────────────────────

function writeArtifact(root, report) {
  const outDir = path.join(root, '_cobolt-output', 'latest', 'build');
  try {
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  } catch {
    /* noop */
  }
  const outPath = path.join(outDir, 'prebuild-validation.json');
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return outPath;
}

function printHuman(report, verbose) {
  console.log('\n  CoBolt Pre-Build Validation\n');
  for (const r of report.results) {
    const icon = r.passed ? '\u2713' : '\u2717';
    console.log(
      `  ${icon} ${r.check}: ${r.name} — ${r.passed ? 'PASS' : `FAIL (${r.failures.length} issue${r.failures.length === 1 ? '' : 's'})`}`,
    );
    if (!r.passed || verbose) {
      const show = verbose ? r.failures : r.failures.filter((f) => f.severity === 'critical' || f.severity === 'high');
      for (const f of show.slice(0, 20)) {
        console.log(`      [${f.severity.toUpperCase()}] ${f.id}: ${f.message}`);
      }
      if (show.length > 20) console.log(`      ... and ${show.length - 20} more`);
    }
  }
  console.log(`\n  VERDICT: ${report.overallPassed ? 'PASS' : 'FAIL'}\n`);
}

// ── CLI ───────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const checkIdx = args.indexOf('--check');
  const checksArg = checkIdx >= 0 && args[checkIdx + 1] ? args[checkIdx + 1] : 'all';
  const checks = checksArg === 'all' ? Object.keys(CHECK_MAP) : checksArg.split(',');
  const jsonMode = args.includes('--json');
  const verbose = args.includes('--verbose');
  const save = args.includes('--save') || !jsonMode;
  const rootIdx = args.indexOf('--root');
  const root = rootIdx >= 0 && args[rootIdx + 1] ? args[rootIdx + 1] : process.cwd();

  if (args.includes('--help') || args.includes('-h')) {
    console.log('CoBolt Pre-Build Validator — 5 deterministic checks\n');
    console.log('Usage:');
    console.log(
      '  node tools/cobolt-prebuild-validate.js [--check v1,v2,v3,v4,v5,v6|all] [--json] [--verbose] [--save]',
    );
    console.log('\nChecks:');
    console.log('  v1  Requirement-to-contract coverage (zero orphan tolerance)');
    console.log('  v2  Contract schema completeness (story spec-kit structure)');
    console.log('  v3  Unresolved-material-ambiguity detection');
    console.log('  v4  Unowned write-scope overlap');
    console.log('  v5  Orphaned code/test delta reconciliation');
    console.log('  v6  Brownfield high-priority issue re-verification');
    process.exit(0);
  }

  const report = runChecks(root, checks);
  if (save) writeArtifact(root, report);
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report, verbose);
  }
  process.exit(report.overallPassed ? 0 : 1);
}

module.exports = {
  runChecks,
  checkRequirementCoverage,
  checkContractSchemaCompleteness,
  checkUnresolvedAmbiguity,
  checkWriteScopeOverlap,
  checkOrphanReconciliation,
  checkBrownfieldIssueReverification,
  CHECK_MAP,
};
