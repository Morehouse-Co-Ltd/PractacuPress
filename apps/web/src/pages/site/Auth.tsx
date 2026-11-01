import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { AuthProviderId } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend, isDemo } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { ApiError } from '../../lib/api';
import { PUBLISH_LABEL, VISIBILITY_LABEL } from '../../lib/format';
import { isPersonalSite } from '../../lib/site';
import {
  AUTH_PROVIDER_IDS,
  PROVIDER_BY_ID,
  authEnvSnippet,
  providerReady,
  readAuthSettings,
} from '../../lib/authProviders';
import { copyText } from '../../lib/clipboard';
import { recordActivity } from '../../lib/activity';
import { useToast } from '../../lib/toast';
import { Button, Callout, Field, Input, Modal } from '../../components/ui';
import { Icon } from '../../components/Icon';

const DEMO_CODE = '246810';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { login, providerLogin, register, site, status, config } = useAuth();
  const personal = isPersonalSite(config);
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
  useTitle(mode === 'login' ? (personal ? '管理员登录' : '登录') : personal ? '注册已关闭' : '创建账户');

  const accounts = useAsync(async () => (demo ? demo.demoMembers() : []), [backend]);
  // 忘记密码能不能用取决于服务端有没有配 SMTP；查询失败时按「可用」处理，
  // 让用户点进去看到具体原因，而不是被一个隐藏的入口困住。
  const resetPolicy = useAsync(async () => backend.passwordResetPolicy(), [backend]);
  const canReset = resetPolicy.data ? resetPolicy.data.enabled : true;

  useEffect(() => {
    if (status === 'ready') navigate(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  if (mode === 'register' && personal) {
    return (
      <div className="auth-page">
        <div className="auth-main">
          <div className="auth-card">
            <p className="eyebrow">Closed</p>
            <h1>这里不开放注册。</h1>
            <p className="auth-lede">
              {site?.name ?? '本站'} 是个人博客，不开放自助注册。账户由站长在后台「用户管理」里创建；
              已经有账户的成员可以直接登录。
            </p>
            <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
              <Link to="/" className="btn btn-primary btn-md">
                回到首页
              </Link>
              <Link to="/login" className="btn btn-secondary btn-md">
                管理员登录
              </Link>
              {canReset ? (
                <Link to="/forgot-password" className="btn btn-ghost btn-md">
                  忘记密码
                </Link>
              ) : null}
            </div>
            <p className="tiny faint mt-16">
              访客无需账户即可阅读全部已发布内容。如果刚完成安装，请使用安装时填写的管理员邮箱进入后台。
            </p>
          </div>
        </div>

        <aside className="auth-aside" aria-hidden>
          <p className="auth-quote">“一个人写，一个人读，也是一种出版。”</p>
          <div className="auth-aside-meta">
            <span>{site ? VISIBILITY_LABEL[site.visibility_mode] : '公开浏览'}</span>
            <span>个人博客</span>
            <span>Ed25519 · HttpOnly Cookie</span>
          </div>
        </aside>
      </div>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (mode === 'register') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        setError('请填写有效的邮箱地址。');
        return;
      }
      if (!displayName.trim()) {
        setError('请填写显示名称。');
        return;
      }
      if (password.length < 8) {
        setError('密码至少 8 位。');
        return;
      }
      if (password !== confirm) {
        setError('两次输入的密码不一致。');
        return;
      }
    }
    setBusy(true);
    try {
      if (mode === 'login') {
        await login(email.trim(), password);
        recordActivity({
          actor: email.trim() || '访客',
          action: '登录',
          target: '管理后台',
          detail: '邮箱 + 密码',
        });
      } else {
        await register({ email: email.trim(), password, display_name: displayName.trim() });
      }
      navigate(next, { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.code === 'unauthenticated'
            ? '邮箱或密码不正确。'
            : err.message
          : err instanceof Error
            ? err.message
            : '请求失败。',
      );
    } finally {
      setBusy(false);
    }
  };

  const fillDemo = (accountEmail: string) => {
    setEmail(accountEmail);
    setPassword('practacu');
    setError('');
  };

  const openProvider = (id: AuthProviderId) => {
    if (!providerReady(id, authSettings[id])) {
      setError(`${PROVIDER_BY_ID[id].name}还没有配置完整。请在后台「登录设置」补齐参数。`);
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
      setProviderError('请填写 11 位手机号。');
      return;
    }
    setProviderError('');
    setCodeSent(true);
    toast.push('ok', '演示验证码已生成', `真实环境由短信服务商发送；这里固定为 ${DEMO_CODE}。`);
  };

  const submitProvider = async () => {
    if (!provider) return;
    setProviderError('');
    if (provider === 'phone') {
      if (!codeSent) {
        setProviderError('请先获取验证码。');
        return;
      }
      if (code.trim() !== DEMO_CODE) {
        setProviderError(`演示模式的验证码是 ${DEMO_CODE}。`);
        return;
      }
    }
    setProviderBusy(true);
    try {
      await providerLogin(provider);
      navigate(next, { replace: true });
    } catch (err) {
      setProviderError(err instanceof Error ? err.message : '登录失败。');
    } finally {
      setProviderBusy(false);
    }
  };

  const copyProviderEnv = async () => {
    const ok = await copyText(authEnvSnippet(authSettings));
    if (ok) toast.push('ok', '服务端配置已复制');
    else toast.push('error', '无法复制', '请手动选择内容。');
  };

  return (
    <div className="auth-page">
      <div className="auth-main">
        <div className="auth-card">
          <p className="eyebrow">{mode === 'login' ? 'Sign in' : 'Join'}</p>
          <h1>
            {mode === 'login' ? (personal ? '回到书房。' : '回到这间房子。') : '领一把自己的钥匙。'}
          </h1>
          <p className="auth-lede">
            {mode === 'login'
              ? personal
                ? `这是 ${site?.name ?? '本站'} 的管理员入口。站长创建的账户都可以登录；访客不需要登录就能阅读。`
                : `登录 ${site?.name ?? '本站'}，继续阅读、评论与写作。`
              : `注册后可以评论、收藏与投稿。${site ? `本站的发布模式是「${PUBLISH_LABEL[site.publish_mode]}」。` : ''}`}
          </p>

          <form className="auth-form" onSubmit={submit}>
            {mode === 'register' ? (
              <Field label="显示名称" htmlFor="auth-name" hint="会出现在文章署名与评论里。">
                <Input
                  id="auth-name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={120}
                  autoComplete="nickname"
                  placeholder="例如：陈默"
                />
              </Field>
            ) : null}

            <Field
              label="邮箱"
              htmlFor="auth-email"
              hint={personal ? '站长创建的账户都可以登录。' : undefined}
            >
              <Input
                id="auth-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                placeholder="you@example.com"
                required
              />
            </Field>

            <Field
              label="密码"
              htmlFor="auth-password"
              hint={mode === 'register' ? '8–128 位。建议使用长口令或密码管理器。' : undefined}
              aside={
                <span className="row gap-10" style={{ alignItems: 'center' }}>
                  {mode === 'login' && canReset ? (
                    <Link
                      to={`/forgot-password?email=${encodeURIComponent(email.trim())}`}
                      className="link-btn"
                    >
                      忘记密码？
                    </Link>
                  ) : null}
                  <button type="button" className="link-btn" onClick={() => setShowPassword((v) => !v)}>
                    {showPassword ? '隐藏' : '显示'}
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
              <Field label="确认密码" htmlFor="auth-confirm">
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

            {error ? (
              <Callout tone="danger" icon="alert">
                {error}
              </Callout>
            ) : null}

            <Button type="submit" size="lg" loading={busy} iconRight="arrow-right">
              {mode === 'login' ? (personal ? '管理员登录' : '登录') : '创建账户'}
            </Button>
          </form>

          {mode === 'login' && !canReset ? (
            <p className="field-hint mt-12">
              这个站点还没有配置发信服务（SMTP），找回密码暂时不可用。请联系站长。
            </p>
          ) : null}

          {mode === 'login' && providers.length ? (
            <div className="auth-providers-block">
              <div className="auth-divider">
                <span>或</span>
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
                      {ready ? null : <span className="auth-provider-flag">待配置</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {demo ? (
            <div className="demo-accounts">
              <p>演示账户 · 密码统一为 practacu</p>
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
            <p className="auth-switch">本站是个人博客，不开放自助注册。需要账户请联系站长创建。</p>
          ) : (
            <p className="auth-switch">
              {mode === 'login' ? (
                <>
                  还没有账户？{' '}
                  <Link to={`/register?next=${encodeURIComponent(next)}`} className="text-link">
                    创建一个
                  </Link>
                </>
              ) : (
                <>
                  已经有账户？{' '}
                  <Link to={`/login?next=${encodeURIComponent(next)}`} className="text-link">
                    直接登录
                  </Link>
                  {canReset ? (
                    <>
                      <span className="faint"> · </span>
                      <Link
                        to={`/forgot-password?email=${encodeURIComponent(email.trim())}`}
                        className="text-link"
                      >
                        忘记密码
                      </Link>
                    </>
                  ) : null}
                </>
              )}
            </p>
          )}
        </div>
      </div>

      <aside className="auth-aside" aria-hidden>
        <p className="auth-quote">
          “独立不是拒绝平台，而是保留搬走的能力。房子不必大，能遮雨，能招待几个朋友，就够了。”
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
          <span>{site ? VISIBILITY_LABEL[site.visibility_mode] : '公开浏览'}</span>
          <span>{site ? PUBLISH_LABEL[site.publish_mode] : '审核发布'}</span>
          <span>Ed25519 · HttpOnly Cookie</span>
          <span>
            <Icon name="shield" size={11} /> 服务端强制授权
          </span>
        </div>
      </aside>

      <Modal
        open={provider !== null}
        title={provider ? `${PROVIDER_BY_ID[provider].name}登录` : '登录'}
        description={
          provider
            ? demo
              ? '演示模式不会真的发送短信或跳转授权页；确认后会以站点管理员身份进入。'
              : '服务端实现对应端点后，这个入口才能真正完成登录。'
            : undefined
        }
        onClose={() => setProvider(null)}
        footer={
          provider && demo ? (
            <>
              <Button variant="ghost" onClick={() => setProvider(null)}>
                取消
              </Button>
              <Button loading={providerBusy} onClick={submitProvider} iconRight="arrow-right">
                {provider === 'phone' ? '登录' : '模拟授权并继续'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setProvider(null)}>
                关闭
              </Button>
              <Button variant="secondary" icon="copy" onClick={copyProviderEnv}>
                复制服务端配置
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
                <Field label="手机号" htmlFor="provider-phone">
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
                  label="验证码"
                  htmlFor="provider-code"
                  aside={
                    <button type="button" className="link-btn" onClick={sendCode}>
                      {codeSent ? '重新获取' : '获取验证码'}
                    </button>
                  }
                >
                  <Input
                    id="provider-code"
                    value={code}
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="6 位数字"
                    onChange={(event) => setCode(event.target.value)}
                  />
                </Field>
                {codeSent ? (
                  <Callout tone="info" icon="message" title="演示验证码">
                    请输入 <code className="mono">{DEMO_CODE}</code>。真实环境由短信服务商下发，前端不保存验证码。
                  </Callout>
                ) : null}
              </>
            ) : null}

            {!demo ? (
              <Callout tone="warn" icon="alert" title="等待服务端实现">
                契约 v0.1.0 没有这个登录端点。服务端实现
                <code className="mono"> {PROVIDER_BY_ID[provider].endpoint} </code>
                后，前端才能把用户交给提供商并接收回调。
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
