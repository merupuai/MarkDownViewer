#!/usr/bin/env node

// CoBolt Fix Router - Deterministic finding-to-agent routing.

const fs = require('node:fs');
const path = require('node:path');

const PREFIX_AGENT_MAP = {
  AISEC: 'cobolt-backend-fix',
  AUTHZ: 'cobolt-backend-fix',
  SEC: 'cobolt-backend-fix',
  PEN: 'cobolt-backend-fix',
  SIL: 'cobolt-backend-fix',
  API: 'cobolt-backend-fix',
  APIWIRE: 'cobolt-backend-fix',
  ARCH: 'cobolt-backend-fix',
  CONTRACT: 'cobolt-backend-fix',
  CONF: 'cobolt-backend-fix',
  INT: 'cobolt-backend-fix',
  OPS: 'cobolt-backend-fix',
  DEP: 'cobolt-backend-fix',
  WIRE: 'cobolt-backend-fix',
  ROUTE: 'cobolt-backend-fix',
  QRY: 'cobolt-backend-fix',
  LIFECYCLE: 'cobolt-backend-fix',
  A11Y: 'cobolt-frontend-fix',
  UI: 'cobolt-frontend-fix',
  UIPH: 'cobolt-frontend-fix',
  DT: 'cobolt-frontend-fix',
  UX: 'cobolt-frontend-fix',
  I18N: 'cobolt-frontend-fix',
  COMP: 'cobolt-compliance-fix',
  DB: 'cobolt-db-fix',
  COV: 'fix-lead',
  GAP: 'fix-lead',
  TEST: 'fix-lead',
  UAT: '__by_extension__',
  FEAT: '__deferred__',
  ENH: '__deferred__',
  CODE: '__by_extension__',
  DEBT: '__by_extension__',
  PERF: '__by_extension__',
  SCAN: '__by_extension__',
  STUB: '__by_extension__',
  ILL: '__by_extension__',
};

const BACKEND_EXTENSIONS = new Set([
  '.go',
  '.py',
  '.rb',
  '.java',
  '.kt',
  '.kts',
  '.cs',
  '.ex',
  '.exs',
  '.rs',
  '.php',
  '.scala',
  '.clj',
  '.hs',
]);
const FRONTEND_EXTENSIONS = new Set([
  '.tsx',
  '.jsx',
  '.vue',
  '.svelte',
  '.heex',
  '.html',
  '.css',
  '.scss',
  '.less',
  '.astro',
  '.hbs',
  '.ejs',
  '.pug',
]);
const SHARED_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs']);

const ACTIONABLE_STATUSES = new Set([
  'open',
  'assigned',
  'fix-applied',
  'fix-applied-unverified',
  'fix-applied-failing',
  'fix-applied-no-test',
  'stalled',
]);

const GENERIC_PATH_SEGMENTS = new Set([
  'src',
  'app',
  'lib',
  'web',
  'api',
  'server',
  'client',
  'frontend',
  'backend',
  'controllers',
  'controller',
  'services',
  'service',
  'components',
  'component',
  'pages',
  'views',
  'view',
  'ui',
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'internal',
  'pkg',
]);

function extractPrefix(id) {
  const match = String(id || '').match(/^([A-Z]+)-?\d/u);
  return match ? match[1] : 'CODE';
}

function extractFindingPrefix(finding) {
  if (finding && typeof finding.prefix === 'string' && finding.prefix.trim()) {
    return finding.prefix.trim().toUpperCase();
  }
  return extractPrefix(finding?.id || '');
}

function resolveFindingFile(finding) {
  if (typeof finding?.file === 'string' && finding.file) return finding.file;
  if (finding?.location && typeof finding.location.file === 'string') return finding.location.file;
  return '';
}

function normalizeClusterKey(value) {
  if (!value) return null;
  const normalized = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-');
  return normalized || null;
}

function inferSubsystemFromFile(filePath) {
  if (!filePath) return null;

  const normalized = String(filePath).replace(/\\/g, '/').toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const directorySegments = segments.slice(0, -1);
  for (let i = directorySegments.length - 1; i >= 0; i--) {
    const segment = normalizeClusterKey(directorySegments[i]);
    if (segment && !GENERIC_PATH_SEGMENTS.has(segment)) {
      return segment;
    }
  }

  const fileBase = normalizeClusterKey(path.basename(normalized, path.extname(normalized)));
  return fileBase || null;
}

function resolveBundleCluster(finding) {
  const file = resolveFindingFile(finding);
  return (
    normalizeClusterKey(finding?.subsystem) ||
    inferSubsystemFromFile(file) ||
    normalizeClusterKey(String(finding?.rootCause || '').split(/[.():;,]/u)[0]) ||
    normalizeClusterKey(extractFindingPrefix(finding)) ||
    'general'
  );
}

function resolveByExtension(ext, filePath) {
  if (BACKEND_EXTENSIONS.has(ext)) return 'cobolt-backend-fix';
  if (FRONTEND_EXTENSIONS.has(ext)) return 'cobolt-frontend-fix';

  if (SHARED_EXTENSIONS.has(ext)) {
    const lower = String(filePath || '')
      .toLowerCase()
      .replace(/\\/g, '/');

    if (/\/(src\/app|pages|components|views|ui|frontend|client|web)\//u.test(lower)) {
      return 'cobolt-frontend-fix';
    }
    if (/\/(api|server|backend|handlers|controllers|services|middleware|lib)\//u.test(lower)) {
      return 'cobolt-backend-fix';
    }
    return 'fix-lead';
  }

  return 'fix-lead';
}

function appendJsonl(filePath, entry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function routeFinding(finding, iteration, failedAgents) {
  const prefix = extractFindingPrefix(finding);
  const file = resolveFindingFile(finding);
  const ext = typeof file === 'string' ? path.extname(file).toLowerCase() : '';

  if ((finding.status || '').toLowerCase() === 'stalled') {
    return {
      agent: 'fix-lead',
      action: 'escalated',
      reason: 'Finding already marked stalled; route directly to fix-lead',
      originalAgent: finding.assignedAgent || null,
    };
  }

  if (prefix === 'FEAT' || prefix === 'ENH') {
    return { agent: null, action: 'deferred', reason: `${prefix} findings are deferred to future work` };
  }

  let agent = PREFIX_AGENT_MAP[prefix];
  if (!agent) {
    return {
      agent: 'fix-lead',
      action: 'escalated',
      reason: `Unmapped finding prefix ${prefix}; route to fix-lead for explicit ownership decision`,
      unmappedPrefix: prefix,
      originalAgent: finding.assignedAgent || null,
    };
  }
  if (agent === '__by_extension__') {
    agent = resolveByExtension(ext, file);
  }

  if (iteration >= 5) {
    return {
      agent: 'fix-lead',
      action: 'escalated',
      reason: `Iteration ${iteration} routes all remaining actionable findings to fix-lead`,
      originalAgent: agent === 'fix-lead' ? finding.assignedAgent || null : agent,
    };
  }

  if (iteration >= 3 && failedAgents.has(agent)) {
    const originalAgent = agent;
    return {
      agent: 'fix-lead',
      action: 'escalated',
      reason: `Escalated from ${originalAgent} (failed in iterations 1-${iteration - 1})`,
      originalAgent,
    };
  }

  return { agent, action: 'routed', reason: `Prefix ${prefix}, extension ${ext || 'N/A'}` };
}

function buildBundles(findings, iteration, failedAgents) {
  const bundles = {};
  const deferred = [];
  const routing = [];

  for (const finding of findings) {
    const route = routeFinding(finding, iteration, failedAgents);
    const cluster = route.agent ? resolveBundleCluster(finding) : null;
    routing.push({ id: finding.id, cluster, ...route });

    if (route.action === 'deferred') {
      deferred.push(finding.id);
      continue;
    }

    const bundleKey = `${route.agent}::${cluster}`;
    if (!bundles[bundleKey]) {
      bundles[bundleKey] = {
        agent: route.agent,
        cluster,
        bundleId: `${route.agent}:${cluster}`,
        findings: [],
        count: 0,
        contextFiles: new Set(),
        prefixes: new Set(),
        rootCauses: new Set(),
      };
    }
    bundles[bundleKey].findings.push(finding);
    bundles[bundleKey].count += 1;
    const file = resolveFindingFile(finding);
    if (file) {
      bundles[bundleKey].contextFiles.add(file);
    }
    bundles[bundleKey].prefixes.add(extractFindingPrefix(finding));
    if (finding?.rootCause) {
      bundles[bundleKey].rootCauses.add(finding.rootCause);
    }
  }

  const normalizedBundles = Object.values(bundles).map((bundle) => ({
    ...bundle,
    contextFiles: [...bundle.contextFiles],
    prefixes: [...bundle.prefixes],
    rootCauses: [...bundle.rootCauses],
  }));

  return {
    bundles: normalizedBundles,
    deferred,
    routing,
    summary: {
      total: findings.length,
      routed: findings.length - deferred.length,
      deferred: deferred.length,
      agentCount: new Set(normalizedBundles.map((bundle) => bundle.agent)).size,
      bundleCount: normalizedBundles.length,
      byAgent: normalizedBundles.reduce((acc, bundle) => {
        acc[bundle.agent] = (acc[bundle.agent] || 0) + bundle.count;
        return acc;
      }, {}),
      byCluster: Object.fromEntries(normalizedBundles.map((bundle) => [bundle.bundleId, bundle.count])),
    },
  };
}

function cmdRoute(args) {
  const trackerIdx = args.indexOf('--tracker');
  const trackerPath = trackerIdx !== -1 && args[trackerIdx + 1] ? args[trackerIdx + 1] : null;
  const iterIdx = args.indexOf('--iteration');
  const iteration = iterIdx !== -1 && args[iterIdx + 1] ? Number.parseInt(args[iterIdx + 1], 10) : 1;
  const failedIdx = args.indexOf('--failed-agents');
  const failedAgents = new Set(failedIdx !== -1 && args[failedIdx + 1] ? args[failedIdx + 1].split(',') : []);
  const jsonMode = args.includes('--json');

  if (!trackerPath) {
    console.error('Usage: node tools/cobolt-fix-router.js route --tracker <path>');
    process.exit(2);
  }

  if (!fs.existsSync(trackerPath)) {
    console.error(`[cobolt-fix-router] Tracker not found: ${trackerPath}`);
    process.exit(1);
  }

  const tracker = JSON.parse(fs.readFileSync(trackerPath, 'utf8'));
  const findings = (tracker.findings || []).filter((finding) => ACTIONABLE_STATUSES.has(finding.status));

  if (findings.length === 0) {
    const result = {
      bundles: [],
      deferred: [],
      routing: [],
      summary: {
        total: 0,
        routed: 0,
        deferred: 0,
        agentCount: 0,
        bundleCount: 0,
        byAgent: {},
        byCluster: {},
      },
      iteration,
      timestamp: new Date().toISOString(),
      generatedBy: 'cobolt-fix-router',
      status: 'no-open-findings',
    };
    const outPath = path.join(path.dirname(trackerPath), `fix-routing-iter-${iteration}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('[cobolt-fix-router] No open findings to route.');
    }
    process.exit(0);
  }

  const result = buildBundles(findings, iteration, failedAgents);
  result.iteration = iteration;
  result.timestamp = new Date().toISOString();
  result.generatedBy = 'cobolt-fix-router';
  const unmappedRoutes = result.routing.filter((entry) => entry.unmappedPrefix);
  for (const route of unmappedRoutes) {
    appendJsonl(path.join(process.cwd(), '_cobolt-output', 'audit', 'unmapped-finding-prefix.jsonl'), {
      timestamp: result.timestamp,
      iteration,
      findingId: route.id,
      prefix: route.unmappedPrefix,
      routedTo: route.agent,
      reason: route.reason,
    });
  }

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[cobolt-fix-router] Routing ${result.summary.total} findings (iteration ${iteration})`);
    console.log(`  Routed: ${result.summary.routed} | Deferred: ${result.summary.deferred}`);
    console.log(`  Agents: ${result.summary.agentCount} | Bundles: ${result.summary.bundleCount}`);
    for (const bundle of result.bundles) {
      console.log(`    ${bundle.agent} [${bundle.cluster}]: ${bundle.count} findings`);
    }
    if (result.deferred.length > 0) {
      console.log(`  Deferred: ${result.deferred.join(', ')}`);
    }
  }

  const outPath = path.join(path.dirname(trackerPath), `fix-routing-iter-${iteration}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.exit(0);
}

if (require.main === module) {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case 'route':
      cmdRoute(args);
      break;
    default:
      console.log('CoBolt Fix Router - Deterministic finding-to-agent routing');
      console.log('');
      console.log('Usage:');
      console.log(
        '  node tools/cobolt-fix-router.js route --tracker <path> [--iteration N] [--failed-agents a,b] [--json]',
      );
      console.log('');
      console.log(
        'Routes findings by: prefix -> agent, extension -> backend/frontend, unmapped prefix -> fix-lead escalation.',
      );
      process.exit(command ? 2 : 0);
  }
}

module.exports = {
  routeFinding,
  buildBundles,
  extractPrefix,
  extractFindingPrefix,
  resolveFindingFile,
  resolveBundleCluster,
  inferSubsystemFromFile,
  ACTIONABLE_STATUSES,
};
