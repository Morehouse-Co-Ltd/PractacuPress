import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Content, ContentAction, ContentKind, ContentStatus, TileSpan } from '../../types';
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
import { useToast } from '../../lib/toast';

type StatusFilter = 'all' | ContentStatus;
type KindFilter = 'all' | ContentKind;

const STATUS_TABS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'published', label: '已发布' },
  { key: 'pending_review', label: '待审核' },
  { key: 'draft', label: '草稿' },
  { key: 'rejected', label: '已退回' },
  { key: 'pending_security_check', label: '安全检查中' },
  { key: 'archived', label: '已归档' },
];

export function ContentListPage() {
  const { me } = useAuth();
  const backend = useBackend();
  const toast = useToast();
  const { customization, update } = useCustomization();
  const { taxonomy } = useTaxonomy();
  const [status, setStatus] = useState<StatusFilter>('all');
  const [kind, setKind] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState('');
  const [confirming, setConfirming] = useState<{ item: Content; action: ContentAction } | null>(null);
  useTitle('内容库');

  const data = useAsync(async () => {
    const [articles, posts] = await Promise.all([
      backend.listContent('article', { limit: 100 }),
      backend.listContent('post', { limit: 100 }),
    ]);
    return [...articles.items, ...posts.items].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }, [backend]);

  const items = data.data ?? [];
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return items.filter((item) => {
      if (kind !== 'all' && item.kind !== kind) return false;
      if (status !== 'all' && item.status !== status) return false;
      if (term && !`${item.title} ${item.summary ?? ''} ${item.author_name ?? ''}`.toLowerCase().includes(term)) {
        return false;
      }
      return true;
    });
  }, [items, kind, status, query]);

  const counts = useMemo(() => {
    const map = new Map<StatusFilter, number>();
    map.set('all', items.length);
    for (const item of items) map.set(item.status, (map.get(item.status) ?? 0) + 1);
    return map;
  }, [items]);

  /** 首页精选：置顶一篇 / 取消置顶，或只改它的占格。 */
  const pinOf = (id: string) => customization.pins.find((entry) => entry.id === id);
  const togglePin = (item: Content) => {
    if (pinOf(item.id)) {
      update({ pins: customization.pins.filter((entry) => entry.id !== item.id) });
      toast.push('ok', '已取消置顶', `《${item.title}》不再出现在首页精选。`);
      return;
    }
    if (customization.pins.length >= MAX_PINS) {
      toast.push('error', `最多置顶 ${MAX_PINS} 篇`, '先在列表里取消一篇再试。');
      return;
    }
    update({ pins: [...customization.pins, { id: item.id, span: '1x1' }] });
    toast.push('ok', '已置顶到首页', `《${item.title}》排在首页精选第 ${customization.pins.length + 1} 位。`);
  };
  const setPinSpan = (id: string, span: TileSpan) => {
    update({ pins: customization.pins.map((entry) => (entry.id === id ? { ...entry, span } : entry)) });
  };

  const runAction = async (item: Content, action: ContentAction, reason?: string) => {
    setBusyId(item.id);
    try {
      const updated = await backend.contentAction(item.kind, item.id, action, reason);
      noteActivity(
        backend,
        me?.user.display_name ?? '管理员',
        ACTION_LABEL[action],
        item.title,
        `状态：${STATUS_LABEL[updated.status]}`,
      );
      toast.push('ok', `${ACTION_LABEL[action]}成功`, `《${item.title}》现在是「${STATUS_LABEL[updated.status]}」`);
      data.reload();
    } catch (err) {
      toast.push('error', `${ACTION_LABEL[action]}失败`, err instanceof Error ? err.message : undefined);
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

  return (
    <>
      <div className="admin-page-head">
        <div>
          <h1>内容库</h1>
          <p>文章与帖子的统一视图。状态由服务端状态机决定，前端只展示允许的动作。</p>
        </div>
        <div className="admin-page-actions">
          <Link to="/admin/content/new/post" className="btn btn-secondary btn-sm">
            新建帖子
          </Link>
          <Link to="/admin/content/new/article" className="btn btn-primary btn-sm">
            <Icon name="plus" size={14} /> 新建文章
          </Link>
        </div>
      </div>

      <div className="toolbar">
        <div className="inline-search" style={{ width: 260 }}>
          <Icon name="search" size={14} />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题、摘要或作者"
            aria-label="搜索内容"
          />
        </div>
        <div className="row gap-6">
          {(
            [
              { key: 'all' as const, label: '全部类型' },
              { key: 'article' as const, label: '文章' },
              { key: 'post' as const, label: '帖子' },
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
        <span className="toolbar-spacer" />
        <span className="tiny faint">{filtered.length} 条</span>
        <Button variant="ghost" size="sm" icon="refresh" onClick={data.reload}>
          刷新
        </Button>
      </div>

      <Tabs
        value={status}
        onChange={setStatus}
        items={STATUS_TABS.map((tab) => ({
          ...tab,
          count: counts.get(tab.key) ?? 0,
        }))}
      />

      {data.error ? (
        <div className="mt-20">
          <Callout tone="danger" icon="alert" title="无法读取内容">
            {data.error instanceof Error ? data.error.message : '请求失败。'}
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
            <EmptyState
              icon="file"
              title={query || status !== 'all' ? '没有符合条件的内容' : '内容库还是空的'}
              body={
                query || status !== 'all'
                  ? '换一个状态或关键词。列表只包含当前账户可见的内容。'
                  : '创建第一篇草稿，或者等待成员提交审核。'
              }
              action={
                <Link to="/admin/content/new/article" className="btn btn-secondary btn-sm">
                  新建草稿
                </Link>
              }
            />
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>标题</th>
                  <th>封面</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th>首页精选</th>
                  <th>作者</th>
                  <th>更新时间</th>
                  <th style={{ textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => {
                  const action = primaryAction(item);
                  const category = taxonomy.categories.find((term) => term.id === item.category_id);
                  const cover = coverFor(customization, item.id);
                  const visibleCover = cover && !cover.hidden && cover.url ? cover : undefined;
                  return (
                    <tr key={item.id}>
                      <td className="cell-title" style={{ maxWidth: 360 }}>
                        <Link to={`/admin/content/${item.kind}/${item.id}`}>{item.title}</Link>
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
                        <Link
                          to={`/admin/content/${item.kind}/${item.id}`}
                          className="content-cover-thumb"
                          aria-label={`编辑《${item.title}》的封面`}
                          title={visibleCover ? '自定义封面 · 点击编辑' : cover ? '封面已隐藏' : '自动生成封面 · 点击编辑'}
                        >
                          {visibleCover ? (
                            <img
                              src={visibleCover.url}
                              alt={coverAlt(visibleCover, item.title)}
                              loading="lazy"
                              style={coverImageStyle(visibleCover)}
                            />
                          ) : cover?.hidden ? (
                            <span className="content-cover-hidden">隐藏</span>
                          ) : (
                            <Cover seed={item.id} label={item.title} ratio="16 / 10" />
                          )}
                          {visibleCover ? <span className="content-cover-flag">自定义</span> : null}
                        </Link>
                      </td>
                      <td>
                        <Badge tone="muted">{KIND_LABEL[item.kind]}</Badge>
                      </td>
                      <td>
                        <StatusBadge status={item.status} />
                      </td>
                      <td>
                        <div className="pin-cell">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={!!pinOf(item.id)}
                            aria-label={`${item.title} 置顶到首页`}
                            title={item.status === 'published' ? '置顶到首页精选' : '草稿不会出现在首页'}
                            className={`switch${pinOf(item.id) ? ' is-on' : ''}`}
                            onClick={() => togglePin(item)}
                          >
                            <span />
                          </button>
                          {pinOf(item.id) ? (
                            <Select
                              value={pinOf(item.id)?.span ?? '1x1'}
                              aria-label="占格大小"
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
                      </td>
                      <td>{item.author_name ?? '—'}</td>
                      <td className="tiny muted nowrap">{formatDateTime(item.updated_at)}</td>
                      <td className="cell-actions">
                        <div className="row gap-4" style={{ justifyContent: 'flex-end' }}>
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
                          {item.actions.includes('reject') ? (
                            <Link to="/admin/review" className="btn btn-ghost btn-sm">
                              去审核
                            </Link>
                          ) : null}
                          <Link to={`/admin/content/${item.kind}/${item.id}`} className="btn btn-ghost btn-sm">
                            编辑
                          </Link>
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
        列表最多载入每种类型 100 条，状态筛选在浏览器内完成。站点管理员权限：
        {isSiteAdmin(me?.role) ? '已具备' : '不具备（不影响内容操作）'}。
      </p>

      <Modal
        open={!!confirming}
        title={confirming ? `${ACTION_LABEL[confirming.action]}《${confirming.item.title}》？` : ''}
        description={
          confirming?.action === 'archive'
            ? '归档后内容会从公开列表移出，但已有链接仍然有效。'
            : '恢复后内容会重新进入公开列表。'
        }
        onClose={() => setConfirming(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              取消
            </Button>
            <Button
              variant={confirming?.action === 'archive' ? 'danger' : 'primary'}
              loading={busyId === confirming?.item.id}
              onClick={() => confirming && void runAction(confirming.item, confirming.action)}
            >
              确认{confirming ? ACTION_LABEL[confirming.action] : ''}
            </Button>
          </>
        }
      />
    </>
  );
}
