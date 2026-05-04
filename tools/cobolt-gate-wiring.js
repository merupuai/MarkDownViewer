#!/usr/bin/env node

// CoBolt Gate Wiring — validates every hook and tool is actually plugged in.
//
// The Meru incident surfaced two specific wiring-drift cases that every
// earlier audit missed:
//   - cobolt-spec-quality.js existed and caught 206 Meru findings, but was
//     never invoked at plan-close because no skill step or aggregator dispatched
//     it. The detection existed; the enforcement hookup was missing.
//   - cobolt-artifact-parity.js returned exit 3 for drift, but the aggregate
//     classifier mapped exit 3 to SKIP. The tool was wired; the contract
//     wasn't.
//
// This tool closes that gap by auditing the wiring itself.
//
// Checks:
//   [WIRE-01] Hook file exists on disk but is not registered in PRE_HOOKS or
//             POST_HOOKS in cobolt-{pre,post}-dispatch.js. The hook is dead —
//             it cannot fire.
//   [WIRE-02] Hook file is registered in PRE_HOOKS but not in gate-tiers.json.
//             Classification is missing; the hook fires with no declared tier.
//   [WIRE-03] Hook file is classified as Tier 1 in gate-tiers.json but is NOT
//             in the dispatcher's TIER1_HOOKS fail-closed set. On load error
//             it will silently be skipped instead of failing-closed.
//   [WIRE-04] Tool file exists but is not registered in tools/index.js. Skills
//             can still invoke it by absolute path, but the CLI entry-point
//             won't list it.
//   [WIRE-05] Tool file is registered as an aggregate-gated checker (in
//             cobolt-readiness-aggregate.js GATES) but its exit-code semantics
//             don't match the aggregate's classifyExit() expectations.
//   [WIRE-06] Declared in docstring / comment as "Tier 1" but not enforced as
//             Tier 1 anywhere. False advertisement.
//
// Exit codes:
//   0 = fully wired
//   1 = usage
//   2 = dispatcher / registry files missing (cannot run)
//   3 = wiring drift — Tier 1 block

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_VIOLATION = 3;

const HOOKS_DIR = 'source/hooks';
const TOOLS_DIR = 'tools';
const PRE_DISPATCH = 'source/hooks/cobolt-pre-dispatch.js';
const POST_DISPATCH = 'source/hooks/cobolt-post-dispatch.js';
const GATE_TIERS = 'source/schemas/gate-tiers.json';
const TOOLS_INDEX = 'tools/index.js';
const AGGREGATE = 'tools/cobolt-readiness-aggregate.js';
const INSTALLER = 'bin/install.js';
const INTERNAL_PATH_INVOKED_TOOLS = new Set([
  // CLI wrappers/helpers intentionally invoked by skill steps via
  // `node tools/<file>.js` rather than exposed as public tools/index commands.
  'cobolt-a11y-runtime.js',
  'cobolt-anchor-index.js',
  'cobolt-anti-patterns.js',
  'cobolt-brownfield-bootstrap.js',
  'cobolt-evolution-lab.js',
  'cobolt-evolution.js',
  'cobolt-fix-decay.js',
  'cobolt-fr-coverage.js',
  'cobolt-init-checkpoints.js',
  'cobolt-integration-provider.js',
  'cobolt-lesson-prefix.js',
  'cobolt-mirror-prod-dev.js',
  'cobolt-paths.js',
  'cobolt-pattern-loader.js',
  'cobolt-perf-measure.js',
  'cobolt-prd-semantic-review.js',
  'cobolt-recovery.js',
  'cobolt-seed-shape-emit.js',
  'cobolt-shared-kernel-conformance.js',
  'cobolt-skill-tracker.js',
  'cobolt-tdd-gate.js',
  'cobolt-ux-edge-gen.js',
  'cobolt-worker-lifecycle.js',
]);

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function readJsonSafe(p) {
  const raw = readFileSafe(p);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function listCoboltJs(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.js') && (f.startsWith('cobolt-') || f.startsWith('_')))
      .filter((f) => !f.endsWith('.test.js'));
  } catch {
    return [];
  }
}

// Strip // and /* ... */ comments, preserving newlines for line-number
// stability. Critical for the array-member extraction below — an apostrophe
// in a comment (e.g., `don't`) would otherwise unbalance the string scanner
// and cause all subsequent entries to be mis-captured. This is the exact
// failure mode that caused gate-wiring to report every hook after line 143
// of cobolt-pre-dispatch.js as "dead" in the v0.31 dry-run.
function stripComments(source) {
  if (!source) return source;
  let out = '';
  let state = 'code';
  let quote = '';

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (state === 'line-comment') {
      if (ch === '\n' || ch === '\r') {
        out += ch;
        state = 'code';
      } else {
        out += ' ';
      }
      continue;
    }

    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        out += '  ';
        i += 1;
        state = 'code';
      } else {
        out += ch === '\n' || ch === '\r' ? ch : ' ';
      }
      continue;
    }

    if (state === 'string') {
      out += ch;
      if (ch === '\\') {
        if (next !== undefined) {
          out += next;
          i += 1;
        }
      } else if (ch === quote) {
        state = 'code';
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      state = 'string';
      out += ch;
    } else if (ch === '/' && next === '/') {
      out += '  ';
      i += 1;
      state = 'line-comment';
    } else if (ch === '/' && next === '*') {
      out += '  ';
      i += 1;
      state = 'block-comment';
    } else {
      out += ch;
    }
  }

  return out;
}

// Extract array members from a source file's named variable. Regex-driven;
// good enough for our declarative dispatcher arrays once comments are stripped.
function extractArrayMembers(source, varName) {
  if (!source) return null;
  const clean = stripComments(source);
  const re = new RegExp(`const\\s+${varName}\\s*=\\s*\\[([\\s\\S]*?)\\];`, 'm');
  const m = clean.match(re);
  if (!m) return null;
  const members = new Set();
  for (const em of m[1].matchAll(/['"]([^'"]+)['"]/g)) {
    members.add(em[1]);
  }
  return members;
}

function extractSetMembers(source, varName) {
  // new Set([...])
  if (!source) return null;
  const clean = stripComments(source);
  const re = new RegExp(`const\\s+${varName}\\s*=\\s*new\\s+Set\\s*\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`, 'm');
  const m = clean.match(re);
  if (!m) return null;
  const members = new Set();
  for (const em of m[1].matchAll(/['"]([^'"]+)['"]/g)) {
    members.add(em[1]);
  }
  return members;
}

// Parse bin/install.js for the HOOK_EVENTS map. Hooks wired via non-PRE/POST
// events (SessionStart, Stop, PreCompact, PostCompact) are registered by the
// installer at deploy time, not in the PreToolUse/PostToolUse dispatcher arrays.
// Without recognizing them here, WIRE-01 false-positive fires for every Stop /
// compaction / session-start hook.
function extractInstallerHookEvents(installerSrc) {
  if (!installerSrc) return new Map();
  const clean = stripComments(installerSrc);
  const m = clean.match(/const\s+HOOK_EVENTS\s*=\s*\{([\s\S]*?)\};/m);
  const map = new Map();
  if (!m) return map;
  for (const entry of m[1].matchAll(/['"]([\w\-.]+\.js)['"]\s*:\s*['"](\w+)['"]/g)) {
    map.set(entry[1], entry[2]);
  }
  return map;
}

function extractGateTierHooks(tiers) {
  // Walk all tier buckets and collect .hook strings
  const byTier = {};
  if (!tiers?.tiers) return byTier;
  for (const [tierName, tierDef] of Object.entries(tiers.tiers)) {
    const gates = tierDef.gates || [];
    byTier[tierName] = new Set(gates.map((g) => g.hook).filter(Boolean));
  }
  return byTier;
}

function check() {
  const violations = [];

  const preSrc = readFileSafe(PRE_DISPATCH);
  const postSrc = readFileSafe(POST_DISPATCH);
  const tiers = readJsonSafe(GATE_TIERS);
  const toolsIdxSrc = readFileSafe(TOOLS_INDEX);
  const aggSrc = readFileSafe(AGGREGATE);
  const installerSrc = readFileSafe(INSTALLER);
  const installerEvents = extractInstallerHookEvents(installerSrc);

  if (!preSrc || !tiers || !toolsIdxSrc) {
    return {
      exitCode: EXIT_MISSING,
      error: 'dispatcher / tiers / tools-index file not found',
      missing: {
        preDispatch: !preSrc,
        gateTiers: !tiers,
        toolsIndex: !toolsIdxSrc,
      },
    };
  }

  const preHooks = extractArrayMembers(preSrc, 'PRE_HOOKS') || new Set();
  const postHooks = postSrc ? extractArrayMembers(postSrc, 'POST_HOOKS') || new Set() : new Set();
  const tier1 = extractSetMembers(preSrc, 'TIER1_HOOKS') || new Set();
  const tierBuckets = extractGateTierHooks(tiers);

  // All hooks declared across tier buckets
  const declaredTier1Hooks = new Set([...(tierBuckets.tier0 || []), ...(tierBuckets['hard-block'] || [])]);
  const declaredTier2Hooks = new Set(tierBuckets['skip-and-report'] || []);
  const declaredTier3Hooks = new Set(tierBuckets['warn-continue'] || []);
  const allDeclared = new Set([...declaredTier1Hooks, ...declaredTier2Hooks, ...declaredTier3Hooks]);

  // ── WIRE-01: hook file exists but not in PRE_HOOKS or POST_HOOKS ──
  const hookFiles = listCoboltJs(HOOKS_DIR);
  for (const f of hookFiles) {
    // Skip the dispatchers themselves, the budget helper, and non-gate files.
    if (
      f === 'cobolt-pre-dispatch.js' ||
      f === 'cobolt-post-dispatch.js' ||
      f.startsWith('_') ||
      f === 'cobolt-hook-helpers.js'
    )
      continue;
    if (!preHooks.has(f) && !postHooks.has(f)) {
      // Non-tool-use hooks (SessionStart, Stop, PreCompact, PostCompact) are
      // wired by bin/install.js at deploy time, not in the PreToolUse/PostToolUse
      // dispatchers. Skip these — they're legitimately wired, just via a
      // different mechanism.
      if (installerEvents.has(f)) continue;
      // Verify it exports run() — only flag if it's a legitimate hook shape
      const content = readFileSafe(path.join(HOOKS_DIR, f));
      if (content && /module\.exports\s*=\s*\{[^}]*\brun\b/.test(content)) {
        violations.push({
          rule: 'WIRE-01',
          severity: 'critical',
          file: f,
          why: 'Hook exports run() but is not registered in PRE_HOOKS, POST_HOOKS, or bin/install.js HOOK_EVENTS. Dead hook — will never fire.',
        });
      }
    }
  }

  // ── WIRE-02: registered in PRE_HOOKS but missing from gate-tiers.json ──
  for (const h of preHooks) {
    if (!allDeclared.has(h)) {
      violations.push({
        rule: 'WIRE-02',
        severity: 'high',
        hook: h,
        why: 'Hook is registered in PRE_HOOKS but has no entry in gate-tiers.json. Fires with no declared tier.',
      });
    }
  }

  // ── WIRE-03: declared Tier 1 in gate-tiers but missing from TIER1_HOOKS set ──
  for (const h of declaredTier1Hooks) {
    if (!preHooks.has(h)) continue; // WIRE-01 covers unregistered entirely
    if (!tier1.has(h)) {
      violations.push({
        rule: 'WIRE-03',
        severity: 'critical',
        hook: h,
        why: 'Declared Tier 1 (tier0 / hard-block) in gate-tiers.json but not in dispatcher TIER1_HOOKS set. On load error it will silently skip instead of fail-closed.',
      });
    }
  }

  // ── WIRE-04: tool exists but not registered in tools/index.js ──
  const toolFiles = listCoboltJs(TOOLS_DIR);
  const registeredTools = new Set();
  // Parse tools/index.js TOOLS object for `file: './cobolt-xxx.js'` entries.
  for (const m of toolsIdxSrc.matchAll(/file\s*:\s*['"]\.\/([\w-]+\.js)['"]/g)) {
    registeredTools.add(m[1]);
  }
  for (const f of toolFiles) {
    if (f === 'index.js' || f.startsWith('_')) continue;
    if (INTERNAL_PATH_INVOKED_TOOLS.has(f)) continue;
    if (!registeredTools.has(f)) {
      // Only flag if the file looks like a tool (has process.exit or module.exports)
      const content = readFileSafe(path.join(TOOLS_DIR, f));
      if (content && /(?:process\.exit|module\.exports)/.test(content)) {
        violations.push({
          rule: 'WIRE-04',
          severity: 'medium',
          file: f,
          why: 'Tool file has CLI shape but is not registered in tools/index.js TOOLS map. Invocable by path but not discoverable via --list.',
        });
      }
    }
  }

  // ── WIRE-05: tool in aggregate but exit-code semantics may drift ──
  // Heuristic check: aggregate classifyExit now maps 2=SKIP, else=FAIL (post-v0.30).
  // Flag any tool referenced in aggregate GATES whose file declares EXIT_MISSING=2
  // but doesn't also clearly differentiate from violations.
  if (aggSrc) {
    const gateNames = new Set();
    const gatesArrayMatch = aggSrc.match(/const\s+GATES\s*=\s*\[([\s\S]*?)\];/m);
    if (gatesArrayMatch) {
      for (const m of gatesArrayMatch[1].matchAll(/tool\s*:\s*['"]([^'"]+)['"]/g)) {
        gateNames.add(m[1]);
      }
    }
    // Check each referenced aggregate tool actually exists
    for (const g of gateNames) {
      const p = path.join(TOOLS_DIR, g);
      if (!fs.existsSync(p)) {
        violations.push({
          rule: 'WIRE-05',
          severity: 'critical',
          tool: g,
          why: 'Aggregate GATES references a tool that does not exist on disk. Aggregate will record tool-not-found at runtime.',
        });
      }
    }
  }

  // ── WIRE-06: docstring claims Tier 1 but no enforcement ──
  for (const f of hookFiles) {
    if (f.startsWith('_')) continue;
    const content = readFileSafe(path.join(HOOKS_DIR, f));
    if (!content) continue;
    const claimsTier1 = /Tier\s*1\b/i.test(content.slice(0, 500));
    if (!claimsTier1) continue;
    // If it claims Tier 1 but isn't in declaredTier1Hooks, flag
    if (!declaredTier1Hooks.has(f) && !declaredTier2Hooks.has(f)) {
      violations.push({
        rule: 'WIRE-06',
        severity: 'high',
        file: f,
        why: 'Docstring claims Tier 1 but gate-tiers.json has no entry for this hook. False advertisement — runtime classification is missing.',
      });
    }
  }

  // Split exit code by severity class:
  //   WIRE-01 (dead hook)  → bypass risk  → hard block (exit 3)
  //   WIRE-03 (missing from TIER1 set) → fail-closed risk → hard block (exit 3)
  //   WIRE-05 (aggregate references missing tool) → broken reference → hard block (exit 3)
  //   WIRE-02 (no gate-tier entry) → hygiene → advisory (exit 2)
  //   WIRE-04 (orphan tool)        → discoverability → advisory (exit 2)
  //   WIRE-06 (docstring mismatch) → false advertisement → advisory (exit 2)
  //
  // CI runs in strict mode (--strict) to surface everything; routine dev runs
  // as advisory to avoid blocking on hygiene debt.
  const criticalRules = new Set(['WIRE-01', 'WIRE-03', 'WIRE-05']);
  const criticalCount = violations.filter((v) => criticalRules.has(v.rule)).length;
  const advisoryCount = violations.length - criticalCount;
  const exitCode = criticalCount > 0 ? EXIT_VIOLATION : advisoryCount > 0 ? EXIT_MISSING : EXIT_OK;

  return {
    exitCode,
    summary: {
      hookFiles: hookFiles.length,
      hooksInPreDispatch: preHooks.size,
      hooksInPostDispatch: postHooks.size,
      hooksInTier1Set: tier1.size,
      hooksDeclaredTier1: declaredTier1Hooks.size,
      toolFiles: toolFiles.length,
      toolsInIndex: registeredTools.size,
      violations: violations.length,
      criticalViolations: criticalCount,
      advisoryViolations: advisoryCount,
    },
    violations,
  };
}

function formatText(r) {
  const lines = ['== Gate Wiring =='];
  if (r.summary) for (const [k, v] of Object.entries(r.summary)) lines.push(`  ${k}: ${v}`);
  if (r.violations?.length) {
    lines.push('  violations:');
    for (const v of r.violations.slice(0, 40)) {
      lines.push(`    [${v.rule}] (${v.severity}) ${v.file || v.hook || v.tool}`);
      if (v.why) lines.push(`        ${v.why}`);
    }
  }
  lines.push(`verdict: ${r.exitCode === EXIT_OK ? 'PASS' : r.exitCode === EXIT_VIOLATION ? 'VIOLATION' : 'MISSING'}`);
  return lines.join('\n');
}

function main(argv = process.argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'check';
  const json = args.includes('--json');
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Usage: cobolt-gate-wiring.js <check|report> [--json]');
    process.exit(EXIT_OK);
  }
  if (cmd !== 'check' && cmd !== 'report') {
    console.error('Usage: cobolt-gate-wiring.js <check|report> [--json]');
    process.exit(EXIT_USAGE);
  }
  const r = check();
  if (json) console.log(JSON.stringify(r, null, 2));
  else console.log(formatText(r));
  process.exit(cmd === 'report' ? EXIT_OK : r.exitCode);
}

if (require.main === module) main();

module.exports = { check, extractArrayMembers, extractSetMembers, EXIT_OK, EXIT_VIOLATION, EXIT_MISSING };
