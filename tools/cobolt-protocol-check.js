#!/usr/bin/env node

// CoBolt Hook Protocol Check — CLI for inspecting the Claude Code hook
// protocol contract that 230+ CoBolt hooks consume.
//
// Subcommands:
//   show                     — print the contract surface (events + fields)
//   pinned                   — print the list of pinned-compatible Claude Code versions
//   detect                   — detect the current Claude Code version
//   validate <event> [<file>]— validate a sample input against an event contract
//                              (reads stdin when <file> is omitted or "-")
//   verdict <event> [<file>] — same as validate, but also prints the
//                              compatibility verdict (permissive vs strict)
//   check                    — CI smoke test: contract module loadable, every
//                              KNOWN_EVENT validates its own wireSnapshot,
//                              schema mirror parses + covers every event.
//                              Quiet on success; one-line failure on regression.
//   doctor                   — operator-facing check summary for cobolt doctor
//
// Exit codes (per repo CLAUDE.md tool exit-code contract):
//   0 — success / OK
//   1 — error (validation failure, unknown event, etc)
//   2 — missing dependency (lib/cobolt-hook-protocol.js not loadable)

const fs = require('node:fs');
const path = require('node:path');

function _safeRequire(p) {
  try {
    return require(p);
  } catch {
    return null;
  }
}

function _loadProtocol() {
  return (
    _safeRequire(path.resolve(__dirname, '..', 'lib', 'cobolt-hook-protocol')) ||
    _safeRequire(path.resolve(__dirname, '..', '..', 'lib', 'cobolt-hook-protocol')) ||
    null
  );
}

function _printHelp() {
  const lines = [
    'cobolt-protocol-check — inspect the Claude Code hook protocol contract',
    '',
    'Usage:',
    '  node tools/cobolt-protocol-check.js <subcommand> [args]',
    '',
    'Subcommands:',
    '  show                       Print the per-event contract surface',
    '  pinned                     Print the pinned-compatible Claude Code versions',
    '  detect                     Detect the current Claude Code version',
    '  validate <event> [<file>]  Validate a sample input against an event contract',
    '                             (reads stdin when <file> omitted or "-")',
    '  verdict  <event> [<file>]  Same as validate, plus the compatibility verdict',
    '  check                      CI smoke test (quiet on success, exit 1 on regression)',
    '  doctor                     Operator-facing protocol doctor summary',
    '  --help, -h                 Show this help (exit 0)',
    '',
    'Events: PreToolUse, PostToolUse, SessionStart, Stop, PreCompact, PostCompact',
    '',
    'Env:',
    '  COBOLT_PROTOCOL_PIN_MODE=strict     opt-in: warn on unrecognized version',
    '  COBOLT_PROTOCOL_VERSION_CHECK=off   silence the SessionStart probe',
    '',
    'See docs/CLAUDE-CODE-PROTOCOL-PINNING.md for the full contract.',
  ];
  console.log(lines.join('\n'));
}

function _readSample(arg) {
  if (!arg || arg === '-') {
    if (process.stdin.isTTY) {
      console.error('Error: no input file given and stdin is a TTY');
      return { err: true };
    }
    try {
      const raw = fs.readFileSync(0, 'utf8');
      return { raw, source: '<stdin>' };
    } catch (e) {
      console.error(`Error: failed to read stdin: ${e.message}`);
      return { err: true };
    }
  }
  try {
    const raw = fs.readFileSync(arg, 'utf8');
    return { raw, source: arg };
  } catch (e) {
    console.error(`Error: failed to read ${arg}: ${e.message}`);
    return { err: true };
  }
}

function _parseSample(raw, source) {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, err: `Invalid JSON in ${source}: ${e.message}` };
  }
}

function cmdShow(protocol) {
  const out = {
    events: protocol.KNOWN_EVENTS,
    contract: {},
    pinnedVersions: protocol.PINNED_CLAUDE_CODE_VERSIONS,
  };
  for (const ev of protocol.KNOWN_EVENTS) {
    const c = protocol.PROTOCOL[ev];
    out.contract[ev] = {
      required: c.required,
      optional: c.optional,
      wireSnapshot: c.wireSnapshot,
    };
  }
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

function cmdPinned(protocol) {
  for (const v of protocol.PINNED_CLAUDE_CODE_VERSIONS) console.log(v);
  return 0;
}

function cmdDetect(protocol) {
  const info = protocol.detectClaudeCodeVersion({});
  console.log(JSON.stringify(info, null, 2));
  return 0;
}

function cmdValidate(protocol, args) {
  const event = args[0];
  if (!event) {
    console.error('Error: validate requires <event> argument');
    return 1;
  }
  const sample = _readSample(args[1]);
  if (sample.err) return 1;
  const parsed = _parseSample(sample.raw, sample.source);
  if (!parsed.ok) {
    console.error(parsed.err);
    return 1;
  }
  const result = protocol.validateHookInput(event, parsed.value);
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

function cmdCheck(protocol) {
  // CI smoke: prove the contract module is wired correctly without producing
  // noisy stdout. Three invariants:
  //   1. KNOWN_EVENTS is non-empty.
  //   2. Every event's documented wireSnapshot validates against its own contract.
  //   3. The JSON Schema mirror parses + has a $defs entry for every KNOWN_EVENT.
  // Exit 0 when all three pass, exit 1 with a one-line cause on first failure.
  if (!Array.isArray(protocol.KNOWN_EVENTS) || protocol.KNOWN_EVENTS.length === 0) {
    console.error('check: KNOWN_EVENTS is empty');
    return 1;
  }
  for (const ev of protocol.KNOWN_EVENTS) {
    const sample = protocol.PROTOCOL[ev]?.wireSnapshot;
    if (!sample) {
      console.error(`check: PROTOCOL.${ev}.wireSnapshot missing`);
      return 1;
    }
    const r = protocol.validateHookInput(ev, sample);
    if (!r.ok) {
      console.error(`check: PROTOCOL.${ev}.wireSnapshot fails its own validator: ${r.reason}`);
      return 1;
    }
  }
  let schema;
  try {
    const schemaPath = path.resolve(__dirname, '..', 'source', 'schemas', 'hook-protocol.schema.json');
    schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  } catch (e) {
    console.error(`check: schema mirror unreadable: ${e.message}`);
    return 1;
  }
  for (const ev of protocol.KNOWN_EVENTS) {
    if (!schema?.$defs?.[ev]) {
      console.error(`check: schema mirror missing $defs.${ev}`);
      return 1;
    }
  }
  return 0;
}

function cmdDoctor(protocol) {
  const exitCode = cmdCheck(protocol);
  const versionInfo = protocol.detectClaudeCodeVersion({});
  const pinned = protocol.isVersionPinned(versionInfo.version);
  console.log(`Hook protocol doctor: ${exitCode === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  Detected Claude Code: ${versionInfo.version} (${versionInfo.source})`);
  console.log(`  Version pinned: ${pinned ? 'yes' : 'no'}`);
  console.log(`  Contract events: ${protocol.KNOWN_EVENTS.join(', ')}`);
  console.log('  Guide: docs/CLAUDE-CODE-PROTOCOL-PINNING.md');
  return exitCode;
}

function cmdVerdict(protocol, args) {
  const event = args[0];
  if (!event) {
    console.error('Error: verdict requires <event> argument');
    return 1;
  }
  const sample = _readSample(args[1]);
  if (sample.err) return 1;
  const parsed = _parseSample(sample.raw, sample.source);
  if (!parsed.ok) {
    console.error(parsed.err);
    return 1;
  }
  const validation = protocol.validateHookInput(event, parsed.value);
  const versionInfo = protocol.detectClaudeCodeVersion({});
  const verdict = protocol.compatibilityVerdict(versionInfo.version, validation, {});
  console.log(
    JSON.stringify(
      {
        validation,
        versionInfo,
        verdict,
      },
      null,
      2,
    ),
  );
  // Exit 1 only when the verdict says action=warn — gives CI a clean signal.
  return verdict.action === 'warn' ? 1 : 0;
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    _printHelp();
    return 0;
  }

  const protocol = _loadProtocol();
  if (!protocol) {
    console.error('Error: lib/cobolt-hook-protocol.js not loadable');
    return 2;
  }

  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'show':
      return cmdShow(protocol);
    case 'pinned':
      return cmdPinned(protocol);
    case 'detect':
      return cmdDetect(protocol);
    case 'validate':
      return cmdValidate(protocol, rest);
    case 'verdict':
      return cmdVerdict(protocol, rest);
    case 'check':
      return cmdCheck(protocol);
    case 'doctor':
      return cmdDoctor(protocol);
    default:
      console.error(`Error: unknown subcommand "${sub}". See --help.`);
      return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main };
