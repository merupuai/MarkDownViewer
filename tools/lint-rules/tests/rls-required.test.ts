import { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import { rule } from '../rules/rls-required';

/** E12-S2 cobolt/rls-required — flags raw queries on tenant-scoped tables. */
const tester = new RuleTester({ parserOptions: { ecmaVersion: 2022, sourceType: 'module' } });

describe('cobolt/rls-required', () => {
  it('allows scoped queries via withTenant', () => {
    expect(() =>
      tester.run('rls-required', rule, {
        valid: [
          { code: "await withTenant(tid, async (c) => { await c.query('SELECT * FROM apps'); });" },
          { code: 'const tenants = await db.tenants.findAll();' },
        ],
        invalid: [],
      }),
    ).not.toThrow();
  });

  it('flags raw SELECT/UPDATE/DELETE on tenant-scoped tables outside withTenant', () => {
    expect(() =>
      tester.run('rls-required', rule, {
        valid: [],
        invalid: [
          { code: "await client.query('SELECT * FROM apps');", errors: [{ messageId: 'rlsRequired' }] },
          {
            code: "await client.query('DELETE FROM projects WHERE id = $1', [id]);",
            errors: [{ messageId: 'rlsRequired' }],
          },
          { code: "await pool.query('UPDATE evidence_events SET x = 1');", errors: [{ messageId: 'rlsRequired' }] },
        ],
      }),
    ).not.toThrow();
  });

  it('ignores unrelated tables (pg_* system tables, non-scoped)', () => {
    expect(() =>
      tester.run('rls-required', rule, {
        valid: [
          { code: "await client.query('SELECT version()');" },
          { code: "await client.query('SELECT * FROM pg_stat_activity');" },
        ],
        invalid: [],
      }),
    ).not.toThrow();
  });
});
