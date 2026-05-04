// CoBolt reference adapter: fly-deploy (v0.44.0 stub).
//
// Intent: deploy a project to Fly.io via `flyctl`, capture machine IDs,
// and support rollback to a prior release via `flyctl releases rollback`.
// Stub in v0.44.0 — returns `notImplemented`. Real adapter lands in
// `@mftlabs/cobolt-adapter-fly` (v0.44.x).

const META = {
  adapterVersion: '0.44.0',
  name: 'fly-deploy',
  capabilities: ['deploy', 'rollback'],
  stub: true,
  plannedReplacement: '@mftlabs/cobolt-adapter-fly (v0.44.x)',
};

async function inject(scenario) {
  return {
    ok: false,
    notImplemented: true,
    detail: `fly-deploy.inject stub — scenario "${scenario?.id}" not actioned. Install @mftlabs/cobolt-adapter-fly when published.`,
  };
}

async function observe(_scenario, _options) {
  return { recovered: false, detail: 'fly-deploy.observe stub — no fly status polled.' };
}

async function restore(_scenario, _faultHandle) {
  return { ok: true, detail: 'fly-deploy.restore stub.' };
}

module.exports = { META, inject, observe, restore };
