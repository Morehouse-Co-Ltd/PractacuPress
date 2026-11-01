import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Notification } from '../../types';
import { useBackend } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { relativeTime } from '../../lib/format';
import { Button, EmptyState, PageLoading, Tabs } from '../../components/ui';
import { Icon, type IconName } from '../../components/Icon';
import { useToast } from '../../lib/toast';
import { useT } from '../../lib/i18n';

type Translator = ReturnType<typeof useT>;

function describe(item: Notification, t: Translator): { icon: IconName; node: ReactNode } {
  const actor = item.payload.actor_name ?? t('有人');
  switch (item.type) {
    case 'comment.created':
      return {
        icon: 'message',
        node: (
          <>
            <strong>{actor}</strong> {t('评论了')}
            {item.payload.title ? (
              <strong>{t('《{title}》', { title: item.payload.title })}</strong>
            ) : (
              t('你的内容')
            )}
            {item.payload.excerpt ? (
              <span className="muted">{t('：{excerpt}', { excerpt: item.payload.excerpt })}</span>
            ) : null}
          </>
        ),
      };
    case 'reaction.created':
      return {
        icon: 'thumb',
        node: (
          <>
            <strong>{actor}</strong> {t('赞了')}
            {item.payload.title ? (
              <strong>{t('《{title}》', { title: item.payload.title })}</strong>
            ) : (
              t('你的内容')
            )}
          </>
        ),
      };
    case 'follow.created':
      return {
        icon: 'user',
        node: (
          <>
            <strong>{actor}</strong> {t('开始关注你。')}
          </>
        ),
      };
    case 'moderation.updated':
      return {
        icon: 'shield',
        node: (
          <>
            {item.payload.title ? (
              <strong>{t('《{title}》', { title: item.payload.title })}</strong>
            ) : (
              t('你的内容')
            )}{' '}
            {t('状态更新')}
            {item.payload.excerpt ? (
              <span className="muted">{t('：{excerpt}', { excerpt: item.payload.excerpt })}</span>
            ) : null}
          </>
        ),
      };
    case 'message.created':
      return {
        icon: 'mail',
        node: (
          <>
            <strong>{actor}</strong> {t('发来一条私信')}
            {item.payload.excerpt ? (
              <span className="muted">{t('：{excerpt}', { excerpt: item.payload.excerpt })}</span>
            ) : null}
          </>
        ),
      };
    default:
      return { icon: 'bell', node: <>{item.type}</> };
  }
}

export function NotificationsPage() {
  const t = useT();
  const backend = useBackend();
  const navigate = useNavigate();
  const toast = useToast();
  const [tab, setTab] = useState<'all' | 'unread'>('all');
  const [busy, setBusy] = useState(false);
  useTitle(t('通知'));

  const inbox = useAsync(() => backend.notifications(), [backend]);
  const items = inbox.data?.items ?? [];
  const unread = items.filter((item) => !item.read).length;
  const visible = tab === 'all' ? items : items.filter((item) => !item.read);

  const markAll = async () => {
    setBusy(true);
    try {
      const updated = await backend.markAllNotificationsRead();
      toast.push(
        'ok',
        updated ? t('已标记 {count} 条为已读', { count: updated }) : t('没有未读通知'),
      );
      inbox.reload();
    } catch (err) {
      toast.push('error', t('操作失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const open = async (item: Notification) => {
    if (!item.read) {
      try {
        await backend.markNotificationRead(item.id);
      } catch {
        /* 已读失败不阻塞跳转 */
      }
    }
    const kind = item.payload.kind;
    const target = item.payload.target_id;
    if (kind && target) {
      navigate(`/${kind === 'article' ? 'a' : 'p'}/${target}`);
      return;
    }
    if (item.payload.conversation_id) {
      navigate(`/messages/${item.payload.conversation_id}`);
      return;
    }
    inbox.reload();
  };

  return (
    <div className="shell shell-narrow">
      <header className="page-head">
        <p className="eyebrow">Inbox</p>
        <h1>{t('通知')}</h1>
        <p>{t('评论、点赞、关注与审核结果。只有你自己的通知会被返回；未读数每 45 秒轮询一次。')}</p>
        <div className="page-head-row">
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { key: 'all', label: t('全部'), count: items.length },
              { key: 'unread', label: t('未读'), count: unread },
            ]}
          />
          <Button
            variant="secondary"
            size="sm"
            icon="check"
            loading={busy}
            onClick={markAll}
            disabled={!unread}
          >
            {t('全部标为已读')}
          </Button>
        </div>
      </header>

      {inbox.loading ? (
        <PageLoading label={t('正在载入通知')} />
      ) : visible.length === 0 ? (
        <div className="mt-24">
          <EmptyState
            icon="bell"
            title={tab === 'unread' ? t('没有未读通知') : t('通知箱是空的')}
            body={
              tab === 'unread'
                ? t('所有消息都读过了。新的评论或审核结果会出现在这里。')
                : t('当有人评论、点赞或关注你时，这里会收到一条通知。')
            }
            action={
              <Link to="/" className="btn btn-secondary btn-sm">
                {t('回到首页')}
              </Link>
            }
          />
        </div>
      ) : (
        <div className="notif-list">
          {visible.map((item) => {
            const meta = describe(item, t);
            return (
              <button
                key={item.id}
                type="button"
                className={`notif-row${item.read ? '' : ' is-unread'}`}
                onClick={() => void open(item)}
                style={{ width: '100%', textAlign: 'left', background: 'none', borderLeft: 0, borderRight: 0, borderTop: 0 }}
              >
                <span className="notif-icon">
                  <Icon name={meta.icon} size={15} />
                </span>
                <span className="notif-body">
                  <p>{meta.node}</p>
                  <time>{relativeTime(item.created_at)}</time>
                </span>
                {!item.read ? <span className="notif-dot" aria-label={t('未读')} /> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
