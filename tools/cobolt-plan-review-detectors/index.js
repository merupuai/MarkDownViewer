const registry = {
  'presence-census': require('./presence-census'),
  'naming-census': require('./naming-census'),
  'audit-bridge': require('./audit-bridge'),
  'semantic-ingest': require('./semantic-ingest'),
  'determinism-check': require('./determinism-check'),
  'requirements-consistency': require('./requirements-consistency'),
  'vnext-control-ingest': require('./vnext-control-ingest'),
};

function getDetector(id) {
  return registry[id] || null;
}

function getDetectors(ids) {
  return (ids || []).map((id) => getDetector(id)).filter(Boolean);
}

module.exports = {
  DETECTORS: registry,
  detectorIds: Object.keys(registry),
  getDetector,
  getDetectors,
};
