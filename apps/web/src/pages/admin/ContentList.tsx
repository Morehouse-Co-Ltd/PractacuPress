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

export function ContentListPage() {
  const t = useT();
  const { me } = useAuth();
  const { personal } = usePermissions();
  const backend = useBackend();
  const toast = useToast();
  const { customization, update } = useCustomization();
  const { taxonomy } = useTaxonomy();
  const [status, setStatus] = useState<StatusFilter>('all');
  const [kind, setKind] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState('');
  const [confirming, setConfirming] = useState<{ item: Content; action: ContentAction } | null>(null);
  useTitle(t('内容库'));

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

  const statusTabs: { key: StatusFilter; label: string }[] = [
    { key: 'all', label: t('全部') },
    { key: 'published', label: t('已发布') },
    { key: 'pending_review', label: t('待审核') },
    { key: 'draft', label: t('草稿') },
    { key: 'rejected', label: t('已退回') },
    { key: 'pending_security_check', label: t('安全检查中') },
    { key: 'archived', label: t('已归档') },
  ];

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

      <div className="panel mt-20">
        {data.loading ? (
          <div className="panel-body">
            <Skeleton lines={7} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="panel-body">
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
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
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
                          aria-label={t('编辑《{title}》的封面', { title: item.title })}
                          title={
                            visibleCover
                              ? t('自定义封面 · 点击编辑')
                              : cover
                                ? t('封面已隐藏')
                                : t('自动生成封面 · 点击编辑')
                          }
                        >
                          {visibleCover ? (
                            <img
                              src={visibleCover.url}
                              alt={coverAlt(visibleCover, item.title)}
                              loading="lazy"
                              style={coverImageStyle(visibleCover)}
                            />
                          ) : cover?.hidden ? (
                            <span className="content-cover-hidden">{t('隐藏')}</span>
                          ) : (
                            <Cover seed={item.id} label={item.title} ratio="16 / 10" />
                          )}
                          {visibleCover ? <span className="content-cover-flag">{t('自定义')}</span> : null}
                        </Link>
                      </td>
                      <td>
                        <Badge tone="muted">{KIND_LABEL[item.kind]}</Badge>
                      </td>
                      <td>
                        <StatusBadge status={item.status} />
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
                          {!personal && item.actions.includes('reject') ? (
                            <Link to="/admin/review" className="btn btn-ghost btn-sm">
                              {t('去审核')}
                            </Link>
                          ) : null}
                          <Link to={`/admin/content/${item.kind}/${item.id}`} className="btn btn-ghost btn-sm">
                            {t('编辑')}
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
        {t('列表最多载入每种类型 100 条，状态筛选在浏览器内完成。站点管理员权限：{status}。', {
          status: isSiteAdmin(me?.role) ? t('已具备') : t('不具备（不影响内容操作）'),
        })}
      </p>

      <Modal
        open={!!confirming}
        title={
          confirming
            ? t('{action}《{title}》？', {
                action: ACTION_LABEL[confirming.action],
                title: confirming.item.title,
              })
            : ''
        }
        description={
          confirming?.action === 'archive'
            ? t('归档后内容会从公开列表移出，但已有链接仍然有效。')
            : t('恢复后内容会重新进入公开列表。')
        }
        onClose={() => setConfirming(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              {t('取消')}
            </Button>
            <Button
              variant={confirming?.action === 'archive' ? 'danger' : 'primary'}
              loading={busyId === confirming?.item.id}
              onClick={() => confirming && void runAction(confirming.item, confirming.action)}
            >
              {confirming ? t('确认{action}', { action: ACTION_LABEL[confirming.action] }) : t('确认')}
            </Button>
          </>
        }
      />
    </>
  );
}
