import type { BlockAppearance, BlockDisplayOverride, BlockInstance, BuilderDevice } from '../types';

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

/**
 * 这一层覆盖里真正要写的字段；`desktop` 没有覆盖层。
 *
 * 编辑器靠它判断「这一项是不是当前设备单独设过的」，所以导出：
 * 只有一处知道 `desktop` 没有层的规则，就不会有人在界面里写出 `at.desktop`。
 */
export function overrideOf(block: BlockInstance, device: BuilderDevice): BlockDisplayOverride | undefined {
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

/**
 * 把一条编辑并进已有的覆盖层。
 *
 * 键级替换；`appearance` 是唯一需要再下一层的字段（外观是按字段继承的，整块替换会
 * 把没动过的字段也冻住）。显式 `undefined` 表示「这一项恢复继承」，直接删键。
 */
function mergeOverride(prev: BlockDisplayOverride, patch: BlockDisplayOverride): BlockDisplayOverride {
  const next: BlockDisplayOverride = { ...prev };
  const appearance: BlockAppearance = { ...prev.appearance, ...patch.appearance };
  for (const field of Object.keys(appearance) as (keyof BlockAppearance)[]) {
    if (appearance[field] === undefined) delete appearance[field];
  }

  for (const key of Object.keys(patch) as (keyof BlockDisplayOverride)[]) {
    if (key === 'appearance') continue;
    if (patch[key] === undefined) delete next[key];
    else Object.assign(next, { [key]: patch[key] });
  }

  if ('appearance' in patch) {
    // `appearance: undefined` 是「整组外观恢复继承」，与逐字段的 undefined 不同。
    if (patch.appearance !== undefined && Object.keys(appearance).length) next.appearance = appearance;
    else delete next.appearance;
  }
  return next;
}

/**
 * 写一条展示层编辑，返回新的区块（入参不动）。
 *
 * `desktop` 没有覆盖层，直接并回基础字段——这是「所见即所得」的常见路径，行为与
 * P1 之前一致。其余设备写进 `at[device]`，基础字段一动不动：切设备只是换一层来看，
 * 改坏一台设备不会波及另一台。
 *
 * 空 patch 表示「恢复继承」：删掉该设备的整层覆盖；覆盖变空时连 `at` 一起删掉，
 * 避免配置里留一串空对象。
 */
export function writeOverride(
  block: BlockInstance,
  device: BuilderDevice,
  patch: BlockDisplayOverride,
): BlockInstance {
  if (device === 'desktop') return { ...block, ...patch };

  const at = { ...block.at };
  const merged = Object.keys(patch).length ? mergeOverride(at[device] ?? {}, patch) : {};
  if (Object.keys(merged).length) at[device] = merged;
  else delete at[device];

  const next: BlockInstance = { ...block };
  if (Object.keys(at).length) next.at = at;
  else delete next.at;
  return next;
}
