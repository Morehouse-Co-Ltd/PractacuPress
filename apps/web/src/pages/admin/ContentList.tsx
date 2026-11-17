import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  ArticleCover,
  BulkAction,
  Content,
  ContentAction,
  ContentKind,
  ContentStatus,
  SiteCustomization,
  TileSpan,
} from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { noteActivity } from '../../lib/activity';
import {
  ACTION_LABEL,
  KIND_LABEL,
  STATUS_LABEL,
  formatDateTime,
  isSiteAdmin,
} from '../../lib/format';
import { useT } from '../../lib/i18n';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Input,
  Modal,
  Select,
  Skeleton,
  StatusBadge,
  Tabs,
} from '../../components/ui';
import { MAX_PINS, TILE_SPANS } from '../../lib/homeTiles';
import { useCustomization } from '../../lib/customize';
import { coverAlt, coverFor, coverImageStyle } from '../../lib/covers';
import { Cover } from '../../components/Cover';
import { Icon } from '../../components/Icon';
import { useTaxonomy } from '../../lib/useTaxonomy';
import { usePermissions } from '../../lib/usePermissions';
import { useToast } from '../../lib/toast';

type StatusFilter = 'all' | ContentStatus;
type KindFilter = 'all' | ContentKind;

/**
 * 列表行里需要二次确认的动作。
 *
 * `delete` / `purge` 不是 `ContentAction`：软删除走 `DELETE /{kind}s/{id}`，
 * 彻底删除走独立的 `purgeContent`，和状态机动作不是同一组接口。放进同一个
 * `confirming` 状态只是为了复用现有确认弹窗，不另造一套机制。
 */
type RowAction = ContentAction | 'delete' | 'purge';

/**
 * 列表里显示的封面：内容字段优先（Beta 1.2 起封面属于内容）。
 *
 * 旧内容没有 `cover_url`，仍按内容 id 读穿站点外观配置里那份旧封面；读穿规则与
 * 编辑器的封面面板一致，一旦保存过就只认内容字段。
 */
function coverOf(
  customization: Pick<SiteCustomization, 'covers'>,
  item: Content,
): ArticleCover | undefined {
  if (item.cover_url) {
    return {
      id: item.id,
      url: item.cover_url,
      ...(item.cover_alt ? { alt: item.cover_alt } : {}),
      position: item.cover_position,
      hidden: !!item.cover_hidden,
    };
  }
  return coverFor(customization, item.id);
}

export function ContentListPage() {
  const t = useT();
  const { me } = useAuth();
  const { personal, can } = usePermissions();
  const backend = useBackend();
  const toast = useToast();
  const { customization, update } = useCustomization();
  const { taxonomy } = useTaxonomy();
  // 删除 / 恢复 / 彻底删除都要求写权限：只读成员看到的是纯列表。
  const canWrite = can('write_content');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [kind, setKind] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');
  /** 回收站视图：正常列表与回收站是互斥的两份数据，由服务端的 trashed 参数决定。 */
  const [trashed, setTrashed] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [confirming, setConfirming] = useState<{ item: Content; action: RowAction } | null>(null);
  // ---- 多选与批量操作（契约 G）----
  /** 选中集合按内容 id 存：两个 kind 混在一个列表里，合并后仍能按 kind 分组调用。 */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<BulkAction | ''>('');
  const [bulkConfirm, setBulkConfirm] = useState<BulkAction | null>(null);
  /** 最近一次批量操作的结果：成功后选择被清空，但汇总与失败明细仍要留在页面上。 */
  const [bulkReport, setBulkReport] = useState<{
    action: BulkAction;
    succeeded: number;
    failed: number;
    failures: { id: string; error: string }[];
  } | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  useTitle(t('内容库'));

  const data = useAsync(async () => {
    // 正常视图不带 trashed：服务端已经排除了已删除内容，前端不再自己合并两份列表。
    // 回收站视图显式传 trashed=true，两个 kind 都要取。
    const options = trashed ? { limit: 100, trashed: true } : { limit: 100 };
    const [articles, posts] = await Promise.all([
      backend.listContent('article', options),
      backend.listContent('post', options),
    ]);
    return [...articles.items, ...posts.items].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }, [backend, trashed]);

  const items = data.data ?? [];
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return items.filter((item) => {
      if (kind !== 'all' && item.kind !== kind) return false;
      // 正常视图绝不放已删除内容（服务端已经排除，这里再兜一层）；
      // 回收站视图反过来只看带 deleted_at 的条目。
      if (trashed ? !item.deleted_at : !!item.deleted_at) return false;
      if (status !== 'all' && item.status !== status) return false;
      if (term && !`${item.title} ${item.summary ?? ''} ${item.author_name ?? ''}`.toLowerCase().includes(term)) {
        return false;
      }
      return true;
    });
  }, [items, kind, status, query, trashed]);

  const counts = useMemo(() => {
    const map = new Map<StatusFilter, number>();
    map.set('all', items.length);
    for (const item of items) map.set(item.status, (map.get(item.status) ?? 0) + 1);
    return map;
  }, [items]);

  /* ---------- 多选 ---------- */

  /** 选中项对应的完整内容：批量动作、可用动作集合都从它们身上算。 */
  const selectedItems = useMemo(
    () => items.filter((item) => selected.has(item.id)),
    [items, selected],
  );
  /** 「全选」只作用于当前筛选结果（页面里看到的那一页），不会去勾选看不见的条目。 */
  const pageIds = useMemo(() => filtered.map((item) => item.id), [filtered]);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someOnPageSelected = pageIds.some((id) => selected.has(id));

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someOnPageSelected && !allOnPageSelected;
    }
  }, [someOnPageSelected, allOnPageSelected]);

  // 内容 / 回收站是两个互斥视图，批量动作集合完全不同；切换后旧选择没有意义。
  useEffect(() => {
    setSelected(new Set());
    setBulkReport(null);
  }, [trashed]);

  // 列表刷新后丢掉已经不存在的 id，避免批量栏显示一个不存在的选中数。
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(items.map((item) => item.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [items]);

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllOnPage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        for (const id of pageIds) next.delete(id);
      } else {
        for (const id of pageIds) next.add(id);
      }
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  /** 批量动作的展示名：回收站动作没有 ContentAction 同名列，单独给一个标签。 */
  const bulkActionLabel = (action: BulkAction): string => {
    if (action === 'trash') return t('移入回收站');
    return ACTION_LABEL[action as ContentAction];
  };

  /** 需要二次确认的批量动作：归档、撤销发布、移入回收站、彻底删除。 */
  const dangerBulkActions: BulkAction[] = ['archive', 'unpublish', 'trash', 'purge'];

  const bulkActionDescription = (action: BulkAction): string => {
    switch (action) {
      case 'archive':
        return t('归档后选中的内容会从公开列表移出，但已有链接仍然有效。');
      case 'unpublish':
        return t('撤销后选中的内容会回到草稿，公开链接将不再可访问。');
      case 'trash':
        return t('选中的内容会移入回收站，之后仍然可以恢复。');
      case 'undelete':
        return t('选中的内容会从回收站恢复到删除前的状态。');
      case 'purge':
        return t('彻底删除不可恢复：正文与版本历史都会一起删除。');
      default:
        return '';
    }
  };

  const bulkActionIcon = (action: BulkAction) => {
    switch (action) {
      case 'submit':
        return 'send' as const;
      case 'publish':
        return 'check' as const;
      case 'archive':
      case 'trash':
      case 'purge':
        return 'trash' as const;
      case 'unpublish':
        return 'x-circle' as const;
      case 'undelete':
        return 'refresh' as const;
      default:
        return undefined;
    }
  };

  /**
   * 可用的批量动作 = 当前视图 × 权限 × 选中项上服务端允许的动作。
   *
   * 服务端下发的 `item.actions` 已经编码了状态机与授权（作者 / 编辑能做什么），
   * 前端只做「选中项里至少有一条能做」的过滤；真正的逐条判定仍由 bulk 接口返回。
   */
  const bulkActions = useMemo<BulkAction[]>(() => {
    if (!canWrite || !selectedItems.length) return [];
    if (trashed) return ['undelete', 'purge'];
    const has = (action: ContentAction) => selectedItems.some((item) => item.actions.includes(action));
    const actions: BulkAction[] = [];
    if (has('submit')) actions.push('submit');
    if (has('publish')) actions.push('publish');
    if (has('archive')) actions.push('archive');
    if (has('unpublish')) actions.push('unpublish');
    // 移入回收站是 DELETE 的批量拼写，不在状态机动作里，有写权限即可。
    actions.push('trash');
    return actions;
  }, [canWrite, selectedItems, trashed]);

  /**
   * 执行批量动作：两个 kind 的选中项按 kind 分组调用（接口一次一个 kind）。
   *
   * 逐条结果由服务端返回，部分成功是正常结果；这里汇总成功 / 失败数并保留
   * 失败条目的 id 与错误码，最后刷新列表、清空选择。
   */
  const runBulk = async (action: BulkAction) => {
    if (!selectedItems.length) return;
    setBulkBusy(action);
    try {
      const byKind = new Map<ContentKind, string[]>();
      for (const item of selectedItems) {
        const ids = byKind.get(item.kind) ?? [];
        ids.push(item.id);
        byKind.set(item.kind, ids);
      }
      let succeeded = 0;
      let failed = 0;
      const failures: { id: string; error: string }[] = [];
      for (const [bulkKind, ids] of byKind) {
        const result = await backend.bulkContentAction(bulkKind, ids, action);
        succeeded += result.succeeded;
        failed += result.failed;
        for (const entry of result.results) {
          if (!entry.ok) failures.push({ id: entry.id, error: entry.error });
        }
      }
      setBulkReport({ action, succeeded, failed, failures });
      toast.push(
        failed > 0 ? 'error' : 'ok',
        t('批量操作完成'),
        t('成功 {succeeded} 项，失败 {failed} 项。', { succeeded, failed }),
      );
      setSelected(new Set());
      data.reload();
    } catch (err) {
      toast.push('error', t('批量操作失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setBulkBusy('');
      setBulkConfirm(null);
    }
  };

  /** 首页精选：置顶一篇 / 取消置顶，或只改它的占格。 */
  const pinOf = (id: string) => customization.pins.find((entry) => entry.id === id);
  const togglePin = (item: Content) => {
    if (pinOf(item.id)) {
      update({ pins: customization.pins.filter((entry) => entry.id !== item.id) });
      toast.push('ok', t('已取消置顶'), t('《{title}》不再出现在首页精选。', { title: item.title }));
      return;
    }
    if (customization.pins.length >= MAX_PINS) {
      toast.push('error', t('最多置顶 {count} 篇', { count: MAX_PINS }), t('先在列表里取消一篇再试。'));
      return;
    }
    update({ pins: [...customization.pins, { id: item.id, span: '1x1' }] });
    toast.push(
      'ok',
      t('已置顶到首页'),
      t('《{title}》排在首页精选第 {position} 位。', {
        title: item.title,
        position: customization.pins.length + 1,
      }),
    );
  };
  const setPinSpan = (id: string, span: TileSpan) => {
    update({ pins: customization.pins.map((entry) => (entry.id === id ? { ...entry, span } : entry)) });
  };

  const runAction = async (item: Content, action: ContentAction, reason?: string) => {
    setBusyId(item.id);
    try {
      const updated = await backend.contentAction(item.kind, item.id, action, reason);
      // 活动日志的 actor / action / detail 会落盘（localStorage），属于存档数据而非实时文案，保持中文。
      noteActivity(
        backend,
        me?.user.display_name ?? '管理员',
        ACTION_LABEL[action],
        item.title,
        `状态：${STATUS_LABEL[updated.status]}`,
      );
      toast.push(
        'ok',
        t('{action}成功', { action: ACTION_LABEL[action] }),
        t('《{title}》现在是「{status}」', {
          title: item.title,
          status: STATUS_LABEL[updated.status],
        }),
      );
      data.reload();
    } catch (err) {
      toast.push(
        'error',
        t('{action}失败', { action: ACTION_LABEL[action] }),
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setBusyId('');
      setConfirming(null);
    }
  };

  const primaryAction = (item: Content): ContentAction | null => {
    if (item.actions.includes('publish')) return 'publish';
    if (item.actions.includes('submit')) return 'submit';
    if (item.actions.includes('restore')) return 'restore';
    if (item.actions.includes('security-retry')) return 'security-retry';
    return null;
  };

  /** 行内动作的按钮/弹窗文案：软删除没有对应的 ContentAction，单独给一个标签。 */
  const rowActionLabel = (action: RowAction): string =>
    action === 'delete' ? t('删除') : ACTION_LABEL[action];

  /** 确认弹窗的说明：只覆盖需要二次确认的几个动作。 */
  const rowActionDescription = (action: RowAction): string => {
    switch (action) {
      case 'archive':
        return t('归档后内容会从公开列表移出，但已有链接仍然有效。');
      case 'restore':
        return t('恢复后内容会重新进入公开列表。');
      case 'undelete':
        return t('内容会回到删除前的状态，可以继续编辑或发布。');
      case 'unpublish':
        return t('撤销后内容会回到草稿，公开链接将不再可访问；之后可以再次发布。');
      case 'delete':
        return t('内容会移入回收站，之后仍然可以恢复。');
      case 'purge':
        return t('彻底删除不可恢复：正文与版本历史都会一起删除。');
      default:
        return '';
    }
  };

  /** 移入回收站：软删除，修订、评论与媒体引用都还在，随时可以恢复。 */
  const runDelete = async (item: Content) => {
    setBusyId(item.id);
    try {
      const updated = await backend.deleteContent(item.kind, item.id);
      // 活动日志会落盘（localStorage），是存档数据；动作名与 runAction 一样取当前语言的标签。
      noteActivity(backend, me?.user.display_name ?? '管理员', t('删除'), item.title, KIND_LABEL[updated.kind]);
      toast.push('ok', t('已移入回收站'), t('《{title}》可以在回收站里恢复。', { title: item.title }));
      data.reload();
    } catch (err) {
      toast.push('error', t('删除失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setBusyId('');
      setConfirming(null);
    }
  };

  /** 彻底删除：不可恢复，成功后条目从两份列表里一起消失。 */
  const runPurge = async (item: Content) => {
    setBusyId(item.id);
    try {
      await backend.purgeContent(item.kind, item.id);
      noteActivity(
        backend,
        me?.user.display_name ?? '管理员',
        ACTION_LABEL.purge,
        item.title,
        KIND_LABEL[item.kind],
      );
      toast.push('ok', t('已彻底删除'), t('《{title}》不会再出现在任何列表里。', { title: item.title }));
      data.reload();
    } catch (err) {
      toast.push('error', t('彻底删除失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setBusyId('');
      setConfirming(null);
    }
  };

  /** 确认弹窗的统一入口：回收站的两个动作走各自接口，其余仍是状态机动作。 */
  const runConfirmed = (item: Content, action: RowAction) => {
    if (action === 'delete') return runDelete(item);
    if (action === 'purge') return runPurge(item);
    return runAction(item, action);
  };

  const statusTabs: { key: StatusFilter; label: string }[] = [
    { key: 'all', label: t('全部') },
    { key: 'published', label: t('已发布') },
    { key: 'pending_review', label: t('待审核') },
    { key: 'draft', label: t('草稿') },
    { key: 'rejected', label: t('已退回') },
    { key: 'pending_security_check', label: t('安全检查中') },
    { key: 'archived', label: t('已归档') },
  ];

  /**
   * 封面缩略图的内容：自定义图片 → 隐藏占位 → 程序化封面。
   *
   * 正常视图与回收站视图只有外层容器不同（可点击进入编辑 / 只读），内容一样。
   */
  const coverThumb = (
    item: Content,
    cover: ArticleCover | undefined,
    visible: ArticleCover | undefined,
  ) => (
    <>
      {visible ? (
        <img
          src={visible.url}
          alt={coverAlt(visible, item.title)}
          loading="lazy"
          style={coverImageStyle(visible)}
        />
      ) : cover?.hidden ? (
        <span className="content-cover-hidden">{t('隐藏')}</span>
      ) : (
        <Cover seed={item.id} label={item.title} ratio="16 / 10" />
      )}
    </>
  );

  return (
    <>
      <div className="admin-page-head">
        <div>
          <h1>{t('内容库')}</h1>
          <p>{t('文章与帖子的统一视图。状态由服务端状态机决定，前端只展示允许的动作。')}</p>
        </div>
        <div className="admin-page-actions">
          <Link to="/admin/content/new/post" className="btn btn-secondary btn-sm">
            {t('新建帖子')}
          </Link>
          <Link to="/admin/content/new/article" className="btn btn-primary btn-sm">
            <Icon name="plus" size={14} /> {t('新建文章')}
          </Link>
        </div>
      </div>

      <div className="toolbar">
        <div className="inline-search" style={{ width: 260 }}>
          <Icon name="search" size={14} />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('搜索标题、摘要或作者')}
            aria-label={t('搜索内容')}
          />
        </div>
        <div className="row gap-6">
          {(
            [
              { key: 'all' as const, label: t('全部类型') },
              { key: 'article' as const, label: t('文章') },
              { key: 'post' as const, label: t('帖子') },
            ]
          ).map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={`pill${kind === entry.key ? ' is-on' : ''}`}
              onClick={() => setKind(entry.key)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {canWrite ? (
          // 回收站与正常列表是互斥视图：切换会重新请求列表（trashed 参数），
          // 而不是在两个本地数组之间过滤。
          <div className="seg" role="group" aria-label={t('视图')}>
            <button
              type="button"
              className={trashed ? '' : 'is-on'}
              aria-pressed={!trashed}
              onClick={() => setTrashed(false)}
            >
              {t('内容')}
            </button>
            <button
              type="button"
              className={trashed ? 'is-on' : ''}
              aria-pressed={trashed}
              onClick={() => setTrashed(true)}
            >
              {t('回收站')}
            </button>
          </div>
        ) : null}
        <span className="toolbar-spacer" />
        <span className="tiny faint">{t('{count} 条', { count: filtered.length })}</span>
        <Button variant="ghost" size="sm" icon="refresh" onClick={data.reload}>
          {t('刷新')}
        </Button>
      </div>

      <Tabs
        value={status}
        onChange={setStatus}
        items={statusTabs.map((tab) => ({
          ...tab,
          count: counts.get(tab.key) ?? 0,
        }))}
      />

      {data.error ? (
        <div className="mt-20">
          <Callout tone="danger" icon="alert" title={t('无法读取内容')}>
            {data.error instanceof Error ? data.error.message : t('请求失败。')}
          </Callout>
        </div>
      ) : null}

      {/* 批量操作栏：有选中项时出现在列表上方；动作按视图、权限与服务端 actions 过滤。 */}
      {selected.size > 0 ? (
        <div className="panel mt-20">
          <div className="panel-body" style={{ paddingTop: 14, paddingBottom: 14 }}>
            <div className="row gap-8" style={{ flexWrap: 'wrap', alignItems: 'center' }} role="group" aria-label={t('批量操作')}>
              <Badge tone="accent">{t('已选择 {count} 项', { count: selected.size })}</Badge>
              {bulkActions.map((action) => (
                <Button
                  key={action}
                  size="sm"
                  variant={
                    action === 'publish'
                      ? 'primary'
                      : dangerBulkActions.includes(action)
                        ? 'danger'
                        : 'secondary'
                  }
                  icon={bulkActionIcon(action)}
                  loading={bulkBusy === action}
                  disabled={!!bulkBusy}
                  onClick={() =>
                    dangerBulkActions.includes(action) ? setBulkConfirm(action) : void runBulk(action)
                  }
                >
                  {bulkActionLabel(action)}
                </Button>
              ))}
              <span className="toolbar-spacer" />
              <Button variant="ghost" size="sm" onClick={clearSelection}>
                {t('清除选择')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 批量结果：成功 / 失败汇总，失败条目带 id 与错误码（契约 G 的逐条结果）。 */}
      {bulkReport ? (
        <div className="mt-20">
          <Callout
            tone={bulkReport.failed > 0 ? 'danger' : 'ok'}
            icon={bulkReport.failed > 0 ? 'alert' : 'check'}
            title={t('成功 {succeeded} 项，失败 {failed} 项。', {
              succeeded: bulkReport.succeeded,
              failed: bulkReport.failed,
            })}
          >
            <p className="small muted" style={{ margin: 0 }}>
              {t('批量操作：{action}', { action: bulkActionLabel(bulkReport.action) })}
            </p>
            {bulkReport.failures.length ? (
              <div className="mt-8">
                <p className="tiny faint" style={{ margin: 0 }}>
                  {t('失败的条目（id · 错误码）：')}
                </p>
                {bulkReport.failures.map((failure) => (
                  <div key={failure.id} className="tiny mono">
                    {t('{id} · {code}', { id: failure.id, code: failure.error || '—' })}
                  </div>
                ))}
              </div>
            ) : null}
            <div className="row gap-8 mt-8">
              <Button variant="ghost" size="sm" onClick={() => setBulkReport(null)}>
                {t('关闭')}
              </Button>
            </div>
          </Callout>
        </div>
      ) : null}

      <div className="panel mt-20">
        {data.loading ? (
          <div className="panel-body">
            <Skeleton lines={7} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="panel-body">
            {trashed ? (
              <EmptyState
                icon="trash"
                title={query || status !== 'all' ? t('没有符合条件的内容') : t('回收站是空的')}
                body={
                  query || status !== 'all'
                    ? t('换一个状态或关键词。列表只包含当前账户可见的内容。')
                    : t('被删除的内容会保留在这里，直到你恢复或彻底删除它们。')
                }
              />
            ) : (
              <EmptyState
                icon="file"
                title={query || status !== 'all' ? t('没有符合条件的内容') : t('内容库还是空的')}
                body={
                  query || status !== 'all'
                    ? t('换一个状态或关键词。列表只包含当前账户可见的内容。')
                    : personal
                      ? t('创建第一篇草稿。')
                      : t('创建第一篇草稿，或者等待成员提交审核。')
                }
                action={
                  <Link to="/admin/content/new/article" className="btn btn-secondary btn-sm">
                    {t('新建草稿')}
                  </Link>
                }
              />
            )}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 34 }}>
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allOnPageSelected}
                      aria-label={t('选择全部')}
                      onChange={toggleAllOnPage}
                    />
                  </th>
                  <th>{t('标题')}</th>
                  <th>{t('封面')}</th>
                  <th>{t('类型')}</th>
                  <th>{t('状态')}</th>
                  <th>{t('阅读量')}</th>
                  <th>{t('首页精选')}</th>
                  <th>{t('作者')}</th>
                  <th>{t('更新时间')}</th>
                  <th style={{ textAlign: 'right' }}>{t('操作')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => {
                  const action = primaryAction(item);
                  const category = taxonomy.categories.find((term) => term.id === item.category_id);
                  const cover = coverOf(customization, item);
                  const visibleCover = cover && !cover.hidden && cover.url ? cover : undefined;
                  const editPath = `/admin/content/${item.kind}/${item.id}`;
                  return (
                    <tr
                      key={item.id}
                      style={selected.has(item.id) ? { background: 'var(--bg-subtle)' } : undefined}
                    >
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(item.id)}
                          aria-label={t('选择《{title}》', { title: item.title })}
                          onChange={() => toggleRow(item.id)}
                        />
                      </td>
                      <td className="cell-title" style={{ maxWidth: 360 }}>
                        {trashed ? (
                          // 回收站里的内容进不了编辑器：服务端只允许 undelete / purge。
                          <span>{item.title}</span>
                        ) : (
                          <Link to={editPath}>{item.title}</Link>
                        )}
                        <div className="tiny faint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.summary || item.slug}
                        </div>
                        <div className="content-list-tags">
                          {category ? (
                            <span className="content-list-cat" style={{ color: category.color }}>
                              {category.name}
                            </span>
                          ) : null}
                          {(item.tags ?? []).slice(0, 3).map((tag) => (
                            <span key={tag} className="content-list-tag">
                              #{tag}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>
                        {trashed ? (
                          // 回收站里的内容进不了编辑器，缩略图只做展示。
                          <span className="content-cover-thumb">
                            {coverThumb(item, cover, visibleCover)}
                          </span>
                        ) : (
                          <Link
                            to={editPath}
                            className="content-cover-thumb"
                            aria-label={t('编辑《{title}》的封面', { title: item.title })}
                            title={
                              visibleCover
                                ? t('自定义封面 · 点击编辑')
                                : cover
                                  ? t('封面已隐藏')
                                  : t('自动生成封面 · 点击编辑')
                            }
                          >
                            {coverThumb(item, cover, visibleCover)}
                            {visibleCover ? <span className="content-cover-flag">{t('自定义')}</span> : null}
                          </Link>
                        )}
                      </td>
                      <td>
                        <Badge tone="muted">{KIND_LABEL[item.kind]}</Badge>
                      </td>
                      <td>
                        <StatusBadge status={item.status} />
                        {item.deleted_at ? (
                          <div className="tiny faint nowrap">
                            {t('已删除于 {time}', { time: formatDateTime(item.deleted_at) })}
                          </div>
                        ) : null}
                        {item.status === 'draft' && item.publish_at ? (
                          <div className="tiny faint nowrap">
                            {t('预约 {time}', { time: formatDateTime(item.publish_at) })}
                          </div>
                        ) : null}
                        {item.access_mode && item.access_mode !== 'public' ? (
                          <div className="tiny faint nowrap">
                            {item.access_mode === 'password' ? t('密码访问') : t('仅登录读者')}
                          </div>
                        ) : null}
                      </td>
                      <td className="tiny muted nowrap">
                        {/* 服务端去重后的单篇阅读量（FSD A-16）；草稿恒为 0。 */}
                        {item.view_count ?? 0}
                      </td>
                      <td>
                        {trashed ? (
                          // 回收站里的内容不在首页精选的候选范围里，整格不显示置顶开关。
                          <span className="tiny faint">—</span>
                        ) : (
                          <div className="pin-cell">
                            <button
                              type="button"
                              role="switch"
                              aria-checked={!!pinOf(item.id)}
                              aria-label={t('{title} 置顶到首页', { title: item.title })}
                              title={item.status === 'published' ? t('置顶到首页精选') : t('草稿不会出现在首页')}
                              className={`switch${pinOf(item.id) ? ' is-on' : ''}`}
                              onClick={() => togglePin(item)}
                            >
                              <span />
                            </button>
                            {pinOf(item.id) ? (
                              <Select
                                value={pinOf(item.id)?.span ?? '1x1'}
                                aria-label={t('占格大小')}
                                onChange={(event) => setPinSpan(item.id, event.target.value as TileSpan)}
                              >
                                {TILE_SPANS.map((span) => (
                                  <option key={span.value} value={span.value}>
                                    {span.label}
                                  </option>
                                ))}
                              </Select>
                            ) : (
                              <span className="tiny faint">—</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td>{item.author_name ?? '—'}</td>
                      <td className="tiny muted nowrap">{formatDateTime(item.updated_at)}</td>
                      <td className="cell-actions">
                        <div className="row gap-4" style={{ justifyContent: 'flex-end' }}>
                          {trashed ? (
                            canWrite ? (
                              <>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  icon="refresh"
                                  loading={busyId === item.id}
                                  onClick={() => void runAction(item, 'undelete')}
                                >
                                  {ACTION_LABEL.undelete}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="danger"
                                  icon="trash"
                                  disabled={busyId === item.id}
                                  onClick={() => setConfirming({ item, action: 'purge' })}
                                >
                                  {ACTION_LABEL.purge}
                                </Button>
                              </>
                            ) : (
                              <span className="tiny faint">{t('只读')}</span>
                            )
                          ) : (
                            <>
                              {action ? (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  loading={busyId === item.id}
                                  onClick={() =>
                                    action === 'archive' || action === 'restore'
                                      ? setConfirming({ item, action })
                                      : void runAction(item, action)
                                  }
                                >
                                  {ACTION_LABEL[action]}
                                </Button>
                              ) : null}
                              {canWrite && item.actions.includes('unpublish') ? (
                                // 契约 I：published → draft，会让公开链接立即失效，走确认弹窗。
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  icon="x-circle"
                                  disabled={busyId === item.id}
                                  onClick={() => setConfirming({ item, action: 'unpublish' })}
                                >
                                  {ACTION_LABEL.unpublish}
                                </Button>
                              ) : null}
                              {!personal && item.actions.includes('reject') ? (
                                <Link to="/admin/review" className="btn btn-ghost btn-sm">
                                  {t('去审核')}
                                </Link>
                              ) : null}
                              {canWrite ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  icon="trash"
                                  disabled={busyId === item.id}
                                  onClick={() => setConfirming({ item, action: 'delete' })}
                                >
                                  {t('删除')}
                                </Button>
                              ) : null}
                              <Link to={editPath} className="btn btn-ghost btn-sm">
                                {t('编辑')}
                              </Link>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="tiny faint mt-16">
        {t('列表最多载入每种类型 100 条，状态筛选在浏览器内完成。站点管理员权限：{status}。', {
          status: isSiteAdmin(me?.role) ? t('已具备') : t('不具备（不影响内容操作）'),
        })}
      </p>

      <Modal
        open={!!confirming}
        title={
          confirming
            ? t('{action}《{title}》？', {
                action: rowActionLabel(confirming.action),
                title: confirming.item.title,
              })
            : ''
        }
        description={confirming ? rowActionDescription(confirming.action) : undefined}
        onClose={() => setConfirming(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              {t('取消')}
            </Button>
            <Button
              variant={
                confirming && ['archive', 'unpublish', 'delete', 'purge'].includes(confirming.action)
                  ? 'danger'
                  : 'primary'
              }
              loading={busyId === confirming?.item.id}
              onClick={() => confirming && void runConfirmed(confirming.item, confirming.action)}
            >
              {confirming ? t('确认{action}', { action: rowActionLabel(confirming.action) }) : t('确认')}
            </Button>
          </>
        }
      />
      {/* 批量危险动作的二次确认：列出动作与数量，确认后才发请求。 */}
      <Modal
        open={!!bulkConfirm}
        title={
          bulkConfirm
            ? t('对选中的 {count} 项执行「{action}」？', {
                count: selected.size,
                action: bulkActionLabel(bulkConfirm),
              })
            : ''
        }
        description={bulkConfirm ? bulkActionDescription(bulkConfirm) : undefined}
        onClose={() => {
          if (!bulkBusy) setBulkConfirm(null);
        }}
        footer={
          <>
            <Button variant="ghost" disabled={!!bulkBusy} onClick={() => setBulkConfirm(null)}>
              {t('取消')}
            </Button>
            <Button
              variant="danger"
              loading={bulkBusy === bulkConfirm}
              onClick={() => bulkConfirm && void runBulk(bulkConfirm)}
            >
              {bulkConfirm ? t('确认{action}', { action: bulkActionLabel(bulkConfirm) }) : t('确认')}
            </Button>
          </>
        }
      />
    </>
  );
}
