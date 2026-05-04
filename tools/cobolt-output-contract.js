#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const { CoboltPaths } = require('../lib/cobolt-paths');

const SOURCE_FILE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.md', '.json', '.yml', '.yaml', '.sh', '.ex']);
const SOURCE_SCAN_SKIP_DIRS = new Set([
  '.git',
  '.claude',
  '.codex',
  '_cobolt-output',
  'node_modules',
  'dist',
  'vendor',
]);
const DEPRECATED_LATEST_STAGE_ALIASES = Object.freeze({
  plan: 'planning',
});

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    check: false,
    json: false,
    rootDir: process.cwd(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') options.check = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--root') {
      options.rootDir = path.resolve(argv[++i] || options.rootDir);
    } else if (arg.startsWith('--root=')) {
      options.rootDir = path.resolve(arg.slice('--root='.length));
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function finding(code, message, filePath = null, severity = 'error') {
  return { code, severity, message, path: filePath };
}

function safeReadJson(filePath) {
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function resolvePointerTarget(pointerValue, outputRoot) {
  if (!pointerValue) return null;
  const raw = pointerValue.trim();
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(outputRoot, raw);
}

function validateLatest(outputRoot, findings) {
  const latestPath = path.join(outputRoot, 'latest');
  const pointerPath = path.join(outputRoot, 'latest.ptr');
  const latestExists = fs.existsSync(latestPath);
  const pointerExists = fs.existsSync(pointerPath);

  if (!latestExists && !pointerExists) {
    return { latestExists, pointerExists, target: null };
  }

  let target = null;
  if (pointerExists) {
    let rawPointer = '';
    try {
      rawPointer = fs.readFileSync(pointerPath, 'utf8');
      target = resolvePointerTarget(rawPointer, outputRoot);
      if (!target || !fs.existsSync(target)) {
        findings.push(
          finding('BROKEN_LATEST_PTR', `latest.ptr points to a missing target: ${rawPointer.trim()}`, pointerPath),
        );
      }
    } catch (err) {
      findings.push(finding('UNREADABLE_LATEST_PTR', `Cannot read latest.ptr: ${err.message}`, pointerPath));
    }
  }

  if (latestExists) {
    try {
      const stat = fs.lstatSync(latestPath);
      if (stat.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(latestPath);
        const resolved = path.isAbsolute(linkTarget) ? linkTarget : path.resolve(outputRoot, linkTarget);
        if (!fs.existsSync(resolved)) {
          findings.push(
            finding(
              'BROKEN_LATEST_LINK',
              `latest symlink/junction points to a missing target: ${linkTarget}`,
              latestPath,
            ),
          );
        }
      } else if (!stat.isDirectory()) {
        findings.push(finding('INVALID_LATEST_PATH', 'latest must be a directory or symlink/junction', latestPath));
      }
    } catch (err) {
      findings.push(finding('UNREADABLE_LATEST_PATH', `Cannot inspect latest: ${err.message}`, latestPath));
    }
  }

  return { latestExists, pointerExists, target };
}

function validateRunDirectories(outputRoot, findings) {
  const runsRoot = path.join(outputRoot, 'runs');
  if (!fs.existsSync(runsRoot)) return;

  for (const day of fs.readdirSync(runsRoot, { withFileTypes: true })) {
    if (!day.isDirectory()) continue;
    const dayPath = path.join(runsRoot, day.name);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.name)) {
      findings.push(finding('INVALID_RUN_DATE_DIR', `Run date directory must be YYYY-MM-DD: ${day.name}`, dayPath));
      continue;
    }
    for (const run of fs.readdirSync(dayPath, { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      const runPath = path.join(dayPath, run.name);
      if (!/^run-\d{3}$/.test(run.name)) {
        findings.push(finding('INVALID_RUN_DIR', `Run directory must be run-NNN: ${day.name}/${run.name}`, runPath));
      }
    }
  }
}

function validateReports(outputRoot, findings) {
  const reportsRoot = path.join(outputRoot, 'reports');
  if (!fs.existsSync(reportsRoot)) return;

  for (const entry of fs.readdirSync(reportsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const reportDir = path.join(reportsRoot, entry.name);
    const containsMilestoneReport =
      fs.existsSync(path.join(reportDir, 'milestone-report.md')) ||
      fs.existsSync(path.join(reportDir, 'milestone-report.json')) ||
      fs.readdirSync(reportDir).some((file) => /^M\d+-/.test(file) || /milestone/i.test(file));
    if (containsMilestoneReport && !/^M\d+$/.test(entry.name)) {
      findings.push(
        finding(
          'INVALID_MILESTONE_REPORT_DIR',
          `Milestone report directory must be named M{n}: ${entry.name}`,
          reportDir,
        ),
      );
    }
  }
}

function validatePlanningDir(latestPath, findings) {
  if (!latestPath || !fs.existsSync(latestPath)) return;
  const planningDir = path.join(latestPath, 'planning');
  if (fs.existsSync(planningDir) && !fs.statSync(planningDir).isDirectory()) {
    findings.push(finding('INVALID_PLANNING_PATH', 'latest/planning must be a directory when present', planningDir));
  }
}

function validateDeprecatedLatestStageDirs(latestPath, findings) {
  if (!latestPath || !fs.existsSync(latestPath)) return;
  for (const [alias, canonical] of Object.entries(DEPRECATED_LATEST_STAGE_ALIASES)) {
    const aliasPath = path.join(latestPath, alias);
    if (!fs.existsSync(aliasPath)) continue;
    findings.push(
      finding(
        'DEPRECATED_LATEST_STAGE_DIR',
        `Use _cobolt-output/latest/${canonical}/ instead of deprecated _cobolt-output/latest/${alias}/`,
        aliasPath,
      ),
    );
  }
}

function walkJsonFiles(dir, result = []) {
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonFiles(full, result);
    else if (entry.isFile() && entry.name.endsWith('.json')) result.push(full);
  }
  return result;
}

function walkSourceFiles(dir, result = []) {
  if (!fs.existsSync(dir)) return result;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (SOURCE_SCAN_SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(full, result);
    } else if (entry.isFile() && SOURCE_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      result.push(full);
    }
  }
  return result;
}

function lineNumberForOffset(text, offset) {
  return text.slice(0, offset).split(/\r?\n/u).length;
}

function validateDeprecatedStageAliasesInSource(rootDir, findings) {
  const pattern = /_cobolt-output[\\/]+latest[\\/]+([A-Za-z0-9._-]+)(?=[\\/]+)/gu;

  for (const sourcePath of walkSourceFiles(rootDir)) {
    let content = '';
    try {
      content = fs.readFileSync(sourcePath, 'utf8');
    } catch {
      continue;
    }

    for (const match of content.matchAll(pattern)) {
      const alias = match[1];
      const canonical = DEPRECATED_LATEST_STAGE_ALIASES[alias];
      if (!canonical) continue;
      const lineNumber = lineNumberForOffset(content, match.index || 0);
      findings.push(
        finding(
          'DEPRECATED_STAGE_ALIAS_REFERENCE',
          `Deprecated artifact stage alias "${alias}" at line ${lineNumber}; use _cobolt-output/latest/${canonical}/`,
          sourcePath,
        ),
      );
    }
  }
}

function loadArtifactDependencies(rootDir) {
  const depsPath = path.join(rootDir, 'source', 'schemas', 'artifact-dependencies.json');
  const parsed = safeReadJson(depsPath);
  if (!parsed.ok) return null;
  return { path: depsPath, data: parsed.data };
}

function primaryArtifactPath(artifact) {
  return artifact?.path || artifact?.pathPattern || artifact?.pathAlternate || '';
}

function validateBuildHandoffDependencies(rootDir, findings) {
  const loaded = loadArtifactDependencies(rootDir);
  if (!loaded) return;

  const deps = loaded.data || {};
  const build = deps.skills?.['cobolt-build'];
  const plan = deps.skills?.['cobolt-plan'];
  if (!build || !plan) return;

  const planProduces = new Set(plan.produces || []);

  for (const artifactId of build.requires || []) {
    const artifact = deps.artifacts?.[artifactId];
    if (!artifact) {
      findings.push(
        finding(
          'BUILD_ARTIFACT_DEFINITION_MISSING',
          `cobolt-build requires "${artifactId}", but artifact-dependencies.json has no artifact definition.`,
          loaded.path,
        ),
      );
      continue;
    }

    if (!planProduces.has(artifactId)) {
      findings.push(
        finding(
          'BUILD_ARTIFACT_NOT_PRODUCED_BY_PLAN',
          `cobolt-build requires "${artifactId}", but cobolt-plan.produces does not advertise it.`,
          loaded.path,
        ),
      );
    }

    const artifactPath = primaryArtifactPath(artifact).replaceAll('\\', '/');
    if (!artifactPath) {
      findings.push(
        finding(
          'BUILD_ARTIFACT_PATH_MISSING',
          `cobolt-build requires "${artifactId}", but it has no path, pathPattern, or pathAlternate.`,
          loaded.path,
        ),
      );
      continue;
    }

    if (artifact.category === 'planning' && !artifactPath.startsWith('_cobolt-output/latest/planning/')) {
      findings.push(
        finding(
          'BUILD_PLANNING_ARTIFACT_PATH_MISMATCH',
          `Build-required planning artifact "${artifactId}" must live under _cobolt-output/latest/planning/.`,
          loaded.path,
        ),
      );
    } else if (artifact.category === 'infra' && !artifactPath.startsWith('_cobolt-output/latest/infra/')) {
      findings.push(
        finding(
          'BUILD_INFRA_ARTIFACT_PATH_MISMATCH',
          `Build-required infra artifact "${artifactId}" must live under _cobolt-output/latest/infra/.`,
          loaded.path,
        ),
      );
    } else if (!['planning', 'infra'].includes(artifact.category)) {
      findings.push(
        finding(
          'BUILD_ARTIFACT_CATEGORY_UNSUPPORTED',
          `Build-required artifact "${artifactId}" has unsupported category "${artifact.category || '(missing)'}".`,
          loaded.path,
        ),
      );
    }
  }
}

function loadSchemaValidators(rootDir) {
  const schemasDir = path.join(rootDir, 'source', 'schemas');
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false, logger: false });
  const validators = new Map();
  if (!fs.existsSync(schemasDir)) return validators;

  for (const entry of fs.readdirSync(schemasDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.schema.json')) continue;
    const schemaPath = path.join(schemasDir, entry.name);
    const parsed = safeReadJson(schemaPath);
    if (!parsed.ok) continue;
    const schemaKey = entry.name.replace(/\.schema\.json$/, '');
    try {
      validators.set(schemaKey, { schemaPath, validate: ajv.compile(parsed.data) });
    } catch {
      /* Existing schema errors are covered by schema tests; this validator only applies usable schemas. */
    }
  }
  return validators;
}

function schemaKeyForArtifact(fileName, validators) {
  const base = fileName.replace(/\.json$/, '');
  const candidates = [base, base.replace(/^M\d+-/, '')];
  for (const candidate of candidates) {
    if (validators.has(candidate)) return candidate;
  }
  return null;
}

function validateSchemaBackedArtifacts(rootDir, outputRoot, findings) {
  const validators = loadSchemaValidators(rootDir);
  if (validators.size === 0) return { validated: 0 };

  let validated = 0;
  const candidateRoots = [path.join(outputRoot, 'latest'), path.join(outputRoot, 'reports')].filter((dir) =>
    fs.existsSync(dir),
  );
  for (const candidateRoot of candidateRoots) {
    for (const jsonPath of walkJsonFiles(candidateRoot)) {
      const key = schemaKeyForArtifact(path.basename(jsonPath), validators);
      if (!key) continue;
      const parsed = safeReadJson(jsonPath);
      if (!parsed.ok) {
        findings.push(finding('INVALID_JSON', `Invalid JSON: ${parsed.error}`, jsonPath));
        continue;
      }
      const validator = validators.get(key);
      validated += 1;
      if (!validator.validate(parsed.data)) {
        findings.push(
          finding(
            'SCHEMA_VALIDATION_FAILED',
            `${path.basename(jsonPath)} failed ${path.basename(validator.schemaPath)}: ${ajvErrors(validator.validate.errors)}`,
            jsonPath,
          ),
        );
      }
    }
  }

  return { validated };
}

function ajvErrors(errors) {
  return (errors || []).map((err) => `${err.instancePath || '/'} ${err.message}`).join('; ') || 'unknown schema error';
}

function checkOutputContract(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const coboltPaths = new CoboltPaths(rootDir);
  const outputRoot = coboltPaths.outputRoot;
  const findings = [];
  validateDeprecatedStageAliasesInSource(rootDir, findings);
  validateBuildHandoffDependencies(rootDir, findings);

  if (!fs.existsSync(outputRoot)) {
    return {
      ok: findings.length === 0,
      status: findings.length === 0 ? 'NOT_INITIALIZED' : 'FAIL',
      outputRoot,
      findings,
      summary:
        findings.length === 0
          ? 'No _cobolt-output directory exists yet.'
          : `${findings.length} source artifact contract issue(s).`,
      schemaArtifactsValidated: 0,
    };
  }

  const latest = validateLatest(outputRoot, findings);
  validateRunDirectories(outputRoot, findings);
  validateReports(outputRoot, findings);
  validatePlanningDir(latest.target || path.join(outputRoot, 'latest'), findings);
  validateDeprecatedLatestStageDirs(latest.target || path.join(outputRoot, 'latest'), findings);
  const schemaResult = validateSchemaBackedArtifacts(rootDir, outputRoot, findings);

  return {
    ok: findings.length === 0,
    status: findings.length === 0 ? 'PASS' : 'FAIL',
    outputRoot,
    latest,
    findings,
    summary: findings.length === 0 ? 'Output contract is valid.' : `${findings.length} output contract issue(s).`,
    schemaArtifactsValidated: schemaResult.validated,
  };
}

function formatHuman(result) {
  if (result.ok) {
    return `Output contract: ${result.status}\n  ${result.summary}\n  Schema-backed artifacts validated: ${result.schemaArtifactsValidated}`;
  }
  return [
    `Output contract: ${result.status}`,
    ...result.findings.map((item) => `  - [${item.code}] ${item.message}${item.path ? ` (${item.path})` : ''}`),
  ].join('\n');
}

function printHelp() {
  console.log('Usage: node tools/cobolt-output-contract.js [--check] [--json] [--root <dir>]');
}

if (require.main === module) {
  try {
    const options = parseArgs();
    if (options.help) {
      printHelp();
      process.exit(0);
    }
    const result = checkOutputContract(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(formatHuman(result));
    process.exit(options.check && !result.ok ? 1 : 0);
  } catch (err) {
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ ok: false, status: 'ERROR', findings: [finding('ERROR', err.message)] }, null, 2));
    } else {
      console.error(err.message);
    }
    process.exit(1);
  }
}

module.exports = {
  checkOutputContract,
  formatHuman,
  parseArgs,
  resolvePointerTarget,
  schemaKeyForArtifact,
  validateBuildHandoffDependencies,
  validateDeprecatedStageAliasesInSource,
};
