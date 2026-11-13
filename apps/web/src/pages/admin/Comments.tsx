import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  Comment,
  CommentModerationAction,
  CommentStatus,
  SafetyPolicy,
  SafetyRateLimit,
  SensitiveWordMode,
} from '../../types';
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
  Field,
  Input,
  Modal,
  PageLoading,
  Select,
  Tabs,
  Textarea,
  Toggle,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';
import { useStepUp } from '../../lib/stepUp';
import { useToast } from '../../lib/toast';

type TabKey = 'all' | CommentStatus;
type SafetyTab = 'words' | 'rate' | 'ip';

const STATUS_TONE: Record<CommentStatus, 'ok' | 'warn' | 'muted' | 'danger'> = {
  visible: 'ok',
  pending_review: 'warn',
  hidden: 'muted',
  deleted: 'danger',
};

export function CommentsPage() {
  const t = useT();
  const { me, site, applySite } = useAuth();
  const backend = useBackend();
  const demo = isDemo(backend);
  const toast = useToast();
  // 删除敏感词 / IP 规则由服务端的 step-up 守卫保护：保护开启后需要先过一次密码验证。
  const { ensureStepUp } = useStepUp();
  const { customization, update } = useCustomization();
  const comments = customization.comments;
  // 真实后端的评论策略在站点设置里，必须交给服务端执行；演示模式仍用本地配置。
  const commentsEnabled = demo ? comments.enabled : (site?.comments_enabled ?? true);
  const commentsRequireReview = demo ? comments.require_review : (site?.comments_require_review ?? false);
  const [tab, setTab] = useState<TabKey>('all');
  const [term, setTerm] = useState('');
  const [appliedTerm, setAppliedTerm] = useState('');
  const [items, setItems] = useState<Comment[]>([]);
  const [counts, setCounts] = useState<Partial<Record<TabKey, number>>>({});
  const [cursor, setCursor] = useState('');
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<Comment | null>(null);
  const [busyId, setBusyId] = useState('');
  const seq = useRef(0);
  useTitle(t('评论与审核'));

  // 评论状态的中文原文作键，取值时按当前语言翻译。
  const statusLabel: Record<CommentStatus, string> = {
    visible: t('已发布'),
    pending_review: t('待审核'),
    hidden: t('已隐藏'),
    deleted: t('已删除'),
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

  const saveComments = (patch: Partial<typeof comments>) => {
    update({ comments: { ...comments, ...patch } });
  };

  // 真实后端：评论开关是站点级字段，保存后由 API 强制执行（关闭时 POST /comments 返回 403）。
  const saveServerPolicy = async (patch: {
    comments_enabled?: boolean;
    comments_require_review?: boolean;
  }) => {
    if (!me) return;
    try {
      await backend.updateSite(me.site_id, patch);
      if (site) applySite({ ...site, ...patch });
      toast.push('ok', t('评论策略已保存'));
    } catch (err) {
      toast.push('error', t('保存失败'), err instanceof Error ? err.message : undefined);
    }
  };

  // 内容安全：仅真实后端的站点管理员可维护。演示后端没有这些端点，整块面板隐藏。
  const canManageSafety = !demo && !!me && (me.role === 'site_admin' || me.role === 'platform_admin');
  const [safetyTab, setSafetyTab] = useState<SafetyTab>('words');
  const [safety, setSafety] = useState<SafetyPolicy | null>(null);
  const [safetyLoading, setSafetyLoading] = useState(false);
  const [safetyError, setSafetyError] = useState('');
  const [safetyBusy, setSafetyBusy] = useState('');
  const [wordDraft, setWordDraft] = useState<{
    word: string;
    mode: SensitiveWordMode;
    replacement: string;
  }>({ word: '', mode: 'reject', replacement: '***' });
  const [ruleDraft, setRuleDraft] = useState<{
    kind: 'allow' | 'deny';
    value: string;
    note: string;
  }>({ kind: 'deny', value: '', note: '' });
  const [rateDraft, setRateDraft] = useState<SafetyRateLimit>({
    user_per_window: 5,
    ip_per_window: 10,
    window_seconds: 60,
  });

  const loadSafety = useCallback(async () => {
    if (!canManageSafety || !me || !backend.safetyPolicy) return;
    setSafetyLoading(true);
    setSafetyError('');
    try {
      const policy = await backend.safetyPolicy(me.site_id);
      setSafety(policy);
      setRateDraft(policy.rate_limit);
    } catch (err) {
      setSafetyError(err instanceof Error ? err.message : t('内容安全策略加载失败。'));
    } finally {
      setSafetyLoading(false);
    }
  }, [backend, canManageSafety, me, t]);

  useEffect(() => {
    void loadSafety();
  }, [loadSafety]);

  const saveRateLimit = async () => {
    if (!me || !backend.updateSafetyRateLimit) return;
    setSafetyBusy('rate');
    try {
      const updated = await backend.updateSafetyRateLimit(me.site_id, rateDraft);
      setRateDraft(updated);
      setSafety((current) => (current ? { ...current, rate_limit: updated } : current));
      toast.push('ok', t('评论频率已保存'));
    } catch (err) {
      toast.push('error', t('保存失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setSafetyBusy('');
    }
  };

  const addWord = async () => {
    if (!me || !backend.createSensitiveWord) return;
    const word = wordDraft.word.trim();
    if (word.length < 2) {
      toast.push('error', t('敏感词至少需要 2 个字符'));
      return;
    }
    setSafetyBusy('word');
    try {
      await backend.createSensitiveWord(me.site_id, {
        word,
        mode: wordDraft.mode,
        replacement: wordDraft.replacement.trim() || '***',
      });
      setWordDraft({ word: '', mode: wordDraft.mode, replacement: wordDraft.replacement });
      toast.push('ok', t('敏感词已添加'));
      await loadSafety();
    } catch (err) {
      toast.push('error', t('添加失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setSafetyBusy('');
    }
  };

  const changeWordMode = async (wordId: string, mode: SensitiveWordMode) => {
    if (!me || !backend.updateSensitiveWord) return;
    setSafetyBusy(wordId);
    try {
      const updated = await backend.updateSensitiveWord(me.site_id, wordId, { mode });
      setSafety((current) =>
        current
          ? { ...current, words: current.words.map((item) => (item.id === wordId ? updated : item)) }
          : current,
      );
      toast.push('ok', t('敏感词规则已更新'));
    } catch (err) {
      toast.push('error', t('更新失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setSafetyBusy('');
    }
  };

  const deleteWord = async (wordId: string) => {
    if (!me || !backend.deleteSensitiveWord) return;
    const allowed = await ensureStepUp(t('删除敏感词'));
    if (!allowed) return;
    setSafetyBusy(wordId);
    try {
      await backend.deleteSensitiveWord(me.site_id, wordId);
      setSafety((current) =>
        current ? { ...current, words: current.words.filter((item) => item.id !== wordId) } : current,
      );
      toast.push('ok', t('敏感词已删除'));
    } catch (err) {
      toast.push('error', t('删除失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setSafetyBusy('');
    }
  };

  const addIPRule = async () => {
    if (!me || !backend.createSiteIPRule) return;
    const value = ruleDraft.value.trim();
    if (!value) {
      toast.push('error', t('请填写 IP 地址或 CIDR 网段'));
      return;
    }
    setSafetyBusy('rule');
    try {
      const created = await backend.createSiteIPRule(me.site_id, {
        kind: ruleDraft.kind,
        value,
        note: ruleDraft.note.trim() || undefined,
      });
      setSafety((current) =>
        current ? { ...current, ip_rules: [...current.ip_rules, created] } : current,
      );
      setRuleDraft({ kind: ruleDraft.kind, value: '', note: '' });
      toast.push('ok', t('IP 规则已添加'));
    } catch (err) {
      toast.push('error', t('添加失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setSafetyBusy('');
    }
  };

  const deleteIPRule = async (ruleId: string) => {
    if (!me || !backend.deleteSiteIPRule) return;
    const allowed = await ensureStepUp(t('删除 IP 规则'));
    if (!allowed) return;
    setSafetyBusy(ruleId);
    try {
      await backend.deleteSiteIPRule(me.site_id, ruleId);
      setSafety((current) =>
        current
          ? { ...current, ip_rules: current.ip_rules.filter((item) => item.id !== ruleId) }
          : current,
      );
      toast.push('ok', t('IP 规则已删除'));
    } catch (err) {
      toast.push('error', t('删除失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setSafetyBusy('');
    }
  };

  return (
    <RoleGate capability="moderate_comment" need={t('审核员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('评论与审核')}</h1>
          <p>{t('处理待审评论、隐藏不合适的发言，并决定本站的评论策略。')}</p>
        </div>
        <div className="admin-page-actions">
          <Button variant="ghost" size="sm" icon="refresh" onClick={() => void load('')}>
            {t('刷新')}
          </Button>
        </div>
      </div>

      <div className="settings-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>{t('评论设置')}</h3>
              <p>{t(demo ? '立即生效，保存在本地安装配置。' : '立即生效，由服务端强制执行。')}</p>
            </div>
            <Badge tone={commentsEnabled ? 'ok' : 'muted'}>{commentsEnabled ? t('已开启') : t('已关闭')}</Badge>
          </div>
          <div className="panel-body">
            <div className="form-stack">
              <Toggle
                checked={commentsEnabled}
                onChange={(next) =>
                  demo
                    ? saveComments({ enabled: next })
                    : void saveServerPolicy({ comments_enabled: next })
                }
                label={t('允许评论')}
                description={t('关闭后文章与帖子底部不再显示评论框，已有评论仍然保留。')}
              />
              <Toggle
                checked={commentsRequireReview}
                onChange={(next) =>
                  demo
                    ? saveComments({ require_review: next })
                    : void saveServerPolicy({ comments_require_review: next })
                }
                label={t('先审后发')}
                description={t('新评论进入待审核队列，通过后才会公开显示。')}
              />
              <Field
                label={t('评论须知')}
                htmlFor="comment-notice"
                aside={`${comments.notice.length}/400`}
                hint={t('显示在评论框上方，留空则不显示。')}
              >
                <Textarea
                  id="comment-notice"
                  value={comments.notice}
                  maxLength={400}
                  style={{ minHeight: 72 }}
                  placeholder={t('例如：请就事论事，尊重其他读者；广告与人身攻击会被删除。')}
                  onChange={(event) => saveComments({ notice: event.target.value })}
                />
              </Field>
              {!demo ? (
                <Callout tone="info" icon="shield" title={t('评论策略由服务端执行')}>
                  {t('关闭评论后，即使直接调用接口也会被拒绝；先审后发时新评论进入待审核队列。')}
                </Callout>
              ) : null}
            </div>
          </div>
        </section>

        <aside className="settings-side">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('审核规则')}</h3>
                <p>{t('评论状态与内容状态是两条独立的流水线。')}</p>
              </div>
            </div>
            <div className="panel-body" style={{ paddingTop: 4 }}>
              <div className="mini-list">
                <div className="mini-row">
                  <span className="mini-label">{t('已发布')}</span>
                  <span className="mini-value">{t('所有人可见')}</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('待审核')}</span>
                  <span className="mini-value">{t('作者与审核员可见')}</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('已隐藏')}</span>
                  <span className="mini-value">{t('仅审核员可见')}</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('已删除')}</span>
                  <span className="mini-value">{t('保留占位，回复仍在')}</span>
                </div>
              </div>
              <p className="tiny faint mt-12" style={{ lineHeight: 1.75 }}>
                {t(
                  '审核员与管理员可以隐藏任何评论；作者可以删除自己的评论。删除是软删除，不会抹掉上下文。',
                )}
              </p>
            </div>
          </section>
        </aside>
      </div>

      {canManageSafety ? (
        <section className="panel mt-24">
          <div className="panel-head">
            <div>
              <h3>{t('内容安全')}</h3>
              <p>{t('敏感词、评论频率与 IP 黑白名单均由服务端执行，命中会写入站点日志。')}</p>
            </div>
            <Badge tone="ok">{t('服务端执行')}</Badge>
          </div>
          <div className="panel-body">
            <Tabs
              value={safetyTab}
              onChange={setSafetyTab}
              items={[
                { key: 'words', label: t('敏感词') },
                { key: 'rate', label: t('评论频率') },
                { key: 'ip', label: t('IP 名单') },
              ]}
            />

            {safetyError ? (
              <div className="mt-16">
                <Callout tone="danger" icon="alert">
                  {safetyError}
                </Callout>
              </div>
            ) : null}

            {safetyLoading && !safety ? (
              <PageLoading label={t('正在载入内容安全策略')} />
            ) : safetyTab === 'words' ? (
              <div className="form-stack mt-16">
                <div className="row gap-10" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <Field
                    label={t('敏感词')}
                    htmlFor="safety-word"
                    hint={t('至少 2 个字符；英文匹配不区分大小写。')}
                  >
                    <Input
                      id="safety-word"
                      value={wordDraft.word}
                      maxLength={100}
                      placeholder={t('例如：违禁词')}
                      onChange={(event) =>
                        setWordDraft({ ...wordDraft, word: event.target.value })
                      }
                    />
                  </Field>
                  <Field label={t('命中动作')} htmlFor="safety-word-mode">
                    <Select
                      id="safety-word-mode"
                      value={wordDraft.mode}
                      onChange={(event) =>
                        setWordDraft({
                          ...wordDraft,
                          mode: event.target.value as SensitiveWordMode,
                        })
                      }
                    >
                      <option value="reject">{t('拒绝提交')}</option>
                      <option value="replace">{t('替换为占位符')}</option>
                      <option value="review">{t('标记待审')}</option>
                    </Select>
                  </Field>
                  <Field label={t('占位符')} htmlFor="safety-word-replacement">
                    <Input
                      id="safety-word-replacement"
                      value={wordDraft.replacement}
                      maxLength={80}
                      disabled={wordDraft.mode !== 'replace'}
                      onChange={(event) =>
                        setWordDraft({ ...wordDraft, replacement: event.target.value })
                      }
                    />
                  </Field>
                  <Button
                    variant="primary"
                    size="sm"
                    icon="plus"
                    loading={safetyBusy === 'word'}
                    onClick={() => void addWord()}
                  >
                    {t('添加敏感词')}
                  </Button>
                </div>

                {safety && safety.words.length > 0 ? (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>{t('敏感词')}</th>
                          <th style={{ width: 170 }}>{t('命中动作')}</th>
                          <th>{t('占位符')}</th>
                          <th>{t('时间')}</th>
                          <th style={{ width: 90 }}>{t('操作')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {safety.words.map((word) => (
                          <tr key={word.id}>
                            <td className="mono">{word.word}</td>
                            <td>
                              <Select
                                value={word.mode}
                                aria-label={t('命中动作')}
                                disabled={safetyBusy === word.id}
                                onChange={(event) =>
                                  void changeWordMode(
                                    word.id,
                                    event.target.value as SensitiveWordMode,
                                  )
                                }
                              >
                                <option value="reject">{t('拒绝提交')}</option>
                                <option value="replace">{t('替换为占位符')}</option>
                                <option value="review">{t('标记待审')}</option>
                              </Select>
                            </td>
                            <td className="mono tiny muted">{word.replacement}</td>
                            <td className="tiny muted">{formatDateTime(word.created_at)}</td>
                            <td>
                              <Button
                                variant="quiet"
                                size="sm"
                                icon="trash"
                                loading={safetyBusy === word.id}
                                onClick={() => void deleteWord(word.id)}
                              >
                                {t('删除')}
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyState
                    icon="shield"
                    title={t('还没有敏感词')}
                    body={t('添加后，评论与内容提交会在服务端执行这里配置的动作。')}
                  />
                )}
              </div>
            ) : safetyTab === 'rate' ? (
              <div className="form-stack mt-16">
                <div className="row gap-10" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <Field
                    label={t('每位用户 / 窗口')}
                    htmlFor="safety-user-limit"
                    hint={t('登录用户在该窗口内最多发表的评论数，0 表示停用。')}
                  >
                    <Input
                      id="safety-user-limit"
                      type="number"
                      min={0}
                      max={1000}
                      value={rateDraft.user_per_window}
                      onChange={(event) =>
                        setRateDraft({
                          ...rateDraft,
                          user_per_window: Number(event.target.value),
                        })
                      }
                    />
                  </Field>
                  <Field
                    label={t('每个 IP / 窗口')}
                    htmlFor="safety-ip-limit"
                    hint={t('匿名与登录评论都按来源地址计数，0 表示停用。')}
                  >
                    <Input
                      id="safety-ip-limit"
                      type="number"
                      min={0}
                      max={10000}
                      value={rateDraft.ip_per_window}
                      onChange={(event) =>
                        setRateDraft({
                          ...rateDraft,
                          ip_per_window: Number(event.target.value),
                        })
                      }
                    />
                  </Field>
                  <Field label={t('窗口秒数')} htmlFor="safety-window">
                    <Input
                      id="safety-window"
                      type="number"
                      min={5}
                      max={86400}
                      value={rateDraft.window_seconds}
                      onChange={(event) =>
                        setRateDraft({
                          ...rateDraft,
                          window_seconds: Number(event.target.value),
                        })
                      }
                    />
                  </Field>
                  <Button
                    variant="primary"
                    size="sm"
                    icon="check"
                    loading={safetyBusy === 'rate'}
                    onClick={() => void saveRateLimit()}
                  >
                    {t('保存频率限制')}
                  </Button>
                </div>
                <Callout tone="info" icon="shield" title={t('超限会返回 429')}>
                  {t(
                    '超过窗口阈值时，评论接口返回 problem+json 429，并带 Retry-After 与 details.retry_after_seconds。',
                  )}
                </Callout>
              </div>
            ) : (
              <div className="form-stack mt-16">
                <div className="row gap-10" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <Field label={t('类型')} htmlFor="safety-rule-kind">
                    <Select
                      id="safety-rule-kind"
                      value={ruleDraft.kind}
                      onChange={(event) =>
                        setRuleDraft({
                          ...ruleDraft,
                          kind: event.target.value as 'allow' | 'deny',
                        })
                      }
                    >
                      <option value="deny">{t('黑名单（拒绝）')}</option>
                      <option value="allow">{t('白名单（放行）')}</option>
                    </Select>
                  </Field>
                  <Field
                    label={t('地址或网段')}
                    htmlFor="safety-rule-value"
                    hint={t('支持单个 IPv4 / IPv6 地址或 CIDR，例如 203.0.113.0/24。')}
                  >
                    <Input
                      id="safety-rule-value"
                      value={ruleDraft.value}
                      maxLength={64}
                      placeholder={t('例如：203.0.113.0/24')}
                      onChange={(event) =>
                        setRuleDraft({ ...ruleDraft, value: event.target.value })
                      }
                    />
                  </Field>
                  <Field label={t('备注（可选）')} htmlFor="safety-rule-note">
                    <Input
                      id="safety-rule-note"
                      value={ruleDraft.note}
                      maxLength={200}
                      onChange={(event) =>
                        setRuleDraft({ ...ruleDraft, note: event.target.value })
                      }
                    />
                  </Field>
                  <Button
                    variant="primary"
                    size="sm"
                    icon="plus"
                    loading={safetyBusy === 'rule'}
                    onClick={() => void addIPRule()}
                  >
                    {t('添加 IP 规则')}
                  </Button>
                </div>
                <Callout tone="warn" icon="alert" title={t('黑名单优先')}>
                  {t(
                    '只要存在白名单，站点就只放行名单内的地址；黑名单始终优先。本机回环地址始终放行，避免把自己锁在管理页之外。',
                  )}
                </Callout>

                {safety && safety.ip_rules.length > 0 ? (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>{t('类型')}</th>
                          <th>{t('地址或网段')}</th>
                          <th>{t('备注')}</th>
                          <th>{t('时间')}</th>
                          <th style={{ width: 90 }}>{t('操作')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {safety.ip_rules.map((rule) => (
                          <tr key={rule.id}>
                            <td>
                              <Badge tone={rule.kind === 'allow' ? 'ok' : 'danger'} dot>
                                {rule.kind === 'allow' ? t('白名单') : t('黑名单')}
                              </Badge>
                            </td>
                            <td className="mono">{rule.value}</td>
                            <td className="tiny muted">{rule.note || '—'}</td>
                            <td className="tiny muted">{formatDateTime(rule.created_at)}</td>
                            <td>
                              <Button
                                variant="quiet"
                                size="sm"
                                icon="trash"
                                loading={safetyBusy === rule.id}
                                onClick={() => void deleteIPRule(rule.id)}
                              >
                                {t('删除')}
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyState
                    icon="shield"
                    title={t('还没有 IP 规则')}
                    body={t('添加黑名单可拒绝特定来源；添加白名单后仅放行名单内地址。')}
                  />
                )}
              </div>
            )}
          </div>
        </section>
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
                {items.map((comment) => {
                  const target = targetOf(comment);
                  return (
                    <tr key={comment.id}>
                      <td style={{ maxWidth: 360 }}>
                        <p className="comment-cell">{comment.body}</p>
                        {comment.parent_id ? (
                          <span className="tiny faint">
                            {t('回复 · {id}', { id: shortId(comment.parent_id) })}
                          </span>
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
