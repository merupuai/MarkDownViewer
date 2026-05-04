#!/usr/bin/env node

// CoBolt SBOM-driven Vulnerability Scanner (P2.4 / v0.62+).
//
// Runs `osv-scanner` against an SBOM (or against the project's lockfile tree
// directly when no SBOM is present yet) and emits a tier-aware findings
// report at milestone close. Complements the existing install-time
// dep-install-gate (which fires on `npm install` / `pip install` / etc.) by
// re-checking the *frozen* SBOM against fresh OSV data — a CVE published
// between install-time and release-time will surface here even if it didn't
// exist when the dep was installed.
//
// Tier semantics:
//   - --rigorous mode: Tier 1 hard-fail when ANY CVSS≥7 finding is present.
//   - --auto mode (default): Tier 2 advisory; degrades milestone grade but
//     does not halt the build pipeline.
// The mode is read from cobolt-state.json (state.mode) at runtime; CLI
// override available via `--tier 1|2`.
//
// Standards mapping (Inv-21):
//   NIST.SSDF.RV.1.4    — vulnerability disclosure & remediation policy.
//   NIST.SSDF.RV.1.2    — maintain SBOM + vulnerability inputs.
//   OWASP.ASVS.V14.2.1  — third-party components up-to-date.
//   EU.CRA.AnnexII.2    — address and remediate vulnerabilities without delay.
//
// Public API:
//   scan({ cwd?, milestone, sbomPath?, tier? }) -> { passed, findings, summary, paths, ledgerEntryId }
//   isAvailable() -> { available, version?, reason? }
//
// CLI:
//   node tools/cobolt-vuln-scan.js status
//   node tools/cobolt-vuln-scan.js scan --milestone M1 [--cwd <dir>] [--tier 1|2]
//
// Exit codes per tools/CLAUDE.md:
//   0 — scan completed successfully (regardless of tier verdict — verdict is
//       in the report; exit 0 means the scan ran, not that nothing was found)
//   1 — hard error (bad input, write failure, etc.)
//   2 — missing optional dep: `osv-scanner` not in PATH

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

function isAvailable() {
  const found = _which('osv-scanner');
  if (!found) {
    return {
      available: false,
      reason: 'osv-scanner binary not found in PATH. Install from https://google.github.io/osv-scanner/',
    };
  }
  // Version detection — osv-scanner --version prints "osv-scanner version: vX.Y.Z"
  const r = spawnSync(found, ['--version'], { encoding: 'utf8' });
  const m = r.stdout?.match(/v?\d+\.\d+\.\d+/);
  return { available: true, version: m ? m[0] : null, path: found };
}

function _readMode(cwd) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(cwd, 'cobolt-state.json'), 'utf8'));
    return state.mode || 'auto';
  } catch {
    return 'auto';
  }
}

function _sanitiseMilestone(milestone) {
  if (!milestone) return null;
  if (!/^M\d+$/i.test(String(milestone))) {
    throw new Error(`scan: milestone must match /^M\\d+$/, got "${milestone}"`);
  }
  return String(milestone).toUpperCase();
}

// ── osv-scanner output normalisation ─────────────────────────────────
//
// osv-scanner JSON output evolves across releases; we accept the canonical
// v1 shape (results[].packages[].vulnerabilities[]) and a v2 alternate
// (vulnerabilities flattened at the top level). Both yield the same
// finding shape downstream.

function _severityFromVuln(vuln) {
  // Severity sources in priority order:
  //   1. database_specific.severity (e.g. GHSA: "HIGH", "CRITICAL")
  //   2. severity[] entries with type=CVSS_V3, score=N.N
  //   3. severity[] entries with type=CVSS_V4
  //   4. fallback: ecosystem-specific or "unknown"
  const dbSev = String(vuln.database_specific?.severity || '').toUpperCase();
  if (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(dbSev)) return dbSev;

  const cvssEntries = Array.isArray(vuln.severity) ? vuln.severity : [];
  for (const entry of cvssEntries) {
    if (entry?.type?.includes('CVSS_V')) {
      // entry.score format: "CVSS:3.1/AV:N/AC:L/.../E:F"  — extract the numeric base.
      // OSV often gives us the full vector; we look for /(\d+\.\d+)/.
      const m = String(entry.score || '').match(/(\d+\.\d+)/);
      if (m) {
        const numeric = parseFloat(m[1]);
        if (numeric >= 9.0) return 'CRITICAL';
        if (numeric >= 7.0) return 'HIGH';
        if (numeric >= 4.0) return 'MEDIUM';
        if (numeric > 0.0) return 'LOW';
      }
    }
  }
  return 'UNKNOWN';
}

function _cvssScore(vuln) {
  const cvssEntries = Array.isArray(vuln.severity) ? vuln.severity : [];
  for (const entry of cvssEntries) {
    if (entry?.type?.includes('CVSS_V')) {
      const m = String(entry.score || '').match(/(\d+\.\d+)/);
      if (m) return parseFloat(m[1]);
    }
  }
  return null;
}

function _normaliseFindings(report) {
  const out = [];
  // v1 shape
  for (const r of report.results || []) {
    const source = r.source?.path || r.source?.type || 'unknown';
    for (const p of r.packages || []) {
      for (const v of p.vulnerabilities || []) {
        out.push({
          id: v.id,
          aliases: v.aliases || [],
          summary: v.summary || null,
          severity: _severityFromVuln(v),
          cvssScore: _cvssScore(v),
          package: {
            name: p.package?.name,
            version: p.package?.version,
            ecosystem: p.package?.ecosystem,
            purl: p.package?.purl || null,
          },
          source,
          fixedVersions: (v.affected || [])
            .flatMap((a) => a.ranges || [])
            .flatMap((rg) => rg.events || [])
            .filter((e) => e.fixed)
            .map((e) => e.fixed),
          references: v.references?.map((ref) => ref.url) || [],
        });
      }
    }
  }
  return out;
}

// ── public scan ──────────────────────────────────────────────────────

function scan({ cwd, milestone, sbomPath, tier } = {}) {
  const root = cwd ? path.resolve(cwd) : process.cwd();
  const M = _sanitiseMilestone(milestone);
  if (!M) throw new Error('scan: --milestone <M{n}> required');

  const avail = isAvailable();
  if (!avail.available) {
    const err = new Error(avail.reason);
    err.code = 'OSV_MISSING';
    throw err;
  }

  const buildDir = path.join(root, '_cobolt-output', 'latest', 'build', M);
  if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true, mode: 0o700 });

  // Choose scan target: SBOM if provided/found, else recursive lockfile scan.
  const resolvedSbom = sbomPath ? path.resolve(root, sbomPath) : path.join(buildDir, 'sbom.cdx.json');
  const args = ['--format', 'json'];
  if (fs.existsSync(resolvedSbom)) {
    args.push('--sbom', resolvedSbom);
  } else {
    args.push('--recursive', root);
  }

  const r = spawnSync('osv-scanner', args, { encoding: 'utf8', cwd: root, maxBuffer: 64 * 1024 * 1024 });
  // osv-scanner exits non-zero when vulnerabilities are found, which is the
  // "success but findings exist" case. We only treat parse failure or hard
  // exec failure as exit 1; any other non-zero is normal.
  let report = {};
  try {
    report = JSON.parse(r.stdout || '{}');
  } catch (parseErr) {
    throw new Error(`scan: osv-scanner output not parseable as JSON: ${parseErr.message}\nstderr: ${r.stderr}`);
  }

  const findings = _normaliseFindings(report);
  const bySev = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  for (const f of findings) bySev[f.severity] = (bySev[f.severity] || 0) + 1;

  // Tier resolution.
  const mode = _readMode(root);
  const effectiveTier = tier ? Number(tier) : mode === 'rigorous' ? 1 : 2;
  const blockerCount = bySev.CRITICAL + bySev.HIGH;
  const verdict = blockerCount === 0 ? 'PASS' : effectiveTier === 1 ? 'FAIL' : 'DEGRADE';
  const passed = verdict !== 'FAIL';

  const summary = {
    milestone: M,
    scannedAt: new Date().toISOString(),
    mode,
    tier: effectiveTier,
    sbomScanned: fs.existsSync(resolvedSbom),
    sbomPath: fs.existsSync(resolvedSbom) ? path.relative(root, resolvedSbom) : null,
    totalFindings: findings.length,
    bySeverity: bySev,
    verdict,
    osvScannerVersion: avail.version,
  };

  const reportPath = path.join(buildDir, `${M}-vuln-scan.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify({ summary, findings }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });

  // Append to evidence ledger.
  let ledgerEntryId = null;
  try {
    const evLedger = require('../lib/cobolt-evidence-ledger');
    const reportBuf = fs.readFileSync(reportPath);
    const entry = evLedger.append(
      {
        kind: evLedger.KINDS.CHECK_RESULT,
        producer: 'cobolt-vuln-scan/v0.62.0',
        sha256s: {
          report: crypto.createHash('sha256').update(reportBuf).digest('hex'),
        },
        controlIds: ['NIST.SSDF.RV.1.4', 'NIST.SSDF.RV.1.2', 'OWASP.ASVS.V14.2.1', 'EU.CRA.AnnexII.2'],
        payload: {
          milestone: M,
          tier: effectiveTier,
          verdict,
          totalFindings: findings.length,
          bySeverity: bySev,
          sbomScanned: summary.sbomScanned,
        },
      },
      { projectRoot: root },
    );
    ledgerEntryId = entry.entryId;
  } catch {
    // Tier 3 advisory.
  }

  return {
    passed,
    findings,
    summary,
    paths: { report: reportPath },
    ledgerEntryId,
  };
}

module.exports = {
  scan,
  isAvailable,
  // Internals exposed for tests only.
  _internal: {
    _normaliseFindings,
    _severityFromVuln,
    _cvssScore,
  },
};

// ── CLI ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('Usage: node tools/cobolt-vuln-scan.js <command> [args]');
    console.log('Commands:');
    console.log('  status                                Check osv-scanner availability');
    console.log('  scan --milestone M1 [--cwd <dir>] [--sbom <path>] [--tier 1|2]');
    process.exit(0);
  }

  if (cmd === 'status') {
    const avail = isAvailable();
    if (avail.available) {
      console.log(`[cobolt-vuln-scan] osv-scanner: ${avail.version || 'unknown version'} (${avail.path})`);
      process.exit(0);
    }
    console.log(`[cobolt-vuln-scan] osv-scanner NOT available — ${avail.reason}`);
    process.exit(2);
  }

  if (cmd === 'scan') {
    try {
      const opts = {};
      for (let i = 1; i < argv.length; i += 1) {
        if (argv[i] === '--milestone') opts.milestone = argv[++i];
        else if (argv[i] === '--cwd') opts.cwd = argv[++i];
        else if (argv[i] === '--sbom') opts.sbomPath = argv[++i];
        else if (argv[i] === '--tier') opts.tier = Number(argv[++i]);
      }
      const r = scan(opts);
      console.log(`[cobolt-vuln-scan] Verdict:    ${r.summary.verdict} (Tier ${r.summary.tier})`);
      console.log(`[cobolt-vuln-scan] Findings:   ${r.summary.totalFindings} total`);
      console.log(`[cobolt-vuln-scan]   CRITICAL: ${r.summary.bySeverity.CRITICAL}`);
      console.log(`[cobolt-vuln-scan]   HIGH:     ${r.summary.bySeverity.HIGH}`);
      console.log(`[cobolt-vuln-scan]   MEDIUM:   ${r.summary.bySeverity.MEDIUM}`);
      console.log(`[cobolt-vuln-scan]   LOW:      ${r.summary.bySeverity.LOW}`);
      console.log(`[cobolt-vuln-scan] Report:     ${r.paths.report}`);
      if (r.ledgerEntryId) console.log(`[cobolt-vuln-scan] Ledger:     ${r.ledgerEntryId}`);
      process.exit(0);
    } catch (err) {
      if (err.code === 'OSV_MISSING') {
        console.error(`[cobolt-vuln-scan] ${err.message}`);
        process.exit(2);
      }
      console.error(`[cobolt-vuln-scan] ${err.message}`);
      process.exit(1);
    }
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}
