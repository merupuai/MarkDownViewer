#!/usr/bin/env node

// CoBolt Bypass CLI (GT-01 / v0.57+).
//
// Issues, lists, verifies, and revokes signed gate-bypass entries. Replaces
// the procurement-blocking pattern of disabling Tier 1 gates with raw env
// vars. Every grant carries a >=30-char reason, an approver list, and an
// auto-expiration; every state change is HMAC-SHA256 signed and chained so
// SOC2 / ISO 27001 auditors can verify the complete history.
//
// Subcommands:
//   grant <gateId>      --reason ... --approver email [...] --hours <n>     Tier 1+ grant (≤90d)
//   emergency           --reason ... --approver A --approver B [--hours n]   Master kill (quorum ≥2, ≤24h)
//   revoke <id>         --reason ... --approver email [...]                  Revoke a prior entry
//   list                [--gate id] [--since iso] [--active-only] [--json]   Inspect ledger
//   verify              [--strict]                                           Re-check signatures + chain
//   report              [--format json|soc2|markdown]                       Auditor-ready output
//   export-token <id>                                                       Print base64 CI envelope
//   import-token        --token <b64>                                       Import a CI envelope locally
//   gates               [--json]                                            List every registered gate
//   check <gateId>      [--quiet]                                           Exit 0 if bypassed (signed
//                                                                          ledger or master kill), 2 if
//                                                                          not bypassed, 1 on input error.
//
// Exit codes (per tools/CLAUDE.md):
//   0 — success / clean help / clean list / `check` returns "bypassed"
//   1 — input error, validation failure, verify failure, unknown gate
//   2 — `check` returns "not bypassed" (so callers can branch with `&&`/`||`)

const fs = require('node:fs');
const path = require('node:path');
const _os = require('node:os');

const ledger = require(path.resolve(__dirname, '..', 'lib', 'cobolt-bypass-ledger.js'));
const registry = require(path.resolve(__dirname, '..', 'lib', 'cobolt-gate-registry.js'));
const audit = require(path.resolve(__dirname, '..', 'lib', 'cobolt-bypass-audit.js'));

const argv = process.argv.slice(2);

// Help / no-args contract: exit 0, print usage, do nothing.
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  printUsage();
  process.exit(0);
}

const sub = argv[0];
const rest = argv.slice(1);

try {
  switch (sub) {
    case 'grant':
      cmdGrant(rest);
      break;
    case 'emergency':
      cmdEmergency(rest);
      break;
    case 'revoke':
      cmdRevoke(rest);
      break;
    case 'list':
      cmdList(rest);
      break;
    case 'verify':
      cmdVerify(rest);
      break;
    case 'report':
      cmdReport(rest);
      break;
    case 'audit':
      cmdAudit(rest);
      break;
    case 'export-token':
      cmdExportToken(rest);
      break;
    case 'import-token':
      cmdImportToken(rest);
      break;
    case 'gates':
      cmdGates(rest);
      break;
    case 'check':
      cmdCheck(rest);
      break;
    default:
      process.stderr.write(`unknown subcommand: ${sub}\n`);
      printUsage();
      process.exit(1);
  }
} catch (err) {
  process.stderr.write(`cobolt-bypass: ${err.message}\n`);
  process.exit(1);
}

// -----------------------------------------------------------------------

function flagValue(argList, name) {
  const i = argList.indexOf(name);
  if (i === -1) return undefined;
  const v = argList[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}

function flagAll(argList, name) {
  const out = [];
  for (let i = 0; i < argList.length; i++) {
    if (argList[i] === name) {
      const v = argList[i + 1];
      if (v && !v.startsWith('--')) out.push(v);
    }
  }
  return out;
}

function hasFlag(argList, name) {
  return argList.includes(name);
}

function projectRoot() {
  return process.cwd();
}

function cmdGrant(args) {
  const gateId = args[0];
  if (!gateId || gateId.startsWith('--')) {
    throw new Error(
      'grant: missing gateId. Usage: cobolt-bypass grant <gateId> --reason ... --approver email [--hours N]',
    );
  }
  const reason = flagValue(args, '--reason');
  const approvers = flagAll(args, '--approver');
  const hoursRaw = flagValue(args, '--hours');
  const until = flagValue(args, '--until');
  let durationHours;
  if (until && until !== true) {
    const ms = new Date(until).getTime() - Date.now();
    if (!Number.isFinite(ms) || ms <= 0)
      throw new Error(`grant: --until must be a future ISO-8601 timestamp; got '${until}'`);
    durationHours = ms / 3600 / 1000;
  } else if (hoursRaw && hoursRaw !== true) {
    durationHours = Number(hoursRaw);
  } else {
    throw new Error('grant: must supply either --hours <n> or --until <ISO-8601>');
  }
  const entry = ledger.grant({
    gateId,
    reason: typeof reason === 'string' ? reason : '',
    approvers,
    durationHours,
    projectRoot: projectRoot(),
  });
  if (hasFlag(args, '--json')) {
    process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
  } else {
    process.stdout.write(`Granted bypass id=${entry.id} gate=${entry.gateId} expires=${entry.expiresAt}\n`);
  }
}

function cmdEmergency(args) {
  const reason = flagValue(args, '--reason');
  const approvers = flagAll(args, '--approver');
  const hoursRaw = flagValue(args, '--hours');
  const durationHours = hoursRaw && hoursRaw !== true ? Number(hoursRaw) : registry.EMERGENCY_MAX_HOURS;
  const entry = ledger.emergency({
    reason: typeof reason === 'string' ? reason : '',
    approvers,
    durationHours,
    projectRoot: projectRoot(),
  });
  if (hasFlag(args, '--json')) {
    process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
  } else {
    process.stdout.write(
      `EMERGENCY master bypass id=${entry.id} approvers=[${entry.approvers.join(', ')}] expires=${entry.expiresAt}\n`,
    );
  }
}

function cmdRevoke(args) {
  const id = args[0];
  if (!id || id.startsWith('--')) throw new Error('revoke: missing entry id');
  const reason = flagValue(args, '--reason');
  const approvers = flagAll(args, '--approver');
  const entry = ledger.revoke({
    id,
    reason: typeof reason === 'string' ? reason : '',
    approvers,
    projectRoot: projectRoot(),
  });
  process.stdout.write(`Revoked bypass id=${entry.revokes} via revocation entry id=${entry.id}\n`);
}

function cmdList(args) {
  const gateId = flagValue(args, '--gate');
  const since = flagValue(args, '--since');
  const activeOnly = hasFlag(args, '--active-only');
  const entries = ledger.list({
    projectRoot: projectRoot(),
    gateId: typeof gateId === 'string' ? gateId : undefined,
    since: typeof since === 'string' ? interpretSince(since) : undefined,
    activeOnly,
  });
  if (hasFlag(args, '--json')) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    return;
  }
  if (entries.length === 0) {
    process.stdout.write('No bypass entries found.\n');
    return;
  }
  for (const e of entries) {
    process.stdout.write(
      `${e.grantedAt} ${e.kind.padEnd(11)} ${e.gateId.padEnd(28)} expires=${e.expiresAt} approvers=[${e.approvers.join(',')}] id=${e.id}\n`,
    );
  }
}

function interpretSince(value) {
  // Accept ISO-8601 OR shorthand like '90d', '7d', '24h'.
  const m = String(value).match(/^(\d+)\s*([dhm])$/i);
  if (m) {
    const n = Number(m[1]);
    const mult = { d: 86400, h: 3600, m: 60 }[m[2].toLowerCase()];
    return new Date(Date.now() - n * mult * 1000).toISOString();
  }
  return value;
}

function cmdVerify(_args) {
  const verdict = ledger.verify({ projectRoot: projectRoot() });
  if (verdict.ok) {
    process.stdout.write('Ledger verified: signatures + chain are intact.\n');
    process.exit(0);
  }
  for (const err of verdict.errors) {
    process.stderr.write(`verify-error: ${err.kind} line=${err.line} ${err.message}\n`);
  }
  process.exit(1);
}

function cmdReport(args) {
  const format = flagValue(args, '--format') || 'markdown';
  const entries = ledger.list({ projectRoot: projectRoot() });
  const verdict = ledger.verify({ projectRoot: projectRoot() });
  const summary = {
    totalEntries: entries.length,
    grants: entries.filter((e) => e.kind === 'grant').length,
    emergencies: entries.filter((e) => e.kind === 'emergency').length,
    autoEnv: entries.filter((e) => e.kind === 'auto-env').length,
    ciTokens: entries.filter((e) => e.kind === 'ci-token').length,
    revocations: entries.filter((e) => e.kind === 'revocation').length,
    chainOk: verdict.ok,
    chainErrors: verdict.errors,
  };
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify({ summary, entries }, null, 2)}\n`);
    return;
  }
  // Markdown / soc2
  const heading = format === 'soc2' ? 'SOC2 Bypass Audit Report' : 'CoBolt Gate Bypass Report';
  let out = '';
  out += `# ${heading}\n\n`;
  out += `Generated: ${new Date().toISOString()}\n\n`;
  out += `## Summary\n\n`;
  out += `- Total entries: ${summary.totalEntries}\n`;
  out += `- Grants: ${summary.grants}\n`;
  out += `- Emergencies (master kill, ≥2 approvers): ${summary.emergencies}\n`;
  out += `- Auto-env (deprecated env-var auto-promote): ${summary.autoEnv}\n`;
  out += `- CI token imports: ${summary.ciTokens}\n`;
  out += `- Revocations: ${summary.revocations}\n`;
  out += `- Chain integrity: ${summary.chainOk ? 'OK' : 'FAIL — see chainErrors'}\n\n`;
  if (!summary.chainOk) {
    out += `## Chain Errors\n\n`;
    for (const e of summary.chainErrors) {
      out += `- line ${e.line}: ${e.message}\n`;
    }
    out += `\n`;
  }
  out += `## Entries (most recent first)\n\n`;
  out += `| When | Kind | Gate | Approvers | Reason | Expires | Id |\n`;
  out += `| ---- | ---- | ---- | --------- | ------ | ------- | -- |\n`;
  for (const e of entries) {
    const approvers = e.approvers.join(', ');
    const reason = String(e.reason).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    out += `| ${e.grantedAt} | ${e.kind} | ${e.gateId} | ${approvers} | ${reason} | ${e.expiresAt} | ${e.id} |\n`;
  }
  process.stdout.write(out);
}

// GT-04: per-gate aggregation lens. Defaults to a 90-day rolling window
// matching the SOC2 / ISO 27001 evidence-pack horizon and writes Markdown to
// _cobolt-output/audit/gate-bypass-audit.md so the EN-06 evidence consumer
// can pick it up by stable path. Pass --out - to stdout.
function cmdAudit(args) {
  const sinceArg = flagValue(args, '--since');
  const sinceLabel = typeof sinceArg === 'string' ? sinceArg : '90d';
  const now = Date.now();
  const sinceMs = audit.resolveSinceMs(sinceLabel, now);
  if (sinceMs == null) {
    throw new Error(
      `audit: --since must be a shorthand like '90d' / '7d' / '24h' or an ISO-8601 timestamp; got '${sinceLabel}'`,
    );
  }
  const topRaw = flagValue(args, '--top-reasons');
  const topReasonsN = typeof topRaw === 'string' ? Math.max(1, Math.floor(Number(topRaw))) : 5;
  if (!Number.isFinite(topReasonsN) || topReasonsN <= 0) {
    throw new Error(`audit: --top-reasons must be a positive integer; got '${topRaw}'`);
  }
  const gateFilter = flagValue(args, '--gate');
  const root = projectRoot();
  const allEntries = ledger.list({ projectRoot: root });
  const filtered = typeof gateFilter === 'string' ? allEntries.filter((e) => e.gateId === gateFilter) : allEntries;
  const aggregate = audit.aggregateByGate({
    entries: filtered,
    now,
    sinceMs,
    topReasonsN,
  });

  if (hasFlag(args, '--json')) {
    const verdict = ledger.verify({ projectRoot: root });
    process.stdout.write(
      `${JSON.stringify(
        {
          generatedAt: new Date(now).toISOString(),
          since: sinceLabel,
          chainOk: verdict.ok,
          chainErrors: verdict.errors,
          aggregate,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const verdict = ledger.verify({ projectRoot: root });
  const md = audit.formatMarkdown({
    aggregate,
    sinceLabel,
    generatedAt: new Date(now).toISOString(),
    chainOk: verdict.ok,
    chainErrors: verdict.errors,
  });

  const outArg = flagValue(args, '--out');
  if (outArg === '-' || outArg === 'stdout') {
    process.stdout.write(md);
    return;
  }
  const outPath =
    typeof outArg === 'string'
      ? path.resolve(root, outArg)
      : path.join(root, '_cobolt-output', 'audit', 'gate-bypass-audit.md');
  fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outPath, md, { encoding: 'utf8', mode: 0o600 });
  if (!hasFlag(args, '--quiet')) {
    process.stdout.write(`Audit written: ${outPath}\n`);
    process.stdout.write(`  totalGatesBypassed: ${aggregate.summary.totalGatesBypassed}\n`);
    process.stdout.write(`  totalBypassEvents: ${aggregate.summary.totalBypassEvents}\n`);
    process.stdout.write(`  totalEmergencies: ${aggregate.summary.totalEmergencies}\n`);
    process.stdout.write(`  totalExpiredWithoutRenewal: ${aggregate.summary.totalExpiredWithoutRenewal}\n`);
  }
}

function cmdExportToken(args) {
  const id = args[0];
  if (!id || id.startsWith('--')) throw new Error('export-token: missing entry id');
  const token = ledger.exportCiToken({ id, projectRoot: projectRoot() });
  process.stdout.write(`${token}\n`);
}

function cmdImportToken(args) {
  const token = flagValue(args, '--token');
  if (typeof token !== 'string') throw new Error('import-token: --token <base64> is required');
  const entry = ledger.importCiToken({ token, projectRoot: projectRoot() });
  process.stdout.write(`Imported CI token as id=${entry.id} gate=${entry.gateId}\n`);
}

function cmdGates(args) {
  const all = registry.listAllBypassable();
  if (hasFlag(args, '--json')) {
    process.stdout.write(`${JSON.stringify(all, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Registered bypassable gates (${all.length}):\n`);
  for (const g of all) {
    process.stdout.write(
      `  ${g.id.padEnd(28)} tier=${String(g.tier).padEnd(7)} env=${(g.envVar || '-').padEnd(40)} hook=${g.hook}\n`,
    );
  }
}

// Shell-friendly bypass check. Skill files cannot `require('./lib/...')` (root
// CLAUDE.md Architectural Invariant 14), so this subcommand is the single
// entry point for shell-driven steps (e.g. cobolt-build/steps/00-preflight.md)
// that need to ask "is this gate currently bypassed?". Exit codes intentionally
// diverge from the rest of cobolt-bypass.js so callers can branch:
//
//   if node tools/cobolt-bypass.js check my-gate; then handle_bypassed; else handle_active; fi
//
//   0 — bypassed (signed ledger entry, master kill, or auto-promoted env var)
//   2 — not bypassed
//   1 — input error (missing/unknown gate id)
function cmdCheck(args) {
  const gateId = args.find((a) => !a.startsWith('--'));
  if (!gateId) {
    process.stderr.write('cobolt-bypass check: <gateId> is required\n');
    process.exit(1);
  }
  const gate = registry.getGateById(gateId);
  if (!gate && gateId !== 'master') {
    process.stderr.write(`cobolt-bypass check: unknown gate id "${gateId}"\n`);
    process.exit(1);
  }
  // Resolver carries the canonical bypass logic (signed ledger + master kill +
  // env-var auto-promote during deprecation window). We import lazily so the
  // CLI's normal subcommands aren't penalized at startup.
  const { isGateBypassed } = require(path.resolve(__dirname, '..', 'lib', 'cobolt-bypass-resolver.js'));
  const bypassed = isGateBypassed(gateId, { projectRoot: process.cwd() });
  if (!hasFlag(args, '--quiet')) {
    process.stdout.write(`${gateId}: ${bypassed ? 'bypassed' : 'active'}\n`);
  }
  process.exit(bypassed ? 0 : 2);
}

function printUsage() {
  process.stdout.write(`cobolt-bypass — signed gate-bypass ledger CLI (GT-01)

Usage:
  cobolt-bypass grant <gateId> --reason "..." --approver email [...] --hours <n>
  cobolt-bypass grant <gateId> --reason "..." --approver email --until <ISO-8601>
  cobolt-bypass emergency --reason "..." --approver A --approver B [--hours <n>]
  cobolt-bypass revoke <id> --reason "..." --approver email
  cobolt-bypass list [--gate <id>] [--since 90d|<ISO>] [--active-only] [--json]
  cobolt-bypass verify
  cobolt-bypass report [--format json|soc2|markdown]
  cobolt-bypass audit [--since 90d|<ISO>] [--out path|-] [--top-reasons N] [--gate id] [--json] [--quiet]
  cobolt-bypass export-token <id>
  cobolt-bypass import-token --token <base64>
  cobolt-bypass gates [--json]

Notes:
  - Tier 1+ grants: max duration 90 days.
  - Emergency master kill: quorum requires >=2 distinct approver emails, max 24h.
  - Tier 0 gates (e.g. human-milestone) are non-bypassable.
  - Deprecated COBOLT_*=off env vars auto-promote to 24h ledger entries during
    the v0.57-v0.59 deprecation window. After v0.59 they are ignored entirely.
  - Ledger lives at _cobolt-output/audit/gate-bypass-ledger.jsonl (append-only,
    chained, HMAC-SHA256 signed). HMAC key auto-generated in .env.cobolt
    (COBOLT_BYPASS_HMAC_KEY).

Exit codes (per tools/CLAUDE.md):
  0 — success / help
  1 — input error / verify failure
`);
}
