#!/usr/bin/env node

// CoBolt Contract Semantic Verifier (v0.12.0 — WS1)
//
// Complements the shape-only verifier (cobolt-contract-verify.js) with two
// deeper layers:
//
//   L2 — Schema conformance: validates example payloads against the declared
//        requestSchema / responseSchema / payloadSchema using JSON Schema
//        (lightweight in-house validator — no runtime dep).
//
//   L3 — Example replay: checks that generated contract tests (from
//        cobolt-contract-testgen.js) exist on disk AND were run in the
//        latest test output. Replay itself is executed by the project's
//        native test runner; this tool verifies the evidence.
//
//   L4 — Invariant coverage: every contract invariant (INV-NNN) must be
//        referenced by at least one example.invariantRefs, AND that example
//        must be kind∈{idempotency,concurrency,authz,failure} when invariant
//        category is idempotency/consistency/ordering/authz (meaning the
//        happy path alone cannot satisfy a critical invariant).
//
// Violations are appended to _cobolt-output/audit/contract-semantic-violations.jsonl
// and bump the contractViolations telemetry metric.
//
// Permissive when no examples[] present on any contract (back-compat with
// v0.11.0 contracts). When at least one contract declares examples, all
// contracts must meet the tier rules in this tool.
//
// Usage:
//   node tools/cobolt-contract-semantic-verify.js verify [--milestone M3] [--layer L2|L3|L4|all]
//   node tools/cobolt-contract-semantic-verify.js check
//   node tools/cobolt-contract-semantic-verify.js invariants
//
// Exit codes:
//   0 — pass (or permissive no-op)
//   1 — violations found
//   2 — invalid contracts file

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function paths() {
  try {
    const mod = require('../lib/cobolt-paths');
    const p = typeof mod === 'function' ? mod() : typeof mod.paths === 'function' ? mod.paths() : mod;
    return p;
  } catch {
    const out = path.join(process.cwd(), '_cobolt-output');
    return {
      outputRoot: out,
      audit: () => path.join(out, 'audit'),
      latestPlanning: () => path.join(out, 'latest', 'planning'),
      latest: () => path.join(out, 'latest'),
    };
  }
}

function loadContracts() {
  const p = paths();
  const candidates = [
    path.join(typeof p.latestPlanning === 'function' ? p.latestPlanning() : '', 'interface-contracts.json'),
    path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'interface-contracts.json'),
    path.join(process.cwd(), '_cobolt-output', 'planning', 'interface-contracts.json'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      try {
        return { data: JSON.parse(fs.readFileSync(c, 'utf8')), source: c };
      } catch (err) {
        throw new Error(`invalid JSON in ${c}: ${err.message}`);
      }
    }
  }
  return { data: null, source: null };
}

// ── Tiny JSON Schema validator (draft-07 subset) ─────────────────────
// Covers: type, required, properties, additionalProperties, items, enum,
// pattern, minimum/maximum, minLength/maxLength, const. Sufficient for
// contract payload validation without pulling ajv.

function validate(schema, value, pathStack = []) {
  const errors = [];
  const here = pathStack.join('.') || '(root)';
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const ok = types.some((t) => {
      if (t === 'integer') return Number.isInteger(value);
      if (t === 'number') return typeof value === 'number';
      return t === actual;
    });
    if (!ok) errors.push(`${here}: expected type ${types.join('|')}, got ${actual}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${here}: value not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push(`${here}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      errors.push(`${here}: pattern /${schema.pattern}/ mismatch`);
    if (schema.minLength != null && value.length < schema.minLength)
      errors.push(`${here}: minLength ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength)
      errors.push(`${here}: maxLength ${schema.maxLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${here}: minimum ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${here}: maximum ${schema.maximum}`);
  }
  if (schema.type === 'object' || (value && typeof value === 'object' && !Array.isArray(value))) {
    const props = schema.properties || {};
    const required = schema.required || [];
    for (const r of required) {
      if (!(r in (value || {}))) errors.push(`${here}: missing required '${r}'`);
    }
    for (const [k, v] of Object.entries(value || {})) {
      if (props[k]) errors.push(...validate(props[k], v, [...pathStack, k]));
      else if (schema.additionalProperties === false) errors.push(`${here}: additional property '${k}' not allowed`);
    }
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${here}: minItems ${schema.minItems}`);
    if (schema.items)
      value.forEach((v, i) => {
        errors.push(...validate(schema.items, v, [...pathStack, `[${i}]`]));
      });
  }
  return errors;
}

// ── L2 — Schema conformance of examples ─────────────────────────────

function extractPayload(sideValue, _kind) {
  // Examples accept either string ("POST /orders {...}") or object form.
  // For schema validation we need an object. Strings are treated as pass
  // (cannot infer payload shape from prose) but flagged as weak.
  if (typeof sideValue === 'string') return { weak: true };
  if (sideValue && typeof sideValue === 'object') {
    // Common shapes: {body: {...}}, {payload: {...}}, {response: {...}}, raw object
    if ('body' in sideValue) return { payload: sideValue.body };
    if ('payload' in sideValue) return { payload: sideValue.payload };
    if ('response' in sideValue) return { payload: sideValue.response };
    if ('request' in sideValue) return { payload: sideValue.request };
    return { payload: sideValue };
  }
  return { weak: true };
}

function verifyL2(contract) {
  const spec = contract.spec || {};
  const examples = contract.examples || [];
  if (examples.length === 0) return { layer: 'L2', skipped: true, reason: 'no examples declared' };

  const issues = [];
  const weakCount = { whenCount: 0, thenCount: 0 };

  for (const ex of examples) {
    // API: validate example.when payload against requestSchema; example.then against responseSchema
    // Skip request validation for failure/edge: these examples often intentionally send invalid input.
    const invalidInputKind = ex.kind === 'failure' || ex.kind === 'edge';
    if (spec.kind === 'api') {
      if (!invalidInputKind && spec.requestSchema && Object.keys(spec.requestSchema).length > 0) {
        const { payload, weak } = extractPayload(ex.when, 'api');
        if (weak) weakCount.whenCount++;
        else {
          const errs = validate(spec.requestSchema, payload);
          if (errs.length) issues.push({ example: ex.id, side: 'request', errors: errs });
        }
      }
      if (spec.responseSchema && Object.keys(spec.responseSchema).length > 0 && ex.kind !== 'failure') {
        const { payload, weak } = extractPayload(ex.then, 'api');
        if (weak) weakCount.thenCount++;
        else {
          const errs = validate(spec.responseSchema, payload);
          if (errs.length) issues.push({ example: ex.id, side: 'response', errors: errs });
        }
      }
    }
    if (spec.kind === 'event' && spec.payloadSchema && Object.keys(spec.payloadSchema).length > 0) {
      const { payload, weak } = extractPayload(ex.then, 'event');
      if (weak) weakCount.thenCount++;
      else {
        const errs = validate(spec.payloadSchema, payload);
        if (errs.length) issues.push({ example: ex.id, side: 'event-payload', errors: errs });
      }
    }
    // v0.12.0 fix M3: DATA L2 — validate example rows against column shape.
    // An example's `then` for a DATA contract is expected to be {row:{...}}
    // or the row object directly. Each column has a name/type/nullable.
    if (spec.kind === 'data' && Array.isArray(spec.columns) && spec.columns.length > 0) {
      const thenVal = ex.then;
      let row = null;
      if (thenVal && typeof thenVal === 'object') {
        row = thenVal.row || thenVal.record || (Array.isArray(thenVal.rows) ? thenVal.rows[0] : null) || thenVal;
      }
      if (!row || typeof row !== 'object') {
        weakCount.thenCount++;
      } else {
        const errs = [];
        for (const col of spec.columns) {
          const present = Object.hasOwn(row, col.name);
          const val = row[col.name];
          if (!present && col.nullable === false) errs.push(`row missing required column '${col.name}'`);
          if (present && val === null && col.nullable === false)
            errs.push(`column '${col.name}' is null but nullable=false`);
          if (present && val != null && col.type) {
            const t = String(col.type).toLowerCase();
            const actual = Array.isArray(val) ? 'array' : typeof val;
            const intFamily = /int|serial|number|numeric|decimal|real|double|float/;
            const strFamily = /text|char|varchar|uuid|string|json/;
            const dateFamily = /date|time|timestamp/;
            const boolFamily = /bool/;
            let ok = true;
            if (intFamily.test(t) && actual !== 'number') ok = false;
            else if (boolFamily.test(t) && actual !== 'boolean') ok = false;
            else if (strFamily.test(t) && actual !== 'string' && actual !== 'object') ok = false;
            else if (dateFamily.test(t) && actual !== 'string' && actual !== 'number') ok = false;
            if (!ok) errs.push(`column '${col.name}' expected ${col.type}, got ${actual}`);
          }
        }
        if (errs.length) issues.push({ example: ex.id, side: 'data-row', errors: errs });
      }
    }
    // TYPE contracts stay shape-only; L2 noted as skipped for clarity.
  }

  return {
    layer: 'L2',
    examples: examples.length,
    issues,
    weakCount,
    ok: issues.length === 0,
  };
}

// ── L3 — Example replay evidence ─────────────────────────────────────

function testgenDir() {
  return path.join(process.cwd(), 'tests', 'contracts');
}

function verifyL3(contract) {
  const examples = contract.examples || [];
  if (examples.length === 0) return { layer: 'L3', skipped: true, reason: 'no examples declared' };

  const dir = testgenDir();
  if (!fs.existsSync(dir))
    return { layer: 'L3', ok: false, reason: `tests/contracts/ not present — run cobolt-contract-testgen.js` };

  const expected = `${contract.id}.`;
  const present = fs.readdirSync(dir).some((f) => f.startsWith(expected));
  if (!present) return { layer: 'L3', ok: false, reason: `no test file for ${contract.id} in tests/contracts/` };

  // Evidence of replay execution — look at latest test output
  const p = paths();
  const latest = typeof p.latest === 'function' ? p.latest() : path.join(process.cwd(), '_cobolt-output', 'latest');
  const reportPath = path.join(latest, 'test', 'contract-replay.json');
  if (!fs.existsSync(reportPath))
    return { layer: 'L3', ok: false, reason: `contract-replay.json not found — replay never executed` };

  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const entry = (report.results || []).find((r) => r.contractId === contract.id);
    if (!entry) return { layer: 'L3', ok: false, reason: `no replay entry for ${contract.id}` };
    // v0.12.0 fix M4: detect stubs that were never wired. If every example's
    // error message matches the testgen stub signature, the builder deleted
    // or stubbed the tests rather than implementing them.
    const stubSignature = /not wired|not implemented/i;
    const allStubbed =
      entry.examples &&
      entry.examples.length > 0 &&
      entry.examples.every((e) => e && !e.ok && stubSignature.test(String(e.error || '')));
    if (allStubbed) {
      return {
        layer: 'L3',
        ok: false,
        reason: `all ${entry.examples.length} replay examples fail with "not wired" — contract stubs were never implemented. Wire actual transport calls in tests/contracts/${contract.id}.*`,
        stubbed: true,
      };
    }
    if (entry.failed > 0)
      return { layer: 'L3', ok: false, reason: `${entry.failed}/${entry.total} examples failed replay` };
    return { layer: 'L3', ok: true, replayed: entry.total };
  } catch (err) {
    return { layer: 'L3', ok: false, reason: `invalid contract-replay.json: ${err.message}` };
  }
}

// ── L4 — Invariant coverage ──────────────────────────────────────────

const CRITICAL_CATEGORIES = new Set(['idempotency', 'consistency', 'ordering', 'authz']);
const NON_HAPPY_KINDS = new Set(['failure', 'edge', 'idempotency', 'concurrency', 'authz', 'replay']);

function verifyL4(contract) {
  const invariants = contract.invariants || [];
  const examples = contract.examples || [];
  if (invariants.length === 0) return { layer: 'L4', skipped: true, reason: 'no invariants declared' };

  const issues = [];
  const exById = new Map(examples.map((e) => [e.id, e]));

  for (const inv of invariants) {
    const refs = examples
      .filter((e) => (e.invariantRefs || []).includes(inv.id))
      .concat((inv.verifiedBy || []).map((id) => exById.get(id)).filter(Boolean));
    if (refs.length === 0) {
      issues.push({ invariant: inv.id, reason: 'no examples reference this invariant' });
      continue;
    }
    if (CRITICAL_CATEGORIES.has(inv.category)) {
      const hasNonHappy = refs.some((e) => NON_HAPPY_KINDS.has(e.kind));
      if (!hasNonHappy) {
        issues.push({
          invariant: inv.id,
          reason: `critical invariant (${inv.category}) covered only by happy-path examples — add an idempotency/concurrency/failure example`,
        });
      }
    }
  }

  return { layer: 'L4', invariants: invariants.length, issues, ok: issues.length === 0 };
}

// ── Main ─────────────────────────────────────────────────────────────

function verifyAll(opts = {}) {
  const { data, source } = loadContracts();
  if (!data) return { ok: true, skipped: true, reason: 'no interface-contracts.json', source: null };

  const contracts = data.contracts || [];
  const milestoneFilter = opts.milestone || null;
  const wantLayers = opts.layer && opts.layer !== 'all' ? new Set([opts.layer]) : new Set(['L2', 'L3', 'L4']);

  const anyExamples = contracts.some((c) => (c.examples || []).length > 0);
  if (!anyExamples) {
    return {
      ok: true,
      skipped: true,
      reason: 'no contract declares examples[] (v0.11.0-style) — semantic gate permissive',
      source,
      totalContracts: contracts.length,
    };
  }

  const violations = [];
  const passes = [];

  for (const c of contracts) {
    if (milestoneFilter && c.provider !== milestoneFilter && !c.consumers.includes(milestoneFilter)) continue;
    const report = { id: c.id, type: c.type, provider: c.provider, consumers: c.consumers, layers: {} };

    if (wantLayers.has('L2')) report.layers.L2 = verifyL2(c);
    if (wantLayers.has('L3')) report.layers.L3 = verifyL3(c);
    if (wantLayers.has('L4')) report.layers.L4 = verifyL4(c);

    const fails = Object.entries(report.layers).filter(([, r]) => r && r.ok === false);
    if (fails.length > 0) violations.push({ ...report, failingLayers: fails.map(([k]) => k) });
    else passes.push({ id: c.id });
  }

  return { ok: violations.length === 0, totalContracts: contracts.length, passes, violations, source };
}

function recordViolations(result) {
  if (!result.violations || result.violations.length === 0) return;
  const p = paths();
  const dir = typeof p.audit === 'function' ? p.audit() : path.join(process.cwd(), '_cobolt-output', 'audit');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const logFile = path.join(dir, 'contract-semantic-violations.jsonl');
  const ts = new Date().toISOString();
  for (const v of result.violations) {
    fs.appendFileSync(logFile, `${JSON.stringify({ ts, ...v })}\n`, { mode: 0o600 });
  }
  try {
    const tool = path.join(__dirname, 'cobolt-production-readiness.js');
    if (fs.existsSync(tool)) {
      execFileSync('node', [tool, 'record', 'contractViolations', String(result.violations.length)], {
        stdio: 'ignore',
      });
    }
  } catch {
    /* telemetry failure non-fatal */
  }
}

function parseFlags(args) {
  const out = { _: [], milestone: null, layer: 'all' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--milestone') out.milestone = args[++i];
    else if (args[i] === '--layer') out.layer = args[++i];
    else out._.push(args[i]);
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case 'verify':
    case 'check': {
      const result = verifyAll({ milestone: flags.milestone, layer: flags.layer });
      recordViolations(result);
      console.log(JSON.stringify(result, null, 2));
      if (result.skipped) return 0;
      return result.ok ? 0 : 1;
    }
    case 'invariants': {
      const { data } = loadContracts();
      const rows = [];
      for (const c of data?.contracts || []) {
        for (const inv of c.invariants || []) {
          rows.push({ contract: c.id, ...inv });
        }
      }
      console.log(JSON.stringify({ count: rows.length, invariants: rows }, null, 2));
      return 0;
    }
    default:
      console.error(
        'Usage: cobolt-contract-semantic-verify.js {verify|check|invariants} [--milestone M3] [--layer L2|L3|L4|all]',
      );
      return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { verifyAll, loadContracts, validate };
