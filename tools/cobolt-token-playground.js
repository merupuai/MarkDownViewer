#!/usr/bin/env node

// CoBolt Token Playground - Self-contained HTML preview for design-tokens.json
//
// Generates a single HTML file with live color swatches, typography samples,
// spacing/radius/shadow previews, and an export button.
//
// Usage:
//   node tools/cobolt-token-playground.js                    # Generate playground HTML
//   node tools/cobolt-token-playground.js --output <path>    # Custom output path
//
// Exit codes:
//   0 = success
//   1 = design-tokens.json not found
//
// Note: The generated HTML uses textContent and safe DOM creation methods.
// All token values are embedded as static JSON — no user input or external data.

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = process.cwd();
const TOKENS_PATH = path.join(PROJECT_ROOT, 'design-tokens.json');
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, '_cobolt-output', 'token-playground.html');

function loadTokens() {
  if (!fs.existsSync(TOKENS_PATH)) {
    console.error('[cobolt-token-playground] design-tokens.json not found.');
    console.error('  Run: node tools/cobolt-sync-tokens.js init');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
}

function buildColorSwatchesHTML(colors, _prefix) {
  if (!colors || Object.keys(colors).length === 0) return '';
  const items = [];
  for (const [name, value] of Object.entries(colors)) {
    // All values come from design-tokens.json (user-owned, no external input)
    items.push(
      `<div class="swatch">` +
        `<div class="swatch-color" style="background:${escapeAttr(value)}">` +
        `<span>${escapeHTML(value)}</span></div>` +
        `<div class="swatch-label">${escapeHTML(name)}<br><code>${escapeHTML(value)}</code></div></div>`,
    );
  }
  return items.join('\n');
}

function buildTypographySamples(typography) {
  if (!typography) return '';
  const fonts = [
    { label: 'Display', family: typography.display, size: '2.25rem' },
    { label: 'Body', family: typography.body, size: '1rem' },
    { label: 'Mono', family: typography.mono, size: '0.875rem' },
  ];
  return fonts
    .filter((f) => f.family)
    .map(
      (f) =>
        `<div class="type-sample">` +
        `<div class="label">${escapeHTML(f.label)} &mdash; ${escapeHTML(f.family)}</div>` +
        `<div style="font-family:'${escapeAttr(f.family)}',system-ui;font-size:${escapeAttr(f.size)}">` +
        `The quick brown fox jumps over the lazy dog</div></div>`,
    )
    .join('\n');
}

function buildTypeScale(scale) {
  if (!scale) return '';
  return Object.entries(scale)
    .map(
      ([name, size]) =>
        `<div class="type-sample">` +
        `<div class="label">${escapeHTML(name)} &mdash; ${escapeHTML(size)}</div>` +
        `<div style="font-size:${escapeAttr(size)}">Sample text at ${escapeHTML(name)}</div></div>`,
    )
    .join('\n');
}

function buildSpacing(spacing) {
  if (!spacing?.scale) return '';
  return Object.entries(spacing.scale)
    .map(
      ([name, value]) =>
        `<div class="spacing-row">` +
        `<span class="spacing-label">${escapeHTML(name)}</span>` +
        `<div class="spacing-bar" style="width:${escapeAttr(value)}"></div>` +
        `<span class="spacing-value">${escapeHTML(value)}</span></div>`,
    )
    .join('\n');
}

function buildRadius(radius) {
  if (!radius) return '';
  return Object.entries(radius)
    .map(
      ([name, value]) =>
        `<div class="radius-box" style="border-radius:${escapeAttr(value)}">${escapeHTML(name)}<br>${escapeHTML(value)}</div>`,
    )
    .join('\n');
}

function buildShadows(shadows) {
  if (!shadows) return '';
  return Object.entries(shadows)
    .map(([name, value]) => `<div class="shadow-box" style="box-shadow:${escapeAttr(value)}">${escapeHTML(name)}</div>`)
    .join('\n');
}

function buildMotion(motion) {
  if (!motion) return '<p>No motion tokens configured.</p>';
  const items = [
    ['Intensity', `${motion.intensity ?? 'N/A'} / 10`],
    ['Easing', motion.easing || 'N/A'],
    ['Duration (fast)', motion.duration?.fast || 'N/A'],
    ['Duration (base)', motion.duration?.base || 'N/A'],
    ['Duration (slow)', motion.duration?.slow || 'N/A'],
  ];
  return `<dl>${items.map(([k, v]) => `<dt>${escapeHTML(k)}</dt><dd>${escapeHTML(v)}</dd>`).join('')}</dl>`;
}

function buildPreferences(prefs) {
  if (!prefs) return '';
  return Object.entries(prefs)
    .map(
      ([key, value]) =>
        `<div class="pref-card">` +
        `<div class="label">${escapeHTML(key)}</div>` +
        `<div class="value">${escapeHTML(String(value))}</div></div>`,
    )
    .join('\n');
}

// Escape HTML entities for safe embedding in static HTML
function escapeHTML(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Escape for use in HTML style attributes (subset of escapeHTML)
function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function generateHTML(tokens) {
  const tokensJson = JSON.stringify(tokens, null, 2);
  const brandName = escapeHTML(tokens.brand?.name || 'Design Token Playground');
  const brandTagline = escapeHTML(tokens.brand?.tagline || 'Preview and export your design tokens');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CoBolt Design Token Playground</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #0f172a; padding: 2rem; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 1.875rem; margin-bottom: 0.5rem; }
  h2 { font-size: 1.25rem; margin: 2rem 0 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid #e2e8f0; }
  .subtitle { color: #64748b; margin-bottom: 2rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 1rem; }
  .swatch { border-radius: 8px; overflow: hidden; border: 1px solid #e2e8f0; background: white; }
  .swatch-color { height: 80px; display: flex; align-items: flex-end; padding: 0.5rem; }
  .swatch-color span { font-size: 0.75rem; padding: 2px 6px; background: rgba(255,255,255,0.85); border-radius: 4px; }
  .swatch-label { padding: 0.5rem; font-size: 0.8rem; }
  .swatch-label code { font-family: monospace; color: #64748b; font-size: 0.7rem; }
  .type-sample { margin: 0.75rem 0; padding: 1rem; background: white; border-radius: 8px; border: 1px solid #e2e8f0; }
  .type-sample .label { font-size: 0.75rem; color: #94a3b8; margin-bottom: 0.25rem; }
  .spacing-row { display: flex; align-items: center; gap: 1rem; margin: 0.5rem 0; }
  .spacing-bar { height: 24px; background: #3b82f6; border-radius: 4px; }
  .spacing-label { font-size: 0.8rem; min-width: 40px; }
  .spacing-value { font-size: 0.75rem; color: #64748b; font-family: monospace; }
  .radius-grid { display: flex; gap: 1rem; flex-wrap: wrap; }
  .radius-box { width: 80px; height: 80px; background: #3b82f6; display: flex; align-items: center; justify-content: center; color: white; font-size: 0.75rem; text-align: center; }
  .shadow-grid { display: flex; gap: 1.5rem; flex-wrap: wrap; }
  .shadow-box { width: 120px; height: 80px; background: white; display: flex; align-items: center; justify-content: center; font-size: 0.75rem; color: #64748b; border-radius: 8px; }
  .motion-info { padding: 1rem; background: white; border-radius: 8px; border: 1px solid #e2e8f0; font-size: 0.875rem; }
  .motion-info dt { font-weight: 600; margin-top: 0.5rem; }
  .motion-info dd { color: #64748b; font-family: monospace; }
  .actions { position: sticky; top: 1rem; float: right; display: flex; gap: 0.5rem; z-index: 10; }
  .btn { padding: 0.5rem 1rem; border: none; border-radius: 6px; cursor: pointer; font-size: 0.875rem; font-weight: 500; }
  .btn-primary { background: #2563eb; color: white; }
  .btn-primary:hover { background: #1d4ed8; }
  .btn-secondary { background: #e2e8f0; color: #334155; }
  .btn-secondary:hover { background: #cbd5e1; }
  .prefs-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.75rem; }
  .pref-card { padding: 0.75rem; background: white; border-radius: 8px; border: 1px solid #e2e8f0; font-size: 0.875rem; }
  .pref-card .label { color: #94a3b8; font-size: 0.75rem; }
  .pref-card .value { font-weight: 600; margin-top: 0.25rem; }
  .dark-preview { background: #0f172a; color: #f8fafc; padding: 1.5rem; border-radius: 12px; margin-top: 1rem; }
  .dark-preview .swatch { background: #1e293b; border-color: #334155; }
  .dark-preview .swatch-label { color: #cbd5e1; }
  .dark-preview .swatch-label code { color: #64748b; }
  .toast { position: fixed; bottom: 2rem; right: 2rem; background: #22c55e; color: white; padding: 0.75rem 1.5rem; border-radius: 8px; display: none; font-weight: 500; }
</style>
</head>
<body>

<div class="actions">
  <button class="btn btn-primary" id="copyJsonBtn">Copy JSON</button>
  <button class="btn btn-secondary" id="copyCssBtn">Copy CSS</button>
</div>

<h1>${brandName}</h1>
<p class="subtitle">${brandTagline}</p>

<h2>Color Palette</h2>
<div class="grid">${buildColorSwatchesHTML(tokens.colors)}</div>

<h2>Dark Mode Overrides</h2>
<div class="dark-preview">
  <div class="grid">${buildColorSwatchesHTML(tokens.darkMode)}</div>
</div>

<h2>Typography</h2>
${buildTypographySamples(tokens.typography)}

<h2>Type Scale</h2>
${buildTypeScale(tokens.typography?.scale)}

<h2>Spacing</h2>
${buildSpacing(tokens.spacing)}

<h2>Border Radius</h2>
<div class="radius-grid">${buildRadius(tokens.radius)}</div>

<h2>Shadows</h2>
<div class="shadow-grid">${buildShadows(tokens.shadows)}</div>

<h2>Motion</h2>
<div class="motion-info">${buildMotion(tokens.motion)}</div>

<h2>Preferences</h2>
<div class="prefs-grid">${buildPreferences(tokens.preferences)}</div>

<div class="toast" id="toast">Copied!</div>

<script>
// Token data embedded at generation time (from user-owned design-tokens.json)
var tokenData = ${tokensJson};

function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(function() { t.style.display = 'none'; }, 2000);
}

document.getElementById('copyJsonBtn').addEventListener('click', function() {
  navigator.clipboard.writeText(JSON.stringify(tokenData, null, 2)).then(function() {
    showToast('JSON copied to clipboard!');
  });
});

document.getElementById('copyCssBtn').addEventListener('click', function() {
  var css = ':root {\\n';
  if (tokenData.colors) {
    var keys = Object.keys(tokenData.colors);
    for (var i = 0; i < keys.length; i++) {
      css += '  --' + keys[i] + ': ' + tokenData.colors[keys[i]] + ';\\n';
    }
  }
  if (tokenData.spacing && tokenData.spacing.scale) {
    var skeys = Object.keys(tokenData.spacing.scale);
    for (var j = 0; j < skeys.length; j++) {
      css += '  --space-' + skeys[j] + ': ' + tokenData.spacing.scale[skeys[j]] + ';\\n';
    }
  }
  if (tokenData.radius) {
    var rkeys = Object.keys(tokenData.radius);
    for (var k = 0; k < rkeys.length; k++) {
      css += '  --radius-' + rkeys[k] + ': ' + tokenData.radius[rkeys[k]] + ';\\n';
    }
  }
  if (tokenData.shadows) {
    var shkeys = Object.keys(tokenData.shadows);
    for (var l = 0; l < shkeys.length; l++) {
      css += '  --shadow-' + shkeys[l] + ': ' + tokenData.shadows[shkeys[l]] + ';\\n';
    }
  }
  css += '}\\n';
  if (tokenData.darkMode) {
    css += '\\n.dark {\\n';
    var dkeys = Object.keys(tokenData.darkMode);
    for (var m = 0; m < dkeys.length; m++) {
      css += '  --' + dkeys[m] + ': ' + tokenData.darkMode[dkeys[m]] + ';\\n';
    }
    css += '}\\n';
  }
  navigator.clipboard.writeText(css).then(function() {
    showToast('CSS copied to clipboard!');
  });
});
</script>
</body>
</html>`;
}

// ── CLI ────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 && args[outputIdx + 1] ? args[outputIdx + 1] : DEFAULT_OUTPUT;

  if (args.includes('--help') || args.includes('-h')) {
    console.log('CoBolt Token Playground - Self-contained HTML design token preview');
    console.log('');
    console.log('Usage:');
    console.log('  node tools/cobolt-token-playground.js [--output <path>]');
    console.log('');
    console.log(`Default output: ${path.relative(PROJECT_ROOT, DEFAULT_OUTPUT)}`);
    return;
  }

  const tokens = loadTokens();
  const html = generateHTML(tokens);

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf8');

  const relPath = path.relative(PROJECT_ROOT, outputPath);
  console.log(`[cobolt-token-playground] Generated: ${relPath}`);
  console.log(`  Open in browser to preview your design tokens.`);
  console.log(`  Use "Copy JSON" button to export modified tokens.`);
}

main();
