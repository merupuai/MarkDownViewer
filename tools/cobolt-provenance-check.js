#!/usr/bin/env node

// CoBolt Decision Provenance Check
//
// Scans story specs + recent commit messages for citation markers on
// non-trivial choices. A non-trivial choice is any line mentioning:
//   library/framework pick ("using <name>", "chose <X> over <Y>")
//   architectural pattern ("event-driven", "CQRS", "saga", "circuit breaker")
//   structural decision ("added layer", "split service", "moved to")
//
// Valid citation formats:
//   [PRD]         [PRD:FR-123]      [PRD:NFR-5]
//   [ARCH]        [ARCH:section]
//   [ADR-N]       [ADR-0007]
//   [M{k}#file:line]   (prior milestone source reference)
//
// Missing citations don't block — this is ADVISORY for reviewers. Writes
// _cobolt-output/latest/provenance/findings.json. Reviewers surface in
// cobolt-review. Tier 8.2 — v0.11.0 (prompt-level enforcement + advisory
// scan; no hard gate because false positives are too common).
//
// Usage:
//   node tools/cobolt-provenance-check.js scan [--milestone M3]
//   node tools/cobolt-provenance-check.js report

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const CITATION_PATTERN = /\[(PRD|ARCH|ADR-\d+|M\d+#[^\]]+|FR-\d+|NFR-\d+|IR-\d+|SK-\d+|IC-[A-Z]+-\d+)[^\]]*\]/;

const DECISION_PATTERNS = [
  /\b(using|chose|picked|selected|switched to|moved to|migrating to)\s+[A-Z][\w.-]+\b/i,
  /\b(event[-\s]driven|cqrs|saga|circuit[-\s]breaker|bulkhead|read[-\s]replica|sharding|cache[-\s]aside)\b/i,
  /\badded\s+(layer|service|middleware|adapter|gateway)\b/i,
  /\b(refactored|split|extracted|inlined)\s+[A-Z\w]+\b/,
];

function storyFiles() {
  const root = path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'stories');
  if (!fs.existsSync(root)) return [];
  const out = [];
  function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.md')) out.push(full);
    }
  }
  walk(root);
  return out;
}

function recentCommitMessages(n = 30) {
  try {
    const out = execFileSync('git', ['log', `-${n}`, '--pretty=format:%H%x09%B%x1e'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\x1e')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry) => {
        const [hash, ...rest] = entry.split('\t');
        return { hash, body: rest.join('\t') };
      });
  } catch {
    return [];
  }
}

function findDecisionsInText(text) {
  const decisions = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < 8) continue;
    for (const pat of DECISION_PATTERNS) {
      if (pat.test(line)) {
        decisions.push({ line: i + 1, text: line.trim().slice(0, 200), cited: CITATION_PATTERN.test(line) });
        break;
      }
    }
  }
  return decisions;
}

function scan(_opts = {}) {
  const findings = [];

  // Stories
  for (const f of storyFiles()) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const decisions = findDecisionsInText(text);
    for (const d of decisions) {
      if (!d.cited) {
        findings.push({
          source: 'story',
          file: path.relative(process.cwd(), f),
          line: d.line,
          snippet: d.text,
          reason: 'non-trivial choice without citation marker',
        });
      }
    }
  }

  // Commit messages
  const commits = recentCommitMessages(50);
  for (const c of commits) {
    const decisions = findDecisionsInText(c.body);
    for (const d of decisions) {
      if (!d.cited) {
        findings.push({
          source: 'commit',
          commit: c.hash.slice(0, 8),
          line: d.line,
          snippet: d.text,
          reason: 'non-trivial choice without citation marker',
        });
      }
    }
  }

  // Write report
  const dir = path.join(process.cwd(), '_cobolt-output', 'latest', 'provenance');
  const fp = path.join(dir, 'findings.json');
  const result = {
    ok: findings.length === 0,
    total: findings.length,
    findings,
    generatedAt: new Date().toISOString(),
    note: 'Advisory only. Cite decisions with [PRD] / [ARCH] / [ADR-N] / [M{k}#file:line] / [FR-N] / [NFR-N] / [IR-N] / [SK-N] / [IC-X-N].',
  };
  atomicWrite(fp, JSON.stringify(result, null, 2));
  return { ...result, report: fp };
}

function report() {
  const fp = path.join(process.cwd(), '_cobolt-output', 'latest', 'provenance', 'findings.json');
  if (!fs.existsSync(fp)) {
    console.log('(no provenance scan yet — run: cobolt-provenance-check scan)');
    return 0;
  }
  const r = JSON.parse(fs.readFileSync(fp, 'utf8'));
  console.log(`Provenance scan: ${r.ok ? 'PASS (all decisions cited)' : 'ADVISORY'}`);
  console.log(`${r.total} unencited decision(s)`);
  for (const f of r.findings.slice(0, 20)) {
    const where = f.source === 'story' ? `${f.file}:${f.line}` : `commit ${f.commit}`;
    console.log(`  - ${where}: "${f.snippet}"`);
  }
  if (r.findings.length > 20) console.log(`  …and ${r.findings.length - 20} more`);
  return 0;
}

function main() {
  const [cmd] = process.argv.slice(2);
  const isHelp = cmd === '--help' || cmd === '-h' || cmd === 'help';
  switch (cmd) {
    case 'scan': {
      const r = scan();
      console.log(JSON.stringify({ total: r.total, report: r.report }, null, 2));
      return 0;
    }
    case 'report':
      return report();
    default: {
      const usage = 'Usage: cobolt-provenance-check.js {scan|report}';
      if (isHelp || !cmd) {
        process.stdout.write(`${usage}\n`);
        return 0;
      }
      process.stderr.write(`${usage}\n`);
      return 1;
    }
  }
}

if (require.main === module) process.exit(main());

module.exports = { scan };
