#!/usr/bin/env node

// CoBolt Aggregate-Boundary Lint Gate (DDD enhancement, v0.59)
//
// Heuristic linter that reads _cobolt-output/latest/planning/capability-contracts/*.contract.json
// and flags operations that likely violate two hard DDD aggregate rules:
//
//   Rule 1 — One aggregate per transaction.
//     A single operation must not mutate >1 aggregate root atomically. Cross-aggregate
//     coordination should be eventual (saga, outbox, domain event), not transactional.
//
//   Rule 2 — Reference other aggregates by ID, not by object.
//     An operation must not return/accept full object graphs that span aggregate roots.
//     Cross-aggregate references should be by ID; the consumer fetches separately.
//
// This is a Tier 2 advisory gate — false positives are tolerable; unflagged true violations
// would cost weeks of refactor at build time.
//
// Subcommands:
//   check        Run heuristics; output JSON report; non-zero exit if violations found
//   --json       Always emit JSON to stdout (default for check)
//   --markdown   Also write _cobolt-output/latest/planning/aggregate-lint-report.md
//
// Exit codes (per tools/CLAUDE.md contract):
//   0  no violations OR planning dir missing (gate skipped — caller decides if that's OK)
//   1  one or more violations found
//   2  reserved (no optional deps)
//   3  reserved

const fs = require('node:fs');
const path = require('node:path');

const { getPlanningDir } = (() => {
  try {
    return require('../lib/cobolt-planning-artifacts');
  } catch {
    return {
      getPlanningDir: (root) => path.join(root || process.cwd(), '_cobolt-output', 'latest', 'planning'),
    };
  }
})();

// ── Heuristic lexicon ─────────────────────────────────────────────────

// Words that follow an entity to indicate mutation (postcondition prose).
// Matched case-insensitively after a CapitalCase entity reference.
const MUTATION_VERBS = [
  'is created',
  'is updated',
  'is deleted',
  'is modified',
  'is persisted',
  'is saved',
  'is removed',
  'is set',
  'is changed',
  'is incremented',
  'is decremented',
  'becomes',
  'transitions to',
  'is recorded',
  'is committed',
  'is written',
];

// Words that suggest object embedding (cross-aggregate reference by object).
const EMBEDDING_PHRASES = [
  'with embedded',
  'including the',
  'with full',
  'with attached',
  'including all',
  'with related',
  'with associated',
  'eager',
  'eager-loaded',
  'eagerly loaded',
  'preloaded with',
];

// Words that suggest ID-only reference (good — should NOT trigger a flag).
const ID_REF_HINTS = [/\bId\b/, /\bID\b/, /Identifier/, /Reference\b/, /\bRef\b/];

// ── Aggregate detection ──────────────────────────────────────────────

function extractEntitiesFromContract(contract) {
  const entities = new Set();

  // From state machines (most reliable signal — entity field is explicit)
  for (const sm of contract.stateMachines || []) {
    if (sm.entity) entities.add(sm.entity);
  }

  // From domain invariants scoped to entity
  for (const inv of contract.domainInvariants || []) {
    if (inv.scope === 'entity') {
      const m = inv.expression.match(/\b([A-Z][A-Za-z]{2,})\b/);
      if (m) entities.add(m[1]);
    }
  }

  // From domain events — event names typically include entity (OrderPlaced, PaymentSettled)
  const events = [...(contract.domainEvents?.produces || []), ...(contract.domainEvents?.consumes || [])];
  for (const ev of events) {
    if (!ev.name) continue;
    // Strip trailing past-tense verb to get entity (OrderPlaced → Order, PaymentSettled → Payment)
    const m = ev.name.match(/^([A-Z][a-z]+)([A-Z][a-z]+(ed|d|en))$/);
    if (m) entities.add(m[1]);
  }

  return entities;
}

function findEntityMentions(text, knownEntities) {
  if (!text || typeof text !== 'string') return [];
  const found = new Set();
  for (const ent of knownEntities) {
    // Whole-word match, allow plurals
    const re = new RegExp(`\\b${ent}s?\\b`);
    if (re.test(text)) found.add(ent);
  }
  return [...found];
}

function detectMultiAggregateMutation(operation, knownEntities) {
  const violations = [];
  for (const post of operation.postconditions || []) {
    // Find all entities mentioned in this postcondition
    const mentioned = findEntityMentions(post, knownEntities);
    if (mentioned.length < 2) continue;

    // Count entities that appear adjacent to a mutation verb
    const mutated = new Set();
    for (const ent of mentioned) {
      // Look for "Order is updated", "Payment was created", etc.
      for (const verb of MUTATION_VERBS) {
        const re = new RegExp(`\\b${ent}\\b\\s+(${verb.replace(/\s+/g, '\\s+')})`, 'i');
        if (re.test(post)) {
          mutated.add(ent);
          break;
        }
      }
    }

    if (mutated.size >= 2) {
      violations.push({
        rule: 'multi-aggregate-tx',
        severity: 'error',
        operation: operation.name,
        postcondition: post,
        aggregatesMutated: [...mutated],
        suggestion:
          'Split into separate operations coordinated by a saga, domain event, or outbox. Atomic cross-aggregate writes do not scale and complicate eventual consistency.',
      });
    }
  }
  return violations;
}

function detectCrossAggregateObjectRef(operation, knownEntities) {
  const violations = [];

  const surfaces = [
    ...(operation.postconditions || []).map((p) => ({ field: 'postcondition', text: p })),
    ...(operation.preconditions || []).map((p) => ({ field: 'precondition', text: p })),
    ...(operation.description ? [{ field: 'description', text: operation.description }] : []),
  ];

  for (const { field, text } of surfaces) {
    for (const phrase of EMBEDDING_PHRASES) {
      const re = new RegExp(`${phrase}\\s+([A-Z][A-Za-z]+)`, 'i');
      const m = text.match(re);
      if (!m) continue;
      const embedded = m[1];
      // Strip "the" or "a" prefixes that may have leaked
      const cleanedEmbedded = embedded.replace(/^(The|A|An)/, '');
      if (!knownEntities.has(cleanedEmbedded)) continue;

      // Check whether the surrounding text uses an ID hint — if so, skip (false positive)
      const contextWindow = text.slice(Math.max(0, m.index - 40), Math.min(text.length, m.index + 60));
      const hasIdHint = ID_REF_HINTS.some((re2) => re2.test(contextWindow));
      if (hasIdHint) continue;

      violations.push({
        rule: 'cross-aggregate-object-ref',
        severity: 'warning',
        operation: operation.name,
        field,
        text,
        embeddedAggregate: cleanedEmbedded,
        suggestion: `Reference ${cleanedEmbedded} by ID instead of embedding the full object. Consumer fetches ${cleanedEmbedded} separately if needed.`,
      });
    }
  }
  return violations;
}

// ── Report rendering ─────────────────────────────────────────────────

function lintContract(contract) {
  const knownEntities = extractEntitiesFromContract(contract);
  const violations = [];
  for (const op of contract.operations || []) {
    violations.push(...detectMultiAggregateMutation(op, knownEntities));
    violations.push(...detectCrossAggregateObjectRef(op, knownEntities));
  }
  return {
    featureId: contract.featureId,
    title: contract.title,
    knownEntities: [...knownEntities],
    operationCount: (contract.operations || []).length,
    violationCount: violations.length,
    violations,
  };
}

function lintAll({ contractsDir }) {
  if (!fs.existsSync(contractsDir)) {
    return {
      ok: true,
      skipped: true,
      reason: `capability-contracts directory missing at ${contractsDir} — gate skipped`,
      contractsDir,
    };
  }

  const files = fs
    .readdirSync(contractsDir)
    .filter((f) => f.endsWith('.contract.json'))
    .map((f) => path.join(contractsDir, f));

  const reports = [];
  let totalViolations = 0;
  let totalErrors = 0;

  for (const file of files) {
    let contract;
    try {
      contract = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      reports.push({
        file,
        error: `failed to parse: ${err.message}`,
        violationCount: 0,
        violations: [],
      });
      continue;
    }
    const report = lintContract(contract);
    report.file = path.relative(process.cwd(), file);
    reports.push(report);
    totalViolations += report.violationCount;
    totalErrors += report.violations.filter((v) => v.severity === 'error').length;
  }

  return {
    ok: totalErrors === 0,
    contractsScanned: files.length,
    totalViolations,
    totalErrors,
    totalWarnings: totalViolations - totalErrors,
    reports: reports.filter((r) => r.violationCount > 0 || r.error),
  };
}

function renderMarkdown(result) {
  if (result.skipped) return `# Aggregate-Boundary Lint Report\n\nSkipped: ${result.reason}\n`;
  const lines = [];
  lines.push('# Aggregate-Boundary Lint Report');
  lines.push('');
  lines.push(`Scanned ${result.contractsScanned} capability contract(s).`);
  lines.push(`Found ${result.totalErrors} error(s) and ${result.totalWarnings} warning(s).`);
  lines.push('');
  lines.push('## DDD Aggregate Rules');
  lines.push('1. **One aggregate per transaction** — a single operation must not mutate >1 aggregate root atomically.');
  lines.push(
    '2. **Reference by ID, not by object** — cross-aggregate references must be IDs; consumer fetches separately.',
  );
  lines.push('');
  if (result.reports.length === 0) {
    lines.push('## Findings');
    lines.push('');
    lines.push('No violations detected.');
    return `${lines.join('\n')}\n`;
  }
  lines.push('## Findings');
  for (const r of result.reports) {
    if (r.error) {
      lines.push('');
      lines.push(`### ${r.file}`);
      lines.push(`PARSE ERROR: ${r.error}`);
      continue;
    }
    lines.push('');
    lines.push(`### ${r.featureId} — ${r.title}`);
    lines.push(`File: \`${r.file}\``);
    lines.push(
      `Known entities: ${r.knownEntities.length ? r.knownEntities.map((e) => `\`${e}\``).join(', ') : '_none detected_'}`,
    );
    for (const v of r.violations) {
      lines.push('');
      lines.push(`- **[${v.severity.toUpperCase()}] ${v.rule}** — operation \`${v.operation}\``);
      if (v.aggregatesMutated)
        lines.push(`  - Aggregates mutated: ${v.aggregatesMutated.map((a) => `\`${a}\``).join(', ')}`);
      if (v.embeddedAggregate) lines.push(`  - Embedded aggregate: \`${v.embeddedAggregate}\``);
      if (v.postcondition) lines.push(`  - Postcondition: _${v.postcondition}_`);
      if (v.text && !v.postcondition) lines.push(`  - Text: _${v.text}_`);
      if (v.suggestion) lines.push(`  - Suggestion: ${v.suggestion}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// ── CLI ───────────────────────────────────────────────────────────────

const USAGE =
  'Usage: cobolt-aggregate-lint.js check [--markdown] [--json]\n' +
  '  check       Run heuristics; emit JSON to stdout; exit 1 if errors found\n' +
  '  --markdown  Also write aggregate-lint-report.md alongside the report\n' +
  '  --json      Force JSON output (default)\n' +
  '  --help, -h  Show this usage';

function parseArgs(argv) {
  const flags = { _: [], markdown: false, json: true };
  for (const a of argv) {
    if (a === '--markdown') flags.markdown = true;
    else if (a === '--json') flags.json = true;
    else flags._.push(a);
  }
  return flags;
}

function main(argv) {
  const flags = parseArgs(argv);
  const cmd = flags._[0] || 'check';
  if (cmd !== 'check') {
    console.error(USAGE);
    return 1;
  }

  const planningDir = getPlanningDir(process.cwd()) || path.join(process.cwd(), '_cobolt-output', 'latest', 'planning');
  const contractsDir = path.join(planningDir, 'capability-contracts');

  const result = lintAll({ contractsDir });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if (flags.markdown) {
    const reportPath = path.join(planningDir, 'aggregate-lint-report.md');
    try {
      fs.mkdirSync(planningDir, { recursive: true });
      fs.writeFileSync(reportPath, renderMarkdown(result), 'utf8');
    } catch (err) {
      process.stderr.write(`failed to write markdown report: ${err.message}\n`);
    }
  }

  if (result.skipped) return 0;
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  process.exit(main(argv));
}

module.exports = {
  extractEntitiesFromContract,
  findEntityMentions,
  detectMultiAggregateMutation,
  detectCrossAggregateObjectRef,
  lintContract,
  lintAll,
  renderMarkdown,
  MUTATION_VERBS,
  EMBEDDING_PHRASES,
};
