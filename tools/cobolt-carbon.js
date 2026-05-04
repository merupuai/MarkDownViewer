#!/usr/bin/env node

// CoBolt Carbon-Aware CI Advisory (P4.3 / v0.64+).
//
// Estimates the carbon footprint of a milestone's CI/build activity and
// emits an advisory report. Tier 3 — never blocking. Required by EU CRA
// Annex II disclosure (sustainability section, voluntary in 2027 but
// expected to firm up by 2030) and by ISO 14064 GHG accounting frameworks.
//
// Estimation method (deterministic, no network):
//   energy_kWh   = sum(stage_duration_seconds * watts_per_node_estimate) / 3600 / 1000
//   carbon_kgCO2 = energy_kWh * grid_intensity_g_per_kWh / 1000
//
// Inputs:
//   - lifecycle-events.jsonl (stage timings)
//   - --region (or COBOLT_REGION env var) → static grid-intensity table
//   - --watts-per-node (defaults to 25W — typical CI runner under load,
//     halfway between idle laptop @5W and a saturated x86 server @100W)
//
// Static grid-intensity table (g CO2 per kWh, 2024 averages from Ember
// Climate / IEA — refreshed annually). Numbers reflect *average* grid mix
// for the region; actual marginal emissions vary by hour.
//
// Standards mapping (Inv-21):
//   Green Software Foundation — Software Carbon Intensity (SCI) spec.
//   ISO 14064-1 — GHG accounting at organisational level.
//   ISO/IEC 27001 A.8.16 — monitoring activities.
//
// Public API:
//   estimate({ cwd?, milestone, region?, wattsPerNode? }) -> { kgCO2e, ... }
//   write({ cwd?, milestone, region? }) -> { jsonPath, mdPath, summary, ledgerEntryId }
//
// CLI:
//   node tools/cobolt-carbon.js estimate --milestone M1 [--region eu-west] [--watts 25] [--json]
//   node tools/cobolt-carbon.js write --milestone M1 [--region eu-west]
//   node tools/cobolt-carbon.js regions [--json]
//
// Exit codes per tools/CLAUDE.md:
//   0 — estimation produced
//   1 — hard error (bad input, write failure)

const fs = require('node:fs');
const path = require('node:path');

const REL_LIFECYCLE = path.join('_cobolt-output', 'audit', 'lifecycle-events.jsonl');
const DEFAULT_WATTS_PER_NODE = 25;

// Grid intensity (g CO2e per kWh) — 2024 averages. Sources: Ember Climate
// (https://ember-climate.org), IEA Electricity Information 2024.
//
// Each entry is { region, country, gPerKWh, source, year }. Adding a
// region requires updating both this table and the regions test.
const GRID_INTENSITY = {
  // Europe
  'eu-west': { gPerKWh: 220, country: 'EU average', source: 'Ember 2024' },
  'eu-north': { gPerKWh: 50, country: 'Sweden / Norway / Iceland', source: 'Ember 2024' },
  'eu-central': { gPerKWh: 380, country: 'Germany', source: 'Ember 2024' },
  'eu-south': { gPerKWh: 250, country: 'Spain / Italy', source: 'Ember 2024' },
  // Americas
  'us-east': { gPerKWh: 380, country: 'US East', source: 'EIA 2024' },
  'us-west': { gPerKWh: 290, country: 'US West', source: 'EIA 2024' },
  'us-central': { gPerKWh: 470, country: 'US Central', source: 'EIA 2024' },
  ca: { gPerKWh: 110, country: 'Canada', source: 'IEA 2024' },
  br: { gPerKWh: 100, country: 'Brazil (hydro-heavy)', source: 'IEA 2024' },
  // APAC
  'ap-east': { gPerKWh: 530, country: 'Hong Kong / Singapore', source: 'IEA 2024' },
  'ap-southeast': { gPerKWh: 720, country: 'Indonesia / Vietnam', source: 'IEA 2024' },
  'ap-south': { gPerKWh: 690, country: 'India', source: 'IEA 2024' },
  'ap-northeast': { gPerKWh: 470, country: 'Japan', source: 'IEA 2024' },
  cn: { gPerKWh: 580, country: 'China', source: 'IEA 2024' },
  au: { gPerKWh: 540, country: 'Australia', source: 'IEA 2024' },
  // Default fallback — global average per IEA 2024.
  global: { gPerKWh: 460, country: 'World average', source: 'IEA 2024' },
};

function _readJsonl(absPath) {
  if (!fs.existsSync(absPath)) return [];
  return fs
    .readFileSync(absPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function _sanitiseMilestone(milestone) {
  if (!milestone) return null;
  if (!/^M\d+$/i.test(String(milestone))) {
    throw new Error(`milestone must match /^M\\d+$/, got "${milestone}"`);
  }
  return String(milestone).toUpperCase();
}

function _resolveRegion(region) {
  const r = (region || process.env.COBOLT_REGION || 'global').toLowerCase();
  return GRID_INTENSITY[r] ? { id: r, ...GRID_INTENSITY[r] } : { id: 'global', ...GRID_INTENSITY.global };
}

// ── stage-duration extraction ─────────────────────────────────────────
//
// We pair stage-started + stage-completed (or stage-failed) events by
// stage name. Unpaired starts are billed at a defensive ceiling of
// 600 seconds (10 minutes) — biased high so the carbon estimate does
// not understate when events are truncated.

function _stagesAndDurations({ lifecycle, milestone }) {
  const M = milestone || null;
  const stages = [];
  const open = new Map(); // stage → started timestamp
  for (const e of lifecycle) {
    const evt = String(e.event || e.eventType || '').toLowerCase();
    const stage = String(e.stage || '').toLowerCase();
    if (!stage) continue;
    if (M && e.milestone && e.milestone !== M) continue;
    const ts = new Date(e.ts || e.timestamp).getTime();
    if (Number.isNaN(ts)) continue;
    if (evt === 'stage-started') {
      open.set(stage, ts);
    } else if (evt === 'stage-completed' || evt === 'stage-failed') {
      const startedAt = open.get(stage);
      if (startedAt) {
        stages.push({ stage, durationSec: (ts - startedAt) / 1000, status: evt });
        open.delete(stage);
      } else {
        // Completed without a start in our window — count it but mark as
        // truncated (gives the user a signal but doesn't break estimation).
        stages.push({ stage, durationSec: 60, status: `${evt}-truncated-start` });
      }
    }
  }
  // Any still-open stages are still running OR truncated — bill defensively.
  for (const [stage] of open) {
    stages.push({ stage, durationSec: 600, status: 'open-truncated' });
  }
  return stages;
}

// ── public estimate ──────────────────────────────────────────────────

function estimate({ cwd, milestone, region, wattsPerNode = DEFAULT_WATTS_PER_NODE } = {}) {
  const root = cwd || process.cwd();
  const M = _sanitiseMilestone(milestone) || null;
  const grid = _resolveRegion(region);
  const lifecycle = _readJsonl(path.join(root, REL_LIFECYCLE));
  const stages = _stagesAndDurations({ lifecycle, milestone: M });

  const totalSec = stages.reduce((acc, s) => acc + s.durationSec, 0);
  const energyKWh = (totalSec * wattsPerNode) / 3600 / 1000;
  const kgCO2e = (energyKWh * grid.gPerKWh) / 1000;

  // Per-stage breakdown.
  const byStage = {};
  for (const s of stages) {
    const sec = byStage[s.stage]?.durationSec || 0;
    byStage[s.stage] = { durationSec: sec + s.durationSec };
  }
  for (const stage of Object.keys(byStage)) {
    const sec = byStage[stage].durationSec;
    byStage[stage].energyKWh = Math.round(((sec * wattsPerNode) / 3600 / 1000) * 1e6) / 1e6;
    byStage[stage].kgCO2e = Math.round(((byStage[stage].energyKWh * grid.gPerKWh) / 1000) * 1e6) / 1e6;
  }

  return {
    milestone: M,
    region: grid,
    wattsPerNode,
    stagesObserved: stages.length,
    totalDurationSec: Math.round(totalSec * 100) / 100,
    energyKWh: Math.round(energyKWh * 1e6) / 1e6,
    kgCO2e: Math.round(kgCO2e * 1e6) / 1e6,
    gCO2e: Math.round(kgCO2e * 1e3 * 1e6) / 1e6,
    byStage,
    generatedAt: new Date().toISOString(),
    note:
      'Advisory estimate. Method: stage-duration × wattsPerNode × grid intensity. ' +
      'Marginal emissions vary by hour; actual values depend on runner location ' +
      'and power source mix at execution time.',
  };
}

function write({ cwd, milestone, region, wattsPerNode } = {}) {
  const root = cwd || process.cwd();
  const e = estimate({ cwd: root, milestone, region, wattsPerNode });
  const auditDir = path.join(root, '_cobolt-output', 'audit');
  fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  const jsonPath = path.join(auditDir, 'carbon-estimate.json');
  const mdPath = path.join(auditDir, 'carbon-estimate.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(e, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  const lines = [
    `# Carbon Footprint — ${e.milestone || 'all'}`,
    '',
    `Region: **${e.region.id}** (${e.region.country}, ${e.region.gPerKWh}gCO₂/kWh per ${e.region.source})`,
    `Watts per node: **${e.wattsPerNode}W**`,
    `Stages observed: **${e.stagesObserved}**`,
    `Total duration: **${e.totalDurationSec}s**`,
    '',
    '## Footprint',
    '',
    `- **${e.kgCO2e}kg CO₂e** (${e.gCO2e}g CO₂e)`,
    `- **${e.energyKWh}kWh** energy consumed`,
    '',
    '## By stage',
    '',
    '| Stage | Duration (s) | Energy (kWh) | CO₂e (kg) |',
    '|-------|--------------|--------------|-----------|',
  ];
  for (const [stage, info] of Object.entries(e.byStage)) {
    lines.push(`| ${stage} | ${Math.round(info.durationSec * 100) / 100} | ${info.energyKWh} | ${info.kgCO2e} |`);
  }
  lines.push('');
  lines.push(`> ${e.note}`);
  lines.push('');
  lines.push('Standards: Green Software Foundation SCI; ISO 14064-1; ISO 27001 A.8.16.');
  lines.push('');
  lines.push('*Made by CoBolt — Autonomous Development Platform*');
  fs.writeFileSync(mdPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });

  // Append to evidence ledger.
  let ledgerEntryId = null;
  try {
    const evLedger = require('../lib/cobolt-evidence-ledger');
    const entry = evLedger.append(
      {
        kind: evLedger.KINDS.CHECK_RESULT,
        producer: 'cobolt-carbon/v0.64.0',
        controlIds: ['ISO.27001.A.8.16'],
        payload: {
          milestone: e.milestone,
          region: e.region.id,
          kgCO2e: e.kgCO2e,
          energyKWh: e.energyKWh,
          stagesObserved: e.stagesObserved,
        },
      },
      { projectRoot: root },
    );
    ledgerEntryId = entry.entryId;
  } catch {
    // Tier 3 advisory.
  }
  return { jsonPath, mdPath, summary: e, ledgerEntryId };
}

function listRegions() {
  return Object.entries(GRID_INTENSITY).map(([id, info]) => ({ id, ...info }));
}

module.exports = {
  estimate,
  write,
  listRegions,
  GRID_INTENSITY,
  DEFAULT_WATTS_PER_NODE,
  // Internals exposed for tests.
  _internal: { _stagesAndDurations, _resolveRegion },
};

// ── CLI ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('Usage: node tools/cobolt-carbon.js <command> [args]');
    console.log('Commands:');
    console.log('  estimate --milestone M1 [--region eu-west] [--watts 25] [--json]');
    console.log('  write    --milestone M1 [--region eu-west] [--watts 25]');
    console.log('  regions  [--json]');
    process.exit(0);
  }
  try {
    const opts = {};
    let json = false;
    for (let i = 1; i < argv.length; i += 1) {
      if (argv[i] === '--milestone') opts.milestone = argv[++i];
      else if (argv[i] === '--region') opts.region = argv[++i];
      else if (argv[i] === '--watts') opts.wattsPerNode = Number(argv[++i]);
      else if (argv[i] === '--cwd') opts.cwd = argv[++i];
      else if (argv[i] === '--json') json = true;
    }
    if (cmd === 'estimate') {
      const e = estimate(opts);
      if (json) {
        console.log(JSON.stringify(e, null, 2));
      } else {
        console.log(`[cobolt-carbon] Region: ${e.region.id} (${e.region.gPerKWh}gCO₂/kWh)`);
        console.log(`[cobolt-carbon] Stages observed: ${e.stagesObserved}`);
        console.log(`[cobolt-carbon] Energy: ${e.energyKWh}kWh`);
        console.log(`[cobolt-carbon] CO₂e:   ${e.kgCO2e}kg (${e.gCO2e}g)`);
      }
      process.exit(0);
    }
    if (cmd === 'write') {
      const r = write(opts);
      console.log(`[cobolt-carbon] JSON: ${r.jsonPath}`);
      console.log(`[cobolt-carbon] MD:   ${r.mdPath}`);
      console.log(`[cobolt-carbon] CO₂e: ${r.summary.kgCO2e}kg`);
      if (r.ledgerEntryId) console.log(`[cobolt-carbon] Ledger: ${r.ledgerEntryId}`);
      process.exit(0);
    }
    if (cmd === 'regions') {
      const r = listRegions();
      if (json) console.log(JSON.stringify(r, null, 2));
      else for (const e of r) console.log(`  ${e.id.padEnd(15)} ${e.gPerKWh}g/kWh  ${e.country}`);
      process.exit(0);
    }
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  } catch (err) {
    console.error(`[cobolt-carbon] ${err.message}`);
    process.exit(1);
  }
}
