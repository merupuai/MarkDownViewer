#!/usr/bin/env node

// CoBolt Evolve — outer-loop harness optimization (Phases 1-5).
//
// Composition:
//   * Meta-Harness substrate (filesystem-rich proposer reads candidates+scores+traces)
//   * GEPA Pareto selection (multi-objective non-dominated retention)
//   * AlphaEvolve islands (diversity + cross-island migration)
//   * Reflexion negative-knowledge ledger
//   * Promotion gate with per-candidate approval tokens + Pareto stability
//   * Dream-hook auto-harvest of failed-candidate lessons
//
// Lives offline under _cobolt-output/harness-lab/. Live source/ is touched
// only by `promote` and `revert`, both gated by eligibility + approval.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const paths = require('../lib/cobolt-evolve/paths');
const allowlist = require('../lib/cobolt-evolve/mutation-allowlist');
const scorecard = require('../lib/cobolt-evolve/scorecard');
const replay = require('../lib/cobolt-evolve/replay');
const reflexion = require('../lib/cobolt-evolve/reflexion');
const islands = require('../lib/cobolt-evolve/islands');
const promotion = require('../lib/cobolt-evolve/promotion');
const dreamHook = require('../lib/cobolt-evolve/dream-hook');

const PHASE_STUB = (cmd) => ({
  ok: false,
  stub: true,
  command: cmd,
  message: `cobolt-evolve "${cmd}" is not enabled.`,
});

function nowIso() {
  return new Date().toISOString();
}

function ensureLab(cwd) {
  paths.ensureDir(paths.root(cwd));
  paths.ensureDir(path.join(paths.root(cwd), 'candidates'));
  paths.ensureDir(path.join(paths.root(cwd), 'islands'));
  paths.ensureDir(paths.corpusDir(cwd));
  paths.ensureDir(paths.reflexionDir(cwd));
}

function listCandidates(cwd = process.cwd()) {
  const dir = path.join(paths.root(cwd), 'candidates');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('c-'))
    .map((d) => {
      const manifestPath = path.join(dir, d.name, 'manifest.json');
      const scorePath = path.join(dir, d.name, 'shadow-scorecard.json');
      let manifest = null;
      let score = null;
      try {
        if (fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch {
        /* skip */
      }
      try {
        if (fs.existsSync(scorePath)) score = JSON.parse(fs.readFileSync(scorePath, 'utf8'));
      } catch {
        /* skip */
      }
      return { candidateId: d.name, manifest, score };
    });
}

function readCandidate(candidateId, cwd = process.cwd()) {
  const cdir = paths.candidateDir(candidateId, cwd);
  const manifestPath = path.join(cdir, 'manifest.json');
  const scPath = path.join(cdir, 'shadow-scorecard.json');
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const score = fs.existsSync(scPath) ? JSON.parse(fs.readFileSync(scPath, 'utf8')) : null;
  return { manifest, score, cdir };
}

function writeManifest(candidateId, manifest, cwd = process.cwd()) {
  const cdir = paths.candidateDir(candidateId, cwd);
  paths.ensureDir(cdir);
  fs.writeFileSync(path.join(cdir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
}

function appendLineage(entry, cwd = process.cwd()) {
  paths.ensureDir(paths.root(cwd));
  fs.appendFileSync(paths.lineagePath(cwd), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function markerPath(cwd = process.cwd()) {
  return path.join(paths.root(cwd), '.evolve-active');
}

// ── Phase 1 commands ────────────────────────────────────────────────────────

function cmdStatus(args) {
  const cwd = process.cwd();
  ensureLab(cwd);
  const corpus = replay.summarize(cwd);
  const cands = listCandidates(cwd);
  const scored = cands.filter((c) => c.score);
  const admissible = scored.filter((c) => scorecard.isAdmissible(c.score));
  const front = scorecard.paretoFront(
    admissible.map((c) => ({
      candidateId: c.candidateId,
      axes: c.score.axes,
      regressionCount: c.score.regressionCount,
    })),
  );
  const out = {
    phase: 5,
    labRoot: paths.ROOT,
    corpus,
    candidates: { total: cands.length, scored: scored.length, admissible: admissible.length },
    paretoFrontSize: front.length,
    paretoFrontIds: front.map((c) => c.candidateId),
    asOf: nowIso(),
  };
  process.stdout.write(`${JSON.stringify(out, null, args.json ? 0 : 2)}\n`);
  return 0;
}

function cmdInitCorpus(args) {
  const cwd = process.cwd();
  ensureLab(cwd);
  const manifestPath = path.join(paths.corpusDir(cwd), 'manifest.json');
  if (fs.existsSync(manifestPath) && !args.force) {
    process.stderr.write(`refusing to overwrite ${manifestPath} (use --force)\n`);
    return 2;
  }
  const corpusId = `corpus-${nowIso().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  const manifest = {
    corpusId,
    frozen: false,
    createdAt: nowIso(),
    description:
      'Replay corpus for cobolt-evolve. Add cases under cases/<case-id>/ then list them here. ' +
      'Freeze (set frozen:true) once stable; scorecards are only comparable within a frozen corpus.',
    cases: [],
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  fs.mkdirSync(path.join(paths.corpusDir(cwd), 'cases'), { recursive: true, mode: 0o700 });
  process.stdout.write(`${JSON.stringify({ ok: true, corpusId, manifestPath }, null, 2)}\n`);
  return 0;
}

function cmdList(args) {
  const out = listCandidates().map((c) => ({
    candidateId: c.candidateId,
    status: c.manifest?.status || 'unknown',
    island: c.manifest?.island || null,
    mutationClass: c.manifest?.mutationClass || null,
    target: c.manifest?.targetPath || null,
    scored: !!c.score,
    admissible: c.score ? scorecard.isAdmissible(c.score) : false,
  }));
  process.stdout.write(`${JSON.stringify(out, null, args.json ? 0 : 2)}\n`);
  return 0;
}

function cmdValidate(args) {
  if (!args._[1]) {
    process.stderr.write('usage: cobolt-evolve validate <candidate-manifest.json>\n');
    return 2;
  }
  const p = path.resolve(args._[1]);
  if (!fs.existsSync(p)) {
    process.stderr.write(`not found: ${p}\n`);
    return 2;
  }
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  const errs = [];
  if (!m.candidateId || !/^c-[0-9a-f]{12}$/.test(m.candidateId)) errs.push('candidateId must match c-<12 hex>');
  if (!m.targetPath) errs.push('targetPath required');
  if (!m.mutationClass) errs.push('mutationClass required');
  if (m.targetPath && m.mutationClass) {
    const v = allowlist.validateTarget(m.targetPath, m.mutationClass);
    if (!v.ok) errs.push(v.reason);
  }
  const result = { ok: errs.length === 0, errors: errs };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

function cmdScore(args) {
  if (!args._[1] || !args._[2]) {
    process.stderr.write('usage: cobolt-evolve score <candidateId> <scorecard.json>\n');
    return 2;
  }
  const candidateId = args._[1];
  if (!/^c-[0-9a-f]{12}$/.test(candidateId)) {
    process.stderr.write('invalid candidateId\n');
    return 2;
  }
  const scPath = path.resolve(args._[2]);
  if (!fs.existsSync(scPath)) {
    process.stderr.write(`not found: ${scPath}\n`);
    return 2;
  }
  const sc = JSON.parse(fs.readFileSync(scPath, 'utf8'));
  const dir = paths.candidateDir(candidateId);
  paths.ensureDir(dir);
  const dest = path.join(dir, 'shadow-scorecard.json');
  fs.writeFileSync(dest, JSON.stringify(sc, null, 2), { mode: 0o600 });
  process.stdout.write(
    `${JSON.stringify({ ok: true, candidateId, dest, admissible: scorecard.isAdmissible(sc) }, null, 2)}\n`,
  );
  return 0;
}

function cmdPareto(args) {
  const cands = listCandidates().filter((c) => c.score);
  const items = cands.map((c) => ({
    candidateId: c.candidateId,
    axes: c.score.axes,
    regressionCount: c.score.regressionCount,
  }));
  const front = scorecard.paretoFront(items);
  const dest = paths.globalParetoPath();
  paths.ensureDir(path.dirname(dest));
  const frontIds = front.map((f) => f.candidateId);
  const payload = { computedAt: nowIso(), front: frontIds };
  fs.writeFileSync(dest, JSON.stringify(payload, null, 2), { mode: 0o600 });
  promotion.appendParetoHistory(frontIds);
  process.stdout.write(`${JSON.stringify({ ok: true, dest, frontSize: front.length }, null, args.json ? 0 : 2)}\n`);
  return 0;
}

// ── Phase 2 commands ────────────────────────────────────────────────────────

function cmdActivate() {
  const cwd = process.cwd();
  paths.ensureDir(paths.root(cwd));
  const p = markerPath(cwd);
  fs.writeFileSync(p, JSON.stringify({ activatedAt: nowIso(), pid: process.pid }, null, 2), { mode: 0o600 });
  process.stdout.write(
    `${JSON.stringify({ ok: true, marker: p, message: 'evolve write-guard now active' }, null, 2)}\n`,
  );
  return 0;
}

function cmdDeactivate() {
  const p = markerPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
  process.stdout.write(`${JSON.stringify({ ok: true, marker: p, removed: !fs.existsSync(p) }, null, 2)}\n`);
  return 0;
}

function cmdPropose(args) {
  const cwd = process.cwd();
  ensureLab(cwd);
  const island = (args.island || 'A').toUpperCase();
  if (!/^[A-K]$/.test(island)) {
    process.stderr.write('island must be A..K\n');
    return 2;
  }
  const cands = listCandidates(cwd);
  const scoredAdmissible = cands
    .filter((c) => c.score && scorecard.isAdmissible(c.score))
    .sort((a, b) => scorecard.compositeScalar(b.score.axes) - scorecard.compositeScalar(a.score.axes));
  const parent = scoredAdmissible[0] || null;
  const recent = cands
    .sort((a, b) => (b.manifest?.createdAt || '').localeCompare(a.manifest?.createdAt || ''))
    .slice(0, 10)
    .map((c) => ({
      candidateId: c.candidateId,
      mutationClass: c.manifest?.mutationClass,
      target: c.manifest?.targetPath,
      status: c.manifest?.status,
    }));
  const lessons = reflexion.loadTopK(8, args.mutationClass ? { mutationClass: args.mutationClass } : {}, cwd);
  const corpus = replay.summarize(cwd);

  const packet = {
    builtAt: nowIso(),
    island,
    parent: parent
      ? {
          candidateId: parent.candidateId,
          mutationClass: parent.manifest?.mutationClass,
          targetPath: parent.manifest?.targetPath,
          axes: parent.score.axes,
          regressionCount: parent.score.regressionCount,
        }
      : null,
    recentCandidates: recent,
    reflexionLessons: lessons,
    corpus,
    constraints: {
      mutationAllowlist: 'lib/cobolt-evolve/mutation-allowlist.js',
      writeSandbox: '_cobolt-output/harness-lab/',
      maxMutationFiles: 1,
      maxRationaleChars: 2000,
    },
  };

  const dir = path.join(paths.root(cwd), 'proposer-inputs');
  paths.ensureDir(dir);
  const dest = path.join(dir, `island-${island}-${Date.now()}.json`);
  fs.writeFileSync(dest, JSON.stringify(packet, null, 2), { mode: 0o600 });
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        packetPath: dest,
        parent: packet.parent?.candidateId || null,
        lessonCount: lessons.length,
        message:
          'Input packet written. Dispatch harness-proposer via the cobolt-evolve skill (CLI does not Agent-dispatch).',
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

function cmdShadowRun(args) {
  const candidateId = args._[1];
  if (!/^c-[0-9a-f]{12}$/.test(candidateId || '')) {
    process.stderr.write('usage: cobolt-evolve shadow-run <candidateId> [--smoke "<cmd>"]\n');
    return 2;
  }
  const cwd = process.cwd();
  const cdir = paths.candidateDir(candidateId, cwd);
  const patchPath = path.join(cdir, 'patch.diff');
  if (!fs.existsSync(patchPath)) {
    process.stderr.write(`patch not found: ${patchPath}\n`);
    return 2;
  }
  const wtRoot = path.join(paths.root(cwd), 'worktrees');
  paths.ensureDir(wtRoot);
  const wt = path.join(wtRoot, candidateId);
  if (fs.existsSync(wt)) {
    process.stderr.write(`worktree already exists: ${wt} (remove first)\n`);
    return 2;
  }
  const branch = `evolve/${candidateId}`;
  const startedAt = Date.now();
  const traceLines = [];
  function trace(event, data) {
    traceLines.push(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
  }
  try {
    trace('worktree.add', { wt, branch });
    execFileSync('git', ['worktree', 'add', '-b', branch, wt, 'HEAD'], { stdio: 'pipe' });
    trace('patch.apply', { patchPath });
    execFileSync('git', ['-C', wt, 'apply', '--whitespace=nowarn', patchPath], { stdio: 'pipe' });
    const smokeCmd = args.smoke || 'node --test tests/test-cobolt-evolve.js';
    trace('smoke.start', { smokeCmd });
    // H2 fix: restrict smoke binary to a minimal allowlist. Candidate manifests
    // must not be able to exec arbitrary binaries during shadow-run.
    const SMOKE_BIN_ALLOWLIST = new Set(['node', 'npm', 'pnpm', 'yarn', 'bun']);
    const [bin, ...rest] = smokeCmd.split(/\s+/);
    if (!SMOKE_BIN_ALLOWLIST.has(bin)) {
      process.stderr.write(`smoke binary "${bin}" not on allowlist (${[...SMOKE_BIN_ALLOWLIST].join(',')})\n`);
      return 2;
    }
    let smokeOk = true;
    let smokeOut = '';
    try {
      smokeOut = execFileSync(bin, rest, { cwd: wt, stdio: 'pipe', encoding: 'utf8' });
    } catch (e) {
      smokeOk = false;
      smokeOut = (e.stdout || '') + (e.stderr || '');
    }
    trace('smoke.end', { ok: smokeOk, bytes: smokeOut.length });
    fs.writeFileSync(path.join(cdir, 'smoke-output.log'), smokeOut, { mode: 0o600 });
    fs.writeFileSync(path.join(cdir, 'trace.jsonl'), `${traceLines.join('\n')}\n`, { mode: 0o600 });
    const wallTimeMs = Date.now() - startedAt;
    const result = {
      ok: smokeOk,
      candidateId,
      worktree: wt,
      wallTimeMs,
      smokeCmd,
      tracePath: path.join(cdir, 'trace.jsonl'),
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return smokeOk ? 0 : 1;
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', wt], { stdio: 'pipe' });
    } catch {
      /* leave for inspection */
    }
  }
}

function cmdReflect(args) {
  const candidateId = args._[1];
  if (!/^c-[0-9a-f]{12}$/.test(candidateId || '')) {
    process.stderr.write('usage: cobolt-evolve reflect <candidateId>\n');
    return 2;
  }
  const cwd = process.cwd();
  const c = readCandidate(candidateId, cwd);
  if (!c?.score) {
    process.stderr.write('manifest.json or shadow-scorecard.json missing for this candidate\n');
    return 2;
  }
  let parentSc = null;
  if (c.manifest.parent) {
    const psPath = path.join(paths.candidateDir(c.manifest.parent, cwd), 'shadow-scorecard.json');
    if (fs.existsSync(psPath)) parentSc = JSON.parse(fs.readFileSync(psPath, 'utf8'));
  }
  // M4 fix: never crash on malformed manifest — report and continue.
  let lesson;
  try {
    lesson = reflexion.extractLesson({ manifest: c.manifest, scorecard: c.score, parentScorecard: parentSc });
  } catch (e) {
    process.stderr.write(`reflect failed: ${e.message}\n`);
    return 1;
  }
  const r = reflexion.appendLesson(lesson, cwd);
  process.stdout.write(`${JSON.stringify({ ok: true, ...r }, null, 2)}\n`);
  return 0;
}

// ── Phase 3 commands ────────────────────────────────────────────────────────

function cmdMigrate(args) {
  const cwd = process.cwd();
  ensureLab(cwd);
  const k = Number(args.perIslandK || 1);
  const records = listCandidates(cwd);
  const pool = islands.buildMigrationPool(records, { perIslandK: k, round: args.round || null });
  const dest = islands.writeMigrationPool(pool, cwd);
  process.stdout.write(
    `${JSON.stringify({ ok: true, dest, perIslandK: k, contributions: pool.contributions, poolSize: pool.pool.length }, null, 2)}\n`,
  );
  return 0;
}

function cmdReflectRejected() {
  const cwd = process.cwd();
  const records = listCandidates(cwd);
  const existingLessonIds = new Set(reflexion.loadAll(cwd).map((l) => l.id));
  let extracted = 0;
  let skipped = 0;
  const details = [];
  for (const r of records) {
    const status = r.manifest?.status;
    if (status !== 'rejected' && status !== 'dominated') continue;
    if (!r.score) {
      skipped++;
      continue;
    }
    let parentSc = null;
    if (r.manifest.parent) {
      const psPath = path.join(paths.candidateDir(r.manifest.parent, cwd), 'shadow-scorecard.json');
      if (fs.existsSync(psPath)) parentSc = JSON.parse(fs.readFileSync(psPath, 'utf8'));
    }
    // M4 fix: one bad candidate must not abort the whole batch.
    let lesson;
    try {
      lesson = reflexion.extractLesson({
        manifest: r.manifest,
        scorecard: r.score,
        parentScorecard: parentSc,
        source: 'auto-reflect',
      });
    } catch {
      skipped++;
      continue;
    }
    if (existingLessonIds.has(lesson.id)) {
      skipped++;
      continue;
    }
    reflexion.appendLesson(lesson, cwd);
    existingLessonIds.add(lesson.id);
    extracted++;
    details.push({ candidateId: r.candidateId, lessonId: lesson.id, failureAxis: lesson.failureAxis });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, extracted, skipped, details }, null, 2)}\n`);
  return 0;
}

// ── Phase 4 commands ────────────────────────────────────────────────────────

function cmdApprove(args) {
  const candidateId = args._[1];
  if (!/^c-[0-9a-f]{12}$/.test(candidateId || '')) {
    process.stderr.write('usage: cobolt-evolve approve <candidateId> --signer <name> [--note "..."]\n');
    return 2;
  }
  if (!args.signer) {
    process.stderr.write('--signer required\n');
    return 2;
  }
  const out = promotion.writeApproval(candidateId, { signer: args.signer, note: args.note }, process.cwd());
  process.stdout.write(`${JSON.stringify({ ok: true, ...out }, null, 2)}\n`);
  return 0;
}

function cmdPromote(args) {
  const candidateId = args._[1];
  if (!/^c-[0-9a-f]{12}$/.test(candidateId || '')) {
    process.stderr.write('usage: cobolt-evolve promote <candidateId> [--auto] [--dry-run]\n');
    return 2;
  }
  const cwd = process.cwd();
  const c = readCandidate(candidateId, cwd);
  if (!c) {
    process.stderr.write(`candidate not found: ${candidateId}\n`);
    return 2;
  }
  const verdict = promotion.checkEligibility({ manifest: c.manifest, scorecard: c.score }, cwd);
  const decision = {
    candidateId,
    eligible: verdict.eligible,
    hasApproval: verdict.hasApproval,
    reasons: verdict.reasons,
    decidedAt: nowIso(),
    auto: !!args.auto,
  };

  if (args.auto && (!verdict.eligible || !verdict.hasApproval)) {
    decision.outcome = 'advisory-skip';
    decision.advisory =
      'Promotion blocked but pipeline must not halt in --auto mode (per CoBolt escalation protocol). ' +
      'Skill orchestrator should dispatch the harness-reflector advisory agent and continue.';
    appendLineage({ event: 'promote.advisory-skip', ...decision }, cwd);
    process.stdout.write(`${JSON.stringify({ ok: true, ...decision }, null, 2)}\n`);
    return 0;
  }
  if (!verdict.eligible) {
    process.stdout.write(`${JSON.stringify({ ok: false, ...decision, outcome: 'rejected' }, null, 2)}\n`);
    return 1;
  }
  if (!verdict.hasApproval) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, ...decision, outcome: 'awaiting-approval', hint: `run: cobolt-evolve approve ${candidateId} --signer <name>` }, null, 2)}\n`,
    );
    return 1;
  }

  const patchPath = path.join(c.cdir, 'patch.diff');
  if (!fs.existsSync(patchPath)) {
    process.stderr.write(`patch.diff missing for ${candidateId}\n`);
    return 2;
  }

  if (args.dryRun) {
    decision.outcome = 'dry-run-ok';
    process.stdout.write(`${JSON.stringify({ ok: true, ...decision, patchPath }, null, 2)}\n`);
    return 0;
  }

  if (fs.existsSync(markerPath(cwd))) {
    process.stderr.write('refusing to promote while evolve is active. Run: cobolt-evolve deactivate\n');
    return 2;
  }
  // H4 fix: patch size ceiling (64KB) + --check preflight so failed applies
  // leave the tree untouched.
  const MAX_PATCH_BYTES = 64 * 1024;
  try {
    const patchStat = fs.statSync(patchPath);
    if (patchStat.size > MAX_PATCH_BYTES) {
      process.stderr.write(`patch size ${patchStat.size} exceeds limit ${MAX_PATCH_BYTES}\n`);
      return 1;
    }
  } catch (e) {
    process.stderr.write(`patch stat failed: ${e.message}\n`);
    return 1;
  }
  try {
    execFileSync('git', ['apply', '--check', '--whitespace=nowarn', patchPath], { stdio: 'pipe', cwd });
  } catch (e) {
    process.stderr.write(`git apply --check rejected patch: ${(e.stderr || e.message || '').toString()}\n`);
    return 1;
  }
  try {
    execFileSync('git', ['apply', '--whitespace=nowarn', patchPath], { stdio: 'pipe', cwd });
  } catch (e) {
    process.stderr.write(`git apply failed: ${(e.stderr || e.message || '').toString()}\n`);
    return 1;
  }
  const subject = `feat(evolve): ${c.manifest.mutationClass} on ${path.basename(c.manifest.targetPath)}`;
  const body = [
    '',
    `candidate: ${candidateId}`,
    `parent: ${c.manifest.parent || 'root'}`,
    `island: ${c.manifest.island || '_'}`,
    `lineage: ${candidateId}`,
    `approved-by: ${verdict.approval.signer}${verdict.approval.note ? ` — ${verdict.approval.note}` : ''}`,
    '',
    'Promoted by cobolt-evolve Phase 4 promotion gate.',
  ].join('\n');
  try {
    execFileSync('git', ['add', c.manifest.targetPath], { stdio: 'pipe', cwd });
    execFileSync('git', ['commit', '-m', `${subject}\n${body}`], { stdio: 'pipe', cwd });
  } catch (e) {
    process.stderr.write(`git commit failed: ${(e.stderr || e.message || '').toString()}\n`);
    return 1;
  }
  let sha = '';
  try {
    sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd }).trim();
  } catch {
    /* skip */
  }
  c.manifest.status = 'promoted';
  c.manifest.decision = {
    outcome: 'promote',
    reason: 'eligible+approved',
    approver: verdict.approval.signer,
    decidedAt: nowIso(),
  };
  writeManifest(candidateId, c.manifest, cwd);
  appendLineage(
    {
      event: 'promote',
      candidateId,
      sha,
      mutationClass: c.manifest.mutationClass,
      target: c.manifest.targetPath,
      signer: verdict.approval.signer,
      at: nowIso(),
    },
    cwd,
  );
  decision.outcome = 'promoted';
  decision.commit = sha;
  process.stdout.write(`${JSON.stringify({ ok: true, ...decision }, null, 2)}\n`);
  return 0;
}

function cmdRevert(args) {
  const candidateId = args._[1];
  if (!/^c-[0-9a-f]{12}$/.test(candidateId || '')) {
    process.stderr.write('usage: cobolt-evolve revert <candidateId> [--reason "..."]\n');
    return 2;
  }
  const cwd = process.cwd();
  const c = readCandidate(candidateId, cwd);
  if (!c) {
    process.stderr.write(`candidate not found: ${candidateId}\n`);
    return 2;
  }
  const lineage = fs.existsSync(paths.lineagePath(cwd))
    ? fs
        .readFileSync(paths.lineagePath(cwd), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    : [];
  const promo = lineage.reverse().find((e) => e.event === 'promote' && e.candidateId === candidateId);
  if (!promo?.sha) {
    process.stderr.write(`no promotion record found for ${candidateId}\n`);
    return 2;
  }
  try {
    execFileSync('git', ['revert', '--no-edit', promo.sha], { stdio: 'pipe', cwd });
  } catch (e) {
    process.stderr.write(`git revert failed: ${(e.stderr || e.message || '').toString()}\n`);
    return 1;
  }
  let revertSha = '';
  try {
    revertSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd }).trim();
  } catch {
    /* skip */
  }
  c.manifest.status = 'reverted';
  c.manifest.decision = {
    outcome: 'revert',
    reason: args.reason || 'canary regression',
    approver: 'auto-revert',
    decidedAt: nowIso(),
  };
  writeManifest(candidateId, c.manifest, cwd);
  appendLineage(
    {
      event: 'revert',
      candidateId,
      originalSha: promo.sha,
      revertSha,
      reason: args.reason || 'canary regression',
      at: nowIso(),
    },
    cwd,
  );
  process.stdout.write(`${JSON.stringify({ ok: true, candidateId, originalSha: promo.sha, revertSha }, null, 2)}\n`);
  return 0;
}

// ── Arg parsing + dispatch ──────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    _: [],
    json: false,
    force: false,
    island: null,
    mutationClass: null,
    smoke: null,
    perIslandK: null,
    round: null,
    auto: false,
    dryRun: false,
    signer: null,
    note: null,
    reason: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--auto') out.auto = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--island') out.island = argv[++i];
    else if (a === '--mutation-class') out.mutationClass = argv[++i];
    else if (a === '--smoke') out.smoke = argv[++i];
    else if (a === '--per-island-k') out.perIslandK = argv[++i];
    else if (a === '--round') out.round = argv[++i];
    else if (a === '--signer') out.signer = argv[++i];
    else if (a === '--note') out.note = argv[++i];
    else if (a === '--reason') out.reason = argv[++i];
    else out._.push(a);
  }
  return out;
}

function help() {
  process.stdout.write(
    [
      'cobolt-evolve — harness optimization outer loop (Phase 5)',
      '',
      'Commands:',
      '  status                                       Show lab state, corpus stats, Pareto size',
      '  init-corpus [--force]                        Create harness-lab/replay-corpus skeleton',
      '  list [--json]                                List candidates with status + scorecards',
      '  validate <manifest.json>                     Validate a candidate manifest against the allowlist',
      '  score <candidateId> <sc.json>                Persist a scorecard under the candidate dir',
      '  pareto                                       Recompute global Pareto front (appends pareto-history)',
      '  activate | deactivate                        Toggle the .evolve-active marker (gates the write-guard)',
      '  propose [--island A] [--mutation-class C]    Build harness-proposer input packet',
      '  shadow-run <candidateId> [--smoke "<cmd>"]   Apply candidate patch in a git worktree, run smoke',
      '  reflect <candidateId>                        Extract a Reflexion lesson from one candidate',
      '  reflect-rejected                             Auto-extract lessons from all rejected/dominated candidates',
      '  migrate [--per-island-k N] [--round N]       Build cross-island migration pool (AlphaEvolve)',
      '  approve <id> --signer <name> [--note ...]    Write an approval token for a candidate',
      '  promote <id> [--auto] [--dry-run]            Promote candidate to source/ (eligibility + approval gated; --auto never halts pipeline)',
      '  revert <id> [--reason "..."]                 Auto-revert a previously promoted candidate',
      '  dream-hook [milestoneId]                     Auto-harvest Reflexion lessons from failed candidates (call from cobolt-dream)',
      '',
    ].join('\n'),
  );
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args._.length === 0) {
    help();
    return 0;
  }
  const cmd = args._[0];
  switch (cmd) {
    case 'status':
      return cmdStatus(args);
    case 'init-corpus':
      return cmdInitCorpus(args);
    case 'list':
      return cmdList(args);
    case 'validate':
      return cmdValidate(args);
    case 'score':
      return cmdScore(args);
    case 'pareto':
      return cmdPareto(args);
    case 'activate':
      return cmdActivate();
    case 'deactivate':
      return cmdDeactivate();
    case 'propose':
      return cmdPropose(args);
    case 'shadow-run':
      return cmdShadowRun(args);
    case 'reflect':
      return cmdReflect(args);
    case 'reflect-rejected':
      return cmdReflectRejected();
    case 'migrate':
      return cmdMigrate(args);
    case 'approve':
      return cmdApprove(args);
    case 'promote':
      return cmdPromote(args);
    case 'revert':
      return cmdRevert(args);
    case 'dream-hook': {
      const out = dreamHook.runDreamHook({ milestoneId: args._[1] || null });
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return 0;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      help();
      return 2;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, parseArgs, listCandidates, ensureLab, markerPath, PHASE_STUB };
