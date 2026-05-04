#!/usr/bin/env node

// CoBolt Review Tool Rollup — v0.20.8
//
// Consolidates review-stage inputs into a single priority-aware
// `review-findings.json` that `cobolt-review-handoff` and `cobolt-fix` consume.
//
// Prior to v0.20.8 the review pipeline had three independent problems:
//   1. Build-stage `M{n}-issues-registry.json` (WIRE / APIWIRE / LIFECYCLE /
//      ILL findings from v0.20.7 build step 04B) was written to disk but
//      `cobolt-review` step 01 never read it. Those findings never reached
//      fix-lead.
//   2. The v0.20.7 priority matrix added to `finding-prefixes.md` was
//      advisory text only. `cobolt-review-handoff` still blocked only on
//      `severity: critical|high` — ignoring prefix-tier mapping entirely.
//   3. Review sidecars (`hallucination-log.json`, `rejected-phantoms.json`,
//      `finding-verification.json`) were produced per-step but not reconciled
//      into a single trustworthy registry before handoff.
//
// This tool closes all three in one deterministic pass.
//
// Usage:
//   node tools/cobolt-review-tool-rollup.js \
//     --review-dir _cobolt-output/latest/review \
//     --build-registry _cobolt-output/latest/build/M1/M1-issues-registry.json \
//     --output _cobolt-output/latest/review/review-findings.json \
//     --merge [--json] [--dry-run]
//
// Exit codes:
//   0 = success (consolidated review-findings.json written)
//   1 = cannot parse a required input
//   2 = build registry >200 bytes but zero findings promoted (silent-drop)
//   3 = output write failed
//
// The priority matrix is loaded at runtime from the canonical markdown table
// in `source/skills/cobolt-review/references/finding-prefixes.md` §Priority
// Matrix via `lib/cobolt-priority-matrix.js`. The previous in-file dict was
// removed in v0.20.9 because it had drifted from the markdown source — a
// classic case where two copies "kept in sync by comment" diverged the moment
// either was edited without checking the other.
//
// Do NOT reintroduce a hardcoded matrix here. If the loader cannot find
// finding-prefixes.md it throws — that's a fail-closed install bug, not a
// reason to bypass the source-of-truth.

const fs = require('node:fs');
const path = require('node:path');
const { loadPriorityMatrix, lookupPriority, PINNED_P0_IDS } = require(
  path.resolve(__dirname, '..', 'lib', 'cobolt-priority-matrix.js'),
);

const DEFAULTS = {
  reviewDir: null,
  buildRegistry: null,
  output: null,
  summaryOutput: null,
  merge: false,
  json: false,
  dryRun: false,
};

// PRIORITY_MATRIX is exported for back-compat with consumers (tests + other
// tools) that read `PRIORITY_MATRIX[prefix][severity]` directly. Sourced from
// the markdown loader — never edit this dict by hand; edit finding-prefixes.md.
const PRIORITY_MATRIX = loadPriorityMatrix().matrix;

// resolvePriority(prefix, severity, id, unmappedLog) -> 'P0'|'P1'|'P2'|'P3'|'P4'
//
// Returns a string for back-compat with existing callers. Wraps the shared
// lookupPriority() helper with two pieces of policy that are review-rollup
// specific (and intentionally NOT in the loader, which other consumers
// reuse with different escalation rules):
//
//   1. Pinned-P0 id override — SEC010/SEC011/OPS004/OPS009/INT002 force P0
//      regardless of (prefix, severity), per finding-prefixes.md §Backwards-
//      Compatibility (lines 156-157).
//   2. Fail-closed unmapped escalation — unmapped (prefix, severity) pairs
//      with severity in {critical, high} are escalated to P1 instead of the
//      loader's default P3, per finding-prefixes.md §Applying the Matrix
//      (line 153).
function resolvePriority(prefix, severity, id, unmappedLog) {
  const idStr = String(id || '').toUpperCase();
  if (PINNED_P0_IDS.has(idStr)) return 'P0';

  const pfx = String(prefix || '').toUpperCase();
  const sev = String(severity || 'medium').toLowerCase();

  const result = lookupPriority(pfx, sev);
  if (result.unmapped) {
    const reason = result.source === 'unknown-prefix' ? 'prefix-not-in-matrix' : 'severity-empty-in-matrix';
    unmappedLog.push({ prefix: pfx, severity: sev, id: idStr, reason });
    if (sev === 'critical' || sev === 'high') return 'P1';
    return 'P3';
  }
  return result.priority;
}

// --- Helpers ---

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--review-dir') args.reviewDir = argv[++i];
    else if (a === '--build-registry') args.buildRegistry = argv[++i];
    else if (a === '--output') args.output = argv[++i];
    else if (a === '--summary-output') args.summaryOutput = argv[++i];
    else if (a === '--merge') args.merge = true;
    else if (a === '--json') args.json = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '-h' || a === '--help') args.help = true;
  }
  return args;
}

function readJsonSafe(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const raw =
      buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe
        ? buffer.toString('utf16le').replace(/^\uFEFF/, '')
        : buffer.toString('utf8').replace(/^\uFEFF/, '');
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

function defaultReviewDir() {
  return path.resolve('_cobolt-output/latest/review');
}

function loadReviewFindings(reviewDir) {
  const p = path.join(reviewDir, 'review-findings.json');
  if (!fs.existsSync(p)) return { existing: null, findings: [] };
  const parsed = readJsonSafe(p);
  if (!parsed.ok) throw new Error(`review-findings.json invalid: ${parsed.error}`);
  const data = parsed.data || {};
  const findings = Array.isArray(data.findings) ? data.findings : [];
  return { existing: data, findings };
}

function loadVerification(reviewDir) {
  const p = path.join(reviewDir, 'finding-verification.json');
  if (!fs.existsSync(p)) return { byId: new Map(), raw: null };
  const parsed = readJsonSafe(p);
  if (!parsed.ok) return { byId: new Map(), raw: null };
  const data = parsed.data || {};
  const results = Array.isArray(data.results) ? data.results : Array.isArray(data.findings) ? data.findings : [];
  const byId = new Map();
  for (const r of results) {
    if (r?.id) byId.set(String(r.id), r);
  }
  return { byId, raw: data };
}

function loadRejectedPhantoms(reviewDir) {
  const p = path.join(reviewDir, 'rejected-phantoms.json');
  if (!fs.existsSync(p)) return new Set();
  const parsed = readJsonSafe(p);
  if (!parsed.ok) return new Set();
  const data = parsed.data || {};
  const rejected = Array.isArray(data.rejected) ? data.rejected : Array.isArray(data) ? data : [];
  const ids = new Set();
  for (const r of rejected) {
    const id = typeof r === 'string' ? r : r?.id;
    if (id) ids.add(String(id));
  }
  return ids;
}

function loadBuildRegistry(buildRegistryPath) {
  if (!buildRegistryPath) return { findings: [], path: null, parsed: false };
  const p = path.resolve(buildRegistryPath);
  if (!fs.existsSync(p)) return { findings: [], path: p, parsed: false };
  const parsed = readJsonSafe(p);
  if (!parsed.ok) throw new Error(`build registry invalid: ${parsed.error}`);
  const data = parsed.data || {};
  const issues = Array.isArray(data.issues) ? data.issues : [];
  // Transform build-registry issues into review-findings.json shape.
  const findings = issues.map((i) => ({
    id: i.id,
    prefix: i.prefix,
    severity: i.severity || 'medium',
    priority: i.priority || null,
    category: i.category,
    description: i.summary || '',
    title: i.summary || '',
    location: { file: Array.isArray(i.affectedAreas) ? i.affectedAreas[0] : i.affectedAreas || '', line: 0 },
    recommendation: i.recommendation,
    evidence: i.evidence,
    sourceTool: i.sourceTool,
    sourceArtifacts: i.sourceArtifacts,
    _origin: 'build-registry',
  }));
  return { findings, path: p, parsed: true, byteSize: fs.statSync(p).size };
}

function dedupeKey(f) {
  const id = String(f.id || '');
  const prefix = String(f.prefix || '').toUpperCase();
  const loc = String(f.location?.file || (Array.isArray(f.affectedAreas) ? f.affectedAreas[0] : f.affectedAreas) || '');
  const summary = (f.description || f.title || f.summary || '').slice(0, 80);
  return `${prefix}:${id}:${loc}:${summary}`;
}

function consolidate(args) {
  const reviewDir = path.resolve(args.reviewDir || defaultReviewDir());
  if (!fs.existsSync(reviewDir)) fs.mkdirSync(reviewDir, { recursive: true });

  const outputPath = args.output ? path.resolve(args.output) : path.join(reviewDir, 'review-findings.json');

  const { existing, findings: existingFindings } = loadReviewFindings(reviewDir);
  const { byId: verificationById } = loadVerification(reviewDir);
  const rejectedIds = loadRejectedPhantoms(reviewDir);

  let buildRegistry;
  try {
    buildRegistry = loadBuildRegistry(args.buildRegistry);
  } catch (err) {
    return { ok: false, reason: 'build-registry-invalid', error: String(err?.message || err) };
  }

  const unmappedLog = [];
  const seen = new Set();
  const consolidated = [];

  const all = [...existingFindings, ...buildRegistry.findings];
  for (const f of all) {
    if (!f || typeof f !== 'object') continue;
    // Drop phantoms that the verifier already rejected.
    if (rejectedIds.has(String(f.id))) continue;
    // Attach verification metadata when present.
    const verif = verificationById.get(String(f.id));
    if (verif && !f.verification) f.verification = verif;
    // Deduplicate by (prefix, id, location, summary[:80]).
    const key = dedupeKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    // Apply priority-matrix lookup — honor existing explicit priority if set.
    const priority = f.priority || resolvePriority(f.prefix, f.severity, f.id, unmappedLog);
    consolidated.push({ ...f, priority });
  }

  // Compute blocking list: any P0, plus any finding that was already-blocking
  // under the pre-v0.20.8 rule (verified critical/high) for back-compat.
  const blocking = consolidated.filter((f) => {
    if (f.priority === 'P0') return true;
    const verif = f.verification || {};
    const status = String(verif.status || '').toLowerCase();
    const sev = String(f.severity || '').toLowerCase();
    return status === 'verified' && (sev === 'critical' || sev === 'high');
  });

  const out = {
    ...(existing || {}),
    schemaVersion: '1.0',
    rolledUpAt: new Date().toISOString(),
    rolledUpBy: 'cobolt-review-tool-rollup',
    findings: consolidated,
    meta: {
      ...(existing?.meta || {}),
      rollup: {
        reviewFindingsIn: existingFindings.length,
        buildRegistryIn: buildRegistry.findings.length,
        buildRegistryPath: buildRegistry.path,
        verificationAttached: verificationById.size,
        phantomsRejected: rejectedIds.size,
        dedupedOut: consolidated.length,
        unmappedPrefixSeverity: unmappedLog.length,
        blocking: blocking.map((f) => ({ id: f.id, prefix: f.prefix, priority: f.priority })),
      },
    },
  };

  // Write audit log for unmapped prefix/severity combinations.
  if (unmappedLog.length > 0 && !args.dryRun) {
    try {
      const auditDir = path.resolve('_cobolt-output/audit');
      if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
      const logPath = path.join(auditDir, 'unmapped-finding-prefix.jsonl');
      const lines = unmappedLog
        .map((entry) =>
          JSON.stringify({
            at: new Date().toISOString(),
            tool: 'cobolt-review-tool-rollup',
            ...entry,
          }),
        )
        .join('\n');
      fs.appendFileSync(logPath, `${lines}\n`, 'utf8');
    } catch {
      /* best-effort audit log */
    }
  }

  // Silent-drop guard for build registry: if we had >200 bytes and zero findings
  // came through, the schema probably drifted.
  let silentDrop = false;
  if (args.merge && buildRegistry.parsed && buildRegistry.byteSize > 200 && buildRegistry.findings.length === 0) {
    silentDrop = true;
  }

  if (!args.dryRun) {
    try {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
    } catch (err) {
      return { ok: false, reason: 'output-write-failed', error: String(err?.message || err) };
    }
  }

  return {
    ok: true,
    reviewDir,
    outputPath,
    silentDrop,
    summary: out.meta.rollup,
  };
}

// --- CLI ---

if (require.main === module) {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      'Usage: cobolt-review-tool-rollup --review-dir <path> [--build-registry <path>] [--output <path>] [--summary-output <path>] [--merge] [--json] [--dry-run]',
    );
    process.exit(0);
  }

  const result = consolidate(args);
  if (args.summaryOutput) {
    try {
      const summaryPath = path.resolve(args.summaryOutput);
      fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
      fs.writeFileSync(summaryPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    } catch (err) {
      console.error(`[review-tool-rollup] FAILED: summary-output-write-failed — ${String(err?.message || err)}`);
      process.exit(3);
    }
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.ok) {
    console.error(`[review-tool-rollup] FAILED: ${result.reason}${result.error ? ` — ${result.error}` : ''}`);
  } else {
    console.log(`[review-tool-rollup] reviewDir=${result.reviewDir}`);
    console.log(`  in: ${result.summary.reviewFindingsIn} review + ${result.summary.buildRegistryIn} build-registry`);
    console.log(
      `  out: ${result.summary.dedupedOut} deduped, ${result.summary.blocking.length} P0-blocking, ${result.summary.phantomsRejected} phantoms dropped`,
    );
    if (result.summary.unmappedPrefixSeverity > 0) {
      console.log(`  unmapped (prefix,severity) pairs: ${result.summary.unmappedPrefixSeverity} — logged to audit/`);
    }
    if (result.silentDrop) {
      console.log('  WARN: build-registry >200 bytes but zero findings propagated — verify schema');
    }
  }

  if (!result.ok) {
    process.exit(result.reason === 'output-write-failed' ? 3 : 1);
  }
  // silentDrop = build-registry >200 bytes but zero findings propagated. This
  // is a schema-drift smoke alarm = hard error (per tools/CLAUDE.md), not a
  // missing-dep skip.
  if (result.silentDrop) process.exit(1);
  process.exit(0);
}

module.exports = { consolidate, resolvePriority, PRIORITY_MATRIX, PINNED_P0_IDS };
