import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/Extensions.tsx` */
const fragment: Dictionary = {
  // ---- 代码编辑器 ----
  ' · 超出上限，保存时会截断': ' · over the limit; it will be truncated when saved',

  // ---- 页面头与内置扩展 ----
  '扩展': 'Extensions',
  '新建扩展': 'New extension',
  '内置扩展': 'Built-in',
  '我的扩展': 'My extensions',
  '扩展工坊': 'Extension studio',
  '内置 {on} / {total}': 'Built-in {on} / {total}',
  '我的扩展 {count}': 'My extensions {count}',
  '内置扩展是随前端发布的能力开关；创作者扩展是一份清单加 HTML / CSS / JS，导入后在本站前台的 sandbox iframe 里运行，可以随时启用、导出或删除。':
    'Built-in extensions are feature switches shipped with the front end; a creator extension is a manifest plus HTML / CSS / JS that runs in a sandbox iframe on this site once imported, and can be enabled, exported, or deleted at any time.',
  '内置扩展与创作者扩展是两套机制': 'Built-in and creator extensions are two separate systems',
  '下面列出的是随前端发布、经过审查的内置能力，只改本站开关。创作者扩展在「我的扩展」里以 sandbox iframe 运行，不接触主站 DOM 与登录态，两者互不影响。':
    'The list below is the reviewed, front-end shipped built-in abilities; you only change the switches on this site. Creator extensions run in a sandbox iframe from My extensions, never touch the main DOM or your session, and the two systems do not affect each other.',
  '全部开启': 'Turn all on',
  '全部关闭': 'Turn all off',
  '扩展已开启': 'Extension turned on',
  '扩展已关闭': 'Extension turned off',
  '已全部开启': 'All turned on',
  '已全部关闭': 'All turned off',
  '去外观页填写公告内容 →': 'Fill in the announcement on the Appearance page →',

  // ---- 我的扩展 ----
  '启用后会出现在站点前台对应的槽位；清单保存在本地安装配置里，可随站点一起迁移。':
    'Once enabled it appears in the matching slot on the public site; the manifest is stored in the local installation config and moves along with the site.',
  '导入扩展': 'Import extensions',
  '全部导出': 'Export all',
  '导入扩展失败': 'Import failed',
  '上次导入失败': 'The last import failed',
  '支持 `.ppext.json` 导出文件、单个裸清单或清单数组；同 id 会覆盖并提示。':
    'Accepts a `.ppext.json` export, a single bare manifest, or an array of manifests; the same id is overwritten and reported.',
  '最多 {count} 个': 'Up to {count}',
  '从文件导入': 'Import from a file',
  '选择文件': 'Choose a file',
  '粘贴 JSON': 'Paste JSON',
  '{\n  "format": "practacu-extension",\n  "version": 1,\n  "extension": { "name": "我的扩展", ... }\n}':
    '{\n  "format": "practacu-extension",\n  "version": 1,\n  "extension": { "name": "My extension", ... }\n}',
  '导入 JSON': 'Import JSON',
  '没有现成清单？': 'No manifest yet?',
  '导入全部示例': 'Import all samples',
  '扩': 'E',
  '已启用': 'Enabled',
  '已停用': 'Disabled',
  '（还没有填写描述）': '(No description yet)',
  '槽位': 'Slot',
  '页面': 'Pages',
  '权限': 'Permissions',
  '{action} {name}': '{action} {name}',
  '停用': 'Disable',
  '导出': 'Export',
  '扩展已启用': 'Extension enabled',
  '扩展已停用': 'Extension disabled',
  '扩展已删除': 'Extension deleted',
  '扩展数量已达上限': 'Extension limit reached',
  '最多 {count} 个，请先删除不用的扩展。':
    'You can keep at most {count}; delete an extension you no longer need first.',
  '已复制扩展': 'Extension duplicated',
  '已导出扩展清单': 'Extension manifest exported',
  '还没有可导出的扩展': 'There are no extensions to export yet',
  '已导出全部扩展': 'All extensions exported',
  '没有导入任何扩展': 'No extensions were imported',
  '覆盖 {count} 个同 id 扩展': {
    one: 'Replaced 1 extension with the same id',
    other: 'Replaced {count} extensions with the same id',
  },
  '因数量上限跳过 {count} 个': {
    one: 'Skipped 1 because of the limit',
    other: 'Skipped {count} because of the limit',
  },
  '已导入 {count} 个扩展': {
    one: 'Imported 1 extension',
    other: 'Imported {count} extensions',
  },
  '可在卡片上打开开关启用。': 'Turn one on with the switch on its card.',
  '还没有创作者扩展': 'No creator extensions yet',
  '可以从示例开始，或者导入别人做好的清单。扩展保存后默认不启用，确认没问题再打开开关。':
    'Start from a sample, or import a manifest someone else made. A saved extension stays off by default; turn it on once you have checked it.',
  '可以从示例开始，或者导入别人做好的清单；导入后在卡片上启用、导出或删除。':
    'Start from a sample, or import a manifest someone else made; once imported you can enable, export or delete it from its card.',
  '导入示例扩展（{count} 个）': {
    one: 'Import the sample extension ({count})',
    other: 'Import all sample extensions ({count})',
  },
  '去工坊做一个': 'Build one in the studio',

  // ---- 创作者扩展（保留已移除的工坊文案，旧配置/文档仍可能引用） ----
  '编辑：{name}': 'Editing: {name}',
  '未命名扩展': 'Untitled extension',
  '新扩展': 'New extension',
  '保存会覆盖「我的扩展」里的同一条清单。':
    'Saving overwrites the matching manifest in My extensions.',
  '保存后会出现在「我的扩展」，默认不启用。':
    'Saving adds it to My extensions, turned off by default.',
  '插入示例模板': 'Insert a sample template',
  '插入示例模板…': 'Insert a sample template…',
  '重置为示例': 'Reset to the sample',
  '更新': 'Update',
  '保存为我的扩展': 'Save to My extensions',
  '已插入示例模板': 'Sample template inserted',
  '已载入示例模板': 'Sample template loaded',
  '可以直接保存为新的扩展，或换成别的模板。':
    'Save it as a new extension right away, or pick a different template.',
  '请先填写扩展名称': 'Give the extension a name first',
  '扩展已更新': 'Extension updated',
  '已保存为我的扩展': 'Saved to My extensions',
  '内容超出上限，已按限制截断。': 'The content went over the limit and was truncated.',
  '默认未启用，可在「我的扩展」打开开关。':
    'It is off by default; use the switch in My extensions.',
  '已导出草稿清单': 'Draft manifest exported',
  '扩展清单': 'Extension manifest',
  '清单决定它出现在哪里、能做什么；内容与脚本在右侧沙箱里实时预览。':
    'The manifest decides where it appears and what it may do; the content and script preview live in the sandbox on the right.',
  '最多 {count} 个字符。': 'Up to {count} characters.',
  '例如：文末作者卡': 'e.g. Author card at the end',
  '版本': 'Version',
  '自由填写，例如 1.0.0。': 'Anything you like, for example 1.0.0.',
  '作者': 'Author',
  '署名': 'Your name',
  '图标': 'Icon',
  '显示在卡片左侧的单字；留空取名称首字。':
    'A single character shown on the left of the card; leave it empty to use the first character of the name.',
  '例：作': 'e.g. A',
  '说明': 'Description',
  '一句话说明这个扩展做什么': 'One line on what this extension does',
  '挂载位置': 'Slots',
  '至少选一个；全部不选会回退到「文章底部」。':
    'Pick at least one; when nothing is selected it falls back to Article bottom.',
  '适用页面': 'Pages',
  '「全部页面」会忽略其它选项；登录页、自定义页只命中「全部页面」。':
    'All pages ignores the other options; the sign-in page and custom pages only match All pages.',
  '申请权限': 'Permissions',
  '没勾选的能力在沙箱桥里会被直接忽略。':
    'Abilities you do not check are ignored outright by the sandbox bridge.',
  '它们只在这个扩展自己的 iframe 里执行，不接触主站 DOM。':
    'They run only inside this extension’s own iframe and never touch the main DOM.',
  '放进 iframe 的 body': 'Placed in the iframe body',
  '自动注入，可用 --pp-bg / --pp-ink / --pp-accent':
    'Injected automatically; --pp-bg / --pp-ink / --pp-accent are available',
  '可用 window.PP 桥读取上下文与上报高度':
    'Use the window.PP bridge to read the context and report a height',
  '实时预览': 'Live preview',
  '与前台相同的 sandbox iframe（allow-scripts，无同源权限）。':
    'The same sandbox iframe as on the public site (allow-scripts, no same-origin access).',
  '前台启用中': 'On for the public site',
  '未启用': 'Off',
  '预览页类型：{page}；标题使用占位内容。扩展未启用时不会出现在前台，但这里始终可以预览。':
    'Preview page type: {page}; the title uses placeholder content. An extension that is off does not appear on the public site, but you can always preview it here.',
  '一篇文章的标题': 'An article title',
  '、': ', ',
  '（未选择）': '(none selected)',

  // ---- 删除确认 ----
  '删除扩展': 'Delete extension',
  '确定删除「{name}」吗？': 'Delete “{name}”?',
  '删除后清单与 HTML / CSS / JS 都会从本地配置移除；已经导出的 `.ppext.json` 文件不受影响。':
    'Deleting removes the manifest and the HTML / CSS / JS from the local config; `.ppext.json` files you already exported are untouched.',
  扩展小组件: 'Extension widgets',
  '服务器扩展以 zip 安装包导入，由后端启动清单决定是否运行；内置扩展随应用发布，免安装。每个扩展以小组件卡片展示，点开卡片查看介绍、权限与前后端能力。':
    'Server extensions are imported as zip packages and the backend manifest decides whether they run; built-in extensions ship with the app and need no install. Each extension is shown as a small widget card; open a card to see its introduction, permissions and front-end/back-end abilities.',
  '服务器扩展与内置扩展都以卡片展示；点击卡片查看介绍、权限与前后端能力。':
    'Server and built-in extensions are shown as cards; open a card to see its introduction, permissions and front-end/back-end abilities.',
  详情: 'Details',
  '共 {count} 个扩展': { one: '1 extension', other: '{count} extensions' },
};

export default fragment;
