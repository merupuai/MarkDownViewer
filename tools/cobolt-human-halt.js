#!/usr/bin/env node
// cobolt-human-halt — emit HUMAN-REVIEW-REQUIRED.md when autonomous recovery exhausts.
//
// Called by cobolt-plan after the full recovery ladder (self-critique → targeted
// redispatch → recovery-advisor) has failed to produce passing artifacts. Produces a
// single structured halt document and marks cobolt-state.json planning.status=HUMAN_REVIEW.
//
// This is the ONLY legitimate non-user-initiated halt in --autonomous mode. It does
// NOT present menus, ceremony, or numbered options — one file, one status flag, exit.
//
// Usage:
//   cobolt-human-halt <phase> --artifact <path> --class <failure-class> [--advisor <path>]

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
// GT-06: lazy-loaded advice helper. Wrapped in try/catch at the call site so
// halt creation never blocks on advice rendering.
let _advice = null;
function loadAdvice() {
  if (_advice !== null) return _advice;
  try {
    _advice = require('../lib/cobolt-gate-advice.js');
  } catch {
    _advice = false;
  }
  return _advice;
}
const ROOT = process.cwd();
const PLANNING_DIR = path.join(ROOT, '_cobolt-output/latest/planning');
const STATE_FILE = path.join(ROOT, 'cobolt-state.json');
const HALT_FILE = path.join(PLANNING_DIR, 'HUMAN-REVIEW-REQUIRED.md');
const AUDIT_DIR = path.join(ROOT, '_cobolt-output/audit');
const ESCALATION_LOG = path.join(AUDIT_DIR, 'escalation-log.jsonl');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--artifact') args.artifact = argv[++i];
    else if (v === '--class') args.class = argv[++i];
    else if (v === '--advisor') args.advisor = argv[++i];
    else if (v === '--skill') args.skill = argv[++i];
    else if (v.startsWith('--')) {
      /* ignore */
    } else args._.push(v);
  }
  return args;
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function readJSONSafe(p) {
  const raw = readFileSafe(p);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function gatherCritiqueHistory(skill) {
  const file = path.join(PLANNING_DIR, 'self-critique', `${skill}.json`);
  const data = readJSONSafe(file);
  if (!data) return null;
  return {
    file,
    verdict: data.verdict,
    contentDepthScore: data.contentDepthScore,
    revisionTargetCount: Array.isArray(data.revisionTargets) ? data.revisionTargets.length : 0,
    revisionTargets: Array.isArray(data.revisionTargets) ? data.revisionTargets.slice(0, 5) : [],
  };
}

function gatherRetryLedger(artifact) {
  const ledger = path.join(AUDIT_DIR, 'plan-retry-ledger.jsonl');
  if (!fs.existsSync(ledger)) return [];
  const lines = fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e.artifact === artifact) entries.push(e);
    } catch {
      /* skip */
    }
  }
  return entries;
}

function markState() {
  const state = readJSONSafe(STATE_FILE) || {};
  if (!state.planning) state.planning = {};
  state.planning.status = 'HUMAN_REVIEW';
  state.planning.humanReviewAt = new Date().toISOString();
  state.planning.humanReviewFile = path.relative(ROOT, HALT_FILE).replaceAll('\\', '/');
  try {
    atomicWrite(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    /* non-fatal */
  }
}

function logEscalation(args) {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.appendFileSync(
    ESCALATION_LOG,
    `${JSON.stringify({ at: new Date().toISOString(), action: 'human-halt', ...args })}\n`,
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const phase = args._[0] || 'unknown';
  const artifact = args.artifact || 'unknown';
  const failureClass = args.class || 'planning-content-quality';
  const skill = args.skill || null;
  const advisorFile = args.advisor || null;

  fs.mkdirSync(PLANNING_DIR, { recursive: true });

  const critique = skill ? gatherCritiqueHistory(skill) : null;
  const retries = gatherRetryLedger(artifact);
  const advisor = advisorFile ? readJSONSafe(advisorFile) : null;

  const content = [
    `# Human Review Required`,
    ``,
    `**Generated:** ${new Date().toISOString()}`,
    `**Phase:** ${phase}`,
    `**Artifact:** \`${artifact}\``,
    `**Failure class:** ${failureClass}`,
    skill ? `**Producing skill:** ${skill}` : null,
    ``,
    `## Why the pipeline stopped`,
    ``,
    `Autonomous recovery exhausted all deterministic options for this artifact:`,
    ``,
    `1. Initial LLM authoring completed.`,
    `2. Self-critique returned \`needs-revision\` after the maximum of 2 revision cycles.`,
    `3. Targeted redispatch with structured correction prompts was attempted ${retries.length} time(s) — the budget is ${retries.length >= 2 ? 'exhausted' : 'not exhausted but other signals forced escalation'}.`,
    `4. The recovery-advisor agent (opus-tier) reviewed the correction history and ${advisor ? `returned action \`${advisor?.proposal?.action || 'escalate'}\`` : 'was not invoked or produced no actionable verdict'}.`,
    ``,
    critique
      ? [
          `## Self-critique state`,
          ``,
          `- Verdict: \`${critique.verdict}\``,
          `- Content depth score: \`${critique.contentDepthScore ?? 'n/a'}\``,
          `- Revision targets: ${critique.revisionTargetCount}`,
          ``,
          critique.revisionTargets.length > 0
            ? [
                `### Outstanding revision targets`,
                ``,
                ...critique.revisionTargets.map(
                  (t, i) =>
                    `${i + 1}. **${t.section || '(section unspecified)'}** — ${t.why || ''}\n   ${t.fixPrompt || ''}`,
                ),
                ``,
              ].join('\n')
            : null,
        ]
          .filter(Boolean)
          .join('\n')
      : null,
    retries.length > 0
      ? [`## Redispatch history`, ``, ...retries.map((r, i) => `${i + 1}. ${r.at} — action=${r.action}`), ``].join('\n')
      : null,
    advisor
      ? [`## Recovery advisor verdict`, ``, '```json', JSON.stringify(advisor, null, 2).slice(0, 2000), '```', ``].join(
          '\n',
        )
      : null,
    `## Recommended next action`,
    ``,
    `**Fast path (autonomous recovery):** run \`/cobolt-unblock\` — converts this halt into tracked planning debt and resumes the pipeline in \`--auto\` mode. No manual editing. The debt entry preserves the revision targets below, so nothing is lost.`,
    ``,
    `**Manual path (re-author the failing sections yourself):**`,
    ``,
    `1. Open \`${artifact}\` and the critique at \`${critique?.file || '_cobolt-output/latest/planning/self-critique/*.json'}\`.`,
    `2. Read the outstanding revision targets above and author the missing or shallow sections by hand — the LLM pipeline has surfaced specifically what it could not produce at quality.`,
    `3. When you are satisfied, delete this file (\`HUMAN-REVIEW-REQUIRED.md\`) and re-run \`/cobolt-plan project --resume --auto\`. The pipeline will re-enter self-critique for the edited artifact; if your edits pass, it will continue. If not, this file will be regenerated with the new failure state.`,
    ``,
    `**See \`docs/PLANNING-RECOVERY.md\`** for all recovery options (including \`--resume\` with a larger retry budget, targeted redispatch, and \`/cobolt-gap\` for coverage-driven halts).`,
    ``,
    `## Full evidence locations`,
    ``,
    `- Self-critique files: \`_cobolt-output/latest/planning/self-critique/\``,
    `- Redispatch ledger: \`_cobolt-output/audit/plan-retry-ledger.jsonl\``,
    `- Escalation log: \`_cobolt-output/audit/escalation-log.jsonl\``,
    `- Advisor request/response: \`_cobolt-output/audit/advisory-request.json\` / \`advisory-response.json\``,
    ``,
  ]
    .filter(Boolean)
    .join('\n');

  // GT-06: append a Failure Advice section enumerating recent gate fires
  // with structured advice envelopes. Idempotent — re-running the halt
  // creation replaces the section between the anchor comments rather than
  // appending duplicates. Wrapped in try/catch so halt creation never
  // blocks on advice rendering.
  let finalContent = content;
  try {
    const adv = loadAdvice();
    if (adv && typeof adv.recentAdvice === 'function' && typeof adv.renderHaltSection === 'function') {
      const SINCE_24H = Date.now() - 24 * 3_600_000;
      const recent = adv.recentAdvice({ projectRoot: ROOT, sinceMs: SINCE_24H });
      const section = adv.renderHaltSection(recent);
      finalContent = `${content}\n${section}`;
    }
  } catch {
    /* halt creation must never fail on advice rendering */
  }

  atomicWrite(HALT_FILE, finalContent);
  markState();
  logEscalation({ phase, artifact, failureClass, skill, advisorFile });

  const jsonOut = process.argv.includes('--json');
  if (jsonOut) {
    console.log(JSON.stringify({ halt: true, file: HALT_FILE, phase, artifact, failureClass }));
  } else {
    console.log(`[human-halt] wrote ${HALT_FILE}`);
    console.log(`[human-halt] planning.status=HUMAN_REVIEW; pipeline will halt on resume until this file is removed.`);
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { main };
