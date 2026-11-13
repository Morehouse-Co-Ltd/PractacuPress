import type {
  CaptchaScene,
  CaptchaStatus,
  HumanVerificationProvider,
  RecaptchaVersion,
} from '../types';

/**
 * 人机验证的前端规则。
 *
 * 这个模块只做纯计算与常量，不碰 DOM、不发请求，所以能直接单测：
 *
 * - 服务端状态怎么读（`readCaptchaStatus`）；
 * - 某个表单要不要挂组件（`captchaSceneRequired`）；
 * - 组件脚本地址与全局名（`captchaScriptUrl`、`CAPTCHA_GLOBAL`）；
 * - 设置页要展示的环境变量名（`captchaEnvSnippet`）。
 *
 * 「要不要显示组件」只有一个来源：`GET /captcha/status` 的 `effective`。站点设置里
 * 的开关只是意图；服务端没有 Secret 时它会以「未启用」处理并记警告，此时若前端仍
 * 按开关渲染组件，用户会以为验证生效了——这正是这一版要修掉的谎。
 */

/** 受保护场景，顺序与设置页一致。 */
export const CAPTCHA_SCENES: CaptchaScene[] = ['login', 'register', 'password_reset', 'comment'];

/**
 * 场景对应的 reCAPTCHA v3 action。
 *
 * 服务端会用同一个字符串校验 `action`，所以两边必须来自同一份定义：前端执行
 * `grecaptcha.execute(key, { action })`，服务端比对响应里的 action 是否等于场景名。
 */
export function captchaAction(scene: CaptchaScene): string {
  return scene;
}

/** 各服务商的脚本地址。脚本都来自服务商 CDN，这是这条路的固定代价。 */
export function captchaScriptUrl(
  provider: HumanVerificationProvider,
  siteKey: string,
  version: RecaptchaVersion = 'v2',
): string {
  switch (provider) {
    case 'turnstile':
      return 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    case 'hcaptcha':
      return 'https://js.hcaptcha.com/1/api.js?render=explicit&hl=zh';
    case 'recaptcha':
      return version === 'v3'
        ? `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}&hl=zh-CN`
        : 'https://www.google.com/recaptcha/api.js?render=explicit&hl=zh-CN';
  }
}

/** 脚本加载后挂到 window 上的全局对象名。 */
export const CAPTCHA_GLOBAL: Record<HumanVerificationProvider, string> = {
  turnstile: 'turnstile',
  hcaptcha: 'hcaptcha',
  recaptcha: 'grecaptcha',
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asProvider(value: unknown): HumanVerificationProvider {
  return value === 'hcaptcha' || value === 'recaptcha' || value === 'turnstile'
    ? value
    : 'turnstile';
}

/**
 * 读服务端状态。
 *
 * 缺失或形状不对时按「不验证」处理：让登录页在没有状态端点时不至于崩，也不会
 * 画出一个服务端并不校验的组件。旧版本服务端没有该端点时走同一条降级路径。
 */
export function readCaptchaStatus(raw: unknown): CaptchaStatus {
  const source = asObject(raw);
  const scenesRaw = asObject(source.scenes);
  const scenes = {} as Record<CaptchaScene, boolean>;
  for (const scene of CAPTCHA_SCENES) {
    scenes[scene] = scenesRaw[scene] === true;
  }
  return {
    enabled: source.enabled === true,
    provider: asProvider(source.provider),
    site_key: typeof source.site_key === 'string' ? source.site_key : '',
    scenes,
    server_configured: source.server_configured === true,
    effective: source.effective === true,
    checked_at: typeof source.checked_at === 'string' ? source.checked_at : '',
  };
}

/** 某个场景当前是否真的要挂组件。 */
export function captchaSceneRequired(status: CaptchaStatus | null, scene: CaptchaScene): boolean {
  if (!status || !status.effective) return false;
  return status.scenes[scene] === true;
}

/**
 * 设置页要提示的环境变量片段。
 *
 * 名字必须和后端 `internal/platform/config` 读的一致，否则站长照着填了也不会生效，
 * 又回到「看起来打开了、其实没校验」的老问题。Site Key 不在这里：它属于站点文档，
 * 保存设置时由服务端接收，只有 Secret 才走环境变量。
 */
export function captchaEnvSnippet(provider: HumanVerificationProvider): string {
  const secret =
    provider === 'hcaptcha'
      ? 'CAPTCHA_HCAPTCHA_SECRET'
      : provider === 'recaptcha'
        ? 'CAPTCHA_RECAPTCHA_SECRET'
        : 'CAPTCHA_TURNSTILE_SECRET';
  const lines = [
    '# server environment (apps/api)',
    `${secret}=your-secret-key`,
    'CAPTCHA_TIMEOUT_SECONDS=5',
  ];
  if (provider === 'recaptcha') {
    // v3 按这个阈值拒绝低分 token；v2 的应答没有 score，这一项不会被用到。
    lines.push('CAPTCHA_RECAPTCHA_MIN_SCORE=0.5');
  }
  return lines.join('\n');
}

/**
 * 校验失败原因 → 一句可读说明。
 *
 * 服务端把稳定的 `details.reason` 放在 problem 里；这里把每个值翻成一句话，未知
 * 原因返回空串交给调用方兜底（显示服务端 message 或通用失败文案）。
 */
export function captchaReasonText(
  reason: string | undefined,
  t: (text: string) => string,
): string {
  switch (reason) {
    case 'captcha_required':
      return t('请先完成人机验证。');
    case 'captcha_invalid':
    case 'captcha_score_too_low':
    case 'captcha_action_mismatch':
      return t('人机验证没有通过，请重新验证后再试。');
    case 'captcha_replayed':
      return t('这次验证已经用过了，请重新验证。');
    case 'captcha_unavailable':
      return t('人机验证服务暂时连不上，请稍后重试。');
    case 'captcha_policy_unavailable':
      return t('站点暂时无法读取验证设置，请稍后重试。');
    default:
      return '';
  }
}
