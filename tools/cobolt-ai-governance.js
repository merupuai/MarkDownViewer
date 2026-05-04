#!/usr/bin/env node
// cobolt-ai-governance — ISO/IEC 42001:2023 + NIST AI RMF 1.0 readiness check.
// Detects AI usage, assesses governance controls, reports gaps. Advisory only.
//
// Usage:
//   node tools/cobolt-ai-governance.js validate
//   node tools/cobolt-ai-governance.js detect

const fs = require('node:fs');
const path = require('node:path');
const { ISO_42001_CONTROLS, NIST_AI_RMF, assessControl } = require('../lib/standards/ai-rmf-controls.js');

// GT-01: bypass routes through signed ledger; env-var auto-promotes during window.
function KILL() {
  const { isGateBypassed } = require('../lib/cobolt-bypass-resolver');
  return isGateBypassed('standards', { projectRoot: process.cwd() });
}
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '_cobolt-output', '.claude', 'coverage']);

const AI_SIGNALS = [
  { pattern: /@anthropic-ai\/sdk|anthropic\./i, provider: 'anthropic' },
  { pattern: /openai|gpt-[0-9]|chatgpt/i, provider: 'openai' },
  { pattern: /@google\/generative-ai|vertexai|gemini/i, provider: 'google' },
  { pattern: /langchain|llamaindex|transformers/i, provider: 'framework' },
  { pattern: /huggingface|sentence-transformers/i, provider: 'huggingface' },
  { pattern: /bedrock|cohere|mistral/i, provider: 'other-llm' },
];

function walk(root, acc = [], depth = 0) {
  if (depth > 8) return acc;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) walk(full, acc, depth + 1);
    else if (ent.isFile()) acc.push(full);
  }
  return acc;
}

function detectAi(projectRoot) {
  const signals = new Set();
  const providers = new Set();
  const pkg = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkg)) {
    const content = fs.readFileSync(pkg, 'utf8');
    for (const s of AI_SIGNALS) {
      if (s.pattern.test(content)) {
        signals.add(`package.json:${s.provider}`);
        providers.add(s.provider);
      }
    }
  }
  const src = path.join(projectRoot, 'src');
  const files = fs.existsSync(src) ? walk(src) : walk(projectRoot).slice(0, 500);
  const codeExts = new Set(['.js', '.ts', '.tsx', '.py', '.go', '.java']);
  for (const f of files) {
    if (!codeExts.has(path.extname(f))) continue;
    let content = '';
    try {
      content = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const s of AI_SIGNALS) {
      if (s.pattern.test(content)) {
        signals.add(path.relative(projectRoot, f).replace(/\\/g, '/'));
        providers.add(s.provider);
      }
    }
  }
  return { present: signals.size > 0, signals: Array.from(signals).slice(0, 50), providers: Array.from(providers) };
}

function buildContext(projectRoot) {
  const files = [];
  function collect(dir, depth = 0) {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) collect(full, depth + 1);
      else files.push(path.relative(projectRoot, full).replace(/\\/g, '/'));
    }
  }
  collect(projectRoot);
  const hasTests = files.some((f) => /(^|\/)(tests?|__tests__|spec)\//i.test(f) || /\.(test|spec)\.[jt]sx?$/i.test(f));
  const hasStructuredLogging = files.some((f) => /pino|winston|bunyan|logger\.js|log\.(ts|js)$/i.test(f));
  const evals = files.some((f) => /\beval(s)?\b/i.test(f));
  return { files, hasTests, hasStructuredLogging, evals };
}

function summarize(controls) {
  const counts = { satisfied: 0, gap: 0, unknown: 0, 'not-applicable': 0 };
  for (const c of controls) counts[c.status] = (counts[c.status] || 0) + 1;
  const assessed = controls.length - counts['not-applicable'];
  const coveragePct = assessed ? Math.round((counts.satisfied / assessed) * 1000) / 10 : 0;
  return { ...counts, coveragePct };
}

function build(projectRoot) {
  const aiDetected = detectAi(projectRoot);
  const ctx = buildContext(projectRoot);
  const controls = ISO_42001_CONTROLS.map((c) => {
    if (!aiDetected.present) return { ...c, status: 'not-applicable', reason: 'no AI usage detected' };
    const result = assessControl(c.id, ctx);
    return { ...c, status: result.status, reason: result.reason };
  });
  const nistFunctions = {};
  for (const [fn, cats] of Object.entries(NIST_AI_RMF)) {
    nistFunctions[fn] = {
      categories: cats,
      evidenceCount: 0,
      status: aiDetected.present ? 'requires-review' : 'not-applicable',
    };
  }
  return {
    standards: ['ISO/IEC 42001:2023', 'NIST AI RMF 1.0'],
    generatedAt: new Date().toISOString(),
    aiDetected,
    controls,
    nistFunctions,
    summary: summarize(controls),
  };
}

function printUsage() {
  console.log(
    [
      'cobolt-ai-governance - ISO/IEC 42001 + NIST AI RMF controls evaluator.',
      '',
      'Usage:',
      '  node tools/cobolt-ai-governance.js [validate|detect]',
      '',
      'No argument defaults to `validate`. Use `--help` or `-h` to print this usage without side effects.',
    ].join('\n'),
  );
}

function main() {
  if (KILL()) {
    console.log('COBOLT_STANDARDS=off — skipping');
    process.exit(0);
  }
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }
  const cmd = args[0] || 'validate';
  const projectRoot = process.cwd();
  if (cmd === 'detect') {
    const det = detectAi(projectRoot);
    console.log(JSON.stringify(det, null, 2));
    return;
  }
  const data = build(projectRoot);
  const outDir = path.join(projectRoot, '_cobolt-output', 'standards');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'ai-governance-report.json');
  fs.writeFileSync(out, JSON.stringify(data, null, 2));
  console.log(
    `ai-governance: aiDetected=${data.aiDetected.present}  providers=${data.aiDetected.providers.join(',') || 'none'}`,
  );
  console.log(
    `  controls: satisfied=${data.summary.satisfied} gaps=${data.summary.gap} unknown=${data.summary.unknown} n/a=${data.summary['not-applicable']}  coverage=${data.summary.coveragePct}%`,
  );
  console.log(`  written: ${out}`);
}

if (require.main === module) main();
module.exports = { build, detectAi };
