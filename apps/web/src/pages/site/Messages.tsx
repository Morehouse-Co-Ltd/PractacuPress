import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';import type { Conversation, Message } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend, isDemo } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { formatDateTime, relativeTime, shortId } from '../../lib/format';
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
  const { id } = useParams();
  const { me } = useAuth();
  const backend = useBackend();
  const demo = isDemo(backend) ? backend : null;
  const navigate = useNavigate();
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [demoMembers, setDemoMembers] = useState<{ id: string; display_name: string }[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastReadRef = useRef('');
  useTitle('私信');

  const conversations = useAsync(() => backend.conversations(), [backend]);
  const activeId = id ?? conversations.data?.[0]?.id ?? '';
  const active: Conversation | undefined = conversations.data?.find((c) => c.id === activeId);

  const messages = useAsync<Message[]>(async () => {
    if (!activeId) return [];
    return backend.messages(activeId);
  }, [backend, activeId]);

  useEffect(() => {
    if (!demo) return;
    demo.demoMembers().then((users) => setDemoMembers(users.filter((u) => u.id !== me?.user.id)));
  }, [demo, me]);

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

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.data]);

  const send = async () => {
    if (!draft.trim() || !activeId) return;
    setBusy(true);
    try {
      const message = await backend.sendMessage(activeId, draft.trim());
      setDraft('');
      messages.setData((prev) => [...(prev ?? []), message]);
      conversations.reload();
    } catch (err) {
      toast.push('error', '发送失败', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const createConversation = async () => {
    if (!demo || !selectedMembers.length) return;
    setBusy(true);
    try {
      const conv = await demo.createConversation(selectedMembers);
      setPicker(false);
      setSelectedMembers([]);
      conversations.reload();
      navigate(`/messages/${conv.id}`);
    } catch (err) {
      toast.push('error', '创建失败', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  if (conversations.loading) {
    return (
      <div className="shell">
        <PageLoading label="正在载入会话" />
      </div>
    );
  }

  return (
    <div className={`messages${activeId ? ' has-thread' : ''}`}>
      <aside className="conv-pane">
        <div className="conv-head">
          <h1>私信</h1>
          {demo ? (
            <Button variant="ghost" size="sm" icon="plus" onClick={() => setPicker(true)} aria-label="发起会话">
              新会话
            </Button>
          ) : (
            <span className="tiny faint">仅成员可见</span>
          )}
        </div>
        <div className="conv-list">
          {(conversations.data ?? []).map((conv) => (
            <button
              key={conv.id}
              type="button"
              className={`conv-item${conv.id === activeId ? ' is-active' : ''}`}
              onClick={() => navigate(`/messages/${conv.id}`)}
            >
              <Avatar name={conv.title ?? '会话'} size={34} />
              <span className="conv-main">
                <span className="conv-title">
                  <strong>{conv.title ?? conv.members.map(shortId).join('、')}</strong>
                  <time>{relativeTime(conv.updated_at)}</time>
                </span>
                <span className="conv-preview">{conv.last_message || '还没有消息'}</span>
                {conv.unread ? <span className="conv-unread">{conv.unread}</span> : null}
              </span>
            </button>
          ))}
          {!conversations.data?.length ? (
            <div style={{ padding: 24 }}>
              <EmptyState
                compact
                icon="mail"
                title="还没有会话"
                body={demo ? '选择和一位成员开始对话。' : '当有人给你发消息时，会话会出现在这里。'}
                action={
                  demo ? (
                    <Button variant="secondary" size="sm" onClick={() => setPicker(true)}>
                      发起会话
                    </Button>
                  ) : null
                }
              />
            </div>
          ) : null}
        </div>
        {!demo ? (
          <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)' }}>
            <p className="tiny faint" style={{ lineHeight: 1.6 }}>
              契约没有成员目录端点，因此无法从浏览器发起新会话；已有会话仍可正常读写。
            </p>
          </div>
        ) : null}
      </aside>

      <section className="thread-pane">
        {active ? (
          <>
            <div className="thread-head">
              <button
                type="button"
                className="icon-btn conversation-back"
                onClick={() => navigate('/messages')}
                aria-label="返回会话列表"
                style={{ display: 'none' }}
              >
                <Icon name="chevron-left" size={17} />
              </button>
              <Avatar name={active.title ?? '会'} size={32} />
              <div>
                <h2>{active.title ?? active.members.map(shortId).join('、')}</h2>
                <p>{active.kind === 'group' ? `群聊 · ${active.members.length} 人` : '私信'}</p>
              </div>
            </div>

            <div className="thread-scroll" ref={scrollRef}>
              {messages.loading ? (
                <PageLoading label="正在载入消息" />
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
                    <p className="mt-12">还没有消息。说点什么吧。</p>
                  </div>
                </div>
              )}
            </div>

            <div className="thread-composer">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="输入消息，Enter 发送，Shift + Enter 换行"
                maxLength={5000}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <Button icon="send" loading={busy} onClick={send} disabled={!draft.trim()}>
                发送
              </Button>
            </div>
          </>
        ) : (
          <div className="thread-empty">
            <div>
              <Icon name="mail" size={26} />
              <p className="mt-12">选择一个会话，或者开始一段新的对话。</p>
            </div>
          </div>
        )}
      </section>

      <Modal
        open={picker}
        title="发起新会话"
        description="选择一位成员就是私信；选择多位会创建群聊。"
        onClose={() => setPicker(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPicker(false)}>
              取消
            </Button>
            <Button loading={busy} onClick={createConversation} disabled={!selectedMembers.length}>
              创建会话
            </Button>
          </>
        }
      >
        <div className="check-list">
          {demoMembers.map((user) => (
            <label key={user.id} className="checkline" style={{ padding: '8px 0' }}>
              <input
                type="checkbox"
                checked={selectedMembers.includes(user.id)}
                onChange={(e) =>
                  setSelectedMembers((prev) =>
                    e.target.checked ? [...prev, user.id] : prev.filter((id) => id !== user.id),
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
        {!demoMembers.length ? <p className="tiny faint">当前站点没有其他可选成员。</p> : null}
        <p className="field-hint mt-12">
          创建后你一定是成员；私信要求恰好一位其他成员。未读游标由服务端保存。
        </p>
      </Modal>
    </div>
  );
}
