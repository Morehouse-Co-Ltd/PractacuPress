# Task 4 report — PropSchema v2 与 repeater 属性

Branch: `feat/page-builder-v2-p0`
Commit: `ff5fa50` — `feat(web): add repeater property schema and migrate the button block to it`
Date: 2026-11-03

Status: **DONE_WITH_CONCERNS**（代码与测试全绿；concerns 集中在计划本身的 4 处偏差与共享工作树带来的提交范围）

---

## 1. 做了什么

`itemlist`（JSON 字符串、每条截 200 字、子字段只有 text/color/select）之后新增
`repeater`：值就是真正的数组，子字段复用 `PropSchema` 递归声明，归一化按子 schema
递归白名单。`button` 区块迁到 `repeater`，渲染器与属性面板读同一份数组。

- `types.ts`：`BlockPropRecord` / `BlockPropValue` / `BlockProps` 三个导出类型，
  `BlockInstance.props` 从 `Record<string, string | number | boolean>` 放宽成 `BlockProps`。
- `blocks.ts`：`PropType` 增加 `'repeater'`；`PropSchema` 增加 `itemSchema?` /
  `minItems?`（`itemLabel?` / `maxItems?` 原本就有）；`BlockDefinition.defaults`
  一并放宽成 `BlockProps`；`button` 的 `defaults` 改为 `{ buttons: [], align, size, new_tab }`，
  schema 改为 `type: 'repeater'` + `itemSchema: [label, link, style]`，`minItems: 1, maxItems: 4`。
- `customize.ts`：新增 `normalizeBlockProps(type, value)` / `blockPropRecord(block, key)`，
  以及内部 `normalizePropRecord` / `normalizeRepeaterValue` / `boundScalars`；
  `normalizeBlock` 里原来那段「逐个 scalarValue」的循环换成一行 `normalizeBlockProps(...)`。
- `BlockProps.tsx`：`PropControl` 增加 `repeater` 分支（增 / 删 / 改、`min`/`max` 护栏、
  `aria-label` 沿用既有的 `t('{label} 第 {index} 条 {field}')` 翻译键）；回调签名统一成
  `(key: string, value: BlockPropValue)` / `(props: BlockProps)`。
- `ActionBlocks.tsx`：`blockItems(block, 'buttons')` → `blockPropRecord(block, 'buttons')`，
  链接白名单（`safeUrl`）与 `aria-disabled` 占位逻辑未改。
- `blocksData.ts`：`boundToken` / `hasBoundProps` 参数与 `resolveBoundProps` 返回类型
  放宽到 `BlockProps`（这是放宽 `props` 后唯一真的需要改的签名）。

## 2. 验证

| 命令 | 结果 |
| --- | --- |
| `npx vitest run src/lib/repeaterProps.test.ts` | 7 passed |
| `npx vitest run src/components/builder/BlockPropsRepeater.test.ts` | 5 passed |
| `npm run typecheck` | 0 errors |
| `npx vitest run`（全量） | **50 files / 553 tests passed**（基线 48 / 541 + 本任务 12 条） |

`typecheck` 只报过一次错（`BlockPropValue` 引入但未使用，本仓库开了 `noUnusedLocals`），
删掉该 import 后即 0 错误。计划预期的 `BlockInspector.tsx` patch 签名连带错误
并没有出现：`BlockProps` 的 `onChange(props)` 本来就喂给 `patch({ props })`
（`Partial<BlockInstance>`），放宽后自然兼容。`blocks.ts` 的 `blockProp` 与
`blockItems` 也不需要改：前者的 `typeof value === typeof fallback` 守卫、后者的
`typeof raw !== 'string'` 守卫在放宽之后仍然正常收窄。

## 3. 碰过的文件（全部在本 commit 里）

| 文件 | 为什么 |
| --- | --- |
| `apps/web/src/types.ts` | 新增 `BlockPropRecord` / `BlockPropValue` / `BlockProps`；`BlockInstance.props: BlockProps` |
| `apps/web/src/lib/blocks.ts` | `PropType` + `'repeater'`；`PropSchema.itemSchema` / `minItems`；`defaults: BlockProps`；`button` 迁到 repeater |
| `apps/web/src/lib/customize.ts` | `normalizeBlockProps` / `blockPropRecord` 及内部清洗函数；`normalizeBlock` 改调新函数 |
| `apps/web/src/components/builder/BlockProps.tsx` | repeater 表单分支；回调签名放宽 |
| `apps/web/src/components/blocks/ActionBlocks.tsx` | 渲染器改读 `blockPropRecord` |
| `apps/web/src/lib/blocksData.ts` | `boundToken` / `hasBoundProps` / `resolveBoundProps` 签名放宽到 `BlockProps`（**计划外，类型连带**） |
| `apps/web/src/lib/repeaterProps.test.ts` | 计划要求的新测试（6 条）+ 1 条 `bind:` 保留回归（见 §4.3） |
| `apps/web/src/components/builder/BlockPropsRepeater.test.ts` | **计划外**：repeater 表单的真实渲染测试 5 条（增 / 删 / 改 / min / max） |

未改：`apps/web/src/components/builder/BlockInspector.tsx`（计划的 `git add` 列了它，
但本任务不需要动；它当前还带着别的 session 的未提交改动，所以没有 stage）。

## 4. 计划里错的地方 / 我做的判断

### 4.1 计划的 `normalizePropRecord` 过不了计划自己的第 4 条测试（已修）

测试写的是：

```ts
normalizeBlockProps('button', { buttons: JSON.stringify([{ label: '旧按钮', link: '/old' }]) })
  // 期望 [{ label: '旧按钮', link: '/old', style: '' }]
```

而 Step 6 给的 `normalizePropRecord` 只复制「条目里真的存在」的字段，`style` 缺失就
不会出现在结果里，`toEqual` 会失败（`toEqual` 忽略 `undefined`，但不忽略缺失后的 `''`）。
实现改为对**缺失**字段补该类型的空值：`toggle → false`，其余字符串型（text / select /
color）→ `''`，数字保持缺省（0 是有意义的数值，不替用户编）。这样也顺带保证
「读一次 → 写一次」是幂等的。

### 4.2 计划给的 `PropSchema` 替换会删掉 `bindable`

Tasks 1–3 已经给 `PropSchema` 加了 `bindable?: boolean`（`blocks.ts` 里有 5 处
`bindable: false`，`BlockProps.tsx` 靠它隐藏绑定下拉）。计划 Step 4 的替换代码块里没有
这一项，照抄会让那些 schema 立刻类型报错、并让代码类字段重新出现绑定下拉。
实现里保留了 `bindable`，同时保留了计划未提及但已存在的
`itemFields[].type = 'select'` 与 `options`。

### 4.3 计划漏掉的**功能回归**：`bind:` 键会被白名单清掉（已修 + 回归测试）

「显示什么数据」把绑定存在 `props['bind:' + key]`（`lib/blocksData.ts`），
这些键**不是任何 schema 字段**。计划要求「未在 schema 里声明的键一律丢弃」，
于是用户选一次数据源 → 保存 → 再读一次，绑定就永久消失，而且现有测试抓不到
（`blocksData.test.ts` 只测纯函数，不经过归一化）。

实现里新增 `boundScalars()`：按 `bind:` 前缀单独保留（目标键非 `__proto__` /
`constructor` / `prototype`，值仍走同一套标量清洗并截到 80 字），
并在 `repeaterProps.test.ts` 里加了一条回归（`bind:title` 保留、`bind:__proto__` 丢弃、
其它未声明键丢弃）。**这是本任务唯一一处超出计划的语义改动，请复核。**

### 4.4 文案（label）没有照抄 Step 5，是为保住 i18n

Step 5 的按钮标签会引入 4 个问题，所以保留了现有（已翻译）文案：

- `t('左')` / `t('中')` / `t('右')`：`'中'` 在英文表里已经是 **Medium**（尺寸档），
  对齐的「居中」会显示成 “Medium”。保留 `左对齐` / `居中` / `右对齐`。
- `t('在新窗口打开')`：行为其实只对**外链**生效（`ActionBlocks` 里
  `isExternalUrl(link) && newTab`），保留 `外部链接在新窗口打开` 更准确。
- `t('文字链')`：英文表里已有 `文字链接 → 'Text link'`，保留旧串。
- Step 5 的新 hint 比现有 hint 少了「留空则只显示样式、不可点击」，保留现有 hint。

结果：本任务**没有新增任何 i18n 键**，`i18n/coverage.test.ts`（每个 `t()` 字面量键必须
有英文）保持绿色。`itemSchema` 的字段标签 `文字 / 链接 / 样式` 与原有 `itemFields`
一模一样，所以面板文案零变化。

### 4.5 其它小结论

- 计划 Interfaces 段写 `BlockPropValue = string | number | boolean | BlockPropRecord | BlockPropRecord[]`，
  但 Step 3 的代码块只有 `BlockPropRecord[]`。按 Step 3 逐字实现（永远不会存单个
  record，多一个联合成员只会让类型更松）。
- `minItems: 1` 与 `disabled={items.length <= min}` 组合起来意味着**最后一行删不掉**
  （只能把文字清空）。按计划原样实现，作为 UX 小瑕疵记录；若要可删，把 `minItems`
  去掉或让删除按钮只受 `max` 约束。
- 按钮区块的默认值现在是空数组，新加的按钮区块在填内容前渲染
  `在右侧添加按钮后显示。`（既有空态文案）。`scripts/e2e-builder-blocks.mjs`
  在添加按钮区块后断言 `.pp-action-btn` 数量 > 0（约 779 / 962 行），
  这条 e2e 多半需要「先填一个按钮」的前置动作；计划 Task 6 本来就要改这个脚本。
- `createBlock` 是浅拷贝 `defaults`，所以所有新按钮区块共享同一个 `[]` 实例。
  当前所有写入路径都是不可变操作（`map` / `filter` / 展开 + 归一化会重建数组），
  因此只是潜在隐患；为了最小改动没有动 `createBlock`，将来若有渲染器原地改
  props 数组，建议在 `createBlock` 里做一次数组级防御拷贝。

## 5. 共享工作树带来的提交范围（请注意）

这个工作树里 HEAD（`07f9b40`）明显落后于工作区：`lib/blocksData.ts`、
`components/blocks/ActionBlocks.tsx` 在 HEAD 里根本不存在，`blocks.ts` 里也还没有
`article-content` 区块、`bindable` 字段与 `hasArticleContent()`（都是别的 session
未提交的改动）。按任务要求「只 stage 精确路径」，我把 8 个路径整文件 stage 了，
因此本 commit 里**必然包含同一批文件上别的 session 的未提交内容**，例如：

- `blocks.ts`：`article-content` 区块、`bindable`、`hasArticleContent`（非本任务）
- `BlockProps.tsx`：「显示什么数据」下拉（`BindPicker`，非本任务）
- `blocksData.ts`、`ActionBlocks.tsx`：整文件都是新建（内容非本任务，但本任务需要它们
  才能编译和渲染）

没有使用 `git add -A/.`、`git stash`、`git checkout -- .`。若父级需要干净的单一任务提交，
需要在这些 session 的改动各自落盘后重新整理历史（`git rebase`/拆分），我这边没有动历史。

---

## Fix: schema 与 defaults 一致性守卫

Commit: `2518693` — `test(web): guard that every block's defaults survive the props whitelist`
Files: `apps/web/src/lib/repeaterProps.test.ts`、`apps/web/src/lib/customize.ts`（仅这两个路径）

### 1. 改了什么

- `repeaterProps.test.ts`：误导性用例 `非数组的 repeater 值回退成空数组` 改名为
  `非数组的 repeater 值被丢弃`（断言本来就是 `undefined`）；新增
  `describe('schema 与 defaults 一致')` 两个守卫：
  defaults 键必须声明在 schema 里、`createBlock` 的默认 props 经过
  `normalizeBlockProps` 后必须原样保留（`JSON.stringify` 逐字相等）。`BLOCK_DEFS`
  合并进原有 `./blocks` import，没有重复 import。
- 新守卫第一次运行就抓到了真实漂移，`customize.ts` 因此做了两处最小修复。

### 2. 失败与修复（选择：扩展「保留」逻辑，不动 blocks.ts）

第一次运行 `schema 与 defaults 一致` 的第二个用例，`drifted` 里有 5 个区块：

| 区块 | 漂移 | 性质 |
| --- | --- | --- |
| `bento-hero` | 键集合相同，`welcome` / `eyebrow` / `name` / `cta` 被挪到末尾 | 键序 |
| `spotlight` | `source` 从第一位被挪到 `heading` 之后 | 键序 |
| `spotlight-hot` | 同上 | 键序 |
| `stats` | `items` 被挪到 `columns` 之后 | 键序 |
| `button` | `buttons: []` 整个键消失 | 真丢键 |

两个根因都在 `customize.ts`，都不需要改 schema：

1. **键序**：`normalizeBlockProps` 按 `def.schema` 顺序输出，而 `blocks.ts` 里这几个区块
   的 `defaults` 字面量顺序与 schema 顺序不一致。归一化只该删键、清洗值，不该搬动键位——
   否则「新建区块 → 保存 → 读回」得到的 JSON 与创建时不同。
   修复：改为按 **写入时的键顺序** 遍历 `source`（schema 命中 → 归一化；未命中 → 只试
   `bind:` 惯例键），白名单过滤与逐值清洗完全不变。顺带把 `boundScalars(source)` 拆成
   逐键的 `boundScalar(key, value)`，避免为保持顺序再遍历第二遍。
2. **空 repeater**：`normalizeRepeaterValue` 原来把空数组当成坏数据返回 `undefined`，
   于是 `button` 的默认值 `buttons: []`（`createBlock` 写进页面 JSON 的初始内容）
   在读一次后消失。修复：数组（含空数组）原样返回；只有「根本不是列表」的坏数据
   （非数组、JSON 解析失败）才返回 `undefined`。`非数组的 repeater 值被丢弃` 的断言
   （`'not-an-array'` → `undefined`）不受影响。

没有改 `blocks.ts`（它本来也不需要改：这 5 个区块的 defaults 键全部已声明在 schema 里，
第一个守卫一次通过）。没有削弱测试。

### 3. 验证输出（`apps/web`）

```
$ npx vitest run
 Test Files  50 passed (50)
      Tests  555 passed (555)
   Duration  43.78s
```

（基线 50 文件 / 553 条，本任务新增 2 条 → 555；无回归。）

```
$ npm run typecheck
> tsc --noEmit
（0 errors）
```

### 4. 备注

- `normalizeBlockProps` 的键序修复对读路径（`readCustomization` → `normalizeScreenLayout`）
  是纯形状变化：键集合与白名单语义不变，全量 555 条测试通过。
- 空 repeater 现在会被持久化成 `[]` 而不是缺键；`blockPropRecord()` 对两者都返回 `[]`，
  渲染与属性面板行为不变。
- 提交仍只 stage 了要求的两个路径，未使用 `git add -A`；工作树里其它 session 的改动未被触碰。
