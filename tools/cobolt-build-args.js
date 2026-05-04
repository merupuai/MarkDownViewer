#!/usr/bin/env node

// cobolt-build-args — deterministic argument normalizer for /cobolt-build.
//
// Purpose:
//   - Make build argument parsing single-source and deterministic.
//   - Eliminate silent-drop of unknown flags into shell arrays.
//   - Preserve a canonical flag list for downstream state/bootstrap calls.
//   - Append an audit trail to _cobolt-output/audit/build-auto-defaults.jsonl.
//
// Usage:
//   node tools/cobolt-build-args.js normalize -- --auto M2
//   node tools/cobolt-build-args.js normalize --json -- --milestone=M3 --parallel
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

function normalizeMilestone(value) {
  const match = String(value || '')
    .trim()
    .match(/^M?(\d+)$/i);
  return match ? `M${Number.parseInt(match[1], 10)}` : null;
}

function parseBooleanFlag(flag, rawValue) {
  const value = String(rawValue || '')
    .trim()
    .toLowerCase();
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new Error(`${flag} requires one of: true, false, 1, 0`);
}

function setMilestone(out, rawValue, source) {
  const milestone = normalizeMilestone(rawValue);
  if (!milestone) {
    throw new Error(`${source} requires milestone format M{n}`);
  }
  if (out.milestone && out.milestone !== milestone) {
    throw new Error(`conflicting milestone values: ${out.milestone} and ${milestone}`);
  }
  out.milestone = milestone;
}

function parseArgs(raw) {
  const out = {
    raw: raw.slice(),
    auto: false,
    resume: false,
    parallel: false,
    // v0.66.5 (Wave 3a A-3a-3): --lightweight requests single-orchestrator,
    // class-aware build for small projects. The flag plumbs through to
    // applyAutoDefaults's canonical output here; behavioral integration
    // (round/step skipping based on project-class, single-orchestrator
    // dispatch suppression) is Wave 3b. Honors COBOLT_BUILD_LIGHTWEIGHT=1.
    lightweight: process.env.COBOLT_BUILD_LIGHTWEIGHT === '1',
    milestone: null,
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

    if (arg === '--parallel') {
      out.parallel = true;
      out.explicit_overrides.push('parallel');
      continue;
    }
    if (arg.startsWith('--parallel=')) {
      out.parallel = parseBooleanFlag('--parallel', arg.slice('--parallel='.length));
      out.explicit_overrides.push('parallel');
      continue;
    }

    if (arg === '--lightweight') {
      out.lightweight = true;
      out.explicit_overrides.push('lightweight');
      continue;
    }
    if (arg.startsWith('--lightweight=')) {
      out.lightweight = parseBooleanFlag('--lightweight', arg.slice('--lightweight='.length));
      out.explicit_overrides.push('lightweight');
      continue;
    }

    if (arg === '--milestone') {
      const next = raw[i + 1];
      if (!next || String(next).startsWith('--')) {
        throw new Error('--milestone requires a value like M1');
      }
      setMilestone(out, next, '--milestone');
      out.explicit_overrides.push('milestone');
      i += 1;
      continue;
    }
    if (arg.startsWith('--milestone=')) {
      setMilestone(out, arg.slice('--milestone='.length), '--milestone');
      out.explicit_overrides.push('milestone');
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

  if (out.positional.length > 0) {
    throw new Error(`unexpected positional argument(s): ${out.positional.join(', ')}`);
  }

  return out;
}

function applyAutoDefaults(parsed) {
  const appliedDefaults = [];
  const milestone = parsed.milestone || 'M1';
  if (!parsed.milestone) {
    appliedDefaults.push('milestone=M1');
  }

  const canonical = [milestone];
  if (parsed.auto) canonical.push('--auto');
  if (parsed.resume) canonical.push('--resume');
  if (parsed.parallel) canonical.push('--parallel');
  // v0.66.5 (Wave 3a A-3a-3): --lightweight surfaced in canonical so SKILL.md
  // resume calls preserve the flag across handoffs.
  if (parsed.lightweight) canonical.push('--lightweight');

  return {
    raw: parsed.raw,
    auto: parsed.auto,
    resume: parsed.resume,
    parallel: parsed.parallel,
    lightweight: parsed.lightweight,
    milestone,
    positional: parsed.positional,
    canonical,
    applied_defaults: appliedDefaults,
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
      tool: 'cobolt-build-args',
      raw: result.raw,
      canonical: result.canonical,
      applied_defaults: result.applied_defaults,
      explicit_overrides: result.explicit_overrides,
    };
    fs.appendFileSync(path.join(auditDir, 'build-auto-defaults.jsonl'), `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    /* best effort */
  }
}

function printUsage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write('Usage: cobolt-build-args normalize [--json] -- <raw args...>\n');
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
    process.stderr.write(`cobolt-build-args: ${error.message}\n`);
    process.exit(EXIT_USAGE);
  }

  let result;
  try {
    result = normalize(parsed);
  } catch (error) {
    process.stderr.write(`cobolt-build-args: ${error.message}\n`);
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
  parseArgs,
  normalize,
  applyAutoDefaults,
  writeAuditTrail,
  normalizeMilestone,
};
