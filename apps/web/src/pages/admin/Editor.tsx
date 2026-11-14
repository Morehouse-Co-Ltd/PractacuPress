import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import type {
  Content,
  ContentAccessMode,
  ContentAction,
  ContentCommentPolicy,
  ContentKind,
  ContentRevision,
} from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend, isDemo } from '../../lib/backend';
import { adminEditorPath, writingPath } from '../../lib/adminAccess';
import { usePermissions } from '../../lib/usePermissions';
import {
  draftIsStale,
  editorDraftKey,
  readEditorDraft,
  removeEditorDraft,
  useAsync,
  useEditorAutosave,
  useTitle,
  useUnsavedWarning,
  type EditorDraftRecord,
} from '../../lib/hooks';
import { noteActivity } from '../../lib/activity';
import {
  ACTION_LABEL,
  KIND_LABEL,
  PUBLISH_LABEL,
  STATUS_LABEL,
  canReview,
  formatDateTime,
  relativeTime,
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
import { htmlToMarkdown } from '../../lib/htmlToMarkdown';
import { htmlToText, renderMarkdown, sanitizeHtml } from '../../lib/markdown';
import { toExportMarkdown } from '../../lib/markdownExport';
import { useTaxonomy } from '../../lib/useTaxonomy';
import { useToast } from '../../lib/toast';

interface FormState {
  title: string;
  slug: string;
  summary: string;
  /** 编辑器内部只处理 Markdown；导入 HTML 也会先归一化。 */
  source_format: 'markdown';
  source_body: string;
  category_id: string;
  tags: string[];
  /** datetime-local 的值；空串表示不预约。 */
  publish_at: string;
  access_mode: ContentAccessMode;
  /** 只写字段：留空保持已有密码。 */
  access_password: string;
  comment_policy: ContentCommentPolicy;
}

type SaveStatus = 'draft' | 'pending_review' | 'published';

/**
 * 写作界面的三种录入方式。
 *
 * - rich：所见即所得（当前默认），内部把 DOM 序列化成 Markdown 存盘；
 * - html / markdown：源码编辑，右侧实时预览；两者在切换时互转，保存时仍统一成
 *   Markdown（HTML 源码会先转成 Markdown 再提交），因此公开页始终走服务端清洗。
 */
type EditorMode = 'rich' | 'html' | 'markdown';

/** 服务端 ISO 时间转成 datetime-local 需要的本地值。 */
function toDateTimeLocal(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** datetime-local 的值转成服务端接受的 ISO 字符串；空值表示取消预约。 */
function fromDateTimeLocal(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const EMPTY: FormState = {
  title: '',
  slug: '',
  summary: '',
  source_format: 'markdown',
  source_body: '',
  category_id: '',
  tags: [],
  publish_at: '',
  access_mode: 'public',
  access_password: '',
  comment_policy: 'inherit',
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
  const { adminEntry } = usePermissions();
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
  // 两个保存按钮各自显示自己的 loading，避免点「发布」时「保存草稿」也在转圈。
  const [saveBusy, setSaveBusy] = useState<SaveStatus | ''>('');
  const [actionBusy, setActionBusy] = useState<ContentAction | ''>('');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [error, setError] = useState('');
  // 编辑区内容只在「切换稿件 / 导入 Markdown」时重灌；输入过程中不重置 DOM，否则光标会跳。
  const [surface, setSurface] = useState<{ html: string; revision: string }>({ html: '', revision: '0' });
  const [editorMode, setEditorMode] = useState<EditorMode>('rich');
  /** HTML 模式下的源码草稿；Markdown 始终是 form.source_body 这份 canonical 文本。 */
  const [htmlDraft, setHtmlDraft] = useState('');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [wordCount, setWordCount] = useState(0);
  const [tagInput, setTagInput] = useState('');
  const revisionRef = useRef(0);
  const importRef = useRef<HTMLInputElement>(null);

  const draftScope = editorDraftKey({
    siteId: site?.id,
    kind,
    contentId: isNew ? null : id,
  });
  const [pendingDraft, setPendingDraft] = useState<EditorDraftRecord | null>(null);
  // 点「稍后再说」后弹窗收起，但草稿仍然保留，等作者在页面里再决定。
  const [draftDeferred, setDraftDeferred] = useState(false);
  const [draftChecked, setDraftChecked] = useState(false);
  const [restoredSavedAt, setRestoredSavedAt] = useState<number | null>(null);

  const content = useAsync(async () => (isNew ? null : backend.getContent(kind, id!)), [backend, kind, id, isNew]);
  const item = content.data;
  useTitle(isNew ? t('新建{kind}', { kind: KIND_LABEL[kind] }) : item?.title ?? t('编辑内容'));

  const history = useAsync(
    async () =>
      isNew ? { items: [] as ContentRevision[] } : backend.contentRevisions(kind, id!),
    [backend, kind, id, isNew],
  );
  const [revisionView, setRevisionView] = useState<ContentRevision | null>(null);
  const [revisionBusy, setRevisionBusy] = useState('');
  const [restoreTarget, setRestoreTarget] = useState<ContentRevision | null>(null);

  const mountSurface = useCallback((html: string) => {
    revisionRef.current += 1;
    setSurface({ html, revision: `r${revisionRef.current}` });
  }, []);

  /** 把服务端返回的稿件灌进表单；seed 是新建后跳转时带过来的源文。 */
  const loadContentIntoForm = useCallback(
    (current: Content, sourceOverride?: string) => {
      const normalized = normalizeEditorSource(
        current.source_format,
        sourceOverride ?? current.source_body ?? '',
      );
      const next: FormState = {
        title: current.title,
        slug: current.slug,
        summary: current.summary ?? '',
        source_format: 'markdown',
        source_body: normalized.markdown,
        category_id: current.category_id ?? '',
        tags: current.tags ?? [],
        publish_at: toDateTimeLocal(current.publish_at),
        access_mode: current.access_mode ?? 'public',
        access_password: '',
        comment_policy: current.comment_policy ?? 'inherit',
      };
      setForm(next);
      setInitial(next);
      setLoadedId(current.id);
      mountSurface(normalized.html);
      setEditorMode('rich');
      setHtmlDraft('');
    },
    [mountSurface],
  );

  useEffect(() => {
    if (isNew) {
      setForm(EMPTY);
      setInitial(EMPTY);
      setLoadedId('new');
      mountSurface('');
      setEditorMode('rich');
      setHtmlDraft('');
      return;
    }
    if (!item || item.id === loadedId) return;
    const seeded = seed && seed.id === item.id ? seed.source_body : undefined;
    loadContentIntoForm(item, seeded);
  }, [item, isNew, seed, loadedId, mountSurface, loadContentIntoForm]);

  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  useUnsavedWarning(dirty);

  // 已发布内容也可以修订：每次保存都会留下一个可回滚的版本。
  const editable =
    isNew ||
    item?.status === 'draft' ||
    item?.status === 'rejected' ||
    item?.status === 'pending_security_check' ||
    item?.status === 'published';
  const published = item?.status === 'published';

  const draftConflict = pendingDraft
    ? !isNew &&
      draftIsStale(pendingDraft, {
        revision: item?.revision,
        updatedAt: item?.updated_at,
      })
    : false;

  /**
   * 本地自动保存。
   *
   * 只写 localStorage，不调用服务端：关闭标签、断网或浏览器崩溃后还能找回正文；
   * 真正的版本管理仍然交给「保存草稿」和版本历史。
   */
  const autosave = useEditorAutosave({
    storageKey: draftScope,
    siteId: site?.id ?? '',
    kind,
    contentId: isNew ? null : (item?.id ?? id ?? null),
    payload: form,
    // 有未处理的旧草稿时先不写，避免把还没决定要不要恢复的内容覆盖掉。
    enabled: editable && dirty && !pendingDraft,
    baseRevision: item?.revision ?? null,
    serverUpdatedAt: item?.updated_at ?? null,
    restoredSavedAt,
    onError: () => {
      toast.push(
        'error',
        t('自动保存失败'),
        t('浏览器本地存储空间不足或已被禁用；请先手动保存草稿。'),
      );
    },
  });

  const restoreDraft = (draft: EditorDraftRecord) => {
    // 旧版本地草稿没有访问/预约字段，用编辑器默认值补齐。
    const payload = draft.payload as Partial<FormState>;
    setForm({
      ...draft.payload,
      publish_at: payload.publish_at ?? '',
      access_mode: payload.access_mode ?? 'public',
      access_password: '',
      comment_policy: payload.comment_policy ?? 'inherit',
    });
    setRestoredSavedAt(draft.saved_at);
    // 正文要从草稿的 Markdown 重新渲染，不能只替换表单字段。
    mountSurface(normalizeEditorSource('markdown', draft.payload.source_body).html);
    setEditorMode('rich');
    setHtmlDraft('');
    setPendingDraft(null);
    setDraftDeferred(false);
    toast.push('ok', t('本地草稿已恢复'), t('还没有保存到服务器，记得保存草稿。'));
  };

  const discardDraft = (quiet = false) => {
    removeEditorDraft(draftScope);
    setPendingDraft(null);
    setDraftDeferred(false);
    setRestoredSavedAt(null);
    if (!quiet) toast.push('ok', t('本地草稿已丢弃'), t('编辑器保留服务器上的当前版本。'));
  };

  /** 载入完成后再看本地草稿：新建内容等表单初始化，已有内容等服务端版本回来。 */
  useEffect(() => {
    if (draftChecked) return;
    if (isNew ? loadedId !== 'new' : !item || loadedId !== item.id) return;
    setDraftChecked(true);
    const stored = readEditorDraft(draftScope);
    if (!stored) return;
    // 与当前服务端内容完全一致就没有恢复价值，顺手清掉，避免下次又弹一次。
    if (JSON.stringify(stored.payload) === JSON.stringify(initial)) {
      removeEditorDraft(draftScope);
      return;
    }
    setPendingDraft(stored);
  }, [draftChecked, draftScope, initial, isNew, item, loadedId]);

  /**
   * 作者选择「稍后再说」后继续改正文：说明当前服务端内容才是继续编辑的起点，
   * 旧草稿已经被新的修改取代。清掉旧记录，让自动保存从这一版重新开始。
   */
  useEffect(() => {
    if (!draftDeferred || !pendingDraft || !dirty) return;
    removeEditorDraft(draftScope);
    setPendingDraft(null);
    setDraftDeferred(false);
    setRestoredSavedAt(null);
  }, [draftDeferred, pendingDraft, dirty, draftScope]);

  const update = (patch: Partial<FormState>) => setForm((prev) => ({ ...prev, ...patch }));

  /** Markdown 的实时渲染结果；HTML 模式直接从源码清洗，避免先把 HTML 转成 Markdown 再渲染。 */
  const markdownPreview = useMemo(
    () => sanitizeHtml(renderMarkdown(form.source_body)),
    [form.source_body],
  );
  const livePreview =
    editorMode === 'html' ? sanitizeHtml(htmlDraft) : markdownPreview;

  /**
   * 切换录入方式。
   *
   * 三种方式共用同一份 canonical Markdown（`form.source_body`）：
   * - 进入 HTML 时把 Markdown 渲染成 HTML 放进源码框；
   * - HTML 每次输入都由 `htmlToMarkdown` 同步回 Markdown，所以切回 Markdown 时不丢内容；
   * - 回到富文本时重新挂载渲染结果，不会覆盖已保存的 Markdown。
   */
  const switchEditorMode = (next: EditorMode) => {
    if (!editable || next === editorMode) return;
    if (next === 'html' || next === 'rich') {
      // 从 Markdown 派生 HTML：切换 / 重新挂载都走同一条渲染链路。
      const html = renderMarkdown(form.source_body);
      if (next === 'html') setHtmlDraft(html);
      else mountSurface(html);
    }
    setEditorMode(next);
  };

  const changeHtmlSource = (value: string) => {
    setHtmlDraft(value);
    // 源码里的 HTML 立即折算成 Markdown 存盘：预览与公开页都使用同一份 canonical 文本。
    update({
      source_format: 'markdown',
      source_body: htmlToMarkdown(sanitizeHtml(value)),
    });
  };

  const changeMarkdownSource = (value: string) => {
    update({ source_format: 'markdown', source_body: value });
  };

  /** 源码框里的格式化快捷键：包住选区（没有选区时插入占位文字）。 */
  const wrapSourceSelection = (
    textarea: HTMLTextAreaElement,
    before: string,
    after: string,
    placeholder: string,
  ) => {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;
    const selected = value.slice(start, end) || placeholder;
    const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
    if (editorMode === 'html') changeHtmlSource(next);
    else changeMarkdownSource(next);
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(
        start + before.length,
        start + before.length + selected.length,
      );
    });
  };

  const insertSourceText = (textarea: HTMLTextAreaElement, text: string) => {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;
    const next = `${value.slice(0, start)}${text}${value.slice(end)}`;
    if (editorMode === 'html') changeHtmlSource(next);
    else changeMarkdownSource(next);
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + text.length, start + text.length);
    });
  };

  const handleSourceKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const textarea = event.currentTarget;
    if (event.key === 'Tab') {
      event.preventDefault();
      insertSourceText(textarea, '  ');
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    if (!mod || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'b' && !event.shiftKey) {
      event.preventDefault();
      if (editorMode === 'html') wrapSourceSelection(textarea, '<strong>', '</strong>', '粗体文字');
      else wrapSourceSelection(textarea, '**', '**', '粗体文字');
      return;
    }
    if (key === 'i' && !event.shiftKey) {
      event.preventDefault();
      if (editorMode === 'html') wrapSourceSelection(textarea, '<em>', '</em>', '斜体文字');
      else wrapSourceSelection(textarea, '*', '*', '斜体文字');
      return;
    }
    if (key === 'k' && !event.shiftKey) {
      event.preventDefault();
      if (editorMode === 'html') {
        wrapSourceSelection(textarea, '<a href="https://">', '</a>', '链接文字');
      } else {
        wrapSourceSelection(textarea, '[', '](https://)', '链接文字');
      }
    }
  };

  const reviewer = canReview(me?.role);
  const canPublishDirectly = reviewer || site?.publish_mode === 'open';
  const category = taxonomy.categories.find((term) => term.id === form.category_id);
  // 源码模式显示源码本身的长度；字数按渲染后的正文统计，和富文本模式保持同一口径。
  const sourceLength = editorMode === 'html' ? htmlDraft.length : form.source_body.length;
  const effectiveWordCount = editorMode === 'rich' ? wordCount : htmlToText(livePreview).length;

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
    // 存盘用的正文是"一段一行"，导出时才把段内软换行补成硬换行，方便拿到别的编辑器里用。
    const blob = new Blob([toExportMarkdown(form.source_body)], {
      type: 'text/markdown;charset=utf-8',
    });
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
      setEditorMode('rich');
      setHtmlDraft('');
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
    if (form.access_mode === 'password' && !form.access_password && !item?.has_access_password) {
      return t('密码访问需要设置一个访问密码。');
    }
    if (form.access_password && form.access_password.length < 4) {
      return t('访问密码至少需要 4 个字符。');
    }
    if (form.publish_at && new Date(form.publish_at).getTime() <= Date.now()) {
      return t('预约发布时间必须晚于现在。');
    }
    return '';
  };

  /**
   * 保存之后再走到目标状态。
   *
   * 新建内容一定先落成草稿，再按右上角按钮的意图提交或发布：
   * 「发布」= createDraft → publish，「提交审核」= createDraft → submit。
   */
  const applyTargetStatus = async (current: Content, nextStatus: SaveStatus): Promise<Content> => {
    let latest = current;
    let status = current.status;
    if (status === 'rejected' && nextStatus !== 'draft') {
      latest = await backend.contentAction(kind, current.id, 'restore');
      status = latest.status;
    }
    if (nextStatus === 'pending_review' && status === 'draft') {
      latest = await backend.contentAction(kind, current.id, 'submit');
      status = latest.status;
    }
    if (nextStatus === 'published' && (status === 'draft' || status === 'pending_review')) {
      latest = await backend.contentAction(kind, current.id, 'publish');
    }
    return latest;
  };

  /** 右上角两个按钮共用：nextStatus 决定这一下是存草稿、提交审核还是直接发布。 */
  const save = async (nextStatus: SaveStatus = 'draft'): Promise<Content | null> => {
    const message = validate();
    if (message) {
      setError(message);
      return null;
    }
    setError('');
    setBusy(true);
    setSaveBusy(nextStatus);
    try {
      const payload = {
        title: form.title.trim(),
        slug: form.slug || undefined,
        summary: form.summary.trim() || undefined,
        source_format: 'markdown' as const,
        source_body: form.source_body,
        category_id: form.category_id || undefined,
        tags: form.tags,
        publish_at: fromDateTimeLocal(form.publish_at),
        access_mode: form.access_mode,
        // 空串表示保持已有密码；服务端只在密码模式下读取它。
        access_password: form.access_mode === 'password' ? form.access_password || undefined : undefined,
        comment_policy: form.comment_policy,
      };
      if (isNew) {
        const created = await backend.createDraft(kind, payload);
        noteActivity(backend, me?.user.display_name ?? '作者', '创建草稿', created.title, KIND_LABEL[kind]);
        let final = created;
        try {
          final = await applyTargetStatus(created, nextStatus);
        } catch (err) {
          toast.push('error', t('草稿已保存，但状态切换失败'), err instanceof Error ? err.message : undefined);
        }
        // 已经落成服务端草稿，本地临时草稿（新建内容的 `new` 位）没有保留价值了。
        autosave.clear();
        setPendingDraft(null);
        setDraftDeferred(false);
        setRestoredSavedAt(null);
        toast.push(
          'ok',
          t('内容已保存'),
          t('当前状态：{status}', { status: STATUS_LABEL[final.status] ?? t('草稿') }),
        );
        navigate(adminEntry ? adminEditorPath(kind, created.id) : writingPath(kind, created.id), {
          replace: true,
          state: { content: { ...final, source_body: form.source_body } },
        });
        return final;
      }
      const updated = await backend.updateDraft(kind, item!.id, payload);
      noteActivity(backend, me?.user.display_name ?? '作者', '更新草稿', updated.title, KIND_LABEL[kind]);
      let final = updated;
      try {
        final = await applyTargetStatus(updated, nextStatus);
      } catch (err) {
        toast.push('error', t('内容已保存，但状态切换失败'), err instanceof Error ? err.message : undefined);
      }
      autosave.clear();
      setPendingDraft(null);
      setDraftDeferred(false);
      setRestoredSavedAt(null);
      setInitial(form);
      content.reload();
      history.reload();
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
      setSaveBusy('');
    }
  };

  /**
   * 写作快捷键：Ctrl/Cmd+S 保存草稿，Ctrl/Cmd+Enter 发布或提交审核。
   *
   * 监听 window 而不是编辑区：作者在标题、摘要里也可能想直接保存；输入法组合期间
   * 不处理（event.isComposing），避免中文输入时误触。
   */
  useEffect(() => {
    if (!editable) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        void save('draft');
        return;
      }
      if (key === 'enter') {
        event.preventDefault();
        void save(canPublishDirectly ? 'published' : 'pending_review');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // save 每次都捕获最新表单；依赖里保留它保证快捷键不会写到旧状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, canPublishDirectly, save]);

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

  /** 读取单个版本的完整源文，供查看与回滚确认。 */
  const openRevision = async (summary: ContentRevision) => {
    if (!item) return;
    setRevisionBusy(summary.id);
    try {
      setRevisionView(await backend.contentRevision(kind, item.id, summary.id));
    } catch (err) {
      toast.push('error', t('无法读取这个版本'), err instanceof Error ? err.message : undefined);
    } finally {
      setRevisionBusy('');
    }
  };

  const restoreRevision = async () => {
    if (!item || !restoreTarget) return;
    setRevisionBusy(restoreTarget.id);
    try {
      const updated = await backend.restoreContentRevision(kind, item.id, restoreTarget.id);
      loadContentIntoForm(updated);
      // 回滚得到的内容才是新的起点，旧本地草稿再恢复就会覆盖回滚结果。
      removeEditorDraft(draftScope);
      setPendingDraft(null);
      setDraftDeferred(false);
      setRestoredSavedAt(null);
      content.reload();
      history.reload();
      toast.push(
        'ok',
        t('已回滚到版本 {version}', { version: restoreTarget.version }),
        t('当前状态：{status}', { status: STATUS_LABEL[updated.status] ?? t('草稿') }),
      );
      setRestoreTarget(null);
      setRevisionView(null);
    } catch (err) {
      toast.push('error', t('回滚失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setRevisionBusy('');
    }
  };

  const revisionActionLabel = (action: ContentRevision['action']): string => {
    switch (action) {
      case 'created':
        return t('创建');
      case 'updated':
        return t('保存');
      case 'rollback_backup':
        return t('回滚前备份');
      case 'rollback':
        return t('回滚');
      default:
        return action;
    }
  };

  // 服务端返回当前版本号；演示数据的旧快照可能没有该字段，退化为“列表第一条是当前版本”。
  const isCurrentVersion = (revision: ContentRevision): boolean =>
    item?.revision !== undefined
      ? revision.version === item.revision
      : history.data?.items[0]?.id === revision.id;

  const autosaveLabel =
    autosave.state === 'saving'
      ? t('正在保存本地草稿…')
      : autosave.state === 'error'
        ? t('本地草稿保存失败（可能是浏览器存储已满）')
        : autosave.savedAt
          ? t('草稿已自动保存 · {time}', {
              time: relativeTime(new Date(autosave.savedAt).toISOString()),
            })
          : '';

  // 管理员回内容库，普通成员回站点：写作台里没有内容库这一站。
  const backTo = adminEntry ? '/admin/content' : '/';
  const backLabel = adminEntry ? t('内容库') : t('返回站点');

  if (!isNew && content.loading) return <PageLoading label={t('正在载入稿件')} />;

  if (!isNew && content.error) {
    return (
      <Callout tone="danger" icon="alert" title={t('无法打开这份稿件')}>
        {content.error instanceof Error ? content.error.message : t('请求失败。')}
        <div className="mt-12">
          <Link to={backTo} className="btn btn-secondary btn-sm">
            {backLabel}
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
            <Link to={backTo} className="back-link" style={{ margin: 0 }}>
              <Icon name="arrow-left" size={13} /> {backLabel}
            </Link>
            <Badge tone="muted">{KIND_LABEL[kind]}</Badge>
            {item ? <StatusBadge status={item.status} /> : <Badge tone="muted">{t('未保存')}</Badge>}
          </div>
          <h1>{isNew ? t('新建{kind}', { kind: KIND_LABEL[kind] }) : editable ? t('编辑稿件') : t('查看稿件')}</h1>
          <p>
            {isNew
              ? t('保存后会生成一份内容；右上角可以直接保存草稿或发布，正文会交给服务端清洗。')
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
              <Button
                variant="secondary"
                size="sm"
                icon="file"
                loading={saveBusy === 'draft'}
                disabled={busy}
                onClick={() => void save('draft')}
              >
                {published ? t('保存修订') : t('保存草稿')}
              </Button>
              {!published ? (
                <Button
                  icon={canPublishDirectly ? 'check' : 'send'}
                  loading={saveBusy === (canPublishDirectly ? 'published' : 'pending_review')}
                  disabled={busy}
                  onClick={() => void save(canPublishDirectly ? 'published' : 'pending_review')}
                >
                  {canPublishDirectly ? t('发布') : t('提交审核')}
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

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
                <span>{t('{count} 字符', { count: sourceLength.toLocaleString() })}</span>
                {form.source_body ? (
                  <span>{t('· 约 {count} 字', { count: effectiveWordCount.toLocaleString() })}</span>
                ) : null}
                {autosaveLabel ? (
                  <span className="tiny faint" role="status" aria-live="polite">
                    {autosaveLabel}
                  </span>
                ) : null}
              </div>
              <div className="editor-controls-right">
                <div className="editor-mode-switch" role="group" aria-label={t('正文编辑格式')}>
                  {(
                    [
                      { key: 'rich', label: t('富文本') },
                      { key: 'html', label: 'HTML' },
                      { key: 'markdown', label: 'Markdown' },
                    ] as const
                  ).map((entry) => (
                    <button
                      key={entry.key}
                      type="button"
                      className={`pill${editorMode === entry.key ? ' is-on' : ''}`}
                      aria-pressed={editorMode === entry.key}
                      disabled={!editable}
                      onClick={() => switchEditorMode(entry.key)}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="editor-shortcut-hint"
                  onClick={() => setShortcutsOpen(true)}
                  title={t('查看写作快捷键')}
                >
                  <Icon name="command" size={12} /> {t('快捷键')}
                </button>
              </div>
            </div>

            {editorMode === 'rich' ? (
              <>
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
              </>
            ) : (
              <>
                <div className="editor-source-split">
                  <div className="editor-source-pane">
                    <div className="editor-source-head">
                      <strong>{editorMode === 'html' ? 'HTML' : 'Markdown'}</strong>
                      <span className="tiny faint">{t('左侧编辑源码')}</span>
                    </div>
                    <Textarea
                      className="editor-source-input"
                      value={editorMode === 'html' ? htmlDraft : form.source_body}
                      onChange={(event) =>
                        editorMode === 'html'
                          ? changeHtmlSource(event.target.value)
                          : changeMarkdownSource(event.target.value)
                      }
                      onKeyDown={handleSourceKeyDown}
                      disabled={!editable}
                      spellCheck={false}
                      aria-label={editorMode === 'html' ? 'HTML' : 'Markdown'}
                      placeholder={
                        editorMode === 'html'
                          ? t('在这里写 HTML；右侧会实时预览。')
                          : t('在这里写 Markdown；右侧会实时预览。')
                      }
                    />
                  </div>
                  <div className="editor-preview-pane">
                    <div className="editor-source-head">
                      <strong>{t('实时预览')}</strong>
                      <span className="tiny faint">{t('与服务端同一套清洗规则')}</span>
                    </div>
                    <div
                      className="article-body editor-preview-body"
                      // HTML / Markdown 已经过 sanitizeHtml：脚本、事件属性与危险 URL 都会被剥掉。
                      dangerouslySetInnerHTML={{ __html: livePreview }}
                    />
                  </div>
                </div>
                <p className="field-hint">
                  {t('HTML 与 Markdown 会互相转换：在这里改完切到另一种格式，内容会同步过去；保存时统一写成 Markdown。')}
                </p>
              </>
            )}

            {pendingDraft && draftDeferred ? (
              <Callout tone="warn" icon="alert" title={t('有未处理的本地草稿')}>
                <p className="small muted" style={{ margin: 0 }}>
                  {t('继续编辑会覆盖旧草稿；也可以现在恢复。')}
                </p>
                <div className="row gap-8 mt-8">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => restoreDraft(pendingDraft)}
                  >
                    {t('恢复本地草稿')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => discardDraft()}>
                    {t('丢弃本地草稿')}
                  </Button>
                </div>
              </Callout>
            ) : null}

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
                  <h3>{t('发布与访问')}</h3>
                  <p>{t('预约发布时间、访问权限与单篇评论策略。')}</p>
                </div>
              </div>
              <div className="panel-body form-stack">
                <Field
                  label={t('预约发布时间')}
                  htmlFor="editor-publish-at"
                  hint={
                    !canPublishDirectly
                      ? t('站点要求先审核，审核通过后才能预约或直接发布。')
                      : form.publish_at
                        ? t('保存后到点自动发布；手动发布会清除预约。')
                        : t('留空表示不预约。到点后由服务端自动发布。')
                  }
                >
                  <div className="row gap-8">
                    <Input
                      id="editor-publish-at"
                      type="datetime-local"
                      value={form.publish_at}
                      disabled={!editable || published || !canPublishDirectly}
                      onChange={(event) => update({ publish_at: event.target.value })}
                    />
                    {form.publish_at && canPublishDirectly ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!editable || published}
                        onClick={() => update({ publish_at: '' })}
                      >
                        {t('取消预约')}
                      </Button>
                    ) : null}
                  </div>
                </Field>

                <Field
                  label={t('访问权限')}
                  htmlFor="editor-access-mode"
                  hint={
                    form.access_mode === 'public'
                      ? t('公开内容会出现在列表、搜索与订阅源里。')
                      : t('密码与仅登录内容只能通过链接访问，不会出现在列表、搜索、订阅源或站点地图里。')
                  }
                >
                  <Select
                    id="editor-access-mode"
                    value={form.access_mode}
                    disabled={!editable}
                    onChange={(event) =>
                      update({
                        access_mode: event.target.value as ContentAccessMode,
                        access_password: '',
                      })
                    }
                  >
                    <option value="public">{t('公开')}</option>
                    <option value="password">{t('密码访问')}</option>
                    <option value="members">{t('仅登录读者')}</option>
                  </Select>
                </Field>

                {form.access_mode === 'password' ? (
                  <Field
                    label={t('访问密码')}
                    htmlFor="editor-access-password"
                    hint={
                      item?.has_access_password
                        ? t('已设置访问密码；留空表示保持不变。')
                        : t('至少 4 个字符，保存后只保留哈希。')
                    }
                  >
                    <Input
                      id="editor-access-password"
                      type="password"
                      autoComplete="new-password"
                      value={form.access_password}
                      maxLength={128}
                      disabled={!editable}
                      placeholder={item?.has_access_password ? t('留空保持不变') : t('设置访问密码')}
                      onChange={(event) => update({ access_password: event.target.value })}
                    />
                  </Field>
                ) : null}

                <Field
                  label={t('评论策略')}
                  htmlFor="editor-comment-policy"
                  hint={t('单篇设置优先于站点级评论开关。')}
                >
                  <Select
                    id="editor-comment-policy"
                    value={form.comment_policy}
                    disabled={!editable}
                    onChange={(event) =>
                      update({ comment_policy: event.target.value as ContentCommentPolicy })
                    }
                  >
                    <option value="inherit">{t('跟随站点设置')}</option>
                    <option value="open">{t('开启评论')}</option>
                    <option value="disabled">{t('关闭评论')}</option>
                    <option value="review">{t('先审后发')}</option>
                  </Select>
                </Field>
              </div>
            </div>

            <div className="panel">
              <div className="panel-head">
                <div>
                  <h3>{t('分类与标签')}</h3>
                  <p>{t('分类用于归档，标签用于跨分类关联主题。')}</p>
                </div>
                {adminEntry ? (
                  <Link to="/admin/taxonomy" className="link-btn">
                    {t('管理')}
                  </Link>
                ) : null}
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
                  <p>{t('右上角决定存草稿还是发布；这里显示当前状态。')}</p>
                </div>
                {item ? <StatusBadge status={item.status} /> : <Badge tone="muted">{t('未保存')}</Badge>}
              </div>
              <div className="panel-body">
                <div className="mini-list">
                  <div className="mini-row">
                    <span className="mini-label">{t('当前状态')}</span>
                    <span className="mini-value">{item ? STATUS_LABEL[item.status] : t('未保存')}</span>
                  </div>
                  <div className="mini-row">
                    <span className="mini-label">{t('发布模式')}</span>
                    <span className="mini-value">{site ? PUBLISH_LABEL[site.publish_mode] : '—'}</span>
                  </div>
                </div>
                <p className="field-hint mt-12">
                  {t('作者不能审核自己的内容；如果当前账户没有直接发布权限，右上角主按钮会显示「提交审核」。')}
                </p>
              </div>
            </div>

            {item ? (
              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h3>{t('版本历史')}</h3>
                    <p>{t('每次保存都会留下一个可回滚的版本，最多保留 20 个。')}</p>
                  </div>
                </div>
                <div className="panel-body">
                  {history.loading ? (
                    <p className="tiny faint">{t('正在载入版本历史')}</p>
                  ) : history.error ? (
                    <p className="tiny faint">{t('无法读取版本历史')}</p>
                  ) : !history.data?.items.length ? (
                    <p className="tiny faint">{t('还没有版本记录')}</p>
                  ) : (
                    <div className="mini-list">
                      {history.data.items.map((revision) => (
                        <div className="mini-row" key={revision.id}>
                          <span className="mini-label">
                            v{revision.version} · {revisionActionLabel(revision.action)}
                            <br />
                            <span className="tiny faint">{formatDateTime(revision.created_at)}</span>
                          </span>
                          <span className="mini-value" style={{ display: 'flex', gap: 6 }}>
                            <Button
                              variant="ghost"
                              size="sm"
                              loading={revisionBusy === revision.id}
                              onClick={() => void openRevision(revision)}
                            >
                              {t('查看')}
                            </Button>
                            {!isCurrentVersion(revision) ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                icon="refresh"
                                onClick={() => setRestoreTarget(revision)}
                              >
                                {t('回滚')}
                              </Button>
                            ) : null}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : null}

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
                          ? t('已发布内容仍可修订，归档由编辑执行。')
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

      <Modal
        open={shortcutsOpen}
        title={t('写作快捷键')}
        description={t('在正文里直接使用；Mac 上把 Ctrl 换成 ⌘。输入法组合期间不会触发。')}
        onClose={() => setShortcutsOpen(false)}
        footer={
          <Button onClick={() => setShortcutsOpen(false)}>{t('知道了')}</Button>
        }
      >
        <div className="shortcut-list">
          {(
            [
              { keys: ['Ctrl', 'S'], label: t('保存草稿') },
              { keys: ['Ctrl', 'Enter'], label: t('发布或提交审核') },
              { keys: ['Ctrl', 'B'], label: t('粗体') },
              { keys: ['Ctrl', 'I'], label: t('斜体') },
              { keys: ['Ctrl', 'K'], label: t('插入链接') },
              { keys: ['Ctrl', 'Alt', '1–3'], label: t('标题二 / 三 / 四级（富文本）') },
              { keys: ['Ctrl', 'Shift', '7'], label: t('有序列表（富文本）') },
              { keys: ['Ctrl', 'Shift', '8'], label: t('无序列表（富文本）') },
              { keys: ['Ctrl', 'Shift', '9'], label: t('引用（富文本）') },
              { keys: ['Tab'], label: t('源码缩进两格（HTML / Markdown）') },
              { keys: ['/'], label: t('打开插入指令（富文本）') },
            ] as { keys: string[]; label: string }[]
          ).map((entry) => (
            <div className="shortcut-row" key={entry.label}>
              <span className="shortcut-label">{entry.label}</span>
              <span className="shortcut-keys">
                {entry.keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </Modal>

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

      <Modal
        open={!!revisionView}
        title={revisionView ? t('版本 {version}', { version: revisionView.version }) : ''}
        description={
          revisionView
            ? `${revisionActionLabel(revisionView.action)} · ${formatDateTime(revisionView.created_at)}`
            : undefined
        }
        onClose={() => setRevisionView(null)}
        footer={
          revisionView ? (
            <>
              <Button variant="ghost" onClick={() => setRevisionView(null)}>
                {t('关闭')}
              </Button>
              {!isCurrentVersion(revisionView) ? (
                <Button
                  variant="secondary"
                  icon="refresh"
                  onClick={() => {
                    setRevisionView(null);
                    setRestoreTarget(revisionView);
                  }}
                >
                  {t('回滚到此版本')}
                </Button>
              ) : null}
            </>
          ) : null
        }
      >
        {revisionView ? (
          <>
            <div className="mini-list">
              <div className="mini-row">
                <span className="mini-label">{t('标题')}</span>
                <span className="mini-value">{revisionView.title}</span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('状态')}</span>
                <span className="mini-value">{STATUS_LABEL[revisionView.status] ?? revisionView.status}</span>
              </div>
              <div className="mini-row">
                <span className="mini-label">{t('编辑者')}</span>
                <span className="mini-value">{revisionView.editor_name ?? revisionView.editor_id}</span>
              </div>
            </div>
            <pre
              className="small mono mt-12"
              style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto' }}
            >
              {revisionView.source_body}
            </pre>
          </>
        ) : null}
      </Modal>

      <Modal
        open={!!restoreTarget}
        title={t('回滚这份稿件？')}
        description={t('回滚前会先备份当前版本，因此回滚本身也可以撤销；发布状态不会改变。')}
        onClose={() => setRestoreTarget(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRestoreTarget(null)}>
              {t('取消')}
            </Button>
            <Button
              variant="danger"
              loading={!!restoreTarget && revisionBusy === restoreTarget.id}
              onClick={() => void restoreRevision()}
            >
              {t('确认回滚')}
            </Button>
          </>
        }
      >
        <p className="small muted">
          {restoreTarget
            ? t('将恢复到版本 {version}（{date}）。', {
                version: restoreTarget.version,
                date: formatDateTime(restoreTarget.created_at),
              })
            : ''}
        </p>
      </Modal>

      <Modal
        open={!!pendingDraft && !draftDeferred}
        title={draftConflict ? t('发现本地草稿，服务器版本已更新') : t('恢复上次编辑？')}
        description={
          pendingDraft
            ? draftConflict
              ? t('服务器上的版本在本地草稿之后更新过。恢复并保存会覆盖服务器版本；如果拿不准，先用服务器版本。')
              : t('发现 {time} 自动保存的本地草稿。', {
                  time: formatDateTime(new Date(pendingDraft.saved_at).toISOString()),
                })
            : undefined
        }
        onClose={() => setDraftDeferred(true)}
        footer={
          pendingDraft ? (
            <>
              <Button variant="ghost" onClick={() => setDraftDeferred(true)}>
                {t('稍后再说')}
              </Button>
              <Button
                variant={draftConflict ? 'primary' : 'ghost'}
                onClick={() => discardDraft()}
              >
                {draftConflict ? t('使用服务器版本') : t('丢弃本地草稿')}
              </Button>
              <Button
                variant={draftConflict ? 'secondary' : 'primary'}
                onClick={() => restoreDraft(pendingDraft)}
              >
                {t('恢复本地草稿')}
              </Button>
            </>
          ) : null
        }
      >
        {pendingDraft ? (
          <>
            <div className="mini-list">
              <div className="mini-row">
                <span className="mini-label">{t('本地草稿')}</span>
                <span className="mini-value">
                  {pendingDraft.payload.title.trim() || t('未命名')}
                  {' · '}
                  {formatDateTime(new Date(pendingDraft.saved_at).toISOString())}
                </span>
              </div>
              {!isNew && item ? (
                <div className="mini-row">
                  <span className="mini-label">{t('服务器版本')}</span>
                  <span className="mini-value">{formatDateTime(item.updated_at)}</span>
                </div>
              ) : null}
              <div className="mini-row">
                <span className="mini-label">{t('正文')}</span>
                <span className="mini-value">
                  {t('{count} 字符', {
                    count: pendingDraft.payload.source_body.length.toLocaleString(),
                  })}
                </span>
              </div>
            </div>
            <p className="field-hint mt-12">
              {t('恢复本地草稿会替换当前编辑区的内容；服务端版本在保存之前不会被改动。')}
            </p>
          </>
        ) : null}
      </Modal>
    </>
  );
}
