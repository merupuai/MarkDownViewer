#!/usr/bin/env node

// CoBolt Evolve — corpus & lesson miner (Phase 2).
//
// Mines _cobolt-output/archive/ for two artifact families:
//   1. "What Could Be Better" sections in dream files -> Reflexion seed lessons
//   2. (Phase 3+) full pipeline runs -> replay corpus cases (not yet implemented)
//
// Phase 2 ships only the Reflexion seeding path. The corpus miner is stubbed
// because it requires frozen PRD+architecture+expected-outcome triples that
// are project-specific; the miner will be re-enabled once cobolt-archive
// exposes a stable schema (tracked separately).
//
// Usage:
//   node tools/cobolt-evolve-mine.js lessons             # seed Reflexion ledger from dream files
//   node tools/cobolt-evolve-mine.js lessons --dry-run   # show what would be appended
//   node tools/cobolt-evolve-mine.js corpus              # currently a stub

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const reflexion = require('../lib/cobolt-evolve/reflexion');

function nowIso() {
  return new Date().toISOString();
}

function listDreamFiles(cwd) {
  const dir = path.join(cwd, '_cobolt-output', 'archive');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && /dream/i.test(d.name) && d.name.endsWith('.md'))
    .map((d) => path.join(dir, d.name));
}

// Extract bullet items under a "What Could Be Better" heading.
function extractWhatCouldBeBetter(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+What\s+Could\s+Be\s+Better/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) break;
    if (!inSection) continue;
    const m =
      line.match(/^\s*\d+\.\s+\*\*([^*]+)\*\*[:-]?\s*(.*)$/) ||
      line.match(/^\s*-\s+\*\*([^*]+)\*\*[:-]?\s*(.*)$/) ||
      line.match(/^\s*\d+\.\s+(.{8,})$/) ||
      line.match(/^\s*-\s+(.{8,})$/);
    if (m) {
      const title = m[2] !== undefined ? m[1].trim() : null;
      const body = (m[2] !== undefined ? m[2] : m[1]).trim();
      if (body) out.push({ title, body });
    }
  }
  return out;
}

// Heuristic: classify a "could be better" item to a mutationClass.
function classify(itemText) {
  const t = itemText.toLowerCase();
  if (/prompt|wording|instruction|agent\b/.test(t)) return 'agent-prompt';
  if (/skill|step|workflow|pipeline\b/.test(t)) return 'skill-step';
  if (/budget|token|context\s+window/.test(t)) return 'context-budget';
  if (/gate|tier|threshold/.test(t)) return 'gate-tier-tighten';
  return 'agent-prompt'; // safe default; proposer can override
}

function lessonFromItem(item, sourceFile) {
  const mutationClass = classify(`${item.title || ''} ${item.body}`);
  const failureAxis = 'historical-pain-point';
  const rule = item.title
    ? `Historical pain point: "${item.title}". ${item.body}`
    : `Historical pain point: ${item.body}`;
  const id = reflexion.lessonIdFor(mutationClass, failureAxis, rule);
  return {
    id,
    createdAt: nowIso(),
    source: `mine:${path.basename(sourceFile)}`,
    mutationClass,
    failureAxis,
    targetPath: '(unknown — derived from dream)',
    candidateId: null,
    parent: null,
    rule,
    avoid: { mutationClass, pathPattern: null },
  };
}

function cmdLessons(args) {
  const cwd = process.cwd();
  const dryRun = args.includes('--dry-run');
  const files = listDreamFiles(cwd);
  if (files.length === 0) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, mined: 0, note: 'no dream files under _cobolt-output/archive/' }, null, 2)}\n`,
    );
    return 0;
  }
  let appended = 0;
  let skipped = 0;
  const previewed = [];
  const existing = new Set(reflexion.loadAll(cwd).map((l) => l.id));
  for (const f of files) {
    const md = fs.readFileSync(f, 'utf8');
    const items = extractWhatCouldBeBetter(md);
    for (const item of items) {
      const lesson = lessonFromItem(item, f);
      if (existing.has(lesson.id)) {
        skipped++;
        continue;
      }
      existing.add(lesson.id);
      if (dryRun) {
        previewed.push({
          id: lesson.id,
          mutationClass: lesson.mutationClass,
          source: lesson.source,
          rule: lesson.rule.slice(0, 120),
        });
      } else {
        reflexion.appendLesson(lesson, cwd);
        appended++;
      }
    }
  }
  const out = { ok: true, dryRun, files: files.length, appended, skipped, ...(dryRun ? { previewed } : {}) };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return 0;
}

// Phase 3 minimal corpus miner.
// Generates one replay case per archived dream file. Each case captures only
// what is deterministic from disk:
//   * caseId derived from dream filename
//   * sourcePath pointing at the dream
//   * an `expected` block with parsed metrics from the dream's "Milestone Summary"
//     section (FR count, complexity, result grade) — these become smoke targets
//     that future shadow-runs can compare metric estimates against.
// Cases are appended to replay-corpus/manifest.json and never auto-frozen;
// the operator must `freeze` once stable (by editing manifest.json frozen:true).
function extractMetricsFromDream(md) {
  const out = {};
  const m1 = md.match(/\*\*ID\*\*:\s*(\S+)/i);
  if (m1) out.milestoneId = m1[1].trim();
  const m2 = md.match(/\*\*Result\*\*:\s*([A-F][+-]?)/i);
  if (m2) out.resultGrade = m2[1].trim();
  const m3 = md.match(/\*\*Complexity\*\*:\s*([^\n]+?)(?:\(|\n)/i);
  if (m3) out.complexity = m3[1].trim();
  const m4 = md.match(/(\d+)\s*FRs?/i);
  if (m4) out.frCount = Number(m4[1]);
  return out;
}

function cmdCorpus(args) {
  const cwd = process.cwd();
  const dryRun = args.includes('--dry-run');
  const dreams = listDreamFiles(cwd);
  if (dreams.length === 0) {
    process.stdout.write(`${JSON.stringify({ ok: true, mined: 0, note: 'no dream files found' }, null, 2)}\n`);
    return 0;
  }
  const corpusManifestPath = path.join(cwd, '_cobolt-output', 'harness-lab', 'replay-corpus', 'manifest.json');
  let manifest = null;
  if (fs.existsSync(corpusManifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(corpusManifestPath, 'utf8'));
    } catch {
      /* recreate below */
    }
  }
  if (!manifest) {
    manifest = {
      corpusId: `corpus-${new Date().toISOString().slice(0, 10)}-mined`,
      frozen: false,
      createdAt: new Date().toISOString(),
      description: 'Auto-mined from dream files (Phase 3).',
      cases: [],
    };
  }
  if (manifest.frozen) {
    process.stderr.write('refusing to mutate a frozen corpus; bump corpusId and unfreeze first\n');
    return 2;
  }
  const existing = new Set((manifest.cases || []).map((c) => c.caseId));
  const added = [];
  for (const f of dreams) {
    const caseId = `case-${path.basename(f, '.md')}`;
    if (existing.has(caseId)) continue;
    const md = fs.readFileSync(f, 'utf8');
    const expected = extractMetricsFromDream(md);
    const c = {
      caseId,
      sourcePath: path.relative(cwd, f).replace(/\\/g, '/'),
      expected,
      weight: 1,
    };
    added.push(c);
    if (!dryRun) manifest.cases.push(c);
  }
  if (!dryRun && added.length > 0) {
    atomicWrite(corpusManifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, dryRun, dreamFiles: dreams.length, added: added.length, totalCases: (manifest.cases || []).length, frozen: manifest.frozen, addedSample: added.slice(0, 5) }, null, 2)}\n`,
  );
  return 0;
}

function help() {
  process.stdout.write(
    [
      'cobolt-evolve-mine — seed harness-lab from existing CoBolt archives',
      '',
      'Commands:',
      '  lessons [--dry-run]   Mine "What Could Be Better" bullets from dreams -> Reflexion ledger',
      '  corpus  [--dry-run]   Mine dream files -> minimal replay-corpus cases',
      '',
    ].join('\n'),
  );
}

function main(argv) {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    help();
    return 0;
  }
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case 'lessons':
      return cmdLessons(rest);
    case 'corpus':
      return cmdCorpus(rest);
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      help();
      return 2;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, listDreamFiles, extractWhatCouldBeBetter, classify, lessonFromItem, extractMetricsFromDream };
