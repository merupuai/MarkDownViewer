// CoBolt reference adapter: sentry-error (v0.44.0 stub).
//
// Intent: query Sentry for recent error spikes tied to a release; flag a
// rollback condition when post-deploy error rate crosses threshold. Planned
// package: `@mftlabs/cobolt-adapter-sentry` (v0.44.x).

const META = {
  adapterVersion: '0.44.0',
  name: 'sentry-error',
  capabilities: ['errors'],
  stub: true,
  plannedReplacement: '@mftlabs/cobolt-adapter-sentry (v0.44.x)',
};

async function inject(scenario) {
  return { ok: false, notImplemented: true, detail: `sentry-error.inject stub — "${scenario?.id}" not actioned.` };
}

async function observe(_scenario, _options) {
  return { recovered: false, detail: 'sentry-error.observe stub — no Sentry API calls made.' };
}

async function restore(_scenario, _faultHandle) {
  return { ok: true, detail: 'sentry-error.restore stub.' };
}

module.exports = { META, inject, observe, restore };
