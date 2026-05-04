#!/usr/bin/env node

// CoBolt Bounded Contexts Tool (v0.12.0 — WS5; DDD enhancements added in v0.59)
//
// Operates on _cobolt-output/latest/planning/bounded-contexts.json — the
// tier between Project and Milestone for production decomposition.
//
// Commands:
//   init --single            Create a default single-context file (≤50 FRs projects)
//   init --template <N>      Scaffold N empty BCs for manual/AI authorship
//   list                     List all BCs + owner + FR/milestone counts
//   show <BC-ID>             Print one BC
//   validate                 Validate against schema + invariants
//   assign-milestone <BC> <M> Assign milestone to a BC (mutex: one milestone to one BC)
//   assign-fr <BC> <FR>      Assign FR to a BC (mutex)
//   coverage                 Report: FRs & milestones assigned vs. from rtm/milestones.md
//   owner-of <path>          Given a file path, return the BC that owns it (coherence lookup)
//   contract-exists <BC-a> <BC-b>  Check if an inter-BC interface contract exists
//   bc-for-milestone <M>     Return BC owning this milestone
//   classify-coverage        DDD: report which BCs lack subdomain classification (core/supporting/generic)
//   validate-relationships   DDD: report cross-BC contracts missing context-map relationship pattern
//   classify <BC> <kind>     DDD: set classification (core|supporting|generic) + investmentLevel
//   set-relationship <BC-a> <BC-b> <pattern>  DDD: set relationship pattern on cross-BC edge

const fs = require('node:fs');
const path = require('node:path');

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
    };
  }
}

function planningDir() {
  const p = paths();
  return typeof p.latestPlanning === 'function'
    ? p.latestPlanning()
    : path.join(process.cwd(), '_cobolt-output', 'latest', 'planning');
}

function bcPath() {
  return path.join(planningDir(), 'bounded-contexts.json');
}
function contractsPath() {
  return path.join(planningDir(), 'interface-contracts.json');
}

function loadBC() {
  if (!fs.existsSync(bcPath())) return null;
  try {
    return JSON.parse(fs.readFileSync(bcPath(), 'utf8'));
  } catch {
    return null;
  }
}

function saveBC(data) {
  fs.mkdirSync(planningDir(), { recursive: true });
  fs.writeFileSync(bcPath(), JSON.stringify(data, null, 2));
}

function loadContracts() {
  if (!fs.existsSync(contractsPath())) return { contracts: [] };
  try {
    return JSON.parse(fs.readFileSync(contractsPath(), 'utf8'));
  } catch {
    return { contracts: [] };
  }
}

// ── init ────────────────────────────────────────────────────────────

function initSingle() {
  const data = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    strategy: 'single-context',
    boundedContexts: [
      {
        id: 'BC-DEFAULT',
        name: 'Default Context',
        purpose:
          'Single bounded context — applicable for projects with ≤50 FRs where subdomain decomposition adds overhead without benefit.',
        owner: 'primary',
        classification: 'core',
        classificationRationale:
          'Single-context project — entire codebase is the differentiator by default. Re-classify if integrating commodity components (auth, payments, search) as separate BCs.',
        investmentLevel: 'high',
        frs: [],
        milestones: [],
        kernel: { valueObjects: [], domainEvents: [], invariants: [] },
        upstreamDependencies: [],
        downstreamConsumers: [],
        ownedPaths: ['**/*'],
      },
    ],
    sharedKernel: { owner: 'primary', components: [] },
  };
  saveBC(data);
  return { ok: true, path: bcPath(), bcs: 1 };
}

function initTemplate(n) {
  const count = Math.max(1, Math.min(20, parseInt(n, 10) || 3));
  const bcs = [];
  for (let i = 1; i <= count; i++) {
    bcs.push({
      id: `BC-STUB${i}`,
      name: `[rename] BC ${i}`,
      purpose: '[one-sentence reason-for-existence]',
      owner: '[team or agent]',
      frs: [],
      milestones: [],
      kernel: { valueObjects: [], domainEvents: [], invariants: [] },
      upstreamDependencies: [],
      downstreamConsumers: [],
      ownedPaths: [],
    });
  }
  const data = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    strategy: 'subdomain',
    boundedContexts: bcs,
    sharedKernel: { owner: 'primary', components: [] },
  };
  saveBC(data);
  return { ok: true, path: bcPath(), bcs: count };
}

// ── queries ─────────────────────────────────────────────────────────

function listBC() {
  const d = loadBC();
  if (!d) return { present: false };
  return {
    present: true,
    strategy: d.strategy,
    count: d.boundedContexts.length,
    contexts: d.boundedContexts.map((b) => ({
      id: b.id,
      name: b.name,
      owner: b.owner,
      frs: (b.frs || []).length,
      milestones: (b.milestones || []).length,
      upstreams: (b.upstreamDependencies || []).length,
      downstreams: (b.downstreamConsumers || []).length,
    })),
  };
}

function show(id) {
  const d = loadBC();
  if (!d) return { present: false };
  const bc = d.boundedContexts.find((b) => b.id === id);
  if (!bc) return { present: true, found: false, id };
  return { present: true, found: true, bc };
}

function bcForMilestone(m) {
  const d = loadBC();
  if (!d) return null;
  return d.boundedContexts.find((b) => (b.milestones || []).includes(m)) || null;
}

function _bcForFr(fr) {
  const d = loadBC();
  if (!d) return null;
  return d.boundedContexts.find((b) => (b.frs || []).includes(fr)) || null;
}

function ownerOfPath(filePath) {
  const d = loadBC();
  if (!d) return null;
  // Normalize — path relative to cwd with forward slashes
  const rel = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const bc of d.boundedContexts) {
    for (const pattern of bc.ownedPaths || []) {
      if (pathMatches(pattern, rel)) return { id: bc.id, pattern };
    }
  }
  // single-context fallback
  if (d.strategy === 'single-context') return { id: d.boundedContexts[0].id, pattern: '**/*' };
  return null;
}

function pathMatches(pattern, filePath) {
  // Minimal glob: ** → .*, * → [^/]*
  const re = new RegExp(
    '^' +
      pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '§DOUBLESTAR§')
        .replace(/\*/g, '[^/]*')
        .replace(/§DOUBLESTAR§/g, '.*') +
      '$',
  );
  return re.test(filePath);
}

// ── coherence ───────────────────────────────────────────────────────

function contractExistsBetween(bcA, bcB) {
  const contracts = loadContracts().contracts || [];
  return contracts.some((c) => {
    const prov = c.boundedContextProvider || null;
    const cons = c.boundedContextConsumer || null;
    if (prov && cons) {
      return (prov === bcA && cons === bcB) || (prov === bcB && cons === bcA);
    }
    // Fall back to milestone-level link
    const d = loadBC();
    if (!d) return false;
    const bcAobj = d.boundedContexts.find((b) => b.id === bcA);
    const bcBobj = d.boundedContexts.find((b) => b.id === bcB);
    if (!bcAobj || !bcBobj) return false;
    const mA = new Set(bcAobj.milestones || []);
    const mB = new Set(bcBobj.milestones || []);
    return (
      (mA.has(c.provider) && (c.consumers || []).some((m) => mB.has(m))) ||
      (mB.has(c.provider) && (c.consumers || []).some((m) => mA.has(m)))
    );
  });
}

// ── validation ──────────────────────────────────────────────────────

function validate() {
  const d = loadBC();
  if (!d) return { ok: true, skipped: true, reason: 'no bounded-contexts.json — single-context behavior assumed' };

  const issues = [];
  const seenIds = new Set();
  const seenFr = new Map();
  const seenMile = new Map();

  for (const bc of d.boundedContexts) {
    if (seenIds.has(bc.id)) issues.push(`duplicate BC id: ${bc.id}`);
    seenIds.add(bc.id);
    for (const fr of bc.frs || []) {
      if (seenFr.has(fr) && seenFr.get(fr) !== bc.id)
        issues.push(`FR ${fr} assigned to both ${seenFr.get(fr)} and ${bc.id}`);
      seenFr.set(fr, bc.id);
    }
    for (const m of bc.milestones || []) {
      if (seenMile.has(m) && seenMile.get(m) !== bc.id)
        issues.push(`milestone ${m} assigned to both ${seenMile.get(m)} and ${bc.id}`);
      seenMile.set(m, bc.id);
    }
    for (const up of bc.upstreamDependencies || []) {
      if (!d.boundedContexts.some((x) => x.id === up.bcId))
        issues.push(`${bc.id} upstream references unknown BC: ${up.bcId}`);
    }
    for (const down of bc.downstreamConsumers || []) {
      if (!d.boundedContexts.some((x) => x.id === down.bcId))
        issues.push(`${bc.id} downstream references unknown BC: ${down.bcId}`);
    }
  }
  return { ok: issues.length === 0, issues, contexts: d.boundedContexts.length };
}

// ── mutations ───────────────────────────────────────────────────────

function assignMilestone(bcId, m) {
  const d = loadBC();
  if (!d) return { ok: false, reason: 'bounded-contexts.json not initialized' };
  // Mutex — remove from any other BC first
  for (const bc of d.boundedContexts) {
    bc.milestones = (bc.milestones || []).filter((x) => x !== m);
  }
  const bc = d.boundedContexts.find((b) => b.id === bcId);
  if (!bc) return { ok: false, reason: `BC ${bcId} not found` };
  bc.milestones = [...new Set([...(bc.milestones || []), m])];
  saveBC(d);
  return { ok: true, bcId, milestone: m };
}

function assignFr(bcId, fr) {
  const d = loadBC();
  if (!d) return { ok: false, reason: 'bounded-contexts.json not initialized' };
  for (const bc of d.boundedContexts) {
    bc.frs = (bc.frs || []).filter((x) => x !== fr);
  }
  const bc = d.boundedContexts.find((b) => b.id === bcId);
  if (!bc) return { ok: false, reason: `BC ${bcId} not found` };
  bc.frs = [...new Set([...(bc.frs || []), fr])];
  saveBC(d);
  return { ok: true, bcId, fr };
}

// ── coverage ────────────────────────────────────────────────────────

function coverage() {
  const d = loadBC();
  if (!d) return { skipped: true };
  const assignedFrs = new Set(d.boundedContexts.flatMap((b) => b.frs || []));
  const assignedMile = new Set(d.boundedContexts.flatMap((b) => b.milestones || []));

  // Compare against RTM and milestones.md (best-effort)
  const rtmPath = path.join(planningDir(), 'rtm.json');
  const milestonesPath = path.join(planningDir(), 'milestones.md');
  const expectedFrs = new Set(),
    expectedMile = new Set();
  if (fs.existsSync(rtmPath)) {
    try {
      const rtm = JSON.parse(fs.readFileSync(rtmPath, 'utf8'));
      const rawEntries = rtm.requirements || rtm.entries || [];
      const entries = Array.isArray(rawEntries)
        ? rawEntries
        : rawEntries && typeof rawEntries === 'object'
          ? Object.values(rawEntries)
          : [];
      for (const e of entries) if (e.id && /^FR-\d+/.test(e.id)) expectedFrs.add(e.id);
    } catch {}
  }
  if (fs.existsSync(milestonesPath)) {
    const txt = fs.readFileSync(milestonesPath, 'utf8');
    for (const m of txt.matchAll(/\bM\d+\b/g)) expectedMile.add(m[0]);
  }

  const missingFrs = [...expectedFrs].filter((f) => !assignedFrs.has(f));
  const missingMile = [...expectedMile].filter((m) => !assignedMile.has(m));

  return {
    strategy: d.strategy,
    contexts: d.boundedContexts.length,
    assignedFrs: assignedFrs.size,
    assignedMilestones: assignedMile.size,
    expectedFrs: expectedFrs.size,
    expectedMilestones: expectedMile.size,
    missingFrs,
    missingMilestones: missingMile,
    ok: missingFrs.length === 0 && missingMile.length === 0,
  };
}

// ── DDD Strategic Design (added v0.59) ──────────────────────────────

const VALID_CLASSIFICATIONS = ['core', 'supporting', 'generic'];
const INVESTMENT_BY_CLASS = { core: 'high', supporting: 'medium', generic: 'low' };
const VALID_RELATIONSHIPS = [
  'customer-supplier',
  'conformist',
  'anticorruption-layer',
  'partnership',
  'published-language',
  'open-host-service',
  'separate-ways',
];

function classify(bcId, kind) {
  const d = loadBC();
  if (!d) return { ok: false, reason: 'bounded-contexts.json not initialized' };
  if (!VALID_CLASSIFICATIONS.includes(kind)) {
    return {
      ok: false,
      reason: `invalid classification "${kind}" — must be one of ${VALID_CLASSIFICATIONS.join('|')}`,
    };
  }
  const bc = d.boundedContexts.find((b) => b.id === bcId);
  if (!bc) return { ok: false, reason: `BC ${bcId} not found` };
  bc.classification = kind;
  bc.investmentLevel = INVESTMENT_BY_CLASS[kind];
  if (!bc.classificationRationale || bc.classificationRationale.length < 10) {
    bc.classificationRationale = `[TODO: explain why ${bc.id} is ${kind} — competitive moat / regulatory / commodity availability]`;
  }
  saveBC(d);
  return { ok: true, bcId, classification: kind, investmentLevel: bc.investmentLevel };
}

function classifyCoverage() {
  const d = loadBC();
  if (!d) return { skipped: true, reason: 'bounded-contexts.json missing' };

  const total = d.boundedContexts.length;
  const unclassified = d.boundedContexts.filter((b) => !VALID_CLASSIFICATIONS.includes(b.classification));
  const classified = d.boundedContexts.filter((b) => VALID_CLASSIFICATIONS.includes(b.classification));
  const allCore = classified.length > 0 && classified.every((b) => b.classification === 'core');
  const missingRationale = classified.filter(
    (b) => !b.classificationRationale || b.classificationRationale.startsWith('[TODO'),
  );

  // Single-context projects auto-pass — classification is a meaningful exercise only with 2+ BCs
  if (d.strategy === 'single-context' && total === 1) {
    return {
      ok: true,
      skipped: false,
      strategy: 'single-context',
      total,
      note: 'single-context project — classification not actionable',
    };
  }

  const issues = [];
  if (unclassified.length > 0) {
    issues.push({
      severity: 'error',
      kind: 'missing-classification',
      bcs: unclassified.map((b) => b.id),
      message: `${unclassified.length}/${total} BCs lack DDD subdomain classification (core|supporting|generic)`,
    });
  }
  if (allCore && total >= 3) {
    issues.push({
      severity: 'warning',
      kind: 'all-core-suspicious',
      message:
        'All BCs classified as "core" — likely classification was not done thoughtfully. Real systems have a mix; commodity capabilities (auth, observability) should be supporting or generic.',
    });
  }
  if (missingRationale.length > 0) {
    issues.push({
      severity: 'warning',
      kind: 'missing-rationale',
      bcs: missingRationale.map((b) => b.id),
      message: `${missingRationale.length} BCs have classification but no rationale (or TODO placeholder)`,
    });
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  return {
    ok: errorCount === 0,
    total,
    classified: classified.length,
    unclassified: unclassified.length,
    distribution: classified.reduce((acc, b) => {
      acc[b.classification] = (acc[b.classification] || 0) + 1;
      return acc;
    }, {}),
    issues,
  };
}

function setRelationship(bcA, bcB, pattern) {
  const d = loadBC();
  if (!d) return { ok: false, reason: 'bounded-contexts.json not initialized' };
  if (!VALID_RELATIONSHIPS.includes(pattern)) {
    return {
      ok: false,
      reason: `invalid relationship "${pattern}" — must be one of ${VALID_RELATIONSHIPS.join('|')}`,
    };
  }
  const consumer = d.boundedContexts.find((b) => b.id === bcA);
  const supplier = d.boundedContexts.find((b) => b.id === bcB);
  if (!consumer || !supplier) return { ok: false, reason: `BC ${bcA} or ${bcB} not found` };

  const upEntry = (consumer.upstreamDependencies || []).find((u) => u.bcId === bcB);
  const downEntry = (supplier.downstreamConsumers || []).find((dn) => dn.bcId === bcA);
  if (!upEntry && !downEntry) {
    return {
      ok: false,
      reason: `no edge declared between ${bcA} (consumer) and ${bcB} (supplier) — declare upstreamDependencies/downstreamConsumers first`,
    };
  }
  if (upEntry) upEntry.relationship = pattern;
  if (downEntry) downEntry.relationship = pattern;
  saveBC(d);
  return { ok: true, consumer: bcA, supplier: bcB, pattern };
}

function validateRelationships() {
  const d = loadBC();
  if (!d) return { skipped: true, reason: 'bounded-contexts.json missing' };

  // Single-context projects have no cross-BC edges by definition
  if (d.strategy === 'single-context' && d.boundedContexts.length === 1) {
    return { ok: true, strategy: 'single-context', edges: 0, note: 'no cross-BC edges in single-context project' };
  }

  const missing = [];
  const inconsistent = [];
  let edges = 0;

  for (const bc of d.boundedContexts) {
    for (const up of bc.upstreamDependencies || []) {
      edges += 1;
      if (!up.relationship) {
        missing.push({
          consumer: bc.id,
          supplier: up.bcId,
          contractId: up.contractId,
          side: 'upstream',
        });
      } else if (!VALID_RELATIONSHIPS.includes(up.relationship)) {
        inconsistent.push({
          consumer: bc.id,
          supplier: up.bcId,
          declared: up.relationship,
          message: `relationship "${up.relationship}" not in valid enum`,
        });
      }
      // Anti-corruption layer should declare translationLayer
      if (up.relationship === 'anticorruption-layer' && !up.translationLayer) {
        inconsistent.push({
          consumer: bc.id,
          supplier: up.bcId,
          declared: up.relationship,
          message:
            'anticorruption-layer relationship requires translationLayer field (path/module that owns translation)',
        });
      }

      // Cross-side consistency check — if supplier declared a relationship for this consumer, both should match
      const supplier = d.boundedContexts.find((b) => b.id === up.bcId);
      if (supplier) {
        const downEntry = (supplier.downstreamConsumers || []).find((dn) => dn.bcId === bc.id);
        if (downEntry?.relationship && up.relationship && downEntry.relationship !== up.relationship) {
          inconsistent.push({
            consumer: bc.id,
            supplier: up.bcId,
            consumerSide: up.relationship,
            supplierSide: downEntry.relationship,
            message: `consumer and supplier declared different relationship patterns — both must agree`,
          });
        }
      }
    }
  }

  return {
    ok: missing.length === 0 && inconsistent.length === 0,
    edges,
    missing,
    inconsistent,
    validPatterns: VALID_RELATIONSHIPS,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────

function parseFlags(args) {
  const out = { _: [], single: false, template: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--single') out.single = true;
    else if (args[i] === '--template') out.template = args[++i];
    else out._.push(args[i]);
  }
  return out;
}

const USAGE =
  'Usage: cobolt-bc.js {init --single|--template N|list|show <id>|validate|' +
  'assign-milestone <BC> <M>|assign-fr <BC> <FR>|coverage|owner-of <path>|' +
  'bc-for-milestone <M>|contract-exists <BCa> <BCb>|' +
  'classify <BC> <core|supporting|generic>|classify-coverage|' +
  'set-relationship <BCa> <BCb> <pattern>|validate-relationships}';

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case 'init': {
      const r = flags.single ? initSingle() : flags.template ? initTemplate(flags.template) : initSingle();
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    case 'list':
      console.log(JSON.stringify(listBC(), null, 2));
      return 0;
    case 'show':
      console.log(JSON.stringify(show(flags._[0]), null, 2));
      return 0;
    case 'validate': {
      const r = validate();
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    case 'assign-milestone': {
      const r = assignMilestone(flags._[0], flags._[1]);
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    case 'assign-fr': {
      const r = assignFr(flags._[0], flags._[1]);
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    case 'coverage': {
      const r = coverage();
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    case 'owner-of':
      console.log(JSON.stringify(ownerOfPath(flags._[0] || ''), null, 2));
      return 0;
    case 'bc-for-milestone':
      console.log(JSON.stringify(bcForMilestone(flags._[0]), null, 2));
      return 0;
    case 'contract-exists': {
      const r = { exists: contractExistsBetween(flags._[0], flags._[1]), bcA: flags._[0], bcB: flags._[1] };
      console.log(JSON.stringify(r, null, 2));
      return r.exists ? 0 : 1;
    }
    case 'classify': {
      const r = classify(flags._[0], flags._[1]);
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    case 'classify-coverage': {
      const r = classifyCoverage();
      console.log(JSON.stringify(r, null, 2));
      return r.ok || r.skipped ? 0 : 1;
    }
    case 'set-relationship': {
      const r = setRelationship(flags._[0], flags._[1], flags._[2]);
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    case 'validate-relationships': {
      const r = validateRelationships();
      console.log(JSON.stringify(r, null, 2));
      return r.ok || r.skipped ? 0 : 1;
    }
    default:
      console.error(USAGE);
      return 1;
  }
}

if (require.main === module) {
  // v0.46 — explicit --help / -h / help → exit 0 per tools/CLAUDE.md contract
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  process.exit(main());
}

module.exports = {
  loadBC,
  saveBC,
  validate,
  coverage,
  ownerOfPath,
  bcForMilestone,
  contractExistsBetween,
  pathMatches,
  classify,
  classifyCoverage,
  setRelationship,
  validateRelationships,
  VALID_CLASSIFICATIONS,
  VALID_RELATIONSHIPS,
};
