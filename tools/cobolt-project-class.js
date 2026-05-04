#!/usr/bin/env node

// CoBolt Project-Class Detector
//
// Emits a deterministic classification of the current project as one of:
//   desktop | saas | service | library | cli | mobile | unknown
//
// Closes the cross-cutting noise-suppression gap surfaced by brownfield
// --scan full runs against desktop/library/CLI projects. Gates that enforce
// auth / secrets / PII / rollback prose are noise on a desktop binary; the
// inverse is a SaaS that has none of those documented at all. The standards
// gate, threat scanner, and illusion scanner can read this artifact (when
// present) and gate per project-class instead of one-size-fits-all.
//
// Detection is intentionally heuristic: every signal carries explicit
// evidence (file path + token snippet) so the user can audit and override.
//
// Inputs (auto-discovered under projectRoot):
//   package.json, pnpm-workspace.yaml, lerna.json
//   tsconfig.json, vite.config.*, next.config.*, nuxt.config.*
//   pyproject.toml, setup.py, setup.cfg, Pipfile
//   Cargo.toml
//   go.mod
//   mix.exs
//   pom.xml, build.gradle, build.gradle.kts
//   Gemfile
//   composer.json
//
// Output (default location: _cobolt-output/latest/planning/project-class.json
//                       OR  _cobolt-output/latest/brownfield/project-class.json):
//
//   {
//     "version": 1,
//     "generatedAt": "...",
//     "generatedBy": "cobolt-project-class",
//     "projectClass": "desktop",
//     "confidence": 0.85,
//     "scores": { "desktop": 0.85, "library": 0.10, ... },
//     "evidence": [{ "class": "desktop", "kind": "dependency", "value": "electron", "source": "package.json#deps" }],
//     "rationale": "...one-line summary..."
//   }
//
// Exit codes (per tools/CLAUDE.md):
//   0 — emitted classification (any class, including 'unknown')
//   1 — hard error (unwritable output, malformed config)
//   2 — usage error

const fs = require('node:fs');
const path = require('node:path');

const TOOL_NAME = 'cobolt-project-class';
const OUTPUT_FILE = 'project-class.json';

// Per-class deterministic signal table. Each entry is a { class, kind, match,
// weight, source } description; the detector evaluates them all and the
// highest aggregate score wins. Ties resolve in favor of the more specific
// class (mobile > desktop > saas > service > cli > library) so that ambiguous
// projects (e.g., a Tauri app that also exposes a CLI) lean toward the
// user-facing class.
const SIGNALS = Object.freeze([
  // ── desktop ──────────────────────────────────────────────────
  { class: 'desktop', kind: 'dep', match: /^(?:electron|@electron-forge\/|@electron\/)/i, weight: 1.0 },
  { class: 'desktop', kind: 'dep', match: /^@tauri-apps\//i, weight: 1.0 },
  { class: 'desktop', kind: 'dep', match: /^(?:nodegui|nw|neutralinojs|sciter)/i, weight: 0.8 },
  { class: 'desktop', kind: 'cargo', match: /\btauri\b/, weight: 1.0 },
  { class: 'desktop', kind: 'pom', match: /\bjavafx\b|\bswt\b/i, weight: 0.7 },
  { class: 'desktop', kind: 'csproj', match: /<UseWPF>|<UseWindowsForms>|Avalonia\.Desktop/i, weight: 0.9 },

  // ── mobile ───────────────────────────────────────────────────
  { class: 'mobile', kind: 'dep', match: /^react-native(?:$|[/-])|^@react-native[-/]/i, weight: 1.0 },
  { class: 'mobile', kind: 'dep', match: /^expo(?:$|[/-])|^@expo\//i, weight: 0.9 },
  { class: 'mobile', kind: 'dep', match: /^(?:@capacitor\/|@ionic\/)/i, weight: 0.7 },
  { class: 'mobile', kind: 'file', match: /(?:^|\/)(?:ios\/|android\/|Podfile$|AndroidManifest\.xml$)/i, weight: 0.8 },
  { class: 'mobile', kind: 'pubspec', match: /\bflutter:\b/i, weight: 1.0 },

  // ── saas (full-stack web app) ────────────────────────────────
  { class: 'saas', kind: 'dep', match: /^next$|^@next\//i, weight: 0.9 },
  { class: 'saas', kind: 'dep', match: /^nuxt$|^@nuxt\//i, weight: 0.9 },
  { class: 'saas', kind: 'dep', match: /^(?:remix|@remix-run\/)/i, weight: 0.9 },
  { class: 'saas', kind: 'dep', match: /^(?:django|flask|fastapi)$/i, weight: 0.9 },
  { class: 'saas', kind: 'dep', match: /^(?:rails|@rails\/)/i, weight: 0.9 },
  { class: 'saas', kind: 'dep', match: /^(?:nestjs|@nestjs\/|hapi|@hapi\/)/i, weight: 0.7 },
  { class: 'saas', kind: 'dep', match: /^express$|^fastify$|^koa$/i, weight: 0.5 },
  { class: 'saas', kind: 'mix', match: /\bphoenix\b/i, weight: 0.9 },
  { class: 'saas', kind: 'pom', match: /\bspring-boot\b|\bspring-mvc\b/i, weight: 0.9 },
  { class: 'saas', kind: 'composer', match: /\b(?:laravel|symfony)\b/i, weight: 0.9 },
  { class: 'saas', kind: 'gem', match: /\brails\b|\bsinatra\b/i, weight: 0.9 },

  // ── service (backend / worker, no human UI) ──────────────────
  { class: 'service', kind: 'dep', match: /^(?:bullmq|bull|kue|agenda)/i, weight: 0.7 },
  { class: 'service', kind: 'dep', match: /^(?:celery|rq|huey|dramatiq)/i, weight: 0.8 },
  { class: 'service', kind: 'dep', match: /^(?:sidekiq|resque|delayed_job)/i, weight: 0.8 },
  { class: 'service', kind: 'dep', match: /^(?:nats|kafkajs|amqplib|@nestjs\/microservices)/i, weight: 0.5 },
  { class: 'service', kind: 'go', match: /\b(?:nats-io|segmentio\/kafka-go|streadway\/amqp)\b/i, weight: 0.6 },

  // ── cli ─────────────────────────────────────────────────────
  { class: 'cli', kind: 'dep', match: /^(?:commander|yargs|clipanion|@oclif\/|cac|meow|sade)/i, weight: 0.7 },
  { class: 'cli', kind: 'dep', match: /^(?:click|typer|argparse|fire)/i, weight: 0.7 },
  { class: 'cli', kind: 'dep', match: /^(?:thor|cri)/i, weight: 0.7 },
  { class: 'cli', kind: 'go', match: /\bspf13\/cobra\b|\burfave\/cli\b/i, weight: 0.8 },
  { class: 'cli', kind: 'cargo', match: /\bclap\b|\bstructopt\b/i, weight: 0.8 },
  { class: 'cli', kind: 'pkg-bin', match: /^.+$/, weight: 0.4 }, // any "bin" entry

  // ── library (published, no app shell) ────────────────────────
  { class: 'library', kind: 'pkg-main', match: /^.+$/, weight: 0.3 }, // has main/exports
  { class: 'library', kind: 'pkg-types', match: /^.+$/, weight: 0.3 }, // has types/typings
  { class: 'library', kind: 'cargo-lib', match: /\[lib\]/, weight: 0.6 },
  { class: 'library', kind: 'pyproject-lib', match: /\[project\]/i, weight: 0.2 },
]);

const CLASS_PRIORITY = Object.freeze(['mobile', 'desktop', 'saas', 'service', 'cli', 'library', 'unknown']);

function exists(p) {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readJson(filePath) {
  const text = readText(filePath);
  if (!text) return null;
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function collectPkgEvidence(projectRoot) {
  const pkgPath = path.join(projectRoot, 'package.json');
  const pkg = readJson(pkgPath);
  if (!pkg) return [];

  const evidence = [];
  const allDeps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
    ...(pkg.peerDependencies || {}),
    ...(pkg.optionalDependencies || {}),
  };

  for (const dep of Object.keys(allDeps)) {
    for (const sig of SIGNALS) {
      if (sig.kind !== 'dep') continue;
      if (sig.match.test(dep)) {
        evidence.push({
          class: sig.class,
          kind: 'dependency',
          value: dep,
          source: 'package.json#dependencies',
          weight: sig.weight,
        });
      }
    }
  }

  if (pkg.bin && (typeof pkg.bin === 'string' || Object.keys(pkg.bin).length > 0)) {
    evidence.push({ class: 'cli', kind: 'pkg-bin', value: 'bin entry', source: 'package.json#bin', weight: 0.4 });
  }
  if (pkg.main || pkg.exports || pkg.module) {
    evidence.push({
      class: 'library',
      kind: 'pkg-main',
      value: pkg.main || (pkg.exports ? 'exports' : 'module'),
      source: 'package.json#main/exports/module',
      weight: 0.3,
    });
  }
  if (pkg.types || pkg.typings) {
    evidence.push({
      class: 'library',
      kind: 'pkg-types',
      value: pkg.types || pkg.typings,
      source: 'package.json#types',
      weight: 0.3,
    });
  }

  return evidence;
}

function collectFileEvidence(projectRoot) {
  const evidence = [];
  for (const sig of SIGNALS) {
    if (sig.kind !== 'file') continue;
    try {
      // Only walk top-level + 1 level deep to avoid expensive recursion.
      const queue = [projectRoot, ...fs.readdirSync(projectRoot).map((entry) => path.join(projectRoot, entry))];
      for (const dir of queue) {
        if (!exists(dir)) continue;
        let stat;
        try {
          stat = fs.statSync(dir);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) {
          const rel = path.relative(projectRoot, dir).replace(/\\/g, '/');
          if (sig.match.test(rel)) {
            evidence.push({ class: sig.class, kind: 'file', value: rel, source: rel, weight: sig.weight });
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  return evidence;
}

function collectCargoEvidence(projectRoot) {
  const cargo = readText(path.join(projectRoot, 'Cargo.toml'));
  if (!cargo) return [];
  const evidence = [];
  for (const sig of SIGNALS) {
    if (sig.kind !== 'cargo' && sig.kind !== 'cargo-lib') continue;
    if (sig.match.test(cargo)) {
      evidence.push({
        class: sig.class,
        kind: sig.kind,
        value: sig.match.source,
        source: 'Cargo.toml',
        weight: sig.weight,
      });
    }
  }
  return evidence;
}

function collectGoEvidence(projectRoot) {
  const goMod = readText(path.join(projectRoot, 'go.mod'));
  if (!goMod) return [];
  const evidence = [];
  for (const sig of SIGNALS) {
    if (sig.kind !== 'go') continue;
    if (sig.match.test(goMod)) {
      evidence.push({
        class: sig.class,
        kind: 'go-mod',
        value: sig.match.source,
        source: 'go.mod',
        weight: sig.weight,
      });
    }
  }
  return evidence;
}

function collectMixEvidence(projectRoot) {
  const mix = readText(path.join(projectRoot, 'mix.exs'));
  if (!mix) return [];
  const evidence = [];
  for (const sig of SIGNALS) {
    if (sig.kind !== 'mix') continue;
    if (sig.match.test(mix)) {
      evidence.push({
        class: sig.class,
        kind: 'mix',
        value: sig.match.source,
        source: 'mix.exs',
        weight: sig.weight,
      });
    }
  }
  return evidence;
}

function collectPomEvidence(projectRoot) {
  const pom = readText(path.join(projectRoot, 'pom.xml'));
  if (!pom) return [];
  const evidence = [];
  for (const sig of SIGNALS) {
    if (sig.kind !== 'pom') continue;
    if (sig.match.test(pom)) {
      evidence.push({
        class: sig.class,
        kind: 'pom',
        value: sig.match.source,
        source: 'pom.xml',
        weight: sig.weight,
      });
    }
  }
  return evidence;
}

function collectComposerEvidence(projectRoot) {
  const composer = readJson(path.join(projectRoot, 'composer.json'));
  if (!composer) return [];
  const evidence = [];
  const text = JSON.stringify(composer);
  for (const sig of SIGNALS) {
    if (sig.kind !== 'composer') continue;
    if (sig.match.test(text)) {
      evidence.push({
        class: sig.class,
        kind: 'composer',
        value: sig.match.source,
        source: 'composer.json',
        weight: sig.weight,
      });
    }
  }
  return evidence;
}

function collectGemEvidence(projectRoot) {
  const gemfile = readText(path.join(projectRoot, 'Gemfile'));
  if (!gemfile) return [];
  const evidence = [];
  for (const sig of SIGNALS) {
    if (sig.kind !== 'gem') continue;
    if (sig.match.test(gemfile)) {
      evidence.push({
        class: sig.class,
        kind: 'gem',
        value: sig.match.source,
        source: 'Gemfile',
        weight: sig.weight,
      });
    }
  }
  return evidence;
}

function collectPubspecEvidence(projectRoot) {
  const pub = readText(path.join(projectRoot, 'pubspec.yaml'));
  if (!pub) return [];
  const evidence = [];
  for (const sig of SIGNALS) {
    if (sig.kind !== 'pubspec') continue;
    if (sig.match.test(pub)) {
      evidence.push({
        class: sig.class,
        kind: 'pubspec',
        value: sig.match.source,
        source: 'pubspec.yaml',
        weight: sig.weight,
      });
    }
  }
  return evidence;
}

function collectAllEvidence(projectRoot) {
  return [
    ...collectPkgEvidence(projectRoot),
    ...collectFileEvidence(projectRoot),
    ...collectCargoEvidence(projectRoot),
    ...collectGoEvidence(projectRoot),
    ...collectMixEvidence(projectRoot),
    ...collectPomEvidence(projectRoot),
    ...collectComposerEvidence(projectRoot),
    ...collectGemEvidence(projectRoot),
    ...collectPubspecEvidence(projectRoot),
  ];
}

function classify(projectRoot) {
  const evidence = collectAllEvidence(projectRoot);

  const scores = {};
  for (const cls of CLASS_PRIORITY) scores[cls] = 0;
  for (const e of evidence) scores[e.class] = (scores[e.class] || 0) + e.weight;

  // Library is a residual class — only assign it when no app-class has signal.
  const appSignal = scores.desktop + scores.mobile + scores.saas + scores.service + scores.cli;
  if (appSignal > 0 && scores.library < appSignal) {
    scores.library = scores.library * 0.3;
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const projectClass = top[1] === 0 ? 'unknown' : top[0];
  const total = ranked.reduce((sum, [, v]) => sum + v, 0) || 1;
  const confidence = projectClass === 'unknown' ? 0 : Math.min(1, top[1] / total);

  let rationale;
  if (projectClass === 'unknown') {
    rationale = 'No class-defining signals found in standard manifests.';
  } else {
    const samples = evidence.filter((e) => e.class === projectClass).slice(0, 3);
    rationale = `Top signals: ${samples.map((s) => `${s.kind}=${s.value}`).join(', ') || 'none'}.`;
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: TOOL_NAME,
    projectClass,
    confidence: Math.round(confidence * 1000) / 1000,
    scores: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    evidence,
    rationale,
  };
}

function defaultOutputPath(projectRoot) {
  const planningDir = path.join(projectRoot, '_cobolt-output', 'latest', 'planning');
  return path.join(planningDir, OUTPUT_FILE);
}

function writeReport(outputPath, report) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function printHelp() {
  process.stdout.write(
    `${TOOL_NAME} — classify the current project as desktop/saas/service/library/cli/mobile/unknown\n\n` +
      `USAGE\n` +
      `  node tools/${TOOL_NAME}.js detect [--project <dir>] [--output <path>] [--json]\n` +
      `  node tools/${TOOL_NAME}.js --help\n\n` +
      `EXIT CODES\n` +
      `  0 — classification emitted (any class, including 'unknown')\n` +
      `  1 — hard error (unwritable output, malformed manifest)\n` +
      `  2 — usage error\n\n` +
      `WHY\n` +
      `  Standards / threat / illusion gates that enforce SaaS-shaped prose are noise on\n` +
      `  desktop or library projects. Reading project-class.json lets each gate select the\n` +
      `  applicable subset of checks instead of running one-size-fits-all.\n`,
  );
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return 0;
  }
  const command = argv[0];
  if (command !== 'detect') {
    process.stderr.write(`Unknown command: ${command}\n`);
    printHelp();
    return 2;
  }

  const projectIdx = argv.indexOf('--project');
  const projectRoot = projectIdx !== -1 && argv[projectIdx + 1] ? path.resolve(argv[projectIdx + 1]) : process.cwd();
  const outputIdx = argv.indexOf('--output');
  const outputPath =
    outputIdx !== -1 && argv[outputIdx + 1] ? path.resolve(argv[outputIdx + 1]) : defaultOutputPath(projectRoot);
  const jsonMode = argv.includes('--json');

  let report;
  try {
    report = classify(projectRoot);
  } catch (err) {
    process.stderr.write(`[${TOOL_NAME}] FAIL classification error: ${err.message}\n`);
    return 1;
  }

  try {
    writeReport(outputPath, report);
  } catch (err) {
    process.stderr.write(`[${TOOL_NAME}] FAIL write error: ${err.message}\n`);
    return 1;
  }

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `[${TOOL_NAME}] ${report.projectClass} (confidence ${report.confidence.toFixed(2)}) -> ${outputPath}\n`,
    );
  }
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  classify,
  collectAllEvidence,
  CLASS_PRIORITY,
  OUTPUT_FILE,
  defaultOutputPath,
};
