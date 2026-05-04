// CoBolt reference adapter: grafana-dashboard (v0.44.0 stub).
//
// Intent: verify declared Grafana dashboards exist and are fresh. Planned
// package: `@mftlabs/cobolt-adapter-grafana` (v0.44.x).

const META = {
  adapterVersion: '0.44.0',
  name: 'grafana-dashboard',
  capabilities: ['dashboards'],
  stub: true,
  plannedReplacement: '@mftlabs/cobolt-adapter-grafana (v0.44.x)',
};

async function inject(scenario) {
  return { ok: false, notImplemented: true, detail: `grafana-dashboard.inject stub — "${scenario?.id}" not actioned.` };
}

async function observe(_scenario, _options) {
  return { recovered: false, detail: 'grafana-dashboard.observe stub — no Grafana API calls made.' };
}

async function restore(_scenario, _faultHandle) {
  return { ok: true, detail: 'grafana-dashboard.restore stub.' };
}

module.exports = { META, inject, observe, restore };
