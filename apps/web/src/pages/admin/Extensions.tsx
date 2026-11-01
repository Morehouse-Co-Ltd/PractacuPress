import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  CustomExtension,
  ExtensionId,
  ExtensionPageScope,
  ExtensionSlot,
} from '../../types';
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

const PP_API_SAMPLE = [
  "const ctx = PP.getContext(); // { theme, page, title, extensionId }",
  "PP.setHeight(document.documentElement.scrollHeight);",
  "PP.notify('完成啦');            // 需要 notify 权限",
  "PP.open('https://example.com'); // 需要 open_link 权限",
  "PP.navigate('/about');          // 需要 navigate 权限",
  "PP.copy('要复制的文字');         // 需要 clipboard 权限",
  "PP.storage.get('count');        // 需要 storage 权限（同步返回）",
  "PP.storage.set('count', '1');   // 需要 storage 权限",
].join('\n');

const SLOT_DOCS: { slot: ExtensionSlot; where: string }[] = [
  { slot: 'site_header', where: '站点页头之后，每页都尝试挂载。' },
  { slot: 'site_footer', where: '站点页脚之前；没有页脚时退回 main 之后。' },
  { slot: 'home_top', where: '主页 main#main 的第一个子元素之前。' },
  { slot: 'home_bottom', where: '主页 main#main 的最后一个子元素之后。' },
  { slot: 'article_top', where: '文章封面之后；没有封面时在正文之前。' },
  { slot: 'article_bottom', where: '文章互动区之后；没有互动区时在评论区之前。' },
  { slot: 'article_side', where: '文章容器内、正文之后。' },
  { slot: 'floating', where: '不占文档流，固定在右下角（宽 min(360px, 92vw)）。' },
];

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
          {over ? ' · 超出上限，保存时会截断' : ''}
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
  useTitle('扩展');
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
    toast.push('ok', on ? '扩展已开启' : '扩展已关闭', meta?.name);
  };

  const setAllBuiltin = (on: boolean) => {
    const next = { ...builtin };
    for (const item of EXTENSIONS) next[item.id] = on;
    update({ extensions: next });
    toast.push('ok', on ? '已全部开启' : '已全部关闭');
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
    toast.push('ok', enabled ? '扩展已启用' : '扩展已停用', extension.name);
  };

  const [deleteTarget, setDeleteTarget] = useState<CustomExtension | null>(null);

  const confirmDelete = () => {
    if (!deleteTarget) return;
    setCustomExtensions(extensions.filter((item) => item.id !== deleteTarget.id));
    if (editingId === deleteTarget.id) resetToTemplate(EXTENSION_TEMPLATES[0].id);
    toast.push('ok', '扩展已删除', deleteTarget.name);
    setDeleteTarget(null);
  };

  const duplicateExtension = (extension: CustomExtension) => {
    if (extensions.length >= MAX_CUSTOM_EXTENSIONS) {
      toast.push('error', '扩展数量已达上限', `最多 ${MAX_CUSTOM_EXTENSIONS} 个，请先删除不用的扩展。`);
      return;
    }
    const copy = createExtension({
      ...extension,
      id: undefined,
      name: `${extension.name} 副本`,
      enabled: false,
    });
    setCustomExtensions([...extensions, copy]);
    toast.push('ok', '已复制扩展', copy.name);
  };

  const exportExtension = (extension: CustomExtension) => {
    downloadJson(extensionFileName(extension), buildExtensionFile(extension));
    toast.push('ok', '已导出扩展清单', extensionFileName(extension));
  };

  const exportAll = () => {
    if (!extensions.length) {
      toast.push('error', '还没有可导出的扩展');
      return;
    }
    const fileName = `practacu-extensions-${new Date().toISOString().slice(0, 10)}.json`;
    downloadJson(fileName, buildExtensionBundle(extensions));
    toast.push('ok', '已导出全部扩展', fileName);
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
      toast.push('error', '没有导入任何扩展', `最多 ${MAX_CUSTOM_EXTENSIONS} 个，请先删除不用的扩展。`);
      return;
    }
    setCustomExtensions(next);
    setImportText('');
    setImportError('');
    const detail = [
      replaced ? `覆盖 ${replaced} 个同 id 扩展` : '',
      dropped ? `因数量上限跳过 ${dropped} 个` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    toast.push('ok', `已导入 ${added + replaced} 个扩展`, detail || '可在卡片上打开开关启用。');
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      importExtensions(parseExtensionFileSafe(text, setImportError));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setImportError(message);
      toast.push('error', '导入扩展失败', message);
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
      toast.push('error', '导入扩展失败', message);
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
    toast.push('info', '已插入示例模板', template.name);
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
    toast.push('info', '已载入示例模板', '可以直接保存为新的扩展，或换成别的模板。');
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
      toast.push('error', '请先填写扩展名称');
      return;
    }
    const built = buildDraft({ ...draft, name });
    const index = extensions.findIndex((item) => item.id === built.id);
    if (index < 0 && extensions.length >= MAX_CUSTOM_EXTENSIONS) {
      toast.push('error', '扩展数量已达上限', `最多 ${MAX_CUSTOM_EXTENSIONS} 个，请先删除不用的扩展。`);
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
      index >= 0 ? '扩展已更新' : '已保存为我的扩展',
      truncated ? '内容超出上限，已按限制截断。' : built.enabled ? '' : '默认未启用，可在「我的扩展」打开开关。',
    );
  };

  const exportDraft = () => {
    const built = buildDraft(draft);
    downloadJson(extensionFileName(built), buildExtensionFile(built));
    toast.push('ok', '已导出草稿清单', extensionFileName(built));
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
    title: '一篇文章的标题',
    extensionId: previewDraft.id,
  };

  /* ---------------- 渲染 ---------------- */

  return (
    <RoleGate capability="manage_site" need="站点管理员">
      <div className="admin-page-head">
        <div>
          <h1>扩展</h1>
          <p>
            内置扩展是随前端发布的能力开关；创作者扩展是一份清单加 HTML / CSS / JS，导入后在本站前台
            的 sandbox iframe 里运行，可以随时启用、导出或删除。
          </p>
        </div>
        <div className="admin-page-actions">
          <Badge tone={builtinCount > 0 ? 'ok' : 'muted'}>内置 {builtinCount} / {EXTENSIONS.length}</Badge>
          <Badge tone={extensions.length ? 'accent' : 'muted'}>我的扩展 {extensions.length}</Badge>
          <Button variant="secondary" size="sm" icon="plus" onClick={startNew}>
            新建扩展
          </Button>
        </div>
      </div>

      <Tabs<ExtensionTab>
        value={tab}
        onChange={setTab}
        items={[
          { key: 'builtin', label: '内置扩展', count: builtinCount },
          { key: 'mine', label: '我的扩展', count: extensions.length },
          { key: 'studio', label: '扩展工坊' },
        ]}
      />

      {tab === 'builtin' ? (
        <div className="mt-20">
          <Callout tone="info" icon="shield" title="内置扩展与创作者扩展是两套机制">
            下面列出的是随前端发布、经过审查的内置能力，只改本站开关。创作者扩展在「我的扩展」里
            以 sandbox iframe 运行，不接触主站 DOM 与登录态，两者互不影响。
          </Callout>

          <div className="row gap-8 mt-16" style={{ justifyContent: 'flex-end' }}>
            <Button variant="secondary" size="sm" onClick={() => setAllBuiltin(true)}>
              全部开启
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAllBuiltin(false)}>
              全部关闭
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
                      去外观页填写公告内容 →
                    </Link>
                  ) : null}
                </section>
              );
            })}
          </div>

          <div className="panel mt-24">
            <div className="panel-head">
              <div>
                <h3>这些开关改变什么</h3>
                <p>内置扩展只作用于前台，不会修改已有内容，也不会请求新的接口。</p>
              </div>
            </div>
            <div className="panel-body">
              <div className="mini-list">
                <div className="mini-row">
                  <span className="mini-label">阅读进度与目录</span>
                  <span className="mini-value" style={{ color: 'var(--muted)', fontWeight: 400 }}>
                    文章页顶部进度线；二、三级标题自动生成锚点与目录。
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">代码与分享</span>
                  <span className="mini-value" style={{ color: 'var(--muted)', fontWeight: 400 }}>
                    代码块复制按钮；支持系统分享时调用 Web Share，否则复制链接。
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">公告与回到顶部</span>
                  <span className="mini-value" style={{ color: 'var(--muted)', fontWeight: 400 }}>
                    页头下方可关闭公告；滚动超过一屏后出现回到顶部按钮。
                  </span>
                </div>
              </div>
              <p className="tiny faint mt-16">
                内置扩展状态保存在本地安装配置，可以随「外观 → 导出配置」一起迁移。
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {tab === 'mine' ? (
        <div className="mt-20">
          <div className="row gap-8" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <p className="small muted" style={{ margin: 0 }}>
              启用后会出现在站点前台对应的槽位；清单保存在本地安装配置里，可随站点一起迁移。
            </p>
            <div className="row gap-8">
              <Button variant="secondary" size="sm" icon="upload" onClick={() => fileRef.current?.click()}>
                导入扩展
              </Button>
              <Button variant="secondary" size="sm" icon="download" onClick={exportAll} disabled={!extensions.length}>
                全部导出
              </Button>
            </div>
          </div>

          {importError ? (
            <Callout tone="danger" icon="alert" title="上次导入失败">
              {importError}
            </Callout>
          ) : null}

          <section className="panel mt-16">
            <div className="panel-head">
              <div>
                <h3>导入扩展</h3>
                <p>支持 `.ppext.json` 导出文件、单个裸清单或清单数组；同 id 会覆盖并提示。</p>
              </div>
              <Badge tone="muted">最多 {MAX_CUSTOM_EXTENSIONS} 个</Badge>
            </div>
            <div className="panel-body">
              <div className="ppe-import-grid">
                <div className="ppe-import-box">
                  <span className="ppe-import-icon">
                    <Icon name="upload" size={18} />
                  </span>
                  <strong>从文件导入</strong>
                  <p>选择导出的 `.ppext.json` 或 `.json` 清单文件。</p>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="application/json,.json,.ppext.json"
                    hidden
                    onChange={(event) => void pickFile(event.target.files?.[0])}
                  />
                  <Button variant="secondary" size="sm" icon="upload" onClick={() => fileRef.current?.click()}>
                    选择文件
                  </Button>
                </div>
                <div className="ppe-import-box">
                  <strong>粘贴 JSON</strong>
                  <Textarea
                    rows={4}
                    value={importText}
                    spellCheck={false}
                    placeholder={'{\n  "format": "practacu-extension",\n  "version": 1,\n  "extension": { "name": "我的扩展", ... }\n}'}
                    onChange={(event) => {
                      setImportText(event.target.value);
                      if (importError) setImportError('');
                    }}
                  />
                  <Button variant="primary" size="sm" icon="check" onClick={importPasted} disabled={!importText.trim()}>
                    导入 JSON
                  </Button>
                </div>
              </div>
              <div className="ppe-sample-row">
                <span className="ppe-sample-label">没有现成清单？</span>
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
                  导入全部示例
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
                    {extension.icon || Array.from(extension.name)[0] || '扩'}
                  </div>
                  <div className="ppe-card-main">
                    <div className="ppe-card-title">
                      <strong>{extension.name}</strong>
                      <span className="ppe-card-version">v{extension.version}</span>
                      {extension.enabled ? <Badge tone="ok" dot>已启用</Badge> : <Badge tone="muted">已停用</Badge>}
                    </div>
                    <p className="ppe-card-author">{extension.author}</p>
                    <p className="ppe-card-desc">{extension.description || '（还没有填写描述）'}</p>
                    <div className="ppe-card-tags">
                      <span className="ppe-tag-label">槽位</span>
                      {extension.slots.map((slot) => (
                        <span key={slot} className="ppe-tag">{slotLabel(slot)}</span>
                      ))}
                      <span className="ppe-tag-label">页面</span>
                      {extension.pages.map((page) => (
                        <span key={page} className="ppe-tag is-soft">{pageScopeLabel(page)}</span>
                      ))}
                      {extension.permissions.length ? (
                        <>
                          <span className="ppe-tag-label">权限</span>
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
                      aria-label={`${extension.enabled ? '停用' : '启用'} ${extension.name}`}
                      className={`switch${extension.enabled ? ' is-on' : ''}`}
                      onClick={() => toggleExtension(extension)}
                    >
                      <span />
                    </button>
                    <div className="ppe-card-actions">
                      <Button variant="ghost" size="sm" icon="edit" onClick={() => openInStudio(extension)}>
                        编辑
                      </Button>
                      <Button variant="ghost" size="sm" icon="copy" onClick={() => duplicateExtension(extension)}>
                        复制
                      </Button>
                      <Button variant="ghost" size="sm" icon="download" onClick={() => exportExtension(extension)}>
                        导出
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="trash"
                        className="ppe-danger-btn"
                        onClick={() => setDeleteTarget(extension)}
                      >
                        删除
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
                title="还没有创作者扩展"
                body="可以从示例开始，或者导入别人做好的清单。扩展保存后默认不启用，确认没问题再打开开关。"
                action={
                  <div className="row gap-8" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
                    <Button variant="primary" size="sm" icon="sparkle" onClick={importSamples}>
                      导入示例扩展（3 个）
                    </Button>
                    <Button variant="secondary" size="sm" icon="plus" onClick={startNew}>
                      去工坊做一个
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
              <strong>{editingId ? `编辑：${draft.name || '未命名扩展'}` : '新扩展'}</strong>
              <span className="tiny faint">
                {editingId ? '保存会覆盖「我的扩展」里的同一条清单。' : '保存后会出现在「我的扩展」，默认不启用。'}
              </span>
            </div>
            <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
              <div className="ppe-template-select">
                <Select value={templateId} onChange={(event) => applyTemplate(event.target.value)} aria-label="插入示例模板">
                  <option value="">插入示例模板…</option>
                  {EXTENSION_TEMPLATES.map((template) => (
                    <option key={template.id} value={template.id}>{template.name}</option>
                  ))}
                </Select>
              </div>
              <Button variant="ghost" size="sm" icon="refresh" onClick={() => resetToTemplate(EXTENSION_TEMPLATES[0].id)}>
                重置为示例
              </Button>
              <Button variant="secondary" size="sm" icon="download" onClick={exportDraft}>
                导出
              </Button>
              <Button variant="primary" size="sm" icon="check" onClick={saveDraft}>
                {editingId ? '更新' : '保存为我的扩展'}
              </Button>
            </div>
          </div>

          <div className="ppe-studio">
            <section className="panel ppe-studio-form">
              <div className="panel-head">
                <div>
                  <h3>扩展清单</h3>
                  <p>清单决定它出现在哪里、能做什么；内容与脚本在右侧沙箱里实时预览。</p>
                </div>
              </div>
              <div className="panel-body ppe-form-stack">
                <Field label="名称" hint={`最多 ${EXTENSION_LIMITS.name} 个字符。`}>
                  <Input
                    value={draft.name}
                    maxLength={EXTENSION_LIMITS.name}
                    placeholder="例如：文末作者卡"
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </Field>
                <div className="form-grid">
                  <Field label="版本" hint="自由填写，例如 1.0.0。">
                    <Input
                      value={draft.version}
                      maxLength={EXTENSION_LIMITS.version}
                      onChange={(event) => setDraft({ ...draft, version: event.target.value })}
                    />
                  </Field>
                  <Field label="作者">
                    <Input
                      value={draft.author}
                      maxLength={EXTENSION_LIMITS.author}
                      placeholder="署名"
                      onChange={(event) => setDraft({ ...draft, author: event.target.value })}
                    />
                  </Field>
                </div>
                <div className="form-grid">
                  <Field label="图标" hint="显示在卡片左侧的单字；留空取名称首字。">
                    <Input
                      value={draft.icon ?? ''}
                      maxLength={4}
                      placeholder="例：作"
                      onChange={(event) => setDraft({ ...draft, icon: event.target.value })}
                    />
                  </Field>
                  <Field label="说明">
                    <Input
                      value={draft.description}
                      maxLength={EXTENSION_LIMITS.description}
                      placeholder="一句话说明这个扩展做什么"
                      onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                    />
                  </Field>
                </div>

                <Field label="挂载位置" hint="至少选一个；全部不选会回退到「文章底部」。">
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

                <Field label="适用页面" hint="「全部页面」会忽略其它选项；登录页、自定义页只命中「全部页面」。">
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

                <Field label="申请权限" hint="没勾选的能力在沙箱桥里会被直接忽略。">
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
                  <p>它们只在这个扩展自己的 iframe 里执行，不接触主站 DOM。</p>
                </div>
              </div>
              <div className="panel-body ppe-code-stack">
                <CodeEditor
                  label="HTML"
                  hint="放进 iframe 的 body"
                  value={draft.html}
                  max={EXTENSION_LIMITS.html}
                  onChange={(html) => setDraft({ ...draft, html })}
                />
                <CodeEditor
                  label="CSS"
                  hint="自动注入，可用 --pp-bg / --pp-ink / --pp-accent"
                  value={draft.css}
                  max={EXTENSION_LIMITS.css}
                  onChange={(css) => setDraft({ ...draft, css })}
                />
                <CodeEditor
                  label="JS"
                  hint="可用 window.PP 桥读取上下文与上报高度"
                  value={draft.js}
                  max={EXTENSION_LIMITS.js}
                  onChange={(js) => setDraft({ ...draft, js })}
                />
              </div>
            </section>

            <aside className="panel ppe-studio-preview">
              <div className="panel-head">
                <div>
                  <h3>实时预览</h3>
                  <p>与前台相同的 sandbox iframe（allow-scripts，无同源权限）。</p>
                </div>
                {previewDraft.enabled ? <Badge tone="ok">前台启用中</Badge> : <Badge tone="muted">未启用</Badge>}
              </div>
              <div className="panel-body">
                <div
                  className="ppe-preview-stage"
                  style={{ background: customization.theme.background, color: customization.theme.ink }}
                >
                  <ExtensionHost extension={previewDraft} context={previewContext} preview maxHeight={480} />
                </div>
                <p className="tiny faint mt-12">
                  预览页类型：{pageScopeLabel(previewPage as ExtensionPageScope)}；标题使用占位内容。
                  扩展未启用时不会出现在前台，但这里始终可以预览。
                </p>
                <div className="mini-list mt-12">
                  <div className="mini-row">
                    <span className="mini-label">槽位</span>
                    <span className="mini-value">{draft.slots.map(slotLabel).join('、') || '（未选择）'}</span>
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

      {/* 扩展开发说明：槽位、权限、PP API 与安全边界。 */}
      <section className="panel mt-24 ppe-docs">
        <div className="panel-head">
          <div>
            <h3>扩展开发说明</h3>
            <p>写扩展前先看这一节：能挂在哪里、能申请哪些能力、沙箱里不能做什么。</p>
          </div>
        </div>
        <div className="panel-body">
          <div className="ppe-docs-grid">
            <div className="ppe-doc-block">
              <h4>槽位</h4>
              <div className="mini-list">
                {SLOT_DOCS.map((item) => (
                  <div className="mini-row" key={item.slot}>
                    <span className="mini-label">{slotLabel(item.slot)}</span>
                    <span className="mini-value ppe-doc-value">{item.where}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="ppe-doc-block">
              <h4>权限</h4>
              <p className="tiny muted">
                清单里声明后，沙箱桥才会把对应请求转给宿主；未声明的调用会被忽略。
              </p>
              <div className="mini-list">
                {EXTENSION_PERMISSIONS.map((permission) => (
                  <div className="mini-row" key={permission}>
                    <span className="mini-label mono">{permission}</span>
                    <span className="mini-value ppe-doc-value">{PERMISSION_HINTS[permission]}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="ppe-doc-block">
              <h4>PP API</h4>
              <p className="tiny muted">只暴露最小能力；`PP.getContext()` 读取主题、页面类型与标题。</p>
              <pre className="ppe-doc-code">{PP_API_SAMPLE}</pre>
              <p className="tiny faint">
                高度由扩展调用 `PP.setHeight(px)` 上报；不调用时桥会根据内容自动测量，上限 2000px。
              </p>
            </div>

            <div className="ppe-doc-block">
              <h4>安全边界</h4>
              <ul className="ppe-doc-list">
                <li>iframe 只有 `allow-scripts`，没有 `allow-same-origin`：拿不到主站 DOM、Cookie 与 localStorage。</li>
                <li>CSP 为 `default-src 'none'`：不能加载远程脚本，只允许内联样式 / 脚本、https 图片与 data 字体。</li>
                <li>打开链接只接受 http(s)；站内跳转只接受以 `/` 开头的路径；剪贴板、通知、存储都要声明权限。</li>
                <li>扩展存储按 id 隔离在 `pp.ext.&lt;id&gt;.*`，key 最长 64、单值最长 2000 字符。</li>
                <li>扩展只在站点前台运行，不会出现在管理后台（本页的工坊预览除外）。</li>
              </ul>
            </div>
          </div>
          <p className="tiny faint mt-16">
            扩展清单与外观配置保存在同一个本地安装文件里，可以随「外观 → 导出配置」迁移；
            导出单个扩展使用「我的扩展 → 导出」，文件名是 `&lt;名称&gt;.ppext.json`。
          </p>
        </div>
      </section>

      <Modal
        open={!!deleteTarget}
        title="删除扩展"
        description={deleteTarget ? `确定删除「${deleteTarget.name}」吗？` : undefined}
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="danger" icon="trash" onClick={confirmDelete}>
              删除
            </Button>
          </>
        }
      >
        <p className="small muted" style={{ lineHeight: 1.8 }}>
          删除后清单与 HTML / CSS / JS 都会从本地配置移除；已经导出的 `.ppext.json` 文件不受影响。
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
