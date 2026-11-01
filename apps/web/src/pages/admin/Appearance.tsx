import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SiteCustomization } from '../../types';
import {
  DEFAULT_HERO,
  DEFAULT_LAYOUT,
  EXTENSIONS,
  downloadCustomization,
  navPages,
  parseCustomizationFile,
  useCustomization,
} from '../../lib/customize';
import { siteNavTabs } from '../../lib/navigation';
import { useAuth } from '../../lib/session';
import { defaultHomeLayout } from '../../lib/blocks';
import { templateById } from '../../lib/templates';
import { APPEARANCE_SECTIONS, activeTheme, themeSections } from '../../lib/themes';
import { DEFAULT_LOADING } from '../../lib/loading';
import { DEFAULT_PERFORMANCE } from '../../lib/performance';
import { DEFAULT_ACCESS } from '../../lib/access';
import { DEFAULT_DOMAINS } from '../../lib/domains';
import { useTitle } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import {
  Badge,
  Button,
  Callout,
  Field,
  Input,
  Modal,
  Textarea,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';

const RESET_SCOPES = [
  {
    id: 'branding',
    name: '品牌与页脚',
    note: '首页首屏、品牌副标题、公告条、版权文案与自定义 CSS；导航 Tab 与页脚栏目保留。',
  },
  { id: 'home', name: '首页编排', note: '按当前布局变体恢复默认组件。' },
  { id: 'pages', name: '自定义页面编排', note: '按模板重建组件；页面正文与标题保留。' },
  { id: 'loading', name: '加载动画', note: '关闭加载画面并回到圆环预设。' },
  { id: 'performance', name: '性能设置', note: '首屏条数、请求缓存与服务器参数回到默认。' },
  { id: 'access', name: '访问限制', note: '关闭浏览器端保护并恢复默认阈值。' },
  { id: 'domains', name: '域名绑定', note: '关闭白名单并清空别名、CORS 与代理地址。' },
] as const;

type ResetScope = (typeof RESET_SCOPES)[number]['id'];

/** 首屏预览：单栏是纸白版式，双栏是夜航的深色黑卡。 */
function HeroPreview({
  kicker,
  title,
  lede,
  fallbackKicker,
  fallbackLede,
  bento,
}: {
  kicker: string;
  title: string;
  lede: string;
  fallbackKicker: string;
  fallbackLede: string;
  bento: boolean;
}) {
  return (
    <div className={`hero-preview${bento ? ' is-bento' : ''}`}>
      <span className="hero-preview-tag">{bento ? '夜航 · 左侧黑卡' : '原版 · 首屏'}</span>
      <p className="hero-kicker">{kicker.trim() || fallbackKicker}</p>
      <p className="hero-preview-title">
        {(title.trim() ? title : DEFAULT_HERO.title).split('\n').map((line, index) => (
          <span key={index}>
            {index > 0 ? <br /> : null}
            {line.split(/(\*[^*]+\*)/g).map((part, i) =>
              part.startsWith('*') && part.endsWith('*') ? (
                <em key={i}>{part.slice(1, -1)}</em>
              ) : (
                <span key={i}>{part}</span>
              ),
            )}
          </span>
        ))}
      </p>
      <p className="hero-preview-lede">{lede.trim() || fallbackLede}</p>
      {bento ? <span className="hero-preview-search">搜索文章、笔记或标签</span> : null}
    </div>
  );
}

export function AppearancePage() {
  useTitle('外观');
  const { site, updateConfig } = useAuth();
  const { customization, update } = useCustomization();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState('');
  const [pendingImport, setPendingImport] = useState<SiteCustomization | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetScopes, setResetScopes] = useState<Record<ResetScope, boolean>>({
    branding: true,
    home: false,
    pages: false,
    loading: true,
    performance: true,
    access: false,
    domains: false,
  });

  const layout = customization.layout;
  const bento = layout.variant === 'bento';
  const themeBundle = activeTheme(customization.active_theme, customization.themes ?? []);
  const themeName = themeBundle?.name ?? '自定义主题';
  const sections = themeSections(themeBundle);
  const hiddenSections = APPEARANCE_SECTIONS.filter((item) => !sections.includes(item.id));
  const nav = siteNavTabs(layout, navPages(customization));
  const enabledCount = EXTENSIONS.filter((item) => customization.extensions[item.id]).length;
  const setLayout = (patch: Partial<typeof layout>) => update({ layout: { ...layout, ...patch } });

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setImportError('');
    try {
      const text = await file.text();
      setPendingImport(parseCustomizationFile(text));
    } catch (err) {
      setImportError(err instanceof Error ? err.message : '无法读取这个文件。');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const applyImport = () => {
    if (!pendingImport) return;
    update(pendingImport);
    toast.push('ok', '配置已导入', '外观、页面与扩展都已替换。');
    setPendingImport(null);
  };

  const applyReset = () => {
    const customizationPatch: Partial<SiteCustomization> = {};
    if (resetScopes.branding) {
      customizationPatch.layout = {
        ...DEFAULT_LAYOUT,
        variant: customization.layout.variant,
        // 导航 Tab 与页脚栏目在主题设置里维护，恢复外观时不跟着清空。
        nav_tabs: customization.layout.nav_tabs,
        footer_columns: customization.layout.footer_columns,
      };
      customizationPatch.custom_css = '';
    }
    if (resetScopes.home) {
      customizationPatch.home = defaultHomeLayout(customization.layout.variant);
    }
    if (resetScopes.pages) {
      customizationPatch.pages = customization.pages.map((page) => ({
        ...page,
        layout: page.template
          ? (templateById(page.template)?.build().layout ?? { blocks: [] })
          : { blocks: [] },
      }));
    }
    if (Object.keys(customizationPatch).length) update(customizationPatch);
    if (resetScopes.loading) updateConfig({ loading: DEFAULT_LOADING });
    if (resetScopes.performance) updateConfig({ performance: DEFAULT_PERFORMANCE });
    if (resetScopes.access) updateConfig({ access: DEFAULT_ACCESS });
    if (resetScopes.domains) updateConfig({ domains: DEFAULT_DOMAINS });
    setResetOpen(false);
    toast.push('ok', '已恢复选中的默认设置', '文章、页面正文、评论、账户与媒体都没有变化。');
  };

  const selectedScopeCount = Object.values(resetScopes).filter(Boolean).length;

  return (
    <RoleGate capability="manage_site" need="站点管理员">
      <div className="admin-page-head">
        <div>
          <h1>外观</h1>
          <p>
            首页首屏、品牌、公告条与自定义 CSS。导航 Tab 与页脚栏目在「主题设置」里；
            显示哪些分区由当前主题决定。
          </p>
        </div>
        <div className="admin-page-actions">
          <Link to="/admin/themes" className="btn btn-secondary btn-sm">
            <Icon name="palette" size={14} /> 主题设置
          </Link>
          <Button
            variant="secondary"
            size="sm"
            icon="download"
            onClick={() => downloadCustomization(customization, site?.name ?? 'Practacu Press')}
          >
            导出配置
          </Button>
          <Link to="/admin/theme" className="btn btn-primary btn-sm">
            <Icon name="layers" size={14} /> 页面编排
          </Link>
          <Button variant="secondary" size="sm" icon="eye" onClick={() => window.open('/', '_blank')}>
            预览站点
          </Button>
        </div>
      </div>

      <div className="theme-banner">
        <div className="theme-banner-main">
          <span className="theme-banner-icon">
            <Icon name="palette" size={16} />
          </span>
          <div>
            <strong>当前主题「{themeName}」{bento ? ' · 双栏' : ' · 单栏'}</strong>
            <p>
              这套主题启用了 {sections.length}/{APPEARANCE_SECTIONS.length} 个外观分区
              {hiddenSections.length
                ? `；未启用的分区（${hiddenSections.map((item) => item.name).join('、')}）不在本页显示。`
                : '，本页显示全部设置。'}
            </p>
          </div>
        </div>
        <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
          <Link to="/admin/themes" className="btn btn-secondary btn-sm">
            换主题 / 改绑定
          </Link>
          <Link to="/admin/themes" className="btn btn-ghost btn-sm">
            导航与页脚
          </Link>
        </div>
      </div>

      {importError ? (
        <div className="mb-20">
          <Callout tone="danger" icon="alert" title="导入失败">
            {importError}
          </Callout>
        </div>
      ) : null}

      <div className="settings-grid">
        <div className="editor-main">
          {sections.includes('hero') ? (
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h3>首页首屏</h3>
                  <p>
                    {bento
                      ? '夜航会把它放进左侧黑卡：眉题在上、标题两行、副标题在下；区块自己填了标题时以区块为准。'
                      : '首页最上方那句话。留空时使用站点名称与简介。'}
                  </p>
                </div>
                <button type="button" className="link-btn" onClick={() => setLayout({ hero: DEFAULT_HERO })}>
                  恢复默认
                </button>
              </div>
              <div className="panel-body">
                <div className="form-stack">
                  <Field
                    label="眉题"
                    htmlFor="layout-hero-kicker"
                    aside={`${layout.hero.kicker.length}/80`}
                    hint={
                      bento
                        ? '显示在黑卡标题上方的小字。留空则不显示。'
                        : '标题上方的小字。留空显示「站点名 · 独立出版」。'
                    }
                  >
                    <Input
                      id="layout-hero-kicker"
                      value={layout.hero.kicker}
                      maxLength={80}
                      placeholder={bento ? '独立出版 · 每周更新' : 'Practacu Press · 独立出版'}
                      onChange={(event) => setLayout({ hero: { ...layout.hero, kicker: event.target.value } })}
                    />
                  </Field>
                  <Field
                    label="主标题"
                    htmlFor="layout-hero-title"
                    aside={`${layout.hero.title.length}/200`}
                    hint={`换行即换行；用 *文字* 标记斜体强调色，${bento ? '夜航最多显示 2 行。' : '最多 4 行。'}`}
                  >
                    <Textarea
                      id="layout-hero-title"
                      value={layout.hero.title}
                      maxLength={200}
                      rows={3}
                      style={{ minHeight: 88, fontFamily: 'var(--serif)', fontSize: 18, lineHeight: 1.5 }}
                      onChange={(event) => setLayout({ hero: { ...layout.hero, title: event.target.value } })}
                    />
                  </Field>
                  <Field
                    label="副标题"
                    htmlFor="layout-hero-lede"
                    aside={`${layout.hero.lede.length}/300`}
                    hint={bento ? '显示在黑卡标题下方；留空则不显示。' : '留空显示站点简介。'}
                  >
                    <Textarea
                      id="layout-hero-lede"
                      value={layout.hero.lede}
                      maxLength={300}
                      rows={2}
                      style={{ minHeight: 64 }}
                      onChange={(event) => setLayout({ hero: { ...layout.hero, lede: event.target.value } })}
                    />
                  </Field>
                  <HeroPreview
                    kicker={layout.hero.kicker}
                    title={layout.hero.title}
                    lede={layout.hero.lede}
                    fallbackKicker={bento ? '' : `${site?.name ?? 'Practacu Press'} · 独立出版`}
                    fallbackLede={
                      site?.description || '一间小而安静的编辑部。写作者拥有自己的稿子，读者被当作邻居。'
                    }
                    bento={bento}
                  />
                </div>
              </div>
            </section>
          ) : null}

          {sections.includes('branding') ? (
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h3>品牌与导航</h3>
                  <p>品牌名下方那行小字；页头显示哪些入口由主题设置里的 Tab 决定。</p>
                </div>
              </div>
              <div className="panel-body">
                <div className="form-stack">
                  <Field label="品牌副标题" htmlFor="layout-brand" hint="留空则显示默认英文副标题。">
                    <Input
                      id="layout-brand"
                      value={layout.brand_sub}
                      maxLength={60}
                      onChange={(event) => setLayout({ brand_sub: event.target.value })}
                    />
                  </Field>

                  <div className="nav-summary">
                    <p className="field-label">
                      页头 Tab
                      <Badge tone={nav.auto ? 'muted' : 'accent'}>{nav.auto ? '自动' : '自定义'}</Badge>
                    </p>
                    <div className="chrome-preview">
                      {nav.tabs.length ? (
                        nav.tabs.map((tab) => (
                          <span className="chrome-preview-tab" key={tab.id}>
                            {tab.label}
                          </span>
                        ))
                      ) : (
                        <span className="tiny faint">没有 Tab，页头只显示品牌与操作区。</span>
                      )}
                    </div>
                    <p className="field-hint">
                      想改文字、换页面或加外链，去
                      <Link to="/admin/themes" className="text-link"> 主题设置 → 导航与页脚 </Link>
                      ；自定义页面勾选“加入站点导航”后会自动出现在自动模式的 Tab 里。
                    </p>
                    <p className="field-hint">
                      页脚的栏目、条目、版权文案与备案信息同样在「主题设置 → 导航与页脚」。
                    </p>
                  </div>
                </div>
              </div>
            </section>
          ) : null}

          {sections.includes('announcement') ? (
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h3>公告条</h3>
                  <p>开启「站点公告条」扩展后，这段文字会显示在页头下方，读者可以关闭。</p>
                </div>
                <Badge tone={customization.extensions.announcement ? 'ok' : 'muted'}>
                  {customization.extensions.announcement ? '已开启' : '未开启'}
                </Badge>
              </div>
              <div className="panel-body">
                <div className="form-stack">
                  <Field label="公告内容" htmlFor="layout-announce" aside={`${layout.announcement.length}/240`}>
                    <Input
                      id="layout-announce"
                      value={layout.announcement}
                      maxLength={240}
                      placeholder="例如：本周六晚八点，线上读稿会。"
                      onChange={(event) => setLayout({ announcement: event.target.value })}
                    />
                  </Field>
                  <Field
                    label="公告链接"
                    htmlFor="layout-announce-link"
                    hint="可选。支持站内路径（/about）或 http(s) 链接。"
                  >
                    <Input
                      id="layout-announce-link"
                      value={layout.announcement_link}
                      maxLength={300}
                      placeholder="/about"
                      onChange={(event) => setLayout({ announcement_link: event.target.value })}
                    />
                  </Field>
                  {!customization.extensions.announcement ? (
                    <p className="field-hint">
                      还没有开启：去<Link to="/admin/extensions" className="text-link"> 扩展 </Link>
                      打开“站点公告条”。
                    </p>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}

          {sections.includes('custom_css') ? (
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h3>自定义 CSS</h3>
                  <p>只在前台生效，适合微调间距、字体或加一条自己的规则。</p>
                </div>
                <Badge tone={customization.custom_css ? 'accent' : 'muted'}>
                  {customization.custom_css ? `${customization.custom_css.length} 字符` : '未使用'}
                </Badge>
              </div>
              <div className="panel-body">
                <Textarea
                  value={customization.custom_css}
                  onChange={(event) => update({ custom_css: event.target.value })}
                  maxLength={20000}
                  style={{ minHeight: 180, fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.7 }}
                  placeholder={'.site-header { border-bottom-width: 2px; }'}
                  aria-label="自定义 CSS"
                />
                <Callout tone="warn" icon="alert" title="只粘贴自己信任的 CSS">
                  自定义 CSS 不会进入管理后台，也不会执行脚本。不要粘贴来路不明的样式；外部 url() 会把访问者IP暴露给第三方。
                </Callout>
              </div>
            </section>
          ) : null}

          {hiddenSections.length ? (
            <Callout tone="info" icon="palette" title="当前主题没有启用全部外观分区">
              被主题隐藏的分区：
              {hiddenSections.map((item) => item.name).join('、')}。数据没有丢失，
              想让它们回来可以在「主题设置 → 主题绑定的外观功能」里勾选。
            </Callout>
          ) : null}

        </div>

        <aside className="settings-side">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>品牌与页面</h3>
                <p>配色、版式、导航与页脚都在主题设置里。</p>
              </div>
            </div>
            <div className="panel-body">
              <div className="mini-list">
                <div className="mini-row">
                  <span className="mini-label">当前主题</span>
                  <span className="mini-value">{themeName}</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">当前版式</span>
                  <span className="mini-value">{bento ? '双栏' : '单栏'}</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">外观分区</span>
                  <span className="mini-value">
                    {sections.length}/{APPEARANCE_SECTIONS.length}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">扩展</span>
                  <span className="mini-value">{enabledCount} / {EXTENSIONS.length} 已开启</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">自定义页面</span>
                  <span className="mini-value">{customization.pages.length} 个</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">备案信息</span>
                  <span className="mini-value">{layout.icp || layout.police ? '已填写' : '未填写'}</span>
                </div>
              </div>
              <div className="row gap-8 mt-16" style={{ flexWrap: 'wrap' }}>
                <Link to="/admin/themes" className="btn btn-secondary btn-sm">
                  主题设置
                </Link>
                <Link to="/admin/extensions" className="btn btn-ghost btn-sm">
                  管理扩展
                </Link>
                <Link to="/admin/pages" className="btn btn-ghost btn-sm">
                  管理页面
                </Link>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>导入与导出</h3>
                <p>把外观、页面与扩展搬到另一台浏览器。</p>
              </div>
            </div>
            <div className="panel-body">
              <p className="tiny faint" style={{ lineHeight: 1.8 }}>
                导出的 JSON 包含主题、导航 Tab、页脚栏目、自定义页面与扩展开关，
                不包含账户、文章或图片。
              </p>
              <div className="row gap-8 mt-12" style={{ flexWrap: 'wrap' }}>
                <Button
                  variant="secondary"
                  size="sm"
                  icon="download"
                  onClick={() => downloadCustomization(customization, site?.name ?? 'Practacu Press')}
                >
                  导出 JSON
                </Button>
                <Button variant="secondary" size="sm" icon="upload" onClick={() => fileRef.current?.click()}>
                  导入
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json,.json"
                  hidden
                  onChange={(event) => void pickFile(event.target.files?.[0])}
                />
              </div>
              <p className="tiny faint mt-12">
                导入会覆盖当前的外观、页面与扩展；账户与内容不受影响。
              </p>
            </div>
          </section>

          <div className="danger-zone">
            <h3>恢复默认站点设置</h3>
            <p>
              可以只重置品牌文案、首页/页面编排、加载动画、性能、访问限制或域名绑定。
              文章、页面正文、评论、账户与媒体不会被删除。
            </p>
            <Button variant="danger" size="sm" className="mt-12" icon="refresh" onClick={() => setResetOpen(true)}>
              选择范围
            </Button>
          </div>
        </aside>
      </div>

      <Modal
        open={!!pendingImport}
        title="导入这份配置？"
        description="当前外观、页面与扩展会被文件里的内容替换。"
        onClose={() => setPendingImport(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingImport(null)}>
              取消
            </Button>
            <Button onClick={applyImport}>替换并保存</Button>
          </>
        }
      >
        <Callout tone="warn" icon="alert">
          这是一次整体替换：导入文件里的页面列表会覆盖本地页面。请确认已经导出备份。
        </Callout>
      </Modal>

      <Modal
        open={resetOpen}
        title="恢复哪些默认设置？"
        description={`已选择 ${selectedScopeCount} 项。只影响设置，不删除内容、账户或媒体。`}
        onClose={() => setResetOpen(false)}
        width={640}
        footer={
          <>
            <Button variant="ghost" onClick={() => setResetOpen(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={selectedScopeCount === 0}
              onClick={applyReset}
              icon="refresh"
            >
              恢复选中项
            </Button>
          </>
        }
      >
        <div className="form-stack">
          <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
            <button
              type="button"
              className="link-btn"
              onClick={() =>
                setResetScopes((prev) => {
                  const next = { ...prev };
                  for (const scope of RESET_SCOPES) next[scope.id] = true;
                  return next;
                })
              }
            >
              全选
            </button>
            <button
              type="button"
              className="link-btn"
              onClick={() =>
                setResetScopes((prev) => {
                  const next = { ...prev };
                  for (const scope of RESET_SCOPES) next[scope.id] = false;
                  return next;
                })
              }
            >
              清空
            </button>
          </div>
          <div className="reset-scope-grid">
            {RESET_SCOPES.map((scope) => (
              <label
                key={scope.id}
                className={`reset-scope${resetScopes[scope.id] ? ' is-selected' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={resetScopes[scope.id]}
                  onChange={(event) =>
                    setResetScopes((prev) => ({ ...prev, [scope.id]: event.target.checked }))
                  }
                />
                <span>
                  <strong>{scope.name}</strong>
                  <em>{scope.note}</em>
                </span>
              </label>
            ))}
          </div>
          <Callout tone="warn" icon="alert" title="恢复后仍可手动重新配置">
            这个操作不会备份；需要保留当前外观时，请先用右侧「导出 JSON」。
          </Callout>
        </div>
      </Modal>
    </RoleGate>
  );
}
