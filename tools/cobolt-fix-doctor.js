#!/usr/bin/env node

// CoBolt Fix Doctor (v0.22.8) — full-stack diagnostic for the fix pipeline.
// Answers "why is the fix loop stuck / why is the plateau gate blocking me?"
// with a single structured report.
//
// Checks (in order):
//   1. Tool presence — fix tools + validators + failure-record writer
//   2. Schema presence — finding-tracker, fix-report
//   3. Agent presence — 16 fix-phase agents
//   4. Hook presence + registration — fix-specific gates
//   5. Sub-skill presence — cobolt-fix + cobolt-resolve + cobolt-hotfix
//   6. Kill-switch state — fix-relevant env flags
//   7. Fix iteration state — active finding count, phantom rate, plateau signature
//   8. Dead-ends ledger — how many dead-ends recorded this run
//   9. Recent failure records — fix-agent-failures ledger

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_TOOLS = [
  'cobolt-fix-router.js',
  'cobolt-fix-readiness.js',
  'cobolt-fix-verdict.js',
  'cobolt-fix-task-manifest.js',
  'cobolt-fix-loop-plateau.js',
  'cobolt-fix-decay.js',
  'cobolt-dead-ends.js',
  'cobolt-rca-diff.js',
  'cobolt-plateau-rollup.js',
  'cobolt-findings.js',
  'cobolt-self-critique.js',
  'cobolt-agent-failure-review.js',
  'cobolt-fix-failure-record.js',
];

const REQUIRED_SCHEMAS = ['finding-tracker.schema.json'];

const REQUIRED_AGENTS = [
  'fix-agent.md',
  'fix-lead.md',
  'cobolt-fix-agent.md',
  'cobolt-fix-lead.md',
  'backend-fix.md',
  'frontend-fix.md',
  'compliance-fix.md',
  'db-fix.md',
  'cobolt-backend-fix.md',
  'cobolt-frontend-fix.md',
  'cobolt-compliance-fix.md',
  'cobolt-db-fix.md',
  'hotfix-agent.md',
  'cobolt-hotfix-agent.md',
  'architect-fix-agent.md',
  'resolve-lead.md',
];

const REQUIRED_HOOKS = [
  'cobolt-fix-checkpoint-required.js',
  'cobolt-plateau-escalation-gate.js',
  'cobolt-phantom-rate-enforcer.js',
  'cobolt-phantom-gate.js',
  'cobolt-phantom-dispatch-gate.js',
];

const REQUIRED_SUBSKILLS = ['cobolt-fix', 'cobolt-resolve', 'cobolt-hotfix'];

const KILL_SWITCH_ENVS = [
  'COBOLT_PHANTOM_RATE_GATE',
  'COBOLT_PLATEAU_ESCALATION_GATE',
  'COBOLT_FIX_CHECKPOINT_REQUIRED',
  'COBOLT_PHANTOM_GATE',
  'COBOLT_PHANTOM_DISPATCH_GATE',
  'COBOLT_V12_GATES',
  'COBOLT_AUTONOMOUS',
  'COBOLT_AUTO',
  'LOOP_PIVOT',
  'LOOP_ARCH_ESCALATE',
];

const FIX_AGENT_SET = new Set(REQUIRED_AGENTS.map((f) => f.replace(/\.md$/, '')));

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
  const cfg = {
    tools: { paths: ['tools'], items: REQUIRED_TOOLS },
    schemas: { paths: ['source/schemas', '.claude/schemas'], items: REQUIRED_SCHEMAS },
    agents: { paths: ['source/agents', '.claude/agents'], items: REQUIRED_AGENTS },
    hooks: { paths: ['source/hooks', '.claude/hooks'], items: REQUIRED_HOOKS },
  }[category];
  if (!cfg) return [];
  return cfg.items.map((name) => {
    let found = null;
    for (const p of cfg.paths) {
      const abs = resolveFile(projectRoot, path.join(p, name));
      if (abs) {
        found = abs;
        break;
      }
    }
    return { name, ok: Boolean(found), path: found || path.join(cfg.paths[0], name) };
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

function checkHookRegistration(projectRoot, hookList) {
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
    } catch {}
  }
  return hookList.map((h) => ({ ...h, registered: h.ok && combined.includes(h.name) }));
}

function checkKillSwitches() {
  const out = {};
  for (const env of KILL_SWITCH_ENVS) {
    const val = process.env[env];
    out[env] = val == null ? null : String(val);
  }
  return out;
}

function checkFixIterationState(projectRoot) {
  const base = path.join(projectRoot, '_cobolt-output', 'latest', 'fix');
  const out = { base, iterations: 0, lastIteration: null };
  if (!fs.existsSync(base)) {
    out.reason = 'no fix iterations yet';
    return out;
  }
  try {
    const entries = fs.readdirSync(base);
    const iterFiles = entries.filter((f) => /^iteration-\d+/.test(f) || /^verification-iter-\d+/.test(f));
    out.iterations = iterFiles.length;
    if (iterFiles.length > 0) {
      iterFiles.sort();
      out.lastIteration = iterFiles[iterFiles.length - 1];
    }
  } catch (err) {
    out.reason = `read-failed: ${err.message}`;
  }
  return out;
}

function checkDeadEnds(projectRoot) {
  const p = path.join(projectRoot, '_cobolt-output', 'latest', 'fix', 'dead-ends.jsonl');
  if (!fs.existsSync(p)) return { present: false, count: 0 };
  try {
    const txt = fs.readFileSync(p, 'utf8');
    return { present: true, count: txt.split('\n').filter((l) => l.trim()).length };
  } catch {
    return { present: false, count: 0 };
  }
}

function checkFindings(projectRoot) {
  const candidates = [
    path.join(projectRoot, '_cobolt-output', 'latest', 'fix', 'finding-tracker.json'),
    path.join(projectRoot, '_cobolt-output', 'latest', 'review', 'review-findings.json'),
    path.join(projectRoot, '_cobolt-output', 'latest', 'review', 'verified-findings.json'),
    path.join(projectRoot, '_cobolt-output', 'latest', 'review', 'findings.json'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      const findings = data.findings || data.items || [];
      const list = Array.isArray(findings) ? findings : [];
      const openCount = list.filter((f) => {
        const status = (f.status || '').toLowerCase();
        return (
          status === 'open' ||
          status === '' ||
          status === 'pending' ||
          status === 'assigned' ||
          status === 'fix-applied' ||
          status === 'fix-applied-unverified' ||
          status === 'fix-applied-failing' ||
          status === 'fix-applied-no-test' ||
          status === 'stalled'
        );
      }).length;
      const fixedCount = list.filter((f) => {
        const status = (f.status || '').toLowerCase();
        return status === 'fixed' || status === 'resolved' || status === 'verified-resolved';
      }).length;
      return {
        present: true,
        path: p,
        total: list.length,
        open: openCount,
        fixed: fixedCount,
      };
    } catch (err) {
      return { present: false, reason: err.message };
    }
  }
  return { present: false, reason: 'no findings file' };
}

function checkRecentFailures(projectRoot) {
  const auditDir = path.join(projectRoot, '_cobolt-output', 'audit');
  if (!fs.existsSync(auditDir)) return { any: false, records: [], ledgerCount: 0 };
  const records = [];
  for (const f of fs.readdirSync(auditDir)) {
    if (!/-failure(?:-[\w-]+)?\.json$/.test(f)) continue;
    const base = f.replace(/-failure(?:-[\w-]+)?\.json$/, '');
    if (!FIX_AGENT_SET.has(base)) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(auditDir, f), 'utf8'));
      records.push({
        file: f,
        agent: rec.agent,
        stage: rec.stage,
        finding: rec.finding,
        iteration: rec.iteration,
        status: rec.status,
        error_class: rec.error_class,
        escalation_target: rec.escalation_target,
      });
    } catch {
      records.push({ file: f, error: 'parse-failed' });
    }
  }
  const ledger = path.join(auditDir, 'fix-agent-failures.jsonl');
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
    ...report.subskills.filter((s) => !s.ok),
    ...report.hooks.filter((h) => !h.ok),
  ];
  if (missing.length > 0) return { level: 'fail', issues: missing };
  const warnings = [];
  for (const h of report.hooks) {
    if (h.ok && !h.registered) warnings.push({ kind: 'hook-unregistered', item: h.name });
  }
  if (!report.findings.present && report.iterationState.iterations === 0) {
    warnings.push({ kind: 'no-fix-run' });
  }
  if (report.findings.present && report.findings.open > 0) {
    warnings.push({ kind: 'open-findings', count: report.findings.open });
  }
  if (report.recentFailures.any) {
    warnings.push({ kind: 'recent-failures', count: report.recentFailures.count });
  }
  if (report.deadEnds.count > 5) {
    warnings.push({ kind: 'many-dead-ends', count: report.deadEnds.count });
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
  lines.push(`\n[fix-doctor] ${banner}`);
  lines.push('');
  for (const cat of [
    ['Tools', r.tools],
    ['Schemas', r.schemas],
    ['Agents', r.agents],
    ['Sub-skills', r.subskills],
  ]) {
    lines.push(`${cat[0]} (${cat[1].filter((x) => x.ok).length}/${cat[1].length}):`);
    for (const x of cat[1]) lines.push(`  ${x.ok ? '[OK]' : '[--]'} ${x.name}`);
    lines.push('');
  }
  lines.push('Hooks (PreToolUse):');
  for (const h of r.hooks) {
    const reg = h.registered ? 'registered' : 'NOT registered';
    lines.push(`  ${h.ok ? '[OK]' : '[--]'} ${h.name.padEnd(38)} ${reg}`);
  }
  lines.push('');
  lines.push('Fix iteration state:');
  if (r.iterationState.reason) {
    lines.push(`  ${r.iterationState.reason}`);
  } else {
    lines.push(`  [OK] ${r.iterationState.iterations} iteration(s), last=${r.iterationState.lastIteration || '-'}`);
  }
  lines.push('');
  lines.push('Dead-ends:');
  if (r.deadEnds.present) {
    const tag = r.deadEnds.count > 5 ? '[!!]' : '[OK]';
    lines.push(`  ${tag} ${r.deadEnds.count} recorded`);
  } else {
    lines.push('  (no dead-ends.jsonl)');
  }
  lines.push('');
  lines.push('Findings:');
  if (r.findings.present) {
    lines.push(`  [OK] ${r.findings.total} total — ${r.findings.open} open, ${r.findings.fixed} fixed`);
  } else {
    lines.push(`  [--] ${r.findings.reason || 'no findings file'}`);
  }
  lines.push('');
  lines.push('Recent failures:');
  if (r.recentFailures.any) {
    for (const rec of r.recentFailures.records) {
      lines.push(`  [!!] ${rec.file}: ${rec.agent} ${rec.status} (${rec.error_class}) → ${rec.escalation_target}`);
    }
    lines.push(`  ledger: ${r.recentFailures.ledgerCount} breadcrumbs`);
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
    } else if (r.summary.warnings?.some((w) => w.kind === 'no-fix-run')) {
      lines.push('  Run /cobolt-fix to start a fix loop.');
    } else if (r.summary.warnings?.some((w) => w.kind === 'many-dead-ends')) {
      lines.push(
        '  Plateau likely — review _cobolt-output/latest/fix/dead-ends.jsonl and consider LOOP_ARCH_ESCALATE.',
      );
    } else if (r.summary.warnings?.some((w) => w.kind === 'recent-failures')) {
      lines.push('  Review failure records and re-dispatch via fix-lead.');
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
    subskills: checkSubskillPresence(projectRoot),
    hooks,
    killSwitches: checkKillSwitches(),
    iterationState: checkFixIterationState(projectRoot),
    deadEnds: checkDeadEnds(projectRoot),
    findings: checkFindings(projectRoot),
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
  if (parsed.flags.help || parsed.flags.h) {
    process.stdout.write('usage: cobolt-fix-doctor check [--dir <path>] [--json]\n');
    return 0;
  }
  const cmd = parsed.positional[0] || 'check';
  if (cmd === 'check') return run(parsed.flags);
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
  REQUIRED_SUBSKILLS,
  REQUIRED_HOOKS,
  KILL_SWITCH_ENVS,
  checkPresence,
  checkSubskillPresence,
  checkHookRegistration,
  checkKillSwitches,
  checkFixIterationState,
  checkDeadEnds,
  checkFindings,
  checkRecentFailures,
  severityFromChecks,
  run,
  main,
};
