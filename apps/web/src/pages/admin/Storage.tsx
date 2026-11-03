import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { StorageScope, StorageSettings, StorageStrategy } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import {
  DEFAULT_LOCAL_DIR,
  MAX_STRATEGIES,
  MAX_STRATEGY_NAME,
  STORAGE_SCOPES,
  buildStorageEnvSnippet,
  createStrategyId,
  defaultStorage,
  emptyStrategy,
  findStrategy,
  globalStrategyOf,
  normalizeStorage,
  normalizeStrategy,
  readStorage,
  scopeLabel,
  storageDriverLabel,
  storageUrlError,
  strategyLocation,
  usedStrategies,
} from '../../lib/storage';
import { useTitle } from '../../lib/hooks';
import { noteActivity } from '../../lib/activity';
import { useToast } from '../../lib/toast';
import { useT } from '../../lib/i18n';
import {
  Badge,
  Button,
  Callout,
  CopyButton,
  Field,
  Input,
  Modal,
  Select,
  Tabs,
  cx,
} from '../../components/ui';
import { Icon, type IconName } from '../../components/Icon';
import { NumberField } from '../../components/NumberField';
import { RoleGate } from '../../components/Guards';

/** 用途固定顺序与图标；文案在组件里按当前语言取。 */
const SCOPE_META: {
  scope: StorageScope;
  icon: IconName;
}[] = [
  {
    scope: 'content',
    icon: 'file',
  },
  {
    scope: 'site',
    icon: 'image',
  },
  {
    scope: 'avatar',
    icon: 'user',
  },
  {
    scope: 'attachment',
    icon: 'upload',
  },
];

/** 正在编辑的策略：新建时没有 id，编辑时用已有 id。 */
type EditorState = { mode: 'create' } | { mode: 'edit'; id: string };

export function StoragePage() {
  const t = useT();
  useTitle(t('储存策略'));
  const { config, site, me, updateConfig } = useAuth();
  const backend = useBackend();
  const toast = useToast();
  const saved = useMemo(() => readStorage(config), [config]);
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState<StorageSettings>(() => saved);
  // 密钥只留在组件状态里，用于生成 .env 片段；刷新页面后就没了。
  const [secret, setSecret] = useState('');
  const [editing, setEditing] = useState<EditorState | null>(null);
  const [form, setForm] = useState<StorageStrategy>(() => emptyStrategy());
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<StorageStrategy | null>(null);
  const dirty = JSON.stringify(draft) !== savedKey;

  const driverItems = [
    { key: 'local' as const, label: t('本地储存') },
    { key: 's3' as const, label: t('云对象存储') },
  ];

  const scopeDescription: Record<StorageScope, string> = {
    content: t('文章与帖子里插入的图片、封面等；正文本身不在媒体存储里。'),
    site: t('站点图标、分享图与首页编排引用的站点级图片。'),
    avatar: t('成员头像；访问频繁、体积小，可以单独放本地或 CDN 桶。'),
    attachment: t('用户上传的附件与私有数据，通常需要鉴权后才能访问。'),
  };

  useEffect(() => {
    setDraft(readStorage(config));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const snippet = buildStorageEnvSnippet(saved, secret);
  const draftGlobal = globalStrategyOf(draft);
  const draftCloud = usedStrategies(draft).some((strategy) => strategy.driver === 's3');
  const savedCloud = saved.strategies.some((strategy) => strategy.driver === 's3');
  const deleteFallback = deleteTarget
    ? draft.strategies.find((strategy) => strategy.id !== deleteTarget.id)
    : undefined;
  const deleteScopes = deleteTarget
    ? STORAGE_SCOPES.filter((scope) => draft.scopes[scope] === deleteTarget.id)
    : [];

  const openCreate = () => {
    if (draft.strategies.length >= MAX_STRATEGIES) {
      toast.push(
        'error',
        t('最多只能有 {max} 套储存策略', { max: MAX_STRATEGIES }),
        t('先删掉一套不再使用的策略，再新建。'),
      );
      return;
    }
    setForm(emptyStrategy());
    setFormErrors({});
    setEditing({ mode: 'create' });
  };

  const openEdit = (strategy: StorageStrategy) => {
    setForm({ ...strategy });
    setFormErrors({});
    setEditing({ mode: 'edit', id: strategy.id });
  };

  /** 弹窗内校验；返回空对象表示通过。 */
  const validateForm = (value: StorageStrategy): Record<string, string> => {
    const errors: Record<string, string> = {};
    const name = value.name.trim();
    const editingId = editing?.mode === 'edit' ? editing.id : null;
    if (!name) {
      errors.name = t('名称不能为空。');
    } else if (Array.from(name).length > MAX_STRATEGY_NAME) {
      errors.name = t('名称最多 {max} 个字符。', { max: MAX_STRATEGY_NAME });
    } else if (
      draft.strategies.some(
        (strategy) => strategy.id !== editingId && strategy.name.trim() === name,
      )
    ) {
      errors.name = t('已经有一套同名策略了。');
    }
    if (value.driver === 's3' && !value.s3_bucket.trim()) {
      errors.bucket = t('云对象存储必须有桶名。');
    }
    const endpointError = storageUrlError(value.s3_endpoint);
    if (endpointError) errors.endpoint = endpointError;
    const publicError = storageUrlError(value.s3_public_base_url);
    if (publicError) errors.publicUrl = publicError;
    return errors;
  };

  const submitForm = () => {
    const errors = validateForm(form);
    if (Object.keys(errors).length) {
      setFormErrors(errors);
      toast.push('error', t('这套储存策略还不能保存'), t('请先修正弹窗里标红的字段。'));
      return;
    }
    const id = editing?.mode === 'edit' ? editing.id : createStrategyId(draft.strategies);
    const strategy = normalizeStrategy(form, id);
    setDraft((prev) => ({
      ...prev,
      strategies: prev.strategies.some((item) => item.id === strategy.id)
        ? prev.strategies.map((item) => (item.id === strategy.id ? strategy : item))
        : [...prev.strategies, strategy],
    }));
    setEditing(null);
    toast.push(
      'ok',
      t('已更新储存策略'),
      t('点右上角「保存修改」写入这台电脑的本地安装配置；部署片段也会随之更新。'),
    );
  };

  const confirmDelete = () => {
    const target = deleteTarget;
    if (!target) return;
    const remaining = draft.strategies.filter((strategy) => strategy.id !== target.id);
    // 至少保留一套：只剩一套时删除按钮本来就是禁用的，这里再兜一次底。
    if (!remaining.length) return;
    const scopes = { ...draft.scopes };
    for (const scope of STORAGE_SCOPES) {
      if (scopes[scope] === target.id) scopes[scope] = remaining[0].id;
    }
    setDraft({ ...draft, strategies: remaining, scopes });
    setDeleteTarget(null);
    toast.push(
      'ok',
      t('已删除储存策略「{name}」', { name: target.name }),
      t('引用它的用途已经回落到第一套策略，点「保存修改」后生效；不会删除任何文件。'),
    );
  };

  const save = () => {
    const next = normalizeStorage(draft);
    for (const strategy of next.strategies) {
      if (strategy.driver === 's3' && !strategy.s3_bucket) {
        toast.push(
          'error',
          t('云策略「{name}」缺少桶名', { name: strategy.name }),
          t('STORAGE_DRIVER=s3 时桶名必填，API 启动会直接拒绝这组环境变量。'),
        );
        return;
      }
      const endpointError = storageUrlError(strategy.s3_endpoint);
      if (endpointError) {
        toast.push(
          'error',
          t('Endpoint 格式不对'),
          t('策略「{name}」的 Endpoint {error}', { name: strategy.name, error: endpointError }),
        );
        return;
      }
      const publicError = storageUrlError(strategy.s3_public_base_url);
      if (publicError) {
        toast.push(
          'error',
          t('公开访问地址格式不对'),
          t('策略「{name}」的公开访问地址{error}', {
            name: strategy.name,
            error: publicError,
          }),
        );
        return;
      }
    }
    updateConfig({ storage: next });
    setDraft(next);
    toast.push(
      'ok',
      t('储存策略已保存'),
      t('已写入这台电脑的本地安装配置；把下方片段写进服务器 .env 并重启 API 之后，新的上传才会写到目标位置。'),
    );
    if (me) {
      noteActivity(
        backend,
        me.user.display_name,
        '修改储存策略',
        site?.name ?? '站点',
        `${next.strategies.length} 套策略 · 全局「${globalStrategyOf(next).name}」`,
      );
    }
  };

  const reset = () => {
    const next = defaultStorage();
    updateConfig({ storage: next });
    setDraft(next);
    setSecret('');
    toast.push(
      'ok',
      t('已恢复默认储存策略'),
      t('回到一套「本地储存」（./data/media），四个用途都指向它；不会删除任何文件，也不会修改服务器的 .env。'),
    );
  };

  const patchScope = (scope: StorageScope, id: string) => {
    setDraft({ ...draft, scopes: { ...draft.scopes, [scope]: id } });
  };

  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('储存策略')}</h1>
          <p>
            {t('决定上传的图片与附件写到哪里：先建一套或几套储存策略（本地目录或 S3 兼容的云对象存储），')}{' '}
            {t('再让每个用途各选一套。浏览器只能保存部署意图，真正生效要靠服务器上的')}{' '}
            <code className="mono">.env</code> {t('与重启 API。')}
          </p>
        </div>
        <div className="admin-page-actions">
          <Link to="/admin/media" className="btn btn-ghost btn-sm">
            <Icon name="image" size={14} /> {t('媒体库')}
          </Link>
          <Button size="sm" disabled={!dirty} onClick={save} icon="check">
            {t('保存修改')}
          </Button>
        </div>
      </div>

      <Callout tone="info" icon="database" title={t('保存只是写配置，部署才算切换')}>
        {t('本页只写入这台电脑的本地安装配置，并把选择翻译成可粘贴的 API')}{' '}
        <code className="mono">.env</code> {t('片段；服务器需要把片段写进')}{' '}
        <code className="mono">.env</code> {t('并重启 API 才生效。演示模式与真实后端行为一致：')}{' '}
        {t('都可以保存与生成片段，但演示模式没有真正的服务端进程可重启。')}
      </Callout>

      <div className="settings-grid mt-20">
        <div className="editor-main">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('储存策略')}</h3>
                <p>
                  {t('每套策略就是一个存储目标；被最多用途使用的那套会写成 .env 的全局 STORAGE_DRIVER，')}
                  {t('其余用途只写自己的覆盖变量。')}
                </p>
              </div>
              <div className="storage-panel-actions">
                <Badge tone={draft.strategies.length > 1 ? 'accent' : 'muted'}>
                  {t('{count} 套', { count: draft.strategies.length })}
                </Badge>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="plus"
                  onClick={openCreate}
                  disabled={draft.strategies.length >= MAX_STRATEGIES}
                >
                  {t('新建储存策略')}
                </Button>
              </div>
            </div>
            <div className="panel-body">
              <div className="storage-strategy-list">
                {draft.strategies.map((strategy) => {
                  const usedBy = STORAGE_SCOPES.filter(
                    (scope) => draft.scopes[scope] === strategy.id,
                  );
                  return (
                    <div
                      key={strategy.id}
                      className={cx(
                        'storage-strategy',
                        draftGlobal.id === strategy.id && 'is-global',
                      )}
                    >
                      <span
                        className={cx(
                          'storage-strategy-icon',
                          strategy.driver === 's3' ? 'is-cloud' : 'is-local',
                        )}
                      >
                        <Icon name={strategy.driver === 's3' ? 'globe' : 'server'} size={16} />
                      </span>
                      <div className="storage-strategy-body">
                        <div className="storage-strategy-title">
                          <strong>{strategy.name}</strong>
                          <Badge tone={strategy.driver === 's3' ? 'accent' : 'neutral'}>
                            {storageDriverLabel(strategy.driver)}
                          </Badge>
                          {draftGlobal.id === strategy.id ? (
                            <Badge tone="ok">{t('全局')}</Badge>
                          ) : null}
                        </div>
                        <p className="storage-strategy-path mono">{strategyLocation(strategy)}</p>
                        {strategy.driver === 's3' && strategy.s3_endpoint ? (
                          <p className="tiny faint">
                            {t('Endpoint：{value}', { value: strategy.s3_endpoint })}
                          </p>
                        ) : null}
                        <p className="storage-strategy-usage">
                          {usedBy.length
                            ? t('用于：{scopes}', {
                                scopes: usedBy.map((scope) => scopeLabel(scope)).join(' / '),
                              })
                            : t('暂时没有用途使用这套策略')}
                        </p>
                      </div>
                      <div className="storage-strategy-actions">
                        <Button
                          variant="ghost"
                          size="sm"
                          icon="edit"
                          onClick={() => openEdit(strategy)}
                        >
                          {t('编辑')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon="trash"
                          disabled={draft.strategies.length <= 1}
                          onClick={() => setDeleteTarget(strategy)}
                        >
                          {t('删除')}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="tiny faint mt-12">
                {t('至少保留一套、最多 {max} 套：只有一套时删除按钮不可用，达到上限时不能再新建。删除被用途引用的策略时，那些用途会回落到第一套。', { max: MAX_STRATEGIES })}
              </p>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('用途分配')}</h3>
                <p>
                  {t('四个用途各自从已有策略里选一套：图片可以放图床，附件可以继续留在本地。')}
                </p>
              </div>
              <Badge tone="muted">
                {t('{count} 套在用', { count: usedStrategies(draft).length })}
              </Badge>
            </div>
            <div className="panel-body">
              <div className="storage-scope-grid">
                {SCOPE_META.map((meta) => {
                  const strategy = findStrategy(draft, draft.scopes[meta.scope]);
                  return (
                    <div key={meta.scope} className="storage-scope">
                      <div className="storage-scope-head">
                        <span className="storage-scope-icon">
                          <Icon name={meta.icon} size={16} />
                        </span>
                        <div className="storage-scope-body">
                          <strong>{scopeLabel(meta.scope)}</strong>
                          <p>{scopeDescription[meta.scope]}</p>
                        </div>
                      </div>
                      <Field
                        label={t('储存策略')}
                        htmlFor={`storage-scope-${meta.scope}`}
                        hint={t('位置：{path}', { path: strategyLocation(strategy) })}
                      >
                        <Select
                          id={`storage-scope-${meta.scope}`}
                          value={strategy.id}
                          onChange={(event) => patchScope(meta.scope, event.target.value)}
                        >
                          {draft.strategies.map((item) => (
                            <option key={item.id} value={item.id}>
                              {`${item.name} · ${storageDriverLabel(item.driver)}`}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </div>
                  );
                })}
              </div>

              <div className="storage-callouts">
                {draftGlobal.driver !== 's3' && draftCloud ? (
                  <Callout tone="warn" icon="alert" title={t('有用途指向云策略，但全局策略还是本地储存')}>
                    {t('片段里不会生成 STORAGE_S3_* 凭据，服务器需要另行提供 endpoint、区域与 Access Key。')}{' '}
                    {t('把云策略分配给更多用途，它就会自动成为全局策略。')}
                  </Callout>
                ) : null}
                <Callout tone="info" icon="info" title={t('全局策略由用途数量决定')}>
                  {t('被最多用途使用的那套写成全局 STORAGE_DRIVER 与 STORAGE_S3_*；数量并列时取列表里靠前的一套。')}{' '}
                  {t('其余用途只写自己的 STORAGE_<用途>_* 覆盖，缺省位置由服务器按全局目录推出来。')}
                </Callout>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('上传体积提示')}</h3>
                <p>{t('只用于前端提示，不会改变服务端上限。')}</p>
              </div>
              <Badge tone="muted">{t('非服务端参数')}</Badge>
            </div>
            <div className="panel-body">
              <div className="form-grid">
                <NumberField
                  id="storage-max-upload"
                  label={t('单文件上限提示')}
                  hint={t('API 与安全服务默认限制 25 MiB；要传更大的文件，需要同时调整 API 与安全服务，而不是只改这里。')}
                  value={draft.max_upload_mb}
                  min={1}
                  max={2048}
                  unit="MB"
                  onChange={(max_upload_mb) => setDraft({ ...draft, max_upload_mb })}
                />
              </div>
              {draft.max_upload_mb > 25 ? (
                <Callout tone="warn" icon="alert" title={t('超过 API 默认的 25 MiB 附件上限')}>
                  {t('这个值只影响页面提示。真正上传大文件前，需要按服务器规格调整 API 与安全服务的')}{' '}
                  {t('请求体上限，否则请求会被更早的一层拒绝。')}
                </Callout>
              ) : null}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('部署片段')}</h3>
                <p>{t('按已保存的策略生成；指向全局策略的用途不写变量，密钥只来自下面的输入框。')}</p>
              </div>
              <CopyButton value={snippet} label={t('复制 .env')} />
            </div>
            <div className="panel-body">
              {savedCloud ? (
                <div className="form-grid storage-secret">
                  <Field
                    label={t('Secret Key（仅本次）')}
                    htmlFor="storage-secret-key"
                    aside={secret ? <Badge tone="accent">{t('仅本次')}</Badge> : null}
                    hint={t('只用于生成 .env 片段，不写入浏览器配置，保存后也不会回显；服务器只有一套 STORAGE_S3_SECRET_KEY，所有云策略共用它。')}
                  >
                    <Input
                      id="storage-secret-key"
                      type="password"
                      value={secret}
                      placeholder={t('只在本页内存里保留')}
                      autoComplete="off"
                      onChange={(event) => setSecret(event.target.value)}
                    />
                  </Field>
                </div>
              ) : null}
              <pre className="auth-env-code">{snippet}</pre>
              <div className="mt-12">
                <Callout tone="warn" icon="alert" title={t('保存不会让服务器立刻换存储')}>
                  {t('把片段写进 API 的')}{' '}
                  <code className="mono">.env</code> {t('（或启动器环境变量）并重启后才会生效。')}{' '}
                  {t('切换存储不会自动搬运已有文件：旧目录里的图片仍在旧目录，旧桶里的对象仍在旧桶，')}{' '}
                  {t('需要自己用 rclone / aws s3 sync 之类同步，或继续保留旧路径。')}
                </Callout>
              </div>
            </div>
          </section>

          <div className="row gap-8 mt-20">
            <Button disabled={!dirty} onClick={save} icon="check">
              {t('保存修改')}
            </Button>
            {dirty ? (
              <Button variant="ghost" onClick={() => setDraft(readStorage(config))}>
                {t('放弃未保存的修改')}
              </Button>
            ) : (
              <span className="tiny faint">{t('没有未保存的修改')}</span>
            )}
          </div>
        </div>

        <aside className="settings-side">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('当前配置')}</h3>
              </div>
            </div>
            <div className="panel-body">
              <div className="mini-list">
                <div className="mini-row">
                  <span className="mini-label">{t('策略数量')}</span>
                  <span className="mini-value">
                    {t('{count} 套', { count: saved.strategies.length })}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('上传提示')}</span>
                  <span className="mini-value">{saved.max_upload_mb} MB</span>
                </div>
              </div>

              <div className="storage-side-strategies mt-12">
                {saved.strategies.map((strategy) => (
                  <div key={strategy.id} className="storage-side-strategy">
                    <span className="storage-side-strategy-name">{strategy.name}</span>
                    <span className="storage-side-strategy-meta">
                      {`${storageDriverLabel(strategy.driver)} · ${strategyLocation(strategy)}`}
                    </span>
                  </div>
                ))}
              </div>

              <div className="mini-list mt-12">
                {SCOPE_META.map((meta) => (
                  <div className="mini-row" key={meta.scope}>
                    <span className="mini-label">{scopeLabel(meta.scope)}</span>
                    <span className="mini-value">
                      {findStrategy(saved, saved.scopes[meta.scope]).name}
                    </span>
                  </div>
                ))}
              </div>

              <div className="row gap-8 mt-16" style={{ flexWrap: 'wrap' }}>
                <Link to="/admin/media" className="btn btn-secondary btn-sm">
                  {t('打开媒体库')}
                </Link>
                <Link to="/admin/performance" className="btn btn-ghost btn-sm">
                  {t('性能优化')}
                </Link>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('切换存储的顺序')}</h3>
                <p>{t('先备份，再切换。')}</p>
              </div>
            </div>
            <div className="panel-body">
              <ol className="perf-steps">
                <li>{t('备份本地 data/media 目录，或记下旧桶名与前缀。')}</li>
                <li>{t('新建或编辑目标储存策略，再把要迁移的用途分配过去。')}</li>
                <li>{t('保存修改，复制下方的 .env 片段。')}</li>
                <li>{t('把片段写进服务器 .env，重启 API（不是刷新后台）。')}</li>
                <li>{t('上传图片验证；必要时用 rclone 迁移已有文件。')}</li>
                <li>{t('确认前台图片正常后，再清理旧目录或旧桶。')}</li>
              </ol>
            </div>
          </section>

          <div className="danger-zone">
            <h3>{t('恢复默认储存策略')}</h3>
            <p>{t('回到一套「本地储存」（./data/media），四个用途都指向它；不会删除文件，也不会修改服务器的 .env。')}</p>
            <Button variant="danger" size="sm" className="mt-12" icon="refresh" onClick={reset}>
              {t('恢复默认')}
            </Button>
          </div>
        </aside>
      </div>

      <Modal
        open={!!editing}
        title={editing?.mode === 'edit' ? t('编辑储存策略') : t('新建储存策略')}
        description={t('策略名会出现在用途分配与 .env 片段注释里；密钥不在这个弹窗保存。')}
        onClose={() => setEditing(null)}
        width={660}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {t('取消')}
            </Button>
            <Button onClick={submitForm} icon="check">
              {editing?.mode === 'edit' ? t('保存这套策略') : t('添加这套策略')}
            </Button>
          </>
        }
      >
        <div className="form-stack">
          <Field
            label={t('名称')}
            htmlFor="storage-strategy-name"
            error={formErrors.name ?? null}
            hint={t('必填且不能与已有策略重名，最多 {max} 个字符。', { max: MAX_STRATEGY_NAME })}
          >
            <Input
              id="storage-strategy-name"
              value={form.name}
              placeholder={t('例如：图床 COS')}
              autoComplete="off"
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>

          <Field
            label={t('类型')}
            hint={t('本地储存写这台服务器的磁盘；云对象存储需要兼容 S3 接口。')}
          >
            <Tabs
              value={form.driver}
              onChange={(driver) => setForm({ ...form, driver })}
              items={driverItems}
            />
          </Field>

          {form.driver === 'local' ? (
            <Field
              label={t('本地目录')}
              htmlFor="storage-strategy-dir"
              hint={t('相对路径基于 API 进程的工作目录；Windows 一键包默认在 exe 同目录的 data/media。备份或迁移只需拷贝这个目录。')}
            >
              <Input
                id="storage-strategy-dir"
                value={form.local_dir}
                placeholder={DEFAULT_LOCAL_DIR}
                onChange={(event) => setForm({ ...form, local_dir: event.target.value })}
              />
            </Field>
          ) : (
            <div className="form-grid">
              <Field
                label={t('桶名（Bucket）')}
                htmlFor="storage-strategy-bucket"
                error={formErrors.bucket ?? null}
                hint={t('云策略必填；服务端启动时会尝试创建缺失的桶。')}
              >
                <Input
                  id="storage-strategy-bucket"
                  value={form.s3_bucket}
                  placeholder="practacu-press"
                  autoComplete="off"
                  onChange={(event) => setForm({ ...form, s3_bucket: event.target.value })}
                />
              </Field>
              <Field
                label={t('对象前缀')}
                htmlFor="storage-strategy-prefix"
                hint={t('同一个桶放多个站点时用来隔离对象键，例如 practacu/；留空写在桶根。')}
              >
                <Input
                  id="storage-strategy-prefix"
                  value={form.s3_prefix}
                  placeholder="practacu/"
                  autoComplete="off"
                  onChange={(event) => setForm({ ...form, s3_prefix: event.target.value })}
                />
              </Field>
              <Field
                label="Endpoint"
                htmlFor="storage-strategy-endpoint"
                error={formErrors.endpoint ?? null}
                hint={t('AWS 留空；MinIO 填 http://127.0.0.1:9000，阿里云 OSS / 腾讯云 COS 填各自 S3 兼容地址。')}
              >
                <Input
                  id="storage-strategy-endpoint"
                  value={form.s3_endpoint}
                  placeholder="https://s3.example.com"
                  autoComplete="off"
                  onChange={(event) => setForm({ ...form, s3_endpoint: event.target.value })}
                />
              </Field>
              <Field
                label={t('区域（Region）')}
                htmlFor="storage-strategy-region"
                hint={t('AWS 填实际区域，例如 ap-southeast-1；MinIO 等也要求一个值，通常保持 us-east-1。')}
              >
                <Input
                  id="storage-strategy-region"
                  value={form.s3_region}
                  placeholder="us-east-1"
                  autoComplete="off"
                  onChange={(event) => setForm({ ...form, s3_region: event.target.value })}
                />
              </Field>
              <Field
                label="Access Key"
                htmlFor="storage-strategy-access-key"
                hint={t('可以保存在本地安装配置里；建议使用只允许该桶读写的子账号。')}
              >
                <Input
                  id="storage-strategy-access-key"
                  value={form.s3_access_key}
                  placeholder="AKIA…"
                  autoComplete="off"
                  onChange={(event) => setForm({ ...form, s3_access_key: event.target.value })}
                />
              </Field>
              <Field
                label={t('公开访问地址（可选）')}
                htmlFor="storage-strategy-public"
                error={formErrors.publicUrl ?? null}
                hint={t('仅用于记录与排查，API 不读取这个值；公开读权限、CDN 与防盗链由桶策略决定。')}
              >
                <Input
                  id="storage-strategy-public"
                  value={form.s3_public_base_url}
                  placeholder="https://cdn.example.com/media"
                  autoComplete="off"
                  onChange={(event) =>
                    setForm({ ...form, s3_public_base_url: event.target.value })
                  }
                />
              </Field>
            </div>
          )}

          {form.driver === 's3' ? (
            <Callout tone="info" icon="globe" title={t('公开访问与防盗链由桶策略或 CDN 决定')}>
              {t('对象存储默认是私有的；需要前台直接引用图片时，要么给桶开只读策略，要么在桶前面挂 CDN / 自定义域名。')}
            </Callout>
          ) : null}

          <p className="tiny faint">
            {t('Secret Key 不在这里填写：它只留在页面内存里，只用于生成 .env 片段。')}
          </p>
        </div>
      </Modal>

      <Modal
        open={!!deleteTarget}
        title={t('删除储存策略')}
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
        {deleteTarget ? (
          <div className="form-stack">
            {deleteScopes.length && deleteFallback ? (
              <Callout tone="warn" icon="alert" title={t('有用途正在使用这套策略')}>
                {t('删除后这些用途会回落到第一套策略「{name}」：', {
                  name: deleteFallback.name,
                })}{' '}
                {deleteScopes.map((scope) => scopeLabel(scope)).join(' / ')}
              </Callout>
            ) : (
              <p className="small muted">{t('没有用途在使用这套策略，删除不会改变上传位置。')}</p>
            )}
            <p className="tiny faint">
              {t('删除只改这台电脑的配置，不会删除任何文件，也不会修改服务器的 .env；已经上传的文件仍留在原位置。')}
            </p>
          </div>
        ) : null}
      </Modal>
    </RoleGate>
  );
}
