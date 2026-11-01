import { useMemo, useState } from 'react';
import type { HumanVerificationProvider, HumanVerificationSettings } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import { useTitle } from '../../lib/hooks';
import { DEFAULT_VERIFICATION, useCustomization } from '../../lib/customize';
import { noteActivity } from '../../lib/activity';
import { useToast } from '../../lib/toast';
import { Badge, Button, Callout, CopyButton, Field, Input, Toggle } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';

const PROVIDERS: { value: HumanVerificationProvider; label: string; note: string }[] = [
  { value: 'turnstile', label: 'Cloudflare Turnstile', note: '免费、无感，推荐海外站点使用。' },
  { value: 'hcaptcha', label: 'hCaptcha', note: '隐私友好，可配置难度与主题。' },
  { value: 'recaptcha', label: 'Google reCAPTCHA v2', note: '兼容性最好，国内访问可能受限。' },
];

const SCENES: { key: 'on_login' | 'on_register' | 'on_comment'; label: string; note: string }[] = [
  { key: 'on_login', label: '登录', note: '密码登录与第三方登录入口前验证。' },
  { key: 'on_register', label: '注册', note: '阻止批量注册与脚本注册。' },
  { key: 'on_comment', label: '评论', note: '发评论、回复与点赞前验证。' },
];

/**
 * 站点设置 · 人机验证。
 *
 * 契约没有验证端点，所以这一页保存的是“启用哪家、保护哪些表单”的意图配置；
 * 密钥只用于生成服务端环境变量片段，不会写入安装配置。
 */
export function VerificationPage() {
  useTitle('人机验证');
  const { me, site } = useAuth();
  const backend = useBackend();
  const toast = useToast();
  const { customization, update } = useCustomization();
  const saved = customization.verification;
  const [draft, setDraft] = useState<HumanVerificationSettings>(saved);
  const [secret, setSecret] = useState('');
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const provider = useMemo(
    () => PROVIDERS.find((item) => item.value === draft.provider) ?? PROVIDERS[0],
    [draft.provider],
  );

  const patch = (next: Partial<HumanVerificationSettings>) => setDraft({ ...draft, ...next });

  const save = () => {
    const next: HumanVerificationSettings = {
      ...draft,
      site_key: draft.site_key.trim().slice(0, 200),
    };
    update({ verification: next });
    setDraft(next);
    toast.push(
      'ok',
      '人机验证设置已保存',
      next.enabled
        ? `已启用 ${provider.label}；前台对应表单会显示验证组件。`
        : '人机验证已关闭，前台表单恢复原样。',
    );
    if (me) {
      noteActivity(
        backend,
        me.user.display_name,
        '修改人机验证',
        site?.name ?? '站点',
        next.enabled ? `${provider.label} · ${next.site_key ? '已填 Site Key' : '待填 Site Key'}` : '已关闭',
      );
    }
  };

  const reset = () => {
    update({ verification: DEFAULT_VERIFICATION });
    setDraft(DEFAULT_VERIFICATION);
    toast.push('ok', '已恢复默认人机验证', '关闭验证并回到 Cloudflare Turnstile。');
  };

  const env = [
    'CAPTCHA_ENABLED=' + (draft.enabled ? 'true' : 'false'),
    'CAPTCHA_PROVIDER=' + draft.provider,
    'CAPTCHA_SITE_KEY=' + (draft.site_key || ''),
    'CAPTCHA_SECRET=' + (secret ? '（已填写，仅本次）' : '（服务端保存）'),
  ].join('\n');

  return (
    <RoleGate capability="manage_site" need="站点管理员">
      <div className="admin-page-head">
        <div>
          <h1>人机验证</h1>
          <p>用 CAPTCHA 保护登录、注册与评论；密钥只用于生成服务端环境变量，不写入浏览器配置。</p>
        </div>
        <div className="admin-page-actions">
          <Button size="sm" disabled={!dirty} onClick={save} icon="check">
            保存修改
          </Button>
        </div>
      </div>

      <Callout tone="info" icon="shield" title="前端只负责显示组件">
        契约 v0.1.0 没有验证端点：本页保存的是站点侧配置意图。接入真实后端时，需要服务端提供
        <code className="mono"> POST /api/v1/auth/verify </code>
        校验 token，并在登录 / 注册 / 评论接口上强制校验。
      </Callout>

      <div className="settings-grid mt-20">
        <div className="editor-main">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>验证服务</h3>
                <p>选择服务商并填写前端可见的 Site Key。</p>
              </div>
              <Badge tone={draft.enabled ? 'ok' : 'muted'} dot={draft.enabled}>
                {draft.enabled ? '已启用' : '未启用'}
              </Badge>
            </div>
            <div className="panel-body">
              <div className="form-stack">
                <Toggle
                  checked={draft.enabled}
                  onChange={(enabled) => patch({ enabled })}
                  label="启用站点人机验证"
                  description="关闭时下面的服务与场景配置会保留，但前台不会显示验证组件。"
                />
                <Field label="服务商" hint="三家都使用同样的前端挂载方式，切换只影响脚本与密钥。">
                  <div className="option-grid three">
                    {PROVIDERS.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        className={`option${draft.provider === item.value ? ' is-selected' : ''}`}
                        onClick={() => patch({ provider: item.value })}
                        aria-pressed={draft.provider === item.value}
                      >
                        <span className="option-icon">
                          <Icon name="shield" size={16} />
                        </span>
                        <span className="option-body">
                          <strong>{item.label}</strong>
                          <p>{item.note}</p>
                        </span>
                      </button>
                    ))}
                  </div>
                </Field>
                <div className="form-grid">
                  <Field
                    label="Site Key"
                    htmlFor="verification-site-key"
                    hint="会写进页面脚本，可以公开；不要填 Secret。"
                  >
                    <Input
                      id="verification-site-key"
                      value={draft.site_key}
                      maxLength={200}
                      placeholder="0x4AAAAAAA…"
                      onChange={(event) => patch({ site_key: event.target.value })}
                    />
                  </Field>
                  <Field
                    label="Secret Key"
                    htmlFor="verification-secret"
                    hint="只用于生成服务端环境变量，不保存到安装配置。"
                    aside={secret ? <Badge tone="accent">仅本次</Badge> : null}
                  >
                    <Input
                      id="verification-secret"
                      type="password"
                      value={secret}
                      autoComplete="off"
                      placeholder="服务端保存的密钥"
                      onChange={(event) => setSecret(event.target.value)}
                    />
                  </Field>
                </div>
                <Toggle
                  checked={draft.on_login}
                  onChange={(on_login) => patch({ on_login })}
                  label="登录时验证"
                  description="邮箱密码登录与第三方登录入口。"
                />
                <Toggle
                  checked={draft.on_register}
                  onChange={(on_register) => patch({ on_register })}
                  label="注册时验证"
                  description="阻止批量注册与脚本注册。"
                />
                <Toggle
                  checked={draft.on_comment}
                  onChange={(on_comment) => patch({ on_comment })}
                  label="评论时验证"
                  description="发评论与回复前验证；已经登录的读者也会被检查。"
                />
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>服务端环境变量</h3>
                <p>交给服务端后由后端在对应接口上校验 token。</p>
              </div>
              <CopyButton value={env} label="复制 .env" />
            </div>
            <div className="panel-body">
              <pre className="auth-env-code">{env}</pre>
              <p className="field-hint">
                密钥不会写入 localStorage；这里的片段只用于粘贴到服务端环境变量。
              </p>
            </div>
          </section>
        </div>

        <aside className="settings-side">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>当前状态</h3>
                <p>保存后才在前台生效。</p>
              </div>
            </div>
            <div className="panel-body">
              <div className="mini-list">
                <div className="mini-row">
                  <span className="mini-label">服务商</span>
                  <span className="mini-value">{provider.label}</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">Site Key</span>
                  <span className="mini-value">{draft.site_key ? '已填写' : '未填写'}</span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">保护场景</span>
                  <span className="mini-value">
                    {SCENES.filter((item) => draft[item.key]).map((item) => item.label).join(' / ') || '无'}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">服务端</span>
                  <span className="mini-value">待接入校验端点</span>
                </div>
              </div>
            </div>
          </section>

          <div className="danger-zone">
            <h3>恢复默认人机验证</h3>
            <p>关闭验证并回到 Cloudflare Turnstile；不会影响文章、评论或访问限制。</p>
            <Button variant="danger" size="sm" className="mt-12" icon="refresh" onClick={reset}>
              恢复默认
            </Button>
          </div>
        </aside>
      </div>

      <div className="row gap-8 mt-20">
        <Button disabled={!dirty} onClick={save} icon="check">
          保存修改
        </Button>
        {dirty ? (
          <Button variant="ghost" onClick={() => setDraft(saved)}>
            放弃未保存的修改
          </Button>
        ) : (
          <span className="tiny faint">没有未保存的修改</span>
        )}
      </div>
    </RoleGate>
  );
}
