import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { AppearanceSectionId, SiteTheme } from '../../types';
import { useCustomization } from '../../lib/customize';
import { defaultHomeLayout } from '../../lib/blocks';
import { applyPreset, DEFAULT_THEME } from '../../lib/theme';
import {
  APPEARANCE_SECTIONS,
  BUILTIN_THEME_IDS,
  DEFAULT_APPEARANCE_SECTIONS,
  THEME_MARKETPLACE_URL,
  activeTheme,
  builtinThemeBundle,
  downloadThemeFile,
  newThemeId,
  parseThemeFile,
  themeLibrary,
  themeMatches,
  themeSections,
  variantLabel,
} from '../../lib/themes';
import { cloneTheme, sameLayout, useThemeSwitch } from '../../lib/themeSwitch';
import { useTitle } from '../../lib/hooks';
import { useT } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { Badge, Button, Callout, Field, Input, Modal, Textarea } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';

function ThemePreview({ bundle }: { bundle: SiteTheme }) {
  const bento = bundle.variant === 'bento';
  return (
    <span
      className={`theme-bundle-preview is-${bundle.variant}`}
      style={{
        background: bundle.theme.background,
        color: bundle.theme.ink,
      }}
      aria-hidden
    >
      <span className="theme-preview-chrome" style={{ background: bundle.theme.accent }} />
      <span className="theme-preview-body">
        <span className="theme-preview-title" style={{ background: bundle.theme.ink }} />
        {bento ? (
          <span className="theme-preview-columns">
            <i style={{ background: bundle.theme.accent }} />
            <i style={{ background: bundle.theme.ink }} />
          </span>
        ) : (
          <span className="theme-preview-lines">
            <i style={{ background: bundle.theme.ink }} />
            <i style={{ background: bundle.theme.ink }} />
            <i style={{ background: bundle.theme.accent }} />
          </span>
        )}
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
  const [deleteTarget, setDeleteTarget] = useState<SiteTheme | null>(null);
  const [getThemeOpen, setGetThemeOpen] = useState(false);
  // 从零创建一套主题：名称、版式、起点与外观功能。
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createNote, setCreateNote] = useState('');
  const [createVariant, setCreateVariant] = useState<'classic' | 'bento'>('classic');
  const [createBase, setCreateBase] = useState<'current' | 'blank'>('current');
  const [createSections, setCreateSections] = useState<AppearanceSectionId[]>(
    DEFAULT_APPEARANCE_SECTIONS,
  );
  const [createError, setCreateError] = useState('');

  const customThemes = customization.themes ?? [];
  const library = themeLibrary(customThemes);
  const selected = activeTheme(customization.active_theme, customThemes);
  const currentTheme = customization.theme;
  const modified = selected
    ? !themeMatches(currentTheme, customization.layout.variant, selected)
    : true;
  const currentName = selected?.name ?? t('自定义主题');
  const currentId = selected?.id ?? customization.active_theme ?? 'custom';
  const fallback = builtinThemeBundle('default');
  const layout = customization.layout;
  const selectedSections = themeSections(selected);

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setImportError('');
    try {
      const parsed = parseThemeFile(await file.text());
      setPendingImport(parsed);
    } catch (err) {
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
      return;
    }
    const next = [...customThemes, pendingImport];
    update({
      themes: next,
      theme: cloneTheme(pendingImport.theme),
      layout: { ...customization.layout, variant: pendingImport.variant },
      active_theme: pendingImport.id,
    });
    toast.push(
      'ok',
      t('已导入并应用「{name}」', { name: pendingImport.name }),
      t('主题只包含配色、排版与版式，不包含文章或页面。'),
    );
    setPendingImport(null);
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const remaining = customThemes.filter((item) => item.id !== deleteTarget.id);
    if (customization.active_theme === deleteTarget.id) {
      const next = fallback ?? {
        id: 'default',
        name: t('原版'),
        note: '',
        variant: 'classic' as const,
        theme: currentTheme,
      };
      const homeWasDefault =
        next.variant !== customization.layout.variant &&
        sameLayout(customization.home, defaultHomeLayout(customization.layout.variant));
      update({
        themes: remaining,
        theme: cloneTheme(next.theme),
        layout: { ...customization.layout, variant: next.variant },
        ...(homeWasDefault ? { home: defaultHomeLayout(next.variant) } : {}),
        active_theme: next.id,
      });
      toast.push(
        'ok',
        t('已删除并回到「{name}」', { name: next.name }),
        t('被删除的主题不再可用；站点内容没有变化。'),
      );
    } else {
      update({ themes: remaining });
      toast.push(
        'ok',
        t('已删除「{name}」', { name: deleteTarget.name }),
        t('当前主题没有变化。'),
      );
    }
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

  const exportCurrent = () => {
    downloadThemeFile({
      id: currentId,
      name: modified ? `${currentName}${t('（当前调整）')}` : currentName,
      note: selected?.note ?? '',
      variant: customization.layout.variant,
      theme: cloneTheme(currentTheme),
      appearance: { sections: selectedSections },
    });
  };

  const openCreate = () => {
    setCreateName('');
    setCreateNote('');
    setCreateVariant(layout.variant);
    setCreateBase('current');
    setCreateSections([...DEFAULT_APPEARANCE_SECTIONS]);
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
    const base =
      createBase === 'current'
        ? cloneTheme(currentTheme)
        : applyPreset(DEFAULT_THEME, createVariant === 'bento' ? 'night' : 'paper');
    const item: SiteTheme = {
      id: newThemeId(),
      name,
      note: createNote.trim().slice(0, 160),
      variant: createVariant,
      theme: base,
      appearance: { sections: [...createSections] },
    };
    const homeWasDefault =
      createVariant !== layout.variant &&
      sameLayout(customization.home, defaultHomeLayout(layout.variant));
    update({
      themes: [...customThemes, item],
      theme: cloneTheme(base),
      layout: { ...layout, variant: createVariant },
      ...(homeWasDefault ? { home: defaultHomeLayout(createVariant) } : {}),
      active_theme: item.id,
    });
    setCreateOpen(false);
    toast.push(
      'ok',
      t('已创建「{name}」', { name }),
      thenBuild
        ? t('配色与版式已经就位，接下来在页面编排里搭页面。')
        : t('可以继续微调配色，或稍后去页面编排。'),
    );
    if (thenBuild) navigate('/admin/theme');
  };

  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('选择主题')}</h1>
          <p>
            {t(
              '下方是全部主题；点击卡片立即应用，单栏 / 双栏版式会一起切换。也可以创建、导入或删除自己的主题。',
            )}
          </p>
        </div>
        <div className="admin-page-actions">
          <Button variant="secondary" size="sm" icon="plus" onClick={openCreate}>
            {t('创建主题')}
          </Button>
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
          <Link to="/admin/themes" className="btn btn-ghost btn-sm">
            <Icon name="palette" size={14} /> {t('主题设置')}
          </Link>
          <Button variant="secondary" size="sm" icon="eye" onClick={() => window.open('/', '_blank')}>
            {t('预览站点')}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
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

      <div className="settings-grid no-side">
        <div className="editor-main">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('选择主题')}</h3>
                <p>{t('上方是当前主题；点击卡片立即应用，单栏/双栏版式会一起切换。')}</p>
              </div>
              <div className="row gap-8">
                <Badge tone={modified ? 'warn' : 'accent'} dot={!modified}>
                  {currentName}
                  {modified ? t(' · 已微调') : ''}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  icon="upload"
                  onClick={() => fileRef.current?.click()}
                >
                  {t('导入')}
                </Button>
              </div>
            </div>
            <div className="panel-body">
              <div className="theme-bundle-grid">
                {library.map((bundle) => {
                  const isSelected = customization.active_theme === bundle.id;
                  const isBuiltin = BUILTIN_THEME_IDS.has(bundle.id);
                  return (
                    <div
                      key={bundle.id}
                      className={`theme-bundle-card${isSelected ? ' is-selected' : ''}`}
                    >
                      <button
                        type="button"
                        className="theme-bundle-main"
                        onClick={() => applyBundle(bundle)}
                        aria-pressed={isSelected}
                      >
                        <ThemePreview bundle={bundle} />
                        <span className="theme-bundle-copy">
                          <span className="theme-bundle-title">
                            <strong>{bundle.name}</strong>
                            {isBuiltin ? (
                              <Badge tone="muted">{t('内置')}</Badge>
                            ) : (
                              <Badge tone="accent">{t('自定义')}</Badge>
                            )}
                            {isSelected ? <Badge tone="ok">{t('使用中')}</Badge> : null}
                          </span>
                          <span className="theme-bundle-note">
                            {bundle.note || t('一套自定义主题。')}
                          </span>
                          <span className="theme-bundle-meta">
                            {variantLabel(bundle.variant)} ·{' '}
                            {bundle.theme.mode === 'dark' ? t('深色') : t('浅色')}
                          </span>
                        </span>
                      </button>
                      <div className="theme-bundle-actions">
                        <button
                          type="button"
                          className="theme-bundle-iconbtn"
                          aria-label={t('编辑「{name}」的页面编排', { name: bundle.name })}
                          title={t('进入页面编排：用这套主题搭首页与文章页')}
                          onClick={() => editLayout(bundle)}
                        >
                          <Icon name="edit" size={14} />
                        </button>
                        {!isBuiltin ? (
                          <button
                            type="button"
                            className="theme-bundle-iconbtn is-danger"
                            aria-label={t('删除主题 {name}', { name: bundle.name })}
                            title={t('删除这套主题')}
                            onClick={() => setDeleteTarget(bundle)}
                          >
                            <Icon name="trash" size={14} />
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
                <button type="button" className="theme-bundle-card is-new" onClick={openCreate}>
                  <span className="theme-bundle-main">
                    <span className="theme-new-preview" aria-hidden>
                      <Icon name="plus" size={22} />
                    </span>
                    <span className="theme-bundle-copy">
                      <span className="theme-bundle-title">
                        <strong>{t('创建主题')}</strong>
                        <Badge tone="accent">{t('从零开始')}</Badge>
                      </span>
                      <span className="theme-bundle-note">
                        {t('选版式、配色起点与外观功能，建好后直接进页面编排。')}
                      </span>
                      <span className="theme-bundle-meta">{t('单栏 / 双栏 · 自定义外观')}</span>
                    </span>
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
        </div>
      </div>

      <Modal
        open={createOpen}
        title={t('创建一套主题')}
        description={t('选好版式与配色起点，之后再微调；创建完可以直接进页面编排搭页面。')}
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
              placeholder={t('例如：夜航 · 摄影版')}
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
              placeholder={t('暖色双栏，适合摄影与社区。')}
            />
          </Field>

          <div>
            <p className="field-label mb-8">{t('版式')}</p>
            <div className="option-grid two">
              {(
                [
                  {
                    key: 'classic' as const,
                    name: t('单栏'),
                    note: t('编辑排版风，适合长文阅读。'),
                  },
                  {
                    key: 'bento' as const,
                    name: t('双栏'),
                    note: t('杂志网格，适合图片与社区。'),
                  },
                ]
              ).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`option${createVariant === item.key ? ' is-selected' : ''}`}
                  onClick={() => setCreateVariant(item.key)}
                  aria-pressed={createVariant === item.key}
                >
                  <span className="option-icon">
                    <Icon name="columns" size={16} />
                  </span>
                  <span className="option-body">
                    <strong>{item.name}</strong>
                    <p>{item.note}</p>
                  </span>
                  <span className="option-radio" />
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="field-label mb-8">{t('配色起点')}</p>
            <div className="option-grid two">
              {(
                [
                  {
                    key: 'current' as const,
                    name: t('沿用当前主题'),
                    note: t('保留现在的配色、字体与圆角。'),
                  },
                  {
                    key: 'blank' as const,
                    name: t('按版式取默认'),
                    note: t('单栏取纸白，双栏取夜航。'),
                  },
                ]
              ).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`option${createBase === item.key ? ' is-selected' : ''}`}
                  onClick={() => setCreateBase(item.key)}
                  aria-pressed={createBase === item.key}
                >
                  <span className="option-icon">
                    <Icon name="palette" size={16} />
                  </span>
                  <span className="option-body">
                    <strong>{item.name}</strong>
                    <p>{item.note}</p>
                  </span>
                  <span className="option-radio" />
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="field-label mb-8">{t('外观功能')}</p>
            <div className="appearance-bind-grid">
              {APPEARANCE_SECTIONS.map((section) => {
                const on = createSections.includes(section.id);
                return (
                  <label key={section.id} className={`appearance-bind${on ? ' is-on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setCreateSections((prev) =>
                          prev.includes(section.id)
                            ? prev.filter((item) => item !== section.id)
                            : [...prev, section.id],
                        )
                      }
                    />
                    <span>
                      <strong>{section.name}</strong>
                      <em>{section.note}</em>
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="field-hint mt-8">
              {t('只影响「外观」页显示哪些设置；取消勾选后，已有文案仍然保留，随时可以再打开。')}
            </p>
          </div>

          <Callout tone="info" icon="layers">
            {t(
              '主题创建后会自动切换为当前主题。点「创建并编排页面」会直接打开页面编排， 为首页与自定义页面加组件。',
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
        description={t('主题只包含配色、排版与单栏/双栏版式；不会导入文章、页面或自定义 CSS。')}
        onClose={() => setPendingImport(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingImport(null)}>
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
                  {variantLabel(pendingImport.variant)} ·{' '}
                  {pendingImport.theme.mode === 'dark' ? t('深色') : t('浅色')}
                </span>
              </div>
            </div>
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
