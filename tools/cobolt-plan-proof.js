#!/usr/bin/env node

// CoBolt Plan Phase Proof (v0.13.10)
//
// Analog of tools/cobolt-step-proof.js for plan phases. Before the plan
// orchestrator writes `phase{N}-*.json`, it calls this tool to record:
//   - which sub-skills were dispatched during the phase
//   - which artifacts were written (path, bytes, sha256)
//   - which artifacts are still MISSING vs the canonical contract in
//     source/schemas/plan-phase-artifacts.json
//
// Output: _cobolt-output/latest/planning/phase-proofs/phase-{N}-proof.json
//
// The phase-gate (cobolt-plan-complete-gate.js with v0.13.10 phase extension)
// reads this proof and refuses the checkpoint write when required artifacts
// are missing or too small.
//
// Usage:
//   node tools/cobolt-plan-proof.js record --phase 2 --dispatched cobolt-create-trd,cobolt-create-secure-coding-standard
//   node tools/cobolt-plan-proof.js verify --phase 2 [--json]
//
// Exit codes:
//   0 = phase proof passes (all required artifacts present + sized)
//   1 = phase proof fails (artifacts missing / below minBytes)
//   2 = usage / internal error

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadPlanPhaseContract } = require('../lib/cobolt-plan-phase-contract');

function _schemaPath() {
  const schema = loadPlanPhaseContract(process.cwd());
  return schema.sourcePath || null;
}

function loadSchema() {
  const schema = loadPlanPhaseContract(process.cwd());
  if (!schema?.phases || Object.keys(schema.phases).length === 0) {
    throw new Error('plan-phase-artifacts.json schema not found');
  }
  return schema;
}

function proofDir() {
  return path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'phase-proofs');
}

function parseArgs(argv) {
  const out = { cmd: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--phase' || a === '-p') out.phase = argv[++i];
    else if (a === '--dispatched') out.dispatched = argv[++i];
    else if (a === '--json') out.json = true;
  }
  return out;
}

function usage(exitCode = 1) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write('Usage:\n');
  stream.write('  node tools/cobolt-plan-proof.js record --phase <1|2|3|4|5> [--dispatched comma,separated]\n');
  stream.write('  node tools/cobolt-plan-proof.js verify --phase <1|2|3|4|5> [--json]\n');
  process.exit(exitCode);
}

function sha256File(p) {
  try {
    const h = crypto.createHash('sha256');
    h.update(fs.readFileSync(p));
    return `sha256:${h.digest('hex')}`;
  } catch {
    return null;
  }
}

function collectArtifactEvidence(phaseSpec) {
  const required = phaseSpec.requiredArtifacts || [];
  const optional = phaseSpec.optionalArtifacts || [];
  const cwd = process.cwd();
  function evidence(list) {
    return list.map((a) => {
      const abs = path.join(cwd, a.path);
      if (!fs.existsSync(abs)) {
        return { path: a.path, exists: false, minBytes: a.minBytes };
      }
      const bytes = fs.statSync(abs).size;
      return {
        path: a.path,
        exists: true,
        bytes,
        minBytes: a.minBytes,
        sha256: sha256File(abs),
        ok: bytes >= a.minBytes,
      };
    });
  }
  const req = evidence(required);
  const opt = evidence(optional);
  const missingRequired = req.filter((e) => !e.exists);
  const underSizedRequired = req.filter((e) => e.exists && e.bytes < e.minBytes);
  return { required: req, optional: opt, missingRequired, underSizedRequired };
}

function record(phase, dispatched) {
  const schema = loadSchema();
  const phaseKey = `phase${phase}`;
  const spec = schema.phases[phaseKey];
  if (!spec) {
    console.error('Unknown phase:', phase);
    process.exit(2);
  }
  const ev = collectArtifactEvidence(spec);
  const proof = {
    phase: Number(phase),
    recordedAt: new Date().toISOString(),
    dispatchedSubSkills: dispatched
      ? dispatched
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    producingSubSkillsContract: spec.producingSubSkills || [],
    requiredArtifacts: ev.required,
    optionalArtifacts: ev.optional,
    gapReportExpected: spec.gapReport || null,
    gapReportPresent: spec.gapReport ? fs.existsSync(path.join(process.cwd(), spec.gapReport)) : null,
    missingRequiredCount: ev.missingRequired.length,
    underSizedRequiredCount: ev.underSizedRequired.length,
    passes: ev.missingRequired.length === 0 && ev.underSizedRequired.length === 0,
  };
  if (!fs.existsSync(proofDir())) fs.mkdirSync(proofDir(), { recursive: true, mode: 0o700 });
  const out = path.join(proofDir(), `phase-${phase}-proof.json`);
  fs.writeFileSync(out, JSON.stringify(proof, null, 2), { mode: 0o600 });
  console.log(`Phase ${phase} proof recorded: ${out}`);
  console.log(
    `  required: ${ev.required.length}, missing: ${ev.missingRequired.length}, undersized: ${ev.underSizedRequired.length}`,
  );
  console.log(`  passes: ${proof.passes}`);
  process.exit(proof.passes ? 0 : 1);
}

function verify(phase, jsonOut) {
  const out = path.join(proofDir(), `phase-${phase}-proof.json`);
  if (!fs.existsSync(out)) {
    const err = { phase: Number(phase), passes: false, reason: 'phase proof not recorded yet' };
    if (jsonOut) console.log(JSON.stringify(err, null, 2));
    else console.error(`Phase ${phase}: no proof recorded at ${out}`);
    process.exit(1);
  }
  const proof = JSON.parse(fs.readFileSync(out, 'utf8'));
  // Re-verify on-disk state matches the recorded proof (defends against post-record mutation).
  const schema = loadSchema();
  const spec = schema.phases[`phase${phase}`];
  const ev = collectArtifactEvidence(spec);
  const mutated = ev.required.some((cur) => {
    const rec = proof.requiredArtifacts.find((r) => r.path === cur.path);
    if (!rec) return true;
    if (rec.exists !== cur.exists) return true;
    if (rec.sha256 && cur.sha256 && rec.sha256 !== cur.sha256) return true;
    return false;
  });
  const passes = proof.passes && !mutated && ev.missingRequired.length === 0 && ev.underSizedRequired.length === 0;
  const result = {
    phase: Number(phase),
    proofFile: out,
    proofPasses: proof.passes,
    currentMissing: ev.missingRequired.map((m) => m.path),
    currentUndersized: ev.underSizedRequired.map((u) => `${u.path} (${u.bytes}/${u.minBytes})`),
    diskMutatedSinceRecord: mutated,
    passes,
  };
  if (jsonOut) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Phase ${phase} verify: ${passes ? 'PASS' : 'FAIL'}`);
    if (result.currentMissing.length) console.log('  missing:', result.currentMissing.join(', '));
    if (result.currentUndersized.length) console.log('  undersized:', result.currentUndersized.join(', '));
    if (mutated) console.log('  disk mutated since record — re-run `record`');
  }
  process.exit(passes ? 0 : 1);
}

function main() {
  const rawArgv = process.argv.slice(2);
  // v0.46 — explicit --help / -h / help → exit 0 per tools/CLAUDE.md contract
  if (rawArgv.includes('--help') || rawArgv.includes('-h') || rawArgv[0] === 'help') return usage(0);
  const args = parseArgs(rawArgv);
  if (!args.cmd) return usage(1);
  if (!args.phase || !/^[1-5]$/.test(args.phase)) return usage(1);
  if (args.cmd === 'record') return record(args.phase, args.dispatched);
  if (args.cmd === 'verify') return verify(args.phase, args.json);
  usage(1);
}

if (require.main === module) main();

module.exports = { loadSchema, collectArtifactEvidence, record, verify };
