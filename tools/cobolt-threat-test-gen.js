#!/usr/bin/env node
// S6 — Convert STRIDE threat-model entries into executable negative tests.
// Every threat in threat-model.md must map to tests/security/<threat-id>.spec.*.
// Emits missing test stubs and fails if coverage < 100%.
//
// v0.40.12 (DEFECT-04): wrapped in main() + --help; missing threat-model.md
// now exits 3 (infrastructure input missing) so Tier 2 gates degrade the
// grade deterministically instead of FAIL-ing like a hard error.
//
// Exit codes (per tools/CLAUDE.md):
//   0 — all threats covered (no stubs emitted)
//   1 — malformed threat-model.md (file exists but 0 threats parsed)
//   2 — usage error
//   3 — threat-model.md missing (required input not produced upstream)
//   NOTE: the tool ALSO exits 1 when coverage is incomplete and stubs were
//   emitted — this is the intentional TDD-RED signal consumed by
//   cobolt-threat-coverage-gate. Callers must distinguish via stderr/report.

const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../lib/cobolt-atomic-write');

function printHelp() {
  process.stdout.write(
    `cobolt-threat-test-gen — STRIDE threat-model → executable test stubs\n\n` +
      `USAGE\n` +
      `  node tools/cobolt-threat-test-gen.js [--help]\n\n` +
      `INPUT\n` +
      `  _cobolt-output/latest/planning/threat-model.md (must exist; STRIDE format)\n\n` +
      `OUTPUT\n` +
      `  tests/security/<threat-id>.spec.ts (one stub per missing threat id)\n` +
      `  _cobolt-output/latest/security/threat-coverage.json (coverage report)\n\n` +
      `EXIT CODES\n` +
      `  0 — all threats covered by existing specs\n` +
      `  1 — malformed threat-model.md (exists but 0 threats parsed); OR incomplete\n` +
      `      coverage — stubs emitted, TDD-RED signal (consumed by coverage gate)\n` +
      `  2 — usage error\n` +
      `  3 — threat-model.md missing (upstream producer didn't run)\n`,
  );
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const CWD = process.cwd();
  const tmPath = path.join(CWD, '_cobolt-output', 'latest', 'planning', 'threat-model.md');
  if (!fs.existsSync(tmPath)) {
    process.stderr.write('threat-model.md missing (input not produced — Tier 2 skip-and-report)\n');
    return 3;
  }
  const md = fs.readFileSync(tmPath, 'utf8');

  const CATS = '(Spoofing|Tampering|Repudiation|Information Disclosure|Denial of Service|Elevation of Privilege)';
  const byId = new Map();
  const add = (id, category, summary) => {
    if (!byId.has(id)) byId.set(id, { id, category, summary: (summary || '').trim() });
  };

  const reTable = new RegExp(`^\\|\\s*(T-\\d+)\\s*\\|\\s*${CATS}\\s*\\|\\s*(.+?)\\s*\\|`, 'gm');
  let m;
  while ((m = reTable.exec(md)) !== null) add(m[1], m[2], m[3]);

  const reBullet = new RegExp(`^[-*]\\s*(T-\\d+)\\s*\\(\\s*${CATS}\\s*\\)\\s*[:\\-\\u2014]\\s*(.+)$`, 'gim');
  while ((m = reBullet.exec(md)) !== null) add(m[1], m[2], m[3]);

  const reHeading = new RegExp(
    `^#{1,6}\\s*(T-\\d+)\\s*[\\-\\u2014:]\\s*${CATS}\\s*$([\\s\\S]*?)(?=^#{1,6}\\s|$(?![\\s\\S]))`,
    'gim',
  );
  while ((m = reHeading.exec(md)) !== null) {
    const body =
      (m[3] || '')
        .split(/\n{2,}/)
        .map((s) => s.trim())
        .filter(Boolean)[0] || '';
    add(m[1], m[2], body);
  }

  const threats = Array.from(byId.values());

  if (!threats.length) {
    process.stderr.write('no STRIDE threats parsed (threat-model.md malformed)\n');
    return 1;
  }

  const secDir = path.join(CWD, 'tests', 'security');
  fs.mkdirSync(secDir, { recursive: true });

  const existing = new Set(fs.readdirSync(secDir).map((f) => f.split('.')[0]));
  const missing = threats.filter((t) => !existing.has(t.id));

  missing.forEach((t) => {
    const body = `// AUTO-STUB for ${t.id} (${t.category})
// Threat: ${t.summary}
// This must fail BEFORE mitigation and pass AFTER.
import { describe, test, expect } from 'vitest';

describe('${t.id} — ${t.category}', () => {
  test.todo('negative path: attacker action does NOT succeed');
  test.todo('positive path: legitimate action still works');
});
`;
    fs.writeFileSync(path.join(secDir, `${t.id}.spec.ts`), body);
  });

  const report = {
    ts: new Date().toISOString(),
    total: threats.length,
    covered: threats.length - missing.length,
    missing: missing.map((t) => t.id),
  };
  const out = path.join(CWD, '_cobolt-output', 'latest', 'security', 'threat-coverage.json');
  atomicWrite(out, JSON.stringify(report, null, 2));
  process.stdout.write(`threats: ${report.covered}/${report.total} covered; ${missing.length} stubs emitted\n`);
  return missing.length ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main };
