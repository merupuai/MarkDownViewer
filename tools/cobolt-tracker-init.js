#!/usr/bin/env node
// @ts-nocheck

// CoBolt Tracker Init — Deterministic JSON tracker generator
//
// Replaces cobolt-create-milestone-trackers skill with a deterministic script.
// Parses milestones.md + epics.md and generates 3 JSON tracker files.
//
// Usage:
//   node tools/cobolt-tracker-init.js generate                  # Generate all 3 trackers
//   node tools/cobolt-tracker-init.js generate --milestones <p>  # Custom milestones path
//   node tools/cobolt-tracker-init.js generate --epics <p>       # Custom epics path
//   node tools/cobolt-tracker-init.js validate                   # Validate existing trackers
//   node tools/cobolt-tracker-init.js status                     # Show tracker status
//
// Exit codes:
//   0 = success
//   1 = missing input files
//   2 = usage error

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite: sharedAtomicWrite } = require('../lib/cobolt-atomic-write');
const { extractRequirementReferences, requirementPrefix } = require('../lib/cobolt-requirements');
const {
  getPlanningDir,
  getMilestoneFRCounts,
  discoverStoryFiles,
  normalizeStoryId,
  resolveStoryFile,
} = require('../lib/cobolt-planning-artifacts');
const { signJson } = require('../lib/cobolt-state-integrity');
const { projectExecutionLedger, seedExecutionLedger } = require('../lib/cobolt-execution-ledger');

// ── Path Resolution ─────────────────────────────────────────

function planningDir() {
  return getPlanningDir(process.cwd(), { create: true });
}

function sortIds(ids) {
  return [...new Set((ids || []).filter(Boolean).map((id) => String(id).toUpperCase()))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

function parseIdList(text, pattern) {
  return sortIds((String(text || '').match(pattern) || []).map((id) => id.toUpperCase()));
}

function normalizeEpicId(epicId) {
  const normalized = String(epicId || '')
    .trim()
    .toUpperCase();
  if (!normalized) return null;
  const match = normalized.match(/^(?:M(\d+)\.)?E([A-Z0-9_]+)$/);
  if (!match) return null;
  const epicToken = /^\d+$/.test(match[2]) ? String(parseInt(match[2], 10)) : match[2];
  return match[1] ? `M${parseInt(match[1], 10)}.E${epicToken}` : `E${epicToken}`;
}

function syncBidirectionalLinks(items, options = {}) {
  const {
    idKey = 'id',
    dependsOnKey = 'dependsOn',
    dependentsKey = 'dependents',
    aliasBlockedBy = true,
    aliasBlocks = true,
  } = options;

  const byId = new Map(items.map((item) => [item[idKey], item]));

  for (const item of items) {
    item[dependsOnKey] = sortIds(item[dependsOnKey]);
    item[dependentsKey] = sortIds(item[dependentsKey]);
  }

  for (const item of items) {
    for (const upstreamId of item[dependsOnKey]) {
      if (upstreamId === item[idKey]) continue;
      const upstream = byId.get(upstreamId);
      if (upstream && !upstream[dependentsKey].includes(item[idKey])) {
        upstream[dependentsKey].push(item[idKey]);
      }
    }
    for (const downstreamId of item[dependentsKey]) {
      if (downstreamId === item[idKey]) continue;
      const downstream = byId.get(downstreamId);
      if (downstream && !downstream[dependsOnKey].includes(item[idKey])) {
        downstream[dependsOnKey].push(item[idKey]);
      }
    }
  }

  for (const item of items) {
    item[dependsOnKey] = sortIds(item[dependsOnKey]);
    item[dependentsKey] = sortIds(item[dependentsKey]);
    if (aliasBlockedBy) item.blockedBy = [...item[dependsOnKey]];
    if (aliasBlocks) item.blocks = [...item[dependentsKey]];
  }

  return items;
}

function extractMarkdownSection(content, headingTitle) {
  const lines = String(content || '').split(/\r?\n/);
  const escapedTitle = headingTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingPattern = new RegExp(`^#{2,6}\\s+${escapedTitle}\\s*$`, 'i');
  let collecting = false;
  let level = 2;
  const buffer = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{2,6})\s+/);
    if (!collecting) {
      if (headingPattern.test(line)) {
        collecting = true;
        level = headingMatch ? headingMatch[1].length : 2;
      }
      continue;
    }

    if (headingMatch && headingMatch[1].length <= level) break;
    buffer.push(line);
  }

  return buffer.join('\n').trim();
}

function extractFrontmatter(content) {
  const match = String(content || '').match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result = {};

  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.+?)\s*$/);
    if (!kv) continue;
    result[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '');
  }

  return result;
}

function normalizeLocalTaskId(rawTaskId) {
  const cleaned = String(rawTaskId || '')
    .replace(/\*\*/g, '')
    .replace(/^(?:Task|Subtask)\s+/i, '')
    .replace(/^#/, '')
    .trim();

  if (!cleaned || /^(?:-|--|—|none|n\/a)$/i.test(cleaned)) return null;

  const match = cleaned.match(/^T?(\d+)(?:[.\-/:](\d+))?$/i);
  if (!match) return cleaned.toUpperCase();

  const main = match[1].padStart(2, '0');
  const sub = match[2] ? `.${match[2].padStart(2, '0')}` : '';
  return `T${main}${sub}`;
}

function normalizeTaskRef(rawRef, storyId) {
  const cleaned = String(rawRef || '')
    .replace(/\*\*/g, '')
    .trim();
  if (!cleaned || /^(?:-|--|—|none|n\/a)$/i.test(cleaned)) return null;

  const crossStoryMatch = cleaned.match(
    /^(E[A-Z0-9_]+-S\d+|M\d+\.S\d+|S-\d+\.\d+|S-\d+-\d+|S\d+\.\d+|\d+-\d+)\s*[:#/]\s*(.+)$/i,
  );
  if (crossStoryMatch) {
    const localTaskId = normalizeLocalTaskId(crossStoryMatch[2]);
    const canonicalStoryId = normalizeStoryId(crossStoryMatch[1]) || crossStoryMatch[1].toUpperCase();
    return localTaskId ? `${canonicalStoryId}:${localTaskId}` : null;
  }

  const localTaskId = normalizeLocalTaskId(cleaned);
  return localTaskId ? `${storyId}:${localTaskId}` : null;
}

function parseTaskList(content, storyId) {
  const taskSection = extractMarkdownSection(content, 'Tasks / Subtasks');
  if (!taskSection) return [];

  const tasks = [];
  for (const line of taskSection.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+\[([ xX])\]\s+((?:Task|Subtask)\s+)?(T?\d+(?:[.\-/:]\d+)?)\s*:\s*(.+)$/i);
    if (!match) continue;

    const localTaskId = normalizeLocalTaskId(match[3]);
    if (!localTaskId) continue;

    tasks.push({
      taskId: `${storyId}:${localTaskId}`,
      localTaskId,
      description: match[4].trim(),
      status: match[1].toLowerCase() === 'x' ? 'done' : 'planned',
      owner: '',
      dependsOn: [],
      dependents: [],
      blockedBy: [],
      issueRefs: [],
      evidence: [],
    });
  }

  return tasks;
}

function parseTaskDependencyMap(content, storyId) {
  const section = extractMarkdownSection(content, 'Task Dependency Map');
  if (!section) return new Map();

  const rows = new Map();
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 3) continue;
    if (/^task id$/i.test(cells[0]) || /^[-:]+$/.test(cells[0])) continue;

    const localTaskId = normalizeLocalTaskId(cells[0]);
    if (!localTaskId) continue;

    const dependsOn = sortIds(
      cells[1]
        .split(/[;,]/)
        .map((entry) => normalizeTaskRef(entry, storyId))
        .filter(Boolean),
    );
    const dependents = sortIds(
      cells[2]
        .split(/[;,]/)
        .map((entry) => normalizeTaskRef(entry, storyId))
        .filter(Boolean),
    );

    rows.set(localTaskId, { dependsOn, dependents });
  }

  return rows;
}

function parseStoryDependencyDirective(line) {
  if (!/\b(dependenc|depends on|blocked by|enables|unblocks|blocks)\b/i.test(line)) return null;
  const segments = line.split(';');
  const dependsOn = [];
  const dependents = [];

  for (const segment of segments) {
    const storyIds = parseIdList(
      segment,
      /\b(?:E[A-Z0-9_]+-S\d+|M\d+\.S\d+|S-\d+\.\d+|S-\d+-\d+|S\d+\.\d+|\d+-\d+)\b/gi,
    ).map((id) => normalizeStoryId(id) || id);
    if (storyIds.length === 0) continue;

    if (/\b(enables|unblocks|blocks)\b/i.test(segment)) {
      dependents.push(...storyIds);
    } else {
      dependsOn.push(...storyIds);
    }
  }

  return {
    dependsOn: sortIds(dependsOn),
    dependents: sortIds(dependents),
  };
}

// ── Atomic Write ────────────────────────────────────────────

function atomicWrite(filePath, data) {
  // Signs the payload first (tracker-specific integrity check) then delegates
  // the durable tmp+fsync+rename to the shared helper.
  const signed = signJson(data);
  sharedAtomicWrite(filePath, `${JSON.stringify(signed, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function readJsonIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function stripTrackerVolatileFields(value) {
  const clone = JSON.parse(JSON.stringify(value || {}));
  delete clone.generatedAt;
  delete clone.generatedBy;
  delete clone._integrity;
  return clone;
}

function trackerSemanticJson(value) {
  return JSON.stringify(stripTrackerVolatileFields(value));
}

// ── Markdown Parsers ────────────────────────────────────────

/**
 * Parse milestones.md to extract milestone IDs, names, epic assignments.
 * Expects: ## Milestone M{n}: Name  or  ## M{n} — Name  or  ## M{n}: Name
 * Epic references: E{n} mentions within milestone sections.
 */
function parseMilestones(content) {
  const milestones = [];
  const lines = content.split('\n');
  let current = null;

  for (const line of lines) {
    // Match milestone headers: ## M1: Name, ## Milestone M1: Name, ## M1 — Name
    const msMatch = line.match(/^##\s+(?:Milestone\s+)?(M\d+)\s*[:\u2014—-]\s*(.+)/i);
    if (msMatch) {
      if (current) milestones.push(current);
      current = {
        id: msMatch[1].toUpperCase(),
        name: msMatch[2].trim(),
        epics: [],
        dependencies: [],
        blocks: [],
        parallelWith: [],
      };
      continue;
    }

    if (!current) continue;

    // Collect epic references within milestone scope.
    // Word-boundaried to avoid matching "E2" inside "E2E:" test labels (a real parser bug
    // observed at planning-fix iteration 2 — phantom E2 inflated storyCount for M3/M4/M6/M7).
    const epicRefs = line.match(/\bE\d+\b/g);
    if (epicRefs) {
      for (const ref of epicRefs) {
        if (!current.epics.includes(ref)) current.epics.push(ref);
      }
    }

    // Collect dependency references (depends on M{n})
    const depMatch = line.match(/depend[s]?\s+on\s+(M\d+)/gi);
    if (depMatch) {
      for (const dep of depMatch) {
        const id = dep.match(/M\d+/i)[0].toUpperCase();
        if (!current.dependencies.includes(id)) current.dependencies.push(id);
      }
    }

    if (/\bblocked-by\b/i.test(line)) {
      current.dependencies.push(...parseIdList(line, /\bM\d+\b/gi));
    }

    if (/\bblocks\b/i.test(line)) {
      current.blocks.push(...parseIdList(line, /\bM\d+\b/gi));
    }

    if (/\bparallel-with\b/i.test(line)) {
      current.parallelWith.push(...parseIdList(line, /\bM\d+\b/gi));
    }
  }
  if (current) milestones.push(current);

  for (const milestone of milestones) {
    milestone.dependencies = sortIds(milestone.dependencies.filter((id) => id !== milestone.id));
    milestone.blocks = sortIds(milestone.blocks.filter((id) => id !== milestone.id));
    milestone.parallelWith = sortIds(milestone.parallelWith.filter((id) => id !== milestone.id));
  }

  return milestones;
}

/**
 * Parse epics.md to extract epic IDs, story IDs, milestone assignments.
 * Expects: ## Epic E{n}: Name  and  ### E{n}-S{n}: Name
 * Milestone refs: (M{n}) or [M{n}] mentions in epic headers.
 */
function parseEpics(content) {
  const epics = [];
  const lines = content.split('\n');
  let current = null;
  let currentStory = null;

  function dedupeRequirementIds(ids) {
    return [...new Set((ids || []).map((id) => id.toUpperCase()))];
  }

  function groupRequirementIds(ids) {
    const groups = { FR: [], NFR: [], TR: [], IR: [] };
    for (const id of dedupeRequirementIds(ids)) {
      const prefix = requirementPrefix(id);
      if (prefix && groups[prefix]) groups[prefix].push(id);
    }
    return groups;
  }

  function finalizeStory() {
    if (!current || !currentStory) return;
    currentStory.requirementIds = dedupeRequirementIds(currentStory.requirementIds);
    const groups = groupRequirementIds(currentStory.requirementIds);
    currentStory.frIds = groups.FR;
    currentStory.nfrIds = groups.NFR;
    currentStory.trIds = groups.TR;
    currentStory.irIds = groups.IR;
    current.stories.push(currentStory);
    currentStory = null;
  }

  function finalizeEpic() {
    if (!current) return;
    finalizeStory();
    const storyRequirementIds = current.stories.flatMap((story) => story.requirementIds || []);
    current.requirementIds = dedupeRequirementIds([...(current.requirementIds || []), ...storyRequirementIds]);
    const groups = groupRequirementIds(current.requirementIds);
    current.frIds = groups.FR;
    current.nfrIds = groups.NFR;
    current.trIds = groups.TR;
    current.irIds = groups.IR;
    // v0.47 CB-OBS-11 (Rdrive101 run): authoring style that mixes a summary
    // table (| E1 | Name | M1 |) with a detail section (## E1: Name) on the
    // same epic must NOT double-count. Prior behavior pushed each match as a
    // separate epic, producing 26 entries for 13 declared epics and
    // propagating duplicate counts into milestone-tracker / story-tracker.
    // Merge-on-duplicate: if an epic with the same id already exists, fold
    // the new current's stories + requirementIds into the existing entry
    // (preferring the later match's name+milestone when they carry more
    // context, e.g., summary-table first then detail-section).
    const existing = epics.find((e) => e.id === current.id);
    if (existing) {
      if (current.name && (!existing.name || current.name.length > existing.name.length)) existing.name = current.name;
      if (current.milestone && !existing.milestone) existing.milestone = current.milestone;
      if (Array.isArray(current.stories) && current.stories.length > 0) {
        existing.stories = (existing.stories || []).concat(current.stories);
      }
      existing.requirementIds = dedupeRequirementIds([
        ...(existing.requirementIds || []),
        ...(current.requirementIds || []),
      ]);
      const eg = groupRequirementIds(existing.requirementIds);
      existing.frIds = eg.FR;
      existing.nfrIds = eg.NFR;
      existing.trIds = eg.TR;
      existing.irIds = eg.IR;
    } else {
      epics.push(current);
    }
    current = null;
  }

  for (const line of lines) {
    // Match epic headers: ## Epic E1: Name, ### Epic M1.E1 — Name
    // Also accept bold (**E1**:) and table-row (| E1 | Name | M1 |) formats.
    const epicMatch =
      line.match(/^#{2,4}\s+(?:Epic\s+)?((?:M\d+\.)?E[A-Z0-9_]+)(?!-S\d)\s*[:\u2014—-]\s*(.+)/i) ||
      line.match(/^#{2,4}\s+(?:Epic\s+)?\*\*((?:M\d+\.)?E[A-Z0-9_]+)\*\*(?!-S\d)\s*[:\u2014—-]\s*(.+)/i) ||
      // v0.47 CB-OBS-10 (Rdrive101 run): require a digit after the E so the
      // plain word "Epic" in summary-table header rows never matches. Prior
      // regex `E[A-Z0-9_]+` with /i matched "Epic" because p/i/c passed the
      // [A-Z0-9_] character class under case-insensitive mode, producing a
      // phantom epic named "EPIC" that broke tracker-init's milestone
      // resolution. Require the id to have at least one digit directly
      // after the E (E1, E10, E2A, E3_V2 all still match; "Epic" does not).
      line.match(/^\|\s*((?:M\d+\.)?E\d+[A-Z0-9_]*)\s*\|\s*([^|]+?)\s*\|/i);
    if (epicMatch) {
      finalizeEpic();
      // Check for milestone assignment in the header or nearby
      const msRef = line.match(/\(?(M\d+)\)?/i);
      current = {
        id: normalizeEpicId(epicMatch[1]) || epicMatch[1].toUpperCase(),
        name: epicMatch[2].trim().replace(/\s*\(M\d+\)\s*/, ''),
        milestone: msRef ? msRef[1].toUpperCase() : null,
        stories: [],
        requirementIds: extractRequirementReferences(line),
      };
      continue;
    }

    // v0.40.5: close the current epic at ANY non-epic H1/H2 heading so
    // trailing appendices (e.g. "## FR Coverage Check") that enumerate
    // FR IDs after the last epic don't pollute the last epic's
    // requirementIds and cascade into story-tracker.json (where the
    // last story absorbs all 39 FR refs and breaks density gates).
    if (current && /^#{1,2}\s+/.test(line)) {
      finalizeEpic();
      continue;
    }

    if (!current) continue;

    // Match story lines: ### E1-S1: Name, **Story M1.S1** — Name,
    // plus whitespace-separated bullets from generated epics: - E1-S1 Name.
    // and the common bold-wrapped variants: - **E1-S1**: Name, ### **E1-S1**: Name.
    // Also accept table-row format: | E1-S1 | Title | Deps |
    const storyMatch =
      line.match(
        /(?:^#{3,6}\s+|^[-*]\s+)?\*{0,2}(?:Story\s+)?(E[A-Z0-9_]+-S\d+|M\d+\.S\d+|S-\d+\.\d+|S-\d+-\d+|S\d+\.\d+|\d+-\d+)\*{0,2}(?:\s*[:\u2014\u2013-]\s*|\s+)(\S.*)/i,
      ) ||
      line.match(
        /^\|\s*\*{0,2}(?:Story\s+)?(E[A-Z0-9_]+-S\d+|M\d+\.S\d+|S-\d+\.\d+|S-\d+-\d+|S\d+\.\d+|\d+-\d+)\*{0,2}\s*\|\s*([^|]+?)\s*\|/i,
      );
    if (storyMatch) {
      finalizeStory();
      currentStory = {
        id: normalizeStoryId(storyMatch[1]) || storyMatch[1].toUpperCase(),
        title: storyMatch[2].trim(),
        requirementIds: extractRequirementReferences(line),
        dependsOn: [],
        dependents: [],
      };
      continue;
    }

    // Fallback: pick up milestone assignment from content lines
    if (!current.milestone) {
      const msRef = line.match(/milestone[:\s]+(M\d+)/i);
      if (msRef) current.milestone = msRef[1].toUpperCase();
    }

    const refs = extractRequirementReferences(line);
    if (currentStory) {
      currentStory.requirementIds.push(...refs);

      const dependencyDirective = parseStoryDependencyDirective(line);
      if (dependencyDirective) {
        currentStory.dependsOn.push(...dependencyDirective.dependsOn);
        currentStory.dependents.push(...dependencyDirective.dependents);
      }
    } else {
      current.requirementIds.push(...refs);
    }
  }
  finalizeEpic();

  syncBidirectionalLinks(
    epics.flatMap((epic) => epic.stories),
    {
      idKey: 'id',
      dependsOnKey: 'dependsOn',
      dependentsKey: 'dependents',
      aliasBlockedBy: false,
      aliasBlocks: false,
    },
  );

  return epics;
}

// ── Generator Functions ─────────────────────────────────────

function generateMilestoneTracker(milestones, epics, options = {}) {
  const { reconciliationDrift = [] } = options;
  const milestoneGraph = new Map(
    milestones.map((milestone) => [
      milestone.id,
      {
        dependsOn: new Set(milestone.dependencies || []),
        dependents: new Set(milestone.blocks || []),
        parallelWith: new Set(milestone.parallelWith || []),
      },
    ]),
  );

  for (const milestone of milestones) {
    for (const upstreamId of milestone.dependencies || []) {
      if (!milestoneGraph.has(upstreamId)) continue;
      milestoneGraph.get(upstreamId).dependents.add(milestone.id);
    }
    for (const downstreamId of milestone.blocks || []) {
      if (!milestoneGraph.has(downstreamId)) continue;
      milestoneGraph.get(downstreamId).dependsOn.add(milestone.id);
    }
    for (const parallelId of milestone.parallelWith || []) {
      if (!milestoneGraph.has(parallelId)) continue;
      milestoneGraph.get(parallelId).parallelWith.add(milestone.id);
    }
  }

  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-tracker-init',
    reconciliationDrift,
    milestones: milestones.map((ms) => {
      const msEpics = epics.filter((e) => e.milestone === ms.id || ms.epics.includes(e.id));
      const storyCount = msEpics.reduce((sum, e) => sum + e.stories.length, 0);
      const graphEntry = milestoneGraph.get(ms.id) || {
        dependsOn: new Set(),
        dependents: new Set(),
        parallelWith: new Set(),
      };
      return {
        id: ms.id,
        name: ms.name,
        status: 'pending',
        gates: {
          'all-stories-complete': false,
          'tests-passing': false,
          'security-scan-clean': false,
          'review-approved': false,
          'audit-passed': false,
        },
        epicCount: msEpics.length,
        storyCount,
        requirementIds: [...new Set(msEpics.flatMap((epic) => epic.requirementIds || []))].sort(),
        frIds: [...new Set(msEpics.flatMap((epic) => epic.frIds || []))].sort(),
        nfrIds: [...new Set(msEpics.flatMap((epic) => epic.nfrIds || []))].sort(),
        trIds: [...new Set(msEpics.flatMap((epic) => epic.trIds || []))].sort(),
        irIds: [...new Set(msEpics.flatMap((epic) => epic.irIds || []))].sort(),
        completedStories: 0,
        blockers: 0,
        dependencies: sortIds([...graphEntry.dependsOn]),
        dependsOn: sortIds([...graphEntry.dependsOn]),
        blockedBy: sortIds([...graphEntry.dependsOn]),
        dependents: sortIds([...graphEntry.dependents]),
        blocks: sortIds([...graphEntry.dependents]),
        parallelWith: sortIds([...graphEntry.parallelWith]),
        startedAt: null,
        completedAt: null,
      };
    }),
  };
}

function generateStoryTracker(epics) {
  const stories = [];
  for (const epic of epics) {
    // v0.18+ fix: reconciliation layer runs before this; if an epic arrives
    // here with no milestone, the tracker run would have already hard-failed.
    // Keep the invariant check local too — belt + suspenders.
    if (!epic.milestone) {
      throw new Error(
        `[cobolt-tracker-init] Invariant violated: epic ${epic.id} has no milestone at story-tracker generation. This should have been caught by reconciliation.`,
      );
    }
    for (const story of epic.stories) {
      stories.push({
        id: story.id,
        title: story.title,
        epic: epic.id,
        milestone: epic.milestone,
        requirementIds: story.requirementIds || [],
        frIds: story.frIds || [],
        nfrIds: story.nfrIds || [],
        trIds: story.trIds || [],
        irIds: story.irIds || [],
        status: 'backlog',
        assignedAgent: null,
        testsWritten: false,
        testsPassing: false,
        reviewed: false,
        blockers: [],
        dependsOn: sortIds(story.dependsOn || []),
        dependents: sortIds(story.dependents || []),
        blockedBy: sortIds(story.dependsOn || []),
        storyFile: null,
        taskCount: 0,
        startedAt: null,
        completedAt: null,
        tasks: [],
      });
    }
  }
  syncBidirectionalLinks(stories, {
    idKey: 'id',
    dependsOnKey: 'dependsOn',
    dependentsKey: 'dependents',
  });
  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-tracker-init',
    stories,
  };
}

function parseFrontmatterIds(value, prefix) {
  if (Array.isArray(value)) return sortIds(value);
  const upperPrefix = String(prefix || '').toUpperCase();
  if (!upperPrefix) return [];
  return parseIdList(String(value || ''), new RegExp(`\\b${upperPrefix}-\\d+\\b`, 'gi'));
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractStoryTitle(content, storyId, frontmatter) {
  const explicitTitle = String(frontmatter?.title || '').trim();
  if (explicitTitle) return explicitTitle;

  const heading = String(content || '')
    .match(/^#\s+(.+)$/m)?.[1]
    ?.trim();
  if (!heading) return storyId;

  return heading
    .replace(new RegExp(`^Story\\s+${escapeRegex(storyId)}\\s*[\\u2014\\u2013:-]\\s*`, 'i'), '')
    .replace(new RegExp(`^${escapeRegex(storyId)}\\s*[\\u2014\\u2013:-]\\s*`, 'i'), '')
    .trim();
}

function createTrackerStoryFromFile(storyFile, pd) {
  const absolutePath = path.isAbsolute(storyFile?.path || '')
    ? storyFile.path
    : path.join(pd, storyFile?.relativePath || '');
  const content = fs.readFileSync(absolutePath, 'utf8');
  const frontmatter = extractFrontmatter(content);
  const storyId = normalizeStoryId(frontmatter.id || storyFile.storyId || path.basename(absolutePath, '.md'));
  if (!storyId) return null;

  const frIds = parseFrontmatterIds(frontmatter.frIds || frontmatter.functionalRequirements, 'FR');
  const nfrIds = parseFrontmatterIds(frontmatter.nfrIds || frontmatter.nonFunctionalRequirements, 'NFR');
  const trIds = parseFrontmatterIds(frontmatter.trIds || frontmatter.technicalRequirements, 'TR');
  const irIds = parseFrontmatterIds(frontmatter.irIds || frontmatter.implicitRequirements, 'IR');
  const explicitRequirementIds = sortIds(
    String(frontmatter.requirementIds || frontmatter.requirements || '')
      .match(/\b(?:FR|NFR|TR|IR)-\d+\b/gi)
      ?.map((id) => id.toUpperCase()) || [],
  );
  const requirementIds = sortIds([...explicitRequirementIds, ...frIds, ...nfrIds, ...trIds, ...irIds]);
  const epic = String(frontmatter.epic || '').trim() || (storyId.includes('-S') ? storyId.split('-S')[0] : null);
  const milestone = String(frontmatter.milestone || '').trim() || null;

  return {
    id: storyId,
    title: extractStoryTitle(content, storyId, frontmatter),
    epic,
    milestone,
    injected: /^LANDING-S\d+$/i.test(storyId) || String(epic || '').toUpperCase() === 'LANDING',
    requirementIds,
    frIds,
    nfrIds,
    trIds,
    irIds,
    status: String(frontmatter.status || 'backlog').replace(/^['"]|['"]$/g, ''),
    assignedAgent: null,
    testsWritten: false,
    testsPassing: false,
    reviewed: false,
    blockers: [],
    dependsOn: [],
    dependents: [],
    blockedBy: [],
    storyFile: storyFile.relativePath || path.relative(pd, absolutePath).replaceAll('\\', '/'),
    taskCount: 0,
    startedAt: null,
    completedAt: null,
    tasks: [],
  };
}

function registerMissingStoryFiles(storyTracker, pd) {
  if (!storyTracker || !Array.isArray(storyTracker.stories)) return 0;

  const knownIds = new Set(storyTracker.stories.map((story) => normalizeStoryId(story.id)).filter(Boolean));
  const discoveredStoryFiles = discoverStoryFiles(pd, { planningDir: pd });
  let added = 0;

  for (const storyFile of discoveredStoryFiles) {
    const storyId = normalizeStoryId(storyFile.storyId);
    if (!storyId || knownIds.has(storyId)) continue;

    const entry = createTrackerStoryFromFile(storyFile, pd);
    if (!entry) continue;

    storyTracker.stories.push(entry);
    knownIds.add(entry.id);
    added += 1;
  }

  if (added > 0) {
    storyTracker.stories.sort((left, right) =>
      String(left.id || '').localeCompare(String(right.id || ''), undefined, { numeric: true }),
    );
  }

  return added;
}

function syncStoryFilesIntoTracker(storyTracker, pd) {
  if (!storyTracker || !Array.isArray(storyTracker.stories)) {
    return { storyTracker, registeredStories: 0, syncedStories: 0, syncedTasks: 0, unresolvedTaskRefs: [] };
  }

  const registeredStories = registerMissingStoryFiles(storyTracker, pd);
  const unresolvedTaskRefs = [];
  const crossStoryTaskEdges = [];
  const allTasks = [];

  for (const story of storyTracker.stories) {
    const storyFile = resolveStoryFile(story.id, pd, { planningDir: pd });
    if (!storyFile) {
      story.storyFile = null;
      story.taskCount = Array.isArray(story.tasks) ? story.tasks.length : 0;
      if (!Array.isArray(story.tasks)) story.tasks = [];
      continue;
    }

    const relativeStoryFile = path.relative(pd, storyFile).replaceAll('\\', '/');
    const content = fs.readFileSync(storyFile, 'utf8');
    const frontmatter = extractFrontmatter(content);
    const tasks = parseTaskList(content, story.id);
    const dependencyRows = parseTaskDependencyMap(content, story.id);

    const taskMap = new Map(tasks.map((task) => [task.localTaskId, task]));
    for (const [localTaskId, row] of dependencyRows.entries()) {
      const task = taskMap.get(localTaskId);
      if (!task) {
        unresolvedTaskRefs.push(`${story.id}:${localTaskId}`);
        continue;
      }
      task.dependsOn = sortIds([...(task.dependsOn || []), ...(row.dependsOn || [])]);
      task.dependents = sortIds([...(task.dependents || []), ...(row.dependents || [])]);
    }

    story.storyFile = relativeStoryFile;
    story.status = String(frontmatter.status || story.status || 'backlog').replace(/^['"]|['"]$/g, '');
    story.tasks = tasks;
    story.taskCount = tasks.length;

    for (const task of tasks) {
      allTasks.push({ storyId: story.id, task });
    }
  }

  const taskById = new Map(allTasks.map(({ task }) => [task.taskId, task]));
  for (const { storyId, task } of allTasks) {
    for (const upstreamTaskId of task.dependsOn || []) {
      const upstreamTask = taskById.get(upstreamTaskId);
      if (!upstreamTask) {
        unresolvedTaskRefs.push(`${task.taskId} -> ${upstreamTaskId}`);
        continue;
      }
      if (!upstreamTask.dependents.includes(task.taskId)) {
        upstreamTask.dependents.push(task.taskId);
      }
      if (!upstreamTaskId.startsWith(`${storyId}:`)) {
        crossStoryTaskEdges.push({ fromStory: storyId, toStory: upstreamTaskId.split(':')[0] });
      }
    }

    for (const downstreamTaskId of task.dependents || []) {
      const downstreamTask = taskById.get(downstreamTaskId);
      if (!downstreamTask) {
        unresolvedTaskRefs.push(`${task.taskId} -> ${downstreamTaskId}`);
        continue;
      }
      if (!downstreamTask.dependsOn.includes(task.taskId)) {
        downstreamTask.dependsOn.push(task.taskId);
      }
      if (!downstreamTaskId.startsWith(`${storyId}:`)) {
        crossStoryTaskEdges.push({ fromStory: downstreamTaskId.split(':')[0], toStory: storyId });
      }
    }
  }

  for (const { task } of allTasks) {
    task.dependsOn = sortIds(task.dependsOn);
    task.dependents = sortIds(task.dependents);
    task.blockedBy = [...task.dependsOn];
  }

  const storyById = new Map(storyTracker.stories.map((story) => [story.id, story]));
  for (const edge of crossStoryTaskEdges) {
    const fromStory = storyById.get(edge.fromStory);
    const toStory = storyById.get(edge.toStory);
    if (!fromStory || !toStory || fromStory.id === toStory.id) continue;
    fromStory.dependsOn = sortIds([...(fromStory.dependsOn || []), toStory.id]);
    toStory.dependents = sortIds([...(toStory.dependents || []), fromStory.id]);
  }

  syncBidirectionalLinks(storyTracker.stories, {
    idKey: 'id',
    dependsOnKey: 'dependsOn',
    dependentsKey: 'dependents',
  });

  return {
    storyTracker,
    registeredStories,
    syncedStories: storyTracker.stories.filter((story) => story.storyFile).length,
    syncedTasks: allTasks.length,
    unresolvedTaskRefs: sortIds(unresolvedTaskRefs),
  };
}

function generateIssueTracker() {
  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-tracker-init',
    issues: [],
    blockers: [],
    escalations: [],
    summary: {
      totalIssues: 0,
      openIssues: 0,
      resolvedIssues: 0,
      totalBlockers: 0,
      activeBlockers: 0,
      totalEscalations: 0,
    },
  };
}

// ── Commands ────────────────────────────────────────────────

function cmdGenerate(args) {
  const pd = planningDir();
  const milestoneOnly = args.includes('--milestone-only') || args.includes('--milestones-only');

  // Resolve input paths (B018 — fall back to feature-mode artifacts)
  let milestonesPath = path.join(pd, 'milestones.md');
  let epicsPath = path.join(pd, 'epics.md');

  const msIdx = args.indexOf('--milestones');
  if (msIdx !== -1 && args[msIdx + 1]) milestonesPath = args[msIdx + 1];
  const epIdx = args.indexOf('--epics');
  if (epIdx !== -1 && args[epIdx + 1]) epicsPath = args[epIdx + 1];

  // B018 — feature-mode produces feature-epics.md; fall back when canonical epics.md is absent
  if (!fs.existsSync(epicsPath)) {
    const featureEpicsPath = path.join(pd, 'feature-epics.md');
    if (fs.existsSync(featureEpicsPath)) {
      epicsPath = featureEpicsPath;
    }
  }

  // Check inputs exist
  if (!fs.existsSync(milestonesPath)) {
    console.error(`[cobolt-tracker-init] Missing: ${milestonesPath}`);
    console.error('  Run /cobolt-plan first to generate milestones.md');
    process.exit(1);
  }
  if (!fs.existsSync(epicsPath)) {
    console.error(`[cobolt-tracker-init] Missing: ${epicsPath}`);
    console.error('  Run /cobolt-plan first to generate epics.md or feature-epics.md');
    process.exit(1);
  }

  // Parse
  const milestonesContent = fs.readFileSync(milestonesPath, 'utf8');
  const epicsContent = fs.readFileSync(epicsPath, 'utf8');

  const milestones = parseMilestones(milestonesContent);
  const epics = parseEpics(epicsContent);

  if (milestones.length === 0) {
    console.error('[cobolt-tracker-init] No milestones found in milestones.md');
    console.error('  Expected: ## M1: Name or ## Milestone M1: Name');
    process.exit(1);
  }
  if (epics.length === 0) {
    console.error('[cobolt-tracker-init] No epics found in epics.md');
    console.error('  Expected: ## Epic E1: Name or ## E1: Name');
    process.exit(1);
  }

  // ── Three-layer epic → milestone reconciliation (v0.18+ fix) ──
  // Layer 1: explicit (Mn) tag in epics.md header — already parsed into epic.milestone.
  // Layer 2: epics.md omits tag → search milestones.md sections for epic ID reference.
  // Layer 3: still unresolved → infer by FR-cluster majority from milestones.md.
  // Layer 4: still unresolved → HARD FAIL (never emit milestone='unassigned').
  const milestoneFrClusters = getMilestoneFRCounts(pd) || {};
  const frToMilestone = {};
  for (const [mid, frs] of Object.entries(milestoneFrClusters)) {
    for (const fr of frs) frToMilestone[fr] = mid;
  }
  const reconciliationDrift = [];

  for (const epic of epics) {
    // Layer 2 — reverse reference.
    if (!epic.milestone) {
      for (const ms of milestones) {
        if (ms.epics.includes(epic.id)) {
          epic.milestone = ms.id;
          epic._reconciledVia = 'milestones-md-reverse-ref';
          break;
        }
      }
    }

    // Layer 3 — FR-cluster majority.
    if (!epic.milestone) {
      const frVotes = {};
      for (const fr of epic.frIds || []) {
        const m = frToMilestone[fr];
        if (m) frVotes[m] = (frVotes[m] || 0) + 1;
      }
      const sorted = Object.entries(frVotes).sort((a, b) => b[1] - a[1]);
      if (sorted.length > 0) {
        epic.milestone = sorted[0][0];
        epic._reconciledVia = 'fr-cluster-majority';
      }
    }

    // Drift detection — epic (Mn) tag vs FR-cluster-inferred milestone.
    if (epic.milestone && epic.frIds && epic.frIds.length > 0) {
      const votes = {};
      for (const fr of epic.frIds) {
        const m = frToMilestone[fr];
        if (m) votes[m] = (votes[m] || 0) + 1;
      }
      const expected = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (expected && expected !== epic.milestone) {
        reconciliationDrift.push({
          epic: epic.id,
          taggedMilestone: epic.milestone,
          frClusterMilestone: expected,
          frIds: epic.frIds,
        });
      }
    }
  }

  // Layer 4 — hard fail if any epic still has no milestone. Silent 'unassigned'
  // propagates to story-tracker.json, sprint-status.yaml, and RTM; we refuse
  // to write trackers in that state.
  const unreconciledEpics = epics.filter((e) => !e.milestone).map((e) => e.id);
  if (unreconciledEpics.length > 0) {
    console.error('[cobolt-tracker-init] HARD FAIL — cannot resolve milestone for epics:');
    for (const id of unreconciledEpics) console.error(`  • ${id}`);
    console.error('');
    console.error('  Every epic must carry an explicit (Mn) tag in epics.md, appear under a');
    console.error('  milestone section in milestones.md, or share FRs with a milestone FR cluster.');
    console.error('  Fix by adding explicit milestone tags in epics.md, then re-run.');
    process.exit(3);
  }

  // Generate
  const msTracker = generateMilestoneTracker(milestones, epics, { reconciliationDrift });
  const storyTracker = generateStoryTracker(epics);
  const issueTracker = generateIssueTracker();
  const storyDir = path.join(pd, 'stories');
  const hasStoryFiles = fs.existsSync(storyDir) && fs.readdirSync(storyDir).some((entry) => entry.endsWith('.md'));
  const syncResult = hasStoryFiles ? syncStoryFilesIntoTracker(storyTracker, pd) : null;

  // Write
  const msPath = path.join(pd, 'milestone-tracker.json');
  const stPath = path.join(pd, 'story-tracker.json');
  const isPath = path.join(pd, 'issue-and-blocker-tracker.json');

  if (milestoneOnly) {
    const existingMilestoneTracker = readJsonIfExists(msPath);
    const changed =
      !existingMilestoneTracker || trackerSemanticJson(existingMilestoneTracker) !== trackerSemanticJson(msTracker);
    if (changed) atomicWrite(msPath, msTracker);
    seedExecutionLedger(process.cwd(), { mode: 'planning-tracker-refresh' });
    projectExecutionLedger(process.cwd());
    console.log(
      changed
        ? '[cobolt-tracker-init] Refreshed milestone-tracker.json only:'
        : '[cobolt-tracker-init] Milestone-tracker.json already current:',
    );
    console.log(`  milestone-tracker.json  â€” ${milestones.length} milestones, ${epics.length} epics`);
    console.log(`  Output: ${msPath}`);
    return;
  }
  atomicWrite(msPath, msTracker);
  atomicWrite(stPath, storyTracker);
  atomicWrite(isPath, issueTracker);
  seedExecutionLedger(process.cwd(), { mode: 'planning-tracker-generate' });
  projectExecutionLedger(process.cwd());

  // Summary
  const totalStories = storyTracker.stories.length;
  console.log('[cobolt-tracker-init] Generated 3 tracker files:');
  console.log(`  milestone-tracker.json  — ${milestones.length} milestones, ${epics.length} epics`);
  console.log(`  story-tracker.json      — ${totalStories} stories`);
  console.log(`  issue-and-blocker-tracker.json — initialized empty`);
  if (syncResult) {
    console.log(
      `  story sync               â€” ${syncResult.syncedStories} story files, ${syncResult.syncedTasks} tracked tasks`,
    );
    if (syncResult.unresolvedTaskRefs.length > 0) {
      console.log(`  warnings                 â€” unresolved task refs: ${syncResult.unresolvedTaskRefs.join(', ')}`);
    }
  }
  console.log(`  Output: ${pd}`);
}

function validateMilestoneTracker(data) {
  const errors = [];
  const milestones = Array.isArray(data?.milestones) ? data.milestones : [];
  const byId = new Map(milestones.map((milestone) => [milestone.id, milestone]));

  for (const milestone of milestones) {
    for (const upstreamId of milestone.dependsOn || milestone.dependencies || []) {
      if (upstreamId === milestone.id) {
        errors.push(`${milestone.id} cannot depend on itself`);
        continue;
      }
      if (!byId.has(upstreamId)) {
        errors.push(`${milestone.id} depends on missing milestone ${upstreamId}`);
        continue;
      }
      if (!(byId.get(upstreamId).dependents || byId.get(upstreamId).blocks || []).includes(milestone.id)) {
        errors.push(`${milestone.id} -> ${upstreamId} is missing reverse milestone link`);
      }
    }
  }

  return errors;
}

function validateStoryTracker(data) {
  const errors = [];
  const stories = Array.isArray(data?.stories) ? data.stories : [];
  const storyById = new Map(stories.map((story) => [story.id, story]));
  const taskById = new Map();

  for (const story of stories) {
    for (const upstreamStoryId of story.dependsOn || []) {
      if (upstreamStoryId === story.id) {
        errors.push(`${story.id} cannot depend on itself`);
        continue;
      }
      if (!storyById.has(upstreamStoryId)) {
        errors.push(`${story.id} depends on missing story ${upstreamStoryId}`);
        continue;
      }
      if (!(storyById.get(upstreamStoryId).dependents || []).includes(story.id)) {
        errors.push(`${story.id} -> ${upstreamStoryId} is missing reverse story link`);
      }
    }

    for (const task of story.tasks || []) {
      if (!task.taskId) {
        errors.push(`${story.id} has a task without taskId`);
        continue;
      }
      if (taskById.has(task.taskId)) {
        errors.push(`Duplicate task ID ${task.taskId}`);
        continue;
      }
      taskById.set(task.taskId, { story, task });
    }
  }

  for (const { story, task } of taskById.values()) {
    for (const upstreamTaskId of task.dependsOn || []) {
      if (upstreamTaskId === task.taskId) {
        errors.push(`${task.taskId} cannot depend on itself`);
        continue;
      }
      const upstream = taskById.get(upstreamTaskId);
      if (!upstream) {
        errors.push(`${task.taskId} depends on missing task ${upstreamTaskId}`);
        continue;
      }
      if (!(upstream.task.dependents || []).includes(task.taskId)) {
        errors.push(`${task.taskId} -> ${upstreamTaskId} is missing reverse task link`);
      }
      if (story.storyFile && !task.taskId.startsWith(`${story.id}:`)) {
        errors.push(`${task.taskId} is assigned to ${story.id} but uses a mismatched story prefix`);
      }
    }
  }

  return errors;
}

function cmdValidate() {
  const pd = planningDir();
  const files = ['milestone-tracker.json', 'story-tracker.json', 'issue-and-blocker-tracker.json'];
  let allValid = true;
  let milestoneData = null;
  let storyData = null;

  for (const file of files) {
    const fp = path.join(pd, file);
    if (!fs.existsSync(fp)) {
      console.error(`  MISSING: ${file}`);
      allValid = false;
      continue;
    }
    try {
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (!data.version || !data.generatedAt) {
        console.error(`  INVALID: ${file} â€” missing version or generatedAt`);
        allValid = false;
      } else {
        const size = fs.statSync(fp).size;
        console.log(`  OK: ${file} (${size} bytes, v${data.version})`);
        if (file === 'milestone-tracker.json') milestoneData = data;
        if (file === 'story-tracker.json') storyData = data;
      }
    } catch (err) {
      console.error(`  INVALID: ${file} â€” ${err.message}`);
      allValid = false;
    }
  }

  for (const error of validateMilestoneTracker(milestoneData)) {
    console.error(`  INVALID: milestone-tracker.json â€” ${error}`);
    allValid = false;
  }

  for (const error of validateStoryTracker(storyData)) {
    console.error(`  INVALID: story-tracker.json â€” ${error}`);
    allValid = false;
  }

  process.exit(allValid ? 0 : 1);
}

function cmdSyncStoryFiles() {
  const pd = planningDir();
  const trackerPath = path.join(pd, 'story-tracker.json');

  if (!fs.existsSync(trackerPath)) {
    console.error(`[cobolt-tracker-init] Missing: ${trackerPath}`);
    console.error('  Run: node tools/cobolt-tracker-init.js generate');
    process.exit(1);
  }

  const originalTracker = JSON.parse(fs.readFileSync(trackerPath, 'utf8'));
  const storyTracker = JSON.parse(JSON.stringify(originalTracker));
  const result = syncStoryFilesIntoTracker(storyTracker, pd);
  const changed = trackerSemanticJson(originalTracker) !== trackerSemanticJson(storyTracker);
  if (changed) {
    storyTracker.generatedAt = new Date().toISOString();
    storyTracker.generatedBy = 'cobolt-tracker-init:sync-story-files';
    atomicWrite(trackerPath, storyTracker);
  }

  console.log('[cobolt-tracker-init] Synced story files into story-tracker.json:');
  console.log(`  Newly registered stories: ${result.registeredStories}`);
  console.log(`  Stories with files: ${result.syncedStories}`);
  console.log(`  Tasks tracked: ${result.syncedTasks}`);
  console.log(`  Changed: ${changed ? 'yes' : 'no'}`);
  if (result.unresolvedTaskRefs.length > 0) {
    console.log(`  Unresolved task refs: ${result.unresolvedTaskRefs.join(', ')}`);
  }
  console.log(`  Output: ${trackerPath}`);
}

function cmdStatus() {
  const pd = planningDir();
  const msPath = path.join(pd, 'milestone-tracker.json');

  if (!fs.existsSync(msPath)) {
    console.log('[cobolt-tracker-init] No trackers found. Run: node tools/cobolt-tracker-init.js generate');
    process.exit(1);
  }

  const ms = JSON.parse(fs.readFileSync(msPath, 'utf8'));
  const st = (() => {
    const p = path.join(pd, 'story-tracker.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  })();

  console.log('[cobolt-tracker-init] Tracker Status:');
  console.log(`  Generated: ${ms.generatedAt}`);
  console.log(`  Milestones: ${ms.milestones.length}`);
  for (const m of ms.milestones) {
    const gatesPassed = Object.values(m.gates).filter(Boolean).length;
    const totalGates = Object.keys(m.gates).length;
    console.log(
      `    ${m.id}: ${m.name} — ${m.status} (${m.completedStories}/${m.storyCount} stories, ${gatesPassed}/${totalGates} gates)`,
    );
  }
  if (st) {
    const backlog = st.stories.filter((s) => s.status === 'backlog' || s.status === 'pending').length;
    const inProgress = st.stories.filter((s) => s.status === 'in-progress').length;
    const done = st.stories.filter((s) => s.status === 'completed' || s.status === 'done').length;
    console.log(`  Stories: ${st.stories.length} total (${backlog} backlog, ${inProgress} in-progress, ${done} done)`);
    const taskCount = st.stories.reduce((sum, story) => sum + (story.taskCount || (story.tasks || []).length || 0), 0);
    const dependencyEdges = st.stories.reduce((sum, story) => sum + (story.dependsOn || []).length, 0);
    console.log(`  Task links: ${taskCount} tasks, ${dependencyEdges} story dependency edges`);
  }
}

// ── CLI Dispatch ────────────────────────────────────────────

if (require.main === module) {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case 'generate':
      cmdGenerate(args);
      break;
    case 'sync-story-files':
      cmdSyncStoryFiles();
      break;
    case 'validate':
      cmdValidate();
      break;
    case 'status':
      cmdStatus();
      break;
    default: {
      console.log('CoBolt Tracker Init — Deterministic JSON tracker generator');
      console.log('');
      console.log('Usage:');
      console.log('  node tools/cobolt-tracker-init.js generate [--milestones <p>] [--epics <p>] [--milestone-only]');
      console.log('  node tools/cobolt-tracker-init.js sync-story-files');
      console.log('  node tools/cobolt-tracker-init.js validate');
      console.log('  node tools/cobolt-tracker-init.js status');
      console.log('');
      console.log('Replaces cobolt-create-milestone-trackers skill with deterministic generation.');
      const isHelpOrEmpty = command === undefined || command === '--help' || command === '-h';
      process.exit(isHelpOrEmpty ? 0 : 1);
    }
  }
}

module.exports = { parseEpics, validateStoryTracker, validateMilestoneTracker, syncStoryFilesIntoTracker };
