#!/usr/bin/env node

// CoBolt Manifest — document indexing, verification, and archival
//
// Tracks every document created by the pipeline across milestones.
// All user-facing documents live in _cobolt-output/reports/M{n}/.
//
// Usage:
//   node tools/cobolt-manifest.js register --milestone M1 --stage planning --file M1-prd.md --title "PRD"
//   node tools/cobolt-manifest.js register --milestone M1 --stage planning --artifact _cobolt-output/latest/planning/prd.md --title "PRD"
//   node tools/cobolt-manifest.js verify --milestone M1
//   node tools/cobolt-manifest.js verify --milestone M1 --phase P1
//   node tools/cobolt-manifest.js list --milestone M1
//   node tools/cobolt-manifest.js list                          # All milestones
//   node tools/cobolt-manifest.js path --milestone M1           # Print reports path
//   node tools/cobolt-manifest.js finalize --milestone M1       # Mark milestone done
//   node tools/cobolt-manifest.js init --milestone M1           # Create reports dir + empty manifest
//   node tools/cobolt-manifest.js expected --milestone M1       # Show expected documents for a milestone
//   node tools/cobolt-manifest.js summary                       # Cross-milestone document summary

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { atomicWriteJSON } = require('../lib/cobolt-atomic-write');
const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

// ── Constants ────────────────────────────────────────────────

const EXPECTED_DOCS = {
  planning: [
    { file: 'M{n}-prd.md', title: 'Product Requirements Document', minSize: 500 },
    { file: 'M{n}-prd-validation.md', title: 'PRD Validation Report', minSize: 200 },
    { file: 'M{n}-architecture.md', title: 'Architecture Specification', minSize: 500 },
    { file: 'M{n}-ux-design.md', title: 'UX Design Specification', minSize: 500 },
    { file: 'M{n}-epics.md', title: 'Epics & Stories', minSize: 500 },
    { file: 'M{n}-readiness-report.md', title: 'Implementation Readiness Report', minSize: 200 },
    { file: 'M{n}-sprint-status.yaml', title: 'Sprint Status Tracker', minSize: 100 },
  ],
  'phase-plan': [{ file: 'M{n}-P{x}-phase-plan.md', title: 'Phase Plan', minSize: 300 }],
  build: [
    { file: 'M{n}-P{x}-build-report.md', title: 'Build Report', minSize: 300 },
    { file: 'M{n}-P{x}-requirement-coverage.md', title: 'Requirement Coverage Report', minSize: 200 },
  ],
  review: [{ file: 'M{n}-P{x}-review-report.md', title: 'Code Review Report', minSize: 300 }],
  pentest: [{ file: 'M{n}-P{x}-pentest-report.md', title: 'Penetration Test Report', minSize: 300 }],
  fix: [{ file: 'M{n}-P{x}-fix-report.md', title: 'Fix Report', minSize: 300 }],
  audit: [{ file: 'M{n}-audit-report.md', title: 'PRD Compliance Audit Report', minSize: 300 }],
  'milestone-validate': [{ file: 'M{n}-compliance-report.md', title: 'Milestone Compliance Report', minSize: 300 }],
  deploy: [{ file: 'M{n}-P{x}-deploy-report.md', title: 'Deployment Report', minSize: 300 }],
  dream: [{ file: 'M{n}-dream.md', title: 'Milestone Retrospective', minSize: 300 }],
  health: [{ file: 'M{n}-health-report.md', title: 'Project Health Report', minSize: 300 }],
  'test-suite': [{ file: 'M{n}-test-suite-report.md', title: 'Test Suite Report', minSize: 200 }],
  gap: [{ file: 'M{n}-gap-report.md', title: 'Gap Analysis Report', minSize: 200 }],
};

// ── Paths ────────────────────────────────────────────────────

function outputRoot(projectDir) {
  const _p = typeof _paths === 'function' ? _paths(projectDir) : null;
  return _p ? path.join(_p.outputRoot, 'reports') : path.join(projectDir || process.cwd(), '_cobolt-output', 'reports');
}

function reportsDir(milestone, projectDir) {
  return path.join(outputRoot(projectDir), milestone);
}

function manifestFile(milestone, projectDir) {
  return path.join(reportsDir(milestone, projectDir), `${milestone}-manifest.json`);
}

function resolveRegisteredPath(milestone, file, projectDir) {
  if (!file) return null;
  if (path.isAbsolute(file)) return file;
  if (file.startsWith('_cobolt-output') || file.startsWith('.')) {
    return path.join(projectDir || process.cwd(), file);
  }
  return path.join(reportsDir(milestone, projectDir), file);
}

function inferStageFromFile(file) {
  if (!file) return null;
  const normalized = String(file).replaceAll('\\', '/');
  const match = normalized.match(/_cobolt-output\/(?:latest\/)?([^/]+)\//);
  return match ? match[1] : null;
}

// ── Manifest CRUD ────────────────────────────────────────────

function normalizeRegisterArgs(args) {
  const normalized = { ...(args || {}) };
  if (!normalized.file && normalized.artifact) {
    normalized.file = normalized.artifact;
  }
  return normalized;
}

function isCanonicalPlanningRegistration(args, file, stage) {
  const milestone = String(args.milestone || '').toLowerCase();
  const noMilestoneOrPlanningAlias = !args.milestone || milestone === 'planning';
  const inferredStage = inferStageFromFile(file);
  return noMilestoneOrPlanningAlias && (!file || stage === 'planning' || inferredStage === 'planning');
}

function tryRegisterCanonicalPlanning(args) {
  const projectDir = path.resolve(args.projectDir || args.project || process.cwd());
  const preflightTool = path.join(projectDir, 'tools', 'cobolt-preflight.js');
  if (!fs.existsSync(preflightTool)) return null;

  try {
    const stdout = execFileSync(process.execPath, [preflightTool, 'register-all', '--json'], {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    const trimmed = stdout.trim();
    const result = trimmed ? JSON.parse(trimmed) : { registered: 0, artifacts: {}, errors: [] };
    if (trimmed) console.log(trimmed);
    return { ...result, delegatedTo: 'cobolt-preflight register-all' };
  } catch (err) {
    const stdout = String(err.stdout || '').trim();
    const stderr = String(err.stderr || '').trim();
    console.error('ERROR: canonical planning artifact registration failed');
    console.error(stdout || stderr || err.message);
    process.exit(1);
  }
}

function resolveDocumentPath(milestone, doc, projectDir) {
  if (doc?.path) {
    if (path.isAbsolute(doc.path)) return doc.path;
    if (doc.path.startsWith('_cobolt-output') || doc.path.startsWith('.')) {
      return path.join(projectDir || process.cwd(), doc.path);
    }
  }
  return resolveRegisteredPath(milestone, doc?.file, projectDir);
}

function printRegisterUsageHint() {
  console.error(
    'Usage: node tools/cobolt-manifest.js register --milestone M1 --stage <stage> --file <path> --title "<title>"',
  );
  console.error('Alias: --artifact may be used instead of --file.');
  console.error('For canonical planning packets, use: node tools/cobolt-preflight.js register-all --json');
}

function readManifest(milestone, projectDir) {
  const fp = manifestFile(milestone, projectDir);
  if (!fs.existsSync(fp)) {
    return {
      milestone,
      createdAt: new Date().toISOString(),
      finalizedAt: null,
      status: 'in-progress',
      documents: [],
    };
  }
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function writeManifest(manifest, projectDir) {
  manifest.lastUpdated = new Date().toISOString();
  const fp = manifestFile(manifest.milestone, projectDir);
  atomicWriteJSON(fp, manifest, { mode: 0o600 });
}

// ── Commands ─────────────────────────────────────────────────

function cmdInit(args) {
  const milestone = args.milestone;
  const projectDir = args.projectDir || args.project || process.cwd();
  if (!milestone) {
    console.error('ERROR: --milestone required');
    process.exit(1);
  }
  const dir = reportsDir(milestone, projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = readManifest(milestone, projectDir);
  writeManifest(manifest, projectDir);
  console.log(`Initialized: ${dir}`);
  console.log(`Manifest: ${manifestFile(milestone, projectDir)}`);
  return { dir, manifest: manifestFile(milestone, projectDir) };
}

function cmdRegister(rawArgs) {
  const args = normalizeRegisterArgs(rawArgs);
  const { milestone, file, title, phase } = args;
  const projectDir = args.projectDir || args.project || process.cwd();
  const stage = args.stage || inferStageFromFile(file) || (args.type === 'planning' ? 'planning' : 'build');
  const step = args.step || null;
  const type = args.type || null;
  if (isCanonicalPlanningRegistration(args, file, stage)) {
    const delegated = tryRegisterCanonicalPlanning(args);
    if (delegated) return delegated;
  }
  if (!milestone) {
    console.error('ERROR: --milestone required');
    printRegisterUsageHint();
    process.exit(1);
  }
  if (!file) {
    console.error('ERROR: --file required');
    printRegisterUsageHint();
    process.exit(1);
  }

  const dir = reportsDir(milestone, projectDir);
  fs.mkdirSync(dir, { recursive: true });

  const manifest = readManifest(milestone, projectDir);
  const filePath = resolveRegisteredPath(milestone, file, projectDir);
  const exists = fs.existsSync(filePath);
  const size = exists ? fs.statSync(filePath).size : 0;

  // v0.40.13 PROD-07: canonicalize the file key before dedup.
  // Previously Windows shells produced duplicate entries like
  //   _cobolt-output/latest/build/M1/M1-integration-smoke.json
  //   _cobolt-output/latest/build/m1/M1-integration-smoke.json (lowercased)
  //   _cobolt-output\latest\build\M1\M1-integration-smoke.json (backslashes)
  // all pointing at the same logical artifact. The register loop did exact
  // string equality — three entries, three different sizes, all correct.
  // Normalize to forward slashes + lowercase before dedup, but preserve the
  // caller's input for the `file` field in the entry (round-trip friendly).
  const canonicalize = (p) =>
    String(p || '')
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .toLowerCase();
  const fileKey = canonicalize(file);
  const idx = manifest.documents.findIndex((d) => canonicalize(d.file) === fileKey);
  const entry = {
    file,
    title: title || type || file,
    stage,
    phase: phase || null,
    step,
    type,
    registeredAt: new Date().toISOString(),
    verified: exists,
    size,
    path: filePath,
  };

  if (idx >= 0) {
    manifest.documents[idx] = entry;
  } else {
    manifest.documents.push(entry);
  }

  writeManifest(manifest, projectDir);
  const status = exists ? `VERIFIED (${size}B)` : 'MISSING';
  console.log(`Registered: ${file} [${status}]`);
  return entry;
}

function cmdVerify(args) {
  const { milestone, phase } = args;
  const projectDir = args.projectDir || args.project || process.cwd();
  if (!milestone) {
    console.error('ERROR: --milestone required');
    process.exit(1);
  }

  const manifest = readManifest(milestone, projectDir);
  const dir = reportsDir(milestone, projectDir);
  let missing = 0;
  let found = 0;
  let truncated = 0;

  console.log(`\n  Document Verification: ${milestone}`);
  console.log(`  Reports: ${dir}\n`);
  console.log('  Status   | Size     | Document');
  console.log('  ---------|----------|------------------------------------------');

  for (const doc of manifest.documents) {
    if (phase && doc.phase && doc.phase !== phase) continue;
    const filePath = resolveDocumentPath(milestone, doc, projectDir);
    const exists = fs.existsSync(filePath);
    const size = exists ? fs.statSync(filePath).size : 0;

    // Update verification status
    doc.verified = exists;
    doc.size = size;
    doc.lastVerified = new Date().toISOString();

    if (!exists) {
      console.log(`  MISSING  |    -     | ${doc.file} (${doc.title})`);
      missing++;
    } else if (size < 100) {
      console.log(`  TRUNCATED| ${String(size).padStart(6)}B | ${doc.file} (${doc.title})`);
      truncated++;
    } else {
      console.log(`  OK       | ${String(size).padStart(6)}B | ${doc.file} (${doc.title})`);
      found++;
    }
  }

  // Check for expected docs not yet registered
  const registeredFiles = new Set(manifest.documents.map((d) => d.file));
  const mn = milestone;
  for (const [, docs] of Object.entries(EXPECTED_DOCS)) {
    for (const doc of docs) {
      const filename = doc.file.replace('M{n}', mn);
      // Skip phase-scoped if no specific phase
      if (filename.includes('P{x}')) continue;
      if (!registeredFiles.has(filename)) {
        const filePath = path.join(dir, filename);
        if (fs.existsSync(filePath)) {
          console.log(
            `  UNREG    | ${String(fs.statSync(filePath).size).padStart(6)}B | ${filename} (${doc.title}) — exists but not registered`,
          );
        } else {
          console.log(`  EXPECTED |    -     | ${filename} (${doc.title}) — not created`);
          missing++;
        }
      }
    }
  }

  writeManifest(manifest, projectDir);

  console.log(`\n  Summary: ${found} ok, ${truncated} truncated, ${missing} missing`);
  const pass = missing === 0 && truncated === 0;
  console.log(`  Result: ${pass ? 'PASS' : 'FAIL'}\n`);
  return { found, truncated, missing, pass };
}

function cmdList(args) {
  const { milestone } = args;

  if (milestone) {
    const manifest = readManifest(milestone);
    console.log(`\n  Documents for ${milestone}:`);
    console.log(`  Status: ${manifest.status} | Documents: ${manifest.documents.length}\n`);
    for (const doc of manifest.documents) {
      const status = doc.verified ? 'OK' : 'MISSING';
      console.log(`  [${status}] ${doc.file} — ${doc.title} (${doc.stage}${doc.phase ? `/${doc.phase}` : ''})`);
    }
    if (manifest.documents.length === 0) {
      console.log('  (no documents registered)');
    }
    console.log();
    return manifest;
  }

  // List all milestones
  const root = outputRoot();
  if (!fs.existsSync(root)) {
    console.log('\n  No reports directory found.\n');
    return [];
  }

  const milestones = fs
    .readdirSync(root)
    .filter((d) => d.match(/^M\d+$/))
    .sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));

  if (milestones.length === 0) {
    console.log('\n  No milestone reports found.\n');
    return [];
  }

  console.log('\n  Milestone Reports Summary');
  console.log('  ─────────────────────────\n');
  for (const m of milestones) {
    const manifest = readManifest(m);
    const docCount = manifest.documents.length;
    const verified = manifest.documents.filter((d) => d.verified).length;
    const status = manifest.finalizedAt ? 'FINALIZED' : 'IN-PROGRESS';
    console.log(`  ${m}: ${verified}/${docCount} documents [${status}]`);
  }
  console.log();
  return milestones;
}

function cmdPath(args) {
  const { milestone } = args;
  if (!milestone) {
    console.error('ERROR: --milestone required');
    process.exit(1);
  }
  const dir = reportsDir(milestone);
  fs.mkdirSync(dir, { recursive: true });
  console.log(dir);
  return dir;
}

function cmdFinalize(args) {
  const { milestone } = args;
  const projectDir = args.projectDir || args.project || process.cwd();
  if (!milestone) {
    console.error('ERROR: --milestone required');
    process.exit(1);
  }
  const manifest = readManifest(milestone, projectDir);
  manifest.finalizedAt = new Date().toISOString();
  manifest.status = 'finalized';

  // Final verification pass
  for (const doc of manifest.documents) {
    const filePath = resolveDocumentPath(milestone, doc, projectDir);
    doc.verified = fs.existsSync(filePath);
    doc.size = doc.verified ? fs.statSync(filePath).size : 0;
    doc.lastVerified = new Date().toISOString();
  }

  writeManifest(manifest, projectDir);
  const verified = manifest.documents.filter((d) => d.verified).length;
  console.log(`Finalized ${milestone}: ${verified}/${manifest.documents.length} documents verified`);
  return manifest;
}

function cmdExpected(args) {
  const { milestone } = args;
  if (!milestone) {
    console.error('ERROR: --milestone required');
    process.exit(1);
  }

  console.log(`\n  Expected Documents for ${milestone}`);
  console.log('  ─────────────────────────────────\n');
  for (const [stageName, docs] of Object.entries(EXPECTED_DOCS)) {
    console.log(`  ${stageName}:`);
    for (const doc of docs) {
      const filename = doc.file.replace('M{n}', milestone);
      console.log(`    ${filename} — ${doc.title} (min ${doc.minSize}B)`);
    }
  }
  console.log();
  return EXPECTED_DOCS;
}

function cmdSummary() {
  const root = outputRoot();
  if (!fs.existsSync(root)) {
    console.log('\n  No reports directory found.\n');
    return;
  }

  const milestones = fs
    .readdirSync(root)
    .filter((d) => d.match(/^M\d+$/))
    .sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));

  if (milestones.length === 0) {
    console.log('\n  No milestone reports found.\n');
    return;
  }

  console.log('\n  CoBolt Pipeline — Document Summary');
  console.log('  ═══════════════════════════════════\n');

  const stages = [
    'planning',
    'build',
    'review',
    'pentest',
    'fix',
    'audit',
    'milestone-validate',
    'deploy',
    'dream',
    'health',
    'test-suite',
    'gap',
  ];

  // Header
  let header = '  Stage            ';
  for (const m of milestones) header += `| ${m.padEnd(6)}`;
  console.log(header);
  console.log(`  ${'─'.repeat(19)}${(`|${'─'.repeat(7)}`).repeat(milestones.length)}`);

  for (const stageName of stages) {
    let row = `  ${stageName.padEnd(19)}`;
    for (const m of milestones) {
      const manifest = readManifest(m);
      const stageDocs = manifest.documents.filter((d) => d.stage === stageName);
      const verified = stageDocs.filter((d) => d.verified).length;
      const total = stageDocs.length;
      if (total === 0) {
        row += '|   -   ';
      } else if (verified === total) {
        row += `| ${verified}/${total} OK`;
      } else {
        row += `| ${verified}/${total}   `;
      }
    }
    console.log(row);
  }

  console.log();
  for (const m of milestones) {
    const manifest = readManifest(m);
    const total = manifest.documents.length;
    const verified = manifest.documents.filter((d) => d.verified).length;
    const status = manifest.finalizedAt ? 'DONE' : 'WIP';
    console.log(`  ${m}: ${verified}/${total} docs [${status}]`);
  }
  console.log();
}

// ── CLI Parser ───────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      positional.push(argv[i]);
    }
  }
  return { ...args, _positional: positional };
}

function printUsage() {
  console.log(`
  CoBolt Manifest — Document Indexing & Verification

  Usage:
    node tools/cobolt-manifest.js <command> [options]

  Commands:
    init      --milestone M{n}                    Create reports dir + empty manifest
    register  --milestone M{n} --file <f> [--stage <s>] [--type <t>] [--step 03a] [--title <t>] [--phase P{x}]
              --artifact <f> is accepted as an alias for --file.
              Canonical planning packets: node tools/cobolt-preflight.js register-all --json
    verify    --milestone M{n} [--phase P{x}]     Verify all docs exist on disk
    list      [--milestone M{n}]                   List documents (one or all milestones)
    path      --milestone M{n}                     Print reports directory path
    finalize  --milestone M{n}                     Mark milestone complete
    expected  --milestone M{n}                     Show expected docs for milestone
    summary                                        Cross-milestone document matrix

  All reports: _cobolt-output/reports/M{n}/
`);
}

// ── Main ─────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const command = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (command) {
    case 'init':
      return cmdInit(args);
    case 'register':
      return cmdRegister(args);
    case 'verify': {
      const result = cmdVerify(args);
      if (!result.pass) process.exit(1);
      return result;
    }
    case 'list':
      return cmdList(args);
    case 'path':
      return cmdPath(args);
    case 'finalize':
      return cmdFinalize(args);
    case 'expected':
      return cmdExpected(args);
    case 'summary':
      return cmdSummary(args);
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

// Programmatic API
module.exports = {
  EXPECTED_DOCS,
  outputRoot,
  reportsDir,
  manifestFile,
  readManifest,
  writeManifest,
  register: cmdRegister,
  verify: cmdVerify,
  list: cmdList,
  init: cmdInit,
  finalize: cmdFinalize,
  expected: cmdExpected,
  summary: cmdSummary,
};

if (require.main === module) {
  main();
}
