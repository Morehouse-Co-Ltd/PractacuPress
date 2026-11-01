import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useBackend } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { ApiError } from '../../lib/api';
import { isPersonalSite } from '../../lib/site';
import { useAuth } from '../../lib/session';
import { useT } from '../../lib/i18n';
import { Button, Callout, Field, Input } from '../../components/ui';
import { Icon } from '../../components/Icon';

/** 认证页共用的两栏外壳：左侧表单，右侧站点注脚。 */
function AuthShell({ children }: { children: ReactNode }) {
  const t = useT();
  const { site, config } = useAuth();
  const personal = isPersonalSite(config);
  return (
    <div className="auth-page">
      <div className="auth-main">
        <div className="auth-card">{children}</div>
      </div>
      <aside className="auth-aside" aria-hidden>
        <p className="auth-quote">{t('“忘记密码是常事。能自己找回来，才算一间待客的房子。”')}</p>
        <svg className="auth-aside-art" viewBox="0 0 360 360">
          <g stroke="#d8d8cf" strokeWidth="1" fill="none">
            {Array.from({ length: 9 }, (_, i) => (
              <circle key={i} cx="180" cy="180" r={26 + i * 18} />
            ))}
            <line x1="0" y1="180" x2="360" y2="180" />
            <line x1="180" y1="0" x2="180" y2="360" />
          </g>
        </svg>
        <div className="auth-aside-meta">
          <span>{site?.name ?? 'Practacu Press'}</span>
          <span>{personal ? t('个人博客') : t('社区站点')}</span>
          <span>{t('一次性链接 · 30 分钟')}</span>
          <span>
            <Icon name="shield" size={11} /> {t('成功后其他设备退出')}
          </span>
        </div>
      </aside>
    </div>
  );
}

type Translator = ReturnType<typeof useT>;

function errorMessage(err: unknown, t: Translator): string {
  if (err instanceof ApiError) {
    if (err.code === 'email_not_configured') {
      return t('服务端还没有配置 SMTP，暂时无法发送邮件。请联系站长。');
    }
    if (err.code === 'validation_failed') return err.message;
    if (err.code === 'rate_limited') return t('请求过于频繁，请稍后再试。');
    return err.message;
  }
  return err instanceof Error ? err.message : t('请求失败，请稍后再试。');
}

/** 申请重置链接。 */
export function ForgotPasswordPage() {
  const t = useT();
  const backend = useBackend();
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [ticket, setTicket] = useState<{ token?: string; expires_in: number } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useTitle(t('找回密码'));

  const policy = useAsync(async () => backend.passwordResetPolicy(), [backend]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError(t('请填写有效的邮箱地址。'));
      return;
    }
    setBusy(true);
    try {
      const result = await backend.requestPasswordReset(email.trim());
      setTicket({ token: result.token, expires_in: result.expires_in });
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  const minutes = ticket ? Math.round(ticket.expires_in / 60) : 30;

  return (
    <AuthShell>
      <p className="eyebrow">Reset</p>
      <h1>{t('找回密码。')}</h1>
      <p className="auth-lede">
        {t(
          '填写账户邮箱，我们会发一封带一次性链接的邮件。链接 {minutes} 分钟内有效，只能使用一次。',
          { minutes },
        )}
      </p>

      {policy.data && !policy.data.enabled ? (
        <div className="mt-24">
          <Callout tone="warn" icon="alert" title={t('这个站点还没有配置发信服务')}>
            {t(
              '服务端需要先填写 SMTP 主机、端口与发信账号，找回密码才能真正发出邮件。 如果你就是站长，可以到「管理后台 → 登录设置 → 邮件通知」生成配置片段。',
            )}
          </Callout>
          <div className="row gap-8 mt-16" style={{ flexWrap: 'wrap' }}>
            <Link to="/login" className="btn btn-secondary btn-md">
              {t('回到登录')}
            </Link>
          </div>
        </div>
      ) : ticket ? (
        <div className="mt-24">
          <Callout tone="ok" icon="check" title={t('如果这个邮箱已注册，邮件已经发出')}>
            {t(
              '没有收到？先看看垃圾邮件目录；邮件可能延迟一两分钟。出于安全考虑，我们不会告诉你这个邮箱是否存在。',
            )}
          </Callout>

          {ticket.token ? (
            <div className="demo-accounts mt-16">
              <p>{t('演示模式不会真的发邮件 · 直接用下面的链接继续')}</p>
              <Link
                to={`/reset-password?token=${encodeURIComponent(ticket.token)}`}
                className="btn btn-primary btn-sm"
              >
                {t('打开重置链接')}
              </Link>
            </div>
          ) : null}

          <div className="row gap-8 mt-24" style={{ flexWrap: 'wrap' }}>
            <Link to="/login" className="btn btn-secondary btn-md">
              {t('回到登录')}
            </Link>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setTicket(null);
                setError('');
              }}
            >
              {t('换一个邮箱')}
            </button>
          </div>
        </div>
      ) : (
        <form className="auth-form" onSubmit={submit}>
          <Field label={t('邮箱')} htmlFor="forgot-email" hint={t('就是登录时使用的那个邮箱。')}>
            <Input
              id="forgot-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              placeholder="you@example.com"
              autoFocus
              required
            />
          </Field>

          {error ? (
            <Callout tone="danger" icon="alert">
              {error}
            </Callout>
          ) : null}

          <Button type="submit" size="lg" loading={busy} iconRight="arrow-right">
            {t('发送重置链接')}
          </Button>
        </form>
      )}

      {!ticket ? (
        <p className="auth-switch">
          {t('想起来了？')}{' '}
          <Link to="/login" className="text-link">
            {t('直接登录')}
          </Link>
        </p>
      ) : null}
    </AuthShell>
  );
}

/** 用链接里的令牌设置新密码。 */
export function ResetPasswordPage() {
  const t = useT();
  const backend = useBackend();
  const { status, logout } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [invalid, setInvalid] = useState(!token);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  useTitle(t('设置新密码'));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (password.length < 8) {
      setError(t('密码至少 8 位。'));
      return;
    }
    if (password !== confirm) {
      setError(t('两次输入的密码不一致。'));
      return;
    }
    setBusy(true);
    try {
      await backend.resetPassword({ token, password });
      // 服务端已经吊销了这个账户的全部会话，本机也别再装作还登录着。
      if (status === 'ready') await logout().catch(() => undefined);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'validation_failed') {
        const reason = (err.problem.details as { reason?: string } | undefined)?.reason;
        if (reason === 'reset_token_invalid') {
          setInvalid(true);
          setError(t('这个链接已经用过，或者过期了。请重新申请一封邮件。'));
          return;
        }
      }
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <p className="eyebrow">{done ? 'Done' : invalid ? 'Expired' : 'New password'}</p>
      <h1>{done ? t('密码已更新。') : invalid ? t('链接不能用了。') : t('设置新密码。')}</h1>

      {done ? (
        <>
          <p className="auth-lede">{t('密码已经更新。为了安全，这个账户之前登录的设备都已退出。')}</p>
          <div className="mt-24">
            <Callout tone="ok" icon="check" title={t('可以继续使用了')}>
              {t('用新密码重新登录即可。之后如果又想改密码，重复一遍找回流程就好。')}
            </Callout>
          </div>
          <div className="row gap-8 mt-24" style={{ flexWrap: 'wrap' }}>
            <Button size="md" onClick={() => navigate('/login', { replace: true })} iconRight="arrow-right">
              {t('去登录')}
            </Button>
            <Link to="/" className="btn btn-secondary btn-md">
              {t('回到首页')}
            </Link>
          </div>
        </>
      ) : invalid ? (
        <>
          <p className="auth-lede">{t('这个重置链接没法使用了。')}</p>
          <div className="mt-24">
            <Callout tone="warn" icon="alert" title={t('链接无效或已过期')}>
              {t('重置链接只能使用一次，并且 30 分钟后失效。重新申请一封邮件就可以了。')}
            </Callout>
          </div>
          <div className="row gap-8 mt-24" style={{ flexWrap: 'wrap' }}>
            <Link to="/forgot-password" className="btn btn-primary btn-md">
              {t('重新申请')}
            </Link>
            <Link to="/login" className="btn btn-secondary btn-md">
              {t('回到登录')}
            </Link>
          </div>
        </>
      ) : (
        <>
          <p className="auth-lede">
            {t('选一个新密码。设置成功后，这个账户在所有设备上的登录都会失效。')}
          </p>
          <form className="auth-form" onSubmit={submit}>
            <Field
              label={t('新密码')}
              htmlFor="reset-password"
              hint={t('8–128 位。建议使用长口令或密码管理器。')}
              aside={
                <button type="button" className="link-btn" onClick={() => setShowPassword((v) => !v)}>
                  {showPassword ? t('隐藏') : t('显示')}
                </button>
              }
            >
              <Input
                id="reset-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                autoFocus
                required
              />
            </Field>

            <Field label={t('确认新密码')} htmlFor="reset-confirm">
              <Input
                id="reset-confirm"
                type={showPassword ? 'text' : 'password'}
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="new-password"
                required
              />
            </Field>

            {error ? (
              <Callout tone="danger" icon="alert">
                {error}
              </Callout>
            ) : null}

            <Button type="submit" size="lg" loading={busy} iconRight="check">
              {t('更新密码')}
            </Button>
          </form>

          <p className="auth-switch">
            <Link to="/login" className="text-link">
              {t('返回登录')}
            </Link>
            <span className="faint"> · </span>
            <Link to="/forgot-password" className="text-link">
              {t('重新申请链接')}
            </Link>
          </p>
        </>
      )}

      {invalid ? (
        <p className="tiny faint mt-16" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Icon name="info" size={12} />
          {t('需要帮助？联系站点管理员。')}
        </p>
      ) : null}
    </AuthShell>
  );
}
