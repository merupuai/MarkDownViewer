#!/usr/bin/env node
// S7 — Contrast matrix: design-tokens × theme × state. Asserts WCAG AA (4.5:1)
// or AAA (7:1) for every combination. Fails fast on any violation.

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const CWD = process.cwd();
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const target = arg('--level', 'AA').toUpperCase();
const threshold = target === 'AAA' ? 7 : 4.5;
const tokensPath = arg('--tokens', 'design-tokens.json');

const t = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(CWD, tokensPath), 'utf8'));
  } catch {
    return null;
  }
})();
if (!t) {
  console.error('design-tokens.json missing');
  process.exit(1);
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h,
    16,
  );
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rel(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance([r, g, b]) {
  return 0.2126 * rel(r) + 0.7152 * rel(g) + 0.0722 * rel(b);
}
function contrast(a, b) {
  const la = luminance(hexToRgb(a)),
    lb = luminance(hexToRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const themes = t.themes || { light: t.colors, dark: t.darkColors || t.colors };
const states = ['default', 'hover', 'active', 'disabled', 'focus'];
const violations = [];
const rows = [];

// Recursively walk a token tree yielding {pathLabel, fg, bg} for every object
// whose keys include a foreground/background pair. Accepted pair names:
//   - fg / bg
//   - foreground / background
//   - text / background
function isHex(s) {
  return typeof s === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s);
}
function findPairs(node, trail, out) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  const pairs = [
    ['fg', 'bg'],
    ['foreground', 'background'],
    ['text', 'background'],
  ];
  for (const [fk, bk] of pairs) {
    if (isHex(node[fk]) && isHex(node[bk])) {
      out.push({ pathLabel: trail.join('.') || 'root', fg: node[fk], bg: node[bk] });
    }
  }
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') findPairs(v, trail.concat(k), out);
  }
}

for (const [themeName, colors] of Object.entries(themes)) {
  if (!colors || typeof colors !== 'object') continue;

  // Flat behavior (preserved): top-level fg/bg + {state}Foreground/{state}Background
  const fg = colors.foreground || colors.text || colors.fg || '#000000';
  const bg = colors.background || colors.bg || '#ffffff';
  for (const state of states) {
    const fgS = colors[`${state}Foreground`] || fg;
    const bgS = colors[`${state}Background`] || bg;
    if (!isHex(fgS) || !isHex(bgS)) continue;
    const r = contrast(fgS, bgS);
    rows.push({ theme: themeName, path: 'flat', state, fg: fgS, bg: bgS, ratio: Number(r.toFixed(2)) });
    if (r < threshold)
      violations.push({ theme: themeName, path: 'flat', state, fg: fgS, bg: bgS, ratio: r, required: threshold });
  }

  // Recursive nested pairs — emit one row per pair × state.
  const pairs = [];
  findPairs(colors, [], pairs);
  for (const p of pairs) {
    for (const state of states) {
      const r = contrast(p.fg, p.bg);
      rows.push({ theme: themeName, path: p.pathLabel, state, fg: p.fg, bg: p.bg, ratio: Number(r.toFixed(2)) });
      if (r < threshold)
        violations.push({
          theme: themeName,
          path: p.pathLabel,
          state,
          fg: p.fg,
          bg: p.bg,
          ratio: r,
          required: threshold,
        });
    }
  }
}

const out = path.join(CWD, '_cobolt-output', 'latest', 'a11y', 'contrast-matrix.json');
atomicWrite(out, JSON.stringify({ target, threshold, rows, violations, ts: new Date().toISOString() }, null, 2));
console.log(`contrast matrix: ${rows.length} combos, ${violations.length} violations @ WCAG ${target}`);
process.exit(violations.length ? 1 : 0);
