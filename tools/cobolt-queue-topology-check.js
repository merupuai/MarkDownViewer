#!/usr/bin/env node

// CoBolt Queue Topology Check — deterministic message-queue producer/consumer verifier.
//
// Covers: NATS, Kafka (kafkajs), RabbitMQ (amqplib), Redis pub/sub, BullMQ, AWS SQS,
// and a generic event-bus fallback. Patterns live in lib/cobolt-messaging-patterns.js.
//
// Tier policy (conditional):
//   - If `cobolt-queue-manifest.json` is present at the project root → Tier 1
//     hard-block on topology mismatch (manifest is the contract).
//   - Otherwise → Tier 2 advisory: detect orphans, record confidence levels,
//     return exit 0 + warning flag. The calling skill can elect to treat it
//     as Tier 1 via state.
//
// Exit contract:
//   0 — all orphans explained (paired, declared in manifest, or unresolvable)
//   1 — Tier 1 mode (manifest present) + undeclared orphan(s)
//   2 — queue libraries referenced in code but not in package.json (dep drift)
//   3 — infra unavailable (reserved)
//
// Bypass: COBOLT_QUEUE_TOPOLOGY=off (logged)
// Artifact: _cobolt-output/latest/build/{M}/{M}-queue-topology.json

const fs = require('node:fs');
const path = require('node:path');
const { buildProvenance } = require('./_brownfield-provenance');
const {
  QUEUE_PUBLISH_PATTERNS,
  QUEUE_SUBSCRIBE_PATTERNS,
  findSubjectMatches,
  findUnresolvableSubjects,
  computeTopology,
} = require('../lib/cobolt-messaging-patterns');
const { loadManifest, classifyAgainstManifest } = require('../lib/cobolt-messaging-topology-manifest');

const TOOL_NAME = 'cobolt-queue-topology-check';
const TOOL_VERSION = '1.0';

const QUEUE_DEP_TO_TECH = {
  kafkajs: 'kafka',
  'node-rdkafka': 'kafka',
  amqplib: 'amqp',
  'amqp-connection-manager': 'amqp',
  nats: 'nats',
  'node-nats-streaming': 'nats',
  bull: 'bullmq',
  bullmq: 'bullmq',
  '@aws-sdk/client-sqs': 'sqs',
  'aws-sdk': 'sqs',
  ioredis: 'redis',
  redis: 'redis',
};

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function detectDeclaredQueueTechs(projectDir) {
  const pkgPath = path.join(projectDir, 'package.json');
  const techs = new Set();
  if (!fs.existsSync(pkgPath)) return techs;
  try {
    const pkg = JSON.parse(readText(pkgPath));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const name of Object.keys(deps)) {
      const tech = QUEUE_DEP_TO_TECH[name];
      if (tech) techs.add(tech);
    }
  } catch {
    /* malformed package.json */
  }
  return techs;
}

function confidenceFor(sites) {
  // High confidence: at least 2 non-test files reference the subject
  // Medium: single site
  // Low: only matched via eventbus/generic pattern
  const techs = new Set(sites.map((s) => s.tech));
  if (techs.has('eventbus') && techs.size === 1) return 'low';
  if (sites.length >= 2) return 'high';
  return 'medium';
}

function scan(projectDir) {
  const resolved = path.resolve(projectDir);
  const declaredTechs = detectDeclaredQueueTechs(resolved);

  const publishers = findSubjectMatches(resolved, QUEUE_PUBLISH_PATTERNS);
  const subscribers = findSubjectMatches(resolved, QUEUE_SUBSCRIBE_PATTERNS);
  const topology = computeTopology(publishers.subjects, subscribers.subjects);

  const unresolvable = findUnresolvableSubjects(resolved, [
    'Publish',
    'publish',
    'Subscribe',
    'subscribe',
    'send',
    'consume',
    'add',
    'process',
  ]);

  const manifestResult = loadManifest(resolved);
  const classified = manifestResult.declared ? classifyAgainstManifest(manifestResult, topology) : null;

  // Build per-orphan records with confidence + declared-status annotations.
  function annotate(list, sideName) {
    return list.map((o) => {
      const sites = (sideName === 'pub' ? publishers.subjects : subscribers.subjects).get(o.subject) || [];
      return {
        subject: o.subject,
        tech: o.tech,
        confidence: confidenceFor(sites),
        declaredInManifest: Boolean(
          classified && [...classified.declared.pubs, ...classified.declared.subs].some((x) => x.subject === o.subject),
        ),
        sites: o.sites,
      };
    });
  }

  const annotatedOrphanPubs = annotate(topology.orphanedPublishers, 'pub');
  const annotatedOrphanSubs = annotate(topology.orphanedSubscribers, 'sub');

  // Detect tech used in code vs declared in deps.
  // Honest limit: patterns overlap (NATS .Publish and Redis .Publish collide).
  // Therefore "missing-dep drift" is only flagged when NO queue deps are
  // declared at all AND at least one non-eventbus site exists. Per-tech
  // attribution would require ast-grep resolution and is out of scope for v1.
  const observedTechs = new Set();
  for (const sites of publishers.subjects.values()) {
    for (const s of sites) observedTechs.add(s.tech);
  }
  for (const sites of subscribers.subjects.values()) {
    for (const s of sites) observedTechs.add(s.tech);
  }
  observedTechs.delete('eventbus');
  const hasSpecificCode = observedTechs.size > 0;
  const missingDepsForTechs = hasSpecificCode && declaredTechs.size === 0 ? [...observedTechs].sort() : [];

  const report = {
    generatedAt: new Date().toISOString(),
    generatedBy: TOOL_NAME,
    version: TOOL_VERSION,
    ...buildProvenance(resolved, []),
    declaredTechs: [...declaredTechs].sort(),
    observedTechs: [...observedTechs].sort(),
    missingDepsForTechs,
    manifest: {
      declared: manifestResult.declared,
      path: manifestResult.path,
      issues: manifestResult.issues,
      queueCount: manifestResult.queues.length,
      channelCount: manifestResult.channels.length,
    },
    summary: {
      totalSubjects: topology.totalSubjects,
      paired: topology.pairedSubjects,
      orphanedPublishers: annotatedOrphanPubs.length,
      orphanedSubscribers: annotatedOrphanSubs.length,
      declaredInManifest: classified ? classified.declared.pubs.length + classified.declared.subs.length : 0,
      undeclaredOrphans: classified
        ? classified.undeclared.pubs.length + classified.undeclared.subs.length
        : annotatedOrphanPubs.length + annotatedOrphanSubs.length,
      unresolvable: unresolvable.length,
      codePresent: topology.totalSubjects > 0,
    },
    orphanedPublishers: annotatedOrphanPubs,
    orphanedSubscribers: annotatedOrphanSubs,
    unresolvable: unresolvable.slice(0, 100),
    honestLimits: [
      'Dynamic queue names (process.env.X, template literals, identifiers) are flagged as unresolvable — tool does not fail on them.',
      'Cross-service producers/consumers require declaration in cobolt-queue-manifest.json.',
      'Eventbus generic patterns (.emit/.on) have low confidence; false positives are possible — annotate with confidence:low.',
      'SQS regex heuristic matches QueueUrl paths; runtime-constructed URLs are unresolvable.',
    ],
  };

  return report;
}

function decideExitCode(report) {
  // GT-01: bypass routes through signed ledger. Env-var auto-promoted during window.
  const { isGateBypassed } = require('../lib/cobolt-bypass-resolver');
  if (isGateBypassed('queue-topology', { projectRoot: process.cwd() })) return { code: 0, bypass: true };
  const { codePresent } = report.summary;
  if (!codePresent) return { code: 0, reason: 'no-queue-code' };
  if (Array.isArray(report.missingDepsForTechs) && report.missingDepsForTechs.length > 0) {
    return { code: 2, reason: 'queue-tech-without-deps', techs: report.missingDepsForTechs };
  }
  if (report.manifest.declared) {
    // Tier 1: any undeclared orphan is a hard fail.
    if (report.summary.undeclaredOrphans > 0) {
      return { code: 1, reason: 'undeclared-orphans-tier1', count: report.summary.undeclaredOrphans };
    }
    return { code: 0, reason: 'all-declared-or-paired-tier1' };
  }
  // Tier 2 advisory: orphans logged but not blocking.
  return {
    code: 0,
    reason: 'advisory-tier2',
    advisoryOrphans: report.summary.orphanedPublishers + report.summary.orphanedSubscribers,
  };
}

function writeReport(filePath, report) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return resolved;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(
      [
        'Usage:',
        '  cobolt-queue-topology-check scan [project-path] [--milestone Mn] [--json] [--output <path>]',
        '',
        'Exit codes:',
        '  0 — all paired or advisory (manifest absent)',
        '  1 — Tier 1: manifest present and undeclared orphans found',
        '  2 — queue libraries referenced in code but not declared in package.json',
        '  3 — infra unavailable (reserved)',
        '',
        'Tier upgrade: presence of cobolt-queue-manifest.json elevates this to Tier 1.',
        'Bypass: COBOLT_QUEUE_TOPOLOGY=off (logged).',
      ].join('\n'),
    );
    process.exit(0);
  }

  if (command !== 'scan') {
    console.error(`Unknown command: ${command}. Run with --help.`);
    process.exit(2);
  }

  let projectDir = process.cwd();
  let outputPath = null;
  let milestone = process.env.COBOLT_MILESTONE || null;
  const jsonMode = args.includes('--json');

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) outputPath = args[++i];
    else if (args[i] === '--milestone' && args[i + 1]) milestone = args[++i];
    else if (args[i] === '--project' && args[i + 1]) projectDir = path.resolve(args[++i]);
    else if (!args[i].startsWith('--')) projectDir = path.resolve(args[i]);
  }

  const report = scan(projectDir);
  const target =
    outputPath ||
    (milestone
      ? path.join(projectDir, '_cobolt-output', 'latest', 'build', milestone, `${milestone}-queue-topology.json`)
      : path.join(projectDir, '_cobolt-output', 'latest', 'build', 'queue-topology.json'));
  writeReport(target, report);

  const verdict = decideExitCode(report);
  report.verdict = verdict;

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[${TOOL_NAME}] ${report.summary.totalSubjects} subject(s) scanned`);
    console.log(`  Manifest: ${report.manifest.declared ? 'DECLARED (Tier 1)' : 'ABSENT (Tier 2 advisory)'}`);
    console.log(`  Paired: ${report.summary.paired}`);
    console.log(`  Orphan publishers: ${report.summary.orphanedPublishers}`);
    console.log(`  Orphan subscribers: ${report.summary.orphanedSubscribers}`);
    console.log(`  Unresolvable: ${report.summary.unresolvable}`);
    console.log(`  Verdict: exit ${verdict.code} (${verdict.reason || 'bypass'})`);
    console.log(`  Written: ${target}`);
  }

  process.exit(verdict.code);
}

module.exports = { scan, detectDeclaredQueueTechs, decideExitCode, confidenceFor };
