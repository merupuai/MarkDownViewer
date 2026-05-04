#!/usr/bin/env node

// CoBolt Framework Contracts - framework-specific runtime/build sanity checks.

const fs = require('node:fs');
const path = require('node:path');
const { checkFrontendRuntime } = require('./cobolt-frontend-runtime-check');

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function detectFrameworks(projectRoot = process.cwd()) {
  const pkg = readJson(path.join(projectRoot, 'package.json')) || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  return {
    phoenix:
      fs.existsSync(path.join(projectRoot, 'mix.exs')) && /phoenix/i.test(readFile(path.join(projectRoot, 'mix.exs'))),
    next: Boolean(deps.next),
    rails:
      fs.existsSync(path.join(projectRoot, 'Gemfile')) &&
      /gem ['"]rails['"]/.test(readFile(path.join(projectRoot, 'Gemfile'))),
    django:
      fs.existsSync(path.join(projectRoot, 'manage.py')) &&
      /DJANGO_SETTINGS_MODULE|django/i.test(readFile(path.join(projectRoot, 'manage.py'))),
    packageJson: pkg,
  };
}

function checkFrameworkContracts(projectRoot = process.cwd()) {
  const detected = detectFrameworks(projectRoot);
  const issues = [];
  const warnings = [];

  if (detected.phoenix) {
    const frontend = checkFrontendRuntime(projectRoot);
    issues.push(...frontend.issues.map((issue) => `Phoenix frontend contract: ${issue}`));
    const router = readFile(path.join(projectRoot, 'lib', `${path.basename(projectRoot)}_web`, 'router.ex'));
    if (!router && !fs.existsSync(path.join(projectRoot, 'lib'))) {
      warnings.push('Phoenix detected but lib/*_web/router.ex could not be located for route contract checks.');
    }
  }

  if (detected.next) {
    const scripts = detected.packageJson.scripts || {};
    if (!scripts.build) issues.push('Next.js detected but package.json has no build script.');
    if (!scripts.start && !scripts.dev) warnings.push('Next.js detected but package.json has no start/dev script.');
  }

  if (detected.rails) {
    if (!fs.existsSync(path.join(projectRoot, 'config', 'routes.rb'))) {
      issues.push('Rails detected but config/routes.rb is missing.');
    }
  }

  if (detected.django) {
    const settingsCandidates = [
      path.join(projectRoot, 'settings.py'),
      ...fs
        .readdirSync(projectRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(projectRoot, entry.name, 'settings.py')),
    ];
    const settingsPath = settingsCandidates.find((candidate) => fs.existsSync(candidate));
    if (!settingsPath) issues.push('Django detected but settings.py is missing.');
    else if (!/STATIC_URL\s*=/.test(readFile(settingsPath)))
      warnings.push('Django settings.py does not declare STATIC_URL.');
  }

  return {
    passed: issues.length === 0,
    issues,
    warnings,
    detected: {
      phoenix: detected.phoenix,
      next: detected.next,
      rails: detected.rails,
      django: detected.django,
    },
  };
}

function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const report = checkFrameworkContracts(process.cwd());
  if (json) console.log(JSON.stringify(report, null, 2));
  else if (report.passed) console.log('[cobolt-framework-contracts] Framework contracts passed.');
  else for (const issue of report.issues) console.error(`[cobolt-framework-contracts] ${issue}`);
  process.exit(report.passed ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  checkFrameworkContracts,
  detectFrameworks,
};
