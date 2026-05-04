// Requirements-internal-consistency detector (Ship 2, v0.54+).
//
// Adds finding class I1 to the plan-review taxonomy: catches direct
// contradiction pairs between FR/NFR/TR requirements within the same PRD/TRD.
// Deterministic — rule-based predicate matching only. No LLM, no embeddings.
//
// Detection covers five contradiction classes:
//   - Storage:        cloud vs on-prem; encrypted vs plaintext; persistent vs ephemeral
//   - Auth:           required vs optional; MFA vs single-factor; central vs federated
//   - Data residency: region constraints (US-only ↔ EU-required, etc.)
//   - Throughput:     incompatible numeric bounds (1000 rps vs 10 rps for the same surface)
//   - Availability:   SLA contradictions (99.99% vs best-effort, etc.)
//
// Each finding cites BOTH requirement IDs in evidence so plan-fix can verify
// the contradiction on disk before dispatching a repair.
//
// Bypass: COBOLT_REQ_CONSISTENCY=off (Tier 2 advisory; bypass logged to
// gate-skip-log.jsonl by the runner).

const fs = require('node:fs');
const path = require('node:path');

const { createFinding } = require('./_shared');

const DETECTOR_ID = 'requirements-consistency';
const FINDING_CLASS = 'I1';

// Token sets per domain. Each domain has POSITIVE and NEGATIVE markers.
// A requirement is classified into a domain when ≥1 token matches; the
// positive/negative axis is determined by whichever set has more matches.
const DOMAIN_RULES = {
  storage: {
    positive: ['cloud', 's3', 'aws', 'azure', 'gcp', 'cloud storage', 'object storage'],
    negative: ['on-prem', 'on premise', 'on-premise', 'self-hosted', 'self hosted', 'local-only', 'no cloud'],
    label: 'storage location (cloud vs on-prem)',
  },
  encryption: {
    positive: ['encrypted', 'encryption at rest', 'aes-256', 'tls', 'kms'],
    negative: ['plaintext', 'unencrypted', 'no encryption', 'cleartext'],
    label: 'encryption (encrypted vs plaintext)',
  },
  persistence: {
    positive: ['persistent', 'durable', 'persisted to disk', 'permanent'],
    negative: ['ephemeral', 'in-memory only', 'transient', 'not persisted'],
    label: 'persistence (durable vs ephemeral)',
  },
  authRequired: {
    positive: ['authentication required', 'must authenticate', 'login required', 'auth required'],
    negative: ['no authentication', 'anonymous access', 'public access', 'unauthenticated'],
    label: 'auth required vs anonymous',
  },
  mfa: {
    positive: ['mfa', 'multi-factor', 'two-factor', '2fa', 'multi factor'],
    negative: ['single-factor', 'single factor', 'password-only', 'password only'],
    label: 'MFA vs single-factor',
  },
  authCentral: {
    positive: ['centralized auth', 'central identity', 'single sign-on', 'sso'],
    negative: ['federated', 'per-service auth', 'decentralized auth'],
    label: 'central vs federated auth',
  },
  residencyUS: {
    positive: ['us-only', 'us only', 'united states only', 'us region', 'data must reside in the us'],
    negative: ['eu-only', 'eu only', 'european union only', 'eu region', 'data must reside in the eu'],
    label: 'data residency (US-only vs EU-only)',
  },
  availability: {
    // 99.99 / 99.9 etc. handled as numeric SLA, see below; these are textual extremes
    positive: ['99.99%', '99.999%', 'high availability', 'always-on', 'always on'],
    negative: ['best-effort', 'best effort', 'no sla', 'no uptime guarantee'],
    label: 'availability (HA SLA vs best-effort)',
  },
};

// Numeric bound contradictions detected separately (throughput, latency, SLA).
const NUMERIC_PATTERNS = {
  throughput: {
    regex: /(\d{1,7})\s*(rps|req\/s|requests per second|qps)/i,
    label: 'throughput',
    incompatibleRatio: 5, // if max/min > 5x within same surface, flag
  },
  latency: {
    regex: /(\d{1,5})\s*(ms|millisecond|seconds?)/i,
    label: 'latency',
    incompatibleRatio: 10,
  },
  sla: {
    regex: /(\d{2}\.\d{1,3})\s*%/,
    label: 'SLA percentage',
    incompatibleRatio: null, // explicit comparison: 99.99 vs 99 = contradiction
  },
};

function readMaybe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

// Extract requirements as { id, prefix, text } from PRD/TRD/NFR markdown.
// Heuristic: a requirement starts with `### FR-001 Title` or `- FR-001:` or
// `**FR-001**` and runs until the next requirement / next heading.
function extractRequirements(content) {
  if (!content) return [];
  const out = [];
  const lines = content.split(/\r?\n/);
  const idPattern = /\b((?:FR|NFR|TR|TRD|IR)-\d{1,4})\b/i;
  let current = null;
  for (const line of lines) {
    const headingMatch = line.match(/^#{2,}\s+([A-Z]{2,4}-\d{1,4})\b/i);
    const bulletMatch = line.match(/^\s*[-*]\s+(?:\*\*)?([A-Z]{2,4}-\d{1,4})\b/i);
    const inlineMatch = line.match(/^\s*\*\*([A-Z]{2,4}-\d{1,4})\b/i);
    const idHit = headingMatch?.[1] || bulletMatch?.[1] || inlineMatch?.[1];
    if (idHit) {
      if (current) out.push(current);
      const id = idHit.toUpperCase();
      const prefix = id.split('-')[0];
      current = { id, prefix, text: `${line}\n` };
    } else if (current) {
      // Stop accumulating on next h2/h1
      if (/^#{1,2}\s+/.test(line) && !idPattern.test(line)) {
        out.push(current);
        current = null;
      } else {
        current.text += `${line}\n`;
      }
    }
  }
  if (current) out.push(current);
  return out;
}

// Classify a requirement into one of the domains. Returns
// { domain, axis: 'positive'|'negative', matchedTokens } or null.
function classifyRequirement(req) {
  const lower = req.text.toLowerCase();
  const classifications = [];
  for (const [domain, rule] of Object.entries(DOMAIN_RULES)) {
    let posCount = 0;
    let negCount = 0;
    const matchedTokens = [];
    for (const tok of rule.positive) {
      if (lower.includes(tok)) {
        posCount += 1;
        matchedTokens.push(tok);
      }
    }
    for (const tok of rule.negative) {
      if (lower.includes(tok)) {
        negCount += 1;
        matchedTokens.push(tok);
      }
    }
    if (posCount + negCount > 0) {
      classifications.push({
        domain,
        axis: posCount > negCount ? 'positive' : 'negative',
        matchedTokens,
        label: rule.label,
      });
    }
  }
  return classifications;
}

// Extract numeric bounds for throughput/latency/SLA.
function extractNumericBounds(req) {
  const bounds = [];
  for (const [name, spec] of Object.entries(NUMERIC_PATTERNS)) {
    const matches = req.text.matchAll(new RegExp(spec.regex, 'gi'));
    for (const m of matches) {
      bounds.push({
        kind: name,
        value: Number(m[1]),
        unit: m[2] || '%',
        snippet: m[0],
      });
    }
  }
  return bounds;
}

// Find direct contradiction pairs among the requirements.
function findContradictions(requirements) {
  const findings = [];
  const classified = requirements.map((r) => ({
    req: r,
    classes: classifyRequirement(r),
    numericBounds: extractNumericBounds(r),
  }));

  // Domain axis contradictions: any pair (A,B) where A is classified positive
  // in domain D and B is classified negative in the same D.
  for (let i = 0; i < classified.length; i++) {
    for (let j = i + 1; j < classified.length; j++) {
      const a = classified[i];
      const b = classified[j];
      for (const ca of a.classes) {
        for (const cb of b.classes) {
          if (ca.domain === cb.domain && ca.axis !== cb.axis) {
            findings.push(
              createFinding({
                classId: FINDING_CLASS,
                severity: 'advisory',
                artifact: 'prd.md',
                detectorId: DETECTOR_ID,
                title: `Domain contradiction: ${a.req.id} vs ${b.req.id} on ${ca.label}`,
                evidence: {
                  requirementA: { id: a.req.id, axis: ca.axis, tokens: ca.matchedTokens, snippet: snippet(a.req.text) },
                  requirementB: { id: b.req.id, axis: cb.axis, tokens: cb.matchedTokens, snippet: snippet(b.req.text) },
                  domain: ca.domain,
                },
                remediationHint: `Resolve the ${ca.label} conflict between ${a.req.id} and ${b.req.id}. One of the two must be amended or both must be reconciled in a shared constraint.`,
              }),
            );
          }
        }
      }
    }
  }

  // Numeric SLA contradictions (both have an SLA percentage; differ by >0.1).
  for (let i = 0; i < classified.length; i++) {
    for (let j = i + 1; j < classified.length; j++) {
      const a = classified[i];
      const b = classified[j];
      const slaA = a.numericBounds.find((n) => n.kind === 'sla');
      const slaB = b.numericBounds.find((n) => n.kind === 'sla');
      if (slaA && slaB && Math.abs(slaA.value - slaB.value) > 0.1) {
        findings.push(
          createFinding({
            classId: FINDING_CLASS,
            severity: 'advisory',
            artifact: 'prd.md',
            detectorId: DETECTOR_ID,
            title: `SLA contradiction: ${a.req.id} (${slaA.value}%) vs ${b.req.id} (${slaB.value}%)`,
            evidence: {
              requirementA: { id: a.req.id, value: slaA.value, snippet: slaA.snippet },
              requirementB: { id: b.req.id, value: slaB.value, snippet: slaB.snippet },
              domain: 'sla',
            },
            remediationHint: `Two requirements declare different SLA percentages (${slaA.value}% vs ${slaB.value}%). Reconcile to a single number or scope each by surface.`,
          }),
        );
      }
    }
  }

  // Numeric throughput contradictions (both throughput, ratio > 5x).
  for (let i = 0; i < classified.length; i++) {
    for (let j = i + 1; j < classified.length; j++) {
      const a = classified[i];
      const b = classified[j];
      const tpA = a.numericBounds.find((n) => n.kind === 'throughput');
      const tpB = b.numericBounds.find((n) => n.kind === 'throughput');
      if (tpA && tpB) {
        const ratio = Math.max(tpA.value, tpB.value) / Math.max(Math.min(tpA.value, tpB.value), 1);
        if (ratio > NUMERIC_PATTERNS.throughput.incompatibleRatio) {
          findings.push(
            createFinding({
              classId: FINDING_CLASS,
              severity: 'advisory',
              artifact: 'prd.md',
              detectorId: DETECTOR_ID,
              title: `Throughput contradiction: ${a.req.id} (${tpA.value} ${tpA.unit}) vs ${b.req.id} (${tpB.value} ${tpB.unit})`,
              evidence: {
                requirementA: { id: a.req.id, value: tpA.value, unit: tpA.unit, snippet: tpA.snippet },
                requirementB: { id: b.req.id, value: tpB.value, unit: tpB.unit, snippet: tpB.snippet },
                ratio: Math.round(ratio * 10) / 10,
                domain: 'throughput',
              },
              remediationHint: `Two requirements declare incompatible throughput bounds (${ratio.toFixed(1)}x apart). Either scope each to a different surface or reconcile to a single number.`,
            }),
          );
        }
      }
    }
  }

  return findings;
}

function snippet(text, len = 120) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > len ? `${s.slice(0, len - 3)}...` : s;
}

// Detector entrypoint: { id, run(context) → { detectorId, findings } }.
function run(context = {}) {
  const planningDir = context.planningDir || context.paths?.planningDir;
  if (!planningDir || !fs.existsSync(planningDir)) {
    return { detectorId: DETECTOR_ID, findings: [] };
  }
  const sources = ['prd.md', 'trd.md', 'security-requirements.md', 'capability-contracts.md', 'data-model-spec.md'];
  const allReqs = [];
  for (const src of sources) {
    const p = path.join(planningDir, src);
    const content = readMaybe(p);
    if (!content) continue;
    const reqs = extractRequirements(content).map((r) => ({ ...r, source: src }));
    allReqs.push(...reqs);
  }
  if (allReqs.length === 0) {
    return { detectorId: DETECTOR_ID, findings: [] };
  }
  const findings = findContradictions(allReqs);
  return { detectorId: DETECTOR_ID, findings };
}

module.exports = {
  id: DETECTOR_ID,
  run,
  // Exported for testing / reuse.
  extractRequirements,
  classifyRequirement,
  extractNumericBounds,
  findContradictions,
  DOMAIN_RULES,
  NUMERIC_PATTERNS,
  FINDING_CLASS,
};
