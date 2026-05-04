#!/usr/bin/env node

/**
 * cobolt-component-validator.js — Deterministic component registry validator
 * Validates component-registry.json structure, file existence, theme consistency.
 *
 * Usage: node tools/cobolt-component-validator.js [--json] [--help]
 */

const fs = require('node:fs');
const path = require('node:path');
const { detectUIProject } = require('./cobolt-ui-detection');

function run(projectRoot) {
  const findings = [];
  const registryPath = path.join(projectRoot, '_cobolt-output', 'latest', 'frontend', 'component-registry.json');
  const uiDetection = detectUIProject(projectRoot);

  if (!fs.existsSync(registryPath)) {
    if (uiDetection.hasUI) {
      return {
        findings: [
          {
            id: 'COMP001',
            severity: 'error',
            file: registryPath,
            line: 0,
            message:
              'UI project detected but component-registry.json is missing. Frontend builders must inventory existing components before creating or composing new UI.',
          },
        ],
        summary: { total: 1, errors: 1, warnings: 0, pass: false },
        uiDetection,
      };
    }
    return {
      findings: [
        {
          id: 'COMP001',
          severity: 'info',
          file: registryPath,
          line: 0,
          message: 'No component-registry.json found. Skipping validation.',
        },
      ],
      summary: { total: 0, errors: 0, warnings: 0, pass: true },
      uiDetection,
    };
  }

  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (e) {
    return {
      findings: [
        { id: 'COMP002', severity: 'error', file: registryPath, line: 0, message: `Invalid JSON: ${e.message}` },
      ],
      summary: { total: 1, errors: 1, warnings: 0, pass: false },
    };
  }

  // Check required top-level fields
  const requiredFields = ['project', 'theme', 'shadcn'];
  for (const field of requiredFields) {
    if (!registry[field]) {
      findings.push({
        id: 'COMP003',
        severity: 'error',
        file: 'component-registry.json',
        line: 0,
        message: `Missing required field: ${field}`,
      });
    }
  }

  // Validate installed shadcn components exist on disk
  if (registry.shadcn?.installed) {
    const componentsDir = registry.shadcn.componentsDir || 'components/ui';
    for (const comp of registry.shadcn.installed) {
      const compPath = path.join(projectRoot, componentsDir, `${comp}.tsx`);
      if (!fs.existsSync(compPath)) {
        findings.push({
          id: 'COMP004',
          severity: 'warning',
          file: `${componentsDir}/${comp}.tsx`,
          line: 0,
          message: `Registered shadcn component "${comp}" not found on disk.`,
        });
      }
    }
  }

  // Validate custom components exist on disk
  if (registry.custom && Array.isArray(registry.custom)) {
    for (const comp of registry.custom) {
      if (comp.path && !fs.existsSync(path.join(projectRoot, comp.path))) {
        findings.push({
          id: 'COMP005',
          severity: 'warning',
          file: comp.path,
          line: 0,
          message: `Custom component "${comp.name}" path not found.`,
        });
      }
    }
  }

  // Validate theme consistency with globals.css
  if (registry.theme?.cssVariablesFile) {
    const cssPath = path.join(projectRoot, registry.theme.cssVariablesFile);
    if (fs.existsSync(cssPath)) {
      const css = fs.readFileSync(cssPath, 'utf8');
      if (registry.theme.darkMode && !css.includes('.dark')) {
        findings.push({
          id: 'COMP006',
          severity: 'warning',
          file: registry.theme.cssVariablesFile,
          line: 0,
          message: 'Theme has darkMode:true but globals.css lacks .dark selector.',
        });
      }
    }
  }

  // Validate userPreferences if present
  if (registry.userPreferences) {
    const prefs = registry.userPreferences;
    if (prefs.designVariance && (prefs.designVariance < 1 || prefs.designVariance > 10)) {
      findings.push({
        id: 'COMP007',
        severity: 'error',
        file: 'component-registry.json',
        line: 0,
        message: 'designVariance must be 1-10.',
      });
    }
    if (prefs.motionIntensity && (prefs.motionIntensity < 1 || prefs.motionIntensity > 10)) {
      findings.push({
        id: 'COMP007',
        severity: 'error',
        file: 'component-registry.json',
        line: 0,
        message: 'motionIntensity must be 1-10.',
      });
    }
    if (prefs.visualDensity && (prefs.visualDensity < 1 || prefs.visualDensity > 10)) {
      findings.push({
        id: 'COMP007',
        severity: 'error',
        file: 'component-registry.json',
        line: 0,
        message: 'visualDensity must be 1-10.',
      });
    }
  }

  const summary = {
    total: findings.length,
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    pass: findings.filter((f) => f.severity === 'error').length === 0,
  };

  return { findings, summary, uiDetection };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: cobolt-component-validator [--json] [--help]');
    process.exit(0);
  }
  const result = run(process.cwd());

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nComponent Registry Validator`);
    for (const f of result.findings) {
      const icon = f.severity === 'error' ? 'ERROR' : f.severity === 'warning' ? 'WARN' : 'INFO';
      console.log(`  [${icon}] ${f.id} — ${f.message}`);
    }
    console.log(
      `\n${result.summary.pass ? 'PASS' : 'FAIL'} — ${result.summary.errors} errors, ${result.summary.warnings} warnings\n`,
    );
    process.exit(result.summary.pass ? 0 : 1);
  }
}

module.exports = { run };
