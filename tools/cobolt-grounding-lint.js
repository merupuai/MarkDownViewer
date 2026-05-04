#!/usr/bin/env node

// cobolt-grounding-lint — flags reviewer-class agents missing EGR (Evidence-Gated Review)
//
// A reviewer-class agent is any source/agents/*.md whose name ends in -reviewer,
// -scanner, -auditor, -verifier, or whose frontmatter declares outputSchema:
// review-findings (or includes review-findings in an array).
//
// Each reviewer-class agent must contain an "EVIDENCE-GATED VERIFICATION" block
// in its body — see source/skills/_shared/reviewer-grounding-rules.md.
//
// Why: pure-LLM reviewers fabricate file paths, line numbers, and code quotes
// at 20–95% rates depending on context pressure. EGR makes evidence claims
// auditable so cobolt-finding-verifier can auto-strip phantoms.
//
// Exit codes:
//   0 — all reviewer-class agents have EGR
//   1 — one or more reviewer-class agents missing EGR
//   2 — invocation error (bad path, etc.)
//
// Outputs JSON to stdout when --json is passed.

const fs = require('node:fs');
const path = require('node:path');

const REVIEWER_NAME_SUFFIXES = ['-reviewer', '-scanner', '-auditor', '-verifier'];
const REVIEWER_OUTPUT_SCHEMAS = ['review-findings', 'review-findings.schema.json'];
const EGR_MARKER = /EVIDENCE-GATED VERIFICATION/i;

// Agents explicitly exempted from EGR — typically deterministic tool-runners
// that perform no LLM analysis (regex-only scanners, pure tool wrappers, or
// runtime exploit verifiers whose evidence model is captured via outputSchema
// rather than EGR).
//
// Each entry must include a one-line reason. Adding to this list requires
// PR review.
const EGR_EXEMPT = new Map([
  ['pr-threat-scanner', 'Pure deterministic regex tool runner — no LLM judgment'],
  ['security-exploit-verifier', 'Runtime exploit attempts captured via exploit-attempt outputSchema'],
  [
    'rule-validator-agent',
    'Validates AI-extracted rules against live system behavior — runtime evidence not source-line evidence',
  ],
  ['review-lead', 'Orchestrator — aggregates findings from EGR-bound reviewer sub-agents, makes no first-party claims'],
  [
    'cobolt-review-lead',
    'Orchestrator — aggregates findings from EGR-bound reviewer sub-agents, makes no first-party claims',
  ],
]);

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

function isReviewerClass(name, frontmatter, content) {
  if (REVIEWER_NAME_SUFFIXES.some((s) => name.endsWith(s))) return true;
  const schema = frontmatter.outputSchema || '';
  if (REVIEWER_OUTPUT_SCHEMAS.some((s) => schema.includes(s))) return true;
  const yamlMatch = content.match(/^outputSchema:\s*\n((?:\s+-\s+\S+\s*\n)+)/m);
  if (yamlMatch && REVIEWER_OUTPUT_SCHEMAS.some((s) => yamlMatch[1].includes(s))) return true;
  return false;
}

function lintAgents(agentsDir) {
  const violations = [];
  const exemptHits = [];
  let reviewersChecked = 0;
  let totalAgents = 0;
  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    if (entry.name === 'CLAUDE.md') continue;
    totalAgents++;
    const filePath = path.join(agentsDir, entry.name);
    const content = fs.readFileSync(filePath, 'utf8');
    const frontmatter = parseFrontmatter(content);
    const name = frontmatter.name || entry.name.replace('.md', '');
    if (!isReviewerClass(name, frontmatter, content)) continue;
    if (EGR_EXEMPT.has(name)) {
      exemptHits.push({ agent: name, reason: EGR_EXEMPT.get(name) });
      continue;
    }
    reviewersChecked++;
    if (!EGR_MARKER.test(content)) {
      violations.push({
        agent: name,
        file: path.relative(process.cwd(), filePath).replace(/\\/g, '/'),
        reason: 'Missing EVIDENCE-GATED VERIFICATION block',
      });
    }
  }
  return { totalAgents, reviewersChecked, exemptCount: exemptHits.length, violations, exemptHits };
}

function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const agentsDir = path.resolve(__dirname, '..', 'source', 'agents');
  if (!fs.existsSync(agentsDir)) {
    process.stderr.write(`[cobolt-grounding-lint] agents dir not found: ${agentsDir}\n`);
    process.exit(2);
  }
  const result = lintAgents(agentsDir);
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `[cobolt-grounding-lint] Scanned ${result.totalAgents} agents, ${result.reviewersChecked} reviewer-class checked, ${result.exemptCount} exempt.\n`,
    );
    if (result.violations.length === 0) {
      process.stdout.write('[cobolt-grounding-lint] OK — every reviewer-class agent declares EGR.\n');
    } else {
      process.stdout.write(`[cobolt-grounding-lint] FAIL — ${result.violations.length} reviewer(s) missing EGR:\n`);
      for (const v of result.violations) {
        process.stdout.write(`  • ${v.agent} (${v.file}): ${v.reason}\n`);
      }
    }
  }
  process.exit(result.violations.length === 0 ? 0 : 1);
}

if (require.main === module) main();

module.exports = { lintAgents, isReviewerClass, parseFrontmatter, EGR_EXEMPT };
