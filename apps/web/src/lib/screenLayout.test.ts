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
import { foldDeviceLayouts } from './migrate';

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

  it('编排器与思维链共用同一张断点表（手机阈值 768）', () => {
    // P1 把 640 收敛到 BREAKPOINT_MD：700px 以前算平板，现在算手机。
    expect(builderDeviceForWidth(700)).toBe('mobile');
    expect(builderDeviceForWidth(768)).toBe('tablet');
    // 桌面闸门同理：1023 还是平板，1024 起才是桌面。
    expect(builderDeviceForWidth(1023)).toBe('tablet');
    expect(builderDeviceForWidth(1024)).toBe('desktop');
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

  it('读取路径折算三端编排：结构相同的设备副本变成 at 覆盖', () => {
    const desktop = [createBlock('text', { title: '桌面文案' })];
    const customization = readCustomization({
      customization: {
        home: {
          blocks: desktop,
          device_split: true,
          devices: {
            desktop: { blocks: desktop },
            mobile: { blocks: [{ ...desktop[0], hidden: true }] },
          },
        },
      },
    } as never);
    // Task 6 打开了折算：渲染层已经求值 at，所以读入时就是「一份 base + at 覆盖」。
    expect(customization.home.device_split).toBeUndefined();
    expect(customization.home.devices).toBeUndefined();
    expect(customization.home.blocks[0].at).toEqual({ mobile: { hidden: true } });
  });

  it('结构对不上的设备编排读入时仍然保留（折算不敢动它）', () => {
    const layout = layoutWithDevices();
    const customization = readCustomization({
      customization: {
        home: layout,
      },
    } as never);
    // 桌面副本与 base 同 id：结构相同，折算时丢掉。
    expect(customization.home.devices?.desktop).toBeUndefined();
    // 手机那份是另建的区块（id 不同 = 结构不同），原样保留，交给人决定。
    expect(customization.home.blocks[0].title).toBe('桌面文案');
    expect(customization.home.devices?.mobile?.blocks[0].title).toBe('手机文案');
    expect(customization.home.device_split).toBe(true);

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
    // P1 会在渲染 at 之前调用 foldDeviceLayouts；这个用例守的是「折算结果读一次不丢」。
    const folded = foldDeviceLayouts(
      { blocks: desktop, device_split: true, devices: { desktop: { blocks: desktop }, mobile: { blocks: mobile } } },
      '首页',
      [],
    ) as Record<string, unknown>;
    const customization = readCustomization({ customization: { home: folded } } as never);
    // 折算进 at 的差异必须活过归一化，否则读一次再保存就永久丢掉手机端的外观设置。
    expect(customization.home.blocks[0].at).toEqual({ mobile: { hidden: true } });
    expect(customization.home.device_split).toBeUndefined();
    expect(customization.home.devices).toBeUndefined();
  });
});
