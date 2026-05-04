#!/usr/bin/env node

// Deterministic Build pipeline audit harness.
// Validates source-backed contracts for cobolt-build: CLI wiring, 19-step graph,
// step artifacts, delegated sub-pipelines, tools, hooks, agents, model tiers,
// dispatch ACLs, gates, state handoffs, and recovery paths.

const fs = require('node:fs');
const path = require('node:path');

const BUILD_STAGE_AGENTS = [
  'build-lead',
  'cobolt-build-lead',
  'research-agent',
  'test-architect',
  'test-writer',
  'db-test-agent',
  'integration-test-agent',
  'uat-agent',
  'infra-agent',
  'db-migration-writer',
  'backend-dev',
  'api-endpoint-builder',
  'frontend-dev',
  'ui-component-builder',
  'liveview-builder',
  'elixir-component-builder',
  'graphql-builder',
  'docker-builder',
  'devops-agent',
  'feature-completeness-reviewer',
  'code-reviewer',
  'enhancement-advisor',
  'code-simplifier',
  'performance-benchmarker',
  'illusion-detector',
  'rtm-analyst',
  'cobolt-audit-agent',
  'milestone-validation-agent',
  'cobolt-review-lead',
  'cobolt-fix-lead',
  'fix-lead',
  'backend-fix',
  'frontend-fix',
  'db-fix',
  'compliance-fix',
  'cobolt-backend-fix',
  'cobolt-frontend-fix',
  'cobolt-db-fix',
  'cobolt-compliance-fix',
  'contract-renegotiator',
];

const REVIEW_PIPELINE_AGENTS = [
  'review-lead',
  'cobolt-review-lead',
  'code-reviewer',
  'security-reviewer',
  'silent-failure-reviewer',
  'performance-reviewer',
  'database-reviewer',
  'compliance-reviewer',
  'accessibility-reviewer',
  'supply-chain-auditor',
  'config-reviewer',
  'architecture-reviewer',
  'api-contract-reviewer',
  'ui-design-reviewer',
  'design-token-linter',
  'ux-reviewer',
  'feature-completeness-reviewer',
  'test-quality-reviewer',
  'integration-reviewer',
  'technical-debt-reviewer',
  'ops-readiness-reviewer',
  'i18n-reviewer',
  'uat-agent',
  'enhancement-advisor',
  'ai-security-reviewer',
  'pentest-agent',
  'sast-dast-runner',
  'db-audit-lead',
];

const FIX_PIPELINE_AGENTS = [
  'cobolt-fix-lead',
  'fix-lead',
  'cobolt-fix-agent',
  'fix-agent',
  'backend-fix',
  'frontend-fix',
  'db-fix',
  'compliance-fix',
  'cobolt-backend-fix',
  'cobolt-frontend-fix',
  'cobolt-db-fix',
  'cobolt-compliance-fix',
  'test-writer',
  'resolve-lead',
];

const SIDECAR_AGENTS = ['architect', 'bounded-context-architect', 'review-lead'];
const CROSS_STAGE_AGENTS = ['resolve-lead', 'recovery-advisor'];

const READ_ONLY_AGENTS = new Set([
  'code-reviewer',
  'security-reviewer',
  'silent-failure-reviewer',
  'performance-reviewer',
  'database-reviewer',
  'compliance-reviewer',
  'accessibility-reviewer',
  'supply-chain-auditor',
  'config-reviewer',
  'architecture-reviewer',
  'api-contract-reviewer',
  'ui-design-reviewer',
  'ux-reviewer',
  'feature-completeness-reviewer',
  'test-quality-reviewer',
  'integration-reviewer',
  'technical-debt-reviewer',
  'ops-readiness-reviewer',
  'i18n-reviewer',
  'enhancement-advisor',
  'illusion-detector',
  'rtm-analyst',
  'ai-security-reviewer',
  'cobolt-audit-agent',
  'sast-dast-runner',
]);

const WRITE_EXPECTED_AGENTS = new Set([
  'build-lead',
  'cobolt-build-lead',
  'research-agent',
  'test-architect',
  'test-writer',
  'db-test-agent',
  'integration-test-agent',
  'uat-agent',
  'infra-agent',
  'db-migration-writer',
  'backend-dev',
  'api-endpoint-builder',
  'frontend-dev',
  'ui-component-builder',
  'liveview-builder',
  'elixir-component-builder',
  'graphql-builder',
  'docker-builder',
  'devops-agent',
  'code-simplifier',
  'performance-benchmarker',
  'cobolt-fix-lead',
  'fix-lead',
  'cobolt-fix-agent',
  'fix-agent',
  'backend-fix',
  'frontend-fix',
  'db-fix',
  'compliance-fix',
  'cobolt-backend-fix',
  'cobolt-frontend-fix',
  'cobolt-db-fix',
  'cobolt-compliance-fix',
  'contract-renegotiator',
  'architect',
  'bounded-context-architect',
  'resolve-lead',
  'recovery-advisor',
  'milestone-validation-agent',
  'review-lead',
  'cobolt-review-lead',
  'pentest-agent',
  'db-audit-lead',
  'design-token-linter',
]);

const REQUIRED_BUILD_HOOKS = [
  'cobolt-directory-gate.js',
  'cobolt-subagent-write-guard.js',
  'cobolt-model-tier-gate.js',
  'cobolt-dispatch-acl.js',
  'cobolt-background-dispatch-gate.js',
  'cobolt-safety.js',
  'cobolt-planning-gate.js',
  'cobolt-rtm-gate.js',
  'cobolt-production-evidence-gate.js',
  'cobolt-prebuild-validate-gate.js',
  'cobolt-tdd-gate.js',
  'cobolt-step-proof-gate.js',
  'cobolt-round-gate.js',
  'cobolt-checkpoint-validator.js',
  'cobolt-checkpoint-write-gate.js',
  'cobolt-reviewer-gate.js',
  'cobolt-build-gate.js',
  'cobolt-browser-evidence-gate.js',
  'cobolt-contract-replay-gate.js',
  'cobolt-contract-break-gate.js',
  'cobolt-migration-replay-gate.js',
  'cobolt-nfr-budget-gate.js',
  'cobolt-cross-milestone-smoke-gate.js',
  'cobolt-pipeline-resilience.js',
  'cobolt-chain-enforcer.js',
  'cobolt-output-validator.js',
  'cobolt-denial-tracker.js',
  'cobolt-token-budget.js',
  'cobolt-memory-trigger.js',
];

const REQUIRED_GATE_NAMES = [
  'Production prebuild evidence',
  'Prebuild validation (v1/v2/v3/v4/v6)',
  'Planning artifacts',
  'Planning artifact path audit',
  'Runtime version contract',
  'Framework runtime contracts',
  'Known failure gate coverage',
  'Stop-the-line thresholds',
  'Story tracker dependency integrity',
  'Planning quality authorization',
  'RTM coverage >= 85%',
  'Governance standards coverage',
  'Compliance control coverage',
  'Core security scan posture',
  'Infrastructure validation',
];

const FAILURE_INCLUDE = '{{COBOLT_INCLUDE:skills/_shared/agent-failure-output.md}}';
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

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
  console.log('Usage: node tools/cobolt-build-pipeline-audit.js check [--dir <repo>] [--json]');
  console.log();
  console.log('Validates cobolt-build source contracts: graph, steps, tools, hooks, agents, ACLs, gates, and state.');
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
  let keyIndex = source.indexOf(`${key}: [`);
  if (keyIndex === -1) keyIndex = source.indexOf(`${key} = [`);
  if (keyIndex === -1) return new Set();
  const start = source.indexOf('[', keyIndex);
  let depth = 0;
  let end = -1;
  // Skip brackets inside line comments and string literals so trailing comments
  // like `// stepsCompleted[]` don't unbalance the depth tracker. Census, not
  // sampling — each PRE_HOOKS entry must be detected.
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    // line comment: skip to next newline
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    // block comment: skip to */
    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    // single-quoted string: skip to closing quote (no embedded newlines)
    if (ch === "'") {
      const close = source.indexOf("'", i + 1);
      if (close === -1) break;
      i = close;
      continue;
    }
    if (ch === '[') depth += 1;
    if (ch === ']') depth -= 1;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) return new Set();
  // Strip line comments and block comments before matching string literals so
  // apostrophes inside comments (e.g. "Bypass: COBOLT_..." or backticked
  // identifiers like `r.testFiles.length`) don't pair with the next array
  // entry's quote and swallow several entries as one giant pseudo-string.
  let body = source.slice(start, end + 1);
  body = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return new Set([...body.matchAll(/'([^']+)'/g)].map((m) => m[1]));
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

function stepStateId(step) {
  return step.file.replace(/\.md$/u, '');
}

function getAllAgentSpecs() {
  const specs = new Map();
  for (const name of BUILD_STAGE_AGENTS) specs.set(name, { name, acl: 'build' });
  for (const name of REVIEW_PIPELINE_AGENTS) {
    if (!specs.has(name)) specs.set(name, { name, acl: 'review' });
  }
  for (const name of FIX_PIPELINE_AGENTS) {
    if (!specs.has(name)) specs.set(name, { name, acl: 'fix' });
  }
  for (const name of SIDECAR_AGENTS) specs.set(name, { name, acl: 'sidecar' });
  for (const name of CROSS_STAGE_AGENTS) specs.set(name, { name, acl: 'cross' });
  return [...specs.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function findLoopBlock(source, re) {
  const startIdx = source.search(re);
  if (startIdx === -1) return null;
  const braceOpen = source.indexOf('{', startIdx);
  if (braceOpen === -1) return null;
  let depth = 0;
  for (let i = braceOpen; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { startIdx, braceOpen, endIdx: i };
    }
  }
  return null;
}

function lineNumberOfOffset(source, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) if (source[i] === '\n') line += 1;
  return line;
}

function checkReleaseOrdering(root = process.cwd()) {
  const findings = [];
  const evidence = { file: 'cli/lib/chain-loop.js' };
  const rel = 'cli/lib/chain-loop.js';
  if (!exists(root, rel)) {
    findings.push({ kind: 'missing-file', detail: rel });
    return { id: 'release-ordering', ok: false, findings, evidence };
  }
  const src = readText(root, rel);
  const block = findLoopBlock(
    src,
    /for\s*\(\s*let\s+idx\s*=\s*0\s*;\s*idx\s*<\s*milestonesToBuild\.length\s*;\s*idx\+\+\s*\)/,
  );
  if (!block) {
    findings.push({ kind: 'loop-header-not-found', detail: 'Per-milestone for-loop header missing' });
    return { id: 'release-ordering', ok: false, findings, evidence };
  }
  evidence.loopLine = lineNumberOfOffset(src, block.startIdx);
  evidence.loopEndLine = lineNumberOfOffset(src, block.endIdx);
  const body = src.slice(block.startIdx, block.endIdx + 1);
  const disallowed = /\b(commitMilestone|bumpVersion|pushMilestone)\s*\(\s*milestoneId\b/g;
  for (const match of body.matchAll(disallowed)) {
    const absOffset = block.startIdx + match.index;
    findings.push({
      kind: 'disallowed-call-in-loop',
      call: match[1],
      line: lineNumberOfOffset(src, absOffset),
    });
  }

  const validateIdx = src.search(/stageConfig\.stage\s*===\s*['"]validate['"]/);
  if (validateIdx === -1) {
    findings.push({
      kind: 'validate-anchor-not-found',
      detail: "stageConfig.stage === 'validate' sentinel missing",
    });
  } else {
    evidence.validateLine = lineNumberOfOffset(src, validateIdx);
    const tail = src.slice(validateIdx);
    const releaseRel = /pipelineFinalRelease\s*\(/.exec(tail);
    if (!releaseRel) {
      findings.push({
        kind: 'final-release-missing',
        detail: 'pipelineFinalRelease(...) not called after validate stage',
      });
    } else {
      evidence.finalReleaseLine = lineNumberOfOffset(src, validateIdx + releaseRel.index);
    }
  }

  return { id: 'release-ordering', ok: findings.length === 0, findings, evidence };
}

function checkMilestoneWorktreeInvariant(root = process.cwd()) {
  const findings = [];
  const evidence = { file: 'cli/lib/chain-loop.js' };
  const rel = 'cli/lib/chain-loop.js';
  if (!exists(root, rel)) {
    findings.push({ kind: 'missing-file', detail: rel });
    return { id: 'milestone-worktree-invariant', ok: false, findings, evidence };
  }
  const src = readText(root, rel);
  const block = findLoopBlock(
    src,
    /for\s*\(\s*let\s+idx\s*=\s*0\s*;\s*idx\s*<\s*milestonesToBuild\.length\s*;\s*idx\+\+\s*\)/,
  );
  if (!block) {
    findings.push({ kind: 'loop-header-not-found', detail: 'Per-milestone for-loop header missing' });
    return { id: 'milestone-worktree-invariant', ok: false, findings, evidence };
  }
  evidence.loopLine = lineNumberOfOffset(src, block.startIdx);
  evidence.loopEndLine = lineNumberOfOffset(src, block.endIdx);
  const body = src.slice(block.startIdx, block.endIdx + 1);

  const ensureRe = /ensureMilestoneWorktree\s*\(\s*milestoneId\s*,/;
  const ensureMatch = ensureRe.exec(body);
  const buildGatesRe = /recordAutoState\s*\([^,]+,[^,]+,\s*['"]build-gates['"]/;
  const buildGatesMatch = buildGatesRe.exec(body);
  if (!ensureMatch) {
    findings.push({
      kind: 'ensure-worktree-missing',
      detail: 'ensureMilestoneWorktree(milestoneId, ...) not called in loop body',
    });
  } else {
    evidence.ensureWorktreeLine = lineNumberOfOffset(src, block.startIdx + ensureMatch.index);
  }
  if (!buildGatesMatch) {
    findings.push({
      kind: 'build-gates-anchor-missing',
      detail: "recordAutoState(..., 'build-gates', ...) not found in loop body",
    });
  } else {
    evidence.buildGatesLine = lineNumberOfOffset(src, block.startIdx + buildGatesMatch.index);
  }
  if (ensureMatch && buildGatesMatch && ensureMatch.index >= buildGatesMatch.index) {
    findings.push({
      kind: 'ensure-worktree-after-build-gates',
      detail: 'ensureMilestoneWorktree must precede the first build-gates recordAutoState',
    });
  }

  const commitWtRe = /commitMilestoneWorktree\s*\(\s*milestoneId\s*,/;
  const commitWtMatch = commitWtRe.exec(body);
  if (!commitWtMatch) {
    findings.push({
      kind: 'commit-worktree-missing',
      detail: 'commitMilestoneWorktree(milestoneId, ...) not called in loop body',
    });
  } else {
    evidence.commitWorktreeLine = lineNumberOfOffset(src, block.startIdx + commitWtMatch.index);
  }

  // try/finally that restores cwd around the loop.
  const preLoopTail = src.slice(0, block.startIdx).split('\n').slice(-12).join('\n');
  if (!/try\s*\{/.test(preLoopTail)) {
    findings.push({
      kind: 'loop-try-header-missing',
      detail: 'Milestone loop is not wrapped in try { ... } finally { ... }',
    });
  }
  const afterLoop = src.slice(block.endIdx + 1, block.endIdx + 2000);
  const finallyRe = /\}\s*finally\s*\{[\s\S]{0,800}?process\.chdir\(\s*originalCwd/;
  if (!finallyRe.test(afterLoop)) {
    findings.push({
      kind: 'finally-chdir-missing',
      detail: 'finally block after loop must restore process.chdir(originalCwd)',
    });
  }

  return { id: 'milestone-worktree-invariant', ok: findings.length === 0, findings, evidence };
}

const QUALITY_ARTIFACT_CONSUMER_PAIRS = [
  {
    artifact: 'product-quality-scorecard',
    consumers: ['tools/cobolt-build-validate-step.js', 'tools/cobolt-build-complete-step.js'],
    enforcement: 'hard',
  },
  {
    artifact: 'ux-state-matrix',
    consumers: ['tools/cobolt-build-validate-step.js', 'tools/cobolt-build-complete-step.js'],
    enforcement: 'hard',
  },
  {
    artifact: 'event-schemas',
    consumers: ['tools/cobolt-build-integration-smoke.js'],
    enforcement: 'advisory',
  },
  {
    artifact: 'dependency-health',
    consumers: ['tools/cobolt-build-validate-step.js', 'tools/cobolt-build-complete-step.js'],
    enforcement: 'advisory',
  },
  {
    artifact: 'nfr-budgets',
    consumers: ['tools/cobolt-nfr-enforce.js'],
    enforcement: 'hard',
  },
];

function checkQualityArtifactConsumers(root = process.cwd(), pairs = QUALITY_ARTIFACT_CONSUMER_PAIRS) {
  const findings = [];
  const evidence = { pairs: [] };
  for (const pair of pairs) {
    const hits = [];
    for (const consumerRel of pair.consumers) {
      if (!exists(root, consumerRel)) continue;
      const src = readText(root, consumerRel);
      if (src.includes(pair.artifact)) hits.push(consumerRel);
    }
    const consumed = hits.length > 0;
    evidence.pairs.push({
      artifact: pair.artifact,
      enforcement: pair.enforcement,
      consumers: pair.consumers,
      consumed,
      matched: hits,
    });
    if (!consumed) {
      findings.push({
        kind: pair.enforcement === 'hard' ? 'missing-consumer' : 'missing-consumer-advisory',
        artifact: pair.artifact,
        expectedIn: pair.consumers,
        enforcement: pair.enforcement,
      });
    }
  }
  const hardMissing = findings.filter((f) => f.kind === 'missing-consumer');
  return {
    id: 'quality-artifact-consumers',
    ok: hardMissing.length === 0,
    findings,
    evidence,
  };
}

function auditBuildPipeline(root = process.cwd()) {
  const repoRoot = path.resolve(root);
  const report = {
    ok: true,
    repoRoot,
    generatedAt: new Date().toISOString(),
    graph: {
      entrypoints: [
        'cobolt-cli build',
        'cli/index.js',
        'cli/commands/build.js',
        'cli/lib/chain-loop.js',
        'source/skills/cobolt-build/SKILL.md',
      ],
      stages: [],
      handoffs: [],
      subPipelines: ['cobolt-review', 'cobolt-fix', 'cobolt-nfr-enforce'],
      terminalConditions: [
        'milestone-complete',
        'auto-next-milestone',
        'final-review-fix-audit-validate',
        'fail-closed',
      ],
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
    'cli/commands/build.js',
    'cli/lib/chain-loop.js',
    'cli/lib/gate-runner.js',
    'source/skills/cobolt-build/SKILL.md',
    'source/hooks/cobolt-build-steps.js',
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
  const cliBuild = readText(repoRoot, 'cli/commands/build.js');
  const chainLoopSource = readText(repoRoot, 'cli/lib/chain-loop.js');
  const buildSkill = readText(repoRoot, 'source/skills/cobolt-build/SKILL.md');
  const gateRunnerSource = readText(repoRoot, 'cli/lib/gate-runner.js');
  const readinessCheckSource = readText(repoRoot, 'tools/cobolt-readiness-check.js');
  const preDispatch = readText(repoRoot, 'source/hooks/cobolt-pre-dispatch.js');
  const postDispatch = readText(repoRoot, 'source/hooks/cobolt-post-dispatch.js');
  const dispatchAcl = readText(repoRoot, 'source/hooks/cobolt-dispatch-acl.js');
  const modelConfig = parseJson(repoRoot, 'source/templates/model-config.json');
  const toolsIndex = require(path.join(repoRoot, 'tools', 'index.js'));
  const chainLoop = require(path.join(repoRoot, 'cli', 'lib', 'chain-loop.js'));
  const hookSteps = require(path.join(repoRoot, 'source', 'hooks', 'cobolt-build-steps.js'));
  const gateRunner = require(path.join(repoRoot, 'cli', 'lib', 'gate-runner.js'));

  addCheck(
    report,
    'entrypoint',
    'CLI root wires build',
    /commands\/build|\.\/commands\/build/.test(cliIndex),
    'CLI root wires build command',
  );
  for (const symbol of [
    'parseBuildArgs',
    'buildMilestoneLoop',
    'runBuildStep',
    'writePreflightArtifacts',
    'setBuildTeamActive',
    'prepareDeferredTaskPreamble',
    'reconcileDeferredTaskExecution',
  ]) {
    addCheck(
      report,
      'entrypoint',
      `cli/commands/build.js ${symbol}`,
      cliBuild.includes(symbol),
      `Build wrapper references ${symbol}`,
    );
  }

  const wrapperStageIds = ['00-preflight', ...chainLoop.BUILD_STEPS.map(stepStateId)];
  report.graph.stages = wrapperStageIds;
  report.graph.handoffs = wrapperStageIds.slice(0, -1).map((id, index) => [id, wrapperStageIds[index + 1]]);
  report.graph.handoffs.push([
    '05-review',
    'cobolt-build-review-step -> cobolt-cli review M{x} --autonomous --build-pipeline',
  ]);
  report.graph.handoffs.push(['06-fix', 'cobolt-fix M{x} --autonomous --build-pipeline']);
  report.graph.handoffs.push(['06d-nfr-enforce', 'cobolt-nfr-enforce']);
  report.graph.handoffs.push(['08-milestone-complete', 'next milestone or final stages']);

  addCheck(
    report,
    'graph',
    '22 hook-level build steps',
    hookSteps.BUILD_STEP_COUNT === 22,
    `Hook metadata reports ${hookSteps.BUILD_STEP_COUNT} build steps`,
  );
  addCheck(
    report,
    'graph',
    '21 wrapper steps plus preflight',
    chainLoop.BUILD_STEPS.length === 21,
    `Wrapper reports ${chainLoop.BUILD_STEPS.length} executable steps plus preflight`,
  );
  addCheck(
    report,
    'graph',
    'wrapper and hook step order match',
    JSON.stringify(wrapperStageIds) === JSON.stringify(hookSteps.BUILD_STEP_IDS),
    'Wrapper step order matches source/hooks/cobolt-build-steps.js',
    { wrapperStageIds, hookStageIds: hookSteps.BUILD_STEP_IDS },
  );
  addCheck(
    report,
    'graph',
    'step weights sum to 100',
    Object.values(hookSteps.BUILD_STEP_WEIGHTS).reduce((sum, weight) => sum + weight, 0) === 100,
    'Build progress weights sum to 100',
  );

  for (const [stepId, toolFile] of Object.entries({
    '01': 'cobolt-build-setup-step.js',
    '01a': 'cobolt-story-specs.js',
    '01b': 'cobolt-build-spec-validation-step.js',
    '02': 'cobolt-build-tdd-red-step.js',
    // PR-4 (v0.54.0) — 02a uses cobolt-story-mock-wire.js as the deterministic wrapper.
    '02a': 'cobolt-story-mock-wire.js',
    '03': 'cobolt-build-tdd-green-step.js',
    // PR-4 (v0.54.0) — 04a0 uses cobolt-code-quality-check.js as the deterministic wrapper.
    '04a0': 'cobolt-code-quality-check.js',
    '03a': 'cobolt-build-code-gap-step.js',
    '03b': 'cobolt-build-integration-smoke.js',
    '04': 'cobolt-build-refactor-gate.js',
    '04a': 'cobolt-build-deep-verification-step.js',
    '04b': 'cobolt-build-issue-registry-step.js',
    // PR-4 (v0.54.0) — 04c uses cobolt-story-cumulative-smoke.js as the deterministic wrapper.
    '04c': 'cobolt-story-cumulative-smoke.js',
    '05': 'cobolt-build-review-step.js',
    '06b': 'contract-replay.js',
    '06c': 'cobolt-schema-replay.js',
    '06d': 'cobolt-nfr-enforce.js',
    '07': 'cobolt-build-validate-step.js',
    '08b': 'cobolt-build-cross-smoke-step.js',
    '08': 'cobolt-build-complete-step.js',
  })) {
    addCheck(
      report,
      'stage-wrapper',
      `${stepId} deterministic wrapper`,
      chainLoopSource.includes(`'${stepId}':`) && chainLoopSource.includes(toolFile),
      `Step ${stepId} is wired to deterministic wrapper ${toolFile}`,
    );
  }

  for (const stepId of wrapperStageIds) {
    const stepPath = path.join('source', 'skills', 'cobolt-build', 'steps', `${stepId}.md`);
    const stepExists = exists(repoRoot, stepPath);
    addCheck(report, 'stage', `${stepId} step file`, stepExists, `${stepPath} exists`);
    if (!stepExists) continue;
    const text = readText(repoRoot, stepPath);
    const wrapperStep = chainLoop.BUILD_STEPS.find((step) => stepStateId(step) === stepId);
    const artifacts =
      stepId === '00-preflight'
        ? ['_cobolt-output/latest/build/proofs/{m}-00-preflight.proof.json']
        : wrapperStep.artifacts;
    const stage = {
      id: stepId,
      file: stepPath,
      label: hookSteps.BUILD_STEP_LABELS[stepId],
      weight: hookSteps.BUILD_STEP_WEIGHTS[stepId],
      artifacts,
      agents: [
        ...new Set([...text.matchAll(/(?:Agent:|subagent_type:|dispatch(?:es)? `)([a-z0-9-]+)/gi)].map((m) => m[1])),
      ].sort(),
      tools: extractScriptRefs(text).filter((file) => exists(repoRoot, path.join('tools', file))),
    };
    report.stages.push(stage);

    addCheck(
      report,
      'stage',
      `${stepId} referenced by skill`,
      buildSkill.includes(`${stepId}.md`),
      `${stepId}.md is referenced by SKILL.md`,
    );
    addCheck(
      report,
      'stage',
      `${stepId} has checkpoint language`,
      /checkpoint/i.test(text),
      `${stepId} documents checkpoint behavior`,
    );
    addCheck(
      report,
      'stage',
      `${stepId} has output/artifact language`,
      /artifact|output/i.test(text),
      `${stepId} documents output artifacts`,
    );
    addCheck(
      report,
      'stage',
      `${stepId} artifact contract`,
      artifacts.length > 0,
      `${stepId} has expected artifact contract`,
    );
    if (wrapperStep) {
      for (const artifact of wrapperStep.artifacts) {
        addCheck(
          report,
          'artifact',
          `${stepId}:${artifact}`,
          artifact.includes('{m}'),
          `${stepId} artifact is milestone-scoped: ${artifact}`,
        );
      }
    }
  }

  addCheck(
    report,
    'stage',
    'Step 05 delegates review',
    /cobolt-build-review-step\.js|cobolt-cli\s+review\s+M\{?x\}?|cobolt-review\s+M\{?x\}?|cobolt-review M/.test(
      readText(repoRoot, 'source/skills/cobolt-build/steps/05-review.md'),
    ),
    'Step 05 delegates to source-backed cobolt-review through the deterministic build wrapper',
  );
  addCheck(
    report,
    'stage',
    'Step 06 delegates fix',
    /cobolt-fix\s+M\{?x\}?|cobolt-fix M/.test(readText(repoRoot, 'source/skills/cobolt-build/steps/06-fix.md')),
    'Step 06 delegates to cobolt-fix',
  );
  addCheck(
    report,
    'stage',
    'Step 06D delegates NFR skill',
    buildSkill.includes('06d-nfr-enforce') && exists(repoRoot, 'source/skills/cobolt-nfr-enforce/SKILL.md'),
    'Step 06D has cobolt-nfr-enforce skill available',
  );
  addCheck(
    report,
    'recovery',
    'autonomous recovery loop exists',
    chainLoopSource.includes('runBuildStepWithAutonomousRecovery'),
    'Wrapper retries failed steps before escalation',
  );
  addCheck(
    report,
    'recovery',
    'advisory escalation exists',
    chainLoopSource.includes('runAutonomousAdvisoryEscalation'),
    'Wrapper has advisory escalation path',
  );
  addCheck(
    report,
    'recovery',
    'carry-forward fails closed',
    chainLoopSource.includes('writeAutonomousStepCarryForward') && chainLoopSource.includes('return { exitCode: 1'),
    'Carry-forward evidence does not green-light failed steps',
  );
  addCheck(
    report,
    'state',
    'team-active lifecycle exists',
    chainLoopSource.includes('setBuildTeamActive(options.toolsDir, true)') &&
      chainLoopSource.includes('setBuildTeamActive(options.toolsDir, false)'),
    'Build wrapper activates and clears teamActive',
  );
  addCheck(
    report,
    'state',
    'artifact chain guard exists',
    chainLoopSource.includes('verifyPreviousArtifactChain') && chainLoopSource.includes('writeStepArtifactChain'),
    'Build wrapper verifies predecessor artifact chains',
  );

  const buildGates = gateRunner.getGates('build', 'M1', path.join(repoRoot, 'tools'));
  report.gates = buildGates.map((gate) => ({ name: gate.name, hard: Boolean(gate.hard) }));
  for (const gateName of REQUIRED_GATE_NAMES) {
    const gate = buildGates.find((entry) => entry.name === gateName);
    addCheck(report, 'gate', gateName, Boolean(gate), `Build preflight gate exists: ${gateName}`);
    if (gate)
      addCheck(report, 'gate', `${gateName} hard`, gate.hard === true, `Build preflight gate is hard: ${gateName}`);
  }
  for (const stopLine of [
    'Production prebuild evidence',
    'Planning artifacts',
    'Planning quality authorization',
    'RTM coverage >= 85%',
    'Infrastructure validation',
  ]) {
    addCheck(
      report,
      'gate',
      `${stopLine} stop-line`,
      chainLoop.hasStopLinePreflightFailure({ results: [{ name: stopLine, passed: false }] }) === true,
      `${stopLine} is classified as a stop-line failure`,
    );
  }
  addCheck(
    report,
    'gate',
    'Planning quality authorization passes milestone scope',
    /evaluateBuildPlanningReadiness[\s\S]{0,180}milestone/.test(gateRunnerSource),
    'Build gate passes the active milestone into planning quality readiness',
  );
  addCheck(
    report,
    'gate',
    'Readiness check supports --milestone',
    /--milestone/.test(readinessCheckSource) && /filterRequirementsByMilestone/.test(readinessCheckSource),
    'Readiness scoring can scope traceability and story-density checks to the active milestone',
  );

  const allBuildText = [
    buildSkill,
    ...wrapperStageIds.map((id) =>
      exists(repoRoot, path.join('source/skills/cobolt-build/steps', `${id}.md`))
        ? readText(repoRoot, path.join('source/skills/cobolt-build/steps', `${id}.md`))
        : '',
    ),
    ...fs
      .readdirSync(path.join(repoRoot, 'source/skills/cobolt-build/references'))
      .filter((file) => file.endsWith('.md'))
      .map((file) => readText(repoRoot, path.join('source/skills/cobolt-build/references', file))),
  ].join('\n');
  const scriptRefs = extractScriptRefs(allBuildText);
  const indexToolRefs = extractIndexToolRefs(allBuildText);
  const registeredToolNames = new Set(Object.keys(toolsIndex.TOOLS || {}));
  for (const file of scriptRefs) {
    const locations = [
      path.join('tools', file),
      path.join('lib', file),
      path.join('source', 'hooks', file),
      path.join('source', 'hooks', 'dist', file),
      path.join('source', 'plugins', file),
    ];
    const found = locations.find((rel) => exists(repoRoot, rel));
    const tool = { file, exists: Boolean(found), path: found || null };
    report.tools.push(tool);
    addCheck(report, 'tool', file, tool.exists, `Referenced build script exists: ${file}`);
  }
  for (const toolName of indexToolRefs) {
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
    'build-pipeline-audit tool registered',
    registeredToolNames.has('build-pipeline-audit'),
    'tools/index.js registers this audit harness',
  );
  addCheck(
    report,
    'tool',
    'source-backed CoBolt tool paths',
    !/\bnode\s+tools[\\/]+cobolt-/u.test(allBuildText) &&
      !/\bnode\s+tools[\\/]+index\.js/u.test(allBuildText) &&
      !/['"]tools[\\/]+cobolt-/u.test(allBuildText) &&
      !/COBOLT_TOOLS=["']?\$\{COBOLT_TOOLS:-\.\/tools\}/u.test(allBuildText) &&
      !/TOOLS_DIR=["']?\$\{COBOLT_TOOLS:-\.\/tools\}/u.test(allBuildText) &&
      !/\.\/tools\/cobolt-preflight\.js/u.test(allBuildText) &&
      !/require\(['"]\.\/tools[\\/]+cobolt-/u.test(allBuildText) &&
      buildSkill.includes('COBOLT_TOOLS'),
    'Build instructions and references use COBOLT_TOOLS instead of project-local tools fallbacks',
  );

  const testRunner = require(path.join(repoRoot, 'tools', 'cobolt-test.js'));
  const testRunnerSource = readText(repoRoot, 'tools/cobolt-test.js');
  const codexRunner = require(path.join(repoRoot, 'cli', 'lib', 'codex-runner.js'));
  addCheck(
    report,
    'tool',
    'cobolt-test dotnet support',
    Boolean(testRunner.FRAMEWORKS?.dotnet?.detectFn) &&
      testRunner.FRAMEWORKS.dotnet.cmd === 'dotnet' &&
      typeof testRunner.FRAMEWORKS.dotnet.env === 'function',
    'cobolt-test.js detects and runs .NET test projects',
  );
  addCheck(
    report,
    'tool',
    'cobolt-test dotnet process hygiene',
    testRunner.FRAMEWORKS.dotnet.args.includes('--disable-build-servers') &&
      testRunner.FRAMEWORKS.dotnet.compileArgs.includes('--disable-build-servers') &&
      testRunnerSource.includes('MSBUILDDISABLENODEREUSE'),
    'cobolt-test.js disables .NET build servers and MSBuild node reuse',
  );
  addCheck(
    report,
    'runner',
    'Codex timeout process-tree cleanup',
    typeof codexRunner.terminateProcessTree === 'function',
    'cli/lib/codex-runner.js exposes process-tree termination for timeout cleanup',
  );
  addCheck(
    report,
    'gate',
    'Build gate quality artifact backfill',
    gateRunnerSource.includes('runPlanQualityArtifactBackfill(toolsDir)') &&
      gateRunnerSource.includes('cobolt-plan-quality-artifacts.js'),
    'Build planning-artifact gate backfills canonical Plan quality artifacts before hard preflight checks',
  );
  const assertionQualitySource = readText(repoRoot, 'tools/cobolt-test-assertion-quality.js');
  addCheck(
    report,
    'tool',
    'assertion-quality C# support',
    assertionQualitySource.includes("'.cs'") &&
      assertionQualitySource.includes('CSHARP_TEST_ATTRIBUTE_RE') &&
      assertionQualitySource.includes('Assert\\.'),
    'cobolt-test-assertion-quality.js scans C# test methods and Assert calls',
  );

  const registeredPreHooks = extractArrayStrings(preDispatch, 'PRE_HOOKS');
  const registeredPostHooks = extractArrayStrings(postDispatch, 'POST_HOOKS');
  for (const hook of REQUIRED_BUILD_HOOKS) {
    const hookExists = exists(repoRoot, path.join('source', 'hooks', hook));
    const registered = registeredPreHooks.has(hook) || registeredPostHooks.has(hook);
    report.hooks.push({ hook, exists: hookExists, registered });
    addCheck(report, 'hook', `${hook} exists`, hookExists, `Hook file exists: ${hook}`);
    addCheck(report, 'hook', `${hook} registered`, registered, `Hook is registered by pre/post dispatcher: ${hook}`);
  }
  for (const bypassHook of [
    'cobolt-nfr-budget-gate.js',
    'cobolt-migration-replay-gate.js',
    'cobolt-contract-break-gate.js',
  ]) {
    const rel = path.join('source', 'hooks', bypassHook);
    const text = exists(repoRoot, rel) ? readText(repoRoot, rel) : '';
    addCheck(
      report,
      'hook',
      `${bypassHook} bypass audit`,
      text.includes('gate-skip-log') || text.includes('bypass'),
      `${bypassHook} records bypass/kill-switch evidence`,
    );
  }

  const buildAcl = extractArrayStrings(dispatchAcl, 'build');
  const reviewAcl = extractArrayStrings(dispatchAcl, 'review');
  const fixAcl = extractArrayStrings(dispatchAcl, 'fix');
  const crossStageAcl = extractArrayStrings(dispatchAcl, 'CROSS_STAGE_AGENTS');
  const sidecarAcl = extractArrayStrings(dispatchAcl, 'SIDECAR_ESCALATION_AGENTS');
  const tierIndex = buildModelTierIndex(modelConfig);
  for (const agentSpec of getAllAgentSpecs()) {
    const agentPath = path.join('source', 'agents', `${agentSpec.name}.md`);
    const agent = { name: agentSpec.name, acl: agentSpec.acl, path: agentPath };
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
    const hasAgentTool = tools.includes('Agent');
    agent.frontmatter = fm;
    agent.tools = tools;
    agent.hasWriteTool = hasWriteTool;
    agent.hasAgentTool = hasAgentTool;
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
    if (READ_ONLY_AGENTS.has(agentSpec.name)) {
      addCheck(
        report,
        'agent',
        `${agentSpec.name} read-only tools`,
        !hasWriteTool && !hasAgentTool,
        `${agentSpec.name} has no write/edit/Agent tool`,
      );
    }
    if (WRITE_EXPECTED_AGENTS.has(agentSpec.name)) {
      addCheck(
        report,
        'agent',
        `${agentSpec.name} write-capable tools`,
        hasWriteTool || hasAgentTool,
        `${agentSpec.name} has expected write or orchestration capability`,
      );
    }
    addCheck(
      report,
      'agent',
      `${agentSpec.name} failure output`,
      content.includes(FAILURE_INCLUDE) || /Failure Output Contract/i.test(content),
      `${agentSpec.name} includes a failure output contract`,
    );

    let aclOk = false;
    if (agentSpec.acl === 'build') aclOk = buildAcl.has(agentSpec.name);
    if (agentSpec.acl === 'review') aclOk = reviewAcl.has(agentSpec.name);
    if (agentSpec.acl === 'fix') aclOk = fixAcl.has(agentSpec.name);
    if (agentSpec.acl === 'cross') aclOk = crossStageAcl.has(agentSpec.name);
    if (agentSpec.acl === 'sidecar') aclOk = sidecarAcl.has(agentSpec.name);
    addCheck(
      report,
      'agent',
      `${agentSpec.name} dispatch ACL`,
      aclOk,
      `${agentSpec.name} is allowed by expected dispatch ACL (${agentSpec.acl})`,
    );
  }

  addCheck(
    report,
    'agent',
    'contract sidecar regex',
    /contract-replay|contract break|06b-contract-replay/.test(dispatchAcl),
    'Dispatch ACL sidecar context covers Step 06B contract quorum',
  );
  addCheck(
    report,
    'agent',
    'model-tier gate source',
    exists(repoRoot, 'source/hooks/cobolt-model-tier-gate.js') && tierIndex.has('cobolt-build-lead'),
    'Model-tier gate can validate build lead tier',
  );
  addCheck(
    report,
    'agent',
    'write guard source',
    exists(repoRoot, 'source/hooks/cobolt-subagent-write-guard.js') && buildSkill.includes('team-active'),
    'Write guard and team-active contract are present',
  );
  addCheck(
    report,
    'agent',
    'dispatch ledger tool',
    exists(repoRoot, 'tools/cobolt-agent-dispatch-ledger.js'),
    'Dispatch ledger writer exists',
  );

  // v0.47.4 structural invariants.
  const v0474Checks = [
    checkReleaseOrdering(repoRoot),
    checkMilestoneWorktreeInvariant(repoRoot),
    checkQualityArtifactConsumers(repoRoot),
  ];
  report.v0474 = v0474Checks;
  for (const result of v0474Checks) {
    const message =
      result.ok === true
        ? `${result.id} invariant holds`
        : `${result.id} failures: ${result.findings
            .map((f) => `${f.kind}${f.line ? `@${f.line}` : ''}${f.artifact ? `(${f.artifact})` : ''}`)
            .join(', ')}`;
    addCheck(report, 'v0474', result.id, result.ok, message, {
      findings: result.findings,
      evidence: result.evidence,
    });
  }

  report.summary = {
    checks: report.checks.length,
    failures: report.issues.length,
    stages: report.stages.length,
    tools: report.tools.length,
    hooks: report.hooks.length,
    agents: report.agents.length,
    gates: report.gates.length,
    v0474: v0474Checks.length,
  };
  report.ok = report.issues.length === 0;
  return report;
}

function printHuman(report) {
  console.log('CoBolt Build Pipeline Audit');
  console.log(`Repo: ${report.repoRoot}`);
  console.log(`Checks: ${report.summary?.checks || report.checks.length}`);
  console.log(`Failures: ${report.summary?.failures || report.issues.length}`);
  console.log();
  console.log('Graph:');
  for (const stage of report.graph.stages) console.log(`  ${stage}`);
  console.log();
  if (report.issues.length === 0) {
    console.log('PASS: Build pipeline source contracts are internally consistent.');
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
  const report = auditBuildPipeline(args.root);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  BUILD_STAGE_AGENTS,
  REVIEW_PIPELINE_AGENTS,
  FIX_PIPELINE_AGENTS,
  REQUIRED_BUILD_HOOKS,
  REQUIRED_GATE_NAMES,
  QUALITY_ARTIFACT_CONSUMER_PAIRS,
  auditBuildPipeline,
  checkReleaseOrdering,
  checkMilestoneWorktreeInvariant,
  checkQualityArtifactConsumers,
  extractScriptRefs,
  extractIndexToolRefs,
  findLoopBlock,
  lineNumberOfOffset,
  parseFrontmatter,
  main,
};
