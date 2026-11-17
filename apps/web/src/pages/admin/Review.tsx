import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import type { Content, ContentAction } from '../../types';
import { useAuth } from '../../lib/session';
import { isDemo, useBackend } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { useCustomization } from '../../lib/customize';
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

/**
 * 服务端风险分的告警阈值（0–100，越大越可疑）。
 *
 * 与评论审核页用同一个阈值：达到这条线的稿件在队列里标红并挂上「高风险」徽标，
 * 审核员的注意力先给它们。
 */
const RISK_ALERT_THRESHOLD = 60;

/** 不高于这个分数算低风险：开启自动发布权限时，这类待审稿件才会被自动发布。 */
const RISK_LOW_MAX = 30;

/**
 * 队列读到的服务端风险字段。
 *
 * `Content`（`types.ts`）还没有这两个可选字段，契约由主控统一补；在那之前这里用
 * 局部类型读取，不去改共享类型。字段缺失（演示数据、旧后端、公开读者侧接口）时
 * 按 0 / 空数组处理，绝不回退到浏览器内的启发式评分。
 */
type RiskScored = Content & { risk_score?: number; risk_flags?: string[] };

/** 读服务端风险分；缺失或非法一律按 0，界面不会因此崩，也不会凭空报风险。 */
function riskScoreOf(item: Content): number {
  const score = (item as RiskScored).risk_score;
  return typeof score === 'number' && Number.isFinite(score) ? Math.max(0, score) : 0;
}

/** 读服务端风险标识；缺失按空数组，未知标识由渲染层原样显示英文。 */
function riskFlagsOf(item: Content): string[] {
  const flags = (item as RiskScored).risk_flags;
  if (!Array.isArray(flags)) return [];
  return flags.filter((flag): flag is string => typeof flag === 'string' && flag !== '');
}

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
  const demo = isDemo(backend);
  const toast = useToast();
  const [busyId, setBusyId] = useState('');
  const [rejecting, setRejecting] = useState<Content | null>(null);
  const [reason, setReason] = useState('');
  const { customization } = useCustomization();
  /**
   * 自动处理权限（原「AI 审核」设置里的三个开关）。
   *
   * 评分已经搬到服务端，这三个开关只决定「允不允许按服务端风险分自动发布」；关掉
   * 时页面只展示分数，不替审核员做任何动作。
   */
  const autoPolicy = customization.comments.ai;
  const canAutoPublish = autoPolicy.enabled && autoPolicy.auto && autoPolicy.scopes.article === true;
  /**
   * 自动发布只有在服务端真的给了分数时才运行。
   *
   * 演示数据的 `Content` 没有风险字段，按约定一律视为 0 分；如果照这个 0 分去执行
   * 「低风险自动发布」，就会把整队待审稿件一次放行。所以缺分数的模式只展示队列，
   * 不替审核员做决定。
   */
  const autoPublishReady = canAutoPublish && !demo;
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoReport, setAutoReport] = useState<{
    published: number;
    skipped: number;
    failed: number;
  } | null>(null);
  /** 每次进入页面只自动跑一轮；手动按钮不受这个标记限制。 */
  const autoRunRef = useRef(false);
  const autoRunningRef = useRef(false);

  const data = useAsync(async () => {
    const [articles, posts] = await Promise.all([
      backend.listContent('article', { limit: 100 }),
      backend.listContent('post', { limit: 100 }),
    ]);
    return [...articles.items, ...posts.items].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  }, [backend]);

  /**
   * 待审稿件按服务端风险分降序。
   *
   * 分数由服务端用同一套规则算好，所以换设备、刷新页面、关掉脚本都不改变队列顺序；
   * 分数相同按提交时间从早到晚，先来的先审。
   */
  const pending = useMemo(
    () =>
      (data.data ?? [])
        .filter((item) => item.status === 'pending_review')
        .sort((a, b) => riskScoreOf(b) - riskScoreOf(a) || a.updated_at.localeCompare(b.updated_at)),
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

  /**
   * 按服务端风险分跑一轮自动发布。
   *
   * 只自动发布风险分不高于 RISK_LOW_MAX 且当前账户确实有「发布」动作的稿件；中高风险、
   * 作者自己的稿件（服务端不给 publish 动作）都留给人工。单轮最多扫描 100 篇。
   */
  const runRiskPass = useCallback(async () => {
    if (autoRunningRef.current || !autoPublishReady) return;
    autoRunningRef.current = true;
    setAutoBusy(true);
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
        const score = riskScoreOf(item);
        if (score > RISK_LOW_MAX) continue;
        try {
          const updated = await backend.contentAction(item.kind, item.id, 'publish');
          if (updated.status === 'published') {
            published += 1;
            noteActivity(
              backend,
              me?.user.display_name ?? '编辑',
              '自动发布',
              item.title,
              `风险分 ${score}`,
            );
          } else {
            // 服务端可能把稿件转去安全检查；这不是自动发布，不能算成功。
            skipped += 1;
          }
        } catch {
          failed += 1;
        }
      }
      setAutoReport({ published, skipped, failed });
      if (published || skipped || failed) {
        if (me) {
          noteActivity(
            backend,
            me.user.display_name,
            '自动发布',
            `发布 ${published} 篇`,
            skipped || failed ? `留待人工 ${skipped} · 失败 ${failed}` : undefined,
          );
        }
        toast.push(
          failed ? 'info' : 'ok',
          t('自动发布已完成'),
          t('自动发布 {published} 篇，留待人工 {skipped} 篇，失败 {failed} 篇。', {
            published,
            skipped,
            failed,
          }),
        );
        data.reload();
      }
    } catch (err) {
      toast.push('error', t('自动发布运行失败'), err instanceof Error ? err.message : undefined);
    } finally {
      autoRunningRef.current = false;
      setAutoBusy(false);
    }
    // data.reload 是 useAsync 里稳定的 useCallback；不把整个 data 放进依赖，
    // 否则每次渲染都会换一个新的回调。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPublishReady, backend, me, t, toast, data.reload]);

  // 进入队列并载入完成后自动跑一轮；autoRunRef 保证同一页面生命周期内只跑一次。
  useEffect(() => {
    if (data.loading || autoRunRef.current) return;
    if (!autoPublishReady) return;
    autoRunRef.current = true;
    void runRiskPass();
  }, [autoPublishReady, data.loading, runRiskPass]);

  /**
   * 服务端风险标识 → 本站语言的提示语。
   *
   * 标识是稳定的英文常量（服务端 `platform/textrisk`），文案归审核界面所有；这里
   * 每次渲染按当前语言取值，切换语言时立刻生效。未收录的标识原样显示英文——服务端
   * 上线新规则时旧前端不会崩，也不会显示空白。写法与评论审核页一致，两个队列说
   * 同一种话。
   */
  const riskFlagLabel: Record<string, string> = {
    links: t('含多个链接'),
    very_short: t('内容过短'),
    very_long: t('内容过长'),
    repeated_chars: t('重复字符过多'),
    shouty: t('大量大写字母'),
    no_letters: t('几乎没有文字'),
    repeated_text: t('重复文本堆砌'),
  };

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

      <div className="mb-16">
        <Callout tone="info" icon="shield" title={t('服务端规则评分')}>
          <p>
            {t(
              '风险分由服务端按规则算好：外链、篇幅、重复字符、大小写与标点，权重固定、可复核。这是规则评分，不是模型推理；页面只读结果，不在浏览器重算。',
            )}
          </p>
          {demo ? (
            <p>{t('演示模式没有服务端评分，待审稿件按 0 分显示，自动发布不会运行。')}</p>
          ) : null}
          {autoPublishReady ? (
            <>
              <p>
                {t(
                  '自动发布权限已开启：风险分不高于 {threshold} 的待审稿件会自动发布，中高风险留在队列里。',
                  { threshold: RISK_LOW_MAX },
                )}
              </p>
              <div className="row gap-8 mt-10" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="refresh"
                  loading={autoBusy}
                  onClick={() => void runRiskPass()}
                >
                  {t('立即运行一轮自动发布')}
                </Button>
                {autoReport ? (
                  <span className="tiny faint">
                    {t('最近一轮：自动发布 {published} 篇，留待人工 {skipped} 篇，失败 {failed} 篇。', {
                      published: autoReport.published,
                      skipped: autoReport.skipped,
                      failed: autoReport.failed,
                    })}
                  </span>
                ) : null}
              </div>
            </>
          ) : null}
        </Callout>
      </div>

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
              // 风险分与风险标识都来自服务端：这里只读，不重算。
              const score = riskScoreOf(item);
              const flags = riskFlagsOf(item);
              const risky = score >= RISK_ALERT_THRESHOLD;
              return (
                <article className="review-card" key={item.id}>
                  <div className="review-card-head">
                    <div style={{ minWidth: 0 }}>
                      <div className="row gap-8 mb-8">
                        <Badge tone="muted">{item.kind === 'article' ? t('文章') : t('帖子')}</Badge>
                        <StatusBadge status={item.status} />
                        {score > 0 ? (
                          <Badge tone={risky ? 'danger' : 'warn'} dot={risky}>
                            {t('风险分 {score}', { score })}
                          </Badge>
                        ) : null}
                        {risky ? <Badge tone="danger">{t('高风险')}</Badge> : null}
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
                  {flags.length ? (
                    <div className="row gap-4 mt-6" style={{ flexWrap: 'wrap' }}>
                      {flags.map((flag) => (
                        <Badge key={flag} tone="muted">
                          {riskFlagLabel[flag] ?? flag}
                        </Badge>
                      ))}
                    </div>
                  ) : demo ? null : (
                    <p className="tiny faint mt-6">{t('规则评分未发现明显风险信号。')}</p>
                  )}

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
              {security.map((item) => {
                // 安全检查未通过的稿件同样在待审状态里，服务端也给了分数；这里照同一
                // 口径显示，方便判断是重试还是直接退回。
                const score = riskScoreOf(item);
                const risky = score >= RISK_ALERT_THRESHOLD;
                return (
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
                        {score > 0 ? (
                          <Badge tone={risky ? 'danger' : 'warn'} dot={risky}>
                            {t('风险分 {score}', { score })}
                          </Badge>
                        ) : null}
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
                );
              })}
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
