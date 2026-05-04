#!/usr/bin/env node

// CoBolt Advisory CLI — consume recovery-advisor proposals from the skill layer.
//
// Usage:
//   node tools/cobolt-advisory.js pending         # is there an unconsumed request?
//   node tools/cobolt-advisory.js response        # print the advisor's response (JSON)
//   node tools/cobolt-advisory.js action          # print just the action token
//   node tools/cobolt-advisory.js consume         # print response + archive it
//   node tools/cobolt-advisory.js resolve-phantom # mark phantom-recovery.json resolved=true
//
// The skill layer calls these between steps to decide what to do when the
// recovery tier returned "advisory-requested". All commands are idempotent
// and non-destructive unless explicitly marked (consume, resolve-phantom).

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const REQ = path.join('_cobolt-output', 'audit', 'advisory-request.json');
const RES = path.join('_cobolt-output', 'audit', 'advisory-response.json');
const ARCHIVE_DIR = path.join('_cobolt-output', 'audit', 'advisory-archive');
const PHANTOM = path.join('_cobolt-output', 'audit', 'phantom-recovery.json');
const LESSONS = path.join('_cobolt-output', 'memory', 'lessons.jsonl');
const REJECTIONS = path.join('_cobolt-output', 'audit', 'advisory-rejections.jsonl');
const BYPASS_LOG = path.join('_cobolt-output', 'audit', 'bypass-events.jsonl');
const USAGE = [
  'Usage: cobolt-advisory.js {pending|response|action|consume|resolve-phantom}',
  '',
  'Commands:',
  '  pending         Check whether an advisory request is waiting on a response.',
  '  response        Print the current advisory response JSON.',
  '  action          Print only the action token from the advisory response.',
  '  consume         Archive the advisory response and associated request.',
  '  resolve-phantom Mark phantom-recovery.json as resolved.',
].join('\n');

// Canonical non-deferrable finding classes — see
// source/skills/_shared/non-deferrable-classes.md
const NON_DEFERRABLE_CLASSES = new Set([
  'scope-gap',
  'illusion-critical',
  'illusion-high',
  'rtm-validated-fail',
  'story-count-mismatch',
  'test-coverage-gap',
]);
const REJECTED_VERDICTS = new Set(['defer', 'skip-with-debt']);

function findingClassFromRequest() {
  const req = readJSON(REQ);
  if (!req) return null;
  // Accept several shapes: failure.class, finding.class, class, findingClass
  return req.findingClass || req.class || req.finding?.class || req.failure?.class || null;
}

function scopeGateMode() {
  const raw = String(process.env.COBOLT_SCOPE_GATE || 'strict').toLowerCase();
  return raw === 'legacy' ? 'legacy' : 'strict';
}

function appendJSONL(file, obj) {
  try {
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, { mode: 0o600 });
  } catch (err) {
    // Advisory audit log is best-effort, but silent failure blinded operators.
    // Warn to stderr so CI / log-tailers can notice persistent write issues
    // (e.g. read-only audit dir, EPERM after privilege drop) without blocking.
    process.stderr.write(`[advisory] appendJSONL(${file}) failed: ${err.message?.split('\n')[0]}\n`);
  }
}

function ensureDir(d) {
  try {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  } catch {}
}

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function printUsage(code) {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(`${USAGE}\n`);
  return code;
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  if (!cmd) return printUsage(1);
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') return printUsage(0);

  switch (cmd) {
    case 'pending': {
      const hasReq = fs.existsSync(REQ);
      const hasRes = fs.existsSync(RES);
      if (hasReq && !hasRes) {
        console.log('advisory-pending: TRUE — recovery-advisor has not responded yet.');
        console.log('Next: dispatch recovery-advisor (opus) with input from:', REQ);
        return 2;
      }
      if (hasRes) {
        console.log('advisory-response: READY');
        return 0;
      }
      console.log('advisory-pending: NONE');
      return 0;
    }
    case 'response': {
      const r = readJSON(RES);
      if (!r) {
        console.error('no advisory-response.json found');
        return 1;
      }
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    case 'action': {
      const r = readJSON(RES);
      if (!r) {
        console.error('none');
        return 1;
      }
      console.log(r.action || 'escalate');
      return 0;
    }
    case 'consume': {
      const r = readJSON(RES);
      if (!r) {
        console.error('no advisory-response.json to consume');
        return 1;
      }
      // Non-deferrable gate — reject defer / skip-with-debt for scope-critical classes.
      const cls = findingClassFromRequest();
      const action = String(r.action || '').toLowerCase();
      if (cls && NON_DEFERRABLE_CLASSES.has(cls) && REJECTED_VERDICTS.has(action)) {
        const mode = scopeGateMode();
        const rec = {
          timestamp: new Date().toISOString(),
          findingClass: cls,
          verdict: action,
          mode,
          reason: 'non-deferrable class cannot accept defer/skip-with-debt',
          response: r,
        };
        if (mode === 'legacy') {
          // Emergency rollback — log and fall through to legacy accept behavior.
          appendJSONL(BYPASS_LOG, { ...rec, allowed: true, bypass: 'COBOLT_SCOPE_GATE=legacy' });
          console.error(`[advisory] LEGACY BYPASS: ${action} accepted for ${cls} (logged).`);
        } else {
          // Strict — reject, log, remove the stale response so advisor is re-dispatched.
          appendJSONL(REJECTIONS, rec);
          try {
            fs.unlinkSync(RES);
          } catch {}
          console.error(`[advisory] REJECTED: verdict "${action}" is not valid for non-deferrable class "${cls}".`);
          console.error(
            '[advisory] Valid verdicts: retry-with-context, fallback-main-session, split-scope, escalate-human.',
          );
          console.error(
            `[advisory] Rejection logged to ${REJECTIONS}. Re-dispatch recovery-advisor with updated prompt.`,
          );
          return 3;
        }
      }
      ensureDir(ARCHIVE_DIR);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target = path.join(ARCHIVE_DIR, `advisory-${stamp}.json`);
      try {
        // Persist the lesson (if present) to memory lessons
        if (r.lesson) {
          ensureDir(path.dirname(LESSONS));
          fs.appendFileSync(LESSONS, `${JSON.stringify({ ...r.lesson, timestamp: stamp })}\n`, { mode: 0o600 });
        }
        fs.renameSync(RES, target);
        if (fs.existsSync(REQ)) fs.renameSync(REQ, target.replace('.json', '.request.json'));
      } catch (e) {
        console.error('archive failed:', e.message);
        return 1;
      }
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    case 'resolve-phantom': {
      const p = readJSON(PHANTOM);
      if (!p) {
        console.error('no phantom-recovery.json');
        return 1;
      }
      p.resolved = true;
      p.resolvedAt = new Date().toISOString();
      atomicWrite(PHANTOM, JSON.stringify(p, null, 2), { mode: 0o600 });
      console.log('phantom-recovery.json marked resolved=true');
      return 0;
    }
    default:
      return printUsage(1);
  }
}

if (require.main === module) process.exit(main());
module.exports = { main, NON_DEFERRABLE_CLASSES, REJECTED_VERDICTS };
