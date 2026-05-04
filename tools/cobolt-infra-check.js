#!/usr/bin/env node

// CoBolt Infrastructure Check — per-milestone infrastructure validation
//
// Validates that required infrastructure is available and healthy before
// build proceeds. This is the ONLY hard stop across ALL pipelines.
//
// Usage:
//   node tools/cobolt-infra-check.js validate              # Full infra validation
//   node tools/cobolt-infra-check.js validate --json        # JSON output
//   node tools/cobolt-infra-check.js validate --milestone M1  # Per-milestone check
//   node tools/cobolt-infra-check.js status                 # Quick status summary
//
// Exit codes:
//   0 = Infrastructure ready (all services healthy)
//   1 = User-provided infrastructure failed validation (HARD STOP)
//   2 = No infrastructure configured — needs setup via cobolt-infra
//   3 = Docker not available

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { atomicWrite, atomicWriteJSON } = require('../lib/cobolt-atomic-write');
const { censusDeployFields } = require('../lib/cobolt-infra-manifest');

const ENV_FILENAME = '.env.cobolt';
const INFRA_MANIFEST = '_cobolt-output/latest/infra/infra-manifest.json';

// ── Service Connectivity Checks ─────────────────────────────

/**
 * Check if Docker daemon is running.
 * @returns {{available: boolean, version: string|null, error: string|null}}
 */
function checkDocker() {
  try {
    const version = execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return { available: true, version, error: null };
  } catch (err) {
    return { available: false, version: null, error: err.message || 'Docker not available' };
  }
}

/**
 * Check if Docker Compose services are running.
 * @param {string} projectDir
 * @returns {{running: boolean, services: object[], error: string|null}}
 */
function checkDockerCompose(projectDir) {
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  const composeFile = composeFiles.find((f) => fs.existsSync(path.join(projectDir, f)));

  if (!composeFile) {
    return { running: false, services: [], error: 'No docker-compose file found' };
  }

  try {
    const output = execFileSync('docker', ['compose', 'ps', '--format', 'json'], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!output) {
      return { running: false, services: [], error: 'No services running' };
    }

    // docker compose ps --format json outputs one JSON object per line
    const services = output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .map((svc) => ({
        name: svc.Name || svc.Service || 'unknown',
        state: svc.State || svc.Status || 'unknown',
        health: svc.Health || 'unknown',
        ports: svc.Ports || svc.Publishers || '',
      }));

    const allHealthy = services.length > 0 && services.every((s) => s.state === 'running' || s.state === 'Up');

    return { running: allHealthy, services, error: allHealthy ? null : 'Some services not running' };
  } catch (err) {
    return { running: false, services: [], error: (err.stderr || err.message || '').trim() };
  }
}

/**
 * Test TCP connectivity to a host:port.
 * @param {string} host
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<{reachable: boolean, latencyMs: number, error: string|null}>}
 */
function checkTcpSync(host, port, timeoutMs = 5000) {
  // Use Node.js net module via a quick sync check with execFileSync
  try {
    const script = `
      const net = require('net');
      const start = Date.now();
      const sock = net.createConnection({host:'${host}',port:${port},timeout:${timeoutMs}});
      sock.on('connect', () => { console.log(JSON.stringify({ok:true,ms:Date.now()-start})); sock.destroy(); });
      sock.on('error', (e) => { console.log(JSON.stringify({ok:false,err:e.message})); sock.destroy(); });
      sock.on('timeout', () => { console.log(JSON.stringify({ok:false,err:'timeout'})); sock.destroy(); });
    `;
    const result = execFileSync('node', ['-e', script], {
      encoding: 'utf8',
      timeout: timeoutMs + 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const parsed = JSON.parse(result);
    return {
      reachable: parsed.ok,
      latencyMs: parsed.ms || 0,
      error: parsed.err || null,
    };
  } catch (err) {
    return { reachable: false, latencyMs: 0, error: err.message || 'Connection check failed' };
  }
}

/**
 * Parse a URL into host and port.
 * @param {string} url
 * @param {number} defaultPort
 * @returns {{host: string, port: number}|null}
 */
function parseEndpoint(url, defaultPort) {
  if (!url) return null;
  try {
    // Handle postgres:// and redis:// by converting to http:// for URL parsing
    const normalized = url.replace(/^postgres(ql)?:\/\//, 'http://').replace(/^rediss?:\/\//, 'http://');
    const parsed = new URL(normalized);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port, 10) || defaultPort,
    };
  } catch {
    return null;
  }
}

// ── User-Provided Infrastructure Validation ─────────────────

/**
 * Validate all user-provided services from .env.cobolt.
 * @param {string} projectDir
 * @returns {{valid: boolean, checks: object[], errors: string[], warnings: string[]}}
 */
function validateUserInfra(projectDir) {
  const envPath = path.join(projectDir, ENV_FILENAME);
  if (!fs.existsSync(envPath)) {
    return { valid: false, checks: [], errors: ['No .env.cobolt found'], warnings: [], source: 'none' };
  }

  // Load cobolt-env lib for parsing
  let coboltEnv;
  try {
    coboltEnv = require('../lib/cobolt-env');
  } catch {
    try {
      coboltEnv = require(path.join(__dirname, '..', 'lib', 'cobolt-env'));
    } catch {
      return { valid: false, checks: [], errors: ['Cannot load cobolt-env library'], warnings: [], source: 'user' };
    }
  }

  const env = coboltEnv.parse(envPath);
  const validation = coboltEnv.validate(env);
  const structured = coboltEnv.structure(env);

  const checks = [];
  const errors = [...validation.errors];
  const warnings = [...validation.warnings];

  // Check database connectivity
  if (structured.database.provided && structured.database.url) {
    const endpoint = parseEndpoint(structured.database.url, 5432);
    if (endpoint) {
      const result = checkTcpSync(endpoint.host, endpoint.port, 5000);
      checks.push({
        service: 'database',
        url: structured.database.url.replace(/:[^:@]*@/, ':***@'), // mask password
        host: endpoint.host,
        port: endpoint.port,
        reachable: result.reachable,
        latencyMs: result.latencyMs,
        error: result.error,
      });
      if (!result.reachable) {
        errors.push(`Database unreachable at ${endpoint.host}:${endpoint.port} — ${result.error}`);
      }
    }
  }

  // Check Redis connectivity
  if (structured.cache.provided && structured.cache.url) {
    const endpoint = parseEndpoint(structured.cache.url, 6379);
    if (endpoint) {
      const result = checkTcpSync(endpoint.host, endpoint.port, 5000);
      checks.push({
        service: 'cache',
        url: structured.cache.url.replace(/:[^:@]*@/, ':***@'),
        host: endpoint.host,
        port: endpoint.port,
        reachable: result.reachable,
        latencyMs: result.latencyMs,
        error: result.error,
      });
      if (!result.reachable) {
        errors.push(`Redis unreachable at ${endpoint.host}:${endpoint.port} — ${result.error}`);
      }
    }
  }

  // Check custom services connectivity
  for (const [name, url] of Object.entries(structured.custom_services || {})) {
    const endpoint = parseEndpoint(url, 443);
    if (endpoint) {
      const result = checkTcpSync(endpoint.host, endpoint.port, 5000);
      checks.push({
        service: `custom:${name}`,
        url,
        host: endpoint.host,
        port: endpoint.port,
        reachable: result.reachable,
        latencyMs: result.latencyMs,
        error: result.error,
      });
      if (!result.reachable) {
        warnings.push(`Custom service '${name}' unreachable at ${endpoint.host}:${endpoint.port}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    checks,
    errors,
    warnings,
    source: 'user',
  };
}

// ── Auto-Provisioned Infrastructure Validation ──────────────

/**
 * Validate auto-provisioned infrastructure (Docker Compose services).
 * @param {string} projectDir
 * @returns {{valid: boolean, checks: object[], errors: string[], warnings: string[]}}
 */
function validateAutoInfra(projectDir) {
  const checks = [];
  const errors = [];
  const warnings = [];

  // Check infra-manifest exists
  const manifestPath = path.join(projectDir, INFRA_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    return {
      valid: false,
      checks: [],
      errors: ['No infra-manifest.json found. Run /cobolt-infra to provision infrastructure.'],
      warnings: [],
      source: 'auto',
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return {
      valid: false,
      checks: [],
      errors: [`Cannot parse infra-manifest.json: ${e.message}`],
      warnings: [],
      source: 'auto',
    };
  }

  // Check Docker
  const docker = checkDocker();
  checks.push({
    service: 'docker',
    available: docker.available,
    version: docker.version,
    error: docker.error,
  });
  if (!docker.available) {
    errors.push(`Docker is not available: ${docker.error}`);
    return { valid: false, checks, errors, warnings, source: 'auto' };
  }

  // Check Docker Compose services
  const compose = checkDockerCompose(projectDir);
  checks.push({
    service: 'docker-compose',
    running: compose.running,
    serviceCount: compose.services.length,
    services: compose.services,
    error: compose.error,
  });

  if (!compose.running) {
    errors.push('Docker Compose services are not running. Infrastructure needs to be started.');
  }

  // Validate individual services from manifest
  const services = manifest.services || manifest.infrastructure?.services || {};
  for (const [name, svc] of Object.entries(services)) {
    if (svc.endpoint || svc.url) {
      const url = svc.endpoint || svc.url;
      const defaultPort = name.includes('db') || name.includes('postgres') ? 5432 : name.includes('redis') ? 6379 : 80;
      const endpoint = parseEndpoint(url, defaultPort);
      if (endpoint) {
        const result = checkTcpSync(endpoint.host, endpoint.port, 5000);
        checks.push({
          service: name,
          url: url.replace(/:[^:@]*@/, ':***@'),
          reachable: result.reachable,
          latencyMs: result.latencyMs,
          error: result.error,
          source: svc._source || 'auto-provisioned',
        });
        if (!result.reachable) {
          if (svc._source === 'user-provided') {
            errors.push(`User-provided service '${name}' unreachable at ${endpoint.host}:${endpoint.port}`);
          } else {
            errors.push(`Auto-provisioned service '${name}' unreachable — Docker Compose may need restart`);
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    checks,
    errors,
    warnings,
    source: 'auto',
  };
}

// ── Architecture Cross-Validation ──────────────────────────

/**
 * Extract infrastructure dependencies declared in architecture.md.
 * Scans for service keywords (databases, caches, object storage, message queues, etc.)
 * and returns a list of expected infrastructure components.
 * @param {string} projectDir
 * @returns {{dependencies: object[], source: string|null}}
 */
function extractArchitectureDependencies(projectDir) {
  const outputRoot = path.join(projectDir, '_cobolt-output');
  const candidates = [
    path.join(outputRoot, 'latest', 'planning', 'architecture.md'),
    path.join(outputRoot, 'planning', 'architecture.md'),
  ];
  const archFile = candidates.find((f) => fs.existsSync(f));
  if (!archFile) return { dependencies: [], source: null };

  const rawContent = fs.readFileSync(archFile, 'utf8');

  // v0.40.5: Strip "alternatives / rejected / considered" content BEFORE
  // pattern-scanning so architecture-table rows that cite legacy options
  // (e.g. `| Primary write buffer | RocksDB | Valkey, NATS (deprecated) |`)
  // don't get flagged as declared infrastructure dependencies.
  //
  // Strategy — two passes:
  //   1) Line-level: drop any line that contains an explicit non-adopt marker.
  //   2) Table-column-aware: when a markdown table header names a column
  //      "Alternatives" / "Rejected" / "Considered" / "Superseded by" etc.,
  //      blank out the content of that column in every data row of the
  //      same table so the infra-pattern regex never sees those tokens.
  const ALT_COL_RE =
    /^\s*(alternatives?|rejected(?:\s+alternatives?)?|considered(?:\s+alternatives?)?|superseded\s+by|not\s+adopted|rejected\s+for)\s*$/i;

  function stripAlternativesColumns(md) {
    const lines = md.split('\n');
    const out = [];
    let inTable = false;
    let altColIdxs = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Detect a header row followed by a separator row like `| --- | --- |`
      const isHeaderLike = /^\s*\|.*\|\s*$/.test(line);
      const next = lines[i + 1] || '';
      const isSeparatorNext = /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(next);
      if (isHeaderLike && isSeparatorNext && !inTable) {
        inTable = true;
        const cols = line
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim());
        altColIdxs = cols.map((c, idx) => (ALT_COL_RE.test(c) ? idx : -1)).filter((idx) => idx >= 0);
        out.push(line);
        continue;
      }
      if (inTable) {
        // Still a table row?
        if (!/^\s*\|.*\|\s*$/.test(line)) {
          inTable = false;
          altColIdxs = [];
          out.push(line);
          continue;
        }
        if (altColIdxs.length > 0) {
          const cells = line.split('|');
          // cells[0] = leading '' or whitespace, cells[last] = trailing '' or whitespace
          // content cells are cells[1..length-2]
          for (const idx of altColIdxs) {
            const cellIdx = idx + 1;
            if (cellIdx >= 1 && cellIdx <= cells.length - 2) {
              cells[cellIdx] = ' (stripped) ';
            }
          }
          out.push(cells.join('|'));
        } else {
          out.push(line);
        }
      } else {
        out.push(line);
      }
    }
    return out.join('\n');
  }

  const content = stripAlternativesColumns(rawContent)
    .split('\n')
    .filter((line) => {
      // Line-level drop for explicit non-adopt markers outside tables.
      if (/\b(deprecated|superseded|legacy(\s+only)?|not\s+adopted|do\s+not\s+use|ruled\s+out)\b/i.test(line))
        return false;
      return true;
    })
    .join('\n');

  const dependencies = [];

  // Infrastructure service patterns with categories
  const INFRA_PATTERNS = [
    // Databases
    { pattern: /\b(?:PostgreSQL|Postgres|pg)\b/i, category: 'database', service: 'postgresql' },
    { pattern: /\bMySQL\b/i, category: 'database', service: 'mysql' },
    { pattern: /\bMongoDB\b/i, category: 'database', service: 'mongodb' },
    { pattern: /\bSQLite\b/i, category: 'database', service: 'sqlite', kind: 'embedded' },
    { pattern: /\bDuckDB\b/i, category: 'database', service: 'duckdb', kind: 'embedded' },
    // Caches
    { pattern: /\b(?:Redis|Valkey)\b/i, category: 'cache', service: 'redis' },
    { pattern: /\bMemcached\b/i, category: 'cache', service: 'memcached' },
    // Message queues
    { pattern: /\bNATS\b/, category: 'message-queue', service: 'nats' },
    { pattern: /\bRabbitMQ\b/i, category: 'message-queue', service: 'rabbitmq' },
    { pattern: /\bKafka\b/i, category: 'message-queue', service: 'kafka' },
    { pattern: /\b(?:Amazon\s+)?SQS\b/, category: 'message-queue', service: 'sqs' },
    // Object storage
    {
      pattern: /\b(?:Cloudflare\s+R2|R2\s+(?:bucket|storage|object|compatible))\b/i,
      category: 'object-storage',
      service: 'r2',
    },
    { pattern: /\b(?:Amazon\s+)?S3\b/, category: 'object-storage', service: 's3' },
    { pattern: /\bMinIO\b/i, category: 'object-storage', service: 'minio' },
    { pattern: /\bGCS\b|Google Cloud Storage/i, category: 'object-storage', service: 'gcs' },
    // Search
    { pattern: /\bElasticsearch\b/i, category: 'search', service: 'elasticsearch' },
    { pattern: /\bOpenSearch\b/i, category: 'search', service: 'opensearch' },
    { pattern: /\bMeilisearch\b/i, category: 'search', service: 'meilisearch' },
    { pattern: /\bTypesense\b/i, category: 'search', service: 'typesense' },
    // Monitoring
    { pattern: /\bPrometheus\b/i, category: 'monitoring', service: 'prometheus' },
    { pattern: /\bGrafana\b/i, category: 'monitoring', service: 'grafana' },
    { pattern: /\bJaeger\b/i, category: 'monitoring', service: 'jaeger' },
  ];

  const seen = new Set();
  for (const { pattern, category, service, kind } of INFRA_PATTERNS) {
    if (pattern.test(content) && !seen.has(service)) {
      seen.add(service);
      dependencies.push({ service, category, kind: kind || 'containerized' });
    }
  }

  return { dependencies, source: archFile };
}

/**
 * Cross-validate architecture dependencies against infra-manifest and .env.cobolt.
 * Returns missing dependencies that are declared in architecture but not provisioned.
 * @param {string} projectDir
 * @returns {{missing: object[], declared: number, provisioned: number, warnings: string[]}}
 */
function crossValidateArchitecture(projectDir) {
  const { dependencies, source } = extractArchitectureDependencies(projectDir);
  if (dependencies.length === 0) {
    return { missing: [], declared: 0, provisioned: 0, warnings: source ? [] : ['No architecture.md found'] };
  }

  // Load infra-manifest
  const manifestPath = path.join(projectDir, INFRA_MANIFEST);
  let manifestDescriptors = [];
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifestDescriptors = collectManifestServiceDescriptors(manifest);
    } catch {
      /* parse error */
    }
  }

  // Load .env.cobolt
  const envServices = new Set();
  const envPath = path.join(projectDir, '.env.cobolt');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    // Check for service-related env vars
    const envServiceMap = {
      postgresql: /COBOLT_DB_URL|DATABASE_URL=postgres|POSTGRES/i,
      mysql: /COBOLT_DB_URL.*mysql|MYSQL/i,
      mongodb: /COBOLT_DB_URL.*mongo|MONGODB/i,
      sqlite: /DATABASE_URL\s*=\s*sqlite|SQLITE_PATH|COBOLT_DB_URL\s*=\s*sqlite/i,
      duckdb: /DATABASE_URL\s*=\s*duckdb|DUCKDB_PATH/i,
      redis: /COBOLT_CACHE_URL|REDIS/i,
      nats: /NATS_URL|COBOLT_SVC_NATS/i,
      rabbitmq: /RABBITMQ_URL|AMQP_URL|COBOLT_SVC_RABBITMQ/i,
      kafka: /KAFKA_URL|COBOLT_SVC_KAFKA/i,
      sqs: /AWS_SQS|COBOLT_SVC_SQS/i,
      r2: /R2_BUCKET|R2_ACCESS|COBOLT_SVC_R2/i,
      s3: /S3_BUCKET|AWS_S3|COBOLT_SVC_S3/i,
      minio: /MINIO_URL|COBOLT_SVC_MINIO/i,
      elasticsearch: /ELASTICSEARCH_URL|COBOLT_SVC_ELASTIC/i,
      prometheus: /PROMETHEUS_URL|COBOLT_SVC_PROMETHEUS/i,
    };
    for (const [svc, pattern] of Object.entries(envServiceMap)) {
      if (pattern.test(envContent)) envServices.add(svc);
    }
  }

  // Docker Compose service detection
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  const composeFile = composeFiles.find((f) => fs.existsSync(path.join(projectDir, f)));
  const composeServices = new Set();
  if (composeFile) {
    const composeContent = fs.readFileSync(path.join(projectDir, composeFile), 'utf8');
    // Simple YAML service name extraction
    for (const dep of dependencies) {
      if (new RegExp(`\\b${dep.service}\\b`, 'i').test(composeContent)) {
        composeServices.add(dep.service);
      }
    }
  }

  const missing = [];
  const warnings = [];
  let provisioned = 0;

  for (const dep of dependencies) {
    const inManifest = manifestDescriptors.some((descriptor) => manifestDescriptorMatchesDependency(descriptor, dep));
    const inEnv = envServices.has(dep.service);
    const inCompose = composeServices.has(dep.service);

    if (inManifest || inEnv || inCompose) {
      provisioned++;
    } else {
      missing.push(dep);
      warnings.push(
        `Architecture declares ${dep.service} (${dep.category}) but it is not in infra-manifest, .env.cobolt, or Docker Compose`,
      );
    }
  }

  return { missing, declared: dependencies.length, provisioned, warnings };
}

// ── Main Validation Entry Point ─────────────────────────────

/**
 * Run full infrastructure validation for a milestone.
 * @param {string} projectDir
 * @param {object} opts
 * @param {string} opts.milestone - Milestone identifier (e.g. "M1")
 * @returns {{ready: boolean, source: string, checks: object[], errors: string[], warnings: string[], action: string}}
 */
function noDeclaredInfrastructure(projectDir) {
  const { dependencies, source } = extractArchitectureDependencies(projectDir);
  return {
    ok: Boolean(source) && dependencies.length === 0,
    source,
    dependencies,
  };
}

const SERVICE_ALIASES = {
  postgresql: ['postgresql', 'postgres', 'pg'],
  redis: ['redis', 'valkey'],
  r2: ['cloudflare r2', 'r2'],
  s3: ['amazon s3', 's3'],
  minio: ['minio'],
  gcs: ['gcs', 'google cloud storage'],
  sqs: ['amazon sqs', 'sqs'],
};

function descriptorText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(descriptorText).join(' ');
  if (typeof value === 'object') return Object.values(value).map(descriptorText).join(' ');
  return String(value);
}

function collectManifestServiceDescriptors(manifest) {
  const descriptors = [];
  const services = manifest?.services || manifest?.infrastructure?.services || {};
  if (services && typeof services === 'object' && !Array.isArray(services)) {
    for (const [key, service] of Object.entries(services)) {
      descriptors.push({ source: 'services', key, text: `${key} ${descriptorText(service)}` });
    }
  }

  const externalGroups = [
    ['managedServicesExternal', manifest?.managedServicesExternal],
    ['managedServices', manifest?.managedServices],
    ['externalServices', manifest?.externalServices],
  ];
  for (const [source, entries] of externalGroups) {
    if (!Array.isArray(entries)) continue;
    for (const [idx, entry] of entries.entries()) {
      const key = entry?.service || entry?.name || `${source}[${idx}]`;
      descriptors.push({ source, key, text: `${key} ${descriptorText(entry)}` });
    }
  }
  return descriptors;
}

function manifestDescriptorMatchesDependency(descriptor, dep) {
  const text = String(descriptor?.text || '').toLowerCase();
  const aliases = SERVICE_ALIASES[dep.service] || [dep.service];
  return aliases.some((alias) => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
  });
}

function validate(projectDir, opts = {}) {
  const milestone = opts.milestone || 'unknown';
  const envPath = path.join(projectDir, ENV_FILENAME);
  const manifestPath = path.join(projectDir, INFRA_MANIFEST);
  const hasUserInfra = fs.existsSync(envPath);
  const noInfra = !hasUserInfra && !fs.existsSync(manifestPath) ? noDeclaredInfrastructure(projectDir) : null;

  if (noInfra?.ok) {
    return {
      ready: true,
      source: 'none',
      milestone,
      checks: [
        {
          service: 'architecture-infra-dependencies',
          declared: 0,
          source: noInfra.source,
          skipped: true,
        },
      ],
      errors: [],
      warnings: ['No infrastructure dependencies declared by architecture.md; infra provisioning is not required.'],
      architectureDeps: { declared: 0, provisioned: 0, missing: [] },
      deployConsumerCensus: {
        ok: true,
        missing: [],
        platformType: null,
        target: null,
        probeKey: null,
        manifestPath,
        reason: 'no-declared-infrastructure',
      },
      action: 'proceed',
      exitCode: 0,
      infrastructureRequired: false,
    };
  }

  // Phase 1: Check Docker availability (required for all paths)
  const docker = checkDocker();
  if (!docker.available && !hasUserInfra) {
    return {
      ready: false,
      source: 'none',
      milestone,
      checks: [{ service: 'docker', available: false, error: docker.error }],
      errors: ['Docker is not available and no user infrastructure (.env.cobolt) configured.'],
      warnings: [],
      action: 'setup', // Redirect to cobolt-infra
      exitCode: 2,
    };
  }

  // Phase 2: User-provided infrastructure takes priority
  if (hasUserInfra) {
    const result = validateUserInfra(projectDir);
    // Phase 2b: Cross-validate against architecture.md
    const archCheck = crossValidateArchitecture(projectDir);
    result.warnings.push(...archCheck.warnings);
    if (archCheck.missing.length > 0) {
      result.errors.push(
        `Architecture declares ${archCheck.declared} infrastructure dependencies but ${archCheck.missing.length} are not provisioned: ${archCheck.missing.map((m) => `${m.service} (${m.category})`).join(', ')}`,
      );
    }
    const census = runDeployConsumerCensus(projectDir, result.checks);
    if (!census.ok) {
      for (const m of census.missing || []) {
        result.errors.push(
          `Deploy manifest census FAIL: ${m} required for platform "${census.platformType || '?'}" / probe "${census.probeKey || '?'}".`,
        );
      }
    }
    const ok = result.valid && archCheck.missing.length === 0 && census.ok;
    if (ok) stampManifestVerified(projectDir, result.checks);
    return {
      ready: ok,
      source: 'user',
      milestone,
      checks: result.checks,
      errors: result.errors,
      warnings: result.warnings,
      architectureDeps: {
        declared: archCheck.declared,
        provisioned: archCheck.provisioned,
        missing: archCheck.missing,
      },
      deployConsumerCensus: census,
      action: ok ? 'proceed' : 'hard-stop',
      exitCode: ok ? 0 : 1,
    };
  }

  // Phase 3: Auto-provisioned infrastructure
  const result = validateAutoInfra(projectDir);
  // Phase 3b: Cross-validate against architecture.md
  const archCheck = crossValidateArchitecture(projectDir);
  result.warnings.push(...archCheck.warnings);
  if (archCheck.missing.length > 0) {
    result.warnings.push(
      `Architecture declares ${archCheck.missing.length} unprovisioned service(s): ${archCheck.missing.map((m) => m.service).join(', ')}. Run /cobolt-infra to provision.`,
    );
  }
  const census = runDeployConsumerCensus(projectDir, result.checks);
  if (!census.ok) {
    for (const m of census.missing || []) {
      result.errors.push(
        `Deploy manifest census FAIL: ${m} required for platform "${census.platformType || '?'}" / probe "${census.probeKey || '?'}".`,
      );
    }
  }
  const ok = result.valid && census.ok;
  if (ok) stampManifestVerified(projectDir, result.checks);
  return {
    ready: ok,
    source: 'auto',
    milestone,
    checks: result.checks,
    errors: result.errors,
    warnings: result.warnings,
    architectureDeps: { declared: archCheck.declared, provisioned: archCheck.provisioned, missing: archCheck.missing },
    deployConsumerCensus: census,
    action: ok ? 'proceed' : 'setup',
    exitCode: ok ? 0 : 2,
  };
}

/**
 * Census-check the deploy-consumer fields in the infra manifest.
 * Issue 18 (v0.40.6) — fail-closed at infra time so deploy never reads
 * nulls for compute.registry / rollback_method / per-platform rollback
 * anchors.
 *
 * @param {string} projectDir
 * @param {object[]} [checks] — existing checks array to append the census record onto
 * @returns {{ok: boolean, missing: string[], platformType: string|null, target: string|null, probeKey: string|null, manifestPath: string, reason?: string}}
 */
function runDeployConsumerCensus(projectDir, checks) {
  const manifestPath = path.join(projectDir, INFRA_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    const record = {
      ok: false,
      missing: ['infra-manifest.json not found — cannot census deploy-consumer fields'],
      platformType: null,
      target: null,
      probeKey: null,
      manifestPath,
      reason: 'manifest-absent',
    };
    if (Array.isArray(checks)) checks.push({ service: 'deploy-consumer-census', ok: false, reason: record.reason });
    return record;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    const record = {
      ok: false,
      missing: [`infra-manifest.json malformed: ${e.message}`],
      platformType: null,
      target: null,
      probeKey: null,
      manifestPath,
      reason: 'manifest-malformed',
    };
    if (Array.isArray(checks)) checks.push({ service: 'deploy-consumer-census', ok: false, reason: record.reason });
    return record;
  }
  const census = censusDeployFields(manifest);
  const record = { ...census, manifestPath };
  if (Array.isArray(checks)) {
    checks.push({
      service: 'deploy-consumer-census',
      ok: census.ok,
      platformType: census.platformType,
      probeKey: census.probeKey,
      missing: census.missing,
    });
  }
  return record;
}

/**
 * Stamp verified: true + verifiedAt on the manifest, preserving staleness
 * defaults when absent. Safe to call repeatedly; last write wins.
 */
function stampManifestVerified(projectDir, _checks) {
  const manifestPath = path.join(projectDir, INFRA_MANIFEST);
  if (!fs.existsSync(manifestPath)) return;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return;
  }
  manifest.verified = true;
  manifest.verifiedAt = new Date().toISOString();
  if (!manifest.staleness || typeof manifest.staleness !== 'object') {
    manifest.staleness = { maxAgeSec: 3600, reprobeOnDeploy: true };
  }
  try {
    atomicWriteJSON(manifestPath, manifest, { mode: 0o600 });
  } catch {
    /* best-effort stamp — the in-memory verdict is authoritative. */
  }
}

// ── CLI ─────────────────────────────────────────────────────

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const icon = result.ready ? 'PASS' : 'FAIL';
  console.log(`\n=== Infrastructure Check: ${icon} ===`);
  console.log(`Milestone: ${result.milestone}`);
  console.log(`Source: ${result.source}`);
  console.log(`Action: ${result.action}`);
  console.log('');

  if (result.checks.length > 0) {
    console.log('Service Checks:');
    for (const check of result.checks) {
      const status = check.ok === true || check.reachable || check.available || check.running ? 'OK' : 'FAIL';
      const name = check.service;
      const detail = check.error ? ` (${check.error})` : check.latencyMs ? ` (${check.latencyMs}ms)` : '';
      console.log(`  [${status}] ${name}${detail}`);
    }
    console.log('');
  }

  if (result.errors.length > 0) {
    console.log('Errors:');
    for (const err of result.errors) {
      console.log(`  ERROR: ${err}`);
    }
    console.log('');
  }

  if (result.warnings.length > 0) {
    console.log('Warnings:');
    for (const warn of result.warnings) {
      console.log(`  WARN: ${warn}`);
    }
    console.log('');
  }

  if (result.action === 'hard-stop') {
    console.log('ACTION REQUIRED: User-provided infrastructure is not reachable.');
    console.log('Fix the services declared in .env.cobolt and retry.');
    console.log('This is a HARD STOP — build cannot proceed with unreachable infrastructure.');
  } else if (result.action === 'setup') {
    console.log('ACTION REQUIRED: Infrastructure needs to be provisioned.');
    console.log('Run: /cobolt-infra --auto');
  }
}

function main() {
  const args = process.argv.slice(2);
  // --help / -h → print usage to stdout and exit 0. Must come BEFORE the
  // `command || 'validate'` default-assignment so --help does not silently
  // run validation.
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: node tools/cobolt-infra-check.js [validate|status|parity|mirror-prod|ensure-playwright] [--json] [--milestone M1] [--autonomous] [--ensure-embedded]',
    );
    process.exit(0);
  }
  const command = args[0] || 'validate';
  const json = args.includes('--json');
  const milestone = (() => {
    const idx = args.indexOf('--milestone');
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : 'unknown';
  })();

  const projectDir = process.cwd();

  // Allow `--mirror-prod` as a top-level flag (no subcommand required).
  if (args.includes('--mirror-prod') && command !== 'mirror-prod') {
    const res = applyMirrorProd(projectDir);
    if (json) console.log(JSON.stringify(res, null, 2));
    else {
      console.log(`mirror-prod: ${res.applied ? 'applied' : 'failed'}`);
      console.log(`  manifest: ${res.manifestPath}`);
      console.log(`  plan: ${res.planPath}`);
    }
    if (command === 'status' || command === 'mirror-prod') process.exit(res.applied ? 0 : 1);
    // otherwise fall through to the requested subcommand
  }

  if (command === 'status') {
    const docker = checkDocker();
    const hasEnv = fs.existsSync(path.join(projectDir, ENV_FILENAME));
    const hasManifest = fs.existsSync(path.join(projectDir, INFRA_MANIFEST));
    const status = {
      docker: docker.available,
      dockerVersion: docker.version,
      userInfra: hasEnv,
      infraManifest: hasManifest,
    };
    if (json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(`Docker: ${docker.available ? `OK (${docker.version})` : 'NOT AVAILABLE'}`);
      console.log(`User infra (.env.cobolt): ${hasEnv ? 'YES' : 'NO'}`);
      console.log(`Infra manifest: ${hasManifest ? 'YES' : 'NO'}`);
    }
    process.exit(0);
  }

  if (command === 'validate') {
    const result = validate(projectDir, { milestone });
    printResult(result, json);
    process.exit(result.exitCode);
  }

  if (command === 'mirror-prod') {
    const res = applyMirrorProd(projectDir);
    if (json) console.log(JSON.stringify(res, null, 2));
    else {
      console.log(`mirror-prod: ${res.applied ? 'applied' : 'failed'}`);
      console.log(`  manifest: ${res.manifestPath}`);
      console.log(`  plan: ${res.planPath}`);
      if (res.warnings?.length) {
        for (const w of res.warnings) console.log(`  WARN: ${w}`);
      }
    }
    process.exit(res.applied ? 0 : 1);
  }

  if (command === 'parity') {
    const autonomous = args.includes('--autonomous');
    const ensure = args.includes('--ensure-embedded');
    let ensureResult = null;
    if (ensure) ensureResult = ensureEmbeddedEntries(projectDir);
    const result = parityCheck(projectDir);
    const payload = { ...result, ensureResult };
    if (json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`\n=== Architecture ↔ Infra Parity ===`);
      console.log(`Declared services: ${result.declared}`);
      console.log(`Matched: ${result.matched}`);
      console.log(`Missing: ${result.missing.length}`);
      for (const m of result.missing) {
        console.log(`  MISSING: ${m.service} (${m.category}, ${m.kind})`);
      }
      if (ensureResult) {
        console.log(`Ensure-embedded applied: ${ensureResult.applied} action(s)`);
      }
    }
    if (!result.ok && autonomous) process.exit(1);
    process.exit(result.ok ? 0 : result.missing.length > 0 ? 1 : 0);
  }

  if (command === 'ensure-playwright') {
    const res = ensurePlaywright(projectDir);
    if (json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`ensure-playwright: ${res.ok ? 'OK' : 'FAILED'}`);
      for (const a of res.actions) console.log(`  - ${a}`);
      if (res.reason) console.log(`  reason: ${res.reason}`);
    }
    process.exit(res.ok ? 0 : 1);
  }

  console.error(`Unknown command: ${command}`);
  console.error(
    'Usage: node tools/cobolt-infra-check.js [validate|status|parity|mirror-prod|ensure-playwright] [--json] [--milestone M1] [--autonomous] [--ensure-embedded]',
  );
  process.exit(1);
}

// Idempotently ensure the Playwright browser service is present in
// docker-compose.yml. Owns the "append if missing, update if stale"
// logic so the infra SKILL is not relying on prose-described actions.
const PLAYWRIGHT_IMAGE = 'mcr.microsoft.com/playwright:v1.52.0-noble';
const PLAYWRIGHT_SERVICE_NAME = 'playwright';

function ensurePlaywright(projectDir) {
  const actions = [];
  // Resolve docker-compose.yml — check both project root and app/ subdir.
  const candidates = [
    path.join(projectDir, 'docker-compose.yml'),
    path.join(projectDir, 'docker-compose.yaml'),
    path.join(projectDir, 'app', 'docker-compose.yml'),
  ];
  const composePath = candidates.find((p) => fs.existsSync(p));
  if (!composePath) {
    return {
      ok: false,
      actions,
      reason:
        'docker-compose.yml not found at project root or app/ — cobolt-infra must generate the base compose file before ensure-playwright runs.',
    };
  }
  let content;
  try {
    content = fs.readFileSync(composePath, 'utf8');
  } catch (e) {
    return { ok: false, actions, reason: `cannot read ${composePath}: ${e.message}` };
  }

  const serviceRegex = new RegExp(`^\\s{2}${PLAYWRIGHT_SERVICE_NAME}\\s*:`, 'm');
  const present = serviceRegex.test(content);
  const staleImage =
    present && /^\s*image:\s*mcr\.microsoft\.com\/playwright:/m.test(content) && !content.includes(PLAYWRIGHT_IMAGE);

  if (present && !staleImage) {
    actions.push(`${PLAYWRIGHT_SERVICE_NAME} service already present and pinned to ${PLAYWRIGHT_IMAGE}`);
    return { ok: true, actions };
  }

  const block = [
    '',
    `  ${PLAYWRIGHT_SERVICE_NAME}:`,
    `    image: ${PLAYWRIGHT_IMAGE}`,
    `    volumes:`,
    `      - .:/app`,
    `    working_dir: /app`,
    `    network_mode: service:app`,
    `    entrypoint: ["sleep", "infinity"]`,
    `    depends_on:`,
    `      - app`,
    '',
  ].join('\n');

  if (staleImage) {
    // Replace existing image line under the playwright service.
    const updated = content.replace(
      /(\n\s{2}playwright\s*:\n(?:\s{4}.*\n)*?\s{4}image:\s*)[^\n]+/,
      `$1${PLAYWRIGHT_IMAGE}`,
    );
    if (updated !== content) {
      fs.writeFileSync(composePath, updated);
      actions.push(`updated ${PLAYWRIGHT_SERVICE_NAME} image pin → ${PLAYWRIGHT_IMAGE}`);
      return { ok: true, actions };
    }
    return {
      ok: false,
      actions,
      reason: 'stale image detected but regex replacement did not match — manual review needed',
    };
  }

  // Append. Find the top-level `services:` key and append under it.
  if (!/^services\s*:/m.test(content)) {
    return { ok: false, actions, reason: '`services:` root key not found in compose file' };
  }
  // Append just before `volumes:` root key if present, else at EOF.
  const volumesIdx = content.search(/^volumes\s*:/m);
  const next =
    volumesIdx >= 0 ? `${content.slice(0, volumesIdx) + block}\n${content.slice(volumesIdx)}` : content + block;
  fs.writeFileSync(composePath, next);
  actions.push(`appended ${PLAYWRIGHT_SERVICE_NAME} service to ${composePath}`);
  return { ok: true, actions };
}

/**
 * Apply --mirror-prod to the infra manifest and write a scaffold plan.
 * Sets `staging.mirrorProd = true` and `staging.priorMilestonesLive = true`.
 * Scaffold only — does not provision anything.
 */
function applyMirrorProd(projectDir) {
  const manifestPath = path.join(projectDir, INFRA_MANIFEST);
  const planDir = path.join(projectDir, '_cobolt-output', 'infra');
  const planPath = path.join(planDir, 'mirror-prod-plan.md');
  const warnings = [];
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      warnings.push(`Cannot parse existing manifest: ${e.message}`);
    }
  }
  manifest = manifest || {};
  manifest.staging = manifest.staging || {};
  manifest.staging.mirrorProd = true;
  manifest.staging.priorMilestonesLive = true;
  manifest.staging.mirroredAt = new Date().toISOString();

  // Gather prod tiers from deploy-plan.md if present (stub otherwise).
  const deployPlanPath = path.join(projectDir, '_cobolt-output', 'latest', 'deploy', 'deploy-plan.md');
  const tiers = [];
  if (fs.existsSync(deployPlanPath)) {
    try {
      const dp = fs.readFileSync(deployPlanPath, 'utf8');
      const re = /^\s*[-*]\s+(.+?:\s*.+)$/gm;
      let m;
      while ((m = re.exec(dp)) && tiers.length < 50) tiers.push(m[1].trim());
    } catch (e) {
      warnings.push(`deploy-plan read failed: ${e.message}`);
    }
  } else {
    warnings.push('deploy-plan.md absent — producing stub plan');
  }

  // Ensure manifest dir exists; write atomically.
  try {
    atomicWriteJSON(manifestPath, manifest, { mode: 0o600 });
  } catch (e) {
    warnings.push(`manifest write failed: ${e.message}`);
    return { applied: false, manifestPath, planPath, warnings };
  }

  const lines = [
    '# Mirror-Prod Staging Plan',
    '',
    `> Generated: ${new Date().toISOString()}`,
    '',
    '## Intent',
    '',
    'Staging environment must mirror production: same managed-service tiers, same',
    'prior-milestone services running live. Exact production parity at scaffold level.',
    '',
    '## Would Provision',
    '',
  ];
  if (tiers.length) {
    lines.push('_Derived from `_cobolt-output/latest/deploy/deploy-plan.md`._');
    lines.push('');
    for (const t of tiers) lines.push(`- ${t}`);
  } else {
    lines.push('_No `deploy-plan.md` found; stub entries below. Populate once deploy plan exists._');
    lines.push('');
    lines.push('- Database: mirror prod tier (size/IOPS/HA)');
    lines.push('- Cache: mirror prod tier');
    lines.push('- Queue/Broker: mirror prod tier');
    lines.push('- Object storage: mirror prod bucket class');
    lines.push('- Secrets manager: mirror prod engine');
    lines.push('- Observability: mirror prod log/metrics/trace backends');
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- Actual provisioning is out of scope for this scaffold.');
  lines.push('- `infra-manifest.json` now carries `staging.mirrorProd: true` +');
  lines.push('  `staging.priorMilestonesLive: true`. Downstream `cobolt-deploy`');
  lines.push('  reads these flags to enforce parity.');
  lines.push('');

  atomicWrite(planPath, lines.join('\n'), { mode: 0o600 });

  // Terraform skeleton emission (non-breaking: skipped when deploy-plan absent).
  let terraform = null;
  if (fs.existsSync(deployPlanPath)) {
    try {
      terraform = emitTerraformSkeleton(projectDir, deployPlanPath);
    } catch (e) {
      warnings.push(`terraform skeleton emit failed: ${e.message}`);
    }
  }

  return { applied: true, manifestPath, planPath, terraform, warnings };
}

/**
 * Emit a minimal Terraform HCL skeleton under
 * `_cobolt-output/infra/mirror-prod/terraform/main.tf` when the deploy
 * target is k8s|ecs|cloud-run AND `deploy-plan.md` declares managed
 * services. Scaffold-only: does NOT run terraform. Returns null when
 * conditions not met.
 */
function emitTerraformSkeleton(projectDir, deployPlanPath) {
  const dp = fs.readFileSync(deployPlanPath, 'utf8');
  const targetMatch = dp.match(/\b(k8s|kubernetes|ecs|cloud[-\s]?run|eks|gke|aks)\b/i);
  if (!targetMatch) return null;
  const target = targetMatch[1].toLowerCase().replace(/\s+/g, '-');

  // Pick provider based on target + content hints.
  let provider = 'aws';
  if (/gcp|gke|cloud-?run|google/i.test(dp)) provider = 'gcp';
  else if (/azure|aks/i.test(dp)) provider = 'azure';
  else if (/ecs|eks|aws/i.test(dp)) provider = 'aws';

  // Detect managed services from deploy-plan.
  const services = [];
  const svcPatterns = [
    {
      re: /\b(RDS|Postgres(QL)?|MySQL|Aurora)\b/i,
      kind: 'postgres',
      aws: 'aws_db_instance',
      gcp: 'google_sql_database_instance',
      azure: 'azurerm_postgresql_flexible_server',
    },
    {
      re: /\b(ElastiCache|Redis|Memorystore)\b/i,
      kind: 'redis',
      aws: 'aws_elasticache_cluster',
      gcp: 'google_redis_instance',
      azure: 'azurerm_redis_cache',
    },
    {
      re: /\b(S3|GCS|Cloud Storage|Blob Storage)\b/i,
      kind: 'object-storage',
      aws: 'aws_s3_bucket',
      gcp: 'google_storage_bucket',
      azure: 'azurerm_storage_account',
    },
    {
      re: /\b(SQS|Pub\/?Sub|Service Bus|Kafka|MSK)\b/i,
      kind: 'queue',
      aws: 'aws_sqs_queue',
      gcp: 'google_pubsub_topic',
      azure: 'azurerm_servicebus_queue',
    },
  ];
  const seen = new Set();
  for (const sp of svcPatterns) {
    if (sp.re.test(dp) && !seen.has(sp.kind)) {
      seen.add(sp.kind);
      services.push({ kind: sp.kind, resource: sp[provider] });
    }
  }
  if (services.length === 0) return null;

  const tfDir = path.join(projectDir, '_cobolt-output', 'infra', 'mirror-prod', 'terraform');
  fs.mkdirSync(tfDir, { recursive: true, mode: 0o700 });

  const providerBlocks = {
    aws: `terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "~> 5.0" }\n  }\n}\n\nprovider "aws" {\n  region = var.region\n}\n\nvariable "region" { default = "us-east-1" }\nvariable "environment" { default = "staging" }\n`,
    gcp: `terraform {\n  required_providers {\n    google = { source = "hashicorp/google", version = "~> 5.0" }\n  }\n}\n\nprovider "google" {\n  project = var.project_id\n  region  = var.region\n}\n\nvariable "project_id" {}\nvariable "region" { default = "us-central1" }\nvariable "environment" { default = "staging" }\n`,
    azure: `terraform {\n  required_providers {\n    azurerm = { source = "hashicorp/azurerm", version = "~> 3.0" }\n  }\n}\n\nprovider "azurerm" {\n  features {}\n}\n\nvariable "location" { default = "eastus" }\nvariable "resource_group_name" { default = "mirror-prod-staging" }\nvariable "environment" { default = "staging" }\n`,
  };

  const resourceStubs = services
    .map((s) => {
      const name = `mirror_prod_${s.kind.replace(/-/g, '_')}`;
      return `# ${s.kind} — scaffold stub. Replace defaults to match production tier.\nresource "${s.resource}" "${name}" {\n  # TODO: fill required arguments per provider docs.\n  # Example placeholder tag to identify mirror-prod resources:\n  # tags = { Environment = var.environment, Origin = "cobolt-mirror-prod" }\n}\n`;
    })
    .join('\n');

  const mainTf = [
    `# Mirror-Prod Terraform Skeleton`,
    `# Generated: ${new Date().toISOString()}`,
    `# Target: ${target}    Provider: ${provider}`,
    `# Scaffold only — run \`terraform init && terraform plan\` to validate.`,
    `# Do NOT \`terraform apply\` without filling the TODO fields and reviewing.`,
    ``,
    providerBlocks[provider],
    ``,
    resourceStubs,
  ].join('\n');

  atomicWrite(path.join(tfDir, 'main.tf'), mainTf, { mode: 0o600 });

  const readme = [
    `# Mirror-Prod Terraform Skeleton`,
    ``,
    `These files are SCAFFOLDS generated by \`cobolt-infra-check.js --mirror-prod\`.`,
    ``,
    `- Provider: **${provider}**`,
    `- Target:   **${target}**`,
    `- Services: ${services.map((s) => s.kind).join(', ')}`,
    ``,
    `## How to use`,
    ``,
    `1. Review \`main.tf\` — every resource has TODO markers.`,
    `2. Fill required arguments per the provider docs.`,
    `3. Run \`terraform init && terraform plan\` to validate.`,
    `4. Review the plan and only then \`terraform apply\`.`,
    ``,
    `These scaffolds are NOT executed by CoBolt. They exist so operators can`,
    `see exactly what a production-parity staging environment would provision.`,
    ``,
  ].join('\n');
  atomicWrite(path.join(tfDir, 'README.md'), readme, { mode: 0o600 });

  return { dir: tfDir, provider, target, services: services.map((s) => s.kind) };
}

// ── Architecture ↔ Infra Parity Gate ───────────────────────

/**
 * Default file path for an embedded DB of the given engine.
 * @param {string} service
 * @returns {string}
 */
function defaultEmbeddedPath(service) {
  if (service === 'sqlite') return './data/app.db';
  if (service === 'duckdb') return './data/app.duckdb';
  return `./data/${service}.db`;
}

/**
 * Default DATABASE_URL for an embedded DB.
 * @param {string} service
 * @param {string} filePath
 */
function defaultEmbeddedUrl(service, filePath) {
  return `${service}:${filePath}`;
}

/**
 * Ensure the manifest contains an entry for each architecture-declared
 * embedded database, plus emit a `.env.cobolt` entry. Returns the actions
 * applied. Idempotent — never overwrites an existing services entry.
 * @param {string} projectDir
 */
function ensureEmbeddedEntries(projectDir) {
  const { dependencies } = extractArchitectureDependencies(projectDir);
  const embedded = dependencies.filter((d) => d.kind === 'embedded');
  const actions = [];
  if (embedded.length === 0) return { actions, applied: 0 };

  const manifestPath = path.join(projectDir, INFRA_MANIFEST);
  let manifest = {};
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      manifest = {};
    }
  }
  manifest.services = manifest.services || {};

  for (const dep of embedded) {
    const filePath = defaultEmbeddedPath(dep.service);
    const url = defaultEmbeddedUrl(dep.service, filePath);
    if (!manifest.services[dep.service]) {
      manifest.services[dep.service] = {
        kind: 'embedded',
        category: dep.category,
        engine: dep.service,
        file: filePath,
        url,
        containerized: false,
        _source: 'auto-provisioned',
        _note: 'Embedded/file-based database — no Docker service required.',
      };
      actions.push({ action: 'added-manifest', service: dep.service, file: filePath });
    }
  }

  atomicWriteJSON(manifestPath, manifest, { mode: 0o600 });

  // Append env entries if missing.
  const envPath = path.join(projectDir, ENV_FILENAME);
  let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  for (const dep of embedded) {
    const filePath = defaultEmbeddedPath(dep.service);
    const url = defaultEmbeddedUrl(dep.service, filePath);
    if (!/^\s*DATABASE_URL\s*=/m.test(envContent)) {
      envContent += `${envContent.endsWith('\n') || envContent === '' ? '' : '\n'}DATABASE_URL=${url}\n`;
      actions.push({ action: 'added-env', service: dep.service, url });
    }
  }
  if (envContent) {
    fs.writeFileSync(envPath, envContent, { mode: 0o600 });
  }

  return { actions, applied: actions.length };
}

/**
 * Architecture ↔ Infra parity check. Compares architecture.md declared
 * services against infra-manifest.json. Returns a deterministic verdict.
 * @param {string} projectDir
 */
function parityCheck(projectDir) {
  const { dependencies, source } = extractArchitectureDependencies(projectDir);
  const manifestPath = path.join(projectDir, INFRA_MANIFEST);
  const manifestExists = fs.existsSync(manifestPath);
  let manifestDescriptors = [];
  if (manifestExists) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifestDescriptors = collectManifestServiceDescriptors(manifest);
    } catch {
      /* parse error */
    }
  }

  const envPath = path.join(projectDir, ENV_FILENAME);
  const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

  const matched = [];
  const missing = [];
  for (const dep of dependencies) {
    const manifestEntry = manifestDescriptors.find((descriptor) =>
      manifestDescriptorMatchesDependency(descriptor, dep),
    );
    const envHit =
      dep.service === 'sqlite'
        ? /DATABASE_URL\s*=\s*sqlite/i.test(envContent)
        : dep.service === 'duckdb'
          ? /DATABASE_URL\s*=\s*duckdb/i.test(envContent)
          : new RegExp(`\\b${dep.service.toUpperCase()}\\b`, 'i').test(envContent);

    if (manifestEntry || envHit) {
      matched.push({
        ...dep,
        manifestKey: manifestEntry?.key || null,
        manifestSource: manifestEntry?.source || null,
        envHit,
      });
    } else {
      missing.push(dep);
    }
  }

  const noDeclaredInfra = Boolean(source) && dependencies.length === 0;
  const ok = noDeclaredInfra || (missing.length === 0 && dependencies.length > 0 && manifestExists);
  return {
    ok,
    source,
    manifestExists,
    declared: dependencies.length,
    matched: matched.length,
    missing,
    matchedDetail: matched,
    skipped: noDeclaredInfra,
    reason: noDeclaredInfra ? 'no declared infrastructure dependencies' : undefined,
  };
}

if (require.main === module) {
  main();
}

module.exports = {
  validate,
  checkDocker,
  checkDockerCompose,
  validateUserInfra,
  validateAutoInfra,
  extractArchitectureDependencies,
  noDeclaredInfrastructure,
  crossValidateArchitecture,
  applyMirrorProd,
  emitTerraformSkeleton,
  ensureEmbeddedEntries,
  parityCheck,
  defaultEmbeddedPath,
  defaultEmbeddedUrl,
  ensurePlaywright,
  runDeployConsumerCensus,
  stampManifestVerified,
};
