#!/usr/bin/env node

// CoBolt Validation Rule Completeness Census (v0.65+, Tier 2 advisory).
//
// Reverse-engineering Wave 2.2 census tool. For every external input
// identified by `validation-cataloger-agent` (form fields, API request bodies,
// file upload schemas, message-queue payloads, environment variables), verify
// that a validation rule exists in the extracted-rules corpus.
//
// Reads inputs from:
//   - `_cobolt-output/latest/brownfield/15-validation-and-error-catalog.md`
//     (if present; canonical output of validation-cataloger-agent)
//   - per-input markdown blocks under
//     `_cobolt-output/latest/brownfield/15-validation/*.md`
//
// Cross-references against extracted rules with `RULE-VALIDATION-*` prefix or
// rules whose sbvrForm.subject matches the input field name.
//
// Tier 2: skip-and-report. Does NOT block by itself. Surfaces gaps where the
// cataloger found an input but no validation rule was extracted to constrain it.
//
// Usage:
//   node tools/cobolt-validation-rule-completeness.js scan [--brownfield <dir>] [--json] [--out <file>]
//
// Exit codes:
//   0 = full coverage (every catalogued input has ≥1 validation rule)
//   1 = usage
//   2 = no catalog / nothing to scan
//   3 = coverage gaps found (advisory only)

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_SKIPPED = 2;
const EXIT_FINDINGS = 3;

// Pattern: `INPUT-FORMS-LOGIN-USERNAME` or `INPUT-API-CHECKOUT-LINEITEMS`.
const INPUT_ID_PATTERN = /\bINPUT-[A-Z0-9]+(?:-[A-Z0-9]+)+\b/g;
const _RULE_ID_PATTERN = /\bRULE-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g;

function parseArgs(argv) {
  const args = { brownfield: null, json: false, out: null };
  let positional;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--brownfield') {
      args.brownfield = argv[++i];
      continue;
    }
    if (a === '--json') {
      args.json = true;
      continue;
    }
    if (a === '--out') {
      args.out = argv[++i];
      continue;
    }
    if (!a.startsWith('--')) {
      positional = positional || a;
    }
  }
  args.command = positional || 'scan';
  return args;
}

function findBrownfieldDir(explicitDir) {
  if (explicitDir) return path.resolve(explicitDir);
  const candidates = [
    path.join(process.cwd(), '_cobolt-output', 'latest', 'brownfield'),
    path.join(process.cwd(), '_cobolt-output', 'brownfield'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function discoverInputs(brownfieldDir) {
  const inputs = new Set();
  const inputContext = new Map(); // inputId -> { source: file, contextSnippet }
  const scanFile = (p) => {
    let body;
    try {
      body = fs.readFileSync(p, 'utf8');
    } catch {
      return;
    }
    for (const m of body.match(INPUT_ID_PATTERN) || []) {
      inputs.add(m);
      if (!inputContext.has(m)) {
        const idx = body.indexOf(m);
        const snippet = body.slice(Math.max(0, idx - 60), Math.min(body.length, idx + 80));
        inputContext.set(m, { source: p, contextSnippet: snippet.replace(/\s+/g, ' ').trim() });
      }
    }
  };
  const mainCatalog = path.join(brownfieldDir, '15-validation-and-error-catalog.md');
  if (fs.existsSync(mainCatalog)) scanFile(mainCatalog);
  const splitDir = path.join(brownfieldDir, '15-validation');
  if (fs.existsSync(splitDir)) {
    for (const entry of fs.readdirSync(splitDir, { withFileTypes: true })) {
      if (entry.isFile() && /\.md$/i.test(entry.name)) scanFile(path.join(splitDir, entry.name));
    }
  }
  return { inputs, inputContext };
}

function discoverValidationRules(brownfieldDir) {
  // Rules are validation-related when their RULE-ID starts with VALIDATION,
  // VALID, FORM, INPUT, or when the rule body cites an INPUT-* id.
  const rulesByInput = new Map(); // inputId -> Set<RULE-ID>
  const generalValidationRules = new Set(); // RULE-VALIDATION-*

  const scanFile = (p) => {
    let body;
    try {
      body = fs.readFileSync(p, 'utf8');
    } catch {
      return;
    }
    const blocks = body.split(/^##\s+(RULE-[A-Z0-9-]+)/m);
    for (let i = 1; i < blocks.length; i += 2) {
      const ruleId = blocks[i];
      const block = blocks[i + 1] || '';
      if (/^RULE-(VALIDATION|VALID|FORM|INPUT)-/.test(ruleId)) {
        generalValidationRules.add(ruleId);
      }
      for (const m of block.match(INPUT_ID_PATTERN) || []) {
        if (!rulesByInput.has(m)) rulesByInput.set(m, new Set());
        rulesByInput.get(m).add(ruleId);
      }
    }
  };
  const main = path.join(brownfieldDir, '14-business-rules-and-validation.md');
  if (fs.existsSync(main)) scanFile(main);
  const splitDir = path.join(brownfieldDir, '14-business-rules');
  if (fs.existsSync(splitDir)) {
    for (const entry of fs.readdirSync(splitDir, { withFileTypes: true })) {
      if (entry.isFile() && /\.md$/i.test(entry.name)) scanFile(path.join(splitDir, entry.name));
    }
  }
  return { rulesByInput, generalValidationRules };
}

function evaluate(inputs, rulesByInput) {
  const gaps = [];
  for (const inputId of inputs) {
    const rules = rulesByInput.get(inputId);
    if (!rules || rules.size === 0) gaps.push(inputId);
  }
  return { gaps, total: inputs.size, covered: inputs.size - gaps.length };
}

function scan({ brownfield }) {
  const dir = findBrownfieldDir(brownfield);
  if (!dir) return { ok: false, reason: 'no-brownfield-dir', exitCode: EXIT_SKIPPED };
  const { inputs, inputContext } = discoverInputs(dir);
  if (inputs.size === 0) return { ok: false, reason: 'no-inputs-catalogued', exitCode: EXIT_SKIPPED };
  const { rulesByInput, generalValidationRules } = discoverValidationRules(dir);
  const result = evaluate(inputs, rulesByInput);
  return {
    ok: true,
    exitCode: result.gaps.length > 0 ? EXIT_FINDINGS : EXIT_OK,
    totalInputs: result.total,
    coveredInputs: result.covered,
    gapCount: result.gaps.length,
    gaps: result.gaps.map((id) => ({ inputId: id, source: inputContext.get(id)?.source })),
    generalValidationRuleCount: generalValidationRules.size,
  };
}

function printHelp() {
  process.stdout.write(
    [
      'CoBolt Validation Rule Completeness Census (Tier 2 advisory).',
      '',
      'Usage:',
      '  node tools/cobolt-validation-rule-completeness.js scan [--brownfield <dir>] [--json] [--out <file>]',
      '',
      'For every external input catalogued in 15-validation-and-error-catalog.md,',
      'verifies that at least one validation rule references it. Reports inputs',
      'with no rules. Exit codes: 0=ok, 1=usage, 2=skipped, 3=findings (advisory).',
      '',
    ].join('\n'),
  );
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return EXIT_OK;
  }
  const result = scan(args);
  const text = args.json
    ? JSON.stringify(result, null, 2)
    : [
        `validation-rule-completeness: ${result.ok ? 'COMPLETED' : `SKIPPED (${result.reason})`}`,
        result.ok ? `  Inputs catalogued: ${result.totalInputs}` : '',
        result.ok ? `  Inputs covered by ≥1 rule: ${result.coveredInputs}` : '',
        result.ok ? `  Coverage gaps: ${result.gapCount}` : '',
        result.ok && result.gapCount > 0 ? '' : null,
        result.ok && result.gapCount > 0 ? '  First 10 gaps:' : null,
        ...(result.ok && result.gapCount > 0
          ? result.gaps
              .slice(0, 10)
              .map((g) => `    - ${g.inputId}${g.source ? ` (in ${path.basename(g.source)})` : ''}`)
          : []),
      ]
        .filter((v) => v !== null && v !== '')
        .join('\n');
  if (args.out) fs.writeFileSync(args.out, `${text}\n`);
  else process.stdout.write(`${text}\n`);
  return result.exitCode;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  scan,
  parseArgs,
  discoverInputs,
  discoverValidationRules,
  evaluate,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_SKIPPED,
  EXIT_FINDINGS,
};
