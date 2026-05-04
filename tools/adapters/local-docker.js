// CoBolt reference adapter: local-docker (v0.44.0 stub).
//
// Intent: orchestrate local Docker / Compose-based chaos scenarios and probe
// the declared health endpoint. Stub in v0.44.0 — returns `notImplemented` so
// cobolt-mttr-probe surfaces an `adapter-not-shipped` gate verdict rather
// than pretending to inject a fault. Real implementation lands in v0.44.x.

const META = {
  adapterVersion: '0.44.0',
  name: 'local-docker',
  capabilities: ['chaos', 'health-probe'],
  stub: true,
  plannedReplacement: 'in-tree (v0.44.x)',
};

async function inject(scenario) {
  return {
    ok: false,
    notImplemented: true,
    detail: `local-docker.inject stub — scenario "${scenario?.id}" not injected. v0.44.0 ships the contract only; the live chaos implementation is planned for v0.44.x.`,
  };
}

async function observe(_scenario, _options) {
  return {
    recovered: false,
    detail:
      'local-docker.observe stub — no observation performed. See tools/adapters/README.md for plugin-package path.',
  };
}

async function restore(_scenario, _faultHandle) {
  return { ok: true, detail: 'local-docker.restore stub — nothing to clean up because inject was a no-op.' };
}

module.exports = { META, inject, observe, restore };
