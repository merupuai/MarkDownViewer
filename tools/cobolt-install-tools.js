#!/usr/bin/env node

// CoBolt Tool Installer — auto-install missing security/quality tools
//
// Uses tool-registry.js to determine what's missing and provides
// platform-specific install commands. Supports Docker image pull as alternative.
//
// Usage:
//   node tools/cobolt-install-tools.js                  # Show missing tools and install commands
//   node tools/cobolt-install-tools.js --install         # Actually install missing core tools
//   node tools/cobolt-install-tools.js --docker-pull     # Pull Docker images for missing tools
//   node tools/cobolt-install-tools.js --priority core   # Only core tools
//   node tools/cobolt-install-tools.js --category sast   # Only SAST tools
//   node tools/cobolt-install-tools.js --dry-run         # Show what would be installed

const { spawnSync } = require('node:child_process');
const { AnalyzerBase } = require('../lib/analyzer-base');
const { TOOL_REGISTRY } = require('../lib/tool-registry');
const { isDockerAvailable, pullAllImages } = require('../lib/docker-tool-runner');

class ToolInstaller {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
    // Use native-only discovery for install checks — Docker-available tools
    // should still be installable natively if the user requests --install
    this.analyzer = new AnalyzerBase(this.projectDir, { dockerFallback: false });
    this.analyzer.results = { tools: [] };
  }

  /**
   * Check all tools and return status.
   */
  check(filters = {}) {
    let tools = [...TOOL_REGISTRY];

    if (filters.priority) tools = tools.filter((t) => t.priority === filters.priority);
    if (filters.category) tools = tools.filter((t) => t.category === filters.category);

    const results = [];
    for (const tool of tools) {
      const disc = this.analyzer._discoverTool(tool.name);
      results.push({
        name: tool.name,
        category: tool.category,
        priority: tool.priority,
        available: disc.found,
        method: disc.method,
        installCmd: tool.install[process.platform] || tool.install.linux,
        builtin: tool.builtin || false,
        dockerImage: tool.dockerImage || null,
        dockerAvailable: disc.method === 'docker',
      });
    }
    return results;
  }

  /**
   * Get missing tools.
   */
  getMissing(filters = {}) {
    return this.check(filters).filter((t) => !t.available && !t.builtin);
  }

  /**
   * Install a single tool.
   */
  installTool(toolResult) {
    const cmd = toolResult.installCmd;
    if (!cmd || cmd.startsWith('Built-in') || cmd.startsWith('See ')) {
      return { name: toolResult.name, success: false, message: 'No install command available' };
    }

    console.log(`  Installing ${toolResult.name}: ${cmd}`);

    // v0.65.3 (audit S3-E): replaced the prior shell-true call with spawnSync
    // delegating to the OS shell explicitly via argv. Removes the last
    // string-interpolation shell call in tools/. Registry-supplied installCmd
    // is still trusted; this form makes the shell-vs-argv boundary explicit.
    try {
      const isWindows = process.platform === 'win32';
      const shell = isWindows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
      const shellArgs = isWindows ? ['/d', '/s', '/c', cmd] : ['-c', cmd];
      const result = spawnSync(shell, shellArgs, {
        stdio: 'inherit',
        timeout: 300000,
      });
      if (result.status === 0) return { name: toolResult.name, success: true };
      const msg = result.error
        ? result.error.message
        : `install command returned status ${result.status}${result.signal ? ` (signal ${result.signal})` : ''}`;
      return { name: toolResult.name, success: false, message: msg };
    } catch (err) {
      return { name: toolResult.name, success: false, message: err.message };
    }
  }

  /**
   * Install all missing tools.
   */
  installAll(filters = {}) {
    const missing = this.getMissing(filters);

    if (missing.length === 0) {
      console.log('  All tools are already installed!');
      return [];
    }

    console.log(`\n  Installing ${missing.length} missing tools...\n`);

    const results = [];
    for (const tool of missing) {
      const result = this.installTool(tool);
      results.push(result);
      console.log(result.success ? `  \u2713 ${tool.name}` : `  \u2717 ${tool.name}: ${result.message}`);
    }

    const succeeded = results.filter((r) => r.success).length;
    console.log(`\n  Installed: ${succeeded}/${missing.length}`);
    return results;
  }

  /**
   * Generate install script for the current platform.
   */
  generateScript(filters = {}) {
    const missing = this.getMissing(filters);
    const lines = [
      '#!/bin/bash',
      '# CoBolt Tool Installer — auto-generated',
      `# Platform: ${process.platform} (${process.arch})`,
      `# Generated: ${new Date().toISOString()}`,
      '',
      'set -e',
      '',
    ];

    for (const tool of missing) {
      lines.push(`# ${tool.name} (${tool.category}, ${tool.priority})`);
      lines.push(tool.installCmd);
      lines.push('');
    }

    return lines.join('\n');
  }
}

// ── Module exports ───────────────────────────────────────────

module.exports = { ToolInstaller };

// ── CLI ──────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--install') {
      options.install = true;
    } else if (args[i] === '--dry-run') {
      options.dryRun = true;
    } else if (args[i] === '--priority' && args[i + 1]) {
      options.priority = args[++i];
    } else if (args[i] === '--category' && args[i + 1]) {
      options.category = args[++i];
    } else if (args[i] === '--script') {
      options.script = true;
    } else if (args[i] === '--docker-pull') {
      options.dockerPull = true;
    } else if (args[i] === '--help') {
      console.log(
        '  Usage: node tools/cobolt-install-tools.js [--install] [--docker-pull] [--priority core] [--category sast] [--dry-run] [--script]',
      );
      console.log('  Options:');
      console.log('    --install       Install missing tools natively');
      console.log('    --docker-pull   Pull Docker images for tools that cannot be installed natively');
      console.log('    --priority <p>  Filter by priority (core|recommended|optional)');
      console.log('    --category <c>  Filter by category (sast|deps|secrets|dast|iac|supply-chain)');
      console.log('    --dry-run       Show what would happen without doing it');
      console.log('    --script        Generate install shell script');
      process.exit(0);
    }
  }

  const installer = new ToolInstaller();

  if (options.script) {
    console.log(installer.generateScript(options));
    process.exit(0);
  }

  // Use a non-Docker analyzer for checking native availability
  const nativeAnalyzer = new AnalyzerBase(process.cwd(), { dockerFallback: false });
  nativeAnalyzer.results = { tools: [] };

  let tools = [...TOOL_REGISTRY];
  if (options.priority) tools = tools.filter((t) => t.priority === options.priority);
  if (options.category) tools = tools.filter((t) => t.category === options.category);

  const allTools = [];
  for (const tool of tools) {
    const disc = nativeAnalyzer._discoverTool(tool.name);
    allTools.push({
      name: tool.name,
      category: tool.category,
      priority: tool.priority,
      nativeAvailable: disc.found,
      method: disc.method,
      installCmd: tool.install[process.platform] || tool.install.linux,
      builtin: tool.builtin || false,
      dockerImage: tool.dockerImage || null,
    });
  }

  const nativeAvailable = allTools.filter((t) => t.nativeAvailable || t.builtin);
  const missing = allTools.filter((t) => !t.nativeAvailable && !t.builtin);
  const dockerCoverable = missing.filter((t) => t.dockerImage);
  const dockerAvail = isDockerAvailable();

  console.log();
  console.log('  CoBolt Tool Status');
  console.log('  ══════════════════════════════════════════════');
  console.log(`  Native:      ${nativeAvailable.length}/${allTools.length} tools installed`);
  console.log(`  Missing:     ${missing.length}/${allTools.length} tools`);
  if (missing.length > 0 && dockerAvail) {
    console.log(`  Docker:      ${dockerCoverable.length}/${missing.length} missing tools have Docker images`);
  } else if (missing.length > 0 && !dockerAvail) {
    console.log(`  Docker:      not available (install Docker Desktop for container fallback)`);
  }
  console.log();

  if (missing.length > 0) {
    console.log('  Missing tools:');
    for (const t of missing) {
      const dockerTag = t.dockerImage ? ` [Docker: ${t.dockerImage}]` : ' [no Docker fallback]';
      console.log(`    ${t.name.padEnd(18)} [${t.priority}] ${t.installCmd}`);
      if (!t.nativeAvailable) console.log(`    ${''.padEnd(18)} ${dockerTag}`);
    }
    console.log();
  }

  if (options.dockerPull) {
    if (!dockerAvail) {
      console.error('  Docker is not available. Install Docker Desktop first.');
      process.exit(1);
    }
    console.log('  Pulling Docker images for missing tools...\n');
    const result = pullAllImages({
      priority: options.priority,
      category: options.category,
      onProgress: (msg) => console.log(`  ${msg}`),
    });
    console.log(
      `\n  Pulled: ${result.pulled.length} | Cached: ${result.skipped.length} | Failed: ${result.failed.length}`,
    );
    if (result.failed.length > 0) {
      for (const f of result.failed) console.log(`    Failed: ${f.name} — ${f.message}`);
    }
  } else if (options.install && !options.dryRun) {
    installer.installAll(options);
  } else if (options.dryRun) {
    console.log('  Dry run — would install:');
    for (const t of missing) console.log(`    ${t.installCmd}`);
    if (dockerAvail && dockerCoverable.length > 0) {
      console.log(`\n  Or use --docker-pull to pull ${dockerCoverable.length} Docker images instead.`);
    }
  } else if (missing.length > 0) {
    console.log('  Run with --install to install natively, or --docker-pull to use Docker containers.');
  }
}
