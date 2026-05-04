#!/usr/bin/env node

// CoBolt Agent Team Validator (v0.25+)
//
// Validates structural integrity of the agent-team subsystem:
//
//   1. Every skill that invokes `team-active` has a matching team reference doc
//      under source/skills/<skill>/references/*-team.md.
//   2. Every team reference doc names a lead agent (TEAM_LEAD_AGENT) that
//      actually exists at source/agents/<lead>.md.
//   3. Every agent named in a team reference doc's composition tables exists
//      at source/agents/<agent>.md.
//   4. Every team reference doc references the canonical teardown protocol
//      (source/skills/_shared/team-teardown-protocol.{md,sh}).
//
// This is a structural gate — it does NOT parse dispatch logic (that's the
// orchestrator's job). It catches roster drift, missing leads, and ceremony
// skips that broke the prompt-only enforcement era (see MEMORY:
// feedback_prompt_enforcement_fails.md).
//
// Usage:
//   node tools/cobolt-team-validate.js                 # validate all teams
//   node tools/cobolt-team-validate.js --skill cobolt-build
//   node tools/cobolt-team-validate.js --json          # machine-readable output
//   node tools/cobolt-team-validate.js --strict        # treat warnings as failures
//
// Exit codes (per tools/CLAUDE.md exit-code contract):
//   0 = all teams valid
//   1 = usage error
//   3 = validation drift (missing leads, unknown agents, missing ceremony refs)

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_DRIFT = 3;

// ── Resolve source roots ────────────────────────────────────────

function resolveSourceDir() {
  const candidates = [path.join(process.cwd(), 'source'), path.join(__dirname, '..', 'source')];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'skills')) && fs.existsSync(path.join(c, 'agents'))) {
      return path.resolve(c);
    }
  }
  return null;
}

// ── Discovery ───────────────────────────────────────────────────

function listTeamRefDocs(sourceDir, skillFilter) {
  const skillsDir = path.join(sourceDir, 'skills');
  const out = [];
  if (!fs.existsSync(skillsDir)) return out;
  for (const entry of fs.readdirSync(skillsDir)) {
    if (!entry.startsWith('cobolt-')) continue;
    if (skillFilter && entry !== skillFilter) continue;
    const refDir = path.join(skillsDir, entry, 'references');
    if (!fs.existsSync(refDir)) continue;
    for (const f of fs.readdirSync(refDir)) {
      if (!f.endsWith('-team.md')) continue;
      out.push({
        skill: entry,
        teamFile: path.join(refDir, f),
        teamName: f.replace(/\.md$/, ''),
      });
    }
  }
  return out;
}

function listSkillsCallingTeamActive(sourceDir) {
  const skillsDir = path.join(sourceDir, 'skills');
  const hits = new Map();
  if (!fs.existsSync(skillsDir)) return hits;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && (p.endsWith('.md') || p.endsWith('.sh'))) {
        let text;
        try {
          text = fs.readFileSync(p, 'utf8');
        } catch {
          continue;
        }
        if (text.includes('team-active')) {
          const rel = path.relative(skillsDir, p);
          const skill = rel.split(path.sep)[0];
          if (!skill.startsWith('cobolt-')) continue;
          if (!hits.has(skill)) hits.set(skill, []);
          hits.get(skill).push(p);
        }
      }
    }
  };
  walk(skillsDir);
  return hits;
}

// Build the canonical agent-name set by reading frontmatter `name:` from every
// agent file. Agent filenames don't always match the frontmatter name
// (e.g. source/agents/cobolt-security-reviewer-agent.md declares
// name: cobolt-security-reviewer). The frontmatter name is the identifier
// used by skill dispatch — that's what team docs must match.
let _agentNamesCache = null;
function loadAgentNames(sourceDir) {
  if (_agentNamesCache) return _agentNamesCache;
  const names = new Set();
  const agentsDir = path.join(sourceDir, 'agents');
  if (!fs.existsSync(agentsDir)) {
    _agentNamesCache = names;
    return names;
  }
  for (const f of fs.readdirSync(agentsDir)) {
    if (!f.endsWith('.md')) continue;
    // fallback: filename without .md
    names.add(f.replace(/\.md$/, ''));
    // frontmatter name (canonical)
    try {
      const head = fs.readFileSync(path.join(agentsDir, f), 'utf8').slice(0, 2048);
      const m = head.match(/^---[\s\S]*?\bname:\s*([a-z][a-z0-9-]+)/m);
      if (m) names.add(m[1]);
    } catch {
      // ignore unreadable files — fallback to filename
    }
  }
  _agentNamesCache = names;
  return names;
}

function agentExists(sourceDir, name) {
  if (!name) return false;
  return loadAgentNames(sourceDir).has(name);
}

// ── Markdown extraction ─────────────────────────────────────────

// Dynamic-teammate opt-out: team docs can declare that teammates are shaped at
// dispatch time (e.g. planning-quality-team where teammate count == number of
// skills with corrections). Skips the "teammates-declared" rule but keeps all
// other structural checks. Marker: HTML comment OR phrase match in body.
function hasDynamicTeammatesMarker(text) {
  if (/<!--\s*team-validate:\s*dynamic\s*-->/i.test(text)) return true;
  if (/\bteammates?\b[^\n]{0,80}\b(?:dynamic|shaped at dispatch|one per (?:producing |active )?skill)\b/i.test(text))
    return true;
  return false;
}

// Narrative-lead opt-out: some dynamic teams name the lead prose-style (e.g.
// "Lead: main session (you).") without setting TEAM_LEAD_AGENT in a shell
// block because the lead is not a sub-agent. Skips the "lead-declared" rule
// only when the dynamic marker is present.
function hasNarrativeLead(text) {
  return /\*\*Lead:\*\*\s+main session/i.test(text) || /\bLead:\s+main session/i.test(text);
}

// Sub-agent roster marker: review-team dispatches 23 reviewers as READ-ONLY
// sub-agents (findings JSON only). It is not a file-writing team, so the
// canonical teardown protocol (census + inject + lead) does not apply.
// Marker skips all team-ceremony checks but STILL validates agent names.
function hasSubagentRosterMarker(text) {
  return /<!--\s*team-validate:\s*subagent-roster\s*-->/i.test(text);
}

// Agent name allowlist — canonical CoBolt convention is to wrap agent names
// in backticks inside table cells. This parser is deliberately strict:
// a cell only qualifies as an agent reference if it is backticked AND ends
// with one of the known agent-role suffixes. This rejects stage labels
// (`tdd-red-write`), round identifiers (`implement-r1-foundation`), and skill
// names (`cobolt-test-suite`) that previous versions of this parser mistook
// for agents.
const AGENT_SUFFIX_RE =
  /-(?:agent|reviewer|lead|analyst|writer|builder|architect|provisioner|orchestrator|advisor|validator|curator|resolver|verifier|detector|monitor|scanner|extractor|generator|cataloger|benchmarker|engineer|designer|specialist|dev|squad|fix|loop|manager|tracker|auditor|enforcer|proposer|recoverer|compactor|planner|renegotiator|strategist)$/;

// Header-cell values that appear in table HEADER rows — never agent names.
const HEADER_CELL_RE =
  /^(?:agent|role|model|tier|stage|purpose|focus|cardinality|prefix|lead|status|action|target|priority|wave|phase|verdict|signal|trigger|when|where|kind|mode|severity|producer|source|description|notes|output|input|gating|reason|writes|path|env|effect|type)$/i;

function extractTeammateAgents(text) {
  const found = new Set();
  const tableLineRe = /^\s*\|(.+)\|\s*$/gm;
  let m;
  while ((m = tableLineRe.exec(text)) !== null) {
    // `[skill]` annotation marks rows that dispatch a skill (not an agent).
    if (/\[skill\]/i.test(m[0])) continue;
    // Divider row (| --- | --- |)
    if (/^\s*\|[\s:-]+\|/.test(m[0])) continue;
    const cells = m[1].split('|').map((c) => c.trim());
    for (const cell of cells) {
      // Accept either backticked `agent-name` or bare kebab-case agent-name.
      // Both forms are used across existing team docs; suffix allowlist
      // provides the precision that rejects stage labels and skill names.
      const match = cell.match(/^`?([a-z][a-z0-9-]{2,40})`?$/);
      if (!match) continue;
      const name = match[1];
      if (HEADER_CELL_RE.test(name)) continue;
      if (!AGENT_SUFFIX_RE.test(name)) continue;
      found.add(name);
    }
  }
  return [...found];
}

// Extract TEAM_LEAD_AGENT= from the teardown-invocation block
function extractTeamLead(text) {
  const m = text.match(/export\s+TEAM_LEAD_AGENT\s*=\s*([a-z][a-z0-9-]+)/);
  return m ? m[1] : null;
}

// Extract escalation chain references — look for patterns like
// "L1 — `architect`" or "architect (L1)"
function extractEscalation(text) {
  const out = {};
  const l1 = text.match(/\bL1[^\n]*?`([a-z][a-z0-9-]+)`|`([a-z][a-z0-9-]+)`\s*\(\s*L1\s*\)/);
  const l2 = text.match(/\bL2[^\n]*?`([a-z][a-z0-9-]+)`|`([a-z][a-z0-9-]+)`\s*\(\s*L2\s*\)/);
  const l3 = text.match(/\bL3[^\n]*?`([a-z][a-z0-9-]+)`|`([a-z][a-z0-9-]+)`\s*\(\s*L3\s*\)/);
  if (l1) out.L1 = l1[1] || l1[2];
  if (l2) out.L2 = l2[1] || l2[2];
  if (l3) out.L3 = l3[1] || l3[2];
  return out;
}

function referencesCanonicalTeardown(text) {
  return (
    text.includes('team-teardown-protocol.md') ||
    text.includes('team-teardown-protocol.sh') ||
    text.includes('_shared/team-teardown-protocol')
  );
}

// ── Validators ──────────────────────────────────────────────────

function validateTeamDoc(sourceDir, { skill, teamFile, teamName }) {
  const findings = [];
  let text;
  try {
    text = fs.readFileSync(teamFile, 'utf8');
  } catch (err) {
    return {
      skill,
      teamName,
      teamFile,
      status: 'fail',
      findings: [{ rule: 'read', severity: 'high', message: `cannot read: ${err.message}` }],
    };
  }

  const lead = extractTeamLead(text);
  const escalation = extractEscalation(text);
  const teammates = extractTeammateAgents(text);
  const isDynamic = hasDynamicTeammatesMarker(text);
  const narrativeLead = hasNarrativeLead(text);
  const isSubagentRoster = hasSubagentRosterMarker(text);

  // Rule 1: canonical teardown referenced (skipped for sub-agent rosters)
  if (!isSubagentRoster && !referencesCanonicalTeardown(text)) {
    findings.push({
      rule: 'canonical-teardown-ref',
      severity: 'high',
      message: 'team doc does not reference source/skills/_shared/team-teardown-protocol.{md,sh}',
    });
  }

  // Rule 2: lead named AND exists on disk (skipped for sub-agent rosters)
  // Narrative-lead teams (Lead: main session) skip the sub-agent lead check.
  const leadName = lead || escalation.L1;
  if (!isSubagentRoster && !leadName && !(isDynamic && narrativeLead)) {
    findings.push({
      rule: 'lead-declared',
      severity: 'high',
      message: 'no TEAM_LEAD_AGENT or L1 lead declared',
    });
  } else if (leadName && !agentExists(sourceDir, leadName)) {
    findings.push({
      rule: 'lead-exists',
      severity: 'high',
      message: `lead agent '${leadName}' not found (checked source/agents/ by filename and frontmatter name)`,
    });
  }

  // Rule 3: L2/L3 escalation targets (if declared) must exist
  for (const [tier, name] of Object.entries(escalation)) {
    if (tier === 'L1') continue;
    if (name && !agentExists(sourceDir, name)) {
      findings.push({
        rule: 'escalation-exists',
        severity: 'medium',
        message: `${tier} escalation target '${name}' not found at source/agents/${name}.md`,
      });
    }
  }

  // Rule 4: at least one teammate (skipped when team is dynamic by design
  // or is a sub-agent roster — rosters may use Title Case table formatting
  // which we don't parse).
  if (teammates.length === 0 && !isDynamic && !isSubagentRoster) {
    findings.push({
      rule: 'teammates-declared',
      severity: 'high',
      message:
        'no teammate agents detected in composition tables — wrap agent names in backticks in table cells, or add `<!-- team-validate: dynamic -->` if the team is shaped at dispatch time',
    });
  }

  // Rule 5: every teammate exists on disk
  const missingTeammates = teammates.filter((t) => !agentExists(sourceDir, t));
  for (const name of missingTeammates) {
    findings.push({
      rule: 'teammate-exists',
      severity: 'high',
      message: `teammate agent '${name}' not found at source/agents/${name}.md`,
    });
  }

  const highCount = findings.filter((f) => f.severity === 'high').length;
  const status = highCount > 0 ? 'fail' : findings.length > 0 ? 'warn' : 'pass';

  return {
    skill,
    teamName,
    teamFile: path.relative(sourceDir, teamFile),
    status,
    lead: leadName || null,
    escalation,
    teammateCount: teammates.length,
    findings,
  };
}

// Some skills are inner workflows that delegate their team ceremony to a
// parent skill's team doc (e.g. cobolt-create-architecture-diagrams invokes
// team-active on behalf of cobolt-arch, whose arch-team.md is the canonical
// team source). A skill can opt into delegation by adding an HTML-comment
// marker: `<!-- team-validate: delegates-to cobolt-<parent> -->` anywhere in
// its SKILL.md.
function findDelegationTarget(sourceDir, skill) {
  const skillFile = path.join(sourceDir, 'skills', skill, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return null;
  const text = fs.readFileSync(skillFile, 'utf8');
  const m = text.match(/<!--\s*team-validate:\s*delegates-to\s+(cobolt-[a-z0-9-]+)\s*-->/i);
  return m ? m[1] : null;
}

function validateOrphanSkills(sourceDir, callingSkills, teamDocs) {
  const withTeam = new Set(teamDocs.map((t) => t.skill));
  const out = [];
  for (const skill of callingSkills.keys()) {
    if (withTeam.has(skill)) continue;
    const delegate = findDelegationTarget(sourceDir, skill);
    if (delegate && withTeam.has(delegate)) continue;
    out.push({
      skill,
      status: 'fail',
      findings: [
        {
          rule: 'team-doc-present',
          severity: 'high',
          message: delegate
            ? `skill invokes \`team-active\` and delegates to '${delegate}' but that skill has no team doc either`
            : `skill invokes \`team-active\` but has no *-team.md under source/skills/${skill}/references/ — add one, or annotate delegation via '<!-- team-validate: delegates-to cobolt-<parent> -->' in SKILL.md`,
          invocations: callingSkills.get(skill).map((p) => path.relative(sourceDir, p)),
        },
      ],
    });
  }
  return out;
}

// ── CLI ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { json: false, strict: false, skill: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--strict') args.strict = true;
    else if (a === '--skill') args.skill = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(
    `Usage: node tools/cobolt-team-validate.js [--skill cobolt-<name>] [--json] [--strict]

Validates the agent-team subsystem:
  - every skill calling team-active has a team reference doc
  - every team doc names a lead agent that exists on disk
  - every teammate agent in composition tables exists on disk
  - every team doc references the canonical teardown protocol

Exit codes:
  0 = all teams valid
  1 = usage error
  3 = validation drift`,
  );
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return EXIT_OK;
  }

  const sourceDir = resolveSourceDir();
  if (!sourceDir) {
    console.error('FATAL: cannot locate source/ directory (looked in cwd and tools/..)');
    return EXIT_USAGE;
  }

  const teamDocs = listTeamRefDocs(sourceDir, args.skill);
  const callingSkills = listSkillsCallingTeamActive(sourceDir);

  const perTeam = teamDocs.map((td) => validateTeamDoc(sourceDir, td));
  const orphans = args.skill ? [] : validateOrphanSkills(sourceDir, callingSkills, teamDocs);

  const allResults = [...perTeam, ...orphans];
  const failCount = allResults.filter((r) => r.status === 'fail').length;
  const warnCount = allResults.filter((r) => r.status === 'warn').length;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          sourceDir: path.relative(process.cwd(), sourceDir) || '.',
          teamsChecked: perTeam.length,
          orphanSkills: orphans.length,
          fail: failCount,
          warn: warnCount,
          results: allResults,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`\nCoBolt Agent Team Validator — ${perTeam.length} team doc(s), ${orphans.length} orphan skill(s)\n`);
    for (const r of allResults) {
      const icon = r.status === 'pass' ? '[OK]' : r.status === 'warn' ? '[WARN]' : '[FAIL]';
      const label = r.teamName ? `${r.skill}/${r.teamName}` : r.skill;
      console.log(`${icon} ${label}`);
      if (r.lead) console.log(`       lead=${r.lead} teammates=${r.teammateCount}`);
      for (const f of r.findings || []) {
        console.log(`       - [${f.severity}] ${f.rule}: ${f.message}`);
      }
    }
    console.log(`\nSummary: ${failCount} fail, ${warnCount} warn, ${perTeam.length - failCount - warnCount} pass`);
  }

  const hasDrift = failCount > 0 || (args.strict && warnCount > 0);
  return hasDrift ? EXIT_DRIFT : EXIT_OK;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  resolveSourceDir,
  listTeamRefDocs,
  listSkillsCallingTeamActive,
  validateTeamDoc,
  validateOrphanSkills,
  extractTeamLead,
  extractTeammateAgents,
  extractEscalation,
};
