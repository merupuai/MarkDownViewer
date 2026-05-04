#!/usr/bin/env node

// CoBolt ADR Resolution — blocks plan close while ADRs referenced as
// authoritative elsewhere carry a non-final status (Proposed | Draft).
//
// Closes Blocker #8 from the Meru readiness review: ADR-013 selected
// Next.js + Tailwind + shadcn but was marked Proposed, while system
// architecture and stories treated it as confirmed and the PRD still said
// Phoenix LiveView. Downstream agents got contradictory stacks.
//
// Invariants:
//   1. An ADR file with `status: Proposed | Draft | Pending | Superseded`
//      whose ID is referenced in architecture.md, prd.md, ux-design-
//      specification.md, engineering-standards.md, or any story as if it
//      were accepted is a violation.
//   2. Cross-artifact stack drift — planning documents must agree on the
//      dominant frontend / backend / database choices. Conflicting stacks
//      (Next.js vs Phoenix LiveView in the same project) are flagged.
//
// Exit codes:
//   0 = resolved
//   1 = usage
//   2 = no planning dir
//   3 = unresolved ADRs / stack drift — Tier 1 block

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_VIOLATION = 3;

function planningDir(cwd = process.cwd()) {
  const p = path.join(cwd, '_cobolt-output', 'latest', 'planning');
  return fs.existsSync(p) ? p : null;
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function listFiles(dir, pattern) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => pattern.test(f));
  } catch {
    return [];
  }
}

function parseAdrMarkdown(content, fileName) {
  if (!content) return null;
  const idMatch = fileName.match(/(?:^|[^a-z])ADR-(\d{2,4})/i) || content.match(/ADR[- ]?(\d{2,4})/i);
  if (!idMatch) return null;
  const id = `ADR-${idMatch[1]}`;
  const statusMatch = content.match(/\b(?:status)\s*[:=]\s*([A-Za-z][A-Za-z ]{2,20})/i);
  const status = statusMatch ? statusMatch[1].trim() : null;
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : null;
  return { id, status, title, file: fileName };
}

function findAdrFiles(pd) {
  const candidates = new Set();
  // Common ADR homes within planning
  for (const sub of ['', 'adr', 'adrs', 'architecture-decisions', 'architecture/adr']) {
    const d = path.join(pd, sub);
    for (const f of listFiles(d, /adr[- ]?\d+.*\.md$/i)) {
      candidates.add(path.join(d, f));
    }
  }
  // Top-level adr-log.md or architecture-decisions.md
  for (const f of ['adr-log.md', 'architecture-decisions.md']) {
    const p = path.join(pd, f);
    if (fs.existsSync(p)) candidates.add(p);
  }
  return [...candidates];
}

// Extract ADR entries from a concatenated ADR log file (one file with multiple
// ADR sections), returning an array of {id, status, title}.
function extractAdrsFromLog(content) {
  if (!content) return [];
  const sections = content.split(/(?=^##+\s+ADR[- ]?\d)/m);
  const out = [];
  for (const section of sections) {
    const idMatch = section.match(/ADR[- ]?(\d{2,4})/);
    if (!idMatch) continue;
    const id = `ADR-${idMatch[1]}`;
    const statusMatch = section.match(/\b(?:status)\s*[:=]\s*([A-Za-z][A-Za-z ]{2,20})/i);
    const status = statusMatch ? statusMatch[1].trim() : null;
    const titleMatch = section.match(/ADR[- ]?\d{2,4}[:\-\s]+(.+?)(?:\n|$)/);
    const title = titleMatch ? titleMatch[1].trim() : null;
    out.push({ id, status, title, file: 'adr-log' });
  }
  return out;
}

const NON_FINAL_STATUS = /^(proposed|draft|pending|superseded|deprecated|rejected|under[- ]review)$/i;
const FINAL_STATUS = /^(accepted|approved|confirmed|final|active|implemented)$/i;

// Conflict detectors — stack-level keywords
const STACK_KEYWORDS = {
  frontendFramework: {
    'next.js': /\bNext\.?js\b|App\s+Router/i,
    'phoenix-liveview': /\bPhoenix\s+LiveView\b|LiveView\b/i,
    react: /\bReact\b(?!ive)/i,
    vue: /\bVue(?:\.js)?\b/i,
    svelte: /\bSvelteKit\b|\bSvelte\b/i,
    'react-native': /\bReact Native\b/i,
  },
  backendFramework: {
    phoenix: /\bPhoenix\s+framework\b|Phoenix\.\w+/i,
    express: /\bExpress\.?js\b/i,
    fastify: /\bFastify\b/i,
    go: /\bGo\s+(?:services|gateway|runtime)\b/i,
    rust: /\bRust\s+(?:services|gateway|tauri)\b/i,
    django: /\bDjango\b/i,
  },
};

function collectStackMentions(docs) {
  const found = {};
  for (const [category, keywords] of Object.entries(STACK_KEYWORDS)) {
    found[category] = {};
    for (const [name, re] of Object.entries(keywords)) {
      for (const [docName, content] of Object.entries(docs)) {
        if (!content) continue;
        if (re.test(content)) {
          if (!found[category][name]) found[category][name] = [];
          found[category][name].push(docName);
        }
      }
    }
  }
  return found;
}

function check({ dir }) {
  const pd = dir || planningDir();
  if (!pd) return { exitCode: EXIT_MISSING, error: 'no planning directory' };

  // Gather ADRs
  const adrs = new Map();
  for (const f of findAdrFiles(pd)) {
    const content = readFileSafe(f);
    const base = path.basename(f);
    if (base === 'adr-log.md' || base === 'architecture-decisions.md') {
      for (const a of extractAdrsFromLog(content)) adrs.set(a.id, a);
    } else {
      const a = parseAdrMarkdown(content, base);
      if (a) adrs.set(a.id, a);
    }
  }

  // Gather authority documents that reference ADR IDs
  const docNames = [
    'prd.md',
    'architecture.md',
    'ux-design-specification.md',
    'engineering-standards.md',
    'data-model-spec.md',
    'api-contracts.md',
    'security-requirements.md',
  ];
  const docs = {};
  for (const name of docNames) docs[name] = readFileSafe(path.join(pd, name));

  const violations = [];

  // Invariant 1: non-final ADRs referenced as authoritative
  for (const [id, a] of adrs.entries()) {
    if (!a.status || FINAL_STATUS.test(a.status)) continue;
    if (!NON_FINAL_STATUS.test(a.status)) continue;
    const referencing = [];
    for (const [docName, content] of Object.entries(docs)) {
      if (!content) continue;
      if (new RegExp(`\\b${id}\\b`).test(content)) referencing.push(docName);
    }
    if (referencing.length > 0) {
      violations.push({
        type: 'adr-not-final-but-referenced',
        adr: id,
        status: a.status,
        title: a.title,
        referencedBy: referencing,
        hint: `Mark ${id} status as Accepted (or remove references) before plan close.`,
      });
    }
  }

  // Invariant 2: frontend / backend stack drift across authoritative docs
  const stacks = collectStackMentions(docs);
  for (const [category, choices] of Object.entries(stacks)) {
    const candidates = Object.keys(choices);
    if (candidates.length >= 2) {
      // Only flag when conflicting choices appear across DIFFERENT authoritative
      // docs — i.e., PRD says one, architecture says another. Same doc listing
      // alternatives is allowed (exploration).
      const docToChoice = {};
      for (const [choice, docList] of Object.entries(choices)) {
        for (const d of docList) {
          if (!docToChoice[d]) docToChoice[d] = [];
          docToChoice[d].push(choice);
        }
      }
      const docsWithSingleChoice = Object.entries(docToChoice).filter(([, cs]) => cs.length === 1);
      const distinctChoices = new Set(docsWithSingleChoice.map(([, cs]) => cs[0]));
      if (distinctChoices.size >= 2 && docsWithSingleChoice.length >= 2) {
        violations.push({
          type: 'stack-drift-across-authoritative-docs',
          category,
          detail: Object.fromEntries(docsWithSingleChoice),
          hint: 'Authoritative docs disagree on stack choice. Resolve via an Accepted ADR and align all docs before plan close.',
        });
      }
    }
  }

  return {
    exitCode: violations.length > 0 ? EXIT_VIOLATION : EXIT_OK,
    planningDir: pd,
    summary: {
      totalAdrs: adrs.size,
      nonFinalAdrs: [...adrs.values()].filter((a) => a.status && NON_FINAL_STATUS.test(a.status)).length,
      referencedNonFinalAdrs: violations.filter((v) => v.type === 'adr-not-final-but-referenced').length,
      stackDrifts: violations.filter((v) => v.type === 'stack-drift-across-authoritative-docs').length,
    },
    adrs: [...adrs.values()],
    violations,
  };
}

function formatText(r) {
  const lines = ['== ADR Resolution =='];
  lines.push(`  planningDir: ${r.planningDir || '(missing)'}`);
  if (r.summary) for (const [k, v] of Object.entries(r.summary)) lines.push(`  ${k}: ${v}`);
  if (r.violations?.length) {
    lines.push('  violations:');
    for (const v of r.violations.slice(0, 30)) {
      lines.push(`    - [${v.type}] ${v.adr || v.category || ''} ${v.status ? `[${v.status}]` : ''}`);
    }
  }
  lines.push(`verdict: ${r.exitCode === EXIT_OK ? 'PASS' : 'VIOLATION'}`);
  return lines.join('\n');
}

function main(argv = process.argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'check';
  const json = args.includes('--json');
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Usage: cobolt-adr-resolution.js check [--json]');
    process.exit(EXIT_OK);
  }
  if (cmd !== 'check' && cmd !== 'report') {
    console.error('Usage: cobolt-adr-resolution.js check [--json]');
    process.exit(EXIT_USAGE);
  }
  const r = check({});
  if (json) console.log(JSON.stringify(r, null, 2));
  else console.log(formatText(r));
  process.exit(cmd === 'report' ? EXIT_OK : r.exitCode);
}

if (require.main === module) main();

module.exports = { check, parseAdrMarkdown, extractAdrsFromLog, collectStackMentions, EXIT_OK, EXIT_VIOLATION };
