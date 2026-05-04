#!/usr/bin/env node

// CoBolt SLSA L3 Build Provenance Attester (P2.1 / v0.62+).
//
// Emits an in-toto v1.0 attestation per SLSA v1.0 build track Level 3 at
// milestone close. The attestation pins:
//   - subject:       hash of every artifact under _cobolt-output/latest/build/{M}/
//                    plus the SBOM (sbom.cdx.json) when present.
//   - predicate:     SLSA v1.0 provenance with buildDefinition + runDetails.
//   - resolvedDeps:  components from the SBOM (Phase 2.2 dependency).
//
// Why we target L3, not L4:
//   L1: provenance generated. L2: hosted, signed builder. L3: hardened,
//   non-falsifiable provenance. L4: hermetic, two-party-review (deferred to
//   Phase 4.5 with TEE attestation). L3 is the right step for v0.62 — every
//   pipeline artifact is sha-pinned, the producer is identified, and the
//   bypass ledger logs every override. L4 hermetic builds need confidential
//   computing infra that's optional (Phase 4.5).
//
// Standards mapping (Inv-21):
//   SLSA.L3.Hardened        — non-falsifiable provenance.
//   SLSA.L3.Provenance      — consumer-facing predicate.
//   NIST.SSDF.PS.3.1        — archive and protect each release; provenance.
//   NIST.SSDF.PS.3.2        — collect and share provenance for components.
//   NIST.SP-800-204D.§3.4   — supply-chain provenance.
//   in-toto v1.0            — Statement + Predicate envelope shape.
//   EU.CRA.AnnexII.1        — vulnerability + component disclosure.
//
// Public API:
//   generate({ cwd?, milestone, builderId?, sbomPath? }) -> { attestation, paths, ledgerEntryId }
//
// CLI:
//   node tools/cobolt-slsa-attest.js generate --milestone M1 [--cwd <dir>]
//   node tools/cobolt-slsa-attest.js verify <attestation.intoto.json>
//
// Exit codes per tools/CLAUDE.md:
//   0 — attestation generated/verified successfully
//   1 — hard error (missing milestone artifacts, parse failure, write failure)
//   2 — missing optional dep (none currently — pure-Node)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';
const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
const BUILD_TYPE = 'https://cobolt.dev/build@v1';
const DEFAULT_BUILDER_ID = 'https://github.com/merupuai/cobolt';

// ── filesystem walk + digest helpers ──────────────────────────────────

function _sha256File(absPath) {
  const buf = fs.readFileSync(absPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function _walkBuildDir(absDir) {
  const out = [];
  function recurse(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) recurse(abs);
      else if (ent.isFile()) out.push(abs);
    }
  }
  recurse(absDir);
  return out;
}

function _safeReadJson(absPath) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

function _gitInfo(cwd) {
  function run(args) {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  }
  return {
    head: run(['rev-parse', 'HEAD']) || null,
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']) || null,
    remote: run(['remote', 'get-url', 'origin']) || null,
  };
}

// ── milestone-state inputs ────────────────────────────────────────────

function _readState(cwd) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, 'cobolt-state.json'), 'utf8'));
  } catch {
    return {};
  }
}

function _readPackage(cwd) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

function _resolvedDepsFromSbom(sbomPath) {
  const sbom = _safeReadJson(sbomPath);
  if (!sbom || !Array.isArray(sbom.components)) return [];
  // SLSA's resolvedDependencies uses ResourceDescriptor shape:
  //   {uri, digest:{sha256:hex}, name?}
  // We map purl → uri so verifiers can replay the dep set.
  return sbom.components
    .filter((c) => c.purl)
    .map((c) => {
      const desc = { uri: c.purl, name: c.name };
      const sha = (c.hashes || []).find((h) => /SHA-256/i.test(h.alg));
      if (sha) desc.digest = { sha256: sha.content };
      return desc;
    });
}

// ── public generate ───────────────────────────────────────────────────

function _sanitiseMilestone(milestone) {
  if (!milestone) return null;
  if (!/^M\d+$/i.test(String(milestone))) {
    throw new Error(`generate: milestone must match /^M\\d+$/, got "${milestone}"`);
  }
  return String(milestone).toUpperCase();
}

function generate({ cwd, milestone, builderId, sbomPath } = {}) {
  const root = cwd ? path.resolve(cwd) : process.cwd();
  const M = _sanitiseMilestone(milestone);
  if (!M) throw new Error('generate: --milestone <M{n}> required');

  const buildDir = path.join(root, '_cobolt-output', 'latest', 'build', M);
  if (!fs.existsSync(buildDir)) {
    throw new Error(`generate: milestone build dir does not exist: ${path.relative(root, buildDir)}`);
  }

  const state = _readState(root);
  const pkg = _readPackage(root);
  const git = _gitInfo(root);
  const generatedAt = new Date().toISOString();

  // Subject: every file under buildDir, sha256-pinned. The attestation MUST
  // self-cover (i.e. the attestation file itself is excluded from subjects to
  // avoid a chicken-and-egg digest).
  const attestationFileName = `slsa-provenance.intoto.json`;
  const subjectFiles = _walkBuildDir(buildDir).filter((abs) => path.basename(abs) !== attestationFileName);
  const subjects = subjectFiles.map((abs) => ({
    name: path.relative(root, abs).replace(/\\/g, '/'),
    digest: { sha256: _sha256File(abs) },
  }));

  // Resolved dependencies — load SBOM if present, else empty (still valid L3).
  const resolvedSbom = sbomPath ? path.resolve(root, sbomPath) : path.join(buildDir, 'sbom.cdx.json');
  const resolvedDependencies = fs.existsSync(resolvedSbom) ? _resolvedDepsFromSbom(resolvedSbom) : [];

  // External parameters: information that, if changed, would produce a
  // different build. SLSA spec recommends encoding only verifiable inputs.
  const externalParameters = {
    repository: git.remote || null,
    ref: git.branch || null,
    commit: git.head || null,
    milestone: M,
    projectVersion: pkg.version || null,
  };

  // Internal parameters: information that may differ between identical
  // external-input runs (timestamp, runner identity).
  const internalParameters = {
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    pipelineMode: state.mode || 'auto',
  };

  const attestation = {
    _type: STATEMENT_TYPE,
    subject: subjects,
    predicateType: PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: BUILD_TYPE,
        externalParameters,
        internalParameters,
        resolvedDependencies,
      },
      runDetails: {
        builder: {
          id: builderId || DEFAULT_BUILDER_ID,
          version: { 'cobolt-slsa-attest': '0.62.0' },
        },
        metadata: {
          invocationId: `${git.head || 'no-git'}::${M}::${generatedAt}`,
          startedOn: state.lastUpdated || generatedAt,
          finishedOn: generatedAt,
        },
        byproducts: [],
      },
    },
  };

  const attestationPath = path.join(buildDir, attestationFileName);
  fs.writeFileSync(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });

  // Append to unified evidence ledger.
  let ledgerEntryId = null;
  try {
    const evLedger = require('../lib/cobolt-evidence-ledger');
    const attBuf = fs.readFileSync(attestationPath);
    const entry = evLedger.append(
      {
        kind: evLedger.KINDS.SLSA_ATTESTATION,
        producer: 'cobolt-slsa-attest/v0.62.0',
        sha256s: {
          'slsa-provenance.intoto.json': crypto.createHash('sha256').update(attBuf).digest('hex'),
        },
        controlIds: ['SLSA.L3.Hardened', 'SLSA.L3.Provenance', 'NIST.SSDF.PS.3.1', 'NIST.SSDF.PS.3.2'],
        payload: {
          milestone: M,
          subjectCount: subjects.length,
          resolvedDepCount: resolvedDependencies.length,
          builderId: builderId || DEFAULT_BUILDER_ID,
          buildType: BUILD_TYPE,
          gitHead: git.head,
        },
      },
      { projectRoot: root },
    );
    ledgerEntryId = entry.entryId;
  } catch {
    // Tier 3 advisory — attestation still on disk even if ledger append fails.
  }

  return {
    attestation,
    paths: { attestation: attestationPath, sbom: fs.existsSync(resolvedSbom) ? resolvedSbom : null },
    subjectCount: subjects.length,
    resolvedDepCount: resolvedDependencies.length,
    ledgerEntryId,
  };
}

// ── verify (offline schema + digest re-check) ─────────────────────────
//
// Validates: statement type, predicate type, subjects exist on disk and
// hash to the recorded digests. Does NOT verify a Sigstore signature —
// that's cobolt-cosign verify's job (P2.3).

function verify(attestationPath, { cwd } = {}) {
  const root = cwd ? path.resolve(cwd) : process.cwd();
  const att = _safeReadJson(attestationPath);
  if (!att) throw new Error(`verify: cannot parse ${attestationPath}`);
  const errors = [];
  if (att._type !== STATEMENT_TYPE) errors.push(`bad _type: expected ${STATEMENT_TYPE}, got ${att._type}`);
  if (att.predicateType !== PREDICATE_TYPE) {
    errors.push(`bad predicateType: expected ${PREDICATE_TYPE}, got ${att.predicateType}`);
  }
  if (!Array.isArray(att.subject)) errors.push('subject must be an array');
  for (const s of att.subject || []) {
    const abs = path.resolve(root, s.name);
    if (!fs.existsSync(abs)) {
      errors.push(`subject missing on disk: ${s.name}`);
      continue;
    }
    const digest = _sha256File(abs);
    if (digest !== s.digest?.sha256) {
      errors.push(
        `subject digest mismatch: ${s.name} (expected ${s.digest?.sha256?.slice(0, 12)}, got ${digest.slice(0, 12)})`,
      );
    }
  }
  return { ok: errors.length === 0, errors, subjectCount: (att.subject || []).length };
}

module.exports = {
  generate,
  verify,
  PREDICATE_TYPE,
  STATEMENT_TYPE,
  BUILD_TYPE,
  DEFAULT_BUILDER_ID,
};

// ── CLI ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('Usage: node tools/cobolt-slsa-attest.js <command> [args]');
    console.log('Commands:');
    console.log('  generate --milestone M1 [--cwd <dir>] [--builder <url>] [--sbom <path>]');
    console.log('  verify <attestation.intoto.json> [--cwd <dir>]');
    process.exit(0);
  }
  try {
    if (cmd === 'generate') {
      const opts = {};
      for (let i = 1; i < argv.length; i += 1) {
        if (argv[i] === '--milestone') opts.milestone = argv[++i];
        else if (argv[i] === '--cwd') opts.cwd = argv[++i];
        else if (argv[i] === '--builder') opts.builderId = argv[++i];
        else if (argv[i] === '--sbom') opts.sbomPath = argv[++i];
      }
      const r = generate(opts);
      console.log(`[cobolt-slsa-attest] Attestation: ${r.paths.attestation}`);
      console.log(`[cobolt-slsa-attest] Subjects:    ${r.subjectCount}`);
      console.log(`[cobolt-slsa-attest] Resolved deps: ${r.resolvedDepCount}`);
      if (r.paths.sbom) console.log(`[cobolt-slsa-attest] SBOM source: ${r.paths.sbom}`);
      if (r.ledgerEntryId) console.log(`[cobolt-slsa-attest] Ledger entry: ${r.ledgerEntryId}`);
      process.exit(0);
    }
    if (cmd === 'verify') {
      if (!argv[1]) {
        console.error('Usage: verify <attestation.intoto.json>');
        process.exit(1);
      }
      const opts = {};
      for (let i = 2; i < argv.length; i += 1) {
        if (argv[i] === '--cwd') opts.cwd = argv[++i];
      }
      const r = verify(path.resolve(argv[1]), opts);
      if (r.ok) {
        console.log(`[cobolt-slsa-attest] OK — ${r.subjectCount} subject(s) verified`);
        process.exit(0);
      }
      console.error('[cobolt-slsa-attest] FAIL');
      for (const e of r.errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  } catch (err) {
    console.error(`[cobolt-slsa-attest] ${err.message}`);
    process.exit(1);
  }
}
