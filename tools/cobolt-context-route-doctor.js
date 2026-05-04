#!/usr/bin/env node

// CoBolt Context Route Doctor — operator visibility for the task-shaped
// context routing subsystem. Reports:
//   - Router enablement (global + per-stage env vars)
//   - Schema presence under source/schemas/
//   - Telemetry sample count + latest entry timestamp
//   - Promotion recommender verdict summary
//   - Route file count under _cobolt-output/latest/*/context-packets/
//   - Evidence impact rollup stats
//   - Artifact freshness report presence
//
// This tool is purely advisory — it never flips flags, writes state, or
// blocks any pipeline. It's a one-shot read-only health surface.
//
// Usage:
//   node tools/cobolt-context-route-doctor.js check [--json]
//   node tools/cobolt-context-route-doctor.js check --verbose [--json]

const fs = require('node:fs');
const path = require('node:path');

function safeRequire(modulePath) {
  try {
    return require(modulePath);
  } catch {
    return null;
  }
}

const usageMod = safeRequire('./cobolt-context-route-usage');
const promoteMod = safeRequire('./cobolt-context-route-promote');
const impactMod = safeRequire('./cobolt-evidence-impact');

const STAGES = ['fix', 'review', 'build', 'planning', 'deploy', 'dream'];
const SCHEMAS = ['context-route.schema.json', 'evidence-impact.schema.json', 'artifact-freshness.schema.json'];

function checkEnvEnablement() {
  const global = String(process.env.COBOLT_CONTEXT_ROUTER || '').trim() === '1';
  const perStage = {};
  for (const s of STAGES) {
    perStage[s] = String(process.env[`COBOLT_CONTEXT_ROUTER_${s.toUpperCase()}`] || '').trim() === '1';
  }
  const impact = String(process.env.COBOLT_CONTEXT_ROUTE_IMPACT || '').trim() === '1';
  const debug = String(process.env.COBOLT_CONTEXT_ROUTER_DEBUG || '').trim() === '1';
  const anyEnabled = global || Object.values(perStage).some(Boolean);
  return { global, perStage, impact, debug, anyEnabled };
}

function checkSchemasPresent(projectRoot) {
  const schemasDir = path.resolve(projectRoot, 'source', 'schemas');
  const present = {};
  for (const name of SCHEMAS) {
    present[name] = fs.existsSync(path.join(schemasDir, name));
  }
  return present;
}

function checkTelemetry(projectRoot) {
  if (!usageMod) return { available: false };
  try {
    const entries = usageMod.readUsage(projectRoot);
    const latestTs = entries.length > 0 ? entries[entries.length - 1].ts : null;
    const byStage = {};
    for (const e of entries) {
      const key = e.stage || 'unknown';
      byStage[key] = (byStage[key] || 0) + 1;
    }
    return {
      available: true,
      sampleCount: entries.length,
      latestTs,
      byStage,
      path: usageMod.auditPath(projectRoot),
    };
  } catch (err) {
    return { available: true, error: err.message };
  }
}

function checkPromotion(projectRoot) {
  if (!promoteMod) return { available: false };
  try {
    const report = promoteMod.reportAll(projectRoot);
    const perStageVerdicts = {};
    for (const [stage, v] of Object.entries(report.perStage)) {
      perStageVerdicts[stage] = v.verdict;
    }
    return {
      available: true,
      overall: report.overall.verdict,
      perStage: perStageVerdicts,
    };
  } catch (err) {
    return { available: true, error: err.message };
  }
}

function checkRouteFiles(projectRoot) {
  const latest = path.join(projectRoot, '_cobolt-output', 'latest');
  if (!fs.existsSync(latest)) return { count: 0, byStage: {} };
  const byStage = {};
  let count = 0;
  const stageDirs = fs.readdirSync(latest).filter((n) => {
    try {
      return fs.statSync(path.join(latest, n)).isDirectory();
    } catch {
      return false;
    }
  });
  for (const stageName of stageDirs) {
    const ctxDir = path.join(latest, stageName, 'context-packets');
    if (!fs.existsSync(ctxDir)) continue;
    const routeFiles = fs.readdirSync(ctxDir).filter((f) => f.endsWith('-route.json'));
    if (routeFiles.length > 0) {
      byStage[stageName] = routeFiles.length;
      count += routeFiles.length;
    }
  }
  return { count, byStage };
}

function checkImpactRollup(projectRoot) {
  if (!impactMod) return { available: false };
  try {
    const r = impactMod.rollup(projectRoot);
    return { available: true, ...r };
  } catch (err) {
    return { available: true, error: err.message };
  }
}

function checkFreshnessReport(projectRoot) {
  const reportPath = path.join(projectRoot, '_cobolt-output', 'audit', 'artifact-freshness.json');
  if (!fs.existsSync(reportPath)) return { present: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    return {
      present: true,
      verdict: parsed.verdict || null,
      generatedAt: parsed.generatedAt || null,
    };
  } catch {
    return { present: true, parseError: true };
  }
}

function runCheck(projectRoot, options = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  return {
    generatedAt: new Date().toISOString(),
    projectRoot: root,
    env: checkEnvEnablement(),
    schemas: checkSchemasPresent(root),
    telemetry: checkTelemetry(root),
    promotion: checkPromotion(root),
    routeFiles: checkRouteFiles(root),
    impact: checkImpactRollup(root),
    freshness: checkFreshnessReport(root),
    verbose: options.verbose === true,
  };
}

// ── CLI ──────────────────────────────────────────────────

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'check';
  if (cmd === '--help' || cmd === '-h') {
    console.log(`  CoBolt Context Route Doctor (read-only advisory)

  Usage:
    node tools/cobolt-context-route-doctor.js check [--verbose] [--json]
`);
    process.exit(0);
  }
  if (cmd !== 'check') {
    console.error(`  Unknown command: ${cmd}`);
    process.exit(2);
  }
  const report = runCheck(process.cwd(), { verbose: args.includes('--verbose') });
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log('  CoBolt Context Route Doctor');
  console.log('  ──────────────────────────────');
  console.log(`  Env: global=${report.env.global} impact=${report.env.impact} debug=${report.env.debug}`);
  const stageEntries = Object.entries(report.env.perStage)
    .filter(([, v]) => v)
    .map(([k]) => k);
  if (stageEntries.length > 0) console.log(`  Per-stage enabled: ${stageEntries.join(', ')}`);
  console.log(
    `  Schemas: ${Object.entries(report.schemas)
      .map(([k, v]) => `${k.replace('.schema.json', '')}=${v ? 'ok' : 'MISSING'}`)
      .join(', ')}`,
  );
  if (report.telemetry.available) {
    console.log(`  Telemetry samples: ${report.telemetry.sampleCount}  latest=${report.telemetry.latestTs || 'n/a'}`);
  } else {
    console.log(`  Telemetry: module unavailable`);
  }
  if (report.promotion.available) {
    console.log(
      `  Promotion: overall=${report.promotion.overall}  perStage=${JSON.stringify(report.promotion.perStage)}`,
    );
  }
  console.log(
    `  Route files written: ${report.routeFiles.count}  byStage=${JSON.stringify(report.routeFiles.byStage)}`,
  );
  if (report.impact.available) {
    console.log(`  Impact rollup: ${report.impact.total || 0} scored  meanScore=${report.impact.meanScore ?? 'n/a'}`);
  }
  console.log(`  Freshness report: ${report.freshness.present ? 'present' : 'absent'}`);
}

module.exports = {
  runCheck,
  checkEnvEnablement,
  checkSchemasPresent,
  checkTelemetry,
  checkPromotion,
  checkRouteFiles,
  checkImpactRollup,
  checkFreshnessReport,
};

if (require.main === module) main(process.argv);
