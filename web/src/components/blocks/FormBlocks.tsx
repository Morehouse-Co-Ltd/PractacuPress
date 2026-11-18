import { useMemo, useState, type FormEvent, type ReactElement } from 'react';
import type { BlockInstance } from '../../types';
import { blockProp } from '../../lib/blocks';
import {
  cooldownRemainingMs,
  contactPayload,
  honeypotTripped,
  validateContact,
  type ContactDraft,
  type ContactFields,
  type ContactIssue,
} from '../../lib/contactForm';
import { isDemo, useBackend } from '../../lib/backend';
import { renderMarkdown, sanitizeHtml } from '../../lib/markdown';
import { useAuth } from '../../lib/session';
import { useT } from '../../lib/i18n';

/**
 * P3 联系表单（`contact-form`）。
 *
 * 只有**联系表单**，没有订阅名单：订阅需要订阅者表、退订、导出与合规声明，是另一个
 * 议题。这里读者写一句话，服务端把它变成站长信箱里的一条通知（见
 * `internal/site/contact.go`），除此之外什么都不留。
 *
 * 四件事值得记下来：
 * - **不渲染用户输入**：留言只作为表单控件的值存在，提交后进入的是别人的通知 payload；
 *   这里从不把它拼进 HTML。作者写的 `intro` 是另一回事，它走 `renderMarkdown` +
 *   `sanitizeHtml`，与 `text` 区块同一条链路。
 * - **三态**：idle / sending / sent。失败回到 idle 并显示重试提示，**永远不清空**已经
 *   写下的内容——重打一遍长留言是最让人放弃的交互。
 * - **蜜罐**：`website` 字段藏在视口外（不是 `display: none`，那太容易被识破）。
 *   填了就不发请求，直接当成功处理；服务端有同样的判断，挡住绕过前端的请求。
 * - **60 秒冷却**：这里是一层（记住上次成功的时间），服务端另有一层。两层的口径一致，
 *   前端这层只是让读者不必等一个 429 才知道。
 *
 * 演示模式不发请求：直接进入成功态，并在按钮下方注明这一点。
 */

/** 表单上的一处提示。`cooldown` 只存在于前端（服务端的 429 是另一道闸）。 */
type Notice = ContactIssue | 'cooldown';

/** 提示语按代码选文案：中文留在 `t()` 里，英文表才有条目。 */
function noticeText(notice: Notice, t: ReturnType<typeof useT>): string {
  switch (notice) {
    case 'message_required':
      return t('请先写下要发送的内容。');
    case 'message_too_long':
      return t('留言最多 2000 个字符，请精简一下。');
    case 'name_too_long':
      return t('名字太长，请缩短到 80 个字节以内（约 26 个汉字）。');
    case 'email_too_long':
      return t('回信地址太长了，请缩短一些。');
    case 'email_invalid':
      return t('回信地址需要包含 @，例如 name@example.com。');
    case 'cooldown':
      return t('刚发过一条，请稍后再试。');
  }
}

function ContactForm({ block }: { block: BlockInstance }): ReactElement {
  const t = useT();
  const backend = useBackend();
  const { site } = useAuth();
  const demo = isDemo(backend);

  const heading = blockProp<string>(block, 'heading', '').trim();
  const intro = blockProp<string>(block, 'intro', '');
  const submitLabel = blockProp<string>(block, 'submit_label', '').trim() || t('发送');
  const successText =
    blockProp<string>(block, 'success_text', '').trim() || t('已经送到站长的信箱，谢谢。');

  // 字段开关每渲染算一次就够；它只决定校验与请求体带哪些键。
  const fields = useMemo<ContactFields>(
    () => ({
      showName: blockProp(block, 'show_name', true),
      showEmail: blockProp(block, 'show_email', true),
    }),
    [block],
  );

  const [draft, setDraft] = useState<ContactDraft>({
    name: '',
    email: '',
    message: '',
    website: '',
  });
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [failed, setFailed] = useState(false);
  // 上次成功发送的时刻：本地冷却以它为起点。失败不计入。
  const [sentAt, setSentAt] = useState<number | null>(null);

  const update = (key: keyof ContactDraft) => (value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status === 'sending') return;

    // 蜜罐：机器人填满了看不见的字段。这里连请求都不发，界面上按成功处理，
    // 与服务端「静默 202」的行为一致。
    if (honeypotTripped(draft)) {
      setStatus('sent');
      setNotice(null);
      setFailed(false);
      return;
    }

    const issue = validateContact(draft, fields);
    if (issue) {
      setNotice(issue);
      setFailed(false);
      return;
    }

    const remaining = cooldownRemainingMs(sentAt, Date.now());
    if (remaining > 0) {
      setNotice('cooldown');
      setFailed(false);
      return;
    }

    setNotice(null);
    setFailed(false);

    // 演示模式不碰网络：直接成功，并在按钮下方说明。
    if (demo) {
      setStatus('sent');
      setSentAt(Date.now());
      return;
    }

    const siteId = site?.id ?? '';
    if (!siteId) {
      // 匿名访客的站点标识来自启动探测；拿不到就说明这次访问没有站点上下文。
      setFailed(true);
      return;
    }

    setStatus('sending');
    try {
      await backend.contactSite(siteId, contactPayload(draft, fields));
      setStatus('sent');
      setSentAt(Date.now());
    } catch {
      // 三态回到 idle，输入原样保留：让读者按一下重试，而不是重写一遍。
      setStatus('idle');
      setFailed(true);
    }
  };

  return (
    <div className="pp-contact">
      {heading ? <h2 className="pp-contact-heading">{heading}</h2> : null}
      {intro ? (
        <div
          className="pp-contact-intro article-body"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderMarkdown(intro)) }}
        />
      ) : null}

      <form className="pp-contact-form" onSubmit={(event) => void submit(event)} noValidate>
        {fields.showName ? (
          <label className="pp-contact-field">
            <span>{t('姓名')}</span>
            <input
              name="name"
              type="text"
              value={draft.name}
              autoComplete="name"
              maxLength={80}
              onChange={(event) => update('name')(event.target.value)}
            />
          </label>
        ) : null}

        {fields.showEmail ? (
          <label className="pp-contact-field">
            <span>{t('回信邮箱')}</span>
            <input
              name="email"
              type="email"
              value={draft.email}
              autoComplete="email"
              // 200 是字节上限，这里用字符数兜个大概；真正的边界由 validateContact 判。
              maxLength={200}
              onChange={(event) => update('email')(event.target.value)}
            />
          </label>
        ) : null}

        <label className="pp-contact-field">
          <span>{t('留言')}</span>
          <textarea
            name="message"
            rows={6}
            value={draft.message}
            onChange={(event) => update('message')(event.target.value)}
          />
        </label>

        {/*
          蜜罐：正常读者看不见也点不到，机器人会按字段名填满。
          用 aria-hidden + tabIndex=-1 把它从读屏与 Tab 顺序里摘出去。
        */}
        <div className="pp-contact-honeypot" aria-hidden="true">
          <label>
            <span>{t('网站')}</span>
            <input
              name="website"
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={draft.website ?? ''}
              onChange={(event) => update('website')(event.target.value)}
            />
          </label>
        </div>

        <button className="pp-contact-submit btn btn-primary" type="submit" disabled={status === 'sending'}>
          {status === 'sending' ? t('正在发送…') : submitLabel}
        </button>

        {demo ? <p className="pp-contact-demo-hint">{t('演示模式下不会真的发送。')}</p> : null}

        {notice ? (
          <p className="pp-contact-error" role="alert">
            {noticeText(notice, t)}
          </p>
        ) : null}

        {failed ? (
          <p className="pp-contact-error" role="alert">
            {t('发送失败，请稍后再试。')}
          </p>
        ) : null}

        {status === 'sent' ? (
          <p className="pp-contact-success" role="status">
            {successText}
          </p>
        ) : null}
      </form>
    </div>
  );
}

export const FORM_RENDERERS: Record<string, (props: { block: BlockInstance }) => ReactElement | null> =
  {
    'contact-form': ContactForm,
  };
