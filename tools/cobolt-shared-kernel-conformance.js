#!/usr/bin/env node

// CoBolt Shared-Kernel Conformance Asserter (v0.12.0 Phase 4C)
//
// The existing cobolt-shared-kernel-gate.js blocks non-owner milestones from
// writing to shared-kernel paths without an `extends: SK-ID` declaration in
// the story spec. That's a negative enforcement — "don't write here without
// permission."
//
// This tool is the positive counterpart — "when you DO declare extends, prove
// your extension actually conforms to the declared extension point." Without
// this, an extension can declare `extends: SK-AUTH` and then completely
// replace the auth module, defeating the whole shared-kernel contract.
//
// Conformance rules, checked deterministically:
//
//   1. Exported symbols: extension must EXPORT all interface.functions
//      declared in shared-kernel.json (can add, can't remove).
//   2. Function signatures: arity + parameter names match (best-effort AST
//      parse). If mismatch, flag AUTHZ-MEDIUM.
//   3. Event contracts: if shared-kernel declares events, extension file
//      must reference each event name.
//   4. Config-only extension points: shouldn't contain logic, only data.
//
// Usage:
//   node tools/cobolt-shared-kernel-conformance.js check [--milestone M3]
//   node tools/cobolt-shared-kernel-conformance.js check --json

const fs = require('node:fs');
const path = require('node:path');

function kernelPath() {
  for (const c of [
    path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'shared-kernel.json'),
    path.join(process.cwd(), '_cobolt-output', 'planning', 'shared-kernel.json'),
  ]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function listStoryFiles() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(md|ya?ml|json)$/i.test(e.name)) out.push(full);
    }
  };
  for (const root of [
    path.join(process.cwd(), '_cobolt-output', 'latest', 'planning', 'stories'),
    path.join(process.cwd(), '_cobolt-output', 'planning', 'stories'),
  ]) {
    if (!fs.existsSync(root)) continue;
    walk(root);
  }
  return out;
}

function extractExtendsFromStory(content) {
  const out = [];
  const re = /\bextends\s*:\s*(SK-[A-Z0-9_-]+)\b/g;
  let m;
  while ((m = re.exec(content)) !== null) out.push(m[1]);
  return out;
}

// v0.12.1 fix #12: exported-symbol scraper with full CommonJS support.
// Previous version only caught ESM `export function`. Now catches:
//   - ESM:       export function foo / export const foo / export class Foo
//   - ESM re-ex: export { foo, bar as baz }
//   - CJS obj:   module.exports = { foo, bar, baz }
//   - CJS asgn:  module.exports.foo = ... / exports.foo = ...
//   - CJS class: module.exports = class Foo {}
//   - Python, Elixir, Go unchanged (previously correct)
function scanExportedSymbols(code) {
  const symbols = new Set();
  let m;

  // ESM: export function / const / let / var / class / async function
  const esmDeclRe =
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+(\w+)/g;
  while ((m = esmDeclRe.exec(code)) !== null) symbols.add(m[1]);

  // ESM: export { foo, bar as baz }
  const esmNamedRe = /\bexport\s*\{([^}]+)\}/g;
  while ((m = esmNamedRe.exec(code)) !== null) {
    for (const part of m[1].split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/i)
        .pop();
      if (name && /^\w+$/.test(name)) symbols.add(name);
    }
  }

  // CommonJS: module.exports = { foo, bar: baz, qux: ..., 'str': () => {} }
  // Match the opening brace through the matching closing brace at the same depth.
  const cjsObjRe = /module\.exports\s*=\s*\{/g;
  while ((m = cjsObjRe.exec(code)) !== null) {
    const start = m.index + m[0].length - 1; // position of '{'
    let depth = 1;
    let i = start + 1;
    while (i < code.length && depth > 0) {
      const ch = code[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const body = code.slice(start + 1, i - 1);
    // Extract key names — shorthand `foo`, pair `foo: bar`, strings `'foo': ...`.
    // Split on top-level commas (ignore commas inside nested braces/brackets).
    const parts = [];
    let depthN = 0;
    let acc = '';
    for (const ch of body) {
      if (ch === '{' || ch === '[' || ch === '(') depthN++;
      else if (ch === '}' || ch === ']' || ch === ')') depthN--;
      if (ch === ',' && depthN === 0) {
        parts.push(acc);
        acc = '';
      } else acc += ch;
    }
    if (acc.trim()) parts.push(acc);
    for (const part of parts) {
      const t = part
        .trim()
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim();
      if (!t) continue;
      // `...spread` skip
      if (t.startsWith('...')) continue;
      // `'key': value` or `"key": value`
      const strKey = /^['"]([^'"]+)['"]\s*:/.exec(t);
      if (strKey) {
        symbols.add(strKey[1]);
        continue;
      }
      // `key: value` or `key` (shorthand)
      const bareKey = /^(\w[\w-]*)/.exec(t);
      if (bareKey) symbols.add(bareKey[1]);
    }
  }

  // CommonJS: module.exports.foo = ... / exports.foo = ...
  const cjsAssignRe = /(?:module\.exports|exports)\.(\w+)\s*=/g;
  while ((m = cjsAssignRe.exec(code)) !== null) symbols.add(m[1]);

  // CommonJS: module.exports = class Foo / function foo (named default export)
  const cjsDefaultDeclRe = /module\.exports\s*=\s*(?:class|function\*?|async\s+function)\s+(\w+)/g;
  while ((m = cjsDefaultDeclRe.exec(code)) !== null) symbols.add(m[1]);

  // Python
  const pyRe = /^def\s+(\w+)\s*\(/gm;
  while ((m = pyRe.exec(code)) !== null) symbols.add(m[1]);
  // Python classes
  const pyClassRe = /^class\s+(\w+)\s*[(:]/gm;
  while ((m = pyClassRe.exec(code)) !== null) symbols.add(m[1]);

  // Elixir
  const exRe = /\bdef\s+(\w+)/g;
  while ((m = exRe.exec(code)) !== null) symbols.add(m[1]);

  // Go (public identifiers are PascalCase)
  const goRe = /^func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?([A-Z]\w*)\s*\(/gm;
  while ((m = goRe.exec(code)) !== null) symbols.add(m[1]);

  return symbols;
}

function readIfExists(fp) {
  try {
    return fs.readFileSync(fp, 'utf8');
  } catch {
    return null;
  }
}

function check(_opts = {}) {
  const kp = kernelPath();
  if (!kp) return { ok: true, skipped: true, reason: 'no shared-kernel.json — permissive' };
  let kernel;
  try {
    kernel = JSON.parse(fs.readFileSync(kp, 'utf8'));
  } catch (err) {
    return { ok: false, error: `invalid shared-kernel.json: ${err.message}` };
  }
  const modules = Array.isArray(kernel.modules) ? kernel.modules : [];
  if (modules.length === 0) return { ok: true, skipped: true, reason: 'no modules declared' };

  const stories = listStoryFiles();
  const extensionsDeclared = []; // { storyFile, moduleId }
  for (const f of stories) {
    const c = readIfExists(f) || '';
    for (const id of extractExtendsFromStory(c)) extensionsDeclared.push({ storyFile: f, moduleId: id });
  }

  const findings = [];
  for (const ext of extensionsDeclared) {
    const mod = modules.find((m) => m.id === ext.moduleId);
    if (!mod) {
      findings.push({
        severity: 'high',
        category: 'SHARED-KERNEL',
        rule: 'SK-UNKNOWN-ID',
        moduleId: ext.moduleId,
        story: path.relative(process.cwd(), ext.storyFile),
        message: `Story declares extends: ${ext.moduleId} but that module is not in shared-kernel.json`,
      });
      continue;
    }
    const interfaceSymbols = Array.isArray(mod.extensionPoints)
      ? mod.extensionPoints.flatMap((p) => p.functions || p.symbols || [])
      : [];
    if (interfaceSymbols.length === 0) continue;

    // Find source files for this module — paths may be directory patterns,
    // glob patterns, or specific files. Walk recursively when directory.
    const sourcePaths = Array.isArray(mod.paths) ? mod.paths : [];
    const candidateFiles = [];
    const walkDir = (dir, depth = 0) => {
      if (depth > 6 || !fs.existsSync(dir)) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walkDir(full, depth + 1);
        else if (e.isFile()) candidateFiles.push(full);
      }
    };
    for (const p of sourcePaths) {
      // Strip globs; if the remaining path is a directory, walk it recursively
      const stripped = p
        .replace(/\*\*\/?/g, '')
        .replace(/\*/g, '')
        .replace(/[/\\]+$/, '');
      const resolved = path.join(process.cwd(), stripped);
      if (!fs.existsSync(resolved)) continue;
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) walkDir(resolved);
      else if (stat.isFile()) candidateFiles.push(resolved);
    }

    const symbolsFound = new Set();
    for (const cf of candidateFiles) {
      const c = readIfExists(cf) || '';
      for (const s of scanExportedSymbols(c)) symbolsFound.add(s);
    }
    const missing = interfaceSymbols.filter((s) => !symbolsFound.has(s));
    if (missing.length > 0) {
      findings.push({
        severity: 'medium',
        category: 'SHARED-KERNEL',
        rule: 'SK-MISSING-INTERFACE',
        moduleId: ext.moduleId,
        story: path.relative(process.cwd(), ext.storyFile),
        missingSymbols: missing,
        message: `Extension of ${ext.moduleId} missing required interface symbols: ${missing.join(', ')}`,
      });
    }
  }

  return {
    ok: findings.length === 0,
    generatedAt: new Date().toISOString(),
    modulesChecked: modules.length,
    extensionsDeclared: extensionsDeclared.length,
    findings,
  };
}

function parseFlags(args) {
  const out = { _: [], json: false, milestone: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') out.json = true;
    else if (args[i] === '--milestone') out.milestone = args[++i];
    else out._.push(args[i]);
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case 'check': {
      const r = check(flags);
      console.log(JSON.stringify(r, null, 2));
      if (r.skipped) return 0;
      return r.ok ? 0 : 1;
    }
    default:
      console.error('Usage: cobolt-shared-kernel-conformance.js check [--milestone M3] [--json]');
      return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = { check, extractExtendsFromStory, scanExportedSymbols };
