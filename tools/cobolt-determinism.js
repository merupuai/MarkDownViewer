#!/usr/bin/env node
// Determinism harness — snapshot planning runs, compare for divergence.

const fs = require('node:fs');
const path = require('node:path');

const CRITICAL_FILES = ['PRD.md', 'architecture.md', 'rtm.json', 'interface-contracts.json', 'shared-kernel.json'];
const CRITICAL_GLOBS = ['epics', 'stories', 'milestones'];
const IGNORED_KEYS = new Set(['timestamp', 'generatedAt', 'createdAt', 'updatedAt', 'runId', 'id']);

function detRoot(cwd) {
  return path.join(cwd, '_cobolt-output', 'determinism');
}
function planningRoot(cwd) {
  return path.join(cwd, '_cobolt-output', 'latest', 'planning');
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function snapshot({ cwd, name }) {
  const src = planningRoot(cwd);
  if (!fs.existsSync(src)) {
    return { ok: false, error: `No planning directory at ${src}` };
  }
  const dst = path.join(detRoot(cwd), name);
  if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
  copyDir(src, dst);
  fs.writeFileSync(
    path.join(dst, '.snapshot-meta.json'),
    JSON.stringify({ name, source: src, capturedAt: new Date().toISOString() }, null, 2),
  );
  return { ok: true, path: dst };
}

function listFiles(dir, rel = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.name.startsWith('.snapshot-meta')) continue;
    if (entry.isDirectory()) out.push(...listFiles(full, r));
    else if (entry.isFile()) out.push(r);
  }
  return out;
}

function relevantFiles(dir) {
  const all = listFiles(dir);
  return all.filter((f) => {
    if (CRITICAL_FILES.includes(f)) return true;
    for (const g of CRITICAL_GLOBS) {
      if (f.startsWith(`${g}/`)) return true;
    }
    return false;
  });
}

function stripIgnored(value) {
  if (Array.isArray(value)) return value.map(stripIgnored);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (IGNORED_KEYS.has(k)) continue;
      out[k] = stripIgnored(value[k]);
    }
    return out;
  }
  return value;
}

function flattenKeys(obj, prefix = '', out = {}) {
  if (obj === null || typeof obj !== 'object') {
    out[prefix || '$'] = obj;
    return out;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      flattenKeys(obj[i], `${prefix}[${i}]`, out);
    }
    return out;
  }
  for (const k of Object.keys(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    flattenKeys(obj[k], p, out);
  }
  return out;
}

function diffJson(a, b) {
  const fa = flattenKeys(stripIgnored(a));
  const fb = flattenKeys(stripIgnored(b));
  const ka = new Set(Object.keys(fa));
  const kb = new Set(Object.keys(fb));
  const added = [...kb].filter((k) => !ka.has(k));
  const removed = [...ka].filter((k) => !kb.has(k));
  const shared = [...ka].filter((k) => kb.has(k));
  const changed = shared.filter((k) => JSON.stringify(fa[k]) !== JSON.stringify(fb[k]));
  const total = new Set([...ka, ...kb]).size || 1;
  const structural = (added.length + removed.length) / total;
  const changedRatio = shared.length ? changed.length / shared.length : 0;
  const score = Math.min(1, structural * 0.4 + changedRatio * 0.4);
  return { added, removed, changed, score, semanticUnits: { a: [...ka], b: [...kb] } };
}

function extractSemanticUnits(md) {
  const units = new Set();
  const frIds = md.match(/\b(FR|NFR|AC|REQ|US|STORY|EPIC|M\d+-?[A-Z0-9-]*)[-_]?\d+[A-Z0-9-]*/g) || [];
  for (const id of frIds) units.add(`id:${id.toUpperCase()}`);
  const headers = md.match(/^#{1,6}\s+(.+)$/gm) || [];
  for (const h of headers)
    units.add(
      `h:${h
        .replace(/^#+\s+/, '')
        .trim()
        .toLowerCase()}`,
    );
  const acLines = md.match(/^\s*[-*]\s*(?:Given|When|Then|And|Must|Should|Shall)\b.+$/gim) || [];
  for (const line of acLines) units.add(`ac:${line.trim().replace(/\s+/g, ' ').toLowerCase()}`);
  return units;
}

function jaccardDistance(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return 1 - inter / union;
}

function diffMarkdown(a, b) {
  const ua = extractSemanticUnits(a);
  const ub = extractSemanticUnits(b);
  const added = [...ub].filter((x) => !ua.has(x));
  const removed = [...ua].filter((x) => !ub.has(x));
  const total = new Set([...ua, ...ub]).size || 1;
  const structural = (added.length + removed.length) / total;
  const jd = jaccardDistance(ua, ub);
  const score = Math.min(1, structural * 0.4 + 0 + jd * 0.2 + structural * 0.4);
  return { added, removed, changed: [], score, semanticUnits: { a: [...ua], b: [...ub] } };
}

function diffFile(pathA, pathB, rel) {
  const aExists = fs.existsSync(pathA);
  const bExists = fs.existsSync(pathB);
  if (!aExists && !bExists) return { score: 0, added: [], removed: [], changed: [], missing: true };
  if (!aExists) return { score: 1, added: [rel], removed: [], changed: [] };
  if (!bExists) return { score: 1, added: [], removed: [rel], changed: [] };
  const textA = fs.readFileSync(pathA, 'utf8');
  const textB = fs.readFileSync(pathB, 'utf8');
  if (rel.endsWith('.json')) {
    try {
      return diffJson(JSON.parse(textA), JSON.parse(textB));
    } catch {
      return diffMarkdown(textA, textB);
    }
  }
  return diffMarkdown(textA.replace(/\s+/g, ' '), textB.replace(/\s+/g, ' '));
}

function findCriticalDivergences(byArtifact) {
  const crit = [];
  for (const [file, d] of Object.entries(byArtifact)) {
    for (const id of d.removed || []) {
      if (typeof id === 'string' && /^id:(FR|NFR|REQ)/i.test(id)) {
        crit.push({ file, kind: 'requirement_dropped', id });
      }
    }
    for (const id of d.added || []) {
      if (typeof id === 'string' && /^id:(FR|NFR|REQ)/i.test(id)) {
        crit.push({ file, kind: 'requirement_added', id });
      }
    }
    if (file.startsWith('milestones/') && (d.changed || []).some((k) => /boundary|scope|stories|epic/i.test(k))) {
      crit.push({ file, kind: 'milestone_boundary_moved' });
    }
  }
  return crit;
}

function compare({ cwd, a, b, threshold = 0.25 }) {
  const root = detRoot(cwd);
  const dirA = path.join(root, a);
  const dirB = path.join(root, b);
  if (!fs.existsSync(dirA) || !fs.existsSync(dirB)) {
    return { ok: false, error: `Missing snapshot(s): ${dirA} / ${dirB}` };
  }
  const files = new Set([...relevantFiles(dirA), ...relevantFiles(dirB)]);
  const byArtifact = {};
  let weighted = 0;
  let n = 0;
  for (const rel of files) {
    const d = diffFile(path.join(dirA, rel), path.join(dirB, rel), rel);
    byArtifact[rel] = {
      score: d.score,
      added: d.added,
      removed: d.removed,
      changed: d.changed,
    };
    weighted += d.score;
    n += 1;
  }
  const divergenceScore = n ? Math.min(1, weighted / n) : 0;
  const criticalDivergences = findCriticalDivergences(byArtifact);
  let verdict = 'PASS';
  if (divergenceScore >= threshold || criticalDivergences.length > 0) verdict = 'FAIL';
  else if (divergenceScore >= 0.1) verdict = 'WARN';
  const report = {
    a,
    b,
    threshold,
    divergenceScore,
    verdict,
    byArtifact,
    criticalDivergences,
    generatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(root, { recursive: true });
  const reportPath = path.join(root, `${a}-vs-${b}-report.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(root, 'latest-verdict.json'),
    JSON.stringify({ verdict, divergenceScore, a, b, reportPath, generatedAt: report.generatedAt }, null, 2),
  );
  return { ok: verdict !== 'FAIL', score: divergenceScore, report, reportPath };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--snapshot') out.snapshot = argv[++i];
    else if (x === '--compare') {
      out.compareA = argv[++i];
      out.compareB = argv[++i];
    } else if (x === '--threshold') out.threshold = Number.parseFloat(argv[++i]);
    else if (x === '--json') out.json = true;
    else if (x === '--cwd') out.cwd = argv[++i];
    else out._.push(x);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = args.cwd || process.cwd();
  if (args.snapshot) {
    const r = snapshot({ cwd, name: args.snapshot });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    } else if (r.ok) {
      process.stdout.write(`Snapshot captured: ${r.path}\n`);
    } else {
      process.stderr.write(`Snapshot failed: ${r.error}\n`);
    }
    process.exit(r.ok ? 0 : 1);
  }
  if (args.compareA && args.compareB) {
    const r = compare({
      cwd,
      a: args.compareA,
      b: args.compareB,
      threshold: Number.isFinite(args.threshold) ? args.threshold : 0.25,
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    } else if (r.ok === false && r.error) {
      process.stderr.write(`Compare error: ${r.error}\n`);
    } else {
      process.stdout.write(
        `Verdict: ${r.report.verdict}  score=${r.report.divergenceScore.toFixed(4)}  report=${r.reportPath}\n`,
      );
    }
    process.exit(r.report && r.report.verdict !== 'FAIL' ? 0 : 1);
  }
  process.stdout.write('Usage: cobolt-determinism --snapshot NAME | --compare A B [--threshold 0.25] [--json]\n');
  process.exit(0);
}

module.exports = { snapshot, compare, diffJson, diffMarkdown, extractSemanticUnits };

if (require.main === module) main();
