import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, migrateCustomization } from './migrate';

function block(id: string, extra: Record<string, unknown> = {}) {
  return { id, type: 'text', title: id, props: {}, animation: 'none', hidden: false, ...extra };
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
});
