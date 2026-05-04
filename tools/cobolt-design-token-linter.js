#!/usr/bin/env node

/**
 * cobolt-design-token-linter.js — Deterministic design token compliance checker
 * Replaces LLM-based design-token-linter agent for all regex/pattern checks.
 * Reads user preferences from component-registry.json before enforcing.
 *
 * Usage: node tools/cobolt-design-token-linter.js [--scope all|changed] [--json] [--fix]
 */

const fs = require('node:fs');
const path = require('node:path');

function loadUserPreferences(projectRoot) {
  const registryPath = path.join(projectRoot, '_cobolt-output', 'latest', 'frontend', 'component-registry.json');
  try {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return registry.userPreferences || {};
  } catch {
    return {};
  }
}

function findSourceFiles(projectRoot) {
  const extensions = ['.tsx', '.jsx', '.ts', '.js', '.css'];
  const excludeDirs = ['node_modules', '.next', 'dist', '_cobolt-output', '.git', '.claude'];
  const files = [];
  const isThemeFile = (f) => /globals\.css|tailwind\.config|theme\.|motion-primitives/i.test(f);

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (excludeDirs.includes(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (extensions.some((ext) => entry.name.endsWith(ext))) files.push(fullPath);
    }
  }

  walk(projectRoot);
  return files.filter((f) => !isThemeFile(f));
}

const CHECKS = {
  DT001_hardcodedColor(line, lineNum, file, prefs) {
    const hexPattern = /(?:bg|text|border|ring|shadow|from|to|via)-\[#[0-9a-fA-F]{3,8}\]/g;
    const matches = [...line.matchAll(hexPattern)];
    if (matches.length === 0) return [];
    return matches
      .map((m) => {
        const hex = m[0].match(/#[0-9a-fA-F]{3,8}/)[0].toLowerCase();
        if (prefs.allowRawColors) return null;
        if (prefs.brandColors) {
          const brandHexes = Object.values(prefs.brandColors)
            .filter(Boolean)
            .map((c) => c.toLowerCase());
          if (brandHexes.includes(hex)) return null;
        }
        return {
          id: 'DT001',
          severity: 'error',
          file,
          line: lineNum,
          code: m[0],
          message: 'Hardcoded hex color. Use semantic token (e.g., bg-primary).',
        };
      })
      .filter(Boolean);
  },

  DT001b_paletteColor(line, lineNum, file) {
    const palettePattern =
      /(?:bg|text|border|ring)-(?:red|blue|green|yellow|purple|pink|indigo|gray|slate|zinc|neutral|stone|amber|emerald|teal|cyan|sky|violet|fuchsia|rose|lime|orange)-\d{2,3}/g;
    const matches = [...line.matchAll(palettePattern)];
    return matches.map((m) => ({
      id: 'DT001',
      severity: 'warning',
      file,
      line: lineNum,
      code: m[0],
      message: 'Tailwind palette color for themed element. Use semantic token.',
    }));
  },

  DT003_bannedFont(line, lineNum, file, prefs) {
    const bannedFonts = ['Inter', 'Roboto', 'Arial', 'Open Sans', 'Helvetica'];
    const allowedBrand = (prefs.allowBrandFonts || []).map((f) => f.toLowerCase());
    const findings = [];
    for (const font of bannedFonts) {
      if (allowedBrand.includes(font.toLowerCase())) continue;
      if (new RegExp(`font-\\[['"]?${font}`, 'i').test(line)) {
        findings.push({
          id: 'DT003',
          severity: 'warning',
          file,
          line: lineNum,
          code: line.trim().slice(0, 80),
          message: `Banned font "${font}". Use Geist, Outfit, or user-specified font.`,
        });
      }
    }
    return findings;
  },

  DT004_rawHTML(line, lineNum, file, prefs) {
    if (prefs.existingUILibrary && prefs.existingUILibrary !== 'none' && prefs.existingUILibrary !== 'shadcn-ui')
      return [];
    const patterns = [
      { re: /<button\s+className=/i, msg: 'Raw <button> with className. Use shadcn <Button>.' },
      { re: /<input\s+className=/i, msg: 'Raw <input> with className. Use shadcn <Input>.' },
      { re: /<select\s+className=/i, msg: 'Raw <select>. Use shadcn <Select>.' },
    ];
    const findings = [];
    for (const p of patterns) {
      if (p.re.test(line)) {
        findings.push({
          id: 'DT004',
          severity: 'warning',
          file,
          line: lineNum,
          code: line.trim().slice(0, 80),
          message: p.msg,
        });
      }
    }
    return findings;
  },

  DT005_inlineAnimation(line, lineNum, file, prefs) {
    if ((prefs.motionIntensity || 6) <= 2) return [];
    const patterns = [/transition:\s*['"]?all/i, /ease-in-out|ease-in(?!-)|ease-out|(?<![a-z-])linear(?!-gradient)/];
    const findings = [];
    for (const p of patterns) {
      if (p.test(line)) {
        findings.push({
          id: 'DT005',
          severity: 'warning',
          file,
          line: lineNum,
          code: line.trim().slice(0, 80),
          message: 'Banned easing. Use spring physics from motion-primitives.',
        });
      }
    }
    return findings;
  },

  DT010_hScreen(line, lineNum, file) {
    if (/\bh-screen\b/.test(line) && !/min-h-\[100dvh\]/.test(line)) {
      return [
        {
          id: 'DT010',
          severity: 'error',
          file,
          line: lineNum,
          code: 'h-screen',
          message: 'Use min-h-[100dvh] instead (iOS Safari bug).',
        },
      ];
    }
    return [];
  },

  DT011_divOnClick(line, lineNum, file) {
    if (/<(?:div|span)\s[^>]*onClick/i.test(line)) {
      return [
        {
          id: 'DT011',
          severity: 'error',
          file,
          line: lineNum,
          code: line.trim().slice(0, 80),
          message: 'Use <button> or Radix primitive instead of <div/span onClick>.',
        },
      ];
    }
    return [];
  },

  DT012_blueDefault(line, lineNum, file, prefs) {
    if (prefs.accentPreset === 'electric-blue') return [];
    if (prefs.brandColors && /blue|#3[bB]82[fF]6/i.test(prefs.brandColors.primary || '')) return [];
    if (/--primary.*(?:blue|indigo|#3b82f6|#6366f1)/i.test(line)) {
      return [
        {
          id: 'DT012',
          severity: 'warning',
          file,
          line: lineNum,
          code: line.trim().slice(0, 80),
          message: 'Blue/indigo as primary without user request. Change accent.',
        },
      ];
    }
    return [];
  },
};

function run(projectRoot, _options = {}) {
  const prefs = loadUserPreferences(projectRoot);
  const files = findSourceFiles(projectRoot);
  const allFindings = [];

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const check of Object.values(CHECKS)) {
        const findings = check(lines[i], i + 1, path.relative(projectRoot, file), prefs);
        allFindings.push(...findings);
      }
    }
  }

  const summary = {
    total: allFindings.length,
    errors: allFindings.filter((f) => f.severity === 'error').length,
    warnings: allFindings.filter((f) => f.severity === 'warning').length,
    filesScanned: files.length,
    preferencesLoaded: Object.keys(prefs).length > 0,
    pass: allFindings.filter((f) => f.severity === 'error').length === 0,
  };

  return { findings: allFindings, summary, preferences: prefs };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: cobolt-design-token-linter [--json] [--help]');
    console.log('  Deterministic design token compliance checker.');
    console.log('  Reads userPreferences from component-registry.json.');
    process.exit(0);
  }
  const jsonOutput = args.includes('--json');
  const result = run(process.cwd());

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nDesign Token Linter — ${result.summary.filesScanned} files scanned`);
    console.log(`Preferences loaded: ${result.summary.preferencesLoaded ? 'YES' : 'NO (using defaults)'}\n`);
    for (const f of result.findings.slice(0, 50)) {
      const icon = f.severity === 'error' ? 'ERROR' : 'WARN';
      console.log(`  [${icon}] ${f.id} ${f.file}:${f.line} — ${f.message}`);
    }
    if (result.findings.length > 50) console.log(`  ... and ${result.findings.length - 50} more`);
    console.log(
      `\n${result.summary.pass ? 'PASS' : 'FAIL'} — ${result.summary.errors} errors, ${result.summary.warnings} warnings\n`,
    );
    process.exit(result.summary.pass ? 0 : 1);
  }
}

module.exports = { run, loadUserPreferences };
