import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type {
  AppearanceSectionId,
  ArticleCardStyle,
  FooterColumn,
  HeaderStyle,
  NavChild,
  NavTab,
  SiteTheme,
  SocialLink,
} from '../../types';
import { useAuth } from '../../lib/session';
import { navPages, useCustomization } from '../../lib/customize';
import { applyMode, DEFAULT_THEME } from '../../lib/theme';
import {
  defaultFooterColumns,
  MAX_FOOTER_COLUMNS,
  MAX_FOOTER_LINKS,
  MAX_NAV_CHILDREN,
  MAX_NAV_TABS,
  MAX_SOCIAL_LINKS,
  NAV_ICON_CHOICES,
  SOCIAL_PLATFORM_CHOICES,
  newNavChild,
  newNavId,
  newSocialLink,
  siteNavTabs,
  socialPlatformLabel,
} from '../../lib/navigation';
import {
  APPEARANCE_SECTIONS,
  BUILTIN_THEME_IDS,
  activeTheme,
  builtinThemeBundle,
  newThemeId,
  themeMatches,
  themeSections,
  variantLabel,
} from '../../lib/themes';
import { cloneTheme, useThemeSwitch } from '../../lib/themeSwitch';
import { withThemeLayout } from '../../lib/themeLayouts';
import { cloneThemePreview } from '../../lib/themePreview';
import { useTitle } from '../../lib/hooks';
import { useT } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { ThemeTokensPanel } from '../../components/theme/ThemeTokensPanel';
import { ThemeCustomSettings } from '../../components/theme/ThemeCustomSettings';
import { themeHasSettings } from '../../lib/themeSettings';
import { LoadingPage } from './Loading';
import { AppearancePage } from './Appearance';
import {
  Badge,
  Button,
  Callout,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
  Toggle,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';

export function ThemesPage() {
  const t = useT();
  useTitle(t('主题设置'));
  const { site } = useAuth();
  const { customization, update } = useCustomization();
  const toast = useToast();
  const { applyBundle } = useThemeSwitch();
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveNote, setSaveNote] = useState('');
  const [saveError, setSaveError] = useState('');
  // 「加载动画」并入主题设置，用顶部分区切换。
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<'theme' | 'chrome' | 'loading' | 'appearance' | 'custom'>(
    params.get('tab') === 'appearance' ? 'appearance' : 'theme',
  );
  /** 切换分区时同步 URL：从「外观」旧入口重定向过来时能直接落在这一栏。 */
  const selectTab = (next: 'theme' | 'chrome' | 'loading' | 'appearance' | 'custom') => {
    setTab(next);
    const copy = new URLSearchParams(params);
    if (next === 'appearance') copy.set('tab', 'appearance');
    else copy.delete('tab');
    setParams(copy, { replace: true });
  };
  // 每个 Tab 的二级导航编辑器是否展开；默认展开，便于直接添加入口。
  const [openNavChildren, setOpenNavChildren] = useState<Record<string, boolean>>({});

  const customThemes = customization.themes ?? [];
  const selected = activeTheme(customization.active_theme, customThemes);
  const currentTheme = customization.theme;
  const soften = currentTheme.soften ?? DEFAULT_THEME.soften;
  const modified = selected
    ? !themeMatches(currentTheme, customization.layout.variant, selected)
    : true;
  const currentName = selected?.name ?? t('自定义主题');
  const fallback = builtinThemeBundle('default');
  const restoreLabel = selected ? t('恢复主题默认') : t('套用原版主题');
  const layout = customization.layout;
  const isBuiltinSelected = !!selected && BUILTIN_THEME_IDS.has(selected.id);
  const selectedCustom = selected && !isBuiltinSelected ? selected : null;
  const selectedSections = themeSections(selected);
  const navState = siteNavTabs(layout, navPages(customization));
  const navTabs = navState.tabs;
  const customNav = layout.nav_tabs;

  const setTheme = (patch: Partial<typeof currentTheme>) =>
    update({ theme: { ...currentTheme, ...patch } });
  const setLayout = (patch: Partial<typeof layout>) =>
    update({ layout: { ...layout, ...patch } });

  const headerStyle = layout.header_style ?? 'classic';
  /** 页头（最上方 Tab 栏）样式选项。 */
  const headerStyleOptions: { id: HeaderStyle; label: string; hint: string }[] = [
    {
      id: 'classic',
      label: t('经典吸顶'),
      hint: t('整条页头吸顶，滚动后加一点阴影。'),
    },
    {
      id: 'transparent',
      label: t('顶部透明'),
      hint: t('页首透明，向下滚动后重新出现底色。'),
    },
    {
      id: 'float',
      label: t('悬浮胶囊'),
      hint: t('滚动后收缩成圆角悬浮栏，可配高斯模糊。'),
    },
  ];
  const headerStyleLabel =
    headerStyleOptions.find((option) => option.id === headerStyle)?.label ?? t('经典吸顶');

  /** 夜航首页文章卡的两套外观；只对 bento 版式开放。 */
  const articleStyle = layout.article_card_style ?? 'cover';
  const articleStyleOptions: { id: ArticleCardStyle; label: string; note: string }[] = [
    {
      id: 'cover',
      label: t('封面在上'),
      note: t('现在的外观：封面在卡片上方，标题与简介在下方。'),
    },
    {
      id: 'blur',
      label: t('模糊背景'),
      note: t('封面铺满整张卡片并高斯模糊，标题与简介压在图上。'),
    },
  ];

  /* ---------- 导航 Tab ---------- */

  const setNavTabs = (tabs: NavTab[]) =>
    update({ layout: { ...layout, nav_tabs: tabs.slice(0, MAX_NAV_TABS) } });

  const startCustomNav = () => {
    setNavTabs(navState.tabs);
    toast.push('ok', t('已改为自定义导航'), t('现在可以改文字、换页面或删掉不需要的入口。'));
  };

  const restoreAutoNav = () => {
    update({ layout: { ...layout, nav_tabs: undefined } });
    toast.push('ok', t('已恢复自动导航'), t('按「首页 / 文章 / 帖子 / 搜索」与加入导航的页面生成。'));
  };

  const editNavTab = (id: string, patch: Partial<NavTab>) => {
    if (!customNav) return;
    setNavTabs(customNav.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)));
  };

  const addNavTab = () => {
    if (!customNav) return;
    if (customNav.length >= MAX_NAV_TABS) {
      toast.push('error', t('最多 {count} 个 Tab', { count: MAX_NAV_TABS }), t('先删掉不用的入口再添加。'));
      return;
    }
    setNavTabs([...customNav, { id: newNavId('tab'), label: t('新入口'), href: '/' }]);
  };

  const removeNavTab = (id: string) => {
    if (!customNav) return;
    setNavTabs(customNav.filter((tab) => tab.id !== id));
  };

  const moveNavTab = (id: string, delta: number) => {
    if (!customNav) return;
    const index = customNav.findIndex((tab) => tab.id === id);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= customNav.length) return;
    const copy = [...customNav];
    const [item] = copy.splice(index, 1);
    copy.splice(next, 0, item);
    setNavTabs(copy);
  };

  /* ---------- 二级导航 ---------- */

  const editNavChild = (tabId: string, childId: string, patch: Partial<NavChild>) => {
    if (!customNav) return;
    setNavTabs(
      customNav.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              children: (tab.children ?? []).map((child) =>
                child.id === childId ? { ...child, ...patch } : child,
              ),
            }
          : tab,
      ),
    );
  };

  const addNavChild = (tabId: string) => {
    if (!customNav) return;
    setNavTabs(
      customNav.map((tab) => {
        if (tab.id !== tabId) return tab;
        const children = tab.children ?? [];
        if (children.length >= MAX_NAV_CHILDREN) {
          toast.push(
            'error',
            t('每个 Tab 最多 {count} 个二级入口', { count: MAX_NAV_CHILDREN }),
            t('先删掉不用的入口。'),
          );
          return tab;
        }
        return { ...tab, children: [...children, newNavChild()] };
      }),
    );
  };

  const removeNavChild = (tabId: string, childId: string) => {
    if (!customNav) return;
    setNavTabs(
      customNav.map((tab) =>
        tab.id === tabId
          ? { ...tab, children: (tab.children ?? []).filter((child) => child.id !== childId) }
          : tab,
      ),
    );
  };

  const moveNavChild = (tabId: string, childId: string, delta: number) => {
    if (!customNav) return;
    setNavTabs(
      customNav.map((tab) => {
        if (tab.id !== tabId) return tab;
        const children = [...(tab.children ?? [])];
        const index = children.findIndex((child) => child.id === childId);
        const next = index + delta;
        if (index < 0 || next < 0 || next >= children.length) return tab;
        const [item] = children.splice(index, 1);
        children.splice(next, 0, item);
        return { ...tab, children };
      }),
    );
  };

  /* ---------- 快捷链接 ---------- */

  const setSocialLinks = (links: SocialLink[]) =>
    setLayout({ social_links: links.slice(0, MAX_SOCIAL_LINKS) });

  const editSocialLink = (id: string, patch: Partial<SocialLink>) =>
    setSocialLinks(
      (layout.social_links ?? []).map((link) => (link.id === id ? { ...link, ...patch } : link)),
    );

  const addSocialLink = () => {
    const links = layout.social_links ?? [];
    if (links.length >= MAX_SOCIAL_LINKS) {
      toast.push(
        'error',
        t('最多 {count} 条快捷链接', { count: MAX_SOCIAL_LINKS }),
        t('先删掉不用的链接再添加。'),
      );
      return;
    }
    setSocialLinks([...links, newSocialLink()]);
  };

  const removeSocialLink = (id: string) =>
    setSocialLinks((layout.social_links ?? []).filter((link) => link.id !== id));

  const moveSocialLink = (id: string, delta: number) => {
    const links = [...(layout.social_links ?? [])];
    const index = links.findIndex((link) => link.id === id);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= links.length) return;
    const [item] = links.splice(index, 1);
    links.splice(next, 0, item);
    setSocialLinks(links);
  };

  /* ---------- 页脚栏目 ---------- */

  const setFooterColumns = (columns: FooterColumn[]) =>
    update({ layout: { ...layout, footer_columns: columns.slice(0, MAX_FOOTER_COLUMNS) } });

  const editColumn = (id: string, patch: Partial<FooterColumn>) =>
    setFooterColumns(
      layout.footer_columns.map((column) => (column.id === id ? { ...column, ...patch } : column)),
    );

  const addColumn = () => {
    if (layout.footer_columns.length >= MAX_FOOTER_COLUMNS) {
      toast.push('error', t('最多 {count} 栏', { count: MAX_FOOTER_COLUMNS }), t('先删掉不用的栏目再添加。'));
      return;
    }
    setFooterColumns([
      ...layout.footer_columns,
      { id: newNavId('fcol'), title: t('新栏目'), links: [] },
    ]);
  };

  const removeColumn = (id: string) =>
    setFooterColumns(layout.footer_columns.filter((column) => column.id !== id));

  const editLink = (columnId: string, linkId: string, patch: Partial<FooterColumn['links'][number]>) =>
    setFooterColumns(
      layout.footer_columns.map((column) =>
        column.id === columnId
          ? {
              ...column,
              links: column.links.map((link) => (link.id === linkId ? { ...link, ...patch } : link)),
            }
          : column,
      ),
    );

  const addLink = (columnId: string) =>
    setFooterColumns(
      layout.footer_columns.map((column) => {
        if (column.id !== columnId || column.links.length >= MAX_FOOTER_LINKS) return column;
        return {
          ...column,
          links: [...column.links, { id: newNavId('flink'), label: t('新条目'), href: '' }],
        };
      }),
    );

  const removeLink = (columnId: string, linkId: string) =>
    setFooterColumns(
      layout.footer_columns.map((column) =>
        column.id === columnId
          ? { ...column, links: column.links.filter((link) => link.id !== linkId) }
          : column,
      ),
    );

  /* ---------- 主题绑定的外观功能 ---------- */

  const toggleSection = (id: AppearanceSectionId) => {
    if (!selectedCustom) return;
    const next = selectedSections.includes(id)
      ? selectedSections.filter((item) => item !== id)
      : [...selectedSections, id];
    update({
      themes: customThemes.map((item) =>
        item.id === selectedCustom.id ? { ...item, appearance: { sections: next } } : item,
      ),
    });
  };

  const restoreCurrent = () => {
    const bundle = selected ?? fallback;
    if (!bundle) return;
    applyBundle(bundle, false);
    toast.push('ok', t('已恢复主题默认'), t('当前主题的配色、排版与版式回到原始定义。'));
  };

  const openSave = () => {
    setSaveName(selected ? `${selected.name}${t('（自定义）')}` : t('我的主题'));
    setSaveNote('');
    setSaveError('');
    setSaveOpen(true);
  };

  const saveAsCustom = () => {
    const name = saveName.trim().slice(0, 40);
    if (!name) {
      setSaveError(t('主题名称不能为空。'));
      return;
    }
    if (customThemes.length >= 20) {
      setSaveError(t('最多保存 20 套自定义主题，请先删除不用的主题。'));
      return;
    }
    const item: SiteTheme = {
      id: newThemeId(),
      name,
      note: saveNote.trim().slice(0, 160),
      variant: customization.layout.variant,
      theme: cloneTheme(currentTheme),
      appearance: { sections: [...selectedSections] },
      ...(selected?.preview ? { preview: cloneThemePreview(selected.preview) } : {}),
    };
    // 另存为主题会把当前这套编排一起存进新主题，之后切回来仍是同一份页面。
    const withHome = withThemeLayout(customization.theme_layouts, item.id, 'home', customization.home);
    const themeLayouts = withThemeLayout(
      withHome,
      item.id,
      'article',
      customization.article ?? { blocks: [] },
    );
    update({
      themes: [...customThemes, item],
      theme_layouts: themeLayouts,
      active_theme: item.id,
    });
    setSaveOpen(false);
    toast.push(
      'ok',
      t('已保存「{name}」', { name }),
      t('可以在主题选择区重新套用，也可以导出给其他站点。'),
    );
  };

  const renderChrome = () => (
    <div className="settings-grid">
      <div className="editor-main">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>{t('页头样式')}</h3>
              <p>{t('最上方 Tab 栏在页首的样子，以及向下滚动后怎么变化；深浅色主题共用。')}</p>
            </div>
            <Badge tone={headerStyle === 'classic' ? 'muted' : 'accent'}>{headerStyleLabel}</Badge>
          </div>
          <div className="panel-body form-stack">
            <div className="header-style-grid" role="radiogroup" aria-label={t('页头样式')}>
              {headerStyleOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={headerStyle === option.id}
                  className={`header-style-card${headerStyle === option.id ? ' is-on' : ''}`}
                  onClick={() => setLayout({ header_style: option.id })}
                >
                  <span className={`header-style-preview is-${option.id}`} aria-hidden />
                  <strong>{option.label}</strong>
                  <em>{option.hint}</em>
                </button>
              ))}
            </div>

            <div className="form-grid">
              <Field
                label={t('模糊强度')}
                htmlFor="header-blur-amount"
                aside="4–24 px"
                hint={t('背景高斯模糊的半径；数值越大越朦胧。关闭模糊时这一项不生效。')}
              >
                <Input
                  id="header-blur-amount"
                  type="number"
                  min={4}
                  max={24}
                  value={layout.header_blur_amount ?? 10}
                  onChange={(event) => setLayout({ header_blur_amount: Number(event.target.value) })}
                />
              </Field>
              <Field
                label={t('滚动触发距离')}
                htmlFor="header-threshold"
                aside="0–240 px"
                hint={t('向下滚动超过这个距离后，切换到“滚动后”的样式。')}
              >
                <Input
                  id="header-threshold"
                  type="number"
                  min={0}
                  max={240}
                  value={layout.header_threshold ?? 8}
                  onChange={(event) => setLayout({ header_threshold: Number(event.target.value) })}
                />
              </Field>
            </div>

            <Toggle
              checked={layout.header_blur !== false}
              onChange={(next) => setLayout({ header_blur: next })}
              label={t('背景高斯模糊')}
              description={t(
                '开启后页头背景半透明并做高斯模糊；关闭则使用实色背景。悬浮胶囊只在滚动后才出现模糊层。',
              )}
            />

            <p className="field-hint">
              {t(
                '三个样式都会在滚动后变化：经典加阴影、顶部透明补底色、悬浮胶囊收缩成一条圆角栏。悬浮胶囊宽度上限 1280px，窄屏自动铺满；页首透明时请确认首屏背景上的文字仍然可读。',
              )}
            </p>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>{t('顶部导航 Tab')}</h3>
              <p>{t('页头显示哪些入口、叫什么名字、指向哪个页面，都在这里决定。')}</p>
            </div>
            <Badge tone={customNav ? 'accent' : 'muted'}>
              {customNav ? t('自定义 · {count} 个', { count: navTabs.length }) : t('自动')}
            </Badge>
          </div>
          <div className="panel-body">
            {customNav ? (
              <div className="form-stack">
                <datalist id="pp-nav-targets">
                  <option value="/">{t('首页')}</option>
                  <option value="/articles">{t('全部文章')}</option>
                  <option value="/posts">{t('全部帖子')}</option>
                  <option value="/search">{t('搜索')}</option>
                  <option value="/about">{t('关于本站')}</option>
                  {customization.pages.map((page) => (
                    <option key={page.id} value={`/${page.slug}`}>
                      {page.title}
                    </option>
                  ))}
                </datalist>
                <div className="form-grid">
                  <Field label={t('导航对齐')} htmlFor="nav-align">
                    <Select
                      id="nav-align"
                      value={layout.nav_align ?? 'left'}
                      onChange={(event) =>
                        setLayout({ nav_align: event.target.value as 'left' | 'center' | 'right' })
                      }
                    >
                      <option value="left">{t('靠左')}</option>
                      <option value="center">{t('居中')}</option>
                      <option value="right">{t('靠右')}</option>
                    </Select>
                  </Field>
                  <Field
                    label={t('图标默认位置')}
                    htmlFor="nav-icon-position"
                    hint={t('单个 Tab 可以单独覆盖。')}
                  >
                    <Select
                      id="nav-icon-position"
                      value={layout.nav_icon_position ?? 'left'}
                      onChange={(event) =>
                        setLayout({
                          nav_icon_position: event.target.value as 'left' | 'right' | 'none',
                        })
                      }
                    >
                      <option value="left">{t('文字左侧')}</option>
                      <option value="right">{t('文字右侧')}</option>
                      <option value="none">{t('不显示图标')}</option>
                    </Select>
                  </Field>
                  <Field
                    label={t('二级导航默认样式')}
                    htmlFor="nav-sub-style"
                    hint={t('每个 Tab 也可以单独选择；有二级入口时才出现。')}
                  >
                    <Select
                      id="nav-sub-style"
                      value={layout.nav_sub_style ?? 'bar'}
                      onChange={(event) =>
                        setLayout({ nav_sub_style: event.target.value as 'bar' | 'dropdown' })
                      }
                    >
                      <option value="bar">{t('页头下方胶囊栏')}</option>
                      <option value="dropdown">{t('收进下拉菜单')}</option>
                    </Select>
                  </Field>
                </div>
                <Toggle
                  checked={layout.nav_sub_show_icons ?? true}
                  onChange={(next) => setLayout({ nav_sub_show_icons: next })}
                  label={t('二级栏显示图标')}
                  description={t('关闭后二级栏只显示文字；下拉菜单仍显示已配置的图标。')}
                />
                {customNav.map((tab, index) => (
                  <div className="chrome-item" key={tab.id}>
                    <div className="chrome-row">
                      <span className="chrome-order">{index + 1}</span>
                      <Input
                        value={tab.label}
                        maxLength={20}
                        placeholder={t('显示文字')}
                        aria-label={t('第 {index} 个 Tab 的文字', { index: index + 1 })}
                        onChange={(event) => editNavTab(tab.id, { label: event.target.value })}
                      />
                      <Input
                        value={tab.href}
                        maxLength={300}
                        list="pp-nav-targets"
                        placeholder={t('/about 或 https://…')}
                        aria-label={t('第 {index} 个 Tab 的链接', { index: index + 1 })}
                        onChange={(event) => editNavTab(tab.id, { href: event.target.value })}
                      />
                      <div className="chrome-row-actions">
                        <button
                          type="button"
                          className="chrome-move"
                          aria-label={t('上移')}
                          disabled={index === 0}
                          onClick={() => moveNavTab(tab.id, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="chrome-move"
                          aria-label={t('下移')}
                          disabled={index === customNav.length - 1}
                          onClick={() => moveNavTab(tab.id, 1)}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="chrome-move is-danger"
                          aria-label={t('删除 {name}', { name: tab.label })}
                          onClick={() => removeNavTab(tab.id)}
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      </div>
                    </div>

                    <div className="chrome-tab-extra">
                      <Field label={t('图标')} htmlFor={`nav-icon-${tab.id}`}>
                        <Select
                          id={`nav-icon-${tab.id}`}
                          value={tab.icon ?? ''}
                          onChange={(event) =>
                            editNavTab(tab.id, { icon: event.target.value || undefined })
                          }
                        >
                          <option value="">{t('无图标')}</option>
                          {NAV_ICON_CHOICES.map((choice) => (
                            <option key={choice.name} value={choice.name}>
                              {choice.label}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label={t('图标位置')} htmlFor={`nav-icon-pos-${tab.id}`}>
                        <Select
                          id={`nav-icon-pos-${tab.id}`}
                          value={tab.icon_position ?? ''}
                          onChange={(event) =>
                            editNavTab(tab.id, {
                              icon_position: (event.target.value || undefined) as
                                | 'left'
                                | 'right'
                                | 'none'
                                | undefined,
                            })
                          }
                        >
                          <option value="">{t('跟随全局')}</option>
                          <option value="left">{t('文字左侧')}</option>
                          <option value="right">{t('文字右侧')}</option>
                          <option value="none">{t('不显示')}</option>
                        </Select>
                      </Field>
                      <Field label={t('二级入口样式')} htmlFor={`nav-sub-${tab.id}`}>
                        <Select
                          id={`nav-sub-${tab.id}`}
                          value={tab.sub_style ?? ''}
                          onChange={(event) =>
                            editNavTab(tab.id, {
                              sub_style: (event.target.value || undefined) as
                                | 'bar'
                                | 'dropdown'
                                | undefined,
                            })
                          }
                        >
                          <option value="">{t('跟随全局')}</option>
                          <option value="bar">{t('胶囊栏')}</option>
                          <option value="dropdown">{t('下拉菜单')}</option>
                        </Select>
                      </Field>
                    </div>

                    <details
                      className="chrome-children"
                      open={openNavChildren[tab.id] ?? true}
                      onToggle={(event) => {
                        const open = event.currentTarget.open;
                        setOpenNavChildren((prev) => ({ ...prev, [tab.id]: open }));
                      }}
                    >
                      <summary>
                        {t('二级导航')}{' '}
                        <span className="tiny faint">{tab.children?.length ?? 0}/{MAX_NAV_CHILDREN}</span>
                      </summary>
                      {(tab.children ?? []).map((child, childIndex) => (
                        <div className="chrome-child" key={child.id}>
                          <div className="chrome-row is-link">
                            <Input
                              value={child.label}
                              maxLength={20}
                              placeholder={t('二级文字')}
                              aria-label={t('第 {tab} 个 Tab 的第 {child} 个二级入口文字', {
                                tab: index + 1,
                                child: childIndex + 1,
                              })}
                              onChange={(event) =>
                                editNavChild(tab.id, child.id, { label: event.target.value })
                              }
                            />
                            <Input
                              value={child.href}
                              maxLength={300}
                              list="pp-nav-targets"
                              placeholder={t('/category/news 或 https://…')}
                              aria-label={t('第 {tab} 个 Tab 的第 {child} 个二级入口链接', {
                                tab: index + 1,
                                child: childIndex + 1,
                              })}
                              onChange={(event) =>
                                editNavChild(tab.id, child.id, { href: event.target.value })
                              }
                            />
                            <div className="chrome-row-actions">
                              <button
                                type="button"
                                className="chrome-move"
                                aria-label={t('二级入口上移')}
                                disabled={childIndex === 0}
                                onClick={() => moveNavChild(tab.id, child.id, -1)}
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                className="chrome-move"
                                aria-label={t('二级入口下移')}
                                disabled={childIndex === (tab.children?.length ?? 0) - 1}
                                onClick={() => moveNavChild(tab.id, child.id, 1)}
                              >
                                ↓
                              </button>
                              <button
                                type="button"
                                className="chrome-move is-danger"
                                aria-label={t('删除 {name}', { name: child.label })}
                                onClick={() => removeNavChild(tab.id, child.id)}
                              >
                                <Icon name="trash" size={13} />
                              </button>
                            </div>
                          </div>
                          <div className="chrome-child-extra">
                            <Select
                              value={child.icon ?? ''}
                              aria-label={t('{name} 的图标', { name: child.label })}
                              onChange={(event) =>
                                editNavChild(tab.id, child.id, {
                                  icon: event.target.value || undefined,
                                })
                              }
                            >
                              <option value="">{t('无图标')}</option>
                              {NAV_ICON_CHOICES.map((choice) => (
                                <option key={choice.name} value={choice.name}>
                                  {choice.label}
                                </option>
                              ))}
                            </Select>
                          </div>
                        </div>
                      ))}
                      <Button
                        variant="secondary"
                        size="sm"
                        icon="plus"
                        onClick={() => addNavChild(tab.id)}
                      >
                        {t('添加二级入口')}
                      </Button>
                    </details>
                  </div>
                ))}
                <div className="row gap-10" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                  <Button variant="secondary" size="sm" icon="plus" onClick={addNavTab}>
                    {t('添加 Tab')}
                  </Button>
                  <button type="button" className="link-btn" onClick={restoreAutoNav}>
                    {t('恢复自动导航')}
                  </button>
                  <span className="tiny faint">
                    {customNav.length}/{MAX_NAV_TABS}
                  </span>
                </div>
                <p className="field-hint">
                  {t('站内路径以')} <code className="mono">/</code>{' '}
                  {t('开头；外链会在新窗口打开；链接留空时这个 Tab 只显示文字，用来做分组。')}
                </p>
              </div>
            ) : (
              <div className="form-stack">
                <div className="chrome-preview" aria-label={t('当前 Tab 预览')}>
                  {navTabs.map((tab) => (
                    <span className="chrome-preview-tab" key={tab.id}>
                      {tab.label}
                    </span>
                  ))}
                </div>
                <div className="form-stack" style={{ gap: 2 }}>
                  <Toggle
                    checked={layout.show_articles}
                    onChange={(next) => setLayout({ show_articles: next })}
                    label={t('自动包含“文章”')}
                  />
                  <Toggle
                    checked={layout.show_posts}
                    onChange={(next) => setLayout({ show_posts: next })}
                    label={t('自动包含“帖子”')}
                  />
                  <Toggle
                    checked={layout.show_search}
                    onChange={(next) => setLayout({ show_search: next })}
                    label={t('自动包含“搜索”')}
                  />
                </div>
                <p className="field-hint">
                  {t('自动模式：按上面的开关与勾选“加入站点导航”的页面生成（最多 {count} 个）。改成自定义之后，这些入口不再自动增减。', {
                    count: MAX_NAV_TABS,
                  })}
                </p>
                <div>
                  <Button variant="secondary" size="sm" icon="edit" onClick={startCustomNav}>
                    {t('改为自定义 Tab')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>{t('软件 / 社交快捷链接')}</h3>
              <p>
                {t(
                  '配置 GitHub、X / Twitter、Mastodon、RSS 或任意网站。夜航主题会显示在页头 左上角品牌旁；所有主题都会在页脚最下方底栏上方显示。',
                )}
              </p>
            </div>
            <Badge tone={(layout.social_links ?? []).length ? 'accent' : 'muted'}>
              {t('{count}/{total} 条', {
                count: (layout.social_links ?? []).length,
                total: MAX_SOCIAL_LINKS,
              })}
            </Badge>
          </div>
          <div className="panel-body">
            <div className="form-stack">
              {(layout.social_links ?? []).map((link, index) => (
                <div className="chrome-item" key={link.id}>
                  <div className="chrome-row chrome-social-row">
                    <span className="chrome-order">{index + 1}</span>
                    <Select
                      value={link.platform}
                      aria-label={t('第 {index} 条快捷链接的平台', { index: index + 1 })}
                      onChange={(event) => {
                        const platform = event.target.value as SocialLink['platform'];
                        const previous = socialPlatformLabel(link.platform);
                        editSocialLink(link.id, {
                          platform,
                          label:
                            !link.label.trim() || link.label === previous
                              ? socialPlatformLabel(platform)
                              : link.label,
                        });
                      }}
                    >
                      {SOCIAL_PLATFORM_CHOICES.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.label}
                        </option>
                      ))}
                    </Select>
                    <Input
                      value={link.label}
                      maxLength={40}
                      placeholder={t('显示文字')}
                      aria-label={t('第 {index} 条快捷链接的文字', { index: index + 1 })}
                      onChange={(event) => editSocialLink(link.id, { label: event.target.value })}
                    />
                    <Input
                      value={link.url}
                      maxLength={300}
                      placeholder={t('https://github.com/your-name 或 mailto:hi@example.com')}
                      aria-label={t('第 {index} 条快捷链接的地址', { index: index + 1 })}
                      onChange={(event) => editSocialLink(link.id, { url: event.target.value })}
                    />
                    <div className="chrome-row-actions">
                      <button
                        type="button"
                        className="chrome-move"
                        aria-label={t('上移快捷链接')}
                        disabled={index === 0}
                        onClick={() => moveSocialLink(link.id, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="chrome-move"
                        aria-label={t('下移快捷链接')}
                        disabled={index === (layout.social_links ?? []).length - 1}
                        onClick={() => moveSocialLink(link.id, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="chrome-move is-danger"
                        aria-label={t('删除 {name}', { name: link.label })}
                        onClick={() => removeSocialLink(link.id)}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              <div>
                <Button variant="secondary" size="sm" icon="plus" onClick={addSocialLink}>
                  {t('添加快捷链接')}
                </Button>
              </div>
              <p className="field-hint">
                {t('地址支持 http(s) 与 mailto；页头只显示图标，页脚会显示图标和文字。')}
              </p>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>{t('页脚品牌区')}</h3>
              <p>
                {t('页脚左侧的标题、副标题与简介；每一项留空都会回退到站点信息，不填也不会出现空白。')}
              </p>
            </div>
          </div>
          <div className="panel-body">
            <div className="form-stack">
              <Field
                label={t('页脚标题')}
                htmlFor="footer-brand-name"
                aside={`${layout.footer_brand_name.length}/60`}
                hint={t('留空显示站点名称。')}
              >
                <Input
                  id="footer-brand-name"
                  value={layout.footer_brand_name}
                  maxLength={60}
                  placeholder={t('例如：Practacu Press')}
                  onChange={(event) => setLayout({ footer_brand_name: event.target.value })}
                />
              </Field>
              <Field
                label={t('页脚副标题')}
                htmlFor="footer-brand-sub"
                aside={`${layout.footer_brand_sub.length}/60`}
                hint={t('留空沿用「外观 → 品牌副标题」。')}
              >
                <Input
                  id="footer-brand-sub"
                  value={layout.footer_brand_sub}
                  maxLength={60}
                  placeholder="Independent publishing"
                  onChange={(event) => setLayout({ footer_brand_sub: event.target.value })}
                />
              </Field>
              <Field
                label={t('页脚简介')}
                htmlFor="footer-brand-desc"
                aside={`${layout.footer_brand_desc.length}/300`}
                hint={t('留空使用站点简介；两者都为空时显示默认文案。')}
              >
                <Textarea
                  id="footer-brand-desc"
                  value={layout.footer_brand_desc}
                  maxLength={300}
                  rows={2}
                  placeholder={t('一句话介绍这间编辑部。')}
                  onChange={(event) => setLayout({ footer_brand_desc: event.target.value })}
                />
              </Field>
              <Toggle
                checked={layout.footer_show_tags}
                onChange={(next) => setLayout({ footer_show_tags: next })}
                label={t('显示状态标签')}
                description={t('公开浏览、审核发布、个人博客等状态；关闭后整行隐藏。')}
              />
              <Field
                label={t('自定义状态标签')}
                htmlFor="footer-tags"
                aside={`${layout.footer_tags.length}/120`}
                hint={t('用逗号或「、」分隔，最多 4 个；留空显示站点真实状态。')}
              >
                <Input
                  id="footer-tags"
                  value={layout.footer_tags}
                  maxLength={120}
                  placeholder={t('例如：独立出版、写作、社区')}
                  onChange={(event) => setLayout({ footer_tags: event.target.value })}
                />
              </Field>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>{t('页脚栏目')}</h3>
              <p>{t('每栏一个标题，下面是若干「文字 + 链接」；不填链接就是纯文字。')}</p>
            </div>
            <Badge tone="muted">
              {t('{count}/{total} 栏', {
                count: layout.footer_columns.length,
                total: MAX_FOOTER_COLUMNS,
              })}
            </Badge>
          </div>
          <div className="panel-body">
            <div className="form-stack">
              {layout.footer_columns.map((column) => (
                <div className="chrome-column" key={column.id}>
                  <div className="chrome-column-head">
                    <Input
                      value={column.title}
                      maxLength={20}
                      placeholder={t('栏目标题，例如：阅读')}
                      aria-label={t('栏目标题')}
                      onChange={(event) => editColumn(column.id, { title: event.target.value })}
                    />
                    <button
                      type="button"
                      className="chrome-move is-danger"
                      aria-label={t('删除栏目 {name}', { name: column.title })}
                      onClick={() => removeColumn(column.id)}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                  {column.links.map((link) => (
                    <div className="chrome-row is-link" key={link.id}>
                      <Input
                        value={link.label}
                        maxLength={40}
                        placeholder={t('显示文字')}
                        aria-label={t('条目文字')}
                        onChange={(event) => editLink(column.id, link.id, { label: event.target.value })}
                      />
                      <Input
                        value={link.href}
                        maxLength={300}
                        list="pp-nav-targets"
                        placeholder={t('链接（可留空）')}
                        aria-label={t('条目链接')}
                        onChange={(event) => editLink(column.id, link.id, { href: event.target.value })}
                      />
                      <button
                        type="button"
                        className="chrome-move is-danger"
                        aria-label={t('删除条目 {name}', { name: link.label })}
                        onClick={() => removeLink(column.id, link.id)}
                      >
                        <Icon name="close" size={13} />
                      </button>
                    </div>
                  ))}
                  <div className="row gap-10" style={{ alignItems: 'center' }}>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => addLink(column.id)}
                      disabled={column.links.length >= MAX_FOOTER_LINKS}
                    >
                      {t('+ 添加一条')}
                    </button>
                    <span className="tiny faint">
                      {column.links.length}/{MAX_FOOTER_LINKS}
                    </span>
                  </div>
                </div>
              ))}

              <div className="row gap-10" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                <Button variant="secondary" size="sm" icon="plus" onClick={addColumn}>
                  {t('添加栏目')}
                </Button>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setFooterColumns(defaultFooterColumns())}
                >
                  {t('恢复默认两栏')}
                </button>
              </div>

              <Field
                label={t('版权文案')}
                htmlFor="footer-text"
                aside={`${layout.footer_text.length}/200`}
                hint={t('显示在最下方；支持 {year} 与 {site} 两个占位符，留空使用默认文案。')}
              >
                <Input
                  id="footer-text"
                  value={layout.footer_text}
                  maxLength={200}
                  placeholder={t('© {year} {site}. 由写作者与读者共同维护。')}
                  onChange={(event) => setLayout({ footer_text: event.target.value })}
                />
              </Field>
              <Field
                label={t('底部右侧说明')}
                htmlFor="footer-note"
                aside={`${layout.footer_note.length}/80`}
                hint={t('显示在版权行右侧，例如版本号或备案说明；留空隐藏。')}
              >
                <Input
                  id="footer-note"
                  value={layout.footer_note}
                  maxLength={80}
                  placeholder={t('前端 v0.1 · React')}
                  onChange={(event) => setLayout({ footer_note: event.target.value })}
                />
              </Field>
              <p className="field-hint">
                {t('ICP 与公安网备号在')}
                <Link to="/admin/settings" className="text-link">
                  {' '}
                  {t('站点设置 → 基本信息')}{' '}
                </Link>
                {t('里填写与展示；这里只管品牌区、栏目、版权与底部说明。')}
              </p>
            </div>
          </div>
        </section>
      </div>

      <aside className="settings-side">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>{t('生效位置')}</h3>
              <p>{t('导航在页头，栏目在页脚；两者都跟随主题的排版。')}</p>
            </div>
          </div>
          <div className="panel-body">
            <div className="mini-list">
              <div className="mini-row">
                <span className="mini-label">{t('导航模式')}</span>
                <span className="mini-value">{customNav ? t('自定义') : t('自动')}</span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('Tab 数量')}</span>
                <span className="mini-value">{t('{count} 个', { count: navTabs.length })}</span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('页脚栏目')}</span>
                <span className="mini-value">
                  {t('{count} 栏', { count: layout.footer_columns.length })}
                </span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('条目总数')}</span>
                <span className="mini-value">
                  {t('{count} 条', {
                    count: layout.footer_columns.reduce((sum, column) => sum + column.links.length, 0),
                  })}
                </span>
              </div>
            </div>
            <div className="row gap-8 mt-16" style={{ flexWrap: 'wrap' }}>
              <Button variant="secondary" size="sm" icon="eye" onClick={() => window.open('/', '_blank')}>
                {t('预览站点')}
              </Button>
              <Link to="/admin/pages" className="btn btn-ghost btn-sm">
                {t('管理页面')}
              </Link>
            </div>
            <p className="tiny faint mt-12">
              {t('某个页面的标题会直接出现在 Tab 上；改标题就去页面里改，这里不用重复维护。')}
            </p>
          </div>
        </section>
      </aside>
    </div>
  );

  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('主题设置')}</h1>
          <p>
            {t(
              '套用、创建与导入主题在「选择主题」页；这里继续微调配色、字体、高级令牌与外观功能，并统一管理导航 Tab 与页脚。',
            )}
          </p>
        </div>
        <div className="admin-page-actions">
          <Link to="/admin/themes/choose" className="btn btn-secondary btn-sm">
            <Icon name="grid" size={14} /> {t('选择主题')}
          </Link>
          <Link to="/admin/theme" className="btn btn-primary btn-sm">
            <Icon name="layers" size={14} /> {t('页面编排')}
          </Link>
          <Button variant="secondary" size="sm" icon="eye" onClick={() => window.open('/', '_blank')}>
            {t('预览站点')}
          </Button>
        </div>
      </div>

      <div className="seg" role="group" aria-label={t('主题设置分区')}>
        <button
          type="button"
          className={tab === 'theme' ? 'is-on' : ''}
          onClick={() => selectTab('theme')}
          aria-pressed={tab === 'theme'}
        >
          {t('主题与版式')}
        </button>
        <button
          type="button"
          className={tab === 'chrome' ? 'is-on' : ''}
          onClick={() => selectTab('chrome')}
          aria-pressed={tab === 'chrome'}
        >
          {t('导航与页脚')}
        </button>
        <button
          type="button"
          className={tab === 'appearance' ? 'is-on' : ''}
          onClick={() => selectTab('appearance')}
          aria-pressed={tab === 'appearance'}
        >
          {t('外观')}
        </button>
        {themeHasSettings(selected) ? (
          <button
            type="button"
            className={tab === 'custom' ? 'is-on' : ''}
            onClick={() => selectTab('custom')}
            aria-pressed={tab === 'custom'}
          >
            {t('主题自定义')}
          </button>
        ) : null}
        <button
          type="button"
          className={tab === 'loading' ? 'is-on' : ''}
          onClick={() => selectTab('loading')}
          aria-pressed={tab === 'loading'}
        >
          {t('加载动画')}
        </button>
      </div>

      {tab === 'custom' && selected ? (
        <div className="mt-20">
          <ThemeCustomSettings theme={selected} />
        </div>
      ) : tab === 'appearance' ? (
        <div className="mt-20">
          <AppearancePage embedded />
        </div>
      ) : tab === 'loading' ? (
        <div className="mt-20">
          <LoadingPage embedded />
        </div>
      ) : tab === 'chrome' ? (
        <div className="mt-20">{renderChrome()}</div>
      ) : selected?.settings?.replace_default ? (
        <div className="mt-20">
          <Callout tone="info" icon="palette" title={t('当前主题使用自己的主题设置')}>
            {t('这套主题声明放弃内置的配色与排版微调，改用主题自己的设置字段；导航与页脚、外观和加载动画仍然可用。')}
          </Callout>
          <ThemeCustomSettings theme={selected} />
        </div>
      ) : (
      <div className="settings-grid no-side">
        <div className="editor-main">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('当前主题微调')}</h3>
                <p>
                  {t('微调会保留在「{name}」上并标记为已微调；重新点击主题卡片可恢复原定义。', {
                    name: currentName,
                  })}
                </p>
              </div>
              <div className="row gap-8">
                <Button variant="ghost" size="sm" icon="refresh" onClick={restoreCurrent}>
                  {restoreLabel}
                </Button>
                <Button variant="secondary" size="sm" icon="plus" onClick={openSave}>
                  {t('另存为主题')}
                </Button>
              </div>
            </div>
            <div className="panel-body">
              <div className="form-stack">
                <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() =>
                      setTheme(applyMode(currentTheme, currentTheme.mode === 'dark' ? 'light' : 'dark'))
                    }
                  >
                    <Icon name={currentTheme.mode === 'dark' ? 'sun' : 'moon'} size={14} />
                    {currentTheme.mode === 'dark' ? t('切到浅色') : t('切到深色')}
                  </button>
                  <Badge tone={modified ? 'warn' : 'muted'}>
                    {modified ? t('当前主题已有本地微调') : t('与主题定义一致')}
                  </Badge>
                </div>

                <div>
                  <p className="field-label mb-8">{t('配色')}</p>
                  <div className="color-row">
                    {(
                      [
                        { key: 'background' as const, label: t('背景') },
                        { key: 'ink' as const, label: t('文字') },
                        { key: 'accent' as const, label: t('强调色') },
                      ]
                    ).map((item) => (
                      <label key={item.key} className="color-field">
                        <span>{item.label}</span>
                        <input
                          type="color"
                          value={currentTheme[item.key]}
                          onChange={(event) => {
                            const value = event.target.value;
                            setTheme({ [item.key]: value, preset: 'custom' });
                          }}
                          aria-label={item.label}
                        />
                        <code>{currentTheme[item.key]}</code>
                      </label>
                    ))}
                  </div>
                  <p className="field-hint mt-8">
                    {t('背景与文字会推导出边框、弱化文字与分隔线；强调色用于链接、当前状态与进度条。')}
                  </p>
                </div>

                <div>
                  <p className="field-label mb-8">{t('标题字体')}</p>
                  <div className="option-grid two">
                    {(
                      [
                        { key: 'serif' as const, name: t('衬线'), note: t('书刊感更强，适合长文。') },
                        { key: 'sans' as const, name: t('无衬线'), note: t('更接近技术博客与产品文档。') },
                      ]
                    ).map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        className={`option${currentTheme.heading_font === item.key ? ' is-selected' : ''}`}
                        onClick={() => setTheme({ heading_font: item.key })}
                        aria-pressed={currentTheme.heading_font === item.key}
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

                <div className="form-grid">
                  <Field label={t('正文字号')} hint={t('只影响文章与自定义页面的正文。')}>
                    <div className="range-field">
                      <input
                        type="range"
                        min={14}
                        max={20}
                        step={0.5}
                        value={currentTheme.body_size}
                        onChange={(event) => setTheme({ body_size: Number(event.target.value) })}
                        aria-label={t('正文字号')}
                      />
                      <output>{currentTheme.body_size} px</output>
                    </div>
                  </Field>
                  <Field label={t('正文栏宽')} hint={t('太宽会降低长文的可读性。')}>
                    <div className="range-field">
                      <input
                        type="range"
                        min={840}
                        max={1120}
                        step={10}
                        value={currentTheme.content_width}
                        onChange={(event) => setTheme({ content_width: Number(event.target.value) })}
                        aria-label={t('正文栏宽')}
                      />
                      <output>{currentTheme.content_width} px</output>
                    </div>
                  </Field>
                  <Field label={t('圆角')} hint={t('按钮、卡片与输入框共用这套圆角。')}>
                    <div className="range-field">
                      <input
                        type="range"
                        min={0}
                        max={12}
                        step={1}
                        value={currentTheme.radius}
                        onChange={(event) => setTheme({ radius: Number(event.target.value) })}
                        aria-label={t('圆角')}
                      />
                      <output>{currentTheme.radius} px</output>
                    </div>
                  </Field>
                </div>

                <div className="soften-editor mt-20">
                  <div className="row" style={{ justifyContent: 'space-between', gap: 14 }}>
                    <div>
                      <strong>{t('柔化与过渡')}</strong>
                      <p className="field-hint" style={{ marginTop: 4 }}>
                        {t(
                          '在背景、页头、页脚与卡片之间加一层柔和过渡：不同颜色的组件不再硬切，背景可以带缓慢流动的光晕。只在站点前台生效。',
                        )}
                      </p>
                    </div>
                    <Toggle
                      checked={soften.enabled}
                      onChange={(enabled) => setTheme({ soften: { ...soften, enabled } })}
                      label={t('启用柔化')}
                    />
                  </div>
                  {soften.enabled ? (
                    <>
                      <div className="form-grid mt-12">
                        <Field label={t('柔化强度')} hint={t('越大，背景光晕与组件混色越明显。')}>
                          <div className="range-field">
                            <input
                              type="range"
                              min={0}
                              max={100}
                              step={5}
                              value={soften.strength}
                              onChange={(event) =>
                                setTheme({ soften: { ...soften, strength: Number(event.target.value) } })
                              }
                              aria-label={t('柔化强度')}
                            />
                            <output>{soften.strength}%</output>
                          </div>
                        </Field>
                        <Field label={t('过渡时长')} hint={t('颜色变化的速度；0 表示瞬间切换。')}>
                          <div className="range-field">
                            <input
                              type="range"
                              min={0}
                              max={1200}
                              step={20}
                              value={soften.transition_ms}
                              onChange={(event) =>
                                setTheme({
                                  soften: { ...soften, transition_ms: Number(event.target.value) },
                                })
                              }
                              aria-label={t('过渡时长')}
                            />
                            <output>{soften.transition_ms} ms</output>
                          </div>
                        </Field>
                        <Field label={t('页头模糊')} hint={t('给吸顶页头加一点毛玻璃。')}>
                          <div className="range-field">
                            <input
                              type="range"
                              min={0}
                              max={24}
                              step={1}
                              value={soften.blur}
                              onChange={(event) =>
                                setTheme({ soften: { ...soften, blur: Number(event.target.value) } })
                              }
                              aria-label={t('页头模糊')}
                            />
                            <output>{soften.blur} px</output>
                          </div>
                        </Field>
                      </div>
                      <div className="form-stack mt-12" style={{ gap: 2 }}>
                        <Toggle
                          checked={soften.gradient}
                          onChange={(gradient) => setTheme({ soften: { ...soften, gradient } })}
                          label={t('背景柔光渐变')}
                          description={t('从强调色与文字色引出两团很淡的光，减弱大块底色。')}
                        />
                        <Toggle
                          checked={soften.blend_components}
                          onChange={(blend_components) =>
                            setTheme({ soften: { ...soften, blend_components } })
                          }
                          label={t('组件颜色混色')}
                          description={t('页头、页脚、浮层与卡片混入少量主题色，边界不再生硬。')}
                        />
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          </section>

          {layout.variant === 'bento' ? (
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h3>{t('文章外观')}</h3>
                  <p>{t('夜航首页的文章卡有两种外观；只改展示，不改文章内容与排序。')}</p>
                </div>
                <Badge tone={articleStyle === 'blur' ? 'accent' : 'muted'}>
                  {articleStyle === 'blur' ? t('模糊背景') : t('封面在上')}
                </Badge>
              </div>
              <div className="panel-body">
                <div className="article-style-grid" role="radiogroup" aria-label={t('文章外观')}>
                  {articleStyleOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={articleStyle === option.id}
                      className={`article-style-card${articleStyle === option.id ? ' is-on' : ''}`}
                      onClick={() => setLayout({ article_card_style: option.id })}
                    >
                      <span className={`article-style-mock is-${option.id}`} aria-hidden>
                        <span className="article-style-mock-cover" />
                        <span className="article-style-mock-text">
                          <i />
                          <i />
                        </span>
                      </span>
                      <span className="article-style-copy">
                        <span>
                          <strong>{option.label}</strong>
                          <em>{option.note}</em>
                        </span>
                        <span className="article-style-dot" aria-hidden />
                      </span>
                    </button>
                  ))}
                </div>
                <p className="field-hint mt-12">
                  {t(
                    '作用于「文章卡网格」「文章列表」「精选文章」三个区块；「置顶文章 / 热门文章」网格本来就以封面铺底，保持原样。',
                  )}
                </p>
              </div>
            </section>
          ) : null}

          <details className="panel advanced-theme">
            <summary className="panel-head">
              <div>
                <h3>{t('高级主题令牌')}</h3>
                <p>{t('逐项覆盖页面底色、正文色、分隔线、强调色等变量；不展开也能正常使用。')}</p>
              </div>
              <span className="faint small">
                {currentTheme.tokens
                  ? t('{count} 项覆盖', { count: Object.keys(currentTheme.tokens).length })
                  : t('跟随主题')}
              </span>
            </summary>
            <div className="panel-body">
              <ThemeTokensPanel
                theme={currentTheme}
                onChange={(theme) => update({ theme })}
              />
            </div>
          </details>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('主题绑定的外观功能')}</h3>
                <p>
                  {t(
                    '勾选的分区会出现在「外观」页；取消勾选就从这个主题的外观设置里移除。 内置主题固定为全部开启，自定义主题可以自己决定。',
                  )}
                </p>
              </div>
              <Badge tone={selectedSections.length ? 'accent' : 'muted'}>
                {t('{count}/{total} 个分区', {
                  count: selectedSections.length,
                  total: APPEARANCE_SECTIONS.length,
                })}
              </Badge>
            </div>
            <div className="panel-body">
              <div className="appearance-bind-grid">
                {APPEARANCE_SECTIONS.map((section) => {
                  const on = selectedSections.includes(section.id);
                  return (
                    <label
                      key={section.id}
                      className={`appearance-bind${on ? ' is-on' : ''}${
                        selectedCustom ? '' : ' is-locked'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!selectedCustom}
                        onChange={() => toggleSection(section.id)}
                      />
                      <span>
                        <strong>{section.name}</strong>
                        <em>{section.note}</em>
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className="field-hint mt-12">
                {selectedCustom ? (
                  <>
                    {t(
                      '改动会立即写进「{name}」，并随主题一起导出。改动后外观页会重新排布； 如果某个分区被关掉，它在外观页就不再出现，已有文案也不会丢失。',
                      { name: selectedCustom.name },
                    )}
                  </>
                ) : (
                  <>
                    {t(
                      '当前是内置主题「{name}」，外观功能由代码定义。想要自定义分区， 可以先「另存为主题」或「创建主题」。',
                      { name: currentName },
                    )}
                  </>
                )}
              </p>
            </div>
          </section>
        </div>
      </div>
      )}

      <Modal
        open={saveOpen}
        title={t('把当前主题另存为自定义主题')}
        description={t('保存当前配色、排版与版式，之后可以在主题选择区一键套用。')}
        onClose={() => setSaveOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSaveOpen(false)}>
              {t('取消')}
            </Button>
            <Button onClick={saveAsCustom} icon="plus">
              {t('保存主题')}
            </Button>
          </>
        }
      >
        <div className="form-stack">
          {saveError ? <Callout tone="danger" icon="alert">{saveError}</Callout> : null}
          <Field label={t('主题名称')} htmlFor="theme-save-name" aside={`${saveName.length}/40`}>
            <Input
              id="theme-save-name"
              value={saveName}
              maxLength={40}
              onChange={(event) => setSaveName(event.target.value)}
              placeholder={t('例如：我的夜航')}
            />
          </Field>
          <Field
            label={t('备注')}
            htmlFor="theme-save-note"
            aside={`${saveNote.length}/160`}
            hint={t('可选，方便在主题库里认出它。')}
          >
            <Textarea
              id="theme-save-note"
              value={saveNote}
              maxLength={160}
              rows={2}
              onChange={(event) => setSaveNote(event.target.value)}
              placeholder={t('暖色双栏，适合摄影站。')}
            />
          </Field>
          <p className="field-hint">
            {t('当前主题：')}
            {currentName} · {variantLabel(customization.layout.variant)} ·{' '}
            {site?.name ?? t('当前站点')}
          </p>
        </div>
      </Modal>
    </RoleGate>
  );
}
