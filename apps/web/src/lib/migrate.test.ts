import { describe, expect, it } from 'vitest';
import type { WebConfig } from '../types';
import { readCustomization } from './customize';
import { CURRENT_SCHEMA_VERSION, foldDeviceLayouts, migrateCustomization } from './migrate';

function block(id: string, extra: Record<string, unknown> = {}) {
  return { id, type: 'text', title: id, props: {}, animation: 'none', hidden: false, ...extra };
}

/** 深度 `depth` 的单链嵌套：最外层一个区块，children 里再接一个，直到 depth 层。 */
function chain(depth: number): Record<string, unknown> {
  let node = block(`deep-${depth}`);
  for (let level = depth - 1; level >= 0; level -= 1) {
    node = block(`deep-${level}`, { children: [node] });
  }
  return node;
}

describe('migrateCustomization', () => {
  it('给没有版本号的文档补上版本号', () => {
    const { value } = migrateCustomization({ home: { blocks: [] } });
    expect(value.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('已经是 v2 的文档原样返回、不产生报告', () => {
    const input = { schema_version: 2, home: { blocks: [] } };
    const { value, report } = migrateCustomization(input);
    expect(value).toEqual(input);
    expect(report).toEqual([]);
  });

  it('三端编排原样保留：不折算成 at、不删设备树、不产生报告', () => {
    // P0 的验收标准是「v1 配置渲染不变」。渲染层还没开始求值 at，所以这里一旦折算，
    // 用户单独画过的手机布局就会在第一次读入时被桌面版顶掉。
    const home = {
      blocks: [block('a'), block('b')],
      device_split: true,
      devices: {
        desktop: { blocks: [block('a'), block('b')] },
        mobile: { blocks: [block('a'), block('b', { hidden: true })] },
      },
    };
    const { value, report } = migrateCustomization({ home: structuredClone(home) });
    const migrated = value.home as Record<string, unknown>;
    expect(migrated).toEqual(home);
    expect(migrated.device_split).toBe(true);
    expect((migrated.devices as Record<string, unknown>).desktop).toBeDefined();
    expect((migrated.devices as Record<string, unknown>).mobile).toBeDefined();
    expect((migrated.blocks as Array<Record<string, unknown>>)[1].at).toBeUndefined();
    expect(report).toEqual([]);
  });

  it('结构不同的设备编排同样原样保留', () => {
    const home = {
      blocks: [block('a')],
      device_split: true,
      devices: { mobile: { blocks: [block('a'), block('only-mobile')] } },
    };
    const { value, report } = migrateCustomization({ home: structuredClone(home) });
    expect(value.home).toEqual(home);
    expect(report).toEqual([]);
  });

  it('坏数据不抛异常', () => {
    expect(() => migrateCustomization(null)).not.toThrow();
    expect(() => migrateCustomization({ home: 'nope' })).not.toThrow();
  });

  it('不修改调用方传进来的文档（纯函数）', () => {
    const input = {
      home: {
        blocks: [block('a'), block('b')],
        device_split: true,
        devices: {
          desktop: { blocks: [block('a'), block('b')] },
          mobile: { blocks: [block('a'), block('b', { hidden: true })] },
        },
      },
    };
    const snapshot = structuredClone(input);
    migrateCustomization(input);
    expect(input).toEqual(snapshot);
  });

  it('v1 文档在读取时把三端布局折算成 at（因为渲染层已经求值 at）', () => {
    const { value } = migrateCustomization(
      {
        home: {
          blocks: [block('a')],
          device_split: true,
          devices: { mobile: { blocks: [block('a', { hidden: true })] } },
        },
      },
      { foldDevices: true },
    );
    const home = value.home as Record<string, unknown>;
    expect((home.blocks as Array<Record<string, unknown>>)[0].at).toEqual({ mobile: { hidden: true } });
    expect(home.devices).toBeUndefined();
  });

  it('首页之外的编排也折算：文章页与自定义页面，报告逐条带上页面标签', () => {
    const split = () => ({
      blocks: [block('a')],
      device_split: true,
      devices: { mobile: { blocks: [block('a', { hidden: true })] } },
    });
    const { value, report } = migrateCustomization(
      {
        home: split(),
        article: split(),
        pages: [{ id: 'p1', title: '关于', layout: split() }],
      },
      { foldDevices: true },
    );
    expect(report).toHaveLength(3);
    expect(report.every((line) => line.includes('手机'))).toBe(true);
    expect(report.some((line) => line.includes('关于'))).toBe(true);

    const article = value.article as Record<string, unknown>;
    expect(article.devices).toBeUndefined();
    const page = (value.pages as Array<Record<string, unknown>>)[0];
    const layout = page.layout as Record<string, unknown>;
    expect(layout.devices).toBeUndefined();
    expect((layout.blocks as Array<Record<string, unknown>>)[0].at).toEqual({ mobile: { hidden: true } });
    // 页面自身的字段不能被折算顺手改掉。
    expect(page.title).toBe('关于');
  });

  it('打开折算时同样不修改调用方传进来的文档', () => {
    const input = {
      home: {
        blocks: [block('a')],
        device_split: true,
        devices: { mobile: { blocks: [block('a', { hidden: true })] } },
      },
      pages: [
        {
          id: 'p1',
          title: '关于',
          layout: {
            blocks: [block('b')],
            device_split: true,
            devices: { mobile: { blocks: [block('b', { hidden: true })] } },
          },
        },
      ],
    };
    const snapshot = structuredClone(input);
    migrateCustomization(input, { foldDevices: true });
    expect(input).toEqual(snapshot);
  });

  it('对迁移结果再跑一次不产生任何变化（幂等）', () => {
    const once = migrateCustomization({
      home: {
        blocks: [block('a'), block('b')],
        device_split: true,
        devices: { mobile: { blocks: [block('a'), block('b', { hidden: true })] } },
      },
    });
    const twice = migrateCustomization(once.value);
    expect(twice.value).toEqual(once.value);
    expect(twice.report).toEqual([]);
  });
});

describe('foldDeviceLayouts', () => {
  it('三棵树结构完全相同时折算成 at 覆盖并丢掉分设备副本', () => {
    const report: string[] = [];
    const folded = foldDeviceLayouts(
      {
        blocks: [block('a'), block('b')],
        device_split: true,
        devices: {
          desktop: { blocks: [block('a'), block('b')] },
          mobile: { blocks: [block('a'), block('b', { hidden: true })] },
        },
      },
      '首页',
      report,
    ) as Record<string, unknown>;
    const blocks = folded.blocks as Array<Record<string, unknown>>;
    expect(blocks[1].at).toEqual({ mobile: { hidden: true } });
    expect(folded.device_split).toBeUndefined();
    expect(folded.devices).toBeUndefined();
    expect(report.join('')).toContain('手机');
  });

  it('结构不同时保留分设备副本并在报告里说明', () => {
    const report: string[] = [];
    const folded = foldDeviceLayouts(
      {
        blocks: [block('a')],
        device_split: true,
        devices: { mobile: { blocks: [block('a'), block('only-mobile')] } },
      },
      '首页',
      report,
    ) as Record<string, unknown>;
    expect((folded.devices as Record<string, unknown>).mobile).toBeDefined();
    expect(report.join('')).toContain('结构不同');
  });

  it('结构相同但没有任何展示差异的设备直接丢掉、不谎报结构不同', () => {
    const report: string[] = [];
    const folded = foldDeviceLayouts(
      {
        blocks: [block('a')],
        device_split: true,
        devices: { tablet: { blocks: [block('a')] } },
      },
      '首页',
      report,
    ) as Record<string, unknown>;
    expect(folded.devices).toBeUndefined();
    expect(folded.device_split).toBeUndefined();
    expect(report).toEqual([]);
  });

  it('嵌套远超深度上限时不爆栈，并保留设备编排', () => {
    // 40 层深的两棵树：形状比较一旦递归到底就会撑破调用栈，所以必须在深度上限处
    // 停下并回答「证明不了相同」，于是手机端编排原样保住。
    const deep = [chain(40)];
    const run = () => {
      const report: string[] = [];
      return foldDeviceLayouts(
        {
          blocks: structuredClone(deep),
          device_split: true,
          devices: { mobile: { blocks: structuredClone(deep) } },
        },
        '首页',
        report,
      ) as Record<string, unknown>;
    };
    expect(run).not.toThrow();
    const folded = run();
    expect((folded.devices as Record<string, unknown>).mobile).toBeDefined();
  });
});

describe('迁移结果落盘', () => {
  it('读入时带上版本号，再读一次不再重跑迁移', () => {
    const config = {
      version: 1,
      setup_complete: true,
      mode: 'demo',
      api_base: '',
      site_id: 's1',
      database: 'sqlite',
      created_at: '',
      docs_url: '',
      customization: { home: { blocks: [] } },
    } as unknown as WebConfig;

    const once = readCustomization(config);
    // 印记就是「已经迁过」的证据：少了它，每次读取都会把整份迁移再跑一遍。
    expect(once.schema_version).toBe(2);

    const twice = readCustomization({ customization: once });
    expect(twice).toEqual(once);
  });

  it('读取路径显式打开了折算：v1 的三端编排读进来就是 at', () => {
    const config = {
      customization: {
        home: {
          blocks: [block('a')],
          device_split: true,
          devices: { mobile: { blocks: [block('a', { hidden: true })] } },
        },
      },
    } as unknown as WebConfig;

    const customization = readCustomization(config);
    expect(customization.home.blocks[0].at).toEqual({ mobile: { hidden: true } });
    expect(customization.home.device_split).toBeUndefined();
    expect(customization.home.devices).toBeUndefined();
  });
});
