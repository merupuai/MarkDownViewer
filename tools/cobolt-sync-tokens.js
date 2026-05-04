#!/usr/bin/env node

/**
 * cobolt-sync-tokens.js — Central design token synchronization
 * Syncs design-tokens.json to component-registry.json and .stitch/DESIGN.md
 *
 * Usage:
 *   node tools/cobolt-sync-tokens.js sync                   — Sync tokens to registry + DESIGN.md
 *   node tools/cobolt-sync-tokens.js check                  — Check for drift (exit 0 = in sync, exit 1 = drift)
 *   node tools/cobolt-sync-tokens.js init                   — Create design-tokens.json from template
 *   node tools/cobolt-sync-tokens.js export --format css     — Print CSS custom properties to stdout
 *   node tools/cobolt-sync-tokens.js export --format tailwind — Print Tailwind extend config to stdout
 *   node tools/cobolt-sync-tokens.js rebrand                — Full cascade: sync + README + rebuild flag
 */

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();
const TOKENS_PATH = path.join(PROJECT_ROOT, 'design-tokens.json');
const TEMPLATE_PATH = path.resolve(__dirname, '..', 'source', 'templates', 'design-tokens.template.json');
const STITCH_DIR = path.join(PROJECT_ROOT, '.stitch');
const DESIGN_MD_PATH = path.join(STITCH_DIR, 'DESIGN.md');

function findRegistryPath() {
  const candidates = [
    path.join(PROJECT_ROOT, '_cobolt-output', 'latest', 'frontend', 'component-registry.json'),
    path.join(PROJECT_ROOT, '_cobolt-output', 'frontend', 'component-registry.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadTokens() {
  if (!fs.existsSync(TOKENS_PATH)) {
    console.error('Error: design-tokens.json not found in project root.');
    console.error('Hint: run "node tools/cobolt-sync-tokens.js init" to create one from the template.');
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
  } catch (err) {
    console.error(`Error: Failed to parse design-tokens.json — ${err.message}`);
    process.exit(1);
  }
}

function loadJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Sync: build theme + userPreferences from tokens
// ---------------------------------------------------------------------------

function buildTheme(tokens) {
  return {
    primaryColor: tokens.colors.primary,
    radius: tokens.radius?.md || '8px',
    fontFamily: {
      sans: tokens.typography.body,
      mono: tokens.typography.mono || 'monospace',
      display: tokens.typography.display || tokens.typography.body,
    },
    darkMode: tokens.preferences?.darkModeDefault || false,
    cssVariablesFile: 'app/globals.css',
  };
}

function buildUserPreferences(tokens) {
  const display = tokens.typography.display || tokens.typography.body;
  const body = tokens.typography.body;
  const mono = tokens.typography.mono || 'monospace';

  return {
    accentPreset: 'custom',
    brandColors: {
      primary: tokens.colors.primary,
      secondary: tokens.colors.secondary || null,
      accent: tokens.colors.accent || null,
    },
    typography: { display, body, mono },
    designVariance: tokens.preferences?.designVariance || 5,
    motionIntensity: tokens.motion?.intensity || 5,
    visualDensity: tokens.preferences?.visualDensity || 5,
    darkMode: tokens.preferences?.darkModeDefault || false,
    allowBrandFonts: [display, body, mono].filter(Boolean),
    allowRawColors: tokens.preferences?.allowRawColors || false,
  };
}

// ---------------------------------------------------------------------------
// Sync: generate DESIGN.md
// ---------------------------------------------------------------------------

function generateDesignMd(tokens) {
  const lines = [];
  const ln = (s = '') => lines.push(s);

  ln('# Design System');
  ln();
  ln('> Auto-generated from design-tokens.json. Do not edit token tables directly.');
  ln();

  // Brand
  const brand = tokens.brand || {};
  ln('## Brand');
  ln();
  if (brand.name) ln(`**Name:** ${brand.name}`);
  if (brand.tagline) ln(`**Tagline:** ${brand.tagline}`);
  if (brand.logo) ln(`**Logo:** ${brand.logo}`);
  if (!brand.name && !brand.tagline && !brand.logo) ln('_No brand info configured._');
  ln();

  // Color Palette
  ln('## Color Palette');
  ln();
  ln('| Token | Value | Role |');
  ln('|-------|-------|------|');
  if (tokens.colors) {
    for (const [key, value] of Object.entries(tokens.colors)) {
      ln(`| \`${key}\` | \`${value}\` | ${key.replace(/-/g, ' ')} |`);
    }
  }
  ln();

  // Dark Mode Overrides
  ln('## Dark Mode Overrides');
  ln();
  if (tokens.darkMode && Object.keys(tokens.darkMode).length > 0) {
    ln('| Token | Value |');
    ln('|-------|-------|');
    for (const [key, value] of Object.entries(tokens.darkMode)) {
      ln(`| \`${key}\` | \`${value}\` |`);
    }
  } else {
    ln('_No dark mode overrides configured._');
  }
  ln();

  // Typography
  ln('## Typography');
  ln();
  const typo = tokens.typography || {};
  if (typo.display) ln(`- **Display:** ${typo.display}`);
  if (typo.body) ln(`- **Body:** ${typo.body}`);
  if (typo.mono) ln(`- **Mono:** ${typo.mono}`);
  ln();
  if (typo.scale && Object.keys(typo.scale).length > 0) {
    ln('### Type Scale');
    ln();
    ln('| Size | Value |');
    ln('|------|-------|');
    for (const [key, value] of Object.entries(typo.scale)) {
      ln(`| \`${key}\` | \`${value}\` |`);
    }
    ln();
  }

  // Spacing
  ln('## Spacing');
  ln();
  const spacing = tokens.spacing || {};
  if (spacing.unit) ln(`**Base unit:** ${spacing.unit}px`);
  ln();
  if (spacing.scale && Object.keys(spacing.scale).length > 0) {
    ln('| Size | Value |');
    ln('|------|-------|');
    for (const [key, value] of Object.entries(spacing.scale)) {
      ln(`| \`${key}\` | \`${value}\` |`);
    }
    ln();
  }

  // Border Radius
  ln('## Border Radius');
  ln();
  if (tokens.radius && Object.keys(tokens.radius).length > 0) {
    ln('| Size | Value |');
    ln('|------|-------|');
    for (const [key, value] of Object.entries(tokens.radius)) {
      ln(`| \`${key}\` | \`${value}\` |`);
    }
  } else {
    ln('_No radius tokens configured._');
  }
  ln();

  // Shadows
  ln('## Shadows');
  ln();
  if (tokens.shadows && Object.keys(tokens.shadows).length > 0) {
    for (const [key, value] of Object.entries(tokens.shadows)) {
      ln(`- **${key}:** \`${value}\``);
    }
  } else {
    ln('_No shadow tokens configured._');
  }
  ln();

  // Motion
  ln('## Motion');
  ln();
  const motion = tokens.motion || {};
  if (motion.intensity != null) ln(`- **Intensity:** ${motion.intensity}`);
  if (motion.easing) ln(`- **Easing:** \`${motion.easing}\``);
  if (motion.duration) {
    ln('- **Durations:**');
    for (const [key, value] of Object.entries(motion.duration)) {
      ln(`  - ${key}: \`${value}\``);
    }
  }
  ln();

  // Preferences
  ln('## Preferences');
  ln();
  const prefs = tokens.preferences || {};
  ln(`- **Dark mode default:** ${prefs.darkModeDefault || false}`);
  ln(`- **Mobile first:** ${prefs.mobileFirst != null ? prefs.mobileFirst : 'N/A'}`);
  ln(`- **UI library:** ${prefs.uiLibrary || 'N/A'}`);
  ln(`- **Design variance:** ${prefs.designVariance || 5}`);
  ln(`- **Visual density:** ${prefs.visualDensity || 5}`);
  ln(`- **Allow raw colors:** ${prefs.allowRawColors || false}`);
  ln();

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Command: sync
// ---------------------------------------------------------------------------

function cmdSync() {
  const tokens = loadTokens();
  let synced = 0;

  // 1. Sync component-registry.json
  const registryPath = findRegistryPath();
  if (registryPath) {
    try {
      const registry = loadJSON(registryPath);
      registry.theme = buildTheme(tokens);
      registry.userPreferences = buildUserPreferences(tokens);
      writeJSON(registryPath, registry);
      console.log(`Synced theme + userPreferences → ${path.relative(PROJECT_ROOT, registryPath)}`);
      synced++;
    } catch (err) {
      console.error(`Error syncing component-registry.json: ${err.message}`);
    }
  } else {
    console.warn('Warning: component-registry.json not found — skipping registry sync.');
    console.warn('  Searched: _cobolt-output/latest/frontend/component-registry.json');
    console.warn('           _cobolt-output/frontend/component-registry.json');
  }

  // 2. Sync .stitch/DESIGN.md
  try {
    const autoGenerated = generateDesignMd(tokens);

    // Preserve manual sections (everything from ## Anti-Patterns onward)
    let manualSections = '';
    if (fs.existsSync(DESIGN_MD_PATH)) {
      const existing = fs.readFileSync(DESIGN_MD_PATH, 'utf8');
      const antiPatternsIdx = existing.indexOf('## Anti-Patterns');
      if (antiPatternsIdx !== -1) {
        manualSections = existing.slice(antiPatternsIdx);
      }
    }

    const content = manualSections ? `${autoGenerated}\n${manualSections}` : autoGenerated;

    if (!fs.existsSync(STITCH_DIR)) fs.mkdirSync(STITCH_DIR, { recursive: true });
    fs.writeFileSync(DESIGN_MD_PATH, content, 'utf8');
    console.log(`Synced design system → .stitch/DESIGN.md`);
    synced++;
  } catch (err) {
    console.error(`Error syncing .stitch/DESIGN.md: ${err.message}`);
  }

  if (synced > 0) {
    console.log(`\nDone — ${synced} target(s) synced from design-tokens.json.`);
  } else {
    console.error('\nNo targets were synced.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Command: check
// ---------------------------------------------------------------------------

function cmdCheck() {
  const tokens = loadTokens();
  const drifts = [];

  // 1. Check component-registry.json
  const registryPath = findRegistryPath();
  if (registryPath) {
    try {
      const registry = loadJSON(registryPath);

      // primaryColor
      const regPrimary = registry.theme?.primaryColor;
      if (regPrimary !== tokens.colors.primary) {
        drifts.push(
          `component-registry.json theme.primaryColor: "${regPrimary}" ≠ tokens.colors.primary "${tokens.colors.primary}"`,
        );
      }

      // fontFamily.sans
      const regSans = registry.theme?.fontFamily?.sans;
      if (regSans !== tokens.typography.body) {
        drifts.push(
          `component-registry.json theme.fontFamily.sans: "${regSans}" ≠ tokens.typography.body "${tokens.typography.body}"`,
        );
      }
    } catch (err) {
      drifts.push(`component-registry.json: could not read — ${err.message}`);
    }
  } else {
    drifts.push('component-registry.json: not found');
  }

  // 2. Check .stitch/DESIGN.md
  if (fs.existsSync(DESIGN_MD_PATH)) {
    const content = fs.readFileSync(DESIGN_MD_PATH, 'utf8');
    if (!content.includes(tokens.colors.primary)) {
      drifts.push(`.stitch/DESIGN.md: does not contain primary color "${tokens.colors.primary}"`);
    }
  } else {
    drifts.push('.stitch/DESIGN.md: not found');
  }

  if (drifts.length === 0) {
    console.log('All targets are in sync with design-tokens.json.');
    process.exit(0);
  } else {
    console.error('Design token drift detected:\n');
    for (const d of drifts) {
      console.error(`  - ${d}`);
    }
    console.error('\nRun "node tools/cobolt-sync-tokens.js sync" to fix.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Command: init
// ---------------------------------------------------------------------------

function cmdInit() {
  if (fs.existsSync(TOKENS_PATH)) {
    console.error('Error: design-tokens.json already exists in project root.');
    console.error('Delete it first if you want to re-initialize from the template.');
    process.exit(1);
  }

  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error(`Error: Template not found at ${TEMPLATE_PATH}`);
    process.exit(1);
  }

  fs.copyFileSync(TEMPLATE_PATH, TOKENS_PATH);
  console.log('Created design-tokens.json from template.');
  console.log('Edit the file with your brand colors, fonts, and preferences, then run:');
  console.log('  node tools/cobolt-sync-tokens.js sync');
}

// ---------------------------------------------------------------------------
// Command: export
// ---------------------------------------------------------------------------

function cmdExport(format) {
  if (!format || (format !== 'css' && format !== 'tailwind')) {
    console.error('Usage: node tools/cobolt-sync-tokens.js export --format css|tailwind');
    process.exit(1);
  }

  const tokens = loadTokens();

  if (format === 'css') {
    exportCSS(tokens);
  } else {
    exportTailwind(tokens);
  }
}

function exportCSS(tokens) {
  const lines = [':root {'];

  // Colors
  if (tokens.colors) {
    for (const [key, value] of Object.entries(tokens.colors)) {
      lines.push(`  --${key}: ${value};`);
    }
  }

  // Spacing
  if (tokens.spacing?.scale) {
    for (const [key, value] of Object.entries(tokens.spacing.scale)) {
      lines.push(`  --space-${key}: ${value};`);
    }
  }

  // Radius
  if (tokens.radius) {
    for (const [key, value] of Object.entries(tokens.radius)) {
      lines.push(`  --radius-${key}: ${value};`);
    }
  }

  // Shadows
  if (tokens.shadows) {
    for (const [key, value] of Object.entries(tokens.shadows)) {
      lines.push(`  --shadow-${key}: ${value};`);
    }
  }

  lines.push('}');

  // Dark mode
  if (tokens.darkMode && Object.keys(tokens.darkMode).length > 0) {
    lines.push('');
    lines.push('.dark {');
    for (const [key, value] of Object.entries(tokens.darkMode)) {
      lines.push(`  --${key}: ${value};`);
    }
    lines.push('}');
  }

  console.log(lines.join('\n'));
}

function exportTailwind(tokens) {
  const extend = {};

  // Colors as CSS variable references
  if (tokens.colors) {
    extend.colors = {};
    for (const key of Object.keys(tokens.colors)) {
      extend.colors[key] = `var(--${key})`;
    }
  }

  // Font family
  if (tokens.typography) {
    extend.fontFamily = {};
    if (tokens.typography.display) {
      extend.fontFamily.display = [tokens.typography.display, 'sans-serif'];
    }
    if (tokens.typography.body) {
      extend.fontFamily.sans = [tokens.typography.body, 'sans-serif'];
    }
    if (tokens.typography.mono) {
      extend.fontFamily.mono = [tokens.typography.mono, 'monospace'];
    }
  }

  // Spacing
  if (tokens.spacing?.scale) {
    extend.spacing = {};
    for (const [key, value] of Object.entries(tokens.spacing.scale)) {
      extend.spacing[key] = value;
    }
  }

  // Border radius
  if (tokens.radius) {
    extend.borderRadius = {};
    for (const [key, value] of Object.entries(tokens.radius)) {
      extend.borderRadius[key] = value;
    }
  }

  console.log(JSON.stringify({ extend }, null, 2));
}

// ---------------------------------------------------------------------------
// Command: rebrand
// ---------------------------------------------------------------------------

function cmdRebrand() {
  console.log('[cobolt-sync-tokens] Running full brand cascade...\n');

  // 1. Run existing sync (tokens → registry + DESIGN.md)
  cmdSync();

  // 2. Regenerate README if cobolt-readme-gen exists
  const readmeGenPath = path.join(__dirname, 'cobolt-readme-gen.js');
  if (fs.existsSync(readmeGenPath)) {
    console.log('\nRegenerating README.md...');
    try {
      const { execFileSync } = require('node:child_process');
      execFileSync(process.execPath, [readmeGenPath, 'generate'], {
        stdio: 'inherit',
        cwd: PROJECT_ROOT,
        timeout: 30000,
      });
    } catch (err) {
      console.warn(`Warning: README generation failed — ${err.message}`);
    }
  } else {
    console.warn('Warning: cobolt-readme-gen.js not found — skipping README update.');
  }

  // 3. Check if landing page story exists — report rebuild need
  const landingFiles = [];
  const searchDirs = ['app', 'src', 'pages'].map((d) => path.join(PROJECT_ROOT, d));
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { recursive: true });
      for (const entry of entries) {
        const name = String(entry).toLowerCase();
        if (name.includes('landing') || (name.includes('page') && name.includes('index'))) {
          landingFiles.push(path.join(dir, String(entry)));
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  // 4. Print cascade summary
  console.log('\n─── Brand Cascade Complete ───');
  console.log('  Synced:');
  console.log('    ✓ component-registry.json');
  console.log('    ✓ .stitch/DESIGN.md');
  console.log('    ✓ README.md');

  if (landingFiles.length > 0) {
    console.log('  Needs rebuild:');
    for (const f of landingFiles.slice(0, 5)) {
      console.log(`    - ${path.relative(PROJECT_ROOT, f)}`);
    }
    console.log('\n  Run "/cobolt-build M1" to rebuild affected components.');
  }

  console.log('\n  Preview tokens visually:');
  console.log('    node tools/cobolt-token-playground.js');
}

// ---------------------------------------------------------------------------
// Command: help
// ---------------------------------------------------------------------------

function cmdHelp() {
  console.log(`cobolt-sync-tokens — Central design token synchronization

Usage:
  node tools/cobolt-sync-tokens.js <command> [options]

Commands:
  sync                        Sync design-tokens.json → component-registry.json + .stitch/DESIGN.md
  check                       Check for drift between tokens and downstream files (exit 1 if drifted)
  init                        Create design-tokens.json from template (refuses if already exists)
  export --format css         Print CSS :root variables to stdout
  export --format tailwind    Print Tailwind extend config to stdout
  rebrand                     Full cascade: sync + README + rebuild flag report

Files:
  design-tokens.json                                       Source of truth (project root)
  _cobolt-output/**/frontend/component-registry.json       Registry target (theme + userPreferences)
  .stitch/DESIGN.md                                        Stitch design target (full design system)
`);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'sync':
      cmdSync();
      break;
    case 'check':
      cmdCheck();
      break;
    case 'init':
      cmdInit();
      break;
    case 'export': {
      const formatIdx = args.indexOf('--format');
      const format = formatIdx !== -1 ? args[formatIdx + 1] : null;
      cmdExport(format);
      break;
    }
    case 'rebrand':
      cmdRebrand();
      break;
    default:
      cmdHelp();
      break;
  }
}

// Programmatic API
module.exports = { buildTheme, buildUserPreferences, generateDesignMd, findRegistryPath };

main();
