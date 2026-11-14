import type {
  AuthProviderId,
  AuthProviderSettings,
  AuthSettings,
  WebConfig,
} from '../types';
import type { IconName } from '../components/Icon';
import { t } from './i18n';
import { liveCatalog } from './i18n/live';

/**
 * 邮箱之外的登录方式（手机验证码、Google、GitHub、微信）。
 *
 * 契约 v0.1.0 只有邮箱注册与密码登录，没有短信或 OAuth 端点。因此这里保存的是
 * “站点希望开放哪些方式 + 非机密参数”，并据此生成服务端 .env 片段；
 * Client Secret / 短信密钥不会写入 localStorage，也不应该由前端持有。
 */

export const AUTH_PROVIDER_IDS: AuthProviderId[] = [
  'phone',
  'google',
  'github',
  'wechat',
  'qq',
  'authenticator',
];

export interface ProviderField {
  key: 'client_id' | 'redirect_uri' | 'extra' | 'note';
  label: string;
  placeholder: string;
  hint?: string;
  required?: boolean;
  /** select 字段用于固定枚举（例如短信服务商）；缺省为文本输入。 */
  type?: 'text' | 'select';
  options?: { value: string; label: string }[];
}

export interface ProviderMeta {
  id: AuthProviderId;
  name: string;
  icon: IconName;
  summary: string;
  detail: string;
  /** 非机密字段。 */
  fields: ProviderField[];
  /** 只写进 .env，不落浏览器。 */
  secretLabel: string;
  secretPlaceholder: string;
  endpoint: string;
}

const RAW_PROVIDER_META: ProviderMeta[] = [
  {
    id: 'phone',
    name: t('手机验证码'),
    icon: 'message',
    summary: t('用手机号与短信验证码登录。'),
    detail: t('需要短信服务商、签名与模板，密钥只存服务端。'),
    fields: [
      {
        key: 'note',
        label: t('短信服务商'),
        placeholder: 'tencent',
        type: 'select',
        options: [
          { value: 'tencent', label: t('腾讯云短信') },
          { value: 'aliyun', label: t('阿里云短信') },
          { value: 'smsbao', label: t('短信宝') },
        ],
        hint: t('接入哪家服务商只决定服务端用哪套签名算法；密钥仍只存服务端。'),
      },
      {
        key: 'client_id',
        label: t('短信签名'),
        placeholder: 'Practacu',
        required: true,
      },
      {
        key: 'extra',
        label: t('模板编号'),
        placeholder: 'SMS_000000',
        required: true,
        hint: t('验证码模板，例如「您的验证码是 ${code}，5 分钟内有效」。'),
      },
    ],
    secretLabel: 'AccessSecret',
    secretPlaceholder: t('短信服务商 AccessSecret'),
    endpoint: 'POST /api/v1/auth/phone/code · POST /api/v1/auth/phone/verify',
  },
  {
    id: 'google',
    name: 'Google',
    icon: 'globe',
    summary: t('用 Google 账户授权登录。'),
    detail: t('需要 OAuth 客户端与已登记的回调地址。'),
    fields: [
      { key: 'client_id', label: 'Client ID', placeholder: '000000000000-xxxx.apps.googleusercontent.com', required: true },
      {
        key: 'redirect_uri',
        label: t('回调地址'),
        placeholder: 'https://press.example.com/api/v1/auth/oauth/google/callback',
        hint: t('必须与 Google Cloud Console 里登记的完全一致。'),
      },
      { key: 'extra', label: 'Scope', placeholder: 'openid email profile' },
    ],
    secretLabel: 'Client Secret',
    secretPlaceholder: 'GOCSPX-...',
    endpoint: 'GET /api/v1/auth/oauth/google/start',
  },
  {
    id: 'github',
    name: 'GitHub',
    icon: 'code',
    summary: t('用 GitHub 账户授权登录。'),
    detail: t('适合技术站点；需要 OAuth App。'),
    fields: [
      { key: 'client_id', label: 'Client ID', placeholder: 'Iv1.xxxxxxxxxxxx', required: true },
      {
        key: 'redirect_uri',
        label: t('回调地址'),
        placeholder: 'https://press.example.com/api/v1/auth/oauth/github/callback',
      },
      { key: 'extra', label: 'Scope', placeholder: 'read:user user:email' },
    ],
    secretLabel: 'Client Secret',
    secretPlaceholder: 'GitHub OAuth App Secret',
    endpoint: 'GET /api/v1/auth/oauth/github/start',
  },
  {
    id: 'wechat',
    name: t('微信'),
    icon: 'message',
    summary: t('用微信扫码或公众号授权登录。'),
    detail: t('需要开放平台网站应用或公众号网页授权。'),
    fields: [
      { key: 'client_id', label: 'AppID', placeholder: 'wx0000000000000000', required: true },
      {
        key: 'redirect_uri',
        label: t('回调地址'),
        placeholder: 'https://press.example.com/api/v1/auth/oauth/wechat/callback',
      },
      { key: 'extra', label: 'Scope', placeholder: 'snsapi_login' },
      { key: 'note', label: t('账号类型'), placeholder: t('开放平台网站应用 / 公众号') },
    ],
    secretLabel: 'AppSecret',
    secretPlaceholder: t('微信 AppSecret'),
    endpoint: 'GET /api/v1/auth/oauth/wechat/start',
  },
  {
    id: 'qq',
    name: 'QQ',
    icon: 'message',
    summary: t('用 QQ 账户授权登录。'),
    detail: t('需要在 QQ 互联创建网站应用，并登记回调地址。'),
    fields: [
      { key: 'client_id', label: t('AppID'), placeholder: '101000000', required: true },
      {
        key: 'redirect_uri',
        label: t('回调地址'),
        placeholder: 'https://press.example.com/api/v1/auth/oauth/qq/callback',
        hint: t('必须与 QQ 互联后台登记的回调地址完全一致。'),
      },
      { key: 'extra', label: 'Scope', placeholder: 'get_user_info' },
    ],
    secretLabel: 'AppKey',
    secretPlaceholder: t('QQ 互联 AppKey'),
    endpoint: 'GET /api/v1/auth/oauth/qq/start',
  },
  {
    id: 'authenticator',
    name: t('身份验证器'),
    icon: 'shield',
    summary: t('用身份验证器 App 的动态验证码登录。'),
    detail: t('基于 TOTP；用户需要先在账户安全里绑定身份验证器。'),
    fields: [
      { key: 'note', label: t('发行方名称'), placeholder: 'Practacu Press' },
      { key: 'extra', label: t('动态码位数'), placeholder: '6' },
    ],
    secretLabel: t('服务端加密密钥'),
    secretPlaceholder: t('只在服务端配置'),
    endpoint: 'POST /api/v1/auth/authenticator/verify',
  },
];

/** 目录中文在读取时翻译，切换语言后立即生效（见 i18n/live.ts）。 */
export const PROVIDER_META = liveCatalog(RAW_PROVIDER_META);

export const PROVIDER_BY_ID: Record<AuthProviderId, ProviderMeta> = PROVIDER_META.reduce(
  (acc, item) => ({ ...acc, [item.id]: item }),
  {} as Record<AuthProviderId, ProviderMeta>,
);

function emptyProvider(): AuthProviderSettings {
  return { enabled: false, client_id: '', redirect_uri: '', extra: '', note: '' };
}

export const DEFAULT_AUTH: AuthSettings = {
  phone: emptyProvider(),
  google: emptyProvider(),
  github: emptyProvider(),
  wechat: emptyProvider(),
  qq: emptyProvider(),
  authenticator: emptyProvider(),
};

function text(value: unknown, max = 400): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** 把旧配置或导入的配置收敛成完整结构。 */
export function readAuthSettings(config: Pick<WebConfig, 'auth'>): AuthSettings {
  const raw = config.auth;
  const read = (id: AuthProviderId): AuthProviderSettings => {
    const source = raw?.[id];
    return {
      enabled: source?.enabled === true,
      client_id: text(source?.client_id),
      redirect_uri: text(source?.redirect_uri, 500),
      extra: text(source?.extra, 200),
      note: text(source?.note, 160),
    };
  };
  return {
    phone: read('phone'),
    google: read('google'),
    github: read('github'),
    wechat: read('wechat'),
    qq: read('qq'),
    authenticator: read('authenticator'),
  };
}

/** 必填的非机密字段是否齐全。密钥无法在前端校验。 */
export function providerReady(id: AuthProviderId, settings: AuthProviderSettings): boolean {
  if (!settings.enabled) return false;
  const meta = PROVIDER_BY_ID[id];
  return meta.fields
    .filter((field) => field.required)
    .every((field) => settings[field.key].trim().length > 0);
}

export function enabledProviders(settings: AuthSettings): AuthProviderId[] {
  return AUTH_PROVIDER_IDS.filter((id) => settings[id].enabled);
}

export function activeProviders(settings: AuthSettings): AuthProviderId[] {
  return AUTH_PROVIDER_IDS.filter((id) => providerReady(id, settings[id]));
}

export function providerEndpoint(id: AuthProviderId): string {
  return PROVIDER_BY_ID[id].endpoint;
}

/** 生成服务端环境变量片段；密钥只在本次会话里拼进去，不会被保存。 */
export function authEnvSnippet(
  settings: AuthSettings,
  secrets: Partial<Record<AuthProviderId, string>> = {},
): string {
  const lines: string[] = [
    t('# 由 Practacu Press 安装引导生成'),
    t('# 机密值只写到服务端环境变量，不要提交到仓库'),
  ];
  for (const id of AUTH_PROVIDER_IDS) {
    const item = settings[id];
    if (!item.enabled) continue;
    const meta = PROVIDER_BY_ID[id];
    const prefix = id.toUpperCase();
    lines.push('');
    lines.push(`# ${meta.name}`);
    lines.push(`AUTH_${prefix}_ENABLED=true`);
    if (item.client_id) {
      lines.push(
        `${id === 'wechat' ? 'WECHAT_APP_ID' : id === 'phone' ? 'SMS_SIGN_NAME' : id === 'qq' ? 'QQ_APP_ID' : `${prefix}_CLIENT_ID`}=${item.client_id}`,
      );
    }
    if (id === 'phone') {
      if (item.note) lines.push(`SMS_PROVIDER=${item.note}`);
      if (item.extra) lines.push(`SMS_TEMPLATE_CODE=${item.extra}`);
      lines.push(`SMS_ACCESS_KEY_ID=${t('<在服务端填写>')}`);
      lines.push(`SMS_ACCESS_SECRET=${secrets.phone?.trim() || t('<在服务端填写>')}`);
    } else if (id === 'authenticator') {
      if (item.note) lines.push(`TOTP_ISSUER=${item.note}`);
      if (item.extra) lines.push(`TOTP_DIGITS=${item.extra}`);
      lines.push(`TOTP_ENCRYPTION_KEY=${secrets.authenticator?.trim() || t('<在服务端填写>')}`);
    } else {
      if (item.redirect_uri) lines.push(`${prefix}_REDIRECT_URI=${item.redirect_uri}`);
      if (item.extra) lines.push(`${prefix}_SCOPE=${item.extra}`);
      const secretKey =
        id === 'wechat'
          ? 'WECHAT_APP_SECRET'
          : id === 'qq'
            ? 'QQ_APP_KEY'
            : `${prefix}_CLIENT_SECRET`;
      lines.push(`${secretKey}=${secrets[id]?.trim() || t('<在服务端填写>')}`);
    }
  }
  if (lines.length === 2) lines.push('', t('# 暂未启用邮箱之外的登录方式'));
  return lines.join('\n');
}
