import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ExtensionSummary, ServerExtensionState } from '../../types';
import {
  BUILTIN_EXTENSIONS,
  type BuiltinExtensionInfo,
} from '../../lib/extensions/builtinCatalog';
import { errorText, useT } from '../../lib/i18n';
import { formatDateTime } from '../../lib/format';
import { useTitle } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import { ApiError } from '../../lib/api';
import { Badge, Button, Callout, Modal } from '../../components/ui';
import { Icon, type IconName } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';

/** 服务器扩展清单的加载状态。 */
type ServerLoadState = 'idle' | 'loading' | 'ready' | 'denied' | 'unavailable' | 'error';

/** 左侧横条列表里的一行：服务器扩展或随应用发布的内置扩展。 */
type ExtensionRow =
  | { key: string; kind: 'builtin'; info: BuiltinExtensionInfo }
  | { key: string; kind: 'server'; extension: ExtensionSummary };

type Translate = ReturnType<typeof useT>;

export function ExtensionsPage() {
  const t = useT();
  useTitle(t('扩展'));
  const toast = useToast();
  const backend = useBackend();
  const { me } = useAuth();
  const isPlatformAdmin = me?.role === 'platform_admin';

  /* ---------------- 服务器扩展（安装包） ---------------- */

  /*
   * 服务器扩展开关只有平台管理员能碰，且端点由并行任务实现：这里全程按「可选能力」
   * 处理，演示模式与旧后端分别显示不同说明，绝不因为 404 / 权限不足把整页打崩。
   * 内置扩展（BUILTIN_EXTENSIONS）与服务器扩展共用左侧横条列表，内置的永远可用。
   */
  const [serverItems, setServerItems] = useState<ExtensionSummary[]>([]);
  const [serverState, setServerState] = useState<ServerLoadState>('idle');
  const [serverError, setServerError] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [busyExtensionId, setBusyExtensionId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importPackageError, setImportPackageError] = useState('');
  const [serverDeleteTarget, setServerDeleteTarget] = useState<ExtensionSummary | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const zipRef = useRef<HTMLInputElement>(null);

  const canManageServer = isPlatformAdmin && typeof backend.listExtensions === 'function';

  const loadServerExtensions = useCallback(async () => {
    if (!isPlatformAdmin) {
      setServerState('denied');
      return;
    }
    const list = backend.listExtensions;
    if (typeof list !== 'function') {
      // 演示后端没有安装目录；旧后端也还没有这个端点。
      setServerState('unavailable');
      return;
    }
    setServerState('loading');
    setServerError('');
    try {
      const items = await list.call(backend);
      setServerItems(items);
      setServerState('ready');
    } catch (error) {
      setServerItems([]);
      if (
        error instanceof ApiError &&
        (error.problem.status === 404 || error.problem.status === 405)
      ) {
        setServerState('unavailable');
        return;
      }
      if (
        error instanceof ApiError &&
        (error.problem.status === 401 || error.problem.status === 403)
      ) {
        setServerState('denied');
        return;
      }
      setServerState('error');
      setServerError(errorText(error));
    }
  }, [backend, isPlatformAdmin]);

  useEffect(() => {
    void loadServerExtensions();
  }, [loadServerExtensions]);

  const rows: ExtensionRow[] = [
    ...serverItems.map((extension) => ({
      key: `server:${extension.id}`,
      kind: 'server' as const,
      extension,
    })),
    ...BUILTIN_EXTENSIONS.map((info) => ({
      key: `builtin:${info.id}`,
      kind: 'builtin' as const,
      info,
    })),
  ];
  const selectedRow = rows.find((row) => row.key === selectedKey) ?? rows[0];
  const selectedName = selectedRow
    ? selectedRow.kind === 'builtin'
      ? t(selectedRow.info.name)
      : selectedRow.extension.name
    : '';
  const demoMissing = serverState === 'unavailable' && backend.mode === 'demo';

  const toggleServerExtension = async (extension: ExtensionSummary) => {
    const setEnabled = backend.setExtensionEnabled;
    if (!canManageServer || typeof setEnabled !== 'function' || busyExtensionId) return;
    setBusyExtensionId(extension.id);
    try {
      const updated = await setEnabled.call(backend, extension.id, !extension.enabled);
      setServerItems((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setSelectedKey(`server:${updated.id}`);
      toast.push(
        'ok',
        updated.enabled ? t('扩展已启用') : t('扩展已停用'),
        t('是否运行由后端启动清单决定，刷新页面后生效。'),
      );
    } catch (error) {
      toast.push('error', t('切换启用状态失败'), errorText(error));
    } finally {
      setBusyExtensionId(null);
    }
  };

  const pickExtensionPackage = async (file: File | undefined) => {
    const importPackage = backend.importExtension;
    if (!file || typeof importPackage !== 'function' || importing) return;
    setImporting(true);
    setImportPackageError('');
    try {
      const created = await importPackage.call(backend, file);
      toast.push('ok', t('扩展包已导入'), created.name);
      setSelectedKey(`server:${created.id}`);
      await loadServerExtensions();
    } catch (error) {
      const message = errorText(error);
      setImportPackageError(message);
      toast.push('error', t('导入扩展包失败'), message);
      if (
        error instanceof ApiError &&
        (error.problem.status === 404 || error.problem.status === 405)
      ) {
        setServerState('unavailable');
      }
    } finally {
      setImporting(false);
      if (zipRef.current) zipRef.current.value = '';
    }
  };

  const confirmDeleteServerExtension = async () => {
    const removeExtension = backend.deleteExtension;
    if (!serverDeleteTarget || typeof removeExtension !== 'function') return;
    const target = serverDeleteTarget;
    setBusyExtensionId(target.id);
    try {
      await removeExtension.call(backend, target.id);
      setServerItems((items) => items.filter((item) => item.id !== target.id));
      setSelectedKey(null);
      setServerDeleteTarget(null);
      toast.push('ok', t('服务器扩展已删除'), target.name);
    } catch (error) {
      toast.push('error', t('删除扩展失败'), errorText(error));
    } finally {
      setBusyExtensionId(null);
    }
  };

  /* ---------------- 渲染 ---------------- */

  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('扩展')}</h1>
          <p>
            {t(
              '服务器扩展以 zip 安装包导入，由后端启动清单决定是否运行；内置扩展随应用发布，免安装。每个扩展以小组件卡片展示，点开卡片查看介绍、权限与前后端能力。',
            )}
          </p>
        </div>
        <div className="admin-page-actions">
          {canManageServer ? (
            <>
              <Button
                variant="primary"
                size="sm"
                icon="upload"
                loading={importing}
                disabled={serverState === 'unavailable'}
                onClick={() => zipRef.current?.click()}
              >
                {importing ? t('正在导入扩展包…') : t('导入扩展')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon="refresh"
                loading={serverState === 'loading'}
                onClick={() => void loadServerExtensions()}
              >
                {t('刷新')}
              </Button>
              <input
                ref={zipRef}
                type="file"
                accept=".zip,application/zip"
                hidden
                onChange={(event) => void pickExtensionPackage(event.target.files?.[0])}
              />
            </>
          ) : null}
          <Link to="/admin/docs" className="btn btn-ghost btn-sm">
            <Icon name="code" size={14} /> {t('扩展文档')}
          </Link>
        </div>
      </div>

      {/* ---------------- 扩展管理区：小组件卡片 ---------------- */}
      <div className="extm-widgets">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>{t('扩展小组件')}</h3>
              <p>
                {t(
                  '服务器扩展与内置扩展都以卡片展示；点击卡片查看介绍、权限与前后端能力。',
                )}
              </p>
            </div>
            <Badge tone="muted">{t('共 {count} 个扩展', { count: rows.length })}</Badge>
          </div>
          <div className="panel-body">
            {serverState === 'loading' ? (
              <p className="extm-list-note">
                <span className="spinner spinner-sm" aria-hidden /> {t('正在读取服务器扩展…')}
              </p>
            ) : null}
            {serverState === 'denied' ? (
              <Callout tone="warn" icon="shield" title={t('仅平台管理员可管理服务器扩展')}>
                {t(
                  '服务器扩展包的导入、启用与删除需要平台管理员；内置扩展仍可正常查看。',
                )}
              </Callout>
            ) : null}
            {demoMissing ? (
              <Callout tone="info" icon="info" title={t('演示模式没有服务器扩展')}>
                {t(
                  '演示数据只存在浏览器里，没有安装服务；连接真实后端后可以导入、启用或删除扩展包。这里只显示随应用发布的内置扩展。',
                )}
              </Callout>
            ) : null}
            {!demoMissing && serverState === 'unavailable' && isPlatformAdmin ? (
              <Callout tone="warn" icon="alert" title={t('服务器扩展接口未就绪')}>
                {t(
                  '当前后端还没有提供扩展管理 API（/api/v1/extensions）。页面先展示随应用发布的内置扩展；后端就绪后点「刷新」重新读取。',
                )}
              </Callout>
            ) : null}
            {serverState === 'error' ? (
              <Callout tone="danger" icon="alert" title={t('读取服务器扩展失败')}>
                {serverError}
              </Callout>
            ) : null}
            {importing ? (
              <p className="extm-list-note">
                <span className="spinner spinner-sm" aria-hidden /> {t('正在导入扩展包…')}
              </p>
            ) : null}
            {importPackageError ? (
              <Callout tone="danger" icon="alert" title={t('导入扩展包失败')}>
                {importPackageError}
              </Callout>
            ) : null}
            {serverState === 'ready' && serverItems.length === 0 ? (
              <p className="extm-list-note">{t('还没有安装服务器扩展；导入一个 zip 扩展包即可。')}</p>
            ) : null}

            <div className="extm-widget-grid" role="list">
              {rows.map((row) => {
                const builtinInfo = row.kind === 'builtin' ? row.info : null;
                const serverExtension = row.kind === 'server' ? row.extension : null;
                const name = builtinInfo ? t(builtinInfo.name) : (serverExtension?.name ?? '');
                const description = builtinInfo
                  ? t(builtinInfo.description)
                  : serverExtension?.description || t('（还没有填写描述）');
                const version = builtinInfo ? builtinInfo.version : (serverExtension?.version ?? '');
                const enabled = builtinInfo ? true : !!serverExtension?.enabled;
                const failed = serverExtension?.state === 'failed';
                const ability = builtinInfo
                  ? t('前端')
                  : serverExtension
                    ? serverAbilityLabel(serverExtension, t)
                    : null;
                const icon: IconName = builtinInfo ? builtinInfo.icon : 'grid';
                const isSelected = selectedRow?.key === row.key;
                const stateText = serverExtension
                  ? serverStateLabel(serverExtension.state, t)
                  : t('始终启用');
                const openDetail = () => {
                  setSelectedKey(row.key);
                  setDetailOpen(true);
                };
                return (
                  <div
                    key={row.key}
                    role="listitem"
                    className={`extm-widget${isSelected ? ' is-selected' : ''}${
                      enabled ? ' is-on' : ''
                    }${failed ? ' is-failed' : ''}`}
                  >
                    <button
                      type="button"
                      className="extm-widget-main"
                      aria-label={t('查看「{name}」的详细信息', { name })}
                      onClick={openDetail}
                    >
                      <span className="extm-widget-icon" aria-hidden>
                        <Icon name={icon} size={22} />
                      </span>
                      <span className="extm-widget-body">
                        <span className="extm-widget-title">
                          <strong>{name}</strong>
                          {builtinInfo ? <Badge tone="muted">{t('内置')}</Badge> : null}
                          {ability ? <Badge tone={builtinInfo ? 'muted' : 'accent'}>{ability}</Badge> : null}
                          {failed ? (
                            <Badge tone="danger" dot>
                              {t('运行失败')}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="extm-widget-desc">{description}</span>
                        <span className="extm-widget-meta">
                          v{version} · {stateText}
                        </span>
                      </span>
                    </button>
                    <div className="extm-widget-foot">
                      {builtinInfo ? (
                        <Badge tone="ok" dot>
                          {t('始终启用')}
                        </Badge>
                      ) : canManageServer && serverExtension ? (
                        <button
                          type="button"
                          role="switch"
                          aria-checked={enabled}
                          aria-label={t('启用或禁用「{name}」', { name })}
                          className={`switch${enabled ? ' is-on' : ''}`}
                          disabled={busyExtensionId === serverExtension.id}
                          onClick={() => void toggleServerExtension(serverExtension)}
                        >
                          <span />
                        </button>
                      ) : (
                        <Badge tone={enabled ? 'ok' : 'muted'}>
                          {enabled ? t('已启用') : t('已停用')}
                        </Badge>
                      )}
                      <button type="button" className="extm-widget-link" onClick={openDetail}>
                        {t('详情')} <Icon name="arrow-right" size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>

      <Modal
        open={detailOpen && !!selectedRow}
        title={selectedName}
        onClose={() => setDetailOpen(false)}
        width={760}
        footer={<Button onClick={() => setDetailOpen(false)}>{t('关闭')}</Button>}
      >
        {selectedRow ? (
          selectedRow.kind === 'server' ? (
            <ServerExtensionDetail
              extension={selectedRow.extension}
              canManage={canManageServer}
              busy={busyExtensionId === selectedRow.extension.id}
              onToggle={() => void toggleServerExtension(selectedRow.extension)}
              onDelete={() => {
                setDetailOpen(false);
                setServerDeleteTarget(selectedRow.extension);
              }}
            />
          ) : (
            <BuiltinExtensionDetail info={selectedRow.info} />
          )
        ) : null}
      </Modal>

      <Modal
        open={!!serverDeleteTarget}
        title={t('删除扩展')}
        description={
          serverDeleteTarget
            ? t('确定删除服务器扩展「{name}」吗？', { name: serverDeleteTarget.name })
            : undefined
        }
        onClose={() => setServerDeleteTarget(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setServerDeleteTarget(null)}>
              {t('取消')}
            </Button>
            <Button
              variant="danger"
              icon="trash"
              loading={!!serverDeleteTarget && busyExtensionId === serverDeleteTarget.id}
              onClick={() => void confirmDeleteServerExtension()}
            >
              {t('删除')}
            </Button>
          </>
        }
      >
        <p className="small muted" style={{ lineHeight: 1.8 }}>
          {t('删除后扩展目录会从服务器移除；内置扩展不受影响。')}
        </p>
      </Modal>

    </RoleGate>
  );
}

/* ---------------- 服务器扩展行 / 详情 ---------------- */

/** 服务器扩展的状态标签（安装 / 启用 / 停用 / 失败）。 */
function serverStateLabel(state: ServerExtensionState, t: Translate): string {
  switch (state) {
    case 'enabled':
      return t('已启用');
    case 'disabled':
      return t('已停用');
    case 'failed':
      return t('运行失败');
    default:
      return t('已安装');
  }
}

/** 状态对应的徽标色调。 */
function serverStateTone(state: ServerExtensionState): 'ok' | 'danger' | 'muted' | 'accent' {
  switch (state) {
    case 'enabled':
      return 'ok';
    case 'failed':
      return 'danger';
    case 'disabled':
      return 'muted';
    default:
      return 'accent';
  }
}

/** 扩展的能力类型：前端 / 后端 / 全栈；两者都没有时返回 null。 */
function serverAbilityLabel(extension: ExtensionSummary, t: Translate): string | null {
  const hasFrontend = extension.frontend !== null;
  const hasBackend = extension.backend !== null;
  if (hasFrontend && hasBackend) return t('全栈');
  if (hasFrontend) return t('前端');
  if (hasBackend) return t('后端');
  return null;
}

interface ServerExtensionDetailProps {
  extension: ExtensionSummary;
  canManage: boolean;
  busy: boolean;
  onToggle: () => void;
  onDelete: () => void;
}

/** 右侧 sticky 详情：安装信息、前后端能力、权限与操作。 */
function ServerExtensionDetail({
  extension,
  canManage,
  busy,
  onToggle,
  onDelete,
}: ServerExtensionDetailProps) {
  const t = useT();
  const ability = serverAbilityLabel(extension, t);
  const frontend = extension.frontend;
  const backend = extension.backend;

  const metaRows: { label: string; value: ReactNode }[] = [
    { label: t('版本'), value: `v${extension.version}` },
  ];
  if (extension.author) metaRows.push({ label: t('作者'), value: extension.author });
  if (extension.license) metaRows.push({ label: t('许可'), value: extension.license });
  if (extension.runtime) metaRows.push({ label: t('运行时'), value: extension.runtime });
  if (extension.installed_at) {
    metaRows.push({ label: t('安装时间'), value: formatDateTime(extension.installed_at) });
  }
  if (extension.enabled_at) {
    metaRows.push({ label: t('启用时间'), value: formatDateTime(extension.enabled_at) });
  }

  return (
    <div className="extm-detail-body">
      <div className="extm-detail-title">
        <span className="extm-detail-icon" aria-hidden>
          <Icon name="grid" size={20} />
        </span>
        <div className="extm-detail-title-copy">
          <h3>{extension.name}</h3>
          <p className="extm-detail-sub">
            v{extension.version}
            {ability ? ` · ${ability}` : ''}
          </p>
        </div>
        <Badge tone={serverStateTone(extension.state)} dot>
          {serverStateLabel(extension.state, t)}
        </Badge>
      </div>

      {extension.homepage ? (
        <a
          className="extm-detail-home"
          href={extension.homepage}
          target="_blank"
          rel="noreferrer noopener"
        >
          {extension.homepage} <Icon name="external" size={12} />
        </a>
      ) : null}

      <p className="extm-detail-desc">
        {extension.description || t('（还没有填写描述）')}
      </p>

      {extension.last_error ? (
        <Callout tone="danger" icon="alert" title={t('最近一次错误')}>
          {extension.last_error}
        </Callout>
      ) : null}

      <dl className="extm-meta">
        {metaRows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>

      {frontend ? (
        <section className="extm-section">
          <h4>{t('前端能力')}</h4>
          <p className="extm-kv">
            <span>{t('入口')}</span>
            <code>{frontend.entry}</code>
          </p>
          <p className="extm-kv">
            <span>
              {t('槽位')} · {frontend.slots.length}
            </span>
            {frontend.slots.length ? (
              <span className="extm-chips">
                {frontend.slots.map((slot) => (
                  <span className="extm-chip" key={slot}>
                    {slot}
                  </span>
                ))}
              </span>
            ) : (
              <span className="extm-empty-value">—</span>
            )}
          </p>
          <p className="extm-kv">
            <span>
              {t('区块')} · {frontend.blocks.length}
            </span>
            {frontend.blocks.length ? (
              <span className="extm-chips">
                {frontend.blocks.map((block, index) => (
                  <span className="extm-chip" key={`${block.type}-${index}`}>
                    {block.name || block.type}
                  </span>
                ))}
              </span>
            ) : (
              <span className="extm-empty-value">—</span>
            )}
          </p>
          <p className="extm-kv">
            <span>
              {t('样式')} · {frontend.styles.length}
            </span>
            {frontend.styles.length ? (
              <span className="extm-chips">
                {frontend.styles.map((style) => (
                  <span className="extm-chip" key={style}>
                    {style}
                  </span>
                ))}
              </span>
            ) : (
              <span className="extm-empty-value">—</span>
            )}
          </p>
        </section>
      ) : null}

      {backend ? (
        <section className="extm-section">
          <h4>{t('后端能力')}</h4>
          <p className="extm-kv">
            <span>WASM</span>
            <Badge tone={backend.wasm ? 'ok' : 'muted'}>{backend.wasm ? 'yes' : 'no'}</Badge>
          </p>
          <p className="extm-kv">
            <span>
              {t('路由')} · {backend.routes.length}
            </span>
            {backend.routes.length ? (
              <ul className="extm-routes">
                {backend.routes.map((route, index) => (
                  <li key={`${route.method}-${route.path}-${index}`}>
                    <code>
                      {route.method.toUpperCase()} {route.path}
                    </code>
                    {route.auth ? <span className="extm-chip">{route.auth}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="extm-empty-value">—</span>
            )}
          </p>
          {backend.hooks?.length ? (
            <p className="extm-kv">
              <span>
                {t('钩子')} · {backend.hooks.length}
              </span>
              <span className="extm-chips">
                {backend.hooks.map((hook) => (
                  <span className="extm-chip" key={hook}>
                    {hook}
                  </span>
                ))}
              </span>
            </p>
          ) : null}
          {typeof backend.timeout_ms === 'number' ? (
            <p className="extm-kv">
              <span>{t('超时')}</span>
              <span>{backend.timeout_ms} ms</span>
            </p>
          ) : null}
          {typeof backend.max_memory_mb === 'number' ? (
            <p className="extm-kv">
              <span>{t('内存上限')}</span>
              <span>{backend.max_memory_mb} MB</span>
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="extm-section">
        <h4>{t('权限')}</h4>
        {extension.permissions.length ? (
          <div className="extm-chips">
            {extension.permissions.map((permission) => (
              <span className="extm-chip is-permission" key={permission}>
                {permission}
              </span>
            ))}
          </div>
        ) : (
          <p className="extm-empty-value">{t('没有声明权限。')}</p>
        )}
      </section>

      <div className="extm-detail-actions">
        {canManage ? (
          <>
            <Button
              variant={extension.enabled ? 'secondary' : 'primary'}
              icon={extension.enabled ? 'x-circle' : 'check-circle'}
              loading={busy}
              onClick={onToggle}
            >
              {extension.enabled ? t('禁用') : t('启用')}
            </Button>
            <Button variant="ghost" icon="trash" disabled={busy} onClick={onDelete}>
              {t('删除')}
            </Button>
          </>
        ) : (
          <p className="field-hint extm-readonly-hint">
            {t('仅平台管理员可启用、禁用或删除服务器扩展。')}
          </p>
        )}
      </div>
    </div>
  );
}

/** 内置扩展的详情：随应用发布、始终启用、不可删除。 */
function BuiltinExtensionDetail({ info }: { info: BuiltinExtensionInfo }) {
  const t = useT();
  return (
    <div className="extm-detail-body">
      <div className="extm-detail-title">
        <span className="extm-detail-icon" aria-hidden>
          <Icon name={info.icon} size={20} />
        </span>
        <div className="extm-detail-title-copy">
          <h3>{t(info.name)}</h3>
          <p className="extm-detail-sub">
            v{info.version} · {t('前端')}
          </p>
        </div>
        <Badge tone="ok" dot>
          {t('已启用')}
        </Badge>
      </div>

      <div className="extm-detail-badges">
        <Badge tone="muted">{t('内置')}</Badge>
        <Badge tone="ok">{t('始终启用')}</Badge>
      </div>

      <p className="extm-detail-desc">{t(info.description)}</p>

      <p className="field-hint">{t('内置扩展，随应用发布')}</p>

      <div className="extm-detail-actions">
        <Link to={`/admin/ext/${info.pageId}`} className="btn btn-secondary btn-sm">
          {t('打开扩展页面 →')}
        </Link>
      </div>
    </div>
  );
}

