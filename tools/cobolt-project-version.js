#!/usr/bin/env node

// CoBolt Project Version — greenfield-first single-source-of-truth for the
// user-project's own semver. Greenfield init seeds .cobolt/project-version.json
// at 0.0.1; this tool drives every subsequent bump, mirror sync, drift check,
// and history ledger entry.
//
// Brownfield/inflight projects (cobolt-state.projectVersion.mode === 'native')
// are NO-OPs here — their authoritative manifest is the ecosystem file
// (package.json / Cargo.toml / mix.exs / pyproject.toml / pom.xml). This tool
// prints the detected source and exits 0 without writing.
//
// Usage:
//   node tools/cobolt-project-version.js show [--json]
//   node tools/cobolt-project-version.js bump <patch|minor|major|prerelease|release|set>
//                                         [--to X.Y.Z] [--milestone M1]
//                                         [--reason "..."] [--by "..."]
//                                         [--stage build] [--pre alpha]
//                                         [--dry-run] [--json]
//   node tools/cobolt-project-version.js sync [--dry-run] [--json]
//   node tools/cobolt-project-version.js check [--json]
//   node tools/cobolt-project-version.js history [--limit 10] [--json]
//   node tools/cobolt-project-version.js init [--version 0.0.1]  # idempotent
//
// Exit codes (tools/CLAUDE.md contract):
//   0  success / no drift
//   1  hard error (missing file, invalid args, schema violation, drift in `check`)
//   2  n/a  (no optional dep paths in this tool)
//   3  n/a

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

const PROJECT_VERSION_REL = path.join('.cobolt', 'project-version.json');
const STATE_FILE = 'cobolt-state.json';
const DEFAULT_INITIAL = '0.0.1';
const SCHEMA_MARKER = 'https://github.com/merupuai/cobolt/schemas/project-version.schema.json';
const SCHEMA_MARKER_LEGACY = 'cobolt-project-version/v1';
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const HISTORY_CAP = 50;

// ── pure helpers ─────────────────────────────────────────────

function parseSemver(v) {
  const m = SEMVER_RE.exec(String(v || '').trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] || null,
    build: m[5] || null,
  };
}

function formatSemver(s) {
  let out = `${s.major}.${s.minor}.${s.patch}`;
  if (s.pre) out += `-${s.pre}`;
  if (s.build) out += `+${s.build}`;
  return out;
}

/**
 * Apply a semver bump. Pure — no disk I/O.
 * @param {string} current
 * @param {'patch'|'minor'|'major'|'prerelease'|'release'|'set'} type
 * @param {{to?:string, pre?:string}} [opts]
 * @returns {string}
 */
function bumpSemver(current, type, opts = {}) {
  const s = parseSemver(current);
  if (!s) throw new Error(`invalid semver: ${current}`);
  switch (type) {
    case 'patch':
      return formatSemver({ ...s, patch: s.patch + 1, pre: null, build: null });
    case 'minor':
      return formatSemver({ ...s, minor: s.minor + 1, patch: 0, pre: null, build: null });
    case 'major':
      return formatSemver({ ...s, major: s.major + 1, minor: 0, patch: 0, pre: null, build: null });
    case 'prerelease': {
      const pre = opts.pre || 'alpha';
      // If already on the same pre-release track, increment its numeric tail; otherwise seed .0.
      if (s.pre?.startsWith(`${pre}`)) {
        const tail = s.pre.split('.').pop();
        const n = /^\d+$/.test(tail) ? Number(tail) + 1 : 0;
        const head = s.pre.endsWith(`.${tail}`) ? s.pre.slice(0, -(tail.length + 1)) : s.pre;
        return formatSemver({ ...s, pre: `${head}.${n}` });
      }
      return formatSemver({ ...s, pre: `${pre}.0` });
    }
    case 'release':
      // Strip pre-release + build metadata without stepping numbers.
      return formatSemver({ ...s, pre: null, build: null });
    case 'set': {
      const to = opts.to;
      if (!parseSemver(to)) throw new Error(`--to must be valid semver (got: ${to})`);
      return String(to);
    }
    default:
      throw new Error(`unknown bump type: ${type}`);
  }
}

function shortHash(input) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function safeReadJson(file) {
  const raw = safeRead(file);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJsonPretty(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function detectCommitSha(projectDir) {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

/** Plan hash = short sha over milestones.md + rtm.json (best-effort). */
function computePlanHash(projectDir) {
  const mPath = path.join(projectDir, '_cobolt-output', 'latest', 'planning', 'milestones.md');
  const rPath = path.join(projectDir, '_cobolt-output', 'latest', 'planning', 'rtm.json');
  const parts = [];
  const m = safeRead(mPath);
  if (m) parts.push(`milestones:${m}`);
  const r = safeRead(rPath);
  if (r) parts.push(`rtm:${r}`);
  if (parts.length === 0) return null;
  return shortHash(parts.join('\n'));
}

// ── state / file accessors ───────────────────────────────────

function resolveProjectDir(explicit) {
  return explicit || process.cwd();
}

function readState(projectDir) {
  return safeReadJson(path.join(projectDir, STATE_FILE));
}

function readCentral(projectDir) {
  return safeReadJson(path.join(projectDir, PROJECT_VERSION_REL));
}

/**
 * Determine the version source for this project.
 * @returns {{mode:'central'|'native'|'missing', path:string|null, version:string|null, payload:object|null}}
 */
function resolveSource(projectDir) {
  const state = readState(projectDir);
  const rec = state?.projectVersion;
  const centralAbs = path.join(projectDir, PROJECT_VERSION_REL);
  const centralExists = fs.existsSync(centralAbs);

  if (rec?.mode === 'native' && rec.source) {
    // Native-mode projects are managed by the ecosystem manifest — not this tool.
    const nativeAbs = path.join(projectDir, rec.source);
    let version = null;
    if (rec.source.endsWith('.json')) {
      version = safeReadJson(nativeAbs)?.version || null;
    }
    return { mode: 'native', path: rec.source, version, payload: null };
  }

  if (centralExists) {
    const payload = readCentral(projectDir);
    return {
      mode: 'central',
      path: PROJECT_VERSION_REL,
      version: payload?.version || null,
      payload,
    };
  }

  return { mode: 'missing', path: null, version: null, payload: null };
}

function discoverMirrors(projectDir, payload, state) {
  const fromPayload = Array.isArray(payload?.mirrors) ? payload.mirrors : [];
  const fromState = Array.isArray(state?.projectVersion?.mirrors) ? state.projectVersion.mirrors : [];
  const merged = new Set([...fromPayload, ...fromState]);
  // Auto-add package.json if present and not already listed.
  if (fs.existsSync(path.join(projectDir, 'package.json'))) merged.add('package.json');
  return [...merged];
}

/**
 * Rewrite a manifest file's `"version": "x.y.z"` in place. Supports JSON, TOML
 * (Cargo.toml, pyproject.toml), Elixir mix.exs, Maven pom.xml, Gradle.
 */
function writeMirrorVersion(absPath, newVersion) {
  const raw = fs.readFileSync(absPath, 'utf8');
  if (absPath.endsWith('.json')) {
    const swapped = raw.replace(/"version"\s*:\s*"\d+\.\d+\.\d+([-+][^"]+)?"/, `"version": "${newVersion}"`);
    if (swapped !== raw) {
      fs.writeFileSync(absPath, swapped, 'utf8');
      return true;
    }
    const parsed = JSON.parse(raw);
    if (parsed.version === newVersion) return false;
    parsed.version = newVersion;
    fs.writeFileSync(absPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    return true;
  }
  if (absPath.endsWith('.toml')) {
    const next = raw.replace(/^(\s*version\s*=\s*)["'][^"']+["']/m, `$1"${newVersion}"`);
    if (next === raw) return false;
    fs.writeFileSync(absPath, next, 'utf8');
    return true;
  }
  if (absPath.endsWith('.exs')) {
    const next = raw.replace(/(version:\s*)["'][^"']+["']/, `$1"${newVersion}"`);
    if (next === raw) return false;
    fs.writeFileSync(absPath, next, 'utf8');
    return true;
  }
  if (absPath.endsWith('.xml')) {
    const next = raw.replace(/<version>[^<]+<\/version>/, `<version>${newVersion}</version>`);
    if (next === raw) return false;
    fs.writeFileSync(absPath, next, 'utf8');
    return true;
  }
  if (absPath.endsWith('.gradle') || absPath.endsWith('.gradle.kts')) {
    const next = raw.replace(/^(\s*version\s*=?\s*)["'][^"']+["']/m, `$1"${newVersion}"`);
    if (next === raw) return false;
    fs.writeFileSync(absPath, next, 'utf8');
    return true;
  }
  throw new Error(`unsupported mirror: ${path.basename(absPath)}`);
}

function readMirrorVersion(absPath) {
  const raw = safeRead(absPath);
  if (raw == null) return null;
  if (absPath.endsWith('.json')) {
    try {
      return JSON.parse(raw).version || null;
    } catch {
      return null;
    }
  }
  const m =
    raw.match(/^\s*version\s*=\s*["']([^"']+)["']/m) ||
    raw.match(/version:\s*["']([^"']+)["']/) ||
    raw.match(/<version>([^<]+)<\/version>/);
  return m ? m[1].trim() : null;
}

// ── high-level operations ────────────────────────────────────

/**
 * Read or seed the central payload. For greenfield projects that never ran
 * cobolt-init the tool can still produce the file at 0.0.1 on demand.
 */
function ensureCentral(projectDir, initial = DEFAULT_INITIAL) {
  const existing = readCentral(projectDir);
  if (existing) return existing;
  const now = new Date().toISOString();
  const payload = {
    $schema: SCHEMA_MARKER,
    version: initial,
    mode: 'central',
    source: 'cobolt-project-version',
    initializedAt: now,
    bumpedAt: now,
    bumpedBy: 'cobolt-project-version.init',
    stage: 'init',
    milestone: null,
    commitSha: detectCommitSha(projectDir),
    planHash: computePlanHash(projectDir),
    mirrors: fs.existsSync(path.join(projectDir, 'package.json')) ? ['package.json'] : [],
    history: [
      {
        version: initial,
        from: null,
        at: now,
        bumpType: 'init',
        reason: 'initial seed',
        milestone: null,
        by: 'cobolt-project-version',
        commitSha: null,
        planHash: null,
      },
    ],
  };
  writeJsonPretty(path.join(projectDir, PROJECT_VERSION_REL), payload);
  return payload;
}

/**
 * Apply a bump to the central file, write mirrors, append history.
 * Returns { ok, from, to, mirrors: [{path, ok, error?}], payload, skipped }.
 */
function applyBump(projectDir, type, opts = {}) {
  const src = resolveSource(projectDir);
  if (src.mode === 'native') {
    return {
      ok: true,
      skipped: true,
      reason: `native-mode project — ${src.path} is authoritative; no bump applied`,
      mode: src.mode,
      path: src.path,
      version: src.version,
    };
  }

  let payload = src.payload;
  if (!payload) {
    // No file yet — seed 0.0.1 then apply the bump on top for deterministic semantics.
    payload = ensureCentral(projectDir);
  }

  const from = payload.version;
  const to = bumpSemver(from, type, { to: opts.to, pre: opts.pre });
  if (to === from && type !== 'set') {
    return { ok: false, skipped: true, reason: `bump is a no-op (${from} → ${to})`, from, to };
  }

  const now = new Date().toISOString();
  const nextPayload = {
    ...payload,
    $schema: payload.$schema === SCHEMA_MARKER_LEGACY ? SCHEMA_MARKER_LEGACY : SCHEMA_MARKER,
    version: to,
    mode: 'central',
    source: opts.by || payload.source || 'cobolt-project-version',
    bumpedAt: now,
    bumpedBy: opts.by || 'cobolt-project-version',
    stage: opts.stage || payload.stage || null,
    milestone: opts.milestone || payload.milestone || null,
    commitSha: detectCommitSha(projectDir),
    planHash: computePlanHash(projectDir),
  };
  // Ensure mirrors array is fresh and package.json is auto-included when present.
  nextPayload.mirrors = discoverMirrors(projectDir, payload, readState(projectDir));

  const entry = {
    version: to,
    from,
    at: now,
    bumpType: type,
    reason: opts.reason || `${type} bump`,
    milestone: opts.milestone || null,
    by: opts.by || 'cobolt-project-version',
    commitSha: nextPayload.commitSha,
    planHash: nextPayload.planHash,
  };
  nextPayload.history = [...(payload.history || []), entry].slice(-HISTORY_CAP);

  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      from,
      to,
      payload: nextPayload,
      mirrorsPlanned: nextPayload.mirrors,
    };
  }

  writeJsonPretty(path.join(projectDir, PROJECT_VERSION_REL), nextPayload);

  const mirrorResults = [];
  for (const rel of nextPayload.mirrors) {
    const abs = path.join(projectDir, rel);
    if (!fs.existsSync(abs)) {
      mirrorResults.push({ path: rel, ok: false, error: 'missing' });
      continue;
    }
    try {
      const changed = writeMirrorVersion(abs, to);
      mirrorResults.push({ path: rel, ok: true, changed });
    } catch (err) {
      mirrorResults.push({ path: rel, ok: false, error: err.message });
    }
  }

  return { ok: true, from, to, payload: nextPayload, mirrors: mirrorResults };
}

/**
 * Drift check: every mirror must match central. Returns { ok, drifts: [] }.
 */
function checkDrift(projectDir) {
  const src = resolveSource(projectDir);
  if (src.mode === 'native') {
    return {
      ok: true,
      mode: 'native',
      source: src.path,
      version: src.version,
      drifts: [],
      note: 'native-mode project — ecosystem manifest is authoritative; drift is out of scope',
    };
  }
  if (src.mode === 'missing') {
    return {
      ok: false,
      mode: 'missing',
      drifts: [],
      error: `no ${PROJECT_VERSION_REL} — run cobolt-init or 'cobolt-project-version init'`,
    };
  }
  const authoritative = src.version;
  const drifts = [];
  const mirrors = discoverMirrors(projectDir, src.payload, readState(projectDir));
  for (const rel of mirrors) {
    const abs = path.join(projectDir, rel);
    if (!fs.existsSync(abs)) {
      drifts.push({ path: rel, status: 'missing', actual: null, expected: authoritative });
      continue;
    }
    const actual = readMirrorVersion(abs);
    if (actual !== authoritative) {
      drifts.push({ path: rel, status: 'drift', actual, expected: authoritative });
    }
  }
  return { ok: drifts.length === 0, mode: 'central', version: authoritative, mirrors, drifts };
}

/** Re-apply the authoritative version to every mirror. */
function syncMirrors(projectDir, { dryRun = false } = {}) {
  const src = resolveSource(projectDir);
  if (src.mode !== 'central') {
    return {
      ok: true,
      skipped: true,
      reason: src.mode === 'native' ? 'native-mode' : 'no central file',
    };
  }
  const version = src.version;
  const mirrors = discoverMirrors(projectDir, src.payload, readState(projectDir));
  const results = [];
  for (const rel of mirrors) {
    const abs = path.join(projectDir, rel);
    if (!fs.existsSync(abs)) {
      results.push({ path: rel, ok: false, error: 'missing' });
      continue;
    }
    const before = readMirrorVersion(abs);
    if (before === version) {
      results.push({ path: rel, ok: true, changed: false });
      continue;
    }
    if (dryRun) {
      results.push({ path: rel, ok: true, changed: true, dryRun: true, before });
      continue;
    }
    try {
      writeMirrorVersion(abs, version);
      results.push({ path: rel, ok: true, changed: true, before });
    } catch (err) {
      results.push({ path: rel, ok: false, error: err.message });
    }
  }
  return { ok: results.every((r) => r.ok), version, mirrors: results };
}

// ── CLI ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function emit(json, obj) {
  if (json) {
    console.log(JSON.stringify(obj, null, 2));
  }
}

function printHelp() {
  console.log(`cobolt-project-version — CoBolt central version manager

  show                             Print current version + metadata
  bump <type>                      patch | minor | major | prerelease | release | set
                                   Flags: --to X.Y.Z (required for 'set')
                                          --milestone Mn --reason "..." --by "..."
                                          --stage build --pre alpha --dry-run --json
  sync [--dry-run] [--json]        Propagate central version to every mirror
  check [--json]                   Exit 1 on mirror drift
  history [--limit 10] [--json]    Print bump history ledger
  init [--version 0.0.1]           Idempotent create of .cobolt/project-version.json

Source of truth: .cobolt/project-version.json (central mode).
Native-mode projects (brownfield/inflight) are no-ops — the ecosystem
manifest is authoritative and is recorded in cobolt-state.projectVersion.
`);
}

function main(argv) {
  const args = parseArgs(argv.slice(2));
  const cmd = args._[0];
  const json = !!args.json;
  const projectDir = resolveProjectDir(null);

  if (!cmd || cmd === 'help' || cmd === '--help') {
    printHelp();
    return 0;
  }

  try {
    switch (cmd) {
      case 'show': {
        const src = resolveSource(projectDir);
        if (src.mode === 'missing') {
          if (json) emit(true, { mode: 'missing', error: `no ${PROJECT_VERSION_REL}` });
          else console.error(`no ${PROJECT_VERSION_REL} — run /cobolt-init or this tool's 'init' subcommand`);
          return 1;
        }
        if (json) {
          emit(true, src);
        } else {
          console.log(`version:  ${src.version}`);
          console.log(`mode:     ${src.mode}`);
          console.log(`source:   ${src.path}`);
          if (src.payload) {
            console.log(`milestone:${src.payload.milestone ?? '(none)'}`);
            console.log(`stage:    ${src.payload.stage ?? '(none)'}`);
            console.log(`bumpedAt: ${src.payload.bumpedAt ?? src.payload.initializedAt}`);
            console.log(`bumpedBy: ${src.payload.bumpedBy ?? '(unset)'}`);
            console.log(`mirrors:  ${(src.payload.mirrors || []).join(', ') || '(none)'}`);
            console.log(`history:  ${(src.payload.history || []).length} entries`);
          }
        }
        return 0;
      }
      case 'init': {
        const initial = args.version || DEFAULT_INITIAL;
        if (!parseSemver(initial)) {
          console.error(`invalid --version: ${initial}`);
          return 1;
        }
        const payload = ensureCentral(projectDir, initial);
        if (json) emit(true, { ok: true, payload });
        else console.log(`initialized at ${payload.version}`);
        return 0;
      }
      case 'bump': {
        const type = args._[1];
        if (!['patch', 'minor', 'major', 'prerelease', 'release', 'set'].includes(type)) {
          console.error('bump type must be one of: patch | minor | major | prerelease | release | set');
          return 1;
        }
        const result = applyBump(projectDir, type, {
          to: args.to,
          pre: args.pre,
          milestone: args.milestone,
          reason: args.reason,
          by: args.by,
          stage: args.stage,
          dryRun: !!args['dry-run'],
        });
        if (json) emit(true, result);
        else if (result.skipped) console.log(`skipped: ${result.reason}`);
        else console.log(`${result.from} → ${result.to}${result.dryRun ? ' (dry-run)' : ''}`);
        return result.ok === false ? 1 : 0;
      }
      case 'sync': {
        const result = syncMirrors(projectDir, { dryRun: !!args['dry-run'] });
        if (json) emit(true, result);
        else if (result.skipped) console.log(`skipped: ${result.reason}`);
        else {
          console.log(`sync @ ${result.version}`);
          for (const m of result.mirrors) {
            const tag = m.ok ? (m.changed ? 'UPDATED' : 'OK') : 'ERROR';
            console.log(`  ${tag.padEnd(8)} ${m.path}${m.error ? ` — ${m.error}` : ''}`);
          }
        }
        return result.ok ? 0 : 1;
      }
      case 'check': {
        const result = checkDrift(projectDir);
        if (json) emit(true, result);
        else if (result.mode === 'native') console.log(`native-mode (${result.source}): skipped`);
        else if (result.mode === 'missing') console.error(result.error);
        else if (result.ok) console.log(`OK — ${result.version} across ${result.mirrors.length} mirror(s)`);
        else {
          console.error(`DRIFT @ authoritative ${result.version}`);
          for (const d of result.drifts) {
            console.error(`  ${d.path}: expected ${d.expected} actual ${d.actual ?? '(missing)'}`);
          }
        }
        return result.ok ? 0 : 1;
      }
      case 'history': {
        const src = resolveSource(projectDir);
        if (src.mode !== 'central') {
          if (json) emit(true, { mode: src.mode, history: [] });
          else console.log(`history unavailable in ${src.mode} mode`);
          return src.mode === 'missing' ? 1 : 0;
        }
        const limit = Number(args.limit || 20);
        const entries = (src.payload.history || []).slice(-limit);
        if (json) emit(true, { version: src.version, history: entries });
        else {
          for (const e of entries) {
            console.log(
              `${e.at}  ${(e.bumpType || '').padEnd(10)} ${e.from ?? '—'} → ${e.version}${e.milestone ? `  [${e.milestone}]` : ''}  ${e.reason || ''}`,
            );
          }
          if (entries.length === 0) console.log('(no history)');
        }
        return 0;
      }
      default:
        console.error(`unknown command: ${cmd}`);
        printHelp();
        return 1;
    }
  } catch (err) {
    if (json) emit(true, { ok: false, error: err.message, stack: err.stack });
    else console.error(`error: ${err.message}`);
    return 1;
  }
}

// ── exports ──────────────────────────────────────────────────

module.exports = {
  PROJECT_VERSION_REL,
  SCHEMA_MARKER,
  DEFAULT_INITIAL,
  parseSemver,
  bumpSemver,
  resolveSource,
  readCentral,
  ensureCentral,
  applyBump,
  checkDrift,
  syncMirrors,
  computePlanHash,
  discoverMirrors,
  readMirrorVersion,
  writeMirrorVersion,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv));
}
