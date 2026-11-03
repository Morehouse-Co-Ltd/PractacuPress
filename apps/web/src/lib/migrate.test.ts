import { describe, expect, it } from 'vitest';
import type { BlockDisplayOverride, WebConfig } from '../types';
import { readCustomization } from './customize';
import {
  CURRENT_SCHEMA_VERSION,
  DISPLAY_KEYS,
  foldDeviceLayouts,
  migrateCustomization,
} from './migrate';

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

  it('v2 文档里残留的 device_split 同样折算（§5.3：不再只在 v1 上折）', () => {
    // P1 之前编辑器一直在生成三棵树，这些文档的 schema_version 已经是 2。
    // 只看版本号的话，它们永远不会折，两套模型就一直并存。
    const { value, report } = migrateCustomization(
      {
        schema_version: CURRENT_SCHEMA_VERSION,
        home: {
          blocks: [block('a'), block('b')],
          device_split: true,
          devices: { mobile: { blocks: [block('a'), block('b', { hidden: true })] } },
        },
      },
      { foldDevices: true },
    );
    const home = value.home as Record<string, unknown>;
    expect(home.device_split).toBeUndefined();
    expect(home.devices).toBeUndefined();
    expect((home.blocks as Array<Record<string, unknown>>)[1].at).toEqual({ mobile: { hidden: true } });
    expect(report.join('')).toContain('手机');
  });

  it('v2 文档里真正不同的设备树仍然保留并报告（守卫不变）', () => {
    const { value, report } = migrateCustomization(
      {
        schema_version: CURRENT_SCHEMA_VERSION,
        home: {
          blocks: [block('a')],
          device_split: true,
          devices: { mobile: { blocks: [{ ...block('a'), title: '手机版标题' }] } },
        },
      },
      { foldDevices: true },
    );
    const home = value.home as Record<string, unknown>;
    expect(home.device_split).toBe(true);
    expect((home.devices as Record<string, unknown>).mobile).toBeDefined();
    expect((home.blocks as Array<Record<string, unknown>>)[0].at).toBeUndefined();
    expect(report.join('')).toContain('内容');
  });

  it('关闭折算时 v2 文档原样返回（编辑器只读不写 device_split）', () => {
    const input = {
      schema_version: CURRENT_SCHEMA_VERSION,
      home: {
        blocks: [block('a')],
        device_split: true,
        devices: { mobile: { blocks: [block('a', { hidden: true })] } },
      },
    };
    const { value, report } = migrateCustomization(structuredClone(input));
    expect(value).toEqual(input);
    expect(report).toEqual([]);
  });

  it('桌面编辑在 devices.desktop 里时以它为准（不退回旧快照）', () => {
    // layout.blocks 只是「打开分端那一刻」的快照，之后的桌面编辑进了 devices.desktop。
    // 两边结构一致时若仍拿快照当基础，站点会悄悄退回旧内容。
    const { value } = migrateCustomization(
      {
        home: {
          blocks: [block('a')],
          device_split: true,
          devices: {
            desktop: { blocks: [{ ...block('a'), title: '桌面新标题' }] },
            mobile: { blocks: [{ ...block('a'), title: '桌面新标题' }] },
          },
        },
      },
      { foldDevices: true },
    );
    const home = value.home as Record<string, unknown>;
    const blocks = home.blocks as Array<Record<string, unknown>>;
    expect(blocks[0].title).toBe('桌面新标题');
    expect(home.device_split).toBeUndefined();
  });

  it('桌面版自己改过内容、手机版又不一样：两边都保住', () => {
    // 基础编排取 devices.desktop，手机版与它内容不同 → 保留手机版树（因此仍带 device_split）。
    const { value, report } = migrateCustomization(
      {
        home: {
          blocks: [block('a')],
          device_split: true,
          devices: {
            desktop: { blocks: [{ ...block('a'), title: '桌面新标题' }] },
            mobile: { blocks: [block('a')] },
          },
        },
      },
      { foldDevices: true },
    );
    const home = value.home as Record<string, unknown>;
    expect((home.blocks as Array<Record<string, unknown>>)[0].title).toBe('桌面新标题');
    expect((home.devices as Record<string, unknown>).mobile).toBeDefined();
    expect(home.device_split).toBe(true);
    expect(report.join('')).toContain('内容');
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

  it('同结构但内容不同：不折算、保留设备树、写进报告', () => {
    // v1 把用户编辑过的整棵树写进 devices[device].blocks：id 与嵌套都能对上，
    // 但标题/props 这些 at 装不下的字段可能已经不一样。折算 = 静默删掉那份内容。
    const report: string[] = [];
    const folded = foldDeviceLayouts(
      {
        blocks: [block('a')],
        device_split: true,
        devices: { mobile: { blocks: [{ ...block('a'), title: '手机版标题' }] } },
      },
      '首页',
      report,
    ) as Record<string, unknown>;
    expect(folded.devices).toBeDefined();
    expect((folded.devices as Record<string, unknown>).mobile).toBeDefined();
    expect((folded.blocks as Array<Record<string, unknown>>)[0].at).toBeUndefined();
    expect(report.join('')).toContain('内容');
  });

  it('内容不同就整端不折算：展示层的差异也不写成 at（不留半折算的树）', () => {
    const report: string[] = [];
    const folded = foldDeviceLayouts(
      {
        blocks: [block('a')],
        device_split: true,
        devices: { mobile: { blocks: [{ ...block('a'), title: '手机版标题', hidden: true }] } },
      },
      '首页',
      report,
    ) as Record<string, unknown>;
    expect((folded.blocks as Array<Record<string, unknown>>)[0].at).toBeUndefined();
    expect((folded.devices as Record<string, unknown>).mobile).toBeDefined();
    expect(report.join('')).toContain('内容');
  });

  it('嵌套子区块的 props 不同同样算内容不同', () => {
    const report: string[] = [];
    const folded = foldDeviceLayouts(
      {
        blocks: [block('a', { children: [block('c', { props: { text: '桌面版' } })] })],
        device_split: true,
        devices: {
          mobile: { blocks: [block('a', { children: [block('c', { props: { text: '手机版' } })] })] },
        },
      },
      '首页',
      report,
    ) as Record<string, unknown>;
    expect((folded.devices as Record<string, unknown>).mobile).toBeDefined();
    expect(report.join('')).toContain('内容');
  });

  it('只有 offset 不同的设备树照常折算，offset 作为 at 补丁活下来', () => {
    // 曾经静默丢数据的那个用例：offset 不在展示键里 → 折算时算不出补丁 → 设备树照样被删，
    // 手机端的起始列偏移就此消失。
    const { value, report } = migrateCustomization(
      {
        home: {
          blocks: [block('a')],
          device_split: true,
          devices: { mobile: { blocks: [block('a', { offset: { base: 3 } })] } },
        },
      },
      { foldDevices: true },
    );
    const home = value.home as Record<string, unknown>;
    expect(home.device_split).toBeUndefined();
    expect(home.devices).toBeUndefined();
    expect((home.blocks as Array<Record<string, unknown>>)[0].at).toEqual({
      mobile: { offset: { base: 3 } },
    });
    expect(report.join('')).toContain('手机');
  });

  it('折算出来的 offset 活过归一化：读一次再保存不会丢', () => {
    const customization = readCustomization({
      customization: {
        home: {
          blocks: [block('a')],
          device_split: true,
          devices: { mobile: { blocks: [block('a', { offset: { base: 3 } })] } },
        },
      },
    } as unknown as WebConfig);
    expect(customization.home.blocks[0].at).toEqual({ mobile: { offset: { base: 3 } } });
    expect(customization.home.devices).toBeUndefined();
  });

  it('只有 align 不同的设备树照常折算，align 留在 at 里', () => {
    const { value, report } = migrateCustomization(
      {
        home: {
          blocks: [block('a')],
          device_split: true,
          devices: { mobile: { blocks: [block('a', { align: 'center' })] } },
        },
      },
      { foldDevices: true },
    );
    const home = value.home as Record<string, unknown>;
    expect(home.devices).toBeUndefined();
    expect((home.blocks as Array<Record<string, unknown>>)[0].at).toEqual({
      mobile: { align: 'center' },
    });
    expect(report.join('')).toContain('手机');
  });

  it('只有 visible 不同的设备树不折算：条件显示是 at 装不下的内容差异', () => {
    // visible 进不了 at；折了就等于把「手机上才显示」这个决定删掉。
    const { value, report } = migrateCustomization(
      {
        home: {
          blocks: [block('a')],
          device_split: true,
          devices: { mobile: { blocks: [block('a', { visible: { devices: ['mobile'] } })] } },
        },
      },
      { foldDevices: true },
    );
    const home = value.home as Record<string, unknown>;
    expect(home.device_split).toBe(true);
    expect((home.devices as Record<string, unknown>).mobile).toBeDefined();
    expect((home.blocks as Array<Record<string, unknown>>)[0].at).toBeUndefined();
    expect(report.join('')).toContain('内容');
  });

  it('子区块只有展示层差异时照常折算：内容守卫比的是内容，不是整棵子树', () => {
    // 这条锁住 CONTENT_KEYS 不列 `children` 的决定：若整棵子树一起 JSON 比较，
    // 子区块的 offset 会把这次合法的折算判成「内容不同」。
    const { value } = migrateCustomization(
      {
        home: {
          blocks: [block('grid', { children: [block('c')] })],
          device_split: true,
          devices: {
            mobile: {
              blocks: [block('grid', { children: [block('c', { offset: { base: 2 } })] })],
            },
          },
        },
      },
      { foldDevices: true },
    );
    const home = value.home as Record<string, unknown>;
    expect(home.devices).toBeUndefined();
    const parent = (home.blocks as Array<Record<string, unknown>>)[0];
    expect((parent.children as Array<Record<string, unknown>>)[0].at).toEqual({
      mobile: { offset: { base: 2 } },
    });
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

  it('读取路径对 v2 文档同样折算残留的 device_split（§5.3）', () => {
    const config = {
      customization: {
        schema_version: 2,
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

describe('DISPLAY_KEYS 与 BlockDisplayOverride 保持同步', () => {
  it('BlockDisplayOverride 的每个键都在 DISPLAY_KEYS 里', () => {
    // 每个键都写满：下面比的是键集合本身，多一个少一个都会红。
    // `satisfies` 管值类型，`Record<keyof BlockDisplayOverride, unknown>` 管「一个都不能少」——
    // 后者是类型层的那道闸：未来给 BlockDisplayOverride 加了字段，这个字面量先编译不过
    // （`npm run typecheck`），不会等到线上才发现折算把新字段吃掉。
    const sample = {
      span: { base: 6 },
      offset: { base: 1 },
      appearance: { radius: 'md' },
      animation: 'fade',
      hidden: true,
      custom_css: '.x { color: red; }',
      width: 320,
      height: 240,
      align: 'center',
      gap_scale: 2,
      mt: 1,
      mb: 1,
    } satisfies BlockDisplayOverride;
    const complete: Record<keyof BlockDisplayOverride, unknown> = sample;
    expect(Object.keys(complete).sort()).toEqual([...DISPLAY_KEYS].sort());
  });
});
