import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type {
  FollowEntry,
  InteractionEntry,
  Page,
  PublicProfile,
  ReadingHistoryEntry,
} from '../../types';
import { useBackend } from '../../lib/backend';
import { useAuth } from '../../lib/session';
import { useAsync, useTitle } from '../../lib/hooks';
import { formatDate } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { useT } from '../../lib/i18n';
import { Avatar, Button, EmptyState, PageLoading, Tabs } from '../../components/ui';
import { Icon } from '../../components/Icon';

/** 个人中心的五个视图；路由参数直接使用同一组键。 */
type MeTab = 'bookmarks' | 'likes' | 'history' | 'following' | 'followers' | 'members';

const TABS: MeTab[] = ['bookmarks', 'likes', 'history', 'following', 'followers', 'members'];

function isTab(value: string | undefined): value is MeTab {
  return !!value && (TABS as string[]).includes(value);
}

function contentPath(entry: { target_id: string; kind?: string; target_type: string }): string {
  const kind = entry.kind ?? entry.target_type;
  return `/${kind === 'post' ? 'p' : 'a'}/${entry.target_id}`;
}

/** 我的收藏 / 我的点赞 / 阅读历史共用一个卡片列表。 */
function InteractionPanel({ tab }: { tab: 'bookmarks' | 'likes' | 'history' }) {
  const t = useT();
  const backend = useBackend();
  const toast = useToast();
  const [busyId, setBusyId] = useState('');
  const page = useAsync<Page<InteractionEntry> | Page<ReadingHistoryEntry>>(async () => {
    if (tab === 'bookmarks') return backend.bookmarks({ limit: 50 });
    if (tab === 'likes') return backend.likes({ limit: 50 });
    return backend.readingHistory({ limit: 50 });
  }, [backend, tab]);

  const remove = useCallback(
    async (entry: InteractionEntry) => {
      setBusyId(entry.target_id);
      try {
        if (tab === 'bookmarks') {
          await backend.toggleBookmark(
            entry.target_type === 'post' ? 'post' : 'article',
            entry.target_id,
            false,
          );
          toast.push('ok', t('已取消收藏'));
        } else {
          await backend.toggleReaction(
            entry.target_type === 'post' ? 'post' : 'article',
            entry.target_id,
            'like',
            false,
          );
          toast.push('ok', t('已取消点赞'));
        }
        page.reload();
      } catch (err) {
        toast.push('error', t('操作失败'), err instanceof Error ? err.message : undefined);
      } finally {
        setBusyId('');
      }
    },
    [backend, page, t, tab, toast],
  );

  if (page.loading) return <PageLoading label={t('正在载入')} />;
  if (page.error) {
    return (
      <EmptyState
        icon="alert"
        title={t('无法载入')}
        body={page.error instanceof Error ? page.error.message : t('请稍后重试。')}
      />
    );
  }

  const items = page.data?.items ?? [];
  if (!items.length) {
    return (
      <EmptyState
        icon={tab === 'history' ? 'clock' : tab === 'likes' ? 'thumb' : 'bookmark'}
        title={
          tab === 'history'
            ? t('还没有阅读记录')
            : tab === 'likes'
              ? t('还没有点赞')
              : t('还没有收藏')
        }
        body={t('浏览内容时产生的记录会出现在这里。')}
        action={
          <Link to="/articles" className="btn btn-secondary btn-sm">
            {t('去看看文章')}
          </Link>
        }
      />
    );
  }

  return (
    <div className="archive-list">
      {items.map((entry) => {
        const reading = 'last_viewed_at' in entry;
        return (
          <article className="archive-item" key={`${entry.target_type}:${entry.target_id}`}>
            <span className="archive-date">
              {formatDate(reading ? entry.last_viewed_at : entry.created_at)}
            </span>
            <div>
              <div className="row gap-8 mb-8" style={{ flexWrap: 'wrap' }}>
                <span className="chip">{entry.kind === 'post' ? t('帖子') : t('文章')}</span>
                {reading ? (
                  <span className="tiny faint">
                    {t('读过 {count} 次', { count: entry.view_count })}
                  </span>
                ) : null}
                {!entry.available ? <span className="chip">{t('已不可见')}</span> : null}
              </div>
              <h2>
                {entry.available ? (
                  <Link to={contentPath(entry)}>{entry.title || entry.target_id}</Link>
                ) : (
                  entry.title || entry.target_id
                )}
              </h2>
              {entry.summary ? <p>{entry.summary}</p> : null}
              {entry.author_name ? <span className="tiny faint">{entry.author_name}</span> : null}
            </div>
            {tab !== 'history' ? (
              <Button
                variant="quiet"
                size="sm"
                loading={busyId === entry.target_id}
                onClick={() => void remove(entry as InteractionEntry)}
              >
                {tab === 'bookmarks' ? t('取消收藏') : t('取消点赞')}
              </Button>
            ) : (
              <span className="archive-author" aria-hidden="true">
                <Icon name="arrow-up-right" size={13} />
              </span>
            )}
          </article>
        );
      })}
    </div>
  );
}

/** 关注与粉丝列表：关注列表可以就地取消关注。 */
function FollowPanel({ mode }: { mode: 'following' | 'followers' }) {
  const t = useT();
  const backend = useBackend();
  const toast = useToast();
  const [busyId, setBusyId] = useState('');
  const page = useAsync<Page<FollowEntry>>(
    () =>
      mode === 'following'
        ? backend.following({ limit: 50 })
        : backend.followers({ limit: 50 }),
    [backend, mode],
  );

  const unfollow = async (userId: string) => {
    setBusyId(userId);
    try {
      await backend.toggleFollow(userId, false);
      toast.push('ok', t('已取消关注'));
      page.reload();
    } catch (err) {
      toast.push('error', t('操作失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setBusyId('');
    }
  };

  if (page.loading) return <PageLoading label={t('正在载入')} />;
  if (page.error) {
    return (
      <EmptyState
        icon="alert"
        title={t('无法载入')}
        body={page.error instanceof Error ? page.error.message : t('请稍后重试。')}
      />
    );
  }

  const items = page.data?.items ?? [];
  if (!items.length) {
    return (
      <EmptyState
        icon="user"
        title={mode === 'following' ? t('还没有关注任何人') : t('还没有粉丝')}
        body={
          mode === 'following'
            ? t('在作者主页点“关注”，这里会列出来。')
            : t('当其他成员关注你时，他们会出现在这里。')
        }
        action={
          <Link to="/me/members" className="btn btn-secondary btn-sm">
            {t('发现成员')}
          </Link>
        }
      />
    );
  }

  return (
    <div className="archive-list">
      {items.map((entry) => (
        <article className="archive-item" key={entry.user_id}>
          <Avatar name={entry.display_name} size={38} />
          <div>
            <h2>
              <Link to={`/u/${entry.user_id}`}>{entry.display_name}</Link>
            </h2>
            {entry.bio ? <p>{entry.bio}</p> : null}
            <span className="tiny faint">{t('自 {date}', { date: formatDate(entry.since) })}</span>
          </div>
          {mode === 'following' ? (
            <Button
              variant="quiet"
              size="sm"
              loading={busyId === entry.user_id}
              onClick={() => void unfollow(entry.user_id)}
            >
              {t('取消关注')}
            </Button>
          ) : (
            <Link to={`/u/${entry.user_id}`} className="archive-author">
              <Icon name="arrow-up-right" size={13} />
            </Link>
          )}
        </article>
      ))}
    </div>
  );
}

/** 成员目录：私信页的“新会话”也从同一个端点取候选成员。 */
function MembersPanel() {
  const t = useT();
  const backend = useBackend();
  const { me } = useAuth();
  const [query, setQuery] = useState('');
  const page = useAsync<PublicProfile[]>(
    () => backend.memberDirectory({ query: query.trim(), limit: 100 }),
    [backend, query],
  );
  const items = (page.data ?? []).filter((user) => user.user_id !== me?.user.id);

  return (
    <div>
      <div className="row gap-8 mb-16">
        <input
          className="input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('搜索成员昵称')}
          maxLength={120}
          aria-label={t('搜索成员昵称')}
        />
      </div>
      {page.loading ? (
        <PageLoading label={t('正在载入')} />
      ) : !items.length ? (
        <EmptyState icon="user" title={t('没有找到成员')} body={t('换个关键词再试一次。')} />
      ) : (
        <div className="archive-list">
          {items.map((user) => (
            <article className="archive-item" key={user.user_id}>
              <Avatar name={user.display_name} size={38} />
              <div>
                <h2>
                  <Link to={`/u/${user.user_id}`}>{user.display_name}</Link>
                </h2>
                {user.bio ? <p>{user.bio}</p> : null}
              </div>
              <Link to={`/u/${user.user_id}`} className="btn btn-secondary btn-sm">
                {t('查看主页')}
              </Link>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export function MePage() {
  const t = useT();
  const { tab: rawTab } = useParams();
  const navigate = useNavigate();
  useTitle(t('我的互动'));
  const tab: MeTab = isTab(rawTab) ? rawTab : 'bookmarks';

  const labels: Record<MeTab, string> = {
    bookmarks: t('我的收藏'),
    likes: t('我的点赞'),
    history: t('阅读历史'),
    following: t('关注'),
    followers: t('粉丝'),
    members: t('成员目录'),
  };

  return (
    <div className="shell shell-narrow">
      <header className="page-head">
        <p className="eyebrow">Me</p>
        <h1>{t('我的互动')}</h1>
        <p>{t('收藏、点赞、阅读历史，以及你关注的人和关注你的人。只有本人能看到这些列表。')}</p>
        <div className="page-head-row">
          <Tabs<MeTab>
            value={tab}
            onChange={(next) => navigate(`/me/${next}`)}
            items={TABS.map((key) => ({ key, label: labels[key] }))}
          />
          <Link to="/messages" className="btn btn-secondary btn-sm">
            {t('私信')}
          </Link>
        </div>
      </header>

      {tab === 'bookmarks' || tab === 'likes' || tab === 'history' ? (
        <InteractionPanel tab={tab} />
      ) : tab === 'following' || tab === 'followers' ? (
        <FollowPanel mode={tab} />
      ) : (
        <MembersPanel />
      )}
    </div>
  );
}
