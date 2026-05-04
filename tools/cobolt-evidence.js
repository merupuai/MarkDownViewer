#!/usr/bin/env node

// CoBolt Evidence Collector — pipeline evidence collection and verification
//
// Collects proof that pipeline stages actually executed (test outputs, scan results,
// build logs). Used by trust architecture to verify gate compliance.
//
// Usage:
//   node tools/cobolt-evidence.js collect <stage> <type> <file>  # Collect evidence artifact
//   node tools/cobolt-evidence.js list [--stage build]           # List collected evidence
//   node tools/cobolt-evidence.js verify <stage>                 # Verify evidence completeness
//   node tools/cobolt-evidence.js summary                        # Show evidence summary
//   node tools/cobolt-evidence.js attest <stage>                 # Generate attestation hash

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { atomicWriteJSON } = require('../lib/cobolt-atomic-write');

const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

function evidenceDir() {
  const _p = typeof _paths === 'function' ? _paths() : null;
  return _p ? _p.evidence() : path.join(process.cwd(), '_cobolt-output/evidence');
}

function manifestPath() {
  return path.join(evidenceDir(), 'manifest.json');
}

function readManifest() {
  const mp = manifestPath();
  if (!fs.existsSync(mp)) return { entries: [], created: new Date().toISOString() };
  return JSON.parse(fs.readFileSync(mp, 'utf8'));
}

function writeManifest(manifest) {
  manifest.lastUpdated = new Date().toISOString();
  const mp = manifestPath();
  try {
    atomicWriteJSON(mp, manifest);
  } catch (err) {
    console.error(`[cobolt-evidence] Error writing manifest: ${err.message}`);
    throw err;
  }
}

// Required evidence per stage for trust verification
const STAGE_REQUIREMENTS = {
  plan: ['requirements', 'architecture'],
  build: ['test-results', 'build-log'],
  review: ['review-report', 'toolgate-report'],
  pentest: ['pentest-report'],
  fix: ['fix-verification'],
  audit: ['audit-report', 'stub-inventory'],
  deploy: ['deploy-log', 'health-check'],
};

// ── Commands ─────────────────────────────────────────────────

function collect(stage, type, sourceFile) {
  // Validate sourceFile is within project boundary (prevent path traversal)
  const resolvedSource = path.resolve(sourceFile);
  const projectRoot = process.cwd();
  if (!resolvedSource.startsWith(projectRoot)) {
    console.error(`  BLOCKED: Source file "${sourceFile}" is outside project directory`);
    process.exit(1);
  }
  if (!fs.existsSync(resolvedSource)) {
    console.error(`  Source file not found: ${sourceFile}`);
    process.exit(1);
  }

  const dir = evidenceDir();
  const stageDir = path.join(dir, stage);
  if (!fs.existsSync(stageDir)) fs.mkdirSync(stageDir, { recursive: true });

  // Copy file and compute hash
  const content = fs.readFileSync(sourceFile);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const ext = path.extname(sourceFile);
  const destName = `${type}-${Date.now()}${ext}`;
  const destPath = path.join(stageDir, destName);
  fs.writeFileSync(destPath, content);

  // Update manifest
  const manifest = readManifest();
  manifest.entries.push({
    stage,
    type,
    file: path.relative(dir, destPath),
    sourceFile: path.resolve(sourceFile),
    sha256: hash,
    size: content.length,
    collectedAt: new Date().toISOString(),
  });
  writeManifest(manifest);

  console.log(`  Evidence collected: [${stage}/${type}] ${destName} (${hash.slice(0, 12)}...)`);
  return { file: destPath, hash };
}

function listEvidence(filters = {}) {
  const manifest = readManifest();
  let entries = manifest.entries;
  if (filters.stage) entries = entries.filter((e) => e.stage === filters.stage);
  if (filters.type) entries = entries.filter((e) => e.type === filters.type);
  return entries;
}

function verify(stage) {
  const required = STAGE_REQUIREMENTS[stage];
  if (!required) {
    console.log(`  No evidence requirements defined for stage: ${stage}`);
    return { complete: true, missing: [], found: [] };
  }

  const manifest = readManifest();
  const stageEntries = manifest.entries.filter((e) => e.stage === stage);
  const foundTypes = new Set(stageEntries.map((e) => e.type));

  const missing = required.filter((r) => !foundTypes.has(r));
  const found = required.filter((r) => foundTypes.has(r));

  return { complete: missing.length === 0, missing, found, total: required.length };
}

function summary() {
  const manifest = readManifest();
  const stages = {};
  for (const entry of manifest.entries) {
    if (!stages[entry.stage]) stages[entry.stage] = [];
    stages[entry.stage].push(entry);
  }
  return {
    totalEntries: manifest.entries.length,
    stages: Object.fromEntries(
      Object.entries(stages).map(([k, v]) => [k, { count: v.length, types: [...new Set(v.map((e) => e.type))] }]),
    ),
    created: manifest.created,
    lastUpdated: manifest.lastUpdated,
  };
}

function attest(stage) {
  const manifest = readManifest();
  const stageEntries = manifest.entries.filter((e) => e.stage === stage);
  if (stageEntries.length === 0) {
    console.error(`  No evidence found for stage: ${stage}`);
    process.exit(1);
  }

  // Create deterministic attestation hash from all stage evidence
  const payload = stageEntries
    .sort((a, b) => a.type.localeCompare(b.type))
    .map((e) => `${e.type}:${e.sha256}`)
    .join('|');

  const attestation = {
    stage,
    timestamp: new Date().toISOString(),
    generator: 'Made by CoBolt — Autonomous Development Platform',
    entryCount: stageEntries.length,
    hash: crypto.createHash('sha256').update(payload).digest('hex'),
    entries: stageEntries.map((e) => ({ type: e.type, sha256: e.sha256 })),
  };

  // Write attestation
  const attestDir = path.join(evidenceDir(), 'attestations');
  if (!fs.existsSync(attestDir)) fs.mkdirSync(attestDir, { recursive: true });
  const attestFile = path.join(attestDir, `${stage}-${Date.now()}.json`);
  fs.writeFileSync(attestFile, JSON.stringify(attestation, null, 2), 'utf8');

  console.log(`  Attestation for ${stage}: ${attestation.hash.slice(0, 16)}...`);
  return attestation;
}

// ── Wireframe evidence (v0.60+) ──────────────────────────────────────

// Emit a .wireframe-evidence.json sidecar binding a frontend component to the
// per-surface wireframe spec it implements. Consumed by cobolt-frontend-write-gate
// (Tier 2) which refuses the component write if the sidecar is missing or the
// surface SHA-256 has drifted. Schema: source/schemas/wireframe-evidence.schema.json.
//
// Inputs are validated against project boundary (no path traversal).
// Surface lookup uses the wireframe-resolver to find the on-disk file matching
// the surfaceId slug (same heuristic the build-setup-step uses).
//
// Exit codes per tools/CLAUDE.md:
//   0 — recorded successfully (or "skipped — no surface map" — pre-v0.59.0 plan)
//   1 — hard error (invalid input, surface unresolvable, write failure)
function recordWireframe({ surfaceId, componentPath, cwd } = {}) {
  if (!surfaceId || typeof surfaceId !== 'string') {
    throw new Error('record-wireframe requires --surface-id <S-XXX>');
  }
  if (!componentPath || typeof componentPath !== 'string') {
    throw new Error('record-wireframe requires --component <relative/path>');
  }
  const projectRoot = cwd ? path.resolve(cwd) : process.cwd();
  const absComponentPath = path.resolve(projectRoot, componentPath);
  if (!absComponentPath.startsWith(projectRoot)) {
    throw new Error(`component path ${componentPath} is outside project root`);
  }
  if (!fs.existsSync(absComponentPath)) {
    throw new Error(`component file not found: ${componentPath}`);
  }

  const wireframeResolver = require('../lib/cobolt-wireframe-resolver');
  const surfaceFiles = wireframeResolver.readSurfaceFiles({ cwd: projectRoot });

  function surfaceIdMatchesFile(sid, fileName) {
    const tail = String(sid)
      .replace(/^[A-Z]+-/u, '')
      .toLowerCase();
    const m = fileName.match(/^(\d{2})-(.+)\.md$/u);
    if (!m) return false;
    const wf = m[2].toLowerCase();
    return tail === wf || tail.includes(wf) || wf.includes(tail);
  }

  const matched = surfaceFiles.find((f) => surfaceIdMatchesFile(surfaceId, f.name));
  if (!matched) {
    // Pre-v0.59.0 plan or surface not yet wireframed — emit a "skipped" sidecar
    // so the gate can distinguish "not yet recorded" from "no match found".
    const sidecarPath = `${absComponentPath}.wireframe-evidence.json`;
    const payload = {
      version: '1',
      surfaceId,
      surfacePath: null,
      surfaceSha256: null,
      componentPath: path.relative(projectRoot, absComponentPath),
      componentSha256: crypto.createHash('sha256').update(fs.readFileSync(absComponentPath)).digest('hex'),
      recordedAt: new Date().toISOString(),
      skipped: 'no-matching-surface-file',
    };
    atomicWriteJSON(sidecarPath, payload);
    return { ok: true, skipped: true, sidecarPath };
  }

  const surfaceContent = fs.readFileSync(matched.path);
  const componentBuf = fs.readFileSync(absComponentPath);
  const sidecarPath = `${absComponentPath}.wireframe-evidence.json`;
  const surfaceSha256 = crypto.createHash('sha256').update(surfaceContent).digest('hex');
  const componentSha256 = crypto.createHash('sha256').update(componentBuf).digest('hex');
  const payload = {
    version: '1',
    surfaceId,
    surfacePath: path.relative(projectRoot, matched.path),
    surfaceSha256,
    componentPath: path.relative(projectRoot, absComponentPath),
    componentSha256,
    recordedAt: new Date().toISOString(),
  };
  // P1.1 — dual-emit to the unified evidence ledger before writing the sidecar.
  // The sidecar stays the read-side contract for cobolt-frontend-write-gate
  // (Tier 2) during the v0.61–v0.63 deprecation window; the ledger is the
  // tamper-evident system-of-record for compliance evidence packs (SOC 2
  // CC8.1, ISO 27001 A.12.4, NIST SSDF PS.3.1).
  let ledgerEntryId = null;
  try {
    const evLedger = require('../lib/cobolt-evidence-ledger');
    const ledgerEntry = evLedger.append(
      {
        kind: evLedger.KINDS.WIREFRAME_BINDING,
        producer: 'cobolt-evidence/v0.61.0',
        surfaceBinding: {
          surfaceId,
          componentPath: path.relative(projectRoot, absComponentPath),
          surfacePath: path.relative(projectRoot, matched.path),
        },
        sha256s: { surface: surfaceSha256, component: componentSha256 },
        controlIds: ['NIST.SSDF.PS.3.1', 'OWASP.ASVS.V14.1.1', 'ISO.27001.A.14.2.5'],
      },
      { projectRoot },
    );
    ledgerEntryId = ledgerEntry.entryId;
    payload._ledgerEntryId = ledgerEntry.entryId;
    payload._ledgerSignature = ledgerEntry.signature;
  } catch (err) {
    // Tier 3 advisory — never block on ledger persistence failure during the
    // deprecation window. Sidecar remains the source of truth for the gate.
    payload._ledgerError = String(err.message || err);
  }
  atomicWriteJSON(sidecarPath, payload);
  return { ok: true, skipped: false, sidecarPath, payload, ledgerEntryId };
}

// ── Module exports ───────────────────────────────────────────

module.exports = {
  collect,
  listEvidence,
  verify,
  summary,
  attest,
  recordWireframe,
  evidenceDir,
  STAGE_REQUIREMENTS,
};

// ── CLI ──────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('  Usage: node tools/cobolt-evidence.js <command> [args]');
    console.log('  Commands: collect, list, verify, summary, attest, record-wireframe');
    console.log('  record-wireframe --surface-id <S-XXX> --component <relative/path>');
    process.exit(0);
  }

  switch (cmd) {
    case 'collect': {
      if (!args[1] || !args[2] || !args[3]) {
        console.error('  Usage: collect <stage> <type> <file>');
        process.exit(1);
      }
      collect(args[1], args[2], args[3]);
      break;
    }
    case 'list': {
      const filters = {};
      for (let i = 1; i < args.length; i += 2) {
        if (args[i] === '--stage') filters.stage = args[i + 1];
        if (args[i] === '--type') filters.type = args[i + 1];
      }
      const entries = listEvidence(filters);
      if (entries.length === 0) {
        console.log('  No evidence found.');
        break;
      }
      for (const e of entries) {
        console.log(`  [${e.stage}/${e.type}] ${e.file} (${e.sha256.slice(0, 12)}...)`);
      }
      break;
    }
    case 'verify': {
      if (!args[1]) {
        console.error('  Usage: verify <stage>');
        process.exit(1);
      }
      const result = verify(args[1]);
      if (result.complete) {
        console.log(`  \u2713 ${args[1]}: All evidence present (${result.found.length}/${result.total})`);
      } else {
        console.log(`  \u2717 ${args[1]}: Missing evidence (${result.found.length}/${result.total})`);
        for (const m of result.missing) console.log(`    - ${m}`);
        process.exit(1);
      }
      break;
    }
    case 'summary': {
      const s = summary();
      console.log(JSON.stringify(s, null, 2));
      break;
    }
    case 'attest': {
      if (!args[1]) {
        console.error('  Usage: attest <stage>');
        process.exit(1);
      }
      attest(args[1]);
      break;
    }
    case 'record-wireframe': {
      let surfaceId = null;
      let componentPath = null;
      let cwd = null;
      for (let i = 1; i < args.length; i += 1) {
        if (args[i] === '--surface-id' && args[i + 1]) {
          surfaceId = args[i + 1];
          i += 1;
        } else if (args[i] === '--component' && args[i + 1]) {
          componentPath = args[i + 1];
          i += 1;
        } else if (args[i] === '--cwd' && args[i + 1]) {
          cwd = args[i + 1];
          i += 1;
        }
      }
      try {
        const result = recordWireframe({ surfaceId, componentPath, cwd });
        if (result.skipped) {
          console.log(`  wireframe-evidence: skipped (no matching surface file) -> ${result.sidecarPath}`);
        } else {
          console.log(`  wireframe-evidence recorded: ${result.sidecarPath}`);
          console.log(`    surfaceSha256: ${result.payload.surfaceSha256.slice(0, 16)}...`);
          console.log(`    componentSha256: ${result.payload.componentSha256.slice(0, 16)}...`);
        }
      } catch (err) {
        console.error(`  record-wireframe failed: ${err.message}`);
        process.exit(1);
      }
      break;
    }
    default:
      console.error(`  Unknown command: ${cmd}`);
      process.exit(1);
  }
}
