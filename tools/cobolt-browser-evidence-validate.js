#!/usr/bin/env node

// CoBolt Browser Evidence Validator
//
// Deterministic on-disk verification that Playwright + Chrome DevTools MCP
// browser tests were actually executed for a milestone/phase. Called by
// cobolt-browser-evidence-gate.js (Tier 1 PreToolUse) before skill boundaries
// (review, fix, deploy, milestone-validate, audit, dream).
//
// Checks:
//   1. UI-project detection (non-UI projects short-circuit with valid=true).
//   2. Required artifacts exist and parse as JSON.
//   3. Semantic thresholds: executedTests > 0, screenshots.length > 0,
//      passed === true, status not in {failed, skipped-*, degraded, no-report}.
//   4. Freshness: artifact mtime >= newest mtime under UI source dirs.
//   5. MCP call ledger census: >=1 playwright browser_navigate entry AND
//      (if CDT evidence claims available) >=1 chrome-devtools entry.
//
// Exit codes:
//   0 — evidence valid for the requested phase
//   1 — evidence missing, stale, or incomplete (hook must block)
//   2 — tool usage error (treated as block by fail-closed hook)
//
// Usage:
//   node tools/cobolt-browser-evidence-validate.js \
//     --milestone M1 --phase {build|review|fix|deploy|validate|audit|dream} \
//     [--iteration N] [--json] [--verbose]

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CWD = process.cwd();
const UI_SOURCE_DIRS = ['src', 'app/lib', 'app/assets', 'web', 'frontend', 'client', 'components', 'pages'];
const UI_EXTENSIONS = new Set(['.tsx', '.jsx', '.vue', '.svelte', '.html', '.heex', '.leex', '.css', '.scss', '.less']);
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '_cobolt-output',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  'tmp',
  'deps',
  '_build',
  '.turbo',
  '.cache',
]);

// Max MCP ledger age acceptable (ms). 24h accommodates long agent-team builds,
// brownfield pipelines, and cross-session resumes. Anti-bypass defense below
// enforces a tighter temporal window BETWEEN ledger entries and evidence file
// mtimes (evidence must be emitted within 1h of a matching ledger entry).
const MCP_LEDGER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Evidence must be emitted close in time to its proving ledger entry.
// Defeats the "touch evidence + append fake ledger row" bypass.
const LEDGER_EVIDENCE_MAX_SKEW_MS = 60 * 60 * 1000;

function parseArgs(argv) {
  const args = { phase: 'build', json: false, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--milestone' || a === '-m') args.milestone = argv[++i];
    else if (a === '--phase' || a === '-p') args.phase = argv[++i];
    else if (a === '--iteration' || a === '-i') args.iteration = Number(argv[++i]);
    else if (a === '--json') args.json = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function mtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function detectUI() {
  // Try the canonical tool; fall back to signal-based detection.
  const envTools = process.env.COBOLT_TOOLS;
  const toolCandidates = [
    envTools && path.join(envTools, 'cobolt-ui-detection.js'),
    path.join(CWD, 'tools', 'cobolt-ui-detection.js'),
    path.join(__dirname, 'cobolt-ui-detection.js'),
  ].filter(Boolean);
  const tool = toolCandidates.find((p) => fs.existsSync(p));

  if (tool) {
    try {
      const out = execFileSync('node', [tool, '--json'], { cwd: CWD, stdio: 'pipe', timeout: 10000 }).toString();
      const parsed = JSON.parse(out);
      return { hasUI: parsed.hasUI === true, signals: parsed.signals || [] };
    } catch {
      /* fall through */
    }
  }

  // Fallback: any .tsx/.jsx/.vue/.svelte/.heex file counts.
  const signals = [];
  try {
    const pkg = path.join(CWD, 'package.json');
    if (fs.existsSync(pkg)) {
      const p = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      const deps = { ...(p.dependencies || {}), ...(p.devDependencies || {}) };
      if (deps.react || deps.vue || deps.svelte || deps.next || deps.nuxt) signals.push('frontend-dep');
    }
    if (
      fs.existsSync(path.join(CWD, 'playwright.config.js')) ||
      fs.existsSync(path.join(CWD, 'playwright.config.ts'))
    ) {
      signals.push('playwright-config');
    }
  } catch {
    /* noop */
  }
  return { hasUI: signals.length > 0, signals };
}

function newestUISourceMtime() {
  let newest = 0;
  function walk(dir, depth = 0) {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (EXCLUDED_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      if (!UI_EXTENSIONS.has(ext)) continue;
      try {
        const m = fs.statSync(full).mtimeMs;
        if (m > newest) newest = m;
      } catch {
        /* noop */
      }
    }
  }
  for (const rel of UI_SOURCE_DIRS) {
    const full = path.join(CWD, rel);
    if (fs.existsSync(full)) walk(full);
  }
  return newest;
}

function loadMcpLedger() {
  const candidates = [
    path.join(CWD, '_cobolt-output', 'latest', 'uat', 'mcp-call-ledger.jsonl'),
    path.join(CWD, '_cobolt-output', 'latest', 'build', 'mcp-call-ledger.jsonl'),
    path.join(CWD, '_cobolt-output', 'latest', 'mcp-call-ledger.jsonl'),
    path.join(CWD, '_cobolt-output', 'audit', 'mcp-call-ledger.jsonl'),
  ];
  const entries = [];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {
          /* skip malformed */
        }
      }
    } catch {
      /* noop */
    }
  }
  return entries;
}

function mcpLedgerEntries(entries, needleRegex, minAgeCutoffMs) {
  return entries.filter((e) => {
    const tool = String(e.toolName || e.tool || e.name || '');
    const family = String(e.family || '');
    if (!needleRegex.test(tool) && !needleRegex.test(family)) return false;
    const ts = Date.parse(e.timestamp || e.ts || 0) || 0;
    return ts >= minAgeCutoffMs;
  });
}

function mcpLedgerHas(entries, needleRegex, minAgeCutoffMs) {
  return mcpLedgerEntries(entries, needleRegex, minAgeCutoffMs).length > 0;
}

// Ledger entries prove real MCP invocation. Evidence file mtime must be within
// LEDGER_EVIDENCE_MAX_SKEW_MS of the most recent matching entry — otherwise
// the evidence was written independently (e.g. hand-crafted JSON + stale ledger).
function hasTemporallyProximateLedgerEntry(entries, needleRegex, evidenceMtimeMs, cutoffMs) {
  const matched = mcpLedgerEntries(entries, needleRegex, cutoffMs);
  if (!matched.length || !evidenceMtimeMs) return false;
  return matched.some((e) => {
    const ts = Date.parse(e.timestamp || e.ts || 0) || 0;
    return Math.abs(ts - evidenceMtimeMs) <= LEDGER_EVIDENCE_MAX_SKEW_MS;
  });
}

// Schema aliases — defend against field-name drift across upstream tools.
function pickStatus(obj) {
  return obj?.status ?? obj?.verdict ?? obj?.result ?? obj?.state ?? null;
}
function pickPassed(obj) {
  if (obj == null) return null;
  const candidates = [obj.passed, obj.passing, obj.ok, obj.success];
  const hit = candidates.find((v) => typeof v === 'boolean');
  return hit === undefined ? null : hit;
}
function pickScreenshots(obj) {
  const pools = [
    obj?.screenshots,
    obj?.visualEvidence?.screenshots,
    obj?.screenshotArtifacts,
    obj?.artifacts?.screenshots,
  ];
  for (const p of pools) if (Array.isArray(p)) return p;
  return [];
}
function pickExecutedTests(obj) {
  const candidates = [obj?.executedTests, obj?.ranTests, obj?.testsRun, obj?.total];
  return Number(candidates.find((v) => typeof v === 'number') ?? 0);
}

// ── Evidence sources keyed by phase ───────────────────────────────────────

function buildEvidencePaths(milestone) {
  const buildDir = path.join(CWD, '_cobolt-output', 'latest', 'build', milestone);
  const playwrightDir = path.join(CWD, '_cobolt-output', `${milestone}-playwright-results`);
  const uatDir = path.join(CWD, '_cobolt-output', 'latest', 'uat');
  return {
    wiringLive: path.join(buildDir, `${milestone}-wiring-live-test.json`),
    browserDeep: path.join(buildDir, `${milestone}-browser-deep-test.json`),
    validationResults: path.join(buildDir, `${milestone}-validation-results.json`),
    browserSmoke: path.join(CWD, '_cobolt-output', 'latest', 'build', 'browser-smoke.json'),
    runSummary: path.join(playwrightDir, 'run-summary.json'),
    uiVisualEvidence: path.join(uatDir, 'ui-visual-evidence.json'),
    chromeDevtoolsEvidence: path.join(uatDir, 'chrome-devtools-evidence.json'),
  };
}

function fixEvidencePaths(_milestone, iteration) {
  const iter = Number.isFinite(iteration) ? iteration : 1;
  return {
    browserVerification: path.join(CWD, '_cobolt-output', 'latest', 'fix', `browser-verification-iter-${iter}.json`),
    smokeScreenshot: path.join(CWD, '_cobolt-output', 'latest', 'fix', `smoke-iteration-${iter}.png`),
  };
}

function statusBad(status) {
  const s = String(status || '')
    .toLowerCase()
    .trim();
  if (!s) return true;
  return ['failed', 'error', 'no-report', 'degraded', 'unknown'].includes(s) || s.startsWith('skipped-');
}

// ── Validators per phase ──────────────────────────────────────────────────

function validateBuildEvidence(milestone, _options) {
  const errors = [];
  const warnings = [];
  const paths = buildEvidencePaths(milestone);
  const codeMtime = newestUISourceMtime();

  // 1. Build Step 04A outputs (wiring-live-test + browser-deep-test)
  const wiring = readJson(paths.wiringLive);
  if (!wiring) {
    errors.push(`Missing build Step 04A wiring-live-test at ${path.relative(CWD, paths.wiringLive)}`);
  } else if (statusBad(pickStatus(wiring))) {
    errors.push(`Wiring-live-test status is "${pickStatus(wiring)}" — expected passed/verified`);
  }

  const browserDeep = readJson(paths.browserDeep);
  if (!browserDeep) {
    errors.push(`Missing build Step 04A browser-deep-test at ${path.relative(CWD, paths.browserDeep)}`);
  } else {
    if (statusBad(pickStatus(browserDeep))) {
      errors.push(`Browser-deep-test status is "${pickStatus(browserDeep)}" — expected passed/verified`);
    }
    if (pickPassed(browserDeep) === false) {
      errors.push(`Browser-deep-test reports passed:false`);
    }
  }

  // 2. Build Step 07 Layer 4 validation
  const validation = readJson(paths.validationResults);
  if (!validation) {
    errors.push(`Missing validation-results: ${path.relative(CWD, paths.validationResults)}`);
  } else {
    const l4 = validation?.layers?.L4_playwright_ui?.status;
    if (!['pass', 'passed', 'resolved'].includes(String(l4 || '').toLowerCase())) {
      errors.push(`L4_playwright_ui status is "${l4}" — expected passed/resolved`);
    }
  }

  // 3. Playwright run-summary with real test count
  const runSummary = readJson(paths.runSummary);
  if (!runSummary) {
    errors.push(`Missing Playwright run-summary at ${path.relative(CWD, paths.runSummary)}`);
  } else if (pickExecutedTests(runSummary) <= 0) {
    errors.push(`Playwright run-summary reports executedTests=${pickExecutedTests(runSummary)}`);
  }

  // 4. UI visual evidence with screenshots — cross-validate paths exist on disk.
  const uiVisual = readJson(paths.uiVisualEvidence);
  let diskScreenshots = [];
  if (!uiVisual) {
    errors.push(`Missing ui-visual-evidence at ${path.relative(CWD, paths.uiVisualEvidence)}`);
  } else {
    const shots = pickScreenshots(uiVisual);
    if (shots.length === 0) {
      errors.push(`ui-visual-evidence has no screenshot entries`);
    } else {
      // Cross-validate: every referenced screenshot path must exist on disk.
      diskScreenshots = shots.map((s) => (typeof s === 'string' ? s : s?.path)).filter(Boolean);
      const missing = diskScreenshots.filter((rel) => {
        const full = path.isAbsolute(rel) ? rel : path.join(CWD, rel);
        return !fs.existsSync(full);
      });
      if (missing.length > 0) {
        errors.push(
          `ui-visual-evidence references ${missing.length} screenshot(s) not on disk: ${missing.slice(0, 3).join(', ')}`,
        );
      }
    }
    if (pickPassed(uiVisual) === false || uiVisual.runtimeCheck?.passed === false) {
      errors.push(`ui-visual-evidence reports passed:false`);
    }
  }

  // 5. Chrome DevTools evidence — required when MCP available
  const cdt = readJson(paths.chromeDevtoolsEvidence);
  if (!cdt) {
    errors.push(`Missing chrome-devtools-evidence: ${path.relative(CWD, paths.chromeDevtoolsEvidence)}`);
  } else if (cdt.available === true) {
    if (cdt.passed !== true) errors.push(`chrome-devtools-evidence reports passed:${cdt.passed}`);
    if (cdt.status && !['verified', 'passed', 'pass'].includes(String(cdt.status).toLowerCase())) {
      errors.push(`chrome-devtools-evidence status "${cdt.status}" — expected verified/passed`);
    }
  } else {
    warnings.push(`Chrome DevTools MCP not available — skipped CDT verification`);
  }

  // 6. Freshness: all evidence must post-date newest UI source file
  if (codeMtime > 0) {
    for (const key of ['wiringLive', 'browserDeep', 'runSummary', 'uiVisualEvidence']) {
      const p = paths[key];
      if (!fs.existsSync(p)) continue;
      const m = mtimeMs(p);
      if (m < codeMtime) {
        errors.push(
          `STALE: ${path.relative(CWD, p)} mtime predates newest UI source file (delta ${Math.round((codeMtime - m) / 1000)}s)`,
        );
      }
    }
  }

  // 7. MCP call ledger census + temporal proximity to evidence file mtimes.
  // Proves real MCP invocation AND that evidence was emitted as part of the
  // same run (not hand-crafted JSON over a stale ledger).
  const ledger = loadMcpLedger();
  const cutoff = Date.now() - MCP_LEDGER_MAX_AGE_MS;
  const pwRegex = /playwright.*(browser_navigate|browser_snapshot|browser_take_screenshot)/i;

  if (!mcpLedgerHas(ledger, pwRegex, cutoff)) {
    errors.push(`MCP call ledger lacks recent Playwright browser_navigate/snapshot/screenshot entry (24h window)`);
  } else {
    // Temporal proximity: ui-visual-evidence mtime must align with a ledger entry.
    const uiMtime = mtimeMs(paths.uiVisualEvidence);
    if (uiMtime && !hasTemporallyProximateLedgerEntry(ledger, pwRegex, uiMtime, cutoff)) {
      errors.push(
        `ui-visual-evidence mtime not within 1h of any Playwright ledger entry — ` +
          `evidence file was likely written independently of real MCP execution (bypass defense)`,
      );
    }
  }

  if (cdt?.available === true) {
    const cdtRegex = /chrome-devtools/i;
    if (!mcpLedgerHas(ledger, cdtRegex, cutoff)) {
      errors.push(`MCP call ledger lacks recent chrome-devtools entry (evidence claims CDT available)`);
    } else {
      const cdtMtime = mtimeMs(paths.chromeDevtoolsEvidence);
      if (cdtMtime && !hasTemporallyProximateLedgerEntry(ledger, cdtRegex, cdtMtime, cutoff)) {
        errors.push(`chrome-devtools-evidence mtime not within 1h of any CDT ledger entry (bypass defense)`);
      }
    }
  }

  return { errors, warnings, paths };
}

function validateFixEvidence(milestone, iteration) {
  const errors = [];
  const warnings = [];
  const paths = fixEvidencePaths(milestone, iteration);
  const codeMtime = newestUISourceMtime();

  const verif = readJson(paths.browserVerification);
  if (!verif) {
    errors.push(`Missing fix browser-verification at ${path.relative(CWD, paths.browserVerification)}`);
  } else {
    if (pickPassed(verif) !== true) {
      errors.push(`browser-verification reports passed:${pickPassed(verif)}`);
    }
    const shotCount = Number(verif.screenshotsCaptured ?? 0) || pickScreenshots(verif).length;
    if (shotCount <= 0) {
      errors.push(`browser-verification captured no screenshots`);
    }
    const consoleErrorCount = Array.isArray(verif.consoleErrors)
      ? verif.consoleErrors.length
      : Number(verif.consoleErrors ?? 0);
    if (consoleErrorCount > 0) {
      errors.push(`browser-verification reports ${consoleErrorCount} console error(s)`);
    }
    const networkFailCount = Array.isArray(verif.networkFailures)
      ? verif.networkFailures.length
      : Number(verif.networkFailures ?? 0);
    if (networkFailCount > 0) {
      errors.push(`browser-verification reports ${networkFailCount} network failure(s)`);
    }
  }

  // Screenshot file must exist and be fresh
  if (fs.existsSync(paths.smokeScreenshot)) {
    const m = mtimeMs(paths.smokeScreenshot);
    if (codeMtime > 0 && m < codeMtime) {
      errors.push(`STALE: ${path.relative(CWD, paths.smokeScreenshot)} predates code changes`);
    }
  } else {
    warnings.push(`No smoke screenshot captured for iteration ${iteration}`);
  }

  // MCP ledger census + temporal proximity to evidence mtime for fix window.
  const ledger = loadMcpLedger();
  const cutoff = Date.now() - MCP_LEDGER_MAX_AGE_MS;
  const pwRegex = /playwright.*browser_(navigate|snapshot|take_screenshot|console|network)/i;
  if (!mcpLedgerHas(ledger, pwRegex, cutoff)) {
    errors.push(`MCP call ledger lacks Playwright entry for fix iteration ${iteration} (24h window)`);
  } else {
    const verifMtime = mtimeMs(paths.browserVerification);
    if (verifMtime && !hasTemporallyProximateLedgerEntry(ledger, pwRegex, verifMtime, cutoff)) {
      errors.push(
        `browser-verification-iter-${iteration}.json mtime not within 1h of any Playwright ledger entry ` +
          `— evidence was likely synthesized, not produced by real MCP execution`,
      );
    }
  }

  return { errors, warnings, paths };
}

// ── Entry point ───────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);

  if (args.help || !args.milestone) {
    process.stderr.write(
      'Usage: cobolt-browser-evidence-validate.js --milestone M1 ' +
        '--phase {build|review|fix|deploy|validate|audit|dream} [--iteration N] [--json]\n',
    );
    process.exit(args.help ? 0 : 2);
  }

  const ui = detectUI();
  if (!ui.hasUI) {
    const result = { valid: true, reason: 'non-ui-project', signals: ui.signals };
    if (args.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stdout.write('OK: non-UI project — browser evidence not required\n');
    process.exit(0);
  }

  let result;
  if (args.phase === 'fix') {
    const out = validateFixEvidence(args.milestone, args.iteration || 1);
    result = {
      valid: out.errors.length === 0,
      phase: 'fix',
      milestone: args.milestone,
      iteration: args.iteration || 1,
      errors: out.errors,
      warnings: out.warnings,
    };
  } else {
    // All non-fix phases share the build evidence contract (review/deploy/validate/audit/dream)
    const out = validateBuildEvidence(args.milestone, args);
    result = {
      valid: out.errors.length === 0,
      phase: args.phase,
      milestone: args.milestone,
      errors: out.errors,
      warnings: out.warnings,
    };
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.valid) {
    process.stdout.write(`OK: browser evidence valid for ${args.milestone} (phase=${args.phase})\n`);
    if (args.verbose && result.warnings?.length) {
      for (const w of result.warnings) process.stdout.write(`  WARN: ${w}\n`);
    }
  } else {
    process.stderr.write(`FAIL: browser evidence invalid for ${args.milestone} (phase=${args.phase})\n`);
    for (const e of result.errors) process.stderr.write(`  - ${e}\n`);
  }

  process.exit(result.valid ? 0 : 1);
}

if (require.main === module) main();
module.exports = { validateBuildEvidence, validateFixEvidence, detectUI };
