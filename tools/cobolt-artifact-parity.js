#!/usr/bin/env node

// CoBolt Cross-Artifact Parity Gate (v0.18+)
//
// Multi-check parity gate that catches drift between pairs (or triples) of
// planning/build artifacts where downstream tooling treats both as
// authoritative. Complements cobolt-epic-milestone-parity.js (epic/milestone
// specific) with broader coverage.
//
// Supported checks:
//   prd-rtm               PRD FRs ↔ RTM entries (bidirectional)
//   ir-parent-fr          Implicit requirements parent-FR traceability
//   feature-registry      FEAT-NNN ↔ enriched-requirements ↔ epics
//   security-coding       security-requirements threats ↔ secure-coding-standard mitigations
//   release-infra         release-readiness checklist ↔ infra-manifest
//   production-evidence   executable-prd ↔ release-slices ↔ boundary-contracts
//   all                   run every check and aggregate
//
// Usage:
//   node tools/cobolt-artifact-parity.js check <name>
//   node tools/cobolt-artifact-parity.js check <name> --json
//   node tools/cobolt-artifact-parity.js check all --json
//
// Exit codes:
//   0 = parity OK
//   1 = usage error
//   2 = missing-inputs (artifact not present — may be expected for unstarted stages)
//   3 = parity-drift (one or more checks failed)

const fs = require('node:fs');
const wireframeResolver = require('../lib/cobolt-wireframe-resolver');
const path = require('node:path');
const { canonicalTrackerStories, getPlanningDir, safeReadJson } = require('../lib/cobolt-planning-artifacts');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_MISSING = 2;
const EXIT_DRIFT = 3;

function planningDir() {
  return getPlanningDir(process.cwd(), { create: false, fallbackToLatest: true });
}

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// v0.40.9 — strip markdown sections whose heading matches `headingRe`.
// Stops stripping at the next `##`-or-higher heading. Used by release-infra
// parity to ignore runbook/rollback prose when counting infra declarations.
function stripSections(markdown, headingRe) {
  if (!markdown) return '';
  const lines = markdown.split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const isHeading = /^##+\s+/.test(line);
    if (isHeading) skipping = headingRe.test(line);
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

// ── FR id normalization helpers ─────────────────────────────

function normFr(raw) {
  const n = parseInt(String(raw).match(/\d+/)?.[0] ?? '', 10);
  if (!Number.isFinite(n)) return null;
  return `FR-${String(n).padStart(3, '0')}`;
}

function extractFrIds(text) {
  if (!text) return [];
  return [...new Set([...text.matchAll(/\bFR-(?:[A-Z]{2,5}-)?\d{1,4}\b/g)].map((m) => normFr(m[0])))].filter(Boolean);
}

function extractFeatIds(text) {
  if (!text) return [];
  return [...new Set([...text.matchAll(/\bFEAT-\d{1,4}\b/g)].map((m) => m[0].toUpperCase()))];
}

function normalizeMilestoneId(value) {
  const m = String(value || '').match(/^M(\d+)$/i);
  if (!m) return null;
  return `M${parseInt(m[1], 10)}`;
}

// ── Check 1: prd-rtm ────────────────────────────────────────

function checkPrdRtm(pd) {
  const prdPath = path.join(pd, 'prd.md');
  const rtmPath = path.join(pd, 'rtm.json');
  if (!fs.existsSync(prdPath)) return { check: 'prd-rtm', status: 'skipped', reason: 'prd.md not found', findings: [] };
  if (!fs.existsSync(rtmPath))
    return { check: 'prd-rtm', status: 'skipped', reason: 'rtm.json not found', findings: [] };

  const prd = readIfExists(prdPath) || '';
  const rtm = safeReadJson(rtmPath) || {};
  const rtmReqs = rtm.requirements || {};
  // v0.40.8 — Normalize BOTH sides through normFr before comparison. Before
  // this fix, PRD IDs were zero-padded (normFr: FR-1 → FR-001) but RTM keys
  // were taken as-is from rtm.json. cobolt-rtm.js stores keys via
  // lib/cobolt-requirements.js::normalizeRequirementId which does NOT
  // zero-pad — so any PRD using short form (FR-1 .. FR-N, the common case)
  // produced 100% false-positive findings. Apply normFr to RTM keys.
  const rtmIds = new Set(
    Object.keys(rtmReqs)
      .filter((id) => id.startsWith('FR-'))
      .map((id) => normFr(id))
      .filter(Boolean),
  );
  const prdIds = new Set(extractFrIds(prd));

  const findings = [];
  for (const id of prdIds) {
    if (!rtmIds.has(id)) {
      findings.push({
        class: 'prd-fr-not-in-rtm',
        severity: 'high',
        id,
        message: `${id} appears in PRD but not in rtm.json`,
      });
    }
  }
  for (const id of rtmIds) {
    if (!prdIds.has(id)) {
      findings.push({
        class: 'rtm-fr-orphaned',
        severity: 'high',
        id,
        message: `${id} is in rtm.json but no longer referenced by PRD (stale)`,
      });
    }
  }

  return {
    check: 'prd-rtm',
    status: findings.length === 0 ? 'pass' : 'fail',
    prdFrCount: prdIds.size,
    rtmFrCount: rtmIds.size,
    findings,
  };
}

// ── Check 2: ir-parent-fr ───────────────────────────────────

function checkIrParentFr(pd) {
  const irPath = path.join(pd, 'implicit-requirements.md');
  const rtmPath = path.join(pd, 'rtm.json');
  if (!fs.existsSync(irPath))
    return { check: 'ir-parent-fr', status: 'skipped', reason: 'implicit-requirements.md not found', findings: [] };
  if (!fs.existsSync(rtmPath))
    return { check: 'ir-parent-fr', status: 'skipped', reason: 'rtm.json not found', findings: [] };

  const ir = readIfExists(irPath) || '';
  const rtm = safeReadJson(rtmPath) || {};
  // v0.40.8 — Same normalization drift as checkPrdRtm above.
  const rtmFrIds = new Set(
    Object.keys(rtm.requirements || {})
      .filter((id) => id.startsWith('FR-'))
      .map((id) => normFr(id))
      .filter(Boolean),
  );

  const findings = [];
  // Extract IR blocks: "IR-NNN" with their immediate surrounding text up to next IR header.
  const lines = ir.split('\n');
  let currentIr = null;
  let block = [];
  const flush = () => {
    if (!currentIr) return;
    const text = block.join(' ');
    const parents = extractFrIds(text);
    if (parents.length === 0) {
      findings.push({
        class: 'ir-no-parent',
        severity: 'medium',
        id: currentIr,
        message: `${currentIr} does not reference any parent FR`,
      });
    } else {
      for (const p of parents) {
        if (!rtmFrIds.has(p)) {
          findings.push({
            class: 'ir-parent-phantom',
            severity: 'high',
            id: currentIr,
            parent: p,
            message: `${currentIr} references parent ${p} which is not in RTM`,
          });
        }
      }
    }
  };
  for (const line of lines) {
    const irHeader = line.match(/^#{2,4}\s+(IR-\d{1,4})/i);
    if (irHeader) {
      flush();
      currentIr = irHeader[1].toUpperCase();
      block = [line];
    } else if (currentIr) {
      block.push(line);
    }
  }
  flush();

  return { check: 'ir-parent-fr', status: findings.length === 0 ? 'pass' : 'fail', findings };
}

// ── Check 3: feature-registry ───────────────────────────────

function checkFeatureRegistry(pd) {
  const regPath = path.join(pd, 'feature-registry.json');
  const enrichedPath = path.join(pd, 'enriched-requirements.md');
  const epicsPath = path.join(pd, 'epics.md');
  if (!fs.existsSync(regPath)) {
    return { check: 'feature-registry', status: 'skipped', reason: 'feature-registry.json not found', findings: [] };
  }
  const registry = safeReadJson(regPath) || {};
  const registered = Array.isArray(registry.features)
    ? new Set(registry.features.map((f) => String(f.id || f.featureId || '').toUpperCase()).filter(Boolean))
    : new Set();

  const enriched = readIfExists(enrichedPath) || '';
  const epics = readIfExists(epicsPath) || '';
  const enrichedIds = new Set(extractFeatIds(enriched));
  const epicsIds = new Set(extractFeatIds(epics));

  const findings = [];
  for (const id of registered) {
    if (enrichedPath && fs.existsSync(enrichedPath) && !enrichedIds.has(id)) {
      findings.push({
        class: 'feat-missing-in-enriched',
        severity: 'high',
        id,
        message: `${id} is in feature-registry.json but missing from enriched-requirements.md`,
      });
    }
    if (epicsPath && fs.existsSync(epicsPath) && !epicsIds.has(id)) {
      findings.push({
        class: 'feat-missing-in-epics',
        severity: 'high',
        id,
        message: `${id} is in feature-registry.json but missing from epics.md`,
      });
    }
  }
  for (const id of enrichedIds) {
    if (!registered.has(id)) {
      findings.push({
        class: 'enriched-feat-phantom',
        severity: 'high',
        id,
        message: `${id} is in enriched-requirements.md but absent from feature-registry.json`,
      });
    }
  }
  for (const id of epicsIds) {
    if (!registered.has(id)) {
      findings.push({
        class: 'epic-feat-phantom',
        severity: 'high',
        id,
        message: `${id} is referenced by epics.md but absent from feature-registry.json`,
      });
    }
  }

  return {
    check: 'feature-registry',
    status: findings.length === 0 ? 'pass' : 'fail',
    registeredCount: registered.size,
    enrichedCount: enrichedIds.size,
    epicsCount: epicsIds.size,
    findings,
  };
}

// ── Check 4: security-coding ────────────────────────────────

function checkSecurityCoding(pd) {
  const secPath = path.join(pd, 'security-requirements.md');
  const codingPath = path.join(pd, 'secure-coding-standard.md');
  if (!fs.existsSync(secPath)) {
    return { check: 'security-coding', status: 'skipped', reason: 'security-requirements.md not found', findings: [] };
  }
  if (!fs.existsSync(codingPath)) {
    return { check: 'security-coding', status: 'skipped', reason: 'secure-coding-standard.md not found', findings: [] };
  }

  const sec = readIfExists(secPath) || '';
  const coding = readIfExists(codingPath) || '';

  // Extract mitigation references in security-requirements.md of form:
  // "Mitigation: secure-coding-standard §X.Y" or "[coding §X.Y]" or "rule SC-###"
  const findings = [];
  const sectionRefs = [
    ...sec.matchAll(/(?:secure[-\s]coding[-\s]standard|coding standard)[^.]{0,60}?§\s*([\d.]+)/gi),
  ].map((m) => m[1]);
  const ruleRefs = [...sec.matchAll(/\bSC-\d{1,4}\b/g)].map((m) => m[0].toUpperCase());

  for (const section of new Set(sectionRefs)) {
    const regex = new RegExp(`(?:^|\\s)§\\s*${section.replace(/\./g, '\\.')}(?:\\s|$|[^0-9])`, 'm');
    if (!regex.test(coding)) {
      findings.push({
        class: 'mitigation-reference-dangling',
        severity: 'critical',
        section: `§${section}`,
        message: `security-requirements.md cites secure-coding-standard §${section} but that section is not present in secure-coding-standard.md`,
      });
    }
  }
  for (const rule of new Set(ruleRefs)) {
    if (!coding.includes(rule)) {
      findings.push({
        class: 'mitigation-rule-dangling',
        severity: 'critical',
        rule,
        message: `security-requirements.md cites rule ${rule} which is not defined in secure-coding-standard.md`,
      });
    }
  }

  // Detect threats without any mitigation reference at all.
  // Require a POSITIVE signal — "Mitigation:" label, SC-NNN rule, or explicit
  // "secure-coding-standard §X" citation. Catches prose like "no mitigation
  // cited" that would have falsely matched the word "mitigation" alone.
  const threatBlocks = sec.split(/^#{2,4}\s+(?:Threat|STRIDE|T-\d+)/im);
  let threatsWithoutMitigation = 0;
  for (let i = 1; i < threatBlocks.length; i += 1) {
    const block = threatBlocks[i];
    if (!/Mitigation\s*:|secure[-\s]coding[-\s]standard|\bSC-\d/i.test(block)) threatsWithoutMitigation += 1;
  }
  if (threatsWithoutMitigation > 0) {
    findings.push({
      class: 'threat-without-mitigation',
      severity: 'critical',
      count: threatsWithoutMitigation,
      message: `${threatsWithoutMitigation} threat block(s) in security-requirements.md have no mitigation reference`,
    });
  }

  return { check: 'security-coding', status: findings.length === 0 ? 'pass' : 'fail', findings };
}

// ── Check 5: release-infra ──────────────────────────────────

function checkReleaseInfra(pd) {
  const checklistPath = path.join(pd, 'release-readiness-checklist.md');
  // infra-manifest typically lives at project root, not in planning dir
  const candidates = [
    path.join(process.cwd(), 'infra-manifest.json'),
    path.join(process.cwd(), '_cobolt-output', 'latest', 'infra', 'infra-manifest.json'),
    path.join(process.cwd(), '_cobolt-output', 'latest', 'infra-manifest.json'),
  ];
  const infraPath = candidates.find((p) => fs.existsSync(p));
  if (!fs.existsSync(checklistPath)) {
    return {
      check: 'release-infra',
      status: 'skipped',
      reason: 'release-readiness-checklist.md not found',
      findings: [],
    };
  }
  if (!infraPath) {
    return {
      check: 'release-infra',
      status: 'skipped',
      reason: 'infra-manifest.json not found (infra stage may not have run)',
      findings: [],
    };
  }

  const checklist = readIfExists(checklistPath) || '';
  const manifest = safeReadJson(infraPath) || {};
  const findings = [];

  // v0.40.9 — strip operational-playbook sections before mining service nouns.
  // The previous implementation flagged "health-check" / "load balancer" when
  // they appeared only inside Rollback / Runbook / Incident-Response / Smoke-
  // Test playbook text (which is generic template language, not a declared
  // dependency). The parity contract is "checklist declares infra ⇒ manifest
  // must declare it", so we ignore prose that is purely operational.
  const OPERATIONAL_SECTION_RE =
    /^##+\s*(?:rollback(?:\s+plan)?|runbook|incident[-\s]response|operations?|smoke\s+test|playbook|post[-\s]?deploy|on[-\s]?call|escalation|emergency)/im;
  const sanitizedChecklist = stripSections(checklist, OPERATIONAL_SECTION_RE);

  // Infrastructure nouns mentioned in the checklist should be present in the manifest.
  // v0.40.9 — exclude matches that are part of a filename or path
  // (e.g. `health-check.log`), or the "health endpoint" verification check
  // which is a probe contract rather than a declared service.
  const SERVICE_NOUN_RE =
    /\b(database|postgres|mysql|redis|s3|object storage|queue|kafka|rabbitmq|load balancer|cdn|ingress|health[-\s]check|secret[s]?[-\s]manager|vault|worker|cron)\b(?!\.[a-z]{1,5}|\/)/gi;
  const serviceMentions = [...sanitizedChecklist.matchAll(SERVICE_NOUN_RE)].map((m) => m[0].toLowerCase());

  const manifestStr = JSON.stringify(manifest).toLowerCase();
  const missing = [];
  for (const noun of new Set(serviceMentions)) {
    if (!manifestStr.includes(noun)) missing.push(noun);
  }

  // Replica / multi-AZ claims in the checklist.
  const replicaClaim = /\b(multi[-\s]az|redundan|failover|replic|ha\s+mode|high availability)\b/i.test(checklist);
  if (replicaClaim && !/replic|redundan|multi|ha:|zones?:/i.test(manifestStr)) {
    findings.push({
      class: 'redundancy-claim-unsupported',
      severity: 'critical',
      message:
        'release-readiness-checklist.md claims redundancy/multi-AZ but infra-manifest.json declares no such configuration',
    });
  }

  if (missing.length > 0) {
    findings.push({
      class: 'checklist-service-not-in-manifest',
      severity: 'high',
      missing,
      message: `release-readiness-checklist.md references infrastructure that is absent from infra-manifest.json: ${missing.join(', ')}`,
    });
  }

  return { check: 'release-infra', status: findings.length === 0 ? 'pass' : 'fail', findings };
}

// ── Check 6: production-evidence ─────────────────────────────

function checkProductionEvidence(pd) {
  const epPath = path.join(pd, 'executable-prd.json');
  const rsPath = path.join(pd, 'release-slices.json');
  const bcPath = path.join(pd, 'boundary-contracts.json');
  const missing = [];
  if (!fs.existsSync(epPath)) missing.push('executable-prd.json');
  if (!fs.existsSync(rsPath)) missing.push('release-slices.json');
  if (!fs.existsSync(bcPath)) missing.push('boundary-contracts.json');
  if (missing.length > 0) {
    return { check: 'production-evidence', status: 'skipped', reason: `missing: ${missing.join(', ')}`, findings: [] };
  }

  const ep = safeReadJson(epPath) || {};
  const rs = safeReadJson(rsPath) || {};
  const bc = safeReadJson(bcPath) || {};
  const findings = [];

  // Every FR in executable-prd must appear in release-slices.
  const epFrs = new Set(
    (Array.isArray(ep.frs) ? ep.frs : Array.isArray(ep.requirements) ? ep.requirements : []).map((f) =>
      String(f.id || f.frId || f).toUpperCase(),
    ),
  );
  const sliceFrs = new Set();
  const slices = Array.isArray(rs.slices) ? rs.slices : Array.isArray(rs) ? rs : [];
  for (const slice of slices) {
    const ids = Array.isArray(slice.frs) ? slice.frs : Array.isArray(slice.requirements) ? slice.requirements : [];
    for (const id of ids) sliceFrs.add(String(id.id || id).toUpperCase());
  }
  for (const fr of epFrs) {
    if (!sliceFrs.has(fr)) {
      findings.push({
        class: 'fr-not-in-release-slice',
        severity: 'critical',
        id: fr,
        message: `${fr} has executable acceptance criteria but no release slice covers it`,
      });
    }
  }

  // Every slice must declare boundaries; each declared boundary must exist in boundary-contracts.
  const declaredBoundaries = new Set(
    (Array.isArray(bc.boundaries) ? bc.boundaries : Array.isArray(bc) ? bc : []).map((b) =>
      String(b.type || b.id || b.name || b).toLowerCase(),
    ),
  );
  for (const slice of slices) {
    const sliceBoundaries = Array.isArray(slice.boundaries) ? slice.boundaries : [];
    for (const boundary of sliceBoundaries) {
      const key = String(boundary.id || boundary.name || boundary).toLowerCase();
      if (!declaredBoundaries.has(key)) {
        findings.push({
          class: 'slice-boundary-undeclared',
          severity: 'critical',
          slice: slice.id || slice.name,
          boundary: key,
          message: `slice references boundary "${key}" but boundary-contracts.json does not declare it`,
        });
      }
    }
  }

  return { check: 'production-evidence', status: findings.length === 0 ? 'pass' : 'fail', findings };
}

// ── Check 7: wireframe-fr-milestones ─────────────────────────
// H-3 fix: wireframes reference FRs that must not belong to future milestones
// from the perspective of the current milestone in flight.
//
// v2.1+: wireframes fan out into _cobolt-output/latest/planning/wireframes/
// (greenfield) or _cobolt-output/latest/brownfield/31a-modernization-wireframes/
// (brownfield). The thin TOC at the legacy merged path no longer carries the
// per-screen detail we used to scan. Delegate to lib/cobolt-wireframe-resolver
// which traverses per-surface files for primary-flow FR references and falls
// back to the legacy merged-file scanner for pre-v2.1 outputs.
function checkWireframeFrMilestones(pd) {
  // pd is the planning dir; resolve the project cwd one level up so the
  // resolver can probe both greenfield and brownfield roots.
  const projectCwd = path.resolve(pd, '..', '..', '..');
  const wfPlan = wireframeResolver.discoverWireframeArtifacts({ cwd: projectCwd });
  if (wfPlan.mode === 'missing') {
    return { check: 'wireframe-fr-milestones', status: 'skipped', reason: 'wireframes not found', findings: [] };
  }
  const rtmPath = path.join(pd, 'rtm.json');
  if (!fs.existsSync(rtmPath)) {
    return { check: 'wireframe-fr-milestones', status: 'skipped', reason: 'rtm.json not found', findings: [] };
  }
  const rtm = safeReadJson(rtmPath) || {};
  const findings = [];

  // Resolver handles both layouts: per-surface scan in v2.1+ mode, legacy
  // primary-flow / user-flow / "## 1." section scan in legacy-merged mode.
  // Returns a Set of normalized FR IDs.
  const primaryFrs = wireframeResolver.extractPrimaryFlowFrIds({ cwd: projectCwd });
  if (primaryFrs.size === 0) {
    return { check: 'wireframe-fr-milestones', status: 'pass', findings: [] };
  }

  // Determine current milestone from state (best-effort).
  let currentMilestone = null;
  try {
    const statePath = path.join(process.cwd(), 'cobolt-state.json');
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      currentMilestone =
        normalizeMilestoneId(state?.pipeline?.currentMilestone) ||
        normalizeMilestoneId(state?.currentMilestone) ||
        normalizeMilestoneId(state?.build?.currentMilestone);
    }
  } catch {
    /* ignore */
  }

  // v0.40.8 — build normalized-key lookup so FR lookups match regardless of
  // whether rtm.json stored the padded or short form.
  const rtmByNormFr = new Map();
  for (const [rawId, reqObj] of Object.entries(rtm.requirements || {})) {
    const normId = normFr(rawId);
    if (normId) rtmByNormFr.set(normId, reqObj);
  }
  for (const fr of primaryFrs) {
    const req = rtmByNormFr.get(fr) ?? rtm.requirements?.[fr];
    if (!req) continue; // phantom handled by other checks
    const msList =
      Array.isArray(req.milestones) && req.milestones.length > 0
        ? req.milestones
        : req.milestone
          ? [req.milestone]
          : [];
    if (msList.length === 0) continue;
    const minMs = msList
      .map((m) => parseInt(m.replace(/^M/, ''), 10))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)[0];
    const curMs = currentMilestone ? parseInt(String(currentMilestone).replace(/^M/, ''), 10) : null;
    if (curMs && Number.isFinite(minMs) && minMs > curMs) {
      findings.push({
        class: 'wireframe-fr-future-milestone',
        severity: 'high',
        fr,
        wireframeFlow: 'primary',
        assignedMilestones: msList,
        currentMilestone: `M${curMs}`,
        message: `Primary wireframe flow uses ${fr} (assigned to ${msList.join(',')}) but current milestone is M${curMs}. The public cut of M${curMs} will ship with a broken user flow.`,
      });
    }
  }

  return { check: 'wireframe-fr-milestones', status: findings.length === 0 ? 'pass' : 'fail', findings };
}

// ── Check 8: infra-desktop-app ───────────────────────────────
// M-4 fix: desktop apps (Tauri/Electron) should NOT declare postgres/redis
// even as not-applicable in infra-manifest + docker-compose — it creates
// scaffold leakage and confuses future infra agents.
function checkInfraDesktopApp(_pd) {
  const cwd = process.cwd();
  const tauriConf =
    fs.existsSync(path.join(cwd, 'tauri.conf.json')) || fs.existsSync(path.join(cwd, 'src-tauri', 'tauri.conf.json'));
  const electronPkg = (() => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      return (
        Boolean(pkg.main && /^electron/.test(String(pkg.main))) ||
        Boolean(pkg.devDependencies?.electron || pkg.dependencies?.electron)
      );
    } catch {
      return false;
    }
  })();
  if (!tauriConf && !electronPkg) {
    return { check: 'infra-desktop-app', status: 'skipped', reason: 'not a desktop app project', findings: [] };
  }
  const manifestCandidates = [
    path.join(cwd, 'infra-manifest.json'),
    path.join(cwd, '_cobolt-output', 'latest', 'infra', 'infra-manifest.json'),
    path.join(cwd, '_cobolt-output', 'latest', 'infra-manifest.json'),
  ];
  const manifestPath = manifestCandidates.find((p) => fs.existsSync(p));
  const composeCandidates = [
    path.join(cwd, 'docker-compose.yml'),
    path.join(cwd, '_cobolt-docker', 'docker-compose.yml'),
    path.join(cwd, '_cobolt-output', 'latest', 'infra', 'docker-compose.yml'),
  ];
  const composePath = composeCandidates.find((p) => fs.existsSync(p));
  const findings = [];
  const leaks = ['postgres', 'redis', 'mysql', 'mongodb', 'kafka', 'rabbitmq'];

  if (manifestPath) {
    const m = safeReadJson(manifestPath) || {};
    for (const svc of leaks) {
      if (m.services?.[svc]) {
        findings.push({
          class: 'desktop-app-infra-leak-manifest',
          severity: 'medium',
          service: svc,
          file: path.relative(cwd, manifestPath),
          message: `Desktop-app project declares "${svc}" service in infra-manifest.json — remove it (even as "not-applicable" — that status still bootstraps downstream agents to check for it).`,
        });
      }
    }
  }
  if (composePath) {
    const text = readIfExists(composePath) || '';
    for (const svc of leaks) {
      const re = new RegExp(`^\\s*${svc}\\s*:`, 'im');
      if (re.test(text)) {
        findings.push({
          class: 'desktop-app-infra-leak-compose',
          severity: 'medium',
          service: svc,
          file: path.relative(cwd, composePath),
          message: `Desktop-app project declares "${svc}" service in ${path.basename(composePath)} — remove. Desktop apps do not run managed services.`,
        });
      }
    }
  }
  return { check: 'infra-desktop-app', status: findings.length === 0 ? 'pass' : 'fail', findings };
}

// ── Check 9: rtm-story-count ─────────────────────────────────
// M-5 fix: traceability-matrix.md reports Total: 30 stories while
// story-tracker.json has 31. Catch this off-by-one at parity time.
function checkRtmStoryCount(pd) {
  const rtmPath = path.join(pd, 'rtm.json');
  const stPath = path.join(pd, 'story-tracker.json');
  const tmPath = path.join(pd, 'traceability-matrix.md');
  if (!fs.existsSync(rtmPath) || !fs.existsSync(stPath)) {
    return {
      check: 'rtm-story-count',
      status: 'skipped',
      reason: 'rtm.json or story-tracker.json not found',
      findings: [],
    };
  }
  const rtm = safeReadJson(rtmPath) || {};
  const st = safeReadJson(stPath) || {};
  const rtmStories = new Set();
  for (const req of Object.values(rtm.requirements || {})) {
    for (const s of req.stories || []) rtmStories.add(s);
  }
  const stStories = new Set(canonicalTrackerStories(st.stories).map((story) => story.id || story));
  const findings = [];
  if (rtmStories.size !== stStories.size) {
    findings.push({
      class: 'rtm-story-count-drift',
      severity: 'medium',
      rtmStoryCount: rtmStories.size,
      storyTrackerCount: stStories.size,
      onlyInRtm: [...rtmStories].filter((s) => !stStories.has(s)),
      onlyInTracker: [...stStories].filter((s) => !rtmStories.has(s)),
      message: `RTM references ${rtmStories.size} unique stories; story-tracker.json has ${stStories.size} — regenerate traceability-matrix from tool output (not agent-authored).`,
    });
  }
  if (fs.existsSync(tmPath)) {
    const tm = readIfExists(tmPath) || '';
    const m =
      tm.match(/Coverage\s+Summary[\s\S]*?(\d+)\s+stor/i) ||
      tm.match(/Total:?\s*\d+\s+requirements?,?\s*\d+\s+epics?,?\s*(\d+)\s+stor/i);
    if (m) {
      const reported = parseInt(m[1], 10);
      if (reported !== stStories.size) {
        findings.push({
          class: 'traceability-matrix-story-count-stale',
          severity: 'medium',
          reportedInMd: reported,
          storyTrackerCount: stStories.size,
          message: `traceability-matrix.md Coverage Summary reports ${reported} stories; story-tracker has ${stStories.size}. Re-emit via deterministic tool.`,
        });
      }
    }
  }
  return { check: 'rtm-story-count', status: findings.length === 0 ? 'pass' : 'fail', findings };
}

// ── Check 10: schema-narrative-vs-data-model ─────────────────
// H-2 fix: cross-milestone-analysis narrative claims v1.1 adds fields that
// data-model-spec v1 already contains.
function checkSchemaNarrative(pd) {
  const xmPath = path.join(pd, 'cross-milestone-analysis.md');
  const dmPath = path.join(pd, 'data-model-spec.md');
  if (!fs.existsSync(xmPath) || !fs.existsSync(dmPath)) {
    return {
      check: 'schema-narrative-vs-data-model',
      status: 'skipped',
      reason: 'cross-milestone-analysis.md or data-model-spec.md not found',
      findings: [],
    };
  }
  const xm = readIfExists(xmPath) || '';
  const dm = readIfExists(dmPath) || '';
  const findings = [];

  // Look for patterns like "v1.1 adds <fieldNames>" or "v1.1 extends <fieldNames>"
  // and verify the fields are NOT already in the data-model v1 section.
  const re =
    /v1(?:\.0)?\s*→\s*v1\.1[\s\S]*?(?:adds?|introduces?|extends?\s+with)\s+([a-zA-Z_][\w, \t`-]+?)(?:\.|\n|$)/i;
  const m = xm.match(re);
  if (!m) return { check: 'schema-narrative-vs-data-model', status: 'pass', findings: [] };
  const fieldsRaw = m[1];
  const fields = fieldsRaw
    .split(/[,\s`]+/)
    .map((s) => s.trim())
    .filter((s) => /^[a-z][a-zA-Z0-9_]{2,}$/.test(s));
  const alreadyPresent = [];
  for (const f of fields) {
    // Look for field inside the v1 section specifically
    const v1Block = dm.match(/##?\s*v1(?:\.0)?[\s\S]*?(?=##?\s*v1\.1|$)/i);
    const hay = v1Block ? v1Block[0] : dm;
    const re2 = new RegExp(`(^|[^a-zA-Z0-9_])${f}\\s*[:=?]`, 'm');
    if (re2.test(hay)) alreadyPresent.push(f);
  }
  if (alreadyPresent.length > 0) {
    findings.push({
      class: 'schema-narrative-v1.1-already-in-v1',
      severity: 'high',
      fields: alreadyPresent,
      message: `cross-milestone-analysis.md claims v1.1 adds [${alreadyPresent.join(', ')}] but those fields already exist in data-model-spec.md v1. Either reduce v1 (deliver fields in v1.1) or remove the v1→v1.1 narrative.`,
    });
  }
  return { check: 'schema-narrative-vs-data-model', status: findings.length === 0 ? 'pass' : 'fail', findings };
}

// ── Check 11: prd-size-stat ──────────────────────────────────
// M-6 fix: source-document-consolidation.md reports stale size for PRD.
function checkPrdSizeStat(pd) {
  const sdcPath = path.join(pd, 'source-document-consolidation.md');
  if (!fs.existsSync(sdcPath)) {
    return {
      check: 'prd-size-stat',
      status: 'skipped',
      reason: 'source-document-consolidation.md not found',
      findings: [],
    };
  }
  const sdc = readIfExists(sdcPath) || '';
  const findings = [];
  // Look for lines like: "docs/PRD.md" size information
  const m = sdc.match(/docs\/PRD\.md[^\n]*?([\d,]+(?:\.\d+)?)\s*(KB|kb|B\b)/i);
  if (!m) return { check: 'prd-size-stat', status: 'pass', findings: [] };
  const reportedValue = parseFloat(String(m[1]).replace(/,/g, ''));
  const reportedKb = /^b$/i.test(m[2]) ? reportedValue / 1024 : reportedValue;
  const prdCandidates = [
    path.join(process.cwd(), 'docs', 'PRD.md'),
    path.join(process.cwd(), 'PRD.md'),
    path.join(pd, 'prd.md'),
  ];
  const prdPath = prdCandidates.find((p) => fs.existsSync(p));
  if (!prdPath) return { check: 'prd-size-stat', status: 'pass', findings: [] };
  const actualKb = fs.statSync(prdPath).size / 1024;
  // Allow 30% drift before flagging.
  if (Math.abs(actualKb - reportedKb) / actualKb > 0.3) {
    findings.push({
      class: 'source-doc-stat-drift',
      severity: 'low',
      reportedKb: Number(reportedKb.toFixed(1)),
      actualKb: Number(actualKb.toFixed(1)),
      message: `source-document-consolidation.md reports docs/PRD.md as ~${reportedKb.toFixed(1)} KB but actual size is ${actualKb.toFixed(1)} KB. Have the consolidation step stat the file and emit real size.`,
    });
  }
  return { check: 'prd-size-stat', status: findings.length === 0 ? 'pass' : 'fail', findings };
}

// ── Runner ──────────────────────────────────────────────────

const CHECKS = {
  'prd-rtm': checkPrdRtm,
  'ir-parent-fr': checkIrParentFr,
  'feature-registry': checkFeatureRegistry,
  'security-coding': checkSecurityCoding,
  'release-infra': checkReleaseInfra,
  'production-evidence': checkProductionEvidence,
  'wireframe-fr-milestones': checkWireframeFrMilestones,
  'infra-desktop-app': checkInfraDesktopApp,
  'rtm-story-count': checkRtmStoryCount,
  'schema-narrative-vs-data-model': checkSchemaNarrative,
  'prd-size-stat': checkPrdSizeStat,
};

function runCheck(name, opts) {
  const pd = planningDir();
  if (!pd) return { check: name, status: 'skipped', reason: 'planning-dir-missing', findings: [] };
  const fn = CHECKS[name];
  if (!fn) throw new Error(`Unknown check: ${name}`);
  return fn(pd, opts);
}

function runAll(opts) {
  return Object.keys(CHECKS).map((name) => runCheck(name, opts));
}

function emit(result, opts) {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const results = Array.isArray(result) ? result : [result];
  for (const r of results) {
    const badge = r.status === 'pass' ? 'PASS' : r.status === 'skipped' ? 'SKIP' : 'FAIL';
    process.stdout.write(
      `[${badge}] ${r.check} — ${(r.findings || []).length} finding(s)${r.reason ? ` (${r.reason})` : ''}\n`,
    );
    for (const f of (r.findings || []).slice(0, 5)) {
      process.stdout.write(`   • ${f.message || JSON.stringify(f)}\n`);
    }
    if ((r.findings || []).length > 5) {
      process.stdout.write(`   … ${r.findings.length - 5} more (use --json for full output)\n`);
    }
  }
}

function exitCodeFor(result) {
  const list = Array.isArray(result) ? result : [result];
  const anyFail = list.some((r) => r.status === 'fail');
  const allSkipped = list.every((r) => r.status === 'skipped');
  if (anyFail) return EXIT_DRIFT;
  if (allSkipped) return EXIT_MISSING;
  return EXIT_OK;
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opts = { json: args.includes('--json') };
  const isHelp = cmd === 'help' || cmd === '-h' || cmd === '--help';
  if (!cmd || isHelp) {
    const usage = [
      'Usage: cobolt-artifact-parity check <name>|all [--json]',
      '',
      'Checks:',
      ...Object.keys(CHECKS).map((n) => `  ${n}`),
      '  all',
    ].join('\n');
    // Help request → stdout + exit 0 (per tools/CLAUDE.md exit contract).
    // Bare invocation (no command at all) → stderr + exit 1 (usage error).
    if (isHelp) {
      process.stdout.write(`${usage}\n`);
      process.exit(0);
    }
    process.stderr.write(`${usage}\n`);
    process.exit(EXIT_USAGE);
  }
  if (cmd !== 'check') {
    process.stderr.write(`Unknown command: ${cmd}\n`);
    process.exit(EXIT_USAGE);
  }
  const name = args[1];
  if (!name) {
    process.stderr.write('Missing check name. Use `check all` to run everything.\n');
    process.exit(EXIT_USAGE);
  }

  try {
    let result;
    if (name === 'all') {
      result = runAll(opts);
    } else if (CHECKS[name]) {
      result = runCheck(name, opts);
    } else {
      process.stderr.write(`Unknown check: ${name}\n`);
      process.exit(EXIT_USAGE);
    }
    emit(result, opts);
    process.exit(exitCodeFor(result));
  } catch (err) {
    process.stderr.write(`[cobolt-artifact-parity] ERROR: ${err.message}\n`);
    process.exit(EXIT_USAGE);
  }
}

if (require.main === module) {
  main();
}

module.exports = { CHECKS, runCheck, runAll };
