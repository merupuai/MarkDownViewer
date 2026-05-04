#!/usr/bin/env node

// CoBolt Build Doctor (v0.22.8) — full-stack diagnostic for the build
// pipeline. Answers "why did my build come out broken / why isn't the
// milestone-complete-gate letting me through?" with a single structured report.
//
// Checks (in order):
//   1. Tool presence — build tools + validators + failure-record writer
//   2. Schema presence — state, story-tracker, milestone-tracker, gate-tiers
//   3. Agent presence — 19 build agents + 2 build leads
//   4. Hook presence + registration — 15 build gates
//   5. Sub-skill presence — cobolt-dev-story + 19 build step files
//   6. Kill-switch state — every build-relevant env flag
//   7. Build artifact freshness — tests/, src/, docker-compose, etc.
//   8. Worktree state — active story worktrees + cleanup state
//   9. TDD round progress — per-story round verdicts
//  10. Recent failure records — build-agent-failures ledger + per-story

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_TOOLS = [
  'cobolt-build-ready-gate.js',
  'cobolt-prebuild-validate.js',
  'cobolt-entrypoint-wiring-check.js',
  'cobolt-worker-lifecycle-check.js',
  'cobolt-worktree.js',
  'cobolt-infra-check.js',
  'cobolt-contract-replay.js',
  'cobolt-schema-replay.js',
  'cobolt-test.js',
  'cobolt-build-tool-rollup.js',
  'cobolt-self-critique.js',
  'cobolt-agent-failure-review.js',
  'cobolt-illusion-scan.js',
  'cobolt-audit.js',
  'cobolt-validate-milestone.js',
  'cobolt-milestone-report.js',
  'cobolt-step-proof.js',
  'cobolt-cross-milestone-smoke.js',
  'cobolt-build-failure-record.js',
  'cobolt-story-mock-wire.js',
  'cobolt-code-quality-check.js',
  'cobolt-code-duplication-detect.js',
  'cobolt-cyclomatic-complexity.js',
  'cobolt-ai-author-fingerprint.js',
  'cobolt-story-cumulative-smoke.js',
];

const REQUIRED_SCHEMAS = [
  'cobolt-state.schema.json',
  'build-artifacts.schema.json',
  'builder-return.schema.json',
  'gate-tiers.json',
];

const REQUIRED_AGENTS = [
  'build-agent.md',
  'cobolt-build-agent.md',
  'build-lead.md',
  'cobolt-build-lead.md',
  'backend-dev.md',
  'frontend-dev.md',
  'api-endpoint-builder.md',
  'db-migration-writer.md',
  'test-writer.md',
  'test-architect.md',
  'integration-test-agent.md',
  'db-test-agent.md',
  'test-team-lead.md',
  'elixir-component-builder.md',
  'liveview-builder.md',
  'graphql-builder.md',
  'ui-component-builder.md',
  'docker-builder.md',
  'devops-agent.md',
];

const REQUIRED_HOOKS = [
  'cobolt-build-gate.js',
  'cobolt-tdd-gate.js',
  'cobolt-prebuild-validate-gate.js',
  'cobolt-checkpoint-write-gate.js',
  'cobolt-round-gate.js',
  'cobolt-build-progress-watchdog.js',
  'cobolt-anti-self-halt.js',
  'cobolt-phantom-gate.js',
  'cobolt-contract-replay-gate.js',
  'cobolt-dispatch-acl.js',
  'cobolt-builder-return-contract.js',
  'cobolt-builder-persistence-verifier.js',
];

const BUILD_STEPS = [
  '00-preflight.md',
  '01-milestone-setup.md',
  '01a-story-specs.md',
  '01b-spec-validation.md',
  '02-tdd-red.md',
  '02a-wire-deps.md',
  '03-tdd-green.md',
  '04a0-code-quality.md',
  '03a-code-gap-analysis.md',
  '03b-integration-smoke.md',
  '04-tdd-refactor.md',
  '04a-deep-verification.md',
  '04b-build-issue-registry.md',
  '04c-cumulative-smoke.md',
  '05-review.md',
  '06-fix.md',
  '06b-contract-replay.md',
  '06c-schema-replay.md',
  '06d-nfr-enforce.md',
  '07-validate.md',
  '08-milestone-complete.md',
  '08b-cross-milestone-smoke.md',
];

const KILL_SWITCH_ENVS = [
  'COBOLT_BUILD_GATE',
  'COBOLT_TDD_GATE',
  'COBOLT_ROUND_GATE',
  'COBOLT_CHECKPOINT_WRITE_GATE',
  'COBOLT_BUILD_WATCHDOG',
  'COBOLT_ANTI_SELF_HALT',
  'COBOLT_PHANTOM_GATE',
  'COBOLT_CONTRACT_REPLAY_GATE',
  'COBOLT_NFR_BUDGET_GATE',
  'COBOLT_PREBUILD_VALIDATE_GATE',
  'COBOLT_BUILDER_CONTRACT_ENFORCE',
  'COBOLT_BYPASS_STORY_MOCK',
  'COBOLT_BYPASS_QUALITY',
  'COBOLT_BYPASS_CUMSMOKE',
  'COBOLT_V12_GATES',
  'COBOLT_AUTONOMOUS',
  'COBOLT_AUTO',
  'COBOLT_MAX_PARALLEL',
];

const REQUIRED_GATE_TIER_ENTRIES = [
  'cobolt-story-mock-wired-gate.js',
  'cobolt-code-quality-gate.js',
  'cobolt-cumulative-smoke-gate.js',
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

function checkPresence(projectRoot, category) {
  const lists = {
    tools: { paths: ['tools'], items: REQUIRED_TOOLS },
    schemas: { paths: ['source/schemas', '.claude/schemas'], items: REQUIRED_SCHEMAS },
    agents: { paths: ['source/agents', '.claude/agents'], items: REQUIRED_AGENTS },
    hooks: { paths: ['source/hooks', '.claude/hooks'], items: REQUIRED_HOOKS },
    steps: { paths: ['source/skills/cobolt-build/steps', '.claude/skills/cobolt-build/steps'], items: BUILD_STEPS },
  };
  const cfg = lists[category];
  if (!cfg) return [];
  return cfg.items.map((name) => {
    let found = null;
    for (const p of cfg.paths) {
      const rel = path.join(p, name);
      const abs = resolveFile(projectRoot, rel);
      if (abs) {
        found = abs;
        break;
      }
    }
    return { name, ok: Boolean(found), path: found || path.join(cfg.paths[0], name) };
  });
}

function checkHookRegistration(projectRoot, hookList) {
  // Hooks may be registered in PreToolUse, PostToolUse, or SessionStart
  // dispatchers. A hook is "registered" if ANY dispatcher references it by
  // filename.
  const dispatcherCandidates = [
    path.join('source', 'hooks', 'cobolt-pre-dispatch.js'),
    path.join('.claude', 'hooks', 'cobolt-pre-dispatch.js'),
    path.join('source', 'hooks', 'cobolt-post-dispatch.js'),
    path.join('.claude', 'hooks', 'cobolt-post-dispatch.js'),
  ];
  let combined = '';
  for (const rel of dispatcherCandidates) {
    const abs = resolveFile(projectRoot, rel);
    if (!abs) continue;
    try {
      combined += `${fs.readFileSync(abs, 'utf8')}\n`;
    } catch {
      /* advisory */
    }
  }
  return hookList.map((h) => ({ ...h, registered: h.ok && combined.includes(h.name) }));
}

function collectGateTierEntries(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectGateTierEntries(item, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  if (typeof value.hook === 'string' || typeof value.tool === 'string') out.push(value);
  for (const child of Object.values(value)) collectGateTierEntries(child, out);
  return out;
}

function checkGateTierEntries(projectRoot) {
  const gateTiersPath = resolveFile(projectRoot, path.join('source', 'schemas', 'gate-tiers.json'));
  if (!gateTiersPath) {
    return REQUIRED_GATE_TIER_ENTRIES.map((name) => ({ name, ok: false, reason: 'gate-tiers-missing' }));
  }
  let allGates = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(gateTiersPath, 'utf8'));
    allGates = collectGateTierEntries(parsed);
  } catch (err) {
    return REQUIRED_GATE_TIER_ENTRIES.map((name) => ({ name, ok: false, reason: `gate-tiers-parse: ${err.message}` }));
  }
  return REQUIRED_GATE_TIER_ENTRIES.map((name) => {
    const entry = allGates.find((gate) => gate.hook === name || gate.tool === name);
    return {
      name,
      ok: Boolean(entry),
      status: entry?.status || null,
      enforcement: entry?.enforcement || null,
      path: gateTiersPath,
      reason: entry ? null : 'missing-gate-tier-entry',
    };
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

function checkBuildArtifacts(projectRoot) {
  const base = path.join(projectRoot, '_cobolt-output', 'latest', 'build');
  if (!fs.existsSync(base)) return { present: false, milestones: [] };
  const milestones = [];
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!/^M\d+$/i.test(entry.name)) continue;
      const milestoneDir = path.join(base, entry.name);
      const stories = [];
      try {
        for (const sub of fs.readdirSync(milestoneDir, { withFileTypes: true })) {
          if (!sub.isDirectory()) continue;
          if (!/^(?:STORY|S)-/i.test(sub.name)) continue;
          const storyDir = path.join(milestoneDir, sub.name);
          let roundCount = 0;
          try {
            roundCount = fs.readdirSync(storyDir).filter((f) => /round-\d+/.test(f)).length;
          } catch {}
          stories.push({ id: sub.name, roundCount });
        }
      } catch {}
      milestones.push({ id: entry.name, storyCount: stories.length, stories });
    }
  } catch {}
  return { present: true, base, milestones };
}

function checkStoryTracker(projectRoot) {
  const p = path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'story-tracker.json');
  if (!fs.existsSync(p)) return { ok: false, reason: 'not-found' };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const stories = data.stories || data.items || [];
    const expected = Array.isArray(data.expectedStoryIds) ? data.expectedStoryIds.length : 0;
    return {
      ok: true,
      storyCount: Array.isArray(stories) ? stories.length : Object.keys(stories).length,
      expectedStoryIds: expected,
    };
  } catch (err) {
    return { ok: false, reason: `parse-failed: ${err.message}` };
  }
}

function checkCurrentMilestone(projectRoot) {
  const p = path.join(projectRoot, 'cobolt-state.json');
  if (!fs.existsSync(p)) return { ok: false, reason: 'cobolt-state.json absent' };
  try {
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    const cur = s?.pipeline?.currentMilestone || s?.build?.currentMilestone || null;
    const stage = s?.pipeline?.currentStage || null;
    return { ok: true, currentMilestone: cur, currentStage: stage };
  } catch (err) {
    return { ok: false, reason: `parse-failed: ${err.message}` };
  }
}

function checkRecentFailures(projectRoot) {
  const auditDir = path.join(projectRoot, '_cobolt-output', 'audit');
  if (!fs.existsSync(auditDir)) return { any: false, records: [], ledgerCount: 0 };
  const BUILD_SET = new Set([
    'build-agent',
    'cobolt-build-agent',
    'backend-dev',
    'frontend-dev',
    'api-endpoint-builder',
    'db-migration-writer',
    'test-writer',
    'test-architect',
    'integration-test-agent',
    'db-test-agent',
    'elixir-component-builder',
    'liveview-builder',
    'graphql-builder',
    'ui-component-builder',
    'docker-builder',
    'devops-agent',
  ]);
  const records = [];
  for (const f of fs.readdirSync(auditDir)) {
    if (!/-failure(?:-[\w-]+)?\.json$/.test(f)) continue;
    const base = f.replace(/-failure(?:-[\w-]+)?\.json$/, '');
    if (!BUILD_SET.has(base)) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(auditDir, f), 'utf8'));
      records.push({
        file: f,
        agent: rec.agent,
        stage: rec.stage,
        story: rec.story,
        milestone: rec.milestone,
        round: rec.round,
        status: rec.status,
        error_class: rec.error_class,
        escalation_target: rec.escalation_target,
      });
    } catch {
      records.push({ file: f, error: 'parse-failed' });
    }
  }
  const ledger = path.join(auditDir, 'build-agent-failures.jsonl');
  let ledgerCount = 0;
  if (fs.existsSync(ledger)) {
    try {
      ledgerCount = fs
        .readFileSync(ledger, 'utf8')
        .split('\n')
        .filter((l) => l.trim()).length;
    } catch {}
  }
  return { any: records.length > 0, count: records.length, ledgerCount, records };
}

function severityFromChecks(report) {
  const missing = [
    ...report.tools.filter((t) => !t.ok),
    ...report.schemas.filter((s) => !s.ok),
    ...report.agents.filter((a) => !a.ok),
    ...report.hooks.filter((h) => !h.ok),
    ...report.gateTiers.filter((g) => !g.ok),
    ...report.steps.filter((s) => !s.ok),
  ];
  if (missing.length > 0) return { level: 'fail', issues: missing };
  const warnings = [];
  for (const h of report.hooks) {
    if (h.ok && !h.registered) warnings.push({ kind: 'hook-unregistered', item: h.name });
  }
  if (!report.storyTracker.ok) {
    warnings.push({ kind: 'story-tracker-missing', reason: report.storyTracker.reason });
  }
  if (!report.buildArtifacts.present) {
    warnings.push({ kind: 'no-build-run' });
  }
  if (report.recentFailures.any) {
    warnings.push({ kind: 'recent-failures', count: report.recentFailures.count });
  }
  for (const [k, v] of Object.entries(report.killSwitches)) {
    if (v == null) continue;
    const low = String(v).toLowerCase();
    if (low === 'off' || low === 'bypass' || low === '0' || low === 'disabled') {
      warnings.push({ kind: 'kill-switch-active', env: k, value: v });
    }
  }
  if (warnings.length > 0) return { level: 'warn', warnings };
  return { level: 'ok' };
}

function renderHuman(r) {
  const lines = [];
  const banner = r.summary.level === 'ok' ? 'ALL GREEN' : r.summary.level === 'warn' ? 'WARNINGS' : 'FAILURES';
  lines.push(`\n[build-doctor] ${banner}`);
  lines.push('');
  for (const cat of [
    ['Tools', r.tools],
    ['Schemas', r.schemas],
    ['Agents', r.agents],
    ['Sub-skill steps', r.steps],
  ]) {
    lines.push(`${cat[0]} (${cat[1].filter((x) => x.ok).length}/${cat[1].length}):`);
    for (const x of cat[1]) lines.push(`  ${x.ok ? '[OK]' : '[--]'} ${x.name}`);
    lines.push('');
  }
  lines.push('Step-invocation gates:');
  for (const g of r.gateTiers) {
    const detail = g.ok ? `${g.status || 'registered'} / ${g.enforcement || 'enforcement-unset'}` : g.reason;
    lines.push(`  ${g.ok ? '[OK]' : '[--]'} ${g.name.padEnd(38)} ${detail}`);
  }
  lines.push('');
  lines.push('Hooks (PreToolUse):');
  for (const h of r.hooks) {
    const reg = h.registered ? 'registered' : 'NOT registered';
    lines.push(`  ${h.ok ? '[OK]' : '[--]'} ${h.name.padEnd(38)} ${reg}`);
  }
  lines.push('');
  lines.push('Current pipeline state:');
  if (r.currentMilestone.ok) {
    lines.push(
      `  milestone=${r.currentMilestone.currentMilestone || '-'} stage=${r.currentMilestone.currentStage || '-'}`,
    );
  } else {
    lines.push(`  [--] ${r.currentMilestone.reason}`);
  }
  lines.push('');
  lines.push('Story tracker:');
  if (r.storyTracker.ok) {
    lines.push(`  [OK] ${r.storyTracker.storyCount} stories, ${r.storyTracker.expectedStoryIds} expected IDs`);
  } else {
    lines.push(`  [--] ${r.storyTracker.reason}`);
  }
  lines.push('');
  lines.push('Build artifacts:');
  if (r.buildArtifacts.present) {
    for (const m of r.buildArtifacts.milestones) {
      lines.push(`  [OK] ${m.id}: ${m.storyCount} stories`);
    }
  } else {
    lines.push('  [--] no build artifacts yet');
  }
  lines.push('');
  lines.push('Recent failures:');
  if (r.recentFailures.any) {
    for (const rec of r.recentFailures.records) {
      lines.push(`  [!!] ${rec.file}: ${rec.agent} ${rec.status} (${rec.error_class}) → ${rec.escalation_target}`);
    }
    lines.push(`  ledger: ${r.recentFailures.ledgerCount} total breadcrumbs`);
  } else {
    lines.push('  [OK] none');
  }
  lines.push('');
  lines.push('Kill switches:');
  const active = Object.entries(r.killSwitches).filter(([, v]) => v != null);
  if (active.length === 0) lines.push('  (none set)');
  else for (const [k, v] of active) lines.push(`  ${k}=${v}`);
  lines.push('');
  if (r.summary.level !== 'ok') {
    lines.push('Next action:');
    if (r.summary.level === 'fail') {
      lines.push('  Restore missing files with: node bin/install.js --claude --global --link');
    } else if (r.summary.warnings?.some((w) => w.kind === 'no-build-run')) {
      lines.push('  Run /cobolt-build M1 --auto to start building.');
    } else if (r.summary.warnings?.some((w) => w.kind === 'recent-failures')) {
      lines.push('  Review failure records under _cobolt-output/audit/ and re-dispatch via build-lead.');
    } else {
      lines.push('  Review warnings above. Most are advisory.');
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function run(flags) {
  const projectRoot = flags.dir ? path.resolve(flags.dir) : process.cwd();
  const hooks = checkHookRegistration(projectRoot, checkPresence(projectRoot, 'hooks'));
  const report = {
    generatedAt: new Date().toISOString(),
    projectRoot,
    tools: checkPresence(projectRoot, 'tools'),
    schemas: checkPresence(projectRoot, 'schemas'),
    agents: checkPresence(projectRoot, 'agents'),
    hooks,
    gateTiers: checkGateTierEntries(projectRoot),
    steps: checkPresence(projectRoot, 'steps'),
    killSwitches: checkKillSwitches(),
    buildArtifacts: checkBuildArtifacts(projectRoot),
    storyTracker: checkStoryTracker(projectRoot),
    currentMilestone: checkCurrentMilestone(projectRoot),
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
  const parsed = parseArgs(argv);
  const cmd = parsed.positional[0] || 'check';
  if (cmd === 'check') return run(parsed.flags);
  if (cmd === '--help' || cmd === '-h') {
    process.stdout.write('usage: cobolt-build-doctor check [--dir <path>] [--json]\n');
    return 0;
  }
  process.stderr.write(`unknown subcommand: ${cmd}\n`);
  return 2;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  REQUIRED_TOOLS,
  REQUIRED_SCHEMAS,
  REQUIRED_AGENTS,
  REQUIRED_HOOKS,
  REQUIRED_GATE_TIER_ENTRIES,
  BUILD_STEPS,
  KILL_SWITCH_ENVS,
  checkPresence,
  checkHookRegistration,
  checkGateTierEntries,
  checkKillSwitches,
  checkBuildArtifacts,
  checkStoryTracker,
  checkCurrentMilestone,
  checkRecentFailures,
  severityFromChecks,
  run,
  main,
};
