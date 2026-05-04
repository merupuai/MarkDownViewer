#!/usr/bin/env node

// CoBolt Plan-Fix Sweep — comprehensive planning verification orchestrator.
//
// Invoked by /cobolt-plan-fix Step 3.5 (after the 33-class plan-review run).
// Executes every standalone planning verifier in sequence, normalizes each
// verifier's JSON output into a unified Finding shape, and aggregates the
// result to _cobolt-output/audit/plan-fix-sweep.json. The SKILL repair loop
// then drives findings to clean across BOTH plan-review-verdict.json AND
// plan-fix-sweep.json — so a finding produced by artifact-parity, gap-inventory,
// rtm census, etc. is no longer silently dropped just because plan-review.js
// happens not to import that detector.
//
// Why this exists:
//   /cobolt-plan runs many verifiers as advisory or behind bypass envs. When
//   advisories ship as PASS_WITH_DEBT, /cobolt-plan-fix's existing 33-class
//   loop never sees them. This sweep is the catch-all: every verifier with
//   a --json contract gets re-run here against the on-disk planning packet,
//   regardless of how /cobolt-plan classified it.
//
// Usage:
//   node tools/cobolt-plan-fix-sweep.js [--target <dir>] [--json]
//                                       [--skip <verifier,verifier>]
//                                       [--only <verifier,verifier>]
//                                       [--out <path>]
//
// Exit codes:
//   0  every verifier exited clean (no critical findings)
//   1  usage error
//   4  at least one verifier reports a critical finding (matches the
//      plan-output-audit Tier 1 convention so existing CI gates can route)
//
// JSON envelope written to <out> (default _cobolt-output/audit/plan-fix-sweep.json):
//   {
//     schemaVersion: 1,
//     generatedAt: ISO,
//     target: absolute project root,
//     verdict: "clean" | "advisory" | "critical",
//     summary: { critical: N, advisory: N, perVerifier: {...} },
//     verifiers: [{
//       id, command, exitCode, durationMs, ranOk: bool,
//       findings: [Finding...],
//       error: string | null,
//     }],
//     findings: [Finding...]
//   }
//
// Finding shape (unified across verifiers):
//   {
//     verifier: "plan-output-audit",
//     classId:  "A23",            // existing repair class OR new SW-* / SC-INPUT / SC1 / SC2 / RTM-* / PARITY-* / GAP / INTEGRITY-* / DOCTOR-* / PM-*
//     severity: "critical" | "advisory",
//     artifactPath: "...",        // relative to project root if known
//     evidence:  "...",           // what the verifier saw
//     remediationHint: "...",     // SKILL injects this into producer dispatch
//     autoFixCommand: "...",      // optional — non-destructive auto-repair (e.g. cobolt-rtm.js reconcile)
//     raw: {...}                  // verifier's original finding object for debugging
//   }

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_CRITICAL = 4;

const SCHEMA_VERSION = 1;

// Each verifier is a self-contained adapter. Order matters: plan-review first
// so that downstream verifiers can cite the same artifacts; rtm-* together so
// their findings interleave cleanly; doctor last because it's diagnostic.
//
// `noInputsExitCodes` lists exit codes the verifier uses to signal "nothing to
// check" (e.g. planning dir missing, RTM not init). When the verifier exits
// with one of these AND emits no JSON, the runner treats the verifier as
// `skipped: true` and contributes zero findings — preventing false-positive
// critical findings on unplanned projects.
//
// `noInputsStderrPatterns` is a fallback for verifiers that conflate "no
// inputs" with their generic exit 1.
const VERIFIERS = [
  {
    id: 'plan-review',
    desc: '33-class deterministic plan-review verdict',
    command: ['cobolt-plan-review.js', 'run', '--project', '.', '--json'],
    adapter: adaptPlanReview,
    noInputsStderrPatterns: [/no planning dir/i, /planning.*not found/i, /prd\.md.*not found/i],
  },
  {
    id: 'plan-output-audit',
    desc: '5-axis output audit (story-density, FR-counts, evidence, etc.)',
    command: ['cobolt-plan-output-audit.js', '--target', '.', '--json'],
    adapter: adaptPlanOutputAudit,
    noInputsStderrPatterns: [/no planning dir/i, /planning.*not found/i],
  },
  {
    id: 'source-coverage',
    desc: 'Source-document → PRD coverage',
    // No explicit --target — tool defaults to <planningDir>/prd.md.
    command: ['cobolt-source-coverage.js', 'check', '--threshold', '100', '--json'],
    adapter: adaptSourceCoverage,
    noInputsExitCodes: [2], // EXIT_USAGE / target file not found
    noInputsStderrPatterns: [
      /no source docs/i,
      /registry.*not found/i,
      /ENOENT/i,
      /EISDIR/i,
      /illegal operation on a directory/i,
      /target artifact not found/i,
    ],
  },
  {
    id: 'source-input-coverage',
    desc: 'User-provided source files/folders -> Source Requirement Registry coverage',
    command: ['cobolt-source-coverage.js', 'input-docs', '--json'],
    adapter: adaptSourceInputCoverage,
    noInputsStderrPatterns: [/no source docs/i, /no deterministic source document packet/i],
  },
  {
    id: 'source-semantic-coverage',
    desc: 'Source-document intent -> downstream semantic coverage',
    command: ['cobolt-source-semantic-coverage.js', 'check', '--threshold', '3', '--json'],
    adapter: adaptSourceSemanticCoverage,
    noInputsExitCodes: [2], // source-document-consolidation.md absent
    noInputsStderrPatterns: [/source-document-consolidation\.md not found/i, /no planning directory/i],
  },
  {
    id: 'rtm-coverage',
    desc: 'RTM coverage gate',
    command: ['cobolt-rtm.js', 'check', '--json'],
    adapter: adaptRtmCheck,
    noInputsStderrPatterns: [/RTM not initialized/i, /run: init/i],
  },
  {
    id: 'rtm-census',
    desc: 'PRD/TRD/IR token vs RTM entry parity',
    command: ['cobolt-rtm.js', 'census', '--json'],
    adapter: adaptRtmCensus,
    noInputsStderrPatterns: [/RTM not initialized/i, /run: init/i],
  },
  {
    id: 'rtm-references',
    desc: 'Phantom reference detection (epics/stories/api/ux vs RTM)',
    command: ['cobolt-rtm.js', 'validate-references', '--json'],
    adapter: adaptRtmReferences,
    noInputsStderrPatterns: [/RTM not initialized/i, /run: init/i],
  },
  {
    id: 'rtm-dead',
    desc: 'Dead-requirement audit (status-without-evidence)',
    command: ['cobolt-rtm.js', 'audit', '--dead', '--json'],
    adapter: adaptRtmDead,
    noInputsStderrPatterns: [/RTM not initialized/i, /run: init/i],
  },
  {
    id: 'artifact-parity',
    desc: '11 cross-artifact parity checks (prd↔rtm, ir↔fr, feature-registry, etc.)',
    command: ['cobolt-artifact-parity.js', 'check', 'all', '--json'],
    adapter: adaptArtifactParity,
    noInputsExitCodes: [2], // EXIT_MISSING — explicit
  },
  {
    id: 'gap-inventory',
    desc: 'Phase-gap-reports + carry-forward consolidated gap inventory',
    command: ['cobolt-gap-inventory.js', 'validate'],
    adapter: adaptGapInventory,
    noInputsExitCodes: [2], // EXIT_NO_INPUTS — explicit
    noInputsStderrPatterns: [/cannot read.*gap-inventory\.json/i],
  },
  {
    id: 'planning-integrity',
    desc: 'Cross-artifact planning integrity (multiple Tier groups)',
    command: ['cobolt-planning-integrity.js', 'check', '--json'],
    adapter: adaptPlanningIntegrity,
    noInputsExitCodes: [3],
    noInputsStderrPatterns: [/planning.*directory not found/i],
  },
  {
    id: 'plan-doctor',
    desc: 'Plan-pipeline health diagnostic (tools, schemas, agents, hooks)',
    command: ['cobolt-plan-doctor.js', 'check', '--json'],
    adapter: adaptPlanDoctor,
    noInputsStderrPatterns: [/planning.*not found/i, /no planning/i],
  },
  {
    id: 'planning-manifest',
    desc: 'Graph-backed planning evidence manifest coverage',
    command: ['cobolt-planning-manifest.js', 'check', '--json'],
    adapter: adaptPlanningManifest,
    noInputsExitCodes: [2],
    noInputsStderrPatterns: [/planning.*not found/i, /no planning/i],
  },
];

// ── argv parsing ────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    target: process.cwd(),
    json: false,
    skip: new Set(),
    only: null,
    out: null,
  };
  const args = [...argv];
  while (args.length > 0) {
    const a = args.shift();
    if (a === '--target' || a === '--project' || a === '--cwd') {
      opts.target = path.resolve(args.shift() || opts.target);
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--skip') {
      const list = (args.shift() || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const id of list) opts.skip.add(id);
    } else if (a === '--only') {
      const list = (args.shift() || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      opts.only = new Set(list);
    } else if (a === '--out') {
      opts.out = path.resolve(args.shift() || '');
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(EXIT_OK);
    } else {
      process.stderr.write(`[plan-fix-sweep] Unknown argument: ${a}\n`);
      process.exit(EXIT_USAGE);
    }
  }
  if (!opts.out) {
    opts.out = path.join(opts.target, '_cobolt-output', 'audit', 'plan-fix-sweep.json');
  }
  return opts;
}

function printHelp() {
  process.stdout.write(
    `CoBolt Plan-Fix Sweep — runs every planning verifier and aggregates findings.\n` +
      `\nUsage:\n` +
      `  node tools/cobolt-plan-fix-sweep.js [--target <dir>] [--json] [--skip a,b] [--only a,b] [--out <path>]\n` +
      `\nVerifiers:\n` +
      VERIFIERS.map((v) => `  ${v.id.padEnd(28)}${v.desc}`).join('\n') +
      `\n\nExit codes:\n  0 clean\n  1 usage\n  4 critical findings present\n`,
  );
}

// ── verifier execution ──────────────────────────────────────

function runVerifier(verifier, opts) {
  const toolPath = path.join(__dirname, verifier.command[0]);
  const args = verifier.command.slice(1);
  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  let error = null;
  try {
    if (!fs.existsSync(toolPath)) {
      throw new Error(`tool not found: ${toolPath}`);
    }
    stdout = execFileSync(process.execPath, [toolPath, ...args], {
      cwd: opts.target,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    exitCode = typeof e?.status === 'number' ? e.status : 1;
    stdout = e?.stdout?.toString?.('utf8') || stdout;
    stderr = e?.stderr?.toString?.('utf8') || String(e?.message || e);
    error = stderr.split('\n').slice(0, 6).join('\n').trim() || null;
  }
  const durationMs = Date.now() - startedAt;
  let parsed = null;
  // Try to parse stdout as JSON. Most verifiers emit JSON when invoked with
  // --json; some emit a JSON line preceded by stderr-mixed text on the same
  // pipe — try the whole buffer first, then fall back to the last line that
  // looks JSON-shaped.
  if (stdout) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i].trim();
        if (l.startsWith('{') || l.startsWith('[')) {
          try {
            parsed = JSON.parse(l);
            break;
          } catch {}
        }
      }
    }
  }
  // Detect "no inputs" sentinels so unplanned projects don't generate
  // false-positive critical findings. Either an explicit exit code allowlist
  // or a stderr pattern match qualifies. Skipped verifiers contribute zero
  // findings and ranOk=true (they ran, they just had nothing to check).
  let skipped = false;
  let skippedReason = null;
  if (Array.isArray(verifier.noInputsExitCodes) && verifier.noInputsExitCodes.includes(exitCode)) {
    skipped = true;
    skippedReason = `exit ${exitCode} indicates no inputs`;
  }
  if (!skipped && Array.isArray(verifier.noInputsStderrPatterns)) {
    for (const pat of verifier.noInputsStderrPatterns) {
      if (pat.test(stderr) || pat.test(stdout)) {
        skipped = true;
        skippedReason = `stderr matched ${pat}`;
        break;
      }
    }
  }
  // Adapter never throws — adapters defensively handle missing/null parsed.
  let findings = [];
  let adapterError = null;
  if (!skipped) {
    try {
      findings = verifier.adapter({ parsed, exitCode, stdout, stderr, opts }) || [];
    } catch (e) {
      adapterError = e?.message || String(e);
    }
  }
  // ranOk semantics: skipped (no inputs) OR adapter parsed JSON OR exit clean.
  // A non-zero exit with parseable JSON is "ran with findings" — NOT a failure.
  const parsedSomething = parsed !== null;
  const ranOk = skipped || parsedSomething || (exitCode === 0 && adapterError === null);
  return {
    id: verifier.id,
    command: ['node', toolPath, ...args].join(' '),
    exitCode,
    durationMs,
    ranOk,
    skipped,
    skippedReason,
    findings,
    error: skipped || ranOk ? adapterError || null : error || adapterError,
    raw: parsed,
  };
}

// ── adapters (one per verifier) ─────────────────────────────

function makeFinding({ verifier, classId, severity, artifactPath, evidence, remediationHint, autoFixCommand, raw }) {
  return {
    verifier,
    classId,
    severity: severity === 'critical' ? 'critical' : 'advisory',
    artifactPath: artifactPath || null,
    evidence: evidence || null,
    remediationHint: remediationHint || null,
    autoFixCommand: autoFixCommand || null,
    raw: raw || null,
  };
}

function adaptPlanReview({ parsed }) {
  if (!parsed) return [];
  const out = [];
  const blockers = Array.isArray(parsed.blockers) ? parsed.blockers : [];
  const advisories = Array.isArray(parsed.advisories) ? parsed.advisories : [];
  for (const f of blockers) {
    out.push(
      makeFinding({
        verifier: 'plan-review',
        classId: f.classId || f.detectorId || 'unclassified',
        severity: 'critical',
        artifactPath: f?.details?.path || f?.artifactPath || null,
        evidence: f.evidence?.summary || f.evidence?.id || f.message || null,
        remediationHint: f.remediationHint || null,
        raw: f,
      }),
    );
  }
  for (const f of advisories) {
    out.push(
      makeFinding({
        verifier: 'plan-review',
        classId: f.classId || f.detectorId || 'unclassified',
        severity: 'advisory',
        artifactPath: f?.details?.path || f?.artifactPath || null,
        evidence: f.evidence?.summary || f.evidence?.id || f.message || null,
        remediationHint: f.remediationHint || null,
        raw: f,
      }),
    );
  }
  return out;
}

function adaptPlanOutputAudit({ parsed, exitCode }) {
  if (!parsed) return [];
  const out = [];
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  for (const axis of results) {
    const blocks = Array.isArray(axis.blocks) ? axis.blocks : [];
    for (const b of blocks) {
      const classId = mapAxisToClassId(axis.axis || axis.id);
      out.push(
        makeFinding({
          verifier: 'plan-output-audit',
          classId,
          severity: 'critical',
          artifactPath: b.path || b.artifactPath || null,
          evidence: b.message || b.summary || axis.axis,
          remediationHint: b.remediationHint || `Repair ${axis.axis} via the producer for ${classId}`,
          raw: b,
        }),
      );
    }
    // STORY-DENSITY-EVIDENCE: D02 evidence:absent surfacing
    if (axis.evidence === 'absent' && (axis.passed === false || axis.status === 'fail')) {
      out.push(
        makeFinding({
          verifier: 'plan-output-audit',
          classId: 'A23',
          severity: 'critical',
          artifactPath: '_cobolt-output/latest/planning/milestones.md',
          evidence: `axis ${axis.axis} reported evidence:absent (vacuous-pass closure)`,
          remediationHint:
            'Run rebalance-milestones to regenerate evidence base, then re-dispatch cobolt-create-epics-and-stories',
          raw: axis,
        }),
      );
    }
  }
  if (exitCode === 4 && out.length === 0) {
    // Tool reported critical but adapter found nothing — flag as raw critical.
    out.push(
      makeFinding({
        verifier: 'plan-output-audit',
        classId: 'SW-OUTPUT-AUDIT',
        severity: 'critical',
        evidence: 'plan-output-audit exited 4 (Tier 1 axis blocked) but emitted no parseable blocks',
        remediationHint: 'Inspect _cobolt-output/audit/plan-output-audit/audit-report.json directly',
        raw: parsed,
      }),
    );
  }
  return out;
}

function mapAxisToClassId(axis) {
  switch (axis) {
    case 'epicDensity':
    case 'epic-density':
      return 'A22';
    case 'storyDensity':
    case 'story-density':
      return 'A23';
    case 'frCounts':
    case 'fr-counts':
      return 'B1';
    case 'trdQuality':
    case 'trd-quality':
      return 'D-quality';
    default:
      return `SW-AXIS-${axis || 'unknown'}`;
  }
}

function adaptSourceCoverage({ parsed, exitCode }) {
  if (!parsed) {
    if (exitCode === 1) {
      return [
        makeFinding({
          verifier: 'source-coverage',
          classId: 'SC1',
          severity: 'critical',
          evidence:
            'cobolt-source-coverage exited 1 (coverage below threshold or registry missing) but emitted no JSON',
          remediationHint:
            'Run cobolt-source-coverage check directly to see missing source IDs, then dispatch cobolt-edit-prd to add them',
        }),
      ];
    }
    return [];
  }
  if (parsed.skipped || parsed.passed === true) return [];
  const missing = Array.isArray(parsed.unmatched)
    ? parsed.unmatched
    : Array.isArray(parsed.missing)
      ? parsed.missing
      : Array.isArray(parsed.missingIds)
        ? parsed.missingIds
        : [];
  const target = parsed.target || '_cobolt-output/latest/planning/prd.md';
  if (missing.length === 0 && parsed.coverage != null && parsed.coverage < (parsed.threshold ?? 95)) {
    return [
      makeFinding({
        verifier: 'source-coverage',
        classId: 'SC1',
        severity: 'critical',
        artifactPath: target,
        evidence: `coverage ${parsed.coverage} below threshold ${parsed.threshold ?? 95}`,
        remediationHint: 'Dispatch cobolt-edit-prd with missing source IDs to add them to PRD',
        raw: parsed,
      }),
    ];
  }
  return missing.map((entry) => {
    const id = entry?.id || entry?.requirementId || entry;
    const sourceFile = entry?.sourceFile ? ` from ${entry.sourceFile}` : '';
    const summary = entry?.summary ? `: ${entry.summary}` : '';
    return makeFinding({
      verifier: 'source-coverage',
      classId: 'SC1',
      severity: 'critical',
      artifactPath: target,
      evidence: `source ID ${id}${sourceFile} missing from PRD${summary}`,
      remediationHint: `Dispatch cobolt-edit-prd to add ${id} to prd.md (or cobolt-extract-implicit-reqs if it is implicit)`,
      raw: entry && typeof entry === 'object' ? entry : { id },
    });
  });
}

function adaptSourceInputCoverage({ parsed, exitCode }) {
  if (!parsed) {
    if (exitCode === 1) {
      return [
        makeFinding({
          verifier: 'source-input-coverage',
          classId: 'SC-INPUT',
          severity: 'critical',
          artifactPath: '_cobolt-output/latest/planning/source-document-consolidation.md',
          evidence: 'cobolt-source-coverage input-docs exited 1 (input document coverage failed) but emitted no JSON',
          remediationHint:
            'Regenerate source-document-consolidation.md from source-intake.json; every input document needs an included/excluded/deferred SRC row',
        }),
      ];
    }
    return [];
  }
  if (parsed.skipped || parsed.passed === true) return [];

  const target = parsed.packetPath || '_cobolt-output/latest/planning/source-document-consolidation.md';
  const missing = Array.isArray(parsed.missingRegistryDocuments) ? parsed.missingRegistryDocuments : [];
  if (missing.length > 0) {
    return missing.map((documentPath) =>
      makeFinding({
        verifier: 'source-input-coverage',
        classId: 'SC-INPUT',
        severity: 'critical',
        artifactPath: target,
        evidence: `input document ${documentPath} has no included/excluded/deferred Source Requirement Registry row`,
        remediationHint:
          'Regenerate source-document-consolidation.md from source-intake.json and add at least one included/excluded/deferred SRC row for this user-provided input document',
        raw: { documentPath, report: parsed },
      }),
    );
  }

  const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
  return [
    makeFinding({
      verifier: 'source-input-coverage',
      classId: 'SC-INPUT',
      severity: 'critical',
      artifactPath: target,
      evidence: issues[0] || 'Source input document coverage failed',
      remediationHint:
        'Repair source-intake.json, PRD frontmatter, and source-document-consolidation.md so every supplied file/folder input is explicitly represented',
      raw: parsed,
    }),
  ];
}

function adaptSourceSemanticCoverage({ parsed }) {
  if (!parsed) return [];
  if (parsed.verdict === 'SKIP' || parsed.verdict === 'PASS') return [];
  const citationOnly = Array.isArray(parsed.citationOnly) ? parsed.citationOnly : [];
  return citationOnly.map((entry) =>
    makeFinding({
      verifier: 'source-semantic-coverage',
      classId: 'SC2',
      severity: 'critical',
      artifactPath: '_cobolt-output/latest/planning/source-document-consolidation.md',
      evidence:
        `source ID ${entry.id || '<unknown>'} is cited downstream but only ${entry.overlapCount ?? 0}` +
        ' substantive source term(s) overlap with the cited planning artifacts',
      remediationHint:
        'Re-dispatch cobolt-analyze-features and cobolt-create-epics-and-stories with the cited SRC IDs so downstream artifacts carry the actual requirement intent, not just the ID.',
      raw: entry,
    }),
  );
}

function adaptRtmCheck({ parsed, exitCode }) {
  if (!parsed) return [];
  if (parsed.passed === true) return [];
  const coverage = parsed.coverage ?? parsed.percentage;
  const threshold = parsed.threshold ?? 0.7;
  if (coverage != null && coverage < threshold) {
    return [
      makeFinding({
        verifier: 'rtm-coverage',
        classId: 'RTM-COV',
        severity: exitCode === 1 ? 'critical' : 'advisory',
        artifactPath: '_cobolt-output/latest/planning/rtm.json',
        evidence: `RTM coverage ${coverage} below threshold ${threshold}`,
        remediationHint:
          'Run cobolt-rtm.js map to back-fill mappings, or dispatch cobolt-create-epics-and-stories to add missing stories',
        autoFixCommand: 'node $COBOLT_TOOLS/cobolt-rtm.js map',
        raw: parsed,
      }),
    ];
  }
  return [];
}

function adaptRtmCensus({ parsed }) {
  if (!parsed || parsed.passed === true) return [];
  const gaps = Array.isArray(parsed.gaps) ? parsed.gaps : Array.isArray(parsed.missing) ? parsed.missing : [];
  return gaps.map((g) =>
    makeFinding({
      verifier: 'rtm-census',
      classId: 'RTM-CENSUS',
      severity: 'critical',
      artifactPath: '_cobolt-output/latest/planning/rtm.json',
      evidence: `requirement ${g.id || g.requirementId || g} present in source artifact but missing from RTM`,
      remediationHint: 'Auto-fixable via cobolt-rtm.js sync-source-registry --all',
      autoFixCommand: 'node $COBOLT_TOOLS/cobolt-rtm.js sync-source-registry --all',
      raw: g,
    }),
  );
}

function adaptRtmReferences({ parsed }) {
  if (!parsed || parsed.passed === true) return [];
  const phantoms = Array.isArray(parsed.phantoms)
    ? parsed.phantoms
    : Array.isArray(parsed.violations)
      ? parsed.violations
      : [];
  return phantoms.map((p) =>
    makeFinding({
      verifier: 'rtm-references',
      classId: 'B3',
      severity: 'critical',
      artifactPath: p.consumerPath || p.artifact || null,
      evidence: `phantom reference ${p.id || p.requirementId || p.token} in ${p.consumerPath || p.artifact || 'unknown'}`,
      remediationHint:
        'Either add the missing requirement to RTM (canonical) or remove the phantom reference from the consumer artifact',
      raw: p,
    }),
  );
}

function adaptRtmDead({ parsed }) {
  if (!parsed || parsed.passed === true) return [];
  const dead = Array.isArray(parsed.dead)
    ? parsed.dead
    : Array.isArray(parsed.deadRequirements)
      ? parsed.deadRequirements
      : [];
  return dead.map((d) =>
    makeFinding({
      verifier: 'rtm-dead',
      classId: 'RTM-DEAD',
      severity: 'advisory',
      artifactPath: '_cobolt-output/latest/planning/rtm.json',
      evidence: `requirement ${d.id || d.requirementId} has status ${d.status || 'set'} but no test/code evidence linked`,
      remediationHint: 'Dispatch cobolt-create-test-strategy to add tests, then run cobolt-rtm.js link-test',
      raw: d,
    }),
  );
}

function adaptArtifactParity({ parsed }) {
  if (!parsed) return [];
  const out = [];
  const checks = Array.isArray(parsed.checks) ? parsed.checks : Array.isArray(parsed.results) ? parsed.results : [];
  for (const check of checks) {
    if (check.passed === true || check.status === 'ok') continue;
    if (check.status === 'missing-inputs') continue; // expected for unstarted stages
    const drifts = Array.isArray(check.drifts) ? check.drifts : Array.isArray(check.violations) ? check.violations : [];
    if (drifts.length === 0) {
      out.push(
        makeFinding({
          verifier: 'artifact-parity',
          classId: `PARITY-${check.name || check.id || 'unknown'}`,
          severity: 'critical',
          evidence: check.message || `parity check ${check.name} failed`,
          remediationHint: parityRemediation(check.name),
          raw: check,
        }),
      );
      continue;
    }
    for (const d of drifts) {
      out.push(
        makeFinding({
          verifier: 'artifact-parity',
          classId: `PARITY-${check.name || check.id || 'unknown'}`,
          severity: 'critical',
          artifactPath: d.artifact || d.path || null,
          evidence: d.message || d.description || `${check.name} drift: ${d.id || JSON.stringify(d)}`,
          remediationHint: parityRemediation(check.name),
          raw: d,
        }),
      );
    }
  }
  return out;
}

function parityRemediation(name) {
  switch (name) {
    case 'prd-rtm':
      return 'Run cobolt-rtm.js reconcile to bidirectionally sync RTM ↔ story-tracker, then cobolt-rtm.js import-prd if PRD has new FRs';
    case 'ir-parent-fr':
      return 'Dispatch cobolt-extract-implicit-reqs to attach orphan IRs to parent FRs';
    case 'feature-registry':
      return 'Dispatch cobolt-analyze-features --autonomous to refresh feature-registry.json from PRD/epics';
    case 'security-coding':
      return 'Dispatch cobolt-create-secure-coding-standard to align mitigations with security-requirements threats';
    case 'release-infra':
      return 'Dispatch cobolt-create-release-readiness or cobolt-infra to align checklist ↔ infra-manifest';
    case 'production-evidence':
      return 'Dispatch cobolt-analyze-features (vertical-slice manifests) and cobolt-create-test-strategy (boundary contracts)';
    case 'wireframe-fr-milestones':
      return 'Dispatch cobolt-create-wireframes to add missing screen coverage';
    case 'rtm-story-count':
      return 'Run cobolt-rtm.js reconcile, then cobolt-create-epics-and-stories --redispatch-plan if counts still drift';
    default:
      return `Dispatch the producer of the drifted artifact identified by parity check ${name}`;
  }
}

function adaptGapInventory({ parsed, exitCode, stdout }) {
  // gap-inventory validate doesn't always emit JSON to stdout — check for explicit JSON or exit code
  if (exitCode === 0) return [];
  if (exitCode === 2) return []; // no inputs — expected for fresh planning
  if (parsed && Array.isArray(parsed.errors)) {
    return parsed.errors.map((e) =>
      makeFinding({
        verifier: 'gap-inventory',
        classId: 'GAP',
        severity: 'critical',
        artifactPath: '_cobolt-output/latest/gap/gap-inventory.json',
        evidence: e.message || JSON.stringify(e),
        remediationHint: 'Re-run cobolt-gap-inventory build to regenerate inventory from phase-gap-reports',
        autoFixCommand: 'node $COBOLT_TOOLS/cobolt-gap-inventory.js build --save',
        raw: e,
      }),
    );
  }
  return [
    makeFinding({
      verifier: 'gap-inventory',
      classId: 'GAP',
      severity: 'critical',
      evidence: `cobolt-gap-inventory validate exited ${exitCode}: ${(stdout || '').slice(0, 200)}`,
      remediationHint: 'Re-run cobolt-gap-inventory build to regenerate inventory',
      autoFixCommand: 'node $COBOLT_TOOLS/cobolt-gap-inventory.js build --save',
    }),
  ];
}

function adaptPlanningIntegrity({ parsed }) {
  if (!parsed) return [];
  const violations = Array.isArray(parsed.violations)
    ? parsed.violations
    : Array.isArray(parsed.failures)
      ? parsed.failures
      : [];
  return violations.map((v) =>
    makeFinding({
      verifier: 'planning-integrity',
      classId: `INTEGRITY-${v.group || v.tier || 'unknown'}`,
      severity: v.tier === 1 || v.severity === 'critical' ? 'critical' : 'advisory',
      artifactPath: v.artifact || v.path || null,
      evidence: v.message || v.description || JSON.stringify(v),
      remediationHint: v.remediationHint || `Dispatch planning-lead with the integrity violation: ${v.group}`,
      raw: v,
    }),
  );
}

function adaptPlanDoctor({ parsed }) {
  if (!parsed) return [];
  const issues = Array.isArray(parsed.issues) ? parsed.issues : Array.isArray(parsed.problems) ? parsed.problems : [];
  return issues
    .filter((i) => i.severity === 'critical' || i.severity === 'error' || i.tier === 1)
    .map((i) =>
      makeFinding({
        verifier: 'plan-doctor',
        classId: `DOCTOR-${i.category || i.area || 'unknown'}`,
        severity: 'critical',
        artifactPath: i.artifact || i.file || null,
        evidence: i.message || i.summary || JSON.stringify(i),
        remediationHint: i.remediationHint || 'Diagnostic finding — escalate to planning-lead',
        raw: i,
      }),
    );
}

// ── aggregation + output ────────────────────────────────────

function adaptPlanningManifest({ parsed, exitCode }) {
  if (!parsed) {
    if (exitCode === 1 || exitCode === 4) {
      return [
        makeFinding({
          verifier: 'planning-manifest',
          classId: 'PM-ARTIFACT',
          severity: 'critical',
          artifactPath: '_cobolt-output/latest/planning/planning-manifest.json',
          evidence: `cobolt-planning-manifest exited ${exitCode} but emitted no parseable JSON`,
          remediationHint:
            'Run node tools/cobolt-planning-manifest.js generate --strict --json, then inspect the manifest verifier output',
        }),
      ];
    }
    return [];
  }

  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  if (findings.length > 0) {
    return findings.map((finding) =>
      makeFinding({
        verifier: 'planning-manifest',
        classId: finding.classId || 'PM-ARTIFACT',
        severity:
          finding.severity ||
          (parsed.strict || parsed.summary?.buildAuthorization === 'blocked' ? 'critical' : 'advisory'),
        artifactPath: finding.artifactPath || '_cobolt-output/latest/planning/planning-manifest.json',
        evidence: finding.evidence || finding.message || JSON.stringify(finding),
        remediationHint:
          finding.remediationHint ||
          'Regenerate planning-manifest.json after deterministic backfill, then dispatch the owning producer for unrepaired gaps',
        raw: finding,
      }),
    );
  }

  if (parsed.passed === false || parsed.summary?.verdict === 'critical') {
    return [
      makeFinding({
        verifier: 'planning-manifest',
        classId: 'PM-ARTIFACT',
        severity: parsed.strict ? 'critical' : 'advisory',
        artifactPath: parsed.manifestPath || '_cobolt-output/latest/planning/planning-manifest.json',
        evidence:
          parsed.message ||
          `planning manifest verdict=${parsed.summary?.verdict || 'unknown'} critical=${parsed.summary?.critical || 0}`,
        remediationHint: 'Inspect planning-manifest.json summary and regenerate after repairing missing evidence links',
        raw: parsed.summary || parsed,
      }),
    ];
  }

  return [];
}

function aggregate(verifiers) {
  let critical = 0;
  let advisory = 0;
  const perVerifier = {};
  const findings = [];
  for (const v of verifiers) {
    perVerifier[v.id] = { critical: 0, advisory: 0, ranOk: v.ranOk };
    for (const f of v.findings) {
      findings.push(f);
      if (f.severity === 'critical') {
        critical++;
        perVerifier[v.id].critical++;
      } else {
        advisory++;
        perVerifier[v.id].advisory++;
      }
    }
  }
  let verdict = 'clean';
  if (critical > 0) verdict = 'critical';
  else if (advisory > 0) verdict = 'advisory';
  return { verdict, summary: { critical, advisory, perVerifier }, findings };
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function writeEnvelope(envelope, outPath) {
  ensureDir(outPath);
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, outPath);
}

function printHuman(envelope, verifierResults) {
  const { verdict, summary } = envelope;
  process.stdout.write(`\nCoBolt Plan-Fix Sweep — ${verdict.toUpperCase()}\n`);
  process.stdout.write(
    `  ${summary.critical} critical, ${summary.advisory} advisory across ${verifierResults.length} verifiers\n`,
  );
  for (const v of verifierResults) {
    let status;
    if (v.skipped) status = 'skip';
    else if (v.ranOk) status = 'ok';
    else status = 'FAILED';
    const counts = `${v.findings.length} findings`;
    process.stdout.write(
      `  - ${v.id.padEnd(28)} ${status.padEnd(7)} ${counts.padEnd(14)} (exit ${v.exitCode}, ${v.durationMs}ms)\n`,
    );
    if (v.skipped) process.stdout.write(`      skipped: ${v.skippedReason}\n`);
    else if (v.error) process.stdout.write(`      error: ${v.error.split('\n')[0].slice(0, 200)}\n`);
  }
  process.stdout.write(`\nWrote ${envelope.outPath}\n`);
}

// ── main ────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const verifierResults = [];
  for (const v of VERIFIERS) {
    if (opts.skip.has(v.id)) continue;
    if (opts.only && !opts.only.has(v.id)) continue;
    const result = runVerifier(v, opts);
    verifierResults.push(result);
  }
  const { verdict, summary, findings } = aggregate(verifierResults);
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: startedAt,
    target: opts.target,
    verdict,
    summary,
    verifiers: verifierResults.map((v) => ({
      id: v.id,
      command: v.command,
      exitCode: v.exitCode,
      durationMs: v.durationMs,
      ranOk: v.ranOk,
      skipped: v.skipped,
      skippedReason: v.skippedReason,
      findingCount: v.findings.length,
      error: v.error,
    })),
    findings,
    outPath: opts.out,
  };
  writeEnvelope(envelope, opts.out);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    printHuman(envelope, verifierResults);
  }
  process.exit(verdict === 'critical' ? EXIT_CRITICAL : EXIT_OK);
}

if (require.main === module) {
  main();
}

module.exports = {
  VERIFIERS,
  runVerifier,
  aggregate,
  // Adapters exported for unit testing.
  adaptPlanReview,
  adaptPlanOutputAudit,
  adaptSourceCoverage,
  adaptSourceInputCoverage,
  adaptSourceSemanticCoverage,
  adaptRtmCheck,
  adaptRtmCensus,
  adaptRtmReferences,
  adaptRtmDead,
  adaptArtifactParity,
  adaptGapInventory,
  adaptPlanningIntegrity,
  adaptPlanDoctor,
  adaptPlanningManifest,
  parseArgs,
};
