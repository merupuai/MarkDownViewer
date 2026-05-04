#!/usr/bin/env node

const path = require('node:path');

const {
  formatAuditEventLine,
  listJsonlFiles,
  readRecentAuditEvents,
  readTailLines,
  parseJsonLine,
  normalizeAuditEvent,
} = require('../lib/cobolt-observability');

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    rootDir: process.cwd(),
    limit: 50,
    json: false,
    follow: false,
    color: process.stdout.isTTY,
    sinceMs: null,
    sources: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--follow' || arg === '-f') options.follow = true;
    else if (arg === '--no-color') options.color = false;
    else if (arg === '--color') options.color = true;
    else if (arg === '--limit' || arg === '-n') options.limit = Number(argv[++i] || options.limit);
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice('--limit='.length));
    else if (arg === '--root') options.rootDir = path.resolve(argv[++i] || options.rootDir);
    else if (arg.startsWith('--root=')) options.rootDir = path.resolve(arg.slice('--root='.length));
    else if (arg === '--since') options.sinceMs = parseSince(argv[++i]);
    else if (arg.startsWith('--since=')) options.sinceMs = parseSince(arg.slice('--since='.length));
    else if (arg === '--source') options.sources.push(argv[++i]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.limit) || options.limit <= 0) options.limit = 50;
  return options;
}

function parseSince(value) {
  if (!value) return null;
  const match = String(value)
    .trim()
    .match(/^(\d+)\s*([smhd])$/i);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const mult = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : unit === 'm' ? 60000 : 1000;
    return Date.now() - amount * mult;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function auditDir(rootDir) {
  return path.join(rootDir, '_cobolt-output', 'audit');
}

function sourceFiles(options) {
  const all = listJsonlFiles(auditDir(options.rootDir));
  if (options.sources.length === 0) return all;
  const wanted = new Set(options.sources.map((source) => String(source).replace(/\.jsonl$/i, '')));
  return all.filter((filePath) => wanted.has(path.basename(filePath).replace(/\.jsonl$/i, '')));
}

function snapshot(options) {
  return readRecentAuditEvents({
    projectRoot: options.rootDir,
    auditDir: auditDir(options.rootDir),
    files: sourceFiles(options),
    limit: options.limit,
    perFileLines: Math.max(options.limit, 100),
    maxBytesPerFile: 512 * 1024,
    sinceMs: options.sinceMs,
  }).reverse();
}

function render(events, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ count: events.length, events }, null, 2)}\n`);
    return;
  }
  if (events.length === 0) {
    process.stdout.write('No audit events found.\n');
    return;
  }
  for (const event of events) {
    process.stdout.write(`${formatAuditEventLine(event, { color: options.color })}\n`);
  }
}

function follow(options) {
  const files = sourceFiles(options);
  const offsets = new Map();
  for (const filePath of files) {
    try {
      offsets.set(filePath, require('node:fs').statSync(filePath).size);
    } catch {
      offsets.set(filePath, 0);
    }
  }
  process.stdout.write(`Watching ${files.length} audit stream(s). Press Ctrl+C to stop.\n`);
  let watcher = null;
  const emitNewLines = (filePath) => {
    const fs = require('node:fs');
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }
    const offset = offsets.get(filePath) || 0;
    if (stat.size < offset) offsets.set(filePath, 0);
    if (stat.size <= offset) return;
    const length = stat.size - offset;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(length);
      fs.readSync(fd, buffer, 0, length, offset);
      offsets.set(filePath, stat.size);
      for (const line of buffer.toString('utf8').split(/\r?\n/).filter(Boolean)) {
        const parsed = parseJsonLine(line);
        if (!parsed) continue;
        const event = normalizeAuditEvent(parsed, filePath, options.rootDir);
        if (options.json) process.stdout.write(`${JSON.stringify(event)}\n`);
        else process.stdout.write(`${formatAuditEventLine(event, { color: options.color })}\n`);
      }
    } finally {
      fs.closeSync(fd);
    }
  };

  try {
    const chokidar = require('chokidar');
    watcher = chokidar.watch(files, { ignoreInitial: true, persistent: true });
    watcher.on('change', emitNewLines).on('add', (filePath) => {
      offsets.set(filePath, 0);
      for (const line of readTailLines(filePath, { maxLines: options.limit, maxBytes: 512 * 1024 })) {
        const parsed = parseJsonLine(line);
        if (!parsed) continue;
        const event = normalizeAuditEvent(parsed, filePath, options.rootDir);
        process.stdout.write(
          options.json ? `${JSON.stringify(event)}\n` : `${formatAuditEventLine(event, { color: options.color })}\n`,
        );
      }
    });
  } catch {
    const interval = setInterval(() => {
      for (const filePath of files) emitNewLines(filePath);
    }, 1000);
    process.on('SIGINT', () => {
      clearInterval(interval);
      process.stdout.write('\nStopped tail.\n');
      process.exit(0);
    });
    return;
  }

  process.on('SIGINT', () => {
    if (watcher) watcher.close().catch(() => {});
    process.stdout.write('\nStopped tail.\n');
    process.exit(0);
  });
}

function printHelp() {
  process.stdout.write(`Usage: node tools/cobolt-tail.js [--limit N] [--since 24h] [--source gate-skip-log] [--json] [--follow]

Pretty-prints a unified event stream from _cobolt-output/audit/*.jsonl.
`);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  render(snapshot(options), options);
  if (options.follow) follow(options);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`cobolt-tail: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { main, parseArgs, snapshot };
