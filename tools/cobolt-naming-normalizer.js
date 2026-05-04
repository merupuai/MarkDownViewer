#!/usr/bin/env node

// CoBolt Naming Normalizer (v0.51+) — RC-4 fix.
//
// Closes the snake_case drift class observed in the M1 RawDrive incident
// (2026-04-25): impl-spec declared `sign_up_workspace_bootstrap` but the
// builder emitted `signup_workspace_bootstrap.ex` — silent loss of the
// underscore between `sign` and `up`. Step 03A then counted this as a
// missing module path. The same class generalizes to camelCase for JS/TS
// and to module-tree expansion for Elixir context shapes
// ({operations,schema,policy} triplets).
//
// The tool exposes deterministic conversions used by:
//   - spec-architect Rule 6 (validate-path before emitting File Map rows)
//   - cobolt-naming-drift-gate.js (PreToolUse — reject Write of file paths
//     whose snake-segmentation diverges from the impl-spec's File Map)
//
// Subcommands:
//
//   to-snake <name> --lang <elixir|python|rust|go>
//     Returns the canonical snake_case form. Splits on:
//       - existing word boundaries (CamelCase → camel_case)
//       - dashes (sign-up → sign_up)
//       - existing underscores preserved
//       - trailing digits keep their underscore (foo_2 stays foo_2)
//
//   to-camel <name> --lang <js|ts>
//     Returns the canonical camelCase form.
//
//   to-pascal <name> --lang <js|ts|elixir>
//     Returns the canonical PascalCase form (Elixir module names).
//
//   validate-path <feature> <path> --lang <elixir|...>
//     Confirms the path's snake-segmentation matches the canonical form
//     of the feature name. Returns exit 0 / prints "ok" on match,
//     exit 4 / prints diagnostic JSON on mismatch.
//
//   expand-tree <feature> --shape <context|domain|service> --lang elixir
//     Returns the canonical sub-module triplet for an Elixir context.
//     `context` → ['operations.ex','schema.ex','policy.ex'] under
//     <root>/<feature>/. The user's M1 case had this triplet implicit
//     in the impl-spec; this exposes it deterministically so generators
//     and naming-drift-gate can verify.
//
// Exit codes (per tools/CLAUDE.md exit contract):
//   0 = success (string emitted to stdout)
//   1 = usage / unhandled error
//   4 = validate-path mismatch (drift detected)

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_DRIFT = 4;

// --- Token splitting ---------------------------------------------------------

// Split an arbitrary identifier into normalized lowercase tokens. Heuristic:
//   - dashes and underscores are word separators
//   - lower→Upper transitions split (signUp → sign, Up)
//   - digit/letter transitions are preserved together (m1 → m1, foo2 → foo2)
//   - all-caps runs followed by capitalized word split correctly
//     (HTTPHandler → HTTP, Handler)
function splitTokens(name) {
  const s = String(name || '').trim();
  if (!s) return [];
  // Replace dashes with underscores, then split on underscores.
  const segments = s.replace(/-+/g, '_').split(/_+/).filter(Boolean);
  const out = [];
  for (const seg of segments) {
    // Within each segment, split on case transitions.
    // 1) lower→Upper:                   signUp        → sign|Up
    // 2) Upper-run before lower:        HTTPHandler   → HTTP|Handler
    // We handle both with one pass:
    const subs = seg
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/\s+/)
      .filter(Boolean);
    for (const sub of subs) out.push(sub.toLowerCase());
  }
  return out;
}

function toSnake(name) {
  return splitTokens(name).join('_');
}

function toCamel(name) {
  const tokens = splitTokens(name);
  if (tokens.length === 0) return '';
  return tokens.map((t, i) => (i === 0 ? t : t.charAt(0).toUpperCase() + t.slice(1))).join('');
}

function toPascal(name) {
  return splitTokens(name)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join('');
}

// --- Path validation ---------------------------------------------------------

// Extract the basename without extension and compare its snake form against
// the canonical snake form of the feature name. Also walk the parent dir
// names — for Elixir context shapes the directory itself encodes the feature
// (sign_up_workspace_bootstrap/operations.ex).
function validatePath(feature, filePath, lang) {
  const canonicalSnake = toSnake(feature);
  const norm = String(filePath).replace(/\\/g, '/');
  const segments = norm.split('/').filter(Boolean);
  const baseWithExt = segments[segments.length - 1] || '';
  const base = baseWithExt.replace(/\.[^.]+$/, '');

  // Match heuristic per language. For Elixir, the feature can live in either
  // the parent directory (context shape) OR the basename (single-file shape).
  // For all other languages, the basename is authoritative.
  const candidates = [];
  if (lang === 'elixir') {
    candidates.push(base);
    if (segments.length >= 2) candidates.push(segments[segments.length - 2]);
  } else {
    candidates.push(base);
  }

  for (const candidate of candidates) {
    const candSnake = toSnake(candidate);
    if (candSnake === canonicalSnake) {
      return { ok: true, canonical: canonicalSnake, observed: candidate };
    }
  }

  return {
    ok: false,
    canonical: canonicalSnake,
    observed: candidates,
    expectedSegment: canonicalSnake,
    diagnostic: `Snake-case drift: feature "${feature}" canonicalizes to "${canonicalSnake}", but path segments [${candidates.join(', ')}] do not match. Path: ${norm}`,
  };
}

// --- Tree expansion ---------------------------------------------------------

const TREE_SHAPES = {
  elixir: {
    context: ['operations.ex', 'schema.ex', 'policy.ex'],
    domain: ['operations.ex', 'schema.ex', 'policy.ex', 'events.ex'],
    service: ['service.ex', 'client.ex', 'config.ex'],
  },
  ts: {
    context: ['index.ts', 'types.ts', 'service.ts'],
  },
  js: {
    context: ['index.js', 'types.js', 'service.js'],
  },
};

function expandTree(feature, shape, lang) {
  const langTree = TREE_SHAPES[lang];
  if (!langTree) {
    throw new Error(`No tree shapes defined for language: ${lang}`);
  }
  const triplet = langTree[shape];
  if (!triplet) {
    throw new Error(`No tree shape "${shape}" for ${lang}. Known: ${Object.keys(langTree).join(',')}`);
  }
  const root = toSnake(feature);
  return triplet.map((leaf) => `${root}/${leaf}`);
}

// --- CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  const rest = args.slice(1);
  const positional = rest.filter((a) => !a.startsWith('--'));
  const idx = (flag) => rest.indexOf(flag);
  const get = (flag) => (idx(flag) >= 0 ? rest[idx(flag) + 1] : null);
  return {
    cmd,
    positional,
    opts: {
      lang: get('--lang'),
      shape: get('--shape'),
      json: rest.includes('--json'),
    },
  };
}

function printUsage(stream) {
  stream.write(
    `${[
      'Usage: cobolt-naming-normalizer <command> [args]',
      '',
      'Commands:',
      '  to-snake <name> --lang <elixir|python|rust|go>',
      '  to-camel <name> --lang <js|ts>',
      '  to-pascal <name> --lang <js|ts|elixir>',
      '  validate-path <feature> <path> --lang <elixir|...>',
      '  expand-tree <feature> --shape <context|domain|service> --lang <elixir|js|ts>',
      '',
      'Exit codes: 0 OK | 1 usage | 4 validate-path drift detected',
    ].join('\n')}\n`,
  );
}

function main() {
  const { cmd, positional, opts } = parseArgs(process.argv);
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    printUsage(process.stderr);
    process.exit(EXIT_USAGE);
  }
  try {
    switch (cmd) {
      case 'to-snake': {
        const name = positional[0];
        if (!name) throw new Error('to-snake requires a name');
        process.stdout.write(`${toSnake(name)}\n`);
        process.exit(EXIT_OK);
        return;
      }
      case 'to-camel': {
        const name = positional[0];
        if (!name) throw new Error('to-camel requires a name');
        process.stdout.write(`${toCamel(name)}\n`);
        process.exit(EXIT_OK);
        return;
      }
      case 'to-pascal': {
        const name = positional[0];
        if (!name) throw new Error('to-pascal requires a name');
        process.stdout.write(`${toPascal(name)}\n`);
        process.exit(EXIT_OK);
        return;
      }
      case 'validate-path': {
        const [feature, filePath] = positional;
        if (!feature || !filePath) throw new Error('validate-path requires <feature> <path>');
        const lang = opts.lang || 'elixir';
        const result = validatePath(feature, filePath, lang);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          process.stdout.write(result.ok ? 'ok\n' : `${result.diagnostic}\n`);
        }
        process.exit(result.ok ? EXIT_OK : EXIT_DRIFT);
        return;
      }
      case 'expand-tree': {
        const feature = positional[0];
        if (!feature) throw new Error('expand-tree requires a feature name');
        const lang = opts.lang || 'elixir';
        const shape = opts.shape || 'context';
        const tree = expandTree(feature, shape, lang);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ feature, lang, shape, tree }, null, 2)}\n`);
        } else {
          for (const f of tree) process.stdout.write(`${f}\n`);
        }
        process.exit(EXIT_OK);
        return;
      }
      default:
        process.stderr.write(`Unknown command: ${cmd}\n`);
        printUsage(process.stderr);
        process.exit(EXIT_USAGE);
    }
  } catch (err) {
    process.stderr.write(`[cobolt-naming-normalizer] ERROR: ${err.message}\n`);
    process.exit(EXIT_USAGE);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  splitTokens,
  toSnake,
  toCamel,
  toPascal,
  validatePath,
  expandTree,
  TREE_SHAPES,
};
