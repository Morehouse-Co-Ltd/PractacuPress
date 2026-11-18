/**
 * 思维导图引擎：缩进大纲 → 树 → tidy-tree 布局。
 *
 * 这是纯函数模块，不依赖 React / DOM，也不新增任何运行时依赖，职责只有两件：
 * 1. `parseMindMapOutline` 把用户写的缩进大纲解析成树，坏数据收敛为 `null`；
 * 2. `layoutMindMap` 把树排成矩形 + 连线路径 + 画布尺寸，供渲染器直接画 SVG。
 *
 * 约定：
 * - 节点矩形坐标指「左上角」，画布四周留 `CANVAS_PAD`，所有坐标非负；
 * - 同一输入多次调用结果完全一致（渲染器依赖它做 `useMemo`，单测会断言）；
 * - 输入树只读，不会被修改。
 */

export interface MindMapNode {
  label: string;
  depth: number;
  children: MindMapNode[];
}

export interface MindMapLayoutNode {
  key: string;
  label: string;
  depth: number;
  /** 矩形左上角。 */
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  /** 一级分支编号（从 0 开始），渲染器用它给整条分支配色。 */
  branch: number;
}

export interface MindMapEdge {
  key: string;
  d: string;
  branch: number;
}

export interface MindMapLayout {
  nodes: MindMapLayoutNode[];
  edges: MindMapEdge[];
  width: number;
  height: number;
}

/**
 * 引擎上限：解析时超出的部分直接截断，不抛错。
 * - `nodes`：最多 80 个节点（含中心主题）；
 * - `depth`：最多 6 层（深度 0–5，中心主题算第 1 层）；
 * - `label`：单个标签最多 60 个字符（按码点计）。
 */
export const MINDMAP_LIMITS: { nodes: number; depth: number; label: number } = {
  nodes: 80,
  depth: 6,
  label: 60,
};

/** 根节点字号，其余节点统一 13。 */
const FONT_ROOT = 15;
const FONT_NODE = 13;

/** 节点左右内边距（单侧）。 */
const NODE_PAD_X = 14;
const MIN_NODE_W = 56;
const MAX_NODE_W = 220;

const ROOT_H = 40;
const NODE_H = 32;

/** 层与层之间的水平间距。 */
const GAP_LEVEL = 48;
/** 兄弟子树之间的垂直间距。 */
const GAP_SIBLING = 12;
/** 画布四周留白。 */
const CANVAS_PAD = 12;

/** 宽字符（中日韩、假名、全角符号等）按 1 个字号计宽，其余按 0.56 个字宽计。 */
const WIDE_CHAR = /[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]/;

/** 行首的列表 / 标题记号，例如 `- `、`* `、`## `。 */
const LINE_MARKER = /^(?:[-*#]+\s*)+/;

function truncateLabel(label: string): string {
  const chars = Array.from(label);
  return chars.length > MINDMAP_LIMITS.label ? chars.slice(0, MINDMAP_LIMITS.label).join('') : label;
}

/** 行首缩进换算成层级：Tab 算一级，两个空格算一级（多余的空格向下取整）。 */
function indentDepth(indent: string): number {
  let depth = 0;
  for (const ch of indent) depth += ch === '\t' ? 1 : 0.5;
  return Math.floor(depth);
}

/**
 * 把缩进大纲解析成树。
 *
 * - 第一行（跳过空行后的第一条）是中心主题；
 * - 两个空格或一个 Tab 缩进表示下一层；
 * - 允许 `-` / `*` / `#` 前缀；空行跳过；标签去掉首尾空白后截到 60 字；
 * - 超过 80 个节点或第 6 层之后的内容直接截断；空输入 / 只有空行返回 `null`。
 */
export function parseMindMapOutline(outline: string): MindMapNode | null {
  if (typeof outline !== 'string' || !outline.trim()) return null;
  const lines = outline.replace(/\r\n?/g, '\n').split('\n');

  let root: MindMapNode | null = null;
  /** `stack[level]` 是当前最靠下的同层节点，用来挂新的子节点。 */
  const stack: MindMapNode[] = [];
  let count = 0;

  for (const line of lines) {
    const match = /^([ \t]*)([\s\S]*)$/.exec(line);
    if (!match) continue;
    const label = truncateLabel(match[2].replace(LINE_MARKER, '').trim());
    if (!label) continue;

    if (!root) {
      root = { label, depth: 0, children: [] };
      stack.push(root);
      count = 1;
      continue;
    }

    // 层级不允许跳级：缩进一次跨了多层时，挂到当前最深节点下面。
    let level = Math.min(indentDepth(match[1]), stack.length);
    if (level < 1) level = 1;
    // 第 depth 层之后的内容截断（0–5 层保留）。
    if (level >= MINDMAP_LIMITS.depth) continue;
    if (count >= MINDMAP_LIMITS.nodes) break;

    const node: MindMapNode = { label, depth: level, children: [] };
    stack[level - 1].children.push(node);
    stack.length = level;
    stack.push(node);
    count += 1;
  }

  return root;
}

/** 按字符估算文本宽度：CJK 按 1 个字号，其余（ASCII、标点）按 0.56 个字号。 */
function estimateTextWidth(label: string, fontSize: number): number {
  let width = 0;
  for (const ch of label) width += WIDE_CHAR.test(ch) ? fontSize : fontSize * 0.56;
  return width;
}

function nodeWidth(label: string, fontSize: number): number {
  const width = Math.round(estimateTextWidth(label, fontSize) + NODE_PAD_X * 2);
  return Math.min(MAX_NODE_W, Math.max(MIN_NODE_W, width));
}

interface Box {
  node: MindMapNode;
  key: string;
  depth: number;
  branch: number;
  side: 'left' | 'right';
  w: number;
  h: number;
  fontSize: number;
  children: Box[];
  /** 子树在垂直方向占用的总高度（含兄弟间距），用于 tidy-tree 摆放。 */
  subtree: number;
  /** 节点中心坐标，最后统一平移并转成左上角。 */
  cx: number;
  cy: number;
}

/** 先序遍历建盒模型；宽度、高度、子树高度都在这一步算好。 */
function measure(node: MindMapNode, depth: number, branch: number, seq: { next: number }): Box {
  const fontSize = depth === 0 ? FONT_ROOT : FONT_NODE;
  const children: MindMapNode[] = Array.isArray(node.children) ? node.children : [];
  const key = `n${seq.next}`;
  seq.next += 1;
  const box: Box = {
    node,
    key,
    depth,
    branch,
    side: 'right',
    w: nodeWidth(node.label, fontSize),
    h: depth === 0 ? ROOT_H : NODE_H,
    fontSize,
    children: [],
    subtree: 0,
    cx: 0,
    cy: 0,
  };
  box.children = children
    .filter((child): child is MindMapNode => Boolean(child) && typeof child.label === 'string')
    .map((child, index) => measure(child, depth + 1, depth === 0 ? index : branch, seq));
  const stackHeight =
    box.children.reduce((sum, child) => sum + child.subtree, 0) +
    GAP_SIBLING * Math.max(0, box.children.length - 1);
  box.subtree = Math.max(box.h, stackHeight);
  return box;
}

function assignSide(box: Box, side: 'left' | 'right'): void {
  box.side = side;
  for (const child of box.children) assignSide(child, side);
}

/**
 * 决定第一层子节点落在左侧还是右侧。
 *
 * `right` 时全部向右；`both` 时按子树高度贪心分配（先放当前更矮的一侧），
 * 既保持原始顺序，又让两侧的垂直占用尽量接近。根节点本身保持居中。
 */
function assignSides(root: Box, layout: 'both' | 'right'): void {
  root.side = 'right';
  if (layout === 'right') {
    for (const child of root.children) assignSide(child, 'right');
    return;
  }
  let leftHeight = 0;
  let rightHeight = 0;
  for (const child of root.children) {
    const side: 'left' | 'right' = leftHeight <= rightHeight ? 'left' : 'right';
    assignSide(child, side);
    if (side === 'left') leftHeight += child.subtree + GAP_SIBLING;
    else rightHeight += child.subtree + GAP_SIBLING;
  }
}

/** 垂直方向：每棵子树在自己的父节点上居中，左右两侧各自独立成列。 */
function placeVertical(box: Box, centerY: number): void {
  box.cy = centerY;
  if (!box.children.length) return;
  const left: Box[] = [];
  const right: Box[] = [];
  for (const child of box.children) {
    if (child.side === 'left') left.push(child);
    else right.push(child);
  }
  for (const group of [left, right]) {
    if (!group.length) continue;
    const total =
      group.reduce((sum, child) => sum + child.subtree, 0) + GAP_SIBLING * (group.length - 1);
    let cursor = centerY - total / 2;
    for (const child of group) {
      placeVertical(child, cursor + child.subtree / 2);
      cursor += child.subtree + GAP_SIBLING;
    }
  }
}

function collectMaxWidth(box: Box, right: number[], left: number[]): void {
  if (box.depth > 0) {
    const widths = box.side === 'left' ? left : right;
    widths[box.depth] = Math.max(widths[box.depth] ?? 0, box.w);
  }
  for (const child of box.children) collectMaxWidth(child, right, left);
}

function assignColumn(box: Box, depth: number, side: 'left' | 'right', centerX: number): void {
  if (box.depth === depth && box.side === side) box.cx = centerX;
  for (const child of box.children) assignColumn(child, depth, side, centerX);
}

/**
 * 水平方向：每一层一列，列宽取该侧该层最宽的节点，列与列之间留 `GAP_LEVEL`。
 * 左侧从根左边缘往左推，右侧从根右边缘往右推。
 */
function placeHorizontal(root: Box): void {
  root.cx = 0;
  const rightWidths: number[] = [];
  const leftWidths: number[] = [];
  collectMaxWidth(root, rightWidths, leftWidths);

  let cursor = root.w / 2 + GAP_LEVEL;
  for (let depth = 1; depth < rightWidths.length; depth += 1) {
    const width = rightWidths[depth];
    if (!width) continue;
    assignColumn(root, depth, 'right', cursor + width / 2);
    cursor += width + GAP_LEVEL;
  }

  cursor = -root.w / 2 - GAP_LEVEL;
  for (let depth = 1; depth < leftWidths.length; depth += 1) {
    const width = leftWidths[depth];
    if (!width) continue;
    assignColumn(root, depth, 'left', cursor - width / 2);
    cursor -= width + GAP_LEVEL;
  }
}

function round2(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

function walk(box: Box, visit: (item: Box) => void): void {
  visit(box);
  for (const child of box.children) walk(child, visit);
}

/** 在平移后的最终坐标上生成两点之间的连线路径。 */
function edgePath(
  parent: MindMapLayoutNode,
  child: MindMapLayoutNode,
  line: 'curve' | 'elbow',
): string {
  const fromRight = child.x + child.w / 2 >= parent.x + parent.w / 2;
  const sx = round2(fromRight ? parent.x + parent.w : parent.x);
  const tx = round2(fromRight ? child.x : child.x + child.w);
  const sy = round2(parent.y + parent.h / 2);
  const ty = round2(child.y + child.h / 2);
  const midX = round2((sx + tx) / 2);
  if (line === 'elbow') {
    return `M ${sx} ${sy} L ${midX} ${sy} L ${midX} ${ty} L ${tx} ${ty}`;
  }
  return `M ${sx} ${sy} C ${midX} ${sy} ${midX} ${ty} ${tx} ${ty}`;
}

/**
 * tidy-tree 布局。
 *
 * - 节点矩形宽按字符估算（CJK 1 个字号、其余 0.56 个字号，+ 左右内边距，clamp 56–220），
 *   根节点高 40、字号 15，其余高 32、字号 13；
 * - 水平层间距 48、兄弟间距 12；`right` 全部向右展开，`both` 把第一层子节点按子树
 *   高度平衡分到左右两侧（根居中）；
 * - `curve` 用三次贝塞尔（C），`elbow` 用直角折线（L），边从父节点边缘连到子节点边缘；
 * - 画布覆盖全部节点并在四周留 12px，坐标非负。
 */
export function layoutMindMap(
  root: MindMapNode,
  options: { layout?: 'both' | 'right'; line?: 'curve' | 'elbow' } = {},
): MindMapLayout {
  const empty: MindMapLayout = {
    nodes: [],
    edges: [],
    width: CANVAS_PAD * 2,
    height: CANVAS_PAD * 2,
  };
  // 防御坏数据：正常调用不会进来，这里保证不抛错。
  if (!root || typeof root.label !== 'string') return empty;

  const layout = options.layout === 'right' ? 'right' : 'both';
  const line = options.line === 'elbow' ? 'elbow' : 'curve';

  const measured = measure(root, 0, 0, { next: 0 });
  assignSides(measured, layout);
  placeVertical(measured, 0);
  placeHorizontal(measured);

  // 先求未平移时的包围盒，再统一平移，保证左上留白且没有负坐标。
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  walk(measured, (box) => {
    const x = box.cx - box.w / 2;
    const y = box.cy - box.h / 2;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + box.w);
    maxY = Math.max(maxY, y + box.h);
  });
  const shiftX = CANVAS_PAD - minX;
  const shiftY = CANVAS_PAD - minY;

  const nodes: MindMapLayoutNode[] = [];
  const edges: MindMapEdge[] = [];

  // 先序输出：根节点在最前，其余节点各自带一条到父节点的边。
  const emit = (box: Box, parent: MindMapLayoutNode | null): void => {
    const node: MindMapLayoutNode = {
      key: box.key,
      label: box.node.label,
      depth: box.depth,
      x: round2(box.cx - box.w / 2 + shiftX),
      y: round2(box.cy - box.h / 2 + shiftY),
      w: box.w,
      h: box.h,
      fontSize: box.fontSize,
      branch: box.branch,
    };
    if (parent) {
      edges.push({
        key: `e-${node.key}`,
        d: edgePath(parent, node, line),
        branch: node.branch,
      });
    }
    nodes.push(node);
    for (const child of box.children) emit(child, node);
  };
  emit(measured, null);

  return {
    nodes,
    edges,
    width: round2(maxX - minX + CANVAS_PAD * 2),
    height: round2(maxY - minY + CANVAS_PAD * 2),
  };
}
