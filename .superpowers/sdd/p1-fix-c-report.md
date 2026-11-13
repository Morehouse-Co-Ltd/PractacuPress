# P1-Fix-C — 分设备栅格 offset 在归一化后保持存活

- **分支**: `feat/page-builder-v2-p0`
- **提交**: `f724df37d7f170487d02ba1110325d553eccc259` — `fix(web): keep per-device grid offsets through normalization`
- **状态**: 完成，测试与类型检查全绿

## 问题

`BlockDisplayOverride`（`at.tablet` / `at.mobile` 覆盖层）只声明了 `span`，而
`normalizeDisplayOverride()` 用白名单逐字段重建 `at[device]`。白名单里没有 `offset`，
所以检查器写下的分设备偏移保存在内存与预览里都正常，**下一次页面加载就静默消失**。

同时 `span` 的清洗函数 `normalizeBlockSpan()` 夹到 1–12。offset 的语义是「从第几栏开始」，
合法范围是 0–11——直接复用它会把合法的 `offset: 0` 抬成 `1`，等于按错误的列落位。

## 改动

### `apps/web/src/types.ts`
`BlockDisplayOverride` 的可选字段区新增：

```ts
/** 分设备的栅格起始列偏移；与 `span` 同形，取值 0–11。 */
offset?: BlockSpan;
```

形状与 `span` 一致（`{ base, md?, sm? }`），因为 `BlockSpan` 只是「三档数字」的载体，
offset 复用它不必新造类型。

### `apps/web/src/lib/customize.ts`
1. 新增独立边界常量 `OFFSET_MIN = 0` / `OFFSET_MAX = 11`，不动的 `SPAN_MIN/MAX` 仍是 1–12。
2. 新增 `clampOffset()`：非数字、非有限值、**非整数**一律返回 `undefined`（丢弃），
   整数夹到 0–11。整数判断用 `Number.isInteger`，一次性挡掉 `NaN` / `Infinity` / `'3'` / `3.5`。
3. 新增 `normalizeBlockOffset()`：与 `normalizeBlockSpan()` 同构——`base` 必需，
   `md` / `sm` 逐档用同一套 `clampOffset` 夹取，坏档位跳过而不是整条丢掉。
4. `normalizeDisplayOverride()` 白名单加入：

```ts
const offset = normalizeBlockOffset(record.offset);
if (offset) patch.offset = offset;
```

`span` 仍然走 `normalizeBlockSpan()`（1–12），两个字段各自用各自的边界。

### `apps/web/src/lib/customizeBlocks.test.ts`
新增 `describe('normalizeScreenLayout：分设备 offset')`，四个用例全部走公开入口
`normalizeScreenLayout`（而不是直接测内部函数），断言 `layout.blocks[0].at?.tablet`：

| 用例 | 输入 | 期望 |
| --- | --- | --- |
| 原样保留 | `{ base: 0, md: 3 }` | `{ base: 0, md: 3 }` |
| 超界夹取 | `{ base: 99 }` | `{ base: 11 }` |
| 零值不被抬高 | `{ base: 0 }` | `{ base: 0 }`（span 归一化会给出 1） |
| 坏数据丢弃 | `{ base: 'x' }` | `offset` 为 `undefined`，同一覆盖里的 `span: { base: 6 }` 仍在 |

第四个用例刻意在同一份覆盖里放一个合法的 `span`：既能证明坏 `offset` 不会让整条覆盖
被丢弃（不会误伤兄弟字段），也顺带锁住 `span` 仍走 1–12 那条老路径。

## 验证

在 `apps/web` 下：

- `npx vitest run` → **59 files / 670 tests passed**（基线 59/666，新增的正是这 4 个用例；
  0 失败、0 跳过）。耗时约 57s。
- `npm run typecheck`（`tsc --noEmit`）→ 干净，无输出。

## 提交与共享工作树

- 索引在操作前为空。用 `git diff --output=.git/p1-fix-c-offset.patch -- <三个路径>`
  导出补丁，再 `git apply --cached` 只暂存自己的 hunk，未触碰同分支上其它会话对
  `types.ts` / `customize.ts` 的改动（实际检查时这三个路径的工作树差异只含本次 hunk）。
- 提交包含 3 个文件、63 行新增，无删除；未使用 `git add -A` 或路径级 `git add`。
- 提交后 `git status --short` 对这三个路径为空，即工作树与索引一致。
- 未使用 PowerShell `Get-Content` / `Set-Content` 重写源码（读取仅用于查看，改写走
  `edit` 工具的精确替换）。

## 观察（未改，超出本次授权范围）

1. `customize.ts` 的 `blockDisplayFields()` 里，顶层 `BlockInstance.offset`
   仍然使用 `normalizeBlockSpan(raw.offset)`（第 672 行附近），同样会把顶层
   `offset: { base: 0 }` 抬成 1。它与本次修的分设备层是同一类问题，但本次任务
   明确只要求分设备覆盖层，故按范围留给后续任务。修法只需把该行换成
   `normalizeBlockOffset(raw.offset)`。
2. `apps/web/src/lib/layout.ts` 第 80–83 行的注释还在说「`offset` 还没进
   `BlockDisplayOverride`」，现在已经过时；该文件不在本次可改清单内，未动。
