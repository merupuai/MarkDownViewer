#!/usr/bin/env node

// CoBolt Artifact Provenance - stamp/check generated artifact lineage metadata.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MARKER_START = '<!-- COBOLT_PROVENANCE';
const MARKER_END = '-->';

function sha256File(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function normalizeRel(projectRoot, filePath) {
  if (!filePath) return null;
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  return path.relative(projectRoot, fullPath).replaceAll('\\', '/');
}

function buildProvenance(projectRoot, options = {}) {
  const artifactPath = options.artifactPath || options.path;
  const inputPaths = Array.isArray(options.inputPaths) ? options.inputPaths : [];
  return {
    schema: 'cobolt-artifact-provenance/v1',
    producedBy: options.producedBy || 'unknown',
    runId: options.runId || null,
    milestone: options.milestone || null,
    artifactPath: normalizeRel(projectRoot, artifactPath),
    canonicalPath: normalizeRel(projectRoot, options.canonicalPath || artifactPath),
    artifactHash: sha256File(path.isAbsolute(artifactPath) ? artifactPath : path.join(projectRoot, artifactPath)),
    inputHashes: inputPaths.map((inputPath) => {
      const fullPath = path.isAbsolute(inputPath) ? inputPath : path.join(projectRoot, inputPath);
      return {
        path: normalizeRel(projectRoot, fullPath),
        sha256: sha256File(fullPath),
      };
    }),
    generatedAt: new Date().toISOString(),
  };
}

function markdownHeader(provenance) {
  return `${MARKER_START}\n${JSON.stringify(provenance, null, 2)}\n${MARKER_END}\n`;
}

function stripMarkdownProvenance(content) {
  const start = content.indexOf(MARKER_START);
  if (start !== 0) return content;
  const end = content.indexOf(MARKER_END, start);
  if (end === -1) return content;
  return content.slice(end + MARKER_END.length).replace(/^\r?\n/, '');
}

function stampArtifact(projectRoot, artifactPath, options = {}) {
  const fullPath = path.isAbsolute(artifactPath) ? artifactPath : path.join(projectRoot, artifactPath);
  if (!fs.existsSync(fullPath)) throw new Error(`Artifact not found: ${fullPath}`);

  const provenance = buildProvenance(projectRoot, {
    ...options,
    artifactPath: fullPath,
    canonicalPath: options.canonicalPath || fullPath,
  });

  const ext = path.extname(fullPath).toLowerCase();
  if (ext === '.json') {
    const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    parsed._coboltProvenance = provenance;
    fs.writeFileSync(fullPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  } else {
    const existing = fs.readFileSync(fullPath, 'utf8');
    fs.writeFileSync(fullPath, `${markdownHeader(provenance)}${stripMarkdownProvenance(existing)}`, 'utf8');
  }

  return provenance;
}

function readProvenance(artifactPath) {
  if (!fs.existsSync(artifactPath)) return null;
  const ext = path.extname(artifactPath).toLowerCase();
  const content = fs.readFileSync(artifactPath, 'utf8');
  if (ext === '.json') {
    try {
      return JSON.parse(content)._coboltProvenance || null;
    } catch {
      return null;
    }
  }

  if (!content.startsWith(MARKER_START)) return null;
  const end = content.indexOf(MARKER_END);
  if (end === -1) return null;
  try {
    return JSON.parse(content.slice(MARKER_START.length, end).trim());
  } catch {
    return null;
  }
}

function checkArtifactProvenance(projectRoot = process.cwd(), artifactPaths = [], options = {}) {
  const issues = [];
  const artifacts = [];

  for (const artifactPath of artifactPaths) {
    const fullPath = path.isAbsolute(artifactPath) ? artifactPath : path.join(projectRoot, artifactPath);
    const provenance = readProvenance(fullPath);
    artifacts.push({ path: normalizeRel(projectRoot, fullPath), hasProvenance: Boolean(provenance), provenance });
    if (!provenance) {
      issues.push(`${normalizeRel(projectRoot, fullPath)} is missing CoBolt provenance metadata.`);
      continue;
    }
    if (options.requireCanonical && provenance.canonicalPath !== normalizeRel(projectRoot, fullPath)) {
      issues.push(
        `${normalizeRel(projectRoot, fullPath)} provenance canonicalPath=${provenance.canonicalPath} does not match actual path.`,
      );
    }
  }

  return {
    passed: issues.length === 0,
    issues,
    artifacts,
  };
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'check';
  const json = argv.includes('--json');
  const fileIndex = argv.indexOf('--file');
  const filePath = fileIndex !== -1 ? argv[fileIndex + 1] : argv[1];

  if (!filePath) {
    console.error('Usage: node tools/cobolt-artifact-provenance.js <stamp|check> --file <path> [--json]');
    process.exit(2);
  }

  if (command === 'stamp') {
    const producedByIndex = argv.indexOf('--produced-by');
    const provenance = stampArtifact(process.cwd(), filePath, {
      producedBy: producedByIndex !== -1 ? argv[producedByIndex + 1] : 'manual',
    });
    if (json) console.log(JSON.stringify(provenance, null, 2));
    else console.log(`[cobolt-artifact-provenance] Stamped ${filePath}`);
    return;
  }

  if (command === 'check') {
    const report = checkArtifactProvenance(process.cwd(), [filePath], { requireCanonical: argv.includes('--strict') });
    if (json) console.log(JSON.stringify(report, null, 2));
    else if (report.passed) console.log('[cobolt-artifact-provenance] Provenance check passed.');
    else for (const issue of report.issues) console.error(`[cobolt-artifact-provenance] ${issue}`);
    process.exit(report.passed ? 0 : 1);
  }

  console.error('Usage: node tools/cobolt-artifact-provenance.js <stamp|check> --file <path> [--json]');
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildProvenance,
  checkArtifactProvenance,
  readProvenance,
  stampArtifact,
  stripMarkdownProvenance,
};
