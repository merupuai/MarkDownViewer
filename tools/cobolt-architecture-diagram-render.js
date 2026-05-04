#!/usr/bin/env node

// CoBolt Architecture Diagram renderer (v0.21.0). Optional SVG / PNG output.
//
// Best-effort: tries @mermaid-js/mermaid-cli (mmdc) via `npx` if available.
// If mmdc is absent the tool exits with a clean "skipped" verdict so the
// report tool can still bundle Mermaid source into the self-rendering HTML
// packet.
//
// Usage:
//   node tools/cobolt-architecture-diagram-render.js render --pipeline greenfield --format svg [--dir <project>]
//
// Exit codes:
//   0 — rendered or cleanly skipped (renderer unavailable, format != svg/png)
//   1 — manifest missing
//   2 — usage error

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { archRoot } = require('./cobolt-architecture-graph');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, content, { mode: 0o600 });
}

function npxCmd() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function hasMmdc() {
  try {
    execFileSync(npxCmd(), ['--no-install', 'mmdc', '--version'], {
      stdio: 'ignore',
      timeout: 10_000,
      shell: process.platform === 'win32',
    });
    return true;
  } catch {
    return false;
  }
}

function renderOne(input, output) {
  execFileSync(npxCmd(), ['--no-install', 'mmdc', '-i', input, '-o', output], {
    stdio: 'inherit',
    timeout: 90_000,
    shell: process.platform === 'win32',
  });
}

// D2 CLI detection + rendering ----------------------------------------------
//
// The `d2` binary is the fastest, cleanest path. If absent, we cleanly skip.
// Layout engine preference: ELK when the `--layout elk` invocation is
// supported (v0.6+); otherwise dagre (default).

function hasD2() {
  try {
    execFileSync('d2', ['--version'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function renderOneD2(input, output, { layout = 'elk', theme = null } = {}) {
  const args = ['--layout', layout];
  if (theme != null) args.push('--theme', String(theme));
  args.push(input, output);
  execFileSync('d2', args, { stdio: 'inherit', timeout: 90_000 });
}

// PlantUML rendering strategies (in order of preference):
//   1. `plantuml` on PATH (native CLI wrapper; some distros ship it)
//   2. `java -jar <PLANTUML_JAR>` where PLANTUML_JAR env var points to plantuml.jar
//   3. `npx --no-install node-plantuml` (if installed in the project)
// Any failure is a clean skip — the .puml source is always present either way.

function hasPlantUmlCli() {
  try {
    execFileSync('plantuml', ['-version'], { stdio: 'ignore', timeout: 10_000 });
    return { mode: 'plantuml-cli' };
  } catch {
    /* fall through */
  }
  const jar = process.env.PLANTUML_JAR;
  if (jar) {
    try {
      execFileSync('java', ['-jar', jar, '-version'], { stdio: 'ignore', timeout: 10_000 });
      return { mode: 'java-jar', jar };
    } catch {
      /* fall through */
    }
  }
  try {
    execFileSync(npxCmd(), ['--no-install', 'node-plantuml', '--version'], {
      stdio: 'ignore',
      timeout: 10_000,
      shell: process.platform === 'win32',
    });
    return { mode: 'node-plantuml' };
  } catch {
    /* fall through */
  }
  return null;
}

function renderOnePlantUml(input, outputDir, format, strategy) {
  // PlantUML writes rendered files to the same directory as the input by
  // default, named `<stem>.<ext>`. We normalize the flag.
  const ext = format === 'png' ? 'png' : 'svg';
  const targetFlag = ext === 'png' ? '-tpng' : '-tsvg';
  if (strategy.mode === 'plantuml-cli') {
    execFileSync('plantuml', [targetFlag, '-o', outputDir, input], {
      stdio: 'inherit',
      timeout: 90_000,
    });
  } else if (strategy.mode === 'java-jar') {
    execFileSync('java', ['-jar', strategy.jar, targetFlag, '-o', outputDir, input], {
      stdio: 'inherit',
      timeout: 90_000,
    });
  } else if (strategy.mode === 'node-plantuml') {
    execFileSync(npxCmd(), ['--no-install', 'node-plantuml', 'generate', input, '-o', outputDir, targetFlag], {
      stdio: 'inherit',
      timeout: 90_000,
      shell: process.platform === 'win32',
    });
  } else {
    throw new Error(`unsupported plantuml strategy: ${strategy.mode}`);
  }
}

function render({ projectRoot = process.cwd(), pipeline = 'greenfield', format = 'svg' } = {}) {
  if (format !== 'svg' && format !== 'png' && format !== 'all') {
    return { ok: true, rendered: 0, skipped: 0, reason: 'format does not request svg/png', results: [] };
  }
  const outDir = archRoot(projectRoot, pipeline);
  const manifestPath = path.join(outDir, 'diagram-manifest.json');
  const manifest = readJson(manifestPath);
  if (!manifest) return { ok: false, code: 1, error: `manifest missing at ${manifestPath}` };

  const mmdcAvailable = hasMmdc();
  const plantumlStrategy = hasPlantUmlCli();
  const d2Available = hasD2();

  const results = [];
  let rendered = 0;
  let skipped = 0;

  const formats = format === 'all' ? ['svg', 'png'] : [format];

  for (const d of manifest.diagrams || []) {
    // Render Mermaid when .mmd file is present.
    if (d.files?.mermaid && mmdcAvailable) {
      const mmdPath = path.isAbsolute(d.files.mermaid) ? d.files.mermaid : path.join(outDir, d.files.mermaid);
      for (const fmt of formats) {
        const renderedRel = path
          .join(
            path.dirname(d.files.mermaid).replace(/mermaid$/, 'rendered'),
            `${path.basename(d.files.mermaid, '.mmd')}.${fmt}`,
          )
          .replace(/\\/g, '/');
        const renderedAbs = path.join(outDir, renderedRel);
        try {
          renderOne(mmdPath, renderedAbs);
          d.files[fmt] = renderedRel;
          rendered += 1;
          results.push({ id: d.id, source: 'mermaid', format: fmt, status: 'ok' });
        } catch (err) {
          skipped += 1;
          results.push({
            id: d.id,
            source: 'mermaid',
            format: fmt,
            status: 'failed',
            reason: String(err.message || err).slice(0, 200),
          });
        }
      }
    } else if (d.files?.mermaid && !mmdcAvailable) {
      skipped += 1;
      results.push({ id: d.id, source: 'mermaid', format, status: 'skipped', reason: 'mmdc-unavailable' });
    }

    // Render PlantUML when .puml file is present.
    if (d.files?.plantuml && plantumlStrategy) {
      const pumlPath = path.isAbsolute(d.files.plantuml) ? d.files.plantuml : path.join(outDir, d.files.plantuml);
      const pumlOutDir = path.join(outDir, path.dirname(d.files.plantuml).replace(/plantuml$/, 'rendered'));
      for (const fmt of formats) {
        try {
          renderOnePlantUml(pumlPath, pumlOutDir, fmt, plantumlStrategy);
          const renderedRel = path
            .join(
              path.dirname(d.files.plantuml).replace(/plantuml$/, 'rendered'),
              `${path.basename(d.files.plantuml, '.puml')}.${fmt}`,
            )
            .replace(/\\/g, '/');
          d.files[`plantuml${fmt === 'svg' ? 'Svg' : 'Png'}`] = renderedRel;
          rendered += 1;
          results.push({ id: d.id, source: 'plantuml', format: fmt, status: 'ok' });
        } catch (err) {
          skipped += 1;
          results.push({
            id: d.id,
            source: 'plantuml',
            format: fmt,
            status: 'failed',
            reason: String(err.message || err).slice(0, 200),
          });
        }
      }
    } else if (d.files?.plantuml && !plantumlStrategy) {
      skipped += 1;
      results.push({
        id: d.id,
        source: 'plantuml',
        format,
        status: 'skipped',
        reason: 'plantuml-unavailable (install: plantuml CLI, set PLANTUML_JAR, or npm i node-plantuml)',
      });
    }

    // Render D2 when .d2 file is present.
    if (d.files?.d2 && d2Available) {
      const d2Path = path.isAbsolute(d.files.d2) ? d.files.d2 : path.join(outDir, d.files.d2);
      const d2OutDir = path.join(outDir, path.dirname(d.files.d2).replace(/d2$/, 'rendered'));
      // SVG from d2 only — PNG requires a specific d2 extension.
      for (const fmt of formats.filter((f) => f === 'svg')) {
        try {
          const renderedRel = path
            .join(path.dirname(d.files.d2).replace(/d2$/, 'rendered'), `${path.basename(d.files.d2, '.d2')}.${fmt}`)
            .replace(/\\/g, '/');
          fs.mkdirSync(d2OutDir, { recursive: true, mode: 0o700 });
          const renderedAbs = path.join(outDir, renderedRel);
          renderOneD2(d2Path, renderedAbs, { layout: 'elk', theme: themeForD2(manifest.theme) });
          d.files[`d2${fmt === 'svg' ? 'Svg' : 'Png'}`] = renderedRel;
          rendered += 1;
          results.push({ id: d.id, source: 'd2', format: fmt, status: 'ok' });
        } catch (err) {
          skipped += 1;
          results.push({
            id: d.id,
            source: 'd2',
            format: fmt,
            status: 'failed',
            reason: String(err.message || err).slice(0, 200),
          });
        }
      }
    } else if (d.files?.d2 && !d2Available) {
      skipped += 1;
      results.push({
        id: d.id,
        source: 'd2',
        format,
        status: 'skipped',
        reason: 'd2-cli-unavailable (install: https://d2lang.com/tour/install)',
      });
    }

    if (!d.files?.mermaid && !d.files?.plantuml && !d.files?.d2) {
      skipped += 1;
      results.push({ id: d.id, source: 'none', format, status: 'skipped', reason: 'no text-format source file' });
    }
  }

  // Persist updated manifest with new rendered paths
  writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const reason = rendered
    ? 'ok'
    : !mmdcAvailable && !plantumlStrategy && !d2Available
      ? 'all-renderers-unavailable'
      : 'all-skipped';
  return { ok: true, rendered, skipped, reason, results };
}

function themeForD2(manifestTheme) {
  // Map our theme names to the d2 `--theme` numeric IDs.
  // These match lib/cobolt-arch-themes.js d2Theme values.
  const map = {
    professional: 0,
    enterprise: 101,
    dark: 200,
    minimal: 8,
    brand: 0,
    'brand-fallback': 0,
  };
  const id = map[String(manifestTheme || 'professional').toLowerCase()];
  return Number.isInteger(id) ? id : 0;
}

function parseCliArgs(argv) {
  const out = { pipeline: 'greenfield', format: 'svg', dir: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pipeline') out.pipeline = argv[++i];
    else if (a === '--format') out.format = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--json') out.json = true;
  }
  return out;
}

// hasGraphviz / hasPlaywright detection — used by `doctor` subcommand only.
function hasGraphviz() {
  try {
    execFileSync('dot', ['-V'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function hasPlaywright() {
  try {
    require.resolve('playwright');
    return true;
  } catch {
    return false;
  }
}

// Doctor — diagnose missing renderer dependencies and print OS-specific
// install commands. Designed to be run by users when the render step reports
// `all-renderers-unavailable` (the most common cause of empty SVG/PNG output).
function doctor({ json = false } = {}) {
  const platform = process.platform; // 'win32' | 'darwin' | 'linux'
  const checks = [
    {
      name: 'mermaid-cli (mmdc)',
      ok: hasMmdc(),
      purpose: 'Renders .mmd → SVG/PNG',
      install: {
        win32: 'npm install -g @mermaid-js/mermaid-cli',
        darwin: 'npm install -g @mermaid-js/mermaid-cli',
        linux: 'npm install -g @mermaid-js/mermaid-cli',
      },
    },
    {
      name: 'plantuml',
      ok: Boolean(hasPlantUmlCli()),
      purpose: 'Renders .puml → SVG/PNG (requires Java)',
      install: {
        win32:
          'choco install plantuml  # OR: npm install -g node-plantuml  # OR: download plantuml.jar and set PLANTUML_JAR',
        darwin: 'brew install plantuml  # (also installs Java if needed)',
        linux: 'sudo apt-get install plantuml  # OR: download plantuml.jar and set PLANTUML_JAR',
      },
    },
    {
      name: 'd2',
      ok: hasD2(),
      purpose: 'Renders .d2 → SVG (with ELK layout)',
      install: {
        win32: 'winget install terrastruct.d2  # OR: scoop install d2',
        darwin: 'brew install d2',
        linux: 'curl -fsSL https://d2lang.com/install.sh | sh -s --',
      },
    },
    {
      name: 'graphviz (dot)',
      ok: hasGraphviz(),
      purpose: 'Used by the graph layout helpers (lib/cobolt-arch-graphviz.js)',
      install: {
        win32: 'choco install graphviz  # OR: winget install Graphviz.Graphviz',
        darwin: 'brew install graphviz',
        linux: 'sudo apt-get install graphviz',
      },
    },
    {
      name: 'playwright',
      ok: hasPlaywright(),
      purpose: 'PDF rendering of the architecture-packet HTML report',
      install: {
        win32: 'npm install playwright && npx playwright install chromium',
        darwin: 'npm install playwright && npx playwright install chromium',
        linux: 'npm install playwright && npx playwright install --with-deps chromium',
      },
    },
  ];
  const okCount = checks.filter((c) => c.ok).length;
  const result = {
    platform,
    okCount,
    totalCount: checks.length,
    allRenderersAvailable: checks.slice(0, 3).every((c) => c.ok), // mmdc + plantuml + d2
    checks: checks.map((c) => ({
      name: c.name,
      ok: c.ok,
      purpose: c.purpose,
      install: c.install[platform] || c.install.linux,
    })),
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `\n[architecture-render:doctor] ${okCount}/${checks.length} renderers available on ${platform}\n\n`,
    );
    for (const c of result.checks) {
      const mark = c.ok ? '[OK]' : '[--]';
      process.stdout.write(`  ${mark} ${c.name.padEnd(22)} — ${c.purpose}\n`);
      if (!c.ok) process.stdout.write(`        install: ${c.install}\n`);
    }
    process.stdout.write(
      result.allRenderersAvailable
        ? '\nAll core renderers (mmdc + plantuml + d2) available — SVG/PNG output should work.\n\n'
        : '\nMissing renderers will be skipped at render time. Install above to enable visual outputs.\n\n',
    );
  }
  return result;
}

function cli(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'doctor') {
    const opts = parseCliArgs(rest);
    const res = doctor({ json: opts.json });
    process.exit(res.allRenderersAvailable ? 0 : 1);
  }
  if (cmd !== 'render') {
    process.stderr.write(
      'usage: cobolt-architecture-diagram-render <render|doctor> [options]\n' +
        '  render --pipeline greenfield|brownfield [--format svg|png|all] [--dir <path>] [--json]\n' +
        '  doctor [--json]              # detect missing renderer dependencies, print install commands\n',
    );
    process.exit(2);
  }
  const opts = parseCliArgs(rest);
  const res = render({ projectRoot: opts.dir || process.cwd(), pipeline: opts.pipeline, format: opts.format });
  if (opts.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  else
    process.stdout.write(
      `[architecture-render] rendered=${res.rendered} skipped=${res.skipped} reason=${res.reason}\n`,
    );
  process.exit(res.code || 0);
}

if (require.main === module) cli(process.argv.slice(2));

module.exports = { render, doctor, hasMmdc, hasPlantUmlCli, hasD2, hasGraphviz, hasPlaywright, themeForD2 };
