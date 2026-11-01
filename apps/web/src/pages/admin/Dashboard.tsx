import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/session';
import { useBackend, isDemo } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { readActivity } from '../../lib/activity';
import {
  formatDateTime,
  isSiteAdmin,
  STATUS_LABEL,
  activityTone,
} from '../../lib/format';
import { Badge, Button, Callout } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { DashboardAnalytics, DashboardPopular, DashboardRecent } from '../../components/DashboardInsights';

export function DashboardPage() {
  const { me, site } = useAuth();
  const backend = useBackend();
  const demo = isDemo(backend) ? backend : null;
  useTitle('仪表盘');

  const data = useAsync(async () => {
    const [articles, posts] = await Promise.all([
      backend.listContent('article', { limit: 100 }),
      backend.listContent('post', { limit: 100 }),
    ]);
    const members =
      me && isSiteAdmin(me.role) ? await backend.members(me.site_id).catch(() => []) : [];
    const activity = demo ? await demo.activity() : readActivity();
    return { articles: articles.items, posts: posts.items, members, activity };
  }, [backend, demo, me]);

  const all = [...(data.data?.articles ?? []), ...(data.data?.posts ?? [])].sort((a, b) =>
    b.updated_at.localeCompare(a.updated_at),
  );
  const published = all.filter((item) => item.status === 'published');
  const review = all.filter((item) => item.status === 'pending_review');
  const drafts = all.filter((item) => ['draft', 'rejected', 'pending_security_check'].includes(item.status));
  const hour = new Date().getHours();
  const greeting = hour < 6 ? '夜里好' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';

  return (
    <>
      <div className="admin-page-head">
        <div>
          <h1>
            {greeting}，{me?.user.display_name ?? '编辑'}
          </h1>
          <p>
            {site?.name ?? '站点'} · 今天是 {new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}
          </p>
        </div>
        <div className="admin-page-actions">
          <Link to="/admin/content/new/post" className="btn btn-secondary btn-sm">
            新建帖子
          </Link>
          <Link to="/admin/content/new/article" className="btn btn-primary btn-sm">
            <Icon name="edit" size={14} /> 新建文章
          </Link>
        </div>
      </div>

      {data.error ? (
        <Callout tone="danger" icon="alert" title="无法读取后台数据">
          {data.error instanceof Error ? data.error.message : '请求失败。'}
          <div className="mt-12">
            <Button variant="secondary" size="sm" onClick={data.reload}>
              重试
            </Button>
          </div>
        </Callout>
      ) : null}

      <div className="stat-grid">
        <div className="stat is-accent">
          <span>已发布</span>
          <b>{data.loading ? '—' : published.length}</b>
          <small>读者可见的内容</small>
        </div>
        <div className="stat is-warn">
          <span>待审核</span>
          <b>{data.loading ? '—' : review.length}</b>
          <small>{review.length ? '需要编辑处理' : '队列已清空'}</small>
        </div>
        <div className="stat">
          <span>草稿与退回</span>
          <b>{data.loading ? '—' : drafts.length}</b>
          <small>尚未进入公开列表</small>
        </div>
        <div className="stat">
          <span>站点用户</span>
          <b>{data.loading ? '—' : isSiteAdmin(me?.role) ? data.data?.members.length ?? 0 : '—'}</b>
          <small>{isSiteAdmin(me?.role) ? '含邀请中与停用' : '需要站点管理员权限'}</small>
        </div>
      </div>

      <div className="dash-insights-grid">
        <DashboardAnalytics />
        <div className="dash-content-column">
          <DashboardPopular items={all} loading={data.loading} />
          <DashboardRecent items={all} loading={data.loading} />
        </div>
      </div>

      <div className="dash-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>审核队列</h3>
              <p>{review.length ? `${review.length} 篇等待处理` : '暂时没有待审内容'}</p>
            </div>
            <Link to="/admin/review" className="btn btn-secondary btn-sm">
              打开队列
            </Link>
          </div>
          <div className="panel-body">
            {review.length === 0 ? (
              <p className="small muted">队列是空的。新的提交会出现在这里，并触发一条通知。</p>
            ) : (
              review.slice(0, 3).map((item) => (
                <div className="mini-row" key={item.id}>
                  <div style={{ minWidth: 0 }}>
                    <Link to={`/admin/review`} className="cell-title">
                      {item.title}
                    </Link>
                    <div className="tiny faint">
                      {item.author_name ?? '作者'} · {formatDateTime(item.updated_at)}
                    </div>
                  </div>
                  <Badge tone="warn">{STATUS_LABEL[item.status]}</Badge>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>最近操作</h3>
              <p>{demo ? '演示后端记录' : '本浏览器记录（无审计端点）'}</p>
            </div>
            <Link to="/admin/activity" className="btn btn-ghost btn-sm">
              全部
            </Link>
          </div>
          <div className="panel-body">
            {(data.data?.activity ?? []).length === 0 ? (
              <p className="small muted">还没有操作日志。</p>
            ) : (
              (data.data?.activity ?? []).slice(0, 6).map((entry) => (
                <div className="mini-row" key={entry.id}>
                  <div style={{ minWidth: 0 }}>
                    <span className="small">{entry.actor}</span>{' '}
                    <span className="muted small">{entry.action}</span>
                    <div className="tiny faint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {entry.target}
                      {entry.detail ? ` · ${entry.detail}` : ''}
                    </div>
                  </div>
                  <Badge tone={activityTone(entry.action)}>{entry.action}</Badge>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </>
  );
}
