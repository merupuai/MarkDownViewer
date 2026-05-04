#!/usr/bin/env node

// CoBolt Brownfield Bootstrap — Tool Path Resolution
//
// Discovers the CoBolt installation directory and writes a path marker
// so that all subsequent `node tools/` commands resolve correctly
// regardless of the current working directory.
//
// Usage:
//   node tools/cobolt-brownfield-bootstrap.js [--dir <project-path>]
//   node tools/cobolt-brownfield-bootstrap.js --json
//
// Output:
//   Writes _cobolt-output/.cobolt-tools-dir with the absolute path to CoBolt tools/
//   All subsequent tool commands should use: node "$(cat _cobolt-output/.cobolt-tools-dir)/cobolt-*.js"
//
// Exit codes:
//   0 = tools found and path marker written
//   1 = CoBolt installation not found

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
// ── Discovery Strategy ──────────────────────────────────────

function platformCommand(baseName, platform = process.platform) {
  if (platform === 'win32' && baseName === 'npm') return 'npm.cmd';
  return baseName;
}

function readPathMarker(projectDir) {
  // Stale-marker hardening: a leaked prior brownfield run may have left a
  // marker pointing at a tools dir that no longer exists, has been moved,
  // or lives inside an ephemeral worktree. In v0.9.10 and earlier the
  // marker was trusted as the top candidate with no validation, which
  // contributed to scope-leak bugs when the marker pointed at a foreign
  // CoBolt checkout. We now validate the marker before returning it and
  // DELETE it when it no longer resolves to a valid, non-ephemeral tools
  // directory.
  const markerPath = path.join(projectDir, '_cobolt-output', '.cobolt-tools-dir');
  if (!fs.existsSync(markerPath)) return null;

  let resolved;
  try {
    resolved = fs.readFileSync(markerPath, 'utf8').trim();
  } catch {
    return null;
  }
  if (!resolved) return null;

  // Reject ephemeral worktree paths outright.
  if (isEphemeralToolsDir(resolved)) {
    try {
      fs.unlinkSync(markerPath);
    } catch {
      /* best effort */
    }
    return null;
  }

  // Reject if the target no longer looks like a CoBolt tools directory.
  // This catches: the checkout was deleted, moved, or pointed at a foreign
  // folder that never contained CoBolt.
  if (!isValidToolsDir(resolved)) {
    try {
      fs.unlinkSync(markerPath);
    } catch {
      /* best effort */
    }
    return null;
  }

  return resolved;
}

function findGlobalNpmRoots(options = {}) {
  const roots = new Set();
  const home = options.homeDir || os.homedir();
  const platform = options.platform || process.platform;

  if (Array.isArray(options.npmGlobalRoots)) {
    for (const root of options.npmGlobalRoots) {
      if (root) roots.add(path.resolve(root));
    }
    return [...roots];
  }

  if (process.env.npm_config_prefix) {
    roots.add(path.join(process.env.npm_config_prefix, 'node_modules'));
  }

  if (platform === 'win32') {
    roots.add(path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules'));
  } else {
    roots.add('/usr/local/lib/node_modules');
    roots.add('/opt/homebrew/lib/node_modules');
    roots.add(path.join(home, '.npm-global', 'lib', 'node_modules'));
  }

  try {
    const npmRoot = execFileSync(platformCommand('npm', platform), ['root', '-g'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();
    if (npmRoot) roots.add(path.resolve(npmRoot));
  } catch {
    /* best effort */
  }

  return [...roots];
}

function buildCandidateToolDirs(projectDir, options = {}) {
  const candidates = [];
  const env = options.env || process.env;
  const home = options.homeDir || os.homedir();
  const platform = options.platform || process.platform;
  const includeScriptDir = options.includeScriptDir !== false;
  const npmRoots = findGlobalNpmRoots({ ...options, homeDir: home, platform });

  const markerPath = readPathMarker(projectDir);
  if (markerPath) {
    candidates.push(markerPath);
  }

  // 1. Environment variable (highest priority)
  if (env.COBOLT_HOME) {
    candidates.push(path.join(env.COBOLT_HOME, 'tools'));
  }

  // 2. Relative to this script (if running from CoBolt directory)
  if (includeScriptDir) {
    candidates.push(path.join(__dirname));
  }

  // 3. Common install locations
  candidates.push(
    path.join(home, 'Desktop', 'CoBolt', 'tools'),
    path.join(home, 'CoBolt', 'tools'),
    path.join(home, '.cobolt', 'tools'),
    path.join(home, 'projects', 'CoBolt', 'tools'),
    path.join(home, 'code', 'CoBolt', 'tools'),
    path.join(home, 'repos', 'CoBolt', 'tools'),
    path.join(home, '.claude', 'plugins', 'cobolt', 'tools'),
    path.join(home, '.claude', 'plugins', 'cobolt', 'source', 'tools'),
    path.join(home, '.claude', 'plugins', 'CoBolt', 'tools'),
    path.join(home, '.claude', 'plugins', 'CoBolt', 'source', 'tools'),
    path.join(home, '.claude', 'plugins', '@mftlabs', 'cobolt', 'tools'),
    path.join(home, '.claude', 'plugins', '@mftlabs', 'cobolt', 'source', 'tools'),
    path.join(home, '.codex', 'plugins', 'cobolt', 'tools'),
    path.join(home, '.codex', 'plugins', 'cobolt', 'source', 'tools'),
    path.join(home, '.codex', 'plugins', '@mftlabs', 'cobolt', 'tools'),
    path.join(home, '.codex', 'plugins', '@mftlabs', 'cobolt', 'source', 'tools'),
  );

  for (const npmRoot of npmRoots) {
    candidates.push(path.join(npmRoot, '@mftlabs', 'cobolt', 'tools'), path.join(npmRoot, 'cobolt', 'tools'));
  }

  // 4. Check common Windows paths
  if (platform === 'win32') {
    candidates.push('C:\\CoBolt\\tools', path.join(home, 'Documents', 'CoBolt', 'tools'));
  }

  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

function findCoboltTools(projectDir = process.cwd(), options = {}) {
  const candidates = buildCandidateToolDirs(projectDir, options);

  for (const candidate of candidates) {
    if (isValidToolsDir(candidate)) {
      return {
        toolsDir: path.resolve(candidate),
        searchedLocations: candidates,
      };
    }
  }

  return {
    toolsDir: null,
    searchedLocations: candidates,
  };
}

// Ephemeral locations that must NEVER be selected as the canonical tools dir,
// even if they happen to contain a valid CoBolt checkout. Agent teams and git
// create short-lived worktree copies whose contents can drift from the
// installed version and disappear between runs. Real installs never live
// inside a `worktrees/` directory, so this guard is safe.
const EPHEMERAL_TOOLS_DIR_PATTERNS = [/(^|[\\/])worktrees[\\/]/i];

function isEphemeralToolsDir(dir) {
  const normalized = String(dir || '').replace(/\\/g, '/');
  return EPHEMERAL_TOOLS_DIR_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isValidToolsDir(dir) {
  // Must contain at least these core tools
  const requiredTools = ['cobolt-state.js', 'cobolt-health.js', 'cobolt-brownfield-evidence-index.js'];

  try {
    if (!fs.existsSync(dir)) return false;
    if (isEphemeralToolsDir(dir)) return false;
    return requiredTools.every((tool) => fs.existsSync(path.join(dir, tool)));
  } catch {
    return false;
  }
}

// ── Path Marker ─────────────────────────────────────────────

function writePathMarker(projectDir, toolsDir) {
  const outputDir = path.join(projectDir, '_cobolt-output');
  const markerPath = path.join(outputDir, '.cobolt-tools-dir');
  atomicWrite(markerPath, toolsDir, 'utf8');

  return markerPath;
}

// ── Verify All Tools ────────────────────────────────────────

function verifyTools(toolsDir) {
  const allTools = [
    'cobolt-brownfield-accuracy-review.js',
    'cobolt-brownfield-classify.js',
    'cobolt-brownfield-evidence-index.js',
    'cobolt-brownfield-exec-report.js',
    'cobolt-brownfield-file-manifest.js',
    'cobolt-brownfield-gap-review.js',
    'cobolt-brownfield-handoff.js',
    'cobolt-brownfield-health-score.js',
    'cobolt-brownfield-planning-sync.js',
    'cobolt-brownfield-readiness-gate.js',
    'cobolt-brownfield-tool-health.js',
    'cobolt-brownfield-tool-rollup.js',
    'cobolt-runtime-truth.js',
    'cobolt-route-wiring-check.js',
    'cobolt-query-migration-contract.js',
    'cobolt-semantic-stub-check.js',
    'cobolt-ui-placeholder-check.js',
    'cobolt-illusion-scan.js',
    'cobolt-health.js',
    'cobolt-legacy-scan.js',
    'cobolt-manifest.js',
    'cobolt-scan.js',
    'cobolt-sbom.js',
    'cobolt-state.js',
    'cobolt-tracker-init.js',
    'cobolt-release-checklist.js',
    'cobolt-schema-reverse.js',
    'cobolt-rule-extract.js',
    'cobolt-context.js',
    'cobolt-standards.js',
    'cobolt-standards-gate.js',
    'cobolt-authz-probe.js',
    'cobolt-auth-contract.js',
    'cobolt-secret-entropy-scanner.js',
    'cobolt-threat-test-gen.js',
    'cobolt-compliance-gate.js',
    'cobolt-pr-threat-scan.js',
    'cobolt-crypto-posture.js',
    'cobolt-attack-path.js',
    'cobolt-cis-benchmarks.js',
  ];

  const results = {};
  let found = 0;
  let missing = 0;

  for (const tool of allTools) {
    const exists = fs.existsSync(path.join(toolsDir, tool));
    results[tool] = exists;
    if (exists) found++;
    else missing++;
  }

  return { results, found, missing, total: allTools.length };
}

// ── Main ────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const dirIdx = args.indexOf('--dir');
  const projectDir = dirIdx !== -1 && args[dirIdx + 1] ? path.resolve(args[dirIdx + 1]) : process.cwd();

  const { toolsDir, searchedLocations } = findCoboltTools(projectDir);

  if (!toolsDir) {
    if (jsonMode) {
      console.log(
        JSON.stringify(
          {
            status: 'error',
            message: 'CoBolt installation not found',
            searchedLocations,
          },
          null,
          2,
        ),
      );
    } else {
      console.error('ERROR: CoBolt installation not found.');
      console.error('Checked marker, env var, repo-local, plugin, and npm install locations.');
    }
    process.exit(1);
  }

  const verification = verifyTools(toolsDir);
  const markerPath = writePathMarker(projectDir, toolsDir);

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          status: 'ok',
          toolsDir,
          markerPath,
          projectDir,
          tools: verification,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`CoBolt tools found: ${toolsDir}`);
    console.log(`Path marker written: ${markerPath}`);
    console.log(`Tools: ${verification.found}/${verification.total} available`);
    if (verification.missing > 0) {
      const missingTools = Object.entries(verification.results)
        .filter(([, v]) => !v)
        .map(([k]) => k);
      console.log(`Missing: ${missingTools.join(', ')}`);
    }
  }

  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildCandidateToolDirs,
  findCoboltTools,
  isEphemeralToolsDir,
  isValidToolsDir,
  readPathMarker,
  writePathMarker,
};
