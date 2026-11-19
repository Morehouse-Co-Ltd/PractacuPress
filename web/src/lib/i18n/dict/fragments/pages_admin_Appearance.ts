import type { Dictionary } from '../../plural';

/** 来源：`web/src/pages/admin/Appearance.tsx` */
const fragment: Dictionary = {
  '白昼 · 卡片首屏': 'Daylight · card hero',
  品牌与页脚: 'Branding and footer',
  '首页首屏、品牌副标题、公告条、版权文案与自定义 CSS；导航 Tab 与页脚栏目保留。':
    'Home hero, brand subtitle, announcement bar, copyright line, and custom CSS; navigation tabs and footer columns are kept.',
  首页编排: 'Home layout',
  '按当前布局变体恢复默认组件。': 'Restore the default blocks for the current layout variant.',
  自定义页面编排: 'Custom page layout',
  '按模板重建组件；页面正文与标题保留。': 'Rebuild blocks from the template; page bodies and titles are kept.',
  加载动画: 'Loading animation',
  '关闭加载画面并回到圆环预设。': 'Turn off the loading screen and go back to the ring preset.',
  性能设置: 'Performance',
  '首屏条数、请求缓存与服务器参数回到默认。':
    'Hero row counts, request caching, and server options return to their defaults.',
  访问限制: 'Access limits',
  '关闭浏览器端保护并恢复默认阈值。':
    'Turn off browser-side protection and restore the default thresholds.',
  域名绑定: 'Domain binding',
  '关闭白名单并清空别名、CORS 与代理地址。':
    'Turn off the allowlist and clear aliases, CORS, and proxy addresses.',

  '夜航 · 左侧黑卡': 'Night Flight · left black card',
  '原版 · 首屏': 'Classic · hero',
  '搜索文章、笔记或标签': 'Search articles, notes, or tags',

  外观: 'Appearance',
  站点管理员: 'Site admin',
  自定义主题: 'Custom theme',
  '无法读取这个文件。': 'This file could not be read.',
  配置已导入: 'Configuration imported',
  '外观、页面与扩展都已替换。': 'Appearance, pages, and extensions have all been replaced.',
  已恢复选中的默认设置: 'Selected defaults restored',
  '文章、页面正文、评论、账户与媒体都没有变化。':
    'Articles, page bodies, comments, accounts, and media are unchanged.',
  '首页首屏、品牌、公告条与自定义 CSS。导航 Tab 与页脚栏目在「主题设置」里；':
    'Home hero, branding, announcement bar, and custom CSS. Navigation tabs and footer columns live in Theme settings;',
  '显示哪些分区由当前主题决定。': 'which sections appear is decided by the current theme.',
  主题设置: 'Theme settings',
  导出配置: 'Export settings',
  页面编排: 'Page layout',

  '当前主题「{name}」': 'Current theme “{name}”',
  ' · 双栏': ' · Two-column',
  ' · 单栏': ' · Single column',
  '这套主题启用了 {enabled}/{total} 个外观分区{tail}':
    'This theme enables {enabled}/{total} appearance sections{tail}',
  '；未启用的分区（{names}）不在本页显示。':
    '; disabled sections ({names}) are hidden on this page.',
  '，本页显示全部设置。': ', so every setting shows on this page.',
  '换主题 / 改绑定': 'Change theme / bindings',
  导航与页脚: 'Navigation and footer',
  导入失败: 'Import failed',

  首页首屏: 'Home hero',
  '夜航会把它放进左侧黑卡：眉题在上、标题两行、副标题在下；区块自己填了标题时以区块为准。':
    'Night Flight places it inside the left black card: kicker on top, a two-line title, then the lede; if the block sets its own title, the block wins.',
  '首页最上方那句话。留空时使用站点名称与简介。':
    'The line at the very top of the home page. Leave it empty to use the site name and description.',
  恢复默认: 'Restore defaults',
  眉题: 'Kicker',
  '显示在黑卡标题上方的小字。留空则不显示。':
    'Small text above the title in the black card. Leave it empty to hide it.',
  '标题上方的小字。留空显示「站点名 · 独立出版」。':
    'Small text above the title. Leave it empty to show “Site name · Independent publishing”.',
  '独立出版 · 每周更新': 'Independent publishing · Weekly updates',
  'Practacu Press · 独立出版': 'Practacu Press · Independent publishing',
  主标题: 'Headline',
  '换行即换行；用 *文字* 标记斜体强调色，{limit}':
    'Line breaks are kept; wrap text in *asterisks* for the italic accent colour, {limit}',
  '夜航最多显示 2 行。': 'Night Flight shows at most 2 lines.',
  '最多 4 行。': 'Up to 4 lines.',
  副标题: 'Lede',
  '显示在黑卡标题下方；留空则不显示。':
    'Shown below the title in the black card; leave it empty to hide it.',
  '留空显示站点简介。': 'Leave it empty to show the site description.',
  '{name} · 独立出版': '{name} · Independent publishing',
  '一间小而安静的编辑部。写作者拥有自己的稿子，读者被当作邻居。':
    'A small, quiet newsroom. Writers own their drafts, and readers are treated as neighbours.',

  品牌与导航: 'Branding and navigation',
  '品牌名下方那行小字；页头显示哪些入口由主题设置里的 Tab 决定。':
    'The small line under the brand name; which header entries appear is decided by the tabs in Theme settings.',
  品牌副标题: 'Brand subtitle',
  '留空则显示默认英文副标题。': 'Leave it empty to show the default English subtitle.',
  '页头 Tab': 'Header tabs',
  自动: 'Automatic',
  自定义: 'Custom',
  '没有 Tab，页头只显示品牌与操作区。':
    'No tabs, so the header only shows the brand and the action area.',
  '想改文字、换页面或加外链，去':
    'To change the text, switch the page, or add an external link, go to',
  '主题设置 → 导航与页脚': 'Theme settings → Navigation and footer',
  '；自定义页面勾选“加入站点导航”后会自动出现在自动模式的 Tab 里。':
    '; custom pages appear in the automatic tabs once you tick “Add to site navigation”.',
  '页脚的栏目、条目、版权文案与备案信息同样在「主题设置 → 导航与页脚」。':
    'Footer columns, items, copyright line, and filing info are also in Theme settings → Navigation and footer.',

  公告条: 'Announcement bar',
  '开启「站点公告条」扩展后，这段文字会显示在页头下方，读者可以关闭。':
    'Once the “Site announcement bar” extension is on, this text shows under the header and readers can dismiss it.',
  已开启: 'On',
  未开启: 'Off',
  公告内容: 'Announcement text',
  '例如：本周六晚八点，线上读稿会。': 'e.g. Online reading session this Saturday at 8 pm.',
  公告链接: 'Announcement link',
  '可选。支持站内路径（/about）或 http(s) 链接。':
    'Optional. Accepts a path on this site (/about) or an http(s) link.',
  '还没有开启：去': 'Not on yet: go to',
  扩展: 'Extensions',
  '打开“站点公告条”。': 'and turn on “Site announcement bar”.',

  '自定义 CSS': 'Custom CSS',
  '只在前台生效，适合微调间距、字体或加一条自己的规则。':
    'Applies to the public site only; handy for fine-tuning spacing, type, or adding a rule of your own.',
  '{count} 字符': { one: '1 character', other: '{count} characters' },
  未使用: 'Not used',
  '只粘贴自己信任的 CSS': 'Only paste CSS you trust',
  '自定义 CSS 不会进入管理后台，也不会执行脚本。不要粘贴来路不明的样式；外部 url() 会把访问者IP暴露给第三方。':
    'Custom CSS never reaches the dashboard and never runs scripts. Do not paste styles from untrusted sources; an external url() exposes visitor IPs to third parties.',
  当前主题没有启用全部外观分区: 'This theme does not enable every appearance section',
  '被主题隐藏的分区：': 'Sections hidden by the theme:',
  '。数据没有丢失，': '. No data is lost,',
  '想让它们回来可以在「主题设置 → 主题绑定的外观功能」里勾选。':
    'and you can tick them back on in Theme settings → appearance features bound to the theme.',

  品牌与页面: 'Branding and pages',
  '配色、版式、导航与页脚都在主题设置里。':
    'Colours, layout, navigation, and footer all live in Theme settings.',
  当前主题: 'Current theme',
  当前版式: 'Current layout',
  外观分区: 'Appearance sections',
  双栏: 'Two-column',
  单栏: 'Single column',
  '{enabled} / {total} 已开启': '{enabled} / {total} enabled',
  自定义页面: 'Custom pages',
  '{count} 个': { one: '1 page', other: '{count} pages' },
  备案信息: 'Filing info',
  已填写: 'Provided',
  未填写: 'Not provided',
  管理扩展: 'Manage extensions',
  管理页面: 'Manage pages',

  导入与导出: 'Import and export',
  '把外观、页面与扩展搬到另一台浏览器。':
    'Move appearance, pages, and extensions to another browser.',
  '导出的 JSON 包含主题、导航 Tab、页脚栏目、自定义页面与扩展开关，':
    'The exported JSON contains the theme, navigation tabs, footer columns, custom pages, and extension toggles,',
  '不包含账户、文章或图片。': 'but not accounts, articles, or images.',
  '导出 JSON': 'Export JSON',
  导入: 'Import',
  '导入会覆盖当前的外观、页面与扩展；账户与内容不受影响。':
    'Importing overwrites the current appearance, pages, and extensions; accounts and content are unaffected.',
  '导入会写入服务端并影响所有访客：当前的外观、页面与扩展会被替换；账户与内容不受影响。':
    'Importing writes to the server and affects every visitor: the current appearance, pages, and extensions are replaced; accounts and content are unaffected.',

  恢复默认站点设置: 'Restore default site settings',
  '可以只重置品牌文案、首页/页面编排、加载动画、性能、访问限制或域名绑定。':
    'You can reset only the branding copy, home and page layouts, loading animation, performance, access limits, or domain binding.',
  '文章、页面正文、评论、账户与媒体不会被删除。':
    'Articles, page bodies, comments, accounts, and media are never deleted.',
  选择范围: 'Choose scope',

  '导入这份配置？': 'Import this configuration?',
  '当前外观、页面与扩展会被文件里的内容替换。':
    'The current appearance, pages, and extensions will be replaced with the contents of the file.',
  '当前外观、页面与扩展会被文件里的内容替换，并立即同步到服务端、对所有访客生效。':
    'The current appearance, pages, and extensions will be replaced with the contents of the file and synced to the server, taking effect for every visitor.',
  '设计包里的自定义 CSS 与自定义代码区块会随站点分发给每个访客，请只导入可信来源的配置。':
    'Custom CSS and custom code blocks in the design package are distributed to every visitor, so only import configurations from sources you trust.',
  替换并保存: 'Replace and save',
  '这是一次整体替换：导入文件里的页面列表会覆盖本地页面。请确认已经导出备份。':
    'This is a full replacement: the page list in the file overwrites the local pages. Make sure you have exported a backup.',

  '恢复哪些默认设置？': 'Which defaults should be restored?',
  '已选择 {count} 项。只影响设置，不删除内容、账户或媒体。':
    '{count} selected. This only affects settings; content, accounts, and media are not deleted.',
  恢复选中项: 'Restore selected',
  全选: 'Select all',
  清空: 'Clear',
  恢复后仍可手动重新配置: 'You can configure it again by hand',
  '这个操作不会备份；需要保留当前外观时，请先用右侧「导出 JSON」。':
    'This does not create a backup; if you need to keep the current appearance, use “Export JSON” on the right first.',
};

export default fragment;
