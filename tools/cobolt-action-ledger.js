#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const ledger = require('../lib/cobolt-action-ledger');

function flagValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value == null || value.startsWith('--')) return true;
  return value;
}

function rootFrom(args) {
  return path.resolve(flagValue(args, '--root', process.cwd()));
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readInput(args) {
  const inputPath = flagValue(args, '--input');
  if (typeof inputPath === 'string') return JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  const raw = fs.readFileSync(0, 'utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}

function printUsage() {
  process.stdout.write(
    [
      'Usage: node tools/cobolt-action-ledger.js <command> [options]',
      '',
      'Commands:',
      '  record [--input file] [--root dir]   Append one hook-style tool event',
      '  verify [--root dir] [--json]         Verify signatures and previous-hash chain',
      '  summary [--root dir] [--json]        Summarize action counts and risk signals',
      '  tail [--limit n] [--root dir]        Print recent ledger entries',
      '  path [--root dir]                    Print ledger path',
      '',
      'Environment:',
      `  ${ledger.KEY_VAR}                  64-hex HMAC key; auto-generated on first record if absent`,
      '  COBOLT_ACTION_LEDGER=off            Disable PostToolUse capture',
      '',
    ].join('\n'),
  );
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'summary';
  const args = argv.slice(1);
  const json = args.includes('--json');
  const root = rootFrom(args);

  try {
    if (command === '--help' || command === '-h' || command === 'help') {
      printUsage();
      return 0;
    }
    if (command === 'record') {
      const entry = ledger.appendAction(readInput(args), { projectRoot: root });
      if (json) printJson({ ok: true, entry });
      else process.stdout.write(`[cobolt-action-ledger] recorded ${entry.action.tool.name} (${entry.entryId})\n`);
      return 0;
    }
    if (command === 'verify') {
      const result = ledger.verify({ projectRoot: root });
      if (json) printJson(result);
      else if (result.ok)
        process.stdout.write(
          `[cobolt-action-ledger] verify OK (${result.count} entr${result.count === 1 ? 'y' : 'ies'})\n`,
        );
      else {
        process.stderr.write(`[cobolt-action-ledger] verify failed (${result.errors.length} error(s))\n`);
        for (const error of result.errors.slice(0, 20)) {
          process.stderr.write(`  [${error.kind}] line ${error.line}: ${error.message}\n`);
        }
      }
      return result.ok ? 0 : 1;
    }
    if (command === 'summary') {
      const result = ledger.summarize({ projectRoot: root });
      if (json) printJson(result);
      else {
        process.stdout.write(`[cobolt-action-ledger] ${result.count} action entr${result.count === 1 ? 'y' : 'ies'}\n`);
        process.stdout.write(`  by tool: ${JSON.stringify(result.byTool)}\n`);
        process.stdout.write(`  risk signals: ${JSON.stringify(result.riskSignalCounts)}\n`);
      }
      return 0;
    }
    if (command === 'tail') {
      const limit = Number(flagValue(args, '--limit', 20));
      const result = ledger.list({ projectRoot: root, limit: Number.isFinite(limit) ? limit : 20 });
      if (json) printJson(result);
      else {
        for (const entry of result) {
          process.stdout.write(
            `${entry.timestamp} ${entry.outcome?.status || 'unknown'} ${entry.action?.tool?.operation || 'unknown'} ${entry.action?.tool?.name || 'unknown'} ${entry.entryId}\n`,
          );
        }
      }
      return 0;
    }
    if (command === 'path') {
      process.stdout.write(`${ledger.ledgerPath(root)}\n`);
      return 0;
    }
    process.stderr.write(`cobolt-action-ledger: unknown command "${command}". Run --help.\n`);
    return 1;
  } catch (error) {
    if (json) printJson({ ok: false, error: error.message || String(error) });
    else process.stderr.write(`[cobolt-action-ledger] ${error.message || String(error)}\n`);
    return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { main };
