#!/usr/bin/env node

// CoBolt compliance control gate.
//
// Converts named compliance frameworks in user/planning artifacts into
// deterministic build blockers. If the user asks for a framework, or the PRD
// names it, the pipeline must carry the related controls into requirements,
// delivery work, and release evidence.

const fs = require('node:fs');
const path = require('node:path');
const { getPlanningDir } = require('../lib/cobolt-planning-artifacts');

const SOC2_ACTIVATION = /\b(soc\s*2|soc2|trust services criteria|type\s+ii|type\s+i)\b/i;
const GDPR_ACTIVATION =
  /\b(gdpr|general data protection regulation|eu personal data|data subject rights?|data subject access|dsar|right to erasure|right to access|data portability|lawful basis|privacy by design)\b/i;
const DPDP_ACTIVATION =
  /\b(dpdp|digital personal data protection|data fiduciary|data principal|consent manager|india privacy)\b/i;
const HIPAA_ACTIVATION = /\b(hipaa|protected health information|phi\b|covered entity|business associate)\b/i;
const PCI_ACTIVATION = /\b(pci(?:[-\s]?dss)?|payment card|cardholder data|primary account number|pan\b|cvv)\b/i;

const SOC2_CONTROLS = [
  {
    id: 'SOC2-ISP',
    label: 'Information security policy',
    patterns: [
      /\binformation security policy\b/i,
      /\bsecurity policy\b/i,
      /\bisms\b/i,
      /\bacceptable use\b/i,
      /\bsecurity owner\b/i,
    ],
  },
  {
    id: 'SOC2-CONTROL-MATRIX',
    label: 'SOC2 control ownership matrix',
    patterns: [
      /\bcontrol ownership\b/i,
      /\bcontrol matrix\b/i,
      /\btrust services criteria\b/i,
      /\bCC[1-9](?:\.[0-9]+)?\b/i,
    ],
  },
  {
    id: 'SOC2-BREACH-SOP',
    label: 'Breach notification and incident response SOP',
    patterns: [
      /\bbreach notification\b/i,
      /\bincident response\b/i,
      /\b72[- ]hour\b/i,
      /\bcustomer notification\b/i,
      /\btabletop\b/i,
    ],
  },
  {
    id: 'SOC2-ACCESS-VETTING',
    label: 'Access vetting and background-check policy',
    patterns: [
      /\bbackground check\b/i,
      /\bidentity verification\b/i,
      /\bpersonnel screening\b/i,
      /\baccess vetting\b/i,
      /\bproduction access\b/i,
    ],
  },
  {
    id: 'SOC2-SUBPROCESSORS',
    label: 'Sub-processor register and DPA template',
    patterns: [
      /\bsub-processor\b/i,
      /\bsubprocessor\b/i,
      /\bdata processing agreement\b/i,
      /\bdpa\b/i,
      /\bvendor register\b/i,
    ],
  },
  {
    id: 'SOC2-MFA',
    label: 'MFA enforcement for privileged and customer access',
    patterns: [/\bmfa\b/i, /\bmulti-factor\b/i, /\btotp\b/i, /\bsso\b/i, /\bprivileged access\b/i],
  },
  {
    id: 'SOC2-AUDIT-RETENTION',
    label: 'Audit-log retention and immutable evidence storage',
    patterns: [
      /\baudit log retention\b/i,
      /\bretention\b/i,
      /\bread-only storage\b/i,
      /\bobject lock\b/i,
      /\bimmutable audit\b/i,
    ],
  },
  {
    id: 'SOC2-KEY-ROTATION',
    label: 'Secrets and key rotation procedure',
    patterns: [/\bkey rotation\b/i, /\bsecret rotation\b/i, /\bkek rotation\b/i, /\bre-?wrap/i, /\bkms\b/i, /\bhsm\b/i],
  },
  {
    id: 'SOC2-SECURITY-TESTING',
    label: 'Security testing and annual penetration test evidence',
    patterns: [/\bpenetration test\b/i, /\bpentest\b/i, /\bsast\b/i, /\bdast\b/i, /\bsecurity testing\b/i],
  },
  {
    id: 'SOC2-MONITORING',
    label: 'Security monitoring, alerting, and response evidence',
    patterns: [
      /\bstructured logging\b/i,
      /\balerting\b/i,
      /\banomal/i,
      /\bsecurity monitoring\b/i,
      /\bsiem\b/i,
      /\bdetection\b/i,
    ],
  },
];

const GDPR_CONTROLS = [
  {
    id: 'GDPR-LAWFUL-BASIS',
    label: 'Lawful basis, privacy notice, and consent records',
    patterns: [
      /\blawful basis\b/i,
      /\blegal basis\b/i,
      /\bconsent record\b/i,
      /\bconsent\b/i,
      /\bprivacy notice\b/i,
      /\bcookie consent\b/i,
    ],
  },
  {
    id: 'GDPR-DSR-ACCESS',
    label: 'Data subject access and export workflow',
    patterns: [
      /\bdata subject access\b/i,
      /\bdsar\b/i,
      /\bsubject access request\b/i,
      /\bdata export\b/i,
      /\baccess request\b/i,
    ],
  },
  {
    id: 'GDPR-DSR-ERASURE',
    label: 'Right-to-erasure and deletion workflow',
    patterns: [
      /\bright to erasure\b/i,
      /\berasure\b/i,
      /\bdelete personal data\b/i,
      /\banonymi[sz]e\b/i,
      /\bdeletion workflow\b/i,
    ],
  },
  {
    id: 'GDPR-PORTABILITY',
    label: 'Data portability in a machine-readable format',
    patterns: [
      /\bdata portability\b/i,
      /\bportable\b/i,
      /\bmachine-readable\b/i,
      /\bjson export\b/i,
      /\bcsv export\b/i,
    ],
  },
  {
    id: 'GDPR-RETENTION',
    label: 'Retention schedule and purge automation',
    patterns: [
      /\bretention schedule\b/i,
      /\bretention policy\b/i,
      /\bdata retention\b/i,
      /\bpurge\b/i,
      /\bdelete after\b/i,
    ],
  },
  {
    id: 'GDPR-BREACH-NOTIFICATION',
    label: 'Data breach notification workflow',
    patterns: [
      /\b72[- ]hour\b/i,
      /\bbreach notification\b/i,
      /\bsupervisory authority\b/i,
      /\bdata breach\b/i,
      /\bincident response\b/i,
    ],
  },
  {
    id: 'GDPR-DPA-SUBPROCESSORS',
    label: 'Processor contracts, DPA, and sub-processor register',
    patterns: [
      /\bdata processing agreement\b/i,
      /\bdpa\b/i,
      /\bprocessor contract\b/i,
      /\bsub-processor\b/i,
      /\bsubprocessor\b/i,
      /\bvendor register\b/i,
    ],
  },
  {
    id: 'GDPR-MINIMIZATION-PII',
    label: 'Data minimization, purpose limitation, and PII protection',
    patterns: [
      /\bdata minimization\b/i,
      /\bpurpose limitation\b/i,
      /\bprivacy by design\b/i,
      /\bpii\b/i,
      /\bpersonal data\b/i,
      /\blog redaction\b/i,
    ],
  },
];

const DPDP_CONTROLS = [
  {
    id: 'DPDP-NOTICE-CONSENT',
    label: 'Notice, purpose, and consent capture',
    patterns: [/\bnotice\b/i, /\bconsent\b/i, /\bpurpose limitation\b/i, /\bdata fiduciary\b/i, /\bconsent manager\b/i],
  },
  {
    id: 'DPDP-DATA-PRINCIPAL-RIGHTS',
    label: 'Data principal rights workflow',
    patterns: [
      /\bdata principal rights\b/i,
      /\bdata principal\b/i,
      /\baccess request\b/i,
      /\bcorrection\b/i,
      /\berasure\b/i,
    ],
  },
  {
    id: 'DPDP-GRIEVANCE-CONTACT',
    label: 'Grievance contact and response process',
    patterns: [
      /\bgrievance\b/i,
      /\bgrievance officer\b/i,
      /\bdata protection officer\b/i,
      /\bdpo\b/i,
      /\bcontact workflow\b/i,
    ],
  },
  {
    id: 'DPDP-BREACH-REPORTING',
    label: 'Personal data breach reporting',
    patterns: [
      /\bpersonal data breach\b/i,
      /\bbreach reporting\b/i,
      /\bdata protection board\b/i,
      /\bbreach notification\b/i,
    ],
  },
  {
    id: 'DPDP-RETENTION-DELETION',
    label: 'Retention limits and deletion on purpose completion',
    patterns: [/\bretention\b/i, /\bdelete after\b/i, /\bpurpose completion\b/i, /\bdata deletion\b/i, /\bpurge\b/i],
  },
  {
    id: 'DPDP-PROCESSOR-CONTRACTS',
    label: 'Processor and vendor obligations',
    patterns: [
      /\bprocessor\b/i,
      /\bvendor\b/i,
      /\bsubprocessor\b/i,
      /\bdata processing agreement\b/i,
      /\bcontractual obligation\b/i,
    ],
  },
];

const HIPAA_CONTROLS = [
  {
    id: 'HIPAA-PHI-INVENTORY',
    label: 'PHI inventory and classification',
    patterns: [
      /\bphi inventory\b/i,
      /\bprotected health information\b/i,
      /\bphi\b/i,
      /\bdata classification\b/i,
      /\bminimum necessary\b/i,
    ],
  },
  {
    id: 'HIPAA-ACCESS-CONTROL',
    label: 'PHI access controls and authorization',
    patterns: [/\baccess control\b/i, /\bauthorization\b/i, /\bminimum necessary\b/i, /\brole-based\b/i, /\brbac\b/i],
  },
  {
    id: 'HIPAA-AUDIT-CONTROLS',
    label: 'Audit controls for PHI access and changes',
    patterns: [/\baudit control\b/i, /\baudit log\b/i, /\baccess log\b/i, /\bphi access\b/i, /\bactivity review\b/i],
  },
  {
    id: 'HIPAA-PHI-PROTECTION',
    label: 'PHI encryption and transmission protection',
    patterns: [/\bencryption\b/i, /\btransmission security\b/i, /\btls\b/i, /\bat rest\b/i, /\bin transit\b/i],
  },
  {
    id: 'HIPAA-BAA-VENDORS',
    label: 'Business associate agreements and vendor controls',
    patterns: [/\bbusiness associate\b/i, /\bbaa\b/i, /\bvendor\b/i, /\bsubprocessor\b/i, /\bcontract\b/i],
  },
  {
    id: 'HIPAA-BREACH-NOTIFICATION',
    label: 'HIPAA breach notification workflow',
    patterns: [
      /\bbreach notification\b/i,
      /\bsecurity incident\b/i,
      /\bhhs\b/i,
      /\bincident response\b/i,
      /\bphi breach\b/i,
    ],
  },
];

const PCI_CONTROLS = [
  {
    id: 'PCI-SCOPE-INVENTORY',
    label: 'Cardholder data scope and inventory',
    patterns: [
      /\bcardholder data\b/i,
      /\bpayment card\b/i,
      /\bprimary account number\b/i,
      /\bpan\b/i,
      /\bcard data environment\b/i,
    ],
  },
  {
    id: 'PCI-SENSITIVE-AUTH-DATA',
    label: 'Sensitive authentication data storage prohibition',
    patterns: [
      /\bcvv\b/i,
      /\bcvc\b/i,
      /\bpin\b/i,
      /\bmagnetic stripe\b/i,
      /\bdo not store\b/i,
      /\bno sensitive authentication data\b/i,
    ],
  },
  {
    id: 'PCI-PROTECTION',
    label: 'Card data encryption, tokenization, and transmission protection',
    patterns: [/\bencryption\b/i, /\btokenization\b/i, /\btls\b/i, /\bin transit\b/i, /\bat rest\b/i],
  },
  {
    id: 'PCI-ACCESS-LOGGING',
    label: 'Card data access control and audit logging',
    patterns: [
      /\baccess control\b/i,
      /\bleast privilege\b/i,
      /\baudit log\b/i,
      /\blog review\b/i,
      /\bcardholder data access\b/i,
    ],
  },
  {
    id: 'PCI-VULNERABILITY-MANAGEMENT',
    label: 'Vulnerability management and security testing',
    patterns: [
      /\bvulnerability management\b/i,
      /\bsecurity testing\b/i,
      /\bsast\b/i,
      /\bdast\b/i,
      /\bdependency audit\b/i,
    ],
  },
  {
    id: 'PCI-PROVIDER-SEGMENTATION',
    label: 'Payment provider boundary and CDE segmentation',
    patterns: [
      /\bpayment provider\b/i,
      /\bstripe\b/i,
      /\bsegmentation\b/i,
      /\bcard data environment\b/i,
      /\bcde\b/i,
      /\bhosted checkout\b/i,
    ],
  },
];

const FRAMEWORK_DEFINITIONS = [
  { id: 'SOC2', label: 'SOC2', activation: SOC2_ACTIVATION, controls: SOC2_CONTROLS },
  { id: 'GDPR', label: 'GDPR', activation: GDPR_ACTIVATION, controls: GDPR_CONTROLS },
  { id: 'DPDP', label: 'DPDP', activation: DPDP_ACTIVATION, controls: DPDP_CONTROLS },
  { id: 'HIPAA', label: 'HIPAA', activation: HIPAA_ACTIVATION, controls: HIPAA_CONTROLS },
  { id: 'PCI', label: 'PCI DSS', activation: PCI_ACTIVATION, controls: PCI_CONTROLS },
];

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function existingFiles(projectRoot, relativePaths) {
  return relativePaths
    .map((relativePath) => path.join(projectRoot, relativePath))
    .filter((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile());
}

function walkFiles(rootDir) {
  const results = [];
  if (!fs.existsSync(rootDir)) return results;

  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && /\.(md|json|ya?ml|txt)$/i.test(entry.name)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function readCorpus(files) {
  return files
    .map((filePath) => {
      const text = readText(filePath);
      return text ? `\n\n--- ${filePath} ---\n${text}` : '';
    })
    .join('\n');
}

function relativePlanningFile(projectRoot, planningDir, fileName) {
  return path.relative(projectRoot, path.join(planningDir, fileName));
}

function planningPaths(projectRoot) {
  const planningDir = getPlanningDir(projectRoot, { create: false });
  if (!planningDir) {
    return {
      planningDir: null,
      activationFiles: [],
      requirementFiles: [],
      deliveryFiles: [],
    };
  }

  return {
    planningDir,
    activationFiles: existingFiles(projectRoot, [
      relativePlanningFile(projectRoot, planningDir, 'prd.md'),
      relativePlanningFile(projectRoot, planningDir, 'feature-prd.md'),
      relativePlanningFile(projectRoot, planningDir, 'source-document-consolidation.md'),
      relativePlanningFile(projectRoot, planningDir, 'security-requirements.md'),
      relativePlanningFile(projectRoot, planningDir, 'trd.md'),
      relativePlanningFile(projectRoot, planningDir, 'release-readiness-checklist.md'),
      relativePlanningFile(projectRoot, planningDir, 'assumptions-log.md'),
      relativePlanningFile(projectRoot, planningDir, 'source-gap-summary.md'),
    ]),
    requirementFiles: existingFiles(projectRoot, [
      relativePlanningFile(projectRoot, planningDir, 'prd.md'),
      relativePlanningFile(projectRoot, planningDir, 'feature-prd.md'),
      relativePlanningFile(projectRoot, planningDir, 'compliance-register.md'),
      relativePlanningFile(projectRoot, planningDir, 'compliance-register.json'),
      relativePlanningFile(projectRoot, planningDir, 'security-requirements.md'),
      relativePlanningFile(projectRoot, planningDir, 'trd.md'),
      relativePlanningFile(projectRoot, planningDir, 'release-readiness-checklist.md'),
      relativePlanningFile(projectRoot, planningDir, 'master-plan.md'),
    ]),
    deliveryFiles: [
      ...existingFiles(projectRoot, [
        relativePlanningFile(projectRoot, planningDir, 'epics.md'),
        relativePlanningFile(projectRoot, planningDir, 'milestones.md'),
        relativePlanningFile(projectRoot, planningDir, 'compliance-register.md'),
        relativePlanningFile(projectRoot, planningDir, 'compliance-register.json'),
        relativePlanningFile(projectRoot, planningDir, 'story-tracker.json'),
        relativePlanningFile(projectRoot, planningDir, 'sprint-status.yaml'),
        relativePlanningFile(projectRoot, planningDir, 'master-plan.md'),
      ]),
      ...walkFiles(path.join(planningDir, 'stories')),
    ],
  };
}

function releaseEvidenceFiles(projectRoot) {
  return [
    ...existingFiles(projectRoot, [
      'SECURITY.md',
      'docs/privacy.md',
      'docs/privacy-policy.md',
      'docs/compliance/gdpr.md',
      'docs/compliance/dpdp.md',
      'docs/compliance/hipaa.md',
      'docs/compliance/pci.md',
      'docs/legal/dpa-template.md',
      'docs/legal/subprocessors.md',
      'docs/security/soc2-controls.md',
      'docs/security/subprocessors.md',
      'docs/security/dpa-template.md',
      'docs/security/data-retention.md',
      'docs/security/data-subject-requests.md',
      'docs/security/privacy-controls.md',
      'docs/security/vendor-register.md',
      'docs/runbooks/incident-response.md',
      'docs/runbooks/breach-notification.md',
      'docs/runbooks/key-rotation.md',
      'docs/runbooks/disaster-recovery.md',
    ]),
    ...walkFiles(path.join(projectRoot, 'docs', 'security', 'policies')),
    ...walkFiles(path.join(projectRoot, 'docs', 'compliance')),
  ];
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function selectedFrameworks(options = {}) {
  if (!options.frameworks) return FRAMEWORK_DEFINITIONS;
  const wanted = new Set(options.frameworks.map((framework) => String(framework).toUpperCase()));
  return FRAMEWORK_DEFINITIONS.filter((framework) => wanted.has(framework.id));
}

function evaluateComplianceControlCoverage(projectRoot = process.cwd(), options = {}) {
  const mode = options.mode || 'planning';
  const paths = planningPaths(projectRoot);
  const frameworks = selectedFrameworks(options);
  const activationCorpus = readCorpus(paths.activationFiles);
  const activeFrameworkIds = new Set(
    frameworks.filter((framework) => framework.activation.test(activationCorpus)).map((framework) => framework.id),
  );

  const requirementCorpus = readCorpus(paths.requirementFiles);
  const deliveryCorpus = readCorpus(paths.deliveryFiles);
  const releaseCorpus = readCorpus(releaseEvidenceFiles(projectRoot));
  const evidenceCorpus = mode === 'release' ? releaseCorpus : deliveryCorpus;

  const controls = frameworks.flatMap((framework) =>
    framework.controls.map((control) => {
      const active = activeFrameworkIds.has(framework.id);
      const requirementMapped = matchesAny(requirementCorpus, control.patterns);
      const deliveryMapped = matchesAny(deliveryCorpus, control.patterns);
      const releaseEvidenceMapped = matchesAny(releaseCorpus, control.patterns);
      const covered = !active || (mode === 'release' ? releaseEvidenceMapped : requirementMapped && deliveryMapped);
      return {
        framework: framework.id,
        id: control.id,
        label: control.label,
        active,
        requirementMapped,
        deliveryMapped,
        releaseEvidenceMapped,
        covered,
      };
    }),
  );

  const activeControls = controls.filter((control) => control.active);
  const missing = activeControls.filter((control) => !control.covered);
  const activeFrameworks = [...activeFrameworkIds];
  const frameworkSummary = {};
  for (const framework of frameworks) {
    const frameworkControls = controls.filter((control) => control.framework === framework.id && control.active);
    if (frameworkControls.length === 0) continue;
    frameworkSummary[framework.id] = {
      totalControls: frameworkControls.length,
      covered: frameworkControls.filter((control) => control.covered).length,
      missing: frameworkControls.filter((control) => !control.covered).length,
    };
  }

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    mode,
    activeFrameworks,
    passed: activeFrameworks.length === 0 || missing.length === 0,
    status: activeFrameworks.length === 0 ? 'not_applicable' : missing.length === 0 ? 'passed' : 'failed',
    summary: {
      active: activeFrameworks.length > 0,
      frameworks: frameworkSummary,
      totalControls: activeControls.length,
      covered: activeControls.filter((control) => control.covered).length,
      missing: missing.length,
      activationFiles: paths.activationFiles.map((filePath) => path.relative(projectRoot, filePath)),
      requirementFiles: paths.requirementFiles.map((filePath) => path.relative(projectRoot, filePath)),
      deliveryFiles: paths.deliveryFiles.map((filePath) => path.relative(projectRoot, filePath)),
      evidenceBytes: evidenceCorpus.length,
    },
    controls,
    missingControls: missing.map((control) => ({
      framework: control.framework,
      id: control.id,
      label: control.label,
      reason:
        mode === 'release'
          ? `${control.framework} is active, but release evidence does not contain this control.`
          : `${control.framework} is active, but requirements and delivery artifacts do not both cover this control.`,
    })),
  };
}

function evaluateSoc2ControlCoverage(projectRoot = process.cwd(), options = {}) {
  return evaluateComplianceControlCoverage(projectRoot, { ...options, frameworks: ['SOC2'] });
}

function writeReport(outputPath, report) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function defaultOutputPath(projectRoot, mode) {
  const planningDir = getPlanningDir(projectRoot, { create: true });
  return path.join(planningDir, `compliance-control-gate-${mode}.json`);
}

function parseArgs(argv) {
  const args = [...argv];
  const modeArg = args.find((arg) => arg === 'planning' || arg === 'release');
  const options = {
    mode: modeArg || 'planning',
    json: args.includes('--json'),
    output: null,
    frameworks: null,
  };

  const outputIndex = args.indexOf('--output');
  if (outputIndex !== -1 && args[outputIndex + 1]) {
    options.output = args[outputIndex + 1];
  }

  const frameworksIndex = args.indexOf('--frameworks');
  if (frameworksIndex !== -1 && args[frameworksIndex + 1]) {
    options.frameworks = args[frameworksIndex + 1]
      .split(',')
      .map((framework) => framework.trim().toUpperCase())
      .filter(Boolean);
  }

  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectRoot = process.cwd();
  const report = evaluateComplianceControlCoverage(projectRoot, options);
  const outputPath = options.output || defaultOutputPath(projectRoot, options.mode);
  writeReport(path.resolve(projectRoot, outputPath), report);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.status === 'not_applicable') {
    console.log('Compliance control gate: not applicable (no named compliance framework active).');
  } else {
    const frameworks = report.activeFrameworks.join(', ');
    console.log(
      `Compliance control gate: ${report.passed ? 'PASS' : 'FAIL'} ` +
        `(${report.summary.covered}/${report.summary.totalControls} controls covered for ${frameworks})`,
    );
    for (const missing of report.missingControls) {
      console.log(`  - ${missing.id}: ${missing.label}`);
    }
  }

  process.exit(report.passed ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  FRAMEWORK_DEFINITIONS,
  SOC2_CONTROLS,
  GDPR_CONTROLS,
  DPDP_CONTROLS,
  HIPAA_CONTROLS,
  PCI_CONTROLS,
  evaluateComplianceControlCoverage,
  evaluateSoc2ControlCoverage,
  parseArgs,
};
