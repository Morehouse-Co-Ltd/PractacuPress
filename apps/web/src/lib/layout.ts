import type { BlockDisplayOverride, BlockInstance, BuilderDevice } from '../types';

/**
 * 断点的唯一来源。
 *
 * P0 之前仓库里有两套：`builderDeviceForWidth` 用 640、思维链的 `is_mobile` 用 768。
 * 两套阈值意味着"同一台设备在编排器和逻辑链里身份不同"，这里统一。
 */
export const BREAKPOINT_SM = 480;
export const BREAKPOINT_MD = 768;
export const BREAKPOINT_LG = 1024;

/** 间距标尺：新字段存的是这个数组的下标，不是像素。 */
export const SPACING_SCALE: readonly number[] = [0, 4, 8, 12, 16, 24, 32, 48, 64, 96];

/** 档位下标 → 像素；非法档位返回 undefined（调用方按"未设置"处理）。 */
export function spacingPx(index: unknown): number | undefined {
  if (typeof index !== 'number' || !Number.isInteger(index)) return undefined;
  if (index < 0 || index >= SPACING_SCALE.length) return undefined;
  return SPACING_SCALE[index];
}

/** 这一层覆盖里真正要写的字段；`desktop` 没有覆盖层。 */
function overrideOf(block: BlockInstance, device: BuilderDevice): BlockDisplayOverride | undefined {
  if (device === 'desktop') return undefined;
  return block.at?.[device];
}

/**
 * 把某个设备的覆盖层叠到区块上。
 *
 * 只叠展示层（`BlockDisplayOverride` 声明的字段），`props` 永远只有一份——
 * 这是 P0 定下的规矩，内容双源是三端布局当年失控的根因。
 */
export function overlayAt(block: BlockInstance, device: BuilderDevice): BlockInstance {
  const override = overrideOf(block, device);
  const children = block.children?.map((child) => overlayAt(child, device));
  const base: BlockInstance = children && children !== block.children ? { ...block, children } : block;
  if (!override) return base;

  const next: BlockInstance = { ...base };
  if (override.span) next.span = override.span;
  if (override.align) next.align = override.align;
  if (override.animation) next.animation = override.animation;
  if (override.hidden !== undefined) next.hidden = override.hidden;
  if (override.custom_css) next.custom_css = override.custom_css;
  if (override.width !== undefined) next.width = override.width;
  if (override.height !== undefined) next.height = override.height;
  if (override.gap_scale !== undefined) next.gap_scale = override.gap_scale;
  if (override.mt !== undefined) next.mt = override.mt;
  if (override.mb !== undefined) next.mb = override.mb;
  if (override.appearance) next.appearance = { ...base.appearance, ...override.appearance };
  return next;
}

/** 批量叠覆盖；渲染入口调用它一次，子树里就不再关心设备。 */
export function applyDisplayOverrides(
  blocks: BlockInstance[],
  device: BuilderDevice,
): BlockInstance[] {
  if (device === 'desktop') return blocks;
  return blocks.map((block) => overlayAt(block, device));
}
