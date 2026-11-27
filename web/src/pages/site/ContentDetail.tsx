import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Comment, ContentKind, ReportReason, ToggleResult } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend, isDemo } from '../../lib/backend';
import { useAsync, useScrollProgress } from '../../lib/hooks';
import { ApiError, isBackendOffline } from '../../lib/api';
import { captchaReasonText, captchaSceneRequired } from '../../lib/captcha';
import {
  KIND_LABEL,
  formatDate,
  formatDateTime,
  readingTime,
} from '../../lib/format';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  EmptyState,
  Field,
  Modal,
  Select,
  Skeleton,
  StatusBadge,
  Textarea,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { Cover } from '../../components/Cover';
import { FeedProvider } from '../../components/blocks/FeedContext';
import { ArticleProvider } from '../../components/blocks/ArticleContext';
import { ScreenRenderer } from '../../components/blocks';
import { hasArticleContent, screenHasBlocks } from '../../lib/blocks';
import { useCustomization } from '../../lib/customize';
import { coverImageStyle, useCoverHidden, visibleCoverFor } from '../../lib/covers';
import { useTaxonomy } from '../../lib/useTaxonomy';
import { usePermissions } from '../../lib/usePermissions';
import { copyText } from '../../lib/clipboard';
import { ArticleBreadcrumb, ArticleToc, FloatingToc, useArticleDiagrams, useArticleToc, useCodeCopy } from '../../components/ArticleTools';
import { ReadingToolbar } from '../../components/ReadingToolbar';
import { ResponsiveHtml } from '../../components/ResponsiveHtml';
import { CaptchaField, useCaptchaStatus } from '../../components/Captcha';
import { useArticleMath } from '../../components/ArticleMath';
import { useToast } from '../../lib/toast';
import { useSeo, articleJsonLd, breadcrumbJsonLd } from '../../lib/seo';
import { firstImage } from '../../lib/markdown';
import { useT } from '../../lib/i18n';
import {
  clipTitle,
  contentPath,
  pickNeighbors,
  pickRelated,
} from './readExperience';

interface CommentNode extends Comment {
  children: CommentNode[];
}

function buildTree(items: Comment[]): CommentNode[] {
  const map = new Map<string, CommentNode>();
  for (const item of items) map.set(item.id, { ...item, children: [] });
  const roots: CommentNode[] = [];
  for (const node of map.values()) {
    if (node.parent_id && map.has(node.parent_id)) {
      map.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function CommentItem({
  node,
  depth,
  meId,
  moderator,
  replyTo,
  onReply,
  onCancelReply,
  onSubmitReply,
  onEdit,
  onDelete,
  busy,
  captchaSlot,
  captchaBlocked = false,
}: {
  node: CommentNode;
  depth: number;
  meId?: string;
  moderator: boolean;
  replyTo: string | null;
  onReply: (id: string) => void;
  onCancelReply: () => void;
  onSubmitReply: (body: string) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  onDelete: (comment: Comment) => void;
  busy: boolean;
  /** 回复框里的人机验证组件；由页面持有 token，所以从上面传下来。 */
  captchaSlot?: ReactNode;
  /** 组件加载失败时禁用发送，避免提交一次注定被拒的回复。 */
  captchaBlocked?: boolean;
}) {
  const t = useT();
  const [replyBody, setReplyBody] = useState('');
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(node.body);
  const own = node.author_id && node.author_id === meId;
  const deleted = node.status === 'deleted';

  return (
    <div className={`comment${depth > 0 ? ' is-nested' : ''}`} style={depth > 0 ? { marginLeft: Math.min(depth, 2) * 26 } : undefined}>
      <div className="comment-head">
        <Avatar name={node.author_name ?? t('读者')} size={26} />
        <strong>{node.author_name ?? t('读者')}</strong>
        {node.created_at ? <time>{formatDate(node.created_at)}</time> : null}
        {deleted ? <Badge tone="muted">{t('已删除')}</Badge> : null}
        {node.status === 'pending_review' ? <Badge tone="warn">{t('待审核')}</Badge> : null}
        <span className="comment-actions">
          {!deleted && node.status !== 'pending_review' && meId ? (
            <button type="button" className="link-btn" onClick={() => onReply(node.id)}>
              {t('回复')}
            </button>
          ) : null}
          {!deleted && own ? (
            <button type="button" className="link-btn" onClick={() => setEditing((v) => !v)}>
              {t('编辑')}
            </button>
          ) : null}
          {!deleted && (own || moderator) ? (
            <button type="button" className="link-btn is-danger" onClick={() => onDelete(node)}>
              {t('删除')}
            </button>
          ) : null}
        </span>
      </div>

      {deleted ? (
        <p className="comment-deleted">{t('该评论已删除。')}</p>
      ) : editing ? (
        <div className="comment-reply-box">
          <Textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} maxLength={5000} />
          <div className="row gap-8 mt-8">
            <Button
              size="sm"
              loading={busy}
              onClick={async () => {
                await onEdit(node.id, editBody);
                setEditing(false);
              }}
            >
              {t('保存')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t('取消')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="comment-body">{node.body}</p>
      )}

      {replyTo === node.id ? (
        <div className="comment-reply-box">
          <Textarea
            autoFocus
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            placeholder={t('回复 {name}…', { name: node.author_name ?? t('这条评论') })}
            maxLength={5000}
            style={{ minHeight: 76 }}
          />
          {captchaSlot}
          <div className="row gap-8 mt-8">
            <Button
              size="sm"
              loading={busy}
              disabled={captchaBlocked || !replyBody.trim()}
              onClick={async () => {
                await onSubmitReply(replyBody);
                setReplyBody('');
              }}
            >
              {t('发送回复')}
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancelReply}>
              {t('取消')}
            </Button>
          </div>
        </div>
      ) : null}

      {node.children.length ? (
        <div className="comment-replies">
          {node.children.map((child) => (
            <CommentItem
              key={child.id}
              node={child}
              depth={depth + 1}
              meId={meId}
              moderator={moderator}
              replyTo={replyTo}
              onReply={onReply}
              onCancelReply={onCancelReply}
              onSubmitReply={onSubmitReply}
              onEdit={onEdit}
              onDelete={onDelete}
              busy={busy}
              captchaSlot={captchaSlot}
              captchaBlocked={captchaBlocked}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ContentDetailPage({ kind }: { kind: ContentKind }) {
  const t = useT();
  const { id = '' } = useParams();
  const { me, site } = useAuth();
  const { customization } = useCustomization();
  // 沉思主题的阅读版式只在这里加开关，其他主题仍走原有文章页。
  const contemplation =
    customization.active_theme === 'contemplation' || customization.theme.preset === 'contemplation';
  // 文章页附加区块：在正文与评论区之间渲染，由「页面编排 → 文章页」维护。
  const articleLayout = customization.article ?? { blocks: [] };
  // 编排里放了「文章内容」占位符时，整份编排挪到正文的位置，由占位符渲染正文；
  // 否则保持旧行为：正文照旧，编排区块排在评论区之后。
  const layoutOwnsBody = hasArticleContent(articleLayout);
  const { taxonomy } = useTaxonomy();
  const { can, adminEntry } = usePermissions();
  const extensions = customization.extensions;
  const backend = useBackend();
  const demo = isDemo(backend);
  // 真实后端以站点字段为准；演示模式保留本地设计里的评论配置。
  const commentSettings = demo
    ? customization.comments
    : {
        ...customization.comments,
        enabled: site?.comments_enabled ?? true,
        require_review: site?.comments_require_review ?? false,
      };
  const navigate = useNavigate();
  const toast = useToast();
  const progress = useScrollProgress();
  const [reaction, setReaction] = useState(false);
  const [bookmarked, setBookmarked] = useState(false);
  const [following, setFollowing] = useState(false);
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Comment | null>(null);
  const [reporting, setReporting] = useState(false);
  const [reportReason, setReportReason] = useState<ReportReason>('spam');
  const [reportNote, setReportNote] = useState('');
  const [reportBusy, setReportBusy] = useState(false);
  // 评论人机验证：站点开启后，评论与回复都要带 token；token 一次性，提交后清空。
  const captcha = useCaptchaStatus();
  const captchaRequired = captchaSceneRequired(captcha.status, 'comment');
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaNonce, setCaptchaNonce] = useState(0);
  const [captchaFailure, setCaptchaFailure] = useState('');
  const captchaBlocked = captchaRequired && !!captchaFailure;
  // 密码文章的解锁表单：密码只提交给 /unlock，成功授权保存在 HttpOnly Cookie。
  const [unlockPassword, setUnlockPassword] = useState('');
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockError, setUnlockError] = useState('');

  const content = useAsync(() => backend.getContent(kind, id), [backend, kind, id]);
  const item = content.data;
  // 内容响应只带 author_id，不带作者名。作者名缺失时补一次公开资料请求；
  // author_name 已经在响应里（或内容没有作者）时完全不发请求。依赖里带 author_id，
  // useAsync 会按作者去重，同一篇文章不会重复请求。
  const authorProfile = useAsync(async () => {
    if (!item?.author_id || item.author_name) return null;
    try {
      return await backend.publicUser(item.author_id);
    } catch {
      // 作者资料读不到时保留兜底文案，不影响正文与评论区。
      return null;
    }
  }, [backend, item?.author_id, item?.author_name]);
  // useAsync 在新依赖解析前会保留上一份 data：导航到另一篇文章时，只有 user_id
  // 与当前作者一致的结果才算数，避免短暂显示上一篇的作者名。
  const profileAuthorName =
    authorProfile.data && authorProfile.data.user_id === item?.author_id
      ? authorProfile.data.display_name
      : undefined;
  const authorName = item?.author_name || profileAuthorName;
  // 作者明确隐藏封面时，整块 .article-hero 不渲染，避免留下空画框。
  // 封面已迁入内容模型（Beta 1.2）：内容对象优先，站点外观里的旧配置回退。
  const coverHidden = useCoverHidden(item?.id, item);
  // 详情页的封面改成「全宽封面头」：有上传的图片就铺图片，没有就铺同款程序化封面，
  // 标题与摘要压在图上，正文顶部再衬一层同图的高斯模糊——和列表卡片共用一套封面。
  const heroCover = coverHidden ? undefined : visibleCoverFor(customization, item?.id, item);

  // 顶部透明 / 悬浮页头会被封面压在下面：给 <html> 打一个标记，让页头文字在滚动前切成白色，
  // 滚动后页头恢复实底，样式表会自动回到主题色（见 styles/articleHero.css）。
  useEffect(() => {
    const root = document.documentElement;
    // 内容还没到位时后台是白底，白色页头文字会看不见，所以只在封面真正渲染时打标记。
    if (!item || coverHidden) delete root.dataset.articleHero;
    else root.dataset.articleHero = 'on';
    return () => {
      delete root.dataset.articleHero;
    };
  }, [coverHidden, item]);

  // 沉思主题的阅读页：向下读时收起页头，向上翻时立刻放出来；离开页面就清掉标记。
  useEffect(() => {
    const root = document.documentElement;
    if (!contemplation) {
      delete root.dataset.ctReadHeader;
      return;
    }
    let lastY = window.scrollY;
    let frame = 0;
    const update = () => {
      frame = 0;
      const y = window.scrollY;
      const delta = y - lastY;
      if (y < 80 || delta < -8) root.dataset.ctReadHeader = 'shown';
      else if (y > 240 && delta > 10) root.dataset.ctReadHeader = 'hidden';
      lastY = y;
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };
    root.dataset.ctReadHeader = 'shown';
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
      delete root.dataset.ctReadHeader;
    };
  }, [contemplation]);
  // 内容级 SEO 覆盖（Beta 1.2）：交给 lib/seo.ts 合并，字段缺省时自动回退站点级配置。
  // 只挑这几个字段而不是整份 item：useSeo 内部会用 JSON.stringify 比较输入，
  // 把 rendered_html 也塞进去会让每次渲染都白序列化一份正文。
  const seoOverrides = useMemo(
    () => ({
      seo_title: item?.seo_title,
      seo_description: item?.seo_description,
      seo_keywords: item?.seo_keywords,
      canonical_url: item?.canonical_url,
      og_image: item?.og_image,
      cover_url: item?.cover_url,
      robots: item?.robots,
    }),
    [item],
  );
  // 详情页的 SEO 在数据到位后写入。分享图优先级由 lib/seo.ts 决定：
  // 内容 og_image → 内容封面 → 正文第一张图 → 站点默认分享图。
  useSeo({
    title: item?.title,
    description: item?.summary,
    path: `/${kind === 'article' ? 'a' : 'p'}/${id}`,
    type: 'article',
    image: item ? firstImage(item.rendered_html) : undefined,
    publishedAt: item?.published_at,
    modifiedAt: item?.updated_at,
    author: authorName,
    keywords: item?.kind === 'article' ? [t('文章')] : [t('帖子')],
    content: seoOverrides,
    jsonLd: item
      ? [
          articleJsonLd({
            content: item,
            url: `${window.location.origin}/${kind === 'article' ? 'a' : 'p'}/${item.id}`,
            siteName: site?.name ?? 'Practacu Press',
            publisher: customization.seo.publisher || site?.name || 'Practacu Press',
            image: firstImage(item.rendered_html),
            author: authorName,
          }),
          breadcrumbJsonLd([
            { name: t('首页'), url: `${window.location.origin}/` },
            {
              name: kind === 'article' ? t('文章') : t('帖子'),
              url: `${window.location.origin}/${kind === 'article' ? 'articles' : 'posts'}`,
            },
            { name: item.title, url: `${window.location.origin}/${kind === 'article' ? 'a' : 'p'}/${item.id}` },
          ]),
        ]
      : [],
  });
  const toc = useArticleToc(item?.rendered_html);
  // 先水合图表、再挂代码复制按钮：图表块水合后不是 pre，不会多出一个复制按钮。
  useArticleDiagrams(item?.rendered_html);
  useCodeCopy(extensions.code_copy, item?.rendered_html);
  // 公式按需加载 KaTeX：没有公式的文章不下载引擎。
  useArticleMath(item?.rendered_html);

  const comments = useAsync(() => backend.comments(kind, id), [backend, kind, id]);
  // 相关推荐 / 上下篇共用一个同类内容池。契约没有 related 端点，
  // 100 篇足够覆盖常见站点；更大的站点会退化成「最近 100 篇里选」。
  const pool = useAsync(async () => {
    const page = await backend.listContent(kind, { limit: 100 });
    return page.items;
  }, [backend, kind]);
  const relatedItems = useMemo(() => pickRelated(item ?? undefined, pool.data ?? []), [item, pool.data]);
  const neighbors = useMemo(() => pickNeighbors(pool.data ?? [], id), [pool.data, id]);

  // 刷新后恢复已赞 / 已收藏 / 已关注。`me` 进入依赖：匿名首帧拿到的是全 false，
  // 登录态水合完成后要再查一次，否则已登录用户会看到未选中，第一次点击反而取消。
  useEffect(() => {
    if (!item) return;
    let alive = true;
    backend
      .stateFor(kind, id, item.author_id)
      .then((state) => {
        if (!alive) return;
        setReaction(state.liked);
        setBookmarked(state.bookmarked);
        setFollowing(state.following);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [backend, kind, id, item, me?.user.id]);

  // 阅读历史只对登录用户有意义；失败不能影响正文展示。
  useEffect(() => {
    if (!me || !item) return;
    void backend.recordReading(kind, id).catch(() => undefined);
  }, [backend, kind, id, item, me?.user.id]);

  const tree = useMemo(() => buildTree(comments.data?.items ?? []), [comments.data]);
  const visibleComments = (comments.data?.items ?? []).filter((c) => c.status !== 'deleted').length;

  // 单篇评论策略覆盖站点开关（C-19）：关闭优先，开启/先审后发各自覆盖站点值。
  const contentCommentPolicy = item?.comment_policy ?? 'inherit';
  const commentsEnabled =
    contentCommentPolicy === 'disabled'
      ? false
      : contentCommentPolicy === 'open' || contentCommentPolicy === 'review'
        ? true
        : commentSettings.enabled;
  const commentsRequireReview =
    contentCommentPolicy === 'review'
      ? true
      : contentCommentPolicy === 'open'
        ? false
        : commentSettings.require_review;

  const requireLogin = () => {
    navigate(`/login?next=${encodeURIComponent(`/${kind === 'article' ? 'a' : 'p'}/${id}`)}`);
  };

  /** 提交访问密码；成功后重新读取正文，失败时保留表单并显示原因。 */
  const unlock = async () => {
    if (!unlockPassword.trim()) return;
    setUnlockBusy(true);
    setUnlockError('');
    try {
      await backend.unlockContent(kind, id, unlockPassword);
      setUnlockPassword('');
      content.reload();
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : t('解锁失败。'));
    } finally {
      setUnlockBusy(false);
    }
  };

  const toggleReaction = async () => {
    if (!me) return requireLogin();
    try {
      const result: ToggleResult = await backend.toggleReaction(kind, id, 'like');
      setReaction(result.active);
      toast.push('ok', result.active ? t('已点赞') : t('已取消点赞'));
    } catch (err) {
      toast.push('error', t('操作失败'), err instanceof Error ? err.message : undefined);
    }
  };

  const toggleBookmark = async () => {
    if (!me) return requireLogin();
    try {
      const result = await backend.toggleBookmark(kind, id);
      setBookmarked(result.active);
      toast.push('ok', result.active ? t('已加入收藏') : t('已取消收藏'));
    } catch (err) {
      toast.push('error', t('操作失败'), err instanceof Error ? err.message : undefined);
    }
  };

  const toggleFollow = async () => {
    if (!me || !item?.author_id) return;
    try {
      const result = await backend.toggleFollow(item.author_id);
      setFollowing(result.active);
      toast.push('ok', result.active ? t('已关注作者') : t('已取消关注'));
    } catch (err) {
      toast.push('error', t('操作失败'), err instanceof Error ? err.message : undefined);
    }
  };

  const share = async () => {
    const ok = await copyText(window.location.href);
    if (ok) toast.push('ok', t('链接已复制'));
    else toast.push('error', t('无法复制链接'), t('请从地址栏手动复制。'));
  };

  const shareNative = async () => {
    if (!item) return;
    const url = window.location.href;
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: item.title, url });
        return;
      } catch {
        /* 用户取消或系统不支持，退回复制链接 */
      }
    }
    await share();
  };

  const submitComment = async (text: string, parentId?: string) => {
    if (!text.trim()) return;
    if (!me) return requireLogin();
    if (!can('comment')) {
      toast.push('error', t('没有评论权限'), t('站长可以在用户组里开启这项能力。'));
      return;
    }
    setBusy(true);
    try {
      const created = await backend.createComment(
        {
          target_type: parentId ? 'comment' : kind,
          target_id: parentId ?? id,
          parent_id: parentId,
          body: text,
          captcha_token: captchaToken || undefined,
        },
        { require_review: commentsRequireReview },
      );
      setBody('');
      setReplyTo(null);
      resetCaptcha();
      comments.reload();
      if (created.status === 'pending_review') {
        toast.push(
          'ok',
          parentId ? t('回复已提交') : t('评论已提交'),
          t('通过审核后才会公开显示。'),
        );
      } else {
        toast.push('ok', parentId ? t('回复已发送') : t('评论已发布'));
      }
    } catch (err) {
      resetCaptcha();
      const reason =
        err instanceof ApiError
          ? (err.problem.details as { reason?: string } | undefined)?.reason
          : undefined;
      toast.push(
        'error',
        t('发送失败'),
        captchaReasonText(reason, t) || (err instanceof Error ? err.message : undefined),
      );
    } finally {
      setBusy(false);
    }
  };

  /** 清掉已用过的 token 并重挂组件；提交成功或失败都要调用。 */
  const resetCaptcha = () => {
    setCaptchaToken('');
    setCaptchaFailure('');
    setCaptchaNonce((value) => value + 1);
  };

  const editComment = async (commentId: string, text: string) => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await backend.updateComment(commentId, text);
      comments.reload();
      toast.push('ok', t('评论已更新'));
    } catch (err) {
      toast.push('error', t('更新失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const submitReport = async () => {
    if (!item) return;
    setReportBusy(true);
    try {
      await backend.report({
        target_type: item.kind,
        target_id: item.id,
        reason: reportReason,
        note: reportNote.trim(),
      });
      setReporting(false);
      setReportNote('');
      setReportReason('spam');
      toast.push('ok', t('举报已提交'), t('站长会尽快处理，感谢你的反馈。'));
    } catch (err) {
      toast.push('error', t('举报失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setReportBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await backend.deleteComment(deleting.id);
      setDeleting(null);
      comments.reload();
      toast.push('ok', t('评论已删除'));
    } catch (err) {
      toast.push('error', t('删除失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  if (content.loading) {
    return (
      <div className="shell">
        <div className="article" style={{ maxWidth: 760, margin: '0 auto' }}>
          <Skeleton lines={2} />
          <div className="mt-24">
            <Skeleton lines={8} />
          </div>
        </div>
      </div>
    );
  }

  // 访问控制的两种拒绝先于通用错误页处理：读者需要看到密码墙或登录提示，而不是
  // 「内容不存在」。服务端不会在 403 里返回标题或摘要，以免泄露。
  const accessReason =
    content.error instanceof ApiError
      ? String((content.error.problem.details as { reason?: unknown } | undefined)?.reason ?? '')
      : '';

  if (content.error instanceof ApiError && accessReason === 'password_required') {
    return (
      <div className="shell">
        <div className="article" style={{ maxWidth: 520, margin: '0 auto', paddingTop: 72 }}>
          <EmptyState
            icon="lock"
            title={t('这篇内容受密码保护')}
            body={t('输入作者设置的访问密码后即可阅读。密码只保存在当前浏览器会话中。')}
          />
          <div className="comment-form" style={{ marginTop: 20 }}>
            <Field label={t('访问密码')} htmlFor="content-unlock-password">
              <input
                id="content-unlock-password"
                className="input"
                type="password"
                autoComplete="current-password"
                value={unlockPassword}
                maxLength={128}
                onChange={(event) => setUnlockPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void unlock();
                  }
                }}
              />
            </Field>
            {unlockError ? (
              <Callout tone="danger" icon="alert">
                {unlockError}
              </Callout>
            ) : null}
            <div className="row gap-8 mt-8">
              <Button size="sm" loading={unlockBusy} disabled={!unlockPassword.trim()} onClick={() => void unlock()}>
                {t('解锁阅读')}
              </Button>
              <Link to={kind === 'article' ? '/articles' : '/posts'} className="btn btn-secondary btn-sm">
                {t('返回列表')}
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (content.error instanceof ApiError && accessReason === 'members_only') {
    return (
      <div className="shell">
        <div style={{ paddingTop: 64 }}>
          <EmptyState
            icon="lock"
            title={t('这篇内容仅登录读者可读')}
            body={t('请先登录账户，再回到这个链接继续阅读。')}
            action={
              <button type="button" className="btn btn-primary btn-sm" onClick={requireLogin}>
                {t('登录后阅读')}
              </button>
            }
          />
        </div>
      </div>
    );
  }

  if (content.error || !item) {
    const notFound = content.error instanceof ApiError && content.error.code === 'not_found';
    const offline = isBackendOffline(content.error);
    return (
      <div className="shell">
        <div style={{ paddingTop: 64 }}>
          <EmptyState
            icon={notFound ? 'file' : offline ? 'alert' : 'lock'}
            title={
              notFound
                ? t('这篇内容不存在')
                : offline
                  ? t('无法连接 API')
                  : t('暂时无法打开')
            }
            body={
              content.error instanceof ApiError
                ? content.error.message
                : content.error instanceof Error
                  ? content.error.message
                  : t('请稍后重试。')
            }
            action={
              <div className="row gap-8" style={{ justifyContent: 'center' }}>
                <Link
                  to={kind === 'article' ? '/articles' : '/posts'}
                  className="btn btn-secondary btn-sm"
                >
                  {t('返回列表')}
                </Link>
                {content.error && !notFound ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={content.reload}
                  >
                    {t('重试')}
                  </button>
                ) : null}
              </div>
            }
          />
        </div>
      </div>
    );
  }

  const url = `/${kind === 'article' ? 'a' : 'p'}/${item.id}`;
  // 作者名优先用响应里的字段；缺失时用公开资料补齐，真正读不到时才退回「作者」。
  const authorLabel = authorName ?? t('作者');
  const isUnpublished = item.status !== 'published';
  // 分类名同时用于文章头的分类标记与「显示什么数据」里的「分类」。
  const articleCategory = item.category_id
    ? taxonomy.categories.find((term) => term.id === item.category_id)
    : undefined;

  // 封面式页头和「隐藏封面」时的旧页头都要出现同一份元信息与分类标记，
  // 抽成函数共用，避免两处以后各自漂移。
  const metaRow = (extraClass = '') => (
    <div className={`article-meta${extraClass ? ` ${extraClass}` : ''}`}>
      <span className="author-line">
        <Avatar name={authorLabel} size={32} />
        <span>
          <span className="author-name">{authorLabel}</span>
          <span className="meta-text" style={{ display: 'block' }}>
            {formatDateTime(item.published_at ?? item.created_at)}
          </span>
        </span>
      </span>
      <span className="dot" />
      <span className="meta-text">
        {t('{count} 分钟阅读', { count: readingTime(item.rendered_html) })}
      </span>
      {typeof item.view_count === 'number' ? (
        <>
          <span className="dot" />
          {/* 单篇阅读量（FSD A-16）：服务端去重后的真实阅读次数，作者与编辑的访问不计入。 */}
          <span className="meta-text">{t('{count} 次阅读', { count: item.view_count })}</span>
        </>
      ) : null}
      <div className="article-meta-actions">
        <button type="button" className="icon-btn" onClick={share} aria-label={t('复制链接')}>
          <Icon name="copy" size={16} />
        </button>
        {me && me.user.id !== item.author_id ? (
          <button
            type="button"
            className="icon-btn"
            onClick={() => setReporting(true)}
            aria-label={t('举报这篇内容')}
            title={t('举报')}
          >
            <Icon name="alert" size={16} />
          </button>
        ) : null}
        {me && adminEntry && can('moderate_content') ? (
          <Link to={`/admin/content/${item.kind}/${item.id}`} className="icon-btn" aria-label={t('在后台编辑')}>
            <Icon name="edit" size={16} />
          </Link>
        ) : null}
      </div>
    </div>
  );

  const taxonomyRow = (extraClass = '') =>
    item.category_id || item.tags?.length ? (
      <div className={`article-taxonomy${extraClass ? ` ${extraClass}` : ''}`}>
        {articleCategory || item.category_id ? (
          <Link
            to={`/category/${encodeURIComponent(articleCategory?.slug ?? item.category_id ?? '')}`}
            className="article-cat"
            style={{ '--pp-cat-color': articleCategory?.color ?? 'var(--accent)' } as CSSProperties}
          >
            {articleCategory?.name ?? t('未分类')}
          </Link>
        ) : null}
        {(item.tags ?? []).map((tag) => {
          const term = taxonomy.tags.find((entry) => entry.name === tag);
          return (
            <Link key={tag} to={`/tag/${encodeURIComponent(term?.slug ?? tag)}`} className="article-tag">
              #{tag}
            </Link>
          );
        })}
      </div>
    ) : null;

  const firstTag = item.tags?.[0];
  const firstTagTerm = firstTag
    ? taxonomy.tags.find((entry) => entry.name === firstTag)
    : undefined;
  const breadcrumb = [
    { label: t('首页'), href: '/' },
    articleCategory
      ? { label: articleCategory.name, href: `/category/${encodeURIComponent(articleCategory.slug)}` }
      : firstTag
        ? { label: firstTag, href: `/tag/${encodeURIComponent(firstTagTerm?.slug ?? firstTag)}` }
        : {
            label: KIND_LABEL[kind],
            href: kind === 'article' ? '/articles' : '/posts',
          },
    { label: item.title },
  ];

  return (
    <>
      {extensions.reading_progress && progress > 0.01 ? (
        <div className="read-progress" style={{ width: `${progress * 100}%` }} />
      ) : null}

      <ReadingToolbar toc={toc} title={item.title} />

      {coverHidden ? null : (
        <section className="article-hero" aria-label={t('封面')}>
          <div className="article-hero-media">
            {heroCover ? (
              <img src={heroCover.url} alt="" aria-hidden="true" style={coverImageStyle(heroCover)} />
            ) : (
              <Cover seed={item.id} label={item.title} ratio="auto" plain />
            )}
          </div>
          <div className="article-hero-veil" aria-hidden="true" />
          <div className="article-hero-inner shell">
            <div className="article-hero-top">
              <Link to={kind === 'article' ? '/articles' : '/posts'} className="article-hero-back">
                <Icon name="arrow-left" size={13} /> {t('返回{kind}列表', { kind: KIND_LABEL[kind] })}
              </Link>
              {isUnpublished ? <StatusBadge status={item.status} /> : null}
            </div>
            <div className="article-hero-text">
              {contemplation ? <ArticleBreadcrumb items={breadcrumb} /> : null}
              <div className="article-hero-kicker">
                <span>{KIND_LABEL[kind]}</span>
                <span className="dot" />
                <span>{t('安全策略 · {version}', { version: item.policy_version })}</span>
              </div>
              <h1>{item.title}</h1>
              {item.summary ? <p className="article-hero-lede">{item.summary}</p> : null}
            </div>
          </div>
        </section>
      )}

      <div className={`article-stage${coverHidden ? '' : ' has-hero'}`}>
        {heroCover ? (
          <div className="article-backdrop" aria-hidden="true">
            <img src={heroCover.url} alt="" />
          </div>
        ) : null}
        <div className="shell">
          <div className="article-layout">
            {extensions.toc ? <FloatingToc items={toc} contemplation={contemplation} /> : null}
          <article className={`article${coverHidden ? '' : ' article--hero'}`}>
            {coverHidden ? (
              <div className="article-head">
                <Link to={kind === 'article' ? '/articles' : '/posts'} className="back-link">
                  <Icon name="arrow-left" size={13} /> {t('返回{kind}列表', { kind: KIND_LABEL[kind] })}
                </Link>
                {contemplation ? <ArticleBreadcrumb items={breadcrumb} /> : null}
                <div className="article-kicker">
                  <span>{KIND_LABEL[kind]}</span>
                  <span className="dot" />
                  <span>{t('安全策略 · {version}', { version: item.policy_version })}</span>
                  {isUnpublished ? <StatusBadge status={item.status} /> : null}
                </div>
                <h1>{item.title}</h1>
                {item.summary ? <p className="article-lede">{item.summary}</p> : null}
                {metaRow()}
                {taxonomyRow()}
              </div>
            ) : (
              <>
                {metaRow('article-meta--hero')}
                {taxonomyRow('article-taxonomy--hero')}
              </>
            )}

            {extensions.toc ? <ArticleToc items={toc} className="article-toc--inline" /> : null}

          {layoutOwnsBody ? (
            // 正文由编排里的「文章内容」占位符渲染：整份编排放在正文原来的位置，
            // 文章头、封面、底部操作条、作者卡与评论区的位置不变。
            <div className="article-extra-blocks">
              <ArticleProvider
                article={item}
                kind={kind}
                url={url}
                categoryName={articleCategory?.name}
              >
                <FeedProvider>
                  <ScreenRenderer
                    layout={articleLayout}
                    variant={customization.layout.variant}
                    scope={{ type: 'page', id: item.id, title: item.title }}
                  />
                </FeedProvider>
              </ArticleProvider>
            </div>
          ) : (
            <ResponsiveHtml
              className="article-body"
              // 契约规定：只渲染服务端清洗后产生的 rendered_html。
              html={item.rendered_html}
            />
          )}

          <div className="article-foot">
            <div className="reaction-row">
              {me ? (
                <>
                  <button
                    type="button"
                    className={`reaction-btn${reaction ? ' is-on' : ''}`}
                    onClick={toggleReaction}
                    aria-pressed={reaction}
                  >
                    <Icon name="thumb" size={15} /> {reaction ? t('已点赞') : t('点赞')}
                  </button>
                  <button
                    type="button"
                    className={`reaction-btn${bookmarked ? ' is-on' : ''}`}
                    onClick={toggleBookmark}
                    aria-pressed={bookmarked}
                  >
                    <Icon name="bookmark" size={15} /> {bookmarked ? t('已收藏') : t('收藏')}
                  </button>
                </>
              ) : null}
              {extensions.share ? (
                <button type="button" className="reaction-btn" onClick={shareNative}>
                  <Icon name="arrow-up-right" size={15} /> {t('分享')}
                </button>
              ) : null}
              <button type="button" className="reaction-btn" onClick={share}>
                <Icon name="copy" size={15} /> {t('复制链接')}
              </button>
            </div>
            <span className="tiny faint">
              {item.updated_at ? t('最后更新 {date}', { date: formatDate(item.updated_at) }) : ''}
            </span>
          </div>

          {item.author_id ? (
            <div className="author-card">
              <Avatar name={authorLabel} size={44} />
              <div className="author-main">
                <strong>{authorLabel}</strong>
                <p>{t('写作者 · 已发布内容归作者所有')}</p>
              </div>
              {me && me.user.id !== item.author_id ? (
                <Button
                  variant={following ? 'secondary' : 'primary'}
                  size="sm"
                  icon={following ? 'check' : 'plus'}
                  onClick={toggleFollow}
                >
                  {following ? t('已关注') : t('关注作者')}
                </Button>
              ) : (
                <Link to={`/u/${item.author_id}`} className="btn btn-secondary btn-sm">
                  {t('作者主页')}
                </Link>
              )}
            </div>
          ) : null}

          <nav className="article-pager" aria-label={t('上一篇与下一篇')}>
            {neighbors.previous ? (
              <Link className="article-pager-item is-prev" to={contentPath(neighbors.previous)}>
                <span>
                  <Icon name="arrow-left" size={12} /> {t('上一篇')}
                </span>
                <strong title={neighbors.previous.title}>{clipTitle(neighbors.previous.title)}</strong>
              </Link>
            ) : (
              <span className="article-pager-item is-prev is-disabled" aria-disabled="true">
                <span>
                  <Icon name="arrow-left" size={12} /> {t('上一篇')}
                </span>
                <strong>{t('已经是第一篇')}</strong>
              </span>
            )}
            {neighbors.next ? (
              <Link className="article-pager-item is-next" to={contentPath(neighbors.next)}>
                <span>
                  {t('下一篇')} <Icon name="arrow-right" size={12} />
                </span>
                <strong title={neighbors.next.title}>{clipTitle(neighbors.next.title)}</strong>
              </Link>
            ) : (
              <span className="article-pager-item is-next is-disabled" aria-disabled="true">
                <span>
                  {t('下一篇')} <Icon name="arrow-right" size={12} />
                </span>
                <strong>{t('已经是最新一篇')}</strong>
              </span>
            )}
          </nav>

          <section className="comments" id="comments">
            <div className="comments-head">
              <h2>{t('讨论')}</h2>
              <span>
                {!commentsEnabled
                  ? t('评论已关闭')
                  : comments.loading
                    ? t('正在载入')
                    : comments.data?.supported
                      ? t('{count} 条评论', { count: visibleComments })
                      : t('暂时无法读取评论')}
              </span>
            </div>

            {!commentsEnabled ? (
              <Callout tone="info" icon="message">
                {contentCommentPolicy === 'disabled'
                  ? t('这篇内容已关闭评论。')
                  : t('本站已经关闭评论。站长可以在「后台 → 评论与审核 → 评论设置」里重新开启。')}
              </Callout>
            ) : (
              <>
                {comments.data?.supported === false ? (
                  <Callout tone="warn" icon="alert" title={t('评论可以写入，但暂时读不回来')}>
                    {t(
                      '当前后端还没有提供评论列表接口。评论已经保存，接口补齐后就会显示出来； 演示模式下评论是完整的。',
                    )}
                  </Callout>
                ) : null}

                {comments.data?.supported ? (
                  me ? (
                    can('comment') ? (
                      <div className="comment-form">
                        <div className="row gap-8">
                          <Avatar name={me.user.display_name} size={28} />
                          <span className="small muted">
                            {t('以')}{' '}
                            <strong style={{ color: 'var(--ink)' }}>{me.user.display_name}</strong>{' '}
                            {t('的身份评论')}
                          </span>
                        </div>
                        {commentSettings.notice ? (
                          <p className="comment-notice">{commentSettings.notice}</p>
                        ) : null}
                        {commentsRequireReview ? (
                          <p className="field-hint">{t('本站开启先审后发：评论通过审核后才会公开显示。')}</p>
                        ) : null}
                        <Textarea
                          value={body}
                          onChange={(e) => setBody(e.target.value)}
                          placeholder={t('写下你的回应。请遵守站点的讨论规则。')}
                          maxLength={5000}
                        />
                        {replyTo ? null : (
                          <CaptchaField
                            scene="comment"
                            status={captcha.status}
                            onToken={setCaptchaToken}
                            resetKey={captchaNonce}
                            onFailure={setCaptchaFailure}
                          />
                        )}
                        <div className="comment-form-foot">
                          <span>{body.length}/5000</span>
                          <Button
                            size="sm"
                            loading={busy}
                            onClick={() => void submitComment(body)}
                            disabled={!body.trim() || captchaBlocked}
                          >
                            {t('发表评论')}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="comment-form">
                        <p className="small muted">
                          {t('当前账户没有发表评论的权限。站长可以在「用户组」里开启。')}
                        </p>
                      </div>
                    )
                  ) : (
                    <div className="comment-form">
                      <p className="small muted">{t('登录后可以参与讨论、回复其他读者。')}</p>
                      <div>
                        <Link to={`/login?next=${encodeURIComponent(url)}`} className="btn btn-primary btn-sm">
                          {t('登录后评论')}
                        </Link>
                      </div>
                    </div>
                  )
                ) : null}

                {comments.loading ? (
                  <div className="mt-16">
                    <Skeleton lines={4} />
                  </div>
                ) : tree.length === 0 ? (
                  <p className="comment-empty">
                    {comments.data?.supported === false
                      ? t('评论列表不可用。')
                      : me && can('comment')
                        ? t('还没有人说话。你可以第一个。')
                        : t('还没有评论。')}
                  </p>
                ) : (
                  <div className="comment-list">
                    {tree.map((node) => (
                      <CommentItem
                        key={node.id}
                        node={node}
                        depth={0}
                        meId={me?.user.id}
                        moderator={can('moderate_comment')}
                        replyTo={replyTo}
                        onReply={setReplyTo}
                        onCancelReply={() => setReplyTo(null)}
                        onSubmitReply={(text) => submitComment(text, node.id)}
                        onEdit={editComment}
                        onDelete={setDeleting}
                        busy={busy}
                        captchaSlot={
                          <CaptchaField
                            scene="comment"
                            status={captcha.status}
                            onToken={setCaptchaToken}
                            resetKey={captchaNonce}
                            onFailure={setCaptchaFailure}
                          />
                        }
                        captchaBlocked={captchaBlocked}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        </article>
        </div>

        {!layoutOwnsBody && screenHasBlocks(articleLayout) ? (
          <section className="article-extra-blocks">
            <FeedProvider>
              <ScreenRenderer layout={articleLayout} variant={customization.layout.variant} />
            </FeedProvider>
          </section>
        ) : null}

        {relatedItems.length ? (
          <section className="article-related">
            <div className="section-head">
              <h2 style={{ fontSize: 22 }}>{t('继续阅读')}</h2>
              <Link to={kind === 'article' ? '/articles' : '/posts'} className="rule-link">
                {t('全部{kind}', { kind: KIND_LABEL[kind] })}
              </Link>
            </div>
            {relatedItems.map((entry) => (
              <article className="story" key={entry.id}>
                <span className="story-index">·</span>
                <div className="story-body">
                  <h3>
                    <Link to={contentPath(entry)}>{entry.title}</Link>
                  </h3>
                  <div className="story-meta">
                    <span>{entry.author_name ?? t('编辑部')}</span>
                    <span>{formatDate(entry.published_at ?? entry.created_at)}</span>
                    {(entry.tags ?? []).slice(0, 3).map((tag) => (
                      <span key={tag}>#{tag}</span>
                    ))}
                  </div>
                </div>
              </article>
            ))}
          </section>
        ) : null}

        <Modal
          open={!!deleting}
          title={t('删除这条评论？')}
          description={t('评论会被标记为已删除，回复仍然保留。这个操作无法在界面上撤销。')}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(null)}>
                {t('取消')}
              </Button>
              <Button variant="danger" loading={busy} onClick={confirmDelete}>
                {t('删除评论')}
              </Button>
            </>
          }
        >
          <p className="small muted" style={{ lineHeight: 1.8 }}>
            “{deleting?.body.slice(0, 140)}”
          </p>
        </Modal>

        <Modal
          open={reporting}
          title={t('举报这篇内容')}
          description={t('举报会进入站长与审核员的后台队列。恶意举报会被记录。')}
          onClose={() => setReporting(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setReporting(false)}>
                {t('取消')}
              </Button>
              <Button variant="danger" loading={reportBusy} onClick={() => void submitReport()}>
                {t('提交举报')}
              </Button>
            </>
          }
        >
          <div className="form-stack">
            <Field label={t('举报原因')} htmlFor="report-reason">
              <Select
                id="report-reason"
                value={reportReason}
                onChange={(event) => setReportReason(event.target.value as ReportReason)}
              >
                <option value="spam">{t('垃圾广告')}</option>
                <option value="abuse">{t('辱骂与骚扰')}</option>
                <option value="illegal">{t('违法或侵权内容')}</option>
                <option value="other">{t('其他')}</option>
              </Select>
            </Field>
            <Field
              label={t('补充说明')}
              htmlFor="report-note"
              aside={`${reportNote.length}/2000`}
              hint={t('可选：告诉审核员问题出在哪里。')}
            >
              <Textarea
                id="report-note"
                value={reportNote}
                maxLength={2000}
                style={{ minHeight: 84 }}
                onChange={(event) => setReportNote(event.target.value)}
              />
            </Field>
          </div>
        </Modal>
        </div>
      </div>
    </>
  );
}
