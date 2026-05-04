#!/usr/bin/env node

// CoBolt Requirements Traceability Matrix (RTM) --- CLI tool
//
// Tracks every requirement (FR, NFR, TR, IR) from origin through epic, story,
// code, and test to validation. Single source of truth for requirement coverage.
//
// Usage:
//   node tools/cobolt-rtm.js init                                    # Create empty RTM
//   node tools/cobolt-rtm.js import-prd [--prd <path>]               # Import FRs and NFRs from PRD
//   node tools/cobolt-rtm.js import-trd [--trd <path>]               # Import TRs from TRD
//   node tools/cobolt-rtm.js import-implicit [--file <path>]          # Import IRs from implicit reqs
//   node tools/cobolt-rtm.js sync-source-registry                     # Import source-registry-only requirements
//   node tools/cobolt-rtm.js map <req-id> --epic <e> --stories <s>   # Map requirement to epic/stories
//   node tools/cobolt-rtm.js map-milestone <req-id> --milestone <m>  # Assign to milestone
//   node tools/cobolt-rtm.js backfill-ac                             # Backfill stories + AC from story-tracker + story files (D-1 fix)
//   node tools/cobolt-rtm.js scan [--dir <path>]                     # Scan codebase for evidence
//   node tools/cobolt-rtm.js check [--threshold <n>]                 # Gate check (exit 1 if below)
//   node tools/cobolt-rtm.js status                                  # Coverage summary
//   node tools/cobolt-rtm.js report [--format md|json]               # Full traceability report
//   node tools/cobolt-rtm.js update <req-id> --field <f> --value <v> # Update a field
//   node tools/cobolt-rtm.js link-test <req-id> <test-case-id>       # Link test evidence
//   node tools/cobolt-rtm.js link-code <req-id> <file:line>          # Link code evidence

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const {
  extractRequirementDefinitions,
  normalizeRequirementId,
  requirementIdVariants,
  canonicalizeRequirementId,
} = require('../lib/cobolt-requirements');

// v0.47.2 — prefer canonical (3-digit zero-padded) form for new rtm.json
// keys. Falls back to normalizeRequirementId when the input doesn't fit the
// canonical grammar (defensive — every FR/NFR/TR/IR/TRD/ADR id SHOULD
// canonicalize, but non-matching inputs still yield a usable key via the
// legacy normalizer).
function canonicalIdOrFallback(rawId) {
  const canonical = canonicalizeRequirementId(rawId);
  return canonical || normalizeRequirementId(rawId);
}
const {
  collectRequirementCandidateFiles,
  findRequirementContentEvidence,
  findRequirementEvidence,
} = require('../lib/cobolt-requirement-evidence');
const { getPlanningDir, resolveRtmFile } = require('../lib/cobolt-planning-artifacts');
const { signJson, verifyJson } = require('../lib/cobolt-state-integrity');
const { CoBoltStateLock } = require('../source/plugins/cobolt-state-lock');

// - Path Resolution -
// All resolution delegated to lib/cobolt-planning-artifacts.resolveRtmFile()

function rtmReadPath() {
  return resolveRtmFile(process.cwd(), 'read') || rtmPath();
}

function rtmPath() {
  return resolveRtmFile(process.cwd(), 'write');
}

// v0.40.8 — planningDir MUST resolve to the canonical planning artifact dir
// (latest/planning/), NOT the rtm.json enclosing dir. Before this fix, once
// rtm.json landed at latest/rtm/rtm.json (the fallback location when no
// planning markers exist at init time), `planningDir()` returned latest/rtm/
// and every `import-prd`, `import-trd`, `import-implicit` lookup probed
// latest/rtm/<artifact>.md — which never exists — and exited 1 silently
// (callers in SKILL.md capture exit code but the bash block has no `set -e`).
//
// Use the canonical getPlanningDir() resolver which understands strong
// planning markers and the latest/planning → runs/<date>/run-NNN/planning
// symlink chain. Fallback to rtm dirname only if no planning dir can be
// resolved (preserves backward-compat for RTM-only workflows).
function planningDir() {
  const resolved = getPlanningDir(process.cwd(), {
    create: false,
    strict: false,
    fallbackToLatest: true,
  });
  if (resolved) return resolved;
  return path.dirname(rtmPath());
}

// v0.40.8 — for SOURCE artifact lookups (prd.md / trd.md /
// implicit-requirements.md) the importer should search BOTH:
//   1. the canonical planning dir (latest/planning/) — the modern location
//   2. the rtm-colocated dir (dirname of rtm.json) — legacy/test location
// Whichever contains the file wins. This keeps the production path
// resolution canonical while preserving backward-compat with older
// installs and tests that colocate source docs with rtm.json.
//
// Returns the resolved absolute path if found at either location, or the
// canonical-dir path (even if absent) so downstream "not found" errors
// name the *canonical* location rather than the fallback.
function resolveSourceArtifact(filename) {
  const canonical = path.join(planningDir(), filename);
  if (fs.existsSync(canonical)) return canonical;
  const colocated = path.join(path.dirname(rtmPath()), filename);
  if (fs.existsSync(colocated)) return colocated;
  return canonical;
}

// - Read/Write (atomic + locked + signed) -

function readRtm() {
  const fp = rtmReadPath();
  if (!fs.existsSync(fp)) return null;
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const integrity = verifyJson(data);
  if (!integrity.valid && integrity.reason.includes('mismatch')) {
    process.stderr.write(`[cobolt-rtm] WARNING: RTM integrity check failed: ${integrity.reason}\n`);
  }
  if (data && Array.isArray(data.requirements)) {
    const migrated = {};
    for (const req of data.requirements) {
      if (req?.id) migrated[req.id] = req;
    }
    data.requirements = migrated;
    process.stderr.write('[cobolt-rtm] NOTICE: migrated legacy Array requirements form to object keyed by id\n');
  } else if (data && (typeof data.requirements !== 'object' || data.requirements === null)) {
    data.requirements = {};
  }
  return data;
}

// v0.47.3 — collision-safe lookup for import commands. Returns the existing
// entry if `id` or any legacy-form equivalent already lives in requirements.
// Pre-v0.47.2 rtm.json files stored short-form keys (`FR-1`); v0.47.2's
// producer migration emits `FR-001`, so a direct `requirements[id]` lookup
// after upgrade would miss the existing `FR-1` entry and land a duplicate.
// Keeping this scoped to the import path (instead of rewriting on every
// readRtm call) preserves `check-format` / `migrate-ids` semantics — both
// commands need to observe the on-disk format to report drift and renames.
function findRequirementByCanonicalId(requirements, canonicalId) {
  if (!requirements || !canonicalId) return null;
  // Fast path — exact key hit.
  if (requirements[canonicalId]) return { key: canonicalId, entry: requirements[canonicalId] };
  // Slow path — scan for any key whose canonical form matches.
  for (const [key, value] of Object.entries(requirements)) {
    if (canonicalizeRequirementId(key) === canonicalId) {
      return { key, entry: value };
    }
  }
  return null;
}

function writeRtm(data) {
  const fp = rtmPath();
  data.metadata.lastUpdated = new Date().toISOString();
  data.metadata.totalRequirements = Object.keys(data.requirements).length;
  data.metadata.coverageSummary = computeCoverage(data);
  const signed = signJson(data);
  try {
    atomicWrite(fp, JSON.stringify(signed, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.error(`[cobolt-rtm] Error writing RTM: ${err.message}`);
    throw err;
  }
}

/**
 * Locked read-modify-write for RTM.
 * Use this when concurrent agent access is possible.
 */
async function writeRtmLocked(updateFn) {
  const fp = rtmPath();
  const lock = new CoBoltStateLock(fp);
  const acquired = await lock.acquire();
  if (!acquired) {
    throw new Error('[cobolt-rtm] Failed to acquire RTM lock --- timeout after 10s');
  }
  try {
    const current = readRtm() || createEmptyRtm();
    const updated = updateFn(current);
    writeRtm(updated);
    return updated;
  } finally {
    lock.release();
  }
}

function createEmptyRtm() {
  return {
    metadata: { version: '1.0.0', createdAt: new Date().toISOString() },
    requirements: {},
  };
}

function resolveRequirementKey(data, candidateId) {
  if (!candidateId || !data?.requirements) return null;
  if (data.requirements[candidateId]) return candidateId;

  const normalized = normalizeRequirementId(candidateId);
  if (data.requirements[normalized]) return normalized;

  return Object.keys(data.requirements).find((existingId) => {
    const variants = new Set(requirementIdVariants(existingId));
    variants.add(normalizeRequirementId(existingId));
    return variants.has(candidateId) || variants.has(normalized);
  });
}

// - Coverage Computation -
// COVERAGE_MODES, normalizeCoverageMode, coverageForMode, computeCoverage,
// getRequirementMilestones, setRequirementMilestones extracted to
// lib/cobolt-rtm-coverage.js. Re-imported below; call sites unchanged.

const {
  COVERAGE_MODES,
  normalizeCoverageMode,
  coverageForMode,
  computeCoverage,
  getRequirementMilestones,
  setRequirementMilestones,
} = require('../lib/cobolt-rtm-coverage');

// - Import Helpers -

function parseFRsFromPRD(content) {
  const entries = {};
  for (const definition of extractRequirementDefinitions(content, {
    types: ['functional', 'non-functional'],
  })) {
    const id = canonicalIdOrFallback(definition.id);
    const targetLine = definition.body
      ?.split('\n')
      .map((line) => line.trim())
      .find((line) => /^\*\*Target:\*\*/i.test(line));
    const target = targetLine ? targetLine.replace(/^\*\*Target:\*\*\s*/i, '').trim() : '';

    entries[id] = {
      id,
      source: 'prd',
      type: definition.type,
      parent_fr: null,
      title: definition.title,
      description: definition.description || (target ? `Target: ${target}` : ''),
      priority: definition.body?.match(/\*\*Priority:\*\*\s*(MVP|Growth|Vision)/i)?.[1] || 'MVP',
      milestone: null,
      acceptance_criteria: definition.acceptanceCriteria?.length
        ? definition.acceptanceCriteria
        : target
          ? [`Target: ${target}`]
          : [],
      epic: null,
      stories: [],
      code_evidence: [],
      test_evidence: [],
      status: 'pending',
    };
  }

  return entries;
}

function parseTRsFromTRD(content) {
  const entries = {};
  for (const definition of extractRequirementDefinitions(content, {
    types: ['technical'],
  })) {
    const id = canonicalIdOrFallback(definition.id);
    const targetLine = definition.body
      ?.split('\n')
      .map((line) => line.trim())
      .find((line) => /^\*\*Target:\*\*/i.test(line));
    const target = targetLine ? targetLine.replace(/^\*\*Target:\*\*\s*/i, '').trim() : '';

    entries[id] = {
      id,
      source: 'trd',
      type: 'technical',
      parent_fr: null,
      title: definition.title,
      description: definition.description || (target ? `Target: ${target}` : ''),
      priority: definition.body?.match(/\*\*Priority:\*\*\s*(MVP|Growth|Vision)/i)?.[1] || 'MVP',
      milestone: null,
      acceptance_criteria: definition.acceptanceCriteria?.length
        ? definition.acceptanceCriteria
        : target
          ? [`Target: ${target}`]
          : [],
      epic: null,
      stories: [],
      code_evidence: [],
      test_evidence: [],
      status: 'pending',
    };
  }
  return entries;
}

function parseIRsFromImplicit(content) {
  const entries = {};
  for (const definition of extractRequirementDefinitions(content, {
    types: ['implicit'],
  })) {
    const id = canonicalIdOrFallback(definition.id);
    const parentMatch = definition.title.match(/\[((?:FR|NFR|TR|IR)(?:(?:[-_.]?[A-Z0-9]+)+))/i);
    const parent_fr = parentMatch ? canonicalIdOrFallback(parentMatch[1]) : null;

    entries[id] = {
      id,
      source: 'implicit',
      type: 'implicit',
      parent_fr,
      title: definition.title,
      description: definition.description || '',
      priority: definition.body?.match(/\*\*Priority:\*\*\s*(MVP|Growth|Vision)/i)?.[1] || 'MVP',
      milestone: null,
      acceptance_criteria: definition.acceptanceCriteria || [],
      epic: null,
      stories: [],
      code_evidence: [],
      test_evidence: [],
      status: 'pending',
    };
  }
  return entries;
}

function dedupeEvidenceMatches(matches = []) {
  const byFile = new Map();
  for (const match of matches) {
    const existing = byFile.get(match.file);
    if (!existing) {
      byFile.set(match.file, { ...match });
      continue;
    }

    const mergedLines = [...new Set([...(existing.matchedLines || []), ...(match.matchedLines || [])])].sort(
      (left, right) => left - right,
    );
    const mergedKeywords = [...new Set([...(existing.matchedKeywords || []), ...(match.matchedKeywords || [])])].sort();
    const mergedPhrases = [...new Set([...(existing.matchedPhrases || []), ...(match.matchedPhrases || [])])].sort();

    byFile.set(match.file, {
      ...existing,
      ...match,
      matchedLines: mergedLines,
      matchedKeywords: mergedKeywords,
      matchedPhrases: mergedPhrases,
      source: existing.source === match.source ? existing.source : 'mixed',
    });
  }

  return [...byFile.values()].sort((left, right) => left.file.localeCompare(right.file, undefined, { numeric: true }));
}

function buildCodeEvidenceRecord(match, now) {
  return {
    file: match.file,
    lines: (match.matchedLines || []).join(','),
    verified_at: now,
    source: match.source || 'marker',
    matched_keywords: match.matchedKeywords || [],
    matched_phrases: match.matchedPhrases || [],
  };
}

function buildTestEvidenceRecord(reqId, match) {
  return {
    case_id: `${reqId}-test`,
    file: match.file,
    lines: (match.matchedLines || []).join(','),
    status: 'pass',
    source: match.source || 'marker',
    matched_keywords: match.matchedKeywords || [],
    matched_phrases: match.matchedPhrases || [],
  };
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function isFlagToken(value) {
  return typeof value === 'string' && value.startsWith('--');
}

function collectRequirementIdsFromStory(story) {
  return [
    ...new Set(
      [
        ...(Array.isArray(story?.requirementIds) ? story.requirementIds : []),
        ...(Array.isArray(story?.frIds) ? story.frIds : []),
        ...(Array.isArray(story?.nfrIds) ? story.nfrIds : []),
        ...(Array.isArray(story?.trIds) ? story.trIds : []),
        ...(Array.isArray(story?.irIds) ? story.irIds : []),
      ]
        .map((id) => normalizeRequirementId(id))
        .filter(Boolean),
    ),
  ];
}

function sortMilestoneIds(values) {
  return [...new Set((values || []).filter(Boolean))].sort((left, right) => {
    const leftNum = Number.parseInt(String(left).replace(/^M/i, ''), 10);
    const rightNum = Number.parseInt(String(right).replace(/^M/i, ''), 10);
    if (Number.isFinite(leftNum) && Number.isFinite(rightNum) && leftNum !== rightNum) return leftNum - rightNum;
    return String(left).localeCompare(String(right), undefined, { numeric: true });
  });
}

function sameStringArray(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function autoMapFromPlanningArtifacts(data, args) {
  const milestoneFilter = getFlagValue(args, '--milestone');
  const pd = getPlanningDir(process.cwd(), { create: true });
  const storyTrackerCandidates = [
    path.join(pd, 'story-tracker.json'),
    path.join(process.cwd(), '_cobolt-output', 'latest', 'brownfield', '41-modernization-story-tracker.json'),
  ];
  const storyTrackerPath = storyTrackerCandidates.find((candidate) => fs.existsSync(candidate));
  const storyTracker = storyTrackerPath ? readJsonIfExists(storyTrackerPath) : null;
  const stories = Array.isArray(storyTracker?.stories) ? storyTracker.stories : [];

  if (stories.length === 0) {
    console.error(
      `  story-tracker.json not found or empty at ${storyTrackerPath}. Run cobolt-tracker-init.js generate or planning sync first.`,
    );
    process.exit(1);
  }

  const scopedStories = milestoneFilter ? stories.filter((story) => story?.milestone === milestoneFilter) : stories;
  if (scopedStories.length === 0) {
    console.error(`  No story-tracker entries found for milestone ${milestoneFilter}`);
    process.exit(1);
  }

  const updatedRequirementIds = new Set();
  const missingRequirements = new Set();
  let linkedStories = 0;

  for (const story of scopedStories) {
    const requirementIds = collectRequirementIdsFromStory(story);
    for (const requestedReqId of requirementIds) {
      const resolvedReqId = resolveRequirementKey(data, requestedReqId);
      if (!resolvedReqId) {
        missingRequirements.add(requestedReqId);
        continue;
      }

      const requirement = data.requirements[resolvedReqId];
      let changed = false;

      if (story.epic && !requirement.epic) {
        requirement.epic = story.epic;
        changed = true;
      }

      if (story.milestone) {
        // Dual-write: maintain both legacy scalar and new array.
        // Append if not already present (closes H-1 — silent cross-milestone loss
        // when a story's milestone differs from a prior single-milestone mapping).
        const current = getRequirementMilestones(requirement);
        if (!current.includes(story.milestone)) {
          current.push(story.milestone);
          setRequirementMilestones(requirement, current, requirement.milestone_phasing);
          changed = true;
        }
      }

      if (story.id && !requirement.stories.includes(story.id)) {
        requirement.stories.push(story.id);
        linkedStories++;
        changed = true;
      }

      if ((requirement.epic || requirement.stories.length > 0) && requirement.status === 'pending') {
        requirement.status = 'mapped';
        changed = true;
      }

      if (changed) {
        updatedRequirementIds.add(resolvedReqId);
      }
    }
  }

  writeRtm(data);
  console.log(
    `  Auto-mapped ${updatedRequirementIds.size} requirement(s) from story-tracker.json${milestoneFilter ? ` for ${milestoneFilter}` : ''}`,
  );
  console.log(`  Story links added: ${linkedStories}`);

  // Phantom-reference detection: stories reference FR/NFR/IR/TR IDs absent
  // from RTM. Historical root cause of pipeline failures — phantom story
  // references were advisory-only and pipeline continued. Now hard-fail
  // unless --no-strict is passed for exploratory use.
  if (missingRequirements.size > 0) {
    const allMissing = [...missingRequirements];
    console.error(`  Missing from RTM: ${allMissing.join(', ')}`);
    console.error(`  ${missingRequirements.size} requirement(s) referenced by stories but absent from RTM.`);
    console.error('  Remediation:');
    console.error('    1. Ensure PRD/TRD/implicit-reqs contain all referenced IDs.');
    console.error('    2. Re-run: cobolt-rtm.js init && import-prd && import-trd && import-implicit');
    console.error('    3. Re-run: cobolt-rtm.js map');
    appendRtmAuditEvent({
      class: 'rtm-story-phantom-refs',
      command: 'map',
      missingCount: missingRequirements.size,
      missing: allMissing,
      milestoneFilter: milestoneFilter || null,
    });
    if (!hasFlag(args, '--no-strict')) process.exit(4);
  }
}

// - Commands -

function cmdInit() {
  const existing = readRtm();
  if (existing) {
    console.log(`  RTM already exists at ${rtmPath()} (${Object.keys(existing.requirements).length} requirements)`);
    console.log('  Use import commands to add requirements.');
    return;
  }

  const data = {
    requirements: {},
    metadata: {
      created: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      version: '1.0.0',
      totalRequirements: 0,
      coverageSummary: computeCoverage({ requirements: {} }),
    },
  };
  writeRtm(data);
  console.log(`  RTM initialized: ${rtmPath()}`);
}

// Count distinct FR/NFR token references in source text. Used to detect
// silent-zero format drift: source has tokens but parser extracted zero.
function countSourceTokens(content, prefixes) {
  // v0.47 root-cause fix (CB-OBS-06 surfaced in Rdrive101 end-to-end run):
  // Prior regex /\b(?:IR)-[A-Z0-9][A-Z0-9_-]*\b/gi matched ANY alphanumeric
  // suffix, including prose ids like "IR-heavy", "IR-light", "FR-friendly".
  // This produced false-positive partial-drift census errors. Canonical
  // requirement IDs always end with a numeric group (FR-123, IR-001,
  // NFR-D2-001). Require trailing digits; allow optional intermediate
  // alphanumeric groups so NFR-D2-001 style IDs continue to match.
  const pattern = new RegExp(`\\b(?:${prefixes.join('|')})-(?:[A-Z0-9]+-)*\\d+\\b`, 'gi');
  const matches = content.match(pattern) || [];
  const normalized = new Set();
  for (const m of matches) {
    const norm = normalizeRequirementId(m);
    if (norm) normalized.add(norm);
  }
  return normalized.size;
}

function appendRtmAuditEvent(event) {
  try {
    const dir = path.join(process.cwd(), '_cobolt-output', 'audit');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(dir, 'rtm-integrity.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* best-effort */
  }
}

function sourceRegistryType(category) {
  const normalized = String(category || '').toUpperCase();
  if (normalized === 'FR') return 'functional';
  if (normalized === 'NFR') return 'non-functional';
  if (normalized === 'TR') return 'technical';
  if (normalized === 'IR') return 'implicit';
  if (normalized === 'CONSTRAINT') return 'constraint';
  return 'source';
}

function buildSourceRegistryRequirement(entry) {
  return {
    id: entry.id,
    source: 'source-registry',
    type: sourceRegistryType(entry.category),
    parent_fr: null,
    title: entry.summary,
    description: `${entry.summary} (source: ${entry.sourceFile})`,
    priority: 'MVP',
    milestone: null,
    milestones: [],
    acceptance_criteria: [`Source requirement ${entry.id}: ${entry.summary}`],
    epic: null,
    stories: [],
    code_evidence: [],
    test_evidence: [],
    status: 'pending',
    source_file: entry.sourceFile,
    source_category: entry.category,
    source_registry_refs: [entry.id],
  };
}

function cmdSyncSourceRegistry(args) {
  const jsonMode = args.includes('--json');
  const includeExcluded = args.includes('--include-excluded');
  const allMode = args.includes('--all');
  const { getSourceRequirementSet, isRequirementCovered } = require('./cobolt-source-coverage');

  let data = readRtm();
  if (!data) {
    cmdInit();
    data = readRtm();
  }

  const sourceRequirements = getSourceRequirementSet({
    projectRoot: process.cwd(),
    planningDir: planningDir(),
    includeExcluded,
  });

  if (sourceRequirements.skipped) {
    const result = {
      skipped: true,
      added: 0,
      updated: 0,
      coveredByExisting: 0,
      reason: sourceRequirements.sourcePacket?.reason || 'No deterministic source document packet was required',
      totalRequirements: Object.keys(data.requirements).length,
    };
    if (jsonMode) console.log(JSON.stringify(result, null, 2));
    else console.log(`  Source registry sync skipped: ${result.reason}`);
    return;
  }

  if (!sourceRequirements.passed) {
    const result = {
      skipped: false,
      passed: false,
      added: 0,
      updated: 0,
      coveredByExisting: 0,
      reason: sourceRequirements.reason,
      issues: sourceRequirements.issues || [],
    };
    if (jsonMode) console.log(JSON.stringify(result, null, 2));
    else console.error(`  Source registry sync failed: ${result.reason}`);
    process.exit(1);
  }

  const originalRtmContent = Object.values(data.requirements)
    .map((r) => `${r.id} ${r.title || ''} ${r.description || ''}`)
    .join('\n');
  let added = 0;
  let updated = 0;
  let coveredByExisting = 0;
  const syncedIds = [];

  for (const entry of sourceRequirements.entries) {
    const existing = data.requirements[entry.id];
    const covered = !allMode && isRequirementCovered(entry, originalRtmContent, null);

    if (existing) {
      data.requirements[entry.id] = {
        ...buildSourceRegistryRequirement(entry),
        ...existing,
        id: entry.id,
        title: existing.title || entry.summary,
        description: existing.description || `${entry.summary} (source: ${entry.sourceFile})`,
        source_registry_refs: [...new Set([...(existing.source_registry_refs || []), entry.id])],
        source_file: existing.source_file || entry.sourceFile,
        source_category: existing.source_category || entry.category,
      };
      updated++;
      syncedIds.push(entry.id);
      continue;
    }

    if (covered) {
      coveredByExisting++;
      continue;
    }

    data.requirements[entry.id] = buildSourceRegistryRequirement(entry);
    added++;
    syncedIds.push(entry.id);
  }

  data.metadata.sourceRegistrySync = {
    syncedAt: new Date().toISOString(),
    mode: allMode ? 'all' : 'missing',
    includedSourceRequirements: sourceRequirements.entries.length,
    added,
    updated,
    coveredByExisting,
    syncedIds,
  };
  writeRtm(data);

  const result = {
    skipped: false,
    passed: true,
    mode: allMode ? 'all' : 'missing',
    includedSourceRequirements: sourceRequirements.entries.length,
    added,
    updated,
    coveredByExisting,
    totalRequirements: Object.keys(data.requirements).length,
    syncedIds,
  };

  if (jsonMode) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`  Source registry sync complete: ${added} added, ${updated} updated`);
    console.log(`  Covered by existing RTM entries: ${coveredByExisting}`);
    console.log(`  Total requirements: ${Object.keys(data.requirements).length}`);
  }
}

function cmdImportPrd(args) {
  const prdFlag = args.indexOf('--prd');
  const prdPath = prdFlag >= 0 && args[prdFlag + 1] ? args[prdFlag + 1] : resolveSourceArtifact('prd.md');
  const strict = !hasFlag(args, '--no-strict');

  if (!fs.existsSync(prdPath)) {
    console.error(`  PRD not found: ${prdPath}`);
    process.exit(1);
  }

  let data = readRtm();
  if (!data) {
    cmdInit();
    data = readRtm();
  }

  const content = fs.readFileSync(prdPath, 'utf8');
  const entries = parseFRsFromPRD(content);
  let added = 0;
  let skipped = 0;

  for (const [id, entry] of Object.entries(entries)) {
    // v0.47.3 — collision-safe lookup. `entries` is keyed by canonical form
    // (parseFRsFromPRD → canonicalIdOrFallback), but `data.requirements`
    // may still hold legacy short-form keys from pre-v0.47.2 rtm.json.
    // Fall back to canonical-form scan so re-importing a PRD against an
    // unmigrated rtm.json does not silently write duplicate entries.
    const existing = findRequirementByCanonicalId(data.requirements, id);
    if (existing) {
      skipped++;
    } else {
      data.requirements[id] = entry;
      added++;
    }
  }

  const sourceTokens = countSourceTokens(content, ['FR', 'NFR']);
  const parsedCount = Object.keys(entries).length;

  // Silent-zero detection: PRD has FR/NFR tokens but 0 parsed. This is the
  // exact class of bug that caused 87 stories to reference phantom FR IDs.
  if (parsedCount === 0 && sourceTokens > 0) {
    const lines = content.split('\n');
    const suspects = lines
      .map((ln, i) => ({ ln, i: i + 1 }))
      .filter(({ ln }) => /\b(FR|NFR|IR|TR)\b/i.test(ln))
      .slice(0, 10);
    console.error(
      `  [cobolt-rtm] FAIL: PRD contains ${sourceTokens} FR/NFR token(s) but parser extracted 0 definitions.`,
    );
    console.error('  Format drift detected. Accepted definition formats:');
    console.error('    ### FR-001 - Title');
    console.error('    - FR-001: Title');
    console.error('    **FR-001**: Title');
    console.error('    | FR-001 | Title |');
    if (suspects.length > 0) {
      console.error('  Sample source lines containing FR/NFR tokens:');
      for (const { ln, i } of suspects) {
        console.error(`    line ${i}: ${ln.trim().slice(0, 160)}`);
      }
    }
    appendRtmAuditEvent({
      class: 'rtm-import-silent-zero',
      command: 'import-prd',
      source: prdPath,
      sourceTokens,
      parsed: 0,
    });
    if (strict) process.exit(2);
  }

  writeRtm(data);
  console.log(`  Imported from PRD: ${added} added, ${skipped} skipped (already exist)`);
  console.log(`  Total requirements: ${Object.keys(data.requirements).length}`);

  // Post-write census: count RTM PRD-source entries and compare against
  // source tokens. Partial drift (e.g., 50 PRD tokens, 8 RTM PRD entries).
  const rtmPrdCount = Object.values(data.requirements).filter((r) => r.source === 'prd').length;
  if (strict && sourceTokens > 0 && rtmPrdCount < sourceTokens) {
    const delta = sourceTokens - rtmPrdCount;
    console.error(
      `  [cobolt-rtm] FAIL: partial drift. PRD source has ${sourceTokens} distinct FR/NFR tokens; RTM has ${rtmPrdCount} entries with source='prd'. Missing ${delta}.`,
    );
    appendRtmAuditEvent({
      class: 'rtm-import-partial-drift',
      command: 'import-prd',
      source: prdPath,
      sourceTokens,
      rtmPrdCount,
      delta,
    });
    process.exit(3);
  }
}

function cmdImportTrd(args) {
  const trdFlag = args.indexOf('--trd');
  const trdPath = trdFlag >= 0 && args[trdFlag + 1] ? args[trdFlag + 1] : resolveSourceArtifact('trd.md');
  const strict = !hasFlag(args, '--no-strict');

  if (!fs.existsSync(trdPath)) {
    console.error(`  TRD not found: ${trdPath}`);
    // Exit 65 = file genuinely absent (distinguishable from parse error).
    // Callers can treat 65 as acceptable ("optional file missing") while
    // still surfacing 1/2/3 as hard failures.
    process.exit(65);
  }

  let data = readRtm();
  if (!data) {
    cmdInit();
    data = readRtm();
  }

  const content = fs.readFileSync(trdPath, 'utf8');
  const entries = parseTRsFromTRD(content);
  let added = 0;
  let skipped = 0;

  for (const [id, entry] of Object.entries(entries)) {
    // v0.47.3 — collision-safe lookup (see cmdImportPrd).
    const existing = findRequirementByCanonicalId(data.requirements, id);
    if (existing) {
      skipped++;
    } else {
      data.requirements[id] = entry;
      added++;
    }
  }

  const sourceTokens = countSourceTokens(content, ['TR']);
  const parsedCount = Object.keys(entries).length;

  if (parsedCount === 0 && sourceTokens > 0) {
    console.error(`  [cobolt-rtm] FAIL: TRD contains ${sourceTokens} TR token(s) but parser extracted 0 definitions.`);
    console.error('  Format drift detected. Accepted definition formats:');
    console.error('    ### TR-001 - Title');
    console.error('    - TR-001: Title');
    console.error('    **TR-001**: Title');
    console.error('    | TR-001 | Title |');
    appendRtmAuditEvent({
      class: 'rtm-import-silent-zero',
      command: 'import-trd',
      source: trdPath,
      sourceTokens,
      parsed: 0,
    });
    if (strict) process.exit(2);
  }

  writeRtm(data);
  console.log(`  Imported from TRD: ${added} added, ${skipped} skipped (already exist)`);
  console.log(`  Total requirements: ${Object.keys(data.requirements).length}`);

  const rtmTrdCount = Object.values(data.requirements).filter((r) => r.source === 'trd').length;
  if (strict && sourceTokens > 0 && rtmTrdCount < sourceTokens) {
    const delta = sourceTokens - rtmTrdCount;
    console.error(
      `  [cobolt-rtm] FAIL: partial drift. TRD source has ${sourceTokens} distinct TR tokens; RTM has ${rtmTrdCount} entries with source='trd'. Missing ${delta}.`,
    );
    appendRtmAuditEvent({
      class: 'rtm-import-partial-drift',
      command: 'import-trd',
      source: trdPath,
      sourceTokens,
      rtmTrdCount,
      delta,
    });
    process.exit(3);
  }
}

function cmdImportImplicit(args) {
  const fileFlag = args.indexOf('--file');
  const filePath =
    fileFlag >= 0 && args[fileFlag + 1] ? args[fileFlag + 1] : resolveSourceArtifact('implicit-requirements.md');
  const strict = !hasFlag(args, '--no-strict');

  if (!fs.existsSync(filePath)) {
    console.error(`  Implicit requirements file not found: ${filePath}`);
    process.exit(65); // genuinely absent — distinguishable from parse error
  }

  let data = readRtm();
  if (!data) {
    cmdInit();
    data = readRtm();
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const entries = parseIRsFromImplicit(content);
  let added = 0;
  let skipped = 0;

  for (const [id, entry] of Object.entries(entries)) {
    // v0.47.3 — collision-safe lookup (see cmdImportPrd).
    const existing = findRequirementByCanonicalId(data.requirements, id);
    if (existing) {
      skipped++;
    } else {
      data.requirements[id] = entry;
      added++;
    }
  }

  const sourceTokens = countSourceTokens(content, ['IR']);
  const parsedCount = Object.keys(entries).length;

  if (parsedCount === 0 && sourceTokens > 0) {
    console.error(
      `  [cobolt-rtm] FAIL: implicit-requirements contains ${sourceTokens} IR token(s) but parser extracted 0 definitions.`,
    );
    console.error('  Format drift detected. Accepted definition formats:');
    console.error('    ### IR-001 - Title [FR-NN]');
    console.error('    - IR-001: Title');
    appendRtmAuditEvent({
      class: 'rtm-import-silent-zero',
      command: 'import-implicit',
      source: filePath,
      sourceTokens,
      parsed: 0,
    });
    if (strict) process.exit(2);
  }

  writeRtm(data);
  console.log(`  Imported implicit requirements: ${added} added, ${skipped} skipped`);
  console.log(`  Total requirements: ${Object.keys(data.requirements).length}`);

  const rtmIrCount = Object.values(data.requirements).filter((r) => r.source === 'implicit').length;
  if (strict && sourceTokens > 0 && rtmIrCount < sourceTokens) {
    const delta = sourceTokens - rtmIrCount;
    console.error(
      `  [cobolt-rtm] FAIL: partial drift. implicit-requirements has ${sourceTokens} distinct IR tokens; RTM has ${rtmIrCount} entries with source='implicit'. Missing ${delta}.`,
    );
    appendRtmAuditEvent({
      class: 'rtm-import-partial-drift',
      command: 'import-implicit',
      source: filePath,
      sourceTokens,
      rtmIrCount,
      delta,
    });
    process.exit(3);
  }
}

function cmdMap(args) {
  const data = readRtm();
  if (!data) {
    console.error('  RTM not initialized. Run: init');
    process.exit(1);
  }

  const requestedReqId = args[0];
  if (!requestedReqId || isFlagToken(requestedReqId)) {
    return autoMapFromPlanningArtifacts(data, args);
  }

  const reqId = requestedReqId ? normalizeRequirementId(requestedReqId) : requestedReqId;
  if (!reqId) {
    console.error('  Usage: map <req-id> --epic <e> --stories <s1,s2>');
    process.exit(1);
  }
  const resolvedReqId = resolveRequirementKey(data, reqId);
  if (!resolvedReqId) {
    console.error(`  Requirement ${reqId} not found`);
    process.exit(1);
  }

  const epic = getFlagValue(args, '--epic');
  const milestone = getFlagValue(args, '--milestone');
  const storiesArg = getFlagValue(args, '--stories');

  if (epic) {
    data.requirements[resolvedReqId].epic = epic;
  }
  if (milestone) {
    setRequirementMilestones(data.requirements[resolvedReqId], [milestone]);
  }
  if (storiesArg) {
    data.requirements[resolvedReqId].stories = storiesArg.split(',').map((s) => s.trim());
  }

  // Auto-advance status
  if (data.requirements[resolvedReqId].epic && data.requirements[resolvedReqId].status === 'pending') {
    // v0.26: Reject mapping requirements with empty acceptance_criteria — they cannot
    // serve as a build handoff artifact. Use --skip-ac-check only for infra/scaffolding
    // requirements where AC comes later, or run `rtm backfill-ac` first.
    const ac = data.requirements[resolvedReqId].acceptance_criteria;
    const hasAc = Array.isArray(ac) && ac.length > 0;
    const skipAcCheck = args.includes('--skip-ac-check');
    if (!hasAc && !skipAcCheck) {
      console.error(
        `  Cannot map ${resolvedReqId}: acceptance_criteria is empty. Either backfill from story/PRD via \`rtm backfill-ac\` or pass --skip-ac-check for deliberately deferred AC (and expect the AC gate to downgrade readiness).`,
      );
      process.exit(1);
    }
    data.requirements[resolvedReqId].status = 'mapped';
  }

  writeRtm(data);
  console.log(
    `  Updated ${resolvedReqId}: epic=${data.requirements[resolvedReqId].epic}, stories=[${data.requirements[resolvedReqId].stories.join(', ')}]`,
  );
}

function cmdMapMilestone(args) {
  const requestedReqId = args[0];
  const reqId = requestedReqId ? normalizeRequirementId(requestedReqId) : requestedReqId;
  if (!reqId) {
    console.error('  Usage: map-milestone <req-id> --milestone <M1>');
    process.exit(1);
  }

  const data = readRtm();
  if (!data) {
    console.error('  RTM not initialized. Run: init');
    process.exit(1);
  }
  const resolvedReqId = resolveRequirementKey(data, reqId);
  if (!resolvedReqId) {
    console.error(`  Requirement ${reqId} not found`);
    process.exit(1);
  }

  const msIdx = args.indexOf('--milestone');
  if (msIdx < 0 || !args[msIdx + 1]) {
    console.error('  --milestone <M1> required');
    process.exit(1);
  }

  setRequirementMilestones(data.requirements[resolvedReqId], [args[msIdx + 1]]);
  writeRtm(data);
  console.log(`  ${resolvedReqId} assigned to milestone ${args[msIdx + 1]}`);
}

// ── Multi-milestone helpers (v0.24+ — closes H-1 silent cross-milestone loss) ──

// setRequirementMilestones + getRequirementMilestones moved to
// lib/cobolt-rtm-coverage.js (re-imported above).

function cmdMapMilestones(args) {
  // Multi-milestone assignment. Use for requirements whose delivery/gating
  // legitimately spans >1 milestone (split FRs, cross-phase NFRs, gates live
  // in Mn with completion in Mm).
  //
  // Usage:
  //   map-milestones <req-id> --milestones M1,M2[,M3]
  //                           [--phasing 'M1=scope text']
  //                           [--phasing 'M2=scope text']
  const requestedReqId = args[0];
  const reqId = requestedReqId ? normalizeRequirementId(requestedReqId) : requestedReqId;
  if (!reqId) {
    console.error('  Usage: map-milestones <req-id> --milestones M1,M2 [--phasing "M1=scope"] [--phasing "M2=scope"]');
    process.exit(1);
  }

  const data = readRtm();
  if (!data) {
    console.error('  RTM not initialized. Run: init');
    process.exit(1);
  }
  const resolvedReqId = resolveRequirementKey(data, reqId);
  if (!resolvedReqId) {
    console.error(`  Requirement ${reqId} not found`);
    process.exit(1);
  }

  const msArg = getFlagValue(args, '--milestones');
  if (!msArg) {
    console.error('  --milestones M1,M2[,M3] required');
    process.exit(1);
  }
  const milestones = msArg
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  if (!milestones.every((m) => /^M\d+$/.test(m))) {
    console.error(`  Invalid milestone format in --milestones ${msArg}. Expected M1,M2,... pattern.`);
    process.exit(1);
  }

  // Collect all --phasing entries (can repeat).
  const phasing = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--phasing' && args[i + 1]) {
      const raw = args[i + 1];
      const eq = raw.indexOf('=');
      if (eq > 0) {
        const key = raw.slice(0, eq).trim();
        const val = raw.slice(eq + 1).trim();
        if (/^M\d+$/.test(key)) {
          phasing[key] = { scope: val, status: 'pending' };
        }
      }
    }
  }

  setRequirementMilestones(data.requirements[resolvedReqId], milestones, phasing);
  writeRtm(data);
  console.log(`  ${resolvedReqId} assigned to milestones [${milestones.join(', ')}]`);
  if (Object.keys(phasing).length > 0) {
    for (const [k, v] of Object.entries(phasing)) {
      console.log(`    ${k}: ${v.scope}`);
    }
  }
}

function cmdBackfillAc(args) {
  // D-1 fix: backfill acceptance_criteria on mapped requirements by harvesting
  // AC sections from story files referenced in story-tracker. No-op for already
  // populated requirements.
  const data = readRtm();
  if (!data) {
    console.error('  RTM not initialized. Run: init');
    process.exit(1);
  }
  const pd = getPlanningDir(process.cwd(), { create: false, strict: false, fallbackToLatest: true });
  if (!pd || !fs.existsSync(pd)) {
    console.error('  planning/ not found');
    process.exit(1);
  }
  const st = readJsonIfExists(path.join(pd, 'story-tracker.json'));
  const stories = Array.isArray(st?.stories) ? st.stories : [];
  if (stories.length === 0) {
    console.error('  story-tracker.json missing or empty; run cobolt-tracker-init first');
    process.exit(1);
  }

  const storiesDir = path.join(pd, 'stories');
  const storyAcCache = new Map();
  // Build a prefix index so we can match canonical filenames like
  // `E1-S1-scaffold-openai-compat-runtime-handlers.md` from a bare id `E1-S1`.
  const storyFileIndex = new Map();
  if (fs.existsSync(storiesDir)) {
    for (const f of fs.readdirSync(storiesDir)) {
      if (!f.endsWith('.md')) continue;
      // canonical: `<storyId>-<slug>.md` OR `<storyId>.md` OR `story-<storyId>.md`
      let m = f.match(/^([A-Z][A-Z0-9_]*-S\d+)(?:-[^.]*)?\.md$/);
      if (!m) m = f.match(/^story-([A-Z][A-Z0-9_]*-S\d+)(?:-[^.]*)?\.md$/);
      if (!m) continue;
      const id = m[1];
      if (!storyFileIndex.has(id)) storyFileIndex.set(id, []);
      storyFileIndex.get(id).push(path.join(storiesDir, f));
    }
  }

  const extractAcFromStoryFile = (storyId) => {
    if (storyAcCache.has(storyId)) return storyAcCache.get(storyId);
    const candidates = [
      ...(storyFileIndex.get(storyId) || []),
      path.join(storiesDir, `story-${storyId}.md`),
      path.join(storiesDir, `${storyId}.md`),
    ];
    for (const f of candidates) {
      if (!fs.existsSync(f)) continue;
      const content = fs.readFileSync(f, 'utf8');
      // v0.40.9 — lookahead terminators MUST NOT include `$` with the /m flag:
      // `$` matches end-of-line which short-circuits the section to its header.
      // Terminate only at the next markdown header, an `---` divider, or the
      // true end of the document (no more text after) via `(?![\s\S])`.
      const acSection = content.match(/^##+\s+Acceptance\s+Criteria[\s\S]*?(?=\n##+\s|\n---\s*\n|(?![\s\S]))/im);
      if (!acSection) continue;
      const bullets = [...acSection[0].matchAll(/^[-*+]\s+(.+)$/gm)].map((m) => m[1].trim());
      if (bullets.length > 0) {
        storyAcCache.set(storyId, bullets);
        return bullets;
      }
    }
    storyAcCache.set(storyId, []);
    return [];
  };

  const collectReqIds = (story) => {
    const values = [
      ...(story.requirementIds || []),
      ...(story.requirements || []),
      ...(story.frIds || []),
      ...(story.nfrIds || []),
      ...(story.trIds || []),
      ...(story.irIds || []),
      story.FR,
      story.NFR,
      story.TR,
      story.IR,
      story.fr,
      story.nfr,
      story.tr,
      story.ir,
      story.requirement,
      story.requirementId,
    ];
    const refs = [];
    for (const value of values) {
      if (Array.isArray(value)) {
        refs.push(...value);
        continue;
      }
      const text = String(value || '');
      for (const match of text.matchAll(/\b(?:FR|NFR|TR|IR)-?\d{1,5}\b/gi)) {
        refs.push(match[0]);
      }
    }
    return refs;
  };

  // Build reverse index: req -> [story objects]
  const storiesByReq = new Map();
  for (const story of stories) {
    for (const rawReq of collectReqIds(story)) {
      const reqId = normalizeRequirementId(rawReq);
      if (!reqId) continue;
      if (!storiesByReq.has(reqId)) storiesByReq.set(reqId, []);
      storiesByReq.get(reqId).push(story);
    }
  }

  let requirementsTouched = 0;
  let storiesLinked = 0;
  let acAdded = 0;

  for (const [reqId, linkedStories] of storiesByReq) {
    const resolved = resolveRequirementKey(data, reqId);
    if (!resolved) continue;
    const req = data.requirements[resolved];
    if (!req) continue;
    let changed = false;
    const linkedStoryIds = [...new Set(linkedStories.map((story) => story?.id).filter(Boolean))];
    const linkedEpics = [...new Set(linkedStories.map((story) => story?.epic).filter(Boolean))];
    const linkedMilestones = sortMilestoneIds(linkedStories.map((story) => story?.milestone));

    // Backfill stories
    for (const storyId of linkedStoryIds) {
      if (!Array.isArray(req.stories)) req.stories = [];
      if (!req.stories.includes(storyId)) {
        req.stories.push(storyId);
        storiesLinked += 1;
        changed = true;
      }
    }

    // Reconcile epic and milestone attribution from the current story tracker.
    // Rebalanced plans must not leave RTM entries pinned to stale milestones.
    if (linkedEpics.length > 0) {
      if (linkedEpics.length === 1) {
        if (req.epic !== linkedEpics[0]) {
          req.epic = linkedEpics[0];
          changed = true;
        }
        if (!sameStringArray(Array.isArray(req.epics) ? req.epics : [], linkedEpics)) {
          req.epics = linkedEpics;
          changed = true;
        }
      } else {
        if (!sameStringArray(Array.isArray(req.epics) ? req.epics : [], linkedEpics)) {
          req.epics = linkedEpics;
          changed = true;
        }
        if (req.epic !== linkedEpics[0]) {
          req.epic = linkedEpics[0];
          changed = true;
        }
      }
    }

    if (linkedMilestones.length > 0) {
      const currentMilestones = sortMilestoneIds(getRequirementMilestones(req));
      const explicitMilestones = sortMilestoneIds(Array.isArray(req.milestones) ? req.milestones : []);
      const needsMilestoneReconcile =
        !sameStringArray(currentMilestones, linkedMilestones) ||
        !sameStringArray(explicitMilestones, linkedMilestones) ||
        req.milestone !== linkedMilestones[0];
      if (needsMilestoneReconcile) {
        const existingPhasing =
          req.milestone_phasing &&
          typeof req.milestone_phasing === 'object' &&
          linkedMilestones.every((milestone) => Object.hasOwn(req.milestone_phasing, milestone))
            ? req.milestone_phasing
            : undefined;
        setRequirementMilestones(req, linkedMilestones, existingPhasing);
        changed = true;
      }
    }

    // Backfill acceptance_criteria from each linked story file
    if (!Array.isArray(req.acceptance_criteria)) req.acceptance_criteria = [];
    const existingAc = new Set(req.acceptance_criteria.map((x) => String(x).trim()));
    for (const storyId of linkedStoryIds) {
      for (const ac of extractAcFromStoryFile(storyId)) {
        const key = String(ac).trim();
        if (key && !existingAc.has(key)) {
          req.acceptance_criteria.push(ac);
          existingAc.add(key);
          acAdded += 1;
          changed = true;
        }
      }
    }

    if (req.stories.length > 0 && req.status === 'pending') {
      req.status = 'mapped';
      changed = true;
    }
    if (changed) requirementsTouched += 1;
  }

  writeRtm(data);
  console.log(
    `  Backfilled ${requirementsTouched} requirement(s): +${storiesLinked} story links, +${acAdded} acceptance criteria`,
  );
  if (hasFlag(args, '--json')) {
    console.log(
      JSON.stringify(
        { requirementsTouched, storiesLinked, acAdded, total: Object.keys(data.requirements).length },
        null,
        2,
      ),
    );
  }
}

function cmdScan(args) {
  const data = readRtm();
  if (!data) {
    console.error('  RTM not initialized. Run: init');
    process.exit(1);
  }

  const dirIdx = args.indexOf('--dir');
  const scanDirs = [];
  if (dirIdx >= 0 && args[dirIdx + 1]) {
    scanDirs.push(args[dirIdx + 1]);
  } else {
    // Default scan directories
    for (const d of ['src', 'app', 'lib', 'server', 'api', 'pages', 'components']) {
      if (fs.existsSync(path.join(process.cwd(), d))) scanDirs.push(d);
    }
  }

  if (scanDirs.length === 0) {
    console.log('  No source directories found to scan.');
    return;
  }

  const reqIds = Object.keys(data.requirements);
  let codeFound = 0;
  let testFound = 0;
  const now = new Date().toISOString();
  const testDirs = ['tests', 'test', '__tests__', 'spec'].filter((d) => fs.existsSync(path.join(process.cwd(), d)));
  const evidenceDirs = [...new Set([...scanDirs, ...testDirs])];

  for (const reqId of reqIds) {
    const requirement = data.requirements[reqId];
    const candidateFiles = collectRequirementCandidateFiles(process.cwd(), reqId, {
      requirementRecord: requirement,
    });
    const evidence = findRequirementEvidence(process.cwd(), reqId, { directories: evidenceDirs });
    const contentEvidence = findRequirementContentEvidence(process.cwd(), requirement, {
      candidateFiles,
    });
    const codeMatches = dedupeEvidenceMatches(
      [...evidence.codeMatches, ...contentEvidence.codeMatches].filter((match) => !match.hasStubSignals),
    );
    const newEvidence = codeMatches
      .filter((match) => !data.requirements[reqId].code_evidence.some((entry) => entry.file === match.file))
      .map((match) => buildCodeEvidenceRecord(match, now));

    if (newEvidence.length > 0) {
      data.requirements[reqId].code_evidence.push(...newEvidence);
      codeFound++;
      if (['pending', 'mapped'].includes(data.requirements[reqId].status)) {
        data.requirements[reqId].status = 'coded';
      }
    }

    const testMatches = dedupeEvidenceMatches([...evidence.testMatches, ...contentEvidence.testMatches]);
    const newTests = testMatches
      .filter((match) => !data.requirements[reqId].test_evidence.some((entry) => entry.file === match.file))
      .map((match) => buildTestEvidenceRecord(reqId, match));

    if (newTests.length > 0) {
      data.requirements[reqId].test_evidence.push(...newTests);
      testFound++;
      if (['pending', 'mapped', 'coded', 'tested'].includes(data.requirements[reqId].status)) {
        data.requirements[reqId].status = 'tested';
      }
    }

    // Reference scans are linkage evidence, not semantic validation.
    // Preserve explicit covered status when it already exists, but do not
    // auto-promote to covered solely because an ID is mentioned in code/tests.
    if (data.requirements[reqId].code_evidence.length > 0 && data.requirements[reqId].test_evidence.length > 0) {
      if (data.requirements[reqId].status !== 'covered') {
        data.requirements[reqId].status = 'tested';
      }
    }
  }

  // Cross-reference with test-registry if it exists
  const testRegistryPath = path.join(process.cwd(), '_cobolt-output/test-registry/test-registry.json');
  if (fs.existsSync(testRegistryPath)) {
    try {
      const registry = JSON.parse(fs.readFileSync(testRegistryPath, 'utf8'));
      if (registry.lineage?.requirements) {
        for (const [reqId, tcIds] of Object.entries(registry.lineage.requirements)) {
          const resolvedReqId = resolveRequirementKey(data, reqId);
          if (resolvedReqId && Array.isArray(tcIds)) {
            for (const tcId of tcIds) {
              if (!data.requirements[resolvedReqId].test_evidence.some((e) => e.case_id === tcId)) {
                data.requirements[resolvedReqId].test_evidence.push({ case_id: tcId, file: '', status: 'pass' });
                testFound++;
              }
            }
            if (
              data.requirements[resolvedReqId].code_evidence.length > 0 &&
              data.requirements[resolvedReqId].test_evidence.length > 0
            ) {
              if (data.requirements[resolvedReqId].status !== 'covered') {
                data.requirements[resolvedReqId].status = 'tested';
              }
            }
          }
        }
      }
    } catch (_e) {
      // Test registry parse error - skip
    }
  }

  writeRtm(data);
  console.log(`  Scan complete: ${codeFound} requirements found in code, ${testFound} found in tests`);
  cmdStatus();
}

function getFlagValue(args, flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function buildCoverageReport(requirements, threshold, milestone, rawMode) {
  const items = requirements.map((req) => ({
    id: req.id,
    title: req.title,
    status: req.status,
    milestone: req.milestone || null,
    type: req.type,
    priority: req.priority,
  }));

  const counts = {
    covered: items.filter((req) => req.status === 'covered').length,
    tested: items.filter((req) => req.status === 'tested').length,
    coded: items.filter((req) => req.status === 'coded').length,
    mapped: items.filter((req) => req.status === 'mapped').length,
    pending: items.filter((req) => req.status === 'pending').length,
    gap: items.filter((req) => req.status === 'gap').length,
  };

  const coverageResult = coverageForMode(items, rawMode);

  return {
    milestone: milestone || null,
    mode: coverageResult.mode,
    threshold,
    totalRequirements: items.length,
    coverage: coverageResult.coverage,
    qualifiedCount: coverageResult.qualifying,
    passed: coverageResult.coverage >= threshold,
    counts,
    requirements: items,
  };
}

function cmdCheck(args) {
  const data = readRtm();
  if (!data) {
    console.error('  RTM not initialized. Run: init');
    process.exit(1);
  }

  const threshold = parseFloat(getFlagValue(args, '--threshold') || '85');
  const milestone = getFlagValue(args, '--milestone');
  const jsonOutput = hasFlag(args, '--json');
  const outputPath = getFlagValue(args, '--output');
  const mode = normalizeCoverageMode(getFlagValue(args, '--mode'));
  // v0.12.0: --type non-functional,technical  (CSV of req types)
  const typeFilter = getFlagValue(args, '--type');
  const typeSet = typeFilter ? new Set(typeFilter.split(',').map((t) => t.trim())) : null;

  const requirements = Object.values(data.requirements).filter(
    (req) => (!milestone || getRequirementMilestones(req).includes(milestone)) && (!typeSet || typeSet.has(req.type)),
  );

  // Empty-RTM edge case: a 0-requirement RTM cannot satisfy a meaningful
  // coverage gate. Even with --threshold 0, an empty RTM is a failure state
  // (nothing to measure). Only `--allow-empty` can override (tests, first-run).
  if (requirements.length === 0 && !hasFlag(args, '--allow-empty')) {
    const msg = milestone
      ? `0 requirements in scope for milestone=${milestone}. Empty scope cannot satisfy coverage gate.`
      : '0 requirements in RTM. Empty RTM cannot satisfy coverage gate. Run import-prd/import-trd/import-implicit first.';
    if (jsonOutput) {
      console.log(JSON.stringify({ passed: false, error: 'empty-scope', message: msg }, null, 2));
    } else {
      console.error(`  RTM CHECK FAIL: ${msg}`);
    }
    process.exit(7);
  }

  const report = buildCoverageReport(requirements, threshold, milestone, mode);

  if (outputPath) {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
  }

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.passed ? 0 : 1);
  }

  if (report.passed) {
    console.log(`  RTM PASS: ${report.coverage}% ${report.mode} coverage (threshold: ${threshold}%)`);
    console.log(`  ${report.qualifiedCount} ${report.mode} / ${report.totalRequirements} total`);
    process.exit(0);
  }

  console.error(`  RTM FAIL: ${report.coverage}% ${report.mode} coverage (threshold: ${threshold}%)`);
  console.error(`  ${report.qualifiedCount} ${report.mode} / ${report.totalRequirements} total`);
  console.error('');

  const qualifyingStatuses = new Set(COVERAGE_MODES[report.mode].qualifyingStatuses);
  const gaps = report.requirements.filter((req) => !qualifyingStatuses.has(req.status));
  if (gaps.length > 0) {
    console.error(`  Requirements missing ${report.mode} evidence:`);
    for (const gap of gaps.slice(0, 20)) {
      console.error(`    ${gap.id}: ${gap.title} [${gap.status}] (${gap.priority})`);
    }
    if (gaps.length > 20) console.error(`    ... and ${gaps.length - 20} more`);
  }
  process.exit(1);
}

function cmdStatus(args = []) {
  const data = readRtm();
  if (!data) {
    console.error('  RTM not initialized. Run: init');
    process.exit(1);
  }

  const jsonOutput = hasFlag(args, '--json');
  const milestone = getFlagValue(args, '--milestone');
  const mode = normalizeCoverageMode(getFlagValue(args, '--mode'));
  const requirements = Object.values(data.requirements).filter(
    (req) => !milestone || getRequirementMilestones(req).includes(milestone),
  );
  const report = buildCoverageReport(requirements, 0, milestone, mode);
  const cov = data.metadata.coverageSummary;
  const total = milestone ? report.totalRequirements : cov.total;

  if (jsonOutput) {
    console.log(JSON.stringify({ ...report, summary: cov }, null, 2));
    return;
  }

  console.log('');
  console.log('  RTM Coverage Status');
  console.log('  =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-');
  console.log(`  Total Requirements: ${total}`);

  if (total === 0) {
    console.log('  (empty --- run import commands to populate)');
    return;
  }

  // By type
  console.log('');
  console.log('  By Type:');
  for (const [type, count] of Object.entries(cov.byType)) {
    if (count > 0)
      console.log(`    ${type.padEnd(16)} ${String(count).padStart(4)}  (${((count / total) * 100).toFixed(1)}%)`);
  }

  // By status
  console.log('');
  console.log('  By Status:');
  const statusOrder = ['covered', 'tested', 'coded', 'mapped', 'pending', 'gap'];
  for (const s of statusOrder) {
    const count = cov.byStatus[s] || 0;
    if (count > 0) {
      const bar = '#'.repeat(Math.round((count / total) * 30));
      console.log(`    ${s.padEnd(10)} ${String(count).padStart(4)}  (${((count / total) * 100).toFixed(1)}%)  ${bar}`);
    }
  }

  // By milestone
  if (Object.keys(cov.byMilestone).length > 0) {
    console.log('');
    console.log('  By Milestone:');
    for (const [ms, msData] of Object.entries(cov.byMilestone)) {
      const mappedPct = msData.total > 0 ? ((msData.mapped / msData.total) * 100).toFixed(1) : '0.0';
      const coveredPct = msData.total > 0 ? ((msData.covered / msData.total) * 100).toFixed(1) : '0.0';
      console.log(
        `    ${ms.padEnd(14)} ${msData.mapped}/${msData.total} mapped (${mappedPct}%), ${msData.covered}/${msData.total} covered (${coveredPct}%)`,
      );
    }
  }

  // Overall
  console.log('');
  console.log(`  Mapping Coverage: ${cov.mappedPercentage}%`);
  console.log(`  Validated Coverage: ${cov.validatedPercentage}%`);
  console.log('');
}

function cmdReport(args) {
  const data = readRtm();
  if (!data) {
    console.error('  RTM not initialized. Run: init');
    process.exit(1);
  }

  const fmtIdx = args.indexOf('--format');
  const format = fmtIdx >= 0 && args[fmtIdx + 1] ? args[fmtIdx + 1] : 'md';

  if (format === 'json') {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // Markdown report
  const lines = [];
  const cov = data.metadata.coverageSummary;

  lines.push('# Requirements Traceability Matrix Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  // v0.48 — distinguish mapped-coverage (planning) from validated-coverage
  // (post-test). Previously this line rendered `cov.percentage` which is
  // aliased to validatedPercentage in lib/cobolt-rtm-coverage.js — during
  // planning that is always 0%, producing the false-alarm "Coverage: 0%"
  // header even when every requirement had been mapped to a story.
  const mappedPct = typeof cov.mappedPercentage === 'number' ? cov.mappedPercentage : cov.percentage;
  const validatedPct = typeof cov.validatedPercentage === 'number' ? cov.validatedPercentage : cov.percentage;
  lines.push(`Total Requirements: ${cov.total} | Mapped: ${mappedPct}% | Validated: ${validatedPct}%`);
  lines.push('');

  // Summary table
  lines.push('## Coverage Summary');
  lines.push('');
  lines.push('| Status | Count | Percentage |');
  lines.push(
    '|----------------------------------------|----------------------------------------|----------------------------------------|',
  );
  for (const s of ['covered', 'tested', 'coded', 'mapped', 'pending', 'gap']) {
    const count = cov.byStatus[s] || 0;
    if (count > 0) {
      lines.push(`| ${s} | ${count} | ${((count / cov.total) * 100).toFixed(1)}% |`);
    }
  }
  lines.push('');

  // By type
  lines.push('## By Requirement Type');
  lines.push('');
  lines.push('| Type | Count |');
  lines.push('|----------------------------------------|----------------------------------------|');
  for (const [type, count] of Object.entries(cov.byType)) {
    if (count > 0) lines.push(`| ${type} | ${count} |`);
  }
  lines.push('');

  // Full traceability
  lines.push('## Full Traceability Matrix');
  lines.push('');
  lines.push('| ID | Title | Type | Priority | Milestone | Epic | Stories | Code | Tests | Status |');
  lines.push(
    '|----------------------------------------|----------------------------------------|----------------------------------------|----------------------------------------|----------------------------------------|----------------------------------------|----------------------------------------|----------------------------------------|----------------------------------------|----------------------------------------|',
  );

  const sorted = Object.values(data.requirements).sort((a, b) => a.id.localeCompare(b.id));
  for (const r of sorted) {
    const code = r.code_evidence.length > 0 ? `${r.code_evidence.length} files` : '-';
    const tests = r.test_evidence.length > 0 ? `${r.test_evidence.length} cases` : '-';
    lines.push(
      `| ${r.id} | ${r.title.slice(0, 40)} | ${r.type} | ${r.priority} | ${r.milestone || '-'} | ${r.epic || '-'} | ${r.stories.join(', ') || '-'} | ${code} | ${tests} | ${r.status} |`,
    );
  }
  lines.push('');

  // Gaps section
  const gaps = sorted.filter((r) => r.status === 'gap' || r.status === 'pending');
  if (gaps.length > 0) {
    lines.push('## Gap Analysis');
    lines.push('');
    lines.push('The following requirements need attention:');
    lines.push('');
    for (const g of gaps) {
      lines.push(`- **${g.id}**: ${g.title} [${g.priority}] --- Status: ${g.status}`);
    }
    lines.push('');
  }

  const report = lines.join('\n');

  // Write report file
  const reportPath = path.join(planningDir(), 'rtm-report.md');
  fs.writeFileSync(reportPath, report, 'utf8');
  console.log(`  Report generated: ${reportPath}`);
}

// - Render Matrix (deterministic traceability-matrix.md) -

/**
 * Extract API endpoint references from api-contracts.md.
 * Returns Map<reqId, string[]> mapping requirement IDs to endpoint paths.
 */
function extractApiEndpoints(apiPath) {
  const map = new Map();
  if (!fs.existsSync(apiPath)) return map;
  const content = fs.readFileSync(apiPath, 'utf8');
  const lines = content.split('\n');
  let currentEndpoint = null;

  for (const line of lines) {
    // Match endpoint headers: ### GET /api/users, ### POST /api/auth/login
    const epMatch = line.match(/^###?\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S+)/i);
    if (epMatch) {
      currentEndpoint = `${epMatch[1].toUpperCase()} ${epMatch[2]}`;
      continue;
    }

    // Collect FR/NFR refs within endpoint scope
    if (currentEndpoint) {
      const refs = line.match(/\b(?:FR|NFR(?:-D2)?|TR|IR)-(?:[A-Z]{2,5}-)?\d{1,4}\b/g);
      if (refs) {
        for (const raw of refs) {
          // v0.47.3 — canonicalize on insertion so lookups from
          // cmdRenderMatrix (which query canonical rtm keys) find the cell.
          // Pre-v0.47.3 this stored raw short-form tokens like `FR-1`, which
          // never matched the padded rtm key `FR-001` → API column rendered
          // `-` for every requirement on projects using short-form refs.
          const ref = canonicalIdOrFallback(raw) || raw;
          if (!map.has(ref)) map.set(ref, []);
          if (!map.get(ref).includes(currentEndpoint)) {
            map.get(ref).push(currentEndpoint);
          }
        }
      }
      // Reset on next heading
      if (line.match(/^##[^#]/)) currentEndpoint = null;
    }
  }
  return map;
}

/**
 * Extract UX screen references from ux-design-specification.md.
 * Returns Map<reqId, string[]> mapping requirement IDs to screen names.
 */
function extractUxScreens(uxPath) {
  const map = new Map();
  if (!fs.existsSync(uxPath)) return map;
  const content = fs.readFileSync(uxPath, 'utf8');
  const lines = content.split('\n');
  let currentScreen = null;

  for (const line of lines) {
    // Match screen headers: ## Screen: Dashboard, ## Login Screen, ### Screen: Profile
    const scrMatch = line.match(/^###?\s+(?:Screen[:\s]+)?(.+)/i);
    if (scrMatch && !scrMatch[1].match(/^\d/) && scrMatch[1].length < 60) {
      currentScreen = scrMatch[1].trim();
      continue;
    }

    // Collect FR/NFR refs within screen scope
    if (currentScreen) {
      const refs = line.match(/\b(?:FR|NFR(?:-D2)?|TR|IR)-(?:[A-Z]{2,5}-)?\d{1,4}\b/g);
      if (refs) {
        for (const raw of refs) {
          // v0.47.3 — canonicalize on insertion (see extractApiEndpoints).
          const ref = canonicalIdOrFallback(raw) || raw;
          if (!map.has(ref)) map.set(ref, []);
          if (!map.get(ref).includes(currentScreen)) {
            map.get(ref).push(currentScreen);
          }
        }
      }
    }
  }
  return map;
}

function cmdRenderMatrix(_args) {
  const data = readRtm();
  if (!data) {
    console.error('  RTM not initialized. Run: init');
    process.exit(1);
  }

  const pd = planningDir();

  // Cross-reference: API endpoints
  const apiEndpoints = extractApiEndpoints(path.join(pd, 'api-contracts.md'));
  // Cross-reference: UX screens
  const uxScreens = extractUxScreens(path.join(pd, 'ux-design-specification.md'));

  const cov = data.metadata.coverageSummary;
  // v0.47.2 — sort with numeric collation so legacy rtm.json files that stored
  // short-form keys (FR-1, FR-10, FR-2, …) still render in numerically-correct
  // order. New emissions are canonicalized at import time and sort correctly
  // under default lex order, but numeric collation is a belt-and-suspenders
  // guard.
  const sorted = Object.values(data.requirements).sort((a, b) =>
    a.id.localeCompare(b.id, undefined, { numeric: true }),
  );

  const lines = [];
  lines.push('# Traceability Matrix');
  lines.push('');
  lines.push(`> Auto-generated by \`node tools/cobolt-rtm.js render-matrix\` --- ${new Date().toISOString()}`);
  // v0.48 — RAID101 fix: show mapped + validated coverage separately.
  // cov.percentage is validatedPercentage (post-test) which is always 0% at
  // plan-close and produced the false "Coverage: 0%" header.
  {
    const mappedPct = typeof cov.mappedPercentage === 'number' ? cov.mappedPercentage : cov.percentage;
    const validatedPct = typeof cov.validatedPercentage === 'number' ? cov.validatedPercentage : cov.percentage;
    lines.push(`> Total Requirements: ${cov.total} | Mapped: ${mappedPct}% | Validated: ${validatedPct}%`);
  }
  lines.push('');

  // Full matrix table
  lines.push('## Full Traceability');
  lines.push('');
  lines.push(
    '| Req ID | Type | Description | Milestone | Epic | Story | API Endpoint | UX Screen | Test | Evidence | Status |',
  );
  lines.push(
    '|----------------------------------------|----------------------------------------|----------------------------------------|----------------------------------------|----------------------------------------|----------------------------------------|----------------------------------------|----------------------------------------|----------------------------------------|----------------------------------------|----------------------------------------|',
  );

  for (const r of sorted) {
    const desc = (r.title || r.description || '').slice(0, 50);
    const api = apiEndpoints.has(r.id) ? apiEndpoints.get(r.id).join(', ') : '-';
    const ux = uxScreens.has(r.id) ? uxScreens.get(r.id).join(', ') : '-';
    const code = r.code_evidence.length > 0 ? `${r.code_evidence.length} files` : '-';
    const tests = r.test_evidence.length > 0 ? `${r.test_evidence.length} cases` : '-';
    lines.push(
      `| ${r.id} | ${r.type} | ${desc} | ${r.milestone || '-'} | ${r.epic || '-'} | ${r.stories.join(', ') || '-'} | ${api} | ${ux} | ${tests} | ${code} | ${r.status} |`,
    );
  }
  lines.push('');

  // Coverage by type
  lines.push('## Coverage by Type');
  lines.push('');
  lines.push('| Type | Total | Mapped | Coded | Tested | Covered | Pending |');
  lines.push(
    '|----------------------------------------|----------------------------------------|----------------------------------------|----------------------------------------|----------------------------------------|----------------------------------------|----------------------------------------|',
  );
  for (const [label, typeValue] of [
    ['FR', 'functional'],
    ['NFR', 'non-functional'],
    ['TR', 'technical'],
    ['IR', 'implicit'],
  ]) {
    const reqs = sorted.filter((r) => r.type === typeValue);
    if (reqs.length === 0) continue;
    const mapped = reqs.filter((r) => r.status === 'mapped').length;
    const coded = reqs.filter((r) => r.status === 'coded').length;
    const tested = reqs.filter((r) => r.status === 'tested').length;
    const covered = reqs.filter((r) => r.status === 'covered').length;
    const pending = reqs.filter((r) => r.status === 'pending' || r.status === 'gap').length;
    lines.push(`| ${label} | ${reqs.length} | ${mapped} | ${coded} | ${tested} | ${covered} | ${pending} |`);
  }
  lines.push('');

  // Coverage gaps
  const gaps = [];
  for (const r of sorted) {
    const missing = [];
    if (!r.milestone) missing.push('milestone');
    if (!r.epic) missing.push('epic');
    if (r.stories.length === 0) missing.push('stories');
    if (r.test_evidence.length === 0) missing.push('tests');
    if (r.code_evidence.length === 0) missing.push('code');
    if (missing.length > 0) gaps.push({ id: r.id, title: r.title, status: r.status, missing });
  }

  if (gaps.length > 0) {
    lines.push('## Coverage Gaps');
    lines.push('');
    lines.push(`${gaps.length} of ${sorted.length} requirements have incomplete traceability:`);
    lines.push('');
    lines.push('| Req ID | Status | Missing |');
    lines.push(
      '|----------------------------------------|----------------------------------------|----------------------------------------|',
    );
    for (const g of gaps) {
      lines.push(`| ${g.id} | ${g.status} | ${g.missing.join(', ')} |`);
    }
    lines.push('');
  }

  // Summary stats
  const fullyCovered = sorted.filter((r) => r.status === 'covered').length;
  const pct = sorted.length > 0 ? ((fullyCovered / sorted.length) * 100).toFixed(1) : '0.0';
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **${fullyCovered} of ${sorted.length}** requirements fully covered (${pct}%)`);
  lines.push(`- **${gaps.length}** requirements have coverage gaps`);
  lines.push(`- **${apiEndpoints.size}** requirements mapped to API endpoints`);
  lines.push(`- **${uxScreens.size}** requirements mapped to UX screens`);
  lines.push('');

  const report = lines.join('\n');
  const outPath = path.join(pd, 'traceability-matrix.md');
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outPath, report, 'utf8');

  console.log(`  Traceability matrix generated: ${outPath}`);
  console.log(`  Requirements: ${sorted.length} | Fully covered: ${fullyCovered} (${pct}%) | Gaps: ${gaps.length}`);
}

function cmdUpdate(args) {
  const milestone = getFlagValue(args, '--milestone');
  const setStatus = getFlagValue(args, '--set-status') || getFlagValue(args, '--status');

  if (milestone) {
    if (!setStatus) {
      console.error('  Usage: update --milestone <m> --set-status <status>');
      process.exit(1);
    }

    const data = readRtm();
    if (!data) {
      console.error('  RTM not initialized. Run: init');
      process.exit(1);
    }

    const matches = Object.values(data.requirements).filter((req) => getRequirementMilestones(req).includes(milestone));
    if (matches.length === 0) {
      console.error(`  No requirements found for milestone ${milestone}`);
      process.exit(1);
    }

    for (const req of matches) {
      req.status = setStatus;
    }

    writeRtm(data);
    console.log(`  Updated ${matches.length} requirement(s) in ${milestone} to status=${setStatus}`);
    return;
  }

  const requestedReqId = args[0];
  const reqId = requestedReqId ? normalizeRequirementId(requestedReqId) : requestedReqId;
  if (!reqId) {
    console.error('  Usage: update <req-id> --field <f> --value <v>');
    process.exit(1);
  }

  const data = readRtm();
  if (!data) {
    console.error('  RTM not initialized. Run: init');
    process.exit(1);
  }
  const resolvedReqId = resolveRequirementKey(data, reqId);
  if (!resolvedReqId) {
    console.error(`  Requirement ${reqId} not found`);
    process.exit(1);
  }

  const fieldIdx = args.indexOf('--field');
  const valueIdx = args.indexOf('--value');

  if (fieldIdx < 0 || !args[fieldIdx + 1]) {
    console.error('  --field required');
    process.exit(1);
  }
  if (valueIdx < 0 || !args[valueIdx + 1]) {
    console.error('  --value required');
    process.exit(1);
  }

  const field = args[fieldIdx + 1];
  let value = args[valueIdx + 1];

  // Auto-parse JSON values
  try {
    value = JSON.parse(value);
  } catch (_e) {
    /* keep as string */
  }

  const allowedFields = [
    'status',
    'priority',
    'milestone',
    'milestones',
    'milestone_phasing',
    'epic',
    'title',
    'description',
  ];
  if (!allowedFields.includes(field)) {
    console.error(`  Field must be one of: ${allowedFields.join(', ')}`);
    process.exit(1);
  }

  const req = data.requirements[resolvedReqId];
  if (field === 'milestone') {
    if (typeof value !== 'string' || !/^M\d+$/.test(value)) {
      console.error('  milestone value must be a single M{n} identifier');
      process.exit(1);
    }
    setRequirementMilestones(req, [value]);
  } else if (field === 'milestones') {
    const milestones = Array.isArray(value)
      ? value
      : String(value)
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);
    if (milestones.length === 0 || milestones.some((m) => typeof m !== 'string' || !/^M\d+$/.test(m))) {
      console.error('  milestones value must be an array or comma-separated list of M{n} identifiers');
      process.exit(1);
    }
    setRequirementMilestones(req, milestones);
  } else if (field === 'milestone_phasing') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      console.error('  milestone_phasing value must be a JSON object');
      process.exit(1);
    }
    const currentMilestones = getRequirementMilestones(req);
    setRequirementMilestones(req, currentMilestones.length > 0 ? currentMilestones : Object.keys(value), value);
  } else {
    req[field] = value;
  }
  writeRtm(data);
  console.log(`  Updated ${resolvedReqId}.${field} = ${typeof value === 'object' ? JSON.stringify(value) : value}`);
}

function cmdLinkTest(args) {
  const requestedReqId = args[0];
  const reqId = requestedReqId ? normalizeRequirementId(requestedReqId) : requestedReqId;
  const caseId = args[1];
  if (!reqId || !caseId) {
    console.error('  Usage: link-test <req-id> <test-case-id>');
    process.exit(1);
  }

  const data = readRtm();
  if (!data) {
    console.error('  RTM not initialized. Run: init');
    process.exit(1);
  }
  const resolvedReqId = resolveRequirementKey(data, reqId);
  if (!resolvedReqId) {
    console.error(`  Requirement ${reqId} not found`);
    process.exit(1);
  }

  if (!data.requirements[resolvedReqId].test_evidence.some((e) => e.case_id === caseId)) {
    data.requirements[resolvedReqId].test_evidence.push({ case_id: caseId, file: '', status: 'pass' });
  }

  // Auto-advance status
  if (data.requirements[resolvedReqId].code_evidence.length > 0) {
    data.requirements[resolvedReqId].status = 'covered';
  } else if (['pending', 'mapped', 'coded'].includes(data.requirements[resolvedReqId].status)) {
    data.requirements[resolvedReqId].status = 'tested';
  }

  writeRtm(data);
  console.log(`  Linked ${caseId} to ${resolvedReqId}`);
}

function cmdLinkCode(args) {
  const requestedReqId = args[0];
  const reqId = requestedReqId ? normalizeRequirementId(requestedReqId) : requestedReqId;
  const fileLine = args[1];
  if (!reqId || !fileLine) {
    console.error('  Usage: link-code <req-id> <file:line>');
    process.exit(1);
  }

  const data = readRtm();
  if (!data) {
    console.error('  RTM not initialized. Run: init');
    process.exit(1);
  }
  const resolvedReqId = resolveRequirementKey(data, reqId);
  if (!resolvedReqId) {
    console.error(`  Requirement ${reqId} not found`);
    process.exit(1);
  }

  const [file, lines] = fileLine.includes(':') ? fileLine.split(':') : [fileLine, ''];

  if (!data.requirements[resolvedReqId].code_evidence.some((e) => e.file === file)) {
    data.requirements[resolvedReqId].code_evidence.push({
      file,
      lines: lines || '',
      verified_at: new Date().toISOString(),
    });
  }

  // Auto-advance status
  if (data.requirements[resolvedReqId].test_evidence.length > 0) {
    data.requirements[resolvedReqId].status = 'covered';
  } else if (['pending', 'mapped'].includes(data.requirements[resolvedReqId].status)) {
    data.requirements[resolvedReqId].status = 'coded';
  }

  writeRtm(data);
  console.log(`  Linked ${file} to ${resolvedReqId}`);
}

// - Source Coverage Validation -

function cmdValidateSourceCoverage(args) {
  const jsonMode = args.includes('--json');
  let threshold = 95;
  const threshIdx = args.indexOf('--threshold');
  if (threshIdx !== -1 && args[threshIdx + 1]) {
    threshold = parseInt(args[threshIdx + 1], 10);
  }

  const { evaluateCoverageAgainstText } = require('./cobolt-source-coverage');

  // Read RTM
  const data = readRtm();
  if (!data) {
    console.error('  RTM not found. Run: node tools/cobolt-rtm.js init');
    process.exit(1);
  }

  // For each source requirement, check if any RTM requirement matches
  const rtmContent = Object.values(data.requirements)
    .map((r) => `${r.id} ${r.title || ''} ${r.description || ''}`)
    .join('\n');
  const { result, exitCode } = evaluateCoverageAgainstText(rtmContent, {
    threshold,
    targetFile: rtmReadPath(),
    projectRoot: process.cwd(),
    planningDir:
      getPlanningDir(process.cwd(), { create: false, strict: false, fallbackToLatest: true }) || planningDir(),
    writeReport: false,
  });
  const matched = Math.max(0, (result?.includedRequirements || 0) - (result?.unmatchedRequirements || 0));
  const unmatched = result?.unmatched || [];

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          ...result,
          rtmRequirements: Object.keys(data.requirements).length,
          matched,
          unmatched: result?.unmatchedRequirements || 0,
          unmatchedEntries: unmatched.map((entry) => ({
            id: entry.id,
            summary: entry.summary,
            sourceFile: entry.sourceFile,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`  [validate-source-coverage] Source - RTM Coverage`);
    console.log(`    Source requirements (included): ${result?.includedRequirements || 0}`);
    console.log(`    RTM requirements: ${Object.keys(data.requirements).length}`);
    console.log(`    Matched: ${matched}`);
    console.log(`    Missing from RTM: ${result?.unmatchedRequirements || 0}`);
    console.log(`    Coverage: ${result?.coverage || 0}% (threshold: ${threshold}%)`);
    console.log(`    Result: ${result?.passed ? 'PASS' : 'FAIL'}`);

    if (Array.isArray(result?.issues) && result.issues.length > 0) {
      console.log('');
      console.log(`    Source packet issues: ${result.issues.join(' | ')}`);
    }

    if (unmatched.length > 0) {
      console.log(`\n    Missing source requirements:`);
      for (const e of unmatched) {
        console.log(`      ${e.id}: ${e.summary} (from ${e.sourceFile})`);
      }
    }
  }

  if (exitCode !== 0) process.exit(exitCode);
}

// - CLI Entry -

// - v0.12.0: dead-requirement audit -
// Detect requirements that are mapped but have zero code_evidence after a
// milestone is marked complete. These are silent-loss candidates.
// ---------------------------------------------------------------------------
// census — Cross-source parity gate.
//
// Invariant: for each requirement source (PRD, TRD, implicit-requirements),
// count distinct FR/NFR/TR/IR tokens in the source file and compare to the
// count of RTM entries with the matching `source` field. Any delta (source
// tokens > RTM entries) is a hard failure.
//
// This is the missing Tier 1 gate that would have caught the user's incident:
// RTM had 49 TRD + implicit entries but ZERO PRD FRs, while PRD contained 72.
// ---------------------------------------------------------------------------
function cmdCensus(args) {
  const data = readRtm();
  if (!data) {
    console.error('  RTM not initialized. Run: init');
    process.exit(1);
  }
  const jsonOut = hasFlag(args, '--json');
  const strict = !hasFlag(args, '--no-strict');

  const sources = [
    { key: 'prd', file: 'prd.md', prefixes: ['FR', 'NFR'], rtmFilter: (r) => r.source === 'prd' },
    { key: 'trd', file: 'trd.md', prefixes: ['TR'], rtmFilter: (r) => r.source === 'trd' },
    { key: 'implicit', file: 'implicit-requirements.md', prefixes: ['IR'], rtmFilter: (r) => r.source === 'implicit' },
  ];

  const rows = [];
  let drift = 0;

  for (const src of sources) {
    // v0.40.8 — use resolveSourceArtifact to honor both canonical planning
    // dir and legacy rtm-colocated source layouts.
    const filePath = resolveSourceArtifact(src.file);
    if (!fs.existsSync(filePath)) {
      rows.push({ source: src.key, sourceFile: filePath, present: false, sourceTokens: 0, rtmCount: 0, delta: 0 });
      continue;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const sourceTokens = countSourceTokens(content, src.prefixes);
    const rtmCount = Object.values(data.requirements).filter(src.rtmFilter).length;
    const delta = Math.max(0, sourceTokens - rtmCount);
    if (delta > 0) drift++;
    rows.push({ source: src.key, sourceFile: filePath, present: true, sourceTokens, rtmCount, delta });
  }

  // v0.26: audit mapped-without-AC. Any requirement marked mapped/coded/tested/covered
  // with an empty acceptance_criteria array is a silent handoff failure — the story
  // cannot derive BDD tests and the readiness gate cannot prove validation intent.
  const advancedStatuses = new Set(['mapped', 'coded', 'tested', 'covered']);
  const mappedWithoutAc = Object.values(data.requirements)
    .filter((r) => advancedStatuses.has(r.status))
    .filter((r) => !Array.isArray(r.acceptance_criteria) || r.acceptance_criteria.length === 0)
    .map((r) => ({ id: r.id, status: r.status, source: r.source }));

  const qualityGaps = {
    mappedWithoutAc: mappedWithoutAc.length,
    mappedWithoutAcIds: mappedWithoutAc.map((r) => r.id),
  };

  const result = {
    checkedAt: new Date().toISOString(),
    totalRtmRequirements: Object.keys(data.requirements).length,
    sources: rows,
    drift: drift > 0,
    driftSources: rows.filter((r) => r.delta > 0).map((r) => r.source),
    qualityGaps,
    passed: drift === 0 && mappedWithoutAc.length === 0,
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('  RTM Source Census');
    console.log(`  ${'-'.repeat(70)}`);
    for (const r of rows) {
      const status = !r.present ? 'MISSING' : r.delta === 0 ? 'OK' : 'DRIFT';
      const line = `    ${r.source.padEnd(10)} tokens=${String(r.sourceTokens).padStart(4)}  rtm=${String(r.rtmCount).padStart(4)}  delta=${String(r.delta).padStart(4)}  [${status}]`;
      if (r.delta > 0) console.error(line);
      else console.log(line);
    }
    if (qualityGaps.mappedWithoutAc > 0) {
      console.error('');
      console.error(`  AC Gap — ${qualityGaps.mappedWithoutAc} mapped requirement(s) have empty acceptance_criteria:`);
      for (const id of qualityGaps.mappedWithoutAcIds.slice(0, 10)) {
        console.error(`    - ${id}`);
      }
      if (qualityGaps.mappedWithoutAcIds.length > 10) {
        console.error(`    ... and ${qualityGaps.mappedWithoutAcIds.length - 10} more`);
      }
      console.error('  Remediation: run `rtm backfill-ac` or add AC to stories/PRD.');
    }
    if (result.passed) {
      console.log('  Census PASS — all sources reconciled with RTM, all mapped reqs have AC.');
    } else if (!result.drift) {
      console.error('');
      console.error('  Census FAIL — mapped requirements without acceptance criteria.');
    } else {
      console.error('');
      console.error('  Census FAIL — requirement source(s) drifted from RTM.');
      console.error('  Remediation: re-run cobolt-rtm.js import-prd / import-trd / import-implicit.');
    }
  }

  if (!result.passed && strict) {
    appendRtmAuditEvent({
      class: 'rtm-census-drift',
      command: 'census',
      driftSources: result.driftSources,
      rows,
    });
    process.exit(5);
  }
}

// ---------------------------------------------------------------------------
// validate-references — Consumer-to-producer reference integrity gate.
//
// Scans epics.md, story-tracker.json, milestones.md, api-contracts.md, and
// ux-design-specification.md for FR/NFR/TR/IR token references. For each
// referenced ID, verifies presence in RTM. Any phantom reference is a hard
// failure — the exact class that caused 87 stories to ship referencing FRs
// absent from RTM.
// ---------------------------------------------------------------------------
function cmdValidateReferences(args) {
  const data = readRtm();
  if (!data) {
    console.error('  RTM not initialized. Run: init');
    process.exit(1);
  }
  const jsonOut = hasFlag(args, '--json');
  const strict = !hasFlag(args, '--no-strict');

  // v0.40.8 — consumer lookups honor both canonical planning dir and
  // legacy rtm-colocated layouts via resolveSourceArtifact.
  const consumers = [
    { key: 'epics', file: resolveSourceArtifact('epics.md'), kind: 'markdown' },
    { key: 'milestones', file: resolveSourceArtifact('milestones.md'), kind: 'markdown' },
    { key: 'api-contracts', file: resolveSourceArtifact('api-contracts.md'), kind: 'markdown' },
    { key: 'ux-design-specification', file: resolveSourceArtifact('ux-design-specification.md'), kind: 'markdown' },
    { key: 'story-tracker', file: resolveSourceArtifact('story-tracker.json'), kind: 'story-tracker' },
  ];

  const rtmKeys = new Set(Object.keys(data.requirements));
  const perConsumer = [];
  let totalPhantoms = 0;

  for (const c of consumers) {
    if (!fs.existsSync(c.file)) {
      perConsumer.push({ consumer: c.key, file: c.file, present: false, referencedCount: 0, phantoms: [] });
      continue;
    }
    const referencedIds = new Set();

    if (c.kind === 'markdown') {
      const content = fs.readFileSync(c.file, 'utf8');
      // Real requirement IDs always contain at least one digit (FR-001, NFR-020).
      // Literal placeholders ("FR-NNN", "NFR-XXX", "TR-###") have no digits and
      // are doc template scaffolding — do not treat them as phantom refs.
      const pattern = /\b(?:FR|NFR|TR|IR)-(?=[A-Z0-9_-]*\d)[A-Z0-9][A-Z0-9_-]*\b/gi;
      const matches = content.match(pattern) || [];
      for (const m of matches) {
        // Also skip pure-placeholder patterns like FR-NNN, FR-XXX, FR-### that
        // may sneak in if an author uses a mixed form like FR-0NN.
        if (/^(?:FR|NFR|TR|IR)-[NX#]+$/i.test(m)) continue;
        // v0.47.3 — consumer-side canonicalization. Producer (parseFRsFromPRD
        // / parseTRsFromTRD / parseIRsFromImplicit) canonicalizes rtm keys
        // via canonicalIdOrFallback, so the referenced-id set must use the
        // same normalizer. Pre-v0.47.3 this used normalizeRequirementId
        // (uppercase-only, no padding) and any project with short-form refs
        // like `FR-1` in epics.md silently failed the phantom gate.
        const norm = canonicalIdOrFallback(m);
        if (norm) referencedIds.add(norm);
      }
    } else if (c.kind === 'story-tracker') {
      try {
        const tracker = JSON.parse(fs.readFileSync(c.file, 'utf8'));
        const stories = Array.isArray(tracker?.stories) ? tracker.stories : [];
        for (const story of stories) {
          for (const field of ['requirementIds', 'frIds', 'nfrIds', 'trIds', 'irIds']) {
            const ids = Array.isArray(story?.[field]) ? story[field] : [];
            for (const id of ids) {
              const norm = canonicalIdOrFallback(id);
              if (norm) referencedIds.add(norm);
            }
          }
        }
      } catch (err) {
        console.error(`  [validate-references] ${c.key} JSON parse error: ${err.message}`);
      }
    }

    const phantoms = [...referencedIds].filter((id) => !rtmKeys.has(id)).sort();
    totalPhantoms += phantoms.length;
    perConsumer.push({
      consumer: c.key,
      file: c.file,
      present: true,
      referencedCount: referencedIds.size,
      phantoms,
    });
  }

  const result = {
    checkedAt: new Date().toISOString(),
    rtmTotal: rtmKeys.size,
    totalPhantoms,
    consumers: perConsumer,
    passed: totalPhantoms === 0,
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('  RTM Consumer Reference Validation');
    console.log(`  ${'-'.repeat(70)}`);
    for (const c of perConsumer) {
      if (!c.present) {
        console.log(`    ${c.consumer.padEnd(26)} [absent]`);
        continue;
      }
      const status = c.phantoms.length === 0 ? 'OK' : 'PHANTOM';
      const line = `    ${c.consumer.padEnd(26)} refs=${String(c.referencedCount).padStart(4)}  phantoms=${String(c.phantoms.length).padStart(4)}  [${status}]`;
      if (c.phantoms.length > 0) {
        console.error(line);
        console.error(
          `      phantom IDs: ${c.phantoms.slice(0, 20).join(', ')}${c.phantoms.length > 20 ? ` ... (+${c.phantoms.length - 20} more)` : ''}`,
        );
      } else {
        console.log(line);
      }
    }
    if (result.passed) {
      console.log('  References PASS — no phantom FR/NFR/TR/IR references detected.');
    } else {
      console.error('');
      console.error(`  References FAIL — ${totalPhantoms} phantom reference(s) across consumer artifacts.`);
      console.error('  Remediation:');
      console.error('    - Add missing IDs to PRD/TRD/implicit-reqs and re-import, OR');
      console.error('    - Edit consumer artifacts to remove phantom references.');
    }
  }

  if (!result.passed && strict) {
    appendRtmAuditEvent({
      class: 'rtm-phantom-references',
      command: 'validate-references',
      totalPhantoms,
      consumers: perConsumer.filter((c) => c.phantoms.length > 0),
    });
    process.exit(6);
  }
}

// CB-OBS-19: rtm.json must carry a valid integrity digest at all times.
// writeRtm() already signs on every programmatic mutation, but external
// editors (scripts, agents, manual hand-edits during recovery) can bypass
// writeRtm and leave the digest stale. `resign` recomputes and writes the
// digest without mutating business state, so downstream gates that verify
// integrity on read do not hard-fail on a benign edit.
function cmdResign(args) {
  const data = readRtm();
  if (!data) {
    console.error('  RTM not initialized. Run: init');
    process.exit(1);
  }
  const jsonOut = hasFlag(args, '--json');
  writeRtm(data);
  const signed = readRtm();
  const digest = signed?._integrity?.sha256 || signed?._integrity?.digest || null;
  if (jsonOut) {
    console.log(
      JSON.stringify(
        {
          ok: Boolean(digest),
          digest: digest ? `${digest.slice(0, 16)}…` : null,
          verifiedAt: signed?._integrity?.verifiedAt || null,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!digest) {
    console.error('  [rtm] resign: digest missing after write — integrity signing failed');
    process.exit(1);
  }
  console.log(`  [rtm] resigned digest=${digest.slice(0, 16)}… verifiedAt=${signed._integrity.verifiedAt}`);
}

// CB-OBS-20: keep rtm.json in lock-step with story-tracker.json.
// The tracker is the authoritative source for which stories reference which
// FR/NFR/IR. rtm.json historically drifted when stories were added or epics
// were renamed — stories[] and epic would stay empty/stale and downstream
// gates (rtm-census, rtm-references, artifact-parity) would flag drift that
// the human had to hand-fix. This command does the bidirectional reconcile
// deterministically.
function cmdReconcileTracker(args) {
  const data = readRtm();
  if (!data) {
    console.error('  RTM not initialized. Run: init');
    process.exit(1);
  }
  const jsonOut = hasFlag(args, '--json');
  const pd = planningDir();
  const trackerPath = path.join(pd, 'story-tracker.json');
  if (!fs.existsSync(trackerPath)) {
    const msg = `  [rtm] reconcile: story-tracker.json not found at ${trackerPath}`;
    if (jsonOut) {
      console.log(JSON.stringify({ ok: false, reason: 'tracker-missing', trackerPath }, null, 2));
      process.exit(1);
    }
    console.error(msg);
    process.exit(1);
  }

  let tracker;
  try {
    tracker = JSON.parse(fs.readFileSync(trackerPath, 'utf8'));
  } catch (err) {
    console.error(`  [rtm] reconcile: failed to parse story-tracker.json: ${err.message}`);
    process.exit(1);
  }

  const stories = Array.isArray(tracker.stories) ? tracker.stories : [];

  // v0.50 — feature-registry fallback. When story-tracker entries are sparse
  // on requirementIds (the LLM that wrote them omitted the inline FR/NFR
  // citation block from workflow.md Step 3), we still need RTM to know which
  // stories cover which requirement. Each story carries `featureId`, and
  // feature-registry.json maps FEAT-NNN -> requirementIds[]. We use that as
  // a fallback so RTM's requirement.stories[] does not collapse to ~20% of
  // the truth (the 117/22 drift class).
  let featureToReqs = null;
  try {
    const frPath = path.join(pd, 'feature-registry.json');
    if (fs.existsSync(frPath)) {
      const fr = JSON.parse(fs.readFileSync(frPath, 'utf8'));
      featureToReqs = new Map();
      for (const feat of fr.features || []) {
        const fid = feat?.featureId || feat?.id;
        if (!fid) continue;
        featureToReqs.set(String(fid).toUpperCase(), feat.requirementIds || feat.frs || feat.requirements || []);
      }
    }
  } catch {
    featureToReqs = null;
  }

  const reqToStories = new Map(); // canonical req id -> Set(storyId)
  const storyToEpic = new Map();
  let featureFallbackUsed = 0;
  for (const story of stories) {
    if (!story?.id) continue;
    const storyId = String(story.id);
    storyToEpic.set(storyId, story.epic || story.epicId || null);
    let storyReqs = [
      ...(story.requirementIds || []),
      ...(story.frIds || []),
      ...(story.nfrIds || []),
      ...(story.irIds || []),
      ...(story.trIds || []),
    ];
    if (storyReqs.length === 0 && featureToReqs && story.featureId) {
      const featReqs = featureToReqs.get(String(story.featureId).toUpperCase()) || [];
      if (featReqs.length > 0) {
        storyReqs = featReqs;
        featureFallbackUsed++;
      }
    }
    const reqs = new Set(storyReqs);
    for (const rid of reqs) {
      if (!rid) continue;
      // v0.50: canonicalize so 2-digit feature-registry IDs (FR-01) map onto
      // 3-digit RTM keys (FR-001) — the storage form rtm uses post v0.47.2.
      const key = canonicalizeRequirementId(String(rid)) || String(rid).toUpperCase();
      if (!reqToStories.has(key)) reqToStories.set(key, new Set());
      reqToStories.get(key).add(storyId);
    }
  }

  let storyChanges = 0;
  let epicChanges = 0;
  let preservedExisting = 0;
  for (const [id, req] of Object.entries(data.requirements || {})) {
    // v0.50: canonicalize lookup so feature-fallback's canonicalized
    // entries match RTM keys regardless of whether RTM stores FR-001 or FR-01.
    const key = canonicalizeRequirementId(String(id)) || String(id).toUpperCase();
    const authoritative = Array.from(reqToStories.get(key) || []);
    const currentStories = Array.isArray(req.stories) ? req.stories : [];
    // v0.50: non-destructive merge. Only overwrite when we have an
    // authoritative new mapping. Empty authoritative + populated existing =
    // preserve existing (avoids the "wipe 438 reqs" regression). When both
    // sides have entries, union them so explicit story-tracker mappings and
    // feature-registry fallbacks combine instead of competing.
    if (authoritative.length > 0) {
      const merged = Array.from(new Set([...currentStories, ...authoritative])).sort();
      if (JSON.stringify(currentStories.slice().sort()) !== JSON.stringify(merged)) {
        req.stories = merged;
        storyChanges++;
      }
    } else if (currentStories.length > 0) {
      preservedExisting++;
    }
    // Derive epic from the first linked story when possible.
    const derivedEpic = authoritative.length > 0 ? storyToEpic.get(authoritative[0]) : null;
    if (derivedEpic && req.epic !== derivedEpic) {
      req.epic = derivedEpic;
      epicChanges++;
    }
  }

  writeRtm(data);
  const summary = {
    ok: true,
    reconciledStoryLinks: storyChanges,
    reconciledEpicLinks: epicChanges,
    preservedExistingStoryLinks: preservedExisting,
    totalRequirements: Object.keys(data.requirements || {}).length,
    totalStories: stories.length,
    featureFallbackUsed,
  };
  if (jsonOut) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(
    `  [rtm] reconcile: story-links=${summary.reconciledStoryLinks}, epic-links=${summary.reconciledEpicLinks} (total reqs=${summary.totalRequirements}, stories=${summary.totalStories})`,
  );
}

function cmdAudit(args) {
  const data = readRtm();
  if (!data) {
    console.error('  RTM not initialized. Run: init');
    process.exit(1);
  }
  const dead = hasFlag(args, '--dead');
  const milestone = getFlagValue(args, '--milestone');
  const jsonOut = hasFlag(args, '--json');

  const reqs = Object.values(data.requirements).filter(
    (r) => !milestone || getRequirementMilestones(r).includes(milestone),
  );
  const findings = [];

  for (const r of reqs) {
    const codeCount = Array.isArray(r.code_evidence) ? r.code_evidence.length : 0;
    const testCount = Array.isArray(r.test_evidence) ? r.test_evidence.length : 0;
    if (dead) {
      // Dead = status in {mapped, pending} with no code_evidence at all
      if ((r.status === 'mapped' || r.status === 'pending') && codeCount === 0) {
        findings.push({ id: r.id, type: r.type, milestone: r.milestone, status: r.status, reason: 'no code evidence' });
      }
      // Also flag: claims "coded" but evidence is empty (lying status)
      if (r.status === 'coded' && codeCount === 0) {
        findings.push({
          id: r.id,
          type: r.type,
          milestone: r.milestone,
          status: r.status,
          reason: 'coded status with no evidence',
        });
      }
      // Also flag: claims "tested" but test_evidence is empty
      if ((r.status === 'tested' || r.status === 'covered') && testCount === 0) {
        findings.push({
          id: r.id,
          type: r.type,
          milestone: r.milestone,
          status: r.status,
          reason: `${r.status} status with no test evidence`,
        });
      }
    }
  }

  const result = {
    auditedAt: new Date().toISOString(),
    totalAudited: reqs.length,
    findings,
    ok: findings.length === 0,
  };
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.ok) console.log(`  Audit PASS: ${reqs.length} requirements, 0 dead findings`);
    else {
      console.error(`  Audit FAIL: ${findings.length} dead/inconsistent requirements`);
      for (const f of findings.slice(0, 40))
        console.error(`    ${f.id} [${f.type}] ${f.milestone || '?'}: ${f.reason}`);
      if (findings.length > 40) console.error(`    ... and ${findings.length - 40} more`);
    }
  }
  process.exit(result.ok ? 0 : 1);
}

function printHelp() {
  console.log(`
  CoBolt RTM --- Requirements Traceability Matrix
  =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

  Commands:
    init                                    Create empty RTM
    import-prd [--prd <path>]               Import FRs/NFRs from PRD
    import-trd [--trd <path>]               Import TRs from TRD
    import-implicit [--file <path>]          Import IRs from implicit requirements
    sync-source-registry [--json] [--all]    Import source-registry-only requirements into RTM
    map <req-id> --epic <e> --stories <s>   Map a single requirement to epic/stories
    map [--milestone <m>]                   Auto-map from story-tracker planning artifacts
    map-milestone <req-id> --milestone <m>  Assign to milestone (single)
    map-milestones <req-id> --milestones M1,M2 [--phasing 'M1=scope'] [--phasing 'M2=scope']
                                            Assign cross-milestone requirement (populates milestones[] + milestone_phasing{})
    scan [--dir <path>]                     Scan codebase for evidence
    check [--threshold <n>] [--milestone M] [--mode mapped|validated] [--json] [--output file]
                                            Gate check (exit 1 if below)
    status [--milestone M] [--mode mapped|validated] [--json]
                                            Coverage summary
    report [--format md|json]               Full traceability report
    update <req-id> --field <f> --value <v> Update a field
    update --milestone <m> --set-status <s> Bulk-update milestone statuses
    update --milestone <m> --status <s>     Legacy alias for --set-status
    link-test <req-id> <test-case-id>       Link test evidence
    link-code <req-id> <file:line>          Link code evidence
    render-matrix                           Generate traceability-matrix.md (deterministic)
    validate-source-coverage [--threshold <n>] [--json]
                                            Validate RTM covers source document requirements
    census [--json] [--no-strict]           Cross-source parity gate: PRD/TRD/IR tokens vs RTM entries
    validate-references [--json] [--no-strict]
                                            Consumer-ref gate: epics/stories/api/ux vs RTM (phantom detection)
    audit [--dead] [--milestone M] [--json] Dead-requirement audit (--dead flags status-without-evidence)
    resign [--json]                         Recompute and persist _integrity digest (CB-OBS-19). Use after external edits.
    reconcile [--json]                      Bidirectional sync of requirement.stories[] + .epic from story-tracker.json (CB-OBS-20).

  Exit codes:
    0  success
    1  usage error / RTM missing
    2  import silent-zero (source has tokens, 0 parsed — format drift)
    3  import partial-drift (source tokens > RTM entries with matching source)
    4  map phantom-refs (story refs FR IDs absent from RTM)
    5  census drift
    6  validate-references phantom IDs
    7  empty RTM / empty scope
   65  source file absent (acceptable for optional imports)

  Status flow: pending - mapped - coded - tested - covered
`);
}

// ── v0.47.2 — FR id format integrity ────────────────────────
//
// Consumer artifacts whose text is scanned for FR/NFR/TR/IR references.
// Order matches the planning pipeline's write order so output is stable.
const FORMAT_CONSUMER_ARTIFACTS = [
  'epics.md',
  'story-tracker.json',
  'executable-prd.json',
  'feature-registry.json',
  'traceability-matrix.md',
  'master-plan.md',
  'readiness-deterministic.json',
  'milestones.md',
];

// Detect whether a given id is already in canonical form (no transformation
// applied). Used by check-format to distinguish drifted from clean entries.
function isCanonicalRequirementId(rawId) {
  const canonical = canonicalizeRequirementId(rawId);
  return canonical !== null && canonical === String(rawId).trim().toUpperCase().replace(/_/g, '-');
}

function collectConsumerReferences(planningDirPath) {
  const references = [];
  const refPattern = /\b(?:FR|NFR|TR|IR|TRD|ADR)(?:-[A-Z0-9]{1,8})?-\d{1,4}(?:-[A-Z]{2,8})?\b/gi;
  for (const artifact of FORMAT_CONSUMER_ARTIFACTS) {
    const full = path.join(planningDirPath, artifact);
    if (!fs.existsSync(full)) continue;
    let content;
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const seen = new Set();
    for (const match of content.matchAll(refPattern)) {
      const raw = match[0];
      if (seen.has(raw)) continue;
      seen.add(raw);
      references.push({ artifact, raw });
    }
  }
  return references;
}

function cmdCheckFormat(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      [
        'Usage: cobolt-rtm.js check-format [--json] [--fix]',
        '',
        'Census rtm.json keys + consumer artifact references for FR id format',
        'drift. Detects two classes:',
        '  - key-format-drift       rtm.json has non-canonical keys (FR-1 vs FR-001)',
        '  - reference-format-drift consumer artifact uses non-canonical form',
        '',
        '  --fix  rewrite rtm.json keys to canonical form (with rtm.json.bak)',
        '         Does NOT rewrite consumer artifacts.',
        '',
        'Exit codes: 0 clean | 1 usage | 2 rtm.json missing | 3 drift detected',
      ].join('\n'),
    );
    process.exit(0);
  }

  const jsonOut = args.includes('--json');
  const fixMode = args.includes('--fix');

  const data = readRtm();
  if (!data) {
    if (jsonOut) console.log(JSON.stringify({ ok: false, reason: 'rtm.json missing' }, null, 2));
    else console.error('  rtm.json missing — run import-prd first');
    process.exit(2);
  }

  const pd = planningDir();
  const findings = [];

  // Check 1 — rtm.json key format drift
  const driftedKeys = [];
  const renames = [];
  for (const key of Object.keys(data.requirements || {})) {
    if (isCanonicalRequirementId(key)) continue;
    const canonical = canonicalizeRequirementId(key);
    if (!canonical) continue; // non-canonicalizable id; different problem (see validate-references)
    driftedKeys.push(key);
    renames.push({ from: key, to: canonical });
  }
  if (driftedKeys.length > 0) {
    findings.push({
      class: 'key-format-drift',
      severity: 'high',
      artifact: 'rtm.json',
      keys: driftedKeys,
      renames,
      message: `${driftedKeys.length} rtm.json key(s) are not in canonical form (e.g. ${driftedKeys[0]} → ${renames[0].to}).`,
    });
  }

  // Check 2 — consumer artifact reference format drift
  const references = pd ? collectConsumerReferences(pd) : [];
  const refDriftByArtifact = new Map();
  for (const { artifact, raw } of references) {
    if (isCanonicalRequirementId(raw)) continue;
    const canonical = canonicalizeRequirementId(raw);
    if (!canonical) continue;
    if (!refDriftByArtifact.has(artifact)) refDriftByArtifact.set(artifact, []);
    refDriftByArtifact.get(artifact).push({ raw, canonical });
  }
  for (const [artifact, drifted] of refDriftByArtifact) {
    findings.push({
      class: 'reference-format-drift',
      severity: 'medium',
      artifact,
      references: drifted,
      message: `${drifted.length} reference(s) in ${artifact} use non-canonical form (e.g. ${drifted[0].raw} → ${drifted[0].canonical}).`,
    });
  }

  // --fix mode: rewrite rtm.json keys
  if (fixMode && driftedKeys.length > 0) {
    const rtmFilePath = path.join(pd, 'rtm.json');
    const backupPath = `${rtmFilePath}.bak`;
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(rtmFilePath, backupPath);
    }
    const newRequirements = {};
    for (const [key, value] of Object.entries(data.requirements || {})) {
      const canonical = canonicalizeRequirementId(key) || key;
      newRequirements[canonical] = { ...value, id: canonical };
    }
    const rewritten = { ...data, requirements: newRequirements };
    fs.writeFileSync(rtmFilePath, JSON.stringify(rewritten, null, 2));
    if (!jsonOut) console.log(`  --fix: rewrote ${driftedKeys.length} key(s); backup at ${path.basename(backupPath)}`);
    process.exit(0);
  }

  const report = {
    ok: findings.length === 0,
    planningDir: pd || null,
    checkedAt: new Date().toISOString(),
    findings,
  };

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
  } else if (findings.length === 0) {
    console.log('  rtm-format: OK — all keys + references are canonical');
  } else {
    console.log(`  rtm-format: DRIFT — ${findings.length} finding(s)`);
    for (const f of findings) console.log(`    [${f.severity}] ${f.message}`);
  }

  process.exit(findings.length === 0 ? 0 : 3);
}

function cmdMigrateIds(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      [
        'Usage: cobolt-rtm.js migrate-ids [--json] [--dry-run]',
        '',
        'Walks rtm.json, canonicalizes every key (idempotent), re-renders',
        'traceability-matrix.md via render-matrix. Legacy projects with',
        'short-form keys can run this to align with v0.47.2 canonical form.',
        '',
        '  --dry-run  report the rename diff without writing',
        '',
        'Exit codes: 0 success | 1 usage | 2 rtm.json missing',
      ].join('\n'),
    );
    process.exit(0);
  }

  const jsonOut = args.includes('--json');
  const dryRun = args.includes('--dry-run');

  const data = readRtm();
  if (!data) {
    if (jsonOut) console.log(JSON.stringify({ ok: false, reason: 'rtm.json missing' }, null, 2));
    else console.error('  rtm.json missing — run import-prd first');
    process.exit(2);
  }

  const pd = planningDir();
  const renames = [];
  const newRequirements = {};

  for (const [key, value] of Object.entries(data.requirements || {})) {
    const canonical = canonicalizeRequirementId(key);
    const targetKey = canonical || key;
    if (canonical && canonical !== key) renames.push({ from: key, to: canonical });
    newRequirements[targetKey] = { ...value, id: targetKey };
  }

  const report = {
    ok: true,
    dryRun,
    planningDir: pd || null,
    renames,
    checkedAt: new Date().toISOString(),
  };

  if (dryRun) {
    if (jsonOut) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`  migrate-ids (dry-run): ${renames.length} key(s) would be renamed.`);
      for (const r of renames.slice(0, 10)) console.log(`    ${r.from} → ${r.to}`);
      if (renames.length > 10) console.log(`    … ${renames.length - 10} more`);
    }
    process.exit(0);
  }

  // Write the migrated rtm.json
  if (pd && renames.length > 0) {
    const rtmFilePath = path.join(pd, 'rtm.json');
    const backupPath = `${rtmFilePath}.bak`;
    if (!fs.existsSync(backupPath)) fs.copyFileSync(rtmFilePath, backupPath);
    const rewritten = { ...data, requirements: newRequirements };
    fs.writeFileSync(rtmFilePath, JSON.stringify(rewritten, null, 2));
  }

  // Re-render the traceability matrix so downstream views pick up canonical form.
  try {
    cmdRenderMatrix([]);
  } catch {
    /* render failures are non-fatal for migrate */
  }

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`  migrate-ids: ${renames.length} key(s) renamed; traceability-matrix.md regenerated`);
  }
  process.exit(0);
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const cmdArgs = args.slice(1);

  switch (cmd) {
    case 'init':
      return cmdInit();
    case 'import-prd':
      return cmdImportPrd(cmdArgs);
    case 'import-trd':
      return cmdImportTrd(cmdArgs);
    case 'import-implicit':
      return cmdImportImplicit(cmdArgs);
    case 'check-format':
      return cmdCheckFormat(cmdArgs);
    case 'migrate-ids':
      return cmdMigrateIds(cmdArgs);
    case 'sync-source-registry':
    case 'import-source-registry':
      return cmdSyncSourceRegistry(cmdArgs);
    case 'map':
      return cmdMap(cmdArgs);
    case 'map-milestone':
      return cmdMapMilestone(cmdArgs);
    case 'map-milestones':
      return cmdMapMilestones(cmdArgs);
    case 'backfill-ac':
    case 'backfill':
      return cmdBackfillAc(cmdArgs);
    case 'scan':
      return cmdScan(cmdArgs);
    case 'check':
      return cmdCheck(cmdArgs);
    case 'status':
      return cmdStatus(cmdArgs);
    case 'report':
      return cmdReport(cmdArgs);
    case 'update':
      return cmdUpdate(cmdArgs);
    case 'link-test':
      return cmdLinkTest(cmdArgs);
    case 'link-code':
      return cmdLinkCode(cmdArgs);
    case 'render-matrix':
      return cmdRenderMatrix(cmdArgs);
    case 'validate-source-coverage':
      return cmdValidateSourceCoverage(cmdArgs);
    case 'census':
      return cmdCensus(cmdArgs);
    case 'validate-references':
      return cmdValidateReferences(cmdArgs);
    case 'audit':
      return cmdAudit(cmdArgs);
    case 'resign':
      return cmdResign(cmdArgs);
    case 'reconcile':
    case 'reconcile-tracker':
      return cmdReconcileTracker(cmdArgs);
    case '--help':
    case '-h':
    case 'help':
      return printHelp();
    default:
      if (!cmd) return printHelp();
      console.error(`  Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
}

// Programmatic API
module.exports = {
  init: cmdInit,
  importPrd: cmdImportPrd,
  importTrd: cmdImportTrd,
  importImplicit: cmdImportImplicit,
  syncSourceRegistry: cmdSyncSourceRegistry,
  map: cmdMap,
  mapMilestone: cmdMapMilestone,
  mapMilestones: cmdMapMilestones,
  setRequirementMilestones,
  getRequirementMilestones,
  backfillAc: cmdBackfillAc,
  scan: cmdScan,
  check: cmdCheck,
  status: cmdStatus,
  report: cmdReport,
  update: cmdUpdate,
  linkTest: cmdLinkTest,
  linkCode: cmdLinkCode,
  renderMatrix: cmdRenderMatrix,
  validateSourceCoverage: cmdValidateSourceCoverage,
  census: cmdCensus,
  validateReferences: cmdValidateReferences,
  audit: cmdAudit,
  autoMapFromPlanningArtifacts,
  countSourceTokens,
  buildCoverageReport,
  readRtm,
  writeRtm,
  writeRtmLocked,
  rtmPath,
};

if (require.main === module) main();
