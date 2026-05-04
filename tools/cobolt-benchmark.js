#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const CORPUS_PATH = path.join(ROOT, 'source', 'templates', 'benchmark-corpus.json');
const RESULTS_DIR = path.join(ROOT, '_cobolt-output', 'audit', 'benchmarks');
const VALID_TARGETS = Object.freeze([
  'cobolt',
  'devin',
  'cursor',
  'github-copilot-coding-agent',
  'openai-codex-cloud',
  'backstage-opa',
  'manual',
]);
const VALID_OUTCOMES = Object.freeze(['pass', 'fail', 'partial', 'skipped', 'error']);

function loadCorpus(corpusPath = CORPUS_PATH) {
  return JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
}

function loadResults(resultsDir = RESULTS_DIR) {
  if (!fs.existsSync(resultsDir)) return [];
  return fs
    .readdirSync(resultsDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const full = path.join(resultsDir, file);
      try {
        return JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch (err) {
        return { _parseError: err.message, _file: file };
      }
    });
}

function validateCase(item) {
  const errors = [];
  if (!item || typeof item !== 'object') return ['case is not an object'];
  if (!/^BM-\d{3}$/.test(item.id || '')) errors.push(`id "${item.id}" must match BM-NNN`);
  if (!item.category) errors.push(`${item.id}: category required`);
  if (!item.title) errors.push(`${item.id}: title required`);
  if (!item.description || item.description.length < 20) errors.push(`${item.id}: description must be >= 20 chars`);
  if (!item.fixture?.kind || !item.fixture?.ref) errors.push(`${item.id}: fixture.kind and fixture.ref required`);
  if (!Array.isArray(item.metrics) || item.metrics.length < 3) errors.push(`${item.id}: at least 3 metrics required`);
  if (!Array.isArray(item.expectedOutcomes) || item.expectedOutcomes.length < 1) {
    errors.push(`${item.id}: expectedOutcomes required`);
  } else {
    for (const outcome of item.expectedOutcomes) {
      if (!outcome.assertion) errors.push(`${item.id}: expectedOutcome.assertion required`);
      if (!outcome.rationale || outcome.rationale.length < 20) {
        errors.push(`${item.id}: expectedOutcome.rationale must be >= 20 chars`);
      }
    }
  }
  return errors;
}

function validateCorpus(corpus) {
  const errors = [];
  if (!corpus || typeof corpus !== 'object') return ['corpus is not an object'];
  if (!corpus.version) errors.push('corpus.version required');
  if (!Array.isArray(corpus.cases)) errors.push('corpus.cases must be array');
  const seen = new Set();
  for (const item of corpus.cases || []) {
    if (seen.has(item.id)) errors.push(`duplicate case id ${item.id}`);
    seen.add(item.id);
    errors.push(...validateCase(item));
  }
  return errors;
}

function validateResult(result, knownCaseIds) {
  const errors = [];
  if (!result || typeof result !== 'object') return ['result is not an object'];
  if (!knownCaseIds.has(result.caseId)) errors.push(`result.caseId "${result.caseId}" unknown`);
  if (!result.runId) errors.push(`${result.caseId}: runId required`);
  if (!result.runAt) errors.push(`${result.caseId}: runAt required`);
  if (!VALID_TARGETS.includes(result.target)) errors.push(`${result.caseId}: target "${result.target}" invalid`);
  if (!VALID_OUTCOMES.includes(result.outcome)) errors.push(`${result.caseId}: outcome "${result.outcome}" invalid`);
  if (!result.measured || typeof result.measured !== 'object')
    errors.push(`${result.caseId}: measured object required`);
  if (!result.envFingerprint?.nodeVersion || !result.envFingerprint?.os) {
    errors.push(`${result.caseId}: envFingerprint.nodeVersion and os required`);
  }
  return errors;
}

function aggregate(corpus, results) {
  const byCase = new Map((corpus.cases || []).map((item) => [item.id, { case: item, runs: [] }]));
  for (const result of results) {
    if (result._parseError) continue;
    const slot = byCase.get(result.caseId);
    if (slot) slot.runs.push(result);
  }
  const summary = { totalCases: byCase.size, totalRuns: 0, byTarget: {} };
  for (const slot of byCase.values()) {
    for (const run of slot.runs) {
      summary.totalRuns++;
      const target = (summary.byTarget[run.target] = summary.byTarget[run.target] || {
        runs: 0,
        pass: 0,
        fail: 0,
        partial: 0,
        skipped: 0,
        error: 0,
      });
      target.runs++;
      if (target[run.outcome] !== undefined) target[run.outcome]++;
    }
  }
  return { summary, byCase };
}

function cmdValidate() {
  const corpus = loadCorpus();
  const known = new Set((corpus.cases || []).map((item) => item.id));
  const errors = [...validateCorpus(corpus)];
  for (const result of loadResults()) {
    if (result._parseError) errors.push(`parse error in ${result._file}: ${result._parseError}`);
    else errors.push(...validateResult(result, known));
  }
  if (errors.length > 0) {
    console.error(`[cobolt-benchmark] FAIL: ${errors.length} validation error(s)`);
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }
  console.log(`[cobolt-benchmark] OK: ${(corpus.cases || []).length} case(s) validate`);
  return 0;
}

function cmdList(opts) {
  const corpus = loadCorpus();
  if (opts.json) console.log(JSON.stringify(corpus, null, 2));
  else {
    console.log(`# CoBolt Benchmark Corpus v${corpus.version}`);
    for (const item of corpus.cases || []) console.log(`${item.id}\t${item.category}\t${item.title}`);
  }
  return 0;
}

function cmdRecord(opts) {
  const corpus = loadCorpus();
  const known = new Set((corpus.cases || []).map((item) => item.id));
  const runAt = new Date().toISOString();
  const runId = opts.runId || `${runAt.replace(/[-:]/g, '').slice(0, 13)}-${crypto.randomBytes(3).toString('hex')}`;
  const measured = Object.fromEntries(
    opts.measured.map((entry) => {
      const idx = entry.indexOf('=');
      if (idx < 0) throw new Error(`--measured entry must be key=value: ${entry}`);
      const key = entry.slice(0, idx);
      const raw = entry.slice(idx + 1);
      const num = Number(raw);
      return [key, Number.isFinite(num) && raw.trim() !== '' ? num : raw];
    }),
  );
  const result = {
    caseId: opts.caseId,
    runId,
    runAt,
    target: opts.target,
    outcome: opts.outcome,
    measured,
    envFingerprint: {
      nodeVersion: process.version,
      os: `${process.platform}-${process.arch}`,
    },
    notes: opts.notes || '',
  };
  const errors = validateResult(result, known);
  if (errors.length > 0) {
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }
  fs.mkdirSync(RESULTS_DIR, { recursive: true, mode: 0o700 });
  const out = path.join(RESULTS_DIR, `${result.caseId}-${result.target}-${runId}.json`);
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(`[cobolt-benchmark] recorded ${path.relative(ROOT, out).replace(/\\/g, '/')}`);
  return 0;
}

function cmdReport(opts) {
  const corpus = loadCorpus();
  const { summary, byCase } = aggregate(corpus, loadResults());
  if (opts.json) {
    console.log(JSON.stringify({ ...summary, generatedAt: new Date().toISOString() }, null, 2));
    return 0;
  }
  console.log(`# CoBolt Benchmark Report`);
  console.log('');
  console.log(`Cases: ${summary.totalCases}`);
  console.log(`Runs: ${summary.totalRuns}`);
  console.log('');
  if (summary.totalRuns === 0) console.log('_No recorded results yet._\n');
  for (const slot of byCase.values()) {
    console.log(`- ${slot.case.id}: ${slot.case.title} (${slot.runs.length} run(s))`);
  }
  return 0;
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { sub: null, json: false, measured: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (i === 0 && !arg.startsWith('--')) opts.sub = arg;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--case') opts.caseId = argv[++i];
    else if (arg === '--target') opts.target = argv[++i];
    else if (arg === '--outcome') opts.outcome = argv[++i];
    else if (arg === '--run-id') opts.runId = argv[++i];
    else if (arg === '--measured') opts.measured.push(argv[++i]);
    else if (arg === '--notes') opts.notes = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  opts.sub = opts.sub || 'validate';
  return opts;
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log('Usage: node tools/cobolt-benchmark.js list|validate|record|report [--json]');
    return 0;
  }
  if (opts.sub === 'list') return cmdList(opts);
  if (opts.sub === 'validate') return cmdValidate(opts);
  if (opts.sub === 'record') return cmdRecord(opts);
  if (opts.sub === 'report') return cmdReport(opts);
  throw new Error(`Unknown subcommand: ${opts.sub}`);
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`[cobolt-benchmark] ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  VALID_OUTCOMES,
  VALID_TARGETS,
  aggregate,
  loadCorpus,
  loadResults,
  validateCase,
  validateCorpus,
  validateResult,
};
