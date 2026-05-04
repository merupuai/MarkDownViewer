#!/usr/bin/env node

// CoBolt Planning Context Packet
//
// Produces a small, path-based packet for planning sub-agents. The packet is
// intentionally compact: agents get canonical artifact paths, requirement IDs,
// and small excerpts instead of duplicated full PRDs/source documents.

const fs = require('node:fs');
const path = require('node:path');

const { normalizeMilestoneId, resolveReadablePlanningDir, safeReadJson } = require('../lib/cobolt-planning-artifacts');
const { atomicWrite } = require('../lib/cobolt-atomic-write');
const { stampArtifact } = require('./cobolt-artifact-provenance');

const DEFAULT_MAX_EXCERPT_CHARS = 2400;

function loadDependencies(projectRoot) {
  const candidates = [
    path.join(projectRoot, 'source', 'schemas', 'artifact-dependencies.json'),
    path.resolve(__dirname, '../source/schemas/artifact-dependencies.json'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch {
      /* try next */
    }
  }
  return null;
}

function normalizeSlash(value) {
  return String(value || '').replaceAll('\\', '/');
}

function rel(projectRoot, filePath) {
  return filePath ? path.relative(projectRoot, filePath).replaceAll('\\', '/') : null;
}

function statArtifact(projectRoot, planningDir, artifact) {
  const rawPath = normalizeSlash(artifact?.path || '');
  const planningPrefix = '_cobolt-output/latest/planning/';
  if (!rawPath.startsWith(planningPrefix)) return null;

  const suffix = rawPath.slice(planningPrefix.length);
  const absolutePath = path.join(planningDir, suffix.replaceAll('/', path.sep));
  let size = 0;
  let exists = false;
  try {
    const stat = fs.statSync(absolutePath);
    exists = stat.isFile();
    size = exists ? stat.size : 0;
  } catch {
    /* missing */
  }

  return {
    path: rel(projectRoot, absolutePath),
    exists,
    size,
    minBytes: Number(artifact.minBytes || 1),
    description: artifact.description || null,
  };
}

function artifactStatus(projectRoot, planningDir, deps, artifactId) {
  const artifact = deps?.artifacts?.[artifactId];
  if (!artifact) return null;

  if (artifact.pathPattern) {
    const pattern = normalizeSlash(artifact.pathPattern);
    const planningPrefix = '_cobolt-output/latest/planning/';
    const suffix = pattern.startsWith(planningPrefix) ? pattern.slice(planningPrefix.length) : pattern;
    const baseDir = suffix.includes('/')
      ? path.join(planningDir, suffix.split('/').slice(0, -1).join(path.sep))
      : planningDir;
    const basenamePattern = suffix.split('/').pop() || '*';
    const extension = basenamePattern.endsWith('.md') ? '.md' : path.extname(basenamePattern);
    let files = [];
    try {
      files = fs
        .readdirSync(baseDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .filter((entry) => !extension || entry.name.endsWith(extension))
        .map((entry) => {
          const filePath = path.join(baseDir, entry.name);
          const stat = fs.statSync(filePath);
          return { path: rel(projectRoot, filePath), size: stat.size };
        });
    } catch {
      /* missing pattern dir */
    }
    return {
      pathPattern: pattern,
      exists: files.length > 0,
      count: files.length,
      files: files.slice(0, 12),
      minBytes: Number(artifact.minBytes || 1),
      description: artifact.description || null,
    };
  }

  return statArtifact(projectRoot, planningDir, artifact);
}

function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function summarizeMarkdown(content, options = {}) {
  const maxExcerptChars = options.maxExcerptChars || DEFAULT_MAX_EXCERPT_CHARS;
  const lines = String(content || '').split(/\r?\n/);
  const headings = lines
    .map((line, index) => ({ line: index + 1, text: line.trim() }))
    .filter((entry) => /^#{1,4}\s+/.test(entry.text))
    .slice(0, 30);
  const requirementIds = [
    ...new Set(
      (String(content || '').match(/\b(?:FR|NFR|TR|IR|SRC|FEAT)-\d+\b/gi) || []).map((id) => id.toUpperCase()),
    ),
  ].slice(0, 80);

  return {
    bytes: Buffer.byteLength(String(content || ''), 'utf8'),
    large: Buffer.byteLength(String(content || ''), 'utf8') > 50 * 1024,
    headings,
    requirementIds,
    excerpt: String(content || '').slice(0, maxExcerptChars),
    truncated: String(content || '').length > maxExcerptChars,
  };
}

function parseSourceRequirementRegistry(content) {
  const rows = [];
  const lines = String(content || '').split(/\r?\n/);
  let inRegistry = false;
  for (const line of lines) {
    if (/^##+\s+Source Requirement Registry\b/i.test(line.trim())) {
      inRegistry = true;
      continue;
    }
    if (inRegistry && /^##+\s+/.test(line.trim())) break;
    if (!inRegistry) continue;
    const match = line.match(/^\|\s*(SRC-\d+)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)?\|\s*([^|]+)?\|/i);
    if (!match) continue;
    rows.push({
      id: match[1].toUpperCase(),
      sourceFile: match[2].trim(),
      summary: match[3].trim(),
      category: (match[4] || '').trim(),
      status: (match[5] || '').trim(),
    });
  }
  return rows;
}

function extractMilestoneSection(content, milestone) {
  const normalized = normalizeMilestoneId(milestone);
  if (!normalized) return null;

  const lines = String(content || '').split(/\r?\n/);
  const startIndex = lines.findIndex((line) =>
    new RegExp(`^#{2,3}\\s+(?:Milestone\\s+)?${normalized}\\b`, 'i').test(line.trim()),
  );
  if (startIndex < 0) return null;

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (/^#{2,3}\s+(?:Milestone\s+)?M\d+\b/i.test(lines[i].trim())) {
      endIndex = i;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join('\n').slice(0, 3000);
}

function listMilestoneStories(planningDir, milestone) {
  const normalized = normalizeMilestoneId(milestone);
  if (!normalized) return [];
  const tracker = safeReadJson(path.join(planningDir, 'story-tracker.json'));
  if (!Array.isArray(tracker?.stories)) return [];
  return tracker.stories
    .filter((story) => normalizeMilestoneId(story.milestone || story.milestoneId) === normalized)
    .map((story) => ({
      id: story.id || null,
      title: story.title || story.name || null,
      file: story.storyFile || story.storyPath || story.path || null,
      requirementIds: story.requirementIds || story.frIds || [],
    }))
    .slice(0, 40);
}

function planningRouterEnabled(options) {
  if (options.contextRoute === false) return false;
  if (options.contextRoute === true) return true;
  if (String(process.env.COBOLT_CONTEXT_ROUTER || '').trim() === '1') return true;
  // Per-stage opt-in: COBOLT_CONTEXT_ROUTER_PLANNING=1
  if (String(process.env.COBOLT_CONTEXT_ROUTER_PLANNING || '').trim() === '1') return true;
  return false;
}

function attachPlanningContextRoute(packet, projectRoot, options) {
  if (!planningRouterEnabled(options)) return packet;
  let router;
  try {
    router = require('./cobolt-context-router');
  } catch (err) {
    if (process.env.COBOLT_CONTEXT_ROUTER_DEBUG === '1') {
      console.error(`  [context-router] load failed: ${err.message}`);
    }
    return packet;
  }
  try {
    const requirementIds = Array.isArray(packet.milestoneSlice?.stories)
      ? [...new Set(packet.milestoneSlice.stories.flatMap((s) => s.requirementIds || []))]
      : [];
    const route = router.buildContextRoute(projectRoot, {
      stage: 'planning',
      milestone: packet.milestone,
      skill: packet.skill,
      requirementIds,
      query: options.query,
      mode: options.mode,
      maxSelected: options.maxSelected,
      maxExcerptChars: options.maxExcerptChars || packet.contextBudget?.maxExcerptChars,
    });
    packet.contextRoute = route;
    appendPlanningRoutingGuidance(packet);
  } catch (err) {
    if (process.env.COBOLT_CONTEXT_ROUTER_DEBUG === '1') {
      console.error(`  [context-router] build failed: ${err.message}`);
    }
  }
  return packet;
}

function appendPlanningRoutingGuidance(packet) {
  if (!packet.contextRoute) return;
  const r = packet.contextRoute;
  const routingRules = [
    `Read contextRoute.selected[] first (${r.selected.length} path-backed cells). Prefer these over scanning all planning artifacts.`,
    `Expand contextRoute.parked[] (${r.parked.length}) only if selected is insufficient; record which parked cells you read.`,
    'Cite selected paths in the structured return for routing telemetry.',
  ];
  if (!Array.isArray(packet.dispatchRules)) packet.dispatchRules = [];
  packet.dispatchRules = [...packet.dispatchRules, ...routingRules];
}

function buildPlanningContextPacket(projectRoot = process.cwd(), options = {}) {
  const root = path.resolve(projectRoot);
  const deps = loadDependencies(root);
  const planningDir = resolveReadablePlanningDir(root, { allowLatestFallback: true });
  const skill = options.skill || 'cobolt-plan';
  const milestone = normalizeMilestoneId(options.milestone);
  const skillDef = deps?.skills?.[skill] || deps?.producers?.[skill] || {};
  const requiredIds = Array.isArray(skillDef.requires)
    ? skillDef.requires
    : Object.values(skillDef.requires || {})
        .flat()
        .filter(Boolean);
  const optionalIds = Array.isArray(skillDef.optionalContext) ? skillDef.optionalContext : [];
  const artifacts = {};

  if (planningDir && deps) {
    for (const artifactId of [...new Set([...requiredIds, ...optionalIds])]) {
      const status = artifactStatus(root, planningDir, deps, artifactId);
      if (status) artifacts[artifactId] = status;
    }
  }

  const prdPath = planningDir ? path.join(planningDir, 'prd.md') : null;
  const prdContent = prdPath ? safeRead(prdPath) : '';
  const sourcePacketPath = planningDir ? path.join(planningDir, 'source-document-consolidation.md') : null;
  const sourcePacketContent = sourcePacketPath ? safeRead(sourcePacketPath) : '';
  const sourceRegistryRows = parseSourceRequirementRegistry(sourcePacketContent);
  const milestonesContent = planningDir ? safeRead(path.join(planningDir, 'milestones.md')) : '';
  const packet = {
    generatedAt: new Date().toISOString(),
    projectRoot: root,
    skill,
    milestone,
    canonicalPlanningDir: planningDir ? rel(root, planningDir) : null,
    contextBudget: {
      maxExcerptChars: options.maxExcerptChars || DEFAULT_MAX_EXCERPT_CHARS,
      guidance:
        'Pass this packet path plus artifact paths to planning agents. Do not paste full PRDs or source documents into agent prompts.',
    },
    requiredArtifactIds: requiredIds,
    optionalArtifactIds: optionalIds,
    artifacts,
    prd: prdPath
      ? {
          path: rel(root, prdPath),
          ...summarizeMarkdown(prdContent, { maxExcerptChars: options.maxExcerptChars }),
        }
      : null,
    sourceRequirements: {
      packetPath: sourcePacketPath ? rel(root, sourcePacketPath) : null,
      count: sourceRegistryRows.length,
      sample: sourceRegistryRows.slice(0, 20),
    },
    milestoneSlice: milestone
      ? {
          milestone,
          sectionExcerpt: extractMilestoneSection(milestonesContent, milestone),
          stories: planningDir ? listMilestoneStories(planningDir, milestone) : [],
        }
      : null,
    dispatchRules: [
      'Give sub-agents artifact paths and IDs first; let them read only the files they need.',
      'Do not paste full PRDs or source-document packets into repeated agent prompts.',
      'For PRDs over 50KB, pass milestoneSlice plus requirement IDs instead of the whole PRD.',
      'Sub-agents must write produced artifacts to the canonical planning directory listed in this packet.',
      'After a sub-agent returns, run cobolt-planning-artifact-audit before continuing.',
    ],
  };

  return attachPlanningContextRoute(packet, root, options);
}

function defaultPacketPath(projectRoot, packet) {
  const planningDir = resolveReadablePlanningDir(projectRoot, { allowLatestFallback: true });
  const baseDir = planningDir || path.join(projectRoot, '_cobolt-output', 'latest', 'planning');
  const outDir = path.join(baseDir, 'context-packets');
  const skillPart = String(packet.skill || 'skill').replace(/[^a-z0-9_-]+/gi, '-');
  const milestonePart = packet.milestone || 'all';
  return path.join(outDir, `${skillPart}-${milestonePart}.json`);
}

function writePlanningContextPacket(projectRoot, packet, outputPath) {
  const target = outputPath || defaultPacketPath(projectRoot, packet);
  // Atomic: tmp + fsync + rename. atomicWrite calls ensureDir internally so the
  // explicit mkdirSync is no longer required.
  atomicWrite(target, JSON.stringify(packet, null, 2), { encoding: 'utf8' });
  try {
    const root = path.resolve(projectRoot);
    const inputPaths = [packet?.prd?.path, packet?.sourceRequirements?.packetPath]
      .filter(Boolean)
      .map((inputPath) => path.join(root, inputPath));
    stampArtifact(root, target, {
      producedBy: 'cobolt-planning-context',
      milestone: packet?.milestone || null,
      inputPaths,
    });
  } catch {
    /* provenance is best-effort for compatibility with partial planning dirs */
  }
  return target;
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(
    'Usage: node tools/cobolt-planning-context.js packet [--skill <skill>] [--milestone M1] [--write] [--json] [--output <file>] [--project <dir>] [--max-excerpt-chars <n>] [--context-route|--no-context-route] [--query <text>] [--mode <name>]\n',
  );
  stream.write(
    '       node tools/cobolt-planning-context.js build [--skill <skill>] [--milestone M1] [--write] [--json] [--output <file>] [--project <dir>] [--max-excerpt-chars <n>] [--context-route|--no-context-route] [--query <text>] [--mode <name>]\n',
  );
  process.exit(exitCode);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') usage(0);
  const command = args[0] && !args[0].startsWith('--') ? args[0] : 'packet';
  if (!['packet', 'build'].includes(command)) {
    usage(1);
  }

  const projectRoot = flagValue(args, '--project') || process.cwd();
  const maxExcerptChars =
    Number.parseInt(flagValue(args, '--max-excerpt-chars') || '', 10) || DEFAULT_MAX_EXCERPT_CHARS;
  const wantRoute = args.includes('--context-route') ? true : args.includes('--no-context-route') ? false : undefined;
  const packet = buildPlanningContextPacket(projectRoot, {
    skill: flagValue(args, '--skill') || 'cobolt-plan',
    milestone: flagValue(args, '--milestone'),
    maxExcerptChars,
    contextRoute: wantRoute,
    query: flagValue(args, '--query'),
    mode: flagValue(args, '--mode'),
  });

  if (args.includes('--write')) {
    const outputPath = writePlanningContextPacket(projectRoot, packet, flagValue(args, '--output'));
    packet.packetPath = rel(path.resolve(projectRoot), outputPath);
    if (packet.contextRoute) {
      try {
        const router = require('./cobolt-context-router');
        const routePath = router.writeContextRoute(projectRoot, packet.contextRoute);
        packet.contextRoutePath = rel(path.resolve(projectRoot), routePath);
      } catch (err) {
        if (process.env.COBOLT_CONTEXT_ROUTER_DEBUG === '1') {
          console.error(`  [context-router] write failed: ${err.message}`);
        }
      }
    }
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify(packet, null, 2));
  } else {
    console.log(`Planning context packet for ${packet.skill}${packet.milestone ? ` ${packet.milestone}` : ''}`);
    console.log(`Canonical planning dir: ${packet.canonicalPlanningDir || '(missing)'}`);
    if (packet.packetPath) console.log(`Packet written: ${packet.packetPath}`);
    if (packet.contextRoutePath) console.log(`Route written: ${packet.contextRoutePath}`);
    console.log(`Required artifacts: ${packet.requiredArtifactIds.length}`);
    console.log(`Source requirements: ${packet.sourceRequirements.count}`);
    if (packet.contextRoute) {
      const r = packet.contextRoute;
      console.log(`Route: selected=${r.selected.length} parked=${r.parked.length} omitted=${r.omitted.length}`);
    }
  }
}

if (require.main === module) main();

module.exports = {
  buildPlanningContextPacket,
  writePlanningContextPacket,
  parseSourceRequirementRegistry,
  summarizeMarkdown,
};
