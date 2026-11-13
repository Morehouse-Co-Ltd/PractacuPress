import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { AuthProviderId, CaptchaScene, TwoFactorChallenge } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend, isDemo } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { passwordProblem, passwordProblemText } from '../../lib/passwordPolicy';
import { ApiError } from '../../lib/api';
import { PUBLISH_LABEL, VISIBILITY_LABEL } from '../../lib/format';
import { isPersonalSite } from '../../lib/site';
import { isRegistrationClosedError, registrationOpen } from '../../lib/registration';
import { navigateWithTransition } from '../../lib/themeTransition';
import {
  AUTH_PROVIDER_IDS,
  PROVIDER_BY_ID,
  authEnvSnippet,
  providerReady,
  readAuthSettings,
} from '../../lib/authProviders';
import { copyText } from '../../lib/clipboard';
import { recordActivity } from '../../lib/activity';
import { captchaReasonText, captchaSceneRequired } from '../../lib/captcha';
import { useToast } from '../../lib/toast';
import { useT } from '../../lib/i18n';
import { Button, Callout, Field, Input, Modal } from '../../components/ui';
import { CaptchaField, useCaptchaStatus } from '../../components/Captcha';
import { Icon } from '../../components/Icon';

const DEMO_CODE = '246810';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const t = useT();
  const { login, verifyTwoFactor, providerLogin, register, site, status, config } = useAuth();
  const personal = isPersonalSite(config);
  // O-3：站长可以在站点设置里关闭自助注册；服务端拒绝时（403 registration_closed）
  // 与提前知道关闭时（Site.registration_open / 访客引导）都走同一张关闭提示卡。
  const registrationClosed = !personal && !registrationOpen(site);
  const backend = useBackend();
  const demo = isDemo(backend) ? backend : null;
  const navigate = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const nextParam = params.get('next') || '/';
  const next = nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/';
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const authSettings = readAuthSettings(config);
  const providers = AUTH_PROVIDER_IDS.filter((id) => authSettings[id].enabled);
  const [provider, setProvider] = useState<AuthProviderId | null>(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerError, setProviderError] = useState('');
  // FSD F-04 第二步：密码正确但账户开启了两步验证时，服务端只给挑战令牌。
  const [challenge, setChallenge] = useState<TwoFactorChallenge | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [twoFactorBusy, setTwoFactorBusy] = useState(false);
  const [twoFactorError, setTwoFactorError] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  // 人机验证：是否显示组件由服务端的 effective 决定，站点设置只是意图。
  const captcha = useCaptchaStatus();
  const captchaScene: CaptchaScene = mode === 'login' ? 'login' : 'register';
  const captchaRequired = captchaSceneRequired(captcha.status, captchaScene);
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaNonce, setCaptchaNonce] = useState(0);
  const [captchaFailure, setCaptchaFailure] = useState('');
  const recaptchaVersion = config.customization?.verification.recaptcha_version ?? 'v2';
  useTitle(
    mode === 'login'
      ? personal
        ? t('管理员登录')
        : t('登录')
      : personal || registrationClosed
        ? t('注册已关闭')
        : t('创建账户'),
  );

  const accounts = useAsync(async () => (demo ? demo.demoMembers() : []), [backend]);
  // 忘记密码能不能用取决于服务端有没有配 SMTP；查询失败时按「可用」处理，
  // 让用户点进去看到具体原因，而不是被一个隐藏的入口困住。
  const resetPolicy = useAsync(async () => backend.passwordResetPolicy(), [backend]);
  const canReset = resetPolicy.data ? resetPolicy.data.enabled : true;

  /** 重新验证：清掉旧 token 并重挂组件（token 只能用一次）。 */
  const resetCaptcha = () => {
    setCaptchaToken('');
    setCaptchaFailure('');
    setCaptchaNonce((value) => value + 1);
  };

  /**
   * 登录成功后的唯一跳转入口。
   *
   * 之前这里同时有「status 变 ready 的 effect」和提交函数里的 navigate 两条路径：
   * 一条先跳到 /admin、另一条又 replace 一次，页面在站点外壳和后台之间闪一下。
   * 用一个 ref 把跳转锁成一次，并且等提交结束（busy 落回 false）再交给 effect，
   * 避免 React 在提交过程中重渲染把登录页重新挂载。
   */
  const navigatedRef = useRef(false);
  const goNext = () => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    navigateWithTransition(() => navigate(next, { replace: true }));
  };

  useEffect(() => {
    if (status === 'ready' && !busy) goNext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, busy]);

  if (mode === 'register' && (personal || registrationClosed)) {
    return (
      <div className="auth-page">
        <div className="auth-main">
          <div className="auth-card">
            <p className="eyebrow">Closed</p>
            <h1>{personal ? t('这里不开放注册。') : t('本站暂未开放注册')}</h1>
            <p className="auth-lede">
              {personal
                ? t(
                    '{site} 是个人博客，不开放自助注册。账户由站长在后台「用户管理」里创建； 已经有账户的成员可以直接登录。',
                    { site: site?.name ?? t('本站') },
                  )
                : t(
                    '{site} 暂时关闭了自助注册。已经注册的成员可以直接登录；需要账户请联系站长开通。',
                    { site: site?.name ?? t('本站') },
                  )}
            </p>
            <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
              <Link to="/" className="btn btn-primary btn-md">
                {t('回到首页')}
              </Link>
              <Link to="/login" className="btn btn-secondary btn-md">
                {personal ? t('管理员登录') : t('登录')}
              </Link>
              {canReset ? (
                <Link to="/forgot-password" className="btn btn-ghost btn-md">
                  {t('忘记密码')}
                </Link>
              ) : null}
            </div>
            <p className="tiny faint mt-16">
              {personal
                ? t(
                    '访客无需账户即可阅读全部已发布内容。如果刚完成安装，请使用安装时填写的管理员邮箱进入后台。',
                  )
                : t('访客无需账户即可阅读全部已发布内容。注册开放时间由站长决定。')}
            </p>
          </div>
        </div>

        <aside className="auth-aside" aria-hidden>
          <p className="auth-quote">{t('“一个人写，一个人读，也是一种出版。”')}</p>
          <div className="auth-aside-meta">
            <span>{site ? VISIBILITY_LABEL[site.visibility_mode] : t('公开浏览')}</span>
            <span>{personal ? t('个人博客') : t('社区站点')}</span>
            <span>Ed25519 · HttpOnly Cookie</span>
          </div>
        </aside>
      </div>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (mode === 'login' && !email.trim()) {
      setError(t('请输入邮箱或用户名。'));
      return;
    }
    if (mode === 'register') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        setError(t('请填写有效的邮箱地址。'));
        return;
      }
      if (!displayName.trim()) {
        setError(t('请填写显示名称。'));
        return;
      }
      // 与后端同一套密码策略；只查长度会让用户提交后收到一句笼统的「参数不合法」。
      const passwordIssue = passwordProblem(password);
      if (passwordIssue) {
        setError(t(passwordProblemText(passwordIssue, t)));
        return;
      }
      if (password !== confirm) {
        setError(t('两次输入的密码不一致。'));
        return;
      }
    }
    setBusy(true);
    try {
      if (mode === 'login') {
        const result = await login(email.trim(), password, captchaToken || undefined);
        if (result.status === 'two_factor_required') {
          // 密码只是第一因素：不跳转，留在本页输入 6 位验证码或恢复码。
          setChallenge(result.challenge);
          setTwoFactorCode('');
          setTwoFactorError('');
          setUseRecoveryCode(false);
          return;
        }
        recordActivity({
          actor: email.trim() || '访客',
          action: '登录',
          target: '管理后台',
          detail: '邮箱/用户名 + 密码',
        });
      } else {
        await register({
          email: email.trim(),
          password,
          display_name: displayName.trim(),
          captcha_token: captchaToken || undefined,
        });
      }
      goNext();
    } catch (err) {
      // token 一次性：无论失败原因，下一次提交都要重新验证。
      resetCaptcha();
      const reason =
        err instanceof ApiError
          ? (err.problem.details as { reason?: string } | undefined)?.reason
          : undefined;
      const captchaText = captchaReasonText(reason, t);
      if (mode === 'register' && isRegistrationClosedError(err)) {
        // O-3：服务端关闭注册时给访客一条可读提示，而不是 403 problem 原文。
        setError(t('本站暂未开放注册。'));
      } else if (captchaText) {
        setError(captchaText);
      } else {
        setError(
          err instanceof ApiError
            ? err.code === 'unauthenticated'
              ? t('邮箱/用户名或密码不正确。')
              : err.message
            : err instanceof Error
              ? err.message
              : t('请求失败。'),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const submitTwoFactor = async (event: FormEvent) => {
    event.preventDefault();
    if (!challenge) return;
    const value = twoFactorCode.trim();
    if (!value) {
      setTwoFactorError(
        useRecoveryCode ? t('请输入一个恢复码。') : t('请输入 6 位验证码。'),
      );
      return;
    }
    if (!useRecoveryCode && !/^\d{6}$/.test(value)) {
      setTwoFactorError(t('验证码是 6 位数字。'));
      return;
    }
    setTwoFactorBusy(true);
    setTwoFactorError('');
    try {
      await verifyTwoFactor(challenge.challenge_token, value);
      recordActivity({
        actor: email.trim() || '访客',
        action: '登录',
        target: '管理后台',
        detail: useRecoveryCode ? '邮箱/用户名 + 恢复码' : '邮箱/用户名 + 两步验证',
      });
      goNext();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'unauthenticated') {
        // 挑战过期或已被使用：回到第一步重新输入密码。
        setChallenge(null);
        setError(t('验证已过期，请重新登录。'));
      } else {
        setTwoFactorError(
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : t('验证失败。'),
        );
      }
    } finally {
      setTwoFactorBusy(false);
    }
  };

  const fillDemo = (accountEmail: string) => {
    setEmail(accountEmail);
    setPassword('practacu');
    setError('');
  };

  const openProvider = (id: AuthProviderId) => {
    if (!providerReady(id, authSettings[id])) {
      setError(
        t('{provider}还没有配置完整。请在后台「登录设置」补齐参数。', {
          provider: PROVIDER_BY_ID[id].name,
        }),
      );
      return;
    }
    setProvider(id);
    setProviderError('');
    setPhone('');
    setCode('');
    setCodeSent(false);
  };

  const sendCode = () => {
    if (!/^1\d{10}$/.test(phone.replace(/\s+/g, ''))) {
      setProviderError(t('请填写 11 位手机号。'));
      return;
    }
    setProviderError('');
    setCodeSent(true);
    toast.push(
      'ok',
      t('演示验证码已生成'),
      t('真实环境由短信服务商发送；这里固定为 {code}。', { code: DEMO_CODE }),
    );
  };

  const submitProvider = async () => {
    if (!provider) return;
    setProviderError('');
    if (provider === 'phone') {
      if (!codeSent) {
        setProviderError(t('请先获取验证码。'));
        return;
      }
      if (code.trim() !== DEMO_CODE) {
        setProviderError(t('演示模式的验证码是 {code}。', { code: DEMO_CODE }));
        return;
      }
    }
    setProviderBusy(true);
    try {
      await providerLogin(provider);
      goNext();
    } catch (err) {
      setProviderError(err instanceof Error ? err.message : t('登录失败。'));
    } finally {
      setProviderBusy(false);
    }
  };

  const copyProviderEnv = async () => {
    const ok = await copyText(authEnvSnippet(authSettings));
    if (ok) toast.push('ok', t('服务端配置已复制'));
    else toast.push('error', t('无法复制'), t('请手动选择内容。'));
  };

  return (
    <div className="auth-page">
      <div className="auth-main">
        <div className="auth-card">
          <p className="eyebrow">{mode === 'login' ? 'Sign in' : 'Join'}</p>
          <h1>
            {challenge
              ? t('两步验证')
              : mode === 'login'
                ? personal
                  ? t('回到书房。')
                  : t('回到这间房子。')
                : t('领一把自己的钥匙。')}
          </h1>
          <p className="auth-lede">
            {challenge
              ? t('{site} 的这项账户开启了两步验证。打开身份验证器，输入当前的 6 位验证码；也可以用一次性恢复码。', {
                  site: site?.name ?? t('本站'),
                })
              : mode === 'login'
                ? personal
                  ? t('这是 {site} 的管理员入口。站长创建的账户都可以登录；访客不需要登录就能阅读。', {
                      site: site?.name ?? t('本站'),
                    })
                  : t('登录 {site}，继续阅读、评论与写作。', { site: site?.name ?? t('本站') })
                : t('注册后可以评论、收藏与投稿。') +
                  (site ? t('本站的发布模式是「{mode}」。', { mode: PUBLISH_LABEL[site.publish_mode] }) : '')}
          </p>

          {challenge ? (
            <form className="auth-form" onSubmit={submitTwoFactor}>
              <Field
                label={useRecoveryCode ? t('恢复码') : t('6 位验证码')}
                htmlFor="auth-two-factor-code"
                hint={
                  useRecoveryCode
                    ? t('每个恢复码只能使用一次，字母不区分大小写。')
                    : demo
                      ? t('演示模式固定使用 {code}。', { code: '123456' })
                      : t('验证码每 30 秒变化；同一个验证码只能使用一次。')
                }
                aside={
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      setUseRecoveryCode((value) => !value);
                      setTwoFactorCode('');
                      setTwoFactorError('');
                    }}
                  >
                    {useRecoveryCode ? t('使用验证器') : t('使用恢复码')}
                  </button>
                }
              >
                <Input
                  id="auth-two-factor-code"
                  value={twoFactorCode}
                  inputMode={useRecoveryCode ? 'text' : 'numeric'}
                  autoComplete="one-time-code"
                  autoFocus
                  maxLength={useRecoveryCode ? 32 : 6}
                  placeholder={useRecoveryCode ? t('XXXXXX-XXXXXX') : '000000'}
                  onChange={(event) => setTwoFactorCode(event.target.value)}
                  required
                />
              </Field>

              {twoFactorError ? (
                <Callout tone="danger" icon="alert">
                  {twoFactorError}
                </Callout>
              ) : null}

              <Button type="submit" size="lg" loading={twoFactorBusy} iconRight="arrow-right">
                {t('验证并登录')}
              </Button>

              <p className="auth-switch">
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setChallenge(null);
                    setTwoFactorError('');
                    setError('');
                    // 密码那一步用掉的 token 已经作废，回到第一步要重新验证。
                    resetCaptcha();
                  }}
                >
                  {t('返回上一步')}
                </button>
              </p>
            </form>
          ) : (
            <>
          <form className="auth-form" onSubmit={submit}>
            {mode === 'register' ? (
              <Field label={t('显示名称')} htmlFor="auth-name" hint={t('会出现在文章署名与评论里。')}>
                <Input
                  id="auth-name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={120}
                  autoComplete="nickname"
                  placeholder={t('例如：陈默')}
                />
              </Field>
            ) : null}

            <Field
              label={mode === 'login' ? t('邮箱或用户名') : t('邮箱')}
              htmlFor="auth-email"
              hint={personal ? t('站长创建的账户都可以登录；用户名或邮箱均可。') : undefined}
            >
              <Input
                id="auth-email"
                type={mode === 'login' ? 'text' : 'email'}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete={mode === 'login' ? 'username' : 'email'}
                placeholder={mode === 'login' ? t('邮箱或用户名') : 'you@example.com'}
                required
              />
            </Field>

            <Field
              label={t('密码')}
              htmlFor="auth-password"
              hint={mode === 'register' ? t('8–128 位。建议使用长口令或密码管理器。') : undefined}
              aside={
                <span className="row gap-10" style={{ alignItems: 'center' }}>
                  {mode === 'login' && canReset ? (
                    <Link
                      to={`/forgot-password?email=${encodeURIComponent(email.trim())}`}
                      className="link-btn"
                    >
                      {t('忘记密码？')}
                    </Link>
                  ) : null}
                  <button type="button" className="link-btn" onClick={() => setShowPassword((v) => !v)}>
                    {showPassword ? t('隐藏') : t('显示')}
                  </button>
                </span>
              }
            >
              <Input
                id="auth-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
              />
            </Field>

            {mode === 'register' ? (
              <Field label={t('确认密码')} htmlFor="auth-confirm">
                <Input
                  id="auth-confirm"
                  type={showPassword ? 'text' : 'password'}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </Field>
            ) : null}

            <CaptchaField
              scene={captchaScene}
              status={captcha.status}
              onToken={setCaptchaToken}
              recaptchaVersion={recaptchaVersion}
              resetKey={captchaNonce}
              onFailure={setCaptchaFailure}
            />

            {error ? (
              <Callout tone="danger" icon="alert">
                {error}
              </Callout>
            ) : null}

            <Button
              type="submit"
              size="lg"
              loading={busy}
              disabled={captchaRequired && !!captchaFailure}
              iconRight="arrow-right"
            >
              {mode === 'login' ? (personal ? t('管理员登录') : t('登录')) : t('创建账户')}
            </Button>
          </form>

          {mode === 'login' && !canReset ? (
            <p className="field-hint mt-12">
              {t('这个站点还没有配置发信服务（SMTP），找回密码暂时不可用。请联系站长。')}
            </p>
          ) : null}

          {mode === 'login' && providers.length ? (
            <div className="auth-providers-block">
              <div className="auth-divider">
                <span>{t('或')}</span>
              </div>
              <div className="auth-provider-buttons">
                {providers.map((id) => {
                  const meta = PROVIDER_BY_ID[id];
                  const ready = providerReady(id, authSettings[id]);
                  return (
                    <button
                      key={id}
                      type="button"
                      className="auth-provider-btn"
                      onClick={() => openProvider(id)}
                    >
                      <Icon name={meta.icon} size={16} />
                      <span>{meta.name}</span>
                      {ready ? null : <span className="auth-provider-flag">{t('待配置')}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {demo ? (
            <div className="demo-accounts">
              <p>{t('演示账户 · 密码统一为 practacu')}</p>
              <div className="row">
                {(accounts.data ?? []).slice(0, 4).map((account) => (
                  <button
                    key={account.id}
                    type="button"
                    className="demo-account"
                    onClick={() => fillDemo(account.email)}
                    title={account.email}
                  >
                    {account.display_name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {personal ? (
            <p className="auth-switch">
              {t('本站是个人博客，不开放自助注册。需要账户请联系站长创建。')}
            </p>
          ) : (
            <p className="auth-switch">
              {mode === 'login' ? (
                registrationClosed ? null : (
                  <>
                    {t('还没有账户？')}{' '}
                    <Link to={`/register?next=${encodeURIComponent(next)}`} className="text-link">
                      {t('创建一个')}
                    </Link>
                  </>
                )
              ) : (
                <>
                  {t('已经有账户？')}{' '}
                  <Link to={`/login?next=${encodeURIComponent(next)}`} className="text-link">
                    {t('直接登录')}
                  </Link>
                  {canReset ? (
                    <>
                      <span className="faint"> · </span>
                      <Link
                        to={`/forgot-password?email=${encodeURIComponent(email.trim())}`}
                        className="text-link"
                      >
                        {t('忘记密码')}
                      </Link>
                    </>
                  ) : null}
                </>
              )}
            </p>
          )}
            </>
          )}
        </div>
      </div>

      <aside className="auth-aside" aria-hidden>
        <p className="auth-quote">
          {t('“独立不是拒绝平台，而是保留搬走的能力。房子不必大，能遮雨，能招待几个朋友，就够了。”')}
        </p>
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
          <span>{site ? VISIBILITY_LABEL[site.visibility_mode] : t('公开浏览')}</span>
          <span>{site ? PUBLISH_LABEL[site.publish_mode] : t('审核发布')}</span>
          <span>Ed25519 · HttpOnly Cookie</span>
          <span>
            <Icon name="shield" size={11} /> {t('服务端强制授权')}
          </span>
        </div>
      </aside>

      <Modal
        open={provider !== null}
        title={
          provider ? t('{provider}登录', { provider: PROVIDER_BY_ID[provider].name }) : t('登录')
        }
        description={
          provider
            ? demo
              ? t('演示模式不会真的发送短信或跳转授权页；确认后会以站点管理员身份进入。')
              : t('服务端实现对应端点后，这个入口才能真正完成登录。')
            : undefined
        }
        onClose={() => setProvider(null)}
        footer={
          provider && demo ? (
            <>
              <Button variant="ghost" onClick={() => setProvider(null)}>
                {t('取消')}
              </Button>
              <Button loading={providerBusy} onClick={submitProvider} iconRight="arrow-right">
                {provider === 'phone' ? t('登录') : t('模拟授权并继续')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setProvider(null)}>
                {t('关闭')}
              </Button>
              <Button variant="secondary" icon="copy" onClick={copyProviderEnv}>
                {t('复制服务端配置')}
              </Button>
            </>
          )
        }
      >
        {provider ? (
          <div className="form-stack">
            <div className="auth-provider-summary">
              <Icon name={PROVIDER_BY_ID[provider].icon} size={16} />
              <div>
                <strong>{PROVIDER_BY_ID[provider].summary}</strong>
                <p>{PROVIDER_BY_ID[provider].detail}</p>
              </div>
            </div>

            {provider === 'phone' && demo ? (
              <>
                <Field label={t('手机号')} htmlFor="provider-phone">
                  <Input
                    id="provider-phone"
                    value={phone}
                    inputMode="tel"
                    placeholder="138 0000 0000"
                    onChange={(event) => {
                      setPhone(event.target.value);
                      setCodeSent(false);
                    }}
                  />
                </Field>
                <Field
                  label={t('验证码')}
                  htmlFor="provider-code"
                  aside={
                    <button type="button" className="link-btn" onClick={sendCode}>
                      {codeSent ? t('重新获取') : t('获取验证码')}
                    </button>
                  }
                >
                  <Input
                    id="provider-code"
                    value={code}
                    inputMode="numeric"
                    maxLength={6}
                    placeholder={t('6 位数字')}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </Field>
                {codeSent ? (
                  <Callout tone="info" icon="message" title={t('演示验证码')}>
                    {t('请输入')} <code className="mono">{DEMO_CODE}</code>
                    {t('。真实环境由短信服务商下发，前端不保存验证码。')}
                  </Callout>
                ) : null}
              </>
            ) : null}

            {!demo ? (
              <Callout tone="warn" icon="alert" title={t('等待服务端实现')}>
                {t('契约 v0.1.0 没有这个登录端点。服务端实现')}
                <code className="mono"> {PROVIDER_BY_ID[provider].endpoint} </code>
                {t('后，前端才能把用户交给提供商并接收回调。')}
              </Callout>
            ) : null}

            {providerError ? (
              <Callout tone="danger" icon="alert">
                {providerError}
              </Callout>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
