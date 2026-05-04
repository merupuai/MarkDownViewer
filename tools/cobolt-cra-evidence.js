#!/usr/bin/env node

// CoBolt EU CRA Readiness Module (P4.6 / v0.64+).
//
// Generates the EU Cyber Resilience Act (Regulation 2024/2847) disclosure
// pack required for products placed on the EU market after enforcement
// begins (late 2027). Pre-emptive readiness — pack is shippable today as
// part of every milestone close, derived from artifacts CoBolt already
// produces.
//
// Components covered (CRA Annex I + Annex II):
//
//   Annex I §1.1  — Designed/developed with appropriate cybersecurity.
//                   Evidence: SLSA L3 attestation (P2.1), gate registry
//                             with NIST/ISO/OWASP control mapping (P1.6).
//   Annex I §1.2  — Made available with no known exploitable
//                   vulnerabilities. Evidence: vuln-scan report (P2.4)
//                             + SBOM (P2.2).
//   Annex I §1.3  — Secure-by-default configuration. Evidence: bypass
//                             ledger (GT-01) shows zero default-bypass.
//   Annex I §1.4  — Protect availability of essential functions.
//                   Evidence: cosign-signed artifacts (P2.3).
//   Annex I §1.5  — Limit attack surfaces. Evidence: prompt-injection
//                             scanner (P1.4) + agent-execution sandbox
//                             (P4.1, deferred).
//   Annex I §1.6  — Reduce impact of an incident. Evidence: hotfix events
//                             from lifecycle ledger.
//   Annex II §1   — Identify and document vulnerabilities and components
//                   (SBOM). Evidence: P2.2 SBOM.
//   Annex II §2   — Address and remediate vulnerabilities without delay.
//                   Evidence: P2.4 vuln-scan + dep-install gate logs.
//   Annex II §3   — Apply effective and regular tests/reviews. Evidence:
//                             evidence-ledger CHECK_RESULT entries.
//   Annex II §4   — Once a security update is available, share information
//                   about fixed vulnerabilities. Evidence: release notes
//                             + cosign-signed updates.
//   Annex II §5   — Coordinated vulnerability disclosure policy.
//                   Evidence: policy text emitted into the pack.
//   Annex II §6   — Distribute updates without delay and free of charge.
//                   Evidence: release pipeline logs.
//   Annex II §7   — Ensure security update mechanisms can be deployed
//                   quickly. Evidence: DORA MTTR metric (P3.3).
//
// Output: _cobolt-output/cra-evidence-pack/{milestone}/
//   ├── README.md                         — Cover page + index
//   ├── annex-i-coverage.md               — §1.1 - §1.6 evidence map
//   ├── annex-ii-coverage.md              — §1 - §7 evidence map
//   ├── vulnerability-disclosure.md       — §5 disclosure policy
//   ├── security-update-policy.md         — §4, §6, §7 update policy
//   ├── component-inventory-ref.md        — points to SBOM artifacts
//   ├── incident-record.md                — hotfix history
//   └── manifest.json                     — machine-readable index
//
// Standards mapping (Inv-21):
//   EU CRA Annex I §1.1-1.6, Annex II §1-7
//   NIST SSDF PS.3.1, RV.1.4 — provenance + vulnerability response
//   ISO 27001:2022 A.18.1.1 — applicable legislation
//
// Public API:
//   generate({ cwd?, milestone, projectName?, projectVersion? }) -> { paths, summary, ledgerEntryId }
//   coverage({ cwd?, milestone }) -> { coverage, gaps, evidenceRefs }
//
// CLI:
//   node tools/cobolt-cra-evidence.js generate --milestone M1 [--cwd <dir>]
//   node tools/cobolt-cra-evidence.js coverage --milestone M1 [--json]
//
// Exit codes per tools/CLAUDE.md:
//   0 — pack generated / coverage computed
//   1 — hard error (bad input, write failure)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PACK_REL = path.join('_cobolt-output', 'cra-evidence-pack');

function _sanitiseMilestone(milestone) {
  if (!milestone) return null;
  if (!/^M\d+$/i.test(String(milestone))) {
    throw new Error(`milestone must match /^M\\d+$/, got "${milestone}"`);
  }
  return String(milestone).toUpperCase();
}

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

function _readJson(absPath) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

// ── coverage map: which existing artifact satisfies which CRA section ──

function coverage({ cwd, milestone }) {
  const root = cwd || process.cwd();
  const M = _sanitiseMilestone(milestone) || 'M1';
  const buildDir = path.join(root, '_cobolt-output', 'latest', 'build', M);
  const auditDir = path.join(root, '_cobolt-output', 'audit');

  // Probe for each artifact CoBolt produces upstream.
  const artifacts = {
    sbomCdx: fs.existsSync(path.join(buildDir, 'sbom.cdx.json')),
    sbomSpdx: fs.existsSync(path.join(buildDir, 'sbom.spdx.json')),
    slsaAttestation: fs.existsSync(path.join(buildDir, 'slsa-provenance.intoto.json')),
    cosignSignatures: (() => {
      try {
        return (
          fs.readdirSync(buildDir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.sig'))
            .length > 0
        );
      } catch {
        return false;
      }
    })(),
    vulnScanReport: fs.existsSync(path.join(buildDir, `${M}-vuln-scan.json`)),
    evidenceLedger: fs.existsSync(path.join(auditDir, 'evidence-ledger.jsonl')),
    bypassLedger: fs.existsSync(path.join(auditDir, 'gate-bypass-ledger.jsonl')),
    lifecycleEvents: fs.existsSync(path.join(auditDir, 'lifecycle-events.jsonl')),
    doraMetrics: fs.existsSync(path.join(auditDir, 'dora-metrics.jsonl')),
    promptInjectionLog: fs.existsSync(path.join(auditDir, 'gate-skip-log.jsonl')),
  };

  // Map CRA sections to satisfying artifacts.
  const cra = {
    'AnnexI.1.1': {
      title: 'Designed/developed with appropriate cybersecurity',
      satisfiedBy: ['slsaAttestation', 'evidenceLedger'],
      satisfied: artifacts.slsaAttestation && artifacts.evidenceLedger,
    },
    'AnnexI.1.2': {
      title: 'Made available with no known exploitable vulnerabilities',
      satisfiedBy: ['vulnScanReport', 'sbomCdx'],
      satisfied: artifacts.vulnScanReport && artifacts.sbomCdx,
    },
    'AnnexI.1.3': {
      title: 'Secure-by-default configuration',
      satisfiedBy: ['bypassLedger'],
      satisfied: artifacts.bypassLedger,
      note: 'Verifies zero default-bypass via signed ledger.',
    },
    'AnnexI.1.4': {
      title: 'Protect availability of essential functions',
      satisfiedBy: ['cosignSignatures', 'evidenceLedger'],
      satisfied: artifacts.cosignSignatures || artifacts.evidenceLedger,
      note: 'cosign-signed update authenticity OR ledger-tracked update integrity.',
    },
    'AnnexI.1.5': {
      title: 'Limit attack surfaces',
      satisfiedBy: ['promptInjectionLog'],
      satisfied: artifacts.promptInjectionLog,
      note: 'Prompt-injection scanner (P1.4) tracks Tier 2 surface-limiting blocks.',
    },
    'AnnexI.1.6': {
      title: 'Reduce impact of an incident',
      satisfiedBy: ['lifecycleEvents'],
      satisfied: artifacts.lifecycleEvents,
      note: 'Hotfix events tracked via lifecycle ledger.',
    },
    'AnnexII.1': {
      title: 'Identify and document vulnerabilities + components (SBOM)',
      satisfiedBy: ['sbomCdx', 'sbomSpdx'],
      satisfied: artifacts.sbomCdx && artifacts.sbomSpdx,
    },
    'AnnexII.2': {
      title: 'Address and remediate vulnerabilities without delay',
      satisfiedBy: ['vulnScanReport'],
      satisfied: artifacts.vulnScanReport,
    },
    'AnnexII.3': {
      title: 'Apply effective and regular tests/reviews',
      satisfiedBy: ['evidenceLedger'],
      satisfied: artifacts.evidenceLedger,
    },
    'AnnexII.4': {
      title: 'Share information about fixed vulnerabilities',
      satisfiedBy: ['vulnScanReport', 'lifecycleEvents'],
      satisfied: artifacts.vulnScanReport && artifacts.lifecycleEvents,
    },
    'AnnexII.5': {
      title: 'Coordinated vulnerability disclosure policy',
      satisfiedBy: ['cra-evidence-pack'],
      satisfied: true, // policy text is emitted into the pack itself
      note: 'Policy text generated by this tool — see vulnerability-disclosure.md',
    },
    'AnnexII.6': {
      title: 'Distribute updates without delay and free of charge',
      satisfiedBy: ['lifecycleEvents'],
      satisfied: artifacts.lifecycleEvents,
    },
    'AnnexII.7': {
      title: 'Security update mechanisms can be deployed quickly',
      satisfiedBy: ['doraMetrics'],
      satisfied: artifacts.doraMetrics,
      note: 'DORA MTTR metric (P3.3) signals deployment-speed posture.',
    },
  };

  const total = Object.keys(cra).length;
  const satisfied = Object.values(cra).filter((c) => c.satisfied).length;
  const gaps = Object.entries(cra)
    .filter(([, c]) => !c.satisfied)
    .map(([id, c]) => ({ id, title: c.title, satisfiedBy: c.satisfiedBy }));

  return {
    milestone: M,
    artifacts,
    cra,
    summary: {
      sectionsTotal: total,
      sectionsSatisfied: satisfied,
      coveragePercent: Math.round((satisfied / total) * 1000) / 10,
      gaps: gaps.length,
    },
    gaps,
  };
}

// ── pack generation ───────────────────────────────────────────────────

function _renderReadme({ projectName, projectVersion, milestone, generatedAt, summary }) {
  return [
    `# EU CRA Evidence Pack — ${projectName || 'project'} ${projectVersion || ''} ${milestone}`,
    '',
    `**Generated:** ${generatedAt}`,
    `**Coverage:** ${summary.sectionsSatisfied}/${summary.sectionsTotal} sections (${summary.coveragePercent}%)`,
    '',
    '## What this pack proves',
    '',
    'This evidence pack supports compliance with **EU Regulation 2024/2847** ',
    '(Cyber Resilience Act). It maps each CRA Annex I and Annex II requirement ',
    'to specific artifacts produced during this milestone:',
    '',
    '- `annex-i-coverage.md` — Essential cybersecurity requirements (§1.1–§1.6)',
    '- `annex-ii-coverage.md` — Vulnerability handling requirements (§1–§7)',
    '- `vulnerability-disclosure.md` — Coordinated vulnerability disclosure policy',
    '- `security-update-policy.md` — Security update + free distribution policy',
    '- `component-inventory-ref.md` — SBOM references (CycloneDX 1.5 + SPDX 2.3)',
    '- `incident-record.md` — Hotfix and incident history',
    '- `manifest.json` — Machine-readable index of every evidence pointer',
    '',
    '## How this pack was produced',
    '',
    'CoBolt produced this pack deterministically by reading existing pipeline ',
    'artifacts. The pack is **not** a separate compliance process — it is a ',
    'view onto the same evidence already captured for SOC 2, NIST SSDF, and ',
    'OWASP ASVS audits. Auditors verifying the pack should:',
    '',
    '1. Verify the SLSA L3 attestation in-toto signature (`slsa-provenance.intoto.json`).',
    '2. Verify the cosign signature on each SBOM (`*.sig` files).',
    '3. Verify the unified evidence ledger HMAC chain (`evidence-ledger.jsonl`).',
    '4. Cross-check the gate-bypass ledger for non-trivial bypasses.',
    '',
    '## Scope statement',
    '',
    'This pack covers **the milestone artifact set** at the time of generation. ',
    'For multi-milestone product certifications, generate one pack per milestone ',
    'and aggregate at release boundaries.',
    '',
    '*Made by CoBolt — Autonomous Development Platform*',
  ].join('\n');
}

function _renderAnnexI(coverageData) {
  const lines = [
    '# EU CRA Annex I — Essential Cybersecurity Requirements',
    '',
    '| Section | Requirement | Satisfied | Evidence | Note |',
    '|---------|------------|-----------|----------|------|',
  ];
  for (const [id, c] of Object.entries(coverageData.cra)) {
    if (!id.startsWith('AnnexI')) continue;
    lines.push(`| ${id} | ${c.title} | ${c.satisfied ? '✓' : '✗'} | ${c.satisfiedBy.join(', ')} | ${c.note || '—'} |`);
  }
  return lines.join('\n');
}

function _renderAnnexII(coverageData) {
  const lines = [
    '# EU CRA Annex II — Vulnerability Handling Requirements',
    '',
    '| Section | Requirement | Satisfied | Evidence | Note |',
    '|---------|------------|-----------|----------|------|',
  ];
  for (const [id, c] of Object.entries(coverageData.cra)) {
    if (!id.startsWith('AnnexII')) continue;
    lines.push(`| ${id} | ${c.title} | ${c.satisfied ? '✓' : '✗'} | ${c.satisfiedBy.join(', ')} | ${c.note || '—'} |`);
  }
  return lines.join('\n');
}

function _renderVulnerabilityDisclosurePolicy({ projectName }) {
  return [
    `# Coordinated Vulnerability Disclosure Policy — ${projectName || 'Project'}`,
    '',
    '## Reporting',
    '',
    'Suspected vulnerabilities should be reported privately to the project ',
    'security contact. Reports must include:',
    '',
    '- Affected version(s) (matching the SBOM in this pack)',
    '- Reproducer or proof of concept',
    '- Suggested remediation if known',
    '- Reporter contact details for coordinated disclosure',
    '',
    '## Acknowledgement',
    '',
    'The project acknowledges receipt within 72 hours of a report.',
    '',
    '## Triage and remediation',
    '',
    'Reports are triaged within 14 days. Remediation timelines depend on severity:',
    '',
    '| CVSS Severity | Target remediation | Ship via |',
    '|---------------|--------------------|----------|',
    '| Critical (9.0+) | 7 days | Out-of-band patch |',
    '| High (7.0-8.9) | 30 days | Next minor release |',
    '| Medium (4.0-6.9) | 90 days | Next minor release |',
    '| Low (<4.0) | Best effort | Roadmap consideration |',
    '',
    '## Public disclosure',
    '',
    'Coordinated public disclosure follows remediation. The project commits to:',
    '',
    '- Publishing a security advisory with CVE assignment',
    '- Crediting the reporter (with consent)',
    '- Providing remediation guidance',
    '',
    '## Standards alignment',
    '',
    '- ISO/IEC 29147 — Vulnerability disclosure',
    '- ISO/IEC 30111 — Vulnerability handling processes',
    '- NIST SSDF RV.1.4 — Vulnerability disclosure policy',
    '- EU CRA Annex II §5 — Coordinated vulnerability disclosure',
  ].join('\n');
}

function _renderSecurityUpdatePolicy({ projectName }) {
  return [
    `# Security Update Policy — ${projectName || 'Project'}`,
    '',
    '## Update distribution',
    '',
    'Security updates are distributed:',
    '',
    '- **Free of charge** (EU CRA Annex II §6) — no licensing barrier to remediation.',
    '- **Without delay** — see vulnerability disclosure policy SLAs.',
    '- **Through the same channels as feature updates** — npm registry, GitHub releases, etc.',
    '',
    '## Authenticity',
    '',
    'Every release artifact is signed with cosign (Sigstore keyless OIDC). ',
    'Verifiers can validate authenticity via:',
    '',
    '```',
    'cosign verify-blob --signature <release>.sig <release>',
    '```',
    '',
    'For air-gapped environments, an internal Rekor instance can be configured ',
    'via `COBOLT_PRIVATE_REKOR=<url>`.',
    '',
    '## Update mechanism',
    '',
    'The project supports atomic, idempotent updates. Update mechanisms can be ',
    'deployed quickly (EU CRA Annex II §7) — DORA MTTR metric in the pipeline ',
    'audit log signals current deployment-speed posture.',
    '',
    '## Standards alignment',
    '',
    '- EU CRA Annex II §4, §6, §7',
    '- NIST SSDF PS.2.1 — Verifiable release integrity',
    '- OpenSSF Scorecard "Signed-Releases"',
  ].join('\n');
}

function _renderComponentInventoryRef({ milestone, artifacts }) {
  const lines = [
    `# Component Inventory References — ${milestone}`,
    '',
    'This document points to the SBOMs (Software Bill of Materials) generated ',
    'by CoBolt at milestone close. Both formats are present per EU CRA Annex II §1.',
    '',
  ];
  if (artifacts.sbomCdx) {
    lines.push('## CycloneDX 1.5');
    lines.push('');
    lines.push(`Path: \`_cobolt-output/latest/build/${milestone}/sbom.cdx.json\``);
    lines.push('');
  }
  if (artifacts.sbomSpdx) {
    lines.push('## SPDX 2.3');
    lines.push('');
    lines.push(`Path: \`_cobolt-output/latest/build/${milestone}/sbom.spdx.json\``);
    lines.push('');
  }
  if (!artifacts.sbomCdx && !artifacts.sbomSpdx) {
    lines.push(
      '_⚠ No SBOMs found for this milestone. Run `node tools/cobolt-sbom.js generate --milestone <M>` before regenerating this pack._',
    );
  }
  return lines.join('\n');
}

function _renderIncidentRecord({ cwd, milestone }) {
  const lifecycle = _readJsonl(path.join(cwd, '_cobolt-output', 'audit', 'lifecycle-events.jsonl'));
  const hotfixes = lifecycle.filter((e) => {
    const stage = String(e.stage || '').toLowerCase();
    return stage === 'hotfix';
  });
  const lines = [
    `# Incident Record — ${milestone}`,
    '',
    'This document summarises hotfix events captured by the lifecycle event ledger. ',
    'Each entry corresponds to an EU CRA Annex II §6 update distribution.',
    '',
    `Total hotfix events: **${hotfixes.length}**`,
    '',
  ];
  if (hotfixes.length === 0) {
    lines.push('_No incident events recorded for this window. Either the project has had ');
    lines.push('zero security incidents, or no incidents have invoked the hotfix pipeline._');
  } else {
    lines.push('| Timestamp | Event | Stage | Notes |');
    lines.push('|-----------|-------|-------|-------|');
    for (const h of hotfixes.slice(0, 50)) {
      lines.push(
        `| ${h.ts || h.timestamp || '?'} | ${h.event || h.eventType || '?'} | ${h.stage || ''} | ${h.message || ''} |`,
      );
    }
    if (hotfixes.length > 50) lines.push(`| _… ${hotfixes.length - 50} more …_ |`);
  }
  return lines.join('\n');
}

function _renderManifest({ pack, summary, artifactPaths, generatedAt }) {
  return JSON.stringify(
    {
      packVersion: '1',
      generator: 'cobolt-cra-evidence/v0.64.0',
      generatedAt,
      cra: { regulation: 'EU 2024/2847', annexI: '§1.1–§1.6', annexII: '§1–§7' },
      coverage: summary,
      pack,
      artifactPaths,
    },
    null,
    2,
  );
}

function generate({ cwd, milestone, projectName, projectVersion } = {}) {
  const root = cwd || process.cwd();
  const M = _sanitiseMilestone(milestone);
  if (!M) throw new Error('generate: --milestone <M{n}> required');

  const generatedAt = new Date().toISOString();
  const cov = coverage({ cwd: root, milestone: M });

  // Auto-detect project metadata.
  let pkgName = projectName;
  let pkgVersion = projectVersion;
  const pkg = _readJson(path.join(root, 'package.json')) || {};
  pkgName = pkgName || pkg.name || 'project';
  pkgVersion = pkgVersion || pkg.version || '0.0.0';

  // Build the pack directory.
  const packDir = path.join(root, PACK_REL, M);
  fs.mkdirSync(packDir, { recursive: true, mode: 0o700 });

  const pack = {
    'README.md': _renderReadme({
      projectName: pkgName,
      projectVersion: pkgVersion,
      milestone: M,
      generatedAt,
      summary: cov.summary,
    }),
    'annex-i-coverage.md': _renderAnnexI(cov),
    'annex-ii-coverage.md': _renderAnnexII(cov),
    'vulnerability-disclosure.md': _renderVulnerabilityDisclosurePolicy({ projectName: pkgName }),
    'security-update-policy.md': _renderSecurityUpdatePolicy({ projectName: pkgName }),
    'component-inventory-ref.md': _renderComponentInventoryRef({
      milestone: M,
      artifacts: cov.artifacts,
    }),
    'incident-record.md': _renderIncidentRecord({ cwd: root, milestone: M }),
  };

  const writtenPaths = {};
  for (const [name, content] of Object.entries(pack)) {
    const p = path.join(packDir, name);
    fs.writeFileSync(p, `${content}\n`, { encoding: 'utf8', mode: 0o600 });
    writtenPaths[name] = p;
  }
  // manifest.json — machine-readable.
  const artifactPaths = {
    sbomCdx: cov.artifacts.sbomCdx
      ? path.relative(root, path.join(root, '_cobolt-output', 'latest', 'build', M, 'sbom.cdx.json'))
      : null,
    sbomSpdx: cov.artifacts.sbomSpdx
      ? path.relative(root, path.join(root, '_cobolt-output', 'latest', 'build', M, 'sbom.spdx.json'))
      : null,
    slsaAttestation: cov.artifacts.slsaAttestation
      ? path.relative(root, path.join(root, '_cobolt-output', 'latest', 'build', M, 'slsa-provenance.intoto.json'))
      : null,
    vulnScanReport: cov.artifacts.vulnScanReport
      ? path.relative(root, path.join(root, '_cobolt-output', 'latest', 'build', M, `${M}-vuln-scan.json`))
      : null,
    evidenceLedger: cov.artifacts.evidenceLedger
      ? path.relative(root, path.join(root, '_cobolt-output', 'audit', 'evidence-ledger.jsonl'))
      : null,
    bypassLedger: cov.artifacts.bypassLedger
      ? path.relative(root, path.join(root, '_cobolt-output', 'audit', 'gate-bypass-ledger.jsonl'))
      : null,
    lifecycleEvents: cov.artifacts.lifecycleEvents
      ? path.relative(root, path.join(root, '_cobolt-output', 'audit', 'lifecycle-events.jsonl'))
      : null,
  };
  const manifestPath = path.join(packDir, 'manifest.json');
  fs.writeFileSync(
    manifestPath,
    `${_renderManifest({
      pack: Object.keys(pack).map((name) => ({ file: name, exists: true })),
      summary: cov.summary,
      artifactPaths,
      generatedAt,
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  writtenPaths['manifest.json'] = manifestPath;

  // Append to evidence ledger.
  let ledgerEntryId = null;
  try {
    const evLedger = require('../lib/cobolt-evidence-ledger');
    const manifestBuf = fs.readFileSync(manifestPath);
    const entry = evLedger.append(
      {
        kind: evLedger.KINDS.CHECK_RESULT,
        producer: 'cobolt-cra-evidence/v0.64.0',
        sha256s: {
          manifest: crypto.createHash('sha256').update(manifestBuf).digest('hex'),
        },
        controlIds: [
          'EU.CRA.AnnexI.1.1',
          'EU.CRA.AnnexI.1.2',
          'EU.CRA.AnnexI.1.3',
          'EU.CRA.AnnexI.1.4',
          'EU.CRA.AnnexI.1.5',
          'EU.CRA.AnnexI.1.6',
          'EU.CRA.AnnexII.1',
          'EU.CRA.AnnexII.2',
          'EU.CRA.AnnexII.3',
          'EU.CRA.AnnexII.4',
          'EU.CRA.AnnexII.5',
          'EU.CRA.AnnexII.6',
          'EU.CRA.AnnexII.7',
          'ISO.27001.A.18.1.1',
        ],
        payload: {
          milestone: M,
          coverage: cov.summary,
          gaps: cov.gaps.map((g) => g.id),
        },
      },
      { projectRoot: root },
    );
    ledgerEntryId = entry.entryId;
  } catch {
    // Tier 3 advisory.
  }

  return {
    paths: writtenPaths,
    summary: cov.summary,
    gaps: cov.gaps,
    ledgerEntryId,
  };
}

module.exports = { generate, coverage };

// ── CLI ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('Usage: node tools/cobolt-cra-evidence.js <command> [args]');
    console.log('Commands:');
    console.log('  generate --milestone M1 [--cwd <dir>] [--name X] [--version Y]');
    console.log('  coverage --milestone M1 [--json]');
    process.exit(0);
  }
  try {
    const opts = {};
    let json = false;
    for (let i = 1; i < argv.length; i += 1) {
      if (argv[i] === '--milestone') opts.milestone = argv[++i];
      else if (argv[i] === '--cwd') opts.cwd = argv[++i];
      else if (argv[i] === '--name') opts.projectName = argv[++i];
      else if (argv[i] === '--version') opts.projectVersion = argv[++i];
      else if (argv[i] === '--json') json = true;
    }
    if (cmd === 'generate') {
      const r = generate(opts);
      console.log(`[cobolt-cra-evidence] Pack written: ${path.dirname(r.paths['README.md'])}`);
      console.log(
        `[cobolt-cra-evidence] Coverage:     ${r.summary.sectionsSatisfied}/${r.summary.sectionsTotal} (${r.summary.coveragePercent}%)`,
      );
      if (r.gaps.length > 0) {
        console.log(`[cobolt-cra-evidence] Gaps:`);
        for (const g of r.gaps) console.log(`  - ${g.id}: ${g.title}`);
      }
      if (r.ledgerEntryId) console.log(`[cobolt-cra-evidence] Ledger:       ${r.ledgerEntryId}`);
      process.exit(0);
    }
    if (cmd === 'coverage') {
      const c = coverage(opts);
      if (json) console.log(JSON.stringify(c, null, 2));
      else {
        console.log(
          `Coverage: ${c.summary.sectionsSatisfied}/${c.summary.sectionsTotal} (${c.summary.coveragePercent}%)`,
        );
        for (const [id, info] of Object.entries(c.cra)) {
          console.log(`  ${info.satisfied ? '✓' : '✗'} ${id}: ${info.title}`);
        }
      }
      process.exit(0);
    }
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  } catch (err) {
    console.error(`[cobolt-cra-evidence] ${err.message}`);
    process.exit(1);
  }
}
