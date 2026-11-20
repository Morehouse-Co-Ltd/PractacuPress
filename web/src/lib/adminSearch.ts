import type { IconName } from '../components/Icon';

/**
 * 后台命令面板（顶栏「搜索功能」）的纯逻辑。
 *
 * 拆成独立模块有两个原因：
 * - 面板的数据来自 AdminShell 现有的侧栏导航，这里只做「怎么搜、怎么排」，不依赖
 *   React、路由或权限，方便单测；
 * - 面板会同时用当前语言的 label、中文原文（英文界面下也要能用中文搜到）和路由匹配，
 *   排序规则写成纯函数后可以逐条断言，不需要渲染组件。
 */

/** 面板里的一个可打开条目：一条导航（含设置子页、扩展页）或一个快捷动作。 */
export interface AdminSearchEntry {
  /** 稳定唯一 id，同时用作列表 key。 */
  id: string;
  /** 当前语言下的显示名（`t()` 之后的文案）。 */
  label: string;
  /** 结果列表里的分组标题（也是当前语言）。 */
  group: string;
  /** 目标路由，交给 `useNavigate` 跳转。 */
  to: string;
  icon?: IconName;
  /**
   * 额外搜索词。核心导航在这里放中文原文，于是英文界面下输入「内容」也能命中
   * 「Content library」；在中文界面下它与 label 相同，不会造成重复结果。
   */
  keywords?: string[];
}

/**
 * 命中优先级，数字越小越靠前。
 *
 * 先按「前缀命中 / 包含命中」分层，再在同一层里让当前语言的 label 排在最前：
 * 用户看到什么就搜什么，中文原文与路由只是补充手段。
 */
const RANK_LABEL_PREFIX = 0;
const RANK_KEYWORD_PREFIX = 1;
const RANK_ROUTE_PREFIX = 2;
const RANK_LABEL_CONTAINS = 3;
const RANK_KEYWORD_CONTAINS = 4;
const RANK_ROUTE_CONTAINS = 5;

/** 大小写不敏感：统一转小写后比较；中文不受影响。 */
function normalize(text: string): string {
  return text.trim().toLowerCase();
}

/** 单个条目对一条查询的命中等级；`null` 表示没命中。 */
function rankEntry(entry: AdminSearchEntry, query: string): number | null {
  const label = normalize(entry.label);
  if (label.startsWith(query)) return RANK_LABEL_PREFIX;
  if ((entry.keywords ?? []).some((keyword) => normalize(keyword).startsWith(query))) {
    return RANK_KEYWORD_PREFIX;
  }
  if (normalize(entry.to).startsWith(query)) return RANK_ROUTE_PREFIX;
  if (label.includes(query)) return RANK_LABEL_CONTAINS;
  if ((entry.keywords ?? []).some((keyword) => normalize(keyword).includes(query))) {
    return RANK_KEYWORD_CONTAINS;
  }
  if (normalize(entry.to).includes(query)) return RANK_ROUTE_CONTAINS;
  return null;
}

/**
 * 按查询过滤并排序。
 *
 * 规则：
 * - 空查询（含纯空白）返回全部条目，保持原顺序——面板因此能直接当「后台地图」用；
 * - 匹配当前语言 label、`keywords`（中文原文）与路由，全部大小写不敏感；
 * - 前缀命中排前、包含命中排后；同一等级保持传入顺序（`Array#sort` 稳定，
 *   这里再显式用原索引兜底，不依赖引擎实现）；
 * - 无命中返回空数组，由面板渲染空态。
 */
export function searchAdminEntries(
  entries: readonly AdminSearchEntry[],
  query: string,
): AdminSearchEntry[] {
  const normalized = normalize(query);
  if (!normalized) return [...entries];

  const hits: { entry: AdminSearchEntry; rank: number; index: number }[] = [];
  entries.forEach((entry, index) => {
    const rank = rankEntry(entry, normalized);
    if (rank !== null) hits.push({ entry, rank, index });
  });

  hits.sort((left, right) => left.rank - right.rank || left.index - right.index);
  return hits.map((hit) => hit.entry);
}

/**
 * ↑/↓ 之后应该选中的下标。
 *
 * 到列表两端就停住（不循环）：命令面板里按住方向键时，循环会让高亮从末尾瞬间跳回
 * 开头，视觉上很难跟住。列表为空时返回 0，调用方按空结果处理。
 */
export function moveActiveIndex(current: number, length: number, delta: number): number {
  if (length <= 0) return 0;
  const next = current + delta;
  if (next < 0) return 0;
  if (next > length - 1) return length - 1;
  return next;
}

/** `isPaletteShortcut` 需要的最低限度事件形状，单测不用构造 DOM 事件。 */
export interface PaletteShortcutEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * 是否是 Ctrl/Cmd+K。
 *
 * 只认「Ctrl+K / ⌘K」这一种组合：带 Alt 或 Shift 的组合留给浏览器与输入法，
 * 不抢。普通字符键完全不经过这里，输入框里的正常输入因此不受影响。
 */
export function isPaletteShortcut(event: PaletteShortcutEvent): boolean {
  if (!event.ctrlKey && !event.metaKey) return false;
  if (event.altKey || event.shiftKey) return false;
  return event.key.toLowerCase() === 'k';
}
