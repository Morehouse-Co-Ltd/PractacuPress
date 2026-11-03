import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CustomExtension, ExtensionId } from '../../types';
import {
  EXTENSIONS,
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
  slotLabel,
} from '../../lib/extensions';
import {
  EXTENSION_TEMPLATES,
  createExtensionFromTemplate,
  extensionTemplateById,
} from '../../lib/extensionTemplates';
import { useT } from '../../lib/i18n';
import { useTitle } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { Badge, Button, Callout, EmptyState, Modal, Tabs, Textarea } from '../../components/ui';
import { Icon, type IconName } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';

const EXT_ICON: Record<ExtensionId, IconName> = {
  reading_progress: 'file',
  toc: 'list',
  code_copy: 'code',
  share: 'arrow-up-right',
  announcement: 'message',
  back_to_top: 'arrow-up',
};

type ExtensionTab = 'builtin' | 'mine';

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
        </div>
      </div>

      <Tabs<ExtensionTab>
        value={tab}
        onChange={setTab}
        items={[
          { key: 'builtin', label: t('内置扩展'), count: builtinCount },
          { key: 'mine', label: t('我的扩展'), count: extensions.length },
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
                  '可以从示例开始，或者导入别人做好的清单；导入后在卡片上启用、导出或删除。',
                )}
                action={
                  <div className="row gap-8" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
                    <Button variant="primary" size="sm" icon="sparkle" onClick={importSamples}>
                      {t('导入示例扩展（{count} 个）', { count: EXTENSION_TEMPLATES.length })}
                    </Button>
                  </div>
                }
              />
            </div>
          )}
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
