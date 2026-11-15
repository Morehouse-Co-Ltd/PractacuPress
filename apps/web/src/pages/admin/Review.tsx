import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import type { Content, ContentAction } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { useCustomization } from '../../lib/customize';
import {
  aiArticleDecision,
  aiAutoEnabled,
  aiRiskReasonText,
  assessArticleRisk,
} from '../../lib/aiModeration';
import { noteActivity } from '../../lib/activity';
import { ACTION_LABEL, PUBLISH_LABEL, excerpt, formatDateTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
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
import { usePermissions } from '../../lib/usePermissions';
import { useToast } from '../../lib/toast';

export function ReviewPage({ embedded = false }: { embedded?: boolean } = {}) {
  const t = useT();
  const { personal } = usePermissions();
  // 个人博客只有一个作者：没有“别人提交、站长审核”的流程，审核队列整块不存在。
  // 侧栏已经不给入口，直接输地址也回到内容库，避免看到一个永远空着的队列。
  if (personal) return <Navigate to="/admin/content" replace />;
  return (
    <RoleGate capability="moderate_content" need={t('审核员')}>
      <ReviewQueue embedded={embedded} />
    </RoleGate>
  );
}

function ReviewQueue({ embedded = false }: { embedded?: boolean }) {
  const t = useT();
  const { me, site } = useAuth();
  const backend = useBackend();
  const toast = useToast();
  const [busyId, setBusyId] = useState('');
  const [rejecting, setRejecting] = useState<Content | null>(null);
  const [reason, setReason] = useState('');
  const { customization } = useCustomization();
  const ai = customization.comments.ai;
  const [aiBusy, setAiBusy] = useState(false);
  const [aiReport, setAiReport] = useState<{
    published: number;
    skipped: number;
    failed: number;
  } | null>(null);
  /** 每次进入页面只自动跑一轮；手动按钮不受这个标记限制。 */
  const aiAutoRunRef = useRef(false);
  const aiRunningRef = useRef(false);

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

  useTitle(embedded ? t('信息安全') : t('审核队列'));

  const act = async (item: Content, action: ContentAction, text?: string) => {
    setBusyId(item.id);
    try {
      const updated = await backend.contentAction(item.kind, item.id, action, text);
      // 活动日志的 actor / action / detail 会落盘（localStorage），属于存档数据而非实时文案，保持中文。
      noteActivity(
        backend,
        me?.user.display_name ?? '编辑',
        ACTION_LABEL[action],
        item.title,
        text ? `理由：${text}` : `状态：${updated.status}`,
      );
      toast.push(
        'ok',
        t('{action}成功', { action: ACTION_LABEL[action] }),
        t('《{title}》', { title: item.title }),
      );
      setRejecting(null);
      setReason('');
      data.reload();
    } catch (err) {
      toast.push(
        'error',
        t('{action}失败', { action: ACTION_LABEL[action] }),
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setBusyId('');
    }
  };

  /** 待审稿件的 AI 风险分：标题、摘要与正文一起看，正文先转纯文本。 */
  const riskOf = (item: Content) =>
    assessArticleRisk(
      {
        title: item.title,
        summary: item.summary,
        rendered_html: item.rendered_html,
        source_body: item.source_body,
      },
      ai,
    );

  /**
   * 按 AI 权限处理一轮待审稿件。
   *
   * 只自动发布低风险且当前账户确实有「发布」动作的稿件；中高风险、作者自己的
   * 稿件（服务端不给 publish 动作）都留给人工。单轮最多扫描 100 篇。
   */
  const runAiPass = useCallback(async () => {
    if (aiRunningRef.current || !aiAutoEnabled(ai, 'article')) return;
    aiRunningRef.current = true;
    setAiBusy(true);
    let published = 0;
    let skipped = 0;
    let failed = 0;
    try {
      const [articles, posts] = await Promise.all([
        backend.listContent('article', { limit: 100 }),
        backend.listContent('post', { limit: 100 }),
      ]);
      const candidates = [...articles.items, ...posts.items].filter(
        (item) => item.status === 'pending_review' && item.actions.includes('publish'),
      );
      for (const item of candidates) {
        const risk = riskOf(item);
        if (aiArticleDecision(ai, risk) !== 'publish') continue;
        try {
          const updated = await backend.contentAction(item.kind, item.id, 'publish');
          if (updated.status === 'published') {
            published += 1;
            noteActivity(
              backend,
              me?.user.display_name ?? '编辑',
              'AI 发布',
              item.title,
              `风险分 ${risk.score}（${risk.level}）`,
            );
          } else {
            // 服务端可能把稿件转去安全检查；这不是 AI 的发布，不能算成功。
            skipped += 1;
          }
        } catch {
          failed += 1;
        }
      }
      setAiReport({ published, skipped, failed });
      if (published || skipped || failed) {
        if (me) {
          noteActivity(
            backend,
            me.user.display_name,
            'AI 审核',
            `发布 ${published} 篇`,
            skipped || failed ? `留待人工 ${skipped} · 失败 ${failed}` : undefined,
          );
        }
        toast.push(
          failed ? 'info' : 'ok',
          t('AI 审核已完成'),
          t('自动发布 {published} 篇，留待人工 {skipped} 篇，失败 {failed} 篇。', {
            published,
            skipped,
            failed,
          }),
        );
        data.reload();
      }
    } catch (err) {
      toast.push('error', t('AI 审核运行失败'), err instanceof Error ? err.message : undefined);
    } finally {
      aiRunningRef.current = false;
      setAiBusy(false);
    }
    // data.reload 是 useAsync 里稳定的 useCallback；不把整个 data 放进依赖，
    // 否则每次渲染都会换一个新的回调。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai, backend, me, t, toast, data.reload]);

  // 进入队列并载入完成后自动跑一轮；aiAutoRunRef 保证同一页面生命周期内只跑一次。
  useEffect(() => {
    if (data.loading || aiAutoRunRef.current) return;
    if (!aiAutoEnabled(ai, 'article')) return;
    aiAutoRunRef.current = true;
    void runAiPass();
  }, [ai, data.loading, runAiPass]);

  return (
    <>
      {embedded ? null : (
        <div className="admin-page-head">
          <div>
            <h1>{t('审核队列')}</h1>
            <p>
              {site ? `${PUBLISH_LABEL[site.publish_mode]} · ` : ''}
              {t('{pending} 篇待审，{security} 篇等待安全检查。作者不能审核自己的稿件。', {
                pending: pending.length,
                security: security.length,
              })}
            </p>
          </div>
          <div className="admin-page-actions">
            <Button variant="ghost" size="sm" icon="refresh" onClick={data.reload}>
              {t('刷新队列')}
            </Button>
          </div>
        </div>
      )}

      {embedded ? (
        <div className="row gap-8 mb-16" style={{ justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="sm" icon="refresh" onClick={data.reload}>
            {t('刷新队列')}
          </Button>
        </div>
      ) : null}

      {ai.enabled && ai.scopes.article ? (
        <div className="mb-16">
          <Callout tone="info" icon="sparkle" title={t('AI 审核已开启')}>
            <p>
              {!ai.auto
                ? t('AI 只给风险分，不会自动发布稿件。')
                : t('低风险待审稿件会自动发布，中高风险留在队列里。')}
            </p>
            {ai.auto ? (
              <div className="row gap-8 mt-10" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="sparkle"
                  loading={aiBusy}
                  onClick={() => void runAiPass()}
                >
                  {t('立即运行 AI 审核')}
                </Button>
                {aiReport ? (
                  <span className="tiny faint">
                    {t('最近一轮：自动发布 {published} 篇，留待人工 {skipped} 篇，失败 {failed} 篇。', {
                      published: aiReport.published,
                      skipped: aiReport.skipped,
                      failed: aiReport.failed,
                    })}
                  </span>
                ) : null}
              </div>
            ) : null}
          </Callout>
        </div>
      ) : null}

      {data.error ? (
        <Callout tone="danger" icon="alert" title={t('无法读取队列')}>
          {data.error instanceof Error ? data.error.message : t('请求失败。')}
        </Callout>
      ) : null}

      {data.loading ? (
        <PageLoading label={t('正在载入审核队列')} />
      ) : (
        <>
          {pending.length === 0 ? (
            <div className="panel">
              <div className="panel-body">
                <EmptyState
                  icon="shield"
                  title={t('队列已清空')}
                  body={t('没有等待审核的稿件。新的提交会出现一条通知，也会回到这个列表。')}
                  action={
                    <Link to="/admin/content" className="btn btn-secondary btn-sm">
                      {t('查看内容库')}
                    </Link>
                  }
                />
              </div>
            </div>
          ) : (
            pending.map((item) => {
              const canAct = item.actions.includes('publish') || item.actions.includes('reject');
              const aiRisk = ai.enabled && ai.scopes.article ? riskOf(item) : null;
              return (
                <article className="review-card" key={item.id}>
                  <div className="review-card-head">
                    <div style={{ minWidth: 0 }}>
                      <div className="row gap-8 mb-8">
                        <Badge tone="muted">{item.kind === 'article' ? t('文章') : t('帖子')}</Badge>
                        <StatusBadge status={item.status} />
                        {aiRisk ? (
                          <Badge
                            tone={
                              aiRisk.level === 'high'
                                ? 'danger'
                                : aiRisk.level === 'medium'
                                  ? 'warn'
                                  : 'ok'
                            }
                          >
                            {t('AI 风险分 {score}', { score: aiRisk.score })}
                          </Badge>
                        ) : null}
                      </div>
                      <h3>
                        <Link to={`/admin/content/${item.kind}/${item.id}`}>{item.title}</Link>
                      </h3>
                      <div className="review-meta">
                        <span>{item.author_name ?? t('作者')}</span>
                        <span>·</span>
                        <span>{t('提交于 {date}', { date: formatDateTime(item.updated_at) })}</span>
                        <span>·</span>
                        <span>{item.policy_version}</span>
                      </div>
                    </div>
                    <Link to={`/admin/content/${item.kind}/${item.id}`} className="btn btn-ghost btn-sm">
                      {t('打开稿件')} <Icon name="arrow-up-right" size={13} />
                    </Link>
                  </div>

                  <p className="review-excerpt">{excerpt(item.rendered_html, 240)}</p>
                  {aiRisk ? (
                    <p className="tiny faint mt-6">
                      {aiRisk.reasons.length
                        ? aiRisk.reasons.map((reason) => aiRiskReasonText(reason)).join(' · ')
                        : t('AI：未发现明显风险')}
                    </p>
                  ) : null}

                  <div className="review-actions">
                    {canAct ? (
                      <>
                        <Button
                          size="sm"
                          icon="check"
                          loading={busyId === item.id}
                          onClick={() => void act(item, 'publish')}
                        >
                          {t('发布')}
                        </Button>
                        <Button size="sm" variant="danger" icon="close" onClick={() => setRejecting(item)}>
                          {t('退回')}
                        </Button>
                      </>
                    ) : (
                      <Callout tone="warn" icon="lock">
                        {t('作者不能审核自己的内容。请让另一位编辑处理这份稿件。')}
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
                <h2 style={{ fontSize: 22 }}>{t('等待安全检查')}</h2>
                <span className="tiny faint">{t('安全检查通过前不会公开')}</span>
              </div>
              {security.map((item) => (
                <div className="review-card" key={item.id}>
                  <div className="review-card-head">
                    <div>
                      <h3>
                        <Link to={`/admin/content/${item.kind}/${item.id}`}>{item.title}</Link>
                      </h3>
                      <p className="review-meta">
                        {item.author_name ?? t('作者')} · {formatDateTime(item.updated_at)}
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
                          {t('重试安全检查')}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <p className="review-excerpt">
                    {t('内容已保留，但安全服务在写入时不可用。服务恢复后重试，或让作者重新提交。')}
                  </p>
                </div>
              ))}
            </section>
          ) : null}
        </>
      )}

      <Modal
        open={!!rejecting}
        title={rejecting ? t('退回《{title}》', { title: rejecting.title }) : ''}
        description={t('理由会写入状态记录并通知作者。请写清楚需要修改的地方。')}
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
              {t('取消')}
            </Button>
            <Button
              variant="danger"
              loading={busyId === rejecting?.id}
              disabled={!reason.trim()}
              onClick={() => rejecting && void act(rejecting, 'reject', reason.trim())}
            >
              {t('确认退回')}
            </Button>
          </>
        }
      >
        <Field label={t('退回理由')} htmlFor="review-reason" aside={`${reason.length}/500`}>
          <Textarea
            id="review-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            autoFocus
            placeholder={t('例如：第二段的统计口径与来源不一致，请补充说明。')}
          />
        </Field>
      </Modal>
    </>
  );
}
