#!/usr/bin/env node

// CoBolt Brownfield Doctor (v0.22.8) — full-stack diagnostic for the
// brownfield (reverse-engineering + legacy modernization) pipeline.
// Mirrors arch-doctor / plan-doctor / build-doctor / fix-doctor.

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_TOOLS = [
  'cobolt-brownfield-readiness-gate.js',
  'cobolt-brownfield-bootstrap.js',
  'cobolt-brownfield-planning-sync.js',
  'cobolt-brownfield-exec-report.js',
  'cobolt-brownfield-accuracy-review.js',
  'cobolt-brownfield-evidence-index.js',
  'cobolt-brownfield-failure-record.js',
  'cobolt-brownfield-contracts.js',
];

const REQUIRED_SCHEMAS = ['cobolt-state.schema.json', 'brownfield-contracts.schema.json'];

const REQUIRED_AGENTS = [
  'brownfield-lead.md',
  'reverse-eng-lead.md',
  'legacy-intake-agent.md',
  'legacy-doc-generator-agent.md',
  'code-archaeologist-agent.md',
  'db-archaeologist-agent.md',
  'ui-archaeologist-agent.md',
  'config-archaeologist-agent.md',
  'binary-analyst-agent.md',
  'tech-stack-detector-agent.md',
  'rule-extractor-agent.md',
  'rule-validator-agent.md',
  'calculation-extractor-agent.md',
  'decision-table-builder-agent.md',
  'state-machine-recoverer-agent.md',
  'validation-cataloger-agent.md',
  'access-auditor-agent.md',
  'data-store-discovery-agent.md',
  'infra-discovery-agent.md',
  'integration-discovery-agent.md',
  'protocol-analyst-agent.md',
  'feature-triage-agent.md',
  'modernization-agent.md',
  'migration-strategist-agent.md',
  'data-migration-planner-agent.md',
  'parity-test-designer-agent.md',
];

const REQUIRED_HOOKS = [
  'cobolt-brownfield-scope-gate.js',
  'cobolt-brownfield-concurrency-gate.js',
  'cobolt-brownfield-artifact-verifier.js',
];

const REQUIRED_SUBSKILLS = ['cobolt-brownfield'];

const KILL_SWITCH_ENVS = [
  'COBOLT_BROWNFIELD_SCOPE_GATE',
  'COBOLT_BROWNFIELD_CONCURRENCY_GATE',
  'COBOLT_BROWNFIELD_ARTIFACT_VERIFIER',
  'COBOLT_V12_GATES',
  'COBOLT_AUTONOMOUS',
  'COBOLT_AUTO',
];

const BROWNFIELD_AGENT_SET = new Set(REQUIRED_AGENTS.map((f) => f.replace(/\.md$/, '')));

function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else {
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
  const candidates = [
    path.join('source', 'hooks', 'cobolt-pre-dispatch.js'),
    path.join('.claude', 'hooks', 'cobolt-pre-dispatch.js'),
    path.join('source', 'hooks', 'cobolt-post-dispatch.js'),
    path.join('.claude', 'hooks', 'cobolt-post-dispatch.js'),
  ];
  let combined = '';
  for (const rel of candidates) {
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

function checkBrownfieldArtifacts(projectRoot) {
  const base = path.join(projectRoot, '_cobolt-output', 'latest', 'brownfield');
  if (!fs.existsSync(base)) return { present: false, reason: 'brownfield/ absent — no scan has run' };
  const sentinels = ['00-source-file-manifest.json', '04-feature-and-module-inventory.md', '23-master-assessment.md'];
  const found = sentinels.filter((f) => fs.existsSync(path.join(base, f)));
  let artifactCount = 0;
  try {
    artifactCount = fs.readdirSync(base).filter((f) => /^\d{2,}-/.test(f)).length;
  } catch {}
  return {
    present: true,
    base,
    sentinelsFound: found,
    sentinelsExpected: sentinels.length,
    artifactCount,
  };
}

function checkPhaseState(projectRoot) {
  const p = path.join(projectRoot, 'cobolt-state.json');
  if (!fs.existsSync(p)) return { ok: false, reason: 'cobolt-state.json absent' };
  try {
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    const bf = s?.brownfield || {};
    return {
      ok: true,
      scanMode: bf.scanMode || null,
      currentPhase: bf.currentPhase || null,
      lastArtifact: bf.lastArtifact || null,
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function checkRecentFailures(projectRoot) {
  const auditDir = path.join(projectRoot, '_cobolt-output', 'audit');
  if (!fs.existsSync(auditDir)) return { any: false, records: [], ledgerCount: 0 };
  const records = [];
  for (const f of fs.readdirSync(auditDir)) {
    if (!/-failure(?:-[\w-]+)?\.json$/.test(f)) continue;
    const base = f.replace(/-failure(?:-[\w-]+)?\.json$/, '');
    if (!BROWNFIELD_AGENT_SET.has(base)) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(auditDir, f), 'utf8'));
      records.push({
        file: f,
        agent: rec.agent,
        stage: rec.stage,
        artifact: rec.artifact,
        status: rec.status,
        error_class: rec.error_class,
        escalation_target: rec.escalation_target,
      });
    } catch {
      records.push({ file: f, error: 'parse-failed' });
    }
  }
  const ledger = path.join(auditDir, 'brownfield-agent-failures.jsonl');
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

function severityFromChecks(r) {
  const missing = [
    ...r.tools.filter((t) => !t.ok),
    ...r.schemas.filter((s) => !s.ok),
    ...r.agents.filter((a) => !a.ok),
    ...r.subskills.filter((s) => !s.ok),
    ...r.hooks.filter((h) => !h.ok),
  ];
  if (missing.length > 0) return { level: 'fail', issues: missing };
  const warnings = [];
  for (const h of r.hooks) {
    if (h.ok && !h.registered) warnings.push({ kind: 'hook-unregistered', item: h.name });
  }
  if (!r.artifacts.present) warnings.push({ kind: 'no-brownfield-run' });
  if (r.recentFailures.any) warnings.push({ kind: 'recent-failures', count: r.recentFailures.count });
  for (const [k, v] of Object.entries(r.killSwitches)) {
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
  lines.push(`\n[brownfield-doctor] ${banner}`);
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
  lines.push('Hooks:');
  for (const h of r.hooks) {
    const reg = h.registered ? 'registered' : 'NOT registered';
    lines.push(`  ${h.ok ? '[OK]' : '[--]'} ${h.name.padEnd(44)} ${reg}`);
  }
  lines.push('');
  lines.push('Phase state:');
  if (r.phaseState.ok) {
    lines.push(
      `  scanMode=${r.phaseState.scanMode || '-'} phase=${r.phaseState.currentPhase || '-'} lastArtifact=${r.phaseState.lastArtifact || '-'}`,
    );
  } else {
    lines.push(`  [--] ${r.phaseState.reason}`);
  }
  lines.push('');
  lines.push('Brownfield artifacts:');
  if (r.artifacts.present) {
    lines.push(
      `  [OK] ${r.artifacts.artifactCount} artifact(s), ${r.artifacts.sentinelsFound.length}/${r.artifacts.sentinelsExpected} sentinels present`,
    );
  } else {
    lines.push(`  [--] ${r.artifacts.reason}`);
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
    } else if (r.summary.warnings?.some((w) => w.kind === 'no-brownfield-run')) {
      lines.push('  Run /cobolt-brownfield . --scan deep to start a reverse-engineering pass.');
    } else if (r.summary.warnings?.some((w) => w.kind === 'recent-failures')) {
      lines.push('  Review failure records and re-dispatch via brownfield-lead.');
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
    artifacts: checkBrownfieldArtifacts(projectRoot),
    phaseState: checkPhaseState(projectRoot),
    recentFailures: checkRecentFailures(projectRoot),
  };
  report.summary = severityFromChecks(report);
  if (flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(renderHuman(report));
  if (report.summary.level === 'fail') return 2;
  if (report.summary.level === 'warn') return 1;
  return 0;
}

function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const cmd = parsed.positional[0] || 'check';
  if (cmd === 'check') return run(parsed.flags);
  if (cmd === '--help' || cmd === '-h') {
    process.stdout.write('usage: cobolt-brownfield-doctor check [--dir <path>] [--json]\n');
    return 0;
  }
  process.stderr.write(`unknown subcommand: ${cmd}\n`);
  return 2;
}

if (require.main === module) process.exit(main());

module.exports = {
  REQUIRED_TOOLS,
  REQUIRED_SCHEMAS,
  REQUIRED_AGENTS,
  REQUIRED_SUBSKILLS,
  REQUIRED_HOOKS,
  KILL_SWITCH_ENVS,
  checkPresence,
  checkHookRegistration,
  checkKillSwitches,
  checkBrownfieldArtifacts,
  checkPhaseState,
  checkRecentFailures,
  severityFromChecks,
  run,
  main,
};
