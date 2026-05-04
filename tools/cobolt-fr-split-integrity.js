#!/usr/bin/env node

// CoBolt FR Split Integrity — detects FRs mapped to multiple unrelated epics
// without a declared split, dangling story references, and FR/landing-page
// false attribution.
//
// Closes Blocker #5 from the Meru readiness review: FR-310 (runtime config
// + debug + control distribution) was assigned to E20 "Audit + SDK + CLI +
// Landing", mapped in RTM to both M4/E5 and M13/E20, linked from
// story-tracker to E20-S3 (CLI basic), and referenced by rtm.json as
// E5-S5 — a story that doesn't exist in the tracker.
//
// Invariants enforced:
//   1. An FR may be mapped to multiple epics only when epics.md or RTM
//      declares an explicit split_rationale / split_into field.
//   2. Every story referenced by RTM must exist in story-tracker.json.
//   3. Every landing/marketing artifact must be backed by a dedicated
//      landing-page requirement, not a runtime FR.
//
// Exit codes:
//   0 = parity
//   1 = usage
//   2 = missing source artifacts
//   3 = integrity violations — Tier 1 block
//
// Invocation:
//   node tools/cobolt-fr-split-integrity.js check [--json]

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_VIOLATION = 3;

const LANDING_KEYWORDS = /landing|marketing|homepage|website-page|splash|hero/i;
const RUNTIME_KEYWORDS = /runtime|config|debug|control-plane|admin|observability|logging|kill[- ]?switch/i;

function planningDir(cwd = process.cwd()) {
  const p = path.join(cwd, '_cobolt-output', 'latest', 'planning');
  return fs.existsSync(p) ? p : null;
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

// Parse the epics.md body into { epicId -> { title, frs: Set, splitRationales: Map<fr, text> } }
function parseEpics(content) {
  const epics = {};
  if (!content) return epics;
  const blocks = content.split(/(?=^##+\s+(?:Epic\s+\d+|E\d+[:\- ]))/gim);
  for (const block of blocks) {
    const headMatch = block.match(/^##+\s+(?:Epic\s+(\d+)|E(\d+))[-:\s]?\s*(.*?)\n/im);
    if (!headMatch) continue;
    const epicId = `E${headMatch[1] || headMatch[2]}`;
    const title = (headMatch[3] || '').trim();
    const frMatches = [...block.matchAll(/\bFR-\d+\b/g)].map((m) => m[0]);
    const frs = new Set(frMatches);
    // Look for split declarations: `split_rationale: ...`, `split:`, or an
    // explicit "## Split Rationale" section referring to an FR ID.
    const splitRationales = new Map();
    const splitSectionRe = /split[_-]?(?:rationale|into|across)[:\s].*?(FR-\d+)/gi;
    for (const m of block.matchAll(splitSectionRe)) {
      splitRationales.set(m[1], m[0]);
    }
    epics[epicId] = { title, frs, splitRationales, raw: block.slice(0, 400) };
  }
  return epics;
}

function parseLandingStories(storiesDir) {
  if (!fs.existsSync(storiesDir)) return [];
  return fs.readdirSync(storiesDir).filter((f) => /landing|marketing|homepage/i.test(f) && /\.md$/i.test(f));
}

function extractFrRefsFromStory(content) {
  if (!content) return [];
  return [...content.matchAll(/\bFR-\d+\b/g)].map((m) => m[0]);
}

function check({ dir }) {
  const pd = dir || planningDir();
  if (!pd) return { exitCode: EXIT_MISSING, error: 'no planning directory' };

  const epicsContent = readFileSafe(path.join(pd, 'epics.md'));
  const rtm = readJsonSafe(path.join(pd, 'rtm.json'));
  const storyTracker = readJsonSafe(path.join(pd, 'story-tracker.json'));
  const storiesDir = path.join(pd, 'stories');

  if (!epicsContent && !rtm && !storyTracker) {
    return { exitCode: EXIT_MISSING, error: 'no planning artifacts', planningDir: pd };
  }

  const violations = [];
  const epics = parseEpics(epicsContent);

  // ── Invariant 1: FR mapped to multiple epics without split_rationale ──
  const frEpicMap = {};
  for (const [epicId, data] of Object.entries(epics)) {
    for (const fr of data.frs) {
      if (!frEpicMap[fr]) frEpicMap[fr] = [];
      frEpicMap[fr].push(epicId);
    }
  }
  for (const [fr, epicIds] of Object.entries(frEpicMap)) {
    if (epicIds.length > 1) {
      // Check whether any declaring epic has a split_rationale for this FR.
      const hasSplit = epicIds.some((eid) => epics[eid]?.splitRationales?.has(fr));
      if (!hasSplit) {
        violations.push({
          type: 'fr-multi-epic-without-split',
          fr,
          epics: epicIds,
          hint:
            'Either consolidate this FR into one epic, or declare a ' +
            '`split_rationale: <FR-ID>: <why>` section in the owning epic.',
        });
      }
    }
  }

  // ── Invariant 2: RTM stories must exist in story-tracker ──
  const trackerIds = new Set();
  if (storyTracker) {
    const stories = Array.isArray(storyTracker.stories)
      ? storyTracker.stories
      : Array.isArray(storyTracker)
        ? storyTracker
        : [];
    for (const s of stories) {
      if (s?.id) trackerIds.add(String(s.id));
      if (s?.storyId) trackerIds.add(String(s.storyId));
      // Common ID formats: E20-S3, LANDING-1, etc.
    }
  }
  if (rtm && typeof rtm === 'object') {
    const requirements = rtm.requirements || rtm.entries || {};
    for (const [reqId, req] of Object.entries(requirements)) {
      const refs = [...(req?.stories || []), ...(req?.mapped_to_stories || [])].filter(Boolean);
      for (const storyRef of refs) {
        const sid = String(storyRef);
        if (trackerIds.size > 0 && !trackerIds.has(sid)) {
          violations.push({
            type: 'dangling-rtm-story-ref',
            requirement: reqId,
            storyRef: sid,
            hint: `RTM references story ${sid} that does not exist in story-tracker.json.`,
          });
        }
      }
    }
  }

  // ── Invariant 3: Landing/marketing stories on runtime FRs ──
  const landingStories = parseLandingStories(storiesDir);
  for (const f of landingStories) {
    const content = readFileSafe(path.join(storiesDir, f));
    const frRefs = extractFrRefsFromStory(content);
    const suspect = frRefs.filter((fr) => {
      const ownerEpic = Object.entries(epics).find(([, d]) => d.frs.has(fr));
      if (!ownerEpic) return false;
      const epicTitle = ownerEpic[1].title || '';
      // The FR's owning epic is about runtime/config/admin — the landing story
      // shouldn't be attributed to it unless it's a dedicated landing FR.
      const isRuntimeEpic = RUNTIME_KEYWORDS.test(epicTitle);
      const isLandingEpic = LANDING_KEYWORDS.test(epicTitle);
      return isRuntimeEpic && !isLandingEpic;
    });
    if (suspect.length > 0) {
      violations.push({
        type: 'landing-on-runtime-fr',
        storyFile: f,
        suspectFrs: suspect,
        hint:
          'Landing / marketing pages must reference a dedicated landing-page FR, ' +
          'not a runtime/config/admin FR (e.g., FR-310 distribution/debug).',
      });
    }
  }

  // ── Invariant 4 (informational): FRs assigned to a milestone AND a different
  // milestone via RTM milestone_phasing. Flag as advisory only.
  const phasingConflicts = [];
  if (rtm && typeof rtm === 'object') {
    const requirements = rtm.requirements || rtm.entries || {};
    for (const [reqId, req] of Object.entries(requirements)) {
      const m = req?.milestone;
      const milestones = req?.milestones || [];
      if (m && Array.isArray(milestones) && milestones.length > 0 && !milestones.includes(m)) {
        phasingConflicts.push({ requirement: reqId, scalar: m, milestones });
      }
    }
  }

  return {
    exitCode: violations.length > 0 ? EXIT_VIOLATION : EXIT_OK,
    planningDir: pd,
    summary: {
      totalEpics: Object.keys(epics).length,
      totalFrs: Object.keys(frEpicMap).length,
      frsAcrossMultipleEpics: Object.values(frEpicMap).filter((a) => a.length > 1).length,
      rtmDanglingRefs: violations.filter((v) => v.type === 'dangling-rtm-story-ref').length,
      landingOnRuntimeFr: violations.filter((v) => v.type === 'landing-on-runtime-fr').length,
      phasingConflicts: phasingConflicts.length,
    },
    violations,
    phasingConflicts,
  };
}

function formatText(r) {
  const lines = ['== FR Split Integrity =='];
  lines.push(`  planningDir: ${r.planningDir || '(missing)'}`);
  if (r.summary) {
    for (const [k, v] of Object.entries(r.summary)) lines.push(`  ${k}: ${v}`);
  }
  if (r.violations?.length) {
    lines.push('  violations:');
    for (const v of r.violations.slice(0, 30)) {
      lines.push(
        `    - [${v.type}] ${JSON.stringify({ fr: v.fr, epics: v.epics, sid: v.storyRef, req: v.requirement, story: v.storyFile, susp: v.suspectFrs })}`,
      );
    }
  }
  lines.push(`verdict: ${r.exitCode === EXIT_OK ? 'PASS' : 'VIOLATION'}`);
  return lines.join('\n');
}

function main(argv = process.argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'check';
  const json = args.includes('--json');

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Usage: cobolt-fr-split-integrity.js check [--json]');
    process.exit(EXIT_OK);
  }
  if (cmd !== 'check' && cmd !== 'report') {
    console.error('Usage: cobolt-fr-split-integrity.js check [--json]');
    process.exit(EXIT_USAGE);
  }
  const result = check({});
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatText(result));
  process.exit(cmd === 'report' ? EXIT_OK : result.exitCode);
}

if (require.main === module) main();

module.exports = { check, parseEpics, EXIT_OK, EXIT_USAGE, EXIT_MISSING, EXIT_VIOLATION };
