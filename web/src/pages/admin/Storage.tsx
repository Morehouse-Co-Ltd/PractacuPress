import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  MediaQuotaBytes,
  StorageRuntimeAllocationEntry,
  StorageScope,
  StorageScopeAllocation,
  StorageSettings,
  StorageStatus,
  StorageStrategy,
} from '../../types';
import { useAuth } from '../../lib/session';
import { isDemo, useBackend } from '../../lib/backend';
import {
  DEFAULT_LOCAL_DIR,
  MAX_ALLOCATION_ENTRIES,
  MAX_ALLOCATION_QUOTA_GB,
  MAX_CONTENT_SOURCE_CHARS,
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
  scopeAllocation,
  scopeLabel,
  scopesUsingStrategy,
  storageApplyPayload,
  storageApplySignature,
  storageDriverLabel,
  storageSettingsFromStatus,
  storageUrlError,
  strategyLocation,
  usedStrategies,
} from '../../lib/storage';
import { formatBytes } from '../../lib/format';
import { errorText, useAsync, useTitle } from '../../lib/hooks';
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
import { MediaQuotaField } from '../../components/MediaQuotaField';
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

/** 某个用途当前写入条目的用量；用于用途卡片的一行摘要。 */
function currentUsage(
  status: StorageStatus | null,
  scope: StorageScope,
): StorageRuntimeAllocationEntry | null {
  const entries = status?.allocations?.[scope]?.entries;
  if (!entries?.length) return null;
  return entries.find((entry) => entry.current) ?? entries[0];
}

export function StoragePage() {
  const t = useT();
  useTitle(t('储存与媒体'));
  const { config, site, me, updateConfig, applySite } = useAuth();
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
  /**
   * S3 Secret Key 草稿：只存在于组件状态。
   *
   * 密钥从不写进本地安装配置（`updateConfig` 只收 `StorageSettings`），只在
   * 「立即应用」那一次请求里作为 `s3_secret_key` 提交，成功后立即清空。
   */
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const secretDraftsRef = useRef(secretDrafts);
  secretDraftsRef.current = secretDrafts;
  /** 最近一次「立即应用」失败的原因；成功后清空，失败时保留旧状态等用户重试。 */
  const [applyError, setApplyError] = useState('');
  const [applying, setApplying] = useState(false);
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
  /** 服务端运行期设置只接管草稿一次，避免后续刷新冲掉正在编辑的内容。 */
  const hydratedServerRef = useRef(false);

  /** 当前草稿的部署签名；与上次应用成功的签名不同就说明还需要应用。 */
  const desiredSig = useMemo(() => storageApplySignature(payload), [payload]);
  /** 上次应用成功的签名：state 驱动徽标刷新，ref 给串行队列读最新值。 */
  const appliedSigRef = useRef(desiredSig);
  const [appliedSig, setAppliedSig] = useState(desiredSig);
  const markApplied = (sig: string) => {
    appliedSigRef.current = sig;
    setAppliedSig(sig);
  };

  /** 演示模式：可以保存，但不冒充真的换了服务端存储，所以不自动应用。 */
  const demo = isDemo(backend);
  /**
   * 谁能立刻应用：平台管理员 + 真实后端 + 有 `applyStorage`。
   *
   * 旧后端没有这个端点、站点管理员没有权限、演示模式不真的切换，这三种情况都只
   * 写本地安装配置，并在页面上解释原因。
   */
  const canApply =
    me?.role === 'platform_admin' && !demo && typeof backend.applyStorage === 'function';
  const canApplyRef = useRef(canApply);
  canApplyRef.current = canApply;
  /** 应用串行队列：一次应用完成后再开始下一次，避免相互覆盖。 */
  const applyQueue = useRef<Promise<void>>(Promise.resolve());

  /**
   * 服务端运行期储存状态。
   *
   * 新端点同时给出「保存值是否已生效」与每个用途的服务端分配 / 用量；旧后端没有
   * 这个端点就返回 null，页面其余部分照常可用。
   */
  const runtime = useAsync<StorageStatus | null>(async () => {
    if (typeof backend.storageStatus === 'function') return backend.storageStatus();
    return null;
  }, [backend]);

  // 服务端已经是唯一事实来源：首次读到运行期设置时接管草稿，并同步进本地安装
  // 配置。否则换一台电脑打开页面会看到本机缓存的默认策略，还误以为它已经生效。
  // 用户已经开始改草稿时不覆盖输入，等自动保存 / 立即应用把改动送上去。
  useEffect(() => {
    const status = runtime.data;
    if (!status || hydratedServerRef.current) return;
    if (!status.strategies.length) return;
    hydratedServerRef.current = true;
    if (payloadKey !== savedSig.current) return;
    const next = storageSettingsFromStatus(status, readStorage(config));
    const nextKey = JSON.stringify(next);
    setDraft(next);
    savedSig.current = nextKey;
    markApplied(storageApplySignature(next));
    updateConfig({ storage: next });
    setSaveState('saved');
    setSaveError('');
    // runtime.data 第一次到达时接管一次；payloadKey / config 只用于判断是否已有编辑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.data]);

  /** `.env` 片段反映本页草稿：没有运行期应用权限时仍可手动部署。 */
  const envSnippet = buildStorageEnvSnippet(draft);

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
        // 本地保存成功后按需应用：签名没变就说明服务端已经是这份设置，不再重复请求。
        const applySig = storageApplySignature(next);
        if (applySig !== appliedSigRef.current) {
          enqueueApply(applySig, next);
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

  /**
   * 把一次应用排进串行队列。
   *
   * 只有平台管理员 + 真实后端 + 有 `applyStorage` 时才真的发请求；失败不自动重试，
   * 页面给「立即应用」按钮让用户自己重来，避免把服务端错误打成循环。
   */
  const enqueueApply = (sig: string, next: StorageSettings, force = false) => {
    if (!canApplyRef.current || typeof backend.applyStorage !== 'function') return;
    const request = storageApplyPayload(next, secretDraftsRef.current);
    applyQueue.current = applyQueue.current
      .then(async () => {
        // 排队期间可能已经被前一次应用覆盖，签名相同就不必再发；
        // 手动「立即应用」例外：只改了 Secret 时设置签名不变，但仍要把新密钥送上去。
        if (!force && sig === appliedSigRef.current) return;
        setApplying(true);
        setApplyError('');
        try {
          const status = await backend.applyStorage!(request);
          runtime.setData(status);
          markApplied(sig);
          secretDraftsRef.current = {};
          setSecretDrafts({});
          toast.push(
            'ok',
            t('已保存并立即生效'),
            t('服务器已换用新设置并写进 data/storage-settings.json；已有文件不会自动迁移。'),
          );
        } catch (err) {
          // 保留旧状态与旧签名：徽标回到「待应用」，用户可以点「立即应用」重试。
          setApplyError(errorText(err));
          toast.push('error', t('立即应用失败'), errorText(err));
        } finally {
          setApplying(false);
        }
      })
      .catch(() => setApplying(false));
  };

  /** 「立即应用」按钮：用当前草稿重试一次（校验不通过时按钮是禁用的）。 */
  const applyNow = () => {
    if (validationError) return;
    enqueueApply(desiredSig, payload, true);
  };

  /**
   * 媒体额度写站点设置。
   *
   * 额度是站点级数据，和上面的储存草稿（本机配置 + 运行期应用）是两条路径；
   * 成功后更新共享的 Site，媒体库等页面立刻看到新值。
   */
  const saveMediaQuota = useCallback(
    async (next: MediaQuotaBytes) => {
      if (!site) throw new Error(t('未连接站点'));
      await backend.updateSite(site.id, { media_quota_bytes: next });
      applySite({ ...site, media_quota_bytes: next });
    },
    [applySite, backend, site, t],
  );

  /** 记下一套策略的密钥草稿；空串表示沿用服务器已保存的密钥。 */
  const patchSecretDraft = (id: string, value: string) => {
    setSecretDrafts((prev) => {
      const next = { ...prev, [id]: value };
      secretDraftsRef.current = next;
      return next;
    });
  };

  /** 丢弃一套策略的密钥草稿（删除策略时用）。 */
  const clearSecretDraft = (id: string) => {
    setSecretDrafts((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      secretDraftsRef.current = next;
      return next;
    });
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
    // 预生成 id：密钥草稿按策略 id 记在组件状态里，新建时也要有稳定的 key。
    setForm({ ...emptyStrategy(), id: createStrategyId(draft.strategies) });
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
    const id =
      editing?.mode === 'edit'
        ? editing.id
        : form.id || createStrategyId(draft.strategies);
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
    clearSecretDraft(target.id);
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
    setApplyError('');
    secretDraftsRef.current = {};
    setSecretDrafts({});
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

  /**
   * 「保存后是否已生效」徽标。
   *
   * - 失败：最近一次应用报错，旧状态保留，等用户点「立即应用」重试；
   * - 应用中：请求在飞；
   * - 已生效：服务端说 live，且本页保存的签名就是应用成功的签名；
   * - 其余：待应用（旧后端、没有权限，或刚改完还没应用）。
   */
  const statusBadge: { tone: 'ok' | 'warn' | 'danger'; label: string } | null = !runtime.data
    ? null
    : applyError
      ? { tone: 'danger', label: t('应用失败') }
      : applying
        ? { tone: 'warn', label: t('应用中…') }
        : runtime.data.live && (!canApply || appliedSig === desiredSig)
          ? { tone: 'ok', label: t('已生效') }
          : { tone: 'warn', label: t('待应用') };

  /**
   * 不能立即应用时的解释。
   *
   * 演示模式、权限不足、旧后端三种情况都只写本地安装配置，不能让用户以为已经换了
   * 服务端存储。
   */
  const applyUnavailableReason = demo
    ? t('演示模式只在本地保存策略，不会真的切换服务器存储；真实后端里的平台管理员保存后会立即应用。')
    : me?.role !== 'platform_admin'
      ? t('只有平台管理员可以立即应用；保存只写入这台电脑的本地安装配置，服务器继续使用部署环境变量或之前应用过的设置。')
      : t('这个后端没有立即应用接口；保存只写本地安装配置，需要把部署片段写进服务器再重启。');

  /**
   * 分配弹窗里的服务端用量摘要。
   *
   * 按写入顺序列出每套策略的 `used_bytes`，并标出当前写入目标；只有新版后端
   * 返回了分配时才显示。配额与顺序 / 切换都由服务端执行，所以这里展示的是
   * 服务端统计值，而不是页面估算。
   */
  /** 弹窗里这套策略在服务端的密钥状态；新建策略或旧后端没有状态时为 null。 */
  const formServerStrategy = editing
    ? (runtime.data?.strategies.find((item) => item.id === form.id) ?? null)
    : null;

  const allocationUsageSummary = allocationScope
    ? (runtime.data?.allocations?.[allocationScope]?.entries ?? [])
        .map((entry, index) => {
          const name = strategyName(findStrategy(draft, entry.strategy_id));
          const used = t('已用 {size}', { size: formatBytes(entry.used_bytes) });
          return `${index + 1}. ${name} ${used}${entry.current ? `（${t('当前写入')}）` : ''}`;
        })
        .join(' · ')
    : '';

  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('储存与媒体')}</h1>
          <p>{t('决定上传的图片与附件写到哪里，并管理正文长度、上传提示与站点媒体额度。')}</p>
        </div>
        <div className="admin-page-actions">
          {statusBadge ? <Badge tone={statusBadge.tone}>{statusBadge.label}</Badge> : null}
          {canApply ? (
            <Button
              variant="secondary"
              size="sm"
              icon="check"
              loading={applying}
              disabled={applying || Boolean(validationError)}
              onClick={applyNow}
            >
              {t('立即应用')}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            icon="refresh"
            loading={runtime.loading}
            onClick={runtime.reload}
          >
            {t('刷新')}
          </Button>
          <AutoSaveStatus state={saveState} error={saveError} />
          <Link to="/admin/media" className="btn btn-ghost btn-sm">
            <Icon name="image" size={14} /> {t('媒体库')}
          </Link>
        </div>
      </div>

      {applyError ? (
        <div className="mt-12">
          <Callout tone="danger" icon="alert" title={t('立即应用失败')}>
            {applyError}
            {canApply ? (
              <div className="mt-12">
                <Button
                  variant="secondary"
                  size="sm"
                  icon="refresh"
                  loading={applying}
                  disabled={applying || Boolean(validationError)}
                  onClick={applyNow}
                >
                  {t('立即应用')}
                </Button>
              </div>
            ) : null}
          </Callout>
        </div>
      ) : null}

      {runtime.error ? (
        <div className="mt-12">
          <Callout tone="danger" icon="alert" title={t('无法读取服务端的储存状态')}>
            {errorText(runtime.error)}
            <div className="mt-12">
              <Button
                variant="secondary"
                size="sm"
                icon="refresh"
                loading={runtime.loading}
                onClick={runtime.reload}
              >
                {t('刷新')}
              </Button>
            </div>
          </Callout>
        </div>
      ) : null}

      <div className="mt-12">
        <Callout tone="info" icon="database" title={t('保存后立即生效')}>
          {t(
            '平台管理员保存后会自动应用：服务器把设置写进 data/storage-settings.json 并马上换用，无需重启；这个文件优先于 .env 里的 STORAGE_* 变量。',
          )}{' '}
          {t('容量上限与多策略切换由服务端在写入时执行；已有文件不会自动迁移，旧目录或旧桶里的对象仍在原处。')}
        </Callout>
      </div>

      <div className="mt-12">
        {!canApply ? (
          <Callout tone="warn" icon="alert" title={t('「立即应用」不可用')}>
            {applyUnavailableReason}
          </Callout>
        ) : (
          <Callout tone="info" icon="database" title={t('保存后自动应用，失败可以重试')}>
            {t('保存成功会自动调用「立即应用」；失败时保留原来的生效状态，页面上会出现错误原因与重试按钮。')}
          </Callout>
        )}
      </div>

      <div className="editor-main mt-20">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>{t('储存策略')}</h3>
              <p>
                {t('每套策略就是一个存储目标；下面为每个用途选择使用哪一套，也可以按顺序分配多套并设置容量上限。')}
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
                // 服务端状态里这套策略的密钥情况；旧后端 / 演示没有时就不显示徽标。
                const serverStrategy = runtime.data?.strategies.find(
                  (item) => item.id === strategy.id,
                );
                const secretDraft = secretDrafts[strategy.id]?.trim() ?? '';
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
                        {strategy.driver === 's3' && serverStrategy ? (
                          <Badge tone={serverStrategy.has_secret ? 'ok' : 'warn'}>
                            {serverStrategy.has_secret
                              ? t('服务器已保存密钥')
                              : t('缺少密钥')}
                          </Badge>
                        ) : null}
                        {strategy.driver === 's3' && secretDraft ? (
                          <Badge tone="accent">{t('新密钥待应用')}</Badge>
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

            <div className="storage-subsection">
              <div className="storage-subsection-head">
                <div>
                  <h4>{t('各用途使用哪套策略')}</h4>
                  <p>{t('每个用途可以只用一套策略，也可以分配多套并设置各自的容量上限。')}</p>
                </div>
                <Badge tone="muted">
                  {t('{count} 套在用', { count: usedStrategies(draft).length })}
                </Badge>
              </div>
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
                  // 当前写入条目的服务端用量；旧后端 / 演示没有状态时不显示。
                  const currentEntry = currentUsage(runtime.data, meta.scope);
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
                              {currentEntry
                                ? ` · ${t('已用 {size}', {
                                    size: formatBytes(currentEntry.used_bytes),
                                  })}`
                                : ''}
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
              <Callout tone="info" icon="info" title={t('多策略由服务端按顺序写入')}>
                {t('保存后服务端按写入顺序使用每套策略：单策略忽略配额；多策略时前一套写满（quota_gb，0 表示不限）后，按「写满后」的规则停止或切到下一套。')}{' '}
                {t('所有策略都写满时，新的上传会失败并返回 storage_quota_exceeded（507）。')}
              </Callout>
              </div>
            </div>

            <details className="mt-12">
              <summary className="link-btn">{t('部署片段（备用）')}</summary>
              <p className="tiny faint">
                {t(
                  '片段只描述位置与驱动，不含任何密钥；旧后端或没有运行期应用权限时，把它写进 API 的 .env 再重启，新的上传才会写到这些位置。',
                )}
              </p>
              <pre className="auth-env-code">{envSnippet}</pre>
              <CopyButton value={envSnippet} label={t('复制 .env')} />
            </details>
          </div>
        </section>

        {allocationScope && allocationMeta && activeAllocation && activePrimary ? (
          <Modal
            open
            title={t('「{scope}」的储存策略', { scope: scopeLabel(allocationScope) })}
            description={t('这个用途可以只用一套策略，也可以按顺序分配多套并设置容量上限；关闭弹窗后改动会自动保存并应用。')}
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
                    ? t('只使用一套策略，最省心；单策略模式下配额不生效。')
                    : t('按写入顺序使用多套策略；服务端在前一套写满（quota_gb）后，按「写满后」的规则停止或切换。')
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
                  {allocationUsageSummary ? (
                    <p className="tiny faint">
                      {t('服务端用量：{usage}', { usage: allocationUsageSummary })}
                    </p>
                  ) : null}
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
                    hint={t('由服务端在写入时执行：按顺序写入，前面的策略写满后才会使用下一套；容量上限只作用于这个用途。')}
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
              <h3>{t('储存设置')}</h3>
              <p>{t('正文长度上限、上传提示与站点媒体额度；修改后随本页自动保存。')}</p>
            </div>
          </div>
          <div className="panel-body">
            <div className="form-grid">
              <NumberField
                id="storage-max-content-chars"
                label={t('正文长度上限')}
                hint={t('1 到 {max} 个 Unicode 字符；保存后文章与帖子立即按此上限校验。', {
                  max: MAX_CONTENT_SOURCE_CHARS.toLocaleString(),
                })}
                value={draft.max_content_chars}
                min={1}
                max={MAX_CONTENT_SOURCE_CHARS}
                unit={t('字符')}
                onChange={(value) =>
                  setDraft((previous) => ({ ...previous, max_content_chars: value }))
                }
              />
              <NumberField
                id="storage-max-upload"
                label={t('上传体积提示')}
                hint={t('API 默认限制 25 MiB；要传更大的文件，需要同时调整 API 与反向代理的请求体上限，而不是只改这里。')}
                value={draft.max_upload_mb}
                min={1}
                max={2048}
                unit="MB"
                onChange={(max_upload_mb) => setDraft({ ...draft, max_upload_mb })}
              />
              <MediaQuotaField
                value={site?.media_quota_bytes}
                onSave={saveMediaQuota}
                disabled={!site}
              />
            </div>
            {draft.max_upload_mb > 25 ? (
              <div className="mt-12">
                <Callout tone="warn" icon="alert" title={t('超过 API 默认的 25 MiB 附件上限')}>
                  {t('这个值只影响页面提示。真正上传大文件前，需要按服务器规格调整 API 的请求体上限，否则请求会被更早的一层拒绝。')}
                </Callout>
              </div>
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
        description={t('策略名会出现在各用途的选择里；Secret Key 只保存在本页内存，仅随「立即应用」提交一次。')}
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
                hint={t('会保存在本地安装配置里，并随应用请求提交；建议使用只允许该桶读写的子账号。')}
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
                label={t('Secret Key（可选）')}
                htmlFor="storage-strategy-secret"
                aside={
                  formServerStrategy ? (
                    <Badge tone={formServerStrategy.has_secret ? 'ok' : 'warn'}>
                      {formServerStrategy.has_secret ? t('服务器已保存密钥') : t('缺少密钥')}
                    </Badge>
                  ) : undefined
                }
                hint={t('只用于「立即应用」这一次请求，不会写入这台电脑的配置；留空表示沿用服务器已保存的密钥。')}
              >
                <Input
                  id="storage-strategy-secret"
                  type="password"
                  value={secretDrafts[form.id] ?? ''}
                  placeholder={t('留空沿用服务器已保存密钥')}
                  autoComplete="new-password"
                  onChange={(event) => patchSecretDraft(form.id, event.target.value)}
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
              {t('删除只改这份储存设置，下一次保存 / 应用后服务端才会换用新顺序；不会删除任何文件，已经上传的文件仍留在原位置。')}
            </p>
          </div>
        ) : null}
      </Modal>
    </RoleGate>
  );
}
