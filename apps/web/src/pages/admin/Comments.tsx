import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Comment, CommentModerationAction, CommentStatus } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend, isDemo } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { useCustomization } from '../../lib/customize';
import { noteActivity } from '../../lib/activity';
import { formatDateTime, KIND_LABEL, shortId } from '../../lib/format';
import { useT } from '../../lib/i18n';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Input,
  Modal,
  PageLoading,
  Tabs,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';
import { useToast } from '../../lib/toast';

type TabKey = 'all' | CommentStatus;

const STATUS_TONE: Record<CommentStatus, 'ok' | 'warn' | 'muted' | 'danger'> = {
  visible: 'ok',
  pending_review: 'warn',
  hidden: 'muted',
  deleted: 'danger',
};

/**
 * 服务端风险分的告警阈值（0–100，越大越可疑）。
 *
 * 达到这个分数的评论在列表里标红并给出醒目提示，自动处理也按它决定删除：界面提示
 * 与自动动作共用一个常量，不会各说各话。
 */
const RISK_ALERT_THRESHOLD = 60;

/** 低于这个分数算低风险：「先审后发」开启时，这类待审评论才允许自动通过。 */
const RISK_LOW_MAX = 30;

/**
 * 读服务端风险分。
 *
 * 评分在评论写入时由服务端算好并落库，浏览器只读不重算——本地重算会让换设备得到
 * 不同结论、关掉 JS 就失效，分数也无法审计。字段缺失（公开读者侧接口、演示数据、
 * 旧版本后端）一律按 0 处理，绝不回退到前端启发式。
 */
function riskScoreOf(comment: Comment): number {
  const score = comment.risk_score;
  return typeof score === 'number' && Number.isFinite(score) ? Math.max(0, score) : 0;
}

/** 读服务端风险标识；字段缺失按空数组，未知标识由渲染层原样显示。 */
function riskFlagsOf(comment: Comment): string[] {
  return Array.isArray(comment.risk_flags) ? comment.risk_flags : [];
}

export function CommentsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const t = useT();
  const { me, site } = useAuth();
  const backend = useBackend();
  const demo = isDemo(backend);
  const toast = useToast();
  const { customization } = useCustomization();
  const comments = customization.comments;
  /**
   * 自动处理权限（原「AI 审核」设置的三个开关）。
   *
   * 评分已经搬到服务端，这里只决定「允许不允许按风险分自动处理」；关掉时页面只
   * 展示分数，不替审核员做任何动作。
   */
  const autoPolicy = comments.ai;
  const canAutoModerate = autoPolicy.enabled && autoPolicy.auto && autoPolicy.scopes.comment === true;
  // 真实后端的评论策略在站点设置里，必须交给服务端执行；演示模式仍用本地配置。
  const commentsEnabled = demo ? comments.enabled : (site?.comments_enabled ?? true);
  const commentsRequireReview = demo ? comments.require_review : (site?.comments_require_review ?? false);
  const [tab, setTab] = useState<TabKey>('all');
  const [term, setTerm] = useState('');
  const [appliedTerm, setAppliedTerm] = useState('');
  const [riskFirst, setRiskFirst] = useState(false);
  const [items, setItems] = useState<Comment[]>([]);
  const [counts, setCounts] = useState<Partial<Record<TabKey, number>>>({});
  const [cursor, setCursor] = useState('');
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<Comment | null>(null);
  const [busyId, setBusyId] = useState('');
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoReport, setAutoReport] = useState<{
    approved: number;
    deleted: number;
    failed: number;
  } | null>(null);
  /** 每次进入页面只自动运行一次，避免刷新列表后反复处理。 */
  const autoRunRef = useRef(false);
  const seq = useRef(0);
  useTitle(embedded ? t('信息安全') : t('评论审核'));

  // 评论状态的中文原文作键，取值时按当前语言翻译。
  const statusLabel: Record<CommentStatus, string> = {
    visible: t('已发布'),
    pending_review: t('待审核'),
    hidden: t('已隐藏'),
    deleted: t('已删除'),
  };

  /**
   * 服务端风险标识 → 本站语言的提示语。
   *
   * 标识是稳定的英文常量（服务端 `risk.go`），文案归审核界面所有；这里每次渲染
   * 按当前语言取值，切换语言时立刻生效。未收录的标识原样显示英文——服务端上线新
   * 规则时旧前端不会崩，也不会显示空白。
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

  // 评论指向的内容：一次取回两边的列表，用于把 target_id 显示成标题。
  const contents = useAsync(async () => {
    const [articles, posts] = await Promise.all([
      backend.listContent('article', { limit: 100 }),
      backend.listContent('post', { limit: 100 }),
    ]);
    const map = new Map<string, { title: string; kind: 'article' | 'post' }>();
    for (const item of [...articles.items, ...posts.items]) {
      map.set(item.id, { title: item.title, kind: item.kind });
    }
    return map;
  }, [backend]);

  const load = useCallback(
    async (append: string) => {
      const current = ++seq.current;
      setLoading(!append);
      setMore(!!append);
      setError('');
      try {
        const page = await backend.allComments({
          status: tab === 'all' ? 'all' : tab,
          q: appliedTerm || undefined,
          limit: 30,
          cursor: append || undefined,
        });
        if (current !== seq.current) return;
        setItems((prev) => (append ? [...prev, ...page.items] : page.items));
        setCounts(page.counts ?? {});
        setCursor(page.next_cursor);
      } catch (err) {
        if (current !== seq.current) return;
        setError(err instanceof Error ? err.message : t('评论加载失败。'));
        if (!append) setItems([]);
      } finally {
        if (current === seq.current) {
          setLoading(false);
          setMore(false);
        }
      }
    },
    [backend, tab, appliedTerm, t],
  );

  useEffect(() => {
    void load('');
  }, [load]);

  const targetOf = (comment: Comment) => {
    if (comment.target_type === 'comment') return { label: t('回复评论'), to: '' };
    const found = contents.data?.get(comment.target_id);
    return {
      label: found?.title ?? shortId(comment.target_id),
      to: found ? `/${found.kind === 'article' ? 'a' : 'p'}/${comment.target_id}` : '',
    };
  };

  /**
   * 「风险分优先」只给当前这一页换顺序：该不该先看完全由服务端分数决定，缺字段的
   * 评论按 0 处理，排在后面。列表本身的取数与分页仍按服务端的顺序走。
   */
  const rows = useMemo(() => {
    if (!riskFirst) return items;
    return [...items].sort((a, b) => {
      const byRisk = riskScoreOf(b) - riskScoreOf(a);
      if (byRisk !== 0) return byRisk;
      return (b.created_at ?? '').localeCompare(a.created_at ?? '');
    });
  }, [items, riskFirst]);

  const moderate = async (comment: Comment, action: CommentModerationAction) => {
    setBusyId(comment.id);
    try {
      await backend.moderateComment(comment.id, action);
      if (me) {
        noteActivity(
          backend,
          me.user.display_name,
          action === 'approve'
            ? '通过评论'
            : action === 'reject'
              ? '驳回评论'
              : action === 'hide'
                ? '隐藏评论'
                : '删除评论',
          comment.body.slice(0, 24),
          comment.author_name,
        );
      }
      toast.push(
        'ok',
        action === 'approve'
          ? t('评论已通过')
          : action === 'reject'
            ? t('评论已驳回')
            : action === 'hide'
              ? t('评论已隐藏')
              : t('评论已删除'),
      );
      setDeleting(null);
      await load('');
    } catch (err) {
      toast.push('error', t('操作失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setBusyId('');
    }
  };

  const tabs: { key: TabKey; label: string; count?: number }[] = useMemo(
    () => [
      { key: 'all', label: t('全部'), count: counts.all },
      { key: 'pending_review', label: t('待审核'), count: counts.pending_review },
      { key: 'visible', label: t('已发布'), count: counts.visible },
      { key: 'hidden', label: t('已隐藏'), count: counts.hidden },
      { key: 'deleted', label: t('已删除'), count: counts.deleted },
    ],
    [counts, t],
  );

  /**
   * 按服务端风险分处理一轮评论。
   *
   * 分数来自服务端（评论写入时计算并落库），浏览器只读分数做决定：
   * - 开启「先审后发」：风险分不高于 `RISK_LOW_MAX` 的待审评论自动通过，其余留给人工；
   * - 未开启「先审后发」：风险分达到 `RISK_ALERT_THRESHOLD` 的公开评论自动删除。
   *
   * 单次最多扫描 100 条，避免一次打开页面触发过长的请求链；更早的评论留给手动处理。
   */
  const autoRunningRef = useRef(false);
  const runRiskPass = useCallback(async () => {
    // 评论关闭时不再动队列：已有评论保留原状，等站长重新开启后再处理。
    if (autoRunningRef.current || !commentsEnabled || !canAutoModerate) return;
    autoRunningRef.current = true;
    setAutoBusy(true);
    let approved = 0;
    let deleted = 0;
    let failed = 0;
    try {
      if (commentsRequireReview) {
        const page = await backend.allComments({ status: 'pending_review', limit: 100 });
        for (const comment of page.items) {
          if (riskScoreOf(comment) > RISK_LOW_MAX) continue;
          try {
            await backend.moderateComment(comment.id, 'approve');
            approved += 1;
          } catch {
            failed += 1;
          }
        }
      } else {
        const page = await backend.allComments({ status: 'visible', limit: 100 });
        for (const comment of page.items) {
          if (riskScoreOf(comment) < RISK_ALERT_THRESHOLD) continue;
          try {
            await backend.moderateComment(comment.id, 'delete');
            deleted += 1;
          } catch {
            failed += 1;
          }
        }
      }
      setAutoReport({ approved, deleted, failed });
      if (approved || deleted || failed) {
        if (me) {
          noteActivity(
            backend,
            me.user.display_name,
            '自动审核',
            `通过 ${approved} · 删除 ${deleted}`,
            failed ? `失败 ${failed}` : undefined,
          );
        }
        toast.push(
          failed ? 'info' : 'ok',
          t('自动审核已完成'),
          t('自动通过 {approved} 条，自动删除 {deleted} 条。', { approved, deleted }),
        );
        await load('');
      }
    } catch (err) {
      toast.push('error', t('自动审核运行失败'), err instanceof Error ? err.message : undefined);
    } finally {
      autoRunningRef.current = false;
      setAutoBusy(false);
    }
  }, [backend, canAutoModerate, commentsEnabled, commentsRequireReview, load, me, t, toast]);

  // 进入列表后自动跑一轮；autoRunRef 保证同一页面生命周期内只跑一次。
  useEffect(() => {
    if (loading || autoRunRef.current) return;
    if (!canAutoModerate) return;
    autoRunRef.current = true;
    void runRiskPass();
  }, [canAutoModerate, loading, runRiskPass]);

  return (
    <RoleGate capability="moderate_comment" need={t('审核员')}>
      {embedded ? (
        <div className="row gap-8 mb-16" style={{ justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="sm" icon="refresh" onClick={() => void load('')}>
            {t('刷新')}
          </Button>
        </div>
      ) : (
        <div className="admin-page-head">
          <div>
            <h1>{t('评论审核')}</h1>
            <p>
              {t('处理待审评论、隐藏不合适的发言；评论策略与自动处理权限在「审核设置」中调整。')}
            </p>
          </div>
          <div className="admin-page-actions">
            <Button variant="ghost" size="sm" icon="refresh" onClick={() => void load('')}>
              {t('刷新')}
            </Button>
          </div>
        </div>
      )}

      {autoPolicy.enabled && autoPolicy.scopes.comment ? (
        <div className="mt-16">
          <Callout tone="info" icon="shield" title={t('服务端风险分已开启')}>
            <p>
              {!autoPolicy.auto
                ? t('风险分由服务端在评论写入时计算并落库，这里只显示结果，不代替审核员处理。')
                : commentsRequireReview
                  ? t('先审后发已开启：风险分不高于 {threshold} 的待审评论自动通过，其余留给人工。', {
                      threshold: RISK_LOW_MAX,
                    })
                  : t('先审后发未开启：风险分达到 {threshold} 的公开评论自动删除，其余保持不变。', {
                      threshold: RISK_ALERT_THRESHOLD,
                    })}
            </p>
            {autoPolicy.auto ? (
              <div className="row gap-8 mt-10" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="shield"
                  loading={autoBusy}
                  onClick={() => void runRiskPass()}
                >
                  {t('立即运行')}
                </Button>
                {autoReport ? (
                  <span className="tiny faint">
                    {t('最近一轮：通过 {approved} 条，删除 {deleted} 条，失败 {failed} 条。', {
                      approved: autoReport.approved,
                      deleted: autoReport.deleted,
                      failed: autoReport.failed,
                    })}
                  </span>
                ) : null}
              </div>
            ) : null}
          </Callout>
        </div>
      ) : null}

      <div className="toolbar mt-24">
        <Tabs value={tab} onChange={setTab} items={tabs} />
        <span className="toolbar-spacer" />
        <div className="inline-search" style={{ width: 260 }}>
          <Icon name="search" size={14} />
          <Input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setAppliedTerm(term.trim());
            }}
            placeholder={t('搜索作者或评论内容，回车确认')}
            aria-label={t('搜索评论')}
          />
        </div>
        <Button
          variant="quiet"
          size="sm"
          icon="filter"
          aria-pressed={riskFirst}
          onClick={() => setRiskFirst((prev) => !prev)}
        >
          {riskFirst ? t('按时间排序') : t('风险分优先')}
        </Button>
        {appliedTerm ? (
          <Button
            variant="quiet"
            size="sm"
            icon="close"
            onClick={() => {
              setTerm('');
              setAppliedTerm('');
            }}
          >
            {t('清除')}
          </Button>
        ) : null}
      </div>

      {error ? (
        <div className="mt-16">
          <Callout tone="danger" icon="alert">
            {error}
          </Callout>
        </div>
      ) : null}

      {loading ? (
        <PageLoading label={t('正在载入评论')} />
      ) : items.length === 0 ? (
        <div className="mt-20">
          <EmptyState
            icon="message"
            title={appliedTerm ? t('没有匹配的评论') : t('这个分组里还没有评论')}
            body={
              appliedTerm
                ? t('换一个关键词，或清除搜索条件。')
                : commentsEnabled
                  ? t('读者在文章下方留言后，评论会出现在这里。')
                  : t('评论当前处于关闭状态，已有评论不会丢失。')
            }
          />
        </div>
      ) : (
        <div className="panel mt-20">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('评论')}</th>
                  <th>{t('作者')}</th>
                  <th>{t('所在内容')}</th>
                  <th>{t('状态')}</th>
                  <th>{t('时间')}</th>
                  <th style={{ width: 190 }}>{t('操作')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((comment) => {
                  const target = targetOf(comment);
                  // 风险分与风险标识都来自服务端：这里只读，不重算。
                  const risk = riskScoreOf(comment);
                  const flags = riskFlagsOf(comment);
                  const risky = risk >= RISK_ALERT_THRESHOLD;
                  return (
                    <tr key={comment.id}>
                      <td style={{ maxWidth: 360 }}>
                        <p className="comment-cell">{comment.body}</p>
                        {comment.parent_id ? (
                          <span className="tiny faint">
                            {t('回复 · {id}', { id: shortId(comment.parent_id) })}
                          </span>
                        ) : null}
                        {risky ? (
                          <div className="mt-6">
                            <Callout tone="danger" icon="alert">
                              {t('风险分 {score}，建议先看这条再通过或删除。', { score: risk })}
                            </Callout>
                          </div>
                        ) : null}
                      </td>
                      <td className="tiny muted">{comment.author_name ?? shortId(comment.author_id)}</td>
                      <td className="tiny">
                        {target.to ? (
                          <Link to={target.to} className="text-link" title={target.label}>
                            {target.label}
                          </Link>
                        ) : (
                          <span className="muted">{target.label}</span>
                        )}
                        <div className="tiny faint">
                          {comment.target_type === 'comment'
                            ? t('评论')
                            : KIND_LABEL[comment.target_type === 'post' ? 'post' : 'article']}
                        </div>
                      </td>
                      <td>
                        <Badge tone={STATUS_TONE[comment.status]} dot>
                          {statusLabel[comment.status]}
                        </Badge>
                        {risk > 0 ? (
                          <div className="mt-6">
                            <Badge tone={risky ? 'danger' : 'warn'} dot={risky}>
                              {t('风险分 {score}', { score: risk })}
                            </Badge>
                          </div>
                        ) : null}
                        {flags.length ? (
                          <div className="row gap-4 mt-4" style={{ flexWrap: 'wrap' }}>
                            {flags.map((flag) => (
                              <Badge key={flag} tone="muted">
                                {riskFlagLabel[flag] ?? flag}
                              </Badge>
                            ))}
                          </div>
                        ) : null}
                      </td>
                      <td className="tiny muted">{formatDateTime(comment.created_at)}</td>
                      <td>
                        <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
                          {comment.status !== 'visible' && comment.status !== 'deleted' ? (
                            <Button
                              variant="quiet"
                              size="sm"
                              icon="check"
                              loading={busyId === comment.id}
                              onClick={() => void moderate(comment, 'approve')}
                            >
                              {t('通过')}
                            </Button>
                          ) : null}
                          {comment.status === 'pending_review' ? (
                            <Button
                              variant="quiet"
                              size="sm"
                              icon="close"
                              loading={busyId === comment.id}
                              onClick={() => void moderate(comment, 'reject')}
                            >
                              {t('驳回')}
                            </Button>
                          ) : null}
                          {comment.status === 'visible' ? (
                            <Button
                              variant="quiet"
                              size="sm"
                              icon="eye"
                              loading={busyId === comment.id}
                              onClick={() => void moderate(comment, 'hide')}
                            >
                              {t('隐藏')}
                            </Button>
                          ) : null}
                          {comment.status !== 'deleted' ? (
                            <Button
                              variant="quiet"
                              size="sm"
                              icon="trash"
                              onClick={() => setDeleting(comment)}
                            >
                              {t('删除')}
                            </Button>
                          ) : (
                            <Button
                              variant="quiet"
                              size="sm"
                              icon="refresh"
                              loading={busyId === comment.id}
                              onClick={() => void moderate(comment, 'approve')}
                            >
                              {t('恢复')}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {cursor ? (
        <div className="row mt-16" style={{ justifyContent: 'center' }}>
          <Button variant="secondary" size="sm" loading={more} onClick={() => void load(cursor)}>
            {t('加载更多')}
          </Button>
        </div>
      ) : null}

      <p className="tiny faint mt-16" style={{ lineHeight: 1.8 }}>
        {t('演示模式的评论保存在浏览器；连接真实后端时，评论列表与审核动作走')}{' '}
        <code className="mono"> GET /comments </code>
        {t('与')}
        <code className="mono"> PATCH /comments/{'{id}'} </code>
        {t('。')}
      </p>

      <Modal
        open={!!deleting}
        title={t('删除这条评论？')}
        description={t('评论会被标记为已删除，作者与审核员仍能看到占位，回复保持完整。')}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {t('取消')}
            </Button>
            <Button
              variant="danger"
              loading={!!deleting && busyId === deleting.id}
              onClick={() => deleting && void moderate(deleting, 'delete')}
            >
              {t('删除评论')}
            </Button>
          </>
        }
      >
        <p className="small muted" style={{ lineHeight: 1.8 }}>
          “{deleting?.body.slice(0, 160)}”
        </p>
      </Modal>
    </RoleGate>
  );
}
