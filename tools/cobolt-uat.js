#!/usr/bin/env node

// CoBolt UAT - deterministic user acceptance planning, evidence, and verdicts.

const fs = require('node:fs');
const path = require('node:path');

const { paths: _paths } = (() => {
  try {
    return require('../lib/cobolt-paths');
  } catch {
    return { paths: null };
  }
})();

const uiDetection = (() => {
  try {
    return require('./cobolt-ui-detection');
  } catch {
    return null;
  }
})();

const playwrightModule = (() => {
  try {
    return require('./cobolt-playwright');
  } catch {
    return null;
  }
})();

const VERSION = '1.0.0';
const DEFAULT_MILESTONE = 'M1';
const DEFAULT_MAX_ITERATIONS = 5;
const DEFAULT_ESCALATE_AFTER = 3;

const SURFACE_AGENT_MAP = {
  'web-ui': ['uat-agent', 'ux-reviewer', 'ui-design-reviewer', 'frontend-fix', 'accessibility-reviewer'],
  'native-ui': ['uat-agent', 'ux-reviewer', 'ui-design-reviewer', 'frontend-fix', 'accessibility-reviewer'],
  api: ['api-contract-reviewer', 'integration-test-agent', 'backend-fix'],
  cli: ['test-writer', 'integration-test-agent', 'backend-fix'],
  library: ['test-writer', 'integration-test-agent'],
  data: ['db-test-agent', 'integration-test-agent', 'backend-fix'],
  infrastructure: ['ops-readiness-reviewer', 'integration-test-agent', 'backend-fix'],
  'code-workflow': ['test-writer', 'integration-test-agent'],
};

const SURFACE_EVIDENCE = {
  'web-ui': [
    'playwright-smoke',
    'playwright-screenshots',
    'playwright-a11y',
    'playwright-sync',
    'chrome-devtools-mcp-status',
  ],
  'native-ui': ['desktop-ui-automation', 'accessibility-automation', 'keyboard-flow', 'screenshot-or-visual-state'],
  api: ['http-health', 'request-response-schema', 'auth-error-cases'],
  cli: ['command-exit-code', 'stdout-stderr', 'state-check'],
  library: ['consumer-example', 'public-api-assertions'],
  data: ['input-fixture', 'output-validation', 'data-quality-check'],
  infrastructure: ['health-readiness', 'rollback-trigger-decision'],
  'code-workflow': ['test-execution-log'],
};

const PERSONA_KEYWORDS = [
  ['admin', 'Admin user', 'human', 'primary'],
  ['administrator', 'Administrator', 'human', 'primary'],
  ['owner', 'Project owner', 'human', 'primary'],
  ['developer', 'Developer', 'human', 'primary'],
  ['operator', 'Operator', 'human', 'primary'],
  ['reviewer', 'Reviewer', 'human', 'secondary'],
  ['auditor', 'Auditor', 'human', 'secondary'],
  ['viewer', 'Viewer', 'human', 'secondary'],
  ['support', 'Support user', 'human', 'secondary'],
  ['guest', 'Guest visitor', 'human', 'restricted'],
  ['unauthenticated', 'Unauthenticated visitor', 'human', 'restricted'],
  ['api client', 'API client', 'external-system', 'primary'],
  ['webhook', 'Webhook sender', 'external-system', 'secondary'],
  ['scheduler', 'Scheduler', 'external-system', 'secondary'],
];

const FUNCTIONAL_ACTION_PATTERNS = [
  ['create', /\b(create|add|new|invite|register)\b/i],
  ['edit', /\b(edit|update|modify|change|save)\b/i],
  ['delete', /\b(delete|remove|archive|deactivate)\b/i],
  ['submit', /\b(submit|send|complete|approve|reject|publish)\b/i],
  ['search', /\b(search|filter|sort|find)\b/i],
  ['export', /\b(export|download|import|upload)\b/i],
  ['configure', /\b(configure|enable|disable|set up|setup)\b/i],
  ['run', /\b(run|trigger|execute|retry|deploy|rollback|start|stop)\b/i],
  [
    'verify-data-display',
    /\b(see|view|display|show|inspect)\b.*\b(health|status|metrics?|reports?|records?|results?|details?|data|table|list)\b/i,
  ],
];

const NAVIGATION_ONLY_PATTERN = /\b(open|navigate|visit|browse|walk|sidebar|menu|link|route)\b/i;

function readJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function readText(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

function slug(value) {
  return (
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  );
}

function requirementKey(value) {
  const raw = String(value || '')
    .trim()
    .toUpperCase();
  const match = raw.match(/^([A-Z]+)-0*(\d+)$/);
  if (match) return `${match[1]}-${Number(match[2])}`;
  return raw;
}

function unique(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function hasNativeDesktopFramework(ui, planningText = '') {
  const frameworks = (ui.frameworks || []).map((framework) => String(framework || '').toLowerCase());
  return (
    frameworks.some((framework) => /\b(wpf|winui|maui|avalonia|winforms|windows forms|xaml)\b/i.test(framework)) ||
    /\b(wpf|winui|maui|avalonia|winforms|windows forms|xaml)\b/i.test(planningText)
  );
}

function hasHttpApiSurface(projectDir, deps, planningDir, planningText = '') {
  const hasOpenApi =
    fs.existsSync(path.join(projectDir, 'openapi.json')) || fs.existsSync(path.join(projectDir, 'openapi.yaml'));
  const hasWebRuntime = Object.keys(deps).some((dep) =>
    ['express', 'fastify', 'koa', '@nestjs/core', 'graphql', 'hono', '@apollo/server'].includes(dep),
  );
  const apiContracts = readText(path.join(planningDir, 'api-contracts.md')).toLowerCase();
  const combinedText = `${planningText}\n${apiContracts}`;
  const noHttp =
    /no\s+http\s+(?:api|endpoints?)|no\s+cloud\s+api|no\s+server\s+api|no\s+network\s+api|no\s+remote\s+api|local\s+(?:commonjs|module)\s+export|internal\s+typed\s+(?:api\s+contracts?|[a-z#]+\s+interfaces?)/.test(
      combinedText,
    );
  const mentionsHttp = /\b(http|https|rest|graphql|webhook|endpoint|endpoints|route|routes|openapi|fastapi)\b/.test(
    combinedText,
  );
  return hasOpenApi || hasWebRuntime || (mentionsHttp && !noHttp);
}

function titleize(value) {
  return String(value || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function parseArgValue(args, name, fallback = null) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

function writeCliOutput(filePath, payload) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  fs.writeFileSync(path.resolve(filePath), `${body.replace(/\s*$/, '')}\n`, 'utf8');
}

function severityCounts(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings || []) counts[finding.severity || 'medium'] += 1;
  return counts;
}

class UatOrchestrator {
  constructor(projectDir = process.cwd()) {
    this.projectDir = path.resolve(projectDir);
    this._p = typeof _paths === 'function' ? _paths(this.projectDir) : null;
  }

  _hasPlanningArtifacts(runRoot) {
    const planningDir = path.join(runRoot, 'planning');
    try {
      return (
        fs.existsSync(planningDir) && fs.readdirSync(planningDir).some((entry) => /\.(md|json|ya?ml)$/i.test(entry))
      );
    } catch {
      return false;
    }
  }

  _runRoot() {
    if (!this._p) return path.join(this.projectDir, '_cobolt-output', 'latest');
    const latest = this._p.latest();
    if (latest && this._hasPlanningArtifacts(latest)) return latest;
    return this._p.currentRun();
  }

  _planningDir() {
    return path.join(this._runRoot(), 'planning');
  }

  _outputDir() {
    return this._ensureDir(path.join(this._runRoot(), 'uat'));
  }

  _reportsDir(milestone) {
    return this._ensureDir(path.join(this.projectDir, '_cobolt-output', 'reports', milestone || DEFAULT_MILESTONE));
  }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  _writeJson(filePath, payload) {
    this._ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return filePath;
  }

  _writeText(filePath, contents) {
    this._ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, contents, 'utf8');
    return filePath;
  }

  _artifactPath(milestone, name) {
    return path.join(this._outputDir(), `${milestone || DEFAULT_MILESTONE}-${name}`);
  }

  _evidenceDir(...parts) {
    return this._ensureDir(path.join(this._outputDir(), 'evidence', ...parts));
  }

  _planningTexts() {
    const files = [
      'prd.md',
      'feature-prd.md',
      'security-requirements.md',
      'ux-design-specification.md',
      'api-contracts.md',
      'implicit-requirements.md',
      'milestones.md',
      'test-strategy.md',
      'uat-strategy.md',
    ];
    return Object.fromEntries(files.map((file) => [file, readText(path.join(this._planningDir(), file))]));
  }

  _allPlanningText() {
    return Object.values(this._planningTexts()).join('\n');
  }

  _loadPackageJson() {
    return readJson(path.join(this.projectDir, 'package.json')) || {};
  }

  classify(options = {}) {
    const milestone = options.milestone || DEFAULT_MILESTONE;
    const ui = uiDetection?.detectUIProject ? uiDetection.detectUIProject(this.projectDir) : { hasUI: false };
    const packageJson = this._loadPackageJson();
    const deps = {
      ...(packageJson.dependencies || {}),
      ...(packageJson.devDependencies || {}),
      ...(packageJson.peerDependencies || {}),
    };
    const planningText = this._allPlanningText().toLowerCase();
    const surfaces = new Set();
    const signals = [];

    const nativeDesktop = ui.hasUI && hasNativeDesktopFramework(ui, planningText);
    if (ui.hasUI) {
      surfaces.add(nativeDesktop ? 'native-ui' : 'web-ui');
      signals.push(...(ui.signals || []).map((signal) => `ui:${signal}`));
      if (nativeDesktop) signals.push('native-desktop-ui');
    }

    if (hasHttpApiSurface(this.projectDir, deps, this._planningDir(), planningText)) {
      surfaces.add('api');
      signals.push('api-contract-or-runtime');
    }

    if (packageJson.bin || fs.existsSync(path.join(this.projectDir, 'cli', 'index.js'))) {
      surfaces.add('cli');
      signals.push('cli-entrypoint');
    }

    if (packageJson.main || packageJson.exports) {
      surfaces.add('library');
      signals.push('package-public-api');
    }

    if (
      fs.existsSync(path.join(this.projectDir, 'migrations')) ||
      fs.existsSync(path.join(this.projectDir, 'priv', 'repo', 'migrations')) ||
      fs.existsSync(path.join(this.projectDir, 'prisma', 'schema.prisma')) ||
      /database|migration|postgres|schema|data pipeline/.test(planningText)
    ) {
      surfaces.add('data');
      signals.push('data-store-or-migration');
    }

    if (
      fs.existsSync(path.join(this.projectDir, 'Dockerfile')) ||
      fs.existsSync(path.join(this.projectDir, 'docker-compose.yml'))
    ) {
      surfaces.add('infrastructure');
      signals.push('deployable-runtime');
    }

    if (surfaces.size === 0) {
      surfaces.add('code-workflow');
      signals.push('fallback-code-workflow');
    }

    const browserEngines = ui.browserEngines ||
      uiDetection?.detectBrowserEngines?.(this.projectDir) || {
        playwright: { available: false, package: false, mcp: false },
        chromeDevTools: { available: false, plugin: false },
      };

    const baseUrlCandidates = unique([
      process.env.BASE_URL,
      surfaces.has('web-ui') && fs.existsSync(path.join(this.projectDir, 'mix.exs')) ? 'http://localhost:4000' : null,
      surfaces.has('web-ui') && packageJson.scripts?.dev ? 'http://localhost:3000' : null,
      surfaces.has('api') ? 'http://localhost:8080' : null,
    ]);

    const testEngines = unique([
      surfaces.has('web-ui') ? 'playwright' : null,
      surfaces.has('web-ui') ? 'chrome-devtools-mcp' : null,
      surfaces.has('native-ui') ? 'native-ui-automation' : null,
      surfaces.has('native-ui') ? 'dotnet-test' : null,
      surfaces.has('api') ? 'http-smoke' : null,
      surfaces.has('cli') ? 'command-runner' : null,
      surfaces.has('library') ? 'node-test' : null,
      surfaces.has('data') ? 'db-test' : null,
    ]);

    const evidencePolicy = Object.fromEntries(
      [...surfaces].map((surface) => [
        surface,
        {
          requiredEvidence: SURFACE_EVIDENCE[surface] || [],
          deterministicEngines:
            surface === 'web-ui'
              ? {
                  playwright: browserEngines.playwright?.available === true,
                  chromeDevToolsMcp: browserEngines.chromeDevTools?.available === true,
                  strictChromeDevTools: options.strictEngines === true,
                }
              : surface === 'native-ui'
                ? {
                    browserRequired: false,
                    nativeAutomation: true,
                  }
                : {},
        },
      ]),
    );

    const result = {
      version: VERSION,
      milestone,
      generatedAt: new Date().toISOString(),
      projectRoot: this.projectDir,
      hasExecutableSurface: true,
      hasUI: surfaces.has('web-ui') || surfaces.has('native-ui'),
      surfaces: [...surfaces].sort(),
      frameworks: ui.frameworks || [],
      signals: unique(signals),
      entrypoints: this._entrypoints(packageJson),
      baseUrlCandidates,
      testEngines,
      browserEngines,
      evidencePolicy,
      recommendedAgents: unique([...surfaces].flatMap((surface) => SURFACE_AGENT_MAP[surface] || [])),
      confidence: Math.min(0.99, 0.45 + unique(signals).length * 0.08),
    };

    if (options.write !== false) this._writeJson(this._artifactPath(milestone, 'surface-classification.json'), result);
    return result;
  }

  _entrypoints(packageJson) {
    const entries = [];
    if (packageJson.scripts?.dev) entries.push('package.json:scripts.dev');
    if (packageJson.scripts?.start) entries.push('package.json:scripts.start');
    if (packageJson.bin) entries.push('package.json:bin');
    if (fs.existsSync(path.join(this.projectDir, 'mix.exs'))) entries.push('mix.exs');
    if (fs.existsSync(path.join(this.projectDir, 'go.mod'))) entries.push('go.mod');
    if (fs.existsSync(path.join(this.projectDir, 'Dockerfile'))) entries.push('Dockerfile');
    return entries;
  }

  _milestoneRequirementKeys(milestone) {
    const milestoneId = String(milestone || DEFAULT_MILESTONE).toUpperCase();
    const keys = new Set();
    const addIds = (ids) => {
      for (const id of ids || []) keys.add(requirementKey(id));
    };

    const tracker = readJson(path.join(this._planningDir(), 'milestone-tracker.json'));
    const milestones = Array.isArray(tracker?.milestones)
      ? tracker.milestones
      : tracker?.milestones && typeof tracker.milestones === 'object'
        ? Object.values(tracker.milestones)
        : [];
    const milestoneRecord = milestones.find((item) =>
      [item?.id, item?.milestone, item?.name].some((value) => String(value || '').toUpperCase() === milestoneId),
    );
    if (milestoneRecord) {
      addIds(milestoneRecord.requirementIds);
      addIds(milestoneRecord.frIds);
      addIds(milestoneRecord.nfrIds);
      addIds(milestoneRecord.trIds);
      addIds(milestoneRecord.irIds);
    }

    const storyTracker = readJson(path.join(this._planningDir(), 'story-tracker.json'));
    for (const story of storyTracker?.stories || []) {
      if (String(story?.milestone || '').toUpperCase() !== milestoneId) continue;
      addIds(story.requirementIds);
      addIds(story.frIds);
      addIds(story.nfrIds);
      addIds(story.trIds);
      addIds(story.irIds);
    }

    const rtm = readJson(path.join(this._planningDir(), 'rtm.json'));
    const rtmReqs = Array.isArray(rtm?.requirements)
      ? rtm.requirements
      : rtm?.requirements && typeof rtm.requirements === 'object'
        ? Object.values(rtm.requirements)
        : [];
    for (const req of rtmReqs) {
      const milestonesForReq = unique([req.milestone, ...(Array.isArray(req.milestones) ? req.milestones : [])]);
      if (milestonesForReq.some((item) => String(item || '').toUpperCase() === milestoneId)) {
        addIds([req.id || req.requirementId]);
      }
    }

    return keys;
  }

  derivePersonas(options = {}) {
    const milestone = options.milestone || DEFAULT_MILESTONE;
    const classification = options.classification || this.classify({ milestone, write: false });
    const texts = this._planningTexts();
    const allText = Object.values(texts).join('\n').toLowerCase();
    const discovered = new Map();
    const addPersona = (persona) => {
      const id = `persona-${slug(persona.name)}`;
      const existing = discovered.get(id) || {};
      discovered.set(id, {
        id,
        name: persona.name,
        type: persona.type || existing.type || 'human',
        priority: persona.priority || existing.priority || 'primary',
        source: unique([...(existing.source || []), ...(persona.source || [])]),
        goals: unique([...(existing.goals || []), ...(persona.goals || [])]),
        permissions: unique([...(existing.permissions || []), ...(persona.permissions || [])]),
        criticalJourneys: unique([...(existing.criticalJourneys || []), ...(persona.criticalJourneys || [])]),
        riskAreas: unique([...(existing.riskAreas || []), ...(persona.riskAreas || [])]),
        surfaces: unique([...(existing.surfaces || []), ...(persona.surfaces || classification.surfaces)]),
        accessibilityContexts: unique([
          ...(existing.accessibilityContexts || []),
          ...(persona.accessibilityContexts || (classification.hasUI ? ['keyboard-only', 'mobile-viewport'] : [])),
        ]),
        coverageRequired: persona.coverageRequired ?? existing.coverageRequired ?? true,
      });
    };

    for (const [file, text] of Object.entries(texts)) {
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/\b(persona|role|actor|stakeholder|user type)s?\b\s*[:-]\s*(.+)$/i);
        if (!match) continue;
        for (const raw of match[2].split(/,|;|\band\b/i)) {
          const name = raw.replace(/[*_`#>-]/g, '').trim();
          if (name.length >= 3 && name.length <= 80) {
            addPersona({
              name,
              source: [`${file}:explicit-persona`],
              goals: [`Complete ${name.toLowerCase()} acceptance journeys`],
            });
          }
        }
      }
    }

    for (const [key, name, type, priority] of PERSONA_KEYWORDS) {
      if (allText.includes(key)) addPersona({ name, type, priority, source: ['keyword-scan'] });
    }

    if (classification.surfaces.includes('web-ui')) {
      addPersona({ name: 'Primary user', type: 'human', priority: 'primary', source: ['surface-fallback:web-ui'] });
      addPersona({
        name: 'Unauthenticated visitor',
        type: 'human',
        priority: 'restricted',
        source: ['surface-fallback:web-ui'],
        riskAreas: ['auth boundary'],
      });
    }
    if (classification.surfaces.includes('native-ui')) {
      addPersona({ name: 'Primary user', type: 'human', priority: 'primary', source: ['surface-fallback:native-ui'] });
      addPersona({
        name: 'Keyboard and screen reader user',
        type: 'human',
        priority: 'secondary',
        source: ['surface-fallback:native-ui'],
        accessibilityContexts: ['keyboard-only', 'screen-reader'],
      });
    }
    if (classification.surfaces.includes('api')) {
      addPersona({
        name: 'API client',
        type: 'external-system',
        priority: 'primary',
        source: ['surface-fallback:api'],
      });
    }
    if (classification.surfaces.includes('cli')) {
      addPersona({ name: 'CLI operator', type: 'human', priority: 'primary', source: ['surface-fallback:cli'] });
    }
    if (discovered.size === 0)
      addPersona({ name: 'Primary user', type: 'human', priority: 'primary', source: ['fallback'] });

    const personas = [...discovered.values()].sort((a, b) => a.id.localeCompare(b.id));
    const matrix = {
      version: VERSION,
      milestone,
      generatedAt: new Date().toISOString(),
      personas,
      summary: {
        total: personas.length,
        primary: personas.filter((persona) => persona.priority === 'primary').length,
        secondary: personas.filter((persona) => persona.priority === 'secondary').length,
        restricted: personas.filter((persona) => persona.priority === 'restricted').length,
        externalSystems: personas.filter((persona) => persona.type === 'external-system').length,
        coverageRequired: personas.filter((persona) => persona.coverageRequired).length,
      },
    };
    if (options.write !== false) this._writeJson(this._artifactPath(milestone, 'uat-personas.json'), matrix);
    return matrix;
  }

  extractRequirements(options = {}) {
    const milestone = options.milestone || DEFAULT_MILESTONE;
    const texts = this._planningTexts();
    const requirements = new Map();
    for (const [file, text] of Object.entries(texts)) {
      for (const line of text.split(/\r?\n/)) {
        for (const match of line.matchAll(/\b((?:FR|NFR|TR|IR|UX|API)-\d{1,4})\b/gi)) {
          const id = match[1].toUpperCase();
          if (!requirements.has(id)) {
            requirements.set(id, {
              id,
              source: path.join('_cobolt-output/latest/planning', file),
              description:
                line
                  .replace(/^[\s#>*-]+/, '')
                  .replace(/\s+/g, ' ')
                  .trim() || id,
            });
          }
        }
      }
    }
    const rtm = readJson(path.join(this._planningDir(), 'rtm.json'));
    const rtmReqs = Array.isArray(rtm?.requirements)
      ? rtm.requirements
      : rtm?.requirements && typeof rtm.requirements === 'object'
        ? Object.values(rtm.requirements)
        : [];
    for (const req of rtmReqs) {
      const id = String(req.id || req.requirementId || '').toUpperCase();
      if (id && !requirements.has(id)) {
        requirements.set(id, {
          id,
          source: '_cobolt-output/latest/planning/rtm.json',
          description: req.description || req.title || id,
        });
      }
    }
    if (requirements.size === 0) {
      requirements.set('REQ-UAT-001', {
        id: 'REQ-UAT-001',
        source: 'generated-fallback',
        description: 'Primary application acceptance workflow completes successfully',
      });
    }
    const milestoneKeys = this._milestoneRequirementKeys(milestone);
    const values = [...requirements.values()];
    if (milestoneKeys.size > 0) {
      const scoped = values.filter((req) => milestoneKeys.has(requirementKey(req.id)));
      if (scoped.length > 0) return scoped.sort((a, b) => a.id.localeCompare(b.id));
    }
    return values.sort((a, b) => a.id.localeCompare(b.id));
  }

  extractModuleActions(requirements = null, classification = null, options = {}) {
    const milestone = options.milestone || DEFAULT_MILESTONE;
    const reqs = requirements || this.extractRequirements({ milestone });
    const surfaces = classification?.surfaces || ['code-workflow'];
    const moduleActions = new Map();
    const addAction = ({ module, action, source, requirementId = null, surface = null, navigationOnly = false }) => {
      const normalizedModule = titleize(
        String(module || '')
          .replace(/[*_`#>:]/g, '')
          .trim(),
      );
      if (!normalizedModule || normalizedModule.length < 2 || normalizedModule.length > 80) return;
      const normalizedAction = slug(action || 'exercise-primary-action');
      const id = `module-action-${slug(normalizedModule)}-${normalizedAction}`;
      const existing = moduleActions.get(id) || {};
      moduleActions.set(id, {
        id,
        module: normalizedModule,
        action: normalizedAction,
        label: `${normalizedModule}: ${normalizedAction.replace(/-/g, ' ')}`,
        source: unique([...(existing.source || []), source]),
        requirementIds: unique([...(existing.requirementIds || []), requirementId]),
        surface:
          surface ||
          existing.surface ||
          (surfaces.includes('web-ui')
            ? 'web-ui'
            : surfaces.includes('native-ui')
              ? 'native-ui'
              : surfaces[0] || 'code-workflow'),
        navigationOnly: Boolean(existing.navigationOnly || navigationOnly),
        coverageRequired: true,
      });
    };

    for (const req of reqs) {
      const text = req.description || req.id;
      const module = this._moduleNameFromText(text);
      if (!module) continue;
      const actions = this._functionalActionsFromText(text);
      if (actions.length === 0 && NAVIGATION_ONLY_PATTERN.test(text)) {
        addAction({
          module,
          action: 'navigation-only-detected',
          source: req.source || 'requirement-text',
          requirementId: req.id,
          surface: this._surfaceForRequirement(req, classification || { surfaces }),
          navigationOnly: true,
        });
        continue;
      }
      for (const action of actions.length > 0 ? actions : ['exercise-primary-action']) {
        addAction({
          module,
          action,
          source: req.source || 'requirement-text',
          requirementId: req.id,
          surface: this._surfaceForRequirement(req, classification || { surfaces }),
        });
      }
    }

    const milestoneKeys = this._milestoneRequirementKeys(milestone);
    if (milestoneKeys.size === 0) {
      for (const [file, text] of Object.entries(this._planningTexts())) {
        for (const line of text.split(/\r?\n/)) {
          const match = line.match(/\b(modules?|functional areas?|workspaces?|sections?)\b\s*[:-]\s*(.+)$/i);
          if (!match) continue;
          for (const raw of match[2].split(/,|;|\band\b/i)) {
            const module = raw.replace(/\([^)]*\)/g, '').trim();
            if (module)
              addAction({
                module,
                action: 'exercise-primary-action',
                source: `${file}:explicit-module-list`,
                surface: surfaces.includes('web-ui')
                  ? 'web-ui'
                  : surfaces.includes('native-ui')
                    ? 'native-ui'
                    : surfaces[0],
              });
          }
        }
      }
    }

    return [...moduleActions.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  _moduleNameFromText(text) {
    const cleaned = String(text || '').replace(/\s+/g, ' ');
    const explicit = cleaned.match(
      /\b(?:in|inside|within|from|on|to)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9 /&-]{2,48}?)\s+(module|page|screen|dashboard|workflow|section)\b/i,
    );
    if (explicit) return explicit[1];
    const leading = cleaned.match(
      /\b([A-Z][A-Za-z0-9 /&-]{2,48}?)\s+(module|page|screen|dashboard|workflow|section)\b/,
    );
    if (leading) return leading[1];
    const known = cleaned.match(
      /\b(dashboard|settings|reports?|projects?|users?|billing|profile|admin|search|notifications?|checkout|orders?|inventory|messages?|documents?)\b/i,
    );
    return known ? known[1] : null;
  }

  _functionalActionsFromText(text) {
    const actions = [];
    for (const [action, pattern] of FUNCTIONAL_ACTION_PATTERNS) {
      if (pattern.test(text)) actions.push(action);
    }
    return unique(actions);
  }

  generateCases(options = {}) {
    const milestone = options.milestone || DEFAULT_MILESTONE;
    const mode = options.mode || 'build';
    const classification = options.classification || this.classify({ milestone, write: false });
    const personaMatrix = options.personaMatrix || this.derivePersonas({ milestone, classification, write: false });
    const requirements = options.requirements || this.extractRequirements({ milestone });
    const moduleActions =
      options.moduleActions || this.extractModuleActions(requirements, classification, { milestone });
    const cases = [];
    let counter = 1;
    const primaryReqs = requirements.filter((req) => /^(FR|UX|API)-/i.test(req.id)).slice(0, 40);
    const requirementsForCases = primaryReqs.length > 0 ? primaryReqs : requirements.slice(0, 20);

    for (const req of requirementsForCases) {
      const surface = this._surfaceForRequirement(req, classification);
      for (const persona of this._personasForRequirement(req, personaMatrix, surface)) {
        cases.push(this._buildCase({ milestone, mode, counter: counter++, req, persona, surface }));
      }
    }

    const requiredPersonas = personaMatrix.personas.filter((persona) => persona.coverageRequired);
    for (const persona of requiredPersonas) {
      if (cases.some((testCase) => testCase.personaId === persona.id)) continue;
      const req = requirementsForCases[0] || requirements[0];
      const surface = persona.surfaces?.[0] || classification.surfaces[0] || 'code-workflow';
      cases.push(this._buildCase({ milestone, mode, counter: counter++, req, persona, surface }));
    }

    for (const moduleAction of moduleActions.filter((item) => item.coverageRequired && !item.navigationOnly)) {
      const req = requirements.find((candidate) => moduleAction.requirementIds.includes(candidate.id)) || {
        id: `MOD-${slug(moduleAction.module).toUpperCase()}`,
        description: `Exercise ${moduleAction.action.replace(/-/g, ' ')} in the ${moduleAction.module} module`,
      };
      const persona =
        this._personaForModuleAction(moduleAction, personaMatrix) || requiredPersonas[0] || personaMatrix.personas[0];
      if (!persona) continue;
      cases.push(this._buildModuleActionCase({ milestone, mode, counter: counter++, req, persona, moduleAction }));
    }

    const coveredPersonaIds = new Set(cases.map((testCase) => testCase.personaId));
    const personaCoverageGaps = requiredPersonas
      .filter((persona) => !coveredPersonaIds.has(persona.id))
      .map((persona) => ({ personaId: persona.id, reason: 'No UAT case generated' }));
    const coveredModuleActionIds = new Set(cases.map((testCase) => testCase.moduleAction?.id).filter(Boolean));
    const moduleActionCoverageGaps = moduleActions
      .filter((item) => item.coverageRequired && (item.navigationOnly || !coveredModuleActionIds.has(item.id)))
      .map((item) => ({
        moduleActionId: item.id,
        module: item.module,
        action: item.action,
        reason: item.navigationOnly
          ? 'Only navigation/sidebar coverage detected; no functional module action is defined'
          : 'No module-action UAT case generated',
      }));

    const payload = {
      version: VERSION,
      milestone,
      mode,
      generatedAt: new Date().toISOString(),
      summary: {
        requirementsTotal: requirements.length,
        personasTotal: personaMatrix.personas.length,
        personasCoverageRequired: requiredPersonas.length,
        personasCovered: coveredPersonaIds.size,
        personaCoverageGaps: personaCoverageGaps.length,
        modulesTotal: moduleActions.length,
        moduleActionsCoverageRequired: moduleActions.filter((item) => item.coverageRequired).length,
        moduleActionsCovered: coveredModuleActionIds.size,
        moduleActionCoverageGaps: moduleActionCoverageGaps.length,
        casesTotal: cases.length,
      },
      moduleActions,
      personaCoverageGaps,
      moduleActionCoverageGaps,
      cases,
    };
    if (options.write !== false) this._writeJson(this._artifactPath(milestone, 'uat-cases.json'), payload);
    return payload;
  }

  _surfaceForRequirement(req, classification) {
    const text = `${req.id} ${req.description}`.toLowerCase();
    if (
      classification.surfaces.includes('web-ui') &&
      /(ui|screen|page|click|form|dashboard|view|ux|navigation)/.test(text)
    )
      return 'web-ui';
    if (
      classification.surfaces.includes('native-ui') &&
      /(ui|screen|window|dialog|settings|click|form|view|ux|keyboard|accessibility|topmost|desktop)/.test(text)
    )
      return 'native-ui';
    if (classification.surfaces.includes('api') && /(api|endpoint|request|response|webhook|graphql)/.test(text))
      return 'api';
    if (classification.surfaces.includes('cli') && /(cli|command|terminal|stdout|stderr)/.test(text)) return 'cli';
    if (classification.surfaces.includes('data') && /(data|database|migration|schema|record|persist)/.test(text))
      return 'data';
    return classification.surfaces[0] || 'code-workflow';
  }

  _personasForRequirement(req, personaMatrix, surface) {
    const text = `${req.id} ${req.description}`.toLowerCase();
    const direct = personaMatrix.personas.filter((persona) => {
      const name = persona.name.toLowerCase();
      return text.includes(name) || name.split(/\s+/).some((part) => part.length > 4 && text.includes(part));
    });
    if (direct.length > 0) return direct.slice(0, 2);
    const surfaceMatch = personaMatrix.personas.filter((persona) => (persona.surfaces || []).includes(surface));
    const primary =
      surfaceMatch.find((persona) => persona.priority === 'primary') ||
      personaMatrix.personas.find((persona) => persona.priority === 'primary');
    return primary ? [primary] : personaMatrix.personas.slice(0, 1);
  }

  _personaForModuleAction(moduleAction, personaMatrix) {
    const surfaceMatch = personaMatrix.personas.filter((persona) =>
      (persona.surfaces || []).includes(moduleAction.surface),
    );
    return (
      surfaceMatch.find((persona) => persona.priority === 'primary') ||
      personaMatrix.personas.find((persona) => persona.priority === 'primary') ||
      personaMatrix.personas[0]
    );
  }

  _buildCase({ milestone, mode, counter, req, persona, surface }) {
    const engine =
      surface === 'web-ui'
        ? 'playwright'
        : surface === 'native-ui'
          ? 'native-ui-automation'
          : surface === 'api'
            ? 'http-smoke'
            : surface === 'cli'
              ? 'command-runner'
              : 'node-test';
    return {
      id: `UAT-${milestone}-${String(counter).padStart(3, '0')}`,
      caseType: 'requirement',
      mode,
      surface,
      priority: persona.priority === 'primary' ? 'critical' : persona.priority === 'restricted' ? 'high' : 'medium',
      requirementIds: [req.id],
      findingIds: [],
      personaId: persona.id,
      persona: persona.name,
      journey: `${persona.name}: ${req.description}`,
      preconditions: this._preconditionsForSurface(surface, persona),
      steps: this._stepsForSurface(surface, req),
      expectedOutcome: req.description,
      negativeCases: this._negativeCasesForPersona(persona, surface),
      evidenceRequired: SURFACE_EVIDENCE[surface] || SURFACE_EVIDENCE['code-workflow'],
      automation: {
        engine,
        deterministic: true,
        testFile:
          surface === 'web-ui'
            ? `tests/e2e/uat/${slug(req.id)}-${slug(persona.name)}.spec.ts`
            : surface === 'native-ui'
              ? `tests/WorldClockDesktop.Tests/UI/${slug(req.id)}${slug(persona.name)}Tests.cs`
              : null,
      },
      status: 'pending',
    };
  }

  _buildModuleActionCase({ milestone, mode, counter, req, persona, moduleAction }) {
    const surface = moduleAction.surface || 'web-ui';
    const engine =
      surface === 'web-ui'
        ? 'playwright'
        : surface === 'native-ui'
          ? 'native-ui-automation'
          : surface === 'api'
            ? 'http-smoke'
            : surface === 'cli'
              ? 'command-runner'
              : 'node-test';
    const readableAction = moduleAction.action.replace(/-/g, ' ');
    return {
      id: `UAT-${milestone}-${String(counter).padStart(3, '0')}`,
      caseType: 'module-action',
      mode,
      surface,
      priority: persona.priority === 'primary' ? 'critical' : 'high',
      requirementIds: unique(moduleAction.requirementIds.length > 0 ? moduleAction.requirementIds : [req.id]),
      findingIds: [],
      personaId: persona.id,
      persona: persona.name,
      moduleAction: {
        id: moduleAction.id,
        module: moduleAction.module,
        action: moduleAction.action,
        navigationOnly: false,
      },
      journey: `${persona.name}: exercise ${readableAction} inside ${moduleAction.module}`,
      preconditions: this._preconditionsForSurface(surface, persona),
      steps: this._stepsForModuleAction(surface, moduleAction),
      expectedOutcome: `${moduleAction.module} supports ${readableAction} with observable state, data, or response evidence`,
      negativeCases: this._negativeCasesForPersona(persona, surface),
      evidenceRequired: unique([
        ...(SURFACE_EVIDENCE[surface] || SURFACE_EVIDENCE['code-workflow']),
        'module-action-assertion',
        'uat-case-id-in-test',
      ]),
      automation: {
        engine,
        deterministic: true,
        testFile:
          surface === 'web-ui'
            ? `tests/e2e/uat/${moduleAction.id}.spec.ts`
            : surface === 'native-ui'
              ? `tests/WorldClockDesktop.Tests/UI/${moduleAction.id.replace(/[^A-Za-z0-9]/g, '')}Tests.cs`
              : null,
        requireCaseIdInTest: true,
      },
      status: 'pending',
    };
  }

  _stepsForModuleAction(surface, moduleAction) {
    const readableAction = moduleAction.action.replace(/-/g, ' ');
    if (surface === 'web-ui') {
      return [
        {
          action: 'navigate',
          target: `${moduleAction.module} module`,
          expected: 'Module route renders without runtime errors',
        },
        {
          action: 'exercise-module-action',
          target: readableAction,
          expected: 'The module action is performed, not just the sidebar/menu item opened',
        },
        {
          action: 'assert-functional-outcome',
          target: `${moduleAction.module} state`,
          expected: 'UI, network, persisted data, or visible result confirms the action worked',
        },
      ];
    }
    if (surface === 'native-ui') {
      return [
        {
          action: 'launch-window',
          target: `${moduleAction.module} desktop UI`,
          expected: 'Native window renders without runtime errors',
        },
        {
          action: 'exercise-module-action',
          target: readableAction,
          expected: 'The desktop UI action is performed, not just a window opened',
        },
        {
          action: 'assert-functional-outcome',
          target: `${moduleAction.module} native state`,
          expected: 'UI automation, persisted data, or visible state confirms the action worked',
        },
      ];
    }
    if (surface === 'api') {
      return [
        {
          action: 'request',
          target: `${moduleAction.module}:${readableAction}`,
          expected: 'Documented endpoint behavior succeeds',
        },
        {
          action: 'assert-functional-outcome',
          target: 'response body/schema',
          expected: 'Response proves the module action completed',
        },
      ];
    }
    if (surface === 'cli') {
      return [
        {
          action: 'run-command',
          target: `${moduleAction.module}:${readableAction}`,
          expected: 'Command exits successfully',
        },
        {
          action: 'assert-functional-outcome',
          target: 'stdout/stderr/state file',
          expected: 'Output proves the module action completed',
        },
      ];
    }
    return [
      {
        action: 'assert-functional-outcome',
        target: `${moduleAction.module}:${readableAction}`,
        expected: 'Executable evidence proves the action works',
      },
    ];
  }

  _preconditionsForSurface(surface, persona) {
    const base = ['Application dependencies are installed'];
    if (surface === 'web-ui') base.push('Application server is running', `${persona.name} test data exists`);
    if (surface === 'native-ui')
      base.push('Desktop application can be launched', `${persona.name} local test data exists`);
    if (surface === 'api')
      base.push('API server is reachable', `${persona.name} credentials or token state is prepared`);
    if (surface === 'cli') base.push('Command is available on PATH or via local project script');
    if (surface === 'data') base.push('Test database or fixture store is available');
    return base;
  }

  _stepsForSurface(surface, req) {
    if (surface === 'web-ui') {
      return [
        { action: 'navigate', target: 'relevant route', expected: 'Page renders without runtime errors' },
        { action: 'interact', target: req.id, expected: 'Observable UI state changes as specified' },
        { action: 'verify', target: 'screen and network', expected: req.description },
      ];
    }
    if (surface === 'native-ui') {
      return [
        {
          action: 'launch-window',
          target: 'relevant desktop window',
          expected: 'Window renders without runtime errors',
        },
        { action: 'interact', target: req.id, expected: 'Observable native UI state changes as specified' },
        { action: 'verify', target: 'automation tree and local state', expected: req.description },
      ];
    }
    if (surface === 'api') {
      return [
        { action: 'request', target: req.id, expected: 'Endpoint returns documented status and schema' },
        { action: 'negative-request', target: req.id, expected: 'Invalid input returns documented error' },
      ];
    }
    if (surface === 'cli')
      return [{ action: 'run-command', target: req.id, expected: 'Exit code and output match acceptance behavior' }];
    return [{ action: 'execute', target: req.id, expected: req.description }];
  }

  _negativeCasesForPersona(persona, surface) {
    const cases = [];
    if (persona.priority === 'restricted') cases.push('Verify restricted access is denied with a clear outcome');
    if (surface === 'web-ui') cases.push('Verify invalid input or blocked state surfaces an error message');
    if (surface === 'native-ui')
      cases.push('Verify invalid input or blocked state surfaces an accessible desktop error message');
    if (surface === 'api') cases.push('Verify unauthorized or malformed request returns documented error');
    return cases;
  }

  _collectTestFiles(milestone) {
    const roots = [
      'tests/e2e',
      'tests',
      'e2e',
      'tests/playwright',
      'test/e2e',
      'tests/browser',
      path.join('_cobolt-output', `${milestone || DEFAULT_MILESTONE}-playwright-results`, 'tests'),
    ].map((dir) => path.join(this.projectDir, dir));
    const files = [];
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!['node_modules', '.git', '_cobolt-output'].includes(entry.name)) walk(fullPath);
          continue;
        }
        if (/\.(spec|test)\.(js|jsx|ts|tsx|mjs|cjs)$/.test(entry.name) || /\.cs$/i.test(entry.name)) {
          files.push(fullPath);
        }
      }
    };
    roots.forEach(walk);
    return unique(files);
  }

  _inspectModuleActionTestCoverage(caseInventory, milestone) {
    const moduleActionCases = (caseInventory.cases || []).filter((testCase) => testCase.caseType === 'module-action');
    if (moduleActionCases.length === 0) {
      return {
        status: 'not-applicable',
        moduleActionCasesTotal: 0,
        moduleActionCasesCovered: 0,
        missingCaseIds: [],
        filesScanned: [],
      };
    }

    const files = this._collectTestFiles(milestone);
    const corpus = files.map((file) => readText(file)).join('\n');
    const missing = moduleActionCases.filter((testCase) => !corpus.includes(testCase.id));
    return {
      status: missing.length === 0 ? 'passed' : 'failed',
      moduleActionCasesTotal: moduleActionCases.length,
      moduleActionCasesCovered: moduleActionCases.length - missing.length,
      missingCaseIds: missing.map((testCase) => testCase.id),
      missingModules: missing.map((testCase) => testCase.moduleAction?.module || testCase.journey),
      filesScanned: files.map((file) => path.relative(this.projectDir, file)),
      rule: 'Every module-action UAT case ID must appear in executable test files; sidebar/navigation-only tests do not satisfy functional module coverage.',
    };
  }

  async run(options = {}) {
    const milestone = options.milestone || DEFAULT_MILESTONE;
    const mode = options.mode || 'build';
    const classification = this.classify({ milestone, strictEngines: options.strictEngines, write: true });
    const personaMatrix = this.derivePersonas({ milestone, classification, write: true });
    const caseInventory = this.generateCases({ milestone, mode, classification, personaMatrix, write: true });
    const baseUrl = options.baseUrl || process.env.BASE_URL || classification.baseUrlCandidates[0] || null;
    const findings = [];
    const evidence = {
      playwright: { status: 'not-applicable' },
      chromeDevToolsMcp: {
        status: classification.browserEngines?.chromeDevTools?.available ? 'available' : 'not-available',
        strictRequired: options.strictEngines === true,
      },
      api: { status: 'not-applicable' },
      moduleActionCoverage: { status: 'not-applicable' },
    };

    evidence.moduleActionCoverage = this._inspectModuleActionTestCoverage(caseInventory, milestone);
    if (evidence.moduleActionCoverage.status === 'failed') {
      findings.push(
        this._finding(
          findings.length + 1,
          'UAT-COVERAGE',
          'high',
          `Functional module-action UAT coverage is missing for ${evidence.moduleActionCoverage.missingCaseIds.length} case(s); sidebar/navigation-only tests are insufficient`,
          classification.surfaces.includes('web-ui')
            ? 'web-ui'
            : classification.surfaces.includes('native-ui')
              ? 'native-ui'
              : classification.surfaces[0] || 'code-workflow',
          evidence.moduleActionCoverage,
        ),
      );
    }

    if (classification.surfaces.includes('web-ui')) {
      if (!baseUrl) {
        evidence.playwright.status = 'missing-base-url';
        findings.push(
          this._finding(
            findings.length + 1,
            'UAT-ENV',
            options.strictEngines ? 'high' : 'medium',
            'UI UAT could not run because no base URL was provided or detected',
            'web-ui',
          ),
        );
      } else if (!playwrightModule?.PlaywrightTool) {
        evidence.playwright.status = 'tool-unavailable';
        findings.push(
          this._finding(
            findings.length + 1,
            'UAT-ENV',
            'high',
            'UI UAT could not run because cobolt-playwright is unavailable',
            'web-ui',
          ),
        );
      } else {
        const tool = new playwrightModule.PlaywrightTool(this.projectDir);
        const smoke = await tool.smoke({ baseUrl });
        const a11yPath = path.join(this._evidenceDir('accessibility'), `${milestone}-a11y-audit.json`);
        const syncPath = path.join(this._evidenceDir('network'), `${milestone}-sync-check.json`);
        const a11y = await tool.audit({ baseUrl, output: a11yPath, standard: 'WCAG2AA' });
        const sync = await tool.checkSync({ baseUrl, output: syncPath });
        this._writeJson(path.join(this._evidenceDir('playwright'), `${milestone}-smoke.json`), smoke);
        evidence.playwright = {
          status: smoke.passed && a11y.score >= 80 && sync.passed ? 'passed' : 'failed',
          baseUrl,
          smokePassed: smoke.passed,
          a11yScore: a11y.score,
          syncPassed: sync.passed,
          smokePath: path.join('_cobolt-output/latest/uat/evidence/playwright', `${milestone}-smoke.json`),
          a11yPath: path.relative(this.projectDir, a11yPath),
          syncPath: path.relative(this.projectDir, syncPath),
        };
        if (!smoke.passed)
          findings.push(
            this._finding(
              findings.length + 1,
              'UAT-RENDER',
              'critical',
              'Playwright smoke test failed for the UI acceptance surface',
              'web-ui',
              smoke,
            ),
          );
        if (a11y.score < 80)
          findings.push(
            this._finding(
              findings.length + 1,
              'UAT-A11Y',
              'high',
              `Playwright accessibility audit score ${a11y.score} is below the required 80 threshold`,
              'web-ui',
              a11y,
            ),
          );
        if (!sync.passed)
          findings.push(
            this._finding(
              findings.length + 1,
              'UAT-API',
              'high',
              'Playwright frontend/backend sync check found failed requests or console errors',
              'web-ui',
              sync,
            ),
          );
      }

      if (options.strictEngines && !classification.browserEngines?.chromeDevTools?.available) {
        findings.push(
          this._finding(
            findings.length + 1,
            'UAT-ENV',
            'high',
            'Chrome DevTools MCP is required in strict UAT mode but is not available',
            'web-ui',
          ),
        );
      }
    }

    if (classification.surfaces.includes('api')) {
      if (!baseUrl) {
        evidence.api.status = 'missing-base-url';
      } else if (playwrightModule?.PlaywrightTool) {
        const tool = new playwrightModule.PlaywrightTool(this.projectDir);
        const health = await tool.healthCheck({ baseUrl });
        const healthPath = path.join(this._evidenceDir('api'), `${milestone}-health-check.json`);
        this._writeJson(healthPath, health);
        evidence.api = {
          status: health.failed > 0 ? 'failed' : 'passed',
          baseUrl,
          healthPath: path.relative(this.projectDir, healthPath),
          total: health.total,
          failed: health.failed,
        };
        if (health.failed > 0)
          findings.push(
            this._finding(
              findings.length + 1,
              'UAT-API',
              'high',
              `API health UAT failed for ${health.failed} route(s)`,
              'api',
              health,
            ),
          );
      }
    }

    const results = {
      version: VERSION,
      milestone,
      mode,
      generatedAt: new Date().toISOString(),
      baseUrl,
      surfaceClassificationPath: path.relative(
        this.projectDir,
        this._artifactPath(milestone, 'surface-classification.json'),
      ),
      personaMatrixPath: path.relative(this.projectDir, this._artifactPath(milestone, 'uat-personas.json')),
      caseInventoryPath: path.relative(this.projectDir, this._artifactPath(milestone, 'uat-cases.json')),
      summary: {
        casesTotal: caseInventory.cases.length,
        casesPassed: findings.length === 0 ? caseInventory.cases.length : 0,
        casesFailed: findings.length > 0 ? Math.max(1, findings.length) : 0,
        personasTotal: personaMatrix.summary.total,
        personasCovered: caseInventory.summary.personasCovered,
        personaCoverageGaps: caseInventory.summary.personaCoverageGaps,
        modulesTotal: caseInventory.summary.modulesTotal || 0,
        moduleActionsCovered: caseInventory.summary.moduleActionsCovered || 0,
        moduleActionCoverageGaps:
          (caseInventory.summary.moduleActionCoverageGaps || 0) +
          (evidence.moduleActionCoverage.status === 'failed' ? evidence.moduleActionCoverage.missingCaseIds.length : 0),
        criticalHighOpen: findings.filter((finding) => ['critical', 'high'].includes(finding.severity)).length,
        evidenceComplete: this._evidenceComplete(classification, evidence, options),
      },
      evidence,
      findings,
    };
    const verdict = this.decideFromResults(results, options);
    results.verdict = verdict.verdict;
    results.status = verdict.status;

    this._writeJson(this._artifactPath(milestone, 'uat-results.json'), results);
    this._writeJson(this._artifactPath(milestone, 'uat-findings.json'), {
      version: VERSION,
      milestone,
      generatedAt: new Date().toISOString(),
      summary: { total: findings.length, bySeverity: severityCounts(findings) },
      findings,
    });
    this._writeJson(this._artifactPath(milestone, 'uat-verdict.json'), verdict);
    this.writeReport({ milestone, results, verdict, classification, personaMatrix, caseInventory });
    return { results, verdict };
  }

  _finding(index, subtype, severity, description, surface, evidence = null) {
    return {
      id: `UAT-${String(index).padStart(3, '0')}`,
      prefix: 'UAT',
      subtype,
      severity,
      category: subtype === 'UAT-A11Y' ? 'a11y' : subtype === 'UAT-API' ? 'api' : 'ux',
      surface,
      description,
      status: 'open',
      evidence,
      assignedAgent: this._agentForSubtype(subtype),
    };
  }

  _agentForSubtype(subtype) {
    if (subtype === 'UAT-A11Y') return 'accessibility-reviewer';
    if (subtype === 'UAT-API') return 'backend-fix';
    if (subtype === 'UAT-ENV') return 'ops-readiness-reviewer';
    if (subtype === 'UAT-COVERAGE') return 'test-architect';
    return 'frontend-fix';
  }

  _evidenceComplete(classification, evidence, options = {}) {
    if (evidence.moduleActionCoverage?.status === 'failed') return false;
    if (classification.surfaces.includes('web-ui')) {
      if (evidence.playwright.status !== 'passed') return false;
      if (options.strictEngines && evidence.chromeDevToolsMcp.status !== 'available') return false;
    }
    if (classification.surfaces.includes('api') && evidence.api.status === 'failed') return false;
    return true;
  }

  decide(options = {}) {
    const milestone = options.milestone || DEFAULT_MILESTONE;
    const results = options.results ||
      readJson(options.resultsPath) ||
      readJson(this._artifactPath(milestone, 'uat-results.json')) || {
        milestone,
        summary: { criticalHighOpen: 0, casesFailed: 0, personaCoverageGaps: 0, evidenceComplete: false },
        findings: [],
      };
    const verdict = this.decideFromResults(results, options);
    this._writeJson(this._artifactPath(milestone, 'uat-verdict.json'), verdict);
    return verdict;
  }

  decideFromResults(results, options = {}) {
    const iteration = Number(options.iteration || results.iteration || 1);
    const maxIterations = Number(options.maxIterations || DEFAULT_MAX_ITERATIONS);
    const attemptsForSameFailures = Number(options.attemptsForSameFailures || results.attemptsForSameFailures || 1);
    const summary = results.summary || {};
    const findings = results.findings || [];
    const counts = severityCounts(findings);
    const criticalHighOpen = summary.criticalHighOpen ?? counts.critical + counts.high;
    const personaCoverageGaps = summary.personaCoverageGaps || 0;
    const moduleActionCoverageGaps = summary.moduleActionCoverageGaps || 0;
    const evidenceComplete = summary.evidenceComplete === true;
    const mode = String(results.mode || options.mode || '').toLowerCase();
    const productionUatMode = mode === 'build' || mode === 'final' || mode === 'release';
    const mediumLowOpen = counts.medium + counts.low;
    let verdict = 'EXIT_SUCCESS';
    let status = 'passed';
    let action = 'continue';
    let reason = 'All required UAT evidence passed';
    let nextOwner = null;
    let humanRequired = false;

    if (criticalHighOpen > 0 && iteration >= maxIterations) {
      verdict = 'EXIT_HUMAN';
      status = 'failed';
      action = 'human-escalation';
      reason = `Max UAT iterations (${maxIterations}) reached with ${criticalHighOpen} Critical/High finding(s) open`;
      nextOwner = 'human';
      humanRequired = true;
    } else if (criticalHighOpen > 0 && attemptsForSameFailures >= DEFAULT_ESCALATE_AFTER) {
      verdict = 'LOOP_ESCALATE';
      status = 'failed';
      action = 'route-to-lead';
      reason = `${criticalHighOpen} Critical/High UAT finding(s) remain after ${attemptsForSameFailures} attempt(s)`;
      nextOwner = this._escalationOwner(findings);
    } else if (criticalHighOpen > 0) {
      verdict = 'LOOP';
      status = 'failed';
      action = 'route-to-fix';
      reason = `${criticalHighOpen} Critical/High UAT finding(s) remain`;
      nextOwner = this._escalationOwner(findings);
    } else if (personaCoverageGaps > 0 && options.strictPersonas) {
      verdict = iteration >= maxIterations ? 'EXIT_HUMAN' : 'LOOP';
      status = 'failed';
      action = iteration >= maxIterations ? 'human-escalation' : 'generate-missing-persona-cases';
      reason = `${personaCoverageGaps} required persona coverage gap(s) remain`;
      nextOwner = iteration >= maxIterations ? 'human' : 'test-architect';
      humanRequired = iteration >= maxIterations;
    } else if (!evidenceComplete && (options.strictEngines || productionUatMode)) {
      verdict =
        iteration >= maxIterations
          ? 'EXIT_HUMAN'
          : attemptsForSameFailures >= DEFAULT_ESCALATE_AFTER
            ? 'LOOP_ESCALATE'
            : 'LOOP';
      status = 'failed';
      action =
        iteration >= maxIterations
          ? 'human-escalation'
          : attemptsForSameFailures >= DEFAULT_ESCALATE_AFTER
            ? 'route-to-lead'
            : 'complete-deterministic-evidence';
      reason = productionUatMode
        ? 'Required deterministic UAT evidence is incomplete for build/final UAT'
        : 'Required deterministic UAT evidence is incomplete';
      nextOwner = iteration >= maxIterations ? 'human' : 'uat-agent';
      humanRequired = iteration >= maxIterations;
    } else if (
      (mediumLowOpen > 0 || personaCoverageGaps > 0 || moduleActionCoverageGaps > 0 || !evidenceComplete) &&
      options.blockConditional
    ) {
      const shouldEscalate = attemptsForSameFailures >= DEFAULT_ESCALATE_AFTER || iteration >= DEFAULT_ESCALATE_AFTER;
      verdict = iteration >= maxIterations ? 'EXIT_HUMAN' : shouldEscalate ? 'LOOP_ESCALATE' : 'LOOP';
      status = 'failed';
      action =
        iteration >= maxIterations
          ? 'human-escalation'
          : shouldEscalate
            ? 'escalate-to-specialist'
            : 'complete-uat-before-continuing';
      reason = 'UAT no-skip mode blocks conditional evidence, persona, and non-critical finding gaps';
      nextOwner =
        iteration >= maxIterations
          ? 'human'
          : moduleActionCoverageGaps > 0 || personaCoverageGaps > 0
            ? 'test-architect'
            : !evidenceComplete
              ? 'uat-agent'
              : this._escalationOwner(findings);
      humanRequired = iteration >= maxIterations;
    } else if (mediumLowOpen > 0 || personaCoverageGaps > 0 || moduleActionCoverageGaps > 0 || !evidenceComplete) {
      verdict = 'EXIT_CONDITIONAL';
      status = 'conditional';
      action = 'carry-forward-with-grade-penalty';
      reason = 'Only non-blocking UAT gaps or degraded evidence remain';
      nextOwner = 'fix-lead';
    }

    return {
      version: VERSION,
      milestone: results.milestone || options.milestone || DEFAULT_MILESTONE,
      mode: results.mode || options.mode || 'build',
      iteration,
      maxIterations,
      status,
      verdict,
      generatedAt: new Date().toISOString(),
      summary: {
        casesTotal: summary.casesTotal || 0,
        casesPassed: summary.casesPassed || 0,
        casesFailed: summary.casesFailed || 0,
        personasTotal: summary.personasTotal || 0,
        personasCovered: summary.personasCovered || 0,
        personaCoverageGaps,
        moduleActionCoverageGaps,
        criticalHighOpen,
        evidenceComplete,
      },
      decision: { action, reason, nextOwner },
      escalation: {
        attemptsForSameFailures,
        level: verdict === 'LOOP_ESCALATE' ? 'lead' : verdict === 'EXIT_HUMAN' ? 'human' : 'none',
        humanRequired,
      },
    };
  }

  _escalationOwner(findings) {
    const criticalHigh = (findings || []).find((finding) => ['critical', 'high'].includes(finding.severity));
    return criticalHigh?.assignedAgent || 'fix-lead';
  }

  writeReport({ milestone, results, verdict, classification, personaMatrix, caseInventory }) {
    const lines = [
      `# ${milestone} UAT Report`,
      '',
      `Generated: ${new Date().toISOString()}`,
      `Verdict: ${verdict.verdict} (${verdict.status})`,
      `Decision: ${verdict.decision.action}`,
      `Reason: ${verdict.decision.reason}`,
      '',
      '## Surface Classification',
      '',
      `Surfaces: ${classification.surfaces.join(', ')}`,
      `Playwright available: ${classification.browserEngines?.playwright?.available === true ? 'yes' : 'no'}`,
      `Chrome DevTools MCP available: ${classification.browserEngines?.chromeDevTools?.available === true ? 'yes' : 'no'}`,
      '',
      '## Persona Coverage',
      '',
      `Personas: ${personaMatrix.summary.total}`,
      `Coverage required: ${personaMatrix.summary.coverageRequired}`,
      `Covered by cases: ${caseInventory.summary.personasCovered}`,
      `Coverage gaps: ${caseInventory.summary.personaCoverageGaps}`,
      '',
      '## Module Action Coverage',
      '',
      `Modules discovered: ${caseInventory.summary.modulesTotal || 0}`,
      `Module actions covered: ${caseInventory.summary.moduleActionsCovered || 0}`,
      `Module action gaps: ${results.summary.moduleActionCoverageGaps || caseInventory.summary.moduleActionCoverageGaps || 0}`,
      `Executable case-id coverage: ${results.evidence.moduleActionCoverage?.status || 'not-applicable'}`,
      '',
      '## Case Summary',
      '',
      `Cases total: ${results.summary.casesTotal}`,
      `Cases passed: ${results.summary.casesPassed}`,
      `Cases failed: ${results.summary.casesFailed}`,
      '',
      '## Findings',
      '',
    ];
    if ((results.findings || []).length === 0) {
      lines.push('No UAT findings were recorded.', '');
    } else {
      for (const finding of results.findings)
        lines.push(`- ${finding.id} [${finding.severity}] ${finding.subtype}: ${finding.description}`);
      lines.push('');
    }
    lines.push('## Evidence', '');
    lines.push(`Playwright: ${results.evidence.playwright.status}`);
    lines.push(`Chrome DevTools MCP: ${results.evidence.chromeDevToolsMcp.status}`);
    lines.push(`API: ${results.evidence.api.status}`);
    lines.push(`Module actions: ${results.evidence.moduleActionCoverage?.status || 'not-applicable'}`);
    lines.push('', '## Scope Ledger', '');
    lines.push('Verified working: only cases with deterministic evidence marked passed in this run.');
    lines.push('Broken or blocked: UAT findings listed above.');
    lines.push('Not yet verified: generated cases without executable evidence in this run.');
    lines.push('');

    const latestPath = this._artifactPath(milestone, 'uat-report.md');
    const reportPath = path.join(this._reportsDir(milestone), `${milestone}-uat-report.md`);
    this._writeText(latestPath, `${lines.join('\n')}\n`);
    this._writeText(reportPath, `${lines.join('\n')}\n`);
    return { latestPath, reportPath };
  }

  report(options = {}) {
    const milestone = options.milestone || DEFAULT_MILESTONE;
    const reportPath = this._artifactPath(milestone, 'uat-report.md');
    if (fs.existsSync(reportPath)) return readText(reportPath);
    const results = readJson(this._artifactPath(milestone, 'uat-results.json'));
    const verdict = readJson(this._artifactPath(milestone, 'uat-verdict.json'));
    if (!results || !verdict) return '# No UAT report found.\n';
    const classification =
      readJson(this._artifactPath(milestone, 'surface-classification.json')) ||
      this.classify({ milestone, write: false });
    const personaMatrix =
      readJson(this._artifactPath(milestone, 'uat-personas.json')) || this.derivePersonas({ milestone, write: false });
    const caseInventory =
      readJson(this._artifactPath(milestone, 'uat-cases.json')) || this.generateCases({ milestone, write: false });
    this.writeReport({ milestone, results, verdict, classification, personaMatrix, caseInventory });
    return readText(reportPath);
  }
}

function printHelp() {
  console.log('CoBolt UAT - deterministic user acceptance pipeline');
  console.log('');
  console.log('Usage: node tools/cobolt-uat.js <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  classify                  Detect application surfaces and evidence engines');
  console.log('  personas                  Derive application-specific UAT personas');
  console.log('  generate                  Generate persona/requirement-traced UAT cases');
  console.log('  run                       Run deterministic UAT evidence checks');
  console.log('  decide                    Compute UAT loop verdict from latest results');
  console.log('  report                    Print latest UAT report');
  console.log('');
  console.log('Options:');
  console.log('  --milestone M1            Milestone id');
  console.log('  --mode build|fix|final    UAT mode');
  console.log('  --base-url URL            Running app URL for Playwright/API evidence');
  console.log('  --iteration N             Current loop iteration');
  console.log('  --max-iterations N        Loop cap (default 5)');
  console.log('  --attempts N              Attempts for same failure');
  console.log('  --strict-engines          Require Chrome DevTools MCP where applicable');
  console.log('  --strict-personas         Block on persona coverage gaps');
  console.log('  --block-conditional       Treat conditional UAT gaps as blocking');
  console.log('  --json                    Print JSON');
  console.log('  --out PATH                Write command output as UTF-8');
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  const options = {
    milestone: parseArgValue(args, '--milestone', DEFAULT_MILESTONE),
    mode: parseArgValue(args, '--mode', 'build'),
    baseUrl: parseArgValue(args, '--base-url', parseArgValue(args, '--url', null)),
    iteration: Number(parseArgValue(args, '--iteration', '1')),
    maxIterations: Number(parseArgValue(args, '--max-iterations', String(DEFAULT_MAX_ITERATIONS))),
    attemptsForSameFailures: Number(parseArgValue(args, '--attempts', '1')),
    out: parseArgValue(args, '--out', null),
    strictEngines: args.includes('--strict-engines'),
    strictPersonas: args.includes('--strict-personas'),
    blockConditional: args.includes('--block-conditional'),
  };
  const json = args.includes('--json');
  const uat = new UatOrchestrator();

  switch (cmd) {
    case 'classify': {
      const result = uat.classify(options);
      writeCliOutput(options.out, result);
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(`UAT surfaces: ${result.surfaces.join(', ')}`);
      break;
    }
    case 'personas': {
      const result = uat.derivePersonas(options);
      writeCliOutput(options.out, result);
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(`UAT personas: ${result.summary.total} (${result.summary.coverageRequired} required)`);
      break;
    }
    case 'generate': {
      const result = uat.generateCases(options);
      writeCliOutput(options.out, result);
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(`UAT cases: ${result.summary.casesTotal}`);
      break;
    }
    case 'run': {
      const result = await uat.run(options);
      writeCliOutput(options.out, result);
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(`UAT verdict: ${result.verdict.verdict} (${result.verdict.status})`);
      process.exitCode =
        result.verdict.verdict === 'EXIT_SUCCESS' ||
        (!options.blockConditional && result.verdict.verdict === 'EXIT_CONDITIONAL')
          ? 0
          : 1;
      break;
    }
    case 'decide': {
      const result = uat.decide(options);
      writeCliOutput(options.out, result);
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(`UAT verdict: ${result.verdict} - ${result.decision.reason}`);
      process.exitCode =
        result.verdict === 'EXIT_SUCCESS' || (!options.blockConditional && result.verdict === 'EXIT_CONDITIONAL')
          ? 0
          : result.verdict === 'EXIT_HUMAN'
            ? 2
            : 1;
      break;
    }
    case 'report': {
      const result = uat.report(options);
      writeCliOutput(options.out, result);
      console.log(result);
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  UatOrchestrator,
  SURFACE_AGENT_MAP,
  SURFACE_EVIDENCE,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_ESCALATE_AFTER,
};
