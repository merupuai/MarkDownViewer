#!/usr/bin/env node

// CoBolt Story Gen - Deterministic story file discovery and dispatch list
//
// Reads sprint-status.yaml (or story-tracker.json) and compares against
// actual story files on disk. Outputs the list of missing story IDs that
// need cobolt-create-story invocation.
//
// This tool closes the gap where Step 30a in cobolt-plan relied on prose
// instructions to loop over all milestones — Claude would generate M1
// stories and stop. Now the loop is deterministic.
//
// Usage:
//   node tools/cobolt-story-gen.js list                  # List ALL story IDs from sprint-status.yaml
//   node tools/cobolt-story-gen.js missing               # List story IDs with no file on disk
//   node tools/cobolt-story-gen.js missing --json        # Machine-readable missing list
//   node tools/cobolt-story-gen.js missing --milestone M2  # Missing stories for one milestone
//   node tools/cobolt-story-gen.js coverage              # Coverage summary per milestone
//   node tools/cobolt-story-gen.js dispatch              # Output cobolt-create-story commands for missing
//   node tools/cobolt-story-gen.js dispatch --autonomous # Append --autonomous flag to commands
//
// Exit codes:
//   0 = success (or no missing stories)
//   1 = missing stories found (for missing/dispatch commands)
//   2 = usage error or missing input files

const fs = require('node:fs');
const path = require('node:path');
const {
  getPlanningDir,
  normalizeStoryId,
  resolveStoryFile,
  safeReadJson,
} = require('../lib/cobolt-planning-artifacts');

let parseEpicsFromMarkdown = null;
try {
  ({ parseEpics: parseEpicsFromMarkdown } = require('./cobolt-tracker-init'));
} catch {
  parseEpicsFromMarkdown = null;
}

// ── Sprint YAML parser (minimal, zero-dep) ─────────────────

function parseSprintYaml(content) {
  const stories = [];
  let currentEpic = null;
  let currentMilestone = null;
  let currentStory = {};

  for (const line of content.split('\n')) {
    const epicIdMatch = line.match(/^\s+id:\s+(E\d+)\s*$/i);
    if (epicIdMatch) {
      currentEpic = epicIdMatch[1].toUpperCase();
      continue;
    }

    const milestoneMatch = line.match(/^\s+milestone:\s+(\S+)/i);
    if (milestoneMatch && !currentStory.id) {
      currentMilestone = milestoneMatch[1].toUpperCase();
      continue;
    }

    const storyIdMatch = line.match(/^\s+id:\s+(E[A-Z0-9_]+-S\d+|S-\d+\.\d+|S-\d+-\d+|S\d+\.\d+|\d+-\d+)\s*$/i);
    if (storyIdMatch) {
      if (currentStory.id) {
        stories.push({ ...currentStory });
      }
      currentStory = {
        id: normalizeStoryId(storyIdMatch[1]),
        epic: currentEpic,
        milestone: currentMilestone,
        status: null,
        title: null,
        storyFile: null,
      };
      continue;
    }

    if (currentStory.id) {
      const statusMatch = line.match(/^\s+status:\s+(\S+)/);
      if (statusMatch) {
        currentStory.status = statusMatch[1].toLowerCase();
        continue;
      }
      const titleMatch = line.match(/^\s+title:\s+(.+)/);
      if (titleMatch) {
        currentStory.title = titleMatch[1].trim().replace(/^["']|["']$/g, '');
        continue;
      }
      const fileMatch = line.match(/^\s+storyFile:\s+(\S+)/);
      if (fileMatch) {
        currentStory.storyFile = fileMatch[1] === 'null' ? null : fileMatch[1];
      }
    }
  }

  if (currentStory.id) stories.push(currentStory);
  return stories;
}

// ── Landing page story injection ───────────────────────────

const LANDING_STORY_ID = 'LANDING-S1';

/**
 * Check if a landing page story should be auto-injected.
 * Conditions: design-tokens.json exists AND ux-design-specification.md exists
 * AND no landing page story file already on disk.
 */
function getInjectedStories(pd) {
  const tokensPath = path.join(process.cwd(), 'design-tokens.json');
  const uxSpecPath = path.join(pd, 'ux-design-specification.md');

  if (!fs.existsSync(tokensPath) || !fs.existsSync(uxSpecPath)) return [];

  // Check if a landing page story file already exists
  const storiesDir = path.join(pd, 'stories');
  if (fs.existsSync(storiesDir)) {
    try {
      const files = fs.readdirSync(storiesDir);
      const hasLanding = files.some((f) => f.toLowerCase().includes('landing'));
      if (hasLanding) return [];
    } catch {
      // If we can't read stories dir, proceed with injection
    }
  }

  return [
    {
      id: LANDING_STORY_ID,
      epic: 'LANDING',
      milestone: 'M1',
      status: 'backlog',
      title: 'Project Landing Page',
      storyFile: null,
      injected: true,
    },
  ];
}

// ── Core logic ──────────────────────────────────────────────

function loadStoriesFromEpics(pd) {
  if (typeof parseEpicsFromMarkdown !== 'function') return [];
  const epicsPath = path.join(pd, 'epics.md');
  if (!fs.existsSync(epicsPath)) return [];

  let epics;
  try {
    epics = parseEpicsFromMarkdown(fs.readFileSync(epicsPath, 'utf8'));
  } catch {
    return [];
  }

  return epics.flatMap((epic) =>
    (epic.stories || [])
      .map((story) => {
        const id = normalizeStoryId(story.id);
        if (!id) return null;
        return {
          id,
          epic: epic.id || null,
          milestone: epic.milestone || null,
          status: 'backlog',
          title: story.title || null,
          storyFile: null,
        };
      })
      .filter(Boolean),
  );
}

function loadAllStories(pd) {
  let result = { source: null, stories: [] };

  // Primary: sprint-status.yaml
  const sprintPath = path.join(pd, 'sprint-status.yaml');
  if (fs.existsSync(sprintPath)) {
    const content = fs.readFileSync(sprintPath, 'utf8');
    const stories = parseSprintYaml(content);
    if (stories.length > 0) result = { source: 'sprint-status.yaml', stories };
  }

  // Fallback: story-tracker.json
  if (result.stories.length === 0) {
    const trackerPath = path.join(pd, 'story-tracker.json');
    const tracker = safeReadJson(trackerPath);
    if (Array.isArray(tracker?.stories) && tracker.stories.length > 0) {
      result = {
        source: 'story-tracker.json',
        stories: tracker.stories.map((s) => ({
          id: normalizeStoryId(s.id),
          epic: s.epic || null,
          milestone: s.milestone || null,
          status: (s.status || 'backlog').toLowerCase(),
          title: s.title || null,
          storyFile: s.storyFile || null,
        })),
      };
    }
  }

  // Last-resort recovery: epics.md is the source document that both
  // sprint-status and story-tracker are derived from. If either derived file is
  // empty or stale, keep story generation dispatchable instead of reporting
  // "no stories found" while the planning packet visibly contains stories.
  if (result.stories.length === 0) {
    const stories = loadStoriesFromEpics(pd);
    if (stories.length > 0) result = { source: 'epics.md', stories };
  }

  // Merge injected stories (landing page, etc.) if not already present
  const injected = getInjectedStories(pd);
  for (const story of injected) {
    const exists = result.stories.some((s) => s.id === story.id);
    if (!exists) {
      result.stories.push(story);
    }
  }

  return result;
}

function classifyStories(pd, stories) {
  return stories.map((story) => {
    // Injected stories (like LANDING-S1) use a different file naming convention
    if (story.injected) {
      const storiesDir = path.join(pd, 'stories');
      const landingFile = fs.existsSync(storiesDir)
        ? fs.readdirSync(storiesDir).find((f) => f.toLowerCase().includes('landing'))
        : null;
      const filePath = landingFile ? path.join(storiesDir, landingFile) : null;
      return {
        ...story,
        hasFile: !!filePath,
        filePath: filePath ? path.relative(pd, filePath).replaceAll('\\', '/') : null,
      };
    }

    const fileOnDisk = resolveStoryFile(story.id, pd, { planningDir: pd });
    return {
      ...story,
      hasFile: !!fileOnDisk,
      filePath: fileOnDisk ? path.relative(pd, fileOnDisk).replaceAll('\\', '/') : null,
    };
  });
}

function filterByMilestone(stories, milestone) {
  if (!milestone) return stories;
  const normalized = milestone.toUpperCase();
  return stories.filter((s) => s.milestone === normalized);
}

function sortByMilestone(stories) {
  return [...stories].sort((a, b) => {
    const mA = parseInt((a.milestone || 'M999').replace(/^M/i, ''), 10);
    const mB = parseInt((b.milestone || 'M999').replace(/^M/i, ''), 10);
    if (mA !== mB) return mA - mB;
    return (a.id || '').localeCompare(b.id || '', undefined, { numeric: true });
  });
}

// ── Commands ────────────────────────────────────────────────

function cmdList(args) {
  const pd = getPlanningDir(process.cwd(), { strict: true, fallbackToLatest: true });
  if (!pd) {
    console.error('[cobolt-story-gen] No planning directory found.');
    process.exit(2);
  }

  const { source, stories } = loadAllStories(pd);
  if (stories.length === 0) {
    console.error('[cobolt-story-gen] No stories found. Run cobolt-sprint-plan.js generate first.');
    process.exit(2);
  }

  const milestone = extractFlag(args, '--milestone');
  const classified = classifyStories(pd, filterByMilestone(stories, milestone));
  const sorted = sortByMilestone(classified);

  const isJson = args.includes('--json');
  if (isJson) {
    console.log(JSON.stringify({ source, stories: sorted }, null, 2));
    return;
  }

  console.log(`[cobolt-story-gen] All stories (source: ${source}):`);
  for (const s of sorted) {
    const fileTag = s.hasFile ? '[FILE]' : '[NONE]';
    console.log(`  ${s.milestone || '??'} | ${s.id} | ${s.status || '??'} | ${fileTag} | ${s.title || ''}`);
  }
  console.log(`  Total: ${sorted.length}`);
}

function cmdMissing(args) {
  const pd = getPlanningDir(process.cwd(), { strict: true, fallbackToLatest: true });
  if (!pd) {
    console.error('[cobolt-story-gen] No planning directory found.');
    process.exit(2);
  }

  const { source, stories } = loadAllStories(pd);
  if (stories.length === 0) {
    console.error('[cobolt-story-gen] No stories found. Run cobolt-sprint-plan.js generate first.');
    process.exit(2);
  }

  const milestone = extractFlag(args, '--milestone');
  const classified = classifyStories(pd, filterByMilestone(stories, milestone));
  const missing = sortByMilestone(classified.filter((s) => !s.hasFile));

  const isJson = args.includes('--json');
  if (isJson) {
    console.log(
      JSON.stringify(
        {
          source,
          total: classified.length,
          missing: missing.length,
          coverage:
            classified.length > 0 ? Math.round(((classified.length - missing.length) / classified.length) * 100) : 100,
          storyIds: missing.map((s) => s.id),
          stories: missing,
        },
        null,
        2,
      ),
    );
  } else {
    if (missing.length === 0) {
      console.log('[cobolt-story-gen] All story files present. Coverage: 100%');
      return;
    }

    console.log(`[cobolt-story-gen] Missing story files (${missing.length}/${classified.length}):`);
    for (const s of missing) {
      console.log(`  ${s.milestone || '??'} | ${s.id} | ${s.title || ''}`);
    }
    console.log(`  Coverage: ${Math.round(((classified.length - missing.length) / classified.length) * 100)}%`);
  }

  if (missing.length > 0) process.exit(1);
}

function cmdCoverage(args) {
  const pd = getPlanningDir(process.cwd(), { strict: true, fallbackToLatest: true });
  if (!pd) {
    console.error('[cobolt-story-gen] No planning directory found.');
    process.exit(2);
  }

  const { source, stories } = loadAllStories(pd);
  if (stories.length === 0) {
    console.error('[cobolt-story-gen] No stories found.');
    process.exit(2);
  }

  const classified = classifyStories(pd, stories);

  // Group by milestone
  const byMilestone = new Map();
  for (const s of classified) {
    const key = s.milestone || 'unassigned';
    if (!byMilestone.has(key)) byMilestone.set(key, { total: 0, present: 0, missing: [] });
    const bucket = byMilestone.get(key);
    bucket.total++;
    if (s.hasFile) {
      bucket.present++;
    } else {
      bucket.missing.push(s.id);
    }
  }

  // Sort milestones
  const sortedKeys = [...byMilestone.keys()].sort((a, b) => {
    const nA = parseInt(a.replace(/^M/i, ''), 10) || 999;
    const nB = parseInt(b.replace(/^M/i, ''), 10) || 999;
    return nA - nB;
  });

  const isJson = args.includes('--json');
  if (isJson) {
    const result = {};
    for (const key of sortedKeys) {
      const bucket = byMilestone.get(key);
      result[key] = {
        total: bucket.total,
        present: bucket.present,
        missing: bucket.missing,
        coverage: bucket.total > 0 ? Math.round((bucket.present / bucket.total) * 100) : 100,
      };
    }
    console.log(JSON.stringify({ source, milestones: result }, null, 2));
    return;
  }

  console.log(`[cobolt-story-gen] Story coverage per milestone (source: ${source}):`);
  let totalAll = 0;
  let presentAll = 0;
  for (const key of sortedKeys) {
    const bucket = byMilestone.get(key);
    totalAll += bucket.total;
    presentAll += bucket.present;
    const pct = bucket.total > 0 ? Math.round((bucket.present / bucket.total) * 100) : 100;
    const bar = pct === 100 ? 'COMPLETE' : `${bucket.missing.length} missing`;
    console.log(`  ${key}: ${bucket.present}/${bucket.total} (${pct}%) — ${bar}`);
    if (bucket.missing.length > 0 && bucket.missing.length <= 5) {
      for (const id of bucket.missing) console.log(`    -> ${id}`);
    }
  }
  const totalPct = totalAll > 0 ? Math.round((presentAll / totalAll) * 100) : 100;
  console.log(`  ─────────────────────────────`);
  console.log(`  TOTAL: ${presentAll}/${totalAll} (${totalPct}%)`);
}

function cmdDispatch(args) {
  const pd = getPlanningDir(process.cwd(), { strict: true, fallbackToLatest: true });
  if (!pd) {
    console.error('[cobolt-story-gen] No planning directory found.');
    process.exit(2);
  }

  const { stories } = loadAllStories(pd);
  if (stories.length === 0) {
    console.error('[cobolt-story-gen] No stories found.');
    process.exit(2);
  }

  const milestone = extractFlag(args, '--milestone');
  const autonomous = args.includes('--autonomous');
  const classified = classifyStories(pd, filterByMilestone(stories, milestone));
  const missing = sortByMilestone(classified.filter((s) => !s.hasFile));

  if (missing.length === 0) {
    console.log('[cobolt-story-gen] All story files present. Nothing to dispatch.');
    return;
  }

  console.log(`[cobolt-story-gen] Dispatch commands for ${missing.length} missing stories:`);
  for (const s of missing) {
    const flag = autonomous ? ' --autonomous' : '';
    console.log(`cobolt-create-story ${s.id}${flag}`);
  }
  console.log('');
  console.log(
    `# Run each command above via: Skill tool -> skill: "cobolt-create-story", args: "<story-id>${autonomous ? ' --autonomous' : ''}"`,
  );

  process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────

function extractFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || !args[idx + 1]) return null;
  return args[idx + 1];
}

function printUsage() {
  console.log('CoBolt Story Gen - Deterministic story file discovery and dispatch');
  console.log('');
  console.log('Usage:');
  console.log('  node tools/cobolt-story-gen.js list [--json] [--milestone M1]');
  console.log('  node tools/cobolt-story-gen.js missing [--json] [--milestone M2]');
  console.log('  node tools/cobolt-story-gen.js coverage [--json]');
  console.log('  node tools/cobolt-story-gen.js dispatch [--autonomous] [--milestone M1]');
  console.log('');
  console.log('Commands:');
  console.log('  list      List all tracked stories and their file status');
  console.log('  missing   List stories that have no file on disk (exit 1 if any)');
  console.log('  coverage  Coverage summary grouped by milestone');
  console.log('  dispatch  Output cobolt-create-story commands for missing stories');
}

// ── Entry point ─────────────────────────────────────────────

if (require.main === module) {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case 'list':
      cmdList(args);
      break;
    case 'missing':
      cmdMissing(args);
      break;
    case 'coverage':
      cmdCoverage(args);
      break;
    case 'dispatch':
      cmdDispatch(args);
      break;
    case '--help':
    case '-h':
    case undefined: {
      printUsage();
      process.exit(0);
      break;
    }
    default: {
      printUsage();
      process.exit(1);
    }
  }
}

module.exports = {
  loadAllStories,
  classifyStories,
  filterByMilestone,
  sortByMilestone,
  parseSprintYaml,
  loadStoriesFromEpics,
  getInjectedStories,
  LANDING_STORY_ID,
};
