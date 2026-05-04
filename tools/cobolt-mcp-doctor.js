#!/usr/bin/env node

// CoBolt MCP Doctor — SF-06 closer.
//
// One-shot remediation + acknowledgement / snooze for the SessionStart
// MCP coverage banner. Pairs with:
//   tools/cobolt-mcp-audit.js        (produces _cobolt-output/audit/mcp-coverage-report.json)
//   source/hooks/cobolt-mcp-coverage-session-warn.js (consumes the ack file
//                                     to suppress the banner)
//
// Subcommands:
//   check                       Print current gap status (default if no args).
//   fix                         Print copy-paste install commands for missing
//                               plugin-MCP servers. Does NOT auto-execute —
//                               `/plugin install` and `claude mcp add` mutate
//                               user state and warrant an explicit paste.
//   ack [--reason <text>]       Record the current gap signature as
//                               acknowledged. Banner stays silent until a
//                               NEW gap appears (set is no longer a subset).
//   snooze --days <N>           Snooze the banner unconditionally for N days
//                               [--reason <text>]    (max 30). Survives gap changes.
//   reset                       Clear ack + snooze. Banner resumes.
//
// State file: <cwd>/_cobolt-output/audit/mcp-coverage-acknowledged.json
// Schema:     source/schemas/mcp-coverage-acknowledged.schema.json
//
// Exit codes (per tools/CLAUDE.md):
//   0 — subcommand ran to completion
//   1 — usage error / unknown subcommand / invalid argument
//   2 — missing optional dep   (n/a here, pure Node)
//   3 — missing infrastructure (audit cache absent and audit failed)

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ACK_REL = path.join('_cobolt-output', 'audit', 'mcp-coverage-acknowledged.json');
const REPORT_REL = path.join('_cobolt-output', 'audit', 'mcp-coverage-report.json');
const SCHEMA_VERSION = 1;
const MAX_SNOOZE_DAYS = 30;

const HELP = `cobolt-mcp-doctor — one-shot MCP coverage remediation + ack/snooze

USAGE
  node tools/cobolt-mcp-doctor.js [subcommand] [options]

SUBCOMMANDS
  check                   Print current gap status (default).
  fix                     Print copy-paste install commands for plugin-MCP gaps.
  ack [--reason <text>]   Acknowledge current gap signature; banner silent
                          until a NEW gap appears.
  snooze --days <N>       Snooze the banner for N days (max ${MAX_SNOOZE_DAYS}).
        [--reason <text>] Survives gap changes; clears at expiry.
  reset                   Clear ack + snooze; banner resumes.

EXIT CODES
  0  ran to completion
  1  usage error / unknown subcommand
  3  audit cache missing (run \`node tools/cobolt-mcp-audit.js\` first)
`;

// ── argv parsing ──────────────────────────────────────────────

function parseArgs(argv) {
  const args = { sub: null, days: null, reason: null, help: false };
  if (!argv.length) {
    args.sub = 'check';
    return args;
  }
  // First positional is subcommand (unless it's a help flag).
  let i = 0;
  if (argv[0] === '-h' || argv[0] === '--help') {
    args.help = true;
    return args;
  }
  args.sub = argv[i++];
  for (; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '-h' || raw === '--help') {
      args.help = true;
    } else if (raw === '--days') {
      const next = argv[++i];
      const n = Number(next);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        return { error: `--days requires a positive integer (got ${JSON.stringify(next)})` };
      }
      args.days = n;
    } else if (raw.startsWith('--days=')) {
      const n = Number(raw.slice('--days='.length));
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        return { error: `--days requires a positive integer (got ${JSON.stringify(raw)})` };
      }
      args.days = n;
    } else if (raw === '--reason') {
      args.reason = argv[++i] || '';
    } else if (raw.startsWith('--reason=')) {
      args.reason = raw.slice('--reason='.length);
    } else {
      return { error: `unknown argument: ${raw}` };
    }
  }
  return args;
}

// ── filesystem helpers ────────────────────────────────────────

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeAck(ackPath, ack) {
  fs.mkdirSync(path.dirname(ackPath), { recursive: true });
  fs.writeFileSync(ackPath, `${JSON.stringify(ack, null, 2)}\n`);
}

function emptyAck() {
  return {
    version: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    ackedSignature: null,
    ackedAt: null,
    ackedReason: null,
    snoozeUntil: null,
    snoozeReason: null,
  };
}

// ── gap-signature derivation ──────────────────────────────────

// Compute the canonical gap-signature list from a coverage report.
// Format: "<kind>:<server>" with kind in {project, plugin, unregistered}.
// Result is sorted + deduplicated so signatures from different runs are
// directly comparable.
function deriveSignature(report) {
  if (!report || typeof report !== 'object') return [];
  const set = new Set();

  // Plugin / project gaps from explicit gaps[] entries when present.
  if (report.gaps && typeof report.gaps === 'object') {
    if (Array.isArray(report.gaps.plugin)) {
      for (const g of report.gaps.plugin) {
        if (g && typeof g.server === 'string') set.add(`plugin:${g.server}`);
      }
    }
    if (Array.isArray(report.gaps.project)) {
      for (const g of report.gaps.project) {
        if (g && typeof g.server === 'string') set.add(`project:${g.server}`);
      }
    }
  }

  // Fallback: derive from per-agent agents[].gap[] when gaps[] absent.
  if (set.size === 0 && Array.isArray(report.agents)) {
    for (const agent of report.agents) {
      if (!Array.isArray(agent?.gap)) continue;
      for (const g of agent.gap) {
        if (!g || typeof g.server !== 'string') continue;
        const kind = g.kind === 'plugin' ? 'plugin' : g.kind === 'project' ? 'project' : null;
        if (kind) set.add(`${kind}:${g.server}`);
      }
    }
  }

  // Unregistered project-MCP servers (declared but not in any runtime config).
  if (Array.isArray(report.serversManifest)) {
    for (const s of report.serversManifest) {
      if (!s || s.kind !== 'project') continue;
      const inMcp = s.registeredInMcpJson === true;
      const inRuntime = s.registeredInRuntimeConfig === true;
      if (!inMcp && !inRuntime && typeof s.server === 'string') {
        set.add(`unregistered:${s.server}`);
      }
    }
  }

  return Array.from(set).sort();
}

// Check whether the current gap set is fully acknowledged. Subset semantics:
//   acked covers current iff every entry in current is also in acked.
function isFullyAcked(currentSignature, ackedSignature) {
  if (!Array.isArray(ackedSignature)) return false;
  const ack = new Set(ackedSignature);
  for (const entry of currentSignature) if (!ack.has(entry)) return false;
  return true;
}

function isSnoozed(ack, now = Date.now()) {
  if (!ack?.snoozeUntil) return false;
  const t = Date.parse(ack.snoozeUntil);
  return Number.isFinite(t) && t > now;
}

// ── audit cache loader ────────────────────────────────────────

function loadReport(cwd) {
  const reportPath = path.join(cwd, REPORT_REL);
  return readJson(reportPath);
}

function ensureReport(cwd, { quiet = false } = {}) {
  let report = loadReport(cwd);
  if (report) return { report, generated: false };

  // No cache — try running the audit once (best-effort).
  const auditTool = findAuditTool(cwd);
  if (!auditTool) return { report: null, generated: false };
  const reportPath = path.join(cwd, REPORT_REL);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const result = spawnSync(
    process.execPath,
    [auditTool, '--format=json', '--write-cache', '--quiet', `--output=${reportPath}`],
    { cwd, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    if (!quiet) {
      process.stderr.write(`mcp-doctor: audit refresh failed (exit ${result.status}); ${result.stderr || ''}`);
    }
    return { report: null, generated: false };
  }
  report = loadReport(cwd);
  return { report, generated: true };
}

function findAuditTool(cwd) {
  const candidates = [path.join(cwd, 'tools', 'cobolt-mcp-audit.js'), path.join(__dirname, 'cobolt-mcp-audit.js')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// ── plugin install command synthesis (fix) ────────────────────

function loadRoles() {
  try {
    return require('../lib/cobolt-mcp-roles.js');
  } catch {
    return null;
  }
}

function pluginInstallCommands(report) {
  const roles = loadRoles();
  const lines = [];
  // Production audit reports carry per-agent agents[].gap[]; tests sometimes
  // synthesize a top-level gaps.plugin[]. Accept both shapes by gathering
  // distinct plugin gap-servers from whichever surface is populated.
  const pluginServers = new Set();
  if (Array.isArray(report?.gaps?.plugin)) {
    for (const g of report.gaps.plugin) {
      if (g && typeof g.server === 'string') pluginServers.add(g.server);
    }
  }
  if (Array.isArray(report?.agents)) {
    for (const agent of report.agents) {
      if (!Array.isArray(agent?.gap)) continue;
      for (const g of agent.gap) {
        if (g && g.kind === 'plugin' && typeof g.server === 'string') pluginServers.add(g.server);
      }
    }
  }
  for (const server of pluginServers) {
    const manifest = roles?.MCP_SERVER_MANIFEST?.find?.((m) => m.server === server);
    const installName = manifest?.pluginInstallName || server;
    lines.push(`/plugin install ${installName}`);
  }

  // Unregistered project-MCP servers — use claude mcp add hint.
  const manifest = report?.serversManifest;
  if (Array.isArray(manifest)) {
    for (const s of manifest) {
      if (!s || s.kind !== 'project') continue;
      if (s.registeredInMcpJson === true || s.registeredInRuntimeConfig === true) continue;
      lines.push(`claude mcp add ${s.server}   # then: node bin/install.js --sync --yes`);
    }
  }

  return lines;
}

// ── subcommands ───────────────────────────────────────────────

function cmdCheck(cwd) {
  const { report } = ensureReport(cwd);
  if (!report) {
    process.stderr.write(
      'mcp-doctor: no audit cache at _cobolt-output/audit/mcp-coverage-report.json and audit refresh failed.\n' +
        '  Run: node tools/cobolt-mcp-audit.js\n',
    );
    return 3;
  }
  const sig = deriveSignature(report);
  const ack = readJson(path.join(cwd, ACK_REL));
  const project = report.summary?.projectMcpGapCount | 0;
  const plugin = report.summary?.pluginMcpGapCount | 0;
  const unregistered = sig.filter((e) => e.startsWith('unregistered:')).length;

  if (project + plugin + unregistered === 0) {
    process.stdout.write('mcp-doctor: no gaps — coverage clean.\n');
    return 0;
  }

  const lines = [];
  lines.push('mcp-doctor: current MCP coverage gaps');
  if (project > 0) lines.push(`  project-MCP gaps:        ${project}`);
  if (plugin > 0) lines.push(`  plugin-MCP gaps:         ${plugin}`);
  if (unregistered > 0) lines.push(`  unregistered (runtime):  ${unregistered}`);
  if (ack && Array.isArray(ack.ackedSignature)) {
    lines.push(
      `  ack status:              ${isFullyAcked(sig, ack.ackedSignature) ? 'covered (banner suppressed)' : 'partial — new gap detected'}`,
    );
  }
  if (ack?.snoozeUntil) {
    lines.push(`  snooze until:            ${ack.snoozeUntil}${isSnoozed(ack) ? ' (active)' : ' (expired)'}`);
  }
  lines.push('');
  lines.push('Next steps:');
  lines.push('  - Print install commands:    node tools/cobolt-mcp-doctor.js fix');
  lines.push('  - Acknowledge current gaps:  node tools/cobolt-mcp-doctor.js ack');
  lines.push(
    `  - Snooze the banner:         node tools/cobolt-mcp-doctor.js snooze --days <N>   (max ${MAX_SNOOZE_DAYS})`,
  );
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

function cmdFix(cwd) {
  const { report } = ensureReport(cwd);
  if (!report) {
    process.stderr.write(
      'mcp-doctor: no audit cache at _cobolt-output/audit/mcp-coverage-report.json. Run audit first.\n',
    );
    return 3;
  }
  const cmds = pluginInstallCommands(report);
  if (cmds.length === 0) {
    process.stdout.write('mcp-doctor: no plugin-MCP gaps — nothing to install.\n');
    return 0;
  }
  process.stdout.write('mcp-doctor: copy-paste these into your shell to remediate plugin-MCP gaps:\n\n');
  for (const c of cmds) process.stdout.write(`  ${c}\n`);
  process.stdout.write(
    '\nThese commands mutate Claude Code state, so they are NOT executed automatically.\n' +
      'After installing, re-run: node tools/cobolt-mcp-audit.js && node tools/cobolt-mcp-doctor.js check\n',
  );
  return 0;
}

function cmdAck(cwd, reason) {
  const { report } = ensureReport(cwd);
  if (!report) {
    process.stderr.write('mcp-doctor: no audit cache. Run audit first.\n');
    return 3;
  }
  const sig = deriveSignature(report);
  const ackPath = path.join(cwd, ACK_REL);
  const existing = readJson(ackPath) || emptyAck();
  const next = {
    ...existing,
    version: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    ackedSignature: sig,
    ackedAt: new Date().toISOString(),
    ackedReason: reason || null,
  };
  writeAck(ackPath, next);
  process.stdout.write(
    `mcp-doctor: acknowledged ${sig.length} gap${sig.length === 1 ? '' : 's'}; banner suppressed until a new gap appears.\n` +
      `  ${path.relative(cwd, ackPath) || ackPath}\n`,
  );
  return 0;
}

function cmdSnooze(cwd, days, reason) {
  if (!Number.isInteger(days) || days <= 0) {
    process.stderr.write('mcp-doctor: --days <N> required (positive integer).\n');
    return 1;
  }
  if (days > MAX_SNOOZE_DAYS) {
    process.stderr.write(`mcp-doctor: --days ${days} exceeds max ${MAX_SNOOZE_DAYS}.\n`);
    return 1;
  }
  const ackPath = path.join(cwd, ACK_REL);
  const existing = readJson(ackPath) || emptyAck();
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  const next = {
    ...existing,
    version: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    snoozeUntil: expiresAt,
    snoozeReason: reason || null,
  };
  writeAck(ackPath, next);
  process.stdout.write(`mcp-doctor: snoozed for ${days} day${days === 1 ? '' : 's'} — until ${expiresAt}.\n`);
  return 0;
}

function cmdReset(cwd) {
  const ackPath = path.join(cwd, ACK_REL);
  if (!fs.existsSync(ackPath)) {
    process.stdout.write('mcp-doctor: no ack file to clear.\n');
    return 0;
  }
  const cleared = {
    ...emptyAck(),
    updatedAt: new Date().toISOString(),
  };
  writeAck(ackPath, cleared);
  process.stdout.write('mcp-doctor: ack + snooze cleared; banner will resume on next session.\n');
  return 0;
}

// ── main ──────────────────────────────────────────────────────

function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const args = parseArgs(argv);
  if (args.error) {
    process.stderr.write(`mcp-doctor: ${args.error}\n\n${HELP}`);
    return 1;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  switch (args.sub) {
    case 'check':
      return cmdCheck(cwd);
    case 'fix':
      return cmdFix(cwd);
    case 'ack':
      return cmdAck(cwd, args.reason);
    case 'snooze':
      return cmdSnooze(cwd, args.days, args.reason);
    case 'reset':
      return cmdReset(cwd);
    default:
      process.stderr.write(`mcp-doctor: unknown subcommand "${args.sub}"\n\n${HELP}`);
      return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  main,
  parseArgs,
  deriveSignature,
  isFullyAcked,
  isSnoozed,
  ACK_REL,
  REPORT_REL,
  MAX_SNOOZE_DAYS,
  SCHEMA_VERSION,
};
