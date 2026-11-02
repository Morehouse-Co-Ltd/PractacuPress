import { describe, expect, it } from 'vitest';
import {
  builderDeviceForWidth,
  cloneBlocks,
  createBlock,
  defaultHomeLayout,
  screenBlocksForDevice,
  screenHasBlocks,
} from './blocks';
import { readCustomization } from './customize';

function layoutWithDevices() {
  const desktop = [createBlock('text', { title: '桌面文案' })];
  const mobile = [createBlock('text', { title: '手机文案' })];
  return {
    blocks: desktop,
    device_split: true as const,
    devices: {
      desktop: { blocks: desktop },
      mobile: { blocks: mobile },
    },
  };
}

describe('按设备选择页面编排', () => {
  it('按宽度归类设备', () => {
    expect(builderDeviceForWidth(1440)).toBe('desktop');
    expect(builderDeviceForWidth(900)).toBe('tablet');
    expect(builderDeviceForWidth(390)).toBe('mobile');
  });

  it('开启分割后取对应设备，缺失设备回退桌面', () => {
    const layout = layoutWithDevices();
    expect(screenBlocksForDevice(layout, 'desktop')[0].title).toBe('桌面文案');
    expect(screenBlocksForDevice(layout, 'mobile')[0].title).toBe('手机文案');
    expect(screenBlocksForDevice(layout, 'tablet')[0].title).toBe('桌面文案');
  });

  it('关闭分割时始终共用 blocks', () => {
    const layout = { ...layoutWithDevices(), device_split: false };
    expect(screenBlocksForDevice(layout, 'mobile')[0].title).toBe('桌面文案');
  });

  it('screenHasBlocks 识别只有设备版有内容的情况', () => {
    expect(screenHasBlocks(defaultHomeLayout('classic'))).toBe(true);
    expect(screenHasBlocks({ blocks: [] })).toBe(false);
    expect(
      screenHasBlocks({
        blocks: [],
        device_split: true,
        devices: { mobile: { blocks: [createBlock('text')] } },
      }),
    ).toBe(true);
  });

  it('cloneBlocks 不共享对象引用', () => {
    const source = [createBlock('text')];
    const cloned = cloneBlocks(source);
    cloned[0].title = '改过的';
    expect(source[0].title).not.toBe('改过的');
  });

  it('配置归一化保留 device_split 与各设备编排', () => {
    const layout = layoutWithDevices();
    const customization = readCustomization({
      customization: {
        home: layout,
      },
    } as never);
    expect(customization.home.device_split).toBe(true);
    // 桌面副本与 blocks 结构一致，v1→v2 迁移判定它冗余并折算掉；桌面视图回退到 blocks。
    expect(customization.home.devices?.desktop).toBeUndefined();
    expect(customization.home.blocks[0].title).toBe('桌面文案');
    // 手机编排是另一棵树（结构不同），迁移按约定原样保留。
    expect(customization.home.devices?.mobile?.blocks[0].title).toBe('手机文案');

    const shared = readCustomization({
      customization: {
        home: { blocks: [createBlock('text')], device_split: false, devices: layout.devices },
      },
    } as never);
    expect(shared.home.device_split).toBeUndefined();
    expect(shared.home.devices).toBeUndefined();
  });

  it('迁移折算出来的 at 经过归一化仍然保留', () => {
    const desktop = [createBlock('text', { title: '共用文案' })];
    const mobile = [{ ...desktop[0], hidden: true }];
    const customization = readCustomization({
      customization: {
        home: {
          blocks: desktop,
          device_split: true,
          devices: { desktop: { blocks: desktop }, mobile: { blocks: mobile } },
        },
      },
    } as never);
    // 折算进 at 的差异必须活过归一化，否则读一次再保存就永久丢掉手机端的外观设置。
    expect(customization.home.blocks[0].at).toEqual({ mobile: { hidden: true } });
    expect(customization.home.device_split).toBeUndefined();
    expect(customization.home.devices).toBeUndefined();
  });
});
