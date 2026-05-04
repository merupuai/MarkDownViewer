#!/usr/bin/env node

/**
 * cobolt-design-checklist.js — Pre-coding design readiness gate
 * Parses UX design spec for required handoff sections and validates completeness.
 *
 * Usage: node tools/cobolt-design-checklist.js [--json] [--spec path] [--help]
 */

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_SECTIONS = [
  {
    pattern: /##.*Data Binding|data.binding.map/i,
    name: 'Data Binding Map',
    description: 'API endpoint mapping per component',
  },
  {
    pattern: /##.*Error Content|error.content.spec/i,
    name: 'Error Content Specification',
    description: 'Error messages and actions per error type',
  },
  {
    pattern: /##.*Interaction Timing|animation.*duration|motion.*primitive/i,
    name: 'Interaction Timing',
    description: 'Animation durations, easings, and primitives',
  },
  {
    pattern: /##.*Responsive.*Collapse|responsive.*strategy|breakpoint/i,
    name: 'Responsive Collapse Strategy',
    description: 'Behavior at desktop/tablet/mobile breakpoints',
  },
  {
    pattern: /##.*State Matrix|state.*matrix/i,
    name: 'State Matrix',
    description: 'All states per component (default, loading, empty, error, etc.)',
  },
];

const REQUIRED_STATES = ['default', 'loading', 'empty', 'error', 'success', 'disabled', 'hover', 'focus', 'active'];

function findDesignSpec(projectRoot, specPath) {
  if (specPath && fs.existsSync(specPath)) return specPath;

  const candidates = [
    path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'ux-design-specification.md'),
    path.join(projectRoot, '_cobolt-output', 'latest', 'planning', 'ux-design.md'),
  ];

  // v0.40.3 — Milestone-dynamic lookup: scan _cobolt-output/reports/ for every
  // Mn/Mn-ux-design.md rather than hardcoding M1. This lets projects at M2+
  // find their own milestone's design spec. Earlier version hardcoded only
  // M1, which silently missed every subsequent milestone's design spec.
  const reportsDir = path.join(projectRoot, '_cobolt-output', 'reports');
  if (fs.existsSync(reportsDir)) {
    try {
      const milestoneDirs = fs
        .readdirSync(reportsDir)
        .filter((d) => /^M\d+$/.test(d))
        .sort((a, b) => parseInt(b.slice(1), 10) - parseInt(a.slice(1), 10)); // newest milestone first
      for (const m of milestoneDirs) {
        candidates.push(path.join(reportsDir, m, `${m}-ux-design.md`));
      }
    } catch {
      /* ignore readdir errors */
    }
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function run(projectRoot, options = {}) {
  const findings = [];
  const specPath = findDesignSpec(projectRoot, options.spec);

  if (!specPath) {
    return {
      findings: [
        {
          id: 'DESIGN001',
          severity: 'info',
          file: 'N/A',
          line: 0,
          message: 'No UX design spec found. Skipping checklist.',
        },
      ],
      summary: { total: 0, errors: 0, warnings: 0, pass: true },
      checklist: [],
    };
  }

  const content = fs.readFileSync(specPath, 'utf8');
  const relFile = path.relative(projectRoot, specPath);
  const checklist = [];

  // Check required handoff sections
  for (const section of REQUIRED_SECTIONS) {
    const found = section.pattern.test(content);
    checklist.push({ item: section.name, found, required: true, description: section.description });
    if (!found) {
      findings.push({
        id: 'DESIGN002',
        severity: 'error',
        file: relFile,
        line: 0,
        message: `Missing required section: "${section.name}" — ${section.description}`,
      });
    }
  }

  // Check state matrix completeness
  const stateMatrixMatch = content.match(/##.*State Matrix[\s\S]*?(?=##|$)/i);
  if (stateMatrixMatch) {
    const stateContent = stateMatrixMatch[0].toLowerCase();
    for (const state of REQUIRED_STATES) {
      const found = stateContent.includes(state);
      checklist.push({ item: `State: ${state}`, found, required: true });
      if (!found) {
        findings.push({
          id: 'DESIGN003',
          severity: 'warning',
          file: relFile,
          line: 0,
          message: `State matrix missing "${state}" state definition.`,
        });
      }
    }
  }

  // Check component registry alignment
  const registryPath = path.join(projectRoot, '_cobolt-output', 'latest', 'frontend', 'component-registry.json');
  if (fs.existsSync(registryPath)) {
    try {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

      // Check preferences alignment
      if (registry.userPreferences) {
        const prefs = registry.userPreferences;
        if (prefs.accentPreset && !content.toLowerCase().includes(prefs.accentPreset.replace('-', ' '))) {
          findings.push({
            id: 'DESIGN004',
            severity: 'warning',
            file: relFile,
            line: 0,
            message: `User preference accent "${prefs.accentPreset}" not reflected in design spec.`,
          });
        }
      }
    } catch {
      /* invalid registry */
    }
  }

  const summary = {
    total: findings.length,
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    pass: findings.filter((f) => f.severity === 'error').length === 0,
  };

  return { findings, summary, checklist };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: cobolt-design-checklist [--json] [--spec path] [--help]');
    console.log('  Pre-coding design readiness gate. Validates UX spec completeness.');
    process.exit(0);
  }
  const specIdx = args.indexOf('--spec');
  const spec = specIdx >= 0 ? args[specIdx + 1] : null;
  const result = run(process.cwd(), { spec });

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nDesign Readiness Checklist`);
    if (result.checklist.length > 0) {
      for (const item of result.checklist) {
        const icon = item.found ? 'PASS' : 'MISS';
        console.log(`  [${icon}] ${item.item}${item.description ? ` — ${item.description}` : ''}`);
      }
    }
    for (const f of result.findings.filter((f) => f.severity !== 'info')) {
      const icon = f.severity === 'error' ? 'ERROR' : 'WARN';
      console.log(`  [${icon}] ${f.id} — ${f.message}`);
    }
    console.log(
      `\n${result.summary.pass ? 'PASS' : 'FAIL'} — ${result.summary.errors} errors, ${result.summary.warnings} warnings\n`,
    );
    process.exit(result.summary.pass ? 0 : 1);
  }
}

module.exports = { run };
