/**
 * 密码策略：与后端 `apps/api/internal/auth/validation.go` 的 `ValidatePassword` 保持**逐条一致**。
 *
 * 为什么必须在前端也校验一次：后端拒绝时返回的是 `validation_failed`，`message` 是固定的
 * 「请求参数不符合要求」，真正的原因（"password must combine at least 2 of ..."）在
 * `details.reason` 里，而界面只显示 `message`。于是用户看到的就是一句莫名其妙的
 * 「参数不合法」，完全不知道密码少了什么。前端按同一套规则先拦下来，才能给出具体原因。
 *
 * 规则（与后端一致）：
 * - 8–128 个字符（按码点数，不按字节）；
 * - 不能全是空白；
 * - 至少包含两类字符：小写字母、大写字母、数字、符号。
 *   无大小写的字母（中文、日文……）记作「小写字母」这一类。
 *
 * 这里返回**错误码**而不是文案：文案在 `passwordProblemText` 里以字面量参数的形式交给 t()，
 * 因为 i18n 覆盖率闸门只认字面量，返回成品字符串会让新文案悄悄掉出闸门。
 */

const MIN_LENGTH = 8;
const MAX_LENGTH = 128;
const MIN_CLASSES = 2;

export type PasswordProblem = 'short' | 'long' | 'blank' | 'classes';

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
  if (passwordClasses(raw) < MIN_CLASSES) return 'classes';
  return null;
}

/** 错误码 → 可显示文案；`t` 由调用方传入，保证文案走字面量 key。 */
export function passwordProblemText(
  problem: PasswordProblem,
  t: (key: string) => string,
): string {
  switch (problem) {
    case 'short':
      return t('密码至少 8 位。');
    case 'long':
      return t('密码最多 128 位。');
    case 'blank':
      return t('密码不能只有空格。');
    default:
      return t('密码需要至少包含两类字符：小写字母、大写字母、数字、符号。');
  }
}
