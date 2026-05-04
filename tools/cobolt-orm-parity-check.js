#!/usr/bin/env node

// CoBolt ORM Parity Check — advisory DB schema ↔ code alignment verifier.
// See full docs block below.

const fs = require('node:fs');
const path = require('node:path');
const { buildProvenance } = require('./_brownfield-provenance');
const { walkSourceFiles } = require('../lib/cobolt-messaging-patterns');

const TOOL_NAME = 'cobolt-orm-parity-check';
const TOOL_VERSION = '1.0';

const BOUNDARY_ORMS = ['sqlalchemy', 'activerecord', 'ecto', 'typeorm', 'sequelize'];

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function detectOrms(projectDir) {
  const orms = { prisma: false, drizzle: false, boundary: [] };
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readText(pkgPath));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.prisma || deps['@prisma/client']) orms.prisma = true;
      if (deps['drizzle-orm']) orms.drizzle = true;
      if (deps.typeorm) orms.boundary.push('typeorm');
      if (deps.sequelize) orms.boundary.push('sequelize');
    } catch {
      /* malformed */
    }
  }
  const boundaryFiles = [
    { file: 'requirements.txt', orm: 'sqlalchemy', re: /sqlalchemy/i },
    { file: 'pyproject.toml', orm: 'sqlalchemy', re: /sqlalchemy/i },
    { file: 'Gemfile', orm: 'activerecord', re: /\brails\b|activerecord/i },
    { file: 'mix.exs', orm: 'ecto', re: /:ecto\b/ },
  ];
  for (const { file, orm, re } of boundaryFiles) {
    const fp = path.join(projectDir, file);
    if (fs.existsSync(fp) && re.test(readText(fp))) {
      if (!orms.boundary.includes(orm)) orms.boundary.push(orm);
    }
  }
  return orms;
}

function findPrismaSchemas(projectDir) {
  const out = [];
  const stack = [projectDir];
  const ignored = new Set(['.git', 'node_modules', '_cobolt-output', 'dist', 'build', '.next', 'coverage']);
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) stack.push(full);
        continue;
      }
      if (entry.name === 'schema.prisma') out.push(full);
    }
  }
  return out;
}

function parsePrismaSchema(text) {
  const models = {};
  const modelRegex = /model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)\}/g;
  for (const m of text.matchAll(modelRegex)) {
    const name = m[1];
    const body = m[2];
    const fields = [];
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) continue;
      const fm = /^([A-Za-z_][A-Za-z0-9_]*)\s+/.exec(trimmed);
      if (fm) fields.push(fm[1]);
    }
    models[name] = fields;
  }
  return models;
}

function findDrizzleSchemas(projectDir) {
  const out = [];
  for (const file of walkSourceFiles(projectDir, { extensions: ['.ts', '.js', '.tsx'] })) {
    const text = readText(file.path);
    if (!text) continue;
    if (/\b(?:pgTable|mysqlTable|sqliteTable)\s*\(/.test(text)) {
      out.push(file.path);
    }
  }
  return out;
}

function parseDrizzleSchema(text) {
  const models = {};
  const tableRegex = /(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*\{([\s\S]*?)\n\s*\}\s*[,)]/g;
  for (const m of text.matchAll(tableRegex)) {
    const tableName = m[1];
    const body = m[2];
    const fields = [];
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;
      const fm = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(trimmed);
      if (fm) fields.push(fm[1]);
    }
    models[tableName] = fields;
  }
  return models;
}

function scanFieldUsage(projectDir, fieldName, excludePath = null) {
  const rx = new RegExp(`\\b${fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  let count = 0;
  const excludeAbs = excludePath ? path.resolve(excludePath) : null;
  for (const file of walkSourceFiles(projectDir, { extensions: ['.js', '.jsx', '.ts', '.tsx'] })) {
    if (excludeAbs && path.resolve(file.path) === excludeAbs) continue;
    const text = readText(file.path);
    if (!text) continue;
    const matches = text.match(rx);
    if (matches) count += matches.length;
    if (count >= 1) return count;
  }
  return count;
}

function scan(projectDir) {
  const resolved = path.resolve(projectDir);
  const orms = detectOrms(resolved);
  const findings = [];
  const models = [];

  if (orms.prisma) {
    for (const schemaFile of findPrismaSchemas(resolved)) {
      const text = readText(schemaFile);
      const parsed = parsePrismaSchema(text);
      for (const [modelName, fields] of Object.entries(parsed)) {
        for (const fieldName of fields) {
          const used = scanFieldUsage(resolved, fieldName, schemaFile);
          models.push({ orm: 'prisma', model: modelName, field: fieldName, used: used > 0 });
          if (used === 0) {
            findings.push({
              orm: 'prisma',
              kind: 'schema-field-unused',
              model: modelName,
              field: fieldName,
              confidence: 'medium',
              detail: `Prisma model ${modelName}.${fieldName} declared but no code reference found.`,
            });
          }
        }
      }
    }
  }

  if (orms.drizzle) {
    for (const schemaFile of findDrizzleSchemas(resolved)) {
      const text = readText(schemaFile);
      const parsed = parseDrizzleSchema(text);
      for (const [tableName, fields] of Object.entries(parsed)) {
        for (const fieldName of fields) {
          const used = scanFieldUsage(resolved, fieldName, schemaFile);
          models.push({ orm: 'drizzle', model: tableName, field: fieldName, used: used > 0 });
          if (used === 0) {
            findings.push({
              orm: 'drizzle',
              kind: 'schema-field-unused',
              model: tableName,
              field: fieldName,
              confidence: 'medium',
              detail: `Drizzle table ${tableName}.${fieldName} declared but no code reference found.`,
            });
          }
        }
      }
    }
  }

  const boundaryDeclarations = orms.boundary.map((orm) => ({
    orm,
    deterministicBoundary: 'orm-dynamic-access',
    note: `${orm} permits runtime string-keyed column access; deterministic parity check out of scope for v1.`,
  }));

  const report = {
    generatedAt: new Date().toISOString(),
    generatedBy: TOOL_NAME,
    version: TOOL_VERSION,
    ...buildProvenance(resolved, []),
    orms: {
      prisma: orms.prisma,
      drizzle: orms.drizzle,
      boundary: orms.boundary,
    },
    summary: {
      totalFields: models.length,
      usedFields: models.filter((m) => m.used).length,
      unusedFields: findings.length,
      findings: findings.length,
      boundaryOrms: boundaryDeclarations.length,
    },
    models: models.slice(0, 500),
    findings: findings.slice(0, 500),
    boundaryDeclarations,
    honestLimits: [
      'Field-usage detection is a coarse identifier-presence check; name collisions may over-count.',
      `Out-of-scope ORMs (${BOUNDARY_ORMS.join(', ')}) are reported as deterministicBoundary — tool does not claim coverage.`,
      'Runtime string-keyed access patterns cannot be statically resolved.',
      'This tool is Tier 2 advisory — findings degrade milestone grade but never block.',
    ],
  };

  return report;
}

function decideExitCode(report) {
  // GT-01: bypass routes through signed ledger. Env-var auto-promoted during window.
  const { isGateBypassed } = require('../lib/cobolt-bypass-resolver');
  if (isGateBypassed('orm-parity', { projectRoot: process.cwd() })) return { code: 0, bypass: true };
  const hasScannableOrm = report.orms.prisma || report.orms.drizzle;
  const hasBoundaryOrm = report.orms.boundary.length > 0;
  if (!hasScannableOrm && !hasBoundaryOrm) return { code: 0, reason: 'no-orm-detected' };
  if (!hasScannableOrm && hasBoundaryOrm) return { code: 0, reason: 'only-boundary-orms-present' };
  return { code: 0, reason: 'advisory-scan-completed', findings: report.summary.findings };
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
        '  cobolt-orm-parity-check scan [project-path] [--milestone Mn] [--json] [--output <path>]',
        '',
        'Scope v1: Prisma + Drizzle. Other ORMs are reported as deterministicBoundary.',
        '',
        'Exit codes:',
        '  0 — scan complete (advisory — findings never hard-block)',
        '  1 — malformed schema or internal error',
        '  2 — no Prisma/Drizzle ORM detected (nothing to scan)',
        '',
        'Bypass: COBOLT_ORM_PARITY=off',
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
      ? path.join(projectDir, '_cobolt-output', 'latest', 'build', milestone, `${milestone}-orm-parity.json`)
      : path.join(projectDir, '_cobolt-output', 'latest', 'build', 'orm-parity.json'));
  writeReport(target, report);

  const verdict = decideExitCode(report);
  report.verdict = verdict;

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[${TOOL_NAME}] ORMs: Prisma=${report.orms.prisma}, Drizzle=${report.orms.drizzle}`);
    if (report.orms.boundary.length > 0) {
      console.log(`  Boundary ORMs (out of scope): ${report.orms.boundary.join(', ')}`);
    }
    console.log(`  Total fields: ${report.summary.totalFields}`);
    console.log(`  Used: ${report.summary.usedFields}`);
    console.log(`  Findings (unused/advisory): ${report.summary.findings}`);
    console.log(`  Verdict: exit ${verdict.code} (${verdict.reason || 'bypass'})`);
    console.log(`  Written: ${target}`);
  }

  process.exit(verdict.code);
}

module.exports = {
  scan,
  detectOrms,
  parsePrismaSchema,
  parseDrizzleSchema,
  decideExitCode,
  BOUNDARY_ORMS,
};
