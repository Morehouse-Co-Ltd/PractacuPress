# Web Task 2 report — unknown-block retention + root-level cap removal

Status: **DONE_WITH_CONCERNS**
Branch: `feat/page-builder-v2-p0`
Commit: `f8515d3` — `fix(web): keep unknown block types and drop the silent root-level cap`

## What changed

### 1. `apps/web/src/types.ts`
Added to `BlockInstance` (immediately after `appearance?: BlockAppearance;`), verbatim from the brief:

```ts
  /**
   * 归一化时无法识别的区块类型：保留原样、不渲染、保存时写回。
   * 这样从更新版本导出的设计不会因为本版本不认识而在下一次保存时永久消失。
   */
  unsupported?: boolean;
```

### 2. `apps/web/src/lib/customize.ts`
All quoted anchors from the brief were present (line numbers had drifted by ~11 lines):

- import: added `MAX_CHILDREN_PER_CONTAINER` to the existing `./blockTree` import (it already imported `MAX_BLOCKS`, `MAX_BLOCK_DEPTH`, `clampColumn`, `countBlocks`).
- `normalizeBlock` type guard replaced:
  - `if (typeof raw.type !== 'string' || !BLOCK_TYPES.has(raw.type)) return null;`
  - → `if (typeof raw.type !== 'string' || !raw.type) return null;` + `const known = BLOCK_TYPES.has(raw.type);`
- child cap `80` → `MAX_CHILDREN_PER_CONTAINER`.
- unknown-type branch inserted before `const appearance = normalizeBlockAppearance(raw.appearance);`: keeps `id`, truncated `type`/`title`, scalar-only `props` (no clamping/truncation — values pass through untouched), `animation`, `hidden`, `unsupported: true`, and `children` when present. Unknown blocks still consume the `MAX_BLOCKS` budget (increment happens before the branch).
- `normalizeBlockList`: removed the root-level `.slice(0, 24)`. The existing `MAX_BLOCKS` subtree-trimming tail was left intact.
- `normalizeLayout` renamed and exported as `normalizeScreenLayout` (brief prose said "改名并导出"; the snippet showed a wrapper — I renamed instead of adding a dead alias). Its three internal call sites (`readCustomization` home/article, `normalizePage`) were updated.
- new export added right after it:

```ts
export function blockBudgetStatus(layout: ScreenLayout): { total: number; limit: number; over: boolean }
```

  `total` = max(root tree size, 0, each device tree size), `limit = MAX_BLOCKS`, `over = total > MAX_BLOCKS`.

### 3. `apps/web/src/lib/customizeBlocks.test.ts` (new)
Six tests exactly as specified (unknown type kept + `unsupported`/`props` preserved; 30 root blocks survive; container children capped at 80; item without `type` dropped; 201 blocks → `over` + `limit === 200`; single block → not over).

One typing-only deviation: the `textBlock` helper uses `animation: 'none' as const`. With the brief's literal, `animation` widened to `string`, so the helper's array was not assignable to `BlockInstance[]` and `npx tsc --noEmit` failed with TS2322 at the two `blockBudgetStatus` calls (lines 44/50). Assertions are unchanged.

## TDD evidence (run from `apps/web`)

### Red — before implementation
`npx vitest run src/lib/customizeBlocks.test.ts`

```
 Test Files  1 failed (1)
      Tests  6 failed (6)
```

All six failed on the missing seam, e.g.:

```
TypeError: (0 , normalizeScreenLayout) is not a function
 ❯ src/lib/customizeBlocks.test.ts:36:20
TypeError: (0 , blockBudgetStatus) is not a function
 ❯ src/lib/customizeBlocks.test.ts:44:20
```

(The unknown-type assertion could not even reach its "0 blocks" failure because the export did not exist yet; per the brief that assertion is the one that would otherwise have gotten 0 blocks.)

### Green — after implementation
`npx vitest run src/lib/customizeBlocks.test.ts`

```
 ✓ src/lib/customizeBlocks.test.ts (6 tests) 21ms
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

### Full suite
`npx vitest run`

```
 Test Files  47 passed (47)
      Tests  528 passed (528)
```

No pre-existing test regressed from dropping the 24-block root cap.

### Typecheck
`npx tsc --noEmit` → exit 0, no output (after the test-helper `as const` fix).

## Concerns / things noticed

1. **Commit is not scoped to this task's edits.** `apps/web/src/types.ts` and `apps/web/src/lib/customize.ts` already carried large uncommitted work from other sessions before I touched them (e.g. `Site.registration_open`, `SiteDomainVerification`, `BlockAppearance`/`BlockRadius`/`BlockShadow`/`BlockCrop`, `highRiskCustomCssMarker`, `sanitizeCustomCss`, `normalizeBlockAppearance` import). The brief prescribes `git add <exact paths>`, and no partial-hunk staging was possible without risking a commit that does not typecheck on its own, so commit `f8515d3` contains those foreign changes too (`3 files changed, 349 insertions(+), 45 deletions(-)`; this task's own share is ~60 lines). Nothing was lost from the working tree — the other sessions still have the rest of their edits unstaged — but the commit is a mixed-attribution commit and should be reviewed with that in mind. Nothing outside the three listed paths was staged, added, stashed, or reverted.
2. **Renderer does not yet truly skip unsupported blocks.** `components/blocks/index.tsx` resolves `RENDERERS[displayBlock.type]`; an unknown type yields `undefined` → the block renders an empty `<section class="pp-block">` shell (no crash, no content) rather than being omitted. That file is not in the brief's Files list, so I left it alone; a follow-up (or the renderer task) should skip `block.unsupported` / unknown renderers.
3. **Inspector is already safe for unknown types.** `components/builder/BlockProps.tsx:270` returns the hint `这个组件类型已不存在，删除它再添加新的。` when `blockDef(block.type)` is missing, so no crash there.
4. **`blockBudgetStatus` device cast is as specified.** `Object.values(layout.devices ?? {})` then `entry as { blocks: BlockInstance[] }` matches the brief verbatim. Since `devices` is `Partial<Record<BuilderDevice, ...>>`, an entry explicitly set to `undefined` (impossible via JSON, possible in memory) would throw. Left verbatim per brief.
5. `normalizeBlockList` still hard-trims to `MAX_BLOCKS` (200) by dropping whole root subtrees from the tail. That is a silent trim of a different kind; the brief only asked for the 24-block cap removal, and `blockBudgetStatus` now exists so the editor can warn before save.

## Fix: 未知区块不再留空壳

`apps/web/src/components/blocks/index.tsx` — `BlockView` 顶部（`useRef`/`useInView`/`usePageSkeleton`/`useFeed` 之前）新增：

```tsx
if (block.unsupported === true) return null;
```

不再产出空的 `<section class="pp-block">` 外壳及其边距/间距。提前 return 早于任何 hook，安全性依赖「同一元素实例生命周期内 `unsupported` 不变」——由 `normalizeBlock` 一次性写入，已核对该字段只在 `src/lib/customize.ts:600` 出现一次写入。`ScreenRenderer` 的 `hidden` 过滤链未改动（另一关注点）。按指示未新增组件测试；`src/lib/customizeBlocks.test.ts` 已覆盖 `unsupported` 标记。

验证（`apps/web`）：

```
npx vitest run
 Test Files  47 passed (47)
      Tests  528 passed (528)
```

```
npm run typecheck
> tsc --noEmit
```
exit 0，0 errors。

提交 `2775d8f`（`fix(web): paint nothing for blocks from a newer schema`）只含该一个文件，但该文件此前已带其他会话的未提交改动（骨架模式、数据绑定等），因此提交里也包含它们（52 insertions / 16 deletions，本任务约 5 行）。仅 `git add apps/web/src/components/blocks/index.tsx`，未用 `git add -A`。

## Fix: 评审四项

四个评审意见的落地（branch `feat/page-builder-v2-p0`）：

1. **hooks 安全**：`apps/web/src/components/blocks/index.tsx` — `BlockView` 的 `if (block.unsupported === true) return null;` 从 hooks 之前移到全部 hooks（`useRef` / `useInView` / `usePageSkeleton` / `useFeed` / `useBlockDataContext` / `useMemo` / `useEffect`）之后、`return (<section>` 之前。中文注释同步更新：守卫在所有 hooks 之后，即使日后有人在原地改掉 `unsupported`，多次渲染的 hooks 调用顺序也不会变化，不会出现「Rendered fewer hooks than expected」。
2. **数据卫生**：`apps/web/src/lib/customize.ts` 抽出 `scalarValue(item)`（字符串 `slice(0, 4000)`、数字夹到 ±1e6、布尔原样、其余返回 `undefined`）。已知类型的 props 循环与未知类型分支的 props 循环共用它，未知分支跳过返回 `undefined` 的值。
3. **保留位置与样式**：未知分支现在同样输出 `area` / `column` / `width` / `height` / `custom_css` / `appearance`，表达式逐行照抄已知分支（`clampColumn`、`Math.min(1600, Math.round(...))`、`Math.min(2400, Math.round(...))`、`custom_css.slice(0, 4000)`、`normalizeBlockAppearance`）；`appearance` 的计算提到分支之前复用。
4. **测试补齐**：`apps/web/src/lib/customizeBlocks.test.ts` 的 `describe('blockBudgetStatus', ...)` 增加两条：分设备布局总量（设备树 2 个 > 根级 1 个，忽略 `devices` 的实现会报 `total: 1` 而失败）与 `total`/`limit` 具体数字。

验证（在 `apps/web` 下）：

```
npx vitest run
 Test Files  47 passed (47)
      Tests  530 passed (530)
   Duration  54.58s
```

```
npm run typecheck
> @practacu/web@0.1.0 typecheck
> tsc --noEmit
```

exit 0，0 errors。530 = 原有 528 + 新增 2。

提交时只 `git add` 上述三个路径（未用 `git add -A` / `git stash` / `git checkout -- .`），报告文件本身不进入提交。
