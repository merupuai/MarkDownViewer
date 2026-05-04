#!/usr/bin/env node
// S2 — Generate property-based tests from implicit-requirements.md invariants.
// Usage: node tools/cobolt-property-test-gen.js --milestone M3 [--lang ts|py|rust|ex]

const fs = require('node:fs');
const path = require('node:path');

const CWD = process.cwd();
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const M = arg('--milestone', 'M1');
const lang = arg('--lang') || detectLang();

function detectLang() {
  const stack = readJSON(path.join(CWD, '_cobolt-output', 'latest', 'planning', 'tech-stack.json'), {});
  const l = (stack.primaryLanguage || '').toLowerCase();
  if (l.includes('typescript') || l.includes('javascript')) return 'ts';
  if (l.includes('python')) return 'py';
  if (l.includes('rust')) return 'rust';
  if (l.includes('elixir')) return 'ex';
  return 'ts';
}
function readJSON(p, d) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return d;
  }
}

const irPath = path.join(CWD, '_cobolt-output', 'latest', 'planning', 'implicit-requirements.md');
if (!fs.existsSync(irPath)) {
  console.error('implicit-requirements.md missing');
  process.exit(1);
}
const irText = fs.readFileSync(irPath, 'utf8');

// Match IR-NNN: ... invariant: <statement>
const rows = [];
const re = /IR-(\d+)[^\n]*?invariant:\s*(.+?)(?=\n(?:IR-|\s*$))/gis;
let m;
while ((m = re.exec(irText)) !== null) rows.push({ id: `IR-${m[1]}`, invariant: m[2].trim().replace(/\s+/g, ' ') });

if (!rows.length) {
  console.error('No IR invariants found');
  process.exit(1);
}

const outDir = path.join(CWD, 'tests', 'independent', M);
fs.mkdirSync(outDir, { recursive: true });

const emit = {
  ts: (r) => `import fc from 'fast-check';
import { test, expect } from 'vitest';

// ${r.id}: ${r.invariant}
test.skip('${r.id} property', () => {
  fc.assert(fc.property(fc.anything(), (x) => {
    // TODO: wire to invariant predicate
    return true;
  }));
});
`,
  py: (r) => `from hypothesis import given, strategies as st

# ${r.id}: ${r.invariant}
@given(st.integers())
def test_${r.id.replace('-', '_').toLowerCase()}(x):
    # TODO: wire to invariant predicate
    assert True
`,
  rust: (r) => `// ${r.id}: ${r.invariant}
#[cfg(test)]
mod ${r.id.toLowerCase().replace('-', '_')} {
    use proptest::prelude::*;
    proptest! {
        #[test]
        fn holds(x in any::<i64>()) {
            // TODO: wire to invariant predicate
            prop_assert!(true);
        }
    }
}
`,
  ex: (r) => `# ${r.id}: ${r.invariant}
defmodule ${r.id.replace('-', '')}Test do
  use ExUnit.Case
  use ExUnitProperties

  property "${r.id}" do
    check all _x <- StreamData.integer() do
      # TODO: wire to invariant predicate
      assert true
    end
  end
end
`,
};

const ext = { ts: 'spec.ts', py: 'py', rust: 'rs', ex: 'exs' }[lang] || 'spec.ts';
const emitter = emit[lang] || emit.ts;

rows.forEach((r) => {
  const fname = path.join(outDir, `${r.id}.${ext}`);
  if (!fs.existsSync(fname)) fs.writeFileSync(fname, emitter(r));
});

fs.writeFileSync(
  path.join(outDir, '_manifest.json'),
  JSON.stringify({ milestone: M, lang, generated: rows.map((r) => r.id), ts: new Date().toISOString() }, null, 2),
);
console.log(`generated ${rows.length} property tests in ${path.relative(CWD, outDir)}`);
