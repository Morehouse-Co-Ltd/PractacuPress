import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Content, ContentAction } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { noteActivity } from '../../lib/activity';
import { ACTION_LABEL, PUBLISH_LABEL, excerpt, formatDateTime } from '../../lib/format';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Field,
  Modal,
  PageLoading,
  StatusBadge,
  Textarea,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';
import { useToast } from '../../lib/toast';

export function ReviewPage() {
  return (
    <RoleGate capability="moderate_content" need="审核员">
      <ReviewQueue />
    </RoleGate>
  );
}

function ReviewQueue() {
  const { me, site } = useAuth();
  const backend = useBackend();
  const toast = useToast();
  const [busyId, setBusyId] = useState('');
  const [rejecting, setRejecting] = useState<Content | null>(null);
  const [reason, setReason] = useState('');

  const data = useAsync(async () => {
    const [articles, posts] = await Promise.all([
      backend.listContent('article', { limit: 100 }),
      backend.listContent('post', { limit: 100 }),
    ]);
    return [...articles.items, ...posts.items].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  }, [backend]);

  const pending = useMemo(
    () => (data.data ?? []).filter((item) => item.status === 'pending_review'),
    [data.data],
  );
  const security = useMemo(
    () => (data.data ?? []).filter((item) => item.status === 'pending_security_check'),
    [data.data],
  );

  useTitle('审核队列');

  const act = async (item: Content, action: ContentAction, text?: string) => {
    setBusyId(item.id);
    try {
      const updated = await backend.contentAction(item.kind, item.id, action, text);
      noteActivity(
        backend,
        me?.user.display_name ?? '编辑',
        ACTION_LABEL[action],
        item.title,
        text ? `理由：${text}` : `状态：${updated.status}`,
      );
      toast.push('ok', `${ACTION_LABEL[action]}成功`, `《${item.title}》`);
      setRejecting(null);
      setReason('');
      data.reload();
    } catch (err) {
      toast.push('error', `${ACTION_LABEL[action]}失败`, err instanceof Error ? err.message : undefined);
    } finally {
      setBusyId('');
    }
  };

  return (
    <>
      <div className="admin-page-head">
        <div>
          <h1>审核队列</h1>
          <p>
            {site ? `${PUBLISH_LABEL[site.publish_mode]} · ` : ''}
            {pending.length} 篇待审，{security.length} 篇等待安全检查。作者不能审核自己的稿件。
          </p>
        </div>
        <div className="admin-page-actions">
          <Button variant="ghost" size="sm" icon="refresh" onClick={data.reload}>
            刷新队列
          </Button>
        </div>
      </div>

      {data.error ? (
        <Callout tone="danger" icon="alert" title="无法读取队列">
          {data.error instanceof Error ? data.error.message : '请求失败。'}
        </Callout>
      ) : null}

      {data.loading ? (
        <PageLoading label="正在载入审核队列" />
      ) : (
        <>
          {pending.length === 0 ? (
            <div className="panel">
              <div className="panel-body">
                <EmptyState
                  icon="shield"
                  title="队列已清空"
                  body="没有等待审核的稿件。新的提交会出现一条通知，也会回到这个列表。"
                  action={
                    <Link to="/admin/content" className="btn btn-secondary btn-sm">
                      查看内容库
                    </Link>
                  }
                />
              </div>
            </div>
          ) : (
            pending.map((item) => {
              const canAct = item.actions.includes('publish') || item.actions.includes('reject');
              return (
                <article className="review-card" key={item.id}>
                  <div className="review-card-head">
                    <div style={{ minWidth: 0 }}>
                      <div className="row gap-8 mb-8">
                        <Badge tone="muted">{item.kind === 'article' ? '文章' : '帖子'}</Badge>
                        <StatusBadge status={item.status} />
                      </div>
                      <h3>
                        <Link to={`/admin/content/${item.kind}/${item.id}`}>{item.title}</Link>
                      </h3>
                      <div className="review-meta">
                        <span>{item.author_name ?? '作者'}</span>
                        <span>·</span>
                        <span>提交于 {formatDateTime(item.updated_at)}</span>
                        <span>·</span>
                        <span>{item.policy_version}</span>
                      </div>
                    </div>
                    <Link to={`/admin/content/${item.kind}/${item.id}`} className="btn btn-ghost btn-sm">
                      打开稿件 <Icon name="arrow-up-right" size={13} />
                    </Link>
                  </div>

                  <p className="review-excerpt">{excerpt(item.rendered_html, 240)}</p>

                  <div className="review-actions">
                    {canAct ? (
                      <>
                        <Button
                          size="sm"
                          icon="check"
                          loading={busyId === item.id}
                          onClick={() => void act(item, 'publish')}
                        >
                          发布
                        </Button>
                        <Button size="sm" variant="danger" icon="close" onClick={() => setRejecting(item)}>
                          退回
                        </Button>
                      </>
                    ) : (
                      <Callout tone="warn" icon="lock">
                        作者不能审核自己的内容。请让另一位编辑处理这份稿件。
                      </Callout>
                    )}
                  </div>
                </article>
              );
            })
          )}

          {security.length > 0 ? (
            <section className="mt-32">
              <div className="section-head">
                <h2 style={{ fontSize: 22 }}>等待安全检查</h2>
                <span className="tiny faint">安全检查通过前不会公开</span>
              </div>
              {security.map((item) => (
                <div className="review-card" key={item.id}>
                  <div className="review-card-head">
                    <div>
                      <h3>
                        <Link to={`/admin/content/${item.kind}/${item.id}`}>{item.title}</Link>
                      </h3>
                      <p className="review-meta">
                        {item.author_name ?? '作者'} · {formatDateTime(item.updated_at)}
                      </p>
                    </div>
                    <div className="row gap-8">
                      <StatusBadge status={item.status} />
                      {item.actions.includes('security-retry') ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          icon="refresh"
                          loading={busyId === item.id}
                          onClick={() => void act(item, 'security-retry')}
                        >
                          重试安全检查
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <p className="review-excerpt">
                    内容已保留，但安全服务在写入时不可用。服务恢复后重试，或让作者重新提交。
                  </p>
                </div>
              ))}
            </section>
          ) : null}
        </>
      )}

      <Modal
        open={!!rejecting}
        title={rejecting ? `退回《${rejecting.title}》` : ''}
        description="理由会写入状态记录并通知作者。请写清楚需要修改的地方。"
        onClose={() => {
          setRejecting(null);
          setReason('');
        }}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setRejecting(null);
                setReason('');
              }}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={busyId === rejecting?.id}
              disabled={!reason.trim()}
              onClick={() => rejecting && void act(rejecting, 'reject', reason.trim())}
            >
              确认退回
            </Button>
          </>
        }
      >
        <Field label="退回理由" htmlFor="review-reason" aside={`${reason.length}/500`}>
          <Textarea
            id="review-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            autoFocus
            placeholder="例如：第二段的统计口径与来源不一致，请补充说明。"
          />
        </Field>
      </Modal>
    </>
  );
}
