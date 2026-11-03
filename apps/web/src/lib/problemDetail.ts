import type { ProblemBody } from '../types';

/**
 * 把服务端的「哪个字段、违反了哪条规则」翻译成用户看得懂的一句话。
 *
 * 背景：`validation_failed` 的 `message` 是固定的「请求参数不符合要求」，真正的原因
 * 在 `details.reason` 里、是给运维看的英文。前端如果只显示 `message`，用户就永远
 * 不知道是邮箱写错了还是密码不够强。
 *
 * 约定（与 `apperr.FieldError` 一致，客户端只认这两个键，绝不解析 `message` 文本）：
 * - `field`: email | password | display_name | name | message | title | slug | role | domain | document
 * - `rule`:  required | malformed | too_short | too_long | too_weak | blank | out_of_range | unknown | too_large | unsupported
 *
 * 两个键缺任何一个、或组合不认识时返回 `null`，调用方保持原有的通用文案。
 */

export interface ProblemDetail {
  field: string;
  rule: string;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** 从响应体里安全地取出字段与规则；不做任何推断。 */
export function problemDetail(problem: ProblemBody | null | undefined): ProblemDetail | null {
  const details = problem?.details;
  if (!details || typeof details !== 'object') return null;
  const record = details as Record<string, unknown>;
  const field = text(record.field);
  const rule = text(record.rule);
  if (!field || !rule) return null;
  return { field, rule };
}

/**
 * 组合键 → 文案。
 *
 * 键是 `field:rule`。没列出的组合返回 `undefined`（走通用文案），不猜。
 * 文案一律以**字面量**传给 `t()`：i18n 覆盖率闸门只认字面量，变量 key 会悄悄漏掉。
 */
function messageFor(detail: ProblemDetail, t: (key: string) => string): string | undefined {
  switch (`${detail.field}:${detail.rule}`) {
    case 'password:too_short':
      return t('密码至少 8 位。');
    case 'password:too_long':
      return t('密码最多 128 位。');
    case 'password:too_weak':
      return t('密码需要至少包含两类字符：小写字母、大写字母、数字、符号。');
    case 'password:blank':
      return t('密码不能只有空格。');

    case 'email:required':
      return t('请填写邮箱地址。');
    case 'email:malformed':
      return t('邮箱地址格式不正确。');
    case 'email:too_long':
      return t('邮箱地址太长，请控制在 254 个字符以内。');

    case 'display_name:required':
      return t('请填写显示名称。');
    case 'display_name:too_long':
      return t('显示名称不能超过 120 个字符。');

    case 'name:required':
      return t('请填写名称。');
    case 'name:too_long':
      return t('名称太长，请精简后再提交。');

    case 'message:required':
      return t('请填写内容。');
    case 'message:too_long':
      return t('内容太长，请精简后再提交。');

    case 'title:required':
      return t('请填写标题。');
    case 'title:too_long':
      return t('标题太长，请精简后再提交。');

    case 'slug:required':
      return t('请填写短链接。');
    case 'slug:malformed':
      return t('短链接只能包含小写字母、数字和连字符。');
    case 'slug:too_long':
      return t('短链接太长。');

    case 'role:required':
      return t('请选择用户组。');
    case 'role:unknown':
      return t('用户组无效。');

    case 'domain:required':
      return t('请填写域名。');
    case 'domain:malformed':
      return t('域名格式不正确，例如 press.example.com。');

    case 'document:required':
      return t('站点设计为空，无法保存。');
    case 'document:too_large':
      return t('站点设计太大了，请删减一些区块后再保存。');
    case 'document:malformed':
      return t('站点设计格式不正确。');

    case 'summary:too_long':
      return t('摘要太长，请精简后再提交。');

    case 'body:required':
      return t('请填写正文。');
    case 'body:too_long':
      return t('正文太长，请精简后再提交。');

    case 'tags:required':
      return t('请至少填写一个标签。');
    case 'tags:too_long':
      return t('标签太多，请删减一些。');
    case 'tags:malformed':
      return t('标签格式不正确，请检查是否含有不允许的字符。');

    case 'target:required':
      return t('缺少要操作的对象，请刷新页面后重试。');
    case 'target:unknown':
      return t('操作对象的类型无法识别。');
    case 'target:unsupported':
      return t('不能对自己执行这个操作。');

    case 'depth:out_of_range':
      return t('回复层级太深了，请直接回复上一层。');

    case 'color:malformed':
      return t('颜色格式不正确，请使用 #rrggbb 这样的写法。');

    default:
      return undefined;
  }
}

/** 对外入口：拿不到具体原因时返回 `null`，把通用文案的决定权交回调用方。 */
export function problemDetailText(
  detail: ProblemDetail | null,
  t: (key: string) => string,
): string | null {
  if (!detail) return null;
  return messageFor(detail, t) ?? null;
}

/** 供测试遍历：所有认识的组合。新增一条就必须出现在这里。 */
export const KNOWN_DETAILS: ProblemDetail[] = [
  { field: 'password', rule: 'too_short' },
  { field: 'password', rule: 'too_long' },
  { field: 'password', rule: 'too_weak' },
  { field: 'password', rule: 'blank' },
  { field: 'email', rule: 'required' },
  { field: 'email', rule: 'malformed' },
  { field: 'email', rule: 'too_long' },
  { field: 'display_name', rule: 'required' },
  { field: 'display_name', rule: 'too_long' },
  { field: 'name', rule: 'required' },
  { field: 'name', rule: 'too_long' },
  { field: 'message', rule: 'required' },
  { field: 'message', rule: 'too_long' },
  { field: 'title', rule: 'required' },
  { field: 'title', rule: 'too_long' },
  { field: 'slug', rule: 'required' },
  { field: 'slug', rule: 'malformed' },
  { field: 'slug', rule: 'too_long' },
  { field: 'role', rule: 'required' },
  { field: 'role', rule: 'unknown' },
  { field: 'domain', rule: 'required' },
  { field: 'domain', rule: 'malformed' },
  { field: 'document', rule: 'required' },
  { field: 'document', rule: 'too_large' },
  { field: 'document', rule: 'malformed' },
  { field: 'summary', rule: 'too_long' },
  { field: 'body', rule: 'required' },
  { field: 'body', rule: 'too_long' },
  { field: 'tags', rule: 'required' },
  { field: 'tags', rule: 'too_long' },
  { field: 'tags', rule: 'malformed' },
  { field: 'target', rule: 'required' },
  { field: 'target', rule: 'unknown' },
  { field: 'target', rule: 'unsupported' },
  { field: 'depth', rule: 'out_of_range' },
  { field: 'color', rule: 'malformed' },
];
