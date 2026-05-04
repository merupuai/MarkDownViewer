#!/usr/bin/env node

// CoBolt Doc Publisher — Canonical-to-human curator
//
// Publishes canonical artifacts from _cobolt-output/ into a human-readable
// view at docs/cobolt/. Never mutates canonical sources. Writes frontmatter
// with canonical pointer + sha for drift detection.
//
// Usage:
//   node tools/cobolt-publish-docs.js publish        [--pipeline=plan|brownfield|all] [--topic=<topic-id>] [--dry-run]
//   node tools/cobolt-publish-docs.js check          [--pipeline=plan|brownfield|all]
//   node tools/cobolt-publish-docs.js audit          [--pipeline=plan|brownfield|all] [--strict-orphans] [--json]
//   node tools/cobolt-publish-docs.js check-manifest
//   node tools/cobolt-publish-docs.js report
//   node tools/cobolt-publish-docs.js print-manifest
//
// Exit codes:
//   0  success (or drift/audit clean)
//   1  generic error
//   2  required artifact missing or undersized (publish)
//   3  drift detected (check) / audit violations present (audit)
//   4  manifest malformed OR lock file malformed
//   5  path-boundary violation (canonical escapes project root OR published escapes topic dir)
//
// Failure-contract emission: on any failure, writes
// _cobolt-output/audit/cobolt-publish-docs-failure.json following the
// canonical schema (escalation_target: review-lead, advisor_required: false
// until L1 escalates). Pipeline consumers read this file to route to
// review-lead, then recovery-advisor per the escalation protocol.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { atomicWrite } = require('../lib/cobolt-atomic-write');

const TOOL_NAME = 'cobolt-publish-docs';
const _MANIFEST_VERSION_SUPPORTED = '1.0.0';

// ── Path helpers ───────────────────────────────────────────────

function projectRoot() {
  return process.cwd();
}

function resolveWithin(root, rel) {
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(path.resolve(root))) {
    throw new Error(`Path escape: ${rel}`);
  }
  return abs;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteFile(target, content) {
  atomicWrite(target, content);
}

function readJson(fp) {
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function safeStat(fp) {
  try {
    return fs.statSync(fp);
  } catch {
    return null;
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ── Manifest resolution ────────────────────────────────────────

function findManifestPath() {
  const root = projectRoot();
  const candidates = [
    path.join(root, 'docs-publish.config.json'),
    path.join(root, '.cobolt', 'doc-publish-manifest.json'),
    path.join(root, '_cobolt-output', 'config', 'doc-publish-manifest.json'),
  ];
  for (const c of candidates) {
    if (safeStat(c)) return c;
  }
  const builtin = path.resolve(__dirname, '..', 'source', 'templates', 'doc-publish-manifest.json');
  if (safeStat(builtin)) return builtin;
  const deployed = path.resolve(__dirname, '..', 'templates', 'doc-publish-manifest.json');
  if (safeStat(deployed)) return deployed;
  return null;
}

function loadManifest() {
  const mp = findManifestPath();
  if (!mp) {
    return {
      manifest: null,
      path: null,
      error: 'Manifest not found. Place it at docs-publish.config.json or install defaults.',
    };
  }
  let manifest;
  try {
    manifest = readJson(mp);
  } catch (e) {
    return { manifest: null, path: mp, error: `Manifest JSON parse error: ${e.message}` };
  }
  if (!manifest.version) return { manifest: null, path: mp, error: 'Manifest missing version' };
  if (!manifest.pipelines) return { manifest: null, path: mp, error: 'Manifest missing pipelines' };
  return { manifest, path: mp, error: null };
}

// ── Failure contract ───────────────────────────────────────────

function writeFailure(record) {
  const root = projectRoot();
  const auditDir = path.join(root, '_cobolt-output', 'audit');
  ensureDir(auditDir);
  const target = path.join(auditDir, `${TOOL_NAME}-failure.json`);
  const full = {
    agent: TOOL_NAME,
    stage: record.stage || 'publish-docs',
    status: record.status || 'failed',
    error_class: record.error_class || 'other',
    error_message: record.error_message || '',
    failed_component: record.failed_component || 'tool',
    failed_tool: TOOL_NAME,
    command: record.command || '',
    exit_code: record.exit_code ?? null,
    stderr: record.stderr || '',
    stack: record.stack || '',
    missing_inputs: record.missing_inputs || [],
    expected_artifacts: record.expected_artifacts || [],
    artifacts_written: record.artifacts_written || [],
    files_touched: record.files_touched || [],
    coverage_gaps: record.coverage_gaps || [],
    recovery_attempts: record.recovery_attempts || [],
    blocked_by: record.blocked_by || [],
    remediation: record.remediation || '',
    escalation_target: record.escalation_target || 'review-lead',
    advisor_required: record.advisor_required === true,
    timestamp: new Date().toISOString(),
  };
  atomicWriteFile(target, `${JSON.stringify(full, null, 2)}\n`);
  return target;
}

// Clear stale failure file when a run succeeds. Keeps audit/ honest.
function clearFailure() {
  const root = projectRoot();
  const target = path.join(root, '_cobolt-output', 'audit', `${TOOL_NAME}-failure.json`);
  if (safeStat(target)) {
    try {
      fs.unlinkSync(target);
    } catch {
      // advisory
    }
  }
}

// ── Frontmatter injection ──────────────────────────────────────

function stripExistingCoboltFrontmatter(content) {
  if (!content.startsWith('---\n')) return { content, had: false };
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return { content, had: false };
  const head = content.slice(4, end);
  if (!/^cobolt_published:/m.test(head)) return { content, had: false };
  return { content: content.slice(end + 5), had: true };
}

function renderFrontmatter(meta) {
  const lines = ['---'];
  lines.push(`cobolt_published: true`);
  lines.push(`canonical: ${meta.canonical}`);
  lines.push(`pipeline: ${meta.pipeline}`);
  lines.push(`topic: ${meta.topic}`);
  lines.push(`title: ${JSON.stringify(meta.title)}`);
  if (meta.order) lines.push(`order: ${meta.order}`);
  if (meta.audiences?.length) {
    lines.push(`audiences: [${meta.audiences.map((a) => JSON.stringify(a)).join(', ')}]`);
  }
  lines.push(`source_sha256: ${meta.source_sha256}`);
  lines.push(`source_size: ${meta.source_size}`);
  lines.push(`published_at: ${meta.published_at}`);
  lines.push(`published_by: ${TOOL_NAME}`);
  lines.push('---');
  return `${lines.join('\n')}\n\n`;
}

// ── Binary / HTML / SVG header helpers ─────────────────────────

const BINARY_KINDS = new Set(['pdf', 'png', 'jpg', 'jpeg']);
const COMMENT_HEADER_KINDS = new Set(['html', 'svg']);

function renderHtmlCommentHeader(meta) {
  const lines = ['<!--'];
  lines.push('  cobolt_published: true');
  lines.push(`  canonical: ${meta.canonical}`);
  lines.push(`  pipeline: ${meta.pipeline}`);
  lines.push(`  topic: ${meta.topic}`);
  lines.push(`  title: ${meta.title}`);
  lines.push(`  source_sha256: ${meta.source_sha256}`);
  lines.push(`  source_size: ${meta.source_size}`);
  lines.push(`  published_at: ${meta.published_at}`);
  lines.push(`  published_by: ${TOOL_NAME}`);
  lines.push('-->\n');
  return lines.join('\n');
}

function stripExistingHtmlCoboltComment(content) {
  // Remove a leading <!-- cobolt_published ... --> comment if one already exists.
  // Survives re-publish (idempotent — no nested comments).
  const m = content.match(/^<!--\s*\n\s*cobolt_published:[\s\S]*?-->\s*\n?/);
  return m ? content.slice(m[0].length) : content;
}

function injectHtmlCommentHeader(buf, meta, kind) {
  const content = buf.toString('utf8');
  const stripped = stripExistingHtmlCoboltComment(content);
  const header = renderHtmlCommentHeader(meta);
  // For HTML, insert comment AFTER <!DOCTYPE...> if present so it remains valid.
  if (kind === 'html') {
    const doctypeMatch = stripped.match(/^(<!DOCTYPE[^>]*>\s*\n?)/i);
    if (doctypeMatch) {
      return doctypeMatch[0] + header + stripped.slice(doctypeMatch[0].length);
    }
  }
  // For SVG, insert AFTER <?xml ... ?> declaration if present.
  if (kind === 'svg') {
    const xmlMatch = stripped.match(/^(<\?xml[^?]*\?>\s*\n?)/);
    if (xmlMatch) {
      return xmlMatch[0] + header + stripped.slice(xmlMatch[0].length);
    }
  }
  return header + stripped;
}

// ── Artifact publishing ────────────────────────────────────────

function resolveCanonical(pipeline, artifactPath) {
  const root = projectRoot();
  const pipelineRoot = pipeline.canonicalRoot ? resolveWithin(root, pipeline.canonicalRoot) : root;
  const abs = path.resolve(pipelineRoot, artifactPath);
  // Path-boundary enforcement: canonical MUST stay within project root even after ../
  // traversal. Rejects rogue manifests that try to read outside the project.
  const projectAbs = path.resolve(root);
  if (!abs.startsWith(projectAbs + path.sep) && abs !== projectAbs) {
    const err = new Error(`canonical path escapes project root: ${artifactPath}`);
    err.code = 'PATH_BOUNDARY_VIOLATION';
    throw err;
  }
  return abs;
}

// Validate a published target path cannot escape its topic directory.
// Rejects absolute paths, paths containing .. segments, or Windows/Unix
// drive-absolute tricks. Never accept user-controlled path traversal into
// docs/cobolt/ namespace.
function validatePublishedPath(namespace, pipelineKey, topicId, publishedRel) {
  if (!publishedRel || typeof publishedRel !== 'string') {
    const err = new Error(`published path empty or not a string`);
    err.code = 'PATH_BOUNDARY_VIOLATION';
    throw err;
  }
  if (path.isAbsolute(publishedRel)) {
    const err = new Error(`published path must be relative, got absolute: ${publishedRel}`);
    err.code = 'PATH_BOUNDARY_VIOLATION';
    throw err;
  }
  const normalized = path.normalize(publishedRel).replace(/\\/g, '/');
  if (normalized.startsWith('../') || normalized === '..' || normalized.includes('/../')) {
    const err = new Error(`published path escapes topic directory: ${publishedRel}`);
    err.code = 'PATH_BOUNDARY_VIOLATION';
    throw err;
  }
  // Enforce that the resolved target stays within namespace/pipeline/topic/.
  const root = projectRoot();
  const topicDirAbs = path.resolve(root, namespace, pipelineKey, topicId);
  const targetAbs = path.resolve(topicDirAbs, publishedRel);
  if (!targetAbs.startsWith(topicDirAbs + path.sep) && targetAbs !== topicDirAbs) {
    const err = new Error(`published path escapes topic directory: ${publishedRel}`);
    err.code = 'PATH_BOUNDARY_VIOLATION';
    throw err;
  }
  return targetAbs;
}

function publishArtifact(ctx, pipelineKey, pipeline, topic, artifact) {
  const root = projectRoot();
  const namespace = ctx.manifest.namespace || 'docs/cobolt';
  const mode = artifact.mode || 'copy-with-frontmatter';
  const kind = artifact.kind || 'markdown';
  const minBytes = typeof artifact.minBytes === 'number' ? artifact.minBytes : 200;
  const results = [];

  if (mode === 'glob') {
    const pipelineRoot = pipeline.canonicalRoot ? resolveWithin(root, pipeline.canonicalRoot) : root;
    const globDir = path.dirname(path.resolve(pipelineRoot, artifact.globPattern || ''));
    const baseName = path.basename(artifact.globPattern || '');
    // Path-boundary: globDir MUST stay within project root even after ../.
    const projectAbs = path.resolve(root);
    if (!globDir.startsWith(projectAbs + path.sep) && globDir !== projectAbs) {
      const err = new Error(`glob dir escapes project root: ${artifact.globPattern}`);
      err.code = 'PATH_BOUNDARY_VIOLATION';
      throw err;
    }
    // Path-boundary: globTargetDir is user-supplied; validate it cannot
    // escape the topic folder.
    if (artifact.globTargetDir) {
      validatePublishedPath(namespace, pipelineKey, topic.id, artifact.globTargetDir);
    }
    if (!safeStat(globDir)) {
      return [
        {
          skipped: true,
          reason: `glob dir missing: ${path.relative(root, globDir)}`,
          artifact,
          required: artifact.required,
        },
      ];
    }
    const pattern = baseName.startsWith('*') ? baseName.slice(1) : baseName.replace(/^\*/, '');
    const entries = fs
      .readdirSync(globDir)
      .filter((name) => (pattern.startsWith('.') ? name.endsWith(pattern) : name.endsWith(pattern.replace(/^\*/, ''))))
      .filter((name) => !name.startsWith('.'));
    if (entries.length === 0) {
      return [{ skipped: true, reason: 'no glob matches', artifact, required: artifact.required }];
    }
    for (const entry of entries) {
      const canonicalAbs = path.join(globDir, entry);
      const publishedRel = path.join(artifact.globTargetDir || 'items', entry);
      // Path-boundary: per-entry validation — entry names from readdirSync are
      // normally safe, but if the manifest configured globTargetDir with ../
      // the join could escape. validatePublishedPath catches this.
      validatePublishedPath(namespace, pipelineKey, topic.id, publishedRel);
      results.push(
        publishOneFile({
          ctx,
          pipelineKey,
          pipeline,
          topic,
          artifact: { ...artifact, canonical: path.relative(root, canonicalAbs), published: publishedRel, minBytes },
          canonicalAbs,
          publishedRel,
          kind,
          namespace,
          // NOTE: downstream publishOneFile branches on `kind` first
          // (BINARY_KINDS / COMMENT_HEADER_KINDS), so a generic mode of
          // copy-with-frontmatter is effectively ignored for non-markdown
          // kinds (svg/png get comment-header; pdf/png get raw copy).
          mode: 'copy-with-frontmatter',
        }),
      );
    }
    return results;
  }

  const canonicalAbs = resolveCanonical(pipeline, artifact.canonical);
  const publishedRel = artifact.published || path.basename(artifact.canonical);
  validatePublishedPath(namespace, pipelineKey, topic.id, publishedRel);
  return [publishOneFile({ ctx, pipelineKey, topic, artifact, canonicalAbs, publishedRel, kind, namespace, mode })];
}

function publishOneFile({ ctx, pipelineKey, topic, artifact, canonicalAbs, publishedRel, kind, namespace, mode }) {
  const root = projectRoot();
  const st = safeStat(canonicalAbs);
  if (!st?.isFile()) {
    return {
      skipped: true,
      reason: 'canonical missing',
      canonical: path.relative(root, canonicalAbs),
      artifact,
      required: !!artifact.required,
    };
  }
  const minBytes = typeof artifact.minBytes === 'number' ? artifact.minBytes : 200;
  if (st.size < minBytes) {
    return {
      skipped: true,
      reason: `undersized ${st.size}<${minBytes}`,
      canonical: path.relative(root, canonicalAbs),
      artifact,
      required: !!artifact.required,
    };
  }
  const buf = fs.readFileSync(canonicalAbs);
  const hash = sha256(buf);
  const targetDir = path.join(root, namespace, pipelineKey, topic.id);
  const targetFile = path.join(targetDir, publishedRel);
  ensureDir(path.dirname(targetFile));

  const meta = {
    canonical: path.relative(root, canonicalAbs).replace(/\\/g, '/'),
    pipeline: pipelineKey,
    topic: topic.id,
    title: artifact.title,
    order: artifact.order || 0,
    audiences: topic.audiences || [],
    source_sha256: hash,
    source_size: st.size,
    published_at: ctx.publishedAt,
  };

  let outContent;
  // Binary kinds (pdf/png/jpg/jpeg) are pure copies — no header injection possible.
  if (BINARY_KINDS.has(kind) || mode === 'copy-raw') {
    outContent = buf;
  } else if (kind === 'markdown' && mode === 'copy-with-frontmatter') {
    const stripped = stripExistingCoboltFrontmatter(buf.toString('utf8'));
    const frontmatter = renderFrontmatter(meta);
    outContent = frontmatter + stripped.content;
  } else if (COMMENT_HEADER_KINDS.has(kind) || mode === 'copy-with-comment-header') {
    // html / svg — inject comment header preserving DOCTYPE / XML declaration ordering.
    outContent = injectHtmlCommentHeader(buf, meta, kind);
  } else {
    outContent = buf;
  }

  if (ctx.dryRun) {
    return {
      published: false,
      dryRun: true,
      canonical: path.relative(root, canonicalAbs).replace(/\\/g, '/'),
      target: path.relative(root, targetFile).replace(/\\/g, '/'),
      sha256: hash,
      size: st.size,
      title: artifact.title,
      topic: topic.id,
    };
  }

  atomicWriteFile(targetFile, outContent);
  return {
    published: true,
    canonical: path.relative(root, canonicalAbs).replace(/\\/g, '/'),
    target: path.relative(root, targetFile).replace(/\\/g, '/'),
    sha256: hash,
    size: st.size,
    title: artifact.title,
    topic: topic.id,
    order: artifact.order || 0,
  };
}

// ── README hub generation ──────────────────────────────────────

function renderTopicReadme(_pipelineKey, topic, publishedItems) {
  const lines = [];
  lines.push(`# ${topic.title}`);
  lines.push('');
  if (topic.description) {
    lines.push(topic.description);
    lines.push('');
  }
  if (topic.audiences?.length) {
    lines.push(`**Audiences:** ${topic.audiences.join(', ')}`);
    lines.push('');
  }
  const docs = publishedItems.filter((p) => p.published || p.dryRun);
  if (docs.length) {
    lines.push('## Documents');
    lines.push('');
    for (const d of docs.sort((a, b) => (a.order || 0) - (b.order || 0))) {
      const name = path.basename(d.target);
      lines.push(`- [${d.title}](./${name})`);
    }
    lines.push('');
  }
  const skipped = publishedItems.filter((p) => p.skipped);
  if (skipped.length) {
    lines.push('## Not yet published');
    lines.push('');
    for (const s of skipped) {
      lines.push(`- **${s.artifact.title || s.artifact.published || s.artifact.canonical}** — ${s.reason}`);
    }
    lines.push('');
  }
  lines.push(`_Topic published by \`${TOOL_NAME}\` — canonical sources live under \`_cobolt-output/\`._`);
  lines.push('');
  return lines.join('\n');
}

function renderPipelineReadme(pipelineKey, pipeline, topicSummaries) {
  const lines = [];
  lines.push(`# ${pipeline.title || pipelineKey}`);
  lines.push('');
  if (pipeline.description) {
    lines.push(pipeline.description);
    lines.push('');
  }
  if (pipeline.readme?.intro) {
    lines.push(pipeline.readme.intro);
    lines.push('');
  }
  lines.push('## Topics');
  lines.push('');
  for (const t of topicSummaries.sort((a, b) => a.order - b.order)) {
    const count = t.publishedCount;
    lines.push(`- [${t.title}](./${t.id}/) — ${count} document${count === 1 ? '' : 's'}`);
  }
  lines.push('');
  lines.push(
    `_Auto-published by \`${TOOL_NAME}\`. Canonical source: \`${pipeline.canonicalRoot || '(project root)'}\`._`,
  );
  lines.push('');
  return lines.join('\n');
}

function renderRootReadme(manifest, pipelineSummaries) {
  const lines = [];
  const readme = manifest.readme || {};
  lines.push(`# ${readme.title || 'CoBolt Project Documentation'}`);
  lines.push('');
  if (readme.intro) {
    lines.push(readme.intro);
    lines.push('');
  }
  if (readme.rolesTable?.length) {
    lines.push('## Reading Order by Role');
    lines.push('');
    lines.push('| Role | Start with | Then |');
    lines.push('| --- | --- | --- |');
    for (const r of readme.rolesTable) {
      const then = (r.then || []).map((t) => `[\`${t}\`](./${t})`).join(', ') || '—';
      lines.push(`| ${r.role} | [\`${r.startWith}\`](./${r.startWith}) | ${then} |`);
    }
    lines.push('');
  }
  lines.push('## Pipelines');
  lines.push('');
  for (const p of pipelineSummaries) {
    lines.push(`- [${p.title}](./${p.key}/) — ${p.topicCount} topics, ${p.publishedCount} documents`);
  }
  lines.push('');
  lines.push(`_Generated by \`${TOOL_NAME}\`. Canonical artifacts live under \`_cobolt-output/\`._`);
  lines.push('');
  return lines.join('\n');
}

// ── Commands ───────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) args[a.slice(2, eq)] = a.slice(eq + 1);
      else args[a.slice(2)] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function cmdPublish(opts) {
  const { manifest, path: manifestPath, error } = loadManifest();
  if (!manifest) {
    writeFailure({
      error_class: 'missing-input',
      error_message: error,
      stage: 'publish:load-manifest',
      missing_inputs: [manifestPath || 'doc-publish-manifest.json'],
      remediation: 'Install CoBolt defaults or provide docs-publish.config.json at project root.',
    });
    process.stderr.write(`[${TOOL_NAME}] manifest error: ${error}\n`);
    return 4;
  }

  const selectedPipelines =
    !opts.pipeline || opts.pipeline === 'all'
      ? Object.keys(manifest.pipelines)
      : String(opts.pipeline)
          .split(',')
          .map((s) => s.trim());

  const publishedAt = new Date().toISOString();
  const ctx = { manifest, publishedAt, dryRun: !!opts['dry-run'] || !!opts.dryRun };
  const topicFilter = opts.topic
    ? new Set(
        String(opts.topic)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;
  const report = {
    tool: TOOL_NAME,
    manifestPath: path.relative(projectRoot(), manifestPath).replace(/\\/g, '/'),
    publishedAt,
    dryRun: ctx.dryRun,
    namespace: manifest.namespace || 'docs/cobolt',
    pipelines: {},
    summary: { publishedCount: 0, skippedCount: 0, missingRequired: 0, missingOptional: 0, topics: 0 },
  };

  const pipelineSummaries = [];

  for (const pipelineKey of selectedPipelines) {
    const pipeline = manifest.pipelines[pipelineKey];
    if (!pipeline) continue;
    const pipelineReport = { title: pipeline.title || pipelineKey, topics: [] };
    let publishedCount = 0;
    let skippedCount = 0;
    let missingRequired = 0;
    let missingOptional = 0;

    for (const topic of pipeline.topics) {
      if (topicFilter && !topicFilter.has(topic.id)) continue;
      const topicItems = [];
      for (const artifact of topic.artifacts) {
        const results = publishArtifact(ctx, pipelineKey, pipeline, topic, artifact);
        for (const r of results) {
          topicItems.push(r);
          if (r.published || r.dryRun) publishedCount++;
          if (r.skipped) {
            skippedCount++;
            if (r.required) missingRequired++;
            else missingOptional++;
          }
        }
      }

      const topicDir = path.join(projectRoot(), manifest.namespace || 'docs/cobolt', pipelineKey, topic.id);
      if (!ctx.dryRun) {
        ensureDir(topicDir);
        atomicWriteFile(path.join(topicDir, 'README.md'), renderTopicReadme(pipelineKey, topic, topicItems));
      }

      pipelineReport.topics.push({
        id: topic.id,
        order: topic.order,
        title: topic.title,
        publishedCount: topicItems.filter((i) => i.published || i.dryRun).length,
        items: topicItems.map((i) => ({
          title: i.title || i.artifact?.title,
          canonical: i.canonical,
          target: i.target,
          size: i.size,
          sha256: i.sha256,
          skipped: !!i.skipped,
          reason: i.reason,
          required: i.required ?? i.artifact?.required ?? false,
        })),
      });
      report.summary.topics++;
    }

    const topicSummaries = pipelineReport.topics.map((t) => ({
      id: t.id,
      order: t.order,
      title: t.title,
      publishedCount: t.publishedCount,
    }));

    const pipelineDir = path.join(projectRoot(), manifest.namespace || 'docs/cobolt', pipelineKey);
    if (!ctx.dryRun) {
      ensureDir(pipelineDir);
      atomicWriteFile(path.join(pipelineDir, 'README.md'), renderPipelineReadme(pipelineKey, pipeline, topicSummaries));
    }

    pipelineReport.summary = { publishedCount, skippedCount, missingRequired, missingOptional };
    report.pipelines[pipelineKey] = pipelineReport;
    report.summary.publishedCount += publishedCount;
    report.summary.skippedCount += skippedCount;
    report.summary.missingRequired += missingRequired;
    report.summary.missingOptional += missingOptional;

    pipelineSummaries.push({
      key: pipelineKey,
      title: pipeline.title || pipelineKey,
      topicCount: topicSummaries.length,
      publishedCount,
    });
  }

  const nsDir = path.join(projectRoot(), manifest.namespace || 'docs/cobolt');
  if (!ctx.dryRun) {
    ensureDir(nsDir);
    atomicWriteFile(path.join(nsDir, 'README.md'), renderRootReadme(manifest, pipelineSummaries));
  }

  // Write lock file (drift detection source of truth)
  const lock = {
    version: '1.0.0',
    generatedBy: TOOL_NAME,
    generatedAt: publishedAt,
    manifestVersion: manifest.version,
    entries: {},
  };
  for (const [pk, pr] of Object.entries(report.pipelines)) {
    for (const t of pr.topics) {
      for (const i of t.items) {
        if (!i.canonical || i.skipped) continue;
        lock.entries[i.canonical] = {
          target: i.target,
          sha256: i.sha256,
          size: i.size,
          pipeline: pk,
          topic: t.id,
          publishedAt,
        };
      }
    }
  }

  const reportDir = path.join(projectRoot(), '_cobolt-output', 'latest', 'publish');
  if (!ctx.dryRun) {
    ensureDir(reportDir);
    atomicWriteFile(path.join(reportDir, 'publish-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    atomicWriteFile(path.join(reportDir, 'publish-manifest.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  }

  if (report.summary.missingRequired > 0) {
    writeFailure({
      error_class: 'missing-input',
      error_message: `${report.summary.missingRequired} required canonical artifact(s) missing or undersized`,
      stage: 'publish:canonical-coverage',
      missing_inputs: Object.values(report.pipelines).flatMap((pr) =>
        pr.topics.flatMap((t) => t.items.filter((i) => i.skipped && i.required).map((i) => i.canonical || i.title)),
      ),
      remediation:
        'Run the upstream planning or brownfield stage to produce the missing artifact, or update the manifest to mark it optional.',
      escalation_target: 'review-lead',
      advisor_required: false,
    });
    process.stderr.write(
      `[${TOOL_NAME}] ${report.summary.missingRequired} required artifact(s) missing; failure.json written\n`,
    );
    // Exit 2 below propagates the signal. Skills wrap this call in Tier 3
    // advisory shell (printing the failure.json breadcrumb without aborting
    // the pipeline) rather than `|| true`, so consumers see the drift
    // without the pipeline hard-blocking. See cobolt-plan Step 35b.
  } else {
    clearFailure();
  }

  if (!ctx.dryRun) {
    process.stdout.write(
      `${TOOL_NAME}: published=${report.summary.publishedCount} skipped=${report.summary.skippedCount} (required_missing=${report.summary.missingRequired}) → ${manifest.namespace}/\n`,
    );
  } else {
    process.stdout.write(
      `${TOOL_NAME} (dry-run): would publish=${report.summary.publishedCount} skipped=${report.summary.skippedCount}\n`,
    );
  }
  return report.summary.missingRequired > 0 ? 2 : 0;
}

function cmdCheck(opts = {}) {
  const root = projectRoot();
  const lockPath = path.join(root, '_cobolt-output', 'latest', 'publish', 'publish-manifest.lock.json');
  const st = safeStat(lockPath);
  if (!st) {
    process.stdout.write(`${TOOL_NAME}: no lock file — run \`publish\` first\n`);
    return 0;
  }
  let lock;
  try {
    lock = readJson(lockPath);
  } catch (e) {
    writeFailure({
      error_class: 'schema-failure',
      error_message: `publish-manifest.lock.json is malformed: ${e.message}`,
      stage: 'check:parse-lock',
      missing_inputs: [path.relative(root, lockPath)],
      remediation: 'Delete the corrupt lock and re-run publish.',
    });
    process.stderr.write(`[${TOOL_NAME}] check: lock file malformed: ${e.message}\n`);
    return 4;
  }
  if (!lock.entries || typeof lock.entries !== 'object') {
    writeFailure({
      error_class: 'schema-failure',
      error_message: 'publish-manifest.lock.json has no entries object',
      stage: 'check:parse-lock',
      missing_inputs: [path.relative(root, lockPath)],
      remediation: 'Delete the corrupt lock and re-run publish.',
    });
    return 4;
  }
  const pipelineFilter = !opts.pipeline || opts.pipeline === 'all' ? null : String(opts.pipeline).trim();
  const drift = [];
  let checkedCount = 0;
  for (const [canonical, entry] of Object.entries(lock.entries)) {
    if (pipelineFilter && entry.pipeline !== pipelineFilter) continue;
    checkedCount++;
    const abs = path.resolve(root, canonical);
    const cst = safeStat(abs);
    if (!cst) {
      drift.push({ canonical, reason: 'canonical disappeared' });
      continue;
    }
    const buf = fs.readFileSync(abs);
    const currentSha = sha256(buf);
    if (currentSha !== entry.sha256) {
      drift.push({
        canonical,
        reason: 'sha256 mismatch',
        was: entry.sha256.slice(0, 12),
        now: currentSha.slice(0, 12),
      });
    }
  }
  if (drift.length === 0) {
    process.stdout.write(
      `${TOOL_NAME}: no drift (${checkedCount} artifacts in sync${pipelineFilter ? ` for pipeline=${pipelineFilter}` : ''})\n`,
    );
    clearFailure();
    return 0;
  }
  // Drift = durable signal. Consumers rely on failure.json to route to review-lead.
  writeFailure({
    error_class: 'verification-gap',
    error_message: `publish-docs drift detected — ${drift.length} canonical artifact(s) out of sync with published copies`,
    stage: 'check:drift',
    coverage_gaps: drift.map((d) => `${d.canonical}: ${d.reason}`),
    remediation: 'Run `node tools/cobolt-publish-docs.js publish` to refresh the published view from canonical.',
    escalation_target: 'review-lead',
    advisor_required: false,
  });
  process.stdout.write(
    `${TOOL_NAME}: DRIFT DETECTED — ${drift.length} artifact(s) out of sync with published copies\n`,
  );
  for (const d of drift.slice(0, 10)) {
    process.stdout.write(`  - ${d.canonical}: ${d.reason}${d.was ? ` (was ${d.was} now ${d.now})` : ''}\n`);
  }
  if (drift.length > 10) process.stdout.write(`  ... and ${drift.length - 10} more\n`);
  process.stdout.write(`\nRun \`node tools/cobolt-publish-docs.js publish\` to re-publish.\n`);
  return 3;
}

// ── Audit sub-command ─────────────────────────────────────────
//
// Post-publish quality gate. Runs AFTER `publish` to census the published
// tree — frontmatter presence on every markdown, comment-header on every
// html/svg, byte-identity of binary pdf/png, orphan detection, stub content.
//
// Emits structured JSON and failure contract on violations. Exit 3 on any
// violation so CI gates can enforce.

const REQUIRED_MARKDOWN_FRONTMATTER_KEYS = [
  'cobolt_published',
  'canonical',
  'source_sha256',
  'pipeline',
  'topic',
  'published_at',
];

const REQUIRED_COMMENT_HEADER_KEYS = REQUIRED_MARKDOWN_FRONTMATTER_KEYS;

function parseFrontmatter(content) {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return null;
  // Require the closing delimiter to be on its OWN line: `\n---\n` or `\n---\r\n` or `\n---` at EOF.
  // Using `content.indexOf('\n---', 3)` alone false-positives on body text like `\n---text`.
  const endRegex = /\n---(?:\r?\n|$)/;
  const m = endRegex.exec(content.slice(3));
  if (!m) return null;
  const end = 3 + m.index;
  const head = content.slice(3, end).replace(/\r/g, '');
  const keys = {};
  for (const line of head.split('\n')) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) keys[match[1]] = match[2];
  }
  return keys;
}

function parseHtmlCoboltComment(content) {
  // Look for a <!-- cobolt_published: true ... --> comment anywhere in the
  // first 8KB of the file. 8KB (up from 2KB) survives large DOCTYPE +
  // prepended-script scenarios before our comment header is reached.
  const head = content.slice(0, 8192);
  const m = head.match(/<!--\s*\n?\s*cobolt_published:\s*true([\s\S]*?)-->/);
  if (!m) return null;
  const keys = { cobolt_published: 'true' };
  for (const line of m[1].split('\n')) {
    const km = line.match(/^\s*(\w+):\s*(.*)$/);
    if (km) keys[km[1]] = km[2].trim();
  }
  return keys;
}

function collectPublishedFiles(nsDir, opts = {}) {
  const pipelineFilter = opts.pipelineFilter || null; // e.g. 'plan' — only walk ns/plan/**
  const results = [];
  if (!safeStat(nsDir)) return results;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // Skip dot-entries (.DS_Store, .gitkeep, .git dirs) — they are never
      // published artifacts and show up as spurious orphans in audit.
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        results.push(abs);
      }
    }
  };
  if (pipelineFilter) {
    const pipelineDir = path.join(nsDir, pipelineFilter);
    if (safeStat(pipelineDir)) walk(pipelineDir);
  } else {
    walk(nsDir);
  }
  return results;
}

function cmdAudit(opts) {
  const root = projectRoot();
  const { manifest, path: manifestPath, error } = loadManifest();
  if (!manifest) {
    writeFailure({
      error_class: 'missing-input',
      error_message: error,
      stage: 'audit:load-manifest',
      missing_inputs: [manifestPath || 'doc-publish-manifest.json'],
      remediation: 'Install CoBolt defaults or provide docs-publish.config.json at project root.',
    });
    process.stderr.write(`[${TOOL_NAME}] audit: manifest error: ${error}\n`);
    return 4;
  }

  const nsDir = path.join(root, manifest.namespace || 'docs/cobolt');
  if (!safeStat(nsDir)) {
    process.stdout.write(`${TOOL_NAME}: no published tree at ${path.relative(root, nsDir)}. Run \`publish\` first.\n`);
    return 0;
  }

  const lockPath = path.join(root, '_cobolt-output', 'latest', 'publish', 'publish-manifest.lock.json');
  if (!safeStat(lockPath)) {
    writeFailure({
      error_class: 'missing-input',
      error_message: 'publish-manifest.lock.json absent — audit needs a prior publish run',
      stage: 'audit:load-lock',
      missing_inputs: [path.relative(root, lockPath)],
      remediation: 'Run `publish` before audit.',
    });
    process.stderr.write(`[${TOOL_NAME}] audit: lock file missing\n`);
    return 3;
  }
  let lock;
  try {
    lock = readJson(lockPath);
  } catch (e) {
    writeFailure({
      error_class: 'schema-failure',
      error_message: `publish-manifest.lock.json is malformed: ${e.message}`,
      stage: 'audit:parse-lock',
      missing_inputs: [path.relative(root, lockPath)],
      remediation: 'Delete the corrupt lock and re-run publish.',
    });
    process.stderr.write(`[${TOOL_NAME}] audit: lock file malformed: ${e.message}\n`);
    return 4;
  }
  if (!lock.entries || typeof lock.entries !== 'object') {
    writeFailure({
      error_class: 'schema-failure',
      error_message: 'publish-manifest.lock.json has no entries object',
      stage: 'audit:parse-lock',
      missing_inputs: [path.relative(root, lockPath)],
      remediation: 'Delete the corrupt lock and re-run publish.',
    });
    return 4;
  }
  const lockByTarget = {};
  for (const [canonical, entry] of Object.entries(lock.entries)) {
    const targetRel = entry.target.replace(/\\/g, '/');
    lockByTarget[targetRel] = { canonical, ...entry };
  }
  // --pipeline filter: when set, restrict both walk + lock-matching to the
  // chosen pipeline so users can audit plan without brownfield noise.
  const pipelineFilter = !opts.pipeline || opts.pipeline === 'all' ? null : String(opts.pipeline).trim();

  const report = {
    tool: TOOL_NAME,
    stage: 'audit',
    auditedAt: new Date().toISOString(),
    namespace: manifest.namespace || 'docs/cobolt',
    verdict: 'ship',
    census: {
      markdownExpected: 0,
      markdownPresent: 0,
      markdownWithValidFrontmatter: 0,
      htmlExpected: 0,
      htmlWithCommentHeader: 0,
      svgExpected: 0,
      svgWithCommentHeader: 0,
      binaryExpected: 0,
      binaryByteIdentical: 0,
      lockEntries: Object.keys(lock.entries || {}).length,
      orphans: [],
      stubs: [],
    },
    violations: [],
  };

  const violate = (violation) => {
    report.violations.push(violation);
    if (violation.severity === 'high' || violation.severity === 'critical') report.verdict = 'block';
    else if (violation.severity === 'medium' && report.verdict === 'ship') report.verdict = 'hold';
  };

  // Iterate every published file under docs/cobolt/ and classify by extension.
  const publishedFiles = collectPublishedFiles(nsDir, { pipelineFilter });
  const seenLockTargets = new Set();

  // When filtering by pipeline, only consider lock entries for that pipeline.
  const relevantLockTargets = pipelineFilter
    ? new Set(
        Object.entries(lockByTarget)
          .filter(([, entry]) => entry.pipeline === pipelineFilter)
          .map(([target]) => target),
      )
    : new Set(Object.keys(lockByTarget));

  for (const abs of publishedFiles) {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    const basename = path.basename(abs);
    // Skip the generated hub READMEs — they're indexes, not canonical-backed docs.
    if (basename === 'README.md') continue;

    const ext = path.extname(abs).toLowerCase();
    const lockEntry = lockByTarget[rel];

    if (lockEntry) {
      // When filtering to a single pipeline, ignore files that belong to a different pipeline.
      if (pipelineFilter && lockEntry.pipeline !== pipelineFilter) continue;
      seenLockTargets.add(rel);
    } else {
      // Orphan: file in published tree but NOT in the lock.
      report.census.orphans.push(rel);
      const severity = opts['strict-orphans'] ? 'high' : 'low';
      violate({
        path: rel,
        class: 'orphan',
        severity,
        detail: `file exists under docs/cobolt/ but no entry in publish-manifest.lock.json`,
        remediation: `Re-run \`publish\` to refresh the lock, or delete ${rel} if the manifest no longer includes it.`,
      });
      continue; // no further checks — orphan can't be validated against lock
    }

    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch (e) {
      violate({
        path: rel,
        class: 'tool-failure',
        severity: 'high',
        detail: `read failed: ${e.message}`,
        remediation: 'Investigate filesystem permission / corruption.',
      });
      continue;
    }

    if (ext === '.md') {
      report.census.markdownExpected++;
      report.census.markdownPresent++;
      const fm = parseFrontmatter(buf.toString('utf8'));
      const bodyLines = buf
        .toString('utf8')
        .split(/\r?\n/)
        .filter((line, i) => i > 0 && !line.startsWith('---') && line.trim().length > 0);
      if (!fm) {
        violate({
          path: rel,
          class: 'missing-frontmatter',
          severity: 'high',
          detail: 'file does not begin with `---` / no closing `---` found',
          remediation: 'Re-run publish to regenerate with frontmatter.',
        });
        continue;
      }
      const missing = REQUIRED_MARKDOWN_FRONTMATTER_KEYS.filter((k) => !(k in fm));
      if (missing.length) {
        violate({
          path: rel,
          class: 'missing-frontmatter',
          severity: 'high',
          detail: `frontmatter present but missing keys: ${missing.join(', ')}`,
          remediation: 'Re-run publish to regenerate with complete frontmatter.',
        });
        continue;
      }
      report.census.markdownWithValidFrontmatter++;
      // Stub detection: fewer than 3 non-blank body lines after frontmatter.
      if (bodyLines.length < 3) {
        report.census.stubs.push(rel);
        violate({
          path: rel,
          class: 'stub-content',
          severity: 'medium',
          detail: `${bodyLines.length} non-blank body line(s) after frontmatter — likely stub`,
          remediation: 'Upstream producer skill should regenerate canonical content.',
        });
      }
    } else if (ext === '.html') {
      report.census.htmlExpected++;
      const fm = parseHtmlCoboltComment(buf.toString('utf8'));
      if (!fm) {
        violate({
          path: rel,
          class: 'missing-comment-header',
          severity: 'high',
          detail: 'HTML missing <!-- cobolt_published: true ... --> comment header',
          remediation: 'Re-run publish with kind=html, mode=copy-with-comment-header.',
        });
        continue;
      }
      const missing = REQUIRED_COMMENT_HEADER_KEYS.filter((k) => !(k in fm));
      if (missing.length) {
        violate({
          path: rel,
          class: 'missing-comment-header',
          severity: 'high',
          detail: `comment header present but missing keys: ${missing.join(', ')}`,
          remediation: 'Re-run publish to regenerate complete comment header.',
        });
        continue;
      }
      report.census.htmlWithCommentHeader++;
    } else if (ext === '.svg') {
      report.census.svgExpected++;
      const fm = parseHtmlCoboltComment(buf.toString('utf8'));
      if (!fm) {
        violate({
          path: rel,
          class: 'missing-comment-header',
          severity: 'medium',
          detail: 'SVG missing <!-- cobolt_published: true ... --> comment header',
          remediation: 'Re-run publish with kind=svg, mode=copy-with-comment-header.',
        });
        continue;
      }
      report.census.svgWithCommentHeader++;
    } else if (ext === '.pdf' || ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
      report.census.binaryExpected++;
      const published_sha = sha256(buf);
      if (published_sha !== lockEntry.sha256) {
        violate({
          path: rel,
          class: 'sha-mismatch',
          severity: 'critical',
          detail: `published sha256 (${published_sha.slice(0, 12)}) != lock sha256 (${String(lockEntry.sha256).slice(0, 12)})`,
          remediation: 'Binary file was modified after publish. Re-run publish to restore byte-identity.',
        });
        continue;
      }
      // Also verify against canonical source.
      const canonicalAbs = path.resolve(root, lockEntry.canonical);
      if (safeStat(canonicalAbs)) {
        const canonical_sha = sha256(fs.readFileSync(canonicalAbs));
        if (canonical_sha !== published_sha) {
          violate({
            path: rel,
            class: 'sha-mismatch',
            severity: 'critical',
            detail: `published sha ≠ canonical sha — canonical has drifted since publish`,
            remediation: 'Re-run publish to refresh from canonical.',
          });
          continue;
        }
      }
      report.census.binaryByteIdentical++;
    }

    // Canonical-pointer resolution check (for markdown / html / svg with frontmatter).
    if (lockEntry?.canonical) {
      const canonicalAbs = path.resolve(root, lockEntry.canonical);
      if (!safeStat(canonicalAbs)) {
        violate({
          path: rel,
          class: 'broken-canonical-pointer',
          severity: 'high',
          detail: `canonical file ${lockEntry.canonical} does not exist on disk`,
          remediation: 'Either restore the canonical source or remove/re-publish this entry.',
        });
      }
    }
  }

  // Orphan detection in the OTHER direction: lock entries whose target file is missing.
  // Restricted to the pipeline under audit when --pipeline is set.
  for (const targetRel of relevantLockTargets) {
    if (!seenLockTargets.has(targetRel)) {
      violate({
        path: targetRel,
        class: 'missing-published-file',
        severity: 'high',
        detail: `lock references ${targetRel} but the file is absent under docs/cobolt/`,
        remediation: `Re-run \`publish\` — someone may have deleted a published file manually.`,
      });
    }
  }

  const byClass = {};
  const bySeverity = {};
  for (const v of report.violations) {
    byClass[v.class] = (byClass[v.class] || 0) + 1;
    bySeverity[v.severity] = (bySeverity[v.severity] || 0) + 1;
  }
  report.summary = {
    violationCount: report.violations.length,
    byClass,
    bySeverity,
  };

  const outDir = path.join(root, '_cobolt-output', 'latest', 'publish');
  ensureDir(outDir);
  atomicWriteFile(path.join(outDir, 'publish-audit.json'), `${JSON.stringify(report, null, 2)}\n`);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const { census, summary, verdict } = report;
    process.stdout.write(`${TOOL_NAME} audit: verdict=${verdict} violations=${summary.violationCount}\n`);
    process.stdout.write(
      `  markdown: ${census.markdownWithValidFrontmatter}/${census.markdownExpected} valid | html: ${census.htmlWithCommentHeader}/${census.htmlExpected} | svg: ${census.svgWithCommentHeader}/${census.svgExpected} | binaries: ${census.binaryByteIdentical}/${census.binaryExpected} identical\n`,
    );
    process.stdout.write(`  orphans: ${census.orphans.length} | stubs: ${census.stubs.length}\n`);
    for (const v of report.violations.slice(0, 10)) {
      process.stdout.write(`  [${v.severity}] ${v.path}: ${v.class} — ${v.detail}\n`);
    }
    if (report.violations.length > 10) process.stdout.write(`  ... and ${report.violations.length - 10} more\n`);
  }

  if (report.verdict !== 'ship') {
    writeFailure({
      error_class: 'verification-gap',
      error_message: `publish-docs audit verdict=${report.verdict} with ${report.summary.violationCount} violation(s)`,
      stage: 'audit:census',
      expected_artifacts: [path.relative(root, path.join(outDir, 'publish-audit.json'))],
      coverage_gaps: report.violations.map((v) => `${v.path}: ${v.class}`),
      remediation: 'Review publish-audit.json and re-publish or escalate to review-lead.',
      escalation_target: 'review-lead',
      advisor_required: false,
    });
    return 3;
  }
  clearFailure();
  return 0;
}

// ── Check-manifest sub-command ─────────────────────────────────
//
// Self-validates the active manifest against the schema constraints without
// requiring an external JSON-schema library. Catches common authoring mistakes
// BEFORE they cause silent publish failures (duplicate topic IDs, duplicate
// published filenames within a topic, missing required keys, invalid kind/mode).

function cmdCheckManifest() {
  const { manifest, path: mp, error } = loadManifest();
  if (!manifest) {
    writeFailure({
      error_class: 'schema-failure',
      error_message: error,
      stage: 'check-manifest:load',
      missing_inputs: [mp || 'doc-publish-manifest.json'],
      remediation: 'Fix the manifest or restore defaults.',
    });
    process.stderr.write(`[${TOOL_NAME}] ${error}\n`);
    return 4;
  }

  const problems = [];
  const problem = (p) => problems.push(p);

  if (!manifest.version) problem('manifest.version missing');
  if (!manifest.namespace) problem('manifest.namespace missing (default: docs/cobolt)');
  if (!manifest.pipelines || typeof manifest.pipelines !== 'object') {
    problem('manifest.pipelines missing or not an object');
  }

  const validKinds = new Set(['markdown', 'json', 'yaml', 'html', 'pdf', 'svg', 'png', 'jpg', 'jpeg']);
  const validModes = new Set(['copy-with-frontmatter', 'copy-raw', 'copy-with-comment-header', 'glob']);

  for (const [pipeKey, pipe] of Object.entries(manifest.pipelines || {})) {
    if (!pipe.title) problem(`pipelines.${pipeKey}.title missing`);
    if (!Array.isArray(pipe.topics) || pipe.topics.length === 0) {
      problem(`pipelines.${pipeKey}.topics must be a non-empty array`);
      continue;
    }
    const seenTopicIds = new Set();
    for (const topic of pipe.topics) {
      if (!topic.id) {
        problem(`pipelines.${pipeKey}.topics[] missing id`);
        continue;
      }
      if (!/^\d{2}-[a-z0-9-]+$/.test(topic.id)) {
        problem(`pipelines.${pipeKey}.${topic.id}: id must match /^\\d{2}-[a-z0-9-]+$/`);
      }
      if (seenTopicIds.has(topic.id)) {
        problem(`pipelines.${pipeKey}: duplicate topic id ${topic.id}`);
      }
      seenTopicIds.add(topic.id);
      if (!Array.isArray(topic.artifacts) || topic.artifacts.length === 0) {
        problem(`pipelines.${pipeKey}.${topic.id}.artifacts must be non-empty`);
        continue;
      }
      const seenPublished = new Set();
      for (const art of topic.artifacts) {
        if (!art.canonical) problem(`pipelines.${pipeKey}.${topic.id}: artifact missing canonical`);
        if (!art.published) problem(`pipelines.${pipeKey}.${topic.id}: artifact missing published`);
        if (!art.title) problem(`pipelines.${pipeKey}.${topic.id}: artifact missing title`);
        if (art.kind && !validKinds.has(art.kind)) {
          problem(`pipelines.${pipeKey}.${topic.id}.${art.canonical}: invalid kind "${art.kind}"`);
        }
        if (art.mode && !validModes.has(art.mode)) {
          problem(`pipelines.${pipeKey}.${topic.id}.${art.canonical}: invalid mode "${art.mode}"`);
        }
        if (art.mode === 'glob' && !art.globPattern) {
          problem(`pipelines.${pipeKey}.${topic.id}.${art.canonical}: mode=glob requires globPattern`);
        }
        if (art.published && seenPublished.has(art.published) && art.mode !== 'glob') {
          problem(`pipelines.${pipeKey}.${topic.id}: duplicate published filename ${art.published}`);
        }
        if (art.published) seenPublished.add(art.published);
      }
    }
  }

  if (problems.length === 0) {
    process.stdout.write(`${TOOL_NAME}: manifest valid (${mp})\n`);
    clearFailure();
    return 0;
  }
  process.stdout.write(`${TOOL_NAME}: manifest has ${problems.length} issue(s):\n`);
  for (const p of problems.slice(0, 20)) process.stdout.write(`  - ${p}\n`);
  if (problems.length > 20) process.stdout.write(`  ... and ${problems.length - 20} more\n`);
  writeFailure({
    error_class: 'schema-failure',
    error_message: `manifest has ${problems.length} schema issue(s)`,
    stage: 'check-manifest:validate',
    coverage_gaps: problems,
    remediation:
      'Fix the reported manifest issues. See source/schemas/doc-publish-manifest.schema.json for the canonical spec.',
    escalation_target: 'review-lead',
    advisor_required: false,
  });
  return 4;
}

function cmdReport() {
  const rp = path.join(projectRoot(), '_cobolt-output', 'latest', 'publish', 'publish-report.json');
  if (!safeStat(rp)) {
    process.stdout.write(`${TOOL_NAME}: no publish report yet. Run \`publish\` first.\n`);
    return 0;
  }
  process.stdout.write(`${fs.readFileSync(rp, 'utf8')}\n`);
  return 0;
}

function cmdPrintManifest() {
  const { manifest, path: mp, error } = loadManifest();
  if (!manifest) {
    process.stderr.write(`[${TOOL_NAME}] ${error}\n`);
    return 4;
  }
  process.stdout.write(`manifest: ${mp}\n`);
  process.stdout.write(`version: ${manifest.version}\n`);
  process.stdout.write(`namespace: ${manifest.namespace}\n`);
  for (const [key, pipe] of Object.entries(manifest.pipelines)) {
    const topicCount = pipe.topics.length;
    const artCount = pipe.topics.reduce((a, t) => a + t.artifacts.length, 0);
    process.stdout.write(`  ${key}: ${topicCount} topics, ${artCount} artifact rules\n`);
  }
  return 0;
}

function help() {
  process.stdout.write(`Usage:
  node tools/cobolt-publish-docs.js publish        [--pipeline=plan|brownfield|all] [--topic=<topic-id>] [--dry-run]
  node tools/cobolt-publish-docs.js check          [--pipeline=plan|brownfield|all]
  node tools/cobolt-publish-docs.js audit          [--pipeline=plan|brownfield|all] [--strict-orphans] [--json]
  node tools/cobolt-publish-docs.js check-manifest
  node tools/cobolt-publish-docs.js report
  node tools/cobolt-publish-docs.js print-manifest

Publishes canonical artifacts from _cobolt-output/ to a human-readable view at
docs/cobolt/. Never mutates canonical sources. Writes drift lock file.

Exit codes:
  0  ok (publish clean, drift check clean, audit clean, manifest valid)
  1  generic error
  2  required canonical artifact missing/undersized (publish)
  3  drift detected (check) OR audit violations found (audit)
  4  manifest malformed OR lock file malformed
  5  path-boundary violation (canonical escapes project root OR published escapes topic dir)
`);
}

function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0] || 'publish';
  try {
    switch (cmd) {
      case 'publish':
        return cmdPublish(args);
      case 'check':
        return cmdCheck(args);
      case 'audit':
        return cmdAudit(args);
      case 'check-manifest':
        return cmdCheckManifest();
      case 'report':
        return cmdReport(args);
      case 'print-manifest':
        return cmdPrintManifest();
      case 'help':
      case '--help':
      case '-h':
        help();
        return 0;
      default:
        process.stderr.write(`Unknown command: ${cmd}\n`);
        help();
        return 1;
    }
  } catch (e) {
    const isPathBoundary = e.code === 'PATH_BOUNDARY_VIOLATION';
    writeFailure({
      error_class: isPathBoundary ? 'permission-denied' : 'runtime-failure',
      error_message: e.message,
      stage: `publish:${cmd}`,
      stack: e.stack,
      remediation: isPathBoundary
        ? 'Fix the manifest — a canonical path escaped project root. Manifests may only reference paths under the project root; no absolute paths or parent traversals that leave the project.'
        : 'Check the failure JSON in _cobolt-output/audit/cobolt-publish-docs-failure.json and escalate to review-lead.',
    });
    process.stderr.write(`[${TOOL_NAME}] ${e.message}\n`);
    return isPathBoundary ? 5 : 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  TOOL_NAME,
  loadManifest,
  findManifestPath,
  writeFailure,
  clearFailure,
  sha256,
  cmdPublish,
  cmdCheck,
  cmdAudit,
  cmdCheckManifest,
  cmdReport,
  cmdPrintManifest,
  renderFrontmatter,
  stripExistingCoboltFrontmatter,
  parseFrontmatter,
  parseHtmlCoboltComment,
  main,
};
