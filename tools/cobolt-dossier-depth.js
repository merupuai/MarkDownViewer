#!/usr/bin/env node

// CoBolt Feature Dossier Depth — verifies FEAT-NNN.md dossiers are deep enough
// to drive development handoff (not hollow skeletons that pass existing byte gates).
//
// Enforced minimums (tunable via flags):
//   - File size:        >= 2500 bytes (excluding frontmatter + HTML comments)
//   - Section count:    >= 12 of 15 canonical headings
//   - BDD AC scenarios: >= 1 Given/When/Then (or explicit "N/A — reason")
//   - Stub markers:     no "TBD", "tbd", "<placeholder>", "[fill me in]"
//
// Canonical sections (see source/templates/cobolt-feature-dossier-template.md):
//   Product Intent, User Expectations, Functional Requirements, User-Facing Surfaces,
//   Data Model, Dependencies, Risks, Acceptance Criteria, Test Strategy, API Contracts,
//   Security, Rollout, Traceability, Implementation Notes, Definition of Done.
//
// Commands:
//   check [--dir <path>] [--min-sections N] [--min-bytes N] [--json]
//
// Exit codes:
//   0 = all dossiers pass
//   1 = usage error
//   2 = missing dossier directory (Tier 2 skip)
//   5 = one or more dossiers fail depth criteria

const fs = require('node:fs');
const path = require('node:path');
const { getPlanningDir } = require('../lib/cobolt-planning-artifacts');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_DEPTH_FAIL = 5;

const CANONICAL_SECTIONS = [
  /product intent/i,
  /user expectations|user journeys/i,
  /functional requirements/i,
  /user[- ]facing surfaces|surfaces/i,
  /data model/i,
  /dependencies/i,
  /risks/i,
  /acceptance criteria/i,
  /test strategy/i,
  /api contract/i,
  /security|compliance/i,
  /rollout|migration/i,
  /traceability/i,
  /implementation notes/i,
  /definition of done/i,
];

const STUB_MARKERS = [/\bTBD\b/i, /<placeholder>/i, /\[fill[- ]me[- ]in\]/i, /\bLorem ipsum\b/i];

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function argValue(argv, flag, fallback) {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  return argv[i + 1];
}

function stripFrontmatter(text) {
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text;
  return text.slice(end + 4);
}

function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

function extractHeadings(text) {
  return [...text.matchAll(/^#{1,4}\s+(.+?)\s*$/gm)].map((m) => m[1].trim());
}

function countBddScenarios(text) {
  // Count Scenario: blocks or Given/When/Then triples
  const scenarios = (text.match(/^Scenario:\s*.+$/gm) || []).length;
  if (scenarios > 0) return scenarios;
  const given = (text.match(/\bgiven\b/gi) || []).length;
  const when = (text.match(/\bwhen\b/gi) || []).length;
  const then = (text.match(/\bthen\b/gi) || []).length;
  return Math.min(given, when, then);
}

function verifyDossier(filePath, opts) {
  const rel = path.basename(filePath);
  const raw = fs.readFileSync(filePath, 'utf8');
  const body = stripHtmlComments(stripFrontmatter(raw));
  const bytes = Buffer.byteLength(body.trim(), 'utf8');

  const headings = extractHeadings(body);
  const sectionMatches = CANONICAL_SECTIONS.filter((re) => headings.some((h) => re.test(h))).length;
  const bdd = countBddScenarios(body);
  const stubs = STUB_MARKERS.flatMap((re) => {
    const m = body.match(re);
    return m ? [m[0]] : [];
  });

  // Explicit N/A pass (e.g., "N/A — feature has no API surface")
  const naOk = /\bN\/A\b[\s—-]/i.test(body);

  const findings = [];
  if (bytes < opts.minBytes) {
    findings.push({ class: 'dossier-too-shallow', severity: 'high', bytes, minBytes: opts.minBytes });
  }
  if (sectionMatches < opts.minSections) {
    findings.push({
      class: 'dossier-missing-sections',
      severity: 'high',
      sectionMatches,
      minSections: opts.minSections,
    });
  }
  if (bdd < opts.minBddScenarios && !naOk) {
    findings.push({
      class: 'dossier-missing-bdd',
      severity: 'medium',
      bdd,
      minBddScenarios: opts.minBddScenarios,
    });
  }
  if (stubs.length > 0) {
    findings.push({ class: 'dossier-stub-markers', severity: 'medium', samples: stubs.slice(0, 3) });
  }

  return {
    dossier: rel,
    path: filePath,
    bytes,
    sectionMatches,
    bddScenarios: bdd,
    stubCount: stubs.length,
    findings,
    passed: findings.every((f) => f.severity !== 'high'),
  };
}

function findDossierFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /^FEAT-\d+.*\.md$/i.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function resolveDossierDir(argv) {
  const explicit = argValue(argv, '--dir', null);
  if (explicit) return path.resolve(explicit);
  const pd = getPlanningDir(process.cwd(), { create: false, fallbackToLatest: true });
  if (!pd) return null;
  const candidates = [path.join(pd, 'feature-dossiers'), path.join(pd, 'features'), path.join(pd, 'dossiers')];
  return candidates.find((c) => fs.existsSync(c)) || candidates[0];
}

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'check';
  const json = hasFlag(args, '--json');

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(
      'Usage: cobolt-dossier-depth.js check [--dir <path>] [--min-sections N] [--min-bytes N] [--min-bdd N] [--json]',
    );
    process.exit(EXIT_OK);
  }

  if (cmd !== 'check') {
    console.error(`Unknown command: ${cmd}`);
    process.exit(EXIT_USAGE);
  }

  const opts = {
    minBytes: parseInt(argValue(args, '--min-bytes', '2500'), 10),
    minSections: parseInt(argValue(args, '--min-sections', '12'), 10),
    minBddScenarios: parseInt(argValue(args, '--min-bdd', '1'), 10),
  };

  const dir = resolveDossierDir(args);
  if (!dir || !fs.existsSync(dir)) {
    const out = { verdict: 'SKIP', reason: 'dossier directory not found', dir };
    if (json) console.log(JSON.stringify(out, null, 2));
    else console.log(`dossier directory not found: ${dir}`);
    process.exit(EXIT_MISSING);
  }

  const files = findDossierFiles(dir);
  if (files.length === 0) {
    const out = { verdict: 'SKIP', reason: 'no FEAT-*.md dossiers found', dir };
    if (json) console.log(JSON.stringify(out, null, 2));
    else console.log('no FEAT-*.md dossiers to verify');
    process.exit(EXIT_MISSING);
  }

  const results = files.map((f) => verifyDossier(f, opts));
  const failed = results.filter((r) => !r.passed);
  const verdict = failed.length === 0 ? 'PASS' : 'FAIL';

  const report = {
    verdict,
    dir,
    opts,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`== CoBolt Dossier Depth (${results.length} dossiers) ==`);
    for (const r of results) {
      const mark = r.passed ? 'PASS' : 'FAIL';
      console.log(
        `  [${mark}] ${r.dossier} — ${r.bytes}B / ${r.sectionMatches}/${CANONICAL_SECTIONS.length} sections / ${r.bddScenarios} BDD`,
      );
      for (const f of r.findings) {
        console.log(`       ${f.severity}: ${f.class}`);
      }
    }
    console.log('');
    console.log(`verdict: ${verdict} (${failed.length} of ${results.length} failed)`);
  }

  process.exit(verdict === 'PASS' ? EXIT_OK : EXIT_DEPTH_FAIL);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { verifyDossier, findDossierFiles };
