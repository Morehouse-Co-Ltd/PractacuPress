import { useState } from 'react';
import type { AuthProviderId, AuthProviderSettings, AuthSettings } from '../types';
import {
  AUTH_PROVIDER_IDS,
  PROVIDER_BY_ID,
  authEnvSnippet,
  providerReady,
} from '../lib/authProviders';
import { Badge, Callout, CopyButton, Field, Input } from './ui';
import { Icon } from './Icon';

/**
 * 登录方式编辑器。安装引导与「站点设置 → 登录方式」共用同一套字段。
 * 密钥只保存在组件内，用于生成 .env 片段，不会写入安装配置。
 */
export function AuthProvidersEditor({
  value,
  onChange,
  secrets,
  onSecretChange,
  idPrefix = 'auth',
  demo = false,
  only,
  showEnv = true,
}: {
  value: AuthSettings;
  onChange: (next: AuthSettings) => void;
  secrets: Partial<Record<AuthProviderId, string>>;
  onSecretChange: (id: AuthProviderId, secret: string) => void;
  idPrefix?: string;
  demo?: boolean;
  /** 只渲染指定的登录方式（登录设置按方式分页时使用）。 */
  only?: AuthProviderId;
  /** 是否显示共享的「服务端环境变量」区块。 */
  showEnv?: boolean;
}) {
  const [envOpen, setEnvOpen] = useState(false);
  const providers = only ? AUTH_PROVIDER_IDS.filter((id) => id === only) : AUTH_PROVIDER_IDS;

  const patch = (id: AuthProviderId, next: Partial<AuthProviderSettings>) => {
    onChange({ ...value, [id]: { ...value[id], ...next } });
  };

  return (
    <div className="auth-providers">
      {providers.map((id) => {
        const meta = PROVIDER_BY_ID[id];
        const item = value[id];
        const ready = providerReady(id, item);
        return (
          <div key={id} className={`auth-provider${item.enabled ? ' is-on' : ''}`}>
            <div className="auth-provider-head">
              <span className="provider-icon">
                <Icon name={meta.icon} size={17} />
              </span>
              <div className="auth-provider-body">
                <strong>{meta.name}</strong>
                <p>{meta.summary}</p>
              </div>
              {item.enabled ? (
                ready ? (
                  <Badge tone="ok" dot>
                    已配置
                  </Badge>
                ) : (
                  <Badge tone="warn">待补齐</Badge>
                )
              ) : (
                <Badge tone="muted">未启用</Badge>
              )}
              <button
                type="button"
                role="switch"
                aria-checked={item.enabled}
                aria-label={`启用${meta.name}登录`}
                className={`switch${item.enabled ? ' is-on' : ''}`}
                onClick={() => patch(id, { enabled: !item.enabled })}
              >
                <span />
              </button>
            </div>

            {item.enabled || only ? (
              <div className="auth-provider-config">
                <div className="form-grid">
                  {meta.fields.map((field) => (
                    <Field
                      key={field.key}
                      label={field.label}
                      htmlFor={`${idPrefix}-${id}-${field.key}`}
                      hint={field.hint}
                    >
                      <Input
                        id={`${idPrefix}-${id}-${field.key}`}
                        value={item[field.key]}
                        placeholder={field.placeholder}
                        maxLength={field.key === 'redirect_uri' ? 500 : 200}
                        onChange={(event) => patch(id, { [field.key]: event.target.value })}
                      />
                    </Field>
                  ))}
                  <Field
                    label={meta.secretLabel}
                    htmlFor={`${idPrefix}-${id}-secret`}
                    hint="只用于生成服务端环境变量，不写入浏览器配置。"
                    aside={secrets[id] ? <Badge tone="accent">仅本次</Badge> : null}
                  >
                    <Input
                      id={`${idPrefix}-${id}-secret`}
                      type="password"
                      value={secrets[id] ?? ''}
                      placeholder={meta.secretPlaceholder}
                      autoComplete="off"
                      onChange={(event) => onSecretChange(id, event.target.value)}
                    />
                  </Field>
                </div>
                <p className="auth-provider-endpoint">
                  服务端端点：<code className="mono">{meta.endpoint}</code>
                </p>
                {!ready ? (
                  <p className="field-hint">
                    填写带 * 的必填项后，前台登录页才会显示这个入口。
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}

      {showEnv ? (
        <div className="auth-env">
          <div className="auth-env-head">
            <div>
              <strong>服务端环境变量</strong>
              <p>
                {demo
                  ? '演示模式不会真的发短信或跳转 OAuth；这份片段用于之后连接真实后端。'
                  : '把这些值交给服务端；密钥留空时会显示占位符，不会被保存。'}
              </p>
            </div>
            <div className="row gap-8">
              <CopyButton value={authEnvSnippet(value, secrets)} label="复制 .env" />
              <button type="button" className="link-btn" onClick={() => setEnvOpen((next) => !next)}>
                {envOpen ? '收起' : '展开'}
              </button>
            </div>
          </div>
          {envOpen ? <pre className="auth-env-code">{authEnvSnippet(value, secrets)}</pre> : null}
          <Callout tone="warn" icon="alert" title="密钥不经过前端保存">
            浏览器的 localStorage 对同域脚本可读。Client Secret、短信 AccessSecret 与 JWT 私钥只应该存在于服务端环境变量，
            这里填写的值仅用于拼接上面的片段。
          </Callout>
        </div>
      ) : null}
    </div>
  );
}
