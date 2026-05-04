#!/usr/bin/env node

// cobolt-file-ownership-claim — PR-2 of build-pipeline redesign (v0.53.0).
//
// Resolves a write target path against file-ownership.json (per
// file-ownership.schema.json) and either confirms the calling agent owns the
// glob or records a conflict. Used by cobolt-source-write-ownership-gate
// (PreToolUse, PR-5).
//
// Modes:
//   resolve --path FILE [--agent NAME]  → look up owner, exit 0/1
//   claim   --path FILE --agent NAME    → if ok, no-op; else append conflict entry
//   verify  [--manifest PATH]           → validate manifest shape only
//
// Usage:
//   node tools/cobolt-file-ownership-claim.js resolve --path src/api/foo.ts --agent backend-dev
//   node tools/cobolt-file-ownership-claim.js claim --path src/api/foo.ts --agent backend-dev
//   node tools/cobolt-file-ownership-claim.js verify
//
// Exit codes: 0 ok / owner matches, 1 conflict, 2 manifest missing, 3 manifest unreadable.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MANIFEST = path.join('_cobolt-output', 'latest', 'planning', 'file-ownership.json');

function loadManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return { ok: false, exit: 2, error: `manifest not found: ${manifestPath}` };
  try {
    return { ok: true, manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) };
  } catch (err) {
    return { ok: false, exit: 3, error: `manifest parse error: ${err.message}` };
  }
}

// Minimal glob matcher: supports **, *, /, no character classes. Sufficient
// for src/** style globs in the manifest. False positives are preferable to
// false negatives — when in doubt the gate reports a conflict for human review.
function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 1;
      // eat trailing slash if any
      if (glob[i + 1] === '/') i += 1;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal regex metacharacter set
    } else if ('.+()|^${}\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function matchOwner(targetPath, manifest) {
  const matches = [];
  for (const owner of manifest.owners || []) {
    const re = globToRegex(owner.glob);
    if (re.test(targetPath)) matches.push(owner);
  }
  // Most-specific glob wins (longest non-wildcard prefix).
  matches.sort((a, b) => specificity(b.glob) - specificity(a.glob));
  return matches[0] || null;
}

function specificity(glob) {
  // Count non-wildcard characters before the first wildcard.
  const idx = glob.indexOf('*');
  return idx < 0 ? glob.length * 2 : idx;
}

function resolve({ manifestPath, targetPath, agent } = {}) {
  manifestPath = manifestPath || DEFAULT_MANIFEST;
  const loaded = loadManifest(manifestPath);
  if (!loaded.ok) return { ok: false, _exit: loaded.exit, error: loaded.error };
  const owner = matchOwner(targetPath, loaded.manifest);
  if (!owner) {
    return {
      schema: 'cobolt-file-ownership-claim@1',
      ok: true,
      verdict: 'unowned',
      targetPath,
      owner: null,
    };
  }
  if (!agent) {
    return {
      schema: 'cobolt-file-ownership-claim@1',
      ok: true,
      verdict: 'matched-without-agent-check',
      targetPath,
      owner: owner.agent,
      glob: owner.glob,
      scope: owner.scope,
      concurrencyPolicy: owner.concurrencyPolicy || 'exclusive',
    };
  }
  if (owner.agent === agent) {
    return {
      schema: 'cobolt-file-ownership-claim@1',
      ok: true,
      verdict: 'owner-matches',
      targetPath,
      owner: owner.agent,
    };
  }
  // Sharded: search for the calling agent in shards[]
  if (owner.concurrencyPolicy === 'sharded' && Array.isArray(owner.shards)) {
    for (const shard of owner.shards) {
      if (shard.agent === agent && globToRegex(shard.subGlob).test(targetPath)) {
        return {
          schema: 'cobolt-file-ownership-claim@1',
          ok: true,
          verdict: 'sharded-allowed',
          targetPath,
          owner: owner.agent,
          shard: shard.subGlob,
        };
      }
    }
  }
  return {
    schema: 'cobolt-file-ownership-claim@1',
    ok: false,
    _exit: 1,
    verdict: 'conflict',
    targetPath,
    declaredOwner: owner.agent,
    actualWriter: agent,
    glob: owner.glob,
    scope: owner.scope,
  };
}

function claim({ manifestPath, targetPath, agent } = {}) {
  manifestPath = manifestPath || DEFAULT_MANIFEST;
  const result = resolve({ manifestPath, targetPath, agent });
  if (result.ok) return result;
  // Record conflict (append-only). Does NOT mutate ownership.
  const loaded = loadManifest(manifestPath);
  if (!loaded.ok) return result;
  const conflicts = loaded.manifest.conflicts || [];
  conflicts.push({
    path: targetPath,
    declaredOwner: result.declaredOwner,
    actualWriter: result.actualWriter,
    resolvedAt: new Date().toISOString(),
    resolution: 'kept-declared-owner',
    scope: result.scope,
  });
  loaded.manifest.conflicts = conflicts;
  fs.writeFileSync(manifestPath, `${JSON.stringify(loaded.manifest, null, 2)}\n`, { mode: 0o600 });
  return result;
}

function verify({ manifestPath } = {}) {
  manifestPath = manifestPath || DEFAULT_MANIFEST;
  const loaded = loadManifest(manifestPath);
  if (!loaded.ok) return { ok: false, _exit: loaded.exit, error: loaded.error };
  const m = loaded.manifest;
  const errors = [];
  if (typeof m.version !== 'string') errors.push('missing version');
  if (!Array.isArray(m.owners)) errors.push('owners must be an array');
  for (const o of m.owners || []) {
    if (!o.glob || !o.agent || !o.scope) errors.push(`incomplete owner entry: ${JSON.stringify(o)}`);
  }
  return {
    schema: 'cobolt-file-ownership-claim@1',
    ok: errors.length === 0,
    verdict: errors.length === 0 ? 'valid' : 'invalid',
    manifestPath,
    errors,
    ownerCount: (m.owners || []).length,
    conflictCount: (m.conflicts || []).length,
  };
}

function printHelp() {
  process.stdout.write(
    `cobolt-file-ownership-claim — file ownership resolution\n\n` +
      `Usage:\n` +
      `  node tools/cobolt-file-ownership-claim.js resolve --path FILE [--agent NAME] [--manifest PATH] [--json]\n` +
      `  node tools/cobolt-file-ownership-claim.js claim   --path FILE --agent NAME [--manifest PATH] [--json]\n` +
      `  node tools/cobolt-file-ownership-claim.js verify  [--manifest PATH] [--json]\n` +
      `Exit: 0 ok, 1 conflict, 2 manifest missing, 3 manifest unreadable\n`,
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--path') args.targetPath = argv[++i];
    else if (a === '--agent') args.agent = argv[++i];
    else if (a === '--manifest') args.manifestPath = argv[++i];
    else if (a === '--json') args.json = true;
  }
  return args;
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return 0;
  }
  const cmd = argv[0];
  if (!cmd) {
    printHelp();
    return 0;
  }
  const args = parseArgs(argv.slice(1));
  let result;
  if (cmd === 'resolve') result = resolve(args);
  else if (cmd === 'claim') result = claim(args);
  else if (cmd === 'verify') result = verify(args);
  else {
    process.stderr.write(`unknown command: ${cmd}\n`);
    return 1;
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok === false) {
    process.stderr.write(
      `${result.verdict || 'error'}: ${result.error || `${result.declaredOwner} owns ${result.glob}, not ${result.actualWriter}`}\n`,
    );
  } else {
    process.stdout.write(`${result.verdict}\n`);
  }
  if (result._exit) return result._exit;
  return result.ok === false ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { resolve, claim, verify, matchOwner, globToRegex };
