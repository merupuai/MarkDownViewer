#!/usr/bin/env node

// Generic YAML route-registry adapter (v0.42.0).
//
// Same contract as the JSON adapter: read the file, resolve a dotted selector,
// extract { path, method? } entries. YAML parsing is optional — if js-yaml is
// unavailable the adapter signals missing-dep (exit 2 upstream).

const fs = require('node:fs');
const jsonAdapter = require('./json-route-registry-adapter');

let _yaml = null;
try {
  _yaml = require('js-yaml');
} catch {
  _yaml = null;
}

function load(filePath, options = {}) {
  if (!_yaml) {
    return {
      ok: false,
      routes: [],
      errors: ['yaml-adapter-missing-dep: js-yaml not installed — `npm install js-yaml` or switch format to json'],
      missingDep: 'js-yaml',
    };
  }
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  } catch (e) {
    return { ok: false, routes: [], errors: [`cannot read ${filePath}: ${e.message}`] };
  }
  let parsed;
  try {
    parsed = _yaml.load(text);
  } catch (e) {
    return { ok: false, routes: [], errors: [`YAML parse failed: ${e.message}`] };
  }
  const node = jsonAdapter.resolveSelector(parsed, options.selector);
  if (node == null) {
    return {
      ok: false,
      routes: [],
      errors: [`selector "${options.selector || '<root>'}" did not resolve inside ${filePath}`],
    };
  }
  const routes = jsonAdapter.extractRoutes(node);
  if (routes.length === 0) {
    return {
      ok: false,
      routes: [],
      errors: [`no routes recovered from ${filePath} after selector "${options.selector || '<root>'}"`],
    };
  }
  return { ok: true, routes, errors: [] };
}

module.exports = { load };
