#!/usr/bin/env node

// CoBolt Report Generator — generate and consolidate pipeline reports
//
// Usage:
//   node tools/cobolt-report.js summary                 # Overall pipeline summary
//   node tools/cobolt-report.js stage <name>             # Stage-specific report
//   node tools/cobolt-report.js consolidate              # Merge all stage reports
//   node tools/cobolt-report.js list                     # List available reports
//   node tools/cobolt-report.js export --format md       # Export consolidated report

const fs = require('node:fs');
const path = require('node:path');
const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

const STAGES = [
  'planning',
  'build',
  'review',
  'pentest',
  'fix',
  'audit',
  'deploy',
  'dream',
  'gap',
  'pr',
  'resolve',
  'health',
  'test-suite',
];

class ReportGenerator {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
    this._p = typeof _paths === 'function' ? _paths(this.projectDir) : null;
  }

  _outputDir() {
    return this._p ? path.dirname(this._p.currentRun()) : path.join(this.projectDir, '_cobolt-output');
  }

  _runDir() {
    return this._p ? this._p.currentRun() : path.join(this.projectDir, '_cobolt-output/latest');
  }

  /**
   * List all available reports in the current run.
   */
  list() {
    const runDir = this._runDir();
    const reports = [];

    for (const stage of STAGES) {
      const stageDir = path.join(runDir, stage);
      if (!fs.existsSync(stageDir)) continue;

      try {
        const files = fs.readdirSync(stageDir).filter((f) => f.endsWith('.json') || f.endsWith('.md'));
        for (const f of files) {
          const stat = fs.statSync(path.join(stageDir, f));
          reports.push({
            stage,
            file: f,
            path: path.join(stageDir, f),
            size: stat.size,
            modified: stat.mtime.toISOString(),
          });
        }
      } catch (_e) {
        /* ignore */
      }
    }

    return reports;
  }

  /**
   * Get stage-specific report data.
   */
  stageReport(stage) {
    const stageDir = path.join(this._runDir(), stage);
    if (!fs.existsSync(stageDir)) return { stage, exists: false, files: [] };

    const files = [];
    try {
      for (const f of fs.readdirSync(stageDir)) {
        const filePath = path.join(stageDir, f);
        const stat = fs.statSync(filePath);
        const entry = { name: f, size: stat.size, modified: stat.mtime.toISOString() };

        // Try to parse JSON files for summary data
        if (f.endsWith('.json')) {
          try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            entry.data = data;
          } catch (_e) {
            /* ignore */
          }
        }
        files.push(entry);
      }
    } catch (_e) {
      /* ignore */
    }

    return { stage, exists: true, files };
  }

  /**
   * Generate overall pipeline summary.
   */
  summary() {
    const runDir = this._runDir();
    const stageStatuses = {};

    for (const stage of STAGES) {
      const stageDir = path.join(runDir, stage);
      if (!fs.existsSync(stageDir)) {
        stageStatuses[stage] = { status: 'not-started', fileCount: 0 };
        continue;
      }

      try {
        const files = fs.readdirSync(stageDir);
        stageStatuses[stage] = {
          status: files.length > 0 ? 'completed' : 'empty',
          fileCount: files.length,
          files: files.slice(0, 5), // First 5 files
        };
      } catch {
        stageStatuses[stage] = { status: 'error', fileCount: 0 };
      }
    }

    // Read run metadata
    let meta = null;
    const metaPath = path.join(runDir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch (_e) {
        /* ignore */
      }
    }

    return {
      runDir,
      meta,
      stages: stageStatuses,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Consolidate all stage reports into one document.
   */
  consolidate() {
    const sum = this.summary();
    const sections = [];

    for (const stage of STAGES) {
      const stageData = this.stageReport(stage);
      if (!stageData.exists || stageData.files.length === 0) continue;

      sections.push({
        stage,
        files: stageData.files,
      });
    }

    return { summary: sum, sections, consolidatedAt: new Date().toISOString(), generator: 'Made by CoBolt' };
  }

  /**
   * Export consolidated report as Markdown.
   */
  toMarkdown() {
    const consolidated = this.consolidate();
    const sum = consolidated.summary;
    const lines = [
      '# CoBolt Pipeline Report',
      '',
      `**Run:** ${sum.runDir}`,
      `**Date:** ${sum.timestamp}`,
      sum.meta ? `**Milestone:** ${sum.meta.milestone || 'N/A'} | **Phase:** ${sum.meta.phase || 'N/A'}` : '',
      '',
      '## Stage Summary',
      '',
      '| Stage | Status | Files |',
      '|-------|--------|-------|',
    ];

    for (const [stage, info] of Object.entries(sum.stages)) {
      const icon = info.status === 'completed' ? '\u2713' : info.status === 'not-started' ? '\u2500' : '\u2717';
      lines.push(`| ${icon} ${stage} | ${info.status} | ${info.fileCount} |`);
    }

    lines.push('');

    for (const section of consolidated.sections) {
      lines.push(`## ${section.stage.charAt(0).toUpperCase() + section.stage.slice(1)}`);
      lines.push('');
      for (const f of section.files) {
        lines.push(`- **${f.name}** (${f.size} bytes, ${f.modified})`);
      }
      lines.push('');
    }

    lines.push('---', '', '*Made by CoBolt — Autonomous Development Platform*');

    return lines.join('\n');
  }

  /**
   * Save consolidated report.
   */
  save() {
    const runDir = this._runDir();
    if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });

    const jsonPath = path.join(runDir, 'pipeline-report.json');
    fs.writeFileSync(jsonPath, JSON.stringify(this.consolidate(), null, 2), 'utf8');

    const mdPath = path.join(runDir, 'pipeline-report.md');
    fs.writeFileSync(mdPath, this.toMarkdown(), 'utf8');

    return { json: jsonPath, md: mdPath };
  }
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function countBySeverity(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings || []) {
    const severity = String(finding.severity || '').toLowerCase();
    if (counts[severity] !== undefined) counts[severity]++;
  }
  return counts;
}

function buildValidationReport(options) {
  const milestone = options.milestone || 'Unknown';
  const input = readJsonIfExists(options.input) || {};
  const layers = input.layers || {};
  const lines = [
    `# ${milestone} Validation Report`,
    '',
    `Generated: ${new Date().toISOString()}`,
    `Overall Status: ${input.overallStatus || 'unknown'}`,
    '',
    '## Layer Summary',
    '',
    '| Layer | Status | Detail |',
    '|-------|--------|--------|',
  ];

  for (const [name, layer] of Object.entries(layers)) {
    lines.push(`| ${name} | ${layer.status || 'unknown'} | ${(layer.detail || '').replace(/\|/g, '\\|')} |`);
  }

  if ((input.failedLayers || []).length > 0) {
    lines.push('', '## Failed Layers', '');
    for (const layer of input.failedLayers) lines.push(`- ${layer}`);
  }

  return `${lines.join('\n')}\n`;
}

function buildReviewReport(options) {
  const milestone = options.milestone || 'Unknown';
  const input = readJsonIfExists(options.input) || {};
  const phantom = readJsonIfExists(options.phantomRates) || {};
  const findings = input.findings || [];
  const sev = countBySeverity(findings);
  const lines = [
    `# ${milestone} Review Report`,
    '',
    `Generated: ${new Date().toISOString()}`,
    `Verified Findings: ${findings.length}`,
    '',
    '## Severity Summary',
    '',
    `- Critical: ${sev.critical}`,
    `- High: ${sev.high}`,
    `- Medium: ${sev.medium}`,
    `- Low: ${sev.low}`,
  ];

  if (phantom && Object.keys(phantom).length > 0) {
    lines.push('', '## Phantom Rates', '', '```json', JSON.stringify(phantom, null, 2), '```');
  }

  if (findings.length > 0) {
    lines.push('', '## Findings', '');
    for (const finding of findings.slice(0, 50)) {
      lines.push(
        `- [${String(finding.severity || 'unknown').toUpperCase()}] ${finding.id || 'untracked'}: ${finding.title || finding.summary || finding.file || 'Unnamed finding'}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

function buildRcaReport(options) {
  const milestone = options.milestone || 'Unknown';
  const context = options.context || 'unspecified';
  return [
    `# ${milestone} Fix RCA`,
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Context',
    '',
    context,
    '',
    '## Summary',
    '',
    'The automated fix loop exhausted its retries before all blocking findings were resolved.',
    '',
    '## Next Actions',
    '',
    '- Review unresolved findings and the latest fix iteration logs.',
    '- Re-run targeted tests for the affected areas before resuming the pipeline.',
    '- Escalate to the owning engineer or lead if the blockers require architectural changes.',
    '',
  ].join('\n');
}

function buildGenericReport(options) {
  const input = readJsonIfExists(options.input);
  return [
    `# ${options.type || 'Generated'} Report`,
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    input ? '```json' : 'No structured input was provided.',
    input ? JSON.stringify(input, null, 2) : '',
    input ? '```' : '',
    '',
  ].join('\n');
}

function generateReport(options = {}) {
  const type = options.type || 'generic';
  const outputPath = options.output;
  if (!outputPath) throw new Error('--output is required for generate');

  let content;
  if (type === 'validation') content = buildValidationReport(options);
  else if (type === 'review') content = buildReviewReport(options);
  else if (type === 'rca') content = buildRcaReport(options);
  else content = buildGenericReport(options);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content, 'utf8');
  return { output: outputPath, type };
}

// ── Module exports ───────────────────────────────────────────

module.exports = { ReportGenerator, STAGES, generateReport };

// ── CLI ──────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help') {
    console.log('  Usage: node tools/cobolt-report.js <command> [args]');
    console.log('  Commands: summary, stage, consolidate, list, export, generate');
    process.exit(0);
  }

  const gen = new ReportGenerator();

  switch (cmd) {
    case 'summary': {
      console.log(JSON.stringify(gen.summary(), null, 2));
      break;
    }
    case 'stage': {
      if (!args[1]) {
        console.error('  Usage: stage <name>');
        process.exit(1);
      }
      console.log(JSON.stringify(gen.stageReport(args[1]), null, 2));
      break;
    }
    case 'consolidate': {
      const paths = gen.save();
      console.log(`  Saved: ${paths.json}`);
      console.log(`  Saved: ${paths.md}`);
      break;
    }
    case 'list': {
      const reports = gen.list();
      if (reports.length === 0) {
        console.log('  No reports found.');
        break;
      }
      for (const r of reports) console.log(`  [${r.stage}] ${r.file} (${r.size} bytes)`);
      break;
    }
    case 'export': {
      const format = args.includes('--format') ? args[args.indexOf('--format') + 1] : 'md';
      if (format === 'md') {
        console.log(gen.toMarkdown());
      } else {
        console.log(JSON.stringify(gen.consolidate(), null, 2));
      }
      break;
    }
    case 'generate': {
      const getFlag = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
      const result = generateReport({
        type: getFlag('--type'),
        milestone: getFlag('--milestone'),
        input: getFlag('--input'),
        output: getFlag('--output'),
        phantomRates: getFlag('--phantom-rates'),
        context: getFlag('--context'),
      });
      console.log(`  Saved: ${result.output}`);
      break;
    }
    default:
      console.error(`  Unknown command: ${cmd}`);
      process.exit(1);
  }
}
