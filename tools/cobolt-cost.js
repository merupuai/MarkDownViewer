#!/usr/bin/env node

// CoBolt Cost CLI — multi-agent cost tracking, token counting, and cache analysis
//
// Tracks token usage per agent invocation, aggregates costs by stage/milestone/model,
// and monitors prompt cache hit rates for optimization.
//
// Usage:
//   node tools/cobolt-cost.js record <agent> <model> <input> <output> [--cache-read N] [--cache-write N]
//   node tools/cobolt-cost.js record <agent> <model> --usage-file usage.json --provider openai|anthropic
//   node tools/cobolt-cost.js show                           # Show current milestone costs
//   node tools/cobolt-cost.js report [--milestone M1]        # Generate cost report
//   node tools/cobolt-cost.js budget [--set USD] [--tokens N] # Show/set milestone budget
//   node tools/cobolt-cost.js check [--auto]                 # Evaluate GT-02 cost budget gate
//   node tools/cobolt-cost.js extend --reason R --approver E # Signed over-budget extension
//   node tools/cobolt-cost.js cache-analysis                 # Analyze cache hit rates
//   node tools/cobolt-cost.js export                         # Export as JSON
//   node tools/cobolt-cost.js reset                          # Reset current milestone costs

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const costBudget = require('../lib/cobolt-cost-budget');
const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

// Pricing per million tokens (USD) from the public model pages.
const PRICING = {
  opus: { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 },
  sonnet: { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
  haiku: { input: 0.25, output: 1.25, cache_read: 0.03, cache_write: 0.3 },
  'gpt-5.5-pro': { input: 30.0, output: 180.0, cache_read: 0, cache_write: 0 },
  'gpt-5.5': { input: 5.0, output: 30.0, cache_read: 0.5, cache_write: 0 },
  'gpt-5.4': { input: 2.5, output: 15.0, cache_read: 0.25, cache_write: 0 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cache_read: 0.075, cache_write: 0 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25, cache_read: 0.02, cache_write: 0 },
  'gpt-5.3-codex': { input: 1.75, output: 14.0, cache_read: 0.175, cache_write: 0 },
  'gpt-5.2-codex': { input: 1.75, output: 14.0, cache_read: 0.175, cache_write: 0 },
  'gpt-5-codex': { input: 1.25, output: 10.0, cache_read: 0.125, cache_write: 0 },
};

function costDir() {
  const _p = typeof _paths === 'function' ? _paths() : null;
  const base = _p ? _p.latest() : path.join(process.cwd(), '_cobolt-output/latest');
  return path.join(base, 'costs');
}

function ledgerFile() {
  return path.join(costDir(), 'cost-ledger.jsonl');
}
function _budgetFile() {
  return path.join(costDir(), 'budget.json');
}
function reportFile() {
  return path.join(costDir(), 'cost-report.md');
}

function ensureDir() {
  const dir = costDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readLedger() {
  const fp = ledgerFile();
  if (!fs.existsSync(fp)) return [];
  return fs
    .readFileSync(fp, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function appendLedger(entry) {
  ensureDir();
  fs.appendFileSync(ledgerFile(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function calculateCost(model, inputTokens, outputTokens, cacheRead = 0, cacheWrite = 0) {
  const tier = PRICING[model] || PRICING.sonnet;
  return (
    (inputTokens / 1_000_000) * tier.input +
    (outputTokens / 1_000_000) * tier.output +
    (cacheRead / 1_000_000) * tier.cache_read +
    (cacheWrite / 1_000_000) * tier.cache_write
  );
}

function parseFlag(args, flag, fallback = null) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

function parseFlagAll(args, flag) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && args[i + 1] && !String(args[i + 1]).startsWith('--')) values.push(args[i + 1]);
  }
  return values;
}

function parseInteger(value, fallback = 0) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function totalLedgerTokens(entry) {
  return (
    (entry.input_tokens || 0) +
    (entry.output_tokens || 0) +
    (entry.cache_read_tokens || 0) +
    (entry.cache_write_tokens || 0)
  );
}

function extractOpenAiUsage(raw) {
  const usage = raw?.usage || raw || {};
  const inputTotal = parseInteger(usage.input_tokens ?? usage.prompt_tokens, 0);
  const output = parseInteger(usage.output_tokens ?? usage.completion_tokens, 0);
  const cached = parseInteger(
    usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens,
    0,
  );
  const inputUncached = Math.max(0, inputTotal - cached);

  return {
    provider: 'openai',
    inputTokens: inputUncached,
    totalInputTokens: inputTotal,
    outputTokens: output,
    cachedTokens: cached,
    reasoningTokens: parseInteger(
      usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens,
      0,
    ),
    totalTokens: parseInteger(usage.total_tokens, inputTotal + output),
  };
}

function extractAnthropicUsage(raw) {
  const usage = raw?.usage || raw || {};
  const input = parseInteger(usage.input_tokens, 0);
  const output = parseInteger(usage.output_tokens, 0);
  const cacheRead = parseInteger(usage.cache_read_input_tokens ?? usage.cache_read_tokens, 0);
  const cacheWrite = parseInteger(usage.cache_creation_input_tokens ?? usage.cache_write_tokens, 0);

  return {
    provider: 'anthropic',
    inputTokens: input,
    totalInputTokens: input + cacheRead + cacheWrite,
    outputTokens: output,
    cachedTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: 0,
    totalTokens: input + output + cacheRead + cacheWrite,
  };
}

function readUsageFile(filePath, provider) {
  if (!filePath) return null;
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (provider === 'openai' || raw?.object?.startsWith?.('response') || raw?.usage?.prompt_tokens_details) {
    return extractOpenAiUsage(raw);
  }
  if (
    provider === 'anthropic' ||
    raw?.type === 'message' ||
    raw?.usage?.cache_creation_input_tokens !== undefined ||
    raw?.usage?.cache_read_input_tokens !== undefined
  ) {
    return extractAnthropicUsage(raw);
  }
  return null;
}

function formatUSD(n) {
  return `$${n.toFixed(2)}`;
}
function formatTokens(n) {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n);
}

// --- Commands ---

function record(args) {
  const agent = args[0];
  const model = args[1] || 'sonnet';
  const provider = parseFlag(
    args,
    '--provider',
    model.startsWith('gpt-') ? 'openai' : /(claude|opus|sonnet|haiku)/i.test(model) ? 'anthropic' : 'unknown',
  );
  const usageFile = parseFlag(args, '--usage-file') || parseFlag(args, '--openai-usage-file');
  const usage = readUsageFile(usageFile, provider);
  const input = usage ? usage.inputTokens : parseInteger(args[2], 0);
  const output = usage ? usage.outputTokens : parseInteger(args[3], 0);
  const cacheRead =
    usage?.cachedTokens ?? parseInteger(parseFlag(args, '--cached-tokens') ?? parseFlag(args, '--cache-read'), 0);
  const cacheWrite = usage?.cacheWriteTokens ?? parseInteger(parseFlag(args, '--cache-write'), 0);
  const stage = parseFlag(args, '--stage', 'unknown');
  const milestone = parseFlag(args, '--milestone', 'M1');

  const cost = calculateCost(model, input, output, cacheRead, cacheWrite);

  const entry = {
    timestamp: new Date().toISOString(),
    agent,
    model,
    provider,
    stage,
    milestone,
    input_tokens: input,
    total_input_tokens: usage?.totalInputTokens ?? input + cacheRead + cacheWrite,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    cached_tokens: cacheRead,
    reasoning_tokens: usage?.reasoningTokens ?? 0,
    provider_total_tokens: usage?.totalTokens ?? input + output + cacheRead + cacheWrite,
    cost_usd: Math.round(cost * 100) / 100,
  };

  appendLedger(entry);
  console.log(`Recorded: ${agent} (${model}) — ${formatTokens(totalLedgerTokens(entry))} tokens, ${formatUSD(cost)}`);
}

function show() {
  const entries = readLedger();
  if (entries.length === 0) {
    console.log('No cost data recorded yet.');
    return;
  }

  let totalInput = 0,
    totalOutput = 0,
    totalCacheRead = 0,
    totalCacheWrite = 0,
    totalCost = 0;
  const byModel = {};

  for (const e of entries) {
    totalInput += e.input_tokens || 0;
    totalOutput += e.output_tokens || 0;
    totalCacheRead += e.cache_read_tokens || 0;
    totalCacheWrite += e.cache_write_tokens || 0;
    totalCost += e.cost_usd || 0;
    const m = e.model || 'unknown';
    byModel[m] = byModel[m] || { agents: 0, tokens: 0, cost: 0, cacheRead: 0, cacheWrite: 0, input: 0 };
    byModel[m].agents++;
    byModel[m].tokens += totalLedgerTokens(e);
    byModel[m].cost += e.cost_usd || 0;
    byModel[m].cacheRead += e.cache_read_tokens || 0;
    byModel[m].cacheWrite += e.cache_write_tokens || 0;
    byModel[m].input += e.input_tokens || 0;
  }

  const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheWrite;
  const cacheRate =
    totalInput + totalCacheRead + totalCacheWrite > 0
      ? Math.round((totalCacheRead / (totalCacheRead + totalCacheWrite + totalInput)) * 100)
      : 0;

  console.log(`\n  Cost Summary (${entries.length} invocations)`);
  console.log(`  ${'─'.repeat(45)}`);
  console.log(`  Total tokens:     ${formatTokens(totalTokens)}`);
  console.log(`  Cache hit rate:   ${cacheRate}%`);
  console.log(`  Total cost:       ${formatUSD(totalCost)}`);
  console.log();
  console.log(`  By Model:`);
  for (const [model, data] of Object.entries(byModel)) {
    const rate =
      data.input + data.cacheRead + data.cacheWrite > 0
        ? Math.round((data.cacheRead / (data.cacheRead + data.cacheWrite + data.input)) * 100)
        : 0;
    console.log(
      `    ${model.padEnd(8)} ${String(data.agents).padStart(4)} agents  ${formatTokens(data.tokens).padStart(8)} tokens  ${String(rate).padStart(3)}% cache  ${formatUSD(data.cost).padStart(10)}`,
    );
  }
  console.log();
}

function generateReport(args) {
  const entries = readLedger();
  if (entries.length === 0) {
    console.log('No cost data to report.');
    return;
  }

  const msIdx = args.indexOf('--milestone');
  const milestone = msIdx >= 0 ? args[msIdx + 1] : null;
  const filtered = milestone ? entries.filter((e) => e.milestone === milestone) : entries;

  let totalInput = 0,
    totalOutput = 0,
    totalCacheRead = 0,
    totalCacheWrite = 0,
    totalCost = 0;
  const byModel = {};
  const byStage = {};

  for (const e of filtered) {
    totalInput += e.input_tokens || 0;
    totalOutput += e.output_tokens || 0;
    totalCacheRead += e.cache_read_tokens || 0;
    totalCacheWrite += e.cache_write_tokens || 0;
    totalCost += e.cost_usd || 0;

    const m = e.model || 'unknown';
    byModel[m] = byModel[m] || { agents: 0, tokens: 0, cost: 0, cacheRead: 0, cacheWrite: 0, input: 0 };
    byModel[m].agents++;
    byModel[m].tokens += totalLedgerTokens(e);
    byModel[m].cost += e.cost_usd || 0;
    byModel[m].cacheRead += e.cache_read_tokens || 0;
    byModel[m].cacheWrite += e.cache_write_tokens || 0;
    byModel[m].input += e.input_tokens || 0;

    const s = e.stage || 'unknown';
    byStage[s] = byStage[s] || { agents: 0, cost: 0 };
    byStage[s].agents++;
    byStage[s].cost += e.cost_usd || 0;
  }

  const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheWrite;
  const cacheRate =
    totalInput + totalCacheRead + totalCacheWrite > 0
      ? Math.round((totalCacheRead / (totalCacheRead + totalCacheWrite + totalInput)) * 100)
      : 0;

  let md = `# Pipeline Cost Report${milestone ? ` — ${milestone}` : ''}\n\n`;
  md += `## Summary\n`;
  md += `- **Invocations**: ${filtered.length}\n`;
  md += `- **Total tokens**: ${formatTokens(totalTokens)}\n`;
  md += `- **Cache hit rate**: ${cacheRate}%\n`;
  md += `- **Estimated cost**: ${formatUSD(totalCost)}\n\n`;

  md += `## By Model Tier\n\n`;
  md += `| Tier | Agents | Tokens | Cache Hit% | Cost |\n`;
  md += `|------|--------|--------|------------|------|\n`;
  for (const [model, data] of Object.entries(byModel)) {
    const rate =
      data.input + data.cacheRead + data.cacheWrite > 0
        ? Math.round((data.cacheRead / (data.cacheRead + data.cacheWrite + data.input)) * 100)
        : 0;
    md += `| ${model} | ${data.agents} | ${formatTokens(data.tokens)} | ${rate}% | ${formatUSD(data.cost)} |\n`;
  }

  md += `\n## By Pipeline Stage\n\n`;
  md += `| Stage | Agents | Cost |\n`;
  md += `|-------|--------|------|\n`;
  for (const [stage, data] of Object.entries(byStage)) {
    md += `| ${stage} | ${data.agents} | ${formatUSD(data.cost)} |\n`;
  }

  // Optimization recommendations
  md += `\n## Optimization Recommendations\n\n`;
  for (const [model, data] of Object.entries(byModel)) {
    const rate =
      data.input + data.cacheRead + data.cacheWrite > 0
        ? Math.round((data.cacheRead / (data.cacheRead + data.cacheWrite + data.input)) * 100)
        : 0;
    if (rate < 40) {
      md += `- **${model}** cache hit rate is ${rate}% (below 40% threshold) — consider restructuring prompts for better cache reuse\n`;
    }
  }

  atomicWrite(reportFile(), md, { mode: 0o600 });
  console.log(`Report written to ${reportFile()}`);
}

function budgetCmd(args) {
  ensureDir();
  const setIdx = args.indexOf('--set');
  const tokensValue = parseFlag(args, '--tokens');
  const hasBudgetInput = setIdx >= 0 || tokensValue != null;
  if (setIdx >= 0) {
    const budgetUsd = parseFloat(args[setIdx + 1]);
    if (Number.isNaN(budgetUsd)) {
      console.error('Invalid budget value');
      process.exit(1);
    }
  }
  if (hasBudgetInput) {
    const budgetUsd = setIdx >= 0 ? parseFloat(args[setIdx + 1]) : null;
    const maxTokens = tokensValue != null ? parseInteger(tokensValue, 0) : null;
    if (setIdx >= 0 && Number.isNaN(budgetUsd)) {
      console.error('Invalid budget value');
      process.exit(1);
    }
    if (tokensValue != null && (!Number.isFinite(maxTokens) || maxTokens <= 0)) {
      console.error('Invalid token budget value');
      process.exit(1);
    }
    const written = costBudget.writeBudgetConfig({
      projectRoot: process.cwd(),
      maxBudgetUsd: budgetUsd,
      maxTokens,
      milestone: parseFlag(args, '--milestone'),
      softLimitPct: parseFlag(args, '--soft') || parseFlag(args, '--soft-limit'),
      hardLimitPct: parseFlag(args, '--hard') || parseFlag(args, '--hard-limit'),
      reason: parseFlag(args, '--reason'),
      approver: parseFlag(args, '--approver'),
    });
    console.log(
      `Budget set to ${written.maxBudgetUsd ? formatUSD(written.maxBudgetUsd) : 'n/a'} / ${
        written.maxTokens ? formatTokens(written.maxTokens) : 'n/a'
      } tokens per ${written.scope}.`,
    );
    return;
  }

  const decision = costBudget.evaluateBudget({ projectRoot: process.cwd(), enforceSoftPause: false });
  if (decision.budget) {
    console.log(costBudget.formatDecision(decision));
    if (decision.action === 'soft-pause') console.log('  WARNING: Cost budget is above soft limit.');
    if (decision.action === 'hard-stop') console.log('  BLOCK: Cost budget is above hard limit.');
  } else {
    console.log('No budget set. Use --set <amount> and/or --tokens <n> to set one.');
  }
}

function checkBudgetCmd(args) {
  const json = args.includes('--json');
  const autoMode =
    args.includes('--auto') || args.includes('--autonomous') || costBudget.isAutonomousState(process.cwd());
  const decision = costBudget.evaluateBudget({
    projectRoot: process.cwd(),
    milestone: parseFlag(args, '--milestone'),
    autoMode,
    enforceSoftPause: autoMode,
  });
  if (json) {
    console.log(JSON.stringify(decision, null, 2));
  } else {
    console.log(costBudget.formatDecision(decision));
  }
  if (!decision.ok) process.exit(1);
}

function extendBudgetCmd(args) {
  const reason = parseFlag(args, '--reason');
  const approvers = parseFlagAll(args, '--approver');
  const hoursRaw = parseFlag(args, '--hours');
  const hours = hoursRaw == null ? null : parseInteger(hoursRaw, costBudget.DEFAULT_EXTENSION_HOURS);
  const until = parseFlag(args, '--until');
  const json = args.includes('--json');
  try {
    const grant = costBudget.extendBudget({
      projectRoot: process.cwd(),
      reason,
      approvers,
      hours,
      until,
    });
    if (json) {
      console.log(JSON.stringify(grant, null, 2));
    } else {
      console.log(`Cost budget extension granted: ${grant.id} (expires ${grant.expiresAt})`);
    }
  } catch (err) {
    console.error(`Cost budget extension failed: ${err.message}`);
    process.exit(1);
  }
}

function cacheAnalysis() {
  const entries = readLedger();
  if (entries.length === 0) {
    console.log('No data for cache analysis.');
    return;
  }

  const byAgent = {};
  for (const e of entries) {
    const key = `${e.agent} (${e.model})`;
    byAgent[key] = byAgent[key] || { input: 0, cacheRead: 0, count: 0 };
    byAgent[key].input += e.input_tokens || 0;
    byAgent[key].cacheRead += e.cache_read_tokens || 0;
    byAgent[key].count++;
  }

  console.log('\n  Cache Hit Rate by Agent');
  console.log(`  ${'─'.repeat(60)}`);
  const sorted = Object.entries(byAgent).sort((a, b) => {
    const rateA = a[1].input > 0 ? a[1].cacheRead / (a[1].cacheRead + a[1].input) : 0;
    const rateB = b[1].input > 0 ? b[1].cacheRead / (b[1].cacheRead + b[1].input) : 0;
    return rateA - rateB;
  });
  for (const [agent, data] of sorted) {
    const rate = data.input > 0 ? Math.round((data.cacheRead / (data.cacheRead + data.input)) * 100) : 0;
    const flag = rate < 40 ? ' ← LOW' : '';
    console.log(`  ${agent.padEnd(35)} ${String(rate).padStart(3)}% (${data.count} calls)${flag}`);
  }
  console.log();
}

function exportCmd() {
  const entries = readLedger();
  console.log(JSON.stringify(entries, null, 2));
}

function resetCmd() {
  ensureDir();
  const fp = ledgerFile();
  if (fs.existsSync(fp)) {
    const backup = `${fp}.bak.${Date.now()}`;
    fs.copyFileSync(fp, backup);
    atomicWrite(fp, '', { mode: 0o600 });
    console.log(`Ledger reset. Backup at ${backup}`);
  } else {
    console.log('No ledger to reset.');
  }
}

// ── Project-Level Aggregation ────────────────────────────
// Persistent cost tracking across ALL pipeline runs for the project.
// Data lives at _cobolt-output/project-costs.jsonl (never reset by new runs).

function projectLedgerFile() {
  return path.join(process.cwd(), '_cobolt-output/project-costs.jsonl');
}

function readProjectLedger() {
  const fp = projectLedgerFile();
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

function projectSummary() {
  const entries = readProjectLedger();
  if (entries.length === 0) {
    console.log('No project cost data recorded yet.');
    return;
  }

  let totalInput = 0,
    totalOutput = 0,
    totalCacheRead = 0,
    totalCacheWrite = 0,
    totalCost = 0;
  const byMilestone = {};
  const byStage = {};
  const byModel = {};
  const byAgent = {};

  for (const e of entries) {
    totalInput += e.input_tokens || 0;
    totalOutput += e.output_tokens || 0;
    totalCacheRead += e.cache_read_tokens || 0;
    totalCacheWrite += e.cache_write_tokens || 0;
    totalCost += e.cost_usd || 0;

    const ms = e.milestone || 'none';
    byMilestone[ms] = byMilestone[ms] || { tokens: 0, cost: 0, count: 0 };
    byMilestone[ms].tokens += totalLedgerTokens(e);
    byMilestone[ms].cost += e.cost_usd || 0;
    byMilestone[ms].count++;

    const st = e.stage || 'unknown';
    byStage[st] = byStage[st] || { tokens: 0, cost: 0, count: 0 };
    byStage[st].tokens += totalLedgerTokens(e);
    byStage[st].cost += e.cost_usd || 0;
    byStage[st].count++;

    const m = e.model || 'unknown';
    byModel[m] = byModel[m] || { tokens: 0, cost: 0, count: 0 };
    byModel[m].tokens += totalLedgerTokens(e);
    byModel[m].cost += e.cost_usd || 0;
    byModel[m].count++;

    const a = e.agent || 'unknown';
    byAgent[a] = byAgent[a] || { tokens: 0, cost: 0, count: 0 };
    byAgent[a].tokens += totalLedgerTokens(e);
    byAgent[a].cost += e.cost_usd || 0;
    byAgent[a].count++;
  }

  const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheWrite;
  const first = entries[0]?.timestamp ? new Date(entries[0].timestamp) : null;
  const last = entries[entries.length - 1]?.timestamp ? new Date(entries[entries.length - 1].timestamp) : null;
  const spanDays = first && last ? Math.max(1, Math.ceil((last - first) / (1000 * 60 * 60 * 24))) : 1;

  console.log(`\n  Project Lifetime Cost Summary`);
  console.log(`  ${'─'.repeat(55)}`);
  console.log(`  Total invocations:  ${entries.length.toLocaleString()}`);
  console.log(`  Total tokens:       ${formatTokens(totalTokens)}`);
  console.log(`  Total cost:         ${formatUSD(totalCost)}`);
  console.log(`  Tracking period:    ${spanDays} day(s)`);
  console.log(`  Avg cost/day:       ${formatUSD(totalCost / spanDays)}`);
  console.log();

  console.log(`  By Milestone:`);
  const msSorted = Object.entries(byMilestone).sort((a, b) => b[1].cost - a[1].cost);
  for (const [ms, data] of msSorted) {
    const pct = totalCost > 0 ? Math.round((data.cost / totalCost) * 100) : 0;
    console.log(
      `    ${ms.padEnd(10)} ${String(data.count).padStart(5)} calls  ${formatTokens(data.tokens).padStart(8)} tokens  ${formatUSD(data.cost).padStart(10)}  ${String(pct).padStart(3)}%`,
    );
  }
  console.log();

  console.log(`  By Pipeline Stage:`);
  const stSorted = Object.entries(byStage).sort((a, b) => b[1].cost - a[1].cost);
  for (const [st, data] of stSorted) {
    const pct = totalCost > 0 ? Math.round((data.cost / totalCost) * 100) : 0;
    console.log(
      `    ${st.padEnd(16)} ${String(data.count).padStart(5)} calls  ${formatTokens(data.tokens).padStart(8)} tokens  ${formatUSD(data.cost).padStart(10)}  ${String(pct).padStart(3)}%`,
    );
  }
  console.log();

  console.log(`  By Model Tier:`);
  for (const [model, data] of Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost)) {
    console.log(
      `    ${model.padEnd(10)} ${String(data.count).padStart(5)} calls  ${formatTokens(data.tokens).padStart(8)} tokens  ${formatUSD(data.cost).padStart(10)}`,
    );
  }
  console.log();

  console.log(`  Top 10 Most Expensive Agents:`);
  const agentSorted = Object.entries(byAgent)
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 10);
  for (const [agent, data] of agentSorted) {
    const avgCost = data.count > 0 ? data.cost / data.count : 0;
    console.log(
      `    ${agent.padEnd(30)} ${String(data.count).padStart(4)}x  ${formatUSD(data.cost).padStart(10)}  (avg ${formatUSD(avgCost)}/call)`,
    );
  }
  console.log();
}

function projectReport(args) {
  const entries = readProjectLedger();
  if (entries.length === 0) {
    console.log('No project cost data to report.');
    return;
  }

  const msIdx = args.indexOf('--milestone');
  const milestone = msIdx >= 0 ? args[msIdx + 1] : null;
  const filtered = milestone ? entries.filter((e) => e.milestone === milestone) : entries;

  let totalInput = 0,
    totalOutput = 0,
    totalCacheRead = 0,
    totalCacheWrite = 0,
    totalCost = 0;
  const byModel = {};
  const byStage = {};
  const byMilestone = {};
  const byAgent = {};

  for (const e of filtered) {
    totalInput += e.input_tokens || 0;
    totalOutput += e.output_tokens || 0;
    totalCacheRead += e.cache_read_tokens || 0;
    totalCacheWrite += e.cache_write_tokens || 0;
    totalCost += e.cost_usd || 0;

    const m = e.model || 'unknown';
    byModel[m] = byModel[m] || { count: 0, tokens: 0, cost: 0 };
    byModel[m].count++;
    byModel[m].tokens += totalLedgerTokens(e);
    byModel[m].cost += e.cost_usd || 0;

    const s = e.stage || 'unknown';
    byStage[s] = byStage[s] || { count: 0, cost: 0 };
    byStage[s].count++;
    byStage[s].cost += e.cost_usd || 0;

    const ms = e.milestone || 'none';
    byMilestone[ms] = byMilestone[ms] || { count: 0, tokens: 0, cost: 0 };
    byMilestone[ms].count++;
    byMilestone[ms].tokens += totalLedgerTokens(e);
    byMilestone[ms].cost += e.cost_usd || 0;

    const a = e.agent || 'unknown';
    byAgent[a] = byAgent[a] || { count: 0, tokens: 0, cost: 0 };
    byAgent[a].count++;
    byAgent[a].tokens += totalLedgerTokens(e);
    byAgent[a].cost += e.cost_usd || 0;
  }

  const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheWrite;
  const title = milestone ? `Project Cost Report — ${milestone}` : 'Project Lifetime Cost Report';

  let md = `# ${title}\n\n`;
  md += `_Generated: ${new Date().toISOString()}_\n\n`;
  md += `## Summary\n\n`;
  md += `- **Invocations**: ${filtered.length.toLocaleString()}\n`;
  md += `- **Total tokens**: ${formatTokens(totalTokens)}\n`;
  md += `- **Estimated cost**: ${formatUSD(totalCost)}\n`;
  md += `- **Data source**: Estimation-based (4 chars/token heuristic)\n\n`;

  md += `## By Milestone\n\n`;
  md += `| Milestone | Invocations | Tokens | Cost | % of Total |\n`;
  md += `|-----------|------------|--------|------|------------|\n`;
  for (const [ms, data] of Object.entries(byMilestone).sort((a, b) => b[1].cost - a[1].cost)) {
    const pct = totalCost > 0 ? Math.round((data.cost / totalCost) * 100) : 0;
    md += `| ${ms} | ${data.count} | ${formatTokens(data.tokens)} | ${formatUSD(data.cost)} | ${pct}% |\n`;
  }

  md += `\n## By Model Tier\n\n`;
  md += `| Tier | Invocations | Tokens | Cost |\n`;
  md += `|------|------------|--------|------|\n`;
  for (const [model, data] of Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost)) {
    md += `| ${model} | ${data.count} | ${formatTokens(data.tokens)} | ${formatUSD(data.cost)} |\n`;
  }

  md += `\n## By Pipeline Stage\n\n`;
  md += `| Stage | Invocations | Cost | % of Total |\n`;
  md += `|-------|------------|------|------------|\n`;
  for (const [stage, data] of Object.entries(byStage).sort((a, b) => b[1].cost - a[1].cost)) {
    const pct = totalCost > 0 ? Math.round((data.cost / totalCost) * 100) : 0;
    md += `| ${stage} | ${data.count} | ${formatUSD(data.cost)} | ${pct}% |\n`;
  }

  md += `\n## Top 15 Most Expensive Agents\n\n`;
  md += `| Agent | Calls | Total Tokens | Total Cost | Avg Cost/Call |\n`;
  md += `|-------|-------|-------------|------------|---------------|\n`;
  const topAgents = Object.entries(byAgent)
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 15);
  for (const [agent, data] of topAgents) {
    const avg = data.count > 0 ? data.cost / data.count : 0;
    md += `| ${agent} | ${data.count} | ${formatTokens(data.tokens)} | ${formatUSD(data.cost)} | ${formatUSD(avg)} |\n`;
  }

  const reportPath = path.join(process.cwd(), '_cobolt-output/project-cost-report.md');
  atomicWrite(reportPath, md, { mode: 0o600 });
  console.log(`Project cost report written to ${reportPath}`);
}

function projectTrend() {
  const entries = readProjectLedger();
  if (entries.length === 0) {
    console.log('No project cost data for trend analysis.');
    return;
  }

  // Group by date
  const byDate = {};
  const byMilestoneDate = {};
  for (const e of entries) {
    const date = e.timestamp ? e.timestamp.slice(0, 10) : 'unknown';
    byDate[date] = byDate[date] || { tokens: 0, cost: 0, count: 0 };
    byDate[date].tokens += totalLedgerTokens(e);
    byDate[date].cost += e.cost_usd || 0;
    byDate[date].count++;

    const ms = e.milestone || 'none';
    const key = `${ms}|${date}`;
    byMilestoneDate[key] = byMilestoneDate[key] || { milestone: ms, date, tokens: 0, cost: 0, count: 0 };
    byMilestoneDate[key].tokens += totalLedgerTokens(e);
    byMilestoneDate[key].cost += e.cost_usd || 0;
    byMilestoneDate[key].count++;
  }

  console.log(`\n  Project Cost Trend (by day)`);
  console.log(`  ${'─'.repeat(65)}`);
  console.log(
    `  ${'Date'.padEnd(12)} ${'Calls'.padStart(6)} ${'Tokens'.padStart(10)} ${'Cost'.padStart(10)} ${'Cumulative'.padStart(12)}`,
  );

  let cumulative = 0;
  const sortedDates = Object.keys(byDate).sort();
  for (const date of sortedDates) {
    const data = byDate[date];
    cumulative += data.cost;
    console.log(
      `  ${date.padEnd(12)} ${String(data.count).padStart(6)} ${formatTokens(data.tokens).padStart(10)} ${formatUSD(data.cost).padStart(10)} ${formatUSD(cumulative).padStart(12)}`,
    );
  }

  console.log();
  console.log(`  Milestone Breakdown by Day:`);
  console.log(`  ${'─'.repeat(65)}`);

  // Group by milestone, then show dates
  const milestones = {};
  for (const data of Object.values(byMilestoneDate)) {
    milestones[data.milestone] = milestones[data.milestone] || [];
    milestones[data.milestone].push(data);
  }

  for (const [ms, days] of Object.entries(milestones).sort()) {
    const totalCost = days.reduce((s, d) => s + d.cost, 0);
    const totalTokens = days.reduce((s, d) => s + d.tokens, 0);
    console.log(`\n  ${ms}: ${formatTokens(totalTokens)} tokens, ${formatUSD(totalCost)} total`);
    for (const d of days.sort((a, b) => a.date.localeCompare(b.date))) {
      console.log(
        `    ${d.date}  ${String(d.count).padStart(5)} calls  ${formatTokens(d.tokens).padStart(8)} tokens  ${formatUSD(d.cost).padStart(10)}`,
      );
    }
  }
  console.log();
}

function projectExport() {
  const entries = readProjectLedger();
  console.log(JSON.stringify(entries, null, 2));
}

// ── Session Persistence ──────────────────────────────────
// Save/restore session state across conversation boundaries.
// Adapted from Claude Code's cost-tracker.ts session persistence pattern.

function sessionStateFile() {
  return path.join(costDir(), 'session-state.json');
}

function saveSession() {
  ensureDir();
  const entries = readLedger();
  const totalCost = entries.reduce((sum, e) => sum + (e.cost_usd || 0), 0);
  const modelUsage = {};
  for (const e of entries) {
    const m = e.model || 'unknown';
    if (!modelUsage[m]) modelUsage[m] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 };
    modelUsage[m].input += e.input_tokens || 0;
    modelUsage[m].output += e.output_tokens || 0;
    modelUsage[m].cacheRead += e.cache_read_tokens || 0;
    modelUsage[m].cacheWrite += e.cache_write_tokens || 0;
    modelUsage[m].cost += e.cost_usd || 0;
    modelUsage[m].calls++;
  }
  const state = {
    sessionId: `session-${Date.now()}`,
    totalCost,
    totalInvocations: entries.length,
    modelUsage,
    savedAt: new Date().toISOString(),
  };
  atomicWrite(sessionStateFile(), JSON.stringify(state, null, 2), { mode: 0o600 });
  console.log(`Session saved: ${formatUSD(totalCost)} across ${entries.length} invocations.`);
}

function resumeSession() {
  const sf = sessionStateFile();
  if (!fs.existsSync(sf)) {
    console.log('No saved session to resume.');
    return;
  }
  const state = JSON.parse(fs.readFileSync(sf, 'utf8'));
  console.log(`\n  Resumed Session: ${state.sessionId}`);
  console.log(`  ${'─'.repeat(45)}`);
  console.log(`  Saved at:         ${state.savedAt}`);
  console.log(`  Total cost:       ${formatUSD(state.totalCost)}`);
  console.log(`  Invocations:      ${state.totalInvocations}`);
  console.log();
  console.log(`  Per-Model Cache Efficiency:`);
  for (const [model, data] of Object.entries(state.modelUsage)) {
    const totalInput = data.input + data.cacheRead;
    const cacheRate = totalInput > 0 ? Math.round((data.cacheRead / totalInput) * 100) : 0;
    const writeRate = data.output > 0 ? Math.round((data.cacheWrite / (data.cacheWrite + data.output)) * 100) : 0;
    console.log(
      `    ${model.padEnd(8)} read: ${String(cacheRate).padStart(3)}%  write: ${String(writeRate).padStart(3)}%  cost: ${formatUSD(data.cost)}`,
    );
  }
  console.log();
}

function showHelp() {
  console.log(`
  cobolt-cost — Multi-agent cost tracking and cache analysis

  Per-Run Commands:
    record <agent> <model> <input> <output>   Record token usage
      [--cache-read N] [--cache-write N]       Cache token counts
      [--cached-tokens N]                      OpenAI cached token alias
      [--usage-file file --provider openai|anthropic]
                                              Parse provider usage payload
      [--stage S] [--milestone M]              Pipeline context
    show                                       Show current run cost summary
    report [--milestone M1]                    Generate current run cost report
    budget [--set USD] [--tokens N]            Show/set milestone budget
      [--soft 80] [--hard 100] [--milestone M1]
    check [--auto] [--json]                    Evaluate GT-02 budget gate
    extend --reason R --approver email         Sign a cost-budget extension
      [--hours N | --until ISO] [--json]
    cache-analysis                             Analyze cache hit rates
    export                                     Export current run ledger as JSON
    reset                                      Reset current run ledger (with backup)
    save                                       Save session state for resume
    resume                                     Restore session state + cache efficiency

  Project Lifetime Commands:
    project-summary                            Show lifetime cost by milestone/stage/agent
    project-report [--milestone M1]            Generate full project cost report (markdown)
    project-trend                              Show daily cost trend + milestone breakdown
    project-export                             Export full project ledger as JSON
  `);
}

function main(args = process.argv.slice(2)) {
  const cmd = args[0];

  switch (cmd) {
    case 'record':
      record(args.slice(1));
      break;
    case 'show':
      show();
      break;
    case 'report':
      generateReport(args.slice(1));
      break;
    case 'budget':
      budgetCmd(args.slice(1));
      break;
    case 'check':
      checkBudgetCmd(args.slice(1));
      break;
    case 'extend':
      extendBudgetCmd(args.slice(1));
      break;
    case 'cache-analysis':
      cacheAnalysis();
      break;
    case 'export':
      exportCmd();
      break;
    case 'reset':
      resetCmd();
      break;
    case 'save':
      saveSession();
      break;
    case 'resume':
      resumeSession();
      break;
    case 'project-summary':
      projectSummary();
      break;
    case 'project-report':
      projectReport(args.slice(1));
      break;
    case 'project-trend':
      projectTrend();
      break;
    case 'project-export':
      projectExport();
      break;
    default:
      showHelp();
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  PRICING,
  calculateCost,
  extractAnthropicUsage,
  extractOpenAiUsage,
  parseInteger,
  readLedger,
  record,
  totalLedgerTokens,
};
