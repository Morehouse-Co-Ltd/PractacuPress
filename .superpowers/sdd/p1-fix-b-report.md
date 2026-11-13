# P1 fix B — 让作者真的能在栅格里摆区块

- 分支：`feat/page-builder-v2-p0`
- 提交：`05f3a2a` — `feat(web): let authors place blocks inside the grid`
- 工作目录：`D:\window\Desktop\Practacu Press`，前端 `apps/web`
- 基线：59 文件 / 658 测试全绿；本次后 59 文件 / 666 测试全绿（`layout.test.ts` +8 例），
  `npm run typecheck` 干净，`npm run i18n:audit` 里 `BlockInspector.tsx` 仍是 0 条待迁移。

---

## 背景与交付

P1 的 `grid` 区块已经能被渲染（12 栏、`span` / `offset`、容器查询），但检查器里没有任何控件，
作者只能得到一条竖排——头号功能事实上不可达。本次把「栅格占位」接进右栏检查器。

### 1. 新分区「栅格占位」（`BlockInspector.tsx`）

- 触发条件：`findBlock(blocks, block.id)?.parent` 存在且 `parent.type === 'grid'`
  （`BlockInspector.tsx:115`，栏数来自父区块 `props.columns`，经 `gridTemplate` 夹到 1–12，
  与渲染器读的是同一处）。
- 三个控件（`BlockInspector.tsx:316-379`）：

  | 控件 | 字段 | 控件形态 | 写入 |
  | --- | --- | --- | --- |
  | 占位栏数 | `span.base` | number `min=1 max=12 step=1` | `writePlacement(v, 当前 offset)` |
  | 起始列偏移 | `offset.base` | number `min=0 max=11 step=1` | `writePlacement(当前 span, v)` |
  | 水平对齐 | `align` | select：跟随内容 / 左对齐 / 居中 / 右对齐 | `writeDisplay({ align })` |

- 全部走 Task 7 已有的写入通道（`writeDisplay` → `writeOverride`，`BlockInspector.tsx:127`）：
  桌面并回基础字段，平板 / 手机写进 `at[device]`，基础编排一动不动。

### 2. 夹取规则（新增纯函数）

```ts
/** 把 span/offset 夹到栅格能容纳的范围；冲突时先退 offset，栏数优先保住。 */
export function clampGridPlacement(
  span: number,
  offset: number,
  columns: number,
): { span: number; offset: number }
```

`apps/web/src/lib/layout.ts:50-78`。三道闸按顺序过：

1. `span` 夹进 1–12，再夹进容器栏数（`columns < span` 时收窄）；
2. `offset` 夹进 0–11；
3. `offset ≤ columns - span`——冲突时缩的是偏移，宽度原样保住。

非有限输入（空输入框的 `NaN`、手改出来的 `Infinity`）回落 `{ span: columns, offset: 0 }`；
`columns` 本身非有限时按 12 处理（与 `gridTemplate` 的回落一致）。

表单里不会出现「夹了一半」的状态：`writePlacement`（`BlockInspector.tsx:183`）一次把两个值一起
算完——栏数变大导致偏移要后退时，同一次写入里 `offset` 也跟着退，输入框不会跟实际落位对不上。

### 3. 桌面保分档、非桌面只记差异

- **桌面**：`withBase(block.span, n)` / `withBase(block.offset, n)` 只改 `base`，已有的 `md` / `sm`
  分档原样保留（直接写 `{ base }` 会把作者按断点排过的档位吃掉）。并且只有算出来的落位与
  基础层不同才写入，不会顺手给没设过 `offset` 的区块塞一条 `{ base: 0 }`。
- **平板 / 手机**：与基础层一致 → 写 `undefined`（`mergeOverride` 删键，等价「恢复继承」）；
  不一致 → 写 `{ base: n }` 进 `at[device]`。因此覆盖层里只留真正的差异。

### 4. 「已覆盖」徽标与「恢复继承」

完全复用 Task 7 的机制，没有第二条通道：

- 徽标：`overridden('span' | 'offset' | 'align')`（`BlockInspector.tsx:108`，参数类型放宽到
  `BlockPlacementPatch`），渲染成与其他展示层字段一模一样的 `<Badge tone="accent">已覆盖</Badge>`；
- 恢复继承：设备头部那个按钮（`clearDeviceOverride` → `writeOverride(block, device, {})`）
  本来就会清掉整层覆盖，`span` / `offset` / `align` 一并回到基础值；单独把某一项改回继承值，
  该字段的徽标立刻消失（非桌面写 `undefined` 就是删键）。
  这与现有 `width` / `height` / `custom_css` / 动画的体验一致——它们同样只有整层恢复按钮。

### 5. 顺带修掉的一个误导控件

栅格子区块以前会显示「所在栏」下拉（`column`）。`column` 只有 `ColumnsBlock` 会消费，`GridBlock`
完全不看它，在 grid 里它是个不起作用的控件，而且会和新加的「栅格占位」摆在一起互相打架。
现在 `parent.type === 'grid'` 时不渲染「所在栏」（`BlockInspector.tsx:286`），分栏容器里的区块与
根级区块的行为原样不变。

---

## 测试

`layout.test.ts`（无需 DOM 的纯逻辑覆盖，新增 8 例）：

- `clampGridPlacement`
  - 合法取值原样返回（`6/3/12` 等）；
  - `span` 夹进 1–12（0 → 1、-5 → 1、99 → 12）；
  - `offset` 夹进 0–11（-3 → 0、99 → 11）；
  - `offset + span > columns` 只退 offset、span 不动（`8/9/12 → 8/4`；`12/1/12 → 12/0`）；
  - `columns < span` 时 span 收窄到栏数、offset 归零（`12/3/4 → 4/0`；`6/2/1 → 1/0`）；
  - 非有限输入的回落（`NaN`、`+Infinity` → `{ span: columns, offset: 0 }`）。
- 「栅格位移按设备分层」2 例：`writeOverride` 把 `offset` 写进 `at.mobile` 而不动基础字段、
  桌面写回基础字段；`overlayAt` 叠上 `at[device].offset`，清掉覆盖后回到基础偏移。

**关于检查器接线的验证口径**：本仓库没有组件测试基础建设（`vitest` 只收 `src/**/*.test.ts`，
现有组件用例是手写 `renderToStaticMarkup` 的个别文件）。因此提交里的覆盖仍然只有
`layout.test.ts` 的纯逻辑 + 全量回归 + `npm run typecheck`。

补充说明（**未提交**，仅本次自查用的临时用例，跑完已删除）：用 `renderToStaticMarkup` 静默渲染了
三种输入，确认 ① grid 子区块出现「栅格占位」、两个数字框的值是 `6 / 0`（父 grid 6 栏、未设 span）；
② `at.tablet.span={base:4}` + `align:'center'` 时显示 `4`、两枚「已覆盖」徽标、`center` 被选中；
③ `container` 里的子区块不出现该分区。断言均通过。这些用例没有留在仓库里。

### 验证命令与结果

```
（apps/web 下）
npx vitest run
  Test Files  59 passed (59)
       Tests  666 passed (666)
  （基线 59 / 658；+8 例全部在 src/lib/layout.test.ts）

npm run typecheck
  tsc --noEmit  → 无输出（exit 0）

npm run i18n:audit
  扫描文件 167；已包裹文案 4853；待迁移文案 193；覆盖率 96.2%
  → 待迁移清单里没有 components/builder/BlockInspector.tsx（仍为 0 条）
```

未削弱任何既有用例：`layout.test.ts` 原有 21 例逐字节未改，只做新增。

---

## i18n

新增 11 条中英对照（8 个标签 + 3 条 hint），全部走 `t()`，写在
`apps/web/src/lib/i18n/dict/fragments/components_builder_BlockInspector.ts`：

`栅格占位` / `占位栏数` / `起始列偏移` / `水平对齐` / `跟随内容` / `左对齐` / `居中` / `右对齐`
+ 三条 hint（`最多 12 栏；与偏移冲突时先退偏移，栏数优先。`、`0 表示从第一栏开始；放不下时自动前移。`、
`只对这一格生效；「跟随内容」用组件自己的对齐设置。`）。

`coverage.test.ts` 的三道闸（键必有英文、英文无中日韩字符、占位符一一对应）全绿；
新 key 里没有 `{…}` 占位符，不会与英文串长度错位。

### 一处刻意的措辞偏离

任务书写的是「select 左 / 中 / 右」，实现用的是「**左对齐 / 居中 / 右对齐**」。原因不是口味：
字典是**中文原文作键**的全局表，`lib_blocks.ts` 里已经有 `中: 'Medium'`（给尺寸档位用），
而片段之间按 `Object.assign` 顺序后者覆盖前者，再写一条 `中: 'Center'` 会把全站所有「中」
（尺寸选择器等）翻成 Center。语义碰撞只能靠改键避开，取「左对齐 / 居中 / 右对齐」既无歧义也更像
对齐控件该有的文案。若确实要字面上的「左 / 中 / 右」，需要同时给尺寸档位改名，属于 i18n 全局改动。

---

## 发现的一处跨文件缺口（不在本次允许修改的文件里）

**现象**：平板 / 手机上设的 `offset`，当场生效、预览也对；但**下次读入会丢**。

**根因**：读取路径 `readCustomization → normalizeScreenLayout → normalizeBlockList → normalizeBlock
→ blockDisplayFields → normalizeBlockAt → normalizeDisplayOverride`
（`apps/web/src/lib/customize.ts:600-638`）对 `at[device]` 是**白名单**重建，只保留
`span / appearance / animation / hidden / custom_css / width / height / align / gap_scale / mt / mb`，
**没有 `offset`**。所以 `at.tablet.offset` 保存后在下次读取时被静默丢弃，落位回到基础偏移。

另外即使把键加进白名单也还不够：现成的 `normalizeBlockSpan`（`customize.ts:587`）用的是
`clampSpan`（1–12），`offset` 的合法值是 0–11，`base: 0` 会被夹成 1。

**本次为什么还是按任务书写**：`BlockDisplayOverride`（`types.ts`）本身就没有 `offset`，`offset` 的
设备覆盖从未建模过；在 `layout.ts` 里用 `BlockPlacementPatch`（`layout.ts:83`）补类型、让
`overlayAt` 认这一层（`layout.ts:113`）只是把「写入 -> 叠加 -> 渲染」这条链在内存里走通，
持久化那一环需要改 `types.ts` + `customize.ts`，**两者都不在本次允许修改的清单内**，且
`customize.test.ts` 正被其他会话改动，我不去抢这两个文件。

**建议的补齐方式**（约 8 行 + 1 个用例，需要授权）：

1. `apps/web/src/types.ts`：`BlockDisplayOverride` 加 `offset?: BlockSpan;`
   （`layout.ts` 里的 `BlockPlacementPatch` 随之可以删掉，回归成单一类型）。
2. `apps/web/src/lib/customize.ts`：新增 `normalizeBlockOffset()`（夹 0–11，不能复用 1–12 的
   `normalizeBlockSpan`），并在 `normalizeDisplayOverride` 里 `const offset = normalizeBlockOffset(record.offset);
   if (offset) patch.offset = offset;`。
3. `customizeBlocks.test.ts` 补 1 例：`at.mobile.offset` 读入后仍在（且 `base: 0` 不被抬成 1）。

**如果不想补这一环**，替代方案是把「起始列偏移」只写基础层（`patch({ offset })`），代价是
在平板上改偏移会同时改掉桌面——与检查器头部「只改这一台设备」的承诺冲突。我选择了按任务书
实现 + 在这里显式记录，因为「平板上的偏移刷新后消失」至少是可见、可复现的，而「悄悄改了另一台
设备」更难被发现。取舍留给下一轮决定。

---

## 共享工作树 / 提交纪律

- 只 `git add` 了本任务允许的 4 个精确路径，没有 `git add -A` / `git stash` / `git checkout -- .`。
- 提交前逐个 `git diff` 复核过：`BlockInspector.tsx` 与 i18n 片段当前工作区里**只有本次的 hunk**
  （其他会话在 `PreviewFrame.tsx` + `components_builder_PreviewFrame.ts` + `pages_admin_ThemeBuilder.ts`
  上的改动没有被我碰，提交后它们仍是 `M`，见 `git status`）。
- 全程用 read / edit / write 改文件，没有用 `Get-Content` / `Set-Content` 重写源码；
  四个文件仍是统一的 LF，没有混行尾。

## 文件清单

| 文件 | 变更 |
| --- | --- |
| `apps/web/src/lib/layout.ts` | 新增 `clampGridPlacement` + `BlockPlacementPatch`；`overrideOf` 返回放宽的类型；`overlayAt` 叠 `offset`；`mergeOverride` / `writeOverride` 走放宽类型 |
| `apps/web/src/components/builder/BlockInspector.tsx` | 新增「栅格占位」分区（span / offset / align）、`writePlacement`、`withBase`、`GRID_ALIGNS`；`DISPLAY_KEYS` 加 `offset`；栅格子区块不再显示「所在栏」 |
| `apps/web/src/lib/layout.test.ts` | +8 例：`clampGridPlacement` 6 例 + 栅格位移按设备分层 2 例 |
| `apps/web/src/lib/i18n/dict/fragments/components_builder_BlockInspector.ts` | +11 条中英文案 |

## 遗留

1. 上节的 `at[device].offset` 持久化缺口（需要 `types.ts` + `customize.ts` 授权）。
2. 组件级测试仍缺基础设施；这类表单接线目前只能靠临时渲染自查，建议后续把「检查器按区块类型
   分区」的几条断言固化成 `BlockInspector.test.ts`（`renderToStaticMarkup`，与 `PreviewFrame.test.ts`
   同一写法），我这次没有新增测试文件，因为任务要求覆盖只落在 `layout.test.ts`。
3. 非桌面写 `span` 覆盖时，该设备的 `md` / `sm` 分档会并成同一个 `base` 值（覆盖层是「这个设备
   一个值」的语义）。这是 P1 既有语义，不是本次引入；若以后要按档位细分，需要给
   `BlockDisplayOverride.span` 定义按档合并的规则。
