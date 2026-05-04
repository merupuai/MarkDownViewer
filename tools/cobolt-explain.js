#!/usr/bin/env node

// CoBolt Gate Explain CLI (GT-06 / v0.58+).
//
// Closes the halt UX gap: instead of grepping HUMAN-REVIEW-REQUIRED.md +
// phase{N}-*.json + cobolt-state.json, an engineer runs `cobolt-explain
// <gate-id>` and gets a copy-pasteable next action plus the full evidence
// trail.
//
// Subcommands / flags:
//   <gate-id>          Render advice for the given gate. Uses the most
//                      recent dynamic context from gate-skip-log.jsonl when
//                      available, else falls back to the static catalog.
//   --list             List every registered gate with its rule name.
//   --halt             Render advice for every gate that has fired
//                      recently (default: last 24h). Suitable for
//                      injection into HUMAN-REVIEW-REQUIRED.md.
//   --inject <path>    With --halt: idempotently inject the rendered
//                      block into the named halt artifact at the
//                      anchor-comment markers.
//   --since <window>   With --halt: time window (Nd/Nh/Nm or ISO).
//                      Default 24h.
//   --json             Emit JSON instead of text.
//
// Exit codes (per tools/CLAUDE.md):
//   0 — success / help / clean rendering
//   1 — input error, unknown gate id, malformed advice envelope

const path = require('node:path');

const advice = require(path.resolve(__dirname, '..', 'lib', 'cobolt-gate-advice.js'));
const registry = require(path.resolve(__dirname, '..', 'lib', 'cobolt-gate-registry.js'));

const argv = process.argv.slice(2);

if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  printUsage();
  process.exit(0);
}

try {
  if (argv.includes('--list')) {
    cmdList();
    process.exit(0);
  }
  if (argv.includes('--halt')) {
    cmdHalt(argv);
    process.exit(0);
  }
  // Positional: <gate-id>
  const gateId = argv.find((a) => !a.startsWith('--'));
  if (!gateId) {
    process.stderr.write('cobolt-explain: missing <gate-id>. Run --help for usage.\n');
    process.exit(1);
  }
  cmdExplain(gateId, argv);
  process.exit(0);
} catch (err) {
  process.stderr.write(`cobolt-explain: ${err.message}\n`);
  process.exit(1);
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}

function projectRoot() {
  return process.cwd();
}

function cmdList() {
  const all = registry.listAllBypassable();
  const json = process.argv.includes('--json');
  const cat = advice.loadCatalog();
  if (json) {
    const out = all.map((g) => {
      const entry = cat.gates?.[g.id] || null;
      return {
        id: g.id,
        tier: g.tier,
        envVar: g.envVar || null,
        hook: g.hook,
        ruleName: entry ? entry.ruleName : null,
        hasCatalogEntry: !!entry,
      };
    });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Registered gates with explainability (${all.length}):\n\n`);
  for (const g of all) {
    const entry = cat.gates?.[g.id] || null;
    const rule = entry ? entry.ruleName : '(no catalog entry — falls back to stub)';
    const tierLabel = String(g.tier).padEnd(7);
    process.stdout.write(`  ${g.id.padEnd(28)} tier=${tierLabel}  ${rule}\n`);
  }
  process.stdout.write(
    '\nRun `node tools/cobolt-explain.js <gate-id>` for full advice (rule + evidence + run-this-to-fix command).\n',
  );
}

function cmdExplain(gateId, args) {
  const root = projectRoot();
  const reg = registry.getGateById(gateId);
  if (!reg && !registry.isTier0(gateId)) {
    // Soft fail — render a stub envelope so the engineer at least sees
    // something coherent, but exit 1 so scripts can detect "unknown gate".
    const stub = advice.buildAdvice({ gateId, tier: 1 });
    if (args.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ unknown: true, advice: stub }, null, 2)}\n`);
    } else {
      process.stdout.write(`(warning) gate id '${gateId}' is not in lib/cobolt-gate-registry.js — rendering stub.\n\n`);
      process.stdout.write(advice.renderText(stub));
    }
    process.exit(1);
  }
  const tier = reg ? reg.tier : 0;
  const dynamicAdvice = advice.latestAdviceForGate({ gateId, projectRoot: root });
  const lastFire = advice.latestFireEventForGate({ gateId, projectRoot: root });
  let envelope;
  if (dynamicAdvice) {
    envelope = dynamicAdvice;
  } else {
    // Synthesize from catalog + registry, attaching last-fire timestamp if any.
    const dynamic = lastFire
      ? {
          whyItFailed: lastFire.event ? `Last fire event: ${lastFire.event} at ${lastFire.at}` : undefined,
          blockedTool: lastFire.tool,
          blockedFile: lastFire.file,
        }
      : {};
    envelope = advice.buildAdvice({ gateId, tier, dynamic, registry });
  }
  if (args.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify({ source: dynamicAdvice ? 'dynamic' : 'catalog', lastFireAt: lastFire?.at || null, advice: envelope }, null, 2)}\n`,
    );
    return;
  }
  if (lastFire?.at) {
    process.stdout.write(`(last fire: ${lastFire.at})\n\n`);
  }
  process.stdout.write(advice.renderText(envelope));
}

function cmdHalt(args) {
  const root = projectRoot();
  const sinceArg = flagValue(args, '--since');
  const sinceLabel = typeof sinceArg === 'string' ? sinceArg : '24h';
  const sinceMs = resolveSinceMs(sinceLabel);
  if (sinceMs == null) {
    throw new Error(`--since must be a window like '24h', '7d', '60m' or an ISO-8601 timestamp; got '${sinceLabel}'`);
  }
  const recent = advice.recentAdvice({ projectRoot: root, sinceMs });

  const injectPath = flagValue(args, '--inject');
  if (typeof injectPath === 'string') {
    const target = path.resolve(root, injectPath);
    const result = advice.injectHaltSection({ haltPath: target, adviceList: recent });
    if (args.includes('--json')) {
      process.stdout.write(
        `${JSON.stringify({ injected: true, replaced: result.replaced, haltPath: target, adviceCount: recent.length }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(
        `Injected ${recent.length} advice block(s) into ${target} (${result.replaced ? 'replaced existing section' : 'appended new section'}).\n`,
      );
    }
    return;
  }

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ since: sinceLabel, count: recent.length, advice: recent }, null, 2)}\n`);
    return;
  }

  if (recent.length === 0) {
    process.stdout.write(`No structured advice in skip-log within window '${sinceLabel}'.\n`);
    process.stdout.write(
      'Either no Tier 1+ gates fired recently, or the gates that fired have not yet been wired to attach advice.\n',
    );
    return;
  }

  process.stdout.write(advice.renderHaltSection(recent));
}

function resolveSinceMs(value, now = Date.now()) {
  if (!value) return null;
  const m = String(value)
    .trim()
    .match(/^(\d+)\s*([dhm])$/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const mult = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000;
    return now - n * mult;
  }
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function printUsage() {
  process.stdout.write(`cobolt-explain — gate failure-advice explainer (GT-06)

Usage:
  cobolt-explain <gate-id>                Render advice for a gate (most-recent fire if any).
  cobolt-explain --list                   List every registered gate with rule names.
  cobolt-explain --halt [--since 24h]     Render every recent fire's advice.
  cobolt-explain --halt --inject <path>   Idempotently inject the halt section
                                          into a HUMAN-REVIEW-REQUIRED.md.
  cobolt-explain ... --json               Emit JSON instead of text.

Examples:
  cobolt-explain memory-size
  cobolt-explain --list
  cobolt-explain --halt --inject _cobolt-output/latest/planning/HUMAN-REVIEW-REQUIRED.md

Notes:
  - Static advice catalog: source/templates/gate-advice-catalog.json
  - Dynamic per-fire context: _cobolt-output/audit/gate-skip-log.jsonl
  - Schema: source/schemas/gate-failure-advice.schema.json
  - See docs/GT-06-GATE-EXPLAIN.md for the full operator guide.

Exit codes:
  0 — success / help
  1 — input error / unknown gate id
`);
}
