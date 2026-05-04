const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { resolveReadablePlanningDir, safeReadJson } = require('../../lib/cobolt-planning-artifacts');

const ROOT = path.resolve(__dirname, '..', '..');
const TAXONOMY_CONFIG_PATH = path.join(ROOT, 'source', 'config', 'plan-review-taxonomy.json');
const TAXONOMY_SCHEMA_PATH = path.join(ROOT, 'source', 'schemas', 'plan-review-taxonomy.schema.json');
const FINDING_SCHEMA_PATH = path.join(ROOT, 'source', 'schemas', 'plan-review-detector.schema.json');
const REPORT_SCHEMA_PATH = path.join(ROOT, 'source', 'schemas', 'plan-review-report.schema.json');
const PHASE_ARTIFACTS_PATH = path.join(ROOT, 'source', 'schemas', 'plan-phase-artifacts.json');
const ARTIFACT_DEPENDENCIES_PATH = path.join(ROOT, 'source', 'schemas', 'artifact-dependencies.json');

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

function readJson(filePath) {
  return safeReadJson(filePath);
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function ensurePlanningDir(projectRoot) {
  const planningDir = resolveReadablePlanningDir(projectRoot, { allowLatestFallback: true });
  let readable = false;
  try {
    readable = Boolean(planningDir && fs.existsSync(planningDir) && fs.statSync(planningDir).isDirectory());
  } catch {
    readable = false;
  }
  if (!readable) {
    throw new Error(`No readable planning directory found under ${projectRoot}`);
  }
  return planningDir;
}

function relativeToPlanning(planningDir, filePath) {
  return toPosix(path.relative(planningDir, filePath));
}

function listPlanningFiles(planningDir, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 6;
  const includeHidden = options.includeHidden === true;
  const files = [];

  function walk(currentDir, depthLeft) {
    if (depthLeft < 0) return;
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith('.')) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depthLeft - 1);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  walk(planningDir, maxDepth);
  return files.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function listRootPlanningFiles(planningDir) {
  try {
    return fs
      .readdirSync(planningDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(planningDir, entry.name))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

function loadPlanPhaseArtifacts() {
  const parsed = readJson(PHASE_ARTIFACTS_PATH);
  if (!parsed?.phases) throw new Error(`Missing plan-phase artifact contract: ${PHASE_ARTIFACTS_PATH}`);
  return parsed;
}

function loadArtifactDependencies() {
  const parsed = readJson(ARTIFACT_DEPENDENCIES_PATH);
  if (!parsed?.artifacts) throw new Error(`Missing artifact dependency contract: ${ARTIFACT_DEPENDENCIES_PATH}`);
  return parsed;
}

function loadState(projectRoot) {
  return readJson(path.join(projectRoot, 'cobolt-state.json')) || {};
}

function planningFlagsFromState(state) {
  const planning = state?.planning || {};
  const pipeline = state?.pipeline || {};
  return {
    auto: Boolean(planning.auto || planning.autonomous || pipeline.autonomous || pipeline.mode === 'autonomous'),
    enhance: Boolean(planning.enhance || planning.enhanced || planning.day2Enhanced),
    brownfield: Boolean(state?.brownfield || pipeline.stage === 'brownfield'),
  };
}

function createFinding(fields = {}) {
  return {
    classId: String(fields.classId || '').trim(),
    severity: fields.severity || 'advisory',
    artifact: String(fields.artifact || '').trim(),
    evidence: fields.evidence ?? {},
    remediationHint: String(fields.remediationHint || '').trim(),
    detectorId: String(fields.detectorId || '').trim(),
    ...(fields.title ? { title: String(fields.title) } : {}),
    ...(fields.details ? { details: fields.details } : {}),
  };
}

function severityRank(severity) {
  if (severity === 'critical') return 3;
  if (severity === 'advisory') return 2;
  return 1;
}

function dedupeFindings(findings) {
  const byKey = new Map();
  for (const finding of findings || []) {
    const key = JSON.stringify([
      finding.classId,
      finding.detectorId,
      finding.artifact,
      typeof finding.evidence === 'string' ? finding.evidence : JSON.stringify(finding.evidence || {}),
    ]);
    const existing = byKey.get(key);
    if (!existing || severityRank(finding.severity) > severityRank(existing.severity)) {
      byKey.set(key, finding);
    }
  }
  return [...byKey.values()].sort((left, right) => {
    if (severityRank(right.severity) !== severityRank(left.severity)) {
      return severityRank(right.severity) - severityRank(left.severity);
    }
    return `${left.classId}:${left.artifact}`.localeCompare(`${right.classId}:${right.artifact}`, undefined, {
      numeric: true,
    });
  });
}

function normalizeContentForSimilarity(content) {
  return new Set(
    String(content || '')
      .split(/\r?\n/u)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length >= 24 && !line.startsWith('#') && !line.startsWith('|')),
  );
}

function jaccardSimilarity(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  const union = new Set([...left, ...right]);
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  return union.size === 0 ? 0 : intersection / union.size;
}

function shannonEntropy(text) {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) return 0;
  const counts = new Map();
  for (const char of value) {
    counts.set(char, (counts.get(char) || 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function parseMarkdownSections(content) {
  const text = String(content || '');
  const matches = [...text.matchAll(/^##+\s+(.+?)\s*$/gim)];
  if (matches.length === 0) return [];
  const sections = [];
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index + matches[index][0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    sections.push({
      heading: matches[index][1].trim(),
      body: text.slice(start, end).trim(),
    });
  }
  return sections;
}

function contentDigest(content) {
  return crypto
    .createHash('sha256')
    .update(String(content || ''))
    .digest('hex');
}

function fileDigest(filePath) {
  try {
    return contentDigest(fs.readFileSync(filePath));
  } catch {
    return null;
  }
}

function computeFingerprint(projectRoot, planningDir, selector) {
  const rows = [];
  for (const filePath of listPlanningFiles(planningDir, { maxDepth: 6 })) {
    if (!selector(filePath)) continue;
    try {
      const stat = fs.statSync(filePath);
      rows.push({
        path: relativeToPlanning(planningDir, filePath),
        bytes: stat.size,
        sha256: fileDigest(filePath),
      });
    } catch {
      /* ignore transient file */
    }
  }
  rows.sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
  return contentDigest(JSON.stringify({ projectRoot: toPosix(projectRoot), rows }));
}

function calculateFingerprints(projectRoot, planningDir) {
  const planningFingerprint = computeFingerprint(projectRoot, planningDir, (filePath) => {
    const base = path.basename(filePath);
    return base !== 'plan-review-verdict.json';
  });
  const inputFingerprint = computeFingerprint(projectRoot, planningDir, (filePath) => {
    const base = path.basename(filePath);
    return ['prd.md', 'executable-prd.json', 'prd-day2-addendum.md', 'source-intake.json'].includes(base);
  });
  return { planningFingerprint, inputFingerprint };
}

function newestPlanningArtifactMtime(planningDir, options = {}) {
  const excluded = new Set((options.excludeRelativePaths || []).map((entry) => toPosix(entry)));
  let newest = 0;
  for (const filePath of listPlanningFiles(planningDir, { maxDepth: 6 })) {
    const relativePath = relativeToPlanning(planningDir, filePath);
    if (excluded.has(relativePath)) continue;
    try {
      newest = Math.max(newest, fs.statSync(filePath).mtimeMs);
    } catch {
      /* ignore transient file */
    }
  }
  return newest;
}

function loadAjv() {
  try {
    const Ajv2020 = require('ajv/dist/2020');
    const addFormats = require('ajv-formats');
    const Ajv = Ajv2020.default || Ajv2020;
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    return ajv;
  } catch {
    return null;
  }
}

function validateWithSchema(schemaPath, data, extraSchemaPaths = []) {
  const ajv = loadAjv();
  if (!ajv) return { ok: true, errors: [] };
  try {
    for (const extraSchemaPath of extraSchemaPaths) {
      const extraSchema = readJson(extraSchemaPath);
      if (extraSchema) ajv.addSchema(extraSchema);
    }
    const schema = readJson(schemaPath);
    if (!schema) {
      return { ok: false, errors: [`missing schema: ${schemaPath}`] };
    }
    const validate = ajv.compile(schema);
    const ok = validate(data);
    return {
      ok: Boolean(ok),
      errors: (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message}`),
    };
  } catch (err) {
    return { ok: false, errors: [String(err.message || err)] };
  }
}

function loadTaxonomyConfig() {
  const taxonomy = readJson(TAXONOMY_CONFIG_PATH);
  if (!taxonomy?.classes) {
    throw new Error(`Missing taxonomy config: ${TAXONOMY_CONFIG_PATH}`);
  }
  const validation = validateWithSchema(TAXONOMY_SCHEMA_PATH, taxonomy);
  if (!validation.ok) {
    throw new Error(`Invalid taxonomy config: ${validation.errors.join('; ')}`);
  }
  return {
    ...taxonomy,
    classById: new Map((taxonomy.classes || []).map((entry) => [entry.id, entry])),
  };
}

module.exports = {
  ROOT,
  TAXONOMY_CONFIG_PATH,
  TAXONOMY_SCHEMA_PATH,
  FINDING_SCHEMA_PATH,
  REPORT_SCHEMA_PATH,
  PHASE_ARTIFACTS_PATH,
  ARTIFACT_DEPENDENCIES_PATH,
  toPosix,
  readJson,
  readText,
  ensurePlanningDir,
  relativeToPlanning,
  listPlanningFiles,
  listRootPlanningFiles,
  loadPlanPhaseArtifacts,
  loadArtifactDependencies,
  loadState,
  planningFlagsFromState,
  createFinding,
  severityRank,
  dedupeFindings,
  normalizeContentForSimilarity,
  jaccardSimilarity,
  shannonEntropy,
  parseMarkdownSections,
  contentDigest,
  fileDigest,
  calculateFingerprints,
  newestPlanningArtifactMtime,
  validateWithSchema,
  loadTaxonomyConfig,
};
