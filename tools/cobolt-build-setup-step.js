#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateBuildPacket } = require('../lib/cobolt-build-packet-check');
const { projectExecutionLedger, syncBuildExecutionLedger } = require('../lib/cobolt-execution-ledger');
const { writePlanIngestionManifest } = require('./cobolt-plan-ingestion-manifest');
const { writeBuildPacketFreshnessSnapshot } = require('./cobolt-build-packet-freshness');
// `cobolt-build-packet-rank` is required lazily inside `rankPacketAndRender`
// so tests can replace `applySectionBudget` via `require.cache` to exercise
// the Tier-3 advisory degrade path. Same pattern as `cobolt-wireframe-resolver`
// usage below.

function normalizeMilestone(value) {
  const match = String(value || '')
    .trim()
    .match(/^M?(\d+)$/i);
  return match ? `M${Number.parseInt(match[1], 10)}` : null;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] || 'run',
    milestone: null,
    json: false,
    timeoutMs: 10 * 60 * 1000,
  };
  if (argv.includes('--help') || argv.includes('-h')) args.command = 'help';
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--milestone' || arg === '-m') args.milestone = normalizeMilestone(argv[++i]);
    else if (arg === '--json') args.json = true;
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i] || args.timeoutMs);
  }
  return args;
}

function writeFile(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode });
}

function writeJson(filePath, payload) {
  writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function decodeText(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(String(buffer || ''), 'utf8');
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer
      .subarray(2)
      .toString('utf16le')
      .replace(/^\uFEFF/u, '');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.alloc(buffer.length - 2);
    for (let i = 2; i + 1 < buffer.length; i += 2) {
      swapped[i - 2] = buffer[i + 1];
      swapped[i - 1] = buffer[i];
    }
    return swapped.toString('utf16le').replace(/^\uFEFF/u, '');
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  return buffer.toString('utf8').replace(/^\uFEFF/u, '');
}

function readText(filePath, fallback = '') {
  try {
    return decodeText(fs.readFileSync(filePath));
  } catch {
    return fallback;
  }
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(readText(filePath));
  } catch {
    return fallback;
  }
}

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

function dedupeByKey(items, keyFn) {
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

function loadExecutionObligations(planDir, milestone = null) {
  const filePath = path.join(planDir, 'milestone-execution-obligations.json');
  const document = readJson(filePath, null);
  const milestoneEntry = Array.isArray(document?.milestones)
    ? document.milestones.find(
        (entry) => String(entry.id || '').toUpperCase() === String(milestone || '').toUpperCase(),
      )
    : null;
  return {
    path: filePath,
    document,
    milestone: milestoneEntry || null,
  };
}

function summarizeExecutionObligations(executionObligations) {
  const document = executionObligations?.document || null;
  const milestone = executionObligations?.milestone || null;
  return {
    path: executionObligations?.path || null,
    status: document?.status || null,
    summary: document?.summary || null,
    driftSummary: document?.driftSummary || null,
    milestone: milestone
      ? {
          id: milestone.id,
          title: milestone.title,
          storyCount: milestone.storyCount,
          carryForwardCount: Array.isArray(milestone.carryForward) ? milestone.carryForward.length : 0,
          launchBlockerCount: Array.isArray(milestone.launchBlockers) ? milestone.launchBlockers.length : 0,
        }
      : null,
  };
}

function projectPath(projectRoot, ...parts) {
  return path.join(projectRoot, ...parts);
}

function buildDir(projectRoot, milestone) {
  return projectPath(projectRoot, '_cobolt-output', 'latest', 'build', milestone);
}

function planningDir(projectRoot) {
  return projectPath(projectRoot, '_cobolt-output', 'latest', 'planning');
}

function resolveToolsDir(projectRoot) {
  if (process.env.COBOLT_TOOLS && fs.existsSync(path.join(process.env.COBOLT_TOOLS, 'cobolt-preflight.js'))) {
    return process.env.COBOLT_TOOLS;
  }
  const marker = readJson(projectPath(projectRoot, '_cobolt-output', '.tool-paths.json'), null);
  if (marker?.toolsDir && fs.existsSync(path.join(marker.toolsDir, 'cobolt-preflight.js'))) return marker.toolsDir;
  return path.resolve(__dirname);
}

function runContextTool(projectRoot, milestone, toolsDir, timeoutMs) {
  const toolPath = path.join(toolsDir, 'cobolt-preflight.js');
  const result = spawnSync(
    process.execPath,
    [toolPath, 'context', 'cobolt-build', '--milestone', milestone, '--json'],
    {
      cwd: projectRoot,
      encoding: 'buffer',
      timeout: timeoutMs,
      windowsHide: true,
      env: {
        ...process.env,
        COBOLT_TOOLS: toolsDir,
        COBOLT_TOOLS_DIR: toolsDir,
      },
    },
  );
  if ((result.status ?? 1) !== 0) {
    const stderr = decodeText(result.stderr || Buffer.alloc(0)).trim();
    throw new Error(stderr || result.error?.message || `cobolt-preflight context exited ${result.status}`);
  }
  return JSON.parse(decodeText(result.stdout || Buffer.alloc(0)));
}

function slug(value) {
  const text = String(value || '')
    .replace(/[^A-Za-z0-9]+/g, '')
    .trim();
  return text || 'MilestoneTask';
}

function parseFileMap(specText) {
  const filesByTask = {};
  const lines = String(specText || '').split(/\r?\n/u);
  let inMap = false;
  for (const line of lines) {
    if (/^\s*###\s+File Map/i.test(line)) {
      inMap = true;
      continue;
    }
    if (inMap && /^###\s+/u.test(line)) break;
    if (!inMap || !/^\s*\|/u.test(line) || /---/u.test(line) || /Action/i.test(line)) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const file = cells[1];
    const task = cells[2];
    if (!file || !task || !/^T\d+/i.test(task)) continue;
    filesByTask[task.toUpperCase()] = filesByTask[task.toUpperCase()] || [];
    filesByTask[task.toUpperCase()].push(file.replaceAll('\\', '/'));
  }
  return filesByTask;
}

function defaultFilesForTask(story, task, profile = {}) {
  const titleSlug = slug(story.title);
  const local = String(task.localTaskId || task.id || '').toUpperCase();
  const featureSlug = titleSlug.charAt(0).toLowerCase() + titleSlug.slice(1);
  const frontendExt = profile.frontendExt || 'tsx';
  const backendExt = profile.backendExt || 'ts';
  const testExt = profile.testExt || 'test.ts';
  if (local === 'T01') {
    return [
      `src/features/${featureSlug}/${featureSlug}.${frontendExt}`,
      `src/features/${featureSlug}/${featureSlug}.route.${backendExt}`,
    ];
  }
  if (local === 'T02') {
    return [`src/features/${featureSlug}/${featureSlug}.service.${backendExt}`];
  }
  return [`tests/${featureSlug}.${testExt}`];
}

function assignedAgentForTask(task) {
  const local = String(task.localTaskId || task.id || '').toUpperCase();
  if (local === 'T01') return 'frontend-dev';
  if (local === 'T02') return 'backend-dev';
  if (local === 'T03') return 'test-writer';
  return 'cobolt-build-lead';
}

function extractAcceptanceCriteria(storyFilePath) {
  const text = readText(storyFilePath);
  const lines = [];
  let inSection = false;
  for (const line of text.split(/\r?\n/u)) {
    if (/^##\s+Acceptance Criteria/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/u.test(line)) break;
    if (inSection && /^\s*-\s+/u.test(line)) lines.push(line.replace(/^\s*-\s+/u, '').trim());
  }
  return lines;
}

function featureIdsForStory(story) {
  const ids = new Set(story.featureIds || story.features || []);
  for (const task of story.tasks || []) {
    const match = String(task.description || '').match(/FEAT-\d{3}/giu);
    for (const id of match || []) ids.add(id.toUpperCase());
  }
  return [...ids];
}

function buildCapabilityEdges(_context, stories) {
  const edges = [];
  const surfaces = ['settings', 'dashboard', 'privacy', 'observability', 'data', 'ui', 'tests', 'accessibility'];
  for (const story of stories) {
    const featureIds = featureIdsForStory(story);
    const taskIds = (story.tasks || []).map((task) => task.taskId || `${story.id}:${task.localTaskId || task.id}`);
    for (const featureId of featureIds.length ? featureIds : [`${story.id}-capability`]) {
      for (const surface of surfaces) {
        edges.push({
          featureId,
          featureTitle: story.title,
          surface,
          status: ['ui', 'tests', 'accessibility', 'data'].includes(surface) ? 'impacts' : 'verify_no_change',
          requiredProof: [`${surface} proof for ${featureId}`],
          assignedTaskIds: taskIds,
        });
      }
    }
  }
  return edges;
}

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function firstExistingFile(baseDir, candidateNames = []) {
  for (const candidateName of candidateNames) {
    if (!candidateName) continue;
    const absolutePath = path.join(baseDir, candidateName);
    if (fs.existsSync(absolutePath)) {
      return { exists: true, absolutePath, relativePath: toPosix(candidateName) };
    }
  }

  const fallback = candidateNames[0] || '';
  return {
    exists: false,
    absolutePath: path.join(baseDir, fallback),
    relativePath: toPosix(fallback),
  };
}

function readPlanningText(planDir, candidateNames = []) {
  const resolved = firstExistingFile(planDir, candidateNames);
  return {
    ...resolved,
    text: resolved.exists ? readText(resolved.absolutePath) : '',
  };
}

function readPlanningJson(planDir, candidateNames = []) {
  const resolved = firstExistingFile(planDir, candidateNames);
  return {
    ...resolved,
    json: resolved.exists ? readJson(resolved.absolutePath, null) : null,
  };
}

function relativeArtifactPath(baseDir, filePath) {
  if (!filePath) return null;
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(baseDir, filePath);
  return toPosix(path.relative(baseDir, absolutePath));
}

function normalizeFeatureId(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function extractMatchingTerms(text, candidates) {
  const found = [];
  for (const candidate of candidates) {
    if (candidate.pattern.test(text)) found.push(candidate.label);
  }
  return unique(found);
}

function extractBulletLines(text, patterns, limit) {
  const lines = [];
  for (const line of String(text || '').split(/\r?\n/u)) {
    const cleaned = line.replace(/^\s*[-*]\s+/, '').trim();
    if (!cleaned || cleaned.length < 24 || cleaned.length > 220) continue;
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

const COMPLIANCE_FRAMEWORK_PATTERNS = [
  { label: 'GDPR', pattern: /\bGDPR\b/i },
  { label: 'SOC2', pattern: /\bSOC\s*2\b/i },
  { label: 'HIPAA', pattern: /\bHIPAA\b/i },
  { label: 'DPDP', pattern: /\bDPDP\b/i },
  { label: 'PCI DSS', pattern: /\bPCI(?:-|\s)?DSS\b|\bPCI\b/i },
  { label: 'FedRAMP', pattern: /\bFedRAMP\b/i },
  { label: 'ISO 27001', pattern: /\bISO\s*27001\b/i },
  { label: 'CCPA', pattern: /\bCCPA\b/i },
  { label: 'LGPD', pattern: /\bLGPD\b/i },
];

function summarizeCapabilityContractCatalog(planDir) {
  const indexDoc = readPlanningJson(planDir, ['capability-contracts-index.json']);
  const contracts = Array.isArray(indexDoc.json?.contracts) ? indexDoc.json.contracts : [];
  return {
    present: indexDoc.exists && contracts.length > 0,
    path: indexDoc.relativePath,
    totalFeatures: Number(indexDoc.json?.totalFeatures || contracts.length || 0),
    readyCount: contracts.filter((entry) => String(entry.status || '').toUpperCase() === 'READY').length,
    contracts: contracts
      .map((entry) => ({
        featureId: normalizeFeatureId(entry.featureId),
        status: String(entry.status || 'UNKNOWN').toUpperCase(),
        evidenceLevel: entry.evidenceLevel || 'unknown',
        operationCount: Number(entry.operationCount || 0),
        invariantCount: Number(entry.invariantCount || 0),
        stateMachineCount: Number(entry.stateMachineCount || 0),
        path: relativeArtifactPath(planDir, entry.path),
        gaps: Array.isArray(entry.gaps) ? entry.gaps.slice(0, 2) : [],
      }))
      .filter((entry) => entry.featureId),
  };
}

function capabilityContractsForFeatures(catalog, featureIds = []) {
  const wanted = new Set((featureIds || []).map(normalizeFeatureId).filter(Boolean));
  if (wanted.size === 0) return [];
  return (catalog?.contracts || []).filter((entry) => wanted.has(entry.featureId));
}

function summarizeComplianceContext(planDir) {
  const jsonDoc = readPlanningJson(planDir, ['compliance-register.json']);
  const markdownDoc = readPlanningText(planDir, ['compliance-register.md']);
  const payload = jsonDoc.json || {};
  const combined = `${markdownDoc.text}\n${JSON.stringify(payload)}`;
  const frameworks = unique([
    ...(Array.isArray(payload.frameworks)
      ? payload.frameworks.map((entry) =>
          typeof entry === 'string' ? entry : entry?.id || entry?.framework || entry?.name || entry?.label,
        )
      : []),
    ...extractMatchingTerms(combined, COMPLIANCE_FRAMEWORK_PATTERNS),
  ]);
  const controls = Array.isArray(payload.controls) ? payload.controls : [];
  const activeControls = controls.filter(
    (control) => !/(?:not[_ -]?applicable|n\/a)/i.test(String(control.status || '')),
  );
  const obligations = controls.slice(0, 8).map((control, index) => ({
    id: control.id || control.controlId || `CTRL-${String(index + 1).padStart(3, '0')}`,
    framework: control.framework || control.frameworkId || frameworks[0] || 'general',
    owner: control.componentOwner || control.owner || null,
    status: control.status || null,
    acceptance:
      control.acceptanceCriterion || control.acceptance || control.summary || control.implementationPattern || null,
    evidenceSource: control.evidenceSource || control.evidence || null,
  }));
  return {
    present: jsonDoc.exists || markdownDoc.exists,
    path: jsonDoc.exists ? jsonDoc.relativePath : markdownDoc.relativePath,
    markdownPath: markdownDoc.exists ? markdownDoc.relativePath : null,
    frameworks,
    dataCategories: unique(
      (Array.isArray(payload.dataCategories) ? payload.dataCategories : []).map((entry) =>
        typeof entry === 'string' ? entry : entry?.name || entry?.label || entry?.category,
      ),
    ),
    controlCount: controls.length,
    activeControlCount: activeControls.length,
    obligations,
    coverage: payload.coverage || null,
  };
}

function summarizeDomainVocabulary(planDir) {
  const doc = readPlanningText(planDir, ['domain-knowledge-base.md', 'domain-knowledge.md']);
  const terms = [];
  for (const match of doc.text.matchAll(/\*\*([^*]{2,40})\*\*/g)) {
    terms.push(match[1]);
  }
  for (const line of doc.text.split(/\r?\n/u)) {
    const colonMatch = line.match(/^\s*[-*]?\s*`?([A-Za-z][A-Za-z0-9/&() +_-]{2,40})`?\s*:/u);
    if (colonMatch) terms.push(colonMatch[1]);
  }
  return {
    present: doc.exists && doc.text.trim().length > 0,
    path: doc.relativePath,
    terms: unique(terms).slice(0, 12),
  };
}

// Heuristic match between a wireframe per-surface filename slug (e.g. the
// "gallery" in 01-gallery.md) and a Phase-5 app-surface-contract surfaceId
// (e.g. "S-GALLERY"). Wireframe filenames are authored alongside the surface
// contract by cobolt-create-wireframes; we lowercase both ends and strip the
// single-letter category prefix on the surfaceId. The match is deliberately
// permissive (substring either direction) so file slugs like "gallery-detail"
// still bind to "S-GALLERY-DETAIL".
function surfaceIdMatchesWireframeSlug(surfaceId, wireframeFileSlug) {
  if (!surfaceId || !wireframeFileSlug) return false;
  const tail = String(surfaceId)
    .replace(/^[A-Z]+-/u, '')
    .toLowerCase();
  const wf = String(wireframeFileSlug).toLowerCase();
  if (!tail || !wf) return false;
  if (tail === wf) return true;
  return tail.includes(wf) || wf.includes(tail);
}

// Build-packet enrichment for v0.59.0+ per-surface wireframes. Reads each
// per-surface file via the resolver, intersects with the milestone-scoped
// surface map (when present), and emits a summary suitable for inlining in
// the build packet so frontend builders inherit per-surface context without
// a "READ file X" instruction (Inv-9). Body cap rule (confirmed by user):
// always inline the first-screen-block + cross-surface-flows; include the
// full body ONLY when the milestone-scoped surface count is <=3 (keeps the
// packet tractable on milestones with many surfaces).
function summarizeWireframeSurfacesForMilestone(planDir, milestone) {
  const wireframeResolver = require('../lib/cobolt-wireframe-resolver');
  const surfaceMapTool = require('./cobolt-surface-map');
  const projectCwd = path.resolve(planDir, '..', '..', '..');

  const allSurfaceFiles = wireframeResolver.readSurfaceFiles({ cwd: projectCwd });
  const discoveryPlan = wireframeResolver.discoverWireframeArtifacts({ cwd: projectCwd });
  if (allSurfaceFiles.length === 0) {
    return {
      present: false,
      mode: discoveryPlan.mode,
      surfaceCount: 0,
      milestoneScoped: false,
      fullBodyIncluded: false,
      surfaces: [],
    };
  }

  const milestoneScope =
    milestone && typeof milestone === 'string'
      ? surfaceMapTool.getSurfacesForMilestone({ cwd: projectCwd, milestone })
      : { surfaces: [], present: false, milestoneFound: false };

  const milestoneScoped = Boolean(milestoneScope.present && milestoneScope.milestoneFound);

  function slugOf(name) {
    const m = /^(\d{2})-(.+)\.md$/u.exec(name);
    return m ? m[2] : '';
  }

  const matchedSurfaces = [];
  for (const file of allSurfaceFiles) {
    const wireframeSlug = slugOf(file.name);
    const matchedFrIds = [];
    let inScope = !milestoneScoped; // when no scope info, include everything
    if (milestoneScoped) {
      const matchedSurfaceEntries = milestoneScope.surfaces.filter((s) =>
        surfaceIdMatchesWireframeSlug(s.slug, wireframeSlug),
      );
      if (matchedSurfaceEntries.length > 0) {
        inScope = true;
        for (const matched of matchedSurfaceEntries) {
          for (const fr of matched.frIds || []) if (!matchedFrIds.includes(fr)) matchedFrIds.push(fr);
        }
      }
    }
    if (!inScope) continue;
    matchedSurfaces.push({ file, frIds: matchedFrIds, wireframeSlug });
  }

  const fullBodyIncluded = matchedSurfaces.length > 0 && matchedSurfaces.length <= 3;

  return {
    present: matchedSurfaces.length > 0,
    mode: discoveryPlan.mode,
    rootPath: discoveryPlan.root ? path.relative(projectCwd, discoveryPlan.root) : null,
    surfaceCount: matchedSurfaces.length,
    totalSurfacesOnDisk: allSurfaceFiles.length,
    milestoneScoped,
    milestoneFound: milestoneScope.milestoneFound || false,
    fullBodyIncluded,
    surfaces: matchedSurfaces.map(({ file, frIds, wireframeSlug }) => ({
      id: file.id,
      name: file.name,
      slug: wireframeSlug,
      relativePath: path.relative(projectCwd, file.path),
      frIds,
      firstScreenBlock: wireframeResolver.extractFirstScreenBlock(file.content) || '',
      crossSurfaceFlows: wireframeResolver.extractCrossSurfaceFlows(file.content) || '',
      fullBody: fullBodyIncluded ? file.content : null,
    })),
  };
}

function summarizeWireframeCues(planDir) {
  // v2.1+: wireframes fan out into per-surface files under planning/wireframes/.
  // The merged wireframes-and-user-flows.md is now a thin TOC and lacks the
  // per-screen detail cues used to live in. Use the resolver to scan all
  // surface files; fall back to the merged file when only the legacy layout
  // is present.
  const wireframeResolver = require('../lib/cobolt-wireframe-resolver');
  // planDir is `_cobolt-output/latest/planning/`; the resolver wants the
  // project cwd, which is two levels up.
  const projectCwd = path.resolve(planDir, '..', '..', '..');
  const concatenated = wireframeResolver.readAllWireframeContent({
    cwd: projectCwd,
    includeFoundations: false, // foundations is reference; it doesn't add screen cues
    includeReadme: true,
  });

  let docText = concatenated;
  let docExists = concatenated.trim().length > 0;
  let docRelativePath = 'wireframes/ (per-surface)';

  if (!docExists) {
    const doc = readPlanningText(planDir, ['wireframes-and-user-flows.md']);
    docText = doc.text;
    docExists = doc.exists && doc.text.trim().length > 0;
    docRelativePath = doc.relativePath;
  }

  const headings = docText
    .split(/\r?\n/u)
    .filter((line) => /^#{2,4}\s+/.test(line))
    .map((line) => line.replace(/^#{2,4}\s+/u, '').trim())
    .slice(0, 8);
  const cues = extractBulletLines(
    docText,
    [/screen/i, /page/i, /flow/i, /state/i, /loading/i, /error/i, /empty/i, /dialog/i, /modal/i, /form/i],
    10,
  );
  return {
    present: docExists,
    path: docRelativePath,
    headings,
    cues,
  };
}

function inferProjectProfile(_projectRoot, planDir, executionObligations = null) {
  const dataModelDoc = readPlanningText(planDir, ['data-model-spec.md', 'data-model.md']);
  const domainKnowledgeDoc = readPlanningText(planDir, ['domain-knowledge-base.md', 'domain-knowledge.md']);
  // v2.1+: prefer per-surface wireframe content for project-profile inference;
  // fall back to merged file when only the legacy layout exists.
  const wireframeDoc = (() => {
    const wireframeResolver = require('../lib/cobolt-wireframe-resolver');
    const projectCwd = path.resolve(planDir, '..', '..', '..');
    const concatenated = wireframeResolver.readAllWireframeContent({
      cwd: projectCwd,
      includeFoundations: false,
      includeReadme: true,
    });
    if (concatenated.trim().length > 0) {
      return { exists: true, text: concatenated, relativePath: 'wireframes/ (per-surface)' };
    }
    return readPlanningText(planDir, ['wireframes-and-user-flows.md']);
  })();
  const complianceDoc = readPlanningText(planDir, ['compliance-register.md']);
  const capabilityContractCatalog = summarizeCapabilityContractCatalog(planDir);
  const complianceContext = summarizeComplianceContext(planDir);
  const domainVocabulary = summarizeDomainVocabulary(planDir);
  const wireframeCues = summarizeWireframeCues(planDir);
  const docs = {
    architecture: readText(path.join(planDir, 'architecture.md')),
    systemArchitecture: readText(path.join(planDir, 'system-architecture.md')),
    projectKnowledge: readText(path.join(planDir, 'project-knowledge-base.md')),
    trd: readText(path.join(planDir, 'trd.md')),
    dataModel: dataModelDoc.text,
    domainKnowledge: domainKnowledgeDoc.text,
    wireframes: wireframeDoc.text,
    compliance: complianceDoc.text,
    security: readText(path.join(planDir, 'security-requirements.md')),
    secureCoding: readText(path.join(planDir, 'secure-coding-standard.md')),
    testStrategy: readText(path.join(planDir, 'test-strategy.md')),
    skills: readText(path.join(planDir, 'project-skills-manifest.md')),
  };
  const combined = Object.values(docs).join('\n');

  const languages = extractMatchingTerms(combined, [
    { label: 'TypeScript', pattern: /\bTypeScript\b/i },
    { label: 'JavaScript', pattern: /\bJavaScript\b/i },
    { label: 'Python', pattern: /\bPython\b/i },
    { label: 'C#', pattern: /\bC#\b|\.NET/i },
    { label: 'Go', pattern: /\bGolang\b|\bGo\b/i },
    { label: 'Java', pattern: /\bJava\b/i },
    { label: 'Rust', pattern: /\bRust\b/i },
  ]);
  const frameworks = extractMatchingTerms(combined, [
    { label: 'React', pattern: /\bReact\b/i },
    { label: 'Vite', pattern: /\bVite\b/i },
    { label: 'Next.js', pattern: /\bNext\.?js\b/i },
    { label: 'FastAPI', pattern: /\bFastAPI\b/i },
    { label: 'Express', pattern: /\bExpress\b/i },
    { label: 'Django', pattern: /\bDjango\b/i },
    { label: 'Vue', pattern: /\bVue\b/i },
    { label: 'Svelte', pattern: /\bSvelte\b/i },
  ]);
  const databases = extractMatchingTerms(combined, [
    { label: 'PostgreSQL', pattern: /\bPostgreSQL\b|\bPostgres\b/i },
    { label: 'Redis', pattern: /\bRedis\b/i },
    { label: 'MySQL', pattern: /\bMySQL\b/i },
    { label: 'SQLite', pattern: /\bSQLite\b/i },
    { label: 'MongoDB', pattern: /\bMongoDB\b/i },
  ]);
  const libraries = extractMatchingTerms(combined, [
    { label: 'Tailwind CSS', pattern: /\bTailwind\b/i },
    { label: 'shadcn/ui', pattern: /\bshadcn\b/i },
    { label: 'SQLAlchemy', pattern: /\bSQLAlchemy\b/i },
    { label: 'Pydantic', pattern: /\bPydantic\b/i },
    { label: 'Cloudflare R2', pattern: /\bCloudflare\s+R2\b/i },
    { label: 'Cloudflare Stream', pattern: /\bCloudflare\s+Stream\b/i },
  ]);
  const testFrameworks = extractMatchingTerms(combined, [
    { label: 'Playwright', pattern: /\bPlaywright\b/i },
    { label: 'Vitest', pattern: /\bVitest\b/i },
    { label: 'pytest', pattern: /\bpytest\b/i },
    { label: 'axe-core', pattern: /\baxe(?:-core)?\b/i },
    { label: 'Jest', pattern: /\bJest\b/i },
  ]);

  const frontendExt = /React|Vite|Next\.js/i.test(frameworks.join(' ')) ? 'tsx' : 'ts';
  const backendExt = /FastAPI|Python|pytest/i.test([...frameworks, ...languages, ...testFrameworks].join(' '))
    ? 'py'
    : 'ts';
  const testExt = backendExt === 'py' && !/React|Vite|Next\.js/i.test(frameworks.join(' ')) ? 'test.py' : 'test.ts';

  const explicitSecurityInvariants = Array.isArray(executionObligations?.document?.securityInvariants)
    ? executionObligations.document.securityInvariants
    : [];
  const explicitRequiredTestEvidence = Array.isArray(executionObligations?.document?.requiredTestEvidence)
    ? executionObligations.document.requiredTestEvidence
    : [];
  const obligationGuidance = Array.isArray(executionObligations?.document?.handoffGuidance)
    ? executionObligations.document.handoffGuidance.join('\n')
    : '';

  const securityInvariants = extractBulletLines(
    `${docs.security}\n${docs.secureCoding}`,
    [/auth/i, /tenant/i, /workspace/i, /encrypt/i, /audit/i, /privacy/i, /rate/i, /token/i, /rls/i],
    8,
  );
  const requiredSecurityInvariants = inferRequiredSecurityInvariants(`${docs.security}\n${docs.secureCoding}`);
  const requiredTestEvidence = extractBulletLines(
    docs.testStrategy,
    [/unit/i, /integration/i, /e2e/i, /accessibility/i, /security/i, /performance/i, /observability/i, /contract/i],
    8,
  );
  const supplementalGuidance = [];
  if (capabilityContractCatalog.present) {
    supplementalGuidance.push(
      `Capability contracts: ${capabilityContractCatalog.readyCount}/${capabilityContractCatalog.totalFeatures || capabilityContractCatalog.contracts.length} features are contract-ready via ${capabilityContractCatalog.path}.`,
    );
  }
  if (complianceContext.present) {
    supplementalGuidance.push(
      `Compliance grounding: ${complianceContext.frameworks.join(', ') || 'frameworks declared in compliance-register'} with ${complianceContext.activeControlCount}/${complianceContext.controlCount} active control entries.`,
    );
  }
  if (domainVocabulary.terms.length > 0) {
    supplementalGuidance.push(`Domain vocabulary to preserve: ${domainVocabulary.terms.join(', ')}.`);
  }
  if (wireframeCues.present) {
    supplementalGuidance.push(
      `Wireframe fidelity cues from ${wireframeCues.path}: ${(wireframeCues.headings || []).join(', ') || (wireframeCues.cues || []).join(', ')}.`,
    );
  }

  return {
    techStack: {
      languages: languages.length ? languages : ['See architecture.md'],
      frameworks: frameworks.length ? frameworks : ['See architecture.md'],
      databases: databases.length ? databases : [`See ${dataModelDoc.relativePath || 'data-model-spec.md'}`],
      libraries: libraries.length ? libraries : ['See architecture.md and dependency-register.md'],
      testFrameworks: testFrameworks.length ? testFrameworks : ['See test-strategy.md'],
    },
    frontendExt,
    backendExt,
    testExt,
    dataModelPath: dataModelDoc.relativePath || 'data-model-spec.md',
    securityInvariants:
      explicitSecurityInvariants.length > 0
        ? explicitSecurityInvariants
        : mergeSecurityInvariants(
            requiredSecurityInvariants,
            securityInvariants.length
              ? securityInvariants.map((summary, index) => ({
                  id: `security-${String(index + 1).padStart(2, '0')}`,
                  summary,
                  source: 'security-requirements.md / secure-coding-standard.md',
                }))
              : [
                  {
                    id: 'security-planning-contract',
                    summary:
                      'Implement the concrete controls required by security-requirements.md and secure-coding-standard.md.',
                    source: 'security-requirements.md / secure-coding-standard.md',
                  },
                ],
          ),
    requiredTestEvidence:
      explicitRequiredTestEvidence.length > 0
        ? explicitRequiredTestEvidence
        : requiredTestEvidence.length
          ? requiredTestEvidence.map((summary, index) => ({
              id: `test-${String(index + 1).padStart(2, '0')}`,
              summary,
            }))
          : [
              {
                id: 'story-acceptance-evidence',
                summary:
                  'Each story must include unit, integration, accessibility, and acceptance evidence from test-strategy.md.',
              },
            ],
    capabilityContractCatalog,
    complianceContext,
    domainVocabulary: domainVocabulary.terms,
    wireframeCues,
    planningGuidance: [
      docs.skills.trim() ||
        'Use the project skills manifest when present; otherwise assign frontend, backend, data, security, and test work according to story file ownership.',
      obligationGuidance,
      ...supplementalGuidance,
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
}

function buildManifest(projectRoot, milestone, context) {
  const now = new Date().toISOString();
  const planDir = context.planningDir || planningDir(projectRoot);
  const executionObligations =
    context.executionObligations?.document || context.executionObligations?.milestone
      ? context.executionObligations
      : loadExecutionObligations(planDir, milestone);
  const projectProfile = inferProjectProfile(projectRoot, planDir, executionObligations);
  const wireframeSurfaces = summarizeWireframeSurfacesForMilestone(planDir, milestone);
  const milestoneObligations = executionObligations.milestone || {
    id: milestone,
    title: milestone,
    stories: [],
    carryForward: [],
    launchBlockers: [],
    summary: {},
  };
  const storyObligationById = new Map(
    (milestoneObligations.stories || [])
      .map((story) => [
        String(story.storyId || '')
          .trim()
          .toUpperCase(),
        story,
      ])
      .filter(([storyId]) => storyId),
  );
  const enhancementQueue = dedupeByKey(
    [...(milestoneObligations.carryForward || []), ...(executionObligations.document?.enhancementQueue || [])],
    (item) => item?.id || `${item?.category || 'item'}:${item?.sourcePath || 'unknown'}:${item?.summary || ''}`,
  );
  const launchBlockers = dedupeByKey(
    [
      ...(milestoneObligations.launchBlockers || []),
      ...(milestoneObligations.stories || []).flatMap((story) => story.launchBlockers || []),
    ],
    (item) => item?.id || item?.message || JSON.stringify(item),
  );
  const driftDetectors = Array.isArray(executionObligations.document?.driftDetectors)
    ? executionObligations.document.driftDetectors
    : [];
  const escalationPackets = executionObligations.document?.escalationPackets || {};
  const stories = (context.stories || []).filter((story) => story.milestone === milestone);
  const epics = new Map();
  const fileOwnership = {};
  const waves = [];
  const allTasks = [];
  let waveNumber = 0;

  for (const story of stories) {
    const storySpecPath = path.join(planDir, 'story-specs', `${story.id}-impl-spec.md`);
    const filesByTask = parseFileMap(readText(storySpecPath));
    const acceptanceCriteria = extractAcceptanceCriteria(
      story.absoluteStoryFile || path.join(planDir, story.storyFile || ''),
    );
    const featureIds = featureIdsForStory(story);
    const obligation =
      storyObligationById.get(
        String(story.id || '')
          .trim()
          .toUpperCase(),
      ) || null;
    const manifestStory = {
      id: story.id,
      title: story.title,
      status: story.status || 'ready-for-dev',
      requirementIds: story.requirementIds || [],
      frIds: story.frIds || [],
      nfrIds: story.nfrIds || [],
      trIds: story.trIds || [],
      irIds: story.irIds || [],
      featureIds,
      dependsOn: story.dependsOn || [],
      acceptanceExamples: obligation?.acceptanceExamples || [],
      negativeScenarios: obligation?.negativeScenarios || [],
      edgeScenarios: obligation?.edgeScenarios || [],
      testFixtures: obligation?.testFixtures || [],
      observability: obligation?.observability || [],
      performanceBudgets: obligation?.performanceBudgets || [],
      accessibilityBudgets: obligation?.accessibilityBudgets || [],
      runtimeOperations: obligation?.runtimeOperations || [],
      securityAbuseCases: obligation?.securityAbuseCases || [],
      architectureFitnessChecks: obligation?.architectureFitnessChecks || [],
      launchBlockers: obligation?.launchBlockers || launchBlockers,
      proofObligations: obligation?.proofObligations || [],
      driftFindings: obligation?.driftFindings || [],
      capabilityContracts: capabilityContractsForFeatures(projectProfile.capabilityContractCatalog, featureIds),
      tasks: [],
    };

    for (const sourceTask of story.tasks || []) {
      waveNumber += 1;
      const localTaskId = String(sourceTask.localTaskId || sourceTask.id || '').toUpperCase();
      const taskId = sourceTask.taskId || `${story.id}:${localTaskId}`;
      const files =
        filesByTask[localTaskId] && filesByTask[localTaskId].length > 0
          ? filesByTask[localTaskId]
          : defaultFilesForTask(story, sourceTask, projectProfile);
      const requiredIntegrationProof = dedupeByKey(
        [
          localTaskId === 'T03'
            ? 'unit/integration/accessibility regression evidence'
            : `${story.id} implementation proof`,
          ...(obligation?.proofObligations || []).map((item) => item.summary),
          ...(obligation?.negativeScenarios || []).map((item) => item.summary || item.id || 'negative-path proof'),
          ...(obligation?.edgeScenarios || []).map((item) => item.summary || item.id || 'edge-path proof'),
        ],
        (value) =>
          String(value || '')
            .trim()
            .toLowerCase(),
      ).slice(0, 12);
      const task = {
        id: localTaskId,
        taskId,
        title: sourceTask.description || `${story.title} ${localTaskId}`,
        assignedAgent: assignedAgentForTask(sourceTask),
        requirementIds: story.requirementIds || [],
        frIds: story.frIds || [],
        nfrIds: story.nfrIds || [],
        trIds: story.trIds || [],
        irIds: story.irIds || [],
        files,
        surfaceImpacts: ['ui', 'data', 'tests', 'accessibility'],
        capabilityEdges: featureIds.map((featureId) => `${featureId}->${assignedAgentForTask(sourceTask)}`),
        capabilityContractIds: manifestStory.capabilityContracts.map((entry) => entry.featureId),
        capabilityContractChecks: manifestStory.capabilityContracts.map(
          (entry) =>
            `${entry.featureId}: preserve ${entry.operationCount} operation(s), ${entry.invariantCount} invariant(s), status=${entry.status}`,
        ),
        requiredIntegrationProof,
        doNotBreakContracts: projectProfile.securityInvariants.map((invariant) => invariant.id),
        wave: waveNumber,
        dependsOn: (sourceTask.dependsOn || []).map((dep) => (dep.includes(':') ? dep : `${story.id}:${dep}`)),
        acceptanceCriteria,
        executionObligations: {
          acceptanceExamples: (obligation?.acceptanceExamples || []).map(
            (item) => item.id || item.summary || item.type,
          ),
          negativeScenarios: (obligation?.negativeScenarios || []).map((item) => item.id || item.summary || item.type),
          edgeScenarios: (obligation?.edgeScenarios || []).map((item) => item.id || item.summary || item.type),
          testFixtures: (obligation?.testFixtures || []).map((item) => item.id || item.seedName || item.summary),
          proofObligations: (obligation?.proofObligations || []).map((item) => item.id || item.summary || item.type),
          launchBlockers: (obligation?.launchBlockers || []).map((item) => item.id || item.message || item.code),
        },
        status: sourceTask.status || 'planned',
      };
      manifestStory.tasks.push(task);
      allTasks.push({ ...task, storyId: story.id, epic: story.epic, milestone });
      waves.push({
        waveNumber,
        taskIds: [taskId],
        canParallelize: false,
        writerExecution: 'sequential-by-default',
      });
      for (const file of files) {
        if (!fileOwnership[file]) {
          fileOwnership[file] = {
            taskId,
            owner: taskId,
            new: !fs.existsSync(path.join(projectRoot, file)),
            source: fs.existsSync(storySpecPath) ? 'story-spec-file-map' : 'deterministic-default',
          };
        }
      }
    }

    const epicId = story.epic || story.id.split('-')[0];
    if (!epics.has(epicId)) epics.set(epicId, { id: epicId, title: epicId, stories: [] });
    epics.get(epicId).stories.push(manifestStory);
  }

  const planningSkills = readText(path.join(planDir, 'project-skills-manifest.md'));
  const generatedSkills = readJson(path.join(planDir, 'generated-skills-manifest.json'), { generated: [] });
  const capabilityEdges = buildCapabilityEdges(context, stories);

  return {
    milestone,
    generatedAt: now,
    generatedBy: 'cobolt-build-setup-step',
    techStack: projectProfile.techStack,
    planningSkills: {
      projectManifestPresent: Boolean(planningSkills.trim()),
      generatedManifestPresent: Boolean(generatedSkills),
      appliedSkills: [
        {
          name: 'frontend-dev',
          source: '_cobolt-output/latest/planning/project-skills-manifest.md',
          appliesTo: stories.map((s) => s.id),
          mode: 'advisory',
        },
        {
          name: 'backend-dev',
          source: '_cobolt-output/latest/planning/project-skills-manifest.md',
          appliesTo: stories.map((s) => s.id),
          mode: 'advisory',
        },
        {
          name: 'test-writer',
          source: '_cobolt-output/latest/planning/project-skills-manifest.md',
          appliesTo: stories.map((s) => s.id),
          mode: 'advisory',
        },
      ],
      generatedSkills: generatedSkills?.generated || [],
    },
    executionObligationsPath: toPosix(
      path.relative(
        projectRoot,
        executionObligations.path || path.join(planDir, 'milestone-execution-obligations.json'),
      ),
    ),
    executionObligationsStatus: executionObligations.document?.status || null,
    securityInvariants: projectProfile.securityInvariants,
    requiredTestEvidence: projectProfile.requiredTestEvidence,
    planningGuidance: projectProfile.planningGuidance,
    capabilityContractCatalog: projectProfile.capabilityContractCatalog.contracts || [],
    complianceContext: projectProfile.complianceContext || { present: false, frameworks: [], obligations: [] },
    domainVocabulary: projectProfile.domainVocabulary?.terms || [],
    domainVocabularyPath: projectProfile.domainVocabulary?.path || null,
    wireframeCues: projectProfile.wireframeCues || { present: false, headings: [], cues: [] },
    wireframeSurfaces: wireframeSurfaces || {
      present: false,
      mode: 'missing',
      surfaceCount: 0,
      milestoneScoped: false,
      fullBodyIncluded: false,
      surfaces: [],
    },
    milestoneExecutionObligations: milestoneObligations.stories || [],
    enhancementQueue,
    driftDetectors,
    driftSummary: executionObligations.document?.driftSummary || null,
    escalationPackets,
    launchBlockers,
    capabilityEdges,
    epics: [...epics.values()],
    tasks: allTasks,
    waves,
    fileOwnership,
    file_ownership: fileOwnership,
    totalTasks: allTasks.length,
    totalWaves: waves.length,
    wave_count: waves.length,
    totalFiles: Object.keys(fileOwnership).length,
  };
}

// Section IDs are stable kebab-case slugs that double as ranker inputs and
// audit identifiers. Ten of them (the `pinned: true` set below) align 1:1
// with `REQUIRED_SECTIONS` in `lib/cobolt-build-packet-check.js`. Pinning by
// construction guarantees packet-check correctness regardless of ranker
// decisions — required sections never enter the ranker pool, so they cannot
// be summarised or dropped. The remaining sections (rankable) are fed to
// `applySectionBudget()` in `run()` so the ranker can shrink the packet by
// summarising or dropping low-FR-relevance reference content.
//
// `story-table` and `task-table` are pinned because they define the work
// itself — dropping them would leave builders without their assignments.
// Tier-3 advisory (BUILD-PIPELINE-VNEXT.md §1.2) means a ranker exception
// must degrade to the unranked packet; the integration call site in `run()`
// wraps the ranker call in try/catch to honor that contract.
const PACKET_SECTION_ORDER = [
  'tech-stack',
  'story-table',
  'task-table',
  'security-invariants',
  'capability-edges',
  'capability-contracts-compliance-domain',
  'plan-artifact-ingestion',
  'build-packet-source-snapshot',
  'required-test-evidence',
  'wireframe-ux-cues',
  'wireframe-surface-bodies',
  'acceptance-examples',
  'observability-budgets-runtime',
  'launch-blockers-drift-escalation',
  'planning-skill-guidance',
];

function composePacketSections(milestone, manifest) {
  const storyRows = [];
  const taskRows = [];
  const obligationStories = Array.isArray(manifest.milestoneExecutionObligations)
    ? manifest.milestoneExecutionObligations
    : [];
  for (const epic of manifest.epics) {
    for (const story of epic.stories) {
      storyRows.push(
        `| ${story.id} | ${story.title} | ${epic.id} | ${story.status} | ${story.requirementIds.join(', ') || 'none'} | ${story.featureIds.join(', ') || 'none'} | ${(story.dependsOn || []).join(', ') || 'none'} | ${story.tasks.map((task) => task.taskId).join(', ')} |`,
      );
      for (const task of story.tasks) {
        taskRows.push(
          `| ${task.taskId} | ${task.title} | ${task.assignedAgent} | ${task.wave} | ${task.dependsOn.join(', ') || 'none'} | ${task.files.join('<br>')} |`,
        );
      }
    }
  }
  const capabilityRows = manifest.capabilityEdges
    .slice(0, 80)
    .map(
      (edge) =>
        `| ${edge.featureId} | ${edge.surface} | ${edge.status} | ${edge.requiredProof.join('; ')} | ${edge.assignedTaskIds.join(', ')} |`,
    );
  const capabilityContractRows = (manifest.capabilityContractCatalog || [])
    .slice(0, 12)
    .map(
      (entry) =>
        `| ${entry.featureId} | ${entry.status} | ${entry.evidenceLevel} | ${entry.operationCount} | ${entry.invariantCount} | ${entry.path || 'n/a'} |`,
    );
  const acceptanceRows = obligationStories.slice(0, 80).map((story) => {
    const fixtures = (story.testFixtures || [])
      .map((item) => item.id || item.seedName || item.summary || 'fixture')
      .slice(0, 3)
      .join(', ');
    return `| ${story.storyId} | ${(story.acceptanceExamples || []).length} | ${(story.negativeScenarios || []).length} | ${(story.edgeScenarios || []).length} | ${fixtures || 'none'} |`;
  });
  const observabilityRows = obligationStories.slice(0, 80).map((story) => {
    const metricCount = (story.observability || []).reduce(
      (sum, entry) => sum + ((entry.metrics || []).length || 0),
      0,
    );
    const alertCount = (story.observability || []).reduce((sum, entry) => sum + ((entry.alerts || []).length || 0), 0);
    const runbooks = (story.runtimeOperations || [])
      .map((item) => item.id || item.name || item.title || 'runbook')
      .slice(0, 3)
      .join(', ');
    return `| ${story.storyId} | ${metricCount} | ${alertCount} | ${(story.performanceBudgets || []).length} | ${(story.accessibilityBudgets || []).length} | ${runbooks || 'none'} |`;
  });
  const performanceBudgetLines = dedupeByKey(
    obligationStories.flatMap((story) => story.performanceBudgets || []),
    (item) => item?.id || item?.route || item?.metric || item?.name || JSON.stringify(item),
  )
    .slice(0, 8)
    .map(
      (item) =>
        `- ${item.id || item.route || item.metric || item.name || 'performance-budget'}: ${item.budget || item.threshold || item.target || item.summary || 'declared budget'}`,
    );
  const accessibilityBudgetLines = dedupeByKey(
    obligationStories.flatMap((story) => story.accessibilityBudgets || []),
    (item) => item?.id || item?.metric || item?.name || JSON.stringify(item),
  )
    .slice(0, 8)
    .map(
      (item) =>
        `- ${item.id || item.metric || item.name || 'accessibility-budget'}: ${item.budget || item.threshold || item.target || item.summary || 'declared budget'}`,
    );
  const launchBlockerLines = (manifest.launchBlockers || [])
    .slice(0, 12)
    .map(
      (blocker) =>
        `- ${blocker.id || blocker.code || 'blocker'}: ${blocker.message || blocker.summary || 'launch blocker'}`,
    );
  const driftDetectorRows = (manifest.driftDetectors || []).map(
    (detector) =>
      `| ${detector.id} | ${detector.status} | ${detector.findingCount} | ${detector.description || detector.label || 'drift detector'} |`,
  );
  const enhancementLines = (manifest.enhancementQueue || [])
    .slice(0, 12)
    .map((item) => `- ${item.id || item.category || 'enhancement'}: ${item.summary || 'follow-up required'}`);
  const complianceLines = [
    `- Frameworks: ${manifest.complianceContext.frameworks?.join(', ') || 'none declared'}`,
    `- Data categories: ${manifest.complianceContext.dataCategories?.join(', ') || 'none declared'}`,
    `- Active controls: ${manifest.complianceContext.activeControlCount || 0}/${manifest.complianceContext.controlCount || 0}`,
    ...(manifest.complianceContext.obligations || [])
      .slice(0, 5)
      .map(
        (entry) =>
          `- ${entry.id} (${entry.framework}): ${entry.acceptance || 'control obligation'}${entry.owner ? ` Owner: ${entry.owner}.` : '.'}`,
      ),
  ];
  const domainVocabularyLines =
    (manifest.domainVocabulary || []).length > 0
      ? manifest.domainVocabulary.map((term) => `- ${term}`)
      : ['- No domain glossary terms were packaged for this milestone.'];
  const wireframeLines = [
    `- Source: ${manifest.wireframeCues.path || 'wireframes-and-user-flows.md not present'}`,
    ...(manifest.wireframeCues.headings || []).slice(0, 5).map((heading) => `- Heading: ${heading}`),
    ...(manifest.wireframeCues.cues || []).slice(0, 6).map((cue) => `- Cue: ${cue}`),
  ];
  // v0.59.0+ per-surface fan-out: inline first-screen-block + cross-surface
  // flows for every milestone-scoped surface so frontend builders get the
  // 9-facet × 6-state body without needing to read external files (Inv-9).
  // Full body only when surfaceCount<=3 (user-confirmed cap).
  const ws = manifest.wireframeSurfaces || { present: false, surfaces: [] };
  const wireframeSurfaceLines = [];
  if (ws.present && ws.surfaces.length > 0) {
    wireframeSurfaceLines.push(
      `- Mode: ${ws.mode}; surfaces in this milestone: ${ws.surfaceCount}/${ws.totalSurfacesOnDisk || ws.surfaceCount}; milestone-scoped: ${ws.milestoneScoped ? 'yes' : 'no (no surface-map)'}.`,
      `- Full body inlined: ${ws.fullBodyIncluded ? 'yes (<=3 surfaces)' : 'no — first-screen-block + cross-flows only; on-disk paths cited per surface'}.`,
      '',
    );
    for (const s of ws.surfaces) {
      const frTag = s.frIds && s.frIds.length > 0 ? ` (FRs: ${s.frIds.join(', ')})` : '';
      wireframeSurfaceLines.push(`### Surface ${s.id} — ${s.slug}${frTag}`);
      wireframeSurfaceLines.push(`Path: ${s.relativePath}`);
      wireframeSurfaceLines.push('');
      if (s.firstScreenBlock && s.firstScreenBlock.trim().length > 0) {
        wireframeSurfaceLines.push('**First screen (canonical layout + 6 states):**');
        wireframeSurfaceLines.push('');
        wireframeSurfaceLines.push(s.firstScreenBlock);
        wireframeSurfaceLines.push('');
      }
      if (s.crossSurfaceFlows && s.crossSurfaceFlows.trim().length > 0) {
        wireframeSurfaceLines.push('**Cross-surface flows:**');
        wireframeSurfaceLines.push('');
        wireframeSurfaceLines.push(s.crossSurfaceFlows);
        wireframeSurfaceLines.push('');
      }
      if (s.fullBody) {
        wireframeSurfaceLines.push('**Full surface body:**');
        wireframeSurfaceLines.push('');
        wireframeSurfaceLines.push(s.fullBody);
        wireframeSurfaceLines.push('');
      } else {
        wireframeSurfaceLines.push(
          `(Full body omitted — read ${s.relativePath} for the remaining screens, states, and facets.)`,
        );
        wireframeSurfaceLines.push('');
      }
    }
  } else {
    wireframeSurfaceLines.push(
      `- No per-surface wireframes available for this milestone (mode: ${ws.mode || 'missing'}).`,
    );
  }
  const planIngestion = manifest.planIngestion || null;
  const planningManifest = planIngestion?.planningManifest || null;
  const planIngestionLines = planIngestion
    ? [
        `- Required artifacts present: ${(planIngestion.summary?.requiredArtifacts || 0) - (planIngestion.summary?.missingRequired || 0)}/${planIngestion.summary?.requiredArtifacts || 0}`,
        `- Optional artifacts present: ${(planIngestion.summary?.presentArtifacts || 0) - ((planIngestion.summary?.requiredArtifacts || 0) - (planIngestion.summary?.missingRequired || 0))}/${planIngestion.summary?.optionalArtifacts || 0}`,
        `- Contract gaps: ${planIngestion.summary?.contractGaps || 0}`,
        `- Planning evidence graph: ${planningManifest?.verdict || 'missing'} (${planningManifest?.critical || 0} critical, ${planningManifest?.advisory || 0} advisory)`,
        `- Planning manifest hash: ${planningManifest?.sha256 || 'missing'}`,
        ...(planIngestion.issues || []).slice(0, 6).map((issue) => `- Issue: ${issue}`),
        ...Object.entries(planIngestion.summary?.carriers || {})
          .slice(0, 8)
          .map(
            ([carrier, stats]) =>
              `- ${carrier}: ${stats.artifacts} artifacts, ${stats.critical} critical, ${stats.missingRequired} missing required`,
          ),
      ]
    : ['- Plan ingestion manifest has not been generated for this milestone.'];
  const buildPacketFreshnessLines = manifest.buildPacketFreshness
    ? [
        `- Tracked source files: ${manifest.buildPacketFreshness.trackedSources || 0}`,
        `- Source digest: ${manifest.buildPacketFreshness.sourceDigest || 'n/a'}`,
        `- Snapshot artifact: ${manifest.buildPacketFreshness.snapshotPath || 'n/a'}`,
        ...(manifest.buildPacketFreshness.issues || []).slice(0, 5).map((issue) => `- Issue: ${issue}`),
      ]
    : ['- Build packet source snapshot was not generated.'];
  const escalationLines = [];
  if (manifest.escalationPackets?.reviewLead?.enabled) {
    escalationLines.push(
      `- review-lead: ${manifest.escalationPackets.reviewLead.findings?.length || 0} finding(s) plus ${manifest.escalationPackets.reviewLead.agentFailures?.length || 0} agent failure record(s).`,
    );
  }
  if (manifest.escalationPackets?.recoveryAdvisor?.enabled) {
    escalationLines.push(
      `- recovery-advisor: ${manifest.escalationPackets.recoveryAdvisor.evidence?.failureCount || 0} critical failure context packet(s) ready for escalation.`,
    );
  }

  const wireframePath =
    manifest.wireframeSurfaces?.rootPath || manifest.wireframeCues?.path || 'planning/wireframes-and-user-flows.md';

  const sections = [
    {
      id: 'tech-stack',
      heading: '## Tech Stack',
      content: [
        `- Languages: ${manifest.techStack.languages.join(', ')}`,
        `- Frameworks: ${manifest.techStack.frameworks.join(', ')}`,
        `- Databases: ${manifest.techStack.databases.join(', ')}`,
        `- Libraries: ${manifest.techStack.libraries.join(', ')}`,
        `- Test frameworks: ${manifest.techStack.testFrameworks.join(', ')}`,
      ].join('\n'),
      sourcePath: 'planning/architecture.md',
      // Pinned: tech-stack content rarely contains FR-NNN refs, so ranker
      // scoring drops it under the 0.05 score floor. Builders nevertheless
      // need the language/framework/database reference inline (without it,
      // they have to re-derive the stack from architecture.md). Pinning
      // this section trades a little ranker reach for builder reliability.
      pinned: true,
    },
    {
      id: 'story-table',
      heading: '## Story Table',
      content: [
        '| Story | Title | Epic | Status | Requirements | Features | Depends On | Tasks |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        ...storyRows,
      ].join('\n'),
      sourcePath: 'planning/story-tracker.json',
      pinned: true,
    },
    {
      id: 'task-table',
      heading: '## Task Table',
      content: [
        '| Task | Title | Agent | Wave | Depends On | Files |',
        '| --- | --- | --- | --- | --- | --- |',
        ...taskRows,
      ].join('\n'),
      sourcePath: 'planning/story-specs/',
      pinned: true,
    },
    {
      id: 'security-invariants',
      heading: '## Security & Data Protection Invariants',
      content: manifest.securityInvariants
        .map((item) => `- ${item.id}: ${item.summary} Source: ${item.source}.`)
        .join('\n'),
      sourcePath: 'planning/security-requirements.md',
      pinned: true,
    },
    {
      id: 'capability-edges',
      heading: '## Product Capability Edges',
      content: [
        '| Feature | Surface | Status | Required Proof | Assigned Tasks |',
        '| --- | --- | --- | --- | --- |',
        ...capabilityRows,
      ].join('\n'),
      sourcePath: 'planning/feature-registry.json',
      pinned: true,
    },
    {
      id: 'capability-contracts-compliance-domain',
      heading: '## Capability Contracts, Compliance, and Domain Vocabulary',
      content: [
        '### Capability Contracts',
        '| Feature | Status | Evidence | Ops | Invariants | Contract |',
        '| --- | --- | --- | --- | --- | --- |',
        ...(capabilityContractRows.length > 0
          ? capabilityContractRows
          : ['| none | NOT_DECLARED | n/a | 0 | 0 | capability-contracts-index.json missing |']),
        '',
        '### Compliance Grounding',
        ...complianceLines,
        '',
        '### Domain Vocabulary',
        ...domainVocabularyLines,
      ].join('\n'),
      sourcePath: 'planning/capability-contracts-index.json',
      pinned: true,
    },
    {
      id: 'plan-artifact-ingestion',
      heading: '## Plan Artifact Ingestion',
      content: planIngestionLines.join('\n'),
      sourcePath: `build/${milestone}/${milestone}-plan-ingestion-manifest.json`,
      pinned: true,
    },
    {
      id: 'build-packet-source-snapshot',
      heading: '## Build Packet Source Snapshot',
      content: buildPacketFreshnessLines.join('\n'),
      sourcePath: `build/${milestone}/${milestone}-build-packet-sources.json`,
      pinned: true,
    },
    {
      id: 'required-test-evidence',
      heading: '## Required Test Evidence',
      content: manifest.requiredTestEvidence.map((item) => `- ${item.id}: ${item.summary}`).join('\n'),
      sourcePath: 'planning/test-strategy.md',
      pinned: true,
    },
    {
      id: 'wireframe-ux-cues',
      heading: '## Wireframe and UX Fidelity Cues',
      content: wireframeLines.join('\n'),
      sourcePath: wireframePath,
      pinned: true,
    },
    {
      id: 'wireframe-surface-bodies',
      heading: '## Wireframe Surface Bodies (per-milestone)',
      content: wireframeSurfaceLines.join('\n'),
      sourcePath: wireframePath,
      pinned: false,
    },
    {
      id: 'acceptance-examples',
      heading: '## Acceptance Examples & Negative Paths',
      content: [
        '| Story | Acceptance Examples | Negative Paths | Edge Paths | Fixtures |',
        '| --- | --- | --- | --- | --- |',
        ...(acceptanceRows.length > 0 ? acceptanceRows : ['| none | 0 | 0 | 0 | none |']),
      ].join('\n'),
      sourcePath: 'planning/milestone-execution-obligations.json',
      pinned: true,
    },
    {
      id: 'observability-budgets-runtime',
      heading: '## Observability, Budgets, and Runtime Operations',
      content: [
        '| Story | Metrics | Alerts | Performance Budgets | Accessibility Budgets | Runbooks |',
        '| --- | --- | --- | --- | --- | --- |',
        ...(observabilityRows.length > 0 ? observabilityRows : ['| none | 0 | 0 | 0 | 0 | none |']),
        '',
        '### Performance Budget Highlights',
        ...(performanceBudgetLines.length > 0
          ? performanceBudgetLines
          : ['- No explicit performance budgets declared for this milestone slice.']),
        '',
        '### Accessibility Budget Highlights',
        ...(accessibilityBudgetLines.length > 0
          ? accessibilityBudgetLines
          : ['- No explicit accessibility budgets declared for this milestone slice.']),
      ].join('\n'),
      sourcePath: 'planning/milestone-execution-obligations.json',
      pinned: true,
    },
    {
      id: 'launch-blockers-drift-escalation',
      heading: '## Launch Blockers, Drift, and Escalation',
      content: [
        '### Launch Blockers',
        ...(launchBlockerLines.length > 0 ? launchBlockerLines : ['- No launch blockers currently declared.']),
        '',
        '### Drift Detectors',
        '| Detector | Status | Findings | Scope |',
        '| --- | --- | --- | --- |',
        ...(driftDetectorRows.length > 0
          ? driftDetectorRows
          : ['| handoff-fidelity | clear | 0 | No active drift detectors were supplied. |']),
        '',
        '### Enhancement Queue',
        ...(enhancementLines.length > 0
          ? enhancementLines
          : ['- No carry-forward enhancements are currently open for this milestone.']),
        '',
        '### Escalation Packets',
        ...(escalationLines.length > 0 ? escalationLines : ['- No escalation packets are currently active.']),
      ].join('\n'),
      sourcePath: 'planning/milestone-execution-obligations.json',
      pinned: true,
    },
    {
      id: 'planning-skill-guidance',
      heading: '## Planning Skill Guidance',
      content:
        manifest.planningGuidance.length > 900
          ? `${manifest.planningGuidance.slice(0, 900).trim()}...`
          : manifest.planningGuidance,
      sourcePath: 'planning/project-skills-manifest.md',
      pinned: false,
    },
  ];

  // Determinism guard: section order must match `PACKET_SECTION_ORDER`.
  const composedIds = sections.map((s) => s.id);
  for (let i = 0; i < composedIds.length; i += 1) {
    if (composedIds[i] !== PACKET_SECTION_ORDER[i]) {
      throw new Error(
        `composePacketSections: section order drift at index ${i} — expected ${PACKET_SECTION_ORDER[i]}, got ${composedIds[i]}`,
      );
    }
  }
  return sections;
}

function renderPacketMarkdown(milestone, sections) {
  const parts = [
    `# ${milestone} Build Packet`,
    '',
    '## Milestone',
    `${milestone} deterministic setup packet generated from the canonical planning context.`,
    '',
  ];
  for (const section of sections) {
    parts.push(section.heading);
    parts.push(section.content);
    parts.push('');
  }
  return parts.join('\n');
}

// Backwards-compatible export. Callers that want the legacy unranked
// markdown (such as existing tests and downstream tools that import the
// full packet builder) keep working. The new ranking integration in
// `run()` calls `composePacketSections()` + `renderPacketMarkdown()`
// directly so it can interleave the ranker between the two.
function buildPacketMarkdown(milestone, _context, manifest) {
  return renderPacketMarkdown(milestone, composePacketSections(milestone, manifest));
}

function docsCacheMarkdown(milestone, manifest) {
  return [
    `# Framework Docs Cache - ${milestone}`,
    '',
    '## Source Status',
    'Context7 MCP is not required for this deterministic setup wrapper; cache is built from the canonical local planning packet and stable framework contracts.',
    '',
    '## Planning-Derived Stack',
    `- Languages: ${manifest.techStack.languages.join(', ')}`,
    `- Frameworks: ${manifest.techStack.frameworks.join(', ')}`,
    `- Databases: ${manifest.techStack.databases.join(', ')}`,
    `- Libraries: ${manifest.techStack.libraries.join(', ')}`,
    '',
    '## Test Evidence',
    ...manifest.requiredTestEvidence.map((item) => `- ${item.summary}`),
    '',
  ].join('\n');
}

function designCacheMarkdown(milestone, manifest) {
  const components = Object.keys(manifest.fileOwnership)
    .filter((file) => /\.(tsx|jsx|vue|svelte|html|css|scss|xaml|cs)$/i.test(file))
    .slice(0, 40)
    .map((file) => `- ${file}`);
  return [`# Design Cache - ${milestone}`, '', '## Target UI/Implementation Surfaces', ...components, ''].join('\n');
}

function checkpointPayload(milestone, manifest, fidelity) {
  return {
    checkpoint: 'setup',
    milestone,
    status: 'passed',
    passedAt: new Date().toISOString(),
    generatedBy: 'cobolt-build-setup-step',
    artifacts: {
      planningContext: `${milestone}-planning-context.json`,
      buildPacket: `${milestone}-build-packet.md`,
      taskManifest: `${milestone}-task-manifest.json`,
      planIngestionManifest: `${milestone}-plan-ingestion-manifest.json`,
      buildPacketSources: `${milestone}-build-packet-sources.json`,
      buildPacketFidelity: `${milestone}-build-packet-fidelity.json`,
      buildPacketRank: `${milestone}-build-packet-rank.json`,
      docsCache: `${milestone}-docs-cache.md`,
      designCache: `${milestone}-design-cache.md`,
    },
    summary: {
      totalTasks: manifest.totalTasks,
      totalWaves: manifest.totalWaves,
      totalFiles: manifest.totalFiles,
      trackedBuildPacketSources: manifest.buildPacketFreshness?.trackedSources || 0,
      enhancementQueue: Array.isArray(manifest.enhancementQueue) ? manifest.enhancementQueue.length : 0,
      driftDetectors: Array.isArray(manifest.driftDetectors) ? manifest.driftDetectors.length : 0,
      buildPacketRankAdvisoryStatus: manifest.buildPacketRank?.advisoryStatus || null,
    },
    fidelity: fidelity
      ? {
          valid: fidelity.valid,
          issues: fidelity.issues || [],
        }
      : null,
    designMCP: {
      figma: 'false',
      stitch: 'false',
    },
  };
}

// Tier-3 advisory ranking integration (BUILD-PIPELINE-VNEXT.md §1.2).
// Composes packet sections, partitions pinned vs rankable, runs the
// ranker on the rankable subset, and reassembles in canonical order.
//
// Failure posture is deliberately tolerant: if the ranker throws or
// returns malformed output, we fall back to the unranked packet and
// record `advisoryStatus: degraded:*` in the rank artifact. Step 01
// must never fail because of ranking — that's the Tier 3 contract.
function rankPacketAndRender(milestone, enrichedContext, manifest) {
  const { applySectionBudget, DEFAULT_TOKEN_BUDGET } = require('./cobolt-build-packet-rank');
  const allSections = composePacketSections(milestone, manifest);
  const rankable = allSections.filter((section) => !section.pinned);
  const pinnedIds = allSections.filter((section) => section.pinned).map((section) => section.id);

  const milestoneFRSet = new Set();
  const milestoneFRs = [];
  const stories = (enrichedContext.stories || []).filter((story) => story.milestone === milestone);
  for (const story of stories) {
    for (const id of [...(story.frIds || []), ...(story.requirementIds || [])]) {
      const norm = String(id || '')
        .trim()
        .toUpperCase();
      if (/^FR-[A-Z0-9-]+$/.test(norm) && !milestoneFRSet.has(norm)) {
        milestoneFRSet.add(norm);
        milestoneFRs.push(norm);
      }
    }
  }
  const capabilityEdges = Array.isArray(manifest.capabilityEdges) ? manifest.capabilityEdges : [];
  const tokenBudget = Number.parseInt(process.env.COBOLT_BUILD_PACKET_TOKEN_BUDGET || '', 10) || DEFAULT_TOKEN_BUDGET;

  let rankResult = null;
  let advisoryStatus = 'ok';
  try {
    rankResult = applySectionBudget(rankable, {
      milestoneFRs,
      frDescriptions: [],
      capabilityEdges,
      tokenBudget,
    });
    if (!rankResult || !Array.isArray(rankResult.sections)) {
      throw new Error('ranker returned malformed result');
    }
  } catch (err) {
    advisoryStatus = `degraded: ${err?.message || String(err)}`;
    rankResult = {
      sections: rankable,
      decisions: rankable.map((section) => ({
        id: section.id,
        decision: 'fallback-inline',
        tokens: 0,
        score: 0,
      })),
      droppedIds: [],
      totalEstimatedTokens: 0,
      budget: tokenBudget,
    };
  }

  // Reassemble in canonical order. Pinned sections always emit; rankable
  // sections emit only if they survived ranking (not in `droppedIds`).
  const droppedSet = new Set(rankResult.droppedIds || []);
  const rankedById = new Map();
  for (const section of rankResult.sections) rankedById.set(section.id, section);

  const finalSections = [];
  for (const original of allSections) {
    if (original.pinned) {
      finalSections.push(original);
      continue;
    }
    if (droppedSet.has(original.id)) continue;
    const ranked = rankedById.get(original.id);
    finalSections.push(ranked || original);
  }

  const packetMarkdown = renderPacketMarkdown(milestone, finalSections);
  const decisions = Array.isArray(rankResult.decisions) ? rankResult.decisions : [];
  const idsByDecision = {
    inline: decisions.filter((d) => d.decision === 'inline').map((d) => d.id),
    summarise: decisions.filter((d) => d.decision === 'summarise').map((d) => d.id),
    'always-include': decisions.filter((d) => d.decision === 'always-include').map((d) => d.id),
    drop: decisions.filter((d) => d.decision === 'drop').map((d) => d.id),
    'fallback-inline': decisions.filter((d) => d.decision === 'fallback-inline').map((d) => d.id),
  };

  const rankArtifact = {
    milestone,
    generatedBy: 'cobolt-build-setup-step',
    generatedAt: new Date().toISOString(),
    advisoryStatus,
    tier: 3,
    tokenBudget,
    totalEstimatedTokens: rankResult.totalEstimatedTokens || 0,
    pinnedIds,
    rankablePool: rankable.map((section) => section.id),
    decisions,
    droppedIds: rankResult.droppedIds || [],
    idsByDecision,
    milestoneFRCount: milestoneFRs.length,
    capabilityEdgeCount: capabilityEdges.length,
  };

  return { packetMarkdown, rankArtifact, advisoryStatus, finalSections };
}

function run(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const milestone = normalizeMilestone(options.milestone);
  if (!milestone) throw new Error('Missing --milestone M{n}');
  const toolsDir = options.toolsDir || resolveToolsDir(projectRoot);
  const targetDir = buildDir(projectRoot, milestone);
  fs.mkdirSync(targetDir, { recursive: true });

  const context = runContextTool(projectRoot, milestone, toolsDir, options.timeoutMs || 10 * 60 * 1000);
  const executionObligations = loadExecutionObligations(context.planningDir || planningDir(projectRoot), milestone);
  const enrichedContext = {
    ...context,
    executionObligations,
    executionObligationsSummary: summarizeExecutionObligations(executionObligations),
  };
  const planningContextPath = path.join(targetDir, `${milestone}-planning-context.json`);
  writeJson(planningContextPath, enrichedContext);
  const planIngestionPath = path.join(targetDir, `${milestone}-plan-ingestion-manifest.json`);
  const planIngestion = writePlanIngestionManifest(projectRoot, {
    milestone,
    outputPath: planIngestionPath,
  }).manifest;
  if (planIngestion.passed !== true) {
    throw new Error(`Plan ingestion manifest failed for ${milestone}: ${(planIngestion.issues || []).join(' | ')}`);
  }

  const manifest = buildManifest(projectRoot, milestone, enrichedContext);
  if (manifest.totalTasks === 0) throw new Error(`No buildable tasks found for ${milestone}`);
  manifest.planIngestion = planIngestion;
  const buildPacketFreshnessPath = path.join(targetDir, `${milestone}-build-packet-sources.json`);
  const buildPacketFreshness = writeBuildPacketFreshnessSnapshot(projectRoot, {
    milestone,
    planIngestion,
    outputPath: buildPacketFreshnessPath,
  }).snapshot;
  manifest.buildPacketFreshness = {
    passed: buildPacketFreshness.passed,
    issues: buildPacketFreshness.issues || [],
    trackedSources: buildPacketFreshness.trackedSources || 0,
    sourceDigest: buildPacketFreshness.sourceDigest || null,
    snapshotPath: toPosix(path.relative(projectRoot, buildPacketFreshnessPath)),
  };

  const packetPath = path.join(targetDir, `${milestone}-build-packet.md`);
  const manifestPath = path.join(targetDir, `${milestone}-task-manifest.json`);
  const fidelityPath = path.join(targetDir, `${milestone}-build-packet-fidelity.json`);
  const rankPath = path.join(targetDir, `${milestone}-build-packet-rank.json`);
  const docsPath = path.join(targetDir, `${milestone}-docs-cache.md`);
  const designPath = path.join(targetDir, `${milestone}-design-cache.md`);

  const ranked = rankPacketAndRender(milestone, enrichedContext, manifest);
  manifest.buildPacketRank = {
    advisoryStatus: ranked.advisoryStatus,
    tokenBudget: ranked.rankArtifact.tokenBudget,
    totalEstimatedTokens: ranked.rankArtifact.totalEstimatedTokens,
    pinnedCount: ranked.rankArtifact.pinnedIds.length,
    rankableCount: ranked.rankArtifact.rankablePool.length,
    droppedCount: (ranked.rankArtifact.droppedIds || []).length,
    rankArtifactPath: toPosix(path.relative(projectRoot, rankPath)),
  };
  writeFile(packetPath, ranked.packetMarkdown);
  writeJson(rankPath, ranked.rankArtifact);
  writeJson(manifestPath, manifest);
  writeFile(docsPath, docsCacheMarkdown(milestone, manifest));
  writeFile(designPath, designCacheMarkdown(milestone, manifest));
  const fidelity = validateBuildPacket(projectRoot, milestone);
  writeJson(fidelityPath, fidelity);
  if (!fidelity.valid) {
    throw new Error(
      `Build packet fidelity validation failed for ${milestone}: ${(fidelity.issues || ['unknown fidelity error']).join(' | ')}`,
    );
  }

  const checkpointsDir = projectPath(projectRoot, '_cobolt-output', 'latest', 'build', 'checkpoints');
  const checkpoint = checkpointPayload(milestone, manifest, fidelity);
  writeJson(path.join(checkpointsDir, `${milestone}-01-milestone-setup.json`), checkpoint);
  writeJson(path.join(checkpointsDir, '01-milestone-setup.json'), checkpoint);
  syncBuildExecutionLedger(projectRoot, milestone, {
    manifestPath,
    buildArtifactsPath: path.join(targetDir, `${milestone}-build-artifacts.json`),
    setupCheckpointPath: path.join(checkpointsDir, `${milestone}-01-milestone-setup.json`),
  });
  projectExecutionLedger(projectRoot);

  return {
    ok: true,
    milestone,
    generatedBy: 'cobolt-build-setup-step',
    artifacts: {
      planningContext: planningContextPath,
      buildPacket: packetPath,
      taskManifest: manifestPath,
      planIngestionManifest: planIngestionPath,
      buildPacketSources: buildPacketFreshnessPath,
      buildPacketFidelity: fidelityPath,
      buildPacketRank: rankPath,
      docsCache: docsPath,
      designCache: designPath,
    },
    summary: checkpoint.summary,
  };
}

function main() {
  const args = parseArgs();
  if (args.command === 'help') {
    console.log(
      JSON.stringify({ usage: 'node tools/cobolt-build-setup-step.js run --milestone M1 [--json]' }, null, 2),
    );
    return;
  }
  try {
    const result = run(args);
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`Generated ${result.milestone} setup artifacts (${result.summary.totalTasks} tasks).`);
  } catch (err) {
    const payload = { ok: false, error: err.message || String(err) };
    if (args.json) console.log(JSON.stringify(payload, null, 2));
    else console.error(payload.error);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  decodeText,
  parseFileMap,
  buildManifest,
  buildPacketMarkdown,
  composePacketSections,
  renderPacketMarkdown,
  rankPacketAndRender,
  summarizeWireframeSurfacesForMilestone,
  surfaceIdMatchesWireframeSlug,
  PACKET_SECTION_ORDER,
  run,
};
