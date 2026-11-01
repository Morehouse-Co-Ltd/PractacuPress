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
  '这些开关改变什么': 'What these switches change',
  '内置扩展只作用于前台，不会修改已有内容，也不会请求新的接口。':
    'Built-in extensions only affect the public site; they never change existing content or call new endpoints.',
  '阅读进度与目录': 'Reading progress and table of contents',
  '文章页顶部进度线；二、三级标题自动生成锚点与目录。':
    'A progress line at the top of article pages; level-two and level-three headings get anchors and a table of contents automatically.',
  '代码与分享': 'Code and sharing',
  '代码块复制按钮；支持系统分享时调用 Web Share，否则复制链接。':
    'A copy button on code blocks; uses Web Share when the system supports it, otherwise copies the link.',
  '公告与回到顶部': 'Announcement and back to top',
  '页头下方可关闭公告；滚动超过一屏后出现回到顶部按钮。':
    'A dismissible announcement below the header; a back-to-top button appears after scrolling more than one screen.',
  '内置扩展状态保存在本地安装配置，可以随「外观 → 导出配置」一起迁移。':
    'Built-in extension state is stored in the local installation config and moves along with Appearance → Export config.',

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
  '选择导出的 `.ppext.json` 或 `.json` 清单文件。':
    'Pick an exported `.ppext.json` or `.json` manifest file.',
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
  '导入示例扩展（{count} 个）': {
    one: 'Import the sample extension ({count})',
    other: 'Import all sample extensions ({count})',
  },
  '去工坊做一个': 'Build one in the studio',

  // ---- 扩展工坊 ----
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

  // ---- 扩展开发说明 ----
  '扩展开发说明': 'Extension development notes',
  "PP.notify('完成啦');            // 需要 notify 权限":
    "PP.notify('Done');            // requires the notify permission",
  "PP.open('https://example.com'); // 需要 open_link 权限":
    "PP.open('https://example.com'); // requires the open_link permission",
  "PP.navigate('/about');          // 需要 navigate 权限":
    "PP.navigate('/about');          // requires the navigate permission",
  "PP.copy('要复制的文字');         // 需要 clipboard 权限":
    "PP.copy('Text to be copied');         // requires the clipboard permission",
  "PP.storage.get('count');        // 需要 storage 权限（同步返回）":
    "PP.storage.get('count');        // requires the storage permission (synchronous)",
  "PP.storage.set('count', '1');   // 需要 storage 权限":
    "PP.storage.set('count', '1');   // requires the storage permission",
  '写扩展前先看这一节：能挂在哪里、能申请哪些能力、沙箱里不能做什么。':
    'Read this before writing an extension: where it can mount, which abilities it can request, and what the sandbox forbids.',
  '站点页头之后，每页都尝试挂载。': 'After the site header; every page tries to mount it.',
  '站点页脚之前；没有页脚时退回 main 之后。':
    'Before the site footer; falls back to after main when there is no footer.',
  '主页 main#main 的第一个子元素之前。':
    'Before the first child of main#main on the home page.',
  '主页 main#main 的最后一个子元素之后。':
    'After the last child of main#main on the home page.',
  '文章封面之后；没有封面时在正文之前。':
    'After the article cover; before the body when there is no cover.',
  '文章互动区之后；没有互动区时在评论区之前。':
    'After the article reactions; before the comments when there are no reactions.',
  '文章容器内、正文之后。': 'Inside the article container, after the body.',
  '不占文档流，固定在右下角（宽 min(360px, 92vw)）。':
    'Out of the document flow, pinned to the bottom right (width min(360px, 92vw)).',
  '清单里声明后，沙箱桥才会把对应请求转给宿主；未声明的调用会被忽略。':
    'The sandbox bridge only forwards a request to the host when the manifest declares it; calls without a declaration are ignored.',
  '只暴露最小能力；`PP.getContext()` 读取主题、页面类型与标题。':
    'Only a minimal surface is exposed; `PP.getContext()` reads the theme, page type, and title.',
  '高度由扩展调用 `PP.setHeight(px)` 上报；不调用时桥会根据内容自动测量，上限 2000px。':
    'The extension reports its height with `PP.setHeight(px)`; without it the bridge measures the content, up to 2000px.',
  '安全边界': 'Security boundaries',
  'iframe 只有 `allow-scripts`，没有 `allow-same-origin`：拿不到主站 DOM、Cookie 与 localStorage。':
    'The iframe has `allow-scripts` only, never `allow-same-origin`: it cannot reach the main DOM, cookies, or localStorage.',
  "CSP 为 `default-src 'none'`：不能加载远程脚本，只允许内联样式 / 脚本、https 图片与 data 字体。":
    "CSP is `default-src 'none'`: remote scripts cannot load; only inline styles / scripts, https images, and data fonts are allowed.",
  '打开链接只接受 http(s)；站内跳转只接受以 `/` 开头的路径；剪贴板、通知、存储都要声明权限。':
    'Opening links accepts http(s) only; in-site navigation accepts paths that start with `/`; the clipboard, notifications, and storage all need a declared permission.',
  '扩展存储按 id 隔离在 `pp.ext.<id>.*`，key 最长 64、单值最长 2000 字符。':
    'Extension storage is isolated per id under `pp.ext.<id>.*`; keys are at most 64 characters and values at most 2000.',
  '扩展只在站点前台运行，不会出现在管理后台（本页的工坊预览除外）。':
    'Extensions run on the public site only and never appear in the dashboard (except the studio preview on this page).',
  '扩展清单与外观配置保存在同一个本地安装文件里，可以随「外观 → 导出配置」迁移；导出单个扩展使用「我的扩展 → 导出」，文件名是 `<名称>.ppext.json`。':
    'Extension manifests live in the same local installation file as the appearance config and move along with Appearance → Export config; to export a single extension use My extensions → Export, which names the file `<name>.ppext.json`.',

  // ---- 删除确认 ----
  '删除扩展': 'Delete extension',
  '确定删除「{name}」吗？': 'Delete “{name}”?',
  '删除后清单与 HTML / CSS / JS 都会从本地配置移除；已经导出的 `.ppext.json` 文件不受影响。':
    'Deleting removes the manifest and the HTML / CSS / JS from the local config; `.ppext.json` files you already exported are untouched.',
};

export default fragment;
