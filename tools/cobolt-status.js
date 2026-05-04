#!/usr/bin/env node
// cobolt-status — single-screen "where am I, what's blocking me" inspector.
//
// Aggregates pipeline state signals into one view so operators do not need to
// grep through _cobolt-output/ to find the current blocker. Complements
// cobolt-progress (live stream) with a point-in-time diagnosis.
//
// Usage:
//   node tools/cobolt-status.js              # human-readable summary
//   node tools/cobolt-status.js --json       # machine-readable envelope
//   node tools/cobolt-status.js --verbose    # include evidence paths and tails
//
// Exit codes:
//   0 — clean state (idle or in-progress, no blockers)
//   4 — DEGRADED (planning debt exists; build can proceed, release will block)
//   5 — HUMAN_REVIEW (halt file present; run /cobolt-unblock or resume)
//   6 — HARD_FAIL (Tier 1 gate failure; must resolve underlying invariant)

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { readExecutionProjection } = require('../lib/cobolt-execution-ledger');
const {
  collectBlockedGate,
  collectCostBudget,
  collectLastFailure,
  collectRecentDispatches,
  collectTokenBudget,
  formatGateFireRateSummary,
  summarizeGateFireRate,
} = require('../lib/cobolt-observability');

const ROOT = process.cwd();
const STATE_FILE = path.join(ROOT, 'cobolt-state.json');
const PLANNING_DIR = path.join(ROOT, '_cobolt-output', 'latest', 'planning');
const AUDIT_DIR = path.join(ROOT, '_cobolt-output', 'audit');

const _HALT_FILE = path.join(PLANNING_DIR, 'HUMAN-REVIEW-REQUIRED.md');
const _DEGRADED_DOC = path.join(PLANNING_DIR, 'DEGRADED-ARTIFACTS.md');
const _DEBT_LEDGER = path.join(AUDIT_DIR, 'planning-debt.jsonl');
const _ESCALATION_LOG = path.join(AUDIT_DIR, 'escalation-log.jsonl');
const _GATE_SKIP_LOG = path.join(AUDIT_DIR, 'gate-skip-log.jsonl');
const _RETRY_LEDGER = path.join(AUDIT_DIR, 'plan-retry-ledger.jsonl');

function readJSONSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function _readJsonLines(p, limit = 10) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const tail = lines.slice(-limit);
    return tail
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

function _fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function _listMilestones() {
  const planningMs = path.join(PLANNING_DIR, 'milestones');
  if (!dirExists(planningMs)) return [];
  return fs
    .readdirSync(planningMs)
    .filter((f) => /^M\d+\.md$/i.test(f) || /^M\d+-/i.test(f))
    .map((f) => f.replace(/\.md$/i, '').replace(/-.+$/, ''))
    .filter((m, i, a) => a.indexOf(m) === i)
    .sort();
}

function collectSignals() {
  const operator = {
    recentDispatches: collectRecentDispatches(ROOT, 3),
    blockedGate: collectBlockedGate(ROOT),
    costBudget: collectCostBudget(ROOT),
    tokenBudget: collectTokenBudget(ROOT),
    lastFailure: collectLastFailure(ROOT),
    gateFireRate: summarizeGateFireRate({
      projectRoot: ROOT,
      windowHours: 24,
      threshold: 5,
      perFileLines: 200,
      maxBytesPerFile: 256 * 1024,
    }),
  };
  const projection = readExecutionProjection(ROOT, 'status');
  if (!projection) {
    return {
      classification: 'IDLE',
      exitCode: 0,
      planningStatus: null,
      haltFile: null,
      degradedDoc: null,
      debt: { total: 0, unresolved: 0, entries: [] },
      recentEscalations: [],
      recentGateSkips: [],
      retryTail: [],
      milestones: [],
      activeMilestone: null,
      activeStage: null,
      activePipeline: null,
      counts: {
        totalTodos: 0,
        activeTodos: 0,
        deferredTodos: 0,
        resolvedTodos: 0,
        openFindings: 0,
        totalFindings: 0,
        completeMilestones: 0,
        partialMilestones: 0,
      },
      state: readJSONSafe(STATE_FILE) || {},
      operator,
    };
  }

  return {
    classification: projection.classification,
    exitCode: Number(projection.exitCode || 0),
    planningStatus: projection.planningStatus || null,
    haltFile: projection.haltFile ? path.join(ROOT, projection.haltFile) : null,
    degradedDoc: projection.degradedDoc ? path.join(ROOT, projection.degradedDoc) : null,
    debt: projection.debt || { total: 0, unresolved: 0, entries: [] },
    recentEscalations: Array.isArray(projection.recentEscalations) ? projection.recentEscalations : [],
    recentGateSkips: Array.isArray(projection.recentGateSkips) ? projection.recentGateSkips : [],
    retryTail: Array.isArray(projection.retryTail) ? projection.retryTail : [],
    milestones: Array.isArray(projection.milestones) ? projection.milestones : [],
    activeMilestone: projection.activeMilestone || null,
    activeStage: projection.activeStage || null,
    activePipeline: projection.activePipeline || null,
    counts: projection.counts || {
      totalTodos: 0,
      activeTodos: 0,
      deferredTodos: 0,
      resolvedTodos: 0,
      openFindings: 0,
      totalFindings: 0,
      completeMilestones: 0,
      partialMilestones: 0,
    },
    state: readJSONSafe(STATE_FILE) || {},
    operator,
  };
}

function recommendAction(signal) {
  switch (signal.classification) {
    case 'HUMAN_REVIEW':
      return {
        primary: '/cobolt-unblock',
        why: 'Converts the halt marker into tracked debt and resumes the pipeline autonomously.',
        alternatives: [
          'rm _cobolt-output/latest/planning/HUMAN-REVIEW-REQUIRED.md && /cobolt-plan project --resume --auto',
          'COBOLT_PLAN_REDISPATCH_MAX=4 /cobolt-plan project --resume',
          '/cobolt-gap  (if coverage-driven)',
        ],
      };
    case 'DEGRADED':
      return {
        primary: 'proceed (build/review allowed; release will block)',
        why: `Planning debt = ${signal.debt.unresolved}; release blocks until resolved or COBOLT_ACCEPT_PLANNING_DEBT=1.`,
        alternatives: [
          '/cobolt-unblock  (re-attempt authorship)',
          'node tools/cobolt-planning-debt.js list',
          '/cobolt-gap  (close gaps into milestones)',
        ],
      };
    case 'HARD_FAIL':
      return {
        primary: 'Fix the failing Tier 1 invariant — there is no --force past Tier 1',
        why: 'Standards gate, schema contract, or census gate failed. See docs/ARCHITECTURE.md §Gates.',
        alternatives: ['node tools/index.js --list | grep gate', 'less _cobolt-output/audit/gate-skip-log.jsonl'],
      };
    case 'IN_PROGRESS':
      return {
        primary: 'node tools/cobolt-progress.js --follow',
        why: 'A pipeline run is active.',
        alternatives: [],
      };
    case 'PLANNED':
      return {
        primary: '/cobolt-build M{next-unbuilt} --auto',
        why: 'Planning complete; build is the next stage.',
        alternatives: [],
      };
    default:
      return {
        primary: '/cobolt-plan project --auto',
        why: 'No active pipeline; start planning.',
        alternatives: ['/cobolt-brownfield <path>  (for existing codebases)'],
      };
  }
}

function renderHuman(signal, action, verbose) {
  const lines = [];
  lines.push('');
  lines.push(`CoBolt Pipeline Status — ${signal.classification}`);
  lines.push('='.repeat(60));
  lines.push('');

  if (signal.planningStatus) {
    lines.push(`  Planning status: ${signal.planningStatus}`);
  }
  if (signal.milestones.length > 0) {
    lines.push(`  Milestones tracked: ${signal.milestones.join(', ')}`);
  }
  if (signal.activeMilestone) {
    lines.push(`  Active milestone: ${signal.activeMilestone}`);
  }
  if (signal.activeStage) {
    lines.push(`  Active stage: ${signal.activeStage}`);
  }
  if (signal.counts && signal.counts.activeTodos > 0) {
    lines.push(`  Active todos: ${signal.counts.activeTodos}`);
  }
  if (signal.counts && signal.counts.openFindings > 0) {
    lines.push(`  Open findings: ${signal.counts.openFindings} of ${signal.counts.totalFindings}`);
  }
  if (signal.haltFile) {
    lines.push(`  Halt marker: ${path.relative(ROOT, signal.haltFile)}`);
  }
  if (signal.degradedDoc) {
    lines.push(`  Degraded table: ${path.relative(ROOT, signal.degradedDoc)}`);
  }
  if (signal.debt.unresolved > 0) {
    lines.push(`  Unresolved planning debt: ${signal.debt.unresolved} of ${signal.debt.total} entries`);
    if (verbose && signal.debt.entries.length > 0) {
      lines.push('');
      lines.push('  Debt entries (up to 5):');
      for (const entry of signal.debt.entries) {
        lines.push(`    - ${entry.artifact} (${entry.failureClass || 'unknown'})`);
      }
    }
  }
  if (signal.operator?.blockedGate) {
    lines.push(
      `  Blocked gate: ${signal.operator.blockedGate.gate} (${signal.operator.blockedGate.message || 'no reason'})`,
    );
  }
  if (signal.operator?.tokenBudget) {
    const budget = signal.operator.tokenBudget;
    const percent = budget.percent == null ? 'n/a' : `${budget.percent}%`;
    lines.push(
      `  Token budget: ${budget.consumed || 0}${budget.budget ? ` / ${budget.budget}` : ''} (${percent}, ${budget.source})`,
    );
  }
  if (signal.operator?.costBudget) {
    const budget = signal.operator.costBudget;
    const percent = budget.percent == null ? 'n/a' : `${budget.percent}%`;
    const usd = budget.budgetUsd
      ? `$${Number(budget.spentUsd || 0).toFixed(2)} / $${Number(budget.budgetUsd).toFixed(2)}`
      : 'n/a';
    const tokens = budget.budgetTokens ? `${budget.spentTokens || 0} / ${budget.budgetTokens}` : 'n/a';
    lines.push(`  Cost budget: ${usd}; tokens ${tokens} (${percent}, ${budget.action})`);
  }
  if (signal.operator?.lastFailure) {
    const failure = signal.operator.lastFailure;
    lines.push(
      `  Last failure: ${failure.gate} in ${failure.source}${failure.evidencePath ? ` -> ${failure.evidencePath}` : ''}`,
    );
  }
  if (signal.operator?.gateFireRate) {
    const fireRate = signal.operator.gateFireRate;
    lines.push(
      `  Gate fire-rate: ${fireRate.verdict} (${fireRate.totalBlocks} blocks / ${fireRate.uniqueGates} gates in ${fireRate.windowHours}h)`,
    );
    if (fireRate.violatingGates.length > 0) {
      lines.push(
        `  Gate fire-rate blockers: ${fireRate.violatingGates
          .map((gate) => `${gate.gate}=${gate.unresolvedBlockCount}`)
          .join(', ')}`,
      );
    }
  }
  if (signal.recentGateSkips.length > 0 && verbose) {
    lines.push('');
    lines.push(`  Recent gate events (${signal.recentGateSkips.length}):`);
    for (const evt of signal.recentGateSkips) {
      lines.push(`    - ${evt.at || ''} ${evt.gate || ''}: ${evt.verdict || evt.action || ''}`);
    }
  }
  if (signal.operator?.recentDispatches?.length > 0 && verbose) {
    lines.push('');
    lines.push('  Last agent dispatches:');
    for (const dispatch of signal.operator.recentDispatches) {
      lines.push(
        `    - ${dispatch.at || ''} ${dispatch.agent || 'agent'} ${dispatch.verdict || ''} ${dispatch.stage || ''}`,
      );
    }
  }

  lines.push('');
  lines.push('NEXT ACTION');
  lines.push('-'.repeat(60));
  lines.push(`  ${action.primary}`);
  lines.push(`  ${action.why}`);
  if (action.alternatives.length > 0) {
    lines.push('');
    lines.push('  Alternatives:');
    for (const alt of action.alternatives) {
      lines.push(`    - ${alt}`);
    }
  }
  lines.push('');
  lines.push('See docs/PLANNING-RECOVERY.md for the full recovery guide.');
  lines.push('');
  return lines.join('\n');
}

function renderTui(signal, action) {
  const lines = [];
  lines.push(`CoBolt Operator Status (${new Date().toLocaleTimeString('en-GB', { hour12: false })})`);
  lines.push('='.repeat(72));
  lines.push(`State: ${signal.classification}`);
  lines.push(
    `Pipeline: ${signal.activePipeline || 'n/a'}  Stage: ${signal.activeStage || 'n/a'}  Milestone: ${signal.activeMilestone || 'n/a'}`,
  );
  lines.push(
    `Todos: active=${signal.counts?.activeTodos || 0} deferred=${signal.counts?.deferredTodos || 0} resolved=${signal.counts?.resolvedTodos || 0}`,
  );
  lines.push(`Findings: open=${signal.counts?.openFindings || 0} total=${signal.counts?.totalFindings || 0}`);
  lines.push('');
  lines.push('Health');
  lines.push('-'.repeat(72));
  const blockedGate = signal.operator?.blockedGate;
  lines.push(
    `Blocked gate: ${blockedGate ? `${blockedGate.gate} (${blockedGate.message || blockedGate.action || 'blocked'})` : 'none detected'}`,
  );
  const tokenBudget = signal.operator?.tokenBudget;
  if (tokenBudget) {
    const percent = tokenBudget.percent == null ? 'n/a' : `${tokenBudget.percent}%`;
    lines.push(
      `Token budget: ${tokenBudget.consumed || 0}${tokenBudget.budget ? `/${tokenBudget.budget}` : ''} (${percent})`,
    );
  } else {
    lines.push('Token budget: no recent budget event');
  }
  const costBudget = signal.operator?.costBudget;
  if (costBudget) {
    const percent = costBudget.percent == null ? 'n/a' : `${costBudget.percent}%`;
    const usd = costBudget.budgetUsd
      ? `$${Number(costBudget.spentUsd || 0).toFixed(2)}/$${Number(costBudget.budgetUsd).toFixed(2)}`
      : 'n/a';
    lines.push(`Cost budget: ${usd} (${percent}, ${costBudget.action})`);
  } else {
    lines.push('Cost budget: no configured budget');
  }
  const failure = signal.operator?.lastFailure;
  lines.push(`Last failure: ${failure ? `${failure.gate} in ${failure.source}` : 'none detected'}`);
  lines.push('');
  lines.push(
    formatGateFireRateSummary(
      signal.operator?.gateFireRate ||
        summarizeGateFireRate({ projectRoot: ROOT, perFileLines: 200, maxBytesPerFile: 256 * 1024 }),
    ),
  );
  lines.push('');
  lines.push('Last Agent Dispatches');
  lines.push('-'.repeat(72));
  const dispatches = signal.operator?.recentDispatches || [];
  if (dispatches.length === 0) {
    lines.push('No agent dispatches recorded.');
  } else {
    for (const dispatch of dispatches) {
      lines.push(
        `${dispatch.at || 'no-time'}  ${String(dispatch.agent || 'agent').padEnd(24)} ${String(
          dispatch.verdict || '',
        ).padEnd(10)} ${dispatch.stage || ''}`,
      );
    }
  }
  lines.push('');
  lines.push('Next Action');
  lines.push('-'.repeat(72));
  lines.push(action.primary);
  lines.push(action.why);
  lines.push('');
  lines.push('Press Ctrl+C to exit. Use --json for the machine-readable envelope.');
  return `${lines.join('\n')}\n`;
}

function drawFrame(text, { clear = process.stdout.isTTY } = {}) {
  if (clear) {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
  }
  process.stdout.write(text);
}

function readRefreshMs(argv) {
  const idx = argv.indexOf('--refresh-ms');
  if (idx === -1) return 2000;
  const value = Number(argv[idx + 1]);
  return Number.isFinite(value) && value > 0 ? value : 2000;
}

function startTui({ refreshMs = 2000, once = false } = {}) {
  const render = () => {
    const signal = collectSignals();
    const action = recommendAction(signal);
    drawFrame(renderTui(signal, action));
    return signal;
  };
  const signal = render();
  if (once) return signal.exitCode;

  const interval = setInterval(render, refreshMs);
  let watcher = null;
  try {
    const chokidar = require('chokidar');
    watcher = chokidar.watch([STATE_FILE, PLANNING_DIR, AUDIT_DIR], {
      ignoreInitial: true,
      persistent: true,
      depth: 1,
    });
    watcher.on('add', render).on('change', render).on('unlink', render);
  } catch {
    // Polling still keeps the view fresh when chokidar is unavailable.
  }
  process.on('SIGINT', () => {
    clearInterval(interval);
    if (watcher) watcher.close().catch(() => {});
    process.stdout.write('\nStopped status TUI.\n');
    process.exit(0);
  });
  return null;
}

function startWatch({ refreshMs = 2000, once = false } = {}) {
  let lastSignature = '';
  const render = () => {
    const signal = collectSignals();
    const fireRate = signal.operator?.gateFireRate;
    const blockedGate = signal.operator?.blockedGate;
    const signature = JSON.stringify({
      classification: signal.classification,
      stage: signal.activeStage,
      milestone: signal.activeMilestone,
      blockedGate: blockedGate?.gate || null,
      fireRate: fireRate?.verdict || null,
      blocks: fireRate?.totalBlocks || 0,
    });
    if (signature !== lastSignature) {
      lastSignature = signature;
      process.stdout.write(
        `${new Date().toISOString()} status=${signal.classification} milestone=${signal.activeMilestone || '-'} stage=${
          signal.activeStage || '-'
        } blockedGate=${blockedGate?.gate || '-'} gateFireRate=${fireRate?.verdict || '-'}\n`,
      );
    }
    return signal;
  };
  const signal = render();
  if (once) return signal.exitCode;
  const interval = setInterval(render, refreshMs);
  process.on('SIGINT', () => {
    clearInterval(interval);
    process.stdout.write('Stopped status watch.\n');
    process.exit(0);
  });
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  const jsonOut = argv.includes('--json');
  const verbose = argv.includes('--verbose') || argv.includes('-v');
  const once = argv.includes('--once');
  const refreshMs = readRefreshMs(argv);

  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`Usage: node tools/cobolt-status.js [--json] [--verbose] [--tui] [--watch]

Options:
  --json             Emit the status envelope as JSON.
  --verbose          Include evidence paths and recent dispatch/gate details.
  --tui              Refresh a compact operator view every 2s.
  --watch            Follow status changes in plain text.
  --refresh-ms <n>   Override the TUI/watch refresh interval.
  --once             Render one TUI/watch frame and exit (useful for tests).
`);
    process.exit(0);
  }

  if (argv.includes('--tui')) {
    const code = startTui({ refreshMs, once });
    if (typeof code === 'number') process.exit(code);
    return;
  }

  if (argv.includes('--watch')) {
    const code = startWatch({ refreshMs, once });
    if (typeof code === 'number') process.exit(code);
    return;
  }

  const signal = collectSignals();
  const action = recommendAction(signal);

  if (jsonOut) {
    const envelope = {
      classification: signal.classification,
      exitCode: signal.exitCode,
      planningStatus: signal.planningStatus,
      haltFile: signal.haltFile,
      degradedDoc: signal.degradedDoc,
      debt: signal.debt,
      milestones: signal.milestones,
      activeMilestone: signal.activeMilestone,
      activeStage: signal.activeStage,
      activePipeline: signal.activePipeline,
      counts: signal.counts,
      recentGateSkips: signal.recentGateSkips,
      recentEscalations: signal.recentEscalations,
      operator: signal.operator,
      recommendation: action,
    };
    if (verbose) envelope.state = signal.state;
    console.log(JSON.stringify(envelope, null, 2));
  } else {
    process.stdout.write(renderHuman(signal, action, verbose));
  }
  process.exit(signal.exitCode);
}

if (require.main === module) main();

module.exports = { collectSignals, recommendAction };
