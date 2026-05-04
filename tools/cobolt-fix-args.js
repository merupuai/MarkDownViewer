#!/usr/bin/env node

// cobolt-fix-args — deterministic argument normalizer for /cobolt-fix.
//
// Purpose:
//   - Eliminate inline shell parsing and silent catch-all branches.
//   - Preserve the standalone error-text surface without treating it as a bug.
//   - Normalize resume/from-step aliases to canonical fix step ids.
//   - Append an audit trail to _cobolt-output/audit/fix-auto-defaults.jsonl.
//
// Usage:
//   node tools/cobolt-fix-args.js normalize -- --autonomous M2 --build-pipeline
//   node tools/cobolt-fix-args.js normalize --json -- TypeError in auth.js
//
// Exit codes:
//   0 — normalized successfully
//   1 — usage / parse error (including unknown flags)
//   2 — conflicting inputs

const fs = require('node:fs');
const path = require('node:path');
const { paths } = require('../lib/cobolt-paths');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_CONFLICT = 2;

const FIX_STEPS = [
  { id: '01', file: '01-recon', label: 'Recon' },
  { id: '02', file: '02-preflight', label: 'Preflight and Phantom Filter' },
  { id: '03', file: '03-fix-routing', label: 'Fix Routing' },
  { id: '04', file: '04-fix-execution', label: 'Fix Execution' },
  { id: '04b', file: '04b-arch-mutate', label: 'Architecture Mutation' },
  { id: '05', file: '05-verification', label: 'Verification' },
  { id: '06', file: '06-rca-generation', label: 'RCA Generation' },
];

function normalizeMilestone(value) {
  const match = String(value || '')
    .trim()
    .match(/^M?(\d+)$/i);
  return match ? `M${Number.parseInt(match[1], 10)}` : null;
}

function normalizeFixStep(value) {
  if (!value) return null;
  const normalized = String(value).trim().toLowerCase();
  for (const step of FIX_STEPS) {
    const labelKey = step.label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (
      normalized === step.id.toLowerCase() ||
      normalized === step.file ||
      normalized === step.label.toLowerCase() ||
      normalized === labelKey
    ) {
      return step.id;
    }
  }
  return null;
}

function parseBooleanFlag(flag, rawValue) {
  const value = String(rawValue || '')
    .trim()
    .toLowerCase();
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new Error(`${flag} requires one of: true, false, 1, 0`);
}

function setSingleValue(out, field, value, label) {
  if (value === null || value === undefined || value === '') {
    throw new Error(`${label} requires a value`);
  }
  if (out[field] && out[field] !== value) {
    throw new Error(`conflicting ${label} values: ${out[field]} and ${value}`);
  }
  out[field] = value;
}

function setMilestone(out, rawValue, source) {
  const milestone = normalizeMilestone(rawValue);
  if (!milestone) {
    throw new Error(`${source} requires milestone format M{n}`);
  }
  setSingleValue(out, 'milestone', milestone, 'milestone');
}

function setFromStep(out, rawValue, source) {
  const step = normalizeFixStep(rawValue);
  if (!step) {
    throw new Error(`${source} requires one of: ${FIX_STEPS.map((entry) => entry.id).join(', ')}`);
  }
  setSingleValue(out, 'fromStep', step, '--from-step');
}

function parseArgs(raw) {
  const out = {
    raw: raw.slice(),
    auto: false,
    buildPipeline: false,
    singleMilestone: false,
    resume: false,
    milestone: null,
    fromStep: null,
    analysisId: null,
    positional: [],
    explicit_overrides: [],
  };

  for (let i = 0; i < raw.length; i += 1) {
    const arg = raw[i];

    if (arg === '--') continue;

    if (arg === '--auto' || arg === '--autonomous') {
      out.auto = true;
      out.explicit_overrides.push('auto');
      continue;
    }
    if (arg.startsWith('--auto=')) {
      out.auto = parseBooleanFlag('--auto', arg.slice('--auto='.length));
      out.explicit_overrides.push('auto');
      continue;
    }
    if (arg.startsWith('--autonomous=')) {
      out.auto = parseBooleanFlag('--autonomous', arg.slice('--autonomous='.length));
      out.explicit_overrides.push('auto');
      continue;
    }

    if (arg === '--build-pipeline') {
      out.buildPipeline = true;
      out.explicit_overrides.push('buildPipeline');
      continue;
    }
    if (arg.startsWith('--build-pipeline=')) {
      out.buildPipeline = parseBooleanFlag('--build-pipeline', arg.slice('--build-pipeline='.length));
      out.explicit_overrides.push('buildPipeline');
      continue;
    }

    if (arg === '--single-milestone') {
      out.singleMilestone = true;
      out.explicit_overrides.push('singleMilestone');
      continue;
    }
    if (arg.startsWith('--single-milestone=')) {
      out.singleMilestone = parseBooleanFlag('--single-milestone', arg.slice('--single-milestone='.length));
      out.explicit_overrides.push('singleMilestone');
      continue;
    }

    if (arg === '--resume') {
      out.resume = true;
      out.explicit_overrides.push('resume');
      continue;
    }
    if (arg.startsWith('--resume=')) {
      out.resume = parseBooleanFlag('--resume', arg.slice('--resume='.length));
      out.explicit_overrides.push('resume');
      continue;
    }

    if (arg === '--analysis') {
      const next = raw[i + 1];
      if (!next || String(next).startsWith('--')) {
        throw new Error('--analysis requires an id');
      }
      setSingleValue(out, 'analysisId', next, '--analysis');
      out.explicit_overrides.push('analysisId');
      i += 1;
      continue;
    }
    if (arg.startsWith('--analysis=')) {
      setSingleValue(out, 'analysisId', arg.slice('--analysis='.length), '--analysis');
      out.explicit_overrides.push('analysisId');
      continue;
    }

    if (arg === '--from-step') {
      const next = raw[i + 1];
      if (!next || String(next).startsWith('--')) {
        throw new Error('--from-step requires a fix step id');
      }
      setFromStep(out, next, '--from-step');
      out.explicit_overrides.push('fromStep');
      i += 1;
      continue;
    }
    if (arg.startsWith('--from-step=')) {
      setFromStep(out, arg.slice('--from-step='.length), '--from-step');
      out.explicit_overrides.push('fromStep');
      continue;
    }

    if (/^M\d+$/i.test(arg)) {
      setMilestone(out, arg, 'milestone');
      out.explicit_overrides.push('milestone');
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`unknown flag: ${arg}`);
    }

    out.positional.push(arg);
  }

  return out;
}

function applyAutoDefaults(parsed) {
  const mode = parsed.auto || parsed.singleMilestone || Boolean(parsed.analysisId) ? 'pipeline' : 'standalone';
  const errorText = parsed.positional.join(' ').trim();
  const canonical = [];

  if (parsed.milestone) canonical.push(parsed.milestone);
  if (parsed.analysisId) canonical.push('--analysis', parsed.analysisId);
  if (parsed.auto) canonical.push('--autonomous');
  if (parsed.buildPipeline) canonical.push('--build-pipeline');
  if (parsed.singleMilestone) canonical.push('--single-milestone');
  if (parsed.resume) canonical.push('--resume');
  if (parsed.fromStep) canonical.push('--from-step', parsed.fromStep);
  canonical.push(...parsed.positional);

  return {
    raw: parsed.raw,
    mode,
    auto: parsed.auto,
    buildPipeline: parsed.buildPipeline,
    singleMilestone: parsed.singleMilestone,
    resume: parsed.resume,
    milestone: parsed.milestone,
    fromStep: parsed.fromStep,
    analysisId: parsed.analysisId,
    positional: parsed.positional,
    errorText,
    canonical,
    applied_defaults: [],
    explicit_overrides: [...new Set(parsed.explicit_overrides)],
  };
}

function normalize(parsed) {
  return applyAutoDefaults(parsed);
}

function writeAuditTrail(result, projectRoot = process.cwd()) {
  try {
    const auditDir = paths(projectRoot).audit();
    const record = {
      timestamp: new Date().toISOString(),
      tool: 'cobolt-fix-args',
      raw: result.raw,
      mode: result.mode,
      canonical: result.canonical,
      milestone: result.milestone,
      fromStep: result.fromStep,
      buildPipeline: result.buildPipeline,
      singleMilestone: result.singleMilestone,
      resume: result.resume,
      analysisId: result.analysisId,
      explicit_overrides: result.explicit_overrides,
    };
    fs.appendFileSync(path.join(auditDir, 'fix-auto-defaults.jsonl'), `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    /* best effort */
  }
}

function printUsage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(
    'Usage: cobolt-fix-args normalize [--json] -- [M{n}] [--autonomous|--auto] [--build-pipeline] [--single-milestone] [--resume] [--from-step <id>] [--analysis <id>] ["<error text>"]\n',
  );
  process.exit(exitCode);
}

function cli(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    printUsage(EXIT_OK);
  }

  const [command, ...rest] = argv;
  if (command !== 'normalize') {
    printUsage(EXIT_USAGE);
  }

  const wantJson = rest.includes('--json');
  const filtered = rest.filter((arg) => arg !== '--json');
  const separatorIndex = filtered.indexOf('--');
  const raw = separatorIndex === -1 ? filtered : filtered.slice(separatorIndex + 1);

  let parsed;
  try {
    parsed = parseArgs(raw);
  } catch (error) {
    process.stderr.write(`cobolt-fix-args: ${error.message}\n`);
    process.exit(EXIT_USAGE);
  }

  let result;
  try {
    result = normalize(parsed);
  } catch (error) {
    process.stderr.write(`cobolt-fix-args: ${error.message}\n`);
    process.exit(EXIT_CONFLICT);
  }

  writeAuditTrail(result);

  if (wantJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.canonical.join(' ')}\n`);
  }
  process.exit(EXIT_OK);
}

if (require.main === module) {
  cli(process.argv.slice(2));
}

module.exports = {
  FIX_STEPS,
  applyAutoDefaults,
  normalize,
  normalizeFixStep,
  normalizeMilestone,
  parseArgs,
  writeAuditTrail,
};
