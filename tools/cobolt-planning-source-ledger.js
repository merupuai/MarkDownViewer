#!/usr/bin/env node

const path = require('node:path');

const {
  ARTIFACTS,
  SCHEMA_VERSION,
  artifactPath,
  collectManifestInputs,
  finding,
  freshnessFromSource,
  loadPlanningManifest,
  loadSourceConfig,
  parseArgs,
  printJsonOrHuman,
  resolvePlanningDir,
  resolveProjectRoot,
  toPosix,
  writeJson,
} = require('../lib/cobolt-planning-vnext');

const TOOL_ID = 'cobolt-planning-source-ledger';

function buildPlanningSourceLedger(options = {}) {
  const projectRoot = resolveProjectRoot(options);
  const planningDir = resolvePlanningDir(projectRoot, { create: options.write !== false });
  const config = loadSourceConfig(projectRoot);
  const manifest = loadPlanningManifest(projectRoot, planningDir);
  const findings = [];

  const sources = (config.sources || []).map((source) => {
    const freshness = freshnessFromSource(source, config);
    if (freshness === 'stale') {
      findings.push(
        finding(`SOURCE-STALE:${source.id}`, 'advisory', `${source.id} source review is stale`, {
          sourceId: source.id,
        }),
      );
    } else if (freshness === 'unknown') {
      findings.push(
        finding(`SOURCE-FRESHNESS-UNKNOWN:${source.id}`, 'advisory', `${source.id} freshness could not be determined`, {
          sourceId: source.id,
        }),
      );
    }
    return {
      id: source.id,
      title: source.title,
      publisher: source.publisher,
      version: source.version || null,
      publishedDate: source.publishedDate || null,
      url: source.url,
      trustClass: source.trustClass || 'primary',
      freshness,
      usedBy: Array.isArray(source.usedBy) ? source.usedBy : [],
    };
  });

  const inputs = collectManifestInputs(projectRoot, planningDir, manifest).map((input) => {
    if (input.disposition === 'included' && !input.present) {
      findings.push(
        finding(`INPUT-MISSING:${input.path}`, 'critical', `Included planning input is missing: ${input.path}`),
      );
    }
    return {
      path: toPosix(input.path),
      disposition: input.disposition || 'unknown',
      sha256: input.sha256,
      present: input.present,
      sourceIntakePresent: input.sourceIntakePresent === true,
      srcMappings: input.srcMappings || [],
      reason: input.reason || null,
    };
  });

  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy: TOOL_ID,
    projectRoot,
    planningDir,
    configPath: toPosix(path.join('source', 'config', 'planning-standards-sources.json')),
    sources,
    inputs,
    summary: {
      sourceCount: sources.length,
      inputCount: inputs.length,
      staleCount: sources.filter((source) => source.freshness === 'stale').length,
      unknownFreshnessCount: sources.filter((source) => source.freshness === 'unknown').length,
      primarySourceCount: sources.filter((source) => source.trustClass === 'primary').length,
      status: findings.some((item) => item.severity === 'critical') ? 'blocked' : findings.length ? 'advisory' : 'pass',
    },
    findings,
  };

  if (options.write !== false) writeJson(artifactPath(projectRoot, ARTIFACTS.sourceLedger, { planningDir }), report);
  return report;
}

function checkPlanningSourceLedger(options = {}) {
  const report = buildPlanningSourceLedger(options);
  return {
    ...report,
    passed: options.strict ? !report.findings.length : !report.findings.some((item) => item.severity === 'critical'),
  };
}

function render(report) {
  return [
    `planning-source-ledger: ${report.summary.status}`,
    `sources=${report.summary.sourceCount} inputs=${report.summary.inputCount} findings=${report.findings.length}`,
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'help') {
    process.stdout.write('usage: cobolt-planning-source-ledger generate|check [--project <dir>] [--json] [--strict]\n');
    return 0;
  }
  const report = options.command === 'check' ? checkPlanningSourceLedger(options) : buildPlanningSourceLedger(options);
  printJsonOrHuman(report, options.json, render);
  if (options.command === 'check' && report.passed === false) return options.strict ? 1 : 0;
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  TOOL_ID,
  buildPlanningSourceLedger,
  checkPlanningSourceLedger,
  main,
};
