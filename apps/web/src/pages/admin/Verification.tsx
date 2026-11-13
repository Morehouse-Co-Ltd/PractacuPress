import { useState } from 'react';
import type { HumanVerificationProvider, HumanVerificationSettings } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { DEFAULT_VERIFICATION, useCustomization } from '../../lib/customize';
import { noteActivity } from '../../lib/activity';
import { useToast } from '../../lib/toast';
import { useT } from '../../lib/i18n';
import { captchaEnvSnippet, readCaptchaStatus } from '../../lib/captcha';
import { clearCaptchaStatusCache } from '../../components/Captcha';
import { Badge, Button, Callout, CopyButton, Field, Input, Toggle } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';
import { EffectCards, type EffectCardItem } from '../../components/EffectCards';

type Translator = ReturnType<typeof useT>;
type SceneKey = 'on_login' | 'on_register' | 'on_comment' | 'on_password_reset';

function providerChoices(t: Translator): { value: HumanVerificationProvider; label: string; note: string }[] {
  return [
    { value: 'turnstile', label: 'Cloudflare Turnstile', note: t('免费、无感，推荐海外站点使用。') },
    { value: 'hcaptcha', label: 'hCaptcha', note: t('隐私友好，可配置难度与主题。') },
    { value: 'recaptcha', label: 'Google reCAPTCHA', note: t('兼容性最好，国内访问可能受限。') },
  ];
}

function sceneChoices(t: Translator): { key: SceneKey; label: string; note: string }[] {
  return [
    { key: 'on_login', label: t('登录'), note: t('邮箱密码登录前验证。') },
    { key: 'on_register', label: t('注册'), note: t('阻止批量注册与脚本注册。') },
    { key: 'on_comment', label: t('评论'), note: t('发评论与回复前验证。') },
    { key: 'on_password_reset', label: t('找回密码'), note: t('发送重置链接前验证。') },
  ];
}

/**
 * 站点设置 · 人机验证。
 *
 * 这一页保存的是站点意图（启用哪家、保护哪些表单、公开的 Site Key）。真正的校验
 * 发生在登录 / 注册 / 找回密码 / 评论接口上：token 一次性，所以没有「先校验再提交」
 * 的独立端点。Secret 只存在于服务端环境变量，页面上的状态卡读的是服务端真实状态，
 * 不是本地的开关——避免出现「开关打开了、其实没校验」的旧问题。
 */
export function VerificationPage() {
  const t = useT();
  useTitle(t('人机验证'));
  const { me, site } = useAuth();
  const backend = useBackend();
  const toast = useToast();
  const { customization, update } = useCustomization();
  const saved = customization.verification;
  const [draft, setDraft] = useState<HumanVerificationSettings>(saved);
  const [secret, setSecret] = useState('');
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const providers = providerChoices(t);
  const scenes = sceneChoices(t);
  const provider = providers.find((item) => item.value === draft.provider) ?? providers[0];

  // 服务端真实状态：Secret 是否配置、哪些场景真的会校验。
  const status = useAsync(
    async () => (await backend.captchaStatus?.()) ?? readCaptchaStatus(null),
    [backend],
  );
  const serverReady = status.data?.server_configured === true;
  const enforced = status.data?.effective === true;
  const statusUnreadable = !!status.error;

  const patch = (next: Partial<HumanVerificationSettings>) => setDraft({ ...draft, ...next });

  /**
   * 重新读服务端状态。
   *
   * 站点文档的保存是 800ms 尾随防抖，立刻读会拿到保存前的文档；所以先读一次让
   * 界面不必空等，再在防抖窗口之后读一次，拿到真正保存后的状态。
   */
  const refreshStatus = () => {
    clearCaptchaStatusCache();
    status.reload();
  };
  const refreshStatusAfterSave = () => {
    refreshStatus();
    window.setTimeout(refreshStatus, 1400);
  };

  const save = () => {
    const next: HumanVerificationSettings = {
      ...draft,
      site_key: draft.site_key.trim().slice(0, 200),
    };
    update({ verification: next });
    setDraft(next);
    // 服务端执行的是站点文档里的配置；保存后重新读一次真实状态，并让前台表单
    // 丢掉可能还写着「未启用」的短期缓存。
    refreshStatusAfterSave();
    toast.push(
      'ok',
      t('人机验证设置已保存'),
      next.enabled
        ? serverReady
          ? t('已启用 {provider}；前台对应表单会显示验证组件。', { provider: provider.label })
          : t('配置已保存，但服务端还没有 {provider} 的 Secret，暂时不会校验。', {
              provider: provider.label,
            })
        : t('人机验证已关闭，前台表单恢复原样。'),
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
    refreshStatusAfterSave();
    toast.push('ok', t('已恢复默认人机验证'), t('关闭验证并回到 Cloudflare Turnstile。'));
  };

  const env = captchaEnvSnippet(draft.provider);

  const protectedScenes = scenes
    .filter((item) => draft[item.key])
    .map((item) => item.label)
    .join(' / ');

  const statusCards: EffectCardItem[] = [
    {
      icon: 'shield',
      label: t('服务商'),
      value: provider.label,
      note: t('当前验证服务'),
    },
    {
      icon: 'check-circle',
      label: t('状态'),
      value: draft.enabled ? t('已启用') : t('未启用'),
      note: t('站点级开关'),
    },
    {
      icon: 'lock',
      label: 'Site Key',
      value: draft.site_key ? t('已填写') : t('未填写'),
      note: t('前端可见'),
    },
    {
      icon: 'layers',
      label: t('保护场景'),
      value: protectedScenes || t('无'),
      note: t('登录 / 注册 / 评论 / 找回密码'),
    },
    {
      icon: 'server',
      label: t('服务端'),
      value: statusUnreadable ? t('读取失败') : serverReady ? t('已配置密钥') : t('未配置密钥'),
      note: status.loading ? t('正在读取服务端状态…') : t('按服务端实际配置'),
    },
  ];

  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('人机验证')}</h1>
          <p>{t('用 CAPTCHA 保护登录、注册、找回密码与评论；密钥只保存在服务端环境变量。')}</p>
        </div>
        <div className="admin-page-actions">
          <Button size="sm" disabled={!dirty} onClick={save} icon="check">
            {t('保存修改')}
          </Button>
        </div>
      </div>

      <Callout tone="info" icon="shield" title={t('校验发生在接口上')}>
        {t(
          '人机验证由登录、注册、找回密码与评论接口执行；验证 token 只能使用一次，所以没有单独的校验端点。开启后前台表单会显示对应服务商的组件，服务端没有 Secret 时不会校验、也不会显示组件。',
        )}
      </Callout>

      {statusUnreadable ? (
        <Callout tone="warn" icon="alert" title={t('读不到服务端状态')}>
          {t('服务端没有回答人机验证状态；保存仍然可用，但这里无法确认校验是否真的生效。请稍后点「刷新状态」。')}
        </Callout>
      ) : null}

      {draft.enabled && !serverReady && !statusUnreadable ? (
        <Callout
          tone="warn"
          icon="alert"
          title={t('服务端还没有这个服务商的密钥')}
        >
          {t(
            '把下面片段里的 {env} 加进服务端环境变量并重启，验证才会真正生效；在此之前前台不会显示组件。',
            { env: draft.provider === 'hcaptcha' ? 'CAPTCHA_HCAPTCHA_SECRET' : draft.provider === 'recaptcha' ? 'CAPTCHA_RECAPTCHA_SECRET' : 'CAPTCHA_TURNSTILE_SECRET' },
          )}
        </Callout>
      ) : null}

      <div className="editor-main mt-20">
        <section className="panel effect-overview">
          <div className="panel-head">
            <div>
              <h3>{t('当前状态')}</h3>
              <p>{t('按当前编辑实时汇总；服务端一栏读取的是真实配置。')}</p>
            </div>
            <div className="row gap-8" style={{ alignItems: 'center' }}>
              <Button size="sm" variant="ghost" icon="refresh" onClick={refreshStatus}>
                {t('刷新状态')}
              </Button>
              <Badge tone={enforced ? 'ok' : 'muted'} dot={enforced}>
                {enforced ? t('校验已生效') : draft.enabled ? t('待配置密钥') : t('未启用')}
              </Badge>
            </div>
          </div>
          <div className="panel-body">
            <EffectCards items={statusCards} columns={5} />
          </div>
        </section>

        <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('验证服务')}</h3>
                <p>{t('选择服务商并填写前端可见的 Site Key。')}</p>
              </div>
              <Badge tone={draft.enabled ? 'ok' : 'muted'} dot={draft.enabled}>
                {draft.enabled ? t('已启用') : t('未启用')}
              </Badge>
            </div>
            <div className="panel-body">
              <div className="form-stack">
                <Toggle
                  checked={draft.enabled}
                  onChange={(enabled) => patch({ enabled })}
                  label={t('启用站点人机验证')}
                  description={t('关闭时下面的服务与场景配置会保留，但前台不会显示验证组件。')}
                />
                <Field label={t('服务商')} hint={t('三家都使用同样的前端挂载方式，切换只影响脚本与密钥。')}>
                  <div className="option-grid three">
                    {providers.map((item) => (
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
                {draft.provider === 'recaptcha' ? (
                  <Field
                    label={t('reCAPTCHA 模式')}
                    hint={t('v2 显示复选框，兼容性最好；v3 无感评分，需要服务端设置分数阈值。')}
                  >
                    <div className="option-grid two">
                      {(['v2', 'v3'] as const).map((version) => (
                        <button
                          key={version}
                          type="button"
                          className={`option${draft.recaptcha_version === version ? ' is-selected' : ''}`}
                          onClick={() => patch({ recaptcha_version: version })}
                          aria-pressed={draft.recaptcha_version === version}
                        >
                          <span className="option-body">
                            <strong>{version.toUpperCase()}</strong>
                            <p>
                              {version === 'v2'
                                ? t('可见复选框，token 由用户点击产生。')
                                : t('无感执行，按场景 action 取 token，低分会被服务端拒绝。')}
                            </p>
                          </span>
                        </button>
                      ))}
                    </div>
                  </Field>
                ) : null}
                <div className="form-grid">
                  <Field
                    label="Site Key"
                    htmlFor="verification-site-key"
                    hint={t('会写进页面脚本，可以公开；不要填 Secret。')}
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
                    hint={t('不会保存；只用来生成下面的服务端环境变量片段。')}
                    aside={secret ? <Badge tone="accent">{t('仅本次')}</Badge> : null}
                  >
                    <Input
                      id="verification-secret"
                      type="password"
                      value={secret}
                      autoComplete="off"
                      placeholder={t('服务端保存的密钥')}
                      onChange={(event) => setSecret(event.target.value)}
                    />
                  </Field>
                </div>
                <Toggle
                  checked={draft.on_login}
                  onChange={(on_login) => patch({ on_login })}
                  label={t('登录时验证')}
                  description={t('每次邮箱密码登录。两步验证的第二步只在登录接口上校验一次。')}
                />
                <Toggle
                  checked={draft.on_register}
                  onChange={(on_register) => patch({ on_register })}
                  label={t('注册时验证')}
                  description={t('阻止批量注册与脚本注册。')}
                />
                <Toggle
                  checked={draft.on_comment}
                  onChange={(on_comment) => patch({ on_comment })}
                  label={t('评论时验证')}
                  description={t('发评论与回复前验证；已经登录的读者也会被检查。')}
                />
                <Toggle
                  checked={draft.on_password_reset}
                  onChange={(on_password_reset) => patch({ on_password_reset })}
                  label={t('找回密码时验证')}
                  description={t('发送重置链接前验证，避免被用来刷邮件。')}
                />
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('服务端环境变量')}</h3>
                <p>{t('复制到服务端并重启后，接口才会真正校验 token。')}</p>
              </div>
              <CopyButton value={env} label={t('复制 .env')} />
            </div>
            <div className="panel-body">
              <pre className="auth-env-code">{env}</pre>
              <p className="field-hint">
                {t(
                  'Site Key 随站点设置保存在服务端文档里；只有 Secret 走环境变量。组件脚本从服务商 CDN 加载，离线或网络受限时显示不出来，表单会给出可读提示。',
                )}
              </p>
            </div>
          </section>
        <div className="row gap-8">
          <Button disabled={!dirty} onClick={save} icon="check">
            {t('保存修改')}
          </Button>
          {dirty ? (
            <Button variant="ghost" onClick={() => setDraft(saved)}>
              {t('放弃未保存的修改')}
            </Button>
          ) : (
            <span className="tiny faint">{t('没有未保存的修改')}</span>
          )}
        </div>

        <div className="danger-zone">
          <h3>{t('恢复默认人机验证')}</h3>
          <p>{t('关闭验证并回到 Cloudflare Turnstile；不会影响文章、评论或访问限制。')}</p>
          <Button variant="danger" size="sm" className="mt-12" icon="refresh" onClick={reset}>
            {t('恢复默认')}
          </Button>
        </div>
      </div>
    </RoleGate>
  );
}
