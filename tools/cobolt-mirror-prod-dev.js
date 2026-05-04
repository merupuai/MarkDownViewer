#!/usr/bin/env node
// Production-mirror for DEVELOPMENT: emits a docker-compose.mirror.yml with
// prod-shaped managed-service stand-ins so dev + staging test against engines
// that behave like the prod targets — without invoking any cloud provider.
//
// Complements tools/cobolt-infra-check.js applyMirrorProd() (which handles the
// cloud-side Terraform skeleton for staging). This tool is the dev-side
// companion: same topology, local containers.
//
// Usage:
//   node tools/cobolt-mirror-prod-dev.js emit    # write docker-compose.mirror.yml
//   node tools/cobolt-mirror-prod-dev.js up      # docker compose -f ... up -d
//   node tools/cobolt-mirror-prod-dev.js down    # docker compose -f ... down
//   node tools/cobolt-mirror-prod-dev.js status  # health of mirror services
//
// Service inference: reads _cobolt-output/latest/deploy/deploy-plan.md and
// _cobolt-output/latest/infra/infra-manifest.json to pick engines + versions
// that match prod. Falls back to sensible defaults when either is absent.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CWD = process.cwd();
const cmd = process.argv[2] || 'help';
const OUT = path.join(CWD, 'docker-compose.mirror.yml');
const ENV_OUT = path.join(CWD, '.env.mirror');

function readJSON(p, d = {}) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return d;
  }
}
function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

// ── Service inference ─────────────────────────────────────────────────────

function inferServices() {
  const manifest = readJSON(path.join(CWD, '_cobolt-output', 'latest', 'infra', 'infra-manifest.json'));
  const deployPlan = readText(path.join(CWD, '_cobolt-output', 'latest', 'deploy', 'deploy-plan.md'));
  const combined = `${deployPlan}\n${JSON.stringify(manifest)}`.toLowerCase();

  const services = [];

  // Postgres — match major version if declared, else 16 (current LTS).
  const pgMatch = combined.match(/postgres(?:ql)?[^\n]*?(\d{2})(?:\.\d+)?/);
  const pgVersion = pgMatch ? pgMatch[1] : '16';
  if (/postgres|rds|cloud[-\s]?sql|supabase|neon|aurora/.test(combined)) {
    services.push({
      name: 'postgres',
      image: `postgres:${pgVersion}-alpine`,
      ports: ['5432:5432'],
      env: ['POSTGRES_PASSWORD=${MIRROR_POSTGRES_PASSWORD:-mirror}', 'POSTGRES_DB=app'],
      volumes: ['mirror-pg:/var/lib/postgresql/data'],
      healthcheck: { test: ['CMD-SHELL', 'pg_isready -U postgres'], interval: '5s', retries: 10 },
    });
  }

  // Redis — cluster mode if prod runs cluster, else standalone 7.
  if (/redis|elasticache|memorystore/.test(combined)) {
    const cluster = /cluster/.test(combined);
    services.push({
      name: 'redis',
      image: cluster ? 'bitnami/redis-cluster:7.2' : 'redis:7-alpine',
      ports: ['6379:6379'],
      env: cluster
        ? ['REDIS_CLUSTER_REPLICAS=0', 'REDIS_NODES=redis', 'ALLOW_EMPTY_PASSWORD=yes', 'REDIS_CLUSTER_CREATOR=yes']
        : [],
      healthcheck: { test: ['CMD', 'redis-cli', 'ping'], interval: '5s', retries: 10 },
    });
  }

  // S3-like object storage — LocalStack when AWS detected, else MinIO.
  if (/\bs3\b|minio|object[-\s]?storage|blob/.test(combined)) {
    if (/\baws\b|\bs3\b|eks|ecs|lambda|rds/.test(combined)) {
      services.push({
        name: 'localstack',
        image: 'localstack/localstack:3',
        ports: ['4566:4566'],
        env: ['SERVICES=s3,sqs,sns,secretsmanager,dynamodb', 'DEFAULT_REGION=us-east-1'],
        healthcheck: {
          test: ['CMD', 'curl', '-sf', 'http://localhost:4566/_localstack/health'],
          interval: '5s',
          retries: 20,
        },
      });
    } else {
      services.push({
        name: 'minio',
        image: 'minio/minio:latest',
        command: 'server /data --console-address ":9001"',
        ports: ['9000:9000', '9001:9001'],
        env: ['MINIO_ROOT_USER=mirror', 'MINIO_ROOT_PASSWORD=mirrormirror'],
        volumes: ['mirror-minio:/data'],
        healthcheck: {
          test: ['CMD', 'curl', '-sf', 'http://localhost:9000/minio/health/live'],
          interval: '5s',
          retries: 10,
        },
      });
    }
  }

  // Kafka / pub-sub.
  if (/kafka|msk|kinesis|pubsub|event[-\s]?hub/.test(combined)) {
    services.push({
      name: 'kafka',
      image: 'bitnami/kafka:3.6',
      ports: ['9092:9092'],
      env: [
        'KAFKA_CFG_NODE_ID=1',
        'KAFKA_CFG_PROCESS_ROLES=controller,broker',
        'KAFKA_CFG_LISTENERS=PLAINTEXT://:9092,CONTROLLER://:9093',
        'KAFKA_CFG_ADVERTISED_LISTENERS=PLAINTEXT://kafka:9092',
        'KAFKA_CFG_CONTROLLER_LISTENER_NAMES=CONTROLLER',
        'KAFKA_CFG_CONTROLLER_QUORUM_VOTERS=1@kafka:9093',
        'KAFKA_CFG_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
      ],
      healthcheck: {
        test: ['CMD-SHELL', 'kafka-topics.sh --bootstrap-server localhost:9092 --list'],
        interval: '10s',
        retries: 15,
      },
    });
  }

  // Observability — Jaeger for tracing, Prometheus for metrics (needed by
  // cobolt-load-chaos real scraping — closes the S3 feedback loop).
  if (/observability|opentelemetry|otel|jaeger|datadog|new[-\s]?relic|prometheus|grafana/.test(combined)) {
    services.push({
      name: 'prometheus',
      image: 'prom/prometheus:latest',
      ports: ['9090:9090'],
      volumes: ['./infra/mirror/prometheus.yml:/etc/prometheus/prometheus.yml:ro'],
    });
    services.push({
      name: 'jaeger',
      image: 'jaegertracing/all-in-one:latest',
      ports: ['16686:16686', '4317:4317', '4318:4318'],
      env: ['COLLECTOR_OTLP_ENABLED=true'],
    });
  }

  // Elasticsearch / OpenSearch.
  if (/elasticsearch|opensearch|algolia/.test(combined)) {
    services.push({
      name: 'opensearch',
      image: 'opensearchproject/opensearch:2',
      ports: ['9200:9200'],
      env: [
        'discovery.type=single-node',
        'DISABLE_SECURITY_PLUGIN=true',
        'OPENSEARCH_INITIAL_ADMIN_PASSWORD=MirrorMirror1!',
      ],
      volumes: ['mirror-os:/usr/share/opensearch/data'],
    });
  }

  // RabbitMQ.
  if (/rabbit|amqp/.test(combined)) {
    services.push({
      name: 'rabbitmq',
      image: 'rabbitmq:3-management-alpine',
      ports: ['5672:5672', '15672:15672'],
    });
  }

  return services;
}

// ── YAML emission (hand-rolled — no js-yaml dep) ──────────────────────────

function yamlDump(services) {
  const volumes = new Set();
  const lines = [
    '# AUTO-GENERATED by cobolt-mirror-prod-dev.js. Safe to edit; re-emit overwrites.',
    '# docker compose -f docker-compose.mirror.yml up -d',
    `# Regenerate: node tools/cobolt-mirror-prod-dev.js emit`,
    '',
    'services:',
  ];
  for (const s of services) {
    lines.push(`  ${s.name}:`);
    lines.push(`    image: ${s.image}`);
    if (s.command) lines.push(`    command: ${JSON.stringify(s.command)}`);
    if (s.ports) {
      lines.push('    ports:');
      for (const p of s.ports) lines.push(`      - "${p}"`);
    }
    if (s.env?.length) {
      lines.push('    environment:');
      for (const e of s.env) lines.push(`      - ${e}`);
    }
    if (s.volumes?.length) {
      lines.push('    volumes:');
      for (const v of s.volumes) {
        lines.push(`      - ${v}`);
        const named = v.split(':')[0];
        if (!named.startsWith('.') && !named.startsWith('/')) volumes.add(named);
      }
    }
    if (s.healthcheck) {
      lines.push('    healthcheck:');
      lines.push(`      test: ${JSON.stringify(s.healthcheck.test)}`);
      if (s.healthcheck.interval) lines.push(`      interval: ${s.healthcheck.interval}`);
      if (s.healthcheck.retries) lines.push(`      retries: ${s.healthcheck.retries}`);
    }
    lines.push('    restart: unless-stopped');
  }
  if (volumes.size) {
    lines.push('', 'volumes:');
    for (const v of [...volumes].sort()) lines.push(`  ${v}: {}`);
  }
  return `${lines.join('\n')}\n`;
}

// Prometheus default config so scraping works out of the box.
function emitPromConfig() {
  const dir = path.join(CWD, 'infra', 'mirror');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'prometheus.yml');
  if (fs.existsSync(f)) return;
  fs.writeFileSync(
    f,
    `global:
  scrape_interval: 5s
scrape_configs:
  - job_name: app
    static_configs:
      - targets: ['host.docker.internal:3000']
`,
  );
}

// ── Commands ──────────────────────────────────────────────────────────────

function cmdEmit() {
  const services = inferServices();
  if (!services.length) {
    console.log('no prod services inferred from deploy-plan.md or infra-manifest.json');
    console.log('edit those files with references to postgres/redis/s3/kafka/etc., then re-run');
    process.exit(0);
  }
  fs.writeFileSync(OUT, yamlDump(services));
  if (services.some((s) => s.name === 'prometheus')) emitPromConfig();
  if (!fs.existsSync(ENV_OUT)) {
    const envLines = [
      '# docker-compose.mirror environment - mirrors prod connection strings.',
      'MIRROR_POSTGRES_PASSWORD=mirror',
      ['DATABASE_URL=postgres://postgres:', '${MIRROR_POSTGRES_PASSWORD}', '@localhost:5432/app'].join(''),
      'REDIS_URL=redis://localhost:6379',
      `S3_ENDPOINT=http://localhost:${services.some((s) => s.name === 'localstack') ? '4566' : '9000'}`,
      'OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318',
      'COBOLT_PROMETHEUS_URL=http://localhost:9090',
    ];
    fs.writeFileSync(ENV_OUT, `${envLines.join('\n')}\n`);
  }
  console.log(`wrote ${path.relative(CWD, OUT)} (${services.length} services)`);
  for (const s of services) console.log(`  - ${s.name}: ${s.image}`);
  console.log('next: docker compose -f docker-compose.mirror.yml up -d');
  console.log(`or:   node tools/cobolt-mirror-prod-dev.js up`);
}

function compose(args) {
  if (!fs.existsSync(OUT)) {
    console.error('no docker-compose.mirror.yml — run: emit first');
    process.exit(1);
  }
  const docker = spawnSync('docker', ['compose', '-f', OUT, ...args], { stdio: 'inherit' });
  process.exit(docker.status || 0);
}

function cmdStatus() {
  if (!fs.existsSync(OUT)) {
    console.error('no mirror stack — run: emit');
    process.exit(1);
  }
  const r = spawnSync('docker', ['compose', '-f', OUT, 'ps', '--format', 'json'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stderr || 'docker compose failed');
    process.exit(r.status);
  }
  const lines = (r.stdout || '').split('\n').filter(Boolean);
  for (const ln of lines) {
    try {
      const s = JSON.parse(ln);
      console.log(`${s.Service?.padEnd(15) || '?'} ${s.State || '?'}   health=${s.Health || 'n/a'}`);
    } catch {}
  }
}

function cmdHelp() {
  console.log(`cobolt-mirror-prod-dev — development-side production mirror

  emit    infer prod services, write docker-compose.mirror.yml
  up      docker compose up -d
  down    docker compose down (preserves volumes)
  nuke    docker compose down -v (destroys volumes)
  status  service health

Pairs with tools/cobolt-infra-check.js --mirror-prod (cloud/Terraform side).
Closes the dev-mode feedback loop — cobolt-load-chaos can now scrape a real
Prometheus via COBOLT_PROMETHEUS_URL set in .env.mirror.`);
}

if (cmd === 'emit') cmdEmit();
else if (cmd === 'up') compose(['up', '-d']);
else if (cmd === 'down') compose(['down']);
else if (cmd === 'nuke') compose(['down', '-v']);
else if (cmd === 'status') cmdStatus();
else cmdHelp();
