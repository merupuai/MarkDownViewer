#!/usr/bin/env node

// CoBolt Promise Census (v0.24+) — C-3 / C-4 / L-1 / L-3 / M-8 / M-9 / M-11 fix
//
// Architecture/standards/project-knowledge documents promise things that must
// exist in the project's dependency manifests, config, and source tree. When
// those promises drift from reality, the project ships with gaps that all
// downstream agents inherit (e.g., architecture mandates specta but Cargo.toml
// has no specta dep; UX spec declares Plus Jakarta Sans but no font is loaded).
//
// This tool reads a fixed set of documents and verifies each detected promise
// against an evidence source. Census-based: checks ALL promises, not a sample.
//
// Checks (each produces independent findings):
//   lib-in-arch-not-in-deps      Libraries cited in architecture.md /
//                                engineering-quality-standards.md /
//                                project-knowledge-base.md that have no
//                                corresponding entry in package.json
//                                dependencies|devDependencies or Cargo.toml
//                                [dependencies]
//   ui-font-not-loaded           UX spec declares a font that is not imported
//                                anywhere in index.html / *.css / tailwind.config
//   a11y-test-not-wired          axe-core / @axe-core/playwright in deps with
//                                no corresponding test file
//   cargo-config-invalid         engineering-quality-standards.md contains
//                                an invalid Cargo profile field (closes M-8)
//   version-claim-mismatch       project-knowledge-base.md version statements
//                                that disagree with manifest-pinned versions
//                                (closes L-1)
//   capability-promise-unmet     architecture cites Tauri capabilities but
//                                src-tauri/capabilities/ is absent (closes C-4)
//
// Exit codes:
//   0 = all promises met
//   1 = usage error
//   2 = skipped (no artifacts present)
//   3 = findings present (block)

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_SKIPPED = 2;
const EXIT_FINDINGS = 3;

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function existsAny(...candidates) {
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function hasDependencyManifest(cwd) {
  const rootManifests = [
    'package.json',
    'Cargo.toml',
    path.join('src-tauri', 'Cargo.toml'),
    'pyproject.toml',
    'requirements.txt',
    'go.mod',
    'mix.exs',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'Directory.Packages.props',
    'packages.config',
  ];
  if (rootManifests.some((name) => fs.existsSync(path.join(cwd, name)))) return true;

  let foundDotNetProject = false;
  const walk = (dir, depth) => {
    if (foundDotNetProject || depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '_cobolt-output') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.csproj')) {
        foundDotNetProject = true;
        return;
      }
    }
  };
  walk(cwd, 0);
  return foundDotNetProject;
}

// Resolve an artifact-by-basename across planning and brownfield output
// trees so promise-census works in both greenfield and brownfield modes.
// Returns the first path that exists, or the first planning candidate
// (possibly-missing) when none exists so callers can still Read and
// receive null, preserving the previous contract.
function planningPath(cwd, name) {
  if (!name) {
    return path.join(cwd, '_cobolt-output', 'latest', 'planning');
  }
  const candidates = [
    path.join(cwd, '_cobolt-output', 'latest', 'planning', name),
    path.join(cwd, '_cobolt-output', 'latest', 'brownfield', name),
    path.join(cwd, '_cobolt-output', 'latest', 'brownfield', 'planning', name),
  ];
  return existsAny(...candidates) || candidates[0];
}

// ── Dependency manifests ─────────────────────────────────────

function getProjectDeps(cwd) {
  const deps = new Set();

  // --- Node.js (package.json) ---
  const pkgPath = path.join(cwd, 'package.json');
  const pkg = readJson(pkgPath);
  if (pkg) {
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      if (pkg[key] && typeof pkg[key] === 'object') {
        for (const d of Object.keys(pkg[key])) deps.add(d.toLowerCase());
      }
    }
  }

  // --- Rust (Cargo.toml + Tauri) ---
  const cargoPath = path.join(cwd, 'Cargo.toml');
  const srcTauriCargo = path.join(cwd, 'src-tauri', 'Cargo.toml');
  for (const p of [cargoPath, srcTauriCargo]) {
    const text = readText(p);
    if (!text) continue;
    const inDepSection = text.split('\n');
    let inDeps = false;
    for (const line of inDepSection) {
      const trimmed = line.trim();
      if (/^\[.*dependencies\]/i.test(trimmed) || /^\[.*dev-dependencies\]/i.test(trimmed)) {
        inDeps = true;
        continue;
      }
      if (/^\[/.test(trimmed) && !/dependencies/i.test(trimmed)) inDeps = false;
      if (!inDeps) continue;
      const m = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=/);
      if (m) deps.add(m[1].toLowerCase());
    }
  }

  // --- .NET (v0.40.13 PROD-04: close the .NET silent-skip gap) ---
  // Scan *.csproj, Directory.Packages.props, packages.config for PackageReference.
  collectDotNetDeps(cwd, deps);

  // --- Python (pyproject.toml, requirements.txt) ---
  const pyproject = readText(path.join(cwd, 'pyproject.toml'));
  if (pyproject) {
    // [project.dependencies] OR [tool.poetry.dependencies]
    const lines = pyproject.split('\n');
    let inDeps = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^\[(?:project\.dependencies|tool\.poetry\.dependencies|project\.optional-dependencies)/i.test(trimmed)) {
        inDeps = true;
        continue;
      }
      if (/^\[/.test(trimmed) && !/dependencies/i.test(trimmed)) inDeps = false;
      if (!inDeps) continue;
      const m = trimmed.match(/^["']?([a-zA-Z0-9_.-]+)["']?\s*[=:]/);
      if (m) deps.add(m[1].toLowerCase());
    }
  }
  const reqTxt = readText(path.join(cwd, 'requirements.txt'));
  if (reqTxt) {
    for (const line of reqTxt.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const m = trimmed.match(/^([a-zA-Z0-9_.-]+)/);
      if (m) deps.add(m[1].toLowerCase());
    }
  }

  // --- Go (go.mod) ---
  const goMod = readText(path.join(cwd, 'go.mod'));
  if (goMod) {
    const reqRe = /^\s*([a-z0-9./-]+)\s+v?\d/gm;
    let m;
    while ((m = reqRe.exec(goMod)) !== null) {
      const name = m[1].toLowerCase();
      if (!name.includes('go.mod') && name.includes('/')) deps.add(name);
    }
  }

  // --- Elixir (mix.exs) ---
  const mixExs = readText(path.join(cwd, 'mix.exs'));
  if (mixExs) {
    const depRe = /\{\s*:([a-z_]+)\s*,/g;
    let m;
    while ((m = depRe.exec(mixExs)) !== null) deps.add(m[1].toLowerCase());
  }

  // --- Java/Kotlin (pom.xml, build.gradle) ---
  const pom = readText(path.join(cwd, 'pom.xml'));
  if (pom) {
    const artifactRe = /<artifactId>\s*([a-zA-Z0-9._-]+)\s*<\/artifactId>/g;
    let m;
    while ((m = artifactRe.exec(pom)) !== null) deps.add(m[1].toLowerCase());
  }
  const gradle = readText(path.join(cwd, 'build.gradle')) || readText(path.join(cwd, 'build.gradle.kts'));
  if (gradle) {
    const depRe = /(?:implementation|api|compile|testImplementation)\s*\(?["']([^:"']+):([^:"']+):[^"']+["']/g;
    let m;
    while ((m = depRe.exec(gradle)) !== null) {
      deps.add(m[2].toLowerCase());
      deps.add(`${m[1]}:${m[2]}`.toLowerCase());
    }
  }

  return deps;
}

// v0.40.13 PROD-04: .NET dependency collection. Scans:
//   - *.csproj (all depths up to 3 levels from cwd) for <PackageReference Include="...">
//   - Directory.Packages.props for Central Package Management
//   - packages.config (legacy)
function collectDotNetDeps(cwd, deps) {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const pkgRefRe = /<PackageReference\s+Include\s*=\s*["']([^"']+)["']/gi;

    const walk = (dir, depth) => {
      if (depth > 3) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '_cobolt-output') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile()) {
          const lower = entry.name.toLowerCase();
          if (lower.endsWith('.csproj') || lower === 'directory.packages.props' || lower === 'packages.config') {
            const text = readText(full) || '';
            let m;
            while ((m = pkgRefRe.exec(text)) !== null) deps.add(m[1].toLowerCase());
            pkgRefRe.lastIndex = 0;
            // packages.config uses `<package id="Name" ... />`
            const legacyRe = /<package\s+id\s*=\s*["']([^"']+)["']/gi;
            while ((m = legacyRe.exec(text)) !== null) deps.add(m[1].toLowerCase());
          }
        }
      }
    };
    walk(cwd, 0);
  } catch {
    /* best effort */
  }
}

// Pinned version lookup (best-effort).
function getPinnedVersion(cwd, libName) {
  const pkg = readJson(path.join(cwd, 'package.json'));
  if (pkg) {
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      if (pkg[key]?.[libName]) return pkg[key][libName];
    }
  }
  for (const p of [path.join(cwd, 'Cargo.toml'), path.join(cwd, 'src-tauri', 'Cargo.toml')]) {
    const text = readText(p);
    if (!text) continue;
    const lines = text.split('\n');
    for (const line of lines) {
      const m = line.match(new RegExp(`^\\s*${libName}\\s*=\\s*"([^"]+)"`, 'i'));
      if (m) return m[1];
      const m2 = line.match(new RegExp(`^\\s*${libName}\\s*=\\s*\\{[^}]*version\\s*=\\s*"([^"]+)"`, 'i'));
      if (m2) return m2[1];
    }
  }
  return null;
}

// ── Library/framework promise extraction ─────────────────────

// Known libraries we watch for in planning docs. Each entry: pattern → canonical
// dependency name(s) to look for in package.json/Cargo.toml. Names are
// lowercased for comparison.
const LIB_WATCHLIST = [
  { pattern: /\bspecta\b/i, deps: ['specta'], label: 'specta' },
  { pattern: /\bts-rs\b/i, deps: ['ts-rs'], label: 'ts-rs' },
  { pattern: /\b@playwright\/test\b|\bPlaywright\b/i, deps: ['@playwright/test', 'playwright'], label: 'Playwright' },
  { pattern: /\baxe-core\b|\b@axe-core\/playwright\b/i, deps: ['axe-core', '@axe-core/playwright'], label: 'axe-core' },
  { pattern: /\bPercy\b/i, deps: ['@percy/cli', '@percy/playwright'], label: 'Percy' },
  { pattern: /\bChromatic\b/i, deps: ['chromatic'], label: 'Chromatic' },
  { pattern: /\b@fontsource\//i, deps: ['@fontsource/*'], label: '@fontsource' },
  { pattern: /\bBackstopJS\b/i, deps: ['backstopjs'], label: 'BackstopJS' },
  { pattern: /\bLighthouse\b/i, deps: ['lighthouse'], label: 'Lighthouse' },
  { pattern: /\bStryker\b/i, deps: ['@stryker-mutator/core'], label: 'Stryker' },
  { pattern: /\bautocannon\b/i, deps: ['autocannon'], label: 'autocannon' },
  {
    pattern: /\bOpen[-\s]Meteo\b/i,
    deps: [],
    label: 'Open-Meteo (external API)',
    note: 'external API — integration must be in architecture-diagrams evidence graph',
  },
];

function checkLibraryPromises(cwd, findings) {
  const docs = [
    { path: planningPath(cwd, 'architecture.md'), label: 'architecture.md' },
    { path: planningPath(cwd, 'engineering-quality-standards.md'), label: 'engineering-quality-standards.md' },
    { path: planningPath(cwd, 'project-knowledge-base.md'), label: 'project-knowledge-base.md' },
    { path: planningPath(cwd, 'test-strategy.md'), label: 'test-strategy.md' },
  ];
  if (!hasDependencyManifest(cwd)) return;
  const presentDeps = getProjectDeps(cwd);
  for (const doc of docs) {
    const text = readText(doc.path);
    if (!text) continue;
    for (const lib of LIB_WATCHLIST) {
      if (lib.deps.length === 0) continue; // external-API entries are informational
      if (!lib.pattern.test(text)) continue;
      // Is ANY of the candidate deps present?
      const matched = lib.deps.find((d) => {
        const dl = d.toLowerCase();
        if (dl.endsWith('/*')) return [...presentDeps].some((p) => p.startsWith(dl.slice(0, -1)));
        // @fontsource/* packages — accept any scoped match
        if (dl.endsWith('/')) return [...presentDeps].some((p) => p.startsWith(dl));
        // @scoped/names are full matches; bare names exact match too.
        return presentDeps.has(dl);
      });
      if (!matched) {
        findings.push({
          class: 'lib-in-arch-not-in-deps',
          severity: 'high',
          library: lib.label,
          doc: doc.label,
          expectedAnyOf: lib.deps,
          message: `${doc.label} cites ${lib.label} but none of [${lib.deps.join(', ')}] appears in package.json/Cargo.toml`,
        });
      }
    }
  }
}

// ── UX font ↔ scaffold imports ───────────────────────────────

function checkUxFonts(cwd, findings) {
  const uxPath = planningPath(cwd, 'ux-design-specification.md');
  const text = readText(uxPath);
  if (!text) return;

  // Extract declared font family names after label patterns like
  // "Display Font:", "Body Font:", "Heading Font:", "Monospace:",
  // "Font Family:" — each on its own line or followed by a comma.
  const fontNames = new Set();
  const labelRe =
    /^\s*(?:Display|Body|Heading|Primary|Secondary|Monospace|Sans)\s*Font\s*:\s*([A-Z][\w +-]*?)(?:\s*[,\n]|$)/gim;
  const familyRe = /^\s*Font\s*Family\s*:\s*([A-Z][\w +-]*?)(?:\s*[,\n]|$)/gim;
  for (const re of [labelRe, familyRe]) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1].trim();
      if (raw.length >= 3 && raw.length <= 40) fontNames.add(raw.replace(/\s+/g, ' ').trim());
    }
  }
  if (fontNames.size === 0) return;

  // Collect font-import evidence across common scaffold files.
  const evidence = [
    readText(path.join(cwd, 'index.html')) || '',
    readText(path.join(cwd, 'app', 'globals.css')) || '',
    readText(path.join(cwd, 'src', 'index.css')) || '',
    readText(path.join(cwd, 'src', 'app.css')) || '',
    readText(path.join(cwd, 'tailwind.config.js')) || '',
    readText(path.join(cwd, 'tailwind.config.ts')) || '',
    readText(path.join(cwd, 'package.json')) || '',
  ]
    .join('\n')
    .toLowerCase();

  for (const font of fontNames) {
    const fLow = font.toLowerCase();
    const keyHyphen = fLow.replace(/\s+/g, '-');
    const keyPlus = fLow.replace(/\s+/g, '+');
    if (
      !evidence.includes(fLow) &&
      !evidence.includes(keyHyphen) &&
      !evidence.includes(keyPlus) &&
      !evidence.includes(`@fontsource/${keyHyphen}`)
    ) {
      findings.push({
        class: 'ui-font-not-loaded',
        severity: 'medium',
        font,
        message: `UX spec declares font "${font}" but no <link>, @import, @fontsource, or tailwind fontFamily entry exists — will silently fall back to system-ui`,
      });
    }
  }
}

// ── Cargo profile field validity ─────────────────────────────

const VALID_CARGO_PROFILE_FIELDS = new Set([
  'opt-level',
  'debug',
  'split-debuginfo',
  'strip',
  'debug-assertions',
  'overflow-checks',
  'lto',
  'panic',
  'incremental',
  'codegen-units',
  'rpath',
]);

function checkCargoConfig(cwd, findings) {
  const esPath = planningPath(cwd, 'engineering-quality-standards.md');
  const text = readText(esPath);
  if (!text) return;
  // Scan for [profile.*] blocks and harvest k=v lines up to either the next
  // [section] in TOML or end-of-text. Note: JS regex has no \Z anchor — we
  // split on headings rather than relying on lookahead.
  const profileRe = /\[profile\.(release|dev|test|bench)\]/g;
  let m;
  while ((m = profileRe.exec(text)) !== null) {
    const start = m.index + m[0].length;
    const after = text.slice(start);
    const nextBracket = after.search(/^\s*\[[^\]]+\]/m);
    const block = nextBracket >= 0 ? after.slice(0, nextBracket) : after;
    const kvRe = /^\s*([a-z][a-z0-9_-]*)\s*=/gim;
    let k;
    while ((k = kvRe.exec(block)) !== null) {
      const key = k[1].toLowerCase();
      if (key.startsWith('profile')) continue;
      if (!VALID_CARGO_PROFILE_FIELDS.has(key)) {
        findings.push({
          class: 'cargo-config-invalid',
          severity: 'high',
          key,
          message: `engineering-quality-standards.md cites [profile.*] field "${key}" — not a valid Cargo profile field. Valid: ${[...VALID_CARGO_PROFILE_FIELDS].join(', ')}. For offline builds use "cargo build --offline --frozen" in CI, not a profile field.`,
        });
      }
    }
  }
}

// ── Version claim ↔ manifest parity ───────────────────────────

function checkVersionClaims(cwd, findings) {
  const pkPath = planningPath(cwd, 'project-knowledge-base.md');
  const text = readText(pkPath);
  if (!text) return;
  // Look for patterns like "Tauri 2.x is stable" or "using React 19"
  // followed by a library name. Accept "Tauri", "React", "Node", "Rust",
  // "Elixir", "Phoenix", "Vue", "Svelte", "Next.js".
  const patterns = [
    { re: /\bTauri\s+(\d+(?:\.\d+)*(?:\.[x0-9]+)?)\s+is\s+(stable|final|GA)/gi, lib: 'tauri' },
    { re: /\b(React|Vue|Svelte|Next\.js|Phoenix|Angular)\s+(\d+(?:\.\d+)*)\b/gi, libCapture: 1, versionCapture: 2 },
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.re.exec(text)) !== null) {
      const libRaw = p.libCapture ? m[p.libCapture] : 'tauri';
      const lib = libRaw.toLowerCase();
      const claimed = (p.versionCapture ? m[p.versionCapture] : m[1]).toLowerCase();
      const pinned = getPinnedVersion(cwd, lib);
      if (!pinned) continue;
      const pinnedLower = pinned.toLowerCase();
      // Detect "X is stable" but pin has rc/alpha/beta
      if (/is\s+stable|is\s+final|is\s+ga/i.test(m[0]) && /(rc|alpha|beta|pre|nightly)/.test(pinnedLower)) {
        findings.push({
          class: 'version-claim-mismatch',
          severity: 'medium',
          library: libRaw,
          claim: m[0].trim().slice(0, 160),
          pinnedVersion: pinned,
          message: `project-knowledge-base.md claims "${libRaw}" is stable, but manifest pins pre-release "${pinned}"`,
        });
      }
      // Detect "React 19" but manifest pins ^18
      if (p.versionCapture) {
        const claimedMajor = claimed.split('.')[0];
        const pinnedMajor = pinnedLower.replace(/^[\^~>=<\s]+/, '').split('.')[0];
        if (pinnedMajor && claimedMajor && pinnedMajor !== claimedMajor) {
          findings.push({
            class: 'version-claim-mismatch',
            severity: 'medium',
            library: libRaw,
            claim: m[0].trim().slice(0, 160),
            pinnedVersion: pinned,
            message: `project-knowledge-base.md says "${libRaw} ${claimed}" but manifest pins "${pinned}" (major version mismatch)`,
          });
        }
      }
    }
  }
}

// ── Capability promise (Tauri-specific) ──────────────────────

function checkCapabilities(cwd, findings) {
  const archPath = planningPath(cwd, 'architecture.md');
  const text = readText(archPath);
  if (!text) return;
  const mentionsCapabilities = /\b(tauri\s+2|capabilities\s*\/|src-tauri\/capabilities|capability\s+files?)\b/i.test(
    text,
  );
  if (!mentionsCapabilities) return;
  const capDir = path.join(cwd, 'src-tauri', 'capabilities');
  if (!fs.existsSync(capDir)) {
    findings.push({
      class: 'capability-promise-unmet',
      severity: 'high',
      message:
        'architecture.md cites Tauri 2 capabilities scheme but src-tauri/capabilities/ does not exist. Scaffold a default.json with minimal allow/deny, plus an integration test asserting a disallowed URL is refused.',
    });
    return;
  }
  const files = fs.readdirSync(capDir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    findings.push({
      class: 'capability-promise-unmet',
      severity: 'high',
      message: `src-tauri/capabilities/ exists but contains no *.json files. Capability-less Tauri 2 rejects all IPC — a missing file will break runtime.`,
    });
  }
}

// ── a11y wiring ──────────────────────────────────────────────

function checkA11yWiring(cwd, findings) {
  const deps = getProjectDeps(cwd);
  const hasAxe = deps.has('axe-core') || deps.has('@axe-core/playwright');
  if (!hasAxe) return;
  // If axe-core is in deps, expect an a11y test file somewhere.
  const testDirs = [
    path.join(cwd, 'e2e', 'tests'),
    path.join(cwd, 'e2e'),
    path.join(cwd, 'tests', 'a11y'),
    path.join(cwd, 'tests', 'e2e'),
  ];
  let found = false;
  for (const dir of testDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir).filter((f) => /\.(spec|test)\.(js|ts)$/.test(f));
      for (const f of files) {
        const content = readText(path.join(dir, f)) || '';
        if (/@axe-core\/playwright|AxeBuilder|axe-core/.test(content)) {
          found = true;
          break;
        }
      }
      if (found) break;
    } catch {
      /* ignore */
    }
  }
  if (!found) {
    findings.push({
      class: 'a11y-test-not-wired',
      severity: 'medium',
      message:
        'axe-core is installed in package.json but no test file imports @axe-core/playwright / AxeBuilder / axe-core. Add e2e/tests/a11y.spec.ts with AxeBuilder(page).analyze() so the a11y promise is enforceable.',
    });
  }
}

// ── Runner ────────────────────────────────────────────────────

function runAll(cwd) {
  const findings = [];
  const planning = path.join(cwd, '_cobolt-output', 'latest', 'planning');
  const brownfield = path.join(cwd, '_cobolt-output', 'latest', 'brownfield');
  if (!fs.existsSync(planning) && !fs.existsSync(brownfield)) {
    return { status: 'skipped', reason: 'no planning or brownfield directory', findings };
  }
  checkLibraryPromises(cwd, findings);
  checkUxFonts(cwd, findings);
  checkCargoConfig(cwd, findings);
  checkVersionClaims(cwd, findings);
  checkCapabilities(cwd, findings);
  checkA11yWiring(cwd, findings);
  return { status: findings.length === 0 ? 'pass' : 'fail', findings };
}

function emit(result, opts) {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const badge = result.status === 'pass' ? 'PASS' : result.status === 'skipped' ? 'SKIP' : 'FAIL';
  process.stdout.write(`[${badge}] cobolt-promise-census — ${result.findings.length} finding(s)\n`);
  for (const f of result.findings.slice(0, 10)) {
    process.stdout.write(`  • [${f.severity}] ${f.message}\n`);
  }
  if (result.findings.length > 10) {
    process.stdout.write(`  … ${result.findings.length - 10} more (use --json for full output)\n`);
  }
}

function usageText() {
  return [
    'Usage: cobolt-promise-census census [--json]',
    '',
    'Verifies planning-doc promises against dependency manifests, config, and source.',
    'Checks: libraries cited in architecture/standards/pk-base but missing from',
    'package.json|Cargo.toml; fonts declared in UX spec but not loaded in',
    'index.html|css|tailwind; invalid Cargo profile fields; version-claim drift;',
    'Tauri capability files; a11y test wiring.',
    '',
    'Exit codes: 0 OK | 1 usage | 2 skipped | 3 findings',
  ].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opts = { json: args.includes('--json') };
  if (!cmd) {
    process.stderr.write(`${usageText()}\n`);
    process.exit(EXIT_USAGE);
  }
  if (cmd === 'help' || cmd === '-h' || cmd === '--help' || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usageText()}\n`);
    process.exit(EXIT_OK);
  }
  if (cmd !== 'census') {
    process.stderr.write(`Unknown command: ${cmd}\n`);
    process.exit(EXIT_USAGE);
  }
  try {
    const result = runAll(process.cwd());
    emit(result, opts);
    if (result.status === 'pass') process.exit(EXIT_OK);
    if (result.status === 'skipped') process.exit(EXIT_SKIPPED);
    process.exit(EXIT_FINDINGS);
  } catch (err) {
    process.stderr.write(`[cobolt-promise-census] ERROR: ${err.message}\n`);
    process.exit(EXIT_USAGE);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  runAll,
  checkLibraryPromises,
  checkUxFonts,
  checkCargoConfig,
  checkVersionClaims,
  checkCapabilities,
  checkA11yWiring,
  hasDependencyManifest,
  getProjectDeps,
  getPinnedVersion,
  VALID_CARGO_PROFILE_FIELDS,
  LIB_WATCHLIST,
};
