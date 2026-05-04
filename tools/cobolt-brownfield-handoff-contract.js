#!/usr/bin/env node

// CoBolt Brownfield → Build Handoff Contract
//
// Closes brownfield issue 16 (handoff-to-build validation gap).
//
// Before this tool, there was no deterministic `brownfield-to-build-handoff-contract.md`
// listing the exact canonical planning artifacts that `cobolt-build` requires,
// with min-byte thresholds. Planning-sync would write out artifacts, but the
// downstream build orchestrator had no single file to read that said "build
// expects THESE files, at THESE minimum sizes". When the sync dropped one
// artifact, the failure surfaced later — mid-build, inside a story dispatch —
// instead of at the handoff boundary.
//
// This tool:
//   1. Emits `_cobolt-output/latest/brownfield/brownfield-to-build-handoff-contract.md`
//      (human-readable) and `brownfield-to-build-handoff-contract.json` (machine).
//   2. Validates every artifact listed in the contract against its min-byte
//      threshold. Any failure exits non-zero.
//   3. Enumerates the producer agent for each artifact so fix routing is not
//      guesswork.
//
// Usage:
//   node tools/cobolt-brownfield-handoff-contract.js generate --dir <bf-dir> [--json]
//   node tools/cobolt-brownfield-handoff-contract.js verify --dir <bf-dir> [--json]
//
// Exit codes:
//   0 — contract generated and every artifact verified
//   1 — one or more artifacts below threshold
//   2 — usage error
//   3 — brownfield dir missing

const fs = require('node:fs');
const path = require('node:path');
const { buildBrownfieldSemanticDrift } = require('./cobolt-brownfield-semantic-drift');
const { emitBrownfieldContracts, validateBrownfieldContracts } = require('./cobolt-brownfield-contracts');

// Canonical build-expected planning artifacts with min-byte thresholds and
// producer-agent names. Derived from:
//   - source/skills/cobolt-brownfield/references/planning-sync-contract.md
//     (canonical build-ready output list)
//   - SKILL.md §4 P4-P6 census gate (min-bytes table)
//   - brownfield-team.md §P4-P6 (producer agent assignments)
const CONTRACT = Object.freeze([
  { artifact: 'planning/prd.md', minBytes: 1000, producer: 'analyst', phase: 'P4' },
  { artifact: 'planning/trd.md', minBytes: 500, producer: 'trd-architect', phase: 'P4' },
  { artifact: 'planning/security-requirements.md', minBytes: 500, producer: 'security-architect', phase: 'P4' },
  { artifact: 'planning/secure-coding-standard.md', minBytes: 300, producer: 'security-architect', phase: 'P4' },
  { artifact: 'planning/engineering-quality-standards.md', minBytes: 300, producer: 'architect', phase: 'P4' },
  { artifact: 'planning/architecture.md', minBytes: 500, producer: 'architect', phase: 'P5' },
  { artifact: 'planning/system-architecture.md', minBytes: 500, producer: 'architect', phase: 'P5' },
  { artifact: 'planning/architecture-decisions.md', minBytes: 500, producer: 'architect', phase: 'P5' },
  { artifact: 'planning/data-model-spec.md', minBytes: 500, producer: 'architect', phase: 'P5' },
  { artifact: 'planning/api-contracts.md', minBytes: 500, producer: 'architect', phase: 'P5' },
  { artifact: 'planning/delivery-plan.md', minBytes: 300, producer: 'delivery-planner', phase: 'P6' },
  { artifact: 'planning/implicit-requirements.md', minBytes: 500, producer: 'implicit-req-extractor', phase: 'P5' },
  { artifact: 'planning/dependency-register.md', minBytes: 500, producer: 'cross-milestone-analyst', phase: 'P5' },
  { artifact: 'planning/dependency-tracker.json', minBytes: 50, producer: 'cross-milestone-analyst', phase: 'P5' },
  { artifact: 'planning/epics.md', minBytes: 500, producer: 'cobolt-agent-pm', phase: 'P6' },
  { artifact: 'planning/milestones.md', minBytes: 500, producer: 'milestone-architect', phase: 'P6' },
  { artifact: 'planning/traceability-matrix.md', minBytes: 300, producer: 'rtm-analyst', phase: 'P6' },
  { artifact: 'planning/test-strategy.md', minBytes: 500, producer: 'test-architect', phase: 'P6' },
  { artifact: 'planning/milestone-tracker.json', minBytes: 50, producer: 'milestone-architect', phase: 'P6' },
  { artifact: 'planning/story-tracker.json', minBytes: 50, producer: 'cobolt-agent-pm', phase: 'P6' },
  { artifact: 'planning/issue-and-blocker-tracker.json', minBytes: 50, producer: 'cobolt-agent-pm', phase: 'P6' },
  { artifact: 'planning/executable-prd.json', minBytes: 100, producer: 'brownfield-sync', phase: 'P6' },
  { artifact: 'planning/release-slices.json', minBytes: 100, producer: 'brownfield-sync', phase: 'P6' },
  { artifact: 'planning/architecture-readiness.json', minBytes: 100, producer: 'brownfield-sync', phase: 'P6' },
  { artifact: 'planning/boundary-contracts.json', minBytes: 100, producer: 'brownfield-sync', phase: 'P6' },
  { artifact: 'planning/release-readiness-checklist.md', minBytes: 300, producer: 'delivery-planner', phase: 'P6' },
  { artifact: 'planning/master-plan.md', minBytes: 500, producer: 'analyst', phase: 'P6' },
  {
    artifact: 'brownfield/brownfield-intake-profile.json',
    minBytes: 100,
    producer: 'brownfield-contracts',
    phase: 'P3',
  },
  {
    artifact: 'brownfield/brownfield-assessment-verdict.json',
    minBytes: 100,
    producer: 'brownfield-contracts',
    phase: 'P3',
  },
  {
    artifact: 'brownfield/legacy-data-classification.json',
    minBytes: 100,
    producer: 'brownfield-contracts',
    phase: 'P3',
  },
  {
    artifact: 'brownfield/brownfield-evidence-confidence.json',
    minBytes: 100,
    producer: 'brownfield-contracts',
    phase: 'P3',
  },
  { artifact: 'brownfield/legacy-risk-register.json', minBytes: 100, producer: 'brownfield-contracts', phase: 'P3' },
  {
    artifact: 'brownfield/standards-version-baseline.json',
    minBytes: 100,
    producer: 'brownfield-contracts',
    phase: 'P3',
  },
  {
    artifact: 'brownfield/brownfield-lifecycle-map.json',
    minBytes: 100,
    producer: 'brownfield-contracts',
    phase: 'P3',
  },
  { artifact: 'brownfield/ai-system-inventory.json', minBytes: 100, producer: 'brownfield-contracts', phase: 'P3' },
  {
    artifact: 'brownfield/legacy-data-lifecycle.json',
    minBytes: 100,
    producer: 'brownfield-contracts',
    phase: 'P6',
  },
  {
    artifact: 'brownfield/brownfield-parity-contract.json',
    minBytes: 100,
    producer: 'brownfield-contracts',
    phase: 'P6',
  },
  {
    artifact: 'brownfield/migration-safety-plan.json',
    minBytes: 100,
    producer: 'brownfield-contracts',
    phase: 'P6',
  },
  {
    artifact: 'brownfield/brownfield-supply-chain-policy.json',
    minBytes: 100,
    producer: 'brownfield-contracts',
    phase: 'P6',
  },
  { artifact: 'brownfield/legacy-ops-inventory.json', minBytes: 100, producer: 'brownfield-contracts', phase: 'P6' },
  {
    artifact: 'brownfield/modernization-ops-gap-report.json',
    minBytes: 100,
    producer: 'brownfield-contracts',
    phase: 'P6',
  },
  {
    artifact: 'brownfield/observability-semantics-contract.json',
    minBytes: 100,
    producer: 'brownfield-contracts',
    phase: 'P6',
  },
  {
    artifact: 'brownfield/brownfield-modernization-readiness.json',
    minBytes: 100,
    producer: 'brownfield-contracts',
    phase: 'P6',
  },
]);

function resolveOutputRoot(cwd) {
  return path.join(cwd, '_cobolt-output', 'latest');
}

function verify(cwd, options = {}) {
  const outputRoot = resolveOutputRoot(cwd);
  const bfDir = path.join(outputRoot, 'brownfield');
  if (fs.existsSync(bfDir)) {
    try {
      emitBrownfieldContracts(bfDir);
    } catch {
      /* validation below reports the failure */
    }
  }
  const results = [];
  let okCount = 0;
  let failCount = 0;

  for (const entry of CONTRACT) {
    const full = path.join(outputRoot, entry.artifact);
    let size = 0;
    let exists = false;
    try {
      const st = fs.statSync(full);
      size = st.size;
      exists = true;
    } catch {
      exists = false;
    }
    const pass = exists && size >= entry.minBytes;
    if (pass) okCount++;
    else failCount++;
    results.push({
      artifact: entry.artifact,
      minBytes: entry.minBytes,
      size,
      exists,
      pass,
      producer: entry.producer,
      phase: entry.phase,
    });
  }

  let contractValidation = null;
  try {
    contractValidation = validateBrownfieldContracts(path.join(outputRoot, 'brownfield'), {
      scope: 'planning',
      write: true,
    });
  } catch (err) {
    contractValidation = {
      ok: false,
      blockers: [{ detail: String(err?.message || err) }],
    };
  }

  const contractPass = contractValidation.ok === true;
  if (contractPass) okCount++;
  else failCount++;
  const validationPath = path.join(outputRoot, 'brownfield', 'brownfield-contract-validation.json');
  let validationSize = 0;
  try {
    validationSize = fs.statSync(validationPath).size;
  } catch {
    validationSize = 0;
  }
  results.push({
    artifact: 'brownfield/brownfield-contract-validation.json',
    minBytes: 100,
    size: validationSize,
    exists: fs.existsSync(validationPath),
    pass: contractPass,
    producer: 'brownfield-contracts',
    phase: 'P6',
    detail: contractPass
      ? 'planning-scope brownfield contracts validated'
      : (contractValidation.blockers || [])
          .slice(0, 3)
          .map((blocker) => blocker.detail)
          .join('; ') || 'planning-scope brownfield contract validation failed',
  });

  let semanticDrift = null;
  if (fs.existsSync(bfDir)) {
    try {
      semanticDrift = buildBrownfieldSemanticDrift(bfDir, { projectRoot: cwd });
    } catch (err) {
      semanticDrift = {
        fidelity: {
          status: 'fail',
          qualitySummary: { detectors: { advisory: 0, fail: 1 } },
        },
        outputPath: path.join(bfDir, 'brownfield-semantic-drift.json'),
        error: String(err?.message || err),
      };
    }
  }

  const semanticDriftExists = semanticDrift ? fs.existsSync(semanticDrift.outputPath) : false;
  let semanticDriftSize = 0;
  try {
    semanticDriftSize = semanticDriftExists ? fs.statSync(semanticDrift.outputPath).size : 0;
  } catch {
    semanticDriftSize = 0;
  }
  const semanticDriftPass = semanticDrift ? semanticDrift.fidelity.status !== 'fail' : false;
  if (semanticDriftPass) okCount++;
  else failCount++;
  results.push({
    artifact: 'brownfield/brownfield-semantic-drift.json',
    minBytes: 100,
    size: semanticDriftSize,
    exists: semanticDriftExists,
    pass: semanticDriftPass,
    producer: 'cobolt-brownfield-semantic-drift',
    phase: 'P6',
    detail: semanticDrift
      ? `status=${semanticDrift.fidelity.status}; advisory=${semanticDrift.fidelity.qualitySummary.detectors.advisory}; fail=${semanticDrift.fidelity.qualitySummary.detectors.fail}`
      : 'brownfield semantic drift artifact missing',
  });

  return {
    ok: failCount === 0,
    total: CONTRACT.length + 2,
    okCount,
    failCount,
    results,
    strict: options.strict === true,
  };
}

function renderMarkdown(verdict) {
  const lines = [
    '# Brownfield → Build Handoff Contract',
    '',
    '> Canonical list of planning artifacts that `cobolt-build` expects from a',
    '> brownfield run. Produced by `cobolt-brownfield-handoff-contract.js`',
    '> (v0.40.6+ — closes brownfield issue 16).',
    '',
    `Generated at: ${new Date().toISOString()}`,
    `Artifacts: ${verdict.total} · OK: ${verdict.okCount} · FAIL: ${verdict.failCount}`,
    '',
    '| Artifact | Min Bytes | Actual | Producer | Phase | Pass |',
    '|----------|-----------|--------|----------|-------|------|',
  ];
  for (const r of verdict.results) {
    lines.push(
      `| ${r.artifact} | ${r.minBytes} | ${r.size} | \`${r.producer}\` | ${r.phase} | ${r.pass ? '✓' : '✗'} |`,
    );
  }
  lines.push('');
  if (verdict.failCount > 0) {
    lines.push('## Failed Artifacts', '');
    for (const r of verdict.results.filter((x) => !x.pass)) {
      lines.push(
        `- \`${r.artifact}\` — missing or undersized (actual ${r.size} / ${r.minBytes} bytes). Producer: \`${r.producer}\` (${r.phase}). ` +
          `Remediation: re-dispatch the producer agent, or run planning-sync with --repair once the brownfield source is produced.`,
      );
    }
  } else {
    lines.push('All canonical planning artifacts meet the build handoff contract.');
  }
  lines.push('');
  return lines.join('\n');
}

function writeArtifacts(cwd, verdict) {
  const bfDir = path.join(cwd, '_cobolt-output', 'latest', 'brownfield');
  fs.mkdirSync(bfDir, { recursive: true });
  const md = renderMarkdown(verdict);
  const mdPath = path.join(bfDir, 'brownfield-to-build-handoff-contract.md');
  const jsonPath = path.join(bfDir, 'brownfield-to-build-handoff-contract.json');
  fs.writeFileSync(mdPath, md, 'utf8');
  fs.writeFileSync(jsonPath, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8');
  return { mdPath, jsonPath };
}

function audit(cwd, entry) {
  try {
    const dir = path.join(cwd, '_cobolt-output', 'audit');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(dir, 'brownfield-handoff-contract.jsonl'),
      `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* best effort */
  }
}

function printHelp() {
  process.stdout.write(
    `cobolt-brownfield-handoff-contract — brownfield → build handoff contract\n\n` +
      `USAGE\n` +
      `  node tools/cobolt-brownfield-handoff-contract.js generate [--dir <bf-dir>] [--json]\n` +
      `  node tools/cobolt-brownfield-handoff-contract.js verify   [--dir <bf-dir>] [--json]\n` +
      `  node tools/cobolt-brownfield-handoff-contract.js --help\n\n` +
      `COMMANDS\n` +
      `  generate — verify + write the MD/JSON contract files\n` +
      `  verify   — verify only; print the report to stdout\n\n` +
      `EXIT CODES\n` +
      `  0 — every artifact meets the contract\n` +
      `  1 — one or more artifacts below threshold\n` +
      `  2 — usage error\n` +
      `  3 — brownfield directory missing\n`,
  );
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }
  const command = args[0];
  if (command !== 'generate' && command !== 'verify') {
    process.stderr.write(`Unknown command: ${command}\n`);
    printHelp();
    return 2;
  }
  const dirIdx = args.indexOf('--dir');
  const cwd = dirIdx !== -1 && args[dirIdx + 1] ? path.resolve(args[dirIdx + 1], '..', '..', '..') : process.cwd();
  const wantJson = args.includes('--json');

  if (!fs.existsSync(path.join(cwd, '_cobolt-output'))) {
    if (wantJson) process.stdout.write(`${JSON.stringify({ ok: false, reason: 'no-cobolt-output' }, null, 2)}\n`);
    else process.stderr.write('FAIL: _cobolt-output/ not found — nothing to verify\n');
    return 3;
  }

  const verdict = verify(cwd);

  if (command === 'generate') {
    try {
      const written = writeArtifacts(cwd, verdict);
      audit(cwd, { outcome: verdict.ok ? 'ok' : 'fail', action: 'generate', ...written });
    } catch (e) {
      audit(cwd, { outcome: 'write-error', message: String(e?.message || e) });
      if (wantJson)
        process.stdout.write(
          `${JSON.stringify({ ok: false, reason: 'write-error', message: String(e?.message || e) }, null, 2)}\n`,
        );
      else process.stderr.write(`FAIL: ${e?.message || e}\n`);
      return 1;
    }
  } else {
    audit(cwd, { outcome: verdict.ok ? 'ok' : 'fail', action: 'verify' });
  }

  if (wantJson) {
    process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  } else {
    process.stdout.write(renderMarkdown(verdict));
  }
  return verdict.ok ? 0 : 1;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = {
  verify,
  renderMarkdown,
  writeArtifacts,
  CONTRACT,
};
