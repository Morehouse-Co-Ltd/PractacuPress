import type { Dictionary } from '../../plural';

/** 来源：`web/src/pages/admin/Seo.tsx` */
const fragment: Dictionary = {
  '配置 SEO': 'Configure SEO',

  '搜索引擎与分享卡片': 'Search engines and share cards',
  '标题模板、描述、canonical、结构化数据，以及可直接下载的 sitemap / robots。':
    'Title templates, descriptions, canonical URLs, structured data, and a sitemap / robots you can download directly.',
  '站点信息': 'Site info',
  '站点地图': 'Sitemap',

  '单页应用的边界': 'Where a single-page app stops',
  '这些标签由前端写入': 'These tags are written by the front end into',
  '：Google、Bing、百度会执行 JavaScript，能读到它们；大多数社交平台的抓取器不执行 JavaScript，分享卡片可能只拿到':
    ': Google, Bing, and Baidu run JavaScript, so they can read them; most social platform crawlers do not run JavaScript, so share cards may only fall back to',
  '里的默认值。需要完整预渲染时，请在托管层开启 SSR 或构建期快照。':
    "'s defaults. When you need full pre-rendering, enable SSR at the hosting layer or use a build-time snapshot.",

  '一篇文章的标题': 'An article title',
  '站点默认描述会出现在这里，约 120–160 字最合适。':
    'The site default description will appear here; about 120–160 characters works best.',

  '搜索结果样式': 'Search result appearance',
  '标题模板支持 {title} 与 {site} 两个占位符。':
    'The title template supports the {title} and {site} placeholders.',
  '标题模板': 'Title template',
  '推荐「{title} · {site}」，过长会被截断。':
    'Recommended: “{title} · {site}”; anything longer gets truncated.',
  '默认描述': 'Default description',
  '文章没有摘要时使用；建议 120–160 字。':
    'Used when an article has no excerpt; 120–160 characters is recommended.',
  '关键词': 'Keywords',
  '逗号分隔。现代搜索引擎基本忽略，但无害。':
    'Comma-separated. Modern search engines mostly ignore it, but it does no harm.',
  '独立出版, 写作, 社区': 'Independent publishing, writing, community',
  '发布者名称': 'Publisher name',
  '写入结构化数据的 Organization。': 'Written into the Organization structured data.',

  '索引与地址': 'Indexing and address',
  '关闭索引后，全站输出': 'With indexing off, the whole site outputs',
  '。': '.',
  '允许搜索引擎收录': 'Allow search engines to index the site',
  '成员限定站点会自动关闭；后台、登录页与搜索结果页始终不收录。':
    'Sites limited to members turn this off automatically; the dashboard, sign-in page, and search results are never indexed.',
  '文章链接结构': 'Permalink structure',
  '选择文章和帖子的固定链接格式。修改后旧链接仍可访问并跳转。':
    'Choose the permalink format for articles and posts. Existing links continue to redirect.',
  '文章': 'Articles',
  '帖子': 'Posts',
  '日期和名称型': 'Day and name',
  '月份和名称型': 'Month and name',
  '数字型': 'Numeric',
  '文章名': 'Post name',
  '自定义结构': 'Custom structure',
  '默认类型路径': 'Default type path',
  '文章自定义结构': 'Article custom structure',
  '帖子自定义结构': 'Post custom structure',
  '可用占位符 %year%、%monthnum%、%day%、%postname% 和 %post_id%。':
    'Available tokens are %year%, %monthnum%, %day%, %postname%, and %post_id%.',
  '结构必须以 / 开头，并包含 %postname% 或 %post_id%。':
    'The structure must start with / and include %postname% or %post_id%.',
  '文章预览': 'Article preview',
  '帖子预览': 'Post preview',
  '帖子跟随文章链接结构': 'Use the article permalink structure for posts',
  '站点地址': 'Site address',
  '用于 canonical 与 sitemap；留空取当前访问地址。':
    'Used for canonical and sitemap; leave it empty to use the current address.',
  '分享图': 'Share image',
  '建议 1200×630，留空则使用文章第一张图。':
    '1200×630 is recommended; leave it empty to use the first image of the article.',
  '/assets/share.png 或 https://...': '/assets/share.png or https://...',
  '分享图预览': 'Share image preview',
  '带不带 @ 都可以。': 'With or without the @ is fine.',

  '订阅源': 'Feeds',
  'RSS 2.0 与 Atom 1.0 由服务端直接提供；关闭后根路径返回 404。':
    'RSS 2.0 and Atom 1.0 are served by the backend; when switched off the root paths answer 404.',
  '启用订阅源': 'Enable feeds',
  '同时关闭 RSS 与 Atom，包括分类与标签订阅。':
    'Turns off RSS and Atom, including the category and tag feeds.',
  '输出全文': 'Include full text',
  '关闭时只输出摘要；打开后包含清洗过的正文。':
    'When off, only the summary is emitted; when on, the sanitized body is included.',
  '每个源最多条数': 'Maximum entries per feed',
  '超过内容服务的上限时会按 100 条截断。':
    'Values above the content service ceiling are clamped to 100 entries.',
  '提供分类与标签订阅': 'Offer category and tag feeds',
  '在 /category/{slug}/ 与 /tag/{slug}/ 下提供 RSS 与 Atom。':
    'Serves RSS and Atom under /category/{slug}/ and /tag/{slug}/.',
  '站点订阅': 'Site feeds',
  '分类与标签订阅': 'Category and tag feeds',

  '站长验证': 'Webmaster verification',
  '把搜索平台给的验证值填进来，会输出对应的 meta 标签。':
    'Paste the verification value the search platform gives you and the matching meta tag is emitted.',
  '百度': 'Baidu',

  '当前生效值': 'Currently in effect',
  '页面渲染时实际写入 head 的内容。': 'What page rendering actually writes into head.',
  '索引': 'Indexing',
  '允许收录': 'Allowed',
  '禁止收录': 'Blocked',
  '已发布内容': 'Published content',
  '{count} 条': { one: '1 item', other: '{count} items' },
  '自定义页面': 'Custom pages',
  '{count} 个': { one: '1 page', other: '{count} pages' },
  'sitemap 条目': 'Sitemap entries',
  '结构化数据包含 WebSite、SearchAction，文章页额外输出 Article 与 BreadcrumbList。':
    'Structured data includes WebSite and SearchAction; article pages also emit Article and BreadcrumbList.',

  '由已发布内容与自定义页面生成，可直接放到站点根目录。':
    'Generated from published content and custom pages; it can sit straight in the site root.',
  '已下载 sitemap.xml': 'Downloaded sitemap.xml',
  '下载': 'Download',
  '关闭索引时输出全站 Disallow；否则屏蔽后台与认证页并指向 sitemap。':
    'When indexing is off it outputs a site-wide Disallow; otherwise it blocks the dashboard and auth pages and points at the sitemap.',
  '已下载 robots.txt': 'Downloaded robots.txt',

  '静态托管需要手动放置': 'Static hosting needs these files placed by hand',
  '单页应用不能自己对外提供根目录文件。把这两个文件放到托管根目录（或反向代理里）才会生效；内容更新后重新下载一次即可。构建产物里已经附带一份默认的':
    'A single-page app cannot serve files from its own root. Put these two files in the hosting root (or in the reverse proxy) for them to take effect; after the content changes, download them again. The build output already ships a default',
};

export default fragment;
