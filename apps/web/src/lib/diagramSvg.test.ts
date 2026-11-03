import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DIAGRAM_SPECS,
  type ChartDiagram,
  type DiagramSpec,
  type FishboneDiagram,
  type LogicDiagram,
  type MindMapDiagram,
} from './diagramSpec';
import { escapeXml, renderDiagramSvg } from './diagramSvg';

/**
 * 图表 SVG 渲染器单测。
 *
 * 渲染器是纯字符串函数：输入图表规格，输出一整段 `<svg>`，不碰 React / DOM。
 * 所以这里只断言字符串结构与转义，不做快照——快照会让 DOM 契约的每一处小调整
 * 都变成噪音，而类名、数量、坐标才是阅读页 `/styles.css` 真正依赖的东西。
 */

const mindmapSpec = (overrides: Partial<MindMapDiagram> = {}): MindMapDiagram => ({
  ...(DEFAULT_DIAGRAM_SPECS.mindmap as MindMapDiagram),
  ...overrides,
});

const logicSpec = (overrides: Partial<LogicDiagram> = {}): LogicDiagram => ({
  ...(DEFAULT_DIAGRAM_SPECS.logic as LogicDiagram),
  ...overrides,
});

const chartSpec = (overrides: Partial<ChartDiagram> = {}): ChartDiagram => ({
  ...(DEFAULT_DIAGRAM_SPECS.chart as ChartDiagram),
  ...overrides,
});

const fishboneSpec = (overrides: Partial<FishboneDiagram> = {}): FishboneDiagram => ({
  ...(DEFAULT_DIAGRAM_SPECS.fishbone as FishboneDiagram),
  ...overrides,
});

const ALL_DEFAULTS: DiagramSpec[] = Object.values(DEFAULT_DIAGRAM_SPECS);

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** 从 `viewBox="0 0 W H"` 取画布尺寸；断言它存在且是正数。 */
function svgSize(svg: string): { width: number; height: number } {
  const match = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  expect(match, '缺少 viewBox="0 0 W H"').not.toBeNull();
  const width = Number(match![1]);
  const height = Number(match![2]);
  expect(Number.isFinite(width) && width > 0, `宽度无效：${width}`).toBe(true);
  expect(Number.isFinite(height) && height > 0, `高度无效：${height}`).toBe(true);
  return { width, height };
}

/** 所有 x / y 属性（含 text、rect、line 的坐标）都非负。 */
function negativeCoordinate(svg: string): string | null {
  const match = /\b(?:x|y)="(-[\d.]+)"/.exec(svg);
  return match ? match[0] : null;
}

describe('escapeXml', () => {
  it('转义 XML 五个保留字符', () => {
    expect(escapeXml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;');
  });

  it('非字符串输入转成文本，null / undefined / 对象不产生 undefined 字面量', () => {
    expect(escapeXml(8)).toBe('8');
    expect(escapeXml(null)).toBe('');
    expect(escapeXml(undefined)).toBe('');
    expect(escapeXml({})).toBe('[object Object]');
  });
});

describe('四类图的基本结构', () => {
  it('每类默认规格都返回完整的 <svg> 文档片段', () => {
    for (const spec of ALL_DEFAULTS) {
      const svg = renderDiagramSvg(spec);
      expect(svg.startsWith('<svg class="pp-diagram-svg"'), spec.type).toBe(true);
      expect(svg.includes('role="img"'), spec.type).toBe(true);
      expect(svg).toMatch(/aria-label="[^"]+"/);
      expect(svg.includes('viewBox="0 0 '), spec.type).toBe(true);
      expect(svg.includes('xmlns="http://www.w3.org/2000/svg"'), spec.type).toBe(true);
      expect(svg.includes('<title>'), spec.type).toBe(true);
      expect(svg.endsWith('</svg>'), spec.type).toBe(true);
      expect(svg.includes('NaN'), spec.type).toBe(false);
      expect(svg.includes('undefined'), spec.type).toBe(false);
      svgSize(svg);
    }
  });

  it('图题画在 SVG 顶部，没有图题时不产生标题文本', () => {
    const titled = renderDiagramSvg(mindmapSpec({ title: '站点结构' }));
    expect(titled.includes('class="pp-diagram-title"')).toBe(true);
    expect(titled.includes('>站点结构<')).toBe(true);
    expect(titled).toMatch(/aria-label="站点结构"/);

    const untitled = renderDiagramSvg(mindmapSpec({ title: '' }));
    expect(untitled.includes('pp-diagram-title')).toBe(false);
    expect(untitled).toMatch(/aria-label="[^"]+"/);
  });

  it('同一输入两次渲染完全相等', () => {
    for (const spec of ALL_DEFAULTS) {
      expect(renderDiagramSvg(spec), spec.type).toBe(renderDiagramSvg(spec));
    }
    for (const kind of ['bar', 'line', 'donut', 'pie'] as const) {
      const spec = chartSpec({ kind });
      expect(renderDiagramSvg(spec), kind).toBe(renderDiagramSvg(spec));
    }
  });

  it('四类图输出都是可解析的合法 SVG', () => {
    for (const spec of ALL_DEFAULTS) {
      const doc = new DOMParser().parseFromString(renderDiagramSvg(spec), 'image/svg+xml');
      expect(doc.querySelector('parsererror'), spec.type).toBeNull();
      expect(doc.documentElement.nodeName.toLowerCase(), spec.type).toBe('svg');
    }
  });
});

describe('思维导图', () => {
  it('节点数 = 大纲节点数，边数 = 节点数 - 1', () => {
    const svg = renderDiagramSvg(mindmapSpec());
    expect(occurrences(svg, 'pp-diagram-node')).toBe(9);
    expect(occurrences(svg, 'pp-diagram-edge')).toBe(8);
    expect(svg.includes('is-root')).toBe(true);
  });

  it('彩色分支用固定 8 色，主题单色不出现十六进制', () => {
    const colorful = renderDiagramSvg(mindmapSpec({ palette: 'colorful' }));
    expect(colorful).toMatch(/#[0-9a-f]{6}/i);

    const theme = renderDiagramSvg(mindmapSpec({ palette: 'theme' }));
    // 主题单色不应出现六位色板颜色；根节点前景用 var(--bg) 反色对，不是固定白。
    expect(theme).not.toMatch(/#[0-9a-f]{6}/i);
    expect(theme.includes('var(--accent)')).toBe(true);
  });

  it('长标签按节点宽度截断并加省略号', () => {
    const svg = renderDiagramSvg(mindmapSpec({ outline: `中心\n  ${'长'.repeat(60)}` }));
    expect(svg.includes('…')).toBe(true);
    expect(occurrences(svg, 'pp-diagram-node')).toBe(2);
  });

  it('右侧展开与两侧展开都保留全部节点', () => {
    for (const layout of ['both', 'right'] as const) {
      const svg = renderDiagramSvg(mindmapSpec({ layout }));
      expect(occurrences(svg, 'pp-diagram-node'), layout).toBe(9);
      expect(occurrences(svg, 'pp-diagram-edge'), layout).toBe(8);
    }
  });

  it('大纲为空时显示占位文本', () => {
    const svg = renderDiagramSvg(mindmapSpec({ outline: '   \n  ' }));
    expect(svg.includes('class="pp-diagram-empty"')).toBe(true);
    expect(occurrences(svg, 'pp-diagram-node')).toBe(0);
    svgSize(svg);
  });
});

describe('逻辑图', () => {
  it('向右的流程带箭头 marker，边数 = 节点数 - 1', () => {
    const svg = renderDiagramSvg(logicSpec({ direction: 'right' }));
    expect(occurrences(svg, 'pp-diagram-node')).toBe(7);
    expect(occurrences(svg, 'pp-diagram-edge')).toBe(6);
    expect(svg.includes('<defs>')).toBe(true);
    expect(svg.includes('id="pp-diagram-arrow"')).toBe(true);
    expect(occurrences(svg, 'marker-end="url(#pp-diagram-arrow)"')).toBe(6);
    expect(svg.includes('is-step')).toBe(true);
  });

  it('向下的流程同样带箭头，且与向右的输出不同', () => {
    const down = renderDiagramSvg(logicSpec({ direction: 'down' }));
    const right = renderDiagramSvg(logicSpec({ direction: 'right' }));
    expect(down).not.toBe(right);
    expect(occurrences(down, 'pp-diagram-node')).toBe(7);
    expect(occurrences(down, 'pp-diagram-edge')).toBe(6);
    expect(occurrences(down, 'marker-end="url(#pp-diagram-arrow)"')).toBe(6);
    expect(negativeCoordinate(down)).toBeNull();
    svgSize(down);
  });

  it('大纲为空时显示占位文本', () => {
    const svg = renderDiagramSvg(logicSpec({ outline: '' }));
    expect(svg.includes('class="pp-diagram-empty"')).toBe(true);
  });
});

describe('统计图', () => {
  it('柱状图：柱数、网格、基线、x 标签与数值标签', () => {
    const svg = renderDiagramSvg(chartSpec({ kind: 'bar' }));
    expect(occurrences(svg, 'class="pp-chart-bar"')).toBe(4);
    expect(occurrences(svg, 'class="pp-chart-grid"')).toBeGreaterThanOrEqual(4);
    expect(occurrences(svg, 'class="pp-chart-axis"')).toBeGreaterThanOrEqual(2);
    expect(occurrences(svg, 'class="pp-chart-label"')).toBeGreaterThanOrEqual(4);
    expect(occurrences(svg, 'class="pp-chart-value"')).toBe(4);
    expect(svg.includes('第一周')).toBe(true);
    expect(svg.includes('128')).toBe(true);
  });

  it('折线图：折线 + 圆点 + 网格', () => {
    const svg = renderDiagramSvg(chartSpec({ kind: 'line' }));
    expect(occurrences(svg, 'class="pp-chart-line"')).toBe(1);
    expect(occurrences(svg, 'class="pp-chart-dot"')).toBe(4);
    expect(occurrences(svg, 'class="pp-chart-grid"')).toBeGreaterThanOrEqual(4);
    expect(svg.includes('第一周')).toBe(true);
    expect(svg.includes('214')).toBe(true);
  });

  it('环形图与饼图：path 圆弧 + 右侧图例（标签 + 数值）', () => {
    for (const kind of ['donut', 'pie'] as const) {
      const svg = renderDiagramSvg(chartSpec({ kind }));
      expect(occurrences(svg, 'class="pp-chart-arc"'), kind).toBe(4);
      expect(occurrences(svg, 'class="pp-chart-legend"'), kind).toBe(1);
      expect(svg.includes('第一周'), kind).toBe(true);
      expect(svg.includes('第四周'), kind).toBe(true);
      expect(svg.includes('214'), kind).toBe(true);
      expect(svg.includes('A '), kind).toBe(true);
    }
  });

  it('单位拼在数值后面', () => {
    const svg = renderDiagramSvg(chartSpec({ kind: 'bar', unit: '次' }));
    expect(svg.includes('128次')).toBe(true);
  });

  it('四种统计类型输出互不相同，且都通过结构断言', () => {
    const outputs = new Set<string>();
    for (const kind of ['bar', 'line', 'donut', 'pie'] as const) {
      const svg = renderDiagramSvg(chartSpec({ kind }));
      outputs.add(svg);
      svgSize(svg);
      expect(svg.includes('NaN')).toBe(false);
    }
    expect(outputs.size).toBe(4);
  });

  it('item 的自定义十六进制颜色生效，非法颜色回退到自动配色', () => {
    const colored = renderDiagramSvg(
      chartSpec({
        items: [
          { label: '甲', value: 3, color: '#ff0000' },
          { label: '乙', value: 5, color: 'red;fill:url(x)' },
        ],
      }),
    );
    expect(colored.includes('#ff0000')).toBe(true);
    expect(colored.includes('red;fill')).toBe(false);
    expect(colored).toMatch(/#[0-9a-f]{6}/i);
  });

  it('空数据与全零数据都显示占位文本', () => {
    expect(renderDiagramSvg(chartSpec({ items: [] })).includes('class="pp-diagram-empty"')).toBe(
      true,
    );
    const zeros = renderDiagramSvg(
      chartSpec({
        kind: 'donut',
        items: [
          { label: '甲', value: 0 },
          { label: '乙', value: 0 },
        ],
      }),
    );
    expect(zeros.includes('class="pp-diagram-empty"')).toBe(true);
  });

  it('负值与坏数值不会产生 NaN / Infinity', () => {
    const svg = renderDiagramSvg(
      chartSpec({
        kind: 'bar',
        items: [
          { label: '降', value: -12 },
          { label: '升', value: 30 },
          { label: '坏', value: Number.NaN },
          { label: '无穷', value: Number.POSITIVE_INFINITY },
        ],
      }),
    );
    expect(svg.includes('NaN')).toBe(false);
    expect(svg.includes('Infinity')).toBe(false);
    svgSize(svg);
    expect(negativeCoordinate(svg)).toBeNull();
  });
});

describe('鱼骨图', () => {
  it('主脊、分类骨、分类名与原因文本', () => {
    const svg = renderDiagramSvg(fishboneSpec());
    expect(occurrences(svg, 'class="pp-fishbone-spine"')).toBe(1);
    expect(occurrences(svg, 'class="pp-fishbone-bone"')).toBe(4);
    expect(occurrences(svg, 'class="pp-fishbone-label"')).toBe(4);
    expect(occurrences(svg, 'class="pp-fishbone-cause"')).toBe(6);
    expect(occurrences(svg, 'class="pp-fishbone-cause-tick"')).toBe(6);
    expect(occurrences(svg, 'class="pp-fishbone-head"')).toBe(1);
    expect(svg.includes('发布为什么总是延期')).toBe(true);
    expect(svg.includes('需求')).toBe(true);
    expect(svg.includes('范围反复变更')).toBe(true);
    expect(svg.includes('并行任务过多')).toBe(true);
  });

  it('分类上下交替：上、下、上、下', () => {
    const svg = renderDiagramSvg(fishboneSpec());
    const labels = [...svg.matchAll(/class="pp-fishbone-label" x="([\d.]+)" y="([\d.]+)"/g)];
    expect(labels.length).toBe(4);
    const ys = labels.map((match) => Number(match[2]));
    expect(ys[0]).toBeLessThan(ys[1]);
    expect(ys[2]).toBeLessThan(ys[1]);
    expect(ys[4 - 1]).toBeGreaterThan(ys[2]);
  });

  it('画布自适应且所有坐标非负', () => {
    const svg = renderDiagramSvg(fishboneSpec());
    expect(negativeCoordinate(svg)).toBeNull();
    const size = svgSize(svg);
    expect(size.width).toBeGreaterThan(size.height);
  });

  it('只有问题、没有分类时仍渲染鱼头', () => {
    const svg = renderDiagramSvg(fishboneSpec({ outline: '只有问题' }));
    expect(svg.includes('class="pp-fishbone-head"')).toBe(true);
    expect(occurrences(svg, 'class="pp-fishbone-bone"')).toBe(0);
    expect(occurrences(svg, 'class="pp-fishbone-cause"')).toBe(0);
    svgSize(svg);
  });

  it('大纲为空时显示占位文本', () => {
    const svg = renderDiagramSvg(fishboneSpec({ outline: '\n  \n' }));
    expect(svg.includes('class="pp-diagram-empty"')).toBe(true);
  });
});

describe('用户文本转义', () => {
  it('大纲里的标签不会变成标签，而是转义后的文本', () => {
    const svg = renderDiagramSvg(mindmapSpec({ outline: '根\n  <script>x</script>' }));
    expect(svg.includes('<script')).toBe(false);
    expect(svg.includes('&lt;script&gt;x&lt;/script&gt;')).toBe(true);
  });

  it('图题同时出现在 aria-label 与 <title> 里并已转义', () => {
    const svg = renderDiagramSvg(mindmapSpec({ title: '<img src=x onerror=alert(1)>' }));
    expect(svg.includes('<img')).toBe(false);
    expect(svg.includes('&lt;img')).toBe(true);
    expect(svg.includes('onerror="')).toBe(false);
  });

  it('带引号的图题不会截断 aria-label 属性', () => {
    const svg = renderDiagramSvg(mindmapSpec({ title: '标题 " onmouseover="alert(1)' }));
    expect(svg.includes('onmouseover="')).toBe(false);
    expect(svg.includes('&quot; onmouseover=&quot;')).toBe(true);
  });

  it('统计图标签同样转义', () => {
    const svg = renderDiagramSvg(
      chartSpec({ items: [{ label: '<b>甲</b>', value: 1 }] }),
    );
    expect(svg.includes('<b>')).toBe(false);
    expect(svg.includes('&lt;b&gt;甲&lt;/b&gt;')).toBe(true);
  });

  it('鱼骨图原因同样转义', () => {
    const svg = renderDiagramSvg(fishboneSpec({ outline: '问题\n  分类\n    <i>原因</i>' }));
    expect(svg.includes('<i>')).toBe(false);
    expect(svg.includes('&lt;i&gt;原因&lt;/i&gt;')).toBe(true);
  });
});

describe('坏数据防御', () => {
  it('不是合法规格时返回占位 SVG 而不是抛错', () => {
    const broken = {} as DiagramSpec;
    expect(() => renderDiagramSvg(broken)).not.toThrow();
    const svg = renderDiagramSvg(broken);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.includes('class="pp-diagram-empty"')).toBe(true);
    svgSize(svg);
  });

  it('未知类型 / 非法枚举值不抛错', () => {
    const weird = {
      type: 'pie-chart',
      title: '奇怪',
      outline: '根\n  子',
      layout: 'left',
      line: 'dotted',
      palette: 'neon',
      direction: 'up',
      kind: 'scatter',
      items: [{ label: '甲', value: 1 }],
    } as unknown as DiagramSpec;
    expect(() => renderDiagramSvg(weird)).not.toThrow();
    expect(renderDiagramSvg(weird).includes('NaN')).toBe(false);
  });

  it('超过图表条目上限时按上限渲染', () => {
    const items = Array.from({ length: 30 }, (_, index) => ({
      label: `项${index + 1}`,
      value: index + 1,
    }));
    const svg = renderDiagramSvg(chartSpec({ items }));
    expect(occurrences(svg, 'class="pp-chart-bar"')).toBe(12);
  });
});
