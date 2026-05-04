#!/usr/bin/env node

// CoBolt Source Coverage - deterministic source document traceability.

const fs = require('node:fs');
const path = require('node:path');
const { getPlanningDir } = require('../lib/cobolt-planning-artifacts');
const { getSourcePacketIntegrityStatus } = require('../lib/cobolt-source-packet');

const TOKEN_STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'need',
  'must',
  'ought',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'under',
  'over',
  'and',
  'but',
  'or',
  'nor',
  'not',
  'so',
  'yet',
  'both',
  'either',
  'neither',
  'each',
  'every',
  'all',
  'any',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'no',
  'only',
  'same',
  'than',
  'too',
  'very',
  'just',
  'also',
  'that',
  'this',
  'these',
  'those',
  'it',
  'its',
  'they',
  'them',
  'their',
  'we',
  'our',
  'you',
  'your',
  'i',
  'me',
  'my',
  'he',
  'she',
  'his',
  'her',
  'who',
  'whom',
  'which',
  'what',
  'when',
  'where',
  'how',
  'if',
  'then',
  'else',
  'while',
  'until',
  'about',
  'up',
  'out',
  'off',
  'down',
]);

const TOKEN_SYNONYMS = new Map([
  ['signin', 'login'],
  ['signon', 'login'],
  ['signing', 'login'],
  ['authenticate', 'authentication'],
  ['auth', 'authentication'],
  ['administrator', 'admin'],
  ['admins', 'admin'],
  ['payments', 'payment'],
  ['billing', 'payment'],
  ['subscriptions', 'subscription'],
  ['filters', 'filter'],
  ['saved', 'save'],
  ['saving', 'save'],
  ['queues', 'queue'],
  ['retries', 'retry'],
  ['retrying', 'retry'],
  ['dashboards', 'dashboard'],
]);

function planningDir() {
  return getPlanningDir(process.cwd(), { create: false, strict: false, fallbackToLatest: true });
}

function defaultTargetPath() {
  const dir = planningDir();
  if (!dir) return null;
  return path.join(dir, 'prd.md');
}

function reportPath() {
  const dir = planningDir();
  if (!dir) return path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'source-coverage-report.json');
  return path.join(dir, 'source-coverage-report.json');
}

function inputDocumentCoverageReportPath() {
  const dir = planningDir();
  if (!dir) {
    return path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'source-input-coverage-report.json');
  }
  return path.join(dir, 'source-input-coverage-report.json');
}

function writeReport(result) {
  const outputPath = reportPath();
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return outputPath;
}

function writeInputDocumentCoverageReport(result) {
  const outputPath = inputDocumentCoverageReportPath();
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return outputPath;
}

function loadJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function buildFailClosedResult(base, reason, issues = [], options = {}) {
  const result = {
    skipped: false,
    coverage: 0,
    passed: false,
    unmatched: [],
    unmatchedRequirements: 0,
    matchedRequirements: 0,
    totalSourceRequirements: 0,
    includedRequirements: 0,
    excludedRequirements: 0,
    reason,
    issues,
    ...base,
  };
  if (options.writeReport !== false) {
    writeReport(result);
  }
  return { result, exitCode: 1 };
}

function parseSourceRegistry(content) {
  const entries = [];
  const lines = content.split('\n');
  let inRegistry = false;

  for (const line of lines) {
    // Accept both `## Source Requirement Registry` and numbered TOC-style
    // headings like `## 9. Source Requirement Registry` or `## 9.1 Source Requirement Registry`.
    if (/^##\s+(?:\d+(?:\.\d+)*\.?\s+)?Source Requirement Registry/i.test(line)) {
      inRegistry = true;
      continue;
    }

    if (inRegistry && /^##\s/.test(line) && !/Source Requirement Registry/i.test(line)) {
      break;
    }

    if (!inRegistry) continue;
    if (line.trim().startsWith('<!--') || line.trim() === '') continue;
    if (/^\|\s*(ID|--)/i.test(line)) continue;
    if (/^\|[\s-|]+$/.test(line)) continue;

    const match = line.match(/^\|\s*(SRC-\d+)\s*\|\s*([^|]*)\s*\|\s*([^|]*)\s*\|\s*([^|]*)\s*\|\s*([^|]*)\s*\|/);
    if (!match) continue;

    entries.push({
      id: match[1].trim(),
      sourceFile: match[2].trim(),
      summary: match[3].trim(),
      category: match[4].trim().toUpperCase(),
      status: match[5].trim().toLowerCase(),
    });
  }

  return entries;
}

function normalizeToken(word) {
  let normalized = String(word || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();

  if (!normalized) return '';
  if (TOKEN_SYNONYMS.has(normalized)) normalized = TOKEN_SYNONYMS.get(normalized);
  if (normalized.endsWith('ies') && normalized.length > 4) normalized = `${normalized.slice(0, -3)}y`;
  else if (normalized.endsWith('ing') && normalized.length > 5) normalized = normalized.slice(0, -3);
  else if (normalized.endsWith('ed') && normalized.length > 4) normalized = normalized.slice(0, -1);
  else if (normalized.endsWith('es') && normalized.length > 4) normalized = normalized.slice(0, -2);
  else if (normalized.endsWith('s') && normalized.length > 3) normalized = normalized.slice(0, -1);
  if (TOKEN_SYNONYMS.has(normalized)) normalized = TOKEN_SYNONYMS.get(normalized);
  return normalized;
}

function extractKeywords(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((word) => normalizeToken(word))
    .filter((word) => word.length > 2 && !TOKEN_STOP_WORDS.has(word));
}

function buildTextFeatures(text) {
  const tokens = extractKeywords(text);
  const phrases = new Set();

  for (let index = 0; index < tokens.length - 1; index++) {
    phrases.add(`${tokens[index]} ${tokens[index + 1]}`);
  }

  for (let index = 0; index < tokens.length - 2; index++) {
    phrases.add(`${tokens[index]} ${tokens[index + 1]} ${tokens[index + 2]}`);
  }

  return {
    tokens,
    tokenSet: new Set(tokens),
    phrases,
    normalizedText: tokens.join(' '),
  };
}

function sourceIndexPath(projectRoot, planningRoot) {
  return path.join(
    planningRoot || planningDir() || path.join(projectRoot, '_cobolt-output', 'latest', 'planning'),
    'source-index.json',
  );
}

function stripRegistryLineHint(sourceFile) {
  return String(sourceFile || '').replace(/:L\d+(?::\d+)?$/i, '');
}

function loadSourceIndex(projectRoot, planningRoot) {
  return loadJson(sourceIndexPath(projectRoot, planningRoot));
}

function findSourceDocumentContext(srcEntry, sourceIndex) {
  const sourcePath = stripRegistryLineHint(srcEntry.sourceFile);
  const documents = Array.isArray(sourceIndex?.documents) ? sourceIndex.documents : [];
  return documents.find((document) => document.path === sourcePath) || null;
}

function buildEntryTerms(srcEntry, sourceDocument) {
  const summaryTerms = extractKeywords(srcEntry.summary);
  const sourcePathTerms = extractKeywords(path.basename(stripRegistryLineHint(srcEntry.sourceFile || '')));
  const hintedTerms = Array.isArray(sourceDocument?.keywordHints)
    ? sourceDocument.keywordHints.map((keyword) => normalizeToken(keyword)).filter(Boolean)
    : [];
  const semanticTerms = Object.values(sourceDocument?.semanticSignals || {})
    .flatMap((values) => values || [])
    .flatMap((value) => extractKeywords(String(value)));

  return [...new Set([...summaryTerms, ...sourcePathTerms, ...hintedTerms, ...semanticTerms])];
}

function isRequirementCovered(srcEntry, targetFeaturesOrText, sourceDocument) {
  const targetFeatures =
    typeof targetFeaturesOrText === 'string' ? buildTextFeatures(targetFeaturesOrText) : targetFeaturesOrText;
  const srcKeywords = buildEntryTerms(srcEntry, sourceDocument);
  if (srcKeywords.length === 0) return true;

  let matchCount = 0;
  for (const keyword of srcKeywords) {
    if (targetFeatures.tokenSet.has(keyword)) {
      matchCount++;
    }
  }

  if (matchCount / srcKeywords.length >= 0.6) {
    return true;
  }

  const summaryTokens = extractKeywords(srcEntry.summary);
  if (summaryTokens.length >= 2) {
    for (let index = 0; index < summaryTokens.length - 1; index++) {
      if (targetFeatures.phrases.has(`${summaryTokens[index]} ${summaryTokens[index + 1]}`)) {
        return true;
      }
    }
  }

  const normalizedSummary = summaryTokens.join(' ').trim();
  if (normalizedSummary.length > 8 && targetFeatures.normalizedText.includes(normalizedSummary)) {
    return true;
  }

  return false;
}

function getSourceRequirementSet(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const planningRoot = options.planningDir || planningDir();
  const includeExcluded = options.includeExcluded === true;
  const sourcePacket = getSourcePacketIntegrityStatus(projectRoot, planningRoot, { minBytes: 1 });

  if (!sourcePacket.required) {
    return {
      skipped: true,
      passed: true,
      sourcePacket,
      entries: [],
      allEntries: [],
      excludedCount: 0,
    };
  }

  if (!sourcePacket.packetExists) {
    return {
      skipped: false,
      passed: false,
      sourcePacket,
      entries: [],
      allEntries: [],
      excludedCount: 0,
      reason: 'Source document consolidation is required but missing',
      issues: sourcePacket.issues,
    };
  }

  const consolContent = fs.readFileSync(sourcePacket.packetPath, 'utf8');
  const allEntries = parseSourceRegistry(consolContent);
  if (allEntries.length === 0) {
    return {
      skipped: false,
      passed: false,
      sourcePacket,
      entries: [],
      allEntries: [],
      excludedCount: 0,
      reason: 'Source Requirement Registry is missing from source-document-consolidation.md',
      issues: sourcePacket.issues,
    };
  }

  const entries = includeExcluded ? allEntries : allEntries.filter((entry) => entry.status === 'included');
  const excludedCount = allEntries.filter((entry) => entry.status.startsWith('excluded')).length;
  return {
    skipped: false,
    passed: true,
    sourcePacket,
    entries,
    allEntries,
    excludedCount,
  };
}

function normalizeDocumentPath(value) {
  return stripRegistryLineHint(value)
    .replace(/\\/g, '/')
    .replace(/^['"]|['"]$/g, '')
    .replace(/^\.\//, '')
    .trim()
    .toLowerCase();
}

function sourceFileMatchesInputDocument(sourceFile, inputDocument) {
  const source = normalizeDocumentPath(sourceFile);
  const input = normalizeDocumentPath(inputDocument);
  if (!source || !input) return false;
  return source === input || source.endsWith(`/${input}`) || input.endsWith(`/${source}`);
}

function expectedInputDocuments(sourcePacket) {
  const fromIntake = Array.isArray(sourcePacket?.expectedInputDocuments) ? sourcePacket.expectedInputDocuments : [];
  const fromPrd = Array.isArray(sourcePacket?.inputDocuments) ? sourcePacket.inputDocuments : [];
  return [...new Set([...fromIntake, ...fromPrd].map((value) => String(value || '').trim()).filter(Boolean))];
}

function evaluateInputDocumentCoverage(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const planningRoot = options.planningDir || planningDir();
  const sourcePacket = getSourcePacketIntegrityStatus(projectRoot, planningRoot, { minBytes: 1 });
  const expected = expectedInputDocuments(sourcePacket);

  if (!sourcePacket.required) {
    const result = {
      skipped: true,
      passed: true,
      reason: 'No deterministic source document packet was required for this planning run',
      expectedInputDocuments: [],
      expectedCount: 0,
      registryCoveredCount: 0,
      missingRegistryDocuments: [],
      sourceIndexPresent: false,
      missingSourceIndexDocuments: [],
      issues: [],
      warnings: [],
    };
    if (options.writeReport !== false) writeInputDocumentCoverageReport(result);
    return { result, exitCode: 0 };
  }

  const issues = [];
  const warnings = [];
  if (expected.length === 0) {
    issues.push('Source intake requires consolidation, but no inputDocuments were recorded.');
  }
  if (!sourcePacket.packetExists) {
    issues.push(
      `Source document consolidation packet is missing at ${
        sourcePacket.packetPath || '_cobolt-output/latest/planning/source-document-consolidation.md'
      }.`,
    );
  }

  let registryEntries = [];
  if (sourcePacket.packetExists) {
    try {
      registryEntries = parseSourceRegistry(fs.readFileSync(sourcePacket.packetPath, 'utf8'));
    } catch {
      registryEntries = [];
    }
    if (registryEntries.length === 0) {
      issues.push('Source Requirement Registry is missing from source-document-consolidation.md.');
    }
  }

  const covered = [];
  const missingRegistryDocuments = [];
  const coveredDetails = [];
  for (const documentPath of expected) {
    const matches = registryEntries.filter((entry) => sourceFileMatchesInputDocument(entry.sourceFile, documentPath));
    if (matches.length > 0) {
      covered.push(documentPath);
      coveredDetails.push({
        documentPath,
        sourceIds: matches.map((entry) => entry.id),
        statuses: [...new Set(matches.map((entry) => entry.status || 'unknown'))],
      });
    } else if (sourcePacket.packetExists && registryEntries.length > 0) {
      missingRegistryDocuments.push(documentPath);
    }
  }

  if (missingRegistryDocuments.length > 0) {
    issues.push(
      `Source Requirement Registry has no included/excluded/deferred row for input documents: ${missingRegistryDocuments.join(
        ', ',
      )}`,
    );
  }

  const sourceIndex = loadSourceIndex(projectRoot, planningRoot);
  const sourceIndexDocuments = Array.isArray(sourceIndex?.documents)
    ? sourceIndex.documents.map((document) => document.path).filter(Boolean)
    : [];
  const sourceIndexPresent = Boolean(sourceIndex);
  const missingSourceIndexDocuments = sourceIndexPresent
    ? expected.filter(
        (documentPath) =>
          !sourceIndexDocuments.some((indexedPath) => sourceFileMatchesInputDocument(indexedPath, documentPath)),
      )
    : [];
  if (!sourceIndexPresent && expected.length > 0) {
    warnings.push('source-index.json is missing; regenerate source intake sidecars before long-lived handoff.');
  } else if (missingSourceIndexDocuments.length > 0) {
    warnings.push(`source-index.json is missing input documents: ${missingSourceIndexDocuments.join(', ')}`);
  }

  const result = {
    skipped: false,
    passed: issues.length === 0,
    expectedInputDocuments: expected,
    expectedCount: expected.length,
    registryCoveredDocuments: covered,
    registryCoveredCount: covered.length,
    coveredDetails,
    missingRegistryDocuments,
    sourceIndexPresent,
    sourceIndexDocumentCount: sourceIndexDocuments.length,
    missingSourceIndexDocuments,
    packetPath: sourcePacket.packetPath,
    sourceIntakePath: sourcePacket.sourceIntakePath,
    issues,
    warnings,
  };

  if (options.writeReport !== false) writeInputDocumentCoverageReport(result);
  return { result, exitCode: result.passed ? 0 : 1 };
}

function evaluateCoverageAgainstText(targetContent, options = {}) {
  const threshold = Number(options.threshold ?? 95);
  const sourceRequirements = getSourceRequirementSet(options);
  const targetFile = options.targetFile || null;
  const targetFeatures = buildTextFeatures(targetContent);
  const sourceIndex = loadSourceIndex(options.projectRoot || process.cwd(), options.planningDir || planningDir());

  if (sourceRequirements.skipped) {
    const result = {
      skipped: true,
      reason: 'No deterministic source document packet was required for this planning run',
      coverage: 100,
      passed: true,
    };
    if (options.writeReport !== false) {
      writeReport(result);
    }
    return { result, exitCode: 0 };
  }

  if (!sourceRequirements.passed) {
    return buildFailClosedResult(
      {
        consolidationFile:
          sourceRequirements.sourcePacket.packetPath ||
          '_cobolt-output/latest/planning/source-document-consolidation.md',
        targetFile,
        threshold,
      },
      sourceRequirements.reason,
      sourceRequirements.issues,
      options,
    );
  }

  const matched = [];
  const unmatched = [];
  for (const entry of sourceRequirements.entries) {
    const sourceDocument = findSourceDocumentContext(entry, sourceIndex);
    if (isRequirementCovered(entry, targetFeatures, sourceDocument)) {
      matched.push(entry);
    } else {
      unmatched.push(entry);
    }
  }

  const total = sourceRequirements.entries.length;
  const coverage = total === 0 ? 100 : Math.round((matched.length / total) * 100);
  const passed = coverage >= threshold;
  const result = {
    skipped: false,
    consolidationFile: sourceRequirements.sourcePacket.packetPath,
    targetFile,
    threshold,
    totalSourceRequirements: sourceRequirements.allEntries.length,
    includedRequirements: sourceRequirements.entries.length,
    excludedRequirements: sourceRequirements.excludedCount,
    matchedRequirements: matched.length,
    unmatchedRequirements: unmatched.length,
    coverage,
    passed,
    unmatched: unmatched.map((entry) => ({
      id: entry.id,
      sourceFile: entry.sourceFile,
      summary: entry.summary,
      category: entry.category,
    })),
  };

  if (options.writeReport !== false) {
    writeReport(result);
  }
  return { result, exitCode: passed ? 0 : 1 };
}

function runCheck(options = {}) {
  const { threshold = 95, targetFile: targetOpt, includeExcluded = false } = options;
  const targetFile = targetOpt || defaultTargetPath();

  if (!targetFile || !fs.existsSync(targetFile)) {
    return {
      result: null,
      error: `Target artifact not found: ${targetFile}`,
      exitCode: 2,
    };
  }

  const targetContent = fs.readFileSync(targetFile, 'utf8');
  return evaluateCoverageAgainstText(targetContent, {
    threshold,
    targetFile,
    includeExcluded,
    projectRoot: process.cwd(),
    planningDir: planningDir(),
    writeReport: true,
  });
}

function cmdCheck(args) {
  const jsonMode = args.includes('--json');
  const includeExcluded = args.includes('--include-excluded');

  let threshold = 95;
  const thresholdIndex = args.indexOf('--threshold');
  if (thresholdIndex !== -1 && args[thresholdIndex + 1]) {
    threshold = parseInt(args[thresholdIndex + 1], 10);
    if (Number.isNaN(threshold) || threshold < 0 || threshold > 100) {
      process.stderr.write('Error: --threshold must be 0-100\n');
      process.exit(2);
    }
  }

  let targetFile = defaultTargetPath();
  const targetIndex = args.indexOf('--target');
  if (targetIndex !== -1 && args[targetIndex + 1]) {
    targetFile = path.resolve(args[targetIndex + 1]);
  }

  const { result, error, exitCode } = runCheck({ threshold, targetFile, includeExcluded });
  if (error) {
    process.stderr.write(`Error: ${error}\n`);
    process.exit(exitCode);
  }

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(exitCode);
  }

  if (result.skipped) {
    process.stdout.write(`[source-coverage] SKIPPED - ${result.reason}\n`);
    process.exit(0);
  }

  process.stdout.write('[source-coverage] Source Document Coverage Report\n');
  process.stdout.write(
    `  Consolidation: ${path.basename(result.consolidationFile || 'source-document-consolidation.md')}\n`,
  );
  process.stdout.write(`  Target: ${path.basename(result.targetFile || 'prd.md')}\n`);
  if (result.reason) {
    process.stdout.write(`  Reason: ${result.reason}\n`);
  }
  if (Array.isArray(result.issues) && result.issues.length > 0) {
    for (const issue of result.issues) {
      process.stdout.write(`  Issue: ${issue}\n`);
    }
  }
  process.stdout.write(`  Total source requirements: ${result.totalSourceRequirements}\n`);
  process.stdout.write(`  Included (checked): ${result.includedRequirements}\n`);
  process.stdout.write(`  Excluded (intentional): ${result.excludedRequirements}\n`);
  process.stdout.write(`  Matched in target: ${result.matchedRequirements}\n`);
  process.stdout.write(`  Missing from target: ${result.unmatchedRequirements}\n`);
  process.stdout.write(`  Coverage: ${result.coverage}% (threshold: ${result.threshold}%)\n`);
  process.stdout.write(`  Result: ${result.passed ? 'PASS' : 'FAIL'}\n`);

  if (Array.isArray(result.unmatched) && result.unmatched.length > 0) {
    process.stdout.write('\n  Missing requirements:\n');
    for (const entry of result.unmatched) {
      process.stdout.write(`    ${entry.id} [${entry.category}] ${entry.summary} (from ${entry.sourceFile})\n`);
    }
  }

  process.stdout.write(`\n  Report: ${reportPath()}\n`);
  process.exit(exitCode);
}

function cmdStatus() {
  const sourcePacket = getSourcePacketIntegrityStatus(process.cwd(), planningDir(), { minBytes: 1 });
  if (!sourcePacket.required) {
    process.stdout.write('[source-coverage] No source document packet required for this planning run\n');
    process.exit(0);
  }

  if (!sourcePacket.packetExists) {
    process.stdout.write('[source-coverage] Source document packet is required but missing\n');
    for (const issue of sourcePacket.issues) {
      process.stdout.write(`  - ${issue}\n`);
    }
    process.exit(1);
  }

  const entries = parseSourceRegistry(fs.readFileSync(sourcePacket.packetPath, 'utf8'));
  if (entries.length === 0) {
    process.stdout.write(
      '[source-coverage] Source document packet exists but the Source Requirement Registry is missing\n',
    );
    process.exit(1);
  }

  const included = entries.filter((entry) => entry.status === 'included');
  const excluded = entries.filter((entry) => entry.status.startsWith('excluded'));
  const byCategory = {};
  for (const entry of entries) {
    const category = entry.category || 'UNKNOWN';
    if (!byCategory[category]) {
      byCategory[category] = { included: 0, excluded: 0 };
    }
    if (entry.status === 'included') {
      byCategory[category].included++;
    } else {
      byCategory[category].excluded++;
    }
  }

  process.stdout.write('[source-coverage] Source Requirement Registry Summary\n\n');
  process.stdout.write(`  Total entries: ${entries.length}\n`);
  process.stdout.write(`  Included: ${included.length}\n`);
  process.stdout.write(`  Excluded: ${excluded.length}\n\n`);
  process.stdout.write('  By category:\n');
  for (const [category, counts] of Object.entries(byCategory)) {
    process.stdout.write(`    ${category}: ${counts.included} included, ${counts.excluded} excluded\n`);
  }
  process.exit(0);
}

function cmdInputDocs(args) {
  const jsonMode = args.includes('--json');
  const { result, exitCode } = evaluateInputDocumentCoverage({
    projectRoot: process.cwd(),
    planningDir: planningDir(),
    writeReport: true,
  });

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(exitCode);
  }

  if (result.skipped) {
    process.stdout.write(`[source-coverage] SKIPPED - ${result.reason}\n`);
    process.exit(0);
  }

  process.stdout.write('[source-coverage] Source Input Document Coverage\n');
  process.stdout.write(`  Expected input documents: ${result.expectedCount}\n`);
  process.stdout.write(`  Registry-covered documents: ${result.registryCoveredCount}\n`);
  if (result.issues.length > 0) {
    for (const issue of result.issues) {
      process.stdout.write(`  Issue: ${issue}\n`);
    }
  }
  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      process.stdout.write(`  Warning: ${warning}\n`);
    }
  }
  if (result.missingRegistryDocuments.length > 0) {
    process.stdout.write('\n  Missing input documents:\n');
    for (const documentPath of result.missingRegistryDocuments) {
      process.stdout.write(`    ${documentPath}\n`);
    }
  }
  process.stdout.write(`\n  Report: ${inputDocumentCoverageReportPath()}\n`);
  process.exit(exitCode);
}

function cmdReport(args) {
  const formatIndex = args.indexOf('--format');
  const format = formatIndex !== -1 && args[formatIndex + 1] ? args[formatIndex + 1] : 'json';
  const reportFile = reportPath();

  if (!fs.existsSync(reportFile)) {
    const { error } = runCheck({ threshold: 0 });
    if (error) {
      process.stderr.write(`Error: ${error}\n`);
      process.exit(2);
    }
  }

  if (!fs.existsSync(reportFile)) {
    process.stderr.write('Error: Could not generate source coverage report\n');
    process.exit(2);
  }

  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  if (format === 'md') {
    process.stdout.write('# Source Coverage Report\n\n');
    process.stdout.write('| Metric | Value |\n|--------|-------|\n');
    process.stdout.write(`| Total source requirements | ${report.totalSourceRequirements || 0} |\n`);
    process.stdout.write(`| Included (checked) | ${report.includedRequirements || 0} |\n`);
    process.stdout.write(`| Excluded (intentional) | ${report.excludedRequirements || 0} |\n`);
    process.stdout.write(`| Matched | ${report.matchedRequirements || 0} |\n`);
    process.stdout.write(`| Missing | ${report.unmatchedRequirements || 0} |\n`);
    process.stdout.write(`| Coverage | ${report.coverage}% |\n`);
    process.stdout.write(`| Result | ${report.passed ? 'PASS' : 'FAIL'} |\n`);
    if (report.reason) {
      process.stdout.write(`| Reason | ${report.reason} |\n`);
    }
    process.stdout.write('\n');

    if (Array.isArray(report.unmatched) && report.unmatched.length > 0) {
      process.stdout.write('## Missing Requirements\n\n');
      process.stdout.write('| ID | Category | Summary | Source |\n|-----|----------|---------|--------|\n');
      for (const entry of report.unmatched) {
        process.stdout.write(`| ${entry.id} | ${entry.category} | ${entry.summary} | ${entry.sourceFile} |\n`);
      }
    }
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

function printUsage() {
  process.stdout.write(`
CoBolt Source Coverage - deterministic source document traceability

Usage:
  node tools/cobolt-source-coverage.js check [--target <path>] [--threshold <n>] [--json]
  node tools/cobolt-source-coverage.js input-docs [--json]
  node tools/cobolt-source-coverage.js status
  node tools/cobolt-source-coverage.js report [--format md|json]

Commands:
  check     Compare source requirements against target artifact (default: prd.md)
  input-docs
            Verify every user-provided input document has an included/excluded/deferred SRC row
  status    Print source requirement registry summary
  report    Generate full coverage report

Options:
  --target <path>       Artifact to check against (default: prd.md)
  --threshold <n>       Minimum coverage % (default: 95)
  --json                Machine-readable JSON output
  --include-excluded    Include excluded items in coverage calculation
  --format <md|json>    Report format (default: json)

Exit codes:
  0  Coverage >= threshold (or skipped - no source docs)
  1  Coverage < threshold, or required source packet/registry missing
  2  Usage error or file not found
`);
}

function main() {
  const args = process.argv.slice(2);
  let command = args[0];
  let commandArgs = args.slice(1);

  // v0.61 (D04): when invoked with bare flags (no leading subcommand),
  // default to `check` so `cobolt-source-coverage --json` works the same
  // as `cobolt-source-coverage check --json`. Pre-fix, any arg starting
  // with `--` (other than --help) hit the "Unknown command" branch and
  // the tool exited 1 — a tiny ergonomic gap that surprised users who
  // expected the modern CLI convention. Help / -h / undefined still
  // route to printUsage; explicit `check`/`status`/`report` still route
  // normally.
  if (typeof command === 'string' && command.startsWith('--') && command !== '--help') {
    commandArgs = args.slice(0);
    command = 'check';
  }

  switch (command) {
    case 'check':
      cmdCheck(commandArgs);
      break;
    case 'input-docs':
      cmdInputDocs(commandArgs);
      break;
    case 'status':
      cmdStatus(commandArgs);
      break;
    case 'report':
      cmdReport(commandArgs);
      break;
    case '--help':
    case '-h':
    case undefined:
      printUsage();
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      printUsage();
      process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluateInputDocumentCoverage,
  evaluateCoverageAgainstText,
  extractKeywords,
  getSourceRequirementSet,
  isRequirementCovered,
  parseSourceRegistry,
  runCheck,
};
