#!/usr/bin/env node
// CoBolt evals CLI (M1 foundation).
//
// Subcommands:
//   list                               List available suites under tests/evals/suites/
//   score --case <path> [--trace <p>]  Score a single case against a trace ledger
//   run --mode static --suite <id>     Run a suite in static mode and emit scorecard.json
//
// Flags:
//   --json                             Emit JSON to stdout instead of text
//   --fail-on-regression               Reserved for M2 (exit non-zero on baseline regression)
//
// Programmatic surface: require('./tools/cobolt-evals') returns { main, runSuite, listAvailableSuites }.

const fs = require('node:fs');
const path = require('node:path');

const evals = require('../lib/cobolt-evals');
const { paths } = require('../lib/cobolt-paths');
const { compareFromPaths, compareScorecards, DEFAULT_THRESHOLD } = require('../lib/cobolt-evals/regression');
const { runSuites } = require('../lib/cobolt-evals/static-runner');
const { listAllSuites } = require('../lib/cobolt-evals/suite-loader');
const history = require('../lib/cobolt-evals/history');
const baselines = require('../lib/cobolt-evals/baselines');
const reports = require('../lib/cobolt-evals/reports');
const { exportFailureCases } = require('../lib/cobolt-evals/preference-pairs');
const { clusterFailures, writeClusters } = require('../lib/cobolt-evals/failure-clusters');
const { generateProposals, readProposals, writeProposals } = require('../lib/cobolt-evals/proposals');
const { applyProposal } = require('../lib/cobolt-evals/approval-gate');
const { adaptGuardReports } = require('../lib/cobolt-evals/guard-adapter');
const hiddenSuite = require('../lib/cobolt-evals/hidden-suite');

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        out.flags[key] = true;
      } else {
        out.flags[key] = next;
        i += 1;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function listAvailableSuites(projectRoot) {
  return evals.listSuites(projectRoot);
}

function cmdList(projectRoot, args) {
  const suites = listAvailableSuites(projectRoot);
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify({ suites }, null, 2)}\n`);
    return 0;
  }
  if (suites.length === 0) {
    process.stdout.write('No eval suites found under tests/evals/suites/.\n');
    return 0;
  }
  process.stdout.write('Available eval suites:\n');
  for (const s of suites) {
    process.stdout.write(`  - ${s.id}  (version=${s.version || '?'}, scope=${s.scope || '?'})\n`);
  }
  return 0;
}

function cmdScore(projectRoot, args) {
  const casePath = args.flags.case;
  if (!casePath) {
    process.stderr.write('error: --case <path> is required\n');
    return 2;
  }
  if (!fs.existsSync(casePath)) {
    process.stderr.write(`error: case not found: ${casePath}\n`);
    return 2;
  }
  const c = JSON.parse(fs.readFileSync(casePath, 'utf8'));
  const tracePath = args.flags.trace || paths(projectRoot).traceLedger();
  const scorecard = evals.scoreStatic(c, { tracePath, projectRoot });
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(scorecard, null, 2)}\n`);
  } else {
    process.stdout.write(
      `case=${scorecard.caseId} verdict=${scorecard.verdict} score=${scorecard.weightedScore.toFixed(3)} hardFailures=${scorecard.hardFailures.length}\n`,
    );
  }
  return scorecard.verdict === 'fail' ? 1 : 0;
}

function runSuite(
  projectRoot,
  { suite, mode = 'static', tracePath, judges = false, judgeKind = 'offline', timeoutMs } = {},
) {
  const cp = paths(projectRoot);
  const effectiveTrace = tracePath || cp.traceLedger();
  let result;
  if (mode === 'live') {
    result = evals.runLive(projectRoot, { suite, timeoutMs });
  } else if (mode === 'static') {
    const judge = judges ? evals.createJudge(judgeKind) : null;
    result = evals.runStatic(projectRoot, { suite, tracePath: effectiveTrace, judges, judge });
  } else {
    throw new Error(`mode '${mode}' not supported (use static|live)`);
  }
  if (!result.ok) {
    return result;
  }

  // Write run manifest and scorecard.
  const manifestPath = cp.runManifest();
  const scorecardPath = cp.scorecardPath();
  const manifest = {
    suiteId: result.scorecard.suiteId,
    suiteVersion: result.scorecard.suiteVersion,
    suitePath: result.suitePath,
    mode,
    tracePath: effectiveTrace,
    startedAt: result.scorecard.generatedAt,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(scorecardPath, `${JSON.stringify(result.scorecard, null, 2)}\n`, { mode: 0o600 });

  // M5: append to history rollup (best-effort; never fail a run on rollup errors).
  try {
    history.appendScorecard(result.scorecard, { projectRoot });
  } catch (e) {
    process.stderr.write(`[cobolt-evals] history append failed: ${e.message}\n`);
  }

  return { ...result, manifestPath, scorecardPath };
}

// Resolve the effective set of suite IDs for cmdRun based on --suite / --suites
// / --all / --include-hidden / --robustness / --adversarial.
function resolveSuiteIds(projectRoot, flags) {
  if (flags.all) {
    const list = listAllSuites(projectRoot, {
      includeHidden: !!flags['include-hidden'],
      includeRobustness: !!flags.robustness,
      includeAdversarial: !!flags.adversarial,
    });
    return list.map((s) => s.id);
  }
  if (flags.suites && flags.suites !== true) {
    return String(flags.suites)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (flags.suite && flags.suite !== true) {
    return [String(flags.suite)];
  }
  return [];
}

function cmdRun(projectRoot, args) {
  const mode = args.flags.mode || 'static';
  const suiteIds = resolveSuiteIds(projectRoot, args.flags);
  if (suiteIds.length === 0) {
    process.stderr.write('error: one of --suite <id> | --suites <csv> | --all is required\n');
    return 3;
  }
  const judgesFlag = args.flags.judges === 'on' || args.flags.judges === true;
  const judgeKind = args.flags['judge-model'] === 'claude' ? 'claude' : 'offline';

  // --threshold / --regression-threshold / --fail-on-regression
  const thresholdFlag =
    args.flags.threshold !== undefined
      ? Number(args.flags.threshold)
      : args.flags['regression-threshold'] !== undefined
        ? Number(args.flags['regression-threshold'])
        : DEFAULT_THRESHOLD;
  const failOnRegression = !!args.flags['fail-on-regression'];
  const requireComposite =
    args.flags['require-composite'] !== undefined ? Number(args.flags['require-composite']) : null;
  const baselineName = args.flags.baseline && args.flags.baseline !== true ? String(args.flags.baseline) : null;
  const calibrateFlag = !!args.flags.calibrate;

  // Resolve baseline BEFORE running suites — otherwise history.appendScorecard
  // would overwrite score-history.json and shift the 7d moving average.
  let baselineScorecard = null;
  if (baselineName) {
    baselineScorecard = baselines.resolveBaseline(projectRoot, baselineName);
  }

  // Single-suite legacy path preserves scorecard.json writing + history append.
  let primary = null;
  let scorecardPath = null;
  let composite = null;
  let perSuite = [];
  const isLegacySingle = suiteIds.length === 1 && !args.flags.all && !args.flags.suites;
  if (isLegacySingle) {
    const result = runSuite(projectRoot, {
      suite: suiteIds[0],
      mode,
      tracePath: args.flags.trace,
      judges: judgesFlag,
      judgeKind,
    });
    if (!result.ok) {
      if (args.flags.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, schemaErrors: result.schemaErrors }, null, 2)}\n`);
      } else {
        process.stderr.write(`Suite load failed:\n  ${(result.schemaErrors || []).join('\n  ')}\n`);
      }
      return 3;
    }
    primary = result.scorecard;
    scorecardPath = result.scorecardPath;
    composite = primary;
    perSuite = [{ suiteId: primary.suiteId, ok: true, scorecard: primary }];
  } else {
    const judge = judgesFlag ? evals.createJudge(judgeKind) : null;
    const multi = runSuites(projectRoot, {
      suiteIds,
      tracePath: args.flags.trace,
      judges: judgesFlag,
      judge,
    });
    if (!multi.ok) {
      if (args.flags.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, perSuite: multi.perSuite }, null, 2)}\n`);
      } else {
        process.stderr.write('error: no suites loaded successfully\n');
        for (const s of multi.perSuite || []) {
          if (!s.ok) process.stderr.write(`  ${s.suiteId}: ${(s.schemaErrors || []).join(', ')}\n`);
        }
      }
      return 3;
    }
    composite = multi.composite;
    perSuite = multi.perSuite;
  }

  // Per-suite require-composite check.
  let requireCompositeFailed = false;
  if (requireComposite !== null && Number.isFinite(requireComposite)) {
    for (const s of perSuite) {
      if (s.ok && s.scorecard && Number(s.scorecard.summary.weightedScore) < requireComposite) {
        requireCompositeFailed = true;
      }
    }
    if (Number(composite.summary.weightedScore) < requireComposite) requireCompositeFailed = true;
  }

  // Baseline regression comparison (baselineScorecard resolved above, before
  // the runner mutated history).
  let regression = null;
  if (baselineScorecard) {
    regression = compareScorecards(baselineScorecard, composite, { threshold: thresholdFlag });
  }

  // Calibration (runs AFTER main eval; failure → exit 2).
  let calibration = null;
  if (calibrateFlag) {
    try {
      const calThreshold = args.flags['calibration-threshold'] ? Number(args.flags['calibration-threshold']) : 0.6;
      calibration = evals.runJudgeCalibration({
        projectRoot,
        threshold: calThreshold,
        judgeKind,
      });
    } catch (e) {
      calibration = { ok: false, error: e.message };
    }
  }

  // Output.
  if (args.flags.json) {
    // Legacy single-suite shape preserved for backward compatibility with
    // existing consumers and tests (test-evals-foundation.js): always expose
    // top-level { ok, scorecard, scorecardPath } when a single suite was
    // resolved via the legacy --suite path.
    const payload = isLegacySingle
      ? { ok: true, scorecard: primary, scorecardPath, suiteIds, perSuite, composite, regression, calibration }
      : { ok: true, suiteIds, perSuite, composite, regression, calibration };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Suites: ${suiteIds.join(',')}\n` +
        `Composite score=${Number(composite.summary.weightedScore).toFixed(3)} ` +
        `passed=${composite.summary.passed} warned=${composite.summary.warned} failed=${composite.summary.failed} ` +
        `hardFailures=${composite.summary.hardFailures.length}\n`,
    );
    if (regression) {
      process.stdout.write(
        `Baseline(${baselineName}): score=${regression.baselineScore.toFixed(3)} drop=${regression.drop.toFixed(3)} threshold=${thresholdFlag} regressed=${regression.regressed}\n`,
      );
    }
    if (calibration) {
      const m = calibration.metrics || {};
      process.stdout.write(
        `Calibration: pearson=${(m.pearson || 0).toFixed(3)} spearman=${(m.spearman || 0).toFixed(3)} ok=${calibration.ok}\n`,
      );
    }
  }

  // Exit code resolution (documented matrix):
  //   3 — (handled above) suite load / config error.
  //   2 — calibration failed below threshold.
  //   1 — regression exceeds threshold / hard failures / require-composite not met.
  //   0 — all clear.
  if (calibrateFlag && calibration?.ok === false && !calibration.error) return 2;
  if (calibrateFlag && calibration?.error) return 2;
  if (requireCompositeFailed) return 1;
  if (composite.summary.hardFailures.length > 0) return 1;
  if (composite.summary.failed > 0) return 1;
  if (failOnRegression && regression?.regressed) return 1;
  return 0;
}

function cmdCompare(_projectRoot, args) {
  const baseline = args.flags.baseline;
  const current = args.flags.current;
  if (!baseline || !current) {
    process.stderr.write('error: --baseline <path> and --current <path> are required\n');
    return 2;
  }
  if (!fs.existsSync(baseline)) {
    process.stderr.write(`error: baseline not found: ${baseline}\n`);
    return 2;
  }
  if (!fs.existsSync(current)) {
    process.stderr.write(`error: current not found: ${current}\n`);
    return 2;
  }
  const threshold = args.flags.threshold ? Number(args.flags.threshold) : DEFAULT_THRESHOLD;
  const report = compareFromPaths(baseline, current, { threshold });
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `baseline=${report.baselineScore.toFixed(3)} current=${report.currentScore.toFixed(3)} ` +
        `drop=${report.drop.toFixed(3)} threshold=${threshold} regressed=${report.regressed}\n`,
    );
  }
  return report.regressed ? 1 : 0;
}

function cmdTrend(projectRoot, args) {
  const agent = args.flags.agent && args.flags.agent !== true ? args.flags.agent : null;
  const rollup = history.readHistory(projectRoot);
  const baselineMain = baselines.readBaseline(projectRoot, 'main');
  const md = reports.renderTrend(rollup, { agent, baselineMain });
  if (args.flags.json) {
    const series = agent ? rollup.byAgent?.[agent] : rollup.overall;
    process.stdout.write(`${JSON.stringify({ agent, series: series || null }, null, 2)}\n`);
  } else {
    process.stdout.write(`${md}\n`);
  }
  return 0;
}

function cmdBaseline(projectRoot, args) {
  const action = args._[1];
  if (action !== 'promote' && action !== 'demote' && action !== 'list') {
    process.stderr.write('error: baseline requires a subcommand: promote | demote | list\n');
    return 2;
  }
  if (action === 'list') {
    const all = baselines.listBaselines(projectRoot);
    process.stdout.write(`${JSON.stringify(all, null, 2)}\n`);
    return 0;
  }
  const to = args.flags.to;
  if (!to) {
    process.stderr.write('error: --to main|release-candidate is required\n');
    return 2;
  }
  if (action === 'demote') {
    const r = baselines.demote({ projectRoot, key: to });
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return 0;
  }
  const source = args.flags.source;
  if (!source) {
    process.stderr.write('error: --source <scorecard-path> is required for promote\n');
    return 2;
  }
  try {
    const r = baselines.promote({ projectRoot, source, to });
    process.stdout.write(`${JSON.stringify({ ok: true, key: r.key, path: r.path }, null, 2)}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
}

function cmdReport(projectRoot, args) {
  const out = reports.generateAll({
    projectRoot,
    agent: args.flags.agent && args.flags.agent !== true ? args.flags.agent : null,
  });
  if (args.flags.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  else process.stdout.write(`Reports written:\n  ${out.summaryPath}\n  ${out.leaderboardPath}\n  ${out.trendPath}\n`);
  return 0;
}

function cmdCalibrate(projectRoot, args) {
  const threshold = args.flags.threshold ? Number(args.flags.threshold) : undefined;
  const judgeKind = args.flags['judge-model'] === 'claude' ? 'claude' : 'offline';
  const goldPath = args.flags.gold || undefined;
  const result = evals.runJudgeCalibration({
    projectRoot,
    threshold,
    judgeKind,
    goldPath,
  });
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const m = result.metrics || {};
    process.stdout.write(
      `cases=${result.caseCount} pearson=${(m.pearson || 0).toFixed(3)} ` +
        `spearman=${(m.spearman || 0).toFixed(3)} mae=${(m.mae || 0).toFixed(3)} ` +
        `threshold=${result.threshold} ok=${result.ok}\n` +
        (result.reportPath ? `Report: ${result.reportPath}\n` : ''),
    );
  }
  return result.ok ? 0 : 1;
}

function readFailureCases(projectRoot) {
  const p = path.join(projectRoot, '_cobolt-output', 'evals', 'datasets', 'failure-cases.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function cmdExportFailures(projectRoot, args) {
  const scorecardPath = args.flags.scorecard || paths(projectRoot).scorecardPath();
  if (!fs.existsSync(scorecardPath)) {
    process.stderr.write(`error: scorecard not found: ${scorecardPath}\n`);
    return 2;
  }
  const format = args.flags.format || 'jsonl';
  if (format !== 'jsonl') {
    process.stderr.write(`error: only --format jsonl is supported (got ${format})\n`);
    return 2;
  }
  const r = exportFailureCases(scorecardPath, { projectRoot });
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...r }, null, 2)}\n`);
  } else {
    process.stdout.write(`Exported ${r.count} failure cases -> ${r.outPath}\n`);
  }
  return 0;
}

function cmdPropose(projectRoot, args) {
  const action = args._[1];
  if (action === 'approve') {
    const id = args.flags.id;
    const by = args.flags.by;
    if (!id || !by) {
      process.stderr.write('error: --id <proposalId> and --by <name> are required\n');
      return 2;
    }
    const all = readProposals(projectRoot).proposals || [];
    const proposal = all.find((p) => p.id === id);
    if (!proposal) {
      process.stderr.write(`error: proposal not found: ${id}\n`);
      return 2;
    }
    const result = applyProposal(proposal, { approvedBy: by, projectRoot });
    if (args.flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else
      process.stdout.write(
        `applied=${result.applied}${result.reason ? ` reason=${result.reason}` : ''}` +
          `${result.patchFile ? ` patch=${result.patchFile}` : ''}\n`,
      );
    return result.applied ? 0 : 1;
  }
  if (action === 'list') {
    const all = readProposals(projectRoot).proposals || [];
    const status = args.flags.status;
    const filtered = status ? all.filter((p) => p.status === status) : all;
    if (args.flags.json) {
      process.stdout.write(`${JSON.stringify({ proposals: filtered }, null, 2)}\n`);
    } else {
      for (const p of filtered) {
        process.stdout.write(`${p.id}  status=${p.status}  dScore=${Number(p.dScore).toFixed(3)}  ${p.title}\n`);
      }
      if (!filtered.length) process.stdout.write('(no proposals)\n');
    }
    return 0;
  }
  // Default: end-to-end generation
  const failures = readFailureCases(projectRoot);
  if (!failures.length) {
    process.stderr.write(
      'error: no failure cases at _cobolt-output/evals/datasets/failure-cases.jsonl; run `export-failures` first\n',
    );
    return 2;
  }
  const clusters = clusterFailures(failures);
  writeClusters(clusters, { projectRoot });
  const { proposals, outPath } = generateProposals(clusters, { projectRoot });
  // Merge with existing (preserve approvals)
  try {
    const existing = (readProposals(projectRoot).proposals || []).reduce((m, p) => {
      m[p.id] = p;
      return m;
    }, {});
    const merged = proposals.map((p) => (existing[p.id] && existing[p.id].status !== 'draft' ? existing[p.id] : p));
    writeProposals(projectRoot, merged);
  } catch (_) {
    /* first run */
  }
  if (args.flags.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, clusters: clusters.length, proposals: proposals.length, outPath }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`Generated ${proposals.length} proposals from ${clusters.length} clusters -> ${outPath}\n`);
  }
  return 0;
}

function cmdAdaptGuards(projectRoot, args) {
  const cp = paths(projectRoot);
  const guardOutputsDir = args.flags['guard-dir'] || cp.latest();
  const traceLedgerPath = args.flags.trace || cp.traceLedger();
  const r = adaptGuardReports({
    guardOutputsDir,
    traceLedgerPath,
    caseId: args.flags.case || null,
    traceId: args.flags['trace-id'] || null,
  });
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...r }, null, 2)}\n`);
  } else {
    process.stdout.write(`adapted ${r.appended} guard events -> ${traceLedgerPath}\n`);
  }
  return 0;
}

function cmdHiddenSuite(projectRoot, args) {
  const action = args._[1];
  if (action === 'encrypt') {
    const file = args.flags.file;
    if (!file) {
      process.stderr.write('error: hidden-suite encrypt requires --file <path>\n');
      return 2;
    }
    if (!hiddenSuite.hasKey()) {
      process.stderr.write('error: COBOLT_EVAL_HIDDEN_KEY not set\n');
      return 2;
    }
    try {
      const r = hiddenSuite.encryptFile({ projectRoot, file });
      if (args.flags.json) process.stdout.write(`${JSON.stringify({ ok: true, ...r }, null, 2)}\n`);
      else process.stdout.write(`Encrypted suite ${r.id} -> ${r.path}\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`error: ${e.message}\n`);
      return 1;
    }
  }
  if (action === 'list') {
    const suites = hiddenSuite.listHidden(projectRoot);
    if (args.flags.json) process.stdout.write(`${JSON.stringify({ suites }, null, 2)}\n`);
    else {
      if (!hiddenSuite.hasKey()) {
        process.stdout.write('COBOLT_EVAL_HIDDEN_KEY not set; no hidden suites visible.\n');
      } else if (suites.length === 0) {
        process.stdout.write('No hidden suites found.\n');
      } else {
        for (const s of suites)
          process.stdout.write(`  - ${s.id}  (version=${s.version || '?'}, scope=${s.scope || '?'})\n`);
      }
    }
    return 0;
  }
  process.stderr.write('error: hidden-suite requires a subcommand: encrypt | list\n');
  return 2;
}

function main(argv) {
  const args = parseArgs(argv.slice(2));
  const sub = args._[0] || 'help';
  const projectRoot = process.cwd();

  switch (sub) {
    case 'list':
      return cmdList(projectRoot, args);
    case 'score':
      return cmdScore(projectRoot, args);
    case 'run':
      return cmdRun(projectRoot, args);
    case 'compare':
      return cmdCompare(projectRoot, args);
    case 'trend':
      return cmdTrend(projectRoot, args);
    case 'baseline':
      return cmdBaseline(projectRoot, args);
    case 'report':
      return cmdReport(projectRoot, args);
    case 'calibrate':
      return cmdCalibrate(projectRoot, args);
    case 'export-failures':
      return cmdExportFailures(projectRoot, args);
    case 'propose':
      return cmdPropose(projectRoot, args);
    case 'adapt-guards':
      return cmdAdaptGuards(projectRoot, args);
    case 'hidden-suite':
      return cmdHiddenSuite(projectRoot, args);
    default:
      process.stdout.write(
        'Usage:\n' +
          '  cobolt-evals list [--json]\n' +
          '  cobolt-evals score --case <path> [--trace <path>] [--json]\n' +
          '  cobolt-evals run --mode static|live --suite <id> [--trace <path>] [--judges on|off] [--judge-model offline|claude] [--json]\n' +
          '  cobolt-evals adapt-guards [--json]\n' +
          '  cobolt-evals calibrate [--threshold 0.6] [--gold <path>] [--judge-model offline|claude] [--json]\n' +
          '  cobolt-evals compare --baseline <path> --current <path> [--threshold 0.05] [--json]\n' +
          '  cobolt-evals trend [--agent <name>] [--json]\n' +
          '  cobolt-evals baseline promote --source <scorecard> --to main|release-candidate\n' +
          '  cobolt-evals baseline demote  --to main|release-candidate\n' +
          '  cobolt-evals baseline list\n' +
          '  cobolt-evals report [--agent <name>] [--json]\n' +
          '  cobolt-evals export-failures [--scorecard <path>] [--format jsonl] [--json]\n' +
          '  cobolt-evals propose [--json]\n' +
          '  cobolt-evals propose approve --id <proposalId> --by <name> [--json]\n' +
          '  cobolt-evals propose list [--status draft|approved|applied|rejected] [--json]\n' +
          '  cobolt-evals hidden-suite encrypt --file <path> [--json]   (requires COBOLT_EVAL_HIDDEN_KEY)\n' +
          '  cobolt-evals hidden-suite list [--json]                    (fail-silent without key)\n',
      );
      return 0;
  }
}

if (require.main === module) {
  process.exit(main(process.argv) || 0);
}

// Bridge to agent-hub: record scored improvement attempt. Non-breaking; only runs
// when agent-hub is available in the host project. Safe no-op otherwise.
function recordImprovementAttempt({ projectRoot = process.cwd(), proposal, score, status = 'scored', tags = [] } = {}) {
  try {
    const hub = require('./cobolt-agent-hub');
    if (!hub || typeof hub.addAttempt !== 'function') return { ok: false, reason: 'hub-unavailable' };
    const record = hub.addAttempt(
      {
        agent: 'cobolt-evals',
        summary: proposal ? proposal.title : 'eval-improvement-attempt',
        score: typeof score === 'number' ? score : proposal?.dScore,
        status,
        tags: ['evals', 'improvement-proposal', proposal?.targetKind || 'unknown', ...tags],
        metadata: proposal ? { proposalId: proposal.id, targetPath: proposal.targetPath } : {},
      },
      projectRoot,
    );
    return { ok: true, record };
  } catch (_) {
    return { ok: false, reason: 'hub-unavailable' };
  }
}

module.exports = { main, runSuite, listAvailableSuites, recordImprovementAttempt };
