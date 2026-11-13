# P1 fix A — 三个正确性缺陷的修复报告

- 分支：`feat/page-builder-v2-p0`
- 提交：`dc67d11` — `fix(web): close three P1 correctness gaps (columns visibility, width fold scope, split deprecation)`
- 工作目录：`D:\window\Desktop\Practacu Press`，前端 `apps/web`
- 基线：58 文件 / 648 测试全绿；本次后 59 文件 / 658 测试全绿，`npm run typecheck` 干净。

---

## DEFECT 1（must-fix，正确性）：`visible` 在 `columns` 里被绕过

### 现象与根因

三条子区块渲染路径里，`container`、`grid`、`section` 与嵌套层都吃 `BlockView` 里过滤好的
`visibleChildren`，只有 `columns` 把原始 `displayBlock` 直接交给 `ColumnsBlock`：

```tsx
// 修复前 apps/web/src/components/blocks/index.tsx
) : isColumns ? (
  <ColumnsBlock block={displayBlock} renderChild={...} />
```

而 `ColumnsBlock` 内部只做 `children.filter((child) => !child.hidden)`（`LayoutBlocks.tsx`），
完全不认识 `isVisibleAt` / `VisibilityContext`。于是「仅 members 可见」「未来日期才出现」
的区块只要落在某一栏里，访客照样看得到——条件显示在分栏里形同虚设。

### 修复

1. `apps/web/src/components/blocks/index.tsx`
   - `columns` 分支改为把已经算好的 `visibleChildren`（`!hidden && (!visibility || isVisibleAt(child, visibility))`）
     随区块一起交给 `ColumnsBlock`，与 `GridBlock` / `SectionBlock` / `container` 完全同一条路径：

     ```tsx
     <ColumnsBlock
       block={{ ...displayBlock, children: visibleChildren }}
       renderChild={(child) => <BlockView key={child.id} block={child} />}
     />
     ```

   - 谓词没有任何复制：仍然只有 `BlockView` 里那一处 `isVisibleAt` + 同一个 `visibility` context。
2. `apps/web/src/components/blocks/LayoutBlocks.tsx`
   - `ColumnsBlock` 不再自己 `filter(!child.hidden)`：子区块到达时已经按 hidden + 条件显示过滤，
     分栏只负责落位。这样「谁能看」只剩一个判定点，不会再出现两处逻辑漂移。
     函数文档同步说明这一约定。
   - 没有第二种调用方（全仓 grep `ColumnsBlock` 只有 `blocks/index.tsx`），改动不影响别处。

### 测试

`apps/web/src/components/blocks/visibilityFilter.test.ts` 新增两个真实渲染用例（沿用原文件
`createRoot` + `act` 的写法，mock 登录态）：

- `分栏列里的子区块同样服从角色条件：访客看不到 members 区块` ——
  两栏 `columns`，第 1 栏普通区块、第 2 栏 `visible: { roles: ['member'] }`；
  访客渲染结果含 `col-plain`、不含 `col-members`。修复前该断言必然失败（分栏只滤 hidden）。
- `分栏列里的 members 区块对登录会员可见` —— 同一份编排在 `role: 'member'` 下含 `col-members`，
  证明不是「一律不渲染」，而是真的按角色求值。

---

## DEFECT 2（must-fix，回归）：折叠像素宽丢掉 grid 之外的宽度

### 现象与根因

`migrateWidthsToSpan`（`apps/web/src/lib/blocks.ts`）对**每个**带 `width` 的区块都
`{ width: undefined, span: { base } }`。但 `span` 只被 `GridBlock` 消费，`BlockView` 仍然用
`width` 画外层 `<section>` 的宽度。于是 v1 站点里设过像素宽的区块在第一次读取时
（`readCustomization → normalizeScreenLayout → migrateWidthsToSpan`）宽度字段被删，
渲染变满宽——直接违反 P1 的底线「v1 配置读出来必须仍然渲染成原来的样子」。

### 修复

`apps/web/src/lib/blocks.ts` — `migrateWidthsToSpan` 增加 `inGrid` 参数并一路穿下去：

```ts
export function migrateWidthsToSpan(
  blocks: BlockInstance[],
  containerWidth: number,
  columns = 12,
  inGrid = false,
): BlockInstance[] {
  return blocks.map((block) => {
    const childInGrid = block.type === 'grid';
    const children = block.children?.length
      ? migrateWidthsToSpan(block.children, containerWidth, columns, childInGrid)
      : block.children;
    const next = children !== block.children ? { ...block, children } : block;
    if (!inGrid || typeof block.width !== 'number' || block.width <= 0 || block.span) return next;
    const { width: _dropWidth, ...rest } = next;
    return { ...rest, span: { base: widthToSpan(block.width, containerWidth, columns) } };
  });
}
```

- 只有 **grid 的直接子区块**折叠：`inGrid` 来自「本层是不是 grid」，不回头查父节点。
- `columns` / `container` / `section` 里的区块、以及 grid 里再套容器后的更深层区块都保留 `width`、不生成 `span`。
- 已有 `span` 的区块依旧不动（一次性迁移语义不变）。
- `normalizeScreenLayout` 的调用点无需改动：根层默认 `inGrid = false`，正是要的语义。

### 测试

`apps/web/src/lib/widthToSpan.test.ts` 按新语义改写并扩充（原有用例没有被削弱，只是
把「会折叠」的场景放进 grid 里）：

- `grid 里的直接子区块被换成 span 并清掉 width`（原「有 width 的区块被换成 span 并清掉 width」）
- `grid 之外的区块保留 width、不生成 span`（**新增**：顶层区块 + `container` 子区块，两者都保宽度）
- `已经有 span 的栅格子区块不动`（原用例放进 grid）
- `递归进子区块且不修改入参；grid 里面再套容器则不再折算`（保留原「不改入参」断言，并钉住深度边界）
- 读取路径三条：grid 内折算、**顶层 width 原样保留**、设备列表同样只折 grid、`at` 覆盖不被吃掉。

---

## DEFECT 3（must-fix，规格 §5.3）：`device_split` 仍在生成、且永不折叠

### 现象与根因

1. 编辑器仍在写三棵树：
   - `ThemeBuilder.tsx` 的 `toggleSplit` 一键把当前编排复制成 `desktop / tablet / mobile` 三份，
     并写入 `device_split: true`；
   - `PreviewFrame.tsx` 工具栏上的「不同设备分割」复选框（`split` / `onSplitChange` props）是这个动作的入口。
2. 读取路径只在 v1 上折叠：`migrateCustomization` 在 `schema_version >= 2` 时直接
   `return { value: doc, report: [] }`，而 P1 之前生成的这些文档版本号已经是 2。
   结果 `device_split` 永远不折，`blocks` 与 `devices` 两套模型长期并存，§5.3 的「单一模型」没有兑现。

### 修复

1. `apps/web/src/components/builder/PreviewFrame.tsx`
   - 删除 `split` / `onSplitChange` 两个 props 与整个 `builder-split-switch` 复选框；
     工具栏只留设备切换（桌面 / 平板 / 手机）。组件文档写明 §5.3 的决定。
2. `apps/web/src/pages/admin/ThemeBuilder.tsx`
   - 删除 `toggleSplit`（连同只为它存在的 `cloneBlocks` import 与 `splitDevices` 变量）与
     `<PreviewFrame split=… onSplitChange=… />` 传参。
   - **保留读取**：`persistBlocks`、`changeDevice`、文章页种子逻辑里对
     `screenLayout.device_split` 的判断原样保留——历史文档仍按三棵树编辑 / 渲染，
     只是不再有「新开分端」的入口。原地留一段注释说明「只读不写」。
3. `apps/web/src/lib/migrate.ts`
   - `migrateCustomization` 不再因版本号跳过折算：

     ```ts
     const fold = options.foldDevices === true;
     if (version >= CURRENT_SCHEMA_VERSION && !fold) return { value: doc, report: [] };
     doc.schema_version = CURRENT_SCHEMA_VERSION;
     if (!fold) return { value: doc, report: [] };
     const report: string[] = [];
     foldDocument(doc, report);
     ```

   - 也就是说：**只要 `foldDevices` 打开，就折 `device_split`，与 `schema_version` 无关**；
     没有 `device_split` 的 v2 文档折算仍是空操作（不产生报告、内容不变）。
   - `foldDeviceLayouts` / `sameShape` / `sameContent` / `foldable` 的内容与形状守卫
     **一行未改**：真正不同的设备树仍然保留并写进报告（`结构不同` / `内容不同`）。
   - `device_split` 类型与 `screenBlocksForDevice` 的 fallback 未删除：折算万一被跳过，旧文档照常渲染。

### 测试

- `apps/web/src/lib/migrate.test.ts`
  - `v2 文档里残留的 device_split 同样折算（§5.3：不再只在 v1 上折）`：
    `schema_version: 2` + 结构一致的 mobile 树 → 折进 `at.mobile.hidden`，`device_split` / `devices` 消失，报告含「手机」。
  - `v2 文档里真正不同的设备树仍然保留并报告（守卫不变）`：内容不同的 mobile 树 → `device_split: true` 保留、
    `devices.mobile` 在、base 上没有 `at`、报告含「内容」。
  - `关闭折算时 v2 文档原样返回（编辑器只读不写 device_split）`：不带 `foldDevices` 的 v2 文档逐字节不变。
  - `读取路径对 v2 文档同样折算残留的 device_split（§5.3）`：`readCustomization` 端到端。
  - 原有 v1 用例、幂等用例、纯函数用例全部保留通过。
- `apps/web/src/components/builder/PreviewFrame.test.ts`（**新增**，2 例）
  - `不再提供「不同设备分割」开关`：静态渲染后的标记里没有该文案、没有 `.builder-split-switch`、没有 checkbox。
  - `设备切换按钮仍然在`：桌面 / 平板 / 手机三个按钮还在，防止「顺手删多了」。
  - 用 `renderToStaticMarkup` 而不是挂载：不跑 effect、不加载 iframe，避免 happy-dom 的网络噪声，
    也避免测试脆弱。

---

## 验证

在 `apps/web` 下执行：

```
npx vitest run
  Test Files  59 passed (59)
       Tests  658 passed (658)
  （基线 58 / 648；新增 1 个测试文件 + 10 个用例）

npm run typecheck
  tsc --noEmit  → 无输出（exit 0）
```

定向复核：

```
npx vitest run src/lib/widthToSpan.test.ts src/lib/migrate.test.ts \
  src/components/blocks/visibilityFilter.test.ts
  → 3 files / 43 tests passed

npx vitest run src/components/builder/PreviewFrame.test.ts
  → 1 file / 2 tests passed
```

未削弱任何既有用例：`widthToSpan.test.ts` 的旧断言是随语义修正而迁移（不是删除），
`migrate.test.ts` 只增不改，`visibilityFilter.test.ts` 只增不改。

## 文件清单（本次提交的 10 个文件）

| 文件 | 变更 |
| --- | --- |
| `apps/web/src/components/blocks/index.tsx` | columns 分支传过滤后的子区块 |
| `apps/web/src/components/blocks/LayoutBlocks.tsx` | `ColumnsBlock` 不再重复过滤 hidden，文档说明 |
| `apps/web/src/lib/blocks.ts` | `migrateWidthsToSpan` 增加 `inGrid` |
| `apps/web/src/lib/migrate.ts` | 折算与版本号解耦 |
| `apps/web/src/pages/admin/ThemeBuilder.tsx` | 删除 `toggleSplit` 及入口，保留读取 |
| `apps/web/src/components/builder/PreviewFrame.tsx` | 删除分割开关与两个 props |
| `apps/web/src/components/blocks/visibilityFilter.test.ts` | +2 columns 可见性用例 |
| `apps/web/src/lib/widthToSpan.test.ts` | 按 grid 范围改写 + 新用例 |
| `apps/web/src/lib/migrate.test.ts` | +4 v2 折算/守卫用例 |
| `apps/web/src/components/builder/PreviewFrame.test.ts` | 新增，2 例 |

无 `apps/web/src/lib/customize.ts` 改动（`normalizeScreenLayout` 的调用签名无需变化）。

## 共享工作树 / 提交纪律

- 只 stage 了上述精确路径，没有 `git add -A` / `git stash` / `git checkout -- .`。
- `PreviewFrame.tsx` 含其他会话的异体 hunk（预览提示文案改写，位于文件末尾）。
  本次通过 `git diff` 摘出属于本任务的 4 个 hunk 写成补丁，`git apply --cached` 只把这几段落进索引；
  异体 hunk 仍留在工作区未提交（提交后 `git status` 里该文件仍为 `M`，diff 仅剩那段文案）。
- `ThemeBuilder.tsx` 在本次改动前与 HEAD 一致，因此整文件 stage 也只会带上本次改动。
- `styles.css` 未触碰：`.builder-split-switch` 的样式现在是死代码，属于后续清理，不在本任务允许的文件范围内。
- 同理，`PreviewFrame` 字典片段里的 `不同设备分割` / `开启后，桌面 / 平板 / 手机各用一份独立编排`
  与 `ThemeBuilder` 里的 `已开启/已关闭不同设备分割` 仍是未使用的英文条目；i18n 覆盖率闸门只检查
  「源码里用到的键必须有英文」，不检查反向，测试因此保持全绿。是否清理留待后续。
- `apps/web/README.md` 仍在描述「不同设备分割」开关（第 291 / 299 / 412 行），不在允许修改的文件清单内，未改。

## 遗留 / 后续建议

1. 清理 `styles.css` 里的 `.builder-split-switch` 规则与三处 i18n 死条目（需要放宽允许修改的文件范围）。
2. `README.md` 的编排器说明同步 §5.3 的「单一模型」措辞。
3. `migrateWidthsToSpan` 现在只在 grid 内折算，若后续引入「grid 之外也需要 span」的新容器，
   应把这个 flag 换成语义更明确的「栅格上下文」类型，而不是再叠一个布尔参数。
