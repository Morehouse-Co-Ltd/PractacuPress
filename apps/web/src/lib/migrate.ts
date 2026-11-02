import type { BlockInstance, ScreenLayout } from '../types';
import { MAX_BLOCK_DEPTH } from './blockTree';

/**
 * 设计文档的结构版本。
 *
 * 1 → 2：三端「整棵树复制三份」改为「一份基础编排 + 展示层覆盖」。
 * 迁移只在结构完全一致时折算；结构不同的设备编排保留，写进报告交给用户决定。
 */
export const CURRENT_SCHEMA_VERSION = 2;

export interface MigrationResult {
  value: Record<string, unknown>;
  /** 给用户看的中文提示；空数组表示这次读取不需要打扰用户。 */
  report: string[];
}

/** 允许被 at 覆盖的展示层字段。 */
const DISPLAY_KEYS = [
  'span',
  'appearance',
  'animation',
  'hidden',
  'custom_css',
  'width',
  'height',
] as const;

const DEVICE_LABEL: Record<string, string> = { tablet: '平板', mobile: '手机' };

/** 只有这两端会折算成 at；桌面版本就是 blocks 本身。 */
const OVERRIDE_DEVICES = ['tablet', 'mobile'] as const;

function childrenOf(block: unknown): BlockInstance[] {
  if (!block || typeof block !== 'object') return [];
  const children = (block as BlockInstance).children;
  return Array.isArray(children) ? children : [];
}

/**
 * 两棵树是否「同一批区块、同一种嵌套」；只有此时折算才不改变任何人的布局。
 *
 * 这里走的是原始文档，早于归一化的深度裁剪；超过 MAX_BLOCK_DEPTH 一律回答
 * 「证明不了形状相同」，于是设备编排按原样保留——宁可多留一份，也不能错折。
 */
function sameShape(a: unknown[], b: unknown[], depth = 0): boolean {
  if (depth >= MAX_BLOCK_DEPTH) return false;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    if ((left as BlockInstance).id !== (right as BlockInstance).id) return false;
    if (!sameShape(childrenOf(left), childrenOf(right), depth + 1)) return false;
  }
  return true;
}

function diffDisplay(base: BlockInstance, other: BlockInstance): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of DISPLAY_KEYS) {
    if (JSON.stringify(base[key]) !== JSON.stringify(other[key])) patch[key] = other[key];
  }
  return patch;
}

/** 把 `other` 相对 `base` 的展示层差异写成 base 上的 at。返回是否真的写了。 */
function foldDisplay(
  base: BlockInstance[],
  other: BlockInstance[],
  device: string,
  depth = 0,
): boolean {
  if (depth >= MAX_BLOCK_DEPTH) return false;
  if (!sameShape(base, other)) return false;
  let changed = false;
  const walk = (a: BlockInstance[], b: BlockInstance[], level: number) => {
    if (level >= MAX_BLOCK_DEPTH) return;
    for (let i = 0; i < a.length; i += 1) {
      const patch = diffDisplay(a[i], b[i]);
      if (Object.keys(patch).length) {
        const at = { ...(a[i].at ?? {}) } as Record<string, Record<string, unknown>>;
        at[device] = { ...(at[device] ?? {}), ...patch };
        a[i] = { ...a[i], at: at as BlockInstance['at'] };
        changed = true;
      }
      walk(childrenOf(a[i]), childrenOf(b[i]), level + 1);
    }
  };
  walk(base, other, depth);
  return changed;
}

/** 真正做折算的实现；调用点的时机约束见 `foldDeviceLayouts`。 */
function foldLayout(raw: unknown, label: string, report: string[]): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const layout = raw as ScreenLayout & Record<string, unknown>;
  if (layout.device_split !== true || !layout.devices) return raw;

  const devices = { ...layout.devices } as Record<string, { blocks: BlockInstance[] } | undefined>;
  const base = Array.isArray(layout.blocks) ? structuredClone(layout.blocks) : [];
  const folded: string[] = [];
  const kept: string[] = [];

  for (const device of OVERRIDE_DEVICES) {
    const entry = devices[device];
    if (!entry || !Array.isArray(entry.blocks)) continue;
    // 结构不同 = 用户真的另画了一份布局；折算会悄悄改掉它，所以原样保留并报告。
    if (!sameShape(base, entry.blocks)) {
      kept.push(DEVICE_LABEL[device]);
      continue;
    }
    if (foldDisplay(base, structuredClone(entry.blocks), device)) folded.push(DEVICE_LABEL[device]);
    delete devices[device];
  }

  // 桌面版本就是 base，结构相同时它是冗余的，直接丢掉。
  if (devices.desktop && Array.isArray(devices.desktop.blocks) && sameShape(base, devices.desktop.blocks)) {
    delete devices.desktop;
  }

  if (folded.length) report.push(`${label}：已把${folded.join('、')}端与桌面不同的展示设置折算成覆盖。`);
  if (kept.length) report.push(`${label}：${kept.join('、')}布局与桌面结构不同，保留为独立编排。`);

  if (Object.keys(devices).length === 0) {
    return { blocks: base };
  }
  return { blocks: base, device_split: true, devices };
}

/**
 * 把三端独立的编排折算成「一份基础编排 + at 覆盖」。
 *
 * 只有渲染层开始求值 `at` 之后才可以调用——在那之前调用会让手机/平板布局
 * 悄悄退回桌面版（迁移会删掉被折算的设备树）。P1 接入 `at` 求值时由迁移流程调用。
 */
export function foldDeviceLayouts(layout: unknown, label: string, report: string[]): unknown {
  return foldLayout(layout, label, report);
}

/**
 * v1 → v2 迁移。
 *
 * 只做两件事：盖上版本号、把 `home` / `article` / `pages[].layout` 原样留在原位。
 * 三端编排的折算不在这一步——见 `foldDeviceLayouts`。
 */
export function migrateCustomization(raw: unknown): MigrationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: {}, report: [] };
  const doc: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const version = typeof doc.schema_version === 'number' ? doc.schema_version : 1;
  if (version >= CURRENT_SCHEMA_VERSION) return { value: doc, report: [] };

  doc.schema_version = CURRENT_SCHEMA_VERSION;
  return { value: doc, report: [] };
}
