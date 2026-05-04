#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const COMMON_ENV_KEYS = new Set([
  'NODE_ENV',
  'CI',
  'PORT',
  'HOST',
  'APP_URL',
  'BASE_URL',
  'TZ',
  'PWD',
  'HOME',
  'USERPROFILE',
]);

const CONFIG_FILE_CANDIDATES = [
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'vite.config.js',
  'vite.config.ts',
  'astro.config.js',
  'astro.config.mjs',
  'astro.config.ts',
  'nuxt.config.js',
  'nuxt.config.ts',
  'svelte.config.js',
  'tailwind.config.js',
  'tailwind.config.ts',
  'playwright.config.js',
  'playwright.config.ts',
  'jest.config.js',
  'jest.config.ts',
  'vitest.config.js',
  'vitest.config.ts',
  'tsconfig.json',
  'appsettings.json',
  'appsettings.Development.json',
  'config/config.exs',
];

function printUsage(stream = process.stdout) {
  stream.write(
    `${[
      'Usage:',
      '  cobolt-build-config-hygiene-check.js check --milestone M1 [--root <path>] [--json]',
      '  cobolt-build-config-hygiene-check.js --help',
    ].join('\n')}\n`,
  );
}

function normalizeMilestone(value) {
  const match = String(value || '')
    .trim()
    .match(/^M?(\d+)$/i);
  return match ? `M${Number.parseInt(match[1], 10)}` : null;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    command: null,
    root: process.cwd(),
    milestone: null,
    json: false,
    help: false,
    write: true,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--no-write') args.write = false;
    else if (arg === '--root') {
      args.root = argv[i + 1] || args.root;
      i += 1;
    } else if (arg.startsWith('--root=')) args.root = arg.slice('--root='.length);
    else if (arg === '--milestone' || arg === '-m') {
      args.milestone = normalizeMilestone(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--milestone=')) args.milestone = normalizeMilestone(arg.slice('--milestone='.length));
    else positional.push(arg);
  }
  args.command = positional[0] || null;
  return args;
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function relative(projectRoot, filePath) {
  return path.relative(projectRoot, filePath).replace(/\\/g, '/');
}

function buildDir(projectRoot, milestone) {
  return path.join(projectRoot, '_cobolt-output', 'latest', 'build', milestone);
}

function walkFiles(projectRoot) {
  const files = [];
  const ignored = new Set(['.git', 'node_modules', '_cobolt-output', 'dist', 'build', '.next', '.claude', '.codex']);
  const stack = [projectRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(fullPath);
    }
  }
  return files;
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, '');
  } catch {
    return '';
  }
}

function collectReferencedEnvKeys(projectRoot) {
  const counts = new Map();
  const files = walkFiles(projectRoot).filter((filePath) =>
    /\.(?:[cm]?[jt]sx?|py|go|rb|exs?|env|json|ya?ml|toml|cs)$/i.test(filePath),
  );

  const patterns = [
    /\bprocess\.env\.([A-Z][A-Z0-9_]{1,})\b/g,
    /\bprocess\.env\[['"]([A-Z][A-Z0-9_]{1,})['"]\]/g,
    /\bimport\.meta\.env\.([A-Z][A-Z0-9_]{1,})\b/g,
    /\bDeno\.env\.get\(['"]([A-Z][A-Z0-9_]{1,})['"]\)/g,
    /\bos\.Getenv\(['"]([A-Z][A-Z0-9_]{1,})['"]\)/g,
    /\bSystem\.getenv\(['"]([A-Z][A-Z0-9_]{1,})['"]\)/g,
    /\bgetenv\(['"]([A-Z][A-Z0-9_]{1,})['"]\)/g,
  ];

  for (const filePath of files) {
    const text = readText(filePath);
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const key = String(match[1] || '').toUpperCase();
        if (!key) continue;
        const record = counts.get(key) || { count: 0, files: new Set() };
        record.count += 1;
        record.files.add(relative(projectRoot, filePath));
        counts.set(key, record);
      }
    }
  }

  return [...counts.entries()]
    .map(([key, value]) => ({
      key,
      count: value.count,
      files: [...value.files].sort(),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function collectDocumentedEnvKeys(projectRoot) {
  const files = walkFiles(projectRoot).filter((filePath) => {
    const name = path.basename(filePath).toLowerCase();
    return (
      /^\.env(?:\.[a-z0-9_-]+)?(?:\.example|\.sample|\.template)?$/i.test(name) ||
      name === '.env.example' ||
      name === '.env.sample' ||
      name === '.env.template'
    );
  });

  const keys = new Map();
  for (const filePath of files) {
    const text = readText(filePath);
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]{1,})\s*=/);
      if (!match) continue;
      const key = match[1].toUpperCase();
      const record = keys.get(key) || { key, files: new Set() };
      record.files.add(relative(projectRoot, filePath));
      keys.set(key, record);
    }
  }
  return {
    keys: [...keys.values()]
      .map((entry) => ({ key: entry.key, files: [...entry.files].sort() }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    files: files.map((filePath) => relative(projectRoot, filePath)).sort(),
  };
}

function collectConfigSurfaceFiles(projectRoot) {
  const configFiles = [];
  for (const relPath of CONFIG_FILE_CANDIDATES) {
    const fullPath = path.join(projectRoot, relPath);
    if (fs.existsSync(fullPath)) configFiles.push(relPath.replace(/\\/g, '/'));
  }
  const configDir = path.join(projectRoot, 'config');
  if (fs.existsSync(configDir)) {
    const nested = walkFiles(configDir).map((filePath) => relative(projectRoot, filePath));
    configFiles.push(...nested);
  }
  return [...new Set(configFiles)].sort();
}

function runCheck(projectRoot, milestone, options = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  const normalizedMilestone = normalizeMilestone(milestone);
  if (!normalizedMilestone) return { ok: false, reason: 'milestone-required' };

  const referencedEnv = collectReferencedEnvKeys(root);
  const documented = collectDocumentedEnvKeys(root);
  const configFiles = collectConfigSurfaceFiles(root);
  const documentedSet = new Set(documented.keys.map((entry) => entry.key));

  const missingDocumentation = referencedEnv
    .map((entry) => entry.key)
    .filter((key) => !COMMON_ENV_KEYS.has(key) && !documentedSet.has(key));

  const issues = [];
  if (referencedEnv.length > 0 && documented.files.length === 0) {
    issues.push({
      severity: 'high',
      code: 'CONFH-ENV-DOCS-MISSING',
      detail: 'Source references environment variables, but no .env.example/.env.sample/.env.template file was found.',
    });
  }
  if (missingDocumentation.length > 0) {
    issues.push({
      severity: 'high',
      code: 'CONFH-ENV-KEYS-UNDOCUMENTED',
      detail: `Environment keys referenced in source but not documented: ${missingDocumentation.join(', ')}`,
    });
  }

  const requiresConfig = referencedEnv.length > 0 || configFiles.length > 0;
  const ok = issues.length === 0;
  const reason = !requiresConfig
    ? 'no-config-surface-detected'
    : ok
      ? 'config-surface-documented'
      : 'config-hygiene-gaps';

  const artifactPath = path.join(
    buildDir(root, normalizedMilestone),
    `${normalizedMilestone}-config-hygiene-check.json`,
  );
  const report = {
    generatedAt: new Date().toISOString(),
    tool: 'cobolt-build-config-hygiene-check',
    milestone: normalizedMilestone,
    ok,
    reason,
    requiresConfig,
    summary: {
      referencedEnvKeys: referencedEnv.length,
      documentedEnvKeys: documented.keys.length,
      configSurfaceFiles: configFiles.length,
      missingDocumentation: missingDocumentation.length,
    },
    referencedEnv,
    documentedEnv: documented,
    configFiles,
    issues,
  };

  if (options.write !== false) writeJson(artifactPath, report);
  return {
    ...report,
    artifactPath,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage(process.stdout);
    return 0;
  }
  if (!args.command) {
    printUsage(process.stderr);
    return 1;
  }
  if (args.command !== 'check') {
    printUsage(process.stderr);
    return 1;
  }
  if (!args.milestone) {
    process.stderr.write('Missing --milestone M{n}.\n');
    return 1;
  }

  const result = runCheck(args.root, args.milestone, { write: args.write });
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${result.artifactPath}\n`);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  normalizeMilestone,
  parseArgs,
  runCheck,
};
