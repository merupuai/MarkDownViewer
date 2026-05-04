#!/usr/bin/env node

// CoBolt Planning Manifest - graph-backed planning evidence for build handoff.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeStoryId, resolveReadablePlanningDir, resolveStoryFile } = require('../lib/cobolt-planning-artifacts');
const {
  artifactIdToStateKey,
  listCanonicalPlanningArtifactIds,
  loadDependencies,
} = require('../lib/cobolt-preflight-helpers');
const { atomicWrite } = require('../lib/cobolt-atomic-write');

const SCHEMA_VERSION = '1.0.0';
const TOOL_ID = 'cobolt-planning-manifest';
const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const REQUIREMENT_ID_RE = /\b(?:FR|NFR|TR|IR|TRD|ADR)(?:-[A-Z0-9]{1,8})?-\d{1,4}(?:-[A-Z]{2,8})?\b/giu;
const SRC_ID_RE = /\bSRC-[A-Z0-9-]+\b/giu;

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

function normalizePath(value) {
  return toPosix(value).replace(/^\.\//, '').replace(/\/+/g, '/').toLowerCase();
}

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, '');
  } catch {
    return '';
  }
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return fallback;
  }
}

function loadPlanningDependencies(projectRoot) {
  const localSchema = path.join(projectRoot, 'source', 'schemas', 'artifact-dependencies.json');
  const local = readJson(localSchema, null);
  return local || loadDependencies(projectRoot) || { artifacts: {}, skills: {} };
}

function sha256Buffer(buffer) {
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

function sha256File(filePath) {
  try {
    return sha256Buffer(fs.readFileSync(filePath));
  } catch {
    return null;
  }
}

function relativePath(root, filePath) {
  if (!filePath) return null;
  return toPosix(path.relative(root, filePath));
}

function latestPlanningDir(projectRoot, options = {}) {
  const planningDir = resolveReadablePlanningDir(projectRoot, { allowLatestFallback: options.create === true });
  if (planningDir) return planningDir;
  return path.join(projectRoot, '_cobolt-output', 'latest', 'planning');
}

function manifestPath(projectRoot, options = {}) {
  const planningDir = options.planningDir || latestPlanningDir(projectRoot, { create: true });
  return path.join(planningDir, 'planning-manifest.json');
}

function repairEvidencePaths(projectRoot, options = {}) {
  const planningDir = options.planningDir || latestPlanningDir(projectRoot, { create: true });
  return {
    jsonlPath: path.join(projectRoot, '_cobolt-output', 'audit', 'plan-fix-repair-evidence.jsonl'),
    summaryPath: path.join(planningDir, 'plan-fix-repair-evidence.json'),
  };
}

function loadSourceRegistry(planningDir) {
  const packetPath = path.join(planningDir, 'source-document-consolidation.md');
  const text = readText(packetPath);
  const entries = [];
  let inRegistry = false;

  for (const line of text.split(/\r?\n/u)) {
    if (/^##\s+(?:\d+(?:\.\d+)*\.?\s+)?Source Requirement Registry/i.test(line)) {
      inRegistry = true;
      continue;
    }
    if (inRegistry && /^##\s+/u.test(line) && !/Source Requirement Registry/i.test(line)) break;
    if (!inRegistry || !/^\|/.test(line) || /^\|\s*(ID|--)/i.test(line)) continue;

    const match = line.match(/^\|\s*(SRC-[A-Z0-9-]+)\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|/i);
    if (!match) continue;
    const status = String(match[5] || '')
      .trim()
      .toLowerCase();
    let disposition = 'included';
    if (status.startsWith('exclude')) disposition = 'excluded';
    else if (status.startsWith('defer')) disposition = 'deferred';

    entries.push({
      id: match[1].trim().toUpperCase(),
      sourceFile: match[2].trim(),
      summary: match[3].trim(),
      category: match[4].trim(),
      status,
      disposition,
    });
  }

  return { packetPath, entries };
}

function collectInputDocuments(projectRoot, planningDir, registry) {
  const intakePath = path.join(planningDir, 'source-intake.json');
  const intake = readJson(intakePath, null);
  const fromIntake = Array.isArray(intake?.inputDocuments) ? intake.inputDocuments : [];
  const fromState = (() => {
    const state = readJson(path.join(projectRoot, 'cobolt-state.json'), null);
    if (Array.isArray(state?.planning?.inputDocuments)) return state.planning.inputDocuments;
    if (typeof state?.planning?.inputDocuments === 'string') {
      try {
        const parsed = JSON.parse(state.planning.inputDocuments);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  })();
  const documents = unique([...fromIntake, ...fromState]);

  return documents.map((documentPath) => {
    const normalized = normalizePath(documentPath);
    const basename = path.basename(normalized);
    const matches = registry.entries.filter((entry) => {
      const source = normalizePath(entry.sourceFile);
      return source === normalized || source.endsWith(`/${basename}`) || source === basename;
    });
    const disposition =
      matches.length === 0
        ? 'missing'
        : matches.some((entry) => entry.disposition === 'included')
          ? 'included'
          : matches.some((entry) => entry.disposition === 'deferred')
            ? 'deferred'
            : 'excluded';
    return {
      path: documentPath,
      sourceIntakePresent: fromIntake.includes(documentPath),
      srcMappings: matches.map((entry) => entry.id),
      disposition,
      reason: matches.find((entry) => entry.status)?.status || null,
    };
  });
}

function resolvePatternFiles(projectRoot, pattern) {
  const normalized = toPosix(pattern);
  if (!normalized.includes('*')) return [];
  const dir = path.join(projectRoot, path.dirname(normalized).replaceAll('/', path.sep));
  const basename = path.basename(normalized);
  const escaped = basename
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const regex = new RegExp(`^${escaped}$`, 'i');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && regex.test(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

function resolveArtifactFiles(projectRoot, artifact) {
  const artifactPath = artifact?.path || artifact?.pathPattern || '';
  if (!artifactPath) return [];
  if (artifactPath.includes('*')) return resolvePatternFiles(projectRoot, artifactPath);
  const absolutePath = path.isAbsolute(artifactPath)
    ? artifactPath
    : path.join(projectRoot, artifactPath.replaceAll('/', path.sep));
  return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile() ? [absolutePath] : [];
}

function collectArtifactEntries(projectRoot, planningDir, deps, options = {}) {
  const buildRequires = new Set(deps?.skills?.['cobolt-build']?.requires || []);
  const registry = loadSourceRegistry(planningDir);
  const ids = listCanonicalPlanningArtifactIds(deps);
  const findings = [];
  const artifacts = [];

  for (const artifactId of ids) {
    const artifact = deps.artifacts[artifactId] || {};
    const expectedPath = artifact.path || artifact.pathPattern || '';
    const required = buildRequires.has(artifactId) || artifact.critical === true;
    const minBytes = Number.isFinite(Number(artifact.minBytes)) ? Number(artifact.minBytes) : 1;
    const files = resolveArtifactFiles(projectRoot, artifact);
    const ownerPhase = artifact.phase ?? artifact.stage ?? null;

    if (files.length === 0) {
      const selfPending = artifactId === 'planning-manifest' && options.assumeSelfPresent === true;
      const entry = {
        artifactId,
        path: expectedPath,
        sha256: selfPending ? options.selfHash || null : null,
        sizeBytes: selfPending ? options.selfSize || 0 : 0,
        ownerPhase,
        producedBy: artifact.producedBy || null,
        required,
        sourceInputs: [],
        verifierResults: [
          {
            id: 'artifact-presence',
            status: selfPending ? 'pass' : 'missing',
            message: selfPending ? 'planning manifest is being generated' : 'artifact not found on disk',
          },
        ],
      };
      artifacts.push(entry);
      if (required && !selfPending) {
        findings.push({
          classId: 'PM-ARTIFACT',
          severity: options.strict ? 'critical' : 'advisory',
          artifactPath: expectedPath,
          evidence: `${artifactId} is required but missing at ${expectedPath}`,
          remediationHint: `Run ${artifact.producedBy || 'the owning planning producer'} to materialize ${expectedPath}`,
          artifactId,
        });
      }
      continue;
    }

    for (const filePath of files) {
      const stat = fs.statSync(filePath);
      const rel = relativePath(projectRoot, filePath);
      const content = readText(filePath);
      const sourceInputs = unique(content.match(SRC_ID_RE) || []);
      const verifierResults = [
        { id: 'artifact-presence', status: 'pass', message: null },
        {
          id: 'minimum-size',
          status: stat.size >= minBytes ? 'pass' : 'fail',
          message: stat.size >= minBytes ? null : `size ${stat.size} below minBytes ${minBytes}`,
        },
      ];
      const entry = {
        artifactId,
        path: rel,
        sha256: sha256File(filePath),
        sizeBytes: stat.size,
        ownerPhase,
        producedBy: artifact.producedBy || null,
        required,
        sourceInputs,
        verifierResults,
      };
      artifacts.push(entry);
      if (required && stat.size < minBytes) {
        findings.push({
          classId: 'PM-ARTIFACT',
          severity: options.strict ? 'critical' : 'advisory',
          artifactPath: rel,
          evidence: `${artifactId} is ${stat.size} bytes, below required minimum ${minBytes}`,
          remediationHint: `Regenerate ${rel} with complete content from ${artifact.producedBy || 'the owning producer'}`,
          artifactId,
        });
      }
    }
  }

  return { artifacts, findings, registry };
}

function extractRequirementIds(text) {
  return unique(String(text || '').match(REQUIREMENT_ID_RE) || []).map((id) => id.toUpperCase());
}

function normalizeRequirementEntry(id, raw) {
  const fields = raw || {};
  const sourceIds = unique([
    ...(fields.sourceIds || []),
    ...(fields.source_ids || []),
    ...(fields.srcIds || []),
    ...(String(fields.description || '').match(SRC_ID_RE) || []),
    ...(String(fields.title || '').match(SRC_ID_RE) || []),
  ]).map((value) => value.toUpperCase());
  const stories = unique([...(fields.stories || []), ...(fields.storyIds || []), fields.story].filter(Boolean)).map(
    (storyId) => normalizeStoryId(storyId) || String(storyId),
  );
  return {
    id: String(fields.id || id || '').toUpperCase(),
    source: fields.source || null,
    type: fields.type || null,
    title: fields.title || '',
    description: fields.description || '',
    sourceIds,
    stories,
    dependencies: unique([...(fields.dependsOn || []), ...(fields.dependencies || []), ...(fields.blockedBy || [])]),
    acceptanceCriteria: fields.acceptance_criteria || fields.acceptanceCriteria || [],
    testEvidence: fields.test_evidence || fields.testEvidence || [],
    raw: fields,
  };
}

function loadRequirementEntries(planningDir) {
  const rtm = readJson(path.join(planningDir, 'rtm.json'), null);
  const entries = [];
  if (rtm?.requirements && typeof rtm.requirements === 'object') {
    for (const [id, raw] of Object.entries(rtm.requirements)) entries.push(normalizeRequirementEntry(id, raw));
  }
  for (const raw of rtm?.entries || []) entries.push(normalizeRequirementEntry(raw.id, raw));

  if (entries.length === 0) {
    const prd = readText(path.join(planningDir, 'prd.md'));
    for (const id of extractRequirementIds(prd)) {
      entries.push(
        normalizeRequirementEntry(id, {
          id,
          source: 'prd',
          type: id.startsWith('NFR-') ? 'non-functional' : 'functional',
        }),
      );
    }
  }

  return entries.filter((entry) => entry.id);
}

function splitMarkdownSections(text) {
  const sections = [];
  let current = { heading: 'Document Body', body: '' };
  for (const line of String(text || '').split(/\r?\n/u)) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/u);
    if (heading) {
      if (current.body.trim()) sections.push(current);
      current = { heading: heading[2].trim(), body: '' };
    } else {
      current.body += `${line}\n`;
    }
  }
  if (current.body.trim()) sections.push(current);
  return sections;
}

function artifactRefsContaining(planningDir, files, id) {
  const refs = [];
  for (const file of files) {
    const absolute = path.join(planningDir, file);
    const text = readText(absolute);
    if (!text) continue;
    if (new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) refs.push(file);
  }
  return refs;
}

function hasDomainSignal(entry, patterns) {
  const text = `${entry.id} ${entry.title} ${entry.description} ${entry.type}`.toLowerCase();
  return patterns.some((pattern) => pattern.test(text));
}

function collectRequirementEvidence(planningDir, storyById, options = {}) {
  const findings = [];
  const prdSections = splitMarkdownSections(readText(path.join(planningDir, 'prd.md')));
  const testStrategy = readText(path.join(planningDir, 'test-strategy.md'));
  const entries = loadRequirementEntries(planningDir);

  return {
    requirements: entries.map((entry) => {
      const idPattern = new RegExp(`\\b${entry.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      const sections = prdSections.filter((section) => idPattern.test(`${section.heading}\n${section.body}`));
      const storyIds = unique(entry.stories).map((storyId) => normalizeStoryId(storyId) || storyId);
      const storyDeps = storyIds.flatMap((storyId) => storyById.get(storyId)?.implementationDependencies?.ids || []);
      const dependencyIds = unique([...entry.dependencies, ...storyDeps]);
      const tests = [
        ...entry.testEvidence.map((test) => test.case_id || test.id || test.file || JSON.stringify(test)),
        ...entry.acceptanceCriteria.map((_, index) => `acceptance-criteria:${index + 1}`),
        ...(idPattern.test(testStrategy) ? ['test-strategy.md'] : []),
      ];
      const apis = artifactRefsContaining(planningDir, ['api-contracts.md', 'api-contracts.json'], entry.id);
      const events = artifactRefsContaining(planningDir, ['event-schemas.md', 'event-schemas.json'], entry.id);
      const data = artifactRefsContaining(planningDir, ['data-model-spec.md', 'data-model.md'], entry.id);
      const security = artifactRefsContaining(
        planningDir,
        ['security-requirements.md', 'secure-coding-standard.md'],
        entry.id,
      );
      const nfrs = artifactRefsContaining(planningDir, ['trd.md', 'engineering-quality-standards.md'], entry.id);
      const notApplicable = [];

      const maybeNa = [
        ['api', apis, [/\bapi\b/, /\bendpoint\b/, /\bwebhook\b/, /\bhttp\b/]],
        ['events', events, [/\bevent\b/, /\bqueue\b/, /\bmessage\b/, /\bpubsub\b/]],
        ['data', data, [/\bdata\b/, /\bdatabase\b/, /\bschema\b/, /\bentity\b/, /\bmodel\b/]],
        ['security', security, [/\bauth\b/, /\bsecurity\b/, /\brbac\b/, /\bpermission\b/, /\btenant\b/]],
        ['nfrs', nfrs, [/\bnfr\b/, /\bperformance\b/, /\breliability\b/, /\bobservability\b/, /\bavailability\b/]],
      ];
      for (const [category, refs, patterns] of maybeNa) {
        if (refs.length === 0 && !hasDomainSignal(entry, patterns)) {
          notApplicable.push({
            category,
            reason: 'No deterministic domain signal found for this requirement category.',
          });
        }
      }

      const requirement = {
        id: entry.id,
        source: entry.source,
        sourceIds: entry.sourceIds,
        prdSections: sections.map((section) => section.heading),
        stories: storyIds,
        dependencies: {
          ids: dependencyIds,
          disposition: dependencyIds.length > 0 ? 'declared' : 'none-declared',
        },
        apis,
        events,
        data,
        security,
        nfrs,
        tests: unique(tests),
        notApplicable,
      };

      if (requirement.prdSections.length === 0) {
        findings.push(
          makeFinding(
            options,
            'PM-REQ',
            'prd.md',
            `${entry.id} is missing a PRD section reference`,
            'Regenerate PRD/RTM so the requirement ID appears in the PRD section it came from.',
            { requirementId: entry.id },
          ),
        );
      }
      if (requirement.stories.length === 0) {
        findings.push(
          makeFinding(
            options,
            'PM-REQ',
            'story-tracker.json',
            `${entry.id} has no story mapping`,
            'Run cobolt-create-epics-and-stories or cobolt-rtm.js reconcile to map this requirement to build stories.',
            { requirementId: entry.id },
          ),
        );
      }
      if (requirement.tests.length === 0) {
        findings.push(
          makeFinding(
            options,
            'PM-REQ',
            'test-strategy.md',
            `${entry.id} has no acceptance/test strategy evidence`,
            'Regenerate test-strategy.md and RTM acceptance criteria for this requirement.',
            { requirementId: entry.id },
          ),
        );
      }
      for (const storyId of requirement.stories) {
        if (!storyById.has(storyId)) {
          findings.push(
            makeFinding(
              options,
              'PM-REQ',
              'story-tracker.json',
              `${entry.id} references missing story ${storyId}`,
              'Repair RTM/story-tracker parity so every referenced story exists.',
              { requirementId: entry.id, storyId },
            ),
          );
        }
      }
      for (const [category, refs, patterns] of maybeNa) {
        if (refs.length === 0 && hasDomainSignal(entry, patterns)) {
          findings.push(
            makeFinding(
              options,
              'PM-REQ',
              `${category === 'api' ? 'api-contracts.md' : category}.md`,
              `${entry.id} appears ${category}-relevant but has no ${category} forward evidence`,
              `Regenerate the ${category} planning artifact or add an explicit not-applicable reason.`,
              { requirementId: entry.id, category },
            ),
          );
        }
      }

      return requirement;
    }),
    findings,
  };
}

function extractAcceptanceCriteriaFromStoryFile(filePath) {
  const text = readText(filePath);
  if (!text) return [];
  const lines = [];
  let inSection = false;
  for (const line of text.split(/\r?\n/u)) {
    if (/^##+\s+Acceptance Criteria/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##+\s+/u.test(line)) break;
    if (inSection && /^\s*[-*]\s+/u.test(line)) lines.push(line.replace(/^\s*[-*]\s+/, '').trim());
  }
  return lines;
}

function collectStoryEvidence(projectRoot, planningDir, options = {}) {
  const tracker = readJson(path.join(planningDir, 'story-tracker.json'), null);
  const stories = Array.isArray(tracker?.stories) ? tracker.stories : [];
  const testStrategy = readText(path.join(planningDir, 'test-strategy.md'));
  const releaseReadiness = readText(path.join(planningDir, 'release-readiness-checklist.md'));
  const obligations = readJson(path.join(planningDir, 'milestone-execution-obligations.json'), null);
  const obligationStories = new Map(
    Object.values(obligations?.milestones || {})
      .flatMap((milestone) => milestone?.stories || [])
      .map((story) => [normalizeStoryId(story.storyId || story.id), story]),
  );
  const findings = [];
  const result = [];

  for (const raw of stories) {
    const id = normalizeStoryId(raw.id || raw.storyId) || String(raw.id || raw.storyId || '');
    if (!id) continue;
    const requirementIds = unique([
      ...(raw.requirementIds || []),
      ...(raw.frIds || []),
      ...(raw.nfrIds || []),
      ...(raw.trIds || []),
      ...(raw.irIds || []),
      ...(raw.requirements || []),
    ]).map((value) => String(value).toUpperCase());
    const storyFile = resolveStoryFile(id, planningDir, { planningDir });
    const fileAcceptance = extractAcceptanceCriteriaFromStoryFile(storyFile);
    const acceptanceCriteriaCount = Math.max(
      Array.isArray(raw.acceptanceCriteria) ? raw.acceptanceCriteria.length : 0,
      fileAcceptance.length,
    );
    const dependencyIds = unique([
      ...(raw.dependsOn || []),
      ...(raw.blockedBy || []),
      ...(raw.dependencies || []),
      ...(raw.tasks || []).flatMap((task) => task.dependsOn || task.blockedBy || []),
    ]);
    const storyPattern = new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const reqPattern = requirementIds.length
      ? new RegExp(
          `\\b(?:${requirementIds.map((req) => req.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
          'i',
        )
      : null;
    const testStrategyRefs = [];
    if (storyPattern.test(testStrategy)) testStrategyRefs.push('test-strategy.md:story');
    if (reqPattern?.test(testStrategy)) testStrategyRefs.push('test-strategy.md:requirements');

    const releaseOpsRefs = [];
    if (storyPattern.test(releaseReadiness)) releaseOpsRefs.push('release-readiness-checklist.md:story');
    if (reqPattern?.test(releaseReadiness)) releaseOpsRefs.push('release-readiness-checklist.md:requirements');
    const obligation = obligationStories.get(id);
    if (obligation) releaseOpsRefs.push('milestone-execution-obligations.json');
    if ((obligation?.runtimeOperations || []).length > 0) releaseOpsRefs.push('runtime-operations');

    const story = {
      id,
      milestone: raw.milestone || null,
      requirements: requirementIds,
      acceptanceCriteriaCount,
      implementationDependencies: {
        ids: dependencyIds,
        disposition: dependencyIds.length > 0 ? 'declared' : 'none-declared',
      },
      testStrategyRefs: unique(testStrategyRefs),
      releaseOpsRefs: unique(releaseOpsRefs),
      buildReady:
        requirementIds.length > 0 &&
        acceptanceCriteriaCount > 0 &&
        testStrategyRefs.length > 0 &&
        releaseOpsRefs.length > 0,
      storyFile: storyFile ? relativePath(projectRoot, storyFile) : null,
    };
    result.push(story);

    if (story.requirements.length === 0) {
      findings.push(
        makeFinding(
          options,
          'PM-STORY',
          'story-tracker.json',
          `${id} has no requirement mapping`,
          'Regenerate story-tracker.json from RTM so every build story carries requirement IDs.',
          { storyId: id },
        ),
      );
    }
    if (story.acceptanceCriteriaCount === 0) {
      findings.push(
        makeFinding(
          options,
          'PM-STORY',
          story.storyFile || 'stories/',
          `${id} has no acceptance criteria`,
          'Regenerate the story file with testable acceptance criteria.',
          { storyId: id },
        ),
      );
    }
    if (story.testStrategyRefs.length === 0) {
      findings.push(
        makeFinding(
          options,
          'PM-STORY',
          'test-strategy.md',
          `${id} has no test strategy reference`,
          'Regenerate test-strategy.md or milestone execution obligations with story/requirement test evidence.',
          { storyId: id },
        ),
      );
    }
    if (story.releaseOpsRefs.length === 0) {
      findings.push(
        makeFinding(
          options,
          'PM-STORY',
          'release-readiness-checklist.md',
          `${id} has no release/ops impact evidence`,
          'Regenerate release readiness and runtime operations planning for this story.',
          { storyId: id },
        ),
      );
    }
  }

  return { stories: result, findings };
}

function makeFinding(options, classId, artifactPath, evidence, remediationHint, extra = {}) {
  return {
    classId,
    severity: options.strict ? 'critical' : 'advisory',
    artifactPath: toPosix(artifactPath),
    evidence,
    remediationHint,
    ...extra,
  };
}

function collectRepairEvidence(projectRoot, planningDir, options = {}) {
  const { jsonlPath, summaryPath } = repairEvidencePaths(projectRoot, { planningDir });
  const planFixSummaryPath = path.join(planningDir, 'plan-fix-summary.json');
  const iterationsPath = path.join(projectRoot, '_cobolt-output', 'audit', 'plan-fix-iterations.jsonl');
  const records = fs.existsSync(jsonlPath)
    ? readText(jsonlPath)
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    : [];
  const findings = [];
  const repairRan = fs.existsSync(planFixSummaryPath) || fs.existsSync(iterationsPath);
  if (repairRan && records.length === 0) {
    findings.push(
      makeFinding(
        options,
        'PM-REPAIR',
        '_cobolt-output/audit/plan-fix-repair-evidence.jsonl',
        'plan-fix repair activity exists but no repair evidence records were emitted',
        'Record each plan-fix repair with before/after hashes, verifier before/after, and why the gate now passes.',
      ),
    );
  }
  return {
    repairEvidence: {
      jsonlPath: relativePath(projectRoot, jsonlPath),
      summaryPath: relativePath(projectRoot, summaryPath),
      recordCount: records.length,
      latestRecordAt: records.at(-1)?.at || null,
    },
    findings,
  };
}

function buildPlanningManifest(projectRoot = process.cwd(), options = {}) {
  const root = path.resolve(projectRoot);
  const planningDir = latestPlanningDir(root, { create: options.create === true });
  const deps = loadPlanningDependencies(root);
  const strict = options.strict === true;
  const artifactResult = collectArtifactEntries(root, planningDir, deps, {
    strict,
    assumeSelfPresent: options.assumeSelfPresent === true,
    selfHash: options.selfHash || null,
    selfSize: options.selfSize || 0,
  });
  const inputs = collectInputDocuments(root, planningDir, artifactResult.registry);
  const inputFindings = inputs
    .filter((input) => input.disposition === 'missing')
    .map((input) =>
      makeFinding(
        { strict },
        'PM-INPUT',
        'source-document-consolidation.md',
        `input document ${input.path} has no included/excluded/deferred SRC row`,
        'Regenerate source-document-consolidation.md from source-intake.json and add an explicit SRC disposition row for this input.',
        { inputPath: input.path },
      ),
    );
  const storyResult = collectStoryEvidence(root, planningDir, { strict });
  const storyById = new Map(storyResult.stories.map((story) => [story.id, story]));
  const requirementResult = collectRequirementEvidence(planningDir, storyById, { strict });
  const repairResult = collectRepairEvidence(root, planningDir, { strict });
  const findings = [
    ...artifactResult.findings,
    ...inputFindings,
    ...requirementResult.findings,
    ...storyResult.findings,
    ...repairResult.findings,
  ];
  const critical = findings.filter((finding) => finding.severity === 'critical').length;
  const advisory = findings.filter((finding) => finding.severity === 'advisory').length;
  const verdict = critical > 0 ? 'critical' : advisory > 0 ? 'advisory' : 'clean';
  const buildAuthorization = critical > 0 ? 'blocked' : 'authorized';

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy: TOOL_ID,
    projectRoot: root,
    planningDir: relativePath(root, planningDir) || '_cobolt-output/latest/planning',
    strict,
    summary: {
      verdict,
      buildAuthorization,
      critical,
      advisory,
      artifacts: artifactResult.artifacts.length,
      inputs: inputs.length,
      requirements: requirementResult.requirements.length,
      stories: storyResult.stories.length,
      repairEvidenceRecords: repairResult.repairEvidence.recordCount,
    },
    artifacts: artifactResult.artifacts,
    inputs,
    requirements: requirementResult.requirements,
    stories: storyResult.stories,
    repairEvidence: repairResult.repairEvidence,
    findings,
  };
}

function writeJson(filePath, data) {
  // Atomic: tmp + fsync + rename. Closes the race between the two sequential
  // manifest writes (lines ~821 and ~830) where a crash could leave the manifest
  // half-written and downstream consumers (build preflight) reading garbage.
  atomicWrite(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, encoding: 'utf8' });
}

function updatePlanningManifestGate(projectRoot, manifest, outputPath) {
  const statePath = path.join(projectRoot, 'cobolt-state.json');
  const state = readJson(statePath, {});
  const stat = fs.existsSync(outputPath) ? fs.statSync(outputPath) : null;
  const rel = relativePath(projectRoot, outputPath);
  const digest = sha256File(outputPath);
  state.gates = state.gates || {};
  state.gates['planning-manifest'] = {
    passed: manifest.summary.buildAuthorization === 'authorized',
    gate_name: 'planning-manifest',
    status: manifest.summary.verdict,
    buildAuthorization: manifest.summary.buildAuthorization,
    critical: manifest.summary.critical,
    advisory: manifest.summary.advisory,
    path: rel,
    sha256: digest,
    timestamp: new Date().toISOString(),
  };
  state.planningArtifacts = state.planningArtifacts || {};
  state.planningArtifacts[artifactIdToStateKey('planning-manifest')] = {
    exists: Boolean(stat),
    path: rel,
    size: stat?.size || 0,
    sha256: digest,
    producedBy: TOOL_ID,
    timestamp: state.gates['planning-manifest'].timestamp,
  };
  writeJson(statePath, state);
  return state.gates['planning-manifest'];
}

function generatePlanningManifest(projectRoot = process.cwd(), options = {}) {
  const root = path.resolve(projectRoot);
  const planningDir = latestPlanningDir(root, { create: true });
  const outputPath = options.outputPath || manifestPath(root, { planningDir });
  let manifest = buildPlanningManifest(root, { ...options, create: true, assumeSelfPresent: true });
  writeJson(outputPath, manifest);
  const stat = fs.statSync(outputPath);
  manifest = buildPlanningManifest(root, {
    ...options,
    create: true,
    assumeSelfPresent: true,
    selfHash: sha256File(outputPath),
    selfSize: stat.size,
  });
  writeJson(outputPath, manifest);
  const gate = updatePlanningManifestGate(root, manifest, outputPath);
  return { manifest, outputPath, gate };
}

function checkPlanningManifest(projectRoot = process.cwd(), options = {}) {
  const root = path.resolve(projectRoot);
  const fallbackPlanningDir = path.join(root, '_cobolt-output', 'latest', 'planning');
  const outputRoot = path.join(root, '_cobolt-output');
  const evidenceNames = [
    'planning-manifest.json',
    'prd.md',
    'source-document-consolidation.md',
    'rtm.json',
    'story-tracker.json',
  ];
  const hasDirectEvidence = evidenceNames.some((name) => fs.existsSync(path.join(fallbackPlanningDir, name)));
  let hasRunEvidence = false;
  const runsRoot = path.join(outputRoot, 'runs');
  try {
    for (const dateEntry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
      if (!dateEntry.isDirectory()) continue;
      const dateDir = path.join(runsRoot, dateEntry.name);
      for (const runEntry of fs.readdirSync(dateDir, { withFileTypes: true })) {
        if (!runEntry.isDirectory()) continue;
        const planningDir = path.join(dateDir, runEntry.name, 'planning');
        if (evidenceNames.some((name) => fs.existsSync(path.join(planningDir, name)))) {
          hasRunEvidence = true;
          break;
        }
      }
      if (hasRunEvidence) break;
    }
  } catch {
    hasRunEvidence = false;
  }
  if (!hasDirectEvidence && !hasRunEvidence) {
    return {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      generatedBy: TOOL_ID,
      projectRoot: root,
      planningDir: relativePath(root, fallbackPlanningDir),
      strict: options.strict === true,
      skipped: true,
      reason: 'planning directory not found',
      summary: {
        verdict: 'clean',
        buildAuthorization: 'authorized',
        critical: 0,
        advisory: 0,
        artifacts: 0,
        inputs: 0,
        requirements: 0,
        stories: 0,
        repairEvidenceRecords: 0,
      },
      artifacts: [],
      inputs: [],
      requirements: [],
      stories: [],
      findings: [],
      manifestPath: relativePath(root, path.join(fallbackPlanningDir, 'planning-manifest.json')),
      passed: true,
    };
  }
  const readablePlanningDir = resolveReadablePlanningDir(root, { allowLatestFallback: true });
  if (!readablePlanningDir && !fs.existsSync(path.join(fallbackPlanningDir, 'planning-manifest.json'))) {
    return {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      generatedBy: TOOL_ID,
      projectRoot: root,
      planningDir: relativePath(root, fallbackPlanningDir),
      strict: options.strict === true,
      skipped: true,
      reason: 'planning directory not found',
      summary: {
        verdict: 'clean',
        buildAuthorization: 'authorized',
        critical: 0,
        advisory: 0,
        artifacts: 0,
        inputs: 0,
        requirements: 0,
        stories: 0,
        repairEvidenceRecords: 0,
      },
      artifacts: [],
      inputs: [],
      requirements: [],
      stories: [],
      findings: [],
      manifestPath: relativePath(root, path.join(fallbackPlanningDir, 'planning-manifest.json')),
      passed: true,
    };
  }
  const planningDir = readablePlanningDir || latestPlanningDir(root, { create: false });
  const outputPath = manifestPath(root, { planningDir });
  const manifest = buildPlanningManifest(root, {
    ...options,
    assumeSelfPresent: fs.existsSync(outputPath),
    selfHash: sha256File(outputPath),
    selfSize: fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0,
  });
  return {
    ...manifest,
    manifestPath: relativePath(root, outputPath),
    passed: options.strict ? manifest.summary.critical === 0 : manifest.summary.verdict !== 'critical',
  };
}

function explainRequirement(projectRoot = process.cwd(), requirementId) {
  const manifest = buildPlanningManifest(projectRoot, { strict: false, assumeSelfPresent: true });
  const normalized = String(requirementId || '').toUpperCase();
  const requirement = manifest.requirements.find((entry) => entry.id === normalized);
  const findings = manifest.findings.filter(
    (finding) => String(finding.requirementId || '').toUpperCase() === normalized,
  );
  return {
    requirementId: normalized,
    found: Boolean(requirement),
    requirement: requirement || null,
    findings,
  };
}

function summarizeRepairEvidence(projectRoot, records, paths) {
  const summary = {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: TOOL_ID,
    recordCount: records.length,
    records,
  };
  writeJson(paths.summaryPath, summary);
  return {
    ...summary,
    jsonlPath: relativePath(projectRoot, paths.jsonlPath),
    summaryPath: relativePath(projectRoot, paths.summaryPath),
  };
}

function recordRepairEvidence(projectRoot = process.cwd(), record = {}) {
  const root = path.resolve(projectRoot);
  const planningDir = latestPlanningDir(root, { create: true });
  const paths = repairEvidencePaths(root, { planningDir });
  const changedArtifacts = unique(record.changedArtifacts || record.changed || []).map((artifactPath) => {
    const absolutePath = path.isAbsolute(artifactPath) ? artifactPath : path.join(root, artifactPath);
    return {
      path: toPosix(path.isAbsolute(artifactPath) ? path.relative(root, artifactPath) : artifactPath),
      beforeSha256: record.beforeHashes?.[artifactPath] || null,
      afterSha256: sha256File(absolutePath),
      exists: fs.existsSync(absolutePath),
    };
  });
  const entry = {
    schemaVersion: '1.0.0',
    at: new Date().toISOString(),
    finding: record.finding || null,
    repairAction: record.repairAction || record.action || 'unspecified',
    changedArtifacts,
    verifierBefore: record.verifierBefore || null,
    verifierAfter: record.verifierAfter || null,
    whyGatePasses: record.whyGatePasses || record.why || '',
  };
  fs.mkdirSync(path.dirname(paths.jsonlPath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(paths.jsonlPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  const records = readText(paths.jsonlPath)
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const summary = summarizeRepairEvidence(root, records, paths);
  return { entry, summary };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] || 'help',
    projectRoot: process.cwd(),
    json: false,
    strict: false,
    requirementId: null,
    outputPath: null,
    findingJson: null,
    action: null,
    why: null,
    changed: [],
    verifierBefore: null,
    verifierAfter: null,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project' || arg === '--cwd' || arg === '--dir') args.projectRoot = path.resolve(argv[++index]);
    else if (arg === '--json') args.json = true;
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--output' || arg === '--out') args.outputPath = path.resolve(argv[++index]);
    else if (arg === '--requirement') args.requirementId = argv[++index];
    else if (arg === '--finding-json') args.findingJson = path.resolve(argv[++index]);
    else if (arg === '--action') args.action = argv[++index];
    else if (arg === '--why') args.why = argv[++index];
    else if (arg === '--changed') args.changed = unique((argv[++index] || '').split(','));
    else if (arg === '--verifier-before') args.verifierBefore = argv[++index];
    else if (arg === '--verifier-after') args.verifierAfter = argv[++index];
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    `CoBolt Planning Manifest\n\n` +
      `Usage:\n` +
      `  node tools/cobolt-planning-manifest.js generate [--project <dir>] [--strict] [--json]\n` +
      `  node tools/cobolt-planning-manifest.js check [--project <dir>] [--strict] [--json]\n` +
      `  node tools/cobolt-planning-manifest.js explain --requirement <REQ-ID> [--project <dir>] [--json]\n` +
      `  node tools/cobolt-planning-manifest.js repair-evidence --finding-json <path> --action <text> --why <text> --changed <a,b> [--json]\n`,
  );
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help' || argv.length === 0) {
    printHelp();
    return EXIT_OK;
  }
  const args = parseArgs(argv);
  if (args.command === 'generate') {
    const result = generatePlanningManifest(args.projectRoot, {
      strict: args.strict,
      outputPath: args.outputPath,
    });
    const envelope = {
      ...result.manifest,
      manifestPath: relativePath(path.resolve(args.projectRoot), result.outputPath),
      gate: result.gate,
      passed: args.strict ? result.manifest.summary.critical === 0 : true,
    };
    if (args.json) process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    else process.stdout.write(`[planning-manifest] ${envelope.summary.verdict} -> ${envelope.manifestPath}\n`);
    return envelope.passed ? EXIT_OK : EXIT_FAIL;
  }
  if (args.command === 'check') {
    const result = checkPlanningManifest(args.projectRoot, { strict: args.strict });
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else
      process.stdout.write(
        `[planning-manifest] ${result.summary.verdict} (${result.summary.critical} critical, ${result.summary.advisory} advisory)\n`,
      );
    if (result.skipped) return EXIT_USAGE;
    return result.passed ? EXIT_OK : EXIT_FAIL;
  }
  if (args.command === 'explain') {
    if (!args.requirementId) {
      process.stderr.write('ERROR: --requirement is required for explain\n');
      return EXIT_USAGE;
    }
    const result = explainRequirement(args.projectRoot, args.requirementId);
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`${result.requirementId}: ${result.found ? 'found' : 'missing'}\n`);
    return result.found ? EXIT_OK : EXIT_FAIL;
  }
  if (args.command === 'repair-evidence') {
    const finding = args.findingJson ? readJson(args.findingJson, null) : null;
    const result = recordRepairEvidence(args.projectRoot, {
      finding,
      action: args.action,
      why: args.why,
      changed: args.changed,
      verifierBefore: args.verifierBefore,
      verifierAfter: args.verifierAfter,
    });
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`[planning-manifest] repair evidence recorded (${result.summary.recordCount} total)\n`);
    return EXIT_OK;
  }
  process.stderr.write(`ERROR: unknown command: ${args.command}\n`);
  printHelp();
  return EXIT_USAGE;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  buildPlanningManifest,
  checkPlanningManifest,
  explainRequirement,
  generatePlanningManifest,
  manifestPath,
  recordRepairEvidence,
  repairEvidencePaths,
  sha256File,
};
