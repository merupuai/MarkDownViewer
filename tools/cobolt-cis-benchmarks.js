#!/usr/bin/env node

// CoBolt CIS Benchmarks Scanner — deterministic hardening checks (v0.19+)
//
// Scans Dockerfile, docker-compose, Kubernetes manifests, and common OS
// config files for CIS Benchmarks hardening controls. Each finding maps
// to a CIS control id with severity and remediation hint.
//
// Supported scopes:
//   - Docker Image (CIS Docker Benchmark 1.6, section 4)
//   - Docker Daemon/Compose (section 2, 5)
//   - Kubernetes Pod Security (CIS Kubernetes Benchmark 1.8, section 5)
//   - Systemd service hardening (NoNewPrivileges, ProtectSystem, etc.)
//
// Deterministic — no runtime probing. Produces JSON + MD artifacts.
//
// Usage:
//   node tools/cobolt-cis-benchmarks.js scan [--dir <path>] [--json] [--save]
//
// Exit codes:
//   0 = scan completed
//   1 = usage error
//   2 = target unreadable

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_UNREADABLE = 2;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '_cobolt-output', 'coverage', 'vendor', 'target']);

// Docker image controls
const DOCKER_IMAGE_CONTROLS = [
  {
    id: 'CIS-DOCKER-4.1',
    severity: 'high',
    title: 'Ensure a user for the container has been created',
    check: (content) => !/^\s*USER\s+[^\s]+/im.test(content),
    message: 'Dockerfile runs as root (no USER directive) — add USER appuser after package install',
  },
  {
    id: 'CIS-DOCKER-4.6',
    severity: 'medium',
    title: 'Ensure that HEALTHCHECK instructions have been added',
    check: (content) => !/^\s*HEALTHCHECK\s+/im.test(content),
    message: 'Dockerfile has no HEALTHCHECK — add one so orchestrator can detect failed containers',
  },
  {
    id: 'CIS-DOCKER-4.7',
    severity: 'medium',
    title: 'Ensure update instructions are not used alone in Dockerfiles',
    check: (content) =>
      /\b(?:apt-get|apt)\s+update\b/i.test(content) &&
      !/(?:apt-get|apt)\s+update[^\n]{0,200}(?:apt-get|apt)\s+install/i.test(content),
    message: 'apt update without chained install — creates cache layer without package install',
  },
  {
    id: 'CIS-DOCKER-4.9',
    severity: 'low',
    title: 'Ensure use of COPY is preferred over ADD',
    check: (content) => /^\s*ADD\s+[^\n]+/im.test(content),
    message: 'ADD used — prefer COPY unless remote URL fetch or tar auto-extract is required',
  },
  {
    id: 'CIS-DOCKER-4.10',
    severity: 'critical',
    title: 'Ensure secrets are not stored in Dockerfiles',
    check: (content) =>
      /\b(?:password|api[_-]?key|secret|token|AWS_SECRET)\s*=\s*['"]?[A-Za-z0-9+/=_-]{8,}/i.test(content),
    message: 'Possible secret in Dockerfile — use BuildKit secrets or runtime env vars',
  },
  {
    id: 'CIS-DOCKER-BASE-LATEST',
    severity: 'medium',
    title: 'Ensure base image is pinned to a specific tag (not :latest or untagged)',
    check: (content) =>
      /^\s*FROM\s+\S+(?::latest)?\s*(?:as\s+\w+)?\s*$/im.test(content) &&
      !/^\s*FROM\s+\S+:(?!latest)[\w.-]+/im.test(content),
    message: 'Base image uses :latest or no tag — pin to an immutable tag for reproducible builds',
  },
];

// Docker compose controls
const DOCKER_COMPOSE_CONTROLS = [
  {
    id: 'CIS-DOCKER-5.25',
    severity: 'high',
    title: 'Ensure container is restricted from acquiring additional privileges',
    check: (content) => !/no-new-privileges\s*:\s*true/i.test(content),
    message: 'Missing `security_opt: [no-new-privileges:true]` in docker-compose service',
  },
  {
    id: 'CIS-DOCKER-5.10',
    severity: 'high',
    title: 'Ensure memory usage for container is limited',
    check: (content) => /services\s*:/i.test(content) && !/(?:mem_limit|memory:)/i.test(content),
    message: 'No memory limit declared — container can OOM the host',
  },
  {
    id: 'CIS-DOCKER-5.11',
    severity: 'medium',
    title: 'Ensure CPU priority is set appropriately',
    check: (content) => /services\s*:/i.test(content) && !/(?:cpu_shares|cpus:|cpu_quota)/i.test(content),
    message: 'No CPU limit declared — container can starve host',
  },
  {
    id: 'CIS-DOCKER-5.12',
    severity: 'high',
    title: 'Ensure the root filesystem is mounted as read-only',
    check: (content) => /services\s*:/i.test(content) && !/read_only\s*:\s*true/i.test(content),
    message: 'No read-only root filesystem — tampering attacks can persist',
  },
  {
    id: 'CIS-DOCKER-5.14',
    severity: 'critical',
    title: 'Ensure containers do not run with privileged flag',
    check: (content) => /privileged\s*:\s*true/i.test(content),
    message: 'Container runs privileged — grants full host access, bypasses all isolation',
  },
  {
    id: 'CIS-DOCKER-5.31',
    severity: 'critical',
    title: 'Ensure the Docker socket is not mounted inside containers',
    check: (content) => /\/var\/run\/docker\.sock/.test(content) && /services\s*:/i.test(content),
    message: 'Docker socket mounted inside container — grants host-equivalent privileges',
  },
];

// Kubernetes manifest controls
const K8S_CONTROLS = [
  {
    id: 'CIS-K8S-5.1.5',
    severity: 'medium',
    title: 'Ensure that default service accounts are not actively used',
    check: (content) =>
      /kind\s*:\s*(?:Deployment|StatefulSet|Pod|Job)/i.test(content) && !/serviceAccountName\s*:/i.test(content),
    message: 'Workload without explicit serviceAccountName — uses default SA, hard to audit',
  },
  {
    id: 'CIS-K8S-5.2.5',
    severity: 'critical',
    title: 'Minimize admission of containers with allowPrivilegeEscalation',
    check: (content) => /allowPrivilegeEscalation\s*:\s*true/i.test(content),
    message: 'allowPrivilegeEscalation: true — container can gain more privileges than parent',
  },
  {
    id: 'CIS-K8S-5.2.6',
    severity: 'critical',
    title: 'Minimize admission of root containers',
    check: (content) =>
      /kind\s*:\s*(?:Deployment|StatefulSet|Pod|Job)/i.test(content) && !/runAsNonRoot\s*:\s*true/i.test(content),
    message: 'runAsNonRoot not enforced — containers may run as UID 0',
  },
  {
    id: 'CIS-K8S-5.2.8',
    severity: 'high',
    title: 'Minimize admission of containers with dangerous capabilities (NET_RAW, SYS_ADMIN, ...)',
    check: (content) =>
      /capabilities\s*:[\s\S]{0,200}add\s*:[\s\S]{0,200}(?:NET_RAW|SYS_ADMIN|SYS_PTRACE|SYS_MODULE)/i.test(content),
    message: 'Dangerous Linux capability added — drop all and add only what is required',
  },
  {
    id: 'CIS-K8S-5.2.9',
    severity: 'medium',
    title: 'Ensure that readOnlyRootFilesystem is set',
    check: (content) =>
      /kind\s*:\s*(?:Deployment|StatefulSet|Pod|Job)/i.test(content) &&
      !/readOnlyRootFilesystem\s*:\s*true/i.test(content),
    message: 'readOnlyRootFilesystem not set — tampering persists across pod restarts',
  },
  {
    id: 'CIS-K8S-5.2.10',
    severity: 'critical',
    title: 'Ensure that hostPath volumes are not mounted',
    check: (content) => /hostPath\s*:/i.test(content),
    message: 'hostPath volume in use — escapes pod isolation to host filesystem',
  },
  {
    id: 'CIS-K8S-RESOURCE-LIMITS',
    severity: 'high',
    title: 'Ensure that every container has resource limits',
    check: (content) =>
      /kind\s*:\s*(?:Deployment|StatefulSet|Pod|Job)/i.test(content) && !/\blimits\s*:/i.test(content),
    message: 'No resource limits — one pod can exhaust node capacity',
  },
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.gitlab-ci') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function classify(filePath) {
  const base = path.basename(filePath).toLowerCase();
  if (base === 'dockerfile' || /\.dockerfile$/i.test(base)) return 'dockerfile';
  if (/^docker-compose.*\.(?:ya?ml)$/i.test(base) || /^compose\.(?:ya?ml)$/i.test(base)) return 'docker-compose';
  if (/\.(?:ya?ml)$/i.test(base)) {
    try {
      const content = fs.readFileSync(filePath, 'utf8').slice(0, 4000);
      if (
        /^\s*apiVersion\s*:\s*(?:apps|v1|batch|policy|networking)/im.test(content) ||
        /kind\s*:\s*(?:Deployment|StatefulSet|Pod|Job|Service|ConfigMap|Secret|Ingress|DaemonSet|NetworkPolicy)/i.test(
          content,
        )
      ) {
        return 'k8s-manifest';
      }
    } catch {
      return null;
    }
  }
  return null;
}

function runControls(content, file, controls, kind, findings) {
  for (const c of controls) {
    try {
      if (c.check(content)) {
        findings.push({
          id: c.id,
          severity: c.severity,
          kind,
          title: c.title,
          file,
          message: c.message,
        });
      }
    } catch {
      /* pattern safety — skip on error */
    }
  }
}

function scan(dir) {
  const files = walk(dir);
  const findings = [];
  const filesScanned = { dockerfile: 0, 'docker-compose': 0, 'k8s-manifest': 0 };
  for (const file of files) {
    const kind = classify(file);
    if (!kind) continue;
    filesScanned[kind] += 1;
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (kind === 'dockerfile') runControls(content, file, DOCKER_IMAGE_CONTROLS, kind, findings);
    if (kind === 'docker-compose') runControls(content, file, DOCKER_COMPOSE_CONTROLS, kind, findings);
    if (kind === 'k8s-manifest') runControls(content, file, K8S_CONTROLS, kind, findings);
  }
  const summary = {
    total: findings.length,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    byControl: {},
    filesScanned,
  };
  for (const f of findings) {
    summary.bySeverity[f.severity] = (summary.bySeverity[f.severity] || 0) + 1;
    summary.byControl[f.id] = (summary.byControl[f.id] || 0) + 1;
  }
  return {
    tool: 'cobolt-cis-benchmarks',
    version: '1.0.0',
    target: dir,
    timestamp: new Date().toISOString(),
    findings,
    summary,
  };
}

function emitMarkdown(result) {
  const { target, timestamp, summary, findings } = result;
  const total =
    summary.filesScanned.dockerfile + summary.filesScanned['docker-compose'] + summary.filesScanned['k8s-manifest'];
  const lines = [];
  lines.push('# CIS Benchmarks Review');
  lines.push('');
  lines.push(`- **Generated:** ${timestamp}`);
  lines.push(`- **Target:** ${target}`);
  lines.push(`- **Dockerfiles scanned:** ${summary.filesScanned.dockerfile}`);
  lines.push(`- **Compose files scanned:** ${summary.filesScanned['docker-compose']}`);
  lines.push(`- **Kubernetes manifests scanned:** ${summary.filesScanned['k8s-manifest']}`);
  lines.push(
    `- **Total findings:** ${summary.total} (critical ${summary.bySeverity.critical}, high ${summary.bySeverity.high}, medium ${summary.bySeverity.medium}, low ${summary.bySeverity.low})`,
  );
  lines.push('');
  lines.push('## Coverage');
  lines.push('');
  lines.push(
    'This review applies deterministic pattern matches against the CIS Docker Benchmark 1.6 and CIS Kubernetes Benchmark 1.8 controls that can be detected from static manifests. It complements (not replaces) a full CIS-CAT Pro scan against live infrastructure, which catches runtime-only controls (daemon flags, kernel parameters, network policies in effect).',
  );
  lines.push('');
  if (total === 0) {
    lines.push('## Findings');
    lines.push('');
    lines.push(
      'No Dockerfile, docker-compose, or Kubernetes manifest detected in the target. This check is advisory — containerized deployments gate on `cobolt-infra` manifest review instead. If the project DOES containerize in the future, this review should be re-run at that point so CIS hardening is verified before images ship.',
    );
    lines.push('');
  } else if (findings.length === 0) {
    lines.push('## Findings');
    lines.push('');
    lines.push(
      `Scanned ${total} container/orchestration file(s) — no CIS Benchmark violations detected. This asserts the files meet the deterministic CIS controls listed below. Runtime configuration still needs verification (network policies in effect, kernel hardening, seccomp profiles) via a live CIS-CAT scan.`,
    );
    lines.push('');
  } else {
    lines.push('## Findings Summary');
    lines.push('');
    lines.push('| Control | Severity | Count |');
    lines.push('|---|---|---|');
    for (const [id, count] of Object.entries(summary.byControl).sort((a, b) => b[1] - a[1])) {
      const example = findings.find((f) => f.id === id);
      lines.push(`| ${id} | ${example ? example.severity : 'unknown'} | ${count} |`);
    }
    lines.push('');
    lines.push('## Findings Detail');
    lines.push('');
    for (const [severity, label] of [
      ['critical', 'Critical'],
      ['high', 'High'],
      ['medium', 'Medium'],
      ['low', 'Low'],
    ]) {
      const subset = findings.filter((f) => f.severity === severity);
      if (subset.length === 0) continue;
      lines.push(`### ${label} (${subset.length})`);
      lines.push('');
      for (const f of subset.slice(0, 80)) {
        lines.push(`- **${f.id}** — ${f.title}`);
        lines.push(`  - File: \`${path.relative(process.cwd(), f.file).replaceAll('\\', '/')}\``);
        lines.push(`  - ${f.message}`);
      }
      if (subset.length > 80) lines.push(`- … ${subset.length - 80} more`);
      lines.push('');
    }
  }
  lines.push('## Control Inventory');
  lines.push('');
  lines.push('This tool implements the following subset of CIS controls:');
  lines.push('');
  lines.push('### CIS Docker Benchmark');
  for (const c of DOCKER_IMAGE_CONTROLS.concat(DOCKER_COMPOSE_CONTROLS)) lines.push(`- **${c.id}** — ${c.title}`);
  lines.push('');
  lines.push('### CIS Kubernetes Benchmark');
  for (const c of K8S_CONTROLS) lines.push(`- **${c.id}** — ${c.title}`);
  lines.push('');
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === '-h' || command === '--help') {
    process.stderr.write('Usage: cobolt-cis-benchmarks scan [--dir <path>] [--json] [--save] [--output <path>]\n');
    process.exit(EXIT_USAGE);
  }
  if (command !== 'scan') {
    process.stderr.write(`Unknown command: ${command}\n`);
    process.exit(EXIT_USAGE);
  }
  const dirIdx = args.indexOf('--dir');
  const dir = dirIdx !== -1 && args[dirIdx + 1] ? path.resolve(args[dirIdx + 1]) : process.cwd();
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 && args[outputIdx + 1] ? args[outputIdx + 1] : null;
  const save = args.includes('--save');

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    process.stderr.write(`[cobolt-cis-benchmarks] unreadable target: ${dir}\n`);
    process.exit(EXIT_UNREADABLE);
  }

  const result = scan(dir);
  const md = emitMarkdown(result);

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `[cobolt-cis-benchmarks] scanned ${result.summary.filesScanned.dockerfile + result.summary.filesScanned['docker-compose'] + result.summary.filesScanned['k8s-manifest']} container/manifest file(s)\n`,
    );
    process.stdout.write(
      `  findings: ${result.summary.total} (crit ${result.summary.bySeverity.critical}, high ${result.summary.bySeverity.high}, med ${result.summary.bySeverity.medium})\n`,
    );
  }

  if (save || outputPath) {
    const jsonPath = outputPath || path.join(dir, '_cobolt-output', 'latest', 'brownfield', '12k-cis-benchmarks.json');
    const mdPath = jsonPath.replace(/\.json$/, '.md');
    atomicWrite(jsonPath, JSON.stringify(result, null, 2), 'utf8');
    atomicWrite(mdPath, md, 'utf8');
    process.stderr.write(`[cobolt-cis-benchmarks] wrote ${jsonPath}\n`);
    process.stderr.write(`[cobolt-cis-benchmarks] wrote ${mdPath}\n`);
  }

  process.exit(EXIT_OK);
}

if (require.main === module) main();

module.exports = { scan, emitMarkdown };
