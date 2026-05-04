#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { atomicWrite } = require('../lib/cobolt-atomic-write');
const { getPlanningDir, getStoryCoverage, safeReadJson } = require('../lib/cobolt-planning-artifacts');
const { compute } = require('./cobolt-planning-counts');
const { aggregate } = require('./cobolt-readiness-aggregate');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_DRIFT = 3;

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseArgs(argv) {
  const out = { command: 'reconcile', json: false, projectRoot: process.cwd() };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--project' || arg === '--target' || arg === '--cwd' || arg === '--dir') {
      out.projectRoot = argv[i + 1] || out.projectRoot;
      i += 1;
    } else if (arg.startsWith('--project=')) out.projectRoot = arg.slice('--project='.length);
    else if (arg.startsWith('--dir=')) out.projectRoot = arg.slice('--dir='.length);
    else if (arg === '--help' || arg === '-h') out.command = 'help';
    else if (!arg.startsWith('-')) positional.push(arg);
  }
  if (positional.length > 0) out.command = positional[0];
  return out;
}

function countTrackedStoriesWithoutFiles(storyTracker) {
  const stories = Array.isArray(storyTracker?.stories) ? storyTracker.stories : [];
  return stories.filter((story) => !story.storyFile).length;
}

function findInfraManifest(projectRoot) {
  const candidates = [
    path.join(projectRoot, '_cobolt-output', 'latest', 'infra', 'infra-manifest.json'),
    path.join(projectRoot, 'infra-manifest.json'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function buildMasterPlanSnapshot(projectRoot, planningDir, aggregateResult = null) {
  const counts = compute(planningDir);
  const storyTracker = safeReadJson(path.join(planningDir, 'story-tracker.json')) || {};
  const storyCoverage = getStoryCoverage(projectRoot, { planningDir });
  const readiness = aggregateResult || aggregate();
  const requirementsByType = counts.requirements?.byType || {};

  return {
    generatedAt: new Date().toISOString(),
    planningDir,
    counts: {
      features: counts.features?.count ?? null,
      fr: requirementsByType.FR ?? null,
      nfr: requirementsByType.NFR ?? null,
      ir: requirementsByType.IR ?? null,
      totalRequirements: counts.requirements?.count ?? null,
      milestones: counts.milestones?.count ?? null,
      epics: counts.epics?.count ?? null,
      stories: counts.stories?.count ?? null,
    },
    readiness,
    storyCoverage,
    nullStoryFileCount: countTrackedStoriesWithoutFiles(storyTracker),
    hasReleaseChecklist: fs.existsSync(path.join(planningDir, 'release-readiness-checklist.md')),
    hasReadinessDeterministic: fs.existsSync(path.join(planningDir, 'readiness-deterministic.json')),
    hasReadinessReport: fs.existsSync(path.join(planningDir, 'readiness-report.md')),
    hasSprintStatus: fs.existsSync(path.join(planningDir, 'sprint-status.yaml')),
    infraManifestPath: findInfraManifest(projectRoot),
  };
}

function replaceCountLine(content, label, value, suffix = '') {
  if (value == null) return content;
  const pattern = new RegExp(`^- \\*\\*${escapeRegex(label)}:\\*\\*.*$`, 'm');
  if (!pattern.test(content)) return content;
  const prefix = `- **${label}:** `;
  return content.replace(pattern, (line) => {
    const remainder = line.startsWith(prefix) ? line.slice(prefix.length) : '';
    if (/^\d+/.test(remainder)) {
      return `${prefix}${value}${remainder.replace(/^\d+/, '')}`;
    }
    return `${prefix}${value}${suffix}`;
  });
}

function replaceFrontmatterGeneratedAt(content, generatedAt) {
  if (!String(content || '').startsWith('---\n')) return content;
  return content.replace(/^generatedAt:\s*.*$/m, `generatedAt: ${generatedAt}`);
}

function replaceReadyForBuildLine(content, snapshot) {
  const failedGates = (snapshot.readiness?.gates || []).filter((gate) => gate.status === 'FAIL');
  const gateList = failedGates.map((gate) => gate.name).join(', ');
  const line =
    snapshot.readiness?.verdict === 'PASS'
      ? '**Ready for build:** Yes. All plan-close gates are green.'
      : gateList
        ? `**Ready for build:** No. Blocked by failing plan-close gates: ${gateList}.`
        : '**Ready for build:** No. Plan-close readiness is not green.';
  return content.replace(/^\*\*Ready for build:\*\*.*$/m, line);
}

function buildRemainingPhaseWork(snapshot) {
  const items = [];

  for (const gate of snapshot.readiness?.gates || []) {
    if (gate.status !== 'FAIL') continue;
    items.push(`Resolve failing planning gate: \`${gate.name}\`.`);
  }

  if (!snapshot.hasReleaseChecklist) items.push('Generate `release-readiness-checklist.md`.');
  if (!snapshot.hasReadinessDeterministic || !snapshot.hasReadinessReport) {
    items.push('Refresh readiness artifacts from the deterministic checks.');
  }
  if (!snapshot.hasSprintStatus) items.push('Generate `sprint-status.yaml`.');
  if ((snapshot.storyCoverage?.missingStoryIds || []).length > 0) {
    items.push(`Generate missing story files: ${(snapshot.storyCoverage.missingStoryIds || []).join(', ')}.`);
  }
  if (snapshot.nullStoryFileCount > 0) {
    items.push(
      `Reconcile \`story-tracker.json\` with ${snapshot.nullStoryFileCount} unbound story entr${snapshot.nullStoryFileCount === 1 ? 'y' : 'ies'}.`,
    );
  }
  if (!snapshot.infraManifestPath) items.push('Provision `infra-manifest.json`.');

  if (items.length === 0) {
    items.push('None. Phase 5 artifacts and close gates are green.');
  }

  return items;
}

function replaceBulletedList(content, markerLine, items) {
  const lines = String(content || '').split(/\r?\n/);
  const markerIndex = lines.findIndex((line) => line.trim() === markerLine.trim());
  if (markerIndex === -1) return content;

  let start = markerIndex + 1;
  while (start < lines.length && lines[start].trim() === '') start += 1;

  let end = start;
  while (end < lines.length && /^\s*-\s+/.test(lines[end])) end += 1;

  const replacement = items.map((item) => `- ${item}`);
  const nextLines = [...lines.slice(0, start), ...replacement, ...lines.slice(end)];
  return nextLines.join('\n');
}

function reconcileMasterPlanContent(content, snapshot) {
  let next = String(content || '');
  next = replaceFrontmatterGeneratedAt(next, snapshot.generatedAt);
  next = replaceCountLine(next, 'Features (FEAT-NNN)', snapshot.counts.features);
  next = replaceCountLine(next, 'Functional Requirements (FR)', snapshot.counts.fr);
  next = replaceCountLine(next, 'Non-Functional Requirements (NFR)', snapshot.counts.nfr);
  next = replaceCountLine(next, 'Implicit Requirements (IR)', snapshot.counts.ir);
  next = replaceCountLine(next, 'Total requirements in RTM', snapshot.counts.totalRequirements);
  next = replaceCountLine(next, 'Milestones', snapshot.counts.milestones);
  next = replaceCountLine(next, 'Epics', snapshot.counts.epics);
  next = replaceCountLine(next, 'Stories', snapshot.counts.stories);
  next = replaceReadyForBuildLine(next, snapshot);
  next = replaceBulletedList(next, '**Remaining Phase 5 work:**', buildRemainingPhaseWork(snapshot));
  return next;
}

function reconcileMasterPlan(projectRoot, options = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  const planningDir = getPlanningDir(root, { create: false, fallbackToLatest: true });
  if (!planningDir || !fs.existsSync(planningDir)) {
    return { ok: false, exitCode: EXIT_MISSING, error: 'planning directory not found', projectRoot: root };
  }

  const masterPlanPath = path.join(planningDir, 'master-plan.md');
  if (!fs.existsSync(masterPlanPath)) {
    return { ok: false, exitCode: EXIT_MISSING, error: 'master-plan.md not found', projectRoot: root, planningDir };
  }

  const originalCwd = process.cwd();
  let snapshot;
  try {
    if (!options.aggregateResult && originalCwd !== root) process.chdir(root);
    snapshot = buildMasterPlanSnapshot(root, planningDir, options.aggregateResult || null);
  } finally {
    if (process.cwd() !== originalCwd) process.chdir(originalCwd);
  }
  const current = fs.readFileSync(masterPlanPath, 'utf8');
  const reconciled = reconcileMasterPlanContent(current, snapshot);
  const changed = reconciled !== current;

  if (changed && options.write !== false) {
    atomicWrite(masterPlanPath, reconciled.endsWith('\n') ? reconciled : `${reconciled}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  return {
    ok: true,
    exitCode: changed && options.write === false ? EXIT_DRIFT : EXIT_OK,
    changed,
    projectRoot: root,
    planningDir,
    masterPlanPath,
    readinessVerdict: snapshot.readiness?.verdict || 'UNKNOWN',
    failedGates: (snapshot.readiness?.gates || []).filter((gate) => gate.status === 'FAIL').map((gate) => gate.name),
    counts: snapshot.counts,
    remainingWork: buildRemainingPhaseWork(snapshot),
  };
}

function printUsage() {
  console.log('Usage: node tools/cobolt-master-plan-reconcile.js [reconcile|check] [--project <dir>] [--json]');
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.command === 'help') {
    printUsage();
    return EXIT_OK;
  }
  if (!['reconcile', 'check'].includes(args.command)) {
    printUsage();
    return EXIT_USAGE;
  }

  const result = reconcileMasterPlan(args.projectRoot, { write: args.command === 'reconcile' });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.ok) {
    console.error(result.error);
  } else {
    console.log(`[cobolt-master-plan-reconcile] ${result.changed ? 'updated' : 'clean'}: ${result.masterPlanPath}`);
    console.log(`  readiness: ${result.readinessVerdict}`);
    console.log(`  remaining work: ${result.remainingWork.length}`);
  }

  return result.exitCode;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  buildMasterPlanSnapshot,
  buildRemainingPhaseWork,
  reconcileMasterPlan,
  reconcileMasterPlanContent,
  replaceBulletedList,
};
