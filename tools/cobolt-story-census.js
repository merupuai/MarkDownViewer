#!/usr/bin/env node

// CoBolt Story Census — audits story-tracker.json against disk reality.
//
// Catches the four defect classes reported by the Meru planning audit:
//   1. storyFile: null on a tracked story that is NOT in backlog/planned/deferred
//   2. storyFile references a path that no longer exists on disk
//   3. Story frontmatter `milestone:` disagrees with tracker's milestone
//   4. Story frontmatter `milestone: unknown` — violates Plan Stage Ordering Invariant
//
// Commands:
//   check [--json] [--fix-backlog]
//
// Exit codes:
//   0 = census clean
//   1 = usage error
//   2 = missing story-tracker.json (Tier 2 skip)
//   5 = census defects found

const fs = require('node:fs');
const path = require('node:path');
const { getPlanningDir, safeReadJson } = require('../lib/cobolt-planning-artifacts');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_DEFECTS = 5;

const BACKLOG_STATUSES = new Set(['backlog', 'planned', 'deferred', 'pending']);

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function readFrontmatter(fp) {
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    if (!raw.startsWith('---')) return null;
    const end = raw.indexOf('\n---', 3);
    if (end === -1) return null;
    const fm = raw.slice(3, end).trim();
    const out = {};
    for (const line of fm.split(/\r?\n/)) {
      const m = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
      if (m) {
        let v = m[2].trim();
        if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
          v = v.slice(1, -1);
        }
        out[m[1]] = v;
      }
    }
    return out;
  } catch {
    return null;
  }
}

function check(pd) {
  const trackerPath = path.join(pd, 'story-tracker.json');
  const data = safeReadJson(trackerPath);
  if (!data) return { verdict: 'SKIP', reason: 'story-tracker.json not found', exitCode: EXIT_MISSING };
  const stories = Array.isArray(data.stories) ? data.stories : [];
  const findings = [];

  for (const entry of stories) {
    const sid = entry.id || entry.storyId || `${entry.epic || ''}-${entry.story || ''}`;
    const sf = entry.storyFile;
    const status = (entry.status || '').toLowerCase();
    const expectedMilestone = entry.milestone;

    // 1. storyFile null on non-backlog entry
    if (sf == null && !BACKLOG_STATUSES.has(status)) {
      findings.push({
        class: 'story-tracker-null-storyfile-active',
        severity: 'high',
        id: sid,
        status,
        message: `${sid} status=${status} has storyFile: null but is not in backlog/planned/deferred`,
      });
      continue;
    }

    if (sf == null) continue;

    // 2. storyFile references non-existent file
    const abs = path.isAbsolute(sf) ? sf : path.join(pd, sf);
    if (!fs.existsSync(abs)) {
      findings.push({
        class: 'story-tracker-orphaned-storyfile',
        severity: 'high',
        id: sid,
        storyFile: sf,
        message: `${sid} references storyFile ${sf} but file does not exist on disk`,
      });
      continue;
    }

    // 3/4. Frontmatter milestone drift / "unknown"
    const fm = readFrontmatter(abs);
    if (!fm) continue;
    const fmMilestone = (fm.milestone || '').trim();
    if (!fmMilestone || fmMilestone.toLowerCase() === 'unknown') {
      findings.push({
        class: 'story-frontmatter-milestone-unknown',
        severity: 'high',
        id: sid,
        storyFile: sf,
        message: `${sid} has milestone: "${fmMilestone || '<empty>'}" — violates Plan Stage Ordering Invariant`,
      });
    } else if (expectedMilestone && fmMilestone !== expectedMilestone) {
      findings.push({
        class: 'story-frontmatter-milestone-drift',
        severity: 'high',
        id: sid,
        storyFile: sf,
        tracker: expectedMilestone,
        frontmatter: fmMilestone,
        message: `${sid} tracker=${expectedMilestone} but frontmatter=${fmMilestone}`,
      });
    }
  }

  return {
    verdict: findings.length === 0 ? 'PASS' : 'DEFECTS',
    totalStories: stories.length,
    findings,
    exitCode: findings.length === 0 ? EXIT_OK : EXIT_DEFECTS,
  };
}

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'check';
  const json = hasFlag(args, '--json');

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Usage: cobolt-story-census.js check [--json]');
    process.exit(EXIT_OK);
  }

  if (cmd !== 'check') {
    console.error(`Unknown command: ${cmd}`);
    process.exit(EXIT_USAGE);
  }

  const pd = getPlanningDir(process.cwd(), { create: false, fallbackToLatest: true });
  if (!pd || !fs.existsSync(pd)) {
    const out = { verdict: 'SKIP', reason: 'no planning directory' };
    if (json) console.log(JSON.stringify(out, null, 2));
    else console.log('no planning directory');
    process.exit(EXIT_MISSING);
  }

  const result = check(pd);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('== Story Census ==');
    console.log(`stories: ${result.totalStories ?? 0}`);
    console.log(`defects: ${result.findings?.length ?? 0}`);
    for (const f of result.findings || []) {
      console.log(`  [${f.severity}] ${f.class}: ${f.message}`);
    }
    console.log(`verdict: ${result.verdict}`);
  }

  process.exit(result.exitCode);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { check };
