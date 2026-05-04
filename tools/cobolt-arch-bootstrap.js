#!/usr/bin/env node

// CoBolt Architecture Bootstrap (v0.22.3+).
//
// One-shot provisioning for the architecture-diagrams pipeline. Called by
// cobolt-init at the end of the bootstrap chain so new projects ship with:
//   1. The icon cache pre-warmed (AWS / Azure / GCP / Postgres / Redis /
//      FastAPI / Stripe / OpenTelemetry / and every slug detected from the
//      project's tech stack — produces real Iconify SVGs on disk).
//   2. The optional render CLIs detected and reported (`mmdc` for Mermaid,
//      `d2` for D2, `plantuml` / `PLANTUML_JAR` / `node-plantuml` for
//      PlantUML / C4-PlantUML). When `--install-renderers` is passed AND a
//      package.json with npm is available, attempts a best-effort
//      `npm install --save-dev @mermaid-js/mermaid-cli node-plantuml`.
//   3. A bootstrap report at `_cobolt-output/latest/init/arch-bootstrap.json`
//      capturing every step, every degraded path, and remediation hints.
//
// Non-disruption contract:
//   - READ-ONLY by default. Touches only `_cobolt-output/latest/architecture-
//     diagrams/icon-cache/` (icon SVGs + manifest) and the report file.
//   - `--install-renderers` is the ONLY flag that mutates the project
//     (devDependencies + lockfile). Even then, the install runs through
//     `npm install --save-dev` so the project's own resolution applies and
//     no global state changes.
//   - Every failure degrades to a structured warning. Init never blocks on
//     missing renderers or unreachable icon CDNs.
//
// Usage:
//   node tools/cobolt-arch-bootstrap.js               # detect + warm cache + report
//   node tools/cobolt-arch-bootstrap.js --install-renderers
//   node tools/cobolt-arch-bootstrap.js --no-icons    # skip cache warm
//   node tools/cobolt-arch-bootstrap.js --json        # machine-readable verdict
//   node tools/cobolt-arch-bootstrap.js --dir <path>  # alternate project root
//
// Exit codes:
//   0 — bootstrap completed (degraded paths still exit 0; check the report)
//   2 — usage error

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

function npxCmd() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function npmCliPath() {
  return path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

function npmInvocation(args) {
  if (process.platform === 'win32') {
    return { command: process.execPath, args: [npmCliPath(), ...args] };
  }
  return { command: 'npm', args };
}

// Detect a CLI binary by attempting `<bin> <flag>` with a short timeout.
// Returns { available: bool, version?: string, reason?: string }.
function detectBinary(bin, args, { extractVersion = (out) => out.split('\n')[0]?.trim() || null } = {}) {
  try {
    const out = execFileSync(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8000,
      encoding: 'utf8',
    });
    return { available: true, version: extractVersion(out) };
  } catch (err) {
    return { available: false, reason: err.code || err.message?.slice(0, 200) || 'unknown' };
  }
}

// Mermaid CLI is installed via npm; we look up `npx --no-install mmdc --version`.
function detectMermaidCli(projectRoot) {
  try {
    const out = execFileSync(npxCmd(), ['--no-install', 'mmdc', '--version'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8000,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    return { available: true, version: out.trim().split('\n')[0] };
  } catch (err) {
    return { available: false, reason: err.code || 'mmdc-not-installed' };
  }
}

function detectPlantUml(projectRoot) {
  // 1. Native CLI
  const cli = detectBinary('plantuml', ['-version']);
  if (cli.available) return { available: true, mode: 'plantuml-cli', version: cli.version };
  // 2. PLANTUML_JAR env var
  const jar = process.env.PLANTUML_JAR;
  if (jar && fs.existsSync(jar)) {
    const java = detectBinary('java', ['-jar', jar, '-version']);
    if (java.available) return { available: true, mode: 'java-jar', jar, version: java.version };
  }
  // 3. node-plantuml via npx
  try {
    execFileSync(npxCmd(), ['--no-install', 'node-plantuml', '--version'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8000,
      shell: process.platform === 'win32',
    });
    return { available: true, mode: 'node-plantuml' };
  } catch {
    /* fall through */
  }
  return {
    available: false,
    reason: 'no-plantuml-strategy-available',
    remediation:
      'Install one of: (a) `plantuml` CLI on PATH, (b) export PLANTUML_JAR=/path/to/plantuml.jar, (c) `npm i -D node-plantuml`',
  };
}

function detectD2() {
  return detectBinary('d2', ['--version'], {
    extractVersion: (out) => out.trim().split('\n')[0],
  });
}

// `npm install --save-dev <pkgs>` with a fail-soft wrapper. Only invoked
// when --install-renderers is passed AND package.json exists.
function attemptNpmInstall(projectRoot, packages) {
  const pkgJsonPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    return {
      attempted: false,
      reason: 'no-package-json',
      remediation: 'Initialize package.json first (npm init -y) or skip --install-renderers',
    };
  }
  const args = ['install', '--save-dev', '--no-audit', '--no-fund', '--silent', ...packages];
  const invocation = npmInvocation(args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000, // 5 min cap
  });
  if (result.error) {
    return { attempted: true, ok: false, reason: result.error.message?.slice(0, 200) || 'spawn-error' };
  }
  if (result.status !== 0) {
    return {
      attempted: true,
      ok: false,
      exitCode: result.status,
      stderr: (result.stderr || '').trim().slice(0, 500),
    };
  }
  return { attempted: true, ok: true, packages };
}

// Pre-warm the icon cache. We DO NOT pass an explicit slug list — the
// icon-search tool runs `suggestSlugsFromStack(projectRoot)` when --slugs is
// omitted, which derives slugs from the project's actual tech stack.
function warmIconCache(projectRoot, budget) {
  const tool = path.join(__dirname, 'cobolt-arch-icon-search.js');
  if (!fs.existsSync(tool)) return { ok: false, reason: 'icon-search-tool-missing' };

  const args = ['ensure', '--dir', projectRoot, '--budget', String(budget), '--json'];
  const result = spawnSync(process.execPath, [tool, ...args], {
    cwd: projectRoot,
    env: { ...process.env, COBOLT_ARCH_ICON_FETCH_CONTEXT: '1' },
    encoding: 'utf8',
    timeout: 90 * 1000,
  });
  if (result.error) return { ok: false, reason: result.error.message?.slice(0, 200) || 'spawn-error' };
  let summary = null;
  try {
    summary = JSON.parse(result.stdout || '{}');
  } catch {
    summary = null;
  }
  return {
    ok: result.status === 0,
    exitCode: result.status,
    total: summary?.total ?? 0,
    resolved: summary?.resolved ?? 0,
    note: summary?.note || (result.stderr || '').trim().slice(0, 200) || null,
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeReport(projectRoot, report) {
  const dir = path.join(projectRoot, '_cobolt-output', 'latest', 'init');
  ensureDir(dir);
  const file = path.join(dir, 'arch-bootstrap.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  return file;
}

function bootstrap({ projectRoot, installRenderers = false, skipIcons = false, iconBudget = 30 } = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  const report = {
    schemaVersion: 'cobolt-arch-bootstrap/v1',
    generatedAt: new Date().toISOString(),
    projectRoot: root,
    options: { installRenderers, skipIcons, iconBudget },
    renderers: {},
    icons: null,
    install: null,
    warnings: [],
    summary: null,
  };

  // Phase 1 — detect renderers BEFORE any install (lets us see what was
  // already there).
  report.renderers.mermaidCliBefore = detectMermaidCli(root);
  report.renderers.plantUmlBefore = detectPlantUml(root);
  report.renderers.d2 = detectD2();
  if (!report.renderers.d2.available) {
    report.warnings.push({
      area: 'd2',
      message:
        'The `d2` binary is a Go executable and cannot be installed via npm. Install from https://d2lang.com/tour/install or skip D2 rendering. The .d2 source files will still be generated and copy-pasteable into play.d2lang.com.',
    });
  }

  // Phase 2 — optional npm install for Mermaid + PlantUML.
  if (installRenderers) {
    const pkgs = [];
    if (!report.renderers.mermaidCliBefore.available) pkgs.push('@mermaid-js/mermaid-cli');
    if (!report.renderers.plantUmlBefore.available) pkgs.push('node-plantuml');
    if (pkgs.length === 0) {
      report.install = { attempted: false, reason: 'all-renderers-already-available' };
    } else {
      report.install = attemptNpmInstall(root, pkgs);
      // Re-detect after install so the report reflects the post-state.
      report.renderers.mermaidCliAfter = detectMermaidCli(root);
      report.renderers.plantUmlAfter = detectPlantUml(root);
    }
  } else {
    report.install = { attempted: false, reason: 'install-flag-not-set' };
  }

  // Phase 3 — warm the icon cache. Independent of renderer state.
  if (!skipIcons) {
    report.icons = warmIconCache(root, iconBudget);
    if (!report.icons?.ok) {
      report.warnings.push({
        area: 'icons',
        message:
          report.icons?.note ||
          'Icon cache could not be warmed. Diagrams will use the generic shape fallback. Verify network access to api.iconify.design / cdn.simpleicons.org / cdn.jsdelivr.net or set COBOLT_ARCH_ICON_FETCH=bundled-only to suppress fetch attempts.',
      });
    }
  } else {
    report.icons = { ok: true, skipped: 'flag-set' };
  }

  // Phase 4 — summary line for human-readable output.
  const mermaidOk = (report.renderers.mermaidCliAfter || report.renderers.mermaidCliBefore)?.available;
  const plantumlOk = (report.renderers.plantUmlAfter || report.renderers.plantUmlBefore)?.available;
  const d2Ok = report.renderers.d2.available;
  const iconsOk = !!report.icons?.ok;
  const iconCount = report.icons?.resolved ?? 0;
  report.summary = {
    mermaid: mermaidOk ? 'ready' : 'sources-only',
    plantuml: plantumlOk ? 'ready' : 'sources-only',
    d2: d2Ok ? 'ready' : 'sources-only',
    icons: iconsOk ? `${iconCount} cached` : 'no cache',
    htmlPacketPolicy:
      'svg-iconic always renders; mermaid renders client-side via Mermaid.js inlined in the packet; plantuml/d2 sources are collapsible',
  };

  const reportPath = writeReport(root, report);
  return { report, reportPath };
}

function parseArgs(argv) {
  const out = { dir: null, installRenderers: false, skipIcons: false, iconBudget: 30, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--install-renderers') out.installRenderers = true;
    else if (a === '--no-icons') out.skipIcons = true;
    else if (a === '--icon-budget') out.iconBudget = parseInt(argv[++i], 10);
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'usage: cobolt-arch-bootstrap [--install-renderers] [--no-icons] [--icon-budget N] [--dir <path>] [--json]\n',
      );
      process.exit(0);
    }
  }
  return out;
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  const { report, reportPath } = bootstrap({
    projectRoot: opts.dir || process.cwd(),
    installRenderers: opts.installRenderers,
    skipIcons: opts.skipIcons,
    iconBudget: opts.iconBudget,
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const s = report.summary;
    process.stdout.write(`[arch-bootstrap] mermaid=${s.mermaid} plantuml=${s.plantuml} d2=${s.d2} icons=${s.icons}\n`);
    if (report.warnings.length) {
      for (const w of report.warnings) {
        process.stdout.write(`[arch-bootstrap] warn (${w.area}): ${w.message.slice(0, 200)}\n`);
      }
    }
    process.stdout.write(`[arch-bootstrap] report: ${reportPath}\n`);
  }
  process.exit(0);
}

module.exports = { bootstrap, detectMermaidCli, detectPlantUml, detectD2, attemptNpmInstall };
