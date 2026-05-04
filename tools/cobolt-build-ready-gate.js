#!/usr/bin/env node

// CoBolt Build-Ready Gate — deterministic planning → build handoff verification.
//
// Runs cobolt-preflight for cobolt-build, classifies missing artifacts into
// deterministic (fixable by tools alone) vs LLM-required (need skill re-dispatch),
// auto-remediates deterministic gaps in-place, and emits a structured verdict.
//
// Usage:
//   node tools/cobolt-build-ready-gate.js [M1|--milestone M1] --json
//   node tools/cobolt-build-ready-gate.js --autonomous   # remediate + re-check once
//
// Exit codes:
//   0 = READY  — planning is build-ready, chain to infra/build
//   1 = BLOCKED — unrecoverable without LLM; remediation queue written
//   2 = usage/internal error
//
// Remediation queue written to:
//   _cobolt-output/latest/planning/build-ready-remediation.json
// Plan SKILL reads this and dispatches the listed skills deterministically.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const REPO = process.cwd();
const PLANNING = path.join(REPO, '_cobolt-output', 'latest', 'planning');
const RTM_HANDOFF_MODE = 'mapped';
const TOOL_DIR = process.env.COBOLT_TOOLS ? path.resolve(process.env.COBOLT_TOOLS) : __dirname;
const USAGE = [
  'Usage:',
  '  node tools/cobolt-build-ready-gate.js [M1|--milestone M1] --json',
  '  node tools/cobolt-build-ready-gate.js --autonomous',
].join('\n');

function toolScript(name) {
  return path.join(TOOL_DIR, name);
}

function nodeToolArgs(args) {
  const [script, ...rest] = args;
  if (!script) return args;
  if (path.isAbsolute(script)) return args;

  const normalized = String(script).replaceAll('\\', '/');
  if (normalized.startsWith('tools/')) {
    return [toolScript(path.basename(script)), ...rest];
  }
  return [script, ...rest];
}

// v0.13.5: layered threshold resolution (env > cobolt-state.projectConfig > default)
let _cfg;
try {
  _cfg = require(path.resolve(__dirname, '..', 'lib', 'cobolt-config.js'));
} catch {
  _cfg = null;
}
function cfg(k, d) {
  return _cfg ? _cfg.getConfig(k, d) : d;
}

// Producer skill → { deterministic, tool } mapping. Preflight reports the
// producing skill on each missing artifact via the `producedBy` field, so we
// key off that rather than artifact ids (which vary per artifact type).
const PRODUCERS = {
  'cobolt-create-prd': { deterministic: false },
  'cobolt-validate-prd': { deterministic: false },
  'cobolt-analyze-features': { deterministic: false },
  'cobolt-feature-coverage': {
    deterministic: true,
    tool: ['tools/cobolt-feature-coverage.js', 'check', '--stage', 'final', '--json'],
  },
  'cobolt-create-story': { deterministic: false },
  'cobolt-tracker-init': { deterministic: true, tool: ['tools/cobolt-tracker-init.js', 'generate'] },
  'cobolt-decompose-milestones': { deterministic: false },
  'cobolt-create-epics-and-stories': { deterministic: false },
  'cobolt-create-architecture': { deterministic: false },
  'cobolt-create-trd': { deterministic: false },
  'cobolt-create-ux-design': { deterministic: false },
  'cobolt-create-wireframes': { deterministic: false },
  'cobolt-master-plan': { deterministic: false },
  'cobolt-rtm': { deterministic: true, tool: ['tools/cobolt-rtm.js', 'render-matrix'] },
  'cobolt-milestone-execution-obligations': {
    deterministic: true,
    tool: ['tools/cobolt-milestone-execution-obligations.js', 'generate', '--json'],
  },
};
function producerFor(artifact) {
  const skill = artifact.producedBy;
  return skill ? { skill, ...(PRODUCERS[skill] || { deterministic: false }) } : null;
}

function runPreflight() {
  try {
    const out = execFileSync('node', [toolScript('cobolt-preflight.js'), 'check', 'cobolt-build', '--json'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out);
  } catch (err) {
    // preflight exits 1 on failure but still emits JSON on stdout
    const stdout = err.stdout ? err.stdout.toString() : '';
    try {
      return JSON.parse(stdout);
    } catch {
      return { passed: false, missing: [], parseError: true };
    }
  }
}

function runDeterministicRemediations(missing) {
  const ran = [];
  const seen = new Set();
  for (const m of missing) {
    const p = producerFor(m);
    if (!p?.deterministic || !p.tool) continue;
    if (seen.has(p.skill)) continue;
    seen.add(p.skill);
    try {
      execFileSync('node', nodeToolArgs(p.tool), { cwd: REPO, stdio: 'pipe' });
      ran.push({ skill: p.skill, artifact: m.id, tool: p.tool.join(' '), status: 'ok' });
    } catch (err) {
      ran.push({
        skill: p.skill,
        artifact: m.id,
        tool: p.tool.join(' '),
        status: 'failed',
        error: String(err.message).slice(0, 200),
      });
    }
  }
  return ran;
}

function buildRemediationQueue(missing) {
  const queue = [];
  const seen = new Set();
  for (const m of missing) {
    const p = producerFor(m);
    if (!p || p.deterministic) continue;
    if (seen.has(p.skill)) continue;
    seen.add(p.skill);
    queue.push({
      skill: p.skill,
      artifact: m.id,
      path: m.path,
      reason: m.description || 'missing or below minBytes',
      dispatch: `${p.skill} --autonomous`,
    });
  }
  return queue;
}

function writeVerdict(verdict) {
  atomicWrite(path.join(PLANNING, 'build-ready-remediation.json'), JSON.stringify(verdict, null, 2));
}

function normalizeMilestone(value) {
  const match = String(value || '')
    .trim()
    .match(/^M?(\d+)$/i);
  return match ? `M${Number(match[1])}` : null;
}

function stateMilestone() {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(REPO, 'cobolt-state.json'), 'utf8'));
    return (
      normalizeMilestone(state.pipeline?.currentMilestone) ||
      normalizeMilestone(state.build?.currentMilestone) ||
      normalizeMilestone(state.currentMilestone)
    );
  } catch {
    return null;
  }
}

function resolveMilestone(args = process.argv.slice(2)) {
  const namedIdx = args.indexOf('--milestone');
  if (namedIdx !== -1) {
    const named = normalizeMilestone(args[namedIdx + 1]);
    if (named) return named;
  }

  const positional = args.find((arg) => !String(arg || '').startsWith('-') && normalizeMilestone(arg));
  return normalizeMilestone(positional) || stateMilestone() || 'M1';
}

// v0.13.4: delegate content-depth checks to the tools that build-time gates
// actually enforce. Preflight checks existence+size; build-time gates check
// content. Previously these disagreed — preflight said READY while
// production-evidence-gate blocked at build entry with prebuild score 33/90.
// Now build-ready-gate fails closed when production-evidence / RTM fail.
function runContentDepthChecks(milestone = resolveMilestone()) {
  const problems = [];
  const resolvedMilestone = normalizeMilestone(milestone) || resolveMilestone();

  let prebuild = null;
  try {
    const out = execFileSync(
      'node',
      [
        toolScript('cobolt-production-evidence.js'),
        'check',
        '--phase',
        'prebuild',
        '--milestone',
        resolvedMilestone,
        '--json',
      ],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    prebuild = JSON.parse(out);
  } catch (err) {
    const stdout = err.stdout ? err.stdout.toString() : '';
    try {
      prebuild = JSON.parse(stdout);
    } catch {
      prebuild = null;
    }
  }
  if (prebuild) {
    const score = Number(prebuild.score ?? prebuild.summary?.score ?? 0);
    const min = Number(prebuild.minScore ?? cfg('PREBUILD_MIN_SCORE', 90));
    if (score < min) {
      // Derive which stubs need regeneration from blockers.
      const blockers = Array.isArray(prebuild.blockers) ? prebuild.blockers : [];
      problems.push({
        check: 'production-evidence-prebuild',
        severity: 'critical',
        score,
        minScore: min,
        blockers: blockers.slice(0, 10),
        remediation: {
          skill: 'cobolt-analyze-features',
          artifact: 'executable-prd.json / release-slices.json / architecture-readiness.json / boundary-contracts.json',
          dispatch: 'cobolt-analyze-features --autonomous',
          reason: `prebuild score ${score}/${min} — stubs lack substantive per-FR content`,
        },
      });
    }
  } else {
    problems.push({
      check: 'production-evidence-prebuild',
      severity: 'critical',
      remediation: {
        skill: 'cobolt-analyze-features',
        dispatch: `node tools/cobolt-production-evidence.js check --phase prebuild --milestone ${resolvedMilestone}`,
        reason: 'production-evidence tool produced no readable JSON',
      },
    });
  }

  // Global RTM coverage (not just --mode mapped).
  try {
    const out = execFileSync(
      'node',
      [
        toolScript('cobolt-rtm.js'),
        'check',
        '--milestone',
        resolvedMilestone,
        '--threshold',
        String(cfg('RTM_MIN_COVERAGE', 85)),
        '--mode',
        RTM_HANDOFF_MODE,
        '--json',
      ],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const rtm = JSON.parse(out);
    const coverage = Number(rtm.coverage ?? rtm.summary?.coverage ?? 0);
    const passed = rtm.passed === true;
    const rtmMin = cfg('RTM_MIN_COVERAGE', 85);
    if (!passed || coverage < rtmMin) {
      problems.push({
        check: 'rtm-global-coverage',
        severity: 'critical',
        coverage,
        threshold: rtmMin,
        remediation: {
          skill: 'cobolt-rtm',
          dispatch: 'node tools/cobolt-rtm.js import-prd && cobolt-analyze-features --autonomous',
          reason: `RTM global coverage ${coverage}% < ${rtmMin}% — FR extraction or mapping incomplete`,
        },
      });
    }
  } catch {
    /* RTM tool failure is already flagged by preflight */
  }

  return problems;
}

function runEnhancementChecks() {
  try {
    const out = execFileSync('node', [toolScript('cobolt-milestone-execution-obligations.js'), 'check', '--json'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(out);
    const document = result?.document;
    if (result?.passed !== true || !document || document.status !== 'advisory') return [];
    return [
      {
        check: 'milestone-execution-obligations',
        severity: 'advisory',
        status: document.status,
        enhancements: Array.isArray(document.enhancementQueue) ? document.enhancementQueue.slice(0, 20) : [],
        driftDetectors: Array.isArray(document.driftDetectors) ? document.driftDetectors : [],
        reviewLeadPacket: document.escalationPackets?.reviewLead || null,
        recoveryAdvisorPacket: document.escalationPackets?.recoveryAdvisor || null,
      },
    ];
  } catch {
    return [];
  }
}

function printUsage(code) {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(`${USAGE}\n`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage(0);
    process.exit(0);
  }
  if (args.length === 0) {
    printUsage(1);
    process.exit(1);
  }
  const autonomous = args.includes('--autonomous');
  const jsonOut = args.includes('--json') || autonomous;
  const milestone = resolveMilestone(args);

  const first = runPreflight();

  // Run content-depth checks even when preflight passes — this is the v0.13.4
  // fix: preflight checks existence+size, content-depth checks actual quality.
  // Previously these disagreed, causing MAY_PROCEED_WITH_CARRY_FORWARD handoffs
  // that the production-evidence-gate would then block at build entry.
  const depthProblems = runContentDepthChecks(milestone);
  const enhancementAdvisories = runEnhancementChecks();

  if (first.passed === true && depthProblems.length === 0) {
    const v = { verdict: 'READY', cycles: 1, preflight: first, enhancementAdvisories };
    writeVerdict(v);
    if (jsonOut) console.log(JSON.stringify(v, null, 2));
    else
      console.log(
        enhancementAdvisories.length > 0
          ? `[BUILD-READY] preflight + content-depth passed with ${enhancementAdvisories.length} enhancement advisory`
          : '[BUILD-READY] preflight + content-depth passed',
      );
    process.exit(0);
  }

  // If preflight passed but depth checks failed, surface the depth queue.
  if (first.passed === true && depthProblems.length > 0) {
    const queue = depthProblems
      .filter((p) => p.remediation)
      .map((p) => ({
        skill: p.remediation.skill,
        artifact: p.remediation.artifact || p.check,
        reason: p.remediation.reason,
        dispatch: p.remediation.dispatch,
      }));
    const verdict = {
      verdict: 'LLM_REMEDIATION_REQUIRED',
      cycles: 1,
      preflight: first,
      contentDepthProblems: depthProblems,
      enhancementAdvisories,
      remediationQueue: queue,
      instruction:
        'Preflight (existence+size) passed but content-depth checks failed. ' +
        'Plan orchestrator MUST dispatch remediationQueue skills (--autonomous), ' +
        'then re-run this gate. Build-time gates (production-evidence, RTM) will block otherwise.',
    };
    writeVerdict(verdict);
    if (jsonOut) console.log(JSON.stringify(verdict, null, 2));
    else
      console.error(
        `[BUILD-READY-${verdict.verdict}] ${depthProblems.length} content-depth problem(s); queue=${queue.length}`,
      );
    process.exit(1);
  }

  const missing = Array.isArray(first.missing) ? first.missing : [];
  const deterministicRuns = autonomous ? runDeterministicRemediations(missing) : [];

  // Re-check after deterministic remediation
  const second = autonomous ? runPreflight() : first;
  if (second.passed === true) {
    const v = { verdict: 'READY', cycles: 2, deterministicRuns, preflight: second, enhancementAdvisories };
    writeVerdict(v);
    if (jsonOut) console.log(JSON.stringify(v, null, 2));
    else
      console.log(
        enhancementAdvisories.length > 0
          ? '[BUILD-READY] preflight passed after deterministic remediation with enhancement advisories'
          : '[BUILD-READY] preflight passed after deterministic remediation',
      );
    process.exit(0);
  }

  const stillMissing = Array.isArray(second.missing) ? second.missing : [];
  const queue = buildRemediationQueue(stillMissing);
  // Merge content-depth problems into the queue so nothing is dropped.
  for (const p of depthProblems) {
    if (p.remediation) {
      queue.push({
        skill: p.remediation.skill,
        artifact: p.remediation.artifact || p.check,
        reason: p.remediation.reason,
        dispatch: p.remediation.dispatch,
      });
    }
  }
  const verdict = {
    verdict: queue.length > 0 ? 'LLM_REMEDIATION_REQUIRED' : 'BLOCKED',
    cycles: autonomous ? 2 : 1,
    deterministicRuns,
    stillMissing: stillMissing.map((m) => ({ id: m.id, path: m.path, producedBy: m.producedBy })),
    contentDepthProblems: depthProblems,
    enhancementAdvisories,
    remediationQueue: queue,
    instruction:
      queue.length > 0
        ? 'Plan orchestrator MUST dispatch each skill in remediationQueue (via Skill tool, --autonomous), then re-run this gate. Max 1 LLM remediation cycle per gate invocation.'
        : 'No remediation path available — escalate to planning-lead or fix source registry.',
  };
  writeVerdict(verdict);
  if (jsonOut) console.log(JSON.stringify(verdict, null, 2));
  else
    console.error(`[BUILD-READY-${verdict.verdict}] ${stillMissing.length} artifact(s) missing; queue=${queue.length}`);
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  runPreflight,
  runDeterministicRemediations,
  buildRemediationQueue,
  runEnhancementChecks,
  resolveMilestone,
  PRODUCERS,
  RTM_HANDOFF_MODE,
};
