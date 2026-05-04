#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const advice = require('../lib/cobolt-gate-advice');
const registry = require('../lib/cobolt-gate-registry');
const { isBlockEvent, readRecentAuditEvents } = require('../lib/cobolt-observability');

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    rootDir: process.cwd(),
    json: false,
    sinceMs: Date.now() - 24 * 60 * 60 * 1000,
    haltPath: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--root') options.rootDir = path.resolve(argv[++i] || options.rootDir);
    else if (arg.startsWith('--root=')) options.rootDir = path.resolve(arg.slice('--root='.length));
    else if (arg === '--halt') options.haltPath = path.resolve(options.rootDir, argv[++i] || '');
    else if (arg.startsWith('--halt=')) options.haltPath = path.resolve(options.rootDir, arg.slice('--halt='.length));
    else if (arg === '--since') options.sinceMs = parseSince(argv[++i]);
    else if (arg.startsWith('--since=')) options.sinceMs = parseSince(arg.slice('--since='.length));
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function parseSince(value) {
  if (!value) return null;
  const match = String(value)
    .trim()
    .match(/^(\d+)\s*([mhd])$/i);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const mult = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : 60000;
    return Date.now() - amount * mult;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function defaultHaltPath(rootDir) {
  return path.join(rootDir, '_cobolt-output', 'latest', 'planning', 'HUMAN-REVIEW-REQUIRED.md');
}

function findLatestHalt(rootDir) {
  const direct = defaultHaltPath(rootDir);
  if (fs.existsSync(direct)) return direct;
  const base = path.join(rootDir, '_cobolt-output');
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === 'HUMAN-REVIEW-REQUIRED.md') {
        try {
          found.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs });
        } catch {
          found.push({ path: full, mtimeMs: 0 });
        }
      }
    }
  };
  walk(base);
  found.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return found[0]?.path || direct;
}

function extractGateIdsFromHalt(text) {
  const ids = new Set();
  const patterns = [
    /gate(?:Id|ID| name)?\s*[:=]\s*`?([A-Za-z0-9_.:-]+)`?/g,
    /###\s+`([^`]+)`\s+\(tier/g,
    /\b([a-z][a-z0-9-]{2,})\s+gate\b/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      const id = String(match[1] || '').trim();
      if (id && !['the', 'this', 'human'].includes(id.toLowerCase())) ids.add(id);
    }
  }
  return Array.from(ids);
}

function buildAdviceForGate(gateId, rootDir) {
  const reg = registry.getGateById(gateId);
  const fire = advice.latestFireEventForGate({ gateId, projectRoot: rootDir });
  const dynamic = fire
    ? {
        whyItFailed: fire.reason || fire.message || fire.event || fire.action,
        blockedTool: fire.tool,
        blockedFile: fire.filePath || fire.file,
        evidencePaths: [fire.evidencePath, fire.filePath, fire.file, fire.verificationPath].filter(Boolean),
      }
    : {};
  return advice.buildAdvice({ gateId, tier: reg?.tier ?? 1, dynamic, registry });
}

function collectWhyBlocked(options) {
  const haltPath = options.haltPath || findLatestHalt(options.rootDir);
  let haltText = '';
  let haltExists = false;
  try {
    haltText = fs.readFileSync(haltPath, 'utf8');
    haltExists = true;
  } catch {
    haltText = '';
  }

  const byGate = new Map();
  for (const item of advice.recentAdvice({ projectRoot: options.rootDir, sinceMs: options.sinceMs })) {
    byGate.set(item.gateId, item);
  }
  for (const gateId of extractGateIdsFromHalt(haltText)) {
    if (!byGate.has(gateId)) byGate.set(gateId, buildAdviceForGate(gateId, options.rootDir));
  }

  if (byGate.size === 0) {
    const recentBlocks = readRecentAuditEvents({
      projectRoot: options.rootDir,
      sinceMs: options.sinceMs,
      limit: 20,
      perFileLines: 200,
      maxBytesPerFile: 512 * 1024,
    }).filter((event) => isBlockEvent(event.raw));
    for (const event of recentBlocks.slice(0, 5)) {
      if (!byGate.has(event.gate)) byGate.set(event.gate, buildAdviceForGate(event.gate, options.rootDir));
    }
  }

  return {
    haltPath,
    haltExists,
    count: byGate.size,
    advice: Array.from(byGate.values()),
    suggestedUnblockCommand: '/cobolt-unblock',
  };
}

function renderText(result) {
  const lines = [];
  lines.push('Why Blocked');
  lines.push('='.repeat(60));
  lines.push(`Halt artifact: ${result.haltExists ? result.haltPath : 'not found'}`);
  lines.push(`Suggested unblock command: ${result.suggestedUnblockCommand}`);
  lines.push('');
  if (result.advice.length === 0) {
    lines.push('No recent blocking gate advice found.');
    lines.push('Run `node tools/cobolt-status.js --verbose` and inspect _cobolt-output/audit/gate-skip-log.jsonl.');
    return `${lines.join('\n')}\n`;
  }
  for (const item of result.advice) {
    lines.push(`Gate: ${item.gateId}`);
    lines.push(`Rule: ${item.ruleName}`);
    if (item.whyItFailed) lines.push(`Why: ${item.whyItFailed}`);
    if (Array.isArray(item.evidencePaths) && item.evidencePaths.length > 0) {
      lines.push(`Evidence: ${item.evidencePaths.join(', ')}`);
    }
    lines.push(`Run: ${item.suggestedAction.command}`);
    lines.push('');
  }
  return `${lines.join('\n')}`;
}

function printHelp() {
  process.stdout.write(`Usage: node tools/cobolt-why-blocked.js [--json] [--since 24h] [--halt <path>]

Reads the latest HUMAN-REVIEW-REQUIRED.md and recent gate-skip logs, then
renders gate name, rule, evidence files, and the next unblock command.
`);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const result = collectWhyBlocked(options);
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(renderText(result));
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`cobolt-why-blocked: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  collectWhyBlocked,
  extractGateIdsFromHalt,
  main,
  parseArgs,
  renderText,
};
