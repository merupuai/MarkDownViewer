#!/usr/bin/env node

// CoBolt Contract Synthesize — brownfield v0.41 bridge.
//
// Problem: v0.41 plan-close requires 11 machine-checkable contracts in
// `_cobolt-output/latest/planning/` authored by milestone-architect. Brownfield
// projects ingested into v0.41 have no such author — they have architecture.md,
// infra-manifest.json, and a real codebase. Without a bridge, brownfield cannot
// complete plan-close in v0.41+.
//
// This tool synthesizes low-confidence starter contracts from whatever
// evidence exists on disk. Every emitted contract carries:
//   - producedBy: "synthesis-shim/v0.41.1"      (matches SYNTHESIS_PRODUCER_PATTERN)
//   - provenance.source: "synthesis-shim"
//   - provenance.confidence: "low"
//   - provenance.sourceArtifacts: [paths it read]
//
// Gate posture: synthesis-authored contracts are APPROVED by the gates but
// flagged low-confidence in the audit log. The expectation is that the user
// re-runs /cobolt-plan so milestone-architect replaces each with a
// high-confidence agent-authored contract before the project promotes from
// --scan to --plan.
//
// Exit codes (per tools/CLAUDE.md contract):
//   0 — wrote one or more contracts (or all already present; `--force` overrides).
//   1 — hard error (invalid flags, un-parseable input evidence, write failure).
//   2 — missing optional dependency.
//   3 — missing infrastructure (e.g. no `_cobolt-output/` directory at all).
//
// Usage:
//   node tools/cobolt-contract-synthesize.js [--project-root <dir>] [--force]
//                                            [--only <comma-separated-list>]
//                                            [--dry-run] [--json]

const fs = require('node:fs');
const path = require('node:path');

const CONTRACT_VERSION = '1.0.0';
const TOOL_VERSION = 'v0.41.1';
const PRODUCED_BY = `synthesis-shim/${TOOL_VERSION}`;

const CONTRACTS = [
  'selected-stack-contract',
  'app-surface-contract',
  'milestone-surface-map',
  'test-obligation-map',
  'compliance-scope',
  'sdlc-lifecycle-contract',
  'supply-chain-policy',
  'authz-trigger-policy',
  'feature-delta-policy',
];

function parseArgs(argv) {
  const args = { only: null, force: false, dryRun: false, json: false, projectRoot: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project-root') args.projectRoot = argv[++i];
    else if (a === '--only')
      args.only = argv[++i]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--json') args.json = true;
    else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  const lines = [
    'cobolt-contract-synthesize — brownfield v0.41 contract bridge',
    '',
    'Emits low-confidence synthesis-shim contracts so brownfield projects can',
    'pass v0.41 plan-close. Expectation: re-run /cobolt-plan afterwards so',
    'milestone-architect replaces each with a high-confidence contract.',
    '',
    'Options:',
    '  --project-root <dir>   Project root (default: cwd)',
    '  --only a,b,c           Only synthesize these contracts (omit suffix)',
    '  --force                Overwrite existing contracts',
    '  --dry-run              Print what would be written; write nothing',
    '  --json                 Emit machine-readable summary',
    '',
    `Contracts: ${CONTRACTS.join(', ')}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readJsonIfExists(filePath) {
  const raw = readIfExists(filePath);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function inferProjectId(projectRoot) {
  const pkg = readJsonIfExists(path.join(projectRoot, 'package.json'));
  if (pkg?.name) return pkg.name;
  const cargo = readIfExists(path.join(projectRoot, 'Cargo.toml'));
  if (cargo) {
    const m = cargo.match(/name\s*=\s*"([^"]+)"/);
    if (m) return m[1];
  }
  return path.basename(projectRoot);
}

function inferStack(projectRoot) {
  const pkg = readJsonIfExists(path.join(projectRoot, 'package.json'));
  const hasVite = Boolean(pkg?.devDependencies?.vite || pkg?.dependencies?.vite);
  const hasReact = Boolean(pkg?.dependencies?.react);
  const hasFastapi = Boolean(
    readIfExists(path.join(projectRoot, 'requirements.txt'))?.match(/fastapi/i) ||
      readIfExists(path.join(projectRoot, 'pyproject.toml'))?.match(/fastapi/i),
  );
  const hasExpress = Boolean(pkg?.dependencies?.express);
  const hasPhoenix = Boolean(readIfExists(path.join(projectRoot, 'mix.exs'))?.match(/phoenix/));
  return {
    frontend: {
      framework: hasReact ? 'react' : 'html-only',
      bundler: hasVite ? 'vite' : undefined,
      entrypoint: hasReact ? 'frontend/src/main.tsx' : 'public/index.html',
      devServer: { cmd: hasVite ? 'npm run dev' : 'echo no-dev-server', port: 5173 },
      requiredFolders: hasReact ? ['frontend/src'] : ['public'],
    },
    backend: {
      language: hasFastapi ? 'python' : hasPhoenix ? 'elixir' : 'node',
      framework: hasFastapi ? 'fastapi' : hasPhoenix ? 'phoenix' : hasExpress ? 'express' : 'unknown',
      entrypoint: hasFastapi ? 'backend/app/main.py' : hasExpress ? 'backend/src/index.js' : 'backend/src/index.js',
      devServer: { cmd: hasFastapi ? 'uvicorn backend.app.main:app' : 'npm run backend', port: 8000 },
      requiredFolders: [hasFastapi ? 'backend/app' : 'backend/src'],
    },
  };
}

function buildSelectedStack(projectRoot, projectId, sourceArtifacts) {
  const stack = inferStack(projectRoot);
  return {
    contractVersion: CONTRACT_VERSION,
    projectId,
    generatedAt: nowIso(),
    producedBy: PRODUCED_BY,
    provenance: { source: 'synthesis-shim', confidence: 'low', sourceArtifacts },
    frontend: stack.frontend,
    backend: stack.backend,
    integrations: [],
    testCommands: { unit: { cmd: 'npm test' }, integration: { cmd: 'npm run test:integration' } },
    reachability: {
      mode: 'generic',
      frontendRouteRegistry: { path: stack.frontend.entrypoint, format: 'js-ast' },
      backendRouteRegistry: {
        path: stack.backend.entrypoint,
        format: stack.backend.framework === 'fastapi' ? 'python-fastapi-routes' : 'express-routes',
      },
    },
  };
}

function buildAppSurface(projectId, sourceArtifacts) {
  // Synthesis default: one placeholder screen + one placeholder API so the
  // gate's "at least one populated surface" invariant holds. The user is
  // expected to re-run /cobolt-plan to populate real surfaces.
  return {
    contractVersion: CONTRACT_VERSION,
    projectId,
    generatedAt: nowIso(),
    producedBy: PRODUCED_BY,
    provenance: { source: 'synthesis-shim', confidence: 'low', sourceArtifacts },
    screens: [
      {
        screenId: 'S-SYNTH-PLACEHOLDER',
        route: '/',
        componentPath: 'frontend/src/App.tsx',
        ownerFR: ['FR-SYNTH-0001'],
        auth: 'public',
      },
    ],
    apis: [
      {
        apiId: 'A-SYNTH-HEALTH',
        method: 'GET',
        path: '/api/healthz',
        handlerPath: 'backend/src/health.ts',
        ownerFR: ['FR-SYNTH-0001'],
        auth: 'public',
      },
    ],
    workers: [],
    jobs: [],
    events: [],
    commands: [],
  };
}

function buildMilestoneSurfaceMap(projectId, milestones, sourceArtifacts) {
  // Map every declared milestone to the synthesized surfaces so cross-contract
  // integrity holds. If no milestones.md present, synthesize a lone M1.
  const milestoneIds = milestones.length > 0 ? milestones : ['M1'];
  const entries = {};
  for (const mId of milestoneIds) {
    entries[mId] = {
      screens: ['S-SYNTH-PLACEHOLDER'],
      apis: ['A-SYNTH-HEALTH'],
      workers: [],
      jobs: [],
      events: [],
      commands: [],
      frBindings: { 'FR-SYNTH-0001': ['S-SYNTH-PLACEHOLDER', 'A-SYNTH-HEALTH'] },
    };
  }
  return {
    contractVersion: CONTRACT_VERSION,
    projectId,
    generatedAt: nowIso(),
    producedBy: PRODUCED_BY,
    provenance: { source: 'synthesis-shim', confidence: 'low', sourceArtifacts },
    milestones: entries,
  };
}

function buildTestObligationMap(projectId, milestones, sourceArtifacts) {
  const milestoneIds = milestones.length > 0 ? milestones : ['M1'];
  const entries = {};
  for (const mId of milestoneIds) {
    entries[mId] = {
      classes: { unit: true, integration: true, e2e: true },
      computed: { frCount: 1, storyCount: 1, minTestsRequired: Math.max(1 * 2, 1 * 1) },
    };
  }
  return {
    contractVersion: CONTRACT_VERSION,
    projectId,
    generatedAt: nowIso(),
    producedBy: PRODUCED_BY,
    provenance: { source: 'synthesis-shim', confidence: 'low', sourceArtifacts },
    defaults: { minTestsPerFr: 2, minTestsPerStory: 1 },
    milestones: entries,
  };
}

function buildComplianceScope(projectId, sourceArtifacts) {
  return {
    contractVersion: CONTRACT_VERSION,
    projectId,
    generatedAt: nowIso(),
    producedBy: PRODUCED_BY,
    provenance: { source: 'synthesis-shim', confidence: 'low', sourceArtifacts },
    frameworks: [],
    notApplicable: {
      reason:
        'Synthesis-shim default: compliance scope not yet declared. Re-run /cobolt-plan so milestone-architect emits the real scope from PRD + jurisdiction.',
    },
    dataClassification: { classes: [] },
    jurisdictionalScope: [],
  };
}

function buildSdlcLifecycle(projectId, sourceArtifacts) {
  return {
    contractVersion: CONTRACT_VERSION,
    projectId,
    generatedAt: nowIso(),
    producedBy: PRODUCED_BY,
    provenance: { source: 'synthesis-shim', confidence: 'low', sourceArtifacts },
    stages: [
      { name: 'planning', owner: 'planning', exitCriteria: ['all 11 contracts emitted'] },
      { name: 'build', owner: 'build', exitCriteria: ['milestone close evidence present'] },
      { name: 'release', owner: 'release', exitCriteria: ['release evidence pack signed'] },
      { name: 'deploy', owner: 'deploy', exitCriteria: ['deploy readiness verified'] },
      { name: 'operate', owner: 'operate', exitCriteria: ['runbook + observability configured'] },
    ],
    environments: { promotionLadder: ['dev', 'staging', 'production'] },
    incidentSlos: { detectionMinutes: 15, ackMinutes: 30, resolutionMinutes: 240 },
  };
}

function buildSupplyChain(projectId, sourceArtifacts) {
  // supply-chain-policy uses `provenance` for SLSA + attestation + signing,
  // so authorship metadata lives under `authorshipProvenance` per the schema.
  return {
    contractVersion: CONTRACT_VERSION,
    projectId,
    generatedAt: nowIso(),
    producedBy: PRODUCED_BY,
    authorshipProvenance: { source: 'synthesis-shim', confidence: 'low', sourceArtifacts },
    sbom: { format: 'cyclonedx', requiredAtRelease: true },
    vulnerabilities: { thresholds: { critical: 0, high: 5 }, blockRelease: true },
    licenses: { allowlist: ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC'], denylist: ['GPL-3.0'] },
    secrets: { scanningTool: 'trufflehog', blockOnFinding: true },
    containerPolicy: { privileged: 'denied', rootUser: 'denied' },
    iacPolicy: { scanner: 'checkov', blockOnCritical: true },
    provenance: { slsaTier: 2, attestationRequired: true, signing: { tool: 'cosign', required: true } },
  };
}

function buildAuthzTrigger(projectId, sourceArtifacts) {
  return {
    contractVersion: CONTRACT_VERSION,
    projectId,
    generatedAt: nowIso(),
    producedBy: PRODUCED_BY,
    provenance: { source: 'synthesis-shim', confidence: 'low', sourceArtifacts },
    triggers: {
      hasApiSurface: false,
      hasRbac: false,
      isMultiTenant: false,
      hasAdminSurface: false,
      hasPermissionBearingTokens: false,
    },
    decision: {
      matrixRequired: false,
      notApplicableReason:
        'Synthesis-shim default: authz posture not yet analysed. Re-run /cobolt-plan for real trigger detection.',
    },
  };
}

function buildFeatureDelta(projectId, sourceArtifacts) {
  return {
    contractVersion: CONTRACT_VERSION,
    projectId,
    generatedAt: nowIso(),
    producedBy: PRODUCED_BY,
    provenance: { source: 'synthesis-shim', confidence: 'low', sourceArtifacts },
    hardTriggers: {
      newRegulatedData: true,
      newTenantBoundary: true,
      newIntegration: true,
      schemaMigration: true,
      newSlo: true,
      newInfrastructure: true,
    },
    classificationDefault: 'local',
  };
}

function discoverMilestones(projectRoot) {
  const milestonesDir = path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'milestones');
  const milestonesMd = path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'milestones.md');
  const ids = new Set();
  try {
    if (fs.existsSync(milestonesDir)) {
      for (const entry of fs.readdirSync(milestonesDir)) {
        const m = entry.match(/^(M\d+)/);
        if (m) ids.add(m[1]);
      }
    }
  } catch {
    /* best-effort */
  }
  const md = readIfExists(milestonesMd);
  if (md) {
    for (const m of md.matchAll(/\bM(\d+)\b/g)) ids.add(`M${m[1]}`);
  }
  return Array.from(ids).sort();
}

function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function synthesize(args) {
  const projectRoot = path.resolve(args.projectRoot || process.cwd());
  const planningDir = path.join(projectRoot, '_cobolt-output', 'latest', 'planning');
  const outDir = planningDir;
  const outputRoot = path.join(projectRoot, '_cobolt-output');
  if (!fs.existsSync(outputRoot)) {
    return { code: 3, error: `_cobolt-output/ not found at ${outputRoot} — run /cobolt-init first.` };
  }
  fs.mkdirSync(planningDir, { recursive: true });

  const projectId = inferProjectId(projectRoot);
  const milestones = discoverMilestones(projectRoot);

  const sourceArtifacts = [
    'package.json',
    '_cobolt-output/latest/planning/milestones.md',
    '_cobolt-output/latest/planning/architecture.md',
    '_cobolt-output/latest/planning/infra-manifest.json',
  ].filter((p) => fs.existsSync(path.join(projectRoot, p)));

  const onlySet = args.only ? new Set(args.only) : null;
  const selected = CONTRACTS.filter((c) => !onlySet || onlySet.has(c));

  const results = [];
  for (const contractName of selected) {
    const outPath = path.join(outDir, `${contractName}.json`);
    const existed = fs.existsSync(outPath);
    if (existed && !args.force) {
      results.push({ contract: contractName, status: 'skipped-exists', path: outPath });
      continue;
    }
    let body;
    switch (contractName) {
      case 'selected-stack-contract':
        body = buildSelectedStack(projectRoot, projectId, sourceArtifacts);
        break;
      case 'app-surface-contract':
        body = buildAppSurface(projectId, sourceArtifacts);
        break;
      case 'milestone-surface-map':
        body = buildMilestoneSurfaceMap(projectId, milestones, sourceArtifacts);
        break;
      case 'test-obligation-map':
        body = buildTestObligationMap(projectId, milestones, sourceArtifacts);
        break;
      case 'compliance-scope':
        body = buildComplianceScope(projectId, sourceArtifacts);
        break;
      case 'sdlc-lifecycle-contract':
        body = buildSdlcLifecycle(projectId, sourceArtifacts);
        break;
      case 'supply-chain-policy':
        body = buildSupplyChain(projectId, sourceArtifacts);
        break;
      case 'authz-trigger-policy':
        body = buildAuthzTrigger(projectId, sourceArtifacts);
        break;
      case 'feature-delta-policy':
        body = buildFeatureDelta(projectId, sourceArtifacts);
        break;
      default:
        continue;
    }
    if (args.dryRun) {
      results.push({ contract: contractName, status: 'dry-run', path: outPath });
    } else {
      try {
        atomicWriteJson(outPath, body);
        results.push({ contract: contractName, status: existed ? 'overwritten' : 'created', path: outPath });
      } catch (err) {
        return { code: 1, error: `write failed for ${contractName}: ${err.message}`, results };
      }
    }
  }
  return { code: 0, projectId, milestones, sourceArtifacts, results };
}

function main() {
  const args = parseArgs(process.argv);
  const result = synthesize(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    if (result.code !== 0) {
      process.stderr.write(`FATAL: ${result.error || 'unknown error'}\n`);
    } else {
      process.stdout.write(
        `cobolt-contract-synthesize: projectId=${result.projectId}, milestones=${result.milestones.join(',') || 'none'}\n`,
      );
      for (const r of result.results) {
        process.stdout.write(`  [${r.status}] ${r.contract} -> ${r.path}\n`);
      }
    }
  }
  process.exit(result.code);
}

if (require.main === module) {
  main();
}

module.exports = {
  synthesize,
  CONTRACTS,
  CONTRACT_VERSION,
  PRODUCED_BY,
  // exported for tests
  inferProjectId,
  inferStack,
  discoverMilestones,
  buildSelectedStack,
  buildAppSurface,
  buildMilestoneSurfaceMap,
  buildTestObligationMap,
  buildComplianceScope,
  buildSdlcLifecycle,
  buildSupplyChain,
  buildAuthzTrigger,
  buildFeatureDelta,
};
