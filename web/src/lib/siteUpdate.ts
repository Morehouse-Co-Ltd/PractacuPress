import type {
  SiteUpdateChannel,
  SiteUpdateFrequency,
  SiteUpdateManifest,
  SiteUpdateMode,
  SiteUpdateSettings,
  SiteUpdateStyle,
} from '../types';
import { compareVersions, parseVersion } from './version';

/**
 * 「站点更新」设置与版本清单的纯逻辑。
 *
 * 版本清单是仓库里的一个 JSON（`web/public/version.json`，构建后就是站点的
 * `/version.json`），只有四个核心字段：标题、说明、版本号与发布渠道。前端与服务端
 * 用同一套规则解析它，所以这里同时提供「解析 / 校验 / 比较」三件事，且不依赖 DOM。
 *
 * 服务器地址是一个下拉栏：可选值在 `UPDATE_SERVERS` 里，全部是标准地址，因此没有
 * 单独的端口输入。真正的「服务端去 GitHub 抓清单再比较」发生在 `/__pp/update`。
 */

/** 版本清单在仓库里的相对路径；GitHub / jsDelivr 的地址都由它拼出来。 */
export const VERSION_MANIFEST_PATH = 'web/public/version.json';

const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/practacu/practacu-press/main';
const JSDELIVR_BASE = 'https://cdn.jsdelivr.net/gh/practacu/practacu-press@main';

export interface UpdateServerOption {
  id: string;
  /** 中文名，页面用 `t(name)` 翻译。 */
  name: string;
  /** 清单地址；相对路径表示本站。 */
  url: string;
  /** 补充说明，页面用 `t(note)` 翻译。 */
  note: string;
}

/**
 * 更新源下拉栏的全部选项。
 *
 * 顺序即下拉顺序：官方仓库第一，镜像兜底，最后是本站（本地构建自检用）。
 * 新增镜像时只改这里，页面与服务端都会跟着用上新地址。
 */
export const UPDATE_SERVERS: UpdateServerOption[] = [
  {
    id: 'github',
    name: 'GitHub 官方仓库',
    url: `${GITHUB_RAW_BASE}/${VERSION_MANIFEST_PATH}`,
    note: '从 GitHub 读取版本清单，国内网络可能较慢。',
  },
  {
    id: 'jsdelivr',
    name: 'jsDelivr 镜像',
    url: `${JSDELIVR_BASE}/${VERSION_MANIFEST_PATH}`,
    note: 'GitHub 访问不稳时用这个镜像，内容与官方仓库一致。',
  },
  {
    id: 'local',
    name: '本站 version.json',
    url: '/version.json',
    note: '直接读本站自己的清单，适合自建构建与离线检查。',
  },
];

export const UPDATE_CHANNELS: { id: SiteUpdateChannel; name: string }[] = [
  { id: 'stable', name: '稳定版' },
  { id: 'beta', name: '测试版' },
];

export const UPDATE_MODES: { id: SiteUpdateMode; name: string; description: string }[] = [
  {
    id: 'manual',
    name: '手动更新',
    description: '只有点「检查更新」时才读取清单，检查通过后再由你决定什么时候更新。',
  },
  {
    id: 'auto',
    name: '自动更新',
    description: '后台按频率读取清单；发现新版本时只提示，不会打断正在编辑的内容。',
  },
];

export const UPDATE_FREQUENCIES: { id: SiteUpdateFrequency; name: string }[] = [
  { id: 'startup', name: '每次启动' },
  { id: 'daily', name: '每天' },
  { id: 'weekly', name: '每周' },
];

/** 自动更新模式的检查间隔（毫秒）；`startup` 表示每次打开后台检查一次。 */
export const UPDATE_FREQUENCY_MS: Record<SiteUpdateFrequency, number> = {
  startup: 0,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/** 发布渠道的中文名，页面用 `t(name)` 翻译。 */
export const UPDATE_STYLES: { id: SiteUpdateStyle; name: string }[] = [
  { id: 'stable', name: '稳定版' },
  { id: 'beta', name: '测试版' },
  { id: 'local', name: '本地版本' },
];

export const DEFAULT_UPDATE_SETTINGS: SiteUpdateSettings = {
  mode: 'manual',
  channel: 'stable',
  frequency: 'startup',
  server_url: UPDATE_SERVERS[0].url,
};

const CHANNEL_IDS = new Set<string>(UPDATE_CHANNELS.map((item) => item.id));
const FREQUENCY_IDS = new Set<string>(UPDATE_FREQUENCIES.map((item) => item.id));
const MODE_IDS = new Set<string>(UPDATE_MODES.map((item) => item.id));
const STYLE_IDS = new Set<string>(UPDATE_STYLES.map((item) => item.id));

/**
 * 把任意来源的配置收敛成合法设置；缺省或非法字段回退默认值。
 *
 * 旧版本把更新方式存成布尔 `auto_update`、把端口存成字符串 `server_port`：
 * 前者迁移成 `mode`，后者直接丢弃（更新源已经不需要端口）。
 */
export function readUpdateSettings(value: unknown): SiteUpdateSettings {
  if (!value || typeof value !== 'object') return DEFAULT_UPDATE_SETTINGS;
  const record = value as Record<string, unknown>;

  const mode: SiteUpdateMode =
    typeof record.mode === 'string' && MODE_IDS.has(record.mode)
      ? (record.mode as SiteUpdateMode)
      : record.auto_update === true
        ? 'auto'
        : DEFAULT_UPDATE_SETTINGS.mode;
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
  const lastChecked =
    typeof record.last_checked_at === 'string' && record.last_checked_at
      ? record.last_checked_at
      : undefined;
  const lastRemote =
    typeof record.last_remote_version === 'string' && record.last_remote_version.trim()
      ? record.last_remote_version.trim()
      : undefined;
  return {
    mode,
    channel,
    frequency,
    // 空白地址（旧配置允许留空）回落到默认更新源：下拉栏里没有“留空”这一项。
    server_url: serverUrl || DEFAULT_UPDATE_SETTINGS.server_url,
    ...(lastChecked ? { last_checked_at: lastChecked } : {}),
    ...(lastRemote ? { last_remote_version: lastRemote } : {}),
  };
}

/** 更新源是否已选：空地址表示「不检查更新」。 */
export function hasUpdateServer(settings: Pick<SiteUpdateSettings, 'server_url'>): boolean {
  return settings.server_url.trim().length > 0;
}

/** 「检查更新」是否可用：只要选了更新源就可以查。 */
export function canCheckForUpdates(settings: Pick<SiteUpdateSettings, 'server_url'>): boolean {
  return hasUpdateServer(settings);
}

/** 当前配置对应的更新源选项；自定义地址返回 null。 */
export function serverOptionOf(serverUrl: string): UpdateServerOption | null {
  const value = serverUrl.trim();
  if (!value) return null;
  return UPDATE_SERVERS.find((item) => item.url === value) ?? null;
}

/** 更新源的展示名：预置项用中文名，自定义地址原样显示。 */
export function serverNameOf(serverUrl: string): string {
  return serverOptionOf(serverUrl)?.name ?? serverUrl.trim();
}

/** 实际要访问的清单地址；没选更新源时回退到默认项。 */
export function manifestUrlOf(serverUrl: string): string {
  const value = serverUrl.trim();
  return value || DEFAULT_UPDATE_SETTINGS.server_url;
}

/** 版本号展示：带 v 前缀；空值显示破折号。 */
export function versionLabel(version: string): string {
  const value = version.trim();
  if (!value) return '—';
  return value.startsWith('v') || value.startsWith('V') ? value : `v${value}`;
}

/** 发布渠道的展示名（中文键，页面套 `t()`）；缺省按稳定版显示。 */
export function styleLabel(style?: SiteUpdateStyle): string {
  const id: SiteUpdateStyle = style ?? 'stable';
  return UPDATE_STYLES.find((item) => item.id === id)?.name ?? id;
}

/** 更新方式的展示名（中文键，页面套 `t()`）。 */
export function modeLabel(mode: SiteUpdateMode): string {
  return UPDATE_MODES.find((item) => item.id === mode)?.name ?? mode;
}

/**
 * 解析并校验版本清单。
 *
 * 核心字段：标题、说明、版本号，以及新清单的 `channel` / `version_code`。
 * `version_code` 必须与版本号算出的值一致；旧清单（只有 `style` 或什么都没有）
 * 按版本号推断通道并补出整数版本号。任何一项不自洽都返回 null —— 损坏的清单
 * 绝不能被当成「有新版本」。
 */
export function parseUpdateManifest(value: unknown): SiteUpdateManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const describe = typeof record.describe === 'string' ? record.describe.trim() : '';
  const version = typeof record.version === 'string' ? record.version.trim() : '';
  if (!title || !describe || !version) return null;

  const parsed = parseVersion(version);
  if (!parsed) return null;

  const rawChannel = typeof record.channel === 'string' ? record.channel.trim() : '';
  const legacyStyle = typeof record.style === 'string' ? record.style.trim() : '';
  if (legacyStyle && !STYLE_IDS.has(legacyStyle)) return null;
  const channel: SiteUpdateChannel | null = CHANNEL_IDS.has(rawChannel)
    ? (rawChannel as SiteUpdateChannel)
    : STYLE_IDS.has(legacyStyle)
      ? legacyStyle === 'beta'
        ? 'beta'
        : 'stable'
      : parsed.channel;
  if (!channel || channel !== parsed.channel) return null;

  const rawCode = record.version_code;
  if (rawCode !== undefined) {
    if (typeof rawCode !== 'number' || !Number.isInteger(rawCode) || rawCode !== parsed.code) {
      return null;
    }
  }
  return {
    title,
    describe,
    version: parsed.version,
    channel,
    version_code: parsed.code,
  };
}

/**
 * 比较两个版本号：`a > b` 返回正数，相等返回 0，`a < b` 返回负数。
 *
 * 只比较整数 `version_code`（规则见 `web/src/lib/version.ts`）；无法解析的版本号
 * 一律按「相等」处理，这样损坏的远端清单不会让人以为有新版本。
 */
export function compareUpdateVersions(a: string, b: string): number {
  return compareVersions(a, b);
}

/** 远端版本是否比本机新。 */
export function isNewerVersion(remote: string, local: string): boolean {
  return compareUpdateVersions(remote, local) > 0;
}

/** 当前通道是否接受这个发布渠道：稳定版通道忽略测试版，测试版通道全都接受。 */
export function isChannelAllowed(channel: SiteUpdateChannel, style?: SiteUpdateStyle): boolean {
  if (channel === 'beta') return true;
  return style !== 'beta';
}

export type UpdateStatus =
  /** 远端更新，且通道接受。 */
  | 'available'
  /** 版本相同。 */
  | 'up_to_date'
  /** 本机版本更新（自建构建超前于发布版本）。 */
  | 'ahead'
  /** 远端是测试版，但当前通道是稳定版。 */
  | 'channel_mismatch'
  /** 清单无效或对不上。 */
  | 'invalid';

export interface UpdateVerdict {
  status: UpdateStatus;
  available: boolean;
  localVersion: string;
  /** 解析后的远端清单；无效时为 null。 */
  remote: SiteUpdateManifest | null;
}

/**
 * 判断这次检查的结果。
 *
 * 只有「远端更新 + 通道接受」才算有新版本；稳定版通道不会因为远端是测试版就提示更新，
 * 这跟发行说明里「稳定版只跟着正式发布走」保持一致。
 */
export function evaluateUpdate(input: {
  localVersion: string;
  remote: SiteUpdateManifest | null;
  channel: SiteUpdateChannel;
}): UpdateVerdict {
  const { localVersion, remote, channel } = input;
  if (!remote) {
    return { status: 'invalid', available: false, localVersion, remote: null };
  }
  const order = compareUpdateVersions(remote.version, localVersion);
  if (order === 0) {
    return { status: 'up_to_date', available: false, localVersion, remote };
  }
  if (order < 0) {
    return { status: 'ahead', available: false, localVersion, remote };
  }
  if (!isChannelAllowed(channel, remote.channel ?? remote.style)) {
    return { status: 'channel_mismatch', available: false, localVersion, remote };
  }
  return { status: 'available', available: true, localVersion, remote };
}

/** 自动更新模式的检查间隔；`startup` 返回 0（本次会话只查一次）。 */
export function updateIntervalMs(frequency: SiteUpdateFrequency): number {
  return UPDATE_FREQUENCY_MS[frequency] ?? 0;
}
