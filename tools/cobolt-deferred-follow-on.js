#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const REGISTER_PATH = path.join(ROOT, 'source', 'templates', 'deferred-follow-on-register.json');
const REPORT_DIR = path.join(ROOT, '_cobolt-output', 'reports', 'deferred-follow-on');
const REQUIRED_IDS = Object.freeze(['DF-01', 'DF-02', 'DF-03', 'DF-04', 'DF-05', 'DF-06', 'DF-07', 'DF-08', 'DF-09']);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeRel(rel) {
  return String(rel || '').replace(/\\/g, '/');
}

function loadRegister(registerPath = REGISTER_PATH) {
  const register = readJson(registerPath);
  if (register.schema !== 'cobolt-deferred-follow-on@1') {
    throw new Error(`unexpected register schema: ${register.schema}`);
  }
  if (!Array.isArray(register.items)) {
    throw new Error('deferred register is missing items[]');
  }
  return register;
}

function validateRegister(register, rootDir = ROOT) {
  const findings = [];
  const ids = register.items.map((item) => item.id);
  const missingIds = REQUIRED_IDS.filter((id) => !ids.includes(id));
  const extraIds = ids.filter((id) => !REQUIRED_IDS.includes(id));
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);

  for (const id of missingIds) findings.push({ code: 'MISSING_DF_ID', id, message: `${id} missing from register` });
  for (const id of extraIds) findings.push({ code: 'UNKNOWN_DF_ID', id, message: `${id} is not a known DF id` });
  for (const id of duplicateIds)
    findings.push({ code: 'DUPLICATE_DF_ID', id, message: `${id} appears more than once` });

  for (const item of register.items) {
    if (!item.title) {
      findings.push({ code: 'MISSING_TITLE', id: item.id, message: `${item.id} has no title` });
    }
    if (!['closed-in-repo', 'external-attestation-pending'].includes(item.status)) {
      findings.push({ code: 'BAD_STATUS', id: item.id, message: `${item.id} status is invalid: ${item.status}` });
    }
    if (!Array.isArray(item.evidencePaths) || item.evidencePaths.length === 0) {
      findings.push({ code: 'NO_EVIDENCE', id: item.id, message: `${item.id} has no evidence paths` });
      continue;
    }
    for (const rel of item.evidencePaths) {
      const normalized = normalizeRel(rel);
      if (path.isAbsolute(normalized)) {
        findings.push({
          code: 'ABSOLUTE_EVIDENCE_PATH',
          id: item.id,
          path: normalized,
          message: `${item.id} evidence path must be repo-relative: ${normalized}`,
        });
        continue;
      }
      const full = path.join(rootDir, normalized);
      if (!fs.existsSync(full)) {
        findings.push({
          code: 'MISSING_EVIDENCE_PATH',
          id: item.id,
          path: normalized,
          message: `${item.id} evidence path missing: ${normalized}`,
        });
      }
    }
  }

  return {
    ok: findings.length === 0,
    schema: register.schema,
    lastUpdated: register.lastUpdated,
    summary: {
      total: register.items.length,
      closedInRepo: register.items.filter((item) => item.status === 'closed-in-repo').length,
      externalAttestationPending: register.items.filter((item) => item.status === 'external-attestation-pending')
        .length,
      findings: findings.length,
    },
    items: register.items.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      closureType: item.closureType,
      evidenceCount: item.evidencePaths.length,
      validationCommandCount: item.validationCommands.length,
    })),
    findings,
  };
}

function renderMarkdown(result) {
  const lines = [
    '# Deferred Follow-on Closure',
    '',
    `Verdict: ${result.ok ? 'PASS' : 'FAIL'}`,
    `Register updated: ${result.lastUpdated}`,
    '',
    '| ID | Status | Closure Type | Evidence Paths | Validation Commands |',
    '| --- | --- | --- | ---: | ---: |',
  ];
  for (const item of result.items) {
    lines.push(
      `| ${item.id} | ${item.status} | ${item.closureType} | ${item.evidenceCount} | ${item.validationCommandCount} |`,
    );
  }
  if (result.findings.length > 0) {
    lines.push('', '## Findings', '');
    for (const finding of result.findings) {
      lines.push(`- ${finding.id || 'register'} ${finding.code}: ${finding.message}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function writeReports(result, reportDir = REPORT_DIR) {
  fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const jsonPath = path.join(reportDir, 'latest.json');
  const mdPath = path.join(reportDir, 'latest.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(mdPath, renderMarkdown(result), { encoding: 'utf8', mode: 0o600 });
  return { jsonPath, mdPath };
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { sub: null, json: false, noWrite: false, rootDir: ROOT, registerPath: REGISTER_PATH };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (i === 0 && !arg.startsWith('--')) opts.sub = arg;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--no-write') opts.noWrite = true;
    else if (arg === '--root') opts.rootDir = path.resolve(argv[++i] || opts.rootDir);
    else if (arg.startsWith('--root=')) opts.rootDir = path.resolve(arg.slice('--root='.length));
    else if (arg === '--register') opts.registerPath = path.resolve(argv[++i] || opts.registerPath);
    else if (arg.startsWith('--register=')) opts.registerPath = path.resolve(arg.slice('--register='.length));
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  opts.sub = opts.sub || 'check';
  return opts;
}

function printHelp() {
  console.log(`Usage: node tools/cobolt-deferred-follow-on.js <check|list|report> [options]

Options:
  --json                 Print JSON.
  --no-write             Do not write reports in report mode.
  --root <dir>           Repository root used for evidence path checks.
  --register <file>      Override deferred follow-on register path.
`);
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    printHelp();
    return 0;
  }
  const register = loadRegister(opts.registerPath);
  const result = validateRegister(register, opts.rootDir);

  if (opts.sub === 'list') {
    for (const item of register.items) {
      console.log(`${item.id}\t${item.status}\t${item.title}`);
    }
    return 0;
  }

  if (opts.sub === 'report') {
    const reports = opts.noWrite ? null : writeReports(result);
    const output = reports ? { ...result, reports } : result;
    if (opts.json) console.log(JSON.stringify(output, null, 2));
    else process.stdout.write(renderMarkdown(result));
    return result.ok ? 0 : 1;
  }

  if (opts.sub === 'check') {
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Deferred follow-on check: ${result.ok ? 'PASS' : 'FAIL'}`);
      console.log(`  Items: ${result.summary.total}`);
      console.log(`  Findings: ${result.summary.findings}`);
      for (const finding of result.findings) console.log(`  - [${finding.code}] ${finding.message}`);
    }
    return result.ok ? 0 : 1;
  }

  throw new Error(`Unknown subcommand: ${opts.sub}`);
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`[cobolt-deferred-follow-on] ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  REGISTER_PATH,
  REQUIRED_IDS,
  loadRegister,
  main,
  parseArgs,
  renderMarkdown,
  validateRegister,
  writeReports,
};
