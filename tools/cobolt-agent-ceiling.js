#!/usr/bin/env node

// CoBolt Agent Ceiling — Tier 1 gate that caps source/agents/ growth.
//
// Why this exists (PF-04 in docs/COBOLT-ENHANCEMENT-PLAN.md):
//   208 agents today; ~1/week growth puts us past 300 within a year. Each
//   agent loads into runtime manifests and adds dispatch + search noise.
//   This gate enforces a hard ceiling so future-CoBolt's session-load cost
//   stays bounded.
//
// Exit codes follow tools/CLAUDE.md contract:
//   0 — count <= ceiling (PASS)
//   1 — count > ceiling (hard FAIL — Tier 1 semantics)
//
// Configuration:
//   - ceiling read from package.json `cobolt.agentCeiling` (default: 150)
//   - bypass via `COBOLT_AGENT_CEILING_GATE=off` (logged to audit ledger)
//
// Usage:
//   node tools/cobolt-agent-ceiling.js          # check, exit 0/1
//   node tools/cobolt-agent-ceiling.js --check  # alias of default
//   node tools/cobolt-agent-ceiling.js --json   # machine-readable verdict

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'source', 'agents');
const PACKAGE_JSON = path.join(ROOT, 'package.json');
const DEFAULT_CEILING = 150;
const ENV_BYPASS = 'COBOLT_AGENT_CEILING_GATE';

function loadCeiling() {
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
    const v = pkg?.cobolt?.agentCeiling;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  } catch {
    /* fall through */
  }
  return DEFAULT_CEILING;
}

function countAgentFiles(rootDir = AGENTS_DIR) {
  if (!fs.existsSync(rootDir)) return { count: 0, files: [] };
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      if (entry.name === 'CLAUDE.md') continue;
      if (entry.name.startsWith('.')) continue;
      files.push(path.relative(ROOT, full).replace(/\\/g, '/'));
    }
  };
  walk(rootDir);
  return { count: files.length, files };
}

function checkCeiling({ rootDir = AGENTS_DIR, ceiling } = {}) {
  const limit = typeof ceiling === 'number' ? ceiling : loadCeiling();
  const { count, files } = countAgentFiles(rootDir);
  const ok = count <= limit;
  return {
    ok,
    count,
    ceiling: limit,
    over: ok ? 0 : count - limit,
    files: ok ? [] : files.slice(-Math.min(files.length, count - limit + 5)),
  };
}

function appendBypassLog(verdict) {
  // Lightweight audit trail (deliberately not the GT-01 signed ledger — that's
  // for runtime gates fired during pipelines; this gate runs in CI/check-docs).
  try {
    const auditDir = path.join(ROOT, '_cobolt-output', 'audit');
    if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(auditDir, 'agent-ceiling-bypass.jsonl'),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        pid: process.pid,
        env: process.env[ENV_BYPASS],
        ...verdict,
      })}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* best-effort */
  }
}

function isBypassed() {
  // Minimal env-var bypass that logs to the audit ledger. Per the GT-01
  // deprecation window, this still works but emits a deprecation banner.
  const v = process.env[ENV_BYPASS];
  return v === 'off' || v === '0' || v === 'false';
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { json: false, help: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--check') {
      /* default behavior */
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: node tools/cobolt-agent-ceiling.js [--check] [--json] [--help]

Enforces the hard ceiling on source/agents/*.md (PF-04).

Exit codes (per tools/CLAUDE.md):
  0 — count <= ceiling
  1 — count > ceiling

Configuration:
  package.json cobolt.agentCeiling (default ${DEFAULT_CEILING})
  ${ENV_BYPASS}=off — bypass with audit-log entry (deprecated)

Examples:
  node tools/cobolt-agent-ceiling.js
  node tools/cobolt-agent-ceiling.js --json
`);
}

if (require.main === module) {
  let opts;
  try {
    opts = parseArgs();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const verdict = checkCeiling();

  if (isBypassed()) {
    appendBypassLog(verdict);
    if (!opts.json) {
      console.warn(
        `[cobolt-agent-ceiling] BYPASSED via ${ENV_BYPASS}=${process.env[ENV_BYPASS]} ` +
          `(count=${verdict.count}, ceiling=${verdict.ceiling}). Logged to audit/agent-ceiling-bypass.jsonl.`,
      );
    }
    if (opts.json) console.log(JSON.stringify({ ...verdict, bypassed: true }, null, 2));
    process.exit(0);
  }

  if (opts.json) {
    console.log(JSON.stringify(verdict, null, 2));
  } else if (verdict.ok) {
    console.log(
      `[cobolt-agent-ceiling] OK — ${verdict.count} agents (ceiling ${verdict.ceiling}, ` +
        `headroom ${verdict.ceiling - verdict.count}).`,
    );
  } else {
    console.error(
      `[cobolt-agent-ceiling] FAIL — ${verdict.count} agents exceeds ceiling ${verdict.ceiling} ` +
        `by ${verdict.over}. AD-04 dedup required before adding more.\n` +
        `Configure ceiling: package.json cobolt.agentCeiling.\n` +
        `Bypass (audit-logged, deprecated): ${ENV_BYPASS}=off`,
    );
    if (verdict.files.length) {
      console.error(`Recent over-ceiling agents:`);
      for (const f of verdict.files) console.error(`  ${f}`);
    }
  }
  process.exit(verdict.ok ? 0 : 1);
}

module.exports = {
  checkCeiling,
  countAgentFiles,
  loadCeiling,
  DEFAULT_CEILING,
  ENV_BYPASS,
};
