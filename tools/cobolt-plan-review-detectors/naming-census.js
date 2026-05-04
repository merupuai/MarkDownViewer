const path = require('node:path');
const {
  expectedStoryIdsFromEpics,
  normalizeStoryId,
  storyIdFromFilename,
} = require('../../lib/cobolt-planning-artifacts');

const {
  createFinding,
  dedupeFindings,
  listPlanningFiles,
  listRootPlanningFiles,
  loadArtifactDependencies,
  loadPlanPhaseArtifacts,
  loadState,
  readJson,
  readText,
  relativeToPlanning,
  toPosix,
} = require('./_shared');

const CANARY_NAMES = ['WorldClock', 'Meru', 'Acme Payroll', 'RetailPulse'];

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function canonicalRequirementKey(id) {
  const match = String(id || '')
    .trim()
    .toUpperCase()
    .match(/^([A-Z]+)-0*(\d+)$/);
  return match
    ? `${match[1]}-${parseInt(match[2], 10)}`
    : String(id || '')
        .trim()
        .toUpperCase();
}

function collectIdsFromText(text, prefixPattern) {
  const results = [];
  for (const match of String(text || '').matchAll(prefixPattern)) {
    const [, prefix, digits] = match;
    results.push(`${String(prefix).toUpperCase()}-${parseInt(digits, 10)}`);
  }
  return unique(results);
}

function extractMilestoneIds(text) {
  return unique([...String(text || '').matchAll(/\bM(\d+)\b/giu)].map((match) => `M${parseInt(match[1], 10)}`)).sort(
    (left, right) => parseInt(left.slice(1), 10) - parseInt(right.slice(1), 10),
  );
}

function relativeFromContractPath(contractPath) {
  return String(contractPath || '')
    .replace(/^_cobolt-output[\\/]+latest[\\/]+planning[\\/]+/i, '')
    .replace(/^planning[\\/]+/i, '')
    .replace(/\\/g, '/');
}

function loadCanonicalArtifactNames() {
  const names = new Set();
  const phaseArtifacts = loadPlanPhaseArtifacts();
  for (const phase of Object.values(phaseArtifacts.phases || {})) {
    for (const bucket of ['requiredArtifacts', 'optionalArtifacts']) {
      for (const artifact of phase[bucket] || []) {
        names.add(relativeFromContractPath(artifact.path).toLowerCase());
      }
    }
  }
  const artifactDependencies = loadArtifactDependencies();
  for (const artifact of Object.values(artifactDependencies.artifacts || {})) {
    if (!String(artifact.path || '').includes('_cobolt-output/latest/planning/')) continue;
    names.add(relativeFromContractPath(artifact.path).toLowerCase());
  }
  return names;
}

function rootTokens(fileName) {
  return unique(
    path
      .basename(fileName, path.extname(fileName))
      .toLowerCase()
      .split(/[-_.]/u)
      .filter((token) => token.length >= 2),
  );
}

function overlapScore(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let shared = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) shared += 1;
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : shared / union;
}

function detectMilestoneNumbering(context, findings) {
  const sources = ['milestones.md', 'epics.md', 'rtm.json', 'cross-milestone-analysis.md']
    .map((relativePath) => ({
      relativePath,
      absolutePath: path.join(context.planningDir, relativePath),
    }))
    .filter((entry) => entry.absolutePath);

  const milestoneSets = new Map();
  for (const source of sources) {
    const content = readText(source.absolutePath);
    if (!content) continue;
    milestoneSets.set(source.relativePath, extractMilestoneIds(content));
  }

  const union = unique([...milestoneSets.values()].flat()).sort(
    (left, right) => parseInt(left.slice(1), 10) - parseInt(right.slice(1), 10),
  );
  if (union.length > 0) {
    if (union[0] !== 'M1') {
      findings.push(
        createFinding({
          classId: 'B1',
          severity: 'critical',
          artifact: 'planning packet',
          evidence: { milestoneIds: union },
          remediationHint: 'Milestone numbering must begin at M1 and remain monotonic across planning artifacts.',
          detectorId: 'naming-census',
        }),
      );
    }
    for (let index = 1; index < union.length; index += 1) {
      const expected = parseInt(union[index - 1].slice(1), 10) + 1;
      const actual = parseInt(union[index].slice(1), 10);
      if (expected !== actual) {
        findings.push(
          createFinding({
            classId: 'B1',
            severity: 'critical',
            artifact: 'planning packet',
            evidence: { milestoneIds: union },
            remediationHint: 'Milestone numbering must not contain gaps or duplicates.',
            detectorId: 'naming-census',
          }),
        );
        break;
      }
    }
  }

  for (const [relativePath, ids] of milestoneSets.entries()) {
    if (JSON.stringify(ids) === JSON.stringify(union)) continue;
    findings.push(
      createFinding({
        classId: 'B1',
        severity: 'critical',
        artifact: relativePath,
        evidence: { observed: ids, expected: union },
        remediationHint:
          'Align milestone identifiers across milestones.md, epics.md, RTM, and cross-milestone analysis.',
        detectorId: 'naming-census',
      }),
    );
  }
}

// v0.52 — exclude plan-review's own outputs (verdict, escalation, quarantine,
// audit-bridge findings) from the FR-identifier-style scan. These files quote
// FR-NNN literals as evidence text from prior detector hits, and reading them
// back as source artifacts produces a self-referential B1 loop the autonomous
// repair loop cannot drain (RawDrive M1=50 incident, 2026-04-27).
const B1_SELF_SCAN_EXCLUSIONS = new Set(['plan-review-verdict.json', 'plan-review-report.json']);

function isSelfScanExcludedPath(planningDir, absolutePath) {
  const relativePath = relativeToPlanning(planningDir, absolutePath);
  if (B1_SELF_SCAN_EXCLUSIONS.has(relativePath)) return true;
  // Anything inside _cobolt-output/audit/plan-review/ is also detector output.
  return /(^|[\\/])plan-review[\\/]/.test(relativePath);
}

function detectIdentifierStyleDrift(context, findings) {
  const aggregate = listPlanningFiles(context.planningDir, { maxDepth: 4 })
    .filter((filePath) => /\.(md|json)$/i.test(filePath))
    .filter((filePath) => !isSelfScanExcludedPath(context.planningDir, filePath))
    .map((filePath) => readText(filePath))
    .join('\n');

  if (/\bFR-\d{3}\b/u.test(aggregate) && /\bFR-\d{1,2}\b/u.test(aggregate)) {
    findings.push(
      createFinding({
        classId: 'B1',
        severity: 'critical',
        artifact: 'planning packet',
        evidence: 'Mixed FR identifier styles detected (for example FR-001 and FR-1).',
        remediationHint: 'Normalize FR identifiers to a single canonical format across the packet.',
        detectorId: 'naming-census',
      }),
    );
  }
}

function detectNamingVariants(context, findings) {
  const canonicalNames = loadCanonicalArtifactNames();
  const canonicalTokenMap = [...canonicalNames].map((name) => ({ name, tokens: rootTokens(name) }));

  for (const filePath of listRootPlanningFiles(context.planningDir)) {
    const relativePath = relativeToPlanning(context.planningDir, filePath);
    const normalized = relativePath.toLowerCase();
    if (canonicalNames.has(normalized)) continue;
    const tokens = rootTokens(relativePath);
    const closest = canonicalTokenMap
      .map((entry) => ({ name: entry.name, score: overlapScore(tokens, entry.tokens) }))
      .sort((left, right) => right.score - left.score)[0];
    if (closest?.score >= 0.5) {
      findings.push(
        createFinding({
          classId: 'B2',
          severity: 'advisory',
          artifact: relativePath,
          evidence: { canonicalName: closest.name, overlap: Number(closest.score.toFixed(3)) },
          remediationHint: 'Rename variant planning files to the canonical registry path before build handoff.',
          detectorId: 'naming-census',
        }),
      );
    }
  }

  for (const filePath of listPlanningFiles(path.join(context.planningDir, 'feature-dossiers'), { maxDepth: 2 })) {
    const base = path.basename(filePath);
    if (!/^FEAT-\d{3}\.md$/i.test(base)) {
      findings.push(
        createFinding({
          classId: 'B2',
          severity: 'advisory',
          artifact: relativeToPlanning(context.planningDir, filePath),
          evidence: 'Feature dossier filenames must match FEAT-NNN.md.',
          remediationHint: 'Rename feature dossier files to the FEAT-NNN.md convention.',
          detectorId: 'naming-census',
        }),
      );
    }
  }

  for (const filePath of listPlanningFiles(path.join(context.planningDir, 'stories'), { maxDepth: 2 })) {
    const base = path.basename(filePath);
    if (!/^(E[A-Z0-9_]+-S\d+|LANDING-S\d+)([-_].+)?\.md$/i.test(base)) {
      findings.push(
        createFinding({
          classId: 'B2',
          severity: 'advisory',
          artifact: relativeToPlanning(context.planningDir, filePath),
          evidence: 'Story filenames must match E{n}-S{n}.md or LANDING-S{n}.md.',
          remediationHint: 'Rename story files to the canonical story naming convention.',
          detectorId: 'naming-census',
        }),
      );
    }
  }
}

function detectPhantomReferences(context, findings) {
  const prdText = readText(path.join(context.planningDir, 'prd.md'));
  const trdText = readText(path.join(context.planningDir, 'trd.md'));
  const implicitText = readText(path.join(context.planningDir, 'implicit-requirements.md'));
  const rtm = readJson(path.join(context.planningDir, 'rtm.json')) || {};

  const definedRequirementIds = new Set(
    unique([
      ...collectIdsFromText(prdText, /\b(FR)-0*(\d+)\b/giu),
      ...collectIdsFromText(trdText, /\b(TR|NFR)-0*(\d+)\b/giu),
      ...collectIdsFromText(implicitText, /\b(IR)-0*(\d+)\b/giu),
      ...Object.keys(rtm.requirements || {}).map(canonicalRequirementKey),
      ...(Array.isArray(rtm.requirements) ? rtm.requirements.map((entry) => canonicalRequirementKey(entry?.id)) : []),
    ]),
  );

  const referenceSources = ['epics.md', 'milestones.md', 'cross-milestone-analysis.md', 'traceability-matrix.md'];
  for (const relativePath of referenceSources) {
    const content = readText(path.join(context.planningDir, relativePath));
    if (!content) continue;
    const referenced = unique([
      ...collectIdsFromText(content, /\b(FR|NFR|TR|IR)-0*(\d+)\b/giu).map(canonicalRequirementKey),
    ]);
    for (const requirementId of referenced) {
      if (definedRequirementIds.has(requirementId)) continue;
      findings.push(
        createFinding({
          classId: 'B3',
          severity: 'critical',
          artifact: relativePath,
          evidence: `Referenced requirement ${requirementId} is not defined in PRD/TRD/implicit requirements or RTM.`,
          remediationHint: 'Remove phantom requirement references or add the missing source requirement definition.',
          detectorId: 'naming-census',
        }),
      );
    }
  }

  const featureRegistry = readJson(path.join(context.planningDir, 'feature-registry.json'));
  for (const feature of featureRegistry?.features || []) {
    const featureId = String(feature.featureId || '')
      .trim()
      .toUpperCase();
    if (!featureId) continue;
    const dossierPaths = [
      path.join(context.planningDir, 'feature-dossiers', `${featureId}.md`),
      path.join(context.planningDir, 'features', `${featureId}.md`),
    ];
    if (dossierPaths.some((filePath) => require('node:fs').existsSync(filePath))) continue;
    findings.push(
      createFinding({
        classId: 'B3',
        severity: 'critical',
        artifact: `feature-registry:${featureId}`,
        evidence: `Feature ${featureId} is declared but no canonical feature dossier exists on disk.`,
        remediationHint: 'Generate the missing feature dossier or remove the phantom feature registry entry.',
        detectorId: 'naming-census',
      }),
    );
  }

  const storyTracker = readJson(path.join(context.planningDir, 'story-tracker.json'));
  for (const story of storyTracker?.stories || []) {
    const storyId = String(story.id || story.storyId || '').trim();
    if (!storyId) continue;
    const storyFile = story.storyFile
      ? path.join(context.planningDir, toPosix(story.storyFile))
      : path.join(context.planningDir, 'stories', `${storyId}.md`);
    if (require('node:fs').existsSync(storyFile)) continue;
    findings.push(
      createFinding({
        classId: 'B3',
        severity: 'critical',
        artifact: `story-tracker:${storyId}`,
        evidence: `Story ${storyId} is declared but the corresponding story file is missing.`,
        remediationHint:
          'Generate the missing story file or remove the phantom story reference from story-tracker.json.',
        detectorId: 'naming-census',
      }),
    );
  }
}

function detectProjectLeakage(context, findings) {
  const state = loadState(context.projectRoot);
  const declaredName = String(
    state?.project?.name || state?.projectName || state?.project?.displayName || state?.project?.title || '',
  ).trim();
  const lowerDeclared = declaredName.toLowerCase();
  const files = listPlanningFiles(context.planningDir, { maxDepth: 4 }).filter((filePath) =>
    /\.(md|json)$/i.test(filePath),
  );

  for (const filePath of files) {
    const content = readText(filePath);
    for (const canary of CANARY_NAMES) {
      if (lowerDeclared && canary.toLowerCase() === lowerDeclared) continue;
      const pattern = new RegExp(`\\b${canary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (!pattern.test(content)) continue;
      findings.push(
        createFinding({
          classId: 'F3',
          severity: 'advisory',
          artifact: relativeToPlanning(context.planningDir, filePath),
          evidence: `Detected unrelated project canary "${canary}" in planning content.`,
          remediationHint:
            'Replace cross-project leakage with the current project name and regenerate the affected artifact.',
          detectorId: 'naming-census',
        }),
      );
    }
  }
}

function detectStoryTrackerSync(context, findings) {
  const tracker = readJson(path.join(context.planningDir, 'story-tracker.json')) || {};
  const trackerIds = new Set(
    (tracker.stories || []).map((story) => normalizeStoryId(story.id || story.storyId)).filter(Boolean),
  );
  const storyFiles = listPlanningFiles(path.join(context.planningDir, 'stories'), { maxDepth: 2 }).filter((filePath) =>
    /\.md$/i.test(filePath),
  );
  for (const filePath of storyFiles) {
    const storyId = storyIdFromFilename(path.basename(filePath));
    if (!storyId || trackerIds.has(storyId)) continue;
    findings.push(
      createFinding({
        classId: 'B3',
        severity: 'critical',
        artifact: relativeToPlanning(context.planningDir, filePath),
        evidence: `Story file ${storyId} exists on disk but is missing from story-tracker.json.`,
        remediationHint: 'Register every canonical story file in story-tracker.json before build handoff.',
        detectorId: 'naming-census',
      }),
    );
  }

  const epicStoryIds = new Set(expectedStoryIdsFromEpics(context.planningDir));
  for (const storyId of epicStoryIds) {
    if (trackerIds.has(storyId)) continue;
    findings.push(
      createFinding({
        classId: 'C3',
        severity: 'critical',
        artifact: 'story-tracker.json',
        evidence: `epics.md references ${storyId} but story-tracker.json does not register it.`,
        remediationHint: 'Synchronize epics.md story IDs into story-tracker.json before build handoff.',
        detectorId: 'naming-census',
      }),
    );
  }
}

function run(context) {
  const findings = [];
  detectMilestoneNumbering(context, findings);
  detectIdentifierStyleDrift(context, findings);
  detectNamingVariants(context, findings);
  detectPhantomReferences(context, findings);
  detectStoryTrackerSync(context, findings);
  detectProjectLeakage(context, findings);

  return {
    detectorId: 'naming-census',
    findings: dedupeFindings(findings),
    metadata: {
      canaryCount: CANARY_NAMES.length,
    },
  };
}

module.exports = { id: 'naming-census', run, CANARY_NAMES };
