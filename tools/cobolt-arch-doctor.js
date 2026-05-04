#!/usr/bin/env node

// CoBolt Architecture Doctor (v0.22.8) — full-stack diagnostic for the
// architecture-diagrams pipeline. Answers "why did my arch packet come out
// grey / empty / missing?" with a single structured report.
//
// Checks (in order):
//   1. Tool presence — every tool the pipeline dispatches
//   2. Schema presence — every JSON schema the tools validate against
//   3. Agent presence — diagram teammates, publish-docs teammates, escalation agents
//   4. Hook presence + registration in pre-dispatch
//   5. Renderer availability (delegates to architecture-diagram-render.js doctor)
//   6. Kill-switch state (every env flag and whether it's set)
//   7. Icon cache health (bundled registry + per-project cache + allowlist)
//   8. Graph + manifest freshness for the current pipeline (greenfield/brownfield)
//   9. Recent Arch/publish failure records under _cobolt-output/audit/
//  10. State coherence (cobolt-state.archDiagrams)
//
// Usage:
//   node tools/cobolt-arch-doctor.js check [--dir <project>] [--json] [--pipeline <p>]
//
// Exit codes:
//   0 — all green
//   1 — one or more warnings (pipeline can still run, but degraded)
//   2 — one or more failures (pipeline will likely produce empty/grey output)

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REQUIRED_TOOLS = [
  'cobolt-architecture-graph.js',
  'cobolt-architecture-diagrams.js',
  'cobolt-architecture-diagram-validate.js',
  'cobolt-architecture-diagram-render.js',
  'cobolt-architecture-diagram-report.js',
  'cobolt-architecture-log.js',
  'cobolt-arch-icon-search.js',
  'cobolt-arch-bootstrap.js',
  'cobolt-arch-propose.js',
  'cobolt-arch-failure-record.js',
  'cobolt-publish-docs.js',
  'cobolt-dispatch-depth.js',
  'cobolt-agent-failure-review.js',
  'cobolt-agent-dispatch-ledger.js',
];

const REQUIRED_SCHEMAS = [
  'architecture-graph.schema.json',
  'architecture-diagram-spec.schema.json',
  'architecture-diagram-manifest.schema.json',
  'architecture-diagram-gap-report.schema.json',
  'arch-icon-registry.schema.json',
  'arch-icon-cache-manifest.schema.json',
];

const REQUIRED_AGENTS = [
  'architecture-diagram-curator.md',
  'arch-icon-resolver.md',
  'publish-docs-curator.md',
  'publish-docs-validator.md',
  'architect.md',
  'review-lead.md',
  'recovery-advisor.md',
];
const REQUIRED_HOOKS = [
  'cobolt-dispatch-acl.js',
  'cobolt-model-tier-gate.js',
  'cobolt-subagent-write-guard.js',
  'cobolt-arch-diagram-gate.js',
  'cobolt-arch-icon-fetch-gate.js',
  'cobolt-arch-mutation-gate.js',
];

const RECENT_FAILURE_RE =
  /^(?:(?:architecture-diagram-curator|arch-icon-resolver|publish-docs-curator|publish-docs-validator)-failure(?:-[\w-]+)?|cobolt-architecture-[a-z-]+-failure|cobolt-publish-docs-failure)\.json$/;

const KILL_SWITCH_ENVS = [
  'COBOLT_ARCH_DIAGRAMS',
  'COBOLT_ARCH_DIAGRAM_GATE',
  'COBOLT_ARCH_ICON_FETCH',
  'COBOLT_ARCH_ICON_FETCH_GATE',
  'COBOLT_ARCH_MUTATION_GATE',
  'COBOLT_ARCH_CURATOR',
  'COBOLT_ARCH_ICON_RESOLVER',
  'COBOLT_ARCH_TEAM',
  'COBOLT_ARCH_RESOLVER_MAX',
  'COBOLT_ARCH_ICON_BUDGET',
  'COBOLT_V12_GATES',
];

function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next != null && !next.startsWith('--')) {
          out.flags[a.slice(2)] = next;
          i += 1;
        } else {
          out.flags[a.slice(2)] = true;
        }
      }
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

function _findRepoRoots(projectRoot) {
  // Tools can live either in-repo (dev) or under ~/.claude/tools (installed).
  const candidates = [
    projectRoot,
    path.join(projectRoot, '..'),
    process.env.COBOLT_TOOLS && path.dirname(process.env.COBOLT_TOOLS),
  ].filter(Boolean);
  return candidates;
}

function resolveFile(projectRoot, relPath) {
  const candidates = [
    path.join(projectRoot, relPath),
    process.env.COBOLT_TOOLS && path.join(process.env.COBOLT_TOOLS, '..', relPath),
    path.join(__dirname, '..', relPath),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function checkToolPresence(projectRoot) {
  const results = [];
  for (const name of REQUIRED_TOOLS) {
    const rel = path.join('tools', name);
    const found = resolveFile(projectRoot, rel);
    results.push({ name, ok: Boolean(found), path: found || rel });
  }
  return results;
}

function checkSchemaPresence(projectRoot) {
  const results = [];
  for (const name of REQUIRED_SCHEMAS) {
    const rel = path.join('source', 'schemas', name);
    const found = resolveFile(projectRoot, rel) || resolveFile(projectRoot, path.join('.claude', 'schemas', name));
    results.push({ name, ok: Boolean(found), path: found || rel });
  }
  return results;
}

function checkAgentPresence(projectRoot) {
  const results = [];
  for (const name of REQUIRED_AGENTS) {
    const rel = path.join('source', 'agents', name);
    const found = resolveFile(projectRoot, rel) || resolveFile(projectRoot, path.join('.claude', 'agents', name));
    results.push({ name, ok: Boolean(found), path: found || rel });
  }
  return results;
}

function checkHookPresence(projectRoot) {
  const results = [];
  for (const name of REQUIRED_HOOKS) {
    const rel = path.join('source', 'hooks', name);
    const installedRel = path.join('.claude', 'hooks', name);
    const found = resolveFile(projectRoot, rel) || resolveFile(projectRoot, installedRel);
    let registered = false;
    try {
      const dispatcher =
        resolveFile(projectRoot, path.join('source', 'hooks', 'cobolt-pre-dispatch.js')) ||
        resolveFile(projectRoot, path.join('.claude', 'hooks', 'cobolt-pre-dispatch.js'));
      if (dispatcher) {
        const txt = fs.readFileSync(dispatcher, 'utf8');
        registered = txt.includes(name);
      }
    } catch {
      /* registration check is advisory */
    }
    results.push({ name, ok: Boolean(found), registered, path: found || rel });
  }
  return results;
}

function callRenderDoctor(projectRoot) {
  const tool = resolveFile(projectRoot, path.join('tools', 'cobolt-architecture-diagram-render.js'));
  if (!tool) return { ok: false, reason: 'render tool not found' };
  try {
    const res = spawnSync(process.execPath, [tool, 'doctor', '--json'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    const stdout = String(res.stdout || '').trim();
    if (stdout) {
      try {
        return {
          ...JSON.parse(stdout),
          ok: res.status === 0,
          reason: res.status === 0 ? undefined : `exit ${res.status}`,
        };
      } catch {
        /* fall through to generic failure */
      }
    }
    if (res.status !== 0) return { ok: false, reason: `exit ${res.status}`, stderr: res.stderr };
    return JSON.parse(stdout);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function checkKillSwitches() {
  const out = {};
  for (const env of KILL_SWITCH_ENVS) {
    const val = process.env[env];
    out[env] = val == null ? null : String(val);
  }
  return out;
}

function checkIconCache(projectRoot, pipeline) {
  const base =
    pipeline === 'brownfield'
      ? path.join(projectRoot, '_cobolt-output', 'latest', 'brownfield', 'architecture-diagrams')
      : path.join(projectRoot, '_cobolt-output', 'latest', 'architecture-diagrams');
  const iconDir = path.join(base, 'icon-cache');
  const manifest = path.join(iconDir, 'icon-cache-manifest.json');
  const registry = resolveFile(projectRoot, path.join('source', 'icons', 'registry.json'));
  const cacheExists = fs.existsSync(iconDir);
  let cached = 0;
  let manifestOk = false;
  if (cacheExists) {
    try {
      cached = fs.readdirSync(iconDir).filter((f) => f.endsWith('.svg')).length;
      if (fs.existsSync(manifest)) {
        JSON.parse(fs.readFileSync(manifest, 'utf8'));
        manifestOk = true;
      }
    } catch {
      /* cache corrupted */
    }
  }
  let registryCount = 0;
  if (registry) {
    try {
      const data = JSON.parse(fs.readFileSync(registry, 'utf8'));
      registryCount = Object.keys(data.slugs || data || {}).length;
    } catch {
      /* advisory */
    }
  }
  return {
    cacheDir: iconDir,
    cacheExists,
    cachedIcons: cached,
    manifestOk,
    bundledRegistry: Boolean(registry),
    bundledRegistryCount: registryCount,
  };
}

function checkGraphAndManifest(projectRoot, pipeline) {
  const base =
    pipeline === 'brownfield'
      ? path.join(projectRoot, '_cobolt-output', 'latest', 'brownfield', 'architecture-diagrams')
      : path.join(projectRoot, '_cobolt-output', 'latest', 'architecture-diagrams');
  const graphPath = path.join(base, 'graph', 'architecture-graph.json');
  const manifestPath = path.join(base, 'diagram-manifest.json');
  const out = { pipeline, base };
  if (fs.existsSync(graphPath)) {
    try {
      const g = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
      const st = fs.statSync(graphPath);
      out.graph = {
        ok: true,
        path: graphPath,
        nodes: Array.isArray(g.nodes) ? g.nodes.length : 0,
        edges: Array.isArray(g.edges) ? g.edges.length : 0,
        mtime: st.mtime.toISOString(),
        ageMinutes: Math.round((Date.now() - st.mtimeMs) / 60000),
      };
    } catch (err) {
      out.graph = { ok: false, path: graphPath, reason: err.message };
    }
  } else {
    out.graph = { ok: false, path: graphPath, reason: 'not-found' };
  }
  if (fs.existsSync(manifestPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const st = fs.statSync(manifestPath);
      const diagrams = Array.isArray(m.diagrams) ? m.diagrams : [];
      out.manifest = {
        ok: true,
        path: manifestPath,
        diagrams: diagrams.length,
        publishableSvgCount: diagrams.filter((diagram) => diagram?.files?.svg || diagram?.files?.svgIconic).length,
        schemaPass: m.validation?.schemaPass,
        violations: m.validation?.violations?.length || 0,
        mtime: st.mtime.toISOString(),
        ageMinutes: Math.round((Date.now() - st.mtimeMs) / 60000),
      };
    } catch (err) {
      out.manifest = { ok: false, path: manifestPath, reason: err.message };
    }
  } else {
    out.manifest = { ok: false, path: manifestPath, reason: 'not-found' };
  }
  return out;
}

function checkRecentFailures(projectRoot) {
  const auditDir = path.join(projectRoot, '_cobolt-output', 'audit');
  if (!fs.existsSync(auditDir)) return { any: false, records: [] };
  const records = [];
  for (const f of fs.readdirSync(auditDir)) {
    if (!RECENT_FAILURE_RE.test(f)) continue;
    try {
      const raw = fs.readFileSync(path.join(auditDir, f), 'utf8');
      const rec = JSON.parse(raw);
      records.push({
        file: f,
        agent: rec.agent,
        status: rec.status,
        error_class: rec.error_class,
        escalation_target: rec.escalation_target,
      });
    } catch {
      records.push({ file: f, error: 'parse-failed' });
    }
  }
  return { any: records.length > 0, count: records.length, records };
}

function checkStateCoherence(projectRoot) {
  const sp = path.join(projectRoot, 'cobolt-state.json');
  if (!fs.existsSync(sp)) return { exists: false };
  try {
    const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
    return {
      exists: true,
      archDiagramsEnabled: Boolean(s?.archDiagrams?.enabled),
      archDiagramsLastRun: s?.archDiagrams?.lastRun || null,
      archDiagramsPipeline: s?.archDiagrams?.pipeline || null,
      currentMilestone: s?.pipeline?.currentMilestone || null,
    };
  } catch (err) {
    return { exists: true, parseError: err.message };
  }
}

function severityFromChecks(report) {
  // Failure: any required tool/schema/agent/hook missing
  const requiredMissing = [
    ...report.tools.filter((t) => !t.ok),
    ...report.schemas.filter((s) => !s.ok),
    ...report.agents.filter((a) => !a.ok),
    ...report.hooks.filter((h) => !h.ok),
  ];
  if (requiredMissing.length > 0) return { level: 'fail', issues: requiredMissing };

  const warnings = [];
  // Warning: hook exists but not registered in dispatcher
  for (const h of report.hooks) {
    if (h.ok && !h.registered) warnings.push({ kind: 'hook-unregistered', item: h.name });
  }
  // Warning: no graph/manifest on disk (pipeline never run)
  if (!report.graphManifest.graph?.ok) warnings.push({ kind: 'no-graph', reason: report.graphManifest.graph?.reason });
  if (!report.graphManifest.manifest?.ok)
    warnings.push({ kind: 'no-manifest', reason: report.graphManifest.manifest?.reason });
  // Warning: recent failure records
  if (report.recentFailures.any) warnings.push({ kind: 'recent-failures', count: report.recentFailures.count });
  // Warning: missing optional renderers. Built-in svg-iconic output is enough
  // for a publishable architecture packet, so do not mark a proven SVG-backed
  // packet as degraded only because external renderer CLIs are absent.
  const hasBuiltInSvgPacket = (report.graphManifest.manifest?.publishableSvgCount || 0) > 0;
  if (!report.renderers?.allRenderersAvailable && !hasBuiltInSvgPacket) {
    warnings.push({ kind: 'renderers-incomplete' });
  }
  // Warning: kill switch disables something
  for (const [k, v] of Object.entries(report.killSwitches)) {
    if (v == null) continue;
    const lower = String(v).toLowerCase();
    if (lower === 'off' || lower === 'bypass' || lower === '0' || lower === 'disabled') {
      warnings.push({ kind: 'kill-switch-active', env: k, value: v });
    }
  }
  if (warnings.length > 0) return { level: 'warn', warnings };
  return { level: 'ok' };
}

function renderHuman(report) {
  const {
    summary,
    tools,
    schemas,
    agents,
    hooks,
    renderers,
    killSwitches,
    iconCache,
    graphManifest,
    recentFailures,
    state,
  } = report;
  const lines = [];
  const banner = summary.level === 'ok' ? 'ALL GREEN' : summary.level === 'warn' ? 'WARNINGS' : 'FAILURES';
  lines.push(`\n[arch-doctor] ${banner}`);
  lines.push('');
  lines.push('Tools:');
  for (const t of tools) lines.push(`  ${t.ok ? '[OK]' : '[--]'} ${t.name}`);
  lines.push('');
  lines.push('Schemas:');
  for (const s of schemas) lines.push(`  ${s.ok ? '[OK]' : '[--]'} ${s.name}`);
  lines.push('');
  lines.push('Agents:');
  for (const a of agents) lines.push(`  ${a.ok ? '[OK]' : '[--]'} ${a.name}`);
  lines.push('');
  lines.push('Hooks (PreToolUse):');
  for (const h of hooks) {
    const reg = h.registered ? 'registered' : 'NOT registered';
    lines.push(`  ${h.ok ? '[OK]' : '[--]'} ${h.name.padEnd(38)} ${reg}`);
  }
  lines.push('');
  if (renderers?.checks) {
    lines.push(`Renderers (${renderers.okCount}/${renderers.totalCount} on ${renderers.platform}):`);
    for (const c of renderers.checks) {
      const mark = c.ok ? '[OK]' : '[--]';
      lines.push(`  ${mark} ${c.name.padEnd(22)} — ${c.purpose}`);
    }
    lines.push('');
  }
  lines.push('Graph + Manifest:');
  if (graphManifest.graph.ok) {
    lines.push(
      `  [OK] graph: ${graphManifest.graph.nodes} nodes / ${graphManifest.graph.edges} edges — age ${graphManifest.graph.ageMinutes} min`,
    );
  } else {
    lines.push(`  [--] graph: ${graphManifest.graph.reason || 'missing'}`);
  }
  if (graphManifest.manifest.ok) {
    const sp = graphManifest.manifest.schemaPass;
    const tag = sp === true ? '[OK]' : sp === false ? '[!!]' : '[??]';
    lines.push(
      `  ${tag} manifest: ${graphManifest.manifest.diagrams} diagrams, schemaPass=${sp}, violations=${graphManifest.manifest.violations} — age ${graphManifest.manifest.ageMinutes} min`,
    );
  } else {
    lines.push(`  [--] manifest: ${graphManifest.manifest.reason || 'missing'}`);
  }
  lines.push('');
  lines.push('Icon cache:');
  lines.push(
    `  ${iconCache.cacheExists ? '[OK]' : '[--]'} ${iconCache.cachedIcons} cached / manifest ${iconCache.manifestOk ? 'ok' : 'missing'} / bundled registry ${iconCache.bundledRegistryCount} slugs`,
  );
  lines.push('');
  lines.push('Recent failures:');
  if (recentFailures.any) {
    for (const r of recentFailures.records) {
      lines.push(`  [!!] ${r.file}: ${r.agent} ${r.status} (${r.error_class}) → ${r.escalation_target}`);
    }
  } else {
    lines.push('  [OK] none');
  }
  lines.push('');
  lines.push('Kill switches:');
  for (const [k, v] of Object.entries(killSwitches)) {
    if (v == null) continue;
    lines.push(`  ${k}=${v}`);
  }
  if (!Object.values(killSwitches).some((v) => v != null)) lines.push('  (none set)');
  lines.push('');
  lines.push('State:');
  if (state.exists) {
    lines.push(
      `  archDiagrams.enabled=${state.archDiagramsEnabled} lastRun=${state.archDiagramsLastRun || 'never'} milestone=${state.currentMilestone || '-'}`,
    );
  } else {
    lines.push('  (cobolt-state.json absent)');
  }
  lines.push('');
  if (summary.level !== 'ok') {
    lines.push('Next action:');
    if (summary.level === 'fail') {
      lines.push('  Run `node bin/install.js --claude --global --link` to restore missing files.');
    } else {
      lines.push('  Review the warnings above. Most are safe to ignore on first run.');
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function run(flags) {
  const projectRoot = flags.dir ? path.resolve(flags.dir) : process.cwd();
  let pipeline = flags.pipeline;
  if (!pipeline) {
    pipeline = fs.existsSync(path.join(projectRoot, '_cobolt-output', 'latest', 'brownfield'))
      ? 'brownfield'
      : 'greenfield';
  }

  const report = {
    generatedAt: new Date().toISOString(),
    projectRoot,
    pipeline,
    tools: checkToolPresence(projectRoot),
    schemas: checkSchemaPresence(projectRoot),
    agents: checkAgentPresence(projectRoot),
    hooks: checkHookPresence(projectRoot),
    renderers: callRenderDoctor(projectRoot),
    killSwitches: checkKillSwitches(),
    iconCache: checkIconCache(projectRoot, pipeline),
    graphManifest: checkGraphAndManifest(projectRoot, pipeline),
    recentFailures: checkRecentFailures(projectRoot),
    state: checkStateCoherence(projectRoot),
  };
  report.summary = severityFromChecks(report);

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderHuman(report));
  }
  if (report.summary.level === 'fail') return 2;
  if (report.summary.level === 'warn') return 1;
  return 0;
}

function main(argv = process.argv.slice(2)) {
  // v0.40.8 — honor --help / -h BEFORE parseArgs consumes them as flags.
  // Before this fix, parseArgs stored { flags: { help: true } } and the
  // `cmd === '--help'` branch was dead code; cmd defaulted to 'check' and
  // the full doctor ran, exiting 1/2 on warnings/failures. Broke the
  // canonical --help contract (exit 0 with usage text).
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'usage: cobolt-arch-doctor check [--dir <path>] [--json] [--pipeline greenfield|brownfield]\n',
    );
    return 0;
  }
  const parsed = parseArgs(argv);
  const cmd = parsed.positional[0] || 'check';
  if (cmd === 'check') return run(parsed.flags);
  process.stderr.write(`unknown subcommand: ${cmd}\n`);
  return 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  REQUIRED_TOOLS,
  REQUIRED_SCHEMAS,
  REQUIRED_AGENTS,
  REQUIRED_HOOKS,
  KILL_SWITCH_ENVS,
  checkToolPresence,
  checkSchemaPresence,
  checkAgentPresence,
  checkHookPresence,
  checkKillSwitches,
  checkIconCache,
  checkGraphAndManifest,
  checkRecentFailures,
  checkStateCoherence,
  severityFromChecks,
  run,
  main,
};
