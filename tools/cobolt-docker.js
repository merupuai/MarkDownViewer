#!/usr/bin/env node

// CoBolt Docker Manager — Docker build, run, verify lifecycle
//
// Usage:
//   node tools/cobolt-docker.js build [--tag name]    # Build Docker image
//   node tools/cobolt-docker.js run [--tag name]       # Run container
//   node tools/cobolt-docker.js verify [--tag name]    # Verify container health
//   node tools/cobolt-docker.js stop [--tag name]      # Stop container
//   node tools/cobolt-docker.js clean                   # Remove stopped containers and dangling images
//   node tools/cobolt-docker.js status                  # Show Docker status
//   node tools/cobolt-docker.js compose-up              # docker compose up -d
//   node tools/cobolt-docker.js compose-down            # docker compose down

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

class DockerManager {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
  }

  /**
   * Check if Docker is available and running.
   */
  isAvailable() {
    try {
      execFileSync('docker', ['info'], { stdio: 'pipe', timeout: 10000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if docker compose is available.
   */
  hasCompose() {
    try {
      execFileSync('docker', ['compose', 'version'], { stdio: 'pipe', timeout: 10000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Detect Dockerfile and compose files.
   */
  detect() {
    return {
      dockerfile: fs.existsSync(path.join(this.projectDir, 'Dockerfile')),
      dockerfileMultistage: this._isMultistage(),
      composeFile: this._findComposeFile(),
      dockerignore: fs.existsSync(path.join(this.projectDir, '.dockerignore')),
    };
  }

  _findComposeFile() {
    const candidates = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
    for (const f of candidates) {
      if (fs.existsSync(path.join(this.projectDir, f))) return f;
    }
    return null;
  }

  _isMultistage() {
    const dockerfilePath = path.join(this.projectDir, 'Dockerfile');
    if (!fs.existsSync(dockerfilePath)) return false;
    const content = fs.readFileSync(dockerfilePath, 'utf8');
    return (content.match(/^FROM\s/gim) || []).length > 1;
  }

  /**
   * Build Docker image.
   */
  build(options = {}) {
    const tag = options.tag || path.basename(this.projectDir).toLowerCase();
    const args = ['build', '-t', tag];
    if (options.target) args.push('--target', options.target);
    if (options.noCache) args.push('--no-cache');
    args.push('.');

    console.log(`  Building: docker ${args.join(' ')}`);
    const startTime = Date.now();

    try {
      execFileSync('docker', args, {
        cwd: this.projectDir,
        stdio: 'inherit',
        timeout: 600000,
      });
      return { success: true, tag, durationMs: Date.now() - startTime };
    } catch (err) {
      return { success: false, tag, error: err.message, durationMs: Date.now() - startTime };
    }
  }

  /**
   * Run container.
   */
  run(options = {}) {
    const tag = options.tag || path.basename(this.projectDir).toLowerCase();
    const name = options.name || `cobolt-${tag}`;
    const args = ['run', '-d', '--name', name];

    if (options.ports) {
      for (const p of options.ports) args.push('-p', p);
    }
    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) args.push('-e', `${k}=${v}`);
    }
    args.push(tag);

    console.log(`  Running: docker ${args.join(' ')}`);

    try {
      const containerId = execFileSync('docker', args, {
        cwd: this.projectDir,
        encoding: 'utf8',
        timeout: 60000,
      }).trim();
      return { success: true, containerId, name, tag };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Verify container is healthy.
   */
  verify(options = {}) {
    const name = options.name || `cobolt-${(options.tag || path.basename(this.projectDir)).toLowerCase()}`;

    try {
      const output = execFileSync('docker', ['inspect', '--format', '{{.State.Status}}', name], {
        encoding: 'utf8',
        timeout: 10000,
      }).trim();

      return { name, status: output, healthy: output === 'running' };
    } catch {
      return { name, status: 'not found', healthy: false };
    }
  }

  /**
   * Stop container.
   */
  stop(options = {}) {
    const name = options.name || `cobolt-${(options.tag || path.basename(this.projectDir)).toLowerCase()}`;

    try {
      execFileSync('docker', ['stop', name], { timeout: 30000 });
      execFileSync('docker', ['rm', name], { timeout: 10000, stdio: 'pipe' });
      return { success: true, name };
    } catch (err) {
      return { success: false, name, error: err.message };
    }
  }

  /**
   * Docker compose up.
   */
  composeUp(options = {}) {
    const composeFile = this._findComposeFile();
    if (!composeFile) {
      return { success: false, error: 'No compose file found' };
    }

    const args = ['compose', '-f', composeFile, 'up', '-d'];
    if (options.build) args.push('--build');

    try {
      execFileSync('docker', args, { cwd: this.projectDir, stdio: 'inherit', timeout: 600000 });
      return { success: true, composeFile };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Docker compose down.
   */
  composeDown() {
    const composeFile = this._findComposeFile();
    if (!composeFile) return { success: false, error: 'No compose file found' };

    try {
      execFileSync('docker', ['compose', '-f', composeFile, 'down'], {
        cwd: this.projectDir,
        stdio: 'inherit',
        timeout: 60000,
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Clean up stopped containers and dangling images.
   */
  clean() {
    const results = [];
    try {
      execFileSync('docker', ['container', 'prune', '-f'], { stdio: 'pipe', timeout: 30000 });
      results.push('Pruned stopped containers');
    } catch {}
    try {
      execFileSync('docker', ['image', 'prune', '-f'], { stdio: 'pipe', timeout: 30000 });
      results.push('Pruned dangling images');
    } catch {}
    return results;
  }

  /**
   * Get Docker status.
   */
  status() {
    const info = {
      available: this.isAvailable(),
      compose: this.hasCompose(),
      detection: this.detect(),
      containers: [],
    };

    if (info.available) {
      try {
        const output = execFileSync('docker', ['ps', '--format', '{{.Names}}\t{{.Status}}\t{{.Ports}}'], {
          encoding: 'utf8',
          timeout: 10000,
        });
        info.containers = output
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [name, status, ports] = line.split('\t');
            return { name, status, ports };
          });
      } catch {}
    }

    return info;
  }
}

// ── Module exports ───────────────────────────────────────────

module.exports = { DockerManager };

// ── CLI ──────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const options = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--tag' && args[i + 1]) {
      options.tag = args[++i];
    } else if (args[i] === '--name' && args[i + 1]) {
      options.name = args[++i];
    } else if (args[i] === '--no-cache') {
      options.noCache = true;
    } else if (args[i] === '--build') {
      options.build = true;
    } else if (args[i] === '--target' && args[i + 1]) {
      options.target = args[++i];
    }
  }

  if (!cmd || cmd === '--help') {
    console.log('  Usage: node tools/cobolt-docker.js <command> [options]');
    console.log('  Commands: build, run, verify, stop, clean, status, compose-up, compose-down');
    process.exit(0);
  }

  const docker = new DockerManager();

  if (!docker.isAvailable() && !['status', '--help'].includes(cmd)) {
    console.error('  Docker is not available. Please install and start Docker.');
    process.exit(1);
  }

  switch (cmd) {
    case 'build': {
      const r = docker.build(options);
      console.log(r.success ? `  \u2713 Built ${r.tag}` : `  \u2717 ${r.error}`);
      process.exit(r.success ? 0 : 1);
      break;
    }
    case 'run': {
      const r = docker.run(options);
      console.log(r.success ? `  \u2713 Running ${r.containerId}` : `  \u2717 ${r.error}`);
      break;
    }
    case 'verify': {
      const r = docker.verify(options);
      console.log(r.healthy ? `  \u2713 ${r.name}: ${r.status}` : `  \u2717 ${r.name}: ${r.status}`);
      process.exit(r.healthy ? 0 : 1);
      break;
    }
    case 'stop': {
      const r = docker.stop(options);
      console.log(r.success ? `  \u2713 Stopped ${r.name}` : `  \u2717 ${r.error}`);
      break;
    }
    case 'clean': {
      const r = docker.clean();
      for (const m of r) console.log(`  \u2713 ${m}`);
      break;
    }
    case 'status': {
      console.log(JSON.stringify(docker.status(), null, 2));
      break;
    }
    case 'compose-up': {
      const r = docker.composeUp(options);
      console.log(r.success ? '  \u2713 Compose up' : `  \u2717 ${r.error}`);
      break;
    }
    case 'compose-down': {
      const r = docker.composeDown();
      console.log(r.success ? '  \u2713 Compose down' : `  \u2717 ${r.error}`);
      break;
    }
    default:
      console.error(`  Unknown command: ${cmd}`);
      process.exit(1);
  }
}
