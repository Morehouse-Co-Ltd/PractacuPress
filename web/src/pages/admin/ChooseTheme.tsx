import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AppearanceSectionId, SiteTheme, ThemeLayoutEntry } from '../../types';
import { useCustomization } from '../../lib/customize';
import { blockDef, defaultHomeLayout } from '../../lib/blocks';
import {
  APPEARANCE_SECTIONS,
  BUILTIN_THEME_IDS,
  THEME_MARKETPLACE_URL,
  activeTheme,
  blankTheme,
  builtinThemeBundle,
  newThemeId,
  parseThemeFile,
  resolveThemeSettings,
  resolveThemeVariant,
  themeLibrary,
  themeMatches,
  themeSections,
  variantLabel,
} from '../../lib/themes';
import { themeApplyPatch, useThemeSwitch } from '../../lib/themeSwitch';
import {
  themeLayoutFor,
  withoutThemeLayout,
} from '../../lib/themeLayouts';
import {
  buildThemePackage,
  layoutPatches,
  readThemePackage,
  siteThemeFromPackage,
  themeManifestFromCustomization,
  themePackageFileName,
  type ParsedThemePackage,
} from '../../lib/themePackage';
import { useTitle } from '../../lib/hooks';
import { useT } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { Badge, Button, Callout, Field, Input, Modal, Textarea } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';
import { ThemePreview } from '../../components/theme/ThemePreview';
import { ThemeLivePreview } from '../../components/theme/ThemeLivePreview';

/** 详情面板里的一枚色板：色块 + 名称 + 十六进制值。 */
function PaletteSwatch({ label, value }: { label: string; value: string }) {
  return (
    <span className="theme-palette-item">
      <i className="theme-palette-chip" style={{ background: value }} aria-hidden />
      <span className="theme-palette-copy">
        <em>{label}</em>
        <code>{value}</code>
      </span>
    </span>
  );
}

/**
 * 「选择主题」页：主题库单独成一页，从「主题设置」的右侧配件区搬出来。
 *
 * 这里只负责挑选、创建、导入、导出与删除主题；配色微调、令牌、外观功能以及
 * 导航与页脚仍然留在「主题设置」页。
 */
export function ChooseThemePage() {
  const t = useT();
  useTitle(t('选择主题'));
  const { customization, update } = useCustomization();
  const toast = useToast();
  const navigate = useNavigate();
  const { applyBundle } = useThemeSwitch();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState('');
  const [pendingImport, setPendingImport] = useState<SiteTheme | null>(null);
  // zip 主题包：清单与页面编排要一起写回，预览仍复用 pendingImport 的主题卡片。
  const [pendingPackage, setPendingPackage] = useState<ParsedThemePackage | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SiteTheme | null>(null);
  const [getThemeOpen, setGetThemeOpen] = useState(false);
  // 从零创建一套空白主题：只需要名称与备注；配色、字体、版式与外观分区都留空，
  // 渲染时回落到默认主题。
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createNote, setCreateNote] = useState('');
  const [createError, setCreateError] = useState('');

  const customThemes = customization.themes ?? [];
  const library = themeLibrary(customThemes);
  const applied = activeTheme(customization.active_theme, customThemes);
  const currentTheme = customization.theme;
  const modified = applied
    ? !themeMatches(currentTheme, customization.layout.variant, applied)
    : true;
  const currentName = applied?.name ?? t('自定义主题');
  const currentId = applied?.id ?? customization.active_theme ?? 'custom';
  const fallback = builtinThemeBundle('default');
  const selectedSections = themeSections(applied);
  // 右侧详情面板的选择：默认对准正在使用的主题；点击卡片只切换详情，不立即应用。
  const [detailId, setDetailId] = useState<string>(customization.active_theme ?? 'default');
  /** 悬停卡片时「预览主题」打开的弹窗；只影响查看，不改变当前站点。 */
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewTheme = previewId ? (library.find((item) => item.id === previewId) ?? null) : null;
  /** 预览按钮的单双击区分：单击等 220ms 再开弹窗，双击直接套用。 */
  const previewTimer = useRef<number | null>(null);
  const detailTheme =
    library.find((item) => item.id === detailId) ?? library[0] ?? null;

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setImportError('');
    try {
      const isZip = /\.zip$/i.test(file.name) || file.type.includes('zip');
      if (isZip) {
        const parsed = await readThemePackage(file);
        setPendingPackage(parsed);
        setPendingImport(siteThemeFromPackage(parsed, newThemeId()));
      } else {
        setPendingPackage(null);
        setPendingImport(parseThemeFile(await file.text()));
      }
    } catch (err) {
      setPendingPackage(null);
      setImportError(err instanceof Error ? err.message : t('无法读取这个主题文件。'));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const confirmImport = () => {
    if (!pendingImport) return;
    if (customThemes.length >= 20) {
      setImportError(t('最多保存 20 套自定义主题，请先删除不用的主题。'));
      setPendingImport(null);
      setPendingPackage(null);
      return;
    }
    // zip 主题包：主题定义与页面编排一起落盘；旧 JSON 仍然只换主题。
    if (pendingPackage) {
      const layouts = layoutPatches(pendingPackage);
      const bundle = siteThemeFromPackage(pendingPackage, newThemeId());
      const nextPages = [...customization.pages];
      for (const item of layouts.pages) {
        const index = nextPages.findIndex((page) => page.slug === item.slug);
        if (index >= 0) {
          nextPages[index] = {
            ...nextPages[index],
            title: nextPages[index].title || item.title,
            layout: item.layout,
            updated_at: new Date().toISOString(),
          };
        } else {
          const now = new Date().toISOString();
          nextPages.push({
            id: newThemeId(),
            title: item.title,
            slug: item.slug,
            body: '',
            status: 'published',
            show_in_nav: false,
            created_at: now,
            updated_at: now,
            layout: item.layout,
          });
        }
      }
      const entry: ThemeLayoutEntry = {
        ...(layouts.home ? { home: layouts.home } : {}),
        ...(layouts.article ? { article: layouts.article } : {}),
      };
      const hasEntry = !!(entry.home || entry.article);
      const themeLayouts = hasEntry
        ? { ...customization.theme_layouts, [bundle.id]: entry }
        : customization.theme_layouts;
      // 主题包里的首页/文章页编排属于这套主题，不再写进站点级 home/article；
      // 目标主题已有自己的首页编排时，切换逻辑不会再把默认编排种进去。
      const { patch } = themeApplyPatch(
        hasEntry ? { ...customization, theme_layouts: themeLayouts } : customization,
        bundle,
      );
      update({
        ...patch,
        themes: [...customThemes, bundle],
        ...(pendingPackage.manifest.appearance
          ? { appearance: pendingPackage.manifest.appearance }
          : {}),
        ...(layouts.pages.length ? { pages: nextPages } : {}),
        ...(hasEntry ? { theme_layouts: themeLayouts } : {}),
      });
      toast.push(
        'ok',
        t('已导入并应用「{name}」', { name: bundle.name }),
        layouts.pages.length
          ? t('配色、版式与 {count} 个页面编排已写入这套主题。', { count: layouts.pages.length })
          : t('配色与版式已写入这套主题；组件与后端包需要在「扩展」页安装。'),
      );
      setDetailId(bundle.id);
      setPendingImport(null);
      setPendingPackage(null);
      return;
    }
    const next = [...customThemes, pendingImport];
    const { patch } = themeApplyPatch(customization, pendingImport);
    update({ ...patch, themes: next });
    toast.push(
      'ok',
      t('已导入并应用「{name}」', { name: pendingImport.name }),
      t('主题只包含配色、排版与版式，不包含文章或页面。'),
    );
    setDetailId(pendingImport.id);
    setPendingImport(null);
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const remaining = customThemes.filter((item) => item.id !== deleteTarget.id);
    // 删除主题时它自己的编排也一起删除；其它主题的条目不受影响。
    const nextLayouts = withoutThemeLayout(customization.theme_layouts, deleteTarget.id);
    if (customization.active_theme === deleteTarget.id) {
      const next = fallback ?? {
        id: 'default',
        name: t('原版'),
        note: '',
        variant: 'classic' as const,
        theme: currentTheme,
      };
      const { patch } = themeApplyPatch(
        { ...customization, theme_layouts: nextLayouts },
        next,
      );
      update({
        ...patch,
        themes: remaining,
        theme_layouts: patch.theme_layouts ?? nextLayouts,
        active_theme: next.id,
      });
      toast.push(
        'ok',
        t('已删除并回到「{name}」', { name: next.name }),
        t('被删除的主题不再可用；站点内容没有变化。'),
      );
    } else {
      update({ themes: remaining, theme_layouts: nextLayouts });
      toast.push(
        'ok',
        t('已删除「{name}」', { name: deleteTarget.name }),
        t('当前主题没有变化。'),
      );
    }
    setDetailId(remaining[0]?.id ?? 'default');
    setDeleteTarget(null);
  };

  /**
   * 卡片上的「编辑」按钮：直接进页面编排。
   *
   * 如果点的不是当前正在用的主题，先把这套主题套上再去编排，否则编排界面里的
   * 配色与版式会和卡片上看到的不一致。
   */
  const editLayout = (bundle: SiteTheme) => {
    if (customization.active_theme !== bundle.id) applyBundle(bundle, false);
    navigate('/admin/theme');
  };

  /**
   * 卡片右上角的「主题设置」：主题设置页编辑的永远是当前主题，所以先套用再过去。
   * 套用时沿用统一的切换提示，站长能看出来主题已经换了。
   */
  const openThemeSettings = (bundle: SiteTheme) => {
    if (customization.active_theme !== bundle.id) applyBundle(bundle);
    navigate('/admin/themes');
  };

  const exportCurrent = () => {
    const { manifest, pages } = themeManifestFromCustomization(customization, {
      id: currentId,
      name: modified ? `${currentName}${t('（当前调整）')}` : currentName,
      note: applied?.note ?? '',
      appearance: { sections: selectedSections },
      ...(applied?.preview ? { preview: applied.preview } : {}),
    });
    // 主题自带的设置字段随主题包一起导出，重新导入后还能继续使用。
    const settings = applied?.settings;
    const adminTabs = settings
      ? {
          version: 1,
          theme: manifest.id,
          replace_default: settings.replace_default,
          tabs: settings.tabs,
        }
      : null;
    const blob = buildThemePackage({
      manifest: adminTabs
        ? {
            ...manifest,
            admin: {
              tabs: 'admin/tabs.json',
              ...(settings?.replace_default ? { replace_default: true } : {}),
            },
          }
        : manifest,
      files: [
        ...pages.map((page) => ({ name: page.file, data: page.data })),
        ...(adminTabs
          ? [{ name: 'admin/tabs.json', data: JSON.stringify(adminTabs, null, 2) }]
          : []),
      ],
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = themePackageFileName(manifest.name);
    link.click();
    URL.revokeObjectURL(url);
    toast.push(
      'ok',
      t('已导出主题包'),
      pages.length
        ? t('包含配色、版式与 {count} 个页面编排。', { count: pages.length })
        : t('包含配色与版式；还没有可导出的页面编排。'),
    );
  };

  const openCreate = () => {
    setCreateName('');
    setCreateNote('');
    setCreateError('');
    setCreateOpen(true);
  };

  const confirmCreate = (thenBuild: boolean) => {
    const name = createName.trim().slice(0, 40);
    setCreateError('');
    if (!name) {
      setCreateError(t('主题名称不能为空。'));
      return;
    }
    if (customThemes.some((item) => item.name === name)) {
      setCreateError(t('已经有同名主题，换一个名字。'));
      return;
    }
    if (customThemes.length >= 20) {
      setCreateError(t('最多保存 20 套自定义主题，请先删除不用的主题。'));
      return;
    }
    // 真正的空白主题：不写配色/字体/版式/外观分区；只给这套主题准备一份空白的
    // 首页与文章页编排。渲染时由解析层回落到内置「原版」的组件样式。
    const item = blankTheme(name, createNote.trim().slice(0, 160));
    const blankLayout: ThemeLayoutEntry = {
      home: { blocks: [] },
      article: { blocks: [] },
    };
    const themeLayouts = { ...customization.theme_layouts, [item.id]: blankLayout };
    const { patch } = themeApplyPatch({ ...customization, theme_layouts: themeLayouts }, item);
    update({
      ...patch,
      themes: [...customThemes, item],
      theme_layouts: themeLayouts,
      active_theme: item.id,
    });
    setCreateOpen(false);
    setDetailId(item.id);
    toast.push(
      'ok',
      t('已创建空白主题「{name}」', { name }),
      thenBuild
        ? t('组件样式沿用默认主题（原版），首页与文章页编排是空白的，接下来在页面编排里搭页面。')
        : t('组件样式沿用默认主题（原版）；可以继续微调，或稍后去页面编排。'),
    );
    if (thenBuild) navigate('/admin/theme');
  };

  /** 详情面板的介绍段落。内置主题有手写文案，自定义主题按版式与配色生成。 */
  const themeIntro = (bundle: SiteTheme): string => {
    if (bundle.id === 'default') {
      return t(
        '纸白单栏：衬线标题、发丝线与大量留白，适合把注意力留给长文阅读。编辑排版干净克制，图片以正文宽度呈现。',
      );
    }
    if (bundle.id === 'night') {
      return t(
        '夜航双栏：冷石墨底色与电光蓝强调，杂志式网格适合图片、专题与社区内容。切到浅色模式会得到同一套设计的冷白重配。',
      );
    }
    if (!bundle.theme && !bundle.variant) {
      return t('空白主题：未设置配色与版式，组件沿用默认主题（原版）的样式。');
    }
    const settings = resolveThemeSettings(bundle);
    return t('{layout}版式、{mode}配色。{note}', {
      layout: variantLabel(resolveThemeVariant(bundle)),
      mode: settings.mode === 'dark' ? t('深色') : t('浅色'),
      note: bundle.note
        ? t('主题作者备注：{note}', { note: bundle.note })
        : t('没有备注。'),
    });
  };

  /** 外观分区 id → 显示名（名称本身已经过 t()，这里再查一次以跟随当前语言）。 */
  const sectionLabel = (id: AppearanceSectionId): string => {
    const entry = APPEARANCE_SECTIONS.find((item) => item.id === id);
    return entry ? t(entry.name) : id;
  };

  /** 这套主题自己的首页组件（没有条目时退回其版式的默认编排）。 */
  const homeBlockLabels = (bundle: SiteTheme): string[] => {
    const own = themeLayoutFor(customization, bundle.id)?.home;
    return (own ?? defaultHomeLayout(resolveThemeVariant(bundle))).blocks.map((block) =>
      t(blockDef(block.type)?.name ?? block.type),
    );
  };

  /** 详情里的首页组件为空时说明这是空白编排，而不是渲染坏了。 */
  const homeBlocksAreBlank = (bundle: SiteTheme): boolean =>
    themeLayoutFor(customization, bundle.id)?.home?.blocks.length === 0;

  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('选择主题')}</h1>
          <p>
            {t(
              '点击卡片在右侧查看详细介绍；鼠标移到封面上，才会出现预览与编辑入口，右上角还有主题设置和删除。',
            )}
          </p>
        </div>
        <div className="admin-page-actions">
          <Button
            variant="secondary"
            size="sm"
            icon="upload"
            onClick={() => fileRef.current?.click()}
          >
            {t('导入主题')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon="download"
            onClick={() => setGetThemeOpen(true)}
          >
            {t('获取主题')}
          </Button>
          <Button variant="secondary" size="sm" icon="download" onClick={exportCurrent}>
            {t('导出当前主题')}
          </Button>
          <Button variant="secondary" size="sm" icon="eye" onClick={() => window.open('/', '_blank')}>
            {t('预览站点')}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/zip,.zip,application/json,.json"
            hidden
            onChange={(event) => void pickFile(event.target.files?.[0])}
          />
        </div>
      </div>

      {importError ? (
        <Callout tone="danger" icon="alert" title={t('导入主题失败')}>
          {importError}
        </Callout>
      ) : null}

      <div className="theme-showcase">
        <section className="panel theme-showcase-list">
          <div className="panel-head">
            <div>
              <h3>{t('主题库')}</h3>
              <p>{t('封面在上、标题与描述在下。点击卡片在右侧查看详细介绍，需要时再点“使用这套主题”。')}</p>
            </div>
            <div className="row gap-8">
              <Badge tone={modified ? 'warn' : 'accent'} dot={!modified}>
                {currentName}
                {modified ? t(' · 已微调') : ''}
              </Badge>
            </div>
          </div>
          <div className="panel-body">
            <div className="theme-gallery">
              {library.map((bundle) => {
                const isApplied = customization.active_theme === bundle.id;
                const isBuiltin = BUILTIN_THEME_IDS.has(bundle.id);
                const isDetail = detailTheme?.id === bundle.id;
                const isBlank = !bundle.theme && !bundle.variant;
                return (
                  <div
                    key={bundle.id}
                    className={`theme-tile${isApplied ? ' is-applied' : ''}${isDetail ? ' is-detail' : ''}`}
                  >
                    <button
                      type="button"
                      className="theme-tile-select"
                      onClick={() => setDetailId(bundle.id)}
                      onDoubleClick={(event) => {
                        event.preventDefault();
                        setDetailId(bundle.id);
                        // 双击即用：和右侧详情里的「使用这套主题」走同一条切换逻辑。
                        if (!isApplied) applyBundle(bundle);
                      }}
                      aria-pressed={isDetail}
                      aria-label={t('查看「{name}」的详细介绍', { name: bundle.name })}
                      title={isApplied ? undefined : t('双击直接使用「{name}」', { name: bundle.name })}
                    >
                      <span className="theme-tile-cover">
                        <ThemePreview bundle={bundle} large />
                      </span>
                      <span className="theme-tile-copy">
                        <span className="theme-tile-title">
                          <strong>{bundle.name}</strong>
                          {isBuiltin ? (
                            <Badge tone="muted">{t('内置')}</Badge>
                          ) : (
                            <Badge tone="accent">{t('自定义')}</Badge>
                          )}
                          {isBlank ? <Badge tone="muted">{t('空白')}</Badge> : null}
                          {isApplied ? <Badge tone="ok">{t('使用中')}</Badge> : null}
                        </span>
                        <span className="theme-tile-note">
                          {bundle.note || t('一套自定义主题。')}
                        </span>
                        <span className="theme-tile-meta">
                          {bundle.variant ? variantLabel(bundle.variant) : t('未设置')} ·{' '}
                          {bundle.theme
                            ? bundle.theme.mode === 'dark'
                              ? t('深色')
                              : t('浅色')
                            : t('未设置')}
                        </span>
                      </span>
                    </button>
                    {/* 悬停时右上角浮出两个图标按钮：主题设置与删除。 */}
                    <div className="theme-tile-corner-actions">
                      <button
                        type="button"
                        className="theme-tile-corner"
                        aria-label={t('打开「{name}」的主题设置', { name: bundle.name })}
                        title={t('主题设置')}
                        onClick={() => openThemeSettings(bundle)}
                      >
                        <Icon name="settings" size={14} />
                      </button>
                      <button
                        type="button"
                        className="theme-tile-corner is-danger"
                        aria-label={t('删除「{name}」', { name: bundle.name })}
                        title={isBuiltin ? t('内置主题不能删除') : t('删除主题')}
                        disabled={isBuiltin}
                        onClick={() => setDeleteTarget(bundle)}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                    {/* 悬停时封面中心浮出同款胶囊按钮：预览主题 / 编辑。
                        正在使用的主题同样可以预览：只是不再提供「切换」动作。 */}
                    <div className="theme-tile-actions">
                      <button
                        type="button"
                        className="theme-tile-action"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (previewTimer.current !== null) {
                            window.clearTimeout(previewTimer.current);
                            previewTimer.current = null;
                          }
                          // 正在使用的主题没有「再套用一次」的动作：直接打开预览，不再等双击窗口。
                          if (isApplied) {
                            setPreviewId(bundle.id);
                            return;
                          }
                          // 双击预览按钮 = 直接使用该主题；单击 = 打开预览弹窗。
                          if (event.detail >= 2) {
                            setDetailId(bundle.id);
                            applyBundle(bundle);
                            return;
                          }
                          previewTimer.current = window.setTimeout(() => {
                            previewTimer.current = null;
                            setPreviewId(bundle.id);
                          }, 220);
                        }}
                        aria-label={t('预览「{name}」', { name: bundle.name })}
                        title={t('预览主题')}
                      >
                        <Icon name="eye" size={15} /> {t('预览主题')}
                      </button>
                      <button
                        type="button"
                        className="theme-tile-action"
                        aria-label={t('编辑「{name}」的页面编排', { name: bundle.name })}
                        title={t('进入页面编排：用这套主题搭首页与文章页')}
                        onClick={() => editLayout(bundle)}
                      >
                        <Icon name="edit" size={14} /> {t('编辑')}
                      </button>
                    </div>
                  </div>
                );
              })}
              <button type="button" className="theme-tile is-new" onClick={openCreate}>
                <span className="theme-tile-cover theme-new-preview" aria-hidden>
                  <Icon name="plus" size={26} />
                </span>
                <span className="theme-tile-copy">
                  <span className="theme-tile-title">
                    <strong>{t('创建空白主题')}</strong>
                    <Badge tone="accent">{t('从零开始')}</Badge>
                  </span>
                  <span className="theme-tile-note">
                    {t('不设置配色、字体与版式；组件沿用默认主题的样式，编排从空白开始。')}
                  </span>
                  <span className="theme-tile-meta">{t('空白主题 · 组件沿用默认主题样式')}</span>
                </span>
              </button>
            </div>
            {!customThemes.length ? (
              <p className="field-hint mt-12">
                {t('还没有自定义主题。可以「创建主题」从零开始，导入 JSON，或把当前微调后的主题另存。')}
              </p>
            ) : null}
          </div>
        </section>

        <aside className="theme-detail" aria-label={t('主题详情')}>
          {detailTheme ? (
            <>
              <div className="theme-detail-cover">
                <ThemePreview bundle={detailTheme} large />
              </div>
              <div className="theme-detail-body">
                <div className="theme-detail-title">
                  <h3>{detailTheme.name}</h3>
                  <div className="row gap-6">
                    {BUILTIN_THEME_IDS.has(detailTheme.id) ? (
                      <Badge tone="muted">{t('内置')}</Badge>
                    ) : (
                      <Badge tone="accent">{t('自定义')}</Badge>
                    )}
                    {!detailTheme.theme && !detailTheme.variant ? (
                      <Badge tone="muted">{t('空白')}</Badge>
                    ) : null}
                    {customization.active_theme === detailTheme.id ? (
                      <Badge tone="ok">{t('使用中')}</Badge>
                    ) : null}
                    {detailTheme.preview ? <Badge tone="muted">{t('自带预览')}</Badge> : null}
                  </div>
                </div>
                <p className="theme-detail-note">{detailTheme.note || t('一套自定义主题。')}</p>
                <p className="theme-detail-intro">{themeIntro(detailTheme)}</p>

                <dl className="theme-detail-meta">
                  <div>
                    <dt>{t('版式')}</dt>
                    <dd>{detailTheme.variant ? variantLabel(detailTheme.variant) : t('未设置')}</dd>
                  </div>
                  <div>
                    <dt>{t('明暗')}</dt>
                    <dd>
                      {detailTheme.theme
                        ? detailTheme.theme.mode === 'dark'
                          ? t('深色')
                          : t('浅色')
                        : t('未设置')}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('标题字体')}</dt>
                    <dd>
                      {detailTheme.theme
                        ? detailTheme.theme.heading_font === 'sans'
                          ? t('无衬线')
                          : t('衬线')
                        : t('未设置')}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('正文字号')}</dt>
                    <dd>{detailTheme.theme ? `${detailTheme.theme.body_size}px` : t('未设置')}</dd>
                  </div>
                  <div>
                    <dt>{t('内容宽度')}</dt>
                    <dd>
                      {detailTheme.theme ? `${detailTheme.theme.content_width}px` : t('未设置')}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('圆角')}</dt>
                    <dd>{detailTheme.theme ? `${detailTheme.theme.radius}px` : t('未设置')}</dd>
                  </div>
                </dl>

                <div className="theme-detail-section">
                  <h4>{t('配色')}</h4>
                  {detailTheme.theme ? (
                    <div className="theme-palette">
                      <PaletteSwatch label={t('背景')} value={detailTheme.theme.background} />
                      <PaletteSwatch label={t('文字')} value={detailTheme.theme.ink} />
                      <PaletteSwatch label={t('强调色')} value={detailTheme.theme.accent} />
                    </div>
                  ) : (
                    <p className="field-hint">{t('未设置配色，组件沿用默认主题（原版）的样式。')}</p>
                  )}
                </div>

                <div className="theme-detail-section">
                  <h4>{t('默认首页组件')}</h4>
                  <div className="theme-chip-list">
                    {homeBlockLabels(detailTheme).map((label, index) => (
                      <span className="theme-chip" key={`${index}-${label}`}>
                        {label}
                      </span>
                    ))}
                    {homeBlocksAreBlank(detailTheme) ? (
                      <span className="theme-chip faint">{t('空白（还没有组件）')}</span>
                    ) : null}
                  </div>
                </div>

                <div className="theme-detail-section">
                  <h4>{t('外观分区')}</h4>
                  <div className="theme-chip-list">
                    {themeSections(detailTheme).map((id) => (
                      <span className="theme-chip" key={id}>
                        {sectionLabel(id)}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="theme-detail-actions">
                  <Button
                    icon={customization.active_theme === detailTheme.id ? 'check' : 'palette'}
                    disabled={customization.active_theme === detailTheme.id}
                    onClick={() => {
                      applyBundle(detailTheme);
                      setDetailId(detailTheme.id);
                    }}
                  >
                    {customization.active_theme === detailTheme.id
                      ? t('正在使用')
                      : t('使用这套主题')}
                  </Button>
                  <Button variant="secondary" icon="layers" onClick={() => editLayout(detailTheme)}>
                    {t('编辑页面编排')}
                  </Button>
                  {!BUILTIN_THEME_IDS.has(detailTheme.id) ? (
                    <Button variant="ghost" icon="trash" onClick={() => setDeleteTarget(detailTheme)}>
                      {t('删除主题')}
                    </Button>
                  ) : null}
                </div>
                <p className="theme-detail-current tiny faint">
                  {t('当前主题：{name}', { name: currentName })}
                  {modified ? t('（已微调）') : ''}
                </p>
              </div>
            </>
          ) : (
            <p className="field-hint">{t('选择一个主题查看详细介绍。')}</p>
          )}
        </aside>
      </div>

      <Modal
        open={!!previewTheme}
        title={previewTheme ? previewTheme.name : t('预览主题')}
        description={
          previewTheme
            ? `${previewTheme.variant ? variantLabel(previewTheme.variant) : t('未设置')} · ${
                previewTheme.theme
                  ? previewTheme.theme.mode === 'dark'
                    ? t('深色')
                    : t('浅色')
                  : t('未设置')
              }`
            : undefined
        }
        onClose={() => setPreviewId(null)}
        width={1040}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPreviewId(null)}>
              {t('关闭')}
            </Button>
            <Button
              icon="palette"
              disabled={!previewTheme || customization.active_theme === previewTheme.id}
              onClick={() => {
                if (!previewTheme) return;
                applyBundle(previewTheme);
                setDetailId(previewTheme.id);
                setPreviewId(null);
              }}
            >
              {previewTheme && customization.active_theme === previewTheme.id
                ? t('这个主题正在使用')
                : t('使用这套主题')}
            </Button>
          </>
        }
      >
        {previewTheme ? (
          <>
            {/* 预览的是真实前台：站点现有内容 + 这套主题，关掉弹窗即还原。 */}
            <ThemeLivePreview bundle={previewTheme} />
            <p className="theme-detail-note">
              {previewTheme.note || t('一套自定义主题。')}
            </p>
            <p className="theme-detail-intro">{themeIntro(previewTheme)}</p>
          </>
        ) : null}
      </Modal>

      <Modal
        open={createOpen}
        title={t('创建空白主题')}
        description={t(
          '只创建主题本身：不设置配色、字体或单双栏版式；组件沿用默认主题（原版）的样式。首页与文章页编排从空白开始。',
        )}
        onClose={() => setCreateOpen(false)}
        width={720}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              {t('取消')}
            </Button>
            <Button variant="secondary" onClick={() => confirmCreate(false)}>
              {t('仅创建')}
            </Button>
            <Button onClick={() => confirmCreate(true)} icon="layers">
              {t('创建并编排页面')}
            </Button>
          </>
        }
      >
        <div className="form-stack">
          {createError ? (
            <Callout tone="danger" icon="alert">
              {createError}
            </Callout>
          ) : null}
          <Field label={t('主题名称')} htmlFor="theme-create-name" aside={`${createName.length}/40`}>
            <Input
              id="theme-create-name"
              value={createName}
              maxLength={40}
              onChange={(event) => setCreateName(event.target.value)}
              placeholder={t('例如：我的主题')}
            />
          </Field>
          <Field
            label={t('备注')}
            htmlFor="theme-create-note"
            aside={`${createNote.length}/160`}
            hint={t('可选，方便在主题库里认出它。')}
          >
            <Textarea
              id="theme-create-note"
              value={createNote}
              maxLength={160}
              rows={2}
              onChange={(event) => setCreateNote(event.target.value)}
              placeholder={t('例如：先搭一个空白版面。')}
            />
          </Field>

          <Callout tone="info" icon="layers">
            {t(
              '主题创建后会自动切换为当前主题。点「创建并编排页面」会直接打开页面编排，为首页与文章页加组件。',
            )}
          </Callout>
        </div>
      </Modal>

      <Modal
        open={getThemeOpen}
        title={t('获取主题')}
        description={t('从主题市场挑选并安装主题；当前版本先预留入口与接口约定。')}
        onClose={() => setGetThemeOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setGetThemeOpen(false)}>
              {t('关闭')}
            </Button>
            {THEME_MARKETPLACE_URL ? (
              <Button
                onClick={() => window.open(THEME_MARKETPLACE_URL, '_blank', 'noopener')}
                icon="external"
              >
                {t('打开主题市场')}
              </Button>
            ) : null}
          </>
        }
      >
        <div className="form-stack">
          <Callout tone="info" icon="sparkle" title={t('主题市场接口尚未接入')}>
            {t(
              '入口与安装流程已经预留：接入后可以在弹窗里浏览主题、预览并一键安装到本机主题库。 当前版本不写入任何外部链接，接口约定与接入步骤见',
            )}
            <code className="mono">
              {' '}
              docs/superpowers/specs/2026-10-25-theme-marketplace-integration.md
            </code>
            {t('。')}
          </Callout>
          <div className="mini-list">
            <div className="mini-row">
              <span className="mini-label">{t('计划接口')}</span>
              <span className="mini-value">GET /api/v1/themes/marketplace</span>
            </div>
            <div className="mini-row">
              <span className="mini-label">{t('安装方式')}</span>
              <span className="mini-value">
                {t('下载主题 JSON 后复用现有主题导入校验')}
              </span>
            </div>
            <div className="mini-row">
              <span className="mini-label">{t('安全约束')}</span>
              <span className="mini-value">
                {t('只接受配色、排版与版式；不导入内容与自定义 CSS')}
              </span>
            </div>
          </div>
          <p className="field-hint">
            {t('接入时只需在')} <code className="mono">lib/themes.ts</code> {t('的')}
            <code className="mono">THEME_MARKETPLACE_URL</code>{' '}
            {t('填入地址，并实现列表拉取。')}
          </p>
        </div>
      </Modal>

      <Modal
        open={!!pendingImport}
        title={
          pendingImport
            ? t('导入主题「{name}」？', { name: pendingImport.name })
            : t('导入主题？')
        }
        description={
          pendingPackage
            ? t('主题包会写入配色、版式与页面编排；组件与后端包需要在「扩展」页安装。')
            : t('主题只包含配色、排版与单栏 / 卡片 / 双栏版式；不会导入文章、页面或自定义 CSS。')
        }
        onClose={() => {
          setPendingImport(null);
          setPendingPackage(null);
        }}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setPendingImport(null);
                setPendingPackage(null);
              }}
            >
              {t('取消')}
            </Button>
            <Button onClick={confirmImport} icon="upload">
              {t('导入并应用')}
            </Button>
          </>
        }
      >
        {pendingImport ? (
          <div className="form-stack">
            <div className="theme-import-preview">
              <ThemePreview bundle={pendingImport} />
              <div>
                <strong>{pendingImport.name}</strong>
                <p>{pendingImport.note || t('没有备注。')}</p>
                <span className="tiny faint">
                  {pendingImport.variant ? variantLabel(pendingImport.variant) : t('未设置')} ·{' '}
                  {pendingImport.theme
                    ? pendingImport.theme.mode === 'dark'
                      ? t('深色')
                      : t('浅色')
                    : t('未设置')}
                </span>
              </div>
            </div>
            {pendingPackage ? (
              <Callout tone="info" icon="layers">
                {t(
                  '这个主题包包含 {count} 个页面编排。导入后可在页面编排器里继续调整。',
                  { count: pendingPackage.layouts.length },
                )}
              </Callout>
            ) : null}
            <Callout tone="info" icon="info">
              {t('导入后会立即应用。当前主题与配色会被替换；文章、页面正文与账户不受影响。')}
            </Callout>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={!!deleteTarget}
        title={
          deleteTarget
            ? t('删除主题「{name}」？', { name: deleteTarget.name })
            : t('删除主题？')
        }
        description={
          deleteTarget && customization.active_theme === deleteTarget.id
            ? t('这是当前正在使用的主题；删除后会回到原版主题。')
            : t('删除后不能恢复，除非你重新导入主题文件。')
        }
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              {t('取消')}
            </Button>
            <Button variant="danger" onClick={confirmDelete} icon="trash">
              {t('删除主题')}
            </Button>
          </>
        }
      >
        <p className="small muted">
          {t('只删除主题定义，不会删除文章、页面、评论或媒体。')}
        </p>
      </Modal>
    </RoleGate>
  );
}
