#!/usr/bin/env node

// CoBolt Sprint Plan - Deterministic sprint-status.yaml generator
//
// Replaces cobolt-sprint-planning skill with a deterministic script.
// Parses epics.md, detects story file existence, and generates sprint-status.yaml.
//
// Usage:
//   node tools/cobolt-sprint-plan.js generate                # Generate sprint-status.yaml
//   node tools/cobolt-sprint-plan.js generate --epics <p>    # Custom epics path
//   node tools/cobolt-sprint-plan.js status                  # Show current sprint status
//   node tools/cobolt-sprint-plan.js update <story-id> <st> # Update story status
//
// Exit codes:
//   0 = success
//   1 = missing input files
//   2 = usage error

const fs = require('node:fs');
const path = require('node:path');
const {
  getPlanningDir,
  getMilestoneFRCounts,
  getMilestoneIds,
  normalizeStoryId,
  resolveStoryFile,
} = require('../lib/cobolt-planning-artifacts');

function planningDir() {
  return getPlanningDir(process.cwd(), { create: true });
}

// YAML emitter (minimal, zero-dep)
function toYaml(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  let out = '';

  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (typeof item === 'object' && item !== null) {
        out += `${pad}-\n`;
        out += toYaml(item, indent + 1);
      } else {
        out += `${pad}- ${yamlValue(item)}\n`;
      }
    }
  } else if (typeof obj === 'object' && obj !== null) {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        out += `${pad}${key}:\n`;
        out += toYaml(value, indent + 1);
      } else if (Array.isArray(value)) {
        out += `${pad}${key}:\n`;
        out += toYaml(value, indent + 1);
      } else {
        out += `${pad}${key}: ${yamlValue(value)}\n`;
      }
    }
  }
  return out;
}

function yamlValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (
      value.includes(':') ||
      value.includes('#') ||
      value.includes("'") ||
      value.includes('"') ||
      value.includes('\n')
    ) {
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  return String(value);
}

// Epic/story parser
function parseEpics(content) {
  const epics = [];
  const lines = content.split('\n');
  let current = null;

  for (const line of lines) {
    const epicMatch = line.match(/^##\s+(?:Epic\s+)?(E[A-Z0-9_]+)\s*[:\u2014-]\s*(.+)/i);
    if (epicMatch) {
      if (current) epics.push(current);
      const milestoneRef = line.match(/\(?(M\d+)\)?/i);
      current = {
        id: epicMatch[1].toUpperCase(),
        name: epicMatch[2].trim().replace(/\s*\(M\d+\)\s*/, ''),
        milestone: milestoneRef ? milestoneRef[1].toUpperCase() : null,
        stories: [],
      };
      continue;
    }

    if (!current) continue;

    if (!current.milestone) {
      const milestoneMatch = line.match(/\bmilestone\b\W+(M\d+)\b/i);
      if (milestoneMatch) current.milestone = milestoneMatch[1].toUpperCase();
    }

    // Accept bold-wrapped IDs (`- **E1-S1**: Title`) — common markdown convention.
    const storyMatch = line.match(
      // v0.47 CB-OBS-12 (Rdrive101): allow nested bullet indentation so stories
      // declared under a parent "- **Stories:**" bullet still parse. Prior
      // /^[-*]\s+/ required column 0 and missed every nested-list convention.
      /(?:^\s*###\s+|^\s*[-*+]\s+)\*{0,2}(E[A-Z0-9_]+-S\d+|LANDING-S\d+|S-\d+\.\d+|S-\d+-\d+|S\d+\.\d+|\d+-\d+)\*{0,2}\s*[:\u2014-]\s*(.+)/i,
    );
    if (storyMatch) {
      current.stories.push({
        id: normalizeStoryId(storyMatch[1]) || storyMatch[1].toUpperCase(),
        title: storyMatch[2].trim(),
      });
    }
  }

  if (current) epics.push(current);
  return epics;
}

// Status detection
const STATUS_FLOW = ['backlog', 'ready-for-dev', 'in-progress', 'review', 'done'];

function normalizeStoryStatus(status) {
  const normalized = String(status || '')
    .trim()
    .toLowerCase();

  switch (normalized) {
    case 'pending':
      return 'backlog';
    case 'ready':
      return 'ready-for-dev';
    case 'completed':
      return 'done';
    case 'backlog':
    case 'ready-for-dev':
    case 'in-progress':
    case 'review':
    case 'done':
      return normalized;
    default:
      return null;
  }
}

function detectStoryStatus(storyId, pd) {
  const storyFile = resolveStoryFile(storyId, pd, { planningDir: pd });
  if (!storyFile) return 'backlog';

  const content = fs.readFileSync(storyFile, 'utf8');
  const statusMatch = content.match(
    /status:\s*(backlog|pending|ready|ready-for-dev|in-progress|review|done|completed)/i,
  );

  if (statusMatch) {
    return normalizeStoryStatus(statusMatch[1]) || 'ready-for-dev';
  }

  return 'ready-for-dev';
}

// Commands
function cmdGenerate(args) {
  const pd = planningDir();

  let epicsPath = path.join(pd, 'epics.md');
  const epicsArgIndex = args.indexOf('--epics');
  if (epicsArgIndex !== -1 && args[epicsArgIndex + 1]) epicsPath = args[epicsArgIndex + 1];

  // B015/F-03 fix: fall back to feature-epics.md when canonical epics.md is absent
  if (!fs.existsSync(epicsPath)) {
    const featureEpicsPath = path.join(pd, 'feature-epics.md');
    if (fs.existsSync(featureEpicsPath)) {
      epicsPath = featureEpicsPath;
    }
  }

  if (!fs.existsSync(epicsPath)) {
    console.error(`[cobolt-sprint-plan] Missing: ${epicsPath}`);
    console.error('  Run /cobolt-plan first to generate epics.md or feature-epics.md');
    process.exit(1);
  }

  const epicsContent = fs.readFileSync(epicsPath, 'utf8');
  const epics = parseEpics(epicsContent);

  if (epics.length === 0) {
    console.error('[cobolt-sprint-plan] No epics found in epics.md');
    process.exit(1);
  }

  // ── Epic → milestone reconciliation (v0.18+ fix) ──
  // Mirrors the logic in cobolt-tracker-init.js so sprint-status.yaml never
  // emits milestone='unassigned' silently. Layers: (1) explicit (Mn) tag in
  // epics.md header (already parsed), (2) milestones.md FR-cluster majority,
  // (3) hard fail. Running sprint-plan before tracker-init must produce
  // identical milestone assignments so the two trackers stay in sync.
  const milestoneIds = getMilestoneIds(pd);
  const milestoneFrClusters = getMilestoneFRCounts(pd) || {};
  const frToMilestone = {};
  for (const [mid, frs] of Object.entries(milestoneFrClusters)) {
    for (const fr of frs) frToMilestone[fr] = mid;
  }
  const unresolved = [];
  for (const epic of epics) {
    if (epic.milestone) continue;
    // FR-cluster majority fallback.
    const epicFrs = [];
    for (const story of epic.stories || []) {
      for (const m of String(story.title || '').matchAll(/\bFR[-\s]?(\d{1,4})\b/gi)) {
        epicFrs.push(`FR-${String(parseInt(m[1], 10)).padStart(3, '0')}`);
      }
    }
    const votes = {};
    for (const fr of epicFrs) {
      const mid = frToMilestone[fr];
      if (mid) votes[mid] = (votes[mid] || 0) + 1;
    }
    const winner = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (winner) {
      epic.milestone = winner;
    } else {
      unresolved.push(epic.id);
    }
  }

  if (unresolved.length > 0) {
    console.error('[cobolt-sprint-plan] HARD FAIL — cannot resolve milestone for epics:');
    for (const id of unresolved) console.error(`  • ${id}`);
    console.error('');
    console.error('  Every epic must carry an explicit (Mn) tag in epics.md, or share FRs with a');
    console.error('  milestone FR cluster in milestones.md. Fix epics.md and re-run.');
    process.exit(3);
  }

  // Verify every epic.milestone references a real milestone ID.
  if (milestoneIds.length > 0) {
    const phantomTags = epics
      .filter((e) => e.milestone && !milestoneIds.includes(e.milestone))
      .map((e) => ({ epic: e.id, milestone: e.milestone }));
    if (phantomTags.length > 0) {
      console.error('[cobolt-sprint-plan] HARD FAIL — epics reference phantom milestones not in milestones.md:');
      for (const { epic, milestone } of phantomTags) console.error(`  • ${epic} → ${milestone}`);
      console.error('  Valid milestones:', milestoneIds.join(', '));
      process.exit(4);
    }
  }

  // Check for landing page story injection
  const { getInjectedStories, LANDING_STORY_ID } = require('./cobolt-story-gen');
  const injected = getInjectedStories(pd);
  const hasLandingStory = injected.some((s) => s.id === LANDING_STORY_ID);

  const sprintEpics = epics.map((epic) => ({
    id: epic.id,
    name: epic.name,
    milestone: epic.milestone, // never 'unassigned' — reconciled above
    stories: epic.stories.map((story) => {
      const storyFile = resolveStoryFile(story.id, pd, { planningDir: pd });
      return {
        id: story.id,
        title: story.title,
        status: detectStoryStatus(story.id, pd),
        storyFile: storyFile ? path.relative(pd, storyFile).replaceAll('\\', '/') : null,
      };
    }),
  }));

  // Inject landing page epic at the front of M1 if conditions are met
  if (hasLandingStory) {
    const landingEpic = {
      id: 'LANDING',
      name: 'Project Landing Page',
      milestone: 'M1',
      stories: [
        {
          id: LANDING_STORY_ID,
          title: 'Project Landing Page',
          status: 'backlog',
          storyFile: null,
        },
      ],
    };
    // Insert before the first epic to give it priority in M1
    sprintEpics.unshift(landingEpic);
  }

  const sprint = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-sprint-plan',
    epics: sprintEpics,
  };

  const allStories = sprint.epics.flatMap((epic) => epic.stories);
  sprint.summary = {
    totalEpics: sprint.epics.length,
    totalStories: allStories.length,
    byStatus: {},
  };

  for (const status of STATUS_FLOW) {
    sprint.summary.byStatus[status] = allStories.filter((story) => story.status === status).length;
  }

  const yamlContent =
    '# Sprint Status - Auto-generated by cobolt-sprint-plan\n' +
    `# ${new Date().toISOString()}\n` +
    '# DO NOT EDIT MANUALLY - regenerate with: node tools/cobolt-sprint-plan.js generate\n\n' +
    toYaml(sprint);

  const outPath = path.join(pd, 'sprint-status.yaml');
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outPath, yamlContent, 'utf8');

  console.log('[cobolt-sprint-plan] Generated sprint-status.yaml:');
  console.log(`  Epics: ${sprint.epics.length}`);
  console.log(`  Stories: ${allStories.length}`);
  for (const [status, count] of Object.entries(sprint.summary.byStatus)) {
    if (count > 0) console.log(`    ${status}: ${count}`);
  }
  console.log(`  Output: ${outPath}`);
}

function cmdStatus() {
  const pd = planningDir();
  const sprintPath = path.join(pd, 'sprint-status.yaml');

  if (!fs.existsSync(sprintPath)) {
    console.log('[cobolt-sprint-plan] No sprint-status.yaml found.');
    console.log('  Run: node tools/cobolt-sprint-plan.js generate');
    process.exit(1);
  }

  const content = fs.readFileSync(sprintPath, 'utf8');
  const lines = content.split('\n');

  let totalStories = 0;
  const statusCounts = {};
  for (const line of lines) {
    const statusMatch = line.match(/^\s+status:\s+(\S+)/);
    if (!statusMatch) continue;

    const status = normalizeStoryStatus(statusMatch[1]) || statusMatch[1];
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    totalStories++;
  }

  console.log('[cobolt-sprint-plan] Sprint Status:');
  console.log(`  Total stories: ${totalStories}`);
  for (const [status, count] of Object.entries(statusCounts)) {
    console.log(`    ${status}: ${count}`);
  }
  const progress = totalStories > 0 ? (((statusCounts.done || 0) / totalStories) * 100).toFixed(1) : '0.0';
  console.log(`  Progress: ${progress}%`);
}

function cmdUpdate(args) {
  const pd = planningDir();
  const sprintPath = path.join(pd, 'sprint-status.yaml');

  if (!fs.existsSync(sprintPath)) {
    console.error('[cobolt-sprint-plan] No sprint-status.yaml found. Generate first.');
    process.exit(1);
  }

  const storyId = (args[0] || '').toUpperCase();
  const newStatus = normalizeStoryStatus(args[1]);

  if (!storyId || !newStatus) {
    console.error('Usage: node tools/cobolt-sprint-plan.js update <story-id> <status>');
    console.error(`  Valid statuses: ${STATUS_FLOW.join(', ')}`);
    process.exit(2);
  }

  let content = fs.readFileSync(sprintPath, 'utf8');
  const idPattern = new RegExp(
    `(id:\\s+${storyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n(?:.*\\n)*?\\s+status:\\s+)\\S+`,
    'i',
  );

  if (!idPattern.test(content)) {
    console.error(`Story ${storyId} not found in sprint-status.yaml`);
    process.exit(1);
  }

  content = content.replace(idPattern, `$1${newStatus}`);
  fs.writeFileSync(sprintPath, content, 'utf8');
  console.log(`[cobolt-sprint-plan] Updated ${storyId} -> ${newStatus}`);
}

function printUsage() {
  console.log('CoBolt Sprint Plan - Deterministic sprint-status.yaml generator');
  console.log('');
  console.log('Usage:');
  console.log('  node tools/cobolt-sprint-plan.js generate [--epics <path>]');
  console.log('  node tools/cobolt-sprint-plan.js status');
  console.log('  node tools/cobolt-sprint-plan.js update <story-id> <status>');
  console.log('');
  console.log('Replaces cobolt-sprint-planning skill with deterministic generation.');
}

if (require.main === module) {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case 'generate':
      cmdGenerate(args);
      break;
    case 'status':
      cmdStatus();
      break;
    case 'update':
      cmdUpdate(args);
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
  STATUS_FLOW,
  normalizeStoryStatus,
  resolveStoryFile,
  detectStoryStatus,
  parseEpics,
  cmdGenerate,
  cmdStatus,
  cmdUpdate,
};
