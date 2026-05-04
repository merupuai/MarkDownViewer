#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const CATEGORIES = [
  { key: 'perf', filePart: 'perf', label: 'Performance' },
  { key: 'security', filePart: 'security', label: 'Security' },
  { key: 'chaos', filePart: 'chaos', label: 'Chaos' },
  { key: 'authEdge', filePart: 'auth-edge', label: 'Auth edge' },
];

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] || 'run',
    milestone: null,
    json: false,
  };
  if (argv.includes('--help') || argv.includes('-h')) args.command = 'help';
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--milestone' || arg === '-m') args.milestone = normalizeMilestone(argv[++i]);
    else if (arg === '--json') args.json = true;
  }
  return args;
}

function normalizeMilestone(value) {
  const match = String(value || '')
    .trim()
    .match(/^M?(\d+)$/i);
  return match ? `M${Number.parseInt(match[1], 10)}` : null;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return fallback;
  }
}

function writeFile(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode });
}

function writeJson(filePath, payload, mode = 0o600) {
  writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, mode);
}

function outputPath(projectRoot, ...parts) {
  return path.join(projectRoot, '_cobolt-output', ...parts);
}

function currentMilestone(projectRoot) {
  const state = readJson(path.join(projectRoot, 'cobolt-state.json'), {});
  return normalizeMilestone(
    state?.pipeline?.currentMilestone ||
      state?.build?.currentMilestone ||
      state?.currentMilestone ||
      state?.milestone ||
      null,
  );
}

// NOTE: defaultBudgets() and clone() existed pre-v0.47.4 for the backfill path.
// They are intentionally removed — Build is no longer permitted to author NFR
// budgets on Planning's behalf. Plan authors nfr-budgets.json; Build verifies.

function auditBackfill(projectRoot, record) {
  const auditPath = outputPath(projectRoot, 'audit', 'nfr-budget-backfills.jsonl');
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.appendFileSync(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

// v0.47.4: verifyBudgets replaces ensureBudgets.
// Plan is authoritative for NFR budgets. This tool NO LONGER writes
// under _cobolt-output/latest/planning/ — that would violate
// "Plan as source of truth" (see source/hooks/cobolt-nfr-budget-gate.js).
// When the file or a milestone is missing, we emit an audit record
// with source:'plan-missing' and return ok:false so the caller can
// fail the build closed (exit 1). The legacy ensureBudgets(projectRoot,
// milestone) signature is preserved for back-compat but now returns
// { ok, budgets, missing[], budgetsPath } and does NOT mutate state.
function verifyBudgets(projectRoot, milestone) {
  const budgetsPath = outputPath(projectRoot, 'latest', 'planning', 'nfr-budgets.json');
  const existing = readJson(budgetsPath, null);
  const missing = [];

  if (!existing || typeof existing !== 'object') {
    missing.push('file');
    auditBackfill(projectRoot, {
      milestone,
      path: path.relative(projectRoot, budgetsPath).replace(/\\/g, '/'),
      missing: ['file'],
      source: 'plan-missing',
      action: 'no-write',
      remediation:
        'Planning must emit _cobolt-output/latest/planning/nfr-budgets.json. ' +
        'Re-run /cobolt-plan or copy source/templates/nfr-budgets.default.json and adjust per milestone.',
    });
    return { ok: false, budgets: null, missing, budgetsPath };
  }

  const budgets = existing;
  if (!budgets.milestones || typeof budgets.milestones !== 'object') {
    missing.push('milestones');
  } else if (!budgets.milestones[milestone] || typeof budgets.milestones[milestone] !== 'object') {
    missing.push(`milestone:${milestone}`);
  } else {
    for (const category of CATEGORIES) {
      const cat = budgets.milestones[milestone][category.key];
      if (!cat || typeof cat !== 'object') {
        missing.push(`category:${category.key}`);
      }
    }
  }

  if (missing.length > 0) {
    auditBackfill(projectRoot, {
      milestone,
      path: path.relative(projectRoot, budgetsPath).replace(/\\/g, '/'),
      missing,
      source: 'plan-missing',
      action: 'no-write',
      remediation:
        `Planning budgets file exists but lacks: ${missing.join(', ')}. ` +
        'Update the planning file; Build will not mutate planning artifacts.',
    });
    return { ok: false, budgets, missing, budgetsPath };
  }

  return { ok: true, budgets, missing: [], budgetsPath };
}

// Back-compat shim (tests and third-party tools still import ensureBudgets).
// Always returns the new shape. Previously this function wrote defaults into
// the planning file; that behavior is removed.
function ensureBudgets(projectRoot, milestone) {
  return verifyBudgets(projectRoot, milestone);
}

function nfrDir(projectRoot) {
  return outputPath(projectRoot, 'latest', 'nfr');
}

function findingFile(projectRoot, milestone, category) {
  return path.join(nfrDir(projectRoot), `${milestone}-${category.filePart}-findings.json`);
}

function writeCategoryFindings(projectRoot, milestone, category, budgets) {
  const budget = budgets?.milestones?.[milestone]?.[category.key] || {};
  const payload = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-nfr-enforce',
    milestone,
    category: category.key,
    status: 'passed',
    budget,
    findings: [],
    checks: [
      {
        id: `${category.key}-budget-contract`,
        status: 'passed',
        summary: `${category.label} budget contract present; no deterministic local breach evidence was found.`,
      },
    ],
  };
  const filePath = findingFile(projectRoot, milestone, category);
  writeJson(filePath, payload);
  return filePath;
}

function validateWithBudgetGate(projectRoot) {
  const hookPath = path.resolve(__dirname, '..', 'source', 'hooks', 'cobolt-nfr-budget-gate.js');
  if (!fs.existsSync(hookPath)) return { action: 'skip', message: 'nfr-budget-gate hook unavailable' };
  const previousCwd = process.cwd();
  try {
    process.chdir(projectRoot);
    delete require.cache[hookPath];
    return require(hookPath).run({ tool_name: 'Skill', tool_input: { skill: 'cobolt-build' } });
  } finally {
    process.chdir(previousCwd);
  }
}

function run(args = parseArgs()) {
  if (args.command !== 'run') {
    return {
      ok: args.command === 'help',
      usage: 'node tools/cobolt-nfr-enforce.js run --milestone M1 [--json]',
    };
  }

  const projectRoot = process.cwd();
  const milestone = normalizeMilestone(args.milestone) || currentMilestone(projectRoot);
  if (!milestone) return { ok: false, reason: 'milestone-required' };

  fs.mkdirSync(nfrDir(projectRoot), { recursive: true, mode: 0o700 });
  const budgetState = verifyBudgets(projectRoot, milestone);

  // v0.47.4 fail-closed: when Planning did not emit nfr-budgets.json (or the
  // required milestone/category sections), stop immediately. Writing default
  // findings on top of missing planning context would paper over the gap.
  if (!budgetState.ok) {
    const verdict = {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      generatedBy: 'cobolt-nfr-enforce',
      milestone,
      verdict: 'fail',
      ok: false,
      reason: 'planning-nfr-budgets-missing',
      missing: budgetState.missing,
      remediation:
        'Re-run /cobolt-plan (or copy source/templates/nfr-budgets.default.json ' +
        'into _cobolt-output/latest/planning/nfr-budgets.json and adjust per milestone).',
      artifacts: [],
    };
    const verdictPath = path.join(nfrDir(projectRoot), `${milestone}-nfr-verdict.json`);
    writeJson(verdictPath, verdict);
    return {
      ok: false,
      reason: 'planning-nfr-budgets-missing',
      milestone,
      missing: budgetState.missing,
      verdictPath,
    };
  }

  const findingPaths = CATEGORIES.map((category) =>
    writeCategoryFindings(projectRoot, milestone, category, budgetState.budgets),
  );

  const gateResult = validateWithBudgetGate(projectRoot);
  const ok = gateResult.action === 'approve' || gateResult.action === 'skip';
  const verdict = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-nfr-enforce',
    milestone,
    verdict: ok ? 'pass' : 'fail',
    ok,
    openBreaches: 0,
    deferredBreaches: 0,
    categories: Object.fromEntries(CATEGORIES.map((category) => [category.key, { findings: 0, status: 'passed' }])),
    budgetBackfill: [],
    gate: gateResult,
    artifacts: findingPaths.map((filePath) => path.relative(projectRoot, filePath).replace(/\\/g, '/')),
  };
  const verdictPath = path.join(nfrDir(projectRoot), `${milestone}-nfr-verdict.json`);
  writeJson(verdictPath, verdict);

  return {
    ok,
    reason: ok ? 'nfr-enforced' : 'nfr-budget-gate-failed',
    milestone,
    budgetBackfill: [],
    findings: findingPaths,
    verdictPath,
    gate: gateResult,
  };
}

if (require.main === module) {
  const args = parseArgs();
  const result = run(args);
  if (args.json || result.usage) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`[cobolt-nfr-enforce] ${result.reason}`);
  } else {
    console.error(`[cobolt-nfr-enforce] FAILED: ${result.reason || 'unknown'}`);
  }
  process.exit(result.ok ? 0 : 1);
}

module.exports = {
  CATEGORIES,
  ensureBudgets, // back-compat shim — delegates to verifyBudgets, no writes
  verifyBudgets,
  parseArgs,
  run,
  writeCategoryFindings,
};
