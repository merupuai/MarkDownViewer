import type { Rule } from 'eslint';

/**
 * cobolt/rls-required - NFR-04/SR-AUTHZ-001: raw SQL on tenant-scoped tables
 * must go through the withTenant() helper so the session GUC is set.
 */
const SCOPED_TABLES = [
  'apps',
  'projects',
  'users',
  'evidence_events',
  'idempotency_keys',
  'role_bindings',
  'share_links',
  'share_link_grants',
  'policy_rules',
  'app_revisions',
  'sessions',
  'tenants',
];
const SCOPED_RE = new RegExp(
  `\\b(SELECT|UPDATE|DELETE|INSERT\\s+INTO)\\b[\\s\\S]*?\\b(${SCOPED_TABLES.join('|')})\\b`,
  'i',
);

function readProp(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[key];
}

function nodeType(value: unknown): string | undefined {
  const type = readProp(value, 'type');
  return typeof type === 'string' ? type : undefined;
}

function nodeName(value: unknown): string | undefined {
  const name = readProp(value, 'name');
  return typeof name === 'string' ? name : undefined;
}

function parentNode(value: unknown): Rule.Node | null {
  const parent = readProp(value, 'parent');
  return parent && typeof parent === 'object' ? (parent as Rule.Node) : null;
}

function cookedTemplateText(value: unknown): string {
  const quasis = readProp(value, 'quasis');
  if (!Array.isArray(quasis)) return '';
  return quasis
    .map((quasi) => {
      const cooked = readProp(readProp(quasi, 'value'), 'cooked');
      return typeof cooked === 'string' ? cooked : '';
    })
    .join(' ');
}

function isInsideWithTenant(node: Rule.Node): boolean {
  let current = parentNode(node);
  while (current) {
    if (nodeType(current) === 'CallExpression') {
      const callee = readProp(current, 'callee');
      if (nodeType(callee) === 'Identifier' && nodeName(callee) === 'withTenant') return true;
      if (nodeType(callee) === 'MemberExpression' && nodeName(readProp(callee, 'property')) === 'withTenant') {
        return true;
      }
    }
    current = parentNode(current);
  }
  return false;
}

export const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Require withTenant() wrapper for queries on tenant-scoped tables' },
    messages: { rlsRequired: 'Raw SQL on tenant-scoped table must run inside withTenant() so RLS session GUC is set.' },
    schema: [],
  },
  create(context) {
    function checkSQL(node: Rule.Node, raw: string) {
      if (!SCOPED_RE.test(raw)) return;
      if (isInsideWithTenant(node)) return;
      context.report({ node, messageId: 'rlsRequired' });
    }
    return {
      CallExpression(node) {
        const callee = readProp(node, 'callee');
        const isQuery = nodeName(readProp(callee, 'property')) === 'query' || nodeName(callee) === 'sql';
        if (!isQuery) return;

        const args = readProp(node, 'arguments');
        if (!Array.isArray(args) || !args[0]) return;
        const arg0 = args[0];
        const value = readProp(arg0, 'value');
        if (nodeType(arg0) === 'Literal' && typeof value === 'string') {
          checkSQL(node as unknown as Rule.Node, value);
        } else if (nodeType(arg0) === 'TemplateLiteral') {
          checkSQL(node as unknown as Rule.Node, cookedTemplateText(arg0));
        }
      },
      TaggedTemplateExpression(node) {
        if (nodeType(readProp(node, 'tag')) !== 'Identifier' || nodeName(readProp(node, 'tag')) !== 'sql') return;
        checkSQL(node as unknown as Rule.Node, cookedTemplateText(readProp(node, 'quasi')));
      },
    };
  },
};
