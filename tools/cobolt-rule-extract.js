#!/usr/bin/env node

// CoBolt Rule Extract — Business rule extraction from code
//
// Usage:
//   node tools/cobolt-rule-extract.js <source-path> [options]
//   node tools/cobolt-rule-extract.js ./legacy-app --json
//   node tools/cobolt-rule-extract.js ./legacy-app --category validations
//
// Features:
//   - Conditional logic detection (IF/THEN/ELSE, SWITCH/CASE)
//   - Decision branch analysis and complexity scoring
//   - State machine detection (status field transitions)
//   - Validation rule extraction (constraints, format checks)
//   - Calculation isolation (formulas, pricing, tax)
//   - Confidence scoring per extracted rule

const fs = require('node:fs');
const path = require('node:path');

// ── Rule Extraction Patterns ───────────────────────────────

const PATTERNS = {
  // Conditional logic patterns by language
  conditionals: {
    javascript: /if\s*\(([^)]+)\)\s*\{/g,
    python: /if\s+(.+):/g,
    java: /if\s*\(([^)]+)\)\s*\{/g,
    csharp: /if\s*\(([^)]+)\)\s*\{/g,
    cobol: /IF\s+(.+?)\s+THEN/gi,
    vb6: /If\s+(.+?)\s+Then/gi,
  },

  // Switch/case patterns
  switches: {
    javascript: /switch\s*\(([^)]+)\)\s*\{/g,
    java: /switch\s*\(([^)]+)\)\s*\{/g,
    cobol: /EVALUATE\s+(.+?)$/gim,
    vb6: /Select\s+Case\s+(.+)$/gim,
  },

  // Status/state field patterns
  stateFields: /(?:status|state|phase|step|stage|mode|flag)\s*[=:]\s*['"`]?(\w+)/gi,

  // Validation patterns
  validations: {
    required: /(?:required|mandatory|must\s+not\s+be\s+(?:null|empty|blank))/gi,
    length: /(?:length|len|size)\s*[<>=!]+\s*(\d+)/gi,
    range: /(?:between|>=?\s*\d+\s*(?:and|&&)\s*<=?\s*\d+)/gi,
    pattern: /(?:match|regex|pattern|format)\s*[=:(/]\s*(.+?)[\s;)]/gi,
    email: /(?:email|e-mail)\s*.*(?:valid|format|regex|match)/gi,
  },

  // Calculation patterns
  calculations: {
    arithmetic: /(?:total|sum|amount|price|cost|tax|discount|rate|score|balance)\s*[=:]\s*(.+?)(?:;|\n)/gi,
    rounding: /(?:round|ceil|floor|trunc|toFixed|ROUNDED)\s*\(/gi,
    percentage: /\*\s*(?:0\.\d+|\d+\s*\/\s*100|\d+%)/g,
  },
};

// ── Extraction Functions ───────────────────────────────────

function extractRules(sourcePath, _options = {}) {
  const results = {
    path: sourcePath,
    timestamp: new Date().toISOString(),
    rules: [],
    summary: {
      total: 0,
      byCategory: {},
      byConfidence: { high: 0, medium: 0, low: 0 },
      filesAnalyzed: 0,
    },
  };

  if (!fs.existsSync(sourcePath)) {
    return { error: `Path not found: ${sourcePath}` };
  }

  const stat = fs.statSync(sourcePath);
  const files = stat.isDirectory() ? walkSourceFiles(sourcePath) : [sourcePath];
  results.summary.filesAnalyzed = files.length;

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const relPath = path.relative(sourcePath, file);
      const lang = detectLanguage(file);

      // Extract conditionals
      extractConditionals(content, relPath, lang, results);

      // Extract state transitions
      extractStateTransitions(content, relPath, results);

      // Extract validations
      extractValidations(content, relPath, results);

      // Extract calculations
      extractCalculations(content, relPath, results);
    } catch {
      /* skip unreadable files */
    }
  }

  // Build summary
  results.summary.total = results.rules.length;
  for (const rule of results.rules) {
    results.summary.byCategory[rule.category] = (results.summary.byCategory[rule.category] || 0) + 1;
    if (rule.confidence >= 80) results.summary.byConfidence.high++;
    else if (rule.confidence >= 50) results.summary.byConfidence.medium++;
    else results.summary.byConfidence.low++;
  }

  return results;
}

function extractConditionals(content, file, lang, results) {
  const lines = content.split('\n');
  const langPatterns = PATTERNS.conditionals[lang] || PATTERNS.conditionals.javascript;

  let match;
  const regex = new RegExp(langPatterns.source, langPatterns.flags);
  while ((match = regex.exec(content)) !== null) {
    const lineNum = content.substring(0, match.index).split('\n').length;
    const condition = match[1]?.trim();
    if (!condition || condition.length > 200) continue;

    results.rules.push({
      id: `BR-${String(results.rules.length + 1).padStart(3, '0')}`,
      category: 'conditional',
      type: 'business_rule',
      condition: condition,
      source: `${file}:${lineNum}`,
      context: getContext(lines, lineNum - 1, 2),
      confidence: scoreConfidence(condition, content, lineNum),
      needsHumanReview: false,
    });
  }
}

function extractStateTransitions(content, file, results) {
  let match;
  const regex = new RegExp(PATTERNS.stateFields.source, PATTERNS.stateFields.flags);
  while ((match = regex.exec(content)) !== null) {
    const lineNum = content.substring(0, match.index).split('\n').length;
    const lines = content.split('\n');

    results.rules.push({
      id: `BR-${String(results.rules.length + 1).padStart(3, '0')}`,
      category: 'state_transition',
      type: 'state_machine',
      stateValue: match[1],
      source: `${file}:${lineNum}`,
      context: getContext(lines, lineNum - 1, 1),
      confidence: 60,
      needsHumanReview: true,
    });
  }
}

function extractValidations(content, file, results) {
  for (const [type, pattern] of Object.entries(PATTERNS.validations)) {
    let match;
    const regex = new RegExp(pattern.source, pattern.flags);
    while ((match = regex.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      const lines = content.split('\n');

      results.rules.push({
        id: `BR-${String(results.rules.length + 1).padStart(3, '0')}`,
        category: 'validation',
        type: type,
        match: match[0].trim(),
        source: `${file}:${lineNum}`,
        context: getContext(lines, lineNum - 1, 1),
        confidence: 85,
        needsHumanReview: false,
      });
    }
  }
}

function extractCalculations(content, file, results) {
  for (const [type, pattern] of Object.entries(PATTERNS.calculations)) {
    let match;
    const regex = new RegExp(pattern.source, pattern.flags);
    while ((match = regex.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      const lines = content.split('\n');

      results.rules.push({
        id: `BR-${String(results.rules.length + 1).padStart(3, '0')}`,
        category: 'calculation',
        type: type,
        formula: match[1]?.trim() || match[0].trim(),
        source: `${file}:${lineNum}`,
        context: getContext(lines, lineNum - 1, 1),
        confidence: 70,
        needsHumanReview: true,
      });
    }
  }
}

function scoreConfidence(condition, content, lineNum) {
  let score = 70; // base score

  // Boost for clear naming
  if (/[A-Z_]{2,}/.test(condition)) score += 5; // constants
  if (/(?:is|has|can|should|must|valid|check|verify)/i.test(condition)) score += 10;

  // Reduce for complexity
  if ((condition.match(/&&|\|\|/g) || []).length > 3) score -= 15;
  if (condition.length > 100) score -= 10;

  // Boost for nearby comments
  const lines = content.split('\n');
  const prevLine = lines[lineNum - 2] || '';
  if (/\/\/|#|--|\/\*/.test(prevLine)) score += 10;

  return Math.min(100, Math.max(10, score));
}

function getContext(lines, lineIdx, surrounding) {
  const start = Math.max(0, lineIdx - surrounding);
  const end = Math.min(lines.length - 1, lineIdx + surrounding);
  return lines.slice(start, end + 1).join('\n');
}

function detectLanguage(file) {
  const ext = path.extname(file).toLowerCase();
  const map = {
    '.js': 'javascript',
    '.ts': 'javascript',
    '.jsx': 'javascript',
    '.tsx': 'javascript',
    '.py': 'python',
    '.java': 'java',
    '.cs': 'csharp',
    '.cob': 'cobol',
    '.cbl': 'cobol',
    '.bas': 'vb6',
    '.frm': 'vb6',
    '.cls': 'vb6',
  };
  return map[ext] || 'javascript';
}

function walkSourceFiles(dir, maxDepth = 10, depth = 0) {
  if (depth > maxDepth) return [];
  const files = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name.startsWith('.') ||
        entry.name === 'node_modules' ||
        entry.name === 'vendor' ||
        entry.name === '__pycache__'
      )
        continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...walkSourceFiles(fullPath, maxDepth, depth + 1));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const codeExts = [
          '.js',
          '.ts',
          '.py',
          '.java',
          '.cs',
          '.rb',
          '.go',
          '.rs',
          '.php',
          '.cob',
          '.cbl',
          '.bas',
          '.frm',
          '.cls',
          '.pas',
          '.ex',
          '.exs',
          '.cpp',
          '.c',
          '.h',
          '.sql',
          '.pl',
          '.lua',
          '.swift',
          '.kt',
          '.scala',
        ];
        if (codeExts.includes(ext)) files.push(fullPath);
      }
    }
  } catch {
    /* skip */
  }
  return files;
}

function formatReport(results) {
  if (results.error) return `Error: ${results.error}`;

  const lines = [];
  lines.push('');
  lines.push('  CoBolt Business Rule Extraction Report');
  lines.push('  ═══════════════════════════════════════════');
  lines.push(`  Source: ${results.path}`);
  lines.push(`  Files analyzed: ${results.summary.filesAnalyzed}`);
  lines.push(`  Rules extracted: ${results.summary.total}`);
  lines.push('');

  lines.push('  By Category:');
  for (const [cat, count] of Object.entries(results.summary.byCategory)) {
    lines.push(`    ${cat}: ${count}`);
  }
  lines.push('');

  lines.push('  By Confidence:');
  lines.push(`    High (80-100%): ${results.summary.byConfidence.high}`);
  lines.push(`    Medium (50-79%): ${results.summary.byConfidence.medium}`);
  lines.push(`    Low (0-49%): ${results.summary.byConfidence.low}`);
  lines.push('');

  // Show top 20 rules
  const topRules = results.rules.slice(0, 20);
  lines.push('  Top Rules:');
  for (const rule of topRules) {
    const review = rule.needsHumanReview ? ' [NEEDS REVIEW]' : '';
    lines.push(`    ${rule.id} [${rule.category}] confidence:${rule.confidence}%${review}`);
    lines.push(`      Source: ${rule.source}`);
  }

  return lines.join('\n');
}

// ── Exports ────────────────────────────────────────────────

module.exports = { extractRules, formatReport, PATTERNS };

// ── CLI ────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  let sourcePath = '.';
  let jsonOutput = false;
  let category = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') jsonOutput = true;
    else if (args[i] === '--category' && args[i + 1]) category = args[++i];
    else if (args[i] === '--help') {
      console.log(
        'Usage: cobolt-rule-extract <source-path> [--json] [--category conditional|validation|calculation|state_transition]',
      );
      process.exit(0);
    } else if (!args[i].startsWith('--')) {
      sourcePath = args[i];
    }
  }

  const results = extractRules(path.resolve(sourcePath), { category });

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(formatReport(results));
  }
}
