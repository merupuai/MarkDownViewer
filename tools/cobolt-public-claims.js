#!/usr/bin/env node

// CoBolt Public Claims Verifier — SF-08.
//
// Walks `source/templates/public-claims.json` and asserts every active claim has
// resolvable evidence: a tool that exits 0, a fresh artifact, file presence, a
// version pin, or a numeric stat that matches `_cobolt-output/stats/current.json`.
//
// Why this tool exists: README and product copy make buyer-facing assertions
// (Docker-ready, K8s-ready, WCAG 2.2 AA, runtime support, 207 agents …) without
// a visible claim-to-evidence manifest. SF-02 covers the stat marker block; this
// tool covers everything else and emits a buyer-readable claim ledger so a
// sophisticated buyer can audit every badge.
//
// Usage:
//   node tools/cobolt-public-claims.js --check              # gate mode (exits non-zero on drift)
//   node tools/cobolt-public-claims.js --check --json       # gate mode + structured output
//   node tools/cobolt-public-claims.js --print              # list every claim + verdict; never fails
//   node tools/cobolt-public-claims.js --report             # write _cobolt-output/reports/public-claims.{md,json}
//
// Exit codes (per tools/CLAUDE.md):
//   0  PASS / report mode
//   1  Drift (--check) or unhandled error
//   2  At least one evidence command exited 2/3 (missing dep / infra)

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TOOL_ROOT = path.join(__dirname, '..');
const SELF_NAME = 'cobolt-public-claims.js';

const DEFAULT_MANIFEST = path.join(TOOL_ROOT, 'source', 'templates', 'public-claims.json');
const DEFAULT_README = path.join(TOOL_ROOT, 'README.md');
const DEFAULT_PACKAGE_JSON = path.join(TOOL_ROOT, 'package.json');
const DEFAULT_STATS = path.join(TOOL_ROOT, '_cobolt-output', 'stats', 'current.json');
const DEFAULT_REPORT_DIR = path.join(TOOL_ROOT, '_cobolt-output', 'reports');

const AMBIGUOUS_METRIC_PATTERN =
  /^(test|tests|file|files|user|users|build|builds|release|releases|hook|hooks)\b(?!.*[_-](?:files?|cases?|count|total|users?|seconds?|ms))/i;

const READMEDOM_BADGE_PATTERN = /<img\s+alt="([^"]+)"\s+src="https:\/\/img\.shields\.io\/badge\/([^"?]+)/g;

// ── Public API ──────────────────────────────────────────────────────────────

function loadManifest(manifestPath = DEFAULT_MANIFEST) {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`public-claims manifest is not an object: ${manifestPath}`);
  }
  if (!Array.isArray(parsed.claims)) {
    throw new Error(`public-claims manifest is missing claims[]: ${manifestPath}`);
  }
  return parsed;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function safeReadStats(statsPath) {
  if (!fs.existsSync(statsPath)) return { exists: false, stats: null, mtime: null };
  const stats = readJson(statsPath);
  const mtime = fs.statSync(statsPath).mtime;
  return { exists: true, stats, mtime };
}

function collectLiveStats(rootDir) {
  try {
    const statSource = require(path.join(rootDir, 'tools', 'cobolt-stat-source.js'));
    if (typeof statSource.collectStats !== 'function') return null;
    return statSource.collectStats(rootDir);
  } catch {
    return null;
  }
}

function ageDaysFrom(date, now = new Date()) {
  if (!date) return null;
  const ms = Math.max(0, now.getTime() - new Date(date).getTime());
  return ms / (1000 * 60 * 60 * 24);
}

function makeVerdict(status, message, extra = {}) {
  return { status, message, ...extra };
}

function detectCycle(manifest) {
  for (const claim of manifest.claims) {
    const cmd = claim.evidence?.command;
    if (typeof cmd === 'string' && cmd.includes(SELF_NAME)) {
      throw new Error(`public-claims manifest cycle detected — ${claim.id} references this tool itself`);
    }
  }
}

function lintAmbiguousMetric(claim) {
  if (typeof claim.claimText !== 'string') return null;
  if (AMBIGUOUS_METRIC_PATTERN.test(claim.claimText)) {
    return makeVerdict(
      'unsupported',
      `claimText "${claim.claimText}" uses an ambiguous metric noun without a disambiguating suffix (files / cases / count …).`,
      { code: 'AMBIGUOUS_METRIC_NAME' },
    );
  }
  return null;
}

// ── Evidence verifiers ──────────────────────────────────────────────────────

function verifyDelegated(claim, ctx) {
  const cmd = claim.evidence.command;
  const cached = ctx.commandCache.get(cmd);
  if (cached) return cached;

  const verdict = runCommand(cmd, ctx, { delegate: claim.evidence.delegate });
  ctx.commandCache.set(cmd, verdict);
  return verdict;
}

function verifyTool(claim, ctx) {
  const cmd = claim.evidence.command;
  const cached = ctx.commandCache.get(cmd);
  if (cached) return cached;
  const verdict = runCommand(cmd, ctx);
  ctx.commandCache.set(cmd, verdict);
  return verdict;
}

function runCommand(cmd, ctx, extra = {}) {
  const argv = cmd.split(/\s+/).filter(Boolean);
  if (argv.length === 0) {
    return makeVerdict('error', `evidence.command is empty`, { code: 'EMPTY_COMMAND' });
  }
  const [first, ...rest] = argv;
  const isNode = first === 'node';
  const exec = isNode ? process.execPath : first;
  const args = isNode ? rest : rest;
  try {
    execFileSync(exec, args, {
      cwd: ctx.rootDir,
      stdio: 'pipe',
      env: { ...process.env, ...(ctx.env || {}) },
    });
    return makeVerdict('pass', `command exited 0: ${cmd}`, { command: cmd, ...extra });
  } catch (err) {
    const code = typeof err.status === 'number' ? err.status : 1;
    if (code === 2 || code === 3) {
      return makeVerdict('skipped', `command exited ${code} (missing dep / infra): ${cmd}`, {
        command: cmd,
        exitCode: code,
        ...extra,
      });
    }
    return makeVerdict('error', `command exited ${code}: ${cmd}`, {
      command: cmd,
      exitCode: code,
      stderr: (err.stderr || '').toString().slice(0, 400),
      ...extra,
    });
  }
}

function verifyArtifact(claim, ctx) {
  const artifactPath = path.resolve(ctx.rootDir, claim.evidence.artifactPath);
  if (!fs.existsSync(artifactPath)) {
    return makeVerdict('unsupported', `artifact missing: ${claim.evidence.artifactPath}`, {
      code: 'MISSING_ARTIFACT',
      artifactPath: claim.evidence.artifactPath,
    });
  }
  if (claim.evidence.parse === 'json') {
    try {
      readJson(artifactPath);
    } catch (err) {
      return makeVerdict('error', `artifact does not parse as JSON: ${claim.evidence.artifactPath}`, {
        code: 'ARTIFACT_PARSE_ERROR',
        detail: err.message,
      });
    }
  }
  const stale = checkFreshness(claim, fs.statSync(artifactPath).mtime, ctx.now);
  if (stale) return stale;
  return makeVerdict('pass', `artifact present: ${claim.evidence.artifactPath}`);
}

function verifyFilePresence(claim, ctx) {
  const missing = claim.evidence.paths.filter((p) => !fs.existsSync(path.resolve(ctx.rootDir, p)));
  if (missing.length === 0) {
    return makeVerdict('pass', `${claim.evidence.paths.length} file(s) present`, {
      paths: claim.evidence.paths,
    });
  }
  return makeVerdict('unsupported', `missing required path(s): ${missing.join(', ')}`, {
    code: 'MISSING_PATH',
    missing,
  });
}

function verifyVersionMatch(claim, ctx) {
  const pkg = ctx.packageJson;
  if (!pkg || typeof pkg.version !== 'string') {
    return makeVerdict('error', `package.json has no version field`, { code: 'NO_PACKAGE_VERSION' });
  }
  const expected = pkg.version;
  return assertReadmeMatch(claim, ctx, expected, 'version');
}

function verifyEnginesMatch(claim, ctx) {
  const pkg = ctx.packageJson;
  const engines = pkg?.engines?.node || '';
  const major = (engines.match(/(\d+)/) || [])[1];
  if (!major) {
    return makeVerdict('error', `package.json#engines.node not parseable: "${engines}"`, {
      code: 'NO_ENGINES_NODE',
    });
  }
  return assertReadmeMatch(claim, ctx, major, 'engines.node major');
}

function verifyStatBadge(claim, ctx) {
  const { exists, stats, mtime } = ctx.statsSnapshot || { exists: false, stats: null, mtime: null };
  const liveStats = ctx.liveStats || null;
  if (!liveStats && !exists) {
    return makeVerdict('unsupported', `stats source unavailable — run \`node tools/cobolt-stat-source.js --print\``, {
      code: 'STATS_MISSING',
    });
  }

  const stale = !liveStats ? checkFreshness(claim, mtime, ctx.now) : null;
  if (stale) return stale;

  const value = liveStats?.[claim.evidence.statKey] ?? stats?.[claim.evidence.statKey];
  if (value === undefined || value === null) {
    return makeVerdict('unsupported', `stats source missing key "${claim.evidence.statKey}"`, {
      code: 'STATS_KEY_MISSING',
    });
  }

  const re = new RegExp(claim.evidence.readmePattern);
  const match = ctx.readmeContent.match(re);
  if (!match || typeof match[1] === 'undefined') {
    return makeVerdict('unsupported', `README pattern not found: /${claim.evidence.readmePattern}/`, {
      code: 'README_PATTERN_NOT_FOUND',
      pattern: claim.evidence.readmePattern,
    });
  }
  const readmeNumber = Number(match[1]);
  const tolerance = claim.evidence.tolerance || 0;
  const drift = Math.abs(readmeNumber - Number(value));
  if (drift > tolerance) {
    return makeVerdict(
      'unsupported',
      `README badge says ${readmeNumber}, stats[${claim.evidence.statKey}] = ${value} (drift ${drift} > tolerance ${tolerance})`,
      { code: 'STAT_BADGE_DRIFT', expected: value, actual: readmeNumber, drift, tolerance },
    );
  }
  return makeVerdict('pass', `README badge ${readmeNumber} == stats[${claim.evidence.statKey}] ${value}`);
}

function verifyInternal(claim, ctx) {
  const fn = INTERNAL_VERIFIERS[claim.evidence.verifier];
  if (typeof fn !== 'function') {
    return makeVerdict('unsupported', `internal verifier not registered: ${claim.evidence.verifier}`, {
      code: 'INTERNAL_VERIFIER_MISSING',
    });
  }
  return fn(claim, ctx);
}

// Closed under AD-01: keywords/badges/CLAUDE.md must tell one runtime story.
// Adding any of these names back to package.json#keywords fails check:claims.
const UNSUPPORTED_RUNTIME_KEYWORDS = Object.freeze([
  'opencode',
  'gemini',
  'antigravity',
  'copilot',
  'cursor',
  'windsurf',
]);

function verifyNoUnsupportedRuntimes(_claim, ctx) {
  const pkg = ctx.packageJson || {};
  const keywords = Array.isArray(pkg.keywords) ? pkg.keywords : [];
  const found = keywords.filter((k) => UNSUPPORTED_RUNTIME_KEYWORDS.includes(String(k).toLowerCase()));
  if (found.length > 0) {
    return makeVerdict(
      'unsupported',
      `package.json#keywords advertises unsupported runtime(s): ${found.join(', ')}. ` +
        `Per AD-01, only runtimes with real install paths (\`bin/install.js --claude\`, \`bin/install.js --codex\`) ` +
        `may appear. Remove the keyword(s) or implement the install path before re-adding.`,
      {
        code: 'UNSUPPORTED_RUNTIME_KEYWORD',
        unsupported: found,
        allowed: ['claude-code', 'codex'],
      },
    );
  }
  return makeVerdict(
    'pass',
    `no unsupported runtime keywords (forbidden set: ${UNSUPPORTED_RUNTIME_KEYWORDS.join(', ')})`,
  );
}

const INTERNAL_VERIFIERS = {
  'no-unsupported-runtimes': verifyNoUnsupportedRuntimes,
};

function assertReadmeMatch(claim, ctx, expected, label) {
  const re = new RegExp(claim.evidence.readmePattern);
  const match = ctx.readmeContent.match(re);
  if (!match || typeof match[1] === 'undefined') {
    return makeVerdict('unsupported', `README pattern not found: /${claim.evidence.readmePattern}/`, {
      code: 'README_PATTERN_NOT_FOUND',
      pattern: claim.evidence.readmePattern,
    });
  }
  if (match[1] !== expected) {
    return makeVerdict('unsupported', `README ${label} = "${match[1]}", expected "${expected}"`, {
      code: 'VERSION_DRIFT',
      expected,
      actual: match[1],
    });
  }
  return makeVerdict('pass', `README ${label} == "${expected}"`);
}

function checkFreshness(claim, mtime, now) {
  const window = claim.freshness?.windowDays;
  if (!window) return null;
  const age = ageDaysFrom(mtime, now);
  if (age === null) return null;
  if (age > window) {
    return makeVerdict('stale', `evidence age ${age.toFixed(1)} days > windowDays ${window}`, {
      code: 'STALE_EVIDENCE',
      ageDays: Number(age.toFixed(1)),
      windowDays: window,
    });
  }
  return null;
}

const KIND_DISPATCH = {
  delegated: verifyDelegated,
  tool: verifyTool,
  artifact: verifyArtifact,
  'file-presence': verifyFilePresence,
  'version-match': verifyVersionMatch,
  'engines-match': verifyEnginesMatch,
  'stat-badge': verifyStatBadge,
  internal: verifyInternal,
};

function verifyClaim(claim, ctx) {
  if (claim.status === 'deprecated') {
    return makeVerdict('pass', `claim deprecated — skipped`, { skipped: true });
  }
  const ambiguous = lintAmbiguousMetric(claim);
  if (ambiguous) return ambiguous;

  if (!claim.evidence || typeof claim.evidence.kind !== 'string') {
    return makeVerdict('unsupported', `claim has no evidence.kind`, { code: 'NO_EVIDENCE' });
  }
  const verifier = KIND_DISPATCH[claim.evidence.kind];
  if (!verifier) {
    return makeVerdict('unsupported', `unknown evidence.kind: ${claim.evidence.kind}`, {
      code: 'UNKNOWN_KIND',
    });
  }
  try {
    return verifier(claim, ctx);
  } catch (err) {
    return makeVerdict('error', `verifier crash: ${err.message}`, {
      code: 'VERIFIER_CRASH',
      stack: err.stack,
    });
  }
}

// ── Coverage lint — find README badges not registered in the manifest ──────

// Build a per-claim set of textual needles used to recognise that a README
// badge is "covered" by some manifest entry. Stat / version / engines claims
// supply their own regex; file-presence / delegated claims rely on claimText
// substring matching against the badge's alt-text and shield-text.
function claimNeedles(claim) {
  const needles = new Set();
  if (claim.evidence?.readmePattern) {
    needles.add({ kind: 'regex', value: claim.evidence.readmePattern });
  }
  if (typeof claim.claimText === 'string') {
    const norm = claim.claimText.toLowerCase().replace(/[\s_-]+/g, '');
    if (norm) needles.add({ kind: 'substring', value: norm });
  }
  return needles;
}

function detectCoverageGaps(manifest, readmeContent) {
  const allNeedles = manifest.claims.flatMap((c) => [...claimNeedles(c)]);

  const findings = [];
  const seenAlts = new Set();
  for (const m of readmeContent.matchAll(READMEDOM_BADGE_PATTERN)) {
    const alt = m[1];
    const badgeText = m[2];
    if (seenAlts.has(alt)) continue;
    seenAlts.add(alt);

    // Coverage-gap detection only flags badges that make a buyer-facing claim:
    //   - Quantitative stat with a recognized noun suffix (`207-Specialist_Agents`,
    //     `tests-680_files`).
    //   - Version pin (`v0.56.9`, `version-0.56.9`).
    //   - Readiness keyword (`Docker-ready`, `WCAG_2.2-AA`).
    //   - Status-band keyword (`license-Proprietary`, `runtime-Claude_Code`,
    //     `node-%3E%3D20`).
    // Decorative section tags / nav anchors / category labels (`01-PLANNING_ENGINE`,
    // `06-Handoff`) are NOT claims — they index sections, not quantities.
    const STAT_NOUN =
      /-(?:Specialist_Agents|Pipeline_Skills|Lifecycle_Hooks|Deterministic_Tools|JSON_Schemas|Public_Workflows|Security_Tools|Quality_Tools|Parallel_Reviewers|ISO_NIST_DORA_Standards|Patent_Candidates|files?|cases?|count|tests?|users?)\b/;
    const looksLikeClaim =
      (/^\d/.test(badgeText) && STAT_NOUN.test(badgeText)) ||
      /\bv\d+\.\d+\.\d+\b/.test(badgeText) ||
      /-(?:ready|AA|AAA|Yes|Pass)\b/i.test(badgeText) ||
      /^(version|node|tests|license|runtime|WCAG|Docker|K8s|Kubernetes)-/i.test(badgeText);
    if (!looksLikeClaim) continue;

    const blob = `<img alt="${alt}" src="https://img.shields.io/badge/${badgeText}`;
    const altNorm = alt.toLowerCase().replace(/[\s_-]+/g, '');
    const badgeNorm = badgeText.toLowerCase().replace(/[\s_%-]+/g, '');

    let covered = false;
    for (const needle of allNeedles) {
      if (needle.kind === 'regex') {
        if (new RegExp(needle.value).test(blob)) {
          covered = true;
          break;
        }
      } else if (needle.kind === 'substring') {
        if (altNorm.includes(needle.value) || needle.value.includes(altNorm) || badgeNorm.includes(needle.value)) {
          covered = true;
          break;
        }
      }
    }
    if (!covered) {
      findings.push({ alt, badge: badgeText });
    }
  }
  return findings;
}

// ── Orchestrator ────────────────────────────────────────────────────────────

function run(options = {}) {
  const rootDir = path.resolve(options.rootDir || TOOL_ROOT);
  const manifestPath = options.manifestPath || DEFAULT_MANIFEST;
  const readmePath = options.readmePath || DEFAULT_README;
  const packageJsonPath = options.packageJsonPath || DEFAULT_PACKAGE_JSON;
  const statsPath = options.statsPath || DEFAULT_STATS;

  const manifest = options.manifest || loadManifest(manifestPath);
  detectCycle(manifest);

  const readmeContent = options.readmeContent ?? fs.readFileSync(readmePath, 'utf8');
  const packageJson = options.packageJson ?? readJson(packageJsonPath);
  const statsSnapshot = options.statsSnapshot ?? safeReadStats(statsPath);
  const liveStats = options.liveStats === undefined ? collectLiveStats(rootDir) : options.liveStats;
  const now = options.now || new Date();

  const ctx = {
    rootDir,
    readmeContent,
    packageJson,
    statsSnapshot,
    liveStats,
    now,
    commandCache: new Map(),
    env: options.env || {},
  };

  const results = manifest.claims.map((claim) => ({
    claim,
    verdict: verifyClaim(claim, ctx),
  }));

  const coverageGaps = options.skipCoverage ? [] : detectCoverageGaps(manifest, readmeContent);

  const counts = results.reduce(
    (acc, r) => {
      acc[r.verdict.status] = (acc[r.verdict.status] || 0) + 1;
      return acc;
    },
    { pass: 0, stale: 0, unsupported: 0, error: 0, skipped: 0 },
  );

  // Active claims drive gating; deferred / deprecated are reported but not gated.
  const gateFailures = results.filter(
    (r) => r.claim.status === 'active' && ['stale', 'unsupported', 'error'].includes(r.verdict.status),
  );
  const skippedActive = results.filter((r) => r.claim.status === 'active' && r.verdict.status === 'skipped');

  const ok = gateFailures.length === 0 && coverageGaps.length === 0;
  return {
    ok,
    counts,
    coverageGaps,
    results,
    gateFailures,
    skippedActive,
    manifestPath,
    generatedAt: now.toISOString(),
  };
}

// ── Reporting ───────────────────────────────────────────────────────────────

function formatReportMarkdown(report, options = {}) {
  const lines = [];
  lines.push('# CoBolt Public Claims Ledger');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}  `);
  lines.push(`Manifest: \`${path.relative(TOOL_ROOT, report.manifestPath)}\`  `);
  lines.push(`Verdict: **${report.ok ? 'PASS' : 'FAIL'}**`);
  lines.push('');
  lines.push(
    `pass: ${report.counts.pass} · stale: ${report.counts.stale} · unsupported: ${report.counts.unsupported} · error: ${report.counts.error} · skipped: ${report.counts.skipped}`,
  );
  lines.push('');
  lines.push('| ID | Category | Claim | Owner | Status | Verdict | Detail |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const { claim, verdict } of report.results) {
    const detail = verdict.message ? verdict.message.replace(/\|/g, '\\|') : '';
    lines.push(
      `| \`${claim.id}\` | ${claim.category} | ${claim.claimText.replace(/\|/g, '\\|')} | ${claim.owner} | ${claim.status} | **${verdict.status}** | ${detail} |`,
    );
  }
  if (report.coverageGaps.length > 0) {
    lines.push('');
    lines.push('## README badges not registered in manifest');
    lines.push('');
    for (const gap of report.coverageGaps) {
      lines.push(`- alt=\`${gap.alt}\` badge=\`${gap.badge}\``);
    }
  }
  if (options.includeFooter !== false) {
    lines.push('');
    lines.push('---');
    lines.push(`Produced by \`tools/${SELF_NAME}\` (SF-08).`);
  }
  return `${lines.join('\n')}\n`;
}

function writeReport(report, options = {}) {
  const dir = options.outDir || DEFAULT_REPORT_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const mdPath = path.join(dir, 'public-claims.md');
  const jsonPath = path.join(dir, 'public-claims.json');
  fs.writeFileSync(mdPath, formatReportMarkdown(report), 'utf8');
  const jsonView = {
    ok: report.ok,
    generatedAt: report.generatedAt,
    counts: report.counts,
    manifestPath: path.relative(TOOL_ROOT, report.manifestPath),
    coverageGaps: report.coverageGaps,
    claims: report.results.map(({ claim, verdict }) => ({
      id: claim.id,
      category: claim.category,
      claimText: claim.claimText,
      owner: claim.owner,
      status: claim.status,
      readmeAnchor: claim.readmeAnchor,
      evidenceKind: claim.evidence ? claim.evidence.kind : null,
      verdict,
    })),
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(jsonView, null, 2)}\n`, 'utf8');
  return { mdPath, jsonPath };
}

function formatHuman(report) {
  if (report.ok) {
    return [
      `public-claims: PASS (${report.counts.pass} passed, ${report.counts.skipped} skipped)`,
      report.coverageGaps.length > 0
        ? `  warning: ${report.coverageGaps.length} README badge(s) not registered in manifest`
        : null,
    ]
      .filter(Boolean)
      .join('\n');
  }
  const lines = [
    `public-claims: FAIL (${report.gateFailures.length} active claim(s) failed, ${report.coverageGaps.length} coverage gap(s))`,
    `  pass=${report.counts.pass} stale=${report.counts.stale} unsupported=${report.counts.unsupported} error=${report.counts.error} skipped=${report.counts.skipped}`,
  ];
  for (const { claim, verdict } of report.gateFailures) {
    lines.push(`  - [${verdict.status.toUpperCase()}] ${claim.id} — ${verdict.message}`);
  }
  if (report.coverageGaps.length > 0) {
    lines.push(`  - ${report.coverageGaps.length} README badge(s) not registered in manifest:`);
    for (const gap of report.coverageGaps.slice(0, 5)) {
      lines.push(`    · alt="${gap.alt}" badge="${gap.badge}"`);
    }
  }
  return lines.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { mode: 'check', json: false, outDir: null, manifest: null, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') args.mode = 'check';
    else if (a === '--print') args.mode = 'print';
    else if (a === '--report') args.mode = 'report';
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.mode = 'help';
    else if (a === '--out' || a === '--out-dir') args.outDir = argv[++i];
    else if (a.startsWith('--out=')) args.outDir = a.slice('--out='.length);
    else if (a === '--manifest') args.manifest = argv[++i];
    else if (a.startsWith('--manifest=')) args.manifest = a.slice('--manifest='.length);
    else if (a === '--root') args.root = argv[++i];
    else if (a.startsWith('--root=')) args.root = a.slice('--root='.length);
    else if (a === '--no-coverage') args.skipCoverage = true;
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      'cobolt-public-claims — verify README/product-copy public claims (SF-08)',
      '',
      'Usage:',
      '  node tools/cobolt-public-claims.js [--check|--print|--report] [--json]',
      '                                     [--manifest <path>] [--root <dir>] [--out <dir>]',
      '                                     [--no-coverage]',
      '',
      'Modes:',
      '  --check (default)  Gate mode — exits non-zero on drift.',
      '  --print            List every claim + verdict; never fails.',
      '  --report           Write _cobolt-output/reports/public-claims.{md,json}.',
      '',
      'Exit codes (per tools/CLAUDE.md):',
      '  0  PASS / report mode',
      '  1  Drift / unhandled error',
      '  2  Evidence command exit 2/3 (missing dep / infra)',
      '',
    ].join('\n'),
  );
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.mode === 'help') {
      printHelp();
      process.exit(0);
    }
    const opts = {};
    if (args.manifest) opts.manifestPath = path.resolve(args.manifest);
    if (args.root) opts.rootDir = path.resolve(args.root);
    if (args.skipCoverage) opts.skipCoverage = true;
    const report = run(opts);

    if (args.mode === 'report') {
      const out = writeReport(report, { outDir: args.outDir ? path.resolve(args.outDir) : undefined });
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ ok: report.ok, ...out, counts: report.counts }, null, 2)}\n`);
      } else {
        process.stdout.write(`public-claims: report written to ${out.mdPath}\n`);
      }
      process.exit(0);
    }

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: report.ok, counts: report.counts, gateFailures: report.gateFailures.map(({ claim, verdict }) => ({ id: claim.id, status: claim.status, verdict })), coverageGaps: report.coverageGaps }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(`${formatHuman(report)}\n`);
    }

    if (args.mode === 'print') {
      process.exit(0);
    }

    if (!report.ok) {
      process.exit(1);
    }
    if (report.skippedActive.length > 0) {
      // At least one claim's evidence command exited 2/3 — surface skip code.
      process.exit(2);
    }
    process.exit(0);
  } catch (err) {
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: err.message }, null, 2)}\n`);
    } else {
      process.stderr.write(`public-claims: ${err.message}\n${err.stack ? `${err.stack}\n` : ''}`);
    }
    process.exit(1);
  }
}

module.exports = {
  AMBIGUOUS_METRIC_PATTERN,
  DEFAULT_MANIFEST,
  INTERNAL_VERIFIERS,
  UNSUPPORTED_RUNTIME_KEYWORDS,
  collectLiveStats,
  detectCoverageGaps,
  detectCycle,
  formatHuman,
  formatReportMarkdown,
  KIND_DISPATCH,
  lintAmbiguousMetric,
  loadManifest,
  parseArgs,
  run,
  verifyArtifact,
  verifyClaim,
  verifyDelegated,
  verifyEnginesMatch,
  verifyFilePresence,
  verifyInternal,
  verifyNoUnsupportedRuntimes,
  verifyStatBadge,
  verifyTool,
  verifyVersionMatch,
  writeReport,
};
