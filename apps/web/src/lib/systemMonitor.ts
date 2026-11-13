import type { SystemMetrics } from '../types';

/**
 * 性能面板的纯逻辑。
 *
 * 面板每几秒轮询一次 `GET /api/v1/system/metrics`，页面只保留最近一段曲线：
 * 这里不依赖 React，也不发请求，方便单测覆盖「采样的合并 / 曲线路径 / 百分比 / 圆环几何」。
 */

/** 采样间隔：4 秒在「够实时」和「不给浏览器访问限制添乱」之间取平衡。 */
export const SYSTEM_SAMPLE_INTERVAL_MS = 4000;

/** 客户端保留的曲线点数：60 个点 × 4 秒 ≈ 最近 4 分钟。 */
export const SYSTEM_HISTORY_LIMIT = 60;

/**
 * 圆环仪表盘的几何参数（页面用 120×120 的 viewBox）。
 *
 * 底环与进度环共用同一个半径；dasharray / dashoffset 都以周长为单位计算，
 * 单测直接验证这两个纯函数即可，不依赖 DOM。
 */
export const SYSTEM_RING_RADIUS = 44;

/** 半径 44 的周长：dasharray 与 dashoffset 的基准长度。 */
export const SYSTEM_RING_CIRCUMFERENCE = 2 * Math.PI * SYSTEM_RING_RADIUS;

/** 曲线上的一个点。 */
export interface SystemSamplePoint {
  at: number;
  cpu: number;
  memory: number;
}

/** 把一次采样并入曲线，超出上限时丢最旧的点。 */
export function appendSample(
  history: SystemSamplePoint[],
  sample: Pick<SystemMetrics, 'sampled_at' | 'cpu' | 'memory'>,
  limit = SYSTEM_HISTORY_LIMIT,
): SystemSamplePoint[] {
  const at = Date.parse(sample.sampled_at);
  const point: SystemSamplePoint = {
    at: Number.isFinite(at) ? at : Date.now(),
    cpu: clampPercent(sample.cpu?.usage_percent),
    memory: clampPercent(sample.memory?.usage_percent),
  };
  const next = [...history, point];
  return next.length > limit ? next.slice(next.length - limit) : next;
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

/** 部分占总量的百分比；总量为 0 时返回 0。 */
export function percentOf(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0 || part <= 0) return 0;
  return Math.min(100, (part / total) * 100);
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

/** 进程角色的展示顺序：本软件自己的角色在前，兜底 app 在后。 */
export const SYSTEM_ROLE_ORDER = ['api', 'security', 'launcher', 'web', 'app'] as const;

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

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
