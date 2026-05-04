#!/usr/bin/env node

// CoBolt Postmortem Ingest - convert incident logs into learning records.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CATEGORY_RULES = [
  { category: 'artifact-path', pattern: /\b(wrong path|incorrect path|misplaced|canonical path|output path)\b/i },
  { category: 'worktree', pattern: /\b(worktree|cleanup|ephemeral|lost files|files lost)\b/i },
  { category: 'context-budget', pattern: /\b(token|context|prd fan|large prd|skill loading|near-capacity)\b/i },
  { category: 'ui-runtime', pattern: /\b(ui|css|tailwind|unstyled|screenshot|raw text|visual)\b/i },
  { category: 'auth-contract', pattern: /\b(auth|sign-?in|login|register|session|cookie|redirect)\b/i },
  { category: 'branch-topology', pattern: /\b(pr|pull request|merge conflict|branch|merge-base)\b/i },
  { category: 'runtime-contract', pattern: /\b(elixir|node|version|runtime)\b/i },
  { category: 'workflow-state', pattern: /\b(auto mode|autonomous|stopped|wait|sequence|loop)\b/i },
  { category: 'documentation', pattern: /\b(readme|docs|documentation)\b/i },
];

const CATEGORY_GATES = {
  'artifact-path': ['planning-artifact-audit', 'artifact-provenance'],
  worktree: ['worktree'],
  'context-budget': ['planning-context', 'context-budget', 'milestone-cost-report'],
  'ui-runtime': ['frontend-runtime-check', 'ui-pr-evidence', 'framework-contracts'],
  'auth-contract': ['auth-contract'],
  'branch-topology': ['branch-topology'],
  'runtime-contract': ['runtime-contract', 'framework-contracts'],
  'workflow-state': ['auto-state', 'stop-line'],
  documentation: ['readme-gen'],
  general: ['gate-coverage'],
};

function outputDir(projectRoot = process.cwd()) {
  return path.join(projectRoot, '_cobolt-output', 'evolution');
}

function slugify(text) {
  return String(text || 'postmortem')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function hashText(text) {
  return crypto
    .createHash('sha256')
    .update(String(text || ''))
    .digest('hex')
    .slice(0, 12);
}

function splitMarkdownTableLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim().replace(/^\*\*|\*\*$/g, ''));
}

function parseIncidentTable(text) {
  const lines = String(text || '').split(/\r?\n/);
  const rows = [];
  let headers = null;
  for (const line of lines) {
    const cells = splitMarkdownTableLine(line);
    if (!cells) continue;
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    if (!headers) {
      headers = cells.map((cell) =>
        cell
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_|_$/g, ''),
      );
      continue;
    }
    if (cells.length < 2) continue;
    const row = {};
    headers.forEach((header, index) => {
      row[header || `col_${index}`] = cells[index] || '';
    });
    rows.push(row);
  }
  return rows;
}

function classifyIncident(text) {
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(text)) return rule.category;
  }
  return 'general';
}

function extractIncidents(text) {
  const tableRows = parseIncidentTable(text);
  if (tableRows.length > 0) {
    return tableRows.map((row, index) => {
      const issue = row.issue || row.problem || row.title || `Incident ${index + 1}`;
      const rootCause = row.root_cause || row.cause || '';
      const fix = row.fix || row.resolution || '';
      const combined = `${issue}\n${rootCause}\n${fix}`;
      const category = classifyIncident(combined);
      return {
        id: `PM-${hashText(combined)}`,
        ordinal: Number.parseInt(row['#'] || row.id || index + 1, 10) || index + 1,
        issue,
        rootCause,
        fix,
        category,
        requiredControls: CATEGORY_GATES[category] || CATEGORY_GATES.general,
      };
    });
  }

  const paragraphs = String(text || '')
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 30);

  return paragraphs.map((paragraph, index) => {
    const category = classifyIncident(paragraph);
    return {
      id: `PM-${hashText(paragraph)}`,
      ordinal: index + 1,
      issue: paragraph.split(/\r?\n/)[0].slice(0, 160),
      rootCause: paragraph,
      fix: '',
      category,
      requiredControls: CATEGORY_GATES[category] || CATEGORY_GATES.general,
    };
  });
}

function appendJsonl(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  for (const entry of entries) {
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

function ingestPostmortem(filePath, options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const text = fs.readFileSync(filePath, 'utf8');
  const incidents = extractIncidents(text);
  const now = new Date().toISOString();
  const record = {
    id: `POST-${hashText(`${filePath}:${text}`)}`,
    source: path.relative(projectRoot, path.resolve(filePath)).replaceAll('\\', '/'),
    generatedAt: now,
    incidentCount: incidents.length,
    incidents,
  };

  const dir = path.join(outputDir(projectRoot), 'postmortems');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `${now.slice(0, 10)}-${slugify(path.basename(filePath))}-${record.id}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  const learningEntries = incidents.map((incident) => ({
    id: incident.id,
    category: 'postmortem',
    failureCategory: incident.category,
    description: incident.issue,
    evidence: incident.rootCause,
    controls: incident.requiredControls,
    createdAt: now,
  }));
  appendJsonl(path.join(outputDir(projectRoot), 'postmortem-lessons.jsonl'), learningEntries);

  const replayCandidates = incidents.map((incident) => ({
    id: `REPLAY-${incident.id.slice(3)}`,
    incidentId: incident.id,
    category: incident.category,
    suggestedControls: incident.requiredControls,
    status: 'candidate',
    createdAt: now,
  }));
  appendJsonl(path.join(outputDir(projectRoot), 'postmortem-replay-candidates.jsonl'), replayCandidates);

  if (options.recordAntiPatterns !== false) {
    try {
      const { recordAntiPattern } = require('./cobolt-anti-patterns');
      for (const incident of incidents) {
        recordAntiPattern({
          category: incident.category === 'context-budget' ? 'agent-strategy' : 'general',
          description: incident.issue,
          evidence: incident.rootCause || incident.fix,
          stage: incident.category,
          agent: 'postmortem-ingest',
          milestone: 'unknown',
        });
      }
    } catch {
      /* anti-pattern store is best effort */
    }
  }

  return { ...record, path: outPath, replayCandidates };
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'ingest';
  const json = argv.includes('--json');
  const filePath = argv.find((arg, index) => index > 0 && !arg.startsWith('--'));
  if (command !== 'ingest' || !filePath) {
    console.error('Usage: node tools/cobolt-postmortem-ingest.js ingest <file> [--json] [--no-anti-patterns]');
    process.exit(2);
  }
  const report = ingestPostmortem(filePath, { recordAntiPatterns: !argv.includes('--no-anti-patterns') });
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(`[cobolt-postmortem-ingest] Learned ${report.incidentCount} incident(s): ${report.path}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  CATEGORY_GATES,
  classifyIncident,
  extractIncidents,
  ingestPostmortem,
  parseIncidentTable,
};
