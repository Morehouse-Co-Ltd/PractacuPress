import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/Editor.tsx` */
const fragment: Dictionary = {
  'v0.1.0 契约没有提供读取源文的端点，服务端只返回了清洗后的 HTML。为避免用空白覆盖原文，':
    'The v0.1.0 contract has no endpoint for reading the source text, so the server only returns sanitized HTML. To avoid overwriting the original with a blank body,',
  写稿: 'write drafts',
  '新建{kind}': 'New {kind}',
  编辑稿件: 'Edit draft',
  查看稿件: 'View draft',
  查看页面: 'View page',
  查看已渲染页面: 'View the rendered page',
  未保存: 'Not saved',
  已保存: 'Saved',
  正在载入稿件: 'Loading the draft',
  无法打开这份稿件: 'This draft cannot be opened',
  返回内容库: 'Back to the content library',
  '保存后会生成一份内容，并按右侧选择的状态提交或发布。正文会交给服务端清洗。':
    'Saving creates a piece of content and submits or publishes it with the status chosen on the right. The server sanitizes the body.',
  '仅自己与编辑可见，可以继续修改。': 'Only you and editors can see it, and you can keep editing.',
  '进入审核队列，等待另一位编辑处理。': 'It joins the review queue and waits for another editor.',
  直接发布: 'Publish directly',
  '保存后立即公开，仍会经过服务端清洗。':
    'It goes public right after saving, and the server still sanitizes it.',
  '当前发布模式不允许直接发布。': 'The current publish mode does not allow publishing directly.',
  '导入 Markdown': 'Import Markdown',
  '导出 Markdown': 'Export Markdown',
  '已导入 Markdown': 'Markdown imported',
  '已导出 Markdown': 'Markdown exported',
  文件太大: 'File too large',
  'Markdown 文件不应超过 2 MB。': 'Markdown files must be 2 MB or smaller.',
  '无法读取这个 Markdown 文件。': 'This Markdown file could not be read.',
  '内容还没有保存，记得保存草稿。': 'The content is not saved yet; remember to save the draft.',
  '标题不能为空。': 'The title cannot be empty.',
  '标题不能超过 200 个字符。': 'The title cannot be longer than 200 characters.',
  '摘要不能超过 500 个字符。': 'The summary cannot be longer than 500 characters.',
  '正文不能为空。': 'The body cannot be empty.',
  '正文不能超过 200000 个字符。': 'The body cannot be longer than 200000 characters.',
  '路径只能使用小写字母、数字和连字符，例如 hello-world。':
    'The path can only use lowercase letters, digits, and hyphens, for example hello-world.',
  '草稿已保存，但状态切换失败': 'The draft was saved, but the status change failed',
  '内容已保存，但状态切换失败': 'The content was saved, but the status change failed',
  内容已保存: 'Content saved',
  '当前状态：{status}': 'Current status: {status}',
  保存草稿: 'Save draft',
  保存并提交: 'Save and submit',
  保存并发布: 'Save and publish',
  '无法安全地编辑这份稿件': 'This draft cannot be edited safely',
  '编辑入口在这里关闭。新建草稿不受影响。':
    'editing is disabled here. Creating a new draft is unaffected.',
  '{kind}标题': '{kind} title',
  摘要: 'Summary',
  '出现在列表、搜索结果与分享卡片里。留空也可以。':
    'Shown in lists, search results, and share cards. It can be left empty.',
  '用一两句话说明这篇稿子。': 'Describe this draft in a sentence or two.',
  '· 约 {count} 字': { one: '· about 1 word', other: '· about {count} words' },
  '所见即所得 · 直接输入 Markdown · 保存时使用 Markdown':
    'WYSIWYG · type Markdown directly · Markdown is used when saving',
  '正文以所见即所得方式编辑：在段首输入':
    'The body uses WYSIWYG editing: at the start of a paragraph, type',
  或行内: 'or, inline',
  粗体: 'Bold',
  '、': ', ',
  '会即时转成排版；空段落输入': 'turn into formatted text right away; in an empty paragraph, type',
  '可打开插入指令。保存与导出使用 Markdown，公开页面仍以服务端清洗后的 rendered_html 为准。':
    ' to open the insert menu. Saving and exporting use Markdown, and public pages still use the server-sanitized rendered_html.',
  稿件信息: 'Draft info',
  '状态与可用动作由服务端返回。': 'The server returns the status and the available actions.',
  创建: 'Created',
  安全策略: 'Security policy',
  '路径（slug）': 'Path (slug)',
  '创建后仍可修改，但旧链接会失效。':
    'It can still be changed after creation, but old links will stop working.',
  留空自动生成: 'Leave empty to generate one',
  '分类用于归档，标签用于跨分类关联主题。':
    'Categories group content; tags connect topics across categories.',
  管理: 'Manage',
  分类: 'Category',
  '每篇内容选择一个分类。': 'Choose one category for each piece of content.',
  未分类: 'Uncategorized',
  '还没有标签，可以在下方直接添加。': 'There are no tags yet; you can add one below.',
  '已选：{tags}': 'Selected: {tags}',
  '添加新标签，回车确认': 'Add a new tag and press Enter',
  添加标签: 'Add tag',
  发布状态: 'Publish status',
  '保存时按这里的选择提交或发布。': 'Saving submits or publishes with the choice made here.',
  '作者不能审核自己的内容；如果当前账户没有直接发布权限，请选择“提交审核”。':
    'Authors cannot review their own content; if this account cannot publish directly, choose “Submit for review”.',
  流程动作: 'Workflow actions',
  '只有当前账户此刻可以执行的动作会出现。':
    'Only the actions this account can run right now are listed.',
  '作者不能审核自己的内容；请等待另一位编辑处理。':
    'Authors cannot review their own content; wait for another editor.',
  '已发布内容不可直接修改，归档由编辑执行。':
    'Published content cannot be edited directly; an editor archives it.',
  '当前没有可执行的流程动作。': 'No workflow action is available right now.',
  退回稿件: 'Send back',
  '发布与上传会调用 Rust 安全服务；不可用时服务端返回 503，内容会保留但不会公开。':
    'Publishing and uploads call the Rust security service; when it is unavailable the server returns 503, and the content is kept but not published.',
  '保存草稿后，这里会出现提交审核、发布等流程动作。作者不能审核自己的稿件。':
    'After you save a draft, workflow actions such as submitting for review and publishing appear here. Authors cannot review their own drafts.',
  退回这份稿件: 'Send this draft back',
  '退回理由会写入状态记录，并通知作者。作者修改后可以重新提交。':
    'The reason is written to the status record and the author is notified. After revising, the author can submit again.',
  确认退回: 'Send it back',
  退回理由: 'Reason for sending back',
  '例如：第三段的引用缺少来源，补充后可以再提交。':
    'For example: the quote in the third paragraph has no source; add one and submit again.',
  '归档这份稿件？': 'Archive this draft?',
  '归档后内容会从公开列表移出，但已有链接仍然有效。':
    'Archiving removes the content from public lists, but existing links keep working.',
  确认归档: 'Archive it',
  '{action}成功': '{action} succeeded',
  '{action}失败': '{action} failed',
  '现在是「{status}」': 'It is now “{status}”',
  '{author} · 更新于 {date}': '{author} · Updated {date}',
};

export default fragment;
