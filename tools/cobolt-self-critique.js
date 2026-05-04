#!/usr/bin/env node
// cobolt-self-critique — verifier for the self-critique + critic-team protocol output.
//
// Planning stage (original): each sub-skill writes
//   _cobolt-output/latest/planning/self-critique/<skill>.json
// per source/skills/_shared/self-critique-protocol.md.
//
// v0.25.0+: generalized to non-planning stages per
// source/skills/_shared/critic-team-protocol.md:
//   build     → _cobolt-output/latest/build/{M}/self-critique/<name>.json
//   fix       → _cobolt-output/latest/fix/{M}/self-critique/round-<N>.json
//   brownfield→ _cobolt-output/latest/brownfield/self-critique/phase-<P>.json
//   validate  → _cobolt-output/latest/validation/{M}/self-critique/validate.json
//   uat       → _cobolt-output/latest/uat/{M}/self-critique/uat.json
//   deploy    → _cobolt-output/latest/deploy/{M}/self-critique/release.json
//
// Usage:
//   cobolt-self-critique verify <skill> [--stage <s>] [--milestone <M>] [--json]
//   cobolt-self-critique status [--stage <s>] [--milestone <M>] [--json]
//
// Exit codes (shared across all stages):
//   0  pass
//   1  verdict=needs-revision (redispatch candidate)
//   2  critique file missing or malformed (redispatch candidate)
//   3  verdict=pass but disk reality contains stub indicators (redispatch required)

const fs = require('node:fs');
const path = require('node:path');

const VALID_STAGES = new Set(['planning', 'build', 'fix', 'brownfield', 'validate', 'uat', 'deploy']);

function resolveCritiqueDir(stage, milestone) {
  const root = path.resolve('_cobolt-output/latest');
  switch (stage) {
    case 'planning':
      return path.join(root, 'planning', 'self-critique');
    case 'build':
      if (!milestone) throw new Error('--milestone required for stage=build');
      return path.join(root, 'build', milestone, 'self-critique');
    case 'fix':
      if (!milestone) throw new Error('--milestone required for stage=fix');
      return path.join(root, 'fix', milestone, 'self-critique');
    case 'brownfield':
      return path.join(root, 'brownfield', 'self-critique');
    case 'validate':
      if (!milestone) throw new Error('--milestone required for stage=validate');
      return path.join(root, 'validation', milestone, 'self-critique');
    case 'uat':
      if (!milestone) throw new Error('--milestone required for stage=uat');
      return path.join(root, 'uat', milestone, 'self-critique');
    case 'deploy':
      if (!milestone) throw new Error('--milestone required for stage=deploy');
      return path.join(root, 'deploy', milestone, 'self-critique');
    default:
      throw new Error(`Unknown stage: ${stage}`);
  }
}

const STUB_PATTERNS = [
  /\bbaseline [a-z ]+ expected\b/i,
  /\brefine during (feature )?design\b/i,
  /\brevisit during feature design\b/i,
  /\bconfirm during architecture\b/i,
  /\bper (feature dossier|architecture|test strategy)\b/i,
  /\bend user, backend service\b/i,
  /\bTODO\b/,
  /\bFIXME\b/,
  /\bXXX\b/,
  /\bPLACEHOLDER\b/i,
  /lorem ipsum/i,
  /<!-- cobolt-plan-repair padding/i,
  /Deterministic stub by cobolt-plan-repair/i,
  /cobolt-plan-repair padding/i,
  /\bDegraded stub padding\b/i,
];

const REQUIRED_TOP_KEYS = [
  'skill',
  'artifact',
  'critiquedAt',
  'schemaCompliance',
  'sourceGrounding',
  'crossArtifactConsistency',
  'contentDepthScore',
  'verdict',
];

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    return { __error: err.message };
  }
}

// v0.47 CB-OBS-08 fix: context-aware stub detection.
// The prior scanner matched \bTODO\b / \bFIXME\b / \bPLACEHOLDER\b on every
// line, flagging governance-policy docs that legitimately mention the token
// (e.g., "TODO/FIXME markers must carry an owner + issue ref, 90-day max
// life"). This created a catch-22: engineering-quality-standards can't
// define deferred-work policy without tripping the stub detector.
//
// Fix: when a line contains a blocklisted token, suppress the finding if
// the token appears inside an explicit governance/allowlist context. The
// heuristic is conservative: the line must contain BOTH the token AND one
// of the allowlist phrases below. Anything else is still flagged.
const STUB_ALLOWLIST_CONTEXT =
  /\b(?:must carry|max life|governance|policy|allowlist|allowed|deferred-work|issue-tracker reference|CI flags stale|owner)\b/i;

// Tokens that support context-suppression (governance docs discuss them).
// baseline/refine/stub padding/lorem ipsum do NOT support suppression —
// those phrases are never a legitimate governance topic.
const CONTEXT_SUPPRESSIBLE_TOKENS = [/\bTODO\b/, /\bFIXME\b/, /\bXXX\b/, /\bPLACEHOLDER\b/i];

function isContextSuppressedHit(line, matchedPattern) {
  const isSuppressible = CONTEXT_SUPPRESSIBLE_TOKENS.some((rx) => rx.source === matchedPattern.source);
  if (!isSuppressible) return false;
  return STUB_ALLOWLIST_CONTEXT.test(line);
}

function scanForStubs(artifactPath) {
  if (!artifactPath) return [];
  const abs = path.isAbsolute(artifactPath) ? artifactPath : path.join(process.cwd(), artifactPath);
  if (!fs.existsSync(abs)) return [{ reason: 'artifact-missing', path: artifactPath }];
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    return [{ reason: 'artifact-unreadable', path: artifactPath, error: err.message }];
  }
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const re of STUB_PATTERNS) {
      const m = lines[i].match(re);
      if (m) {
        if (isContextSuppressedHit(lines[i], re)) continue; // CB-OBS-08 suppression
        hits.push({ file: artifactPath, line: i + 1, match: m[0] });
        break;
      }
    }
    if (hits.length >= 20) break;
  }
  return hits;
}

function verifyCritique(skill, opts = {}) {
  const stage = opts.stage || 'planning';
  const milestone = opts.milestone || null;
  let dir;
  try {
    dir = resolveCritiqueDir(stage, milestone);
  } catch (err) {
    return { skill, code: 2, reason: 'stage-resolution-error', error: err.message };
  }
  const file = path.join(dir, `${skill}.json`);
  if (!fs.existsSync(file)) {
    return { skill, stage, milestone, code: 2, reason: 'critique-file-missing', file };
  }
  const critique = readJSON(file);
  if (critique.__error) {
    return {
      skill,
      stage,
      milestone,
      code: 2,
      reason: 'critique-file-malformed',
      file,
      error: critique.__error,
    };
  }
  const missing = REQUIRED_TOP_KEYS.filter((k) => !(k in critique));
  if (missing.length > 0) {
    return {
      skill,
      stage,
      milestone,
      code: 2,
      reason: 'critique-schema-incomplete',
      file,
      missingKeys: missing,
    };
  }
  if (critique.verdict !== 'pass' && critique.verdict !== 'needs-revision') {
    return {
      skill,
      stage,
      milestone,
      code: 2,
      reason: 'critique-verdict-invalid',
      file,
      verdict: critique.verdict,
    };
  }
  if (critique.verdict === 'needs-revision') {
    return {
      skill,
      stage,
      milestone,
      code: 1,
      reason: 'needs-revision',
      file,
      revisionTargets: critique.revisionTargets || [],
      contentDepthScore: critique.contentDepthScore,
    };
  }

  // verdict=pass — cross-check artifact on disk for stub indicators.
  const artifacts = [critique.artifact, ...(critique.artifactsAlsoProduced || [])].filter(Boolean);
  const allHits = [];
  for (const a of artifacts) {
    const hits = scanForStubs(a);
    allHits.push(...hits);
  }
  if (allHits.length > 0) {
    return {
      skill,
      stage,
      milestone,
      code: 3,
      reason: 'verdict-pass-but-stubs-on-disk',
      file,
      stubHits: allHits.slice(0, 10),
      stubHitCount: allHits.length,
    };
  }

  return {
    skill,
    stage,
    milestone,
    code: 0,
    reason: 'pass',
    file,
    contentDepthScore: critique.contentDepthScore,
    artifacts,
  };
}

function statusAll(opts = {}) {
  const stage = opts.stage || 'planning';
  const milestone = opts.milestone || null;
  let dir;
  try {
    dir = resolveCritiqueDir(stage, milestone);
  } catch (err) {
    return { critiqueDir: null, stage, exists: false, results: [], error: err.message };
  }
  if (!fs.existsSync(dir)) return { critiqueDir: dir, stage, milestone, exists: false, results: [] };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const results = files.map((f) => verifyCritique(path.basename(f, '.json'), { stage, milestone }));
  return { critiqueDir: dir, stage, milestone, exists: true, results };
}

function parseArgs(argv) {
  const args = { stage: 'planning', milestone: null, json: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--stage') {
      args.stage = argv[++i];
    } else if (a === '--milestone') {
      args.milestone = argv[++i];
    } else {
      args.rest.push(a);
    }
  }
  if (!VALID_STAGES.has(args.stage)) {
    console.error(`Invalid --stage: ${args.stage}. Valid: ${[...VALID_STAGES].join('|')}`);
    process.exit(2);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = args.rest;

  if (cmd === 'verify') {
    const skill = rest[0];
    if (!skill || skill.startsWith('--')) {
      console.error('Usage: cobolt-self-critique verify <skill-name> [--stage <s>] [--milestone <M>] [--json]');
      process.exit(2);
    }
    const result = verifyCritique(skill, { stage: args.stage, milestone: args.milestone });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else
      console.log(
        `[self-critique:${args.stage}] ${result.skill}: ${result.reason}${result.contentDepthScore ? ` (score=${result.contentDepthScore})` : ''}`,
      );
    process.exit(result.code);
  }

  if (cmd === 'status' || !cmd) {
    const result = statusAll({ stage: args.stage, milestone: args.milestone });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`[self-critique:${args.stage}] ${result.results.length} critique file(s)`);
      for (const r of result.results) console.log(`  ${r.skill}: ${r.reason}`);
    }
    const worst = result.results.reduce((acc, r) => Math.max(acc, r.code), 0);
    process.exit(worst);
  }

  console.error('Usage: cobolt-self-critique verify <skill> | status [--stage <s>] [--milestone <M>] [--json]');
  // Tool-exit-contract: --help/-h or no-args -> 0; unknown subcommand -> 1
  const firstArg = process.argv[2];
  const isHelp = firstArg === '--help' || firstArg === '-h';
  process.exit(process.argv.length <= 2 || isHelp ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  verifyCritique,
  statusAll,
  scanForStubs,
  resolveCritiqueDir,
  VALID_STAGES,
  STUB_PATTERNS,
};
