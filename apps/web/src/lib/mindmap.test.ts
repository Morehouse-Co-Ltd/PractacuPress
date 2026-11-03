import { describe, expect, it } from 'vitest';
import {
  MINDMAP_LIMITS,
  layoutMindMap,
  parseMindMapOutline,
  type MindMapLayout,
  type MindMapNode,
} from './mindmap';

/**
 * 思维导图引擎单测：覆盖大纲解析（缩进、记号、上限、空输入）与布局
 * （向右/两侧、连线数、画布边界、确定性、坏输入不抛错）。
 * 引擎是纯函数，测试不需要任何 DOM / React。
 */

const OUTLINE = '我的站点\n  写作\n    长文\n    随笔\n  阅读\n    书单\n  社区\n    留言\n    友链';

function countNodes(node: MindMapNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

function maxDepth(node: MindMapNode): number {
  return node.children.reduce((deepest, child) => Math.max(deepest, maxDepth(child)), node.depth);
}

function parse(outline: string): MindMapNode {
  const root = parseMindMapOutline(outline);
  expect(root).not.toBeNull();
  return root as MindMapNode;
}

describe('parseMindMapOutline', () => {
  it('第一行是中心主题，两个空格缩进表示下一层', () => {
    const root = parse('中心主题\n  写作\n    长文\n  阅读');
    expect(root.label).toBe('中心主题');
    expect(root.depth).toBe(0);
    expect(root.children.map((child) => child.label)).toEqual(['写作', '阅读']);
    expect(root.children.map((child) => child.depth)).toEqual([1, 1]);
    expect(root.children[0].children.map((child) => child.label)).toEqual(['长文']);
    expect(root.children[0].children[0].depth).toBe(2);
  });

  it('Tab 缩进与两个空格等价，可混合', () => {
    const root = parse('根\n\t子\n\t\t孙\n  另一个子');
    expect(root.children.map((child) => child.label)).toEqual(['子', '另一个子']);
    expect(root.children[0].children[0].label).toBe('孙');
    expect(root.children[0].children[0].depth).toBe(2);
  });

  it('允许 - / * / # 前缀，逐层去掉', () => {
    const root = parse('中心\n  - 甲\n  * 乙\n  # 丙\n    ## 丁');
    expect(root.children.map((child) => child.label)).toEqual(['甲', '乙', '丙']);
    expect(root.children[2].children.map((child) => child.label)).toEqual(['丁']);
  });

  it('跳过空行与只有记号的空行', () => {
    const root = parse('中心\n\n  甲\n   \n  - \n  乙');
    expect(root.children.map((child) => child.label)).toEqual(['甲', '乙']);
  });

  it('去掉首尾空白并把标签截到 60 字', () => {
    expect(parse('  中心  \n    甲  ').label).toBe('中心');
    expect(parse('  中心  \n    甲  ').children[0].label).toBe('甲');
    const long = '一'.repeat(80);
    const root = parse(`中心\n  ${long}`);
    expect(root.children[0].label.length).toBe(MINDMAP_LIMITS.label);
    expect(root.children[0].label).toBe('一'.repeat(MINDMAP_LIMITS.label));
  });

  it('空输入 / 只有空行返回 null', () => {
    expect(parseMindMapOutline('')).toBeNull();
    expect(parseMindMapOutline('   ')).toBeNull();
    expect(parseMindMapOutline(' \n\t\n   \n')).toBeNull();
    expect(parseMindMapOutline('\r\n\r\n')).toBeNull();
  });

  it('超过 80 个节点时截断而不是抛错', () => {
    const lines = ['根', ...Array.from({ length: 200 }, (_, index) => `  节点${index + 1}`)];
    const root = parse(lines.join('\n'));
    expect(countNodes(root)).toBe(MINDMAP_LIMITS.nodes);
    expect(root.children.length).toBe(MINDMAP_LIMITS.nodes - 1);
  });

  it('超过 6 层时截断而不是抛错', () => {
    const lines = ['L0'];
    for (let depth = 1; depth <= 9; depth += 1) lines.push(`${'  '.repeat(depth)}L${depth}`);
    const root = parse(lines.join('\n'));
    expect(maxDepth(root)).toBe(MINDMAP_LIMITS.depth - 1);
    expect(countNodes(root)).toBe(MINDMAP_LIMITS.depth);
  });

  it('缩进跳级时挂到当前最深节点，不产生空洞层级', () => {
    const root = parse('根\n  甲\n      乙');
    expect(root.children.map((child) => child.label)).toEqual(['甲']);
    expect(root.children[0].children[0].label).toBe('乙');
    expect(root.children[0].children[0].depth).toBe(2);
  });

  it('CRLF 换行与坏输入不抛错', () => {
    expect(() => parseMindMapOutline('!!!\n@@@\n- \n###')).not.toThrow();
    expect(() => parseMindMapOutline('根\r\n  甲\r\n    乙')).not.toThrow();
    const root = parse('根\r\n  甲\r\n    乙');
    expect(root.children[0].label).toBe('甲');
    expect(root.children[0].children[0].label).toBe('乙');
  });
});

describe('layoutMindMap', () => {
  it('默认大纲：节点数 = 解析出的节点数，边数 = 节点数 - 1', () => {
    const root = parse(OUTLINE);
    expect(countNodes(root)).toBe(9);
    const layout = layoutMindMap(root);
    expect(layout.nodes.length).toBe(9);
    expect(layout.edges.length).toBe(layout.nodes.length - 1);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it('right 布局：根之外的节点全部在根右侧', () => {
    const root = parse(OUTLINE);
    const layout = layoutMindMap(root, { layout: 'right' });
    const rootNode = layout.nodes[0];
    expect(rootNode.depth).toBe(0);
    for (const node of layout.nodes.slice(1)) {
      expect(node.x).toBeGreaterThanOrEqual(rootNode.x + rootNode.w);
    }
    expect(layout.edges.length).toBe(layout.nodes.length - 1);
  });

  it('both 布局：第一层子节点左右两侧都有', () => {
    const root = parse(OUTLINE);
    const layout = layoutMindMap(root, { layout: 'both' });
    const rootNode = layout.nodes[0];
    const firstLevel = layout.nodes.filter((node) => node.depth === 1);
    expect(firstLevel.length).toBe(3);
    expect(firstLevel.some((node) => node.x + node.w <= rootNode.x)).toBe(true);
    expect(firstLevel.some((node) => node.x >= rootNode.x + rootNode.w)).toBe(true);
    expect(layout.edges.length).toBe(layout.nodes.length - 1);
  });

  it('所有布局/连线组合都满足 边 = 节点 - 1，且路径非空', () => {
    const root = parse(OUTLINE);
    for (const layout of ['both', 'right'] as const) {
      for (const line of ['curve', 'elbow'] as const) {
        const result = layoutMindMap(root, { layout, line });
        expect(result.nodes.length).toBe(countNodes(root));
        expect(result.edges.length).toBe(result.nodes.length - 1);
        expect(result.edges.every((edge) => edge.d.length > 0)).toBe(true);
      }
    }
  });

  it('curve 用三次贝塞尔，elbow 只用直角折线', () => {
    const root = parse(OUTLINE);
    const curve = layoutMindMap(root, { layout: 'both', line: 'curve' });
    expect(curve.edges.every((edge) => edge.d.includes('C'))).toBe(true);
    const elbow = layoutMindMap(root, { layout: 'both', line: 'elbow' });
    expect(elbow.edges.every((edge) => !edge.d.includes('C'))).toBe(true);
    expect(elbow.edges.every((edge) => edge.d.startsWith('M') && edge.d.includes('L'))).toBe(true);
  });

  it('画布覆盖全部节点并留 12px 内边距，坐标非负', () => {
    const root = parse(OUTLINE);
    for (const layout of ['both', 'right'] as const) {
      const result = layoutMindMap(root, { layout });
      for (const node of result.nodes) {
        expect(node.x).toBeGreaterThanOrEqual(12);
        expect(node.y).toBeGreaterThanOrEqual(12);
        expect(node.x + node.w).toBeLessThanOrEqual(result.width - 12 + 1e-6);
        expect(node.y + node.h).toBeLessThanOrEqual(result.height - 12 + 1e-6);
      }
    }
  });

  it('根节点字号 15、其余 13，高度 40 / 32，宽度 clamp 在 56–220', () => {
    const root = parse(OUTLINE);
    const layout = layoutMindMap(root);
    for (const node of layout.nodes) {
      if (node.depth === 0) {
        expect(node.fontSize).toBe(15);
        expect(node.h).toBe(40);
      } else {
        expect(node.fontSize).toBe(13);
        expect(node.h).toBe(32);
      }
      expect(node.w).toBeGreaterThanOrEqual(56);
      expect(node.w).toBeLessThanOrEqual(220);
    }
    const long = layoutMindMap(parse(`中心\n  ${'长'.repeat(60)}`));
    expect(long.nodes[1].w).toBe(220);
  });

  it('同一输入多次调用结果完全一致', () => {
    const root = parse(OUTLINE);
    expect(layoutMindMap(root)).toEqual(layoutMindMap(root));
    expect(layoutMindMap(root, { layout: 'right', line: 'elbow' })).toEqual(
      layoutMindMap(root, { layout: 'right', line: 'elbow' }),
    );
    expect(parseMindMapOutline(OUTLINE)).toEqual(parseMindMapOutline(OUTLINE));
  });

  it('单节点也能布局：0 条边，画布仍有尺寸', () => {
    const layout = layoutMindMap(parse('只有主题'));
    expect(layout.nodes).toHaveLength(1);
    expect(layout.edges).toEqual([]);
    expect(layout.nodes[0].x).toBe(12);
    expect(layout.nodes[0].y).toBe(12);
    expect(layout.width).toBeGreaterThan(56);
    expect(layout.height).toBe(64);
  });

  it('坏输入不抛错', () => {
    expect(() => layoutMindMap({} as MindMapNode)).not.toThrow();
    expect(layoutMindMap({} as MindMapNode).nodes).toEqual([]);
    const broken = {
      label: '根',
      depth: 0,
      children: [null as unknown as MindMapNode],
    } satisfies MindMapNode;
    expect(() => layoutMindMap(broken)).not.toThrow();
    expect(layoutMindMap(broken).nodes).toHaveLength(1);
  });

  it('边总是从父节点边缘连到子节点边缘', () => {
    const root = parse('中心\n  右一\n  右二');
    const layout = layoutMindMap(root, { layout: 'right' });
    const rootNode = layout.nodes[0];
    for (const edge of layout.edges) {
      expect(edge.d.startsWith(`M ${rootNode.x + rootNode.w}`)).toBe(true);
    }
  });
});

describe('MindMapLayout 结构', () => {
  it('布局结果字段完整，key 唯一，branch 从第一层分支继承', () => {
    const layout = layoutMindMap(parse(OUTLINE));
    const keys = new Set(layout.nodes.map((node) => node.key));
    expect(keys.size).toBe(layout.nodes.length);
    expect(new Set(layout.edges.map((edge) => edge.key)).size).toBe(layout.edges.length);

    const root = layout.nodes[0];
    expect(root.branch).toBe(0);
    const firstLevel = layout.nodes.filter((node) => node.depth === 1);
    expect(firstLevel.map((node) => node.branch)).toEqual([0, 1, 2]);
    for (const node of layout.nodes) {
      expect(typeof node.label).toBe('string');
      expect(Number.isFinite(node.x) && Number.isFinite(node.y)).toBe(true);
      expect(node.w).toBeGreaterThan(0);
      expect(node.h).toBeGreaterThan(0);
    }
    const edge: MindMapLayout['edges'][number] = layout.edges[0];
    expect(edge.branch).toBeGreaterThanOrEqual(0);
  });
});
