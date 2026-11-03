# 页面编排 v2 · P1 栅格与响应式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `at`（分设备覆盖）真正被渲染层求值，并在这之上交付 `grid` / `section` 两个布局原语、间距标尺与内置可见性，最后打开 v1 三端布局的自动折算。

**Architecture:** 新增两个纯函数模块 `lib/layout.ts`（断点、间距标尺、`at` 合并）与 `lib/visibility.ts`（条件显示求值），渲染入口 `ScreenRenderer` 成为唯一的求值点；布局原语是注册表里的两个新区块，渲染器走既有 `LayoutBlocks.tsx`。编辑器只读原始树，不改写基础编排。

**Tech Stack:** React 19 + TypeScript 5.9 + Vitest 3；零新增运行时依赖。

**Spec:** `docs/superpowers/specs/2026-11-02-page-builder-v2-design.md` §5

## Global Constraints

- 不新增任何 npm 运行时依赖。
- 新界面文案一律走 `t()` 并补英文；`lib/i18n/coverage.test.ts` 是硬闸门。
- 不允许出现 `any`；`npm run typecheck` 必须 0 错误。
- **v1 配置读出来必须仍然渲染成原来的样子**——这是 P0 的验收，也是 P1 的底线。
- 渲染层是唯一求值点：编辑器不改写基础编排，`at` / `visible` 的判定只发生在 `ScreenRenderer` 及其子节点。
- 所有命令在 `apps/web` 下执行。
- 本工作树与其它会话共享：`git add` 只加精确路径，禁止 `git add -A` / `git stash` / `git checkout -- .`。若文件里有他人未提交的 hunk，用 `git diff` 过滤后 `git apply --cached` 只暂存自己的部分。
- 每个 Task 结束：`npx vitest run` 全绿 + 一次提交。

---

### Task 1: 断点、间距标尺与 `at` 求值

P0 把 `BlockInstance.at` 建模好了，但没有任何地方读它；这也是 P0 把「三端布局折算」推迟的原因。
本任务补上求值路径，并顺手把两处互相打架的断点（`builderDeviceForWidth` 用 640、思维链 `is_mobile` 用 768）
收敛到一处。

**Files:**
- Create: `apps/web/src/lib/layout.ts`
- Test: `apps/web/src/lib/layout.test.ts`
- Modify: `apps/web/src/lib/blocks.ts:1049-1053`（`builderDeviceForWidth`）
- Modify: `apps/web/src/lib/logic.ts`（`is_mobile` / `is_desktop` 改用共享断点）
- Modify: `apps/web/src/components/blocks/index.tsx`（`ScreenRenderer` 应用覆盖）

**Interfaces:**
- Produces: `BREAKPOINT_SM = 480`、`BREAKPOINT_MD = 768`、`BREAKPOINT_LG = 1024`。
- Produces: `SPACING_SCALE: readonly number[] = [0,4,8,12,16,24,32,48,64,96]` 与
  `spacingPx(index: unknown): number | undefined`（越界或非整数返回 `undefined`）。
- Produces: `overlayAt(block: BlockInstance, device: BuilderDevice): BlockInstance`——
  返回把 `at[device]` 合并进来后的新区块（不修改入参，递归进 `children`）。
- Produces: `applyDisplayOverrides(blocks: BlockInstance[], device: BuilderDevice): BlockInstance[]`。

- [ ] **Step 1: 写失败测试**

新建 `apps/web/src/lib/layout.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { BlockInstance } from '../types';
import {
  BREAKPOINT_LG,
  BREAKPOINT_MD,
  BREAKPOINT_SM,
  SPACING_SCALE,
  applyDisplayOverrides,
  overlayAt,
  spacingPx,
} from './layout';

function mk(id: string, extra: Partial<BlockInstance> = {}): BlockInstance {
  return { id, type: 'text', title: id, props: {}, animation: 'none', hidden: false, ...extra };
}

describe('断点', () => {
  it('三档从小到大且与文档一致', () => {
    expect([BREAKPOINT_SM, BREAKPOINT_MD, BREAKPOINT_LG]).toEqual([480, 768, 1024]);
  });
});

describe('spacingPx', () => {
  it('按档位下标取值', () => {
    expect(spacingPx(0)).toBe(0);
    expect(spacingPx(9)).toBe(96);
  });
  it('越界、非整数、非数字一律 undefined', () => {
    expect(spacingPx(-1)).toBeUndefined();
    expect(spacingPx(99)).toBeUndefined();
    expect(spacingPx(1.5)).toBeUndefined();
    expect(spacingPx('3')).toBeUndefined();
  });
  it('标尺是只读常量且单调递增', () => {
    expect(SPACING_SCALE).toEqual([0, 4, 8, 12, 16, 24, 32, 48, 64, 96]);
  });
});

describe('overlayAt', () => {
  it('手机覆盖隐藏时只影响手机', () => {
    const block = mk('a', { at: { mobile: { hidden: true } } });
    expect(overlayAt(block, 'mobile').hidden).toBe(true);
    expect(overlayAt(block, 'desktop').hidden).toBe(false);
  });

  it('外观对象按字段合并，不整块替换', () => {
    const block = mk('a', {
      appearance: { radius: 'md', padding: 12 },
      at: { tablet: { appearance: { radius: 'xl' } } },
    });
    expect(overlayAt(block, 'tablet').appearance).toEqual({ radius: 'xl', padding: 12 });
  });

  it('递归进子区块', () => {
    const child = mk('c', { at: { mobile: { hidden: true } } });
    const parent = mk('p', { children: [child] });
    const mobile = overlayAt(parent, 'mobile');
    expect(mobile.children?.[0].hidden).toBe(true);
    expect(overlayAt(parent, 'desktop').children?.[0].hidden).toBe(false);
  });

  it('不修改入参', () => {
    const block = mk('a', { at: { mobile: { span: { base: 6 } } } });
    overlayAt(block, 'mobile');
    expect(block.span).toBeUndefined();
  });
});

describe('applyDisplayOverrides', () => {
  it('桌面原样返回（desktop 没有覆盖层）', () => {
    const blocks = [mk('a', { at: { mobile: { hidden: true } } })];
    expect(applyDisplayOverrides(blocks, 'desktop')[0].hidden).toBe(false);
  });
  it('批量应用手机覆盖', () => {
    const blocks = [mk('a', { at: { mobile: { hidden: true } } }), mk('b')];
    expect(applyDisplayOverrides(blocks, 'mobile').map((b) => b.hidden)).toEqual([true, false]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/lib/layout.test.ts
```

Expected: FAIL —— `Cannot find module './layout'`。

- [ ] **Step 3: 写 layout.ts**

新建 `apps/web/src/lib/layout.ts`：

```ts
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
```

- [ ] **Step 4: 让 `at` 在类型上可用**

`BlockInstance` 目前没有 `align` / `gap_scale` / `mt` / `mb` 这几个顶层字段（它们只存在于
`BlockDisplayOverride` 里）。在 `apps/web/src/types.ts` 的 `BlockInstance` 里
`offset?: BlockOffset;` 之后追加：

```ts
  /** 子区块在栅格里的水平对齐（P1）。 */
  align?: 'left' | 'center' | 'right';
  /** 栅格间距档位（P1，作用于 grid 容器）。 */
  gap_scale?: number;
  /** 上外边距档位（P1，间距标尺的下标）。 */
  mt?: number;
  /** 下外边距档位（P1，间距标尺的下标）。 */
  mb?: number;
```

- [ ] **Step 5: 跑测试确认通过**

```bash
npx vitest run src/lib/layout.test.ts && npm run typecheck
```

Expected: 全部 PASS，0 类型错误。

- [ ] **Step 6: 收敛断点**

`apps/web/src/lib/blocks.ts` 的 `builderDeviceForWidth` 换成：

```ts
/** 按窗口宽度判断当前设备；阈值来自 lib/layout.ts 的唯一断点表。 */
export function builderDeviceForWidth(width: number): BuilderDevice {
  if (width < BREAKPOINT_MD) return 'mobile';
  if (width < BREAKPOINT_LG) return 'tablet';
  return 'desktop';
}
```

（顶部从 `./layout` 引入 `BREAKPOINT_MD` / `BREAKPOINT_LG`。）

`apps/web/src/lib/logic.ts` 里 `is_mobile` / `is_desktop` 的 768 改用 `BREAKPOINT_MD`，
并在注释里写明"与编排器共用同一张断点表"。

- [ ] **Step 7: 在渲染入口应用覆盖**

`apps/web/src/components/blocks/index.tsx` 的 `ScreenRenderer` 里，把：

```ts
  const blocks = screenBlocksForDevice(layout, device).filter((block) => !block.hidden);
```

改成：

```ts
  const blocks = applyDisplayOverrides(screenBlocksForDevice(layout, device), device).filter(
    (block) => !block.hidden,
  );
```

（`applyDisplayOverrides` 从 `../../lib/layout` 引入。）

- [ ] **Step 8: 全量验证并提交**

```bash
npx vitest run && npm run typecheck
```

Expected: 52 文件 / 575 以上测试全部 PASS，0 类型错误（`builderDeviceForWidth` 阈值变化不会
让既有测试变红——若有测试写死了 640，按新阈值改断言，并在报告里说明）。

```bash
git add apps/web/src/lib/layout.ts apps/web/src/lib/layout.test.ts apps/web/src/lib/blocks.ts \
  apps/web/src/lib/logic.ts apps/web/src/types.ts apps/web/src/components/blocks/index.tsx
git commit -m "feat(web): evaluate per-device overrides and unify the breakpoint table"
```

---

### Task 2: 内置条件显示（`visible`）

**Files:**
- Create: `apps/web/src/lib/visibility.ts`
- Test: `apps/web/src/lib/visibility.test.ts`
- Modify: `apps/web/src/components/blocks/index.tsx`

**Interfaces:**
- Consumes: `overlayAt`（Task 1）。
- Produces: `type ViewerRole = 'guest' | 'member' | 'admin'`。
- Produces: `isVisibleAt(block: Pick<BlockInstance, 'visible'>, ctx: { device, role, now }): boolean`。
- Produces: `roleFromSession(me: Me | null): ViewerRole`——`null` → guest；`platform_admin`/`site_admin` → admin；其余登录用户 → member。

- [ ] **Step 1: 写失败测试**

新建 `apps/web/src/lib/visibility.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { isVisibleAt } from './visibility';

const now = new Date('2026-11-03T12:00:00Z');
const ctx = (role: 'guest' | 'member' | 'admin' = 'guest', device: 'desktop' | 'mobile' = 'desktop') => ({
  role,
  device,
  now,
});

describe('isVisibleAt', () => {
  it('没有 visible 就是可见', () => {
    expect(isVisibleAt({}, ctx())).toBe(true);
  });

  it('设备白名单', () => {
    const block = { visible: { devices: ['mobile' as const] } };
    expect(isVisibleAt(block, ctx('guest', 'mobile'))).toBe(true);
    expect(isVisibleAt(block, ctx('guest', 'desktop'))).toBe(false);
  });

  it('角色白名单', () => {
    const block = { visible: { roles: ['member' as const, 'admin' as const] } };
    expect(isVisibleAt(block, ctx('guest'))).toBe(false);
    expect(isVisibleAt(block, ctx('member'))).toBe(true);
  });

  it('时间窗前可见、窗内可见、窗后不可见', () => {
    const block = { visible: { from: '2026-11-01', to: '2026-11-10' } };
    expect(isVisibleAt(block, { ...ctx(), now: new Date('2026-10-31T00:00:00Z') })).toBe(false);
    expect(isVisibleAt(block, { ...ctx(), now: new Date('2026-11-05T00:00:00Z') })).toBe(true);
    expect(isVisibleAt(block, { ...ctx(), now: new Date('2026-11-11T00:00:00Z') })).toBe(false);
  });

  it('坏日期一律当作没有这个限制，不抛异常', () => {
    const block = { visible: { from: 'not-a-date' } };
    expect(() => isVisibleAt(block, ctx())).not.toThrow();
    expect(isVisibleAt(block, ctx())).toBe(true);
  });

  it('三个条件同时存在时全部满足才可见', () => {
    const block = {
      visible: { devices: ['mobile' as const], roles: ['member' as const], from: '2026-11-01' },
    };
    expect(isVisibleAt(block, ctx('member', 'mobile'))).toBe(true);
    expect(isVisibleAt(block, ctx('guest', 'mobile'))).toBe(false);
    expect(isVisibleAt(block, ctx('member', 'desktop'))).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/lib/visibility.test.ts
```

Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写 visibility.ts**

```ts
import type { BlockInstance, BuilderDevice, Me } from '../types';

/** 访客在这次渲染里扮演的角色。 */
export type ViewerRole = 'guest' | 'member' | 'admin';

export interface VisibilityContext {
  device: BuilderDevice;
  role: ViewerRole;
  now: Date;
}

/** 从登录态推出角色。个人站点里所有登录账户都是管理员，由 me.role 直接决定。 */
export function roleFromSession(me: Me | null): ViewerRole {
  if (!me) return 'guest';
  return me.role === 'platform_admin' || me.role === 'site_admin' ? 'admin' : 'member';
}

function dateOf(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/**
 * 条件显示求值。
 *
 * 三组条件全部满足才可见；缺某组表示该组不设限。坏日期按"没写"处理——
 * 一个手滑的日期不该让整块内容从站点上消失。
 *
 * 注意：这是排版工具，不是访问控制。站点设计文档对所有访客是同一份公开 JSON，
 * 用 visible 藏内容不构成安全边界。
 */
export function isVisibleAt(
  block: Pick<BlockInstance, 'visible'>,
  ctx: VisibilityContext,
): boolean {
  const visible = block.visible;
  if (!visible) return true;

  if (visible.devices?.length && !visible.devices.includes(ctx.device)) return false;
  if (visible.roles?.length && !visible.roles.includes(ctx.role)) return false;

  const now = ctx.now.getTime();
  const from = dateOf(visible.from);
  const to = dateOf(visible.to);
  if (from !== null && now < from) return false;
  // to 是「含当天」：把结束日期当作那天的最后一毫秒。
  if (to !== null && now > to + 86_399_999) return false;
  return true;
}
```

- [ ] **Step 4: 接进渲染入口**

`components/blocks/index.tsx` 的 `ScreenRenderer`：

```tsx
  const { me } = useAuth();
  const role = roleFromSession(me);
  const now = useMemo(() => new Date(), []);
  const blocks = applyDisplayOverrides(screenBlocksForDevice(layout, device), device)
    .filter((block) => !block.hidden)
    .filter((block) => isVisibleAt(block, { device, role, now }));
```

`useAuth` 来自 `../../lib/session`；`useMemo` 加进 react import。
子区块的过滤放在 `BlockView` 里：容器渲染 `visibleChildren` 之前，同样按 `isVisibleAt` 过滤
（`BlockView` 里已经有 `visibleChildren` 的计算，把 `.filter((child) => !child.hidden)` 扩成
两个过滤条件即可；角色与 now 通过 props 从 `ScreenRenderer` 传下去，或用一个轻量的
`VisibilityContext` React context——选后者的实现要在报告里说明理由）。

- [ ] **Step 5: 全量验证并提交**

```bash
npx vitest run && npm run typecheck
git add apps/web/src/lib/visibility.ts apps/web/src/lib/visibility.test.ts apps/web/src/components/blocks/index.tsx
git commit -m "feat(web): evaluate per-block visibility at render time"
```

---

### Task 3: `grid` 布局原语

**Files:**
- Modify: `apps/web/src/lib/blocks.ts`（注册 `grid`）
- Modify: `apps/web/src/components/blocks/LayoutBlocks.tsx`（`GridBlock`）
- Modify: `apps/web/src/components/blocks/index.tsx`（分派）
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/lib/gridBlock.test.ts`

**Interfaces:**
- Consumes: `SPACING_SCALE` / `spacingPx`、`BlockInstance.span/offset`。
- Produces: `gridTemplate(block: BlockInstance): { columns: number; gap: number }`——纯函数，供渲染器与测试共用。
- Produces: `spanFor(block: BlockInstance, device: BuilderDevice): { span: number; offset: number }`——夹到 1–12，缺省满宽。

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/lib/gridBlock.test.ts
import { describe, expect, it } from 'vitest';
import type { BlockInstance } from '../types';
import { gridTemplate, spanFor } from './blocks';

function mk(extra: Partial<BlockInstance> = {}): BlockInstance {
  return { id: 'g', type: 'grid', title: 'g', props: {}, animation: 'none', hidden: false, ...extra };
}

describe('gridTemplate', () => {
  it('默认 12 栏、间距档位 4', () => {
    expect(gridTemplate(mk({ props: {} }))).toEqual({ columns: 12, gap: 16 });
  });
  it('栏数夹在 1–12', () => {
    expect(gridTemplate(mk({ props: { columns: 99 } })).columns).toBe(12);
    expect(gridTemplate(mk({ props: { columns: 0 } })).columns).toBe(1);
  });
  it('间距走标尺，非法档位回落实心默认', () => {
    expect(gridTemplate(mk({ props: { gap: 9 } })).gap).toBe(96);
    expect(gridTemplate(mk({ props: { gap: 99 } })).gap).toBe(16);
  });
});

describe('spanFor', () => {
  it('没有 span 时占满整行', () => {
    expect(spanFor(mk(), 'desktop')).toEqual({ span: 12, offset: 0 });
  });
  it('按断点取 span', () => {
    const block = mk({ span: { base: 6, md: 8, sm: 12 }, offset: { base: 1 } });
    expect(spanFor(block, 'desktop')).toEqual({ span: 6, offset: 1 });
    expect(spanFor(block, 'tablet')).toEqual({ span: 8, offset: 1 });
    expect(spanFor(block, 'mobile')).toEqual({ span: 12, offset: 1 });
  });
  it('越界一律夹住', () => {
    expect(spanFor(mk({ span: { base: 99 }, offset: { base: 99 } }), 'desktop')).toEqual({
      span: 12,
      offset: 11,
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/lib/gridBlock.test.ts
```

Expected: FAIL —— `gridTemplate` / `spanFor` 未导出。

- [ ] **Step 3: 在 blocks.ts 加纯函数与注册表条目**

在 `apps/web/src/lib/blocks.ts` 末尾加：

```ts
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? Math.round(value) : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** grid 容器的栏数与间距（px）；间距档位非法时回落到 16px。 */
export function gridTemplate(block: BlockInstance): { columns: number; gap: number } {
  const columns = clampInt(block.props.columns, 1, 12, 12);
  const gap = spacingPx(clampInt(block.props.gap, 0, SPACING_SCALE.length - 1, 4)) ?? 16;
  return { columns, gap };
}

/** 子区块在某一设备下的占位与偏移；缺省满宽、无偏移。 */
export function spanFor(
  block: BlockInstance,
  device: BuilderDevice,
): { span: number; offset: number } {
  const pick = (value: { base?: number; md?: number; sm?: number } | undefined, fallback: number) => {
    if (!value) return fallback;
    if (device === 'tablet' && value.md !== undefined) return value.md;
    if (device === 'mobile' && value.sm !== undefined) return value.sm;
    return value.base ?? fallback;
  };
  return {
    span: clampInt(pick(block.span, 12), 1, 12, 12),
    offset: clampInt(pick(block.offset, 0), 0, 11, 0),
  };
}
```

在 `RAW_BLOCK_DEFS` 里 `container` 条目之后追加：

```ts
  {
    type: 'grid',
    name: t('栅格'),
    description: t('12 栏栅格容器：子区块可以占 1–12 栏、左右偏移，栏距走间距标尺。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: { columns: 12, gap: 4 },
    schema: [
      { key: 'columns', label: t('栏数'), type: 'number', min: 1, max: 12, step: 1 },
      { key: 'gap', label: t('栏距'), type: 'number', min: 0, max: 9, step: 1, hint: t('0–9，对应 0–96px 的间距标尺。') },
    ],
  },
  {
    type: 'section',
    name: t('分节'),
    description: t('一整段版面：可限宽、可设上下留白、可加底色与分隔线。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: { max_width: 'normal', padding_y: 5, background: '', divider: false },
    schema: [
      {
        key: 'max_width',
        label: t('内容宽度'),
        type: 'select',
        options: [
          { value: 'narrow', label: t('窄（640）') },
          { value: 'normal', label: t('常规（860）') },
          { value: 'wide', label: t('宽（1200）') },
          { value: 'full', label: t('满宽') },
        ],
      },
      { key: 'padding_y', label: t('上下留白'), type: 'number', min: 0, max: 9, step: 1, hint: t('0–9，对应 0–96px 的间距标尺。') },
      { key: 'background', label: t('底色'), type: 'color' },
      { key: 'divider', label: t('上下分隔线'), type: 'toggle' },
    ],
  },
```

顶部 import 补 `spacingPx`、`SPACING_SCALE`（来自 `./layout`）。

- [ ] **Step 4: 渲染器**

`apps/web/src/components/blocks/LayoutBlocks.tsx` 追加：

```tsx
/** 12 栏栅格：子区块按 span/offset 落位，断点用容器查询而不是媒体查询。 */
export function GridBlock({
  block,
  renderChild,
}: {
  block: BlockInstance;
  renderChild: (child: BlockInstance) => ReactElement;
}) {
  const { columns, gap } = gridTemplate(block);
  return (
    <div
      className="pp-grid"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap }}
    >
      {(block.children ?? []).map((child) => (
        <div
          key={child.id}
          className="pp-grid-cell"
          style={{ gridColumn: `${gridColumnOf(child)} / span ${gridColumnOf(child, true)}` }}
        >
          {renderChild(child)}
        </div>
      ))}
    </div>
  );
}

/** 只在渲染期算：device 由外层 CSS 变量决定，这里产出的是基础与断点两套值。 */
function gridColumnOf(child: BlockInstance, span = false): number {
  const base = span ? spanFor(child, 'desktop').span : spanFor(child, 'desktop').offset + 1;
  return base;
}
```

> 断点差异化用 CSS 变量 + 容器查询实现：`GridBlock` 在容器上写
> `--span-base` / `--span-md` / `--span-sm`，`styles.css` 里用
> `@container (max-width: 1023px) { .pp-grid-cell { grid-column-end: span var(--span-md) } }`
> 之类的规则切换。实现时把这三个变量写进 `style`，CSS 规则三档齐全即可；
> 具体写法在报告里贴出来，确保预览 iframe 改宽度时真的重排。

在 `components/blocks/index.tsx` 的分派链里，`container` 分支之后加 `grid`：

```tsx
      ) : block.type === 'grid' ? (
        <GridBlock block={block} renderChild={(child) => <BlockView key={child.id} block={child} />} />
```

- [ ] **Step 5: 验收**

```bash
npx vitest run && npm run typecheck && npm run build
```

Expected: 全绿；构建体积增量 < 10 KB。

```bash
git add apps/web/src/lib/blocks.ts apps/web/src/lib/gridBlock.test.ts \
  apps/web/src/components/blocks/LayoutBlocks.tsx apps/web/src/components/blocks/index.tsx apps/web/src/styles.css
git commit -m "feat(web): add the 12-column grid block"
```

---

### Task 4: `section` 布局原语

**Files:**
- Modify: `apps/web/src/lib/blocks.ts`（注册条目已随 Task 3 加好，本任务补渲染所需纯函数）
- Modify: `apps/web/src/components/blocks/LayoutBlocks.tsx`
- Modify: `apps/web/src/components/blocks/index.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/lib/sectionBlock.test.ts`

**Interfaces:**
- Consumes: `spacingPx`、`SPACING_SCALE`。
- Produces: `sectionLayout(block: BlockInstance): { maxWidth?: number; paddingY: number; background?: string; divider: boolean }`。

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/lib/sectionBlock.test.ts
import { describe, expect, it } from 'vitest';
import type { BlockInstance } from '../types';
import { sectionLayout } from './blocks';

function mk(props: Record<string, unknown> = {}): BlockInstance {
  return { id: 's', type: 'section', title: 's', props, animation: 'none', hidden: false };
}

describe('sectionLayout', () => {
  it('默认常规宽度、留白档 5（32px）、无底色、无分隔线', () => {
    expect(sectionLayout(mk())).toEqual({ maxWidth: 860, paddingY: 32, background: undefined, divider: false });
  });
  it('满宽不设 maxWidth', () => {
    expect(sectionLayout(mk({ max_width: 'full' })).maxWidth).toBeUndefined();
  });
  it('坏档位回落 32px，坏颜色被丢弃', () => {
    expect(sectionLayout(mk({ padding_y: 99 })).paddingY).toBe(32);
    expect(sectionLayout(mk({ background: 'not-a-color' })).background).toBeUndefined();
  });
  it('分隔线开关', () => {
    expect(sectionLayout(mk({ divider: true })).divider).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/lib/sectionBlock.test.ts
```

- [ ] **Step 3: 实现**

`blocks.ts` 末尾：

```ts
const SECTION_WIDTHS: Record<string, number | undefined> = {
  narrow: 640,
  normal: 860,
  wide: 1200,
  full: undefined,
};

/** section 的取宽带与留白；颜色只接受 #rgb / #rrggbb / #rrggbbaa。 */
export function sectionLayout(block: BlockInstance): {
  maxWidth?: number;
  paddingY: number;
  background?: string;
  divider: boolean;
} {
  const raw = block.props;
  const width = typeof raw.max_width === 'string' ? raw.max_width : 'normal';
  const paddingY = spacingPx(typeof raw.padding_y === 'number' ? raw.padding_y : 5) ?? 32;
  const color = typeof raw.background === 'string' ? raw.background.trim() : '';
  return {
    maxWidth: SECTION_WIDTHS[width] ?? 860,
    paddingY,
    background: /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color) ? color : undefined,
    divider: raw.divider === true,
  };
}
```

`LayoutBlocks.tsx` 追加：

```tsx
/** 分节：限宽 + 上下留白 + 可选底色与上下分隔线。 */
export function SectionBlock({
  block,
  children,
}: {
  block: BlockInstance;
  children: ReactNode;
}) {
  const { maxWidth, paddingY, background, divider } = sectionLayout(block);
  return (
    <section
      className={`pp-section${divider ? ' pp-section-divided' : ''}`}
      style={{
        paddingTop: paddingY,
        paddingBottom: paddingY,
        background: background ?? undefined,
      }}
    >
      <div className="pp-section-inner" style={{ maxWidth: maxWidth ? `${maxWidth}px` : undefined }}>
        {children}
      </div>
    </section>
  );
}
```

`index.tsx` 分派链在 `grid` 之后加 `section` 分支（渲染 `visibleChildren`）。

`styles.css` 追加：

```css
.pp-section-inner { margin-inline: auto; width: 100%; }
.pp-section-divided { border-block: 1px solid var(--line); }
```

- [ ] **Step 4: 验收并提交**

```bash
npx vitest run && npm run typecheck
git add apps/web/src/lib/blocks.ts apps/web/src/lib/sectionBlock.test.ts \
  apps/web/src/components/blocks/LayoutBlocks.tsx apps/web/src/components/blocks/index.tsx apps/web/src/styles.css
git commit -m "feat(web): add the section block"
```

---

### Task 5: 像素宽折算成栅格列

**Files:**
- Modify: `apps/web/src/lib/customize.ts`
- Modify: `apps/web/src/lib/blocks.ts`
- Test: `apps/web/src/lib/widthToSpan.test.ts`（新建）

**Interfaces:**
- Produces: `widthToSpan(width: number, containerWidth: number, columns: number): number`——纯函数。
- Produces: `migrateWidthsToSpan(blocks: BlockInstance[], containerWidth: number): BlockInstance[]`。

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/lib/widthToSpan.test.ts
import { describe, expect, it } from 'vitest';
import type { BlockInstance } from '../types';
import { migrateWidthsToSpan, widthToSpan } from './blocks';

function mk(id: string, extra: Partial<BlockInstance> = {}): BlockInstance {
  return { id, type: 'text', title: id, props: {}, animation: 'none', hidden: false, ...extra };
}

describe('widthToSpan', () => {
  it('半宽换算成 6 栏', () => {
    expect(widthToSpan(600, 1200, 12)).toBe(6);
  });
  it('向上取整，避免窄块算出 0 栏', () => {
    expect(widthToSpan(10, 1200, 12)).toBe(1);
  });
  it('超过容器宽夹到满栏', () => {
    expect(widthToSpan(5000, 1200, 12)).toBe(12);
  });
  it('坏输入返回满栏', () => {
    expect(widthToSpan(Number.NaN, 1200, 12)).toBe(12);
    expect(widthToSpan(600, 0, 12)).toBe(12);
  });
});

describe('migrateWidthsToSpan', () => {
  it('有 width 的区块被换成 span 并清掉 width', () => {
    const blocks = [mk('a', { width: 600 }), mk('b')];
    const next = migrateWidthsToSpan(blocks, 1200);
    expect(next[0].span).toEqual({ base: 6 });
    expect(next[0].width).toBeUndefined();
    expect(next[1].span).toBeUndefined();
  });
  it('已经有 span 的区块不动', () => {
    const blocks = [mk('a', { width: 600, span: { base: 3 } })];
    expect(migrateWidthsToSpan(blocks, 1200)[0]).toEqual(blocks[0]);
  });
  it('递归进子区块且不修改入参', () => {
    const child = mk('c', { width: 600 });
    const blocks = [mk('p', { children: [child] })];
    const next = migrateWidthsToSpan(blocks, 1200);
    expect(next[0].children?.[0].span).toEqual({ base: 6 });
    expect(blocks[0].children?.[0].span).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/lib/widthToSpan.test.ts
```

- [ ] **Step 3: 实现**

`blocks.ts` 末尾：

```ts
/** 像素宽折算成栅格列数；向上取整，坏输入按满栏处理。 */
export function widthToSpan(width: number, containerWidth: number, columns = 12): number {
  if (!Number.isFinite(width) || !Number.isFinite(containerWidth) || containerWidth <= 0) {
    return columns;
  }
  const raw = Math.ceil((width / containerWidth) * columns);
  return Math.min(columns, Math.max(1, raw));
}

/**
 * 一次性把「像素宽」折算成「栅格占位」。
 *
 * 只处理没有 span 的区块——已经有 span 的说明用户已经按栅格排过，不再二次折算。
 * 这是 P1 §5.1 定下的一次性迁移：不保留两套宽度语义并存。
 */
export function migrateWidthsToSpan(
  blocks: BlockInstance[],
  containerWidth: number,
  columns = 12,
): BlockInstance[] {
  return blocks.map((block) => {
    const children = block.children?.length
      ? migrateWidthsToSpan(block.children, containerWidth, columns)
      : block.children;
    const next: BlockInstance = children !== block.children ? { ...block, children } : block;
    if (typeof block.width !== 'number' || block.width <= 0 || block.span) return next;
    const { width: _dropWidth, ...rest } = next;
    return { ...rest, span: { base: widthToSpan(block.width, containerWidth, columns) } };
  });
}
```

- [ ] **Step 4: 接到读取路径**

在 `customize.ts` 的 `normalizeScreenLayout` 返回之前，对 `blocks` 与每个设备的 `blocks`
各跑一次 `migrateWidthsToSpan(list, 1200)`（容器宽按 1200 的常规内容宽度估算），
并加注释说明"这是 §5.1 的一次性折算"。

同时把 `normalizeBlockAppearance` 的 padding 上限从 64 放宽到 96（与标尺最大值对齐），
语义仍是 px。

- [ ] **Step 5: 验收并提交**

```bash
npx vitest run && npm run typecheck
git add apps/web/src/lib/blocks.ts apps/web/src/lib/widthToSpan.test.ts apps/web/src/lib/customize.ts
git commit -m "feat(web): fold pixel widths into grid spans once"
```

---

### Task 6: 打开 v1 三端布局的自动折算

P0 把 `foldDeviceLayouts` 留成了"等 `at` 求值后再调用"。Task 1 已经让渲染层真正读 `at`，
现在可以打开它了。

**Files:**
- Modify: `apps/web/src/lib/customize.ts`
- Modify: `apps/web/src/lib/migrate.ts`
- Test: `apps/web/src/lib/migrate.test.ts`（追加）

**Interfaces:**
- Consumes: `foldDeviceLayouts`（P0）、`applyDisplayOverrides`（Task 1）。
- Produces: `readCustomization` 对 v1 文档（无 `schema_version` 或 `< 2`）先折算再归一化。

- [ ] **Step 1: 写失败测试**

在 `migrate.test.ts` 追加：

```ts
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
```

（`migrateCustomization` 增加第二个可选参数 `{ foldDevices?: boolean }`，默认 `false`——
P0 的行为保持默认，只有 `readCustomization` 显式打开它。）

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/lib/migrate.test.ts
```

Expected: FAIL —— 第二个参数还不存在。

- [ ] **Step 3: 实现并接线**

`migrate.ts`：`migrateCustomization(raw, options = {})`；当 `options.foldDevices === true` 时，
对 `home` / `article` / `pages[].layout` 调用 `foldDeviceLayouts`，把报告合并进 `report`。

`customize.ts` 的 `readCustomization` 改成：

```ts
const migrated = migrateCustomization(config.customization, { foldDevices: true });
```

- [ ] **Step 4: 验收并提交**

```bash
npx vitest run && npm run typecheck
git add apps/web/src/lib/migrate.ts apps/web/src/lib/migrate.test.ts apps/web/src/lib/customize.ts
git commit -m "feat(web): fold legacy split-device layouts now that at is rendered"
```

---

### Task 7: 编辑器的继承 / 覆盖态

**Files:**
- Modify: `apps/web/src/components/builder/BlockInspector.tsx`
- Modify: `apps/web/src/pages/admin/ThemeBuilder.tsx`
- Test: 已有组件测试模式下补一个 `BlockInspector` 的轻量断言（若项目没有组件测试基建，则在报告里说明并只做类型与现有测试回归）

**Interfaces:**
- Consumes: `overlayAt`、`BlockDisplayOverride`。
- Produces: `writeOverride(block: BlockInstance, device: BuilderDevice, patch: BlockDisplayOverride): BlockInstance`——
  非桌面设备时写进 `at[device]`；桌面写回基础字段。放在 `lib/layout.ts`。

- [ ] **Step 1: 写失败测试**（追加到 `layout.test.ts`）

```ts
import { writeOverride } from './layout';

it('手机上改外观写进 at.mobile，不动基础外观', () => {
  const block = mk('a', { appearance: { radius: 'md' } });
  const next = writeOverride(block, 'mobile', { appearance: { radius: 'xl' } });
  expect(next.appearance).toEqual({ radius: 'md' });
  expect(next.at?.mobile?.appearance).toEqual({ radius: 'xl' });
});

it('桌面上改外观写回基础字段', () => {
  const block = mk('a', { appearance: { radius: 'md' } });
  const next = writeOverride(block, 'desktop', { appearance: { radius: 'xl' } });
  expect(next.appearance).toEqual({ radius: 'xl' });
  expect(next.at?.desktop).toBeUndefined();
});

it('恢复继承：传空 patch 时删掉该设备的覆盖', () => {
  const block = mk('a', { at: { mobile: { hidden: true } } });
  const next = writeOverride(block, 'mobile', {});
  expect(next.at?.mobile).toBeUndefined();
});
```

- [ ] **Step 2: 实现 `writeOverride`**（`lib/layout.ts`）

规则：`desktop` 直接合并到顶层；其余设备把 patch 合并进 `at[device]`；
合并后该设备覆盖为空对象时删掉这个键；`at` 变空时删掉 `at`。

- [ ] **Step 3: 编辑器接线**

`BlockInspector` 的属性写入从 `patch({ appearance })` 改为
`patch(writeOverride(block, device, { appearance }))`——`device` 由 `ThemeBuilder` 传下来。
非桌面设备时，每条被覆盖的属性旁显示「已覆盖」并给一个「恢复继承」按钮（调 `writeOverride(block, device, {})`）。
`ThemeBuilder` 切换设备时**不再 `history.reset`**：撤销栈跨设备保留，因为现在改的可能是同一棵树的不同层。

- [ ] **Step 4: 验收并提交**

```bash
npx vitest run && npm run typecheck
git add apps/web/src/lib/layout.ts apps/web/src/lib/layout.test.ts \
  apps/web/src/components/builder/BlockInspector.tsx apps/web/src/pages/admin/ThemeBuilder.tsx
git commit -m "feat(web): edit per-device overrides in the inspector"
```

---

## Self-Review

**规格覆盖**

| 规格条目 | 任务 |
| --- | --- |
| §5.1 `grid`（12 栏 / span / offset / gap 标尺 / 容器查询） | Task 3 |
| §5.1 `section`（宽度档 / 间距 / 背景 / 分隔线） | Task 4 |
| §5.1 `width: px` 一次性折算 | Task 5 |
| §5.2 间距标尺 + `padding` 上限 96 | Task 1（标尺）、Task 5（上限） |
| §5.3 `at` 求值 / 编辑器继承覆盖 / 撤销栈 | Task 1、Task 6、Task 7 |
| §5.3 断点统一 480/768/1024 | Task 1 |
| §5.4 `visible` 求值 | Task 2 |

**依赖顺序**：Task 1 必须先做（`at` 求值是 Task 6 的前提）；Task 3 依赖 Task 1 的间距标尺；
其余互不阻塞。

**刻意留到 P2 的**：`anchor` 与 `anchor-nav`（需要目录组件一起上）、`SPACING_SCALE` 在面板里的
档位按钮（属 P2 的编辑器手感工作）、迁移报告 UI（属 P3 的运营面板）。
