#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { DEFAULT_IGNORE_DIRS, walkFiles } = require('../lib/cobolt-search');
const { atomicWrite, atomicWriteJSON } = require('../lib/cobolt-atomic-write');

const VERSION = '1.2.0';
const DEFAULT_TARGET_CHARS = 1000;
const DEFAULT_MAX_CHARS = 1400;
const DEFAULT_MIN_CHARS = 250;
const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_BATCH_SIZE = 64;

const INDEX_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.css',
  '.scss',
  '.html',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.rb',
  '.cs',
  '.php',
  '.kt',
  '.swift',
  '.ex',
  '.exs',
  '.heex',
  '.eex',
  '.leex',
  '.sface',
  '.erl',
  '.hrl',
  '.sh',
  '.sql',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.md',
  '.mdx',
  '.txt',
  '.rst',
]);

const INDEX_IGNORE_DIRS = new Set([
  ...DEFAULT_IGNORE_DIRS,
  'deps',
  '_build',
  '.elixir_ls',
  '.pytest_cache',
  '.ruff_cache',
  '.mypy_cache',
  'coverage',
  'tmp',
  'temp',
  'logs',
  '__COBOLT_CONFIG_DIR__',
]);

const SKIP_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
]);

function outputDir(root) {
  return path.join(path.resolve(root || process.cwd()), '_cobolt-output', 'code-index');
}

function manifestPath(root) {
  return path.join(outputDir(root), 'embedding-index.json');
}

function chunksPath(root) {
  return path.join(outputDir(root), 'chunks.jsonl');
}

function embeddingsPath(root) {
  return path.join(outputDir(root), 'embeddings.jsonl');
}

function fileHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function writeFileAtomic(filePath, content) {
  atomicWrite(filePath, content, { encoding: 'utf8' });
}

function writeJsonAtomic(filePath, payload) {
  atomicWriteJSON(filePath, payload);
}

function readJsonSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn('[cobolt-embedding-index] manifest unreadable, rebuilding:', err.message);
  }
  return null;
}

function readJsonlSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function shouldIndexFile(filePath) {
  const base = path.basename(filePath);
  if (SKIP_BASENAMES.has(base)) return false;
  if (/\.min\.(js|css)$/i.test(base)) return false;
  if (/\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tar|7z|exe|dll|so|dylib)$/i.test(base)) return false;
  return INDEX_EXTENSIONS.has(path.extname(base).toLowerCase());
}

function normalizeRelPath(root, filePath) {
  return path.relative(path.resolve(root), path.resolve(filePath)).replace(/\\/g, '/');
}

function isStructuralBoundary(line, ext) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if ((ext === '.md' || ext === '.mdx' || ext === '.rst') && /^#{1,6}\s+/.test(trimmed)) return true;
  if (/^(function|class|export\s+function|export\s+class|def|async\s+function)\b/.test(trimmed)) return true;
  if (/^(defmodule|defprotocol|defimpl|defmacro|defp?)\b/.test(trimmed)) return true;
  if (/^(describe|it|test)\s*\(/.test(trimmed)) return true;
  return false;
}

function splitIntoUnits(content, ext) {
  const lines = content.split('\n');
  const units = [];
  let current = [];
  let startLine = 1;

  function flush(endLine) {
    const text = current.join('\n').trim();
    if (text) units.push({ text, startLine, endLine });
    current = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const boundary = isStructuralBoundary(line, ext);

    if (boundary && current.length > 0) {
      flush(lineNo - 1);
      startLine = lineNo;
    }

    if (current.length === 0) startLine = lineNo;
    current.push(line);

    if (!line.trim()) {
      flush(lineNo);
      startLine = lineNo + 1;
    }
  }

  if (current.length > 0) flush(lines.length);
  return units;
}

function splitLargeUnit(unit, maxChars) {
  if (unit.text.length <= maxChars) return [unit];

  const lines = unit.text.split('\n');
  const chunks = [];
  let current = [];
  let startLine = unit.startLine;

  function flush(endLine) {
    const text = current.join('\n').trim();
    if (text) chunks.push({ text, startLine, endLine });
    current = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = unit.startLine + i;
    const projected = current.concat(line).join('\n');
    if (current.length > 0 && projected.length > maxChars) {
      flush(lineNo - 1);
      startLine = lineNo;
    }
    current.push(line);
  }

  if (current.length > 0) flush(unit.endLine);
  return chunks;
}

function mergeUnits(units, options = {}) {
  const targetChars = options.targetChars || DEFAULT_TARGET_CHARS;
  const maxChars = options.maxChars || DEFAULT_MAX_CHARS;
  const minChars = options.minChars || DEFAULT_MIN_CHARS;
  const normalizedUnits = units.flatMap((unit) => splitLargeUnit(unit, maxChars));
  const chunks = [];
  let current = [];
  let startLine = null;
  let endLine = null;

  function currentTextWith(unit = null) {
    return current
      .concat(unit ? [unit] : [])
      .map((entry) => entry.text)
      .join('\n\n')
      .trim();
  }

  function flush() {
    const text = currentTextWith();
    if (text) chunks.push({ text, startLine, endLine });
    current = [];
    startLine = null;
    endLine = null;
  }

  for (const unit of normalizedUnits) {
    if (current.length === 0) {
      current.push(unit);
      startLine = unit.startLine;
      endLine = unit.endLine;
      continue;
    }

    const projected = currentTextWith(unit);
    const currentText = currentTextWith();
    if (projected.length > maxChars && currentText.length >= minChars) {
      flush();
      current.push(unit);
      startLine = unit.startLine;
      endLine = unit.endLine;
      continue;
    }

    current.push(unit);
    endLine = unit.endLine;
    if (projected.length >= targetChars) flush();
  }

  if (current.length > 0) flush();
  return chunks;
}

function chunkFile(root, filePath, options = {}) {
  const relPath = normalizeRelPath(root, filePath);
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    return { relPath, hash: null, chunks: [], skipped: true };
  }

  const content = buffer.toString('utf8');
  if (!content.trim()) return { relPath, hash: fileHash(buffer), chunks: [], skipped: true };

  const ext = path.extname(filePath).toLowerCase();
  const units = splitIntoUnits(content, ext);
  const rawChunks = mergeUnits(units, options);
  const chunks = rawChunks.map((chunk, index) => {
    const contentHash = hashText(`${relPath}:${chunk.startLine}:${chunk.endLine}:${chunk.text}`);
    return {
      id: `chunk:${contentHash}`,
      ordinal: index,
      path: relPath,
      extension: ext,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      charCount: chunk.text.length,
      hash: contentHash,
      text: chunk.text,
    };
  });

  return {
    relPath,
    hash: fileHash(buffer),
    chunks,
    skipped: false,
  };
}

function collectProjectChunks(root, options = {}) {
  const resolvedRoot = path.resolve(root || process.cwd());
  const files = walkFiles(resolvedRoot, {
    extensions: [...INDEX_EXTENSIONS],
    ignoreDirs: INDEX_IGNORE_DIRS,
    maxFileSize: options.maxFileSize || 512 * 1024,
    filter: shouldIndexFile,
  });

  const chunks = [];
  const fileEntries = [];
  for (const filePath of files) {
    const result = chunkFile(resolvedRoot, filePath, options);
    fileEntries.push({
      path: result.relPath,
      hash: result.hash,
      chunks: result.chunks.length,
      skipped: result.skipped,
    });
    chunks.push(...result.chunks);
  }

  return {
    root: resolvedRoot,
    files: fileEntries.sort((a, b) => a.path.localeCompare(b.path)),
    chunks: chunks.sort((a, b) => a.path.localeCompare(b.path) || a.ordinal - b.ordinal),
  };
}

function serializeJsonl(entries) {
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : '');
}

function shouldGenerateEmbeddings(options = {}) {
  if (options.embed === true) return true;
  if (options.embedIfKey === true && (options.apiKey || process.env.OPENAI_API_KEY)) return true;
  return process.env.COBOLT_EMBEDDINGS === '1' && Boolean(options.apiKey || process.env.OPENAI_API_KEY);
}

async function requestEmbeddingBatch(inputs, options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required to generate embeddings');

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available in this Node.js runtime');

  const body = {
    model: options.model || DEFAULT_MODEL,
    input: inputs,
    encoding_format: 'float',
  };
  if (options.dimensions) body.dimensions = options.dimensions;

  const response = await fetchImpl('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Embedding request failed (${response.status}): ${detail.slice(0, 240)}`);
  }

  return response.json();
}

async function generateEmbeddingsForChunks(chunks, options = {}) {
  const batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
  const model = options.model || DEFAULT_MODEL;
  const embeddings = [];
  let promptTokens = 0;

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const payload = await requestEmbeddingBatch(
      batch.map((chunk) => chunk.text),
      options,
    );

    const vectors = payload.data || [];
    for (const vector of vectors) {
      const chunk = batch[vector.index];
      if (!chunk) continue;
      embeddings.push({
        chunkId: chunk.id,
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        model: payload.model || model,
        dimensions: Array.isArray(vector.embedding) ? vector.embedding.length : null,
        embedding: vector.embedding,
      });
    }
    promptTokens += payload.usage?.prompt_tokens || 0;
  }

  return {
    status: 'generated',
    model,
    count: embeddings.length,
    promptTokens,
    embeddings,
  };
}

async function buildEmbeddingIndex(root, options = {}) {
  const resolvedRoot = path.resolve(root || process.cwd());
  const targetChars = options.targetChars || DEFAULT_TARGET_CHARS;
  const maxChars = options.maxChars || Math.max(DEFAULT_MAX_CHARS, targetChars + 250);
  const collected = collectProjectChunks(resolvedRoot, {
    ...options,
    targetChars,
    maxChars,
  });

  let embeddingResult = {
    status: shouldGenerateEmbeddings(options) ? 'failed' : 'skipped',
    model: options.model || DEFAULT_MODEL,
    count: 0,
    promptTokens: 0,
    error: null,
  };

  if (shouldGenerateEmbeddings(options)) {
    try {
      embeddingResult = await generateEmbeddingsForChunks(collected.chunks, options);
      writeFileAtomic(embeddingsPath(resolvedRoot), serializeJsonl(embeddingResult.embeddings));
    } catch (err) {
      embeddingResult = {
        status: 'failed',
        model: options.model || DEFAULT_MODEL,
        count: 0,
        promptTokens: 0,
        error: err?.message || 'embedding generation failed',
      };
      try {
        fs.unlinkSync(embeddingsPath(resolvedRoot));
      } catch {
        /* already absent */
      }
    }
  } else {
    writeFileAtomic(embeddingsPath(resolvedRoot), '');
  }

  writeFileAtomic(chunksPath(resolvedRoot), serializeJsonl(collected.chunks));

  const manifest = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    root: resolvedRoot,
    storage: {
      manifest: path.relative(resolvedRoot, manifestPath(resolvedRoot)).replace(/\\/g, '/'),
      chunks: path.relative(resolvedRoot, chunksPath(resolvedRoot)).replace(/\\/g, '/'),
      embeddings: path.relative(resolvedRoot, embeddingsPath(resolvedRoot)).replace(/\\/g, '/'),
    },
    chunking: {
      strategy: 'line-and-structure-aware',
      targetChars,
      maxChars,
      minChars: options.minChars || DEFAULT_MIN_CHARS,
    },
    embeddings: {
      status: embeddingResult.status,
      model: embeddingResult.model,
      count: embeddingResult.count,
      promptTokens: embeddingResult.promptTokens,
      error: embeddingResult.error || null,
      localOnly: true,
    },
    counts: {
      files: collected.files.length,
      indexedFiles: collected.files.filter((file) => !file.skipped && file.chunks > 0).length,
      chunks: collected.chunks.length,
      totalChars: collected.chunks.reduce((sum, chunk) => sum + chunk.charCount, 0),
    },
    files: collected.files,
  };

  writeJsonAtomic(manifestPath(resolvedRoot), manifest);
  return {
    manifest,
    chunks: collected.chunks,
    paths: {
      manifestPath: manifestPath(resolvedRoot),
      chunksPath: chunksPath(resolvedRoot),
      embeddingsPath: embeddingsPath(resolvedRoot),
    },
  };
}

function ensureLocalChunkIndex(root, options = {}) {
  const resolvedRoot = path.resolve(root || process.cwd());
  const existing = readEmbeddingIndex(resolvedRoot);
  if (isReusableIndex(existing, resolvedRoot, options)) {
    return {
      manifest: existing,
      paths: {
        manifestPath: manifestPath(resolvedRoot),
        chunksPath: chunksPath(resolvedRoot),
        embeddingsPath: embeddingsPath(resolvedRoot),
      },
      reused: true,
    };
  }

  const targetChars = options.targetChars || DEFAULT_TARGET_CHARS;
  const maxChars = options.maxChars || Math.max(DEFAULT_MAX_CHARS, targetChars + 250);
  const collected = collectProjectChunks(resolvedRoot, {
    ...options,
    targetChars,
    maxChars,
  });

  writeFileAtomic(chunksPath(resolvedRoot), serializeJsonl(collected.chunks));
  if (!fs.existsSync(embeddingsPath(resolvedRoot))) writeFileAtomic(embeddingsPath(resolvedRoot), '');

  const manifest = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    root: resolvedRoot,
    storage: {
      manifest: path.relative(resolvedRoot, manifestPath(resolvedRoot)).replace(/\\/g, '/'),
      chunks: path.relative(resolvedRoot, chunksPath(resolvedRoot)).replace(/\\/g, '/'),
      embeddings: path.relative(resolvedRoot, embeddingsPath(resolvedRoot)).replace(/\\/g, '/'),
    },
    chunking: {
      strategy: 'line-and-structure-aware',
      targetChars,
      maxChars,
      minChars: options.minChars || DEFAULT_MIN_CHARS,
    },
    embeddings: {
      status: 'skipped',
      model: options.model || process.env.COBOLT_EMBEDDING_MODEL || DEFAULT_MODEL,
      count: 0,
      promptTokens: 0,
      error: null,
      localOnly: true,
    },
    counts: {
      files: collected.files.length,
      indexedFiles: collected.files.filter((file) => !file.skipped && file.chunks > 0).length,
      chunks: collected.chunks.length,
      totalChars: collected.chunks.reduce((sum, chunk) => sum + chunk.charCount, 0),
    },
    files: collected.files,
  };

  writeJsonAtomic(manifestPath(resolvedRoot), manifest);
  return {
    manifest,
    paths: {
      manifestPath: manifestPath(resolvedRoot),
      chunksPath: chunksPath(resolvedRoot),
      embeddingsPath: embeddingsPath(resolvedRoot),
    },
    reused: false,
  };
}

function collectProjectFileManifest(root, options = {}) {
  const resolvedRoot = path.resolve(root || process.cwd());
  const files = walkFiles(resolvedRoot, {
    extensions: [...INDEX_EXTENSIONS],
    ignoreDirs: INDEX_IGNORE_DIRS,
    maxFileSize: options.maxFileSize || 512 * 1024,
    filter: shouldIndexFile,
  });

  return files
    .map((filePath) => {
      const relPath = normalizeRelPath(resolvedRoot, filePath);
      try {
        const buffer = fs.readFileSync(filePath);
        return {
          path: relPath,
          hash: fileHash(buffer),
          skipped: !buffer.toString('utf8').trim(),
        };
      } catch {
        return { path: relPath, hash: null, skipped: true };
      }
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function readEmbeddingIndex(root) {
  return readJsonSafe(manifestPath(root));
}

function fileManifestMatches(existingFiles, currentFiles) {
  if (!Array.isArray(existingFiles) || !Array.isArray(currentFiles)) return false;
  if (existingFiles.length !== currentFiles.length) return false;

  const existingByPath = new Map(existingFiles.map((file) => [file.path, file]));
  for (const current of currentFiles) {
    const existing = existingByPath.get(current.path);
    if (!existing) return false;
    if (existing.hash !== current.hash) return false;
    if (Boolean(existing.skipped) !== Boolean(current.skipped)) return false;
  }
  return true;
}

function isReusableIndex(existing, root, options = {}) {
  if (!existing || options.force === true) return false;
  if (existing.version !== VERSION) return false;

  const resolvedRoot = path.resolve(root || process.cwd());
  if (existing.root && path.resolve(existing.root) !== resolvedRoot) return false;

  const targetChars = options.targetChars || DEFAULT_TARGET_CHARS;
  const maxChars = options.maxChars || Math.max(DEFAULT_MAX_CHARS, targetChars + 250);
  if (existing.chunking?.targetChars !== targetChars) return false;
  if (existing.chunking?.maxChars !== maxChars) return false;

  const chunkFile = chunksPath(resolvedRoot);
  const embeddingFile = embeddingsPath(resolvedRoot);
  if (!fs.existsSync(chunkFile) || !fs.existsSync(embeddingFile)) return false;

  const currentFiles = collectProjectFileManifest(resolvedRoot, options);
  return fileManifestMatches(existing.files, currentFiles);
}

async function ensureEmbeddingIndex(root, options = {}) {
  const existing = readEmbeddingIndex(root);
  if (isReusableIndex(existing, root, options)) {
    return {
      manifest: existing,
      chunks: null,
      paths: {
        manifestPath: manifestPath(root),
        chunksPath: chunksPath(root),
        embeddingsPath: embeddingsPath(root),
      },
      reused: true,
    };
  }
  return buildEmbeddingIndex(root, options);
}

function formatSummary(result) {
  const manifest = result.manifest || result;
  return [
    'CoBolt Project Embedding Index',
    '',
    `Files indexed: ${manifest.counts?.indexedFiles || 0}/${manifest.counts?.files || 0}`,
    `Chunks: ${manifest.counts?.chunks || 0}`,
    `Chunk target: ${manifest.chunking?.targetChars || DEFAULT_TARGET_CHARS} chars`,
    `Embeddings: ${manifest.embeddings?.status || 'unknown'} (${manifest.embeddings?.model || DEFAULT_MODEL})`,
    `Storage: ${manifest.storage?.chunks || path.relative(process.cwd(), chunksPath(process.cwd()))}`,
  ].join('\n');
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return null;
  return args[index + 1];
}

function printUsage() {
  console.log('CoBolt Project Embedding Index');
  console.log('');
  console.log('Usage: node tools/cobolt-embedding-index.js <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  build [--embed|--embed-if-key] [--model M] [--target-chars N] [--json]');
  console.log('  status [--json]');
  console.log('');
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || '--help';
  const jsonMode = args.includes('--json');

  if (command === '--help' || command === '-h' || command === 'help') {
    printUsage();
    return;
  }

  if (command === 'build') {
    const targetChars = Number.parseInt(flagValue(args, '--target-chars') || DEFAULT_TARGET_CHARS, 10);
    const result = await buildEmbeddingIndex(process.cwd(), {
      force: true,
      embed: args.includes('--embed'),
      embedIfKey: args.includes('--embed-if-key'),
      model: flagValue(args, '--model') || process.env.COBOLT_EMBEDDING_MODEL || DEFAULT_MODEL,
      targetChars: Number.isFinite(targetChars) ? targetChars : DEFAULT_TARGET_CHARS,
    });

    if (jsonMode) {
      console.log(JSON.stringify({ manifest: result.manifest, paths: result.paths }, null, 2));
      return;
    }

    console.log(formatSummary(result));
    if (args.includes('--embed') && result.manifest.embeddings?.status === 'failed') {
      console.error(`Embedding generation failed: ${result.manifest.embeddings.error || 'unknown error'}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'status') {
    const manifest = readEmbeddingIndex(process.cwd());
    if (!manifest) {
      if (jsonMode) console.log(JSON.stringify({ exists: false }, null, 2));
      else console.log('No embedding index found. Run: node tools/cobolt-embedding-index.js build');
      return;
    }

    if (jsonMode) {
      console.log(JSON.stringify({ exists: true, manifest }, null, 2));
      return;
    }

    console.log(formatSummary(manifest));
    return;
  }

  printUsage();
  process.exitCode = 1;
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_TARGET_CHARS,
  buildEmbeddingIndex,
  chunksPath,
  collectProjectFileManifest,
  collectProjectChunks,
  embeddingsPath,
  ensureEmbeddingIndex,
  ensureLocalChunkIndex,
  formatSummary,
  manifestPath,
  readChunks: (root) => readJsonlSafe(chunksPath(root)),
  readEmbeddings: (root) => readJsonlSafe(embeddingsPath(root)),
  readEmbeddingIndex,
  requestEmbeddingBatch,
  shouldGenerateEmbeddings,
  isReusableIndex,
  splitIntoUnits,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
