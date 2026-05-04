#!/usr/bin/env node

// CoBolt Harness-Only Detector (v0.42.0).
//
// Rejects null-domain implementations: every integration declared in
// selected-stack-contract.json must be touched by shipping code, not only by
// test harness / fixtures / mocks. The seed dictionary is
// source/schemas/domain-primitives.json; projects can extend or override via
// _cobolt-output/latest/planning/domain-primitives.json.
//
// Algorithm (census — not sampling):
//   1. Load stack contract. For every entry in integrations[]:
//      - Treat integration.type as a domain-primitives category id.
//      - Union importSymbols (contract-declared) with
//        domain-primitives.categories[type].requiredAnyOf[*].libraries +
//        .symbols. This is the "signal set" — any match counts as wired.
//   2. Enumerate shipping files from frontend.requiredFolders +
//      backend.requiredFolders (recursively, filtering noisy paths).
//   3. Enumerate harness files: tests/**, __tests__/**, **/*.test.*,
//      **/*.spec.*, fixtures/**, mocks/**, harness/**.
//   4. For every integration, record match counts in shipping vs. harness.
//      Emit a finding when shippingMatches === 0:
//        - totalMatches === 0  → integration-unwired
//        - totalMatches > 0    → integration-harness-only
//
// Exit codes: 0 no harness-only findings, 1 at least one, 3 missing infra
// (missing stack contract when --strict). v0.42 has no optional deps so exit
// 2 is not produced by this tool.
//
// Master kill switch: COBOLT_V12_GATES=bypass.
// Per-gate bypass:    COBOLT_HARNESS_ONLY_GATE=0  (audit-logged).

const fs = require('node:fs');
const path = require('node:path');
const shippingFiles = require('../lib/cobolt-shipping-files');
const { logDecision } = require('../lib/cobolt-gate-audit');

// ---------- args ----------

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] && !argv[0].startsWith('-') ? argv[0] : 'check',
    root: process.cwd(),
    milestone: null,
    json: false,
    write: true,
    strict: false,
  };
  const start = args.command === argv[0] ? 1 : 0;
  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' || arg === '--dir') args.root = argv[++i] || args.root;
    else if (arg.startsWith('--root=')) args.root = arg.slice('--root='.length);
    else if (arg.startsWith('--dir=')) args.root = arg.slice('--dir='.length);
    else if (arg === '--milestone' || arg === '-m') args.milestone = normalizeMilestone(argv[++i]);
    else if (arg.startsWith('--milestone=')) args.milestone = normalizeMilestone(arg.slice('--milestone='.length));
    else if (arg === '--json') args.json = true;
    else if (arg === '--no-write') args.write = false;
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--help' || arg === '-h') args.command = 'help';
  }
  return args;
}

function normalizeMilestone(value) {
  const match = String(value || '')
    .trim()
    .match(/^M?(\d+)$/i);
  return match ? `M${Number.parseInt(match[1], 10)}` : null;
}

// ---------- disk ----------

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  } catch {
    return '';
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(readText(filePath));
  } catch {
    return null;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

// Shipping-tree enumeration lives in lib/cobolt-shipping-files.js so the
// harness-only gate and the source-write-provenance gate never drift on what
// counts as "shipping" vs "harness". Re-exports preserved for back-compat.
const { walkFiles, isHarnessPath } = shippingFiles;

// ---------- signal set ----------

function loadPrimitives(root, distSchemasDir) {
  const projectOverride = readJson(path.join(root, '_cobolt-output', 'latest', 'planning', 'domain-primitives.json'));
  if (projectOverride?.categories) return { source: 'project-override', value: projectOverride };
  const seedCandidates = [
    distSchemasDir ? path.join(distSchemasDir, 'domain-primitives.json') : null,
    path.resolve(__dirname, '..', 'source', 'schemas', 'domain-primitives.json'),
    path.resolve(__dirname, '..', 'schemas', 'domain-primitives.json'),
    path.resolve(root, 'source', 'schemas', 'domain-primitives.json'),
  ].filter(Boolean);
  for (const candidate of seedCandidates) {
    const seed = readJson(candidate);
    if (seed?.categories) return { source: `seed:${path.relative(root, candidate).replace(/\\/g, '/')}`, value: seed };
  }
  return { source: 'absent', value: null };
}

function buildSignalSet(integration, primitives) {
  const libraries = new Set();
  const symbols = new Set();
  for (const sym of integration.importSymbols || []) {
    const s = String(sym).trim();
    if (!s) continue;
    // Heuristic: dotted/slashed specifiers are library-like; bare identifiers are symbol-like.
    if (/[./]/.test(s) || /^@[\w.-]+\/[\w.-]+$/.test(s)) libraries.add(s);
    else symbols.add(s);
  }
  const category = primitives?.categories?.[integration.type];
  if (category && Array.isArray(category.requiredAnyOf)) {
    for (const clause of category.requiredAnyOf) {
      for (const lib of clause.libraries || []) libraries.add(String(lib));
      for (const sym of clause.symbols || []) symbols.add(String(sym));
    }
  }
  return {
    libraries: [...libraries],
    symbols: [...symbols],
  };
}

// ---------- scan ----------

// B3 — languages that conventionally case-fold identifiers between source
// and contract declarations. Elixir modules are CamelCase in source but a
// contract authored from the JS/NPM lens may say "bcrypt" when the Elixir
// side imports `Bcrypt`. Ruby has similar folding for constants. Other
// languages keep case-sensitive semantics.
const CASE_INSENSITIVE_EXTS = new Set(['.ex', '.exs', '.rb']);

function scanFile(file, signals) {
  const text = readText(file.abs);
  if (!text) return { matches: 0, hitLibraries: [], hitSymbols: [] };
  const fileExt = path.extname(file.abs).toLowerCase();
  const caseInsensitive = CASE_INSENSITIVE_EXTS.has(fileExt);
  const regexFlags = caseInsensitive ? 'i' : '';
  const haystack = caseInsensitive ? text.toLowerCase() : text;
  const hitLibraries = signals.libraries.filter((lib) => {
    const needle = caseInsensitive ? String(lib).toLowerCase() : String(lib);
    return haystack.includes(needle);
  });
  const hitSymbols = signals.symbols.filter((sym) => {
    const re = new RegExp(`\\b${String(sym).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, regexFlags);
    return re.test(text);
  });
  return {
    matches: hitLibraries.length + hitSymbols.length,
    hitLibraries,
    hitSymbols,
  };
}

function scanTree(files, signals) {
  const shipping = [];
  const harness = [];
  for (const file of files) {
    const bucket = isHarnessPath(file.rel) ? harness : shipping;
    const result = scanFile(file, signals);
    if (result.matches > 0) {
      bucket.push({ path: file.rel, ...result });
    }
  }
  return { shipping, harness };
}

// ---------- evaluate ----------

function evaluate({ projectRoot, milestone, strict, primitivesOverride, distSchemasDir }) {
  const resolvedRoot = path.resolve(projectRoot || process.cwd());
  const planningDir = path.join(resolvedRoot, '_cobolt-output', 'latest', 'planning');
  const stack = readJson(path.join(planningDir, 'selected-stack-contract.json'));
  const findings = [];
  const errors = [];

  if (!stack) {
    errors.push({
      id: 'stack-contract-missing',
      severity: 'critical',
      message: 'selected-stack-contract.json not found — harness-only detector has no integrations to enforce.',
      remediation: 'Run /cobolt-plan so milestone-architect emits selected-stack-contract.json.',
    });
    return {
      generatedAt: new Date().toISOString(),
      generatedBy: 'cobolt-harness-only-detector',
      projectRoot: resolvedRoot,
      milestone,
      passed: false,
      missingInfra: strict,
      errors,
      findings,
      integrations: [],
    };
  }

  const integrations = Array.isArray(stack.integrations) ? stack.integrations : [];
  if (integrations.length === 0) {
    findings.push('contract declares zero integrations — nothing to enforce (legal for pure-UI projects)');
    return {
      generatedAt: new Date().toISOString(),
      generatedBy: 'cobolt-harness-only-detector',
      projectRoot: resolvedRoot,
      milestone,
      passed: true,
      errors,
      findings,
      integrations: [],
    };
  }

  const primitives = primitivesOverride
    ? { source: 'explicit-override', value: primitivesOverride }
    : loadPrimitives(resolvedRoot, distSchemasDir);
  findings.push(`domain-primitives source: ${primitives.source}`);

  const scanRoots = new Set();
  for (const folder of stack.frontend?.requiredFolders || []) scanRoots.add(folder);
  for (const folder of stack.backend?.requiredFolders || []) scanRoots.add(folder);
  if (scanRoots.size === 0) scanRoots.add('');
  findings.push(`scan roots: ${[...scanRoots].join(', ') || '<project root>'}`);

  const allFiles = [];
  for (const root of scanRoots) allFiles.push(...walkFiles(resolvedRoot, root));
  findings.push(`shipping source files scanned: ${allFiles.length}`);

  const perIntegration = [];
  for (const integration of integrations) {
    const signals = buildSignalSet(integration, primitives.value);
    if (signals.libraries.length === 0 && signals.symbols.length === 0) {
      perIntegration.push({
        integrationId: integration.id,
        type: integration.type,
        status: 'no-signals-available',
        reason: `integration "${integration.id}" (type=${integration.type}) has no importSymbols and no matching domain-primitives category; cannot infer wiring.`,
        signals,
        shipping: [],
        harness: [],
      });
      errors.push({
        id: `integration-no-signals-${integration.id}`,
        severity: 'high',
        message: `integration "${integration.id}" (type=${integration.type}) declared no importSymbols and domain-primitives has no entry for "${integration.type}"`,
        remediation:
          'Either add importSymbols to the contract (preferred) OR extend _cobolt-output/latest/planning/domain-primitives.json with a category matching this integration type.',
      });
      continue;
    }
    const { shipping, harness } = scanTree(allFiles, signals);
    let status;
    let severity;
    if (shipping.length === 0 && harness.length === 0) {
      status = 'unwired';
      severity = 'critical';
    } else if (shipping.length === 0) {
      status = 'harness-only';
      severity = 'critical';
    } else {
      status = 'wired';
      severity = null;
    }
    perIntegration.push({
      integrationId: integration.id,
      type: integration.type,
      library: integration.library,
      signals,
      shipping,
      harness,
      status,
    });
    if (status !== 'wired') {
      errors.push({
        id: `integration-${status}-${integration.id}`,
        severity,
        message:
          status === 'unwired'
            ? `integration "${integration.id}" (type=${integration.type}) has zero references in the shipping tree or test harness — the stack contract claims it, but nothing imports it.`
            : `integration "${integration.id}" (type=${integration.type}) is referenced ONLY by test harness files (${harness.length} match(es)) with no shipping-code references — this is a null-domain implementation.`,
        remediation:
          status === 'unwired'
            ? 'Import and use the declared library/symbols in the shipping tree, OR remove the integration from the contract if it was declared prematurely.'
            : 'Move the integration call site out of tests/ / __tests__/ / fixtures/ / mocks/ / harness/ and into the shipping tree (frontend.requiredFolders or backend.requiredFolders). If the integration is genuinely test-only, it should NOT appear in selected-stack-contract.integrations[].',
        signalSummary: {
          libraries: signals.libraries,
          symbols: signals.symbols,
        },
      });
    }
  }

  const passed = errors.filter((e) => e.severity === 'critical').length === 0;

  return {
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-harness-only-detector',
    projectRoot: resolvedRoot,
    milestone,
    primitivesSource: primitives.source,
    passed,
    integrations: perIntegration,
    errors,
    findings,
  };
}

// ---------- write reports ----------

function writeReports(result, args) {
  const latestDir = path.join(result.projectRoot, '_cobolt-output', 'latest');
  const reportPath = path.join(latestDir, 'quality', 'harness-only-report.json');
  writeJson(reportPath, result);
  const reports = [reportPath];
  if (args.milestone) {
    const milestonePath = path.join(latestDir, 'build', args.milestone, `${args.milestone}-harness-only-report.json`);
    writeJson(milestonePath, result);
    reports.push(milestonePath);
  }
  return reports;
}

// ---------- entrypoint ----------

function run(args = parseArgs()) {
  const v12 = String(process.env.COBOLT_V12_GATES || '').toLowerCase();
  if (v12 === 'bypass' || v12 === 'off') {
    logDecision(args.root || process.cwd(), {
      gate: 'cobolt-harness-only-detector',
      decision: 'bypass',
      env: 'COBOLT_V12_GATES',
    });
    return {
      ok: true,
      bypassed: 'COBOLT_V12_GATES',
      reason: 'master-bypass',
      passed: true,
      errors: [],
      findings: ['master bypass active — harness-only check skipped'],
    };
  }
  if (process.env.COBOLT_HARNESS_ONLY_GATE === '0') {
    logDecision(args.root || process.cwd(), {
      gate: 'cobolt-harness-only-detector',
      decision: 'bypass',
      env: 'COBOLT_HARNESS_ONLY_GATE',
    });
    return {
      ok: true,
      bypassed: 'COBOLT_HARNESS_ONLY_GATE',
      reason: 'per-gate-bypass',
      passed: true,
      errors: [],
      findings: ['per-gate bypass active — harness-only check skipped'],
    };
  }
  if (args.command === 'help') {
    return {
      ok: true,
      usage:
        'node tools/cobolt-harness-only-detector.js check [--root <project>] [--milestone M1] [--strict] [--json] [--no-write]',
    };
  }
  if (args.command !== 'check') {
    return { ok: false, reason: 'unknown-command', command: args.command };
  }
  const result = evaluate({ projectRoot: args.root, milestone: args.milestone, strict: args.strict });
  const reportPaths = args.write ? writeReports(result, args) : [];
  return {
    ok: result.passed,
    reason: result.passed ? 'no-harness-only' : 'harness-only-findings',
    reportPaths,
    ...result,
  };
}

if (require.main === module) {
  const args = parseArgs();
  const result = run(args);
  if (args.json || result.usage) console.log(JSON.stringify(result, null, 2));
  else if (!result.ok) console.error(`${result.reason}: ${(result.errors || []).map((e) => e.id).join(', ')}`);
  let exit = 0;
  if (!result.ok) {
    if (result.missingInfra) exit = 3;
    else exit = 1;
  }
  process.exit(exit);
}

module.exports = {
  CASE_INSENSITIVE_EXTS,
  buildSignalSet,
  evaluate,
  isHarnessPath,
  loadPrimitives,
  parseArgs,
  run,
  scanFile,
  scanTree,
  walkFiles,
};
