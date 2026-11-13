# P1 Task 5 report — 像素宽折算成栅格列（一次性迁移）

- **Status:** complete
- **Branch:** `feat/page-builder-v2-p0`
- **Commit:** `c199534` — `feat(web): fold pixel widths into grid spans once`
- **Tests:** `apps/web` 58 files / 632 tests green (baseline 57 / 622 + 10 new); `tsc --noEmit` exit 0
- **Brief:** `.superpowers/sdd/p1-task-5-brief.md`（正文中文为 mojibake，代码块可读，按代码块逐字执行）

---

## 1. 交付物

### 1.1 `widthToSpan` / `migrateWidthsToSpan`（`apps/web/src/lib/blocks.ts` 末尾）

按 brief 逐字落地，只把注释的 mojibake 还原成中文原文：

```ts
/**
 * 像素宽折算成栅格列数；向上取整，坏输入按满栏处理。
 */
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
 * 只处理没有 span 的区块——已经有 span 的说明用户已经按格子排过，不再二次折算。
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

纯函数、无副作用：已经有 `children` 变化时才浅拷贝父块，`span` 已存在的块原样返回（同一引用），入参树不被修改。

### 1.2 接到读取路径（`apps/web/src/lib/customize.ts`）

```ts
/**
 * 读取路径上的一次性折算：像素宽（`width`）→ 栅格占位（`span`）。
 * …（注释说明 §5.1 一次性迁移、`at` 分档覆盖不吃这次折算）
 */
const MIGRATE_CONTAINER_WIDTH = 1200;

export function normalizeScreenLayout(value: unknown): ScreenLayout {
  const raw = value as ScreenLayout | undefined;
  const blocks = migrateWidthsToSpan(normalizeBlockList(raw?.blocks), MIGRATE_CONTAINER_WIDTH);
  …
  for (const device of ['desktop', 'tablet', 'mobile'] as const) {
    …
    devices[device] = {
      blocks: migrateWidthsToSpan(normalizeBlockList(entry.blocks), MIGRATE_CONTAINER_WIDTH),
    };
  }
  …
}
```

要点（都与任务约束对齐）：

- **只在 `normalizeScreenLayout` 里折**，也就是只有读取路径（`readCustomization` → home / article / `normalizePage`）。保存路径不写这段逻辑，`width` 不会再被折算一次；落盘仍然是原始对象，符合 "read path only"。
- **不动 `at` 覆盖**：`migrateWidthsToSpan` 只递归 `children`，不进入 `at.tablet` / `at.mobile`。`at` 里的 `width`（`blockDisplayOverride` 的合法字段，Task 1 的分档出口）原封不动，专门有一条测试钉住。
- **容器宽 1200**（brief 指定的常规内容宽估值），写成命名常量 + 注释，说明它只决定折算档位、不决定渲染宽度。
- 折叠发生在 `normalizeBlockList`（含 `MAX_READ_BLOCKS` 截断与各项清洗）**之后**，所以折的是已经清洗过、已夹到 1–1600 的 `width`；`span` 优先于 `width` 的既有语义（`types.ts` 的注释、`spanFor` 的实现）在折算里同样成立：已有 `span` 就不折。

### 1.3 `normalizeBlockAppearance` 的 padding 上限 64 → 96

上限常量在 `apps/web/src/lib/blockAppearance.ts` 的 `BLOCK_PADDING_RANGE`（检查器与归一化共用一份），brief 说的 `normalizeBlockAppearance` 用的是它，所以改这一处即可，两边同时生效：

```ts
export const BLOCK_PADDING_RANGE = { min: 0, max: 96, step: 4 } as const;
```

96 与 `SPACING_SCALE` 的最大值（`[0,4,8,12,16,24,32,48,64,96]`）对齐，语义仍是 px。`blockAppearance.test.ts` 里越界用例断言的是 `BLOCK_PADDING_RANGE.max`（自指），没有硬编码 64，因此无需改测试。

### 1.4 顺手收敛的两处一行修正

1. `section` 注册表 `defaults.padding_y`: `5` → `6`。index 5 是 24px，`SECTION_DEFAULT_PADDING_INDEX = 6`（32px）才是约定默认值；不改的话「新建分节」渲染 24px、而「坏值回落」渲染 32px，同一个默认动作两种结果。
2. `max_width` 的 `normal` 选项文案：`常规（960）` → `常规（860）`（实际 `SECTION_WIDTHS.normal = 860`），并同步英文条目 `lib_blocks.ts`: `'常规（860）': 'Regular (860)'`。i18n 覆盖率闸门按 `t()` 字面量键比对英文表，只改源码不留英文条目会立刻红。

---

## 2. TDD 过程

1. **红**：先写 `apps/web/src/lib/widthToSpan.test.ts`（brief 的 7 条 + 我补的 3 条读取路径用例，共 10 条），`npx vitest run src/lib/widthToSpan.test.ts` → `Tests 10 failed (10)`（`widthToSpan` 未导出，且 `normalizeScreenLayout` 返回的块没有 `span`）。
2. **绿**：实现 `widthToSpan` / `migrateWidthsToSpan` + 接进 `normalizeScreenLayout` + padding 上限 + 两处一行修正 → 该文件 `10 passed`。
3. **全量**：`npx vitest run` → 58 files / 632 tests passed；`npx tsc --noEmit` → exit 0；`node scripts/i18n-audit.mjs` → exit 0（输出的是仓库既有的未翻译清单，与本任务无关）。

新增的 3 条（brief 的 Step 4 没有测试，补上以免「接线」只靠肉眼）：

- 归一化把 `width: 600` 折成 `span: { base: 6 }` 并清掉 `width`；
- `devices.mobile.blocks` 里的 `width: 300` 折成 `{ base: 3 }`（1200 容器下 300/1200*12 = 3）；
- 基础 `width: 600` 被折，而 `at.mobile.width: 500` 原样保留（分档覆盖不被折算吃掉）。

---

## 3. 文件

| 文件 | 改动 |
| --- | --- |
| `apps/web/src/lib/blocks.ts` | 新增 `widthToSpan` / `migrateWidthsToSpan`；`section.defaults.padding_y` 5→6；`normal` 选项文案 960→860 |
| `apps/web/src/lib/customize.ts` | `normalizeScreenLayout` 对根列表与各设备列表各折一次（容器宽 1200 常量 + 说明注释）；import 增加 `migrateWidthsToSpan` |
| `apps/web/src/lib/widthToSpan.test.ts` | 新建，10 条测试 |
| `apps/web/src/lib/blockAppearance.ts` | `BLOCK_PADDING_RANGE.max` 64→96（brief 的 padding 上限，实体在这个文件；该文件此前是未跟踪文件，本次随提交入库） |
| `apps/web/src/lib/i18n/dict/fragments/lib_blocks.ts` | `'常规（960）': 'Regular (960)'` → `'常规（860）': 'Regular (860)'` |

**超出 brief 列出的两个文件之外**：`blockAppearance.ts`（padding 上限的实际位置，且此前未被 git 跟踪）、`i18n/dict/fragments/lib_blocks.ts`（文案键改名的英文条目）。

临时/其他说明：

- 共享工作树里另有大量与本任务无关的已修改/未跟踪文件（P0 其他批次），本次只 `git add` 上表 5 个精确路径，未使用 `git add -A` / `stash` / `checkout --`。
- 提交包含 `blockAppearance.ts` 整份新文件（186 行）：`customize.ts` 在 HEAD 上本来就 `import` 它，不入库则 HEAD 无法通过类型检查；本次的 padding 修改也落在这个文件里。若父级希望把它并到 P0 的独立提交里，可以从 `c199534` 单独摘出（内容与磁盘现状一致，无冲突风险）。
- 顺带发现（未改）：`sectionBlock.test.ts:59` 的用例标题仍写「留白档 5（32px）」，实际断言 `paddingY === 32` 走的是回落值 6（32px），标题是旧文案；不影响结果，未在本次改动范围内一并修正。
