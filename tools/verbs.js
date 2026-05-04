// SF-01 — verb-namespaced surface for cobolt-tools.
// 21 verbs / 140 noun routes. Lock list lives in tools/verbs-lock.json.
// Every noun target MUST be a key in tools/index.js TOOLS registry —
// asserted by tools/cobolt-public-surface-check.js::assertVerbsLock().
//
// Schema for each noun value:
//   - 'flat-name'                          → spawn cobolt-<flat>.js with user args only
//   - { target: 'flat-name', preArgs: [..] } → spawn cobolt-<flat>.js <preArgs...> <user args...>
//   - '__meta__'                           → meta verb (handled by tools/index.js itself)
//
// preArgs preserves the legacy npm script subcommand. Example: tools:gate-lint
// was 'node tools/cobolt-gate-lint.js check' so verbs.gate.lint = { target: 'gate-lint', preArgs: ['check'] }.
//
// See: docs/superpowers/specs/2026-04-30-sf-01-cli-surface-collapse-design.md

const VERBS = Object.freeze({
  state: {
    desc: 'Pipeline state, ledger, anchor, recovery',
    nouns: {
      get: { target: 'state', preArgs: ['get'] },
      verify: { target: 'state', preArgs: ['verify'] },
      backup: { target: 'state', preArgs: ['backup'] },
      restore: { target: 'state', preArgs: ['restore'] },
      tenant: 'tenant',
      ledger: 'execution-ledger',
      anchor: 'anchor',
      recovery: 'recovery',
      paths: 'paths',
      health: 'health',
    },
  },
  gate: {
    desc: 'Quality-gate orchestration',
    nouns: {
      run: 'gate',
      lint: { target: 'gate-lint', preArgs: ['check'] },
      wiring: { target: 'gate-wiring', preArgs: ['check'] },
      firerate: 'gate-firerate',
      effectiveness: 'gate-effectiveness',
      channel: { target: 'channel-wiring-check', preArgs: ['scan'] },
      queue: { target: 'queue-topology-check', preArgs: ['scan'] },
      orm: { target: 'orm-parity-check', preArgs: ['scan'] },
    },
  },
  audit: {
    desc: 'Pipeline compliance audits',
    nouns: {
      run: { target: 'audit', preArgs: ['full'] },
      lite: 'audit-lite',
      'build-pipeline': { target: 'build-pipeline-audit', preArgs: ['check'] },
      'fix-pipeline': { target: 'fix-pipeline-audit', preArgs: ['check'] },
      'agent-failure': 'agent-failure-review',
      'follow-on': { target: 'deferred-follow-on', preArgs: ['check'] },
    },
  },
  scan: {
    desc: 'Security and quality scanners',
    nouns: {
      sast: 'scan',
      sbom: 'sbom',
      provenance: 'provenance',
      'pr-threat': 'pr-threat-scan',
      entropy: 'entropy-scan',
      license: { target: 'license-scan', preArgs: ['check'] },
      lockfile: { target: 'lockfile-verify', preArgs: ['check'] },
      fingerprint: { target: 'ai-author-fingerprint', preArgs: ['scan'] },
      'dead-code': 'dead-code',
      'n-plus-one': 'n-plus-one',
      'memory-leak': 'memory-leak',
      'dep-health': 'dep-health',
    },
  },
  evidence: {
    desc: 'Coverage and traceability',
    nouns: {
      collect: { target: 'evidence', preArgs: ['collect'] },
      pack: { target: 'evidence-pack', preArgs: ['pack'] },
      impact: 'evidence-impact',
      'source-coverage': 'source-coverage',
      'trace-coverage': { target: 'trace-tag-coverage', preArgs: ['check'] },
      'semantic-coverage': { target: 'source-semantic-coverage', preArgs: ['check'] },
      nav: 'evidence-nav',
    },
  },
  status: {
    desc: 'Read-only state surfaces',
    nouns: {
      show: 'status',
      progress: 'progress',
      debt: 'debt-banner',
      tail: 'tail',
      'why-blocked': 'why-blocked',
      'recovery-stats': 'recovery-stats',
      plateau: 'plateau-rollup',
      'escalate-guard': 'escalate-guard',
    },
  },
  fleet: {
    desc: 'Multi-project observability',
    nouns: {
      observe: 'fleet-observe',
    },
  },
  doctor: {
    desc: 'Per-stage doctors',
    nouns: {
      plan: { target: 'plan-doctor', preArgs: ['check'] },
      build: { target: 'build-doctor', preArgs: ['check'] },
      fix: { target: 'fix-doctor', preArgs: ['check'] },
      enterprise: { target: 'enterprise-readiness', preArgs: ['check'] },
      brownfield: { target: 'brownfield-doctor', preArgs: ['check'] },
      arch: { target: 'arch-doctor', preArgs: ['check'] },
      'context-route': { target: 'context-route-doctor', preArgs: ['check'] },
      plugins: { target: 'plugin-lock', preArgs: ['verify'] },
      protocol: { target: 'protocol-check', preArgs: ['doctor'] },
      runtime: { target: 'runtime-resilience', preArgs: ['check'] },
    },
  },
  release: {
    desc: 'Versioning and readiness',
    nouns: {
      bump: { target: 'release', preArgs: ['release'] },
      readiness: 'release-readiness',
      provenance: { target: 'provenance', preArgs: ['verify'] },
      'install-trust': { target: 'verify-install', preArgs: ['verify'] },
      'run-manifest': { target: 'run-manifest', preArgs: ['verify'] },
      'version-census': { target: 'version-census', preArgs: ['check'] },
      'project-version': 'project-version',
    },
  },
  output: {
    desc: 'Artifact data governance',
    nouns: {
      classify: { target: 'output-governance', preArgs: ['classify'] },
      archive: { target: 'output-governance', preArgs: ['archive'] },
      purge: { target: 'output-governance', preArgs: ['purge'] },
    },
  },
  deploy: {
    desc: 'Deploy stage helpers',
    nouns: {
      aggregate: { target: 'deploy-aggregate', preArgs: ['check'] },
      verify: 'deploy-verify',
    },
  },
  env: {
    desc: 'Environment',
    nouns: {
      show: { target: 'env', preArgs: ['show'] },
      validate: { target: 'env', preArgs: ['validate'] },
      telemetry: { target: 'telemetry', preArgs: ['certify'] },
      airgap: { target: 'airgap', preArgs: ['verify'] },
      rotate: { target: 'env', preArgs: ['rotate'] },
      audit: { target: 'env', preArgs: ['audit'] },
      sync: 'runtime-sync',
    },
  },
  cost: {
    desc: 'Cost telemetry',
    nouns: {
      report: { target: 'cost', preArgs: ['report'] },
      budget: { target: 'cost', preArgs: ['budget'] },
      check: { target: 'cost', preArgs: ['check'] },
      extend: { target: 'cost', preArgs: ['extend'] },
    },
  },
  policy: {
    desc: 'Gate policy interoperability',
    nouns: {
      export: { target: 'policy', preArgs: ['export'] },
      rbac: { target: 'rbac', preArgs: ['check'] },
      schema: { target: 'policy', preArgs: ['schema'] },
      verify: { target: 'policy', preArgs: ['verify'] },
      evaluate: { target: 'policy', preArgs: ['evaluate'] },
    },
  },
  standards: {
    desc: 'ISO / NIST / DORA',
    nouns: {
      'iso-25010': 'iso-25010',
      'iso-5055': 'iso-5055',
      'iso-29148': 'iso-29148',
      'ai-rmf': 'ai-rmf',
      dora: { target: 'dora', preArgs: ['report'] },
      'framework-versions': { target: 'framework-versions', preArgs: ['refresh'] },
      all: { target: 'standards', preArgs: ['all'] },
    },
  },
  contract: {
    desc: 'Behavioral and API contracts',
    nouns: {
      verify: 'contract-verify',
      'semantic-verify': 'contract-semantic-verify',
      replay: 'contract-replay',
      codegen: 'contract-codegen',
      testgen: 'contract-testgen',
      'story-emit': { target: 'story-contract-emit', preArgs: ['emit'] },
      'api-validate': 'api-contract',
    },
  },
  rtm: {
    desc: 'Requirements traceability matrix',
    nouns: {
      check: { target: 'rtm', preArgs: ['check'] },
      integrity: 'rtm-mapped-integrity',
      'count-parity': 'planning-count-parity',
    },
  },
  story: {
    desc: 'Story-level tools',
    nouns: {
      census: { target: 'story-census', preArgs: ['check'] },
      'mock-wire': 'story-mock-wire',
      'dep-map': { target: 'story-dep-map', preArgs: ['build'] },
      smoke: { target: 'story-cumulative-smoke', preArgs: ['run'] },
      'visual-diff': 'story-visual-diff',
      'contract-emit': { target: 'story-contract-emit', preArgs: ['emit'] },
    },
  },
  plan: {
    desc: 'Plan-stage tools',
    nouns: {
      proof: 'plan-proof',
      review: { target: 'plan-review', preArgs: ['run'] },
      metrics: { target: 'plan-metrics', preArgs: ['report'] },
      debt: 'planning-debt',
      counts: { target: 'planning-counts', preArgs: ['check'] },
      bootstrap: 'planning-bootstrap',
      redispatch: 'plan-redispatch',
      'source-ledger': 'planning-source-ledger',
      'control-map': 'planning-control-map',
      'risk-model': 'planning-risk-model',
      'threat-model': 'agentic-threat-model',
      'performance-profile': 'planning-performance-profile',
      'replay-calibration': 'planning-replay-calibration',
      'evidence-signature': 'planning-evidence-signature',
      'loop-verdict': 'planning-loop-verdict',
      'fr-coverage': { target: 'fr-epic-coverage', preArgs: ['check', '--threshold', '100'] },
      'trd-coverage': { target: 'trd-epic-coverage', preArgs: ['check', '--threshold', '100'] },
      dossier: { target: 'dossier-depth', preArgs: ['check'] },
      redteam: 'prd-redteam',
    },
  },
  arch: {
    desc: 'Architecture diagrams',
    nouns: {
      graph: 'architecture-graph',
      diagrams: 'architecture-diagrams',
      validate: 'architecture-diagram-validate',
      render: 'architecture-diagram-render',
      report: 'architecture-diagram-report',
      propose: 'arch-propose',
      doctor: { target: 'arch-doctor', preArgs: ['check'] },
      log: 'architecture-log',
      'failure-record': 'arch-failure-record',
    },
  },
  tools: {
    desc: 'Meta and escape hatch',
    nouns: {
      list: '__meta__',
      help: '__meta__',
      extension: 'extension',
      workflow: 'workflow-integration',
      'task-graph': 'task-graph',
      benchmark: 'benchmark',
      'agent-dedup': 'agent-dedup',
      'install-profile': { target: 'install-profile', preArgs: ['profile'] },
    },
  },
});

/**
 * Internal: normalize a noun value (string OR object) to its target tool name.
 * Returns null when the input is the meta sentinel '__meta__'.
 *
 * @param {string|object|undefined} value
 * @returns {string|null}
 */
function targetOf(value) {
  if (!value) return null;
  if (value === '__meta__') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.target === 'string') return value.target;
  return null;
}

/**
 * Resolve a verb-noun pair. Returns { target, preArgs } on match, or null on miss.
 * Caller (tools/index.js) prepends preArgs to user args before spawning the flat tool.
 *
 * @param {string} verb
 * @param {string} noun
 * @returns {{ target: string, preArgs: string[] }|null}
 */
function resolve(verb, noun) {
  const def = VERBS[verb];
  if (!def) return null;
  const value = def.nouns?.[noun];
  if (!value || value === '__meta__') return null;
  if (typeof value === 'string') return { target: value, preArgs: [] };
  if (typeof value === 'object' && typeof value.target === 'string') {
    return { target: value.target, preArgs: Array.isArray(value.preArgs) ? value.preArgs : [] };
  }
  return null;
}

/**
 * Suggest a verb-noun invocation form for a legacy `tools:*` npm script slug.
 * Used by scripts/deprecation-shim.js to print a one-line migration hint.
 *
 * Returns 'cobolt-tools <verb> <noun>' when a verb owns the slug's flat tool.
 * Falls back to the legacy form 'cobolt-tools <slug-tail> (legacy)' when no
 * verb claims the slug — covers the ~352 tools with no canonical verb mapping.
 *
 * @param {string} slug e.g. 'tools:gate-lint'
 * @returns {string}
 */
function suggestForSlug(slug) {
  const trimmed = String(slug || '').replace(/^tools:/, '');
  for (const [verb, def] of Object.entries(VERBS)) {
    for (const [noun, value] of Object.entries(def.nouns || {})) {
      if (targetOf(value) === trimmed) return `cobolt-tools ${verb} ${noun}`;
    }
  }
  return `cobolt-tools ${trimmed} (legacy)`;
}

/**
 * @returns {string[]} verb names sorted alphabetically
 */
function listVerbs() {
  return Object.keys(VERBS).sort();
}

module.exports = { VERBS, resolve, suggestForSlug, listVerbs, targetOf };
