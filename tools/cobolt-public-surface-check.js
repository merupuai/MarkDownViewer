#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  CODEX_CLI_ROOT_COMMANDS,
  PUBLIC_WORKFLOWS,
  assertCliCommandModulesExist,
  assertCodexCliAlignment,
  assertPublicWorkflowShape,
  rootCommandFromCodexCli,
} = require('../lib/cobolt-public-surface');

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    check: false,
    json: false,
    rootDir: path.join(__dirname, '..'),
    docsPath: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') options.check = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--root') {
      options.rootDir = path.resolve(argv[++i] || options.rootDir);
    } else if (arg.startsWith('--root=')) {
      options.rootDir = path.resolve(arg.slice('--root='.length));
    } else if (arg === '--docs') {
      options.docsPath = path.resolve(argv[++i] || '');
    } else if (arg.startsWith('--docs=')) {
      options.docsPath = path.resolve(arg.slice('--docs='.length));
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function extractSection(markdown, heading) {
  const pattern = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im');
  const match = markdown.match(pattern);
  if (!match || match.index === undefined) return '';
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const next = rest.search(/^##\s+/m);
  return next === -1 ? rest : rest.slice(0, next);
}

function parsePublicWorkflowRows(markdown) {
  const section = extractSection(markdown, 'Public Workflows');
  const rows = [];

  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    if (/^\|\s*-+\s*\|/.test(trimmed) || /\|\s*Workflow\s*\|/i.test(trimmed)) continue;

    const cells = trimmed
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());
    if (cells.length < 4) continue;

    rows.push({
      workflow: cells[0],
      claude: cells[1],
      codexCli: cells[2],
      purpose: cells[3],
      raw: trimmed,
    });
  }

  return rows;
}

function extractCodexCliReferences(text) {
  const refs = new Set();
  for (const match of text.matchAll(/`cobolt-cli\s+([^`]+)`/g)) {
    refs.add(`cobolt-cli ${match[1].trim()}`);
  }
  return refs;
}

function extractCodexCliRootReferences(text) {
  const roots = new Set();
  for (const ref of extractCodexCliReferences(text)) {
    const root = rootCommandFromCodexCli(ref);
    if (root) roots.add(root);
  }
  return roots;
}

function parseCommandReferenceHeadings(markdown) {
  const headings = new Set();
  for (const match of markdown.matchAll(/^###\s+`cobolt-cli\s+([a-z-]+)`/gm)) {
    headings.add(match[1]);
  }
  return headings;
}

function createFinding(code, message, details = {}) {
  return { code, message, ...details };
}

function assertVerbsLock(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'));
  const verbsModule = options.verbsModule || require(path.join(rootDir, 'tools', 'verbs.js'));
  const toolsModule = options.toolsModule || require(path.join(rootDir, 'tools', 'index.js'));
  const lockPath = path.join(rootDir, 'tools', 'verbs-lock.json');
  const lock = options.lock || JSON.parse(fs.readFileSync(lockPath, 'utf8'));

  const actualVerbs = Object.keys(verbsModule.VERBS).sort();
  const expectedVerbs = [...lock.verbs].sort();

  if (actualVerbs.length !== expectedVerbs.length || actualVerbs.some((v, i) => v !== expectedVerbs[i])) {
    const missing = expectedVerbs.filter((v) => !actualVerbs.includes(v));
    const extra = actualVerbs.filter((v) => !expectedVerbs.includes(v));
    const detail = [];
    if (missing.length) detail.push(`missing: ${missing.join(', ')}`);
    if (extra.length) detail.push(`extra: ${extra.join(', ')}`);
    throw new Error(`tools/verbs.js verbs drift (${detail.join('; ')})`);
  }

  const tools = toolsModule.TOOLS || {};
  const targetOf =
    verbsModule.targetOf ||
    ((value) => {
      if (!value || value === '__meta__') return null;
      if (typeof value === 'string') return value;
      if (typeof value === 'object' && typeof value.target === 'string') return value.target;
      return null;
    });
  for (const [verb, def] of Object.entries(verbsModule.VERBS)) {
    for (const [noun, value] of Object.entries(def.nouns || {})) {
      if (value === '__meta__') continue;
      const target = targetOf(value);
      if (!target || !tools[target]) {
        throw new Error(`verb ${verb}.${noun} resolves to unknown tool: ${target}`);
      }
    }
  }
  return true;
}

function checkPublicSurface(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'));
  const docsPath = options.docsPath || path.join(rootDir, 'docs', 'COBOLT-CLI-GUIDE.md');
  const docsContent = options.docsContent ?? fs.readFileSync(docsPath, 'utf8');
  const commandRegistry = options.commandRegistry || require(path.join(rootDir, 'cli', 'index.js')).COMMANDS;
  const findings = [];

  try {
    assertPublicWorkflowShape(PUBLIC_WORKFLOWS);
  } catch (err) {
    findings.push(createFinding('PUBLIC_WORKFLOW_SHAPE', err.message));
  }

  try {
    assertCodexCliAlignment(commandRegistry);
  } catch (err) {
    findings.push(createFinding('CLI_COMMAND_ALIGNMENT', err.message));
  }

  try {
    assertCliCommandModulesExist(rootDir);
  } catch (err) {
    findings.push(createFinding('CLI_COMMAND_MODULE_MISSING', err.message));
  }

  try {
    assertVerbsLock({ rootDir });
  } catch (err) {
    findings.push(createFinding('VERBS_LOCK_DRIFT', err.message));
  }

  const workflowRows = parsePublicWorkflowRows(docsContent);
  const publicWorkflowSection = extractSection(docsContent, 'Public Workflows');
  const workflowRefs = extractCodexCliReferences(publicWorkflowSection);
  const workflowRoots = extractCodexCliRootReferences(publicWorkflowSection);
  const commandReferenceHeadings = parseCommandReferenceHeadings(docsContent);
  const expectedRoots = new Set(CODEX_CLI_ROOT_COMMANDS);

  for (const workflow of PUBLIC_WORKFLOWS) {
    const row = workflowRows.find(
      (candidate) => candidate.claude.includes(workflow.claude) && candidate.codexCli.includes(workflow.codexCli),
    );
    if (!row) {
      findings.push(
        createFinding('MISSING_PUBLIC_WORKFLOW_ROW', `Missing Public Workflows row for ${workflow.id}`, {
          workflow: workflow.id,
          expectedClaude: workflow.claude,
          expectedCodexCli: workflow.codexCli,
        }),
      );
    }
  }

  for (const root of expectedRoots) {
    if (!commandReferenceHeadings.has(root)) {
      findings.push(
        createFinding('MISSING_COMMAND_REFERENCE', `Missing command reference heading for cobolt-cli ${root}`, {
          command: root,
        }),
      );
    }
  }

  for (const root of workflowRoots) {
    if (!expectedRoots.has(root) && root !== 'analyze') {
      findings.push(
        createFinding('EXTRA_DOCUMENTED_ROOT_COMMAND', `Public workflow docs mention unknown root command: ${root}`, {
          command: root,
        }),
      );
    }
  }

  for (const ref of workflowRefs) {
    const root = rootCommandFromCodexCli(ref);
    if (root === 'analyze' && !/\balias\b/i.test(publicWorkflowSection)) {
      findings.push(
        createFinding('ANALYZE_ALIAS_NOT_EXPLAINED', 'analyze may only be documented as an alias for analyse'),
      );
    }
  }

  if (workflowRoots.has('analyze')) {
    findings.push(createFinding('ANALYZE_PUBLIC_WORKFLOW', 'analyze is an alias only and must not be a table row'));
  }

  const documentedRoots = new Set([...commandReferenceHeadings, ...workflowRoots]);
  for (const root of documentedRoots) {
    if (!expectedRoots.has(root) && root !== 'analyze') {
      findings.push(
        createFinding('DOCUMENTED_COMMAND_NOT_IN_CLI', `Documented command is missing from CLI: ${root}`, {
          command: root,
        }),
      );
    }
  }

  return {
    ok: findings.length === 0,
    docsPath,
    publicWorkflowCount: PUBLIC_WORKFLOWS.length,
    cliRootCommandCount: CODEX_CLI_ROOT_COMMANDS.length,
    documentedWorkflowRows: workflowRows.length,
    commandReferenceHeadings: [...commandReferenceHeadings].sort(),
    findings,
  };
}

function formatHuman(result) {
  if (result.ok) {
    return [
      'Public surface check: PASS',
      `  Workflows: ${result.publicWorkflowCount}`,
      `  CLI root commands: ${result.cliRootCommandCount}`,
      `  Docs rows: ${result.documentedWorkflowRows}`,
    ].join('\n');
  }

  return [
    'Public surface check: FAIL',
    ...result.findings.map((finding) => `  - [${finding.code}] ${finding.message}`),
  ].join('\n');
}

function printHelp() {
  console.log('Usage: node tools/cobolt-public-surface-check.js [--check] [--json] [--root <dir>] [--docs <file>]');
}

if (require.main === module) {
  try {
    const options = parseArgs();
    if (options.help) {
      printHelp();
      process.exit(0);
    }
    const result = checkPublicSurface(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatHuman(result));
    }
    process.exit(options.check && !result.ok ? 1 : 0);
  } catch (err) {
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ ok: false, findings: [{ code: 'ERROR', message: err.message }] }, null, 2));
    } else {
      console.error(err.message);
    }
    process.exit(1);
  }
}

module.exports = {
  assertVerbsLock,
  checkPublicSurface,
  extractCodexCliReferences,
  extractSection,
  formatHuman,
  parseArgs,
  parseCommandReferenceHeadings,
  parsePublicWorkflowRows,
};
