import type { Rule } from 'eslint';

/**
 * cobolt/no-reusable-assets — NFR-13: ban imports from reusable_assets/ at runtime.
 */
export const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow imports from reusable_assets/', recommended: true },
    messages: {
      banned:
        "Imports from 'reusable_assets/' are banned at runtime (NFR-13). Move the module into a proper workspace package.",
    },
    schema: [],
  },
  create(context) {
    function check(node: Rule.Node, source: unknown) {
      if (typeof source !== 'string') return;
      if (/(^|[/\\])reusable_assets([/\\])/.test(source) || source.startsWith('reusable_assets/')) {
        context.report({ node, messageId: 'banned' });
      }
    }
    return {
      ImportDeclaration(node) {
        check(node as unknown as Rule.Node, (node.source as { value: string }).value);
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal') {
          check(node as unknown as Rule.Node, (node.source as { value?: unknown }).value);
        }
      },
      CallExpression(node) {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          node.arguments[0]?.type === 'Literal'
        ) {
          check(node as unknown as Rule.Node, (node.arguments[0] as { value?: unknown }).value);
        }
      },
    };
  },
};
