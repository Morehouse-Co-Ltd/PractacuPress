/**
 * 文章图表：规格类型、白名单归一化与 Markdown 围栏互转。
 *
 * 为什么是「围栏代码块 + JSON」而不是内联 SVG：
 * 文章正文要经过服务端 goldmark 渲染和 Go 白名单清洗，白名单里没有
 * svg / figure / div，也没有 data-* 与 style。围栏代码块会被渲染成
 * `<pre><code class="language-pp-diagram">…</code></pre>`，正好在白名单内；
 * 前端拿到 `rendered_html` 后再把它水合成 SVG（见 lib/diagramHydrate.ts）。
 *
 * 这样做的好处：正文只多一段紧凑 JSON，渲染结果不落盘，换主题/布局随时重渲染，
 * 而且后端与安全边界一行都不用改。
 */

export type DiagramType = 'mindmap' | 'logic' | 'chart' | 'fishbone';

/** 围栏语言名：` ```pp-diagram `。 */
export const DIAGRAM_LANGUAGE = 'pp-diagram';

export const DIAGRAM_TYPES: DiagramType[] = ['mindmap', 'logic', 'chart', 'fishbone'];

export const DIAGRAM_LIMITS = {
  outline: 4000,
  title: 90,
  chartItems: 12,
  chartLabel: 40,
  treeNodes: 80,
  treeDepth: 6,
} as const;

export interface DiagramBase {
  type: DiagramType;
  /** 图题；留空不显示。 */
  title?: string;
}

export interface MindMapDiagram extends DiagramBase {
  type: 'mindmap';
  /** 缩进大纲；第一行是中心主题，两个空格或 Tab 缩进一层。 */
  outline: string;
  layout: 'both' | 'right';
  line: 'curve' | 'elbow';
  palette: 'colorful' | 'theme';
}

export interface LogicDiagram extends DiagramBase {
  type: 'logic';
  /** 缩进大纲；第一行是起点，缩进表示下一步/分支。 */
  outline: string;
  direction: 'right' | 'down';
}

export type ChartKind = 'bar' | 'line' | 'donut' | 'pie';

export interface ChartItem {
  label: string;
  value: number;
  /** 可选的覆盖色（十六进制）；空表示用自动配色。 */
  color?: string;
}

export interface ChartDiagram extends DiagramBase {
  type: 'chart';
  kind: ChartKind;
  /** 数值单位，例如 次、%、篇。 */
  unit?: string;
  items: ChartItem[];
}

export interface FishboneDiagram extends DiagramBase {
  type: 'fishbone';
  /**
   * 缩进大纲：第一行是问题/结果，一级是分类（鱼骨），二级是原因。
   * 与思维导图共用同一套解析器。
   */
  outline: string;
}

export type DiagramSpec = MindMapDiagram | LogicDiagram | ChartDiagram | FishboneDiagram;

/** 新建图表时的示例：都是内容而不是界面文案，按原文存进稿件。 */
export const DEFAULT_DIAGRAM_SPECS: Record<DiagramType, DiagramSpec> = {
  mindmap: {
    type: 'mindmap',
    title: '',
    outline: '我的站点\n  写作\n    长文\n    随笔\n  阅读\n    书单\n  社区\n    留言\n    友链',
    layout: 'both',
    line: 'curve',
    palette: 'colorful',
  },
  logic: {
    type: 'logic',
    title: '',
    outline: '开始\n  收集素材\n    确认来源\n    补充数据\n  撰写初稿\n    自检\n  发布',
    direction: 'right',
  },
  chart: {
    type: 'chart',
    title: '最近四周访问',
    kind: 'bar',
    unit: '',
    items: [
      { label: '第一周', value: 128 },
      { label: '第二周', value: 176 },
      { label: '第三周', value: 152 },
      { label: '第四周', value: 214 },
    ],
  },
  fishbone: {
    type: 'fishbone',
    title: '',
    outline: '发布为什么总是延期\n  需求\n    范围反复变更\n    验收标准不清\n  流程\n    评审排队\n    返工\n  工具\n    构建太慢\n  人\n    并行任务过多',
  },
};

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function pickText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.replace(/\r\n?/g, '\n').slice(0, max);
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function pickNumber(value: unknown): number {
  const next = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(next)) return 0;
  return Math.max(-1e9, Math.min(1e9, Math.round(next * 100) / 100));
}

/** 把图表数据行（`标签,数值`，一行一项）解析成条目。坏行直接跳过。 */
export function parseChartData(text: string): ChartItem[] {
  const items: ChartItem[] = [];
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^(.*?)[\s,，;；\t]+(-?\d+(?:\.\d+)?)\s*$/.exec(line);
    if (!match) continue;
    const label = match[1].trim().slice(0, DIAGRAM_LIMITS.chartLabel);
    if (!label) continue;
    items.push({ label, value: pickNumber(match[2]) });
    if (items.length >= DIAGRAM_LIMITS.chartItems) break;
  }
  return items;
}

/** 反向序列化，供「编辑图表」回填数据框。 */
export function serializeChartData(items: ChartItem[]): string {
  return items.map((item) => `${item.label}, ${item.value}`).join('\n');
}

function normalizeChartItems(value: unknown): ChartItem[] {
  if (!Array.isArray(value)) return [];
  const items: ChartItem[] = [];
  for (const entry of value.slice(0, DIAGRAM_LIMITS.chartItems)) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const label = pickText(raw.label, DIAGRAM_LIMITS.chartLabel)?.trim();
    if (!label) continue;
    const item: ChartItem = { label, value: pickNumber(raw.value) };
    if (typeof raw.color === 'string' && HEX_COLOR.test(raw.color)) item.color = raw.color.toLowerCase();
    items.push(item);
  }
  return items;
}

/**
 * 把不可信输入（旧稿件、手改 Markdown、导入文件）收敛成合法规格。
 *
 * 与页面编排的兼容性原则一致：能渲染就渲染，坏字段当作没设置，
 * 整个规格无法识别时返回 null，让调用方保留原来的代码块。
 */
export function normalizeDiagramSpec(value: unknown): DiagramSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const type = raw.type;
  if (typeof type !== 'string' || !(DIAGRAM_TYPES as string[]).includes(type)) return null;
  const title = pickText(raw.title, DIAGRAM_LIMITS.title)?.trim() ?? '';

  switch (type as DiagramType) {
    case 'mindmap': {
      const outline = pickText(raw.outline, DIAGRAM_LIMITS.outline) ?? '';
      if (!outline.trim()) return null;
      return {
        type: 'mindmap',
        ...(title ? { title } : {}),
        outline,
        layout: pickEnum(raw.layout, ['both', 'right'] as const, 'both'),
        line: pickEnum(raw.line, ['curve', 'elbow'] as const, 'curve'),
        palette: pickEnum(raw.palette, ['colorful', 'theme'] as const, 'colorful'),
      };
    }
    case 'logic': {
      const outline = pickText(raw.outline, DIAGRAM_LIMITS.outline) ?? '';
      if (!outline.trim()) return null;
      return {
        type: 'logic',
        ...(title ? { title } : {}),
        outline,
        direction: pickEnum(raw.direction, ['right', 'down'] as const, 'right'),
      };
    }
    case 'chart': {
      const items = normalizeChartItems(raw.items);
      // 空数据也保留规格：阅读页显示「暂无数据」比整块消失更容易理解。
      return {
        type: 'chart',
        ...(title ? { title } : {}),
        kind: pickEnum(raw.kind, ['bar', 'line', 'donut', 'pie'] as const, 'bar'),
        ...(pickText(raw.unit, 12)?.trim() ? { unit: pickText(raw.unit, 12)!.trim() } : {}),
        items,
      };
    }
    case 'fishbone': {
      const outline = pickText(raw.outline, DIAGRAM_LIMITS.outline) ?? '';
      if (!outline.trim()) return null;
      return { type: 'fishbone', ...(title ? { title } : {}), outline };
    }
    default:
      return null;
  }
}

const CODE_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};

/** 代码块内容只需要挡住能提前关闭标签的三个字符。 */
export function escapeCodeText(value: string): string {
  return value.replace(/[&<>]/g, (ch) => CODE_ESCAPE[ch] ?? ch);
}

/** 从围栏里的 JSON 文本解析规格；坏 JSON / 坏规格返回 null。 */
export function parseDiagramJson(text: unknown): DiagramSpec | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return normalizeDiagramSpec(parsed);
}

export function diagramToJson(spec: DiagramSpec): string {
  return JSON.stringify(spec);
}

/** 插入编辑器/正文的围栏 HTML（`pre > code.language-pp-diagram`）。 */
export function diagramBlockHtml(spec: DiagramSpec): string {
  return `<pre><code class="language-${DIAGRAM_LANGUAGE}">${escapeCodeText(
    diagramToJson(spec),
  )}</code></pre>`;
}

/** 判断一个 code 元素的 class 是否是图表围栏。 */
export function isDiagramCode(element: Element | null): element is HTMLElement {
  if (!element || element.tagName.toLowerCase() !== 'code') return false;
  return element.classList.contains(`language-${DIAGRAM_LANGUAGE}`);
}
