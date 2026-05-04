#!/usr/bin/env node

// CoBolt Observability Check
//
// Verifies source code has the four observability primitives per service:
//   1. Structured logging (not just console.log / IO.puts)
//   2. Metric emission (Prometheus/StatsD/OpenTelemetry)
//   3. Trace spans (OpenTelemetry/Honeycomb/Datadog)
//   4. Error classification (typed errors or error class hierarchies)
//
// Pattern-based; not a semantic parser. False negatives possible for novel
// observability stacks. If a project uses something we don't know, add the
// pattern to the appropriate category or set COBOLT_OBSERVABILITY_PATTERNS.
//
// Usage:
//   node tools/cobolt-observability-check.js scan [--json]
//   node tools/cobolt-observability-check.js gate    # exit 1 if any category missing
//
// Writes _cobolt-output/latest/observability/check.json.

const fs = require('node:fs');
const path = require('node:path');

const CATEGORIES = [
  {
    id: 'STRUCTURED_LOG',
    name: 'Structured logging',
    patterns: [
      /\brequire\(['"]pino['"]\)/,
      /\brequire\(['"]winston['"]\)/,
      /\brequire\(['"]bunyan['"]\)/,
      /from\s+['"]pino['"]/,
      /from\s+['"]winston['"]/,
      /import\s+structlog\b/,
      /from\s+structlog/,
      /Logger\.info\(/,
      /Logger\.warn\(/,
      /Logger\.error\(/,
      /Logger\.debug\(/,
      /Logger\.metadata/,
      /log\.(info|warn|error|debug)\s*\(\s*\{/,
      /zap\.NewLogger|logrus\.|slog\.(Info|Warn|Error)/,
    ],
  },
  {
    id: 'METRICS',
    name: 'Metric emission',
    patterns: [
      /prom-client|prometheus_client|prometheus-api-client/,
      /statsd|hot-shots/,
      /@opentelemetry\/api-metrics|otel\.metrics/,
      /Counter\(|Histogram\(|Gauge\(/,
      /Telemetry\.execute/,
      /:telemetry\.execute|:telemetry_metrics/,
      /metric\.(Counter|Gauge|Histogram)/,
    ],
  },
  {
    id: 'TRACES',
    name: 'Distributed tracing',
    patterns: [
      /@opentelemetry\/(api|sdk|auto-instrumentations)/,
      /opentelemetry\.trace|trace\.SpanFromContext/,
      /honeycomb|Honeycomb/,
      /dd-trace|datadog/,
      /OpenTelemetry|Tracer\.span|tracer\.startSpan/,
      /:opentelemetry_api|OpenTelemetry\.Tracer/,
    ],
  },
  {
    id: 'ERROR_CLASS',
    name: 'Error classification',
    patterns: [
      /class\s+\w+Error\s+extends\s+Error/,
      /class\s+\w+Exception\s+extends/,
      /defexception\s+/,
      /defmodule\s+.+Error\s+do/,
      /@dataclass.*class\s+\w+Error/,
      /type\s+.+Error\s+=\s+(struct|enum|interface)/,
      /sentry|Sentry\.captureException|@sentry\//,
      /rollbar|Rollbar/,
      /bugsnag/i,
    ],
  },
];

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '_cobolt-output',
  'dist',
  'build',
  '.next',
  'coverage',
  '_build',
  'deps',
  '.venv',
  'venv',
  'target',
]);
const CODE_EXTS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.ex',
  '.exs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
]);

function walk(dir, out = [], depth = 0) {
  if (depth > 12) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, depth + 1);
    else if (e.isFile() && CODE_EXTS.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

function scan() {
  const files = walk(process.cwd());
  const results = CATEGORIES.map((cat) => ({ ...cat, hits: [], satisfied: false }));

  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const cat of results) {
      if (cat.hits.length >= 3) continue;
      for (const pat of cat.patterns) {
        if (pat.test(text)) {
          cat.hits.push({ file: path.relative(process.cwd(), f), pattern: pat.source.slice(0, 60) });
          break;
        }
      }
    }
  }

  for (const cat of results) cat.satisfied = cat.hits.length > 0;
  const passed = results.every((c) => c.satisfied);

  return {
    passed,
    scannedFiles: files.length,
    categories: results.map((c) => ({ id: c.id, name: c.name, satisfied: c.satisfied, evidence: c.hits })),
    missing: results.filter((c) => !c.satisfied).map((c) => c.id),
    generatedAt: new Date().toISOString(),
  };
}

function writeReport(result) {
  const dir = path.join(process.cwd(), '_cobolt-output', 'latest', 'observability');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fp = path.join(dir, 'check.json');
  fs.writeFileSync(fp, JSON.stringify(result, null, 2));
  return fp;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const json = rest.includes('--json');
  const isHelp = cmd === '--help' || cmd === '-h' || cmd === 'help';
  switch (cmd) {
    case 'scan': {
      const r = scan();
      const fp = writeReport(r);
      if (json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`Observability check — ${r.passed ? 'PASS' : 'FAIL'} (${r.scannedFiles} files)`);
        for (const c of r.categories) {
          console.log(
            `  ${c.satisfied ? '✓' : '✗'} ${c.id.padEnd(18)} — ${c.name}${c.satisfied ? ` (${c.evidence[0].file})` : ''}`,
          );
        }
        if (!r.passed) console.log(`\nMissing: ${r.missing.join(', ')}`);
        console.log(`\nReport: ${fp}`);
      }
      return r.passed ? 0 : 1;
    }
    case 'gate': {
      const r = scan();
      writeReport(r);
      return r.passed ? 0 : 1;
    }
    default: {
      const usage = 'Usage: cobolt-observability-check.js {scan|gate} [--json]';
      if (isHelp || !cmd) {
        process.stdout.write(`${usage}\n`);
        return 0;
      }
      process.stderr.write(`${usage}\n`);
      return 1;
    }
  }
}

if (require.main === module) process.exit(main());

module.exports = { scan };
