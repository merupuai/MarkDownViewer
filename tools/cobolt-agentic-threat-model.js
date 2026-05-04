#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  ARTIFACTS,
  SCHEMA_VERSION,
  artifactPath,
  finding,
  parseArgs,
  printJsonOrHuman,
  readJson,
  resolvePlanningDir,
  resolveProjectRoot,
  toPosix,
  writeJson,
} = require('../lib/cobolt-planning-vnext');

const TOOL_ID = 'cobolt-agentic-threat-model';

function fileExists(projectRoot, relPath) {
  return fs.existsSync(path.join(projectRoot, relPath));
}

function readPreDispatch(projectRoot) {
  try {
    return fs.readFileSync(path.join(projectRoot, 'source', 'hooks', 'cobolt-pre-dispatch.js'), 'utf8');
  } catch {
    return '';
  }
}

function gateRegistered(projectRoot, hookName) {
  return readPreDispatch(projectRoot).includes(hookName);
}

function threat(id, channel, title, severity, status, controlIds, evidence) {
  return { id, channel, title, severity, status, controlIds, evidence };
}

function buildAgenticThreatModel(options = {}) {
  const projectRoot = resolveProjectRoot(options);
  const planningDir = resolvePlanningDir(projectRoot, { create: options.write !== false });
  const sourceLedger = readJson(path.join(planningDir, ARTIFACTS.sourceLedger), null);
  const findings = [];

  const promptScannerPresent =
    fileExists(projectRoot, 'source/hooks/cobolt-prompt-injection-scanner.js') &&
    fileExists(projectRoot, 'lib/cobolt-prompt-injection-patterns.js');
  const promptScannerRegistered = gateRegistered(projectRoot, 'cobolt-prompt-injection-scanner.js');
  const agentReplayPresent = fileExists(projectRoot, 'tools/cobolt-agent-replay.js');
  const mcpAuditPresent =
    fileExists(projectRoot, 'tools/cobolt-mcp-audit.js') && fileExists(projectRoot, 'tools/cobolt-plugin-lock.js');
  const provenanceGatePresent = fileExists(projectRoot, 'source/hooks/cobolt-planning-provenance-gate.js');
  const planReviewPresent = fs.existsSync(path.join(planningDir, 'plan-review-verdict.json'));
  const outputAuditPresent = fs.existsSync(
    path.join(projectRoot, '_cobolt-output', 'audit', 'plan-output-audit', 'audit-report.json'),
  );

  const threats = [
    threat(
      'AGENTIC-PROMPT-INJECTION',
      'source-input',
      'Prompt injection or role-confusion payload enters planning source inputs',
      'high',
      promptScannerPresent && promptScannerRegistered ? 'mitigated' : 'open',
      ['OWASP.LLM.01', 'NIST.AI.RMF.MEASURE.2.7', 'NIST.SSDF.PW.4.4'],
      [
        promptScannerPresent
          ? 'source/hooks/cobolt-prompt-injection-scanner.js'
          : 'missing prompt-injection scanner hook',
        promptScannerRegistered
          ? 'registered in source/hooks/cobolt-pre-dispatch.js'
          : 'not registered in pre-dispatch',
      ],
    ),
    threat(
      'AGENTIC-MCP-CAPABILITY',
      'mcp',
      'MCP/tool capability expansion changes what planning agents can read or do',
      'high',
      mcpAuditPresent ? 'mitigated' : 'open',
      ['MCP.SECURITY.AUTHZ', 'OWASP.LLM.06', 'NIST.AI.RMF.MANAGE.4'],
      [
        mcpAuditPresent
          ? 'tools/cobolt-mcp-audit.js and tools/cobolt-plugin-lock.js'
          : 'MCP audit/plugin lock evidence missing',
      ],
    ),
    threat(
      'AGENTIC-SOURCE-LAUNDERING',
      'artifact',
      'Generated artifacts launder untrusted or manual source claims into build authority',
      'high',
      provenanceGatePresent && sourceLedger ? 'mitigated' : 'open',
      ['NIST.SSDF.PS.3.1', 'SLSA.PROVENANCE', 'OWASP.LLM.05'],
      [
        provenanceGatePresent ? 'source/hooks/cobolt-planning-provenance-gate.js' : 'planning provenance gate missing',
        sourceLedger
          ? toPosix(path.join('_cobolt-output', 'latest', 'planning', ARTIFACTS.sourceLedger))
          : 'source ledger missing',
      ],
    ),
    threat(
      'AGENTIC-OUTPUT-FABRICATION',
      'agent-output',
      'Agent claims produce plausible but unverifiable plan evidence',
      'high',
      agentReplayPresent && planReviewPresent && outputAuditPresent ? 'mitigated' : 'open',
      ['NIST.AI.RMF.MEASURE.2.5', 'OWASP.LLM.09', 'NIST.SSDF.PW.7.2'],
      [
        agentReplayPresent ? 'tools/cobolt-agent-replay.js' : 'agent replay harness missing',
        planReviewPresent ? 'plan-review-verdict.json' : 'plan-review-verdict.json missing',
        outputAuditPresent
          ? '_cobolt-output/audit/plan-output-audit/audit-report.json'
          : 'plan-output-audit report missing',
      ],
    ),
    threat(
      'AGENTIC-SEMANTIC-DRIFT',
      'semantic-drift',
      'Stable source input produces semantically divergent planning output across runs',
      'medium',
      agentReplayPresent ? 'mitigated' : 'accepted',
      ['NIST.AI.RMF.MEASURE.2.7', 'NIST.AI.RMF.MANAGE.2'],
      [agentReplayPresent ? 'tools/cobolt-agent-replay.js drift-report' : 'Phase 4 replay/calibration planned'],
    ),
    threat(
      'AGENTIC-MEMORY-POISONING',
      'memory',
      'Stale or poisoned memory/context influences planning without source traceability',
      'medium',
      sourceLedger ? 'mitigated' : 'open',
      ['NIST.AI.RMF.MAP.4', 'OWASP.LLM.08'],
      [sourceLedger ? 'source ledger separates accepted source from ambient context' : 'source ledger missing'],
    ),
  ];

  for (const item of threats) {
    if (item.status === 'open') {
      findings.push(
        finding(`THREAT-OPEN:${item.id}`, item.severity === 'high' ? 'critical' : 'advisory', `${item.id} is open`, {
          threatId: item.id,
        }),
      );
    }
  }

  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy: TOOL_ID,
    projectRoot,
    planningDir,
    threats,
    summary: {
      threatCount: threats.length,
      mitigatedCount: threats.filter((item) => item.status === 'mitigated').length,
      acceptedCount: threats.filter((item) => item.status === 'accepted').length,
      openCount: threats.filter((item) => item.status === 'open').length,
      promptScannerPresent,
      promptScannerRegistered,
      agentReplayPresent,
      mcpAuditPresent,
    },
    findings,
  };

  if (options.write !== false) writeJson(artifactPath(projectRoot, ARTIFACTS.threatModel, { planningDir }), report);
  return report;
}

function checkAgenticThreatModel(options = {}) {
  const report = buildAgenticThreatModel(options);
  return {
    ...report,
    passed: options.strict ? !report.findings.length : !report.findings.some((item) => item.severity === 'critical'),
  };
}

function render(report) {
  return [
    `agentic-threat-model: mitigated ${report.summary.mitigatedCount}/${report.summary.threatCount}`,
    `open=${report.summary.openCount} findings=${report.findings.length}`,
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'help') {
    process.stdout.write('usage: cobolt-agentic-threat-model generate|check [--project <dir>] [--json] [--strict]\n');
    return 0;
  }
  const report = options.command === 'check' ? checkAgenticThreatModel(options) : buildAgenticThreatModel(options);
  printJsonOrHuman(report, options.json, render);
  if (options.command === 'check' && report.passed === false) return options.strict ? 1 : 0;
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  TOOL_ID,
  buildAgenticThreatModel,
  checkAgenticThreatModel,
  main,
};
