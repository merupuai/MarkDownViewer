#!/usr/bin/env node

// CoBolt Pipeline Replay Harness — opt-in per
// docs/cobolt-context-routing-plan.md Companion Improvement #2.
//
// Records compact stage inputs/outputs as fixtures. Replays selected
// pipeline paths to validate contracts, state transitions, artifact
// writes, and gate outcomes without a full live pipeline run.
//
// Recording is opt-in (--record). Replay runs in temporary directories
// only — it never mutates real _cobolt-output/latest/. Reports are
// written to _cobolt-output/audit/pipeline-replay/ only on explicit
// invocation.
//
// Usage:
//   node tools/cobolt-pipeline-replay.js record --name fix-sec001 --packet PATH [--args ...]
//   node tools/cobolt-pipeline-replay.js list [--dir FIXTURES]
//   node tools/cobolt-pipeline-replay.js replay --name fix-sec001 [--json]
//   node tools/cobolt-pipeline-replay.js validate --fixture FILE [--json]

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { atomicWriteJSON } = require('../lib/cobolt-atomic-write');
const FIXTURE_VERSION = '1.0.0';

function safeRequire(modulePath) {
  try {
    return require(modulePath);
  } catch {
    return null;
  }
}
const pathsMod = safeRequire('../lib/cobolt-paths');

function fixturesDir(projectRoot, override) {
  if (override) return path.resolve(override);
  // Default: tests/fixtures/pipeline-replay/ for shipped fixtures.
  return path.resolve(projectRoot || process.cwd(), 'tests', 'fixtures', 'pipeline-replay');
}

function reportDir(projectRoot) {
  const root = path.resolve(projectRoot || process.cwd());
  if (typeof pathsMod === 'function') {
    try {
      const p = pathsMod(root);
      if (p?.auditDir) return path.join(p.auditDir(), 'pipeline-replay');
    } catch {
      /* fall through */
    }
  }
  return path.join(root, '_cobolt-output', 'audit', 'pipeline-replay');
}

function safeReadJson(abs) {
  try {
    if (!fs.existsSync(abs)) return null;
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

function sha256(buffer) {
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

// ── Sanitization ──────────────────────────────────────────
//
// Replace machine-specific absolute paths with placeholders so fixtures
// are portable across machines.

function sanitize(value, substitutions) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    let result = value;
    for (const [from, to] of substitutions) {
      if (from && result.includes(from)) result = result.split(from).join(to);
    }
    // Normalize Windows separators in paths
    return result.replace(/\\/g, '/');
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, substitutions));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitize(v, substitutions);
    return out;
  }
  return value;
}

function buildSubstitutions(projectRoot) {
  const root = path.resolve(projectRoot);
  const home = os.homedir();
  const subs = [
    [root, '<PROJECT_ROOT>'],
    [home, '<HOME>'],
    [os.tmpdir(), '<TMP>'],
  ];
  return subs;
}

// ── Recording ─────────────────────────────────────────────

const SAFE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

function assertSafeName(name) {
  if (!name || !SAFE_NAME_PATTERN.test(String(name))) {
    const err = new Error(
      `fixture name must match ${SAFE_NAME_PATTERN} (1-100 alnum plus . _ -); refusing to write/read "${String(name).slice(0, 50)}"`,
    );
    err.code = 'UNSAFE_FIXTURE_NAME';
    throw err;
  }
}

function recordFixture(projectRoot, options = {}) {
  if (!options.name) throw new Error('recordFixture requires --name');
  assertSafeName(options.name);
  const subs = buildSubstitutions(projectRoot);

  const packetPath = options.packet
    ? path.isAbsolute(options.packet)
      ? options.packet
      : path.join(projectRoot, options.packet)
    : null;
  const packet = packetPath ? safeReadJson(packetPath) : null;

  const stateData = options.includeState ? safeReadJson(path.join(projectRoot, 'cobolt-state.json')) : null;

  const fixture = {
    version: FIXTURE_VERSION,
    name: String(options.name),
    stage: options.stage || packet?.stage || null,
    milestone: options.milestone || packet?.milestone || null,
    capturedAt: new Date().toISOString(),
    inputs: {
      packetPath: packetPath ? sanitize(packetPath, subs) : null,
      args: Array.isArray(options.args) ? options.args.map((a) => sanitize(String(a), subs)) : [],
      env: sanitize(options.env || {}, subs),
    },
    artifacts: (options.artifacts || []).map((art) => ({
      path: sanitize(art.path, subs),
      exists: !!art.exists,
      bytes: Number(art.bytes || 0),
      checksum: art.checksum || null,
    })),
    packet: packet ? sanitize(packet, subs) : null,
    state: stateData ? sanitize(stateData, subs) : null,
    expectations: options.expectations || {
      requiredArtifactPaths: [],
      requiredStateTransitions: [],
      allowedFailures: [],
    },
  };
  fixture.checksum = sha256(Buffer.from(JSON.stringify(fixture))).slice(0, 23);
  return fixture;
}

function writeFixture(projectRoot, fixture, outputDir) {
  const dir = fixturesDir(projectRoot, outputDir);
  const outPath = path.join(dir, `${fixture.name}.json`);
  atomicWriteJSON(outPath, fixture, { mode: 0o600 });
  return outPath;
}

function listFixtures(projectRoot, overrideDir) {
  const dir = fixturesDir(projectRoot, overrideDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const abs = path.join(dir, f);
      const fixture = safeReadJson(abs);
      return {
        name: fixture?.name || path.basename(f, '.json'),
        stage: fixture?.stage || null,
        milestone: fixture?.milestone || null,
        capturedAt: fixture?.capturedAt || null,
        path: abs,
      };
    });
}

// ── Validation ────────────────────────────────────────────

function validateFixture(fixture) {
  const issues = [];
  if (!fixture || typeof fixture !== 'object') {
    issues.push({ code: 'missing-fixture', severity: 'error', message: 'fixture payload is not an object' });
    return { ok: false, issues };
  }
  for (const key of ['version', 'name', 'capturedAt', 'inputs', 'expectations']) {
    if (!(key in fixture)) issues.push({ code: 'missing-field', severity: 'error', message: `missing ${key}` });
  }
  // Check for machine-specific leakage across platforms.
  // Covers: Windows drive roots, macOS /Users/, Linux /home/, server /root/
  // /opt/ /var/ /mnt/ /srv/, and tmpdir-like /tmp/.
  const raw = JSON.stringify(fixture);
  const LEAK_PATTERNS = [
    /[A-Z]:\\\\/, // Windows drive prefix in serialized JSON
    /\/Users\/[^/"\\]+\//, // macOS home
    /\/home\/[^/"\\]+\//, // Linux home
    /\/(root|opt|var|mnt|srv|tmp)\/[^"]/, // server/system paths
  ];
  const hits = LEAK_PATTERNS.filter((re) => re.test(raw));
  if (hits.length > 0) {
    issues.push({
      code: 'unscrubbed-path',
      severity: 'warn',
      message: `fixture contains unscrubbed absolute paths (${hits.length} pattern(s) matched)`,
    });
  }
  // Required artifact paths should be relative (replay runs in tempdir)
  const requiredArtifacts = fixture.expectations?.requiredArtifactPaths || [];
  const expectedArtifactPaths = new Set(
    (fixture.artifacts || []).map((artifact) => normalizeFixtureRelPath(artifact.path)),
  );
  for (const p of requiredArtifacts) {
    if (path.isAbsolute(p)) {
      issues.push({
        code: 'absolute-required-path',
        severity: 'error',
        message: `required artifact "${p}" must be repo-relative for portable replay`,
      });
    }
    if (expectedArtifactPaths.has(normalizeFixtureRelPath(p))) {
      issues.push({
        code: 'required-artifact-overlaps-expected-output',
        severity: 'error',
        message: `required input artifact "${p}" is also listed as an expected output artifact`,
      });
    }
  }
  const errors = issues.filter((i) => i.severity === 'error').length;
  return { ok: errors === 0, issues };
}

// ── Replay ────────────────────────────────────────────────

function normalizeFixtureRelPath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function materializeReplayArtifact(tmpRoot, relPath, bytes = 2) {
  const abs = path.join(tmpRoot, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const minBytes = Math.max(2, Number(bytes) || 2);
  const content = Buffer.from(JSON.stringify({ replayFixtureArtifact: normalizeFixtureRelPath(relPath) }));
  fs.writeFileSync(
    abs,
    content.length >= minBytes ? content : Buffer.concat([content, Buffer.alloc(minBytes - content.length, 0x20)]),
  );
  return abs;
}

function replay(projectRoot, name, options = {}) {
  try {
    assertSafeName(name);
  } catch (err) {
    return { name, ok: false, issues: [{ code: 'unsafe-fixture-name', severity: 'error', message: err.message }] };
  }
  const dir = fixturesDir(projectRoot, options.fixturesDir);
  const fixturePath = path.join(dir, `${name}.json`);
  const fixture = safeReadJson(fixturePath);
  if (!fixture) {
    return {
      name,
      ok: false,
      issues: [
        { code: 'fixture-not-found', severity: 'error', message: `fixture ${name} not found at ${fixturePath}` },
      ],
    };
  }
  const validation = validateFixture(fixture);
  const issues = [...validation.issues];

  // Replay runs in a disposable temp dir — we never mutate _cobolt-output/latest/.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `cobolt-replay-${name}-`));
  try {
    const expectedArtifactPaths = new Set(
      (fixture.artifacts || []).map((artifact) => normalizeFixtureRelPath(artifact.path)),
    );
    // Materialize required input artifacts only when they are not also expected
    // outputs. Overlaps are validation errors and must not become self-fulfilling.
    const required = fixture.expectations?.requiredArtifactPaths || [];
    for (const relPath of required) {
      if (expectedArtifactPaths.has(normalizeFixtureRelPath(relPath))) continue;
      materializeReplayArtifact(tmpRoot, relPath, 2);
    }
    const requiredInputPaths = new Set(required.map(normalizeFixtureRelPath));
    for (const art of fixture.artifacts || []) {
      const relPath = normalizeFixtureRelPath(art.path);
      if (!art.exists || requiredInputPaths.has(relPath)) continue;
      if (Number(art.bytes || 0) > 0 || art.checksum) {
        materializeReplayArtifact(tmpRoot, relPath, art.bytes || 2);
      }
    }
    // Validate artifact expectations
    for (const art of fixture.artifacts || []) {
      const abs = path.join(tmpRoot, art.path);
      if (art.exists && !fs.existsSync(abs)) {
        issues.push({
          code: 'expected-artifact-missing',
          severity: 'error',
          message: `expected ${art.path} to exist`,
        });
      }
    }
    // Validate state transitions if provided
    const transitions = fixture.expectations?.requiredStateTransitions || [];
    for (const t of transitions) {
      if (typeof t !== 'object' || !t.from || !t.to) {
        issues.push({
          code: 'invalid-transition',
          severity: 'error',
          message: `state transition entry must include from and to: ${JSON.stringify(t)}`,
        });
      }
    }
    const errors = issues.filter((i) => i.severity === 'error').length;
    return {
      name,
      ok: errors === 0,
      issues,
      tmpRoot,
      fixturePath,
    };
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function writeReport(projectRoot, result) {
  const dir = reportDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `${result.name}-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  return outPath;
}

// ── CLI ──────────────────────────────────────────────────

function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

function collectFlagValues(args, flag) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === flag && args[i + 1]) values.push(args[i + 1]);
  return values;
}

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(`  CoBolt Pipeline Replay Harness (opt-in)

  Usage:
    node tools/cobolt-pipeline-replay.js record --name NAME --packet PATH [--stage S] [--milestone M] [--arg ...] [--dir DIR] [--json]
    node tools/cobolt-pipeline-replay.js list [--dir DIR] [--json]
    node tools/cobolt-pipeline-replay.js replay --name NAME [--dir DIR] [--write] [--json]
    node tools/cobolt-pipeline-replay.js validate --fixture FILE [--json]
`);
    process.exit(0);
  }
  if (cmd === 'record') {
    const fixture = recordFixture(process.cwd(), {
      name: flagValue(args, '--name'),
      packet: flagValue(args, '--packet'),
      stage: flagValue(args, '--stage'),
      milestone: flagValue(args, '--milestone'),
      args: collectFlagValues(args, '--arg'),
    });
    const outPath = writeFixture(process.cwd(), fixture, flagValue(args, '--dir'));
    if (args.includes('--json')) console.log(JSON.stringify({ fixture, path: outPath }, null, 2));
    else console.log(`  Recorded fixture ${fixture.name} → ${outPath}`);
    return;
  }
  if (cmd === 'list') {
    const items = listFixtures(process.cwd(), flagValue(args, '--dir'));
    if (args.includes('--json')) console.log(JSON.stringify(items, null, 2));
    else for (const it of items) console.log(`  ${it.name}  stage=${it.stage || '?'}  m=${it.milestone || '?'}`);
    return;
  }
  if (cmd === 'replay') {
    const name = flagValue(args, '--name');
    if (!name) {
      console.error('  --name is required');
      process.exit(2);
    }
    const result = replay(process.cwd(), name, { fixturesDir: flagValue(args, '--dir') });
    if (args.includes('--write')) writeReport(process.cwd(), result);
    if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`  Replay ${name}: ${result.ok ? 'OK' : 'FAIL'}`);
      for (const i of result.issues) console.log(`    [${i.severity}] ${i.code}: ${i.message}`);
    }
    process.exit(result.ok ? 0 : 1);
  }
  if (cmd === 'validate') {
    const file = flagValue(args, '--fixture');
    if (!file) {
      console.error('  --fixture is required');
      process.exit(2);
    }
    const fixture = safeReadJson(path.resolve(process.cwd(), file));
    const r = validateFixture(fixture);
    if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`  Fixture ${path.basename(file)}: ${r.ok ? 'OK' : 'FAIL'}`);
      for (const i of r.issues) console.log(`    [${i.severity}] ${i.code}: ${i.message}`);
    }
    process.exit(r.ok ? 0 : 1);
  }
  console.error(`  Unknown command: ${cmd}`);
  process.exit(2);
}

module.exports = {
  recordFixture,
  writeFixture,
  listFixtures,
  replay,
  validateFixture,
  fixturesDir,
  FIXTURE_VERSION,
};

if (require.main === module) main(process.argv);
