#!/usr/bin/env node

// Deterministic Fix pipeline source-contract audit harness.
// Validates cobolt-fix wiring across CLI, skill steps, tools, hooks, agents,
// dispatch ACLs, model tiers, state/checkpoint handoffs, loop verdicts, and
// required artifacts. This is intentionally source-backed and safe to run
// without mutating a target application.

const fs = require('node:fs');
const path = require('node:path');

const FIX_STEPS = [
  { id: '01', file: '01-recon.md', label: 'Recon', state: 'recon' },
  { id: '02', file: '02-preflight.md', label: 'Preflight and Phantom Filter', state: 'preflight' },
  { id: '03', file: '03-fix-routing.md', label: 'Fix Routing', state: 'routing' },
  { id: '04', file: '04-fix-execution.md', label: 'Fix Execution', state: 'fixing-' },
  { id: '04b', file: '04b-arch-mutate.md', label: 'Architecture Mutation', state: 'arch-mutate' },
  { id: '05', file: '05-verification.md', label: 'Verification', state: 'verifying-' },
  { id: '06', file: '06-rca-generation.md', label: 'RCA Generation', state: 'rca-generation' },
];

const REQUIRED_FIX_TOOLS = [
  'cobolt-preflight.js',
  'cobolt-state.js',
  'cobolt-debt-banner.js',
  'cobolt-embedding-index.js',
  'cobolt-knowledge-graph.js',
  'cobolt-entrypoint-wiring-check.js',
  'cobolt-worker-lifecycle-check.js',
  'cobolt-fix-readiness.js',
  'cobolt-fix-surface-gates.js',
  'cobolt-fix-risk-acceptance.js',
  'cobolt-fix-architecture-approval.js',
  'cobolt-fix-learning-packet.js',
  'cobolt-hotfix-release-contract.js',
  'cobolt-scope-fence.js',
  'cobolt-fix-router.js',
  'cobolt-fix-task-manifest.js',
  'cobolt-fix-evidence.js',
  'cobolt-output-validator.js',
  'cobolt-dispatch-depth.js',
  'cobolt-agent-teams.js',
  'cobolt-agent-dispatch-ledger.js',
  'cobolt-agent-failure-review.js',
  'cobolt-fix-failure-record.js',
  'cobolt-fix-verdict.js',
  'cobolt-fix-loop-plateau.js',
  'cobolt-fix-decay.js',
  'cobolt-dead-ends.js',
  'cobolt-arch-propose.js',
  'cobolt-self-critique.js',
  'cobolt-rca-diff.js',
  'cobolt-gate.js',
  'cobolt-test.js',
  'cobolt-audit.js',
  'cobolt-uat-regression.js',
  'cobolt-standards.js',
  'cobolt-manifest.js',
  'cobolt-context.js',
];

const REQUIRED_FIX_SCRIPTS = [
  'init-finding-tracker.sh',
  'capture-failure-context.sh',
  'create-troubleshooting-dossier.sh',
  'create-minimal-repro.sh',
  'create-hypothesis-log.sh',
  'update-hypothesis-log.sh',
  'capture-iteration-scope.sh',
  'run-verification.sh',
  'run-scoped-reverify.sh',
  'sync-flow-ledger.sh',
  'update-verification-result.sh',
  'update-finding-status.sh',
  'generate-rca.sh',
];

const REQUIRED_FIX_HOOKS = [
  'cobolt-subagent-write-guard.js',
  'cobolt-model-tier-gate.js',
  'cobolt-dispatch-acl.js',
  'cobolt-output-validator.js',
  'cobolt-fix-checkpoint-required.js',
  'cobolt-fix-case-registry-gate.js',
  'cobolt-fix-verdict-write-gate.js',
  'cobolt-plateau-escalation-gate.js',
  'cobolt-phantom-rate-enforcer.js',
  'cobolt-phantom-gate.js',
  'cobolt-phantom-dispatch-gate.js',
  'cobolt-claim-discipline-gate.js',
  'cobolt-claim-discipline.js',
  'cobolt-arch-mutation-gate.js',
  'cobolt-browser-evidence-gate.js',
  'cobolt-exploit-verify-gate.js',
];

const FIX_AGENTS = [
  'cobolt-fix-lead',
  'fix-lead',
  'cobolt-fix-agent',
  'fix-agent',
  'cobolt-backend-fix',
  'cobolt-frontend-fix',
  'cobolt-db-fix',
  'cobolt-compliance-fix',
  'backend-fix',
  'frontend-fix',
  'db-fix',
  'compliance-fix',
  'architect-fix-agent',
  'architecture-reviewer',
  'security-reviewer',
  'cobolt-code-reviewer',
  'code-reviewer',
  'illusion-detector',
  'code-simplifier',
  'fix-critic',
  'critique-lead',
  'review-lead',
  'resolve-lead',
  'recovery-advisor',
];

const READ_ONLY_FIX_AGENTS = new Set([
  'architecture-reviewer',
  'security-reviewer',
  'cobolt-code-reviewer',
  'code-reviewer',
  'illusion-detector',
]);

const WRITE_EXPECTED_FIX_AGENTS = new Set([
  'cobolt-fix-lead',
  'fix-lead',
  'cobolt-fix-agent',
  'fix-agent',
  'cobolt-backend-fix',
  'cobolt-frontend-fix',
  'cobolt-db-fix',
  'cobolt-compliance-fix',
  'backend-fix',
  'frontend-fix',
  'db-fix',
  'compliance-fix',
  'architect-fix-agent',
  'code-simplifier',
  'fix-critic',
  'critique-lead',
  'review-lead',
  'resolve-lead',
  'recovery-advisor',
]);

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const FAILURE_INCLUDE = '{{COBOLT_INCLUDE:skills/_shared/agent-failure-output.md}}';

const REQUIRED_ARTIFACTS = [
  'finding-tracker.json',
  'fix-context.json',
  'fix-task-manifest.json',
  'fix-source-registry.json',
  'fix-case-registry.json',
  'fix-risk-register.json',
  'fix-remediation-plan.json',
  'fix-validation-plan.json',
  'fix-source-proof.json',
  'fix-blast-radius.json',
  'fix-touched-surface-gates.json',
  'fix-learning-packet.json',
  'risk-acceptance.json',
  'architecture-mutation-approval.json',
  'fix-rollback-plan.json',
  'hotfix-release-contract.json',
  'fix-coverage-matrix.json',
  'fix-readiness-report.json',
  'troubleshooting-dossier.json',
  'failure-capture.json',
  'minimal-repro.json',
  'hypothesis-log.json',
  'flow-ledger.json',
  'fix-iteration-log.json',
  'phantom-rate-tracker.json',
  'fix-completeness-report.json',
  'rca-report.md',
  'M{n}-fix-report.md',
];

const REQUIRED_VERDICTS = [
  'EXIT_SUCCESS',
  'EXIT_ESCALATE',
  'LOOP',
  'LOOP_REVERT',
  'LOOP_PIVOT',
  'LOOP_ARCH_ESCALATE',
  'LOOP_ARCH_MUTATE',
  'LOOP_INTEGRATION_PLATEAU',
];

function parseArgs(argv) {
  const out = { command: 'check', root: process.cwd(), json: false, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--dir' || arg === '--root') {
      out.root = argv[i + 1] || out.root;
      i += 1;
    } else if (arg.startsWith('--dir=')) out.root = arg.slice('--dir='.length);
    else if (arg.startsWith('--root=')) out.root = arg.slice('--root='.length);
    else if (arg.startsWith('--')) out.unknown = arg;
    else positional.push(arg);
  }
  if (positional.length > 0) out.command = positional[0];
  return out;
}

function printUsage() {
  console.log('Usage: node tools/cobolt-fix-pipeline-audit.js check [--dir <repo>] [--json]');
  console.log();
  console.log('Validates cobolt-fix source contracts: graph, tools, hooks, agents, ACLs, loops, state, and artifacts.');
}

function exists(root, relPath) {
  return fs.existsSync(path.join(root, relPath));
}

function readText(root, relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
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
  let keyIndex = source.indexOf(`${key}: [`);
  if (keyIndex === -1) keyIndex = source.indexOf(`${key} = [`);
  if (keyIndex === -1) return new Set();
  const start = source.indexOf('[', keyIndex);
  let depth = 0;
  let end = -1;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '[') depth += 1;
    if (source[i] === ']') depth -= 1;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) return new Set();
  const body = source.slice(start, end + 1);
  return new Set([...body.matchAll(/^\s*'([^']+)'/gm)].map((m) => m[1]));
}

function buildModelTierIndex(modelConfig) {
  const index = new Map();
  for (const [tier, agents] of Object.entries(modelConfig['agent-tiers'] || {})) {
    for (const agent of agents || []) index.set(agent, tier);
  }
  return index;
}

function extractDirectToolScriptRefs(text) {
  const refs = new Set();
  for (const match of String(text).matchAll(
    /\b(?:node|bash)\s+(?:"?\$[A-Z_]*(?:TOOLS|TOOL_DIR)\/|"?\.?\/?tools\/)(cobolt-[a-z0-9-]+\.js)\b/g,
  )) {
    refs.add(match[1]);
  }
  return [...refs].sort();
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

function auditFixPipeline(root = process.cwd()) {
  const repoRoot = path.resolve(root);
  const report = {
    ok: true,
    repoRoot,
    generatedAt: new Date().toISOString(),
    graph: {
      entrypoints: ['cobolt-cli fix', 'cli/index.js', 'cli/commands/fix.js', 'source/skills/cobolt-fix/SKILL.md'],
      stages: FIX_STEPS.map((step) => step.file.replace(/\.md$/u, '')),
      subPipelines: ['cobolt-review', 'cobolt-audit', 'cobolt-build', 'cobolt-resolve', 'cobolt-hotfix'],
      loops: REQUIRED_VERDICTS.filter((verdict) => verdict.startsWith('LOOP')),
      terminalConditions: REQUIRED_VERDICTS.filter((verdict) => verdict.startsWith('EXIT')),
    },
    checks: [],
    issues: [],
    stages: [],
    tools: [],
    hooks: [],
    agents: [],
    artifacts: [],
  };

  const requiredEntryFiles = [
    'cli/index.js',
    'cli/commands/fix.js',
    'cli/lib/gate-runner.js',
    'cli/lib/autonomous-recovery.js',
    'cli/lib/prompt-assembler.js',
    'source/skills/cobolt-fix/SKILL.md',
    'source/skills/cobolt-fix/references/agent-team.md',
    'source/skills/cobolt-fix/references/finding-lifecycle.md',
    'source/skills/cobolt-fix/references/never-stop-directive.md',
    'source/skills/cobolt-fix/references/troubleshooting-playbook.md',
    'source/skills/cobolt-fix/references/verification-rules.md',
    'source/skills/_shared/agent-dispatch-preamble.md',
    'source/skills/_shared/team-teardown-protocol.sh',
    'source/templates/model-config.json',
    'source/hooks/cobolt-pre-dispatch.js',
    'source/hooks/cobolt-post-dispatch.js',
    'source/hooks/cobolt-dispatch-acl.js',
    'source/hooks/cobolt-model-tier-gate.js',
    'source/hooks/cobolt-subagent-write-guard.js',
    'tools/index.js',
  ];

  for (const relPath of requiredEntryFiles) {
    addCheck(report, 'entrypoint', relPath, exists(repoRoot, relPath), `${relPath} exists`);
  }
  if (report.issues.length > 0) {
    report.ok = false;
    report.summary = { checks: report.checks.length, failures: report.issues.length };
    return report;
  }

  const cliIndex = readText(repoRoot, 'cli/index.js');
  const fixCommand = readText(repoRoot, 'cli/commands/fix.js');
  const skill = readText(repoRoot, 'source/skills/cobolt-fix/SKILL.md');
  const agentTeam = readText(repoRoot, 'source/skills/cobolt-fix/references/agent-team.md');
  const preDispatch = readText(repoRoot, 'source/hooks/cobolt-pre-dispatch.js');
  const postDispatch = readText(repoRoot, 'source/hooks/cobolt-post-dispatch.js');
  const dispatchAcl = readText(repoRoot, 'source/hooks/cobolt-dispatch-acl.js');
  const toolIndex = readText(repoRoot, 'tools/index.js');
  const modelConfig = parseJson(repoRoot, 'source/templates/model-config.json');
  const tierIndex = buildModelTierIndex(modelConfig);

  addCheck(
    report,
    'entrypoint',
    'CLI fix command registered',
    /fix:\s*\{\s*module:\s*['"]\.\/commands\/fix['"]/.test(cliIndex),
    'cli/index.js registers fix command',
  );
  addCheck(
    report,
    'entrypoint',
    'Fix command exposes parser tests',
    /_testOnly:\s*\{[\s\S]*parseFixArgs/.test(fixCommand),
    'cli/commands/fix.js exports test-only parser helpers',
  );
  addCheck(
    report,
    'entrypoint',
    'Fix command autonomous recovery',
    fixCommand.includes('runAutonomousCodexStageWithAdvisory') && fixCommand.includes('writeAutonomousCarryForward'),
    'fix wrapper uses advisory recovery and carry-forward evidence',
  );
  addCheck(
    report,
    'entrypoint',
    'Fix command does not use target project tools fallback',
    !/process\.cwd\(\),\s*['"]tools['"]/.test(cliIndex),
    'CLI tool resolution stays source-backed',
  );

  for (const step of FIX_STEPS) {
    const relPath = path.join('source', 'skills', 'cobolt-fix', 'step-files', step.file);
    const stepExists = exists(repoRoot, relPath);
    const stepRecord = { ...step, path: relPath, exists: stepExists };
    report.stages.push(stepRecord);
    addCheck(report, 'stage', `${step.id} ${step.file} exists`, stepExists, `${relPath} exists`);
    addCheck(
      report,
      'stage',
      `${step.id} referenced by skill`,
      skill.includes(step.file),
      `SKILL.md references ${step.file}`,
    );
    if (!stepExists) continue;
    const stepText = readText(repoRoot, relPath);
    const hasCheckpoint = step.id === '04b' || stepText.includes('pipeline.fixStage');
    addCheck(
      report,
      'stage',
      `${step.id} checkpoint state`,
      hasCheckpoint,
      `${step.file} records or inherits fixStage checkpoint semantics`,
    );
    addCheck(
      report,
      'stage',
      `${step.id} purpose`,
      /## Purpose|## STEP GOAL/i.test(stepText),
      `${step.file} declares stage purpose`,
    );
    for (const ref of extractDirectToolScriptRefs(stepText)) {
      addCheck(
        report,
        'stage-tool-ref',
        `${step.file} references ${ref}`,
        exists(repoRoot, path.join('tools', ref)),
        `${ref} exists for ${step.file}`,
      );
    }
  }

  for (const artifact of REQUIRED_ARTIFACTS) {
    const present = skill.includes(artifact) || skill.includes(artifact.replace('{n}', 'n'));
    report.artifacts.push({ artifact, declared: present });
    addCheck(report, 'artifact', artifact, present, `SKILL.md declares required artifact ${artifact}`);
  }

  for (const tool of REQUIRED_FIX_TOOLS) {
    const relPath = path.join('tools', tool);
    const ok = exists(repoRoot, relPath);
    report.tools.push({ tool, exists: ok });
    addCheck(report, 'tool', `${tool} exists`, ok, `${relPath} exists`);
  }

  const textSurface = [
    skill,
    agentTeam,
    ...FIX_STEPS.map((step) => path.join('source', 'skills', 'cobolt-fix', 'step-files', step.file))
      .filter((rel) => exists(repoRoot, rel))
      .map((rel) => readText(repoRoot, rel)),
  ].join('\n');
  for (const ref of extractDirectToolScriptRefs(textSurface)) {
    addCheck(
      report,
      'tool-ref',
      ref,
      exists(repoRoot, path.join('tools', ref)),
      `Direct tool reference exists: ${ref}`,
    );
  }
  const registeredTools = new Set([...toolIndex.matchAll(/'([^']+)':\s*\{\s*file:/g)].map((m) => m[1]));
  for (const indexRef of extractIndexToolRefs(textSurface)) {
    addCheck(
      report,
      'tool-ref',
      `tools/index.js ${indexRef}`,
      registeredTools.has(indexRef),
      `${indexRef} is registered in tools/index.js`,
    );
  }
  for (const registered of [
    'fix-router',
    'fix-verdict',
    'fix-readiness',
    'fix-surface-gates',
    'fix-risk-acceptance',
    'fix-architecture-approval',
    'fix-learning-packet',
    'hotfix-release-contract',
    'fix-task-manifest',
    'fix-evidence',
    'output-validator',
    'fix-failure-record',
    'fix-doctor',
  ]) {
    addCheck(
      report,
      'tool-registry',
      registered,
      registeredTools.has(registered),
      `${registered} is registered in tools/index.js`,
    );
  }

  for (const script of REQUIRED_FIX_SCRIPTS) {
    addCheck(
      report,
      'script',
      script,
      exists(repoRoot, path.join('source', 'skills', 'cobolt-fix', 'scripts', script)),
      `cobolt-fix script exists: ${script}`,
    );
  }

  const registeredPreHooks = extractArrayStrings(preDispatch, 'PRE_HOOKS');
  const registeredPostHooks = extractArrayStrings(postDispatch, 'POST_HOOKS');
  for (const hook of REQUIRED_FIX_HOOKS) {
    const hookExists = exists(repoRoot, path.join('source', 'hooks', hook));
    const registered = registeredPreHooks.has(hook) || registeredPostHooks.has(hook);
    report.hooks.push({ hook, exists: hookExists, registered });
    addCheck(report, 'hook', `${hook} exists`, hookExists, `Hook file exists: ${hook}`);
    addCheck(report, 'hook', `${hook} registered`, registered, `Hook is registered by pre/post dispatcher: ${hook}`);
    if (hookExists && /(gate|enforcer|required)/.test(hook)) {
      const hookText = readText(repoRoot, path.join('source', 'hooks', hook));
      addCheck(
        report,
        'hook',
        `${hook} audit evidence`,
        /audit|jsonl|gate-skip-log|validation-failed|escalation|checkpoint|marker/i.test(hookText),
        `${hook} records durable evidence or marker state`,
      );
    }
  }

  const fixAcl = extractArrayStrings(dispatchAcl, 'fix');
  const crossStageAcl = extractArrayStrings(dispatchAcl, 'CROSS_STAGE_AGENTS');
  const writeAgentSource = exists(repoRoot, 'lib/cobolt-write-agents.js')
    ? readText(repoRoot, 'lib/cobolt-write-agents.js')
    : '';
  for (const agentName of FIX_AGENTS) {
    const relPath = path.join('source', 'agents', `${agentName}.md`);
    const agentExists = exists(repoRoot, relPath);
    const agent = { name: agentName, path: relPath, exists: agentExists };
    addCheck(report, 'agent', `${agentName} exists`, agentExists, `${relPath} exists`);
    if (!agentExists) {
      report.agents.push(agent);
      continue;
    }

    const content = readText(repoRoot, relPath);
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
    addCheck(report, 'agent', `${agentName} read tool`, tools.includes('Read'), `${agentName} declares Read tool`);

    if (READ_ONLY_FIX_AGENTS.has(agentName)) {
      addCheck(
        report,
        'agent',
        `${agentName} read-only`,
        !hasWriteTool && !hasAgentTool,
        `${agentName} has no write/edit/Agent tool`,
      );
    }
    if (WRITE_EXPECTED_FIX_AGENTS.has(agentName)) {
      addCheck(
        report,
        'agent',
        `${agentName} write-capable`,
        hasWriteTool || hasAgentTool,
        `${agentName} has expected write or orchestration capability`,
      );
    }
    addCheck(
      report,
      'agent',
      `${agentName} failure contract`,
      content.includes(FAILURE_INCLUDE) || /Failure Output Contract/i.test(content),
      `${agentName} includes structured failure output contract`,
    );

    const aclOk = fixAcl.has(agentName) || crossStageAcl.has(agentName);
    addCheck(report, 'agent', `${agentName} dispatch ACL`, aclOk, `${agentName} is allowed by fix or cross-stage ACL`);
    if (WRITE_EXPECTED_FIX_AGENTS.has(agentName)) {
      addCheck(
        report,
        'agent',
        `${agentName} write guard coverage`,
        writeAgentSource.includes(agentName) ||
          agentName === 'review-lead' ||
          agentName === 'resolve-lead' ||
          agentName === 'recovery-advisor',
        `${agentName} is covered by canonical write-agent guard when relevant`,
      );
    }
  }

  const verdictSource = readText(repoRoot, 'tools/cobolt-fix-verdict.js');
  const verificationStep = readText(repoRoot, 'source/skills/cobolt-fix/step-files/05-verification.md');
  for (const verdict of REQUIRED_VERDICTS) {
    const inTool = verdictSource.includes(verdict);
    const inStep = verificationStep.includes(verdict) || verdict === 'EXIT_SUCCESS';
    addCheck(report, 'loop', `${verdict} in verdict tool`, inTool, `${verdict} is produced by cobolt-fix-verdict.js`);
    addCheck(
      report,
      'loop',
      `${verdict} handling documented`,
      inStep,
      `${verdict} handling is documented in Step 05 where applicable`,
    );
  }
  addCheck(
    report,
    'loop',
    'partial-ship terminal semantics',
    verdictSource.includes('totalPartial > 0') &&
      verdictSource.includes('partial-ship') &&
      verificationStep.includes('carry-forward.json'),
    'Deferred/carry-forward findings terminate through EXIT_ESCALATE with explicit partial-ship carry-forward semantics',
  );
  addCheck(
    report,
    'loop',
    'artifact chain verification',
    verdictSource.includes('verifyPreviousArtifactChain') && verdictSource.includes('writeIterationArtifactChain'),
    'Fix verdict verifies and records artifact chains',
  );
  addCheck(
    report,
    'loop',
    'signature plateau telemetry',
    verdictSource.includes('LOOP_INTEGRATION_PLATEAU') && verdictSource.includes('writeTelemetry'),
    'Fix verdict records signature plateau telemetry',
  );
  addCheck(
    report,
    'loop',
    'canonical step order',
    verificationStep.includes('stepOrder') &&
      verificationStep.includes('toolGate') &&
      verificationStep.includes('uatRegression'),
    'Verification step enforces canonical sub-step order',
  );

  const readinessSource = readText(repoRoot, 'tools/cobolt-fix-readiness.js');
  for (const dimension of [
    'findingSource',
    'severityPriority',
    'impact',
    'reproduction',
    'sourceEvidence',
    'recentChanges',
    'rootCauseHypotheses',
    'blastRadius',
    'rollbackPlan',
    'fixStrategy',
    'testPlan',
    'securityPrivacy',
    'dataMigration',
    'integrations',
    'observability',
    'deployment',
    'verification',
    'rcaPrevention',
  ]) {
    addCheck(
      report,
      'readiness',
      dimension,
      readinessSource.includes(`'${dimension}'`),
      `Fix readiness enforces ${dimension}`,
    );
  }
  addCheck(
    report,
    'readiness',
    'zero-case autonomous artifacts',
    readinessSource.includes('writeZeroCaseRuntimeArtifacts') &&
      readinessSource.includes('fix-completeness-report.json') &&
      readinessSource.includes('fix-source-proof.json'),
    'Fix readiness writes truthful zero-case artifacts',
  );
  for (const contract of [
    'fix-source-proof.json',
    'fix-blast-radius.json',
    'fix-learning-packet.json',
    'risk-acceptance.json',
    'architecture-mutation-approval.json',
    'fix-rollback-plan.json',
    'hotfix-release-contract.json',
  ]) {
    addCheck(
      report,
      'readiness',
      contract,
      readinessSource.includes(contract),
      `Fix readiness emits SDLC contract ${contract}`,
    );
  }

  const routerSource = readText(repoRoot, 'tools/cobolt-fix-router.js');
  for (const prefix of ['WIRE', 'APIWIRE', 'LIFECYCLE', 'ROUTE', 'QRY', 'STUB', 'ILL', 'UIPH', 'FEAT', 'ENH']) {
    addCheck(report, 'router', prefix, routerSource.includes(prefix), `Fix router handles ${prefix}`);
  }
  addCheck(
    report,
    'router',
    'unmapped prefix audit',
    routerSource.includes('unmapped-finding-prefix.jsonl'),
    'Router audits unmapped prefixes',
  );

  const manifestSource = readText(repoRoot, 'tools/cobolt-fix-task-manifest.js');
  addCheck(
    report,
    'manifest',
    'ownership collision merge',
    manifestSource.includes('buildOwnershipComponents') && manifestSource.includes('ownershipCollisions'),
    'Task manifest merges shared-file ownership collisions',
  );
  addCheck(
    report,
    'manifest',
    'execution groups',
    manifestSource.includes('executionGroups') && manifestSource.includes('hybrid'),
    'Task manifest emits sequential/parallel/hybrid execution groups',
  );

  report.summary = {
    checks: report.checks.length,
    failures: report.issues.length,
    stages: report.stages.length,
    tools: report.tools.length,
    hooks: report.hooks.length,
    agents: report.agents.length,
    artifacts: report.artifacts.length,
  };
  report.ok = report.issues.length === 0;
  return report;
}

function printHuman(report) {
  console.log('CoBolt Fix Pipeline Audit');
  console.log(`Repo: ${report.repoRoot}`);
  console.log(`Checks: ${report.summary?.checks || report.checks.length}`);
  console.log(`Failures: ${report.summary?.failures || report.issues.length}`);
  console.log();
  console.log('Graph:');
  for (const stage of report.graph.stages) console.log(`  ${stage}`);
  console.log();
  if (report.issues.length === 0) {
    console.log('PASS: Fix pipeline source contracts are internally consistent.');
    return;
  }
  console.log('Failures:');
  for (const issue of report.issues) {
    console.log(`  [${issue.section}] ${issue.name}: ${issue.message}`);
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
  if (args.command !== 'check') {
    console.error(`Unknown command: ${args.command}`);
    printUsage();
    return 1;
  }
  const report = auditFixPipeline(args.root);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  FIX_STEPS,
  REQUIRED_FIX_TOOLS,
  REQUIRED_FIX_HOOKS,
  FIX_AGENTS,
  REQUIRED_VERDICTS,
  auditFixPipeline,
  extractDirectToolScriptRefs,
  extractIndexToolRefs,
  parseFrontmatter,
  main,
};
