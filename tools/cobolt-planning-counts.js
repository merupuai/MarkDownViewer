#!/usr/bin/env node

// CoBolt Planning Counts — canonical summary of epic / story / milestone / feature counts
// Reads the disk-authoritative artifacts and emits reconciled counts so that the prose
// summary table in milestones.md can never silently drift from reality.
//
// Inputs (order of authority):
//   epics.md                        → epic count (E{n} headings)
//   story-tracker.json              → story count (stories[])
//   milestone-tracker.json          → per-milestone epic assignments
//   feature-registry.json           → feature count
//   rtm.json                        → requirement count
//   milestones.md                   → declared summary counts (for drift detection)
//
// Commands:
//   compute                         → print canonical counts (JSON or text)
//   check                           → compare milestones.md ## Summary vs disk; exit 4 on drift
//   reconcile [--write-note]        → append reconciliation note to milestones.md
//
// Exit codes:
//   0 = success
//   1 = usage error
//   2 = missing required artifact (treated as Tier 2 skip-and-report)
//   4 = drift detected between milestones.md declared counts and disk-derived counts

const fs = require('node:fs');
const path = require('node:path');
const { canonicalTrackerStories, getPlanningDir, safeReadJson } = require('../lib/cobolt-planning-artifacts');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_DRIFT = 4;

function planningDir() {
  return getPlanningDir(process.cwd(), { create: false, fallbackToLatest: true });
}

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

// ── Canonical counters ──────────────────────────────────────

function countEpicsInEpicsMd(pd) {
  const epicsPath = path.join(pd, 'epics.md');
  const text = readIfExists(epicsPath);
  if (text == null) return { count: null, path: epicsPath, present: false, epics: [] };

  // Match "## E0", "## E1:", "### E10 — title", etc.
  const matches = [...text.matchAll(/^#{1,4}\s+E(\d+)[\s:—–-]/gm)];
  const uniq = [...new Set(matches.map((m) => `E${parseInt(m[1], 10)}`))];
  return { count: uniq.length, path: epicsPath, present: true, epics: uniq };
}

function countStoriesInTracker(pd) {
  const trackerPath = path.join(pd, 'story-tracker.json');
  const data = safeReadJson(trackerPath);
  if (!data) return { count: null, path: trackerPath, present: false };
  const stories = canonicalTrackerStories(data.stories);
  return {
    count: stories.length,
    path: trackerPath,
    present: true,
    nullStoryFiles: stories.filter((s) => s.storyFile == null).length,
  };
}

function countMilestonesInTracker(pd) {
  const trackerPath = path.join(pd, 'milestone-tracker.json');
  const data = safeReadJson(trackerPath);
  if (!data) return { count: null, path: trackerPath, present: false };
  const milestones = data.milestones || {};
  return {
    count: Object.keys(milestones).length,
    path: trackerPath,
    present: true,
    milestoneIds: Object.keys(milestones),
  };
}

function countFeatures(pd) {
  const regPath = path.join(pd, 'feature-registry.json');
  const data = safeReadJson(regPath);
  if (!data) return { count: null, path: regPath, present: false };
  const features = Array.isArray(data.features) ? data.features : [];
  const declared = typeof data.totalFeatures === 'number' ? data.totalFeatures : null;
  return {
    count: features.length,
    declared,
    drift: declared != null && declared !== features.length,
    path: regPath,
    present: true,
  };
}

function countRequirements(pd) {
  const rtmPath = path.join(pd, 'rtm.json');
  const data = safeReadJson(rtmPath);
  if (!data) return { count: null, path: rtmPath, present: false };
  const reqs = data.requirements || {};
  const ids = Object.keys(reqs);
  const byType = { FR: 0, NFR: 0, TR: 0, IR: 0, TRD: 0, other: 0 };
  for (const id of ids) {
    if (id.startsWith('FR-')) byType.FR++;
    else if (id.startsWith('NFR-')) byType.NFR++;
    else if (id.startsWith('TR-')) byType.TR++;
    else if (id.startsWith('IR-')) byType.IR++;
    else if (id.startsWith('TRD-')) byType.TRD++;
    else byType.other++;
  }
  return { count: ids.length, byType, path: rtmPath, present: true };
}

// ── Summary parsing (milestones.md) ─────────────────────────

function parseDeclaredSummary(pd) {
  const ms = path.join(pd, 'milestones.md');
  const text = readIfExists(ms);
  if (text == null) return { present: false, path: ms };

  // Look for a row like "| **Total** | 40 | 99 |" or a sentence like
  // "40 epics → 99 stories". Return best-effort numeric pair.
  const totalRow = text.match(/\|\s*\*?\*?Total\*?\*?\s*\|([^|]+)\|([^|]+)\|/i);
  if (totalRow) {
    const nums = [totalRow[1], totalRow[2]]
      .map((s) => parseInt(String(s).match(/\d+/)?.[0] ?? '', 10))
      .filter((n) => Number.isFinite(n));
    if (nums.length >= 2) return { present: true, path: ms, epics: nums[0], stories: nums[1] };
  }

  const prose = text.match(/(\d+)\s+epics?\s*(?:->|→|and|,)\s*(\d+)\s+stor(?:y|ies)/i);
  if (prose) {
    return {
      present: true,
      path: ms,
      epics: parseInt(prose[1], 10),
      stories: parseInt(prose[2], 10),
    };
  }

  return { present: true, path: ms, epics: null, stories: null };
}

// ── Top-level compute ──────────────────────────────────────

function compute(pd) {
  return {
    generatedAt: new Date().toISOString(),
    planningDir: pd,
    epics: countEpicsInEpicsMd(pd),
    stories: countStoriesInTracker(pd),
    milestones: countMilestonesInTracker(pd),
    features: countFeatures(pd),
    requirements: countRequirements(pd),
    declaredSummary: parseDeclaredSummary(pd),
  };
}

function check(pd) {
  const snap = compute(pd);
  const findings = [];

  const missing = [];
  if (!snap.epics.present) missing.push('epics.md');
  if (!snap.stories.present) missing.push('story-tracker.json');
  if (!snap.milestones.present) missing.push('milestone-tracker.json');
  if (missing.length > 0) {
    return {
      verdict: 'SKIP',
      reason: `missing: ${missing.join(', ')}`,
      snapshot: snap,
      findings,
      exitCode: EXIT_MISSING,
    };
  }

  if (snap.features.drift) {
    findings.push({
      class: 'feature-registry-count-drift',
      severity: 'high',
      message: `feature-registry.json declares totalFeatures=${snap.features.declared} but contains ${snap.features.count} features`,
    });
  }

  if (snap.stories.nullStoryFiles > 0) {
    findings.push({
      class: 'story-tracker-null-storyfiles',
      severity: 'medium',
      count: snap.stories.nullStoryFiles,
      message: `${snap.stories.nullStoryFiles} story-tracker entries have storyFile: null`,
    });
  }

  if (snap.declaredSummary.present && snap.declaredSummary.epics != null) {
    if (snap.declaredSummary.epics !== snap.epics.count) {
      findings.push({
        class: 'milestones-summary-epic-drift',
        severity: 'high',
        declared: snap.declaredSummary.epics,
        actual: snap.epics.count,
        message: `milestones.md Summary declares ${snap.declaredSummary.epics} epics but epics.md contains ${snap.epics.count}`,
      });
    }
    if (snap.declaredSummary.stories != null && snap.declaredSummary.stories !== snap.stories.count) {
      findings.push({
        class: 'milestones-summary-story-drift',
        severity: 'high',
        declared: snap.declaredSummary.stories,
        actual: snap.stories.count,
        message: `milestones.md Summary declares ${snap.declaredSummary.stories} stories but story-tracker.json contains ${snap.stories.count}`,
      });
    }
  }

  const verdict = findings.some((f) => f.severity === 'high') ? 'DRIFT' : 'OK';
  return { verdict, findings, snapshot: snap, exitCode: verdict === 'DRIFT' ? EXIT_DRIFT : EXIT_OK };
}

function printHuman(result) {
  const snap = result.snapshot;
  console.log('== CoBolt Planning Counts ==');
  console.log(`planningDir : ${snap.planningDir}`);
  console.log(`epics       : ${snap.epics.count ?? 'MISSING'} (epics.md)`);
  console.log(`stories     : ${snap.stories.count ?? 'MISSING'} (story-tracker.json)`);
  console.log(`milestones  : ${snap.milestones.count ?? 'MISSING'} (milestone-tracker.json)`);
  console.log(`features    : ${snap.features.count ?? 'MISSING'} (feature-registry.json)`);
  console.log(`requirements: ${snap.requirements.count ?? 'MISSING'} (rtm.json)`);
  if (snap.declaredSummary.present) {
    console.log(
      `declared    : epics=${snap.declaredSummary.epics ?? '?'} stories=${snap.declaredSummary.stories ?? '?'} (milestones.md)`,
    );
  }
  if (result.findings?.length) {
    console.log('');
    console.log('-- findings --');
    for (const f of result.findings) {
      console.log(`  [${f.severity}] ${f.class}: ${f.message}`);
    }
  }
  console.log('');
  console.log(`verdict: ${result.verdict}`);
}

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'compute';
  const json = hasFlag(args, '--json');

  const pd = planningDir();
  if (!pd || !fs.existsSync(pd)) {
    const out = { verdict: 'SKIP', reason: 'no planning directory', planningDir: pd };
    if (json) console.log(JSON.stringify(out, null, 2));
    else console.log('No planning directory found. Run cobolt-plan first.');
    process.exit(EXIT_MISSING);
  }

  if (cmd === 'compute') {
    const snap = compute(pd);
    if (json) console.log(JSON.stringify(snap, null, 2));
    else printHuman({ verdict: 'OK', findings: [], snapshot: snap });
    process.exit(EXIT_OK);
  } else if (cmd === 'check') {
    const result = check(pd);
    if (json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    process.exit(result.exitCode);
  } else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Usage: cobolt-planning-counts.js <compute|check> [--json]');
    process.exit(EXIT_OK);
  } else {
    console.error(`Unknown command: ${cmd}`);
    console.error('Usage: cobolt-planning-counts.js <compute|check> [--json]');
    process.exit(EXIT_USAGE);
  }
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { compute, check };
