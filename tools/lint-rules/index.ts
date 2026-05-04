import { rule as noAnyLeak } from './rules/no-any-leak';
import { rule as noReusableAssets } from './rules/no-reusable-assets';
import { rule as rlsRequired } from './rules/rls-required';

export const rules = {
  'no-reusable-assets': noReusableAssets,
  'rls-required': rlsRequired,
  'no-any-leak': noAnyLeak,
};

export default {
  meta: { name: '@cobolt/lint-rules', version: '0.0.1' },
  rules,
};
