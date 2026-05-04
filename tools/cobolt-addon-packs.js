#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const PACKS = Object.freeze({
  'brownfield-web': {
    id: 'brownfield-web',
    name: 'Brownfield Web',
    category: 'brownfield',
    description: 'Visual reverse-engineering extras for UI-heavy brownfield assessments and modernization planning.',
    capabilities: [
      'Visual route inventory and screenshot/DOM evidence summaries',
      'Design token extraction for color, typography, spacing, and elevation signals',
      'Brownfield planning inputs tuned for visual parity and UX continuity',
    ],
    includes: {
      tools: ['playwright', 'design-token-extract', 'knowledge-graph'],
      docs: ['docs/BROWNFIELD-PIPELINE.md', 'docs/COBOLT-CLI-GUIDE.md'],
    },
    commands: [
      'node tools/index.js design-token-extract extract',
      'node tools/index.js playwright visual-inventory',
      'cobolt-cli brownfield . --scan full --visual',
    ],
  },
  'performance-lab': {
    id: 'performance-lab',
    name: 'Performance Lab',
    category: 'quality',
    description: 'A focused pack for latency, hotspot, and regression hunting across builds and releases.',
    capabilities: [
      'Runtime profiling and correlated hotspot reports',
      'Flaky test detection and performance drift tracking',
      'Health and review workflows with performance-first operator cues',
    ],
    includes: {
      tools: ['runtime-profiler', 'flake-hunter', 'health', 'playwright'],
      docs: ['docs/OPERATIONS.md'],
    },
    commands: ['npm run tools:runtime-profiler', 'npm run tools:flake', 'npm run state:health'],
  },
  governance: {
    id: 'governance',
    name: 'Governance',
    category: 'controls',
    description: 'A controls-heavy pack for evidence, auditability, and disciplined release readiness.',
    capabilities: [
      'Traceability and PRD compliance surfaces',
      'SBOM, threat scan, and reliability-readiness workflows',
      'Audience-specific briefs and course exports for review boards or handoff',
    ],
    includes: {
      tools: ['audit', 'sbom', 'pr-threat-scan', 'reliability-guard', 'brief', 'course-export'],
      docs: ['docs/OUTPUTS-AND-ARTIFACTS.md', 'docs/OPERATIONS.md'],
    },
    commands: [
      'npm run audit:run',
      'npm run scan:sbom',
      'node tools/index.js course-export generate --audience handoff',
    ],
  },
});

function outputDir(projectDir = process.cwd()) {
  return path.join(path.resolve(projectDir), '_cobolt-output', 'config');
}

function manifestPath(projectDir = process.cwd()) {
  return path.join(outputDir(projectDir), 'addon-packs.json');
}

function notesPath(projectDir = process.cwd()) {
  return path.join(outputDir(projectDir), 'addon-packs.md');
}

function listPacks() {
  return Object.values(PACKS);
}

function normalizePackIds(input) {
  const values = Array.isArray(input) ? input : String(input || '').split(',');
  return [
    ...new Set(
      values
        .map((value) =>
          String(value || '')
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  ];
}

function validatePackIds(packIds) {
  const unknown = packIds.filter((packId) => !PACKS[packId]);
  if (unknown.length > 0) {
    throw new Error(`Unknown add-on pack(s): ${unknown.join(', ')}`);
  }
}

function readPackManifest(projectDir = process.cwd()) {
  const target = manifestPath(projectDir);
  if (!fs.existsSync(target)) {
    return {
      version: '1.0.0',
      generatedAt: null,
      generatedBy: 'cobolt-addon-packs',
      projectRoot: path.resolve(projectDir),
      installed: [],
    };
  }

  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

function renderPackNotes(manifest) {
  const installed = (manifest.installed || []).map((entry) => PACKS[entry.id]).filter(Boolean);
  const lines = ['# CoBolt Add-On Packs', '', `Generated at: ${manifest.generatedAt || new Date().toISOString()}`, ''];

  if (installed.length === 0) {
    lines.push('No add-on packs are installed.');
    return lines.join('\n');
  }

  for (const pack of installed) {
    lines.push(`## ${pack.name}`);
    lines.push('');
    lines.push(pack.description);
    lines.push('');
    lines.push('Capabilities:');
    lines.push(...pack.capabilities.map((capability) => `- ${capability}`));
    lines.push('');
    lines.push('Suggested commands:');
    lines.push(...pack.commands.map((command) => `- \`${command}\``));
    lines.push('');
  }

  return lines.join('\n');
}

function writePackManifest(manifest, projectDir = process.cwd()) {
  const target = manifestPath(projectDir);
  const summaryPath = notesPath(projectDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(summaryPath, `${renderPackNotes(manifest)}\n`, 'utf8');
  return { manifestPath: target, notesPath: summaryPath };
}

function buildStatus(projectDir = process.cwd()) {
  const manifest = readPackManifest(projectDir);
  const installedSet = new Set((manifest.installed || []).map((entry) => entry.id));

  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    projectRoot: path.resolve(projectDir),
    manifestPath: manifestPath(projectDir),
    notesPath: notesPath(projectDir),
    installed: listPacks()
      .filter((pack) => installedSet.has(pack.id))
      .map((pack) => pack.id),
    packs: listPacks().map((pack) => ({
      id: pack.id,
      name: pack.name,
      category: pack.category,
      description: pack.description,
      installed: installedSet.has(pack.id),
      capabilities: pack.capabilities,
      includes: pack.includes,
    })),
  };
}

function installPacks(projectDir = process.cwd(), packIds = []) {
  const normalized = normalizePackIds(packIds);
  validatePackIds(normalized);

  const current = readPackManifest(projectDir);
  const installed = new Map((current.installed || []).map((entry) => [entry.id, entry]));

  for (const packId of normalized) {
    installed.set(packId, {
      id: packId,
      installedAt: new Date().toISOString(),
    });
  }

  const next = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-addon-packs',
    projectRoot: path.resolve(projectDir),
    installed: [...installed.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };

  const written = writePackManifest(next, projectDir);
  return {
    ...next,
    ...written,
  };
}

function uninstallPacks(projectDir = process.cwd(), packIds = []) {
  const normalized = normalizePackIds(packIds);
  validatePackIds(normalized);

  const current = readPackManifest(projectDir);
  const installed = (current.installed || []).filter((entry) => !normalized.includes(entry.id));
  const next = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-addon-packs',
    projectRoot: path.resolve(projectDir),
    installed,
  };

  const written = writePackManifest(next, projectDir);
  return {
    ...next,
    ...written,
  };
}

function printUsage() {
  console.log('Usage: node tools/cobolt-addon-packs.js <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  list');
  console.log('  show <pack-id>');
  console.log('  status [--dir path] [--json]');
  console.log('  install <pack-id[,pack-id]> [--dir path] [--json]');
  console.log('  uninstall <pack-id[,pack-id]> [--dir path] [--json]');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || 'list';
  const dirIndex = args.indexOf('--dir');
  const projectDir = dirIndex >= 0 ? args[dirIndex + 1] : process.cwd();
  const jsonMode = args.includes('--json');

  if (command === '--help' || command === '-h' || command === 'help') {
    printUsage();
    process.exit(0);
  }

  if (command === 'list') {
    const packs = listPacks();
    console.log(
      jsonMode
        ? JSON.stringify(packs, null, 2)
        : packs.map((pack) => `${pack.id} - ${pack.name}: ${pack.description}`).join('\n'),
    );
    process.exit(0);
  }

  if (command === 'show') {
    const packId = String(args[1] || '')
      .trim()
      .toLowerCase();
    if (!PACKS[packId]) {
      console.error(`Unknown add-on pack: ${args[1] || '(missing)'}`);
      process.exit(2);
    }
    console.log(jsonMode ? JSON.stringify(PACKS[packId], null, 2) : renderPackNotes({ installed: [{ id: packId }] }));
    process.exit(0);
  }

  if (command === 'status') {
    const status = buildStatus(projectDir);
    console.log(jsonMode ? JSON.stringify(status, null, 2) : renderPackNotes(readPackManifest(projectDir)));
    process.exit(0);
  }

  if (command === 'install') {
    const manifest = installPacks(projectDir, args[1] || '');
    console.log(jsonMode ? JSON.stringify(manifest, null, 2) : `Installed add-on packs in ${manifest.manifestPath}`);
    process.exit(0);
  }

  if (command === 'uninstall') {
    const manifest = uninstallPacks(projectDir, args[1] || '');
    console.log(jsonMode ? JSON.stringify(manifest, null, 2) : `Updated add-on packs in ${manifest.manifestPath}`);
    process.exit(0);
  }

  printUsage();
  process.exit(2);
}

module.exports = {
  PACKS,
  listPacks,
  normalizePackIds,
  readPackManifest,
  writePackManifest,
  buildStatus,
  installPacks,
  uninstallPacks,
  manifestPath,
  notesPath,
};
