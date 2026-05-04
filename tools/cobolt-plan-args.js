#!/usr/bin/env node

// cobolt-plan-args — deterministic argument normalizer for /cobolt-plan.
//
// Purpose: when the user passes `--auto` / `--autonomous`, imply
// `--enhance`, `--scope enterprise`, `--rigorous`, and `--arch` unless an explicit opt-out is
// present. Returns a canonical JSON record Claude can read before
// executing the skill, and appends a line to
// `_cobolt-output/audit/auto-defaults.jsonl` for traceability.
//
// Usage:
//   node tools/cobolt-plan-args.js normalize -- <raw-args...>
//   node tools/cobolt-plan-args.js normalize --json -- --auto ./docs
//
// Output (JSON, stdout):
//   {
//     "raw": ["--auto", "./docs"],
//     "auto": true,
//     "enhance": true,          // after defaulting
//     "noEnhance": false,
//     "scope": "enterprise",    // after defaulting
//     "rigorous": true,
//     "resume": false,
//     "positional": ["./docs"],
//     "fromFiles": [],          // v0.46 — structured source-intake flags
//     "fromFolder": null,       // (the normalizer is the single parser)
//     "requirementsDir": null,
//     "audience": null,
//     "planReviewThreshold": "critical",
//     "canonical": ["--auto", "--enhance", "--scope", "enterprise", "--plan-review-threshold", "critical", "--rigorous", "--arch", ...],
//     "applied_defaults": ["enhance=true", "scope=enterprise", "planReviewThreshold=critical", "rigorous=true", "arch=true"],
//     "explicit_overrides": []
//   }
//
// Exit codes:
//   0 — normalized successfully
//   2 — conflicting flags (e.g. --enhance and --no-enhance both present)

const fs = require('node:fs');
const path = require('node:path');

// v0.61 (D17): capture the load error so operators can see WHY --arch was
// silently dropped. Pre-fix, both the require failure and the
// parseAndNormalize throw fell through with `archFlags = { enabled: false }`
// and no audit record — under --auto users had `--arch` silently disabled
// with no log, no checkpoint, no remediation hint.
let archFlagsLoadError = null;
const archFlagsLib = (() => {
  try {
    return require('../lib/cobolt-arch-flags');
  } catch (err) {
    archFlagsLoadError = {
      phase: 'require',
      message: err?.message ? String(err.message) : String(err),
      code: err?.code ? String(err.code) : null,
    };
    return null;
  }
})();
const { VALID_THRESHOLDS, normalizePlanReviewThreshold } = require('../lib/cobolt-plan-review-policy');

const SCOPE_VALUES = new Set(['mvp', 'standard', 'enterprise']);

function hasArchEnableFlag(args) {
  return (
    Array.isArray(args) && args.some((arg) => arg === '--arch' || arg === '--architecture' || arg === '--arch-only')
  );
}

function parseArgs(raw) {
  const out = {
    raw: raw.slice(),
    auto: false,
    enhance: null, // null = not set
    noEnhance: false,
    enhanceExplicit: false,
    noEnhanceExplicit: false,
    scope: null, // null = not set
    rigorous: false,
    resume: false,
    milestones: null,
    positional: [],
    // v0.46 — structured source-intake fields. Pre-v0.46 these were dropped
    // into `positional` alongside the mode argument, fragmenting the parser
    // across cli/commands/plan.js and the SKILL.md prose. Normalizer is now
    // the single authoritative parser per the CoBolt invariant for deterministic
    // argument handling.
    fromFiles: [],
    fromFolder: null,
    requirementsDir: null,
    audience: null,
    planReviewThreshold: null,
  };
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--auto' || a === '--autonomous') {
      out.auto = true;
      continue;
    }
    if (a === '--enhance') {
      out.enhance = true;
      out.enhanceExplicit = true;
      continue;
    }
    if (a === '--no-enhance') {
      out.noEnhance = true;
      out.noEnhanceExplicit = true;
      out.enhance = false;
      continue;
    }
    if (a === '--rigorous') {
      out.rigorous = true;
      continue;
    }
    if (a === '--resume') {
      out.resume = true;
      continue;
    }
    if (a === '--scope') {
      const next = raw[i + 1];
      if (next && SCOPE_VALUES.has(next)) {
        out.scope = next;
        i++;
        continue;
      }
      throw new Error(`--scope requires one of: ${[...SCOPE_VALUES].join(', ')}`);
    }
    if (a.startsWith('--scope=')) {
      const v = a.slice('--scope='.length);
      if (!SCOPE_VALUES.has(v)) throw new Error(`invalid --scope value: ${v}`);
      out.scope = v;
      continue;
    }
    if (a === '--milestones') {
      out.milestones = raw[i + 1];
      i++;
      continue;
    }
    if (a.startsWith('--milestones=')) {
      out.milestones = a.slice('--milestones='.length);
      continue;
    }
    // v0.46 — source-intake flags. Previously unknown-flag path pushed the
    // flag token to positional but left its value (if any) to be
    // mis-classified. Producers (SKILL.md Step 11/L671, cli/commands/plan.js)
    // had to re-parse raw args. Single authoritative parser from here on.
    if (a === '--from-folder') {
      const next = raw[i + 1];
      if (next && !String(next).startsWith('--')) {
        out.fromFolder = next;
        i++;
      } else {
        throw new Error('--from-folder requires a path argument');
      }
      continue;
    }
    if (a.startsWith('--from-folder=')) {
      out.fromFolder = a.slice('--from-folder='.length);
      continue;
    }
    if (a === '--from-files') {
      // Consume subsequent non-flag tokens until next flag or end of args.
      while (i + 1 < raw.length && !String(raw[i + 1]).startsWith('--')) {
        out.fromFiles.push(raw[i + 1]);
        i++;
      }
      if (out.fromFiles.length === 0) {
        throw new Error('--from-files requires at least one file path argument');
      }
      continue;
    }
    if (a.startsWith('--from-files=')) {
      // Comma or space separated list after `=`.
      const list = a
        .slice('--from-files='.length)
        .split(/[,\s]+/)
        .filter(Boolean);
      out.fromFiles.push(...list);
      continue;
    }
    if (a === '--requirements-dir') {
      const next = raw[i + 1];
      if (next && !String(next).startsWith('--')) {
        out.requirementsDir = next;
        i++;
      } else {
        throw new Error('--requirements-dir requires a path argument');
      }
      continue;
    }
    if (a.startsWith('--requirements-dir=')) {
      out.requirementsDir = a.slice('--requirements-dir='.length);
      continue;
    }
    if (a === '--audience') {
      const next = raw[i + 1];
      if (next && !String(next).startsWith('--')) {
        out.audience = next;
        i++;
      } else {
        throw new Error('--audience requires a role argument (e.g. leadership, governance, engineering)');
      }
      continue;
    }
    if (a.startsWith('--audience=')) {
      out.audience = a.slice('--audience='.length);
      continue;
    }
    if (a === '--plan-review-threshold') {
      const next = raw[i + 1];
      const normalized = String(next || '')
        .trim()
        .toLowerCase();
      if (next && !String(next).startsWith('--') && VALID_THRESHOLDS.has(normalized)) {
        out.planReviewThreshold = normalized;
        i++;
      } else {
        throw new Error(`--plan-review-threshold requires one of: ${[...VALID_THRESHOLDS].join(', ')}`);
      }
      continue;
    }
    if (a.startsWith('--plan-review-threshold=')) {
      const rawValue = a.slice('--plan-review-threshold='.length);
      const normalized = String(rawValue || '')
        .trim()
        .toLowerCase();
      if (!VALID_THRESHOLDS.has(normalized)) {
        throw new Error(`invalid --plan-review-threshold value: ${rawValue}`);
      }
      out.planReviewThreshold = normalized;
      continue;
    }
    if (a === '--') continue;
    // Architecture flags — detection here is advisory; shared lib normalizes
    // canonical form. We still track raw positional pass-through so downstream
    // consumers that only inspect raw args see nothing surprising.
    if (
      a === '--arch' ||
      a === '--architecture' ||
      a === '--arch-only' ||
      a === '--arch-gate' ||
      a === '--arch-no-report' ||
      a === '--arch-no-inline-mermaid' ||
      a === '--arch-profile' ||
      a === '--arch-state' ||
      a === '--arch-format' ||
      a.startsWith('--arch-profile=') ||
      a.startsWith('--arch-state=') ||
      a.startsWith('--arch-format=')
    ) {
      // swallow value-taking variants
      if (a === '--arch-profile' || a === '--arch-state' || a === '--arch-format') {
        if (raw[i + 1] && !String(raw[i + 1]).startsWith('--')) i++;
      }
      continue;
    }
    if (a.startsWith('--')) {
      // pass through unknown flags in positional so nothing is silently dropped
      out.positional.push(a);
      continue;
    }
    out.positional.push(a);
  }
  return out;
}

function validateParsedArgs(parsed) {
  if (parsed.enhanceExplicit && parsed.noEnhanceExplicit) {
    throw new Error('--enhance and --no-enhance are mutually exclusive');
  }
  // v0.46 — source-intake mutual-exclusivity: --from-files, --from-folder, and
  // --requirements-dir declare the planning source packet differently.
  // Combining them produces ambiguous provenance (which source wins?). The
  // SKILL.md already assumes one source — surface the conflict at the
  // normalizer rather than silently picking one at skill time.
  const sources = [];
  if (parsed.fromFiles.length > 0) sources.push('--from-files');
  if (parsed.fromFolder) sources.push('--from-folder');
  if (parsed.requirementsDir) sources.push('--requirements-dir');
  if (sources.length > 1) {
    throw new Error(`source-intake flags are mutually exclusive: ${sources.join(' + ')} cannot be combined`);
  }
}

function normalize(parsed) {
  validateParsedArgs(parsed);

  const explicitOverrides = [];
  const appliedDefaults = [];

  // enhance: default true when --auto is present and --no-enhance was not passed.
  let enhance;
  if (parsed.noEnhance) {
    enhance = false;
    explicitOverrides.push('no-enhance');
  } else if (parsed.enhance === true) {
    enhance = true;
    explicitOverrides.push('enhance');
  } else if (parsed.auto) {
    enhance = true;
    appliedDefaults.push('enhance=true');
  } else {
    enhance = false;
  }

  // scope: default "enterprise" when --auto and user did not set scope.
  let scope;
  if (parsed.scope) {
    scope = parsed.scope;
    explicitOverrides.push(`scope=${parsed.scope}`);
  } else if (parsed.auto) {
    scope = 'enterprise';
    appliedDefaults.push('scope=enterprise');
  } else {
    scope = 'standard';
  }

  let planReviewThreshold;
  if (parsed.planReviewThreshold) {
    planReviewThreshold = normalizePlanReviewThreshold(parsed.planReviewThreshold);
    explicitOverrides.push(`plan-review-threshold=${planReviewThreshold}`);
  } else {
    planReviewThreshold = 'critical';
    appliedDefaults.push('planReviewThreshold=critical');
  }

  let rigorous;
  if (parsed.rigorous) {
    rigorous = true;
    explicitOverrides.push('rigorous');
  } else if (parsed.auto) {
    rigorous = true;
    appliedDefaults.push('rigorous=true');
  } else {
    rigorous = false;
  }

  const canonical = [];
  if (parsed.auto) canonical.push('--auto');
  if (enhance) canonical.push('--enhance');
  else if (parsed.noEnhance) canonical.push('--no-enhance');
  canonical.push('--scope', scope);
  canonical.push('--plan-review-threshold', planReviewThreshold);
  if (rigorous) canonical.push('--rigorous');
  if (parsed.resume) canonical.push('--resume');
  if (parsed.milestones) canonical.push('--milestones', String(parsed.milestones));

  // Architecture sidecar: explicit via --arch, or defaulted on under --auto.
  let archFlags = { enabled: false, canonical: [] };
  const archEnabledByAuto = parsed.auto && !hasArchEnableFlag(parsed.raw);
  const archArgs = archEnabledByAuto ? ['--arch', ...parsed.raw] : parsed.raw;
  // v0.61 (D17): track arch-flags failure so operators see why --arch was
  // dropped. Both the require failure (archFlagsLoadError, captured above)
  // and the parseAndNormalize throw write to
  // _cobolt-output/audit/arch-flags-load.jsonl as a Tier 2 audit record.
  let archParseError = null;
  if (archFlagsLib) {
    try {
      archFlags = archFlagsLib.parseAndNormalize(archArgs, { pipelineContext: 'greenfield' });
    } catch (err) {
      archParseError = {
        phase: 'parseAndNormalize',
        message: err?.message ? String(err.message) : String(err),
        code: err?.code ? String(err.code) : null,
      };
      archFlags = { enabled: false, canonical: [] };
    }
  }
  if (archFlags.enabled) {
    canonical.push(...archFlags.canonical);
    if (archEnabledByAuto) appliedDefaults.push('arch=true');
    else explicitOverrides.push('arch=enabled');
  } else if (archEnabledByAuto && (archFlagsLoadError || archParseError)) {
    // --auto implied --arch but the arch-flags library could not produce
    // canonical args. Surface this as an explicit silent-disable record so
    // downstream consumers (and the operator) can see it.
    writeArchFlagsLoadAudit({
      raw: parsed.raw,
      archEnabledByAuto,
      loadError: archFlagsLoadError,
      parseError: archParseError,
    });
  }

  // v0.46 — preserve source-intake flags in canonical output so downstream
  // consumers that rebuild args from canonical (tests, chain-loop, resume
  // recovery) do not silently lose the source packet.
  if (parsed.fromFolder) canonical.push('--from-folder', parsed.fromFolder);
  if (parsed.fromFiles.length > 0) canonical.push('--from-files', ...parsed.fromFiles);
  if (parsed.requirementsDir) canonical.push('--requirements-dir', parsed.requirementsDir);
  if (parsed.audience) canonical.push('--audience', parsed.audience);

  return {
    raw: parsed.raw,
    auto: parsed.auto,
    enhance,
    noEnhance: parsed.noEnhance,
    scope,
    rigorous,
    resume: parsed.resume,
    milestones: parsed.milestones,
    positional: parsed.positional,
    fromFiles: parsed.fromFiles,
    fromFolder: parsed.fromFolder,
    requirementsDir: parsed.requirementsDir,
    audience: parsed.audience,
    planReviewThreshold,
    archFlags,
    canonical,
    applied_defaults: appliedDefaults,
    explicit_overrides: explicitOverrides,
  };
}

function writeAuditRecord(result) {
  try {
    const dir = path.join(process.cwd(), '_cobolt-output', 'audit');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const entry = {
      timestamp: new Date().toISOString(),
      tool: 'cobolt-plan-args',
      raw: result.raw,
      applied_defaults: result.applied_defaults,
      explicit_overrides: result.explicit_overrides,
      canonical: result.canonical,
    };
    fs.appendFileSync(path.join(dir, 'auto-defaults.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    /* best-effort; never fail the skill over audit IO */
  }
}

// v0.61 (D17): emit a Tier 2 audit record when --auto implied --arch but the
// arch-flags library could not produce canonical args (require failed or
// parseAndNormalize threw). Operators see this in
// _cobolt-output/audit/arch-flags-load.jsonl and stderr; the planning
// pipeline still continues but the audit record explains why arch=true was
// dropped from canonical.
function writeArchFlagsLoadAudit({ raw, archEnabledByAuto, loadError, parseError }) {
  const entry = {
    timestamp: new Date().toISOString(),
    tool: 'cobolt-plan-args',
    tier: 'tier-2',
    severity: 'medium',
    class: loadError ? 'arch-flags-require-failed' : 'arch-flags-parse-failed',
    archEnabledByAuto,
    loadError,
    parseError,
    raw,
    remediation: loadError
      ? 'lib/cobolt-arch-flags missing or unreadable — re-run installer (node bin/install.js --claude --global --link)'
      : 'lib/cobolt-arch-flags.parseAndNormalize threw — open issue with this audit record attached',
  };
  try {
    const dir = path.join(process.cwd(), '_cobolt-output', 'audit');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, 'arch-flags-load.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    /* best-effort; audit IO failure must not break the planner */
  }
  try {
    process.stderr.write(
      `[cobolt-plan-args] WARN arch-flags load failed (${entry.class}); --arch dropped from canonical. See _cobolt-output/audit/arch-flags-load.jsonl\n`,
    );
  } catch {
    /* best-effort */
  }
}

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write('usage: cobolt-plan-args normalize [--json] -- <raw args...>\n');
  process.exit(exitCode);
}

function cli(argv) {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') usage(0);
  const [cmd, ...rest] = argv;
  if (cmd !== 'normalize') {
    usage(1);
  }
  const jsonFlagIdx = rest.indexOf('--json');
  const wantJson = jsonFlagIdx !== -1;
  if (wantJson) rest.splice(jsonFlagIdx, 1);
  const sepIdx = rest.indexOf('--');
  const raw = sepIdx === -1 ? rest : rest.slice(sepIdx + 1);

  let parsed;
  try {
    parsed = parseArgs(raw);
  } catch (err) {
    process.stderr.write(`cobolt-plan-args: ${err.message}\n`);
    process.exit(2);
  }

  let result;
  try {
    result = normalize(parsed);
  } catch (err) {
    process.stderr.write(`cobolt-plan-args: ${err.message}\n`);
    process.exit(2);
  }
  writeAuditRecord(result);

  if (wantJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.canonical.join(' ')}\n`);
  }
}

if (require.main === module) {
  cli(process.argv.slice(2));
}

module.exports = { parseArgs, normalize, writeAuditRecord };
