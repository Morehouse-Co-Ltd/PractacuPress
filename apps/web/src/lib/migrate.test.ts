import { describe, expect, it } from 'vitest';
import type { WebConfig } from '../types';
import { readCustomization } from './customize';
import { CURRENT_SCHEMA_VERSION, migrateCustomization } from './migrate';

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

  it('三棵树结构完全相同时折算成 at 覆盖并丢掉分设备副本', () => {
    const { value, report } = migrateCustomization({
      home: {
        blocks: [block('a'), block('b')],
        device_split: true,
        devices: {
          desktop: { blocks: [block('a'), block('b')] },
          mobile: { blocks: [block('a'), block('b', { hidden: true })] },
        },
      },
    });
    const home = value.home as Record<string, unknown>;
    const blocks = home.blocks as Array<Record<string, unknown>>;
    expect(blocks[1].at).toEqual({ mobile: { hidden: true } });
    expect(home.device_split).toBeUndefined();
    expect(home.devices).toBeUndefined();
    expect(report.join('')).toContain('手机');
  });

  it('结构不同时保留分设备副本并在报告里说明', () => {
    const { value, report } = migrateCustomization({
      home: {
        blocks: [block('a')],
        device_split: true,
        devices: { mobile: { blocks: [block('a'), block('only-mobile')] } },
      },
    });
    const home = value.home as Record<string, unknown>;
    expect((home.devices as Record<string, unknown>).mobile).toBeDefined();
    expect(report.join('')).toContain('结构不同');
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

  it('结构相同但没有任何展示差异的设备直接丢掉、不谎报结构不同', () => {
    const { value, report } = migrateCustomization({
      home: {
        blocks: [block('a')],
        device_split: true,
        devices: { tablet: { blocks: [block('a')] } },
      },
    });
    const home = value.home as Record<string, unknown>;
    expect(home.devices).toBeUndefined();
    expect(home.device_split).toBeUndefined();
    expect(report).toEqual([]);
  });

  it('嵌套远超深度上限时不爆栈，并保留设备编排', () => {
    // 40 层深的两棵树：形状比较一旦递归到底就会撑破调用栈，所以必须在深度上限处
    // 停下并回答「证明不了相同」，于是手机端编排原样保住。
    const deep = [chain(40)];
    const run = () =>
      migrateCustomization({
        home: {
          blocks: structuredClone(deep),
          device_split: true,
          devices: { mobile: { blocks: structuredClone(deep) } },
        },
      });
    expect(run).not.toThrow();
    const home = run().value.home as Record<string, unknown>;
    expect((home.devices as Record<string, unknown>).mobile).toBeDefined();
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
});
