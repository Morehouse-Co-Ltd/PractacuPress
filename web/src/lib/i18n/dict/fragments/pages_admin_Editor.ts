import type { Dictionary } from '../../plural';

/** 来源：`web/src/pages/admin/Editor.tsx` */
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
  '保存后会生成一份内容；右上角可以直接保存草稿或发布，正文会交给服务端清洗。':
    'Saving creates a piece of content; the buttons at the top right save a draft or publish it directly. The server sanitizes the body.',
  '右上角决定存草稿还是发布；这里显示当前状态。':
    'The top-right buttons save a draft or publish; this panel shows the current status.',
  '作者不能审核自己的内容；如果当前账户没有直接发布权限，右上角主按钮会显示「提交审核」。':
    'Authors cannot review their own content; if this account cannot publish directly, the primary button at the top right reads “Submit for review”.',
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
  '发布与上传会调用 内置安全清洗；不可用时服务端返回 503，内容会保留但不会公开。':
    'Publishing and uploads call the built-in security checks; when it is unavailable the server returns 503, and the content is kept but not published.',
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
  保存修订: 'Save revision',
  '已发布内容仍可修订，归档由编辑执行。':
    'Published content can still be revised; an editor archives it.',
  版本历史: 'Version history',
  '每次保存都会留下一个可回滚的版本，最多保留 20 个。':
    'Every save keeps a restorable version; the newest 20 are retained.',
  正在载入版本历史: 'Loading version history',
  无法读取版本历史: 'The version history could not be loaded',
  还没有版本记录: 'No versions yet',
  回滚: 'Restore',
  回滚前备份: 'Backup before restore',
  无法读取这个版本: 'This version could not be read',
  '已回滚到版本 {version}': 'Restored version {version}',
  回滚失败: 'Restore failed',
  '版本 {version}': 'Version {version}',
  回滚到此版本: 'Restore this version',
  编辑者: 'Editor',
  '回滚这份稿件？': 'Restore this draft?',
  '回滚前会先备份当前版本，因此回滚本身也可以撤销；发布状态不会改变。':
    'The current version is backed up first, so the restore can itself be undone; the publish status does not change.',
  确认回滚: 'Restore it',
  '将恢复到版本 {version}（{date}）。': 'Restore version {version} ({date}).',

  // ---- 本地自动保存与草稿恢复 ----
  '正在保存本地草稿…': 'Saving the local draft…',
  '本地草稿保存失败（可能是浏览器存储已满）':
    'The local draft could not be saved (browser storage may be full)',
  '草稿已自动保存 · {time}': 'Draft autosaved · {time}',
  自动保存失败: 'Autosave failed',
  '浏览器本地存储空间不足或已被禁用；请先手动保存草稿。':
    'Browser storage is full or disabled; save the draft manually for now.',
  本地草稿已恢复: 'Local draft restored',
  '还没有保存到服务器，记得保存草稿。':
    'It has not been saved to the server yet; remember to save the draft.',
  本地草稿已丢弃: 'Local draft discarded',
  '编辑器保留服务器上的当前版本。': 'The editor keeps the current server version.',
  有未处理的本地草稿: 'An undecided local draft remains',
  '继续编辑会覆盖旧草稿；也可以现在恢复。':
    'Editing will overwrite the old draft; you can also restore it now.',
  '恢复上次编辑？': 'Resume your last edit?',
  '发现本地草稿，服务器版本已更新': 'Local draft found, but the server version is newer',
  '服务器上的版本在本地草稿之后更新过。恢复并保存会覆盖服务器版本；如果拿不准，先用服务器版本。':
    'The server version was updated after this local draft. Restoring and saving will overwrite the server version; if unsure, keep the server version.',
  '发现 {time} 自动保存的本地草稿。': 'Found a local draft autosaved {time}.',
  本地草稿: 'Local draft',
  服务器版本: 'Server version',
  稍后再说: 'Decide later',
  丢弃本地草稿: 'Discard local draft',
  恢复本地草稿: 'Restore local draft',
  使用服务器版本: 'Use server version',
  '恢复本地草稿会替换当前编辑区的内容；服务端版本在保存之前不会被改动。':
    'Restoring the local draft replaces the editor content; the server version is not changed until you save.',

  // ---- 发布与访问 ----
  发布与访问: 'Publishing and access',
  '预约发布时间、访问权限与单篇评论策略。':
    'Schedule publication, choose who may read the item, and set its comment policy.',
  预约发布时间: 'Scheduled publication',
  '保存后到点自动发布；手动发布会清除预约。':
    'It publishes automatically at the chosen time; a manual publish clears the schedule.',
  '站点要求先审核，审核通过后才能预约或直接发布。':
    'This site requires review, so scheduling and direct publishing become available after approval.',
  '留空表示不预约。到点后由服务端自动发布。':
    'Leave empty for no schedule. The server publishes the draft when the time arrives.',
  取消预约: 'Cancel schedule',
  访问权限: 'Access',
  '公开内容会出现在列表、搜索与订阅源里。':
    'Public items appear in listings, search and feeds.',
  '密码与仅登录内容只能通过链接访问，不会出现在列表、搜索、订阅源或站点地图里。':
    'Password and members-only items are direct-link-only and never appear in listings, search, feeds or the sitemap.',
  公开: 'Public',
  密码访问: 'Password',
  仅登录读者: 'Members only',
  访问密码: 'Access password',
  '已设置访问密码；留空表示保持不变。':
    'An access password is set; leave empty to keep it.',
  '至少 4 个字符，保存后只保留哈希。':
    'At least 4 characters. Only a hash is stored.',
  留空保持不变: 'Leave empty to keep it',
  设置访问密码: 'Set an access password',
  评论策略: 'Comment policy',
  '单篇设置优先于站点级评论开关。':
    'The per-item setting overrides the site-wide comment switches.',
  跟随站点设置: 'Follow site settings',
  开启评论: 'Comments open',
  关闭评论: 'Comments closed',
  先审后发: 'Review before publishing',
  '密码访问需要设置一个访问密码。': 'Password access needs an access password.',
  '访问密码至少需要 4 个字符。': 'The access password must be at least 4 characters.',
  '预约发布时间必须晚于现在。': 'The scheduled publication must be in the future.',

  // ---- 富文本 / HTML / Markdown 与写作快捷键 ----
  正文编辑格式: 'Body editing format',
  富文本: 'Rich text',
  快捷键: 'Shortcuts',
  查看写作快捷键: 'View writing shortcuts',
  写作快捷键: 'Writing shortcuts',
  '在正文里直接使用；Mac 上把 Ctrl 换成 ⌘。输入法组合期间不会触发。':
    'Use these directly in the body; on a Mac use ⌘ instead of Ctrl. They never fire while an IME is composing.',
  知道了: 'Got it',
  发布或提交审核: 'Publish or submit for review',
  插入链接: 'Insert link',
  '标题二 / 三 / 四级（富文本）': 'Heading 2 / 3 / 4 (rich text)',
  '有序列表（富文本）': 'Numbered list (rich text)',
  '无序列表（富文本）': 'Bulleted list (rich text)',
  '引用（富文本）': 'Quote (rich text)',
  '源码缩进两格（HTML / Markdown）': 'Indent two spaces in source (HTML / Markdown)',
  '打开插入指令（富文本）': 'Open the insert menu (rich text)',
  左侧编辑源码: 'Edit the source on the left',
  实时预览: 'Live preview',
  '与服务端同一套清洗规则': 'Same sanitizer as the server',
  '在这里写 HTML；右侧会实时预览。': 'Write HTML here; the right side previews it live.',
  '在这里写 Markdown；右侧会实时预览。': 'Write Markdown here; the right side previews it live.',
  'HTML 与 Markdown 会互相转换：在这里改完切到另一种格式，内容会同步过去；保存时统一写成 Markdown。':
    'HTML and Markdown convert both ways: edit here, switch formats, and the content follows. Saving always writes Markdown.',

  // ---- 标题上方的元信息条 ----
  设置封面: 'Set cover',
  '封面随内容保存：列表、首页卡片、订阅源与分享卡都会使用它；也可以在这里隐藏封面。':
    'The cover is saved with the content and used by the list, home page cards, feeds, and share cards; it can also be hidden here.',
  分类与标签: 'Category and tags',
  '分类用于归档，标签用于跨分类关联主题；最多 12 个标签。':
    'Categories archive content; tags connect topics across categories. Up to 12 tags.',
  '{count} 个标签': { one: '1 tag', other: '{count} tags' },
  '还没有标签。': 'No tags yet.',
  '更新于 {date}': 'Updated {date}',
  '保存后会生成一份内容。': 'Saving creates a piece of content.',

  // ---- 搜索与分享（单篇 SEO 覆盖，Beta 1.2）----
  搜索与分享: 'Search and sharing',
  '标题、描述、关键词、规范链接、分享图与收录指令。':
    'Title, description, keywords, canonical link, share image, and indexing directive.',
  'SEO 标题': 'SEO title',
  '搜索引擎结果里显示的标题，建议 60 个字符以内。':
    'The title shown in search results; 60 characters or fewer is recommended.',
  '留空则使用站点标题模板': 'Leave empty to use the site title template.',
  '搜索与分享描述': 'Search and share description',
  '搜索结果通常只显示前 160 个字符左右，更长的部分会被截断。':
    'Search results usually show only the first 160 characters or so; anything longer is truncated.',
  '用一两句话说明这篇内容讲什么，留空则使用摘要。':
    'Describe this content in a sentence or two; the summary is used when it is empty.',
  关键词: 'Keywords',
  '用逗号分隔；留空则继承站点关键词。':
    'Separate keywords with commas; leave empty to inherit the site keywords.',
  '规范链接（canonical）': 'Canonical link',
  '同一篇内容另有首发地址时填写；留空则以本站地址为准。':
    'Fill this in when the content was first published elsewhere; leave empty to use this site address.',
  社交分享图: 'Social share image',
  '分享卡片使用的图片地址；留空则回退到封面或站点分享图。':
    'Image URL used by share cards; leave empty to fall back to the cover or the site share image.',
  收录指令: 'Indexing directive',
  '继承站点时跟随「设置 → SEO」的收录开关；禁止收录会把本页移出站点地图。':
    'Inheriting follows the indexing switch in Settings → SEO; noindex removes this page from the sitemap.',
  继承站点: 'Inherit site setting',
  允许收录: 'Allow indexing',
  禁止收录: 'Exclude from search',

  // ---- 并发冲突（契约 F，保存带 revision）----
  保存冲突: 'Save conflict',
  '可以选择载入最新版本，或覆盖保存。':
    'You can load the latest version, or overwrite it with your changes.',
  '这篇内容已被他人修改，你的改动尚未保存。':
    'Someone else changed this content; your changes are not saved.',
  '载入最新版本会丢弃你的改动；覆盖保存会用当前编辑区的内容替换服务器上的版本。':
    'Loading the latest version discards your changes; overwriting replaces the server version with what is in the editor now.',
  '服务器上的最新版本号：{revision}': 'Latest server revision: {revision}',
  载入最新版本: 'Load latest version',
  覆盖保存: 'Overwrite',
  '载入最新版本？': 'Load the latest version?',
  '载入最新版本会丢弃你尚未保存的改动；服务器上的内容不会被改动。':
    'Loading the latest version discards your unsaved changes; the server content is not modified.',
  确认载入: 'Load it',
  已载入最新版本: 'Latest version loaded',
  '你的本地改动已被丢弃。': 'Your local changes were discarded.',
  载入最新版本失败: 'Loading the latest version failed',

  // ---- 版本对比（契约 E，行级 diff）----
  对比: 'Compare',
  版本对比: 'Version comparison',
  '逐行比较两个版本的正文；插入为绿色，删除为红色。':
    'Compare the body of two versions line by line; insertions are green and deletions are red.',
  起始版本: 'From version',
  目标版本: 'To version',
  当前版本: 'Current version',
  正在比较版本: 'Comparing versions',
  'v{from} → v{to}': 'v{from} → v{to}',
  '正文超过 20000 行，只比较了前 20000 行；其余部分没有显示。':
    'The body has more than 20000 lines, so only the first 20000 lines were compared; the rest is not shown.',
  '这两个版本没有正文差异。': 'These two versions have no body differences.',
  无法比较这两个版本: 'These two versions cannot be compared',

  // ---- 草稿预览（契约 H）----
  无法生成预览链接: 'Could not create a preview link',

  // ---- 撤销发布（契约 I）----
  '撤销发布？': 'Unpublish this content?',
  '撤销后内容会回到草稿，公开链接将不再可访问；之后可以再次发布。':
    'Unpublishing returns the content to draft and the public link stops working; you can publish it again later.',
  确认撤销发布: 'Unpublish it',
};

export default fragment;
