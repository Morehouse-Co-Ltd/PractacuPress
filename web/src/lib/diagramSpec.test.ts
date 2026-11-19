import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DIAGRAM_SPECS,
  DIAGRAM_LIMITS,
  diagramBlockHtml,
  normalizeDiagramSpec,
  parseChartData,
  parseDiagramJson,
  serializeChartData,
} from './diagramSpec';

describe('图表规格归一化', () => {
  it('接受四类合法规格（空图题/空单位会被省略）', () => {
    for (const spec of Object.values(DEFAULT_DIAGRAM_SPECS)) {
      const normalized = normalizeDiagramSpec(spec);
      expect(normalized).not.toBeNull();
      expect(normalized?.type).toBe(spec.type);
      if (normalized?.type === 'mindmap') {
        expect(normalized.outline).toBe((spec as { outline: string }).outline);
      }
      if (normalized?.type === 'chart') {
        expect(normalized.items).toHaveLength((spec as { items: unknown[] }).items.length);
      }
    }
  });

  it('拒绝未知类型与空大纲', () => {
    expect(normalizeDiagramSpec({ type: 'pie-chart' })).toBeNull();
    expect(normalizeDiagramSpec({ type: 'mindmap', outline: '   ' })).toBeNull();
    expect(normalizeDiagramSpec({ type: 'fishbone', outline: '' })).toBeNull();
    expect(normalizeDiagramSpec(null)).toBeNull();
    expect(normalizeDiagramSpec([])).toBeNull();
  });

  it('枚举越界回落到默认值，标题去空白并截断', () => {
    const spec = normalizeDiagramSpec({
      type: 'mindmap',
      outline: '中心\n  分支',
      layout: 'diagonal',
      line: 'straight',
      palette: 'rainbow',
      title: `  ${'x'.repeat(DIAGRAM_LIMITS.title + 20)}  `,
    });
    expect(spec).toMatchObject({ layout: 'both', line: 'curve', palette: 'colorful' });
    const title = (spec as { title?: string }).title ?? '';
    expect(title.length).toBeLessThanOrEqual(DIAGRAM_LIMITS.title);
    expect(title.startsWith('x')).toBe(true);
  });

  it('图表数据限制条数、过滤坏项、只收十六进制覆盖色', () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      label: `第 ${index + 1} 项`,
      value: index,
      color: index % 2 ? '#aabbcc' : 'red',
    }));
    const spec = normalizeDiagramSpec({ type: 'chart', kind: 'bar', items });
    expect(spec?.type).toBe('chart');
    if (spec?.type !== 'chart') return;
    expect(spec.items).toHaveLength(DIAGRAM_LIMITS.chartItems);
    expect(spec.items[1].color).toBe('#aabbcc');
    expect(spec.items[0].color).toBeUndefined();
  });

  it('图表允许空数据（阅读页显示占位）', () => {
    const spec = normalizeDiagramSpec({ type: 'chart', kind: 'donut', items: [] });
    expect(spec).toEqual({ type: 'chart', kind: 'donut', items: [] });
  });
});

describe('围栏互转', () => {
  it('diagramBlockHtml 生成白名单内的 pre > code，并转义危险字符', () => {
    const html = diagramBlockHtml({
      type: 'chart',
      kind: 'bar',
      items: [{ label: '</code><img onerror=alert(1)>', value: 3 }],
    });
    expect(html.startsWith('<pre><code class="language-pp-diagram">')).toBe(true);
    expect(html.endsWith('</code></pre>')).toBe(true);
    expect(html).toContain('&lt;/code&gt;');
    expect(html).not.toContain('<img');
  });

  it('生成的围栏内容能被解析回同等规格', () => {
    const spec = {
      type: 'fishbone' as const,
      title: '延期原因',
      outline: '为什么延期\n  需求\n    范围变更\n  流程\n    返工',
    };
    const html = diagramBlockHtml(spec);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const code = doc.querySelector('code.language-pp-diagram');
    expect(code).not.toBeNull();
    expect(parseDiagramJson(code?.textContent)).toEqual(spec);
  });

  it('坏 JSON 返回 null，不抛错', () => {
    expect(parseDiagramJson('{oops')).toBeNull();
    expect(parseDiagramJson('')).toBeNull();
    expect(parseDiagramJson(undefined)).toBeNull();
  });
});

describe('图表数据行解析', () => {
  it('支持逗号 / 全角逗号 / 空格分隔与小数、负数', () => {
    const items = parseChartData('一月,12\n二月，18.5\n三月 9\n四月\t-3\n坏行没有数字');
    expect(items).toEqual([
      { label: '一月', value: 12 },
      { label: '二月', value: 18.5 },
      { label: '三月', value: 9 },
      { label: '四月', value: -3 },
    ]);
  });

  it('超过上限截断，并忽略空标签', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `项 ${index}, ${index}`).join('\n');
    expect(parseChartData(lines)).toHaveLength(DIAGRAM_LIMITS.chartItems);
    expect(parseChartData(', 12\n  , 3')).toEqual([]);
  });

  it('序列化后能再次解析（往返一致）', () => {
    const items = [
      { label: '写作', value: 12 },
      { label: '阅读', value: 30 },
    ];
    expect(parseChartData(serializeChartData(items))).toEqual(items);
  });
});
