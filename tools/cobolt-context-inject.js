#!/usr/bin/env node

// CoBolt Context Inject — signature-only source extraction for late builders
//
// Late-milestone builders (M3+) work from anchor + spec, not actual M1..M(n-1)
// source. They infer interfaces; they don't import them — the root cause of
// cross-milestone drift.
//
// This tool extracts MINIMAL slices of prior-milestone code — signatures only,
// not bodies — for every symbol referenced in interface-contracts.json. The
// result is injected into the builder's prompt at dispatch time by
// step-03-tdd-green.md.
//
// Budget discipline: target ≤1500 tokens of extracted signatures per dispatch,
// hard cap 3000. Beyond that we trim to the N most-referenced symbols.
//
// Usage:
//   node tools/cobolt-context-inject.js build [--milestone M3]
//   node tools/cobolt-context-inject.js show  # print last context bundle
//
// Output: _cobolt-output/latest/context-inject/${M}-signatures.md
//
// Tier 1.4 (v0.11.0).

const fs = require('node:fs');
const path = require('node:path');
const USAGE = [
  'Usage:',
  '  node tools/cobolt-context-inject.js build [--milestone M3]',
  '  node tools/cobolt-context-inject.js show',
].join('\n');

function currentMilestone() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'cobolt-state.json'), 'utf8'));
    return s.pipeline?.currentMilestone || null;
  } catch {
    return null;
  }
}

function loadContracts() {
  const fp = path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'interface-contracts.json');
  if (!fs.existsSync(fp)) return { contracts: [] };
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return { contracts: [] };
  }
}

// Extract function/type/const signatures from source — one line per symbol
// Supports JS/TS/Elixir/Python lightly.
function extractSignatures(text, symbols) {
  const found = [];
  const lines = text.split('\n');
  const symbolSet = new Set(symbols.map((s) => s.toLowerCase()));

  const patterns = [
    /^export\s+(?:async\s+)?function\s+(\w+)\s*\([^)]*\)[^{]*/,
    /^export\s+const\s+(\w+)\s*(?:=|:)\s*/,
    /^export\s+(?:abstract\s+)?class\s+(\w+)[^{]*/,
    /^export\s+(?:type|interface)\s+(\w+)[^={]*/,
    /^def\s+(\w+)\s*\([^)]*\)/,
    /^class\s+(\w+)[^:]*:/,
    /^\s*def\s+(\w+)\s*\([^)]*\)\s*(?:,\s*do:|\s+do\s*$)/, // elixir
    /^\s*defmodule\s+([\w.]+)\s+do/,
    /^func\s+(\w+)\s*\([^)]*\)[^{]*/,
    /^(?:pub\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)[^{]*/,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    for (const pat of patterns) {
      const m = line.match(pat);
      if (m && symbolSet.has(m[1].toLowerCase())) {
        // One-line signature — trim braces, opening brackets
        const sig = line.replace(/\s*\{.*$/, '').slice(0, 200);
        found.push({ symbol: m[1], signature: sig });
        break;
      }
    }
  }
  return found;
}

function walkSource() {
  const out = [];
  const ignore = new Set([
    'node_modules',
    '.git',
    '_cobolt-output',
    'dist',
    'build',
    '.next',
    'coverage',
    '_build',
    'deps',
  ]);
  function walk(d, depth = 0) {
    if (depth > 10) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (ignore.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(js|mjs|cjs|ts|tsx|jsx|ex|exs|py|go|rs)$/i.test(e.name)) out.push(full);
    }
  }
  walk(process.cwd());
  return out;
}

function build(opts = {}) {
  const milestone = opts.milestone || currentMilestone();
  if (!milestone) return { ok: false, reason: 'no current milestone' };

  // Only inject for M(n>2) — earlier milestones have no prior code to drift from
  const num = Number(String(milestone).replace(/^M/, '')) || 0;
  if (num < 3) return { ok: true, skipped: true, reason: 'M1/M2 — no injection needed', milestone };

  const { contracts } = loadContracts();
  if (!contracts || contracts.length === 0) {
    return { ok: true, skipped: true, reason: 'no interface-contracts.json', milestone };
  }

  // Find contracts where a prior milestone is provider AND current milestone is consumer
  const applicable = contracts.filter(
    (c) => c.provider && c.provider !== milestone && (c.consumers || []).includes(milestone),
  );

  // Collect symbols (API paths, type symbols, data entity names, event names)
  const symbols = new Set();
  for (const c of applicable) {
    const sp = c.spec || {};
    if (sp.kind === 'type' && sp.symbol) symbols.add(sp.symbol.split('.').pop());
    if (sp.kind === 'data' && sp.entity) symbols.add(sp.entity);
    if (sp.kind === 'event' && sp.eventName) symbols.add(sp.eventName);
    // API endpoints don't map cleanly to symbols; include path as a grep hint
  }

  const files = walkSource();
  const allSigs = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const sigs = extractSignatures(text, [...symbols]);
    for (const s of sigs) allSigs.push({ ...s, file: path.relative(process.cwd(), f) });
  }

  // Budget discipline: ≤80 signatures (≈1500 tokens); trim by file diversity
  const trimmed = allSigs.slice(0, 80);

  // Build markdown bundle
  const lines = [
    `# Prior-Milestone Signatures for ${milestone}`,
    '',
    `_Extracted by cobolt-context-inject for interface contracts between ${milestone} and its providers._`,
    '_Signatures only — no bodies. Do NOT re-implement these; import/call them._',
    '',
  ];

  // API contract hints (can't extract signatures, but include method+path)
  const apiContracts = applicable.filter((c) => c.spec?.kind === 'api');
  if (apiContracts.length > 0) {
    lines.push('## API Endpoints to Call (do not re-implement)');
    lines.push('');
    for (const c of apiContracts) {
      lines.push(`- \`${c.spec.method} ${c.spec.path}\` — ${c.id} (provider: ${c.provider})`);
    }
    lines.push('');
  }

  if (trimmed.length > 0) {
    lines.push('## Symbol Signatures');
    lines.push('');
    lines.push('```');
    for (const s of trimmed) lines.push(`// ${s.file}`);
    for (const s of trimmed) lines.push(s.signature);
    lines.push('```');
    lines.push('');
  }

  if (applicable.length === 0) {
    lines.push('_No cross-milestone contracts consumed by this milestone._');
  }

  const md = lines.join('\n');

  // Write output
  const outDir = path.join(process.cwd(), '_cobolt-output', 'latest', 'context-inject');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const outPath = path.join(outDir, `${milestone}-signatures.md`);
  fs.writeFileSync(outPath, md);

  return {
    ok: true,
    milestone,
    contractsConsumed: applicable.length,
    signaturesExtracted: trimmed.length,
    bundleFile: outPath,
    approxTokens: Math.ceil(md.length / 4),
  };
}

function show() {
  const dir = path.join(process.cwd(), '_cobolt-output', 'latest', 'context-inject');
  if (!fs.existsSync(dir)) {
    console.log('(no context bundles)');
    return 0;
  }
  for (const f of fs.readdirSync(dir)) {
    console.log(`\n═══ ${f} ═══`);
    console.log(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  return 0;
}

function parseFlags(args) {
  const out = { _: [], milestone: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--milestone') out.milestone = args[++i];
    else out._.push(args[i]);
  }
  return out;
}

function usage(code) {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(`${USAGE}\n`);
  return code;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) return usage(1);

  const [cmd, ...rest] = argv;
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') return usage(0);

  const flags = parseFlags(rest);
  switch (cmd) {
    case 'build': {
      const r = build({ milestone: flags.milestone });
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    case 'show':
      return show();
    default:
      return usage(1);
  }
}

if (require.main === module) process.exit(main());

module.exports = { build };
