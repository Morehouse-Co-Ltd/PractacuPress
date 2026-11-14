import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  StorageScope,
  StorageScopeAllocation,
  StorageSettings,
  StorageStrategy,
} from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import {
  DEFAULT_LOCAL_DIR,
  MAX_ALLOCATION_ENTRIES,
  MAX_ALLOCATION_QUOTA_GB,
  MAX_STRATEGIES,
  MAX_STRATEGY_NAME,
  STORAGE_SCOPES,
  createStrategyId,
  defaultStorage,
  emptyStrategy,
  findStrategy,
  globalStrategyOf,
  normalizeStorage,
  normalizeStrategy,
  readStorage,
  scopeAllocation,
  scopeLabel,
  scopesUsingStrategy,
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
import { AutoSaveStatus, type AutoSaveState } from '../../components/AutoSaveStatus';

/** 自动保存的防抖时长：停止编辑 700ms 后写回，避免每敲一下都写本地配置。 */
const AUTOSAVE_DELAY_MS = 700;

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

/** 一个用途的容量合计；0 表示其中至少有一套策略不限容量。 */
function quotaSummary(allocation: StorageScopeAllocation, t: ReturnType<typeof useT>): string {
  const entries =
    allocation.mode === 'single' ? allocation.entries.slice(0, 1) : allocation.entries;
  if (entries.some((entry) => entry.quota_gb === 0)) return t('含不限容量');
  const total = entries.reduce((sum, entry) => sum + entry.quota_gb, 0);
  return t('合计 {size} GB', { size: total });
}

/** 策略的展示名：名称留空时回落到类型名，保证摘要行不会只剩一个徽标。 */
function strategyName(strategy: StorageStrategy): string {
  return strategy.name.trim() || storageDriverLabel(strategy.driver);
}

/**
 * 名称和类型是否说了两回事。
 *
 * 默认策略叫「本地储存」，类型也是「本地储存」；再拼成「本地储存 · 本地储存」
 * 只是重复，所以只有用户自己改了名字才在摘要和下拉里带上类型。
 */
function strategyNeedsDriver(strategy: StorageStrategy): boolean {
  const name = strategyName(strategy).trim().toLowerCase();
  return name !== storageDriverLabel(strategy.driver).toLowerCase();
}

/** 下拉选项的纯文本：原生下拉不能用富文本，只能靠标签本身避免重复。 */
function strategyOptionLabel(strategy: StorageStrategy): string {
  return strategyNeedsDriver(strategy)
    ? `${strategyName(strategy)} · ${storageDriverLabel(strategy.driver)}`
    : strategyName(strategy);
}

export function StoragePage() {
  const t = useT();
  useTitle(t('储存策略'));
  const { config, site, me, updateConfig } = useAuth();
  const backend = useBackend();
  const toast = useToast();
  const saved = useMemo(() => readStorage(config), [config]);
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState<StorageSettings>(() => saved);
  const [editing, setEditing] = useState<EditorState | null>(null);
  /** 正在弹窗里调整分配方式的用途；null 表示弹窗关闭。 */
  const [allocationScope, setAllocationScope] = useState<StorageScope | null>(null);
  const [form, setForm] = useState<StorageStrategy>(() => emptyStrategy());
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<StorageStrategy | null>(null);
  const [saveState, setSaveState] = useState<AutoSaveState>('idle');
  const [saveError, setSaveError] = useState('');
  /** 草稿归一化后的真正写入值；签名相同就不再重复保存。 */
  const payload = useMemo(() => normalizeStorage(draft), [draft]);
  const payloadKey = JSON.stringify(payload);
  /** 当前草稿签名；保存完成后据此判断期间有没有新的输入。 */
  const payloadKeyRef = useRef(payloadKey);
  payloadKeyRef.current = payloadKey;
  /** 上一次的校验失败原因；只在原因变化时提示一次，避免连续输入时刷屏。 */
  const lastInvalidRef = useRef('');
  /** 最近一次已写入（或已从服务端读到）的归一化签名；签名相同就不重复保存。 */
  const savedSig = useRef(payloadKey);
  /** 自动保存串行队列：后一次永远排在前一次完成之后，避免并发覆盖。 */
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  /** 上一次同步过的服务端签名；挂载时只记下，不同步也不保存。 */
  const syncedKey = useRef(savedKey);

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

  /** 保存前校验：S3 必须有桶名，端点与公开地址必须是 http(s) 绝对地址。 */
  const validationError = (() => {
    for (const strategy of payload.strategies) {
      if (strategy.driver === 's3' && !strategy.s3_bucket) {
        return t('云策略「{name}」缺少桶名', { name: strategy.name });
      }
      const endpointError = storageUrlError(strategy.s3_endpoint);
      if (endpointError) {
        return t('策略「{name}」的 Endpoint {error}', {
          name: strategy.name,
          error: endpointError,
        });
      }
      const publicError = storageUrlError(strategy.s3_public_base_url);
      if (publicError) {
        return t('策略「{name}」的公开访问地址{error}', {
          name: strategy.name,
          error: publicError,
        });
      }
    }
    return '';
  })();

  /** 把一次保存排进串行队列；执行时签名已对齐就说明无需再写。 */
  const enqueueSave = (sig: string, next: StorageSettings) => {
    saveQueue.current = saveQueue.current
      .then(() => {
        if (sig === savedSig.current) {
          setSaveState('idle');
          return;
        }
        setSaveState('saving');
        // 本页只写这台电脑的本地安装配置，updateConfig 是同步落盘的。
        updateConfig({ storage: next });
        savedSig.current = sig;
        setSaveState('saved');
        toast.push('ok', t('已自动保存'));
        // 与旧的手动保存一致：期间没有新的输入时把草稿归一化成真正写入的值。
        if (payloadKeyRef.current === sig) {
          setDraft(next);
        }
        if (me) {
          const multiCount = STORAGE_SCOPES.filter(
            (scope) => scopeAllocation(next, scope).mode === 'quota',
          ).length;
          noteActivity(
            backend,
            me.user.display_name,
            '修改储存策略',
            site?.name ?? '站点',
            t('{count} 套策略 · {multi} 个用途多策略', {
              count: next.strategies.length,
              multi: multiCount,
            }),
          );
        }
      })
      .catch(() => setSaveState('error'));
  };

  // 草稿变化后尾随防抖自动保存：与已保存值一致就不动，校验不通过只报错不写入。
  useEffect(() => {
    if (payloadKey === savedSig.current) {
      setSaveState((state) => (state === 'saving' ? state : 'idle'));
      setSaveError('');
      lastInvalidRef.current = '';
      return;
    }
    if (validationError) {
      setSaveState('error');
      setSaveError(validationError);
      if (lastInvalidRef.current !== validationError) {
        lastInvalidRef.current = validationError;
        toast.push('error', t('自动保存失败'), validationError);
      }
      return;
    }
    lastInvalidRef.current = '';
    setSaveState('pending');
    setSaveError('');
    const timer = window.setTimeout(() => enqueueSave(payloadKey, payload), AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
    // enqueueSave 只依赖 ref 与稳定回调；签名变化才是重新排队的依据。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payloadKey, validationError]);

  // 本地配置更新（开屏水合或本页保存完成）时同步草稿：本地有更新的内容就保留，
  // 既避免冲掉正在编辑的内容，也避免把刚同步回来的值当成新改动再保存一次。
  useEffect(() => {
    if (syncedKey.current === savedKey) return;
    syncedKey.current = savedKey;
    const next = readStorage(config);
    if (payloadKey === savedSig.current) {
      setDraft(next);
    }
    savedSig.current = JSON.stringify(next);
    // 只跟配置变化同步；payloadKey 故意不入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const draftGlobal = globalStrategyOf(draft);
  const draftCloud = usedStrategies(draft).some((strategy) => strategy.driver === 's3');
  const deleteFallback = deleteTarget
    ? draft.strategies.find((strategy) => strategy.id !== deleteTarget.id)
    : undefined;
  const deleteScopes = deleteTarget
    ? scopesUsingStrategy(draft, deleteTarget.id)
    : [];

  /** 弹窗对应的用途、分配与主策略；弹窗关闭时都是 null。 */
  const allocationMeta = allocationScope
    ? SCOPE_META.find((meta) => meta.scope === allocationScope) ?? null
    : null;
  const activeAllocation = allocationScope ? scopeAllocation(draft, allocationScope) : null;
  const activePrimary =
    allocationScope && activeAllocation
      ? findStrategy(
          draft,
          activeAllocation.entries[0]?.strategy_id ?? draft.scopes[allocationScope],
        )
      : null;
  const activeShownEntries = activeAllocation
    ? activeAllocation.mode === 'single'
      ? activeAllocation.entries.slice(0, 1)
      : activeAllocation.entries
    : [];
  const activeHasAvailable = activeAllocation
    ? draft.strategies.some(
        (strategy) =>
          !activeAllocation.entries.some((entry) => entry.strategy_id === strategy.id),
      )
    : false;

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
      t('改动会自动写入这台电脑的本地安装配置。'),
    );
  };

  const confirmDelete = () => {
    const target = deleteTarget;
    if (!target) return;
    const remaining = draft.strategies.filter((strategy) => strategy.id !== target.id);
    // 至少保留一套：只剩一套时删除按钮本来就是禁用的，这里再兜一次底。
    if (!remaining.length) return;
    const normalized = normalizeStorage(draft);
    const allocations = {} as Record<StorageScope, StorageScopeAllocation>;
    for (const scope of STORAGE_SCOPES) {
      const allocation = normalized.allocations![scope];
      const entries = allocation.entries.filter(
        (entry) => entry.strategy_id !== target.id,
      );
      if (!entries.length) {
        entries.push({ strategy_id: remaining[0].id, quota_gb: 0 });
      }
      allocations[scope] = { ...allocation, entries };
    }
    const scopes = {} as Record<StorageScope, string>;
    for (const scope of STORAGE_SCOPES) {
      scopes[scope] = allocations[scope].entries[0].strategy_id;
    }
    setDraft({ ...normalized, strategies: remaining, scopes, allocations });
    setDeleteTarget(null);
    toast.push(
      'ok',
      t('已删除储存策略「{name}」', { name: target.name }),
      deleteScopes.length
        ? t('引用它的用途已经从分配里移除，空出来的位置回落到第一套策略；改动会自动保存，不会删除任何文件。')
        : t('没有用途在使用这套策略，删除不会改变上传位置，也不会删除任何文件。'),
    );
  };

  const reset = () => {
    const next = normalizeStorage(defaultStorage());
    // 先把草稿与签名一起对齐默认值，避免自动保存把恢复前的旧草稿又写回去。
    savedSig.current = JSON.stringify(next);
    setDraft(next);
    setSaveError('');
    updateConfig({ storage: next });
    setSaveState('saved');
    toast.push(
      'ok',
      t('已恢复默认储存策略'),
      t('回到一套「本地储存」（./data/media），四个用途都改为单策略并指向它；不会删除文件，也不会修改服务器的存储配置。'),
    );
  };

  /**
   * 更新一个用途的完整分配。
   *
   * 先走一次 normalizeStorage，保证旧草稿也带上 allocations；再把主策略
   * `scopes[scope]` 同步成分配顺序的第一套。
   */
  const patchAllocation = (
    scope: StorageScope,
    update: (allocation: StorageScopeAllocation) => StorageScopeAllocation,
  ) => {
    setDraft((prev) => {
      const normalized = normalizeStorage(prev);
      const allocations = {
        ...normalized.allocations!,
        [scope]: update(normalized.allocations![scope]),
      };
      const scopes = {
        ...normalized.scopes,
        [scope]:
          allocations[scope].entries[0]?.strategy_id ?? normalized.scopes[scope],
      };
      return { ...normalized, scopes, allocations };
    });
  };

  const setScopeMode = (scope: StorageScope, mode: StorageScopeAllocation['mode']) => {
    patchAllocation(scope, (allocation) => ({ ...allocation, mode }));
  };

  const setScopeOverflow = (
    scope: StorageScope,
    overflow: StorageScopeAllocation['overflow'],
  ) => {
    patchAllocation(scope, (allocation) => ({ ...allocation, overflow }));
  };

  const setSingleStrategy = (scope: StorageScope, strategyId: string) => {
    patchAllocation(scope, (allocation) => {
      const first = allocation.entries[0] ?? { strategy_id: strategyId, quota_gb: 0 };
      const rest = allocation.entries
        .slice(1)
        .filter((entry) => entry.strategy_id !== strategyId);
      return {
        ...allocation,
        entries: [{ ...first, strategy_id: strategyId }, ...rest],
      };
    });
  };

  const setEntryStrategy = (scope: StorageScope, index: number, strategyId: string) => {
    const allocation = scopeAllocation(draft, scope);
    if (
      allocation.entries.some(
        (entry, entryIndex) =>
          entryIndex !== index && entry.strategy_id === strategyId,
      )
    ) {
      toast.push(
        'error',
        t('这套策略已经在当前用途里了。'),
        t('同一个用途里每套策略只能出现一次，可以先用上移 / 下移调整顺序。'),
      );
      return;
    }
    patchAllocation(scope, (current) => ({
      ...current,
      entries: current.entries.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, strategy_id: strategyId } : entry,
      ),
    }));
  };

  const setEntryQuota = (scope: StorageScope, index: number, raw: number) => {
    const quota = Number.isFinite(raw)
      ? Math.min(MAX_ALLOCATION_QUOTA_GB, Math.max(0, Math.round(raw)))
      : 0;
    patchAllocation(scope, (allocation) => ({
      ...allocation,
      entries: allocation.entries.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, quota_gb: quota } : entry,
      ),
    }));
  };

  const moveEntry = (scope: StorageScope, index: number, delta: -1 | 1) => {
    patchAllocation(scope, (allocation) => {
      const target = index + delta;
      if (target < 0 || target >= allocation.entries.length) return allocation;
      const entries = [...allocation.entries];
      [entries[index], entries[target]] = [entries[target], entries[index]];
      return { ...allocation, entries };
    });
  };

  const addEntry = (scope: StorageScope) => {
    const allocation = scopeAllocation(draft, scope);
    if (allocation.entries.length >= MAX_ALLOCATION_ENTRIES) {
      toast.push(
        'info',
        t('这个用途已经分配了 {max} 套策略', { max: MAX_ALLOCATION_ENTRIES }),
        t('移除一套不再使用的策略后再添加。'),
      );
      return;
    }
    const used = new Set(allocation.entries.map((entry) => entry.strategy_id));
    const candidate = draft.strategies.find((strategy) => !used.has(strategy.id));
    if (!candidate) {
      toast.push(
        'info',
        t('当前用途没有可添加的策略了。'),
        t('先新建一套储存策略，或移除一套已有的策略。'),
      );
      return;
    }
    patchAllocation(scope, (current) => ({
      ...current,
      mode: 'quota',
      entries: [
        ...current.entries,
        { strategy_id: candidate.id, quota_gb: 0 },
      ],
    }));
  };

  const removeEntry = (scope: StorageScope, index: number) => {
    const allocation = scopeAllocation(draft, scope);
    if (allocation.entries.length <= 1) {
      toast.push(
        'info',
        t('至少保留一套策略。'),
        t('要把这个用途改回单策略，可以切换「分配方式」。'),
      );
      return;
    }
    patchAllocation(scope, (current) => ({
      ...current,
      entries: current.entries.filter((_, entryIndex) => entryIndex !== index),
    }));
  };

  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('储存策略')}</h1>
          <p>
            {t('决定上传的图片与附件写到哪里：先建一套或几套储存策略（本地目录或 S3 兼容的云对象存储），')}{' '}
            {t('再为每个用途分配一套或多套；多套时按顺序使用，并可在达到容量上限后自动切换。')}
          </p>
        </div>
        <div className="admin-page-actions">
          <AutoSaveStatus state={saveState} error={saveError} />
          <Link to="/admin/media" className="btn btn-ghost btn-sm">
            <Icon name="image" size={14} /> {t('媒体库')}
          </Link>
        </div>
      </div>

      <Callout tone="info" icon="database" title={t('保存只是写配置，部署才算切换')}>
        {t('本页只写入这台电脑的本地安装配置，不会改动服务器上的文件或凭据。')}{' '}
        {t('服务器最终使用哪套存储，仍由部署时的存储配置决定；演示模式与真实后端行为一致。')}
      </Callout>

      <div className="editor-main mt-20">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>{t('储存策略')}</h3>
              <p>
                {t('每套策略就是一个存储目标；被最多用途使用的那套会标记为全局策略。')}
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
                const usedBy = scopesUsingStrategy(draft, strategy.id);
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
                {t('每个用途可以只用一套策略，也可以分配多套并设置各自的容量上限。')}
              </p>
            </div>
            <Badge tone="muted">
              {t('{count} 套在用', { count: usedStrategies(draft).length })}
            </Badge>
          </div>
          <div className="panel-body">
            <div className="storage-scope-grid">
              {SCOPE_META.map((meta) => {
                const allocation = scopeAllocation(draft, meta.scope);
                const shownEntries =
                  allocation.mode === 'single'
                    ? allocation.entries.slice(0, 1)
                    : allocation.entries;
                const primary = findStrategy(
                  draft,
                  allocation.entries[0]?.strategy_id ?? draft.scopes[meta.scope],
                );
                const strategyNames = shownEntries
                  .map((entry) => strategyName(findStrategy(draft, entry.strategy_id)))
                  .join(' → ');
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
                      <Badge tone={allocation.mode === 'quota' ? 'accent' : 'muted'}>
                        {allocation.mode === 'quota'
                          ? t('多策略')
                          : t('单策略')}
                      </Badge>
                    </div>

                    <Field label={t('储存策略')}>
                      <button
                        type="button"
                        className="storage-current"
                        onClick={() => setAllocationScope(meta.scope)}
                        aria-haspopup="dialog"
                        aria-label={t('查看「{scope}」的储存策略', {
                          scope: scopeLabel(meta.scope),
                        })}
                      >
                        <span className="storage-current-icon">
                          <Icon
                            name={primary.driver === 's3' ? 'globe' : 'server'}
                            size={15}
                          />
                        </span>
                        <span className="storage-current-body">
                          <span className="storage-current-title">
                            <strong>
                              {allocation.mode === 'quota'
                                ? t('{count} 套策略', { count: shownEntries.length })
                                : strategyName(primary)}
                            </strong>
                            {allocation.mode === 'single' && strategyNeedsDriver(primary) ? (
                              <Badge tone={primary.driver === 's3' ? 'accent' : 'neutral'}>
                                {storageDriverLabel(primary.driver)}
                              </Badge>
                            ) : null}
                          </span>
                          <span className="storage-current-meta">
                            {allocation.mode === 'quota'
                              ? `${strategyNames} · ${quotaSummary(allocation, t)}`
                              : strategyLocation(primary)}
                          </span>
                        </span>
                        <span className="storage-current-side">
                          <span className="tiny">{t('查看')}</span>
                          <Icon name="chevron-right" size={15} />
                        </span>
                      </button>
                    </Field>
                  </div>
                );
              })}
            </div>

            <div className="storage-callouts">
              {draftGlobal.driver !== 's3' && draftCloud ? (
                <Callout tone="warn" icon="alert" title={t('有用途指向云策略，但全局策略还是本地储存')}>
                  {t('服务器目前只支持一套云凭据；多套云策略需要部署方另行提供 endpoint、区域与 Access Key。')}{' '}
                  {t('把云策略分配给更多用途，它就会自动成为全局策略。')}
                </Callout>
              ) : null}
              <Callout tone="info" icon="info" title={t('多策略按顺序切换')}>
                {t('每个用途的第一套是主策略；达到容量上限后，按「写满后」的规则切换到下一套或停止。')}{' '}
                {t('容量上限按用途单独记录，不改变策略本身的存储位置。')}
              </Callout>
            </div>
          </div>
        </section>

        {allocationScope && allocationMeta && activeAllocation && activePrimary ? (
          <Modal
            open
            title={t('「{scope}」的储存策略', { scope: scopeLabel(allocationScope) })}
            description={t('这个用途可以只用一套策略，也可以按顺序分配多套并设置容量上限；关闭弹窗后改动会自动保存。')}
            onClose={() => setAllocationScope(null)}
            width={680}
            footer={
              <Button onClick={() => setAllocationScope(null)} icon="check">
                {t('完成')}
              </Button>
            }
          >
            <div className="storage-allocation-dialog">
              <Field
                label={t('分配方式')}
                hint={
                  activeAllocation.mode === 'single'
                    ? t('只使用一套策略，最省心。')
                    : t('按顺序使用多套策略；前一套达到容量上限后，按「写满后」的规则处理。')
                }
              >
                <Tabs
                  value={activeAllocation.mode}
                  onChange={(mode) => setScopeMode(allocationScope, mode)}
                  items={[
                    { key: 'single', label: t('单策略') },
                    { key: 'quota', label: t('多策略 · 容量切换') },
                  ]}
                />
              </Field>

              {activeAllocation.mode === 'single' ? (
                <Field label={t('储存策略')}>
                  <div
                    className="storage-strategy-options"
                    role="radiogroup"
                    aria-label={t('储存策略')}
                  >
                    {draft.strategies.map((item) => {
                      const selected = item.id === activePrimary.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          className={cx(
                            'storage-strategy-option',
                            selected && 'is-selected',
                          )}
                          onClick={() => setSingleStrategy(allocationScope, item.id)}
                        >
                          <span className="storage-strategy-option-icon">
                            <Icon
                              name={item.driver === 's3' ? 'globe' : 'server'}
                              size={15}
                            />
                          </span>
                          <span className="storage-strategy-option-body">
                            <span className="storage-strategy-option-title">
                              <strong>{strategyName(item)}</strong>
                              {strategyNeedsDriver(item) ? (
                                <Badge
                                  tone={item.driver === 's3' ? 'accent' : 'neutral'}
                                >
                                  {storageDriverLabel(item.driver)}
                                </Badge>
                              ) : null}
                            </span>
                            <span className="storage-strategy-option-path">
                              {strategyLocation(item)}
                            </span>
                          </span>
                          <span
                            className={cx(
                              'storage-strategy-option-check',
                              selected && 'is-checked',
                            )}
                            aria-hidden
                          >
                            {selected ? <Icon name="check" size={12} /> : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </Field>
              ) : (
                <div className="storage-allocation">
                  <div className="storage-allocation-caption">
                    <span>{t('策略顺序')}</span>
                    <span>{t('容量上限')}</span>
                    <span className="tiny faint">{quotaSummary(activeAllocation, t)}</span>
                  </div>
                  <div className="storage-allocation-list">
                    {activeAllocation.entries.map((entry, index) => (
                      <div
                        key={`${entry.strategy_id}-${index}`}
                        className="storage-allocation-row"
                      >
                        <span className="storage-allocation-order" aria-hidden>
                          {index + 1}
                        </span>
                        <Select
                          className="storage-strategy-select"
                          value={entry.strategy_id}
                          aria-label={t('第 {index} 套策略', { index: index + 1 })}
                          onChange={(event) =>
                            setEntryStrategy(allocationScope, index, event.target.value)
                          }
                        >
                          {draft.strategies.map((item) => {
                            const taken = activeAllocation.entries.some(
                              (other, otherIndex) =>
                                otherIndex !== index &&
                                other.strategy_id === item.id,
                            );
                            return (
                              <option key={item.id} value={item.id} disabled={taken}>
                                {strategyOptionLabel(item)}
                              </option>
                            );
                          })}
                        </Select>
                        <div className="input-suffix storage-allocation-quota">
                          <Input
                            type="number"
                            min={0}
                            max={MAX_ALLOCATION_QUOTA_GB}
                            step={1}
                            value={entry.quota_gb}
                            aria-label={t('容量上限')}
                            onChange={(event) =>
                              setEntryQuota(
                                allocationScope,
                                index,
                                Number(event.target.value),
                              )
                            }
                          />
                          <span>GB</span>
                        </div>
                        <div className="storage-allocation-actions">
                          <Button
                            variant="ghost"
                            size="sm"
                            icon="arrow-up"
                            title={t('上移')}
                            aria-label={t('上移')}
                            disabled={index === 0}
                            onClick={() => moveEntry(allocationScope, index, -1)}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            icon="arrow-up"
                            className="storage-allocation-down"
                            title={t('下移')}
                            aria-label={t('下移')}
                            disabled={index === activeAllocation.entries.length - 1}
                            onClick={() => moveEntry(allocationScope, index, 1)}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            icon="close"
                            title={t('移除这套策略')}
                            aria-label={t('移除这套策略')}
                            disabled={activeAllocation.entries.length <= 1}
                            onClick={() => removeEntry(allocationScope, index)}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="storage-allocation-foot">
                    <Button
                      variant="secondary"
                      size="sm"
                      icon="plus"
                      disabled={
                        activeAllocation.entries.length >= MAX_ALLOCATION_ENTRIES ||
                        !activeHasAvailable
                      }
                      onClick={() => addEntry(allocationScope)}
                    >
                      {t('添加一套策略')}
                    </Button>
                    <span className="tiny faint">{t('0 表示不限容量')}</span>
                  </div>
                  <Field
                    label={t('写满后')}
                    htmlFor={`storage-overflow-${allocationScope}`}
                    hint={t('按顺序写入；前面的策略写满后才会使用下一套。容量上限只作用于这个用途。')}
                  >
                    <Select
                      id={`storage-overflow-${allocationScope}`}
                      value={activeAllocation.overflow}
                      onChange={(event) =>
                        setScopeOverflow(
                          allocationScope,
                          event.target.value as StorageScopeAllocation['overflow'],
                        )
                      }
                    >
                      <option value="switch">{t('自动切换到下一套')}</option>
                      <option value="stop">{t('停止写入并提示')}</option>
                    </Select>
                  </Field>
                  <p className="tiny faint">
                    {t('当前顺序：{order}', {
                      order: activeShownEntries
                        .map(
                          (entry, index) =>
                            `${index + 1}. ${strategyName(findStrategy(draft, entry.strategy_id))}`,
                        )
                        .join(' → '),
                    })}
                  </p>
                </div>
              )}
            </div>
          </Modal>
        ) : null}

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

        <div className="danger-zone">
          <h3>{t('恢复默认储存策略')}</h3>
          <p>
            {t('回到一套「本地储存」（./data/media），四个用途都改为单策略并指向它；不会删除文件，也不会修改服务器的存储配置。')}
          </p>
          <Button variant="danger" size="sm" className="mt-12" icon="refresh" onClick={reset}>
            {t('恢复默认')}
          </Button>
        </div>
      </div>

      <Modal
        open={!!editing}
        title={editing?.mode === 'edit' ? t('编辑储存策略') : t('新建储存策略')}
        description={t('策略名会出现在用途分配里；密钥不在这个弹窗保存。')}
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
                {t('删除后这些用途里的这套策略会被移除，空出来的位置回落到第一套策略「{name}」：', {
                  name: deleteFallback.name,
                })}{' '}
                {deleteScopes.map((scope) => scopeLabel(scope)).join(' / ')}
              </Callout>
            ) : (
              <p className="small muted">{t('没有用途在使用这套策略，删除不会改变上传位置。')}</p>
            )}
            <p className="tiny faint">
              {t('删除只改这台电脑的配置，不会删除任何文件，也不会修改服务器的存储配置；已经上传的文件仍留在原位置。')}
            </p>
          </div>
        ) : null}
      </Modal>
    </RoleGate>
  );
}
