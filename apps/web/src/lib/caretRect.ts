/**
 * 编辑器的几何层：光标矩形与浮层落点。
 *
 * 全部返回视口坐标，纯函数便于单测（happy-dom 里量测恒为零，只能测分支）。
 * `caretAnchor` 刻意不插入探针节点去"量"零尺寸光标：那会动 DOM 和选区，
 * 在 contenteditable 里风险大于收益，宁可逐级降级到块矩形。
 */

/** 光标/锚点矩形，全部是视口坐标。 */
export interface CaretAnchor {
  left: number;
  top: number;
  bottom: number;
  height: number;
}

/** 面板与光标之间留的空隙。 */
const MENU_GAP = 6;
/** 面板与视口边缘之间留的安全边距。 */
const MENU_MARGIN = 8;

function toAnchor(rect: {
  left: number;
  top: number;
  bottom: number;
  height: number;
}): CaretAnchor {
  return {
    left: rect.left,
    top: rect.top,
    bottom: rect.bottom,
    // 有的浏览器把折叠选区的 rect 报成零高，退回用上下边之差。
    height: rect.height || Math.max(0, rect.bottom - rect.top),
  };
}

/**
 * 光标矩形：range 自身矩形 → getClientRects()[0] → 块矩形，逐级降级。
 * 最后一档是近似值（块的首行位置通常就等于块顶），但总比不显示要好。
 */
export function caretAnchor(range: Range | null, block: HTMLElement | null): CaretAnchor | null {
  if (!range) return null;
  const own = range.getBoundingClientRect?.();
  if (own && (own.width > 0 || own.height > 0)) return toAnchor(own);
  const first = range.getClientRects?.()[0];
  if (first && (first.width > 0 || first.height > 0)) return toAnchor(first);
  const fallback = block?.getBoundingClientRect();
  return fallback ? toAnchor(fallback) : null;
}

/** 块的首行行盒：把标记对齐到"这一行的第一行"，而不是整块的顶边。 */
export function firstLineAnchor(block: HTMLElement): CaretAnchor | null {
  const range = document.createRange();
  range.selectNodeContents(block);
  range.collapse(true);
  return caretAnchor(range, block);
}

/**
 * 面板落点：优先光标下方，放不下翻到上方，横向夹在边距内。
 *
 * 两条兜底：翻到上方也出界，就还是放下方（再被夹进视口）；面板比视口还高时
 * 贴边距，宁可压住底部也要让人看见第一行。
 */
export function placeMenu(
  anchor: CaretAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = MENU_GAP,
  margin = MENU_MARGIN,
): { left: number; top: number; placement: 'below' | 'above' } {
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;
  const fitsBelow = below + size.height <= viewport.height - margin;
  const placement: 'below' | 'above' = fitsBelow || above < margin ? 'below' : 'above';
  const preferred = placement === 'below' ? below : above;
  const maxTop = Math.max(margin, viewport.height - margin - size.height);
  const maxLeft = Math.max(margin, viewport.width - margin - size.width);
  return {
    left: Math.min(Math.max(margin, anchor.left), maxLeft),
    top: Math.min(Math.max(margin, preferred), maxTop),
    placement,
  };
}
