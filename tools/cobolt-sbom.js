#!/usr/bin/env node

// CoBolt SBOM Generator — Software Bill of Materials
//
// Generates SBOM in CycloneDX-compatible JSON format by scanning
// package manifests (package.json, go.mod, requirements.txt, mix.exs, Cargo.toml).
//
// Usage:
//   node tools/cobolt-sbom.js                    # Generate SBOM for current project
//   node tools/cobolt-sbom.js --format json       # Output format (json|markdown)
//   node tools/cobolt-sbom.js --save              # Save to _cobolt-output/evidence
//   node tools/cobolt-sbom.js --include-dev       # Include dev dependencies
//   node tools/cobolt-sbom.js --output <path>     # Write to a specific file
//   node tools/cobolt-sbom.js --silent            # No stdout (pairs with --output)
//   node tools/cobolt-sbom.js --fail-on-empty     # Exit 1 if zero components found
//
// Exit codes (per tools/CLAUDE.md contract):
//   0 — SBOM generated successfully
//   1 — hard error (parse failure, write failure, empty-with-flag)
//   2 — missing optional dep (reserved; currently unused)
//   3 — missing infra (reserved; currently unused)

const fs = require('node:fs');
const path = require('node:path');
const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

function readJsonFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(content);
}

// Convert npm lockfile integrity string ("sha512-<base64> sha1-<base64>")
// into CycloneDX v1.5 component.hashes[] (alg is SHA-256/SHA-384/SHA-512, content is hex).
function integrityToHashes(integrityStr) {
  if (!integrityStr || typeof integrityStr !== 'string') return undefined;
  const algMap = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };
  const out = [];
  for (const token of integrityStr.trim().split(/\s+/)) {
    const dash = token.indexOf('-');
    if (dash <= 0) continue;
    const alg = token.slice(0, dash).toLowerCase();
    const b64 = token.slice(dash + 1);
    const mapped = algMap[alg];
    if (!mapped || !b64) continue;
    try {
      const hex = Buffer.from(b64, 'base64').toString('hex');
      if (hex) out.push({ alg: mapped, content: hex });
    } catch {
      /* ignore malformed base64 */
    }
  }
  return out.length ? out : undefined;
}

class SBOMGenerator {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
    this.components = [];
    this.metadata = {
      tool: 'cobolt-sbom',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    };
    this.discoveredManifests = [];
    this.applicationComponent = {
      type: 'application',
      name: path.basename(this.projectDir),
    };
  }

  /**
   * Scan all supported package manifests.
   */
  scan(options = {}) {
    this.components = [];
    this.discoveredManifests = [];
    this.applicationComponent = {
      type: 'application',
      name: path.basename(this.projectDir),
    };

    // Node.js (package.json)
    this._scanNodePackages(options.includeDev);

    // Python (requirements.txt, pyproject.toml)
    this._scanPythonPackages();

    // Go (go.mod)
    this._scanGoModules();

    // Elixir (mix.exs / mix.lock)
    this._scanElixirDeps();

    // Rust (Cargo.toml / Cargo.lock)
    this._scanRustCrates();

    return this.components;
  }

  _recordManifest(filePath, ecosystem) {
    this.discoveredManifests.push({
      ecosystem,
      path: path.relative(this.projectDir, filePath) || path.basename(filePath),
    });
  }

  _scanNodePackages(includeDev) {
    const pkgFile = path.join(this.projectDir, 'package.json');
    if (!fs.existsSync(pkgFile)) return;

    const pkg = readJsonFile(pkgFile);
    this._recordManifest(pkgFile, 'npm');
    this.applicationComponent = {
      ...this.applicationComponent,
      name: pkg.name || this.applicationComponent.name,
      ...(pkg.version ? { version: pkg.version } : {}),
    };
    const deps = { ...(pkg.dependencies || {}) };
    if (includeDev) Object.assign(deps, pkg.devDependencies || {});

    for (const [name, version] of Object.entries(deps)) {
      this.components.push({
        type: 'library',
        name,
        version: version.replace(/^[\^~>=<]/, ''),
        ecosystem: 'npm',
        purl: `pkg:npm/${name}@${version.replace(/^[\^~>=<]/, '')}`,
      });
    }

    // Also scan package-lock.json for precise versions, integrity hashes,
    // and tarball URLs. Populates CycloneDX component.hashes + externalReferences.
    const lockFile = path.join(this.projectDir, 'package-lock.json');
    if (fs.existsSync(lockFile)) {
      try {
        const lock = readJsonFile(lockFile);
        const packages = lock.packages || {};
        for (const [pkgPath, info] of Object.entries(packages)) {
          if (pkgPath === '' || !pkgPath.startsWith('node_modules/')) continue;
          // Handle nested node_modules/<scope>/<name> or node_modules/<name>
          const pkgName = pkgPath.replace(/^node_modules\//, '').replace(/\/node_modules\/.*/, '');
          if (!info.version) continue;
          const hashes = integrityToHashes(info.integrity);
          const externalReferences = [];
          if (info.resolved) {
            externalReferences.push({ type: 'distribution', url: info.resolved });
          }
          externalReferences.push({
            type: 'website',
            url: `https://www.npmjs.com/package/${pkgName}`,
          });

          const existing = this.components.find((c) => c.ecosystem === 'npm' && c.name === pkgName);
          if (existing) {
            existing.version = info.version;
            existing.purl = `pkg:npm/${pkgName}@${info.version}`;
            if (hashes) existing.hashes = hashes;
            existing.externalReferences = externalReferences;
            if (info.dev === true) existing.scope = 'optional';
          } else {
            // Include transitive deps so SBOM reflects the full supply-chain graph.
            // Skip dev-only transitives unless --include-dev was requested.
            if (info.dev === true && !includeDev) continue;
            const component = {
              type: 'library',
              name: pkgName,
              version: info.version,
              ecosystem: 'npm',
              purl: `pkg:npm/${pkgName}@${info.version}`,
              externalReferences,
            };
            if (hashes) component.hashes = hashes;
            if (info.dev === true) component.scope = 'optional';
            this.components.push(component);
          }
        }
      } catch {
        /* ignore parse errors */
      }
    }
  }

  _scanPythonPackages() {
    const reqFile = path.join(this.projectDir, 'requirements.txt');
    if (!fs.existsSync(reqFile)) return;

    this._recordManifest(reqFile, 'pypi');
    const lines = fs.readFileSync(reqFile, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
      const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s*[>=<~!]*\s*([\d.]*)/);
      if (match) {
        this.components.push({
          type: 'library',
          name: match[1],
          version: match[2] || 'unknown',
          ecosystem: 'pypi',
          purl: `pkg:pypi/${match[1]}@${match[2] || 'unknown'}`,
        });
      }
    }
  }

  _scanGoModules() {
    const goMod = path.join(this.projectDir, 'go.mod');
    if (!fs.existsSync(goMod)) return;

    this._recordManifest(goMod, 'go');
    const content = fs.readFileSync(goMod, 'utf8');
    const requireBlock = content.match(/require\s*\(([\s\S]*?)\)/);
    if (!requireBlock) return;

    const lines = requireBlock[1].split('\n');
    for (const line of lines) {
      const match = line.trim().match(/^(\S+)\s+v?([\d.]+\S*)/);
      if (match) {
        this.components.push({
          type: 'library',
          name: match[1],
          version: match[2],
          ecosystem: 'go',
          purl: `pkg:golang/${match[1]}@${match[2]}`,
        });
      }
    }
  }

  _scanElixirDeps() {
    const mixLock = path.join(this.projectDir, 'mix.lock');
    if (!fs.existsSync(mixLock)) return;

    this._recordManifest(mixLock, 'hex');
    const content = fs.readFileSync(mixLock, 'utf8');
    const depRegex = /"([^"]+)":\s*\{:hex,\s*:([^,]+),\s*"([^"]+)"/g;
    let match;
    while ((match = depRegex.exec(content)) !== null) {
      this.components.push({
        type: 'library',
        name: match[1],
        version: match[3],
        ecosystem: 'hex',
        purl: `pkg:hex/${match[1]}@${match[3]}`,
      });
    }
  }

  _scanRustCrates() {
    const cargoLock = path.join(this.projectDir, 'Cargo.lock');
    if (!fs.existsSync(cargoLock)) return;

    this._recordManifest(cargoLock, 'crates');
    const content = fs.readFileSync(cargoLock, 'utf8');
    const packageRegex = /\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g;
    let match;
    while ((match = packageRegex.exec(content)) !== null) {
      this.components.push({
        type: 'library',
        name: match[1],
        version: match[2],
        ecosystem: 'crates',
        purl: `pkg:cargo/${match[1]}@${match[2]}`,
      });
    }
  }

  /**
   * Generate CycloneDX-compatible SBOM.
   */
  toBOM() {
    return {
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      version: 1,
      metadata: {
        timestamp: this.metadata.timestamp,
        tools: [{ vendor: 'CoBolt', name: 'cobolt-sbom', version: this.metadata.version }],
        component: this.applicationComponent,
        properties: this.discoveredManifests.map((manifest) => ({
          name: 'cobolt:manifest',
          value: `${manifest.ecosystem}:${manifest.path}`,
        })),
      },
      components: this.components,
    };
  }

  /**
   * Generate markdown summary.
   */
  toMarkdown() {
    const byEcosystem = {};
    for (const c of this.components) {
      if (!byEcosystem[c.ecosystem]) byEcosystem[c.ecosystem] = [];
      byEcosystem[c.ecosystem].push(c);
    }

    const lines = [
      '# Software Bill of Materials (SBOM)',
      '',
      `**Generated:** ${this.metadata.timestamp}`,
      `**Total components:** ${this.components.length}`,
      '',
    ];

    for (const [eco, comps] of Object.entries(byEcosystem)) {
      lines.push(`## ${eco} (${comps.length})`);
      lines.push('');
      lines.push('| Package | Version |');
      lines.push('|---------|---------|');
      for (const c of comps.sort((a, b) => a.name.localeCompare(b.name))) {
        lines.push(`| ${c.name} | ${c.version} |`);
      }
      lines.push('');
    }

    lines.push('---', '', '*Made by CoBolt — Autonomous Development Platform*');

    return lines.join('\n');
  }

  /**
   * Save SBOM to _cobolt-output.
   */
  save() {
    const _p = typeof _paths === 'function' ? _paths(this.projectDir) : null;
    const outDir = _p ? _p.evidence() : path.join(this.projectDir, '_cobolt-output/evidence');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const jsonPath = path.join(outDir, 'sbom.json');
    fs.writeFileSync(jsonPath, JSON.stringify(this.toBOM(), null, 2), 'utf8');

    const mdPath = path.join(outDir, 'sbom.md');
    fs.writeFileSync(mdPath, this.toMarkdown(), 'utf8');

    return { json: jsonPath, md: mdPath };
  }
}

function writeOutput(filePath, content) {
  const resolvedPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, content, 'utf8');
  return resolvedPath;
}

// ── SPDX 2.3 secondary emitter (P2.2 / v0.62+) ────────────────────────
//
// SPDX 2.3 is the second official SBOM format compliance auditors accept
// alongside CycloneDX. NIST SSDF RV.1.2, EU CRA Annex II §1, and US EO 14028
// all reference both formats interchangeably. We render from the same
// scanned components so the two SBOMs always agree.
//
// SPDXRef IDs MUST be unique within the document; we use SPDXRef-Pkg-N
// (1-indexed) for components and SPDXRef-Project for the root.

const _crypto = require('node:crypto');

function _spdxIdSafe(name, version) {
  // SPDX IDs accept letters, digits, ., -.  All other chars become '-'.
  return `${name}-${version}`.replace(/[^A-Za-z0-9.-]/g, '-');
}

function _toSpdx({ bom, projectDir }) {
  const generatedAt = bom?.metadata?.timestamp || new Date().toISOString();
  const root = bom?.metadata?.component || { name: path.basename(projectDir || ''), version: '0.0.0' };
  const components = Array.isArray(bom?.components) ? bom.components : [];

  const docName = `${root.name || 'project'}-sbom`;
  const docNs = `https://cobolt.dev/spdx/${encodeURIComponent(docName)}-${_crypto.randomUUID()}`;
  const rootSpdxId = 'SPDXRef-Project';

  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: docName,
    documentNamespace: docNs,
    creationInfo: {
      created: generatedAt,
      creators: ['Tool: cobolt-sbom-1.0.0', 'Organization: CoBolt'],
      licenseListVersion: '3.21',
    },
    packages: [
      {
        SPDXID: rootSpdxId,
        name: root.name || 'project',
        versionInfo: root.version || '0.0.0',
        downloadLocation: 'NOASSERTION',
        filesAnalyzed: false,
        primaryPackagePurpose: 'APPLICATION',
        copyrightText: 'NOASSERTION',
      },
      ...components.map((c, i) => {
        const spdxId = `SPDXRef-Pkg-${i + 1}-${_spdxIdSafe(c.name, c.version)}`.slice(0, 80);
        const pkg = {
          SPDXID: spdxId,
          name: c.name,
          versionInfo: c.version,
          downloadLocation: 'NOASSERTION',
          filesAnalyzed: false,
          copyrightText: 'NOASSERTION',
        };
        if (c.purl) {
          pkg.externalRefs = [
            { referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: c.purl },
          ];
        }
        if (Array.isArray(c.hashes) && c.hashes.length > 0) {
          pkg.checksums = c.hashes.map((h) => ({
            algorithm: String(h.alg || '').replace(/^SHA-/, 'SHA'),
            checksumValue: h.content,
          }));
        }
        return pkg;
      }),
    ],
    relationships: [
      { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: rootSpdxId },
      ...components.map((_c, i) => ({
        spdxElementId: rootSpdxId,
        relationshipType: 'DEPENDS_ON',
        relatedSpdxElement: `SPDXRef-Pkg-${i + 1}-${_spdxIdSafe(components[i].name, components[i].version)}`.slice(
          0,
          80,
        ),
      })),
    ],
  };
}

// ── High-level generate() — Phase 2.2 entrypoint ──────────────────────
//
// Wraps the existing SBOMGenerator class with milestone-aware output paths,
// SPDX 2.3 secondary emission, and evidence-ledger persistence (P1.1).
// Backwards-compatible — does not change the existing class API or its
// _cobolt-output/evidence/sbom.json save path; new callers use generate().

function _sanitiseMilestone(milestone) {
  if (!milestone) return null;
  if (!/^M\d+$/i.test(String(milestone))) {
    throw new Error(`generate: milestone must match /^M\\d+$/, got "${milestone}"`);
  }
  return String(milestone).toUpperCase();
}

function generate({ cwd, milestone, projectName, projectVersion, includeDev = false } = {}) {
  const root = cwd ? path.resolve(cwd) : process.cwd();
  const M = _sanitiseMilestone(milestone) || 'M1';

  const gen = new SBOMGenerator(root);
  gen.scan({ includeDev });
  // Honour explicit project metadata when provided.
  if (projectName) gen.applicationComponent.name = projectName;
  if (projectVersion) gen.applicationComponent.version = projectVersion;
  const cdx = gen.toBOM();
  const spdx = _toSpdx({ bom: cdx, projectDir: root });

  const buildDir = path.join(root, '_cobolt-output', 'latest', 'build', M);
  fs.mkdirSync(buildDir, { recursive: true, mode: 0o700 });
  const cdxPath = path.join(buildDir, 'sbom.cdx.json');
  const spdxPath = path.join(buildDir, 'sbom.spdx.json');
  fs.writeFileSync(cdxPath, `${JSON.stringify(cdx, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(spdxPath, `${JSON.stringify(spdx, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  // Append to unified evidence ledger (P1.1 dual-emit pattern).
  let ledgerEntryId = null;
  try {
    const evLedger = require('../lib/cobolt-evidence-ledger');
    const cdxBuf = fs.readFileSync(cdxPath);
    const spdxBuf = fs.readFileSync(spdxPath);
    const entry = evLedger.append(
      {
        kind: evLedger.KINDS.SBOM,
        producer: 'cobolt-sbom/v0.62.0',
        sha256s: {
          'sbom.cdx.json': _crypto.createHash('sha256').update(cdxBuf).digest('hex'),
          'sbom.spdx.json': _crypto.createHash('sha256').update(spdxBuf).digest('hex'),
        },
        controlIds: ['NIST.SSDF.RV.1.2', 'OWASP.ASVS.V14.2.5', 'EU.CRA.AnnexI.1.2', 'EU.CRA.AnnexII.1'],
        payload: {
          milestone: M,
          componentCount: gen.components.length,
          ecosystems: [...new Set(gen.components.map((c) => c.ecosystem).filter(Boolean))],
          cdxSerialNumber: cdx.serialNumber || null,
          spdxDocumentNamespace: spdx.documentNamespace,
        },
      },
      { projectRoot: root },
    );
    ledgerEntryId = entry.entryId;
  } catch {
    // Tier 3 advisory — SBOM still on disk even if ledger append fails.
  }

  return {
    cdx,
    spdx,
    paths: { cdx: cdxPath, spdx: spdxPath },
    componentCount: gen.components.length,
    ecosystems: [...new Set(gen.components.map((c) => c.ecosystem).filter(Boolean))],
    ledgerEntryId,
  };
}

// ── Module exports ───────────────────────────────────────────

module.exports = { SBOMGenerator, readJsonFile, writeOutput, generate, _toSpdx };

// ── CLI ──────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  // Phase 2.2 high-level subcommand: `generate --milestone M1 [...]`.
  // Emits CycloneDX 1.5 + SPDX 2.3 to _cobolt-output/latest/build/{M}/ and
  // appends to the unified evidence ledger.
  if (args[0] === 'generate') {
    try {
      const opts = {};
      for (let i = 1; i < args.length; i += 1) {
        if (args[i] === '--milestone') opts.milestone = args[++i];
        else if (args[i] === '--cwd') opts.cwd = args[++i];
        else if (args[i] === '--name') opts.projectName = args[++i];
        else if (args[i] === '--version') opts.projectVersion = args[++i];
        else if (args[i] === '--include-dev') opts.includeDev = true;
      }
      const r = generate(opts);
      console.log(`[cobolt-sbom] CycloneDX 1.5: ${r.paths.cdx}`);
      console.log(`[cobolt-sbom] SPDX 2.3:     ${r.paths.spdx}`);
      console.log(`[cobolt-sbom] Components:   ${r.componentCount}`);
      console.log(`[cobolt-sbom] Ecosystems:   ${r.ecosystems.join(', ') || '(none — root-only SBOM)'}`);
      if (r.ledgerEntryId) console.log(`[cobolt-sbom] Ledger entry: ${r.ledgerEntryId}`);
      process.exit(0);
    } catch (err) {
      console.error(`[cobolt-sbom] generate failed: ${err.message}`);
      process.exit(1);
    }
  }

  const options = {};
  let projectDir = process.cwd();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--format' && args[i + 1]) {
      options.format = args[++i];
    } else if (args[i] === '--save') {
      options.save = true;
    } else if (args[i] === '--output' && args[i + 1]) {
      options.output = args[++i];
    } else if (args[i] === '--quiet-json') {
      options.quietJson = true;
    } else if (args[i] === '--silent') {
      options.silent = true;
    } else if (args[i] === '--fail-on-empty') {
      options.failOnEmpty = true;
    } else if (args[i] === '--include-dev') {
      options.includeDev = true;
    } else if (args[i] === '--help') {
      console.log('  Usage: node tools/cobolt-sbom.js [project-path] [--format json|cyclonedx|markdown]');
      console.log('                                 [--output <path>] [--save] [--include-dev]');
      console.log('                                 [--silent] [--quiet-json] [--fail-on-empty]');
      process.exit(0);
    } else if (!args[i].startsWith('--')) {
      projectDir = path.resolve(args[i]);
    }
  }

  try {
    const gen = new SBOMGenerator(projectDir);
    gen.scan(options);

    if (options.failOnEmpty && gen.components.length === 0) {
      console.error('  SBOM empty — no components discovered (--fail-on-empty)');
      process.exit(1);
    }

    const wantsMarkdown = options.format === 'markdown';
    const outputContent = wantsMarkdown ? gen.toMarkdown() : JSON.stringify(gen.toBOM(), null, 2);
    const silent = options.silent === true;
    const quietBanner = silent || options.quietJson || !wantsMarkdown;

    if (!quietBanner) {
      console.log(`\n  SBOM: ${gen.components.length} components found\n`);
    }
    if (!silent) {
      console.log(outputContent);
    }

    if (options.output) {
      writeOutput(options.output, `${outputContent}\n`);
    }

    if (options.save) {
      const paths = gen.save();
      if (!silent && !quietBanner) {
        console.log(`  Saved: ${paths.json}`);
        console.log(`  Saved: ${paths.md}`);
      }
    }

    process.exit(0);
  } catch (err) {
    console.error(`  SBOM generation failed: ${err.message}`);
    process.exit(1);
  }
}
