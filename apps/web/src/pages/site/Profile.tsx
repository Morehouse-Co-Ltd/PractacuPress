import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../lib/session';
import { useBackend, isDemo } from '../../lib/backend';
import { useAsync } from '../../lib/hooks';
import { formatDate, ROLE_LABEL, readingTime } from '../../lib/format';
import { isPersonalSite } from '../../lib/site';
import { usePermissions } from '../../lib/usePermissions';
import { Button, EmptyState, Skeleton } from '../../components/ui';
import { Avatar } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useToast } from '../../lib/toast';
import { useSeo, personJsonLd } from '../../lib/seo';

export function ProfilePage() {
  const { id = '' } = useParams();
  const { me, site, config } = useAuth();
  const { can } = usePermissions();
  const backend = useBackend();
  const personal = isPersonalSite(config);
  const demo = isDemo(backend) ? backend : null;
  const toast = useToast();
  const [following, setFollowing] = useState(false);
  const [busy, setBusy] = useState(false);

  const profile = useAsync(async () => backend.publicUser(id), [backend, id]);

  const authored = useAsync(async () => {
    const [articles, posts] = await Promise.all([
      backend.listContent('article', { limit: 100, authorId: id }),
      backend.listContent('post', { limit: 100, authorId: id }),
    ]);
    return [...articles.items, ...posts.items]
      .filter((entry) => entry.status === 'published')
      .sort((a, b) => (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at));
  }, [backend, id]);

  useEffect(() => {
    if (!demo) return;
    demo.demoFollowing().then((ids) => setFollowing(ids.includes(id)));
  }, [demo, id]);

  const name = profile.data?.display_name ?? (profile.loading ? '' : '未知用户');
  useSeo({
    title: name || '成员',
    path: `/u/${id}`,
    type: 'profile',
    description: name ? `${name} 在 ${site?.name ?? '本站'} 主页与已发布内容。` : undefined,
    jsonLd: name
      ? [personJsonLd({ name, url: `${window.location.origin}/u/${id}` })]
      : [],
  });

  const toggleFollow = async () => {
    if (!me) return;
    setBusy(true);
    try {
      const result = await backend.toggleFollow(id);
      setFollowing(result.active);
      toast.push('ok', result.active ? '已关注' : '已取消关注');
    } catch (err) {
      toast.push('error', '操作失败', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  if (profile.loading) {
    return (
      <div className="shell">
        <div className="mt-32">
          <Skeleton lines={5} />
        </div>
      </div>
    );
  }

  if (!profile.data) {
    return (
      <div className="shell">
        <div style={{ paddingTop: 56 }}>
          <EmptyState
            icon="user"
            title="无法打开这个主页"
            body="这位成员不在当前站点里，或主页还没有公开。"
            action={
              <Link to="/" className="btn btn-secondary btn-sm">
                返回首页
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const user = profile.data;
  const own = me?.user.id === id;
  const role = user.role;

  return (
    <div className="shell">
      <header className="profile-head">
        <Avatar name={user.display_name} size={76} />
        <div>
          <h1>{user.display_name}</h1>
          <p>
            {role ? `${ROLE_LABEL[role as keyof typeof ROLE_LABEL]} · ` : ''}
            加入于 {formatDate(user.created_at)} · {site?.name ?? '本站'}
          </p>
        </div>
        <div className="profile-actions">
          {own ? (
            <>
              <Link to="/notifications" className="btn btn-secondary btn-sm">
                我的通知
              </Link>
              {can('moderate_content') || can('manage_site') ? (
                <Link to="/admin" className="btn btn-primary btn-sm">
                  管理后台
                </Link>
              ) : null}
            </>
          ) : me ? (
            <Button
              variant={following ? 'secondary' : 'primary'}
              size="sm"
              icon={following ? 'check' : 'plus'}
              loading={busy}
              onClick={toggleFollow}
            >
              {following ? '已关注' : '关注'}
            </Button>
          ) : personal ? null : (
            <Link to={`/login?next=${encodeURIComponent(`/u/${id}`)}`} className="btn btn-primary btn-sm">
              登录后关注
            </Link>
          )}
        </div>
      </header>

      <div className="profile-stats">
        <div>
          <b>{authored.data?.length ?? 0}</b>
          <span>已发布内容</span>
        </div>
        <div>
          <b className="is-small">{formatDate(user.created_at)}</b>
          <span>加入时间</span>
        </div>
        <div>
          <b className="is-small">{own ? '本人' : following ? '已关注' : '未关注'}</b>
          <span>关注状态</span>
        </div>
      </div>

      <section className="mt-32">
        <div className="section-head">
          <h2 style={{ fontSize: 24 }}>{own ? '我的文章与帖子' : 'TA 的文章与帖子'}</h2>
          <span className="tiny faint">{authored.data?.length ?? 0} 篇</span>
        </div>

        {authored.loading ? (
          <Skeleton lines={5} />
        ) : !authored.data?.length ? (
          <EmptyState compact icon="file" title="还没有已发布的内容" body="草稿与被退回的稿子不会出现在公开主页。" />
        ) : (
          <div className="archive-list">
            {authored.data.map((entry) => (
              <article className="archive-item" key={entry.id}>
                <span className="archive-date">{formatDate(entry.published_at ?? entry.created_at)}</span>
                <div>
                  <div className="row gap-8 mb-8">
                    <span className="chip">{entry.kind === 'article' ? '文章' : '帖子'}</span>
                    <span className="tiny faint">{readingTime(entry.rendered_html)} 分钟</span>
                  </div>
                  <h2>
                    <Link to={`/${entry.kind === 'article' ? 'a' : 'p'}/${entry.id}`}>{entry.title}</Link>
                  </h2>
                  <p>{entry.summary ?? ''}</p>
                </div>
                <span className="archive-author">
                  <Icon name="arrow-up-right" size={13} />
                </span>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
