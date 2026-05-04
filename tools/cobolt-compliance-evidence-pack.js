#!/usr/bin/env node

// CoBolt Compliance Evidence Pack — Wave 5 §5.12 (Tier 2 advisory).
//
// Assembles a packaged compliance evidence bundle from existing brownfield
// artifacts when the legacy system handles personal data, healthcare data, or
// payment data. The bundle is consumed by external auditors; the pipeline does
// not act on it. NEVER blocks — Tier 2 advisory only.
//
// Sources read (all optional — gracefully degrade per source):
//   - `_cobolt-output/latest/brownfield/legacy-data-classification.json`
//     (data classifications + GDPR purposes / dataCategories)
//   - `_cobolt-output/latest/brownfield/12-security-and-quality-assessment.md`
//     (security posture + auth surfaces; HIPAA + DPIA signals)
//   - `_cobolt-output/latest/brownfield/33-modernization-dependency-and-integration-register.md`
//     (PCI-DSS scope-reduction signals — tokenization, scope boundaries)
//   - `_cobolt-output/latest/brownfield/45-modernization-master-plan.md`
//     (HIPAA evaluation linkage, scope confirmation)
//   - `_cobolt-output/latest/brownfield/migration-safety-plan.json` AND
//     `_cobolt-output/latest/brownfield/33a-7r-decisions/*.json`
//     (per-component personalDataTouching + gdprArt30Ref + iso14764Category)
//   - `_cobolt-output/standards/standards-evidence.json`
//     (cross-reference to the existing standards-gate output for SOC 2 mapping)
//
// Output:
//   `_cobolt-output/reports/re-evidence-pack/compliance-evidence-bundle.json`
//   conforming to source/schemas/compliance-evidence-bundle.schema.json.
//
// Exit codes (per tools/CLAUDE.md contract):
//   0 — bundle assembled successfully (with or without gaps)
//   1 — hard error (write failure, internal exception)
//   2 — skipped: no compliance scope detected (no personal/health/payment data)
//   3 — bundle assembled BUT contains gaps the auditor must close (advisory)
//
// Usage:
//   node tools/cobolt-compliance-evidence-pack.js assemble [--brownfield <dir>] [--out <path>] [--json]

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_SKIPPED = 2;
const EXIT_HAS_GAPS = 3;

const BUNDLE_VERSION = '1.0.0';
const TOOL_ID = 'cobolt-compliance-evidence-pack/v1.0.0';

// ── Argument parsing ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { brownfield: null, out: null, json: false };
  let positional;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--brownfield') {
      args.brownfield = argv[++i];
      continue;
    }
    if (a === '--out') {
      args.out = argv[++i];
      continue;
    }
    if (a === '--json') {
      args.json = true;
      continue;
    }
    if (!a.startsWith('--')) {
      positional = positional || a;
    }
  }
  args.command = positional || 'assemble';
  return args;
}

// ── Filesystem helpers ────────────────────────────────────────────────────

function findBrownfieldDir(explicitDir) {
  if (explicitDir) return path.resolve(explicitDir);
  const candidates = [
    path.join(process.cwd(), '_cobolt-output', 'latest', 'brownfield'),
    path.join(process.cwd(), '_cobolt-output', 'brownfield'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readTextSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readDirJson(dir) {
  if (!fs.existsSync(dir)) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.json$/i.test(entry.name)) continue;
    const data = readJsonSafe(path.join(dir, entry.name));
    if (data) out.push({ file: entry.name, data });
  }
  return out;
}

// ── Decision aggregation (mirrors cobolt-re-evidence) ────────────────────

function loadAllDecisions(brownfieldDir) {
  const decisions = [];
  const safetyPlan = readJsonSafe(path.join(brownfieldDir, 'migration-safety-plan.json'));
  if (Array.isArray(safetyPlan?.decisions)) decisions.push(...safetyPlan.decisions);
  for (const { data } of readDirJson(path.join(brownfieldDir, '33a-7r-decisions'))) {
    if (data?.componentId) decisions.push(data);
  }
  return decisions;
}

// ── Scope detection ──────────────────────────────────────────────────────

const HIPAA_SIGNAL = /\b(HIPAA|45\s*CFR\s*164|PHI|protected health information|covered entity|business associate)\b/i;
const PCI_DSS_SIGNAL = /\b(PCI[-\s]?DSS|cardholder data|primary account number|PAN|CVV|tokeni[sz]ation)\b/i;
const DPDP_SIGNAL = /\b(DPDP|digital personal data protection|data fiduciary|data principal)\b/i;
const CCPA_SIGNAL = /\b(CCPA|california consumer privacy)\b/i;

function detectScope(brownfieldDir, decisions) {
  const personalDataDetected = decisions.some((d) => d?.personalDataTouching === true);
  const securityDoc = readTextSafe(path.join(brownfieldDir, '12-security-and-quality-assessment.md'));
  const integrationDoc = readTextSafe(
    path.join(brownfieldDir, '33-modernization-dependency-and-integration-register.md'),
  );
  const masterPlan = readTextSafe(path.join(brownfieldDir, '45-modernization-master-plan.md'));
  const dataClass = readJsonSafe(path.join(brownfieldDir, 'legacy-data-classification.json'));

  const corpus = [securityDoc, integrationDoc, masterPlan, dataClass ? JSON.stringify(dataClass) : ''].join('\n');

  const healthDataDetected = HIPAA_SIGNAL.test(corpus);
  const paymentDataDetected = PCI_DSS_SIGNAL.test(corpus);
  const dpdpRelevant = DPDP_SIGNAL.test(corpus);
  const ccpaRelevant = CCPA_SIGNAL.test(corpus);

  const frameworks = [];
  if (personalDataDetected) frameworks.push('GDPR'); // GDPR is the EU baseline; assume in-scope when personal data present
  if (healthDataDetected) frameworks.push('HIPAA');
  if (paymentDataDetected) frameworks.push('PCI-DSS');
  if (personalDataDetected || healthDataDetected || paymentDataDetected) frameworks.push('SOC2');
  if (dpdpRelevant) frameworks.push('DPDP');
  if (ccpaRelevant) frameworks.push('CCPA');

  return {
    frameworks,
    personalDataDetected,
    healthDataDetected,
    paymentDataDetected,
    componentCount: decisions.length,
  };
}

// ── Per-framework evidence builders ──────────────────────────────────────

function buildGdprArt30(decisions) {
  const personal = decisions.filter((d) => d?.personalDataTouching === true);
  if (personal.length === 0) return null;
  const records = personal.map((d) => ({
    componentId: d.componentId || '(unknown)',
    componentName: d.componentName || d.componentId || '(unknown)',
    controllerOrProcessor: 'unknown',
    purposes: [],
    dataCategories: [],
    dataSubjects: [],
    lawfulBasis: '',
    retentionPeriod: '',
    art30RefSource: d.gdprArt30Ref || null,
  }));
  return {
    regulation: 'GDPR Art. 30 (records of processing activities)',
    records,
  };
}

function buildGdprArt35Dpia(securityDoc, scope) {
  if (!scope.personalDataDetected) return null;
  // High-risk indicators per GDPR Art. 35(3): systematic monitoring, special-category
  // data, large-scale processing, etc. Heuristic detection from security doc body.
  const HIGH_RISK_PATTERNS = [
    /\bbiometric\b/i,
    /\bgenetic\b/i,
    /\bsensitive\b/i,
    /\bsystematic monitoring\b/i,
    /\blarge[-\s]scale processing\b/i,
    /\bautomated decision[-\s]making\b/i,
    /\bprofiling\b/i,
  ];
  const highRiskProcessingDetected = HIGH_RISK_PATTERNS.some((re) => re.test(securityDoc));
  return {
    regulation: 'GDPR Art. 35 (data protection impact assessment)',
    highRiskProcessingDetected,
    templatePath: '_cobolt-output/reports/re-evidence-pack/gdpr-art35-dpia-template.md',
    summary: highRiskProcessingDetected
      ? 'High-risk processing indicators detected; full DPIA required before modernization launch.'
      : 'No high-risk indicators detected in security assessment; baseline DPIA may suffice.',
  };
}

function buildHipaaEvaluation(_brownfieldDir, securityDoc, masterPlanText) {
  if (!HIPAA_SIGNAL.test(securityDoc + masterPlanText)) return null;
  const evaluationLog = [];
  // Heuristic: extract sections from security doc that mention HIPAA / 164 / PHI.
  for (const para of securityDoc.split(/\n\s*\n/)) {
    if (HIPAA_SIGNAL.test(para)) {
      evaluationLog.push(para.replace(/\s+/g, ' ').trim().slice(0, 200));
    }
  }
  return {
    regulation: 'HIPAA 45 CFR 164.308(a)(8) — Evaluation',
    evaluationLog: evaluationLog.slice(0, 10),
    linkedMasterPlan: '_cobolt-output/latest/brownfield/45-modernization-master-plan.md',
  };
}

function buildPciDssScopeReduction(integrationDoc, masterPlanText) {
  if (!PCI_DSS_SIGNAL.test(integrationDoc + masterPlanText)) return null;
  const tokenizationDetected = /\btokeni[sz]ation\b/i.test(integrationDoc + masterPlanText);
  const scopeBoundaries = [];
  for (const para of integrationDoc.split(/\n\s*\n/)) {
    if (PCI_DSS_SIGNAL.test(para)) scopeBoundaries.push(para.replace(/\s+/g, ' ').trim().slice(0, 200));
  }
  return {
    regulation: 'PCI-DSS v4.0.1 scope-reduction analysis',
    tokenizationDetected,
    scopeBoundaries: scopeBoundaries.slice(0, 10),
    evidenceSources: [
      '_cobolt-output/latest/brownfield/33-modernization-dependency-and-integration-register.md',
      '_cobolt-output/latest/brownfield/45-modernization-master-plan.md',
    ],
  };
}

function buildSoc2Mapping(scope, projectRoot) {
  // Always present when SOC2 is in scope. Cross-references the existing
  // standards-gate output where possible (which already reports baseline secure-
  // coding-standard / engineering-quality-standards / quality-gate config).
  if (!scope.frameworks.includes('SOC2')) return null;
  const standardsEvidence = readJsonSafe(
    path.join(projectRoot, '_cobolt-output', 'standards', 'standards-evidence.json'),
  );
  const standardsArtifact = standardsEvidence ? '_cobolt-output/standards/standards-evidence.json' : null;
  return {
    regulation: 'AICPA SOC 2 TSP-100 (Trust Services Criteria)',
    controlMapping: [
      { criterion: 'CC6.1', evidenceArtifact: standardsArtifact || 'pending', monitoringWindowMonths: 12 },
      { criterion: 'CC7.2', evidenceArtifact: standardsArtifact || 'pending', monitoringWindowMonths: 12 },
      {
        criterion: 'CC8.1',
        evidenceArtifact: '_cobolt-output/audit/human-approvals.jsonl',
        monitoringWindowMonths: 12,
      },
    ],
  };
}

// ── Gap detection ────────────────────────────────────────────────────────

function detectGaps(scope, evidence) {
  const gaps = [];
  if (scope.frameworks.includes('GDPR')) {
    if (!evidence.gdprArt30RecordsOfProcessing || evidence.gdprArt30RecordsOfProcessing.records.length === 0) {
      gaps.push({
        framework: 'GDPR',
        missing:
          'Art. 30 records of processing — no personalDataTouching components found OR migration-safety-plan.json absent',
        remediationHint:
          'Populate per-component 33a-7r-decisions/*.json with personalDataTouching:true + gdprArt30Ref. Re-run assembly.',
      });
    }
    if (!evidence.gdprArt35Dpia) {
      gaps.push({
        framework: 'GDPR',
        missing: 'Art. 35 DPIA',
        remediationHint: 'Add 12-security-and-quality-assessment.md with personal-data processing description.',
      });
    }
  }
  if (scope.frameworks.includes('HIPAA') && !evidence.hipaaEvaluation) {
    gaps.push({
      framework: 'HIPAA',
      missing: '45 CFR 164.308(a)(8) evaluation log',
      remediationHint:
        'Add HIPAA / 45 CFR 164 / PHI references to 12-security-and-quality-assessment.md or 45-modernization-master-plan.md.',
    });
  }
  if (scope.frameworks.includes('PCI-DSS') && !evidence.pciDssScopeReduction) {
    gaps.push({
      framework: 'PCI-DSS',
      missing: 'Scope-reduction analysis',
      remediationHint:
        'Add PCI-DSS / cardholder data / tokenization references to 33-modernization-dependency-and-integration-register.md.',
    });
  }
  if (scope.frameworks.includes('SOC2') && !evidence.soc2TspMapping) {
    gaps.push({
      framework: 'SOC2',
      missing: 'TSP-100 control mapping',
      remediationHint: 'Run cobolt-standards.js to populate standards-evidence.json.',
    });
  }
  return gaps;
}

// ── Main assembly ────────────────────────────────────────────────────────

function assemble(opts = {}) {
  const projectRoot = process.cwd();
  const brownfieldDir = findBrownfieldDir(opts.brownfield);
  if (!brownfieldDir) {
    return { ok: false, exitCode: EXIT_SKIPPED, reason: 'no brownfield directory on disk' };
  }
  const decisions = loadAllDecisions(brownfieldDir);
  const scope = detectScope(brownfieldDir, decisions);
  if (scope.frameworks.length === 0) {
    return {
      ok: false,
      exitCode: EXIT_SKIPPED,
      reason: 'no compliance scope detected (no personal/health/payment data)',
      scope,
    };
  }
  const securityDoc = readTextSafe(path.join(brownfieldDir, '12-security-and-quality-assessment.md'));
  const integrationDoc = readTextSafe(
    path.join(brownfieldDir, '33-modernization-dependency-and-integration-register.md'),
  );
  const masterPlanText = readTextSafe(path.join(brownfieldDir, '45-modernization-master-plan.md'));
  const evidence = {};
  const art30 = buildGdprArt30(decisions);
  if (art30) evidence.gdprArt30RecordsOfProcessing = art30;
  const dpia = buildGdprArt35Dpia(securityDoc, scope);
  if (dpia) evidence.gdprArt35Dpia = dpia;
  const hipaa = buildHipaaEvaluation(brownfieldDir, securityDoc, masterPlanText);
  if (hipaa) evidence.hipaaEvaluation = hipaa;
  const pci = buildPciDssScopeReduction(integrationDoc, masterPlanText);
  if (pci) evidence.pciDssScopeReduction = pci;
  const soc2 = buildSoc2Mapping(scope, projectRoot);
  if (soc2) evidence.soc2TspMapping = soc2;
  const gaps = detectGaps(scope, evidence);

  const bundle = {
    schemaVersion: 1,
    bundleVersion: BUNDLE_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy: TOOL_ID,
    scope,
    evidence,
    gaps,
  };

  const outPath =
    opts.out ||
    path.join(projectRoot, '_cobolt-output', 'reports', 're-evidence-pack', 'compliance-evidence-bundle.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(bundle, null, 2)}\n`);
  bundle.outputPath = path.relative(projectRoot, outPath);

  return {
    ok: true,
    exitCode: gaps.length > 0 ? EXIT_HAS_GAPS : EXIT_OK,
    bundle,
    outPath,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────

function printHelp() {
  process.stdout.write(
    [
      'CoBolt Compliance Evidence Pack (Wave 5 §5.12, Tier 2 advisory).',
      '',
      'Usage:',
      '  node tools/cobolt-compliance-evidence-pack.js assemble [--brownfield <dir>] [--out <path>] [--json]',
      '',
      'Assembles a packaged compliance bundle from existing brownfield artifacts when',
      'the legacy system handles personal data, healthcare data, or payment data.',
      'Bundle conforms to source/schemas/compliance-evidence-bundle.schema.json.',
      'Exit codes: 0=ok, 1=usage, 2=skipped, 3=bundle has gaps (advisory).',
      '',
    ].join('\n'),
  );
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return EXIT_OK;
  }
  const result = assemble(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(
      `compliance-evidence-pack: ${result.exitCode === EXIT_OK ? 'COMPLETE' : 'ASSEMBLED WITH GAPS'}\n`,
    );
    process.stdout.write(`  Output: ${result.outPath}\n`);
    process.stdout.write(`  Frameworks in scope: ${result.bundle.scope.frameworks.join(', ')}\n`);
    process.stdout.write(`  Gaps: ${result.bundle.gaps.length}\n`);
    for (const g of result.bundle.gaps) {
      process.stdout.write(`    - [${g.framework}] ${g.missing}\n`);
    }
  } else {
    process.stdout.write(`compliance-evidence-pack: SKIPPED — ${result.reason}\n`);
  }
  return result.exitCode;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  assemble,
  parseArgs,
  detectScope,
  loadAllDecisions,
  buildGdprArt30,
  buildGdprArt35Dpia,
  buildHipaaEvaluation,
  buildPciDssScopeReduction,
  buildSoc2Mapping,
  detectGaps,
  HIPAA_SIGNAL,
  PCI_DSS_SIGNAL,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_SKIPPED,
  EXIT_HAS_GAPS,
};
