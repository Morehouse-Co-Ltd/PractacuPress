import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { AuthProviderId, CaptchaScene, TwoFactorChallenge } from '../../types';
import { inSitePath, useAuth } from '../../lib/session';
import { useBackend, isDemo } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import {
  passwordCreationProblem,
  passwordProblemText,
  weakPasswordProblem,
} from '../../lib/passwordPolicy';
import { useWeakPasswordConfirm } from '../../components/WeakPasswordDialog';
import { ApiError } from '../../lib/api';
import { PUBLISH_LABEL, VISIBILITY_LABEL } from '../../lib/format';
import { isPersonalSite } from '../../lib/site';
import { isRegistrationClosedError, registrationOpen } from '../../lib/registration';
import { navigateWithTransition } from '../../lib/themeTransition';
import {
  AUTH_PROVIDER_IDS,
  PROVIDER_BY_ID,
  providerReady,
  providerStartsOAuth,
  readAuthSettings,
} from '../../lib/authProviders';
import { recordActivity } from '../../lib/activity';
import { captchaReasonText, captchaSceneRequired } from '../../lib/captcha';
import { useToast } from '../../lib/toast';
import { useT } from '../../lib/i18n';
import { Button, Callout, Field, Input, Modal } from '../../components/ui';
import { CaptchaField, useCaptchaStatus } from '../../components/Captcha';
import { Icon } from '../../components/Icon';

// 演示模式的固定验证码：真实后端由短信服务商下发，这里只是为了本地能用同一套界面走通。
const DEMO_CODE = '246810';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const t = useT();
  const weakPassword = useWeakPasswordConfirm();
  const { login, verifyTwoFactor, providerLogin, oauthStart, register, site, status, config } =
    useAuth();
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
  // 与 OAuth 回跳共用同一套站内路径校验：反斜杠会被浏览器规范化成 `/`，
  // 只检查前缀的写法（`/\evil.example`）能把登录成功后的用户带到外站。
  const next = inSitePath(nextParam) || '/';
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const authSettings = readAuthSettings(config);
  const providers = AUTH_PROVIDER_IDS.filter((id) => authSettings[id].enabled);
  /**
   * 真实后端没有实现的登录方式（微信、QQ、验证器）。
   *
   * 站长可能已经在「登录设置」里把它们填完整了，但服务端没有对应端点：这些按钮要标成
   * 不可用并说清原因，而不是让用户点下去撞一页 problem+json。演示后端全部靠本地模拟，
   * 所以演示模式这个列表是空的。短信登录不在这里：服务端已经有 `/auth/phone/*` 端点，
   * 这个入口能不能用由下面的 `phonePolicy` 决定（见 unavailable 的定义）。
   */
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
  /**
   * 真实后端的短信登录（`/auth/phone/codes` + `/auth/phone/login`）。
   *
   * 与演示模式那份本地弹窗分开存放：演示后端不真的发码，走的是下面的模拟流程，
   * 两套状态混在一起会互相清空。
   */
  const [smsOpen, setSmsOpen] = useState(false);
  const [smsPhone, setSmsPhone] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [smsCodeSent, setSmsCodeSent] = useState(false);
  const [smsDevCode, setSmsDevCode] = useState('');
  /** 发码冷却：由服务端 `resend_after_seconds` 给，本地只负责把按钮锁住。 */
  const [smsCooldown, setSmsCooldown] = useState(0);
  const [smsBusy, setSmsBusy] = useState(false);
  const [smsError, setSmsError] = useState('');
  // 人机验证：是否显示组件由服务端的 effective 决定，站点设置只是意图。
  const captcha = useCaptchaStatus();
  const captchaScene: CaptchaScene = mode === 'login' ? 'login' : 'register';
  const captchaRequired = captchaSceneRequired(captcha.status, captchaScene);
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaNonce, setCaptchaNonce] = useState(0);
  const [captchaFailure, setCaptchaFailure] = useState('');
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

  /**
   * 短信登录能不能用，由**服务端策略**决定（`SMS_PROVIDER` 不是 `off`）。
   *
   * 后台「登录设置」里的开关只是站长的意图：签名与模板填好了、服务端却没有配网关时，
   * 发码只会拿到 503 `sms_not_configured`。所以入口只在策略说能用时才可点。
   * 演示模式不查策略：它不真的发短信，仍然走本地模拟弹窗（行为保持不变）。
   * 注册页没有短信入口，也就不必发这次请求。
   */
  const phonePolicy = useAsync(
    async () => (demo || mode !== 'login' ? null : backend.phonePolicy().catch(() => null)),
    [backend, mode],
  );
  const phoneAvailable = !demo && phonePolicy.data?.enabled === true;
  const unavailable = demo
    ? []
    : providers.filter((id) => id !== 'phone' && !providerStartsOAuth(id));

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

  // 发码冷却每秒走一格；到 0 之后按钮自己解锁，不再保留定时器。
  useEffect(() => {
    if (smsCooldown <= 0) return;
    const timer = window.setTimeout(() => {
      setSmsCooldown((value) => (value > 0 ? value - 1 : 0));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [smsCooldown]);

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
    await runSubmit(false);
  };

  const runSubmit = async (confirmWeak: boolean) => {
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
      if (!password) {
        setError(t('请填写密码。'));
        return;
      }
      if (password !== confirm) {
        setError(t('两次输入的密码不一致。'));
        return;
      }
      const weak = weakPasswordProblem(password);
      if (weak && !confirmWeak) {
        weakPassword.ask(weak, () => void runSubmit(true));
        return;
      }
      const hard = passwordCreationProblem(password, true);
      if (hard) {
        setError(t(passwordProblemText(hard, t)));
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
          confirm_weak_password: confirmWeak || undefined,
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
    // 真实后端的短信登录：口子开不开由服务端策略决定，与后台填的签名/模板无关，
    // 所以这里不拦 `providerReady`，否则填了一半的站点反而点不开已经能用的入口。
    if (!demo && id === 'phone') {
      if (!phoneAvailable) {
        setError(t('服务端没有可用的短信网关（SMS_PROVIDER=off），手机验证码登录暂时不可用。'));
        return;
      }
      setError('');
      setProviderError('');
      setSmsPhone('');
      setSmsCode('');
      setSmsCodeSent(false);
      setSmsDevCode('');
      setSmsCooldown(0);
      setSmsError('');
      setSmsOpen(true);
      return;
    }
    if (!providerReady(id, authSettings[id])) {
      setError(
        t('{provider}还没有配置完整。请在后台「登录设置」补齐参数。', {
          provider: PROVIDER_BY_ID[id].name,
        }),
      );
      return;
    }
    // 真实后端：授权页在提供商那边，只能整页跳转（fetch 到不了对方的登录页，回调
    // 种下的 HttpOnly Cookie 也不是脚本能处理的）。所以点击就直接交给后端，不再展开
    // 任何本地表单；回到站内之后落哪一页由后端 landingURL 决定，前端不重复跳转。
    if (!demo) {
      try {
        oauthStart(id, next);
      } catch (err) {
        // 只会在后端没有这种登录方式时抛错；按钮本身已经禁用，这里只是兜底。
        setError(err instanceof Error ? err.message : t('登录失败。'));
      }
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

  /**
   * 演示弹窗的提交：只有演示后端会走到这里（真实后端在 `openProvider` 里就整页跳走了）。
   */
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

  /**
   * 429 上的等待秒数。
   *
   * 服务端只在把 `retry_after_seconds` 放进 details 时才给得出数字：客户端的
   * `ApiError` 只保留 problem body，读不到 `Retry-After` 响应头，所以拿不到时返回 0，
   * 由调用方退到「请稍后再试」。
   */
  const phoneRetrySeconds = (err: unknown): number => {
    if (!(err instanceof ApiError)) return 0;
    const raw = err.problem.details?.retry_after_seconds;
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : 0;
  };

  /** 短信登录的错误码 → 可读提示（契约 A 的三个稳定码 + 频率超限）。 */
  const phoneErrorText = (err: unknown): string => {
    if (!(err instanceof ApiError)) {
      return err instanceof Error ? err.message : t('请求失败。');
    }
    const wait = phoneRetrySeconds(err);
    switch (err.code) {
      case 'invalid_code':
        return t('验证码不正确或已过期，请重新获取。');
      case 'registration_closed':
        return t('本站暂未开放注册。');
      case 'sms_not_configured':
        return t('服务端还没有配置短信服务，暂时无法发送验证码。');
      case 'rate_limited':
        return wait > 0
          ? t('操作过于频繁，请在 {seconds} 秒后再试。', { seconds: wait })
          : t('操作过于频繁，请稍后再试。');
      default:
        return err.message;
    }
  };

  /** 真实后端：请求一条登录用短信验证码（202），并按服务端给的秒数开始冷却。 */
  const sendSmsCode = async () => {
    const value = smsPhone.replace(/\s+/g, '');
    if (!/^1\d{10}$/.test(value)) {
      setSmsError(t('请填写 11 位手机号。'));
      return;
    }
    setSmsError('');
    setSmsBusy(true);
    try {
      const result = await backend.requestPhoneCode(value, 'login');
      setSmsCodeSent(true);
      setSmsDevCode(result.dev_code ?? '');
      setSmsCooldown(result.resend_after_seconds > 0 ? result.resend_after_seconds : 60);
    } catch (err) {
      const wait = phoneRetrySeconds(err);
      if (wait > 0) setSmsCooldown(wait);
      setSmsError(phoneErrorText(err));
    } finally {
      setSmsBusy(false);
    }
  };

  /**
   * 真实后端的短信登录提交。
   *
   * `/auth/phone/login` 与密码登录同形：要么直接给会话，要么给第二步的 2FA 挑战。
   * 挑战交给本页既有的验证界面（`challenge` + `verifyTwoFactor`），会话建立后
   * `status` 变 ready，由上面的 effect 统一跳转。
   */
  const submitSmsLogin = async () => {
    const value = smsPhone.replace(/\s+/g, '');
    if (!/^1\d{10}$/.test(value)) {
      setSmsError(t('请填写 11 位手机号。'));
      return;
    }
    if (!smsCode.trim()) {
      setSmsError(t('请输入验证码。'));
      return;
    }
    setSmsError('');
    setSmsBusy(true);
    try {
      // phoneLogin 与密码登录同形：可能是会话，也可能是 2FA 挑战。
      const result = await backend.phoneLogin({
        phone: value,
        code: smsCode.trim(),
      });
      if (result.status === 'two_factor_required') {
        setSmsOpen(false);
        setChallenge(result.challenge);
        setTwoFactorCode('');
        setTwoFactorError('');
        setUseRecoveryCode(false);
        return;
      }
      recordActivity({
        actor: value,
        action: '登录',
        target: '管理后台',
        detail: '手机号 + 短信验证码',
      });
      // 会话已经由后端客户端应用（令牌在内存、刷新 Cookie 在浏览器），但
      // AuthProvider 的会话状态没有暴露「短信登录」这条水合路径（`useAuth` 只
      // 提供密码 / 2FA 登录）。整页跳一次，让开屏水合从刷新 Cookie 接上这张会话——
      // 与第三方登录回跳是同一套机制，代价只是多一次页面加载。
      window.location.assign(next);
    } catch (err) {
      setSmsError(phoneErrorText(err));
    } finally {
      setSmsBusy(false);
    }
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
              hint={
                mode === 'register'
                  ? t('建议至少 12 位并包含两类字符；弱密码确认后也可以保存。')
                  : undefined
              }
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
                  // 真实后端只实现了部分方式：没实现的那个点了也只会 404，直接禁用。
                  // 样式表不在这次改动的范围里，不可用状态用内联样式标出来。
                  // 短信登录走服务端真实端点：策略查询中先禁用，查到了才下结论。
                  const checking = id === 'phone' && phonePolicy.loading;
                  const supported =
                    demo !== null ||
                    (id === 'phone' ? phoneAvailable : providerStartsOAuth(id));
                  const unsupportedText = checking
                    ? undefined
                    : id === 'phone'
                      ? t(
                          '服务端没有可用的短信网关（SMS_PROVIDER=off），手机验证码登录暂时不可用。',
                        )
                      : meta.unsupportedHint;
                  return (
                    <button
                      key={id}
                      type="button"
                      className="auth-provider-btn"
                      disabled={!supported}
                      title={supported ? undefined : unsupportedText}
                      style={supported ? undefined : { opacity: 0.55, cursor: 'not-allowed' }}
                      onClick={() => openProvider(id)}
                    >
                      <Icon name={meta.icon} size={16} />
                      <span>{meta.name}</span>
                      {ready ? null : <span className="auth-provider-flag">{t('待配置')}</span>}
                      {supported || checking ? null : (
                        <span className="auth-provider-flag">
                          {id === 'phone' ? t('短信未配置') : t('暂不支持')}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {unavailable.length ? (
                <p className="field-hint mt-8">
                  {t('服务端还没有实现 {providers} 登录，这些入口暂时不可用。', {
                    providers: unavailable.map((id) => PROVIDER_BY_ID[id].name).join(' / '),
                  })}
                </p>
              ) : null}
              {!demo && providers.includes('phone') && !phonePolicy.loading && !phoneAvailable ? (
                <p className="field-hint mt-8">
                  {t(
                    '服务端没有可用的短信网关（SMS_PROVIDER=off），手机验证码登录暂时不可用。',
                  )}
                </p>
              ) : null}
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

      {/*
        登录方式弹窗只属于演示模式：真实后端点一下就已经整页跳去授权页了，没有可以
        在本地「填」的东西。原先那种「等服务端实现」的说明也不再成立——后端已经实现
        google / github 两个提供方，其余方式在按钮上标成不可用。
      */}
      {demo && provider ? (
        <Modal
          open
          title={t('{provider}登录', { provider: PROVIDER_BY_ID[provider].name })}
          description={t(
            '演示模式不会真的发送短信或跳转授权页；确认后会以站点管理员身份进入。',
          )}
          onClose={() => setProvider(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setProvider(null)}>
                {t('取消')}
              </Button>
              <Button loading={providerBusy} onClick={submitProvider} iconRight="arrow-right">
                {provider === 'phone' ? t('登录') : t('模拟授权并继续')}
              </Button>
            </>
          }
        >
          <div className="form-stack">
            <div className="auth-provider-summary">
              <Icon name={PROVIDER_BY_ID[provider].icon} size={16} />
              <div>
                <strong>{PROVIDER_BY_ID[provider].summary}</strong>
                <p>{PROVIDER_BY_ID[provider].detail}</p>
              </div>
            </div>

            {provider === 'phone' ? (
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

            {providerError ? (
              <Callout tone="danger" icon="alert">
                {providerError}
              </Callout>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {/*
        真实后端的短信登录：发码走 `/auth/phone/codes`，登录走 `/auth/phone/login`。
        与上面演示弹窗分开渲染，演示模式永远走不到这里（策略在那里不生效）。
      */}
      {!demo && smsOpen ? (
        <Modal
          open
          title={t('手机验证码登录')}
          description={t(
            '用手机号接收 6 位验证码登录；未注册的号码在站点开放注册时会自动创建账户。',
          )}
          onClose={() => setSmsOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setSmsOpen(false)}>
                {t('取消')}
              </Button>
              <Button
                type="submit"
                form="auth-sms-form"
                loading={smsBusy}
                iconRight="arrow-right"
              >
                {t('登录')}
              </Button>
            </>
          }
        >
          <form
            id="auth-sms-form"
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void submitSmsLogin();
            }}
          >
            <Field label={t('手机号')} htmlFor="auth-sms-phone">
              <Input
                id="auth-sms-phone"
                value={smsPhone}
                inputMode="tel"
                autoComplete="tel"
                placeholder="138 0000 0000"
                onChange={(event) => {
                  setSmsPhone(event.target.value);
                  setSmsCodeSent(false);
                  setSmsDevCode('');
                }}
              />
            </Field>
            <Field
              label={t('验证码')}
              htmlFor="auth-sms-code"
              aside={
                <button
                  type="button"
                  className="link-btn"
                  disabled={smsBusy || smsCooldown > 0}
                  onClick={() => void sendSmsCode()}
                >
                  {smsCooldown > 0
                    ? t('{seconds} 秒后重发', { seconds: smsCooldown })
                    : smsCodeSent
                      ? t('重新获取')
                      : t('获取验证码')}
                </button>
              }
            >
              <Input
                id="auth-sms-code"
                value={smsCode}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder={t('6 位数字')}
                onChange={(event) => setSmsCode(event.target.value)}
              />
            </Field>

            {smsDevCode ? (
              <Callout tone="info" icon="message" title={t('开发模式验证码')}>
                {t('开发模式下短信服务商不会真的发信，验证码是 {code}。', { code: smsDevCode })}
              </Callout>
            ) : smsCodeSent ? (
              <Callout tone="info" icon="message" title={t('验证码已发送')}>
                {t('请查看手机短信，验证码几分钟内有效。')}
              </Callout>
            ) : null}

            {smsError ? (
              <Callout tone="danger" icon="alert">
                {smsError}
              </Callout>
            ) : null}
          </form>
        </Modal>
      ) : null}
      {weakPassword.dialog}
    </div>
  );
}
