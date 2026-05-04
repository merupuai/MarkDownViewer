#!/usr/bin/env node

// CoBolt Architecture Diagram Validator (v0.21.0).
//
// Validates:
//   - architecture-graph.json shape
//   - per-diagram spec shape
//   - diagram-manifest.json shape
//   - Mermaid files are non-empty and do not contain TODO / FIXME / XXX / PLACEHOLDER
//   - every graph node has evidence refs OR explicit inferred/weak/unknown confidence
//
// Tier 3 by default (advisory). Tier 2 when `--gate` is passed (callers interpret
// the non-zero exit as milestone-grade degrade instead of hard block).
//
// Usage:
//   node tools/cobolt-architecture-diagram-validate.js check --pipeline greenfield [--gate] [--dir <project>]
//
// Exit codes:
//   0 — all checks pass (or advisory-only mode)
//   1 — required artifacts missing (no graph / no manifest)
//   2 — usage error
//   4 — violations found AND --gate was passed (Tier 2 outcome)

const fs = require('node:fs');
const path = require('node:path');
const { graphPath, archRoot, validateGraphShape } = require('./cobolt-architecture-graph');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeFile(p, content) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content, { mode: 0o600 });
}

function resolveArtifactPath(outDir, filePath) {
  if (!filePath) return null;
  return path.isAbsolute(filePath) ? filePath : path.join(outDir, filePath);
}

function validateSpecShape(spec) {
  const errs = [];
  for (const req of ['id', 'title', 'taxonomyArea', 'profile', 'state', 'purpose', 'nodes', 'edges', 'confidence']) {
    if (!(req in spec)) errs.push(`${spec.id || '<anon>'} missing field: ${req}`);
  }
  if (spec.nodes && !Array.isArray(spec.nodes)) errs.push(`${spec.id} nodes not array`);
  if (spec.edges && !Array.isArray(spec.edges)) errs.push(`${spec.id} edges not array`);
  if (spec.nodes && Array.isArray(spec.nodes)) {
    for (const n of spec.nodes) {
      if (!n.id || !n.label) errs.push(`${spec.id} node missing id/label: ${JSON.stringify(n).slice(0, 100)}`);
    }
  }
  return errs;
}

function validateManifestShape(manifest) {
  const errs = [];
  for (const req of ['version', 'generatedAt', 'pipeline', 'profile', 'state', 'diagrams']) {
    if (!(req in manifest)) errs.push(`manifest missing field: ${req}`);
  }
  if (manifest.diagrams && !Array.isArray(manifest.diagrams)) errs.push('manifest.diagrams not array');
  return errs;
}

const PLACEHOLDER_RX = /\b(TODO|FIXME|XXX|PLACEHOLDER|LOREM IPSUM)\b/i;

function validateMermaidSyntax(content) {
  const errs = [];
  if (!content?.trim()) return ['mermaid file is empty'];
  if (PLACEHOLDER_RX.test(content)) errs.push('mermaid contains placeholder token (TODO/FIXME/XXX/PLACEHOLDER)');
  // Basic syntax sanity: must declare a diagram type on one of the first lines
  const first = content
    .split('\n')
    .slice(0, 10)
    .some((l) =>
      /^\s*(flowchart|graph|erDiagram|classDiagram|sequenceDiagram|stateDiagram|gantt|journey|timeline|mindmap|%%\{)/i.test(
        l,
      ),
    );
  if (!first) errs.push('mermaid missing diagram declaration in first 10 lines');
  return errs;
}

function validatePlantUmlSyntax(content) {
  const errs = [];
  if (!content?.trim()) return ['plantuml file is empty'];
  if (PLACEHOLDER_RX.test(content)) errs.push('plantuml contains placeholder token (TODO/FIXME/XXX/PLACEHOLDER)');
  if (!/^\s*@startuml\b/im.test(content)) errs.push('plantuml missing @startuml');
  if (!/^\s*@enduml\b/im.test(content)) errs.push('plantuml missing @enduml');
  return errs;
}

function validateSvgSyntax(content) {
  const errs = [];
  if (!content?.trim()) return ['svg file is empty'];
  if (PLACEHOLDER_RX.test(content)) errs.push('svg contains placeholder token (TODO/FIXME/XXX/PLACEHOLDER)');
  if (!/<svg\b/i.test(content)) errs.push('svg missing <svg> root element');
  if (!/<\/svg>/i.test(content)) errs.push('svg missing closing </svg>');
  return errs;
}

function validateEvidenceBacking(graph) {
  const errs = [];
  const ok = { ok: 0, inferred: 0, weak: 0, unknown: 0 };
  for (const n of graph.nodes || []) {
    const hasEvidence = Array.isArray(n.evidence) && n.evidence.length > 0;
    const explicit = ['inferred', 'weak', 'unknown'].includes(n.confidence);
    if (hasEvidence) ok.ok += 1;
    else if (explicit) ok[n.confidence] += 1;
    else {
      errs.push(`node ${n.id} claims confirmed but has no evidence refs`);
    }
  }
  return { errs, summary: ok };
}

function check({ projectRoot = process.cwd(), pipeline = 'greenfield', gate = false } = {}) {
  const outDir = archRoot(projectRoot, pipeline);
  const gp = graphPath(projectRoot, pipeline);
  const manifestPath = path.join(outDir, 'diagram-manifest.json');

  const graph = readJson(gp);
  const manifest = readJson(manifestPath);
  if (!graph || !manifest) {
    return { ok: false, code: 1, error: 'graph or manifest missing — run generate first', violations: [] };
  }

  const violations = [];
  for (const e of validateGraphShape(graph)) violations.push({ code: 'GRAPH_SCHEMA', message: e, severity: 'error' });

  for (const e of validateManifestShape(manifest))
    violations.push({ code: 'MANIFEST_SCHEMA', message: e, severity: 'error' });

  for (const d of manifest.diagrams || []) {
    if (!d.files?.spec) {
      if (d.status !== 'skipped' && d.status !== 'failed') {
        violations.push({
          code: 'DIAGRAM_FILES_MISSING',
          message: `${d.id} missing spec path`,
          diagramId: d.id,
          severity: 'error',
        });
      }
      continue;
    }
    const specPath = resolveArtifactPath(outDir, d.files.spec);

    const spec = readJson(specPath);
    if (!spec) {
      violations.push({
        code: 'SPEC_UNREADABLE',
        message: `${d.id} spec missing: ${specPath}`,
        diagramId: d.id,
        severity: 'error',
      });
    } else {
      for (const e of validateSpecShape(spec)) {
        violations.push({ code: 'SPEC_SCHEMA', message: e, diagramId: d.id, severity: 'error' });
      }
    }

    const sourceFiles = [];
    const addSource = (kind, filePath) => {
      const resolved = resolveArtifactPath(outDir, filePath);
      if (resolved) sourceFiles.push({ kind, path: resolved });
    };
    addSource('mermaid', d.files.mermaid);
    addSource('plantuml', d.files.plantuml);
    addSource('svg', d.files.svgIconic);
    addSource('svg', d.files.svg);
    addSource('svg', d.files.plantumlSvg);
    addSource('svg', d.files.d2Svg);
    addSource('png', d.files.png);
    addSource('png', d.files.plantumlPng);
    addSource('png', d.files.d2Png);

    if (!sourceFiles.length && d.status !== 'skipped' && d.status !== 'failed') {
      violations.push({
        code: 'DIAGRAM_SOURCE_MISSING',
        message: `${d.id} missing mermaid/plantuml/svg source path`,
        diagramId: d.id,
        severity: 'error',
      });
    }

    for (const source of sourceFiles) {
      if (source.kind === 'png') {
        try {
          const stat = fs.statSync(source.path);
          if (!stat.isFile() || stat.size === 0) throw new Error('empty png');
        } catch {
          violations.push({
            code: 'PNG_MISSING',
            message: `${d.id} png unreadable: ${source.path}`,
            diagramId: d.id,
            severity: 'error',
          });
        }
        continue;
      }
      const sourceContent = readText(source.path);
      if (!sourceContent) {
        violations.push({
          code: `${source.kind.toUpperCase()}_MISSING`,
          message: `${d.id} ${source.kind} unreadable: ${source.path}`,
          diagramId: d.id,
          severity: 'error',
        });
        continue;
      }
      const syntaxErrors =
        source.kind === 'plantuml'
          ? validatePlantUmlSyntax(sourceContent)
          : source.kind === 'svg'
            ? validateSvgSyntax(sourceContent)
            : validateMermaidSyntax(sourceContent);
      for (const e of syntaxErrors) {
        violations.push({
          code: `${source.kind.toUpperCase()}_SYNTAX`,
          message: `${d.id}: ${e}`,
          diagramId: d.id,
          severity: 'warning',
        });
      }
    }
  }

  const { errs: evidenceErrs, summary: confidenceSummary } = validateEvidenceBacking(graph);
  for (const e of evidenceErrs) violations.push({ code: 'EVIDENCE_BACKING', message: e, severity: 'warning' });

  // Degraded-graph signal: produced by the graph builder when fewer than 5
  // non-default nodes exist after every fallback. Diagrams will be near-empty
  // and stakeholder-unfit. Tier 2 — promotes to a hard fail under --gate.
  if (graph.degraded === true) {
    violations.push({
      code: 'GRAPH_UNDERSUPPLIED',
      message:
        graph.degradedReason ||
        'Graph contains too few real nodes to produce meaningful diagrams. Run the full brownfield/plan pipeline so documentation artifacts feed the graph.',
      severity: gate ? 'error' : 'warning',
    });
  }

  const schemaPass = !violations.some(
    (v) => v.code === 'GRAPH_SCHEMA' || v.code === 'SPEC_SCHEMA' || v.code === 'MANIFEST_SCHEMA',
  );
  const syntaxPass = !violations.some(
    (v) =>
      v.code === 'MERMAID_SYNTAX' ||
      v.code === 'MERMAID_MISSING' ||
      v.code === 'PLANTUML_SYNTAX' ||
      v.code === 'PLANTUML_MISSING' ||
      v.code === 'SVG_SYNTAX' ||
      v.code === 'SVG_MISSING' ||
      v.code === 'PNG_MISSING',
  );
  const evidencePass = !violations.some((v) => v.code === 'EVIDENCE_BACKING');

  // Persist gap report
  const gapReport = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    pipeline,
    profile: manifest.profile,
    state: manifest.state,
    gaps: (graph.gaps || []).map((g, i) => ({
      id: `GAP-${String(i + 1).padStart(3, '0')}`,
      area: g.area,
      reason: g.reason,
      severity: 'medium',
    })),
    unresolvedEvidence: [],
    confidenceSummary: {
      confirmed: confidenceSummary.ok,
      inferred: confidenceSummary.inferred,
      weak: confidenceSummary.weak,
      unknown: confidenceSummary.unknown,
    },
  };
  writeFile(path.join(outDir, 'gap-report.json'), JSON.stringify(gapReport, null, 2));

  const mdLines = [];
  mdLines.push('# Architecture Diagrams — Gap Report');
  mdLines.push('');
  mdLines.push(`Generated: ${gapReport.generatedAt}`);
  mdLines.push('');
  mdLines.push('## Evidence Confidence Summary');
  mdLines.push(`- confirmed: ${gapReport.confidenceSummary.confirmed}`);
  mdLines.push(`- inferred: ${gapReport.confidenceSummary.inferred}`);
  mdLines.push(`- weak: ${gapReport.confidenceSummary.weak}`);
  mdLines.push(`- unknown: ${gapReport.confidenceSummary.unknown}`);
  mdLines.push('');
  if (gapReport.gaps.length) {
    mdLines.push('## Gaps');
    for (const g of gapReport.gaps) mdLines.push(`- **${g.area}** — ${g.reason}`);
    mdLines.push('');
  }
  if (violations.length) {
    mdLines.push('## Validation Violations');
    for (const v of violations) mdLines.push(`- (${v.code}${v.diagramId ? ` / ${v.diagramId}` : ''}) ${v.message}`);
    mdLines.push('');
  }
  writeFile(path.join(outDir, 'gap-report.md'), mdLines.join('\n'));

  // Update manifest with validation block (non-destructive — only validation fields)
  manifest.validation = {
    schemaPass,
    syntaxPass,
    evidencePass,
    tier: gate ? 2 : 3,
    violations,
  };
  writeFile(path.join(outDir, 'diagram-manifest.json'), JSON.stringify(manifest, null, 2));

  const hasErrors = violations.some((v) => v.severity === 'error');
  return {
    ok: !hasErrors,
    code: hasErrors && gate ? 4 : 0,
    violations,
    confidenceSummary,
    gate,
  };
}

function parseCliArgs(argv) {
  const out = { pipeline: 'greenfield', dir: null, gate: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pipeline') out.pipeline = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--gate') out.gate = true;
    else if (a === '--json') out.json = true;
  }
  return out;
}

function cli(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'check') {
    process.stderr.write(
      'usage: cobolt-architecture-diagram-validate check --pipeline greenfield|brownfield [--gate] [--dir <path>] [--json]\n',
    );
    process.exit(2);
  }
  const opts = parseCliArgs(rest);
  const res = check({ projectRoot: opts.dir || process.cwd(), pipeline: opts.pipeline, gate: opts.gate });
  if (opts.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  else {
    process.stdout.write(
      `[architecture-validate] ${res.ok ? 'PASS' : 'VIOLATIONS'} (${res.violations.length} findings, tier=${res.gate ? 2 : 3})\n`,
    );
  }
  process.exit(res.code || 0);
}

if (require.main === module) cli(process.argv.slice(2));

module.exports = {
  check,
  validateSpecShape,
  validateManifestShape,
  validateMermaidSyntax,
  validatePlantUmlSyntax,
  validateSvgSyntax,
  validateEvidenceBacking,
};
