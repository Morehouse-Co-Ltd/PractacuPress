import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AuthProviderId, MailSettings } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend, isDemo } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { useT } from '../../lib/i18n';
import {
  AUTH_PROVIDER_IDS,
  PROVIDER_BY_ID,
  authEnvSnippet,
  readAuthSettings,
} from '../../lib/authProviders';
import { readMailSettings } from '../../lib/mail';
import { AuthProvidersEditor } from '../../components/AuthProviders';
import { MailSettingsEditor } from '../../components/MailSettings';
import { Badge, Callout, CopyButton } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';

type LoginTab = 'email' | AuthProviderId;

/**
 * 登录设置：用顶部五种方式当分页。
 *
 * 邮箱与密码是基础方式（内含邮件通知 / 找回密码），其余四种第三方登录各自
 * 只有自己的配置项；服务端环境变量片段在分页下方统一生成。
 */
export function LoginSettingsPage() {
  const t = useT();
  const { config, updateConfig } = useAuth();
  const backend = useBackend();
  const demo = isDemo(backend);
  const [secrets, setSecrets] = useState<Partial<Record<AuthProviderId, string>>>({});
  const [mailPassword, setMailPassword] = useState('');
  const [tab, setTab] = useState<LoginTab>('email');
  const auth = readAuthSettings(config);
  const mailSettings = readMailSettings(config);
  const policy = useAsync(async () => backend.passwordResetPolicy(), [backend]);
  useTitle(t('登录设置'));

  const provider = tab === 'email' ? null : PROVIDER_BY_ID[tab];
  const secretsReady = Object.values(secrets).some((value) => !!value);
  const envSnippet = authEnvSnippet(auth, secrets);

  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('登录设置')}</h1>
          <p>
            {t(
              '点击上方五种登录方式切换配置；每种方式只显示自己的参数。开关自动保存到站点服务端，登录页对所有访客显示同一组方式。',
            )}
          </p>
        </div>
        <div className="admin-page-actions">
          <Link to="/admin/settings" className="btn btn-secondary btn-sm">
            <Icon name="arrow-left" size={14} /> {t('返回站点设置')}
          </Link>
        </div>
      </div>

      <div className="login-summary" role="tablist" aria-label={t('登录方式')}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'email'}
          className={`login-summary-card is-on is-tab${tab === 'email' ? ' is-active' : ''}`}
          onClick={() => setTab('email')}
        >
          <span className="login-summary-icon">
            <Icon name="mail" size={18} />
          </span>
          <div>
            <strong>{t('邮箱与密码')}</strong>
            <p>{t('基础登录方式，含邮件通知与找回密码。')}</p>
          </div>
          <Badge tone="ok" dot>
            {t('已启用')}
          </Badge>
        </button>
        {AUTH_PROVIDER_IDS.map((id) => {
          const meta = PROVIDER_BY_ID[id];
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`login-summary-card is-tab${auth[id].enabled ? ' is-on' : ''}${
                tab === id ? ' is-active' : ''
              }`}
              onClick={() => setTab(id)}
            >
              <span className="login-summary-icon">
                <Icon name={meta.icon} size={18} />
              </span>
              <div>
                <strong>{meta.name}</strong>
              </div>
              <Badge tone={auth[id].enabled ? 'accent' : 'muted'}>
                {auth[id].enabled ? t('已启用') : t('关闭')}
              </Badge>
            </button>
          );
        })}
      </div>

      {tab === 'email' ? (
        <>
          <section className="panel mt-20">
            <div className="panel-head">
              <div>
                <h3>{t('邮箱与密码')}</h3>
              </div>
              <Badge tone="ok" dot>
                Ed25519 · HttpOnly Cookie
              </Badge>
            </div>
            <div className="panel-body">
              <div className="mini-list">
                <div className="mini-row">
                  <span className="mini-label">{t('登录方式')}</span>
                  <span className="mini-value">{t('邮箱 + 密码')}</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('令牌')}</span>
                  <span className="mini-value">Ed25519 JWT + Refresh Cookie</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('防跨站')}</span>
                  <span className="mini-value">{t('CSRF 双提交')}</span>
                </div>
              </div>
            </div>
          </section>

          <section className="panel mt-20">
            <div className="panel-head">
              <div>
                <h3>{t('邮件通知')}</h3>
                <p>{t('找回密码靠邮件发出一次性链接；没有 SMTP 就没有找回密码。')}</p>
              </div>
              <Badge
                tone={demo ? 'accent' : policy.data?.enabled ? 'ok' : 'muted'}
                dot={!demo && !!policy.data?.enabled}
              >
                {demo
                  ? t('演示模式')
                  : policy.data?.enabled
                    ? t('服务端已连通')
                    : t('服务端未配置')}
              </Badge>
            </div>
            <div className="panel-body">
              <MailSettingsEditor
                value={mailSettings}
                onChange={(mail: MailSettings) => updateConfig({ mail })}
                password={mailPassword}
                onPasswordChange={setMailPassword}
                idPrefix="login-settings-mail"
                demo={demo}
                policy={policy.data ?? null}
              />
              <p className="field-hint mt-12">
                {t('这一栏记录的是站点侧的配置意图，真正能否发信由服务端环境变量决定。')}{' '}
                {t('下面的片段复制到 .env 后重启 API，徽章会变成「服务端已连通」。')}
              </p>
            </div>
          </section>
        </>
      ) : provider ? (
        <section className="panel mt-20">
          <div className="panel-head">
            <div>
              <h3>{provider.name}</h3>
              <p>{provider.detail}</p>
            </div>
            <Badge tone={auth[provider.id].enabled ? 'accent' : 'muted'}>
              {auth[provider.id].enabled ? t('已启用') : t('未启用')}
            </Badge>
          </div>
          <div className="panel-body">
            <AuthProvidersEditor
              value={auth}
              onChange={(next) => updateConfig({ auth: next })}
              secrets={secrets}
              onSecretChange={(id, secret) => setSecrets((prev) => ({ ...prev, [id]: secret }))}
              idPrefix="login-settings"
              demo={demo}
              only={provider.id}
              showEnv={false}
            />
            <Callout tone="info" icon="info">
              {t('登录页只显示必填项完整的方式。连接真实后端时，对应端点需要由服务端实现；演示模式可以直接模拟授权。')}
            </Callout>
          </div>
        </section>
      ) : null}

      <section className="panel mt-20">
        <div className="panel-head">
          <div>
            <h3>{t('服务端环境变量')}</h3>
            <p>{t('五种方式共用；密钥只用于拼接片段，不会写入浏览器配置。')}</p>
          </div>
          <div className="row gap-8">
            {secretsReady ? <Badge tone="accent">{t('含本次填写密钥')}</Badge> : null}
            <CopyButton value={envSnippet} label={t('复制 .env')} />
          </div>
        </div>
        <div className="panel-body">
          <pre className="auth-env-code">{envSnippet}</pre>
          <Callout tone="warn" icon="alert" title={t('密钥不经过前端保存')}>
            {t('浏览器的 localStorage 对同域脚本可读。Client Secret、短信 AccessSecret 与 JWT')}{' '}
            {t('私钥只应该存在于服务端环境变量，这里填写的值仅用于拼接上面的片段。')}
          </Callout>
        </div>
      </section>
    </RoleGate>
  );
}
