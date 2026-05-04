#!/usr/bin/env node

// CoBolt Plan Content-Depth Gate
//
// Problem this closes:
//   Existing artifact schemas only enforce `minBytes` — a file passes if it is
//   larger than 500 bytes, regardless of content depth. Two producers have
//   shipped with content that technically passes but is useless downstream:
//
//     1. system-architecture.md without a single Mermaid block
//        (C4 L1/L2/L3 diagrams are a documented deliverable).
//     2. enriched-requirements.md with only a summary table — no per-FR
//        enrichment sections, defeating the cobolt-analyze-features goal.
//
//   This tool is Tier 2 (skip-and-report by default): every check emits a
//   structured finding and the gate exits non-zero when any required check
//   fails. It reads only the test-project planning tree; it never writes to
//   the artifact (root-cause fixes live in the producers).
//
// Usage:
//   node tools/cobolt-plan-content-depth-gate.js check [--project <dir>] [--json]
//
// Exit codes:
//   0 = all checks pass
//   1 = at least one required check failed (Tier 2 — pipeline degrades)
//   2 = missing required inputs (planning dir absent)

const fs = require('node:fs');
const path = require('node:path');

const CHECKS = [
  {
    id: 'system-architecture-c4-diagrams',
    file: 'system-architecture.md',
    tier: 2,
    description: 'System architecture must include at least 2 Mermaid diagrams (C4 L1 + L2).',
    evaluate(text) {
      const mermaid = (text.match(/```mermaid/g) || []).length;
      const hasC4Keywords = /C4Context|C4Container|C4Component|graph (LR|TB|TD|BT|RL)/.test(text);
      const ok = mermaid >= 2 && hasC4Keywords;
      return {
        ok,
        evidence: { mermaidBlocks: mermaid, c4Keywords: hasC4Keywords },
        remediation:
          'cobolt-create-system-architecture must emit Mermaid C4 blocks. See skill step-03-component-boundaries.',
      };
    },
  },
  {
    id: 'architecture-composite-index',
    file: 'architecture.md',
    tier: 2,
    description: 'architecture.md composite index must include at least 1 Mermaid diagram.',
    evaluate(text) {
      const mermaid = (text.match(/```mermaid/g) || []).length;
      const ok = mermaid >= 1;
      return { ok, evidence: { mermaidBlocks: mermaid } };
    },
  },
  {
    id: 'data-model-erd',
    file: 'data-model-spec.md',
    tier: 2,
    description: 'data-model-spec.md must include a Mermaid ERD diagram (erDiagram block).',
    evaluate(text) {
      const hasErd = /```mermaid[\s\S]*?erDiagram/i.test(text);
      return {
        ok: hasErd,
        evidence: { erDiagram: hasErd },
        remediation: 'cobolt-create-data-model must emit an erDiagram Mermaid block.',
      };
    },
  },
  {
    id: 'enriched-requirements-depth',
    file: 'enriched-requirements.md',
    tier: 2,
    description: 'enriched-requirements.md must cover every FR declared in prd.md (≥80% referenced inline).',
    requires: ['prd.md'],
    evaluate(text, context) {
      const prdText = context.readFile('prd.md') || '';
      const prdFrs = [...new Set([...prdText.matchAll(/\bFR-(\d{3})\b/g)].map((m) => m[1]))];
      if (prdFrs.length === 0) return { ok: true, evidence: { prdFrs: 0 } };
      const enrichedFrs = new Set([...text.matchAll(/\bFR-(\d{3})\b/g)].map((m) => m[1]));
      const hit = prdFrs.filter((id) => enrichedFrs.has(id)).length;
      const coverage = hit / prdFrs.length;
      const h2Count = (text.match(/^##\s/gm) || []).length;
      const ok = coverage >= 0.8 && h2Count >= Math.max(3, Math.ceil(prdFrs.length / 10));
      return {
        ok,
        evidence: {
          prdFrs: prdFrs.length,
          enrichedFrs: enrichedFrs.size,
          coveragePct: Math.round(coverage * 1000) / 10,
          h2Headings: h2Count,
        },
        remediation:
          'cobolt-analyze-features step 04 must emit per-FR enrichment sections (UI states, data lifecycle, integration edges, business-logic boundaries). Enforce ≥80% FR coverage in the workflow.',
      };
    },
  },
  {
    id: 'api-contracts-error-taxonomy',
    file: 'api-contracts.md',
    tier: 2,
    description: 'api-contracts.md must declare an error taxonomy (HTTP status table or Problem Details).',
    evaluate(text) {
      const problemDetails = /RFC\s*7807|application\/problem\+json/i.test(text);
      const statusTable = /\|\s*(4\d{2}|5\d{2})\s*\|/m.test(text);
      const ok = problemDetails || statusTable;
      return {
        ok,
        evidence: { problemDetails, statusTable },
        remediation: 'cobolt-create-api-contracts must include an error-taxonomy section with status codes.',
      };
    },
  },
  {
    id: 'test-strategy-category-coverage',
    file: 'test-strategy.md',
    tier: 2,
    description:
      'test-strategy.md must enumerate at least 5 of 8 test categories (unit, integration, e2e, security, performance, api, database, accessibility).',
    evaluate(text) {
      const tokens = [
        /\bunit\b/i,
        /\bintegration\b/i,
        /\b(e2e|end[-\s]?to[-\s]?end)\b/i,
        /\bsecurity\b/i,
        /\bperformance|\bload\b/i,
        /\bapi\b/i,
        /\bdatabase|\bdb\b/i,
        /\baccessibility|a11y\b/i,
      ];
      const hits = tokens.filter((re) => re.test(text)).length;
      const ok = hits >= 5;
      return {
        ok,
        evidence: { categoriesFound: hits, minimumRequired: 5 },
        remediation: 'cobolt-create-test-strategy must enumerate all 8 categories even if some are marked N/A.',
      };
    },
  },
];

function parseArgs(argv) {
  const out = { command: 'check', project: process.cwd(), json: false, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--project' || a === '--dir' || a === '--root') {
      out.project = argv[i + 1] || out.project;
      i += 1;
    } else if (a.startsWith('--project=')) out.project = a.slice('--project='.length);
    else if (a.startsWith('--')) out.unknown = a;
    else positional.push(a);
  }
  if (positional.length > 0) out.command = positional[0];
  return out;
}

function resolvePlanningDir(projectRoot) {
  const candidates = [
    path.join(projectRoot, '_cobolt-output', 'latest', 'planning'),
    path.join(projectRoot, '_cobolt-output', 'planning'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function readOrNull(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function runChecks(projectRoot) {
  const planningDir = resolvePlanningDir(projectRoot);
  const report = { ok: true, projectRoot, planningDir, checks: [], findings: [] };
  if (!planningDir) {
    report.ok = false;
    report.error = 'No planning dir under _cobolt-output/';
    return report;
  }
  const context = {
    readFile(name) {
      return readOrNull(path.join(planningDir, name));
    },
  };
  for (const check of CHECKS) {
    const text = readOrNull(path.join(planningDir, check.file));
    if (text == null) {
      const skipped = {
        id: check.id,
        file: check.file,
        ok: false,
        reason: 'artifact missing',
        tier: check.tier,
      };
      report.checks.push(skipped);
      report.findings.push({
        id: check.id,
        severity: check.tier === 1 ? 'HIGH' : 'MEDIUM',
        file: check.file,
        message: `${check.file} is missing — ${check.description}`,
        remediation: `Producer must write ${check.file}. See cobolt-plan Phase 2/3.`,
      });
      report.ok = false;
      continue;
    }
    const result = check.evaluate(text, context);
    report.checks.push({
      id: check.id,
      file: check.file,
      ok: result.ok,
      tier: check.tier,
      evidence: result.evidence || null,
      description: check.description,
    });
    if (!result.ok) {
      report.findings.push({
        id: check.id,
        severity: check.tier === 1 ? 'HIGH' : 'MEDIUM',
        file: check.file,
        message: check.description,
        evidence: result.evidence || null,
        remediation: result.remediation || 'Strengthen the producer skill to emit the required content.',
      });
      report.ok = false;
    }
  }
  report.summary = {
    checked: report.checks.length,
    passed: report.checks.filter((c) => c.ok).length,
    failed: report.findings.length,
  };
  return report;
}

function printHuman(report) {
  console.log('CoBolt Plan Content-Depth Gate');
  console.log(`Project:      ${report.projectRoot}`);
  console.log(`Planning dir: ${report.planningDir || '(unresolved)'}`);
  if (report.error) {
    console.log(`Error: ${report.error}`);
    return;
  }
  console.log(
    `Summary:      ${report.summary.passed}/${report.summary.checked} passed, ${report.summary.failed} findings`,
  );
  console.log();
  for (const f of report.findings) {
    console.log(`  [${f.severity}] ${f.id} — ${f.file}`);
    console.log(`      ${f.message}`);
    console.log(`      remediation: ${f.remediation}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('Usage: node tools/cobolt-plan-content-depth-gate.js check [--project <dir>] [--json]');
    return 0;
  }
  if (args.unknown) {
    console.error(`Unknown option: ${args.unknown}`);
    return 1;
  }
  if (args.command !== 'check') {
    console.error(`Unknown command: ${args.command}`);
    return 1;
  }
  const report = runChecks(args.project);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  if (!report.planningDir) return 2;
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { CHECKS, runChecks, resolvePlanningDir, main };
