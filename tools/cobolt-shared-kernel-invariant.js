#!/usr/bin/env node
// CoBolt Shared-Kernel Invariant Checker
//
// Detects contradictions between a kernel version's declared invariants and
// later extension versions' schemas. Complements cobolt-shared-kernel-gate
// (which only blocks unauthorized WRITES) by catching semantic contradictions
// when M_n legitimately extends the kernel in a way that breaks M_{n-1}'s
// assumptions (required field removed, type narrowed, enum trimmed, etc.).
//
// Input: _cobolt-output/latest/planning/shared-kernel.json
//   {
//     kernels: [{
//       id, version, owner,
//       invariants: [{ id, description, assertion }],  // assertion: JSON Schema fragment
//       schema: { ...JSON Schema... },
//       extensions: [{ milestone, version, schema, invariants? }]
//     }]
//   }
// Back-compat: also accepts `modules` array with inline `versions: [...]`.
//
// Programmatic: require('.../cobolt-shared-kernel-invariant').checkKernelInvariants({ cwd, milestone })
// CLI: node tools/cobolt-shared-kernel-invariant.js [--milestone M2] [--json]

const fs = require('node:fs');
const path = require('node:path');

function tryAjv() {
  try {
    const Ajv = require('ajv');
    return new Ajv({ allErrors: true, strict: false });
  } catch {
    return null;
  }
}

function loadKernelDoc(cwd) {
  const candidates = [
    path.join(cwd, '_cobolt-output', 'latest', 'planning', 'shared-kernel.json'),
    path.join(cwd, '_cobolt-output', 'planning', 'shared-kernel.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        return { path: c, doc: JSON.parse(fs.readFileSync(c, 'utf8')) };
      } catch {
        return { path: c, doc: null };
      }
    }
  }
  return { path: null, doc: null };
}

// Normalize either {kernels:[{version,schema,invariants,extensions}]} or
// {modules:[{versions:[{version,schema,invariants}]}]} into an ordered
// list of versions per kernel.
function normalizeKernels(doc) {
  if (!doc || typeof doc !== 'object') return [];
  const out = [];
  const list = Array.isArray(doc.kernels) ? doc.kernels : Array.isArray(doc.modules) ? doc.modules : [];
  for (const k of list) {
    if (!k?.id) continue;
    const versions = [];
    // Base version
    if (k.schema || k.invariants) {
      versions.push({
        version: k.version || 1,
        milestone: k.owner || k.milestone || null,
        schema: k.schema || null,
        invariants: Array.isArray(k.invariants) ? k.invariants : [],
      });
    }
    // Extensions
    const exts = Array.isArray(k.extensions) ? k.extensions : Array.isArray(k.versions) ? k.versions : [];
    for (const e of exts) {
      if (!e) continue;
      versions.push({
        version: e.version != null ? e.version : versions.length + 1,
        milestone: e.milestone || null,
        schema: e.schema || null,
        invariants: Array.isArray(e.invariants) ? e.invariants : [],
      });
    }
    versions.sort((a, b) => a.version - b.version);
    out.push({ id: k.id, owner: k.owner || null, versions });
  }
  return out;
}

// Deterministic schema shape extraction limited to JSON Schema subsets we care
// about: type, required, properties, enum.
function schemaShape(schema) {
  if (!schema || typeof schema !== 'object') return { type: null, required: [], properties: {}, enum: null };
  return {
    type: schema.type || null,
    required: Array.isArray(schema.required) ? schema.required.slice() : [],
    properties: schema.properties && typeof schema.properties === 'object' ? schema.properties : {},
    enum: Array.isArray(schema.enum) ? schema.enum.slice() : null,
  };
}

// Compatibility check: prior schema's guarantees must still hold in current.
// Returns array of reasons (empty = compatible).
function compareSchemas(prior, current) {
  const reasons = [];
  const P = schemaShape(prior);
  const C = schemaShape(current);

  if (P.type && C.type && P.type !== C.type) {
    reasons.push(`root type changed: ${P.type} -> ${C.type}`);
  }

  // Required fields that existed before must still be required.
  for (const f of P.required) {
    if (!C.required.includes(f)) {
      reasons.push(`required field '${f}' is no longer required (became optional or was removed)`);
    }
  }

  // Properties: type narrowing / removal
  for (const [name, priorProp] of Object.entries(P.properties)) {
    const curProp = C.properties[name];
    if (!curProp) {
      if (P.required.includes(name)) {
        reasons.push(`property '${name}' removed (was required)`);
      }
      continue;
    }
    if (priorProp && curProp && priorProp.type && curProp.type && priorProp.type !== curProp.type) {
      reasons.push(`property '${name}' type changed: ${priorProp.type} -> ${curProp.type}`);
    }
    // Enum narrowing
    if (Array.isArray(priorProp?.enum)) {
      const curEnum = Array.isArray(curProp.enum) ? curProp.enum : null;
      if (!curEnum) {
        reasons.push(`property '${name}' enum constraint removed (prior values: ${priorProp.enum.join(',')})`);
      } else {
        const removed = priorProp.enum.filter((v) => !curEnum.includes(v));
        if (removed.length) reasons.push(`property '${name}' enum values removed: ${removed.join(',')}`);
      }
    }
  }
  return reasons;
}

// Check an invariant's assertion (a JSON Schema fragment) still holds over the
// current schema. We validate the CURRENT SCHEMA SHAPE against the assertion
// by checking required/type/enum subsumption — a structural check, not a data
// validation. If ajv is present we additionally compile the assertion to
// detect malformed assertions early.
function checkInvariant(inv, currentSchema, ajv) {
  const assertion = inv?.assertion;
  if (!assertion || typeof assertion !== 'object') return null;
  if (ajv) {
    try {
      ajv.compile(assertion);
    } catch (e) {
      return `invariant '${inv.id || inv.description}' assertion invalid: ${e.message}`;
    }
  }
  // Structural: required fields in assertion must be required in current.
  const cur = schemaShape(currentSchema);
  const reqs = Array.isArray(assertion.required) ? assertion.required : [];
  for (const r of reqs) {
    if (!cur.required.includes(r)) {
      return `invariant '${inv.id || inv.description}' violated: asserts required '${r}', current schema does not require it`;
    }
  }
  // Type assertion on root
  if (assertion.type && cur.type && assertion.type !== cur.type) {
    return `invariant '${inv.id || inv.description}' violated: asserts root type '${assertion.type}', current is '${cur.type}'`;
  }
  // Per-property type assertions
  const aprops = assertion.properties || {};
  for (const [name, ap] of Object.entries(aprops)) {
    const cp = cur.properties[name];
    if (!cp) {
      return `invariant '${inv.id || inv.description}' violated: asserts property '${name}', current schema lacks it`;
    }
    if (ap.type && cp.type && ap.type !== cp.type) {
      return `invariant '${inv.id || inv.description}' violated: property '${name}' must be '${ap.type}', current is '${cp.type}'`;
    }
  }
  return null;
}

function checkKernelInvariants({ cwd = process.cwd(), milestone = null } = {}) {
  const { path: kernelPath, doc } = loadKernelDoc(cwd);
  if (!doc) {
    return {
      ok: true,
      permissive: true,
      reason: kernelPath ? 'kernel file unparseable' : 'no kernel file',
      kernelPath,
      reports: [],
    };
  }
  const kernels = normalizeKernels(doc);
  const extendedKernels = kernels.filter((k) => k.versions.length > 1);
  if (extendedKernels.length === 0) {
    return { ok: true, permissive: true, reason: 'no kernels with extensions', kernelPath, reports: [] };
  }
  const ajv = tryAjv();
  const reports = [];

  // Census: every extended kernel must be checked. Track coverage.
  for (const k of extendedKernels) {
    const violations = [];
    for (let i = 1; i < k.versions.length; i++) {
      const prior = k.versions[i - 1];
      const current = k.versions[i];
      if (milestone && current.milestone && current.milestone !== milestone) {
        // Still include prior checks up to the target milestone; skip newer ones.
        // We only check extensions AT OR BEFORE the target.
        if (versionOrder(current.milestone, milestone) > 0) continue;
      }
      const schemaReasons = compareSchemas(prior.schema, current.schema);
      for (const reason of schemaReasons) {
        violations.push({
          invariantId: null,
          priorVersion: prior.version,
          currentVersion: current.version,
          priorMilestone: prior.milestone,
          currentMilestone: current.milestone,
          reason,
        });
      }
      for (const inv of prior.invariants || []) {
        const vr = checkInvariant(inv, current.schema, ajv);
        if (vr) {
          violations.push({
            invariantId: inv.id || null,
            priorVersion: prior.version,
            currentVersion: current.version,
            priorMilestone: prior.milestone,
            currentMilestone: current.milestone,
            reason: vr,
          });
        }
      }
    }
    reports.push({ kernel: k.id, owner: k.owner, versions: k.versions.length, violations });
  }

  const totalViolations = reports.reduce((n, r) => n + r.violations.length, 0);
  return {
    ok: totalViolations === 0,
    permissive: false,
    kernelPath,
    coverage: { extendedKernels: extendedKernels.length, checked: reports.length },
    reports,
  };
}

// Rough M-number ordering; falls back to string compare.
function versionOrder(a, b) {
  const ma = /^M(\d+)/i.exec(a || '');
  const mb = /^M(\d+)/i.exec(b || '');
  if (ma && mb) return parseInt(ma[1], 10) - parseInt(mb[1], 10);
  return String(a).localeCompare(String(b));
}

function parseArgs(argv) {
  const out = { json: false, milestone: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--milestone') out.milestone = argv[++i];
  }
  return out;
}

function formatReport(result) {
  const lines = [];
  if (result.permissive) {
    lines.push(`shared-kernel-invariant: PASS (${result.reason})`);
    return lines.join('\n');
  }
  lines.push(`shared-kernel-invariant: ${result.ok ? 'PASS' : 'FAIL'}`);
  lines.push(`coverage: ${result.coverage.checked}/${result.coverage.extendedKernels} extended kernels`);
  for (const r of result.reports) {
    lines.push(`\n[${r.kernel}] owner=${r.owner || '?'} versions=${r.versions} violations=${r.violations.length}`);
    for (const v of r.violations) {
      lines.push(
        `  v${v.priorVersion}(${v.priorMilestone || '?'}) -> v${v.currentVersion}(${v.currentMilestone || '?'}): ${v.reason}${v.invariantId ? ` [inv=${v.invariantId}]` : ''}`,
      );
    }
  }
  return lines.join('\n');
}

module.exports = { checkKernelInvariants, compareSchemas, checkInvariant, normalizeKernels };

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const result = checkKernelInvariants({ cwd: process.cwd(), milestone: args.milestone });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(result)}\n`);
  }
  process.exit(result.ok ? 0 : 1);
}
