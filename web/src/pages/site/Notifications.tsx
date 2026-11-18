import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Notification, NotificationChannelPreferences, NotificationPreferences } from '../../types';
import { useBackend } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { REALTIME_POLL, isInboxEvent, useRealtime } from '../../lib/realtime';
import { relativeTime } from '../../lib/format';
import { Button, EmptyState, Modal, PageLoading, Tabs, Toggle } from '../../components/ui';
import { Icon, type IconName } from '../../components/Icon';
import { useToast } from '../../lib/toast';
import { useT } from '../../lib/i18n';

type Translator = ReturnType<typeof useT>;

function describe(item: Notification, t: Translator): { icon: IconName; node: ReactNode } {
  const actor = item.payload.actor_name ?? t('有人');
  switch (item.type) {
    case 'comment.created':
      if (item.payload.reply === '1') {
        return {
          icon: 'message',
          node: (
            <>
              <strong>{actor}</strong> {t('回复了你')}
              {item.payload.excerpt ? (
                <span className="muted">{t('：{excerpt}', { excerpt: item.payload.excerpt })}</span>
              ) : null}
            </>
          ),
        };
      }
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
    case 'contact.created':
      // 联系表单：主题与正文都由服务端拼好，这里原样当文本渲染。
      return {
        icon: 'mail',
        node: (
          <>
            <strong>{item.payload.subject ?? t('站点来信')}</strong>
            {item.payload.message ? (
              <span className="muted">
                {t('：{excerpt}', { excerpt: item.payload.message })}
              </span>
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
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [prefsLoading, setPrefsLoading] = useState(false);
  const [prefsSaving, setPrefsSaving] = useState(false);
  useTitle(t('通知'));

  const inbox = useAsync(() => backend.notifications(), [backend]);
  const reloadInbox = inbox.reload;
  const realtime = useRealtime();
  const items = inbox.data?.items ?? [];
  const unread = items.filter((item) => !item.read).length;
  const visible = tab === 'all' ? items : items.filter((item) => !item.read);

  // 实时推送到达时重读通知；没有长连接时 `realtime.poll` 每 45 秒补一次。
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = realtime.subscribe((event) => {
      if (event.type !== REALTIME_POLL && !isInboxEvent(event.type)) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        reloadInbox();
      }, 200);
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [realtime, reloadInbox]);

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
    if (item.type === 'follow.created' && item.actor_id) {
      navigate(`/u/${item.actor_id}`);
      return;
    }
    inbox.reload();
  };

  const openPreferences = async () => {
    setPrefsOpen(true);
    if (prefs) return;
    setPrefsLoading(true);
    try {
      setPrefs(await backend.notificationPreferences());
    } catch (err) {
      toast.push('error', t('载入通知设置失败'), err instanceof Error ? err.message : undefined);
      setPrefsOpen(false);
    } finally {
      setPrefsLoading(false);
    }
  };

  const patchChannel = (
    channel: 'in_app' | 'email',
    key: keyof NotificationChannelPreferences,
    value: boolean,
  ) => {
    setPrefs((current) =>
      current
        ? { ...current, [channel]: { ...current[channel], [key]: value } }
        : current,
    );
  };

  const savePreferences = async () => {
    if (!prefs) return;
    setPrefsSaving(true);
    try {
      const saved = await backend.updateNotificationPreferences(prefs);
      setPrefs(saved);
      setPrefsOpen(false);
      toast.push('ok', t('通知设置已保存'));
    } catch (err) {
      toast.push('error', t('保存通知设置失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setPrefsSaving(false);
    }
  };

  return (
    <div className="shell shell-narrow">
      <header className="page-head">
        <p className="eyebrow">Inbox</p>
        <h1>{t('通知')}</h1>
        <p>{t('评论、点赞、关注与审核结果。只有你自己的通知会被返回；新通知实时推送，断线时每 45 秒轮询一次。')}</p>
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
          <Button variant="ghost" size="sm" icon="settings" onClick={() => void openPreferences()}>
            {t('通知设置')}
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
      <Modal
        open={prefsOpen}
        title={t('通知设置')}
        description={t('站内与邮件分别控制；分类开关只影响对应的事件。')}
        onClose={() => setPrefsOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPrefsOpen(false)}>
              {t('取消')}
            </Button>
            <Button loading={prefsSaving} onClick={() => void savePreferences()} disabled={!prefs}>
              {t('保存')}
            </Button>
          </>
        }
      >
        {prefsLoading ? (
          <PageLoading label={t('正在载入通知设置')} />
        ) : prefs ? (
          <div style={{ display: 'grid', gap: 20 }}>
            <section>
              <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>{t('站内通知')}</h3>
              <Toggle
                checked={prefs.in_app.enabled}
                onChange={(next) => patchChannel('in_app', 'enabled', next)}
                label={t('接收站内通知')}
                description={t('关闭后铃铛不再新增未读消息。')}
              />
              <div
                style={{
                  display: 'grid',
                  gap: 4,
                  marginTop: 4,
                  opacity: prefs.in_app.enabled ? 1 : 0.5,
                }}
              >
                <Toggle
                  checked={prefs.in_app.comments}
                  onChange={(next) => patchChannel('in_app', 'comments', next)}
                  label={t('评论与回复')}
                  description={t('有人评论你的内容或回复你的评论。')}
                  disabled={!prefs.in_app.enabled}
                />
                <Toggle
                  checked={prefs.in_app.reactions}
                  onChange={(next) => patchChannel('in_app', 'reactions', next)}
                  label={t('赞与反应')}
                  description={t('有人赞了你的内容。')}
                  disabled={!prefs.in_app.enabled}
                />
                <Toggle
                  checked={prefs.in_app.follows}
                  onChange={(next) => patchChannel('in_app', 'follows', next)}
                  label={t('新增关注')}
                  description={t('有人开始关注你。')}
                  disabled={!prefs.in_app.enabled}
                />
                <Toggle
                  checked={prefs.in_app.moderation}
                  onChange={(next) => patchChannel('in_app', 'moderation', next)}
                  label={t('审核与站点消息')}
                  description={t('审核结果、举报处理与站点来信。')}
                  disabled={!prefs.in_app.enabled}
                />
              </div>
            </section>

            <section>
              <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>{t('邮件通知')}</h3>
              {!prefs.email_configured ? (
                <p className="tiny faint" style={{ margin: '0 0 8px' }}>
                  {t('当前部署未配置 SMTP，邮件通知暂时不会发送。')}
                </p>
              ) : null}
              <Toggle
                checked={prefs.email.enabled}
                onChange={(next) => patchChannel('email', 'enabled', next)}
                label={t('接收邮件通知')}
                description={t('开启后，符合下面分类的事件会同时发到你的账户邮箱。')}
                disabled={!prefs.email_configured}
              />
              <div
                style={{
                  display: 'grid',
                  gap: 4,
                  marginTop: 4,
                  opacity: prefs.email.enabled && prefs.email_configured ? 1 : 0.5,
                }}
              >
                <Toggle
                  checked={prefs.email.comments}
                  onChange={(next) => patchChannel('email', 'comments', next)}
                  label={t('评论与回复')}
                  disabled={!prefs.email_configured || !prefs.email.enabled}
                />
                <Toggle
                  checked={prefs.email.reactions}
                  onChange={(next) => patchChannel('email', 'reactions', next)}
                  label={t('赞与反应')}
                  disabled={!prefs.email_configured || !prefs.email.enabled}
                />
                <Toggle
                  checked={prefs.email.follows}
                  onChange={(next) => patchChannel('email', 'follows', next)}
                  label={t('新增关注')}
                  disabled={!prefs.email_configured || !prefs.email.enabled}
                />
                <Toggle
                  checked={prefs.email.moderation}
                  onChange={(next) => patchChannel('email', 'moderation', next)}
                  label={t('审核与站点消息')}
                  disabled={!prefs.email_configured || !prefs.email.enabled}
                />
              </div>
            </section>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}