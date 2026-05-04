#!/usr/bin/env node

// CoBolt Policy Interoperability CLI (PI-01 / GT-07).
//
// Bridges CoBolt's tiered gate system to enterprise policy engines (OPA/Rego,
// Conftest, Gatekeeper, internal catalogs). Ships export + verify + schema +
// evaluate. Inline gate-hook composition is a later phase.
//
// Subcommands:
//   export [--format json|rego] [--out <path>]
//                        Emit the canonical bundle (registry + tiers + catalog)
//                        in JSON (default) or Rego module form. --out writes
//                        a file; absent --out prints to stdout.
//   schema [--out <path>]
//                        Emit the frozen v1 evidence-envelope schema. Useful
//                        for vendoring into a downstream Rego project so it
//                        can validate inputs before evaluation.
//   verify               Cross-check registry ↔ tiers ↔ catalog parity. Exits
//                        1 if drift detected. Used in CI.
//   evaluate --engine json|opa --bundle <path> [--envelope <path>]
//                        Evaluate a v1 evidence envelope and merge with the
//                        native verdict.
//   --help / -h          Usage.
//
// Composition rule recorded in every bundle:
//   final = max-severity(native, external)
//   Severity order: deny > degrade > warn > allow.
//   External policies CAN add denies/warns/degrades.
//   External policies CANNOT weaken a Tier 1 native deny.
//
// Exit codes (mandatory contract — see tools/CLAUDE.md):
//   0 — success / help / verify-clean
//   1 — input error / verify-drift / policy deny / write failure
//   2 — missing optional dependency (OPA binary)
//   3 — missing infrastructure (OPA execution failure)

const fs = require('node:fs');
const path = require('node:path');

const exporter = require(path.resolve(__dirname, '..', 'lib', 'cobolt-policy-export.js'));

const argv = process.argv.slice(2);

if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  printUsage();
  process.exit(0);
}

const sub = argv[0];
const rest = argv.slice(1);

try {
  switch (sub) {
    case 'export':
      cmdExport(rest);
      process.exit(0);
      break;
    case 'schema':
      cmdSchema(rest);
      process.exit(0);
      break;
    case 'verify':
      cmdVerify(rest);
      // cmdVerify owns its own exit
      break;
    case 'evaluate':
      cmdEvaluate(rest);
      // cmdEvaluate owns its own exit
      break;
    default:
      process.stderr.write(`cobolt-policy: unknown subcommand '${sub}'. Run --help.\n`);
      process.exit(1);
  }
} catch (err) {
  process.stderr.write(`cobolt-policy: ${err.message}\n`);
  process.exit(1);
}

function printUsage() {
  process.stdout.write(
    [
      'cobolt-policy — CoBolt policy interoperability (PI-01 Phase 1)',
      '',
      'Usage:',
      '  cobolt-policy export [--format json|rego] [--out <path>]',
      '  cobolt-policy schema [--out <path>]',
      '  cobolt-policy verify',
      '  cobolt-policy evaluate --engine json|opa --bundle <path> [--envelope <path>] [--json]',
      '  cobolt-policy --help | -h',
      '',
      'export    Emit bundle of registered gates + tier semantics + advice catalog.',
      '          --format json (default) prints the canonical JSON bundle.',
      '          --format rego emits a Rego module pair (cobolt.gates + cobolt.policy).',
      '          --out <path> writes to file; otherwise stdout.',
      '',
      'schema    Emit policy-evidence-envelope.schema.json (v1 frozen) — the input',
      '          shape every external Rego policy is evaluated against.',
      '',
      'verify    Cross-check registry ↔ gate-tiers.json ↔ gate-advice-catalog.json',
      '          parity. Exits 1 on drift. Suitable for CI.',
      '',
      'evaluate  Evaluate a JSON fixture bundle or OPA/Rego bundle against a v1',
      '          evidence envelope. Final verdict uses additive-only-deny merge.',
      '',
      'Composition rule (recorded in every bundle):',
      '  final = max-severity(native, external)',
      '  External policies CAN add denies/warns/degrades.',
      '  External policies CANNOT weaken a Tier 1 native deny.',
      '',
      'Exit codes:',
      '  0 success | 1 input error, drift, or policy deny | 2 missing OPA | 3 OPA execution failure',
      '',
      'See docs/PI-01-POLICY-INTEROPERABILITY.md for the integrator guide.',
      '',
    ].join('\n'),
  );
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}

function cmdExport(args) {
  const format = flagValue(args, '--format') || 'json';
  if (format !== 'json' && format !== 'rego') {
    throw new Error(`unknown --format '${format}'. Use json|rego.`);
  }
  const outPath = flagValue(args, '--out');
  const bundle = exporter.buildPolicyBundle();
  const text = format === 'json' ? exporter.emitJSON(bundle) : exporter.emitRego(bundle);
  writeOrPrint(text, outPath);
}

function cmdSchema(args) {
  const outPath = flagValue(args, '--out');
  const schema = exporter.getPolicySchema();
  const text = `${JSON.stringify(schema, null, 2)}\n`;
  writeOrPrint(text, outPath);
}

function cmdVerify(_args) {
  const bundle = exporter.buildPolicyBundle();
  const result = exporter.verifyBundleAgainstCatalog(bundle);
  if (result.ok) {
    process.stdout.write(
      `cobolt-policy verify: OK (${bundle.counts.total} gates, ${bundle.counts.bypassable} bypassable)\n`,
    );
    process.exit(0);
  }
  process.stderr.write(`cobolt-policy verify: ${result.drift.length} drift record(s)\n`);
  for (const d of result.drift) {
    process.stderr.write(`  [${d.kind}] ${d.id}: ${d.detail}\n`);
  }
  process.exit(1);
}

function parseTier(value) {
  if (value === 'master') return 'master';
  const n = Number(value);
  return Number.isInteger(n) ? n : 3;
}

function readEnvelopeFromArgs(args) {
  const envelopePath = flagValue(args, '--envelope') || flagValue(args, '--input');
  if (typeof envelopePath === 'string') {
    return JSON.parse(fs.readFileSync(path.resolve(envelopePath), 'utf8'));
  }
  const evidencePaths = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--evidence' && args[i + 1] && !args[i + 1].startsWith('--')) evidencePaths.push(args[i + 1]);
  }
  return exporter.buildEvidenceEnvelope({
    gateId: flagValue(args, '--gate-id') || flagValue(args, '--gate') || 'manual-policy-check',
    tier: parseTier(flagValue(args, '--tier')),
    phase: flagValue(args, '--phase') || 'session',
    nativeDecision: flagValue(args, '--native-decision') || 'allow',
    reason: flagValue(args, '--reason') || '',
    tool: flagValue(args, '--tool') || null,
    filePath: flagValue(args, '--file') || flagValue(args, '--file-path') || null,
    pipelineMode: flagValue(args, '--mode') || 'unknown',
    milestone: flagValue(args, '--milestone') || null,
    evidencePaths,
  });
}

// P2.5 (v0.65+) — write the policy verdict to the unified evidence ledger
// so compliance evidence packs correlate Rego-evaluated decisions with the
// rest of the pipeline. Tier 3 advisory — never blocks evaluate() on
// ledger persistence failure. Maps to NIST SSDF PO.5.2 + SOC 2 CC8.1 +
// OWASP DSOMM Level 4.
function appendPolicyEvidence({ envelope, result }) {
  try {
    const evLedger = require('../lib/cobolt-evidence-ledger');
    return evLedger.append(
      {
        kind: evLedger.KINDS.GATE_DECISION,
        producer: 'cobolt-policy/v0.65.0',
        controlIds: ['NIST.SSDF.PO.5.2', 'SOC2.CC8.1', 'ISO.27001.A.18.1.1'],
        payload: {
          gateId: envelope?.gateId || null,
          tier: envelope?.tier || null,
          phase: envelope?.phase || null,
          milestone: envelope?.milestone || null,
          nativeDecision: result?.final?.native?.decision || null,
          externalDecision: result?.final?.external?.decision || null,
          finalDecision: result?.final?.decision || null,
        },
      },
      { projectRoot: process.cwd() },
    );
  } catch {
    return null;
  }
}

function cmdEvaluate(args) {
  const engine = flagValue(args, '--engine') || 'json';
  const bundlePath = flagValue(args, '--bundle');
  if (!bundlePath || bundlePath === true) {
    process.stderr.write('cobolt-policy evaluate: --bundle <path> is required.\n');
    process.exit(1);
  }
  const envelope = readEnvelopeFromArgs(args);
  let result;
  try {
    result = exporter.evaluatePolicyBundle({
      engine,
      bundlePath,
      envelope,
      query: flagValue(args, '--query') || undefined,
      opaPath: flagValue(args, '--opa') || undefined,
    });
  } catch (err) {
    const message = err?.message || String(err);
    if (err?.code === 'MISSING_OPA') {
      process.stderr.write(`cobolt-policy evaluate: ${message}\n`);
      process.exit(2);
    }
    if (err?.code === 'OPA_EVAL_FAILED') {
      process.stderr.write(`cobolt-policy evaluate: ${message}\n`);
      process.exit(3);
    }
    process.stderr.write(`cobolt-policy evaluate: ${message}\n`);
    process.exit(1);
  }

  // P2.5 — append verdict to unified evidence ledger (Tier 3 advisory).
  const ledgerEntry = appendPolicyEvidence({ envelope, result });
  if (ledgerEntry) result.ledgerEntryId = ledgerEntry.entryId;

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `native:   ${result.final.native.decision}`,
        `external: ${result.final.external.decision}`,
        `final:    ${result.final.decision}`,
        ...(result.final.external.messages || []).map((m) => `- ${m}`),
        ledgerEntry ? `ledger:   ${ledgerEntry.entryId}` : '',
        '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  process.exit(result.final.decision === 'deny' ? 1 : 0);
}

function writeOrPrint(text, outPath) {
  if (typeof outPath === 'string' && outPath.length > 0) {
    const abs = path.resolve(outPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    process.stdout.write(`wrote ${abs}\n`);
    return;
  }
  process.stdout.write(text);
}

module.exports = {
  // Programmatic surface for tests / orchestration. Real consumers should import
  // lib/cobolt-policy-export.js directly; this surface is convenience-only.
  buildPolicyBundle: exporter.buildPolicyBundle,
  emitJSON: exporter.emitJSON,
  emitRego: exporter.emitRego,
  getPolicySchema: exporter.getPolicySchema,
  verifyBundleAgainstCatalog: exporter.verifyBundleAgainstCatalog,
  buildEvidenceEnvelope: exporter.buildEvidenceEnvelope,
  evaluatePolicyBundle: exporter.evaluatePolicyBundle,
  mergePolicyVerdicts: exporter.mergePolicyVerdicts,
  appendPolicyEvidence,
};
