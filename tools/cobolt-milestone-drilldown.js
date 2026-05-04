#!/usr/bin/env node

// CoBolt Milestone Drilldown Validator (v0.51 design-gap closure)
//
// The v0.51 hardening declared (in milestone-architect.md and the
// cobolt-decompose-milestones skill) that milestones.md MUST contain a
// `#### FEAT-NNN` level-4 drill-down per feature inside each `## M{n}:`
// milestone section, with each drill-down enumerating at least one FR.
// Prompt-only enforcement fails under task pressure — this tool provides
// the deterministic validator that was missing.
//
// Usage:
//   node tools/cobolt-milestone-drilldown.js [--planning <dir>] [--json]
//   node tools/cobolt-milestone-drilldown.js --help
//
// Exit codes (per project_tool_exit_contract):
//   0 = passed (every FEAT in every milestone has matching drill-down)
//   1 = failed (missing drill-downs OR milestones.md missing/empty)
//   2 = missing dependency (feature-registry.json absent)
//   3 = missing infrastructure (planning dir doesn't exist)
//
// Bypass env: COBOLT_MILESTONE_DRILLDOWN_GATE
//   block (default in v0.52+) — exit code reflects validation
//   advisory                  — always exit 0 but still print findings; mode logged
//   off                       — always exit 0, print "bypassed", mode logged

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_MISSING_DEP = 2;
const EXIT_MISSING_INFRA = 3;

const DEFAULT_PLANNING_REL = path.join('_cobolt-output', 'latest', 'planning');

// ── Pure helpers ─────────────────────────────────────────────

function safeRead(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// Normalize FEAT-NN / FEAT-001 / feat-7 → FEAT-NNN (3-digit pad).
function normalizeFeat(raw) {
  const m = String(raw || '').match(/FEAT[-_\s]?(\d+)/i);
  if (!m) return null;
  return `FEAT-${String(parseInt(m[1], 10)).padStart(3, '0')}`;
}

// Split milestones.md into per-`## M{n}:` sections. Returns
// [{ milestone: 'M1', body: '...' }, ...] in source order.
function splitMilestoneSections(markdown) {
  if (!markdown) return [];
  const lines = markdown.split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(M\d+)\s*:/i);
    if (m) {
      if (current) sections.push(current);
      current = { milestone: m[1].toUpperCase(), body: [line] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) sections.push(current);
  return sections.map((s) => ({ milestone: s.milestone, body: s.body.join('\n') }));
}

// Parse the **Features:** bullet list inside a single milestone section.
// Recognises:  `- FEAT-001 Title`  / `* FEAT-001`  / `- feat-1 Title` etc.
// Stops at the next blank-line + non-list block, or end of section.
function parseFeaturesBlock(sectionBody) {
  const lines = sectionBody.split(/\r?\n/);
  const ids = [];
  let inBlock = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^\*\*Features:\*\*/i.test(line) || /^Features:\s*$/i.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    // Bullet line — extract FEAT id if present.
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      const id = normalizeFeat(bullet[1]);
      if (id) ids.push(id);
      continue;
    }
    // Blank line inside the block: tolerate one, but break on a non-bullet
    // non-blank line (start of the drill-downs or another sub-section).
    if (line === '') {
      // Allow a single trailing blank then keep scanning. We break on the
      // next non-bullet structural line.
      continue;
    }
    // Non-bullet, non-blank — block ended.
    break;
  }
  return [...new Set(ids)];
}

// Parse `#### FEAT-NNN` drill-down blocks inside a single milestone section.
// Returns Map<FEAT-NNN, { frCount, line }>. Stops a block at the next
// `####` heading or any heading of higher precedence (### / ## / #).
function parseDrilldownBlocks(sectionBody) {
  const lines = sectionBody.split(/\r?\n/);
  const blocks = new Map();
  let current = null;
  const flush = () => {
    if (!current) return;
    blocks.set(current.id, { frCount: current.frCount, line: current.line });
    current = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const drilldown = line.match(/^####\s+(FEAT[-_\s]?\d+)/i);
    if (drilldown) {
      flush();
      const id = normalizeFeat(drilldown[1]);
      if (id) current = { id, frCount: 0, line: i + 1 };
      continue;
    }
    // Any other heading of equal or higher level closes the current block.
    if (/^#{1,3}\s+/.test(line) && current) {
      flush();
      continue;
    }
    if (current) {
      // Count FR-* enumeration lines under this drilldown.
      // Accept FR-NN, FR-NNN-NN, FR-DOM-NN, etc.
      if (/^\s*[-*]\s+FR-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/i.test(line)) {
        current.frCount += 1;
      }
    }
  }
  flush();
  return blocks;
}

// ── Core API ─────────────────────────────────────────────────

function validate(planningDir) {
  const result = {
    passed: false,
    evidence: 'absent',
    missingDrilldowns: [],
    featuresWithoutFRs: [],
    featureCountByMilestone: {},
    drilldownCountByMilestone: {},
    reason: '',
  };

  if (!planningDir || !fs.existsSync(planningDir)) {
    result.reason = `planning dir not found: ${planningDir}`;
    return result;
  }

  const milestonesPath = path.join(planningDir, 'milestones.md');
  if (!fs.existsSync(milestonesPath)) {
    result.reason = 'milestones.md not found';
    return result;
  }

  const md = safeRead(milestonesPath) || '';
  const sections = splitMilestoneSections(md);
  if (sections.length === 0) {
    result.evidence = 'partial';
    result.reason = 'milestones.md has zero `## M{n}:` sections — file is empty or malformed';
    return result;
  }

  let anyDrilldown = false;
  for (const { milestone, body } of sections) {
    const features = parseFeaturesBlock(body);
    const drilldowns = parseDrilldownBlocks(body);
    result.featureCountByMilestone[milestone] = features.length;
    result.drilldownCountByMilestone[milestone] = drilldowns.size;
    if (drilldowns.size > 0) anyDrilldown = true;

    for (const feat of features) {
      if (!drilldowns.has(feat)) {
        result.missingDrilldowns.push({ milestone, feature: feat });
      }
    }
    for (const [feat, info] of drilldowns) {
      if (info.frCount === 0) {
        result.featuresWithoutFRs.push(`${milestone}/${feat}`);
      }
    }
  }

  if (
    !anyDrilldown &&
    result.missingDrilldowns.length === 0 &&
    Object.values(result.featureCountByMilestone).every((n) => n === 0)
  ) {
    // Sections exist but no Features: blocks and no drill-downs.
    result.evidence = 'partial';
    result.reason = 'milestone sections present but no `**Features:**` blocks or `#### FEAT-NNN` drill-downs found';
    return result;
  }

  if (result.missingDrilldowns.length === 0 && result.featuresWithoutFRs.length === 0) {
    result.passed = true;
    result.evidence = 'present';
  } else {
    result.evidence = anyDrilldown ? 'partial' : 'absent';
    const parts = [];
    if (result.missingDrilldowns.length > 0) {
      parts.push(`${result.missingDrilldowns.length} missing drill-down(s)`);
    }
    if (result.featuresWithoutFRs.length > 0) {
      parts.push(`${result.featuresWithoutFRs.length} drill-down(s) without FR enumeration`);
    }
    result.reason = parts.join('; ');
  }
  return result;
}

// ── Render API (D11 v0.52+) ───────────────────────────────────
//
// Pairs the validator with a deterministic renderer so the v0.51 prompt-only
// rule in milestone-architect.md is no longer the sole defense. When the
// LLM-authored milestones.md omits `#### FEAT-NNN` drill-downs, this function
// derives them from feature-registry.json and appends them at the end of each
// affected `## M{n}:` section. Cross-references FEAT title + boundedContext +
// FR sourceIds straight from the registry — never invents data.

function buildFeatureLookup(registry) {
  // Accept multiple registry shapes: { features: [...] }, { features: {id:...} },
  // { featureRegistry: { features: ... } }, or a top-level array.
  let raw;
  if (Array.isArray(registry)) raw = registry;
  else if (Array.isArray(registry?.features)) raw = registry.features;
  else if (registry?.features && typeof registry.features === 'object') raw = Object.values(registry.features);
  else if (Array.isArray(registry?.featureRegistry?.features)) raw = registry.featureRegistry.features;
  else raw = [];

  const lookup = new Map();
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const id = normalizeFeat(f.id || f.featureId);
    if (!id) continue;
    const sourceIds = Array.isArray(f.sourceIds) ? f.sourceIds : Array.isArray(f.source_ids) ? f.source_ids : [];
    const frs = sourceIds.filter((s) => /^FR-[A-Z0-9]+(?:-[A-Z0-9]+)*$/i.test(String(s)));
    lookup.set(id, {
      title: String(f.title || f.name || `(untitled ${id})`).trim(),
      boundedContext: String(f.boundedContext || f.bc || f.owningContext || 'unspecified').trim(),
      frs,
    });
  }
  return lookup;
}

function renderMissingBlock(milestone, missing, lookup) {
  const out = [
    '',
    `<!-- D11 (v0.52+) auto-rendered drill-downs for ${milestone} via cobolt-milestone-drilldown render -->`,
  ];
  let withData = 0;
  let withoutData = 0;
  for (const featId of missing) {
    const data = lookup.get(featId);
    if (data) {
      out.push(`#### ${featId} — ${data.title} · ${data.boundedContext} BC`);
      out.push(
        `- **FRs (${data.frs.length}):** ${data.frs.length ? data.frs.join(', ') : '_none enumerated in feature-registry_'}`,
      );
      withData += 1;
    } else {
      out.push(`#### ${featId} — (not found in feature-registry.json) · unspecified BC`);
      out.push(`- **FRs (0):** _registry has no entry for ${featId}; investigate cobolt-analyze-features output_`);
      withoutData += 1;
    }
    out.push('');
  }
  return { lines: out, withData, withoutData };
}

function render(planningDir, options = {}) {
  const result = {
    passed: false,
    rendered: 0,
    sectionsTouched: 0,
    skippedNoData: 0,
    dryRun: !!options.dryRun,
    errors: [],
  };

  if (!planningDir || !fs.existsSync(planningDir)) {
    result.errors.push(`planning dir not found: ${planningDir}`);
    return result;
  }

  const milestonesPath = path.join(planningDir, 'milestones.md');
  const registryPath = path.join(planningDir, 'feature-registry.json');

  if (!fs.existsSync(milestonesPath)) {
    result.errors.push('milestones.md not found');
    return result;
  }
  if (!fs.existsSync(registryPath)) {
    result.errors.push('feature-registry.json not found — render needs FEAT title + FR cross-reference');
    return result;
  }

  let registry;
  try {
    registry = JSON.parse(safeRead(registryPath) || '{}');
  } catch (e) {
    result.errors.push(`feature-registry.json parse error: ${e.message}`);
    return result;
  }
  const lookup = buildFeatureLookup(registry);

  const md = safeRead(milestonesPath) || '';
  const lines = md.split(/\r?\n/);

  // Single pass: copy lines through; at each `## M{n}:` boundary flush any
  // accumulated section, deriving + appending missing drill-downs.
  const outLines = [];
  let currentSection = null;
  let currentBody = [];

  const flushSection = () => {
    if (currentSection === null) return;
    outLines.push(...currentBody);
    const sectionText = currentBody.join('\n');
    const features = parseFeaturesBlock(sectionText);
    const drilldowns = parseDrilldownBlocks(sectionText);
    const missing = features.filter((f) => !drilldowns.has(f));
    if (missing.length > 0) {
      const block = renderMissingBlock(currentSection, missing, lookup);
      outLines.push(...block.lines);
      result.rendered += block.withData;
      result.skippedNoData += block.withoutData;
      result.sectionsTouched += 1;
    }
    currentSection = null;
    currentBody = [];
  };

  for (const line of lines) {
    const sectionMatch = line.match(/^##\s+(M\d+)\s*:/i);
    if (sectionMatch) {
      flushSection();
      currentSection = sectionMatch[1].toUpperCase();
      currentBody = [line];
    } else if (currentSection) {
      currentBody.push(line);
    } else {
      outLines.push(line);
    }
  }
  flushSection();

  const newContent = outLines.join('\n');
  if (!options.dryRun && newContent !== md) {
    fs.writeFileSync(milestonesPath, newContent);
  }

  // Render is "passed" when we either rendered something OR validate passes
  // (i.e., nothing needed rendering). Errors flip pass to false.
  result.passed = result.errors.length === 0 && (result.rendered > 0 || validate(planningDir).passed);
  return result;
}

// ── CLI ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { command: 'validate', planning: null, json: false, help: false, dryRun: false };
  // Optional positional command: validate (default) | render
  if (argv[0] === 'validate' || argv[0] === 'render') {
    opts.command = argv.shift();
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--planning') {
      opts.planning = argv[i + 1];
      i += 1;
    }
  }
  return opts;
}

function printUsage(stream = process.stdout) {
  const usage = [
    'Usage:',
    '  node tools/cobolt-milestone-drilldown.js [validate] [--planning <dir>] [--json]',
    '  node tools/cobolt-milestone-drilldown.js render   [--planning <dir>] [--json] [--dry-run]',
    '',
    'Subcommands:',
    '  validate (default)  Validate that milestones.md contains a `#### FEAT-NNN` level-4',
    '                      drill-down per feature inside each `## M{n}:` milestone section,',
    '                      and that each drill-down enumerates at least one FR line.',
    '',
    '  render              D11 (v0.52+). Pairs the validator with a deterministic renderer.',
    '                      Reads milestones.md + feature-registry.json; for each section that',
    '                      lacks a `#### FEAT-NNN` drill-down, derives the block from the',
    '                      registry and appends it at the end of the affected milestone',
    '                      section. Closes the prompt-only-enforcement gap (memory:',
    '                      feedback_prompt_enforcement_fails).',
    '',
    'Options:',
    '  --help, -h           Print this usage and exit 0',
    '  --planning <dir>     Planning directory (default ./_cobolt-output/latest/planning)',
    '  --json               Emit a single JSON object on stdout',
    '  --dry-run            (render only) Compute changes but do not write milestones.md',
    '',
    'Exit codes:',
    '  0  passed (validate: no missing drill-downs; render: at least one rendered or none needed)',
    '  1  failed (validate: missing drill-downs; render: file write or registry parse error)',
    '  2  missing dependency (feature-registry.json absent)',
    '  3  missing infrastructure (planning dir absent)',
    '',
    'Bypass env COBOLT_MILESTONE_DRILLDOWN_GATE:',
    '  block (default)   exit reflects validation',
    '  advisory          always exit 0; findings still printed',
    '  off               always exit 0; "bypassed" printed',
  ].join('\n');
  stream.write(`${usage}\n`);
}

function resolvePlanningDir(arg) {
  if (arg) return path.resolve(arg);
  return path.resolve(process.cwd(), DEFAULT_PLANNING_REL);
}

function emitText(result, mode) {
  const badge = result.passed ? 'PASS' : 'FAIL';
  process.stdout.write(`[${badge}] cobolt-milestone-drilldown — evidence=${result.evidence}\n`);
  if (mode && mode !== 'block') process.stdout.write(`   mode: ${mode}\n`);
  if (result.reason) process.stdout.write(`   reason: ${result.reason}\n`);
  for (const m of result.missingDrilldowns.slice(0, 10)) {
    process.stdout.write(`   • missing drill-down: ${m.milestone}/${m.feature}\n`);
  }
  if (result.missingDrilldowns.length > 10) {
    process.stdout.write(`   … ${result.missingDrilldowns.length - 10} more missing drill-downs\n`);
  }
  for (const f of result.featuresWithoutFRs.slice(0, 10)) {
    process.stdout.write(`   • drill-down without FRs: ${f}\n`);
  }
  if (result.featuresWithoutFRs.length > 10) {
    process.stdout.write(`   … ${result.featuresWithoutFRs.length - 10} more drill-downs missing FR lines\n`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage(process.stdout);
    process.exit(EXIT_OK);
  }

  const planningDir = resolvePlanningDir(opts.planning);

  // Render subcommand short-circuits the validate path. Render writes to disk
  // (unless --dry-run) and returns its own JSON shape.
  if (opts.command === 'render') {
    const renderResult = render(planningDir, { dryRun: opts.dryRun });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(renderResult, null, 2)}\n`);
    } else {
      const badge = renderResult.passed ? 'PASS' : renderResult.errors.length ? 'FAIL' : 'NOOP';
      process.stdout.write(
        `[${badge}] cobolt-milestone-drilldown render — rendered=${renderResult.rendered} ` +
          `sectionsTouched=${renderResult.sectionsTouched} skippedNoData=${renderResult.skippedNoData}` +
          `${renderResult.dryRun ? ' (dry-run)' : ''}\n`,
      );
      for (const err of renderResult.errors.slice(0, 5)) {
        process.stdout.write(`   • error: ${err}\n`);
      }
    }
    process.exit(renderResult.errors.length ? EXIT_FAIL : EXIT_OK);
  }

  const gateMode = String(process.env.COBOLT_MILESTONE_DRILLDOWN_GATE || 'block').toLowerCase();

  // Infrastructure check first.
  if (!fs.existsSync(planningDir)) {
    if (gateMode === 'off') {
      const payload = { mode: 'bypass_env', reason: `planning dir absent: ${planningDir}`, passed: false };
      if (opts.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      else process.stdout.write(`[BYPASS] cobolt-milestone-drilldown bypassed (planning dir absent)\n`);
      process.exit(EXIT_OK);
    }
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ passed: false, evidence: 'absent', reason: `planning dir absent: ${planningDir}`, exit: EXIT_MISSING_INFRA }, null, 2)}\n`,
      );
    } else {
      process.stderr.write(`[cobolt-milestone-drilldown] planning dir not found: ${planningDir}\n`);
    }
    process.exit(EXIT_MISSING_INFRA);
  }

  // Dependency check: feature-registry.json must exist for cross-reference.
  const registryPath = path.join(planningDir, 'feature-registry.json');
  const registryAbsent = !fs.existsSync(registryPath);

  // Run validation regardless of bypass — we still want findings in output.
  const result = validate(planningDir);

  if (gateMode === 'off') {
    const payload = { mode: 'bypass_env', ...result };
    if (opts.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else {
      process.stdout.write(`[BYPASS] cobolt-milestone-drilldown bypassed (COBOLT_MILESTONE_DRILLDOWN_GATE=off)\n`);
      emitText(result, 'bypass_env');
    }
    process.exit(EXIT_OK);
  }
  if (gateMode === 'advisory') {
    const payload = { mode: 'advisory', ...result };
    if (opts.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else emitText(result, 'advisory');
    process.exit(EXIT_OK);
  }

  // Block mode (default).
  if (registryAbsent) {
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ ...result, mode: 'block', dependency: 'feature-registry.json', exit: EXIT_MISSING_DEP }, null, 2)}\n`,
      );
    } else {
      emitText(result, 'block');
      process.stderr.write(`[cobolt-milestone-drilldown] feature-registry.json absent — cannot cross-reference\n`);
    }
    process.exit(EXIT_MISSING_DEP);
  }

  if (opts.json) process.stdout.write(`${JSON.stringify({ mode: 'block', ...result }, null, 2)}\n`);
  else emitText(result, 'block');

  process.exit(result.passed ? EXIT_OK : EXIT_FAIL);
}

if (require.main === module) {
  main();
}

module.exports = {
  validate,
  render,
  buildFeatureLookup,
  renderMissingBlock,
  splitMilestoneSections,
  parseFeaturesBlock,
  parseDrilldownBlocks,
  normalizeFeat,
};
