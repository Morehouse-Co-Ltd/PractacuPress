import { useCallback, useEffect, useRef, useState } from 'react';
import type { RedirectRule, RedirectSource, RedirectStatusCode } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import { useTitle } from '../../lib/hooks';
import { ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { errorText, useT } from '../../lib/i18n';
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
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';
import { useToast } from '../../lib/toast';

/**
 * 后台「重定向」页。
 *
 * 只做规则的增删改查：公开端怎么命中规则、slug 变更时怎么自动建规则都在服务端
 * （见 `internal/redirect`）。这里刻意不在浏览器里模拟解析顺序，避免出现
 * 「后台说会跳、线上不跳」的两种口径。
 */

/** 新建 / 编辑弹窗的草稿；`id` 为空表示新建。 */
interface RuleDraft {
  id: string;
  from_path: string;
  to_path: string;
  status_code: RedirectStatusCode;
}

const EMPTY_DRAFT: RuleDraft = { id: '', from_path: '', to_path: '', status_code: 301 };

const STATUS_CODES: RedirectStatusCode[] = [301, 302, 308];

/** 与服务端列表默认页大小保持同一量级；「加载更多」按游标继续取。 */
const PAGE_SIZE = 30;

/** 服务端 `MaxPathLength`。 */
const MAX_PATH_LENGTH = 512;

/** 服务端 `MaxQueryLength`。 */
const MAX_QUERY_LENGTH = 100;

/**
 * 比较「旧路径 / 新路径是否相同」时忽略结尾斜杠。
 *
 * 服务端会把旧路径规范成无结尾斜杠的形式，`/a/old` 与 `/a/old/` 是同一条规则；
 * 前端如果按原样比较，会放过一条自己跳自己的规则。
 */
function comparablePath(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
}

export function RedirectsPage() {
  const t = useT();
  const { site } = useAuth();
  const backend = useBackend();
  const toast = useToast();
  const siteId = site?.id ?? '';
  useTitle(t('重定向'));

  const [items, setItems] = useState<RedirectRule[]>([]);
  const [cursor, setCursor] = useState('');
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [term, setTerm] = useState('');
  const [appliedTerm, setAppliedTerm] = useState('');
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [editingSource, setEditingSource] = useState<RedirectSource>('manual');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<RedirectRule | null>(null);
  const [busyId, setBusyId] = useState('');
  /** 列表请求序号：搜索词切换得快时只认最后一次响应。 */
  const seq = useRef(0);

  // 中文原文作键，取值时按当前语言翻译。
  const statusLabel: Record<RedirectStatusCode, string> = {
    301: t('永久重定向'),
    302: t('临时重定向'),
    308: t('永久重定向（保留请求方法）'),
  };
  const statusTone: Record<RedirectStatusCode, 'ok' | 'warn' | 'accent'> = {
    301: 'ok',
    302: 'warn',
    308: 'accent',
  };

  /**
   * 规则来源。服务端目前只写 `manual` 与 `slug_change`；`import` 是契约里预留的
   * 第三种来源，未知值原样显示，旧前端遇到新来源不会崩。
   */
  const sourceLabel = (source: string): string => {
    switch (source) {
      case 'slug_change':
        return t('改 slug 自动生成');
      case 'manual':
        return t('手工');
      case 'import':
        return t('导入');
      default:
        return source;
    }
  };

  const load = useCallback(
    async (nextCursor: string) => {
      if (!siteId) return;
      const append = nextCursor !== '';
      const current = ++seq.current;
      setLoading(!append);
      setMore(append);
      setError('');
      // 重新取第一页时旧游标已经失效；先清掉，避免首屏加载 / 失败时还露出「加载更多」。
      if (!append) setCursor('');
      try {
        const page = await backend.listRedirects(siteId, {
          limit: PAGE_SIZE,
          cursor: append ? nextCursor : undefined,
          q: appliedTerm || undefined,
        });
        if (current !== seq.current) return;
        setItems((prev) => (append ? [...prev, ...page.items] : page.items));
        setCursor(page.next_cursor || '');
      } catch (err) {
        if (current !== seq.current) return;
        // 「加载更多」失败只补一条提示，已加载的页保持原样；首屏失败才占满错误态。
        if (append) {
          toast.push('error', t('加载更多失败'), errorText(err) || undefined);
        } else {
          setError(errorText(err) || t('重定向规则加载失败。'));
          setItems([]);
        }
      } finally {
        if (current === seq.current) {
          setLoading(false);
          setMore(false);
        }
      }
    },
    [appliedTerm, backend, siteId, t, toast],
  );

  useEffect(() => {
    void load('');
  }, [load]);

  const openCreate = () => {
    setDraft({ ...EMPTY_DRAFT });
    setEditingSource('manual');
    setFormError('');
  };

  const openEdit = (rule: RedirectRule) => {
    setDraft({
      id: rule.id,
      from_path: rule.from_path,
      to_path: rule.to_path,
      status_code: rule.status_code,
    });
    setEditingSource(rule.source);
    setFormError('');
  };

  /**
   * 前端的基本校验：非空、旧路径以 `/` 开头、新路径以 `/` 或 http(s):// 开头、
   * 且旧路径与新路径不相同。更细的规范化（去查询串、去结尾斜杠）交给服务端，
   * 这里只拦明显填错的输入。
   */
  const validateDraft = (value: RuleDraft): string => {
    const from = value.from_path.trim();
    const to = value.to_path.trim();
    if (!from) return t('旧路径不能为空。');
    if (!from.startsWith('/') || from.startsWith('//')) {
      return t('旧路径必须以 / 开头，例如 /a/old-title。');
    }
    if (!to) return t('新路径不能为空。');
    const lower = to.toLowerCase();
    const isHttp = lower.startsWith('http://') || lower.startsWith('https://');
    if (!to.startsWith('/') && !isHttp) return t('新路径必须以 / 或 http(s):// 开头。');
    if (to.startsWith('//')) return t('新路径不能以 // 开头。');
    if (comparablePath(from) === comparablePath(to)) return t('旧路径与新路径不能相同。');
    return '';
  };

  /** 409 是「旧路径重复」，给一句能直接照做的提示；其它错误沿用统一翻译。 */
  const saveErrorText = (err: unknown): string => {
    if (err instanceof ApiError && err.problem.status === 409) {
      return t('这个旧路径已经有一条规则了；同一旧路径只能有一条。');
    }
    return errorText(err) || t('保存失败');
  };

  const saveDraft = async () => {
    if (!draft || saving || !siteId) return;
    const problem = validateDraft(draft);
    if (problem) {
      setFormError(problem);
      return;
    }
    const payload = {
      from_path: draft.from_path.trim(),
      to_path: draft.to_path.trim(),
      status_code: draft.status_code,
    };
    setSaving(true);
    setFormError('');
    try {
      if (draft.id) {
        await backend.updateRedirect(siteId, draft.id, payload);
      } else {
        await backend.createRedirect(siteId, payload);
      }
      toast.push(
        'ok',
        draft.id ? t('规则已更新') : t('规则已创建'),
        `${payload.from_path} → ${payload.to_path}`,
      );
      setDraft(null);
      await load('');
    } catch (err) {
      setFormError(saveErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  const removeRule = async () => {
    if (!deleting || busyId || !siteId) return;
    const target = deleting;
    setBusyId(target.id);
    try {
      await backend.deleteRedirect(siteId, target.id);
      toast.push('ok', t('规则已删除'), `${target.from_path} → ${target.to_path}`);
      setDeleting(null);
      await load('');
    } catch (err) {
      toast.push('error', t('删除失败'), errorText(err) || undefined);
    } finally {
      setBusyId('');
    }
  };

  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('重定向')}</h1>
          <p>
            {t(
              '一条规则由「旧路径」指向「新路径」；同一旧路径只能有一条规则。已发布内容修改 slug 时，服务端会自动生成一条 source=slug_change 的规则，旧链接不会立刻失效。',
            )}
          </p>
        </div>
        <div className="admin-page-actions">
          <Button variant="ghost" size="sm" icon="refresh" onClick={() => void load('')}>
            {t('刷新')}
          </Button>
        </div>
      </div>

      <Callout tone="info" icon="info" title={t('规则怎么生效')}>
        {t(
          '访问旧路径时服务端按规则返回对应状态码并跳到新路径；301 / 308 适合永久搬家，302 适合临时调整。改 slug 自动生成的规则在这里也能看到，删掉它旧地址就不再跳转。',
        )}
      </Callout>

      <div className="toolbar mt-20">
        <div className="inline-search" style={{ width: 300 }}>
          <Icon name="search" size={14} />
          <Input
            value={term}
            maxLength={MAX_QUERY_LENGTH}
            onChange={(event) => setTerm(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setAppliedTerm(term.trim());
            }}
            placeholder={t('搜索旧路径或新路径，回车确认')}
            aria-label={t('搜索重定向规则')}
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
        <span className="toolbar-spacer" />
        <span className="tiny faint">{t('{count} 条规则', { count: items.length })}</span>
        <Button size="sm" icon="plus" onClick={openCreate}>
          {t('新建规则')}
        </Button>
      </div>

      {error ? (
        <div className="mt-16">
          <Callout tone="danger" icon="alert" title={t('重定向规则加载失败。')}>
            <p>{error}</p>
            <div className="row gap-8 mt-10">
              <Button size="sm" variant="secondary" icon="refresh" onClick={() => void load('')}>
                {t('重试')}
              </Button>
            </div>
          </Callout>
        </div>
      ) : null}

      {loading ? (
        <PageLoading label={t('正在载入重定向规则')} />
      ) : items.length === 0 ? (
        error ? null : (
          <div className="mt-20">
            <EmptyState
              icon="link"
              title={appliedTerm ? t('没有匹配的规则') : t('还没有重定向规则')}
              body={
                appliedTerm
                  ? t('换一个关键词，或清除搜索条件。')
                  : t('老链接需要继续可用时新建一条即可；改 slug 产生的规则也会出现在这里。')
              }
              action={
                <Button size="sm" icon="plus" onClick={openCreate}>
                  {t('新建规则')}
                </Button>
              }
            />
          </div>
        )
      ) : (
        <div className="panel mt-20">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('旧路径')}</th>
                  <th style={{ width: 28 }}>
                    <span className="sr-only">{t('跳转方向')}</span>
                  </th>
                  <th>{t('新路径')}</th>
                  <th>{t('状态码')}</th>
                  <th>{t('来源')}</th>
                  <th>{t('命中次数')}</th>
                  <th>{t('创建时间')}</th>
                  <th style={{ width: 170 }}>{t('操作')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((rule) => (
                  <tr key={rule.id}>
                    <td>
                      <code className="mono small">{rule.from_path}</code>
                    </td>
                    <td className="faint" aria-hidden="true">
                      →
                    </td>
                    <td>
                      <code className="mono small">{rule.to_path}</code>
                    </td>
                    <td>
                      <Badge tone={statusTone[rule.status_code]} dot>
                        {rule.status_code} · {statusLabel[rule.status_code]}
                      </Badge>
                    </td>
                    <td>
                      <Badge tone={rule.source === 'slug_change' ? 'accent' : 'muted'}>
                        {sourceLabel(rule.source)}
                      </Badge>
                    </td>
                    <td className="cell-num">
                      {rule.hit_count > 0
                        ? t('{count} 次命中', { count: rule.hit_count })
                        : '—'}
                    </td>
                    <td className="tiny muted">{formatDateTime(rule.created_at)}</td>
                    <td className="cell-actions">
                      <div className="row gap-4" style={{ justifyContent: 'flex-end' }}>
                        <Button
                          variant="quiet"
                          size="sm"
                          icon="edit"
                          onClick={() => openEdit(rule)}
                        >
                          {t('编辑')}
                        </Button>
                        <Button
                          variant="quiet"
                          size="sm"
                          icon="trash"
                          onClick={() => setDeleting(rule)}
                        >
                          {t('删除')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
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
        {t(
          '路径由服务端规范化：旧路径会去掉查询串与结尾斜杠，新路径可以是站内路径或完整的 http(s) 地址。',
        )}
      </p>

      <Modal
        open={!!draft}
        title={draft?.id ? t('编辑规则') : t('新建规则')}
        description={t(
          '旧路径是访客访问的地址，新路径是跳转目标；同一旧路径只能有一条规则。',
        )}
        onClose={() => setDraft(null)}
        width={560}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              {t('取消')}
            </Button>
            <Button icon="check" loading={saving} onClick={() => void saveDraft()}>
              {t('保存')}
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="form-stack">
            <Field
              label={t('旧路径')}
              htmlFor="redirect-from"
              hint={t('必须以 / 开头，例如 /a/old-title。')}
            >
              <Input
                id="redirect-from"
                value={draft.from_path}
                maxLength={MAX_PATH_LENGTH}
                autoFocus
                placeholder="/a/old-title"
                onChange={(event) =>
                  setDraft((prev) => (prev ? { ...prev, from_path: event.target.value } : prev))
                }
              />
            </Field>
            <Field
              label={t('新路径')}
              htmlFor="redirect-to"
              hint={t('站内路径以 / 开头；站外地址填 https:// 开头的完整链接。')}
            >
              <Input
                id="redirect-to"
                value={draft.to_path}
                maxLength={MAX_PATH_LENGTH}
                placeholder="/a/new-title"
                onChange={(event) =>
                  setDraft((prev) => (prev ? { ...prev, to_path: event.target.value } : prev))
                }
              />
            </Field>
            <Field
              label={t('状态码')}
              htmlFor="redirect-status"
              hint={t('301 永久、302 临时、308 永久且保留请求方法。')}
            >
              <Select
                id="redirect-status"
                value={String(draft.status_code)}
                onChange={(event) =>
                  setDraft((prev) =>
                    prev
                      ? { ...prev, status_code: Number(event.target.value) as RedirectStatusCode }
                      : prev,
                  )
                }
              >
                {STATUS_CODES.map((code) => (
                  <option key={code} value={code}>
                    {code} · {statusLabel[code]}
                  </option>
                ))}
              </Select>
            </Field>
            {editingSource === 'slug_change' ? (
              <Callout tone="info" icon="info" title={t('这条规则是自动生成的')}>
                {t(
                  '已发布内容修改 slug 时，服务端会自动创建 source=slug_change 的规则；在这里修改会覆盖自动维护的跳转目标。',
                )}
              </Callout>
            ) : null}
            {formError ? (
              <Callout tone="danger" icon="alert">
                {formError}
              </Callout>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={!!deleting}
        title={t('删除这条规则？')}
        description={t(
          '删除后旧路径不再跳转，访问它会直接落到 404。这个操作不能撤销。',
        )}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {t('取消')}
            </Button>
            <Button
              variant="danger"
              icon="trash"
              loading={!!deleting && busyId === deleting.id}
              onClick={() => void removeRule()}
            >
              {t('删除规则')}
            </Button>
          </>
        }
      >
        <p className="small muted" style={{ lineHeight: 1.8 }}>
          <code className="mono">{deleting?.from_path}</code> →{' '}
          <code className="mono">{deleting?.to_path}</code>
        </p>
      </Modal>
    </RoleGate>
  );
}
