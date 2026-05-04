#!/usr/bin/env node

// CoBolt Skill Tracker — Agent/skill effectiveness tracking across runs
//
// Records which skills and agents were active when pipeline stages succeed
// or fail. Computes per-skill and per-agent success rates over time.
// Enables data-driven agent selection and skill pruning.
//
// Usage:
//   node tools/cobolt-skill-tracker.js record <stage> <status> [--agents a,b] [--skills x,y] [--milestone M1]
//   node tools/cobolt-skill-tracker.js stats [--sort success-rate|count] [--min-runs 3]
//   node tools/cobolt-skill-tracker.js agents [--sort success-rate]         # Agent effectiveness
//   node tools/cobolt-skill-tracker.js recommend <stage>                    # Best agents for stage
//   node tools/cobolt-skill-tracker.js prune [--threshold 0.3] [--min-runs 5]  # Identify low performers
//   node tools/cobolt-skill-tracker.js report [--json]                      # Full effectiveness report
//   node tools/cobolt-skill-tracker.js reset                                # Reset tracking data
//
// Exit codes: 0 = success, 1 = no data, 2 = usage error

const fs = require('node:fs');
const path = require('node:path');

const { atomicWrite: sharedAtomicWrite } = require('../lib/cobolt-atomic-write');

// ── Path Resolution ────────────────────────────────────────

function trackerDir() {
  return path.join(process.cwd(), '_cobolt-output/evolution');
}

function trackerFile() {
  return path.join(trackerDir(), 'skill-tracker.jsonl');
}

function statsFile() {
  return path.join(trackerDir(), 'skill-stats.json');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readJsonl(fp) {
  if (!fs.existsSync(fp)) return [];
  return fs
    .readFileSync(fp, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function atomicWrite(fp, data) {
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  sharedAtomicWrite(fp, content, { mode: 0o600 });
}

// ── Time Decay ─────────────────────────────────────────────

const HALF_LIFE_DAYS = 60; // Effectiveness data decays slower than lessons

function timeWeight(timestamp) {
  const ageDays = (Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays < 0) return 1.0;
  if (ageDays > 180) return 0.0;
  return Math.exp((-ageDays * Math.LN2) / HALF_LIFE_DAYS);
}

// ── Record ─────────────────────────────────────────────────

function record(stage, success, agents, skills, milestone, runId) {
  const entry = {
    timestamp: new Date().toISOString(),
    stage,
    success: !!success,
    agents: agents || [],
    skills: skills || [],
    milestone: milestone || 'unknown',
    runId: runId || `run-${Date.now()}`,
  };

  ensureDir(trackerDir());
  fs.appendFileSync(trackerFile(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return entry;
}

// ── Stats Computation ──────────────────────────────────────

function computeStats(entries, minRuns) {
  const min = minRuns || 1;
  const agentStats = {};
  const skillStats = {};
  const stageStats = {};

  for (const entry of entries) {
    const weight = timeWeight(entry.timestamp);
    if (weight < 0.05) continue;

    // Agent stats
    for (const agent of entry.agents || []) {
      if (!agentStats[agent])
        agentStats[agent] = { total: 0, successes: 0, weightedTotal: 0, weightedSuccesses: 0, stages: {} };
      const a = agentStats[agent];
      a.total++;
      a.weightedTotal += weight;
      if (entry.success) {
        a.successes++;
        a.weightedSuccesses += weight;
      }
      if (!a.stages[entry.stage]) a.stages[entry.stage] = { total: 0, successes: 0 };
      a.stages[entry.stage].total++;
      if (entry.success) a.stages[entry.stage].successes++;
    }

    // Skill stats
    for (const skill of entry.skills || []) {
      if (!skillStats[skill]) skillStats[skill] = { total: 0, successes: 0, weightedTotal: 0, weightedSuccesses: 0 };
      const s = skillStats[skill];
      s.total++;
      s.weightedTotal += weight;
      if (entry.success) {
        s.successes++;
        s.weightedSuccesses += weight;
      }
    }

    // Stage stats
    if (!stageStats[entry.stage]) stageStats[entry.stage] = { total: 0, successes: 0, agents: new Set() };
    const st = stageStats[entry.stage];
    st.total++;
    if (entry.success) st.successes++;
    for (const agent of entry.agents || []) st.agents.add(agent);
  }

  // Compute rates and filter by minRuns
  const formatStats = (stats) => {
    const result = {};
    for (const [name, s] of Object.entries(stats)) {
      if (s.total < min) continue;
      result[name] = {
        total: s.total,
        successes: s.successes,
        successRate: s.total > 0 ? Math.round((s.successes / s.total) * 100) / 100 : 0,
        weightedRate: s.weightedTotal > 0 ? Math.round((s.weightedSuccesses / s.weightedTotal) * 100) / 100 : 0,
        ...(s.stages ? { stages: s.stages } : {}),
      };
    }
    return result;
  };

  const stageResult = {};
  for (const [name, s] of Object.entries(stageStats)) {
    stageResult[name] = {
      total: s.total,
      successes: s.successes,
      successRate: s.total > 0 ? Math.round((s.successes / s.total) * 100) / 100 : 0,
      uniqueAgents: s.agents.size,
    };
  }

  return {
    agents: formatStats(agentStats),
    skills: formatStats(skillStats),
    stages: stageResult,
    totalEntries: entries.length,
    activeEntries: entries.filter((e) => timeWeight(e.timestamp) >= 0.05).length,
  };
}

// ── Recommend ──────────────────────────────────────────────

function recommendForStage(stage, entries) {
  const stats = computeStats(entries, 2);
  const candidates = [];

  for (const [agent, s] of Object.entries(stats.agents)) {
    const stageData = s.stages?.[stage];
    if (!stageData || stageData.total < 1) continue;

    const stageRate = stageData.total > 0 ? stageData.successes / stageData.total : 0;
    const overallRate = s.successRate;
    // Weighted blend: 70% stage-specific, 30% overall
    const score = 0.7 * stageRate + 0.3 * overallRate;

    candidates.push({
      agent,
      score: Math.round(score * 100) / 100,
      stageRate: Math.round(stageRate * 100) / 100,
      overallRate: Math.round(overallRate * 100) / 100,
      stageRuns: stageData.total,
      totalRuns: s.total,
    });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

// ── Prune Identification ───────────────────────────────────

function identifyLowPerformers(entries, threshold, minRuns) {
  const stats = computeStats(entries, minRuns || 5);
  const lowPerformers = [];

  for (const [name, s] of Object.entries(stats.agents)) {
    if (s.weightedRate < (threshold || 0.3)) {
      lowPerformers.push({
        type: 'agent',
        name,
        successRate: s.successRate,
        weightedRate: s.weightedRate,
        totalRuns: s.total,
        recommendation: s.weightedRate < 0.15 ? 'replace' : 'review',
      });
    }
  }

  for (const [name, s] of Object.entries(stats.skills)) {
    if (s.weightedRate < (threshold || 0.3)) {
      lowPerformers.push({
        type: 'skill',
        name,
        successRate: s.successRate,
        weightedRate: s.weightedRate,
        totalRuns: s.total,
        recommendation: s.weightedRate < 0.15 ? 'remove' : 'review',
      });
    }
  }

  return lowPerformers.sort((a, b) => a.weightedRate - b.weightedRate);
}

// ── CLI Commands ───────────────────────────────────────────

function cmdRecord(args) {
  const stage = args[0];
  const status = args[1];
  if (!stage || !status) {
    console.error(
      'Usage: node tools/cobolt-skill-tracker.js record <stage> <success|failure> [--agents a,b] [--skills x,y]',
    );
    process.exit(2);
  }

  const agentIdx = args.indexOf('--agents');
  const agents = agentIdx !== -1 && args[agentIdx + 1] ? args[agentIdx + 1].split(',') : [];
  const skillIdx = args.indexOf('--skills');
  const skills = skillIdx !== -1 && args[skillIdx + 1] ? args[skillIdx + 1].split(',') : [];
  const msIdx = args.indexOf('--milestone');
  const milestone = msIdx !== -1 && args[msIdx + 1] ? args[msIdx + 1] : 'unknown';
  const runIdx = args.indexOf('--run-id');
  const runId = runIdx !== -1 && args[runIdx + 1] ? args[runIdx + 1] : undefined;

  const success = status === 'success' || status === 'true' || status === '1';
  const _entry = record(stage, success, agents, skills, milestone, runId);

  console.log(
    `[cobolt-skill-tracker] Recorded: ${stage} ${success ? 'SUCCESS' : 'FAILURE'} (${agents.length} agents, ${skills.length} skills)`,
  );
  process.exit(0);
}

function cmdStats(args) {
  const entries = readJsonl(trackerFile());
  if (entries.length === 0) {
    console.log('[cobolt-skill-tracker] No tracking data yet.');
    process.exit(1);
  }

  const minIdx = args.indexOf('--min-runs');
  const minRuns = minIdx !== -1 ? parseInt(args[minIdx + 1], 10) || 3 : 1;
  const stats = computeStats(entries, minRuns);

  // Cache stats
  atomicWrite(statsFile(), { ...stats, lastComputed: new Date().toISOString() });

  if (args.includes('--json')) {
    console.log(JSON.stringify(stats, null, 2));
  } else {
    console.log(`[cobolt-skill-tracker] ${stats.totalEntries} records (${stats.activeEntries} active)`);
    console.log('');

    // Sort by success rate
    const sortKey = args.includes('--sort') ? args[args.indexOf('--sort') + 1] : 'success-rate';
    const sortedSkills = Object.entries(stats.skills).sort((a, b) =>
      sortKey === 'count' ? b[1].total - a[1].total : b[1].weightedRate - a[1].weightedRate,
    );

    if (sortedSkills.length > 0) {
      console.log('  Skills:');
      for (const [name, s] of sortedSkills) {
        console.log(`    ${name}: ${(s.weightedRate * 100).toFixed(0)}% (${s.successes}/${s.total} runs)`);
      }
    }

    const sortedAgents = Object.entries(stats.agents).sort((a, b) => b[1].weightedRate - a[1].weightedRate);

    if (sortedAgents.length > 0) {
      console.log('');
      console.log('  Agents:');
      for (const [name, s] of sortedAgents.slice(0, 15)) {
        console.log(`    ${name}: ${(s.weightedRate * 100).toFixed(0)}% (${s.successes}/${s.total} runs)`);
      }
      if (sortedAgents.length > 15) console.log(`    ... and ${sortedAgents.length - 15} more`);
    }
  }
  process.exit(0);
}

function cmdAgents(args) {
  const entries = readJsonl(trackerFile());
  if (entries.length === 0) {
    console.log('[cobolt-skill-tracker] No data.');
    process.exit(1);
  }

  const stats = computeStats(entries, 1);
  const sorted = Object.entries(stats.agents).sort((a, b) => b[1].weightedRate - a[1].weightedRate);

  if (args.includes('--json')) {
    console.log(JSON.stringify(stats.agents, null, 2));
  } else {
    console.log('[cobolt-skill-tracker] Agent Effectiveness');
    console.log('');
    for (const [name, s] of sorted) {
      const bar = '█'.repeat(Math.round(s.weightedRate * 20)) + '░'.repeat(20 - Math.round(s.weightedRate * 20));
      console.log(`  ${name.padEnd(30)} ${bar} ${(s.weightedRate * 100).toFixed(0)}% (${s.successes}/${s.total})`);
    }
  }
  process.exit(0);
}

function cmdRecommend(args) {
  const stage = args[0];
  if (!stage) {
    console.error('Usage: node tools/cobolt-skill-tracker.js recommend <stage>');
    process.exit(2);
  }

  const entries = readJsonl(trackerFile());
  const recommendations = recommendForStage(stage, entries);

  if (args.includes('--json')) {
    console.log(JSON.stringify({ stage, recommendations }, null, 2));
  } else {
    console.log(`[cobolt-skill-tracker] Best agents for "${stage}":`);
    if (recommendations.length === 0) {
      console.log('  No data for this stage yet.');
    } else {
      for (const r of recommendations.slice(0, 10)) {
        console.log(
          `  ${r.agent}: score=${r.score} (stage=${(r.stageRate * 100).toFixed(0)}%, overall=${(r.overallRate * 100).toFixed(0)}%, ${r.stageRuns} stage runs)`,
        );
      }
    }
  }
  process.exit(recommendations.length > 0 ? 0 : 1);
}

function cmdPrune(args) {
  const threshIdx = args.indexOf('--threshold');
  const threshold = threshIdx !== -1 ? parseFloat(args[threshIdx + 1]) : 0.3;
  const minIdx = args.indexOf('--min-runs');
  const minRuns = minIdx !== -1 ? parseInt(args[minIdx + 1], 10) : 5;

  const entries = readJsonl(trackerFile());
  const lowPerformers = identifyLowPerformers(entries, threshold, minRuns);

  if (args.includes('--json')) {
    console.log(JSON.stringify({ lowPerformers, threshold, minRuns }, null, 2));
  } else {
    console.log(
      `[cobolt-skill-tracker] Low performers (< ${(threshold * 100).toFixed(0)}% success, >= ${minRuns} runs):`,
    );
    if (lowPerformers.length === 0) {
      console.log('  None found — all performers above threshold.');
    } else {
      for (const lp of lowPerformers) {
        console.log(
          `  [${lp.recommendation.toUpperCase()}] ${lp.type}: ${lp.name} — ${(lp.weightedRate * 100).toFixed(0)}% weighted (${lp.totalRuns} runs)`,
        );
      }
    }
  }
  process.exit(lowPerformers.length > 0 ? 0 : 1);
}

function cmdReport(args) {
  const entries = readJsonl(trackerFile());
  const stats = computeStats(entries, 1);
  const lowPerformers = identifyLowPerformers(entries, 0.3, 5);

  const report = {
    ...stats,
    lowPerformers,
    generatedAt: new Date().toISOString(),
    generatedBy: 'cobolt-skill-tracker',
  };

  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('[cobolt-skill-tracker] Effectiveness Report');
    console.log(`  Total records: ${stats.totalEntries} (${stats.activeEntries} active)`);
    console.log(`  Tracked agents: ${Object.keys(stats.agents).length}`);
    console.log(`  Tracked skills: ${Object.keys(stats.skills).length}`);
    console.log(`  Tracked stages: ${Object.keys(stats.stages).length}`);
    console.log(`  Low performers: ${lowPerformers.length}`);
  }

  atomicWrite(statsFile(), report);
  process.exit(0);
}

function cmdReset() {
  const fp = trackerFile();
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  const sp = statsFile();
  if (fs.existsSync(sp)) fs.unlinkSync(sp);
  console.log('[cobolt-skill-tracker] Reset complete.');
  process.exit(0);
}

// ── Main ──────────────���────────────────────────────────��───

if (require.main === module) {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case 'record':
      cmdRecord(args);
      break;
    case 'stats':
      cmdStats(args);
      break;
    case 'agents':
      cmdAgents(args);
      break;
    case 'recommend':
      cmdRecommend(args);
      break;
    case 'prune':
      cmdPrune(args);
      break;
    case 'report':
      cmdReport(args);
      break;
    case 'reset':
      cmdReset();
      break;
    default:
      console.log('CoBolt Skill Tracker — Agent/skill effectiveness across runs');
      console.log('');
      console.log('Usage:');
      console.log(
        '  node tools/cobolt-skill-tracker.js record <stage> <success|failure> [--agents a,b] [--skills x,y] [--milestone M1]',
      );
      console.log('  node tools/cobolt-skill-tracker.js stats [--sort success-rate|count] [--min-runs 3] [--json]');
      console.log('  node tools/cobolt-skill-tracker.js agents [--sort success-rate] [--json]');
      console.log('  node tools/cobolt-skill-tracker.js recommend <stage> [--json]');
      console.log('  node tools/cobolt-skill-tracker.js prune [--threshold 0.3] [--min-runs 5] [--json]');
      console.log('  node tools/cobolt-skill-tracker.js report [--json]');
      console.log('  node tools/cobolt-skill-tracker.js reset');
      process.exit(command ? 2 : 0);
  }
}

module.exports = {
  record,
  computeStats,
  recommendForStage,
  identifyLowPerformers,
  timeWeight,
};
