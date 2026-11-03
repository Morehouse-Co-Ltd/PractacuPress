import type { Dictionary } from '../../plural';

/**
 * 来源：`apps/web/src/lib/passwordPolicy.ts`
 *
 * 密码策略与后端 `auth/validation.go` 的 `ValidatePassword` 一一对应；这里的英文
 * 条目只负责把被拒绝的原因说清楚，规则本身不在文案里重复。
 */
const fragment: Dictionary = {
  '密码最多 128 位。': 'The password must be at most 128 characters.',
  '密码不能只有空格。': 'The password cannot be only spaces.',
  '密码需要至少包含两类字符：小写字母、大写字母、数字、符号。':
    'The password must combine at least two of: lowercase letters, uppercase letters, digits, symbols.',
};

export default fragment;
