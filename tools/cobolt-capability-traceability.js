#!/usr/bin/env node

// CoBolt Capability Traceability Gate (v0.48+)
//
// Census gate that asserts every user-provided capability spec (docs/capabilities/*.md or
// similar classified at intake) is traced to at least one downstream planning artifact:
// a capability contract, an epic, or a story. Fails fast when specs become ghosts.
//
// Reads:
//   _cobolt-output/latest/planning/capability-spec-index.json  (emitted by source-intake)
//   _cobolt-output/latest/planning/capability-contracts/*.contract.json  (sourceIds references)
//   _cobolt-output/latest/planning/epics.md                    (specId / path mentions)
// At --stage final, additionally requires:
//   _cobolt-output/latest/planning/feature-service-blueprints.md
//   _cobolt-output/latest/planning/story-tracker.json          (story-level spec references)
//
// Subcommands:
//   check   Run the gate; exit 1 with untracedSpecs[] on any ghost spec
//
// Exit codes (per tools/CLAUDE.md contract):
//   0  success (either all specs traced OR no capability-spec-index present)
//   1  hard error (gate failed, bug, usage error)
//   2  missing optional dep (reserved)
//   3  missing infra (planning directory absent)

const fs = require('node:fs');
const path = require('node:path');

const { getPlanningDir } = (() => {
  try {
    return require('../lib/cobolt-planning-artifacts');
  } catch {
    return {
      getPlanningDir: (root) => path.join(root || process.cwd(), '_cobolt-output', 'latest', 'planning'),
    };
  }
})();

function isCapabilityPipelineDisabled() {
  const flag = (process.env.COBOLT_CAPABILITY_PIPELINE || '').toLowerCase();
  return flag === 'off' || flag === '0' || flag === 'false';
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readTextSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function listContractFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.contract.json'))
    .map((f) => path.join(dir, f));
}

function resolvePaths(cwd) {
  const root = cwd || process.cwd();
  const planningDir = getPlanningDir(root) || path.join(root, '_cobolt-output', 'latest', 'planning');
  return {
    root,
    planningDir,
    capabilitySpecIndexFile: path.join(planningDir, 'capability-spec-index.json'),
    contractsDir: path.join(planningDir, 'capability-contracts'),
    epicsFile: path.join(planningDir, 'epics.md'),
    blueprintsFile: path.join(planningDir, 'feature-service-blueprints.md'),
    storyTrackerFile: path.join(planningDir, 'story-tracker.json'),
  };
}

function ensurePlanningDir(paths) {
  if (!fs.existsSync(paths.planningDir)) {
    return { ok: false, exitCode: 3, message: `Planning directory missing at ${paths.planningDir}` };
  }
  return { ok: true };
}

function collectContractReferences(contractsDir) {
  const files = listContractFiles(contractsDir);
  const refs = new Map(); // specId/path → Set(featureId)
  for (const file of files) {
    const contract = readJsonSafe(file);
    if (!contract) continue;
    const featureId = contract.featureId || path.basename(file, '.contract.json');
    const sourceIds = Array.isArray(contract.sourceIds) ? contract.sourceIds : [];
    for (const id of sourceIds) {
      const normalized = String(id).replace(/\\/g, '/');
      if (!refs.has(normalized)) refs.set(normalized, new Set());
      refs.get(normalized).add(featureId);
    }
  }
  return refs;
}

function specIsTracedBy(spec, { contractRefs, epicsText, blueprintsText, storyTrackerText, stage }) {
  const reasons = [];
  const indexedFeatures = Array.isArray(spec.traced?.features) ? spec.traced.features : [];
  if (indexedFeatures.length > 0) reasons.push(`traced.features=[${indexedFeatures.join(',')}]`);

  const specPath = (spec.path || '').replace(/\\/g, '/');
  const specBasename = specPath ? path.basename(specPath) : '';
  const specId = spec.specId || '';

  const matchingContractRefs = new Set();
  for (const [refKey, featureIds] of contractRefs.entries()) {
    const match =
      (specPath && refKey.endsWith(specPath)) ||
      (specBasename && refKey.endsWith(specBasename)) ||
      (specId && refKey.includes(specId));
    if (match) {
      for (const fid of featureIds) matchingContractRefs.add(fid);
    }
  }
  if (matchingContractRefs.size > 0) reasons.push(`contracts=[${[...matchingContractRefs].sort().join(',')}]`);

  if (epicsText && ((specPath && epicsText.includes(specPath)) || (specId && epicsText.includes(specId)))) {
    reasons.push('epics.md');
  }

  if (stage === 'final') {
    if (
      blueprintsText &&
      ((specPath && blueprintsText.includes(specPath)) || (specId && blueprintsText.includes(specId)))
    ) {
      reasons.push('feature-service-blueprints.md');
    }
    if (
      storyTrackerText &&
      ((specPath && storyTrackerText.includes(specPath)) || (specId && storyTrackerText.includes(specId)))
    ) {
      reasons.push('story-tracker.json');
    }
  }

  return reasons;
}

function cmdCheck(argv) {
  const flags = parseFlags(argv);
  const stage = flags.stage || 'intake';
  if (stage !== 'intake' && stage !== 'final') {
    fail(flags, { ok: false, message: `Invalid --stage ${stage}. Use intake or final.` }, 1);
    return;
  }

  const paths = resolvePaths(flags.cwd);
  const infra = ensurePlanningDir(paths);
  if (!infra.ok) {
    fail(flags, { ok: false, message: infra.message }, infra.exitCode);
    return;
  }

  // Null-capabilities path: no index → nothing to census → pass vacuously.
  if (isCapabilityPipelineDisabled()) {
    emit(flags, {
      ok: true,
      command: 'check',
      stage,
      skipped: 'capability-pipeline-disabled',
      capabilityPipelineDisabled: true,
    });
    return;
  }

  const index = readJsonSafe(paths.capabilitySpecIndexFile);
  if (!index || !Array.isArray(index.specs) || index.specs.length === 0) {
    emit(flags, {
      ok: true,
      command: 'check',
      stage,
      skipped: 'no-capability-spec-index',
      specCount: 0,
    });
    return;
  }

  const contractRefs = collectContractReferences(paths.contractsDir);
  const epicsText = readTextSafe(paths.epicsFile) || '';
  const blueprintsText = stage === 'final' ? readTextSafe(paths.blueprintsFile) || '' : '';
  const storyTrackerText = stage === 'final' ? readTextSafe(paths.storyTrackerFile) || '' : '';

  const missingFinalArtifacts = [];
  if (stage === 'final') {
    if (!fs.existsSync(paths.blueprintsFile)) missingFinalArtifacts.push('feature-service-blueprints.md');
    if (!fs.existsSync(paths.storyTrackerFile)) missingFinalArtifacts.push('story-tracker.json');
  }

  const tracedSpecs = [];
  const untracedSpecs = [];

  for (const spec of index.specs) {
    const reasons = specIsTracedBy(spec, { contractRefs, epicsText, blueprintsText, storyTrackerText, stage });
    if (reasons.length > 0) {
      tracedSpecs.push({ specId: spec.specId, path: spec.path, reasons });
    } else {
      untracedSpecs.push({ specId: spec.specId, path: spec.path, title: spec.title || '' });
    }
  }

  const passing = untracedSpecs.length === 0 && missingFinalArtifacts.length === 0;
  const payload = {
    ok: passing,
    command: 'check',
    stage,
    specCount: index.specs.length,
    tracedCount: tracedSpecs.length,
    untracedCount: untracedSpecs.length,
    tracedSpecs,
    untracedSpecs,
    missingFinalArtifacts,
    capabilitySpecIndexFile: paths.capabilitySpecIndexFile,
  };

  if (passing) {
    emit(flags, payload);
  } else {
    fail(flags, payload, 1);
  }
}

function parseFlags(argv) {
  const flags = { json: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--stage') flags.stage = argv[++i];
    else if (a === '--cwd') flags.cwd = argv[++i];
    else positional.push(a);
  }
  flags.positional = positional;
  return flags;
}

function emit(flags, payload) {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderHuman(payload)}\n`);
  }
  process.exit(0);
}

function fail(flags, payload, code) {
  const exitCode = typeof code === 'number' ? code : 1;
  const body = typeof payload === 'string' ? { ok: false, message: payload } : payload;
  if (flags.json) {
    // tool exit-code contract (tools/CLAUDE.md): failure is signaled by exit
    // code, not by stream choice. Structured JSON output belongs on stdout
    // regardless of pass/fail so consumers can parse it reliably.
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  } else {
    process.stderr.write(`${renderHuman(body)}\n`);
  }
  process.exit(exitCode);
}

function renderHuman(payload) {
  if (!payload || typeof payload !== 'object') return String(payload);
  const lines = [];
  lines.push(`Command: ${payload.command || 'check'}`);
  if (payload.stage) lines.push(`Stage:   ${payload.stage}`);
  if (payload.skipped) lines.push(`Skipped: ${payload.skipped}`);
  if (payload.specCount !== undefined) {
    lines.push(
      `Specs:   ${payload.specCount} (${payload.tracedCount || 0} traced, ${payload.untracedCount || 0} untraced)`,
    );
  }
  if (Array.isArray(payload.untracedSpecs) && payload.untracedSpecs.length > 0) {
    lines.push('Untraced capability specs:');
    for (const spec of payload.untracedSpecs) {
      lines.push(`  - ${spec.specId} (${spec.path})`);
    }
  }
  if (Array.isArray(payload.missingFinalArtifacts) && payload.missingFinalArtifacts.length > 0) {
    lines.push(`Missing --stage final artifacts: ${payload.missingFinalArtifacts.join(', ')}`);
  }
  if (payload.message) lines.push(payload.message);
  return lines.join('\n');
}

function printUsage() {
  const body = `
CoBolt Capability Traceability Gate — census every capability spec back to ≥1 planning artifact.

Usage:
  node tools/cobolt-capability-traceability.js check [--stage intake|final] [--json] [--cwd <dir>]

The gate is a no-op unless _cobolt-output/latest/planning/capability-spec-index.json exists.
The index is produced by source intake (v0.48+) when docs/capabilities/*.md are supplied.

At --stage intake (default): each spec must be referenced by contract sourceIds OR traced.features OR epics.md.
At --stage final: additionally, feature-service-blueprints.md and story-tracker.json must reference every spec.

Kill-switch: COBOLT_CAPABILITY_PIPELINE=off  → gate passes vacuously.

Exit codes:
  0  Success (or skipped because no specs indexed)
  1  Hard error (untraced specs, missing final artifacts, usage error)
  3  Missing infra (planning directory absent)
`.trim();
  process.stdout.write(`${body}\n`);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case 'check':
      return cmdCheck(rest);
    case '--help':
    case '-h':
    case undefined:
      printUsage();
      return;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n`);
      printUsage();
      process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  resolvePaths,
  collectContractReferences,
  specIsTracedBy,
};
