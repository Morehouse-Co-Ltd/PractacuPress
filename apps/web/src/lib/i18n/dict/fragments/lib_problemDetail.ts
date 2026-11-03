import type { Dictionary } from '../../plural';

/**
 * 来源：`apps/web/src/lib/problemDetail.ts`
 *
 * 服务端在 `validation_failed` 的 `details` 里给出 `field` + `rule`，这里把它们翻成
 * 用户看得懂的一句话。与 `lib_passwordPolicy.ts` 重复的文案复用同一个中文键，
 * 英文只需维护一份。
 */
const fragment: Dictionary = {
  '请填写邮箱地址。': 'Enter an email address.',
  '邮箱地址格式不正确。': 'That email address is not in a valid format.',
  '邮箱地址太长，请控制在 254 个字符以内。': 'The email address is too long; keep it within 254 characters.',
  '请填写名称。': 'Enter a name.',
  '名称太长，请精简后再提交。': 'The name is too long; shorten it and try again.',
  '请填写内容。': 'Enter some content.',
  '内容太长，请精简后再提交。': 'The content is too long; shorten it and try again.',
  '请填写标题。': 'Enter a title.',
  '标题太长，请精简后再提交。': 'The title is too long; shorten it and try again.',
  '请填写短链接。': 'Enter a slug.',
  '短链接只能包含小写字母、数字和连字符。': 'A slug may contain only lowercase letters, digits and hyphens.',
  '短链接太长。': 'The slug is too long.',
  '请选择用户组。': 'Choose a group.',
  '用户组无效。': 'That group is not valid.',
  '请填写域名。': 'Enter a domain.',
  '域名格式不正确，例如 press.example.com。': 'That domain is not in a valid format, for example press.example.com.',
  '站点设计为空，无法保存。': 'The site design is empty, so there is nothing to save.',
  '站点设计太大了，请删减一些区块后再保存。':
    'The site design is too large; remove some blocks and save again.',
  '站点设计格式不正确。': 'The site design is not in a valid format.',
  '摘要太长，请精简后再提交。': 'The summary is too long; shorten it and try again.',
  '请填写正文。': 'Enter the body text.',
  '正文太长，请精简后再提交。': 'The body is too long; shorten it and try again.',
  '请至少填写一个标签。': 'Add at least one tag.',
  '标签太多，请删减一些。': 'Too many tags; remove some.',
  '标签格式不正确，请检查是否含有不允许的字符。': 'A tag is not in a valid format; check for disallowed characters.',
  '缺少要操作的对象，请刷新页面后重试。': 'The item to act on is missing; refresh the page and try again.',
  '操作对象的类型无法识别。': 'The type of the item to act on is not recognised.',
  '不能对自己执行这个操作。': 'You cannot do this to yourself.',
  '回复层级太深了，请直接回复上一层。': 'The reply is nested too deeply; reply to the comment above instead.',
  '颜色格式不正确，请使用 #rrggbb 这样的写法。': 'That colour is not valid; use a value such as #rrggbb.',
};

export default fragment;
