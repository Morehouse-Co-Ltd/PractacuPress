/**
 * 密码策略：与后端 `internal/auth/validation.go` 的 `ValidatePassword` 保持**逐条一致**。
 *
 * 为什么必须在前端也校验一次：后端拒绝时返回的是 `validation_failed`，`message` 是固定的
 * 「请求参数不符合要求」，真正的原因（"password must combine at least 2 of ..."）在
 * `details.reason` 里，而界面只显示 `message`。于是用户看到的就是一句莫名其妙的
 * 「参数不合法」，完全不知道密码少了什么。前端按同一套规则先拦下来，才能给出具体原因。
 *
 * 规则（与后端一致）：
 * - 12–128 个字符（按码点数，不按字节）；
 * - 不能全是空白；
 * - 不能是内嵌常见弱口令黑名单里的整串（忽略大小写、精确匹配）；
 * - 至少包含两类字符：小写字母、大写字母、数字、符号。
 *   无大小写的字母（中文、日文……）记作「小写字母」这一类。
 *
 * 这里返回**错误码**而不是文案：文案在 `passwordProblemText` 里以字面量参数的形式交给 t()，
 * 因为 i18n 覆盖率闸门只认字面量，返回成品字符串会让新文案悄悄掉出闸门。
 */

import { COMMON_PASSWORDS } from './commonPasswords';

const MIN_LENGTH = 12;
const MAX_LENGTH = 128;
const MIN_CLASSES = 2;

export type PasswordProblem = 'short' | 'long' | 'blank' | 'common' | 'classes';

/** 密码用到了哪几类字符；判定顺序与后端一致。 */
export function passwordClasses(raw: string): number {
  let lower = false;
  let upper = false;
  let digit = false;
  let symbol = false;

  for (const char of raw) {
    if (/\p{Ll}/u.test(char)) lower = true;
    else if (/\p{Lu}/u.test(char)) upper = true;
    else if (/\p{Nd}/u.test(char)) digit = true;
    else if (/\p{L}/u.test(char)) lower = true; // 无大小写的字母，例如中文
    else symbol = true;
  }

  return [lower, upper, digit, symbol].filter(Boolean).length;
}

/** 校验一个**待创建**的密码；通过返回 `null`。 */
export function passwordProblem(raw: string): PasswordProblem | null {
  const length = [...raw].length;
  if (length < MIN_LENGTH) return 'short';
  if (length > MAX_LENGTH) return 'long';
  if (raw.trim() === '') return 'blank';
  // 与后端同一顺序：先报「常见弱口令」，再报字符类不足，用户才知道该换一个密码而不是
  // 在原密码后面补一位数字。
  if (COMMON_PASSWORDS.has(raw.toLowerCase())) return 'common';
  if (passwordClasses(raw) < MIN_CLASSES) return 'classes';
  return null;
}

/**
 * 与后端 `ValidatePasswordForCreation` 对齐：计算“创建/替换密码”时的问题。
 *
 * - 空串 → short（表单必填提示）
 * - 纯空白 → blank（硬失败，即使确认也不保存）
 * - 超过 128 码点 → long（硬失败）
 * - 确认过弱密码 → null
 * - 否则回到严格策略
 */
export function passwordCreationProblem(
  raw: string,
  confirmWeak = false,
): PasswordProblem | null {
  if (raw === '') return 'short';
  if (raw.trim() === '') return 'blank';
  if ([...raw].length > MAX_LENGTH) return 'long';
  if (confirmWeak) return null;
  return passwordProblem(raw);
}

/**
 * 是否属于“可以弹窗确认”的弱密码。
 *
 * 空串、纯空白和超长密码不在这里返回：它们必须直接报错，不能被“仍然使用”绕过。
 */
export function weakPasswordProblem(raw: string): PasswordProblem | null {
  if (raw.trim() === '') return null;
  const problem = passwordProblem(raw);
  return problem === 'short' || problem === 'common' || problem === 'classes'
    ? problem
    : null;
}

/** 错误码 → 可显示文案；`t` 由调用方传入，保证文案走字面量 key。 */
export function passwordProblemText(
  problem: PasswordProblem,
  t: (key: string) => string,
): string {
  switch (problem) {
    case 'short':
      return t('密码至少 12 位。');
    case 'long':
      return t('密码最多 128 位。');
    case 'blank':
      return t('密码不能只有空格。');
    case 'common':
      return t('密码不能是常见弱口令，请换一个更独特的口令。');
    default:
      return t('密码需要至少包含两类字符：小写字母、大写字母、数字、符号。');
  }
}
