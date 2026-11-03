import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Comment, ContentKind, ToggleResult } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend, isDemo } from '../../lib/backend';
import { useAsync, useScrollProgress } from '../../lib/hooks';
import { ApiError } from '../../lib/api';
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
  Modal,
  Skeleton,
  StatusBadge,
  Textarea,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { ContentCover } from '../../components/Cover';
import { FeedProvider } from '../../components/blocks/FeedContext';
import { ArticleProvider } from '../../components/blocks/ArticleContext';
import { ScreenRenderer } from '../../components/blocks';
import { hasArticleContent, screenHasBlocks } from '../../lib/blocks';
import { useCustomization } from '../../lib/customize';
import { useCoverHidden } from '../../lib/covers';
import { useTaxonomy } from '../../lib/useTaxonomy';
import { usePermissions } from '../../lib/usePermissions';
import { copyText } from '../../lib/clipboard';
import { ArticleToc, useArticleDiagrams, useArticleToc, useCodeCopy } from '../../components/ArticleTools';
import { useToast } from '../../lib/toast';
import { useSeo, articleJsonLd, breadcrumbJsonLd } from '../../lib/seo';
import { firstImage } from '../../lib/markdown';
import { useT } from '../../lib/i18n';

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
          <div className="row gap-8 mt-8">
            <Button
              size="sm"
              loading={busy}
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
  // 文章页附加区块：在正文与评论区之间渲染，由「页面编排 → 文章页」维护。
  const articleLayout = customization.article ?? { blocks: [] };
  // 编排里放了「文章内容」占位符时，整份编排挪到正文的位置，由占位符渲染正文；
  // 否则保持旧行为：正文照旧，编排区块排在评论区之后。
  const layoutOwnsBody = hasArticleContent(articleLayout);
  const { taxonomy } = useTaxonomy();
  const { can } = usePermissions();
  const commentSettings = customization.comments;
  const extensions = customization.extensions;
  const backend = useBackend();
  const demo = isDemo(backend);
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

  const content = useAsync(() => backend.getContent(kind, id), [backend, kind, id]);
  const item = content.data;
  // 作者明确隐藏封面时，整块 .article-cover 不渲染，避免留下空画框。
  const coverHidden = useCoverHidden(item?.id);
  // 详情页的 SEO 在数据到位后写入；分享图优先取正文第一张图。
  useSeo({
    title: item?.title,
    description: item?.summary,
    path: `/${kind === 'article' ? 'a' : 'p'}/${id}`,
    type: 'article',
    image: item ? firstImage(item.rendered_html) : undefined,
    publishedAt: item?.published_at,
    modifiedAt: item?.updated_at,
    author: item?.author_name,
    keywords: item?.kind === 'article' ? [t('文章')] : [t('帖子')],
    jsonLd: item
      ? [
          articleJsonLd({
            content: item,
            url: `${window.location.origin}/${kind === 'article' ? 'a' : 'p'}/${item.id}`,
            siteName: site?.name ?? 'Practacu Press',
            publisher: customization.seo.publisher || site?.name || 'Practacu Press',
            image: firstImage(item.rendered_html),
            author: item.author_name,
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

  const comments = useAsync(() => backend.comments(kind, id), [backend, kind, id]);
  const related = useAsync(async () => {
    const page = await backend.listContent(kind, { limit: 4 });
    return page.items.filter((entry) => entry.id !== id && entry.status === 'published').slice(0, 3);
  }, [backend, kind, id]);

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
  }, [backend, kind, id, item]);

  const tree = useMemo(() => buildTree(comments.data?.items ?? []), [comments.data]);
  const visibleComments = (comments.data?.items ?? []).filter((c) => c.status !== 'deleted').length;

  const requireLogin = () => {
    navigate(`/login?next=${encodeURIComponent(`/${kind === 'article' ? 'a' : 'p'}/${id}`)}`);
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
      await backend.createComment(
        {
          target_type: parentId ? 'comment' : kind,
          target_id: parentId ?? id,
          parent_id: parentId,
          body: text,
        },
        { require_review: commentSettings.require_review },
      );
      setBody('');
      setReplyTo(null);
      comments.reload();
      if (commentSettings.require_review && demo) {
        toast.push(
          'ok',
          parentId ? t('回复已提交') : t('评论已提交'),
          t('通过审核后才会公开显示。'),
        );
      } else {
        toast.push('ok', parentId ? t('回复已发送') : t('评论已发布'));
      }
    } catch (err) {
      toast.push('error', t('发送失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
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

  if (content.error || !item) {
    const notFound = content.error instanceof ApiError && content.error.code === 'not_found';
    return (
      <div className="shell">
        <div style={{ paddingTop: 64 }}>
          <EmptyState
            icon={notFound ? 'file' : 'lock'}
            title={notFound ? t('这篇内容不存在') : t('暂时无法打开')}
            body={
              content.error instanceof ApiError
                ? content.error.message
                : content.error instanceof Error
                  ? content.error.message
                  : t('请稍后重试。')
            }
            action={
              <Link to={kind === 'article' ? '/articles' : '/posts'} className="btn btn-secondary btn-sm">
                {t('返回列表')}
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const url = `/${kind === 'article' ? 'a' : 'p'}/${item.id}`;
  const isUnpublished = item.status !== 'published';
  // 分类名同时用于文章头的分类标记与「显示什么数据」里的「分类」。
  const articleCategory = item.category_id
    ? taxonomy.categories.find((term) => term.id === item.category_id)
    : undefined;

  return (
    <>
      {extensions.reading_progress && progress > 0.01 ? (
        <div className="read-progress" style={{ width: `${progress * 100}%` }} />
      ) : null}
      <div className="shell">
        <article className="article">
          <div className="article-head">
            <Link to={kind === 'article' ? '/articles' : '/posts'} className="back-link">
              <Icon name="arrow-left" size={13} /> {t('返回{kind}列表', { kind: KIND_LABEL[kind] })}
            </Link>
            <div className="article-kicker">
              <span>{KIND_LABEL[kind]}</span>
              <span className="dot" />
              <span>{t('安全策略 · {version}', { version: item.policy_version })}</span>
              {isUnpublished ? <StatusBadge status={item.status} /> : null}
            </div>
            <h1>{item.title}</h1>
            {item.summary ? <p className="article-lede">{item.summary}</p> : null}
            <div className="article-meta">
              <span className="author-line">
                <Avatar name={item.author_name ?? t('编辑部')} size={32} />
                <span>
                  <span className="author-name">{item.author_name ?? t('编辑部')}</span>
                  <span className="meta-text" style={{ display: 'block' }}>
                    {formatDateTime(item.published_at ?? item.created_at)}
                  </span>
                </span>
              </span>
              <span className="dot" />
              <span className="meta-text">
                {t('{count} 分钟阅读', { count: readingTime(item.rendered_html) })}
              </span>
              <div className="article-meta-actions">
                <button type="button" className="icon-btn" onClick={share} aria-label={t('复制链接')}>
                  <Icon name="copy" size={16} />
                </button>
                {me && can('moderate_content') ? (
                  <Link to={`/admin/content/${item.kind}/${item.id}`} className="icon-btn" aria-label={t('在后台编辑')}>
                    <Icon name="edit" size={16} />
                  </Link>
                ) : null}
              </div>
            </div>
            {item.category_id || item.tags?.length ? (
              <div className="article-taxonomy">
                {articleCategory ? (
                  <span className="article-cat" style={{ '--pp-cat-color': articleCategory.color } as CSSProperties}>
                    {articleCategory.name}
                  </span>
                ) : null}
                {(item.tags ?? []).map((tag) => (
                  <span key={tag} className="article-tag">
                    #{tag}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          {coverHidden ? null : (
            <div className="article-cover">
              <ContentCover id={item.id} label={item.title} ratio="21 / 9" />
            </div>
          )}

          {extensions.toc ? <ArticleToc items={toc} /> : null}

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
            <div
              className="article-body"
              // 契约规定：只渲染服务端清洗后产生的 rendered_html。
              dangerouslySetInnerHTML={{ __html: item.rendered_html }}
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
              <Avatar name={item.author_name} size={44} />
              <div className="author-main">
                <strong>{item.author_name ?? t('作者')}</strong>
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

          <section className="comments">
            <div className="comments-head">
              <h2>{t('讨论')}</h2>
              <span>
                {!commentSettings.enabled
                  ? t('评论已关闭')
                  : comments.loading
                    ? t('正在载入')
                    : comments.data?.supported
                      ? t('{count} 条评论', { count: visibleComments })
                      : t('暂时无法读取评论')}
              </span>
            </div>

            {!commentSettings.enabled ? (
              <Callout tone="info" icon="message">
                {t('本站已经关闭评论。站长可以在「后台 → 评论与审核 → 评论设置」里重新开启。')}
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
                        {commentSettings.require_review ? (
                          <p className="field-hint">
                            {demo
                              ? t('本站开启先审后发：评论通过审核后才会公开显示。')
                              : t('先审后发目前只在演示模式生效；真实后端需要接入站点级评论策略。')}
                          </p>
                        ) : null}
                        <Textarea
                          value={body}
                          onChange={(e) => setBody(e.target.value)}
                          placeholder={t('写下你的回应。请遵守站点的讨论规则。')}
                          maxLength={5000}
                        />
                        <div className="comment-form-foot">
                          <span>{body.length}/5000</span>
                          <Button size="sm" loading={busy} onClick={() => void submitComment(body)} disabled={!body.trim()}>
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
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        </article>

        {!layoutOwnsBody && screenHasBlocks(articleLayout) ? (
          <section className="article-extra-blocks">
            <FeedProvider>
              <ScreenRenderer layout={articleLayout} variant={customization.layout.variant} />
            </FeedProvider>
          </section>
        ) : null}

        {related.data?.length ? (
          <section style={{ maxWidth: 720, margin: '56px auto 0' }}>
            <div className="section-head">
              <h2 style={{ fontSize: 22 }}>{t('继续阅读')}</h2>
              <Link to={kind === 'article' ? '/articles' : '/posts'} className="rule-link">
                {t('全部{kind}', { kind: KIND_LABEL[kind] })}
              </Link>
            </div>
            {related.data.map((entry) => (
              <article className="story" key={entry.id}>
                <span className="story-index">·</span>
                <div className="story-body">
                  <h3>
                    <Link to={`/${entry.kind === 'article' ? 'a' : 'p'}/${entry.id}`}>{entry.title}</Link>
                  </h3>
                  <div className="story-meta">
                    <span>{entry.author_name ?? t('编辑部')}</span>
                    <span>{formatDate(entry.published_at ?? entry.created_at)}</span>
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
      </div>
    </>
  );
}
