#!/usr/bin/env node

// CoBolt Stack Conformance (v0.42.0 — contract-driven, framework-agnostic).
//
// Reads _cobolt-output/latest/planning/selected-stack-contract.json and
// verifies that what was declared at plan-close is what actually exists on
// disk. No framework allowlist — the contract is the only source of truth.
//
// Checks:
//   1. contract-present
//   2. frontend.entrypoint exists on disk with content
//   3. backend.entrypoint  exists on disk with content
//   4. every frontend.requiredFolders entry exists AND is non-empty
//   5. every backend.requiredFolders  entry exists AND is non-empty
//   6. testCommands.unit and testCommands.integration are non-empty strings
//   7. framework identifier (case-insensitive) appears in its declared
//      entrypoint file — a soft consistency signal, never an allowlist
//   8. v0.41 carryover detectors (contract-agnostic, still relevant):
//        - scaffold-only-output
//        - generated-runtime-server-scope-narrow
//        - root-test-script-milestone-scoped
//
// Pre-v0.41 projects without a contract:
//   - Emit `stack-contract-absent` at severity "high" (warn, not block).
//   - Skip checks 2-7 but keep the carryover detectors.
//
// Exit codes: 0 passed, 1 issues present. This tool is read-only with no
// optional deps and no external infra, so exit 2 and 3 are not produced.
//
// Master kill switch: COBOLT_V12_GATES=bypass.
// Per-gate bypass:    COBOLT_STACK_CONFORMANCE_GATE=0  (audit-logged).

const fs = require('node:fs');
const path = require('node:path');
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

// ---------- disk helpers ----------

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

function fileExists(root, relPath) {
  if (!relPath) return false;
  return fs.existsSync(path.join(root, relPath));
}

function fileHasContent(root, relPath, minBytes = 1) {
  if (!fileExists(root, relPath)) return false;
  try {
    const stat = fs.statSync(path.join(root, relPath));
    return stat.isFile() && stat.size >= minBytes;
  } catch {
    return false;
  }
}

function folderIsNonEmpty(root, relPath) {
  const full = path.join(root, relPath);
  try {
    const stat = fs.statSync(full);
    if (!stat.isDirectory()) return false;
    const entries = fs.readdirSync(full);
    return entries.length > 0;
  } catch {
    return false;
  }
}

function findFiles(root, predicate, options = {}) {
  const results = [];
  const max = options.max || 500;
  const ignore = new Set(['.git', 'node_modules', '.venv', 'venv', '_cobolt-output', 'dist', 'build', '.next']);
  function walk(dir) {
    if (results.length >= max) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= max) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignore.has(entry.name)) walk(full);
      } else if (predicate(full)) {
        results.push(full);
      }
    }
  }
  walk(root);
  return results;
}

// ---------- issue helpers ----------

function issue(id, severity, message, remediation) {
  return { id, severity, message, remediation };
}

// ---------- contract-driven checks ----------

function checkContractShape(contract, issues) {
  const required = ['frontend', 'backend', 'integrations', 'testCommands', 'reachability', 'projectId'];
  for (const field of required) {
    if (!(field in contract)) {
      issues.push(
        issue(
          `contract-missing-${field}`,
          'critical',
          `selected-stack-contract.json is missing required field "${field}"`,
          'Regenerate the contract via milestone-architect (cobolt-plan Phase 4.9) — do NOT hand-edit.',
        ),
      );
    }
  }
}

function checkEntrypoint(root, tier, contract, issues) {
  const section = contract[tier];
  if (!section || typeof section !== 'object') return;
  const entrypoint = section.entrypoint;
  if (!entrypoint) {
    issues.push(
      issue(
        `${tier}-entrypoint-undeclared`,
        'critical',
        `selected-stack-contract.${tier}.entrypoint is missing`,
        `Set ${tier}.entrypoint to the project-root-relative path of the shipping ${tier} entrypoint.`,
      ),
    );
    return;
  }
  if (!fileHasContent(root, entrypoint, 1)) {
    issues.push(
      issue(
        `${tier}-entrypoint-missing`,
        'critical',
        `${tier}.entrypoint "${entrypoint}" declared in the contract does not exist on disk or is empty`,
        `Create the shipping ${tier} entrypoint at ${entrypoint} with real framework-level boot code — generated feature slices are not a substitute.`,
      ),
    );
    return;
  }
  const framework = section.framework;
  if (framework) {
    const text = readText(path.join(root, entrypoint));
    if (!frameworkAppearsInImports(framework, text)) {
      issues.push(
        issue(
          `${tier}-framework-keyword-absent`,
          'high',
          `${tier}.framework "${framework}" does not appear in an import/require specifier inside the declared entrypoint ${entrypoint}`,
          `Verify the entrypoint reflects the declared framework, OR update ${tier}.framework in selected-stack-contract.json to match the actual shipping code. CoBolt does not maintain a framework allowlist — this check validates internal contract↔code consistency only by scanning import specifiers (not comments or arbitrary string matches).`,
        ),
      );
    }
  }
}

// B2 — tighter framework keyword check. Looks for the declared framework
// identifier inside an import-or-require statement rather than anywhere in
// the file. A comment like `// no react here` or a string literal like
// `console.log("go home")` no longer produces false positives. Every pattern
// below requires a keyword-introducer (import/from/require/use) — the earlier
// unanchored `['"]X['"]` pattern was dropped in v0.43 review to avoid
// matching unrelated string literals. Language-agnostic.
function frameworkAppearsInImports(framework, text) {
  if (!framework || !text) return false;
  const escaped = String(framework).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Every pattern anchors on an import-introducer keyword (import/from/require/use/@Use).
  // Bare quoted-string matching was removed in the v0.43 review because short
  // framework names like `go`, `next`, `express`, `rails` would false-positive
  // against unrelated string literals (e.g. `res.send("express delivery")`).
  const patterns = [
    new RegExp(`\\bimport\\s+[^;\n]*\\b${escaped}\\b`, 'i'), // Python / JS / Go / Rust `import X`
    new RegExp(`\\bfrom\\s+[^;\n]*\\b${escaped}\\b`, 'i'), // Python `from X import`
    new RegExp(`\\brequire\\s*\\(\\s*['"][^'"]*\\b${escaped}\\b`, 'i'), // JS `require('x')`
    new RegExp(`\\buse\\s+[^;\n]*\\b${escaped}\\b`, 'i'), // Rust / Elixir / PHP `use X`
    new RegExp(`@Use\\w*\\(\\s*['"][^'"]*\\b${escaped}\\b`, 'i'), // NestJS-style decorators
    new RegExp(`\\bimport\\s+[^;\n]*"[^"]*\\b${escaped}\\b[^"]*"`, 'i'), // Go `import "x"` (single-line)
  ];
  return patterns.some((p) => p.test(text));
}

function checkRequiredFolders(root, tier, contract, issues) {
  const section = contract[tier];
  const folders = section?.requiredFolders;
  if (!Array.isArray(folders) || folders.length === 0) {
    issues.push(
      issue(
        `${tier}-required-folders-empty`,
        'high',
        `${tier}.requiredFolders is empty in the contract — nothing to enforce`,
        `Declare at least one required folder for ${tier} in selected-stack-contract.json.`,
      ),
    );
    return;
  }
  for (const folder of folders) {
    if (!folderIsNonEmpty(root, folder)) {
      issues.push(
        issue(
          `${tier}-required-folder-missing`,
          'critical',
          `${tier} requiredFolder "${folder}" missing or empty on disk`,
          `Create the folder and populate it with shipping code per the contract.`,
        ),
      );
    }
  }
}

function checkTestCommands(contract, issues) {
  const t = contract.testCommands;
  if (!t || typeof t !== 'object') {
    issues.push(
      issue(
        'test-commands-missing',
        'critical',
        'testCommands is missing from selected-stack-contract.json',
        'Declare testCommands.unit and testCommands.integration so build validation has authoritative commands.',
      ),
    );
    return;
  }
  for (const name of ['unit', 'integration']) {
    if (!t[name] || typeof t[name].cmd !== 'string' || !t[name].cmd.trim()) {
      issues.push(
        issue(
          `test-command-${name}-undeclared`,
          'high',
          `testCommands.${name}.cmd is missing or empty`,
          `Declare testCommands.${name}.cmd with the shell command the build pipeline must run.`,
        ),
      );
    }
  }
}

// ---------- carryover detectors (contract-agnostic, v0.41) ----------

function collectCarryoverSignals(root) {
  const rootPkg = readJson(path.join(root, 'package.json'));
  const rootScripts = rootPkg?.scripts || {};
  const generatedRuntimeFiles = findFiles(
    root,
    (filePath) => /[\\/]app[\\/]features[\\/]m\d+-runtime\.cjs$/i.test(filePath),
    { max: 100 },
  );
  const generatedFeatureFiles = findFiles(
    root,
    (filePath) => /[\\/](app|src)[\\/]features[\\/]/i.test(filePath) && /\.(?:ts|tsx|js|py|cjs)$/i.test(filePath),
    { max: 200 },
  );
  const runtimeServerScripts = findFiles(
    root,
    (filePath) =>
      /[\\/]scripts[\\/].+\.(?:cjs|mjs|js)$/i.test(filePath) && /serve|server|runtime/i.test(path.basename(filePath)),
    { max: 50 },
  ).map((filePath) => ({
    path: path.relative(root, filePath).replace(/\\/g, '/'),
    text: readText(filePath),
  }));
  return {
    rootScripts,
    generatedRuntimeCount: generatedRuntimeFiles.length,
    generatedFeatureFileCount: generatedFeatureFiles.length,
    runtimeServerScripts: runtimeServerScripts.map((s) => s.path),
    runtimeServerUsesDynamicMilestoneLoad: runtimeServerScripts.some((s) =>
      /readdirSync\s*\([^)]*features|glob|m\\d\+|m\d\+-runtime|\^m\\d\+|\\d\+-runtime/.test(s.text),
    ),
    runtimeServerSingleMilestoneRequires: runtimeServerScripts.flatMap((s) => {
      const matches = [...s.text.matchAll(/\bm([1-9]\d*)-runtime\.cjs\b/giu)].map((m) => `M${m[1]}`);
      return [...new Set(matches)].map((milestone) => ({ script: s.path, milestone }));
    }),
  };
}

function runCarryoverDetectors(signals, contractPresent, issues, contractContext = {}) {
  if (signals.generatedRuntimeCount > 1 && /tests?[\\/]+m\d+\b/i.test(String(signals.rootScripts.test || ''))) {
    issues.push(
      issue(
        'root-test-script-milestone-scoped',
        'high',
        'Multiple generated milestone runtimes exist, but the root test script is scoped to a single milestone test directory.',
        'Run all milestone tests from the root quality gate, or make the milestone scope explicit only inside per-milestone build steps.',
      ),
    );
  }
  if (
    signals.generatedRuntimeCount > 1 &&
    signals.runtimeServerSingleMilestoneRequires.length > 0 &&
    !signals.runtimeServerUsesDynamicMilestoneLoad
  ) {
    issues.push(
      issue(
        'generated-runtime-server-scope-narrow',
        'critical',
        'Multiple generated milestone runtimes exist, but the application runtime server appears to import only specific milestone runtime files.',
        'Load/register all generated milestone runtimes or prove each generated story route is mounted through the application listener.',
      ),
    );
  }
  // Scaffold-only fires whenever generated feature slices exist AND the
  // declared shipping stack is effectively absent on disk — whether the
  // contract is missing entirely (v0.42) OR present-but-entrypoints-missing
  // (v0.43 B1 closer). Without this, a project with a valid contract but
  // zero real boot code reports `frontend-entrypoint-missing` +
  // `backend-entrypoint-missing` without the canonical false-completion
  // signal builders search for.
  const entrypointsAbsent =
    contractPresent === true &&
    (contractContext.frontendEntrypointMissing === true || contractContext.backendEntrypointMissing === true);
  if (
    (contractPresent === false || entrypointsAbsent) &&
    signals.generatedRuntimeCount > 0 &&
    signals.generatedFeatureFileCount > 0
  ) {
    issues.push(
      issue(
        'scaffold-only-output',
        'critical',
        entrypointsAbsent
          ? 'Build output contains generated feature/runtime slices and the contract declares shipping entrypoints that do not exist on disk. This is a false completion pattern.'
          : 'Build output contains generated feature/runtime slices but lacks a declared shipping stack (no selected-stack-contract.json). This is a false completion pattern.',
        'Block milestone completion until milestone-architect emits a selected-stack-contract.json whose entrypoints actually exist on disk.',
      ),
    );
  }
}

// ---------- evaluate ----------

function evaluate(root, options = {}) {
  const projectRoot = path.resolve(root || process.cwd());
  const strict = options.strict === true;
  const contractPath = path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'selected-stack-contract.json');
  const contract = readJson(contractPath);
  const contractPresent = contract != null;
  const issues = [];
  const findings = [];

  findings.push(`contract present: ${contractPresent}`);
  if (contractPresent) {
    findings.push(`contract projectId: ${contract.projectId || '<absent>'}`);
    findings.push(`contract frontend.framework: ${contract.frontend?.framework || '<absent>'}`);
    findings.push(`contract backend.framework: ${contract.backend?.framework || '<absent>'}`);
    findings.push(`reachability.mode: ${contract.reachability?.mode || '<absent>'}`);
    checkContractShape(contract, issues);
    checkEntrypoint(projectRoot, 'frontend', contract, issues);
    checkEntrypoint(projectRoot, 'backend', contract, issues);
    checkRequiredFolders(projectRoot, 'frontend', contract, issues);
    checkRequiredFolders(projectRoot, 'backend', contract, issues);
    checkTestCommands(contract, issues);
  } else {
    // --strict elevates the otherwise-advisory contract-absent signal to a
    // blocking critical, matching the semantics of the other v0.42 tools
    // (contract-reachability, harness-only-detector, source-write-provenance)
    // whose --strict flag forces missing-infra to fail closed.
    issues.push(
      issue(
        'stack-contract-absent',
        strict ? 'critical' : 'high',
        'selected-stack-contract.json not found — stack conformance cannot enforce declared surfaces against shipping code.',
        'Run /cobolt-plan (or resume) so milestone-architect emits selected-stack-contract.json at _cobolt-output/latest/planning/ per Phase 4.9.',
      ),
    );
  }

  const signals = collectCarryoverSignals(projectRoot);
  const carryoverContext = {
    frontendEntrypointMissing:
      contractPresent === true &&
      !!contract.frontend?.entrypoint &&
      !fileHasContent(projectRoot, contract.frontend.entrypoint, 1),
    backendEntrypointMissing:
      contractPresent === true &&
      !!contract.backend?.entrypoint &&
      !fileHasContent(projectRoot, contract.backend.entrypoint, 1),
  };
  runCarryoverDetectors(signals, contractPresent, issues, carryoverContext);

  findings.push(
    `carryover signals: generatedRuntime=${signals.generatedRuntimeCount}, generatedFeatureFiles=${signals.generatedFeatureFileCount}, runtimeServerScripts=${signals.runtimeServerScripts.length}`,
  );

  return {
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-stack-conformance',
    projectRoot,
    contractPresent,
    contractPath: path.relative(projectRoot, contractPath).replace(/\\/g, '/'),
    contractSummary: contractPresent
      ? {
          projectId: contract.projectId,
          frontend: {
            framework: contract.frontend?.framework,
            entrypoint: contract.frontend?.entrypoint,
            requiredFolders: contract.frontend?.requiredFolders || [],
          },
          backend: {
            language: contract.backend?.language,
            framework: contract.backend?.framework,
            entrypoint: contract.backend?.entrypoint,
            requiredFolders: contract.backend?.requiredFolders || [],
          },
          reachabilityMode: contract.reachability?.mode,
          integrationsCount: Array.isArray(contract.integrations) ? contract.integrations.length : 0,
        }
      : null,
    passed: issues.filter((it) => it.severity === 'critical').length === 0,
    findings,
    issues,
    carryoverSignals: signals,
  };
}

// ---------- write reports ----------

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeReports(result, args) {
  const latestDir = path.join(result.projectRoot, '_cobolt-output', 'latest');
  const reportPath = path.join(latestDir, 'quality', 'stack-conformance.json');
  writeJson(reportPath, result);
  const reports = [reportPath];
  if (args.milestone) {
    const milestonePath = path.join(latestDir, 'build', args.milestone, `${args.milestone}-stack-conformance.json`);
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
      gate: 'cobolt-stack-conformance',
      decision: 'bypass',
      env: 'COBOLT_V12_GATES',
    });
    return {
      ok: true,
      bypassed: 'COBOLT_V12_GATES',
      reason: 'master-bypass',
      passed: true,
      issues: [],
      findings: ['master bypass active — stack conformance skipped'],
    };
  }
  if (process.env.COBOLT_STACK_CONFORMANCE_GATE === '0') {
    logDecision(args.root || process.cwd(), {
      gate: 'cobolt-stack-conformance',
      decision: 'bypass',
      env: 'COBOLT_STACK_CONFORMANCE_GATE',
    });
    return {
      ok: true,
      bypassed: 'COBOLT_STACK_CONFORMANCE_GATE',
      reason: 'per-gate-bypass',
      passed: true,
      issues: [],
      findings: ['per-gate bypass active — stack conformance skipped'],
    };
  }
  if (args.command === 'help') {
    return {
      ok: true,
      usage: 'node tools/cobolt-stack-conformance.js check [--root <project>] [--milestone M1] [--json] [--no-write]',
    };
  }
  if (args.command !== 'check') {
    return { ok: false, reason: 'unknown-command', command: args.command };
  }
  const result = evaluate(args.root, { strict: args.strict });
  const reportPaths = args.write ? writeReports(result, args) : [];
  return {
    ok: result.passed,
    reason: result.passed ? 'stack-conformant' : 'stack-conformance-failed',
    reportPaths,
    ...result,
  };
}

if (require.main === module) {
  const args = parseArgs();
  const result = run(args);
  if (args.json || result.usage) console.log(JSON.stringify(result, null, 2));
  else if (!result.ok) console.error(`${result.reason}: ${result.issues.map((i) => i.id).join(', ')}`);
  process.exit(result.ok ? 0 : 1);
}

module.exports = {
  checkContractShape,
  checkEntrypoint,
  checkRequiredFolders,
  checkTestCommands,
  collectCarryoverSignals,
  evaluate,
  frameworkAppearsInImports,
  parseArgs,
  run,
  runCarryoverDetectors,
};
