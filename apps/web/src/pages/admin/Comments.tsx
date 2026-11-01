import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Comment, CommentModerationAction, CommentStatus } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend, isDemo } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { useCustomization } from '../../lib/customize';
import { noteActivity } from '../../lib/activity';
import { formatDateTime, KIND_LABEL, shortId } from '../../lib/format';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Field,
  Input,
  Modal,
  PageLoading,
  Tabs,
  Textarea,
  Toggle,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';
import { useToast } from '../../lib/toast';

type TabKey = 'all' | CommentStatus;

const STATUS_LABEL: Record<CommentStatus, string> = {
  visible: '已发布',
  pending_review: '待审核',
  hidden: '已隐藏',
  deleted: '已删除',
};

const STATUS_TONE: Record<CommentStatus, 'ok' | 'warn' | 'muted' | 'danger'> = {
  visible: 'ok',
  pending_review: 'warn',
  hidden: 'muted',
  deleted: 'danger',
};

export function CommentsPage() {
  const { me } = useAuth();
  const backend = useBackend();
  const demo = isDemo(backend);
  const toast = useToast();
  const { customization, update } = useCustomization();
  const comments = customization.comments;
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
  useTitle('评论与审核');

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
        setError(err instanceof Error ? err.message : '评论加载失败。');
        if (!append) setItems([]);
      } finally {
        if (current === seq.current) {
          setLoading(false);
          setMore(false);
        }
      }
    },
    [backend, tab, appliedTerm],
  );

  useEffect(() => {
    void load('');
  }, [load]);

  const targetOf = (comment: Comment) => {
    if (comment.target_type === 'comment') return { label: '回复评论', to: '' };
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
          action === 'approve' ? '通过评论' : action === 'hide' ? '隐藏评论' : '删除评论',
          comment.body.slice(0, 24),
          comment.author_name,
        );
      }
      toast.push('ok', action === 'approve' ? '评论已通过' : action === 'hide' ? '评论已隐藏' : '评论已删除');
      setDeleting(null);
      await load('');
    } catch (err) {
      toast.push('error', '操作失败', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyId('');
    }
  };

  const tabs: { key: TabKey; label: string; count?: number }[] = useMemo(
    () => [
      { key: 'all', label: '全部', count: counts.all },
      { key: 'pending_review', label: '待审核', count: counts.pending_review },
      { key: 'visible', label: '已发布', count: counts.visible },
      { key: 'hidden', label: '已隐藏', count: counts.hidden },
      { key: 'deleted', label: '已删除', count: counts.deleted },
    ],
    [counts],
  );

  const saveComments = (patch: Partial<typeof comments>) => {
    update({ comments: { ...comments, ...patch } });
  };

  return (
    <RoleGate capability="moderate_comment" need="审核员">
      <div className="admin-page-head">
        <div>
          <h1>评论与审核</h1>
          <p>处理待审评论、隐藏不合适的发言，并决定本站的评论策略。</p>
        </div>
        <div className="admin-page-actions">
          <Button variant="ghost" size="sm" icon="refresh" onClick={() => void load('')}>
            刷新
          </Button>
        </div>
      </div>

      <div className="settings-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>评论设置</h3>
              <p>立即生效，保存在本地安装配置；真实后端上线后应改为服务端站点策略。</p>
            </div>
            <Badge tone={comments.enabled ? 'ok' : 'muted'}>{comments.enabled ? '已开启' : '已关闭'}</Badge>
          </div>
          <div className="panel-body">
            <div className="form-stack">
              <Toggle
                checked={comments.enabled}
                onChange={(next) => saveComments({ enabled: next })}
                label="允许评论"
                description="关闭后文章与帖子底部不再显示评论框，已有评论仍然保留。"
              />
              <Toggle
                checked={comments.require_review}
                onChange={(next) => saveComments({ require_review: next })}
                label="先审后发"
                description="新评论进入待审核队列，通过后才会公开显示。"
              />
              <Field
                label="评论须知"
                htmlFor="comment-notice"
                aside={`${comments.notice.length}/400`}
                hint="显示在评论框上方，留空则不显示。"
              >
                <Textarea
                  id="comment-notice"
                  value={comments.notice}
                  maxLength={400}
                  style={{ minHeight: 72 }}
                  placeholder="例如：请就事论事，尊重其他读者；广告与人身攻击会被删除。"
                  onChange={(event) => saveComments({ notice: event.target.value })}
                />
              </Field>
              {!demo ? (
                <Callout tone="warn" icon="alert" title="先审后发需要服务端策略">
                  当前连接真实后端：新评论默认直接发布，这个开关只影响演示数据。
                  服务端接入站点级评论审核策略后才会真正拦下评论。
                </Callout>
              ) : null}
            </div>
          </div>
        </section>

        <aside className="settings-side">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>审核规则</h3>
                <p>评论状态与内容状态是两条独立的流水线。</p>
              </div>
            </div>
            <div className="panel-body" style={{ paddingTop: 4 }}>
              <div className="mini-list">
                <div className="mini-row">
                  <span className="mini-label">已发布</span>
                  <span className="mini-value">所有人可见</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">待审核</span>
                  <span className="mini-value">作者与审核员可见</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">已隐藏</span>
                  <span className="mini-value">仅审核员可见</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">已删除</span>
                  <span className="mini-value">保留占位，回复仍在</span>
                </div>
              </div>
              <p className="tiny faint mt-12" style={{ lineHeight: 1.75 }}>
                审核员与管理员可以隐藏任何评论；作者可以删除自己的评论。删除是软删除，不会抹掉上下文。
              </p>
            </div>
          </section>
        </aside>
      </div>

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
            placeholder="搜索作者或评论内容，回车确认"
            aria-label="搜索评论"
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
            清除
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
        <PageLoading label="正在载入评论" />
      ) : items.length === 0 ? (
        <div className="mt-20">
          <EmptyState
            icon="message"
            title={appliedTerm ? '没有匹配的评论' : '这个分组里还没有评论'}
            body={
              appliedTerm
                ? '换一个关键词，或清除搜索条件。'
                : comments.enabled
                  ? '读者在文章下方留言后，评论会出现在这里。'
                  : '评论当前处于关闭状态，已有评论不会丢失。'
            }
          />
        </div>
      ) : (
        <div className="panel mt-20">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>评论</th>
                  <th>作者</th>
                  <th>所在内容</th>
                  <th>状态</th>
                  <th>时间</th>
                  <th style={{ width: 190 }}>操作</th>
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
                          <span className="tiny faint">回复 · {shortId(comment.parent_id)}</span>
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
                            ? '评论'
                            : KIND_LABEL[comment.target_type === 'post' ? 'post' : 'article']}
                        </div>
                      </td>
                      <td>
                        <Badge tone={STATUS_TONE[comment.status]} dot>
                          {STATUS_LABEL[comment.status]}
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
                              通过
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
                              隐藏
                            </Button>
                          ) : null}
                          {comment.status !== 'deleted' ? (
                            <Button
                              variant="quiet"
                              size="sm"
                              icon="trash"
                              onClick={() => setDeleting(comment)}
                            >
                              删除
                            </Button>
                          ) : (
                            <Button
                              variant="quiet"
                              size="sm"
                              icon="refresh"
                              loading={busyId === comment.id}
                              onClick={() => void moderate(comment, 'approve')}
                            >
                              恢复
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
            加载更多
          </Button>
        </div>
      ) : null}

      <p className="tiny faint mt-16" style={{ lineHeight: 1.8 }}>
        演示模式的评论保存在浏览器；连接真实后端时，评论列表与审核动作走
        <code className="mono"> GET /comments </code>与
        <code className="mono"> PATCH /comments/{'{id}'} </code>。
      </p>

      <Modal
        open={!!deleting}
        title="删除这条评论？"
        description="评论会被标记为已删除，作者与审核员仍能看到占位，回复保持完整。"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              loading={!!deleting && busyId === deleting.id}
              onClick={() => deleting && void moderate(deleting, 'delete')}
            >
              删除评论
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
