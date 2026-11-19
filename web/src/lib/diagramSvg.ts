/**
 * 文章图表 SVG 渲染器：规格 → 一整段 `<svg>`。
 *
 * 定位：**纯字符串函数**，不 import React、不碰 `document` / `window`。
 * 调用方（`lib/diagramHydrate.ts`、图表弹窗）把结果塞进 `figure.innerHTML` 或
 * `dangerouslySetInnerHTML`，所以这里只负责结构与内联配色，视觉细节交给 `styles.css`。
 *
 * 几条硬约束：
 * - SVG presentation 属性（`fill` / `stroke`）不支持 `var()`，主题令牌必须写进内联 `style`；
 *   彩色分支与统计图自动配色才用固定十六进制色板。
 * - 所有用户文本（图题、节点、标签、单位）都过 `escapeXml`，坐标一律 `num()` 收敛，
 *   输出里不允许出现 `NaN` / `undefined` / `Infinity`。
 * - 同一输入多次调用输出完全一致（不依赖时间、随机数或全局状态）。
 */

import type {
  ChartDiagram,
  DiagramSpec,
  DiagramType,
  FishboneDiagram,
  LogicDiagram,
  MindMapDiagram,
} from './diagramSpec';
import { DIAGRAM_LIMITS } from './diagramSpec';
import { t } from './i18n';
import { layoutMindMap, parseMindMapOutline, type MindMapNode } from './mindmap';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 彩色分支 / 统计图自动配色：固定 8 色，深色主题下也能分辨。 */
const PALETTE = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
] as const;

/** 与 `diagramSpec.normalizeChartItems` 一致的十六进制校验，挡住样式注入。 */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** 节点尺寸约定与 `mindmap.ts` 保持一致（宽按字符估算，clamp 56–220）。 */
const FONT_ROOT = 15;
const FONT_NODE = 13;
const NODE_PAD_X = 14;
const MIN_NODE_W = 56;
const MAX_NODE_W = 220;
const ROOT_H = 40;
const NODE_H = 32;

/** 宽字符（中日韩、假名、全角符号等）按 1 个字号计宽，其余按 0.56 个字号。 */
const WIDE_CHAR = /[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]/;

const TITLE_SIZE = 14;
const TITLE_BAND = 28;

const EMPTY_WIDTH = 360;
const EMPTY_HEIGHT = 120;

const ARROW_MARKER =
  '<defs><marker id="pp-diagram-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">' +
  '<path class="pp-diagram-arrow" d="M 0 0 L 10 5 L 0 10 Z" style="fill:var(--line-strong)"/>' +
  '</marker></defs>';

/** 向下逻辑图：层与层、兄弟之间都用固定间距，和横向布局保持同一节奏。 */
const STEP_GAP_X = 24;
const STEP_GAP_Y = 40;
const STEP_PAD = 12;

const CHART_WIDTH = 640;
const CHART_HEIGHT = 260;
const CHART_PAD_L = 52;
const CHART_PAD_R = 16;
const CHART_PAD_T = 12;
const CHART_PAD_B = 44;
const CHART_GRID_LINES = 4;
const CHART_LEGEND_X = 324;

const ARC_CX = 190;
const ARC_CY = CHART_HEIGHT / 2;
const ARC_OUTER = 92;
const ARC_INNER = 56;

const FISHBONE_STEP = 156;
const FISHBONE_BONE_DX = 34;
const FISHBONE_BONE_DY = 86;
const FISHBONE_HEAD_GAP = 26;
const FISHBONE_HEAD_H = 46;
const FISHBONE_PAD = 16;
const FISHBONE_CATEGORY_FONT = 12.5;
const FISHBONE_CAUSE_FONT = 11;
const FISHBONE_CATEGORY_MAX = 120;
const FISHBONE_CAUSE_MAX = 120;

interface Body {
  /** 已生成的内部标记；坐标从 (0, 0) 起，由外层 `<g>` 整体下移图题高度。 */
  markup: string;
  width: number;
  height: number;
}

const XML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** 转义任意值里的 XML 保留字符；`null` / `undefined` 变成空串。 */
export function escapeXml(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[&<>"']/g, (ch) => XML_ESCAPE[ch] || ch);
}

/**
 * 十六进制色的粗略亮度，用来决定压在上面的文字用白还是近黑。
 *
 * 彩色分支是固定色板（有浅有深），白字压在浅黄上只有 2:1 出头；按亮度
 * 切换前景色才能让每个分支都达到可读对比。
 */
function isLightHex(hex: string): boolean {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((ch) => ch + ch).join('') : value;
  const red = parseInt(full.slice(0, 2), 16) || 0;
  const green = parseInt(full.slice(2, 4), 16) || 0;
  const blue = parseInt(full.slice(4, 6), 16) || 0;
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255 > 0.58;
}

/** 彩色底上的文字：深底白字、浅底近黑字。 */
function textOnHex(hex: string): string {
  return isLightHex(hex) ? '#1c1c1a' : '#ffffff';
}

function round2(value: number): number {
  const safe = Number.isFinite(value) ? value : 0;
  const rounded = Math.round(safe * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/** 坐标 / 数值统一出口：四舍五入到两位，NaN 与无穷退化成 0。 */
function num(value: number): string {
  return String(round2(value));
}

function safeNumber(value: unknown): number {
  const next = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(next)) return 0;
  return Math.max(-1e9, Math.min(1e9, Math.round(next * 100) / 100));
}

function safeColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : fallback;
}

/** 按字符估算文本宽度：CJK 按 1 个字号，其余（ASCII、标点）按 0.56 个字号。 */
function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const ch of text) width += WIDE_CHAR.test(ch) ? fontSize : fontSize * 0.56;
  return width;
}

/** 节点矩形宽：文本估算 + 左右内边距，clamp 56–220。 */
function nodeWidth(label: string, fontSize: number): number {
  const width = Math.round(estimateTextWidth(label, fontSize) + NODE_PAD_X * 2);
  return Math.min(MAX_NODE_W, Math.max(MIN_NODE_W, width));
}

/** 文本宽度估算的舍入余量：节点宽按 `Math.round` 取整，留 2px 避免「刚好放下」被误截。 */
const FIT_SLACK = 2;

/** 在给宽度内截断文本并加省略号；返回的文本估算宽度不超过 `maxWidth + FIT_SLACK`。 */
function fitText(text: string, maxWidth: number, fontSize: number): string {
  if (maxWidth <= 0) return '';
  const limit = maxWidth + FIT_SLACK;
  if (estimateTextWidth(text, fontSize) <= limit) return text;
  const ellipsis = '…';
  const budget = limit - estimateTextWidth(ellipsis, fontSize);
  let out = '';
  let width = 0;
  for (const ch of text) {
    const next = width + (WIDE_CHAR.test(ch) ? fontSize : fontSize * 0.56);
    if (next > budget) break;
    out += ch;
    width = next;
  }
  return out ? `${out}${ellipsis}` : ellipsis;
}

/** 图表数值文本：整数原样，小数保留两位再去掉尾零。 */
function formatValue(value: number, unit: string): string {
  return `${num(value)}${unit}`;
}

function typeLabel(type: DiagramType): string {
  switch (type) {
    case 'mindmap':
      return t('思维导图');
    case 'logic':
      return t('逻辑图');
    case 'chart':
      return t('统计图');
    default:
      return t('鱼骨图');
  }
}

/** 空数据 / 空大纲时的居中占位，用 SVG `<text>` 而不是 HTML，保持返回类型单一。 */
function emptyBody(type: DiagramType): Body {
  const label = type === 'chart' ? t('暂无图表数据。') : t('暂无大纲数据。');
  const markup =
    `<text class="pp-diagram-empty" x="${EMPTY_WIDTH / 2}" y="${EMPTY_HEIGHT / 2}" ` +
    'text-anchor="middle" dominant-baseline="middle" style="fill:var(--muted)">' +
    `${escapeXml(label)}</text>`;
  return { markup, width: EMPTY_WIDTH, height: EMPTY_HEIGHT };
}

/** 统一包一层 `<svg>`：图题在顶部，`<title>` / `aria-label` 永远有内容。 */
function wrapSvg(type: DiagramType, body: Body, title?: string): string {
  const titleText = typeof title === 'string' ? title.trim() : '';
  const titleWidth = titleText ? estimateTextWidth(titleText, TITLE_SIZE) + 24 : 0;
  const width = Math.max(1, Math.ceil(Math.max(body.width, titleWidth)));
  const band = titleText ? TITLE_BAND : 0;
  const height = Math.max(1, Math.ceil(band + body.height));
  const accessible = titleText || typeLabel(type);
  const titleMarkup = titleText
    ? `<text class="pp-diagram-title" x="12" y="${TITLE_SIZE + 4}" style="fill:var(--ink)">` +
      `${escapeXml(titleText)}</text>`
    : '';
  return (
    `<svg class="pp-diagram-svg" role="img" aria-label="${escapeXml(accessible)}" ` +
    `viewBox="0 0 ${width} ${height}" xmlns="${SVG_NS}">` +
    `<title>${escapeXml(accessible)}</title>` +
    titleMarkup +
    `<g transform="translate(0 ${band})">${body.markup}</g>` +
    '</svg>'
  );
}

/** 分支颜色：主题单色全部主色，彩色按一级分支取固定色板。 */
function branchColor(branch: number, colorful: boolean): string {
  if (!colorful) return 'var(--accent)';
  return PALETTE[branch % PALETTE.length];
}

// ---------------------------------------------------------------------------
// 思维导图
// ---------------------------------------------------------------------------

function renderMindmap(spec: MindMapDiagram): Body {
  const root = parseMindMapOutline(typeof spec.outline === 'string' ? spec.outline : '');
  if (!root) return emptyBody('mindmap');

  const layout = layoutMindMap(root, {
    layout: spec.layout === 'right' ? 'right' : 'both',
    line: spec.line === 'elbow' ? 'elbow' : 'curve',
  });
  const colorful = spec.palette !== 'theme';

  const edges = layout.edges
    .map(
      (edge) =>
        `<path class="pp-diagram-edge" d="${escapeXml(edge.d)}" ` +
        `style="stroke:${branchColor(edge.branch, colorful)}"/>`,
    )
    .join('');

  const nodes = layout.nodes
    .map((node) => {
      const isRoot = node.depth === 0;
      const color = branchColor(node.branch, colorful);
      const fill = isRoot ? 'var(--accent)' : node.depth === 1 && colorful ? color : 'var(--bg)';
      const stroke = isRoot ? 'var(--accent)' : color;
      // 主色底用 var(--bg) 反色对（浅色主题近白、暗色主题近黑）；彩色分支按亮度选前景。
      const textFill = isRoot
        ? 'var(--bg)'
        : colorful && node.depth === 1
          ? textOnHex(color)
          : 'var(--ink)';
      const label = fitText(node.label, node.w - NODE_PAD_X * 2, node.fontSize);
      return (
        `<g class="pp-diagram-node${isRoot ? ' is-root' : ''}" data-depth="${node.depth}" ` +
        `data-key="${node.key}">` +
        `<rect x="${num(node.x)}" y="${num(node.y)}" width="${num(node.w)}" ` +
        `height="${num(node.h)}" rx="8" style="fill:${fill};stroke:${stroke}"/>` +
        `<text x="${num(node.x + node.w / 2)}" y="${num(node.y + node.h / 2)}" ` +
        `text-anchor="middle" dominant-baseline="middle" font-size="${node.fontSize}" ` +
        `style="fill:${textFill}">${escapeXml(label)}</text>` +
        '</g>'
      );
    })
    .join('');

  return { markup: edges + nodes, width: layout.width, height: layout.height };
}

// ---------------------------------------------------------------------------
// 逻辑图（复用思维导图解析器；向右 = tidy-tree，向下 = 自写的纵向摆放）
// ---------------------------------------------------------------------------

interface StepNode {
  key: string;
  label: string;
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
}

interface StepEdge {
  key: string;
  d: string;
}

interface StepLayout {
  nodes: StepNode[];
  edges: StepEdge[];
  width: number;
  height: number;
}

function stepEdge(parent: StepNode, child: StepNode): string {
  // 向下：父节点底部 → 一半处 → 子节点中心 → 子节点顶部，箭头朝下。
  const sx = round2(parent.x + parent.w / 2);
  const sy = round2(parent.y + parent.h);
  const tx = round2(child.x + child.w / 2);
  const ty = round2(child.y);
  const midY = round2(sy + STEP_GAP_Y / 2);
  return `M ${sx} ${sy} L ${sx} ${midY} L ${tx} ${midY} L ${tx} ${ty}`;
}

function layoutStepsRight(root: MindMapNode): StepLayout {
  const layout = layoutMindMap(root, { layout: 'right', line: 'elbow' });
  return {
    nodes: layout.nodes.map((node) => ({
      key: node.key,
      label: node.label,
      depth: node.depth,
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
      fontSize: node.fontSize,
    })),
    edges: layout.edges.map((edge) => ({ key: edge.key, d: edge.d })),
    width: layout.width,
    height: layout.height,
  };
}

interface DownBox {
  key: string;
  label: string;
  depth: number;
  w: number;
  h: number;
  fontSize: number;
  children: DownBox[];
  subtreeW: number;
  x: number;
  y: number;
}

function measureDown(node: MindMapNode, depth: number, seq: { next: number }): DownBox {
  const fontSize = depth === 0 ? FONT_ROOT : FONT_NODE;
  const key = `n${seq.next}`;
  seq.next += 1;
  const children = (Array.isArray(node.children) ? node.children : [])
    .filter((child): child is MindMapNode => Boolean(child) && typeof child.label === 'string')
    .map((child) => measureDown(child, depth + 1, seq));
  const w = nodeWidth(node.label, fontSize);
  const h = depth === 0 ? ROOT_H : NODE_H;
  const childrenW =
    children.reduce((sum, child) => sum + child.subtreeW, 0) +
    STEP_GAP_X * Math.max(0, children.length - 1);
  return {
    key,
    label: node.label,
    depth,
    w,
    h,
    fontSize,
    children,
    subtreeW: Math.max(w, childrenW),
    x: 0,
    y: 0,
  };
}

function walkDown(box: DownBox, visit: (item: DownBox) => void): void {
  visit(box);
  for (const child of box.children) walkDown(child, visit);
}

/** 纵向 tidy-tree：子树按宽度分摊，父节点在子节点上方居中。 */
function layoutStepsDown(root: MindMapNode): StepLayout {
  const measured = measureDown(root, 0, { next: 0 });

  const levelHeights: number[] = [];
  walkDown(measured, (box) => {
    levelHeights[box.depth] = Math.max(levelHeights[box.depth] ?? 0, box.h);
  });
  const levelY: number[] = [];
  let cursorY = STEP_PAD;
  for (let depth = 0; depth < levelHeights.length; depth += 1) {
    levelY[depth] = cursorY;
    cursorY += levelHeights[depth] + STEP_GAP_Y;
  }

  const place = (box: DownBox, left: number): void => {
    box.x = left + box.subtreeW / 2 - box.w / 2;
    box.y = levelY[box.depth] ?? STEP_PAD;
    const children = box.children;
    const childrenW =
      children.reduce((sum, child) => sum + child.subtreeW, 0) +
      STEP_GAP_X * Math.max(0, children.length - 1);
    let cursor = left + (box.subtreeW - childrenW) / 2;
    for (const child of children) {
      place(child, cursor);
      cursor += child.subtreeW + STEP_GAP_X;
    }
  };
  place(measured, 0);

  let minX = Infinity;
  let maxX = -Infinity;
  let maxY = 0;
  walkDown(measured, (box) => {
    minX = Math.min(minX, box.x);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  });
  const shiftX = STEP_PAD - minX;

  const nodes: StepNode[] = [];
  const edges: StepEdge[] = [];
  const emit = (box: DownBox, parent: StepNode | null): void => {
    const node: StepNode = {
      key: box.key,
      label: box.label,
      depth: box.depth,
      x: round2(box.x + shiftX),
      y: round2(box.y),
      w: box.w,
      h: box.h,
      fontSize: box.fontSize,
    };
    if (parent) edges.push({ key: `e-${node.key}`, d: stepEdge(parent, node) });
    nodes.push(node);
    for (const child of box.children) emit(child, node);
  };
  emit(measured, null);

  return { nodes, edges, width: maxX - minX + STEP_PAD * 2, height: maxY + STEP_PAD };
}

function renderStepNodes(nodes: StepNode[]): string {
  return nodes
    .map((node) => {
      const isRoot = node.depth === 0;
      const label = fitText(node.label, node.w - NODE_PAD_X * 2, node.fontSize);
      const rectStyle = isRoot
        ? 'fill:var(--accent);stroke:var(--accent)'
        : 'fill:var(--bg);stroke:var(--line-strong)';
      const textStyle = isRoot ? 'fill:var(--bg)' : 'fill:var(--ink)';
      return (
        `<g class="pp-diagram-node is-step${isRoot ? ' is-root' : ''}" data-depth="${node.depth}" ` +
        `data-key="${node.key}">` +
        `<rect x="${num(node.x)}" y="${num(node.y)}" width="${num(node.w)}" ` +
        `height="${num(node.h)}" rx="8" style="${rectStyle}"/>` +
        `<text x="${num(node.x + node.w / 2)}" y="${num(node.y + node.h / 2)}" ` +
        `text-anchor="middle" dominant-baseline="middle" font-size="${node.fontSize}" ` +
        `style="${textStyle}">${escapeXml(label)}</text>` +
        '</g>'
      );
    })
    .join('');
}

function renderStepEdges(edges: StepEdge[]): string {
  return edges
    .map(
      (edge) =>
        `<path class="pp-diagram-edge" d="${escapeXml(edge.d)}" ` +
        `marker-end="url(#pp-diagram-arrow)" style="stroke:var(--line-strong)"/>`,
    )
    .join('');
}

function renderLogic(spec: LogicDiagram): Body {
  const root = parseMindMapOutline(typeof spec.outline === 'string' ? spec.outline : '');
  if (!root) return emptyBody('logic');
  const steps = spec.direction === 'down' ? layoutStepsDown(root) : layoutStepsRight(root);
  return {
    markup: ARROW_MARKER + renderStepEdges(steps.edges) + renderStepNodes(steps.nodes),
    width: steps.width,
    height: steps.height,
  };
}

// ---------------------------------------------------------------------------
// 统计图
// ---------------------------------------------------------------------------

interface ChartPoint {
  label: string;
  value: number;
  color: string;
}

function chartPoints(spec: ChartDiagram): ChartPoint[] {
  const source = Array.isArray(spec.items) ? spec.items : [];
  const points: ChartPoint[] = [];
  for (const raw of source.slice(0, DIAGRAM_LIMITS.chartItems)) {
    if (!raw || typeof raw !== 'object') continue;
    const label =
      typeof raw.label === 'string' ? raw.label.trim().slice(0, DIAGRAM_LIMITS.chartLabel) : '';
    if (!label) continue;
    points.push({
      label,
      value: safeNumber(raw.value),
      color: safeColor(raw.color, PALETTE[points.length % PALETTE.length]),
    });
  }
  return points;
}

function chartXLabelAnchor(position: number): 'start' | 'middle' | 'end' {
  if (position < CHART_PAD_L + 24) return 'start';
  if (position > CHART_WIDTH - CHART_PAD_R - 24) return 'end';
  return 'middle';
}

function renderAxisChart(points: ChartPoint[], kind: 'bar' | 'line', unit: string): Body {
  const plotW = CHART_WIDTH - CHART_PAD_L - CHART_PAD_R;
  const plotH = CHART_HEIGHT - CHART_PAD_T - CHART_PAD_B;
  const values = points.map((point) => point.value);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const top = max === min ? (max === 0 ? 1 : max) : max;
  const range = top - min || 1;
  const yOf = (value: number): number => CHART_PAD_T + (1 - (value - min) / range) * plotH;
  const baseY = yOf(0);

  const grid: string[] = [];
  for (let index = 0; index <= CHART_GRID_LINES; index += 1) {
    const value = min + ((top - min) * index) / CHART_GRID_LINES;
    const y = yOf(value);
    grid.push(
      `<line class="pp-chart-grid" x1="${num(CHART_PAD_L)}" y1="${num(y)}" ` +
        `x2="${num(CHART_WIDTH - CHART_PAD_R)}" y2="${num(y)}" style="stroke:var(--line)"/>`,
    );
    grid.push(
      `<text class="pp-chart-label" x="${num(CHART_PAD_L - 8)}" y="${num(y + 3)}" ` +
        `text-anchor="end" style="fill:var(--muted)">${escapeXml(num(value))}</text>`,
    );
  }
  const axis =
    `<line class="pp-chart-axis" x1="${num(CHART_PAD_L)}" y1="${num(CHART_PAD_T)}" ` +
    `x2="${num(CHART_PAD_L)}" y2="${num(CHART_PAD_T + plotH)}" style="stroke:var(--line-strong)"/>` +
    `<line class="pp-chart-axis" x1="${num(CHART_PAD_L)}" y1="${num(baseY)}" ` +
    `x2="${num(CHART_WIDTH - CHART_PAD_R)}" y2="${num(baseY)}" style="stroke:var(--line-strong)"/>`;

  const xLabelY = CHART_HEIGHT - CHART_PAD_B + 16;
  let series = '';

  if (kind === 'bar') {
    const slot = plotW / points.length;
    const barW = Math.min(40, Math.max(8, slot * 0.58));
    const bars: string[] = [];
    points.forEach((point, index) => {
      const x = CHART_PAD_L + slot * index + (slot - barW) / 2;
      const y = yOf(point.value);
      const topY = Math.min(y, baseY);
      const height = Math.max(1, Math.abs(y - baseY));
      const labelY = point.value >= 0 ? topY - 5 : topY + height + 13;
      const centerX = x + barW / 2;
      bars.push(
        `<rect class="pp-chart-bar" x="${num(x)}" y="${num(topY)}" width="${num(barW)}" ` +
          `height="${num(height)}" rx="4" style="fill:${point.color}"/>`,
      );
      bars.push(
        `<text class="pp-chart-value" x="${num(centerX)}" y="${num(labelY)}" ` +
          `text-anchor="middle" style="fill:var(--ink)">${escapeXml(formatValue(point.value, unit))}</text>`,
      );
      bars.push(
        `<text class="pp-chart-label" x="${num(centerX)}" y="${num(xLabelY)}" ` +
          `text-anchor="${chartXLabelAnchor(centerX)}" style="fill:var(--muted)">` +
          `${escapeXml(fitText(point.label, slot - 4, 11))}</text>`,
      );
    });
    series = bars.join('');
  } else {
    const step = points.length > 1 ? plotW / (points.length - 1) : 0;
    const coords = points.map((point, index) => ({
      x: points.length > 1 ? CHART_PAD_L + step * index : CHART_PAD_L + plotW / 2,
      y: yOf(point.value),
      point,
    }));
    const polyline = coords.map((coord) => `${num(coord.x)},${num(coord.y)}`).join(' ');
    const lines: string[] = [
      `<polyline class="pp-chart-line" points="${polyline}" style="stroke:var(--accent)"/>`,
    ];
    coords.forEach((coord) => {
      const labelY = coord.y - 9 < CHART_PAD_T + 8 ? coord.y + 16 : coord.y - 9;
      lines.push(
        `<circle class="pp-chart-dot" cx="${num(coord.x)}" cy="${num(coord.y)}" r="4" ` +
          `style="fill:${coord.point.color};stroke:var(--bg)"/>`,
      );
      lines.push(
        `<text class="pp-chart-value" x="${num(coord.x)}" y="${num(labelY)}" ` +
          `text-anchor="middle" style="fill:var(--ink)">${escapeXml(
            formatValue(coord.point.value, unit),
          )}</text>`,
      );
      lines.push(
        `<text class="pp-chart-label" x="${num(coord.x)}" y="${num(xLabelY)}" ` +
          `text-anchor="${chartXLabelAnchor(coord.x)}" style="fill:var(--muted)">` +
          `${escapeXml(fitText(coord.point.label, step > 0 ? step - 4 : plotW, 11))}</text>`,
      );
    });
    series = lines.join('');
  }

  return { markup: grid.join('') + axis + series, width: CHART_WIDTH, height: CHART_HEIGHT };
}

interface FlatPoint {
  x: number;
  y: number;
}

function polar(radius: number, angle: number): FlatPoint {
  return {
    x: round2(ARC_CX + Math.cos(angle) * radius),
    y: round2(ARC_CY + Math.sin(angle) * radius),
  };
}

function pointPair(point: FlatPoint): string {
  return `${num(point.x)} ${num(point.y)}`;
}

function renderPieChart(points: ChartPoint[], kind: 'donut' | 'pie', unit: string): Body {
  const positive = points.map((point) => ({ ...point, value: Math.max(0, point.value) }));
  const total = positive.reduce((sum, point) => sum + point.value, 0);
  if (total <= 0) return emptyBody('chart');

  const slices: string[] = [];
  let angle = -Math.PI / 2;
  for (const point of positive) {
    const fraction = point.value / total;
    const start = angle;
    const end = angle + fraction * Math.PI * 2;
    angle = end;
    if (fraction >= 0.999999) {
      // 单个扇区占满整圆：SVG 圆弧起点终点重合会退化成空路径，改用圆。
      if (kind === 'donut') {
        slices.push(
          `<circle class="pp-chart-arc" cx="${num(ARC_CX)}" cy="${num(ARC_CY)}" ` +
            `r="${num((ARC_OUTER + ARC_INNER) / 2)}" style="fill:none;stroke:${point.color};` +
            `stroke-width:${num(ARC_OUTER - ARC_INNER)}"/>`,
        );
      } else {
        slices.push(
          `<circle class="pp-chart-arc" cx="${num(ARC_CX)}" cy="${num(ARC_CY)}" ` +
            `r="${num(ARC_OUTER)}" style="fill:${point.color}"/>`,
        );
      }
      continue;
    }
    const large = fraction > 0.5 ? 1 : 0;
    const startOuter = polar(ARC_OUTER, start);
    const endOuter = polar(ARC_OUTER, end);
    if (kind === 'donut') {
      const endInner = polar(ARC_INNER, end);
      const startInner = polar(ARC_INNER, start);
      slices.push(
        `<path class="pp-chart-arc" d="M ${pointPair(startOuter)} ` +
          `A ${num(ARC_OUTER)} ${num(ARC_OUTER)} 0 ${large} 1 ${pointPair(endOuter)} ` +
          `L ${pointPair(endInner)} ` +
          `A ${num(ARC_INNER)} ${num(ARC_INNER)} 0 ${large} 0 ${pointPair(startInner)} Z" ` +
          `style="fill:${point.color};stroke:var(--bg);stroke-width:1"/>`,
      );
    } else {
      slices.push(
        `<path class="pp-chart-arc" d="M ${num(ARC_CX)} ${num(ARC_CY)} ` +
          `L ${pointPair(startOuter)} ` +
          `A ${num(ARC_OUTER)} ${num(ARC_OUTER)} 0 ${large} 1 ${pointPair(endOuter)} Z" ` +
          `style="fill:${point.color};stroke:var(--bg);stroke-width:1"/>`,
      );
    }
  }

  const legend: string[] = [];
  const valueX = CHART_WIDTH - CHART_PAD_R;
  const rowHeight = Math.min(22, Math.max(15, (CHART_HEIGHT - 56) / positive.length));
  positive.forEach((point, index) => {
    const y = 44 + rowHeight * index;
    const valueText = formatValue(point.value, unit);
    const labelWidth = Math.max(
      40,
      valueX - (CHART_LEGEND_X + 16) - estimateTextWidth(valueText, 11) - 16,
    );
    legend.push(
      '<g class="pp-chart-legend-item">' +
        `<rect class="pp-chart-swatch" x="${num(CHART_LEGEND_X)}" y="${num(y - 9)}" ` +
        `width="10" height="10" rx="2" style="fill:${point.color}"/>` +
        `<text class="pp-chart-label" x="${num(CHART_LEGEND_X + 16)}" y="${num(y)}" ` +
        `style="fill:var(--ink)">${escapeXml(fitText(point.label, labelWidth, 11))}</text>` +
        `<text class="pp-chart-value" x="${num(valueX)}" y="${num(y)}" text-anchor="end" ` +
        `style="fill:var(--ink)">${escapeXml(valueText)}</text>` +
        '</g>',
    );
  });

  return {
    markup: slices.join('') + `<g class="pp-chart-legend">${legend.join('')}</g>`,
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
  };
}

function renderChart(spec: ChartDiagram): Body {
  const points = chartPoints(spec);
  if (!points.length) return emptyBody('chart');
  const unit = typeof spec.unit === 'string' ? spec.unit.trim() : '';
  if (spec.kind === 'donut' || spec.kind === 'pie') {
    return renderPieChart(points, spec.kind, unit);
  }
  return renderAxisChart(points, spec.kind === 'line' ? 'line' : 'bar', unit);
}

// ---------------------------------------------------------------------------
// 鱼骨图
// ---------------------------------------------------------------------------

interface FishboneText {
  kind: 'label' | 'cause';
  /** 文本右端（`text-anchor="end"`）。 */
  x: number;
  /** 基线。 */
  y: number;
  text: string;
  /** 估算宽度，用于计算画布包围盒。 */
  width: number;
  fontSize: number;
}

interface FishboneLine {
  kind: 'bone' | 'tick';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function fishboneChildren(node: MindMapNode): MindMapNode[] {
  return (Array.isArray(node.children) ? node.children : []).filter(
    (child): child is MindMapNode => Boolean(child) && typeof child.label === 'string',
  );
}

/**
 * 横向鱼骨：主脊从左侧问题分类区伸向右侧鱼头（问题），一级分类上下交替成斜骨，
 * 二级原因沿斜骨分布、保持水平可读，每个原因前有一条短刻度线。
 * 先在虚拟坐标里摆好，再按包围盒整体平移到非负坐标。
 */
function renderFishbone(spec: FishboneDiagram): Body {
  const root = parseMindMapOutline(typeof spec.outline === 'string' ? spec.outline : '');
  if (!root) return emptyBody('fishbone');

  const categories = fishboneChildren(root);
  const headFont = FONT_NODE;
  const headW = Math.min(MAX_NODE_W, Math.max(96, nodeWidth(root.label, headFont)));
  const headH = FISHBONE_HEAD_H;
  const headText = fitText(root.label, headW - 20, headFont);
  const spineEnd = categories.length * FISHBONE_STEP;
  const headX = spineEnd + FISHBONE_HEAD_GAP;

  const texts: FishboneText[] = [];
  const lines: FishboneLine[] = [];

  categories.forEach((category, categoryIndex) => {
    const up = categoryIndex % 2 === 0;
    const anchorX = FISHBONE_STEP * categoryIndex + FISHBONE_STEP / 2;
    const endX = anchorX - FISHBONE_BONE_DX;
    const endY = up ? -FISHBONE_BONE_DY : FISHBONE_BONE_DY;
    lines.push({ kind: 'bone', x1: anchorX, y1: 0, x2: endX, y2: endY });

    const labelText = fitText(category.label, FISHBONE_CATEGORY_MAX, FISHBONE_CATEGORY_FONT);
    texts.push({
      kind: 'label',
      x: endX - 6,
      y: up ? endY - 8 : endY + 16,
      text: labelText,
      width: estimateTextWidth(labelText, FISHBONE_CATEGORY_FONT),
      fontSize: FISHBONE_CATEGORY_FONT,
    });

    const causes = fishboneChildren(category);
    causes.forEach((cause, causeIndex) => {
      const fraction = (causeIndex + 1) / (causes.length + 1);
      const px = anchorX - FISHBONE_BONE_DX * fraction;
      const py = (up ? -FISHBONE_BONE_DY : FISHBONE_BONE_DY) * fraction;
      const causeText = fitText(cause.label, FISHBONE_CAUSE_MAX, FISHBONE_CAUSE_FONT);
      const causeX = px - 16;
      texts.push({
        kind: 'cause',
        x: causeX,
        y: up ? py - 4 : py + 14,
        text: causeText,
        width: estimateTextWidth(causeText, FISHBONE_CAUSE_FONT),
        fontSize: FISHBONE_CAUSE_FONT,
      });
      lines.push({ kind: 'tick', x1: px, y1: py, x2: px - 12, y2: py });
    });
  });

  // 包围盒：主脊、鱼头、斜骨、全部文字。文字按右端锚点向左展开。
  let minX = Math.min(0, headX);
  let maxX = headX + headW;
  let minY = -headH / 2;
  let maxY = headH / 2;
  for (const text of texts) {
    minX = Math.min(minX, text.x - text.width);
    maxX = Math.max(maxX, text.x);
    minY = Math.min(minY, text.y - text.fontSize);
    maxY = Math.max(maxY, text.y + text.fontSize * 0.4);
  }
  for (const line of lines) {
    minX = Math.min(minX, line.x1, line.x2);
    maxX = Math.max(maxX, line.x1, line.x2);
    minY = Math.min(minY, line.y1, line.y2);
    maxY = Math.max(maxY, line.y1, line.y2);
  }
  const shiftX = FISHBONE_PAD - minX;
  const shiftY = FISHBONE_PAD - minY;
  const x = (value: number): string => num(value + shiftX);
  const y = (value: number): string => num(value + shiftY);

  const parts: string[] = [];
  for (const line of lines) {
    const cls = line.kind === 'bone' ? 'pp-fishbone-bone' : 'pp-fishbone-cause-tick';
    parts.push(
      `<path class="${cls}" d="M ${x(line.x1)} ${y(line.y1)} L ${x(line.x2)} ${y(line.y2)}" ` +
        'style="stroke:var(--line-strong)"/>',
    );
  }
  parts.push(
    `<path class="pp-fishbone-spine" d="M ${x(0)} ${y(0)} L ${x(headX)} ${y(0)}" ` +
      'style="stroke:var(--line-strong)"/>',
  );
  parts.push(
    `<rect class="pp-fishbone-head" x="${x(headX)}" y="${y(-headH / 2)}" width="${num(headW)}" ` +
      `height="${num(headH)}" rx="${num(headH / 2)}" style="fill:var(--accent)"/>`,
  );
  parts.push(
    `<text class="pp-diagram-node is-root" x="${x(headX + headW / 2)}" y="${y(0)}" ` +
      'text-anchor="middle" dominant-baseline="middle" ' +
      `style="fill:var(--bg)" font-size="${headFont}">${escapeXml(headText)}</text>`,
  );
  for (const text of texts) {
    const cls = text.kind === 'label' ? 'pp-fishbone-label' : 'pp-fishbone-cause';
    const fill = text.kind === 'label' ? 'var(--ink)' : 'var(--muted)';
    parts.push(
      `<text class="${cls}" x="${x(text.x)}" y="${y(text.y)}" text-anchor="end" ` +
        `font-size="${text.fontSize}" style="fill:${fill}">${escapeXml(text.text)}</text>`,
    );
  }

  const width = maxX - minX + FISHBONE_PAD * 2;
  const height = maxY - minY + FISHBONE_PAD * 2;
  return { markup: parts.join(''), width, height };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 把图表规格渲染成一整段 `<svg>`；坏数据回退成占位，不抛错。 */
export function renderDiagramSvg(spec: DiagramSpec): string {
  if (!spec || typeof spec !== 'object') {
    return wrapSvg('chart', emptyBody('chart'));
  }
  const title = typeof spec.title === 'string' ? spec.title : undefined;
  switch (spec.type) {
    case 'mindmap':
      return wrapSvg('mindmap', renderMindmap(spec), title);
    case 'logic':
      return wrapSvg('logic', renderLogic(spec), title);
    case 'chart':
      return wrapSvg('chart', renderChart(spec), title);
    case 'fishbone':
      return wrapSvg('fishbone', renderFishbone(spec), title);
    default:
      return wrapSvg('chart', emptyBody('chart'), title);
  }
}
