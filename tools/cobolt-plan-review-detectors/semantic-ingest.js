const fs = require('node:fs');
const path = require('node:path');

const { createFinding, dedupeFindings, readJson } = require('./_shared');

const REQUIRED_SEMANTIC_REVIEWERS = [
  'plan-critic',
  'architecture-reviewer',
  'api-contract-reviewer',
  'schema-contract-reviewer',
  'policy-enforcer',
];

function semanticContractFinding(reviewer, evidence) {
  return createFinding({
    classId: 'E1',
    severity: 'critical',
    artifact: `semantic/${reviewer}.json`,
    evidence,
    remediationHint:
      'Run the required planning-scoped semantic reviewer and write normalized findings before build handoff.',
    detectorId: 'semantic-ingest',
  });
}

function normalizeSemanticFinding(raw, fileName) {
  if (!raw || typeof raw !== 'object') return null;
  const classId = String(raw.classId || '').trim();
  const artifact = String(raw.artifact || fileName || 'semantic-review').trim();
  if (!classId || !artifact) return null;
  return createFinding({
    classId,
    severity: raw.severity || 'advisory',
    artifact,
    evidence: raw.evidence || raw.summary || raw.message || `semantic finding from ${fileName}`,
    remediationHint: raw.remediationHint || 'Resolve the semantic planning inconsistency before build handoff.',
    detectorId: 'semantic-ingest',
    ...(raw.title ? { title: raw.title } : {}),
    ...(raw.details ? { details: raw.details } : {}),
  });
}

function run(context) {
  const findings = [];
  const semanticDir = context.paths.semanticDir;
  const requireSemanticReviewers = context.requireSemanticReviewers === true;
  if (!fs.existsSync(semanticDir)) {
    if (requireSemanticReviewers) {
      for (const reviewer of REQUIRED_SEMANTIC_REVIEWERS) {
        findings.push(semanticContractFinding(reviewer, 'Required semantic reviewer output is missing.'));
      }
    }
    return {
      detectorId: 'semantic-ingest',
      findings,
      metadata: { semanticDir, filesRead: 0 },
    };
  }

  const files = fs
    .readdirSync(semanticDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  const requiredReviewerSet = new Set(REQUIRED_SEMANTIC_REVIEWERS);
  const seenRequiredReviewers = new Set();
  const invalidRequiredReviewers = new Set();

  for (const name of files) {
    const parsed = readJson(path.join(semanticDir, name));
    const reviewerFromFile = path.basename(name, '.json');
    const reviewerFromPayload = String(parsed?.reviewer || '').trim();
    if (requireSemanticReviewers && requiredReviewerSet.has(reviewerFromFile)) {
      if (!parsed || parsed.reviewer !== reviewerFromFile || !Array.isArray(parsed.findings)) {
        invalidRequiredReviewers.add(reviewerFromFile);
        findings.push(
          semanticContractFinding(
            reviewerFromFile,
            'Required semantic reviewer output is malformed; expected { reviewer, findings: [] } with a matching reviewer name.',
          ),
        );
        continue;
      }
      seenRequiredReviewers.add(reviewerFromPayload);
    }

    const items = Array.isArray(parsed?.findings) ? parsed.findings : Array.isArray(parsed) ? parsed : [];
    for (const raw of items) {
      const normalized = normalizeSemanticFinding(raw, name);
      if (!normalized) continue;
      const classMeta = context.taxonomy.classById.get(normalized.classId);
      if (!classMeta?.detectors?.includes('semantic-ingest')) continue;
      findings.push(normalized);
    }
  }

  if (requireSemanticReviewers) {
    for (const reviewer of REQUIRED_SEMANTIC_REVIEWERS) {
      if (seenRequiredReviewers.has(reviewer) || invalidRequiredReviewers.has(reviewer)) continue;
      findings.push(semanticContractFinding(reviewer, 'Required semantic reviewer output is missing.'));
    }
  }

  return {
    detectorId: 'semantic-ingest',
    findings: dedupeFindings(findings),
    metadata: { semanticDir, filesRead: files.length },
  };
}

module.exports = { id: 'semantic-ingest', run, REQUIRED_SEMANTIC_REVIEWERS };
