import type { Rule } from 'eslint';

/**
 * cobolt/no-any-leak - TR-105: ban `any` on exports unless explicitly justified
 * with a // COBOLT:justify comment on the preceding line.
 */
function readProp(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[key];
}

function nodeArray(value: unknown): Rule.Node[] {
  return Array.isArray(value) ? (value as Rule.Node[]) : [];
}

function hasJustifyCommentBefore(node: Rule.Node, sourceCode: Rule.RuleContext['sourceCode']): boolean {
  const comments = sourceCode.getCommentsBefore(node) || [];
  return comments.some((comment: { value?: string }) => /COBOLT:justify/.test(comment.value || ''));
}

function containsAny(typeAnn: unknown): boolean {
  if (!typeAnn) return false;
  if (readProp(typeAnn, 'type') === 'TSAnyKeyword') return true;
  const nestedType = readProp(typeAnn, 'typeAnnotation');
  return nestedType ? containsAny(nestedType) : false;
}

export const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow `any` on exported declarations without justification' },
    messages: { anyLeak: 'Exported API uses `any` - add // COBOLT:justify <reason> or narrow the type (TR-105).' },
    schema: [],
  },
  create(context) {
    const sc = context.sourceCode;
    return {
      ExportNamedDeclaration(node: Rule.Node) {
        const decl = readProp(node, 'declaration');
        if (!decl) return;
        if (hasJustifyCommentBefore(node, sc)) return;

        if (readProp(decl, 'type') === 'VariableDeclaration') {
          for (const declaration of nodeArray(readProp(decl, 'declarations'))) {
            if (containsAny(readProp(readProp(declaration, 'id'), 'typeAnnotation'))) {
              context.report({ node, messageId: 'anyLeak' });
              return;
            }
          }
        } else if (readProp(decl, 'type') === 'FunctionDeclaration') {
          for (const param of nodeArray(readProp(decl, 'params'))) {
            if (containsAny(readProp(param, 'typeAnnotation'))) {
              context.report({ node, messageId: 'anyLeak' });
              return;
            }
          }
          if (containsAny(readProp(decl, 'returnType'))) {
            context.report({ node, messageId: 'anyLeak' });
            return;
          }
        } else if (
          readProp(decl, 'type') === 'TSTypeAliasDeclaration' ||
          readProp(decl, 'type') === 'TSInterfaceDeclaration'
        ) {
          // Walk declaration text for TSAnyKeyword.
          const text = sc.getText(decl as Rule.Node);
          if (/:\s*any\b/.test(text)) context.report({ node, messageId: 'anyLeak' });
        }
      },
    };
  },
};
