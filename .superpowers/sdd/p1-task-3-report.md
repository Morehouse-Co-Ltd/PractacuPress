# P1 Task 3 — `grid` 布局原语 · 实现报告

- 分支：`feat/page-builder-v2-p0`
- 提交：`349c9c7` `feat(web): add the 12-column grid block`
- 测试：`apps/web` 全量 **56 文件 / 614 用例全绿**（基线 55 / 599，+1 文件 +15 用例）
- 门禁：`npm run typecheck` 干净、`npm run build` 成功、`npm run i18n:audit` 无新增待迁移

---

## 1. 结论摘要

12 栏栅格 `grid` 原语落地：注册表条目 + 两个纯函数（栏数/间距、按断点的占位）+ 三档落位与
「offset + span ≤ 栏数」的夹取 + `GridBlock` 渲染器 + 容器查询实现的响应式三档。
`section` 只登记了注册表条目（渲染器留给 Task 4），它的 defaults 四个键全部在 schema 里声明，
所以 `repeaterProps.test.ts` 的「defaults 键都在 schema 里」「读→写幂等」两条守卫仍然绿。

响应式走**纯 CSS 容器查询**，没有为断点使用 `useViewportDevice()`：一个 JS 兜底都不需要，
理由见 §4。

---

## 2. TDD 过程（红 → 绿）

先写 `apps/web/src/lib/gridBlock.test.ts`（brief Step 1 的 9 条原样保留 + 6 条补齐响应式契约），
运行得到预期失败：

```
 ❯ src/lib/gridBlock.test.ts (13 tests | 13 failed)
   × gridTemplate > 默认 12 栏、间距档位 4  → (0 , gridTemplate) is not a function
   × spanFor > 越界一律夹住                 → (0 , spanFor) is not a function
   × 栅格断点用容器查询实现 > ...            → expected '' to match /\.pp-grid\s*\{[^}]*container-type:/
 Test Files  1 failed (1)     Tests  13 failed
```

（第一次跑还额外拿到一个真实问题：`import '../../styles.css?raw'` 路径错，应从 `src/lib/`
写到 `src/styles.css`，即 `'../styles.css?raw'`。）

实现后：

```
 ✓ src/lib/gridBlock.test.ts (15 tests) 12ms
 Test Files  1 passed (1)      Tests  15 passed (15)
```

全量：

```
 Test Files  56 passed (56)
      Tests  614 passed (614)
```

---

## 3. 改动清单

| 文件 | 内容 |
| --- | --- |
| `apps/web/src/lib/blocks.ts` | `grid` / `section` 注册表条目；`clampInt`、`gridTemplate`、`spanFor`、`gridPlacements`、`gridCellVars`、`GRID_MAX_COLUMNS` |
| `apps/web/src/components/blocks/LayoutBlocks.tsx` | `GridBlock`（单元格只写自定义属性） |
| `apps/web/src/components/blocks/index.tsx` | 派遣链加 `grid` 分支；`hasNestedLayer` 排除 `grid`（否则子区块会被画两遍） |
| `apps/web/src/styles.css` | `.pp-grid` / `.pp-grid-cell` + 两条 `@container` 规则（+44 行） |
| `apps/web/src/lib/gridBlock.test.ts` | 新增 15 条用例 |
| `apps/web/src/lib/i18n/dict/fragments/lib_blocks.ts` | 14 条英文（栅格/分节相关） |
| `apps/web/vitest.config.ts` | `css: { include: [/styles\.css/] }`，让样式表能按文本读进测试（超出 brief） |
| `apps/web/src/components/builder/BlockTreeEditor.tsx` | 栅格在组件树里算「子区块容器」+ 归到「布局」组（超出 brief） |

### 3.1 纯函数（`lib/blocks.ts`）

```ts
export const GRID_MAX_COLUMNS = 12;
const GRID_DEFAULT_GAP_INDEX = 4;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? Math.round(value) : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function gridTemplate(block: BlockInstance): { columns: number; gap: number } {
  const columns = clampInt(block.props.columns, 1, GRID_MAX_COLUMNS, GRID_MAX_COLUMNS);
  const gap = spacingPx(block.props.gap) ?? SPACING_SCALE[GRID_DEFAULT_GAP_INDEX];
  return { columns, gap };
}

export function spanFor(block, device): { span: number; offset: number } {
  const pick = (value, fallback) => {
    if (!value) return fallback;
    if (device === 'tablet' && value.md !== undefined) return value.md;
    if (device === 'mobile' && value.sm !== undefined) return value.sm;
    return value.base ?? fallback;
  };
  return {
    span: clampInt(pick(block.span, GRID_MAX_COLUMNS), 1, GRID_MAX_COLUMNS, GRID_MAX_COLUMNS),
    offset: clampInt(pick(block.offset, 0), 0, GRID_MAX_COLUMNS - 1, 0),
  };
}

export function gridPlacements(block, columns): GridPlacements {
  const cols = clampInt(columns, 1, GRID_MAX_COLUMNS, GRID_MAX_COLUMNS);
  const fit = (span, offset) => {
    const width = Math.min(cols, span);
    return { span: width, offset: Math.min(offset, cols - width) };
  };
  return { base: fit(...), md: fit(...), sm: fit(...) };  // 三档各夹一次
}

export function gridCellVars(block, columns): Record<string, string> {
  // { '--pp-span-base': '12', '--pp-offset-base': '0', ...md, ...sm }
}
```

`spanFor` 保留 brief 的语义（跨断点取值 + 夹 1–12 / 0–11，brief 的 3 条测试全过）；
**「offset + span ≤ 栏数」放在 `gridPlacements`**，因为它依赖容器栏数，而 `spanFor` 不知道栏数
（brief 自己的测试就要求 `span 12 / offset 11` 合法，所以在 `spanFor` 里合并夹取会直接撞测试）。

### 3.2 渲染器（`blocks/LayoutBlocks.tsx`）

```tsx
export function GridBlock({ block, renderChild }) {
  const { columns, gap } = gridTemplate(block);
  const children = (block.children ?? []).filter((child) => !child.hidden);
  return (
    <div className="pp-grid" data-pp-grid={columns}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap }}>
      {children.map((child) => (
        <div key={child.id} className="pp-grid-cell" data-pp-align={child.align}
          style={gridCellVars(child, columns) as CSSProperties}>
          {renderChild(child)}
        </div>
      ))}
    </div>
  );
}
```

派遣处传的是**已经过滤好的**子区块（`{ ...displayBlock, children: visibleChildren }`），
所以条件显示（设备 / 角色 / 时间窗）在栅格里和在 `container` 里是同一条规则，不会因为
换了个容器就漏掉。

---

## 4. 响应式：容器查询（brief 要求贴出的 CSS）

```css
.pp-grid {
  display: grid;
  align-items: start;
  container-type: inline-size;
  container-name: pp-grid;
}
.pp-grid-cell {
  --pp-col-start: calc(var(--pp-offset-base) + 1);
  --pp-col-span: var(--pp-span-base);
  min-width: 0;
  overflow-wrap: anywhere;
  grid-column-start: var(--pp-col-start);
  grid-column-end: span var(--pp-col-span);
}
.pp-grid-cell > .pp-block { margin: 0; }
.pp-grid-cell[data-pp-align='center'] { justify-self: center; }
.pp-grid-cell[data-pp-align='right']  { justify-self: end; }
.pp-grid-cell[data-pp-align='left']   { justify-self: start; }

@container pp-grid (max-width: 1023px) {
  .pp-grid-cell {
    --pp-col-start: calc(var(--pp-offset-md) + 1);
    --pp-col-span: var(--pp-span-md);
  }
}
@container pp-grid (max-width: 767px) {
  .pp-grid-cell {
    --pp-col-start: calc(var(--pp-offset-sm) + 1);
    --pp-col-span: var(--pp-span-sm);
  }
}
```

要点：

1. **为什么是 `@container` 而不是 `@media`**：编排器预览跑在 iframe 里（`PreviewFrame`），
   媒体查询量的是**外层窗口**的宽度——预览切到手机档时 iframe 变窄了，`@media (max-width:
   767px)` 依然不成立，看到的还是桌面排版。`container-type: inline-size` 让栅格成为查询容器，
   量自己的行内尺寸；`@container` 只看最近的容器（`container-name: pp-grid` 把它钉住，
   避免嵌套栅格时命中祖先容器）。改 iframe 宽度、拖面板、换设备档位，全部由浏览器重排。
2. **三档规则**：默认（无查询）用 `--pp-span-base` / `--pp-offset-base`；1023px 以下切到
   `md`，767px 以下切到 `sm`。阈值 = `lib/layout.ts` 的 `BREAKPOINT_LG - 1` / `BREAKPOINT_MD - 1`，
   测试直接拿这两个常量去断言 CSS 文本，CSS 和断点表不会各走各的。
3. **`span: { base: 12, md: 6, sm: 12 }` 的实际效果**：桌面整行 → 平板半行 → 手机整行。
   `gridCellVars` 写 `--pp-span-base/md/sm = 12/6/12`，CSS 按容器宽度挑档。
   md / sm 缺省时渲染器写的就是 base 的值（`spanFor` 的 pick 语义），所以不存在
   "变量没定义 → 整个 `grid-column` 失效" 的坑——不依赖 `var()` 的非法值回退。
4. **offset 的夹取在 JS 里**（`gridPlacements`）：CSS 无法在"栏数是变量"的前提下干净地算
   `min(offset, columns - span)`，而栏数已经是渲染期已知的数值，放在纯函数里既能被测试盯住，
   也让 `grid-column: 1 / span 12` 这种"顶出隐式第 13 栏"的坏值不可能出现。

**没有用 `useViewportDevice()` 做兜底**：三档全部能由 CSS 表达（档位是布尔式的区间判断，
没有需要 JS 计算的东西），容器查询在目标浏览器（Chromium 105+ / Safari 16+ / Firefox 110+）
齐备，加 JS 兜底只会引入"CSS 已经切了档、JS 又改一次"的双源问题。`device` 仍然只服务于
`ScreenRenderer` 的可见性求值，渲染器里一次都没读。

---

## 5. 与 brief 的偏离（每处都有测试兜着）

1. **`gridTemplate` 的间距档位从「夹」改成「回落」**。brief 的骨架
   `spacingPx(clampInt(gap, 0, 9, 4)) ?? 16` 与 brief 自己的测试互相矛盾：
   `gap: 99` 会被夹到 9 → 96px，而测试要求 `16`。以测试为准：档位必须是标尺上的整数下标，
   越界/非整数一律当作"没设"→ 默认档 4 → 16px。注释里写清了为什么两者规则不同
   （栏数夹取合理，间距夹到 9 会静默变成 96px 巨缝）。
2. **`gridColumnOf` 换成了 `gridPlacements` + `gridCellVars`**。brief 的 `gridColumnOf`
   只产出 base 一档、且只有一个数字，无法表达三档；改成一次算出三档自定义属性，渲染器
   不参与断点判断。
3. **`hasNestedLayer` 排除 `grid`**（`blocks/index.tsx`）。不排除的话栅格的子区块会被
   `GridBlock` 和 `pp-nested-layer` 各画一遍。
4. **`section` 只登记，不渲染**（按指令）。为了让它在组件库里位置合理，`BlockTreeEditor`
   的 `groupOf` 把 `grid` / `section` 归到「布局」组。
5. **`gap_scale` 没用上**：`BlockInstance.gap_scale` 是「作用于 grid 容器」的间距档位，
   但 brief 的 `gridTemplate` 只读 `props.gap`，测试也按 `props.gap` 断言。留给后续任务
   （它需要先定"`gap_scale` 与 `props.gap` 谁优先、要不要双写"）。

---

## 6. 超出 brief 的文件与理由

1. **`apps/web/vitest.config.ts`** — `css: { include: [/styles\.css/] }`。
   仓库既有的测试约定是"不用 Node 的 fs"（见 `i18n/coverage.test.ts` 注释），而 Vitest 默认把
   `.css` 模块替换成空串（实测 `?raw` / `?inline` / `import.meta.glob(?raw)` 全是 `''`）。
   为了让 `styles.css` 能被当文本断言（"断点真的是容器查询"这条守卫），只放行主样式表，
   其余样式表照旧被 stub 掉；全量用例耗时与基线持平（~53s），没有副作用。
2. **`apps/web/src/components/builder/BlockTreeEditor.tsx`** — 两处：
   - `childHostColumns()`：栅格在组件树里显示「子组件」投放区。不登记的话空栅格在树里是叶子
     （`cols === 0`），只能在行上"盲拖"才能塞进第一个子区块——栅格等于没有入口。
   - `handlePaletteAdd` / `groupOf`：选中栅格时点组件库即加入（与分栏一致），并把栅格归到「布局」组。
   都是各 1–3 行的改动，没有路由/状态机层面的行为变化。

---

## 7. 验收记录

```
npx vitest run        56 files / 614 tests passed      （基线 55 / 599）
npm run typecheck     clean
npm run build         built in 4.10s
                      dist/assets/index-*.css  214.50 kB (gzip 36.84 kB)
                      dist/assets/index-*.js   1263.16 kB (gzip 406.66 kB)
npm run i18n:audit    扫描 167 文件 / 已包裹 4829 / 待迁移 188 / 覆盖率 96.3%
```

- 新增体积：源码 +447 / −14（`blocks.ts` +159、`LayoutBlocks.tsx` +42、测试 +130、文案 +41、
  CSS +44、其余 +14），构建产物里 JS 增量约 1 KB 级、CSS 增量 ≈ 1 KB，远低于 brief 的「< 10 KB」。
- `i18n:audit` 的 188 条待迁移是**既有欠账**：本次新增的 14 条文案全部 `t()` 包裹并已写进
  `dict/fragments/lib_blocks.ts`，没有新增裸中文字面量；真正的闸门 `coverage.test.ts` 绿。
- `repeaterProps.test.ts` 的「defaults 键都在 schema 里」与「读→写幂等」两条守卫对新注册的
  `grid`（`columns` / `gap`）和 `section`（`max_width` / `padding_y` / `background` / `divider`）
  都是绿的——`section` 的 `background: ''` 走 `scalarValue` 保留空串，不会被归一化吃掉。

### 提交范围

`git add` 只用显式路径。注意 **`styles.css` 里本来就有 400+ 行别的在途改动**（builder 预览
留白、`theme-bundle-actions` 等，与本次无关），所以这个文件用 hunk 级暂存只提交了
`+44` 行的栅格 CSS，其余改动仍留在工作区未暂存；其余 7 个文件本次改动前后都没有他人的改动，
整文件暂存。`git diff --cached --stat` 复核：8 文件 / 447 插入 / 14 删除。

---

## 8. 给后续任务的交接

- **Task 4（`section` 渲染器）**：注册表条目已就位（`max_width` / `padding_y` / `background` /
  `divider`，`padding_y` 是 `SPACING_SCALE` 下标，用 `spacingPx()` 换算）。在 `RENDERERS`
  或派遣链里加分支即可；`section` 目前会被画成一个空的 `<section class="pp-block">`。
- **栅格的子区块在编排器里的 span/offset 编辑**：`BlockInstance.span/offset`（`BlockSpan`）与
  `gridCellVars` 已经就绪，属性面板只要写这两个字段即可；`gridPlacements` 会自动夹取。
- **嵌套栅格**：`.pp-grid` 自带 `container-name: pp-grid`，内层栅格会命中自己而不是外层；
  但 `@container` 只匹配最近容器，若将来把栅格放进 `columns`，语义不变。
- **`gap_scale` 与 `props.gap` 的优先级**尚未定义，`gridTemplate` 目前只读 `props.gap`。
