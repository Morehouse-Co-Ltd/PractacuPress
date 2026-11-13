# P2 Task 2 报告：无媒体组件三件套（功能网格 / 卡片组 / 步骤）

- **状态**：完成（TDD：先写测试并跑红，再实现，再补 CSS，最后全量）
- **分支**：`feat/page-builder-v2-p0`
- **提交**：`753db693d3dfb4cdc1dca0d8ba623a795b71306c`（`753db69`）
  `feat(web): add the feature grid, card grid and steps blocks`
- **工作目录**：`apps/web`

## 1. 验证结果

| 项目 | 基线（开工前实测） | 本任务后 |
| --- | --- | --- |
| `npx vitest run` | 62 files / 698 tests 全绿 | **63 files / 715 tests 全绿** |
| `npx tsc --noEmit` | OK | OK |
| `node scripts/i18n-audit.mjs` | 待迁移 193 / 覆盖率 96.2% | 待迁移 193 / 覆盖率 96.2%（退出码 0） |
| `src/lib/i18n/coverage.test.ts` | 绿 | 绿（随全量套件跑过） |

新增 1 个测试文件、17 条用例；`698 + 17 = 715`，没有别的文件变红。

### 先红后绿的证据链（诚实说明红的形态）

1. 先写 `src/lib/marketingBlocks.test.ts` 并运行 →
   **FAIL**：`Failed to resolve import "../components/blocks/MarketingBlocks" from "src/lib/marketingBlocks.test.ts"`。
2. 实现 `blocks.ts` 的三条定义 + `MarketingBlocks.tsx` + `index.tsx` 注册后 → **17 passed**。
3. 再补 `styles.css`（三条样式用例在那之前是红的：找不到 `@media (max-width: 767px)` 下的
   `.pp-steps.is-horizontal`、找不到 `.pp-card-grid-card:hover` 规则）。

**诚实标注**：本任务的红色是 **导入解析失败**，不是 17 条断言逐条失败。原因是渲染器走静态
import（`MARKETING_RENDERERS` 必须存在于模块里，测试才能拿到它），模块不存在时整个套件在
collect 阶段就失败，断言一条都跑不到。这与 P1 的 `sectionBlock.test.ts` 同一个形态。
另外两条「定义存在 / defaults ⊆ schema / 读→写幂等」是本仓库的**永久守卫**（`repeaterProps.test.ts`
对全量 `BLOCK_DEFS` 遍历），它们对新定义是"加错才红"，不是"没写就红"。

## 2. 实现内容

### `apps/web/src/lib/blocks.ts`

1. `BlockDefinition.group` 的联合类型增加 `'content'`（原因见 §3.1），并补一段注释说明这个字段
   只是来源批次的描述——「添加组件」面板的分组由 `BlockTreeEditor` 的 `groupOf(type)` 按 type 推导，
   `def.group` 不参与渲染。
2. 在 `RAW_BLOCK_DEFS` 末尾新增三条定义（`group: 'content'`，`variants: ['classic', 'bento']`）：

| type | name | defaults | schema |
| --- | --- | --- | --- |
| `feature-grid` | 功能网格 | `{heading:'', columns:3, items:[]}` | `heading` text；`columns` select 2/3/4；`items` repeater（`icon` text / `title` text / `text` textarea，`maxItems: 8`） |
| `card-grid` | 卡片组 | `{heading:'', columns:3, items:[]}` | `heading` text；`columns` select 2/3/4；`items` repeater（`title` text / `text` textarea / `link` text，`maxItems: 9`） |
| `steps` | 步骤 | `{heading:'', orientation:'vertical', items:[]}` | `heading` text；`orientation` select vertical/horizontal；`items` repeater（`title` text / `text` textarea，`maxItems: 8`） |

- `columns` 的选项值沿用既有 `stats` / `articles` 的写法（`String(n)` + `t('{count} 列', {count})`），
  `defaults` 里是数字 `3`（与 `stats` 一致）：数字 `3` 归一化后原样保留，选择器 `String()` 后正好对上 `'3'`。
- 三个 `heading` 都带 hint `留空隐藏标题。`（复用既有词条）。
- `steps.orientation` 的 hint 明说「横向在窄屏自动退回纵向」，与 CSS 行为对齐。
- **没有改** `lib/loading.ts`：三个区块都是静态内容，不依赖 FeedContext，不需要骨架形状。

### `apps/web/src/components/blocks/MarketingBlocks.tsx`（新建，180 行）

`MARKETING_RENDERERS: Record<string, (props: { block }) => ReactElement | null>`，三条：

- 共用外壳 `MarketingBlock`：外层 `.pp-marketing`，可选标题行 `.pp-marketing-heading`（`<h2>`），
  列数通过内联 CSS 变量 `--pp-marketing-columns` 下发给栅格（不在组件里算断点）。
- `columnsOf(block)`：`Number(block.props.columns)` 后夹到 2–4，非数字回落到 3。
  **没有用 `blockProp(block, 'columns', 3)`**：`blockProp` 是 `typeof` 严格匹配，用户在面板里改过
  一次列数后值会变成字符串 `'2'`，类型不符会回落成 3——那会让"选 2 列"静默失效。
- 条目一律 `blockPropRecord(block, 'items')`，再按 `8 / 9 / 8` 截一次（旧配置可能超编）。
- 图标：`navIconName(item.icon)`（`lib/navigation.ts` 的白名单），`undefined` 时整个图标位不渲染，
  不会出现方框或 `<svg>` 空壳。
- 链接：`safeUrl(item.link)`；`card-grid` 的卡片有链接时包成 `<a href>`，外链自动
  `target="_blank"` + `rel="noreferrer noopener"`，站内路径留在当前标签页；没链接 / 链接没过白名单
  时是静态 `<div>`，不留"可点的假象"。
- 空 `items`：渲染 `<div className="pp-media-empty">{t('在右侧添加条目。')}</div>`（复用既有空态样式）。
- `steps` 用 `<ol>/<li>` 承载顺序语义，横向时 `<ol class="pp-steps is-horizontal">`；圈里的序号
  `aria-hidden`（读屏不重复念一遍）。

### `apps/web/src/components/blocks/index.tsx`

`import { MARKETING_RENDERERS } from './MarketingBlocks';` + 在 `RENDERERS` 里最后一个展开
（与 `ACTION_RENDERERS` / `ARTICLE_RENDERERS` 同一形状）。没有改 `BlockView`，也没有为新类型加分支。

### `apps/web/src/styles.css`（+127 行，追加在文件末尾）

- `.pp-marketing` / `.pp-marketing-heading`：外壳与标题行。
- `.pp-feature-grid` / `.pp-card-grid`：`repeat(var(--pp-marketing-columns, 3), minmax(0, 1fr))`。
- 卡片 hover **只改 `border-color` + 极淡的 `background`**，没有 `transform` / 阴影位移；
  `@media (prefers-reduced-motion: reduce)` 下 `transition: none`。
- `.pp-steps.is-horizontal`：一行排开 + `::after` 拉一条 1px 连线（最后一步不长尾巴）。
- `@media (max-width: 767px)`：横向步骤退回纵向、连线隐藏（断点与 P1 断点表一致，未新造断点）。
- 颜色全部取自 `var(--ink)` / `var(--line)` / `var(--line-strong)` / `var(--bg-subtle)` /
  `var(--accent)` / `var(--muted)`，`color-mix` 只做 accent 的淡底，深浅色主题都不需要额外分支。

### i18n

- 新建 `dict/fragments/components_blocks_MarketingBlocks.ts`：`在右侧添加条目。` →
  `Add items on the right to show them here.`
- `dict/fragments/lib_blocks.ts` 追加 19 行（日期分组注释 `2026-11-03 内容型区块`）：
  `功能网格` / `卡片组` / `步骤` / `方向` / `纵向` / `横向` + 3 条 description + 3 条 hint。
  `标题` / `说明` / `链接` / `列数` / `图标` / `条目` / `{count} 列` / `留空隐藏标题。` 都是既有词条，
  按仓库约定不在新片段里重复定义。

## 3. 与 brief 的偏差与判断（4 处）

### 3.1 `group: 'content'` 需要先扩展联合类型
brief 要求 `group: 'content'`，但 `BlockDefinition.group` 在 HEAD 上只有
`'classic' | 'nightflight' | 'shared'`（`content` 是 P2 才出现的分组）。这里把 `'content'` 加进联合类型，
**不改任何既有定义，也不改任何 UI 代码**——已核对 `group` 的唯一消费方式：
`BlockTreeEditor` 的面板分组走 `groupOf(def.type)`（按 type 推导，不是读 `def.group`），
`blocksData.test.ts` 只对既有区块断言 `'shared'`。所以三个新区块会自动出现在面板的「内容」组里，
这正是 brief「加区块不需要改编辑器」的预期。

### 3.2 测试比 brief 多覆盖了渲染与 CSS
brief 要求的三条（定义存在 / defaults ⊆ schema / 渲染器在生产 `RENDERERS` 里）全部有；此外加了：
空条目引导文案、内置图标渲染 vs 未知图标静默、`javascript:` 链接不生成 `<a>`、横向/纵向的
`is-horizontal` 类、767px 媒体查询、hover 规则里没有 `transform`、减少动效下 `transition: none`。
理由：这几条是本任务里唯一会静默退化的地方（渲染器画错不会让任何其它测试变红）。

### 3.3 空 `items` 时保留标题行
`ButtonBlock` 的空态是「只剩一句提示」（它没有 `heading` 字段）。这三个区块有 `heading`：作者填了
标题却因为还没加条目而看不见，会以为是 bug。所以空态是「标题行 + 引导句」。测试只断言引导句存在，
不限制标题行是否同时出现。

### 3.4 卡片外链新窗口打开
brief 的 `card-grid` schema 没有 `new_tab` 开关。这里沿用「外链新窗口、站内留在当前页」的既有约定
（与 `button` 区块在 `new_tab` 打开时的行为一致），并带上 `rel="noreferrer noopener"`。
若后续想给作者开关，加一个 `toggle` 字段即可，渲染器里已经分好了 `external` 分支。

## 4. 触碰的文件

brief 内（5）：
- `apps/web/src/lib/blocks.ts`
- `apps/web/src/components/blocks/MarketingBlocks.tsx`（新建）
- `apps/web/src/components/blocks/index.tsx`
- `apps/web/src/styles.css`
- `apps/web/src/lib/marketingBlocks.test.ts`（新建）

brief 外（2，均为 i18n 硬闸门所必需）：
- `apps/web/src/lib/i18n/dict/fragments/components_blocks_MarketingBlocks.ts`（新建）
- `apps/web/src/lib/i18n/dict/fragments/lib_blocks.ts`（追加 19 行）

### 共享工作树的处理（`styles.css` 其它会话的改动没有被带上）

开工时 `apps/web/src/styles.css` 已经带着**别人未提交的 416 增 / 23 删**（builder 全屏预览、
stat-grid、两个 `@import` 等）。直接 `git add` 会把它们一起提交。本任务的做法：

1. 只在文件**末尾**追加自己的一段（127 行，以 `营销区块（功能网格 / 卡片组 / 步骤` 注释开头）；
2. 用一次性 Node 脚本（放在系统临时目录，不在仓库里）拼出「HEAD 的 styles.css + 本任务那一段」，
   `git hash-object -w --path apps/web/src/styles.css` 写进对象库（`--path` 让 clean filter 照常
   规范行尾：工作树是 CRLF、HEAD blob 是 LF），再 `git update-index --cacheinfo` 把这条 blob
   挂上索引；
3. 提交后核对：`git diff --cached` 为空、`git diff --stat apps/web/src/styles.css` 仍是
   **416 增 / 23 删**（别人的改动原样留在工作树里，仍是未提交状态）。

`lib/blocks.ts` 与 `dict/fragments/lib_blocks.ts` 在开工时是干净的（`git status` 无输出），所以这两处
是普通 `git add`；其余路径一律逐个 `git add <path>`。全程没有 `git add -A` / `git stash` /
`git checkout -- .`，也没有用 `Get-Content`/`Set-Content` 改写任何源码（读写走 read/edit/write）。

## 5. 留给后续任务的

- Task 3 / Task 4 可以直接复用 `MarketingBlocks.tsx` 的 `MarketingBlock` 外壳与 `columnsOf` /
  `textOf` 取值习惯（媒体类区块只是把文字换成 `<img>`）。
- `feature-grid` 的 `icon` 目前是自由文本 + 白名单静默丢弃；若产品上希望"只能选"，把字段换成
  `select`（`NAV_ICON_CHOICES` 已经是 `{name,label}` 列表）即可，渲染器不用改。
- 三个区块都是静态内容，**不要**给它们登记 `lib/loading.ts` 的骨架形状；骨架只属于依赖
  `FeedContext` 的区块。
- 横向步骤的连线用 `::after` + `calc(-50% + 22px)`，依赖"每步等宽"（`flex: 1 1 0`）；若以后允许
  某一步更宽，连线要改成 grid 列线或 flex 间隙方案。
