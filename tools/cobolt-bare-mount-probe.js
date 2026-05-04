#!/usr/bin/env node
/**
 * cobolt-bare-mount-probe.js — Routing hygiene probe.
 *
 * Extracts mount prefixes from authz-matrix.json endpoints (/api, /admin,
 * /v1, /internal, etc.) and probes each bare prefix. Raw 404 on a mount
 * root is a cosmetic finding — bots get a clean 200/404 oracle. Expected
 * responses: 301/302 redirect, 401 (auth required), or documented index.
 *
 * Advisory only — does not block the pipeline.
 */

const fs = require('node:fs');
const path = require('node:path');

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) args[k.slice(2)] = argv[++i];
  }
  return args;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function writeJson(p, d) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(d, null, 2));
}

function extractMounts(matrix) {
  const mounts = new Set();
  for (const ep of matrix.endpoints || []) {
    const segments = ep.path.split('/').filter(Boolean);
    // Collect progressively deeper prefixes: /api, /api/v1, /api/v1/admin
    let prefix = '';
    for (const seg of segments) {
      if (seg.startsWith(':') || seg.startsWith('{')) break; // stop at dynamic segment
      prefix += `/${seg}`;
      if (prefix !== ep.path) mounts.add(prefix);
    }
  }
  return [...mounts];
}

async function probe(url) {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual' });
    return { status: res.status };
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

async function main() {
  const args = parseArgs();
  if (!args.matrix || !args['app-url'] || !args.out) {
    console.error('usage: --matrix <path> --app-url <url> --out <path>');
    process.exit(1);
  }

  const matrix = readJson(args.matrix);
  const appUrl = args['app-url'].replace(/\/$/, '');
  const mounts = extractMounts(matrix);

  const findings = [];
  for (const mount of mounts) {
    const result = await probe(`${appUrl}${mount}`);
    const rawNotFound = result.status === 404;
    findings.push({
      mount,
      status: result.status,
      hygiene: rawNotFound ? 'raw-404' : 'ok',
      recommendation: rawNotFound
        ? 'Return a documented response (301 to docs, 401 if behind auth, or an index payload) instead of a bare 404.'
        : null,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    appUrl,
    totalMounts: mounts.length,
    rawNotFoundCount: findings.filter((f) => f.hygiene === 'raw-404').length,
    findings,
  };
  writeJson(args.out, report);

  console.log(`bare-mount-probe: raw-404=${report.rawNotFoundCount}/${report.totalMounts}`);
  process.exit(0); // advisory
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
module.exports = { main, extractMounts };
