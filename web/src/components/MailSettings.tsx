import { useState } from 'react';
import type { MailEncryption, MailSettings, PasswordResetPolicy } from '../types';
import {
  ENCRYPTION_OPTIONS,
  defaultPortFor,
  mailSettingsReady,
  smtpEnvSnippet,
} from '../lib/mail';
import { Badge, Callout, CopyButton, Field, Input, Select } from './ui';
import { Icon } from './Icon';
import { useT } from '../lib/i18n';

/**
 * 邮件（SMTP）编辑器。安装引导与「登录设置 → 邮件通知」共用。
 *
 * 密码只保存在组件状态里，用于拼接 .env 片段；服务端能力以 policy 为准。
 */
export function MailSettingsEditor({
  value,
  onChange,
  password,
  onPasswordChange,
  idPrefix = 'mail',
  demo = false,
  policy,
}: {
  value: MailSettings;
  onChange: (next: MailSettings) => void;
  password: string;
  onPasswordChange: (secret: string) => void;
  idPrefix?: string;
  demo?: boolean;
  policy?: PasswordResetPolicy | null;
}) {
  const t = useT();
  const [envOpen, setEnvOpen] = useState(false);
  const ready = mailSettingsReady(value);
  // 演示模式没有真实服务端，policy 说「可用」也不代表能发信。
  const live = !demo && policy?.enabled === true;

  const patch = (next: Partial<MailSettings>) => onChange({ ...value, ...next });

  const changeEncryption = (encryption: MailEncryption) => {
    const wasDefault = !value.port.trim() || value.port.trim() === defaultPortFor(value.encryption);
    patch({ encryption, port: wasDefault ? defaultPortFor(encryption) : value.port });
  };

  return (
    <div className="auth-providers">
      <div className={`auth-provider${value.enabled ? ' is-on' : ''}`}>
        <div className="auth-provider-head">
          <span className="provider-icon">
            <Icon name="mail" size={17} />
          </span>
          <div className="auth-provider-body">
            <strong>{t('找回密码邮件')}</strong>
            <p>{t('用户忘记密码时，服务端通过 SMTP 发出一封一次性链接。')}</p>
          </div>
          {value.enabled ? (
            demo ? (
              <Badge tone="accent">{t('演示模式')}</Badge>
            ) : live ? (
              <Badge tone="ok" dot>
                {t('服务端已就绪')}
              </Badge>
            ) : ready ? (
              <Badge tone="warn">{t('待服务端配置')}</Badge>
            ) : (
              <Badge tone="warn">{t('待补齐')}</Badge>
            )
          ) : (
            <Badge tone="muted">{t('未启用')}</Badge>
          )}
          <button
            type="button"
            role="switch"
            aria-checked={value.enabled}
            aria-label={t('启用找回密码')}
            className={`switch${value.enabled ? ' is-on' : ''}`}
            onClick={() => patch({ enabled: !value.enabled })}
          >
            <span />
          </button>
        </div>

        {value.enabled ? (
          <div className="auth-provider-config">
            <div className="form-grid">
              <Field
                label={t('SMTP 主机')}
                htmlFor={`${idPrefix}-host`}
                hint={t('例如 smtp.qq.com、smtp.gmail.com、mail.example.com。')}
              >
                <Input
                  id={`${idPrefix}-host`}
                  value={value.host}
                  placeholder="smtp.example.com"
                  autoComplete="off"
                  onChange={(event) => patch({ host: event.target.value })}
                />
              </Field>
              <Field label={t('加密方式')} htmlFor={`${idPrefix}-encryption`}>
                <Select
                  id={`${idPrefix}-encryption`}
                  value={value.encryption}
                  onChange={(event) => changeEncryption(event.target.value as MailEncryption)}
                >
                  {ENCRYPTION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {t(option.label)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label={t('端口')}
                htmlFor={`${idPrefix}-port`}
                hint={t('留空按加密方式取默认值（当前 {port}）。', {
                  port: defaultPortFor(value.encryption),
                })}
              >
                <Input
                  id={`${idPrefix}-port`}
                  value={value.port}
                  inputMode="numeric"
                  placeholder={defaultPortFor(value.encryption)}
                  onChange={(event) => patch({ port: event.target.value.replace(/[^\d]/g, '') })}
                />
              </Field>
              <Field
                label={t('发件地址')}
                htmlFor={`${idPrefix}-from`}
                hint={t('多数服务商要求与登录账号一致。')}
              >
                <Input
                  id={`${idPrefix}-from`}
                  type="email"
                  value={value.from}
                  placeholder="noreply@example.com"
                  autoComplete="off"
                  onChange={(event) => patch({ from: event.target.value })}
                />
              </Field>
              <Field
                label={t('登录账号')}
                htmlFor={`${idPrefix}-username`}
                hint={t('没有认证的内网中继可以留空。')}
              >
                <Input
                  id={`${idPrefix}-username`}
                  value={value.username}
                  placeholder="noreply@example.com"
                  autoComplete="off"
                  onChange={(event) => patch({ username: event.target.value })}
                />
              </Field>
              <Field
                label={t('登录密码 / 授权码')}
                htmlFor={`${idPrefix}-password`}
                hint={t('只用于生成服务端环境变量，不写入浏览器配置。')}
                aside={password ? <Badge tone="accent">{t('仅本次')}</Badge> : null}
              >
                <Input
                  id={`${idPrefix}-password`}
                  type="password"
                  value={password}
                  placeholder={t('SMTP 授权码')}
                  autoComplete="off"
                  onChange={(event) => onPasswordChange(event.target.value)}
                />
              </Field>
              <Field label={t('发件人名称')} htmlFor={`${idPrefix}-from-name`}>
                <Input
                  id={`${idPrefix}-from-name`}
                  value={value.from_name}
                  placeholder="Practacu Press"
                  onChange={(event) => patch({ from_name: event.target.value })}
                />
              </Field>
              <Field
                label={t('站点地址')}
                htmlFor={`${idPrefix}-base`}
                hint={t('绝对链接的前缀；留空时服务端按 https 假定，桌面 / localhost（http）请显式填写。')}
              >
                <Input
                  id={`${idPrefix}-base`}
                  value={value.public_base_url}
                  placeholder="https://press.example.com"
                  autoComplete="off"
                  onChange={(event) => patch({ public_base_url: event.target.value })}
                />
              </Field>
            </div>

            <p className="auth-provider-endpoint">
              {t('服务端端点：')}
              <code className="mono">GET /api/v1/auth/password-reset/policy</code>
            </p>

            <Callout
              tone={live ? 'ok' : 'info'}
              icon={live ? 'check' : 'info'}
              title={
                demo
                  ? t('演示模式：不会真的发信')
                  : live
                    ? t('服务端已能发出找回密码邮件')
                    : t('还需要把配置写进服务端')
              }
            >
              {demo
                ? t(
                    '演示模式的「忘记密码」完全在本地完成，不会真的发信。把上面的片段交给正式服务端后，登录页就会走真实邮件。',
                  )
                : live
                  ? t(
                      '服务端已经连上 SMTP。登录页会显示「忘记密码」入口，重置链接 30 分钟内有效。',
                    )
                  : t(
                      '把下面的环境变量写进服务端并重启 API，找回密码入口就会出现。在这之前，登录页会提示暂不可用。',
                    )}
            </Callout>
          </div>
        ) : null}
      </div>

      <div className="auth-env">
        <div className="auth-env-head">
          <div>
            <strong>{t('服务端环境变量')}</strong>
            <p>{t('复制到 .env（或进程环境变量）；重启 API 后生效。')}</p>
          </div>
          <div className="row gap-8">
            <CopyButton value={smtpEnvSnippet(value, password)} label={t('复制 .env')} />
            <button type="button" className="link-btn" onClick={() => setEnvOpen((next) => !next)}>
              {envOpen ? t('收起') : t('展开')}
            </button>
          </div>
        </div>
        {envOpen ? <pre className="auth-env-code">{smtpEnvSnippet(value, password)}</pre> : null}
        <Callout tone="warn" icon="alert" title={t('密码不经过前端保存')}>
          {t(
            'SMTP 授权码与 JWT 私钥一样只应该存在于服务端环境变量。这里填写的值仅用于拼接上面的片段，页面刷新后就没了。',
          )}
        </Callout>
      </div>
    </div>
  );
}
