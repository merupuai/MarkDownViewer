#!/usr/bin/env node

// CoBolt Sigstore Signing Wrapper (P2.3 / v0.62+).
//
// Thin wrapper around the `cosign` CLI for signing SBOMs and SLSA
// attestations at release time. Produces detached signatures (`.sig`) and
// publishes to the Sigstore Rekor transparency log unless an air-gapped
// internal Rekor is configured via COBOLT_PRIVATE_REKOR.
//
// Why a wrapper rather than re-implementing Sigstore in Node:
//   - Cosign is the canonical implementation; verifiers worldwide accept it.
//   - Keyless OIDC flow requires browser interaction the first time; cosign
//     handles this. Rolling our own would replay a half-baked OAuth dance.
//   - Air-gap deployments need swappable Rekor URLs — cosign supports
//     COSIGN_REKOR_URL and we forward via COBOLT_PRIVATE_REKOR.
//
// Standards mapping (Inv-21):
//   NIST.SSDF.PS.2.1            — verifiable release integrity (signed releases).
//   NIST.SP-800-204D.§3.6       — supply-chain signing.
//   OpenSSF Scorecard "Signed-Releases".
//   EU.CRA.AnnexI.1.4           — protect availability of essential functions
//                                  (signed update authenticity).
//
// Public API:
//   isAvailable() -> { available, version?, reason? }
//   signBlob({ file, cwd?, output? }) -> { signaturePath, certificatePath?, ledgerEntryId }
//   verifyBlob({ file, signature, certificate?, cwd? }) -> { ok, errors }
//   signAll({ cwd?, milestone }) -> { signed: [{file, signaturePath, ...}], skipped: [...] }
//
// CLI:
//   node tools/cobolt-cosign.js status
//   node tools/cobolt-cosign.js sign-blob <file> [--output <sig>]
//   node tools/cobolt-cosign.js verify-blob <file> --signature <sig> [--cert <cert>]
//   node tools/cobolt-cosign.js sign-milestone --milestone M1 [--cwd <dir>]
//
// Exit codes per tools/CLAUDE.md:
//   0 — signature(s) generated/verified successfully
//   1 — hard error (invalid input, signing failure, verify failure)
//   2 — missing optional dep: `cosign` binary not in PATH

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function _which(binary) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(cmd, [binary], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/)[0].trim() || null;
}

function _cosignVersion(cosignPath) {
  const r = spawnSync(cosignPath || 'cosign', ['version'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  // cosign prints multi-line; the first line typically includes "GitVersion: vX.Y.Z"
  const m = r.stdout.match(/GitVersion:\s*(v?\d+\.\d+\.\d+\S*)/);
  return m ? m[1] : null;
}

function isAvailable() {
  const found = _which('cosign');
  if (!found) {
    return {
      available: false,
      reason: 'cosign binary not found in PATH. Install from https://docs.sigstore.dev/system_config/installation/',
    };
  }
  const version = _cosignVersion(found);
  return { available: true, version, path: found };
}

function _resolveRekorUrl() {
  // Air-gap option: enterprise users point at an internal Rekor instance.
  // Setting COSIGN_REKOR_URL is what cosign actually consults; we map our
  // friendlier var to it without overwriting any explicit setting.
  if (process.env.COBOLT_PRIVATE_REKOR && !process.env.COSIGN_REKOR_URL) {
    return process.env.COBOLT_PRIVATE_REKOR;
  }
  return null;
}

// ── core sign / verify primitives ─────────────────────────────────────

function signBlob({ file, cwd, output, identity, oidcIssuer } = {}) {
  if (!file) throw new Error('signBlob: file path required');
  const root = cwd ? path.resolve(cwd) : process.cwd();
  const absFile = path.resolve(root, file);
  if (!fs.existsSync(absFile)) throw new Error(`signBlob: file not found: ${file}`);
  const avail = isAvailable();
  if (!avail.available) {
    const err = new Error(avail.reason);
    err.code = 'COSIGN_MISSING';
    throw err;
  }

  const sigPath = output ? path.resolve(root, output) : `${absFile}.sig`;
  const certPath = `${absFile}.cert`;

  const args = ['sign-blob', '--yes', '--output-signature', sigPath, '--output-certificate', certPath];
  if (identity) args.push('--identity-token', identity); // CI flow
  if (oidcIssuer) args.push('--oidc-issuer', oidcIssuer);

  const env = { ...process.env };
  const rekor = _resolveRekorUrl();
  if (rekor) env.COSIGN_REKOR_URL = rekor;

  args.push(absFile);
  const r = spawnSync('cosign', args, { encoding: 'utf8', env, cwd: root });
  if (r.status !== 0) {
    const err = new Error(`cosign sign-blob failed (exit ${r.status}): ${r.stderr || r.stdout}`);
    err.code = 'COSIGN_SIGN_FAILED';
    throw err;
  }

  // Append to evidence ledger.
  let ledgerEntryId = null;
  try {
    const evLedger = require('../lib/cobolt-evidence-ledger');
    const fileBuf = fs.readFileSync(absFile);
    const sigBuf = fs.readFileSync(sigPath);
    const certBuf = fs.existsSync(certPath) ? fs.readFileSync(certPath) : null;
    const sha256s = {
      file: crypto.createHash('sha256').update(fileBuf).digest('hex'),
      signature: crypto.createHash('sha256').update(sigBuf).digest('hex'),
    };
    if (certBuf) sha256s.certificate = crypto.createHash('sha256').update(certBuf).digest('hex');
    const entry = evLedger.append(
      {
        kind: evLedger.KINDS.CHECK_RESULT,
        producer: 'cobolt-cosign/v0.62.0',
        sha256s,
        controlIds: ['NIST.SSDF.PS.2.1', 'EU.CRA.AnnexI.1.4'],
        payload: {
          op: 'sign-blob',
          file: path.relative(root, absFile),
          signature: path.relative(root, sigPath),
          certificate: certBuf ? path.relative(root, certPath) : null,
          cosignVersion: avail.version,
          rekorUrl: rekor || 'public',
        },
      },
      { projectRoot: root },
    );
    ledgerEntryId = entry.entryId;
  } catch {
    // Tier 3 advisory.
  }

  return {
    signaturePath: sigPath,
    certificatePath: fs.existsSync(certPath) ? certPath : null,
    ledgerEntryId,
  };
}

function verifyBlob({ file, signature, certificate, identity, oidcIssuer, cwd } = {}) {
  if (!file || !signature) throw new Error('verifyBlob: file and signature paths required');
  const root = cwd ? path.resolve(cwd) : process.cwd();
  const avail = isAvailable();
  if (!avail.available) {
    const err = new Error(avail.reason);
    err.code = 'COSIGN_MISSING';
    throw err;
  }

  const args = ['verify-blob', '--signature', path.resolve(root, signature)];
  if (certificate) args.push('--certificate', path.resolve(root, certificate));
  if (identity) args.push('--certificate-identity', identity);
  if (oidcIssuer) args.push('--certificate-oidc-issuer', oidcIssuer);
  args.push(path.resolve(root, file));

  const env = { ...process.env };
  const rekor = _resolveRekorUrl();
  if (rekor) env.COSIGN_REKOR_URL = rekor;

  const r = spawnSync('cosign', args, { encoding: 'utf8', env, cwd: root });
  if (r.status !== 0) {
    return { ok: false, errors: [r.stderr || r.stdout || `exit ${r.status}`] };
  }
  return { ok: true, errors: [] };
}

// ── milestone-aware sign-all ──────────────────────────────────────────
//
// At release-time, every artifact in _cobolt-output/latest/build/{M}/ that
// participates in supply-chain attestation gets signed: the SBOM (cdx +
// spdx) and the SLSA attestation. Other artifacts (test reports, etc.)
// stay unsigned to keep the signature surface small.

const SIGNABLE_PATTERNS = [/^sbom\.cdx\.json$/, /^sbom\.spdx\.json$/, /^slsa-provenance\.intoto\.json$/];

function signAll({ cwd, milestone, identity, oidcIssuer } = {}) {
  const root = cwd ? path.resolve(cwd) : process.cwd();
  if (!milestone || !/^M\d+$/i.test(String(milestone))) {
    throw new Error('signAll: --milestone <M{n}> required');
  }
  const M = String(milestone).toUpperCase();
  const buildDir = path.join(root, '_cobolt-output', 'latest', 'build', M);
  if (!fs.existsSync(buildDir)) {
    throw new Error(`signAll: milestone build dir does not exist: ${path.relative(root, buildDir)}`);
  }
  const avail = isAvailable();
  if (!avail.available) {
    const err = new Error(avail.reason);
    err.code = 'COSIGN_MISSING';
    throw err;
  }

  const signed = [];
  const skipped = [];
  const entries = fs.readdirSync(buildDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!SIGNABLE_PATTERNS.some((re) => re.test(ent.name))) {
      skipped.push({ name: ent.name, reason: 'not-signable' });
      continue;
    }
    if (ent.name.endsWith('.sig') || ent.name.endsWith('.cert')) {
      skipped.push({ name: ent.name, reason: 'is-signature' });
      continue;
    }
    try {
      const result = signBlob({
        file: path.join(buildDir, ent.name),
        cwd: root,
        identity,
        oidcIssuer,
      });
      signed.push({
        name: ent.name,
        signaturePath: result.signaturePath,
        certificatePath: result.certificatePath,
        ledgerEntryId: result.ledgerEntryId,
      });
    } catch (err) {
      skipped.push({ name: ent.name, reason: `sign-failed: ${err.message}` });
    }
  }

  return { signed, skipped, milestone: M, cosignVersion: avail.version };
}

module.exports = {
  isAvailable,
  signBlob,
  verifyBlob,
  signAll,
  SIGNABLE_PATTERNS,
};

// ── CLI ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('Usage: node tools/cobolt-cosign.js <command> [args]');
    console.log('Commands:');
    console.log('  status                                Check cosign availability');
    console.log('  sign-blob <file> [--output <sig>]     Sign a single file');
    console.log('  verify-blob <file> --signature <sig> [--cert <cert>] [--identity <id>] [--issuer <url>]');
    console.log('  sign-milestone --milestone M1 [--cwd <dir>]   Sign SBOMs + SLSA attestation for M{n}');
    console.log('');
    console.log('Env vars:');
    console.log('  COBOLT_PRIVATE_REKOR=<url>            Air-gapped internal Rekor instance');
    process.exit(0);
  }

  if (cmd === 'status') {
    const avail = isAvailable();
    if (avail.available) {
      console.log(`[cobolt-cosign] cosign available: ${avail.version || 'unknown version'}`);
      console.log(`[cobolt-cosign] path:      ${avail.path}`);
      console.log(`[cobolt-cosign] rekor:     ${_resolveRekorUrl() || 'public (sigstore)'}`);
      process.exit(0);
    }
    console.log(`[cobolt-cosign] cosign NOT available — ${avail.reason}`);
    process.exit(2);
  }

  try {
    if (cmd === 'sign-blob') {
      const file = argv[1];
      if (!file) {
        console.error('Usage: sign-blob <file> [--output <sig>]');
        process.exit(1);
      }
      let output, identity, issuer;
      for (let i = 2; i < argv.length; i += 1) {
        if (argv[i] === '--output') output = argv[++i];
        else if (argv[i] === '--identity') identity = argv[++i];
        else if (argv[i] === '--issuer') issuer = argv[++i];
      }
      const r = signBlob({ file, output, identity, oidcIssuer: issuer });
      console.log(`[cobolt-cosign] Signature: ${r.signaturePath}`);
      if (r.certificatePath) console.log(`[cobolt-cosign] Certificate: ${r.certificatePath}`);
      if (r.ledgerEntryId) console.log(`[cobolt-cosign] Ledger entry: ${r.ledgerEntryId}`);
      process.exit(0);
    }
    if (cmd === 'verify-blob') {
      const file = argv[1];
      let signature, cert, identity, issuer;
      for (let i = 2; i < argv.length; i += 1) {
        if (argv[i] === '--signature') signature = argv[++i];
        else if (argv[i] === '--cert') cert = argv[++i];
        else if (argv[i] === '--identity') identity = argv[++i];
        else if (argv[i] === '--issuer') issuer = argv[++i];
      }
      if (!file || !signature) {
        console.error('Usage: verify-blob <file> --signature <sig>');
        process.exit(1);
      }
      const r = verifyBlob({ file, signature, certificate: cert, identity, oidcIssuer: issuer });
      if (r.ok) {
        console.log('[cobolt-cosign] Verified OK');
        process.exit(0);
      }
      console.error('[cobolt-cosign] Verification FAILED');
      for (const e of r.errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    if (cmd === 'sign-milestone') {
      let milestone, cwd, identity, issuer;
      for (let i = 1; i < argv.length; i += 1) {
        if (argv[i] === '--milestone') milestone = argv[++i];
        else if (argv[i] === '--cwd') cwd = argv[++i];
        else if (argv[i] === '--identity') identity = argv[++i];
        else if (argv[i] === '--issuer') issuer = argv[++i];
      }
      const r = signAll({ milestone, cwd, identity, oidcIssuer: issuer });
      console.log(`[cobolt-cosign] Milestone ${r.milestone} — ${r.signed.length} signed, ${r.skipped.length} skipped`);
      for (const s of r.signed) console.log(`  + ${s.name} -> ${path.basename(s.signaturePath)}`);
      for (const s of r.skipped) console.log(`  - ${s.name} (${s.reason})`);
      process.exit(0);
    }
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  } catch (err) {
    if (err.code === 'COSIGN_MISSING') {
      console.error(`[cobolt-cosign] ${err.message}`);
      process.exit(2);
    }
    console.error(`[cobolt-cosign] ${err.message}`);
    process.exit(1);
  }
}
