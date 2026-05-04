#!/usr/bin/env node

// CoBolt Plan Doctor (v0.22.8) — full-stack diagnostic for the planning
// pipeline. Answers "why did my plan come out incomplete / why is the build
// gate blocking me?" with a single structured report.
//
// Checks (in order):
//   1. Tool presence — planning tools + validators + failure-record writer
//   2. Schema presence — rtm / milestone / plan-phase-artifacts schemas
//   3. Agent presence — all 18 planning agents on disk
//   4. Hook presence + registration — planning gates
//   5. Sub-skill presence — 20+ sub-skills dispatched by cobolt-plan
//   6. Kill-switch state — every planning-relevant env flag
//   7. Planning artifact freshness — PRD / TRD / arch / data-model / etc.
//   8. RTM integrity — census, coverage, phantom refs
//   9. Phase checkpoint coverage — which phases have been completed
//  10. Recent failure records — planning-agent-failures ledger + per-agent
//
// Usage:
//   node tools/cobolt-plan-doctor.js check [--dir <project>] [--json]
//
// Exit codes:
//   0 — all green
//   1 — one or more warnings
//   2 — one or more failures (pipeline will not advance)

const fs = require('node:fs');
const path = require('node:path');
const { buildPlanningLoopVerdict } = require('./cobolt-planning-loop-verdict');

const REQUIRED_TOOLS = [
  'cobolt-planning-context.js',
  'cobolt-planning-artifact-audit.js',
  'cobolt-plan-proof.js',
  'cobolt-planning-bootstrap.js',
  'cobolt-plan-redispatch.js',
  'cobolt-planning-debt.js',
  'cobolt-sprint-plan.js',
  'cobolt-plan-args.js',
  'cobolt-validate-prd.js',
  'cobolt-rtm.js',
  'cobolt-preflight.js',
  'cobolt-validate-milestone.js',
  'cobolt-self-critique.js',
  'cobolt-agent-failure-review.js',
  'cobolt-planning-failure-record.js',
  'cobolt-planning-source-ledger.js',
  'cobolt-planning-control-map.js',
  'cobolt-planning-risk-model.js',
  'cobolt-agentic-threat-model.js',
  'cobolt-planning-performance-profile.js',
  'cobolt-planning-replay-calibration.js',
  'cobolt-planning-evidence-signature.js',
  'cobolt-planning-loop-verdict.js',
];

const REQUIRED_SCHEMAS = [
  'rtm.schema.json',
  'milestone-report.schema.json',
  'milestone-regroup-plan.schema.json',
  'plan-phase-artifacts.json',
  'planning-external-source-ledger.schema.json',
  'planning-control-map.schema.json',
  'planning-risk-model.schema.json',
  'agentic-threat-model.schema.json',
  'planning-performance-profile.schema.json',
  'planning-replay-calibration.schema.json',
  'planning-evidence-signature.schema.json',
  'planning-loop-verdict.schema.json',
];

const REQUIRED_AGENTS = [
  'analyst.md',
  'architect.md',
  'ux-designer.md',
  'security-architect.md',
  'trd-architect.md',
  'milestone-architect.md',
  'cross-milestone-analyst.md',
  'delivery-planner.md',
  'gap-analyst.md',
  'rtm-analyst.md',
  'implicit-req-extractor.md',
  'compliance-architect.md',
  'prd-redteam-agent.md',
  'enhancement-advisor.md',
  'engineering-standards-validator.md',
  'bounded-context-architect.md',
  'spec-architect.md',
  'localization-specialist.md',
  'planning-lead.md',
  'recovery-advisor.md',
];

const REQUIRED_HOOKS = [
  'cobolt-planning-gate.js',
  'cobolt-plan-readiness-gate.js',
  'cobolt-planning-critique-gate.js',
  'cobolt-plan-subskill-trap-gate.js',
  'cobolt-plan-complete-gate.js',
  'cobolt-prompt-injection-scanner.js',
];

const REQUIRED_SUBSKILLS = [
  'cobolt-create-prd',
  'cobolt-validate-prd',
  'cobolt-enhance-prd',
  'cobolt-extract-implicit-reqs',
  'cobolt-create-trd',
  'cobolt-create-architecture',
  'cobolt-create-ux-design',
  'cobolt-create-data-model',
  'cobolt-create-api-contracts',
  'cobolt-create-security-reqs',
  'cobolt-create-delivery-plan',
  'cobolt-create-epics-and-stories',
  'cobolt-decompose-milestones',
  'cobolt-decompose-bounded-contexts',
  'cobolt-create-cross-milestone-analysis',
  'cobolt-create-traceability-matrix',
  'cobolt-master-plan',
  'cobolt-check-implementation-readiness',
  'cobolt-sprint-planning',
  'cobolt-analyze-features',
];

const KILL_SWITCH_ENVS = [
  'COBOLT_PLANNING_GATE',
  'COBOLT_PLAN_READINESS_GATE',
  'COBOLT_PLANNING_CRITIQUE_GATE',
  'COBOLT_PLAN_SUBSKILL_TRAP_GATE',
  'COBOLT_PLAN_COMPLETE_GATE',
  'COBOLT_RTM_INTEGRITY_GATE',
  'COBOLT_ARTIFACT_PARITY',
  'COBOLT_V12_GATES',
  'COBOLT_AUTONOMOUS',
  'COBOLT_AUTO',
];

const PLANNING_ARTIFACTS = [
  'prd.md',
  'trd.md',
  'architecture.md',
  'system-architecture.md',
  'data-model-spec.md',
  'api-contracts.md',
  'security-requirements.md',
  'delivery-plan.md',
  'epics.md',
  'milestones.md',
  'ux-design-specification.md',
  'rtm.json',
  'feature-registry.json',
  'story-tracker.json',
  'milestone-tracker.json',
  'sprint-status.yaml',
  'release-readiness-checklist.md',
  'planning-external-source-ledger.json',
  'planning-control-map.json',
  'planning-risk-model.json',
  'agentic-threat-model.json',
  'planning-performance-profile.json',
  'planning-replay-calibration.json',
  'planning-evidence-signature.json',
  'planning-loop-verdict.json',
];

function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next != null && !next.startsWith('--')) {
          out.flags[a.slice(2)] = next;
          i += 1;
        } else {
          out.flags[a.slice(2)] = true;
        }
      }
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

function resolveFile(projectRoot, relPath) {
  const candidates = [
    path.join(projectRoot, relPath),
    process.env.COBOLT_TOOLS && path.join(process.env.COBOLT_TOOLS, '..', relPath),
    path.join(__dirname, '..', relPath),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function checkToolPresence(projectRoot) {
  return REQUIRED_TOOLS.map((name) => {
    const rel = path.join('tools', name);
    const found = resolveFile(projectRoot, rel);
    return { name, ok: Boolean(found), path: found || rel };
  });
}

function checkSchemaPresence(projectRoot) {
  return REQUIRED_SCHEMAS.map((name) => {
    const rel = path.join('source', 'schemas', name);
    const installedRel = path.join('.claude', 'schemas', name);
    const found = resolveFile(projectRoot, rel) || resolveFile(projectRoot, installedRel);
    return { name, ok: Boolean(found), path: found || rel };
  });
}

function checkAgentPresence(projectRoot) {
  return REQUIRED_AGENTS.map((name) => {
    const rel = path.join('source', 'agents', name);
    const installedRel = path.join('.claude', 'agents', name);
    const found = resolveFile(projectRoot, rel) || resolveFile(projectRoot, installedRel);
    return { name, ok: Boolean(found), path: found || rel };
  });
}

function checkSubskillPresence(projectRoot) {
  return REQUIRED_SUBSKILLS.map((name) => {
    const rel = path.join('source', 'skills', name, 'SKILL.md');
    const installedRel = path.join('.claude', 'skills', name, 'SKILL.md');
    const found = resolveFile(projectRoot, rel) || resolveFile(projectRoot, installedRel);
    return { name, ok: Boolean(found), path: found || rel };
  });
}

function checkHookPresence(projectRoot) {
  return REQUIRED_HOOKS.map((name) => {
    const rel = path.join('source', 'hooks', name);
    const installedRel = path.join('.claude', 'hooks', name);
    const found = resolveFile(projectRoot, rel) || resolveFile(projectRoot, installedRel);
    let registered = false;
    try {
      const dispatcher =
        resolveFile(projectRoot, path.join('source', 'hooks', 'cobolt-pre-dispatch.js')) ||
        resolveFile(projectRoot, path.join('.claude', 'hooks', 'cobolt-pre-dispatch.js'));
      if (dispatcher) {
        const txt = fs.readFileSync(dispatcher, 'utf8');
        registered = txt.includes(name);
      }
    } catch {
      /* registration check is advisory */
    }
    return { name, ok: Boolean(found), registered, path: found || rel };
  });
}

function checkKillSwitches() {
  const out = {};
  for (const env of KILL_SWITCH_ENVS) {
    const val = process.env[env];
    out[env] = val == null ? null : String(val);
  }
  return out;
}

function checkArtifactFreshness(projectRoot) {
  const base = path.join(projectRoot, '_cobolt-output', 'latest', 'planning');
  const out = { base, artifacts: [], present: 0, total: PLANNING_ARTIFACTS.length };
  if (!fs.existsSync(base)) {
    out.reason = 'planning directory absent — no plan has been run';
    return out;
  }
  for (const name of PLANNING_ARTIFACTS) {
    const p = path.join(base, name);
    const sub = path.join(base, 'rtm', name);
    const candidates = [p, sub];
    let found = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        found = c;
        break;
      }
    }
    if (found) {
      try {
        const st = fs.statSync(found);
        out.artifacts.push({
          name,
          ok: true,
          bytes: st.size,
          ageMinutes: Math.round((Date.now() - st.mtimeMs) / 60000),
        });
        out.present += 1;
      } catch {
        out.artifacts.push({ name, ok: false, reason: 'stat-failed' });
      }
    } else {
      out.artifacts.push({ name, ok: false, reason: 'not-found' });
    }
  }
  return out;
}

function checkRtmIntegrity(projectRoot) {
  const rtmPath = path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'rtm.json');
  if (!fs.existsSync(rtmPath)) return { ok: false, reason: 'rtm.json absent' };
  try {
    const rtm = JSON.parse(fs.readFileSync(rtmPath, 'utf8'));
    const requirements = Array.isArray(rtm.requirements)
      ? rtm.requirements
      : rtm.requirements && typeof rtm.requirements === 'object'
        ? Object.values(rtm.requirements)
        : [];
    const withStories = requirements.filter((r) => (r.stories || []).length > 0).length;
    const coverage = requirements.length > 0 ? withStories / requirements.length : 0;
    return {
      ok: true,
      requirementCount: requirements.length,
      withStoriesCount: withStories,
      coverage: Math.round(coverage * 1000) / 1000,
    };
  } catch (err) {
    return { ok: false, reason: `parse-failed: ${err.message}` };
  }
}

function checkPhaseCheckpoints(projectRoot) {
  const base = path.join(projectRoot, '_cobolt-output', 'latest', 'planning');
  // Canonical checkpoint files produced by cobolt-plan SKILL.md:
  //   phase1-product-intent.json, phase2-technical-guardrails.json,
  //   phase3-system-design.json, phase4-delivery-breakdown.json,
  //   phase5-build-authorization.json
  // Schema: source/schemas/plan-phase-artifacts.json (phases[phaseN].checkpointFile).
  const canonicalByPhase = {
    'phase-1': ['phase1-product-intent.json'],
    'phase-2': ['phase2-technical-guardrails.json'],
    'phase-3': ['phase3-system-design.json'],
    'phase-4': ['phase4-delivery-breakdown.json'],
    'phase-5': ['phase5-build-authorization.json'],
  };
  const phases = Object.keys(canonicalByPhase);
  const out = { completed: 0, total: phases.length, phases: [] };
  for (const p of phases) {
    const candidates = [
      // Canonical name under checkpoints/
      ...canonicalByPhase[p].map((name) => path.join(base, 'checkpoints', name)),
      // Canonical name at planning/ root
      ...canonicalByPhase[p].map((name) => path.join(base, name)),
      // Legacy fallback shapes
      path.join(base, `${p}-checkpoint.json`),
      path.join(base, 'checkpoints', `${p}.json`),
      path.join(base, `${p}-build-authorization.json`),
    ];
    let found = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        found = c;
        break;
      }
    }
    if (found) {
      out.phases.push({ phase: p, ok: true, path: found });
      out.completed += 1;
    } else {
      out.phases.push({ phase: p, ok: false });
    }
  }
  return out;
}

function checkRecentFailures(projectRoot) {
  const auditDir = path.join(projectRoot, '_cobolt-output', 'audit');
  if (!fs.existsSync(auditDir)) return { any: false, records: [] };

  const PLANNING_AGENT_SET = new Set([
    'analyst',
    'architect',
    'ux-designer',
    'security-architect',
    'trd-architect',
    'milestone-architect',
    'cross-milestone-analyst',
    'delivery-planner',
    'gap-analyst',
    'rtm-analyst',
    'implicit-req-extractor',
    'compliance-architect',
    'prd-redteam-agent',
    'enhancement-advisor',
    'engineering-standards-validator',
    'bounded-context-architect',
    'spec-architect',
    'localization-specialist',
  ]);

  const records = [];
  for (const f of fs.readdirSync(auditDir)) {
    if (!f.endsWith('-failure.json')) continue;
    const base = f.replace(/-failure\.json$/, '');
    if (!PLANNING_AGENT_SET.has(base)) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(auditDir, f), 'utf8'));
      records.push({
        file: f,
        agent: rec.agent,
        stage: rec.stage,
        status: rec.status,
        error_class: rec.error_class,
        escalation_target: rec.escalation_target,
      });
    } catch {
      records.push({ file: f, error: 'parse-failed' });
    }
  }

  // Also check the ledger file
  const ledger = path.join(auditDir, 'planning-agent-failures.jsonl');
  let ledgerCount = 0;
  if (fs.existsSync(ledger)) {
    try {
      const txt = fs.readFileSync(ledger, 'utf8');
      ledgerCount = txt.split('\n').filter((l) => l.trim()).length;
    } catch {
      /* advisory */
    }
  }

  return { any: records.length > 0, count: records.length, ledgerCount, records };
}

function checkPlanCloseAuthority(projectRoot) {
  try {
    const vNextGate = String(process.env.COBOLT_PLAN_VNEXT_GATE || '').toLowerCase();
    const strict = !['0', 'false', 'off', 'advisory', 'bypass', 'disabled'].includes(vNextGate);
    const verdict = buildPlanningLoopVerdict({ projectRoot, write: false, strict });
    return {
      ok: verdict.status !== 'blocked',
      status: verdict.status,
      buildAuthorized: verdict.buildAuthorized === true,
      threshold: verdict.threshold,
      enforcement: strict ? 'strict' : 'advisory',
      primaryBlocker: verdict.blockingReasons?.[0] || null,
      primaryAdvisory: verdict.advisoryReasons?.[0] || null,
      recoveryCommand: verdict.recoveryCommands?.[0] || null,
      blockingCount: Array.isArray(verdict.blockingReasons) ? verdict.blockingReasons.length : 0,
      advisoryCount: Array.isArray(verdict.advisoryReasons) ? verdict.advisoryReasons.length : 0,
      verdict,
    };
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      buildAuthorized: false,
      enforcement: 'strict',
      primaryBlocker: err.message,
      recoveryCommand: 'node tools/index.js doctor plan',
    };
  }
}

function severityFromChecks(report) {
  const requiredMissing = [
    ...report.tools.filter((t) => !t.ok),
    ...report.schemas.filter((s) => !s.ok),
    ...report.agents.filter((a) => !a.ok),
    ...report.subskills.filter((s) => !s.ok),
    ...report.hooks.filter((h) => !h.ok),
  ];
  if (requiredMissing.length > 0) return { level: 'fail', issues: requiredMissing };

  const warnings = [];
  for (const h of report.hooks) {
    if (h.ok && !h.registered) warnings.push({ kind: 'hook-unregistered', item: h.name });
  }
  if (report.artifacts.total > 0 && report.artifacts.present === 0) {
    warnings.push({ kind: 'no-plan-run' });
  }
  if (report.rtm && !report.rtm.ok) warnings.push({ kind: 'rtm-unreadable', reason: report.rtm.reason });
  if (report.rtm?.ok && report.rtm.coverage < 0.85) {
    warnings.push({ kind: 'rtm-low-coverage', coverage: report.rtm.coverage });
  }
  if (report.recentFailures.any) warnings.push({ kind: 'recent-failures', count: report.recentFailures.count });
  if (report.planCloseAuthority && !report.planCloseAuthority.ok) {
    warnings.push({
      kind: 'plan-close-blocked',
      status: report.planCloseAuthority.status,
      reason: report.planCloseAuthority.primaryBlocker,
    });
  }
  for (const [k, v] of Object.entries(report.killSwitches)) {
    if (v == null) continue;
    const lower = String(v).toLowerCase();
    if (lower === 'off' || lower === 'bypass' || lower === '0' || lower === 'disabled') {
      warnings.push({ kind: 'kill-switch-active', env: k, value: v });
    }
  }
  if (warnings.length > 0) return { level: 'warn', warnings };
  return { level: 'ok' };
}

function renderHuman(report) {
  const {
    summary,
    tools,
    schemas,
    agents,
    subskills,
    hooks,
    killSwitches,
    artifacts,
    planCloseAuthority,
    rtm,
    phaseCheckpoints,
    recentFailures,
  } = report;
  const lines = [];
  const banner = summary.level === 'ok' ? 'ALL GREEN' : summary.level === 'warn' ? 'WARNINGS' : 'FAILURES';
  lines.push(`\n[plan-doctor] ${banner}`);
  lines.push('');
  lines.push(`Tools (${tools.filter((t) => t.ok).length}/${tools.length}):`);
  for (const t of tools) lines.push(`  ${t.ok ? '[OK]' : '[--]'} ${t.name}`);
  lines.push('');
  lines.push(`Schemas (${schemas.filter((s) => s.ok).length}/${schemas.length}):`);
  for (const s of schemas) lines.push(`  ${s.ok ? '[OK]' : '[--]'} ${s.name}`);
  lines.push('');
  lines.push(`Agents (${agents.filter((a) => a.ok).length}/${agents.length}):`);
  for (const a of agents) lines.push(`  ${a.ok ? '[OK]' : '[--]'} ${a.name}`);
  lines.push('');
  lines.push(`Sub-skills (${subskills.filter((s) => s.ok).length}/${subskills.length}):`);
  for (const s of subskills) lines.push(`  ${s.ok ? '[OK]' : '[--]'} ${s.name}`);
  lines.push('');
  lines.push('Hooks (PreToolUse):');
  for (const h of hooks) {
    const reg = h.registered ? 'registered' : 'NOT registered';
    lines.push(`  ${h.ok ? '[OK]' : '[--]'} ${h.name.padEnd(38)} ${reg}`);
  }
  lines.push('');
  lines.push(`Planning artifacts (${artifacts.present}/${artifacts.total}):`);
  if (artifacts.reason) {
    lines.push(`  ${artifacts.reason}`);
  } else {
    for (const a of artifacts.artifacts) {
      if (a.ok) {
        lines.push(`  [OK] ${a.name.padEnd(32)} ${a.bytes} bytes, ${a.ageMinutes} min old`);
      } else {
        lines.push(`  [--] ${a.name.padEnd(32)} ${a.reason || 'missing'}`);
      }
    }
  }
  lines.push('');
  lines.push('Plan close authority:');
  if (planCloseAuthority) {
    const tag = planCloseAuthority.ok ? '[OK]' : '[!!]';
    lines.push(
      `  ${tag} status=${planCloseAuthority.status} enforcement=${planCloseAuthority.enforcement || 'strict'} buildAuthorized=${
        planCloseAuthority.buildAuthorized === true
      }`,
    );
    if (planCloseAuthority.primaryBlocker) lines.push(`  primary: ${planCloseAuthority.primaryBlocker}`);
    else if (planCloseAuthority.primaryAdvisory) lines.push(`  advisory: ${planCloseAuthority.primaryAdvisory}`);
    if (planCloseAuthority.recoveryCommand) lines.push(`  recovery: ${planCloseAuthority.recoveryCommand}`);
  } else {
    lines.push('  [--] not evaluated');
  }
  lines.push('');
  lines.push('RTM integrity:');
  if (rtm.ok) {
    const covTag = rtm.coverage >= 0.85 ? '[OK]' : '[!!]';
    lines.push(
      `  ${covTag} ${rtm.requirementCount} reqs, ${rtm.withStoriesCount} with stories, coverage ${Math.round(rtm.coverage * 100)}%`,
    );
  } else {
    lines.push(`  [--] ${rtm.reason}`);
  }
  lines.push('');
  lines.push(`Phase checkpoints (${phaseCheckpoints.completed}/${phaseCheckpoints.total}):`);
  for (const p of phaseCheckpoints.phases) lines.push(`  ${p.ok ? '[OK]' : '[--]'} ${p.phase}`);
  lines.push('');
  lines.push('Recent failures:');
  if (recentFailures.any) {
    for (const r of recentFailures.records) {
      lines.push(`  [!!] ${r.file}: ${r.agent} ${r.status} (${r.error_class}) → ${r.escalation_target}`);
    }
    lines.push(`  ledger: ${recentFailures.ledgerCount} total breadcrumbs`);
  } else {
    lines.push('  [OK] none');
  }
  lines.push('');
  lines.push('Kill switches:');
  const active = Object.entries(killSwitches).filter(([, v]) => v != null);
  if (active.length === 0) lines.push('  (none set)');
  else for (const [k, v] of active) lines.push(`  ${k}=${v}`);
  lines.push('');
  if (summary.level !== 'ok') {
    lines.push('Next action:');
    if (summary.level === 'fail') {
      lines.push('  Restore missing files with: node bin/install.js --claude --global --link');
    } else if (summary.warnings?.some((w) => w.kind === 'no-plan-run')) {
      lines.push('  Run /cobolt-plan to start a new planning pass.');
    } else if (summary.warnings?.some((w) => w.kind === 'rtm-low-coverage')) {
      lines.push('  Re-dispatch rtm-analyst to import missing requirements into rtm.json.');
    } else if (summary.warnings?.some((w) => w.kind === 'recent-failures')) {
      lines.push('  Review failure records and re-dispatch the failing agent(s) with corrected input.');
    } else if (summary.warnings?.some((w) => w.kind === 'plan-close-blocked')) {
      lines.push(`  Run: ${planCloseAuthority?.recoveryCommand || 'node tools/index.js doctor plan'}`);
    } else {
      lines.push('  Review warnings above. Most are advisory.');
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function run(flags) {
  const projectRoot = flags.dir ? path.resolve(flags.dir) : process.cwd();
  const report = {
    generatedAt: new Date().toISOString(),
    projectRoot,
    tools: checkToolPresence(projectRoot),
    schemas: checkSchemaPresence(projectRoot),
    agents: checkAgentPresence(projectRoot),
    subskills: checkSubskillPresence(projectRoot),
    hooks: checkHookPresence(projectRoot),
    killSwitches: checkKillSwitches(),
    artifacts: checkArtifactFreshness(projectRoot),
    planCloseAuthority: checkPlanCloseAuthority(projectRoot),
    rtm: checkRtmIntegrity(projectRoot),
    phaseCheckpoints: checkPhaseCheckpoints(projectRoot),
    recentFailures: checkRecentFailures(projectRoot),
  };
  report.summary = severityFromChecks(report);

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderHuman(report));
  }
  if (report.summary.level === 'fail') return 2;
  if (report.summary.level === 'warn') return 1;
  return 0;
}

function main(argv = process.argv.slice(2)) {
  // Tool-exit-contract: --help/-h must short-circuit before parseArgs consumes it as a flag.
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('usage: cobolt-plan-doctor check [--dir <path>] [--json]\n');
    return 0;
  }
  const parsed = parseArgs(argv);
  const cmd = parsed.positional[0] || 'check';
  if (cmd === 'check') return run(parsed.flags);
  process.stderr.write(`unknown subcommand: ${cmd}\n`);
  return 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  REQUIRED_TOOLS,
  REQUIRED_SCHEMAS,
  REQUIRED_AGENTS,
  REQUIRED_SUBSKILLS,
  REQUIRED_HOOKS,
  KILL_SWITCH_ENVS,
  PLANNING_ARTIFACTS,
  checkToolPresence,
  checkSchemaPresence,
  checkAgentPresence,
  checkSubskillPresence,
  checkHookPresence,
  checkKillSwitches,
  checkArtifactFreshness,
  checkPlanCloseAuthority,
  checkRtmIntegrity,
  checkPhaseCheckpoints,
  checkRecentFailures,
  severityFromChecks,
  run,
  main,
};
