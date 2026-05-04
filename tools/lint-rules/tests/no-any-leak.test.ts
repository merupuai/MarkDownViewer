import { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import { rule } from '../rules/no-any-leak';

/** E12-S2 cobolt/no-any-leak — flags cross-module any casts. */
const tester = new RuleTester({
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: {} },
  parser: require.resolve('@typescript-eslint/parser'),
});

describe('cobolt/no-any-leak', () => {
  it('allows any WITHIN a single module', () => {
    expect(() =>
      tester.run('no-any-leak', rule, {
        valid: [{ code: 'const x: any = 1;' }],
        invalid: [],
      }),
    ).not.toThrow();
  });
  it('flags exported any types', () => {
    expect(() =>
      tester.run('no-any-leak', rule, {
        valid: [],
        invalid: [
          { code: 'export const x: any = 1;', errors: [{ messageId: 'anyLeak' }] },
          { code: 'export function f(x: any): void {}', errors: [{ messageId: 'anyLeak' }] },
        ],
      }),
    ).not.toThrow();
  });
  it('allows explicit // COBOLT:justify comments near any', () => {
    expect(() =>
      tester.run('no-any-leak', rule, {
        valid: [{ code: '// COBOLT:justify external-lib-untyped\nexport const x: any = 1;' }],
        invalid: [],
      }),
    ).not.toThrow();
  });
});
