#!/usr/bin/env node

// Deterministic Plan pipeline audit harness.
// This tool validates source-backed contracts for the cobolt-plan pipeline:
// CLI wiring, phase checkpoints, artifact dependency schema, tool registry,
// hook registration, agent frontmatter, dispatch ACL, model tier mapping,
// write-tool boundaries, and failure-output contracts.

const fs = require('node:fs');
const path = require('node:path');

const PLAN_PHASES = [
  {
    id: 'phase1',
    name: 'Product Intent',
    checkpoint: 'phase1-product-intent.json',
    next: 'phase2',
  },
  {
    id: 'phase2',
    name: 'Technical Guardrails',
    checkpoint: 'phase2-technical-guardrails.json',
    next: 'phase3',
  },
  {
    id: 'phase3',
    name: 'System Design',
    checkpoint: 'phase3-system-design.json',
    next: 'phase4',
  },
  {
    id: 'phase4',
    name: 'Delivery Breakdown',
    checkpoint: 'phase4-delivery-breakdown.json',
    next: 'phase5',
  },
  {
    id: 'phase5',
    name: 'Build Authorization',
    checkpoint: 'phase5-build-authorization.json',
    next: 'infrastructure-handoff',
  },
];

const PLAN_AGENTS = [
  { name: 'planning-lead', acl: 'planning', write: true },
  { name: 'resolve-lead', acl: 'cross', write: true },
  { name: 'recovery-advisor', acl: 'cross', write: true },
  { name: 'review-lead', acl: 'sidecar', readOnly: true },
  { name: 'feature-completeness-reviewer', acl: 'planning', readOnly: true },
  { name: 'architecture-analyst', acl: 'planning', readOnly: true },
  { name: 'gap-analyst', acl: 'planning', write: true },
  { name: 'compliance-architect', acl: 'planning', write: true },
  { name: 'architect', acl: 'planning', write: true },
  { name: 'ux-designer', acl: 'planning', write: true },
  { name: 'analyst', acl: 'planning', write: true },
  { name: 'security-architect', acl: 'planning', write: true },
  { name: 'trd-architect', acl: 'planning', readOnly: true },
  { name: 'milestone-architect', acl: 'planning', readOnly: true },
  { name: 'cross-milestone-analyst', acl: 'planning', readOnly: true },
  { name: 'delivery-planner', acl: 'planning', write: true },
  { name: 'rtm-analyst', acl: 'planning', readOnly: true },
  { name: 'implicit-req-extractor', acl: 'planning', readOnly: true },
  { name: 'prd-redteam-agent', acl: 'planning', write: true },
  { name: 'enhancement-advisor', acl: 'planning', readOnly: true },
  { name: 'engineering-standards-validator', acl: 'planning', write: true },
  { name: 'bounded-context-architect', acl: 'planning', write: true },
  { name: 'spec-architect', acl: 'planning', write: true },
  { name: 'localization-specialist', acl: 'planning', write: true },
];

const REQUIRED_PLAN_HOOKS = [
  'cobolt-planning-gate.js',
  'cobolt-plan-readiness-gate.js',
  'cobolt-planning-critique-gate.js',
  'cobolt-plan-subskill-trap-gate.js',
  'cobolt-plan-complete-gate.js',
  'cobolt-planning-provenance-gate.js',
  'cobolt-feature-registry-validation-gate.js',
  'cobolt-story-frontmatter-gate.js',
  'cobolt-dossier-depth-gate.js',
  'cobolt-ux-completeness-gate.js',
  'cobolt-rtm-integrity-gate.js',
  'cobolt-rtm-validated-gate.js',
  'cobolt-story-coverage-gate.js',
  'cobolt-model-tier-gate.js',
  'cobolt-dispatch-acl.js',
  'cobolt-subagent-write-guard.js',
  'cobolt-verdict-consume-gate.js',
];

const REQUIRED_CLI_SYMBOLS = [
  'normalizePlanArgs',
  'resolvePlanningRuntimeOptions',
  'finalizePlanningPacket',
  'runInfrastructureHandoff',
  'runPostInfraBuildReadyGate',
  'selectNextMilestoneForPlan',
  'runGates',
  'assembleSkillPrompt',
];

const FAILURE_INCLUDE = '{{COBOLT_INCLUDE:skills/_shared/agent-failure-output.md}}';
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

function parseArgs(argv) {
  const out = { command: 'check', root: process.cwd(), json: false, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--json') {
      out.json = true;
    } else if (arg === '--dir' || arg === '--root') {
      out.root = argv[i + 1] || out.root;
      i += 1;
    } else if (arg.startsWith('--dir=')) {
      out.root = arg.slice('--dir='.length);
    } else if (arg.startsWith('--root=')) {
      out.root = arg.slice('--root='.length);
    } else if (arg.startsWith('--')) {
      out.unknown = arg;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 0) out.command = positional[0];
  return out;
}

function printUsage() {
  console.log('Usage: node tools/cobolt-plan-pipeline-audit.js check [--dir <repo>] [--json]');
  console.log();
  console.log(
    'Validates cobolt-plan source contracts: CLI, phases, artifacts, tools, hooks, agents, ACL, and state handoffs.',
  );
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
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function splitTools(value) {
  return String(value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function parsePlanArtifactTable(skillText) {
  const rows = [];
  for (const line of skillText.split(/\r?\n/)) {
    if (!/^\|\s*[^|]+\|/.test(line)) continue;
    const artifactMatches = [...line.matchAll(/`(_cobolt-output\/latest\/planning\/[^`]+)`/g)];
    if (artifactMatches.length === 0) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    const producer = (cells[2] || '').replace(/^`|`$/g, '');
    const phase = Number((cells[5] || '').replace(/[^0-9]/g, '')) || null;
    const required = /\bYES\b/i.test(cells[6] || '');
    for (const match of artifactMatches) {
      rows.push({
        id: cells[1] || '',
        producer,
        artifact: match[1],
        minBytes: Number((cells[4] || '').replace(/[^0-9]/g, '')) || null,
        phase,
        required,
      });
    }
  }
  return rows;
}

function normalizeSkillProducer(producer) {
  const m = String(producer).match(/\b(cobolt-[a-z0-9-]+)\b/i);
  return m ? m[1] : null;
}

function extractNodeToolRefs(text) {
  return [...new Set([...text.matchAll(/node\s+tools\/([\w.-]+\.js)/g)].map((m) => m[1]))].sort();
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
  return new Set([...body.matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

function buildModelTierIndex(modelConfig) {
  const index = new Map();
  for (const [tier, agents] of Object.entries(modelConfig['agent-tiers'] || {})) {
    for (const agent of agents || []) index.set(agent, tier);
  }
  return index;
}

function addCheck(report, section, name, ok, message, detail = {}) {
  const check = { section, name, ok: Boolean(ok), message, ...detail };
  report.checks.push(check);
  if (!ok) report.issues.push(check);
  return check;
}

function auditPlanPipeline(root = process.cwd()) {
  const repoRoot = path.resolve(root);
  const report = {
    ok: true,
    repoRoot,
    generatedAt: new Date().toISOString(),
    graph: {
      entrypoints: ['cobolt-cli plan', 'cli/index.js', 'cli/commands/plan.js', 'source/skills/cobolt-plan/SKILL.md'],
      phases: PLAN_PHASES,
      handoffs: [
        ['cobolt-cli plan', 'cli/commands/plan.js'],
        ['cli/commands/plan.js', 'source/skills/cobolt-plan/SKILL.md'],
        ['phase1', 'phase2'],
        ['phase2', 'phase3'],
        ['phase3', 'phase4'],
        ['phase4', 'phase5'],
        ['phase5', 'runInfrastructureHandoff'],
        ['runInfrastructureHandoff', 'runPostInfraBuildReadyGate'],
        ['runPostInfraBuildReadyGate', 'cobolt-build'],
      ],
    },
    checks: [],
    issues: [],
    phases: [],
    artifacts: [],
    tools: [],
    hooks: [],
    agents: [],
  };

  for (const relPath of [
    'cli/index.js',
    'cli/commands/plan.js',
    'source/skills/cobolt-plan/SKILL.md',
    'source/schemas/plan-phase-artifacts.json',
    'source/schemas/artifact-dependencies.json',
    'source/hooks/cobolt-pre-dispatch.js',
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
  const cliPlan = readText(repoRoot, 'cli/commands/plan.js');
  const planSkill = readText(repoRoot, 'source/skills/cobolt-plan/SKILL.md');
  const phaseSchema = parseJson(repoRoot, 'source/schemas/plan-phase-artifacts.json');
  const dependencySchema = parseJson(repoRoot, 'source/schemas/artifact-dependencies.json');
  const preDispatch = readText(repoRoot, 'source/hooks/cobolt-pre-dispatch.js');
  const dispatchAcl = readText(repoRoot, 'source/hooks/cobolt-dispatch-acl.js');
  const modelConfig = parseJson(repoRoot, 'source/templates/model-config.json');

  addCheck(
    report,
    'entrypoint',
    'cli/index.js exports plan command',
    /commands\/plan|\.\/commands\/plan/.test(cliIndex),
    'CLI root wires plan command',
  );
  for (const symbol of REQUIRED_CLI_SYMBOLS) {
    addCheck(
      report,
      'entrypoint',
      `cli/commands/plan.js ${symbol}`,
      cliPlan.includes(symbol),
      `Plan wrapper references ${symbol}`,
    );
  }
  addCheck(
    report,
    'entrypoint',
    'Plan wrapper supports --arch',
    cliPlan.includes('runArchitectureHandoff') || cliPlan.includes('arch'),
    'Plan wrapper contains architecture handoff support',
  );
  addCheck(
    report,
    'entrypoint',
    'Plan wrapper supports --auto build handoff',
    cliPlan.includes('runPostInfraBuildReadyGate') &&
      cliPlan.includes("require('./build')") &&
      cliPlan.includes('buildCmd.run'),
    'Plan wrapper contains post-infra build handoff',
  );

  const artifactRows = parsePlanArtifactTable(planSkill);
  report.artifacts = artifactRows;
  addCheck(
    report,
    'artifact-contract',
    'Plan artifact table parsed',
    artifactRows.length >= 60,
    `Parsed ${artifactRows.length} Plan artifact rows`,
  );

  const dependencyPaths = new Set();
  const dependencyArtifactKeys = new Set(Object.keys(dependencySchema.artifacts || {}));
  for (const artifact of Object.values(dependencySchema.artifacts || {})) {
    if (!artifact || typeof artifact !== 'object') continue;
    if (artifact.path) dependencyPaths.add(artifact.path);
    if (artifact.pathPattern) dependencyPaths.add(artifact.pathPattern);
  }
  for (const row of artifactRows) {
    addCheck(
      report,
      'artifact-contract',
      row.artifact,
      dependencyPaths.has(row.artifact),
      `Plan table artifact is declared in artifact-dependencies.json: ${row.artifact}`,
      { producer: row.producer, phase: row.phase },
    );
  }

  const producedRefs = new Set();
  const consumedRefs = new Set();
  const skillEntries = Object.values(dependencySchema.skills || {});
  const producerEntries = Object.values(dependencySchema.producers || {});
  for (const entry of [...skillEntries, ...producerEntries]) {
    if (typeof entry !== 'object' || entry === null) continue;
    for (const key of entry.produces || []) producedRefs.add(key);
    for (const key of entry.requires || []) consumedRefs.add(key);
    for (const key of entry.optionalContext || []) consumedRefs.add(key);
  }
  for (const key of producedRefs) {
    addCheck(
      report,
      'artifact-contract',
      `produces:${key}`,
      dependencyArtifactKeys.has(key),
      `Produced artifact key exists: ${key}`,
    );
  }
  for (const key of consumedRefs) {
    addCheck(
      report,
      'artifact-contract',
      `requires:${key}`,
      dependencyArtifactKeys.has(key),
      `Required/optional artifact key exists: ${key}`,
    );
  }

  for (const phase of PLAN_PHASES) {
    const schemaPhase = phaseSchema.phases?.[phase.id];
    const requiredArtifacts = schemaPhase?.requiredArtifacts || [];
    report.phases.push({
      id: phase.id,
      name: phase.name,
      checkpoint: phase.checkpoint,
      requiredArtifacts,
      producingSubSkills: schemaPhase?.producingSubSkills || [],
    });
    addCheck(
      report,
      'phase-contract',
      `${phase.id} exists`,
      Boolean(schemaPhase),
      `${phase.id} exists in plan-phase-artifacts.json`,
    );
    addCheck(
      report,
      'phase-contract',
      `${phase.id} checkpoint`,
      schemaPhase?.checkpointFile === phase.checkpoint,
      `${phase.id} checkpoint is ${phase.checkpoint}`,
    );
    addCheck(
      report,
      'phase-contract',
      `${phase.id} checkpoint mentioned`,
      planSkill.includes(phase.checkpoint),
      `${phase.checkpoint} is referenced by cobolt-plan`,
    );
    for (const artifact of requiredArtifacts) {
      addCheck(
        report,
        'phase-contract',
        `${phase.id}:${artifact.path}`,
        dependencyPaths.has(artifact.path),
        `${phase.id} required artifact exists in dependency schema: ${artifact.path}`,
      );
    }
  }
  const phase2Required = new Set((phaseSchema.phases?.phase2?.requiredArtifacts || []).map((a) => a.path));
  addCheck(
    report,
    'phase-contract',
    'Phase 2 canonical engineering standards artifact',
    phase2Required.has('_cobolt-output/latest/planning/engineering-quality-standards.md') &&
      !phase2Required.has('_cobolt-output/latest/planning/engineering-standards.md'),
    'Phase 2 requires engineering-quality-standards.md and not stale engineering-standards.md',
  );
  const phase3Required = new Set((phaseSchema.phases?.phase3?.requiredArtifacts || []).map((a) => a.path));
  addCheck(
    report,
    'phase-contract',
    'Phase 3 system architecture artifact',
    phase3Required.has('_cobolt-output/latest/planning/system-architecture.md'),
    'Phase 3 requires system-architecture.md',
  );

  const toolRefs = extractNodeToolRefs(planSkill);
  const toolsIndex = require(path.join(repoRoot, 'tools', 'index.js'));
  const registeredToolFiles = new Set(Object.values(toolsIndex.TOOLS || {}).map((entry) => path.basename(entry.file)));
  for (const file of toolRefs) {
    const tool = {
      file,
      registered: file === 'index.js' || registeredToolFiles.has(file),
      exists: exists(repoRoot, path.join('tools', file)),
    };
    report.tools.push(tool);
    addCheck(report, 'tool', `tools/${file} exists`, tool.exists, `Plan-referenced tool exists: tools/${file}`);
    addCheck(
      report,
      'tool',
      `tools/${file} registered`,
      tool.registered,
      `Plan-referenced tool is registered in tools/index.js: ${file}`,
    );
  }

  const producers = new Set(artifactRows.map((row) => normalizeSkillProducer(row.producer)).filter(Boolean));
  for (const skill of [...producers].sort()) {
    const skillPath = path.join('source', 'skills', skill, 'SKILL.md');
    if (!exists(repoRoot, skillPath)) continue;
    const content = readText(repoRoot, skillPath);
    const fm = parseFrontmatter(content);
    addCheck(report, 'skill', `${skill} frontmatter`, Boolean(fm), `${skill} has YAML frontmatter`);
    addCheck(
      report,
      'skill',
      `${skill} disable-model-invocation`,
      fm?.['disable-model-invocation'] === 'false',
      `${skill} is model-invokable by Plan`,
    );
  }

  for (const hook of REQUIRED_PLAN_HOOKS) {
    const hookExists = exists(repoRoot, path.join('source', 'hooks', hook));
    const registered = preDispatch.includes(`'${hook}'`) || preDispatch.includes(`"${hook}"`);
    report.hooks.push({ hook, exists: hookExists, registered });
    addCheck(report, 'hook', `${hook} exists`, hookExists, `Hook file exists: ${hook}`);
    addCheck(report, 'hook', `${hook} registered`, registered, `Hook is registered in cobolt-pre-dispatch.js: ${hook}`);
  }

  const planningAcl = extractArrayStrings(dispatchAcl, 'planning');
  const crossStageAgents = extractArrayStrings(dispatchAcl, 'CROSS_STAGE_AGENTS');
  const sidecarAgents = extractArrayStrings(dispatchAcl, 'SIDECAR_ESCALATION_AGENTS');
  const tierIndex = buildModelTierIndex(modelConfig);
  for (const agentSpec of PLAN_AGENTS) {
    const agentPath = path.join('source', 'agents', `${agentSpec.name}.md`);
    const agent = { name: agentSpec.name, path: agentPath };
    const agentExists = exists(repoRoot, agentPath);
    addCheck(report, 'agent', `${agentSpec.name} exists`, agentExists, `${agentPath} exists`);
    if (!agentExists) {
      report.agents.push(agent);
      continue;
    }
    const content = readText(repoRoot, agentPath);
    const fm = parseFrontmatter(content);
    const tools = splitTools(fm?.tools);
    const hasWriteTool = tools.some((tool) => WRITE_TOOLS.has(tool));
    agent.frontmatter = fm;
    agent.tools = tools;
    agent.hasWriteTool = hasWriteTool;
    report.agents.push(agent);

    addCheck(report, 'agent', `${agentSpec.name} frontmatter`, Boolean(fm), `${agentSpec.name} has YAML frontmatter`);
    addCheck(
      report,
      'agent',
      `${agentSpec.name} name`,
      fm?.name === agentSpec.name,
      `${agentSpec.name} frontmatter name matches filename`,
    );
    addCheck(
      report,
      'agent',
      `${agentSpec.name} mode`,
      fm?.mode === 'subagent',
      `${agentSpec.name} is dispatchable with mode: subagent`,
    );
    addCheck(report, 'agent', `${agentSpec.name} model`, Boolean(fm?.model), `${agentSpec.name} declares a model`);
    addCheck(
      report,
      'agent',
      `${agentSpec.name} tier`,
      tierIndex.has(agentSpec.name),
      `${agentSpec.name} is present in model-config agent tiers`,
    );
    addCheck(
      report,
      'agent',
      `${agentSpec.name} tools`,
      tools.length > 0 && tools.includes('Read'),
      `${agentSpec.name} declares tools including Read`,
    );
    if (agentSpec.readOnly) {
      addCheck(
        report,
        'agent',
        `${agentSpec.name} read-only tools`,
        !hasWriteTool,
        `${agentSpec.name} does not declare Write/Edit/MultiEdit`,
      );
    }
    if (agentSpec.write) {
      addCheck(
        report,
        'agent',
        `${agentSpec.name} write-capable tools`,
        hasWriteTool,
        `${agentSpec.name} declares a write tool in a valid Plan context`,
      );
    }
    addCheck(
      report,
      'agent',
      `${agentSpec.name} failure output`,
      content.includes(FAILURE_INCLUDE),
      `${agentSpec.name} includes the universal failure output contract`,
    );

    let aclOk = false;
    if (agentSpec.acl === 'planning') aclOk = planningAcl.has(agentSpec.name);
    if (agentSpec.acl === 'cross') aclOk = crossStageAgents.has(agentSpec.name);
    if (agentSpec.acl === 'sidecar') aclOk = sidecarAgents.has(agentSpec.name);
    addCheck(
      report,
      'agent',
      `${agentSpec.name} dispatch ACL`,
      aclOk,
      `${agentSpec.name} is allowed by the expected dispatch ACL (${agentSpec.acl})`,
    );
  }

  report.summary = {
    checks: report.checks.length,
    failures: report.issues.length,
    artifacts: report.artifacts.length,
    tools: report.tools.length,
    hooks: report.hooks.length,
    agents: report.agents.length,
  };
  report.ok = report.issues.length === 0;
  return report;
}

function printHuman(report) {
  console.log('CoBolt Plan Pipeline Audit');
  console.log(`Repo: ${report.repoRoot}`);
  console.log(`Checks: ${report.summary?.checks || report.checks.length}`);
  console.log(`Failures: ${report.summary?.failures || report.issues.length}`);
  console.log();
  console.log('Graph:');
  for (const phase of report.graph.phases) {
    console.log(`  ${phase.id}: ${phase.name} -> ${phase.next}`);
  }
  console.log();
  if (report.issues.length === 0) {
    console.log('PASS: Plan pipeline source contracts are internally consistent.');
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
  const report = auditPlanPipeline(args.root);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  PLAN_PHASES,
  PLAN_AGENTS,
  REQUIRED_PLAN_HOOKS,
  auditPlanPipeline,
  parsePlanArtifactTable,
  extractNodeToolRefs,
  parseFrontmatter,
  main,
};
