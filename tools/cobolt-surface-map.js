#!/usr/bin/env node

// cobolt-surface-map — read-only accessor for the Phase-5 plan-stage surface
// contracts (`app-surface-contract.json` and `milestone-surface-map.json`).
//
// These two JSON files are emitted by cobolt-plan Phase 5/7 (milestone-architect)
// and write-gated at plan-close by the existing app-surface-contract-gate and
// milestone-surface-map-gate hooks. This tool gives downstream build-stage
// consumers (cobolt-build-setup-step, cobolt-build-deep-verification-step,
// cobolt-frontend-write-gate) a single trusted reader so they don't reimplement
// JSON loading and FR-binding flattening five different ways.
//
// Programmatic API (single source of truth):
//   loadSurfaceMap({cwd})              -> { contract, milestones, paths, present }
//   getSurfacesForMilestone({cwd, M})  -> [{ slug, category, frIds, item }]
//   getSurfaceById({cwd, surfaceId})   -> { category, item } or null
//
// CLI:
//   node tools/cobolt-surface-map.js list [--milestone M1] [--json]
//   node tools/cobolt-surface-map.js show <surfaceId> [--json]
//   node tools/cobolt-surface-map.js status [--json]
//
// Exit codes (per tools/CLAUDE.md):
//   0  success (including a clean "no surface map present, returning empty")
//   1  hard error — bad input, parse failure, unhandled exception
//
// Missing-file fallback returns empty results so pre-v0.59.0 projects don't
// crash. Missing surface contract is NOT exit 1 — it's a structural property
// of legacy plans, not a tool bug.

const fs = require('node:fs');
const path = require('node:path');

const CONTRACT_REL_PATH = path.join('_cobolt-output', 'latest', 'planning', 'app-surface-contract.json');
const MILESTONE_MAP_REL_PATH = path.join('_cobolt-output', 'latest', 'planning', 'milestone-surface-map.json');

const CATEGORY_KEYS = ['screens', 'apis', 'workers', 'jobs', 'events', 'commands'];
const SURFACE_ID_FIELD_BY_CATEGORY = {
  screens: 'screenId',
  apis: 'apiId',
  workers: 'workerId',
  jobs: 'jobId',
  events: 'eventId',
  commands: 'commandId',
};

function readJsonSafe(absPath) {
  try {
    const txt = fs.readFileSync(absPath, 'utf8');
    return JSON.parse(txt);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    if (err instanceof SyntaxError) {
      const e = new Error(`Failed to parse ${absPath}: ${err.message}`);
      e.code = 'EPARSE';
      throw e;
    }
    throw err;
  }
}

function loadSurfaceMap({ cwd } = {}) {
  const base = cwd || process.cwd();
  const contractPath = path.join(base, CONTRACT_REL_PATH);
  const milestoneMapPath = path.join(base, MILESTONE_MAP_REL_PATH);
  const contract = readJsonSafe(contractPath);
  const milestoneMap = readJsonSafe(milestoneMapPath);
  const present = Boolean(contract) && Boolean(milestoneMap);
  return {
    present,
    contract,
    milestones: milestoneMap?.milestones ? milestoneMap.milestones : {},
    paths: { contract: contractPath, milestoneMap: milestoneMapPath },
  };
}

function indexContractSurfaces(contract) {
  const byId = new Map();
  if (!contract) return byId;
  for (const category of CATEGORY_KEYS) {
    const arr = Array.isArray(contract[category]) ? contract[category] : [];
    const idField = SURFACE_ID_FIELD_BY_CATEGORY[category];
    for (const item of arr) {
      const id = item?.[idField];
      if (typeof id === 'string' && id.length > 0) {
        byId.set(id, { category, item });
      }
    }
  }
  return byId;
}

function getSurfacesForMilestone({ cwd, milestone } = {}) {
  if (!milestone || typeof milestone !== 'string') {
    return { surfaces: [], present: false, milestoneFound: false };
  }
  const map = loadSurfaceMap({ cwd });
  if (!map.present) {
    return { surfaces: [], present: false, milestoneFound: false };
  }
  const entry = map.milestones[milestone];
  if (!entry) {
    return { surfaces: [], present: true, milestoneFound: false };
  }
  const byId = indexContractSurfaces(map.contract);
  const frBindings = entry.frBindings || {};
  // Build reverse index: surfaceId -> [frIds]
  const frsBySurface = new Map();
  for (const [fr, surfaceIds] of Object.entries(frBindings)) {
    if (!Array.isArray(surfaceIds)) continue;
    for (const sid of surfaceIds) {
      if (!frsBySurface.has(sid)) frsBySurface.set(sid, []);
      frsBySurface.get(sid).push(fr);
    }
  }
  const surfaces = [];
  for (const category of CATEGORY_KEYS) {
    const ids = Array.isArray(entry[category]) ? entry[category] : [];
    for (const slug of ids) {
      const fromContract = byId.get(slug) || null;
      surfaces.push({
        slug,
        category,
        frIds: frsBySurface.get(slug) || [],
        item: fromContract ? fromContract.item : null,
      });
    }
  }
  return {
    surfaces,
    present: true,
    milestoneFound: true,
    dependsOnMilestones: Array.isArray(entry.dependsOnMilestones) ? entry.dependsOnMilestones.slice() : [],
  };
}

function getSurfaceById({ cwd, surfaceId } = {}) {
  if (!surfaceId || typeof surfaceId !== 'string') return null;
  const map = loadSurfaceMap({ cwd });
  if (!map.present) return null;
  const byId = indexContractSurfaces(map.contract);
  return byId.get(surfaceId) || null;
}

function listAllMilestones({ cwd } = {}) {
  const map = loadSurfaceMap({ cwd });
  return Object.keys(map.milestones).sort();
}

module.exports = {
  loadSurfaceMap,
  getSurfacesForMilestone,
  getSurfaceById,
  listAllMilestones,
  CONTRACT_REL_PATH,
  MILESTONE_MAP_REL_PATH,
  CATEGORY_KEYS,
};

// ── CLI ──────────────────────────────────────────────────────

function parseFlags(argv) {
  const flags = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--milestone' && argv[i + 1]) {
      flags.milestone = argv[i + 1];
      i += 1;
    }
  }
  return flags;
}

function printUsageAndExit(code) {
  console.log('Usage: node tools/cobolt-surface-map.js <command> [args]');
  console.log('Commands:');
  console.log('  list [--milestone M1] [--json]   List surfaces for one or all milestones');
  console.log('  show <surfaceId> [--json]        Show one surface from app-surface-contract');
  console.log('  status [--json]                  Report whether contracts are present on disk');
  process.exit(code);
}

function cliList(flags) {
  if (flags.milestone) {
    const result = getSurfacesForMilestone({ milestone: flags.milestone });
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    if (!result.present) {
      console.log('No surface map present (pre-v0.59.0 plan or missing artifacts).');
      return 0;
    }
    if (!result.milestoneFound) {
      console.log(`Milestone ${flags.milestone} not declared in milestone-surface-map.json`);
      return 0;
    }
    console.log(`Milestone ${flags.milestone}: ${result.surfaces.length} surfaces`);
    for (const s of result.surfaces) {
      const frs = s.frIds.join(', ') || '(no FR bindings)';
      console.log(`  [${s.category}] ${s.slug} -> ${frs}`);
    }
    return 0;
  }
  const milestones = listAllMilestones();
  if (flags.json) {
    const out = {};
    for (const m of milestones) out[m] = getSurfacesForMilestone({ milestone: m });
    console.log(JSON.stringify({ milestones: out }, null, 2));
    return 0;
  }
  if (milestones.length === 0) {
    console.log('No surface map present (pre-v0.59.0 plan or missing artifacts).');
    return 0;
  }
  for (const m of milestones) {
    const r = getSurfacesForMilestone({ milestone: m });
    console.log(`${m}: ${r.surfaces.length} surfaces`);
  }
  return 0;
}

function cliShow(args, flags) {
  const surfaceId = args[1];
  if (!surfaceId) {
    console.error('Usage: show <surfaceId>');
    return 1;
  }
  const result = getSurfaceById({ surfaceId });
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (!result) {
    console.log(`Surface ${surfaceId} not found in app-surface-contract.json`);
    return 0;
  }
  console.log(`[${result.category}] ${surfaceId}`);
  console.log(JSON.stringify(result.item, null, 2));
  return 0;
}

function cliStatus(flags) {
  const map = loadSurfaceMap({});
  const status = {
    present: map.present,
    contractExists: Boolean(map.contract),
    milestoneMapExists: Boolean(map.milestones && Object.keys(map.milestones).length > 0),
    milestoneCount: Object.keys(map.milestones || {}).length,
    paths: map.paths,
  };
  if (flags.json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(`app-surface-contract.json:    ${status.contractExists ? 'present' : 'missing'}`);
    console.log(`milestone-surface-map.json:   ${status.milestoneMapExists ? 'present' : 'missing'}`);
    console.log(`Milestones declared:          ${status.milestoneCount}`);
  }
  return 0;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    printUsageAndExit(0);
  }
  const flags = parseFlags(argv);
  try {
    let code = 1;
    if (cmd === 'list') code = cliList(flags);
    else if (cmd === 'show') code = cliShow(argv, flags);
    else if (cmd === 'status') code = cliStatus(flags);
    else {
      console.error(`Unknown command: ${cmd}`);
      printUsageAndExit(1);
    }
    process.exit(code);
  } catch (err) {
    console.error(`[cobolt-surface-map] ${err.message}`);
    process.exit(1);
  }
}
