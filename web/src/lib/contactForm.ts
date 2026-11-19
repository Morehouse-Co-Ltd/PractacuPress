/**
 * 联系表单的校验与请求参数（P3）。
 *
 * 只放**规则**，不放文案：所有提示语都留在渲染器里用 `t()` 包着，这样英文表里
 * 有对应的条目，覆盖率闸门（`i18n/coverage.test.ts`）也扫得到。这里返回的是
 * `ContactIssue` 这种稳定的代码，测试与界面都按代码分支。
 *
 * 两边边界必须一致，否则会出现"前端放行、后端 400"的哑巴失败：
 * - `name` / `email` 在服务端按**字节**限制（通知的 payload 按字节存储），这里也按
 *   字节算，`utf8Length()` 与 Go 的 `len(s)` 同口径；
 * - `message` 在服务端按**字符**限制（中文一字三字节，按字节算会把上限砍到三分之一），
 *   这里按码点算，emoji 只算一个。
 */

/** 与服务端一致的边界；改这里之前先看 `internal/site/contact.go`。 */
export const CONTACT_LIMITS = {
  /** 姓名字节数。 */
  name: 80,
  /** 邮箱字节数。 */
  email: 200,
  /** 留言字符数。 */
  message: 2000,
} as const;

/** 同一访客两次提交之间的最小间隔，与服务端的冷却时间同值。 */
export const CONTACT_COOLDOWN_MS = 60_000;

/** 表单里的一次填写。 */
export interface ContactDraft {
  name: string;
  email: string;
  message: string;
  /**
   * 蜜罐：渲染时藏在屏幕外，正常访客看不见也填不到。
   *
   * 机器人会按 HTML 里的字段名逐个填满，所以非空即视为机器人——判定在提交前做，
   * 命中就**不调用**接口（服务端另有一层同样的判断，挡住绕过前端的请求）。
   */
  website?: string;
}

/** 区块上能藏起来的字段；藏起来的不校验，也不发送。 */
export interface ContactFields {
  showName: boolean;
  showEmail: boolean;
}

/** 一次校验的结果；`null` 表示可以提交。 */
export type ContactIssue =
  | 'message_required'
  | 'message_too_long'
  | 'name_too_long'
  | 'email_too_long'
  | 'email_invalid';

/** 实际发给 `POST /sites/{siteID}/contact` 的字段。 */
export interface ContactPayload {
  name: string;
  email: string;
  message: string;
  website: string;
}

/**
 * UTF-8 字节数。
 *
 * 不用 `TextEncoder`：它依赖宿主环境，而这条规则是纯算术。逐码点累加，与 Go 的
 * `len(string)` 完全同一口径（一个代理对在 JS 里是两个 UTF-16 单元，`for…of`
 * 按码点取值，正好算 4 字节）。
 */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** 码点数：emoji 算一个字符，与作者的直觉一致。 */
function characterLength(text: string): number {
  let count = 0;
  for (const _char of text) count += 1;
  return count;
}

/**
 * 校验一次填写。
 *
 * 顺序固定：先说留言（唯一必填项），再说留名，最后说回信地址。一次只报一个问题
 * ——表单只有一处提示位，堆一串错误只会让读者不知道先改哪个。
 */
export function validateContact(draft: ContactDraft, fields: ContactFields): ContactIssue | null {
  const message = draft.message.trim();
  if (!message) return 'message_required';
  if (characterLength(message) > CONTACT_LIMITS.message) return 'message_too_long';

  const name = draft.name.trim();
  if (fields.showName && utf8Length(name) > CONTACT_LIMITS.name) return 'name_too_long';

  const email = draft.email.trim();
  // 邮箱是可选的：留空就是不回信。填了就必须是个像样的地址。
  if (fields.showEmail && email) {
    if (utf8Length(email) > CONTACT_LIMITS.email) return 'email_too_long';
    if (!looksLikeEmail(email)) return 'email_invalid';
  }

  return null;
}

/**
 * 邮箱的「像不像」判断，与服务端同一条规则：含 `@`，两边都不为空，没有空白字符。
 *
 * 不追求 RFC 5322：那套正则既拦不住垃圾邮件，也拦不住打错的地址；能不能真正回信
 * 只有发出去才知道。
 */
export function looksLikeEmail(email: string): boolean {
  const at = email.indexOf('@');
  if (at <= 0 || at === email.length - 1) return false;
  return !/\s/.test(email);
}

/** 蜜罐是否被填了。 */
export function honeypotTripped(draft: ContactDraft): boolean {
  return (draft.website ?? '').trim() !== '';
}

/**
 * 请求体。
 *
 * 藏起来的字段不发空串：服务端把空串当"没填"，但少发一个键能让日志与测试都更干净。
 * 蜜罐照样发——它是给服务端那一层判断看的，前端这一层已经先短路了。
 */
export function contactPayload(draft: ContactDraft, fields: ContactFields): ContactPayload {
  const payload: ContactPayload = {
    name: '',
    email: '',
    message: draft.message.trim(),
    website: (draft.website ?? '').trim(),
  };
  if (fields.showName) payload.name = draft.name.trim();
  if (fields.showEmail) payload.email = draft.email.trim();
  return payload;
}

/**
 * 冷却还剩多少毫秒。
 *
 * `lastSentAt` 为空表示这次会话还没成功发过。失败不计入冷却：读者改一个字再试一次
 * 是正常操作，卡他一分钟没有道理。
 */
export function cooldownRemainingMs(lastSentAt: number | null, now: number): number {
  if (lastSentAt === null) return 0;
  const elapsed = now - lastSentAt;
  if (elapsed <= 0) return CONTACT_COOLDOWN_MS;
  return Math.max(0, CONTACT_COOLDOWN_MS - elapsed);
}
