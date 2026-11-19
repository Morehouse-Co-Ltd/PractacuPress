import type { SystemMetrics } from '../types';

/**
 * 性能面板的纯逻辑。
 *
 * 面板每 2 秒轮询一次 `GET /api/v1/system/metrics`（与后端采样节奏一致），页面只保留
 * 最近约 2 分钟的曲线：这里不依赖 React，也不发请求，方便单测覆盖「采样的合并 /
 * 曲线路径 / 百分比拆分 / 数据年龄与过期判定 / 圆环几何」。
 */

/**
 * 前端轮询间隔：与服务端 `internal/system.DefaultInterval`（2 秒）保持一致。
 *
 * 服务端每个周期才产出新快照，轮询更快只会读到同一份缓存；更慢则面板明显滞后。
 */
export const SYSTEM_SAMPLE_INTERVAL_MS = 2000;

/** 客户端保留的曲线点数：60 个点 × 2 秒 ≈ 最近 2 分钟。 */
export const SYSTEM_HISTORY_LIMIT = 60;

/** 曲线覆盖的时间窗口（毫秒），用于「最近 N 秒」文案。 */
export const SYSTEM_HISTORY_WINDOW_MS = SYSTEM_SAMPLE_INTERVAL_MS * SYSTEM_HISTORY_LIMIT;

/**
 * 数据过期阈值：服务端每 2 秒采样，连续 8 秒（4 个周期）没有新样本，说明采样器停了、
 * 请求失败或网络断了。此时页面必须显示「数据已过期」，不能把旧数字当成实时数据。
 */
export const SYSTEM_STALE_AFTER_MS = 8000;

/**
 * 圆环仪表盘的几何参数（页面用 120×120 的 viewBox）。
 *
 * 底环与进度环共用同一个半径；dasharray / dashoffset 都以周长为单位计算，
 * 单测直接验证这两个纯函数即可，不依赖 DOM。
 */
export const SYSTEM_RING_RADIUS = 44;

/** 半径 44 的周长：dasharray 与 dashoffset 的基准长度。 */
export const SYSTEM_RING_CIRCUMFERENCE = 2 * Math.PI * SYSTEM_RING_RADIUS;

/** 曲线上的一个点：`at` 是服务端采样时间（毫秒时间戳）。 */
export interface SystemSamplePoint {
  at: number;
  cpu: number;
  memory: number;
}

/** 一次采样拆成「本软件 / 其他软件 / 空闲」三段，单位都是占整机容量的百分比。 */
export interface ResourceSplit {
  app: number;
  other: number;
  idle: number;
}

/**
 * 把一次采样并入曲线。
 *
 * - CPU / 内存都夹紧到 0–100，非法值按 0；
 * - `sampled_at` 解析失败时用当前时间兜底，曲线不会因为一条坏数据出现 NaN；
 * - 同一个 `sampled_at` 视为同一份样本（轮询比采样快时会重复读到它），直接替换最后一个点，
 *   曲线不会被平台期填满；
 * - 比曲线末尾更旧的样本（例如请求乱序返回）直接丢弃；
 * - 超出上限时丢最旧的点，只保留最近一段窗口。
 */
export function appendSample(
  history: SystemSamplePoint[],
  sample: Pick<SystemMetrics, 'sampled_at' | 'cpu' | 'memory'>,
  limit = SYSTEM_HISTORY_LIMIT,
): SystemSamplePoint[] {
  const parsed = Date.parse(sample.sampled_at);
  const point: SystemSamplePoint = {
    at: Number.isFinite(parsed) ? parsed : Date.now(),
    cpu: clampPercent(sample.cpu?.usage_percent),
    memory: clampPercent(sample.memory?.usage_percent),
  };
  const last = history[history.length - 1];
  if (last && point.at === last.at) {
    const next = history.slice(0, -1);
    next.push(point);
    return next;
  }
  if (last && point.at < last.at) return history;
  const next = [...history, point];
  const max = Math.max(1, Math.floor(limit));
  return next.length > max ? next.slice(next.length - max) : next;
}

/** 一条 0–100 曲线的 SVG path（折线）。点不足两个时返回空串，调用方画平线占位。 */
export function sparklinePath(
  values: number[],
  width: number,
  height: number,
  padding = 2,
): string {
  const usable = values.map(clampPercent).filter((value) => Number.isFinite(value));
  if (usable.length < 2) return '';
  const innerWidth = Math.max(1, width - padding * 2);
  const innerHeight = Math.max(1, height - padding * 2);
  return usable
    .map((value, index) => {
      const x = padding + (innerWidth * index) / (usable.length - 1);
      const y = padding + innerHeight * (1 - value / 100);
      return `${index === 0 ? 'M' : 'L'}${round1(x)} ${round1(y)}`;
    })
    .join(' ');
}

/**
 * 把「本软件 + 其他软件」拆成占整机容量的三段百分比，合计恰好 100。
 *
 * 输入是互不重叠的两个部分（页面先用已用量夹紧），这里仍做防御性处理：负数 / NaN 按 0，
 * 两个部分相加超过总量时截断「其他软件」，空闲段永远非负。三个宽度相加恒为 100，
 * 因此占比条不会出现「标签加起来不等于条宽」的矛盾。
 */
export function resourceSplit(appValue: number, otherValue: number, total: number): ResourceSplit {
  const capacity = nonNegative(total);
  if (capacity <= 0) return { app: 0, other: 0, idle: 0 };
  const app = Math.min(nonNegative(appValue), capacity);
  const other = Math.min(nonNegative(otherValue), capacity - app);
  const appPercent = (app / capacity) * 100;
  const otherPercent = (other / capacity) * 100;
  return {
    app: appPercent,
    other: otherPercent,
    idle: Math.max(0, 100 - appPercent - otherPercent),
  };
}

/** 部分占总量的百分比；总量为 0 时返回 0。 */
export function percentOf(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0 || part <= 0) return 0;
  return Math.min(100, (part / total) * 100);
}

/**
 * 采样数据年龄（毫秒）：现在时间减去服务端 `sampled_at`。
 *
 * 时间戳非法时返回 null（调用方把 null 当成过期）；本机时钟比服务端慢会产生负数，
 * 这里按 0 处理，避免出现「-3 秒前」这种文案。
 */
export function sampleAgeMs(sampledAt: string, now = Date.now()): number | null {
  const at = Date.parse(sampledAt);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return null;
  return Math.max(0, now - at);
}

/** 数据是否已过期：时间戳非法或年龄超过阈值（默认 8 秒）都算过期。 */
export function isSampleStale(
  sampledAt: string,
  now = Date.now(),
  maxAgeMs = SYSTEM_STALE_AFTER_MS,
): boolean {
  const age = sampleAgeMs(sampledAt, now);
  if (age === null) return true;
  const threshold = Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? maxAgeMs : SYSTEM_STALE_AFTER_MS;
  return age > threshold;
}

/** 把运行秒数拆成天 / 时 / 分，供页面按当前语言拼文案。 */
export function uptimeParts(seconds: number): { days: number; hours: number; minutes: number } {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return {
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
  };
}

/** 百分比夹紧到 0–100；非数字 / NaN / 负数一律按 0（空环）。 */
export function clampPercent(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * 圆环进度的 stroke-dashoffset。
 *
 * SVG 里 dashoffset = 0 表示整圈可见，等于周长时进度为 0；所以百分比越大，
 * offset 越小。半径/周长可以传入（页面与单测共用同一套默认值）。
 * 非法周长回退到默认周长，保证返回值永远是有限数。
 */
export function ringDashOffset(
  percent: number,
  circumference = SYSTEM_RING_CIRCUMFERENCE,
): number {
  const length =
    Number.isFinite(circumference) && circumference > 0
      ? circumference
      : SYSTEM_RING_CIRCUMFERENCE;
  return length * (1 - clampPercent(percent) / 100);
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
