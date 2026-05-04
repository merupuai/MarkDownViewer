// CoBolt reference adapter: prometheus-verify (v0.44.0 stub).
//
// Intent: assert declared PromQL queries return values within SLO ranges
// (error-rate below N%, p95 latency below M ms) immediately after deploy.
// Stub in v0.44.0. Planned package: `@mftlabs/cobolt-adapter-prometheus`
// (v0.44.x).

const META = {
  adapterVersion: '0.44.0',
  name: 'prometheus-verify',
  capabilities: ['metrics', 'health-probe'],
  stub: true,
  plannedReplacement: '@mftlabs/cobolt-adapter-prometheus (v0.44.x)',
};

async function inject(scenario) {
  return { ok: false, notImplemented: true, detail: `prometheus-verify.inject stub — "${scenario?.id}" not injected.` };
}

async function observe(_scenario, _options) {
  return { recovered: false, detail: 'prometheus-verify.observe stub — no PromQL queries executed.' };
}

async function restore(_scenario, _faultHandle) {
  return { ok: true, detail: 'prometheus-verify.restore stub.' };
}

module.exports = { META, inject, observe, restore };
