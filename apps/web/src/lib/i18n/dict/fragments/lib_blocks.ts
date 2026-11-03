import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/lib/blocks.ts` */
const fragment: Dictionary = {
  '{count} 栏': { one: '1 column', other: '{count} columns' },
  '{count} 列': { one: '1 column', other: '{count} columns' },
  '「跟随主题」：经典单栏沿用主题圆角，夜航双栏与首屏两张 16px 大卡保持一致。':
    '“Follow theme”: the classic single column inherits the theme radius, matching the Nightflight two-column layout and the two 16px hero cards.',
  '16:10 封面卡双列排布；可带小节标题栏与「全部 / 文章 / 帖子」切换。':
    'Two-column 16:10 cover cards, optionally with a section header and All / Articles / Posts tabs.',
  '2–4 栏，可继续嵌套任何区块。': '2–4 columns that can nest any block.',
  'HTML + CSS + JS，在独立 sandbox iframe 中运行。':
    'HTML, CSS and JS running in an isolated sandbox iframe.',
  'iframe 高度': 'Iframe height',
  'iframe 嵌入': 'Iframe embed',
  'MP4/WebM 视频与封面。': 'MP4/WebM video with a poster.',
  '按发布时间倒序，只展示已发布内容。': 'Newest first, published content only.',
  按钮文字: 'Button label',
  按月归档: 'Monthly archive',
  '按站内阅读次数排序，适合放在首页或页面侧栏。':
    'Ranked by views on this site; fits a home page or a page sidebar.',
  '百分比遮罩，保证白字可读；0 表示不压暗。':
    'Percentage overlay that keeps white text readable; 0 disables dimming.',
  '绑定分类 slug': 'Bound category slug',
  背景图压暗: 'Background dimming',
  本机访问统计: 'Local visit stats',
  比例: 'Aspect ratio',
  编号: 'Numbered',
  标签: 'Tag',
  标签云: 'Tag cloud',
  标题: 'Title',
  标准: 'Standard',
  布局: 'Layout',
  裁剪: 'Crop',
  彩虹渐变卡: 'Rainbow gradient card',
  出处: 'Source',
  纯色: 'Solid color',
  纯色块: 'Solid color block',
  '纯色模式下作为界面背景或占位块。':
    'In solid color mode, used as a background or placeholder block.',
  次按钮: 'Secondary button',
  '从已发布内容统计每个月发了多少篇，参考站的「八月 2026 · 1 篇」。':
    'Counts published items per month, like the reference site’s “August 2026 · 1 item”.',
  大格子显示摘要: 'Show summary in large tiles',
  '带标题、说明和链接的条目列表。': 'A list of items with a title, description and link.',
  单位: 'Unit',
  '单行列表（无分栏）': 'Single-column list',
  地址: 'Address',
  '底部「查看更多」': 'Bottom “View more”',
  点击链接: 'Link target',
  订阅横幅: 'Subscribe band',
  对齐: 'Alignment',
  分栏卡片: 'Grid cards',
  分栏列数: 'Grid columns',
  分栏容器: 'Columns container',
  分类胶囊: 'Category pills',
  分类来源: 'Category source',
  封面地址: 'Cover image URL',
  '封面网格：把「内容库 → 首页精选」里置顶的文章铺成格子，每篇占几格在内容库里选。格子越大，标题、阅读量与摘要越完整。':
    'Cover grid: lays out the articles pinned in “Library → Home features” as tiles, and how many tiles each one spans is chosen in the library. The larger the tile, the more complete the title, view count and summary.',
  副标题: 'Subhead',
  '高饱和渐变胶囊，用颜色建立分类记忆。':
    'High-saturation gradient pills that make categories memorable by color.',
  高度: 'Height',
  更多链接文字: 'More link label',
  '关闭时是纯文字的紧凑榜单。': 'When off, it is a compact text-only list.',
  黑卡背景图: 'Black card background image',
  黑卡大标题: 'Black card headline',
  黑卡底部搜索框: 'Search box at the bottom of the black card',
  黑卡底色: 'Black card background',
  黑卡显示域名: 'Show domain on the black card',
  '横向大卡：左侧封面、右侧标题摘要与 meta，是双栏布局的主内容流。':
    'Wide rows with a cover on the left and title, summary and meta on the right — the main content stream of the two-column layout.',
  环形图: 'Donut chart',
  幻灯片: 'Slideshow',
  加载条数: 'Items to load',
  间距: 'Spacing',
  简洁: 'Plain',
  渐变卡按钮: 'Gradient card button',
  渐变卡眉题: 'Gradient card eyebrow',
  渐变卡手写字: 'Gradient card handwriting',
  渐变卡主名: 'Gradient card name',
  胶囊: 'Pill',
  胶囊列表: 'Pills',
  节点: 'Node',
  '仅「彩虹渐变卡」模式使用，例如 hello。':
    'Only used in “Rainbow gradient card” mode, for example hello.',
  紧凑: 'Compact',
  经典首屏: 'Classic hero',
  精选文章: 'Featured article',
  居中: 'Center',
  '可选，填图片地址（http(s) 或 /media/...）。留空就是上面的纯色底。':
    'Optional. Enter an image URL (http(s) or /media/...). Leave empty to keep the solid color above.',
  '可以从媒体库选，也可以填外部图片地址。':
    'Pick one from the media library, or paste an external image URL.',
  快捷键提示: 'Shortcut hints',
  宽松: 'Wide',
  栏数: 'Column count',
  链接: 'Link',
  列表: 'List',
  列数: 'Columns',
  '留空按登录状态自动选择。': 'Leave empty to choose automatically from the sign-in state.',
  '留空使用「查看更多」。': 'Leave empty to use “View more”.',
  '留空使用「搜索文章」。': 'Leave empty to use “Search articles”.',
  '留空使用「外观 → 首页首屏」的标题；支持换行与 *斜体强调*，最多两行。':
    'Leave empty to use the title from “Appearance → Home hero”; line breaks and *italic emphasis* are supported, up to two lines.',
  '留空使用「外观 → 首页首屏」的副标题。':
    'Leave empty to use the subhead from “Appearance → Home hero”.',
  '留空使用「外观 → 首页首屏」的设置；*文字* 为斜体强调。':
    'Leave empty to use the “Appearance → Home hero” setting; *text* renders as italic emphasis.',
  '留空使用默认文案。': 'Leave empty to use the default copy.',
  '留空使用站点名。': 'Leave empty to use the site name.',
  '留空显示「留言箱」。': 'Leave empty to show “Guestbook”.',
  '留空隐藏。': 'Leave empty to hide.',
  '留空隐藏按钮。': 'Leave empty to hide the button.',
  '留空隐藏标题。': 'Leave empty to hide the title.',
  '留空隐藏标题栏。': 'Leave empty to hide the heading bar.',
  '留空隐藏标题行。': 'Leave empty to hide the heading row.',
  留言箱: 'Guestbook',
  '轮播间隔（秒）': 'Autoplay interval (seconds)',
  '没有背景图时使用，默认纯黑。': 'Used when there is no background image; defaults to pure black.',
  眉题: 'Eyebrow',
  '眉题 + 大标题 + 副标题 + 行动按钮，编辑排版风。':
    'Eyebrow, big headline, subhead and call to action — editorial typography.',
  '眉题、标题、正文与局部 CSS。': 'Eyebrow, title, body and scoped CSS.',
  'Markdown 正文：段落、列表、引用、链接与强调都支持；保存的是这段原文。':
    'Markdown body: paragraphs, lists, quotes, links and emphasis are supported; the text itself is what gets saved.',
  内容来源: 'Content source',
  内容流: 'Content feed',
  昵称: 'Display name',
  '年份 / 时间': 'Year / time',
  '契约没有标签端点，这里手动维护。':
    'The contract has no tags endpoint, so tags are maintained by hand here.',
  '切到置顶后，名字里的「热门」就只是标题了，记得改一下小节标题。':
    'After switching to pinned, “Popular” in the name is just a title — remember to update the section heading.',
  '热门模式按名次自动排：2×2 → 2×1 → 2×1 → 四个 1×1，七篇一循环。':
    'Popular mode follows the ranking: 2×2 → 2×1 → 2×1 → four 1×1 tiles, repeating every seven items.',
  热门条目显示缩略图: 'Show thumbnails in the popular list',
  热门文章: 'Popular articles',
  '热门文章（按热度排布）': 'Popular articles (ranked layout)',
  '热门文章按站内阅读次数排序，无统计数据时回退到最新发布。':
    'Popular articles are ranked by views on this site; without stats it falls back to newest first.',
  热门文章标题: 'Popular list heading',
  热门文章篇数: 'Popular articles count',
  容器组: 'Container group',
  时间线: 'Timeline',
  使用主色渐变底: 'Use accent gradient background',
  事件: 'Event',
  视频: 'Video',
  视频地址: 'Video URL',
  '手动幻灯片，自动轮播、箭头与圆点。': 'A manual slideshow with autoplay, arrows and dots.',
  手动胶囊: 'Manual pills',
  手动填写: 'Enter manually',
  输入框占位文字: 'Input placeholder',
  数据: 'Data',
  数据来源: 'Data source',
  数值: 'Value',
  '双卡首屏：左侧大黑卡（可换背景图 + 大标题 + 搜索框）/ 右侧是紧凑的热门榜单，也可以换回彩虹渐变卡。':
    'Two-card hero: a large black card on the left (custom background image, big headline and search box) and a compact popular list on the right, or switch back to the rainbow gradient card.',
  说明: 'Description',
  搜索框占位文字: 'Search placeholder',
  搜索入口: 'Search launcher',
  替代文字: 'Alt text',
  填充: 'Fill',
  条: 'Item',
  条目: 'Items',
  '同一个精选网格的热门预设：按 30 天阅读量排序，最热的占最大格，往下依次是横条与小方块，名次一变排布跟着变。':
    'The popular preset of the same featured grid: ranked by 30-day views, the hottest item takes the largest tile, then wide strips and small squares; the layout follows the ranking.',
  统计卡片: 'Stat cards',
  图标: 'Icon',
  图表: 'Chart',
  图表类型: 'Chart type',
  图片: 'Image',
  '图片、说明与链接，可单独设置圆角。': 'Image, caption and link, with its own corner radius.',
  图片地址: 'Image URL',
  图片来源: 'Image source',
  '团队名上方的小字，留空隐藏。': 'Small text above the team name; leave empty to hide.',
  完整显示: 'Fit',
  网站: 'Website',
  网站卡片: 'Website card',
  '网站卡片或 iframe 嵌入。': 'A website card or an iframe embed.',
  网址: 'URL',
  文本: 'Text',
  文章卡网格: 'Article card grid',
  文章列表: 'Article list',
  '文章数、建站天数、总字数，数字右对齐。': 'Article count, days online and total words, right-aligned.',
  文章组件: 'Articles',
  显示标签: 'Show tags',
  '显示播放/暂停按钮': 'Show play/pause button',
  显示封面: 'Show cover',
  显示建站天数: 'Show days online',
  显示类型与阅读量: 'Show type and views',
  显示内容类型切换: 'Show content type tabs',
  显示篇数: 'Items shown',
  '显示全部 / 文章 / 帖子切换': 'Show All / Articles / Posts tabs',
  显示日期: 'Show date',
  显示日期与阅读时长: 'Show date and reading time',
  显示时间: 'Show time',
  显示时间与阅读时长: 'Show time and reading time',
  显示图例: 'Show legend',
  显示文章数: 'Show article count',
  显示文字: 'Display text',
  显示序号: 'Show index numbers',
  显示右侧栏: 'Show sidebar',
  显示原生播放条: 'Show native controls',
  显示月份数: 'Months shown',
  显示阅读次数: 'Show view count',
  显示摘要: 'Show summary',
  显示总字数: 'Show total words',
  项: 'Item',
  小节标题: 'Section heading',
  悬浮卡片: 'Floating cards',
  颜色: 'Color',
  样式: 'Style',
  '页面底部的一条号召横幅，可改文案与按钮。':
    'A call-to-action band at the bottom of the page; the copy and buttons are editable.',
  夜航首屏: 'Nightflight hero',
  '一段可编辑的引言，适合发刊词与摘句。':
    'An editable quote, good for a masthead note or a favorite passage.',
  '一个打开全屏搜索浮层的按钮（Shift+S）。':
    'A button that opens the full-screen search overlay (Shift+S).',
  一句话: 'One-liner',
  '一排 kbd 芯片，告诉读者键盘能做什么。':
    'A row of kbd chips that shows readers what the keyboard can do.',
  '一张大封面卡，把最新或最想推荐的一篇放在聚光灯下。':
    'One large cover card that puts the newest or most recommended piece in the spotlight.',
  '一张留言表单 + 最新留言列表，适合「留言板 / 树洞」这样的页面。':
    'A message form plus the latest messages, good for guestbook or confession-wall pages.',
  '一组数字指标，适合成果、年度总结。':
    'A set of numeric metrics, good for results and yearly recaps.',
  引导语: 'Intro text',
  引言: 'Quote',
  引言卡: 'Quote card',
  右侧卡片: 'Right card',
  右对齐: 'Align right',
  '与首屏热门篇数合计建议 10–30 篇。':
    'Together with the hero popular list, 10–30 items is recommended.',
  '与下方文章列表合计建议控制在 10–30 篇。':
    'Together with the article list below, 10–30 items is recommended.',
  圆角: 'Corner radius',
  '在 sandbox 中执行，不加载外部脚本。':
    'Runs in the sandbox and loads no external scripts.',
  展示方式: 'Display mode',
  展示篇数: 'Items shown',
  站点统计: 'Site stats',
  张: 'Slide',
  折线图: 'Line chart',
  正文: 'Body',
  '只能访问这个 iframe 内部，不能读取后台。':
    'It can only reach inside this iframe, with no access to the dashboard.',
  '只写声明，例如 font-size: 18px; letter-spacing: .02em; 不会影响其他区块。':
    'Declarations only, for example font-size: 18px; letter-spacing: .02em; other blocks are unaffected.',
  指标: 'Metrics',
  '置顶名单在「内容库 → 首页精选」里勾选。':
    'Tick the pinned list in “Library → Home features”.',
  置顶文章: 'Pinned articles',
  '置顶文章（手动占格）': 'Pinned articles (manual tiles)',
  主按钮: 'Primary button',
  主标题: 'Headline',
  '主色渐变底 + 头像 + 一句话 + 社交链接。':
    'Accent gradient background, avatar, one-liner and social links.',
  '柱状、折线或环形图，可手填或读本机访问统计。':
    'Bar, line or donut chart; fill it by hand or read local visit stats.',
  柱状图: 'Bar chart',
  自定义代码: 'Custom code',
  自动读取分类: 'Read categories automatically',
  自动轮播: 'Autoplay',
  '自动模式会读取「分类与标签」里的全部分类；手动模式可绑定分类并覆盖显示文字。':
    'Automatic mode reads every category from “Categories & tags”; manual mode can bind a category and override the display text.',
  '字号随条目数线性映射，hover 变强调色。':
    'Font size scales linearly with the item count; hover uses the accent color.',
  '纵向容器，把任意区块组合成一个可整体移动的组件。':
    'A vertical container that groups any blocks into one component you can move as a whole.',
  最大宽度: 'Max width',
  最多几篇: 'Maximum items',
  最多显示留言数: 'Maximum messages shown',
  最近文章: 'Recent articles',
  最新发布: 'Newest first',
  '最新或热门文章，支持列表、分栏和悬浮卡片。':
    'Latest or popular articles in a list, grid or floating cards.',
  '最新文章 / 帖子列表 + 右侧栏，带分类切换。':
    'Latest articles and posts with a sidebar and category tabs.',
  '左边是标题卡，右边是热门榜。':
    'The left side is the headline card, the right side is the popular list.',
  '左侧竖线 + 圆点的节点列表，适合站点大事记。':
    'A node list with a vertical line and dots, good for a site timeline.',
  左对齐: 'Align left',
  '左更宽 · 2 : 1': 'Wider left · 2 : 1',
  '左宽 · 3 : 2（默认）': 'Wide left · 3 : 2 (default)',
  左右比例: 'Column ratio',
  左右等宽: 'Equal columns',
  '作用域 CSS': 'Scoped CSS',
  作者卡: 'Author card',

  // ---- 2026-11-01 按钮 ----
  按钮: 'Button',
  '一组带样式的行动按钮：站内跳转、外部链接、对齐与尺寸都能改。':
    'A group of styled call-to-action buttons with editable links, alignment and size.',
  实心: 'Solid',
  描边: 'Outline',
  幽灵: 'Ghost',
  尺寸: 'Size',
  小: 'Small',
  中: 'Medium',
  大: 'Large',
  '外部链接在新窗口打开': 'Open external links in a new tab',
  '最多 4 个。链接可填 http(s) 地址或以 / 开头的站内路径；留空则只显示样式、不可点击。':
    'Up to 4 buttons. Links may be http(s) URLs or absolute site paths starting with /; leave the link empty to show an unclickable style only.',

  // ---- 2026-11-02 文章内容占位符 ----
  文章内容: 'Article content',
  '文章正文的占位符：在文章页渲染真实正文，其它页面只显示占位提示。':
    'A placeholder for the article body: on article pages it renders the real text, on other pages it only shows a placeholder hint.',
  显示目录: 'Show table of contents',
  '目录来自正文里的二级 / 三级标题；「外观 → 目录」已经打开时不会再重复一遍。':
    'The table of contents comes from the h2/h3 headings in the body; when “Appearance → Table of contents” is already on, it is not repeated.',

  // ---- 2026-11-03 栅格与分节 ----
  栅格: 'Grid',
  '12 栏栅格容器：子区块可以占 1–12 栏、左右偏移，栏距走间距标尺。':
    'A 12-column grid: children can span 1–12 columns and sit at a column offset, with the gap following the spacing scale.',
  栏距: 'Column gap',
  '0–9，对应 0–96px 的间距标尺。': '0–9, mapping to a 0–96px spacing scale.',
  分节: 'Section',
  '一整段版面：可限宽、可设上下留白、可加底色与分割线。':
    'A whole band of the page: constrained width, top and bottom padding, background colour and dividers.',
  内容宽度: 'Content width',
  '窄（640）': 'Narrow (640)',
  '常规（860）': 'Regular (860)',
  '宽（1200）': 'Wide (1200)',
  满宽: 'Full width',
  上下留白: 'Vertical padding',
  底色: 'Background colour',
  上下分割线: 'Top and bottom divider',

  // ---- 2026-11-03 内容型区块（功能网格 / 卡片组 / 步骤） ----
  功能网格: 'Feature grid',
  '图标 + 标题 + 说明，2–4 列排开，适合把功能点一次讲清。':
    'Icon, title and description in 2–4 columns: a quick way to explain what the product does.',
  卡片组: 'Card grid',
  '一组可点击的卡片，比功能网格更自由，适合导航与推荐。':
    'A set of clickable cards; freer than the feature grid, good for navigation and recommendations.',
  步骤: 'Steps',
  '按顺序排列的步骤 / 流程，可纵向也可横向排开。':
    'Ordered steps or a process, laid out vertically or horizontally.',
  方向: 'Direction',
  纵向: 'Vertical',
  横向: 'Horizontal',
  '横向在窄屏自动退回纵向。': 'On narrow screens the horizontal layout falls back to vertical.',
  '最多 8 条。图标可填内置图标名，留空则不显示图标。':
    'Up to 8 items. The icon may be any built-in icon name; leave it empty to show no icon.',
  '最多 8 条，序号按顺序自动生成。': 'Up to 8 items; the numbers are generated in order.',
  '最多 9 条。链接可填 http(s) 地址或以 / 开头的站内路径；留空则卡片不可点击。':
    'Up to 9 cards. Links may be http(s) URLs or absolute site paths starting with /; leave the link empty to keep the card unclickable.',

  // ---- 2026-11-03 媒体型区块（团队 / Logo 墙 / 图集） ----
  团队成员: 'Team members',
  '成员头像 + 姓名 + 头衔，头像裁成正圆；没填头像时用姓名首字母兜底。':
    'Member avatar with name and role, cropped to a circle; when no avatar is set, the first letter of the name stands in for it.',
  姓名: 'Name',
  头衔: 'Role',
  '最多 12 位。头像留空时用姓名首字母做占位。':
    'Up to 12 members. When the avatar is empty, the first letter of the name is used as a placeholder.',
  'Logo 墙': 'Logo wall',
  '一排合作方 Logo，默认灰度、悬停恢复彩色，适合客户与伙伴背书。':
    'A row of partner logos, greyscale by default and in colour on hover; good for customer and partner endorsements.',
  'Logo 一行放几个；窄屏自动减少。': 'How many logos per row; narrow screens show fewer.',
  '最多 12 个。替代文字留给读屏；纯装饰可留空。':
    'Up to 12 logos. Alt text is for screen readers; leave it empty for purely decorative images.',
  Logo: 'Logo',
  '图片栅格，点开看大图，可用方向键前后切换。':
    'An image grid; click to see the large version and use the arrow keys to move between images.',
  '1:1 方形': '1:1 square',
  '4:3 横向': '4:3 landscape',
  '16:9 宽幅': '16:9 wide',
  '缩略图裁成同一个比例，点击看原图。':
    'Thumbnails are cropped to the same ratio; click one to see the full image.',
  '最多 20 张。说明会显示在大图下方，也用作图片的替代文字。':
    'Up to 20 images. The caption is shown below the large image and also used as its alt text.',

  // ---- 2026-11-03 说服型区块（定价 / 常见问题 / 用户评价 / 图文交替） ----
  定价表: 'Pricing table',
  '几档价格并排，推荐档用主题色标出；功能清单一行一条，行首加 - 表示这一档不含。':
    'A few price tiers side by side, with the recommended one outlined in the accent colour. Write the feature list one per line; start a line with - to mark a feature as not included.',
  档位: 'Tier',
  '最多 4 档。功能清单一行一条，行首加 - 表示不含该项。':
    'Up to 4 tiers. Write the feature list one per line; start a line with - to mark an item as not included.',
  档位名称: 'Tier name',
  价格: 'Price',
  周期: 'Billing period',
  功能清单: 'Feature list',
  按钮链接: 'Button link',
  推荐档: 'Recommended tier',
  常见问题: 'FAQ',
  '一问一答的折叠列表，第一条可以默认展开。':
    'A collapsible list of questions and answers; the first one can start expanded.',
  默认展开第一条: 'Expand the first one by default',
  问题: 'Question',
  '最多 20 条。问题写在折叠标题上，答案展开后显示。':
    'Up to 20 entries. The question sits on the collapsed row; the answer appears once it is expanded.',
  答案: 'Answer',
  用户评价: 'Testimonials',
  '客户评价卡片：栅格排开，或者一行横滑翻看。':
    'Customer quotes as cards, either in a grid or on one swipeable row.',
  横向滑动: 'Swipe sideways',
  '横向滑动在触屏上左右滑，桌面用方向键或滚动。':
    'The carousel scrolls sideways on touch screens; on desktop use the arrow keys or scroll.',
  评价: 'Testimonial',
  '最多 9 条。评价写一段话，姓名与头衔用于署名。':
    'Up to 9 quotes. Write a short paragraph; the name and role are used as the signature.',
  评价内容: 'Quote',
  图文交替: 'Image and text',
  '一图一文左右排开，正文支持 Markdown；窄屏自动图在上、文在下。':
    'An image beside a block of text, with Markdown support; on narrow screens the image moves above the text.',
  '读屏用；纯装饰可留空。': 'Read by screen readers; leave it empty for decorative images.',
  图在哪一侧: 'Image side',
  左侧: 'Left',
  右侧: 'Right',
  '窄屏一律图在上、文在下。': 'On narrow screens the image always sits above the text.',

  // ---- 2026-11-03 工具型区块（对比表 / 倒计时 / 音频） ----
  对比表: 'Comparison table',
  '一张对比表：一列是项目，另外两列是两个方案；窄屏左右滑动看全。':
    'A comparison table: one column of items and two columns for the options being compared; swipe sideways on narrow screens to see it all.',
  左栏表头: 'Left column heading',
  '两个表头都留空就不画表头行。': 'Leave both headings empty to hide the header row.',
  右栏表头: 'Right column heading',
  行: 'Row',
  '最多 12 行。三列全空的行会自动跳过。':
    'Up to 12 rows. Rows where all three cells are empty are skipped.',
  项目: 'Item',
  左栏: 'Left column',
  右栏: 'Right column',
  倒计时: 'Countdown',
  '距离某个时间还有多久，按天 / 小时 / 分 / 秒排开；到点后显示结束文案。':
    'How long until a point in time, split into days, hours, minutes and seconds; once it passes, the closing text is shown.',
  目标日期: 'Target date',
  '填 2026-12-31 这样的日期（按访客本地零点算），或 2026-12-31T20:00:00+08:00 这样的完整时间。':
    'Write a date such as 2026-12-31 (counted from local midnight), or a full timestamp such as 2026-12-31T20:00:00+08:00.',
  显示秒: 'Show seconds',
  结束后的文案: 'Text after it ends',
  '留空时显示「已结束」。': 'Leave empty to show “Finished”.',
  音频: 'Audio',
  '原生音频播放器，带标题、作者与封面；不自动播放。':
    'A native audio player with title, artist and cover art; it never autoplays.',
  音频地址: 'Audio URL',
  '可以从媒体库选，也可以填外部音频地址；没填就不显示播放器。':
    'Pick one from the media library or paste an external audio URL; leave it empty to show no player.',
  作者: 'Artist',
  封面: 'Cover image',
  '可留空；只作装饰，不参与读屏。': 'Optional; purely decorative and hidden from screen readers.',
};

export default fragment;
