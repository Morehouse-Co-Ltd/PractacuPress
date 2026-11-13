import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Conversation, Message, PublicProfile } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { REALTIME_POLL, useRealtime } from '../../lib/realtime';
import { formatDateTime, relativeTime, shortId } from '../../lib/format';
import { useT } from '../../lib/i18n';
import {
  Avatar,
  Button,
  EmptyState,
  Modal,
  PageLoading,
  Textarea,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useToast } from '../../lib/toast';

export function MessagesPage() {
  const t = useT();
  const { id } = useParams();
  const { me } = useAuth();
  const backend = useBackend();
  const navigate = useNavigate();
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [members, setMembers] = useState<PublicProfile[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastReadRef = useRef('');
  useTitle(t('私信'));

  const conversations = useAsync(() => backend.conversations(), [backend]);
  const activeId = id ?? conversations.data?.[0]?.id ?? '';
  const active: Conversation | undefined = conversations.data?.find((c) => c.id === activeId);

  const messages = useAsync<Message[]>(async () => {
    if (!activeId) return [];
    return backend.messages(activeId);
  }, [backend, activeId]);
  const reloadConversations = conversations.reload;
  const reloadMessages = messages.reload;
  const realtime = useRealtime();

  /**
   * 实时推送 / 轮询兜底都只触发「重新读一次服务端」，不把推送内容直接塞进列表：
   * 推送里的 `message.created` 只有 id 没有正文，重读还顺带拿到排序与未读游标，
   * 也避免同一条消息被推送和补偿各插一次。
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let needList = false;
    let needThread = false;
    const flush = () => {
      timer = null;
      if (needList) {
        needList = false;
        reloadConversations();
      }
      if (needThread) {
        needThread = false;
        reloadMessages();
      }
    };
    const unsubscribe = realtime.subscribe((event) => {
      const isPoll = event.type === REALTIME_POLL;
      if (!isPoll && event.type !== 'message.created') return;
      needList = true;
      const conversationId =
        typeof event.payload.conversation_id === 'string' ? event.payload.conversation_id : '';
      if (isPoll || (activeId && conversationId === activeId)) needThread = true;
      // 补偿可能一次补很多事件，合并成一次刷新，避免连续请求。
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, 200);
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [realtime, activeId, reloadConversations, reloadMessages]);

  /**
   * 成员目录只在打开“新会话”时拉取：日常读写已有会话不需要这次请求，而目录
   * 端点要求登录，未登录用户也看不到这个弹窗。
   */
  useEffect(() => {
    if (!picker) return;
    let alive = true;
    backend
      .memberDirectory({ limit: 100 })
      .then((users) => {
        if (alive) setMembers(users.filter((user) => user.user_id !== me?.user.id));
      })
      .catch((err) => {
        if (alive) toast.push('error', t('无法加载成员'), err instanceof Error ? err.message : undefined);
      });
    return () => {
      alive = false;
    };
    // t / toast 只是提示文案与容器；目录请求只随弹窗与身份变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, picker, me?.user.id]);

  useEffect(() => {
    const list = messages.data;
    if (!activeId || !list?.length) return;
    const last = list[list.length - 1];
    if (lastReadRef.current === last.id) return;
    lastReadRef.current = last.id;
    backend
      .markConversationRead(activeId, last.id)
      .then(() => conversations.reload())
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, messages.data]);

  const lastThreadRef = useRef('');
  const lastCountRef = useRef(0);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const count = messages.data?.length ?? 0;
    const threadChanged = lastThreadRef.current !== activeId;
    const firstLoad = lastCountRef.current === 0 && count > 0;
    const grew = count > lastCountRef.current;
    lastThreadRef.current = activeId;
    lastCountRef.current = count;
    // 轮询 / 推送刷新时只有本来就在底部才跟随，别把正在翻历史的人拽回底部。
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    const last = messages.data?.[count - 1];
    const own = last?.sender_id === me?.user.id;
    if (threadChanged || firstLoad || (grew && (distance < 160 || own))) {
      node.scrollTop = node.scrollHeight;
    }
  }, [activeId, messages.data, me?.user.id]);

  const send = async () => {
    if (!draft.trim() || !activeId) return;
    setBusy(true);
    try {
      const message = await backend.sendMessage(activeId, draft.trim());
      setDraft('');
      messages.setData((prev) => [...(prev ?? []), message]);
      conversations.reload();
    } catch (err) {
      toast.push('error', t('发送失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const createConversation = async () => {
    if (!selectedMembers.length) return;
    setBusy(true);
    try {
      const conv = await backend.createConversation(selectedMembers);
      setPicker(false);
      setSelectedMembers([]);
      conversations.reload();
      navigate(`/messages/${conv.id}`);
    } catch (err) {
      toast.push('error', t('创建失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  if (conversations.loading) {
    return (
      <div className="shell">
        <PageLoading label={t('正在载入会话')} />
      </div>
    );
  }

  return (
    <div className={`messages${activeId ? ' has-thread' : ''}`}>
      <aside className="conv-pane">
        <div className="conv-head">
          <h1>{t('私信')}</h1>
          <Button
            variant="ghost"
            size="sm"
            icon="plus"
            onClick={() => setPicker(true)}
            aria-label={t('发起会话')}
          >
            {t('新会话')}
          </Button>
        </div>
        <div className="conv-list">
          {(conversations.data ?? []).map((conv) => (
            <button
              key={conv.id}
              type="button"
              className={`conv-item${conv.id === activeId ? ' is-active' : ''}`}
              onClick={() => navigate(`/messages/${conv.id}`)}
            >
              <Avatar name={conv.title ?? t('会话')} size={34} />
              <span className="conv-main">
                <span className="conv-title">
                  <strong>{conv.title ?? conv.members.map(shortId).join('、')}</strong>
                  <time>{relativeTime(conv.updated_at)}</time>
                </span>
                <span className="conv-preview">{conv.last_message || t('还没有消息')}</span>
                {conv.unread ? <span className="conv-unread">{conv.unread}</span> : null}
              </span>
            </button>
          ))}
          {!conversations.data?.length ? (
            <div style={{ padding: 24 }}>
              <EmptyState
                compact
                icon="mail"
                title={t('还没有会话')}
                body={t('选择和一位成员开始对话。')}
                action={
                  <Button variant="secondary" size="sm" onClick={() => setPicker(true)}>
                    {t('发起会话')}
                  </Button>
                }
              />
            </div>
          ) : null}
        </div>
      </aside>

      <section className="thread-pane">
        {active ? (
          <>
            <div className="thread-head">
              <button
                type="button"
                className="icon-btn conversation-back"
                onClick={() => navigate('/messages')}
                aria-label={t('返回会话列表')}
                style={{ display: 'none' }}
              >
                <Icon name="chevron-left" size={17} />
              </button>
              <Avatar name={active.title ?? t('会')} size={32} />
              <div>
                <h2>{active.title ?? active.members.map(shortId).join('、')}</h2>
                <p>
                  {active.kind === 'group'
                    ? t('群聊 · {count} 人', { count: active.members.length })
                    : t('私信')}
                </p>
              </div>
            </div>

            <div className="thread-scroll" ref={scrollRef}>
              {messages.loading ? (
                <PageLoading label={t('正在载入消息')} />
              ) : messages.data?.length ? (
                messages.data.map((message) => {
                  const own = message.sender_id === me?.user.id;
                  return (
                    <div key={message.id} className={`msg-row${own ? ' is-own' : ''}`}>
                      <Avatar name={message.sender_name ?? (own ? me?.user.display_name : shortId(message.sender_id))} size={26} />
                      <div>
                        <div className="msg-bubble">{message.body}</div>
                        <div className="msg-meta">{formatDateTime(message.created_at)}</div>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="thread-empty">
                  <div>
                    <Icon name="mail" size={22} />
                    <p className="mt-12">{t('还没有消息。说点什么吧。')}</p>
                  </div>
                </div>
              )}
            </div>

            <div className="thread-composer">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t('输入消息，Enter 发送，Shift + Enter 换行')}
                maxLength={5000}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <Button icon="send" loading={busy} onClick={send} disabled={!draft.trim()}>
                {t('发送')}
              </Button>
            </div>
          </>
        ) : (
          <div className="thread-empty">
            <div>
              <Icon name="mail" size={26} />
              <p className="mt-12">{t('选择一个会话，或者开始一段新的对话。')}</p>
            </div>
          </div>
        )}
      </section>

      <Modal
        open={picker}
        title={t('发起新会话')}
        description={t('选择一位成员就是私信；选择多位会创建群聊。')}
        onClose={() => setPicker(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPicker(false)}>
              {t('取消')}
            </Button>
            <Button loading={busy} onClick={createConversation} disabled={!selectedMembers.length}>
              {t('创建会话')}
            </Button>
          </>
        }
      >
        <div className="check-list">
          {members.map((user) => (
            <label key={user.user_id} className="checkline" style={{ padding: '8px 0' }}>
              <input
                type="checkbox"
                checked={selectedMembers.includes(user.user_id)}
                onChange={(e) =>
                  setSelectedMembers((prev) =>
                    e.target.checked
                      ? [...prev, user.user_id]
                      : prev.filter((id) => id !== user.user_id),
                  )
                }
              />
              <span className="row gap-8">
                <Avatar name={user.display_name} size={24} />
                {user.display_name}
              </span>
            </label>
          ))}
        </div>
        {!members.length ? <p className="tiny faint">{t('当前站点没有其他可选成员。')}</p> : null}
        <p className="field-hint mt-12">
          {t('创建后你一定是成员；私信要求恰好一位其他成员。未读游标由服务端保存。')}
        </p>
      </Modal>
    </div>
  );
}
