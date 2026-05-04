#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { atomicWriteJSON } = require('../lib/cobolt-atomic-write');

const FRAMEWORKS = Object.freeze({
  'soc2-type2': [
    'docs/TELEMETRY.md',
    'docs/SUPPORT.md',
    'docs/GOVERNANCE.md',
    '_cobolt-output/reports/public-claims.json',
  ],
  iso27001: ['docs/TELEMETRY.md', 'docs/GOVERNANCE.md', '_cobolt-output/release/provenance/latest.intoto.json'],
  iso27017: ['docs/TELEMETRY.md', '_cobolt-output/reports/enterprise-readiness/airgap-verify.json'],
  hipaa: ['docs/TELEMETRY.md', 'docs/SUPPORT.md', '_cobolt-output/audit/gate-bypass-ledger.jsonl'],
  'fedramp-low': [
    'docs/AIR-GAPPED-INSTALL.md',
    'docs/TELEMETRY.md',
    '_cobolt-output/release/install-trust/latest.json',
  ],
  'pci-dss-saq-d': ['docs/TELEMETRY.md', '_cobolt-output/release/provenance/latest.intoto.json'],
});

function argValue(args, name, fallback = null) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] || fallback : fallback;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function safeCopy(root, rel, destDir) {
  const src = path.join(root, rel);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return null;
  const target = path.join(destDir, rel.replace(/[\\/]/g, '__'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(src, target);
  return target;
}

function buildEvidencePack(root = process.cwd(), framework = 'soc2-type2', options = {}) {
  const required = FRAMEWORKS[framework];
  if (!required) throw new Error(`Unknown framework "${framework}". Known: ${Object.keys(FRAMEWORKS).join(', ')}`);
  const outDir = path.resolve(options.output || path.join(root, '_cobolt-output', 'evidence-packs', framework));
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

  const artifacts = required.map((rel) => {
    const target = safeCopy(root, rel, outDir);
    return {
      id: rel.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      source: rel,
      target: target ? path.relative(root, target).replace(/\\/g, '/') : null,
      status: target ? 'included' : 'missing',
      sha256: target ? sha256File(target) : null,
      required: true,
    };
  });

  const manifest = {
    schema: 'cobolt-evidence-pack@1',
    framework,
    generatedAt: new Date().toISOString(),
    artifacts,
    summary: {
      required: artifacts.length,
      included: artifacts.filter((a) => a.status === 'included').length,
      missing: artifacts.filter((a) => a.status === 'missing').length,
    },
  };
  atomicWriteJSON(path.join(outDir, 'manifest.json'), manifest, { mode: 0o600 });
  fs.writeFileSync(path.join(outDir, 'index.md'), renderIndex(manifest), 'utf8');
  return { outDir, manifest };
}

function renderIndex(manifest) {
  const lines = [
    `# CoBolt Evidence Pack: ${manifest.framework}`,
    '',
    `Generated: ${manifest.generatedAt}`,
    '',
    '| Artifact | Status | SHA-256 |',
    '| --- | --- | --- |',
  ];
  for (const artifact of manifest.artifacts) {
    lines.push(`| ${artifact.source} | ${artifact.status} | ${artifact.sha256 || ''} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function cmdPack(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const framework = argValue(args, '--framework', args[0] || 'soc2-type2');
  const output = argValue(args, '--output');
  const result = buildEvidencePack(root, framework, { output });
  console.log(
    JSON.stringify({ schema: 'cobolt-evidence-pack-result@1', outputDir: result.outDir, ...result.manifest }, null, 2),
  );
  return result.manifest.summary.missing === 0 ? 0 : 1;
}

function cmdList() {
  console.log(Object.keys(FRAMEWORKS).join('\n'));
  return 0;
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0] || 'pack';
  const args = argv.slice(1);
  if (cmd === 'pack' || cmd === 'generate') return cmdPack(args);
  if (cmd === 'list') return cmdList();
  console.log('Usage: node tools/cobolt-evidence-pack.js pack <framework>|list');
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { FRAMEWORKS, buildEvidencePack, main };
