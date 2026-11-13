# P1 Task 4 — `section` 布局原语 · 实现报告

- 分支：`feat/page-builder-v2-p0`
- 提交：`6a87844` `feat(web): add the section block`
- 测试：`apps/web` 全量 **57 文件 / 622 用例全绿**（基线 56 / 614，+1 文件 +8 用例）
- 门禁：`npm run typecheck` 干净；`npm run i18n:audit` exit 0、覆盖 96.3%（无新增待迁移文案）；`coverage.test.ts` 绿
- 超出 brief 的文件：**无**（改动恰好是 brief 列出的 5 个路径）

---

## 1. 结论摘要

`section` 分节原语落地：纯函数 `sectionLayout`（取宽 / 上下留白 / 底色 / 分隔线 + 三处回落规则）、
`SectionBlock` 渲染器（外层通栏铺底色与留白、内层限宽居中）、`blocks/index.tsx` 的派遣分支，
以及两条 CSS。

`section` 与 `container` / `grid` 一样是**子区块宿主**：派遣链里由 `section` 分支自己画
`visibleChildren`，并且 `hasNestedLayer` 的排除名单同步加上 `isSection`——否则同一批子区块会被
`pp-nested-layer` 兜底再画一遍。这条不是靠读代码保证的，见 §2 的渲染用例。

**brief 里的示例代码有两处按原样写会跑不出它自己的测试**（`full` 取宽、缺省留白档），已在 §3.1
说明处理方式；测试文件保持 brief 的断言不变。

---

## 2. TDD 过程（红 → 绿 → 加护栏）

### 2.1 先写失败测试

`apps/web/src/lib/sectionBlock.test.ts` 按 brief Step 1 逐字写入（4 条），运行：

```
 ❯ src/lib/sectionBlock.test.ts (4 tests | 4 failed)
   × 默认常规宽度、留白档 5（32px）、无底色、无分隔线 → TypeError: (0 , sectionLayout) is not a function
   × 满宽不设 maxWidth                              → TypeError: (0 , sectionLayout) is not a function
   × 坏档位回落 32px，坏颜色被丢弃                    → TypeError: (0 , sectionLayout) is not a function
   × 分隔线开关                                     → TypeError: (0 , sectionLayout) is not a function
 Test Files  1 failed (1)      Tests  4 failed (4)
```

### 2.2 实现后仍有两条红，暴露 brief 的 bug

按 brief 逐字实现后：

```
 ✓ 默认常规宽度、留白档 5（32px）、无底色、无分隔线
 × 满宽不设 maxWidth → AssertionError: expected 860 to be undefined
 ✓ 坏档位回落 32px，坏颜色被丢弃
 ✓ 分隔线开关
 Test Files  1 failed (1)      Tests  1 failed | 3 passed (4)
```

`maxWidth: SECTION_WIDTHS[width] ?? 860` 永远不可能返回 `undefined`——`full` 的合法值就是
`undefined`，被 `??` 当成「没认出这个档位」再补回 860。改成成员判断后转绿（§3.1）。

另有一处 brief 与 `SPACING_SCALE` 不一致：brief 把缺省留白写成档位 `5` 并期望 32px，
但 `[0,4,8,12,16,24,32,48,64,96]` 的第 5 档是 **24px**（32px 是第 6 档）。处理方式见 §3.1。

### 2.3 绿

```
 ✓ src/lib/sectionBlock.test.ts > sectionLayout (4)
 ✓ src/lib/sectionBlock.test.ts > 分节的渲染接线 (3)
 ✓ src/lib/sectionBlock.test.ts > 分节的样式表接线 (1)
 Test Files  1 passed (1)      Tests  8 passed (8)
```

### 2.4 全量

```
 Test Files  57 passed (57)
      Tests  622 passed (622)
```

（基线 `56 / 614` → `57 / 622`：新增 1 个测试文件、8 条用例，无既有用例改动。）

---

## 3. 改动清单

| 文件 | 内容 |
| --- | --- |
| `apps/web/src/lib/blocks.ts` | `SECTION_WIDTHS`、`SECTION_DEFAULT_PADDING_INDEX`、`sectionLayout`（+51 行） |
| `apps/web/src/components/blocks/LayoutBlocks.tsx` | `SectionBlock`（+ 导入 `sectionLayout`，+33 行） |
| `apps/web/src/components/blocks/index.tsx` | `isSection`、`hasNestedLayer` 排除、`section` 派遣分支 |
| `apps/web/src/styles.css` | `.pp-section-inner`、`.pp-section-divided`（+10 行） |
| `apps/web/src/lib/sectionBlock.test.ts` | 新增 8 条用例（4 条 brief 断言 + 4 条渲染/样式接线） |

### 3.1 `sectionLayout` 与两处对 brief 的偏离

```ts
const SECTION_WIDTHS: Record<string, number | undefined> = {
  narrow: 640,
  normal: 860,
  wide: 1200,
  full: undefined,
};

const SECTION_DEFAULT_PADDING_INDEX = 6; // 6 → 32px
```

两处偏离，都是为了让 brief 自带的断言成立：

1. **`full` 取宽**：`SECTION_WIDTHS[width] ?? 860` → `width in SECTION_WIDTHS ? SECTION_WIDTHS[width] : 860`。
   `??` 会把「满宽 = 不限宽」误判成「未知档位」补回 860，brief 的 `满宽不设 maxWidth` 用例必红。
   用成员判断后，未知档位仍然回落到常规 860（旧数据 / 手写字符串不该变成 0 宽版面）。
2. **缺省留白档**：brief 写 `padding_y` 缺省 `5`，注释与断言都要 32px，但 `spacingPx(5) === 24`。
   改成缺省档 `6`（32px），与坏值回落值 `?? 32` 同一个数——否则「有没有这个字段」会让留白从
   32px 跳到 24px。**注意副作用**：Task 3 已提交的注册表 `defaults.padding_y` 仍是 `5`（24px），
   即「面板新建的分节」= 24px、「旧数据缺字段的分节」= 32px。按 brief 的「只实现 sectionLayout /
   SectionBlock / 派遣 / CSS」范围，**没有动注册表条目**；若要统一，把 `defaults.padding_y` 改成 `6`
   即可（一处整数，无测试牵动）。
3. **测试文件的类型**：brief 的 `mk(props: Record<string, unknown>)` 过不了 `tsc`
   （`BlockProps = Record<string, BlockPropValue>`，`unknown` 不兼容）。改为
   `function mk(props: BlockProps = {})`，断言与非空值一字未改。

其余逻辑逐字保留 brief：颜色只认 `#rgb` / `#rrggbb` / `#rrggbbaa`（`trim()` 后校验，坏值丢弃 →
底色退回主题），`divider: raw.divider === true`，`paddingY` 走 `spacingPx` 且非整数/越界一律
回落（不夹到 96px 的巨缝）。

### 3.2 渲染器

`SectionBlock` 与 brief 一致：外层 `<section class="pp-section[ pp-section-divided]">` 承载
`paddingTop/Bottom`（px）与 `background`，内层 `.pp-section-inner` 只写 `maxWidth`（px 或
`undefined` 表示满宽）。取宽 / 留白 / 颜色全部来自 `sectionLayout`，组件里没有第二份规则。

### 3.3 派遣链（`blocks/index.tsx`）

- 新增 `isSection`，分支放在 `grid` 之后、通用 `Renderer` 之前；
- `hasNestedLayer` 的排除名单 `!isColumns && !isContainer && !isGrid` → 追加 `&& !isSection`；
- 传给 `SectionBlock` 的是 `visibleChildren`（已按 `hidden` / 设备 / 角色 / 时间窗过滤），
  递归仍走同一个 `BlockView`（动画、`data-pp-block`、骨架、`unsupported` 守卫都在那里）。

### 3.4 CSS

```css
.pp-section-inner { margin-inline: auto; width: 100%; }
.pp-section-divided { border-block: 1px solid var(--line); }
```

只补「满宽时也要居中」的兜底与分隔线；限宽本身是行内 `max-width`，不需要媒体/容器查询
（P1 的断点逻辑在 `grid`，`section` 的取宽是固定档位）。

### 3.5 新增的 4 条护栏用例（同文件，超出 brief 的断言）

brief 只要求 4 条纯函数断言。考虑到「子区块被画两遍」是本任务最容易犯的错（`hasNestedLayer`
兜底分支真的会把 `section` 的 children 再画一遍），补了：

- **渲染接线**（真实渲染 `ScreenRenderer`，沿用 `visibilityFilter.test.ts` 的 happy-dom 手法）：
  `[data-pp-block]` 恰好是 `['sec','kid']`、`.pp-nested-layer` 为 `null`、子区块落在
  `.pp-section > .pp-section-inner` 里；
- 限宽 / 留白 / 底色 / 分隔线真的落到 DOM：`paddingTop/Bottom = 96px`（档 9）、
  `background` 含 `#123456`、`.pp-section-divided`、内层 `maxWidth = 640px`；
- 满宽时内层不写 `max-width`；
- **样式表接线**（`styles.css?raw`）：两条选择器的属性都在，改 CSS 不改名字会当场断。

---

## 4. 验证证据

```
$ cd apps/web && npx vitest run            → Test Files 57 passed (57) / Tests 622 passed (622)
$ npx tsc --noEmit -p tsconfig.json        → exit 0
$ npm run i18n:audit                       → 覆盖率 96.3%、188 条待迁移（与基线一致，exit 0）
$ npx vitest run src/lib/i18n/coverage.test.ts → 3 passed
```

`section` 没有新增面向用户的字符串：`SectionBlock` 只有 `className` / 行内样式，
注册表里的中文早已随 Task 3 加进 `lib_blocks.ts` 英文表，所以不需要新字典条目。

---

## 5. 提交与共享工作树

只暂存本任务的 5 个路径，**没有** `git add -A` / `stash` / `checkout --`。

`styles.css` 里带着其他会话 416 行未暂存改动，本任务用「全量 diff → 只取自己那个 hunk →
`git apply --cached`」的方式暂存：

```
$ git diff -U3 -- apps/web/src/styles.css        # 537 行，多个 hunk
$ git apply --cached --check styles-mine.patch   # 只含 pp-section 那一个 hunk → exit 0
$ git commit ...
 apps/web/src/components/blocks/LayoutBlocks.tsx | 33 +++++-
 apps/web/src/components/blocks/index.tsx        | 15 ++-
 apps/web/src/lib/blocks.ts                      | 51 ++++++++++
 apps/web/src/lib/sectionBlock.test.ts           | 128 ++++++++++++++++++++++++
 apps/web/src/styles.css                         | 10 ++
 5 files changed, 234 insertions(+), 3 deletions(-)
```

提交后工作树仍保留他人的改动（`git diff --stat -- apps/web/src/styles.css` 依旧 416+/23-），
`git show HEAD:apps/web/src/styles.css` 里只有本任务的 10 行分节规则。

---

## 6. 遗留 / 建议

1. **注册表 `defaults.padding_y` 与缺省不一致**（§3.1 第 2 条）：Task 3 的注册表仍写 `5`（24px），
   而 `sectionLayout` 的缺省是 32px。建议后续把 `defaults.padding_y` 改成 `6`，让「面板新建」
   与「旧数据缺字段」渲染一致；本任务按 brief 范围未动。
2. **注册表文案 `常规（960）` 与实现不符**：`section` 的 `max_width=normal` 实际是 **860px**
   （brief、设计文档 §5.1 与测试都是 860），schema 选项文案写的是「常规（960）」。同属 Task 3
   已提交的条目，未在本任务改动，建议顺手订正文案。
3. `SectionBlock` 的外层是 `<section>`，套在 `BlockView` 的 `<section class="pp-block">` 里，
   会出现嵌套 `<section>`。HTML 合法、无语义问题，但若后续给内层加 `aria-label` 需要留意两个
   同名 label 的播报顺序。
4. 骨架模式（`BLOCK_SKELETON_SHAPES`）没有 `section` 条目，分节在加载态照常画子区块，
   与 `grid` / `container`（同样没有条目）一致，属预期。
