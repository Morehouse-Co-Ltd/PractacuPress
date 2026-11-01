import type { DomainSettings, TlsSettings, WebConfig } from '../types';
import { settingBool, settingList, settingText } from './settings';

/**
 * 域名绑定白名单。
 *
 * 浏览器只能决定“当前域名要不要展示站点”，它不是一个安全边界：真正的绑定由
 * DNS 和反向代理的 `server_name` 完成。后台「访问与域名」页会生成可直接部署的
 * Nginx 片段；别名域名访问 API 时由代理把 Host 改写成主域名，避免服务端按
 * 主机名解析站点时把别名当成未知站点。
 *
 * 没有设置主域名时，生产环境只允许公网 IP 直连（localhost 例外仅用于本机管理）。
 */

export const DEFAULT_TLS: TlsSettings = {
  mode: 'off',
  email: '',
  cert_path: '',
  key_path: '',
  hsts: false,
};

export const DEFAULT_DOMAINS: DomainSettings = {
  enabled: false,
  primary: '',
  aliases: [],
  allow_www: true,
  allow_localhost: true,
  allow_ip: true,
  redirect_primary: false,
  https_only: false,
  tls: DEFAULT_TLS,
  cors_origins: [],
  cookie_domain: '',
  trusted_proxies: [],
};

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function isIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

export function isIpHost(value: string): boolean {
  const host = value.replace(/^\[|\]$/g, '');
  if (isIpv4(host)) return true;
  // IPv6 字面量：至少两个冒号，只允许十六进制与冒号。
  return host.includes(':') && /^[0-9a-f:]+$/i.test(host) && (host.match(/:/g)?.length ?? 0) >= 2;
}

/**
 * 判断 host 是不是“公网 IP”。
 *
 * 没有域名时，生产环境只接受公网 IP 的 Host；回环、内网、链路本地、CGNAT、
 * 组播与保留地址都按“非公网”处理。localhost 由单独开关放行，方便本机管理。
 */
export function isPublicIp(value: string): boolean {
  const host = value.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (isIpv4(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a >= 224) return false; // 组播与保留
    return true;
  }
  if (!isIpHost(host)) return false;
  if (host === '::' || host === '::1') return false;
  if (/^fe[89ab]/.test(host)) return false; // 链路本地
  if (/^f[cd]/.test(host)) return false; // 唯一本地地址
  if (host.startsWith('ff')) return false; // 组播
  if (host.startsWith('::ffff:')) return isPublicIp(host.slice('::ffff:'.length));
  return true;
}

export function isLocalHost(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0'
  );
}

function validHostname(value: string): boolean {
  if (!value || value.length > 253) return false;
  if (isIpHost(value)) return true;
  if (!value.includes('.') && value !== 'localhost') {
    // 单标签主机名只接受 localhost；其余（例如内网别名）留给用户显式加入。
    return value === 'localhost';
  }
  const labels = value.split('.');
  return labels.every((label) => HOST_LABEL.test(label) && label.length <= 63);
}

/**
 * 把用户输入收敛成小写主机名：去掉协议、路径、端口、结尾点，中文域名转 punycode。
 * 无效输入返回空串。
 */
export function normalizeDomain(value: unknown): string {
  if (typeof value !== 'string') return '';
  let text = value.trim().toLowerCase();
  if (!text) return '';

  // 通配符交给 base 解析，URL 不接受 `*.` 主机名。
  if (text.startsWith('*.')) {
    const base = normalizeDomain(text.slice(2));
    return base && !base.startsWith('*.') && !isIpHost(base) ? `*.${base}` : '';
  }

  if (text.includes('://')) {
    try {
      text = new URL(text).hostname;
    } catch {
      return '';
    }
  } else {
    text = text.split(/[/?#]/, 1)[0];
    try {
      // URL 会替我们处理端口、IDN 和非法字符。
      text = new URL(`http://${text}`).hostname;
    } catch {
      return '';
    }
  }

  text = text.replace(/\.+$/g, '');
  if (!text) return '';

  if (text.startsWith('*.')) {
    const base = text.slice(2);
    return base && validHostname(base) && !isIpHost(base) ? `*.${base}` : '';
  }
  return validHostname(text) ? text : '';
}

/** 用于 CORS / preconnect 的来源：只保留 http(s) 的 origin。 */
export function normalizeOrigin(value: unknown, fallbackProtocol = 'https'): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  try {
    const url = new URL(text.includes('://') ? text : `${fallbackProtocol}://${text}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

export function readDomains(config: Pick<WebConfig, 'domains'>): DomainSettings {
  const raw = config.domains;
  const primary = normalizeDomain(raw?.primary);
  const aliases: string[] = [];
  if (Array.isArray(raw?.aliases)) {
    for (const item of raw.aliases) {
      const normalized = normalizeDomain(item);
      if (normalized && normalized !== primary && !aliases.includes(normalized)) {
        aliases.push(normalized);
      }
      if (aliases.length >= 20) break;
    }
  }
  const corsOrigins = settingList(raw?.cors_origins, 12, 300)
    .map((item) => normalizeOrigin(item))
    .filter((item, index, list) => item && list.indexOf(item) === index);
  const tlsMode = raw?.tls?.mode;
  const tls: TlsSettings = {
    mode: tlsMode === 'letsencrypt' || tlsMode === 'manual' ? tlsMode : DEFAULT_TLS.mode,
    email: settingText(raw?.tls?.email, '', 200).trim(),
    cert_path: settingText(raw?.tls?.cert_path, '', 300).trim(),
    key_path: settingText(raw?.tls?.key_path, '', 300).trim(),
    hsts: settingBool(raw?.tls?.hsts, DEFAULT_TLS.hsts),
  };

  return {
    enabled: settingBool(raw?.enabled, DEFAULT_DOMAINS.enabled),
    primary,
    aliases,
    allow_www: settingBool(raw?.allow_www, DEFAULT_DOMAINS.allow_www),
    allow_localhost: settingBool(raw?.allow_localhost, DEFAULT_DOMAINS.allow_localhost),
    allow_ip: settingBool(raw?.allow_ip, DEFAULT_DOMAINS.allow_ip),
    redirect_primary: settingBool(raw?.redirect_primary, DEFAULT_DOMAINS.redirect_primary),
    https_only: settingBool(raw?.https_only, DEFAULT_DOMAINS.https_only),
    tls,
    cors_origins: corsOrigins,
    cookie_domain: settingText(raw?.cookie_domain, '', 200).trim(),
    trusted_proxies: settingList(raw?.trusted_proxies, 16, 64),
  };
}

/** 当前域名是否命中一条绑定的主机规则。 */
export function hostMatches(host: string, pattern: string): boolean {
  const target = host.toLowerCase();
  const rule = pattern.toLowerCase();
  if (!rule) return false;
  if (rule.startsWith('*.')) {
    const suffix = rule.slice(1); // .example.com
    return target !== suffix.slice(1) && target.endsWith(suffix);
  }
  return target === rule;
}

/** 返回去重后的绑定域名（主域名在前）。 */
export function boundDomains(settings: DomainSettings, siteDomain?: string): string[] {
  const out: string[] = [];
  const primary = normalizeDomain(siteDomain) || normalizeDomain(settings.primary);
  if (primary) out.push(primary);
  for (const alias of settings.aliases) {
    const normalized = normalizeDomain(alias);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

/**
 * 判断当前 host 是否被允许。
 *
 * 有主域名/别名时按白名单匹配，localhost 与 IP 由两个开关放行；没有设置任何域名时，
 * 生产环境只允许公网 IP 直连（localhost 仅用于本机管理，避免管理员被锁在门外）。
 */
export function domainAllowed(
  host: string,
  settings: DomainSettings,
  siteDomain?: string,
): boolean {
  if (!settings.enabled) return true;
  const target = normalizeDomain(host) || host.toLowerCase();
  const domains = boundDomains(settings, siteDomain);
  if (settings.allow_localhost && isLocalHost(target)) return true;
  if (!domains.length) {
    // 没有域名：只允许公网 IP 直接访问。
    return isPublicIp(target);
  }
  if (settings.allow_ip && isIpHost(target)) return true;

  const matches = (value: string) => domains.some((item) => hostMatches(value, item));
  if (matches(target)) return true;
  if (settings.allow_www && target.startsWith('www.')) {
    return matches(target.slice(4));
  }
  return false;
}

/** 保存前的逐条校验；返回空串表示通过。 */
export function domainEntryError(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '域名不能为空。';
  if (/\s/.test(trimmed)) return '域名不能包含空格。';
  const normalized = normalizeDomain(trimmed);
  if (!normalized) return '不是有效的域名。';
  if (normalized.startsWith('*.') && normalized.slice(2).split('.').length < 2) {
    return '通配域名至少需要两级，例如 *.example.com。';
  }
  return '';
}

/** 从绑定的域名推导默认 CORS 来源，供生成配置使用。 */
export function defaultCorsOrigins(settings: DomainSettings, siteDomain?: string): string[] {
  const out = settings.cors_origins.slice();
  for (const domain of boundDomains(settings, siteDomain)) {
    if (domain.startsWith('*.')) continue;
    const origin = `https://${domain}`;
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}
