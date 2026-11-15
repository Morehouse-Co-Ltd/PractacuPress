import type {
  CaptchaScene,
  CaptchaStatus,
  HumanVerificationProvider,
  LocalCaptchaChallenge,
  LocalCaptchaKind,
  LocalCaptchaPoint,
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
 * 的开关只是意图；服务端没有能力校验时它会以「未启用」处理并记警告，此时若前端仍
 * 按开关渲染组件，用户会以为验证生效了——这正是这一版要修掉的谎。
 */

/** 受保护场景，顺序与设置页一致。 */
export const CAPTCHA_SCENES: CaptchaScene[] = ['login', 'register', 'password_reset', 'comment'];

/**
 * 场景对应的组件 action。
 *
 * 第三方组件用它区分表单；本地验证则把 token 绑定到同一个场景名，服务端按它比对，
 * 所以两边必须来自同一份定义。
 */
export function captchaAction(scene: CaptchaScene): string {
  return scene;
}

/**
 * 第三方服务商的脚本地址。
 *
 * 本地（自托管）验证没有外部脚本：题目由本站接口下发，返回空串，调用方不会加载。
 */
export function captchaScriptUrl(provider: HumanVerificationProvider): string {
  switch (provider) {
    case 'turnstile':
      return 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    case 'hcaptcha':
      return 'https://js.hcaptcha.com/1/api.js?render=explicit&hl=zh';
    case 'local':
      return '';
  }
}

/**
 * 服务商是否需要前端 Site Key。
 *
 * 本地验证由本站服务端出题，既没有 Site Key 也不需要 Secret；设置页据此隐藏输入框，
 * 状态端点也不会把「没填 Site Key」当成未配置。
 */
export function captchaProviderNeedsSiteKey(provider: HumanVerificationProvider): boolean {
  return provider !== 'local';
}

/** 脚本加载后挂到 window 上的全局对象名；本地验证没有脚本，空串表示不适用。 */
export const CAPTCHA_GLOBAL: Record<HumanVerificationProvider, string> = {
  turnstile: 'turnstile',
  hcaptcha: 'hcaptcha',
  local: '',
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 收敛服务商字符串。
 *
 * `recaptcha` 是旧版本保存的值：Google reCAPTCHA 已从产品中移除，旧配置一律按
 * Turnstile 处理，行为和旧站点保持一致，而不是让表单失去验证。
 */
export function asProvider(value: unknown): HumanVerificationProvider {
  if (value === 'recaptcha') return 'turnstile';
  return value === 'hcaptcha' || value === 'local' || value === 'turnstile'
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

/** 本地验证的三种题型，顺序与界面轮换一致。 */
export const LOCAL_CAPTCHA_KINDS: LocalCaptchaKind[] = ['slider', 'click', 'select'];

function asLocalKind(value: unknown): LocalCaptchaKind {
  return value === 'click' || value === 'select' || value === 'slider' ? value : 'slider';
}

function asFiniteInt(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 把 `GET /captcha/local/challenge` 的应答收敛成固定形状。
 *
 * 服务端是可信来源，但这个函数仍然补齐缺省值：题型决定读哪些字段，字段缺失时
 * 组件应当显示一块可读的降级提示，而不是在渲染时抛异常、让整个登录页白屏。
 */
export function readLocalCaptchaChallenge(raw: unknown): LocalCaptchaChallenge {
  const source = asObject(raw);
  const kind = asLocalKind(source.kind);
  const challenge: LocalCaptchaChallenge = {
    challenge_id: asText(source.challenge_id),
    kind,
    prompt: asText(source.prompt),
    expires_at: asText(source.expires_at),
    width: asFiniteInt(source.width),
    height: asFiniteInt(source.height),
  };
  if (kind === 'slider') {
    challenge.background = asText(source.background);
    challenge.piece = asText(source.piece);
    challenge.piece_size = asFiniteInt(source.piece_size, 52);
    challenge.piece_top = asFiniteInt(source.piece_top);
    challenge.width = challenge.width || 320;
    challenge.height = challenge.height || 180;
    challenge.max_offset = asFiniteInt(
      source.max_offset,
      Math.max(challenge.width - challenge.piece_size, 0),
    );
  } else {
    challenge.image = asText(source.image);
    challenge.target_count = asFiniteInt(source.target_count, 3);
    const fallback = kind === 'select' ? 288 : 320;
    challenge.width = challenge.width || fallback;
    challenge.height = challenge.height || (kind === 'select' ? 288 : 200);
  }
  if (kind === 'select') {
    challenge.rows = asFiniteInt(source.rows, 3);
    challenge.cols = asFiniteInt(source.cols, 3);
  }
  return challenge;
}

/** 图片在页面上的位置与尺寸，来自 `getBoundingClientRect`。 */
export interface CaptchaRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 把一次点击换算成图片坐标。
 *
 * 图片可能被 CSS 缩小（窄屏），所以坐标必须按「显示尺寸 → 原始像素」的比例换算；
 * 直接提交 `offsetX` 会在手机上偏出目标。越界的点击返回 null，由调用方忽略。
 */
export function captchaPointFromEvent(
  rect: CaptchaRect,
  clientX: number,
  clientY: number,
  naturalWidth: number,
  naturalHeight: number,
): LocalCaptchaPoint | null {
  if (rect.width <= 0 || rect.height <= 0 || naturalWidth <= 0 || naturalHeight <= 0) return null;
  const x = ((clientX - rect.left) * naturalWidth) / rect.width;
  const y = ((clientY - rect.top) * naturalHeight) / rect.height;
  if (x < 0 || y < 0 || x > naturalWidth || y > naturalHeight) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

/** 九宫格题：把一个图片坐标换算成格子序号（行优先）；越界返回 null。 */
export function captchaCellIndex(
  point: LocalCaptchaPoint,
  width: number,
  height: number,
  rows: number,
  cols: number,
): number | null {
  if (width <= 0 || height <= 0 || rows <= 0 || cols <= 0) return null;
  if (point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) return null;
  const col = Math.floor((point.x / width) * cols);
  const row = Math.floor((point.y / height) * rows);
  if (col < 0 || col >= cols || row < 0 || row >= rows) return null;
  return row * cols + col;
}

/**
 * 设置页要提示的环境变量片段。
 *
 * 名字必须和后端 `internal/platform/config` 读的一致，否则站长照着填了也不会生效，
 * 又回到「看起来打开了、其实没校验」的老问题。Site Key 不在这里：它属于站点文档，
 * 保存设置时由服务端接收，只有 Secret 才走环境变量。本地验证完全不需要环境变量。
 */
export function captchaEnvSnippet(provider: HumanVerificationProvider): string {
  if (provider === 'local') {
    return [
      '# the local provider runs inside the API process',
      '# no secret, site key or extra environment variable is required',
      'CAPTCHA_TIMEOUT_SECONDS=5',
    ].join('\n');
  }
  const secret =
    provider === 'hcaptcha' ? 'CAPTCHA_HCAPTCHA_SECRET' : 'CAPTCHA_TURNSTILE_SECRET';
  return [
    '# server environment (apps/api)',
    `${secret}=your-secret-key`,
    'CAPTCHA_TIMEOUT_SECONDS=5',
  ].join('\n');
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
