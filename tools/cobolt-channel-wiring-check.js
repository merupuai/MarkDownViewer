#!/usr/bin/env node

// CoBolt Channel Wiring Check — deterministic Socket.IO / ws / SSE wiring verifier.
//
// Purpose:
//   Closes the WebSocket/SSE "silent channel typo" failure mode. Given a project
//   emits on channel `chat.message` (server-side io.emit) and handles it
//   elsewhere (server-side io.on or frontend socket.on), this tool verifies
//   every emit has a handler and vice versa.
//
// Scope:
//   - Socket.IO v2+  — detected when `socket.io` or `socket.io-client` in deps
//   - ws (raw)       — detected when `ws` in deps; channel-based routing only
//                      (ws without a channel convention is flagged unresolvable)
//   - SSE (server-sent events) — detected by `text/event-stream` content-type
//                      + write() pattern; advisory-only (no consumer pairing)
//
// Exit contract (tools/CLAUDE.md):
//   0 — all detectable channels paired (or no realtime code — permissive no-op)
//   1 — one or more orphan emits or orphan handlers
//   2 — realtime libraries referenced in code but not declared in deps
//   3 — missing infrastructure (reserved; currently unused)
//
// Honest limits (reported in artifact):
//   - Socket.IO lifecycle events (`connection`, `disconnect`, …) are excluded.
//   - Dynamic channel names (template literals, identifiers) are flagged as
//     `unresolvable: true` and neither fail nor pass — tracked separately.
//   - Cross-repo pairing (backend A emits, frontend B consumes across repos)
//     is OUT OF SCOPE. Declare those in `cobolt-queue-manifest.json` (v1 only
//     covers queues; channel-manifest is future work).
//
// Artifact: _cobolt-output/latest/build/{M}/{M}-channel-wiring.json
// Bypass: COBOLT_CHANNEL_WIRING=off (logged, not silent)

const fs = require('node:fs');
const path = require('node:path');
const { buildProvenance } = require('./_brownfield-provenance');
const {
  CHANNEL_EMIT_PATTERNS,
  CHANNEL_HANDLER_PATTERNS,
  SSE_CONTENT_TYPE_PATTERN,
  SSE_WRITE_PATTERN,
  SSE_EVENT_MARKER_PATTERN,
  isSocketIoLifecycleEvent,
  findSubjectMatches,
  findUnresolvableSubjects,
  walkSourceFiles,
} = require('../lib/cobolt-messaging-patterns');

const TOOL_NAME = 'cobolt-channel-wiring-check';
const TOOL_VERSION = '1.0';

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

// ── Framework detection ──────────────────────────────────────────────────────

function detectFrameworks(projectDir) {
  const frameworks = {
    socketio: false,
    ws: false,
    sse: false,
    // v0.65.3 — additional realtime transports recognized at the dependency
    // level. Detection only — pairing/wiring verification stays on the
    // socket.io+ws+sse fast path; these surfaces emit a deterministic-boundary
    // record so consumers see "we cannot verify this transport" honestly.
    boundary: [],
  };
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readText(pkgPath));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps['socket.io'] || deps['socket.io-client'] || deps['@nestjs/websockets']) {
        frameworks.socketio = true;
      }
      if (deps.ws || deps['@fastify/websocket'] || deps['socket.io'] /* bundles ws */) {
        frameworks.ws = true;
      }
      // Boundary transports — declared but not statically verifiable yet.
      const BOUNDARY_REALTIME = {
        phoenix: 'phoenix-channels-js',
        '@livestate/client': 'phoenix-livestate',
        ably: 'ably',
        'pusher-js': 'pusher',
        pusher: 'pusher-server',
        centrifuge: 'centrifuge',
        '@hocuspocus/server': 'hocuspocus',
        '@hocuspocus/provider': 'hocuspocus',
        partykit: 'partykit',
        partysocket: 'partykit',
        '@liveblocks/client': 'liveblocks',
        '@liveblocks/node': 'liveblocks',
        '@supabase/realtime-js': 'supabase-realtime',
        '@supabase/supabase-js': 'supabase-realtime',
      };
      for (const dep of Object.keys(deps)) {
        if (BOUNDARY_REALTIME[dep] && !frameworks.boundary.includes(BOUNDARY_REALTIME[dep])) {
          frameworks.boundary.push(BOUNDARY_REALTIME[dep]);
        }
      }
    } catch {
      // malformed package.json — skip
    }
  }
  // mix.exs (Phoenix Channels — server side)
  try {
    const mix = readText(path.join(projectDir, 'mix.exs'));
    if (mix && /:phoenix(?:\s|,)/.test(mix)) {
      if (!frameworks.boundary.includes('phoenix-channels-elixir')) {
        frameworks.boundary.push('phoenix-channels-elixir');
      }
    }
  } catch {
    /* no mix.exs */
  }
  frameworks.boundary.sort();
  // SSE is framework-less — detected by content pattern during scan.
  return frameworks;
}

// Scan files for SSE signals. Returns { present, sites, eventNames }.
// SSE is advisory only: we detect server-side streaming endpoints but we don't
// pair them with consumers (EventSource is almost always in frontend which
// may or may not be in this repo).
function detectSseEndpoints(projectDir) {
  const sites = [];
  const eventNames = new Set();
  const files = walkSourceFiles(projectDir);
  for (const file of files) {
    const text = readText(file.path);
    if (!text) continue;
    const hasContentType = SSE_CONTENT_TYPE_PATTERN.test(text);
    const hasWrite = SSE_WRITE_PATTERN.test(text);
    if (hasContentType && hasWrite) {
      sites.push({ file: file.relativePath });
      for (const m of text.matchAll(SSE_EVENT_MARKER_PATTERN)) {
        if (m[1]) eventNames.add(m[1].trim());
      }
    }
  }
  return {
    present: sites.length > 0,
    sites,
    eventNames: [...eventNames].sort(),
  };
}

// ── Core scan ────────────────────────────────────────────────────────────────

function scan(projectDir, _options = {}) {
  const resolved = path.resolve(projectDir);
  const frameworks = detectFrameworks(resolved);
  const sse = detectSseEndpoints(resolved);

  const emits = findSubjectMatches(resolved, CHANNEL_EMIT_PATTERNS);
  const handles = findSubjectMatches(resolved, CHANNEL_HANDLER_PATTERNS);

  // Filter out Socket.IO lifecycle events from handlers — they are not app channels.
  const appHandles = new Map();
  for (const [subject, sites] of handles.subjects) {
    if (isSocketIoLifecycleEvent(subject)) continue;
    appHandles.set(subject, sites);
  }

  // Channels present in code but no socket.io/ws in deps → exit 2.
  const realtimeCodePresent = emits.subjects.size > 0 || appHandles.size > 0;
  const realtimeDepsPresent = frameworks.socketio || frameworks.ws;

  // Compute pairing.
  const channels = [];
  const allSubjects = new Set([...emits.subjects.keys(), ...appHandles.keys()]);
  for (const subject of [...allSubjects].sort()) {
    const emitSites = emits.subjects.get(subject) || [];
    const handleSites = appHandles.get(subject) || [];
    let status;
    if (emitSites.length > 0 && handleSites.length > 0) status = 'paired';
    else if (emitSites.length > 0) status = 'orphan-emit';
    else status = 'orphan-handle';
    channels.push({
      name: subject,
      status,
      emits: emitSites.slice(0, 5),
      handles: handleSites.slice(0, 5),
      tech: (emitSites[0] || handleSites[0])?.tech || 'unknown',
    });
  }

  // Flag unresolvable (dynamic) channel names.
  const unresolvable = findUnresolvableSubjects(resolved, ['emit', 'on'], {});
  // ws channels where the `channel:` convention is not used → flag the file as ws-unresolvable.
  const wsFiles = [];
  if (frameworks.ws) {
    for (const file of walkSourceFiles(resolved)) {
      const text = readText(file.path);
      if (!text) continue;
      if (/new\s+(?:WebSocket|WebSocketServer|ws)\s*\(/.test(text)) {
        if (!/channel\s*:\s*["'`]/.test(text)) {
          wsFiles.push({
            file: file.relativePath,
            kind: 'ws-no-channel-convention',
          });
        }
      }
    }
  }

  const paired = channels.filter((c) => c.status === 'paired').length;
  const orphanEmits = channels.filter((c) => c.status === 'orphan-emit');
  const orphanHandles = channels.filter((c) => c.status === 'orphan-handle');

  const report = {
    generatedAt: new Date().toISOString(),
    generatedBy: TOOL_NAME,
    version: TOOL_VERSION,
    ...buildProvenance(resolved, []),
    frameworks: Object.entries(frameworks)
      .filter(([, v]) => v)
      .map(([k]) => k),
    sse: {
      present: sse.present,
      sites: sse.sites.slice(0, 20),
      eventNames: sse.eventNames.slice(0, 50),
    },
    summary: {
      total: channels.length,
      paired,
      orphanEmits: orphanEmits.length,
      orphanHandles: orphanHandles.length,
      unresolvable: unresolvable.length + wsFiles.length,
      realtimeCodePresent,
      realtimeDepsPresent,
      sseEndpoints: sse.sites.length,
      // v0.65.3 — count of declared-but-unverifiable transports
      boundaryFrameworks: (frameworks.boundary || []).length,
    },
    channels,
    unresolvable: [...unresolvable.slice(0, 50), ...wsFiles.slice(0, 50)],
    deterministicBoundary: frameworks.boundary || [],
    honestLimits: [
      'Socket.IO lifecycle events (connect, disconnect, error, ...) are excluded from pairing.',
      'Dynamic channel names (template literals, identifiers, process.env.X) are flagged as unresolvable, not failed.',
      'Cross-repo pairing is out of scope for v1.',
      'SSE is advisory — no consumer pairing (EventSource frontend is often in a separate repo).',
      // v0.65.3 — boundary transports
      ...((frameworks.boundary || []).length > 0
        ? [
            `Boundary transports detected (declared but not statically verifiable): ${(frameworks.boundary || []).join(', ')}. ` +
              'Their channel surfaces (Phoenix topics, Ably/Pusher channels, Centrifuge subs, Hocuspocus rooms, ' +
              'PartyKit/Liveblocks rooms, Supabase Realtime channels) cannot be paired by this tool. ' +
              'Plan a v2 walker extension or treat these surfaces as out-of-scope for invariant #17.',
          ]
        : []),
    ],
  };

  return report;
}

// ── Report writer ────────────────────────────────────────────────────────────

function writeReport(filePath, report) {
  const resolvedPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return resolvedPath;
}

// Decide exit code per tools/CLAUDE.md exit contract.
function decideExitCode(report) {
  // GT-01: bypass routes through signed ledger. Raw env-var still honored
  // during the deprecation window via auto-promotion to a 24h ledger entry.
  // Use report.sourcePath (the scanned project) so the bypass ledger lookup
  // and auto-promote target the same project the report describes — not the
  // caller's process.cwd(). This keeps test fixtures' env-var bypass writes
  // contained inside the temp project (cleaned up by afterEach) instead of
  // polluting the parent project's ledger for 24h.
  const { isGateBypassed } = require('../lib/cobolt-bypass-resolver');
  const projectRoot = report?.sourcePath || process.cwd();
  if (isGateBypassed('channel-wiring', { projectRoot })) {
    return { code: 0, bypass: true };
  }
  const { orphanEmits, orphanHandles, realtimeCodePresent, realtimeDepsPresent } = report.summary;
  if (realtimeCodePresent && !realtimeDepsPresent) {
    return { code: 2, reason: 'realtime-code-without-deps' };
  }
  if (!realtimeCodePresent) {
    return { code: 0, reason: 'no-realtime-code' };
  }
  if (orphanEmits > 0 || orphanHandles > 0) {
    return { code: 1, reason: 'orphan-channels' };
  }
  return { code: 0, reason: 'all-paired' };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(
      [
        'Usage:',
        '  cobolt-channel-wiring-check scan [project-path] [--milestone Mn] [--json] [--output <path>]',
        '',
        'Exit codes:',
        '  0 — all channels paired, or no realtime code, or bypass',
        '  1 — orphan emit(s) or orphan handler(s) found',
        '  2 — realtime code present but no realtime library in deps',
        '  3 — infra unavailable (reserved)',
        '',
        'Bypass: COBOLT_CHANNEL_WIRING=off (logged in audit log)',
      ].join('\n'),
    );
    process.exit(command ? 0 : 0);
  }

  if (command !== 'scan') {
    console.error(`Unknown command: ${command}. Run with --help.`);
    process.exit(2);
  }

  let projectDir = process.cwd();
  let outputPath = null;
  let milestone = process.env.COBOLT_MILESTONE || null;
  const jsonMode = args.includes('--json');

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) {
      outputPath = args[++i];
    } else if (args[i] === '--milestone' && args[i + 1]) {
      milestone = args[++i];
    } else if (args[i] === '--project' && args[i + 1]) {
      projectDir = path.resolve(args[++i]);
    } else if (!args[i].startsWith('--')) {
      projectDir = path.resolve(args[i]);
    }
  }

  const report = scan(projectDir);
  const defaultOutput = milestone
    ? path.join(projectDir, '_cobolt-output', 'latest', 'build', milestone, `${milestone}-channel-wiring.json`)
    : path.join(projectDir, '_cobolt-output', 'latest', 'build', 'channel-wiring.json');
  const target = outputPath || defaultOutput;
  writeReport(target, report);

  const verdict = decideExitCode(report);
  report.verdict = verdict;

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[${TOOL_NAME}] ${report.summary.total} channels scanned`);
    console.log(`  Frameworks: ${report.frameworks.join(', ') || 'none detected'}`);
    console.log(`  Paired: ${report.summary.paired}`);
    console.log(`  Orphan emits: ${report.summary.orphanEmits}`);
    console.log(`  Orphan handlers: ${report.summary.orphanHandles}`);
    console.log(`  Unresolvable: ${report.summary.unresolvable}`);
    console.log(`  SSE endpoints: ${report.summary.sseEndpoints}`);
    console.log(`  Verdict: exit ${verdict.code} (${verdict.reason || 'bypass'})`);
    console.log(`  Written: ${target}`);
  }

  process.exit(verdict.code);
}

module.exports = { scan, detectFrameworks, detectSseEndpoints, decideExitCode };
