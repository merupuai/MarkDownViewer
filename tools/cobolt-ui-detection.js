#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const UI_FRAMEWORK_PACKAGES = {
  react: ['react', 'react-dom'],
  next: ['next'],
  vue: ['vue', 'nuxt', 'nuxt3'],
  svelte: ['svelte', '@sveltejs/kit'],
  angular: ['@angular/core'],
  phoenix: ['phoenix', 'phoenix_html', 'phoenix_live_view'],
  liveview: ['phoenix_live_view'],
  astro: ['astro'],
};

const UI_FILE_EXTENSIONS = new Set(['.tsx', '.jsx', '.vue', '.svelte', '.astro', '.heex', '.html', '.htm']);
const UI_DIR_CANDIDATES = ['src', 'app', 'frontend', 'client', 'web', 'pages', 'components', 'templates', 'lib'];
const PLAYWRIGHT_CONFIG_CANDIDATES = [
  path.join('e2e', 'playwright.config.js'),
  path.join('e2e', 'playwright.config.ts'),
  'playwright.config.js',
  'playwright.config.ts',
];
const KNOWN_UI_FRAMEWORK_TOKENS = new Set(
  [
    ...Object.keys(UI_FRAMEWORK_PACKAGES),
    ...Object.values(UI_FRAMEWORK_PACKAGES).flat(),
    'next.js',
    'nuxt.js',
    'vite',
    'react native',
    'reactnative',
    'solid',
    'solidjs',
    'solid.js',
    'wpf',
    'winui',
    'winui3',
    'maui',
    'avalonia',
    'winforms',
    'windows forms',
    'uno',
    'uno platform',
  ].map((value) =>
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ''),
  ),
);

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function canonicalFrameworkToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function isPlaceholderFrameworkValue(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) return true;
  return (
    /^see\b/.test(normalized) ||
    /\b(?:architecture|data-model|dependency-register|test-strategy)\.md\b/.test(normalized) ||
    /^(?:n\/a|none|unknown|tbd)$/i.test(normalized)
  );
}

function normalizeManifestUiFramework(value) {
  if (isPlaceholderFrameworkValue(value)) return null;
  const token = canonicalFrameworkToken(value);
  if (!token || !KNOWN_UI_FRAMEWORK_TOKENS.has(token)) return null;
  return token;
}

function uxTrackerDeclaresNonUi(uxTracker) {
  if (!uxTracker || typeof uxTracker !== 'object') return false;
  if (!String(uxTracker.nonUiRationale || '').trim()) return false;

  const screenCount = Array.isArray(uxTracker.screens) ? uxTracker.screens.length : 0;
  const surfaceCount = Array.isArray(uxTracker.surfaces) ? uxTracker.surfaces.length : 0;
  if (screenCount > 0 || surfaceCount > 0) return false;

  const featureCoverage = Array.isArray(uxTracker.featureCoverage) ? uxTracker.featureCoverage : [];
  if (featureCoverage.length === 0) return true;

  return featureCoverage.every(
    (entry) =>
      String(entry?.status || '')
        .trim()
        .toLowerCase() === 'not_applicable',
  );
}

function findPlaywrightConfig(projectRoot) {
  for (const candidate of PLAYWRIGHT_CONFIG_CANDIDATES) {
    const absolute = path.join(projectRoot, candidate);
    if (fs.existsSync(absolute)) return absolute;
  }
  return null;
}

function findState(projectRoot) {
  return loadJson(path.join(projectRoot, 'cobolt-state.json'));
}

function currentMilestoneFromState(state) {
  return state?.currentMilestone || state?.build?.currentMilestone || state?.pipeline?.currentMilestone || null;
}

function findTaskManifest(projectRoot, state) {
  const currentMilestone = currentMilestoneFromState(state);
  const candidates = [];

  if (currentMilestone) {
    candidates.push(
      path.join(
        projectRoot,
        '_cobolt-output',
        'latest',
        'build',
        currentMilestone,
        `${currentMilestone}-task-manifest.json`,
      ),
    );
  }

  const buildRoot = path.join(projectRoot, '_cobolt-output', 'latest', 'build');
  try {
    for (const entry of fs.readdirSync(buildRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^M\d+$/i.test(entry.name)) continue;
      candidates.push(path.join(buildRoot, entry.name, `${entry.name}-task-manifest.json`));
    }
  } catch {
    /* ignore missing build directories */
  }

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function scanPackageFrameworks(projectRoot) {
  const packageJson = loadJson(path.join(projectRoot, 'package.json'));
  if (!packageJson) return [];

  const deps = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {}),
    ...(packageJson.peerDependencies || {}),
  };

  const frameworks = [];
  for (const [framework, packages] of Object.entries(UI_FRAMEWORK_PACKAGES)) {
    if (packages.some((pkg) => Object.hasOwn(deps, pkg))) {
      frameworks.push(framework);
    }
  }
  return frameworks;
}

function scanMixFrameworks(projectRoot) {
  const mixPath = path.join(projectRoot, 'mix.exs');
  if (!fs.existsSync(mixPath)) return [];
  try {
    const content = fs.readFileSync(mixPath, 'utf8');
    const frameworks = [];
    if (/phoenix_live_view/i.test(content)) frameworks.push('liveview');
    if (/phoenix_html|phoenix_live_view|phoenix\b/i.test(content)) frameworks.push('phoenix');
    return [...new Set(frameworks)];
  } catch {
    return [];
  }
}

function scanUiFiles(projectRoot, limit = 50) {
  const matches = [];
  const queue = UI_DIR_CANDIDATES.map((dir) => path.join(projectRoot, dir)).filter((dir) => fs.existsSync(dir));

  while (queue.length > 0 && matches.length < limit) {
    const current = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (matches.length >= limit) break;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== '_cobolt-output') {
          queue.push(absolute);
        }
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (UI_FILE_EXTENSIONS.has(ext)) {
        matches.push(path.relative(projectRoot, absolute));
      }
    }
  }

  return matches;
}

function detectUIProject(projectRoot = process.cwd()) {
  const root = path.resolve(projectRoot);
  const state = findState(root);
  const signals = [];
  const strongSignals = [];
  const frameworks = new Set();
  const taskManifestPath = findTaskManifest(root, state);
  const taskManifest = taskManifestPath ? loadJson(taskManifestPath) : null;
  const playwrightConfigPath = findPlaywrightConfig(root);
  const planningDir = path.join(root, '_cobolt-output', 'latest', 'planning');
  const uxTrackerPath = path.join(planningDir, 'ux-tracker.json');
  const uxTracker = loadJson(uxTrackerPath);
  const nonUiDeclared = uxTrackerDeclaresNonUi(uxTracker);

  if (state?.flags?.hasUI === true) {
    signals.push('state.hasUI');
    strongSignals.push('state.hasUI');
  }
  if (playwrightConfigPath) {
    signals.push('playwright-config');
    strongSignals.push('playwright-config');
  }

  for (const framework of scanPackageFrameworks(root)) frameworks.add(framework);
  for (const framework of scanMixFrameworks(root)) frameworks.add(framework);

  if (Array.isArray(taskManifest?.techStack?.frameworks)) {
    for (const framework of taskManifest.techStack.frameworks) {
      const normalized = normalizeManifestUiFramework(framework);
      if (normalized) frameworks.add(normalized);
    }
  }

  const taskFiles = Object.keys(taskManifest?.fileOwnership || {});
  const uiOwnedFiles = taskFiles.filter((file) => UI_FILE_EXTENSIONS.has(path.extname(file).toLowerCase()));
  if (uiOwnedFiles.length > 0) {
    signals.push('task-manifest-ui-files');
    strongSignals.push('task-manifest-ui-files');
  }

  if (fs.existsSync(path.join(planningDir, 'ux-design-specification.md'))) signals.push('planning-ux-spec');
  if (fs.existsSync(path.join(planningDir, 'wireframes-and-user-flows.md'))) signals.push('planning-wireframes');
  if (fs.existsSync(path.join(planningDir, 'ux-tracker.json'))) signals.push('planning-ux-tracker');

  const uiFiles = scanUiFiles(root);
  if (uiFiles.length > 0) {
    signals.push('ui-source-files');
    strongSignals.push('ui-source-files');
  }

  if (frameworks.size > 0) {
    signals.push('ui-framework');
    strongSignals.push('ui-framework');
  }

  const hasStrongUI = strongSignals.length > 0;
  const hasPlanningOnlyUiSignals = signals.some((signal) => signal.startsWith('planning-'));
  const hasUI = hasStrongUI || (hasPlanningOnlyUiSignals && !nonUiDeclared);
  const browserEngines = detectBrowserEngines(root);

  return {
    hasUI,
    hasStrongUI,
    projectRoot: root,
    signals,
    strongSignals,
    frameworks: [...frameworks].sort(),
    playwrightConfigPath: playwrightConfigPath ? path.relative(root, playwrightConfigPath) : null,
    taskManifestPath: taskManifestPath ? path.relative(root, taskManifestPath) : null,
    taskManifestUiFiles: uiOwnedFiles.slice(0, 20),
    uiSourceFiles: uiFiles.slice(0, 20),
    nonUiDeclared,
    browserEngines,
  };
}

function detectBrowserEngines(projectRoot) {
  const engines = {
    playwright: { available: false, mcp: false, package: false },
    chromeDevTools: { available: false, plugin: false },
  };

  // Check Playwright package
  try {
    const pkgPath = path.join(projectRoot, 'node_modules', 'playwright', 'package.json');
    engines.playwright.package = fs.existsSync(pkgPath);
  } catch {
    /* ignore */
  }

  // Check Playwright MCP config
  const settingsLocations = [
    path.join(projectRoot, '.claude', 'settings.json'),
    path.join(projectRoot, '.claude-plugin', 'settings.json'),
  ];

  for (const settingsPath of settingsLocations) {
    if (!fs.existsSync(settingsPath)) continue;
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (settings.mcpServers?.playwright) engines.playwright.mcp = true;
      const serverKeys = Object.keys(settings.mcpServers || {});
      if (serverKeys.some((key) => key.includes('chrome-devtools') || key.includes('devtools'))) {
        engines.chromeDevTools.plugin = true;
      }
    } catch {
      /* invalid JSON */
    }
  }

  // Check for Chrome DevTools plugin in Claude plugins directory
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  if (homeDir) {
    const pluginDir = path.join(homeDir, '.claude', 'plugins');
    try {
      if (fs.existsSync(pluginDir)) {
        const entries = fs.readdirSync(pluginDir);
        if (entries.some((entry) => entry.includes('chrome-devtools'))) {
          engines.chromeDevTools.plugin = true;
        }
      }
    } catch {
      /* permission error */
    }
  }

  engines.playwright.available = engines.playwright.package || engines.playwright.mcp;
  engines.chromeDevTools.available = engines.chromeDevTools.plugin;

  return engines;
}

function main() {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf('--dir');
  const projectRoot = dirIdx !== -1 && args[dirIdx + 1] ? args[dirIdx + 1] : process.cwd();
  const result = detectUIProject(projectRoot);

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('CoBolt UI Detection');
  console.log(`  Root:       ${result.projectRoot}`);
  console.log(`  Has UI:     ${result.hasUI ? 'yes' : 'no'}`);
  console.log(`  Signals:    ${result.signals.join(', ') || 'none'}`);
  console.log(`  Frameworks: ${result.frameworks.join(', ') || 'none'}`);
  if (result.playwrightConfigPath) console.log(`  Playwright: ${result.playwrightConfigPath}`);
  if (result.taskManifestPath) console.log(`  Manifest:   ${result.taskManifestPath}`);
  console.log(
    `  Engines:    Playwright=${result.browserEngines.playwright.available ? 'yes' : 'no'} ChromeDevTools=${result.browserEngines.chromeDevTools.available ? 'yes' : 'no'}`,
  );
}

if (require.main === module) {
  main();
}

module.exports = { detectUIProject, findPlaywrightConfig, detectBrowserEngines, uxTrackerDeclaresNonUi };
