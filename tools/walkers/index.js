#!/usr/bin/env node

// Walker registry (v0.42.0).
//
// Lookup table for reachability dispatch in cobolt-contract-reachability.js.
//
// `reference` walkers: intentionally empty — CoBolt does not ship
// framework-named walkers. Projects on a framework declare reachability.mode
// as "custom" (owning a walker module) or "generic" (declarative route
// registry parsed by a format adapter below). The schema explicitly allows
// reference mode for future plugin publication; the reachability tool fails
// closed on any declared reference walker name, citing this registry.
//
// `generic` adapters: format-specific parsers (not framework-specific). Each
// reads a route-registry file and returns [{ path, method? }]. Adding a new
// format is one file in tools/walkers/generic/ + one entry here.

const jsonAdapter = require('./generic/json-route-registry-adapter');
const yamlAdapter = require('./generic/yaml-route-registry-adapter');
const openapiAdapter = require('./generic/openapi-adapter');
const regexLineAdapter = require('./generic/regex-line-adapter');

const REFERENCE_WALKERS = Object.freeze({});

const GENERIC_ADAPTERS = Object.freeze({
  json: jsonAdapter,
  yaml: yamlAdapter,
  openapi: openapiAdapter,
  'regex-line': regexLineAdapter,
});

function listReferenceWalkers() {
  return Object.keys(REFERENCE_WALKERS);
}

function listGenericAdapters() {
  return Object.keys(GENERIC_ADAPTERS);
}

function resolveReferenceWalker(name) {
  return REFERENCE_WALKERS[String(name || '')] || null;
}

function resolveGenericAdapter(format) {
  return GENERIC_ADAPTERS[String(format || '').toLowerCase()] || null;
}

module.exports = {
  REFERENCE_WALKERS,
  GENERIC_ADAPTERS,
  listReferenceWalkers,
  listGenericAdapters,
  resolveReferenceWalker,
  resolveGenericAdapter,
};
