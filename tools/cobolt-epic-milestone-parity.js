#!/usr/bin/env node

// CoBolt Epic ↔ Milestone Parity Gate
//
// Verifies bidirectional consistency between epics.md and milestones.md.
// Added in v0.18+ to close the "epics-before-milestones" drift class where
// epics.md (Mn) tags and milestones.md FR clusters could disagree silently,
// propagating wrong story→milestone mappings to story-tracker.json,
// sprint-status.yaml, and RTM.
//
// Usage:
//   node tools/cobolt-epic-milestone-parity.js check
//   node tools/cobolt-epic-milestone-parity.js check --json
//   node tools/cobolt-epic-milestone-parity.js check --planning-dir <path>
//
// Exit codes:
//   0 = parity OK
//   1 = usage error
//   2 = epic-tag-phantom  (epic has (Mn) tag pointing at missing milestone)
//   3 = epic-unlisted     (epics.md tags epic to M{n} but milestones.md M{n} section never names it)
//   4 = fr-cluster-drift  (FR assigned to different milestones by epics.md vs milestones.md)
//   5 = unassigned-story  (story-tracker.json has stories with milestone='unassigned'/null)
//   6 = missing-inputs    (epics.md or milestones.md absent)

const fs = require('node:fs');
const path = require('node:path');
const {
  getPlanningDir,
  getMilestoneFRCounts,
  getMilestoneIds,
  safeReadJson,
} = require('../lib/cobolt-planning-artifacts');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_EPIC_TAG_PHANTOM = 2;
const EXIT_EPIC_UNLISTED = 3;
const EXIT_FR_CLUSTER_DRIFT = 4;
const EXIT_UNASSIGNED_STORY = 5;
const EXIT_MISSING_INPUTS = 6;

function normalizeMilestoneId(raw) {
  if (!raw) return null;
  const match = String(raw).match(/M(\d+)/i);
  if (!match) return null;
  return `M${parseInt(match[1], 10)}`;
}

function normalizeEpicId(raw) {
  if (!raw) return null;
  const match = String(raw).match(/E(\d+)/i);
  if (!match) return null;
  return `E${parseInt(match[1], 10)}`;
}

function normalizeFrId(raw) {
  const n = parseInt(String(raw).match(/\d+/)?.[0] ?? '', 10);
  if (!Number.isFinite(n)) return null;
  return `FR-${String(n).padStart(3, '0')}`;
}

// Parse epics.md:
//   - epic.id, epic.milestone (from `(Mn)` / `[Mn]` / `milestone: Mn`)
//   - epic.frIds (from any FR-NNN referenced inside the epic section)
//   - epic.storyIds (from E{n}-S{m} patterns)
function parseEpics(content) {
  const epics = [];
  const lines = content.split('\n');
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    // Epic header: ## Epic E1: Name (M1) | ## E1 — Title | ## E1: Title
    const headerMatch = line.match(/^##\s+(?:Epic\s+)?(E[A-Z0-9_]+)\s*[:\u2014-]\s*(.+)/i);
    if (headerMatch) {
      if (current) epics.push(current);
      const milestoneRef = line.match(/[([]?(M\d+)[)\]]?/);
      current = {
        id: normalizeEpicId(headerMatch[1]),
        title: String(headerMatch[2] || '')
          .trim()
          .replace(/\s*[([]M\d+[)\]]\s*/, ''),
        milestone: milestoneRef ? normalizeMilestoneId(milestoneRef[1]) : null,
        frIds: new Set(),
        storyIds: new Set(),
        _raw: [],
      };
      continue;
    }
    // v0.40.5: close the current epic section when hitting ANY non-epic
    // H1/H2 heading. Without this, trailing summary sections (e.g. a
    // "## FR Coverage Check" appendix that enumerates "FR-001 (E1-S1),
    // FR-002 (E1-S2), ..." after the last epic) pollute the last epic's
    // frIds with every FR in the document and cascade into false
    // fr-cluster-drift findings in epic-milestone parity.
    if (current && /^#{1,2}\s+/.test(line)) {
      epics.push(current);
      current = null;
      continue;
    }
    if (!current) continue;

    // Capture milestone from content if not in header
    if (!current.milestone) {
      const msInline = line.match(/\bmilestone[:\s]+(M\d+)\b/i);
      if (msInline) current.milestone = normalizeMilestoneId(msInline[1]);
    }

    // Story pattern: E{n}-S{m}
    const storyPattern = new RegExp(`\\b${current.id}-S(\\d+)\\b`, 'gi');
    for (const m of line.matchAll(storyPattern)) {
      current.storyIds.add(`${current.id}-S${parseInt(m[1], 10)}`);
    }

    // FR references inside this epic section
    for (const m of line.matchAll(/\bFR[-\s]?(\d{1,4})\b/gi)) {
      current.frIds.add(normalizeFrId(m[1]));
    }

    current._raw.push(line);
  }
  if (current) epics.push(current);

  for (const e of epics) {
    e.frIds = [...e.frIds].filter(Boolean).sort();
    e.storyIds = [...e.storyIds].sort();
    delete e._raw;
  }
  return epics;
}

// Parse milestones.md → { M1: ['E1', 'E2'], M2: ['E3'] }
function parseMilestoneEpicRefs(content) {
  const result = {};
  // Split into milestone sections
  const sections = content.split(/^(?=#{2,3}\s+(?:Milestone\s+)?M\d+\s*[:\-\u2014])/gim);
  for (const section of sections) {
    const headingMatch = section.match(/^#{2,3}\s+(?:Milestone\s+)?M(\d+)\s*[:\-\u2014]/im);
    if (!headingMatch) continue;
    const milestoneId = `M${parseInt(headingMatch[1], 10)}`;
    const epicRefs = new Set();
    for (const m of section.matchAll(/\bE(\d+)\b/gi)) {
      epicRefs.add(`E${parseInt(m[1], 10)}`);
    }
    result[milestoneId] = [...epicRefs].sort();
  }
  return result;
}

function emit(payload, code, opts = {}) {
  const output = { ok: code === EXIT_OK, exitCode: code, ...payload };
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    const status = output.ok ? 'PASS' : 'FAIL';
    process.stdout.write(`[epic-milestone-parity] ${status} — exit ${code}\n`);
    if (output.summary) process.stdout.write(`  ${output.summary}\n`);
    if (output.findings) {
      for (const f of output.findings.slice(0, 10)) {
        process.stdout.write(`  • ${JSON.stringify(f)}\n`);
      }
      if (output.findings.length > 10) {
        process.stdout.write(`  … (${output.findings.length - 10} more; use --json for full output)\n`);
      }
    }
  }
  process.exit(code);
}

function parseArgs(argv) {
  const out = { json: false, planningDir: null, allowUnassignedFr: true, strictFrOrphans: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--planning-dir') out.planningDir = argv[++i];
    else if (a === '--strict-fr-orphans') out.strictFrOrphans = true;
  }
  return out;
}

function check(argv) {
  const opts = parseArgs(argv);
  const pd = opts.planningDir
    ? opts.planningDir
    : getPlanningDir(process.cwd(), { create: false, fallbackToLatest: true });

  if (!pd) {
    return emit(
      { reason: 'planning-dir-missing', summary: 'no planning directory discovered' },
      EXIT_MISSING_INPUTS,
      opts,
    );
  }

  let epicsPath = path.join(pd, 'epics.md');
  if (!fs.existsSync(epicsPath)) {
    const featureEpics = path.join(pd, 'feature-epics.md');
    if (fs.existsSync(featureEpics)) epicsPath = featureEpics;
  }
  const milestonesPath = path.join(pd, 'milestones.md');
  const storyTrackerPath = path.join(pd, 'story-tracker.json');

  if (!fs.existsSync(epicsPath)) {
    return emit(
      { reason: 'epics-missing', path: epicsPath, summary: 'epics.md (or feature-epics.md) not found' },
      EXIT_MISSING_INPUTS,
      opts,
    );
  }
  if (!fs.existsSync(milestonesPath)) {
    return emit(
      {
        reason: 'milestones-missing',
        path: milestonesPath,
        summary: 'milestones.md not found — decompose-milestones must run before epics',
      },
      EXIT_MISSING_INPUTS,
      opts,
    );
  }

  const epicsContent = fs.readFileSync(epicsPath, 'utf8');
  const milestonesContent = fs.readFileSync(milestonesPath, 'utf8');
  const epics = parseEpics(epicsContent);
  const milestoneIds = getMilestoneIds(pd);
  const milestoneFrMap = getMilestoneFRCounts(pd);
  const milestoneEpicRefs = parseMilestoneEpicRefs(milestonesContent);

  const findings = [];

  // Check 1 — epic-tag-phantom: every epic's (Mn) tag must exist in milestones.md
  // Also catches epic-missing-milestone-tag (same severity).
  for (const epic of epics) {
    if (!epic.milestone) {
      findings.push({
        class: 'epic-missing-milestone-tag',
        severity: 'critical',
        epic: epic.id,
        message: `Epic ${epic.id} has no (Mn) tag. Every epic must pin to a milestone ID from milestones.md.`,
      });
      continue;
    }
    if (!milestoneIds.includes(epic.milestone)) {
      findings.push({
        class: 'epic-tag-phantom',
        severity: 'critical',
        epic: epic.id,
        milestone: epic.milestone,
        validMilestones: milestoneIds,
        message: `Epic ${epic.id} references ${epic.milestone} which is not in milestones.md.`,
      });
    }
  }

  // Check 2 — epic-unlisted: every tagged epic should appear inside its claimed milestone's section in milestones.md
  for (const epic of epics) {
    if (!epic.milestone) continue;
    if (!milestoneIds.includes(epic.milestone)) continue;
    const refs = milestoneEpicRefs[epic.milestone] || [];
    if (!refs.includes(epic.id)) {
      findings.push({
        class: 'epic-unlisted',
        severity: 'high',
        epic: epic.id,
        expectedIn: epic.milestone,
        actualRefsInMilestone: refs,
        message: `Epic ${epic.id} claims milestone ${epic.milestone} but milestones.md's ${epic.milestone} section never references ${epic.id}.`,
      });
    }
  }

  // Check 3 — fr-cluster-drift: FRs assigned to a milestone by epics.md (via epic.milestone)
  // must match the FR cluster declared in milestones.md's milestone section.
  const epicDerivedFrToMilestone = {};
  for (const epic of epics) {
    if (!epic.milestone) continue;
    for (const fr of epic.frIds || []) {
      if (fr) epicDerivedFrToMilestone[fr] = epic.milestone;
    }
  }
  const milestoneFrToMilestone = {};
  for (const [m, frs] of Object.entries(milestoneFrMap)) {
    for (const fr of frs) milestoneFrToMilestone[fr] = m;
  }
  const allFrs = new Set([...Object.keys(epicDerivedFrToMilestone), ...Object.keys(milestoneFrToMilestone)]);
  for (const fr of allFrs) {
    const epicMs = epicDerivedFrToMilestone[fr];
    const milestoneMs = milestoneFrToMilestone[fr];
    if (epicMs && milestoneMs && epicMs !== milestoneMs) {
      findings.push({
        class: 'fr-cluster-drift',
        severity: 'critical',
        fr,
        epicsMilestone: epicMs,
        milestonesMilestone: milestoneMs,
        message: `${fr} is clustered under ${milestoneMs} in milestones.md but assigned to ${epicMs} via epic tagging.`,
      });
    } else if (opts.strictFrOrphans && !epicMs && milestoneMs) {
      findings.push({
        class: 'fr-orphan-in-epics',
        severity: 'high',
        fr,
        milestone: milestoneMs,
        message: `${fr} is declared in ${milestoneMs} but no epic covers it.`,
      });
    } else if (opts.strictFrOrphans && epicMs && !milestoneMs) {
      findings.push({
        class: 'fr-orphan-in-milestones',
        severity: 'high',
        fr,
        milestone: epicMs,
        message: `${fr} is covered by an epic tagged ${epicMs} but milestones.md does not list it under ${epicMs}.`,
      });
    }
  }

  // Check 4 — unassigned-story: story-tracker.json with milestone='unassigned' / null
  const storyTracker = safeReadJson(storyTrackerPath);
  if (storyTracker && Array.isArray(storyTracker.stories)) {
    for (const story of storyTracker.stories) {
      const ms = story?.milestone;
      if (!ms || ms === 'unassigned') {
        findings.push({
          class: 'unassigned-story',
          severity: 'critical',
          story: story?.id,
          epic: story?.epic,
          message: `Story ${story?.id} has milestone='${ms ?? 'null'}'. Every story must inherit a valid milestone from its epic.`,
        });
      }
    }
  }

  if (findings.length === 0) {
    return emit(
      {
        summary: `parity verified: ${epics.length} epics across ${milestoneIds.length} milestones`,
        epicsCount: epics.length,
        milestoneCount: milestoneIds.length,
      },
      EXIT_OK,
      opts,
    );
  }

  // Determine exit code by most severe class present (stable priority).
  const priority = [
    ['unassigned-story', EXIT_UNASSIGNED_STORY],
    ['fr-cluster-drift', EXIT_FR_CLUSTER_DRIFT],
    ['epic-unlisted', EXIT_EPIC_UNLISTED],
    ['epic-tag-phantom', EXIT_EPIC_TAG_PHANTOM],
    ['epic-missing-milestone-tag', EXIT_EPIC_TAG_PHANTOM],
    ['fr-orphan-in-epics', EXIT_FR_CLUSTER_DRIFT],
    ['fr-orphan-in-milestones', EXIT_FR_CLUSTER_DRIFT],
  ];
  const classSet = new Set(findings.map((f) => f.class));
  let exitCode = EXIT_EPIC_TAG_PHANTOM;
  for (const [cls, code] of priority) {
    if (classSet.has(cls)) {
      exitCode = code;
      break;
    }
  }

  const classCounts = {};
  for (const f of findings) classCounts[f.class] = (classCounts[f.class] || 0) + 1;

  return emit(
    {
      findings,
      classCounts,
      epicsCount: epics.length,
      milestoneCount: milestoneIds.length,
      summary: `${findings.length} parity issue(s) detected across ${Object.keys(classCounts).length} class(es)`,
    },
    exitCode,
    opts,
  );
}

function usage(exitCode = EXIT_USAGE) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(
    `${[
      'Usage:',
      '  cobolt-epic-milestone-parity check [--json] [--planning-dir <path>] [--strict-fr-orphans]',
      '',
      'Checks (exit code → severity priority):',
      '  2  epic-tag-phantom / epic-missing-milestone-tag',
      '  3  epic-unlisted',
      '  4  fr-cluster-drift (and --strict-fr-orphans)',
      '  5  unassigned-story',
      '  6  missing inputs',
    ].join('\n')}\n`,
  );
  process.exit(exitCode);
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  // v0.46 — explicit --help / -h / help → exit 0 per tools/CLAUDE.md contract
  if (command === 'help' || command === '-h' || command === '--help') return usage(0);
  if (!command) return usage(EXIT_USAGE);
  if (command === 'check') return check(args.slice(1));
  usage();
}

if (require.main === module) {
  main();
}

module.exports = { parseEpics, parseMilestoneEpicRefs, normalizeMilestoneId, normalizeEpicId, normalizeFrId };
