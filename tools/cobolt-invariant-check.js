#!/usr/bin/env node
// S5 — Architectural invariant executor. Parses ADRs with `assert:` blocks from
// architecture-decisions.md and runs two engines:
//   - AST (ast-grep) for static forbid-import / require-wrapper rules
//   - Runtime (OTel span queries over staging traces) for behavior assertions
// Emits _cobolt-output/latest/invariants/{M}-violations.json.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const CWD = process.cwd();
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const M = arg('--milestone', 'M1');
const adrPath = arg('--adr') || '_cobolt-output/latest/planning/architecture-decisions.md';
const tracePath = arg('--traces') || '_cobolt-output/latest/traces/otel.jsonl';

const skipped = [];
const adrs = parseADRs(path.join(CWD, adrPath));
const violations = [];

// Surface missing engines up-front so downstream sees evidence of non-coverage.
(function detectEngineAvailability() {
  const yaml = tryRequire('yaml') || tryRequire('js-yaml');
  if (!yaml)
    skipped.push({
      engine: 'yaml-parser',
      reason: 'neither `yaml` nor `js-yaml` installed — assert blocks cannot be parsed',
    });
  const astGrep = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ast-grep']);
  if (astGrep.status !== 0)
    skipped.push({ engine: 'ast-grep', reason: 'ast-grep not on PATH — AST forbid-import rules not checked' });
  if (!fs.existsSync(path.join(CWD, tracePath))) {
    skipped.push({
      engine: 'runtime-traces',
      reason: `no traces file at ${tracePath} — runtime assertions not checked`,
    });
  }
})();

for (const adr of adrs) {
  if (adr.assert?.ast?.['forbid-import']) {
    const rule = adr.assert.ast['forbid-import'];
    const targets = Array.isArray(rule.targets) ? rule.targets : [rule.targets];
    const hits = astGrepForbid(rule.from, targets);
    if (hits.length)
      violations.push({ adr: adr.id, kind: 'ast', summary: `${hits.length} forbidden imports`, details: hits });
  }
  if (adr.assert?.runtime?.trace) {
    const rt = adr.assert.runtime.trace;
    const issues = runtimeCheck(path.join(CWD, tracePath), rt);
    if (issues.length)
      violations.push({
        adr: adr.id,
        kind: 'runtime',
        summary: `${issues.length} runtime violations`,
        details: issues.slice(0, 20),
      });
  }
}

const out = path.join(CWD, '_cobolt-output', 'latest', 'invariants', `${M}-violations.json`);
atomicWrite(out, JSON.stringify({ milestone: M, generatedAt: new Date().toISOString(), violations, skipped }, null, 2));
console.log(`invariant check: ${violations.length} violations → ${path.relative(CWD, out)}`);
process.exit(violations.length ? 1 : 0);

function parseADRs(p) {
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, 'utf8');
  const blocks = text.split(/^##\s+(ADR-\d+)/m);
  const out = [];
  for (let i = 1; i < blocks.length; i += 2) {
    const id = blocks[i];
    const body = blocks[i + 1] || '';
    const yamlMatch = body.match(/```ya?ml\s*([\s\S]*?)```/);
    if (!yamlMatch) continue;
    try {
      // Minimal YAML parser — require yaml or fall back to JSON if yaml unavailable.
      const yaml = tryRequire('yaml') || tryRequire('js-yaml');
      if (!yaml) continue;
      const parsed = yaml.parse ? yaml.parse(yamlMatch[1]) : yaml.load(yamlMatch[1]);
      if (parsed?.assert) out.push({ id, assert: parsed.assert });
    } catch {}
  }
  return out;
}

function tryRequire(n) {
  try {
    return require(n);
  } catch {
    return null;
  }
}

function astGrepForbid(fromGlob, targets) {
  const astGrep = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ast-grep']);
  if (astGrep.status !== 0) return []; // no ast-grep, skip
  const hits = [];
  for (const t of targets) {
    const r = spawnSync('ast-grep', ['run', '-p', `import $$$ from '${t}'`, '--json', fromGlob], { cwd: CWD });
    if (r.status === 0) {
      try {
        const out = JSON.parse(r.stdout.toString() || '[]');
        for (const h of out) hits.push({ file: h.file, line: h.range?.start?.line });
      } catch {}
    }
  }
  return hits;
}

function runtimeCheck(tracePath, rt) {
  if (!fs.existsSync(tracePath)) return [];
  const issues = [];
  const lines = fs.readFileSync(tracePath, 'utf8').split('\n').filter(Boolean);
  for (const ln of lines) {
    let span;
    try {
      span = JSON.parse(ln);
    } catch {
      continue;
    }
    if (rt.query && !getPath(span, rt.query)) continue;
    if (rt.assert && !evalAssert(span, rt.assert)) issues.push({ traceId: span.traceId, spanId: span.spanId });
  }
  return issues;
}

function getPath(obj, p) {
  return p.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
}
function evalAssert(span, expr) {
  // Tiny DSL: supports `a == b`, `a != b`, `exists a`
  const m = expr.match(/^\s*(.+?)\s*(==|!=)\s*(.+)\s*$/) || expr.match(/^\s*exists\s+(.+)$/);
  if (!m) return true;
  if (m.length === 2) return getPath(span, m[1]) !== undefined;
  const [, l, op, r] = m;
  const lv = getPath(span, l),
    rv = getPath(span, r);
  return op === '==' ? lv === rv : lv !== rv;
}
