#!/usr/bin/env node

// CoBolt UX Spec Completeness — verifies ux-design-specification.md contains
// every required section non-trivially populated. Five sections were observed
// missing in post-v0.26 planning output:
//   - State matrix (per-component state enumeration)
//   - Data binding map (field-to-source mapping)
//   - Error content spec (error message copy + CTA per error type)
//   - Interaction timing (hover/focus/loading/transition timing)
//   - Responsive collapse strategy (breakpoint behavior)
//
// Frontend-dev falls back to ux-design-specification.md when MCP is unavailable,
// so shipping a spec missing these sections results in improvised UI with
// missing error states and undefined responsive behavior.
//
// Commands:
//   check [--file path] [--json] [--min-section-bytes N]
//
// Exit codes:
//   0 = all required sections present and non-stub
//   1 = usage error
//   2 = spec file missing (Tier 2 skip)
//   5 = sections missing / too shallow

const fs = require('node:fs');
const path = require('node:path');
const { getPlanningDir } = require('../lib/cobolt-planning-artifacts');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_DEFECTS = 5;

// Canonical 16-section UX spec. Each section is matched by ANY of the provided
// heading regexes (case-insensitive). Sections marked `required: true` are
// Tier 1; others are advisory.
const REQUIRED_SECTIONS = [
  {
    key: 'product-intent',
    label: 'Product Intent / UX Objectives',
    required: true,
    patterns: [/ux objectives?/i, /product intent/i, /design goals?/i],
  },
  { key: 'principles', label: 'Design Principles', required: true, patterns: [/design principles?/i] },
  { key: 'personas', label: 'Personas', required: true, patterns: [/personas?/i, /user segments?/i] },
  {
    key: 'information-arch',
    label: 'Information Architecture',
    required: true,
    patterns: [/information architecture/i, /site ?map/i, /nav(?:igation)? architecture/i],
  },
  {
    key: 'design-system',
    label: 'Design System (tokens / typography / spacing)',
    required: true,
    patterns: [/design system/i, /design tokens?/i],
  },
  {
    key: 'component-inventory',
    label: 'Component Inventory',
    required: true,
    patterns: [/component inventory/i, /components?\s*(?:list|catalog|catalogue)?/i],
  },
  {
    key: 'screens',
    label: 'Screens & Layouts',
    required: true,
    patterns: [/screens? (?:&|and) layouts?/i, /screen inventory/i, /layouts?/i],
  },
  {
    key: 'state-matrix',
    label: 'State Matrix',
    required: true,
    patterns: [/state matrix/i, /component states?/i, /state enumeration/i],
  },
  {
    key: 'data-binding',
    label: 'Data Binding Map',
    required: true,
    patterns: [/data binding/i, /field(?:\s+to\s+source)?\s+mapping/i],
  },
  {
    key: 'error-content',
    label: 'Error Content Specification',
    required: true,
    patterns: [/error content/i, /error messag(?:e|ing)/i, /error (?:state|scenarios?)/i],
  },
  {
    key: 'interaction-timing',
    label: 'Interaction Timing',
    required: true,
    patterns: [/interaction timing/i, /animation (?:timing|spec)/i, /motion (?:spec|tokens?)/i],
  },
  {
    key: 'responsive',
    label: 'Responsive Collapse Strategy',
    required: true,
    patterns: [/responsive (?:collapse|strategy|behavior)/i, /breakpoint(?:s|\s+behavior)?/i],
  },
  { key: 'a11y', label: 'Accessibility', required: true, patterns: [/accessibility/i, /a11y/i, /wcag/i] },
  {
    key: 'i18n',
    label: 'Internationalization / i18n hooks',
    required: false,
    patterns: [/i18n/i, /internationali[sz]ation/i, /localization/i, /l10n/i],
  },
  { key: 'wireframes', label: 'Wireframes', required: false, patterns: [/wireframes?/i, /low[- ]fidelity/i] },
  {
    key: 'design-sources',
    label: 'Design Source References (Figma / Stitch)',
    required: false,
    patterns: [/design sources?/i, /figma/i, /stitch/i, /mcp (?:attempt|log)/i],
  },
];

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function argValue(argv, flag, fallback) {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  return argv[i + 1];
}

function resolveFile(args) {
  const explicit = argValue(args, '--file', null);
  if (explicit) return path.resolve(explicit);
  const pd = getPlanningDir(process.cwd(), { create: false, fallbackToLatest: true });
  if (!pd) return null;
  const candidates = [
    path.join(pd, 'ux-design-specification.md'),
    path.join(pd, 'ux', 'ux-design-specification.md'),
    path.join(pd, 'ux-design.md'),
  ];
  return candidates.find((c) => fs.existsSync(c)) || candidates[0];
}

function splitIntoSections(text) {
  // Split at H2 (## ) boundaries. Keep heading line as part of the section body.
  const lines = text.split(/\r?\n/);
  const sections = [];
  let current = { heading: '(preamble)', body: [] };
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      sections.push(current);
      current = { heading: line.replace(/^##\s+/, '').trim(), body: [line] };
    } else {
      current.body.push(line);
    }
  }
  sections.push(current);
  return sections
    .filter((s) => s.heading !== '(preamble)' || s.body.join('').trim().length > 0)
    .map((s) => ({ heading: s.heading, body: s.body.join('\n') }));
}

function isStub(body) {
  const trimmed = body.replace(/^##\s+.+\n?/, '').trim();
  if (trimmed.length < 40) return true;
  if (/^tbd$|^todo$|^n\/a$/i.test(trimmed)) return true;
  if (/<!--\s*(?:placeholder|tbd|todo)\s*-->/i.test(trimmed)) return true;
  return false;
}

function check(filePath, _opts) {
  if (!fs.existsSync(filePath)) {
    return { verdict: 'SKIP', reason: `spec not found at ${filePath}`, exitCode: EXIT_MISSING };
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const sections = splitIntoSections(text);
  const findings = [];
  const results = [];

  for (const req of REQUIRED_SECTIONS) {
    const match = sections.find((s) => req.patterns.some((re) => re.test(s.heading)));
    const entry = { key: req.key, label: req.label, required: req.required };
    if (!match) {
      entry.status = 'missing';
      if (req.required) {
        findings.push({
          severity: 'high',
          class: 'ux-section-missing',
          key: req.key,
          label: req.label,
          message: `required section "${req.label}" not found`,
        });
      }
    } else {
      entry.heading = match.heading;
      entry.bytes = Buffer.byteLength(match.body, 'utf8');
      if (isStub(match.body)) {
        entry.status = 'stub';
        if (req.required) {
          findings.push({
            severity: 'high',
            class: 'ux-section-stub',
            key: req.key,
            label: req.label,
            bytes: entry.bytes,
            message: `section "${req.label}" is <40 non-heading chars or contains stub marker`,
          });
        }
      } else {
        entry.status = 'present';
      }
    }
    results.push(entry);
  }

  const verdict = findings.length === 0 ? 'PASS' : 'FAIL';
  return {
    verdict,
    filePath,
    sectionsFound: sections.length,
    sections: results,
    findings,
    exitCode: verdict === 'PASS' ? EXIT_OK : EXIT_DEFECTS,
  };
}

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'check';
  const json = hasFlag(args, '--json');

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Usage: cobolt-ux-completeness.js check [--file path] [--json]');
    process.exit(EXIT_OK);
  }

  if (cmd !== 'check') {
    console.error(`Unknown command: ${cmd}`);
    process.exit(EXIT_USAGE);
  }

  const fp = resolveFile(args);
  if (!fp) {
    const out = { verdict: 'SKIP', reason: 'no planning directory' };
    if (json) console.log(JSON.stringify(out, null, 2));
    else console.log('no planning directory');
    process.exit(EXIT_MISSING);
  }

  const result = check(fp, {});
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('== UX Completeness ==');
    console.log(`file: ${fp}`);
    for (const s of result.sections || []) {
      const mark = s.status === 'present' ? 'OK  ' : s.status === 'stub' ? 'STUB' : 'MISS';
      const reqTag = s.required ? '[req]' : '[opt]';
      console.log(`  [${mark}] ${reqTag} ${s.label}${s.bytes ? ` (${s.bytes}B)` : ''}`);
    }
    console.log(`verdict: ${result.verdict}`);
    for (const f of (result.findings || []).slice(0, 10)) {
      console.log(`  -> ${f.class}: ${f.message}`);
    }
  }

  process.exit(result.exitCode);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { check, REQUIRED_SECTIONS };
