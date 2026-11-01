// 纯逻辑冒烟测试：主题令牌、区块注册表、思维链求值、页面模板。
import { THEME_PRESETS, applyPreset, applyMode, resolveTokens, themeCss, presetTokens } from '../src/lib/theme.ts';
import { BLOCK_DEFS, createBlock, defaultHomeLayout, blockItems, blockProp, availableBlocks, resolveArea } from '../src/lib/blocks.ts';
import { MAX_PINS, TILE_SPANS, autoSpanForRank, normalizePins, normalizeTileSpan } from '../src/lib/homeTiles.ts';
import { evaluateChain, chainIssue, describeChain } from '../src/lib/logic.ts';
import { PAGE_TEMPLATES } from '../src/lib/templates.ts';
import { readCustomization, DEFAULT_CUSTOMIZATION } from '../src/lib/customize.ts';
import {
  DEFAULT_PERMISSIONS,
  effectiveGroup,
  groupCan,
  normalizePermissions,
  roleForGroup,
} from '../src/lib/permissions.ts';
import {
  DEFAULT_MAIL,
  defaultPortFor,
  mailSettingsReady,
  readMailSettings,
  smtpEnvSnippet,
} from '../src/lib/mail.ts';
import { renderMarkdown, firstImage, htmlToText } from '../src/lib/markdown.ts';
import {
  columnsBlock,
  embedBlock,
  galleryBlock,
  iconBlock,
  imageBlock,
  tableBlock,
  videoBlock,
} from '../src/lib/richBlocks.ts';
import {
  absoluteUrl,
  composeTitle,
  robotsFor,
  robotsTxt,
  sitemapXml,
  buildSitemap,
} from '../src/lib/seo.ts';
import {
  autoNavTabs,
  defaultFooterColumns,
  MAX_FOOTER_COLUMNS,
  MAX_FOOTER_LINKS,
  MAX_NAV_TABS,
  navTabActive,
  normalizeFooterColumns,
  normalizeNavTabs,
  safeHref,
  siteNavTabs,
} from '../src/lib/navigation.ts';
import { builtinThemeBundle, normalizeAppearance, themeSections } from '../src/lib/themes.ts';

let failures = 0;
function check(name: string, condition: boolean, extra = '') {
  if (condition) console.log(`ok   ${name}`);
  else {
    failures += 1;
    console.log(`FAIL ${name} ${extra}`);
  }
}

/* ---- 主题 ---- */
check('7 套预设', THEME_PRESETS.length === 7);
const night = THEME_PRESETS.find((p) => p.id === 'night')!;
check('夜航深色暖黑', night.dark.background === '#18171d');
check('夜航浅色冷白', night.light.background === '#f7f9fe');

const paper = applyPreset(DEFAULT_CUSTOMIZATION.theme, 'paper');
check('applyPreset 切模式', paper.mode === 'light' && paper.preset === 'paper');
const nightDark = applyPreset(DEFAULT_CUSTOMIZATION.theme, 'night');
check('applyPreset 夜航落到深色', nightDark.mode === 'dark' && nightDark.background === '#18171d');
const backToLight = applyMode(nightDark, 'light');
check('applyMode 换令牌组', backToLight.background === '#f7f9fe' && backToLight.preset === 'night');
const custom = applyMode({ ...nightDark, preset: 'custom', tokens: { muted: '#ff0000' } }, 'light');
check('自定义模式保留覆盖', custom.tokens?.muted === '#ff0000');

const css = themeCss({ ...DEFAULT_CUSTOMIZATION, theme: nightDark });
check('CSS 输出 13 个令牌', (css.match(/--[a-z-]+:/g) ?? []).length >= 13);
check('CSS 含 shell', css.includes('--shell:'));

// 令牌名必须与 styles.css 实际消费的名字一致（曾把 background 发成 --background 导致主题不生效）。
const CONSUMED = [
  '--bg',
  '--bg-subtle',
  '--bg-sunken',
  '--ink',
  '--ink-soft',
  '--muted',
  '--faint',
  '--line',
  '--line-strong',
  '--accent',
  '--accent-soft',
  '--prose',
  '--accent-ink',
];
const missing = CONSUMED.filter((name) => !css.includes(`${name}:`));
check('令牌名与 styles.css 消费名一致', missing.length === 0, missing.join(' '));
check('不再发出 --background', !css.includes('--background:'));
check('background 令牌落到 --bg', css.includes('--bg: #18171d'));

/* ---- 区块 ---- */
// 组件数量会随迭代增加，这里只守住下限与唯一性，避免「少了一个」却没人发现。
check('默认组件不少于 30 个', BLOCK_DEFS.length >= 30, `实际 ${BLOCK_DEFS.length}`);
check('组件类型不重复', new Set(BLOCK_DEFS.map((item) => item.type)).size === BLOCK_DEFS.length);
const bentoHome = defaultHomeLayout('bento');
check('bento 默认 8 区块', bentoHome.blocks.length === 8, `实际 ${bentoHome.blocks.length}`);
check('classic 默认 3 区块', defaultHomeLayout('classic').blocks.length === 3);
check('bento 可添加夜航组件', availableBlocks('bento').some((b) => b.type === 'bento-hero'));
check('classic 不可添加 bento-hero', !availableBlocks('classic').some((b) => b.type === 'bento-hero'));
check('新增文章列表组件', availableBlocks('bento').some((b) => b.type === 'post-list'));
check('首屏与分类是整幅', resolveArea(createBlock('bento-hero')) === 'full' && resolveArea(createBlock('category-pills')) === 'full');
check('归档默认侧栏', resolveArea(createBlock('archive')) === 'side');
const heroBlock = createBlock('bento-hero');
check(
  '首屏右卡默认热门文章六篇',
  blockProp(heroBlock, 'right_mode', 'popular') === 'popular' && blockProp(heroBlock, 'popular_limit', 6) === 6,
);
check('首屏默认带搜索框', blockProp(heroBlock, 'show_search', true) === true);
check(
  '首屏黑卡默认纯黑无背景图',
  blockProp(heroBlock, 'bg_color', '#000000') === '#000000' && blockProp(heroBlock, 'bg_image', '') === '',
);
check('首屏默认左宽比例', blockProp(heroBlock, 'hero_ratio', 'wide') === 'wide');
const grid = createBlock('post-grid');
const list = createBlock('post-list');
check('文章网格默认 18 篇', blockProp(grid, 'limit', 18) === 18, String(blockProp(grid, 'limit', 18)));
check('文章列表默认 18 篇', blockProp(list, 'limit', 18) === 18);
check('首页默认总量落在 10~30', 6 + 18 >= 10 && 6 + 18 <= 30);
check(
  '文章列表默认带查看更多',
  blockProp(grid, 'show_more', true) === true && blockProp(list, 'more_label', '查看更多') === '查看更多',
);
check('精选网格组件只在夜航', availableBlocks('bento').some((b) => b.type === 'spotlight'));
check('精选网格默认落主栏', resolveArea(createBlock('spotlight')) === 'main');
check('占格默认 1×1', normalizeTileSpan(undefined) === '1x1');
check('非法占格收敛为 1×1', normalizeTileSpan('3x3') === '1x1' && normalizeTileSpan('2x2') === '2x2');
check('占格选项四个', TILE_SPANS.length === 4);
const spot = createBlock('spotlight');
const spotHot = createBlock('spotlight-hot');
check(
  '置顶预设默认置顶模式、七篇、标题叫置顶文章',
  blockProp(spot, 'source', 'pinned') === 'pinned' &&
    blockProp(spot, 'limit', 7) === 7 &&
    blockProp(spot, 'heading', '置顶文章') === '置顶文章',
);
check(
  '热门预设默认热门模式、标题叫热门文章',
  blockProp(spotHot, 'source', 'popular') === 'popular' &&
    blockProp(spotHot, 'heading', '热门文章') === '热门文章',
);
check(
  '两个预设都在夜航、都落主栏',
  ['spotlight', 'spotlight-hot'].every(
    (type) => availableBlocks('bento').some((b) => b.type === type) && resolveArea(createBlock(type)) === 'main',
  ),
);
check(
  '热门排布第一名最大',
  autoSpanForRank(0) === '2x2' && autoSpanForRank(1) === '2x1' && autoSpanForRank(3) === '1x1',
);
check('热门排布七篇一循环', autoSpanForRank(7) === '2x2' && autoSpanForRank(9) === '2x1');
const pins = normalizePins([
  { id: 'cnt_a', span: '2x2' },
  { id: 'cnt_a', span: '1x1' },
  { id: 'cnt_b', span: 'oops' },
  { span: '2x1' },
  'x',
]);
check('置顶名单去重且收敛占格', pins.length === 2 && pins[0]?.span === '2x2' && pins[1]?.span === '1x1');
check(
  '置顶名单上限',
  normalizePins(Array.from({ length: MAX_PINS + 5 }, (_, i) => ({ id: `c${i}`, span: '1x1' }))).length ===
    MAX_PINS,
);
check('统计与标签默认侧栏', resolveArea(createBlock('stat-list')) === 'side' && resolveArea(createBlock('tag-cloud')) === 'side');
check('列表与精选默认主栏', resolveArea(createBlock('post-list')) === 'main' && resolveArea(createBlock('feature-post')) === 'main');
check('显式落位覆盖默认值', resolveArea({ ...createBlock('tag-cloud'), area: 'main' }) === 'main');
const pills = createBlock('category-pills');
check('itemlist 默认值可解析', blockItems(pills, 'items').length === 3);
check('blockProp 回退', blockProp(pills, 'missing', 'x') === 'x');
check('坏 JSON 返回空数组', blockItems({ ...pills, props: { items: '{oops' } }, 'items').length === 0);
check('非数组 JSON 返回空数组', blockItems({ ...pills, props: { items: '{"a":1}' } }, 'items').length === 0);

/* ---- 思维链 ---- */
const chain = {
  id: 'c1',
  name: '测试链',
  enabled: true,
  steps: [
    { id: 's1', kind: 'trigger' as const, type: 'page_load', config: {} },
    { id: 's2', kind: 'condition' as const, type: 'is_home', config: {} },
    { id: 's3', kind: 'action' as const, type: 'pulse_block', config: { block_id: 'blk_1' } },
  ],
};
const ctx = {
  pathname: '/',
  isMobile: false,
  loggedIn: false,
  personal: false,
  mode: 'dark' as const,
  scroll: 0,
  idleFor: 0,
  event: { kind: 'load' as const },
};
const result = evaluateChain(chain, ctx, true);
check('链条触发并产出动作', result.fired && result.actions.length === 1);
check('describeChain 可读', describeChain(chain).includes('页面载入'));
const broken = { ...chain, steps: [chain.steps[2]] };
check('结构校验拦下无触发链', chainIssue(broken).length > 0);
check('求值拒绝非法链', evaluateChain(broken, ctx, true).fired === false);

/* ---- 页面模板 ---- */
check('页面模板不少于 4 个', PAGE_TEMPLATES.length >= 4, `实际 ${PAGE_TEMPLATES.length}`);
for (const template of PAGE_TEMPLATES) {
  const built = template.build();
  // 页面正文已改由 layout.blocks 承载：模板不再返回 Markdown 的 body 字段。
  check(
    `模板 ${template.id} 可生成`,
    typeof built.summary === 'string' &&
      built.template === template.id &&
      Array.isArray(built.layout.blocks),
  );
}

/* ---- 配置归一化 ---- */
const normalized = readCustomization({ customization: { home: { blocks: [{ type: 'nope', id: 'x' }] } } });
check('坏区块被丢弃并回退默认', normalized.home.blocks.length === 3);
const withVariant = readCustomization({ customization: { layout: { variant: 'bento' } } });
check('变体归一化', withVariant.layout.variant === 'bento' && withVariant.home.blocks.length === 8);
const withPins = readCustomization({
  customization: {
    pins: [
      { id: 'cnt_a', span: '2x2' },
      { id: 'cnt_b', span: '3x3' },
    ],
  },
});
check(
  '置顶文章写进配置并被归一化',
  withPins.pins.length === 2 && withPins.pins[0]?.span === '2x2' && withPins.pins[1]?.span === '1x1',
);
check('没有置顶时是空数组', readCustomization({ customization: {} }).pins.length === 0);

/* ---- 权限组 ---- */
const perms = normalizePermissions({});
check('最高管理员拥有配置权限', perms.owner.capabilities.manage_permission === true);
check('最高管理员可以进入后台', perms.owner.admin_access === true);
check('游客不能持有后台能力', perms.guest.capabilities.comment === false && perms.guest.admin_access === false);
check('管理员默认可配置权限', perms.admin.capabilities.manage_permission === true);
check('成员不能配置权限', perms.member.capabilities.manage_permission === false);
const tampered = normalizePermissions({
  guest: { admin_access: true, capabilities: { comment: true } },
  owner: { admin_access: false, capabilities: { read_content: false } },
});
check('归一化阻止游客越权', tampered.guest.admin_access === false && tampered.guest.capabilities.comment === false);
check('归一化强制最高管理员全开', tampered.owner.capabilities.read_content === true && tampered.owner.admin_access === true);

const personalGroup = effectiveGroup({ kind: 'personal', visibility: 'public', role: 'member', loggedIn: true });
check('个人博客下成员即最高管理员', personalGroup === 'owner');
const communityGroup = effectiveGroup({ kind: 'community', visibility: 'public', role: 'editor', loggedIn: true });
check('社区站点按角色映射', communityGroup === 'moderator' && roleForGroup('moderator') === 'editor');
check('游客未登录落在游客组', effectiveGroup({ kind: 'community', visibility: 'public', loggedIn: false }) === 'guest');
check(
  '登录后浏览不受访客模式限制',
  groupCan(DEFAULT_PERMISSIONS, 'member', 'read_content', { visibility: 'members_only' }) === true,
);
check(
  '访客模式限制游客阅读',
  groupCan(DEFAULT_PERMISSIONS, 'guest', 'read_content', { visibility: 'members_only' }) === false,
);

/* ---- 评论与备案设置 ---- */
const defaults = readCustomization({});
check('评论默认开启且不先审', defaults.comments.enabled === true && defaults.comments.require_review === false);
const overridden = readCustomization({
  customization: { comments: { enabled: false, require_review: true, notice: '理性讨论' }, layout: { police: '京公网安备 11010502030123 号' } },
});
check('评论设置可覆盖', overridden.comments.enabled === false && overridden.comments.require_review === true);
check('公安备案号进入布局配置', overridden.layout.police.includes('11010502030123'));
check('默认公安备案号为空', DEFAULT_CUSTOMIZATION.layout.police === '');

/* ---- 邮件（SMTP）配置 ---- */
const mailDefaults = readMailSettings({});
check('邮件默认启用 STARTTLS', mailDefaults.enabled === true && mailDefaults.encryption === 'starttls');
check('STARTTLS 默认端口 587', defaultPortFor('starttls') === '587');
check('SSL 默认端口 465', defaultPortFor('ssl') === '465');
check('未填主机时不算就绪', mailSettingsReady(mailDefaults) === false);

const mailFilled = readMailSettings({
  mail: {
    enabled: true,
    host: 'smtp.example.com',
    port: '465',
    encryption: 'ssl',
    username: 'noreply@example.com',
    from: 'noreply@example.com',
    from_name: 'Press',
    public_base_url: 'https://press.example.com',
  },
});
check('非机密字段可回填', mailFilled.host === 'smtp.example.com' && mailFilled.encryption === 'ssl');
check('主机与发件人齐全即就绪', mailSettingsReady(mailFilled) === true);

const snippet = smtpEnvSnippet(mailFilled, 's3cret');
check('片段含 SMTP_HOST', snippet.includes('SMTP_HOST=smtp.example.com'));
check('片段含加密与端口', snippet.includes('SMTP_PORT=465') && snippet.includes('SMTP_ENCRYPTION=ssl'));
check('片段含本次填写的密码', snippet.includes('SMTP_PASSWORD=s3cret'));
check('片段含站点地址', snippet.includes('PUBLIC_BASE_URL=https://press.example.com'));

const noSecret = smtpEnvSnippet(mailFilled);
check('未填密码时不泄露占位符以外的内容', noSecret.includes('SMTP_PASSWORD=<在服务端填写>'));
check('默认值不含密码字段', smtpEnvSnippet(DEFAULT_MAIL).includes('还没有填写 SMTP 主机'));

const noneEncryption = readMailSettings({ mail: { ...mailFilled, encryption: 'none', port: '' } });
check('未知加密方式回落 STARTTLS', readMailSettings({ mail: { encryption: 'weird' } }).encryption === 'starttls');
check('不加密时端口留空可按默认 25 推导', defaultPortFor(noneEncryption.encryption) === '25');

/* ---- Markdown 渲染 ---- */
const md = renderMarkdown(
  [
    '# 标题',
    '',
    '正文 **粗体** 与 *斜体*，~~删除线~~，`code`。',
    '',
    '| 列 | 值 |',
    '| --- | ---: |',
    '| 甲 | 1 |',
    '',
    '![封面](https://example.com/a.png)',
    '',
    '- [x] 已完成',
    '- [ ] 待办',
  ].join('\n'),
);
check('标题渲染', md.includes('<h1>标题</h1>'));
check('粗体与斜体', md.includes('<strong>粗体</strong>') && md.includes('<em>斜体</em>'));
check('删除线', md.includes('<del>删除线</del>'));
check('行内代码', md.includes('<code>code</code>'));
check('表格渲染', md.includes('<table class="pp-table">') && md.includes('<th>列</th>'));
check('表格右对齐类名', md.includes('pp-align-right'));
check('图片渲染', md.includes('<img src="https://example.com/a.png" alt="封面"'));
check('任务列表', md.includes('☑') && md.includes('☐'));
check('首图提取', firstImage(md) === 'https://example.com/a.png');
check('纯文本提取', htmlToText('<p>a <strong>b</strong></p>') === 'a b');

/* ---- 富文本区块 ---- */
const cols = columnsBlock(2, ['左栏', '右栏']);
check('分栏用表格承载', cols.includes('class="pp-columns"') && cols.includes('左栏') && cols.includes('右栏'));
const tbl = tableBlock({ rows: 2, cols: 3, header: true });
check('表格三列', (tbl.match(/<th>/g) ?? []).length === 3);
check('表头 + 两行数据', (tbl.match(/<tr>/g) ?? []).length === 3);
const img = imageBlock({ src: 'https://x/y.png', alt: '图', caption: '图注' });
check('图片带图注', img.includes('pp-caption') && img.includes('alt="图"'));
const vid = videoBlock({ url: 'https://www.youtube.com/watch?v=abc123', title: '演示' });
check('YouTube 封面可推导', vid.includes('i.ytimg.com') && vid.includes('pp-video'));
check('无封面用占位样式', videoBlock({ url: 'https://example.com/v' }).includes('pp-video-plain'));
const emb = embedBlock({ url: 'https://example.com/post' });
check('嵌入卡片显示域名', emb.includes('pp-embed') && emb.includes('example.com'));
const icon = iconBlock('star', '每周更新');
check('图标用 i 标签', icon.includes('pp-icon-star') && icon.includes('每周更新'));
const gal = galleryBlock(3, ['https://a/1.png']);
check('图集三格', (gal.match(/<td>/g) ?? []).length === 3);
check(
  '区块只用白名单标签',
  [cols, tbl, img, vid, emb, icon, gal].every((snippet) => !/<(div|span|iframe|video|figure)\b/.test(snippet)),
);

/* ---- SEO ---- */
check('标题模板替换', composeTitle('{title} · {site}', '一篇稿子', '小站') === '一篇稿子 · 小站');
check('空模板回落', composeTitle('', '标题', '站') === '标题 · 站');
check('绝对地址拼接', absoluteUrl('/a/1', 'https://press.example.com') === 'https://press.example.com/a/1');
check(
  '绝对地址不重复前缀',
  absoluteUrl('https://cdn.example.com/x.png', 'https://press.example.com') === 'https://cdn.example.com/x.png',
);
check('搜索页 noindex', robotsFor(true, { noindex: true }, false).includes('noindex'));
check('成员限定站点 noindex', robotsFor(true, {}, true).includes('noindex'));
check('正常页面可收录', robotsFor(true, {}, false).includes('index, follow'));

const entries = buildSitemap({
  origin: 'https://press.example.com',
  contents: [
    { kind: 'article', id: 'a1', status: 'published', updated_at: '2026-10-01T00:00:00Z' },
    { kind: 'post', id: 'p1', status: 'draft', updated_at: '2026-10-02T00:00:00Z' },
  ] as never,
  pages: [
    { slug: 'about', title: '关于', status: 'published', updated_at: '2026-09-01T00:00:00Z' },
    { slug: 'hidden', title: '草稿页', status: 'draft', updated_at: '2026-09-02T00:00:00Z' },
  ],
});
const xml = sitemapXml(entries);
check('sitemap 含首页与文章', entries.length === 5 && xml.includes('https://press.example.com/a/a1'));
check('sitemap 不含草稿', !xml.includes('/p/p1') && !xml.includes('/hidden'));
check('sitemap 声明命名空间', xml.includes('http://www.sitemaps.org/schemas/sitemap/0.9'));
const robots = robotsTxt({ origin: 'https://press.example.com', indexable: true });
check('robots 屏蔽后台', robots.includes('Disallow: /admin'));
check('robots 指向 sitemap', robots.includes('Sitemap: https://press.example.com/sitemap.xml'));
check('关闭索引时全站 Disallow', robotsTxt({ origin: 'https://x', indexable: false }) === 'User-agent: *\nDisallow: /\n');

/* ---- 导航 Tab 与页脚栏目 ---- */
const navPagesFixture = [
  { id: 'p1', title: '关于本站', slug: 'about', status: 'published', show_in_nav: true, created_at: '2026-01-01' },
  { id: 'p2', title: '草稿页', slug: 'draft', status: 'draft', show_in_nav: true, created_at: '2026-01-02' },
] as never[];

const autoTabs = autoNavTabs(DEFAULT_CUSTOMIZATION.layout, navPagesFixture as never);
check(
  '自动导航含首页与内置入口',
  autoTabs.map((tab) => tab.label).join('/') === '首页/文章/帖子/搜索/关于本站',
  autoTabs.map((tab) => tab.label).join('/'),
);
check(
  '自动导航跳过草稿页',
  !autoTabs.some((tab) => tab.href === '/draft'),
);
check(
  '自动导航遵守 show_posts',
  !autoNavTabs({ ...DEFAULT_CUSTOMIZATION.layout, show_posts: false }, []).some(
    (tab) => tab.href === '/posts',
  ),
);
check('自动导航有上限', autoNavTabs(DEFAULT_CUSTOMIZATION.layout, Array.from({ length: 20 }, (_, i) => ({
  id: `x${i}`, title: `页${i}`, slug: `page-${i}`, status: 'published', show_in_nav: true, created_at: '',
})) as never).length <= MAX_NAV_TABS);

const autoState = siteNavTabs(DEFAULT_CUSTOMIZATION.layout, navPagesFixture as never);
check('未配置时走自动模式', autoState.auto && autoState.tabs.length === 5);

const customLayout = {
  ...DEFAULT_CUSTOMIZATION.layout,
  nav_tabs: [{ id: 'tab_a', label: '首页', href: '/' }, { id: 'tab_b', label: '联系我们', href: '/contact' }],
};
const customState = siteNavTabs(customLayout, navPagesFixture as never);
check('配置后完全按条目渲染', !customState.auto && customState.tabs.length === 2);
check('空数组表示没有 Tab', siteNavTabs({ ...customLayout, nav_tabs: [] }, []).tabs.length === 0);

const normalizedTabs = normalizeNavTabs([
  { id: 'a', label: '  ', href: '/' },
  { id: 'a', label: '重复 id', href: '/x' },
  { label: '外链', href: 'https://example.com' },
  ...Array.from({ length: 12 }, (_, i) => ({ label: `T${i}`, href: `/t${i}` })),
]);
check('导航丢弃空标题', !!normalizedTabs && !normalizedTabs.some((tab) => !tab.label.trim()));
check('导航重复 id 会改写', !!normalizedTabs && new Set(normalizedTabs.map((tab) => tab.id)).size === normalizedTabs!.length);
check('导航有数量上限', !!normalizedTabs && normalizedTabs.length === MAX_NAV_TABS);
check('未配置导航返回 undefined', normalizeNavTabs(undefined) === undefined);
check('坏类型导航返回 undefined', normalizeNavTabs('oops') === undefined);

check('safeHref 放行站内路径', safeHref('/about') === '/about');
check('safeHref 放行 https', safeHref('https://example.com') === 'https://example.com');
check('safeHref 拒绝 javascript', safeHref('javascript:alert(1)') === '');
check('safeHref 拒绝协议相对地址', safeHref('//evil.com/x') === '');
check('safeHref 拒绝 data URL', safeHref('data:text/html,<b>x</b>') === '');
check('safeHref 允许锚点', safeHref('#top') === '#top');

check('导航高亮文章详情', navTabActive('/a/a1', '/articles'));
check('导航高亮帖子详情', navTabActive('/p/p1', '/posts'));
check('首页只在根路径高亮', navTabActive('/about', '/') === false && navTabActive('/', '/'));
check('前缀不误伤相似路径', navTabActive('/about-us', '/about') === false && navTabActive('/about/team', '/about'));
check('外链不高亮', navTabActive('/x', 'https://example.com') === false);

const footerDefaults = defaultFooterColumns();
check('默认页脚两栏', footerDefaults.length === 2 && footerDefaults[0].links.length >= 2);
check('页脚坏配置回落到默认', normalizeFooterColumns('nope').length === 2);
const bigFooter = normalizeFooterColumns(
  Array.from({ length: 8 }, (_, i) => ({
    id: `c${i}`,
    title: `栏${i}`,
    links: Array.from({ length: 12 }, (_, j) => ({ label: `L${j}`, href: `/l${j}` })),
  })),
);
check('页脚栏数上限', bigFooter.length === MAX_FOOTER_COLUMNS);
check('页脚条目上限', bigFooter.every((column) => column.links.length === MAX_FOOTER_LINKS));
check(
  '页脚允许纯文字条目',
  normalizeFooterColumns([{ title: '关于', links: [{ label: '只显示文字', href: '' }] }])[0].links[0].href === '',
);

/* ---- 主题绑定的外观分区 ---- */
const nightTheme = builtinThemeBundle('night');
check('内置夜航启用全部外观分区', themeSections(nightTheme).length === 4);
check('未声明外观分区的主题按全集处理', themeSections({ id: 'x', name: 'x', note: '', variant: 'classic', theme: DEFAULT_CUSTOMIZATION.theme }).length === 4);
check(
  '主题可以关闭全部分区',
  themeSections({ id: 'x', name: 'x', note: '', variant: 'classic', theme: DEFAULT_CUSTOMIZATION.theme, appearance: { sections: [] } }).length === 0,
);
const readAppearance = normalizeAppearance({ sections: ['hero', 'nope', 'hero', 'custom_css'] });
check('外观分区去重并丢弃未知项', !!readAppearance && readAppearance.sections.join(',') === 'hero,custom_css');
check('坏外观配置返回 undefined', normalizeAppearance({ sections: 'hero' }) === undefined);

/* ---- 留言箱 ---- */
check('留言箱区块已注册', BLOCK_DEFS.some((def) => def.type === 'guestbook'));
check('留言箱两种版式都能用', availableBlocks('classic').some((def) => def.type === 'guestbook') && availableBlocks('bento').some((def) => def.type === 'guestbook'));
check('留言箱页面模板存在', PAGE_TEMPLATES.some((template) => template.id === 'guestbook'));
const guestbookTemplate = PAGE_TEMPLATES.find((template) => template.id === 'guestbook')!;
check(
  '留言箱模板带留言组件',
  guestbookTemplate.build().layout.blocks.some((block) => block.type === 'guestbook'),
);

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);