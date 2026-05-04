#!/usr/bin/env node

// Custom-mode walker loader (v0.42.0).
//
// Loads a project-owned walker module (declared as reachability.customPath in
// selected-stack-contract.json) and invokes its named entrypoint function.
//
// The custom module MUST export the named entrypoint as a function. It is
// called with { projectRoot, contract, surfaces } and MUST return a plain
// object shaped as:
//
//   {
//     "<surfaceId>": { reached: true, via: ["path1", "path2"] },
//     "<surfaceId>": { reached: false, reason: "Gallery.tsx not imported from main.tsx" },
//     ...
//   }
//
// OR an array of per-surface verdicts:
//
//   [ { surfaceId: "S-GALLERY", reached: true, via: [...] }, ... ]
//
// The loader normalizes both shapes into an array. It refuses to load modules
// that resolve outside the project root, that throw during load, or that
// return a value the reachability tool cannot reason about.

const fs = require('node:fs');
const path = require('node:path');

function resolveModulePath(projectRoot, customPath) {
  const resolved = path.resolve(projectRoot, customPath);
  // v0.43 C4: use path.relative instead of case-sensitive startsWith so
  // Windows drive-letter casing differences (C:/ vs c:/) do not produce
  // false-rejection when the project root and the resolved path are
  // produced by different APIs.
  const rootResolved = path.resolve(projectRoot);
  const relFromRoot = path.relative(rootResolved, resolved);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    return { ok: false, reason: `customPath "${customPath}" resolves outside projectRoot (${resolved})` };
  }
  if (!fs.existsSync(resolved)) {
    return { ok: false, reason: `customPath "${customPath}" not found on disk (${resolved})` };
  }
  return { ok: true, absolutePath: resolved };
}

function normalizeVerdict(raw, surfaceIds) {
  if (!raw) return { ok: false, verdicts: [], reason: 'custom walker returned null/undefined' };
  if (Array.isArray(raw)) {
    const verdicts = raw
      .filter((entry) => entry && typeof entry === 'object' && entry.surfaceId)
      .map((entry) => ({
        surfaceId: String(entry.surfaceId),
        reached: entry.reached === true,
        via: Array.isArray(entry.via) ? entry.via.map(String) : [],
        reason: entry.reason ? String(entry.reason) : undefined,
      }));
    return { ok: true, verdicts };
  }
  if (typeof raw === 'object') {
    const verdicts = [];
    for (const surfaceId of surfaceIds) {
      const entry = raw[surfaceId];
      if (entry && typeof entry === 'object') {
        verdicts.push({
          surfaceId,
          reached: entry.reached === true,
          via: Array.isArray(entry.via) ? entry.via.map(String) : [],
          reason: entry.reason ? String(entry.reason) : undefined,
        });
      }
    }
    return { ok: true, verdicts };
  }
  return { ok: false, verdicts: [], reason: `custom walker returned an unusable type: ${typeof raw}` };
}

function invoke(projectRoot, contract, surfaces) {
  const reachability = contract?.reachability;
  if (!reachability || reachability.mode !== 'custom') {
    return { ok: false, reason: 'contract.reachability.mode is not "custom"' };
  }
  const resolved = resolveModulePath(projectRoot, reachability.customPath);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  let mod;
  try {
    mod = require(resolved.absolutePath);
  } catch (e) {
    return { ok: false, reason: `custom walker require() failed: ${e.message}` };
  }
  const entryName = reachability.entrypoint;
  const entry = mod?.[entryName];
  if (typeof entry !== 'function') {
    return {
      ok: false,
      reason: `custom walker "${reachability.customPath}" does not export function "${entryName}"`,
    };
  }
  let raw;
  try {
    raw = entry({ projectRoot, contract, surfaces, config: reachability.config || {} });
  } catch (e) {
    return { ok: false, reason: `custom walker threw: ${e.message}` };
  }
  const surfaceIds = surfaces.map((s) => s.surfaceId);
  const normalized = normalizeVerdict(raw, surfaceIds);
  if (!normalized.ok) return { ok: false, reason: normalized.reason };
  return { ok: true, verdicts: normalized.verdicts };
}

module.exports = { invoke, resolveModulePath, normalizeVerdict };
