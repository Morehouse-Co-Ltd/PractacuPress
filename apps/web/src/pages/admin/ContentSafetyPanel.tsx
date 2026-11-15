import { useCallback, useEffect, useState } from 'react';
import type { SafetyPolicy, SafetyRateLimit, SensitiveWordMode } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend, isDemo } from '../../lib/backend';
import { formatDateTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Field,
  Input,
  PageLoading,
  Select,
  Tabs,
} from '../../components/ui';
import { useStepUp } from '../../lib/stepUp';
import { useToast } from '../../lib/toast';

type SafetyTab = 'words' | 'rate' | 'ip';

/**
 * 内容安全：敏感词、评论频率与 IP 黑白名单。
 *
 * 这些规则由服务端执行，只有站点管理员可以维护；演示后端没有这些端点，整块面板
 * 不渲染。从「评论审核」拆出来之后，它跟着「审核设置」一起出现。
 */
export function ContentSafetyPanel() {
  const t = useT();
  const { me } = useAuth();
  const backend = useBackend();
  const demo = isDemo(backend);
  const toast = useToast();
  const { ensureStepUp } = useStepUp();

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
    <>
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
    </>
  );
}
