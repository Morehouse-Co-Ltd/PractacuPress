import type { BlockInstance, ScreenLayout } from '../types';
import { MAX_BLOCK_DEPTH } from './blockTree';

/**
 * 设计文档的结构版本。
 *
 * 1 → 2：三端「整棵树复制三份」改为「一份基础编排 + 展示层覆盖」。
 * 迁移只在结构**与内容**都完全一致时折算；任何不一致的设备编排保留，写进报告交给用户决定。
 * 基础编排取 `devices.desktop`（用户后期真正在编辑的那棵），缺失时才退回 `layout.blocks` 快照。
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
 * 两棵树是否「同一批区块、同一种嵌套」；形状与内容都相同，折算才不改变任何人的布局。
 * 这个函数只回答形状，内容由 `sameContent` 负责。
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

/**
 * `at` 能携带的只有展示层；这些字段它带不走，内容一旦不同折算就是丢数据。
 *
 * v1 的 `ThemeBuilder.persistBlocks` 把用户编辑过的整棵树写进 `devices[device].blocks`，
 * 所以「id 与嵌套一样」并不等于「同一份内容」：手机版换过标题、改过 props 的树
 * 也能通过形状检查。这里把 at 装不下的字段逐个比一遍。
 */
const CONTENT_KEYS = ['type', 'title', 'column', 'area', 'props'] as const;

/**
 * 两棵树是否「同一份内容」，而不只是同一批 id。
 *
 * 与 `sameShape` 一样在深度上限处回答「证明不了相同」：证明不了就保留设备编排。
 */
function sameContent(a: unknown[], b: unknown[], depth = 0): boolean {
  if (depth >= MAX_BLOCK_DEPTH) return false;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    for (const key of CONTENT_KEYS) {
      if (JSON.stringify((left as BlockInstance)[key]) !== JSON.stringify((right as BlockInstance)[key])) {
        return false;
      }
    }
    if (!sameContent(childrenOf(left), childrenOf(right), depth + 1)) return false;
  }
  return true;
}

/** 折算只允许发生在「形状与内容都相同」的两棵树之间。 */
function foldable(base: unknown[], other: unknown[], depth = 0): boolean {
  return sameShape(base, other, depth) && sameContent(base, other, depth);
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
  if (!foldable(base, other)) return false;
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

/**
 * 折算用的基础编排。
 *
 * v1 的 `layout.blocks` 只是「打开分端那一刻」的快照，之后的桌面编辑都落进了
 * `devices.desktop.blocks`。以真正被编辑过的那棵为准，否则折算后站点会悄悄退回旧快照。
 * 无论选中哪棵都先拷贝一份：折算要在上面写 `at`，绝不能碰到调用方的文档。
 */
function foldBase(
  layout: ScreenLayout & Record<string, unknown>,
  devices: Record<string, { blocks: BlockInstance[] } | undefined>,
): BlockInstance[] {
  const desktopBlocks = devices.desktop?.blocks;
  if (Array.isArray(desktopBlocks)) return structuredClone(desktopBlocks);
  return Array.isArray(layout.blocks) ? structuredClone(layout.blocks) : [];
}

/** 真正做折算的实现；调用点的时机约束见 `foldDeviceLayouts`。 */
function foldLayout(raw: unknown, label: string, report: string[]): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const layout = raw as ScreenLayout & Record<string, unknown>;
  if (layout.device_split !== true || !layout.devices) return raw;

  const devices = { ...layout.devices } as Record<string, { blocks: BlockInstance[] } | undefined>;
  const base = foldBase(layout, devices);
  const folded: string[] = [];
  const kept: string[] = [];
  const contentKept: string[] = [];

  for (const device of OVERRIDE_DEVICES) {
    const entry = devices[device];
    if (!entry || !Array.isArray(entry.blocks)) continue;
    // 结构不同 = 用户真的另画了一份布局；折算会悄悄改掉它，所以原样保留并报告。
    if (!sameShape(base, entry.blocks)) {
      kept.push(DEVICE_LABEL[device]);
      continue;
    }
    // 结构相同但内容不同 = at 装不下这份差异；折算会把内容删掉，所以同样保留并报告。
    if (!sameContent(base, entry.blocks)) {
      contentKept.push(DEVICE_LABEL[device]);
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
  if (contentKept.length) report.push(`${label}：${contentKept.join('、')}内容与桌面不同，保留为独立编排。`);

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
 * 迁移的调用选项。
 *
 * `foldDevices` 默认关闭，原因写在 `foldDeviceLayouts` 上：折算会删掉被折叠的设备树，
 * 只有渲染层真的求值 `at` 之后才安全。读取路径（`readCustomization`）显式打开它，
 * 其它调用点保持 P0 的行为不变。
 */
export interface MigrateOptions {
  foldDevices?: boolean;
}

/** 页面的报告标签：带标题更好认，标题缺失时退回通称。 */
function pageLabel(page: Record<string, unknown>): string {
  const title = typeof page.title === 'string' ? page.title.trim() : '';
  return title ? `页面「${title}」` : '页面';
}

/** 把一份文档里的三端编排折算掉；`doc` 已经是浅拷贝，这里只替换其中的字段。 */
function foldDocument(doc: Record<string, unknown>, report: string[]): void {
  if (doc.home !== undefined) doc.home = foldDeviceLayouts(doc.home, '首页', report);
  if (doc.article !== undefined) doc.article = foldDeviceLayouts(doc.article, '文章页', report);
  if (!Array.isArray(doc.pages)) return;
  doc.pages = doc.pages.map((page) => {
    if (!page || typeof page !== 'object' || Array.isArray(page)) return page;
    const entry = page as Record<string, unknown>;
    if (entry.layout === undefined) return page;
    return { ...entry, layout: foldDeviceLayouts(entry.layout, pageLabel(entry), report) };
  });
}

/**
 * v1 → v2 迁移。
 *
 * 做三件事：盖上版本号、把 `home` / `article` / `pages[].layout` 原样留在原位，
 * 传 `{ foldDevices: true }` 时再把三端独立编排折算成 `at` 覆盖（见 `foldDeviceLayouts`）。
 *
 * 折算**不看版本号**：P1 之前编辑器一直在生成 `device_split`，那些文档的
 * `schema_version` 已经是 2（§5.3）。只在 v1 上折，v2 里的三棵树就永远不会折，
 * 两套模型会一直并存。没有 `device_split` 的 v2 文档折算仍是空操作，不会产生报告。
 *
 * 纯函数：只改浅拷贝出来的文档，折算出的编排都是新对象。
 */
export function migrateCustomization(raw: unknown, options: MigrateOptions = {}): MigrationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: {}, report: [] };
  const doc: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const version = typeof doc.schema_version === 'number' ? doc.schema_version : 1;
  const fold = options.foldDevices === true;
  if (version >= CURRENT_SCHEMA_VERSION && !fold) return { value: doc, report: [] };

  doc.schema_version = CURRENT_SCHEMA_VERSION;
  if (!fold) return { value: doc, report: [] };

  const report: string[] = [];
  foldDocument(doc, report);
  return { value: doc, report };
}
