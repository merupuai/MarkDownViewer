#!/usr/bin/env node

// CoBolt Domain IR Pack Loader (v0.12.0 — WS2)
//
// Reads the project's PRD + state to detect applicable domain(s), loads the
// corresponding packs from source/data/domain-ir-packs/, and emits:
//
//   - for injection into cobolt-extract-implicit-reqs step-01:
//       JSON bundle of mandatoryIRs that the IR author must address
//
//   - for coverage verification by cobolt-domain-ir-gate.js:
//       per-IR presence check against _cobolt-output/latest/planning/implicit-requirements.md
//
// Multiple packs can apply (e.g., fintech + saas-multitenant for a B2B
// payments platform). Matches are additive.
//
// Usage:
//   cobolt-domain-ir-pack.js detect               # list matching packs
//   cobolt-domain-ir-pack.js inject               # emit IR bundle as JSON
//   cobolt-domain-ir-pack.js verify               # coverage check (exit 1 on miss)
//   cobolt-domain-ir-pack.js list                 # list available packs
//   cobolt-domain-ir-pack.js show <domain>        # print one pack

const fs = require('node:fs');
const path = require('node:path');

const LOW_SIGNAL_KEYWORDS = new Set(['account', 'plan', 'product', 'usage']);

function paths() {
  try {
    const mod = require('../lib/cobolt-paths');
    const p = typeof mod === 'function' ? mod() : typeof mod.paths === 'function' ? mod.paths() : mod;
    return p;
  } catch {
    const out = path.join(process.cwd(), '_cobolt-output');
    return {
      outputRoot: out,
      audit: () => path.join(out, 'audit'),
      latestPlanning: () => path.join(out, 'latest', 'planning'),
    };
  }
}

function packsDir() {
  // Search in priority order:
  // 1. user project override: ./cobolt-data/domain-ir-packs
  // 2. installed CoBolt source: ../source/data/domain-ir-packs (relative to tools/)
  // 3. installed CoBolt package: <package>/source/data/domain-ir-packs
  const candidates = [
    path.join(process.cwd(), 'cobolt-data', 'domain-ir-packs'),
    path.join(__dirname, '..', 'source', 'data', 'domain-ir-packs'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

// v0.12.0 fix M7: minimal schema validation so malformed packs surface loudly
function validatePack(pack, filename) {
  const errors = [];
  if (!pack || typeof pack !== 'object') return [`${filename}: not an object`];
  if (!pack.domain || typeof pack.domain !== 'string') errors.push(`${filename}: missing "domain"`);
  if (!pack.packVersion || !/^\d+\.\d+\.\d+$/.test(pack.packVersion))
    errors.push(`${filename}: packVersion must be semver`);
  if (!Array.isArray(pack.mandatoryIRs) || pack.mandatoryIRs.length === 0)
    errors.push(`${filename}: mandatoryIRs must be non-empty array`);
  else {
    for (const ir of pack.mandatoryIRs) {
      if (!ir.id || !/^IR-[A-Z]{2,6}-\d{3,}$/.test(ir.id))
        errors.push(`${filename}: IR id "${ir.id}" does not match IR-XXX-NNN`);
      if (!ir.pattern) errors.push(`${filename}: IR ${ir.id} missing pattern`);
      if (!ir.appliesTo) errors.push(`${filename}: IR ${ir.id} missing appliesTo`);
      if (!Array.isArray(ir.requiredCoverage) || ir.requiredCoverage.length === 0)
        errors.push(`${filename}: IR ${ir.id} requiredCoverage must be non-empty`);
    }
  }
  return errors;
}

function loadAllPacks() {
  const dir = packsDir();
  if (!dir) return [];
  const packs = [];
  const errors = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (err) {
      errors.push(`${f}: invalid JSON — ${err.message}`);
      continue;
    }
    const validationErrors = validatePack(raw, f);
    if (validationErrors.length > 0) {
      errors.push(...validationErrors);
      continue;
    }
    packs.push(raw);
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(`[pack-loader] ${e}`);
  }
  return packs;
}

function loadPrdText() {
  const p = paths();
  const prdCandidates = [
    path.join(typeof p.latestPlanning === 'function' ? p.latestPlanning() : '', 'prd.md'),
    path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'prd.md'),
    path.join(process.cwd(), 'docs', 'prd.md'),
  ];
  const briefCandidates = [
    path.join(typeof p.latestPlanning === 'function' ? p.latestPlanning() : '', 'project-brief.md'),
    path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'project-brief.md'),
  ];
  const parts = [];
  for (const c of [...prdCandidates, ...briefCandidates]) {
    if (c && fs.existsSync(c)) parts.push(fs.readFileSync(c, 'utf8'));
  }
  return parts.join('\n\n');
}

function loadStateDomain() {
  const stateFile = path.join(process.cwd(), 'cobolt-state.json');
  if (!fs.existsSync(stateFile)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return s.project?.domain || s.classification?.domain || null;
  } catch {
    return null;
  }
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordMatches(text, keyword) {
  const normalized = String(keyword || '')
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  const parts = normalized.split(/\s+/u).filter(Boolean).map(escapeRegex);
  if (parts.length === 0) return false;
  const pattern = new RegExp(`\\b${parts.join('\\s+')}\\b`, 'iu');
  return pattern.test(text);
}

function keywordWeight(keyword) {
  return LOW_SIGNAL_KEYWORDS.has(
    String(keyword || '')
      .trim()
      .toLowerCase(),
  )
    ? 0.5
    : 1;
}

function detectPacks() {
  const packs = loadAllPacks();
  const prdText = loadPrdText().toLowerCase();
  const stateDomain = loadStateDomain();
  const hits = [];

  for (const pack of packs) {
    let matched = false;
    const reasons = [];

    if (pack.appliesWhen?.prdDomainMatch && stateDomain) {
      if (stateDomain.toLowerCase() === pack.domain.toLowerCase()) {
        matched = true;
        reasons.push(`state.domain == "${pack.domain}"`);
      }
    }

    const kw = pack.appliesWhen?.keywords || [];
    const matchedKeywords = kw.filter((keyword) => keywordMatches(prdText, keyword));
    const keywordScore = matchedKeywords.reduce((total, keyword) => total + keywordWeight(keyword), 0);
    if (matchedKeywords.length >= 2 && keywordScore >= 2) {
      matched = true;
      reasons.push(
        `PRD matched ${matchedKeywords.length} keywords (${matchedKeywords.slice(0, 4).join(', ')}) with score ${keywordScore.toFixed(1)}`,
      );
    }

    if (matched) hits.push({ domain: pack.domain, displayName: pack.displayName, reasons, pack });
  }
  return hits;
}

function injectIRs() {
  const hits = detectPacks();
  const bundle = {
    generatedAt: new Date().toISOString(),
    packsMatched: hits.map((h) => ({ domain: h.domain, reasons: h.reasons, packVersion: h.pack.packVersion })),
    mandatoryIRs: [],
    mandatoryFRs: [],
    invariantHints: [],
  };
  for (const { pack } of hits) {
    for (const ir of pack.mandatoryIRs || []) bundle.mandatoryIRs.push({ sourcePack: pack.domain, ...ir });
    for (const fr of pack.mandatoryFRs || []) bundle.mandatoryFRs.push({ sourcePack: pack.domain, ...fr });
    for (const inv of pack.invariantHints || [])
      bundle.invariantHints.push({ sourcePack: pack.domain, statement: inv });
  }
  // Persist for downstream consumers (gate, PRD redteam, cross-milestone-analysis)
  const p = paths();
  const planning =
    typeof p.latestPlanning === 'function'
      ? p.latestPlanning()
      : path.join(process.cwd(), '_cobolt-output', 'latest', 'planning');
  fs.mkdirSync(planning, { recursive: true });
  fs.writeFileSync(path.join(planning, 'domain-ir-bundle.json'), JSON.stringify(bundle, null, 2));
  return bundle;
}

function loadIRText() {
  const p = paths();
  const candidates = [
    path.join(typeof p.latestPlanning === 'function' ? p.latestPlanning() : '', 'implicit-requirements.md'),
    path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'implicit-requirements.md'),
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return fs.readFileSync(c, 'utf8');
  return '';
}

function verifyCoverage() {
  const bundle = injectIRs(); // always re-detect for freshness
  const irText = loadIRText().toLowerCase();
  if (!irText) {
    return {
      ok: false,
      reason: 'implicit-requirements.md not found — cannot verify domain IR coverage',
      bundle,
    };
  }
  const missing = [];
  // v0.12.0 fix H3: word-boundary matching — prevents false positives like
  // "stockholder" matching "stock reservation" or "charge" matching "recharge".
  function wordHit(text, phrase) {
    // Accept phrase as a whole if any significant word (len > 4) appears with
    // word boundaries. Multiple significant words must all hit.
    const words = phrase
      .toLowerCase()
      .split(/[\s(),.\-_/]+/)
      .filter((w) => w.length > 4)
      .slice(0, 4);
    if (words.length === 0) return text.includes(phrase.toLowerCase());
    return words.every((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
  }
  for (const ir of bundle.mandatoryIRs) {
    const idHit = new RegExp(`\\b${ir.id.replace(/-/g, '-')}\\b`, 'i').test(irText);
    const patternHit = wordHit(irText, ir.pattern);
    const coverageHits = (ir.requiredCoverage || []).filter((r) => wordHit(irText, r)).length;
    const coverageRatio = (ir.requiredCoverage || []).length > 0 ? coverageHits / ir.requiredCoverage.length : 1;

    if (!idHit && !patternHit) {
      missing.push({
        id: ir.id,
        pattern: ir.pattern,
        pack: ir.sourcePack,
        severity: ir.severity,
        reason: 'IR not referenced by ID or pattern',
      });
    } else if (coverageRatio < 0.5) {
      missing.push({
        id: ir.id,
        pattern: ir.pattern,
        pack: ir.sourcePack,
        severity: ir.severity,
        reason: `only ${Math.round(coverageRatio * 100)}% of requiredCoverage items found`,
      });
    }
  }
  const critical = missing.filter((m) => m.severity === 'critical');
  return {
    ok: critical.length === 0 && missing.length === 0,
    criticalMissing: critical,
    missing,
    totalMandatoryIRs: bundle.mandatoryIRs.length,
    packsMatched: bundle.packsMatched,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────

function main() {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case 'detect': {
      const hits = detectPacks();
      console.log(
        JSON.stringify(
          {
            count: hits.length,
            packs: hits.map((h) => ({ domain: h.domain, displayName: h.displayName, reasons: h.reasons })),
          },
          null,
          2,
        ),
      );
      return 0;
    }
    case 'inject': {
      const bundle = injectIRs();
      console.log(JSON.stringify(bundle, null, 2));
      return 0;
    }
    case 'verify':
    case 'check': {
      const r = verifyCoverage();
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    case 'list': {
      const packs = loadAllPacks();
      console.log(
        JSON.stringify(
          {
            count: packs.length,
            packs: packs.map((p) => ({
              domain: p.domain,
              displayName: p.displayName,
              packVersion: p.packVersion,
              mandatoryIRCount: (p.mandatoryIRs || []).length,
              mandatoryFRCount: (p.mandatoryFRs || []).length,
              invariantHintCount: (p.invariantHints || []).length,
            })),
          },
          null,
          2,
        ),
      );
      return 0;
    }
    case 'show': {
      if (!arg) {
        console.error('show requires domain name');
        return 1;
      }
      const pack = loadAllPacks().find((p) => p.domain === arg);
      if (!pack) {
        console.error(`pack not found: ${arg}`);
        return 1;
      }
      console.log(JSON.stringify(pack, null, 2));
      return 0;
    }
    default:
      console.error('Usage: cobolt-domain-ir-pack.js {detect|inject|verify|list|show <domain>}');
      return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { detectPacks, injectIRs, verifyCoverage, loadAllPacks };
