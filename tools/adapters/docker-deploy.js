// CoBolt reference adapter: docker-deploy (v0.44.0 stub).
//
// Intent: deploy via `docker compose` / `docker stack`, capture container
// IDs for rollback. Stub in v0.44.0. Planned package:
// `@mftlabs/cobolt-adapter-docker` (v0.44.x).

const META = {
  adapterVersion: '0.44.0',
  name: 'docker-deploy',
  capabilities: ['deploy', 'rollback'],
  stub: true,
  plannedReplacement: '@mftlabs/cobolt-adapter-docker (v0.44.x)',
};

async function inject(scenario) {
  return {
    ok: false,
    notImplemented: true,
    detail: `docker-deploy.inject stub — scenario "${scenario?.id}" not actioned.`,
  };
}

async function observe(_scenario, _options) {
  return { recovered: false, detail: 'docker-deploy.observe stub.' };
}

async function restore(_scenario, _faultHandle) {
  return { ok: true, detail: 'docker-deploy.restore stub.' };
}

module.exports = { META, inject, observe, restore };
