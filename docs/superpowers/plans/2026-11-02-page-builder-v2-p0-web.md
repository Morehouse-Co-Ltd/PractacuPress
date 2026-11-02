# 页面编排 v2 · P0 前端地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把页面编排的数据地基换成 Schema v2：可嵌套属性、未知区块不丢、上限只有一套、拖拽落点正确、带版本号与迁移器、体积有预算。

**Architecture:** 全部改动集中在 `apps/web` 的四层——`types.ts`（模型）、`lib/blocks.ts`（注册表与 schema）、`lib/customize.ts`（归一化）、`lib/blockTree.ts`（树操作），再加一个新的 `lib/migrate.ts`。编辑器与渲染器只做接线改造，不重写。所有新字段都是可选的增量字段，v1 配置不迁移也能渲染。

**Tech Stack:** React 19 + TypeScript 5.9 + Vite 7 + Vitest 3；零新增运行时依赖。

**Spec:** `docs/superpowers/specs/2026-11-02-page-builder-v2-design.md`（§4 P0 地基）

## Global Constraints

- 不新增任何 npm 运行时依赖（`react` / `react-dom` / `react-router-dom` 之外一律不加）。
- 新界面文案一律走 `t()` 并补英文；`lib/i18n/coverage.test.ts` 是硬闸门，绿了才算完成。
- TypeScript 不允许出现 `any`；`npm run typecheck` 必须 0 错误。
- 所有命令在 `apps/web` 目录下执行。
- 兼容是硬要求：v1 配置（含 `device_split` 三棵树、`itemlist` 字符串、未知枚举）读出来必须仍然渲染。
- 归一化只做白名单收敛，不做"顺手修好"——不确定性交给迁移报告，不交给静默改写。
- 每个 Task 结束都要 `npx vitest run` 全绿 + 一次提交。

---

### Task 1: 树约束收敛与下移补偿

`MAX_BLOCKS` / `MAX_BLOCK_DEPTH` 已是唯一来源（`blockTree.ts:10-11`），但子容器上限 80 散落在
`customize.ts:578`，根级 24 散落在 `customize.ts:611`。同时 `moveBlock` 在同一父级向下移动时
少减一位（审计 W-4）。

**Files:**
- Modify: `apps/web/src/lib/blockTree.ts:10-11,132-144`
- Test: `apps/web/src/lib/blockTreeMove.test.ts`（新建）

**Interfaces:**
- Produces: `MAX_CHILDREN_PER_CONTAINER: number`（值为 80），供 Task 2 的归一化引用。
- Produces: `moveBlock(blocks, id, target)` 的语义校正——`target.index` 现在是"移除后应插入的下标"，
  同一父级向下移动时自动补偿。签名不变。

- [ ] **Step 1: 写失败测试**

新建 `apps/web/src/lib/blockTreeMove.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { BlockInstance } from '../types';
import { moveBlock } from './blockTree';

function mk(id: string, children: BlockInstance[] = []): BlockInstance {
  return {
    id,
    type: 'text',
    title: id,
    props: {},
    animation: 'none',
    hidden: false,
    ...(children.length ? { children } : {}),
  };
}

function ids(blocks: BlockInstance[]): string[] {
  return blocks.map((block) => block.id);
}

describe('moveBlock 同一父级内的下标补偿', () => {
  it('根级把 A 拖到 B 之后得到 [B,A,C]', () => {
    const next = moveBlock([mk('a'), mk('b'), mk('c')], 'a', { parentId: null, index: 2 });
    expect(ids(next)).toEqual(['b', 'a', 'c']);
  });

  it('根级向上拖动仍然正确', () => {
    const next = moveBlock([mk('a'), mk('b'), mk('c')], 'c', { parentId: null, index: 0 });
    expect(ids(next)).toEqual(['c', 'a', 'b']);
  });

  it('容器内向下拖动同样补偿', () => {
    const blocks = [mk('box', [mk('a'), mk('b'), mk('c')])];
    const next = moveBlock(blocks, 'a', { parentId: 'box', index: 2 });
    expect(ids(next[0].children ?? [])).toEqual(['b', 'a', 'c']);
  });

  it('拖到自身子孙里仍然被拒绝', () => {
    const blocks = [mk('box', [mk('inner')])];
    const next = moveBlock(blocks, 'box', { parentId: 'inner', index: 0 });
    expect(next).toBe(blocks);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/lib/blockTreeMove.test.ts
```

Expected: FAIL —第一个用例得到 `['b','c','a']`，与期望的 `['b','a','c']` 不符。

- [ ] **Step 3: 加常量并修正 moveBlock**

在 `apps/web/src/lib/blockTree.ts` 把第 10-11 行替换为：

```ts
export const MAX_BLOCK_DEPTH = 8;
export const MAX_BLOCKS = 200;
/** 单个容器下的直接子区块上限；与深度、总数构成本项目仅有的三条树约束。 */
export const MAX_CHILDREN_PER_CONTAINER = 80;
```

把 `moveBlock` 里 `const without = removeBlock(blocks, id);` 之后的全部下标计算
（原 132-144 行）替换为：

```ts
  const without = removeBlock(blocks, id);
  // 同一父级内向下移动时，移除本节点会让目标下标前移一位；编辑器给的
  // target.index 是「插到某一项之后」，所以先补偿，再夹到合法范围。
  const sameParent = (found.parent?.id ?? null) === (target.parentId ?? null);
  let index = sameParent && found.index < target.index ? target.index - 1 : target.index;
  if (target.parentId) {
    const parent = findBlock(without, target.parentId)?.block;
    if (!parent) return blocks;
    const max = parent.children?.length ?? 0;
    index = Math.min(Math.max(index, 0), max);
  } else {
    index = Math.min(Math.max(index, 0), without.length);
  }
  return insertBlock(without, { ...target, index }, found.block);
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run src/lib/blockTreeMove.test.ts && npx vitest run src/lib/blockTree.test.ts
```

Expected: 两个文件全部 PASS（含既有的 `blockTree.test.ts`，证明没有回归）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/lib/blockTree.ts apps/web/src/lib/blockTreeMove.test.ts
git commit -m "fix(web): compensate the drop index when a block moves down inside one parent"
```

---

### Task 2: 未知区块保留 + 根级 24 上限删除

`normalizeBlock` 对不认识的 `type` 直接返回 `null`（`customize.ts:557`），而 hydration 把归一化
结果写回 localStorage、下次保存又 PUT 回去——**从更新版本导入的区块会永久消失**。
同时根级 `.slice(0, 24)`（`customize.ts:611`）让第 25 个区块凭空消失。

**Files:**
- Modify: `apps/web/src/types.ts`（`BlockInstance` 加 `unsupported?: boolean`）
- Modify: `apps/web/src/lib/customize.ts:548-641`
- Test: `apps/web/src/lib/customizeBlocks.test.ts`（新建）

**Interfaces:**
- Consumes: `MAX_CHILDREN_PER_CONTAINER`、`MAX_BLOCKS`（Task 1）。
- Produces: `export function normalizeScreenLayout(value: unknown): ScreenLayout`——
  原本模块私有的 `normalizeLayout` 改为导出，供编辑器与测试直接调用。
- Produces: `export function blockBudgetStatus(layout: ScreenLayout): { total: number; limit: number; over: boolean }`——
  编辑器保存前用它判断是否超限。
- Produces: `BlockInstance.unsupported?: boolean`——`true` 表示类型来自更新版本，保留但不渲染。

- [ ] **Step 1: 写失败测试**

新建 `apps/web/src/lib/customizeBlocks.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { blockBudgetStatus, normalizeScreenLayout } from './customize';

function textBlock(id: string) {
  return { id, type: 'text', title: id, props: { body: 'hi' }, animation: 'none', hidden: false };
}

describe('normalizeScreenLayout', () => {
  it('保留不认识的区块类型并打上 unsupported', () => {
    const layout = normalizeScreenLayout({
      blocks: [{ id: 'x1', type: 'pricing-v9', title: '价格', props: { plan: 'A' } }],
    });
    expect(layout.blocks).toHaveLength(1);
    expect(layout.blocks[0].type).toBe('pricing-v9');
    expect(layout.blocks[0].unsupported).toBe(true);
    expect(layout.blocks[0].props).toEqual({ plan: 'A' });
  });

  it('根级不再截断到 24 个', () => {
    const blocks = Array.from({ length: 30 }, (_, i) => textBlock(`b${i}`));
    const layout = normalizeScreenLayout({ blocks });
    expect(layout.blocks).toHaveLength(30);
  });

  it('容器子区块仍受 80 条上限约束', () => {
    const children = Array.from({ length: 90 }, (_, i) => textBlock(`c${i}`));
    const layout = normalizeScreenLayout({
      blocks: [{ id: 'box', type: 'container', title: 'box', props: {}, animation: 'none', hidden: false, children }],
    });
    expect(layout.blocks[0].children).toHaveLength(80);
  });

  it('没有任何 type 的条目直接丢弃', () => {
    const layout = normalizeScreenLayout({ blocks: [{ id: 'bad' }, textBlock('ok')] });
    expect(layout.blocks.map((block) => block.id)).toEqual(['ok']);
  });
});

describe('blockBudgetStatus', () => {
  it('超过 200 个区块时报告超限', () => {
    const blocks = Array.from({ length: 201 }, (_, i) => textBlock(`b${i}`));
    const status = blockBudgetStatus({ blocks });
    expect(status.over).toBe(true);
    expect(status.limit).toBe(200);
  });

  it('正常编排不超限', () => {
    expect(blockBudgetStatus({ blocks: [textBlock('a')] }).over).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/lib/customizeBlocks.test.ts
```

Expected: FAIL —— `blockBudgetStatus` 不是导出成员；未知类型那条断言拿到 0 个区块。

- [ ] **Step 3: 在 types.ts 给 BlockInstance 加字段**

在 `apps/web/src/types.ts` 的 `BlockInstance` 里，`appearance?: BlockAppearance;` 之后追加：

```ts
  /**
   * 归一化时无法识别的区块类型：保留原样、不渲染、保存时写回。
   * 这样从更新版本导出的设计不会因为本版本不认识而在下一次保存时永久消失。
   */
  unsupported?: boolean;
```

- [ ] **Step 4: 改 normalizeBlock 与 normalizeBlockList**

在 `apps/web/src/lib/customize.ts`，把 `normalizeBlock` 里这两行：

```ts
  const raw = value as Partial<BlockInstance>;
  if (typeof raw.type !== 'string' || !BLOCK_TYPES.has(raw.type)) return null;
  budget.count += 1;
```

替换为：

```ts
  const raw = value as Partial<BlockInstance>;
  if (typeof raw.type !== 'string' || !raw.type) return null;
  budget.count += 1;
  const known = BLOCK_TYPES.has(raw.type);
```

接着把子区块那行的 `.slice(0, 80)` 换成常量：

```ts
  const children = Array.isArray(raw.children)
    ? raw.children
        .slice(0, MAX_CHILDREN_PER_CONTAINER)
        .map((child) => normalizeBlock(child, depth + 1, seen, budget))
        .filter((child): child is BlockInstance => !!child)
    : [];
```

再在 `const appearance = normalizeBlockAppearance(raw.appearance);` 之前插入未知类型分支：

```ts
  if (!known) {
    // 不认识的类型：保留形状，不解释 props，渲染器会跳过它。
    const unsupportedProps: Record<string, string | number | boolean> = {};
    for (const [key, item] of Object.entries(raw.props ?? {})) {
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        unsupportedProps[key] = item;
      }
    }
    return {
      id,
      type: raw.type.slice(0, 64),
      title: text(raw.title, '', 80) || raw.type.slice(0, 64),
      props: unsupportedProps,
      animation: animation(raw.animation),
      hidden: bool(raw.hidden, false),
      unsupported: true,
      ...(children.length ? { children } : {}),
    };
  }
```

然后在 `normalizeBlockList` 里去掉根级 24 条截断：

```ts
  const blocks = raw
    .map((block) => normalizeBlock(block))
    .filter((block): block is BlockInstance => !!block);
```

在文件里 `normalizeLayout` 之后追加导出与预算函数（同时把 `normalizeLayout` 改名并导出）：

```ts
export function normalizeScreenLayout(value: unknown): ScreenLayout {
  return normalizeLayout(value);
}

/** 编排的区块总量；编辑器保存前用它挡住超限，而不是让归一化静默截断。 */
export function blockBudgetStatus(layout: ScreenLayout): {
  total: number;
  limit: number;
  over: boolean;
} {
  const perDevice = Object.values(layout.devices ?? {}).map((entry) =>
    countBlocks((entry as { blocks: BlockInstance[] }).blocks),
  );
  const total = Math.max(countBlocks(layout.blocks), 0, ...perDevice);
  return { total, limit: MAX_BLOCKS, over: total > MAX_BLOCKS };
}
```

确认文件顶部已从 `./blockTree` 引入 `countBlocks`；若没有，补进既有的 import 语句。

- [ ] **Step 5: 跑测试确认通过**

```bash
npx vitest run src/lib/customizeBlocks.test.ts && npx vitest run
```

Expected: 新文件全 PASS，整仓测试仍然全绿。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/types.ts apps/web/src/lib/customize.ts apps/web/src/lib/customizeBlocks.test.ts
git commit -m "fix(web): keep unknown block types and drop the silent root-level cap"
```

---

### Task 3: 模型 v2 字段 + schema_version + 迁移器

**Files:**
- Modify: `apps/web/src/types.ts`（`BlockInstance` 增加展示层覆盖字段；`SiteCustomization` 增加 `schema_version`）
- Create: `apps/web/src/lib/migrate.ts`
- Modify: `apps/web/src/lib/customize.ts`（`readCustomization` 入口调用迁移）
- Test: `apps/web/src/lib/migrate.test.ts`（新建）

**Interfaces:**
- Produces: `CURRENT_SCHEMA_VERSION = 2`。
- Produces: `migrateCustomization(raw: unknown): { value: Record<string, unknown>; report: string[] }`——
  纯函数、幂等；`report` 是给用户看的中文句子，空数组表示"无需提示"。
- Produces: `BlockInstance.at?: { tablet?: BlockDisplayOverride; mobile?: BlockDisplayOverride }`、
  `visible?: BlockVisibility`、`anchor?: string`、`span?: BlockSpan`、`offset?: BlockSpan`——
  Task 4/5 与 P1 都会用到，P0 只负责把类型与迁移写对，渲染暂不消费。

- [ ] **Step 1: 写失败测试**

新建 `apps/web/src/lib/migrate.test.ts`：

```ts
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
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/lib/migrate.test.ts
```

Expected: FAIL —— `Cannot find module './migrate'`。

- [ ] **Step 3: 在 types.ts 增加 v2 字段**

在 `apps/web/src/types.ts` 的 `BlockInstance` 里 `unsupported?: boolean;` 之后追加：

```ts
  /** 只覆盖展示层，不覆盖 props；缺省表示沿用基础值。 */
  at?: { tablet?: BlockDisplayOverride; mobile?: BlockDisplayOverride };
  /** 内置条件显示；渲染期求值，刷新后仍然生效。 */
  visible?: BlockVisibility;
  /** 目录 / 跳转锚点。 */
  anchor?: string;
  /** 栅格占位；与 width 同时存在时 span 优先。 */
  span?: BlockSpan;
  /** 栅格起始列偏移。 */
  offset?: BlockSpan;
```

在同一个文件的 `SitePage` 定义之前插入：

```ts
export interface BlockSpan {
  base: number; // 1–12
  md?: number;  // ≥768
  sm?: number;  // ≥480
}

export type BlockDisplayOverride = Pick<
  BlockInstance,
  'span' | 'appearance' | 'animation' | 'hidden' | 'custom_css' | 'width' | 'height'
> & {
  align?: 'left' | 'center' | 'right';
  gap_scale?: number;
  mt?: number;
  mb?: number;
};

export interface BlockVisibility {
  devices?: BuilderDevice[];
  roles?: ('guest' | 'member' | 'admin')[];
  /** ISO 日期，含首尾。 */
  from?: string;
  to?: string;
}
```

在 `SiteCustomization` 接口里 `language?: Locale;` 之后追加：

```ts
  /** 设计文档的结构版本；缺省按 1 处理，读入时由 migrate.ts 升级到 2。 */
  schema_version?: number;
```

- [ ] **Step 4: 写 migrate.ts**

新建 `apps/web/src/lib/migrate.ts`：

```ts
import type { BlockInstance, ScreenLayout } from '../types';

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

function sameShape(a: BlockInstance[], b: BlockInstance[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].id !== b[i].id) return false;
    if (!sameShape(a[i].children ?? [], b[i].children ?? [])) return false;
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
function foldDisplay(base: BlockInstance[], other: BlockInstance[], device: string): boolean {
  if (!sameShape(base, other)) return false;
  let changed = false;
  const walk = (a: BlockInstance[], b: BlockInstance[]) => {
    for (let i = 0; i < a.length; i += 1) {
      const patch = diffDisplay(a[i], b[i]);
      if (Object.keys(patch).length) {
        const at = { ...(a[i].at ?? {}) } as Record<string, Record<string, unknown>>;
        at[device] = { ...(at[device] ?? {}), ...patch };
        a[i] = { ...a[i], at: at as BlockInstance['at'] };
        changed = true;
      }
      walk(a[i].children ?? [], b[i].children ?? []);
    }
  };
  walk(base, other);
  return changed;
}

function foldLayout(raw: unknown, label: string, report: string[]): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const layout = raw as ScreenLayout & Record<string, unknown>;
  if (layout.device_split !== true || !layout.devices) return raw;

  const devices = { ...layout.devices } as Record<string, { blocks: BlockInstance[] } | undefined>;
  const base = Array.isArray(layout.blocks) ? structuredClone(layout.blocks) : [];
  let folded = 0;
  const kept: string[] = [];

  for (const device of ['tablet', 'mobile'] as const) {
    const entry = devices[device];
    if (!entry || !Array.isArray(entry.blocks)) continue;
    if (foldDisplay(base, structuredClone(entry.blocks), device)) {
      folded += 1;
      delete devices[device];
    } else {
      kept.push(DEVICE_LABEL[device]);
    }
  }

  // 桌面版本就是 base，结构相同时它是冗余的，直接丢掉。
  if (devices.desktop && sameShape(base, devices.desktop.blocks)) delete devices.desktop;

  if (folded) report.push(`${label}：已把 ${folded} 端与桌面不同的展示设置折算成覆盖。`);
  if (kept.length) report.push(`${label}：${kept.join('、')}布局与桌面结构不同，保留为独立编排。`);

  if (!diffAnyDevice(devices)) {
    return { blocks: base };
  }
  return { blocks: base, device_split: true, devices };
}

function diffAnyDevice(devices: Record<string, unknown>): boolean {
  return Object.keys(devices).length > 0;
}

export function migrateCustomization(raw: unknown): MigrationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: {}, report: [] };
  const doc: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const version = typeof doc.schema_version === 'number' ? doc.schema_version : 1;
  if (version >= CURRENT_SCHEMA_VERSION) return { value: doc, report: [] };

  const report: string[] = [];
  if (doc.home) doc.home = foldLayout(doc.home, '首页', report);
  if (doc.article) doc.article = foldLayout(doc.article, '文章页', report);
  if (Array.isArray(doc.pages)) {
    doc.pages = doc.pages.map((page, index) => {
      if (!page || typeof page !== 'object') return page;
      const entry = page as Record<string, unknown>;
      if (!entry.layout) return page;
      return { ...entry, layout: foldLayout(entry.layout, `页面「${String(entry.title ?? index)}」`, report) };
    });
  }
  doc.schema_version = CURRENT_SCHEMA_VERSION;
  return { value: doc, report };
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
npx vitest run src/lib/migrate.test.ts
```

Expected: 5 个用例全部 PASS。

- [ ] **Step 6: 接到 readCustomization 入口**

在 `apps/web/src/lib/customize.ts` 顶部 import 区加入：

```ts
import { migrateCustomization } from './migrate';
```

找到 `readCustomization` 的函数体第一行（把入参配置读成 `config.customization` 的那处），
在最前面插入迁移：

```ts
export function readCustomization(config: WebConfig): SiteCustomization {
  const migrated = migrateCustomization(config.customization).value;
  const raw = migrated as Partial<SiteCustomization>;
  // …原有函数体，把原来读 config.customization 的地方改成读 raw
}
```

注意：**只改读取路径**。保存路径（`customizationSync.ts` 的 PUT）仍然写原始对象，
迁移结果在下一次保存时自然落盘。

- [ ] **Step 7: 跑全量测试与类型检查**

```bash
npx vitest run && npm run typecheck
```

Expected: 全绿，0 类型错误。

- [ ] **Step 8: 提交**

```bash
git add apps/web/src/types.ts apps/web/src/lib/migrate.ts apps/web/src/lib/migrate.test.ts apps/web/src/lib/customize.ts
git commit -m "feat(web): add schema v2 block fields, version stamp and the v1 to v2 migrator"
```

---

### Task 4: PropSchema v2 与 repeater 属性

现有 `itemlist` 把结构化数据存成 JSON 字符串、每条值截 200 字（`blocks.ts:1073-1092`）、
子字段只有 text/color/select。P0 引入 `repeater`：值就是真正的数组，子字段复用 `PropSchema`，
归一化按子 schema 递归白名单。

**Files:**
- Modify: `apps/web/src/types.ts`（`BlockPropValue`）
- Modify: `apps/web/src/lib/blocks.ts:22-55,907-967`（`PropType`、`PropSchema`、`button` 区块定义）
- Modify: `apps/web/src/lib/customize.ts`（按 schema 递归清洗 props）
- Modify: `apps/web/src/components/builder/BlockProps.tsx`（repeater 表单）
- Test: `apps/web/src/lib/repeaterProps.test.ts`（新建）

**Interfaces:**
- Produces: `type BlockPropValue = string | number | boolean | BlockPropRecord | BlockPropRecord[]`，
  `type BlockPropRecord = Record<string, string | number | boolean>`——
  `BlockInstance.props: Record<string, BlockPropValue>`。
- Produces: `PropSchema.itemSchema?: PropSchema[]`、`minItems?: number`、
  `maxItems?: number`、`itemLabel?: string`；`PropType` 增加 `'repeater'`。
- Produces: `normalizeBlockProps(type: string, value: unknown): Record<string, BlockPropValue>`——
  按注册表 schema 递归白名单清洗，供 `normalizeBlock` 调用与测试直接使用。
- Produces: `blockPropRecord(block, key): BlockPropRecord[]`——渲染器读 repeater 值的唯一入口
  （坏值一律返回 `[]`）。

- [ ] **Step 1: 写失败测试**

新建 `apps/web/src/lib/repeaterProps.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { createBlock } from './blocks';
import { normalizeBlockProps } from './customize';

describe('normalizeBlockProps', () => {
  it('repeater 值按 itemSchema 递归清洗，未声明的键被丢弃', () => {
    const props = normalizeBlockProps('button', {
      buttons: [{ label: '去', link: '/a', style: 'solid', __evil: '<script>' }],
      unknown_top: 'drop me',
    });
    expect(props.buttons).toEqual([{ label: '去', link: '/a', style: 'solid' }]);
    expect(props.unknown_top).toBeUndefined();
  });

  it('repeater 超出 maxItems 的部分被截掉', () => {
    const buttons = Array.from({ length: 9 }, (_, i) => ({ label: `b${i}`, link: '/' }));
    const props = normalizeBlockProps('button', { buttons });
    expect((props.buttons as unknown[]).length).toBe(4);
  });

  it('非数组的 repeater 值回退成空数组', () => {
    const props = normalizeBlockProps('button', { buttons: 'not-an-array' });
    expect(props.buttons).toBeUndefined();
  });

  it('旧配置里的 itemlist JSON 字符串仍然能读成 repeater 值', () => {
    const props = normalizeBlockProps('button', {
      buttons: JSON.stringify([{ label: '旧按钮', link: '/old' }]),
    });
    expect(props.buttons).toEqual([{ label: '旧按钮', link: '/old', style: '' }]);
  });

  it('不认识类型的 props 原样保留标量', () => {
    expect(normalizeBlockProps('pricing-v9', { plan: 'A', n: 1 })).toEqual({ plan: 'A', n: 1 });
  });
});

describe('createBlock', () => {
  it('button 的默认 props 是空 repeater 而不是 JSON 字符串', () => {
    expect(createBlock('button').props.buttons).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/lib/repeaterProps.test.ts
```

Expected: FAIL —— `normalizeBlockProps` 未导出；`buttons` 拿到的是字符串。

- [ ] **Step 3: 在 types.ts 放宽 props 的值类型**

在 `apps/web/src/types.ts` 的 `BlockInstance` 定义之前插入：

```ts
/** 一个 repeater 条目：只允许标量与字符串。 */
export type BlockPropRecord = Record<string, string | number | boolean>;

/** 区块属性值：标量或 repeater 的条目数组。 */
export type BlockPropValue = string | number | boolean | BlockPropRecord[];

export type BlockProps = Record<string, BlockPropValue>;
```

把 `BlockInstance` 里的 `props: Record<string, string | number | boolean>;` 改成：

```ts
  props: BlockProps;
```

- [ ] **Step 4: 扩展 blocks.ts 的 schema 类型**

把 `apps/web/src/lib/blocks.ts` 的 `PropType` 与 `PropSchema`（22-44 行）替换为：

```ts
export type PropType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  | 'toggle'
  | 'color'
  /** 旧的结构化列表：JSON 字符串。只为读取既有配置保留。 */
  | 'itemlist'
  /** 结构化列表：值是条目数组，子字段由 itemSchema 递归声明。 */
  | 'repeater';

export interface PropSchema {
  key: string;
  label: string;
  type: PropType;
  hint?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  /** itemlist：条目字段，例如 [{ key: 'label', label: '名称' }] */
  itemFields?: {
    key: string;
    label: string;
    type?: 'text' | 'color' | 'select';
    options?: { value: string; label: string }[];
  }[];
  itemLabel?: string;
  maxItems?: number;
  /** repeater：每个条目的字段，复用同一套 PropSchema（不允许再嵌 repeater）。 */
  itemSchema?: PropSchema[];
  minItems?: number;
}
```

- [ ] **Step 5: 把 button 区块迁到 repeater**

找到 `blocks.ts` 里 `type: 'button'` 的定义（原 907 行附近），把它的 `defaults` 与 `schema` 换成：

```ts
    defaults: { buttons: [], align: 'left', size: 'md', new_tab: false },
    schema: [
      {
        key: 'buttons',
        label: t('按钮'),
        type: 'repeater',
        itemLabel: t('按钮'),
        minItems: 1,
        maxItems: 4,
        hint: t('最多 4 个；链接只接受 http(s) 地址或 / 开头的站内路径。'),
        itemSchema: [
          { key: 'label', label: t('文字'), type: 'text' },
          { key: 'link', label: t('链接'), type: 'text' },
          {
            key: 'style',
            label: t('样式'),
            type: 'select',
            options: [
              { value: 'solid', label: t('实心') },
              { value: 'outline', label: t('描边') },
              { value: 'ghost', label: t('幽灵') },
              { value: 'link', label: t('文字链') },
            ],
          },
        ],
      },
      {
        key: 'align',
        label: t('对齐'),
        type: 'select',
        options: [
          { value: 'left', label: t('左') },
          { value: 'center', label: t('中') },
          { value: 'right', label: t('右') },
        ],
      },
      {
        key: 'size',
        label: t('尺寸'),
        type: 'select',
        options: [
          { value: 'sm', label: t('小') },
          { value: 'md', label: t('中') },
          { value: 'lg', label: t('大') },
        ],
      },
      { key: 'new_tab', label: t('在新窗口打开'), type: 'toggle' },
    ],
```

- [ ] **Step 6: 在 customize.ts 写 normalizeBlockProps**

在 `apps/web/src/lib/customize.ts` 的 `normalizeBlock` 之前插入：

```ts
function scalarValue(item: unknown): string | number | boolean | undefined {
  if (typeof item === 'number') return Math.min(1e6, Math.max(-1e6, item));
  if (typeof item === 'boolean') return item;
  if (typeof item === 'string') return item.slice(0, 4000);
  return undefined;
}

function normalizePropRecord(
  value: unknown,
  schema: PropSchema[],
): Record<string, string | number | boolean> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const out: Record<string, string | number | boolean> = {};
  for (const field of schema) {
    const raw = source[field.key];
    if (field.type === 'repeater') continue; // 只允许一层
    const scalar = scalarValue(raw);
    if (scalar !== undefined) out[field.key] = scalar;
  }
  return out;
}

function normalizeRepeaterValue(
  value: unknown,
  schema: PropSchema,
): Record<string, string | number | boolean>[] | undefined {
  const fields = schema.itemSchema ?? [];
  const max = schema.maxItems ?? 30;
  let list: unknown[] | null = null;
  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === 'string' && value) {
    // 旧配置：itemlist 存的就是 JSON 字符串。
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = null;
    }
  }
  if (!list) return undefined;
  const out = list
    .slice(0, max)
    .map((item) => normalizePropRecord(item, fields))
    .filter((item): item is Record<string, string | number | boolean> => !!item);
  return out.length ? out : undefined;
}

/**
 * 按注册表 schema 递归白名单清洗属性。
 *
 * 未在 schema 里声明的键一律丢弃——服务端只存不解释，白名单只能在前端这一层做。
 * 不认识的区块类型退化成"只保留标量"，保证从更新版本导入的配置不会丢内容。
 */
export function normalizeBlockProps(
  type: string,
  value: unknown,
): Record<string, BlockPropValue> {
  const def = blockDef(type);
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  if (!def) {
    const out: Record<string, BlockPropValue> = {};
    for (const [key, item] of Object.entries(source)) {
      const scalar = scalarValue(item);
      if (scalar !== undefined) out[key] = scalar;
    }
    return out;
  }
  const out: Record<string, BlockPropValue> = {};
  for (const field of def.schema) {
    if (field.type === 'repeater') {
      const list = normalizeRepeaterValue(source[field.key], field);
      if (list) out[field.key] = list;
      continue;
    }
    const scalar = scalarValue(source[field.key]);
    if (scalar !== undefined) out[field.key] = scalar;
  }
  return out;
}

/** 读 repeater 值；坏数据一律返回空数组，渲染器不需要防御。 */
export function blockPropRecord(
  block: Pick<BlockInstance, 'props'>,
  key: string,
): Record<string, string | number | boolean>[] {
  const value = block.props[key];
  return Array.isArray(value) ? value : [];
}
```

把 `normalizeBlock` 里构造 `props` 的那段循环：

```ts
  const props: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(raw.props ?? {})) {
    // …
  }
```

整体替换为一行：

```ts
  const props = normalizeBlockProps(raw.type, raw.props);
```

顶部 import 补上 `PropSchema`、`BlockPropValue` 类型与 `blockDef`（若尚未引入）。

- [ ] **Step 7: BlockProps.tsx 支持 repeater**

在 `apps/web/src/components/builder/BlockProps.tsx` 的 `PropControl` 里，
`if (schema.type === 'itemlist')` 分支之前插入：

```tsx
  if (schema.type === 'repeater') {
    const items = blockPropRecord(block, schema.key);
    const max = schema.maxItems ?? 30;
    const min = schema.minItems ?? 0;
    const commit = (next: Record<string, string | number | boolean>[]) =>
      onChange(schema.key, next.slice(0, max));

    return (
      <Field
        label={schema.label}
        hint={schema.hint ?? t('最多 {count} 条。', { count: max })}
        aside={`${items.length}/${max}`}
      >
        <div className="itemlist">
          {items.map((item, index) => (
            <div className="itemlist-row" key={index}>
              {(schema.itemSchema ?? []).map((field) => {
                const update = (value: string | number | boolean) => {
                  commit(items.map((entry, i) => (i === index ? { ...entry, [field.key]: value } : entry)));
                };
                return (
                  <label key={field.key} className="itemlist-field">
                    <span>{field.label}</span>
                    {field.type === 'select' ? (
                      <select
                        value={String(item[field.key] ?? '')}
                        onChange={(event) => update(event.target.value)}
                        aria-label={`${schema.label} 第 ${index + 1} 条 ${field.label}`}
                      >
                        <option value="">—</option>
                        {(field.options ?? []).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    ) : field.type === 'toggle' ? (
                      <input
                        type="checkbox"
                        checked={item[field.key] === true}
                        onChange={(event) => update(event.target.checked)}
                        aria-label={`${schema.label} 第 ${index + 1} 条 ${field.label}`}
                      />
                    ) : (
                      <input
                        type="text"
                        value={String(item[field.key] ?? '')}
                        onChange={(event) => update(event.target.value)}
                        aria-label={`${schema.label} 第 ${index + 1} 条 ${field.label}`}
                      />
                    )}
                  </label>
                );
              })}
              <button
                type="button"
                className="link-btn"
                disabled={items.length <= min}
                onClick={() => commit(items.filter((_, i) => i !== index))}
              >
                {t('删除')}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={items.length >= max}
            onClick={() => {
              const blank: Record<string, string | number | boolean> = {};
              for (const field of schema.itemSchema ?? []) {
                blank[field.key] = field.type === 'toggle' ? false : '';
              }
              commit([...items, blank]);
            }}
          >
            {t('添加{label}', { label: schema.itemLabel ?? t('条目') })}
          </button>
        </div>
      </Field>
    );
  }
```

顶部 import 改成：

```tsx
import { blockDef, blockProp, type PropSchema } from '../../lib/blocks';
import { blockPropRecord } from '../../lib/customize';
```

并把 `PropControl` 与 `BlockProps` 的回调签名统一成
`(key: string, value: BlockPropValue)` / `(props: BlockProps)`（从 `../../types` 引入）。

- [ ] **Step 8: 让渲染器读 button 的新形状**

在 `apps/web/src/components/blocks/ActionBlocks.tsx` 里，把读取 `props.buttons`
的 JSON 解析改成 `blockPropRecord(block, 'buttons')`：

```tsx
  const buttons = blockPropRecord(block, 'buttons');
```

保留原有的链接白名单与 `aria-disabled` 逻辑不变；只替换取值方式。

- [ ] **Step 9: 跑测试、类型检查与全量回归**

```bash
npx vitest run src/lib/repeaterProps.test.ts && npm run typecheck && npx vitest run
```

Expected: 全部 PASS；`typecheck` 0 错误（`BlockProps` 放宽后的类型会牵动
`BlockInspector.tsx` 的 patch 签名，如报错就同步改成 `BlockProps`）。

- [ ] **Step 10: 提交**

```bash
git add apps/web/src/types.ts apps/web/src/lib/blocks.ts apps/web/src/lib/customize.ts \
  apps/web/src/components/builder/BlockProps.tsx apps/web/src/components/blocks/ActionBlocks.tsx \
  apps/web/src/components/builder/BlockInspector.tsx apps/web/src/lib/repeaterProps.test.ts
git commit -m "feat(web): add repeater property schema and migrate the button block to it"
```

---

### Task 5: media 属性类型与媒体库选择器

现在图片块只能手填 URL（`blocks.ts:633`）。P0 让 `image` 的 `src` 走 `media` 类型，
表单里能直接从媒体库挑图。

**Files:**
- Modify: `apps/web/src/lib/blocks.ts`（`PropType` 增 `'media'`；`image` 的 `src` 改类型）
- Create: `apps/web/src/components/builder/MediaPicker.tsx`
- Modify: `apps/web/src/components/builder/BlockProps.tsx`
- Modify: `apps/web/src/lib/customize.ts`（`media` 值白名单：只接受 `/api/v1/media/…`、`http(s)://`、`/…`）
- Test: `apps/web/src/lib/mediaProps.test.ts`（新建）

**Interfaces:**
- Consumes: `normalizeBlockProps`（Task 4）。
- Produces: `PropType` 增加 `'media'`。
- Produces: `<MediaPicker value={string} onChange={(url: string) => void} />`。
- Produces: `normalizeMediaUrl(value: unknown): string | undefined`——非法值（含 `data:`）返回 `undefined`。

- [ ] **Step 1: 写失败测试**

新建 `apps/web/src/lib/mediaProps.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { normalizeBlockProps, normalizeMediaUrl } from './customize';

describe('normalizeMediaUrl', () => {
  it('接受站内媒体地址、绝对 http(s) 与站内路径', () => {
    expect(normalizeMediaUrl('/api/v1/media/abc')).toBe('/api/v1/media/abc');
    expect(normalizeMediaUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(normalizeMediaUrl('/img/a.png')).toBe('/img/a.png');
  });

  it('拒绝 data URL、javascript 与相对路径', () => {
    expect(normalizeMediaUrl('data:image/png;base64,AAAA')).toBeUndefined();
    expect(normalizeMediaUrl('javascript:alert(1)')).toBeUndefined();
    expect(normalizeMediaUrl('img/a.png')).toBeUndefined();
    expect(normalizeMediaUrl('')).toBeUndefined();
  });
});

describe('image 区块的 src', () => {
  it('走 media 白名单', () => {
    const props = normalizeBlockProps('image', { src: 'data:image/png;base64,AAAA', alt: '图' });
    expect(props.src).toBeUndefined();
    expect(props.alt).toBe('图');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/lib/mediaProps.test.ts
```

Expected: FAIL —— `normalizeMediaUrl` 未导出，且 `data:` 目前会被当作普通字符串放行。

- [ ] **Step 3: blocks.ts 增加 media 类型并改 image 的 src**

`PropType` union 追加一行：

```ts
  /** 媒体库选择器：值只接受站内媒体地址、http(s) 或 / 开头的站内路径。 */
  | 'media';
```

把 `image` 区块 schema 里的 `src` 项换成：

```ts
      { key: 'src', label: t('图片地址'), type: 'media', hint: t('可以从媒体库选，也可以填外部图片地址。') },
```

- [ ] **Step 4: customize.ts 加 normalizeMediaUrl 并接进 props 清洗**

在 `normalizeBlockProps` 之前插入：

```ts
/**
 * 媒体地址白名单。
 *
 * 只接受站内媒体端点、http(s) 绝对地址与 / 开头的站内路径；
 * `data:` 与 `javascript:` 一律拒绝——区块里的内联图片会把 1 MiB 的设计预算瞬间撑爆。
 */
export function normalizeMediaUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const url = value.trim();
  if (!url || url.length > 2048) return undefined;
  if (url.startsWith('/api/v1/media/') || url.startsWith('/')) return url.slice(0, 2048);
  if (/^https?:\/\//i.test(url)) return url.slice(0, 2048);
  return undefined;
}
```

在 `normalizeBlockProps` 的字段循环里，`repeater` 分支之前插入 media 分支：

```ts
    if (field.type === 'media') {
      const media = normalizeMediaUrl(source[field.key]);
      if (media) out[field.key] = media;
      continue;
    }
```

- [ ] **Step 5: 写 MediaPicker**

新建 `apps/web/src/components/builder/MediaPicker.tsx`：

```tsx
import { useEffect, useState } from 'react';
import type { Asset } from '../../types';
import { useBackend } from '../../lib/backend';
import { useT } from '../../lib/i18n';
import { Button, Modal } from '../ui';

/**
 * 媒体库选择器。
 *
 * 只列已扫描通过（`scan_status === 'clean'`）的资产：拒绝与待审的资产连管理员
 * 也不该拖进版面。返回值是资产的展示地址，区块里只存这个字符串。
 */
export function MediaPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (url: string) => void;
}) {
  const t = useT();
  const backend = useBackend();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError('');
    backend.api
      .listAssets()
      .then((items) => {
        if (!alive) return;
        setAssets(items.filter((asset) => asset.scan_status === 'clean' && asset.url));
      })
      .catch(() => {
        if (alive) setError(t('读不到媒体库，检查登录状态或后端是否在线。'));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, backend, t]);

  return (
    <Modal open={open} title={t('从媒体库选择')} onClose={onClose}>
      {loading ? <p className="field-hint">{t('正在读取媒体库…')}</p> : null}
      {error ? <p className="field-hint">{error}</p> : null}
      {!loading && !error && assets.length === 0 ? (
        <p className="field-hint">{t('媒体库还是空的，先去「媒体」页上传图片。')}</p>
      ) : null}
      <div className="media-picker-grid">
        {assets.map((asset) => (
          <button
            key={asset.id}
            type="button"
            className="media-picker-item"
            onClick={() => {
              onPick(asset.url ?? '');
              onClose();
            }}
          >
            <img src={asset.url} alt={asset.file_name ?? ''} loading="lazy" />
            <span>{asset.file_name ?? asset.id}</span>
          </button>
        ))}
      </div>
      <Button variant="secondary" onClick={onClose}>
        {t('取消')}
      </Button>
    </Modal>
  );
}
```

同时把下面三个样式补进 `apps/web/src/styles.css`（放在 `.itemlist` 附近）：

```css
.media-picker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; max-height: 320px; overflow: auto; margin: 12px 0; }
.media-picker-item { display: flex; flex-direction: column; gap: 4px; padding: 6px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg-subtle); cursor: pointer; text-align: left; }
.media-picker-item img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; border-radius: 6px; }
.media-picker-item span { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 6: BlockProps 渲染 media 类型**

在 `BlockProps.tsx` 的 `PropControl` 里加一个分支（放在 `repeater` 分支之后）：

```tsx
  if (schema.type === 'media') {
    return (
      <Field label={schema.label} hint={schema.hint} htmlFor={id}>
        <div className="media-field">
          <Input
            id={id}
            value={String(block.props[schema.key] ?? '')}
            onChange={(event) => onChange(schema.key, event.target.value)}
          />
          <Button variant="secondary" size="sm" onClick={() => setPickerOpen(true)}>
            {t('从媒体库选择')}
          </Button>
        </div>
        <MediaPicker
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onPick={(url) => onChange(schema.key, url)}
        />
      </Field>
    );
  }
```

`PropControl` 顶部加状态：`const [pickerOpen, setPickerOpen] = useState(false);`，
并把 `useState` 加进 react import；`MediaPicker` 与会话级的 `Button` 一起 import。
样式补一条：

```css
.media-field { display: flex; gap: 8px; align-items: center; }
.media-field input { flex: 1; }
```

- [ ] **Step 7: 跑测试与类型检查**

```bash
npx vitest run src/lib/mediaProps.test.ts && npm run typecheck
```

Expected: 全 PASS，0 类型错误。

- [ ] **Step 8: 提交**

```bash
git add apps/web/src/lib/blocks.ts apps/web/src/lib/customize.ts \
  apps/web/src/components/builder/MediaPicker.tsx apps/web/src/components/builder/BlockProps.tsx \
  apps/web/src/lib/mediaProps.test.ts apps/web/src/styles.css
git commit -m "feat(web): add the media property type and a media library picker"
```

---

### Task 6: 体积预算、保存护栏与端到端验证

**Files:**
- Modify: `apps/web/src/lib/customize.ts`（props 体积、`covers` data URL、设计总量软警告）
- Modify: `apps/web/src/pages/admin/ThemeBuilder.tsx`（保存前用 `blockBudgetStatus` 拦截）
- Modify: `apps/web/src/lib/i18n/*`（新增文案的英文）
- Modify: `apps/web/scripts/e2e-builder-blocks.mjs`
- Test: `apps/web/src/lib/volumeBudget.test.ts`（新建）

**Interfaces:**
- Consumes: `blockBudgetStatus`（Task 2）、`normalizeBlockProps`（Task 4）。
- Produces: `PROPS_MAX_BYTES = 8192`、`DESIGN_SOFT_LIMIT_BYTES = 524288`、`COVER_DATA_URL_MAX = 65536`。
- Produces: `designVolumeReport(customization): { bytes: number; soft: boolean }`。

- [ ] **Step 1: 写失败测试**

新建 `apps/web/src/lib/volumeBudget.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { COVER_DATA_URL_MAX, PROPS_MAX_BYTES, designVolumeReport } from './customize';

describe('体积预算', () => {
  it('封面 data URL 超过 64 KB 被丢弃', () => {
    const huge = `data:image/png;base64,${'A'.repeat(COVER_DATA_URL_MAX + 10)}`;
    const report = designVolumeReport({ covers: [{ id: 'c1', url: huge }] });
    expect(report.bytes).toBeLessThan(DESIGN_SOFT_LIMIT_BYTES);
  });

  it('单块 props 超过 8 KB 的部分不再计入', () => {
    const big = 'x'.repeat(PROPS_MAX_BYTES + 100);
    const report = designVolumeReport({ home: { blocks: [{ id: 'a', type: 'text', props: { body: big } }] } });
    expect(report.bytes).toBeLessThan(PROPS_MAX_BYTES + 1024);
  });

  it('正常设计不触发软警告', () => {
    expect(designVolumeReport({ home: { blocks: [] } }).soft).toBe(false);
  });
});
```

（`DESIGN_SOFT_LIMIT_BYTES` 从 `./customize` 一并 import，测试里用到。）

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/lib/volumeBudget.test.ts
```

Expected: FAIL —— 这些导出还不存在。

- [ ] **Step 3: 在 customize.ts 实现预算**

在 `normalizeMediaUrl` 之后插入：

```ts
/** 单个区块 props 的序列化上限。 */
export const PROPS_MAX_BYTES = 8192;
/** 整份设计的软警告线（硬上限是服务端的 1 MiB）。 */
export const DESIGN_SOFT_LIMIT_BYTES = 524288;
/** 封面内联图上限；再大就是首屏负担。 */
export const COVER_DATA_URL_MAX = 65536;

function byteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
  } catch {
    return 0;
  }
}

/** 估算一份设计的体积，并判断是否越过软警告线。 */
export function designVolumeReport(customization: unknown): { bytes: number; soft: boolean } {
  const bytes = byteLength(customization);
  return { bytes, soft: bytes > DESIGN_SOFT_LIMIT_BYTES };
}
```

在 `normalizeBlockProps` 结尾加体积裁剪：

```ts
  const capped: Record<string, BlockPropValue> = {};
  for (const [key, item] of Object.entries(out)) {
    if (byteLength({ [key]: item }) > PROPS_MAX_BYTES) continue;
    capped[key] = item;
  }
  return capped;
```

把 `covers` 的归一化里 data URL 的长度上限改用 `COVER_DATA_URL_MAX`（原 1_200_000），
并丢弃超限项而不是截断。

- [ ] **Step 4: 保存护栏**

在 `apps/web/src/pages/admin/ThemeBuilder.tsx` 里，`persistBlocks` 之前加：

```tsx
  const guardBudget = (next: BlockInstance[]): boolean => {
    const total = countBlocks(next);
    if (total <= MAX_BLOCKS) return true;
    toast.error(
      t('这份编排有 {count} 个区块，超过上限 {limit} 个。请先删掉一些再保存。', {
        count: total,
        limit: MAX_BLOCKS,
      }),
    );
    return false;
  };
```

`persistBlocks` 第一行加 `if (!guardBudget(next)) return;`，
import 里补 `countBlocks`、`MAX_BLOCKS`。

- [ ] **Step 5: 补英文文案**

把本轮新增的所有 `t()` 文案补进 `apps/web/src/lib/i18n/en.ts`（沿用文件内既有格式，
中文原文作 key）。完成后跑闸门：

```bash
npm run i18n:audit && npx vitest run src/lib/i18n/coverage.test.ts
```

Expected: 覆盖率不低于既有基线，`coverage.test.ts` PASS。

- [ ] **Step 6: 扩展端到端脚本**

在 `apps/web/scripts/e2e-builder-blocks.mjs` 现有用例之后追加三步断言：

1. 打开页面编排 → 左侧组件库拖入一个「按钮」；
2. 在右侧属性面板点「添加按钮」两次，填文字与链接，刷新后断言两个按钮仍在；
3. 在图片块点「从媒体库选择」，选第一张图，刷新后断言 `img[src*="/api/v1/media/"]` 存在。

```bash
node scripts/e2e-builder-blocks.mjs
```

Expected: 输出 `PASS n / FAIL 0`，截图落在 `apps/web/.tmp/shots-builder/`。

- [ ] **Step 7: 全量验收**

```bash
npm run typecheck && npx vitest run && npm run build
```

Expected: 0 类型错误、全部测试 PASS、构建成功且 dist 增量不超过 40 KB。

- [ ] **Step 8: 提交**

```bash
git add apps/web/src/lib/customize.ts apps/web/src/pages/admin/ThemeBuilder.tsx \
  apps/web/src/lib/i18n apps/web/src/lib/volumeBudget.test.ts apps/web/scripts/e2e-builder-blocks.mjs
git commit -m "feat(web): enforce design volume budgets and guard saves at the block limit"
```

---

## Self-Review

**Spec 覆盖检查**

| 规格条目 | 落在哪个 Task |
| --- | --- |
| §4.1 数据模型（`at` / `visible` / `anchor` / `span` / `offset` / `unsupported`） | Task 2（`unsupported`）、Task 3（其余全部字段） |
| §4.2 PropSchema v2（repeater / media + 白名单递归） | Task 4、Task 5 |
| §4.3-1 未知区块保留 | Task 2 |
| §4.3-2 上限收敛、删除根级 24、拒绝静默截断 | Task 1（常量）、Task 2（归一化）、Task 6（保存护栏） |
| §4.3-3 拖拽下移补偿 | Task 1 |
| §4.4 迁移与 schema_version | Task 3 |
| §4.5 体积预算 | Task 6 |

P0 里剩下的 `richtext` / `page` / `taxonomy` / `icon` / `token-color` 五种 schema 类型，
规格把它们列在 §4.2 但**没有任何 P0 组件消费它们**——它们随 P2 的组件一起进场，
不放进 P0，避免造出没人用的表单分支。这是有意收窄，写在计划里以免执行者以为是漏项。

**占位符扫描**：无 TBD / TODO；每个代码步骤都给了完整代码；每条命令都给了期望结果。

**类型一致性**：`BlockPropValue` / `BlockPropRecord` / `BlockProps` 在 Task 4 定义，
Task 5、Task 6 沿用同一组名字；`normalizeBlockProps`、`blockPropRecord`、
`normalizeMediaUrl`、`designVolumeReport`、`blockBudgetStatus`、`MAX_BLOCKS`、
`MAX_CHILDREN_PER_CONTAINER` 全部只定义一次。
