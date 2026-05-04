#!/usr/bin/env node

// CoBolt Route Wiring Check - deterministic domain liveness verifier

const fs = require('node:fs');
const path = require('node:path');
const { buildProvenance } = require('./_brownfield-provenance');

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.go', '.py', '.rb', '.java', '.rs', '.ex', '.exs']);
const IGNORED_DIRS = new Set(['.git', 'node_modules', '_cobolt-output', 'dist', 'build', 'coverage']);

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
  return fs.readFileSync(filePath, 'utf8');
}

function discoverDomainDirs(projectDir) {
  const candidates = ['backend/internal/domain', 'internal/domain', 'src/domains', 'domains', 'modules'];
  const domains = [];

  for (const candidate of candidates) {
    const fullPath = path.join(projectDir, candidate);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) continue;
    for (const entry of fs.readdirSync(fullPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      domains.push({
        name: entry.name,
        dir: path.join(fullPath, entry.name),
      });
    }
  }

  return domains;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findSignals(projectDir, domain, allFiles) {
  const routePatterns = [new RegExp(`/${escapeRegex(domain.name)}s?\\b`, 'i')];
  const importPattern = new RegExp(`(?:internal/domain|domains|modules)[/\\\\]${escapeRegex(domain.name)}\\b`, 'i');
  const namePattern = new RegExp(`\\b${escapeRegex(domain.name)}\\b`, 'i');
  const signals = { imports: [], routes: [], wiring: [] };

  for (const filePath of allFiles) {
    if (filePath.startsWith(domain.dir)) continue;
    const relativePath = path.relative(projectDir, filePath);
    const text = readText(filePath);

    if (importPattern.test(text)) {
      signals.imports.push(relativePath);
    }
    if (routePatterns.some((pattern) => pattern.test(text))) {
      signals.routes.push(relativePath);
    }
    if (/(main|router|server|app|index)\./i.test(path.basename(filePath)) && namePattern.test(text)) {
      signals.wiring.push(relativePath);
    }
  }

  return signals;
}

function scan(projectDir) {
  const allFiles = walkFiles(projectDir, isSourceFile);
  const domains = discoverDomainDirs(projectDir).map((domain) => {
    const signals = findSignals(projectDir, domain, allFiles);
    const externalReferences = new Set([...signals.imports, ...signals.routes, ...signals.wiring]);
    const status =
      externalReferences.size === 0
        ? 'unwired'
        : signals.routes.length > 0 || signals.wiring.length > 0
          ? 'live'
          : 'partial';

    return {
      name: domain.name,
      path: path.relative(projectDir, domain.dir),
      status,
      signalCounts: {
        imports: signals.imports.length,
        routes: signals.routes.length,
        wiring: signals.wiring.length,
        externalReferences: externalReferences.size,
      },
      signals,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-route-wiring-check',
    projectDir: path.resolve(projectDir),
    ...buildProvenance(projectDir, allFiles),
    summary: {
      domains: domains.length,
      live: domains.filter((domain) => domain.status === 'live').length,
      partial: domains.filter((domain) => domain.status === 'partial').length,
      unwired: domains.filter((domain) => domain.status === 'unwired').length,
    },
    domains,
  };
}

function writeReport(filePath, report) {
  const resolvedPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return resolvedPath;
}

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

  if (command !== 'scan') {
    console.log('Usage: node tools/cobolt-route-wiring-check.js scan [project-path] [--json] [--output <path>]');
    process.exit(command ? 2 : 0);
  }

  const report = scan(projectDir);
  const targetPath =
    outputPath || path.join(projectDir, '_cobolt-output', 'latest', 'brownfield', 'domain-liveness.json');
  writeReport(targetPath, report);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[cobolt-route-wiring-check] ${report.summary.domains} domains scanned`);
    console.log(`  Live: ${report.summary.live}`);
    console.log(`  Partial: ${report.summary.partial}`);
    console.log(`  Unwired: ${report.summary.unwired}`);
    console.log(`  Written: ${targetPath}`);
  }

  process.exit(report.summary.unwired === 0 ? 0 : 1);
}

module.exports = { discoverDomainDirs, scan, writeReport };
