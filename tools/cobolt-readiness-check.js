#!/usr/bin/env node

// CoBolt Readiness Check — Deterministic implementation readiness scoring
//
// Handles 5 of 7 readiness dimensions deterministically (no LLM needed).
// Remaining dimensions (architecture alignment and deep BDD quality) stay LLM.
//
// Dimensions:
//   D1 FR Traceability — RTM coverage check (100% = 10, <85% = fail)
//   D2 Document Presence — all planning artifacts on disk (preflight check)
//   D3 Epic/Story Coverage — stories-per-FR ratio, story completeness
//   D4 Frontend Completeness — UI implementation planning coverage
//   D5 Feature Readiness — FEAT-NNN dossier and cross-layer coverage gate
//
// Usage:
//   node tools/cobolt-readiness-check.js check           # Run all 5 checks
//   node tools/cobolt-readiness-check.js check --json     # Machine-readable output
//   node tools/cobolt-readiness-check.js score            # Numeric score only
//
// Exit codes:
//   0 = all dimensions pass
//   1 = one or more fail
//   2 = usage error

const fs = require('node:fs');
const path = require('node:path');
const {
  extractRequirementDefinitions,
  extractRequirementReferences,
  normalizeRequirementId,
} = require('../lib/cobolt-requirements');
const {
  getPlanningDir,
  getStoryCoverage,
  normalizeStoryId,
  resolveStoryFile,
} = require('../lib/cobolt-planning-artifacts');
const { getSourcePacketIntegrityStatus } = require('../lib/cobolt-source-packet');
const { PreflightChecker } = require('./cobolt-preflight');
const { run: runFrontendCompleteness } = require('./cobolt-frontend-completeness');
const { readJsonVerified } = require('../lib/cobolt-state-integrity');
const { evaluateCoverageAgainstText } = require('./cobolt-source-coverage');
const { runCheck: runFeatureCoverage } = require('./cobolt-feature-coverage');

// ── Path Resolution ─────────────────────────────────────────

function planningDir() {
  return getPlanningDir(process.cwd(), { strict: true, fallbackToLatest: true });
}

const TYPE_LABELS = {
  functional: 'FR',
  'non-functional': 'NFR',
  technical: 'TR',
  implicit: 'IR',
};

function isReadinessRequirement(requirement) {
  return requirement?.source !== 'source-registry';
}

function splitReadinessRequirements(requirements) {
  const primary = requirements.filter(isReadinessRequirement);
  const sourceRegistryRows = requirements.length - primary.length;
  return {
    primary: primary.length > 0 ? primary : requirements,
    sourceRegistryRows: primary.length > 0 ? sourceRegistryRows : 0,
  };
}

function normalizeMilestoneFilter(value) {
  const match = String(value || '')
    .trim()
    .toUpperCase()
    .match(/^M?(\d+)$/);
  return match ? `M${parseInt(match[1], 10)}` : null;
}

function requirementMilestones(requirement) {
  const values = [
    requirement?.milestone,
    requirement?.milestoneId,
    ...(Array.isArray(requirement?.milestones) ? requirement.milestones : []),
  ];
  return values.map((value) => normalizeMilestoneFilter(value)).filter(Boolean);
}

function filterRequirementsByMilestone(requirements, milestone) {
  const scopedMilestone = normalizeMilestoneFilter(milestone);
  if (!scopedMilestone) return requirements;
  return requirements.filter((requirement) => requirementMilestones(requirement).includes(scopedMilestone));
}

function storyIdBelongsToMilestone(storyId, milestone) {
  const scopedMilestone = normalizeMilestoneFilter(milestone);
  if (!scopedMilestone) return true;
  return String(storyId || '')
    .trim()
    .toUpperCase()
    .startsWith(`${scopedMilestone}.`);
}

function filterDensityToMilestone(density, milestone) {
  const scopedMilestone = normalizeMilestoneFilter(milestone);
  if (!scopedMilestone) return density;
  const milestones = Array.isArray(density?.milestones)
    ? density.milestones.filter((entry) => normalizeMilestoneFilter(entry.id) === scopedMilestone)
    : [];
  const failing = (density?.failing || []).filter((id) => normalizeMilestoneFilter(id) === scopedMilestone);
  const warnings = (density?.warnings || []).filter((id) => normalizeMilestoneFilter(id) === scopedMilestone);
  return { ...density, milestones, failing, warnings, passed: failing.length === 0 };
}

function filterEpicDensityToMilestone(epicDensity, milestone) {
  const scopedMilestone = normalizeMilestoneFilter(milestone);
  if (!scopedMilestone) return epicDensity;
  const epics = Array.isArray(epicDensity?.epics)
    ? epicDensity.epics.filter(
        (entry) =>
          normalizeMilestoneFilter(entry.milestone) === scopedMilestone ||
          String(entry.id || '')
            .toUpperCase()
            .startsWith(`${scopedMilestone}.`),
      )
    : [];
  const scopedIds = new Set(epics.map((entry) => entry.id));
  const failing = (epicDensity?.failing || []).filter((id) => scopedIds.has(id));
  const warnings = (epicDensity?.warnings || []).filter((id) => scopedIds.has(id));
  return { ...epicDensity, epics, failing, warnings, passed: failing.length === 0 };
}

function parseOptionValue(args, name) {
  const index = args.indexOf(name);
  return index !== -1 ? args[index + 1] : null;
}

function readRequirementInventory() {
  const rtmPath = path.join(planningDir(), 'rtm.json');
  if (fs.existsSync(rtmPath)) {
    try {
      const { data: rtm, integrity } = readJsonVerified(rtmPath);
      if (rtm && (integrity.valid || !integrity.reason?.includes('mismatch')))
        return Object.values(rtm.requirements || {});
    } catch {
      /* fall back to document parsing */
    }
  }

  const files = [
    path.join(planningDir(), 'prd.md'),
    path.join(planningDir(), 'trd.md'),
    path.join(planningDir(), 'implicit-requirements.md'),
  ];

  const requirements = [];
  for (const filePath of files) {
    if (!fs.existsSync(filePath)) continue;
    requirements.push(...extractRequirementDefinitions(fs.readFileSync(filePath, 'utf8')));
  }

  return requirements;
}

function addRtmStoryMappedRequirementIds(mappedRequirementIds, requirementIds, pd) {
  const rtmPath = path.join(pd, 'rtm.json');
  if (!fs.existsSync(rtmPath)) return 0;

  try {
    const { data: rtm, integrity } = readJsonVerified(rtmPath);
    if (!rtm || (!integrity.valid && integrity.reason?.includes('mismatch'))) return 0;

    const entries = Array.isArray(rtm.requirements)
      ? rtm.requirements.map((requirement) => [requirement?.id, requirement])
      : Object.entries(rtm.requirements || {});
    let added = 0;

    for (const [key, requirement] of entries) {
      const requirementId = normalizeRequirementId(requirement?.id || key);
      if (!requirementId || !requirementIds.has(requirementId)) continue;
      const stories = Array.isArray(requirement?.stories) ? requirement.stories : [];
      const hasStoryLink = stories.some((storyId) => String(storyId || '').trim());
      if (!hasStoryLink || mappedRequirementIds.has(requirementId)) continue;
      mappedRequirementIds.add(requirementId);
      added += 1;
    }

    return added;
  } catch {
    return 0;
  }
}

function getReadinessArtifacts() {
  const checker = new PreflightChecker(process.cwd());
  const buildSkill = checker.deps?.skills?.['cobolt-build'];
  if (!buildSkill) return [];

  const excludedArtifacts = new Set([
    'readiness-report',
    'readiness-report-json',
    'sprint-status',
    'story-tracker',
    'story-file',
  ]);
  return (buildSkill.requires || [])
    .filter((artifactId) => !excludedArtifacts.has(artifactId))
    .map((artifactId) => ({ artifactId, result: checker._checkRequiredArtifact(artifactId) }));
}

// ── D1: FR Traceability from RTM ────────────────────────────

function d1FrTraceability(options = {}) {
  const findings = [];
  let score = 10;
  const milestone = normalizeMilestoneFilter(options.milestone);

  const rtmPath = path.join(planningDir(), 'rtm.json');
  if (!fs.existsSync(rtmPath)) {
    findings.push('rtm.json not found — cannot assess FR traceability');
    return { dimension: 'D1', name: 'Requirement Traceability', score: 0, weight: 0.15, findings };
  }

  const { data: rtm, integrity } = readJsonVerified(rtmPath);
  if (!rtm) {
    findings.push('rtm.json could not be read or verified');
    return { dimension: 'D1', name: 'Requirement Traceability', score: 0, weight: 0.15, findings };
  }
  if (!integrity.valid && integrity.reason?.includes('mismatch')) {
    findings.push(`rtm.json integrity check failed: ${integrity.reason}`);
    return { dimension: 'D1', name: 'Requirement Traceability', score: 0, weight: 0.15, findings };
  }
  const allReqs = Object.values(rtm.requirements || {});
  const split = splitReadinessRequirements(allReqs);
  const reqs = filterRequirementsByMilestone(split.primary, milestone);
  const sourceRegistryRows = split.sourceRegistryRows;
  const total = reqs.length;
  if (milestone) {
    findings.push(`Scope: ${milestone} (${total} requirement(s))`);
  }
  if (sourceRegistryRows > 0) {
    findings.push(
      `Source-registry support rows excluded from delivery-mapping score: ${sourceRegistryRows} (validated separately by source coverage gates)`,
    );
  }

  if (total === 0) {
    findings.push(
      milestone ? `No RTM requirements are assigned to ${milestone}` : 'RTM is empty — no requirements imported',
    );
    return { dimension: 'D1', name: 'Requirement Traceability', score: milestone ? 10 : 0, weight: 0.15, findings };
  }

  // Count by status
  const byStatus = {};
  for (const r of reqs) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  }

  // Readiness measures mapping completeness, not post-build implementation claims.
  const mapped = reqs.filter((r) => ['mapped', 'coded', 'tested', 'covered'].includes(r.status)).length;
  const coverage = (mapped / total) * 100;

  findings.push(`RTM: ${total} requirements, ${mapped} mapped (${coverage.toFixed(1)}%)`);

  // Check by type
  for (const [type, label] of Object.entries(TYPE_LABELS)) {
    const typeReqs = reqs.filter((r) => r.type === type);
    if (typeReqs.length === 0) continue;
    const typeMapped = typeReqs.filter((r) => ['mapped', 'coded', 'tested', 'covered'].includes(r.status)).length;
    const typeCov = ((typeMapped / typeReqs.length) * 100).toFixed(1);
    findings.push(`  ${label}: ${typeMapped}/${typeReqs.length} (${typeCov}%)`);
  }

  // Unmapped requirements
  const unmapped = reqs.filter((r) => r.status === 'pending' || r.status === 'gap');
  if (unmapped.length > 0) {
    findings.push(`Unmapped: ${unmapped.map((r) => r.id).join(', ')}`);
  }

  // Score based on coverage
  if (coverage >= 100) score = 10;
  else if (coverage >= 95) score = 9;
  else if (coverage >= 90) score = 8;
  else if (coverage >= 85) score = 7;
  else if (coverage >= 75) score = 5;
  else if (coverage >= 50) score = 3;
  else score = 1;

  return { dimension: 'D1', name: 'Requirement Traceability', score, weight: 0.15, findings, coverage };
}

// ── D2: Document Presence ───────────────────────────────────

function d2DocumentPresence() {
  const findings = [];
  let score = 10;
  const readinessArtifacts = getReadinessArtifacts();
  const sourcePacket = getSourcePacketIntegrityStatus(process.cwd(), planningDir(), { minBytes: 300 });

  if (readinessArtifacts.length === 0) {
    findings.push('artifact-dependencies.json not available - cannot assess document presence');
    return { dimension: 'D2', name: 'Document Presence', score: 0, weight: 0.2, findings };
  }

  let presentCount = 0;
  let criticalMissing = 0;

  for (const { artifactId, result } of readinessArtifacts) {
    if (!result.exists) {
      findings.push(`MISSING: ${artifactId} (${result.path})`);
      score -= 1.5;
      criticalMissing++;
      continue;
    }

    if (result.size < result.minBytes) {
      findings.push(`STUB: ${artifactId} (${result.size}B < ${result.minBytes}B min)`);
      score -= 1;
      continue;
    }

    presentCount++;
  }

  findings.unshift(`${presentCount}/${readinessArtifacts.length} artifacts present and valid`);
  if (criticalMissing > 0) {
    findings.push(`${criticalMissing} build-critical artifacts missing before sprint prep`);
  }

  if (sourcePacket.required) {
    if (sourcePacket.valid) {
      findings.push('SOURCE PACKET: PRD frontmatter is linked to a valid source-document-consolidation.md packet.');
    } else {
      score = Math.min(score, 4);
      for (const issue of sourcePacket.issues) {
        findings.push(`SOURCE PACKET: ${issue}`);
      }
    }
  }

  return { dimension: 'D2', name: 'Document Presence', score: Math.max(0, score), weight: 0.2, findings };
}

// ── D3: Epic/Story Coverage ─────────────────────────────────

function d3StoryCoverage(options = {}) {
  const findings = [];
  let score = 10;
  const pd = planningDir();
  const checker = new PreflightChecker(process.cwd());
  const milestone = normalizeMilestoneFilter(options.milestone);

  const allRequirements = readRequirementInventory();
  const split = splitReadinessRequirements(allRequirements);
  const requirements = filterRequirementsByMilestone(split.primary, milestone);
  const sourceRegistryRows = split.sourceRegistryRows;
  const requirementIds = new Set(
    requirements.map((requirement) => normalizeRequirementId(requirement.id)).filter(Boolean),
  );
  const totalRequirements = requirementIds.size;
  if (milestone) findings.push(`Scope: ${milestone} (${totalRequirements} requirement(s))`);

  // Read epics for story count and FR references
  const epicsPath = path.join(pd, 'epics.md');
  if (!fs.existsSync(epicsPath)) {
    findings.push('epics.md not found — cannot assess story coverage');
    return { dimension: 'D3', name: 'Story Coverage', score: 0, weight: 0.15, findings };
  }

  const epicsContent = fs.readFileSync(epicsPath, 'utf8');

  // Count epics and stories (match canonical + brownfield milestone-scoped ID formats)
  const epicMatches = [...epicsContent.matchAll(/^#{2,4}\s+(?:Epic\s+)?((?:M\d+\.)?E[A-Z0-9_]+)(?!-S\d).*$/gim)].filter(
    (match) =>
      !milestone ||
      String(match[1] || '')
        .toUpperCase()
        .startsWith(`${milestone}.`) ||
      new RegExp(`\\b${milestone}\\b`, 'i').test(match[0] || ''),
  );
  const storyMatches = [
    ...epicsContent.matchAll(/(E[A-Z0-9_]+-S\d+|M\d+\.S\d+|S-\d+\.\d+|S-\d+-\d+|S\d+\.\d+|\d+-\d+)/gim),
  ].filter((match) => !milestone || storyIdBelongsToMilestone(match[1], milestone));
  const epicCount = epicMatches.length;
  const storyCount = new Set(storyMatches.map((m) => normalizeStoryId(m[1])).filter(Boolean)).size;

  const storyDir = path.join(pd, 'stories');
  let storyContent = '';
  if (fs.existsSync(storyDir)) {
    try {
      storyContent = fs
        .readdirSync(storyDir)
        .filter((entry) => entry.endsWith('.md'))
        .map((entry) => fs.readFileSync(path.join(storyDir, entry), 'utf8'))
        .join('\n');
    } catch {
      /* ignore unreadable story directories */
    }
  }

  const mappedRequirementIds = new Set(
    [...extractRequirementReferences(epicsContent), ...extractRequirementReferences(storyContent)]
      .map((id) => normalizeRequirementId(id))
      .filter((id) => id && requirementIds.has(id)),
  );
  const rtmStoryMappedCount = addRtmStoryMappedRequirementIds(mappedRequirementIds, requirementIds, pd);

  findings.push(`Epics: ${epicCount} | Stories: ${storyCount} | Requirements in planning set: ${totalRequirements}`);
  if (sourceRegistryRows > 0) {
    findings.push(
      `Source-registry support rows excluded from story-mapping score: ${sourceRegistryRows} (source text coverage remains mandatory)`,
    );
  }
  if (rtmStoryMappedCount > 0) findings.push(`RTM story mappings counted: +${rtmStoryMappedCount}`);

  if (totalRequirements > 0) {
    const requirementCoverage = (mappedRequirementIds.size / totalRequirements) * 100;
    findings.push(
      `Requirement coverage in epics/stories: ${mappedRequirementIds.size}/${totalRequirements} (${requirementCoverage.toFixed(1)}%)`,
    );
    if (requirementCoverage < 80) {
      score -= 3;
      findings.push('WARN: < 80% of requirements are referenced in epics/stories');
    } else if (requirementCoverage < 100) {
      score -= 1;
    }
  }

  // Story density (at least 2 stories per epic avg)
  if (epicCount > 0) {
    const avgStories = storyCount / epicCount;
    findings.push(`Average stories/epic: ${avgStories.toFixed(1)}`);
    if (avgStories < 1) {
      score -= 2;
      findings.push('WARN: Some epics have no stories');
    }
  }

  // Check for BDD syntax in epics (Given/When/Then)
  const bddCount = [...epicsContent.matchAll(/\b(Given|When|Then)\b/g)].length;
  if (bddCount === 0) {
    findings.push('No BDD syntax (Given/When/Then) found in epics');
    score -= 1;
  } else {
    findings.push(`BDD markers found: ${bddCount}`);
  }

  // Check story files on disk using the canonical slug-aware resolver
  let storyIds = [...new Set(storyMatches.map((m) => m[1].toUpperCase()))];
  const storyTrackerPath = path.join(pd, 'story-tracker.json');
  let trackerContent = '';
  if (fs.existsSync(storyTrackerPath)) {
    try {
      const tracker = JSON.parse(fs.readFileSync(storyTrackerPath, 'utf8'));
      const trackedIds = (tracker.stories || [])
        .filter((story) => !milestone || normalizeMilestoneFilter(story.milestone || story.milestoneId) === milestone)
        .map((story) => String(story.id || '').toUpperCase())
        .filter(Boolean);
      if (trackedIds.length > 0) storyIds = trackedIds;
      trackerContent = JSON.stringify(tracker);
    } catch {
      /* ignore unreadable tracker */
    }
  }

  const coverage = getStoryCoverage(pd, { planningDir: pd });
  const expectedStoryIds = storyIds.length > 0 ? storyIds : coverage.expectedStoryIds;
  let storyFilesPresent = 0;
  for (const storyId of expectedStoryIds) {
    if (resolveStoryFile(storyId, pd, { planningDir: pd })) storyFilesPresent++;
  }

  findings.push(`Story files on disk: ${storyFilesPresent}/${expectedStoryIds.length}`);
  if (expectedStoryIds.length > 0 && storyFilesPresent > 0 && storyFilesPresent < expectedStoryIds.length) {
    score -= 1;
    findings.push('WARN: Story enrichment has started but spec-kit coverage is incomplete');
  } else if (expectedStoryIds.length > 0 && storyFilesPresent === 0) {
    findings.push('Story spec-kits have not been generated yet - expected after sprint planning');
  }

  // Validate tracker dependency integrity (bidirectional links)
  if (fs.existsSync(storyTrackerPath)) {
    try {
      const { validateStoryTracker } = require('./cobolt-tracker-init');
      const trackerData = JSON.parse(fs.readFileSync(storyTrackerPath, 'utf8'));
      const depErrors = validateStoryTracker(trackerData);
      if (depErrors.length > 0) {
        score -= 2;
        findings.push(`WARN: ${depErrors.length} tracker dependency error(s): ${depErrors.slice(0, 3).join('; ')}`);
      } else {
        findings.push('Story tracker dependency integrity: OK');
      }
    } catch {
      findings.push('Story tracker dependency validation skipped (tracker unreadable)');
    }
  }

  if (milestone) {
    findings.push(
      `Source coverage in epics/stories: milestone-scoped; full source registry remains enforced by build-ready and feature-coverage gates.`,
    );
  } else {
    const sourceCoverage = evaluateCoverageAgainstText([epicsContent, trackerContent, storyContent].join('\n'), {
      threshold: 100,
      projectRoot: process.cwd(),
      planningDir: pd,
      targetFile: epicsPath,
      writeReport: false,
    });
    if (sourceCoverage.result?.skipped) {
      findings.push('Source coverage in epics/stories: skipped (no required source packet)');
    } else {
      findings.push(
        `Source coverage in epics/stories: ${sourceCoverage.result?.matchedRequirements || 0}/${sourceCoverage.result?.includedRequirements || 0} (${sourceCoverage.result?.coverage || 0}%)`,
      );
      if (!sourceCoverage.result?.passed) {
        score = Math.min(
          score,
          Array.isArray(sourceCoverage.result?.issues) && sourceCoverage.result.issues.length > 0 ? 0 : 4,
        );
        if (Array.isArray(sourceCoverage.result?.issues)) {
          for (const issue of sourceCoverage.result.issues) {
            findings.push(`SOURCE GATE: ${issue}`);
          }
        }
        if (Array.isArray(sourceCoverage.result?.unmatched) && sourceCoverage.result.unmatched.length > 0) {
          findings.push(
            `SOURCE GATE: Missing from epics/stories -> ${sourceCoverage.result.unmatched
              .slice(0, 5)
              .map((entry) => entry.id)
              .join(', ')}${sourceCoverage.result.unmatched.length > 5 ? '...' : ''}`,
          );
        }
      }
    }
  }

  const density = filterDensityToMilestone(checker.validateMilestoneStoryDensity(), milestone);
  if (density.milestones.length > 0) {
    findings.push(
      `Story density target: ${density.targets.storyCount.min}-${density.targets.storyCount.max} stories per milestone, warning above ${density.targets.frPerStory.warning} FR/story, hard limit ${density.targets.frPerStory.hardLimit} FR/story`,
    );
    for (const milestone of density.milestones) {
      if (milestone.status === 'ok') continue;
      findings.push(
        `Story density ${milestone.status.toUpperCase()}: ${milestone.id} has ${milestone.frCount} FRs across ${milestone.storyCount} stories (${milestone.avgFrPerStory?.toFixed(2) || 'n/a'} FR/story)`,
      );
      if (milestone.recommendation) findings.push(`  ${milestone.recommendation}`);
    }
  } else if (!density.passed) {
    findings.push(density.message);
  }

  const densityHardFail = density.failing.length > 0;
  if (densityHardFail) {
    score = 0;
    findings.push(`HARD FAIL: planning story density is invalid for ${density.failing.join(', ')}`);
  } else if (density.warnings.length > 0) {
    score -= 1;
    // v0.48+ — if the plan orchestrator already attempted auto-correction
    // (step 21c) and warnings persisted, surface that fact as a separate
    // finding so operators see that retry was attempted rather than skipped.
    // Score deduction stays at -1 (unchanged) — outcome drives the score,
    // not the attempt count. density-state.json is emitted by
    // cobolt-story-density-correction.js.
    try {
      const densityState = JSON.parse(fs.readFileSync(path.join(planningDir(), 'density-state.json'), 'utf8'));
      if (Number(densityState?.redispatchAttempts || 0) >= 1) {
        findings.push(
          `Story density: warnings persisted after auto-correction attempt (redispatchAttempts=${densityState.redispatchAttempts}); carry-forward recorded.`,
        );
      }
    } catch {
      /* density-state.json absent — older plan run or step 21c skipped; no extra finding */
    }
  }

  const epicDensity = filterEpicDensityToMilestone(checker.validateEpicDensity(), milestone);
  if (epicDensity.epics.length > 0) {
    findings.push(
      `Epic density target: ${epicDensity.thresholds.storiesPerEpic.min}-${epicDensity.thresholds.storiesPerEpic.max} stories per epic, hard limit ${epicDensity.thresholds.storiesPerEpic.hardLimit}, hard fail above ${epicDensity.thresholds.frPerStory.hardLimit} FR/story`,
    );
    for (const epic of epicDensity.epics) {
      if (epic.status === 'ok') continue;
      findings.push(
        `Epic density ${epic.status.toUpperCase()}: ${epic.id} has ${epic.storyCount} stories and ${epic.frCount} FRs (${epic.avgFrPerStory?.toFixed(2) || 'n/a'} FR/story)`,
      );
      if (epic.recommendation) findings.push(`  ${epic.recommendation}`);
    }
  } else if (!epicDensity.passed) {
    findings.push(epicDensity.message);
  }

  const epicDensityHardFail = epicDensity.failing.length > 0;
  if (epicDensityHardFail) {
    score = 0;
    findings.push(`HARD FAIL: epic decomposition is invalid for ${epicDensity.failing.join(', ')}`);
  } else if (epicDensity.warnings.length > 0) {
    score -= 1;
  }

  return {
    dimension: 'D3',
    name: 'Story Coverage',
    score: Math.max(0, score),
    weight: 0.15,
    findings,
    hardFail: densityHardFail || epicDensityHardFail,
  };
}

function d4FrontendCompleteness() {
  const findings = [];
  const result = runFrontendCompleteness(process.cwd(), { planningDir: planningDir() });

  if (result.skipped) {
    findings.push(...(result.findings || []));
    return { dimension: 'D4', name: 'Frontend Completeness', score: 10, weight: 0.15, findings };
  }

  findings.push(...(result.findings || []));
  for (const issue of result.issues || []) {
    findings.push(`ISSUE: ${issue}`);
  }

  return {
    dimension: 'D4',
    name: 'Frontend Completeness',
    score: result.passed ? Math.max(0, Number(result.score || 0)) : Math.min(Math.max(0, Number(result.score || 0)), 4),
    weight: 0.15,
    findings,
  };
}

function d5FeatureReadiness() {
  const findings = [];
  const { result } = runFeatureCoverage({
    projectRoot: process.cwd(),
    planningDir: planningDir(),
    stage: 'final',
  });

  findings.push(
    `Feature readiness: ${result.summary.readyFeatures}/${result.summary.totalFeatures} READY, ${result.summary.draftOnlyFeatures} DRAFT_ONLY, ${result.summary.blockedFeatures} BLOCKED`,
  );
  findings.push(`Feature source coverage: ${result.sourceCoverage.mapped}/${result.sourceCoverage.total}`);

  for (const issue of result.packetIssues || []) {
    findings.push(`FEATURE GATE: ${issue}`);
  }

  for (const feature of result.features || []) {
    if (feature.status === 'READY') continue;
    findings.push(
      `FEATURE ${feature.status}: ${feature.featureId || '(invalid feature)'} ${feature.title || ''}`.trim(),
    );
    for (const issue of (feature.issues || []).slice(0, 3)) {
      findings.push(`  ${issue}`);
    }
    for (const assumption of (feature.assumptions || []).slice(0, 3)) {
      findings.push(`  ${assumption}`);
    }
  }

  let score = 10;
  if (!result.passed) {
    score = result.summary.totalFeatures > 0 && result.summary.blockedFeatures === 0 ? 4 : 0;
  }

  return {
    dimension: 'D5',
    name: 'Feature Readiness',
    score,
    weight: 0.2,
    findings,
    hardFail: !result.passed,
  };
}

// ── Scoring / Grading ───────────────────────────────────────

function computeGrade(score) {
  if (score >= 9.5) return 'A+';
  if (score >= 9.0) return 'A';
  if (score >= 8.5) return 'A-';
  if (score >= 8.0) return 'B+';
  if (score >= 7.5) return 'B';
  if (score >= 7.0) return 'B-';
  if (score >= 6.0) return 'C';
  if (score >= 5.0) return 'D';
  return 'F';
}

function computeVerdict(avgScore, failedCount) {
  if (failedCount === 0 && avgScore >= 7.0) return 'PASS';
  if (failedCount <= 1 && avgScore >= 5.0) return 'CONDITIONAL';
  return 'FAIL';
}

// ── Main ────────────────────────────────────────────────────

function runChecks(options = {}) {
  const results = [
    d1FrTraceability(options),
    d2DocumentPresence(),
    d3StoryCoverage(options),
    d4FrontendCompleteness(),
    d5FeatureReadiness(),
  ];

  // Weighted average (these 3 dimensions have combined weight 0.50 out of 1.0)
  const weightedSum = results.reduce((sum, r) => sum + r.score * r.weight, 0);
  const totalWeight = results.reduce((sum, r) => sum + r.weight, 0);
  const avgScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

  const failedDims = results.filter((r) => r.score < 5);
  const hardFailedDims = results.filter((r) => r.hardFail === true);
  const grade = computeGrade(avgScore);
  const verdict = hardFailedDims.length > 0 ? 'FAIL' : computeVerdict(avgScore, failedDims.length);

  return {
    dimensions: results,
    averageScore: Math.round(avgScore * 10) / 10,
    grade,
    verdict,
    failedDimensions: failedDims.map((r) => r.dimension),
    hardFailedDimensions: hardFailedDims.map((r) => r.dimension),
    note: 'Deterministic dimensions only (5/7). Remaining 2 (architecture alignment and deep BDD quality) require LLM evaluation.',
  };
}

// ── CLI ─────────────────────────────────────────────────────

function cmdCheck(args) {
  const jsonMode = args.includes('--json');
  const result = runChecks({ milestone: parseOptionValue(args, '--milestone') });

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('[cobolt-readiness-check] Deterministic Readiness Assessment (5/7 dimensions)');
    console.log('');
    for (const d of result.dimensions) {
      const status = d.score >= 7 ? 'PASS' : d.score >= 5 ? 'WARN' : 'FAIL';
      console.log(
        `  ${d.dimension} ${d.name}: ${d.score.toFixed(1)}/10 (weight: ${(d.weight * 100).toFixed(0)}%) [${status}]`,
      );
      for (const f of d.findings) {
        console.log(`    ${f}`);
      }
      console.log('');
    }
    console.log(`  Grade: ${result.grade} | Score: ${result.averageScore}/10 | Verdict: ${result.verdict}`);
    if (result.failedDimensions.length > 0) {
      console.log(`  Failed: ${result.failedDimensions.join(', ')}`);
    }
    if (result.hardFailedDimensions.length > 0) {
      console.log(`  Hard failed: ${result.hardFailedDimensions.join(', ')}`);
    }
  }

  // Write report
  const reportPath = path.join(planningDir(), 'readiness-deterministic.json');
  const dir = path.dirname(reportPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  // CB-OBS-17: emit the canonical readiness-report.{md,json} pair that
  // cobolt-check-implementation-readiness was historically expected to
  // produce. cobolt-build-ready-gate looks for both; without them the
  // gate halts with "remediation required" even when D1..D5 all PASS.
  // Keeping this in cobolt-readiness-check (rather than creating another
  // tool) guarantees a single source of truth for the scorecard.
  writeReadinessReportPair(result, planningDir());

  process.exit(result.verdict === 'FAIL' ? 1 : 0);
}

function writeReadinessReportPair(result, pd) {
  try {
    const jsonPayload = {
      version: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: 'cobolt-readiness-check',
      verdict: result.verdict === 'PASS' ? 'READY_FOR_BUILD' : result.verdict,
      overallGrade: result.grade,
      overallScore: result.averageScore,
      dimensions: Object.fromEntries(
        (result.dimensions || []).map((d) => [
          `${d.dimension}_${(d.name || '').replace(/\s+/g, '')}`,
          { score: d.score, weight: d.weight, verdict: d.score >= 7 ? 'PASS' : d.score >= 5 ? 'WARN' : 'FAIL' },
        ]),
      ),
      failedDimensions: result.failedDimensions || [],
      hardFailedDimensions: result.hardFailedDimensions || [],
      buildAuthorization: result.verdict === 'PASS' ? 'APPROVED' : 'WITHHELD',
      nextSkill: result.verdict === 'PASS' ? 'cobolt-build' : null,
    };
    const jsonPath = path.join(pd, 'readiness-report.json');
    fs.writeFileSync(jsonPath, `${JSON.stringify(jsonPayload, null, 2)}\n`, 'utf8');

    const lines = [
      `---`,
      `project: ${path.basename(process.cwd())}`,
      `producedBy: cobolt-readiness-check (deterministic)`,
      `generatedAt: ${jsonPayload.generatedAt}`,
      `verdict: ${jsonPayload.verdict}`,
      `---`,
      '',
      `# Implementation Readiness Report`,
      '',
      `**Verdict:** ${jsonPayload.verdict} — Grade ${jsonPayload.overallGrade} (${jsonPayload.overallScore}/10)`,
      '',
      `## Dimension Scorecard`,
      '',
      `| Dimension | Score | Weight | Verdict |`,
      `|-----------|-------|--------|---------|`,
      ...(result.dimensions || []).map((d) => {
        const v = d.score >= 7 ? 'PASS' : d.score >= 5 ? 'WARN' : 'FAIL';
        return `| ${d.dimension} ${d.name} | ${d.score.toFixed(1)}/10 | ${(d.weight * 100).toFixed(0)}% | ${v} |`;
      }),
      '',
      `## Build Authorization`,
      '',
      `- Overall: **${jsonPayload.buildAuthorization}**`,
      `- Next skill: ${jsonPayload.nextSkill ? `\`${jsonPayload.nextSkill}\`` : '(none — remediate failing dimensions first)'}`,
      '',
      result.failedDimensions?.length ? `**Failed dimensions:** ${result.failedDimensions.join(', ')}` : '',
      result.hardFailedDimensions?.length
        ? `**Hard-failed dimensions:** ${result.hardFailedDimensions.join(', ')}`
        : '',
      '',
    ]
      .filter(Boolean)
      .join('\n');
    fs.writeFileSync(path.join(pd, 'readiness-report.md'), lines, 'utf8');
  } catch (err) {
    // Never break the readiness gate on a report-write failure — just log.
    console.error(`[cobolt-readiness-check] WARNING: could not write readiness-report pair: ${err.message}`);
  }
}

if (require.main === module) {
  const [, , command, ...args] = process.argv;
  const printHelp = () => {
    console.log('CoBolt Readiness Check - Deterministic implementation readiness scoring');
    console.log('');
    console.log('Usage:');
    console.log('  node tools/cobolt-readiness-check.js check [--json]');
    console.log('  node tools/cobolt-readiness-check.js score');
    console.log('');
    console.log('Dimensions: D1 FR Traceability, D2 Document Presence, D3 Story Coverage');
    console.log('Remaining 3 dimensions require LLM evaluation.');
  };

  if (command === undefined || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  switch (command) {
    case 'check':
      cmdCheck(args);
      break;
    case 'score':
      {
        const result = runChecks({ milestone: parseOptionValue(args, '--milestone') });
        console.log(`${result.averageScore}`);
        process.exit(result.verdict === 'FAIL' ? 1 : 0);
      }
      break;
    default: {
      console.log('CoBolt Readiness Check — Deterministic implementation readiness scoring');
      console.log('');
      console.log('Usage:');
      console.log('  node tools/cobolt-readiness-check.js check [--json]');
      console.log('  node tools/cobolt-readiness-check.js score');
      console.log('');
      console.log('Dimensions: D1 FR Traceability, D2 Document Presence, D3 Story Coverage');
      console.log('Remaining 3 dimensions require LLM evaluation.');
      const isHelpOrEmpty = command === undefined || command === '--help' || command === '-h';
      process.exit(isHelpOrEmpty ? 0 : 1);
    }
  }
}

module.exports = { runChecks };
