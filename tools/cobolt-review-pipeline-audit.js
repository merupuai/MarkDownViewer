#!/usr/bin/env node

// Deterministic Review pipeline audit harness.
// Validates source-backed contracts for cobolt-review: CLI wiring, step graph,
// tools, hooks, gates, agents, ACLs, priority matrix, artifact handoffs, and
// recovery paths.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { BASELINE_PREFIXES, BASELINE_REVIEWERS, REVIEWER_PREFIXES } = require('../lib/cobolt-reviewer-registry');
const { atomicWrite, atomicWriteJSON } = require('../lib/cobolt-atomic-write');

const REVIEW_LEADS = ['review-lead', 'cobolt-review-lead'];

const OPTIONAL_SPECIALISTS = [
  'cobolt-authz-reviewer',
  'security-authz-deep-reviewer',
  'illusion-detector',
  'ai-security-reviewer',
  'sast-dast-runner',
  'pentest-agent',
  'db-audit-lead',
];

const REVIEW_AGENTS = [
  ...REVIEW_LEADS,
  ...BASELINE_REVIEWERS.map((reviewer) => reviewer.agent),
  ...OPTIONAL_SPECIALISTS,
];

const WRITE_CAPABLE_REVIEW_AGENTS = new Set([
  'review-lead',
  'cobolt-review-lead',
  'cobolt-authz-reviewer',
  'design-token-linter',
  'uat-agent',
  'pentest-agent',
  'db-audit-lead',
  'security-authz-deep-reviewer',
]);

const REQUIRED_REVIEW_HOOKS = [
  'cobolt-subagent-write-guard.js',
  'cobolt-model-tier-gate.js',
  'cobolt-dispatch-acl.js',
  'cobolt-reviewer-gate.js',
  'cobolt-phantom-rate-enforcer.js',
  'cobolt-reviewer-completeness.js',
  'cobolt-review-findings-write-gate.js',
  'cobolt-chain-decision-gate.js',
  'cobolt-advisory-consumption-gate.js',
  'cobolt-advisory-verdict-gate.js',
  'cobolt-checkpoint-write-gate.js',
  'cobolt-step-proof-gate.js',
  'cobolt-artifact-consumer-gate.js',
  'cobolt-output-validator.js',
  'cobolt-build-gate.js',
  'cobolt-browser-evidence-gate.js',
  'cobolt-security-hard-gate.js',
];

const REQUIRED_REVIEW_GATE_NAMES = [
  'Governance standards coverage',
  'Standards evidence profile',
  'Compliance control coverage',
  'Security invariant scan',
  'Secret entropy scan',
  'Core security scan posture',
];

const REQUIRED_BUILD_PIPELINE_GATE_NAMES = [
  'Build authority planning artifacts',
  'Build Step 04 checkpoint exists',
  'Build-pipeline review handoff exists',
  'Build packet freshness',
];

const REQUIRED_POST_BUILD_GATE_NAMES = ['Build validation checkpoint exists'];

const REQUIRED_REVIEW_TOOLS = [
  'cobolt-review-packet.js',
  'cobolt-review-coverage.js',
  'cobolt-review-evidence-index.js',
  'cobolt-review-accuracy.js',
  'cobolt-review-readiness-gate.js',
  'cobolt-review-governance.js',
  'cobolt-review-handoff.js',
  'cobolt-review-tool-rollup.js',
  'cobolt-finding-dedup.js',
  'cobolt-finding-verifier.js',
  'cobolt-agent-dispatch-ledger.js',
  'cobolt-agent-failure-review.js',
  // Added v0.66+ — close registration-gap class for review pipeline tools.
  'cobolt-prd-semantic-review.js',
  'cobolt-human-review-packet.js',
  'cobolt-build-review-step.js',
  'cobolt-plan-review.js',
  'cobolt-review-step.js',
  'cobolt-review-fr-coverage.js',
  'cobolt-review-handoff-fidelity.js',
  'cobolt-review-file-manifest.js',
];

const FAILURE_INCLUDE = '{{COBOLT_INCLUDE:skills/_shared/agent-failure-output.md}}';
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

function parseArgs(argv) {
  const out = {
    command: 'check',
    root: process.cwd(),
    project: null,
    json: false,
    help: false,
    keepTemp: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--keep-temp') out.keepTemp = true;
    else if (arg === '--dir' || arg === '--root') {
      out.root = argv[i + 1] || out.root;
      i += 1;
    } else if (arg === '--project') {
      out.project = argv[i + 1] || out.project;
      i += 1;
    } else if (arg.startsWith('--dir=')) out.root = arg.slice('--dir='.length);
    else if (arg.startsWith('--root=')) out.root = arg.slice('--root='.length);
    else if (arg.startsWith('--project=')) out.project = arg.slice('--project='.length);
    else if (arg.startsWith('--')) out.unknown = arg;
    else positional.push(arg);
  }
  if (positional.length > 0) out.command = positional[0];
  return out;
}

function printUsage() {
  console.log('Usage:');
  console.log('  node tools/cobolt-review-pipeline-audit.js check [--dir <repo>] [--json]');
  console.log('  node tools/cobolt-review-pipeline-audit.js probe [--dir <repo>] [--project <app>] [--json]');
  console.log();
  console.log('Validates cobolt-review source contracts: graph, tools, hooks, gates, agents, ACLs, and artifacts.');
}

function readText(root, relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function exists(root, relPath) {
  return fs.existsSync(path.join(root, relPath));
}

function parseJson(root, relPath) {
  return JSON.parse(readText(root, relPath));
}

function parseFrontmatter(markdown) {
  const match = String(markdown || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const out = {};
  let currentArrayKey = null;
  for (const line of match[1].split(/\r?\n/)) {
    if (currentArrayKey) {
      const item = line.match(/^\s*-\s+(.+?)\s*$/);
      if (item) {
        out[currentArrayKey].push(item[1].trim().replace(/^['"]|['"]$/g, ''));
        continue;
      }
      currentArrayKey = null;
    }
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim();
    if (!value) {
      out[m[1]] = [];
      currentArrayKey = m[1];
    } else {
      out[m[1]] = value.replace(/^['"]|['"]$/g, '');
    }
  }
  return out;
}

function splitTools(value) {
  return String(value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function extractArrayStrings(source, key) {
  const lines = String(source || '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes(`${key}: [`) || line.includes(`${key} = [`));
  if (start === -1) return new Set();
  const bodyLines = [];
  for (let i = start; i < lines.length; i += 1) {
    bodyLines.push(lines[i]);
    if (i > start && /^\s*];/.test(lines[i])) break;
  }
  const body = bodyLines.join('\n');
  return new Set([...body.matchAll(/^\s*'([^']+)'/gm)].map((m) => m[1]));
}

function buildModelTierIndex(modelConfig) {
  const index = new Map();
  for (const [tier, agents] of Object.entries(modelConfig['agent-tiers'] || {})) {
    for (const agent of agents || []) index.set(agent, tier);
  }
  return index;
}

function extractScriptRefs(text) {
  return [...new Set([...String(text).matchAll(/\b(cobolt-[a-z0-9-]+\.js)\b/g)].map((m) => m[1]))].sort();
}

function extractIndexToolRefs(text) {
  const refs = new Set();
  for (const match of String(text).matchAll(/tools\/index\.js\s+([a-z0-9-]+)/g)) refs.add(match[1]);
  return [...refs].sort();
}

function addCheck(report, section, name, ok, message, detail = {}) {
  const check = { section, name, ok: Boolean(ok), message, ...detail };
  report.checks.push(check);
  if (!ok) report.issues.push(check);
  return check;
}

function findToolFile(root, file) {
  const candidates = [
    path.join('tools', file),
    path.join('lib', file),
    path.join('source', 'hooks', file),
    path.join('source', 'hooks', 'dist', file),
    path.join('source', 'plugins', file),
  ];
  return candidates.find((candidate) => exists(root, candidate)) || null;
}

function agentAllowedInReview(agent, dispatchAcl) {
  const reviewAcl = new Set(dispatchAcl._testOnly.STAGE_ACL.review || []);
  const cross = new Set(dispatchAcl._testOnly.CROSS_STAGE_AGENTS || []);
  const sidecar = new Set(dispatchAcl._testOnly.SIDECAR_ESCALATION_AGENTS || []);
  return reviewAcl.has(agent) || cross.has(agent) || sidecar.has(agent);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteJSON(filePath, value);
}

function tail(value, max = 1200) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

function makeProbeReport(root, project) {
  return {
    ok: true,
    repoRoot: path.resolve(root),
    projectRoot: project ? path.resolve(project) : null,
    generatedAt: new Date().toISOString(),
    tempRoot: null,
    stages: [],
    checks: [],
    issues: [],
    limitations: [
      {
        component: 'LLM subagent execution',
        status: 'contract-verified',
        reason:
          'This local harness cannot deterministically run hosted LLM subagents. It verifies agent files, frontmatter, model tier, ACLs, write guards, reviewer prompt gate, dispatch ledger, failure contracts, and stage wiring instead.',
      },
    ],
  };
}

function addProbe(report, stageId, component) {
  const entry = {
    stage: stageId,
    ...component,
    ok: component.ok !== false,
  };
  report.checks.push(entry);
  if (!report.stages.some((stage) => stage.id === stageId)) report.stages.push({ id: stageId, components: [] });
  report.stages.find((stage) => stage.id === stageId).components.push(entry);
  if (!entry.ok) {
    report.ok = false;
    report.issues.push(entry);
  }
  return entry;
}

function runProbeCommand(report, stageId, component, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || report.repoRoot,
    encoding: 'utf8',
    input: options.input,
    env: { ...process.env, ...(options.env || {}) },
    timeout: options.timeout || 120000,
    windowsHide: true,
  });
  const expectedStatuses = options.expectedStatuses || [0];
  const statusOk = expectedStatuses.includes(result.status);
  let predicateOk = true;
  let parsed = null;
  if (options.parseJson) {
    try {
      parsed = JSON.parse(result.stdout || '{}');
    } catch (err) {
      predicateOk = false;
      parsed = { parseError: err.message };
    }
  }
  if (typeof options.expect === 'function') {
    try {
      predicateOk = Boolean(options.expect({ result, parsed }));
    } catch {
      predicateOk = false;
    }
  }
  return addProbe(report, stageId, {
    component,
    status: 'executed',
    ok: statusOk && predicateOk,
    command: [command, ...args].join(' '),
    exitCode: result.status,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
    parsed,
  });
}

function createComponentFixture() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cobolt-review-component-probe-'));
  const projectRoot = path.join(tempRoot, 'project');
  const reviewDir = path.join(projectRoot, '_cobolt-output', 'latest', 'review');
  const reportsDir = path.join(projectRoot, '_cobolt-output', 'reports', 'M1');
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });

  const source = [
    'const clockToken = "review_component_probe";',
    'function renderClockZone(zone) {',
    '  const normalizedZone = zone || "UTC";',
    '  return "clock:" + normalizedZone + ":" + clockToken;',
    '}',
    'module.exports = { renderClockZone };',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(projectRoot, 'src', 'app.js'), source, 'utf8');
  writeJson(path.join(projectRoot, 'cobolt-state.json'), {
    currentMilestone: 'M1',
    currentStage: 'reviewing',
    pipeline: { currentMilestone: 'M1', currentStage: 'reviewing' },
    build: { currentMilestone: 'M1', currentStep: '05-review' },
    review: { currentMilestone: 'M1', buildPipeline: true },
  });

  const findings = BASELINE_REVIEWERS.map((reviewer, index) => ({
    id: `${reviewer.prefix.replace(/[^A-Z]/g, '')}${String(index + 1).padStart(3, '0')}`,
    prefix: reviewer.prefix,
    severity: 'low',
    category: 'component-probe',
    title: `${reviewer.prefix} component probe finding`,
    description: 'renderClockZone normalizedZone clockToken review_component_probe source evidence',
    location: { file: 'src/app.js', line: 2 },
    evidence: {
      codeSnippet: 'function renderClockZone(zone) {',
      grepEvidence: 'renderClockZone normalizedZone clockToken',
      toolCalls: [],
    },
    reviewerAgent: reviewer.agent,
  }));

  const byPrefix = Object.fromEntries(BASELINE_REVIEWERS.map((reviewer) => [reviewer.prefix, 1]));
  const reviewFindings = {
    version: '1.0.0',
    milestone: 'M1',
    reviewers: BASELINE_REVIEWERS.map((reviewer) => reviewer.agent),
    summary: {
      total: findings.length,
      bySeverity: { critical: 0, high: 0, medium: 0, low: findings.length },
      byPrefix,
    },
    findings,
  };
  const verification = {
    generatedAt: new Date().toISOString(),
    version: 3,
    config: { sampleRate: 100, strict: true, autoStrip: false },
    stats: { total: findings.length, verified: findings.length, unverified: 0, rejected: 0 },
    hallucination: { estimatedRate: 0, pattern: 'component-probe' },
    results: findings.map((finding) => ({
      id: finding.id,
      status: 'verified',
      confidence: 1,
      flags: [],
    })),
  };

  writeJson(path.join(reviewDir, '00-source-file-manifest.json'), {
    version: '1.0.0',
    root: projectRoot,
    files: ['src/app.js'],
    totalFiles: 1,
  });
  writeJson(path.join(reviewDir, 'review-manifest.json'), {
    version: '2.0.0',
    reviewId: 'M1',
    milestone: 'M1',
    mode: 'pipeline',
    dispatched: BASELINE_REVIEWERS.map((reviewer) => reviewer.agent),
    completed: BASELINE_REVIEWERS.map((reviewer) => reviewer.agent),
    failed: [],
    reviewedFiles: ['src/app.js'],
    findingsFiles: ['review-findings.json'],
  });
  writeJson(path.join(reviewDir, 'M1-review-packet.json'), {
    version: '2.0.0',
    projectRoot,
    reviewDir,
    reviewId: 'M1',
    milestone: 'M1',
    mode: 'pipeline',
    sourceManifest: { path: '00-source-file-manifest.json', totalFiles: 1 },
    scope: {
      totalFiles: 1,
      changedFiles: ['src/app.js'],
      filesInScope: ['src/app.js'],
      categories: { other: ['src/app.js'] },
    },
  });
  writeJson(path.join(reviewDir, 'raw-findings.json'), reviewFindings);
  writeJson(path.join(reviewDir, 'all-findings.json'), reviewFindings);
  writeJson(path.join(reviewDir, 'deduped-findings.json'), reviewFindings);
  writeJson(path.join(reviewDir, 'review-findings.json'), reviewFindings);
  writeJson(path.join(reviewDir, 'finding-verification.json'), verification);
  writeJson(path.join(reviewDir, 'failures-summary.json'), {
    gate_failures: [],
    reviewer_failures: [],
    blocking_findings: [],
    verification_failures: [],
  });
  writeJson(path.join(reviewDir, 'cross-validation-report.json'), {
    analyzedAt: new Date().toISOString(),
    totalFindings: findings.length,
    afterDedup: findings.length,
    verified: findings.length,
    phantom: 0,
    phantomRate: 0,
    coverageGaps: [],
    contradictions: [],
    rejectedReviewers: [],
  });
  atomicWrite(
    path.join(reportsDir, 'M1-review-report.md'),
    `# M1 Review Report\n\nKnown finding IDs: ${findings.map((finding) => finding.id).join(', ')}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );

  return { tempRoot, projectRoot, reviewDir };
}

function probeReviewComponents(options = {}) {
  const repoRoot = path.resolve(options.root || process.cwd());
  const report = makeProbeReport(repoRoot, options.project);
  const fixture = createComponentFixture();
  report.tempRoot = fixture.tempRoot;

  const fixtureReviewDir = fixture.reviewDir;
  const testProject = options.project ? path.resolve(options.project) : fixture.projectRoot;
  const testProjectReviewDir = path.join(fixture.tempRoot, 'test-project-review');

  runProbeCommand(report, '00-preflight', 'CLI review command-local help', process.execPath, [
    path.join(repoRoot, 'cli', 'index.js'),
    'review',
    '--help',
  ]);
  runProbeCommand(
    report,
    '00-preflight',
    'dispatch ACL approves review reviewer',
    process.execPath,
    [path.join(repoRoot, 'source', 'hooks', 'cobolt-dispatch-acl.js')],
    {
      cwd: fixture.projectRoot,
      input: JSON.stringify({ tool_name: 'Agent', tool_input: { subagent_type: 'code-reviewer' } }),
      parseJson: true,
      expect: ({ parsed }) => parsed.action === 'approve',
    },
  );
  runProbeCommand(
    report,
    '00-preflight',
    'dispatch ACL blocks wrong-stage reviewer',
    process.execPath,
    [path.join(repoRoot, 'source', 'hooks', 'cobolt-dispatch-acl.js')],
    {
      cwd: fixture.projectRoot,
      input: JSON.stringify({ tool_name: 'Agent', tool_input: { subagent_type: 'backend-dev' } }),
      parseJson: true,
      expect: ({ parsed }) => parsed.action === 'block',
    },
  );
  runProbeCommand(report, '00-preflight', 'model-tier gate blocks downgrade', process.execPath, [
    '-e',
    "const gate=require('./source/hooks/cobolt-model-tier-gate'); const r=gate.run({tool_name:'Agent', tool_input:{subagent_type:'review-lead', model:'haiku'}}); console.log(JSON.stringify(r)); process.exit(r.action==='block'?0:1);",
  ]);
  runProbeCommand(report, '00-preflight', 'subagent write guard blocks nested writer', process.execPath, [
    '-e',
    "const gate=require('./source/hooks/cobolt-subagent-write-guard'); const r=gate.shouldBlock({tool_name:'Agent', tool_input:{subagent_type:'cobolt-fix-agent', prompt:'write files'}},2,{teamActive:false}); console.log(JSON.stringify(r)); process.exit(r.blocked?0:1);",
  ]);

  runProbeCommand(
    report,
    '01-review-packet',
    'fixture review packet build',
    process.execPath,
    [
      path.join(repoRoot, 'tools', 'cobolt-review-packet.js'),
      'build',
      '--dir',
      fixture.projectRoot,
      '--review-dir',
      fixtureReviewDir,
      '--review-id',
      'M1',
      '--milestone',
      'M1',
      '--mode',
      'pipeline',
      '--json',
    ],
    { parseJson: true, expect: ({ parsed }) => Boolean(parsed.packetPath && parsed.manifestPath) },
  );
  if (fs.existsSync(testProject)) {
    runProbeCommand(
      report,
      '01-review-packet',
      'provided project review packet build',
      process.execPath,
      [
        path.join(repoRoot, 'tools', 'cobolt-review-packet.js'),
        'build',
        '--dir',
        testProject,
        '--review-dir',
        testProjectReviewDir,
        '--review-id',
        'M1',
        '--milestone',
        'M1',
        '--mode',
        'pipeline',
        '--json',
      ],
      { parseJson: true, expect: ({ parsed }) => Boolean(parsed.packetPath && parsed.manifestPath) },
    );
  } else {
    addProbe(report, '01-review-packet', {
      component: 'provided project review packet build',
      status: 'skipped',
      ok: false,
      reason: `Project path does not exist: ${testProject}`,
    });
  }

  // Restore the full synthetic fixture after packet generation rewrites the manifest.
  const refreshedFixture = createComponentFixture();
  fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  report.tempRoot = refreshedFixture.tempRoot;
  const reviewDir = refreshedFixture.reviewDir;
  const projectRoot = refreshedFixture.projectRoot;

  runProbeCommand(
    report,
    '02-wave-1',
    'reviewer prompt gate approves code-injected dispatch',
    process.execPath,
    [path.join(repoRoot, 'source', 'hooks', 'cobolt-reviewer-gate.js')],
    {
      cwd: projectRoot,
      input: JSON.stringify({
        tool_name: 'Agent',
        tool_input: {
          subagent_type: 'code-reviewer',
          prompt: [
            'file: src/app.js',
            '```js',
            'const clockToken = "review_component_probe";',
            'function renderClockZone(zone) {',
            '  const normalizedZone = zone || "UTC";',
            '  return "clock:" + normalizedZone + ":" + clockToken;',
            '}',
            'module.exports = { renderClockZone };',
            '```',
          ].join('\n'),
        },
      }),
      parseJson: true,
      expect: ({ parsed }) => parsed.action === 'approve',
    },
  );
  runProbeCommand(
    report,
    '02-wave-1',
    'dispatch ledger append pass',
    process.execPath,
    [
      path.join(repoRoot, 'tools', 'cobolt-agent-dispatch-ledger.js'),
      'append',
      '--skill',
      'cobolt-review',
      '--stage',
      '02-wave-1',
      '--agent',
      'code-reviewer',
      '--verdict',
      'pass',
      '--findings-resolved',
      '0',
      '--json',
    ],
    { cwd: projectRoot, parseJson: true, expect: ({ parsed }) => parsed.ok === true },
  );
  runProbeCommand(
    report,
    '02-wave-1',
    'dispatch ledger census',
    process.execPath,
    [
      path.join(repoRoot, 'tools', 'cobolt-agent-dispatch-ledger.js'),
      'census',
      '--skill',
      'cobolt-review',
      '--expected',
      '1',
      '--json',
    ],
    { cwd: projectRoot, parseJson: true, expect: ({ parsed }) => parsed.ok === true },
  );

  runProbeCommand(
    report,
    '03-wave-2',
    'dispatch ledger append escalation context',
    process.execPath,
    [
      path.join(repoRoot, 'tools', 'cobolt-agent-dispatch-ledger.js'),
      'append',
      '--skill',
      'cobolt-review',
      '--stage',
      '03-wave-2',
      '--agent',
      'security-reviewer',
      '--verdict',
      'fail',
      '--escalation-target',
      'review-lead',
      '--failure-artifact',
      path.join(reviewDir, 'security-reviewer-failure.json'),
      '--json',
    ],
    { cwd: projectRoot, parseJson: true, expect: ({ parsed }) => parsed.ok === true },
  );
  runProbeCommand(
    report,
    '03-wave-2',
    'agent failure review tool executes',
    process.execPath,
    [path.join(repoRoot, 'tools', 'cobolt-agent-failure-review.js'), '--cwd', projectRoot, '--json'],
    {
      cwd: projectRoot,
      parseJson: true,
      expect: ({ parsed }) => ['clear', 'failures-detected'].includes(parsed.status),
    },
  );

  runProbeCommand(
    report,
    '04-cross-validation',
    'finding dedup executes',
    process.execPath,
    [
      path.join(repoRoot, 'tools', 'cobolt-finding-dedup.js'),
      'dedup',
      '--input',
      path.join(reviewDir, 'raw-findings.json'),
      '--output',
      path.join(reviewDir, 'deduped-findings.json'),
      '--json',
    ],
    { parseJson: true, expect: ({ parsed }) => Number(parsed.unique || 0) > 0 },
  );
  runProbeCommand(
    report,
    '04-cross-validation',
    'finding verifier executes',
    process.execPath,
    [
      path.join(repoRoot, 'tools', 'cobolt-finding-verifier.js'),
      '--findings',
      path.join(reviewDir, 'review-findings.json'),
      '--output',
      path.join(reviewDir, 'finding-verification.json'),
      '--project-root',
      projectRoot,
      '--no-auto-strip',
    ],
    { cwd: projectRoot, expect: () => fs.existsSync(path.join(reviewDir, 'finding-verification.json')) },
  );
  runProbeCommand(
    report,
    '04-cross-validation',
    'review tool rollup executes',
    process.execPath,
    [
      path.join(repoRoot, 'tools', 'cobolt-review-tool-rollup.js'),
      '--review-dir',
      reviewDir,
      '--output',
      path.join(reviewDir, 'review-findings.json'),
      '--merge',
      '--json',
    ],
    { parseJson: true, expect: ({ parsed }) => parsed.ok === true },
  );

  runProbeCommand(
    report,
    '05-coverage-gap',
    'review coverage executes',
    process.execPath,
    [
      path.join(repoRoot, 'tools', 'cobolt-review-coverage.js'),
      'check',
      '--dir',
      reviewDir,
      '--review-id',
      'M1',
      '--json',
    ],
    { parseJson: true, expect: ({ parsed }) => parsed.passed === true },
  );
  runProbeCommand(
    report,
    '05-coverage-gap',
    'review evidence index executes',
    process.execPath,
    [path.join(repoRoot, 'tools', 'cobolt-review-evidence-index.js'), 'build', '--dir', reviewDir, '--json'],
    { parseJson: true, expect: ({ parsed }) => parsed.integrity?.valid === true && parsed.artifactCount > 0 },
  );
  runProbeCommand(
    report,
    '05-coverage-gap',
    'review accuracy executes',
    process.execPath,
    [path.join(repoRoot, 'tools', 'cobolt-review-accuracy.js'), 'check', '--dir', reviewDir, '--json'],
    { parseJson: true, expect: ({ parsed }) => parsed.passed === true },
  );
  runProbeCommand(
    report,
    '05-coverage-gap',
    'review readiness gate executes',
    process.execPath,
    [path.join(repoRoot, 'tools', 'cobolt-review-readiness-gate.js'), 'check', '--dir', reviewDir, '--json'],
    { parseJson: true, expect: ({ parsed }) => parsed.passed === true },
  );

  runProbeCommand(
    report,
    '06-report-handoff',
    'review governance executes',
    process.execPath,
    [
      path.join(repoRoot, 'tools', 'cobolt-review-governance.js'),
      'build',
      '--dir',
      reviewDir,
      '--json',
      '--build-pipeline',
    ],
    { parseJson: true, expect: ({ parsed }) => Boolean(parsed.artifacts?.releaseGate && parsed.files?.releaseGate) },
  );
  runProbeCommand(
    report,
    '06-report-handoff',
    'review handoff executes',
    process.execPath,
    [
      path.join(repoRoot, 'tools', 'cobolt-review-handoff.js'),
      'build',
      '--dir',
      reviewDir,
      '--json',
      '--build-pipeline',
    ],
    { parseJson: true, expect: ({ parsed }) => parsed.recommendedNextStep?.skill === 'cobolt-fix' },
  );
  runProbeCommand(
    report,
    '06-report-handoff',
    'reviewer completeness hook approves complete review',
    process.execPath,
    [path.join(repoRoot, 'source', 'hooks', 'cobolt-reviewer-completeness.js')],
    {
      cwd: projectRoot,
      input: JSON.stringify({ tool_name: 'Skill', tool_input: { skill: 'cobolt-fix' } }),
      parseJson: true,
      expect: ({ parsed }) => parsed.action === 'approve',
    },
  );

  addProbe(report, '02-wave-1', {
    component: 'baseline reviewer subagent execution',
    status: 'contract-verified',
    ok: true,
    count: BASELINE_REVIEWERS.filter((reviewer) => reviewer.wave === 1).length,
    reason:
      'Local deterministic harness verifies dispatch ACL/model/tools/failure contracts; hosted subagent bodies are not run locally.',
  });
  addProbe(report, '03-wave-2', {
    component: 'baseline reviewer subagent execution',
    status: 'contract-verified',
    ok: true,
    count: BASELINE_REVIEWERS.filter((reviewer) => reviewer.wave === 2).length,
    reason:
      'Local deterministic harness verifies dispatch ACL/model/tools/failure contracts; hosted subagent bodies are not run locally.',
  });

  report.summary = {
    stages: report.stages.length,
    components: report.checks.length,
    executed: report.checks.filter((check) => check.status === 'executed').length,
    contractVerified: report.checks.filter((check) => check.status === 'contract-verified').length,
    skipped: report.checks.filter((check) => check.status === 'skipped').length,
    failures: report.issues.length,
  };

  if (!options.keepTemp) {
    // Keep enough path evidence in the report, but remove generated temp files.
    for (const root of [report.tempRoot, testProjectReviewDir]) {
      try {
        if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }

  return report;
}

function auditReviewPipeline(root = process.cwd()) {
  const repoRoot = path.resolve(root);
  const report = {
    ok: true,
    repoRoot,
    generatedAt: new Date().toISOString(),
    graph: {
      entrypoints: [
        'cobolt-cli review',
        'cli/index.js',
        'cli/commands/review.js',
        'cli/lib/review-loop.js',
        'source/skills/cobolt-review/SKILL.md',
      ],
      stages: [],
      handoffs: [],
      subPipelines: ['cobolt-fix', 'cobolt-pentest', 'cobolt-milestone-validate'],
      loops: [
        'pre-flight gate recovery: 2 attempts',
        'step autonomous recovery: 2 repair attempts',
        'codex retry per step: maxRetries=2',
        'handoff advisory retry: 1 retry',
      ],
      terminalConditions: ['standalone-report', 'fix-handoff', 'pentest-handoff', 'milestone-validate-handoff'],
    },
    checks: [],
    issues: [],
    stages: [],
    tools: [],
    hooks: [],
    agents: [],
    gates: [],
  };

  for (const relPath of [
    'cli/index.js',
    'cli/commands/review.js',
    'cli/lib/review-loop.js',
    'cli/lib/gate-runner.js',
    'source/skills/cobolt-review/SKILL.md',
    'source/skills/cobolt-review/references/review-team.md',
    'source/skills/cobolt-review/references/finding-prefixes.md',
    'lib/cobolt-reviewer-registry.js',
    'source/hooks/cobolt-pre-dispatch.js',
    'source/hooks/cobolt-post-dispatch.js',
    'source/hooks/cobolt-dispatch-acl.js',
    'source/hooks/cobolt-model-tier-gate.js',
    'source/hooks/cobolt-subagent-write-guard.js',
    'source/templates/model-config.json',
    'tools/index.js',
  ]) {
    addCheck(report, 'entrypoint', relPath, exists(repoRoot, relPath), `${relPath} exists`);
  }

  if (report.issues.length > 0) {
    report.ok = false;
    return report;
  }

  const cliIndex = readText(repoRoot, 'cli/index.js');
  const cliReview = readText(repoRoot, 'cli/commands/review.js');
  const reviewLoopSource = readText(repoRoot, 'cli/lib/review-loop.js');
  const reviewSkill = readText(repoRoot, 'source/skills/cobolt-review/SKILL.md');
  const reviewTeam = readText(repoRoot, 'source/skills/cobolt-review/references/review-team.md');
  const findingPrefixes = readText(repoRoot, 'source/skills/cobolt-review/references/finding-prefixes.md');
  const preDispatch = readText(repoRoot, 'source/hooks/cobolt-pre-dispatch.js');
  const postDispatch = readText(repoRoot, 'source/hooks/cobolt-post-dispatch.js');
  const modelConfig = parseJson(repoRoot, 'source/templates/model-config.json');

  const reviewLoop = require(path.join(repoRoot, 'cli', 'lib', 'review-loop.js'));
  const gateRunner = require(path.join(repoRoot, 'cli', 'lib', 'gate-runner.js'));
  const toolsIndex = require(path.join(repoRoot, 'tools', 'index.js'));
  const dispatchAcl = require(path.join(repoRoot, 'source', 'hooks', 'cobolt-dispatch-acl.js'));
  const rollup = require(path.join(repoRoot, 'tools', 'cobolt-review-tool-rollup.js'));

  addCheck(
    report,
    'entrypoint',
    'CLI root wires review',
    /commands\/review|\.\/commands\/review/.test(cliIndex),
    'CLI root wires review command',
  );
  for (const symbol of [
    'parseReviewArgs',
    'runReviewStepWithAutonomousRecovery',
    'chainFromReviewHandoff',
    'buildReviewGroundingContext',
    'recoverAutonomousReviewGates',
    'emitStageSurfaces',
  ]) {
    addCheck(
      report,
      'entrypoint',
      `cli/commands/review.js ${symbol}`,
      cliReview.includes(symbol),
      `Review wrapper references ${symbol}`,
    );
  }

  report.graph.stages = reviewLoop.REVIEW_STEPS.map((step) => `${step.id}-${step.file.replace(/^\d+-|\.md$/g, '')}`);
  report.graph.handoffs = reviewLoop.REVIEW_STEPS.slice(0, -1).map((step, index) => [
    step.id,
    reviewLoop.REVIEW_STEPS[index + 1].id,
  ]);
  report.graph.handoffs.push(['06', 'review-handoff.json -> cobolt-fix|cobolt-pentest|cobolt-milestone-validate']);

  addCheck(
    report,
    'graph',
    '7 review wrapper steps',
    reviewLoop.REVIEW_STEPS.length === 7,
    `Wrapper reports ${reviewLoop.REVIEW_STEPS.length} executable review steps`,
  );
  addCheck(
    report,
    'graph',
    'review steps are 00-06',
    JSON.stringify(reviewLoop.REVIEW_STEPS.map((step) => step.id)) ===
      JSON.stringify(['00', '01', '02', '03', '04', '05', '06']),
    'Review step ids are contiguous from 00 through 06',
  );
  addCheck(
    report,
    'graph',
    '23 baseline reviewer agents',
    BASELINE_REVIEWERS.length === 23,
    `Reviewer registry declares ${BASELINE_REVIEWERS.length} baseline reviewer agents`,
  );
  addCheck(
    report,
    'graph',
    '23 baseline prefixes',
    BASELINE_PREFIXES.length === 23,
    `Reviewer registry declares ${BASELINE_PREFIXES.length} baseline prefixes`,
  );

  for (const reviewStep of reviewLoop.REVIEW_STEPS) {
    const stepPath = path.join('source', 'skills', 'cobolt-review', 'steps', reviewStep.file);
    const stepExists = exists(repoRoot, stepPath);
    addCheck(report, 'stage', `${reviewStep.id} step file`, stepExists, `${stepPath} exists`);
    if (!stepExists) continue;
    const text = readText(repoRoot, stepPath);
    const stage = {
      id: reviewStep.id,
      file: stepPath,
      label: reviewStep.label,
      timeout: reviewStep.timeout,
      artifacts: reviewStep.artifacts,
      tools: extractScriptRefs(text).filter((file) => findToolFile(repoRoot, file)),
      agents: [
        ...new Set(
          [...text.matchAll(/`([a-z0-9-]+(?:-reviewer|-advisor|-agent|-lead|-linter|-auditor))`/gi)].map((m) => m[1]),
        ),
      ].sort(),
    };
    report.stages.push(stage);
    addCheck(
      report,
      'stage',
      `${reviewStep.id} referenced by skill`,
      reviewSkill.includes(reviewStep.file),
      `${reviewStep.file} is referenced by SKILL.md`,
    );
    addCheck(
      report,
      'stage',
      `${reviewStep.id} required outputs`,
      /Required Outputs/i.test(text),
      `${reviewStep.file} documents required outputs`,
    );
    addCheck(
      report,
      'stage',
      `${reviewStep.id} procedure`,
      /Procedure/i.test(text),
      `${reviewStep.file} documents procedure`,
    );
    addCheck(
      report,
      'stage',
      `${reviewStep.id} artifact contract`,
      Array.isArray(reviewStep.artifacts) && reviewStep.artifacts.length > 0,
      `${reviewStep.id} has expected artifact contract`,
    );
    addCheck(
      report,
      'stage',
      `${reviewStep.id} proof artifact`,
      reviewStep.artifacts.some((artifact) => artifact.endsWith('.proof.json')),
      `${reviewStep.id} has a proof artifact`,
    );
    for (const artifact of reviewStep.artifacts) {
      addCheck(
        report,
        'artifact',
        `${reviewStep.id}:${artifact}`,
        artifact.includes('{m}') || !/reports\/\{m\}|proofs\/\{m\}|review\/\{m\}/.test(artifact),
        `${reviewStep.id} artifact path is explicitly scoped or intentionally global: ${artifact}`,
      );
    }
  }

  const waveText = [
    readText(repoRoot, 'source/skills/cobolt-review/steps/02-wave-1.md'),
    readText(repoRoot, 'source/skills/cobolt-review/steps/03-wave-2.md'),
  ].join('\n');
  for (const reviewer of BASELINE_REVIEWERS) {
    addCheck(
      report,
      'stage',
      `${reviewer.agent} wave coverage`,
      waveText.includes(`\`${reviewer.agent}\``),
      `${reviewer.agent} is assigned in a review wave step`,
    );
  }
  for (const specialist of OPTIONAL_SPECIALISTS) {
    addCheck(
      report,
      'stage',
      `${specialist} optional coverage`,
      waveText.includes(`\`${specialist}\``),
      `${specialist} is listed as a review optional specialist`,
    );
  }

  addCheck(
    report,
    'recovery',
    'autonomous step recovery loop exists',
    reviewLoopSource.includes('runReviewStepWithAutonomousRecovery') &&
      reviewLoopSource.includes('Autonomous Review Step Repair'),
    'Review wrapper repairs and retries failed steps',
  );
  addCheck(
    report,
    'recovery',
    'previous artifact chain guard exists',
    reviewLoopSource.includes('verifyPreviousArtifactChain') && reviewLoopSource.includes('writeStepArtifactChain'),
    'Review wrapper verifies predecessor artifact chains',
  );
  addCheck(
    report,
    'recovery',
    'handoff advisory recovery exists',
    cliReview.includes('review-handoff-chain') && cliReview.includes('runAutonomousAdvisoryDecision'),
    'Review wrapper escalates failed handoff chains through advisory recovery',
  );
  addCheck(
    report,
    'handoff',
    'build-pipeline review always enters fix',
    reviewLoop.buildPipelineReviewNextStep({ reviewIntegrity: { passed: true } }, 'M1', { milestone: 'M1' }).skill ===
      'cobolt-fix',
    'Build-pipeline review hands off through cobolt-fix even when clean',
  );

  const standaloneGates = gateRunner.getGates('review', 'M1', path.join(repoRoot, 'tools'), { mode: 'standalone' });
  const buildPipelineGates = gateRunner.getGates('review', 'M1', path.join(repoRoot, 'tools'), {
    mode: 'pipeline',
    buildPipeline: true,
  });
  const postBuildGates = gateRunner.getGates('review', 'M1', path.join(repoRoot, 'tools'), {
    mode: 'pipeline',
    buildPipeline: false,
  });
  report.gates = buildPipelineGates.map((gate) => ({ name: gate.name, hard: Boolean(gate.hard) }));
  for (const gateName of REQUIRED_REVIEW_GATE_NAMES) {
    const gate = standaloneGates.find((entry) => entry.name === gateName);
    addCheck(report, 'gate', gateName, Boolean(gate), `Review preflight gate exists: ${gateName}`);
    addCheck(report, 'gate', `${gateName} hard`, gate?.hard === true, `Review preflight gate is hard: ${gateName}`);
  }
  for (const gateName of REQUIRED_BUILD_PIPELINE_GATE_NAMES) {
    const gate = buildPipelineGates.find((entry) => entry.name === gateName);
    addCheck(report, 'gate', gateName, Boolean(gate), `Build-pipeline review gate exists: ${gateName}`);
    addCheck(
      report,
      'gate',
      `${gateName} hard`,
      gate?.hard === true,
      `Build-pipeline review gate is hard: ${gateName}`,
    );
  }
  for (const gateName of REQUIRED_POST_BUILD_GATE_NAMES) {
    const gate = postBuildGates.find((entry) => entry.name === gateName);
    addCheck(report, 'gate', gateName, Boolean(gate), `Post-build review gate exists: ${gateName}`);
    addCheck(report, 'gate', `${gateName} hard`, gate?.hard === true, `Post-build review gate is hard: ${gateName}`);
  }

  const allReviewText = [
    reviewSkill,
    reviewTeam,
    findingPrefixes,
    ...reviewLoop.REVIEW_STEPS.map((step) =>
      readText(repoRoot, path.join('source/skills/cobolt-review/steps', step.file)),
    ),
  ].join('\n');
  const registeredToolNames = new Set(Object.keys(toolsIndex.TOOLS || {}));
  const registeredToolFiles = new Set(Object.values(toolsIndex.TOOLS || {}).map((entry) => path.basename(entry.file)));
  for (const file of [...new Set([...REQUIRED_REVIEW_TOOLS, ...extractScriptRefs(allReviewText)])].sort()) {
    const found = findToolFile(repoRoot, file);
    report.tools.push({ file, exists: Boolean(found), path: found });
    addCheck(report, 'tool', file, Boolean(found), `Referenced review script exists: ${file}`);
    if (found?.startsWith('tools')) {
      addCheck(
        report,
        'tool-registry',
        `${file} registered`,
        registeredToolFiles.has(file),
        `${file} is registered in tools/index.js`,
      );
    }
  }
  for (const toolName of extractIndexToolRefs(allReviewText)) {
    addCheck(
      report,
      'tool-registry',
      `tools/index.js ${toolName}`,
      registeredToolNames.has(toolName),
      `tools/index.js registers ${toolName}`,
    );
  }
  addCheck(
    report,
    'tool-registry',
    'review-pipeline-audit tool registered',
    registeredToolNames.has('review-pipeline-audit'),
    'tools/index.js registers this audit harness',
  );
  for (const prefix of BASELINE_PREFIXES) {
    addCheck(
      report,
      'priority-matrix',
      `${prefix} priority row`,
      Boolean(rollup.PRIORITY_MATRIX[prefix]),
      `${prefix} has a priority-matrix row in cobolt-review-tool-rollup`,
    );
  }

  const registeredPreHooks = extractArrayStrings(preDispatch, 'PRE_HOOKS');
  const registeredPostHooks = extractArrayStrings(postDispatch, 'POST_HOOKS');
  for (const hook of REQUIRED_REVIEW_HOOKS) {
    const hookExists = exists(repoRoot, path.join('source', 'hooks', hook));
    const registered = registeredPreHooks.has(hook) || registeredPostHooks.has(hook);
    report.hooks.push({ hook, exists: hookExists, registered });
    addCheck(report, 'hook', `${hook} exists`, hookExists, `Hook file exists: ${hook}`);
    addCheck(report, 'hook', `${hook} registered`, registered, `Hook is registered by pre/post dispatcher: ${hook}`);
  }
  for (const bypassHook of [
    'cobolt-chain-decision-gate.js',
    'cobolt-advisory-consumption-gate.js',
    'cobolt-checkpoint-write-gate.js',
  ]) {
    const text = exists(repoRoot, path.join('source', 'hooks', bypassHook))
      ? readText(repoRoot, path.join('source', 'hooks', bypassHook))
      : '';
    addCheck(
      report,
      'hook',
      `${bypassHook} bypass audit`,
      text.includes('gate-skip-log') || text.includes('bypass') || text.includes('audit'),
      `${bypassHook} records bypass/kill-switch or audit evidence`,
    );
  }

  const tierIndex = buildModelTierIndex(modelConfig);
  for (const agentName of [...new Set(REVIEW_AGENTS)].sort((a, b) => a.localeCompare(b))) {
    const agentPath = path.join('source', 'agents', `${agentName}.md`);
    const agent = { name: agentName, path: agentPath, prefix: REVIEWER_PREFIXES[agentName] || null };
    const agentExists = exists(repoRoot, agentPath);
    addCheck(report, 'agent', `${agentName} exists`, agentExists, `${agentPath} exists`);
    if (!agentExists) {
      report.agents.push(agent);
      continue;
    }

    const content = readText(repoRoot, agentPath);
    const fm = parseFrontmatter(content);
    const tools = splitTools(fm?.tools);
    const hasWriteTool = tools.some((tool) => WRITE_TOOLS.has(tool));
    const hasAgentTool = tools.includes('Agent');
    agent.frontmatter = fm;
    agent.tools = tools;
    agent.hasWriteTool = hasWriteTool;
    agent.hasAgentTool = hasAgentTool;
    report.agents.push(agent);

    addCheck(report, 'agent', `${agentName} frontmatter`, Boolean(fm), `${agentName} has YAML frontmatter`);
    addCheck(
      report,
      'agent',
      `${agentName} name`,
      fm?.name === agentName,
      `${agentName} frontmatter name matches filename`,
    );
    addCheck(
      report,
      'agent',
      `${agentName} mode`,
      fm?.mode === 'subagent',
      `${agentName} is dispatchable with mode: subagent`,
    );
    addCheck(report, 'agent', `${agentName} model`, Boolean(fm?.model), `${agentName} declares a model`);
    addCheck(
      report,
      'agent',
      `${agentName} tier`,
      tierIndex.has(agentName),
      `${agentName} is present in model-config agent tiers`,
    );
    addCheck(
      report,
      'agent',
      `${agentName} read tool`,
      tools.includes('Read'),
      `${agentName} declares Read for grounded review`,
    );
    addCheck(
      report,
      'agent',
      `${agentName} failure output`,
      content.includes(FAILURE_INCLUDE) || /Failure Output Contract/i.test(content),
      `${agentName} includes a failure output contract`,
    );
    addCheck(
      report,
      'agent',
      `${agentName} dispatch ACL`,
      agentAllowedInReview(agentName, dispatchAcl),
      `${agentName} is allowed in review stage or documented sidecar/cross-stage context`,
    );
    if (!WRITE_CAPABLE_REVIEW_AGENTS.has(agentName)) {
      addCheck(
        report,
        'agent',
        `${agentName} read-only tools`,
        !hasWriteTool && !hasAgentTool,
        `${agentName} has no write/edit/orchestration tools`,
      );
    } else {
      addCheck(
        report,
        'agent',
        `${agentName} write-capable context`,
        hasWriteTool || hasAgentTool,
        `${agentName} has explicit artifact-writing or orchestration capability in a valid review context`,
      );
    }
  }

  addCheck(
    report,
    'agent',
    'dispatch ledger mandated',
    reviewSkill.includes('cobolt-agent-dispatch-ledger.js') && reviewSkill.includes('census --skill cobolt-review'),
    'Review skill mandates dispatch ledger census',
  );
  addCheck(
    report,
    'agent',
    'reviewer failure ledger mandated',
    reviewSkill.includes('reviewer-failures.jsonl') && reviewTeam.includes('Failure JSON Contract'),
    'Review skill documents per-reviewer failure records and escalation ledger',
  );

  report.summary = {
    checks: report.checks.length,
    failures: report.issues.length,
    stages: report.stages.length,
    tools: report.tools.length,
    hooks: report.hooks.length,
    agents: report.agents.length,
    gates: report.gates.length,
  };
  report.ok = report.issues.length === 0;
  return report;
}

function printHuman(report) {
  console.log('CoBolt Review Pipeline Audit');
  console.log(`Repo: ${report.repoRoot}`);
  console.log(`Checks: ${report.summary?.checks || report.checks.length}`);
  console.log(`Failures: ${report.summary?.failures || report.issues.length}`);
  console.log();
  console.log('Graph:');
  for (const stage of report.graph.stages) console.log(`  ${stage}`);
  console.log();
  if (report.issues.length === 0) {
    console.log('PASS: Review pipeline source contracts are internally consistent.');
    return;
  }
  console.log('Failures:');
  for (const issue of report.issues) {
    console.log(`  [${issue.section}] ${issue.name}: ${issue.message}`);
  }
}

function printProbeHuman(report) {
  console.log('CoBolt Review Component Probe');
  console.log(`Repo: ${report.repoRoot}`);
  if (report.projectRoot) console.log(`Project: ${report.projectRoot}`);
  console.log(`Components: ${report.summary?.components || report.checks.length}`);
  console.log(`Executed: ${report.summary?.executed || 0}`);
  console.log(`Contract-verified: ${report.summary?.contractVerified || 0}`);
  console.log(`Failures: ${report.summary?.failures || report.issues.length}`);
  console.log();
  for (const stage of report.stages) {
    console.log(`${stage.id}:`);
    for (const component of stage.components) {
      const mark = component.ok ? 'PASS' : 'FAIL';
      console.log(`  ${mark} [${component.status}] ${component.component}`);
    }
  }
  console.log();
  if (report.ok) console.log('PASS: Review deterministic components executed or explicitly contract-verified.');
  else {
    console.log('Failures:');
    for (const issue of report.issues)
      console.log(`  [${issue.stage}] ${issue.component}: ${issue.stderrTail || issue.reason || issue.stdoutTail}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return 0;
  }
  if (args.unknown) {
    console.error(`Unknown option: ${args.unknown}`);
    printUsage();
    return 1;
  }
  if (args.command === 'probe') {
    const report = probeReviewComponents({
      root: args.root,
      project: args.project,
      keepTemp: args.keepTemp,
    });
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printProbeHuman(report);
    return report.ok ? 0 : 1;
  }
  if (args.command !== 'check') {
    console.error(`Unknown command: ${args.command}`);
    printUsage();
    return 1;
  }
  const report = auditReviewPipeline(args.root);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  OPTIONAL_SPECIALISTS,
  REQUIRED_REVIEW_GATE_NAMES,
  REQUIRED_REVIEW_HOOKS,
  REQUIRED_REVIEW_TOOLS,
  REVIEW_AGENTS,
  REVIEW_LEADS,
  auditReviewPipeline,
  extractIndexToolRefs,
  extractScriptRefs,
  parseFrontmatter,
  probeReviewComponents,
  main,
};
