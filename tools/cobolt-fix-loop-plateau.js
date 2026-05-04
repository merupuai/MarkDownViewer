#!/usr/bin/env node

// CoBolt Fix Loop Plateau — signature-based plateau detection.
//
// Extends the finding-count delta detector in cobolt-fix-verdict.js with
// bug-signature hashing so the loop can recognize "same bug reshaped across
// files" — the classic integration-bug shape where unit-fix agents churn
// symptom-files forever without resolving the real cross-component defect.
//
// Signature = sha256(normalized_stack_trace + "||" + sorted(file_A + file_B)).
// Normalization strips line numbers, absolute paths, timestamps, pids, uuids,
// and other volatile tokens so that the same bug produces the same signature
// across iterations even when the crash line drifts.
//
// Plateau = same signature observed in >= 3 consecutive iterations, regardless
// of finding count delta. Cross-BC auto-escalation = signature's owning files
// map to >= 2 distinct bounded contexts AND at least 2 unit-fix iterations
// have already been spent on this signature.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SIGNATURE_PLATEAU_WINDOW = 3;
const UNIT_FIX_ATTEMPT_CAP = 2;
const TELEMETRY_RELATIVE_PATH = path.join('_cobolt-output', 'audit', 'fix-loop-telemetry.jsonl');

const VOLATILE_TOKEN_PATTERNS = [
  /\b0x[0-9a-f]{4,}\b/gi,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b\d{10,}\b/g,
  /\bpid[=: ]\d+/gi,
  /\btid[=: ]\d+/gi,
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]*/g,
];

function normalizeStackTrace(raw) {
  if (!raw) return '';
  const text = Array.isArray(raw) ? raw.join('\n') : String(raw);
  let out = text
    .replace(/\r\n/g, '\n')
    .replace(/[A-Z]:\\[^\s:]+/g, (match) => path.basename(match.replace(/\\/g, '/')))
    .replace(/\/[^\s:]+\/([^/\s:]+)/g, '$1')
    .replace(/:(\d+)(?::(\d+))?/g, ':L')
    .replace(/\bline\s+\d+/gi, 'line L');
  for (const pattern of VOLATILE_TOKEN_PATTERNS) {
    out = out.replace(pattern, '');
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .toLowerCase();
}

function extractFindingFiles(finding) {
  const files = new Set();
  const locFile = finding?.location?.file;
  if (typeof locFile === 'string' && locFile.trim()) files.add(locFile.trim());
  if (typeof finding?.file === 'string' && finding.file.trim()) files.add(finding.file.trim());
  for (const key of ['relatedFiles', 'files', 'affectedFiles']) {
    const list = finding?.[key];
    if (Array.isArray(list)) {
      for (const item of list) {
        if (typeof item === 'string' && item.trim()) files.add(item.trim());
      }
    }
  }
  const evidence = finding?.evidence;
  if (evidence && typeof evidence === 'object') {
    for (const key of ['files', 'relatedFiles', 'affectedFiles']) {
      const list = evidence[key];
      if (Array.isArray(list)) {
        for (const item of list) {
          if (typeof item === 'string' && item.trim()) files.add(item.trim());
        }
      }
    }
  }
  return [...files].map((f) => f.replace(/\\/g, '/'));
}

function extractFindingTrace(finding) {
  const candidates = [
    finding?.stackTrace,
    finding?.failureTrace,
    finding?.trace,
    finding?.evidence?.stackTrace,
    finding?.evidence?.failureTrace,
    finding?.evidence?.trace,
    finding?.evidence?.errorText,
    finding?.description,
  ];
  for (const candidate of candidates) {
    if (candidate && (typeof candidate === 'string' || Array.isArray(candidate))) return candidate;
  }
  return '';
}

function computeBugSignature(finding) {
  const normalizedTrace = normalizeStackTrace(extractFindingTrace(finding));
  const files = extractFindingFiles(finding).sort();
  const pair = files.length >= 2 ? [files[0], files[1]].join('+') : files.join('+');
  const input = `${normalizedTrace}||${pair}`;
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return {
    hash,
    files,
    filePair: files.length >= 2 ? [files[0], files[1]] : files,
    traceNormalized: normalizedTrace,
  };
}

function bucketSignaturesForFindings(findings) {
  if (!Array.isArray(findings)) return new Map();
  const buckets = new Map();
  for (const finding of findings) {
    const sig = computeBugSignature(finding);
    const entry = buckets.get(sig.hash) || {
      hash: sig.hash,
      filePair: sig.filePair,
      files: sig.files,
      findingIds: [],
    };
    entry.findingIds.push(String(finding?.id || ''));
    buckets.set(sig.hash, entry);
  }
  return buckets;
}

// Build per-iteration signature sets from iterationLog entries that carry
// either an explicit `findings` snapshot or a pre-computed `bugSignatures`
// array. Older entries without either field contribute an empty set (they
// cannot participate in a plateau).
function iterationSignatureSets(iterationLog) {
  if (!Array.isArray(iterationLog)) return [];
  return iterationLog.map((entry) => {
    if (Array.isArray(entry?.bugSignatures) && entry.bugSignatures.length > 0) {
      return new Set(entry.bugSignatures.map((s) => (typeof s === 'string' ? s : s?.hash)).filter(Boolean));
    }
    if (Array.isArray(entry?.findings)) {
      return new Set([...bucketSignaturesForFindings(entry.findings).keys()]);
    }
    return new Set();
  });
}

function detectSignaturePlateau(iterationLog, currentFindings, options = {}) {
  const window = options.window || SIGNATURE_PLATEAU_WINDOW;
  const currentBuckets = bucketSignaturesForFindings(currentFindings || []);
  const currentSignatures = new Set(currentBuckets.keys());
  if (currentSignatures.size === 0) return { detected: false, signatures: [], window };

  const priorSets = iterationSignatureSets(iterationLog);
  const needPrior = window - 1;
  if (priorSets.length < needPrior) return { detected: false, signatures: [], window };
  const recent = priorSets.slice(-needPrior);

  const persistent = [];
  for (const hash of currentSignatures) {
    const inAllPrior = recent.every((set) => set.has(hash));
    if (inAllPrior) persistent.push(hash);
  }

  if (persistent.length === 0) return { detected: false, signatures: [], window };
  return {
    detected: true,
    signatures: persistent.map((hash) => currentBuckets.get(hash)),
    window,
  };
}

function countSignatureUnitFixIterations(iterationLog, signatureHash) {
  if (!Array.isArray(iterationLog) || !signatureHash) return 0;
  let count = 0;
  const unitVerdicts = new Set(['LOOP', 'LOOP_REVERT', 'LOOP_PIVOT']);
  for (const entry of iterationLog) {
    if (!entry || !unitVerdicts.has(String(entry.verdict))) continue;
    const sigs = Array.isArray(entry.bugSignatures)
      ? entry.bugSignatures.map((s) => (typeof s === 'string' ? s : s?.hash)).filter(Boolean)
      : Array.isArray(entry.findings)
        ? [...bucketSignaturesForFindings(entry.findings).keys()]
        : [];
    if (sigs.includes(signatureHash)) count += 1;
  }
  return count;
}

// Load bounded contexts once per call. Returns null when absent or single-ctx.
function loadBoundedContexts(cwd = process.cwd()) {
  const bcPath = path.join(cwd, '_cobolt-output', 'latest', 'planning', 'bounded-contexts.json');
  if (!fs.existsSync(bcPath)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(bcPath, 'utf8'));
  } catch {
    return null;
  }
  if (!data || data.strategy === 'single-context') return null;
  const contexts = Array.isArray(data.boundedContexts) ? data.boundedContexts : [];
  if (contexts.length <= 1) return null;
  return data;
}

function patternSpecificity(pattern) {
  const wildcards = (pattern.match(/\*/g) || []).length;
  return pattern.length - wildcards * 10;
}

function pathMatches(pattern, filePath) {
  const re = new RegExp(
    `^${pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '§DOUBLESTAR§')
      .replace(/\*/g, '[^/]*')
      .replace(/§DOUBLESTAR§/g, '.*')}$`,
  );
  return re.test(filePath);
}

function bcForFile(bcData, filePath, cwd = process.cwd()) {
  if (!bcData) return null;
  const normalizedCwd = cwd.replace(/\\/g, '/');
  const rel = filePath.replace(/\\/g, '/').replace(`${normalizedCwd}/`, '').replace(/^\.\//, '');
  const matches = [];
  for (const bc of bcData.boundedContexts || []) {
    for (const pat of bc.ownedPaths || []) {
      if (pathMatches(pat, rel)) {
        matches.push({ bc, specificity: patternSpecificity(pat) });
      }
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.specificity - a.specificity);
  return matches[0].bc;
}

function classifyBCCrossing(signature, bcData, cwd = process.cwd()) {
  if (!signature || !bcData) return { crossesBC: false, bcs: [] };
  const bcs = [];
  const seen = new Set();
  for (const file of signature.files || []) {
    const bc = bcForFile(bcData, file, cwd);
    if (bc && !seen.has(bc.id)) {
      seen.add(bc.id);
      bcs.push({ id: bc.id, file });
    }
  }
  return { crossesBC: bcs.length >= 2, bcs };
}

function writeTelemetry(record, cwd = process.cwd()) {
  try {
    const telemetryPath = path.join(cwd, TELEMETRY_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(telemetryPath), { recursive: true });
    const entry = { timestamp: new Date().toISOString(), ...record };
    fs.appendFileSync(telemetryPath, `${JSON.stringify(entry)}\n`, 'utf8');
    return telemetryPath;
  } catch {
    return null;
  }
}

function cmdAnalyze(args) {
  const trackerIdx = args.indexOf('--tracker');
  const trackerPath = trackerIdx !== -1 ? args[trackerIdx + 1] : null;
  if (!trackerPath || !fs.existsSync(trackerPath)) {
    console.error('Usage: node tools/cobolt-fix-loop-plateau.js analyze --tracker <path>');
    process.exit(3);
  }
  const tracker = JSON.parse(fs.readFileSync(trackerPath, 'utf8'));
  const findings = Array.isArray(tracker.findings) ? tracker.findings : [];
  const buckets = bucketSignaturesForFindings(findings);
  const bcData = loadBoundedContexts();
  const out = {
    signatures: [...buckets.values()].map((entry) => ({
      ...entry,
      bcCrossing: classifyBCCrossing(entry, bcData),
    })),
  };
  console.log(JSON.stringify(out, null, 2));
}

if (require.main === module) {
  const [, , command, ...args] = process.argv;
  switch (command) {
    case 'analyze':
      cmdAnalyze(args);
      break;
    default:
      console.log('CoBolt Fix Loop Plateau - signature-based plateau detection');
      console.log('');
      console.log('Usage:');
      console.log('  node tools/cobolt-fix-loop-plateau.js analyze --tracker <path>');
      process.exit(command ? 3 : 0);
  }
}

module.exports = {
  SIGNATURE_PLATEAU_WINDOW,
  UNIT_FIX_ATTEMPT_CAP,
  TELEMETRY_RELATIVE_PATH,
  normalizeStackTrace,
  extractFindingFiles,
  extractFindingTrace,
  computeBugSignature,
  bucketSignaturesForFindings,
  iterationSignatureSets,
  detectSignaturePlateau,
  countSignatureUnitFixIterations,
  loadBoundedContexts,
  bcForFile,
  classifyBCCrossing,
  writeTelemetry,
};
