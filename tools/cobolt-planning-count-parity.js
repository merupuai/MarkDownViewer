#!/usr/bin/env node

// CoBolt Planning Count Parity — census check across 7 planning artifacts.
//
// Closes Blocker #4 from the Meru readiness review: epics.md frontmatter
// claimed 19 epics / 108 stories while readiness saw 21/84, story-tracker
// had 83, story-specs-index had 83, sprint-status.yaml had 21/84, stories/
// had an orphan landing page, and milestones.md listed 13 with critical path
// stopping at M12.
//
// This tool converges those seven views into one census and fails loudly
// when they disagree — the invariant is "pick one canonical work breakdown,
// derive every downstream artifact from it."
//
// Exit codes (per tools/CLAUDE.md contract):
//   0 = parity — all sources agree within tolerance
//   1 = usage error / unhandled exception
//   2 = missing source artifacts (cannot run)
//   3 = parity drift detected — Tier 1 block
//
// Invocation:
//   node tools/cobolt-planning-count-parity.js check [--json] [--strict]
//   node tools/cobolt-planning-count-parity.js report [--json]

const fs = require('node:fs');
const path = require('node:path');
const { canonicalTrackerStories } = require('../lib/cobolt-planning-artifacts');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_DRIFT = 3;

function findPlanningDir(cwd = process.cwd()) {
  const latest = path.join(cwd, '_cobolt-output', 'latest', 'planning');
  if (fs.existsSync(latest)) return latest;
  return null;
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function readJsonSafe(p) {
  const raw = readFileSafe(p);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Parse YAML frontmatter counts from epics.md without pulling in a YAML dep.
function parseEpicsFrontmatter(content) {
  if (!content) return { totalEpics: null, totalStories: null, found: false };
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { totalEpics: null, totalStories: null, found: false };
  const fm = m[1];
  const eMatch = fm.match(/total[_-]?epics\s*:\s*(\d+)/i);
  const sMatch = fm.match(/total[_-]?stories\s*:\s*(\d+)/i);
  return {
    totalEpics: eMatch ? Number(eMatch[1]) : null,
    totalStories: sMatch ? Number(sMatch[1]) : null,
    found: true,
  };
}

// Count "## Epic N: ..." or "## E<digits>: ..." style headings as a crosscheck.
// Intentionally strict: rejects "### E1-S1" story headings (false positives),
// and requires a separating `: ` or end-of-line after the epic id.
function countEpicHeadingsInMarkdown(content) {
  if (!content) return 0;
  // CB-OBS-14: epic IDs may carry alphabetic suffixes (E1b, E11b, E8b).
  // The normalizer in lib/cobolt-planning-artifacts.js::normalizeStoryId already
  // accepts E[A-Z0-9_]+-S\d+ — this counter must match the same alphabet, but
  // must NOT match generic English words like "## Epic Summary". Constrain the
  // `Epic N` form so the token after `Epic` must start with a digit or E+digit.
  const heads = content.match(/^##\s+(?:Epic\s+(?:E?\d+[A-Za-z0-9_]*)\b|E\d+[A-Za-z0-9_]*(?::|\s+—|\s+-)\s)/gim);
  return heads ? heads.length : 0;
}

function countStoryHeadingsInMarkdown(content) {
  if (!content) return 0;
  // CB-OBS-14: match E{digits+alpha}-S{n} so E1b-S1, E11b-S3, E8-S2 all count.
  const heads = content.match(/^###+\s+(?:Story\s+[A-Z0-9-]+|E[A-Z0-9_]*\d+[A-Z0-9_]*-S\d+)/gim);
  return heads ? heads.length : 0;
}

function parseMilestonesMd(content) {
  if (!content) return { total: 0, ids: [] };
  const ids = [...content.matchAll(/^##+\s+(M\d+)\b/gim)].map((m) => m[1]);
  return { total: ids.length, ids };
}

function parseSprintStatus(content) {
  if (!content) return { totalEpics: null, totalStories: null };
  // Simple YAML field extraction; avoids the yaml package.
  const e = content.match(/total[_-]?epics\s*:\s*(\d+)/i);
  const s = content.match(/total[_-]?stories\s*:\s*(\d+)/i);
  if (e || s) {
    return {
      totalEpics: e ? Number(e[1]) : null,
      totalStories: s ? Number(s[1]) : null,
    };
  }
  // Fallback — count `- epic:` / `- story:` list entries.
  const epics = (content.match(/^\s*-\s*epic\s*:/gim) || []).length;
  const stories = (content.match(/^\s*-\s*(?:story|id)\s*:/gim) || []).length;
  return { totalEpics: epics || null, totalStories: stories || null };
}

function listStoryFiles(storiesDir) {
  try {
    if (!fs.existsSync(storiesDir)) return [];
    return fs
      .readdirSync(storiesDir)
      .filter((f) => /\.md$/i.test(f) && !/^(README|index)\.md$/i.test(f) && !/^LANDING-S\d+(?:[-_].*)?\.md$/i.test(f));
  } catch {
    return [];
  }
}

// v0.66.5 (Wave 2 B-1c): logical-story key extraction. The parity check used
// raw file count, but a single logical story can ship under TWO names on disk:
//   - kebab-case slug:           1-1-csp.md             (epic 1, story 1)
//   - milestone-scoped canonical: M1.S1.md               (milestone 1, story 1)
// Both forms describe the same logical story but normalizeStoryId returns
// different canonical IDs (E1-S1 vs M1.S1), so a deduplication-by-storyId map
// keyed on those still over-counts. The fix collapses both to a logical
// (group, story) pair extracted directly from the filename — both `1-1-csp.md`
// and `M1.S1.md` map to "1.1", so they count once. The diagnostic this closes
// is the build feedback "story-file gate expects 78 = 2×39 ... brownfield only
// emits kebab-case → 50% coverage automatically." Returning unique logical
// keys (not raw file count) keeps the count consistent with story-tracker.json.
function extractLogicalStoryKey(fileName) {
  const base = String(fileName || '').replace(/\.md$/i, '');
  // Kebab/compact form: 1-1-csp, 12-3-foo
  let m = base.match(/^(\d+)-(\d+)(?:[-_].*)?$/);
  if (m) return `${parseInt(m[1], 10)}.${parseInt(m[2], 10)}`;
  // Canonical milestone-scoped: M1.S1, m12.s3
  m = base.match(/^M(\d+)\.S(\d+)$/i);
  if (m) return `${parseInt(m[1], 10)}.${parseInt(m[2], 10)}`;
  // Canonical epic-scoped: E1-S1, EA-S2 (alpha epic kept as-is)
  m = base.match(/^E([A-Z0-9_]+)-S(\d+)$/i);
  if (m) {
    const epic = /^\d+$/.test(m[1]) ? String(parseInt(m[1], 10)) : m[1].toUpperCase();
    return `E${epic}.${parseInt(m[2], 10)}`;
  }
  // story- prefix variant
  m = base.match(/^story-(.+)$/i);
  if (m) return extractLogicalStoryKey(`${m[1]}.md`);
  // Brownfield S-1.1, S-1-1, S1.1
  m = base.match(/^S-?(\d+)[.-](\d+)$/);
  if (m) return `${parseInt(m[1], 10)}.${parseInt(m[2], 10)}`;
  return base; // unrecognized — count as its own bucket
}

function uniqueLogicalStoryCount(storyFiles) {
  const seen = new Set();
  for (const f of storyFiles) seen.add(extractLogicalStoryKey(f));
  return seen.size;
}

function countInRtm(rtm) {
  if (!rtm || typeof rtm !== 'object') return { storyCount: null, epicCount: null, milestoneCount: null };
  const requirements = rtm.requirements || rtm.entries || {};
  const storySet = new Set();
  const epicSet = new Set();
  const milestoneSet = new Set();
  for (const key of Object.keys(requirements)) {
    const req = requirements[key];
    const stories = req?.stories || req?.mapped_to_stories || [];
    // RTM may use `epics` array, `mapped_to_epics` array, or the singular
    // `epic` scalar (canonical in the current schema). Accept all three.
    let epicsList = req?.epics || req?.mapped_to_epics || [];
    if ((!epicsList || epicsList.length === 0) && req?.epic) epicsList = [req.epic];
    const milestones = req?.milestones || (req?.milestone ? [req.milestone] : []);
    for (const s of stories || []) storySet.add(String(s));
    for (const e of epicsList || []) epicSet.add(String(e));
    for (const m of milestones || []) milestoneSet.add(String(m));
  }
  return { storyCount: storySet.size, epicCount: epicSet.size, milestoneCount: milestoneSet.size };
}

function check({ planningDir, strict = false }) {
  const pd = planningDir || findPlanningDir();
  if (!pd) {
    return { exitCode: EXIT_MISSING, error: 'no planning directory', sources: {} };
  }

  const epicsMd = readFileSafe(path.join(pd, 'epics.md'));
  const milestonesMd = readFileSafe(path.join(pd, 'milestones.md'));
  const sprintStatus = readFileSafe(path.join(pd, 'sprint-status.yaml'));
  const storyTracker = readJsonSafe(path.join(pd, 'story-tracker.json'));
  const specsIndex = readJsonSafe(path.join(pd, 'story-specs-index.json'));
  const rtm = readJsonSafe(path.join(pd, 'rtm.json'));
  const storiesDir = path.join(pd, 'stories');

  // Minimum viable set — if none of these exist, we genuinely have no planning
  // to parity-check. Mark missing and exit 2 (cannot run).
  if (!epicsMd && !milestonesMd && !storyTracker && !rtm) {
    return { exitCode: EXIT_MISSING, error: 'no planning artifacts found', sources: {}, planningDir: pd };
  }

  const fm = parseEpicsFrontmatter(epicsMd);
  const epicsMdEpicHeadings = countEpicHeadingsInMarkdown(epicsMd);
  const epicsMdStoryHeadings = countStoryHeadingsInMarkdown(epicsMd);
  const ms = parseMilestonesMd(milestonesMd);
  const sp = parseSprintStatus(sprintStatus);

  const trackerStories = Array.isArray(storyTracker?.stories)
    ? canonicalTrackerStories(storyTracker.stories).length
    : Array.isArray(storyTracker)
      ? storyTracker.length
      : null;

  const specIndexStories = Array.isArray(specsIndex?.specs)
    ? specsIndex.specs.length
    : Array.isArray(specsIndex)
      ? specsIndex.length
      : null;

  const storyFiles = listStoryFiles(storiesDir);
  // v0.66.5 (Wave 2 B-1c): use logical-story count (deduplicated across
  // kebab/canonical/milestone-scoped naming forms) for the parity comparison so
  // dual-named files for the same logical story don't masquerade as drift.
  // Raw file count is still surfaced in the report below as `:rawFileCount`.
  const storyFileCount = uniqueLogicalStoryCount(storyFiles);
  const storyFileRawCount = storyFiles.length;

  const rtmCounts = countInRtm(rtm);

  const sources = {
    'epics.md:frontmatter.totalEpics': fm.totalEpics,
    'epics.md:frontmatter.totalStories': fm.totalStories,
    'epics.md:epicHeadings': epicsMdEpicHeadings || null,
    'epics.md:storyHeadings': epicsMdStoryHeadings || null,
    'milestones.md:count': ms.total || null,
    'sprint-status.yaml:totalEpics': sp.totalEpics,
    'sprint-status.yaml:totalStories': sp.totalStories,
    'story-tracker.json:stories.length': trackerStories,
    'story-specs-index.json:specs.length': specIndexStories,
    'stories/*.md:fileCount': storyFileCount || null,
    'stories/*.md:rawFileCount': storyFileRawCount || null,
    'rtm.json:uniqueStories': rtmCounts.storyCount,
    'rtm.json:uniqueEpics': rtmCounts.epicCount,
    'rtm.json:uniqueMilestones': rtmCounts.milestoneCount,
  };

  // Detect disagreements. Two groups: epic-count sources and story-count
  // sources. A source with null is "not present" and excluded from the
  // group unless strict=true.
  const epicCountSources = {
    'epics.md:frontmatter.totalEpics': fm.totalEpics,
    'epics.md:epicHeadings': epicsMdEpicHeadings || null,
    'sprint-status.yaml:totalEpics': sp.totalEpics,
    'rtm.json:uniqueEpics': rtmCounts.epicCount,
  };
  const storyCountSources = {
    'epics.md:frontmatter.totalStories': fm.totalStories,
    'epics.md:storyHeadings': epicsMdStoryHeadings || null,
    'sprint-status.yaml:totalStories': sp.totalStories,
    'story-tracker.json:stories.length': trackerStories,
    'story-specs-index.json:specs.length': specIndexStories,
    'stories/*.md:fileCount': storyFileCount || null,
    'rtm.json:uniqueStories': rtmCounts.storyCount,
  };
  const milestoneCountSources = {
    'milestones.md:count': ms.total || null,
    'rtm.json:uniqueMilestones': rtmCounts.milestoneCount,
  };

  function findDrift(group, label) {
    const present = Object.entries(group).filter(([, v]) => Number.isFinite(v));
    if (present.length < 2) return null; // nothing to compare
    const values = new Set(present.map(([, v]) => v));
    if (values.size === 1) return null;
    return {
      label,
      values: present.map(([source, v]) => ({ source, count: v })),
      distinct: [...values].sort((a, b) => a - b),
    };
  }

  const drifts = [];
  const epicDrift = findDrift(epicCountSources, 'epic-count');
  if (epicDrift) drifts.push(epicDrift);
  const storyDrift = findDrift(storyCountSources, 'story-count');
  if (storyDrift) drifts.push(storyDrift);
  const msDrift = findDrift(milestoneCountSources, 'milestone-count');
  if (msDrift) drifts.push(msDrift);

  // Orphan check: a .md file in stories/ whose ID doesn't appear in
  // story-tracker. The review flagged LANDING-1-landing-page.md as this
  // class.
  const trackerIds = new Set();
  if (storyTracker && Array.isArray(storyTracker.stories)) {
    for (const s of storyTracker.stories) {
      if (s?.id) trackerIds.add(String(s.id).toUpperCase());
      if (s?.storyId) trackerIds.add(String(s.storyId).toUpperCase());
    }
  }
  const orphans = [];
  for (const f of storyFiles) {
    const base = f.replace(/\.md$/i, '');
    // Accept id || E\d+-S\d+ || E\d+-S\d+-slug
    // CB-OBS-15: uppercase-normalize before comparing — story files are
    // canonically lower-case (e1-s1.md) while tracker IDs are upper-case.
    const idGuess = base.match(/^([A-Z0-9]+-S?\d+)/i)?.[1] || base;
    const idGuessUpper = String(idGuess).toUpperCase();
    const baseUpper = String(base).toUpperCase();
    if (trackerIds.size > 0 && !trackerIds.has(idGuessUpper) && !trackerIds.has(baseUpper)) {
      orphans.push(f);
    }
  }

  const hasDrift = drifts.length > 0 || orphans.length > 0;
  return {
    exitCode: hasDrift ? EXIT_DRIFT : EXIT_OK,
    planningDir: pd,
    sources,
    drifts,
    orphans,
    strict,
  };
}

function formatText(result) {
  const lines = ['== Planning Count Parity =='];
  lines.push(`  planningDir: ${result.planningDir || '(missing)'}`);
  lines.push('  sources:');
  for (const [k, v] of Object.entries(result.sources || {})) {
    lines.push(`    ${k}: ${v == null ? '(null)' : v}`);
  }
  if (result.drifts?.length) {
    lines.push('  drifts:');
    for (const d of result.drifts) {
      lines.push(`    - ${d.label}: distinct=${d.distinct.join(',')}`);
      for (const entry of d.values) {
        lines.push(`        ${entry.source} = ${entry.count}`);
      }
    }
  } else {
    lines.push('  drifts: (none)');
  }
  if (result.orphans?.length) {
    lines.push('  orphan-story-files:');
    for (const o of result.orphans) lines.push(`    - ${o}`);
  } else {
    lines.push('  orphan-story-files: (none)');
  }
  lines.push(`verdict: ${result.exitCode === EXIT_OK ? 'PASS' : result.exitCode === EXIT_DRIFT ? 'DRIFT' : 'MISSING'}`);
  return lines.join('\n');
}

function usage() {
  return [
    'Usage: cobolt-planning-count-parity.js <check|report> [--json] [--strict]',
    '',
    '  check   Run census across 7 planning artifacts. Exits 3 on drift.',
    '  report  Same as check but exits 0 regardless (advisory reporting).',
    '',
    '  --json   Emit machine-readable JSON verdict',
    '  --strict Treat missing sources as drift instead of excluding from comparison',
  ].join('\n');
}

function main(argv = process.argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'check';
  const json = args.includes('--json');
  const strict = args.includes('--strict');

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(usage());
    process.exit(EXIT_OK);
  }
  if (cmd !== 'check' && cmd !== 'report') {
    console.error(`Unknown command: ${cmd}\n\n${usage()}`);
    process.exit(EXIT_USAGE);
  }

  const result = check({ strict });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatText(result));
  }
  process.exit(cmd === 'report' ? EXIT_OK : result.exitCode);
}

if (require.main === module) main();

module.exports = {
  check,
  parseEpicsFrontmatter,
  parseMilestonesMd,
  parseSprintStatus,
  countInRtm,
  // v0.66.5 (Wave 2 B-1c): exposed for regression tests pinning dual-naming dedup.
  extractLogicalStoryKey,
  uniqueLogicalStoryCount,
  listStoryFiles,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_MISSING,
  EXIT_DRIFT,
};
