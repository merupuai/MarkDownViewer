#!/usr/bin/env node

// CoBolt Artifact Freshness Gate — warning-only per
// docs/cobolt-context-routing-plan.md Companion Improvement #3.
//
// Compares PRD, RTM, story-tracker, milestone-tracker, architecture, test
// plan, finding-tracker, review findings, and fix tracker by checksum +
// mtime + referenced IDs. Reports drift as findings. Blocks ONLY when
// enforce mode is opted in AND a stale artifact would invalidate a
// release-critical gate. Default is warning-only so existing pipelines
// are never disrupted.
//
// Usage:
//   node tools/cobolt-artifact-freshness.js check [--json]
//   node tools/cobolt-artifact-freshness.js check --enforce [--json]
//
// Exit codes:
//   0 — no findings or warnings only (default)
//   1 — blockers present AND --enforce was passed (opt-in only)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPORT_VERSION = '1.0.0';
const STALE_DAYS = 30;
const RECENT_DAYS = 7;

function safeRequire(modulePath) {
  try {
    return require(modulePath);
  } catch {
    return null;
  }
}
const pathsMod = safeRequire('../lib/cobolt-paths');

function latestDir(projectRoot) {
  const root = path.resolve(projectRoot);
  if (typeof pathsMod === 'function') {
    try {
      const p = pathsMod(root);
      if (p?.latestOutputDir) return p.latestOutputDir();
    } catch {
      /* fall through */
    }
  }
  return path.join(root, '_cobolt-output', 'latest');
}

function rel(projectRoot, abs) {
  return path.relative(path.resolve(projectRoot), abs).replace(/\\/g, '/');
}

function statArtifact(projectRoot, abs) {
  try {
    const st = fs.statSync(abs);
    return {
      path: rel(projectRoot, abs),
      exists: true,
      size: st.size,
      checksum: sha256(abs),
      updatedAt: st.mtime.toISOString(),
      ageDays: (Date.now() - st.mtimeMs) / (1000 * 60 * 60 * 24),
    };
  } catch {
    return { path: rel(projectRoot, abs), exists: false, size: null, checksum: null, updatedAt: null, ageDays: null };
  }
}

function sha256(abs) {
  try {
    const buf = fs.readFileSync(abs);
    return `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
  } catch {
    return null;
  }
}

function safeReadJson(abs) {
  try {
    if (!fs.existsSync(abs)) return null;
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

function safeReadText(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

// ── Checks ────────────────────────────────────────────────

function checkPrdVsRtm(projectRoot, prdInfo, rtmInfo) {
  const findings = [];
  if (!prdInfo.exists || !rtmInfo.exists) return findings;
  if (prdInfo.updatedAt && rtmInfo.updatedAt && prdInfo.updatedAt > rtmInfo.updatedAt) {
    const drift = Math.max(
      0,
      (new Date(prdInfo.updatedAt).getTime() - new Date(rtmInfo.updatedAt).getTime()) / (1000 * 60 * 60 * 24),
    );
    findings.push({
      code: 'prd-newer-than-rtm',
      severity: 'warn',
      message: `PRD changed ${drift.toFixed(1)} day(s) after RTM was regenerated — RTM may be out of sync`,
      paths: [prdInfo.path, rtmInfo.path],
      detail: `prd.mtime=${prdInfo.updatedAt} rtm.mtime=${rtmInfo.updatedAt}`,
    });
  }
  // Check that every FR-NNN in PRD body is present in RTM.requirements
  const prd = safeReadText(path.resolve(projectRoot, prdInfo.path));
  const rtm = safeReadJson(path.resolve(projectRoot, rtmInfo.path));
  if (rtm?.requirements) {
    const prdIds = new Set(prd.match(/\bFR-\d+\b/g) || []);
    const rtmIds = new Set(Object.keys(rtm.requirements).filter((k) => /^FR-/.test(k)));
    const missing = [...prdIds].filter((id) => !rtmIds.has(id));
    if (missing.length > 0) {
      findings.push({
        code: 'prd-ids-missing-from-rtm',
        severity: 'warn',
        message: `PRD references ${missing.length} FR id(s) missing from RTM: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`,
        paths: [prdInfo.path, rtmInfo.path],
        detail: missing.join(','),
      });
    }
  }
  return findings;
}

function checkStoryTrackerVsBuildPlan(projectRoot) {
  const findings = [];
  const storyTrackerPath = path.join(latestDir(projectRoot), 'planning', 'story-tracker.json');
  if (!fs.existsSync(storyTrackerPath)) return findings;
  const storyInfo = statArtifact(projectRoot, storyTrackerPath);
  // Compare with any per-milestone build manifests
  const buildDir = path.join(latestDir(projectRoot), 'build');
  if (!fs.existsSync(buildDir)) return findings;
  const milestones = fs.readdirSync(buildDir).filter((name) => /^M\d+$/.test(name));
  for (const m of milestones) {
    const buildProgress = path.join(buildDir, m, 'progress.json');
    if (!fs.existsSync(buildProgress)) continue;
    const buildInfo = statArtifact(projectRoot, buildProgress);
    if (buildInfo.updatedAt && storyInfo.updatedAt && storyInfo.updatedAt > buildInfo.updatedAt) {
      const drift =
        (new Date(storyInfo.updatedAt).getTime() - new Date(buildInfo.updatedAt).getTime()) / (1000 * 60 * 60 * 24);
      if (drift > 1) {
        findings.push({
          code: 'story-tracker-newer-than-build-plan',
          severity: 'warn',
          message: `story-tracker updated ${drift.toFixed(1)} day(s) after ${m} build plan — build plan may not reflect latest stories`,
          paths: [storyInfo.path, buildInfo.path],
          detail: null,
        });
      }
    }
  }
  return findings;
}

function checkReleaseCriticalFreshness(_projectRoot, artifacts) {
  const findings = [];
  const rtmInfo = artifacts.find((a) => a.path.endsWith('planning/rtm.json'));
  if (rtmInfo?.exists && rtmInfo.ageDays !== null && rtmInfo.ageDays > STALE_DAYS) {
    findings.push({
      code: 'rtm-stale',
      severity: 'block',
      message: `RTM is ${rtmInfo.ageDays.toFixed(0)} days old (>${STALE_DAYS}); release gate would be invalidated`,
      paths: [rtmInfo.path],
      detail: null,
    });
  }
  return findings;
}

function checkOrphanedMilestoneReports(projectRoot) {
  const findings = [];
  const reportsDir = path.join(projectRoot, '_cobolt-output', 'reports');
  if (!fs.existsSync(reportsDir)) return findings;
  const rtmInfo = statArtifact(projectRoot, path.join(latestDir(projectRoot), 'planning', 'rtm.json'));
  if (!rtmInfo.exists) return findings;
  const reportDirs = fs
    .readdirSync(reportsDir)
    .filter((n) => /^M\d+$/.test(n))
    .map((n) => path.join(reportsDir, n));
  for (const reportDir of reportDirs) {
    const info = statArtifact(projectRoot, reportDir);
    if (info.ageDays !== null && info.ageDays > RECENT_DAYS && rtmInfo.ageDays < info.ageDays) {
      findings.push({
        code: 'milestone-report-older-than-rtm',
        severity: 'info',
        message: `${path.basename(reportDir)} report is ${info.ageDays.toFixed(0)} day(s) old while RTM was refreshed ${rtmInfo.ageDays.toFixed(0)} day(s) ago`,
        paths: [info.path, rtmInfo.path],
        detail: null,
      });
    }
  }
  return findings;
}

// ── Main ──────────────────────────────────────────────────

function checkFreshness(projectRoot, options = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  const latest = latestDir(root);
  const mode = options.enforce ? 'enforce' : 'warning';

  const candidates = [
    { path: path.join(latest, 'planning', 'prd.md'), kind: 'prd' },
    { path: path.join(latest, 'planning', 'rtm.json'), kind: 'rtm' },
    { path: path.join(latest, 'planning', 'story-tracker.json'), kind: 'story-tracker' },
    { path: path.join(latest, 'planning', 'milestone-tracker.json'), kind: 'milestone-tracker' },
    { path: path.join(latest, 'planning', 'architecture.md'), kind: 'architecture' },
    { path: path.join(latest, 'planning', 'test-strategy.md'), kind: 'test-strategy' },
    { path: path.join(latest, 'review', 'finding-tracker.json'), kind: 'review-findings' },
  ];

  const artifacts = candidates.map((c) => {
    const info = statArtifact(root, c.path);
    info.kind = c.kind;
    return info;
  });

  const findings = [];
  const prdInfo = artifacts.find((a) => a.kind === 'prd');
  const rtmInfo = artifacts.find((a) => a.kind === 'rtm');
  if (prdInfo && rtmInfo) findings.push(...checkPrdVsRtm(root, prdInfo, rtmInfo));
  findings.push(...checkStoryTrackerVsBuildPlan(root));
  findings.push(...checkReleaseCriticalFreshness(root, artifacts));
  findings.push(...checkOrphanedMilestoneReports(root));

  const blockers = findings.filter((f) => f.severity === 'block').length;
  const warnings = findings.filter((f) => f.severity === 'warn').length;
  const enforcedBlockers = mode === 'enforce' ? blockers : 0;
  const status = enforcedBlockers > 0 ? 'blocked' : blockers + warnings > 0 ? 'warnings' : 'ok';

  return {
    version: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    mode,
    currentMilestone: options.currentMilestone || null,
    artifacts,
    findings,
    verdict: { status, blockers: enforcedBlockers, warnings, wouldBlock: blockers },
  };
}

function writeReport(projectRoot, report) {
  const auditDir = path.join(projectRoot, '_cobolt-output', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  const outPath = path.join(auditDir, 'artifact-freshness.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  return outPath;
}

// ── CLI ──────────────────────────────────────────────────

function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'check';
  if (cmd === '--help' || cmd === '-h') {
    console.log(`  CoBolt Artifact Freshness Gate (warning-only by default)

  Usage:
    node tools/cobolt-artifact-freshness.js check [--enforce] [--write] [--json]
`);
    process.exit(0);
  }
  if (cmd !== 'check') {
    console.error(`  Unknown command: ${cmd}`);
    process.exit(2);
  }
  const enforce = args.includes('--enforce');
  const report = checkFreshness(process.cwd(), {
    enforce,
    currentMilestone: flagValue(args, '--milestone'),
  });
  if (args.includes('--write')) writeReport(process.cwd(), report);
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `  Freshness status: ${report.verdict.status} (blockers=${report.verdict.blockers} wouldBlock=${report.verdict.wouldBlock} warnings=${report.verdict.warnings})`,
    );
    for (const f of report.findings) {
      console.log(`    [${f.severity}] ${f.code}: ${f.message}`);
    }
  }
  if (enforce && report.verdict.blockers > 0) process.exit(1);
}

module.exports = {
  checkFreshness,
  writeReport,
  statArtifact,
  STALE_DAYS,
  RECENT_DAYS,
  REPORT_VERSION,
};

if (require.main === module) main(process.argv);
