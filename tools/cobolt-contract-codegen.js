#!/usr/bin/env node
// S4 — Emit typed clients + servers + validators from interface-contracts.json.
// Eliminates drift-by-construction between consumer and provider milestones.
// Usage:
//   cobolt-contract-codegen --contract _cobolt-output/latest/planning/interface-contracts.json \
//     --lang ts,py,go --out generated/contracts/

const fs = require('node:fs');
const path = require('node:path');

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const contractPath = arg('--contract') || '_cobolt-output/latest/planning/interface-contracts.json';
const langs = (arg('--lang') || 'ts').split(',');
const outRoot = arg('--out') || 'generated/contracts';

const CWD = process.cwd();

const pascal = (s) =>
  String(s || '')
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, x) => x.toUpperCase())
    .replace(/^(.)/, (x) => x.toUpperCase());
const goField = (k) =>
  k.replace(/^(.)/, (x) => x.toUpperCase()).replace(/[^a-zA-Z0-9]+(.)/g, (_, x) => x.toUpperCase());

// Deterministic recursive type emission.
// Each emitter returns { type, inline } where `inline` is a list of named
// interface declarations to emit BEFORE the containing interface, ordered
// deterministically (parent name ascending, property name ascending).

function emitTsType(schema, nameHint, inlines) {
  if (!schema || typeof schema !== 'object') return 'unknown';
  if (schema.type === 'string') return 'string';
  if (schema.type === 'number' || schema.type === 'integer') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'array') {
    const items = schema.items || {};
    if (items.type === 'object') {
      const ifaceName = `${nameHint}Item`;
      emitTsInterface(ifaceName, items, inlines);
      return `${ifaceName}[]`;
    }
    if (items.type === 'array') {
      return `${emitTsType(items, `${nameHint}Item`, inlines)}[]`;
    }
    return `${emitTsType(items, `${nameHint}Item`, inlines)}[]`;
  }
  if (schema.type === 'object') {
    emitTsInterface(nameHint, schema, inlines);
    return nameHint;
  }
  return 'unknown';
}
function emitTsInterface(name, schema, inlines) {
  if (inlines.some((i) => i.name === name)) return;
  const props = schema.properties || {};
  const req = new Set(schema.required || []);
  const lines = [`export interface ${name} {`];
  Object.keys(props)
    .sort()
    .forEach((k) => {
      const childName = `${name}${pascal(k)}`;
      const t = emitTsType(props[k], childName, inlines);
      lines.push(`  ${k}${req.has(k) ? '' : '?'}: ${t};`);
    });
  lines.push('}');
  inlines.push({ name, text: lines.join('\n') });
}

function emitPyType(schema, nameHint, inlines) {
  if (!schema || typeof schema !== 'object') return 'Any';
  if (schema.type === 'string') return 'str';
  if (schema.type === 'integer') return 'int';
  if (schema.type === 'number') return 'float';
  if (schema.type === 'boolean') return 'bool';
  if (schema.type === 'array') {
    const items = schema.items || {};
    if (items.type === 'object') {
      const n = `${nameHint}Item`;
      emitPyClass(n, items, inlines);
      return `list[${n}]`;
    }
    return `list[${emitPyType(items, `${nameHint}Item`, inlines)}]`;
  }
  if (schema.type === 'object') {
    emitPyClass(nameHint, schema, inlines);
    return nameHint;
  }
  return 'Any';
}
function emitPyClass(name, schema, inlines) {
  if (inlines.some((i) => i.name === name)) return;
  const props = schema.properties || {};
  const lines = [`class ${name}(TypedDict, total=False):`];
  const keys = Object.keys(props).sort();
  if (!keys.length) {
    lines.push('    pass');
  }
  keys.forEach((k) => {
    const childName = `${name}${pascal(k)}`;
    const t = emitPyType(props[k], childName, inlines);
    lines.push(`    ${k}: ${t}`);
  });
  inlines.push({ name, text: lines.join('\n') });
}

function emitGoType(schema, nameHint, inlines) {
  if (!schema || typeof schema !== 'object') return 'interface{}';
  if (schema.type === 'string') return 'string';
  if (schema.type === 'integer') return 'int64';
  if (schema.type === 'number') return 'float64';
  if (schema.type === 'boolean') return 'bool';
  if (schema.type === 'array') {
    const items = schema.items || {};
    if (items.type === 'object') {
      const n = `${nameHint}Item`;
      emitGoStruct(n, items, inlines);
      return `[]${n}`;
    }
    return `[]${emitGoType(items, `${nameHint}Item`, inlines)}`;
  }
  if (schema.type === 'object') {
    emitGoStruct(nameHint, schema, inlines);
    return nameHint;
  }
  return 'interface{}';
}
function emitGoStruct(name, schema, inlines) {
  if (inlines.some((i) => i.name === name)) return;
  const props = schema.properties || {};
  const lines = [`type ${name} struct {`];
  Object.keys(props)
    .sort()
    .forEach((k) => {
      const childName = `${name}${pascal(k)}`;
      const t = emitGoType(props[k], childName, inlines);
      lines.push(`  ${goField(k)} ${t} \`json:"${k}"\``);
    });
  lines.push('}');
  inlines.push({ name, text: lines.join('\n') });
}

function loadList() {
  const full = path.isAbsolute(contractPath) ? contractPath : path.resolve(process.cwd(), contractPath);
  const contracts = JSON.parse(fs.readFileSync(full, 'utf8'));
  return (contracts.contracts || [])
    .slice()
    .sort((a, b) => String(a.id || a.name).localeCompare(String(b.id || b.name)));
}
let _list = null;
function list() {
  if (!_list) _list = loadList();
  return _list;
}

const emitTS = () => {
  const out = ['// AUTO-GENERATED by cobolt-contract-codegen. Do not edit.', ''];
  list().forEach((c) => {
    const p = pascal(c.id || c.name);
    const inlines = [];
    emitTsInterface(`${p}Request`, c.request || {}, inlines);
    emitTsInterface(`${p}Response`, c.response || {}, inlines);
    inlines.forEach((i) => {
      out.push(i.text);
      out.push('');
    });
    out.push(`export const ${p}Endpoint = ${JSON.stringify(c.endpoint || c.path || '')} as const;`);
    out.push('');
  });
  return out.join('\n');
};

const emitPY = () => {
  const out = ['# AUTO-GENERATED by cobolt-contract-codegen.', 'from typing import TypedDict, Any', ''];
  list().forEach((c) => {
    const p = pascal(c.id || c.name);
    const inlines = [];
    emitPyClass(`${p}Request`, c.request || {}, inlines);
    emitPyClass(`${p}Response`, c.response || {}, inlines);
    inlines.forEach((i) => {
      out.push(i.text);
      out.push('');
    });
    out.push(`${p.toUpperCase()}_ENDPOINT = ${JSON.stringify(c.endpoint || c.path || '')}`);
    out.push('');
  });
  return out.join('\n');
};

const emitGO = () => {
  const out = ['// AUTO-GENERATED by cobolt-contract-codegen.', 'package contracts', ''];
  list().forEach((c) => {
    const p = pascal(c.id || c.name);
    const inlines = [];
    emitGoStruct(`${p}Request`, c.request || {}, inlines);
    emitGoStruct(`${p}Response`, c.response || {}, inlines);
    inlines.forEach((i) => {
      out.push(i.text);
      out.push('');
    });
    out.push(`const ${p}Endpoint = ${JSON.stringify(c.endpoint || c.path || '')}`);
    out.push('');
  });
  return out.join('\n');
};

const emitters = { ts: emitTS, py: emitPY, go: emitGO };
const exts = { ts: 'ts', py: 'py', go: 'go' };

if (require.main === module) {
  langs.forEach((l) => {
    if (!emitters[l]) {
      console.error('unknown lang', l);
      return;
    }
    const base = path.isAbsolute(outRoot) ? outRoot : path.join(CWD, outRoot);
    const file = path.join(base, l, `contracts.${exts[l]}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, emitters[l]());
    console.log(`wrote ${path.relative(CWD, file)}`);
  });
}

module.exports = { emitTS, emitPY, emitGO, emitTsInterface, emitPyClass, emitGoStruct };
