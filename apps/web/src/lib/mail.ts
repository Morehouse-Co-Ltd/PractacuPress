import type { MailEncryption, MailSettings, WebConfig } from '../types';
import { t } from './i18n';

/**
 * 服务端邮件（SMTP）设置。
 *
 * 与登录方式同一套约定：非机密字段存在安装配置里方便回填表单，密码只在本次会话
 * 里用于生成 .env 片段，绝不写入 localStorage。真实能否发信由服务端说了算，
 * 前端只通过 GET /auth/password-reset/policy 得知结果。
 */

export const DEFAULT_MAIL: MailSettings = {
  enabled: true,
  host: '',
  port: '',
  encryption: 'starttls',
  username: '',
  from: '',
  from_name: 'Practacu Press',
  public_base_url: '',
};

export const ENCRYPTION_OPTIONS: { value: MailEncryption; label: string; port: string }[] = [
  { value: 'starttls', label: t('STARTTLS（推荐）'), port: '587' },
  { value: 'ssl', label: 'SSL / TLS', port: '465' },
  { value: 'none', label: t('不加密'), port: '25' },
];

export function defaultPortFor(encryption: MailEncryption): string {
  return ENCRYPTION_OPTIONS.find((item) => item.value === encryption)?.port ?? '587';
}

function text(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** 把旧配置或导入的配置收敛成完整结构。 */
export function readMailSettings(config: Pick<WebConfig, 'mail'>): MailSettings {
  const raw = config.mail;
  const encryption: MailEncryption =
    raw?.encryption === 'ssl' || raw?.encryption === 'none' ? raw.encryption : 'starttls';
  return {
    enabled: raw?.enabled !== false,
    host: text(raw?.host),
    port: text(raw?.port, 5),
    encryption,
    username: text(raw?.username, 320),
    from: text(raw?.from, 320),
    from_name: text(raw?.from_name, 120) || DEFAULT_MAIL.from_name,
    public_base_url: text(raw?.public_base_url, 500),
  };
}

/** 非机密字段是否齐全。密码与真实连通性只能在服务端验证。 */
export function mailSettingsReady(mail: MailSettings): boolean {
  return mail.host.trim().length > 0 && mail.from.trim().length > 0;
}

/** 生成服务端环境变量片段；密码只在本次会话里拼进去。 */
export function smtpEnvSnippet(mail: MailSettings, password = ''): string {
  const lines = [
    t('# 由 Practacu Press 的「登录设置 → 邮件通知」生成'),
    t('# 这些值属于服务端环境变量，不要提交到仓库'),
    '',
  ];
  if (!mail.host.trim()) {
    lines.push(t('# 还没有填写 SMTP 主机，找回密码暂时不可用'));
    return lines.join('\n');
  }

  lines.push(`SMTP_HOST=${mail.host.trim()}`);
  lines.push(`SMTP_PORT=${(mail.port || defaultPortFor(mail.encryption)).trim()}`);
  lines.push(`SMTP_ENCRYPTION=${mail.encryption}`);
  if (mail.username.trim()) {
    lines.push(`SMTP_USERNAME=${mail.username.trim()}`);
    lines.push(`SMTP_PASSWORD=${password.trim() || t('<在服务端填写>')}`);
  }
  lines.push(`SMTP_FROM=${mail.from.trim()}`);
  if (mail.from_name.trim()) lines.push(`SMTP_FROM_NAME=${mail.from_name.trim()}`);
  lines.push('');
  lines.push(t('# 绝对链接的前缀；留空时服务端按 https 假定，桌面 / localhost（http）请显式填写 http://127.0.0.1:<端口>'));
  lines.push(`PUBLIC_BASE_URL=${mail.public_base_url.trim() || t('<你的站点地址，例如 https://press.example.com>')}`);
  return lines.join('\n');
}
