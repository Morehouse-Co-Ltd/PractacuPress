# P2 fix — 媒体选择器进入 repeater 行（完成任务报告）

- 分支：`feat/page-builder-v2-p0`
- 提交：`a883ec3` `feat(web): pick media from the library inside repeater rows`
- 状态：**完成**，全量 `vitest` 与 `tsc --noEmit` 均干净。

## 1. 问题

P2 的 `team` / `logo-wall` / `gallery` 三个区块，条目里带 `media` 子字段
（`avatar` / `image`）。`BlockProps.tsx` 的 repeater 分支把除 `select` 外的
每个子字段都渲染成普通 `<input type="text">`，作者只能手贴 `/api/v1/media/…`
地址；而顶层 `media` 属性早就有 `MediaPicker` 这套选择器，两条路径不一致。

## 2. 改动

### 2.1 抽出 `MediaField`（一份实现，两个调用点）

`apps/web/src/components/builder/BlockProps.tsx` 新增模块内组件：

```tsx
function MediaField({ id?, value, onChange, ariaLabel?, open, onOpen, onClose })
```

- 渲染 `.media-field`：`<Input>`（URL）+ `<Button variant="secondary" size="sm">`
  「从媒体库选择」。
- 选中后只写回一个纯 URL 字符串：`onPick` 直接接到 `onChange(url)`，存储形状
  （repeater 记录里的字符串字段）不变。
- 调用点 1：顶层 `media` 分支，复用 `PropControl` 原有的 `pickerOpen` 状态，
  视觉与行为不变（id / hint / htmlFor 全部保留）。
- 调用点 2：repeater 行的 `media` 子字段。

### 2.2 只有一个弹窗：状态选择

**选择：单份受控状态。** `PropControl` 里加 `const [openRow, setOpenRow] =
useState<string | null>(null)`，键是 `` `${index}:${field.key}` ``。行内的
`MediaField` 通过 `open={openRow === rowKey} / onOpen / onClose` 受控，
因此同一时刻最多只有一行的选择器是打开的——点第二行会先把第一行关掉。
（另一种做法是每行一个 `useState`，靠弹窗遮罩挡点击；这里没有采用，因为状态
集中在父级才能真正保证「exactly one」。）

### 2.3 行的结构

- 行的其余部分不变：字段标签、`删除` 按钮、`aria-label` 仍由
  `t('{label} 第 {index} 条 {field}')` 生成（含行号）。
- 唯一的结构调整：**媒体行的字段容器从 `<label>` 换成 `<div
  className="itemlist-field">`**。原因：`<label>` 只收短语内容，且行里现在多了
  一个按钮，点按钮会被 label 激活行为牵连。`aria-label` 本来就在控件上，可访问名
  不受影响；`select` / `toggle` / `text` / `color` 行仍是原来的 `<label>`，样式
  类名一致，CSS 无需改动。
- 选择器按钮的可访问名是 `"<行标签> 从媒体库选择"`（例：`条目 第 1 条 头像
  从媒体库选择`），读屏能分清是哪一行。

### 2.4 选择器改为按需挂载

`MediaField` 里 `{open ? <MediaPicker … /> : null}`。原来顶层是常挂载 +
`open={false}`。这样做有两个好处：

1. 一行可能有 20 个条目 × 每行一个媒体字段；不再为每一行常驻一个
   `MediaPicker`（它渲染时会调 `useBackend()`，没有 Provider 的环境会直接抛错）。
2. 没有打开选择器时，组件树里不该出现媒体库相关的东西。

对顶层 `media` 属性是行为等价的小优化（弹窗只在打开时存在），`Modal` 本身
`open === false` 时返回 `null`，所以外观没有任何变化。

## 3. i18n

- 没有新增文案键：`从媒体库选择` 已有英文条目
  （`apps/web/src/lib/i18n/dict/fragments/components_builder_MediaPicker.ts:
  '从媒体库选择': 'Pick from media library'`），直接复用同一个字面量键。
- `npm run i18n:audit`：覆盖率 96.3%，待迁移 193 条，**全部是既有文件**；
  `components/builder/BlockProps.tsx` 不在待迁移列表里（改动没有引入未包裹的
  中文界面文案；注释里的中文被审计脚本剥掉）。
- `src/lib/i18n/coverage.test.ts`：3 个用例全绿（每个 `t()` 字面量键都有英文、
  英文里不含中日韩字符、占位符一一对应）。

## 4. 测试

新增 `apps/web/src/components/builder/BlockPropsRepeaterMedia.test.ts`（4 个用例），
沿用仓库既有的 `react-dom/client` + `act` 真实渲染模式（无 `@testing-library/react`）。
选择器要读媒体库，所以用一个只实现 `listAssets` 的假 `Backend` 包在
`BackendProvider` 里。

1. `media 子字段渲染地址输入框 + 从媒体库选择按钮`：行里有按钮（文案 +
   含行号的 `aria-label`），输入框回显旧 URL，未点按钮时 DOM 里没有 `.modal-layer`。
2. `text 子字段仍是普通输入框…`：`姓名` 字段仍是 `input[type=text]`、容器仍是
   `LABEL`；媒体字段容器是 `DIV`；整行按钮恰好是 `['从媒体库选择', '删除']`
   ——文字字段没有被顺手加上选择器。
3. `同一时刻只开一个选择器`：点第一行 → 1 个 `.modal-layer`；再点第二行 →
   仍然只有 1 个。
4. `选中的地址只写回命中那一行，值仍是纯 URL 字符串`：假资产
   `/api/v1/media/asset-1`，第 2 行被覆盖、第 1 行原样保留，`typeof === 'string'`，
   选完弹窗自动收起。

### 验证结果（`apps/web`）

```
npx vitest run            → Test Files 67 passed (67) / Tests 833 passed (833)
npm run typecheck (tsc)   → 干净，无输出
npm run i18n:audit        → 覆盖率 96.3%，BlockProps.tsx 无待迁移项
```

基线是 66 文件 / 829 用例，本任务新增 1 个文件 / 4 个用例 → 67 / 833，
数量对得上，且没有既有用例被改动或删除。

## 5. 改动文件

- `apps/web/src/components/builder/BlockProps.tsx`
- `apps/web/src/components/builder/BlockPropsRepeaterMedia.test.ts`（新增）

未触碰 `MediaPicker.tsx`（复用其 `open` / `onClose` / `onPick` 接口）、
未触碰 `apps/web/src/lib/blocks.ts`、未改动任何存储形状与归一化逻辑。

## 6. 备注 / 风险

- 媒体行容器由 `label` 变 `div` 是可见的结构差异，但类名不变，样式与既有
  渲染测试（`.itemlist-row input[type="text"]`）都不受影响；新增用例显式钉住了
  「媒体行 DIV / 文字行 LABEL」这条约定。
- 删除行时若选择器恰好打开：弹窗遮罩会挡住删除按钮，实际不可达；`openRow`
  仍指向字符串键，即使被外部重置也会安全回落到「没有选择器打开」。
- 提交只暂存了上面两个路径，共享工作树里其它未提交改动没有被动过。
