import type {
  SiteUpdateChannel,
  SiteUpdateFrequency,
  SiteUpdateSettings,
} from '../types';

/**
 * 「站点更新」设置。
 *
 * 更新服务端还没接入，这一页先把设置存在本机后台配置（WebConfig）里：
 * 地址与端口可以为空，空配置只表示“暂不检查更新”，不影响站点其它功能。
 * 接入更新服务后，服务端可以复用同一份字段语义。
 */

export const UPDATE_CHANNELS: { id: SiteUpdateChannel; name: string }[] = [
  { id: 'stable', name: '稳定版' },
  { id: 'beta', name: '测试版' },
];

export const UPDATE_FREQUENCIES: { id: SiteUpdateFrequency; name: string }[] = [
  { id: 'startup', name: '每次启动' },
  { id: 'daily', name: '每天' },
  { id: 'weekly', name: '每周' },
];

export const DEFAULT_UPDATE_SETTINGS: SiteUpdateSettings = {
  auto_update: false,
  channel: 'stable',
  frequency: 'startup',
  server_url: '',
  server_port: '',
};

const CHANNEL_IDS = new Set<string>(UPDATE_CHANNELS.map((item) => item.id));
const FREQUENCY_IDS = new Set<string>(UPDATE_FREQUENCIES.map((item) => item.id));

/** 把任意来源的配置收敛成合法设置；缺省或非法字段回退默认值。 */
export function readUpdateSettings(value: unknown): SiteUpdateSettings {
  if (!value || typeof value !== 'object') return DEFAULT_UPDATE_SETTINGS;
  const record = value as Record<string, unknown>;
  const channel =
    typeof record.channel === 'string' && CHANNEL_IDS.has(record.channel)
      ? (record.channel as SiteUpdateChannel)
      : DEFAULT_UPDATE_SETTINGS.channel;
  const frequency =
    typeof record.frequency === 'string' && FREQUENCY_IDS.has(record.frequency)
      ? (record.frequency as SiteUpdateFrequency)
      : DEFAULT_UPDATE_SETTINGS.frequency;
  const serverUrl =
    typeof record.server_url === 'string' ? record.server_url.trim() : '';
  const serverPort =
    typeof record.server_port === 'string' ? record.server_port.trim() : '';
  const lastChecked =
    typeof record.last_checked_at === 'string' && record.last_checked_at
      ? record.last_checked_at
      : undefined;
  return {
    auto_update: record.auto_update === true,
    channel,
    frequency,
    server_url: serverUrl,
    server_port: serverPort,
    ...(lastChecked ? { last_checked_at: lastChecked } : {}),
  };
}

/**
 * 校验更新服务端端口。
 *
 * 空字符串合法（表示使用协议默认端口）；否则必须是 1–65535 的整数。
 */
export function isValidUpdatePort(input: string): boolean {
  const value = input.trim();
  if (!value) return true;
  if (!/^\d{1,5}$/.test(value)) return false;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** 更新服务端是否已经配置地址；空地址表示“暂不检查更新”。 */
export function hasUpdateServer(settings: Pick<SiteUpdateSettings, 'server_url'>): boolean {
  return settings.server_url.trim().length > 0;
}

/** 检查更新按钮是否可用：更新服务尚未接入，永远返回不可用。 */
export function canCheckForUpdates(): boolean {
  return false;
}

/** 版本号展示：带 v 前缀；空值显示破折号。 */
export function versionLabel(version: string): string {
  const value = version.trim();
  if (!value) return '—';
  return value.startsWith('v') ? value : `v${value}`;
}
