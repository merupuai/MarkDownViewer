#!/usr/bin/env node

// CoBolt Fix Surface Gates
//
// Classifies changed/touched files into high-risk SDLC surfaces and emits the
// extra evidence checks required before a fix can be released.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_OUTPUT_DIR = path.join('_cobolt-output', 'latest', 'fix');

const SURFACE_RULES = [
  {
    type: 'dependency-manifest',
    reason: 'dependency or lockfile change',
    checks: ['sbom', 'dependency-health', 'vulnerability-scan'],
    match: (file) =>
      /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|package\.json|requirements\.txt|pyproject\.toml|poetry\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|Gemfile|Gemfile\.lock|mix\.exs|mix\.lock)$/u.test(
        file,
      ),
  },
  {
    type: 'container-infra',
    reason: 'container, helm, kubernetes, or infrastructure change',
    checks: ['container-scan', 'cis-benchmark', 'rollback-smoke'],
    match: (file) =>
      /(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml|compose\.ya?ml)$/iu.test(file) ||
      /(^|\/)(helm|charts|k8s|kubernetes|infra|terraform)\//iu.test(file) ||
      /\.(tf|hcl)$/iu.test(file),
  },
  {
    type: 'ci-supply-chain',
    reason: 'CI or release automation change',
    checks: ['ci-dry-run', 'provenance-check'],
    match: (file) =>
      /(^|\/)(\.github\/workflows|\.gitlab-ci\.ya?ml|Jenkinsfile|azure-pipelines\.ya?ml|circle\.yml|buildkite\.ya?ml)/iu.test(
        file,
      ),
  },
  {
    type: 'secrets-config',
    reason: 'secret, environment, or runtime configuration change',
    checks: ['entropy-scan', 'config-diff-review'],
    match: (file) =>
      /(^|\/)(\.env|\.env\.[^/]+|secrets?|config|configs?|settings|appsettings)(\/|\.|$)/iu.test(file) ||
      /\.(ya?ml|toml|ini|properties)$/iu.test(file),
  },
  {
    type: 'auth-crypto',
    reason: 'authentication, authorization, session, token, or crypto change',
    checks: ['security-retest', 'crypto-posture'],
    match: (file) =>
      /(^|\/|[-_])(auth|authz|rbac|permission|policy|crypto|jwt|oauth|session|token|password)(\/|[-_.]|$)/iu.test(file),
  },
  {
    type: 'api-contract',
    reason: 'API route, controller, schema, contract, or GraphQL change',
    checks: ['contract-replay'],
    match: (file) => /(^|\/)(api|routes?|controllers?|graphql|openapi|schema|contracts?)(\/|[-_.]|$)/iu.test(file),
  },
  {
    type: 'data-migration',
    reason: 'database, query, model, repository, or migration change',
    checks: ['migration-integrity'],
    match: (file) => /(^|\/)(db|database|migrations?|models?|repositories?|queries)(\/|[-_.]|$)/iu.test(file),
  },
  {
    type: 'frontend-user-flow',
    reason: 'user-facing page, component, style, or UI flow change',
    checks: ['browser-smoke', 'uat-regression'],
    match: (file) => /(^|\/)(app|pages|screens|views|components|ui|styles|public)(\/|[-_.]|$)/iu.test(file),
  },
];

function normalizeFile(file) {
  return String(file || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//u, '')
    .trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function readJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function parseArgs(argv) {
  const out = {
    outputDir: DEFAULT_OUTPUT_DIR,
    evidenceDir: null,
    files: [],
    json: false,
    allowPending: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output-dir') out.outputDir = argv[++index] || out.outputDir;
    else if (arg === '--evidence-dir') out.evidenceDir = argv[++index] || null;
    else if (arg === '--file') out.files.push(argv[++index]);
    else if (arg === '--files') out.files.push(...String(argv[++index] || '').split(/[,\s]+/u));
    else if (arg === '--json') out.json = true;
    else if (arg === '--allow-pending') out.allowPending = true;
    else if (arg.startsWith('--')) out.unknown = arg;
    else out.files.push(arg);
  }
  return out;
}

function gitChangedFiles() {
  const result = spawnSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/u).map(normalizeFile).filter(Boolean);
}

function evidencePathFor(evidenceDir, checkId) {
  return path.join(evidenceDir, `${checkId}.json`);
}

function classifyFiles(files) {
  const normalizedFiles = unique(files.map(normalizeFile));
  const surfaces = [];
  for (const rule of SURFACE_RULES) {
    const matchedFiles = normalizedFiles.filter((file) => rule.match(file));
    if (matchedFiles.length > 0) {
      surfaces.push({
        surfaceId: `SURF-${String(surfaces.length + 1).padStart(3, '0')}`,
        type: rule.type,
        reason: rule.reason,
        files: matchedFiles,
        requiredChecks: rule.checks,
      });
    }
  }
  const requiredCheckIds = unique(surfaces.flatMap((surface) => surface.requiredChecks));
  return { files: normalizedFiles, surfaces, requiredCheckIds };
}

function buildSurfaceGatePlan(files, options = {}) {
  const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
  const evidenceDir = options.evidenceDir || path.join(outputDir, 'surface-gate-evidence');
  const { files: changedFiles, surfaces, requiredCheckIds } = classifyFiles(files);
  const requiredChecks = requiredCheckIds.map((checkId) => {
    const evidencePath = evidencePathFor(evidenceDir, checkId);
    const evidencePresent = fs.existsSync(evidencePath);
    const evidence = readJson(evidencePath);
    const evidencePassed = evidencePresent ? evidence?.passed !== false && evidence?.status !== 'fail' : false;
    return {
      checkId,
      evidencePath,
      evidencePresent,
      status: evidencePresent && evidencePassed ? 'pass' : evidencePresent ? 'fail' : 'pending',
    };
  });
  const missingEvidence = requiredChecks.filter((check) => check.status !== 'pass').map((check) => check.checkId);
  const status =
    surfaces.length === 0
      ? 'not_applicable'
      : missingEvidence.length === 0
        ? 'pass'
        : options.allowPending
          ? 'pending'
          : 'fail';
  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-fix-surface-gates',
    status,
    changedFiles,
    surfaces,
    requiredChecks,
    missingEvidence,
  };
}

function runPlan(options = {}) {
  const files = options.files && options.files.length > 0 ? options.files : gitChangedFiles();
  const plan = buildSurfaceGatePlan(files, { ...options, allowPending: true });
  writeJson(path.join(options.outputDir || DEFAULT_OUTPUT_DIR, 'fix-touched-surface-gates.json'), plan);
  return plan;
}

function runCheck(options = {}) {
  const files = options.files && options.files.length > 0 ? options.files : gitChangedFiles();
  const plan = buildSurfaceGatePlan(files, options);
  writeJson(path.join(options.outputDir || DEFAULT_OUTPUT_DIR, 'fix-touched-surface-gates.json'), plan);
  return plan;
}

function printUsage() {
  console.log(`
CoBolt Fix Surface Gates

Usage:
  node tools/cobolt-fix-surface-gates.js plan [--file <path> ...] [--output-dir <dir>] [--json]
  node tools/cobolt-fix-surface-gates.js check [--file <path> ...] [--output-dir <dir>] [--evidence-dir <dir>] [--json]
`);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  if (!command || command === '--help' || options.unknown) {
    printUsage();
    return options.unknown ? 2 : 0;
  }
  const result = command === 'plan' ? runPlan(options) : command === 'check' ? runCheck(options) : null;
  if (!result) {
    printUsage();
    return 2;
  }
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`[cobolt-fix-surface-gates] ${result.status}; ${result.surfaces.length} surface(s)`);
  return result.status === 'fail' ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  SURFACE_RULES,
  buildSurfaceGatePlan,
  classifyFiles,
  runCheck,
  runPlan,
};
