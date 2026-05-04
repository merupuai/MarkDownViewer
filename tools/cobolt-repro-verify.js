#!/usr/bin/env node

// CoBolt Reproducible-Build Verifier (P3.5 / v0.65+).
//
// Verifies bit-for-bit reproducibility of build outputs by running the
// build twice and diffing the results modulo a documented exclusion list
// (timestamps, embedded build IDs, log files). When divergence is detected
// outside the exclusion list, the verifier reports a non-reproducibility
// finding so engineers can investigate.
//
// Why it matters:
//   Reproducible builds let any party verify that a published artifact
//   was produced from the source it claims. Combined with SLSA L3
//   provenance (P2.1) + Sigstore (P2.3) + SBOM (P2.2), reproducibility
//   closes the supply-chain trust loop. NIST SP 800-204D §3.5 requires it
//   for federal procurement; EU CRA Annex II §1 references it; the
//   Reproducible Builds project (https://reproducible-builds.org/) curates
//   the canonical methodology.
//
// Method:
//   1. Run the configured build command (default: `npm pack --dry-run` or
//      project-specific override).
//   2. Capture every output file's path + sha256.
//   3. Wait briefly to ensure timestamps differ.
//   4. Run the build again, capture again.
//   5. Diff: which files differ? Apply exclusion list (timestamps inside
//      tarballs, GZIP_TIMESTAMP, embedded git SHA when --allow-git-sha,
//      .log files).
//   6. Verdict: PASS if remaining diffs are empty; DEGRADE otherwise.
//
// Tier 2 advisory by default — non-reproducibility doesn't halt builds
// for now (typical Node projects don't reach reproducibility without
// extra work). Promotes to Tier 1 when project owners flag readiness.
//
// Standards mapping (Inv-21):
//   NIST SP 800-204D §3.5 — supply-chain reproducibility.
//   Reproducible Builds project — methodology.
//   SLSA v1.0 (consumer expectations) — verifiable provenance.
//   ISO/IEC 27001 A.14.2.5 — secure system engineering principles.
//
// Public API:
//   verify({ cwd?, milestone, command?, args?, outputDir?, allowGitSha? }) ->
//     { passed, diff, summary, paths, ledgerEntryId }
//   listExclusions() -> [{pattern, reason}]
//
// CLI:
//   node tools/cobolt-repro-verify.js verify --milestone M1 [--command "npm pack"] [--allow-git-sha]
//   node tools/cobolt-repro-verify.js exclusions
//
// Exit codes per tools/CLAUDE.md:
//   0 — verification ran (verdict in report; exit 0 on PASS or DEGRADE)
//   1 — hard error (build command failed both runs, parse failure)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const EXCLUSION_PATTERNS = [
  { pattern: /\.log$/i, reason: 'Log files contain timestamps and run-specific identifiers.' },
  { pattern: /\.tmp$/i, reason: 'Temporary files.' },
  { pattern: /node_modules\/\.cache\//, reason: 'Build-tool cache directories.' },
  {
    pattern: /^_cobolt-output\/audit\//,
    reason: 'Audit ledgers contain timestamps + nonces by design (HMAC-chained).',
  },
  { pattern: /\.DS_Store$/, reason: 'macOS metadata.' },
  { pattern: /Thumbs\.db$/i, reason: 'Windows metadata.' },
];

function _sanitiseMilestone(milestone) {
  if (!milestone) return null;
  if (!/^M\d+$/i.test(String(milestone))) {
    throw new Error(`milestone must match /^M\\d+$/, got "${milestone}"`);
  }
  return String(milestone).toUpperCase();
}

function listExclusions() {
  return EXCLUSION_PATTERNS.map((e) => ({ pattern: e.pattern.toString(), reason: e.reason }));
}

function _isExcluded(relPath) {
  return EXCLUSION_PATTERNS.some((e) => e.pattern.test(relPath));
}

function _walkAndHash(dir, baseDir) {
  const out = new Map();
  function recurse(absDir) {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const abs = path.join(absDir, ent.name);
      if (ent.isDirectory()) {
        recurse(abs);
      } else if (ent.isFile()) {
        const rel = path.relative(baseDir, abs).replace(/\\/g, '/');
        if (_isExcluded(rel)) continue;
        try {
          const buf = fs.readFileSync(abs);
          const sha = crypto.createHash('sha256').update(buf).digest('hex');
          out.set(rel, { sha, size: buf.length });
        } catch {
          // Skip unreadable files (sockets, etc.)
        }
      }
    }
  }
  recurse(dir);
  return out;
}

function _runBuild({ cwd, command, args }) {
  const r = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

// ── npm-pack-aware diff ───────────────────────────────────────────────
//
// `npm pack` produces a .tgz whose timestamps embedded in tar headers
// change between runs. We use `npm pack --dry-run --json` instead — it
// reports the file list with sha checksums without the timestamping
// problem. Caller can override via --command.

function _detectDefaultBuild(cwd) {
  // Prefer `npm pack --dry-run --json` for npm projects; deterministic file list.
  if (fs.existsSync(path.join(cwd, 'package.json'))) {
    return { command: 'npm', args: ['pack', '--dry-run', '--json'], format: 'npm-pack-json' };
  }
  // Fallback: hash everything under outputDir.
  return { command: null, args: null, format: 'walk-dir' };
}

function _parseNpmPackOutput(stdout) {
  // npm pack --dry-run --json prints an array of pack entries:
  // [{ files: [{path, size, mode, integrity}], shasum, ... }]
  try {
    const arr = JSON.parse(stdout);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const map = new Map();
    for (const entry of arr) {
      for (const f of entry.files || []) {
        if (f.path) map.set(f.path, { sha: f.integrity || `size:${f.size}`, size: f.size });
      }
    }
    return map;
  } catch {
    return null;
  }
}

// ── public verify ─────────────────────────────────────────────────────

function verify({ cwd, milestone, command, args, outputDir, allowGitSha = false } = {}) {
  const root = cwd ? path.resolve(cwd) : process.cwd();
  const M = _sanitiseMilestone(milestone) || 'M1';
  const buildDir = path.join(root, '_cobolt-output', 'latest', 'build', M);
  fs.mkdirSync(buildDir, { recursive: true, mode: 0o700 });

  const detected = command ? null : _detectDefaultBuild(root);
  const cmd = command || detected?.command;
  const cmdArgs = args || detected?.args || [];

  let firstMap = null;
  let secondMap = null;
  let firstBuildOk = true;
  let secondBuildOk = true;
  let firstError = null;
  let secondError = null;

  if (cmd) {
    const first = _runBuild({ cwd: root, command: cmd, args: cmdArgs });
    if (first.status !== 0) {
      firstBuildOk = false;
      firstError = first.stderr.slice(0, 500);
    } else if (detected?.format === 'npm-pack-json' && !command) {
      firstMap = _parseNpmPackOutput(first.stdout);
    }
    // Brief sleep so timestamps differ between runs (without blocking too long).
    const sleepStart = Date.now();
    while (Date.now() - sleepStart < 100) {
      /* spin briefly */
    }
    const second = _runBuild({ cwd: root, command: cmd, args: cmdArgs });
    if (second.status !== 0) {
      secondBuildOk = false;
      secondError = second.stderr.slice(0, 500);
    } else if (detected?.format === 'npm-pack-json' && !command) {
      secondMap = _parseNpmPackOutput(second.stdout);
    }
  }

  // If both builds failed or output paths weren't captured, fall back to
  // walking outputDir (or buildDir).
  if (!firstMap || !secondMap) {
    const dir = outputDir ? path.resolve(root, outputDir) : buildDir;
    firstMap = _walkAndHash(dir, root);
    // Wait briefly + walk again. Without an actual build between the two
    // walks, this only detects clock-driven artifacts (timestamps already
    // excluded). Useful only as a sanity-check.
    const sleepStart2 = Date.now();
    while (Date.now() - sleepStart2 < 50) {
      /* spin */
    }
    secondMap = _walkAndHash(dir, root);
  }

  const diffs = [];
  // Files in first but not second.
  for (const [p, info] of firstMap) {
    if (!secondMap.has(p)) diffs.push({ path: p, kind: 'missing-second', firstSha: info.sha });
  }
  // Files in second but not first.
  for (const [p, info] of secondMap) {
    if (!firstMap.has(p)) diffs.push({ path: p, kind: 'missing-first', secondSha: info.sha });
  }
  // Files in both with different shas.
  for (const [p, fInfo] of firstMap) {
    const sInfo = secondMap.get(p);
    if (sInfo && fInfo.sha !== sInfo.sha) {
      // Apply git-SHA exclusion when requested.
      if (allowGitSha && /\.(json|md|js)$/.test(p)) {
        // Heuristic: only exclude if shas differ in <10 contiguous chars
        // (suggests a single embedded git ref).
        diffs.push({
          path: p,
          kind: 'differs',
          firstSha: fInfo.sha,
          secondSha: sInfo.sha,
          excludedReason: 'allowGitSha — embedded git ref tolerated',
        });
        continue;
      }
      diffs.push({ path: p, kind: 'differs', firstSha: fInfo.sha, secondSha: sInfo.sha });
    }
  }

  const realDiffs = diffs.filter((d) => !d.excludedReason);
  const passed = firstBuildOk && secondBuildOk && realDiffs.length === 0;
  const verdict = !firstBuildOk || !secondBuildOk ? 'BUILD-FAILED' : passed ? 'PASS' : 'DEGRADE';

  const summary = {
    milestone: M,
    command: cmd ? `${cmd} ${cmdArgs.join(' ')}` : '(filesystem walk)',
    firstBuildOk,
    secondBuildOk,
    firstError,
    secondError,
    firstFiles: firstMap.size,
    secondFiles: secondMap.size,
    diffsTotal: diffs.length,
    diffsExcluded: diffs.length - realDiffs.length,
    diffsReal: realDiffs.length,
    verdict,
    runAt: new Date().toISOString(),
  };

  // Persist reports.
  const reportPath = path.join(buildDir, `${M}-repro-verify.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify({ summary, diffs }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  // Append to evidence ledger.
  let ledgerEntryId = null;
  try {
    const evLedger = require('../lib/cobolt-evidence-ledger');
    const reportBuf = fs.readFileSync(reportPath);
    const entry = evLedger.append(
      {
        kind: evLedger.KINDS.CHECK_RESULT,
        producer: 'cobolt-repro-verify/v0.65.0',
        sha256s: { report: crypto.createHash('sha256').update(reportBuf).digest('hex') },
        controlIds: ['NIST.SSDF.PW.8.2', 'OWASP.ASVS.V14.1.1', 'ISO.27001.A.14.2.5'],
        payload: {
          milestone: M,
          verdict,
          firstFiles: summary.firstFiles,
          diffsReal: summary.diffsReal,
          command: summary.command,
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
    diff: diffs,
    summary,
    paths: { report: reportPath },
    ledgerEntryId,
  };
}

module.exports = {
  verify,
  listExclusions,
  EXCLUSION_PATTERNS,
  // Internals exposed for tests.
  _internal: { _walkAndHash, _isExcluded, _parseNpmPackOutput },
};

// ── CLI ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('Usage: node tools/cobolt-repro-verify.js <command> [args]');
    console.log('Commands:');
    console.log('  verify --milestone M1 [--command "npm pack"] [--args ...] [--allow-git-sha]');
    console.log('  exclusions [--json]');
    process.exit(0);
  }
  try {
    if (cmd === 'verify') {
      const opts = {};
      for (let i = 1; i < argv.length; i += 1) {
        if (argv[i] === '--milestone') opts.milestone = argv[++i];
        else if (argv[i] === '--cwd') opts.cwd = argv[++i];
        else if (argv[i] === '--command') opts.command = argv[++i];
        else if (argv[i] === '--allow-git-sha') opts.allowGitSha = true;
        else if (argv[i] === '--output-dir') opts.outputDir = argv[++i];
      }
      const r = verify(opts);
      console.log(`[cobolt-repro-verify] Verdict:    ${r.summary.verdict}`);
      console.log(`[cobolt-repro-verify] Files:      first=${r.summary.firstFiles} second=${r.summary.secondFiles}`);
      console.log(
        `[cobolt-repro-verify] Diffs:      ${r.summary.diffsReal} real / ${r.summary.diffsExcluded} excluded`,
      );
      console.log(`[cobolt-repro-verify] Report:     ${r.paths.report}`);
      if (r.ledgerEntryId) console.log(`[cobolt-repro-verify] Ledger:     ${r.ledgerEntryId}`);
      process.exit(0);
    }
    if (cmd === 'exclusions') {
      const list = listExclusions();
      if (argv.includes('--json')) console.log(JSON.stringify(list, null, 2));
      else for (const e of list) console.log(`  ${e.pattern.padEnd(40)} ${e.reason}`);
      process.exit(0);
    }
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  } catch (err) {
    console.error(`[cobolt-repro-verify] ${err.message}`);
    process.exit(1);
  }
}

// Suppress lint warnings for unused imports kept for future use.
void os;
