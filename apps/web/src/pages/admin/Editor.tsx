import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { Content, ContentAction, ContentKind, SourceFormat } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend, isDemo } from '../../lib/backend';
import { useAsync, useTitle, useUnsavedWarning } from '../../lib/hooks';
import { noteActivity } from '../../lib/activity';
import {
  ACTION_LABEL,
  KIND_LABEL,
  PUBLISH_LABEL,
  STATUS_LABEL,
  canReview,
  formatDateTime,
} from '../../lib/format';
import { useT } from '../../lib/i18n';
import {
  Badge,
  Button,
  Callout,
  Field,
  Input,
  Modal,
  PageLoading,
  Select,
  StatusBadge,
  Textarea,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';
import { RichTextEditor } from '../../components/RichTextEditor';
import { ArticleCoverPanel } from '../../components/ArticleCoverPanel';
import { normalizeEditorSource } from '../../lib/editorSource';
import { useTaxonomy } from '../../lib/useTaxonomy';
import { useToast } from '../../lib/toast';

interface FormState {
  title: string;
  slug: string;
  summary: string;
  source_format: SourceFormat;
  source_body: string;
  category_id: string;
  tags: string[];
}

type SaveStatus = 'draft' | 'pending_review' | 'published';

const EMPTY: FormState = {
  title: '',
  slug: '',
  summary: '',
  source_format: 'markdown',
  source_body: '',
  category_id: '',
  tags: [],
};

export function EditorPage() {
  const t = useT();
  return (
    <RoleGate capability="write_content" need={t('写稿')}>
      <EditorWorkspace />
    </RoleGate>
  );
}

function EditorWorkspace() {
  const t = useT();
  const { kind: kindParam, id } = useParams();
  const kind: ContentKind = kindParam === 'post' ? 'post' : 'article';
  const isNew = !id;
  const { me, site } = useAuth();
  const backend = useBackend();
  const demo = isDemo(backend);
  const { taxonomy, saveTerm: saveTaxonomyTerm } = useTaxonomy();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const seed = (location.state as { content?: Content } | null)?.content;

  const [form, setForm] = useState<FormState>(EMPTY);
  const [initial, setInitial] = useState<FormState>(EMPTY);
  const [loadedId, setLoadedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<ContentAction | ''>('');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [error, setError] = useState('');
  // 编辑区内容只在「切换稿件 / 导入 Markdown」时重灌；输入过程中不重置 DOM，否则光标会跳。
  const [surface, setSurface] = useState<{ html: string; revision: string }>({ html: '', revision: '0' });
  const [wordCount, setWordCount] = useState(0);
  const [targetStatus, setTargetStatus] = useState<SaveStatus>('draft');
  const [initialStatus, setInitialStatus] = useState<SaveStatus>('draft');
  const [tagInput, setTagInput] = useState('');
  const revisionRef = useRef(0);
  const importRef = useRef<HTMLInputElement>(null);

  const content = useAsync(async () => (isNew ? null : backend.getContent(kind, id!)), [backend, kind, id, isNew]);
  const item = content.data;
  useTitle(isNew ? t('新建{kind}', { kind: KIND_LABEL[kind] }) : item?.title ?? t('编辑内容'));

  const mountSurface = useCallback((html: string) => {
    revisionRef.current += 1;
    setSurface({ html, revision: `r${revisionRef.current}` });
  }, []);

  useEffect(() => {
    if (isNew) {
      setForm(EMPTY);
      setInitial(EMPTY);
      setLoadedId('new');
      setTargetStatus('draft');
      setInitialStatus('draft');
      mountSurface('');
      return;
    }
    if (!item || item.id === loadedId) return;
    const seeded = seed && seed.id === item.id ? seed.source_body : undefined;
    const source = seeded ?? item.source_body ?? '';
    const normalized = normalizeEditorSource(item.source_format, source);
    const next: FormState = {
      title: item.title,
      slug: item.slug,
      summary: item.summary ?? '',
      source_format: 'markdown',
      source_body: normalized.markdown,
      category_id: item.category_id ?? '',
      tags: item.tags ?? [],
    };
    setForm(next);
    setInitial(next);
    setTargetStatus(
      item.status === 'published'
        ? 'published'
        : item.status === 'pending_review'
          ? 'pending_review'
          : 'draft',
    );
    setInitialStatus(
      item.status === 'published'
        ? 'published'
        : item.status === 'pending_review'
          ? 'pending_review'
          : 'draft',
    );
    setLoadedId(item.id);
    mountSurface(normalized.html);
  }, [item, isNew, seed, loadedId, mountSurface]);

  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || targetStatus !== initialStatus;
  useUnsavedWarning(dirty);

  const editable = isNew || item?.status === 'draft' || item?.status === 'rejected';
  const sourceMissing = !isNew && !!item && item.source_body === undefined && !(seed && seed.id === item.id);

  const update = (patch: Partial<FormState>) => setForm((prev) => ({ ...prev, ...patch }));

  const reviewer = canReview(me?.role);
  const canPublishDirectly = reviewer || site?.publish_mode === 'open';
  const category = taxonomy.categories.find((term) => term.id === form.category_id);

  const statusOptions: { value: SaveStatus; label: string; hint: string; disabled: boolean }[] = [
    {
      value: 'draft',
      label: t('草稿'),
      hint: t('仅自己与编辑可见，可以继续修改。'),
      disabled: false,
    },
    {
      value: 'pending_review',
      label: t('提交审核'),
      hint: t('进入审核队列，等待另一位编辑处理。'),
      disabled: false,
    },
    {
      value: 'published',
      label: t('直接发布'),
      hint: canPublishDirectly ? t('保存后立即公开，仍会经过服务端清洗。') : t('当前发布模式不允许直接发布。'),
      disabled: !canPublishDirectly,
    },
  ];

  const toggleTag = (name: string) => {
    update({
      tags: form.tags.includes(name) ? form.tags.filter((tag) => tag !== name) : [...form.tags, name].slice(0, 12),
    });
  };

  const addCustomTag = async () => {
    const name = tagInput.trim().replace(/^#/, '').slice(0, 24);
    if (!name) return;
    if (!taxonomy.tags.some((term) => term.name === name)) {
      await saveTaxonomyTerm('tag', {
        kind: 'tag',
        name,
        slug:
          name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') || `tag-${Date.now().toString(36)}`,
      });
    }
    if (!form.tags.includes(name)) update({ tags: [...form.tags, name].slice(0, 12) });
    setTagInput('');
  };

  const exportMarkdown = () => {
    const base =
      (form.slug || form.title || 'untitled').trim().replace(/[\/:*?"<>|\s]+/g, '-') || 'untitled';
    const blob = new Blob([form.source_body], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${base}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast.push('ok', t('已导出 Markdown'), `${base}.md`);
  };

  const importMarkdown = async (file: File) => {
    if (file.size > 2_000_000) {
      toast.push('error', t('文件太大'), t('Markdown 文件不应超过 2 MB。'));
      return;
    }
    try {
      const body = (await file.text()).slice(0, 200_000);
      update({ source_format: 'markdown', source_body: body });
      mountSurface(normalizeEditorSource('markdown', body).html);
      toast.push('ok', t('已导入 Markdown'), t('内容还没有保存，记得保存草稿。'));
    } catch {
      toast.push('error', t('导入失败'), t('无法读取这个 Markdown 文件。'));
    }
  };

  const validate = (): string => {
    if (!form.title.trim()) return t('标题不能为空。');
    if (form.title.length > 200) return t('标题不能超过 200 个字符。');
    if (form.summary.length > 500) return t('摘要不能超过 500 个字符。');
    if (!form.source_body.trim()) return t('正文不能为空。');
    if (form.source_body.length > 200000) return t('正文不能超过 200000 个字符。');
    if (form.slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(form.slug)) {
      return t('路径只能使用小写字母、数字和连字符，例如 hello-world。');
    }
    return '';
  };

  const applyTargetStatus = async (current: Content): Promise<Content> => {
    let latest = current;
    let status = current.status;
    if (status === 'rejected' && targetStatus !== 'draft') {
      latest = await backend.contentAction(kind, current.id, 'restore');
      status = latest.status;
    }
    if (targetStatus === 'pending_review' && status === 'draft') {
      latest = await backend.contentAction(kind, current.id, 'submit');
      status = latest.status;
    }
    if (targetStatus === 'published' && (status === 'draft' || status === 'pending_review')) {
      latest = await backend.contentAction(kind, current.id, 'publish');
      status = latest.status;
    }
    if (targetStatus === 'draft' && status === 'rejected') {
      latest = await backend.contentAction(kind, current.id, 'restore');
    }
    return latest;
  };

  const save = async (): Promise<Content | null> => {
    const message = validate();
    if (message) {
      setError(message);
      return null;
    }
    setError('');
    setBusy(true);
    try {
      const payload = {
        title: form.title.trim(),
        slug: form.slug || undefined,
        summary: form.summary.trim() || undefined,
        source_format: 'markdown' as const,
        source_body: form.source_body,
        category_id: form.category_id || undefined,
        tags: form.tags,
      };
      if (isNew) {
        const created = await backend.createDraft(kind, payload);
        noteActivity(backend, me?.user.display_name ?? '作者', '创建草稿', created.title, KIND_LABEL[kind]);
        let final = created;
        try {
          final = await applyTargetStatus(created);
        } catch (err) {
          toast.push('error', t('草稿已保存，但状态切换失败'), err instanceof Error ? err.message : undefined);
        }
        toast.push(
          'ok',
          t('内容已保存'),
          t('当前状态：{status}', { status: STATUS_LABEL[final.status] ?? t('草稿') }),
        );
        navigate(`/admin/content/${kind}/${created.id}`, {
          replace: true,
          state: { content: { ...final, source_body: form.source_body } },
        });
        return final;
      }
      const updated = await backend.updateDraft(kind, item!.id, payload);
      noteActivity(backend, me?.user.display_name ?? '作者', '更新草稿', updated.title, KIND_LABEL[kind]);
      let final = updated;
      try {
        final = await applyTargetStatus(updated);
      } catch (err) {
        toast.push('error', t('内容已保存，但状态切换失败'), err instanceof Error ? err.message : undefined);
      }
      setInitial(form);
      setInitialStatus(
        final.status === 'published'
          ? 'published'
          : final.status === 'pending_review'
            ? 'pending_review'
            : 'draft',
      );
      content.reload();
      setForm(form);
      toast.push('ok', t('已保存'), t('当前状态：{status}', { status: STATUS_LABEL[final.status] }));
      return final;
    } catch (err) {
      const text = err instanceof Error ? err.message : t('保存失败。');
      setError(text);
      toast.push('error', t('保存失败'), text);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (action: ContentAction, reason?: string) => {
    if (!item) return;
    setActionBusy(action);
    try {
      const updated = await backend.contentAction(kind, item.id, action, reason);
      noteActivity(
        backend,
        me?.user.display_name ?? '管理员',
        ACTION_LABEL[action],
        item.title,
        `状态：${STATUS_LABEL[updated.status]}`,
      );
      toast.push(
        'ok',
        t('{action}成功', { action: ACTION_LABEL[action] }),
        t('现在是「{status}」', { status: STATUS_LABEL[updated.status] }),
      );
      content.reload();
      setRejectOpen(false);
      setArchiveOpen(false);
      setRejectReason('');
    } catch (err) {
      toast.push(
        'error',
        t('{action}失败', { action: ACTION_LABEL[action] }),
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setActionBusy('');
    }
  };

  if (!isNew && content.loading) return <PageLoading label={t('正在载入稿件')} />;

  if (!isNew && content.error) {
    return (
      <Callout tone="danger" icon="alert" title={t('无法打开这份稿件')}>
        {content.error instanceof Error ? content.error.message : t('请求失败。')}
        <div className="mt-12">
          <Link to="/admin/content" className="btn btn-secondary btn-sm">
            {t('返回内容库')}
          </Link>
        </div>
      </Callout>
    );
  }

  return (
    <>
      <div className="admin-page-head">
        <div>
          <div className="row gap-8 mb-8">
            <Link to="/admin/content" className="back-link" style={{ margin: 0 }}>
              <Icon name="arrow-left" size={13} /> {t('内容库')}
            </Link>
            <Badge tone="muted">{KIND_LABEL[kind]}</Badge>
            {item ? <StatusBadge status={item.status} /> : <Badge tone="muted">{t('未保存')}</Badge>}
          </div>
          <h1>{isNew ? t('新建{kind}', { kind: KIND_LABEL[kind] }) : editable ? t('编辑稿件') : t('查看稿件')}</h1>
          <p>
            {isNew
              ? t('保存后会生成一份内容，并按右侧选择的状态提交或发布。正文会交给服务端清洗。')
              : item
                ? t('{author} · 更新于 {date}', {
                    author: item.author_name ?? t('作者'),
                    date: formatDateTime(item.updated_at),
                  })
                : ''}
          </p>
        </div>
        <div className="admin-page-actions">
          {item?.status === 'published' ? (
            <Link to={`/${kind === 'article' ? 'a' : 'p'}/${item.id}`} className="btn btn-secondary btn-sm">
              <Icon name="eye" size={14} /> {t('查看页面')}
            </Link>
          ) : null}
          {editable ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                icon="upload"
                onClick={() => importRef.current?.click()}
              >
                {t('导入 Markdown')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon="download"
                disabled={!form.source_body.trim()}
                onClick={exportMarkdown}
              >
                {t('导出 Markdown')}
              </Button>
              <input
                ref={importRef}
                type="file"
                accept=".md,text/markdown,text/plain"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void importMarkdown(file);
                }}
              />
              <Button icon="check" loading={busy} onClick={() => void save()}>
                {targetStatus === 'draft'
                  ? t('保存草稿')
                  : targetStatus === 'pending_review'
                    ? t('保存并提交')
                    : t('保存并发布')}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {sourceMissing ? (
        <Callout tone="warn" icon="alert" title={t('无法安全地编辑这份稿件')}>
          {t('v0.1.0 契约没有提供读取源文的端点，服务端只返回了清洗后的 HTML。为避免用空白覆盖原文，')}{' '}
          {t('编辑入口在这里关闭。新建草稿不受影响。')}
          <div className="mt-12">
            <Link to={`/${kind === 'article' ? 'a' : 'p'}/${id}`} className="btn btn-secondary btn-sm">
              {t('查看已渲染页面')}
            </Link>
          </div>
        </Callout>
      ) : (
        <div className="editor-grid">
          <div className="editor-main">
            <input
              className="editor-title-input"
              value={form.title}
              onChange={(e) => update({ title: e.target.value })}
              placeholder={t('{kind}标题', { kind: KIND_LABEL[kind] })}
              maxLength={200}
              disabled={!editable}
              aria-label={t('标题')}
            />

            <Field
              label={t('摘要')}
              htmlFor="editor-summary"
              aside={`${form.summary.length}/500`}
              hint={t('出现在列表、搜索结果与分享卡片里。留空也可以。')}
            >
              <Textarea
                id="editor-summary"
                value={form.summary}
                onChange={(e) => update({ summary: e.target.value })}
                maxLength={500}
                style={{ minHeight: 70 }}
                disabled={!editable}
                placeholder={t('用一两句话说明这篇稿子。')}
              />
            </Field>

            <div className="editor-controls">
              <div className="editor-mode">
                <span>{t('{count} 字符', { count: form.source_body.length.toLocaleString() })}</span>
                {form.source_body ? (
                  <span>{t('· 约 {count} 字', { count: wordCount.toLocaleString() })}</span>
                ) : null}
              </div>
              <span className="tiny faint">
                {t('所见即所得 · 直接输入 Markdown · 保存时使用 Markdown')}
              </span>
            </div>

            <RichTextEditor
              initialHtml={surface.html}
              revision={surface.revision}
              disabled={!editable}
              onChange={(markdown, stats) => {
                update({ source_format: 'markdown', source_body: markdown });
                setWordCount(stats.text);
              }}
            />

            <p className="field-hint">
              {t('正文以所见即所得方式编辑：在段首输入')} <code># </code>
              <code>- </code>
              <code>1. </code>
              <code>&gt; </code>
              {t('或行内')} <code>**{t('粗体')}**</code>
              {t('、')}
              <code>[{t('文字')}](https://…)</code> {t('会即时转成排版；空段落输入')} <code>/</code>
              {t('可打开插入指令。保存与导出使用 Markdown，公开页面仍以服务端清洗后的 rendered_html 为准。')}
            </p>

            {error ? (
              <Callout tone="danger" icon="alert">
                {error}
              </Callout>
            ) : null}
          </div>

          <aside className="editor-side">
            <div className="panel">
              <div className="panel-head">
                <div>
                  <h3>{t('稿件信息')}</h3>
                  <p>{t('状态与可用动作由服务端返回。')}</p>
                </div>
              </div>
              <div className="panel-body" style={{ paddingTop: 6 }}>
                <div className="mini-list">
                  <div className="mini-row">
                    <span className="mini-label">{t('状态')}</span>
                    <span className="mini-value">{item ? STATUS_LABEL[item.status] : t('未保存')}</span>
                  </div>
                  <div className="mini-row">
                    <span className="mini-label">{t('类型')}</span>
                    <span className="mini-value">{KIND_LABEL[kind]}</span>
                  </div>
                  <div className="mini-row">
                    <span className="mini-label">{t('作者')}</span>
                    <span className="mini-value">{item?.author_name ?? me?.user.display_name ?? '—'}</span>
                  </div>
                  <div className="mini-row">
                    <span className="mini-label">{t('创建')}</span>
                    <span className="mini-value">{formatDateTime(item?.created_at)}</span>
                  </div>
                  <div className="mini-row">
                    <span className="mini-label">{t('更新')}</span>
                    <span className="mini-value">{formatDateTime(item?.updated_at)}</span>
                  </div>
                  <div className="mini-row">
                    <span className="mini-label">{t('安全策略')}</span>
                    <span className="mini-value mono">{item?.policy_version ?? 'policy-2026.10'}</span>
                  </div>
                  <div className="mini-row">
                    <span className="mini-label">{t('发布模式')}</span>
                    <span className="mini-value">{site ? PUBLISH_LABEL[site.publish_mode] : '—'}</span>
                  </div>
                </div>

                <div className="mt-16">
                  <Field
                    label={t('路径（slug）')}
                    htmlFor="editor-slug"
                    hint={t('创建后仍可修改，但旧链接会失效。')}
                  >
                    <Input
                      id="editor-slug"
                      value={form.slug}
                      onChange={(e) => update({ slug: e.target.value })}
                      placeholder={t('留空自动生成')}
                      pattern="[a-z0-9-]*"
                      disabled={!editable}
                    />
                  </Field>
                </div>
              </div>
            </div>

            <ArticleCoverPanel contentId={item?.id} title={form.title} />

            <div className="panel">
              <div className="panel-head">
                <div>
                  <h3>{t('分类与标签')}</h3>
                  <p>{t('分类用于归档，标签用于跨分类关联主题。')}</p>
                </div>
                <Link to="/admin/taxonomy" className="link-btn">
                  {t('管理')}
                </Link>
              </div>
              <div className="panel-body form-stack">
                <Field
                  label={t('分类')}
                  htmlFor="editor-category"
                  hint={category?.description || t('每篇内容选择一个分类。')}
                >
                  <Select
                    id="editor-category"
                    value={form.category_id}
                    disabled={!editable}
                    onChange={(event) => update({ category_id: event.target.value })}
                  >
                    <option value="">{t('未分类')}</option>
                    {taxonomy.categories.map((term) => (
                      <option key={term.id} value={term.id}>
                        {term.name}
                      </option>
                    ))}
                  </Select>
                </Field>

                <div className="field">
                  <div className="field-head">
                    <span className="field-label">{t('标签')}</span>
                    <span className="field-aside">{form.tags.length}/12</span>
                  </div>
                  <div className="tag-picker">
                    {taxonomy.tags.map((term) => (
                      <button
                        key={term.id}
                        type="button"
                        disabled={!editable}
                        className={`tag-chip${form.tags.includes(term.name) ? ' is-on' : ''}`}
                        onClick={() => toggleTag(term.name)}
                      >
                        #{term.name}
                      </button>
                    ))}
                    {!taxonomy.tags.length ? (
                      <span className="tiny faint">{t('还没有标签，可以在下方直接添加。')}</span>
                    ) : null}
                  </div>
                  {form.tags.length ? (
                    <p className="field-hint">
                      {t('已选：{tags}', { tags: form.tags.map((tag) => `#${tag}`).join(' · ') })}
                    </p>
                  ) : null}
                  {editable ? (
                    <div className="tag-add-row">
                      <Input
                        value={tagInput}
                        maxLength={24}
                        placeholder={t('添加新标签，回车确认')}
                        aria-label={t('添加标签')}
                        onChange={(event) => setTagInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            addCustomTag();
                          }
                        }}
                      />
                      <Button variant="secondary" size="sm" icon="plus" onClick={addCustomTag}>
                        {t('添加')}
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="panel">
              <div className="panel-head">
                <div>
                  <h3>{t('发布状态')}</h3>
                  <p>{t('保存时按这里的选择提交或发布。')}</p>
                </div>
                {item ? <StatusBadge status={item.status} /> : <Badge tone="muted">{t('未保存')}</Badge>}
              </div>
              <div className="panel-body">
                <div className="publish-state-grid">
                  {statusOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      disabled={!editable || option.disabled}
                      className={`publish-state${targetStatus === option.value ? ' is-on' : ''}`}
                      onClick={() => setTargetStatus(option.value)}
                    >
                      <span className="publish-state-dot" />
                      <span>
                        <strong>{option.label}</strong>
                        <em>{option.hint}</em>
                      </span>
                    </button>
                  ))}
                </div>
                <p className="field-hint mt-12">
                  {t('作者不能审核自己的内容；如果当前账户没有直接发布权限，请选择“提交审核”。')}
                </p>
              </div>
            </div>

            {item ? (
              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h3>{t('流程动作')}</h3>
                    <p>{t('只有当前账户此刻可以执行的动作会出现。')}</p>
                  </div>
                </div>
                <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {item.actions.length === 0 ? (
                    <p className="tiny faint">
                      {item.status === 'pending_review'
                        ? t('作者不能审核自己的内容；请等待另一位编辑处理。')
                        : item.status === 'published'
                          ? t('已发布内容不可直接修改，归档由编辑执行。')
                          : t('当前没有可执行的流程动作。')}
                    </p>
                  ) : (
                    item.actions.map((action) => {
                      if (action === 'reject') {
                        return (
                          <Button key={action} variant="danger" icon="close" onClick={() => setRejectOpen(true)}>
                            {t('退回稿件')}
                          </Button>
                        );
                      }
                      if (action === 'archive') {
                        return (
                          <Button key={action} variant="danger" icon="trash" onClick={() => setArchiveOpen(true)}>
                            {t('归档')}
                          </Button>
                        );
                      }
                      return (
                        <Button
                          key={action}
                          variant={action === 'publish' ? 'primary' : 'secondary'}
                          icon={action === 'submit' ? 'send' : action === 'restore' ? 'refresh' : 'check'}
                          loading={actionBusy === action}
                          onClick={() => void runAction(action)}
                        >
                          {ACTION_LABEL[action]}
                        </Button>
                      );
                    })
                  )}
                  {!demo ? (
                    <p className="tiny faint" style={{ marginTop: 4 }}>
                      {t('发布与上传会调用 Rust 安全服务；不可用时服务端返回 503，内容会保留但不会公开。')}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="panel">
                <div className="panel-body">
                  <p className="small muted">
                    {t('保存草稿后，这里会出现提交审核、发布等流程动作。作者不能审核自己的稿件。')}
                  </p>
                </div>
              </div>
            )}
          </aside>
        </div>
      )}

      <Modal
        open={rejectOpen}
        title={t('退回这份稿件')}
        description={t('退回理由会写入状态记录，并通知作者。作者修改后可以重新提交。')}
        onClose={() => setRejectOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRejectOpen(false)}>
              {t('取消')}
            </Button>
            <Button
              variant="danger"
              loading={actionBusy === 'reject'}
              disabled={!rejectReason.trim()}
              onClick={() => void runAction('reject', rejectReason.trim())}
            >
              {t('确认退回')}
            </Button>
          </>
        }
      >
        <Field label={t('退回理由')} htmlFor="reject-reason" aside={`${rejectReason.length}/500`}>
          <Textarea
            id="reject-reason"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            maxLength={500}
            placeholder={t('例如：第三段的引用缺少来源，补充后可以再提交。')}
            autoFocus
          />
        </Field>
      </Modal>

      <Modal
        open={archiveOpen}
        title={t('归档这份稿件？')}
        description={t('归档后内容会从公开列表移出，但已有链接仍然有效。')}
        onClose={() => setArchiveOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setArchiveOpen(false)}>
              {t('取消')}
            </Button>
            <Button variant="danger" loading={actionBusy === 'archive'} onClick={() => void runAction('archive')}>
              {t('确认归档')}
            </Button>
          </>
        }
      />
    </>
  );
}
