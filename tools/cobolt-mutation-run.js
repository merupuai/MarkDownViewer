#!/usr/bin/env node
// S2 — Mutation testing runner. Detects an installed mutation tool
// (stryker / mutmut / pitest / mull), runs it against files changed in
// the current milestone (git diff M{n}-start..HEAD if tag exists, else
// HEAD~20..HEAD), parses tool output into a normalized shape, and writes:
//   - _cobolt-output/latest/verify/{M}-mutation-report.json  (detailed)
//   - merges {score, skipped?} into {M}-verdict.json (if exists)
//
// Usage:
//   node tools/cobolt-mutation-run.js --milestone M1 [--tool stryker]

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const CWD = process.cwd();
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};

const M = arg('--milestone', 'M1');
const FORCED_TOOL = arg('--tool');

function which(bin) {
  const localBin = path.join(CWD, 'node_modules', '.bin', process.platform === 'win32' ? `${bin}.cmd` : bin);
  if (fs.existsSync(localBin)) return localBin;
  const localPlainBin = path.join(CWD, 'node_modules', '.bin', bin);
  if (fs.existsSync(localPlainBin)) return localPlainBin;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : null;
}

function detectTool() {
  if (FORCED_TOOL) return FORCED_TOOL;
  if (which('stryker')) return 'stryker';
  if (which('mutmut')) return 'mutmut';
  if (which('pitest')) return 'pitest';
  if (which('mull-runner')) return 'mull';
  if (which('mull')) return 'mull';
  return null;
}

function changedFiles() {
  const tag = `${M}-start`;
  try {
    execFileSync('git', ['rev-parse', '--verify', tag], { cwd: CWD, stdio: 'ignore' });
    const out = execFileSync('git', ['diff', '--name-only', `${tag}..HEAD`], { cwd: CWD, encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  } catch {}
  try {
    const out = execFileSync('git', ['diff', '--name-only', 'HEAD~20..HEAD'], { cwd: CWD, encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function runStryker(files) {
  const srcFiles = files.filter((f) => /\.(js|ts|mjs|cjs)$/.test(f) && !/test|spec|__tests__/.test(f));
  const args = ['run'];
  if (srcFiles.length) {
    args.push('--mutate', srcFiles.join(','));
  }
  args.push('--reporters', 'json');
  const r = spawnSync(which('stryker') || 'stryker', args, { cwd: CWD, encoding: 'utf8' });
  const reportPath = path.join(CWD, 'reports', 'mutation', 'mutation.json');
  if (!fs.existsSync(reportPath))
    return { error: `stryker ran (status=${r.status}) but no report found at ${reportPath}` };
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const killed = [];
  const survivors = [];
  for (const [file, f] of Object.entries(report.files || {})) {
    for (const mut of f.mutants || []) {
      const entry = { file, id: mut.id, mutator: mut.mutatorName, line: mut.location?.start?.line };
      if (mut.status === 'Killed' || mut.status === 'Timeout') killed.push(entry);
      else if (mut.status === 'Survived' || mut.status === 'NoCoverage') survivors.push(entry);
    }
  }
  const total = killed.length + survivors.length;
  return { total, killed, survivors, score: total ? killed.length / total : 0 };
}

function runMutmut(files) {
  const srcFiles = files.filter((f) => /\.py$/.test(f) && !/test_|_test\.py$/.test(f));
  try {
    execFileSync('mutmut', ['run', ...(srcFiles.length ? ['--paths-to-mutate', srcFiles.join(',')] : [])], {
      cwd: CWD,
      stdio: 'inherit',
    });
  } catch {}
  const r = spawnSync('mutmut', ['results'], { cwd: CWD, encoding: 'utf8' });
  if (r.status !== 0) return { error: 'mutmut results failed' };
  const text = r.stdout;
  const killedCount = Number((text.match(/killed:\s*(\d+)/i) || [])[1] || 0);
  const survivedCount = Number((text.match(/survived:\s*(\d+)/i) || [])[1] || 0);
  const total = killedCount + survivedCount;
  return {
    total,
    killed: Array(killedCount)
      .fill(0)
      .map((_, i) => ({ id: `killed-${i}` })),
    survivors: Array(survivedCount)
      .fill(0)
      .map((_, i) => ({ id: `survived-${i}` })),
    score: total ? killedCount / total : 0,
  };
}

function runPitest() {
  const r = spawnSync('pitest', [], { cwd: CWD, encoding: 'utf8' });
  if (r.status !== 0) return { error: 'pitest failed' };
  const idx = path.join(CWD, 'target', 'pit-reports', 'mutations.xml');
  if (!fs.existsSync(idx)) return { error: 'pitest report not found' };
  const xml = fs.readFileSync(idx, 'utf8');
  const all = xml.match(/<mutation[^>]*status="([^"]+)"/g) || [];
  const killed = all.filter((s) => /status="KILLED"/.test(s)).length;
  const survived = all.filter((s) => /status="SURVIVED"/.test(s)).length;
  const total = killed + survived;
  return {
    total,
    killed: Array(killed)
      .fill(0)
      .map((_, i) => ({ id: `killed-${i}` })),
    survivors: Array(survived)
      .fill(0)
      .map((_, i) => ({ id: `survived-${i}` })),
    score: total ? killed / total : 0,
  };
}

function main() {
  const tool = detectTool();
  const outDir = path.join(CWD, '_cobolt-output', 'latest', 'verify');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${M}-mutation-report.json`);
  const verdictPath = path.join(outDir, `${M}-verdict.json`);

  if (!tool) {
    const report = {
      milestone: M,
      generatedAt: new Date().toISOString(),
      skipped: 'no mutation tool detected (stryker/mutmut/pitest/mull)',
    };
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    mergeIntoVerdict(verdictPath, { mutationScore: null, mutationSkipped: report.skipped });
    console.log(`mutation: SKIPPED — ${report.skipped}`);
    process.exit(0);
  }

  const files = changedFiles();
  let result;
  try {
    if (tool === 'stryker') result = runStryker(files);
    else if (tool === 'mutmut') result = runMutmut(files);
    else if (tool === 'pitest') result = runPitest();
    else result = { error: `runner not implemented for ${tool}` };
  } catch (e) {
    result = { error: `mutation run threw: ${e.message}` };
  }

  const report = {
    milestone: M,
    generatedAt: new Date().toISOString(),
    tool,
    changedFiles: files.length,
  };
  if (result.error) {
    report.skipped = result.error;
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    mergeIntoVerdict(verdictPath, { mutationScore: null, mutationSkipped: result.error });
    console.log(`mutation: SKIPPED — ${result.error}`);
    process.exit(0);
  }
  report.score = result.score;
  report.total = result.total;
  report.killed = result.killed;
  report.survivors = result.survivors;

  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  mergeIntoVerdict(verdictPath, {
    mutationScore: result.score,
    mutation: { tool, total: result.total, killed: result.killed.length, survivors: result.survivors.length },
  });
  console.log(
    `mutation: score=${(result.score * 100).toFixed(1)}% (${result.killed.length}/${result.total}) → ${path.relative(CWD, out)}`,
  );
  process.exit(0);
}

function mergeIntoVerdict(p, patch) {
  let v = {};
  if (fs.existsSync(p)) {
    try {
      v = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      v = {};
    }
  }
  Object.assign(v, patch);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

if (require.main === module) main();

module.exports = { detectTool, changedFiles };
