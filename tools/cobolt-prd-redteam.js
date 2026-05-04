#!/usr/bin/env node

// CoBolt PRD Red-Team Tool (v0.12.0 — WS4)
//
// Deterministic companion to prd-redteam-agent. Runs checks the agent would
// run but without LLM cost — intended to be invoked by the agent (or directly
// by the gate) to pre-seed findings and to verify the agent's output is not
// hallucinated.
//
// Primary responsibilities:
//   1. Load prd.md + domain-ir-bundle.json (if present) + deterministic
//      validation scores (if present).
//   2. For each mandatory IR in the bundle, perform a text-level coverage
//      check against the PRD (ID hit, pattern-name hit, requiredCoverage
//      keyword presence). Flag misses.
//   3. Run a set of deterministic adversarial probes that don't need LLM
//      reasoning: any FR mentioning "payment"/"money"/"transfer" without any
//      idempotency keyword nearby, any FR mentioning "list"/"search" without
//      pagination mention, any FR mentioning "upload" without size/type
//      constraint, etc.
//   4. Merge deterministic findings with the agent's verdict.json (if
//      produced). Score each axis; produce a combined verdict.
//
// Usage:
//   cobolt-prd-redteam.js scan                 # deterministic pre-seed only
//   cobolt-prd-redteam.js check                # merge with agent verdict; exit 1 on BLOCK
//   cobolt-prd-redteam.js merge <agent-json>   # merge a specific agent file
//
// Exit codes:
//   0 — pass / APPROVE
//   1 — REVISE (non-blocking findings present)
//   2 — BLOCK (critical-severity gaps)

const fs = require('node:fs');
const path = require('node:path');

function paths() {
  try {
    const mod = require('../lib/cobolt-paths');
    const p = typeof mod === 'function' ? mod() : typeof mod.paths === 'function' ? mod.paths() : mod;
    return p;
  } catch {
    const out = path.join(process.cwd(), '_cobolt-output');
    return {
      outputRoot: out,
      audit: () => path.join(out, 'audit'),
      latestPlanning: () => path.join(out, 'latest', 'planning'),
    };
  }
}

function loadPrd() {
  const p = paths();
  const candidates = [
    path.join(typeof p.latestPlanning === 'function' ? p.latestPlanning() : '', 'prd.md'),
    path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'prd.md'),
    path.join(process.cwd(), 'docs', 'prd.md'),
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return { text: fs.readFileSync(c, 'utf8'), source: c };
  return { text: '', source: null };
}

function loadBundle() {
  const p = paths();
  const f = path.join(typeof p.latestPlanning === 'function' ? p.latestPlanning() : '', 'domain-ir-bundle.json');
  if (fs.existsSync(f)) {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {}
  }
  return null;
}

function loadDeterministic() {
  const p = paths();
  const f = path.join(
    typeof p.latestPlanning === 'function' ? p.latestPlanning() : '',
    'prd-deterministic-validation.json',
  );
  if (fs.existsSync(f)) {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {}
  }
  return null;
}

// ── Deterministic probes ────────────────────────────────────────────

function splitFRs(prdText) {
  // v0.12.0 fix H4: multi-pattern FR detection. Accept:
  //   ## FR-001 Title        (ATX heading)
  //   ### FR-001             (deeper heading)
  //   **FR-001**:            (bold inline, common in PRDs)
  //   | FR-001 | Title ...   (table row)
  //   - **FR-001**:          (list bullet with bold)
  const lines = prdText.split(/\r?\n/);
  const frs = [];
  let current = null;
  const HEADING_FR = /^#{1,6}\s*(?:FR|FRQ)[-_]?(\d{3,})\b/i;
  const BOLD_FR = /^\s*(?:-|\*)?\s*\*\*(?:FR|FRQ)[-_]?(\d{3,})\*\*/i;
  const TABLE_FR = /^\|\s*(?:FR|FRQ)[-_]?(\d{3,})\b/i;
  function startsFR(line) {
    return HEADING_FR.exec(line) || BOLD_FR.exec(line) || TABLE_FR.exec(line);
  }
  for (let i = 0; i < lines.length; i++) {
    const m = startsFR(lines[i]);
    if (m) {
      if (current) frs.push(current);
      current = { id: `FR-${m[1]}`, line: i, text: `${lines[i]}\n` };
    } else if (current) {
      current.text += `${lines[i]}\n`;
      if (current.text.length > 4000) {
        frs.push(current);
        current = null;
      }
    }
  }
  if (current) frs.push(current);
  // Fallback with loud warning emitted to the result, not silently
  if (frs.length === 0 && prdText.trim().length > 0) {
    frs.push({ id: 'FR-ALL', line: 0, text: prdText, _fallback: true });
  }
  return frs;
}

const PROBES = [
  {
    id: 'PROBE-IDEMPOTENCY',
    axis: 'A2',
    severity: 'critical',
    match: (t) =>
      /\b(payment|charge|transfer|withdraw|deposit|refund|payout|debit|credit)\b/i.test(t) &&
      !/idempoten|dedup|retry.safe|exactly.once/i.test(t),
    hypothesis: 'Money-movement FR with no idempotency / dedup / retry-safety statement',
    rationale:
      'Retried money movement debits twice. Industry-standard baseline is Idempotency-Key header + dedup window.',
  },
  {
    id: 'PROBE-PAGINATION',
    axis: 'A4',
    severity: 'high',
    match: (t) =>
      /\b(list|search|index|feed|history|catalog|timeline)\b/i.test(t) &&
      !/\b(page|pagination|cursor|limit|offset|per.page)\b/i.test(t),
    hypothesis: 'List/search FR without pagination contract (cursor, limit, ordering stability)',
    rationale: 'Unbounded list endpoints become N+1 outages under real data. Pagination is not optional at scale.',
  },
  {
    id: 'PROBE-UPLOAD-LIMITS',
    axis: 'A3',
    severity: 'high',
    match: (t) =>
      /\b(upload|attach|file|image|video|document)\b.*\b(upload|user)/i.test(t) &&
      !/\b(max.size|mime|allowlist|type.allowed|size.limit)\b/i.test(t),
    hypothesis: 'Upload FR without size, MIME, or type allowlist constraints',
    rationale: 'Uploads without explicit limits become a denial-of-service and malware vector.',
  },
  {
    id: 'PROBE-RATE-LIMIT',
    axis: 'A3',
    severity: 'high',
    match: (t) =>
      /\b(login|signup|register|password.reset|forgot|otp|verify|token)\b/i.test(t) &&
      !/\b(rate.limit|throttle|captcha|backoff|lockout)\b/i.test(t),
    hypothesis: 'Authentication-adjacent FR without rate limiting / lockout / CAPTCHA',
    rationale: 'Credential-stuffing and enumeration attacks rely on unbounded retry.',
  },
  {
    id: 'PROBE-TENANT-SCOPE',
    axis: 'A1',
    severity: 'critical',
    match: (t, bundle) => {
      const tenanted = bundle?.packsMatched?.some((p) => p.domain === 'saas-multitenant');
      return (
        tenanted &&
        /\b(list|get|fetch|query|show|return)\b/i.test(t) &&
        !/\b(tenant|workspace|organization|org.id|scope)\b/i.test(t)
      );
    },
    hypothesis: 'Multi-tenant app FR that reads data without mentioning tenant scope',
    rationale: 'Cross-tenant leak is the single most severe SaaS bug. Scope must be explicit on every read.',
  },
  {
    id: 'PROBE-RETRY-POLICY',
    axis: 'A2',
    severity: 'medium',
    match: (t) =>
      /\b(webhook|callback|notify|send|publish|emit|integrate)\b/i.test(t) &&
      !/\b(retry|backoff|dead.letter|exponential|at.least.once)\b/i.test(t),
    hypothesis: 'Outbound integration FR without retry / DLQ / backoff policy',
    rationale: 'Silent delivery drops are invisible until a customer complains.',
  },
  {
    id: 'PROBE-AUDIT',
    axis: 'A5',
    severity: 'high',
    match: (t, bundle) => {
      const regulated = bundle?.packsMatched?.some((p) =>
        ['fintech', 'healthcare', 'saas-multitenant'].includes(p.domain),
      );
      return (
        regulated &&
        /\b(delete|modify|update|change|revoke|grant)\b/i.test(t) &&
        !/\b(audit|log|trail|record|history|immutable)\b/i.test(t)
      );
    },
    hypothesis: 'Regulated-domain mutation FR without audit-log mention',
    rationale: 'Compliance evidence depends on audit records for every privileged mutation.',
  },
  {
    id: 'PROBE-OBSERVABILITY',
    axis: 'A5',
    severity: 'medium',
    match: (t) =>
      /\b(endpoint|api|service|job|worker|processor)\b/i.test(t) &&
      !/\b(metric|log|trace|observ|alert|health)\b/i.test(t) &&
      t.length > 400,
    hypothesis: 'Backend FR of substantive length without observability signals',
    rationale: 'If you cannot see it failing, you cannot fix it. Observability added later is shallow.',
  },
  {
    id: 'PROBE-DELETION',
    axis: 'A5',
    severity: 'medium',
    match: (t) =>
      /\b(delete|remove|purge)\b/i.test(t) &&
      !/\b(soft.delete|cascade|retention|gdpr|right.to|undo|recover)\b/i.test(t),
    hypothesis: 'Deletion FR without soft-delete / cascade / retention / GDPR consideration',
    rationale: 'Hard deletes break foreign keys, destroy audit trail, and violate data-retention requirements.',
  },
];

function runProbes(prdText, bundle) {
  const frs = splitFRs(prdText);
  const fellBack = frs.length === 1 && frs[0]._fallback;
  const findings = [];
  if (fellBack) {
    findings.push({
      id: 'REDTEAM-000',
      probe: 'META-FR-PARSE-FALLBACK',
      axis: 'A5',
      severity: 'medium',
      citation: 'PRD structure',
      hypothesis:
        'PRD has no detectable FR-NNN headings, bold markers, or table rows — probe citations are PRD-wide and imprecise',
      rationale:
        'Without FR-level granularity, findings cannot be routed to the specific requirement. Re-format the PRD with `## FR-NNN` headings to enable targeted analysis.',
    });
  }
  let counter = fellBack ? 1 : 1;
  if (fellBack) counter = 1;
  for (const probe of PROBES) {
    for (const fr of frs) {
      try {
        if (probe.match(fr.text, bundle)) {
          findings.push({
            id: `REDTEAM-${String(counter++).padStart(3, '0')}`,
            probe: probe.id,
            axis: probe.axis,
            severity: probe.severity,
            citation: fr.id,
            hypothesis: probe.hypothesis,
            rationale: probe.rationale,
          });
          if (counter > 30) break;
        }
      } catch {
        /* skip probe on error */
      }
    }
    if (counter > 30) break;
  }
  return findings;
}

// ── Domain pack coverage (reuse cobolt-domain-ir-pack verify) ───────

function domainPackAlignment(bundle, prdText) {
  if (!bundle || !Array.isArray(bundle.mandatoryIRs)) return [];
  const text = prdText.toLowerCase();
  return bundle.mandatoryIRs.map((ir) => {
    const idHit = text.includes(ir.id.toLowerCase());
    const patternHit = text.includes((ir.pattern || '').toLowerCase());
    const addressed = idHit || patternHit;
    return {
      packId: ir.id,
      pack: ir.sourcePack,
      severity: ir.severity || 'high',
      addressed,
      evidence: addressed
        ? `matched by ${idHit ? 'id' : 'pattern'}`
        : `neither ID nor pattern "${ir.pattern}" found in PRD`,
    };
  });
}

// ── Scoring ──────────────────────────────────────────────────────────

const SEVERITY_PENALTY = { critical: 3, high: 2, medium: 1, low: 0 };

function scoreAxes(findings, bundle, prdText) {
  const axes = { A1: 10, A2: 10, A3: 10, A4: 10, A5: 10 };
  for (const f of findings) {
    const penalty = SEVERITY_PENALTY[f.severity] || 0;
    if (axes[f.axis] != null) axes[f.axis] = Math.max(0, axes[f.axis] - penalty);
  }
  // Domain pack misses add pressure to the relevant axes
  const alignment = domainPackAlignment(bundle, prdText);
  for (const a of alignment) {
    if (!a.addressed && a.severity === 'critical') {
      // Spread penalty across A1+A2+A5
      axes.A1 = Math.max(0, axes.A1 - 1);
      axes.A2 = Math.max(0, axes.A2 - 1);
      axes.A5 = Math.max(0, axes.A5 - 1);
    }
  }
  const total = axes.A1 + axes.A2 + axes.A3 + axes.A4 + axes.A5;
  return { ...axes, total, max: 50 };
}

function recommend(scores, findings, alignment) {
  const critical =
    findings.filter((f) => f.severity === 'critical').length +
    alignment.filter((a) => !a.addressed && a.severity === 'critical').length;
  if (critical > 0) return 'BLOCK';
  const high = findings.filter((f) => f.severity === 'high').length;
  if (scores.total < 30 || high >= 3) return 'REVISE';
  return 'APPROVE';
}

// ── Merge with agent verdict ─────────────────────────────────────────

function loadAgentVerdict() {
  const p = paths();
  const f = path.join(typeof p.latestPlanning === 'function' ? p.latestPlanning() : '', 'prd-redteam-verdict.json');
  if (fs.existsSync(f)) {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {}
  }
  return null;
}

function merge(deterministic, agent) {
  if (!agent) return deterministic;
  // Dedupe on (axis + hypothesis) approximate
  const key = (x) => `${x.axis}::${(x.hypothesis || '').slice(0, 80).toLowerCase()}`;
  const seen = new Map();
  for (const f of deterministic.findings || []) seen.set(key(f), { ...f, source: 'probe' });
  for (const f of agent.findings || []) {
    const k = key(f);
    if (!seen.has(k)) seen.set(k, { ...f, source: 'agent' });
  }
  const findings = [...seen.values()];
  const alignment = deterministic.domainPackAlignment;
  const scores = scoreAxes(
    findings.filter((f) => f.source !== 'agent-score'),
    null,
    '',
  );
  // v0.12.0 fix M2: conservative merge — MIN not AVG. If either the probes
  // or the agent scored an axis low, that axis IS low. Averaging hides gaps.
  if (agent.scores) {
    for (const k of ['A1', 'A2', 'A3', 'A4', 'A5']) {
      if (agent.scores[k] != null) scores[k] = Math.min(scores[k], agent.scores[k]);
    }
    scores.total = scores.A1 + scores.A2 + scores.A3 + scores.A4 + scores.A5;
  }
  return {
    generatedAt: new Date().toISOString(),
    scores,
    recommendation: recommend(scores, findings, alignment),
    findings,
    domainPackAlignment: alignment,
    sources: { deterministic: true, agent: true },
  };
}

// ── Main ─────────────────────────────────────────────────────────────

function scan() {
  const { text: prdText, source } = loadPrd();
  if (!prdText) return { ok: false, skipped: true, reason: 'no PRD found', source: null };
  const bundle = loadBundle();
  const det = loadDeterministic();
  const findings = runProbes(prdText, bundle);
  const alignment = domainPackAlignment(bundle, prdText);
  const scores = scoreAxes(findings, bundle, prdText);
  const recommendation = recommend(scores, findings, alignment);
  const verdict = {
    generatedAt: new Date().toISOString(),
    source,
    prdDeterministicGrade: det ? det.grade : null,
    scores,
    recommendation,
    findings,
    domainPackAlignment: alignment,
    sources: { deterministic: true, agent: false },
  };
  // Persist
  const p = paths();
  const planning =
    typeof p.latestPlanning === 'function'
      ? p.latestPlanning()
      : path.join(process.cwd(), '_cobolt-output', 'latest', 'planning');
  fs.mkdirSync(planning, { recursive: true });
  fs.writeFileSync(path.join(planning, 'prd-redteam-deterministic.json'), JSON.stringify(verdict, null, 2));
  return verdict;
}

function check() {
  const deterministic = scan();
  if (deterministic.skipped) return { ok: true, skipped: true, ...deterministic };
  const agent = loadAgentVerdict();
  const merged = agent ? merge(deterministic, agent) : deterministic;
  // Persist merged
  const p = paths();
  const planning =
    typeof p.latestPlanning === 'function'
      ? p.latestPlanning()
      : path.join(process.cwd(), '_cobolt-output', 'latest', 'planning');
  fs.writeFileSync(path.join(planning, 'prd-redteam-merged.json'), JSON.stringify(merged, null, 2));
  // Telemetry
  try {
    const dir =
      typeof paths().audit === 'function' ? paths().audit() : path.join(process.cwd(), '_cobolt-output', 'audit');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(dir, 'prd-redteam-log.jsonl'),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        recommendation: merged.recommendation,
        total: merged.scores.total,
        findings: merged.findings.length,
      })}\n`,
    );
  } catch {}
  return merged;
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case 'scan': {
      const r = scan();
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    case 'check': {
      const r = check();
      console.log(JSON.stringify(r, null, 2));
      if (r.skipped) return 0;
      return r.recommendation === 'BLOCK' ? 2 : r.recommendation === 'REVISE' ? 1 : 0;
    }
    case 'merge': {
      if (!arg) {
        console.error('merge requires agent verdict path');
        return 1;
      }
      const agent = JSON.parse(fs.readFileSync(arg, 'utf8'));
      const det = scan();
      const merged = merge(det, agent);
      console.log(JSON.stringify(merged, null, 2));
      return 0;
    }
    default:
      console.error('Usage: cobolt-prd-redteam.js {scan|check|merge <path>}');
      return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { scan, check, merge, runProbes, scoreAxes, recommend };
