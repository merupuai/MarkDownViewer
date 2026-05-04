#!/usr/bin/env node

// CoBolt Pre-Flight — Planning Artifact Gate Tool
//
// Deterministic check: do the required planning artifacts exist on disk
// before a downstream skill (build, review, fix, deploy, etc.) can run?
//
// Usage:
//   node tools/cobolt-preflight.js check <skill>           # Check if skill's deps exist
//   node tools/cobolt-preflight.js check cobolt-build       # Example: check build deps
//   node tools/cobolt-preflight.js check cobolt-dev-story   # Example: check dev deps
//   node tools/cobolt-preflight.js list                     # List all skills and deps
//   node tools/cobolt-preflight.js status                   # Show all artifact status
//   node tools/cobolt-preflight.js status --json            # Machine-readable
//
// Exit codes:
//   0 = all required artifacts exist
//   1 = one or more required artifacts missing
//   2 = usage error or schema missing
//
// Consumed by:
//   - cobolt-planning-gate.js (PreToolUse hook) — blocks skills with missing deps
//   - cobolt-plan SKILL.md — artifact verification protocol
//   - Developer CLI — manual pre-flight checks

const fs = require('node:fs');
const _os = require('node:os');
const path = require('node:path');
const _crypto = require('node:crypto');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const { CoboltPaths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { CoboltPaths: null };
  }
})();
const {
  getMilestonesDocument,
  getMilestoneFRCounts,
  getMilestoneIds,
  getMilestoneTitleMap,
  getPlanningDir,
  getStoryCoverage,
  normalizeMilestoneId,
  normalizeStoryId,
  resolveReadablePlanningDir,
  resolveStoryFile,
  safeReadJson,
} = require('../lib/cobolt-planning-artifacts');
const {
  extractRequirementDefinitions,
  extractRequirementReferences,
  normalizeRequirementId,
  normalizeRequirementLookupId,
  requirementPrefix,
} = require('../lib/cobolt-requirements');
const { SchemaValidator } = require('../lib/schema-validator');
const { getSourcePacketIntegrityStatus } = require('../lib/cobolt-source-packet');
const { evaluateCoverageAgainstText } = require('./cobolt-source-coverage');
const { validateBrownfieldContracts } = require('./cobolt-brownfield-contracts');

// Pure helpers extracted to lib/cobolt-preflight-helpers.js for isolated testing.
// Re-imported here so existing call sites keep working unchanged.
const {
  loadDependencies,
  artifactIdToStateKey,
  listCanonicalPlanningArtifactIds,
  parseBlockedTaskRef,
  milestoneNumber,
  percent,
  sha256,
} = require('../lib/cobolt-preflight-helpers');

function describeArtifactFile(root, filePath) {
  if (!filePath) return null;
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
  if (!fs.existsSync(absolutePath)) {
    return {
      path: path.relative(root, absolutePath).replaceAll('\\', '/'),
      exists: false,
      size: 0,
      sha256: null,
    };
  }

  const buffer = fs.readFileSync(absolutePath);
  return {
    path: path.relative(root, absolutePath).replaceAll('\\', '/'),
    exists: true,
    size: buffer.length,
    sha256: sha256(buffer),
  };
}

function sortRegroupOperations(operations) {
  return [...(operations || [])].sort((left, right) => {
    const leftKey = [
      String(left.storyId || ''),
      String(left.fromMilestone || ''),
      String(left.toMilestone || ''),
      String(left.storyLabel || ''),
    ].join(':');
    const rightKey = [
      String(right.storyId || ''),
      String(right.fromMilestone || ''),
      String(right.toMilestone || ''),
      String(right.storyLabel || ''),
    ].join(':');
    return leftKey.localeCompare(rightKey, undefined, { numeric: true });
  });
}

function sortUniqueIds(ids) {
  return [...new Set((ids || []).filter(Boolean).map((id) => String(id).toUpperCase()))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

function isCoverageAliasRequirement(entry) {
  return /^\s*Coverage alias for\s+[A-Z]+-\d+/i.test(String(entry?.title || entry?.description || ''));
}

function shouldUseRequirementLookupCandidate(existing, candidate) {
  if (!existing) return true;
  const existingIsAlias = isCoverageAliasRequirement(existing);
  const candidateIsAlias = isCoverageAliasRequirement(candidate);
  if (existingIsAlias && !candidateIsAlias) return true;
  if (!existingIsAlias && candidateIsAlias) return false;
  return true;
}

function extractStoryFrIds(story) {
  const direct = Array.isArray(story?.frIds) ? story.frIds : [];
  const singular = Array.isArray(story?.FR) ? story.FR : story?.FR ? [story.FR] : [];
  const fallback = Array.isArray(story?.requirementIds)
    ? story.requirementIds.filter((id) => /^FR-\d+/i.test(String(id || '').trim()))
    : [];
  return sortUniqueIds([...direct, ...singular, ...fallback]);
}

const DELIVERY_SLICE_TITLE_ANTI_PATTERNS = [
  { pattern: /\blayer\b/i, reason: 'sounds like a technical layer instead of a demoable outcome' },
  { pattern: /\bplatform\b/i, reason: 'reads like a platform bucket instead of one user capability' },
  { pattern: /\boperations\b/i, reason: 'suggests a department bucket instead of a focused milestone' },
  { pattern: /\bcommand\s+center\b/i, reason: 'usually bundles too many concerns into one milestone' },
  { pattern: /\breporting\b/i, reason: 'often becomes a catch-all bucket unless narrowly scoped' },
  { pattern: /\blaunch\b/i, reason: 'is release framing, not a user-visible capability slice' },
];

const EPIC_TECHNICAL_BUCKET_PATTERNS = [
  { pattern: /\blayer\b/i, reason: 'epic title reads like a technical layer instead of one user capability' },
  { pattern: /\bplatform\b/i, reason: 'epic title reads like a platform bucket instead of one feature outcome' },
  { pattern: /\bengine\b/i, reason: 'epic title reads like an engine/bucket instead of a focused user-facing slice' },
  {
    pattern: /\bcommand\s+center\b/i,
    reason: 'epic title usually indicates a control-plane bucket rather than one buildable feature',
  },
];

const DELIVERY_POINT_RULES = [
  {
    key: 'auth',
    label: 'auth/security',
    weight: 1,
    pattern: /\b(auth|authentication|authorize|authorization|login|session|identity|rbac|permission|mfa|sso|oauth)\b/i,
  },
  {
    key: 'payments',
    label: 'payments/commercial',
    weight: 1,
    pattern: /\b(payments?|billing|invoices?|subscriptions?|monetization|checkout|gst|tax|refund|settlement|ledger)\b/i,
  },
  {
    key: 'compliance',
    label: 'compliance/audit',
    weight: 1,
    pattern:
      /\b(compliance|audit|consent|retention|gdpr|hipaa|soc2|encryption|legal hold|policy controls?|privacy polic(?:y|ies)|security polic(?:y|ies)|data polic(?:y|ies))\b/i,
  },
  {
    key: 'ai',
    label: 'ai/intelligence',
    weight: 1,
    pattern: /\b(ai|llm|agent|prompt|rag|embedding|inference|intelligence|model)\b/i,
  },
  {
    key: 'migration',
    label: 'migration/data movement',
    weight: 0.75,
    pattern: /\b(migration|migrate|import|export|sync|etl|backfill|reconcile|cutover)\b/i,
  },
  {
    key: 'integration',
    label: 'integrations/marketplaces',
    weight: 0.5,
    pattern: /\b(integration|webhook|partner|marketplace|api|connector|notification|sms|whatsapp)\b/i,
  },
];

function evaluateTitleAntiPatterns(title, antiPatterns, options = {}) {
  const reasons = [];
  const normalizedTitle = String(title || '').trim();
  if (!normalizedTitle) return reasons;

  for (const rule of antiPatterns || []) {
    if (rule.pattern.test(normalizedTitle)) reasons.push(rule.reason);
  }

  const conjunctionCount = (normalizedTitle.match(/\s*&\s*|\s*\/\s*|,\s*/g) || []).length;
  if (options.flagMultiArea !== false && conjunctionCount >= (options.conjunctionThreshold || 2)) {
    reasons.push('bundles too many capability areas into one title');
  }

  return [...new Set(reasons)];
}

function readRequirementInventoryFromPlanningDir(planningDir) {
  if (!planningDir) return new Map();

  const requirementMap = new Map();
  const addRequirement = (id, entry) => {
    const normalizedId = normalizeRequirementId(id);
    if (!normalizedId) return;
    const lookupId = normalizeRequirementLookupId(normalizedId);
    const value = { ...entry, id: normalizedId };
    requirementMap.set(normalizedId, value);
    if (lookupId && shouldUseRequirementLookupCandidate(requirementMap.get(lookupId), value)) {
      requirementMap.set(lookupId, value);
    }
  };
  const rtmPath = path.join(planningDir, 'rtm.json');
  if (fs.existsSync(rtmPath)) {
    try {
      const rtm = JSON.parse(fs.readFileSync(rtmPath, 'utf8'));
      for (const entry of Object.values(rtm?.requirements || {})) {
        const id = normalizeRequirementId(entry?.id);
        if (!id) continue;
        addRequirement(id, {
          id,
          type: entry?.type || (requirementPrefix(id) || '').toLowerCase(),
          title: String(entry?.title || entry?.summary || ''),
          description: String(entry?.description || entry?.statement || entry?.text || ''),
          body: String(entry?.body || ''),
        });
      }
    } catch {
      /* fall back to markdown parsing */
    }
  }

  for (const fileName of ['prd.md', 'trd.md', 'implicit-requirements.md']) {
    const filePath = path.join(planningDir, fileName);
    if (!fs.existsSync(filePath)) continue;

    for (const definition of extractRequirementDefinitions(fs.readFileSync(filePath, 'utf8'))) {
      const id = normalizeRequirementId(definition.id);
      if (!id) continue;
      const existing = requirementMap.get(id) || { id };
      addRequirement(id, {
        id,
        type: existing.type || definition.type,
        title: existing.title || definition.title || '',
        description: existing.description || definition.description || '',
        body: existing.body || definition.body || '',
      });
    }
  }

  return requirementMap;
}

function readStoryTrackerStories(planningDir) {
  const tracker = safeReadJson(path.join(planningDir, 'story-tracker.json'));
  return Array.isArray(tracker?.stories) ? tracker.stories : [];
}

function getMilestoneFrIdMap(planningDir, root) {
  const milestoneFrs = new Map(
    Object.entries(getMilestoneFRCounts(planningDir || root)).map(([id, frIds]) => [
      id,
      new Set((frIds || []).map((frId) => normalizeRequirementLookupId(frId)).filter(Boolean)),
    ]),
  );

  for (const story of readStoryTrackerStories(planningDir)) {
    const milestoneId = normalizeMilestoneId(story.milestone || story.milestoneId);
    if (!milestoneId) continue;
    if (!milestoneFrs.has(milestoneId)) milestoneFrs.set(milestoneId, new Set());
    for (const frId of extractStoryFrIds(story)) {
      const normalizedFrId = normalizeRequirementLookupId(frId);
      if (normalizedFrId) milestoneFrs.get(milestoneId).add(normalizedFrId);
    }
  }

  return milestoneFrs;
}

function parseEpicPlan(content) {
  const epics = [];
  const lines = String(content || '').split(/\r?\n/);
  let currentEpic = null;
  let currentStory = null;

  function dedupe(ids) {
    return sortUniqueIds((ids || []).map((id) => normalizeRequirementId(id)).filter(Boolean));
  }

  function finalizeStory() {
    if (!currentEpic || !currentStory) return;
    currentStory.requirementIds = dedupe(currentStory.requirementIds);
    currentStory.frIds = currentStory.requirementIds.filter((id) => requirementPrefix(id) === 'FR');
    currentEpic.stories.push(currentStory);
    currentStory = null;
  }

  function finalizeEpic() {
    if (!currentEpic) return;
    finalizeStory();
    const storyRequirementIds = currentEpic.stories.flatMap((story) => story.requirementIds || []);
    currentEpic.requirementIds = dedupe([...(currentEpic.requirementIds || []), ...storyRequirementIds]);
    currentEpic.frIds = currentEpic.requirementIds.filter((id) => requirementPrefix(id) === 'FR');
    epics.push(currentEpic);
    currentEpic = null;
  }

  for (const line of lines) {
    const epicMatch = line.match(/^#{2,4}\s+(?:Epic\s+)?((?:M\d+\.)?E[A-Z0-9_]+)(?!-S\d)\s*[:\u2014\u2013-]\s*(.+)/i);
    if (epicMatch) {
      finalizeEpic();
      const milestoneRef = line.match(/\b(M\d+)\b/i);
      currentEpic = {
        id: normalizeEpicPlanId(epicMatch[1]) || String(epicMatch[1] || '').toUpperCase(),
        title: String(epicMatch[2] || '')
          .trim()
          .replace(/\s+\(M\d+\)\s*$/i, ''),
        milestone: milestoneRef ? normalizeMilestoneId(milestoneRef[1]) : null,
        requirementIds: extractRequirementReferences(line),
        stories: [],
      };
      continue;
    }

    // v0.40.5: close the current epic at any non-epic H1/H2 heading so trailing
    // appendices (e.g. "## FR Coverage Check") don't leak all document FR refs
    // into the last epic's requirementIds and cascade into false density-gate
    // failures.
    if (currentEpic && /^#{1,2}\s+/.test(line)) {
      finalizeEpic();
      continue;
    }

    if (!currentEpic) continue;

    const storyMatch =
      line.match(
        /^\s*(?:#{3,6}\s+|[-*]\s+)?(?:\*\*)?Story\s+((?:M\d+\.)?S\d+|E[A-Z0-9_]+-S\d+|S-\d+\.\d+|S-\d+-\d+|S\d+\.\d+|\d+-\d+)(?:\*\*)?\s*[:\u2014\u2013-]\s*(.+)/i,
      ) ||
      line.match(
        /^\s*(?:#{3,6}\s+|[-*]\s+)(?:\*\*)?(E[A-Z0-9_]+-S\d+|(?:M\d+\.)?S\d+|S-\d+\.\d+|S-\d+-\d+|S\d+\.\d+|\d+-\d+)(?:\*\*)?\s*[:\u2014\u2013-]\s*(.+)/i,
      );
    if (storyMatch) {
      finalizeStory();
      currentStory = {
        id: normalizeStoryId(storyMatch[1]) || String(storyMatch[1] || '').toUpperCase(),
        title: String(storyMatch[2] || '')
          .trim()
          .replace(/^\*+|\*+$/g, '')
          .trim(),
        requirementIds: extractRequirementReferences(line),
        acceptanceCriteriaCount: 0,
      };
      continue;
    }

    const refs = extractRequirementReferences(line);
    if (currentStory) {
      currentStory.requirementIds.push(...refs);
      if (/^\s*(Given|When|Then|And|But)\b/i.test(line)) {
        currentStory.acceptanceCriteriaCount += 1;
      }
    } else {
      currentEpic.requirementIds.push(...refs);
    }
  }

  finalizeEpic();
  return epics;
}

function normalizeEpicPlanId(epicId) {
  const normalized = String(epicId || '')
    .trim()
    .toUpperCase();
  if (!normalized) return null;
  const match = normalized.match(/^(?:M(\d+)\.)?E([A-Z0-9_]+)$/);
  if (!match) return null;
  const epicToken = /^\d+$/.test(match[2]) ? String(parseInt(match[2], 10)) : match[2];
  return match[1] ? `M${parseInt(match[1], 10)}.E${epicToken}` : `E${epicToken}`;
}

function countAcceptanceCriteria(content) {
  return String(content || '')
    .split(/\r?\n/)
    .filter((line) => /^\s*(Given|When|Then|And|But)\b/i.test(line)).length;
}

function nextVersionedMilestonesPath(planningDir) {
  const existing = fs
    .readdirSync(planningDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .map((name) => {
      const match = name.match(/^milestones-v(\d+)\.md$/i);
      return match ? parseInt(match[1], 10) : 1;
    })
    .filter((value) => Number.isInteger(value));

  const nextVersion = (existing.length > 0 ? Math.max(...existing) : 1) + 1;
  return {
    version: nextVersion,
    path: path.join(planningDir, `milestones-v${nextVersion}.md`),
  };
}

function cloneCountMap(source) {
  return new Map(source ? [...source.entries()] : []);
}

class PreflightChecker {
  constructor(projectRoot) {
    this.root = projectRoot || process.cwd();
    this.deps = loadDependencies(this.root);
    this._paths = CoboltPaths ? new CoboltPaths(this.root) : null;
    this._schemaValidator = new SchemaValidator(path.resolve(__dirname, '../source/schemas'));
  }

  _historicalPlanningDirs() {
    const results = [];
    const runsRoot = path.join(this.root, '_cobolt-output', 'runs');
    if (!fs.existsSync(runsRoot)) return results;

    try {
      const days = fs.readdirSync(runsRoot).sort().reverse();
      for (const day of days) {
        const dayDir = path.join(runsRoot, day);
        if (!fs.existsSync(dayDir) || !fs.statSync(dayDir).isDirectory()) continue;

        const runs = fs.readdirSync(dayDir).sort().reverse();
        for (const run of runs) {
          const planningDir = path.join(dayDir, run, 'planning');
          if (fs.existsSync(planningDir) && fs.statSync(planningDir).isDirectory()) {
            results.push(path.resolve(planningDir));
          }
        }
      }
    } catch {
      return results;
    }

    return results;
  }

  _planningDirCandidates() {
    const candidates = [];
    const strictDir = getPlanningDir(this.root, { create: false, strict: true, fallbackToLatest: false });
    const recoveredDir = getPlanningDir(this.root, { create: false, strict: false, fallbackToLatest: false });

    if (strictDir) candidates.push(strictDir);
    if (recoveredDir) candidates.push(recoveredDir);
    candidates.push(...this._historicalPlanningDirs());

    return [...new Set(candidates.filter(Boolean).map((candidate) => path.resolve(candidate)))];
  }

  _resolvePlanningArtifactPaths(artifactPath) {
    const normalized = String(artifactPath || '').replaceAll('\\', '/');
    const planningPrefix = '_cobolt-output/latest/planning/';
    if (!normalized.startsWith(planningPrefix)) return [];

    const suffix = normalized.slice(planningPrefix.length);
    return this._planningDirCandidates().map((planningDir) => path.join(planningDir, suffix.replaceAll('/', path.sep)));
  }

  _resolveArtifactPaths(artifactPath) {
    const candidates = [];
    candidates.push(...this._resolvePlanningArtifactPaths(artifactPath));

    if (artifactPath) {
      const absolute = path.isAbsolute(artifactPath) ? artifactPath : path.join(this.root, artifactPath);
      candidates.push(absolute);
    }

    return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
  }

  _resolvePatternCandidates(patterns) {
    const remapped = [];
    const planningDir = this._findPlanningDir();
    const planningPrefix = '_cobolt-output/latest/planning/';
    const relativePlanningDir = planningDir ? path.relative(this.root, planningDir).replaceAll('\\', '/') : null;

    for (const pattern of patterns) {
      remapped.push(pattern);
      if (relativePlanningDir && pattern.startsWith(planningPrefix)) {
        remapped.push(`${relativePlanningDir}/${pattern.slice(planningPrefix.length)}`);
      }
    }

    return [...new Set(remapped)];
  }

  _resolveSkill(skill) {
    if (!this.deps) return { skill, skillDef: null };

    let resolvedSkill = skill;
    if (skill === 'cobolt-build') {
      try {
        const stateFile = path.join(this.root, 'cobolt-state.json');
        if (fs.existsSync(stateFile)) {
          const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          const mode = state?.planning?.mode;
          if (mode === 'feature' && this.deps.skills['cobolt-build-feature']) {
            resolvedSkill = 'cobolt-build-feature';
          }
        }
      } catch {
        /* best effort */
      }
    }

    const skillDef = this.deps.skills?.[resolvedSkill] || this.deps.producers?.[resolvedSkill] || null;
    return { skill: resolvedSkill, skillDef };
  }

  _decorateArtifactResult(result) {
    if (!result?.path) return result;
    const absolutePath = path.isAbsolute(result.path) ? result.path : path.join(this.root, result.path);
    return {
      ...result,
      absolutePath,
    };
  }

  _checkBrownfieldBuildReadiness(skill, resolvedSkill) {
    const isBuildSkill = skill === 'cobolt-build' || String(resolvedSkill || '').startsWith('cobolt-build');
    if (!isBuildSkill) return null;

    const bfDir = path.join(this.root, '_cobolt-output', 'latest', 'brownfield');
    if (!fs.existsSync(bfDir)) return null;

    const signalFiles = [
      'brownfield-assessment-verdict.json',
      'brownfield-modernization-readiness.json',
      'brownfield-to-build-handoff-contract.json',
    ];
    if (!signalFiles.some((file) => fs.existsSync(path.join(bfDir, file)))) return null;

    let validation;
    try {
      validation = validateBrownfieldContracts(bfDir, { scope: 'planning', write: true });
    } catch (err) {
      validation = { ok: false, blockers: [{ detail: String(err?.message || err) }] };
    }

    const validationPath = path.join(bfDir, 'brownfield-contract-validation.json');
    let size = 0;
    try {
      size = fs.statSync(validationPath).size;
    } catch {
      size = 0;
    }

    return {
      id: 'brownfield-modernization-readiness',
      exists: validation.ok === true,
      path: path.relative(this.root, validationPath).replaceAll('\\', '/'),
      size,
      minBytes: 100,
      description: validation.ok
        ? 'Brownfield modernization readiness contract authorizes build handoff'
        : `Brownfield modernization readiness blocks build: ${(validation.blockers || [])
            .slice(0, 3)
            .map((blocker) => blocker.detail)
            .join('; ')}`,
      producedBy: 'cobolt-brownfield-contracts',
      required: true,
    };
  }

  /**
   * Check if a skill's required artifacts exist on disk.
   * @param {string} skill - Skill name (e.g., 'cobolt-build')
   * @returns {{ passed: boolean, skill: string, missing: Array, present: Array, message: string }}
   */
  check(skill) {
    if (!this.deps) {
      return {
        passed: false,
        skill,
        missing: [],
        present: [],
        message: 'PREFLIGHT ERROR: artifact-dependencies.json not found. Run /cobolt-plan first.',
      };
    }

    const { skill: resolvedSkill, skillDef } = this._resolveSkill(skill);
    if (!skillDef) {
      // Unknown skills fail closed because dependency gates cannot verify them.
      return {
        passed: false,
        skill,
        missing: [
          {
            id: 'unknown-skill',
            description: `Unknown skill '${skill}' is not registered in artifact-dependencies.json`,
            required: true,
          },
        ],
        present: [],
        message: `Unknown skill '${skill}' is not registered in artifact-dependencies.json; dependency gates cannot verify it.`,
      };
    }

    const missing = [];
    const present = [];
    const requiresCompleteStoryCoverage = skillDef.requireCompleteStoryCoverage === true;

    // Check required artifacts
    for (const artifactId of skillDef.requires || []) {
      const result =
        requiresCompleteStoryCoverage && artifactId === 'story-file'
          ? this._checkStoryCoverageArtifact()
          : this._checkRequiredArtifact(artifactId);
      if (result.exists) {
        present.push(this._decorateArtifactResult(result));
      } else {
        missing.push(this._decorateArtifactResult(result));
      }
    }

    // Check requiresAny (at least one must exist, e.g., story files)
    if (skillDef.requiresAny && skillDef.requiresAny.length > 0) {
      const anyResults = skillDef.requiresAny.map((id) => this._checkArtifact(id));
      const anyExists = anyResults.some((r) => r.exists);
      if (anyExists) {
        present.push(...anyResults.filter((r) => r.exists).map((result) => this._decorateArtifactResult(result)));
      } else {
        // All missing in requiresAny — report them
        missing.push(...anyResults.map((result) => this._decorateArtifactResult(result)));
      }
    }

    const brownfieldReadiness = this._checkBrownfieldBuildReadiness(skill, resolvedSkill);
    if (brownfieldReadiness) {
      if (brownfieldReadiness.exists) present.push(this._decorateArtifactResult(brownfieldReadiness));
      else missing.push(this._decorateArtifactResult(brownfieldReadiness));
    }

    const passed = missing.length === 0;
    const message = passed
      ? `PREFLIGHT PASSED: All ${present.length} required artifacts exist for '${skill}'${resolvedSkill !== skill ? ` (resolved to '${resolvedSkill}')` : ''}.`
      : this._buildBlockMessage(skill, skillDef, missing, present);

    return { passed, skill: resolvedSkill, originalSkill: skill, missing, present, message };
  }

  /**
   * Check a single artifact's existence and size.
   * @param {string} artifactId - Key in deps.artifacts
   * @returns {{ id: string, exists: boolean, path: string, size: number, minBytes: number, description: string, producedBy: string }}
   */
  _checkArtifact(artifactId) {
    const artifact = this.deps.artifacts[artifactId];
    if (!artifact) {
      return {
        id: artifactId,
        exists: false,
        path: '?',
        size: 0,
        minBytes: 0,
        description: 'Unknown artifact',
        producedBy: '?',
      };
    }

    // Handle pattern-based artifacts (story files)
    if (artifact.pathPattern) {
      return this._checkPatternArtifact(artifactId, artifact);
    }

    let exists = false;
    let size = 0;
    let resolvedPath = artifact.path;

    for (const candidate of this._resolveArtifactPaths(artifact.path)) {
      try {
        const stat = fs.statSync(candidate);
        resolvedPath = path.relative(this.root, candidate).replaceAll('\\', '/');
        size = stat.size;
        exists = size >= (artifact.minBytes || 0);
        if (exists) break;
      } catch {
        /* try next candidate */
      }
    }

    return {
      id: artifactId,
      exists,
      path: resolvedPath,
      size,
      minBytes: artifact.minBytes || 0,
      description: artifact.description,
      producedBy: artifact.producedBy,
      optional: artifact.optional || false,
    };
  }

  _scanDeclaredInfrastructure() {
    if (this._declaredInfrastructureScan !== undefined) return this._declaredInfrastructureScan;
    try {
      const { noDeclaredInfrastructure } = require('./cobolt-infra-check');
      this._declaredInfrastructureScan = noDeclaredInfrastructure(this.root);
    } catch (err) {
      this._declaredInfrastructureScan = {
        ok: false,
        source: null,
        dependencies: [],
        error: err.message,
      };
    }
    return this._declaredInfrastructureScan;
  }

  _checkInfraManifestArtifact(result) {
    if (result.exists) return result;
    const scan = this._scanDeclaredInfrastructure();
    if (!scan.ok) return result;
    return {
      ...result,
      exists: true,
      skipped: true,
      optional: true,
      issues: [],
      reason: 'No infrastructure dependencies are declared by architecture.md; infra-manifest is not required.',
      architectureSource: scan.source,
    };
  }

  _checkRequiredArtifact(artifactId) {
    const result = this._checkArtifact(artifactId);
    if (artifactId === 'infra-manifest') {
      return this._checkInfraManifestArtifact(result);
    }
    if (artifactId === 'feature-readiness-report') {
      return this._checkFeatureReadinessArtifact(result);
    }
    if (artifactId === 'fix-readiness-report') {
      return this._checkFixReadinessArtifact(result);
    }
    if (artifactId !== 'source-document-consolidation') {
      return result;
    }

    const artifact = this.deps?.artifacts?.[artifactId] || {};
    const sourcePacket = getSourcePacketIntegrityStatus(this.root, this._findPlanningDir(), {
      minBytes: artifact.minBytes || 0,
    });

    if (!sourcePacket.required) {
      return {
        ...result,
        exists: true,
        skipped: true,
        issues: [],
      };
    }

    if (!sourcePacket.packetPath) {
      return {
        ...result,
        issues: sourcePacket.issues,
      };
    }

    return {
      ...result,
      path: path.isAbsolute(sourcePacket.packetPath)
        ? path.relative(this.root, sourcePacket.packetPath).replaceAll('\\', '/')
        : sourcePacket.packetPath,
      issues: sourcePacket.issues,
    };
  }

  _checkFeatureReadinessArtifact(result) {
    if (!result.exists || !result.path) return result;

    const absolutePath = path.isAbsolute(result.path) ? result.path : path.join(this.root, result.path);
    let report = null;
    try {
      report = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    } catch {
      return {
        ...result,
        exists: false,
        issues: ['feature-readiness-report.json is not valid JSON'],
      };
    }

    const nonReady = Array.isArray(report.features)
      ? report.features.filter((feature) => String(feature.status || '').toUpperCase() !== 'READY')
      : [];
    if (report.passed !== true || nonReady.length > 0) {
      const totalFeatures = Array.isArray(report.features) ? report.features.length : 0;
      return {
        ...result,
        exists: false,
        contentGateFailed: true,
        issues: [
          `feature-readiness-report.json FILE EXISTS at ${result.path} but CONTENT failed the per-feature readiness gate (${nonReady.length}/${totalFeatures} features not READY, passed=${report.passed}). This is NOT a path/naming issue — the dossier content is incomplete. Remediation: re-run /cobolt-analyze-features for the non-READY features and /cobolt-feature-coverage to regenerate the report.`,
          ...nonReady
            .slice(0, 10)
            .map(
              (feature) =>
                `  • ${feature.featureId || '(unknown)'}: status=${feature.status || 'unknown'}${feature.missing ? ` missing=${JSON.stringify(feature.missing)}` : ''}`,
            ),
        ],
      };
    }

    return result;
  }

  _checkFixReadinessArtifact(result) {
    if (!result.exists || !result.path) return result;

    const absolutePath = path.isAbsolute(result.path) ? result.path : path.join(this.root, result.path);
    let report = null;
    try {
      report = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    } catch {
      return {
        ...result,
        exists: false,
        issues: ['fix-readiness-report.json is not valid JSON'],
      };
    }

    const nonReady = Array.isArray(report.cases)
      ? report.cases.filter((fixCase) => String(fixCase.status || '').toUpperCase() !== 'READY')
      : [];
    if (report.passed !== true || nonReady.length > 0) {
      return {
        ...result,
        exists: false,
        issues: [
          'fix-readiness-report.json did not pass the per-finding remediation readiness gate',
          ...nonReady.slice(0, 5).map((fixCase) => `${fixCase.caseId || '(unknown)'}: ${fixCase.status || 'unknown'}`),
        ],
      };
    }

    return result;
  }

  _checkStoryCoverageArtifact() {
    const artifact = this.deps.artifacts['story-file'];
    if (!artifact) {
      return {
        id: 'story-file',
        exists: false,
        path: '_cobolt-output/latest/planning/stories/*.md',
        size: 0,
        minBytes: 0,
        description: 'Story files',
        producedBy: 'cobolt-create-story',
      };
    }

    const coverage = getStoryCoverage(this.root, { planningDir: this._findPlanningDir() });
    const trackerResult = this._checkArtifact('story-tracker');
    const trackerPlanningDir =
      trackerResult.exists && trackerResult.path
        ? path.dirname(path.join(this.root, trackerResult.path))
        : this._findPlanningDir();
    const recoveredCoverage = getStoryCoverage(this.root, { planningDir: trackerPlanningDir });
    const activeCoverage = recoveredCoverage.expectedStoryIds.length > 0 ? recoveredCoverage : coverage;
    const exists =
      trackerResult.exists && activeCoverage.expectedStoryIds.length > 0 && activeCoverage.missingStoryIds.length === 0;

    return {
      id: 'story-file',
      exists,
      path: artifact.pathPattern,
      size: activeCoverage.actualFiles.length,
      minBytes: activeCoverage.expectedStoryIds.length || 1,
      description:
        activeCoverage.expectedStoryIds.length > 0
          ? `Story coverage ${activeCoverage.actualFiles.length}/${activeCoverage.expectedStoryIds.length} files present (${activeCoverage.coverage}%)`
          : `Story coverage ${activeCoverage.actualFiles.length} file(s) present with no tracker baseline`,
      producedBy: artifact.producedBy,
      optional: false,
      actualStories: activeCoverage.actualFiles.length,
      expectedStories: activeCoverage.expectedStoryIds.length,
      missingStoryIds: activeCoverage.missingStoryIds,
    };
  }

  /**
   * Check pattern-based artifacts (story files, reports using glob patterns).
   */
  _checkPatternArtifact(artifactId, artifact) {
    const patternCandidates = this._resolvePatternCandidates(
      [artifact.pathPattern, artifact.pathAlternate].filter(Boolean),
    );
    const found = this._searchPatternArtifact(patternCandidates, artifact);
    const foundPath = found?.path || '';
    const foundSize = found?.size || 0;

    return {
      id: artifactId,
      exists: !!found,
      path: found && foundPath ? foundPath : artifact.pathPattern,
      size: foundSize,
      minBytes: artifact.minBytes || 0,
      description: artifact.description,
      producedBy: artifact.producedBy,
      optional: artifact.optional || false,
    };
  }

  _collectPatternArtifacts(patterns, artifact) {
    const normalizedPatterns = patterns.map((p) => p.replaceAll('\\', '/'));
    const matchers = normalizedPatterns.map((p) => this._globToRegex(p));
    const excludes = new Set(artifact.pathExcludes || []);
    const filenamePattern = artifact.filenamePattern ? new RegExp(artifact.filenamePattern) : null;
    const minBytes = artifact.minBytes || 0;
    const searchRoot = normalizedPatterns.some((p) => p.startsWith('_cobolt-output/'))
      ? path.join(this.root, '_cobolt-output')
      : this.root;

    return this._walkAllForPattern(searchRoot, (relativePath, entryName, size) => {
      const normalizedPath = relativePath.replaceAll('\\', '/');
      if (!matchers.some((regex) => regex.test(normalizedPath))) return false;
      if (excludes.has(entryName)) return false;
      if (filenamePattern && !filenamePattern.test(entryName)) return false;
      return size >= minBytes;
    });
  }

  _searchPatternArtifact(patterns, artifact) {
    return this._collectPatternArtifacts(patterns, artifact)[0] || null;
  }

  _resolveEntryKind(entry, fullPath) {
    // Windows junctions and symlinks report isDirectory()=false on Dirent —
    // follow via statSync to classify the link target. Without this, preflight
    // globs miss files under `_cobolt-output/latest/...` when latest is a junction.
    if (entry.isDirectory()) return 'dir';
    if (entry.isFile()) return 'file';
    if (entry.isSymbolicLink()) {
      try {
        const target = fs.statSync(fullPath);
        if (target.isDirectory()) return 'dir';
        if (target.isFile()) return 'file';
      } catch {
        return 'skip';
      }
    }
    return 'skip';
  }

  _walkForPattern(rootDir, predicate, depth = 0, visited = new Set()) {
    if (depth > 10 || !fs.existsSync(rootDir)) return null;
    let realRoot;
    try {
      realRoot = fs.realpathSync(rootDir);
    } catch {
      realRoot = rootDir;
    }
    if (visited.has(realRoot)) return null;
    visited.add(realRoot);

    try {
      const entries = fs.readdirSync(rootDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const fullPath = path.join(rootDir, entry.name);
        const kind = this._resolveEntryKind(entry, fullPath);
        if (kind === 'dir') {
          if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
          const nested = this._walkForPattern(fullPath, predicate, depth + 1, visited);
          if (nested) return nested;
          continue;
        }
        if (kind !== 'file') continue;
        const relativePath = path.relative(this.root, fullPath);
        const stat = fs.statSync(fullPath);
        if (predicate(relativePath, entry.name, stat.size)) {
          return { path: relativePath.replaceAll('\\', '/'), size: stat.size };
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  _walkAllForPattern(rootDir, predicate, depth = 0, results = [], visited = new Set()) {
    if (depth > 10 || !fs.existsSync(rootDir)) return results;
    let realRoot;
    try {
      realRoot = fs.realpathSync(rootDir);
    } catch {
      realRoot = rootDir;
    }
    if (visited.has(realRoot)) return results;
    visited.add(realRoot);

    try {
      const entries = fs.readdirSync(rootDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const fullPath = path.join(rootDir, entry.name);
        const kind = this._resolveEntryKind(entry, fullPath);
        if (kind === 'dir') {
          if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
          this._walkAllForPattern(fullPath, predicate, depth + 1, results, visited);
          continue;
        }
        if (kind !== 'file') continue;
        const relativePath = path.relative(this.root, fullPath);
        const stat = fs.statSync(fullPath);
        if (predicate(relativePath, entry.name, stat.size)) {
          results.push({ path: relativePath.replaceAll('\\', '/'), size: stat.size });
        }
      }
    } catch {
      return results;
    }

    return results;
  }

  _globToRegex(pattern) {
    const normalized = pattern.replaceAll('\\', '/');
    let regex = '';

    for (let i = 0; i < normalized.length; i++) {
      const char = normalized[i];
      const next = normalized[i + 1];

      if (char === '*' && next === '*') {
        regex += '.*';
        i++;
        continue;
      }
      if (char === '*') {
        regex += '[^/]*';
        continue;
      }
      if (char === '?') {
        regex += '.';
        continue;
      }

      regex += /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char;
    }

    return new RegExp(`^${regex}$`);
  }

  /**
   * Build a human-readable block message with remediation steps.
   */
  _buildBlockMessage(skill, skillDef, missing, present) {
    const lines = [
      `PLANNING GATE BLOCKED: Cannot run '${skill}' — missing required planning artifacts.`,
      '',
      `${skillDef.description}`,
      '',
      'MISSING ARTIFACTS:',
    ];

    for (const m of missing) {
      if (m.optional) {
        lines.push(`  [optional] ${m.id}: ${m.description}`);
        lines.push(`             Expected: ${m.path}`);
        lines.push(`             Produced by: /cobolt-${m.producedBy}`);
      } else {
        lines.push(`  [REQUIRED] ${m.id}: ${m.description}`);
        lines.push(`             Expected: ${m.path} (min ${m.minBytes} bytes)`);
        lines.push(`             Produced by: /cobolt-${m.producedBy}`);
        if (Array.isArray(m.issues) && m.issues.length > 0) {
          lines.push(`             Details: ${m.issues.join(' | ')}`);
        }
      }
    }

    if (present.length > 0) {
      lines.push('');
      lines.push(`PRESENT (${present.length}): ${present.map((p) => p.id).join(', ')}`);
    }

    lines.push('');
    lines.push('REMEDIATION:');
    lines.push('  Run the planning pipeline first:');
    lines.push('    /cobolt-plan project                         # Interactive');
    lines.push('    /cobolt-plan project --from-files docs/PRD.md # From existing PRD');
    lines.push('    /cobolt-plan project --autonomous            # Fully autonomous');
    lines.push('');
    lines.push('  Or run individual planning skills:');

    const producers = [...new Set(missing.map((m) => m.producedBy))];
    for (const p of producers) {
      lines.push(`    /cobolt-${p}`);
    }

    return lines.join('\n');
  }

  /**
   * Get status of all artifacts.
   * @returns {Array<{ id: string, exists: boolean, path: string, size: number, minBytes: number, description: string, producedBy: string }>}
   */
  status() {
    if (!this.deps) return [];
    return Object.keys(this.deps.artifacts)
      .filter((id) => !id.startsWith('_')) // Skip _comment fields
      .map((id) => this._checkArtifact(id));
  }

  /**
   * Validate story file completeness across all milestones.
   * Counts expected stories from story-tracker.json and actual story files on disk.
   * @returns {{ passed: boolean, expected: number, actual: number, missing: string[], message: string }}
   */
  validateStories() {
    const planningDir = this._findPlanningDir();
    if (!planningDir) {
      return {
        passed: false,
        expected: 0,
        actual: 0,
        missing: [],
        message: 'STORY VALIDATION FAILED: No planning directory found.',
      };
    }

    const coverage = getStoryCoverage(planningDir, { planningDir });
    const passed =
      coverage.expectedStoryIds.length > 0 ? coverage.missingStoryIds.length === 0 : coverage.actualFiles.length > 0;
    const epicsPath = path.join(planningDir, 'epics.md');
    const epicsContent = fs.existsSync(epicsPath) ? fs.readFileSync(epicsPath, 'utf8') : '';
    const storyTrackerPath = path.join(planningDir, 'story-tracker.json');
    const trackerContent = fs.existsSync(storyTrackerPath) ? fs.readFileSync(storyTrackerPath, 'utf8') : '';
    const storyDir = path.join(planningDir, 'stories');
    const storyContent = fs.existsSync(storyDir)
      ? fs
          .readdirSync(storyDir)
          .filter((entry) => entry.endsWith('.md'))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .map((entry) => fs.readFileSync(path.join(storyDir, entry), 'utf8'))
          .join('\n')
      : '';
    const sourceCoverage = evaluateCoverageAgainstText([epicsContent, trackerContent, storyContent].join('\n'), {
      threshold: 100,
      projectRoot: this.root,
      planningDir,
      targetFile: epicsPath || path.join(planningDir, 'stories'),
      writeReport: false,
    });

    let message;
    if (!sourceCoverage.result?.skipped && !sourceCoverage.result?.passed) {
      message =
        `STORY VALIDATION FAILED: source requirements are not fully represented in epics/stories (${sourceCoverage.result?.coverage || 0}% coverage). ` +
        `Missing: ${(sourceCoverage.result?.unmatched || [])
          .slice(0, 5)
          .map((entry) => entry.id)
          .join(', ')}${(sourceCoverage.result?.unmatched || []).length > 5 ? '...' : ''}`;
    } else if (passed) {
      message = `STORY VALIDATION PASSED: ${coverage.actualFiles.length} story files covering ${coverage.expectedStoryIds.length || 'all tracked'} stories (${coverage.coverage}%).`;
    } else if (coverage.expectedStoryIds.length === 0 && coverage.actualFiles.length === 0) {
      message =
        'STORY VALIDATION FAILED: No story files found and no story tracker available. Run cobolt-create-story for all stories.';
    } else {
      message = `STORY VALIDATION FAILED: ${coverage.missingStoryIds.length} of ${coverage.expectedStoryIds.length} stories missing (${coverage.coverage}% coverage). Missing: ${coverage.missingStoryIds.slice(0, 10).join(', ')}${coverage.missingStoryIds.length > 10 ? '...' : ''}`;
    }

    // v0.40.5: surface the real failure reason and expose unmatched source IDs
    // via a flat `missingSourceIds` field. Prior callers saw `passed:false` with
    // `missing:[]` and could not tell that the failure was source-coverage,
    // not story-file-missing. API consumers can now branch on `failureReason`.
    const storyFilesComplete = passed;
    const sourceCoveragePass = Boolean(sourceCoverage.result?.skipped || sourceCoverage.result?.passed);
    const overall = storyFilesComplete && sourceCoveragePass;
    let failureReason = null;
    if (!overall) {
      if (!storyFilesComplete && !sourceCoveragePass) failureReason = 'story-files-and-source-coverage';
      else if (!storyFilesComplete) failureReason = 'story-files-missing';
      else failureReason = 'source-coverage-below-threshold';
    }
    return {
      passed: overall,
      failureReason,
      expected: coverage.expectedStoryIds.length,
      actual: coverage.actualFiles.length,
      coverage: coverage.coverage,
      missing: coverage.missingStoryIds,
      missingSourceIds: (sourceCoverage.result?.unmatched || []).map((entry) => entry.id),
      sourceCoverage: sourceCoverage.result || null,
      message,
    };
  }

  /**
   * Validate whether milestone decomposition leaves too many tasks blocked by later milestones.
   * This catches likely build-time deferrals early enough for planning to regroup the work.
   * @returns {{
   *   passed: boolean,
   *   skipped: boolean,
   *   thresholds: object,
   *   milestones: Array<object>,
   *   failing: string[],
   *   warnings: string[],
   *   recommendations: string[],
   *   message: string
   * }}
   */
  validateBlockedTasks() {
    const planningDir = this._findPlanningDir();
    const thresholds = {
      warningCount: 2,
      failCount: 4,
      warningRatio: 0.15,
      failRatio: 0.3,
      warningStoryCount: 8,
      failStoryCount: 12,
      warningFrCount: 12,
      failFrCount: 15,
    };

    if (!planningDir) {
      return {
        passed: false,
        skipped: false,
        thresholds,
        milestones: [],
        failing: [],
        warnings: [],
        suggestedMoves: [],
        recommendations: [],
        message: 'BLOCKED TASK VALIDATION FAILED: No planning directory found.',
      };
    }

    const advisorPath = path.join(planningDir, 'milestone-regroup-plan.json');
    const advisorPathRelative = path.relative(this.root, advisorPath).replaceAll('\\', '/');
    const trackerPath = path.join(planningDir, 'story-tracker.json');
    const registryPath = path.join(planningDir, 'cross-milestone-blocked-tasks.json');
    const previousAdvisor = safeReadJson(advisorPath);
    const getAdvisorInputs = () => ({
      storyTracker: describeArtifactFile(this.root, trackerPath),
      blockedTaskRegistry: describeArtifactFile(this.root, registryPath),
    });
    const emitAdvisor = (result) => {
      const advisorStatus = result.skipped
        ? 'skipped'
        : result.passed
          ? (result.warnings?.length || 0) > 0
            ? 'warning'
            : 'pass'
          : 'fail';
      const inputs = getAdvisorInputs();
      const operations = sortRegroupOperations(
        (result.suggestedMoves || []).map((move) => ({
          op: 'move-story',
          storyId: move.storyId,
          storyLabel: move.storyLabel,
          fromMilestone: move.fromMilestone,
          toMilestone: move.toMilestone,
          blockedTasks: move.blockedTasks,
          totalStoryTasks: move.totalStoryTasks,
          blockedRatio: move.blockedRatio,
          blockerMilestones: move.blockerMilestones,
          blockerCounts: move.blockerCounts,
          reason: move.reason,
        })),
      );
      const payload = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        source: 'cobolt-preflight validate-blocked-tasks',
        status: advisorStatus,
        thresholds,
        inputs,
        summary: {
          failing: result.failing || [],
          warnings: result.warnings || [],
          totalMilestones: result.milestones?.length || 0,
          totalSuggestedMoves: result.suggestedMoves?.length || 0,
          totalFutureBlockedTasks: result.totalFutureBlockedTasks || 0,
          totalConflicts: result.conflicts?.length || 0,
        },
        patch: {
          operationCount: operations.length,
          operations,
        },
        integrity: {
          inputsHash: sha256(
            JSON.stringify({
              storyTracker: inputs.storyTracker?.sha256 || null,
              blockedTaskRegistry: inputs.blockedTaskRegistry?.sha256 || null,
            }),
          ),
          operationsHash: sha256(JSON.stringify(operations)),
        },
        milestones: result.milestones || [],
        simulatedMilestones: result.simulatedMilestones || [],
        suggestedMoves: result.suggestedMoves || [],
        conflicts: result.conflicts || [],
        ratchet: result.ratchet || null,
        recommendations: result.recommendations || [],
        message: result.message,
      };

      try {
        atomicWrite(advisorPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        return {
          ...result,
          artifactPath: advisorPathRelative,
        };
      } catch (error) {
        return {
          ...result,
          artifactPath: advisorPathRelative,
          artifactError: error.message,
        };
      }
    };

    if (!fs.existsSync(registryPath)) {
      return emitAdvisor({
        passed: true,
        skipped: true,
        thresholds,
        milestones: [],
        failing: [],
        warnings: [],
        suggestedMoves: [],
        recommendations: [],
        message:
          'BLOCKED TASK VALIDATION SKIPPED: cross-milestone-blocked-tasks.json not found. ' +
          'Run blocked-task extraction after story sync to evaluate milestone regrouping.',
      });
    }

    if (!fs.existsSync(trackerPath)) {
      return emitAdvisor({
        passed: false,
        skipped: false,
        thresholds,
        milestones: [],
        failing: [],
        warnings: [],
        suggestedMoves: [],
        recommendations: [],
        message:
          'BLOCKED TASK VALIDATION FAILED: story-tracker.json not found. ' +
          'Task-level dependency analysis requires the canonical tracker.',
      });
    }

    const tracker = safeReadJson(trackerPath);
    if (!Array.isArray(tracker?.stories)) {
      return emitAdvisor({
        passed: false,
        skipped: false,
        thresholds,
        milestones: [],
        failing: [],
        warnings: [],
        suggestedMoves: [],
        recommendations: [],
        message: 'BLOCKED TASK VALIDATION FAILED: story-tracker.json is unreadable or missing the stories array.',
      });
    }

    const registry = safeReadJson(registryPath);
    if (!Array.isArray(registry?.blockedTasks)) {
      return emitAdvisor({
        passed: false,
        skipped: false,
        thresholds,
        milestones: [],
        failing: [],
        warnings: [],
        suggestedMoves: [],
        recommendations: [],
        message:
          'BLOCKED TASK VALIDATION FAILED: cross-milestone-blocked-tasks.json is unreadable or missing blockedTasks.',
      });
    }

    const invalidRegistryEntries = registry.blockedTasks
      .map((entry, index) => {
        if (String(entry?.status || 'deferred').toLowerCase() === 'completed') return null;
        const taskRef = parseBlockedTaskRef(entry?.taskId);
        const blockerRef = parseBlockedTaskRef(entry?.blockedBy);
        if (taskRef && blockerRef) return null;
        return {
          index,
          taskId: entry?.taskId || null,
          blockedBy: entry?.blockedBy || null,
          reason: !taskRef
            ? 'taskId must match M{n}:E{x}-S{n}:T{n} or M{n}:E{x}-S{n}:ALL'
            : 'blockedBy must match M{n}:E{x}-S{n}:T{n} or M{n}:E{x}-S{n}:ALL',
        };
      })
      .filter(Boolean);

    if (invalidRegistryEntries.length > 0) {
      return emitAdvisor({
        passed: false,
        skipped: false,
        thresholds,
        milestones: [],
        failing: [],
        warnings: [],
        suggestedMoves: [],
        recommendations: [
          'Regenerate cross-milestone-blocked-tasks.json with cobolt-blocked-tasks extract after fixing task ID normalization.',
        ],
        conflicts: invalidRegistryEntries,
        totalFutureBlockedTasks: 0,
        message:
          `BLOCKED TASK VALIDATION FAILED: ${invalidRegistryEntries.length} malformed blocked-task ` +
          'reference(s) found in cross-milestone-blocked-tasks.json.',
      });
    }

    const storyIndex = new Map();
    const milestoneStats = new Map();

    const ensureMilestone = (milestoneId) => {
      const normalized = normalizeMilestoneId(milestoneId);
      if (!normalized) return null;
      if (!milestoneStats.has(normalized)) {
        milestoneStats.set(normalized, {
          id: normalized,
          totalTasks: 0,
          totalStories: 0,
          storyIds: new Set(),
          frIdCounts: new Map(),
          blockedStories: new Set(),
          blockerMilestones: new Set(),
          blockedTaskRefs: [],
          futureBlockedByStory: new Map(),
        });
      }
      return milestoneStats.get(normalized);
    };

    for (const story of tracker.stories) {
      const storyId = normalizeStoryId(story.id || story.storyId);
      const milestoneId = normalizeMilestoneId(story.milestone || story.milestoneId);
      const taskCount =
        Number.isInteger(story.taskCount) && story.taskCount >= 0
          ? story.taskCount
          : Array.isArray(story.tasks)
            ? story.tasks.length
            : 0;
      const frIds = extractStoryFrIds(story);

      if (storyId) {
        storyIndex.set(storyId, {
          storyId,
          milestoneId,
          taskCount,
          frIds,
          title: String(story.title || '').trim(),
        });
      }

      const stats = ensureMilestone(milestoneId);
      if (!stats) continue;
      stats.totalStories += 1;
      stats.totalTasks += taskCount;
      if (storyId) stats.storyIds.add(storyId);
      for (const frId of frIds) {
        stats.frIdCounts.set(frId, (stats.frIdCounts.get(frId) || 0) + 1);
      }
    }

    for (const entry of registry.blockedTasks) {
      if (String(entry?.status || 'deferred').toLowerCase() === 'completed') continue;

      const taskRef = parseBlockedTaskRef(entry.taskId);
      const blockerRef = parseBlockedTaskRef(entry.blockedBy);
      const milestoneId = normalizeMilestoneId(entry.taskMilestone || taskRef?.milestone);
      const blockerMilestoneId = normalizeMilestoneId(entry.blockerMilestone || blockerRef?.milestone);
      const milestoneNo = milestoneNumber(milestoneId);
      const blockerNo = milestoneNumber(blockerMilestoneId);
      if (!milestoneId || !blockerMilestoneId || milestoneNo === null || blockerNo === null) continue;
      if (blockerNo <= milestoneNo) continue;

      const stats = ensureMilestone(milestoneId);
      if (!stats) continue;

      const storyId = normalizeStoryId(taskRef?.storyId || entry.storyId);
      const storyKey = storyId || String(entry.taskId || `unknown-${stats.id}`);
      if (!stats.futureBlockedByStory.has(storyKey)) {
        stats.futureBlockedByStory.set(storyKey, {
          storyId,
          taskRefs: new Set(),
          hasAll: false,
          blockerMilestones: new Set(),
          blockerCounts: new Map(),
          allBlockerMilestones: new Set(),
        });
      }

      const storyBucket = stats.futureBlockedByStory.get(storyKey);
      storyBucket.blockerMilestones.add(blockerMilestoneId);
      if (taskRef?.localTaskId === 'ALL') {
        storyBucket.hasAll = true;
        storyBucket.allBlockerMilestones.add(blockerMilestoneId);
      } else {
        storyBucket.taskRefs.add(String(entry.taskId || `${stats.id}:${storyKey}`));
        storyBucket.blockerCounts.set(blockerMilestoneId, (storyBucket.blockerCounts.get(blockerMilestoneId) || 0) + 1);
      }

      if (storyId) stats.blockedStories.add(storyId);
      stats.blockerMilestones.add(blockerMilestoneId);
      if (entry.taskId) stats.blockedTaskRefs.push(String(entry.taskId));
    }

    const milestones = [...milestoneStats.values()]
      .map((stats) => {
        let blockedEquivalent = 0;
        const suggestedMoves = [];
        for (const [storyKey, storyBucket] of stats.futureBlockedByStory.entries()) {
          const storyMeta = storyBucket.storyId ? storyIndex.get(storyBucket.storyId) : null;
          const fullStoryWeight = Math.max(1, storyMeta?.taskCount || 0);
          const blockedCount = storyBucket.hasAll ? fullStoryWeight : storyBucket.taskRefs.size;
          blockedEquivalent += blockedCount;
          if (!storyBucket.storyId && storyBucket.taskRefs.size > 0) {
            stats.blockedStories.add(storyKey);
          }

          const effectiveBlockerCounts = new Map(storyBucket.blockerCounts);
          for (const blockerMilestoneId of storyBucket.allBlockerMilestones) {
            effectiveBlockerCounts.set(
              blockerMilestoneId,
              (effectiveBlockerCounts.get(blockerMilestoneId) || 0) + fullStoryWeight,
            );
          }

          const blockerMilestones = [...storyBucket.blockerMilestones].sort(
            (a, b) => milestoneNumber(a) - milestoneNumber(b),
          );
          const targetMilestone = blockerMilestones.length > 0 ? blockerMilestones[blockerMilestones.length - 1] : null;

          if (targetMilestone && targetMilestone !== stats.id) {
            const storyLabel = storyBucket.storyId
              ? `${storyBucket.storyId}${storyMeta?.title ? ` (${storyMeta.title})` : ''}`
              : [...storyBucket.taskRefs].slice(0, 3).join(', ') || storyKey;
            const blockedRatio = fullStoryWeight > 0 ? blockedCount / fullStoryWeight : 1;
            let reason;
            if (blockerMilestones.length === 1) {
              reason =
                blockedCount >= fullStoryWeight
                  ? `all ${fullStoryWeight} task(s) are blocked by ${targetMilestone}`
                  : `${blockedCount}/${fullStoryWeight} task(s) are blocked by ${targetMilestone}`;
            } else {
              reason =
                `${blockedCount}/${fullStoryWeight} task(s) depend on ${blockerMilestones.join(', ')}; ` +
                `latest no-deferral placement is ${targetMilestone}`;
            }

            suggestedMoves.push({
              storyId: storyBucket.storyId || null,
              storyLabel,
              fromMilestone: stats.id,
              toMilestone: targetMilestone,
              blockedTasks: blockedCount,
              totalStoryTasks: fullStoryWeight,
              blockedRatio: Number(blockedRatio.toFixed(4)),
              blockerMilestones,
              blockerCounts: Object.fromEntries(
                [...effectiveBlockerCounts.entries()].sort((a, b) => milestoneNumber(a[0]) - milestoneNumber(b[0])),
              ),
              reason,
            });
          }
        }

        const ratio = stats.totalTasks > 0 ? blockedEquivalent / stats.totalTasks : blockedEquivalent > 0 ? 1 : 0;
        let status = 'ok';
        if (blockedEquivalent >= thresholds.failCount || ratio >= thresholds.failRatio) {
          status = 'failed';
        } else if (blockedEquivalent >= thresholds.warningCount || ratio >= thresholds.warningRatio) {
          status = 'warning';
        }

        const blockers = [...stats.blockerMilestones].sort((a, b) => milestoneNumber(a) - milestoneNumber(b));
        const blockedStories = [...stats.blockedStories].sort((a, b) =>
          a.localeCompare(b, undefined, { numeric: true }),
        );
        const recommendations = [];
        if (status !== 'ok') {
          if (suggestedMoves.length > 0) {
            for (const move of suggestedMoves.slice(0, 5)) {
              recommendations.push(
                `Move ${move.storyLabel} from ${move.fromMilestone} to ${move.toMilestone} because ${move.reason}.`,
              );
            }
          } else {
            recommendations.push(
              `${stats.id}: regroup ${blockedStories.slice(0, 5).join(', ') || 'the affected tasks'} with ${blockers.join(', ') || 'later milestones'}, ` +
                `or move the dependent work later so ${stats.id} can finish without deferrals.`,
            );
          }
        }

        return {
          id: stats.id,
          totalTasks: stats.totalTasks,
          totalStories: stats.totalStories,
          frIds: [...stats.frIdCounts.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
          frCount: stats.frIdCounts.size,
          blockedTasks: blockedEquivalent,
          blockedRatio: Number(ratio.toFixed(4)),
          blockedStories,
          blockerMilestones: blockers,
          suggestedMoves,
          blockedTaskRefs: [...new Set(stats.blockedTaskRefs)].sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true }),
          ),
          recommendations,
          status,
        };
      })
      .sort((a, b) => milestoneNumber(a.id) - milestoneNumber(b.id));

    const failing = milestones.filter((m) => m.status === 'failed').map((m) => m.id);
    const warnings = milestones.filter((m) => m.status === 'warning').map((m) => m.id);
    const recommendations = milestones.flatMap((m) => m.recommendations);
    const suggestedMoves = milestones.flatMap((m) => m.suggestedMoves);
    const totalFutureBlockedTasks = milestones.reduce((sum, milestone) => sum + (milestone.blockedTasks || 0), 0);

    const conflicts = [];
    const simulatedMilestones = new Map(
      [...milestoneStats.entries()].map(([milestoneId, stats]) => [
        milestoneId,
        {
          id: milestoneId,
          originalStories: stats.totalStories,
          originalTasks: stats.totalTasks,
          originalFrCount: stats.frIdCounts.size,
          storyCount: stats.totalStories,
          taskCount: stats.totalTasks,
          blockedTasks: milestones.find((milestone) => milestone.id === milestoneId)?.blockedTasks || 0,
          frIdCounts: cloneCountMap(stats.frIdCounts),
        },
      ]),
    );

    const moveDestinations = new Map();
    for (const move of suggestedMoves) {
      const moveKey = move.storyId || move.storyLabel;
      const existing = moveDestinations.get(moveKey);
      if (existing && existing !== move.toMilestone) {
        conflicts.push({
          severity: 'error',
          type: 'conflicting-placement',
          storyId: move.storyId || null,
          storyLabel: move.storyLabel,
          fromMilestone: move.fromMilestone,
          toMilestone: move.toMilestone,
          conflictingMilestone: existing,
          reason: `${move.storyLabel} is assigned to multiple target milestones (${existing}, ${move.toMilestone}).`,
        });
        continue;
      }
      moveDestinations.set(moveKey, move.toMilestone);

      const storyMeta = move.storyId ? storyIndex.get(move.storyId) : null;
      const sourceState = simulatedMilestones.get(move.fromMilestone) || {
        id: move.fromMilestone,
        originalStories: 0,
        originalTasks: 0,
        originalFrCount: 0,
        storyCount: 0,
        taskCount: 0,
        blockedTasks: 0,
        frIdCounts: new Map(),
      };
      const targetState = simulatedMilestones.get(move.toMilestone) || {
        id: move.toMilestone,
        originalStories: 0,
        originalTasks: 0,
        originalFrCount: 0,
        storyCount: 0,
        taskCount: 0,
        blockedTasks: milestones.find((milestone) => milestone.id === move.toMilestone)?.blockedTasks || 0,
        frIdCounts: new Map(),
      };

      if (!simulatedMilestones.has(move.fromMilestone)) simulatedMilestones.set(move.fromMilestone, sourceState);
      if (!simulatedMilestones.has(move.toMilestone)) simulatedMilestones.set(move.toMilestone, targetState);

      if (!storyMeta || !move.storyId) {
        conflicts.push({
          severity: 'error',
          type: 'missing-story-metadata',
          storyId: move.storyId || null,
          storyLabel: move.storyLabel,
          fromMilestone: move.fromMilestone,
          toMilestone: move.toMilestone,
          reason: `Missing story-tracker metadata for ${move.storyLabel}; cannot simulate regroup capacity safely.`,
        });
        continue;
      }

      sourceState.storyCount = Math.max(0, sourceState.storyCount - 1);
      sourceState.taskCount = Math.max(0, sourceState.taskCount - (storyMeta.taskCount || 0));
      for (const frId of storyMeta.frIds || []) {
        const nextCount = (sourceState.frIdCounts.get(frId) || 0) - 1;
        if (nextCount > 0) sourceState.frIdCounts.set(frId, nextCount);
        else sourceState.frIdCounts.delete(frId);
      }

      targetState.storyCount += 1;
      targetState.taskCount += storyMeta.taskCount || 0;
      for (const frId of storyMeta.frIds || []) {
        targetState.frIdCounts.set(frId, (targetState.frIdCounts.get(frId) || 0) + 1);
      }
    }

    for (const move of suggestedMoves) {
      const sourceState = simulatedMilestones.get(move.fromMilestone);
      if (sourceState && sourceState.originalStories > 0 && sourceState.storyCount === 0) {
        conflicts.push({
          severity: 'error',
          type: 'empty-source-milestone',
          milestone: move.fromMilestone,
          storyId: move.storyId || null,
          storyLabel: move.storyLabel,
          reason: `Applying the proposed moves would leave ${move.fromMilestone} with no stories.`,
        });
      }
    }

    const simulatedMilestoneSummaries = [...simulatedMilestones.values()]
      .map((state) => {
        const frCount = state.frIdCounts.size;
        const blockedRatio =
          state.taskCount > 0 ? state.blockedTasks / state.taskCount : state.blockedTasks > 0 ? 1 : 0;
        return {
          id: state.id,
          originalStories: state.originalStories,
          originalTasks: state.originalTasks,
          originalFrCount: state.originalFrCount,
          projectedStories: state.storyCount,
          projectedTasks: state.taskCount,
          projectedFrCount: frCount,
          projectedBlockedTasks: state.blockedTasks,
          projectedBlockedRatio: Number(blockedRatio.toFixed(4)),
        };
      })
      .sort((a, b) => milestoneNumber(a.id) - milestoneNumber(b.id));

    for (const simulated of simulatedMilestoneSummaries) {
      const receivesMoves = suggestedMoves.some((move) => move.toMilestone === simulated.id);
      if (!receivesMoves) continue;

      const overloadReasons = [];
      if (simulated.projectedFrCount > thresholds.failFrCount) {
        overloadReasons.push(
          `projected FR count ${simulated.projectedFrCount} exceeds hard limit ${thresholds.failFrCount}`,
        );
      }
      if (simulated.projectedStories > thresholds.failStoryCount) {
        overloadReasons.push(
          `projected story count ${simulated.projectedStories} exceeds hard limit ${thresholds.failStoryCount}`,
        );
      }
      if (simulated.projectedBlockedRatio >= thresholds.failRatio) {
        overloadReasons.push(
          `projected blocked-task ratio ${percent(simulated.projectedBlockedRatio)} exceeds ${percent(thresholds.failRatio)}`,
        );
      }

      if (overloadReasons.length > 0) {
        conflicts.push({
          severity: 'error',
          type: 'target-overload',
          milestone: simulated.id,
          reason: `${simulated.id} would be overloaded after regrouping: ${overloadReasons.join(', ')}.`,
        });
        continue;
      }

      if (simulated.projectedFrCount > thresholds.warningFrCount) {
        recommendations.push(
          `${simulated.id}: regrouping would raise FR count to ${simulated.projectedFrCount}/${thresholds.failFrCount}; split or rebalance before applying all moves.`,
        );
      }
      if (simulated.projectedStories > thresholds.warningStoryCount) {
        recommendations.push(
          `${simulated.id}: regrouping would raise story count to ${simulated.projectedStories}/${thresholds.failStoryCount}; review milestone capacity before applying all moves.`,
        );
      }
    }

    const dedupedConflicts = [];
    const seenConflicts = new Set();
    for (const conflict of conflicts) {
      const key = JSON.stringify(conflict);
      if (seenConflicts.has(key)) continue;
      seenConflicts.add(key);
      dedupedConflicts.push(conflict);
    }

    const currentInputsHash = sha256(
      JSON.stringify({
        storyTracker: describeArtifactFile(this.root, trackerPath)?.sha256 || null,
        blockedTaskRegistry: describeArtifactFile(this.root, registryPath)?.sha256 || null,
      }),
    );
    let ratchet = {
      applied: false,
      previousTotalFutureBlockedTasks: null,
      currentTotalFutureBlockedTasks: totalFutureBlockedTasks,
      improved: null,
      reason: null,
    };
    const previousTotalFutureBlockedTasks = Number(previousAdvisor?.summary?.totalFutureBlockedTasks);
    const previousInputsHash = previousAdvisor?.integrity?.inputsHash;
    if (
      Number.isFinite(previousTotalFutureBlockedTasks) &&
      previousTotalFutureBlockedTasks > 0 &&
      previousInputsHash &&
      previousInputsHash !== currentInputsHash &&
      previousAdvisor?.status !== 'skipped'
    ) {
      ratchet = {
        applied: true,
        previousTotalFutureBlockedTasks,
        currentTotalFutureBlockedTasks: totalFutureBlockedTasks,
        improved: totalFutureBlockedTasks < previousTotalFutureBlockedTasks,
        reason:
          totalFutureBlockedTasks < previousTotalFutureBlockedTasks
            ? null
            : `previous regroup baseline had ${previousTotalFutureBlockedTasks} future-blocked tasks, current plan has ${totalFutureBlockedTasks}`,
      };
    }

    const blockingConflicts = dedupedConflicts.filter((conflict) => conflict.severity === 'error');
    const ratchetFailed = ratchet.applied && ratchet.improved === false;

    let message;
    if (blockingConflicts.length > 0) {
      const summary = blockingConflicts
        .slice(0, 3)
        .map((conflict) => conflict.reason)
        .join(' | ');
      message =
        `BLOCKED TASK VALIDATION FAILED: Proposed regrouping has deterministic conflicts. ${summary} ` +
        'Resolve milestone-capacity or placement conflicts before applying the regroup plan.';
    } else if (ratchetFailed) {
      message =
        `BLOCKED TASK VALIDATION FAILED: Regroup ratchet did not improve future-blocked tasks; ${ratchet.reason}. ` +
        'Regrouping retries must reduce blocked work before build can proceed.';
    } else if (failing.length > 0) {
      const summary = milestones
        .filter((m) => m.status === 'failed')
        .map(
          (m) =>
            `${m.id} has ${m.blockedTasks}/${m.totalTasks || m.blockedTasks} future-blocked task(s) (${percent(m.blockedRatio)}) blocked by ${m.blockerMilestones.join(', ') || 'later milestones'}`,
        )
        .join('; ');
      message =
        `BLOCKED TASK VALIDATION FAILED: ${summary}. ` +
        'Re-run milestone decomposition and regroup tightly coupled stories before build.';
    } else if (warnings.length > 0) {
      const summary = milestones
        .filter((m) => m.status === 'warning')
        .map(
          (m) =>
            `${m.id} has ${m.blockedTasks}/${m.totalTasks || m.blockedTasks} future-blocked task(s) (${percent(m.blockedRatio)})`,
        )
        .join('; ');
      message =
        `BLOCKED TASK VALIDATION WARNING: ${summary}. ` +
        'Planning can continue, but regrouping these stories will reduce build-time deferrals.';
    } else {
      message = 'BLOCKED TASK VALIDATION PASSED: No milestone exceeds the future-blocked task thresholds.';
    }

    for (const conflict of blockingConflicts) {
      recommendations.push(conflict.reason);
    }
    if (ratchetFailed && ratchet.reason) {
      recommendations.push(`Regroup ratchet failed because ${ratchet.reason}.`);
    }

    return emitAdvisor({
      passed: failing.length === 0 && blockingConflicts.length === 0 && !ratchetFailed,
      skipped: false,
      thresholds,
      milestones,
      failing,
      warnings,
      totalFutureBlockedTasks,
      simulatedMilestones: simulatedMilestoneSummaries,
      conflicts: dedupedConflicts,
      ratchet,
      suggestedMoves,
      recommendations: [...new Set(recommendations)],
      message,
    });
  }

  /**
   * Validate whether the current planning packet has absorbed the latest regroup plan.
   * Detects pending move-story operations and stale regroup plans after tracker updates.
   * @returns {{
   *   passed: boolean,
   *   skipped: boolean,
   *   stale: boolean,
   *   status: string,
   *   artifactPath: string,
   *   expectedInputs: object,
   *   currentInputs: object,
   *   applied: Array<object>,
   *   pending: Array<object>,
   *   invalid: Array<object>,
   *   staleReasons: string[],
   *   message: string
   * }}
   */
  validateRegroupPlan() {
    const planningDir = this._findPlanningDir();
    if (!planningDir) {
      return {
        passed: false,
        skipped: false,
        stale: false,
        status: 'fail',
        artifactPath: '_cobolt-output/latest/planning/milestone-regroup-plan.json',
        expectedInputs: {},
        currentInputs: {},
        applied: [],
        pending: [],
        invalid: [],
        staleReasons: [],
        message: 'REGROUP PLAN VALIDATION FAILED: No planning directory found.',
      };
    }

    const regroupPath = path.join(planningDir, 'milestone-regroup-plan.json');
    const regroupPathRelative = path.relative(this.root, regroupPath).replaceAll('\\', '/');
    if (!fs.existsSync(regroupPath)) {
      return {
        passed: true,
        skipped: true,
        stale: false,
        status: 'skipped',
        artifactPath: regroupPathRelative,
        expectedInputs: {},
        currentInputs: {},
        applied: [],
        pending: [],
        invalid: [],
        staleReasons: [],
        message:
          'REGROUP PLAN VALIDATION SKIPPED: milestone-regroup-plan.json not found. ' +
          'Run validate-blocked-tasks first when milestone regrouping is needed.',
      };
    }

    const regroupPlan = safeReadJson(regroupPath);
    if (!regroupPlan || !Array.isArray(regroupPlan?.patch?.operations)) {
      return {
        passed: false,
        skipped: false,
        stale: false,
        status: 'fail',
        artifactPath: regroupPathRelative,
        expectedInputs: {},
        currentInputs: {},
        applied: [],
        pending: [],
        invalid: [],
        staleReasons: [],
        message:
          'REGROUP PLAN VALIDATION FAILED: milestone-regroup-plan.json is unreadable or missing patch.operations.',
      };
    }

    const schemaResult = this._schemaValidator.validate(regroupPlan, 'milestone-regroup-plan.schema.json');
    if (!schemaResult.valid) {
      return {
        passed: false,
        skipped: false,
        stale: false,
        status: 'fail',
        artifactPath: regroupPathRelative,
        expectedInputs: regroupPlan.inputs || {},
        currentInputs: {},
        applied: [],
        pending: [],
        invalid: [],
        staleReasons: [],
        schemaErrors: schemaResult.errors,
        message:
          'REGROUP PLAN VALIDATION FAILED: milestone-regroup-plan.json does not match milestone-regroup-plan.schema.json. ' +
          schemaResult.errors.slice(0, 3).join(' | '),
      };
    }

    const trackerPath = path.join(planningDir, 'story-tracker.json');
    const registryPath = path.join(planningDir, 'cross-milestone-blocked-tasks.json');
    const currentInputs = {
      storyTracker: describeArtifactFile(this.root, trackerPath),
      blockedTaskRegistry: describeArtifactFile(this.root, registryPath),
    };
    const expectedInputs = regroupPlan.inputs || {};

    const tracker = safeReadJson(trackerPath);
    if (!Array.isArray(tracker?.stories)) {
      return {
        passed: false,
        skipped: false,
        stale: false,
        status: 'fail',
        artifactPath: regroupPathRelative,
        expectedInputs,
        currentInputs,
        applied: [],
        pending: [],
        invalid: [],
        staleReasons: [],
        message: 'REGROUP PLAN VALIDATION FAILED: story-tracker.json is unreadable or missing the stories array.',
      };
    }

    const staleReasons = [];
    if (
      expectedInputs.storyTracker?.sha256 &&
      currentInputs.storyTracker?.sha256 &&
      expectedInputs.storyTracker.sha256 !== currentInputs.storyTracker.sha256
    ) {
      staleReasons.push('story-tracker.json changed after the regroup plan was generated');
    }
    if (
      expectedInputs.blockedTaskRegistry?.sha256 &&
      currentInputs.blockedTaskRegistry?.sha256 &&
      expectedInputs.blockedTaskRegistry.sha256 !== currentInputs.blockedTaskRegistry.sha256
    ) {
      staleReasons.push('cross-milestone-blocked-tasks.json changed after the regroup plan was generated');
    }

    const storyMilestones = new Map(
      tracker.stories
        .map((story) => ({
          storyId: normalizeStoryId(story.id || story.storyId),
          milestone: normalizeMilestoneId(story.milestone || story.milestoneId),
        }))
        .filter((story) => story.storyId)
        .map((story) => [story.storyId, story.milestone || null]),
    );

    const operations = sortRegroupOperations(
      regroupPlan.patch.operations.filter((operation) => String(operation?.op || '') === 'move-story'),
    );
    const applied = [];
    const pending = [];
    const invalid = [];

    for (const operation of operations) {
      const storyId = normalizeStoryId(operation.storyId);
      const toMilestone = normalizeMilestoneId(operation.toMilestone);
      const fromMilestone = normalizeMilestoneId(operation.fromMilestone);
      const currentMilestone = storyMilestones.get(storyId) || null;
      const normalized = {
        ...operation,
        storyId,
        fromMilestone,
        toMilestone,
        currentMilestone,
      };

      if (!storyId || !toMilestone) {
        invalid.push({
          ...normalized,
          reason: 'Operation is missing storyId or toMilestone.',
        });
        continue;
      }

      if (!currentMilestone) {
        invalid.push({
          ...normalized,
          reason: `${storyId} is not present in story-tracker.json.`,
        });
        continue;
      }

      if (currentMilestone === toMilestone) {
        applied.push(normalized);
      } else {
        pending.push(normalized);
      }
    }

    let status = 'pass';
    let passed = true;
    let message;

    if (invalid.length > 0 || pending.length > 0) {
      status = 'fail';
      passed = false;
      const pendingSummary = pending
        .slice(0, 5)
        .map(
          (operation) =>
            `${operation.storyId} still in ${operation.currentMilestone || 'unknown'} (target ${operation.toMilestone})`,
        )
        .join('; ');
      const invalidSummary = invalid
        .slice(0, 5)
        .map((operation) => operation.reason)
        .join('; ');
      message =
        'REGROUP PLAN VALIDATION FAILED: Proposed regrouping has not been fully applied. ' +
        [pendingSummary, invalidSummary].filter(Boolean).join(' ');
    } else if (staleReasons.length > 0) {
      status = 'warning';
      message =
        'REGROUP PLAN VALIDATION WARNING: All proposed move-story operations are already reflected in story-tracker.json, ' +
        `but the regroup plan is stale because ${staleReasons.join(' and ')}. ` +
        'Re-run validate-blocked-tasks to refresh the deterministic regroup artifact.';
    } else {
      message =
        'REGROUP PLAN VALIDATION PASSED: All move-story operations are already reflected in story-tracker.json.';
    }

    return {
      passed,
      skipped: false,
      stale: staleReasons.length > 0,
      status,
      artifactPath: regroupPathRelative,
      expectedInputs,
      currentInputs,
      applied,
      pending,
      invalid,
      staleReasons,
      message,
    };
  }

  /**
   * List all skills and producers and their dependencies.
   * Returns the merged view: skills first, producers second. Mode-variant
   * aliases like `cobolt-build-feature` and handoff aliases like
   * `cobolt-plan-build-handoff` stay in skills; deterministic CLI tools
   * (kind:"tool") live in producers.
   */
  list() {
    if (!this.deps) return {};
    return { ...(this.deps.skills || {}), ...(this.deps.producers || {}) };
  }

  /**
   * Auto-register all planning artifacts found on disk into cobolt-state.json.
   * Replaces 37 manual `cobolt-state.js set planningArtifacts.X` calls.
   * @returns {{ registered: number, artifacts: object, errors: string[] }}
   */
  // RD4 (v0.52+): emit per-skip audit lines so operators can diagnose why
  // `requiredMissing` is high without re-running register-all in debug mode.
  // Each line: { at, runId, event, artifactId, expectedPath, producedBy }.
  // Best-effort: audit-write failure must never break registration.
  _appendRegisterAllAudit(skipped, runId) {
    if (!Array.isArray(skipped) || skipped.length === 0) return;
    try {
      const auditPath = path.join(this.root, '_cobolt-output', 'audit', 'register-all.jsonl');
      fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
      const lines = skipped
        .map((s) =>
          JSON.stringify({
            at: runId,
            runId,
            event: 'artifact-skipped',
            artifactId: s.artifactId,
            expectedPath: s.expectedPath,
            producedBy: s.producedBy,
          }),
        )
        .join('\n');
      fs.appendFileSync(auditPath, `${lines}\n`, { mode: 0o600 });
    } catch {
      /* best-effort */
    }
  }

  // RD5 (v0.52+): walk the planning dir once and return the most recent
  // mtime as ISO string. Consumers (build-handoff, /cobolt-unblock, the
  // post-Stop register-all hook) compare this against the gate verdict's
  // `timestamp` to detect a stale snapshot — i.e., files written after
  // register-all last ran. Returns null when the dir is empty or unreadable.
  _computeLatestDiskMtime(planningDir) {
    if (!planningDir) return null;
    let latestMs = 0;
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile()) {
          try {
            const st = fs.statSync(full);
            if (st.mtimeMs > latestMs) latestMs = st.mtimeMs;
          } catch {
            /* skip unreadable file */
          }
        }
      }
    };
    walk(planningDir);
    return latestMs > 0 ? new Date(latestMs).toISOString() : null;
  }

  registerAll() {
    const planningDir = this._findPlanningDir();
    if (!planningDir) {
      return { registered: 0, artifacts: {}, errors: ['No planning directory found'] };
    }

    const stateFile = path.join(this.root, 'cobolt-state.json');
    let state = {};
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      /* fresh state */
    }

    if (!state.planningArtifacts) state.planningArtifacts = {};

    const registered = {};
    const errors = [];
    const skipped = []; // RD4: capture per-artifact skip evidence for audit emission below
    let count = 0;
    const now = new Date().toISOString();

    for (const artifactId of listCanonicalPlanningArtifactIds(this.deps)) {
      const artifactDef = this.deps.artifacts[artifactId];
      const stateKey = artifactIdToStateKey(artifactId);
      const artifactResult =
        artifactId === 'story-file' ? this._checkStoryCoverageArtifact() : this._checkArtifact(artifactId);

      if (!artifactResult.exists) {
        // RD4: record what's missing so operators don't have to re-derive it
        // from `requiredMissing: N`. Producer mapping comes straight from the
        // schema so the audit line names the sub-skill that should have run.
        skipped.push({
          artifactId,
          expectedPath: artifactDef?.path || artifactResult?.path || null,
          producedBy: artifactDef?.producedBy || null,
        });
        continue;
      }

      if (artifactId === 'story-file') {
        const coverage = getStoryCoverage(this.root, { planningDir });
        const storyFiles = coverage.actualFiles.map((file) => ({
          key: file.storyId,
          path: `_cobolt-output/latest/planning/${file.relativePath}`,
          size: file.size,
          timestamp: now,
        }));
        registered[stateKey] = storyFiles;
        state.planningArtifacts[stateKey] = storyFiles;
        count++;
        continue;
      }

      registered[stateKey] = {
        exists: true,
        path: artifactResult.path,
        size: artifactResult.size,
        producedBy: artifactDef.producedBy,
        timestamp: now,
      };
      state.planningArtifacts[stateKey] = registered[stateKey];
      count++;
    }

    if (!state.gates) state.gates = {};

    const regroupValidation = this.validateRegroupPlan();
    state.gates['planning-regroup'] = {
      passed: regroupValidation.passed,
      gate_name: 'planning-regroup',
      status: regroupValidation.status,
      stale: regroupValidation.stale === true,
      skipped: regroupValidation.skipped === true,
      artifactPath: regroupValidation.artifactPath || null,
      appliedCount: Array.isArray(regroupValidation.applied) ? regroupValidation.applied.length : 0,
      pendingCount: Array.isArray(regroupValidation.pending) ? regroupValidation.pending.length : 0,
      invalidCount: Array.isArray(regroupValidation.invalid) ? regroupValidation.invalid.length : 0,
      timestamp: now,
    };

    const planningHandoffReadiness = this.check('cobolt-plan-build-handoff');
    // RD5: snapshot the latest disk mtime so consumers can detect stale verdicts.
    // At write time `latestDiskMtime` and `timestamp` are effectively equal; the
    // value matters when downstream consumers (build-handoff gate, /cobolt-unblock,
    // the Stop-event register-all hook) re-read the verdict later and need to
    // tell whether the registry is still fresh.
    const latestDiskMtime = this._computeLatestDiskMtime(planningDir);
    state.gates['planning-artifacts'] = {
      passed: planningHandoffReadiness.passed,
      gate_name: 'planning-artifacts',
      checkedSkill: planningHandoffReadiness.skill,
      originalSkill: planningHandoffReadiness.originalSkill,
      registered: count,
      requiredPresent: planningHandoffReadiness.present.length,
      requiredMissing: planningHandoffReadiness.missing.length,
      timestamp: now,
      latestDiskMtime,
    };

    if (!state.pipeline) state.pipeline = {};
    if (!state.pipeline.stages) state.pipeline.stages = {};
    if (!state.pipeline.stages['S1-S4']) state.pipeline.stages['S1-S4'] = {};
    state.pipeline.stages['S1-S4'].filesWritten = Object.values(registered)
      .flatMap((entry) => (Array.isArray(entry) ? entry.map((item) => item.path) : [entry.path]))
      .filter(Boolean);

    // Write state
    try {
      atomicWrite(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    } catch (e) {
      errors.push(`Failed to write cobolt-state.json: ${e.message}`);
    }

    // RD4: emit the per-skip audit log AFTER the state write so a state-write
    // failure does not suppress the diagnostic trail.
    this._appendRegisterAllAudit(skipped, now);

    return { registered: count, artifacts: registered, errors, skipped: skipped.length };
  }

  /**
   * Validate milestone count in milestones.md.
   * Deterministic check: parses the file, counts ## M{n} headings, enforces minimum 3.
   * @returns {{ passed: boolean, count: number, minimum: number, maximum: number, sizingTarget: number, message: string, details: object }}
   */
  validateMilestones() {
    const planningDir = this._findPlanningDir();
    if (!planningDir) {
      return {
        passed: false,
        count: 0,
        minimum: 3,
        maximum: 0,
        sizingTarget: 0,
        message: 'MILESTONE VALIDATION FAILED: No planning directory found. Run /cobolt-plan first.',
        details: {},
      };
    }

    const milestonesPath = path.join(planningDir, 'milestones.md');
    if (!fs.existsSync(milestonesPath)) {
      return {
        passed: false,
        count: 0,
        minimum: 3,
        maximum: 0,
        sizingTarget: 0,
        message: 'MILESTONE VALIDATION FAILED: milestones.md not found. Run cobolt-decompose-milestones first.',
        details: {},
      };
    }

    const content = fs.readFileSync(milestonesPath, 'utf8');
    // Pass project root (this.root), not planning dir — getMilestoneIds internally resolves to planning dir
    const milestoneIds = getMilestoneIds(this.root);
    const count = milestoneIds.length;
    const milestoneNumbers = milestoneIds.map((id) => parseInt(id.replace(/^M/i, ''), 10));

    // Parse frontmatter for sizing targets
    let sizingMin = 3;
    let sizingMax = 999;
    let sizingTarget = 0;
    let userMilestoneHint = null;

    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      const fm = frontmatterMatch[1];
      const minMatch = fm.match(/sizingMin:\s*(\d+)/);
      const maxMatch = fm.match(/sizingMax:\s*(\d+)/);
      const targetMatch = fm.match(/sizingTarget:\s*(\d+)/);
      const hintMatch = fm.match(/userMilestoneHint:\s*(\d+)/);

      if (minMatch) sizingMin = Math.max(3, parseInt(minMatch[1], 10));
      if (maxMatch) sizingMax = parseInt(maxMatch[1], 10);
      if (targetMatch) sizingTarget = parseInt(targetMatch[1], 10);
      if (hintMatch) userMilestoneHint = parseInt(hintMatch[1], 10);
    }

    // Absolute minimum is always 3, regardless of formula or user hint
    const absoluteMinimum = 3;
    const effectiveMin = Math.max(absoluteMinimum, sizingMin);

    const passed = count >= effectiveMin && count <= sizingMax;

    let message;
    if (count < effectiveMin) {
      message =
        `MILESTONE VALIDATION FAILED: Found ${count} milestone(s), minimum required is ${effectiveMin} (absolute floor: 3). ` +
        `The milestone decomposition must produce at least 3 milestones. ` +
        `Re-run cobolt-decompose-milestones to split the largest milestone(s).`;
    } else if (count > sizingMax && sizingMax > 0) {
      message =
        `MILESTONE VALIDATION WARNING: Found ${count} milestones, maximum recommended is ${sizingMax}. ` +
        `Consider merging the smallest milestones that share data model dependencies.`;
    } else {
      message = `MILESTONE VALIDATION PASSED: ${count} milestones (range: ${effectiveMin}-${sizingMax}).`;
    }

    return {
      passed,
      count,
      minimum: effectiveMin,
      maximum: sizingMax,
      sizingTarget,
      userMilestoneHint,
      milestoneNumbers: milestoneNumbers.sort((a, b) => a - b),
      message,
      details: { path: milestonesPath, absoluteMinimum, formulaMin: sizingMin, formulaMax: sizingMax },
    };
  }

  /**
   * Get feature milestone range info.
   * Returns the highest existing milestone number and whether feature mode is active.
   * Used by build preflight to validate milestone arguments in feature mode.
   * @returns {{ featureMode: boolean, highestMilestone: number, nextMilestone: number, featureMilestones: number[], originalMilestones: number[] }}
   */
  getFeatureMilestoneInfo() {
    const planningDir = this._findPlanningDir();
    if (!planningDir)
      return {
        featureMode: false,
        highestMilestone: 0,
        nextMilestone: 1,
        featureMilestones: [],
        originalMilestones: [],
      };

    let featureMode = false;
    try {
      const stateFile = path.join(this.root, 'cobolt-state.json');
      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        featureMode = state?.planning?.mode === 'feature';
      }
    } catch {
      // best effort
    }

    const milestonesPath = path.join(planningDir, 'milestones.md');
    if (!fs.existsSync(milestonesPath))
      return { featureMode, highestMilestone: 0, nextMilestone: 1, featureMilestones: [], originalMilestones: [] };

    const content = fs.readFileSync(milestonesPath, 'utf8');
    const milestoneIds = getMilestoneIds(this.root);
    const milestoneNumbers = milestoneIds
      .map((id) => parseInt(id.replace(/^M/i, ''), 10))
      .filter((n) => !Number.isNaN(n));
    const highestMilestone = milestoneNumbers.length > 0 ? Math.max(...milestoneNumbers) : 0;
    const milestoneSections = new Map();
    const milestoneHeading = /^#{2,3}\s+(?:Milestone\s+)?M(\d+)\s*[:\-\u2014]/i;
    let currentMilestone = null;
    let currentLines = [];

    for (const line of content.split(/\r?\n/)) {
      const headingMatch = line.match(milestoneHeading);
      if (headingMatch) {
        if (currentMilestone !== null) milestoneSections.set(currentMilestone, currentLines.join('\n'));
        currentMilestone = parseInt(headingMatch[1], 10);
        currentLines = [line];
        continue;
      }
      if (currentMilestone !== null) currentLines.push(line);
    }
    if (currentMilestone !== null) milestoneSections.set(currentMilestone, currentLines.join('\n'));

    const featureMilestones = [];
    const originalMilestones = [];
    for (const num of milestoneNumbers) {
      const section = milestoneSections.get(num);
      if (section) {
        if (/Source:\s*feature-prd\.md/i.test(section)) {
          featureMilestones.push(num);
        } else {
          originalMilestones.push(num);
        }
      } else {
        originalMilestones.push(num);
      }
    }

    return {
      featureMode,
      highestMilestone,
      nextMilestone: highestMilestone + 1,
      featureMilestones,
      originalMilestones,
    };
  }

  /**
   * Validate per-milestone FR distribution.
   * Target: 5-8 FRs per milestone (preferred). Hard fail if any milestone has >10 FRs.
   * Tightened from 15→10 in v0.11.0 ("Production Defaults") — smaller milestones reduce
   * cross-cutting interactions per build, raising per-milestone success rate.
   * @returns {{ passed: boolean, target: {min: number, max: number}, hardLimit: number, milestones: object[], oversized: string[], message: string }}
   */
  validateMilestoneFRDistribution() {
    // Rigorous mode tightens target/cap (2-3 target, hard cap 4). Auto mode unchanged.
    let rigorous = false;
    try {
      rigorous = require('../lib/cobolt-mode').isRigorous(this.root);
    } catch {}
    const FR_TARGET_MIN = rigorous ? 2 : 5;
    const FR_PREFERRED_MIN = rigorous ? 2 : 5;
    const FR_TARGET_MAX = rigorous ? 3 : 8;
    const FR_HARD_LIMIT = rigorous ? 4 : 10;

    const frCounts = getMilestoneFRCounts(this.root);
    const milestoneIds = Object.keys(frCounts);

    if (milestoneIds.length === 0) {
      return {
        passed: false,
        target: { min: FR_TARGET_MIN, max: FR_TARGET_MAX },
        preferredRange: { min: FR_PREFERRED_MIN, max: FR_TARGET_MAX },
        hardLimit: FR_HARD_LIMIT,
        milestones: [],
        oversized: [],
        message: 'FR DISTRIBUTION CHECK FAILED: No milestones found or milestones.md has no FR references.',
      };
    }

    const milestones = milestoneIds.map((id) => ({
      id,
      frCount: frCounts[id].length,
      frs: frCounts[id],
      status:
        frCounts[id].length > FR_HARD_LIMIT
          ? 'oversized'
          : frCounts[id].length > FR_TARGET_MAX
            ? 'warning'
            : frCounts[id].length < FR_TARGET_MIN
              ? 'undersized'
              : 'ok',
    }));

    const oversized = milestones.filter((m) => m.frCount > FR_HARD_LIMIT);
    const warnings = milestones.filter((m) => m.frCount > FR_TARGET_MAX && m.frCount <= FR_HARD_LIMIT);
    const passed = oversized.length === 0;

    let message;
    if (oversized.length > 0) {
      const details = oversized.map((m) => `${m.id} has ${m.frCount} FRs`).join(', ');
      message =
        `FR DISTRIBUTION FAILED: ${oversized.length} milestone(s) exceed the hard limit of ${FR_HARD_LIMIT} FRs — ${details}. ` +
        `Target is ${FR_TARGET_MIN}-${FR_TARGET_MAX} FRs per milestone (preferred ${FR_PREFERRED_MIN}-${FR_TARGET_MAX}). ` +
        `Re-run cobolt-decompose-milestones to split oversized milestones.`;
    } else if (warnings.length > 0) {
      const details = warnings.map((m) => `${m.id} has ${m.frCount} FRs`).join(', ');
      message =
        `FR DISTRIBUTION WARNING: ${warnings.length} milestone(s) above target of ${FR_TARGET_MAX} FRs — ${details}. ` +
        `Consider splitting for more manageable delivery. Preferred sizing is ${FR_PREFERRED_MIN}-${FR_TARGET_MAX} FRs.`;
    } else {
      message =
        `FR DISTRIBUTION PASSED: All ${milestoneIds.length} milestones within target (${FR_TARGET_MIN}-${FR_TARGET_MAX} FRs). ` +
        `Preferred sizing is ${FR_PREFERRED_MIN}-${FR_TARGET_MAX} FRs per milestone.`;
    }

    return {
      passed,
      target: { min: FR_TARGET_MIN, max: FR_TARGET_MAX },
      preferredRange: { min: FR_PREFERRED_MIN, max: FR_TARGET_MAX },
      hardLimit: FR_HARD_LIMIT,
      milestones,
      oversized: oversized.map((m) => m.id),
      warnings: warnings.map((m) => m.id),
      message,
    };
  }

  /**
   * Validate whether milestones are decomposed into a healthy story shape.
   * Target: 3-6 stories per milestone, with 1-3 FRs per story.
   *
   * HARD fails (block planning → build):
   *   - avg FRs/story > 3 (milestone under-split, stories too coarse)
   *   - milestone has >=7 FRs spread across <3 stories (also under-split)
   *   - story count > 10 (milestone over-split; 30/milestone incident class — v0.18+ fix)
   *   - avg FRs/story < 0.5 AND story count > 6 (thin stories, work-free splits)
   *
   * WARN (degraded but passes):
   *   - avg FRs/story in (2, 3]
   *   - story count in (6, 10]
   *
   * v0.18+ fix: previously "too many stories" was advisory-only, which let
   * milestones with 30+ stories through because the validator returned
   * passed=true. That propagated to build and created one impl-spec per story
   * in _cobolt-output/latest/build/M{n}/M{n}-story-specs/, blowing up the
   * build round budget.
   * @returns {{
   *   passed: boolean,
   *   targets: object,
   *   milestones: Array<object>,
   *   failing: string[],
   *   warnings: string[],
   *   message: string
   * }}
   */
  validateMilestoneStoryDensity() {
    const STORY_TARGET_MIN = 3;
    const STORY_TARGET_MAX = 6;
    const STORY_HARD_MAX = 10; // v0.18+ hard upper bound
    const FR_PER_STORY_WARNING = 2;
    const FR_PER_STORY_HARD_LIMIT = 3;
    const FR_PER_STORY_THIN_FLOOR = 0.5; // v0.18+ — stories with <0.5 FR avg are work-free
    const LARGE_MILESTONE_FR_THRESHOLD = 7;

    // v0.50+ silent-noop closure (RawDrive042026): the validator's failing=[]
    // return value previously conflated "data is clean" with "data is missing
    // and I couldn't evaluate". Downstream gates (cobolt-story-density-gate)
    // approved on failing.length===0 without distinguishing the two — letting
    // cold-start writes silently pass with no audit log line. The `evidence`
    // field below makes the distinction explicit so callers can defer (vs
    // approve) when there isn't enough on-disk data to evaluate against.
    //
    //   'present' — milestones.md FR map AND story-tracker.json stories both
    //               available; the validator made a real decision.
    //   'partial' — exactly one of the two sources had data; partial evaluation.
    //   'absent'  — neither source had usable data.
    const planningDir = this._findPlanningDir();
    if (!planningDir) {
      return {
        passed: false,
        targets: {
          storyCount: { min: STORY_TARGET_MIN, max: STORY_TARGET_MAX, hardMax: STORY_HARD_MAX },
          frPerStory: {
            warning: FR_PER_STORY_WARNING,
            hardLimit: FR_PER_STORY_HARD_LIMIT,
            thinFloor: FR_PER_STORY_THIN_FLOOR,
          },
          largeMilestoneFrThreshold: LARGE_MILESTONE_FR_THRESHOLD,
        },
        milestones: [],
        failing: [],
        warnings: [],
        evidence: 'absent',
        message: 'STORY DENSITY CHECK FAILED: No planning directory found. Run /cobolt-plan first.',
      };
    }

    const frCounts = getMilestoneFRCounts(this.root);
    const milestonesHasFrData = Object.keys(frCounts).length > 0;

    const tracker = safeReadJson(path.join(planningDir, 'story-tracker.json'));
    if (!Array.isArray(tracker?.stories) || tracker.stories.length === 0) {
      return {
        passed: false,
        targets: {
          storyCount: { min: STORY_TARGET_MIN, max: STORY_TARGET_MAX, hardMax: STORY_HARD_MAX },
          frPerStory: {
            warning: FR_PER_STORY_WARNING,
            hardLimit: FR_PER_STORY_HARD_LIMIT,
            thinFloor: FR_PER_STORY_THIN_FLOOR,
          },
          largeMilestoneFrThreshold: LARGE_MILESTONE_FR_THRESHOLD,
        },
        milestones: [],
        failing: [],
        warnings: [],
        evidence: milestonesHasFrData ? 'partial' : 'absent',
        message:
          'STORY DENSITY CHECK FAILED: story-tracker.json is missing or empty. Generate stories and trackers before validating planning density.',
      };
    }

    const storiesByMilestone = new Map();
    for (const story of tracker.stories) {
      const milestoneId = normalizeMilestoneId(story.milestone || story.milestoneId);
      if (!milestoneId) continue;
      if (!storiesByMilestone.has(milestoneId)) storiesByMilestone.set(milestoneId, []);
      storiesByMilestone.get(milestoneId).push(story);
    }

    const milestoneIds = [...new Set([...Object.keys(frCounts), ...storiesByMilestone.keys()].filter(Boolean))].sort(
      (a, b) => milestoneNumber(a) - milestoneNumber(b),
    );

    if (milestoneIds.length === 0) {
      return {
        passed: false,
        targets: {
          storyCount: { min: STORY_TARGET_MIN, max: STORY_TARGET_MAX, hardMax: STORY_HARD_MAX },
          frPerStory: {
            warning: FR_PER_STORY_WARNING,
            hardLimit: FR_PER_STORY_HARD_LIMIT,
            thinFloor: FR_PER_STORY_THIN_FLOOR,
          },
          largeMilestoneFrThreshold: LARGE_MILESTONE_FR_THRESHOLD,
        },
        milestones: [],
        failing: [],
        warnings: [],
        evidence: 'absent',
        message: 'STORY DENSITY CHECK FAILED: No milestone assignments found in milestones.md or story-tracker.json.',
      };
    }

    const milestones = milestoneIds.map((id) => {
      const stories = storiesByMilestone.get(id) || [];
      const frSet = new Set((frCounts[id] || []).map((frId) => normalizeRequirementLookupId(frId)).filter(Boolean));
      for (const story of stories) {
        for (const frId of extractStoryFrIds(story)) {
          const normalizedFrId = normalizeRequirementLookupId(frId);
          if (normalizedFrId) frSet.add(normalizedFrId);
        }
      }

      const frCount = frSet.size;
      const storyCount = stories.length;
      const avgFrPerStory = storyCount > 0 ? Number((frCount / storyCount).toFixed(2)) : null;
      const suggestedMinStories =
        frCount <= 2 ? Math.max(1, frCount) : Math.max(STORY_TARGET_MIN, Math.ceil(frCount / FR_PER_STORY_HARD_LIMIT));

      const failures = [];
      const advisories = [];

      if (frCount > 0 && storyCount === 0) {
        failures.push('no stories assigned');
      }
      if (avgFrPerStory !== null && avgFrPerStory > FR_PER_STORY_HARD_LIMIT) {
        failures.push(`avg ${avgFrPerStory} FR/story exceeds hard limit ${FR_PER_STORY_HARD_LIMIT}`);
      } else if (avgFrPerStory !== null && avgFrPerStory > FR_PER_STORY_WARNING) {
        advisories.push(`avg ${avgFrPerStory} FR/story is above preferred max ${FR_PER_STORY_WARNING}`);
      }
      if (frCount >= LARGE_MILESTONE_FR_THRESHOLD && storyCount < STORY_TARGET_MIN) {
        failures.push(`${frCount} FRs are spread across only ${storyCount} stories`);
      }
      // v0.18+ fix — excess stories (over-split) was previously advisory-only.
      // 30 stories/milestone would pass because the validator never failed on
      // excess. Now: hard fail above STORY_HARD_MAX, warn in (MAX, HARD_MAX].
      if (storyCount > STORY_HARD_MAX) {
        failures.push(
          `${storyCount} stories exceeds hard upper bound ${STORY_HARD_MAX} (milestone is over-split; target ${STORY_TARGET_MIN}-${STORY_TARGET_MAX})`,
        );
      } else if (storyCount > STORY_TARGET_MAX) {
        advisories.push(
          `${storyCount} stories exceeds preferred milestone range ${STORY_TARGET_MIN}-${STORY_TARGET_MAX}`,
        );
      }
      // v0.18+ — thin-story check: average <0.5 FR/story with many stories means
      // stories are work-free splits. Excludes small-milestone edge cases
      // (<=6 stories) where avg can legitimately be low.
      if (avgFrPerStory !== null && avgFrPerStory < FR_PER_STORY_THIN_FLOOR && storyCount > STORY_TARGET_MAX) {
        failures.push(
          `avg ${avgFrPerStory} FR/story below thin-story floor ${FR_PER_STORY_THIN_FLOOR} with ${storyCount} stories — likely work-free splits`,
        );
      }

      const status = failures.length > 0 ? 'failed' : advisories.length > 0 ? 'warning' : 'ok';
      const overSplit = failures.some((failure) => /exceeds hard upper bound|below thin-story floor/i.test(failure));
      const recommendation =
        status === 'failed' && overSplit
          ? `Merge thin sibling stories or re-scope ${id} into fewer feature slices. Keep at most ${STORY_HARD_MAX} stories while preserving no more than ${FR_PER_STORY_HARD_LIMIT} FRs per story.`
          : status === 'failed'
            ? `Split coarse stories or re-scope ${id}. Aim for at least ${suggestedMinStories} stories and no more than ${FR_PER_STORY_HARD_LIMIT} FRs per story.`
            : status === 'warning'
              ? `Tighten ${id} toward ${STORY_TARGET_MIN}-${STORY_TARGET_MAX} stories and keep stories closer to 1-${FR_PER_STORY_WARNING} FRs each.`
              : null;

      return {
        id,
        frCount,
        storyCount,
        avgFrPerStory,
        frIds: [...frSet].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
        storyIds: stories
          .map((story) => normalizeStoryId(story.id || story.storyId))
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
        suggestedMinStories,
        failures,
        advisories,
        status,
        recommendation,
      };
    });

    const failing = milestones.filter((milestone) => milestone.status === 'failed').map((milestone) => milestone.id);
    const warnings = milestones.filter((milestone) => milestone.status === 'warning').map((milestone) => milestone.id);
    const passed = failing.length === 0;

    let message;
    if (failing.length > 0) {
      const details = milestones
        .filter((milestone) => milestone.status === 'failed')
        .map((milestone) => `${milestone.id} (${milestone.frCount} FRs/${milestone.storyCount} stories)`)
        .join(', ');
      message =
        `STORY DENSITY FAILED: ${failing.length} milestone(s) have invalid story shape — ${details}. ` +
        `Target is ${STORY_TARGET_MIN}-${STORY_TARGET_MAX} stories per milestone with 1-${FR_PER_STORY_HARD_LIMIT} FRs per story. ` +
        `Hard bounds: 1..${STORY_HARD_MAX} stories; <=${FR_PER_STORY_HARD_LIMIT} FRs/story; >=${FR_PER_STORY_THIN_FLOOR} FRs/story when >${STORY_TARGET_MAX} stories.`;
    } else if (warnings.length > 0) {
      const details = milestones
        .filter((milestone) => milestone.status === 'warning')
        .map((milestone) => `${milestone.id} (${milestone.frCount} FRs/${milestone.storyCount} stories)`)
        .join(', ');
      message =
        `STORY DENSITY WARNING: ${warnings.length} milestone(s) are technically valid but dense — ${details}. ` +
        `Preferred range is ${STORY_TARGET_MIN}-${STORY_TARGET_MAX} stories per milestone and <=${FR_PER_STORY_WARNING} FRs per story.`;
    } else {
      message =
        `STORY DENSITY PASSED: All ${milestones.length} milestones are within the preferred story shape ` +
        `(${STORY_TARGET_MIN}-${STORY_TARGET_MAX} stories, <=${FR_PER_STORY_WARNING} FRs per story).`;
    }

    // Evidence on the success path: tracker is non-empty (we got past the
    // earlier guard) — so we always have story data here. milestonesHasFrData
    // tells us whether milestones.md also contributed FR assignments.
    const evidence = milestonesHasFrData ? 'present' : 'partial';

    return {
      passed,
      targets: {
        storyCount: { min: STORY_TARGET_MIN, max: STORY_TARGET_MAX, hardMax: STORY_HARD_MAX },
        frPerStory: {
          warning: FR_PER_STORY_WARNING,
          hardLimit: FR_PER_STORY_HARD_LIMIT,
          thinFloor: FR_PER_STORY_THIN_FLOOR,
        },
        largeMilestoneFrThreshold: LARGE_MILESTONE_FR_THRESHOLD,
      },
      milestones,
      failing,
      warnings,
      evidence,
      message,
    };
  }

  /**
   * Estimate weighted milestone size using requirement semantics, not just FR count.
   * Heavy domains like auth, payments, compliance, AI, migration, and integrations
   * accrue additional delivery points on top of the FR count baseline.
   */
  validateWeightedMilestoneSizing() {
    const POINT_TARGET_MIN = 8;
    const POINT_TARGET_MAX = 18;
    const POINT_HARD_LIMIT = 24;
    const AVG_WARNING_LIMIT = 1.75;
    const AVG_HARD_LIMIT = 2.5;
    const MAX_ADDITIONAL_PER_FR = 2.5;

    // v0.50+ silent-noop closure (RawDrive042026). See the same comment block
    // on validateMilestoneStoryDensity above for the evidence semantics.
    const planningDir = this._findPlanningDir();
    if (!planningDir) {
      return {
        passed: false,
        thresholds: {
          preferredRange: { min: POINT_TARGET_MIN, max: POINT_TARGET_MAX },
          hardLimit: POINT_HARD_LIMIT,
          avgWarningLimit: AVG_WARNING_LIMIT,
          avgHardLimit: AVG_HARD_LIMIT,
        },
        milestones: [],
        failing: [],
        warnings: [],
        evidence: 'absent',
        message: 'WEIGHTED SIZING FAILED: No planning directory found. Run /cobolt-plan first.',
      };
    }

    const requirementMap = readRequirementInventoryFromPlanningDir(planningDir);
    const titleMap = getMilestoneTitleMap(planningDir);
    const milestoneFrMap = getMilestoneFrIdMap(planningDir, this.root);
    const milestonesHasFrData = Object.keys(getMilestoneFRCounts(planningDir)).length > 0;
    const trackerHasStories = readStoryTrackerStories(planningDir).length > 0;
    const milestoneIds = [...milestoneFrMap.keys()].sort((a, b) => milestoneNumber(a) - milestoneNumber(b));

    if (milestoneIds.length === 0) {
      return {
        passed: false,
        thresholds: {
          preferredRange: { min: POINT_TARGET_MIN, max: POINT_TARGET_MAX },
          hardLimit: POINT_HARD_LIMIT,
          avgWarningLimit: AVG_WARNING_LIMIT,
          avgHardLimit: AVG_HARD_LIMIT,
        },
        milestones: [],
        failing: [],
        warnings: [],
        evidence: 'absent',
        message: 'WEIGHTED SIZING FAILED: No milestone FR assignments found in milestones.md or story-tracker.json.',
      };
    }

    const milestones = milestoneIds.map((id) => {
      const frIds = sortUniqueIds([...milestoneFrMap.get(id)]);
      const riskCategoryCounts = new Map();
      const frBreakdown = frIds.map((frId) => {
        const requirement = requirementMap.get(frId) || null;
        const requirementText = [requirement?.title, requirement?.description, requirement?.body]
          .filter(Boolean)
          .join('\n');
        let additionalPoints = 0;
        const categories = [];

        for (const rule of DELIVERY_POINT_RULES) {
          if (!rule.pattern.test(requirementText)) continue;
          additionalPoints += rule.weight;
          categories.push(rule.label);
          riskCategoryCounts.set(rule.label, (riskCategoryCounts.get(rule.label) || 0) + 1);
        }

        const cappedAdditional = Math.min(additionalPoints, MAX_ADDITIONAL_PER_FR);
        const deliveryPoints = Number((1 + cappedAdditional).toFixed(2));
        return {
          id: frId,
          title: requirement?.title || null,
          deliveryPoints,
          categories,
        };
      });

      const deliveryPoints = Number(
        frBreakdown.reduce((sum, requirement) => sum + Number(requirement.deliveryPoints || 0), 0).toFixed(2),
      );
      const avgPointsPerFr = frBreakdown.length > 0 ? Number((deliveryPoints / frBreakdown.length).toFixed(2)) : 0;
      const dominantRisks = [...riskCategoryCounts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 3)
        .map(([label]) => label);

      const failures = [];
      const advisories = [];

      if (deliveryPoints > POINT_HARD_LIMIT) {
        failures.push(`${deliveryPoints} delivery points exceeds hard limit ${POINT_HARD_LIMIT}`);
      } else if (deliveryPoints > POINT_TARGET_MAX) {
        advisories.push(
          `${deliveryPoints} delivery points exceeds preferred range ${POINT_TARGET_MIN}-${POINT_TARGET_MAX}`,
        );
      }

      if (frBreakdown.length >= 4 && avgPointsPerFr > AVG_HARD_LIMIT) {
        failures.push(`average ${avgPointsPerFr} delivery points/FR exceeds hard limit ${AVG_HARD_LIMIT}`);
      } else if (frBreakdown.length >= 4 && avgPointsPerFr > AVG_WARNING_LIMIT) {
        advisories.push(`average ${avgPointsPerFr} delivery points/FR is above preferred max ${AVG_WARNING_LIMIT}`);
      }

      const status = failures.length > 0 ? 'failed' : advisories.length > 0 ? 'warning' : 'ok';
      const recommendation =
        status === 'failed'
          ? `Split ${id} into smaller delivery slices or peel off the highest-risk requirements. Target <=${POINT_TARGET_MAX} delivery points before build.`
          : status === 'warning'
            ? `Review ${id} for heavy domains like ${dominantRisks.join(', ') || 'cross-cutting work'} and consider an earlier split before implementation starts.`
            : null;

      return {
        id,
        title: titleMap[id] || '',
        frCount: frBreakdown.length,
        frIds,
        deliveryPoints,
        avgPointsPerFr,
        dominantRisks,
        frBreakdown,
        failures,
        advisories,
        status,
        recommendation,
      };
    });

    const failing = milestones.filter((milestone) => milestone.status === 'failed').map((milestone) => milestone.id);
    const warnings = milestones.filter((milestone) => milestone.status === 'warning').map((milestone) => milestone.id);
    const passed = failing.length === 0;

    let message;
    if (failing.length > 0) {
      message =
        `WEIGHTED SIZING FAILED: ${failing.length} milestone(s) are too heavy by delivery points — ${milestones
          .filter((milestone) => milestone.status === 'failed')
          .map((milestone) => `${milestone.id} (${milestone.deliveryPoints} points)`)
          .join(', ')}. ` +
        `Preferred range is ${POINT_TARGET_MIN}-${POINT_TARGET_MAX} delivery points with a hard limit of ${POINT_HARD_LIMIT}.`;
    } else if (warnings.length > 0) {
      message = `WEIGHTED SIZING WARNING: ${warnings.length} milestone(s) are within FR caps but still heavy — ${milestones
        .filter((milestone) => milestone.status === 'warning')
        .map((milestone) => `${milestone.id} (${milestone.deliveryPoints} points)`)
        .join(', ')}. Review risk-heavy milestones before build.`;
    } else {
      message = `WEIGHTED SIZING PASSED: All ${milestones.length} milestones are within the preferred delivery-point range (${POINT_TARGET_MIN}-${POINT_TARGET_MAX}).`;
    }

    // Weighted sizing CAN evaluate from milestones.md alone (no tracker needed
    // because each FR carries baseline + risk weight from the requirement
    // inventory). Evidence is 'present' when the FR map came from milestones.md
    // (the canonical source); 'partial' when only the tracker contributed FR
    // assignments; 'absent' is unreachable here (we returned earlier above).
    const evidence = milestonesHasFrData ? 'present' : trackerHasStories ? 'partial' : 'partial';

    return {
      passed,
      thresholds: {
        preferredRange: { min: POINT_TARGET_MIN, max: POINT_TARGET_MAX },
        hardLimit: POINT_HARD_LIMIT,
        avgWarningLimit: AVG_WARNING_LIMIT,
        avgHardLimit: AVG_HARD_LIMIT,
      },
      milestones,
      failing,
      warnings,
      evidence,
      message,
    };
  }

  /**
   * Validate epic/story shaping so epics remain user-visible delivery slices.
   * Warn on oversized epics and fail epics that still behave like technical buckets.
   */
  validateEpicDensity() {
    const STORY_TARGET_MIN = 2;
    const STORY_TARGET_MAX = 4;
    const STORY_HARD_LIMIT = 6;
    const FR_PER_STORY_WARNING = 2;
    const FR_PER_STORY_HARD_LIMIT = 3;
    const ACCEPTANCE_WARNING = 5;

    // v0.53+ — three-state evidence semantics, mirroring validateMilestoneStoryDensity.
    // Lets PreToolUse callers (cobolt-story-density-gate) distinguish "no failing
    // epics, real PASS" from "couldn't evaluate, defer". Cold-start writes used to
    // approve trivially because failing=[] was the same code path for both.
    const planningDir = this._findPlanningDir();
    if (!planningDir) {
      return {
        passed: false,
        thresholds: {
          storiesPerEpic: { min: STORY_TARGET_MIN, max: STORY_TARGET_MAX, hardLimit: STORY_HARD_LIMIT },
          frPerStory: { warning: FR_PER_STORY_WARNING, hardLimit: FR_PER_STORY_HARD_LIMIT },
          acceptanceCriteriaWarning: ACCEPTANCE_WARNING,
        },
        epics: [],
        failing: [],
        warnings: [],
        evidence: 'absent',
        message: 'EPIC DENSITY FAILED: No planning directory found. Run /cobolt-plan first.',
      };
    }

    const epicsPath = path.join(planningDir, 'epics.md');
    const trackerStories = readStoryTrackerStories(planningDir);
    const trackerStoriesByEpic = new Map();
    for (const story of trackerStories) {
      const epicId = normalizeEpicPlanId(story.epic || story.epicId);
      if (!epicId) continue;
      if (!trackerStoriesByEpic.has(epicId)) trackerStoriesByEpic.set(epicId, []);
      trackerStoriesByEpic.get(epicId).push(story);
    }
    const trackerHasData = trackerStoriesByEpic.size > 0;

    if (!fs.existsSync(epicsPath)) {
      return {
        passed: false,
        thresholds: {
          storiesPerEpic: { min: STORY_TARGET_MIN, max: STORY_TARGET_MAX, hardLimit: STORY_HARD_LIMIT },
          frPerStory: { warning: FR_PER_STORY_WARNING, hardLimit: FR_PER_STORY_HARD_LIMIT },
          acceptanceCriteriaWarning: ACCEPTANCE_WARNING,
        },
        epics: [],
        failing: [],
        warnings: [],
        evidence: trackerHasData ? 'partial' : 'absent',
        message: 'EPIC DENSITY FAILED: epics.md is missing. Generate epics and stories before validating epic shape.',
      };
    }

    const parsedEpics = parseEpicPlan(fs.readFileSync(epicsPath, 'utf8'));
    const epicsHasData = parsedEpics.length > 0;

    if (parsedEpics.length === 0 && trackerStoriesByEpic.size === 0) {
      return {
        passed: false,
        thresholds: {
          storiesPerEpic: { min: STORY_TARGET_MIN, max: STORY_TARGET_MAX, hardLimit: STORY_HARD_LIMIT },
          frPerStory: { warning: FR_PER_STORY_WARNING, hardLimit: FR_PER_STORY_HARD_LIMIT },
          acceptanceCriteriaWarning: ACCEPTANCE_WARNING,
        },
        epics: [],
        failing: [],
        warnings: [],
        evidence: 'absent',
        message: 'EPIC DENSITY FAILED: No epic definitions were found in epics.md.',
      };
    }

    const epicIndex = new Map(parsedEpics.map((epic) => [epic.id, epic]));
    for (const [epicId] of trackerStoriesByEpic.entries()) {
      if (epicIndex.has(epicId)) continue;
      epicIndex.set(epicId, {
        id: epicId,
        title: epicId,
        milestone: null,
        requirementIds: [],
        frIds: [],
        stories: [],
      });
    }

    const epics = [...epicIndex.values()]
      .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
      .map((epic) => {
        const parsedStoriesById = new Map((epic.stories || []).map((story) => [story.id, story]));
        const trackerEpicStories = trackerStoriesByEpic.get(epic.id) || [];
        for (const story of trackerEpicStories) {
          const storyId = normalizeStoryId(story.id || story.storyId);
          if (!storyId) continue;
          if (!parsedStoriesById.has(storyId)) {
            parsedStoriesById.set(storyId, {
              id: storyId,
              title: String(story.title || story.name || storyId),
              requirementIds: [],
              frIds: [],
              acceptanceCriteriaCount: 0,
            });
          }
        }

        const storySummaries = [...parsedStoriesById.values()]
          .map((story) => {
            const trackerStory = trackerEpicStories.find(
              (candidate) => normalizeStoryId(candidate.id || candidate.storyId) === story.id,
            );
            const storyFile = resolveStoryFile(story.id, planningDir, { planningDir });
            const storyFileContent = storyFile && fs.existsSync(storyFile) ? fs.readFileSync(storyFile, 'utf8') : '';
            const storyRequirementIds = sortUniqueIds([
              ...(story.requirementIds || []),
              ...(trackerStory?.requirementIds || []),
              ...extractStoryFrIds(trackerStory),
              ...extractRequirementReferences(storyFileContent),
            ]);
            const frIds = storyRequirementIds.filter((id) => requirementPrefix(id) === 'FR');
            const acceptanceCriteriaCount = Math.max(
              story.acceptanceCriteriaCount || 0,
              countAcceptanceCriteria(storyFileContent),
            );

            const failures = [];
            const advisories = [];
            if (frIds.length > FR_PER_STORY_HARD_LIMIT && acceptanceCriteriaCount > ACCEPTANCE_WARNING) {
              failures.push(
                `${story.id} spans ${frIds.length} FRs with ${acceptanceCriteriaCount} acceptance criteria`,
              );
            } else if (frIds.length > FR_PER_STORY_HARD_LIMIT || acceptanceCriteriaCount > ACCEPTANCE_WARNING) {
              advisories.push(
                `${story.id} is dense (${frIds.length} FRs, ${acceptanceCriteriaCount} acceptance criteria)`,
              );
            }

            return {
              id: story.id,
              title: trackerStory?.title || story.title || story.id,
              frIds,
              frCount: frIds.length,
              acceptanceCriteriaCount,
              failures,
              advisories,
            };
          })
          .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));

        const epicFrIds = sortUniqueIds([
          ...(epic.frIds || []),
          ...storySummaries.flatMap((story) => story.frIds || []),
        ]);
        const storyCount = storySummaries.length;
        const frCount = epicFrIds.length;
        const avgFrPerStory = storyCount > 0 ? Number((frCount / storyCount).toFixed(2)) : null;
        const failures = [];
        const advisories = [];

        const titleReasons = evaluateTitleAntiPatterns(epic.title, EPIC_TECHNICAL_BUCKET_PATTERNS, {
          conjunctionThreshold: 2,
          flagMultiArea: true,
        });
        if (titleReasons.length > 0) failures.push(...titleReasons);

        if (frCount > 0 && storyCount === 0) {
          failures.push('epic has requirements but no stories');
        }
        if (storyCount > STORY_HARD_LIMIT) {
          failures.push(`${storyCount} stories exceeds hard limit ${STORY_HARD_LIMIT}`);
        } else if (storyCount > STORY_TARGET_MAX) {
          advisories.push(`${storyCount} stories exceeds preferred range ${STORY_TARGET_MIN}-${STORY_TARGET_MAX}`);
        } else if (storyCount > 0 && storyCount < STORY_TARGET_MIN) {
          advisories.push(
            `only ${storyCount} stories; most epics should land in the ${STORY_TARGET_MIN}-${STORY_TARGET_MAX} range`,
          );
        }

        if (avgFrPerStory !== null && avgFrPerStory > FR_PER_STORY_HARD_LIMIT) {
          failures.push(`average ${avgFrPerStory} FR/story exceeds hard limit ${FR_PER_STORY_HARD_LIMIT}`);
        } else if (avgFrPerStory !== null && avgFrPerStory > FR_PER_STORY_WARNING) {
          advisories.push(`average ${avgFrPerStory} FR/story is above preferred max ${FR_PER_STORY_WARNING}`);
        }

        for (const story of storySummaries) {
          failures.push(...story.failures);
          advisories.push(...story.advisories);
        }

        const status = failures.length > 0 ? 'failed' : advisories.length > 0 ? 'warning' : 'ok';
        const recommendation =
          status === 'failed'
            ? `Split ${epic.id} into narrower user-facing epics or decompose the densest stories before build starts.`
            : status === 'warning'
              ? `Trim ${epic.id} toward ${STORY_TARGET_MIN}-${STORY_TARGET_MAX} stories and keep stories closer to 1-${FR_PER_STORY_WARNING} FRs each.`
              : null;

        return {
          id: epic.id,
          title: epic.title,
          milestone: epic.milestone || null,
          storyCount,
          frCount,
          avgFrPerStory,
          storySummaries,
          failures: [...new Set(failures)],
          advisories: [...new Set(advisories)],
          status,
          recommendation,
        };
      });

    const failing = epics.filter((epic) => epic.status === 'failed').map((epic) => epic.id);
    const warnings = epics.filter((epic) => epic.status === 'warning').map((epic) => epic.id);
    const passed = failing.length === 0;

    let message;
    if (failing.length > 0) {
      message =
        `EPIC DENSITY FAILED: ${failing.length} epic(s) are too coarse or bucket-like — ${epics
          .filter((epic) => epic.status === 'failed')
          .map((epic) => `${epic.id} (${epic.storyCount} stories, ${epic.frCount} FRs)`)
          .join(', ')}. ` +
        `Target is ${STORY_TARGET_MIN}-${STORY_TARGET_MAX} stories per epic with <=${FR_PER_STORY_HARD_LIMIT} FRs/story.`;
    } else if (warnings.length > 0) {
      message = `EPIC DENSITY WARNING: ${warnings.length} epic(s) are technically valid but dense — ${epics
        .filter((epic) => epic.status === 'warning')
        .map((epic) => `${epic.id} (${epic.storyCount} stories, ${epic.frCount} FRs)`)
        .join(', ')}. Review epic shape before implementation.`;
    } else {
      message = `EPIC DENSITY PASSED: All ${epics.length} epics look like focused delivery slices.`;
    }

    const evidence = epicsHasData && trackerHasData ? 'present' : epicsHasData || trackerHasData ? 'partial' : 'absent';

    return {
      passed,
      thresholds: {
        storiesPerEpic: { min: STORY_TARGET_MIN, max: STORY_TARGET_MAX, hardLimit: STORY_HARD_LIMIT },
        frPerStory: { warning: FR_PER_STORY_WARNING, hardLimit: FR_PER_STORY_HARD_LIMIT },
        acceptanceCriteriaWarning: ACCEPTANCE_WARNING,
      },
      epics,
      failing,
      warnings,
      evidence,
      message,
    };
  }

  /**
   * Lint milestone titles for department-bucket and technical-layer anti-patterns.
   * Warnings do not block the build, but they should trigger a naming/scope review.
   * @returns {{
   *   passed: boolean,
   *   blocking: boolean,
   *   status: string,
   *   milestones: Array<object>,
   *   warnings: string[],
   *   message: string
   * }}
   */
  validateMilestoneTitles() {
    const titleMap = getMilestoneTitleMap(this.root);
    const milestoneIds = Object.keys(titleMap).sort((a, b) => milestoneNumber(a) - milestoneNumber(b));

    if (milestoneIds.length === 0) {
      return {
        passed: false,
        blocking: true,
        status: 'failed',
        milestones: [],
        warnings: [],
        message: 'MILESTONE TITLE LINT FAILED: No milestone titles found in milestones.md.',
      };
    }
    const milestones = milestoneIds.map((id) => {
      const title = String(titleMap[id] || '').trim();
      const reasons = evaluateTitleAntiPatterns(title, DELIVERY_SLICE_TITLE_ANTI_PATTERNS, {
        conjunctionThreshold: 2,
        flagMultiArea: true,
      });

      return {
        id,
        title,
        reasons,
        status: reasons.length > 0 ? 'warning' : 'ok',
      };
    });

    const warnings = milestones.filter((milestone) => milestone.status === 'warning');
    const message =
      warnings.length > 0
        ? `MILESTONE TITLE LINT WARNING: ${warnings.length} title(s) look bucket-like — ${warnings
            .slice(0, 4)
            .map((milestone) => `${milestone.id} "${milestone.title}"`)
            .join(', ')}. Prefer demoable user outcomes over department/layer labels.`
        : `MILESTONE TITLE LINT PASSED: All ${milestones.length} milestone titles read like focused delivery slices.`;

    return {
      passed: warnings.length === 0,
      blocking: false,
      status: warnings.length > 0 ? 'warning' : 'pass',
      milestones,
      warnings: warnings.map((milestone) => milestone.id),
      message,
    };
  }

  rebalanceMilestones(options = {}) {
    const planningDir = this._findPlanningDir();
    if (!planningDir) {
      return {
        passed: false,
        needsRebalance: false,
        writeRequested: options.write === true,
        analyses: {
          frDistribution: { message: 'No planning directory found.' },
          storyDensity: { message: 'No planning directory found.' },
          weightedSizing: { message: 'No planning directory found.' },
          epicDensity: { message: 'No planning directory found.' },
          blockedTasks: { message: 'No planning directory found.' },
        },
        message: 'MILESTONE REBALANCE FAILED: No planning directory found. Run /cobolt-plan first.',
      };
    }

    const milestonesDoc = getMilestonesDocument(planningDir);
    const dist = this.validateMilestoneFRDistribution();
    const density = this.validateMilestoneStoryDensity();
    const weighted = this.validateWeightedMilestoneSizing();
    const epicDensity = this.validateEpicDensity();
    const blocked = this.validateBlockedTasks();

    const needsRebalance =
      !dist.passed ||
      !density.passed ||
      !weighted.passed ||
      !epicDensity.passed ||
      (blocked.skipped !== true && blocked.passed !== true);

    const report = {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      source: 'cobolt-preflight rebalance-milestones',
      status: needsRebalance ? 'warning' : 'pass',
      inputs: {
        milestonesMd: describeArtifactFile(this.root, path.join(planningDir, 'milestones.md')),
        epicsMd: describeArtifactFile(this.root, path.join(planningDir, 'epics.md')),
        storyTracker: describeArtifactFile(this.root, path.join(planningDir, 'story-tracker.json')),
        blockedTaskRegistry: describeArtifactFile(
          this.root,
          path.join(planningDir, 'cross-milestone-blocked-tasks.json'),
        ),
      },
      summary: {
        oversizedMilestones: dist.oversized || [],
        denseMilestones: density.failing || [],
        heavyMilestones: weighted.failing || [],
        coarseEpics: epicDensity.failing || [],
        suggestedMoves: blocked.suggestedMoves || [],
      },
      analyses: {
        frDistribution: dist,
        storyDensity: density,
        weightedSizing: weighted,
        epicDensity,
        blockedTasks: blocked,
      },
      artifacts: {},
      message: needsRebalance
        ? 'Milestone plan needs rebalancing. Review the generated report for split candidates, story moves, and dense epics.'
        : 'Milestone plan is already within the configured sizing and density targets.',
    };

    if (options.write === true) {
      const reportPath = path.join(planningDir, 'milestone-rebalance-plan.json');
      const markdownPath = path.join(planningDir, 'milestone-rebalance-plan.md');
      const versioned = nextVersionedMilestonesPath(planningDir);
      const storyMoveLines =
        Array.isArray(blocked.suggestedMoves) && blocked.suggestedMoves.length > 0
          ? blocked.suggestedMoves.map(
              (move) =>
                `- Move ${move.storyLabel} (${move.storyId || 'story'}) from ${move.fromMilestone} to ${move.toMilestone}: ${move.reason}`,
            )
          : ['- No cross-milestone story moves were suggested.'];

      const oversizedLines =
        dist.milestones
          ?.filter((milestone) => milestone.status === 'oversized' || milestone.status === 'warning')
          .map(
            (milestone) =>
              `- ${milestone.id}: ${milestone.frCount} FRs. ${milestone.status === 'oversized' ? 'Must split.' : 'Consider splitting.'}`,
          ) || [];
      const denseLines =
        density.milestones
          ?.filter((milestone) => milestone.status !== 'ok')
          .map((milestone) =>
            `- ${milestone.id}: ${milestone.frCount} FRs across ${milestone.storyCount} stories (${milestone.avgFrPerStory?.toFixed(2) || 'n/a'} FR/story). ${milestone.recommendation || ''}`.trim(),
          ) || [];
      const weightedLines =
        weighted.milestones
          ?.filter((milestone) => milestone.status !== 'ok')
          .map((milestone) =>
            `- ${milestone.id}: ${milestone.deliveryPoints} delivery points (${milestone.dominantRisks.join(', ') || 'general complexity'}). ${milestone.recommendation || ''}`.trim(),
          ) || [];
      const epicLines =
        epicDensity.epics
          ?.filter((epic) => epic.status !== 'ok')
          .map((epic) =>
            `- ${epic.id}: ${epic.storyCount} stories, ${epic.frCount} FRs. ${epic.recommendation || epic.failures[0] || epic.advisories[0] || ''}`.trim(),
          ) || [];

      const markdown = [
        '# Milestone Rebalance Plan',
        '',
        `Generated: ${report.generatedAt}`,
        `Planning directory: ${path.relative(this.root, planningDir).replaceAll('\\', '/')}`,
        '',
        '## Summary',
        '',
        `- FR distribution: ${dist.message}`,
        `- Story density: ${density.message}`,
        `- Weighted sizing: ${weighted.message}`,
        `- Epic density: ${epicDensity.message}`,
        `- Blocked-task regrouping: ${blocked.message}`,
        '',
        '## Milestone Split Candidates',
        '',
        ...(oversizedLines.length > 0 ? oversizedLines : ['- No milestone FR-count split candidates were found.']),
        '',
        '## Story Reshaping Candidates',
        '',
        ...(denseLines.length > 0 ? denseLines : ['- No milestone story-density reshaping candidates were found.']),
        '',
        '## Heavy Milestones',
        '',
        ...(weightedLines.length > 0 ? weightedLines : ['- No weighted-size hotspots were found.']),
        '',
        '## Epic Reshaping Candidates',
        '',
        ...(epicLines.length > 0 ? epicLines : ['- No epic-density hotspots were found.']),
        '',
        '## Suggested Story Moves',
        '',
        ...storyMoveLines,
        '',
      ].join('\n');

      const versionedContent = [
        String(milestonesDoc?.content || '# Milestones'),
        '',
        '## Rebalance Proposal',
        '',
        `Source report: ${path.basename(markdownPath)}`,
        '',
        '### Proposed Changes',
        '',
        ...(oversizedLines.length > 0 ? oversizedLines : ['- No milestone-count changes suggested.']),
        ...(denseLines.length > 0 ? denseLines : ['- No story-density changes suggested.']),
        ...(weightedLines.length > 0 ? weightedLines : ['- No weighted-size changes suggested.']),
        ...(epicLines.length > 0 ? epicLines : ['- No epic reshaping changes suggested.']),
        '',
        '### Proposed Story Moves',
        '',
        ...storyMoveLines,
        '',
      ].join('\n');

      report.artifacts = {
        json: path.relative(this.root, reportPath).replaceAll('\\', '/'),
        markdown: path.relative(this.root, markdownPath).replaceAll('\\', '/'),
        milestonesVersion: path.relative(this.root, versioned.path).replaceAll('\\', '/'),
      };
      report.message += ` Artifacts written: ${report.artifacts.json}, ${report.artifacts.markdown}, ${report.artifacts.milestonesVersion}.`;
      atomicWrite(markdownPath, `${markdown}\n`, 'utf8');
      atomicWrite(versioned.path, `${versionedContent}\n`, 'utf8');
      atomicWrite(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }

    return {
      ...report,
      passed: true,
      needsRebalance,
      writeRequested: options.write === true,
    };
  }

  context(skill, options = {}) {
    if (!this.deps) {
      return {
        skill,
        milestone: normalizeMilestoneId(options.milestone),
        planningDir: null,
        summary: {
          requiredPresent: 0,
          requiredMissing: 0,
          optionalPresent: 0,
          optionalMissing: 0,
          totalMilestones: 0,
          totalStories: 0,
          totalTasks: 0,
        },
        artifacts: { required: [], optional: [] },
        stories: [],
        tasks: [],
        storyCoverage: getStoryCoverage(this.root),
        warnings: ['artifact-dependencies.json not found'],
      };
    }

    const { skill: resolvedSkill, skillDef } = this._resolveSkill(skill);
    if (!skillDef) {
      return {
        skill,
        milestone: normalizeMilestoneId(options.milestone),
        planningDir: this._findPlanningDir(),
        summary: {
          requiredPresent: 0,
          requiredMissing: 0,
          optionalPresent: 0,
          optionalMissing: 0,
          totalMilestones: getMilestoneIds(this.root).length,
          totalStories: 0,
          totalTasks: 0,
        },
        artifacts: { required: [], optional: [] },
        stories: [],
        tasks: [],
        storyCoverage: getStoryCoverage(this.root, { milestone: options.milestone }),
        warnings: [`Unknown skill '${skill}'`],
      };
    }

    const milestone = normalizeMilestoneId(options.milestone);
    const required = (skillDef.requires || []).map((artifactId) =>
      this._decorateArtifactResult(
        skillDef.requireCompleteStoryCoverage && artifactId === 'story-file'
          ? this._checkStoryCoverageArtifact()
          : this._checkRequiredArtifact(artifactId),
      ),
    );
    const optional = (skillDef.optionalContext || []).map((artifactId) =>
      this._decorateArtifactResult(this._checkArtifact(artifactId)),
    );

    const planningDir = this._findPlanningDir();
    const storyCoverage = getStoryCoverage(this.root, { milestone, planningDir });
    const tracker = planningDir ? safeReadJson(path.join(planningDir, 'story-tracker.json')) : null;
    const allStories = Array.isArray(tracker?.stories) ? tracker.stories : [];
    const stories = allStories
      .filter((story) => !milestone || normalizeMilestoneId(story.milestone) === milestone)
      .map((story) => {
        const storyId = normalizeStoryId(story.id);
        const resolvedStoryPath = story.storyFile
          ? path.isAbsolute(story.storyFile)
            ? story.storyFile
            : planningDir
              ? path.join(planningDir, story.storyFile)
              : null
          : resolveStoryFile(storyId, planningDir || this.root, { planningDir });
        const relativeStoryPath =
          resolvedStoryPath && planningDir
            ? path.relative(planningDir, resolvedStoryPath).replaceAll('\\', '/')
            : story.storyFile || null;

        return {
          ...story,
          id: storyId,
          storyFile: relativeStoryPath,
          absoluteStoryFile: resolvedStoryPath || null,
        };
      });

    const tasks = stories.flatMap((story) =>
      (story.tasks || []).map((task) => ({
        ...task,
        storyId: story.id,
        epic: story.epic || null,
        milestone: story.milestone || null,
      })),
    );

    const warnings = [];
    if (required.some((artifact) => !artifact.exists)) {
      warnings.push(
        `Missing required artifacts: ${required
          .filter((artifact) => !artifact.exists)
          .map((artifact) => artifact.id)
          .join(', ')}`,
      );
    }
    if (storyCoverage.expectedStoryIds.length > 0 && storyCoverage.missingStoryIds.length > 0) {
      warnings.push(`Incomplete story coverage: ${storyCoverage.missingStoryIds.join(', ')}`);
    }
    if (milestone && stories.length === 0) {
      warnings.push(`No stories found in story-tracker.json for ${milestone}`);
    }

    return {
      skill: resolvedSkill,
      originalSkill: skill,
      milestone,
      planningDir,
      artifacts: { required, optional },
      storyCoverage,
      stories,
      tasks,
      summary: {
        requiredPresent: required.filter((artifact) => artifact.exists).length,
        requiredMissing: required.filter((artifact) => !artifact.exists).length,
        optionalPresent: optional.filter((artifact) => artifact.exists).length,
        optionalMissing: optional.filter((artifact) => !artifact.exists).length,
        totalMilestones: getMilestoneIds(planningDir || this.root).length,
        totalStories: stories.length,
        totalTasks: tasks.length,
      },
      warnings,
    };
  }

  /**
   * Find the best readable planning directory for downstream checks.
   * Prefers the current latest run when it contains a real planning packet,
   * then recovers the last valid planning run when latest only has partial data.
   */
  _findPlanningDir() {
    const hasPlanningArtifacts = (dir) => {
      try {
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
        const entries = fs.readdirSync(dir);
        // A "real" planning dir has at least prd.md or feature-registry.json or stories/
        return entries.some((e) =>
          /^(prd\.md|feature-registry\.json|stories|feature-dossiers|epics\.md|milestones\.md)$/i.test(e),
        );
      } catch {
        return false;
      }
    };

    const directCandidates = [
      path.join(this.root, '_cobolt-output', 'latest', 'planning'),
      path.join(this.root, '_cobolt-output', 'planning'),
    ];
    for (const candidate of directCandidates) {
      if (hasPlanningArtifacts(candidate)) return candidate;
    }

    // Fall back to the most recent run-specific planning dir on disk
    for (const historical of this._historicalPlanningDirs()) {
      if (hasPlanningArtifacts(historical)) return historical;
    }

    if (typeof resolveReadablePlanningDir === 'function') {
      return resolveReadablePlanningDir(this.root, { allowLatestFallback: true });
    }
    return getPlanningDir(this.root, { strict: false, fallbackToLatest: true });
  }
}

// ── CLI ──────────────────────────────────────────────────────

function printUsage() {
  console.log(`
  CoBolt Pre-Flight — Planning Artifact Gate
  ═══════════════════════════════════════════

  Usage: node tools/cobolt-preflight.js <command> [args]

  Commands:
    check <skill>         Check if skill's required artifacts exist
    context <skill>       Emit canonical planning context for a downstream skill
    status                Show all artifact status
    list                  List all skills and dependencies
    register-all          Auto-register all planning artifacts into cobolt-state.json
    validate-milestones   Validate milestone count (minimum 3, within sizing range)
    validate-milestone-sizes  Validate per-milestone FR distribution (target 5-12, hard limit 15)
    validate-story-density    Validate milestone story density (target 3-6 stories, <=3 FRs/story hard limit)
    validate-weighted-sizing  Estimate milestone delivery-point weight beyond raw FR count
    validate-epic-density     Validate epic shape (target 2-4 stories/epic, fail bucket-like epics)
    validate-milestone-titles Lint milestone titles for bucket/layer anti-patterns
    validate-blocked-tasks    Validate future-blocked task risk after milestone decomposition
    validate-regroup-plan     Validate whether regroup plan operations have been absorbed
    rebalance-milestones  Diagnose oversized milestones and show split recommendations (use --write to persist)
    validate-stories      Validate story file completeness across all milestones

  Options:
    --json           Output machine-readable JSON
    --write          Persist rebalance artifacts (rebalance report + milestones-vN.md)
    --project <dir>  Project root directory

  Examples:
    node tools/cobolt-preflight.js check cobolt-build
    node tools/cobolt-preflight.js context cobolt-build --milestone M1 --json
    node tools/cobolt-preflight.js check cobolt-dev-story
    node tools/cobolt-preflight.js status --json
    node tools/cobolt-preflight.js validate-milestones
    node tools/cobolt-preflight.js validate-story-density --json
    node tools/cobolt-preflight.js validate-weighted-sizing --json
    node tools/cobolt-preflight.js validate-epic-density --json
    node tools/cobolt-preflight.js validate-milestone-titles --json
    node tools/cobolt-preflight.js validate-blocked-tasks --json
    node tools/cobolt-preflight.js validate-regroup-plan --json
    node tools/cobolt-preflight.js rebalance-milestones --write
    node tools/cobolt-preflight.js register-all
    node tools/cobolt-preflight.js list
`);
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const jsonFlag = args.includes('--json');
  const writeFlag = args.includes('--write');
  const projectIdx = args.indexOf('--project');
  const projectRoot = projectIdx >= 0 ? args[projectIdx + 1] : process.cwd();

  // --help / -h / help → stdout + exit 0 (per tools/CLAUDE.md exit contract).
  // Must happen BEFORE switch so unknown command path doesn't swallow them.
  if (command === '--help' || command === '-h' || command === 'help') {
    printUsage();
    process.exit(0);
  }

  const checker = new PreflightChecker(projectRoot);

  switch (command) {
    case 'check': {
      const skill = args[1];
      if (!skill || skill.startsWith('--')) {
        console.error('Error: skill name required. Usage: cobolt-preflight check <skill>');
        process.exit(2);
      }
      const result = checker.check(skill);
      if (jsonFlag) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result.message);
        if (!result.passed && result.missing.length > 0) {
          console.log(`\nMissing: ${result.missing.length} | Present: ${result.present.length}`);
        }
      }
      process.exit(result.passed ? 0 : 1);
      break;
    }

    case 'status': {
      const artifacts = checker.status();
      if (jsonFlag) {
        console.log(JSON.stringify(artifacts, null, 2));
      } else {
        console.log('\n  CoBolt Planning Artifact Status');
        console.log('  ═══════════════════════════════\n');
        const maxId = Math.max(...artifacts.map((a) => a.id.length));
        for (const a of artifacts) {
          const status = a.exists
            ? '\x1b[32mPRESENT\x1b[0m'
            : a.optional
              ? '\x1b[33mMISSING (optional)\x1b[0m'
              : '\x1b[31mMISSING\x1b[0m';
          const sizeInfo = a.exists ? `${a.size}B` : `need ${a.minBytes}B+`;
          console.log(`  ${a.id.padEnd(maxId + 2)} ${status}  ${sizeInfo}`);
        }
        const presentCount = artifacts.filter((a) => a.exists).length;
        const requiredCount = artifacts.filter((a) => !a.optional).length;
        const requiredPresent = artifacts.filter((a) => !a.optional && a.exists).length;
        console.log(
          `\n  ${presentCount}/${artifacts.length} total present | ${requiredPresent}/${requiredCount} required present\n`,
        );
      }
      // `status` is a read-only display command — always exits 0. Scripts that
      // need a gating verdict on artifact presence should use `check <skill>`
      // (which is the explicit gate command). Previously `status` exited 1
      // when any required artifact was missing, which broke every skill's
      // opening diagnostic run (every fresh project has missing artifacts
      // by definition — that's why we run status).
      process.exit(0);
      break;
    }

    case 'list': {
      const skills = checker.list();
      if (jsonFlag) {
        console.log(JSON.stringify(skills, null, 2));
      } else {
        console.log('\n  CoBolt Skill Dependency Map');
        console.log('  ══════════════════════════\n');
        for (const [name, def] of Object.entries(skills)) {
          const rawReqs = def.requires || [];
          const reqs =
            (Array.isArray(rawReqs)
              ? rawReqs
              : rawReqs.pipeline || rawReqs.standalone || Object.values(rawReqs).flat()
            ).join(', ') || '(none)';
          const prods = (def.produces || []).join(', ') || '(none)';
          console.log(`  ${name}`);
          console.log(`    requires: ${reqs}`);
          if (def.requiresAny) console.log(`    requiresAny: ${def.requiresAny.join(', ')}`);
          console.log(`    produces: ${prods}`);
          console.log();
        }
      }
      process.exit(0);
      break;
    }

    case 'validate-milestones': {
      const result = checker.validateMilestones();
      if (jsonFlag) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n  ${result.message}`);
        if (result.count > 0) {
          console.log(`  Milestones found: ${result.milestoneNumbers.map((n) => `M${n}`).join(', ')}`);
          console.log(`  Sizing range: ${result.minimum}-${result.maximum}`);
        }
        console.log();
      }
      process.exit(result.passed ? 0 : 1);
      break;
    }

    case 'feature-milestone-info': {
      const info = checker.getFeatureMilestoneInfo();
      if (jsonFlag) {
        console.log(JSON.stringify(info, null, 2));
      } else {
        console.log(`\n  Feature mode: ${info.featureMode}`);
        console.log(`  Highest milestone: M${info.highestMilestone}`);
        if (info.featureMode) {
          console.log(`  Original milestones: ${info.originalMilestones.map((n) => `M${n}`).join(', ') || 'none'}`);
          console.log(`  Feature milestones: ${info.featureMilestones.map((n) => `M${n}`).join(', ') || 'none'}`);
        }
        console.log();
      }
      break;
    }

    case 'validate-milestone-sizes': {
      const result = checker.validateMilestoneFRDistribution();
      if (jsonFlag) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n  ${result.message}`);
        if (result.milestones.length > 0) {
          console.log();
          for (const m of result.milestones) {
            const marker = m.status === 'oversized' ? '✗' : m.status === 'warning' ? '!' : '✓';
            console.log(
              `  ${marker} ${m.id}: ${m.frCount} FRs ${m.status === 'oversized' ? '(EXCEEDS LIMIT)' : m.status === 'warning' ? '(above target)' : ''}`,
            );
          }
          console.log(
            `\n  Target: ${result.target.min}-${result.target.max} FRs | Preferred: ${result.preferredRange.min}-${result.preferredRange.max} FRs | Hard limit: ${result.hardLimit} FRs`,
          );
        }
        console.log();
      }
      process.exit(result.passed ? 0 : 1);
      break;
    }

    case 'validate-story-density': {
      const result = checker.validateMilestoneStoryDensity();
      if (jsonFlag) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n  ${result.message}`);
        if (result.milestones.length > 0) {
          console.log();
          for (const milestone of result.milestones) {
            const marker = milestone.status === 'failed' ? '×' : milestone.status === 'warning' ? '!' : '✓';
            const avg =
              typeof milestone.avgFrPerStory === 'number' ? `${milestone.avgFrPerStory.toFixed(2)} FR/story` : 'n/a';
            console.log(
              `  ${marker} ${milestone.id}: ${milestone.storyCount} stories | ${milestone.frCount} FRs | ${avg}`,
            );
            if (milestone.recommendation) {
              console.log(`    ${milestone.recommendation}`);
            }
          }
          console.log(
            `\n  Target: ${result.targets.storyCount.min}-${result.targets.storyCount.max} stories/milestone | Warning above ${result.targets.frPerStory.warning} FR/story | Hard limit: ${result.targets.frPerStory.hardLimit} FR/story`,
          );
        }
        console.log();
      }
      process.exit(result.passed ? 0 : 1);
      break;
    }

    case 'validate-weighted-sizing': {
      const result = checker.validateWeightedMilestoneSizing();
      if (jsonFlag) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n  ${result.message}`);
        if (result.milestones.length > 0) {
          console.log();
          for (const milestone of result.milestones) {
            const marker = milestone.status === 'failed' ? 'x' : milestone.status === 'warning' ? '!' : 'ok';
            console.log(
              `  ${marker} ${milestone.id}: ${milestone.deliveryPoints} points | ${milestone.frCount} FRs | avg ${milestone.avgPointsPerFr.toFixed(2)} points/FR`,
            );
            if (milestone.dominantRisks.length > 0) {
              console.log(`    Dominant risks: ${milestone.dominantRisks.join(', ')}`);
            }
            if (milestone.recommendation) {
              console.log(`    ${milestone.recommendation}`);
            }
          }
          console.log(
            `\n  Preferred: ${result.thresholds.preferredRange.min}-${result.thresholds.preferredRange.max} points | Hard limit: ${result.thresholds.hardLimit} | Avg warning: ${result.thresholds.avgWarningLimit} points/FR`,
          );
        }
        console.log();
      }
      process.exit(result.passed ? 0 : 1);
      break;
    }

    case 'validate-epic-density': {
      const result = checker.validateEpicDensity();
      if (jsonFlag) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n  ${result.message}`);
        if (result.epics.length > 0) {
          console.log();
          for (const epic of result.epics) {
            const marker = epic.status === 'failed' ? 'x' : epic.status === 'warning' ? '!' : 'ok';
            const avg = typeof epic.avgFrPerStory === 'number' ? `${epic.avgFrPerStory.toFixed(2)} FR/story` : 'n/a';
            console.log(`  ${marker} ${epic.id}: ${epic.storyCount} stories | ${epic.frCount} FRs | ${avg}`);
            if (epic.recommendation) {
              console.log(`    ${epic.recommendation}`);
            }
          }
          console.log(
            `\n  Target: ${result.thresholds.storiesPerEpic.min}-${result.thresholds.storiesPerEpic.max} stories/epic | Hard limit: ${result.thresholds.storiesPerEpic.hardLimit} stories | Story warning: >${result.thresholds.acceptanceCriteriaWarning} acceptance criteria`,
          );
        }
        console.log();
      }
      process.exit(result.passed ? 0 : 1);
      break;
    }

    case 'validate-milestone-titles': {
      const result = checker.validateMilestoneTitles();
      if (jsonFlag) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n  ${result.message}`);
        if (result.milestones.length > 0) {
          console.log();
          for (const milestone of result.milestones) {
            if (milestone.status !== 'warning') continue;
            console.log(`  ! ${milestone.id}: ${milestone.title}`);
            for (const reason of milestone.reasons || []) {
              console.log(`    - ${reason}`);
            }
          }
        }
        console.log();
      }
      process.exit(result.blocking ? 1 : 0);
      break;
    }

    case 'validate-blocked-tasks': {
      const result = checker.validateBlockedTasks();
      if (jsonFlag) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n  ${result.message}`);
        if (result.milestones.length > 0) {
          console.log();
          for (const milestone of result.milestones) {
            if (milestone.blockedTasks === 0) continue;
            const marker = milestone.status === 'failed' ? 'FAIL' : milestone.status === 'warning' ? 'WARN' : 'OK';
            console.log(
              `  ${marker} ${milestone.id}: ${milestone.blockedTasks}/${milestone.totalTasks || milestone.blockedTasks} blocked (${percent(milestone.blockedRatio)})`,
            );
            if (milestone.blockerMilestones.length > 0) {
              console.log(`    Blocked by later milestones: ${milestone.blockerMilestones.join(', ')}`);
            }
          }
        }
        if (result.recommendations.length > 0) {
          console.log('\n  Recommendations:');
          for (const recommendation of result.recommendations) {
            console.log(`    - ${recommendation}`);
          }
        }
        console.log();
      }
      process.exit(result.passed ? 0 : 1);
      break;
    }

    case 'validate-regroup-plan': {
      const result = checker.validateRegroupPlan();
      if (jsonFlag) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n  ${result.message}`);
        if (result.pending.length > 0) {
          console.log('\n  Pending operations:');
          for (const operation of result.pending.slice(0, 10)) {
            console.log(
              `    - ${operation.storyId}: ${operation.currentMilestone || 'unknown'} -> ${operation.toMilestone}`,
            );
          }
        }
        if (result.staleReasons.length > 0) {
          console.log('\n  Stale reasons:');
          for (const reason of result.staleReasons) {
            console.log(`    - ${reason}`);
          }
        }
        console.log();
      }
      process.exit(result.passed ? 0 : 1);
      break;
    }

    case 'rebalance-milestones': {
      // In rigorous mode, auto-split without prompting (--write implicit).
      let rigorousAutoWrite = false;
      try {
        rigorousAutoWrite = require('../lib/cobolt-mode').isRigorous(checker.root || process.cwd());
      } catch {}
      const effectiveWrite = writeFlag || rigorousAutoWrite;
      const result = checker.rebalanceMilestones({ write: effectiveWrite });
      if (jsonFlag) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log('\n  MILESTONE REBALANCE ADVISOR');
        console.log('  ==========================\n');
        console.log(`  ${result.message}`);
        console.log();
        console.log(`  FR distribution: ${result.analyses.frDistribution.message}`);
        console.log(`  Story density: ${result.analyses.storyDensity.message}`);
        console.log(`  Weighted sizing: ${result.analyses.weightedSizing.message}`);
        console.log(`  Epic density: ${result.analyses.epicDensity.message}`);
        console.log(`  Blocked-task regrouping: ${result.analyses.blockedTasks.message}`);
        if (result.artifacts?.json) {
          console.log('\n  Artifacts:');
          console.log(`    JSON report: ${result.artifacts.json}`);
          console.log(`    Markdown report: ${result.artifacts.markdown}`);
          console.log(`    Versioned milestones: ${result.artifacts.milestonesVersion}`);
        }
        console.log();
      }
      process.exit(result.needsRebalance ? 1 : 0);
      break;
    }

    case 'validate-stories': {
      const result = checker.validateStories();
      if (jsonFlag) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n  ${result.message}`);
        if (result.expected > 0) {
          console.log(`  Expected: ${result.expected} | Actual: ${result.actual} | Coverage: ${result.coverage}%`);
        }
        if (result.missing.length > 0 && result.missing.length <= 20) {
          console.log(`  Missing: ${result.missing.join(', ')}`);
        }
        console.log();
      }
      process.exit(result.passed ? 0 : 1);
      break;
    }

    case 'context': {
      const skill = args[1];
      const milestoneIdx = args.indexOf('--milestone');
      const milestone = milestoneIdx >= 0 ? args[milestoneIdx + 1] : null;
      if (!skill || skill.startsWith('--')) {
        console.error('Error: skill name required. Usage: cobolt-preflight context <skill> [--milestone M1]');
        process.exit(2);
      }
      const result = checker.context(skill, { milestone });
      if (jsonFlag) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n  CoBolt Planning Context for ${result.skill}`);
        if (result.milestone) console.log(`  Milestone: ${result.milestone}`);
        console.log(`  Planning dir: ${result.planningDir || '(missing)'}`);
        console.log(
          `  Required: ${result.summary.requiredPresent} present / ${result.summary.requiredMissing} missing`,
        );
        console.log(
          `  Optional: ${result.summary.optionalPresent} present / ${result.summary.optionalMissing} missing`,
        );
        console.log(
          `  Stories: ${result.summary.totalStories} | Tasks: ${result.summary.totalTasks} | Milestones: ${result.summary.totalMilestones}`,
        );
        if (result.storyCoverage.expectedStoryIds.length > 0) {
          console.log(
            `  Story coverage: ${result.storyCoverage.actualFiles.length}/${result.storyCoverage.expectedStoryIds.length} (${result.storyCoverage.coverage}%)`,
          );
        }
        if (result.warnings.length > 0) {
          console.log(`  Warnings: ${result.warnings.join(' | ')}`);
        }
        console.log();
      }
      process.exit(result.summary.requiredMissing === 0 ? 0 : 1);
      break;
    }

    case 'register-all': {
      const result = checker.registerAll();
      if (jsonFlag) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (result.registered > 0) {
          console.log(`\n  Registered ${result.registered} planning artifacts into cobolt-state.json`);
          for (const [key, info] of Object.entries(result.artifacts)) {
            console.log(`    ${key}: ${info.path} (${info.size}B)`);
          }
          console.log();
        } else {
          console.log('\n  No planning artifacts found to register.');
          if (result.errors.length > 0) {
            for (const err of result.errors) console.error(`  ERROR: ${err}`);
          }
          console.log();
        }
      }
      process.exit(result.registered > 0 ? 0 : 1);
      break;
    }

    default:
      printUsage();
      process.exit(command ? 2 : 0);
  }
}

if (require.main === module) main();

module.exports = { PreflightChecker };
