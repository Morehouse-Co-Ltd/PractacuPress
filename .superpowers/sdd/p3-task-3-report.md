# P3 Task 3 报告：锚点与本页目录

- **状态**：完成（TDD 红→绿；全量测试、类型检查、i18n 闸门全绿）
- **分支**：`feat/page-builder-v2-p0`
- **提交**：`c6b7c14789a0cb4f99d3f066c486dc3556943dec`
  `feat(web): add block anchors and the table of contents block`
- **提交内容**：11 个文件，910 插入 / 1 删除（仅 P3 Task 3 的范围）

---

## 1. 交付了什么

| 能力 | 落点 |
| --- | --- |
| 锚点归一化、递归收集、去重 | `apps/web/src/lib/anchorNav.ts`（新建，纯函数，无 DOM / 无 React） |
| 锚点的编辑入口 | `apps/web/src/components/builder/BlockInspector.tsx`（「锚点」文本输入） |
| 锚点成为 DOM `id` | `apps/web/src/components/blocks/index.tsx`（`<section id>`，不包一层） |
| 整页锚点分配 | `apps/web/src/components/blocks/AnchorScope.tsx`（新建，context） |
| 本页目录区块 | `apps/web/src/components/blocks/AnchorNav.tsx`（新建，`ANCHOR_RENDERERS`） |
| 区块注册 | `apps/web/src/lib/blocks.ts`（`anchor-nav`：`heading` 一个属性） |
| 样式 | `apps/web/src/styles.css`（文件末尾新增一节，57 行） |
| 文案 | 新建 `fragments/components_blocks_AnchorNav.ts`；追加 `lib_blocks.ts`、`components_builder_BlockInspector.ts` |
| 测试 | `apps/web/src/lib/anchorNav.test.ts`（新建，35 个用例） |

`BlockInstance.anchor`（P0 建模、P1 保留、此前无人读写）现在既有写入方（检查器），
也有消费者（区块 `id` + 目录区块），并且两侧共用同一份数据。

---

## 2. 关键设计决定

### 2.1 为什么去重需要「一层 context」而不是让区块自己判断

「重复锚点只有第一个生效」是一个**跨区块**的判断：单个 `BlockView` 只知道自己，
它既不知道前面有没有人先用过这个锚点，也不知道自己排第几。若在渲染期用一个可变
`Set` 边画边占位，会与 React 的重复渲染（StrictMode / 重渲染）纠缠不清。

所以整页在 `ScreenRenderer` 里算一趟（`anchorIds` / `anchorTargets`），再用
`AnchorScopeProvider` 往下发：

- `ids`：区块 id → 锚点，`BlockView` 据此决定自己要不要画 `id`；
- `targets`：目录要列的目标（文档顺序、已去重）。

两者出自**同一趟遍历**，所以目录里列出来的每条链接一定能在页面上找到对应 `id`——
不会出现「目录里有、点过去没反应」的死链。这条不变量在测试里直接断言（逐个链接
反查 `[id]`）。

默认值（无 provider）是空的：单独渲染一个区块时不该凭空冒出 `id`，那会和真实页面上
的分配结果打架。生产上唯一入口是 `ScreenRenderer`，所以不影响真实渲染。

### 2.2 锚点的形状（`normalizeAnchor`）

顺序是刻意的：`trim` → 小写 → 空白转 `-` → 只留 `[a-z0-9-]` → 连续 `-` 并一个 →
去掉开头 `-` → 截断 40 → **再去掉结尾 `-`**。

- 先小写再滤字符（大小写转换会引入新字符）；
- 先并连字符再截断（`a---b` 不该白白吃掉长度预算）；
- 截断后补一次去尾（正好切在 `-` 上会留下 `foo-` 这种半截锚点）。

空、纯空白、纯中文、纯标点一律得到空串 → 视为「没有锚点」。`id=""` 在 HTML 里非法，
`href="#"` 会跳回页首，都比没有锚点更糟，所以**不写 `id` 属性**而不是写空串
（测试断言的是 `hasAttribute('id') === false` 与 `[id=""]` 不存在）。

### 2.3 `anchorTargets` 的标题与跳过规则

标题优先级：`props.title` → `props.heading` → 后台显示名（`block.title`）→ 锚点本身。

目录是给读者看的，读者认的是正文标题；后台显示名只在两样都没填时兜底，再没有就用
锚点凑一句，绝不留一条空链接。

`hidden` / `unsupported` 的区块**连同子树**都不进目录：它们在渲染树上根本不出现
（`ScreenRenderer` 过滤根级、`BlockView` 过滤子级），列进目录只会造死链。

**范围说明（写进报告以免被当成 bug）**：去重是**每个 `ScreenRenderer` 一份**。
`ContentDetail` 这类页面在同一个文档里挂了两个 `ScreenRenderer`（文章组件 + 页面编排），
理论上两份编排里的锚点可能撞车。当前任务不处理——跨 `ScreenRenderer` 的去重需要一个
页面级注册表，属于另一件事；测试里也明确只在单份编排内断言。

### 2.4 检查器：写入基础区块，不做设备分档

锚点**不是展示层字段**，所以写入走既有的 `patch`（`updateBlock` 落基础区块），
不进 `writeOverride` / `at`。设备上看到的永远是同一个 `id`——跳转锚点不该随屏幕尺寸改变。

输入框**保留作者原样打的字符**（中文、空格都留着），只在提示里显示归一化后的实际落点：
`链接地址：#about-us；重复的锚点只有第一个生效。`。
一开始考虑过「每敲一个字符就归一化」，实测体验很差——敲中文时输入框看起来像死掉了，
所以改成「原样存、渲染期归一化 + 实时提示」。

### 2.5 平滑滚动：复用已有规则，没写第二份

`styles.css` 里**已有** `html { scroll-behavior: smooth }`（文件开头），
并在 `@media (prefers-reduced-motion: reduce)` 里关成 `auto`（另有一处
`scroll-behavior: auto !important`）。所以本任务只加了：

- `.pp-block[id] { scroll-margin-top: 72px }`——站点头部是吸顶的（内容高 66px + 1px
  分割线），被跳过去的那一节会藏在它后面；窄屏（头部 58px）收到 64px；
- 目录自身的样式（列表、链接、焦点环、当前项）。
一句话没再写 `scroll-behavior`，测试也钉住「`html` 上只有一处 `smooth`」，
防止后来人加第二份而与 `prefers-reduced-motion` 那半脱节。

### 2.6 滚动高亮

- `IntersectionObserver`，阈值 **0.25**；`disconnect()` 在 effect 清理里；
- 目标元素用 `document.getElementById(anchor)` 查——锚点可能被条件显示（设备 / 角色 /
  时间窗）挡住，没画出来就不观察；
- 两节同时在视口里（矮屏 + 长页很常见）取 `boundingClientRect.top` 最靠上的那一节，
  读者正在读的是它；
- 高亮用 `aria-current="location"`（不是 class），CSS 再按属性选择器上色——
  语义与样式一处对应，读屏也能念出「当前所在」；
- `typeof IntersectionObserver === 'undefined'` 时直接 return：不高亮、不崩、跳转照旧。
  与 `useInView` 的既有写法一致。

### 2.7 点击 = 原生锚点

`<a href="#anchor">`，不调 `scrollIntoView`。URL 可复制、可分享，浏览器前进后退照常工作，
平滑滚动交给 CSS。测试断言链接是 `<a>`、`href` 正确且没有 `onclick`。

---

## 3. TDD 过程

1. **先写测试**（`anchorNav.test.ts`）并跑红：`Failed to resolve import "./anchorNav"`。
2. 实现 `lib/anchorNav.ts` → 31/35 通过（余下 4 条是尚未添加的 CSS）。
3. 接线（`AnchorScope` + `AnchorNav` + `index.tsx`）与注册（`blocks.ts`）、样式 → 35/35。
4. 全量 + 类型检查 + i18n 审计 → 绿。

测试覆盖四层：

- **纯函数**：归一化（大小写 / 空白 / 非法字符 / 连字符合并 / 截断 40 / 截断处连字符 /
  空与非 ASCII）、`anchorTargets`（文档顺序、父先于子、标题优先级、归一化后去重、
  跳过隐藏与不支持的子树）、`anchorIds`（重复的后来者不在表里、子区块也在表里）；
- **注册表**：`anchor-nav` 定义存在、`group: 'content'`、两个变体、`defaults ⊆ schema`、
  `normalizeBlockProps` 幂等、渲染器进了生产用的 `BLOCK_RENDERERS`、`ANCHOR_RENDERERS`
  只有这一条；
- **接线**：`id` 落在 `<section>` 本身（`tagName === 'SECTION'`）、归一化后写入、重复只有
  第一个有 `id`、非法与空锚点**没有 `id` 属性**、`[id=""]` 不存在、隐藏区块不抢锚点、
  子区块也生效、目录与 `id` 一一对应；
- **目录渲染**：`nav[aria-label="本页目录"]`、原生 `<a href>`、标题可留空、空态引导、
  重复只出现一次、阈值 0.25 与 `observe` 的元素集合、`aria-current` 落到最靠上的一节、
  卸载 `disconnect()`、无 `IntersectionObserver` 时不崩不高亮；
- **样式**：`html` 上只有一处 `scroll-behavior: smooth` 且 `prefers-reduced-motion` 下关成
  `auto`；`scroll-margin-top`；当前项用 `var(--accent)`；链接有 padding 与
  `:focus-visible` 轮廓。

> IntersectionObserver 替身：测试里注入一个记录 `observe` / `disconnect` / `options` 的
> 假实现，按 `options.threshold === 0.25` 从多个实例里挑出目录的那个（`useInView` 用的是
> `rootMargin`，不会撞车）。切到「无 IO 环境」时把全局删掉——顺带发现 `toc` 区块的默认
> 入场动画会在无 `IntersectionObserver` 时触发 `Element.animate`（happy-dom 没有），
> 测试夹具因此把动画关掉，与本任务无关。

---

## 4. 验证

```
cd apps/web
npx vitest run        → 69 files / 892 tests 全通过（含新增 35 条）
npx tsc --noEmit      → 通过，无输出
npm run i18n:audit    → 覆盖率 96.3%（历史待迁移 193 条，均为存量）
                        本次新增/改动的文件未出现在待迁移清单里（0 条）
src/lib/i18n/coverage.test.ts → 通过（t() 键都有英文、英文无 CJK、占位符形状一致）
```

基线是 68 文件 / ~840 测试；本次净增 1 个测试文件、35 条用例。工作树里另有其他会话
并行提交的测试，所以总数高于「840 + 35」，但**全绿**。

---

## 5. 提交卫生（共享工作树）

工作树里同时有别的会话的改动。`styles.css`、`lib/blocks.ts`、`BlockInspector.tsx`
都带着别人的 hunk。

- `lib/blocks.ts`、`BlockInspector.tsx`、`blocks/index.tsx`、两个既有 i18n fragment：
  逐个 `git diff -U0` 核对过 hunk 头，**只含本任务的改动**，才 `git add` 具体路径；
- `styles.css`：整文件有 416 插入 / 23 删除是别人的。做法是
  `git show HEAD:…styles.css` → 追加本任务的 57 行 → `git hash-object -w --path` →
  `git update-index --cacheinfo`，让索引里只多出这一节（提交后 `git diff --cached` 复核：
  `1 file changed, 57 insertions(+)`）；
- 全程没有 `git add -A` / `git stash` / `git checkout -- .`；
- 提交后工作树里 `styles.css` 仍是 `M`（别人的 hunk），`git diff` 里已不含本任务的行
  （`Select-String "pp-anchor-nav"` 计数为 0）。

---

## 6. 未做 / 交给后续

- **e2e**：`scripts/e2e-builder-blocks.mjs` 增加「加一个 `anchor-nav` 并断言渲染」属于
  Task 5 收口（计划 §Task 5），本任务未动。
- **设计文档 §15 记录**：同样在 Task 5。
- **脚手架配置**：`status` 里也有一个 `anchor`（`lib/migrate.ts` 的保留键清单），与本任务
  的锚点无关，未改动。
- **`customize.ts` 的锚点清洗上限仍是 120 字符**（`v2` 展示层字段那一节）。渲染期一律按
  40 字符归一化，所以存进去的长锚点不会漏到 DOM 上；但如果希望「存的就是能用的」，
  可以把它收到 40——会牵动既有的配置清洗测试，留给后续一次性处理。
- **联系表单**（Task 4）完全没有触碰。
