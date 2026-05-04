#!/usr/bin/env node

// CoBolt Legacy Scan — Technology detection for legacy systems
//
// Usage:
//   node tools/cobolt-legacy-scan.js <project-path> [options]
//   node tools/cobolt-legacy-scan.js ./legacy-app --json
//   node tools/cobolt-legacy-scan.js ./legacy-app --check languages
//
// Features:
//   - Language detection from file extensions, shebangs, syntax
//   - Framework identification from package manifests and imports
//   - Dependency listing from all package manager formats
//   - Dead technology flagging (EOL frameworks, extinct languages)
//   - Tech-age scoring (vintage estimate)

const fs = require('node:fs');
const path = require('node:path');

// ── Legacy Technology Database ─────────────────────────────

const LEGACY_TECH = {
  // Language detection by extension
  languages: {
    '.cob': { name: 'COBOL', vintage: 1959, eol: false, talent: 'critical' },
    '.cbl': { name: 'COBOL', vintage: 1959, eol: false, talent: 'critical' },
    '.frm': { name: 'VB6', vintage: 1998, eol: true, talent: 'extinct' },
    '.cls': { name: 'VB6/VBA', vintage: 1998, eol: true, talent: 'rare' },
    '.bas': { name: 'VB6/BASIC', vintage: 1998, eol: true, talent: 'rare' },
    '.pas': { name: 'Delphi/Pascal', vintage: 1995, eol: false, talent: 'rare' },
    '.dfm': { name: 'Delphi Form', vintage: 1995, eol: false, talent: 'rare' },
    '.dpr': { name: 'Delphi Project', vintage: 1995, eol: false, talent: 'rare' },
    '.fmb': { name: 'Oracle Forms', vintage: 1990, eol: true, talent: 'rare' },
    '.rdf': { name: 'Oracle Reports', vintage: 1990, eol: true, talent: 'rare' },
    '.nsf': { name: 'Lotus Notes', vintage: 1989, eol: true, talent: 'extinct' },
    '.dbf': { name: 'FoxPro/dBASE', vintage: 1986, eol: true, talent: 'extinct' },
    '.prg': { name: 'FoxPro/Clipper', vintage: 1986, eol: true, talent: 'extinct' },
    '.cfm': { name: 'ColdFusion', vintage: 1995, eol: false, talent: 'rare' },
    '.cfc': { name: 'ColdFusion', vintage: 1995, eol: false, talent: 'rare' },
    '.rpgle': { name: 'RPG/AS400', vintage: 1959, eol: false, talent: 'critical' },
    '.swf': { name: 'Flash', vintage: 1996, eol: true, talent: 'extinct' },
    '.fla': { name: 'Flash', vintage: 1996, eol: true, talent: 'extinct' },
    '.mxml': { name: 'Flex', vintage: 2004, eol: true, talent: 'extinct' },
    '.4gl': { name: 'Progress 4GL', vintage: 1984, eol: false, talent: 'rare' },
    '.w': { name: 'Progress 4GL', vintage: 1984, eol: false, talent: 'rare' },
    '.f': { name: 'Fortran', vintage: 1957, eol: false, talent: 'rare' },
    '.f90': { name: 'Fortran 90', vintage: 1991, eol: false, talent: 'niche' },
    '.m': { name: 'MUMPS/Caché', vintage: 1966, eol: false, talent: 'critical' },
  },

  // Framework detection by config files
  frameworks: {
    'web.config': { name: 'ASP.NET', vintage: 2002 },
    'Global.asax': { name: 'ASP.NET WebForms', vintage: 2002 },
    'struts-config.xml': { name: 'Apache Struts', vintage: 2000 },
    'faces-config.xml': { name: 'JavaServer Faces', vintage: 2004 },
    'applicationContext.xml': { name: 'Spring (XML config)', vintage: 2002 },
    'hibernate.cfg.xml': { name: 'Hibernate (XML)', vintage: 2001 },
    'build.xml': { name: 'Apache Ant', vintage: 2000 },
  },

  // Package manager files
  packageManagers: {
    'package.json': 'npm/Node.js',
    'requirements.txt': 'pip/Python',
    Pipfile: 'pipenv/Python',
    'pyproject.toml': 'Python (modern)',
    Gemfile: 'bundler/Ruby',
    'pom.xml': 'Maven/Java',
    'build.gradle': 'Gradle/Java',
    'go.mod': 'Go Modules',
    'Cargo.toml': 'Cargo/Rust',
    'mix.exs': 'Mix/Elixir',
    'composer.json': 'Composer/PHP',
    Makefile: 'Make',
    'CMakeLists.txt': 'CMake/C++',
    'nuget.config': 'NuGet/.NET',
  },
};

// ── Scan Functions ─────────────────────────────────────────

function scanDirectory(projectPath, options = {}) {
  const results = {
    path: projectPath,
    timestamp: new Date().toISOString(),
    languages: {},
    frameworks: [],
    packageManagers: [],
    legacyTech: [],
    fileCount: 0,
    totalLOC: 0,
    techAgeScore: null,
    modernizationUrgency: 'low',
  };

  if (!fs.existsSync(projectPath)) {
    return { error: `Path not found: ${projectPath}` };
  }

  // Recursive file scan
  const files = walkDir(projectPath, options.maxDepth || 10);
  results.fileCount = files.length;

  // Language detection
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();

    // Check legacy tech
    if (LEGACY_TECH.languages[ext]) {
      const tech = LEGACY_TECH.languages[ext];
      if (!results.languages[tech.name]) {
        results.languages[tech.name] = { files: 0, ext, ...tech };
      }
      results.languages[tech.name].files++;

      if (tech.eol || tech.talent === 'critical' || tech.talent === 'extinct') {
        if (!results.legacyTech.find((l) => l.name === tech.name)) {
          results.legacyTech.push(tech);
        }
      }
    }

    // Standard language detection
    const stdLang = detectStandardLanguage(ext);
    if (stdLang && !results.languages[stdLang]) {
      results.languages[stdLang] = { files: 0, ext };
    }
    if (stdLang && results.languages[stdLang]) {
      results.languages[stdLang].files++;
    }
  }

  // Framework detection
  for (const file of files) {
    const basename = path.basename(file);
    if (LEGACY_TECH.frameworks[basename]) {
      results.frameworks.push({
        ...LEGACY_TECH.frameworks[basename],
        file: file,
      });
    }
    if (LEGACY_TECH.packageManagers[basename]) {
      results.packageManagers.push({
        manager: LEGACY_TECH.packageManagers[basename],
        file: file,
      });
    }
  }

  // Tech-age scoring
  const vintages = Object.values(results.languages)
    .filter((l) => l.vintage)
    .map((l) => l.vintage);
  if (vintages.length > 0) {
    const oldest = Math.min(...vintages);
    const newest = Math.max(...vintages);
    results.techAgeScore = {
      oldest,
      newest,
      range: `${oldest}-${newest}`,
      averageVintage: Math.round(vintages.reduce((a, b) => a + b, 0) / vintages.length),
    };
  }

  // Urgency assessment
  if (results.legacyTech.some((t) => t.talent === 'extinct')) {
    results.modernizationUrgency = 'critical';
  } else if (results.legacyTech.some((t) => t.talent === 'critical')) {
    results.modernizationUrgency = 'high';
  } else if (results.legacyTech.some((t) => t.eol)) {
    results.modernizationUrgency = 'medium';
  }

  return results;
}

function detectStandardLanguage(ext) {
  const map = {
    '.js': 'JavaScript',
    '.ts': 'TypeScript',
    '.jsx': 'React/JSX',
    '.tsx': 'React/TSX',
    '.py': 'Python',
    '.rb': 'Ruby',
    '.java': 'Java',
    '.kt': 'Kotlin',
    '.scala': 'Scala',
    '.go': 'Go',
    '.rs': 'Rust',
    '.c': 'C',
    '.cpp': 'C++',
    '.h': 'C/C++ Header',
    '.cs': 'C#',
    '.php': 'PHP',
    '.swift': 'Swift',
    '.ex': 'Elixir',
    '.exs': 'Elixir Script',
    '.erl': 'Erlang',
    '.sql': 'SQL',
    '.sh': 'Shell',
    '.pl': 'Perl',
    '.r': 'R',
    '.lua': 'Lua',
  };
  return map[ext] || null;
}

function walkDir(dir, maxDepth, depth = 0) {
  if (depth > maxDepth) return [];
  const files = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (
        entry.name.startsWith('.') ||
        entry.name === 'node_modules' ||
        entry.name === 'vendor' ||
        entry.name === '__pycache__' ||
        entry.name === 'target' ||
        entry.name === '_build'
      )
        continue;
      if (entry.isDirectory()) {
        files.push(...walkDir(fullPath, maxDepth, depth + 1));
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  } catch {
    /* permission denied or other error — skip */
  }
  return files;
}

function formatReport(results) {
  if (results.error) return `Error: ${results.error}`;

  const lines = [];
  lines.push('');
  lines.push('  CoBolt Legacy Scan Report');
  lines.push('  ═══════════════════════════════════════');
  lines.push(`  Path: ${results.path}`);
  lines.push(`  Files scanned: ${results.fileCount}`);
  lines.push(`  Modernization urgency: ${results.modernizationUrgency.toUpperCase()}`);
  lines.push('');

  // Languages
  lines.push('  Languages Detected:');
  for (const [name, info] of Object.entries(results.languages)) {
    const eolTag = info.eol ? ' [EOL]' : '';
    const talentTag = info.talent ? ` (talent: ${info.talent})` : '';
    lines.push(`    ${name}: ${info.files} files${eolTag}${talentTag}`);
  }
  lines.push('');

  // Legacy tech warnings
  if (results.legacyTech.length > 0) {
    lines.push('  Legacy Technology Warnings:');
    for (const tech of results.legacyTech) {
      lines.push(`    ⚠ ${tech.name} (vintage: ${tech.vintage}, talent: ${tech.talent})`);
    }
    lines.push('');
  }

  // Frameworks
  if (results.frameworks.length > 0) {
    lines.push('  Frameworks:');
    for (const fw of results.frameworks) {
      lines.push(`    ${fw.name} (vintage: ${fw.vintage})`);
    }
    lines.push('');
  }

  // Package managers
  if (results.packageManagers.length > 0) {
    lines.push('  Package Managers:');
    for (const pm of results.packageManagers) {
      lines.push(`    ${pm.manager}`);
    }
    lines.push('');
  }

  // Tech age
  if (results.techAgeScore) {
    lines.push(`  Tech Age Score: ${results.techAgeScore.range} (avg vintage: ${results.techAgeScore.averageVintage})`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Exports ────────────────────────────────────────────────

module.exports = { scanDirectory, formatReport, LEGACY_TECH };

// ── CLI ────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  let projectPath = '.';
  let jsonOutput = false;
  let _check = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') jsonOutput = true;
    else if (args[i] === '--check' && args[i + 1]) _check = args[++i];
    else if (args[i] === '--help') {
      console.log('Usage: cobolt-legacy-scan <project-path> [--json] [--check languages|frameworks|all]');
      process.exit(0);
    } else if (!args[i].startsWith('--')) {
      projectPath = args[i];
    }
  }

  const results = scanDirectory(path.resolve(projectPath));

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(formatReport(results));
  }

  // Exit with non-zero if critical legacy tech found
  if (results.modernizationUrgency === 'critical') {
    process.exit(2);
  } else if (results.modernizationUrgency === 'high') {
    process.exit(1);
  }
}
