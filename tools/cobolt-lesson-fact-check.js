#!/usr/bin/env node

// cobolt-lesson-fact-check — v0.45.0 end-of-milestone lesson fact-check.
//
// Reads _cobolt-output/memory/lessons.jsonl and, for every lesson whose
// mistake/fix text cites specific files or FR IDs, verifies those citations
// against the current codebase + RTM. Citations that no longer resolve
// (file deleted, FR ID absent) mark the lesson as `veracity: "disputed"`
// so cobolt-lesson-inject excludes it from future retrieval.
//
// Advisory tool — never blocks pipeline. Intended to run at:
//   - End of each milestone (cobolt-dream skill)
//   - Ad-hoc via CLI when operator notices stale lessons injected
//
// Veracity values:
//   verified  — lesson was explicitly validated (human or successful fix).
//   assumed   — default; lesson was recorded without verification.
//   disputed  — lesson citations no longer resolve (this tool's output).
//
// Commands:
//   audit [--json] [--write] [--milestone M{n}]
//     audit: inspect lessons, report per-lesson verdict.
//     --write: persist disputed flags back to lessons.jsonl.
//     --milestone: filter to lessons from a specific milestone.
//   help
//
// Exit codes:
//   0 — audit complete
//   1 — usage error
//   2 — lessons.jsonl absent

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function argOf(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

function readJsonlFile(fp) {
  if (!fs.existsSync(fp)) return null;
  try {
    return fs
      .readFileSync(fp, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return null;
  }
}

function extractCitations(lesson) {
  const text = `${lesson.mistake || ''}\n${lesson.fix || ''}\n${(lesson.tags || []).join(' ')}`;
  const files = new Set();
  const frIds = new Set();

  const fileRe =
    /(?:^|[\s`"'(])([\w./-]+\.(?:js|ts|jsx|tsx|py|rb|go|rs|ex|exs|java|kt|swift|c|cc|cpp|h|hpp|php|md|json|yml|yaml|toml|sql))(?=[\s`"')]|$)/gm;
  let fm;
  while ((fm = fileRe.exec(text)) !== null) {
    const f = fm[1];
    if (f.includes('://')) continue;
    if (f.length > 200) continue;
    files.add(f);
  }

  const idRe = /\b((?:FR|NFR|TR|IR)[-_]?\d{1,4})\b/g;
  let im;
  while ((im = idRe.exec(text)) !== null) {
    frIds.add(im[1].replace(/[-_]/, '-'));
  }

  return { files: [...files], frIds: [...frIds] };
}

function loadRtmIds(root) {
  const candidates = [
    path.join(root, '_cobolt-output', 'latest', 'planning', 'rtm.json'),
    path.join(root, '_cobolt-output', 'latest', 'rtm', 'rtm.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        const rtm = JSON.parse(fs.readFileSync(c, 'utf8'));
        return new Set(Object.keys(rtm.requirements || {}));
      } catch {
        /* try next */
      }
    }
  }
  return null; // RTM absent — cannot verify FR IDs
}

function checkLesson(root, lesson, rtmIds) {
  const citations = extractCitations(lesson);
  const hasCitations = citations.files.length + citations.frIds.length > 0;
  if (!hasCitations) {
    return { verdict: 'unverifiable', reason: 'no-citations', citations };
  }

  const missingFiles = citations.files.filter((f) => {
    const abs = path.isAbsolute(f) ? f : path.join(root, f);
    return !fs.existsSync(abs);
  });

  const missingFrIds = rtmIds ? citations.frIds.filter((id) => !rtmIds.has(id)) : [];

  const totalCited = citations.files.length + (rtmIds ? citations.frIds.length : 0);
  const totalMissing = missingFiles.length + missingFrIds.length;

  if (totalCited === 0) {
    return { verdict: 'unverifiable', reason: 'rtm-absent', citations };
  }

  if (totalMissing === 0) {
    return { verdict: 'verified', citations };
  }

  if (totalMissing === totalCited) {
    return {
      verdict: 'disputed',
      reason: 'all-citations-missing',
      citations,
      missingFiles,
      missingFrIds,
    };
  }

  // Partial — leave as assumed (original state), note the partial drift.
  return {
    verdict: 'assumed',
    reason: 'partial-citation-drift',
    citations,
    missingFiles,
    missingFrIds,
  };
}

function audit(root, opts = {}) {
  const lessonsPath = path.join(root, '_cobolt-output', 'memory', 'lessons.jsonl');
  const lessons = readJsonlFile(lessonsPath);
  if (!lessons) {
    return { ok: false, exitCode: EXIT_MISSING, reason: 'lessons-file-absent' };
  }

  const rtmIds = loadRtmIds(root);
  const milestone = opts.milestone;

  const results = [];
  const tally = { verified: 0, assumed: 0, disputed: 0, unverifiable: 0 };

  for (const L of lessons) {
    if (milestone && L.milestone && L.milestone !== milestone) {
      results.push({ lesson: L, verdict: null, skipped: 'milestone-filter' });
      continue;
    }
    const r = checkLesson(root, L, rtmIds);
    tally[r.verdict] = (tally[r.verdict] || 0) + 1;
    results.push({ lesson: L, ...r });
  }

  return {
    ok: true,
    exitCode: EXIT_OK,
    report: {
      lessonsFile: lessonsPath,
      auditedAt: new Date().toISOString(),
      totalLessons: lessons.length,
      rtmAvailable: !!rtmIds,
      tally,
      results,
    },
  };
}

function persistVerdicts(_root, report) {
  const lessonsPath = report.lessonsFile;
  const originals = readJsonlFile(lessonsPath) || [];
  const byId = new Map(originals.map((L) => [L.id || JSON.stringify(L), L]));

  let changed = 0;
  for (const r of report.results) {
    if (r.skipped) continue;
    const original = r.lesson;
    const key = original.id || JSON.stringify(original);
    const existing = byId.get(key);
    if (!existing) continue;

    // Only mutate to `disputed` or to `verified`; do NOT mass-flip
    // `assumed`. Preserves human-set verdicts.
    if (r.verdict === 'disputed' && existing.veracity !== 'disputed') {
      existing.veracity = 'disputed';
      existing.disputedAt = new Date().toISOString();
      existing.disputedReason = r.reason;
      changed++;
    } else if (r.verdict === 'verified' && !existing.veracity) {
      existing.veracity = 'verified';
      existing.verifiedAt = new Date().toISOString();
      changed++;
    }
  }

  if (changed > 0) {
    const body = `${[...byId.values()].map((L) => JSON.stringify(L)).join('\n')}\n`;
    fs.writeFileSync(lessonsPath, body);
  }
  return changed;
}

function printHuman(report) {
  console.log('== Lesson Fact-Check ==');
  console.log(`  total:       ${report.totalLessons}`);
  console.log(`  verified:    ${report.tally.verified || 0}`);
  console.log(`  assumed:     ${report.tally.assumed || 0}`);
  console.log(`  disputed:    ${report.tally.disputed || 0}`);
  console.log(`  unverifiable: ${report.tally.unverifiable || 0}`);
  const disputedResults = report.results.filter((r) => r.verdict === 'disputed');
  if (disputedResults.length > 0) {
    console.log('');
    console.log('Disputed lessons (citations no longer resolve):');
    for (const r of disputedResults) {
      console.log(`  - ${r.lesson.id || '?'} (${r.lesson.milestone || 'n/a'}): ${r.reason}`);
    }
  }
}

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'audit';
  const json = hasFlag(args, '--json');
  const write = hasFlag(args, '--write');
  const milestone = argOf(args, '--milestone');

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Usage: cobolt-lesson-fact-check.js audit [--json] [--write] [--milestone M{n}]');
    console.log('Exits: 0=ok, 1=usage, 2=lessons-absent');
    process.exit(EXIT_OK);
  }

  if (cmd !== 'audit') {
    console.error(`Unknown command: ${cmd}`);
    process.exit(EXIT_USAGE);
  }

  const root = process.cwd();
  const result = audit(root, { milestone });

  if (!result.ok) {
    if (json) console.log(JSON.stringify({ ok: false, reason: result.reason }));
    else console.error(`lesson-fact-check: ${result.reason}`);
    process.exit(result.exitCode);
  }

  if (write) {
    const changed = persistVerdicts(root, result.report);
    result.report.persisted = changed;
  }

  if (json) console.log(JSON.stringify(result.report, null, 2));
  else {
    printHuman(result.report);
    if (result.report.persisted) console.log(`  persisted ${result.report.persisted} verdicts`);
  }

  process.exit(result.exitCode);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { audit, checkLesson, extractCitations, persistVerdicts };
