#!/usr/bin/env node
// cobolt-plan-redispatch — structured gap → targeted redispatch payload builder.
//
// When a phase gap review or self-critique verification fails, this tool reads
// the structured failure evidence (phase-{N}-corrections.json and/or self-critique
// results) and builds a per-artifact correction prompt bundle that cobolt-plan
// injects into the next sub-skill dispatch.
//
// Per-artifact retry budget is tracked in _cobolt-output/audit/plan-retry-ledger.jsonl.
// After COBOLT_PLAN_REDISPATCH_MAX (default 2) attempts, this tool declines further
// redispatch and emits escalate=true — the orchestrator must then call recovery-advisor
// (opus-tier) or write HUMAN-REVIEW-REQUIRED.md.
//
// Usage:
//   build <phase>          — consume phase-<N>-corrections.json + self-critique results,
//                            emit per-skill redispatch-plan.json
//   record <artifact>      — record an attempt against an artifact (increments counter)
//   budget <artifact>      — check remaining budget for an artifact

const fs = require('node:fs');
const path = require('node:path');

const MAX_RETRIES = Number(process.env.COBOLT_PLAN_REDISPATCH_MAX || 2);
function planningDir() {
  return path.join(process.cwd(), '_cobolt-output/latest/planning');
}
function auditDir() {
  return path.join(process.cwd(), '_cobolt-output/audit');
}
function ledgerPath() {
  return path.join(auditDir(), 'plan-retry-ledger.jsonl');
}

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function appendLedger(entry) {
  fs.mkdirSync(auditDir(), { recursive: true });
  fs.appendFileSync(ledgerPath(), `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`);
}

// Normalize an artifact path so that `prd.md`, `./prd.md`,
// `_cobolt-output/latest/planning/prd.md` and absolute paths all map to the
// same canonical identifier (basename). Without this, the retry ledger
// accumulates under one form while buildRedispatchPlan looks up under
// another, and budget exhaustion is silently never detected — redispatch
// can loop forever.
function canonicalArtifactKey(artifact) {
  if (!artifact) return '';
  const normalized = String(artifact).replaceAll('\\', '/');
  return path.basename(normalized);
}

function artifactAttemptCount(artifact) {
  if (!fs.existsSync(ledgerPath())) return 0;
  const key = canonicalArtifactKey(artifact);
  const lines = fs.readFileSync(ledgerPath(), 'utf8').split('\n').filter(Boolean);
  let n = 0;
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (canonicalArtifactKey(e.artifact) === key && e.action === 'redispatch') n++;
    } catch {
      /* skip */
    }
  }
  return n;
}

function collectCorrections(phase) {
  const corrections = [];
  const phaseFile = path.join(planningDir(), `phase-${phase}-corrections.json`);
  const phaseData = readJSON(phaseFile);
  if (phaseData && Array.isArray(phaseData.corrections)) {
    for (const c of phaseData.corrections) corrections.push({ source: 'phase-gap-review', ...c });
  }

  const critiqueDir = path.join(planningDir(), 'self-critique');
  if (fs.existsSync(critiqueDir)) {
    for (const f of fs.readdirSync(critiqueDir)) {
      if (!f.endsWith('.json')) continue;
      const data = readJSON(path.join(critiqueDir, f));
      if (!data || data.verdict !== 'needs-revision') continue;
      const skill = data.skill || path.basename(f, '.json');
      const targets = Array.isArray(data.revisionTargets) ? data.revisionTargets : [];
      for (const t of targets) {
        corrections.push({
          source: 'self-critique',
          artifact: data.artifact,
          producingSkill: skill,
          failureClass: 'self-critique-revision-target',
          evidence: { section: t.section, why: t.why },
          correctionPrompt: t.fixPrompt,
        });
      }
    }
  }
  return corrections;
}

function buildRedispatchPlan(phase) {
  const corrections = collectCorrections(phase);
  const bySkill = new Map();
  const declined = [];

  for (const c of corrections) {
    const skill = c.producingSkill;
    const artifact = c.artifact || '(unspecified)';
    if (!skill) continue;
    const attempts = artifactAttemptCount(artifact);
    if (attempts >= MAX_RETRIES) {
      declined.push({ artifact, producingSkill: skill, attempts, reason: 'budget-exhausted' });
      continue;
    }
    if (!bySkill.has(skill)) bySkill.set(skill, []);
    bySkill.get(skill).push(c);
  }

  const plan = {
    phase,
    generatedAt: new Date().toISOString(),
    totalCorrections: corrections.length,
    redispatchSkillCount: bySkill.size,
    declined,
    escalate: declined.length > 0 && bySkill.size === 0,
    redispatches: [],
  };

  for (const [skill, items] of bySkill.entries()) {
    const promptSections = items.map((c, i) => {
      const loc = c.evidence?.file
        ? `${c.evidence.file}${c.evidence.lines ? `:${c.evidence.lines}` : ''}`
        : c.evidence?.section || c.artifact;
      return `${i + 1}. [${c.failureClass}] ${loc}\n   → ${c.correctionPrompt}`;
    });
    const correctionPrompt = `REDISPATCH — prior output failed quality gates. Address these specific items before declaring completion. Re-run your self-critique after revision.\n\n${promptSections.join('\n\n')}\n\nDo NOT regenerate the artifact from scratch unless every item above requires it. Surgical revision preferred.`;
    plan.redispatches.push({
      skill,
      correctionCount: items.length,
      artifacts: [...new Set(items.map((i) => i.artifact))],
      correctionPrompt,
    });
  }

  const outFile = path.join(planningDir(), `phase-${phase}-redispatch-plan.json`);
  fs.writeFileSync(outFile, JSON.stringify(plan, null, 2));
  return { plan, outFile };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const jsonOut = process.argv.includes('--json');

  if (cmd === 'build') {
    const phase = rest[0];
    if (!phase || phase.startsWith('--')) {
      console.error('Usage: cobolt-plan-redispatch build <phase-number>');
      process.exit(1);
    }
    const { plan, outFile } = buildRedispatchPlan(phase);
    if (jsonOut) console.log(JSON.stringify({ outFile, ...plan }, null, 2));
    else
      console.log(
        `[redispatch] phase=${phase} redispatches=${plan.redispatchSkillCount} declined=${plan.declined.length} escalate=${plan.escalate}`,
      );
    process.exit(plan.escalate ? 4 : 0);
  }

  if (cmd === 'record') {
    const artifact = rest[0];
    if (!artifact || artifact.startsWith('--')) {
      console.error('Usage: cobolt-plan-redispatch record <artifact-path>');
      process.exit(1);
    }
    appendLedger({ artifact, action: 'redispatch' });
    const n = artifactAttemptCount(artifact);
    if (jsonOut) console.log(JSON.stringify({ artifact, attempts: n, remaining: Math.max(0, MAX_RETRIES - n) }));
    else console.log(`[redispatch] recorded; ${artifact} attempts=${n} remaining=${Math.max(0, MAX_RETRIES - n)}`);
    process.exit(0);
  }

  if (cmd === 'budget') {
    const artifact = rest[0];
    if (!artifact || artifact.startsWith('--')) {
      console.error('Usage: cobolt-plan-redispatch budget <artifact-path>');
      process.exit(1);
    }
    const n = artifactAttemptCount(artifact);
    const remaining = Math.max(0, MAX_RETRIES - n);
    if (jsonOut) console.log(JSON.stringify({ artifact, attempts: n, remaining, exhausted: remaining === 0 }));
    else console.log(`[redispatch] ${artifact} attempts=${n} remaining=${remaining}`);
    process.exit(remaining === 0 ? 4 : 0);
  }

  console.error('Usage: cobolt-plan-redispatch {build <phase> | record <artifact> | budget <artifact>} [--json]');
  // Tool-exit-contract: --help/-h or no-args -> 0; unknown subcommand -> 1
  const firstArg = process.argv[2];
  const isHelp = firstArg === '--help' || firstArg === '-h';
  process.exit(process.argv.length <= 2 || isHelp ? 0 : 1);
}

if (require.main === module) main();

module.exports = { buildRedispatchPlan, artifactAttemptCount, MAX_RETRIES };
