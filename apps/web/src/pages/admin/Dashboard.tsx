import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import { errorText, useAsync, useTitle } from '../../lib/hooks';
import {
  formatDateTime,
  isSiteAdmin,
  STATUS_LABEL,
} from '../../lib/format';
import { activityActionLabel } from '../../lib/activityLabels';
import { useLocale, useT } from '../../lib/i18n';
import { usePermissions } from '../../lib/usePermissions';
import { Badge, Button, Callout, Skeleton } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { DashboardAnalytics, DashboardPopular, DashboardRecent } from '../../components/DashboardInsights';

export function DashboardPage() {
  const t = useT();
  const locale = useLocale();
  const { me, site } = useAuth();
  const { personal } = usePermissions();
  const backend = useBackend();
  useTitle(t('仪表盘'));

  const data = useAsync(async () => {
    const [articles, posts] = await Promise.all([
      backend.listContent('article', { limit: 100 }),
      backend.listContent('post', { limit: 100 }),
    ]);
    const members =
      me && isSiteAdmin(me.role) ? await backend.members(me.site_id).catch(() => []) : [];
    return { articles: articles.items, posts: posts.items, members };
  }, [backend, me]);

  /**
   * 「最近操作」改读服务端审计（`GET /sites/{siteID}/activity`）。
   *
   * 不再回退 localStorage：失败时只在面板内显示可重试错误，其它卡片不受影响。
   * 该端点要求站点管理员，普通编辑看不到服务端审计记录。
   */
  const canViewActivity = !!site && isSiteAdmin(me?.role);
  const activity = useAsync(async () => {
    if (!site || !isSiteAdmin(me?.role)) return [];
    return backend.siteActivity(site.id, 10);
  }, [backend, site?.id, me?.role]);

  const all = [...(data.data?.articles ?? []), ...(data.data?.posts ?? [])].sort((a, b) =>
    b.updated_at.localeCompare(a.updated_at),
  );
  const published = all.filter((item) => item.status === 'published');
  const review = all.filter((item) => item.status === 'pending_review');
  const drafts = all.filter((item) => ['draft', 'rejected', 'pending_security_check'].includes(item.status));
  const hour = new Date().getHours();
  const greeting =
    hour < 6 ? t('夜里好') : hour < 12 ? t('早上好') : hour < 18 ? t('下午好') : t('晚上好');
  const editorName = me?.user.display_name ?? t('编辑');
  const siteName = site?.name ?? t('站点');
  const today = new Date().toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });

  return (
    <>
      <div className="admin-page-head">
        <div>
          <h1>{t('{greeting}，{name}', { greeting, name: editorName })}</h1>
          <p>{t('{site} · 今天是 {date}', { site: siteName, date: today })}</p>
        </div>
        <div className="admin-page-actions">
          <Link to="/admin/content/new/post" className="btn btn-secondary btn-sm">
            {t('新建帖子')}
          </Link>
          <Link to="/admin/content/new/article" className="btn btn-primary btn-sm">
            <Icon name="edit" size={14} /> {t('新建文章')}
          </Link>
        </div>
      </div>

      {data.error ? (
        <Callout tone="danger" icon="alert" title={t('无法读取后台数据')}>
          {data.error instanceof Error ? data.error.message : t('请求失败。')}
          <div className="mt-12">
            <Button variant="secondary" size="sm" onClick={data.reload}>
              {t('重试')}
            </Button>
          </div>
        </Callout>
      ) : null}

      <div className={`stat-grid${personal ? ' is-three' : ''}`}>
        <div className="stat is-accent">
          <span>{t('已发布')}</span>
          <b>{data.loading ? '—' : published.length}</b>
          <small>{t('读者可见的内容')}</small>
        </div>
        {/* 个人博客没有“别人提交、我来审核”的流程，待审核卡片与审核队列面板整块不渲染。 */}
        {personal ? null : (
          <div className="stat is-warn">
            <span>{t('待审核')}</span>
            <b>{data.loading ? '—' : review.length}</b>
            <small>{review.length ? t('需要编辑处理') : t('队列已清空')}</small>
          </div>
        )}
        <div className="stat">
          <span>{t('草稿与退回')}</span>
          <b>{data.loading ? '—' : drafts.length}</b>
          <small>{t('尚未进入公开列表')}</small>
        </div>
        <div className="stat">
          <span>{t('站点用户')}</span>
          <b>{data.loading ? '—' : isSiteAdmin(me?.role) ? data.data?.members.length ?? 0 : '—'}</b>
          <small>{isSiteAdmin(me?.role) ? t('含邀请中与停用') : t('需要站点管理员权限')}</small>
        </div>
      </div>

      <div className="dash-insights-grid">
        <DashboardAnalytics />
        <div className="dash-content-column">
          <DashboardPopular items={all} loading={data.loading} />
          <DashboardRecent items={all} loading={data.loading} />
        </div>
      </div>

      <div className={`dash-grid${personal ? ' is-single' : ''}`}>
        {personal ? null : (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('审核队列')}</h3>
                <p>
                  {review.length
                    ? t('{count} 篇等待处理', { count: review.length })
                    : t('暂时没有待审内容')}
                </p>
              </div>
              <Link to="/admin/review" className="btn btn-secondary btn-sm">
                {t('打开队列')}
              </Link>
            </div>
            <div className="panel-body">
              {review.length === 0 ? (
                <p className="small muted">
                  {t('队列是空的。新的提交会出现在这里，并触发一条通知。')}
                </p>
              ) : (
                review.slice(0, 3).map((item) => (
                  <div className="mini-row" key={item.id}>
                    <div style={{ minWidth: 0 }}>
                      <Link to={`/admin/review`} className="cell-title">
                        {item.title}
                      </Link>
                      <div className="tiny faint">
                        {item.author_name ?? t('作者')} · {formatDateTime(item.updated_at)}
                      </div>
                    </div>
                    <Badge tone="warn">{STATUS_LABEL[item.status]}</Badge>
                  </div>
                ))
              )}
            </div>
          </section>
        )}

        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>{t('最近操作')}</h3>
              <p>{t('来自服务端 audit_logs 的审计记录')}</p>
            </div>
            <Link to="/admin/activity" className="btn btn-ghost btn-sm">
              {t('全部')}
            </Link>
          </div>
          <div className="panel-body">
            {!canViewActivity ? (
              <p className="small muted">{t('只有站点管理员可以查看服务端审计记录。')}</p>
            ) : activity.loading ? (
              <Skeleton lines={3} />
            ) : activity.error ? (
              <Callout tone="danger" icon="alert" title={t('无法读取最近操作')}>
                <p>{errorText(activity.error) || t('请求失败。')}</p>
                <div className="mt-12">
                  <Button variant="secondary" size="sm" onClick={activity.reload}>
                    {t('重试')}
                  </Button>
                </div>
              </Callout>
            ) : (activity.data ?? []).length === 0 ? (
              <p className="small muted">{t('还没有操作日志。')}</p>
            ) : (
              (activity.data ?? []).map((entry) => {
                const failed = entry.outcome === 'failure';
                return (
                  <div className="mini-row" key={entry.id}>
                    <div style={{ minWidth: 0 }}>
                      <span className="small">{entry.actor_name || entry.actor_id || t('系统')}</span>{' '}
                      <span className="muted small">{activityActionLabel(entry.action, t)}</span>
                      <div
                        className="tiny faint"
                        style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        {formatDateTime(entry.created_at)}
                        {entry.detail ? ` · ${entry.detail}` : ''}
                      </div>
                    </div>
                    <Badge tone={failed ? 'danger' : 'ok'}>
                      {failed ? t('失败') : t('成功')}
                    </Badge>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>
    </>
  );
}
