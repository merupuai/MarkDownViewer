#!/usr/bin/env node

// CoBolt Deploy Aggregate — mirrors cobolt-readiness-aggregate.js but for the
// pre-deploy validation stage. Ensures deployment-report / milestone-verdict
// cannot claim PASS when any of the validation gates disagree.
//
// Runs 6 validation verdicts and aggregates:
//   1. milestone-validate     → _cobolt-output/latest/validate/milestone-validation-report.json
//   2. audit                  → _cobolt-output/latest/audit/audit-report.json
//   3. uat                    → _cobolt-output/latest/uat/uat-verdict.json
//   4. pentest                → _cobolt-output/latest/pentest/pentest-findings.json
//   5. reliability-guard      → _cobolt-output/latest/deploy/reliability-guard.json
//   6. infra-manifest.verified → _cobolt-output/latest/infra/infra-manifest.json
//
// If any returns FAIL / CRITICAL / unverified, the aggregate verdict is FAIL
// and an entry is appended to _cobolt-output/audit/deploy-aggregation.jsonl.
//
// Also enforces:
//   - pentest: zero exploitProof-verified CRITICAL/HIGH in status=open
//   - milestone vs audit: verdicts must agree (both PASS/CONDITIONAL/FAIL)
//   - uat: summary.casesFailed must be 0 when verdict=PASS
//   - cross-verdict timestamp ordering (v0.45.0): validate must not be
//     older than audit/pentest/uat by more than COBOLT_VALIDATE_STALE_WINDOW
//     (default 30 minutes). Guards the cascade where validate PASSED on
//     Monday, audit found a CRITICAL on Tuesday, deploy proceeds Wednesday
//     reading Monday's validate verdict.
//
// Commands:
//   check [--json] [--strict]
//
// Exit codes:
//   0 = aggregate PASS
//   1 = usage error
//   2 = validation artifacts missing (Tier 2 skip)
//   8 = aggregate FAIL (includes stale-validate-verdict cross-check)

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_FAIL = 8;

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function readFirstExisting(paths) {
  for (const p of paths) {
    if (fs.existsSync(p)) return { path: p, data: readJson(p) };
  }
  return { path: null, data: null };
}

function latest(root) {
  return path.join(root, '_cobolt-output', 'latest');
}

function classify(verdict) {
  const v = String(verdict || '').toUpperCase();
  if (v === 'PASS' || v === 'OK' || v === 'READY' || v === 'APPROVED') return 'PASS';
  if (v === 'CONDITIONAL' || v === 'DEGRADED' || v === 'WARN') return 'CONDITIONAL';
  if (v === 'FAIL' || v === 'BLOCKED' || v === 'REJECTED' || v === 'CRITICAL') return 'FAIL';
  return 'UNKNOWN';
}

// Extract a best-effort timestamp (ms) from a verdict JSON blob. Supports
// several common field names so we do not have to coerce every producer to
// one canonical schema.
function extractTimestamp(data, fallbackPath) {
  if (!data) return null;
  const candidates = [
    data.generatedAt,
    data.capturedAt,
    data.completedAt,
    data.timestamp,
    data.summary?.generatedAt,
    data.summary?.capturedAt,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const ms = Date.parse(c);
    if (Number.isFinite(ms)) return ms;
  }
  // Fall back to file mtime.
  if (fallbackPath) {
    try {
      return fs.statSync(fallbackPath).mtimeMs;
    } catch {
      return null;
    }
  }
  return null;
}

function checkMilestoneValidate(root) {
  const p = path.join(latest(root), 'validate');
  const { path: found, data } = readFirstExisting([
    path.join(p, 'milestone-validation-report.json'),
    path.join(p, 'milestone-verdict.json'),
  ]);
  if (!data) return { name: 'milestone-validate', status: 'SKIP', reason: 'artifact missing' };
  const status = classify(data.verdict);
  const details = {
    unImplemented: data.summary?.findings?.unImplemented ?? 0,
    partialImpl: data.summary?.findings?.partial ?? 0,
  };
  // Phantom-pass guard: verdict=PASS with unImplemented > 0 is a contradiction.
  if (status === 'PASS' && details.unImplemented > 0) {
    return {
      name: 'milestone-validate',
      status: 'FAIL',
      reason: `verdict=PASS but unImplemented=${details.unImplemented} — phantom-pass`,
      path: found,
      generatedAt: extractTimestamp(data, found),
    };
  }
  return {
    name: 'milestone-validate',
    status,
    verdict: data.verdict,
    path: found,
    details,
    generatedAt: extractTimestamp(data, found),
  };
}

function checkAudit(root) {
  const p = path.join(latest(root), 'audit');
  const { path: found, data } = readFirstExisting([
    path.join(p, 'audit-report.json'),
    path.join(p, 'compliance-audit-report.json'),
  ]);
  if (!data) return { name: 'audit', status: 'SKIP', reason: 'artifact missing' };
  const status = classify(data.verdict || data.summary?.verdict);
  return { name: 'audit', status, verdict: data.verdict, path: found, generatedAt: extractTimestamp(data, found) };
}

function checkUat(root) {
  const p = path.join(latest(root), 'uat');
  const { path: found, data } = readFirstExisting([path.join(p, 'uat-verdict.json'), path.join(p, 'uat-report.json')]);
  if (!data) return { name: 'uat', status: 'SKIP', reason: 'artifact missing' };
  const status = classify(data.verdict);
  const details = {
    casesFailed: data.summary?.casesFailed ?? 0,
    casesTotal: data.summary?.casesTotal ?? 0,
    personaGap: data.summary?.personaCoverageGaps ?? 0,
  };
  if (status === 'PASS' && details.casesFailed > 0) {
    return {
      name: 'uat',
      status: 'FAIL',
      reason: `verdict=PASS but casesFailed=${details.casesFailed} — phantom-pass`,
      path: found,
      generatedAt: extractTimestamp(data, found),
    };
  }
  return {
    name: 'uat',
    status,
    verdict: data.verdict,
    path: found,
    details,
    generatedAt: extractTimestamp(data, found),
  };
}

function checkPentest(root) {
  const p = path.join(latest(root), 'pentest');
  const { path: found, data } = readFirstExisting([
    path.join(p, 'pentest-findings.json'),
    path.join(p, 'pentest-report.json'),
  ]);
  if (!data) return { name: 'pentest', status: 'SKIP', reason: 'artifact missing' };
  const findings = Array.isArray(data.findings) ? data.findings : [];
  const openHigh = findings.filter(
    (f) =>
      (f.severity === 'critical' || f.severity === 'high') &&
      f.status !== 'fixed' &&
      f.status !== 'false-positive' &&
      f.status !== 'accepted',
  );
  if (openHigh.length > 0) {
    return {
      name: 'pentest',
      status: 'FAIL',
      reason: `${openHigh.length} open CRITICAL/HIGH finding(s)`,
      openHighIds: openHigh.map((f) => f.id).slice(0, 10),
      path: found,
      generatedAt: extractTimestamp(data, found),
    };
  }
  // Enforce exploitProof for fixed CRITICAL/HIGH
  const fixedWithoutProof = findings.filter(
    (f) =>
      (f.severity === 'critical' || f.severity === 'high') &&
      f.status === 'fixed' &&
      !(f.exploitProof && f.exploitProof.blocked === true),
  );
  if (fixedWithoutProof.length > 0) {
    return {
      name: 'pentest',
      status: 'FAIL',
      reason: `${fixedWithoutProof.length} fixed CRITICAL/HIGH lack exploitProof`,
      fixedWithoutProofIds: fixedWithoutProof.map((f) => f.id).slice(0, 10),
      path: found,
      generatedAt: extractTimestamp(data, found),
    };
  }
  return { name: 'pentest', status: 'PASS', path: found, generatedAt: extractTimestamp(data, found) };
}

function checkReliabilityGuard(root) {
  const p = path.join(latest(root), 'deploy', 'reliability-guard.json');
  if (!fs.existsSync(p)) return { name: 'reliability-guard', status: 'SKIP', reason: 'artifact missing' };
  const data = readJson(p);
  if (!data) return { name: 'reliability-guard', status: 'SKIP', reason: 'unparseable' };
  const status = classify(data.verdict || (data.passed ? 'PASS' : 'FAIL'));
  // Freshness — older than 2h is stale in deploy context
  if (data.generatedAt) {
    const age = Date.now() - Date.parse(data.generatedAt);
    if (age > 2 * 60 * 60 * 1000) {
      return {
        name: 'reliability-guard',
        status: 'FAIL',
        reason: `verdict is ${Math.round(age / 60000)}min stale — re-run required`,
        path: p,
      };
    }
  }
  return { name: 'reliability-guard', status, path: p };
}

function checkInfraManifest(root) {
  const p = path.join(latest(root), 'infra', 'infra-manifest.json');
  if (!fs.existsSync(p)) return { name: 'infra-manifest', status: 'SKIP', reason: 'artifact missing' };
  const data = readJson(p);
  if (!data) return { name: 'infra-manifest', status: 'FAIL', reason: 'unparseable JSON', path: p };
  if (data.verified !== true) {
    return { name: 'infra-manifest', status: 'FAIL', reason: 'verified=false — infra not ready', path: p };
  }
  return { name: 'infra-manifest', status: 'PASS', path: p };
}

function aggregate(root) {
  const results = [
    checkMilestoneValidate(root),
    checkAudit(root),
    checkUat(root),
    checkPentest(root),
    checkReliabilityGuard(root),
    checkInfraManifest(root),
  ];
  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIP');

  // Cross-check: milestone-validate vs audit MUST agree when both present
  const mv = results.find((r) => r.name === 'milestone-validate' && r.status !== 'SKIP');
  const au = results.find((r) => r.name === 'audit' && r.status !== 'SKIP');
  const ut = results.find((r) => r.name === 'uat' && r.status !== 'SKIP');
  const pt = results.find((r) => r.name === 'pentest' && r.status !== 'SKIP');
  const crossCheck = [];
  if (mv && au && mv.status !== au.status) {
    crossCheck.push({
      class: 'milestone-audit-disagreement',
      severity: 'high',
      message: `milestone-validate=${mv.status} but audit=${au.status} — verdicts must agree`,
    });
  }

  // Cross-check (v0.45.0): validate timestamp must not be older than
  // audit/pentest/uat by more than the staleness window. Guards the cascade
  // where validate ran earlier and audit/pentest/uat were re-run later but
  // validate was not re-run, so deploy would proceed on pre-audit-finding
  // validate verdict.
  const STALE_WINDOW_MS = (Number.parseInt(process.env.COBOLT_VALIDATE_STALE_WINDOW_MIN || '30', 10) || 30) * 60 * 1000;
  if (mv?.generatedAt) {
    const fresher = [];
    for (const other of [au, ut, pt]) {
      if (!other?.generatedAt) continue;
      const skewMs = other.generatedAt - mv.generatedAt;
      if (skewMs > STALE_WINDOW_MS) {
        fresher.push({ gate: other.name, skewMin: Math.round(skewMs / 60000) });
      }
    }
    if (fresher.length > 0) {
      const freshList = fresher.map((f) => `${f.gate}+${f.skewMin}min`).join(', ');
      crossCheck.push({
        class: 'stale-validate-verdict',
        severity: 'high',
        message: `milestone-validate is older than ${freshList} — re-run milestone-validate to reconcile`,
        fresher,
        validateGeneratedAt: new Date(mv.generatedAt).toISOString(),
        windowMin: STALE_WINDOW_MS / 60000,
      });
    }
  }

  const verdict = failed.length === 0 && crossCheck.length === 0 ? 'PASS' : 'FAIL';
  return {
    verdict,
    gates: results,
    failedCount: failed.length,
    skippedCount: skipped.length,
    crossCheck,
    exitCode: verdict === 'PASS' ? EXIT_OK : EXIT_FAIL,
  };
}

function writeAudit(root, record) {
  const dir = path.join(root, '_cobolt-output', 'audit');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'deploy-aggregation.jsonl'), `${JSON.stringify(record)}\n`);
  } catch {
    /* best-effort */
  }
}

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'check';
  const json = hasFlag(args, '--json');
  const strict = hasFlag(args, '--strict');

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Usage: cobolt-deploy-aggregate.js check [--json] [--strict]');
    process.exit(EXIT_OK);
  }

  if (cmd !== 'check') {
    console.error(`Unknown command: ${cmd}`);
    process.exit(EXIT_USAGE);
  }

  const root = process.cwd();
  const result = aggregate(root);

  writeAudit(root, {
    timestamp: new Date().toISOString(),
    verdict: result.verdict,
    failedCount: result.failedCount,
    skippedCount: result.skippedCount,
    gates: result.gates,
    crossCheck: result.crossCheck,
  });

  // In strict mode a SKIP (missing artifact) is treated as FAIL.
  let effectiveExit = result.exitCode;
  if (strict && result.skippedCount > 0 && result.verdict === 'PASS') {
    effectiveExit = EXIT_MISSING;
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('== Deploy Aggregate ==');
    for (const g of result.gates) {
      const line = `  [${g.status}] ${g.name}${g.reason ? ` — ${g.reason}` : ''}`;
      console.log(line);
    }
    for (const c of result.crossCheck) {
      console.log(`  [CROSS] ${c.class}: ${c.message}`);
    }
    console.log(`verdict: ${result.verdict}`);
  }

  process.exit(effectiveExit);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { aggregate };
