#!/usr/bin/env node

// CoBolt Build Tool Rollup — deterministic build-sidecar-to-registry promoter.
//
// v0.20.7 — mirrors brownfield-tool-rollup (v0.20.5) but for build-stage
// sidecars. Reads the four JSON sidecars that step 03b and 04a produce and
// converts every record into a typed finding in `M{n}-issues-registry.json`.
//
// Prior to v0.20.7, these sidecars were gated (pass/fail) at step 03b but the
// structured findings inside were never promoted — review never saw them,
// fix-lead never saw them, and only boot/wiring aggregate verdicts propagated.
//
// Sidecars handled (relative to --dir, typically _cobolt-output/latest/build/{M}/):
//   {M}-wiring-check.json         →  WIRE-NNN      (cobolt-entrypoint-wiring-check)
//   {M}-api-contract-check.json   →  APIWIRE-NNN   (inline check from step 03b)
//   {M}-worker-lifecycle.json     →  LIFECYCLE-NNN (cobolt-worker-lifecycle)
//   {M}-illusion-report.json      →  ILL-NNN       (cobolt-illusion-scan)
//
// Usage:
//   node tools/cobolt-build-tool-rollup.js \
//     --dir _cobolt-output/latest/build/M1 \
//     --milestone M1 \
//     [--output _cobolt-output/latest/build/M1/M1-issues-registry.json] \
//     [--merge] [--json] [--dry-run]
//
// Exit codes:
//   0 = success (rollup merged or no sidecars present)
//   1 = sidecar exists but could not be parsed
//   2 = sidecar exists with content but extractor returned zero (silent-drop guard)
//   3 = registry write failed
//
// Tier 1 gate (--merge mode): every parsed sidecar with >200 bytes of content
// MUST yield at least one finding or the silent-drop guard fires.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  dir: null,
  milestone: null,
  output: null, // defaults to <dir>/<milestone>-issues-registry.json
  reportOutput: null,
  merge: false,
  json: false,
  dryRun: false,
};

function decodeJsonText(buffer) {
  if (!Buffer.isBuffer(buffer)) return String(buffer || '');
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buffer.length - 2);
    for (let i = 2; i + 1 < buffer.length; i += 2) {
      swapped[i - 2] = buffer[i + 1];
      swapped[i - 1] = buffer[i];
    }
    return swapped.toString('utf16le');
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 256));
  let nulOdd = 0;
  let nulEven = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] !== 0) continue;
    if (i % 2 === 0) nulEven++;
    else nulOdd++;
  }
  if (nulOdd > nulEven && nulOdd > 2) return buffer.toString('utf16le');
  return buffer.toString('utf8');
}

function normalizeSeverity(value) {
  const sev = String(value || 'medium').toLowerCase();
  if (sev === 'critical' || sev === 'high' || sev === 'medium' || sev === 'low') return sev;
  return 'medium';
}

function priorityForSeverity(severity) {
  return severity === 'critical' ? 'P0' : severity === 'high' ? 'P1' : severity === 'medium' ? 'P2' : 'P3';
}

function isUnhealthyIntegration(integration) {
  if (!integration || typeof integration !== 'object') return false;
  return !(integration.status === 'up' || integration.status === 'ok' || integration.status === true);
}

function isInactiveWorker(worker) {
  if (!worker || typeof worker !== 'object') return false;
  return worker.status === 'defined-not-started' || worker.started === false || worker.running === false;
}

function normalizeIllusionRecords(data) {
  if (!data || typeof data !== 'object') return [];
  return [
    ...(Array.isArray(data.findings)
      ? data.findings.map((f) => ({ ...f, recordType: f.recordType || 'finding' }))
      : []),
    ...(Array.isArray(data.illusions)
      ? data.illusions.map((f) => ({ ...f, recordType: f.recordType || 'illusion' }))
      : []),
    ...(Array.isArray(data.partials)
      ? data.partials.map((f) => ({ ...f, recordType: f.recordType || 'partial' }))
      : []),
  ];
}

function hasActionableRollupRecords(prefix, data) {
  if (!data || typeof data !== 'object') return false;

  if (prefix === 'WIRE') {
    const domains = Array.isArray(data.domains) ? data.domains : [];
    return domains.some((d) => d && (d.status === 'unwired' || d.status === 'partial'));
  }

  if (prefix === 'APIWIRE') {
    const missing = Array.isArray(data.missing) ? data.missing : [];
    return missing.length > 0;
  }

  if (prefix === 'LIFECYCLE') {
    const integrations = Array.isArray(data.integrations) ? data.integrations : [];
    const reasons = Array.isArray(data.failureReasons) ? data.failureReasons : [];
    const workers = Array.isArray(data.workers) ? data.workers : [];
    return (
      integrations.some(isUnhealthyIntegration) ||
      reasons.some((r) => typeof r === 'string' && /^\/health|^\/ready|^\/metrics/.test(r)) ||
      workers.some(isInactiveWorker)
    );
  }

  if (prefix === 'ILL') {
    return normalizeIllusionRecords(data).length > 0;
  }

  return true;
}

// --- Sidecar → finding rules ---

function sidecarSpec(milestone) {
  const M = milestone || '{M}';
  return [
    {
      file: `${M}-wiring-check.json`,
      prefix: 'WIRE',
      tool: 'cobolt-entrypoint-wiring-check',
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
              summary: `Domain/handler "${d.name}" is unwired — route registered but not mounted in entrypoint`,
              affectedAreas: [d.path || d.name].filter(Boolean),
              recommendation: `Mount \`${d.path || d.name}\` in the app entrypoint (router.use / app.register / mount()), or delete if dead.`,
              evidence: { status: d.status, framework: d.framework || null, evidence: d.evidence || null },
            });
          } else if (d.status === 'partial') {
            out.push({
              severity: 'medium',
              priority: 'P2',
              summary: `Domain/handler "${d.name}" is partially wired — imported but not fully registered`,
              affectedAreas: [d.path || d.name].filter(Boolean),
              recommendation: `Verify \`${d.path || d.name}\` is reachable via the running app; add router/main wiring or document why partial is intentional.`,
              evidence: { status: d.status, evidence: d.evidence || null },
            });
          }
        }
        return out;
      },
    },
    {
      file: `${M}-api-contract-check.json`,
      prefix: 'APIWIRE',
      tool: 'build-api-contract-check',
      category: 'API',
      extract: (data) => {
        const out = [];
        const missing = Array.isArray(data?.missing) ? data.missing : [];
        const completeness = typeof data?.completeness === 'number' ? data.completeness : null;
        for (const m of missing) {
          if (!m || typeof m !== 'object') continue;
          const method = m.method || 'UNKNOWN';
          const mpath = m.path || '';
          out.push({
            severity: 'high',
            priority: 'P1',
            summary: `Spec endpoint ${method} ${mpath} has no registered handler — contract drift`,
            affectedAreas: [mpath, 'api-contracts.md'].filter(Boolean),
            recommendation: `Implement handler for ${method} ${mpath} (see api-contracts.md), or remove the endpoint from the contract if intentional.`,
            evidence: { method, path: mpath, completenessPercent: completeness },
          });
        }
        return out;
      },
    },
    {
      file: `${M}-worker-lifecycle.json`,
      prefix: 'LIFECYCLE',
      tool: 'cobolt-worker-lifecycle',
      category: 'OPS',
      extract: (data) => {
        const out = [];
        if (!data || typeof data !== 'object') return out;

        const integrations = Array.isArray(data.integrations) ? data.integrations : [];
        for (const i of integrations) {
          if (!i || typeof i !== 'object') continue;
          if (!isUnhealthyIntegration(i)) continue;
          out.push({
            severity: i.status === 'down' ? 'high' : 'medium',
            priority: i.status === 'down' ? 'P1' : 'P2',
            summary: `Integration "${i.name}" is ${i.status} per /ready — declared but not healthy at runtime`,
            affectedAreas: [i.name].filter(Boolean),
            recommendation: `Start / reconnect "${i.name}" or remove the declared dependency if the feature is not in scope for this milestone.`,
            evidence: { status: i.status, source: i.source, detail: i.detail || null },
          });
        }

        const reasons = Array.isArray(data.failureReasons) ? data.failureReasons : [];
        for (const r of reasons) {
          if (typeof r !== 'string') continue;
          // Only emit lifecycle findings for the primary /health, /ready, /metrics probes —
          // integration-level reasons are already covered above.
          if (/^\/health|^\/ready|^\/metrics/.test(r)) {
            out.push({
              severity: 'high',
              priority: 'P1',
              summary: `Worker-lifecycle probe failed: ${r}`,
              affectedAreas: ['/health', '/ready', '/metrics'].filter((x) => r.includes(x)),
              recommendation:
                'Expose the missing/broken health endpoint per the ops-readiness contract, or mark the milestone as not production-targeted.',
              evidence: { reason: r, appUrl: data.appUrl || null },
            });
          }
        }

        const workers = Array.isArray(data.workers) ? data.workers : [];
        for (const w of workers) {
          if (!isInactiveWorker(w)) continue;
          out.push({
            severity: 'high',
            priority: 'P1',
            summary: `Worker "${w.name || w.file || 'unknown'}" is defined but not started by the application entrypoint`,
            affectedAreas: [w.file, w.startedIn].filter(Boolean),
            recommendation: `Start "${w.name || w.file || 'worker'}" from the application entrypoint/supervision tree, or remove the unused worker definition if it is out of scope.`,
            evidence: {
              status: w.status || 'not-started',
              method: w.method || null,
              language: w.language || null,
              evidence: w.evidence || null,
            },
          });
        }

        return out;
      },
    },
    {
      file: `${M}-illusion-report.json`,
      prefix: 'ILL',
      tool: 'cobolt-illusion-scan',
      category: 'QUALITY',
      extract: (data) => {
        const out = [];
        const findings = normalizeIllusionRecords(data);
        for (const f of findings) {
          if (!f || typeof f !== 'object') continue;
          const sev = normalizeSeverity(f.severity);
          const priority = priorityForSeverity(sev);
          const loc = f.line ? `${f.file || 'unknown'}:${f.line}` : f.file || 'unknown';
          const fn = f.function ? ` in ${f.function}` : '';
          const recordType = f.recordType || 'finding';
          out.push({
            severity: sev,
            priority,
            summary:
              f.message ||
              f.description ||
              (f.reason ? `Behavioral ${recordType}${fn} at ${loc} - ${f.reason}` : null) ||
              `Behavioral illusion (${f.category || 'unknown'}) at ${loc} - function appears implemented but is a no-op / facade`,
            affectedAreas: [f.file || 'unknown'].filter(Boolean),
            recommendation:
              f.recommendation ||
              'Replace the illusion with a real implementation, or document why the no-op / facade is intentional for this milestone.',
            evidence: {
              category: f.category || recordType,
              id: f.id,
              file: f.file,
              line: f.line,
              function: f.function,
              recordType,
              snippet: f.snippet || null,
              reason: f.reason || null,
              fr: f.fr || null,
              pretends: f.pretends || null,
              actual: f.actual || null,
            },
          });
        }
        return out;
      },
    },
  ];
}

// --- Helpers ---

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--milestone' || a === '-m') args.milestone = argv[++i];
    else if (a === '--output') args.output = argv[++i];
    else if (a === '--report-output' || a === '--report-out' || a === '--out') args.reportOutput = argv[++i];
    else if (a === '--merge') args.merge = true;
    else if (a === '--json') args.json = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '-h' || a === '--help') args.help = true;
  }
  return args;
}

function readJsonSafe(filePath) {
  try {
    const raw = decodeJsonText(fs.readFileSync(filePath)).replace(/^\uFEFF/, '');
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

function resolveMilestoneFromDir(dir) {
  // Dir typically ends in `/build/{M}` where M is e.g. M1, M2.
  const base = path.basename(path.resolve(dir));
  if (/^M\d+$/.test(base)) return base;
  return null;
}

function loadRegistry(registryPath, milestone) {
  if (!fs.existsSync(registryPath)) {
    return {
      milestone: milestone || null,
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
  if (!reg.milestone && milestone) reg.milestone = milestone;
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

function alreadyRecorded(registry, prefix, summary, firstArea) {
  for (const issue of registry.issues) {
    if (!issue || typeof issue !== 'object') continue;
    const id = String(issue.id || '');
    if (!id.startsWith(prefix)) continue;
    if (issue.summary === summary) {
      const issueFirstArea = Array.isArray(issue.affectedAreas) ? issue.affectedAreas[0] : null;
      if (issueFirstArea === firstArea) return true;
    }
  }
  return false;
}

function rollup(args) {
  if (!args.dir) {
    return { ok: false, reason: 'dir-required', message: '--dir is required (e.g. _cobolt-output/latest/build/M1)' };
  }
  const dir = path.resolve(args.dir);

  if (!fs.existsSync(dir)) {
    return {
      ok: false,
      reason: 'build-dir-missing',
      dir,
      summary: { sidecarsFound: 0, findingsAdded: 0 },
      sidecars: [],
    };
  }

  const milestone = args.milestone || resolveMilestoneFromDir(dir) || '{M}';
  const registryPath = args.output ? path.resolve(args.output) : path.join(dir, `${milestone}-issues-registry.json`);
  const sidecars = sidecarSpec(milestone);

  const registry = loadRegistry(registryPath, milestone);
  const sidecarsReport = [];
  let totalAdded = 0;

  for (const spec of sidecars) {
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
        emittedBy: 'cobolt-build-tool-rollup',
      });
      added++;
    }

    const note = (() => {
      if (extracted.length === 0 && added === 0) {
        try {
          const stat = fs.statSync(filePath);
          if (stat.size > 200 && hasActionableRollupRecords(spec.prefix, parsed.data)) {
            return 'extractor returned zero findings despite >200-byte sidecar; verify extractor shape matches sidecar schema';
          }
        } catch {
          /* stat failed */
        }
      }
      return null;
    })();

    sidecarsReport.push({
      file: spec.file,
      prefix: spec.prefix,
      present: true,
      parsed: true,
      findings: extracted.length,
      added,
      ...(note ? { note } : {}),
    });
    totalAdded += added;
  }

  registry.lastUpdated = new Date().toISOString();

  const summary = {
    milestone,
    sidecarsFound: sidecarsReport.filter((s) => s.present).length,
    sidecarsParsed: sidecarsReport.filter((s) => s.present && s.parsed).length,
    findingsAdded: totalAdded,
    totalIssuesAfter: registry.issues.length,
  };

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
    milestone,
    registryPath,
    summary,
    sidecars: sidecarsReport,
  };
}

// --- CLI ---

if (require.main === module) {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      'Usage: cobolt-build-tool-rollup --dir <path> [--milestone M{n}] [--output <path>] [--report-output <path>] [--merge] [--json] [--dry-run]',
    );
    process.exit(0);
  }

  const result = rollup(args);

  if (args.json) {
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (args.reportOutput) {
      fs.mkdirSync(path.dirname(path.resolve(args.reportOutput)), { recursive: true });
      fs.writeFileSync(path.resolve(args.reportOutput), json, 'utf8');
    }
    process.stdout.write(json);
  } else if (!result.ok) {
    console.error(
      `[build-tool-rollup] FAILED: ${result.reason}${result.message ? ` — ${result.message}` : ''}${result.error ? ` — ${result.error}` : ''}`,
    );
  } else {
    console.log(`[build-tool-rollup] milestone=${result.milestone} dir=${result.dir}`);
    console.log(
      `  sidecars: ${result.summary.sidecarsFound} found, ${result.summary.sidecarsParsed} parsed; ${result.summary.findingsAdded} new findings added; ${result.summary.totalIssuesAfter} total in registry`,
    );
    for (const s of result.sidecars) {
      if (!s.present) continue;
      const note = s.note ? ` (${s.note})` : '';
      const err = s.error ? ` (ERROR: ${s.error})` : '';
      console.log(`  - ${s.file} → ${s.prefix}: ${s.findings} extracted, ${s.added} added${note}${err}`);
    }
  }

  if (!result.ok) {
    if (result.reason === 'registry-write-failed') process.exit(3);
    if (result.reason === 'dir-required') process.exit(2);
    process.exit(1);
  }

  if (args.merge) {
    const silentDropped = result.sidecars.some(
      (s) => s.present && s.parsed && s.added === 0 && s.note && s.findings === 0,
    );
    if (silentDropped) process.exit(2);
  }

  process.exit(0);
}

module.exports = { rollup, sidecarSpec };
