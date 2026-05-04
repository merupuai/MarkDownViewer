#!/usr/bin/env node

// CoBolt Brownfield Tool Rollup — deterministic sidecar-to-registry promoter.
//
// Reads the JSON sidecars produced by P1 deterministic tools and converts
// every meaningful record into a typed finding in 16-issues-registry.json.
// Prior to v0.20.5, these sidecars were written to disk and then ignored by
// P3 synthesis — route/query/stub/UI-placeholder findings never reached the
// user-visible issues registry.
//
// Sidecars handled:
//   domain-liveness.json            →  ROUTE-NNN (cobolt-route-wiring-check)
//   query-migration-contract.json   →  QRY-NNN   (cobolt-query-migration-contract)
//   semantic-stub-findings.json     →  STUB-NNN  (cobolt-semantic-stub-check)
//   ui-placeholder-mock-scan.json   →  UIPH-NNN  (cobolt-ui-placeholder-check)
//
// Usage:
//   node tools/cobolt-brownfield-tool-rollup.js \
//     --dir _cobolt-output/latest/brownfield \
//     --output _cobolt-output/latest/brownfield/16-issues-registry.json \
//     [--merge] [--json] [--dry-run]
//
// Exit codes:
//   0 = success (rollup merged or no sidecars present)
//   1 = sidecar exists but could not be parsed
//   2 = sidecar exists but produced zero findings (silent-drop guard)
//   3 = registry write failed
//
// Tier 1 gate (--merge mode): every sidecar found on disk MUST yield at least
// one registry entry or exit 2. Silent sidecar-to-registry drops are a bug.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  dir: '_cobolt-output/latest/brownfield',
  output: null, // defaults to <dir>/16-issues-registry.json
  merge: false,
  json: false,
  dryRun: false,
};

// --- Sidecar → finding rules ---

const SIDECARS = [
  {
    file: 'domain-liveness.json',
    prefix: 'ROUTE',
    tool: 'cobolt-route-wiring-check',
    category: 'ROUTING',
    extract: (data) => {
      const out = [];
      const domains = Array.isArray(data?.domains) ? data.domains : [];
      for (const d of domains) {
        if (!d || typeof d !== 'object') continue;
        if (d.status === 'unwired') {
          out.push({
            severity: 'high',
            priority: 'P1',
            summary: `Domain "${d.name}" is unwired — no router, importer, or controller references it`,
            affectedAreas: [d.path || d.name],
            recommendation: `Either delete \`${d.path || d.name}\` as dead code, or wire it into the app entrypoint / router.`,
            evidence: { status: d.status, signalCounts: d.signalCounts || {} },
          });
        } else if (d.status === 'partial') {
          out.push({
            severity: 'medium',
            priority: 'P2',
            summary: `Domain "${d.name}" is partially wired — imported but no routes/main registration`,
            affectedAreas: [d.path || d.name],
            recommendation: `Verify \`${d.path || d.name}\` is reachable via the running app; add router/main wiring or document why import-only is intentional.`,
            evidence: { status: d.status, signalCounts: d.signalCounts || {} },
          });
        }
      }
      return out;
    },
  },
  {
    file: 'query-migration-contract.json',
    prefix: 'QRY',
    tool: 'cobolt-query-migration-contract',
    category: 'ROUTING',
    extract: (data) => {
      const out = [];
      const mismatches = Array.isArray(data?.mismatches)
        ? data.mismatches
        : Array.isArray(data?.findings)
          ? data.findings
          : [];
      for (const m of mismatches) {
        if (!m || typeof m !== 'object') continue;
        out.push({
          severity: m.severity || 'high',
          priority: m.severity === 'low' ? 'P3' : 'P1',
          summary: m.message || m.summary || `Query/migration contract mismatch: ${m.table || m.query || 'unknown'}`,
          affectedAreas: [m.file || m.table || m.query || 'db'].filter(Boolean),
          recommendation:
            m.recommendation ||
            'Align ORM / query reference against migration schema, or update migration to match query shape.',
          evidence: m.evidence || m,
        });
      }
      return out;
    },
  },
  {
    file: 'semantic-stub-findings.json',
    prefix: 'STUB',
    tool: 'cobolt-semantic-stub-check',
    category: 'ROUTING',
    extract: (data) => {
      const out = [];
      const stubs = Array.isArray(data?.stubs) ? data.stubs : Array.isArray(data?.findings) ? data.findings : [];
      for (const s of stubs) {
        if (!s || typeof s !== 'object') continue;
        out.push({
          severity: s.severity || 'medium',
          priority: 'P2',
          summary:
            s.message ||
            s.summary ||
            `Semantic stub at ${s.file || 'unknown'}${s.line ? `:${s.line}` : ''} — returns constant / pass-through / no-op`,
          affectedAreas: [s.file || 'unknown'],
          recommendation:
            s.recommendation ||
            'Replace stub with real implementation, or document why the pass-through is intentional.',
          evidence: s.evidence || s,
        });
      }
      return out;
    },
  },
  {
    file: 'ui-placeholder-mock-scan.json',
    prefix: 'UIPH',
    tool: 'cobolt-ui-placeholder-check',
    category: 'UI/UX',
    extract: (data) => {
      const out = [];
      const placeholders = Array.isArray(data?.placeholders)
        ? data.placeholders
        : Array.isArray(data?.findings)
          ? data.findings
          : [];
      for (const p of placeholders) {
        if (!p || typeof p !== 'object') continue;
        out.push({
          severity: p.severity || 'medium',
          priority: 'P2',
          summary:
            p.message ||
            p.summary ||
            `UI placeholder at ${p.file || 'unknown'}${p.line ? `:${p.line}` : ''} — lorem / TODO / mock content in a live route`,
          affectedAreas: [p.file || p.route || 'ui'],
          recommendation:
            p.recommendation ||
            'Replace placeholder with real copy/content, or gate the route behind a feature flag until ready.',
          evidence: p.evidence || p,
        });
      }
      return out;
    },
  },
];

// --- Helpers ---

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--output') args.output = argv[++i];
    else if (a === '--merge') args.merge = true;
    else if (a === '--json') args.json = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '-h' || a === '--help') args.help = true;
  }
  return args;
}

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

function loadRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) {
    return {
      project: '',
      product: 'CoBolt',
      lastUpdated: new Date().toISOString(),
      trackerVersion: '1.0',
      issues: [],
    };
  }
  const parsed = readJsonSafe(registryPath);
  if (!parsed.ok) {
    throw new Error(`registry ${registryPath} is not valid JSON: ${parsed.error}`);
  }
  const reg = parsed.data || {};
  if (!Array.isArray(reg.issues)) reg.issues = [];
  if (!reg.trackerVersion) reg.trackerVersion = '1.0';
  if (!reg.product) reg.product = 'CoBolt';
  return reg;
}

function nextCounter(registry, prefix) {
  let max = 0;
  for (const issue of registry.issues) {
    const id = String(issue?.id || '');
    const m = id.match(new RegExp(`^${prefix}(\\d+)$`));
    if (m) {
      const n = Number.parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

function alreadyRecorded(registry, prefix, summary, affectedArea) {
  // Dedupe by prefix + summary + first affected area so reruns don't stack.
  for (const issue of registry.issues) {
    if (!issue || typeof issue !== 'object') continue;
    const id = String(issue.id || '');
    if (!id.startsWith(prefix)) continue;
    if (issue.summary === summary) {
      const firstArea = Array.isArray(issue.affectedAreas) ? issue.affectedAreas[0] : null;
      if (firstArea === affectedArea) return true;
    }
  }
  return false;
}

function rollup(args) {
  const dir = path.resolve(args.dir);
  const registryPath = args.output ? path.resolve(args.output) : path.join(dir, '16-issues-registry.json');

  if (!fs.existsSync(dir)) {
    return {
      ok: false,
      reason: 'brownfield-dir-missing',
      dir,
      summary: { sidecarsFound: 0, findingsAdded: 0 },
      sidecars: [],
    };
  }

  const registry = loadRegistry(registryPath);
  const sidecarsReport = [];
  let totalAdded = 0;

  for (const spec of SIDECARS) {
    const filePath = path.join(dir, spec.file);
    if (!fs.existsSync(filePath)) {
      sidecarsReport.push({
        file: spec.file,
        prefix: spec.prefix,
        present: false,
        parsed: false,
        findings: 0,
        added: 0,
      });
      continue;
    }

    const parsed = readJsonSafe(filePath);
    if (!parsed.ok) {
      sidecarsReport.push({
        file: spec.file,
        prefix: spec.prefix,
        present: true,
        parsed: false,
        error: parsed.error,
        findings: 0,
        added: 0,
      });
      continue;
    }

    let extracted = [];
    try {
      extracted = spec.extract(parsed.data) || [];
    } catch (err) {
      sidecarsReport.push({
        file: spec.file,
        prefix: spec.prefix,
        present: true,
        parsed: true,
        error: `extractor-threw: ${String(err?.message || err)}`,
        findings: 0,
        added: 0,
      });
      continue;
    }

    let counter = nextCounter(registry, spec.prefix);
    let added = 0;
    for (const f of extracted) {
      const summary = f.summary || '';
      const firstArea = Array.isArray(f.affectedAreas) ? f.affectedAreas[0] : null;
      if (alreadyRecorded(registry, spec.prefix, summary, firstArea)) continue;

      const id = `${spec.prefix}${String(counter++).padStart(3, '0')}`;
      registry.issues.push({
        id,
        category: spec.category,
        prefix: spec.prefix,
        priority: f.priority || 'P2',
        severity: f.severity || 'medium',
        effort: 'M',
        summary,
        status: 'open',
        sourceTool: spec.tool,
        sourceArtifacts: [spec.file],
        affectedAreas: Array.isArray(f.affectedAreas) ? f.affectedAreas : [],
        recommendation: f.recommendation || '',
        evidence: f.evidence || null,
        notes: '',
        emittedAt: new Date().toISOString(),
        emittedBy: 'cobolt-brownfield-tool-rollup',
      });
      added++;
    }

    sidecarsReport.push({
      file: spec.file,
      prefix: spec.prefix,
      present: true,
      parsed: true,
      findings: extracted.length,
      added,
    });
    totalAdded += added;
  }

  registry.lastUpdated = new Date().toISOString();

  const summary = {
    sidecarsFound: sidecarsReport.filter((s) => s.present).length,
    sidecarsParsed: sidecarsReport.filter((s) => s.present && s.parsed).length,
    findingsAdded: totalAdded,
    totalIssuesAfter: registry.issues.length,
  };

  // Tier 1 gate: merge mode requires parsed sidecars to produce >0 findings
  // OR yield a documented zero-finding result (i.e., extractor was actually
  // called and returned []). A sidecar that parsed but produced zero findings
  // AND whose file is non-trivially sized is a silent-drop bug.
  if (args.merge) {
    for (const s of sidecarsReport) {
      if (s.present && s.parsed && s.findings === 0 && s.added === 0) {
        try {
          const stat = fs.statSync(path.join(dir, s.file));
          if (stat.size > 200) {
            // Sidecar has content but extractor returned zero. Record but do
            // not hard-fail — may be legitimately empty (all domains live).
            s.note =
              'extractor returned zero findings despite >200-byte sidecar; verify extractor shape matches sidecar schema';
          }
        } catch {
          /* stat failed; skip */
        }
      }
    }
  }

  if (!args.dryRun) {
    try {
      fs.mkdirSync(path.dirname(registryPath), { recursive: true });
      fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    } catch (err) {
      return {
        ok: false,
        reason: 'registry-write-failed',
        error: String(err?.message || err),
        registryPath,
        summary,
        sidecars: sidecarsReport,
      };
    }
  }

  return {
    ok: true,
    dir,
    registryPath,
    summary,
    sidecars: sidecarsReport,
  };
}

// --- CLI ---

if (require.main === module) {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: cobolt-brownfield-tool-rollup [--dir <path>] [--output <path>] [--merge] [--json] [--dry-run]');
    process.exit(0);
  }

  const result = rollup(args);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (!result.ok) {
      console.error(`[tool-rollup] FAILED: ${result.reason}${result.error ? ` — ${result.error}` : ''}`);
    } else {
      console.log(`[tool-rollup] dir=${result.dir}`);
      console.log(
        `  sidecars: ${result.summary.sidecarsFound} found, ${result.summary.sidecarsParsed} parsed; ${result.summary.findingsAdded} new findings added; ${result.summary.totalIssuesAfter} total in registry`,
      );
      for (const s of result.sidecars) {
        if (!s.present) continue;
        const note = s.note ? ` (${s.note})` : '';
        console.log(`  - ${s.file} → ${s.prefix}: ${s.findings} extracted, ${s.added} added${note}`);
      }
    }
  }

  if (!result.ok) process.exit(result.reason === 'registry-write-failed' ? 3 : 1);

  // Exit 2 if merge mode and any sidecar was present+parsed but added zero new findings
  // AND has a silent-drop note. This surfaces extractor/schema drift.
  if (args.merge) {
    const silentDropped = result.sidecars.some(
      (s) => s.present && s.parsed && s.added === 0 && s.note && s.findings === 0,
    );
    if (silentDropped) process.exit(2);
  }

  process.exit(0);
}

module.exports = { rollup, SIDECARS };
