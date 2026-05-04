#!/usr/bin/env node

// Generic OpenAPI 3.x route adapter (v0.42.0).
//
// Reads an OpenAPI 3.x JSON or YAML document and extracts the union of
// declared operations as { path, method }. Does not validate the full schema —
// only extracts path+method pairs. Any HTTP method listed under a `paths.*`
// entry counts.

const fs = require('node:fs');
const path = require('node:path');

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

let _yaml = null;
try {
  _yaml = require('js-yaml');
} catch {
  _yaml = null;
}

function parseDocument(filePath, text) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') {
    return JSON.parse(text);
  }
  // Try JSON first (some projects use .yaml for historical reasons with JSON content).
  try {
    return JSON.parse(text);
  } catch {
    // fall through to YAML
  }
  if (!_yaml) {
    const err = new Error(
      'openapi-adapter-missing-dep: js-yaml required to parse non-JSON OpenAPI documents. `npm install js-yaml`.',
    );
    err.missingDep = 'js-yaml';
    throw err;
  }
  return _yaml.load(text);
}

function load(filePath, options = {}) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  } catch (e) {
    return { ok: false, routes: [], errors: [`cannot read ${filePath}: ${e.message}`] };
  }
  let doc;
  try {
    doc = parseDocument(filePath, text);
  } catch (e) {
    if (e.missingDep) {
      return { ok: false, routes: [], errors: [e.message], missingDep: e.missingDep };
    }
    return { ok: false, routes: [], errors: [`parse failed: ${e.message}`] };
  }
  if (!doc || typeof doc !== 'object' || !doc.paths || typeof doc.paths !== 'object') {
    return { ok: false, routes: [], errors: [`OpenAPI document has no paths object: ${filePath}`] };
  }
  const routes = [];
  for (const [routePath, pathItem] of Object.entries(doc.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const key of Object.keys(pathItem)) {
      if (HTTP_METHODS.has(key.toLowerCase())) {
        routes.push({ path: routePath, method: key.toUpperCase() });
      }
    }
  }
  if (routes.length === 0) {
    return { ok: false, routes: [], errors: [`no operations recovered from ${filePath}`] };
  }
  if (options.methodFilter) {
    const allowed = new Set(String(options.methodFilter).toUpperCase().split(','));
    return { ok: true, routes: routes.filter((r) => allowed.has(r.method)), errors: [] };
  }
  return { ok: true, routes, errors: [] };
}

module.exports = { load, parseDocument, HTTP_METHODS };
