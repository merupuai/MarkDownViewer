#!/usr/bin/env node

// CoBolt Entrypoint Wiring Check — deterministic call-graph route registration verifier
// Verifies that route registration functions are CALLED from entry points, not just DEFINED.

const fs = require('node:fs');
const path = require('node:path');
const { buildProvenance } = require('./_brownfield-provenance');

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.go', '.py', '.rb', '.java', '.rs', '.ex', '.exs']);
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '_cobolt-output',
  'dist',
  'build',
  'coverage',
  '.next',
  '__pycache__',
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function walkFiles(rootDir, predicate, collected = []) {
  if (!fs.existsSync(rootDir)) return collected;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        walkFiles(fullPath, predicate, collected);
      }
      continue;
    }
    if (predicate(fullPath)) {
      collected.push(fullPath);
    }
  }
  return collected;
}

function isSourceFile(filePath) {
  return SOURCE_EXTENSIONS.has(path.extname(filePath));
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Framework Detection ──────────────────────────────────────────────────────

/**
 * Detect which frameworks are present in the project.
 * @param {string} projectDir
 * @returns {string[]} Array of framework identifiers
 */
function detectFramework(projectDir) {
  const frameworks = [];

  // Go (chi, gorilla, gin, stdlib)
  if (fs.existsSync(path.join(projectDir, 'go.mod'))) {
    frameworks.push('go');
  }

  // Node.js frameworks
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readText(pkgPath));
      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

      if (allDeps.next) {
        frameworks.push('nextjs');
      }
      if (allDeps.express) {
        frameworks.push('express');
      }
      if (allDeps.fastify) {
        frameworks.push('fastify');
      }
    } catch {
      // Malformed package.json — skip
    }
  }

  // Phoenix (Elixir)
  if (fs.existsSync(path.join(projectDir, 'mix.exs'))) {
    const mixContent = readText(path.join(projectDir, 'mix.exs'));
    if (/phoenix/.test(mixContent)) {
      frameworks.push('phoenix');
    }
  }

  // Django (Python)
  const managePy = path.join(projectDir, 'manage.py');
  const settingsCandidates = walkFiles(projectDir, (f) => f.endsWith('settings.py'));
  if (fs.existsSync(managePy) || settingsCandidates.length > 0) {
    const manageContent = fs.existsSync(managePy) ? readText(managePy) : '';
    if (/django/i.test(manageContent) || settingsCandidates.some((f) => /django/i.test(readText(f)))) {
      frameworks.push('django');
    }
  }

  return frameworks;
}

// ── Go Wiring Check ──────────────────────────────────────────────────────────

/**
 * Find Go route registration functions (func Register*Routes) and verify
 * they are called from entry-point files (main.go).
 */
function checkGoWiring(projectDir, allFiles) {
  const domains = [];
  const registerPattern = /func\s+(Register\w*Routes)\s*\(/g;

  // Find all registration functions
  for (const filePath of allFiles) {
    if (!filePath.endsWith('.go')) continue;
    const text = readText(filePath);
    let match;
    while ((match = registerPattern.exec(text)) !== null) {
      domains.push({
        name: deriveDomainName(projectDir, filePath),
        registrationFunction: match[1],
        definedIn: path.relative(projectDir, filePath),
        status: 'unwired',
        calledFrom: [],
        evidence: null,
      });
    }
  }

  if (domains.length === 0) return domains;

  // Find entry points (main.go files)
  const entryPoints = allFiles.filter((f) => f.endsWith('.go') && path.basename(f) === 'main.go');

  // Check each registration function is called from an entry point
  for (const domain of domains) {
    const callPattern = new RegExp(`\\b${escapeRegex(domain.registrationFunction)}\\s*\\(`, 'm');
    for (const entryFile of entryPoints) {
      const entryText = readText(entryFile);
      if (callPattern.test(entryText)) {
        domain.status = 'wired';
        domain.calledFrom.push(path.relative(projectDir, entryFile));
        domain.evidence = `${domain.registrationFunction}() called from entry point`;
      }
    }
  }

  return domains;
}

// ── Express/Fastify Wiring Check ─────────────────────────────────────────────

/**
 * Find route files in routes/ directory and verify they are require()'d
 * and .use()'d from app.js/server.js/index.js.
 */
function checkExpressWiring(projectDir, allFiles) {
  const domains = [];
  const routesDir = path.join(projectDir, 'routes');

  if (!fs.existsSync(routesDir)) return domains;

  // Discover route files
  const routeFiles = allFiles.filter((f) => f.startsWith(routesDir + path.sep) && /\.(js|ts)$/.test(f));

  for (const routeFile of routeFiles) {
    const baseName = path.basename(routeFile, path.extname(routeFile));
    const relPath = path.relative(projectDir, routeFile);

    domains.push({
      name: baseName,
      registrationFunction: `routes/${baseName}`,
      definedIn: relPath,
      status: 'unwired',
      calledFrom: [],
      evidence: null,
    });
  }

  if (domains.length === 0) return domains;

  // Find entry points (app.js, server.js, index.js at project root or src/)
  const entryPointNames = new Set(['app.js', 'server.js', 'index.js', 'app.ts', 'server.ts', 'index.ts']);
  const entryPoints = allFiles.filter((f) => {
    const rel = path.relative(projectDir, f);
    const parts = rel.split(path.sep);
    // Root-level or in src/
    return (
      (parts.length === 1 || (parts.length === 2 && parts[0] === 'src')) && entryPointNames.has(parts[parts.length - 1])
    );
  });

  for (const domain of domains) {
    // Build patterns to match require('./routes/xxx') and .use(
    const requirePattern = new RegExp(`require\\s*\\(\\s*['"][./]*routes/${escapeRegex(domain.name)}['"]\\s*\\)`);
    const usePattern = /\.use\s*\(/;

    for (const entryFile of entryPoints) {
      const entryText = readText(entryFile);
      if (requirePattern.test(entryText) && usePattern.test(entryText)) {
        domain.status = 'wired';
        domain.calledFrom.push(path.relative(projectDir, entryFile));
        domain.evidence = `routes/${domain.name} required and mounted via .use()`;
      }
    }
  }

  return domains;
}

// ── Next.js App Router Wiring Check ──────────────────────────────────────────

/**
 * Next.js App Router — auto-wired by convention. All page.tsx/route.ts files
 * in app/ directory are automatically wired.
 */
function checkNextjsAppWiring(projectDir, allFiles) {
  const domains = [];
  const appDir = path.join(projectDir, 'app');

  if (!fs.existsSync(appDir)) return domains;

  const appRouteFiles = allFiles.filter((f) => {
    if (!f.startsWith(appDir + path.sep)) return false;
    const basename = path.basename(f);
    return /^(page|route)\.(tsx?|jsx?)$/.test(basename);
  });

  for (const routeFile of appRouteFiles) {
    const relPath = path.relative(appDir, routeFile);
    const routeSegments = path
      .dirname(relPath)
      .split(path.sep)
      .filter((s) => s !== '.');
    const domainName = routeSegments.join('/') || 'root';

    domains.push({
      name: domainName,
      registrationFunction: `app/${relPath}`,
      definedIn: path.relative(projectDir, routeFile),
      status: 'wired', // Auto-wired by convention
      calledFrom: ['next.js-app-router'],
      evidence: 'Auto-wired by Next.js App Router convention',
    });
  }

  return domains;
}

// ── Phoenix Wiring Check ─────────────────────────────────────────────────────

/**
 * Find scope "/path" do blocks in router.ex and verify endpoint.ex
 * contains plug Router.
 */
function checkPhoenixWiring(projectDir, allFiles) {
  const domains = [];

  // Find router.ex files
  const routerFiles = allFiles.filter((f) => f.endsWith('.ex') && path.basename(f) === 'router.ex');

  const scopePattern = /scope\s+"\/(\w+)"\s+do/g;

  for (const routerFile of routerFiles) {
    const text = readText(routerFile);
    let match;
    while ((match = scopePattern.exec(text)) !== null) {
      domains.push({
        name: match[1],
        registrationFunction: `scope "/${match[1]}"`,
        definedIn: path.relative(projectDir, routerFile),
        status: 'unwired',
        calledFrom: [],
        evidence: null,
      });
    }
  }

  if (domains.length === 0) return domains;

  // Find endpoint.ex files and check for plug Router
  const endpointFiles = allFiles.filter((f) => f.endsWith('.ex') && path.basename(f) === 'endpoint.ex');

  const plugRouterPattern = /plug\s+\w*\.?Router/;

  for (const endpointFile of endpointFiles) {
    const text = readText(endpointFile);
    if (plugRouterPattern.test(text)) {
      for (const domain of domains) {
        domain.status = 'wired';
        domain.calledFrom.push(path.relative(projectDir, endpointFile));
        domain.evidence = 'plug Router found in endpoint.ex';
      }
    }
  }

  return domains;
}

// ── Django Wiring Check ──────────────────────────────────────────────────────

/**
 * Find urlpatterns in app urls.py and verify root urls.py contains
 * include('app.urls').
 */
function checkDjangoWiring(projectDir, allFiles) {
  const domains = [];

  // Find app-level urls.py files (not root)
  const urlsFiles = allFiles.filter((f) => f.endsWith('.py') && path.basename(f) === 'urls.py');

  const urlpatternsPattern = /urlpatterns\s*=\s*\[/;

  for (const urlsFile of urlsFiles) {
    const text = readText(urlsFile);
    if (!urlpatternsPattern.test(text)) continue;

    const relPath = path.relative(projectDir, urlsFile);
    const parts = relPath.split(path.sep);
    if (parts.length < 2) continue; // Root urls.py — skip

    const appName = parts[parts.length - 2];

    domains.push({
      name: appName,
      registrationFunction: `${appName}/urls.py urlpatterns`,
      definedIn: relPath,
      status: 'unwired',
      calledFrom: [],
      evidence: null,
    });
  }

  if (domains.length === 0) return domains;

  // Find root urls.py (shallowest one, or ones with include())
  const rootUrls = urlsFiles.filter((f) => {
    const text = readText(f);
    return /include\s*\(/.test(text);
  });

  for (const domain of domains) {
    const includePattern = new RegExp(`include\\s*\\(\\s*['"]${escapeRegex(domain.name)}\\.urls['"]`);

    for (const rootFile of rootUrls) {
      if (rootFile === path.join(projectDir, domain.definedIn)) continue; // Skip self
      const text = readText(rootFile);
      if (includePattern.test(text)) {
        domain.status = 'wired';
        domain.calledFrom.push(path.relative(projectDir, rootFile));
        domain.evidence = `include('${domain.name}.urls') found in root urlconf`;
      }
    }
  }

  return domains;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function deriveDomainName(projectDir, filePath) {
  const rel = path.relative(projectDir, filePath);
  const parts = rel.split(path.sep);
  // Look for common domain directory patterns
  const domainIdx = parts.findIndex((p) => p === 'domain' || p === 'domains' || p === 'modules');
  if (domainIdx >= 0 && domainIdx < parts.length - 1) {
    return parts[domainIdx + 1];
  }
  // Fallback: parent directory name
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
}

// ── Main Scan ────────────────────────────────────────────────────────────────

/**
 * Scan a project directory for route registrations and verify they are
 * called from entry points.
 * @param {string} projectDir
 * @returns {object} Scan result with summary and domains
 */
// v0.65.3 (audit S1-F): boundary frameworks the static walker does NOT yet
// support. When package.json/Cargo.toml/etc names one of these dependencies,
// emit a deterministicBoundary record so consumers see "we cannot verify this
// surface" honestly instead of seeing 0 entrypoints + exit 0.
const BOUNDARY_FRAMEWORK_DEPS = {
  // JS/TS
  '@nestjs/core': 'nestjs',
  '@nestjs/common': 'nestjs',
  hono: 'hono',
  koa: 'koa',
  '@cloudflare/workers-types': 'cloudflare-workers',
  'aws-lambda': 'aws-lambda',
  '@aws-sdk/client-lambda': 'aws-lambda',
  '@vercel/node': 'vercel-functions',
  // Schedulers
  'node-cron': 'cron-jobs',
  croner: 'cron-jobs',
  bullmq: 'bullmq-jobs',
  bee: 'bee-jobs',
  // CLI
  commander: 'commander-cli',
  yargs: 'yargs-cli',
  oclif: 'oclif-cli',
  // Java/Kotlin
  'spring-boot-starter-web': 'spring-boot',
  ktor: 'ktor',
  // Python (alongside django)
  fastapi: 'fastapi',
  flask: 'flask',
  starlette: 'starlette',
};

function detectBoundaryFrameworks(resolvedDir) {
  const found = new Set();
  // package.json deps + devDeps
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(resolvedDir, 'package.json'), 'utf8'));
    const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) };
    for (const dep of Object.keys(all)) {
      if (BOUNDARY_FRAMEWORK_DEPS[dep]) found.add(BOUNDARY_FRAMEWORK_DEPS[dep]);
    }
    if (pkg.bin) found.add('package-bin-cli');
  } catch {
    /* no package.json or unreadable */
  }
  // pyproject.toml / requirements.txt
  for (const f of ['pyproject.toml', 'requirements.txt']) {
    try {
      const t = fs.readFileSync(path.join(resolvedDir, f), 'utf8');
      if (/\bfastapi\b/i.test(t)) found.add('fastapi');
      if (/\bflask\b/i.test(t)) found.add('flask');
      if (/\bstarlette\b/i.test(t)) found.add('starlette');
      if (/\bcelery\b/i.test(t)) found.add('celery-jobs');
    } catch {
      /* ignore */
    }
  }
  // Cargo.toml
  try {
    const t = fs.readFileSync(path.join(resolvedDir, 'Cargo.toml'), 'utf8');
    if (/\baxum\b/i.test(t)) found.add('axum');
    if (/\bactix-web\b/i.test(t)) found.add('actix-web');
    if (/\brocket\b/i.test(t)) found.add('rocket');
  } catch {
    /* ignore */
  }
  return Array.from(found).sort();
}

function scan(projectDir) {
  const resolvedDir = path.resolve(projectDir);
  const allFiles = walkFiles(resolvedDir, isSourceFile);
  const frameworks = detectFramework(resolvedDir);
  const allDomains = [];

  if (frameworks.includes('go')) {
    allDomains.push(...checkGoWiring(resolvedDir, allFiles));
  }

  if (frameworks.includes('express') || frameworks.includes('fastify')) {
    allDomains.push(...checkExpressWiring(resolvedDir, allFiles));
  }

  if (frameworks.includes('nextjs')) {
    allDomains.push(...checkNextjsAppWiring(resolvedDir, allFiles));
  }

  if (frameworks.includes('phoenix')) {
    allDomains.push(...checkPhoenixWiring(resolvedDir, allFiles));
  }

  if (frameworks.includes('django')) {
    allDomains.push(...checkDjangoWiring(resolvedDir, allFiles));
  }

  const wired = allDomains.filter((d) => d.status === 'wired').length;
  const unwired = allDomains.filter((d) => d.status === 'unwired').length;

  // v0.65.3 — honesty record for surfaces beyond the walker's reach.
  const deterministicBoundary = detectBoundaryFrameworks(resolvedDir);
  const honestLimits = [];
  if (frameworks.length === 0 && deterministicBoundary.length === 0) {
    honestLimits.push({
      kind: 'no-framework-detected',
      detail:
        'No supported framework detected (Go, Express, Fastify, Next.js App Router, Phoenix, Django). ' +
        'Entry-point wiring not verifiable for this project — silent exit-0 is dishonest. ' +
        'Add a supported framework or extend cobolt-entrypoint-wiring-check.js.',
    });
  }
  if (deterministicBoundary.length > 0) {
    honestLimits.push({
      kind: 'deterministic-boundary',
      frameworks: deterministicBoundary,
      detail:
        'These frameworks are declared in dependency manifests but are NOT yet covered by the static wiring walker. ' +
        'Their entry points (HTTP routes, queue consumers, cron jobs, CLI commands, Lambda handlers) cannot be verified by this tool. ' +
        'Plan a v2 walker extension or treat these surfaces as out-of-scope for invariant #17.',
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-entrypoint-wiring-check',
    projectDir: resolvedDir,
    ...buildProvenance(resolvedDir, allFiles),
    frameworks,
    deterministicBoundary,
    honestLimits,
    summary: {
      total: allDomains.length,
      wired,
      unwired,
      boundaryFrameworks: deterministicBoundary.length,
    },
    domains: allDomains,
  };
}

// ── Report Writer ────────────────────────────────────────────────────────────

function writeReport(filePath, report) {
  const resolvedPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return resolvedPath;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  let projectDir = process.cwd();
  let outputPath = null;
  const jsonMode = args.includes('--json');

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) {
      outputPath = args[++i];
    } else if (!args[i].startsWith('--')) {
      projectDir = path.resolve(args[i]);
    }
  }

  // v0.65.3 (audit S3-D): explicit --help/-h branch per v0.40.2 exit-code contract.
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log('Usage: node tools/cobolt-entrypoint-wiring-check.js scan [project-path] [--json] [--output <path>]');
    console.log('');
    console.log('Census every API entrypoint (route registration) and verify it is wired from a binary entrypoint.');
    console.log('Tier 1 hard-gate when frameworks are recognized; deterministic-boundary record otherwise.');
    console.log('');
    console.log('Exit codes (per tools/CLAUDE.md contract):');
    console.log('  0  scan ran to completion (PASS)');
    console.log('  1  hard error (misuse, internal exception)');
    console.log('  2  unknown subcommand or missing optional dependency');
    console.log('  3  missing infrastructure');
    process.exit(0);
  }

  if (!command) {
    console.log('Usage: node tools/cobolt-entrypoint-wiring-check.js scan [project-path] [--json] [--output <path>]');
    process.exit(0);
  }

  if (command !== 'scan') {
    console.error(`Unknown subcommand: ${command}`);
    console.error('Usage: node tools/cobolt-entrypoint-wiring-check.js scan [project-path] [--json] [--output <path>]');
    process.exit(1);
  }

  // v0.65.3 — bypass-resolver wiring (GT-01). When the gate is bypassed via
  // signed ledger or legacy COBOLT_ENTRYPOINT_WIRING=off, exit 0 with a noted
  // bypass record. Cannot register in lib/cobolt-gate-registry without a hook;
  // this is a tool-side check that mirrors sibling cobolt-channel/queue/orm.
  if (process.env.COBOLT_ENTRYPOINT_WIRING === 'off' || process.env.COBOLT_V12_GATES === 'bypass') {
    if (jsonMode) {
      console.log(
        JSON.stringify({
          status: 'bypassed',
          reason:
            process.env.COBOLT_ENTRYPOINT_WIRING === 'off' ? 'COBOLT_ENTRYPOINT_WIRING=off' : 'COBOLT_V12_GATES=bypass',
          generatedBy: 'cobolt-entrypoint-wiring-check',
        }),
      );
    }
    process.exit(0);
  }

  const report = scan(projectDir);
  const targetPath = outputPath || path.join(projectDir, '_cobolt-output', 'latest', 'build', 'entrypoint-wiring.json');
  writeReport(targetPath, report);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[cobolt-entrypoint-wiring-check] ${report.summary.total} route registrations scanned`);
    console.log(`  Frameworks: ${report.frameworks.join(', ') || 'none detected'}`);
    console.log(`  Wired: ${report.summary.wired}`);
    console.log(`  Unwired: ${report.summary.unwired}`);
    console.log(`  Written: ${targetPath}`);
  }

  process.exit(report.summary.unwired === 0 ? 0 : 1);
}

module.exports = { scan, detectFramework };
