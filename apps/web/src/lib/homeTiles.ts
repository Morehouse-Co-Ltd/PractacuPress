import type { HomePin, TileSpan } from '../types';

/**
 * 首页精选网格（置顶 / 热门）。
 *
 * 契约没有置顶端点，置顶名单和主题、页面一样存在本地安装配置里
 * （`customization.pins`，随「导出配置」迁移）。这里只负责：
 * 占格选项、非法值收敛、热门模式的自动排布节奏。
 */

export const TILE_SPANS: { value: TileSpan; label: string; note: string }[] = [
  { value: '1x1', label: '1 × 1', note: '小方块' },
  { value: '2x1', label: '2 × 1', note: '横条' },
  { value: '1x2', label: '1 × 2', note: '竖条' },
  { value: '2x2', label: '2 × 2', note: '大方块' },
];

const SPAN_VALUES = new Set<string>(TILE_SPANS.map((item) => item.value));

/** 收口非法值：旧配置、导入的 JSON 都可能带别的写法。 */
export function normalizeTileSpan(value: unknown): TileSpan {
  return typeof value === 'string' && SPAN_VALUES.has(value) ? (value as TileSpan) : '1x1';
}

/**
 * 热门模式的自动排布：名次越高占格越大。
 * 四人列网格下 2x2 + 2x1 + 2x1 正好铺满两行，再来四个 1x1 铺满第三行，
 * 七篇为一组循环，保证「最热的一篇」永远是最大那格。
 */
const POPULAR_PATTERN: TileSpan[] = ['2x2', '2x1', '2x1', '1x1', '1x1', '1x1', '1x1'];

export function autoSpanForRank(index: number): TileSpan {
  if (!Number.isFinite(index) || index < 0) return '1x1';
  return POPULAR_PATTERN[index % POPULAR_PATTERN.length];
}

/** 一份置顶名单最多几篇：再多首页就塞不下了。 */
export const MAX_PINS = 12;

/** 把任意来源的置顶名单收敛成合法数组（去重、截断、只留 id 与占格）。 */
export function normalizePins(value: unknown): HomePin[] {
  if (!Array.isArray(value)) return [];
  const out: HomePin[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, 80) : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, span: normalizeTileSpan(raw.span) });
    if (out.length >= MAX_PINS) break;
  }
  return out;
}
