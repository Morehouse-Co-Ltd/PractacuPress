import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import type { BlockInstance, Comment } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import { ApiError } from '../../lib/api';
import { usePermissions } from '../../lib/usePermissions';
import { useCustomization } from '../../lib/customize';
import { captchaReasonText, captchaSceneRequired } from '../../lib/captcha';
import { useToast } from '../../lib/toast';
import { blockProp } from '../../lib/blocks';
import { formatDate } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { Avatar, Callout, EmptyState, Skeleton } from '../ui';
import { CaptchaField, useCaptchaStatus } from '../Captcha';
import { Icon } from '../Icon';
import { useScreenScope } from './ScreenScope';

/**
 * 留言箱。
 *
 * 数据走评论接口：`target_type=page`、`target_id` 取当前界面（首页或页面 id），
 * 因此不需要新的后端端点。先审后发由站点的评论策略决定，前端只负责展示状态。
 */
export function Guestbook({ block }: { block: BlockInstance }): ReactElement {
  const t = useT();
  const { me } = useAuth();
  const backend = useBackend();
  const { can } = usePermissions();
  const { customization } = useCustomization();
  const toast = useToast();
  const scope = useScreenScope();

  const heading = blockProp(block, 'heading', '').trim() || t('留言箱');
  const intro = blockProp(block, 'intro', '').trim();
  const placeholder = blockProp(block, 'placeholder', '').trim() || t('写句话吧…');
  const limit = Math.min(50, Math.max(3, blockProp(block, 'limit', 20)));

  const [items, setItems] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  // 留言走评论接口，所以同样受站点评论人机验证约束。
  const captcha = useCaptchaStatus();
  const captchaRequired = captchaSceneRequired(captcha.status, 'comment');
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaNonce, setCaptchaNonce] = useState(0);
  const [captchaFailure, setCaptchaFailure] = useState('');
  const captchaBlocked = captchaRequired && !!captchaFailure;

  const commentsDisabled = !customization.comments.enabled;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await backend.comments('page', scope.id);
      setItems(result.items);
      setError(result.supported ? '' : t('当前后端还没有评论列表端点，留言暂时无法显示。'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('留言读取失败。'));
    } finally {
      setLoading(false);
    }
  }, [backend, scope.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    const text = body.trim();
    if (!text || busy) return;
    if (!can('comment')) {
      toast.push('error', t('没有留言权限'), t('站长可以在用户组里开启这项能力。'));
      return;
    }
    setBusy(true);
    try {
      await backend.createComment(
        {
          target_type: 'page',
          target_id: scope.id,
          body: text,
          captcha_token: captchaToken || undefined,
        },
        { require_review: customization.comments.require_review },
      );
      setBody('');
      resetCaptcha();
      await load();
      toast.push(
        'ok',
        t('留言已送出'),
        customization.comments.require_review ? t('通过审核后才会公开显示。') : undefined,
      );
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

  /** 一次性 token：提交后（成功或失败）都要重新验证。 */
  const resetCaptcha = () => {
    setCaptchaToken('');
    setCaptchaFailure('');
    setCaptchaNonce((value) => value + 1);
  };

  const sorted = [...items].sort((a, b) =>
    (b.created_at ?? '').localeCompare(a.created_at ?? ''),
  );

  return (
    <section className="pp-guestbook" aria-label={heading}>
      <div className="pp-guestbook-head">
        <div>
          <h2>{heading}</h2>
          {intro ? <p>{intro}</p> : null}
        </div>
        <span className="pp-guestbook-count">
          <Icon name="mail" size={13} /> {t('{count} 条留言', { count: items.length })}
        </span>
      </div>

      {commentsDisabled ? (
        <Callout tone="info" icon="info" title={t('留言入口已关闭')}>
          {t('站长在「站点设置 → 评论」里关闭了评论；已有留言仍然保留。')}
        </Callout>
      ) : me ? (
        <form
          className="pp-guestbook-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Avatar name={me.user.display_name} size={34} />
          <div className="pp-guestbook-input">
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder={placeholder}
              maxLength={5000}
              rows={4}
              aria-label={t('给{title}留言', { title: scope.title ?? t('这个页面') })}
            />
            <CaptchaField
              scene="comment"
              status={captcha.status}
              onToken={setCaptchaToken}
              recaptchaVersion={customization.verification.recaptcha_version ?? 'v2'}
              resetKey={captchaNonce}
              onFailure={setCaptchaFailure}
            />
            <div className="pp-guestbook-actions">
              <span className="tiny faint">{body.length}/5000</span>
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={busy || !body.trim() || captchaBlocked}
              >
                {busy ? t('发送中…') : t('留下这句话')}
              </button>
            </div>
          </div>
        </form>
      ) : (
        <div className="pp-guestbook-login">
          <Icon name="mail" size={16} />
          <span>{t('登录后就能留言，写多写少都可以。')}</span>
          <Link to="/login" className="btn btn-secondary btn-sm">
            {t('去登录')}
          </Link>
        </div>
      )}

      {error ? (
        <Callout tone="danger" icon="alert">
          {error}
        </Callout>
      ) : null}

      {loading ? (
        <Skeleton lines={3} />
      ) : sorted.length ? (
        <ul className="pp-guestbook-list">
          {sorted.slice(0, limit).map((comment) => (
            <li key={comment.id}>
              <Avatar name={comment.author_name ?? t('访客')} size={30} />
              <div className="pp-guestbook-body">
                <div className="pp-guestbook-meta">
                  <strong>{comment.author_name ?? t('访客')}</strong>
                  {comment.created_at ? <span>{formatDate(comment.created_at)}</span> : null}
                  {comment.status === 'pending_review' ? <em>{t('待审核')}</em> : null}
                </div>
                <p>{comment.body}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState compact icon="mail" title={t('还没有留言')} body={t('第一句话留给你。')} />
      )}
    </section>
  );
}

export const ENGAGE_RENDERERS: Record<string, (props: { block: BlockInstance }) => ReactElement> = {
  guestbook: Guestbook,
};
