#!/usr/bin/env node

// Generic JSON route-registry adapter (v0.42.0).
//
// Parses a JSON file containing a flat list of routes. No framework knowledge.
// The contract tells us the file path + optional selector (dotted key path into
// the top-level structure); we read the file, resolve the selector, and
// normalize each entry to { path, method? }.
//
// Accepted shapes after the selector resolves:
//   [ "/a", "/b" ]
//   [ { "path": "/a" }, { "path": "/b", "method": "GET" } ]
//   [ { "route": "/a", "verb": "POST" } ]
//   { "/a": { method: "GET" }, "/b": {} }
//
// The adapter rejects nothing based on framework identity — it only fails when
// the file is unreadable, the selector does not resolve, or no route strings
// are recoverable.

const fs = require('node:fs');

function readText(filePath) {
  try {
    return { ok: true, text: fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '') };
  } catch (e) {
    return { ok: false, error: `cannot read ${filePath}: ${e.message}` };
  }
}

function resolveSelector(value, selector) {
  if (!selector) return value;
  const parts = String(selector)
    .split(/[.[\]]/)
    .filter(Boolean);
  let cursor = value;
  for (const part of parts) {
    if (cursor == null) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function extractRoutes(node) {
  const routes = [];
  if (Array.isArray(node)) {
    for (const entry of node) {
      if (typeof entry === 'string') {
        routes.push({ path: entry });
      } else if (entry && typeof entry === 'object') {
        const routePath = entry.path || entry.route || entry.url || entry.pattern;
        if (routePath) {
          const method = (entry.method || entry.verb || '').toUpperCase() || undefined;
          routes.push(method ? { path: routePath, method } : { path: routePath });
        }
      }
    }
    return routes;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('/') || key.startsWith(':')) {
        const method = (value?.method || value?.verb || '').toUpperCase() || undefined;
        routes.push(method ? { path: key, method } : { path: key });
      }
    }
  }
  return routes;
}

function load(filePath, options = {}) {
  const read = readText(filePath);
  if (!read.ok) return { ok: false, routes: [], errors: [read.error] };
  let parsed;
  try {
    parsed = JSON.parse(read.text);
  } catch (e) {
    return { ok: false, routes: [], errors: [`JSON parse failed: ${e.message}`] };
  }
  const node = resolveSelector(parsed, options.selector);
  if (node == null) {
    return {
      ok: false,
      routes: [],
      errors: [`selector "${options.selector || '<root>'}" did not resolve inside ${filePath}`],
    };
  }
  const routes = extractRoutes(node);
  if (routes.length === 0) {
    return {
      ok: false,
      routes: [],
      errors: [`no routes recovered from ${filePath} after selector "${options.selector || '<root>'}"`],
    };
  }
  return { ok: true, routes, errors: [] };
}

module.exports = { load, resolveSelector, extractRoutes };
