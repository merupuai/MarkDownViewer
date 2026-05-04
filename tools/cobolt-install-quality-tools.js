#!/usr/bin/env node

// CoBolt Quality Tool Installer — auto-provision linters, formatters, type checkers
//
// Parallel to cobolt-install-tools.js (security tools).
// Uses quality-tool-registry.js for tech-stack-aware tool discovery.
//
// Usage:
//   node tools/cobolt-install-quality-tools.js                     # Show status
//   node tools/cobolt-install-quality-tools.js --install            # Install missing tools
//   node tools/cobolt-install-quality-tools.js --language js        # Filter by language
//   node tools/cobolt-install-quality-tools.js --list               # List all registered tools
//   node tools/cobolt-install-quality-tools.js --dry-run            # Show what would be installed
//   node tools/cobolt-install-quality-tools.js --init-configs       # Also generate config files

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  QUALITY_TOOL_REGISTRY,
  getQualityToolsByLanguage,
  getRecommendedToolsForStack,
} = require('../lib/quality-tool-registry');

class QualityToolInstaller {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
  }

  /**
   * Detect project tech stack from root files.
   */
  detectStack() {
    const files = [];
    try {
      const entries = fs.readdirSync(this.projectDir);
      for (const entry of entries) {
        const stat = fs.statSync(path.join(this.projectDir, entry));
        if (stat.isFile()) files.push(entry);
      }
    } catch {
      /* empty */
    }
    return files;
  }

  /**
   * Check if a tool is available.
   */
  isToolAvailable(tool) {
    // Check for config files (tool is configured in project)
    for (const detect of tool.detect) {
      const target = path.join(this.projectDir, detect);
      if (fs.existsSync(target)) return { found: true, method: 'config', path: detect };
    }

    // Check for binary on PATH
    if (tool.verify) {
      try {
        const binName = tool.name === 'biome' ? 'biome' : tool.name;
        execFileSync('npx', [binName, ...tool.verify], {
          stdio: 'pipe',
          timeout: 10000,
          cwd: this.projectDir,
        });
        return { found: true, method: 'binary' };
      } catch {
        /* not found */
      }
    }

    // Check node_modules/.bin for npm-installed tools
    const binPath = path.join(this.projectDir, 'node_modules', '.bin', tool.name);
    if (fs.existsSync(binPath)) return { found: true, method: 'node_modules' };

    return { found: false };
  }

  /**
   * Get recommended tools for the detected stack.
   */
  getRecommended() {
    const stackFiles = this.detectStack();
    return getRecommendedToolsForStack(stackFiles);
  }

  /**
   * Check all tools and return status.
   */
  check(filters = {}) {
    let tools = [...QUALITY_TOOL_REGISTRY];

    if (filters.language) {
      tools = getQualityToolsByLanguage(filters.language);
    }

    return tools.map((tool) => {
      const disc = this.isToolAvailable(tool);
      return {
        name: tool.name,
        displayName: tool.displayName,
        category: tool.category,
        priority: tool.priority,
        languages: tool.languages,
        available: disc.found,
        method: disc.method || null,
        install: tool.install,
        replaces: tool.replaces,
        description: tool.description,
      };
    });
  }

  /**
   * Get missing tools.
   */
  getMissing(filters = {}) {
    return this.check(filters).filter((t) => !t.available);
  }

  /**
   * Get the best install command for a tool on this platform.
   */
  getInstallCommand(tool) {
    const install = tool.install || {};

    // Prefer npm for JS tools
    if (install.npm) return install.npm;
    // Prefer pip for Python tools
    if (install.pip) return install.pip;
    // Prefer go install for Go tools
    if (install.go) return install.go;
    // Prefer rustup for Rust tools
    if (install.rustup) return install.rustup;
    // Prefer mix for Elixir tools
    if (install.mix) return install.mix;
    // Prefer uv on any platform if available
    if (install.uv) return install.uv;
    // Prefer brew on macOS
    if (process.platform === 'darwin' && install.brew) return install.brew;
    // Prefer scoop on Windows
    if (process.platform === 'win32' && install.scoop) return install.scoop;
    // Fallback to brew on Linux
    if (install.brew) return install.brew;

    return null;
  }

  /**
   * Install a single tool.
   */
  installTool(toolResult) {
    const cmd = this.getInstallCommand(toolResult);
    if (!cmd) {
      return { name: toolResult.name, success: false, message: 'No install command available' };
    }

    console.log(`  Installing ${toolResult.displayName}: ${cmd}`);

    try {
      const parts = cmd.split(' ');
      const bin = parts[0];
      const args = parts.slice(1);

      execFileSync(bin, args, {
        stdio: 'inherit',
        timeout: 300000, // 5 min max per tool
        cwd: this.projectDir,
      });

      return { name: toolResult.name, success: true };
    } catch (err) {
      return { name: toolResult.name, success: false, message: err.message };
    }
  }

  /**
   * Install all missing recommended tools.
   */
  installAll(_filters = {}) {
    const recommended = this.getRecommended();
    const missing = recommended.filter((tool) => !this.isToolAvailable(tool).found);

    if (missing.length === 0) {
      console.log('  All recommended quality tools are already installed!');
      return [];
    }

    console.log(`\n  Installing ${missing.length} missing quality tools...\n`);

    const results = [];
    for (const tool of missing) {
      const result = this.installTool(tool);
      results.push(result);
      console.log(result.success ? `  \u2713 ${tool.displayName}` : `  \u2717 ${tool.displayName}: ${result.message}`);
    }

    const succeeded = results.filter((r) => r.success).length;
    console.log(`\n  Installed: ${succeeded}/${missing.length}`);
    return results;
  }
}

// ── Module exports ──────────────────────────────────────────

module.exports = { QualityToolInstaller };

// ── CLI ─────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--install') options.install = true;
    else if (args[i] === '--dry-run') options.dryRun = true;
    else if (args[i] === '--list') options.list = true;
    else if (args[i] === '--init-configs') options.initConfigs = true;
    else if (args[i] === '--language' && args[i + 1]) options.language = args[++i];
    else if (args[i] === '--json') options.json = true;
    else if (args[i] === '--help') {
      console.log(
        '  Usage: node tools/cobolt-install-quality-tools.js [--install] [--language js] [--list] [--dry-run] [--json]',
      );
      console.log('');
      console.log('  Options:');
      console.log('    --install        Install missing recommended tools');
      console.log('    --dry-run        Show what would be installed');
      console.log('    --language <l>   Filter by language (js, ts, py, go, rs, ex)');
      console.log('    --list           List all registered quality tools');
      console.log('    --init-configs   Also generate default config files');
      console.log('    --json           JSON output');
      process.exit(0);
    }
  }

  const installer = new QualityToolInstaller();

  if (options.list) {
    console.log('\n  CoBolt Quality Tool Registry');
    console.log(
      '  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
    );
    for (const tool of QUALITY_TOOL_REGISTRY) {
      const langs = tool.languages.join(', ');
      const replaces = tool.replaces.length > 0 ? ` (replaces: ${tool.replaces.join(', ')})` : '';
      console.log(`  ${tool.displayName.padEnd(20)} [${tool.category.padEnd(12)}] ${langs}${replaces}`);
    }
    console.log();
    process.exit(0);
  }

  const allTools = installer.check(options);
  const missing = allTools.filter((t) => !t.available);
  const available = allTools.filter((t) => t.available);

  // Greenfield chicken-and-egg: if no stack manifests exist yet (package.json,
  // pyproject.toml, go.mod, Cargo.toml, mix.exs), nothing is enforceable because
  // creating those manifests IS the first build task. Exit 2 signals "defer"
  // so callers (build preflight) can treat it as a soft-skip + re-verify later
  // instead of a hard fail-closed block.
  const stackFilesCheck = installer.detectStack();
  const hasAnyStack =
    stackFilesCheck.includes('package.json') ||
    stackFilesCheck.includes('pyproject.toml') ||
    stackFilesCheck.includes('requirements.txt') ||
    stackFilesCheck.includes('go.mod') ||
    stackFilesCheck.includes('Cargo.toml') ||
    stackFilesCheck.includes('mix.exs');

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          available,
          missing,
          total: allTools.length,
          stacksDetected: hasAnyStack,
          verdict: hasAnyStack ? (missing.length > 0 ? 'missing-tools' : 'pass') : 'no-stack-yet',
        },
        null,
        2,
      ),
    );
    if (!hasAnyStack) process.exit(2);
    process.exit(missing.length > 0 ? 1 : 0);
  }

  console.log();
  console.log('  CoBolt Quality Tool Status');
  console.log(
    '  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
  );

  // Show detected stack
  const stackFiles = installer.detectStack();
  const stacks = [];
  if (stackFiles.includes('package.json')) stacks.push('JS/TS');
  if (stackFiles.includes('pyproject.toml') || stackFiles.includes('requirements.txt')) stacks.push('Python');
  if (stackFiles.includes('go.mod')) stacks.push('Go');
  if (stackFiles.includes('Cargo.toml')) stacks.push('Rust');
  if (stackFiles.includes('mix.exs')) stacks.push('Elixir');
  console.log(`  Detected stacks: ${stacks.length > 0 ? stacks.join(', ') : 'none'}`);
  console.log(`  Available: ${available.length}/${allTools.length}`);
  console.log(`  Missing:   ${missing.length}/${allTools.length}`);
  console.log();

  if (available.length > 0) {
    console.log('  Available:');
    for (const t of available) {
      console.log(`    \u2713 ${t.displayName.padEnd(20)} [${t.category}] (${t.method})`);
    }
    console.log();
  }

  if (missing.length > 0) {
    console.log('  Missing:');
    for (const t of missing) {
      const cmd = installer.getInstallCommand(t);
      console.log(`    \u2717 ${t.displayName.padEnd(20)} [${t.category}] ${cmd || 'no install command'}`);
    }
    console.log();
  }

  // Show recommended
  const recommended = installer.getRecommended();
  if (recommended.length > 0) {
    console.log('  Recommended for your stack:');
    for (const t of recommended) {
      const status = installer.isToolAvailable(t).found ? '\u2713' : '\u2717';
      console.log(`    ${status} ${t.displayName.padEnd(20)} \u2014 ${t.description}`);
    }
    console.log();
  }

  if (options.install && !options.dryRun) {
    installer.installAll(options);
  } else if (options.dryRun) {
    const toInstall = recommended.filter((t) => !installer.isToolAvailable(t).found);
    if (toInstall.length > 0) {
      console.log('  Dry run \u2014 would install:');
      for (const t of toInstall) {
        console.log(`    ${installer.getInstallCommand(t)}`);
      }
    } else {
      console.log('  Dry run \u2014 nothing to install.');
    }
  } else if (missing.length > 0) {
    console.log('  Run with --install to install missing recommended tools.');
  }

  if (!hasAnyStack) {
    console.log('  No stack manifests detected yet — deferring quality-tools gate.');
    console.log('  The gate will re-verify after the first scaffold task writes a manifest.');
    process.exit(2);
  }
  process.exit(missing.length > 0 ? 1 : 0);
}
