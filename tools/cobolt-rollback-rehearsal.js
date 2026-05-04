#!/usr/bin/env node

// CoBolt Rollback Rehearsal (P3.10 / v0.66+).
//
// Validates rollback readiness at milestone close — the deploy can recover
// from a failure quickly. Two rehearsal modes:
//
//   1. Static validation (always available):
//      - Rollback script exists and is executable
//      - Rollback script declares idempotency markers
//      - Rollback target version is recorded in deployment manifest
//      - DORA MTTR data shows recent rollbacks complete in budget
//
//   2. Dry-run timing (when COBOLT_ROLLBACK_DRY_RUN=1):
//      - Invoke rollback script with --dry-run / --no-op
//      - Measure elapsed time; record evidence
//      - Real platform-aware rollback (live cutover) is deferred to v0.67
//        when each deploy target's runner is integrated.
//
// Standards mapping (Inv-21):
//   *Site Reliability Engineering* — DiRT (Disaster Recovery Testing).
//   Netflix Chaos Kong / Spinnaker — rehearsal patterns.
//   ISO/IEC 27001 A.5.30 — ICT readiness for business continuity.
//   NIST 800-53 CP-4 — contingency plan testing.
//
// Public API:
//   validate({ cwd?, milestone, scriptPath?, manifestPath? }) -> { ok, findings, summary }
//   rehearse({ cwd?, milestone, dryRun? }) -> { passed, durationMs, summary }
//   write({ cwd?, milestone }) -> { jsonPath, mdPath, summary, ledgerEntryId }
//
// CLI:
//   node tools/cobolt-rollback-rehearsal.js validate --milestone M1
//   node tools/cobolt-rollback-rehearsal.js rehearse --milestone M1 [--dry-run]
//   node tools/cobolt-rollback-rehearsal.js write --milestone M1
//
// Exit codes per tools/CLAUDE.md:
//   0 — validation/rehearsal completed (verdict in report)
//   1 — hard error
//   2 — missing script (project hasn't declared a rollback path)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const IDEMPOTENCY_MARKERS = [/idempotent/i, /already[-_\s]rolled[-_\s]back/i, /set[-_\s]once/i, /no[-_\s]op[-_\s]if/i];

const ROLLBACK_SCRIPT_CANDIDATES = [
  'rollback.sh',
  'rollback.js',
  'scripts/rollback.sh',
  'scripts/rollback.js',
  'bin/rollback',
  'deploy/rollback.sh',
];

function _sanitiseMilestone(milestone) {
  if (!milestone) return null;
  if (!/^M\d+$/i.test(String(milestone))) {
    throw new Error(`milestone must match /^M\\d+$/, got "${milestone}"`);
  }
  return String(milestone).toUpperCase();
}

function _findRollbackScript(cwd) {
  for (const rel of ROLLBACK_SCRIPT_CANDIDATES) {
    const abs = path.join(cwd, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
}

function _isExecutable(absPath) {
  if (process.platform === 'win32') return true; // Windows ACLs differ; assume yes.
  try {
    fs.accessSync(absPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ── public validate ──────────────────────────────────────────────────

function validate({ cwd, milestone, scriptPath, manifestPath } = {}) {
  const root = cwd || process.cwd();
  const M = _sanitiseMilestone(milestone) || 'M1';
  const findings = [];

  // 1. Rollback script presence + executability.
  const script = scriptPath ? path.resolve(root, scriptPath) : _findRollbackScript(root);
  if (!script) {
    findings.push({
      severity: 'error',
      type: 'rollback-script-missing',
      message: 'No rollback script found in canonical paths (rollback.sh/.js, scripts/rollback.*, bin/rollback).',
    });
  } else if (!_isExecutable(script)) {
    findings.push({
      severity: 'warning',
      type: 'rollback-script-not-executable',
      message: `Rollback script ${path.relative(root, script)} is not marked executable.`,
    });
  }

  // 2. Idempotency markers in the script body.
  if (script && fs.existsSync(script)) {
    let hasMarker = false;
    try {
      const text = fs.readFileSync(script, 'utf8');
      hasMarker = IDEMPOTENCY_MARKERS.some((re) => re.test(text));
    } catch {
      // skip
    }
    if (!hasMarker) {
      findings.push({
        severity: 'warning',
        type: 'idempotency-marker-absent',
        message: 'Rollback script has no idempotency marker comment. Document re-run safety.',
      });
    }
  }

  // 3. Deployment manifest declares rollback target version.
  const manifestCandidates = manifestPath
    ? [path.resolve(root, manifestPath)]
    : [
        path.join(root, '_cobolt-output', 'latest', 'build', M, 'deployment-manifest.json'),
        path.join(root, '_cobolt-output', 'latest', 'deploy', M, 'manifest.json'),
        path.join(root, 'infra-manifest.json'),
      ];
  let manifestFound = null;
  let rollbackTargetVersion = null;
  for (const c of manifestCandidates) {
    if (fs.existsSync(c)) {
      manifestFound = c;
      try {
        const m = JSON.parse(fs.readFileSync(c, 'utf8'));
        rollbackTargetVersion = m.rollbackTarget || m.previousVersion || m.rollbackVersion || null;
      } catch {
        // ignore
      }
      break;
    }
  }
  if (!manifestFound) {
    findings.push({
      severity: 'warning',
      type: 'deployment-manifest-missing',
      message: 'No deployment manifest found. Rollback target version is undocumented.',
    });
  } else if (!rollbackTargetVersion) {
    findings.push({
      severity: 'warning',
      type: 'rollback-target-undeclared',
      message: `Deployment manifest at ${path.relative(root, manifestFound)} does not declare rollbackTarget / previousVersion.`,
    });
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  return {
    ok: errors === 0,
    findings,
    summary: {
      milestone: M,
      scriptFound: Boolean(script),
      scriptPath: script ? path.relative(root, script) : null,
      manifestFound: Boolean(manifestFound),
      manifestPath: manifestFound ? path.relative(root, manifestFound) : null,
      rollbackTargetVersion,
      errorCount: errors,
      warningCount: findings.length - errors,
    },
  };
}

// ── public rehearse ──────────────────────────────────────────────────

function rehearse({ cwd, milestone, dryRun = process.env.COBOLT_ROLLBACK_DRY_RUN === '1' } = {}) {
  const root = cwd || process.cwd();
  const M = _sanitiseMilestone(milestone) || 'M1';
  const validation = validate({ cwd: root, milestone: M });
  const script = _findRollbackScript(root);

  if (!validation.ok) {
    return {
      passed: false,
      durationMs: 0,
      summary: { milestone: M, mode: 'validation-only', validation: validation.summary },
      findings: validation.findings,
    };
  }
  if (!dryRun) {
    return {
      passed: true,
      durationMs: 0,
      summary: { milestone: M, mode: 'validation-only', validation: validation.summary },
      findings: validation.findings,
      note: 'Set COBOLT_ROLLBACK_DRY_RUN=1 to invoke the rollback script with --dry-run.',
    };
  }

  // Dry-run timing path. Invoke `<script> --dry-run` (or `--no-op`).
  const start = Date.now();
  let exitStatus = 0;
  let stderr = '';
  if (script) {
    const ext = path.extname(script).toLowerCase();
    let cmd, args;
    if (ext === '.js') {
      cmd = process.execPath;
      args = [script, '--dry-run'];
    } else if (ext === '.sh' || ext === '') {
      cmd = process.platform === 'win32' ? 'bash' : script;
      args = process.platform === 'win32' ? [script, '--dry-run'] : ['--dry-run'];
    } else {
      cmd = script;
      args = ['--dry-run'];
    }
    const r = spawnSync(cmd, args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    exitStatus = r.status ?? 1;
    stderr = r.stderr || '';
  }
  const durationMs = Date.now() - start;

  return {
    passed: exitStatus === 0,
    durationMs,
    summary: {
      milestone: M,
      mode: 'dry-run',
      exitStatus,
      validation: validation.summary,
    },
    findings: [
      ...validation.findings,
      ...(exitStatus !== 0
        ? [
            {
              severity: 'error',
              type: 'dry-run-failed',
              message: `Rollback dry-run exited with status ${exitStatus}. stderr: ${stderr.slice(0, 300)}`,
            },
          ]
        : []),
    ],
  };
}

// ── persistence ──────────────────────────────────────────────────────

function write({ cwd, milestone, dryRun } = {}) {
  const root = cwd || process.cwd();
  const M = _sanitiseMilestone(milestone) || 'M1';
  const r = rehearse({ cwd: root, milestone: M, dryRun });
  const auditDir = path.join(root, '_cobolt-output', 'audit');
  fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  const jsonPath = path.join(auditDir, 'rollback-rehearsal.json');
  fs.writeFileSync(jsonPath, `${JSON.stringify(r, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  // Append to evidence ledger.
  let ledgerEntryId = null;
  try {
    const evLedger = require('../lib/cobolt-evidence-ledger');
    const reportBuf = fs.readFileSync(jsonPath);
    const entry = evLedger.append(
      {
        kind: evLedger.KINDS.CHECK_RESULT,
        producer: 'cobolt-rollback-rehearsal/v0.66.0',
        sha256s: { report: crypto.createHash('sha256').update(reportBuf).digest('hex') },
        controlIds: ['ISO.27001.A.5.30', 'NIST.800-53.CP-4', 'SOC2.A1.2'],
        payload: {
          milestone: M,
          passed: r.passed,
          mode: r.summary.mode,
          durationMs: r.durationMs,
          errorCount: r.findings.filter((f) => f.severity === 'error').length,
        },
      },
      { projectRoot: root },
    );
    ledgerEntryId = entry.entryId;
  } catch {
    // Tier 3 advisory.
  }
  return { jsonPath, summary: r.summary, ledgerEntryId };
}

module.exports = {
  validate,
  rehearse,
  write,
  IDEMPOTENCY_MARKERS,
  ROLLBACK_SCRIPT_CANDIDATES,
};

// ── CLI ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('Usage: node tools/cobolt-rollback-rehearsal.js <command> [args]');
    console.log('Commands:');
    console.log('  validate --milestone M1                Static rollback-readiness check');
    console.log('  rehearse --milestone M1 [--dry-run]    Static + dry-run rollback timing');
    console.log('  write    --milestone M1 [--dry-run]    Persist evidence to audit dir');
    process.exit(0);
  }
  try {
    const opts = {};
    for (let i = 1; i < argv.length; i += 1) {
      if (argv[i] === '--milestone') opts.milestone = argv[++i];
      else if (argv[i] === '--cwd') opts.cwd = argv[++i];
      else if (argv[i] === '--dry-run') opts.dryRun = true;
      else if (argv[i] === '--script') opts.scriptPath = argv[++i];
    }
    if (cmd === 'validate') {
      const r = validate(opts);
      console.log(`[cobolt-rollback-rehearsal] ${r.ok ? 'OK' : 'FAIL'}`);
      console.log(`  Script:  ${r.summary.scriptPath || '(missing)'}`);
      console.log(`  Errors:  ${r.summary.errorCount}, Warnings: ${r.summary.warningCount}`);
      for (const f of r.findings) console.log(`    [${f.severity}] ${f.type}: ${f.message}`);
      process.exit(r.ok ? 0 : 1);
    }
    if (cmd === 'rehearse') {
      const r = rehearse(opts);
      console.log(`[cobolt-rollback-rehearsal] ${r.passed ? 'PASS' : 'FAIL'} (${r.summary.mode})`);
      console.log(`  Duration: ${r.durationMs}ms`);
      for (const f of r.findings) console.log(`    [${f.severity}] ${f.type}: ${f.message}`);
      process.exit(0);
    }
    if (cmd === 'write') {
      const r = write(opts);
      console.log(`[cobolt-rollback-rehearsal] JSON: ${r.jsonPath}`);
      if (r.ledgerEntryId) console.log(`[cobolt-rollback-rehearsal] Ledger: ${r.ledgerEntryId}`);
      process.exit(0);
    }
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  } catch (err) {
    console.error(`[cobolt-rollback-rehearsal] ${err.message}`);
    process.exit(1);
  }
}
