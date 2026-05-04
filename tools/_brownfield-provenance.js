const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function getToolVersion() {
  try {
    return require('../package.json').version || null;
  } catch {
    return null;
  }
}

function getCommitSha(projectDir) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function uniqueExistingFiles(files) {
  return [...new Set((files || []).map((filePath) => path.resolve(filePath)))]
    .filter((filePath) => fs.existsSync(filePath))
    .sort();
}

function hashInputFiles(projectDir, files = []) {
  const normalized = uniqueExistingFiles(files).map((filePath) => {
    const stat = fs.statSync(filePath);
    return {
      path: path.relative(projectDir, filePath),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  });

  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function hashStructuredInput(data) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(data ?? null))
    .digest('hex');
}

function buildProvenance(projectDir, files = []) {
  const resolvedProjectDir = path.resolve(projectDir);
  return {
    sourcePath: resolvedProjectDir,
    commitSha: getCommitSha(resolvedProjectDir),
    inputArtifactsHash: hashInputFiles(resolvedProjectDir, files),
    toolVersion: getToolVersion(),
  };
}

module.exports = {
  buildProvenance,
  getCommitSha,
  getToolVersion,
  hashInputFiles,
  hashStructuredInput,
};
