#!/usr/bin/env node

/**
 * cobolt-wireframe-diff.js — Deterministic wireframe-to-UI diff tool
 *
 * Compares component-registry.json declarations against actual UI code usage.
 * Detects: declared-but-unused components, used-but-undeclared components,
 * and page wiring gaps (pages referencing components they don't import).
 *
 * Usage:
 *   node tools/cobolt-wireframe-diff.js scan [--json] [--milestone M1]
 */

const fs = require('node:fs');
const path = require('node:path');
const { buildProvenance } = require('./_brownfield-provenance');

const UI_EXTENSIONS = new Set(['.tsx', '.jsx', '.js', '.html']);
const IGNORED_DIRS = new Set(['.git', 'node_modules', '_cobolt-output', 'dist', 'build', 'coverage', '.next', '.nuxt']);

function normalizeProjectPath(projectPath) {
  if (!projectPath) return '';
  const normalized = String(projectPath).trim().replace(/\\/g, '/');
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function findRegistryPath(projectDir) {
  const candidates = [
    path.join(projectDir, '_cobolt-output', 'latest', 'frontend', 'component-registry.json'),
    path.join(projectDir, '_cobolt-output', 'frontend', 'component-registry.json'),
  ];
  return candidates.find((f) => fs.existsSync(f)) || null;
}

function loadRegistry(registryPath) {
  try {
    return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch {
    return null;
  }
}

function extractDeclaredComponents(registry) {
  const declared = new Map();

  // shadcn installed components
  const shadcnComponents = registry.shadcn?.installed || [];
  for (const name of shadcnComponents) {
    declared.set(name.toLowerCase(), { name, source: 'shadcn', declaredIn: 'shadcn.installed' });
  }

  // Custom components
  const customs = registry.custom || [];
  for (const comp of customs) {
    const name = comp.name || path.basename(comp.path || '', path.extname(comp.path || ''));
    if (name) {
      declared.set(name.toLowerCase(), { name, source: 'custom', declaredIn: comp.path || 'custom' });
    }
  }

  return declared;
}

function extractPageDeclarations(registry) {
  const pages = [];
  for (const page of registry.pages || []) {
    if (page.file && page.components) {
      pages.push({
        route: page.route || 'unknown',
        file: page.file,
        declaredComponents: page.components || [],
      });
    }
  }
  return pages;
}

function walkSourceFiles(rootDir, collected = []) {
  if (!fs.existsSync(rootDir)) return collected;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        walkSourceFiles(fullPath, collected);
      }
      continue;
    }
    if (UI_EXTENSIONS.has(path.extname(fullPath))) {
      collected.push(fullPath);
    }
  }
  return collected;
}

function extractUsedComponents(filePath) {
  const used = new Set();
  try {
    const content = fs.readFileSync(filePath, 'utf8');

    // Match import statements: import { Button, Card } from '...'
    const importRegex = /import\s+\{([^}]+)\}\s+from\s+['"][^'"]+['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const names = match[1].split(',').map((n) =>
        n
          .trim()
          .split(/\s+as\s+/)[0]
          .trim(),
      );
      for (const name of names) {
        if (name && /^[A-Z]/.test(name)) {
          used.add(name.toLowerCase());
        }
      }
    }

    // Match default imports: import Button from '...'
    const defaultImportRegex = /import\s+([A-Z]\w+)\s+from\s+['"][^'"]+['"]/g;
    while ((match = defaultImportRegex.exec(content)) !== null) {
      used.add(match[1].toLowerCase());
    }

    // Match JSX tags: <Button>, <Card.Header>
    const jsxRegex = /<([A-Z]\w+)[\s/>]/g;
    while ((match = jsxRegex.exec(content)) !== null) {
      used.add(match[1].toLowerCase());
    }
  } catch {
    /* skip unreadable files */
  }
  return used;
}

function scan(projectDir, milestone) {
  const findings = [];
  const registryPath = findRegistryPath(projectDir);

  if (!registryPath) {
    return {
      generatedAt: new Date().toISOString(),
      generatedBy: 'cobolt-wireframe-diff',
      summary: { declared: 0, used: 0, unused: 0, undeclared: 0, gaps: 0, pass: true, noRegistry: true },
      findings: [],
    };
  }

  const registry = loadRegistry(registryPath);
  if (!registry) {
    findings.push({
      id: 'WF-ERR',
      type: 'error',
      severity: 'error',
      component: 'component-registry.json',
      message: 'Failed to parse component-registry.json',
    });
    return {
      generatedAt: new Date().toISOString(),
      generatedBy: 'cobolt-wireframe-diff',
      summary: { declared: 0, used: 0, unused: 0, undeclared: 0, gaps: 0, pass: false },
      findings,
    };
  }

  const declared = extractDeclaredComponents(registry);
  const pages = extractPageDeclarations(registry);
  const sourceFiles = walkSourceFiles(projectDir);

  // Collect all used components across all source files
  const allUsed = new Map();
  const perFileUsage = new Map();
  for (const filePath of sourceFiles) {
    const used = extractUsedComponents(filePath);
    const relativePath = normalizeProjectPath(path.relative(projectDir, filePath));
    perFileUsage.set(relativePath, used);
    for (const comp of used) {
      if (!allUsed.has(comp)) allUsed.set(comp, []);
      allUsed.get(comp).push(relativePath);
    }
  }

  let findingIdx = 0;

  // Check declared-but-unused
  for (const [key, info] of declared) {
    if (!allUsed.has(key)) {
      findings.push({
        id: `WF-${String(++findingIdx).padStart(3, '0')}`,
        type: 'unused',
        severity: 'error',
        component: info.name,
        declaredIn: info.declaredIn,
        usedIn: null,
        message: `Component "${info.name}" declared in registry (${info.source}) but not imported/used in any source file`,
      });
    }
  }

  // Check used-but-undeclared (warning — registry needs update, not a code problem)
  for (const [key, files] of allUsed) {
    if (!declared.has(key)) {
      // Skip common React built-ins
      if (['fragment', 'suspense', 'strictmode', 'profiler'].includes(key)) continue;
      findings.push({
        id: `WF-${String(++findingIdx).padStart(3, '0')}`,
        type: 'undeclared',
        severity: 'warning',
        component: key,
        declaredIn: null,
        usedIn: files.slice(0, 5).join(', '),
        message: `Component "${key}" used in code but not declared in component-registry.json`,
      });
    }
  }

  // Check page wiring gaps
  for (const page of pages) {
    const normalizedPageFile = normalizeProjectPath(page.file);
    const pageUsage = perFileUsage.get(normalizedPageFile);
    if (!pageUsage) continue;

    for (const comp of page.declaredComponents) {
      if (!pageUsage.has(comp.toLowerCase())) {
        findings.push({
          id: `WF-${String(++findingIdx).padStart(3, '0')}`,
          type: 'gap',
          severity: 'error',
          component: comp,
          declaredIn: `page:${page.route} (${normalizedPageFile})`,
          usedIn: null,
          message: `Page "${page.route}" declares component "${comp}" but doesn't import/use it`,
        });
      }
    }
  }

  const unused = findings.filter((f) => f.type === 'unused').length;
  const undeclared = findings.filter((f) => f.type === 'undeclared').length;
  const gaps = findings.filter((f) => f.type === 'gap').length;
  const errors = findings.filter((f) => f.severity === 'error').length;

  return {
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-wireframe-diff',
    milestone: milestone || null,
    registryPath: path.relative(projectDir, registryPath),
    ...buildProvenance(projectDir, sourceFiles),
    summary: {
      declared: declared.size,
      used: allUsed.size,
      unused,
      undeclared,
      gaps,
      errors,
      pass: errors === 0,
    },
    findings,
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
  const jsonMode = args.includes('--json');
  let projectDir = process.cwd();
  let milestone = null;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--milestone' && args[i + 1]) {
      milestone = args[++i];
    } else if (!args[i].startsWith('--')) {
      projectDir = path.resolve(args[i]);
    }
  }

  if (command !== 'scan') {
    console.log('Usage: node tools/cobolt-wireframe-diff.js scan [--json] [--milestone M1]');
    process.exit(command ? 2 : 0);
  }

  const report = scan(projectDir, milestone);
  const targetPath = path.join(
    projectDir,
    '_cobolt-output',
    'latest',
    'build',
    milestone ? `${milestone}-wireframe-diff.json` : 'wireframe-diff.json',
  );
  writeReport(targetPath, report);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[cobolt-wireframe-diff] ${report.summary.errors} error(s), ${report.summary.undeclared} warning(s)`);
    console.log(`  Declared: ${report.summary.declared}, Used: ${report.summary.used}`);
    console.log(`  Written: ${targetPath}`);
  }

  process.exit(report.summary.pass ? 0 : 1);
}

module.exports = { scan, writeReport, extractDeclaredComponents, extractUsedComponents };
