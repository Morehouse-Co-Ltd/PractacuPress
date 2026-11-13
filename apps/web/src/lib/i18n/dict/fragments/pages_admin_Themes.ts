import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/Themes.tsx` */
const fragment: Dictionary = {
  '主题设置': 'Theme settings',
  '自定义主题': 'Custom theme',
  '恢复主题默认': 'Restore theme defaults',
  '套用原版主题': 'Apply the default theme',
  '经典吸顶': 'Classic sticky',
  '整条页头吸顶，滚动后加一点阴影。':
    'The whole header sticks to the top and gains a slight shadow once you scroll.',
  '顶部透明': 'Transparent top',
  '页首透明，向下滚动后重新出现底色。':
    'Transparent at the top; the background colour comes back as you scroll down.',
  '悬浮胶囊': 'Floating pill',
  '滚动后收缩成圆角悬浮栏，可配高斯模糊。':
    'Shrinks into a rounded floating bar on scroll, optionally with a gaussian blur.',
  '已改为自定义导航': 'Switched to custom navigation',
  '现在可以改文字、换页面或删掉不需要的入口。':
    'You can now change labels, point entries at other pages, or remove the ones you do not need.',
  '已恢复自动导航': 'Automatic navigation restored',
  '按「首页 / 文章 / 帖子 / 搜索」与加入导航的页面生成。':
    'Generated from Home / Articles / Posts / Search plus any page added to the site navigation.',
  '最多 {count} 个 Tab': 'At most {count} tabs',
  '先删掉不用的入口再添加。': 'Remove an entry you do not use before adding another.',
  '新入口': 'New entry',
  '每个 Tab 最多 {count} 个二级入口': 'Each tab allows at most {count} sub-entries',
  '先删掉不用的入口。': 'Remove an entry you do not use first.',
  '最多 {count} 条快捷链接': 'At most {count} quick links',
  '先删掉不用的链接再添加。': 'Remove a link you do not use before adding another.',
  '最多 {count} 栏': 'At most {count} columns',
  '先删掉不用的栏目再添加。': 'Remove a column you do not use before adding another.',
  '新栏目': 'New column',
  '新条目': 'New item',
  '已切换到「{name}」': 'Switched to “{name}”',
  '配色、排版与{layout}版式已一起切换，首页也同步为该主题的默认编排。':
    'Colours, typography and the {layout} layout all switched together, and the home page now uses this theme’s default arrangement.',
  '双栏': 'two-column',
  '单栏': 'single-column',
  '配色、排版与{layout}版式已一起切换；已有首页编排不会删除，可在页面编排里继续调整。':
    'Colours, typography and the {layout} layout all switched together; your existing home page arrangement is kept and can be adjusted in Page layout.',
  '配色、排版与双栏版式已一起切换；已有首页编排不会删除，可在页面编排里继续调整。':
    'Colours, typography and the two-column layout all switched together; your existing home page arrangement is kept and can be adjusted in Page layout.',
  '配色、排版与单栏版式已一起切换；已有首页编排不会删除。':
    'Colours, typography and the single-column layout all switched together; your existing home page arrangement is kept.',
  '已恢复主题默认': 'Theme defaults restored',
  '当前主题的配色、排版与版式回到原始定义。':
    'The colours, typography and layout of the current theme are back to their original definition.',
  '无法读取这个主题文件。': 'This theme file could not be read.',
  '最多保存 20 套自定义主题，请先删除不用的主题。':
    'You can keep at most 20 custom themes; delete one you do not use first.',
  '已导入并应用「{name}」': 'Imported and applied “{name}”',
  '主题只包含配色、排版与版式，不包含文章或页面。':
    'A theme only contains colours, typography and layout; it never contains articles or pages.',
  '（自定义）': ' (custom)',
  '我的主题': 'My theme',
  '主题名称不能为空。': 'The theme name cannot be empty.',
  '已保存「{name}」': 'Saved “{name}”',
  '可以在主题选择区重新套用，也可以导出给其他站点。':
    'You can apply it again from the theme list, or export it for another site.',
  '原版': 'Default',
  '已删除并回到「{name}」': 'Deleted and switched back to “{name}”',
  '被删除的主题不再可用；站点内容没有变化。':
    'The deleted theme is no longer available; your site content is unchanged.',
  '已删除「{name}」': 'Deleted “{name}”',
  '当前主题没有变化。': 'The current theme is unchanged.',
  '（当前调整）': ' (adjusted)',
  '已经有同名主题，换一个名字。': 'A theme with that name already exists; pick another name.',
  '已创建「{name}」': 'Created “{name}”',
  '配色与版式已经就位，接下来在页面编排里搭页面。':
    'Colours and layout are in place; build your pages next in Page layout.',
  '可以继续微调配色，或稍后去页面编排。':
    'You can keep fine-tuning the colours, or head to Page layout later.',
  '页头样式': 'Header style',
  '最上方 Tab 栏在页首的样子，以及向下滚动后怎么变化；深浅色主题共用。':
    'How the top tab bar looks at the top of the page and how it changes as you scroll down; shared by light and dark themes.',
  '模糊强度': 'Blur amount',
  '背景高斯模糊的半径；数值越大越朦胧。关闭模糊时这一项不生效。':
    'Radius of the background gaussian blur; higher values look hazier. It has no effect while blur is off.',
  '滚动触发距离': 'Scroll threshold',
  '向下滚动超过这个距离后，切换到“滚动后”的样式。':
    'After scrolling down further than this, the “scrolled” style takes over.',
  '背景高斯模糊': 'Background gaussian blur',
  '开启后页头背景半透明并做高斯模糊；关闭则使用实色背景。悬浮胶囊只在滚动后才出现模糊层。':
    'When on, the header background becomes translucent with a gaussian blur; when off it stays a solid colour. The floating pill only blurs after you scroll.',
  '三个样式都会在滚动后变化：经典加阴影、顶部透明补底色、悬浮胶囊收缩成一条圆角栏。悬浮胶囊宽度上限 1280px，窄屏自动铺满；页首透明时请确认首屏背景上的文字仍然可读。':
    'All three styles change on scroll: classic adds a shadow, transparent top restores the background colour, and the floating pill shrinks into a rounded bar. The floating pill is capped at 1280px wide and fills narrow screens; with a transparent top, check that text over the first screen is still readable.',
  '顶部导航 Tab': 'Top navigation tabs',
  '页头显示哪些入口、叫什么名字、指向哪个页面，都在这里决定。':
    'Which entries the header shows, what they are called, and which page they point to are all decided here.',
  '自定义 · {count} 个': 'Custom · {count}',
  '自动': 'Automatic',
  '首页': 'Home',
  '全部文章': 'All articles',
  '全部帖子': 'All posts',
  '关于本站': 'About this site',
  '导航对齐': 'Navigation alignment',
  '靠左': 'Left',
  '居中': 'Centre',
  '靠右': 'Right',
  '图标默认位置': 'Default icon position',
  '单个 Tab 可以单独覆盖。': 'Each tab can override this.',
  '文字左侧': 'Left of the text',
  '文字右侧': 'Right of the text',
  '不显示图标': 'No icon',
  '二级导航默认样式': 'Default sub-navigation style',
  '每个 Tab 也可以单独选择；有二级入口时才出现。':
    'Each tab can choose its own; only shown when a tab has sub-entries.',
  '页头下方胶囊栏': 'Pill bar below the header',
  '收进下拉菜单': 'Collapsed into a dropdown menu',
  '二级栏显示图标': 'Show icons in the sub-navigation bar',
  '关闭后二级栏只显示文字；下拉菜单仍显示已配置的图标。':
    'When off, the sub-navigation bar shows text only; the dropdown menu still shows configured icons.',
  '显示文字': 'Label',
  '第 {index} 个 Tab 的文字': 'Label of tab {index}',
  '/about 或 https://…': '/about or https://…',
  '第 {index} 个 Tab 的链接': 'Link of tab {index}',
  '上移': 'Move up',
  '下移': 'Move down',
  '删除 {name}': 'Delete {name}',
  '图标': 'Icon',
  '无图标': 'No icon',
  '图标位置': 'Icon position',
  '跟随全局': 'Follow global',
  '不显示': 'Hidden',
  '二级入口样式': 'Sub-entry style',
  '胶囊栏': 'Pill bar',
  '下拉菜单': 'Dropdown menu',
  '二级导航': 'Sub-navigation',
  '二级文字': 'Sub-entry label',
  '第 {tab} 个 Tab 的第 {child} 个二级入口文字':
    'Label of sub-entry {child} of tab {tab}',
  '/category/news 或 https://…': '/category/news or https://…',
  '第 {tab} 个 Tab 的第 {child} 个二级入口链接':
    'Link of sub-entry {child} of tab {tab}',
  '二级入口上移': 'Move sub-entry up',
  '二级入口下移': 'Move sub-entry down',
  '{name} 的图标': 'Icon for {name}',
  '添加二级入口': 'Add sub-entry',
  '添加 Tab': 'Add tab',
  '恢复自动导航': 'Restore automatic navigation',
  '站内路径以': 'Site paths begin with',
  '开头；外链会在新窗口打开；链接留空时这个 Tab 只显示文字，用来做分组。':
    'and external links open in a new window; when the link is left empty the tab only shows text, which works as a group heading.',
  '当前 Tab 预览': 'Current tab preview',
  '自动包含“文章”': 'Include “Articles” automatically',
  '自动包含“帖子”': 'Include “Posts” automatically',
  '自动包含“搜索”': 'Include “Search” automatically',
  '自动模式：按上面的开关与勾选“加入站点导航”的页面生成（最多 {count} 个）。改成自定义之后，这些入口不再自动增减。':
    'Automatic mode: generated from the switches above plus any page marked “add to site navigation” (up to {count}). Once you switch to custom, these entries no longer change automatically.',
  '改为自定义 Tab': 'Switch to custom tabs',
  '软件 / 社交快捷链接': 'Software / social quick links',
  '配置 GitHub、X / Twitter、Mastodon、RSS 或任意网站。夜航主题会显示在页头 左上角品牌旁；所有主题都会在页脚最下方底栏上方显示。':
    'Configure GitHub, X / Twitter, Mastodon, RSS or any website. The Night flight theme shows them next to the brand in the top-left of the header; every theme shows them above the bottom bar of the footer.',
  '{count}/{total} 条': '{count}/{total} links',
  '第 {index} 条快捷链接的平台': 'Platform of quick link {index}',
  '第 {index} 条快捷链接的文字': 'Label of quick link {index}',
  'https://github.com/your-name 或 mailto:hi@example.com':
    'https://github.com/your-name or mailto:hi@example.com',
  '第 {index} 条快捷链接的地址': 'Address of quick link {index}',
  '上移快捷链接': 'Move quick link up',
  '下移快捷链接': 'Move quick link down',
  '添加快捷链接': 'Add quick link',
  '地址支持 http(s) 与 mailto；页头只显示图标，页脚会显示图标和文字。':
    'The address accepts http(s) and mailto; the header shows icons only, while the footer shows icons with text.',
  '页脚品牌区': 'Footer brand area',
  '页脚左侧的标题、副标题与简介；每一项留空都会回退到站点信息，不填也不会出现空白。':
    'Title, subtitle and description on the left of the footer; anything left empty falls back to the site info, so no blank space appears.',
  '页脚标题': 'Footer title',
  '留空显示站点名称。': 'Leave empty to show the site name.',
  '例如：Practacu Press': 'e.g. Practacu Press',
  '页脚副标题': 'Footer subtitle',
  '留空沿用「外观 → 品牌副标题」。': 'Leave empty to reuse Appearance → Brand subtitle.',
  '页脚简介': 'Footer description',
  '留空使用站点简介；两者都为空时显示默认文案。':
    'Leave empty to use the site description; when both are empty, default copy is shown.',
  '一句话介绍这间编辑部。': 'One sentence about this newsroom.',
  '显示状态标签': 'Show status tags',
  '公开浏览、审核发布、个人博客等状态；关闭后整行隐藏。':
    'Statuses such as public, moderated or personal blog; turn it off to hide the whole row.',
  '自定义状态标签': 'Custom status tags',
  '用逗号或「、」分隔，最多 4 个；留空显示站点真实状态。':
    'Separate with commas, up to 4; leave empty to show the real site status.',
  '例如：独立出版、写作、社区': 'e.g. Independent publishing, Writing, Community',
  '页脚栏目': 'Footer columns',
  '每栏一个标题，下面是若干「文字 + 链接」；不填链接就是纯文字。':
    'Each column has one title followed by “text + link” items; without a link the item is plain text.',
  '{count}/{total} 栏': '{count}/{total} columns',
  '栏目标题，例如：阅读': 'Column title, e.g. Reading',
  '栏目标题': 'Column title',
  '删除栏目 {name}': 'Delete column {name}',
  '条目文字': 'Item label',
  '链接（可留空）': 'Link (optional)',
  '条目链接': 'Item link',
  '删除条目 {name}': 'Delete item {name}',
  '+ 添加一条': '+ Add one',
  '添加栏目': 'Add column',
  '恢复默认两栏': 'Restore the two default columns',
  '版权文案': 'Copyright text',
  '显示在最下方；支持 {year} 与 {site} 两个占位符，留空使用默认文案。':
    'Shown at the very bottom; supports the {year} and {site} placeholders, and falls back to default copy when empty.',
  '© {year} {site}. 由写作者与读者共同维护。':
    '© {year} {site}. Maintained by its writers and readers.',
  '底部右侧说明': 'Bottom-right note',
  '显示在版权行右侧，例如版本号或备案说明；留空隐藏。':
    'Shown to the right of the copyright line, for example a version number or filing note; leave empty to hide.',
  '前端 v0.1 · React': 'Frontend v0.1 · React',
  'ICP 与公安网备号在': 'ICP and public security filing numbers are set in',
  '站点设置 → 基本信息': 'Site settings → Basic info',
  '里填写与展示；这里只管品牌区、栏目、版权与底部说明。':
    '; this page only covers the brand area, columns, copyright and the bottom note.',
  '生效位置': 'Where it applies',
  '导航在页头，栏目在页脚；两者都跟随主题的排版。':
    'Navigation lives in the header and columns in the footer; both follow the theme typography.',
  '导航模式': 'Navigation mode',
  '自定义': 'Custom',
  'Tab 数量': 'Tab count',
  '{count} 个': { one: '1 tab', other: '{count} tabs' },
  '{count} 栏': { one: '1 column', other: '{count} columns' },
  '条目总数': 'Total items',
  '{count} 条': { one: '1 item', other: '{count} items' },
  '管理页面': 'Manage pages',
  '某个页面的标题会直接出现在 Tab 上；改标题就去页面里改，这里不用重复维护。':
    'A page title appears on the tab as-is; edit it on the page itself instead of maintaining it twice here.',
  '一套主题同时决定配色、排版与页面版式（单栏 / 双栏）。原版与夜航是内置大主题；也可以创建、导入或删除自己的主题，并把页脚与导航 Tab 放在这里统一管理。':
    'A theme decides colours, typography and page layout (single-column / two-column) at once. Default and Night flight are built-in themes; you can also create, import or delete your own, and manage the footer and navigation tabs here.',
  '套用、创建与导入主题在「选择主题」页；这里继续微调配色、字体、高级令牌与外观功能，并统一管理导航 Tab 与页脚。':
    'Apply, create and import themes on the “Choose a theme” page; fine-tune colours, type, advanced tokens and appearance features here, and manage the navigation tabs and footer.',
  '创建主题': 'Create theme',
  '导入主题': 'Import theme',
  '获取主题': 'Get themes',
  '导出当前主题': 'Export current theme',
  '页面编排': 'Page layout',
  '导入主题失败': 'Theme import failed',
  '主题设置分区': 'Theme settings sections',
  '主题与版式': 'Theme and layout',
  '导航与页脚': 'Navigation and footer',
  '加载动画': 'Loading animation',
  '选择主题': 'Choose a theme',
  '上方是当前主题；点击卡片立即应用，单栏/双栏版式会一起切换。':
    'The current theme is shown above; clicking a card applies it immediately and switches the single/two-column layout with it.',
  ' · 已微调': ' · adjusted',
  '导入': 'Import',
  '内置': 'Built-in',
  '使用中': 'In use',
  '一套自定义主题。': 'A custom theme.',
  '深色': 'Dark',
  '浅色': 'Light',
  '删除主题 {name}': 'Delete theme {name}',
  '删除这套主题': 'Delete this theme',
  '从零开始': 'From scratch',
  '选版式、配色起点与外观功能，建好后直接进页面编排。':
    'Pick a layout, a colour starting point and appearance features, then go straight to Page layout.',
  '单栏 / 双栏 · 自定义外观': 'Single-column / two-column · custom appearance',
  '还没有自定义主题。可以「创建主题」从零开始，导入 JSON，或把当前微调后的主题另存。':
    'No custom themes yet. Use “Create theme” to start from scratch, import a JSON file, or save the current adjusted theme as a new one.',
  '当前主题微调': 'Fine-tune the current theme',
  '微调会保留在「{name}」上并标记为已微调；重新点击主题卡片可恢复原定义。':
    'Adjustments stay on “{name}” and mark it as adjusted; click the theme card again to restore its original definition.',
  '另存为主题': 'Save as theme',
  '切到浅色': 'Switch to light',
  '切到深色': 'Switch to dark',
  '当前主题已有本地微调': 'This theme has local adjustments',
  '与主题定义一致': 'Matches the theme definition',
  '配色': 'Colours',
  '背景': 'Background',
  '文字': 'Text',
  '强调色': 'Accent',
  '背景与文字会推导出边框、弱化文字与分隔线；强调色用于链接、当前状态与进度条。':
    'The background and text colours derive borders, muted text and dividers; the accent colour is used for links, current state and progress bars.',
  '标题字体': 'Heading font',
  '衬线': 'Serif',
  '书刊感更强，适合长文。': 'More bookish, suited to long reads.',
  '无衬线': 'Sans-serif',
  '更接近技术博客与产品文档。': 'Closer to technical blogs and product docs.',
  '正文字号': 'Body size',
  '只影响文章与自定义页面的正文。':
    'Only affects the body text of articles and custom pages.',
  '正文栏宽': 'Body column width',
  '太宽会降低长文的可读性。': 'Too wide hurts readability on long articles.',
  '圆角': 'Corner radius',
  '按钮、卡片与输入框共用这套圆角。': 'Buttons, cards and inputs share this radius.',
  '柔化与过渡': 'Soften and transitions',
  '在背景、页头、页脚与卡片之间加一层柔和过渡：不同颜色的组件不再硬切，背景可以带缓慢流动的光晕。只在站点前台生效。':
    'Adds a soft transition between the background, header, footer and cards: differently coloured parts no longer cut hard, and the background can carry a slowly moving glow. Only applies on the public site.',
  '启用柔化': 'Enable softening',
  '柔化强度': 'Soften strength',
  '越大，背景光晕与组件混色越明显。':
    'Higher values make the background glow and the colour blending more obvious.',
  '过渡时长': 'Transition duration',
  '颜色变化的速度；0 表示瞬间切换。':
    'How fast colours change; 0 means an instant switch.',
  '页头模糊': 'Header blur',
  '给吸顶页头加一点毛玻璃。': 'Adds a little frosted glass to the sticky header.',
  '背景柔光渐变': 'Background glow gradient',
  '从强调色与文字色引出两团很淡的光，减弱大块底色。':
    'Pulls two very faint glows from the accent and text colours to soften large areas of background.',
  '组件颜色混色': 'Blend component colours',
  '页头、页脚、浮层与卡片混入少量主题色，边界不再生硬。':
    'The header, footer, overlays and cards blend in a little theme colour so the edges are softer.',
  '高级主题令牌': 'Advanced theme tokens',
  '逐项覆盖页面底色、正文色、分隔线、强调色等变量；不展开也能正常使用。':
    'Override page background, body colour, dividers, accent and other variables one by one; the page works fine without opening this.',
  '{count} 项覆盖': { one: '1 override', other: '{count} overrides' },
  '跟随主题': 'Follow theme',
  '主题绑定的外观功能': 'Appearance features bound to the theme',
  '勾选的分区会出现在「外观」页；取消勾选就从这个主题的外观设置里移除。 内置主题固定为全部开启，自定义主题可以自己决定。':
    'Checked sections appear on the Appearance page; unchecking one removes it from this theme’s appearance settings. Built-in themes always have every section on, custom themes can decide for themselves.',
  '{count}/{total} 个分区': '{count}/{total} sections',
  '改动会立即写进「{name}」，并随主题一起导出。改动后外观页会重新排布； 如果某个分区被关掉，它在外观页就不再出现，已有文案也不会丢失。':
    'Changes are written to “{name}” right away and are exported with the theme. The Appearance page is rearranged afterwards; a section you turn off no longer appears there, and existing copy is not lost.',
  '当前是内置主题「{name}」，外观功能由代码定义。想要自定义分区， 可以先「另存为主题」或「创建主题」。':
    'This is the built-in theme “{name}”, whose appearance features are defined in code. To customise the sections, use “Save as theme” or “Create theme” first.',
  '主题库': 'Theme library',
  '主题文件包含配色、排版、版式与外观绑定。':
    'A theme file contains colours, typography, layout and appearance bindings.',
  '内置主题': 'Built-in themes',
  '{count} 套': { one: '1 theme', other: '{count} themes' },
  '当前主题': 'Current theme',
  '版式': 'Layout',
  '已微调': 'Adjusted',
  '原始定义': 'Original definition',
  '外观功能': 'Appearance features',
  '导入主题不会覆盖文章、页面或自定义 CSS。最多保存 20 套自定义主题。':
    'Importing a theme never overwrites articles, pages or custom CSS. You can keep at most 20 custom themes.',
  '恢复原版主题': 'Restore the default theme',
  '切回内置的原版主题，并清掉当前主题上的微调；不会删除内容或已导入的主题。':
    'Switches back to the built-in default theme and clears the adjustments on the current one; no content or imported theme is deleted.',
  '恢复原版': 'Restore default',
  '创建一套主题': 'Create a theme',
  '选好版式与配色起点，之后再微调；创建完可以直接进页面编排搭页面。':
    'Choose a layout and a colour starting point and fine-tune later; you can go straight to Page layout once it is created.',
  '仅创建': 'Create only',
  '创建并编排页面': 'Create and lay out pages',
  '主题名称': 'Theme name',
  '例如：夜航 · 摄影版': 'e.g. Night flight · Photography',
  '备注': 'Note',
  '可选，方便在主题库里认出它。': 'Optional, helps you recognise it in the theme library.',
  '暖色双栏，适合摄影与社区。': 'Warm two-column palette, suited to photography and community.',
  '编辑排版风，适合长文阅读。': 'Editorial style, suited to long reads.',
  '杂志网格，适合图片与社区。': 'Magazine grid, suited to images and community.',
  '配色起点': 'Colour starting point',
  '沿用当前主题': 'Reuse the current theme',
  '保留现在的配色、字体与圆角。': 'Keeps the current colours, fonts and corner radius.',
  '按版式取默认': 'Use the layout default',
  '单栏取纸白，双栏取夜航。': 'Paper white for single-column, Night flight for two-column.',
  '只影响「外观」页显示哪些设置；取消勾选后，已有文案仍然保留，随时可以再打开。':
    'Only affects which settings the Appearance page shows; unchecked sections keep their copy and can be turned back on at any time.',
  '主题创建后会自动切换为当前主题。点「创建并编排页面」会直接打开页面编排， 为首页与自定义页面加组件。':
    'The new theme becomes the current theme right away. “Create and lay out pages” opens Page layout so you can add components to the home page and custom pages.',
  '从主题市场挑选并安装主题；当前版本先预留入口与接口约定。':
    'Browse and install themes from the theme marketplace; this version only reserves the entry point and the API contract.',
  '打开主题市场': 'Open the theme marketplace',
  '主题市场接口尚未接入': 'The theme marketplace is not connected yet',
  '入口与安装流程已经预留：接入后可以在弹窗里浏览主题、预览并一键安装到本机主题库。 当前版本不写入任何外部链接，接口约定与接入步骤见':
    'The entry point and install flow are already reserved: once connected you can browse themes in this dialog, preview them and install them into the local theme library in one click. This version writes no external links; the contract and integration steps are in',
  '。': '.',
  '计划接口': 'Planned API',
  '安装方式': 'Install method',
  '下载主题 JSON 后复用现有主题导入校验':
    'Download the theme JSON and reuse the existing theme import validation',
  '安全约束': 'Safety constraints',
  '只接受配色、排版与版式；不导入内容与自定义 CSS':
    'Accepts colours, typography and layout only; never imports content or custom CSS',
  '接入时只需在': 'To connect it, put the address into',
  '的': '',
  '填入地址，并实现列表拉取。': 'and implement the list fetch.',
  '导入主题「{name}」？': 'Import the theme “{name}”?',
  '导入主题？': 'Import theme?',
  '主题只包含配色、排版与单栏 / 卡片 / 双栏版式；不会导入文章、页面或自定义 CSS。':
    'A theme only contains colours, typography and a single-column / cards / two-column layout; it never imports articles, pages or custom CSS.',
  '导入并应用': 'Import and apply',
  '没有备注。': 'No note.',
  '导入后会立即应用。当前主题与配色会被替换；文章、页面正文与账户不受影响。':
    'It applies immediately after import. The current theme and colours are replaced; articles, page content and accounts are not affected.',
  '删除主题「{name}」？': 'Delete the theme “{name}”?',
  '删除主题？': 'Delete theme?',
  '这是当前正在使用的主题；删除后会回到原版主题。':
    'This is the theme currently in use; deleting it switches back to the default theme.',
  '删除后不能恢复，除非你重新导入主题文件。':
    'Deletion cannot be undone unless you import the theme file again.',
  '删除主题': 'Delete theme',
  '只删除主题定义，不会删除文章、页面、评论或媒体。':
    'Only the theme definition is deleted; articles, pages, comments and media are untouched.',
  '把当前主题另存为自定义主题': 'Save the current theme as a custom theme',
  '保存当前配色、排版与版式，之后可以在主题选择区一键套用。':
    'Saves the current colours, typography and layout so you can apply them from the theme list later.',
  '保存主题': 'Save theme',
  '例如：我的夜航': 'e.g. My Night flight',
  '暖色双栏，适合摄影站。': 'Warm two-column palette, suited to photography sites.',
  '当前主题：': 'Current theme: ',
  '当前站点': 'this site',
  '文章外观': 'Article appearance',
  '夜航首页的文章卡有两种外观；只改展示，不改文章内容与排序。':
    'Articles on the Night flight home page can use one of two appearances; only the presentation changes, never the content or order.',
  '封面在上': 'Cover on top',
  '现在的外观：封面在卡片上方，标题与简介在下方。':
    'The current look: the cover sits above the card content, with the title and summary below.',
  '模糊背景': 'Blurred background',
  '封面铺满整张卡片并高斯模糊，标题与简介压在图上。':
    'The cover fills the whole card with a gaussian blur, and the title and summary sit over the image.',
  '作用于「文章卡网格」「文章列表」「精选文章」三个区块；「置顶文章 / 热门文章」网格本来就以封面铺底，保持原样。':
    'Applies to the article grid, article list and featured article blocks; the pinned / popular grid already uses covers as its background and stays as is.',
};

export default fragment;
