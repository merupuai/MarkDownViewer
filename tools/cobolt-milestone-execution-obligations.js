#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { atomicWriteJSON } = require('../lib/cobolt-atomic-write');
const {
  getMilestoneIds,
  getMilestoneTitleMap,
  normalizeMilestoneId,
  normalizeStoryId,
  resolveReadablePlanningDir,
  resolveStoryFile,
  safeReadJson,
} = require('../lib/cobolt-planning-artifacts');
const { QUALITY_ARTIFACTS } = require('./cobolt-plan-quality-artifacts');

const ARTIFACT_ID = 'milestone-execution-obligations';
const ARTIFACT_FILE = 'milestone-execution-obligations.json';
const REVIEW_LEAD = 'review-lead';
const ADVISOR_AGENT = 'recovery-advisor';
const VALID_STATUSES = new Set(['pass', 'advisory']);
const PLACEHOLDER_PATTERNS = [
  { label: 'TODO', pattern: /\bTODO\b/i },
  { label: 'TBD', pattern: /\bTBD\b/i },
  { label: '<placeholder>', pattern: /<placeholder>/i },
  { label: '[placeholder]', pattern: /\[placeholder\]/i },
  { label: 'lorem ipsum', pattern: /\blorem ipsum\b/i },
  { label: 'refine later', pattern: /\b(refine|fill in|define)\s+(later|during implementation|during design)\b/i },
  { label: 'to be determined', pattern: /\bto be determined\b/i },
];
const PLANNING_QUALITY_DOCS = [
  'prd.md',
  'trd.md',
  'architecture.md',
  'ux-design-specification.md',
  'epics.md',
  'milestones.md',
  'delivery-plan.md',
  'test-strategy.md',
  'security-requirements.md',
];
const AUDIT_FAILURE_SUFFIX = '-failure.json';

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

function sha256File(filePath) {
  try {
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
  } catch {
    return null;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function relativeFrom(root, filePath) {
  return toPosix(path.relative(root, filePath));
}

function resolvePlanningDir(projectRoot, options = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  const planningDir = resolveReadablePlanningDir(root, { allowLatestFallback: options.create === true });
  if (planningDir && options.create === true) {
    fs.mkdirSync(planningDir, { recursive: true, mode: 0o700 });
  }
  return planningDir;
}

function artifactPath(planningDir) {
  return path.join(planningDir, ARTIFACT_FILE);
}

function parseArgs(argv) {
  const options = {
    command: null,
    projectRoot: process.cwd(),
    json: false,
    strict: false,
  };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (!options.command && !arg.startsWith('-')) {
      options.command = arg;
    } else if (arg === '--project' || arg === '--cwd' || arg === '--dir') {
      options.projectRoot = args.shift() || options.projectRoot;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--strict') {
      options.strict = true;
    } else if (arg === '--help' || arg === '-h') {
      options.command = 'help';
    }
  }
  if (!options.command) options.command = 'check';
  return options;
}

function getStoryTrackerStories(planningDir) {
  const tracker = safeReadJson(path.join(planningDir, 'story-tracker.json'));
  return Array.isArray(tracker?.stories) ? tracker.stories : [];
}

function extractStoryFeatureIds(story) {
  const ids = new Set();
  for (const value of [...(story.featureIds || []), ...(story.features || [])]) {
    if (value) ids.add(String(value).trim().toUpperCase());
  }
  for (const task of story.tasks || []) {
    const matches = String(task.description || '').match(/FEAT-\d{3}/giu);
    for (const match of matches || []) ids.add(match.toUpperCase());
  }
  return [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function extractStoryRequirementIds(story) {
  const ids = new Set();
  for (const bucket of [
    story.requirementIds,
    story.frIds,
    story.nfrIds,
    story.trIds,
    story.irIds,
    story.requirements,
  ]) {
    for (const value of bucket || []) {
      if (value) ids.add(String(value).trim().toUpperCase());
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function extractAcceptanceCriteria(storyFilePath) {
  const text = readText(storyFilePath);
  if (!text) return [];
  const lines = [];
  let inSection = false;
  for (const line of text.split(/\r?\n/u)) {
    if (/^##\s+Acceptance Criteria/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/u.test(line)) break;
    if (inSection && /^\s*-\s+/u.test(line)) {
      lines.push(line.replace(/^\s*-\s+/u, '').trim());
    }
  }
  return lines;
}

function collectSourceEvidence(_projectRoot, planningDir, extraFiles = []) {
  const files = new Set([
    'story-tracker.json',
    'milestones.md',
    'phase-4-gap-report.json',
    'phase-5-gap-report.json',
    'checkpoints/phase5-build-authorization.json',
    ...PLANNING_QUALITY_DOCS,
    ...QUALITY_ARTIFACTS.map((artifact) => artifact.file),
    ...extraFiles,
  ]);
  return [...files]
    .map((file) => {
      const absolutePath = path.join(planningDir, file);
      const exists = fs.existsSync(absolutePath);
      const stat = exists ? fs.statSync(absolutePath) : null;
      return {
        path: toPosix(file),
        exists,
        bytes: stat?.size || 0,
        sha256: exists ? sha256File(absolutePath) : null,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

function loadQualityArtifacts(planningDir) {
  const result = {};
  for (const artifact of QUALITY_ARTIFACTS) {
    result[artifact.id] = safeReadJson(path.join(planningDir, artifact.file));
  }
  return result;
}

function buildRequirementIndexById(collection, entryPath = 'requirementId') {
  const index = new Map();
  for (const item of collection || []) {
    const key = String(item?.[entryPath] || '')
      .trim()
      .toUpperCase();
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(item);
  }
  return index;
}

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function extractBulletLines(text, patterns, limit) {
  const lines = [];
  for (const line of String(text || '').split(/\r?\n/u)) {
    const cleaned = line.replace(/^\s*[-*]\s+/, '').trim();
    if (!cleaned || cleaned.length < 24 || cleaned.length > 240) continue;
    if (!patterns.some((pattern) => pattern.test(cleaned))) continue;
    lines.push(cleaned.replace(/\s+/g, ' '));
  }
  return unique(lines).slice(0, limit);
}

const REQUIRED_SECURITY_INVARIANTS = [
  {
    id: 'server_side_hashed_tokens',
    sourcePatterns: [/(password reset token|email verification token|recovery code|api key)/i, /(hash|hashed)/i],
    summary: 'Reset, verification, recovery, and API key tokens are hashed server-side before storage and comparison.',
    source: 'security-requirements.md / secure-coding-standard.md',
  },
  {
    id: 'encryption_at_rest',
    sourcePatterns: [/(encrypt|encryption|aes-256|kms|field-level|sse-kms)/i],
    summary: 'Sensitive data uses encryption at rest with KMS or SSE-KMS plus key management for field-level secrets.',
    source: 'security-requirements.md / secure-coding-standard.md',
  },
];

function inferRequiredSecurityInvariants(text) {
  return REQUIRED_SECURITY_INVARIANTS.filter((rule) => rule.sourcePatterns.every((pattern) => pattern.test(text))).map(
    ({ id, summary, source }) => ({ id, summary, source }),
  );
}

function mergeSecurityInvariants(required, extracted) {
  const merged = [];
  const seenIds = new Set();
  const seenSummaries = new Set();
  for (const item of [...required, ...extracted]) {
    const id = String(item.id || '').trim();
    const summaryKey = String(item.summary || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    if ((id && seenIds.has(id)) || (summaryKey && seenSummaries.has(summaryKey))) continue;
    if (id) seenIds.add(id);
    if (summaryKey) seenSummaries.add(summaryKey);
    merged.push(item);
  }
  return merged;
}

function findDocumentPlaceholders(content) {
  return PLACEHOLDER_PATTERNS.filter(({ pattern }) => pattern.test(content || '')).map(({ label }) => label);
}

function countShortSections(content) {
  const matches = [...String(content || '').matchAll(/^##+\s+(.+?)\s*$/gim)];
  if (matches.length === 0) return [];
  const sections = [];
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index + matches[index][0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : content.length;
    const body = String(content || '')
      .slice(start, end)
      .replace(/^[-*\s#>|`]+/gmu, '')
      .trim();
    if (body.length > 0 && body.length < 80) {
      sections.push({ heading: matches[index][1].trim(), length: body.length });
    }
  }
  return sections;
}

function comparableLines(content) {
  return new Set(
    String(content || '')
      .split(/\r?\n/u)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length >= 24 && !line.startsWith('#') && !line.startsWith('|')),
  );
}

function jaccardSimilarity(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  const union = new Set([...left, ...right]);
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  return union.size === 0 ? 0 : intersection / union.size;
}

function scanPlanningDocuments(planningDir, stories) {
  const findings = [];
  const docs = PLANNING_QUALITY_DOCS.map((file) => ({
    file,
    path: path.join(planningDir, file),
    content: readText(path.join(planningDir, file)),
  })).filter((doc) => doc.content.trim());

  for (const doc of docs) {
    const placeholders = findDocumentPlaceholders(doc.content);
    if (placeholders.length > 0) {
      findings.push({
        category: 'planning-artifact-quality',
        severity: 'medium',
        sourcePath: toPosix(doc.file),
        summary: `${doc.file} contains placeholder markers`,
        details: { placeholders },
      });
    }
    const shortSections = countShortSections(doc.content);
    if (shortSections.length > 0) {
      findings.push({
        category: 'planning-artifact-quality',
        severity: 'medium',
        sourcePath: toPosix(doc.file),
        summary: `${doc.file} has short sections that are likely shallow`,
        details: { sections: shortSections.slice(0, 10) },
      });
    }
  }

  for (let index = 0; index < docs.length; index += 1) {
    for (let offset = index + 1; offset < docs.length; offset += 1) {
      const left = docs[index];
      const right = docs[offset];
      const similarity = jaccardSimilarity(comparableLines(left.content), comparableLines(right.content));
      if (similarity >= 0.72) {
        findings.push({
          category: 'cross-artifact-drift',
          severity: 'medium',
          sourcePath: `${toPosix(left.file)} ↔ ${toPosix(right.file)}`,
          summary: `${left.file} and ${right.file} appear overly duplicated`,
          details: { similarity: Number(similarity.toFixed(3)) },
        });
      }
    }
  }

  for (const story of stories) {
    const storyFile = resolveStoryFile(story.id || story.storyId, planningDir, { planningDir });
    const acceptanceCriteria = extractAcceptanceCriteria(storyFile);
    if (acceptanceCriteria.length > 0 && acceptanceCriteria.length < 2) {
      findings.push({
        category: 'story-contract-quality',
        severity: 'medium',
        sourcePath: storyFile ? relativeFrom(planningDir, storyFile) : `story:${story.id}`,
        summary: `${story.id || story.storyId} has thin acceptance criteria`,
        details: { acceptanceCriteriaCount: acceptanceCriteria.length },
      });
    }
    const stubCriteria = acceptanceCriteria.filter((criterion) => findDocumentPlaceholders(criterion).length > 0);
    if (stubCriteria.length > 0) {
      findings.push({
        category: 'story-contract-quality',
        severity: 'high',
        sourcePath: storyFile ? relativeFrom(planningDir, storyFile) : `story:${story.id}`,
        summary: `${story.id || story.storyId} acceptance criteria contain placeholders`,
        details: { acceptanceCriteria: stubCriteria.slice(0, 5) },
      });
    }
  }

  return findings;
}

function collectAgentFailureContexts(projectRoot) {
  const auditDir = path.join(projectRoot, '_cobolt-output', 'audit');
  if (!fs.existsSync(auditDir)) return [];
  const entries = [];
  for (const name of fs.readdirSync(auditDir)) {
    if (!name.endsWith(AUDIT_FAILURE_SUFFIX)) continue;
    const filePath = path.join(auditDir, name);
    const raw = safeReadJson(filePath);
    if (!raw || typeof raw !== 'object') continue;
    entries.push({
      file: relativeFrom(projectRoot, filePath),
      agent: raw.agent || raw.reviewer || path.basename(name, '.json'),
      status: raw.status || 'failed',
      errorClass: raw.error_class || raw.reason || null,
      escalationTarget: raw.escalation_target || REVIEW_LEAD,
      remediation: raw.remediation || raw.nextAction || null,
      raw,
    });
  }
  return entries.sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }));
}

function loadPlanOutputAudit(projectRoot) {
  const auditPath = path.join(projectRoot, '_cobolt-output', 'audit', 'plan-output-audit', 'audit-report.json');
  return safeReadJson(auditPath);
}

function loadPlanReviewReport(projectRoot) {
  const reportPath = path.join(projectRoot, '_cobolt-output', 'audit', 'plan-review', 'plan-review-report.json');
  return safeReadJson(reportPath);
}

function toQueueItem(base, index) {
  return {
    id: base.id || `PLANQ-${String(index + 1).padStart(3, '0')}`,
    status: 'open',
    owner: REVIEW_LEAD,
    advisorAgent: ADVISOR_AGENT,
    category: base.category,
    severity: base.severity || 'medium',
    summary: base.summary,
    sourcePath: base.sourcePath || null,
    details: base.details || {},
  };
}

function _dedupeByKey(items, keyFn) {
  const result = [];
  const seen = new Set();
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function extractPlanOutputAuditItems(report) {
  if (!report || !Array.isArray(report.results)) return [];
  const items = [];
  for (const result of report.results) {
    for (const finding of result.findings || []) {
      items.push({
        category: 'plan-output-audit',
        severity: finding.severity === 'block' ? 'high' : 'medium',
        sourcePath: `plan-output-audit/${result.id}`,
        summary: `${result.id} ${result.name}: ${finding.message}`,
        details: {
          axis: result.id,
          tier: result.tier,
          findingId: finding.id,
          finding,
        },
      });
    }
  }
  return items;
}

function extractPlanReviewItems(report) {
  if (!report || !Array.isArray(report.findings)) return [];
  return report.findings.map((finding) => ({
    category: 'plan-review',
    severity: finding.severity === 'critical' ? 'high' : finding.severity === 'info' ? 'low' : 'medium',
    sourcePath: `plan-review/${finding.classId}`,
    summary: `${finding.classId} ${finding.artifact}: ${
      typeof finding.evidence === 'string' ? finding.evidence : JSON.stringify(finding.evidence)
    }`,
    details: finding,
  }));
}

function extractGapItems(planningDir, phase) {
  const filePath = path.join(planningDir, `phase-${phase}-gap-report.json`);
  const report = safeReadJson(filePath);
  if (!report) return [];
  const verdict = String(report.result || report.status || report.verdict || '').toUpperCase();
  if (verdict === 'PASS') return [];
  const items = [];
  const findings = Array.isArray(report.findings) ? report.findings : Array.isArray(report.issues) ? report.issues : [];
  if (findings.length === 0) {
    items.push({
      category: 'phase-gap-review',
      severity: verdict.includes('WARN') ? 'medium' : 'high',
      sourcePath: relativeFrom(planningDir, filePath),
      summary: `phase-${phase} gap report requires follow-up (${verdict || 'UNKNOWN'})`,
      details: report,
    });
    return items;
  }
  for (const finding of findings) {
    items.push({
      category: 'phase-gap-review',
      severity: verdict.includes('WARN') ? 'medium' : 'high',
      sourcePath: relativeFrom(planningDir, filePath),
      summary: `phase-${phase} gap: ${finding.message || finding.summary || finding.id || 'follow-up required'}`,
      details: finding,
    });
  }
  return items;
}

function collectLaunchBlockers(launchQualityGate) {
  const blockers = Array.isArray(launchQualityGate?.blockers) ? launchQualityGate.blockers : [];
  return blockers.map((blocker, index) => ({
    id: blocker.artifactId ? `LQG-${blocker.artifactId}-${index + 1}` : `LQG-${index + 1}`,
    code: blocker.code || 'BLOCKER',
    message: blocker.message || 'launch quality blocker',
    artifactId: blocker.artifactId || null,
  }));
}

function milestoneStoryBuckets(planningDir) {
  const stories = getStoryTrackerStories(planningDir);
  const milestones = new Map();
  for (const story of stories) {
    const milestoneId = normalizeMilestoneId(story.milestone || story.milestoneId);
    if (!milestoneId) continue;
    if (!milestones.has(milestoneId)) milestones.set(milestoneId, []);
    milestones.get(milestoneId).push(story);
  }
  return milestones;
}

function buildObservabilityObligations(featureIds, observabilityContract) {
  const contracts = Array.isArray(observabilityContract?.featureContracts)
    ? observabilityContract.featureContracts
    : [];
  const selected = contracts.filter((entry) => featureIds.includes(String(entry.featureId || '').toUpperCase()));
  const effective = selected.length > 0 ? selected : contracts.slice(0, 2);
  return effective.map((entry) => ({
    featureId: entry.featureId || null,
    logs: (entry.logs || []).map((log) => ({
      event: log.event,
      level: log.level,
      requiredFields: log.requiredFields || [],
    })),
    metrics: (entry.metrics || []).map((metric) => ({
      name: metric.name,
      type: metric.type,
      budget: metric.budget,
    })),
    traces: (entry.traces || []).map((trace) => ({
      span: trace.span,
      requiredAttributes: trace.requiredAttributes || [],
    })),
    alerts: (entry.alerts || []).map((alert) => ({
      name: alert.name,
      condition: alert.condition,
    })),
  }));
}

function buildProofObligations(story, acceptanceExamples, fixtures, observability, securityCases, launchBlockers) {
  const proof = [];
  for (const example of acceptanceExamples) {
    proof.push({
      type: 'acceptance-example',
      id: example.id,
      summary: `${example.type} coverage for ${story.id}`,
    });
  }
  for (const fixture of fixtures) {
    proof.push({
      type: 'fixture',
      id: fixture.id,
      summary: `deterministic seed ${fixture.seedName || fixture.id}`,
    });
  }
  for (const entry of observability) {
    for (const metric of entry.metrics || []) {
      proof.push({
        type: 'observability',
        id: metric.name,
        summary: `prove ${metric.name} with budget ${metric.budget || 'declared budget'}`,
      });
    }
  }
  for (const securityCase of securityCases) {
    proof.push({
      type: 'security-abuse-case',
      id: securityCase.id,
      summary: `negative-path defense for ${securityCase.abuseCase || securityCase.id}`,
    });
  }
  for (const blocker of launchBlockers) {
    proof.push({
      type: 'launch-blocker',
      id: blocker.id,
      summary: blocker.message,
    });
  }
  return proof.slice(0, 24);
}

function collectStoryDriftFindings(storyId, storyFile, queueItems) {
  const storyToken = String(storyId || '')
    .trim()
    .toLowerCase();
  const storyFileToken = String(storyFile || '')
    .trim()
    .toLowerCase();
  if (!storyToken && !storyFileToken) return [];
  return (queueItems || []).filter((item) => {
    const sourcePath = String(item.sourcePath || '')
      .trim()
      .toLowerCase();
    const summary = String(item.summary || '')
      .trim()
      .toLowerCase();
    return (
      (storyToken && (sourcePath.includes(storyToken) || summary.includes(storyToken))) ||
      (storyFileToken && sourcePath.includes(storyFileToken))
    );
  });
}

function buildStoryObligation(story, planningDir, indexes, qualityArtifacts, launchBlockers, queueItems) {
  const storyId = normalizeStoryId(story.id || story.storyId) || String(story.id || story.storyId || '').trim();
  const storyFile = resolveStoryFile(storyId, planningDir, { planningDir });
  const relativeStoryFile = storyFile ? relativeFrom(planningDir, storyFile) : null;
  const storyRequirementIds = extractStoryRequirementIds(story);
  const featureIds = extractStoryFeatureIds(story);
  const acceptanceEntries = storyRequirementIds.flatMap((id) => indexes.examples.get(id) || []);
  const exampleRows = acceptanceEntries.flatMap((entry) => entry.examples || []);
  const negativeScenarios = exampleRows.filter((example) => example.type === 'negative-path');
  const edgeScenarios = exampleRows.filter((example) => example.type === 'edge-path');
  const fixtures = storyRequirementIds.flatMap((id) => indexes.fixtures.get(id) || []);
  const securityCases = storyRequirementIds.flatMap((id) => indexes.securityCases.get(id) || []);
  const observability = buildObservabilityObligations(featureIds, qualityArtifacts['observability-contract']);
  const proofObligations = buildProofObligations(
    { id: storyId },
    exampleRows,
    fixtures,
    observability,
    securityCases,
    launchBlockers,
  );
  const driftFindings = collectStoryDriftFindings(storyId, relativeStoryFile, queueItems);

  return {
    storyId,
    title: String(story.title || story.name || storyId),
    storyFile: relativeStoryFile,
    requirementIds: storyRequirementIds,
    featureIds,
    acceptanceCriteria: storyFile ? extractAcceptanceCriteria(storyFile) : [],
    acceptanceExamples: exampleRows,
    negativeScenarios,
    edgeScenarios,
    testFixtures: fixtures,
    observability,
    performanceBudgets: qualityArtifacts['performance-accessibility-budgets']?.performanceBudgets || [],
    accessibilityBudgets: qualityArtifacts['performance-accessibility-budgets']?.accessibilityBudgets || [],
    runtimeOperations: qualityArtifacts['runtime-operations-pack']?.runbooks || [],
    securityAbuseCases: securityCases,
    architectureFitnessChecks: qualityArtifacts['architecture-fitness-checks']?.checks || [],
    launchBlockers,
    driftFindings,
    proofObligations,
  };
}

function buildMilestones(_projectRoot, planningDir, qualityArtifacts, queueItems) {
  const titleMap = getMilestoneTitleMap(planningDir);
  const milestoneIds = getMilestoneIds(planningDir);
  const storiesByMilestone = milestoneStoryBuckets(planningDir);
  const indexes = {
    examples: buildRequirementIndexById(qualityArtifacts['acceptance-example-pack']?.examples, 'requirementId'),
    fixtures: buildRequirementIndexById(qualityArtifacts['test-data-fixture-plan']?.fixtures, 'requirementId'),
    securityCases: buildRequirementIndexById(qualityArtifacts['security-abuse-case-pack']?.cases, 'requirementId'),
  };
  const allLaunchBlockers = collectLaunchBlockers(qualityArtifacts['launch-quality-gate']);

  return milestoneIds.map((milestoneId) => {
    const stories = storiesByMilestone.get(milestoneId) || [];
    const storyObligations = stories.map((story) =>
      buildStoryObligation(story, planningDir, indexes, qualityArtifacts, allLaunchBlockers, queueItems),
    );
    const requirementIds = new Set(storyObligations.flatMap((story) => story.requirementIds || []));
    const featureIds = new Set(storyObligations.flatMap((story) => story.featureIds || []));
    const carryForward = queueItems.filter((item) =>
      [
        'phase-gap-review',
        'plan-output-audit',
        'planning-artifact-quality',
        'cross-artifact-drift',
        'story-contract-quality',
        'agent-failure',
      ].includes(item.category),
    );
    return {
      id: milestoneId,
      title: titleMap[milestoneId] || milestoneId,
      storyCount: storyObligations.length,
      requirementIds: [...requirementIds].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      featureIds: [...featureIds].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      stories: storyObligations,
      launchBlockers: allLaunchBlockers,
      carryForward,
      summary: {
        acceptanceExamples: storyObligations.reduce((sum, story) => sum + (story.acceptanceExamples || []).length, 0),
        testFixtures: storyObligations.reduce((sum, story) => sum + (story.testFixtures || []).length, 0),
        proofObligations: storyObligations.reduce((sum, story) => sum + (story.proofObligations || []).length, 0),
        driftFindings: storyObligations.reduce((sum, story) => sum + (story.driftFindings || []).length, 0),
      },
    };
  });
}

function buildDriftDetectors(queueItems) {
  const detectorSpecs = [
    {
      id: 'planning-artifact-depth',
      category: 'planning-artifact-quality',
      label: 'Planning artifact depth detector',
      description: 'Flags placeholders, shallow sections, and weak content depth in planning documents.',
    },
    {
      id: 'cross-artifact-consistency',
      category: 'cross-artifact-drift',
      label: 'Cross-artifact drift detector',
      description:
        'Flags duplicated or inconsistent planning content across PRD, TRD, architecture, UX, and milestones.',
    },
    {
      id: 'story-contract-strength',
      category: 'story-contract-quality',
      label: 'Story contract detector',
      description: 'Flags weak, placeholder, or thin acceptance criteria before build derives code tasks.',
    },
    {
      id: 'phase-gap-carry-forward',
      category: 'phase-gap-review',
      label: 'Phase gap carry-forward detector',
      description: 'Carries unresolved phase-gap findings forward so build starts with known planning risk.',
    },
    {
      id: 'plan-output-audit-carry-forward',
      category: 'plan-output-audit',
      label: 'Plan output audit detector',
      description: 'Carries final audit findings into the build contract instead of rediscovering them later.',
    },
    {
      id: 'plan-review-carry-forward',
      category: 'plan-review',
      label: 'Plan review detector',
      description: 'Carries holistic plan-review taxonomy findings into the build contract and escalation packets.',
    },
    {
      id: 'agent-failure-review',
      category: 'agent-failure',
      label: 'Agent failure detector',
      description: 'Collects agent failure records and escalates them with full error context to review-lead.',
    },
  ];

  return detectorSpecs.map((spec) => {
    const findings = (queueItems || []).filter((item) => item.category === spec.category);
    return {
      id: spec.id,
      category: spec.category,
      label: spec.label,
      description: spec.description,
      status: findings.length > 0 ? 'active' : 'clear',
      findingCount: findings.length,
      owner: REVIEW_LEAD,
      advisorAgent: spec.category === 'agent-failure' ? ADVISOR_AGENT : null,
      sampleFindings: findings.slice(0, 5).map((item) => ({
        id: item.id,
        severity: item.severity,
        summary: item.summary,
        sourcePath: item.sourcePath || null,
      })),
    };
  });
}

function summarizeDrift(queueItems, driftDetectors) {
  const countsByCategory = {};
  for (const item of queueItems || []) {
    countsByCategory[item.category] = (countsByCategory[item.category] || 0) + 1;
  }
  return {
    totalFindings: (queueItems || []).length,
    activeDetectorCount: (driftDetectors || []).filter((detector) => detector.findingCount > 0).length,
    countsByCategory,
  };
}

function buildEscalationPackets(queueItems, agentFailures, milestones) {
  const milestoneIds = milestones.map((milestone) => milestone.id);
  const reviewLeadFindings = queueItems.filter((item) => item.owner === REVIEW_LEAD);
  const criticalAgentFailures = agentFailures.filter((failure) =>
    ['failed', 'timeout', 'crash', 'schema-invalid', 'phantom-saturated'].includes(String(failure.status || '')),
  );
  return {
    reviewLead: {
      enabled: reviewLeadFindings.length > 0 || agentFailures.length > 0,
      leadAgent: REVIEW_LEAD,
      instruction:
        'Review planning artifact quality drift, unblock weak handoff contracts, and keep build/review moving with corrected evidence.',
      milestoneIds,
      findings: reviewLeadFindings,
      agentFailures,
    },
    recoveryAdvisor: {
      enabled: criticalAgentFailures.length > 0,
      advisorAgent: ADVISOR_AGENT,
      instruction:
        'If repeated lead retries do not converge, use the full failure context below to choose retry-with-context, split-scope, fallback-main-session, or skip-with-debt.',
      failureClass: 'planning-content-quality',
      evidence: {
        milestoneIds,
        failureCount: criticalAgentFailures.length,
        failures: criticalAgentFailures,
      },
    },
  };
}

function createDocument(projectRoot, planningDir) {
  const qualityArtifacts = loadQualityArtifacts(planningDir);
  const planOutputAudit = loadPlanOutputAudit(projectRoot);
  const planReviewReport = loadPlanReviewReport(projectRoot);
  const stories = getStoryTrackerStories(planningDir);
  const qualityDocFindings = scanPlanningDocuments(planningDir, stories);
  const planOutputAuditItems = extractPlanOutputAuditItems(planOutputAudit);
  const planReviewItems = extractPlanReviewItems(planReviewReport);
  const gapItems = [...extractGapItems(planningDir, 4), ...extractGapItems(planningDir, 5)];
  const agentFailures = collectAgentFailureContexts(projectRoot);
  const agentFailureItems = agentFailures.map((failure) => ({
    category: 'agent-failure',
    severity: ['failed', 'crash', 'timeout'].includes(String(failure.status || '').toLowerCase()) ? 'high' : 'medium',
    sourcePath: failure.file,
    summary: `${failure.agent} reported ${failure.status || 'failure'}${failure.errorClass ? ` (${failure.errorClass})` : ''}`,
    details: failure.raw,
  }));
  const securityText = [
    readText(path.join(planningDir, 'security-requirements.md')),
    readText(path.join(planningDir, 'secure-coding-standard.md')),
  ].join('\n');
  const testStrategyText = readText(path.join(planningDir, 'test-strategy.md'));
  const securityInvariants = mergeSecurityInvariants(
    inferRequiredSecurityInvariants(securityText),
    extractBulletLines(
      securityText,
      [/auth/i, /tenant/i, /workspace/i, /encrypt/i, /audit/i, /privacy/i, /rate/i, /token/i, /rls/i],
      10,
    ).map((summary, index) => ({
      id: `security-${String(index + 1).padStart(2, '0')}`,
      summary,
      source: 'security-requirements.md / secure-coding-standard.md',
    })),
  );
  const requiredTestEvidence = extractBulletLines(
    testStrategyText,
    [/unit/i, /integration/i, /e2e/i, /accessibility/i, /security/i, /performance/i, /observability/i, /contract/i],
    12,
  ).map((summary, index) => ({
    id: `test-${String(index + 1).padStart(2, '0')}`,
    summary,
  }));

  const queueItems = [
    ...qualityDocFindings,
    ...gapItems,
    ...planOutputAuditItems,
    ...planReviewItems,
    ...agentFailureItems,
  ].map(toQueueItem);
  const milestones = buildMilestones(projectRoot, planningDir, qualityArtifacts, queueItems);
  const driftDetectors = buildDriftDetectors(queueItems);
  const driftSummary = summarizeDrift(queueItems, driftDetectors);
  const escalationPackets = buildEscalationPackets(queueItems, agentFailures, milestones);
  const extraEvidence = [];
  if (planOutputAudit) extraEvidence.push('../audit/plan-output-audit/audit-report.json');
  if (planReviewReport) extraEvidence.push('../audit/plan-review/plan-review-report.json');
  for (const failure of agentFailures) extraEvidence.push(failure.file.replace('_cobolt-output/audit/', ''));

  const missing = [];
  if (milestones.length === 0) missing.push('milestone coverage');
  if (!qualityArtifacts['acceptance-example-pack']) missing.push('quality/acceptance-example-pack.json');
  if (!qualityArtifacts['launch-quality-gate']) missing.push('quality/launch-quality-gate.json');

  return {
    version: 1,
    artifactId: ARTIFACT_ID,
    generatedAt: new Date().toISOString(),
    generator: 'cobolt-milestone-execution-obligations',
    status: missing.length > 0 ? 'fail' : queueItems.length > 0 ? 'advisory' : 'pass',
    blockers: missing.map((entry) => ({
      code: 'MISSING_EXECUTION_INPUT',
      message: `${entry} missing or unreadable`,
    })),
    sourceEvidence: collectSourceEvidence(projectRoot, planningDir, extraEvidence),
    securityInvariants,
    requiredTestEvidence,
    summary: {
      milestoneCount: milestones.length,
      storyCount: milestones.reduce((sum, milestone) => sum + milestone.storyCount, 0),
      enhancementCount: queueItems.length,
      agentFailureCount: agentFailures.length,
    },
    enhancementQueue: queueItems,
    driftDetectors,
    driftSummary,
    agentFailureContexts: agentFailures,
    milestones,
    escalationPackets,
    handoffGuidance: [
      'Treat milestone/story proof obligations as the authoritative build contract.',
      `Route open enhancementQueue items to ${REVIEW_LEAD} with the full finding payload, not a summary.`,
      `If repeated retries do not converge, pass the full agent failure context to ${ADVISOR_AGENT}.`,
      'Carry phase-gap and plan-output-audit findings into build/review instead of rediscovering them later.',
    ],
  };
}

function generateMilestoneExecutionObligations(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const planningDir = resolvePlanningDir(projectRoot, { create: true });
  if (!planningDir) {
    return {
      passed: false,
      projectRoot,
      planningDir: null,
      message: 'No canonical planning directory could be resolved',
      outputPath: null,
    };
  }

  const document = createDocument(projectRoot, planningDir);
  const outputPath = artifactPath(planningDir);
  atomicWriteJSON(outputPath, document, { indent: 2 });
  const check = checkMilestoneExecutionObligations({ projectRoot });
  return {
    passed: check.passed,
    projectRoot,
    planningDir,
    outputPath,
    document,
    check,
  };
}

function validateDocument(document) {
  if (!document || typeof document !== 'object') return 'not valid JSON object';
  if (document.version !== 1) return 'version must be 1';
  if (document.artifactId !== ARTIFACT_ID) return `artifactId must be ${ARTIFACT_ID}`;
  if (!VALID_STATUSES.has(document.status)) return `status must be one of ${[...VALID_STATUSES].join(', ')}`;
  if (!Array.isArray(document.sourceEvidence) || document.sourceEvidence.length === 0) return 'sourceEvidence missing';
  if (!Array.isArray(document.milestones) || document.milestones.length === 0) return 'milestones missing';
  if (!Array.isArray(document.enhancementQueue)) return 'enhancementQueue missing';
  if (!Array.isArray(document.driftDetectors) || document.driftDetectors.length === 0) return 'driftDetectors missing';
  if (!document.escalationPackets?.reviewLead || document.escalationPackets.reviewLead.leadAgent !== REVIEW_LEAD) {
    return `reviewLead escalation packet must target ${REVIEW_LEAD}`;
  }
  return null;
}

function checkMilestoneExecutionObligations(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const planningDir = resolvePlanningDir(projectRoot, { create: false });
  if (!planningDir) {
    return {
      passed: false,
      projectRoot,
      planningDir: null,
      message: 'No readable planning directory found',
      outputPath: null,
    };
  }

  const outputPath = artifactPath(planningDir);
  if (!fs.existsSync(outputPath)) {
    return {
      passed: false,
      projectRoot,
      planningDir,
      outputPath,
      message: `${ARTIFACT_FILE} is missing`,
    };
  }

  const document = safeReadJson(outputPath);
  const reason = validateDocument(document);
  return {
    passed: !reason,
    projectRoot,
    planningDir,
    outputPath,
    document,
    message: reason || null,
  };
}

function usage() {
  return [
    `Usage: node tools/cobolt-milestone-execution-obligations.js <generate|check> [--project <dir>] [--json] [--strict]`,
    '',
    'Commands:',
    '  generate  Generate milestone execution obligations and enhancement/escalation context.',
    '  check     Validate the existing milestone execution obligations artifact.',
  ].join('\n');
}

function printHuman(result, command) {
  const status = result.passed ? 'PASS' : 'FAIL';
  console.log(`CoBolt milestone execution obligations ${command}: ${status}`);
  if (result.planningDir) console.log(`Planning dir: ${result.planningDir}`);
  if (result.outputPath) console.log(`Artifact: ${result.outputPath}`);
  if (result.document?.summary) {
    console.log(
      `Milestones: ${result.document.summary.milestoneCount} | Stories: ${result.document.summary.storyCount} | Enhancements: ${result.document.summary.enhancementCount}`,
    );
  }
  if (result.message) console.log(`Issue: ${result.message}`);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'help') {
    console.log(usage());
    return 0;
  }
  if (!['generate', 'check'].includes(options.command)) {
    console.error(`Unknown command: ${options.command}`);
    console.error(usage());
    return 2;
  }
  const result =
    options.command === 'generate'
      ? generateMilestoneExecutionObligations({ projectRoot: options.projectRoot })
      : checkMilestoneExecutionObligations({ projectRoot: options.projectRoot });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printHuman(result, options.command);
  }
  if (!result.passed && (options.strict || options.command === 'check')) return 1;
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  ADVISOR_AGENT,
  ARTIFACT_FILE,
  ARTIFACT_ID,
  REVIEW_LEAD,
  checkMilestoneExecutionObligations,
  createDocument,
  generateMilestoneExecutionObligations,
  main,
  validateDocument,
};
