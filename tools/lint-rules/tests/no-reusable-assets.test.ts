import { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import { rule as noReusableAssets } from '../rules/no-reusable-assets';

/**
 * M1 / Round 1 / E12-S2 — cobolt/no-reusable-assets lint rule.
 * Requirements: NFR-13 (no reusable_assets/ at runtime)
 */
const ruleTester = new RuleTester({ parserOptions: { ecmaVersion: 2022, sourceType: 'module' } });

describe('cobolt/no-reusable-assets', () => {
  it('allows regular imports', () => {
    expect(() =>
      ruleTester.run('no-reusable-assets', noReusableAssets, {
        valid: [
          { code: "import x from './foo';" },
          { code: "import pkg from 'react';" },
          { code: "import { util } from '@cobolt/ui';" },
        ],
        invalid: [],
      }),
    ).not.toThrow();
  });

  it('blocks imports from reusable_assets/', () => {
    expect(() =>
      ruleTester.run('no-reusable-assets', noReusableAssets, {
        valid: [],
        invalid: [
          { code: "import x from 'reusable_assets/foo';", errors: [{ messageId: 'banned' }] },
          { code: "import x from '../reusable_assets/bar';", errors: [{ messageId: 'banned' }] },
          { code: "import x from '/app/reusable_assets/baz';", errors: [{ messageId: 'banned' }] },
        ],
      }),
    ).not.toThrow();
  });

  it('allows literal "reusable_assets" in non-import contexts', () => {
    expect(() =>
      ruleTester.run('no-reusable-assets', noReusableAssets, {
        valid: [{ code: "const folder = 'reusable_assets';" }, { code: '// comment about reusable_assets/' }],
        invalid: [],
      }),
    ).not.toThrow();
  });
});
