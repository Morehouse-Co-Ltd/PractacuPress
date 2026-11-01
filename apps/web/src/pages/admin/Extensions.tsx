import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CustomExtension, ExtensionId, ExtensionPageScope } from '../../types';
import {
  EXTENSIONS,
  EXTENSION_LIMITS,
  EXTENSION_PAGE_SCOPES,
  EXTENSION_PERMISSIONS,
  EXTENSION_SLOTS,
  MAX_CUSTOM_EXTENSIONS,
  useCustomization,
} from '../../lib/customize';
import {
  buildExtensionBundle,
  buildExtensionFile,
  createExtension,
  downloadJson,
  extensionFileName,
  pageScopeLabel,
  parseExtensionFile,
  permissionLabel,
  PERMISSION_HINTS,
  slotLabel,
  type ExtensionPageKind,
} from '../../lib/extensions';
import {
  EXTENSION_TEMPLATES,
  createExtensionFromTemplate,
  extensionTemplateById,
} from '../../lib/extensionTemplates';
import { useT } from '../../lib/i18n';
import { useTitle } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { Badge, Button, Callout, EmptyState, Field, Input, Modal, Select, Tabs, Textarea } from '../../components/ui';
import { Icon, type IconName } from '../../components/Icon';
import { ExtensionHost } from '../../components/ExtensionHost';
import { RoleGate } from '../../components/Guards';

const EXT_ICON: Record<ExtensionId, IconName> = {
  reading_progress: 'file',
  toc: 'list',
  code_copy: 'code',
  share: 'arrow-up-right',
  announcement: 'message',
  back_to_top: 'arrow-up',
};

type ExtensionTab = 'builtin' | 'mine' | 'studio';

/** 把草稿收敛成合法清单：名称必填，其余字段走 createExtension 的上限与去重。 */
function buildDraft(draft: CustomExtension): CustomExtension {
  return createExtension({ ...draft, name: draft.name.trim() || '未命名扩展' });
}

function toggleItem<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/** 工坊里的代码编辑框：等宽字体 + 字符计数，超限只提示，保存时再截断。 */
function CodeEditor({
  label,
  hint,
  value,
  max,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  max: number;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const over = value.length > max;
  return (
    <div className={`ppe-code${over ? ' is-over' : ''}`}>
      <div className="ppe-code-head">
        <span className="ppe-code-label">
          {label}
          <span className="ppe-code-hint">{hint}</span>
        </span>
        <span className={`ppe-char-count${over ? ' is-over' : ''}`}>
          {value.length.toLocaleString('zh-CN')} / {max.toLocaleString('zh-CN')}
          {over ? t(' · 超出上限，保存时会截断') : ''}
        </span>
      </div>
      <textarea
        className="ppe-code-area"
        value={value}
        spellCheck={false}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function ExtensionsPage() {
  const t = useT();
  useTitle(t('扩展'));
  const { customization, update } = useCustomization();
  const toast = useToast();
  const [tab, setTab] = useState<ExtensionTab>('builtin');
  const extensions = customization.custom_extensions;
  const builtin = customization.extensions;
  const builtinCount = EXTENSIONS.filter((item) => builtin[item.id]).length;

  /* ---------------- 内置扩展 ---------------- */

  const setBuiltinExtension = (id: ExtensionId, on: boolean) => {
    update({ extensions: { ...builtin, [id]: on } });
    const meta = EXTENSIONS.find((item) => item.id === id);
    toast.push('ok', on ? t('扩展已开启') : t('扩展已关闭'), meta?.name);
  };

  const setAllBuiltin = (on: boolean) => {
    const next = { ...builtin };
    for (const item of EXTENSIONS) next[item.id] = on;
    update({ extensions: next });
    toast.push('ok', on ? t('已全部开启') : t('已全部关闭'));
  };

  /* ---------------- 我的扩展：写入 / 启停 / 删除 ---------------- */

  const setCustomExtensions = (next: CustomExtension[]) => update({ custom_extensions: next });

  const toggleExtension = (extension: CustomExtension) => {
    const enabled = !extension.enabled;
    setCustomExtensions(
      extensions.map((item) =>
        item.id === extension.id ? { ...item, enabled, updated_at: new Date().toISOString() } : item,
      ),
    );
    toast.push('ok', enabled ? t('扩展已启用') : t('扩展已停用'), extension.name);
  };

  const [deleteTarget, setDeleteTarget] = useState<CustomExtension | null>(null);

  const confirmDelete = () => {
    if (!deleteTarget) return;
    setCustomExtensions(extensions.filter((item) => item.id !== deleteTarget.id));
    if (editingId === deleteTarget.id) resetToTemplate(EXTENSION_TEMPLATES[0].id);
    toast.push('ok', t('扩展已删除'), deleteTarget.name);
    setDeleteTarget(null);
  };

  const duplicateExtension = (extension: CustomExtension) => {
    if (extensions.length >= MAX_CUSTOM_EXTENSIONS) {
      toast.push(
        'error',
        t('扩展数量已达上限'),
        t('最多 {count} 个，请先删除不用的扩展。', { count: MAX_CUSTOM_EXTENSIONS }),
      );
      return;
    }
    const copy = createExtension({
      ...extension,
      id: undefined,
      name: `${extension.name} 副本`,
      enabled: false,
    });
    setCustomExtensions([...extensions, copy]);
    toast.push('ok', t('已复制扩展'), copy.name);
  };

  const exportExtension = (extension: CustomExtension) => {
    downloadJson(extensionFileName(extension), buildExtensionFile(extension));
    toast.push('ok', t('已导出扩展清单'), extensionFileName(extension));
  };

  const exportAll = () => {
    if (!extensions.length) {
      toast.push('error', t('还没有可导出的扩展'));
      return;
    }
    const fileName = `practacu-extensions-${new Date().toISOString().slice(0, 10)}.json`;
    downloadJson(fileName, buildExtensionBundle(extensions));
    toast.push('ok', t('已导出全部扩展'), fileName);
  };

  /* ---------------- 导入 ---------------- */

  const fileRef = useRef<HTMLInputElement>(null);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');

  const importExtensions = (incoming: CustomExtension[]) => {
    if (!incoming.length) return;
    const next = [...extensions];
    let added = 0;
    let replaced = 0;
    for (const extension of incoming) {
      const index = next.findIndex((item) => item.id === extension.id);
      if (index >= 0) {
        next[index] = extension;
        replaced += 1;
      } else if (next.length < MAX_CUSTOM_EXTENSIONS) {
        next.push(extension);
        added += 1;
      }
    }
    const dropped = incoming.length - added - replaced;
    if (!added && !replaced) {
      toast.push(
        'error',
        t('没有导入任何扩展'),
        t('最多 {count} 个，请先删除不用的扩展。', { count: MAX_CUSTOM_EXTENSIONS }),
      );
      return;
    }
    setCustomExtensions(next);
    setImportText('');
    setImportError('');
    const detail = [
      replaced ? t('覆盖 {count} 个同 id 扩展', { count: replaced }) : '',
      dropped ? t('因数量上限跳过 {count} 个', { count: dropped }) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    toast.push(
      'ok',
      t('已导入 {count} 个扩展', { count: added + replaced }),
      detail || t('可在卡片上打开开关启用。'),
    );
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      importExtensions(parseExtensionFileSafe(text, setImportError));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setImportError(message);
      toast.push('error', t('导入扩展失败'), message);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const importPasted = () => {
    try {
      const list = parseExtensionFileSafe(importText, setImportError);
      importExtensions(list);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setImportError(message);
      toast.push('error', t('导入扩展失败'), message);
    }
  };

  const importSamples = () => {
    const samples = EXTENSION_TEMPLATES.map((template) => ({
      ...createExtensionFromTemplate(template),
      enabled: true,
    }));
    importExtensions(samples);
  };

  const importSample = (templateId: string) => {
    const template = extensionTemplateById(templateId);
    if (!template) return;
    importExtensions([{ ...createExtensionFromTemplate(template), enabled: true }]);
  };

  /* ---------------- 扩展工坊 ---------------- */

  const [draft, setDraft] = useState<CustomExtension>(() =>
    createExtensionFromTemplate(EXTENSION_TEMPLATES[0]),
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState('');
  const [previewDraft, setPreviewDraft] = useState(draft);

  // 预览防抖：连续输入时不必每个按键都重载 iframe。
  useEffect(() => {
    const timer = window.setTimeout(() => setPreviewDraft(draft), 420);
    return () => window.clearTimeout(timer);
  }, [draft]);

  const applyTemplate = (templateIdValue: string) => {
    setTemplateId('');
    const template = extensionTemplateById(templateIdValue);
    if (!template) return;
    setDraft((prev) => ({
      ...prev,
      name: template.name,
      version: prev.version || '1.0.0',
      author: prev.author || 'Practacu Press',
      description: template.description,
      icon: template.icon,
      slots: [...template.slots],
      pages: [...template.pages],
      permissions: [...template.permissions],
      html: template.html,
      css: template.css,
      js: template.js,
    }));
    toast.push('info', t('已插入示例模板'), template.name);
  };

  const resetToTemplate = (templateIdValue: string) => {
    const template = extensionTemplateById(templateIdValue) ?? EXTENSION_TEMPLATES[0];
    const next = createExtensionFromTemplate(template);
    setDraft(next);
    setPreviewDraft(next);
    setEditingId(null);
    setTemplateId('');
    setTab('studio');
  };

  const startNew = () => {
    resetToTemplate(EXTENSION_TEMPLATES[0].id);
    toast.push('info', t('已载入示例模板'), t('可以直接保存为新的扩展，或换成别的模板。'));
  };

  const openInStudio = (extension: CustomExtension) => {
    setDraft(extension);
    setPreviewDraft(extension);
    setEditingId(extension.id);
    setTemplateId('');
    setTab('studio');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const saveDraft = () => {
    const name = draft.name.trim();
    if (!name) {
      toast.push('error', t('请先填写扩展名称'));
      return;
    }
    const built = buildDraft({ ...draft, name });
    const index = extensions.findIndex((item) => item.id === built.id);
    if (index < 0 && extensions.length >= MAX_CUSTOM_EXTENSIONS) {
      toast.push(
        'error',
        t('扩展数量已达上限'),
        t('最多 {count} 个，请先删除不用的扩展。', { count: MAX_CUSTOM_EXTENSIONS }),
      );
      return;
    }
    const next = index >= 0 ? extensions.map((item) => (item.id === built.id ? built : item)) : [...extensions, built];
    setCustomExtensions(next);
    setDraft(built);
    setEditingId(built.id);
    const truncated =
      built.html.length !== draft.html.length ||
      built.css.length !== draft.css.length ||
      built.js.length !== draft.js.length;
    toast.push(
      'ok',
      index >= 0 ? t('扩展已更新') : t('已保存为我的扩展'),
      truncated
        ? t('内容超出上限，已按限制截断。')
        : built.enabled
          ? ''
          : t('默认未启用，可在「我的扩展」打开开关。'),
    );
  };

  const exportDraft = () => {
    const built = buildDraft(draft);
    downloadJson(extensionFileName(built), buildExtensionFile(built));
    toast.push('ok', t('已导出草稿清单'), extensionFileName(built));
  };

  const previewPage: ExtensionPageKind =
    previewDraft.pages.includes('all') || previewDraft.pages.includes('article')
      ? 'article'
      : previewDraft.pages.includes('home')
        ? 'home'
        : previewDraft.pages.includes('search')
          ? 'search'
          : 'list';

  const previewContext = {
    theme: {
      background: customization.theme.background,
      ink: customization.theme.ink,
      accent: customization.theme.accent,
      font: customization.theme.heading_font,
    },
    page: previewPage,
    title: t('一篇文章的标题'),
    extensionId: previewDraft.id,
  };

  /* ---------------- 渲染 ---------------- */

  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('扩展')}</h1>
          <p>
            {t(
              '内置扩展是随前端发布的能力开关；创作者扩展是一份清单加 HTML / CSS / JS，导入后在本站前台的 sandbox iframe 里运行，可以随时启用、导出或删除。',
            )}
          </p>
        </div>
        <div className="admin-page-actions">
          <Badge tone={builtinCount > 0 ? 'ok' : 'muted'}>
            {t('内置 {on} / {total}', { on: builtinCount, total: EXTENSIONS.length })}
          </Badge>
          <Badge tone={extensions.length ? 'accent' : 'muted'}>
            {t('我的扩展 {count}', { count: extensions.length })}
          </Badge>
          <Button variant="secondary" size="sm" icon="plus" onClick={startNew}>
            {t('新建扩展')}
          </Button>
        </div>
      </div>

      <Tabs<ExtensionTab>
        value={tab}
        onChange={setTab}
        items={[
          { key: 'builtin', label: t('内置扩展'), count: builtinCount },
          { key: 'mine', label: t('我的扩展'), count: extensions.length },
          { key: 'studio', label: t('扩展工坊') },
        ]}
      />

      {tab === 'builtin' ? (
        <div className="mt-20">
          <Callout tone="info" icon="shield" title={t('内置扩展与创作者扩展是两套机制')}>
            {t(
              '下面列出的是随前端发布、经过审查的内置能力，只改本站开关。创作者扩展在「我的扩展」里以 sandbox iframe 运行，不接触主站 DOM 与登录态，两者互不影响。',
            )}
          </Callout>

          <div className="row gap-8 mt-16" style={{ justifyContent: 'flex-end' }}>
            <Button variant="secondary" size="sm" onClick={() => setAllBuiltin(true)}>
              {t('全部开启')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAllBuiltin(false)}>
              {t('全部关闭')}
            </Button>
          </div>

          <div className="extensions-grid mt-20">
            {EXTENSIONS.map((item) => {
              const on = builtin[item.id];
              return (
                <section key={item.id} className={`ext-card${on ? ' is-on' : ''}`}>
                  <div className="ext-head">
                    <span className="ext-icon">
                      <Icon name={EXT_ICON[item.id]} size={16} />
                    </span>
                    <div className="ext-body">
                      <strong>{item.name}</strong>
                      <p>{item.description}</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={on}
                      aria-label={item.name}
                      className={`switch${on ? ' is-on' : ''}`}
                      onClick={() => setBuiltinExtension(item.id, !on)}
                    >
                      <span />
                    </button>
                  </div>
                  <p className="ext-detail">{item.detail}</p>
                  {item.id === 'announcement' && on ? (
                    <Link to="/admin/appearance" className="tiny" style={{ color: 'var(--accent)' }}>
                      {t('去外观页填写公告内容 →')}
                    </Link>
                  ) : null}
                </section>
              );
            })}
          </div>
        </div>
      ) : null}

      {tab === 'mine' ? (
        <div className="mt-20">
          <div className="row gap-8" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <p className="small muted" style={{ margin: 0 }}>
              {t('启用后会出现在站点前台对应的槽位；清单保存在本地安装配置里，可随站点一起迁移。')}
            </p>
            <div className="row gap-8">
              <Button variant="secondary" size="sm" icon="upload" onClick={() => fileRef.current?.click()}>
                {t('导入扩展')}
              </Button>
              <Button variant="secondary" size="sm" icon="download" onClick={exportAll} disabled={!extensions.length}>
                {t('全部导出')}
              </Button>
            </div>
          </div>

          {importError ? (
            <Callout tone="danger" icon="alert" title={t('上次导入失败')}>
              {importError}
            </Callout>
          ) : null}

          <section className="panel mt-16">
            <div className="panel-head">
              <div>
                <h3>{t('导入扩展')}</h3>
                <p>{t('支持 `.ppext.json` 导出文件、单个裸清单或清单数组；同 id 会覆盖并提示。')}</p>
              </div>
              <Badge tone="muted">{t('最多 {count} 个', { count: MAX_CUSTOM_EXTENSIONS })}</Badge>
            </div>
            <div className="panel-body">
              <div className="ppe-import-grid">
                <div className="ppe-import-box">
                  <span className="ppe-import-icon">
                    <Icon name="upload" size={18} />
                  </span>
                  <strong>{t('从文件导入')}</strong>
                  <p>{t('选择导出的 `.ppext.json` 或 `.json` 清单文件。')}</p>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="application/json,.json,.ppext.json"
                    hidden
                    onChange={(event) => void pickFile(event.target.files?.[0])}
                  />
                  <Button variant="secondary" size="sm" icon="upload" onClick={() => fileRef.current?.click()}>
                    {t('选择文件')}
                  </Button>
                </div>
                <div className="ppe-import-box">
                  <strong>{t('粘贴 JSON')}</strong>
                  <Textarea
                    rows={4}
                    value={importText}
                    spellCheck={false}
                    placeholder={t(
                      '{\n  "format": "practacu-extension",\n  "version": 1,\n  "extension": { "name": "我的扩展", ... }\n}',
                    )}
                    onChange={(event) => {
                      setImportText(event.target.value);
                      if (importError) setImportError('');
                    }}
                  />
                  <Button variant="primary" size="sm" icon="check" onClick={importPasted} disabled={!importText.trim()}>
                    {t('导入 JSON')}
                  </Button>
                </div>
              </div>
              <div className="ppe-sample-row">
                <span className="ppe-sample-label">{t('没有现成清单？')}</span>
                {EXTENSION_TEMPLATES.map((template) => (
                  <Button
                    key={template.id}
                    variant="ghost"
                    size="sm"
                    icon="sparkle"
                    onClick={() => importSample(template.id)}
                  >
                    {template.name}
                  </Button>
                ))}
                <Button variant="quiet" size="sm" onClick={importSamples}>
                  {t('导入全部示例')}
                </Button>
              </div>
            </div>
          </section>

          {extensions.length ? (
            <div className="ppe-card-list mt-16">
              {extensions.map((extension) => (
                <article
                  key={extension.id}
                  className={`ppe-card${extension.enabled ? ' is-on' : ''}`}
                  data-pp-extension-id={extension.id}
                >
                  <div className="ppe-card-icon" aria-hidden="true">
                    {extension.icon || Array.from(extension.name)[0] || t('扩')}
                  </div>
                  <div className="ppe-card-main">
                    <div className="ppe-card-title">
                      <strong>{extension.name}</strong>
                      <span className="ppe-card-version">v{extension.version}</span>
                      {extension.enabled ? (
                        <Badge tone="ok" dot>
                          {t('已启用')}
                        </Badge>
                      ) : (
                        <Badge tone="muted">{t('已停用')}</Badge>
                      )}
                    </div>
                    <p className="ppe-card-author">{extension.author}</p>
                    <p className="ppe-card-desc">{extension.description || t('（还没有填写描述）')}</p>
                    <div className="ppe-card-tags">
                      <span className="ppe-tag-label">{t('槽位')}</span>
                      {extension.slots.map((slot) => (
                        <span key={slot} className="ppe-tag">{slotLabel(slot)}</span>
                      ))}
                      <span className="ppe-tag-label">{t('页面')}</span>
                      {extension.pages.map((page) => (
                        <span key={page} className="ppe-tag is-soft">{pageScopeLabel(page)}</span>
                      ))}
                      {extension.permissions.length ? (
                        <>
                          <span className="ppe-tag-label">{t('权限')}</span>
                          {extension.permissions.map((permission) => (
                            <span key={permission} className="ppe-tag is-quiet">{permissionLabel(permission)}</span>
                          ))}
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="ppe-card-side">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={extension.enabled}
                      aria-label={t('{action} {name}', {
                        action: extension.enabled ? t('停用') : t('启用'),
                        name: extension.name,
                      })}
                      className={`switch${extension.enabled ? ' is-on' : ''}`}
                      onClick={() => toggleExtension(extension)}
                    >
                      <span />
                    </button>
                    <div className="ppe-card-actions">
                      <Button variant="ghost" size="sm" icon="edit" onClick={() => openInStudio(extension)}>
                        {t('编辑')}
                      </Button>
                      <Button variant="ghost" size="sm" icon="copy" onClick={() => duplicateExtension(extension)}>
                        {t('复制')}
                      </Button>
                      <Button variant="ghost" size="sm" icon="download" onClick={() => exportExtension(extension)}>
                        {t('导出')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="trash"
                        className="ppe-danger-btn"
                        onClick={() => setDeleteTarget(extension)}
                      >
                        {t('删除')}
                      </Button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="mt-16">
              <EmptyState
                icon="sparkle"
                title={t('还没有创作者扩展')}
                body={t(
                  '可以从示例开始，或者导入别人做好的清单。扩展保存后默认不启用，确认没问题再打开开关。',
                )}
                action={
                  <div className="row gap-8" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
                    <Button variant="primary" size="sm" icon="sparkle" onClick={importSamples}>
                      {t('导入示例扩展（{count} 个）', { count: EXTENSION_TEMPLATES.length })}
                    </Button>
                    <Button variant="secondary" size="sm" icon="plus" onClick={startNew}>
                      {t('去工坊做一个')}
                    </Button>
                  </div>
                }
              />
            </div>
          )}
        </div>
      ) : null}

      {tab === 'studio' ? (
        <div className="mt-20">
          <div className="ppe-studio-bar">
            <div>
              <strong>
                {editingId
                  ? t('编辑：{name}', { name: draft.name || t('未命名扩展') })
                  : t('新扩展')}
              </strong>
              <span className="tiny faint">
                {editingId
                  ? t('保存会覆盖「我的扩展」里的同一条清单。')
                  : t('保存后会出现在「我的扩展」，默认不启用。')}
              </span>
            </div>
            <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
              <div className="ppe-template-select">
                <Select
                  value={templateId}
                  onChange={(event) => applyTemplate(event.target.value)}
                  aria-label={t('插入示例模板')}
                >
                  <option value="">{t('插入示例模板…')}</option>
                  {EXTENSION_TEMPLATES.map((template) => (
                    <option key={template.id} value={template.id}>{template.name}</option>
                  ))}
                </Select>
              </div>
              <Button variant="ghost" size="sm" icon="refresh" onClick={() => resetToTemplate(EXTENSION_TEMPLATES[0].id)}>
                {t('重置为示例')}
              </Button>
              <Button variant="secondary" size="sm" icon="download" onClick={exportDraft}>
                {t('导出')}
              </Button>
              <Button variant="primary" size="sm" icon="check" onClick={saveDraft}>
                {editingId ? t('更新') : t('保存为我的扩展')}
              </Button>
            </div>
          </div>

          <div className="ppe-studio">
            <section className="panel ppe-studio-form">
              <div className="panel-head">
                <div>
                  <h3>{t('扩展清单')}</h3>
                  <p>{t('清单决定它出现在哪里、能做什么；内容与脚本在右侧沙箱里实时预览。')}</p>
                </div>
              </div>
              <div className="panel-body ppe-form-stack">
                <Field label={t('名称')} hint={t('最多 {count} 个字符。', { count: EXTENSION_LIMITS.name })}>
                  <Input
                    value={draft.name}
                    maxLength={EXTENSION_LIMITS.name}
                    placeholder={t('例如：文末作者卡')}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </Field>
                <div className="form-grid">
                  <Field label={t('版本')} hint={t('自由填写，例如 1.0.0。')}>
                    <Input
                      value={draft.version}
                      maxLength={EXTENSION_LIMITS.version}
                      onChange={(event) => setDraft({ ...draft, version: event.target.value })}
                    />
                  </Field>
                  <Field label={t('作者')}>
                    <Input
                      value={draft.author}
                      maxLength={EXTENSION_LIMITS.author}
                      placeholder={t('署名')}
                      onChange={(event) => setDraft({ ...draft, author: event.target.value })}
                    />
                  </Field>
                </div>
                <div className="form-grid">
                  <Field label={t('图标')} hint={t('显示在卡片左侧的单字；留空取名称首字。')}>
                    <Input
                      value={draft.icon ?? ''}
                      maxLength={4}
                      placeholder={t('例：作')}
                      onChange={(event) => setDraft({ ...draft, icon: event.target.value })}
                    />
                  </Field>
                  <Field label={t('说明')}>
                    <Input
                      value={draft.description}
                      maxLength={EXTENSION_LIMITS.description}
                      placeholder={t('一句话说明这个扩展做什么')}
                      onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                    />
                  </Field>
                </div>

                <Field label={t('挂载位置')} hint={t('至少选一个；全部不选会回退到「文章底部」。')}>
                  <div className="ppe-check-grid">
                    {EXTENSION_SLOTS.map((slot) => (
                      <label key={slot} className="checkline">
                        <input
                          type="checkbox"
                          checked={draft.slots.includes(slot)}
                          onChange={() => setDraft({ ...draft, slots: toggleItem(draft.slots, slot) })}
                        />
                        <span>{slotLabel(slot)}</span>
                      </label>
                    ))}
                  </div>
                </Field>

                <Field
                  label={t('适用页面')}
                  hint={t('「全部页面」会忽略其它选项；登录页、自定义页只命中「全部页面」。')}
                >
                  <div className="ppe-check-grid">
                    {EXTENSION_PAGE_SCOPES.map((page) => (
                      <label key={page} className="checkline">
                        <input
                          type="checkbox"
                          checked={draft.pages.includes(page)}
                          onChange={() => setDraft({ ...draft, pages: toggleItem(draft.pages, page) })}
                        />
                        <span>{pageScopeLabel(page)}</span>
                      </label>
                    ))}
                  </div>
                </Field>

                <Field label={t('申请权限')} hint={t('没勾选的能力在沙箱桥里会被直接忽略。')}>
                  <div className="ppe-permission-list">
                    {EXTENSION_PERMISSIONS.map((permission) => (
                      <label key={permission} className="checkline ppe-permission-row">
                        <input
                          type="checkbox"
                          checked={draft.permissions.includes(permission)}
                          onChange={() =>
                            setDraft({ ...draft, permissions: toggleItem(draft.permissions, permission) })
                          }
                        />
                        <span>
                          <strong>{permissionLabel(permission)}</strong>
                          <span className="ppe-permission-hint">{PERMISSION_HINTS[permission]}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </Field>
              </div>
            </section>

            <section className="panel ppe-studio-code">
              <div className="panel-head">
                <div>
                  <h3>HTML / CSS / JS</h3>
                  <p>{t('它们只在这个扩展自己的 iframe 里执行，不接触主站 DOM。')}</p>
                </div>
              </div>
              <div className="panel-body ppe-code-stack">
                <CodeEditor
                  label="HTML"
                  hint={t('放进 iframe 的 body')}
                  value={draft.html}
                  max={EXTENSION_LIMITS.html}
                  onChange={(html) => setDraft({ ...draft, html })}
                />
                <CodeEditor
                  label="CSS"
                  hint={t('自动注入，可用 --pp-bg / --pp-ink / --pp-accent')}
                  value={draft.css}
                  max={EXTENSION_LIMITS.css}
                  onChange={(css) => setDraft({ ...draft, css })}
                />
                <CodeEditor
                  label="JS"
                  hint={t('可用 window.PP 桥读取上下文与上报高度')}
                  value={draft.js}
                  max={EXTENSION_LIMITS.js}
                  onChange={(js) => setDraft({ ...draft, js })}
                />
              </div>
            </section>

            <aside className="panel ppe-studio-preview">
              <div className="panel-head">
                <div>
                  <h3>{t('实时预览')}</h3>
                  <p>{t('与前台相同的 sandbox iframe（allow-scripts，无同源权限）。')}</p>
                </div>
                {previewDraft.enabled ? (
                  <Badge tone="ok">{t('前台启用中')}</Badge>
                ) : (
                  <Badge tone="muted">{t('未启用')}</Badge>
                )}
              </div>
              <div className="panel-body">
                <div
                  className="ppe-preview-stage"
                  style={{ background: customization.theme.background, color: customization.theme.ink }}
                >
                  <ExtensionHost extension={previewDraft} context={previewContext} preview maxHeight={480} />
                </div>
                <p className="tiny faint mt-12">
                  {t('预览页类型：{page}；标题使用占位内容。扩展未启用时不会出现在前台，但这里始终可以预览。', {
                    page: pageScopeLabel(previewPage as ExtensionPageScope),
                  })}
                </p>
                <div className="mini-list mt-12">
                  <div className="mini-row">
                    <span className="mini-label">{t('槽位')}</span>
                    <span className="mini-value">
                      {draft.slots.map(slotLabel).join(t('、')) || t('（未选择）')}
                    </span>
                  </div>
                  <div className="mini-row">
                    <span className="mini-label">HTML / CSS / JS</span>
                    <span className="mini-value">
                      {draft.html.length.toLocaleString('zh-CN')} / {draft.css.length.toLocaleString('zh-CN')} /{' '}
                      {draft.js.length.toLocaleString('zh-CN')}
                    </span>
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </div>
      ) : null}

      <Modal
        open={!!deleteTarget}
        title={t('删除扩展')}
        description={
          deleteTarget ? t('确定删除「{name}」吗？', { name: deleteTarget.name }) : undefined
        }
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              {t('取消')}
            </Button>
            <Button variant="danger" icon="trash" onClick={confirmDelete}>
              {t('删除')}
            </Button>
          </>
        }
      >
        <p className="small muted" style={{ lineHeight: 1.8 }}>
          {t('删除后清单与 HTML / CSS / JS 都会从本地配置移除；已经导出的 `.ppext.json` 文件不受影响。')}
        </p>
      </Modal>
    </RoleGate>
  );
}

/**
 * parseExtensionFile 的包装：把错误同时写到导入区提示里。
 *
 * 文件导入与粘贴导入共用同一套错误展示；调用方负责 toast。
 */
function parseExtensionFileSafe(
  text: string,
  setError: (value: string) => void,
): CustomExtension[] {
  try {
    return parseExtensionFile(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setError(message);
    throw error;
  }
}
