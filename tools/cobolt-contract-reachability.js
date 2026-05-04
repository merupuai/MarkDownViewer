#!/usr/bin/env node

// CoBolt Contract Reachability (v0.42.0).
//
// Build-stage gate that walks the shipping stack declared in
// _cobolt-output/latest/planning/selected-stack-contract.json and proves every
// surface declared in app-surface-contract.json / milestone-surface-map.json
// is reachable from the shipping entrypoints.
//
// Dispatch (framework-agnostic — declared in the contract, never inferred):
//
//   reachability.mode === "reference"
//     CoBolt ships zero reference walkers in v0.42. Declaring reference mode
//     with any walker name fails closed with a remediation pointing at the
//     "custom" and "generic" modes.
//
//   reachability.mode === "custom"
//     Loads reachability.customPath via Node's require() (subject to a
//     project-root containment check), calls reachability.entrypoint with
//     { projectRoot, contract, surfaces, config }, and accepts the returned
//     per-surface verdicts verbatim.
//
//   reachability.mode === "generic"
//     Parses reachability.frontendRouteRegistry + reachability.backendRouteRegistry
//     with the format adapter named by routeRegistry.format (json | yaml |
//     openapi | regex-line). Adapters read a file, resolve a selector, and
//     return [{ path, method? }]. Reachability then compares app-surface
//     contract screens[].route / apis[].path against the adapter's output +
//     asserts each surface's declared componentPath / handlerPath /
//     producerPath exists on disk.
//
// Exit codes: 0 all surfaces reached, 1 unreached surfaces exist, 2 missing
// dependency (e.g. js-yaml), 3 missing infrastructure (contract files absent
// when --strict), else 1.
//
// Master kill switch: COBOLT_V12_GATES=bypass.
// Per-gate bypass:    COBOLT_CONTRACT_REACHABILITY_GATE=0  (audit-logged).

const fs = require('node:fs');
const path = require('node:path');
const walkers = require('./walkers');
const customLoader = require('./walkers/custom-loader');
const importGraph = require('../lib/cobolt-import-graph');
const { logDecision } = require('../lib/cobolt-gate-audit');

// ---------- args ----------

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: argv[0] && !argv[0].startsWith('-') ? argv[0] : 'check',
    root: process.cwd(),
    milestone: null,
    json: false,
    write: true,
    strict: false,
  };
  const start = args.command === argv[0] ? 1 : 0;
  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' || arg === '--dir') args.root = argv[++i] || args.root;
    else if (arg.startsWith('--root=')) args.root = arg.slice('--root='.length);
    else if (arg.startsWith('--dir=')) args.root = arg.slice('--dir='.length);
    else if (arg === '--milestone' || arg === '-m') args.milestone = normalizeMilestone(argv[++i]);
    else if (arg.startsWith('--milestone=')) args.milestone = normalizeMilestone(arg.slice('--milestone='.length));
    else if (arg === '--json') args.json = true;
    else if (arg === '--no-write') args.write = false;
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--help' || arg === '-h') args.command = 'help';
  }
  return args;
}

function normalizeMilestone(value) {
  const match = String(value || '')
    .trim()
    .match(/^M?(\d+)$/i);
  return match ? `M${Number.parseInt(match[1], 10)}` : null;
}

// ---------- disk helpers ----------

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function fileExists(root, relPath) {
  if (!relPath) return false;
  return fs.existsSync(path.join(root, relPath));
}

function fileHasContent(root, relPath, minBytes = 1) {
  if (!fileExists(root, relPath)) return false;
  try {
    const stat = fs.statSync(path.join(root, relPath));
    return stat.isFile() && stat.size >= minBytes;
  } catch {
    return false;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

// ---------- contract loading ----------

function loadContracts(projectRoot) {
  const planningDir = path.join(projectRoot, '_cobolt-output', 'latest', 'planning');
  const stack = readJson(path.join(planningDir, 'selected-stack-contract.json'));
  const surfaces = readJson(path.join(planningDir, 'app-surface-contract.json'));
  const map = readJson(path.join(planningDir, 'milestone-surface-map.json'));
  return { stack, surfaces, map, planningDir };
}

function surfaceScopeForMilestone(surfaces, map, milestone) {
  if (!map || !milestone) return allSurfaces(surfaces);
  const milestoneEntry = map.milestones?.[milestone] || map[milestone];
  if (!milestoneEntry) return allSurfaces(surfaces);
  const requested = new Set();
  for (const category of ['screens', 'apis', 'workers', 'jobs', 'events', 'commands']) {
    for (const id of milestoneEntry[category] || []) requested.add(id);
  }
  return allSurfaces(surfaces).filter((s) => requested.has(s.surfaceId));
}

function allSurfaces(surfaces) {
  if (!surfaces) return [];
  const out = [];
  const push = (category, arr, idKey, pathKey, extra) => {
    for (const entry of arr || []) {
      out.push({
        category,
        surfaceId: entry[idKey],
        declaredPath: entry[pathKey],
        route: extra?.route ? entry[extra.route] : undefined,
        method: extra?.method ? entry[extra.method] : undefined,
        ownerFR: Array.isArray(entry.ownerFR) ? entry.ownerFR : [],
        raw: entry,
      });
    }
  };
  push('screens', surfaces.screens, 'screenId', 'componentPath', { route: 'route' });
  push('apis', surfaces.apis, 'apiId', 'handlerPath', { route: 'path', method: 'method' });
  push('workers', surfaces.workers, 'workerId', 'handlerPath');
  push('jobs', surfaces.jobs, 'jobId', 'handlerPath');
  push('events', surfaces.events, 'eventId', 'producerPath');
  push('commands', surfaces.commands, 'commandId', 'handlerPath');
  return out;
}

// ---------- generic-mode route matching ----------

function normalizeRoute(routePath) {
  return String(routePath || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\{([^}]+)\}/g, ':$1')
    .toLowerCase();
}

function routeMatches(declared, registry) {
  const d = normalizeRoute(declared);
  return registry.some((r) => normalizeRoute(r.path) === d);
}

function loadRegistryAdapter(projectRoot, registry) {
  if (!registry?.path || !registry?.format) {
    return { ok: false, reason: 'routeRegistry.path and routeRegistry.format are required' };
  }
  const adapter = walkers.resolveGenericAdapter(registry.format);
  if (!adapter) {
    return {
      ok: false,
      reason: `generic adapter "${registry.format}" not shipped in v0.42 (available: ${walkers
        .listGenericAdapters()
        .join(', ')}) — declare an adapter that ships with CoBolt or switch reachability.mode to "custom"`,
      adapterNotShipped: true,
    };
  }
  const abs = path.join(projectRoot, registry.path);
  if (!fs.existsSync(abs)) {
    return { ok: false, reason: `route registry file not found on disk: ${registry.path}` };
  }
  const loaded = adapter.load(abs, { selector: registry.selector });
  return { ok: loaded.ok, routes: loaded.routes || [], errors: loaded.errors || [], missingDep: loaded.missingDep };
}

function importGraphMode() {
  const raw = String(process.env.COBOLT_REACHABILITY_IMPORT_GRAPH || '').toLowerCase();
  if (raw === 'off' || raw === '0') return 'off';
  if (raw === 'strict') return 'strict';
  return 'advisory';
}

function buildImportGraphReach(projectRoot, contract) {
  const frontendEntry = contract.frontend?.entrypoint;
  const backendEntry = contract.backend?.entrypoint;
  const reached = new Set();
  const stats = { frontend: null, backend: null };
  if (frontendEntry) {
    const abs = path.join(projectRoot, frontendEntry);
    if (fs.existsSync(abs)) {
      const result = importGraph.walk(abs, projectRoot);
      for (const rel of result.reached) reached.add(rel);
      stats.frontend = { ...result.stats, entry: frontendEntry };
    } else {
      stats.frontend = { entry: frontendEntry, missing: true };
    }
  }
  if (backendEntry) {
    const abs = path.join(projectRoot, backendEntry);
    if (fs.existsSync(abs)) {
      const result = importGraph.walk(abs, projectRoot);
      for (const rel of result.reached) reached.add(rel);
      stats.backend = { ...result.stats, entry: backendEntry };
    } else {
      stats.backend = { entry: backendEntry, missing: true };
    }
  }
  return { reached, stats };
}

function genericVerdicts(projectRoot, contract, surfaces) {
  const reachability = contract.reachability || {};
  const frontendLoad = loadRegistryAdapter(projectRoot, reachability.frontendRouteRegistry);
  const backendLoad = loadRegistryAdapter(projectRoot, reachability.backendRouteRegistry);
  if (frontendLoad.missingDep || backendLoad.missingDep) {
    return {
      ok: false,
      verdicts: [],
      missingDep: frontendLoad.missingDep || backendLoad.missingDep,
      errors: [...(frontendLoad.errors || []), ...(backendLoad.errors || [])],
    };
  }

  const graphMode = importGraphMode();
  const graph =
    graphMode === 'off' ? { reached: new Set(), stats: null } : buildImportGraphReach(projectRoot, contract);

  const verdicts = [];
  for (const surface of surfaces) {
    const via = [];
    const pathOnDisk = fileHasContent(projectRoot, surface.declaredPath, 1);
    if (pathOnDisk) via.push(`exists:${surface.declaredPath}`);

    let routeHit = null;
    if (surface.category === 'screens') {
      if (frontendLoad.ok && surface.route && routeMatches(surface.route, frontendLoad.routes)) {
        routeHit = `frontendRouteRegistry:${surface.route}`;
        via.push(routeHit);
      }
    } else if (surface.category === 'apis') {
      if (backendLoad.ok && surface.route && routeMatches(surface.route, backendLoad.routes)) {
        routeHit = `backendRouteRegistry:${surface.route}`;
        via.push(routeHit);
      }
    }

    // Import-graph annotation — advisory by default, blocking under --strict.
    let importGraphVerdict = null;
    if (graphMode !== 'off' && pathOnDisk) {
      importGraphVerdict = importGraph.surfaceReachable(graph.reached, surface.declaredPath);
      if (importGraphVerdict.reached) via.push(importGraphVerdict.via || 'import-graph');
    }

    const baseReached =
      pathOnDisk && (surface.category === 'screens' || surface.category === 'apis' ? !!routeHit : true);
    const reached = baseReached && (graphMode === 'strict' && importGraphVerdict ? importGraphVerdict.reached : true);

    let reason;
    if (!reached) {
      if (!pathOnDisk) {
        reason = `declared ${surface.category === 'screens' ? 'componentPath' : surface.category === 'events' ? 'producerPath' : 'handlerPath'} missing or empty: ${surface.declaredPath}`;
      } else if (!routeHit && (surface.category === 'screens' || surface.category === 'apis')) {
        reason = `route "${surface.route}" not present in ${surface.category === 'screens' ? 'frontend' : 'backend'}RouteRegistry`;
      } else if (graphMode === 'strict' && importGraphVerdict && !importGraphVerdict.reached) {
        reason = `strict import-graph check: ${importGraphVerdict.reason}. Disable with COBOLT_REACHABILITY_IMPORT_GRAPH=off or use reachability.mode=custom.`;
      }
    }

    verdicts.push({
      surfaceId: surface.surfaceId,
      category: surface.category,
      reached,
      via,
      reason,
      ownerFR: surface.ownerFR,
      importGraph:
        importGraphVerdict == null
          ? { mode: graphMode }
          : {
              mode: graphMode,
              reached: importGraphVerdict.reached,
              reason: importGraphVerdict.reason,
              via: importGraphVerdict.via || null,
            },
    });
  }
  return {
    ok: true,
    verdicts,
    registryStats: {
      frontend: {
        ok: frontendLoad.ok,
        routeCount: (frontendLoad.routes || []).length,
        errors: frontendLoad.errors || [],
      },
      backend: { ok: backendLoad.ok, routeCount: (backendLoad.routes || []).length, errors: backendLoad.errors || [] },
    },
    importGraphStats: graph.stats,
    importGraphMode: graphMode,
  };
}

// ---------- custom-mode ----------

function customVerdicts(projectRoot, contract, surfaces) {
  const result = customLoader.invoke(projectRoot, contract, surfaces);
  if (!result.ok) {
    return {
      ok: false,
      verdicts: [],
      errors: [result.reason],
    };
  }
  const decorated = result.verdicts.map((v) => {
    const surface = surfaces.find((s) => s.surfaceId === v.surfaceId);
    return {
      surfaceId: v.surfaceId,
      category: surface?.category,
      reached: v.reached,
      via: v.via,
      reason: v.reason,
      ownerFR: surface?.ownerFR || [],
    };
  });
  // Surfaces the custom walker forgot to answer — count as unreached.
  for (const surface of surfaces) {
    if (!decorated.find((d) => d.surfaceId === surface.surfaceId)) {
      decorated.push({
        surfaceId: surface.surfaceId,
        category: surface.category,
        reached: false,
        via: [],
        reason: 'custom walker returned no verdict for this surface',
        ownerFR: surface.ownerFR,
      });
    }
  }
  return { ok: true, verdicts: decorated };
}

// ---------- evaluate ----------

function evaluate({ projectRoot, milestone, strict }) {
  const resolvedRoot = path.resolve(projectRoot || process.cwd());
  const { stack, surfaces, map, planningDir } = loadContracts(resolvedRoot);
  const errors = [];
  const findings = [];

  if (!stack) {
    errors.push({
      id: 'stack-contract-missing',
      severity: 'critical',
      message: `selected-stack-contract.json not found under ${path.relative(resolvedRoot, planningDir)}`,
      remediation:
        'Run /cobolt-plan (or resume) so milestone-architect emits selected-stack-contract.json per Phase 4.9.',
    });
  }
  if (!surfaces) {
    errors.push({
      id: 'app-surface-contract-missing',
      severity: 'critical',
      message: 'app-surface-contract.json not found — cannot determine which surfaces must reach.',
      remediation: 'Run /cobolt-plan Phase 6 so milestone-architect emits app-surface-contract.json.',
    });
  }
  if (milestone && !map) {
    findings.push(
      `milestone-surface-map.json not found; scoring the full app-surface contract against milestone "${milestone}".`,
    );
  }
  if (errors.length > 0) {
    return {
      generatedAt: new Date().toISOString(),
      generatedBy: 'cobolt-contract-reachability',
      projectRoot: resolvedRoot,
      milestone,
      passed: false,
      missingInfra: strict,
      mode: null,
      verdicts: [],
      errors,
      findings,
    };
  }

  const scopeSurfaces = milestone ? surfaceScopeForMilestone(surfaces, map, milestone) : allSurfaces(surfaces);
  findings.push(
    `surfaces in scope: ${scopeSurfaces.length}${milestone ? ` (milestone ${milestone})` : ' (all milestones)'}`,
  );

  // Census-safety: a milestone-surface-map entry with zero surfaces across all
  // six categories would otherwise silently produce an empty scopeSurfaces
  // list, and the reachability gate would report passed=true with no
  // verdicts. Fail closed instead.
  if (milestone && map && scopeSurfaces.length === 0 && allSurfaces(surfaces).length > 0) {
    return {
      generatedAt: new Date().toISOString(),
      generatedBy: 'cobolt-contract-reachability',
      projectRoot: resolvedRoot,
      milestone,
      passed: false,
      mode: stack.reachability?.mode || null,
      verdicts: [],
      errors: [
        {
          id: 'milestone-zero-scope-surfaces',
          severity: 'critical',
          message: `milestone-surface-map.json declares zero surfaces for ${milestone} across screens/apis/workers/jobs/events/commands while app-surface-contract has ${allSurfaces(surfaces).length} surface(s). A milestone that ships zero surfaces cannot legitimately pass reachability.`,
          remediation: `Populate milestones.${milestone} in milestone-surface-map.json with the surfaceIds this milestone delivers, OR document the milestone as non-shipping and exclude it from the build pipeline.`,
        },
      ],
      findings,
    };
  }

  const mode = stack.reachability?.mode || 'unknown';
  let dispatch;
  if (mode === 'reference') {
    const walkerName = stack.reachability?.walker;
    dispatch = {
      ok: false,
      verdicts: [],
      errors: [
        `reference mode walker "${walkerName}" not shipped in v0.42. CoBolt ships zero reference walkers so it does not silently bless a framework allowlist. Switch reachability.mode to "custom" (own the walker) or "generic" (declare routeRegistry.format from: ${walkers.listGenericAdapters().join(', ')}).`,
      ],
    };
  } else if (mode === 'custom') {
    dispatch = customVerdicts(resolvedRoot, stack, scopeSurfaces);
  } else if (mode === 'generic') {
    dispatch = genericVerdicts(resolvedRoot, stack, scopeSurfaces);
  } else {
    dispatch = {
      ok: false,
      verdicts: [],
      errors: [`reachability.mode is "${mode}" — must be one of reference | custom | generic.`],
    };
  }

  if (dispatch.missingDep) {
    return {
      generatedAt: new Date().toISOString(),
      generatedBy: 'cobolt-contract-reachability',
      projectRoot: resolvedRoot,
      milestone,
      passed: false,
      missingDep: dispatch.missingDep,
      mode,
      verdicts: [],
      errors: [
        {
          id: 'reachability-missing-dep',
          severity: 'high',
          message: `dependency required by generic adapter is not installed: ${dispatch.missingDep}`,
          remediation: `install ${dispatch.missingDep} or switch the route registry format to one that does not require it.`,
          details: dispatch.errors,
        },
      ],
      findings,
    };
  }

  if (!dispatch.ok) {
    return {
      generatedAt: new Date().toISOString(),
      generatedBy: 'cobolt-contract-reachability',
      projectRoot: resolvedRoot,
      milestone,
      passed: false,
      mode,
      verdicts: [],
      errors: dispatch.errors.map((msg, idx) => ({
        id: `reachability-dispatch-error-${idx + 1}`,
        severity: 'critical',
        message: msg,
        remediation: 'See reachability.mode docs above; this tool does not substitute defaults.',
      })),
      findings,
      registryStats: dispatch.registryStats,
    };
  }

  const unreached = dispatch.verdicts.filter((v) => !v.reached);
  const passed = unreached.length === 0;

  return {
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-contract-reachability',
    projectRoot: resolvedRoot,
    milestone,
    passed,
    mode,
    verdicts: dispatch.verdicts,
    errors: unreached.map((v) => ({
      id: `unreached-${v.surfaceId}`,
      severity: 'critical',
      message: `Surface "${v.surfaceId}" (${v.category}) unreached: ${v.reason || 'unspecified'}`,
      remediation:
        'Ensure the declared componentPath/handlerPath/producerPath exists on disk AND is reachable from the shipping entrypoint (route registry match for screens/apis; path existence for workers/jobs/events/commands).',
    })),
    findings,
    registryStats: dispatch.registryStats,
  };
}

// ---------- write reports ----------

function writeReports(result, args) {
  const latestDir = path.join(result.projectRoot, '_cobolt-output', 'latest');
  const reportPath = path.join(latestDir, 'quality', 'contract-reachability.json');
  writeJson(reportPath, result);
  const reports = [reportPath];
  if (args.milestone) {
    const milestonePath = path.join(latestDir, 'build', args.milestone, `${args.milestone}-contract-reachability.json`);
    writeJson(milestonePath, result);
    reports.push(milestonePath);
  }
  return reports;
}

// ---------- entrypoint ----------

function run(args = parseArgs()) {
  // Master and per-gate bypass.
  const v12 = String(process.env.COBOLT_V12_GATES || '').toLowerCase();
  if (v12 === 'bypass' || v12 === 'off') {
    logDecision(args.root || process.cwd(), {
      gate: 'cobolt-contract-reachability',
      decision: 'bypass',
      env: 'COBOLT_V12_GATES',
    });
    return {
      ok: true,
      bypassed: 'COBOLT_V12_GATES',
      reason: 'master-bypass',
      passed: true,
      verdicts: [],
      errors: [],
      findings: ['master bypass active — reachability gate skipped'],
    };
  }
  if (process.env.COBOLT_CONTRACT_REACHABILITY_GATE === '0') {
    logDecision(args.root || process.cwd(), {
      gate: 'cobolt-contract-reachability',
      decision: 'bypass',
      env: 'COBOLT_CONTRACT_REACHABILITY_GATE',
    });
    return {
      ok: true,
      bypassed: 'COBOLT_CONTRACT_REACHABILITY_GATE',
      reason: 'per-gate-bypass',
      passed: true,
      verdicts: [],
      errors: [],
      findings: ['per-gate bypass active — reachability gate skipped'],
    };
  }
  if (args.command === 'help') {
    return {
      ok: true,
      usage:
        'node tools/cobolt-contract-reachability.js check [--root <project>] [--milestone M1] [--strict] [--json] [--no-write]',
    };
  }
  if (args.command !== 'check') {
    return { ok: false, reason: 'unknown-command', command: args.command };
  }
  const result = evaluate({ projectRoot: args.root, milestone: args.milestone, strict: args.strict });
  const reportPaths = args.write ? writeReports(result, args) : [];
  const ok = result.passed === true;
  return {
    ok,
    reason: ok ? 'all-surfaces-reached' : result.missingDep ? 'reachability-missing-dep' : 'reachability-failed',
    reportPaths,
    ...result,
  };
}

if (require.main === module) {
  const args = parseArgs();
  const result = run(args);
  if (args.json || result.usage) console.log(JSON.stringify(result, null, 2));
  else if (!result.ok) console.error(`${result.reason}: ${(result.errors || []).map((e) => e.id || e).join(', ')}`);
  let exit = 0;
  if (!result.ok) {
    if (result.missingDep) exit = 2;
    else if (result.missingInfra) exit = 3;
    else exit = 1;
  }
  process.exit(exit);
}

module.exports = {
  allSurfaces,
  customVerdicts,
  evaluate,
  genericVerdicts,
  loadContracts,
  loadRegistryAdapter,
  normalizeRoute,
  parseArgs,
  routeMatches,
  run,
  surfaceScopeForMilestone,
};
