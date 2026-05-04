#!/usr/bin/env node

// CoBolt Repair — diagnose and heal corrupt build state.
//
// Usage:
//   node tools/cobolt-repair.js diagnose --milestone M1
//   node tools/cobolt-repair.js heal --milestone M1 [--rewind-to <stepId>] --confirm
//
// Diagnose: walk _cobolt-output/latest/build/{M}/ + checkpoints/, cross-check
// against cobolt-state.json and the checkpoint-write-gate predecessor map.
// Reports orphan checkpoints (no upstream artifacts) and orphan artifacts
// (no corresponding checkpoint). Exits 0 if healthy, 2 if corrupt.
//
// Heal: delete checkpoints and state entries at or after the named step
// (default: earliest orphan). Dry-run by default. --confirm required to write.
//
// This tool is a lifeline when the pipeline writes a phantom checkpoint
// despite the write-gate (e.g. the gate was bypassed or an older CoBolt
// version produced the state). It never touches user source code.

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
// v0.13.5: single source of truth — schema. Fallback to hook export, then inline.
const { PREDECESSORS, STEP_ORDER } = (() => {
  try {
    const lib = require(path.resolve(__dirname, '..', 'lib', 'cobolt-checkpoint.js'));
    const schema = lib.loadSchema();
    return { PREDECESSORS: schema.predecessors || {}, STEP_ORDER: schema.stepOrder || [] };
  } catch {
    /* fall through */
  }
  try {
    const hook = require(path.resolve(__dirname, '..', 'source', 'hooks', 'cobolt-checkpoint-write-gate.js'));
    return {
      PREDECESSORS: hook.PREDECESSORS || {},
      STEP_ORDER: [
        '00-preflight',
        '01-milestone-setup',
        '01a-story-specs',
        '01b-spec-validation',
        '02-tdd-red',
        '03-tdd-green',
        '04-tdd-refactor',
        '05-review',
        '06-fix',
        '07-validate',
        '08-milestone-complete',
      ],
    };
  } catch {
    return {
      PREDECESSORS: {},
      STEP_ORDER: [
        '00-preflight',
        '01-milestone-setup',
        '01a-story-specs',
        '01b-spec-validation',
        '02-tdd-red',
        '03-tdd-green',
        '04-tdd-refactor',
        '05-review',
        '06-fix',
        '07-validate',
        '08-milestone-complete',
      ],
    };
  }
})();

function usage() {
  console.log('Usage:');
  console.log('  node tools/cobolt-repair.js diagnose --milestone M{n}');
  console.log('  node tools/cobolt-repair.js heal     --milestone M{n} [--rewind-to <stepId>] --confirm');
  process.exit(1);
}

function parseArgs(argv) {
  const out = { cmd: argv[0], confirm: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--milestone' || a === '-m') out.milestone = argv[++i];
    else if (a === '--rewind-to' || a === '-r') out.rewindTo = argv[++i];
    else if (a === '--confirm') out.confirm = true;
    else if (a === '--json') out.json = true;
  }
  return out;
}

function buildDir(m) {
  return path.join(process.cwd(), '_cobolt-output', 'latest', 'build', m);
}
function checkpointDir() {
  return path.join(process.cwd(), '_cobolt-output', 'latest', 'build', 'checkpoints');
}
function statePath() {
  return path.join(process.cwd(), 'cobolt-state.json');
}

function listCheckpoints(m) {
  const dir = checkpointDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${m}-`) && f.endsWith('.json'))
    .map((f) => ({
      file: f,
      fullPath: path.join(dir, f),
      key: f.replace(new RegExp(`^${m}-`), '').replace(/\.json$/, ''),
    }));
}

function artifactExists(rel, m) {
  return fs.existsSync(path.join(process.cwd(), rel.replace(/\{M\}/g, m)));
}

function diagnose(m) {
  const report = {
    milestone: m,
    healthy: true,
    checkpointsFound: [],
    orphans: [],
    missingArtifacts: [],
    earliestCorruption: null,
    buildDirExists: fs.existsSync(buildDir(m)),
    buildDirContents: [],
  };
  if (report.buildDirExists) {
    report.buildDirContents = fs.readdirSync(buildDir(m));
  }
  const cps = listCheckpoints(m);
  report.checkpointsFound = cps.map((c) => c.file);

  for (const cp of cps) {
    const spec = PREDECESSORS[cp.key];
    if (!spec) continue; // round-N-* not in static map; skip for now
    const missingPred = spec.predecessors.filter((p) => !fs.existsSync(path.join(checkpointDir(), `${m}-${p}.json`)));
    const missingArt = (spec.artifacts || []).filter((a) => !artifactExists(a, m));
    if (missingPred.length || missingArt.length) {
      report.healthy = false;
      report.orphans.push({
        checkpoint: cp.file,
        missingPredecessors: missingPred,
        missingArtifacts: missingArt.map((a) => a.replace(/\{M\}/g, m)),
      });
      const firstBroken = missingPred[0] || cp.key;
      if (
        !report.earliestCorruption ||
        STEP_ORDER.indexOf(firstBroken) < STEP_ORDER.indexOf(report.earliestCorruption)
      ) {
        report.earliestCorruption = firstBroken;
      }
    }
  }

  // Round checkpoints: any round-N-green without M-test-plan.json is phantom
  for (const cp of cps) {
    if (/^round-\d+-green$/.test(cp.key)) {
      if (!artifactExists('_cobolt-output/latest/build/{M}/{M}-test-plan.json', m)) {
        report.healthy = false;
        report.orphans.push({
          checkpoint: cp.file,
          missingPredecessors: ['02-tdd-red'],
          missingArtifacts: [`_cobolt-output/latest/build/${m}/${m}-test-plan.json`],
        });
        if (!report.earliestCorruption) report.earliestCorruption = '01-milestone-setup';
      }
    }
  }

  return report;
}

function heal(m, rewindTo, confirm) {
  const diag = diagnose(m);
  const rewind = rewindTo || diag.earliestCorruption || '01-milestone-setup';
  const rewindIdx = STEP_ORDER.indexOf(rewind);
  if (rewindIdx < 0) {
    console.error(`ERROR: unknown rewind target "${rewind}". Valid: ${STEP_ORDER.join(', ')}`);
    process.exit(1);
  }

  const cps = listCheckpoints(m);
  const toDelete = [];
  for (const cp of cps) {
    // Match step keys
    const idx = STEP_ORDER.indexOf(cp.key);
    if (idx >= rewindIdx) toDelete.push(cp.fullPath);
    // All round-* checkpoints get purged (they depend on Step 02+)
    if (/^round-\d+-(red|green|refactor)$/.test(cp.key) && rewindIdx <= STEP_ORDER.indexOf('03-tdd-green')) {
      toDelete.push(cp.fullPath);
    }
  }

  console.log(`Repair plan for ${m} — rewind to: ${rewind}`);
  console.log(`  Earliest corruption detected: ${diag.earliestCorruption || '(none — diagnostic override)'}`);
  console.log(`  Checkpoints to delete: ${toDelete.length}`);
  for (const f of toDelete) console.log(`    - ${path.relative(process.cwd(), f)}`);
  console.log('  State mutations:');
  console.log(`    - build.currentStep      → ${rewind}`);
  console.log('    - build.currentRound     → (cleared)');
  console.log('    - build.currentRoundPhase → (cleared)');

  if (!confirm) {
    console.log('\nDRY-RUN. Re-run with --confirm to apply.');
    return 0;
  }

  for (const f of toDelete) {
    try {
      fs.unlinkSync(f);
    } catch (e) {
      console.error(`  WARN: could not delete ${f}: ${e.message}`);
    }
  }
  try {
    const s = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    if (!s.build) s.build = {};
    s.build.currentStep = rewind;
    delete s.build.currentRound;
    delete s.build.currentRoundPhase;
    atomicWrite(statePath(), JSON.stringify(s, null, 2));
  } catch (e) {
    console.error(`  WARN: could not update cobolt-state.json: ${e.message}`);
  }

  console.log(`\nHealed. Resume with: /cobolt-build ${m} --resume --auto`);
  return 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.cmd || !['diagnose', 'heal'].includes(args.cmd)) return usage();
  if (!args.milestone || !/^M\d+$/.test(args.milestone)) {
    console.error('ERROR: --milestone M{n} required');
    return usage();
  }
  if (args.cmd === 'diagnose') {
    const r = diagnose(args.milestone);
    if (args.json) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.log(`Diagnosis for ${args.milestone}:`);
      console.log(`  Build dir exists: ${r.buildDirExists} (${r.buildDirContents.length} entries)`);
      console.log(`  Checkpoints found: ${r.checkpointsFound.length}`);
      for (const c of r.checkpointsFound) console.log(`    - ${c}`);
      if (r.healthy) {
        console.log('  Status: HEALTHY');
      } else {
        console.log('  Status: CORRUPT');
        console.log(`  Earliest corruption: ${r.earliestCorruption}`);
        console.log('  Orphans:');
        for (const o of r.orphans) {
          console.log(`    ${o.checkpoint}`);
          if (o.missingPredecessors.length)
            console.log(`      missing predecessors: ${o.missingPredecessors.join(', ')}`);
          if (o.missingArtifacts.length) console.log(`      missing artifacts: ${o.missingArtifacts.join(', ')}`);
        }
        console.log(`\n  Heal: node tools/cobolt-repair.js heal --milestone ${args.milestone} --confirm`);
      }
    }
    process.exit(r.healthy ? 0 : 2);
  }
  if (args.cmd === 'heal') {
    process.exit(heal(args.milestone, args.rewindTo, args.confirm));
  }
}

if (require.main === module) main();

module.exports = { diagnose, heal, STEP_ORDER };
