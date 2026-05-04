#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { walkFiles } = require('../lib/cobolt-search');
const { atomicWriteJSON } = require('../lib/cobolt-atomic-write');
// Lazy-load sibling tools so this module stays usable (build, stats, query)
// even when the sibling files are absent in a partial installation.
function requireCodeIndex() {
  return require('./cobolt-code-index');
}
function requireEmbeddingIndex() {
  return require('./cobolt-embedding-index');
}

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst']);
const CODE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.htm',
  '.vue',
  '.svelte',
  '.py',
  '.pyi',
  '.go',
  '.rs',
  '.java',
  '.rb',
  '.rake',
  '.cs',
  '.php',
  '.kt',
  '.kts',
  '.c',
  '.h',
  '.cpp',
  '.cc',
  '.cxx',
  '.hpp',
  '.swift',
  '.sh',
  '.bash',
  '.zsh',
  '.json',
  '.yaml',
  '.yml',
  '.sql',
  '.scala',
  '.sc',
  '.toml',
]);

function outputRoot(root) {
  return path.join(root, '_cobolt-output');
}

function codeIndexDir(root) {
  return path.join(outputRoot(root), 'code-index');
}

function graphPath(root) {
  return path.join(codeIndexDir(root), 'knowledge-graph.json');
}

function summaryPath(root) {
  return path.join(codeIndexDir(root), 'knowledge-graph-summary.json');
}

function readJsonSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {
    /* fail open */
  }
  return null;
}

function writeJsonAtomic(filePath, data) {
  atomicWriteJSON(filePath, data);
  return filePath;
}

function resolveLatestDir(root) {
  const latestDir = path.join(outputRoot(root), 'latest');
  if (fs.existsSync(latestDir)) return latestDir;

  const pointerFile = path.join(outputRoot(root), 'latest.ptr');
  if (!fs.existsSync(pointerFile)) return null;

  try {
    const pointerTarget = fs.readFileSync(pointerFile, 'utf8').trim();
    if (pointerTarget && fs.existsSync(pointerTarget)) return pointerTarget;
  } catch {
    /* ignore */
  }

  return null;
}

function normalizeRelPath(root, candidate) {
  if (!candidate) return null;
  const resolvedRoot = path.resolve(root);
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(resolvedRoot, candidate);
  return path.relative(resolvedRoot, resolved).replace(/\\/g, '/');
}

function nodeId(type, value) {
  return `${type}:${value}`;
}

function normalizeEvidenceRef(ref) {
  const match = String(ref || '')
    .trim()
    .match(/^([A-Za-z]+)[-_]?([0-9]+(?:[.-][0-9]+)*)$/);
  if (!match) return null;
  return `${match[1].toUpperCase()}-${match[2]}`;
}

function classifyEvidenceRef(ref) {
  const prefix = String(ref || '')
    .split('-')[0]
    .toUpperCase();
  if (['FR', 'NFR', 'TR', 'IR', 'REQ'].includes(prefix)) return 'requirement';
  return 'finding';
}

function extractEvidenceRefsFromText(text) {
  const refs = new Set();
  const matches = String(text || '').match(/\b[A-Z]{2,8}[-_]\d+(?:[.-]\d+)*\b/gi) || [];
  for (const match of matches) {
    const normalized = normalizeEvidenceRef(match);
    if (normalized) refs.add(normalized);
  }
  return [...refs].sort();
}

function readLineSlice(root, relPath, startLine, endLine) {
  try {
    const fullPath = path.join(root, relPath);
    const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
    const start = Math.max(0, (startLine || 1) - 1);
    const end = Math.min(lines.length, endLine || lines.length);
    return lines.slice(start, end).join('\n');
  } catch {
    return '';
  }
}

function compactList(values, limit = 5) {
  return values.filter(Boolean).slice(0, limit);
}

function stableSortById(items) {
  return items.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

class KnowledgeGraphBuilder {
  constructor(root) {
    this.root = path.resolve(root || process.cwd());
    this.nodes = new Map();
    this.edges = [];
    this.edgeKeys = new Set();
    this.warnings = [];
    this.latestDir = resolveLatestDir(this.root);
  }

  addNode(id, type, attrs = {}) {
    const existing = this.nodes.get(id);
    if (existing) {
      this.nodes.set(id, {
        ...existing,
        ...attrs,
        id,
        type,
        metadata: { ...(existing.metadata || {}), ...(attrs.metadata || {}) },
      });
      return this.nodes.get(id);
    }

    const node = {
      id,
      type,
      label: attrs.label || id,
      path: attrs.path || null,
      metadata: attrs.metadata || {},
    };
    this.nodes.set(id, node);
    return node;
  }

  addEdge(from, to, type, metadata = {}) {
    if (!from || !to || from === to) return null;
    const key = `${from}|${type}|${to}`;
    if (this.edgeKeys.has(key)) return null;
    this.edgeKeys.add(key);
    const edge = { from, to, type, metadata };
    this.edges.push(edge);
    return edge;
  }

  addDocumentSections(documentNode, relPath, entry = {}) {
    const sections = Array.isArray(entry.sections) ? entry.sections : [];
    if (sections.length === 0) return;

    const stack = [];
    for (const section of sections) {
      const startLine = Number.isFinite(section.startLine) ? section.startLine : 1;
      const endLine = Number.isFinite(section.endLine) ? section.endLine : startLine;
      const level = Number.isFinite(section.level) ? section.level : 1;
      const heading = String(section.heading || `Section L${startLine}`).trim();
      const sectionKey = `${relPath}#L${startLine}`;
      const sectionNode = this.addNode(nodeId('section', sectionKey), 'section', {
        label: heading,
        path: relPath,
        metadata: {
          heading,
          level,
          startLine,
          endLine,
          lineCount: section.lineCount || Math.max(0, endLine - startLine),
        },
      });

      this.addEdge(documentNode.id, sectionNode.id, 'contains_section');

      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      if (stack.length > 0) this.addEdge(stack[stack.length - 1].id, sectionNode.id, 'contains_section');
      stack.push({ id: sectionNode.id, level });

      const sectionText = readLineSlice(this.root, relPath, startLine, endLine);
      for (const ref of extractEvidenceRefsFromText(sectionText)) {
        const refType = classifyEvidenceRef(ref);
        const refNode = this.addNode(nodeId(refType, ref), refType, {
          label: ref,
          metadata: { discoveredFrom: 'document-section-reference' },
        });
        this.addEdge(
          sectionNode.id,
          refNode.id,
          refType === 'requirement' ? 'mentions_requirement' : 'mentions_finding',
        );
      }
    }
  }

  addCodeAndDocumentNodes() {
    const codeIndex = readJsonSafe(path.join(codeIndexDir(this.root), 'code-index.json'));
    const docIndex = readJsonSafe(path.join(codeIndexDir(this.root), 'doc-index.json'));
    const deps = readJsonSafe(path.join(codeIndexDir(this.root), 'deps.json'));

    if (codeIndex?.files && Object.keys(codeIndex.files).length > 0) {
      for (const [relPath, entry] of Object.entries(codeIndex.files)) {
        const fileNode = this.addNode(nodeId('file', relPath), 'file', {
          label: relPath,
          path: relPath,
          metadata: {
            lang: entry.lang,
            symbolCount: (entry.functions || []).length + (entry.classes || []).length + (entry.types || []).length,
          },
        });

        for (const symbol of entry.functions || []) {
          const symbolNode = this.addNode(
            nodeId('symbol', `${relPath}#function:${symbol.name}:${symbol.line}`),
            'symbol',
            {
              label: symbol.name,
              path: relPath,
              metadata: { kind: 'function', line: symbol.line, language: entry.lang },
            },
          );
          this.addEdge(fileNode.id, symbolNode.id, 'contains');
        }

        for (const symbol of entry.classes || []) {
          const symbolNode = this.addNode(
            nodeId('symbol', `${relPath}#class:${symbol.name}:${symbol.line}`),
            'symbol',
            {
              label: symbol.name,
              path: relPath,
              metadata: { kind: 'class', line: symbol.line, language: entry.lang },
            },
          );
          this.addEdge(fileNode.id, symbolNode.id, 'contains');
        }

        for (const symbol of entry.types || []) {
          const symbolNode = this.addNode(nodeId('symbol', `${relPath}#type:${symbol.name}:${symbol.line}`), 'symbol', {
            label: symbol.name,
            path: relPath,
            metadata: { kind: 'type', line: symbol.line, language: entry.lang },
          });
          this.addEdge(fileNode.id, symbolNode.id, 'contains');
        }
      }
    } else {
      const files = walkFiles(this.root, {
        extensions: [...CODE_EXTENSIONS],
      });
      for (const filePath of files) {
        const relPath = normalizeRelPath(this.root, filePath);
        this.addNode(nodeId('file', relPath), 'file', {
          label: relPath,
          path: relPath,
          metadata: { discoveredFrom: 'fallback-file-walk' },
        });
      }
    }

    if (docIndex?.files && Object.keys(docIndex.files).length > 0) {
      for (const [relPath, entry] of Object.entries(docIndex.files)) {
        const documentNode = this.addNode(nodeId('document', relPath), 'document', {
          label: relPath,
          path: relPath,
          metadata: {
            sections: (entry.sections || []).length,
            totalLines: entry.totalLines || 0,
          },
        });
        this.addDocumentSections(documentNode, relPath, entry);
      }
    } else {
      const files = walkFiles(this.root, {
        extensions: [...DOC_EXTENSIONS],
      });
      for (const filePath of files) {
        const relPath = normalizeRelPath(this.root, filePath);
        const document = requireCodeIndex().parseDocument(filePath) || { totalLines: 0, sections: [] };
        const documentNode = this.addNode(nodeId('document', relPath), 'document', {
          label: relPath,
          path: relPath,
          metadata: {
            sections: (document.sections || []).length,
            totalLines: document.totalLines || 0,
          },
        });
        this.addDocumentSections(documentNode, relPath, document);
      }
    }

    if (deps?.importedBy) {
      for (const [moduleName, importers] of Object.entries(deps.importedBy)) {
        const moduleNode = this.addNode(nodeId('module', moduleName), 'module', {
          label: moduleName,
          metadata: { importedBy: importers.length },
        });
        for (const importer of importers) {
          const importerNode = this.addNode(nodeId('file', importer), 'file', {
            label: importer,
            path: importer,
            metadata: { discoveredFrom: 'dependency-edge' },
          });
          this.addEdge(importerNode.id, moduleNode.id, 'imports');
        }
      }
    }
  }

  addPlanningNodes() {
    if (!this.latestDir) return;

    const planningDir = path.join(this.latestDir, 'planning');
    const rtm = readJsonSafe(path.join(planningDir, 'rtm.json'));
    const storyTracker = readJsonSafe(path.join(planningDir, 'story-tracker.json'));
    const milestoneTracker = readJsonSafe(path.join(planningDir, 'milestone-tracker.json'));

    if (!rtm) this.warnings.push('missing: planning/rtm.json — requirement nodes omitted');
    if (!storyTracker) this.warnings.push('missing: planning/story-tracker.json — story nodes omitted');
    if (!milestoneTracker) this.warnings.push('missing: planning/milestone-tracker.json — milestone nodes omitted');

    const storyMilestones = new Map();

    for (const milestone of milestoneTracker?.milestones || []) {
      const milestoneId = String(milestone.id || '').trim();
      if (!milestoneId) continue;
      const milestoneNode = this.addNode(nodeId('milestone', milestoneId), 'milestone', {
        label: milestone.name || milestoneId,
        metadata: {
          storyCount: milestone.storyCount || (milestone.stories || []).length || 0,
          status: milestone.status || null,
        },
      });

      for (const dep of milestone.dependsOn || milestone.dependencies || []) {
        const depId = String(dep || '').trim();
        if (!depId) continue;
        const depNode = this.addNode(nodeId('milestone', depId), 'milestone', { label: depId });
        this.addEdge(milestoneNode.id, depNode.id, 'depends_on');
      }

      for (const storyId of milestone.stories || []) {
        const storyNode = this.addNode(nodeId('story', storyId), 'story', {
          label: storyId,
          metadata: { discoveredFrom: 'milestone-tracker' },
        });
        storyMilestones.set(storyId, milestoneId);
        this.addEdge(milestoneNode.id, storyNode.id, 'contains_story');
      }
    }

    for (const story of storyTracker?.stories || []) {
      const storyId = String(story.id || '').trim();
      if (!storyId) continue;
      const milestoneId = story.milestone || story.milestoneId || storyMilestones.get(storyId) || null;
      const storyNode = this.addNode(nodeId('story', storyId), 'story', {
        label: story.title || storyId,
        path: story.storyFile || null,
        metadata: {
          epic: story.epic || story.epicId || null,
          milestone: milestoneId,
          status: story.status || null,
          requirementIds: story.requirementIds || story.frIds || [],
        },
      });

      if (milestoneId) {
        const milestoneNode = this.addNode(nodeId('milestone', milestoneId), 'milestone', { label: milestoneId });
        this.addEdge(milestoneNode.id, storyNode.id, 'contains_story');
      }

      for (const dep of story.dependsOn || []) {
        const depId = String(dep || '').trim();
        if (!depId) continue;
        const depNode = this.addNode(nodeId('story', depId), 'story', { label: depId });
        this.addEdge(storyNode.id, depNode.id, 'depends_on_story');
      }

      if (story.storyFile) {
        const relPath = normalizeRelPath(this.root, story.storyFile);
        const fileNode = this.addNode(nodeId('document', relPath), 'document', {
          label: relPath,
          path: relPath,
          metadata: { discoveredFrom: 'story-tracker' },
        });
        this.addEdge(storyNode.id, fileNode.id, 'documented_by');
      }
    }

    for (const requirement of Object.values(rtm?.requirements || {})) {
      const requirementId = String(requirement.id || '').trim();
      if (!requirementId) continue;

      const requirementNode = this.addNode(nodeId('requirement', requirementId), 'requirement', {
        label: requirement.title || requirementId,
        metadata: {
          status: requirement.status || 'unknown',
          type: requirement.type || 'unknown',
          priority: requirement.priority || null,
          milestone: requirement.milestone || null,
          epic: requirement.epic || null,
        },
      });

      if (requirement.milestone) {
        const milestoneNode = this.addNode(nodeId('milestone', requirement.milestone), 'milestone', {
          label: requirement.milestone,
        });
        this.addEdge(requirementNode.id, milestoneNode.id, 'planned_for');
      }

      for (const storyId of requirement.stories || []) {
        const storyNode = this.addNode(nodeId('story', storyId), 'story', { label: storyId });
        this.addEdge(requirementNode.id, storyNode.id, 'implemented_by_story');
      }

      for (const evidence of requirement.code_evidence || []) {
        if (!evidence?.file) continue;
        const relPath = normalizeRelPath(this.root, evidence.file);
        const fileNode = this.addNode(nodeId('file', relPath), 'file', {
          label: relPath,
          path: relPath,
          metadata: { discoveredFrom: 'rtm-code-evidence' },
        });
        this.addEdge(requirementNode.id, fileNode.id, 'implemented_by_file', {
          line: evidence.line || null,
        });
      }

      for (const evidence of requirement.test_evidence || []) {
        if (!evidence?.file) continue;
        const relPath = normalizeRelPath(this.root, evidence.file);
        const fileNode = this.addNode(nodeId('file', relPath), 'file', {
          label: relPath,
          path: relPath,
          metadata: { discoveredFrom: 'rtm-test-evidence' },
        });
        this.addEdge(requirementNode.id, fileNode.id, 'verified_by_test', {
          line: evidence.line || null,
          caseId: evidence.case_id || null,
        });
      }
    }
  }

  addFindingNodes() {
    if (!this.latestDir) return;

    const candidates = [
      { stage: 'review', filePath: path.join(this.latestDir, 'review', 'finding-tracker.json') },
      { stage: 'fix', filePath: path.join(this.latestDir, 'fix', 'finding-tracker.json') },
      { stage: 'brownfield', filePath: path.join(this.latestDir, 'brownfield', '16-issues-registry.json') },
    ];

    for (const candidate of candidates) {
      const payload = readJsonSafe(candidate.filePath);
      if (!payload) continue;

      const findings = Array.isArray(payload.findings)
        ? payload.findings
        : Array.isArray(payload.issues)
          ? payload.issues
          : [];

      for (const finding of findings) {
        const findingId = String(finding.id || '').trim();
        if (!findingId) continue;

        const findingNode = this.addNode(nodeId('finding', findingId), 'finding', {
          label: finding.description || finding.title || findingId,
          metadata: {
            stage: candidate.stage,
            severity: finding.severity || finding.priority || null,
            status: finding.status || 'open',
            prefix: finding.prefix || null,
            category: finding.category || null,
          },
        });

        const milestoneId = finding.milestone || payload.milestone || null;
        if (milestoneId) {
          const milestoneNode = this.addNode(nodeId('milestone', milestoneId), 'milestone', { label: milestoneId });
          this.addEdge(findingNode.id, milestoneNode.id, 'reported_in');
        }

        const locationFile = finding.location?.file || finding.file || null;
        if (locationFile) {
          const relPath = normalizeRelPath(this.root, locationFile);
          const fileNode = this.addNode(nodeId('file', relPath), 'file', {
            label: relPath,
            path: relPath,
            metadata: { discoveredFrom: `${candidate.stage}-finding` },
          });
          this.addEdge(findingNode.id, fileNode.id, 'touches', {
            line: finding.location?.line || finding.line || null,
          });
        }
      }
    }
  }

  addBrownfieldEvidenceNodes() {
    if (!this.latestDir) return;
    const evidenceIndex = readJsonSafe(path.join(this.latestDir, 'brownfield', '19-evidence-index.json'));
    if (!evidenceIndex?.entries) return;

    for (const entry of evidenceIndex.entries) {
      const evidenceId = String(entry.artifact || '').trim();
      if (!evidenceId) continue;
      const evidenceNode = this.addNode(nodeId('evidence', evidenceId), 'evidence', {
        label: evidenceId,
        path: normalizeRelPath(this.root, entry.path || evidenceId),
        metadata: {
          source: entry.source || null,
          sourceType: entry.sourceType || null,
          phase: entry.phase || null,
          confidence: entry.confidence || null,
        },
      });

      if (entry.path) {
        const relPath = normalizeRelPath(this.root, entry.path);
        const docNode = this.addNode(nodeId('document', relPath), 'document', {
          label: relPath,
          path: relPath,
          metadata: { discoveredFrom: 'brownfield-evidence' },
        });
        this.addEdge(evidenceNode.id, docNode.id, 'stored_in');
      }
    }
  }

  build() {
    this.addCodeAndDocumentNodes();
    this.addPlanningNodes();
    this.addFindingNodes();
    this.addBrownfieldEvidenceNodes();

    const nodes = stableSortById([...this.nodes.values()]);
    const edges = this.edges.sort((a, b) => {
      const left = `${a.from}|${a.type}|${a.to}`;
      const right = `${b.from}|${b.type}|${b.to}`;
      return left.localeCompare(right);
    });

    const counts = {
      nodes: nodes.length,
      edges: edges.length,
      byType: {},
      byEdgeType: {},
    };

    for (const node of nodes) {
      counts.byType[node.type] = (counts.byType[node.type] || 0) + 1;
    }
    for (const edge of edges) {
      counts.byEdgeType[edge.type] = (counts.byEdgeType[edge.type] || 0) + 1;
    }

    return {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      root: this.root,
      latestDir: this.latestDir,
      warnings: this.warnings,
      counts,
      nodes,
      edges,
    };
  }
}

function degreeMap(graph) {
  const degrees = new Map();
  for (const node of graph.nodes || []) {
    degrees.set(node.id, { incoming: 0, outgoing: 0 });
  }
  for (const edge of graph.edges || []) {
    if (!degrees.has(edge.from)) degrees.set(edge.from, { incoming: 0, outgoing: 0 });
    if (!degrees.has(edge.to)) degrees.set(edge.to, { incoming: 0, outgoing: 0 });
    degrees.get(edge.from).outgoing += 1;
    degrees.get(edge.to).incoming += 1;
  }
  return degrees;
}

function buildKnowledgeGraphSummary(graph) {
  const degrees = degreeMap(graph);
  const nodes = graph.nodes || [];
  const byType = graph.counts?.byType || {};
  const requirements = nodes.filter((node) => node.type === 'requirement');
  const findings = nodes.filter((node) => node.type === 'finding');
  const milestones = nodes.filter((node) => node.type === 'milestone');
  const files = nodes.filter((node) => node.type === 'file');

  const requirementStatuses = {};
  for (const requirement of requirements) {
    const status = requirement.metadata?.status || 'unknown';
    requirementStatuses[status] = (requirementStatuses[status] || 0) + 1;
  }

  const findingStatuses = {};
  const findingSeverities = {};
  for (const finding of findings) {
    const status = finding.metadata?.status || 'unknown';
    const severity = finding.metadata?.severity || 'unknown';
    findingStatuses[status] = (findingStatuses[status] || 0) + 1;
    findingSeverities[severity] = (findingSeverities[severity] || 0) + 1;
  }

  const topFiles = files
    .map((file) => ({
      path: file.path,
      degree: (degrees.get(file.id)?.incoming || 0) + (degrees.get(file.id)?.outgoing || 0),
      metadata: file.metadata || {},
    }))
    .sort((a, b) => b.degree - a.degree || String(a.path).localeCompare(String(b.path)))
    .slice(0, 5);

  const milestoneSummary = milestones
    .map((milestone) => ({
      id: milestone.id.replace(/^milestone:/, ''),
      label: milestone.label,
      stories: (graph.edges || []).filter((edge) => edge.from === milestone.id && edge.type === 'contains_story')
        .length,
      requirements: (graph.edges || []).filter((edge) => edge.to === milestone.id && edge.type === 'planned_for')
        .length,
      findings: (graph.edges || []).filter((edge) => edge.to === milestone.id && edge.type === 'reported_in').length,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    generatedAt: new Date().toISOString(),
    graphGeneratedAt: graph.generatedAt,
    counts: graph.counts,
    byType,
    requirements: {
      total: requirements.length,
      byStatus: requirementStatuses,
    },
    findings: {
      total: findings.length,
      byStatus: findingStatuses,
      bySeverity: findingSeverities,
      openIds: compactList(
        findings
          .filter(
            (finding) =>
              !['verified', 'verified-resolved', 'resolved', 'fixed', 'done', 'closed'].includes(
                String(finding.metadata?.status || '').toLowerCase(),
              ),
          )
          .map((finding) => finding.id.replace(/^finding:/, '')),
        10,
      ),
    },
    milestones: milestoneSummary,
    topFiles,
  };
}

function formatKnowledgeGraphSummary(summary) {
  const milestoneText =
    summary.milestones.length > 0
      ? summary.milestones
          .map(
            (milestone) =>
              `${milestone.id}(${milestone.requirements} reqs, ${milestone.stories} stories, ${milestone.findings} findings)`,
          )
          .join(', ')
      : 'none';

  const topFilesText =
    summary.topFiles.length > 0 ? summary.topFiles.map((file) => `${file.path}(${file.degree})`).join(', ') : 'none';

  return [
    `- Graph nodes: ${summary.counts?.nodes || 0}, edges: ${summary.counts?.edges || 0}`,
    `- Core entities: requirements=${summary.byType.requirement || 0}, stories=${summary.byType.story || 0}, milestones=${summary.byType.milestone || 0}, findings=${summary.byType.finding || 0}`,
    `- Requirement statuses: ${
      Object.entries(summary.requirements.byStatus || {})
        .map(([status, count]) => `${status}=${count}`)
        .join(', ') || 'none'
    }`,
    `- Open findings: ${summary.findings.openIds.join(', ') || 'none'}`,
    `- Milestones: ${milestoneText}`,
    `- Most-connected files: ${topFilesText}`,
  ].join('\n');
}

function readKnowledgeGraph(root) {
  return readJsonSafe(graphPath(path.resolve(root || process.cwd())));
}

function ensureKnowledgeGraph(root, options = {}) {
  const resolvedRoot = path.resolve(root || process.cwd());
  try {
    requireEmbeddingIndex().ensureLocalChunkIndex(resolvedRoot, { force: options.force === true });
  } catch (err) {
    console.error('[cobolt-knowledge-graph] chunk index init failed:', err.message);
    /* Evidence navigation still works without the optional chunk sidecar. */
  }
  const existingGraph = options.force ? null : readKnowledgeGraph(resolvedRoot);
  const graph = existingGraph || new KnowledgeGraphBuilder(resolvedRoot).build();
  const summary = buildKnowledgeGraphSummary(graph);

  writeJsonAtomic(graphPath(resolvedRoot), graph);
  writeJsonAtomic(summaryPath(resolvedRoot), summary);

  return {
    graph,
    summary,
    warnings: graph.warnings || [],
    graphPath: graphPath(resolvedRoot),
    summaryPath: summaryPath(resolvedRoot),
  };
}

function queryKnowledgeGraph(root, query, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 20;
  const { graph } = ensureKnowledgeGraph(root, { force: options.force });
  const degrees = degreeMap(graph);
  const needle = String(query || '')
    .trim()
    .toLowerCase();

  const matches = (graph.nodes || [])
    .map((node) => {
      const searchable = [node.id, node.label, node.path, JSON.stringify(node.metadata || {})]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      let score = 0;
      if (needle && searchable.includes(needle)) score += 5;
      if (needle && String(node.id).toLowerCase() === needle) score += 10;
      if (needle && String(node.label || '').toLowerCase() === needle) score += 8;
      score += (degrees.get(node.id)?.incoming || 0) + (degrees.get(node.id)?.outgoing || 0);

      return { node, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || String(a.node.id).localeCompare(String(b.node.id)))
    .slice(0, limit)
    .map((entry) => ({
      ...entry,
      incoming: degrees.get(entry.node.id)?.incoming || 0,
      outgoing: degrees.get(entry.node.id)?.outgoing || 0,
    }));

  return {
    query,
    totalMatches: matches.length,
    matches,
  };
}

function explainKnowledgeNode(root, nodeLookup, options = {}) {
  const { graph } = ensureKnowledgeGraph(root, { force: options.force });
  const node = (graph.nodes || []).find((candidate) => candidate.id === nodeLookup || candidate.label === nodeLookup);
  if (!node) return null;

  return {
    node,
    incoming: (graph.edges || []).filter((edge) => edge.to === node.id),
    outgoing: (graph.edges || []).filter((edge) => edge.from === node.id),
  };
}

function tokenizeQuery(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function scoreNodeForEvidenceQuery(node, query, tokens) {
  const rawNeedle = String(query || '')
    .trim()
    .toLowerCase();
  const searchable = [node.id, node.label, node.path, JSON.stringify(node.metadata || {})]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  let score = 0;
  const reasons = [];

  if (rawNeedle && String(node.id).toLowerCase() === rawNeedle) {
    score += 60;
    reasons.push('exact id match');
  }
  if (rawNeedle && String(node.label || '').toLowerCase() === rawNeedle) {
    score += 45;
    reasons.push('exact label match');
  }
  if (rawNeedle && searchable.includes(rawNeedle)) {
    score += 25;
    reasons.push('phrase match');
  }

  const matchedTokens = tokens.filter((token) => searchable.includes(token));
  if (matchedTokens.length > 0) {
    score += matchedTokens.length * 6;
    reasons.push(`token match: ${matchedTokens.slice(0, 5).join(', ')}`);
  }

  if (score > 0 && ['requirement', 'finding', 'story', 'section'].includes(node.type)) score += 6;
  if (score > 0 && ['file', 'document'].includes(node.type)) score += 2;

  return { score, reasons };
}

const EVIDENCE_EDGE_PRIORITY = {
  implemented_by_file: 100,
  verified_by_test: 95,
  touches: 90,
  implemented_by_story: 85,
  planned_for: 80,
  reported_in: 80,
  documented_by: 75,
  contains_section: 70,
  mentions_requirement: 65,
  mentions_finding: 65,
  contains_story: 60,
  depends_on: 55,
  depends_on_story: 55,
  stored_in: 50,
  imports: 30,
  contains: 25,
};

function edgePriority(edge) {
  return EVIDENCE_EDGE_PRIORITY[edge.type] || 10;
}

function contextItemFromNode(node, options = {}) {
  const metadata = node.metadata || {};
  return {
    id: node.id,
    type: node.type,
    label: node.label,
    path: node.path || null,
    startLine: metadata.startLine || options.line || null,
    endLine: metadata.endLine || options.line || null,
    relation: options.relation || null,
    source: options.source || null,
    score: options.score || 0,
    why: options.why || null,
    metadata: {
      status: metadata.status || null,
      severity: metadata.severity || null,
      milestone: metadata.milestone || null,
      level: metadata.level || null,
      lineCount: metadata.lineCount || null,
    },
  };
}

function upsertContextItem(items, item) {
  const existing = items.get(item.id);
  if (!existing) {
    items.set(item.id, {
      ...item,
      relations: item.relation ? [item.relation] : [],
      why: item.why ? [item.why] : [],
    });
    return;
  }

  existing.score = Math.max(existing.score || 0, item.score || 0);
  if (!existing.startLine && item.startLine) existing.startLine = item.startLine;
  if (!existing.endLine && item.endLine) existing.endLine = item.endLine;
  if (item.relation && !existing.relations.includes(item.relation)) existing.relations.push(item.relation);
  if (item.why && !existing.why.includes(item.why)) existing.why.push(item.why);
}

function contextItemFromChunk(chunk, options = {}) {
  return {
    id: chunk.id,
    type: 'chunk',
    label: `${chunk.path}:${chunk.startLine}-${chunk.endLine}`,
    path: chunk.path || null,
    startLine: chunk.startLine || null,
    endLine: chunk.endLine || null,
    relation: options.relation || 'chunk_match',
    source: options.source || null,
    score: options.score || 0,
    why: options.why || null,
    snippet: String(chunk.text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 280),
    metadata: {
      extension: chunk.extension || null,
      charCount: chunk.charCount || null,
      lexicalScore: options.lexicalScore || null,
      semanticScore: options.semanticScore || null,
    },
  };
}

function scoreChunkLexically(chunk, query, tokens) {
  const rawNeedle = String(query || '')
    .trim()
    .toLowerCase();
  const searchable = [chunk.path, chunk.text].filter(Boolean).join(' ').toLowerCase();
  let score = 0;
  const reasons = [];

  if (rawNeedle && searchable.includes(rawNeedle)) {
    score += 40;
    reasons.push('chunk phrase match');
  }

  const matchedTokens = tokens.filter((token) => searchable.includes(token));
  if (matchedTokens.length > 0) {
    score += matchedTokens.length * 7;
    reasons.push(`chunk token match: ${matchedTokens.slice(0, 5).join(', ')}`);
  }

  return { score, reasons };
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || left.length !== right.length) return null;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i++) {
    const a = Number(left[i]);
    const b = Number(right[i]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }

  if (leftNorm === 0 || rightNorm === 0) return null;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function rankedChunkMatches(root, query, tokens, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 8;
  const chunks = requireEmbeddingIndex().readChunks(root);
  if (!Array.isArray(chunks) || chunks.length === 0) return [];

  const embeddingByChunk = new Map();
  if (Array.isArray(options.queryEmbedding) && options.queryEmbedding.length > 0) {
    for (const entry of requireEmbeddingIndex().readEmbeddings(root)) {
      if (Array.isArray(entry.embedding)) embeddingByChunk.set(entry.chunkId, entry.embedding);
    }
  }

  return chunks
    .map((chunk) => {
      const lexical = scoreChunkLexically(chunk, query, tokens);
      const similarity = embeddingByChunk.has(chunk.id)
        ? cosineSimilarity(options.queryEmbedding, embeddingByChunk.get(chunk.id))
        : null;
      const semanticScore = similarity == null ? 0 : Math.max(0, similarity) * 80;
      const score = lexical.score + semanticScore;
      const reasons = [...lexical.reasons];
      if (similarity != null) reasons.push(`embedding similarity: ${similarity.toFixed(4)}`);
      return { chunk, score, lexicalScore: lexical.score, semanticScore, similarity, reasons };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || String(a.chunk.id).localeCompare(String(b.chunk.id)))
    .slice(0, limit);
}

function graphNodeForPath(nodeById, relPath) {
  return nodeById.get(nodeId('file', relPath)) || nodeById.get(nodeId('document', relPath)) || null;
}

function addGraphNeighborsForNode(graph, nodeById, contextItems, sourceNode, sourceId, baseScore, limit) {
  if (!sourceNode) return;
  upsertContextItem(
    contextItems,
    contextItemFromNode(sourceNode, {
      relation: 'chunk_source',
      source: sourceId,
      score: baseScore,
      why: `${sourceId} -> chunk_source`,
    }),
  );

  const connectedEdges = (graph.edges || [])
    .filter((edge) => edge.from === sourceNode.id || edge.to === sourceNode.id)
    .sort((a, b) => edgePriority(b) - edgePriority(a));

  for (const edge of connectedEdges.slice(0, limit)) {
    const neighborId = edge.from === sourceNode.id ? edge.to : edge.from;
    const neighbor = nodeById.get(neighborId);
    if (!neighbor) continue;
    upsertContextItem(
      contextItems,
      contextItemFromNode(neighbor, {
        relation: edge.type,
        source: sourceId,
        line: edge.metadata?.line || null,
        score: Math.max(1, baseScore - 5 + edgePriority(edge)),
        why: `${sourceNode.id} ${edge.from === sourceNode.id ? '->' : '<-'} ${edge.type}`,
      }),
    );
  }
}

function retrieveEvidenceContext(root, query, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 12;
  const directLimit = Number.isFinite(options.directLimit) && options.directLimit > 0 ? options.directLimit : 6;
  const { graph } = ensureKnowledgeGraph(root, { force: options.force });
  const tokens = tokenizeQuery(query);
  const nodeById = new Map((graph.nodes || []).map((node) => [node.id, node]));
  const chunkLimit =
    Number.isFinite(options.chunkLimit) && options.chunkLimit > 0 ? options.chunkLimit : Math.min(limit, 8);

  const directMatches = (graph.nodes || [])
    .map((node) => {
      const scored = scoreNodeForEvidenceQuery(node, query, tokens);
      return { node, score: scored.score, reasons: scored.reasons };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || String(a.node.id).localeCompare(String(b.node.id)))
    .slice(0, directLimit);

  const contextItems = new Map();

  for (const match of directMatches) {
    upsertContextItem(
      contextItems,
      contextItemFromNode(match.node, {
        relation: 'direct_match',
        score: match.score,
        why: match.reasons.join('; ') || 'matched query',
      }),
    );

    const connectedEdges = (graph.edges || [])
      .filter((edge) => edge.from === match.node.id || edge.to === match.node.id)
      .sort((a, b) => edgePriority(b) - edgePriority(a));

    for (const edge of connectedEdges.slice(0, limit)) {
      const neighborId = edge.from === match.node.id ? edge.to : edge.from;
      const neighbor = nodeById.get(neighborId);
      if (!neighbor) continue;

      upsertContextItem(
        contextItems,
        contextItemFromNode(neighbor, {
          relation: edge.type,
          source: match.node.id,
          line: edge.metadata?.line || null,
          score: Math.max(1, match.score - 5 + edgePriority(edge)),
          why: `${match.node.id} ${edge.from === match.node.id ? '->' : '<-'} ${edge.type}`,
        }),
      );
    }
  }

  const chunkMatches = rankedChunkMatches(root, query, tokens, {
    limit: chunkLimit,
    queryEmbedding: options.queryEmbedding,
  });

  for (const match of chunkMatches) {
    const relation = match.semanticScore > 0 ? 'semantic_chunk_match' : 'chunk_match';
    upsertContextItem(
      contextItems,
      contextItemFromChunk(match.chunk, {
        relation,
        score: match.score,
        lexicalScore: match.lexicalScore,
        semanticScore: match.semanticScore,
        why: match.reasons.join('; ') || 'matched chunk text',
      }),
    );

    addGraphNeighborsForNode(
      graph,
      nodeById,
      contextItems,
      graphNodeForPath(nodeById, match.chunk.path),
      match.chunk.id,
      match.score,
      limit,
    );
  }

  const rankedContext = [...contextItems.values()]
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
    .slice(0, limit);

  const byType = {};
  for (const item of rankedContext) byType[item.type] = (byType[item.type] || 0) + 1;

  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    strategy: 'cobolt-pipeline-native-evidence-navigation',
    query,
    counts: {
      graphNodes: graph.counts?.nodes || 0,
      graphEdges: graph.counts?.edges || 0,
      directMatches: directMatches.length,
      chunkMatches: chunkMatches.length,
      semanticChunkMatches: chunkMatches.filter((match) => match.semanticScore > 0).length,
      contextItems: rankedContext.length,
      byType,
    },
    embeddingRetrieval: {
      status: Array.isArray(options.queryEmbedding) ? 'used' : 'not_used',
      reason: options.embeddingReason || null,
    },
    directMatches: directMatches.map((match) => ({
      id: match.node.id,
      type: match.node.type,
      label: match.node.label,
      path: match.node.path || null,
      score: match.score,
      reasons: match.reasons,
    })),
    contextItems: rankedContext,
    guidance: [
      'Read the cited paths and line ranges before editing.',
      'Prefer requirement, finding, story, and test evidence over broad document reads.',
      'If evidence is missing, update the source artifact or RTM rather than inventing context.',
    ],
  };
}

async function retrieveEvidenceContextAsync(root, query, options = {}) {
  const manifest = requireEmbeddingIndex().readEmbeddingIndex(root);
  let queryEmbedding = options.queryEmbedding || null;
  let embeddingReason = null;

  if (
    !queryEmbedding &&
    options.useEmbeddings !== false &&
    manifest?.embeddings?.status === 'generated' &&
    manifest.embeddings.count > 0
  ) {
    try {
      const payload = await requireEmbeddingIndex().requestEmbeddingBatch([String(query || '')], {
        ...options,
        model: options.model || manifest.embeddings.model,
      });
      queryEmbedding = payload.data?.[0]?.embedding || null;
      if (!queryEmbedding) embeddingReason = 'query embedding response was empty';
    } catch (err) {
      embeddingReason = err?.message || 'query embedding unavailable';
    }
  } else if (manifest?.embeddings?.status !== 'generated') {
    embeddingReason = 'local embeddings not generated';
  }

  return retrieveEvidenceContext(root, query, {
    ...options,
    queryEmbedding,
    embeddingReason,
  });
}

function evidenceContextPath(root) {
  return path.join(codeIndexDir(path.resolve(root || process.cwd())), 'evidence-context-latest.json');
}

function saveEvidenceContext(root, contextPack) {
  const filePath = evidenceContextPath(root);
  writeJsonAtomic(filePath, contextPack);
  return filePath;
}

function formatEvidenceContext(contextPack) {
  const lines = [
    `Evidence context for "${contextPack.query}"`,
    '',
    `Direct matches: ${contextPack.counts.directMatches}`,
    `Chunk matches: ${contextPack.counts.chunkMatches || 0}`,
    `Context items: ${contextPack.counts.contextItems}`,
    `Embeddings: ${contextPack.embeddingRetrieval?.status || 'not_used'}`,
    '',
  ];

  if (contextPack.directMatches.length > 0) {
    lines.push('Direct matches:');
    for (const match of contextPack.directMatches.slice(0, 6)) {
      lines.push(`  ${match.id} (${match.type}) ${match.path ? `path=${match.path}` : ''}`);
      if (match.reasons.length > 0) lines.push(`    ${match.reasons.join('; ')}`);
    }
    lines.push('');
  }

  lines.push('Context pack:');
  for (const item of contextPack.contextItems) {
    const location = item.path
      ? ` ${item.path}${item.startLine ? `:${item.startLine}${item.endLine && item.endLine !== item.startLine ? `-${item.endLine}` : ''}` : ''}`
      : '';
    lines.push(`  [${item.type}] ${item.id}${location}`);
    lines.push(`    ${item.label}`);
    if (item.snippet) lines.push(`    snippet=${item.snippet}`);
    if (item.relations.length > 0) lines.push(`    relations=${item.relations.join(', ')}`);
  }

  return lines.join('\n');
}

function printUsage() {
  console.log('CoBolt Knowledge Graph');
  console.log('');
  console.log('Usage: node tools/cobolt-knowledge-graph.js <command> [args]');
  console.log('');
  console.log('Commands:');
  console.log('  build [--force]         Build/update the typed graph');
  console.log('  stats                   Show graph counts');
  console.log('  query <term>            Search nodes by id, label, path, or metadata');
  console.log('  retrieve <query>        Build a traceable evidence context pack');
  console.log('  explain <node-id>       Show incoming and outgoing edges for one node');
  console.log('  summary                 Print a compact graph summary');
  console.log('');
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || '--help';
  const root = process.cwd();
  const force = args.includes('--force');
  const jsonMode = args.includes('--json');

  if (command === '--help' || command === '-h' || command === 'help') {
    printUsage();
    return;
  }

  if (command === 'build') {
    const result = ensureKnowledgeGraph(root, { force });
    if (jsonMode) {
      console.log(
        JSON.stringify(
          {
            graphPath: result.graphPath,
            summaryPath: result.summaryPath,
            counts: result.graph.counts,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log('Knowledge graph ready.');
    console.log(`  Nodes: ${result.graph.counts.nodes}`);
    console.log(`  Edges: ${result.graph.counts.edges}`);
    console.log(`  Graph: ${path.relative(root, result.graphPath)}`);
    console.log(`  Summary: ${path.relative(root, result.summaryPath)}`);
    return;
  }

  if (command === 'stats') {
    const { graph } = ensureKnowledgeGraph(root, { force });
    if (jsonMode) {
      console.log(JSON.stringify(graph.counts, null, 2));
      return;
    }

    console.log('Knowledge Graph Stats');
    console.log('');
    console.log(`  Nodes: ${graph.counts.nodes}`);
    console.log(`  Edges: ${graph.counts.edges}`);
    console.log(
      `  Types: ${Object.entries(graph.counts.byType)
        .map(([type, count]) => `${type}(${count})`)
        .join(', ')}`,
    );
    return;
  }

  if (command === 'query') {
    const query = args
      .filter((arg, index) => index > 0 && arg !== '--force' && arg !== '--json')
      .join(' ')
      .trim();
    if (!query) {
      console.error('Usage: node tools/cobolt-knowledge-graph.js query <term>');
      process.exit(1);
    }

    const result = queryKnowledgeGraph(root, query, { force });
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.matches.length === 0) {
      console.log(`No graph nodes matched "${query}".`);
      return;
    }

    console.log(`Graph matches for "${query}"`);
    console.log('');
    for (const match of result.matches) {
      console.log(`  ${match.node.id}`);
      console.log(`    ${match.node.label}`);
      console.log(`    type=${match.node.type} incoming=${match.incoming} outgoing=${match.outgoing}`);
      if (match.node.path) console.log(`    path=${match.node.path}`);
    }
    return;
  }

  if (command === 'retrieve') {
    const limitArg = args.indexOf('--limit');
    const limit =
      limitArg !== -1 && args[limitArg + 1] && Number.isFinite(Number(args[limitArg + 1]))
        ? Number(args[limitArg + 1])
        : 12;
    const query = args
      .filter(
        (arg, index) =>
          index > 0 &&
          arg !== '--force' &&
          arg !== '--json' &&
          arg !== '--save' &&
          arg !== '--limit' &&
          index !== limitArg + 1,
      )
      .join(' ')
      .trim();
    if (!query) {
      console.error('Usage: node tools/cobolt-knowledge-graph.js retrieve <query> [--limit N] [--save] [--json]');
      process.exit(1);
    }

    const contextPack = await retrieveEvidenceContextAsync(root, query, { force, limit });
    const savedPath = args.includes('--save') ? saveEvidenceContext(root, contextPack) : null;

    if (jsonMode) {
      console.log(JSON.stringify(savedPath ? { ...contextPack, savedPath } : contextPack, null, 2));
      return;
    }

    console.log(formatEvidenceContext(contextPack));
    if (savedPath) console.log(`\nSaved: ${path.relative(root, savedPath)}`);
    return;
  }

  if (command === 'explain') {
    const lookup = args
      .filter((arg, index) => index > 0 && arg !== '--force' && arg !== '--json')
      .join(' ')
      .trim();
    if (!lookup) {
      console.error('Usage: node tools/cobolt-knowledge-graph.js explain <node-id>');
      process.exit(1);
    }

    const explained = explainKnowledgeNode(root, lookup, { force });
    if (!explained) {
      console.error(`Node not found: ${lookup}`);
      process.exit(1);
    }

    if (jsonMode) {
      console.log(JSON.stringify(explained, null, 2));
      return;
    }

    console.log(explained.node.id);
    console.log(`  label: ${explained.node.label}`);
    console.log(`  type: ${explained.node.type}`);
    if (explained.node.path) console.log(`  path: ${explained.node.path}`);
    console.log('');
    console.log('  Incoming:');
    for (const edge of explained.incoming.slice(0, 20)) {
      console.log(`    ${edge.from} --${edge.type}--> ${edge.to}`);
    }
    console.log('  Outgoing:');
    for (const edge of explained.outgoing.slice(0, 20)) {
      console.log(`    ${edge.from} --${edge.type}--> ${edge.to}`);
    }
    return;
  }

  if (command === 'summary') {
    const result = ensureKnowledgeGraph(root, { force });
    if (jsonMode) {
      console.log(JSON.stringify(result.summary, null, 2));
      return;
    }

    console.log('Knowledge Graph Summary');
    console.log('');
    console.log(formatKnowledgeGraphSummary(result.summary));
    return;
  }

  printUsage();
}

module.exports = {
  KnowledgeGraphBuilder,
  buildKnowledgeGraphSummary,
  evidenceContextPath,
  ensureKnowledgeGraph,
  explainKnowledgeNode,
  formatEvidenceContext,
  formatKnowledgeGraphSummary,
  graphPath,
  queryKnowledgeGraph,
  readKnowledgeGraph,
  retrieveEvidenceContext,
  retrieveEvidenceContextAsync,
  saveEvidenceContext,
  summaryPath,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
