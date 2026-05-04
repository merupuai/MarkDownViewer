#!/usr/bin/env node

// CoBolt Spec Verify — Deterministic impl-spec verification against disk
//
// Reads story implementation specs (Step 01A), extracts File Map entries and
// Function Signatures, then verifies each one exists on disk. Census-based:
// checks ALL items, not a sample.
//
// Usage:
//   node tools/cobolt-spec-verify.js <milestone> [--round <N>] [--json] [--out <file>] [--strict]
//   node tools/cobolt-spec-verify.js M1 --round 2 --json
//   node tools/cobolt-spec-verify.js M1 --summary
//
// Modes:
//   (default)       Verify all tasks in the milestone
//   --round <N>     Verify only tasks assigned to round N
//   --strict        Exit 1 if ANY task is not fully complete
//   --summary       Print one-line per-task status
//   --json          Output machine-readable JSON
//
// Returns:
//   exit 0: all tasks verified (or non-strict mode with partials)
//   exit 1: missing/partial tasks found (strict mode)
//   exit 2: cannot run (missing specs, manifest, etc.)

const fs = require('node:fs');
const path = require('node:path');

// ── Helpers ───────────────────────────────────────────────────

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function optionValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : null;
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

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function fileExists(filePath) {
  try {
    const resolved = path.resolve(process.cwd(), filePath);
    return fs.existsSync(resolved) && fs.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

function fileHasContent(filePath, minBytes = 10) {
  try {
    const resolved = path.resolve(process.cwd(), filePath);
    const stat = fs.statSync(resolved);
    return stat.isFile() && stat.size >= minBytes;
  } catch {
    return false;
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fileLayerParts(filePath) {
  const normalized = String(filePath || '')
    .replace(/\\/g, '/')
    .toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  const base = path.basename(normalized).replace(/\.(?:[cm]?[jt]sx?|py|go|rs|java|cs)$/u, '');
  const dotted = base.split('.').filter(Boolean);
  return { segments, dotted };
}

function hasLayerMarker(filePath, markers) {
  const { segments, dotted } = fileLayerParts(filePath);
  const markerSet = new Set(markers.map((marker) => marker.toLowerCase()));
  if (dotted.some((part) => markerSet.has(part))) return true;
  return segments.some((segment) => markerSet.has(segment) || markerSet.has(segment.replace(/s$/u, '')));
}

/**
 * Search for a function/method name in a file using simple text matching.
 * Supports common patterns across JS/TS/Go/Python/Rust/Elixir.
 */
function functionExistsInFile(filePath, functionName) {
  const resolved = path.resolve(process.cwd(), filePath);
  const content = readText(resolved);
  if (!content) return false;

  // Clean the function name (remove parens, params, return types)
  const cleanName = functionName
    .replace(/\(.*$/, '')
    .replace(/^(async\s+|export\s+|pub\s+|fn\s+|func\s+|def\s+|function\s+)/, '')
    .trim();

  if (!cleanName || cleanName.length < 2) return false;

  const patterns = [
    new RegExp(`\\bfunction\\s+${escapeRegex(cleanName)}\\s*[(<]`),
    new RegExp(`\\b(?:const|let|var)\\s+${escapeRegex(cleanName)}\\s*=`),
    new RegExp(`\\b${escapeRegex(cleanName)}\\s*[:(]`),
    new RegExp(`\\bfunc\\s+(?:\\([^)]*\\)\\s+)?${escapeRegex(cleanName)}\\s*\\(`),
    new RegExp(`\\bdef\\s+${escapeRegex(cleanName)}\\s*\\(`),
    new RegExp(`\\bfn\\s+${escapeRegex(cleanName)}\\s*[(<]`),
    new RegExp(`\\bdefp?\\s+${escapeRegex(cleanName)}\\s*[(/]`),
    new RegExp(`^\\s+(?:async\\s+)?${escapeRegex(cleanName)}\\s*\\(`, 'm'),
  ];

  return patterns.some((p) => p.test(content));
}

/**
 * Check if a function body contains TODO/FIXME/HACK stubs indicating incomplete implementation.
 * Returns { hasStubs: boolean, stubMarkers: string[] }
 */
function functionHasStubs(filePath, functionName) {
  const resolved = path.resolve(process.cwd(), filePath);
  const content = readText(resolved);
  if (!content) return { hasStubs: false, stubMarkers: [] };

  const cleanName = functionName
    .replace(/\(.*$/, '')
    .replace(/^(async\s+|export\s+|pub\s+|fn\s+|func\s+|def\s+|function\s+)/, '')
    .trim();
  if (!cleanName || cleanName.length < 2) return { hasStubs: false, stubMarkers: [] };

  // Find the function's approximate body (from declaration to next function or end)
  const funcStart = content.search(new RegExp(`\\b${escapeRegex(cleanName)}\\s*[(<]`));
  if (funcStart < 0) return { hasStubs: false, stubMarkers: [] };

  // Extract ~200 lines after function start as approximate body
  const bodySlice = content.slice(funcStart, funcStart + 5000);

  const stubPatterns = [
    /\/\/\s*TODO\b/i,
    /\/\/\s*FIXME\b/i,
    /\/\/\s*HACK\b/i,
    /\/\/\s*STUB\b/i,
    /\/\/\s*PLACEHOLDER\b/i,
    /#\s*TODO\b/i,
    /#\s*FIXME\b/i, // Python
    /panic\("not implemented"\)/, // Go
    /raise NotImplementedError/, // Python
    /throw new Error\(['"]not implemented/i, // JS/TS
    /unimplemented!\(\)/, // Rust
    /todo!\(\)/, // Rust
  ];

  const stubMarkers = [];
  for (const p of stubPatterns) {
    const match = bodySlice.match(p);
    if (match) stubMarkers.push(match[0].trim());
  }

  return { hasStubs: stubMarkers.length > 0, stubMarkers };
}

/**
 * Check if a file contains TODO/FIXME/HACK markers anywhere (file-level stub detection).
 * Returns count of stub markers found.
 */
function countFileStubs(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  const content = readText(resolved);
  if (!content) return 0;
  const markers = content.match(/(?:\/\/|#)\s*(?:TODO|FIXME|HACK|STUB|PLACEHOLDER)\b/gi);
  return markers ? markers.length : 0;
}

// ── Impl-Spec Parsing ────────────────────────────────────────

/**
 * Parse a story impl-spec markdown file and extract:
 * - File Map entries (action, path, purpose, taskId)
 * - Function Signatures (name, file where it should live)
 * - Task implementation order
 */
// M5-followup FIX 2 (2026-05-02): impl-spec File Map cells often arrive
// wrapped in markdown formatters (backticks for code paths, occasionally
// quotes). Without stripping, fs.existsSync receives literal "`apps/x.ex`"
// and reports the file missing even when it exists on disk. See
// merupuai/maas M5 carry-forward (M5-CF-02): all 29 missingFiles entries
// in M5-spec-verify-full.json were this false positive.
function stripPathFormatting(raw) {
  if (raw == null) return '';
  let s = String(raw).trim();
  // Strip surrounding double-backtick (rare): ``path``
  if (/^``.+``$/.test(s)) s = s.slice(2, -2).trim();
  // Strip surrounding single-backtick: `path`
  if (/^`.+`$/.test(s)) s = s.slice(1, -1).trim();
  // Strip wrapping single or double quotes: "path" or 'path'
  if (/^"[^"]+"$/.test(s)) s = s.slice(1, -1).trim();
  if (/^'[^']+'$/.test(s)) s = s.slice(1, -1).trim();
  return s;
}

function parseImplSpec(specContent, storyId) {
  const result = { storyId, fileMap: [], functions: [], tasks: [] };
  if (!specContent) return result;

  // ── Parse File Map table ──
  for (const line of specContent.split(/\r?\n/u)) {
    if (!line.includes('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (!/^(create|modify)$/iu.test(cells[0] || '')) continue;
    const action = cells[0].toLowerCase();
    const filePath = stripPathFormatting(cells[1] || '');
    let purpose = cells.length >= 4 ? cells[2] || '' : '';
    let taskId = cells.length >= 4 ? cells[3] || '' : cells[2] || '';
    if (!taskId && /^[A-Z]*\d+(?:[-_:][A-Z0-9]+)*$/i.test(purpose)) {
      taskId = purpose.toUpperCase();
      purpose = '';
    }
    if (filePath === 'File Path' || filePath.startsWith('---') || !filePath) continue;
    result.fileMap.push({ action, filePath, purpose, taskId });
  }

  // ── Parse Function Signatures ──
  const funcSection = specContent.match(/### Function Signatures[\s\S]*?(?=\n### |\n## |$)/);
  if (funcSection) {
    const funcRegex = /^[-*]\s+`?([a-zA-Z_]\w*)\s*\(/gm;
    let funcMatch;
    while ((funcMatch = funcRegex.exec(funcSection[0])) !== null) {
      const funcName = funcMatch[1].trim();
      if (funcName && funcName.length > 1) {
        result.functions.push({ name: funcName });
      }
    }
  }

  // ── Parse Implementation Order ──
  const orderSection = specContent.match(/### Implementation Order[\s\S]*?(?=\n### |\n## |$)/);
  if (orderSection) {
    const taskRegex = /^\d+\.\s+(T\d+):/gm;
    let taskMatch;
    while ((taskMatch = taskRegex.exec(orderSection[0])) !== null) {
      result.tasks.push(taskMatch[1]);
    }
  }

  // ── Parse API Endpoints ──
  const apiSection = specContent.match(/### API Endpoints[\s\S]*?(?=\n### |\n## |$)/);
  if (apiSection) {
    const epRegex = /^\s*[-*]\s+\*?\*?(GET|POST|PUT|PATCH|DELETE)\*?\*?\s+[`]?(\/?[a-zA-Z0-9/:_\-{}.]+)[`]?/gim;
    let epMatch;
    while ((epMatch = epRegex.exec(apiSection[0])) !== null) {
      result.apiEndpoints = result.apiEndpoints || [];
      result.apiEndpoints.push({ method: epMatch[1].toUpperCase(), path: epMatch[2].trim() });
    }
  }

  // ── Map functions to files via proximity in the spec text ──
  for (const func of result.functions) {
    const contextRegex = new RegExp(
      `([a-zA-Z0-9_/.-]+\\.[a-zA-Z]+)[^\\n]*${escapeRegex(func.name)}|` +
        `${escapeRegex(func.name)}[^\\n]*?([a-zA-Z0-9_/.-]+\\.[a-zA-Z]+)`,
      'i',
    );
    const contextMatch = specContent.match(contextRegex);
    if (contextMatch) {
      func.expectedFile = (contextMatch[1] || contextMatch[2] || '').trim();
    }
    if (!func.expectedFile) {
      for (const fm of result.fileMap) {
        if (fm.action === 'create' && fm.filePath.match(/\.(js|ts|tsx|jsx|go|py|rs|ex|exs)$/)) {
          const nearFunc = specContent.indexOf(func.name);
          const nearPath = specContent.indexOf(fm.filePath);
          if (nearFunc >= 0 && nearPath >= 0 && Math.abs(nearFunc - nearPath) < 500) {
            func.expectedFile = fm.filePath;
            break;
          }
        }
      }
    }
  }

  return result;
}

// ── Verification Engine ──────────────────────────────────────

/**
 * Verify a parsed impl-spec against disk state.
 * Returns per-task verification results.
 */
function verifySpec(parsed) {
  const results = {
    storyId: parsed.storyId,
    tasks: {},
    fileMap: [],
    functions: [],
    summary: { total: 0, complete: 0, partial: 0, missing: 0 },
  };

  // ── Verify File Map ──
  for (const entry of parsed.fileMap) {
    const exists = fileExists(entry.filePath);
    const hasContent = exists && fileHasContent(entry.filePath);
    const stubCount = hasContent ? countFileStubs(entry.filePath) : 0;
    const status = hasContent ? (stubCount > 2 ? 'stubbed' : 'present') : exists ? 'empty' : 'missing';

    results.fileMap.push({ ...entry, status, exists, hasContent, stubCount });

    if (entry.taskId) {
      if (!results.tasks[entry.taskId]) {
        results.tasks[entry.taskId] = {
          taskId: entry.taskId,
          files: { total: 0, present: 0, missing: 0 },
          functions: { total: 0, found: 0, missing: 0 },
          specStatus: 'missing',
        };
      }
      const task = results.tasks[entry.taskId];
      task.files.total++;
      if (hasContent) task.files.present++;
      else task.files.missing++;
    }
  }

  // ── Verify Function Signatures ──
  for (const func of parsed.functions) {
    let found = false;
    const searchedIn = [];

    if (func.expectedFile && fileExists(func.expectedFile)) {
      found = functionExistsInFile(func.expectedFile, func.name);
      searchedIn.push(func.expectedFile);
    }

    if (!found) {
      for (const entry of parsed.fileMap) {
        if (entry.status !== 'missing' && !searchedIn.includes(entry.filePath)) {
          if (functionExistsInFile(entry.filePath, func.name)) {
            found = true;
            searchedIn.push(entry.filePath);
            break;
          }
          searchedIn.push(entry.filePath);
        }
      }
    }

    // Check for TODO/FIXME stubs in found functions
    let hasStubs = false;
    let stubMarkers = [];
    if (found) {
      const stubCheck = functionHasStubs(searchedIn[searchedIn.length - 1] || func.expectedFile, func.name);
      hasStubs = stubCheck.hasStubs;
      stubMarkers = stubCheck.stubMarkers;
    }

    results.functions.push({
      name: func.name,
      expectedFile: func.expectedFile || null,
      found,
      hasStubs,
      stubMarkers,
      searchedIn,
    });

    for (const entry of parsed.fileMap) {
      if (entry.taskId && func.expectedFile === entry.filePath) {
        if (results.tasks[entry.taskId]) {
          results.tasks[entry.taskId].functions.total++;
          if (found) results.tasks[entry.taskId].functions.found++;
          else results.tasks[entry.taskId].functions.missing++;
        }
        break;
      }
    }
  }

  // ── Cross-layer wiring check ──
  // For files in the File Map: check if "handler" files import "repo/service" files
  results.wiringGaps = [];
  const handlerFiles = parsed.fileMap.filter(
    (f) => hasLayerMarker(f.filePath, ['handler', 'controller', 'route', 'api', 'endpoint']) && f.status !== 'missing',
  );
  const repoFiles = parsed.fileMap.filter(
    (f) =>
      hasLayerMarker(f.filePath, ['repo', 'repository', 'service', 'store', 'model', 'domain']) &&
      f.status !== 'missing',
  );

  for (const handler of handlerFiles) {
    const handlerContent = readText(path.resolve(process.cwd(), handler.filePath));
    if (!handlerContent) continue;
    for (const repo of repoFiles) {
      if (repo.filePath === handler.filePath) continue;
      // Check if handler imports/requires the repo file
      const repoBase = path.basename(repo.filePath, path.extname(repo.filePath));
      const importPattern = new RegExp(`(?:require|import|from)\\s*[('"].*${escapeRegex(repoBase)}[)'"]`, 'i');
      if (!importPattern.test(handlerContent)) {
        results.wiringGaps.push({
          handler: handler.filePath,
          repo: repo.filePath,
          issue: `Handler does not import repo/service: ${repoBase}`,
        });
      }
    }
  }

  // ── Compute per-task specStatus (stub-aware) ──
  // Count functions with stubs per task
  for (const func of results.functions) {
    if (func.hasStubs) {
      for (const entry of parsed.fileMap) {
        if (entry.taskId && func.expectedFile === entry.filePath && results.tasks[entry.taskId]) {
          if (!results.tasks[entry.taskId].functions.stubbed) results.tasks[entry.taskId].functions.stubbed = 0;
          results.tasks[entry.taskId].functions.stubbed++;
          break;
        }
      }
    }
  }

  for (const task of Object.values(results.tasks)) {
    const allFilesPresent = task.files.missing === 0 && task.files.total > 0;
    const allFunctionsFound = task.functions.missing === 0;
    const hasStubs = (task.functions.stubbed || 0) > 0;
    const hasAnyFile = task.files.present > 0;

    if (allFilesPresent && allFunctionsFound && !hasStubs) {
      task.specStatus = 'complete';
      results.summary.complete++;
    } else if (hasAnyFile) {
      task.specStatus = 'partial';
      results.summary.partial++;
    } else {
      task.specStatus = 'missing';
      results.summary.missing++;
    }
    results.summary.total++;
  }

  return results;
}

// ── Round Scoping ────────────────────────────────────────────

function getStoryIdsForRound(testPlan, roundNum) {
  if (!testPlan?.rounds) return null;
  const round = testPlan.rounds.find((r) => r.id === roundNum || r.roundNumber === roundNum || r.round === roundNum);
  if (!round) return null;
  const storyIds = new Set();
  for (const tf of round.testFiles || []) {
    for (const s of tf.stories || []) storyIds.add(s);
  }
  return storyIds;
}

function getTasksForRound(taskManifest, roundNum) {
  const taskIds = new Set();
  if (!taskManifest) return taskIds;
  for (const epic of taskManifest.epics || []) {
    for (const story of epic.stories || []) {
      for (const task of story.tasks || []) {
        if (task.wave === roundNum || task.round === roundNum) taskIds.add(task.id);
      }
    }
  }
  return taskIds;
}

// ── Main ─────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const milestone = args.find((a) => /^M\d+$/i.test(a));
  const roundFlag = args.indexOf('--round');
  const roundNum = roundFlag >= 0 ? parseInt(args[roundFlag + 1], 10) : null;
  const jsonOut = optionValue(args, '--out');
  const jsonMode = args.includes('--json') || Boolean(jsonOut);
  // v0.29: --strict is now the default; --loose preserves the prior advisory
  // exit-0 behavior for non-blocking call sites. Kept as a no-op for backward
  // compatibility.
  const loose = args.includes('--loose');
  const summaryMode = args.includes('--summary');

  if (!milestone) {
    console.error(
      'Usage: cobolt-spec-verify.js <milestone> [--round <N>] [--json] [--out <file>] [--loose] [--strict]',
    );
    process.exit(2);
  }

  const cwd = process.cwd();
  const buildDir = path.join(cwd, '_cobolt-output', 'latest', 'build', milestone);
  const buildSpecsDir = path.join(buildDir, `${milestone}-story-specs`);
  const planningSpecsDir = path.join(cwd, '_cobolt-output', 'latest', 'planning', 'story-specs');

  // Check build dir first (during build), fallback to planning dir (during planning)
  const specsDir = fs.existsSync(buildSpecsDir) ? buildSpecsDir : planningSpecsDir;
  const taskManifestPath = path.join(buildDir, `${milestone}-task-manifest.json`);
  const testPlanPath = path.join(buildDir, `${milestone}-test-plan.json`);

  if (!fs.existsSync(specsDir)) {
    const msg = `ERROR: Story specs directory not found: ${specsDir}`;
    if (jsonMode) emitJson({ error: msg, passed: false }, jsonOut);
    else console.error(msg);
    process.exit(2);
  }

  const taskManifest = readJson(taskManifestPath);
  const testPlan = readJson(testPlanPath);

  const specFiles = fs.readdirSync(specsDir).filter((f) => f.endsWith('-impl-spec.md'));
  if (specFiles.length === 0) {
    const msg = `ERROR: No impl-spec files found in ${specsDir}`;
    if (jsonMode) emitJson({ error: msg, passed: false }, jsonOut);
    else console.error(msg);
    process.exit(2);
  }

  const roundStoryIds = roundNum ? getStoryIdsForRound(testPlan, roundNum) : null;
  const roundTaskIds = roundNum && taskManifest ? getTasksForRound(taskManifest, roundNum) : null;

  const allResults = [];
  const cum = {
    milestone,
    round: roundNum,
    stories: { total: 0, complete: 0, partial: 0, missing: 0 },
    tasks: { total: 0, complete: 0, partial: 0, missing: 0 },
    files: { total: 0, present: 0, missing: 0, empty: 0 },
    functions: { total: 0, found: 0, missing: 0 },
  };

  for (const specFile of specFiles) {
    const storyId = specFile.replace('-impl-spec.md', '');
    if (roundStoryIds && !roundStoryIds.has(storyId)) continue;

    const specContent = readText(path.join(specsDir, specFile));
    const parsed = parseImplSpec(specContent, storyId);
    const verified = verifySpec(parsed);

    if (roundTaskIds && roundTaskIds.size > 0) {
      for (const taskId of Object.keys(verified.tasks)) {
        if (!roundTaskIds.has(taskId)) delete verified.tasks[taskId];
      }
      verified.summary = { total: 0, complete: 0, partial: 0, missing: 0 };
      for (const task of Object.values(verified.tasks)) {
        verified.summary.total++;
        verified.summary[task.specStatus]++;
      }
    }

    allResults.push(verified);

    const storyComplete =
      verified.summary.missing === 0 && verified.summary.partial === 0 && verified.summary.total > 0;
    const storyPartial = verified.summary.complete > 0 || verified.summary.partial > 0;
    cum.stories.total++;
    if (storyComplete) cum.stories.complete++;
    else if (storyPartial) cum.stories.partial++;
    else cum.stories.missing++;

    cum.tasks.total += verified.summary.total;
    cum.tasks.complete += verified.summary.complete;
    cum.tasks.partial += verified.summary.partial;
    cum.tasks.missing += verified.summary.missing;

    for (const f of verified.fileMap) {
      cum.files.total++;
      if (f.hasContent) cum.files.present++;
      else if (f.exists) cum.files.empty++;
      else cum.files.missing++;
    }
    for (const fn of verified.functions) {
      cum.functions.total++;
      if (fn.found) cum.functions.found++;
      else cum.functions.missing++;
    }
  }

  const pct = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(1) : '100.0');
  const filesPct = pct(cum.files.present, cum.files.total);
  const funcPct = pct(cum.functions.found, cum.functions.total);
  const tasksPct = pct(cum.tasks.complete, cum.tasks.total);

  // v0.29: default to strict evaluation. The previous `: true` branch was a
  // tautology — verify would exit 0 regardless of missing files/functions when
  // --strict was absent, so "0 complete story specs, 83 missing" would STILL
  // pass the gate (Meru planning incident). `--loose` remains available for
  // advisory call sites that only want the JSON breakdown without a verdict.
  const passed = loose
    ? true
    : cum.files.missing === 0 &&
      cum.files.empty === 0 &&
      cum.functions.missing === 0 &&
      // Belt-and-suspenders: zero complete specs is always a fail when any are
      // expected. Prevents the "completeSpecs=0, missingSpecs>0, verdict=PASS"
      // class that the review flagged directly.
      !(cum.files.total > 0 && cum.files.present === 0) &&
      !(cum.functions.total > 0 && cum.functions.found === 0);

  const output = {
    milestone,
    round: roundNum,
    verifiedAt: new Date().toISOString(),
    passed,
    completeness: {
      files: parseFloat(filesPct),
      functions: parseFloat(funcPct),
      tasks: parseFloat(tasksPct),
    },
    summary: cum,
    stories: allResults,
    missingFiles: allResults.flatMap((r) => r.fileMap).filter((f) => !f.hasContent),
    missingFunctions: allResults.flatMap((r) => r.functions).filter((f) => !f.found),
    stubbedFunctions: allResults.flatMap((r) => r.functions).filter((f) => f.found && f.hasStubs),
    stubbedFiles: allResults.flatMap((r) => r.fileMap).filter((f) => f.stubCount > 2),
  };

  if (jsonMode) {
    emitJson(output, jsonOut);
  } else if (summaryMode) {
    const roundLabel = roundNum ? ` Round ${roundNum}` : '';
    console.log(`Spec Verification: ${milestone}${roundLabel}`);
    console.log(`  Files:     ${cum.files.present}/${cum.files.total} present (${filesPct}%)`);
    console.log(`  Functions: ${cum.functions.found}/${cum.functions.total} found (${funcPct}%)`);
    console.log(`  Tasks:     ${cum.tasks.complete}/${cum.tasks.total} complete (${tasksPct}%)`);
    if (output.missingFiles.length > 0) {
      console.log('  Missing files:');
      for (const f of output.missingFiles.slice(0, 20)) {
        console.log(`    - ${f.filePath} (${f.action}, ${f.taskId})`);
      }
    }
    if (output.missingFunctions.length > 0) {
      console.log('  Missing functions:');
      for (const f of output.missingFunctions.slice(0, 20)) {
        console.log(`    - ${f.name}${f.expectedFile ? ` (in ${f.expectedFile})` : ''}`);
      }
    }
    console.log(`  Verdict: ${passed ? 'PASS' : 'FAIL'}`);
  } else {
    const roundLabel = roundNum ? ` Round ${roundNum}` : '';
    console.log(`\nSpec Verification: ${milestone}${roundLabel}\n`);
    for (const r of allResults) {
      const tasks = Object.values(r.tasks);
      if (tasks.length === 0) continue;
      const allOk = tasks.every((t) => t.specStatus === 'complete');
      const anyOk = tasks.some((t) => t.specStatus !== 'missing');
      const icon = allOk ? 'PASS' : anyOk ? 'PARTIAL' : 'MISS';
      console.log(`  [${icon}] ${r.storyId}:`);
      for (const t of tasks) {
        console.log(
          `      [${t.specStatus.toUpperCase().padEnd(8)}] ${t.taskId}: ` +
            `files ${t.files.present}/${t.files.total}, functions ${t.functions.found}/${t.functions.total}`,
        );
      }
    }
    console.log(`\n  Files:     ${cum.files.present}/${cum.files.total} (${filesPct}%)`);
    console.log(`  Functions: ${cum.functions.found}/${cum.functions.total} (${funcPct}%)`);
    console.log(`  Tasks:     ${cum.tasks.complete}/${cum.tasks.total} (${tasksPct}%)`);
    console.log(`  Verdict:   ${passed ? 'PASS' : 'FAIL'}\n`);
  }

  process.exit(passed ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  parseImplSpec,
  verifySpec,
  functionExistsInFile,
  functionHasStubs,
  countFileStubs,
  stripPathFormatting,
};
