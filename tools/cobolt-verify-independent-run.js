#!/usr/bin/env node
// S2 — Independent verification runner. Controller that:
//   1. Ensures property/independent tests exist under tests/independent/M{n}/
//      (generates via cobolt-property-test-gen.js when absent).
//   2. Runs the tests via the appropriate framework based on tech-stack.json.
//   3. Merges a mutation-score report (from cobolt-mutation-run.js) if present.
//   4. Writes `_cobolt-output/latest/verify/{M}-verdict.json` consumed by
//      source/hooks/cobolt-mutation-score-gate.js.
//
// Usage:
//   node tools/cobolt-verify-independent-run.js --milestone M1 [--skip-mutation]

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const CWD = process.cwd();
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const hasFlag = (k) => process.argv.includes(k);

const M = arg('--milestone', 'M1');
const SKIP_MUTATION = hasFlag('--skip-mutation');
const DISPATCH_AUTHORING = hasFlag('--dispatch-authoring');

function readJSON(p, d) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return d;
  }
}

function detectLang() {
  const stack = readJSON(path.join(CWD, '_cobolt-output', 'latest', 'planning', 'tech-stack.json'), {});
  const l = (stack.primaryLanguage || '').toLowerCase();
  if (l.includes('typescript') || l.includes('javascript')) return 'ts';
  if (l.includes('python')) return 'py';
  if (l.includes('rust')) return 'rust';
  if (l.includes('elixir')) return 'ex';
  return 'ts';
}

function ensureTestsExist() {
  const dir = path.join(CWD, 'tests', 'independent', M);
  const hasAny = fs.existsSync(dir) && fs.readdirSync(dir).some((f) => /\.(ts|js|mjs|py|rs|exs)$/.test(f));
  if (hasAny) return { generated: false, dir };
  const gen = path.join(__dirname, 'cobolt-property-test-gen.js');
  if (!fs.existsSync(gen)) return { generated: false, dir, reason: 'property-test-gen missing' };
  const r = spawnSync(process.execPath, [gen, '--milestone', M], { cwd: CWD, stdio: 'inherit' });
  return { generated: r.status === 0, dir, reason: r.status === 0 ? null : 'generator failed' };
}

function runTests(lang, dir) {
  if (!fs.existsSync(dir)) {
    return { total: 0, passed: 0, failed: 0, skipped: 'no tests dir' };
  }
  const files = fs.readdirSync(dir);
  if (lang === 'ts' || lang === 'js') {
    // Prefer node --test for zero-dep; fallback to vitest if present.
    const jsFiles = files.filter((f) => /\.(js|mjs|cjs)$/.test(f)).map((f) => path.join(dir, f));
    if (jsFiles.length) {
      const r = spawnSync(process.execPath, ['--test', ...jsFiles], {
        cwd: CWD,
        encoding: 'utf8',
        env: childProcessEnv(),
      });
      return parseNodeTest(r.stdout + r.stderr, r.status);
    }
    const tsFiles = files.filter((f) => /\.ts$/.test(f));
    if (tsFiles.length) {
      // Try vitest
      const vitest = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['vitest'], { encoding: 'utf8' });
      if (vitest.status === 0) {
        const r = spawnSync('vitest', ['run', dir, '--reporter=json'], { cwd: CWD, encoding: 'utf8' });
        return parseVitest(r.stdout, r.status);
      }
      return { total: tsFiles.length, passed: 0, failed: 0, skipped: 'no ts runner (vitest) available' };
    }
  }
  if (lang === 'py') {
    const pyTool = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pytest'], { encoding: 'utf8' });
    if (pyTool.status !== 0) return { total: 0, passed: 0, failed: 0, skipped: 'pytest not installed' };
    const r = spawnSync('pytest', [dir, '-q', '--tb=no'], { cwd: CWD, encoding: 'utf8' });
    return parsePytest(r.stdout + r.stderr, r.status);
  }
  if (lang === 'rust') {
    return { total: 0, passed: 0, failed: 0, skipped: 'rust runner not wired (use `cargo test`)' };
  }
  if (lang === 'ex') {
    return { total: 0, passed: 0, failed: 0, skipped: 'elixir runner not wired (use `mix test`)' };
  }
  return { total: 0, passed: 0, failed: 0, skipped: `unsupported lang: ${lang}` };
}

function childProcessEnv() {
  const env = { ...process.env };
  // When this runner is invoked from this repository's own node:test suite,
  // inherited test-runner IPC context can consume child TAP output before this
  // tool can parse it. Independent verification needs an ordinary subprocess.
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function parseNodeTest(text, status) {
  // Node's TAP output: "# tests N", "# pass N", "# fail N"
  const total = lastNumber(text, /^#\s*tests\s+(\d+)$/gm) || 0;
  const passed = lastNumber(text, /^#\s*pass\s+(\d+)$/gm) || 0;
  const failed = lastNumber(text, /^#\s*fail\s+(\d+)$/gm) || 0;
  if (total === 0 && status !== 0) return { total: 0, passed: 0, failed: 0, skipped: 'node --test reported no tests' };
  return { total, passed, failed };
}

function lastNumber(text, regex) {
  const matches = [...String(text || '').matchAll(regex)];
  if (!matches.length) return null;
  return Number(matches[matches.length - 1][1]);
}

function parseVitest(stdout) {
  try {
    const j = JSON.parse(stdout);
    const total = j.numTotalTests || 0;
    const passed = j.numPassedTests || 0;
    const failed = j.numFailedTests || 0;
    return { total, passed, failed };
  } catch {
    return { total: 0, passed: 0, failed: 0, skipped: 'vitest output not parseable' };
  }
}

function parsePytest(text) {
  const m = text.match(/(\d+)\s+passed(?:,\s+(\d+)\s+failed)?/);
  if (!m) return { total: 0, passed: 0, failed: 0, skipped: 'pytest output not parseable' };
  const passed = Number(m[1] || 0);
  const failed = Number(m[2] || 0);
  return { total: passed + failed, passed, failed };
}

function mergeMutation(verdict) {
  const p = path.join(CWD, '_cobolt-output', 'latest', 'verify', `${M}-mutation-report.json`);
  if (!fs.existsSync(p)) {
    verdict.mutationScore = null;
    verdict.mutationSkipped = 'mutation report not found; run cobolt-mutation-run.js';
    return;
  }
  const m = readJSON(p, null);
  if (!m) {
    verdict.mutationScore = null;
    verdict.mutationSkipped = 'mutation report unreadable';
    return;
  }
  if (m.skipped) {
    verdict.mutationScore = null;
    verdict.mutationSkipped = m.skipped;
    return;
  }
  verdict.mutationScore = typeof m.score === 'number' ? m.score : null;
  verdict.mutation = {
    tool: m.tool || null,
    total: m.total || 0,
    killed: (m.killed || []).length,
    survivors: (m.survivors || []).length,
  };
}

function mergeContractConformance(verdict) {
  try {
    const { checkContractReplay } = require('./cobolt-contract-replay');
    const replay = checkContractReplay({ cwd: CWD, milestone: M });
    verdict.contractRuntimeConformance = typeof replay.coverage === 'number' ? replay.coverage : replay.ok ? 1 : 0;
    verdict.contractReplay = {
      ok: replay.ok === true,
      skipped: replay.skipped === true,
      reason: replay.reason || null,
      totalPairs: replay.totalPairs || 0,
      executedPairs: replay.executedPairs || 0,
      failures: Array.isArray(replay.failures) ? replay.failures.slice(0, 20) : [],
    };
  } catch (error) {
    verdict.contractRuntimeConformance = 0;
    verdict.contractReplay = {
      ok: false,
      error: error.message,
    };
  }
}

// ── Independent-Verifier Authoring Brief ────────────────────
//
// The CLI emits the brief; actual second-model session must be invoked by
// the calling skill (cobolt-verify-independent SKILL.md) or a human
// operator. Node alone cannot reach a second LLM provider.
function emitAuthoringBrief() {
  const verifyDir = path.join(CWD, '_cobolt-output', 'latest', 'verify');
  const envSpec = process.env.COBOLT_INDEPENDENT_VERIFIER || '';
  const [provider, model] = envSpec.split(':');
  const auto = Boolean(provider && model);

  const commonBody = [
    `# Independent Verifier Dispatch Brief — ${M}`,
    ``,
    `Generated: ${new Date().toISOString()}`,
    ``,
    `## Sealed constraints (READ-ONLY SCOPE)`,
    ``,
    `- You MUST NOT read any file under \`src/\` or \`app/\`.`,
    `- You MUST NOT read the primary test suite under \`tests/\` (only \`tests/independent/${M}/\`).`,
    `- You may read: \`_cobolt-output/latest/planning/**\` (PRD, TRD, architecture, api-contracts, rtm.json).`,
    `- You may read: \`_cobolt-output/latest/build/${M}/\` summaries only — no raw source.`,
    ``,
    `## Task`,
    ``,
    `Author property-based and invariant tests for ${M} under \`tests/independent/${M}/\``,
    `from the SPEC alone. Do NOT cross-reference implementation source.`,
    ``,
    `## Output`,
    ``,
    `Write each test file directly. Each file should focus on one invariant or`,
    `requirement from PRD/TRD. Prefer node --test for JS/TS projects.`,
    ``,
  ].join('\n');

  let authoringMode = 'skipped';
  let writtenPath = null;
  if (auto) {
    authoringMode = 'auto';
    writtenPath = path.join(verifyDir, `${M}-dispatch-brief.md`);
    const autoBody = `${commonBody}\n## Dispatch target\n\n- Provider: \`${provider}\`\n- Model:    \`${model}\`\n\n> Node cannot dispatch a second-model session directly. The calling skill\n> (\`source/skills/cobolt-verify-independent/SKILL.md\`) must invoke the\n> second model against this brief. A human operator may also run it.\n`;
    atomicWrite(writtenPath, autoBody);
  } else {
    authoringMode = 'manual';
    writtenPath = path.join(verifyDir, `${M}-manual-dispatch-prompt.md`);
    const manualBody = `${commonBody}\n## How to run\n\n1. Copy the section above into a second LLM session (different provider from the primary builder).\n2. Let that session author the test files under \`tests/independent/${M}/\`.\n3. Re-run \`node tools/cobolt-verify-independent-run.js --milestone ${M}\`.\n\n> Set \`COBOLT_INDEPENDENT_VERIFIER=provider:model\` to signal auto mode for\n> downstream skills.\n`;
    atomicWrite(writtenPath, manualBody);
  }
  return { authoringMode, briefPath: writtenPath };
}

function main() {
  const lang = detectLang();
  let authoring = null;
  if (DISPATCH_AUTHORING) {
    try {
      authoring = emitAuthoringBrief();
    } catch (e) {
      authoring = { authoringMode: 'skipped', error: e.message };
    }
  }
  const ensure = ensureTestsExist();
  const run = runTests(lang, ensure.dir);
  const verdict = {
    milestone: M,
    generatedAt: new Date().toISOString(),
    lang,
    testsGenerated: ensure.generated,
    independentTests: {
      total: run.total,
      passed: run.passed,
      failed: run.failed,
    },
    independentTestPassRate: run.total > 0 ? run.passed / run.total : 0,
  };
  if (run.skipped) verdict.independentTests.skipped = run.skipped;
  if (ensure.reason) verdict.generatorNote = ensure.reason;
  if (authoring) {
    verdict.authoringMode = authoring.authoringMode;
    if (authoring.briefPath) verdict.authoringBrief = path.relative(CWD, authoring.briefPath);
    if (authoring.error) verdict.authoringError = authoring.error;
  } else if (DISPATCH_AUTHORING) {
    verdict.authoringMode = 'skipped';
  }

  if (!SKIP_MUTATION) mergeMutation(verdict);
  else verdict.mutationSkipped = '--skip-mutation flag';
  mergeContractConformance(verdict);

  verdict.pass =
    run.failed === 0 &&
    run.total > 0 &&
    !run.skipped &&
    (verdict.mutationScore == null || verdict.mutationScore >= 0.7) &&
    verdict.contractRuntimeConformance >= 0.95;

  const out = path.join(CWD, '_cobolt-output', 'latest', 'verify', `${M}-verdict.json`);
  atomicWrite(out, JSON.stringify(verdict, null, 2));
  console.log(
    `verify-independent: ${verdict.pass ? 'PASS' : 'FAIL'} (${run.passed}/${run.total}, mutation=${verdict.mutationScore ?? 'n/a'}) → ${path.relative(CWD, out)}`,
  );
  process.exit(verdict.pass ? 0 : 1);
}

if (require.main === module) main();

module.exports = { runTests, mergeMutation };
