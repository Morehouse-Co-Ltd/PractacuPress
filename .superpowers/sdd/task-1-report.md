# Task 1 报告：树约束收敛与下移补偿

- **分支**：`feat/page-builder-v2-p0`
- **提交**：`86146417e688ca9441f1120c4296ec8597e0c520`
  `fix(web): compensate the drop index when a block moves down inside one parent`
- **状态**：DONE_WITH_CONCERNS（实现与计划一致；但计划 Step 4 的"两个文件全绿"与既有测试的
  旧下标约定冲突，见"关注点 1"）

## 1. 改动内容

### 1.1 `apps/web/src/lib/blockTree.ts`

**(a) 新增唯一来源常量**（原第 10-11 行之后）：

```ts
export const MAX_BLOCK_DEPTH = 8;
export const MAX_BLOCKS = 200;
/** 单个容器下的直接子区块上限；与深度、总数构成本项目仅有的三条树约束。 */
export const MAX_CHILDREN_PER_CONTAINER = 80;
```

只新增导出，未改动 `MAX_BLOCK_DEPTH` / `MAX_BLOCKS` 的值。`customize.ts` 里散落的 80（子容器）
与 24（根级）**本次未动**——按计划那是 Task 2 的事，Task 2 会 `Consumes` 这个新常量。

**(b) `moveBlock` 下标补偿**（原 132-144 行）：

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

与计划逐字一致。相对原实现的两点行为变化：

1. 同父级且 `found.index < target.index` 时 `index -= 1`（W-4 修复）；
2. 下标改为**双向夹取**（原来只 `Math.min`，负数会落到 `insertBlock` 内部再夹；现在显式
   `Math.max(…, 0)`，语义更清楚，无行为差异）。

函数签名、返回值约定（无效移动返回原数组）未变。

### 1.2 `apps/web/src/lib/blockTreeMove.test.ts`（新建）

按计划 Step 1 逐字新建，4 个用例：

- 根级把 A 拖到 B 之后得到 `[B,A,C]`
- 根级向上拖动仍然正确
- 容器内向下拖动同样补偿
- 拖到自身子孙里仍然被拒绝（返回原数组引用）

### 1.3 `apps/web/src/lib/blockTree.test.ts`（**计划外改动，仅 1 个下标字面量**，见关注点 1）

`moves a block between columns and reorders siblings` 用例里 `index: 1` → `index: 2`，
并加一行注释说明落点是"放到 second 之后"的边界下标。断言的**意图与期望值完全没变**
（仍期望 `[second, first]` 且 `column === 2`），只是把落点改写成修正后的下标约定。

`git diff --cached --stat`：

```
 apps/web/src/lib/blockTree.test.ts     |  3 ++-
 apps/web/src/lib/blockTree.ts          | 13 ++++++----
 apps/web/src/lib/blockTreeMove.test.ts | 43 ++++++++++++++++++++++++++++++++++
 3 files changed, 53 insertions(+), 6 deletions(-)
```

没有其他文件被改；未新增依赖；未重排未触碰的代码。

## 2. TDD 过程与测试输出

### Step 2（红灯，实现前）

```
$ npx vitest run src/lib/blockTreeMove.test.ts
 Test Files  1 failed (1)
      Tests  2 failed | 2 passed (4)
AssertionError: expected [ 'b', 'c', 'a' ] to deeply equal [ 'b', 'a', 'c' ]
```

与计划预测的 `['b','c','a']` 完全一致；容器内向下用例同样以相同原因失败。

### Step 4（绿灯，实现后）

```
$ npx vitest run src/lib/blockTreeMove.test.ts
 ✓ src/lib/blockTreeMove.test.ts (4 tests) 13ms
 Test Files  1 passed (1)

$ npx vitest run src/lib/blockTree.test.ts
 ✓ src/lib/blockTree.test.ts (5 tests) 16ms
 Test Files  1 passed (1)
```

### 类型检查

```
$ npm run typecheck
> tsc --noEmit
（无输出，0 错误）
```

### 全量回归

```
$ npx vitest run
 Test Files  1 failed | 42 passed (43)
      Tests  1 failed | 497 passed (498)
```

唯一失败的是 **`src/lib/i18n/coverage.test.ts`**，缺英文键
`pages/admin/Storage.tsx: 决定上传的图片与附件写到哪里：…`——该文件不在本任务范围、也未被本次
改动触及（属仓库中已存在的未完成 i18n 覆盖，与 `moveBlock` 无关）。本任务的三个文件均不含
`t()` 调用。其余 42 个文件、497 个用例全绿。

## 3. 关注点

### 关注点 1（重要，已按注释处理）：既有 `blockTree.test.ts` 与计划的 Step 4 期望互相矛盾

计划 Step 4 要求 `blockTreeMove.test.ts` **和**既有 `blockTree.test.ts` 都 PASS（"证明没有回归"），
但这两者在**同一父级、`target.index === found.index + 1`** 这一个输入上期望相反，任何实现都无法同时满足：

- 既有用例：`[first, second]`，把 `first`（index 0）移到同一父级 `index: 1`，期望 `[second, first]`
  ——即把 `index` 当作"移除后数组里的下标"（旧约定）。
- 新用例：`[a, b, c]`，把 `a`（index 0）移到 `index: 2`，期望 `[b, a, c]`
  ——即把 `index` 当作"移除前的边界下标（插到某一项之后）"（新约定）。

我核对了真实调用方与审计报告，确认**新约定才是正确语义**：

- `apps/web/src/pages/admin/ThemeBuilder.tsx:245`
  `const index = targetLocation.index + (data.position === 'after' ? 1 : 0)`——
  用的是 `findBlock` 拿到的**移除前**下标（`blockTree.ts:29-43`），
  而 `insertBlock` 作用在**移除后**数组，正是 `docs/audit/web-findings.md:376-390`（BUG-1
  / 审计 W-4）描述的差一格 bug，且该审计给出的修复公式就是本次实现。
- `BlockTreeEditor.tsx:446` 的 `index: index + 1`、`:485` 的 `index: blocks.length` 也都是
  移除前边界下标，本次修复后它们才正确（此前同样差一格）。

因此我没有采用"为了让旧用例通过而换一种补偿规则"的做法（例如只在
`target.index > found.index + 1` 时补偿）——那样虽然 9 个用例全绿，但会把
"拖到下一个兄弟之前"（边界下标 `i+1`，本应是空操作）错误地变成下移一格，
即用新的 bug 换旧用例的绿。我选择把旧用例的**落点字面量**从 `1` 改成 `2`（唯一改动），
保留其"跨列 + 重排"的原意。

**如果计划作者不接受这个计划外改动**，回滚方式：`git revert` 该提交后重做，或只把
`apps/web/src/lib/blockTree.test.ts` 的 `index: 2` 改回 `1` —— 但那样该用例必然红，
且与修正后的语义不符，建议同时修订计划文本。

### 关注点 2（真实 UI 回归，未修复，超出本任务文件范围）

`apps/web/src/components/builder/BlockTreeEditor.tsx:214-227` 的 `move(id, direction)`（图层树
「上移 / 下移」按钮）传的是 `location.index + direction`：

- `↑`（`direction = -1`）：`found.index < target.index` 不成立，不补偿，行为正确。
- `↓`（`direction = +1`）：新语义下会被补偿回原位置，**点「下移」变成空操作**。

本次修复前该写法恰好是对的（旧语义下等价），修复后需要在调用方改成
`index: location.index + direction + (direction > 0 ? 1 : 0)`（或统一改成"插到某一行之后"的
边界下标）。计划的 Task 2-6 都没有覆盖 `BlockTreeEditor` 的这处调用，建议追加一个任务，
或把它并进 Task 6 的端到端验证里。我**没有**改这个文件（计划明确只允许改 Task 1 的
files 列表 + 那一个测试文件）。

其余调用方已逐个核对，修复后语义正确：
`ThemeBuilder.tsx:255`（预览拖放）、`BlockTreeEditor.tsx:293`（拖到行上=变子级，跨父级不补偿）、
`:376` / `:399`（列内投放，本身就是"追加到末尾"）、`:446`（行后投放，此前差一格）、
`:485`（拖到列表末尾）。

### 关注点 3（提示，非问题）

`MAX_CHILDREN_PER_CONTAINER` 目前**没有任何引用**（Task 2 才会消费）。`tsc --noEmit` 通过，
因为它是导出常量。若 Task 2 未按期落地，这是一个"声明了但没人用"的悬空约束。
`customize.ts` 里的 80 与 24 仍在原处，两套数字暂时并存——由 Task 2 收敛。

### 关注点 4（环境提示）

`npx vitest run` 输出中有一条既有 esbuild 警告：
`Duplicate key "立即生效，保存在本地安装配置。"`，来自
`src/lib/i18n/dict/fragments/pages_admin_Comments.ts`。与本次改动无关，未处理。

## 4. 复现命令

```powershell
cd "D:\window\Desktop\Practacu Press\apps\web"
npx vitest run src/lib/blockTreeMove.test.ts
npx vitest run src/lib/blockTree.test.ts
npm run typecheck
```

## Fix: 上下移动按钮

针对「关注点 2」的修复（提交 `3c6a6b3`，`fix(web): make the tree panel move-down button use the corrected drop index`）。

### 改动

1. `apps/web/src/lib/blockTree.ts`：在 `moveBlock` 之后新增纯函数
   `stepTarget(location, direction)`，把「上移/下移一格」翻译成*移除前边界下标*
   （`location.index + direction + (direction > 0 ? 1 : 0)`），并在父级存在时带上 `column`。
   按钮与测试共用同一处逻辑，不再各写一遍下标约定。
2. `apps/web/src/components/builder/BlockTreeEditor.tsx`：`move()` 改为
   `onChange(moveBlock(blocks, id, stepTarget(location, direction)))`；
   边界守卫保留（仍用 `location.index + direction` 判断是否越界，该值只用于守卫）。
3. `apps/web/src/lib/blockTreeMove.test.ts`：新增 `describe('stepTarget 与上下移动按钮')`，
   3 个用例（根级下移 `[b,a,c]`、根级上移 `[a,c,b]`、容器内下移 `[b,a]`），未改动原有用例。

未新增依赖；未改动其他文件；`BlockTreeEditor.tsx` 中 `groupOf` 的换行是本次修复前工作区里
已存在的未提交改动，非本次编辑（本次只动了 import 块与 `move()` 函数体）。

### TDD 与测试输出

红灯（先加测试，此时 `stepTarget` 尚不存在）：

```
$ npx vitest run src/lib/blockTreeMove.test.ts src/lib/blockTree.test.ts
 Test Files  1 failed | 1 passed (2)
      Tests  3 failed | 9 passed (12)
TypeError: (0 , stepTarget) is not a function
```

绿灯（实现后）：

```
$ npx vitest run src/lib/blockTreeMove.test.ts src/lib/blockTree.test.ts
 ? src/lib/blockTreeMove.test.ts (7 tests) 7ms
 ? src/lib/blockTree.test.ts (5 tests) 13ms
 Test Files  2 passed (2)
      Tests  12 passed (12)
```

类型检查：

```
$ npm run typecheck
> tsc --noEmit
（无输出，0 错误）
```

> 说明：首次运行 `npm run typecheck` 时曾出现 6 条错误，全部落在未触碰的
> `src/components/SlashMenu.tsx`（`placeMenu` 未使用、`position` 未定义）。稍后复跑即 0 错误，
> 该文件属于其他并行任务正在进行中的编辑，与本提交无关。本提交涉及的三个文件无任何诊断。

## Fix 2: 补跨父级与缝测试

- **提交**：`6c086163caa3d31e112019b34d997c870944b57a`
  `test(web): pin cross-parent moves and the findBlock/stepTarget seam`

只改 `apps/web/src/lib/blockTreeMove.test.ts`：`./blockTree` 导入补 `findBlock`，在
`describe('stepTarget 与上下移动按钮', ...)` 内追加 2 个用例（7 → 9 个）：

1. **跨父级不补偿** —— `[a, box[x]]`，把根级 `a` 移进 `box`、`index: 1`；断言 `box.children`
   为 `['x','a']`。若错误地在跨父级时也做 `index - 1` 补偿，`a` 会落到下标 0，得到
   `['a','x']`，该断言即失败。
2. **`findBlock` → `stepTarget` 缝** —— 先 `findBlock(blocks, 'a')` 取真实 location，
   再喂给 `stepTarget(location!, 1)`；断言结果为 `['b','a','c']`。不再手写 location 字面量，
   因此 `findBlock` 的 `index` 语义一旦变化，这个用例会立刻红。

新增断言前已核对实现：`blockTree.ts` 中 `sameParent` 门控 `found.index < target.index`
的 `-1` 补偿，跨父级时 `sameParent` 为 false，走原始下标。

测试输出：

```
$ npx vitest run src/lib/blockTreeMove.test.ts src/lib/blockTree.test.ts
 ✓ src/lib/blockTreeMove.test.ts (9 tests) 17ms
 ✓ src/lib/blockTree.test.ts (5 tests) 14ms
 Test Files  2 passed (2)
      Tests  14 passed (14)
```

```
$ npm run typecheck
> tsc --noEmit
（无输出，0 errors）
```

（注：本文件尾部原为 GBK 编码，与开头 UTF-8 混排，导致 Markdown 读取失败；本次追加时
已把全文无损转写为 UTF-8，正文文字未改动。）