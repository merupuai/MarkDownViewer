#!/usr/bin/env node

// CoBolt Capability Graph - deterministic feature-to-surface dependency model.
//
// This tool turns the feature registry and planning packet into a product
// capability graph. It catches "feature islands" by making adjacent surfaces
// explicit: settings, dashboards, analytics, notifications, permissions, audit
// logs, search, billing, rollout, observability, and similar surfaces.

const fs = require('node:fs');
const path = require('node:path');

const { getPlanningDir, normalizeMilestoneId, safeReadJson } = require('../lib/cobolt-planning-artifacts');

const SURFACE_CATALOG = [
  {
    key: 'settings',
    label: 'Settings',
    edgeType: 'configures',
    patterns: [/\bsettings?\b/i, /\bpreferences?\b/i, /\bconfiguration\b/i, /\bworkspace\s+policy\b/i],
    proofTerms: ['settings', 'preference', 'configuration', 'policy'],
    requiredProof: ['settings UI or configuration assertion'],
  },
  {
    key: 'dashboard',
    label: 'Dashboard',
    edgeType: 'summarized_by',
    patterns: [/\bdashboards?\b/i, /\bsummary\b/i, /\bwidget\b/i, /\bchart\b/i, /\bcount\b/i],
    proofTerms: ['dashboard', 'summary', 'widget', 'chart', 'count'],
    requiredProof: ['dashboard summary, widget, or route smoke assertion'],
  },
  {
    key: 'analytics',
    label: 'Analytics',
    edgeType: 'emits_event',
    patterns: [/\banalytics?\b/i, /\btracking\b/i, /\bevent(s)?\b/i, /\btelemetry\b/i, /\bposthog\b/i],
    proofTerms: ['analytics', 'tracking', 'event', 'telemetry'],
    requiredProof: ['analytics event assertion with event name'],
  },
  {
    key: 'notifications',
    label: 'Notifications',
    edgeType: 'notifies',
    patterns: [/\bnotification(s)?\b/i, /\bemail\b/i, /\bsms\b/i, /\bin-app\b/i, /\bwebhook\b/i],
    proofTerms: ['notification', 'email', 'sms', 'webhook', 'in-app'],
    requiredProof: ['notification delivery, queue, or webhook assertion'],
  },
  {
    key: 'permissions',
    label: 'Permissions',
    edgeType: 'authorized_by',
    patterns: [/\bpermissions?\b/i, /\brbac\b/i, /\brole(s)?\b/i, /\bauth(orization|z)?\b/i, /\bowner-only\b/i],
    proofTerms: ['permission', 'rbac', 'role', 'authorization', 'owner'],
    requiredProof: ['permission matrix or authorization negative-path test'],
  },
  {
    key: 'auditLog',
    label: 'Audit Log',
    edgeType: 'audited_by',
    patterns: [/\baudit\b/i, /\blog(s|ged|ging)?\b/i, /\bactivity\b/i, /\btrail\b/i],
    proofTerms: ['audit', 'log', 'activity', 'trail'],
    requiredProof: ['audit log assertion for state-changing action'],
  },
  {
    key: 'admin',
    label: 'Admin',
    edgeType: 'managed_by',
    patterns: [/\badmin\b/i, /\boperator\b/i, /\bmoderation\b/i, /\bbackoffice\b/i],
    proofTerms: ['admin', 'operator', 'moderation', 'backoffice'],
    requiredProof: ['admin/operator flow assertion or explicit non-impact check'],
  },
  {
    key: 'search',
    label: 'Search',
    edgeType: 'indexed_by',
    patterns: [/\bsearch\b/i, /\bindex(ed|ing)?\b/i, /\bfilter(s|ing)?\b/i, /\bquery\b/i],
    proofTerms: ['search', 'index', 'filter', 'query'],
    requiredProof: ['search/index/filter regression assertion'],
  },
  {
    key: 'importExport',
    label: 'Import/Export',
    edgeType: 'moves_data_through',
    patterns: [/\bimport\b/i, /\bexport\b/i, /\bcsv\b/i, /\bdownload\b/i, /\bupload\b/i],
    proofTerms: ['import', 'export', 'csv', 'download', 'upload'],
    requiredProof: ['import/export or file boundary assertion'],
  },
  {
    key: 'billing',
    label: 'Billing',
    edgeType: 'commercialized_by',
    patterns: [/\bbilling\b/i, /\bpayment\b/i, /\binvoice\b/i, /\bsubscription\b/i, /\bprice\b/i],
    proofTerms: ['billing', 'payment', 'invoice', 'subscription', 'price'],
    requiredProof: ['billing, entitlement, or ledger contract assertion'],
  },
  {
    key: 'privacy',
    label: 'Privacy',
    edgeType: 'governed_by',
    patterns: [/\bprivacy\b/i, /\bpii\b/i, /\bpersonal\s+data\b/i, /\bretention\b/i, /\bconsent\b/i],
    proofTerms: ['privacy', 'pii', 'personal data', 'retention', 'consent'],
    requiredProof: ['privacy/data-handling assertion or retention check'],
  },
  {
    key: 'featureFlags',
    label: 'Feature Flags',
    edgeType: 'rolled_out_by',
    patterns: [/\bfeature\s+flag\b/i, /\bflag(s|ged)?\b/i, /\brollout\b/i, /\bkill\s*switch\b/i],
    proofTerms: ['feature flag', 'flag', 'rollout', 'kill switch'],
    requiredProof: ['feature flag default, rollout, or kill-switch assertion'],
  },
  {
    key: 'observability',
    label: 'Observability',
    edgeType: 'observed_by',
    patterns: [/\bobservability\b/i, /\bmetric(s)?\b/i, /\btrace(s)?\b/i, /\blog(s|ging)?\b/i, /\balert(s)?\b/i],
    proofTerms: ['observability', 'metric', 'trace', 'log', 'alert'],
    requiredProof: ['log, metric, trace, or alert assertion'],
  },
  {
    key: 'supportOps',
    label: 'Support/Ops',
    edgeType: 'supported_by',
    patterns: [/\bsupport\b/i, /\bhelpdesk\b/i, /\bops\b/i, /\bescalation\b/i, /\brecovery\b/i],
    proofTerms: ['support', 'helpdesk', 'ops', 'escalation', 'recovery'],
    requiredProof: ['support workflow, runbook, or escalation assertion'],
  },
  {
    key: 'integrations',
    label: 'Integrations',
    edgeType: 'integrates_with',
    patterns: [/\bintegration(s)?\b/i, /\bthird-party\b/i, /\bprovider\b/i, /\bexternal\b/i, /\bconnector\b/i],
    proofTerms: ['integration', 'third-party', 'provider', 'external', 'connector'],
    requiredProof: ['integration contract, retry, timeout, or sandbox assertion'],
  },
  {
    key: 'api',
    label: 'API',
    edgeType: 'exposed_by',
    patterns: [/\bapi\b/i, /\bendpoint\b/i, /\bopenapi\b/i, /\broute\b/i, /\bhttp\b/i],
    proofTerms: ['api', 'endpoint', 'openapi', 'route', 'http'],
    requiredProof: ['API contract or route test'],
  },
  {
    key: 'data',
    label: 'Data',
    edgeType: 'persists_to',
    patterns: [/\bdata\b/i, /\bdatabase\b/i, /\bentity\b/i, /\btable\b/i, /\bmigration\b/i],
    proofTerms: ['data', 'database', 'entity', 'table', 'migration'],
    requiredProof: ['migration, repository, or data lifecycle assertion'],
  },
  {
    key: 'ui',
    label: 'UI',
    edgeType: 'experienced_through',
    patterns: [/\bui\b/i, /\bscreen\b/i, /\bpage\b/i, /\bcomponent\b/i, /\bform\b/i, /\bmodal\b/i],
    proofTerms: ['ui', 'screen', 'page', 'component', 'form', 'modal'],
    requiredProof: ['UI state, route, or component assertion'],
  },
  {
    key: 'tests',
    label: 'Tests',
    edgeType: 'proven_by',
    patterns: [/\btest(s|ing)?\b/i, /\bgherkin\b/i, /\bgiven\b/i, /\bwhen\b/i, /\bthen\b/i],
    proofTerms: ['test', 'testing', 'given', 'when', 'then'],
    requiredProof: ['unit, integration, E2E, or acceptance test evidence'],
  },
  {
    key: 'accessibility',
    label: 'Accessibility',
    edgeType: 'accessible_by',
    patterns: [/\baccessibility\b/i, /\ba11y\b/i, /\bwcag\b/i, /\bkeyboard\b/i, /\bscreen\s+reader\b/i],
    proofTerms: ['accessibility', 'a11y', 'wcag', 'keyboard', 'screen reader'],
    requiredProof: ['WCAG, keyboard, or screen-reader assertion'],
  },
  {
    key: 'i18n',
    label: 'Internationalization',
    edgeType: 'localized_by',
    patterns: [/\bi18n\b/i, /\blocali[sz]ation\b/i, /\blocale\b/i, /\brtl\b/i, /\btranslation\b/i],
    proofTerms: ['i18n', 'localization', 'locale', 'rtl', 'translation'],
    requiredProof: ['locale, formatting, or RTL assertion'],
  },
];

const SURFACE_BY_KEY = new Map(SURFACE_CATALOG.map((surface) => [surface.key, surface]));
const ALLOWED_SURFACE_STATUSES = new Set(['impacts', 'not_applicable', 'verify_no_change', 'deferred', 'blocked']);
const REASON_REQUIRED_STATUSES = new Set(['not_applicable', 'verify_no_change', 'deferred', 'blocked']);

const COVERAGE_SURFACE_MAP = {
  ui: ['ui'],
  uiStates: ['ui'],
  wireframes: ['ui'],
  api: ['api'],
  middleware: ['api'],
  backend: ['api', 'data'],
  data: ['data'],
  integrations: ['integrations'],
  auth: ['permissions'],
  security: ['permissions', 'auditLog'],
  privacy: ['privacy'],
  observability: ['observability'],
  tests: ['tests'],
  rollout: ['featureFlags'],
  accessibility: ['accessibility'],
};

const FINAL_PLANNING_ARTIFACTS = [
  'enriched-requirements.md',
  'feature-service-blueprints.md',
  'architecture.md',
  'system-architecture.md',
  'api-contracts.md',
  'data-model-spec.md',
  'security-requirements.md',
  'delivery-plan.md',
  'ux-design-specification.md',
  'wireframes-and-user-flows.md',
  'dependency-register.md',
  'test-strategy.md',
  'epics.md',
  'milestones.md',
  'cross-milestone-analysis.md',
  'master-plan.md',
  'release-readiness-checklist.md',
];

function resolvePlanningDir(projectRoot = process.cwd(), explicitPlanningDir = null) {
  if (explicitPlanningDir) return path.resolve(projectRoot, explicitPlanningDir);
  return (
    getPlanningDir(projectRoot, { create: false, strict: false, fallbackToLatest: true }) ||
    path.join(projectRoot, '_cobolt-output', 'latest', 'planning')
  );
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(readText(filePath));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function emitJson(value, outPath = null) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (outPath) {
    const resolved = path.resolve(process.cwd(), outPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, text, 'utf8');
  }
  process.stdout.write(text);
}

function normalizeFeatureId(value) {
  const match = String(value || '')
    .trim()
    .match(/FEAT-\d+/i);
  return match ? match[0].toUpperCase() : '';
}

function normalizeRequirementId(value) {
  const match = String(value || '')
    .trim()
    .match(/\b(FR|NFR|TR|IR)-0*(\d+)\b/i);
  return match ? `${match[1].toUpperCase()}-${Number.parseInt(match[2], 10)}` : null;
}

function normalizeSurfaceKey(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/[\s_/-]+/g, '')
    .toLowerCase();
  for (const surface of SURFACE_CATALOG) {
    const surfaceKey = surface.key.replace(/[\s_/-]+/g, '').toLowerCase();
    const labelKey = surface.label.replace(/[\s_/-]+/g, '').toLowerCase();
    if (normalized === surfaceKey || normalized === labelKey) return surface.key;
  }
  if (['audit', 'auditlog', 'activitylog'].includes(normalized)) return 'auditLog';
  if (['importexport', 'exports', 'imports'].includes(normalized)) return 'importExport';
  if (['flags', 'featureflag', 'featureflags'].includes(normalized)) return 'featureFlags';
  if (['support', 'ops', 'supportops'].includes(normalized)) return 'supportOps';
  return '';
}

function normalizeStatus(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (['impact', 'impacted', 'impacts', 'covered', 'planned', 'required', 'yes'].includes(normalized)) return 'impacts';
  if (['not_applicable', 'notapplicable', 'n/a', 'na', 'none', 'no'].includes(normalized)) return 'not_applicable';
  if (['verify_no_change', 'verify-no-change', 'no_change', 'unchanged'].includes(normalized))
    return 'verify_no_change';
  if (['deferred', 'blocked'].includes(normalized)) return normalized;
  return normalized || 'impacts';
}

function statusNeedsReason(status) {
  return REASON_REQUIRED_STATUSES.has(String(status || ''));
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value
      .split(/[,;\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function flattenText(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((entry) => flattenText(entry, depth + 1)).join('\n');
  if (typeof value === 'object')
    return Object.values(value)
      .map((entry) => flattenText(entry, depth + 1))
      .join('\n');
  return '';
}

function loadFeatureRegistry(planningDir) {
  const registryPath = path.join(planningDir, 'feature-registry.json');
  const registry = readJson(registryPath);
  if (!registry) {
    return {
      registryPath,
      registry: null,
      features: [],
      issues: ['feature-registry.json is missing or invalid JSON'],
    };
  }
  const features = Array.isArray(registry)
    ? registry
    : Array.isArray(registry.features)
      ? registry.features
      : Array.isArray(registry.featureRegistry)
        ? registry.featureRegistry
        : [];
  return {
    registryPath,
    registry,
    features,
    issues: features.length > 0 ? [] : ['feature-registry.json has no features array'],
  };
}

function loadDossier(planningDir, featureId) {
  const candidates = [
    path.join(planningDir, 'feature-dossiers', `${featureId}.md`),
    path.join(planningDir, 'feature-dossiers', `${featureId.toLowerCase()}.md`),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    return {
      path: candidate,
      relativePath: path.relative(planningDir, candidate).replaceAll('\\', '/'),
      content: readText(candidate),
    };
  }
  return {
    path: candidates[0],
    relativePath: candidates[0] ? path.relative(planningDir, candidates[0]).replaceAll('\\', '/') : '',
    content: '',
  };
}

function extractExplicitSurfaceImpacts(feature) {
  const sources = [
    feature.surfaces,
    feature.adjacentSurfaces,
    feature.surfaceImpacts,
    feature.capabilitySurfaces,
    feature.interactions,
    feature.coverage?.adjacentSurfaces,
    feature.coverage?.surfaceImpacts,
  ].filter(Boolean);
  const impacts = new Map();

  function addImpact(rawKey, rawValue, source) {
    const key = normalizeSurfaceKey(rawKey);
    if (!key) return;
    const isObjectValue = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue);
    const value = isObjectValue ? rawValue : {};
    if (impacts.has(key)) {
      const existing = impacts.get(key);
      if (!existing.reason && (value.reason || value.rationale)) existing.reason = value.reason || value.rationale;
      if (!existing.details && (value.details || value.summary)) existing.details = value.details || value.summary;
      return;
    }
    impacts.set(key, {
      surface: key,
      status: normalizeStatus(value.status || value.impact || rawValue),
      reason: value.reason || value.rationale || '',
      details: value.details || value.summary || (!isObjectValue && typeof rawValue === 'string' ? rawValue : ''),
      evidenceLevel: value.evidenceLevel || value.level || 'STATED',
      source,
      confidence: value.confidence || 'high',
    });
  }

  for (const sourceValue of sources) {
    if (Array.isArray(sourceValue)) {
      for (const entry of sourceValue) {
        if (typeof entry === 'string') addImpact(entry, { status: 'impacts', details: entry }, 'feature-registry');
        else addImpact(entry.surface || entry.key || entry.name || entry.id, entry, 'feature-registry');
      }
    } else if (typeof sourceValue === 'object') {
      for (const [key, value] of Object.entries(sourceValue)) addImpact(key, value, 'feature-registry');
    } else if (typeof sourceValue === 'string') {
      for (const key of asArray(sourceValue))
        addImpact(key, { status: 'impacts', details: sourceValue }, 'feature-registry');
    }
  }

  return impacts;
}

function collectCoverageEvidence(feature) {
  const evidence = [];
  const coverage = feature.coverage && typeof feature.coverage === 'object' ? feature.coverage : {};
  for (const [coverageKey, surfaceKeys] of Object.entries(COVERAGE_SURFACE_MAP)) {
    const cell = coverage[coverageKey];
    if (!cell) continue;
    const status = normalizeStatus(cell.status || cell.coverage || 'impacts');
    if (status === 'not_applicable') continue;
    for (const surface of surfaceKeys) {
      evidence.push({
        surface,
        source: `feature-registry.coverage.${coverageKey}`,
        confidence: 'medium',
        details: cell.details || cell.summary || flattenText(cell),
      });
    }
  }
  return evidence;
}

// v0.52 — clamp excerpt to whole-identifier boundaries so we never emit a
// partial FR-## token. Plan-review's B1 numbering-drift detector treats
// FR-1 as a distinct identifier from FR-12, so a mid-truncation creates
// hundreds of phantom findings per run on a packet with FR-100+ ids.
function clampExcerptAtIdentifier(text, limit) {
  const collapsed = String(text || '').replace(/\s+/g, ' ');
  if (collapsed.length <= limit) return collapsed;
  const head = collapsed.slice(0, limit);
  const trailingIdentifier = /[A-Z]+-\d+$/i.exec(head);
  if (!trailingIdentifier) return head;
  // Walk back to before the partial identifier so we never publish a truncated
  // FR/EPIC/M token. Keep at least 1 char so we always return a non-empty string.
  const cutAt = Math.max(1, trailingIdentifier.index);
  return head.slice(0, cutAt);
}

function matchSurfaceEvidence(surface, texts) {
  const matches = [];
  for (const source of texts) {
    if (!source.content) continue;
    if (!surface.patterns.some((pattern) => pattern.test(source.content))) continue;
    matches.push({
      source: source.source,
      confidence: source.confidence || 'medium',
      excerpt: clampExcerptAtIdentifier(source.content, 240),
    });
  }
  return matches;
}

function buildFeaturePattern(featureId, title) {
  const escaped = [featureId, title]
    .filter(Boolean)
    .map((value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escaped.join('|') || '$^', 'i');
}

function extractFeatureHeadingSection(content, featureId, title) {
  const text = String(content || '');
  if (!text.trim()) return '';
  const featurePattern = buildFeaturePattern(featureId, title);
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(lines[index]);
    if (!heading || !featurePattern.test(heading[2])) continue;

    const level = heading[1].length;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const nextHeading = /^(#{1,6})\s+/.exec(lines[cursor]);
      if (nextHeading && nextHeading[1].length <= level) {
        end = cursor;
        break;
      }
    }
    return lines.slice(index, end).join('\n').trim();
  }

  return '';
}

function extractFeatureRelevantText(content, featureId, title) {
  const text = String(content || '');
  if (!text.trim()) return '';

  const section = extractFeatureHeadingSection(text, featureId, title);
  if (section) return section;

  const featurePattern = buildFeaturePattern(featureId, title);
  const lines = text.split(/\r?\n/);
  const selected = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!featurePattern.test(lines[index])) continue;
    const start = Math.max(0, index - 1);
    const end = Math.min(lines.length, index + 2);
    selected.push(lines.slice(start, end).join('\n'));
  }
  return selected.join('\n').trim();
}

function collectFinalPlanningEvidence(planningDir, featureId, title) {
  const evidence = [];
  for (const artifact of FINAL_PLANNING_ARTIFACTS) {
    const artifactPath = path.join(planningDir, artifact);
    if (!fs.existsSync(artifactPath)) continue;
    const content = readText(artifactPath);
    const relevantContent = extractFeatureRelevantText(content, featureId, title);
    if (relevantContent) {
      evidence.push({
        source: artifact,
        confidence: 'medium',
        content: relevantContent,
      });
    }
  }
  return evidence;
}

function buildFeatureImpact(planningDir, feature) {
  const featureId = normalizeFeatureId(feature.featureId || feature.id);
  const title = String(feature.title || feature.name || '').trim();
  const explicitImpacts = extractExplicitSurfaceImpacts(feature);
  const dossier = loadDossier(planningDir, featureId);
  const blueprintContent = extractFeatureRelevantText(
    readText(path.join(planningDir, 'feature-service-blueprints.md')),
    featureId,
    title,
  );
  const featureText = flattenText(feature);
  const texts = [
    { source: 'feature-registry.json', confidence: 'high', content: featureText },
    { source: dossier.relativePath || 'feature-dossier', confidence: 'medium', content: dossier.content },
    { source: 'feature-service-blueprints.md', confidence: 'medium', content: blueprintContent },
    ...collectFinalPlanningEvidence(planningDir, featureId, title),
  ];

  const coverageEvidence = collectCoverageEvidence(feature);
  const surfaceImpacts = {};
  const edges = [];
  const warnings = [];
  const evidenceSurfaceKeys = new Set();
  const declaredSurfaceKeys = new Set(explicitImpacts.keys());
  const missingSurfaceDeclarations = [];
  const missingSurfaceReasons = [];
  const invalidSurfaceStatuses = [];

  for (const surface of SURFACE_CATALOG) {
    const explicit = explicitImpacts.get(surface.key);
    const declared = Boolean(explicit);
    const coverageMatches = coverageEvidence.filter((entry) => entry.surface === surface.key);
    const textMatches = matchSurfaceEvidence(surface, texts);
    const evidence = [
      ...(explicit
        ? [
            {
              source: explicit.source,
              confidence: explicit.confidence || 'high',
              details: explicit.details || explicit.reason || '',
            },
          ]
        : []),
      ...coverageMatches,
      ...textMatches,
    ];

    let status = 'not_applicable';
    let reason = `No planning evidence found for ${surface.label}.`;
    let explicitReason = '';
    if (explicit) {
      status = explicit.status;
      explicitReason = String(explicit.reason || explicit.details || '').trim();
      reason = explicitReason || `${surface.label} impact declared in feature-registry.json.`;
    } else if (evidence.length > 0) {
      status = 'impacts';
      reason = `${surface.label} impact inferred from planning evidence.`;
    }

    if (evidence.length > 0) evidenceSurfaceKeys.add(surface.key);
    if (!declared) missingSurfaceDeclarations.push(surface.key);
    if (!ALLOWED_SURFACE_STATUSES.has(status)) invalidSurfaceStatuses.push(`${surface.key}:${status}`);
    if (declared && statusNeedsReason(status) && !explicitReason) missingSurfaceReasons.push(surface.key);

    surfaceImpacts[surface.key] = {
      status,
      label: surface.label,
      reason,
      declared,
      inferred: !declared && evidence.length > 0,
      declarationSource: explicit?.source || '',
      evidence: evidence.map((entry) => ({
        source: entry.source,
        confidence: entry.confidence || 'medium',
        details: entry.details || entry.excerpt || '',
      })),
      requiredProof: status === 'impacts' || status === 'verify_no_change' ? surface.requiredProof : [],
    };

    if (status === 'blocked' || status === 'deferred')
      warnings.push(`${featureId} ${surface.label} impact is ${status}`);

    if (status === 'impacts' || status === 'verify_no_change') {
      edges.push({
        id: `${featureId || 'FEATURE'}->${surface.key}`,
        from: `feature:${featureId || title || 'unknown'}`,
        to: `surface:${surface.key}`,
        type: surface.edgeType,
        status,
        confidence: explicit?.confidence || (evidence.length > 1 ? 'high' : 'medium'),
        evidence: surfaceImpacts[surface.key].evidence,
        requiredProof: surfaceImpacts[surface.key].requiredProof,
      });
    }
  }

  return {
    featureId,
    title,
    sourceIds: [
      ...asArray(feature.sourceIds),
      ...asArray(feature.sourceIDs),
      ...asArray(feature.requirementIds),
      ...asArray(feature.frIds),
    ],
    declaredSurfaceCount: declaredSurfaceKeys.size,
    evidenceSurfaceCount: evidenceSurfaceKeys.size,
    missingSurfaceDeclarations,
    missingSurfaceReasons,
    invalidSurfaceStatuses,
    actionableSurfaceCount:
      edges.length +
      Object.values(surfaceImpacts).filter((impact) => ['deferred', 'blocked'].includes(impact.status)).length,
    surfaceImpacts,
    warnings,
    edges,
  };
}

function buildSurfaceImpactMatrix(graph) {
  const lines = [
    '# Surface Impact Matrix',
    '',
    `Generated: ${graph.generatedAt}`,
    '',
    'Every feature must explicitly impact, verify no change, defer, block, or mark not applicable for each adjacent product surface.',
    '',
    '| Feature | Surface | Declaration | Status | Reason | Required Proof |',
    '| --- | --- | --- | --- | --- | --- |',
  ];

  for (const feature of graph.features) {
    for (const surface of SURFACE_CATALOG) {
      const impact = feature.surfaceImpacts[surface.key] || {};
      const declaration = impact.declared ? 'explicit' : impact.inferred ? 'inferred' : 'missing';
      lines.push(
        `| ${feature.featureId || '(unknown)'} ${feature.title || ''} | ${surface.label} | ${declaration} | ${impact.status || 'missing'} | ${String(impact.reason || '').replace(/\|/g, '/')} | ${(impact.requiredProof || []).join('; ') || 'N/A'} |`,
      );
    }
  }

  if (graph.features.length === 0)
    lines.push('| None | None | missing | missing | feature-registry.json has no features | N/A |');
  return `${lines.join('\n')}\n`;
}

function generateCapabilityGraph(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const planningDir = resolvePlanningDir(projectRoot, options.planningDir);
  const generatedAt = new Date().toISOString();
  const registryLoad = loadFeatureRegistry(planningDir);
  const issues = [...registryLoad.issues];
  const warnings = [];
  const features = registryLoad.features.map((feature) => {
    const impact = buildFeatureImpact(planningDir, feature);
    if (!impact.featureId) issues.push(`Feature "${impact.title || '(untitled)'}" is missing a FEAT-NNN id`);
    if (!impact.title) issues.push(`${impact.featureId || 'Feature'} is missing a title`);
    warnings.push(...impact.warnings);
    return impact;
  });

  const nodes = [
    ...features.map((feature) => ({
      id: `feature:${feature.featureId}`,
      type: 'feature',
      label: feature.title || feature.featureId,
      featureId: feature.featureId,
    })),
    ...SURFACE_CATALOG.map((surface) => ({
      id: `surface:${surface.key}`,
      type: 'surface',
      label: surface.label,
      surface: surface.key,
    })),
  ];
  const edges = features.flatMap((feature) => feature.edges);
  const graph = {
    version: '1.0.0',
    generatedAt,
    planningDir,
    standardsContract: [
      'Dependency mapping for upstream/downstream product surfaces',
      'Journey mapping and service blueprint adjacency',
      'C4 and contract-first architecture relationships',
      'Observable build proof for feature-to-surface edges',
    ],
    surfaceCatalog: SURFACE_CATALOG.map(({ key, label, edgeType, requiredProof }) => ({
      key,
      label,
      edgeType,
      requiredProof,
    })),
    nodes,
    edges,
    features: features.map(({ edges: _edges, warnings: _warnings, ...feature }) => feature),
    summary: {
      totalFeatures: features.length,
      totalSurfaces: SURFACE_CATALOG.length,
      impactedEdges: edges.length,
      notApplicableSurfaces: features.reduce(
        (sum, feature) =>
          sum + Object.values(feature.surfaceImpacts).filter((impact) => impact.status === 'not_applicable').length,
        0,
      ),
    },
    issues,
    warnings,
  };

  const graphPath = path.join(planningDir, 'capability-graph.json');
  const matrixPath = path.join(planningDir, 'surface-impact-matrix.md');
  if (options.write !== false) {
    writeJson(graphPath, graph);
    fs.mkdirSync(path.dirname(matrixPath), { recursive: true });
    fs.writeFileSync(matrixPath, buildSurfaceImpactMatrix(graph), 'utf8');
  }

  return {
    graph,
    artifacts: {
      capabilityGraph: path.relative(projectRoot, graphPath).replaceAll('\\', '/'),
      surfaceImpactMatrix: path.relative(projectRoot, matrixPath).replaceAll('\\', '/'),
    },
  };
}

function collectMilestoneFeatureIds(projectRoot, planningDir, milestone) {
  const normalizedMilestone = normalizeMilestoneId(milestone);
  if (!normalizedMilestone) return new Set();
  const tracker = safeReadJson(path.join(planningDir, 'story-tracker.json'));
  const featureIds = new Set();
  const requirementIds = new Set();
  for (const story of Array.isArray(tracker?.stories) ? tracker.stories : []) {
    const storyMilestone = normalizeMilestoneId(story.milestone || story.milestoneId);
    if (storyMilestone !== normalizedMilestone) continue;
    for (const id of [
      ...asArray(story.featureIds),
      ...asArray(story.featureId),
      ...asArray(story.features),
      ...asArray(story.requirementIds),
    ]) {
      const normalized = normalizeFeatureId(id);
      if (normalized) featureIds.add(normalized);
    }
    for (const id of [
      ...asArray(story.requirementIds),
      ...asArray(story.frIds),
      ...asArray(story.sourceIds),
      ...asArray(story.sourceIDs),
    ]) {
      const normalized = normalizeRequirementId(id);
      if (normalized) requirementIds.add(normalized);
    }
  }

  const buildDir = path.join(projectRoot, '_cobolt-output', 'latest', 'build', normalizedMilestone);
  const taskManifest = safeReadJson(path.join(buildDir, `${normalizedMilestone}-task-manifest.json`));
  const tasks = Array.isArray(taskManifest?.tasks) ? taskManifest.tasks : [];
  for (const task of tasks) {
    const taskMilestone = normalizeMilestoneId(task.milestone || task.milestoneId || normalizedMilestone);
    if (taskMilestone !== normalizedMilestone) continue;
    for (const id of [
      ...asArray(task.featureIds),
      ...asArray(task.featureId),
      ...asArray(task.features),
      ...asArray(task.capabilityFeatureIds),
    ]) {
      const normalized = normalizeFeatureId(id);
      if (normalized) featureIds.add(normalized);
    }
    for (const edge of asArray(task.capabilityEdges)) {
      const normalized = normalizeFeatureId(edge?.featureId || edge?.feature || edge?.from || edge?.id);
      if (normalized) featureIds.add(normalized);
    }
    for (const id of [
      ...asArray(task.requirementIds),
      ...asArray(task.frIds),
      ...asArray(task.sourceIds),
      ...asArray(task.sourceIDs),
    ]) {
      const normalized = normalizeRequirementId(id);
      if (normalized) requirementIds.add(normalized);
    }
  }
  for (const edge of asArray(taskManifest?.capabilityEdges)) {
    const normalized = normalizeFeatureId(edge?.featureId || edge?.feature || edge?.from || edge?.id);
    if (normalized) featureIds.add(normalized);
  }

  const registryLoad = loadFeatureRegistry(planningDir);
  for (const feature of registryLoad.features) {
    const featureId = normalizeFeatureId(feature.featureId || feature.id);
    if (!featureId) continue;
    const linkedRequirements = [
      ...asArray(feature.sourceIds),
      ...asArray(feature.sourceIDs),
      ...asArray(feature.requirementIds),
      ...asArray(feature.frIds),
    ]
      .map(normalizeRequirementId)
      .filter(Boolean);
    if (linkedRequirements.some((id) => requirementIds.has(id))) featureIds.add(featureId);
  }

  return featureIds;
}

function isTestEvidenceFile(filePath) {
  const normalized = String(filePath || '')
    .replaceAll('\\', '/')
    .toLowerCase();
  const basename = normalized.split('/').pop() || normalized;
  return (
    /(^|\/)(tests?|__tests__|e2e|acceptance)\//i.test(normalized) ||
    /(^|[\\/])[^\\/]*(test|spec|e2e|acceptance)[^\\/]*\./i.test(filePath) ||
    /\.(test|spec)\.[^.]+$/i.test(basename)
  );
}

function collectBuildProofText(projectRoot, milestone, options = {}) {
  const normalizedMilestone = normalizeMilestoneId(milestone);
  if (!normalizedMilestone) return { available: false, records: [], files: [], structuredProofs: [] };
  const buildDir = path.join(projectRoot, '_cobolt-output', 'latest', 'build', normalizedMilestone);
  const artifacts = safeReadJson(path.join(buildDir, `${normalizedMilestone}-build-artifacts.json`));
  const files = new Set();
  for (const value of [
    ...(artifacts?.filesCreated || []),
    ...(artifacts?.filesModified || []),
    ...(artifacts?.sourceWriteProvenance || []),
    ...(artifacts?.testFiles || []),
    ...(artifacts?.tests || []),
  ]) {
    if (typeof value === 'string') files.add(value);
    else if (value?.path) files.add(value.path);
    else if (value?.file) files.add(value.file);
  }

  const structuredProofs = [
    ...(Array.isArray(artifacts?.capabilityProofs) ? artifacts.capabilityProofs : []),
    ...(Array.isArray(artifacts?.surfaceProofs) ? artifacts.surfaceProofs : []),
    ...(Array.isArray(artifacts?.edgeProofs) ? artifacts.edgeProofs : []),
  ].filter(() => options.includeStructuredProofs !== false);
  const records = [];
  const checkedFiles = [];
  for (const file of files) {
    const absolute = path.isAbsolute(file) ? file : path.join(projectRoot, file);
    if (!fs.existsSync(absolute) || fs.statSync(absolute).isDirectory()) continue;
    const content = readText(absolute);
    records.push({
      file: file.replaceAll('\\', '/'),
      content,
      evidenceKind: isTestEvidenceFile(file) ? 'test' : 'implementation',
    });
    checkedFiles.push(file.replaceAll('\\', '/'));
  }

  return {
    available:
      fs.existsSync(path.join(buildDir, `${normalizedMilestone}-build-artifacts.json`)) &&
      (records.length > 0 || structuredProofs.length > 0),
    records,
    files: [...new Set(checkedFiles)].sort(),
    structuredProofs,
  };
}

function normalizeEvidenceFiles(value) {
  return [
    ...asArray(value?.evidenceFiles),
    ...asArray(value?.evidenceFile),
    ...asArray(value?.file),
    ...asArray(value?.path),
  ]
    .map((file) => String(file).replaceAll('\\', '/'))
    .filter(Boolean);
}

function structuredProofMatches(edge, feature, buildProof) {
  const featureId = feature.featureId;
  const surfaceKey = String(edge.to || '').replace(/^surface:/, '');
  const positiveStatuses = new Set([
    'impacts',
    'verify_no_change',
    'covered',
    'pass',
    'passed',
    'proven',
    'ok',
    'complete',
    'tested',
  ]);
  const positiveEvidenceTypes = new Set(['test', 'regression', 'explicit_non_impact', 'contract', 'integration']);
  const knownFiles = new Set((buildProof.files || []).map((file) => String(file).replaceAll('\\', '/')));
  return (buildProof.structuredProofs || []).some((proof) => {
    if (!proof || typeof proof !== 'object') return false;
    const proofFeatureId = normalizeFeatureId(proof.featureId || proof.feature || proof.from || proof.id);
    const proofSurface = normalizeSurfaceKey(proof.surface || proof.surfaceKey || proof.to || proof.name);
    const status = normalizeStatus(proof.status || proof.result || proof.verdict || 'passed');
    if (proofFeatureId !== featureId || proofSurface !== surfaceKey || !positiveStatuses.has(status)) return false;

    const verifier = String(proof.verifiedBy || proof.verifier || '').toLowerCase();
    if (verifier === 'cobolt-capability-graph' || verifier === 'cobolt-capability-graph.js') return true;

    const evidenceFiles = normalizeEvidenceFiles(proof);
    const hasKnownEvidenceFile = evidenceFiles.some((file) => knownFiles.has(file));
    const evidenceType = String(proof.evidenceType || proof.kind || '').toLowerCase();
    return hasKnownEvidenceFile && positiveEvidenceTypes.has(evidenceType);
  });
}

function findEdgeProof(edge, feature, buildProof) {
  if (structuredProofMatches(edge, feature, buildProof)) {
    return {
      proven: true,
      evidenceType: 'structured',
      evidenceFiles: normalizeEvidenceFiles(
        (buildProof.structuredProofs || []).find(
          (proof) =>
            normalizeFeatureId(proof?.featureId || proof?.feature || proof?.from || proof?.id) === feature.featureId &&
            normalizeSurfaceKey(proof?.surface || proof?.surfaceKey || proof?.to || proof?.name) ===
              String(edge.to || '').replace(/^surface:/, ''),
        ) || {},
      ),
    };
  }
  const featureNeedles = [feature.featureId, feature.title].filter(Boolean).map((value) => String(value).toLowerCase());
  const surface = SURFACE_BY_KEY.get(String(edge.to || '').replace(/^surface:/, ''));
  const surfaceTerms = [surface?.key, surface?.label, ...(surface?.proofTerms || [])]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
  const evidenceRecords = (buildProof.records || []).filter((record) => {
    const haystack = String(record.content || '').toLowerCase();
    if (!haystack.trim()) return false;
    const featureMentioned = featureNeedles.some((needle) => needle.length > 3 && haystack.includes(needle));
    const surfaceMentioned = surfaceTerms.some((term) => term.length > 1 && haystack.includes(term));
    return featureMentioned && surfaceMentioned && record.evidenceKind === 'test';
  });
  return {
    proven: evidenceRecords.length > 0,
    evidenceType: evidenceRecords.length > 0 ? 'test' : null,
    evidenceFiles: evidenceRecords.map((record) => record.file),
  };
}

function deriveCapabilityProofs(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const planningDir = resolvePlanningDir(projectRoot, options.planningDir);
  const milestone = normalizeMilestoneId(options.milestone);
  const { graph } = generateCapabilityGraph({ projectRoot, planningDir, write: options.writeGraph !== false });
  const milestoneFeatureIds = collectMilestoneFeatureIds(projectRoot, planningDir, milestone);
  const buildProof = collectBuildProofText(projectRoot, milestone, { includeStructuredProofs: false });
  const featureById = new Map(graph.features.map((feature) => [feature.featureId, feature]));
  const edges = graph.edges.filter((edge) => {
    const featureId = String(edge.from || '').replace(/^feature:/, '');
    return milestoneFeatureIds.size === 0 || milestoneFeatureIds.has(featureId);
  });

  return edges.map((edge) => {
    const featureId = String(edge.from || '').replace(/^feature:/, '');
    const surface = String(edge.to || '').replace(/^surface:/, '');
    const feature = featureById.get(featureId) || { featureId };
    const proof = findEdgeProof(edge, feature, buildProof);
    return {
      edgeId: edge.id,
      featureId,
      surface,
      status: proof.proven ? 'proven' : 'missing',
      evidenceType: proof.evidenceType || 'missing',
      evidenceFiles: proof.evidenceFiles || [],
      requiredProof: edge.requiredProof || [],
      verifiedBy: 'cobolt-capability-graph',
      verifiedAt: new Date().toISOString(),
      summary: proof.proven
        ? `${featureId} -> ${surface} has test or structured regression evidence.`
        : `${featureId} -> ${surface} is missing build proof.`,
    };
  });
}

function checkCapabilityGraph(options = {}) {
  const stage = ['intake', 'final', 'build'].includes(options.stage) ? options.stage : 'final';
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const planningDir = resolvePlanningDir(projectRoot, options.planningDir);
  const { graph, artifacts } = generateCapabilityGraph({ projectRoot, planningDir, write: options.write !== false });
  const issues = [...graph.issues];
  const warnings = [...graph.warnings];
  const proof = {
    stage,
    milestone: normalizeMilestoneId(options.milestone) || null,
    available: false,
    files: [],
    checkedEdges: 0,
    provenEdges: 0,
    missingEdges: [],
  };

  if (stage === 'intake' || stage === 'final') {
    for (const feature of graph.features) {
      if (Number(feature.actionableSurfaceCount || 0) === 0) {
        issues.push(
          `Capability graph has no actionable surface edges for ${feature.featureId || feature.title || 'unknown feature'}.`,
        );
      }
      if (Number(feature.declaredSurfaceCount || 0) === 0) {
        issues.push(
          `Capability graph has no declared adjacent surfaces for ${feature.featureId || feature.title || 'unknown feature'}.`,
        );
      }
      for (const surfaceKey of feature.missingSurfaceDeclarations || []) {
        const surface = SURFACE_BY_KEY.get(surfaceKey);
        issues.push(
          `${feature.featureId || feature.title || 'Feature'} is missing explicit surface declaration for ${surface?.label || surfaceKey}. Declare impacts, verify_no_change, deferred, blocked, or not_applicable with a reason.`,
        );
      }
      for (const surfaceKey of feature.missingSurfaceReasons || []) {
        const surface = SURFACE_BY_KEY.get(surfaceKey);
        const impact = feature.surfaceImpacts?.[surfaceKey] || {};
        issues.push(
          `${feature.featureId || feature.title || 'Feature'} declares ${surface?.label || surfaceKey} as ${impact.status || 'unknown'} without an explicit reason.`,
        );
      }
      for (const invalidStatus of feature.invalidSurfaceStatuses || []) {
        issues.push(`${feature.featureId || feature.title || 'Feature'} has invalid surface status ${invalidStatus}.`);
      }
    }
  }

  if (stage === 'final') {
    for (const edge of graph.edges) {
      if (!Array.isArray(edge.evidence) || edge.evidence.length === 0) {
        issues.push(`Capability edge ${edge.id} has no planning evidence.`);
      }
      if (!Array.isArray(edge.requiredProof) || edge.requiredProof.length === 0) {
        issues.push(`Capability edge ${edge.id} has no required proof contract.`);
      }
    }
  }

  if (stage === 'build') {
    const milestoneFeatureIds = collectMilestoneFeatureIds(projectRoot, planningDir, options.milestone);
    const buildProof = collectBuildProofText(projectRoot, options.milestone);
    proof.available = buildProof.available;
    proof.files = buildProof.files;
    if (!buildProof.available) {
      issues.push('Build proof artifacts are not available for capability edge validation.');
    } else {
      const featureById = new Map(graph.features.map((feature) => [feature.featureId, feature]));
      const edges = graph.edges.filter((edge) => {
        const featureId = String(edge.from || '').replace(/^feature:/, '');
        return milestoneFeatureIds.size === 0 || milestoneFeatureIds.has(featureId);
      });
      proof.checkedEdges = edges.length;
      for (const edge of edges) {
        const featureId = String(edge.from || '').replace(/^feature:/, '');
        const feature = featureById.get(featureId) || { featureId };
        const edgeProof = findEdgeProof(edge, feature, buildProof);
        if (edgeProof.proven) {
          proof.provenEdges += 1;
          continue;
        }
        const missing = {
          edgeId: edge.id,
          featureId,
          surface: String(edge.to || '').replace(/^surface:/, ''),
          requiredProof: edge.requiredProof || [],
        };
        proof.missingEdges.push(missing);
        issues.push(
          `Missing build proof for ${featureId} -> ${missing.surface}: ${(edge.requiredProof || []).join('; ')}`,
        );
      }
    }
  }

  const reportPath = path.join(planningDir, 'capability-edge-proof-report.json');
  const result = {
    generatedAt: new Date().toISOString(),
    stage,
    passed: issues.length === 0,
    planningDir,
    summary: graph.summary,
    artifacts: {
      ...artifacts,
      capabilityEdgeProofReport: path.relative(projectRoot, reportPath).replaceAll('\\', '/'),
    },
    issues,
    warnings,
    proof,
  };
  if (options.write !== false) writeJson(reportPath, result);
  return { result, graph, exitCode: result.passed ? 0 : 1 };
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--out') options.out = args[++index];
    else if (arg === '--stage') options.stage = args[++index];
    else if (arg === '--planning-dir') options.planningDir = args[++index];
    else if (arg === '--milestone') options.milestone = args[++index];
  }
  return options;
}

function printUsage() {
  process.stdout.write(`
CoBolt Capability Graph - feature-to-surface dependency and proof gate

Usage:
  node tools/cobolt-capability-graph.js generate [--planning-dir <dir>] [--json] [--out <file>]
  node tools/cobolt-capability-graph.js check [--stage intake|final|build] [--milestone M1] [--json] [--out <file>]

Outputs:
  _cobolt-output/latest/planning/capability-graph.json
  _cobolt-output/latest/planning/surface-impact-matrix.md
  _cobolt-output/latest/planning/capability-edge-proof-report.json

Exit codes:
  0  Capability graph check passed
  1  Capability graph check failed
  2  Usage error
`);
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const options = parseOptions(args.slice(1));

  if (command === 'generate') {
    const { graph, artifacts } = generateCapabilityGraph(options);
    if (options.json || options.out) {
      emitJson({ passed: graph.issues.length === 0, artifacts, graph }, options.out);
    } else {
      process.stdout.write('[capability-graph] Generated product capability graph\n');
      process.stdout.write(`  Features: ${graph.summary.totalFeatures}\n`);
      process.stdout.write(`  Edges: ${graph.summary.impactedEdges}\n`);
      process.stdout.write(`  Graph: ${artifacts.capabilityGraph}\n`);
      process.stdout.write(`  Matrix: ${artifacts.surfaceImpactMatrix}\n`);
    }
    process.exit(graph.issues.length === 0 ? 0 : 1);
  }

  if (command === 'check') {
    const { result, exitCode } = checkCapabilityGraph(options);
    if (options.json || options.out) emitJson(result, options.out);
    else {
      process.stdout.write('[capability-graph] Product Capability Graph Check\n');
      process.stdout.write(`  Stage: ${result.stage}\n`);
      process.stdout.write(`  Features: ${result.summary.totalFeatures}\n`);
      process.stdout.write(`  Edges: ${result.summary.impactedEdges}\n`);
      process.stdout.write(`  Result: ${result.passed ? 'PASS' : 'FAIL'}\n`);
      for (const issue of result.issues.slice(0, 8)) process.stdout.write(`  Issue: ${issue}\n`);
      for (const warning of result.warnings.slice(0, 5)) process.stdout.write(`  Warning: ${warning}\n`);
      process.stdout.write(`  Report: ${result.artifacts.capabilityEdgeProofReport}\n`);
    }
    process.exit(exitCode);
  }

  if (command === '--help' || command === '-h' || !command) {
    printUsage();
    process.exit(0);
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  printUsage();
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  SURFACE_CATALOG,
  checkCapabilityGraph,
  clampExcerptAtIdentifier,
  deriveCapabilityProofs,
  generateCapabilityGraph,
  loadFeatureRegistry,
  normalizeSurfaceKey,
};
