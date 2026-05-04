#!/usr/bin/env node

// Generic regex-per-line adapter (v0.42.0).
//
// Reads a file, applies the user-supplied regex (from the contract's
// routeRegistry.selector) to every line, and treats each match's first capture
// group as a route path. The regex MUST contain at least one capture group;
// an optional named `method` group is honoured.
//
// This adapter intentionally knows nothing about any framework. It is the
// escape hatch for projects that declare a route registry in source files and
// do not want to author a custom walker.
//
// Example selector (express.js-like, advisory only — nothing framework-specific
// is baked into the adapter):
//   /app\\.(?<method>get|post|put|delete|patch)\\(\\s*['"](?<path>\\/[^'"\\s]*)['"]/g

const fs = require('node:fs');

function load(filePath, options = {}) {
  if (!options.selector || typeof options.selector !== 'string') {
    return {
      ok: false,
      routes: [],
      errors: ['regex-line-adapter requires routeRegistry.selector to be a non-empty regex string'],
    };
  }
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  } catch (e) {
    return { ok: false, routes: [], errors: [`cannot read ${filePath}: ${e.message}`] };
  }

  let regex;
  try {
    // Accept the canonical /body/flags form when both slashes are present;
    // otherwise treat the entire selector as the raw pattern body with a
    // default `g` flag. No middle-ground slicing — that was fragile on
    // patterns that happen to end with trailing flag-looking characters
    // without a preceding slash.
    const wrapped = options.selector.match(/^\/(.+)\/([gimsuy]*)$/);
    let body;
    let flags;
    if (wrapped) {
      body = wrapped[1];
      flags = wrapped[2] || 'g';
    } else {
      body = options.selector;
      flags = 'g';
    }
    if (!flags.includes('g')) flags = `${flags}g`;
    regex = new RegExp(body, flags);
  } catch (e) {
    return { ok: false, routes: [], errors: [`invalid regex selector: ${e.message}`] };
  }

  const routes = [];
  const iter = regex.global ? text.matchAll(regex) : [text.match(regex)].filter(Boolean);
  for (const match of iter) {
    if (!match) continue;
    const groups = match.groups || {};
    const pathValue = groups.path || match[1];
    if (!pathValue) continue;
    const method = (groups.method || '').toUpperCase() || undefined;
    routes.push(method ? { path: pathValue, method } : { path: pathValue });
  }
  if (routes.length === 0) {
    return {
      ok: false,
      routes: [],
      errors: [`regex selector matched no lines in ${filePath}`],
    };
  }
  return { ok: true, routes, errors: [] };
}

module.exports = { load };
