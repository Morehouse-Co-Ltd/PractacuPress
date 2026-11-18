/**
 * 页面编排器浮动面板的位置约束。
 *
 * 面板可以被拖到任意位置，但必须留出可见的标题栏，避免拖出屏幕后再也抓不回来；
 * 高度也必须保持在窗口之内，否则内部滚动区域会被裁掉。纯函数，便于单测。
 */

export interface PanelPosition {
  left: number;
  top: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

/** 面板离窗口边缘的最小距离。 */
export const PANEL_EDGE = 8;
/** 松手时离左右边缘多近就吸附过去。 */
export const PANEL_SNAP_DISTANCE = 64;
/** 拖到窗口底部时，标题栏至少要露出的高度。 */
const HEADER_VISIBLE = 48;
/** 面板最矮高度，窗口特别矮时以窗口可用高度为准。 */
const MIN_HEIGHT = 220;

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function clampPanelPosition(
  position: PanelPosition,
  viewport: ViewportSize,
  panelWidth: number,
): PanelPosition {
  const width = Number.isFinite(panelWidth) && panelWidth > 0 ? panelWidth : 320;
  const viewportWidth = Number.isFinite(viewport.width) ? Math.max(0, viewport.width) : 0;
  const viewportHeight = Number.isFinite(viewport.height) ? Math.max(0, viewport.height) : 0;

  const maxLeft = Math.max(PANEL_EDGE, viewportWidth - width - PANEL_EDGE);
  const maxTop = Math.max(PANEL_EDGE, viewportHeight - HEADER_VISIBLE);
  const maxHeight = Math.max(PANEL_EDGE, viewportHeight - PANEL_EDGE * 2);
  const minHeight = Math.min(MIN_HEIGHT, maxHeight);

  return {
    left: clampNumber(position.left, PANEL_EDGE, maxLeft),
    top: clampNumber(position.top, PANEL_EDGE, maxTop),
    height: clampNumber(position.height, minHeight, maxHeight),
  };
}

/**
 * 松手时把面板吸附到最近的一侧。
 *
 * 拖动体验的关键是「拖到边上就贴边」：离左右边缘 64px 以内时自动对齐，
 * 但仍然走一遍 clamp，保证在小窗口里不会把面板推出屏幕。
 */
export function snapPanelPosition(
  position: PanelPosition,
  viewport: ViewportSize,
  panelWidth: number,
  snapDistance = PANEL_SNAP_DISTANCE,
): PanelPosition {
  const width = Number.isFinite(panelWidth) && panelWidth > 0 ? panelWidth : 320;
  const viewportWidth = Number.isFinite(viewport.width) ? Math.max(0, viewport.width) : 0;
  const clamped = clampPanelPosition(position, viewport, width);
  const rightGap = viewportWidth - (clamped.left + width);

  let left = clamped.left;
  if (clamped.left <= snapDistance) left = PANEL_EDGE;
  else if (rightGap <= snapDistance) left = viewportWidth - width - PANEL_EDGE;

  return clampPanelPosition({ ...clamped, left }, viewport, width);
}
