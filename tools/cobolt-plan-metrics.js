#!/usr/bin/env node

// CoBolt plan-metrics aggregator (Ship 1, v0.54+).
//
// Read-only aggregator over existing audit JSONLs and planning artifacts.
// Reports debt ratio, coverage score, escalation count, phantom rate,
// plan-fix convergence, phase progression. Emits both machine-readable
// (plan-metrics.json) and human-readable (plan-metrics-report.md) output.
//
// User-stated success target: criticalDebtRatio < 1%.
//
// CLI:
//   node tools/cobolt-plan-metrics.js report [--json] [--md]
//   node tools/cobolt-plan-metrics.js summary
//   node tools/cobolt-plan-metrics.js --help
//
// Exit codes (per tools/CLAUDE.md contract):
//   0 = success (metrics computed and emitted)
//   1 = misuse / hard error
//   3 = missing infrastructure (no _cobolt-output found)
//
// Read-only: no kill-switch needed. Inputs are all best-effort — every
// missing file is treated as "no signal", never an error.

const fs = require('node:fs');
const path = require('node:path');

const { getPlanningDir } = require('../lib/cobolt-planning-artifacts');

const AUDIT_FILES = {
  gateSkipLog: 'gate-skip-log.jsonl',
  escalationLog: 'escalation-log.jsonl',
  planFixIterations: 'plan-fix-iterations.jsonl',
  planningDebt: 'planning-debt.jsonl',
  phantomScores: 'phantom-agent-scores.json',
  phantomDispatch: 'phantom-dispatch.jsonl',
  checkpointDebtGate: 'checkpoint-debt-gate.jsonl',
  buildToPlanFeedback: 'build-to-plan-feedback.jsonl',
};

function parseArgs(argv) {
  const out = { command: null, json: false, md: false, target: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'report' || arg === 'summary') {
      out.command = arg;
    } else if (arg === '--json') {
      out.json = true;
    } else if (arg === '--md') {
      out.md = true;
    } else if (arg === '--target') {
      out.target = argv[++i] || null;
    } else if (arg === '--out') {
      out.out = argv[++i] || null;
    } else if (arg === '--help' || arg === '-h') {
      out.command = 'help';
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    [
      'cobolt-plan-metrics — read-only aggregator over CoBolt audit logs and planning artifacts',
      '',
      'Usage:',
      '  node tools/cobolt-plan-metrics.js report [--json|--md] [--target <root>] [--out <path>]',
      '  node tools/cobolt-plan-metrics.js summary [--target <root>]',
      '',
      'Default report writes both:',
      '  _cobolt-output/latest/planning/plan-metrics.json',
      '  _cobolt-output/latest/planning/plan-metrics-report.md',
      '',
      'Metrics emitted:',
      '  criticalDebtRatio   — open critical debt / total findings (target <1%)',
      '  coverageScore       — weighted FR + NFR + TR + source coverage',
      '  escalationCount     — events per escalation rung (planning-lead, recovery-advisor, halt)',
      '  phantomRate         — max + mean per-agent phantom-return rate',
      '  planFixConvergence  — iterations where verdict reached clean / total iterations',
      '  phaseProgression    — current phase + checkpoint completeness (1, 2, 3, 4, 4.5, 5)',
      '',
      'Exit codes:',
      '  0  metrics computed and emitted',
      '  1  misuse / hard error',
      '  3  no _cobolt-output found (nothing to aggregate)',
      '',
    ].join('\n'),
  );
}

function readJsonlBestEffort(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readJsonBestEffort(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function computeDebtRatio(auditDir) {
  const debtEntries = readJsonlBestEffort(path.join(auditDir, AUDIT_FILES.planningDebt));
  const open = debtEntries.filter((e) => e?.resolved !== true);
  const critical = open.filter((e) => {
    const cls = String(e?.failureClass || '').toLowerCase();
    return cls.includes('critical') || cls === 'planning-content-quality';
  });
  // Approximate total-findings denominator from plan-fix iteration repair counts.
  const fixIters = readJsonlBestEffort(path.join(auditDir, AUDIT_FILES.planFixIterations));
  const totalFindingsEverSeen = fixIters.reduce((acc, e) => acc + (Number(e?.findings) || 0), 0);
  const denominator = Math.max(totalFindingsEverSeen, debtEntries.length, 1);
  const ratio = denominator > 0 ? (critical.length / denominator) * 100 : 0;
  return {
    openDebtEntries: open.length,
    criticalDebtEntries: critical.length,
    resolvedDebtEntries: debtEntries.length - open.length,
    totalFindingsCorpus: totalFindingsEverSeen,
    criticalDebtRatio: Math.round(ratio * 100) / 100,
    targetThreshold: 1.0,
    withinTarget: ratio < 1.0,
  };
}

function computeCoverageScore(planningDir) {
  if (!planningDir || !fs.existsSync(planningDir)) {
    return { weighted: null, components: null, reason: 'planning directory not found' };
  }
  // FR coverage from rtm.json: open the source-coverage-report if present (richer)
  // and fall back to a direct rtm scan.
  const sourceReport = readJsonBestEffort(path.join(planningDir, 'source-coverage-report.json'));
  const rtm = readJsonBestEffort(path.join(planningDir, 'rtm.json'));

  const components = {};

  if (sourceReport && typeof sourceReport.coverage === 'number') {
    components.sourceCoverage = sourceReport.coverage;
  }

  if (rtm) {
    const reqs = rtm.requirements || {};
    const counts = { FR: 0, NFR: 0, TR: 0, IR: 0 };
    for (const id of Object.keys(reqs)) {
      const m = String(id).match(/^([A-Z]{2,4})-/);
      if (m && counts[m[1]] !== undefined) counts[m[1]] += 1;
    }
    components.requirementBreakdown = counts;
  }

  // Plan-review verdict gives a direct quality signal — clean=100, advisory=85, critical=50
  const verdict = readJsonBestEffort(path.join(planningDir, 'plan-review-verdict.json'));
  if (verdict?.verdict?.status) {
    const map = { clean: 100, advisory: 85, critical: 50 };
    components.planReviewQuality = map[verdict.verdict.status] ?? null;
  }

  // FR-epic coverage report (if cached) — direct percentage
  const frEpicCacheCandidates = [
    path.join(planningDir, 'fr-epic-coverage.json'),
    path.join(planningDir, '..', 'audit', 'fr-epic-coverage.json'),
  ];
  for (const p of frEpicCacheCandidates) {
    const cached = readJsonBestEffort(p);
    if (cached && typeof cached.coverage === 'number') {
      components.frEpicCoverage = cached.coverage;
      break;
    }
  }

  // Weighted average across whatever components are present.
  const weights = {
    sourceCoverage: 0.3,
    frEpicCoverage: 0.3,
    planReviewQuality: 0.4,
  };
  let totalWeight = 0;
  let weightedSum = 0;
  for (const [k, w] of Object.entries(weights)) {
    if (typeof components[k] === 'number') {
      weightedSum += components[k] * w;
      totalWeight += w;
    }
  }
  const weighted = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 100) / 100 : null;
  return { weighted, components, weights };
}

function computeEscalationCount(auditDir) {
  const events = readJsonlBestEffort(path.join(auditDir, AUDIT_FILES.escalationLog));
  const byRung = { rung1_planningLead: 0, rung2_recoveryAdvisor: 0, rung3_halt: 0, other: 0 };
  for (const e of events) {
    const target = String(e?.escalation_target || e?.escalationTarget || '').toLowerCase();
    const rung = Number(e?.rung);
    if (target.includes('planning-lead') || rung === 1) byRung.rung1_planningLead += 1;
    else if (target.includes('recovery-advisor') || rung === 2) byRung.rung2_recoveryAdvisor += 1;
    else if (target.includes('halt') || rung === 3 || /human-review/.test(String(e?.action || '').toLowerCase())) {
      byRung.rung3_halt += 1;
    } else {
      byRung.other += 1;
    }
  }
  return { ...byRung, totalEvents: events.length };
}

function computePhantomRate(auditDir) {
  const scoreFile = readJsonBestEffort(path.join(auditDir, AUDIT_FILES.phantomScores));
  const dispatches = readJsonlBestEffort(path.join(auditDir, AUDIT_FILES.phantomDispatch));
  if (!scoreFile && dispatches.length === 0) {
    return { perAgent: {}, max: 0, mean: 0, agentsOverThreshold: [], threshold: 0.8 };
  }
  const perAgent = {};
  if (scoreFile && typeof scoreFile === 'object') {
    for (const [agent, scoreObj] of Object.entries(scoreFile)) {
      if (typeof scoreObj === 'number') perAgent[agent] = scoreObj;
      else if (scoreObj && typeof scoreObj === 'object') {
        const rate = scoreObj.phantomRate ?? scoreObj.rate ?? scoreObj.phantom ?? 0;
        if (typeof rate === 'number') perAgent[agent] = rate;
      }
    }
  }
  // Augment with dispatch-derived rate where missing.
  const dispatchByAgent = new Map();
  for (const d of dispatches) {
    const agent = String(d?.agent || 'unknown');
    const isPhantom = d?.phantom === true || d?.toolCount === 0;
    const cur = dispatchByAgent.get(agent) || { total: 0, phantom: 0 };
    cur.total += 1;
    if (isPhantom) cur.phantom += 1;
    dispatchByAgent.set(agent, cur);
  }
  for (const [agent, { total, phantom }] of dispatchByAgent.entries()) {
    if (perAgent[agent] === undefined && total > 0) {
      perAgent[agent] = Math.round((phantom / total) * 1000) / 1000;
    }
  }
  const rates = Object.values(perAgent);
  const max = rates.length ? Math.max(...rates) : 0;
  const mean = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
  const threshold = 0.8;
  const agentsOverThreshold = Object.entries(perAgent)
    .filter(([, rate]) => rate > threshold)
    .map(([agent]) => agent);
  return {
    perAgent,
    max: Math.round(max * 1000) / 1000,
    mean: Math.round(mean * 1000) / 1000,
    agentsOverThreshold,
    threshold,
  };
}

function computePlanFixConvergence(auditDir, planningDir) {
  const iterations = readJsonlBestEffort(path.join(auditDir, AUDIT_FILES.planFixIterations));
  const summary = planningDir ? readJsonBestEffort(path.join(planningDir, 'plan-fix-summary.json')) : null;
  if (iterations.length === 0 && !summary) {
    return { totalRuns: 0, convergedRuns: 0, convergenceRate: null, avgIterationsPerRun: null };
  }
  // Group iterations by run (use timestamp/run-id heuristic). Simplest: count
  // any iteration entry where status is 'converged' or 'clean'.
  let converged = 0;
  for (const it of iterations) {
    const status = String(it?.status || '').toLowerCase();
    if (status === 'converged' || status === 'clean') converged += 1;
  }
  const totalRuns = iterations.length;
  return {
    totalRuns,
    convergedRuns: converged,
    convergenceRate: totalRuns > 0 ? Math.round((converged / totalRuns) * 1000) / 10 : null,
    avgIterationsPerRun: summary?.avgIterations ?? null,
    finalSummaryStatus: summary?.status ?? null,
  };
}

function computePhaseProgression(planningDir) {
  if (!planningDir || !fs.existsSync(planningDir)) {
    return { current: null, complete: [], pending: [] };
  }
  const checkpointsDir = path.join(planningDir, 'checkpoints');
  if (!fs.existsSync(checkpointsDir)) {
    return { current: null, complete: [], pending: ['1', '2', '3', '4', '4-5', '5'] };
  }
  const files = fs.readdirSync(checkpointsDir).filter((f) => /^phase[\d-]+-.+\.json$/.test(f));
  const phaseLabels = ['1', '2', '3', '4', '4-5', '5'];
  const complete = [];
  for (const label of phaseLabels) {
    const found = files.find((f) => new RegExp(`^phase${label}-`).test(f));
    if (found) complete.push(label);
  }
  const pending = phaseLabels.filter((p) => !complete.includes(p));
  const current = complete.length > 0 ? complete[complete.length - 1] : null;
  return { current, complete, pending, totalCheckpoints: files.length };
}

function computeGateSkipBypasses(auditDir) {
  const events = readJsonlBestEffort(path.join(auditDir, AUDIT_FILES.gateSkipLog));
  const perGate = {};
  for (const e of events) {
    const gate = String(e?.hook || e?.gate || 'unknown');
    perGate[gate] = (perGate[gate] || 0) + 1;
  }
  return { perGate, totalSkips: events.length };
}

function computeCheckpointDebtBlocks(auditDir) {
  const events = readJsonlBestEffort(path.join(auditDir, AUDIT_FILES.checkpointDebtGate));
  const blocks = events.filter((e) => /block|deny/i.test(String(e?.action || '')));
  return { totalEvents: events.length, blockCount: blocks.length };
}

function computeBuildFeedback(auditDir) {
  const events = readJsonlBestEffort(path.join(auditDir, AUDIT_FILES.buildToPlanFeedback));
  return { totalEvents: events.length, unconsumed: events.filter((e) => !e?.consumed).length };
}

function gatherMetrics(projectRoot) {
  const root = projectRoot || process.cwd();
  const cobOut = path.join(root, '_cobolt-output');
  if (!fs.existsSync(cobOut)) {
    return { ok: false, reason: '_cobolt-output not found', root };
  }
  const auditDir = path.join(cobOut, 'audit');
  const planningDir = getPlanningDir(root, { create: false, strict: false, fallbackToLatest: true });
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    root,
    planningDir,
    debtRatio: computeDebtRatio(auditDir),
    coverageScore: computeCoverageScore(planningDir),
    escalationCount: computeEscalationCount(auditDir),
    phantomRate: computePhantomRate(auditDir),
    planFixConvergence: computePlanFixConvergence(auditDir, planningDir),
    phaseProgression: computePhaseProgression(planningDir),
    gateSkipBypasses: computeGateSkipBypasses(auditDir),
    checkpointDebtBlocks: computeCheckpointDebtBlocks(auditDir),
    buildFeedback: computeBuildFeedback(auditDir),
  };
}

function renderMarkdown(m) {
  if (!m.ok) return `# CoBolt plan-metrics\n\n_no _cobolt-output found at ${m.root}; nothing to report._\n`;
  const debt = m.debtRatio;
  const cov = m.coverageScore;
  const esc = m.escalationCount;
  const phantom = m.phantomRate;
  const conv = m.planFixConvergence;
  const phase = m.phaseProgression;

  const lines = [];
  lines.push(`# CoBolt plan-metrics`);
  lines.push('');
  lines.push(`Generated at ${m.generatedAt}.`);
  lines.push('');
  lines.push(`## Critical debt ratio`);
  lines.push('');
  lines.push(
    `- **${debt.criticalDebtRatio}%** (target: <${debt.targetThreshold}%) — ${debt.withinTarget ? 'PASS' : 'OVER TARGET'}`,
  );
  lines.push(`- Open debt entries: ${debt.openDebtEntries} (critical: ${debt.criticalDebtEntries})`);
  lines.push(`- Resolved entries: ${debt.resolvedDebtEntries}`);
  lines.push('');
  lines.push(`## Coverage score`);
  lines.push('');
  lines.push(`- **Weighted: ${cov.weighted ?? 'n/a'}**`);
  if (cov.components) {
    for (const [k, v] of Object.entries(cov.components)) {
      if (typeof v === 'number') lines.push(`  - ${k}: ${v}`);
      else lines.push(`  - ${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push('');
  lines.push(`## Escalation count (3-strike chain)`);
  lines.push('');
  lines.push(`- Rung 1 (planning-lead): ${esc.rung1_planningLead}`);
  lines.push(`- Rung 2 (recovery-advisor): ${esc.rung2_recoveryAdvisor}`);
  lines.push(`- Rung 3 (halt / HUMAN-REVIEW-REQUIRED): ${esc.rung3_halt}`);
  lines.push(`- Other: ${esc.other}`);
  lines.push('');
  lines.push(`## Phantom-return rate`);
  lines.push('');
  lines.push(`- Max: ${phantom.max} (threshold ${phantom.threshold})`);
  lines.push(`- Mean: ${phantom.mean}`);
  if (phantom.agentsOverThreshold.length) {
    lines.push(`- Agents over threshold: ${phantom.agentsOverThreshold.join(', ')}`);
  } else {
    lines.push(`- Agents over threshold: none`);
  }
  lines.push('');
  lines.push(`## Plan-fix convergence`);
  lines.push('');
  lines.push(`- Total iteration entries: ${conv.totalRuns}`);
  lines.push(`- Converged: ${conv.convergedRuns}`);
  lines.push(`- Convergence rate: ${conv.convergenceRate ?? 'n/a'}%`);
  lines.push('');
  lines.push(`## Phase progression`);
  lines.push('');
  lines.push(`- Current phase: **${phase.current ?? '(none yet)'}**`);
  lines.push(`- Complete: ${phase.complete.length ? phase.complete.join(', ') : '(none)'}`);
  lines.push(`- Pending: ${phase.pending.join(', ')}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function renderSummary(m) {
  if (!m.ok) return `plan-metrics: no _cobolt-output found at ${m.root}\n`;
  const debt = m.debtRatio;
  const cov = m.coverageScore;
  const phase = m.phaseProgression;
  return [
    `plan-metrics: phase=${phase.current ?? '-'}`,
    `  criticalDebtRatio=${debt.criticalDebtRatio}% (target<${debt.targetThreshold}%, ${debt.withinTarget ? 'OK' : 'OVER'})`,
    `  coverageScore=${cov.weighted ?? 'n/a'}`,
    `  escalations: r1=${m.escalationCount.rung1_planningLead} r2=${m.escalationCount.rung2_recoveryAdvisor} r3=${m.escalationCount.rung3_halt}`,
    `  phantomMax=${m.phantomRate.max}`,
    '',
  ].join('\n');
}

function writeArtifacts(m, opts = {}) {
  if (!m.ok || !m.planningDir) return;
  const jsonOut = opts.outJson || path.join(m.planningDir, 'plan-metrics.json');
  const mdOut = opts.outMd || path.join(m.planningDir, 'plan-metrics-report.md');
  try {
    fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
    fs.writeFileSync(jsonOut, `${JSON.stringify(m, null, 2)}\n`);
    fs.writeFileSync(mdOut, renderMarkdown(m));
  } catch {
    /* best-effort — read-only tool, never crash on output write */
  }
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.command === 'help' || !args.command) {
    printHelp();
    process.exit(args.command === 'help' ? 0 : 1);
  }
  const metrics = gatherMetrics(args.target);
  if (!metrics.ok) {
    if (args.json) {
      process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
    } else {
      process.stdout.write(`plan-metrics: ${metrics.reason}\n`);
    }
    process.exit(3);
  }

  if (args.command === 'summary') {
    if (args.json) {
      process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
    } else {
      process.stdout.write(renderSummary(metrics));
    }
  } else {
    // report (default): write artifacts unless --json was passed
    if (args.json) {
      process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
    } else if (args.md) {
      process.stdout.write(renderMarkdown(metrics));
    } else {
      writeArtifacts(metrics, { outJson: args.out });
      process.stdout.write(renderSummary(metrics));
    }
  }
  process.exit(0);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  gatherMetrics,
  renderMarkdown,
  renderSummary,
  parseArgs,
  computeDebtRatio,
  computeCoverageScore,
  computeEscalationCount,
  computePhantomRate,
  computePlanFixConvergence,
  computePhaseProgression,
};
