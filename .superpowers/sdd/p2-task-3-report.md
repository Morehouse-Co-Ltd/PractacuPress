# P2 Task 3 报告：媒体组件三件套（团队 / Logo 墙 / 图集）

- **状态**：完成（TDD：先写测试跑红 → 实现 → 补 CSS → 补 i18n → 全量）
- **分支**：`feat/page-builder-v2-p0`
- **提交**：`f5a92ef81df8f859e517cf190197c80ad34e4299`（`f5a92ef`）
  `feat(web): add the team, logo wall and gallery blocks`
- **工作目录**：`apps/web`

## 1. 验证结果

| 项目 | 基线（开工前实测） | 本任务后 |
| --- | --- | --- |
| `npx vitest run` | 63 files / 715 tests 全绿 | **64 files / 748 tests 全绿** |
| `npx tsc --noEmit` | OK | OK |
| `node scripts/i18n-audit.mjs` | 待迁移 193 / 覆盖率 96.2% | 待迁移 193 / 覆盖率 96.2%（已包裹 4947，退出码 0） |
| `src/lib/i18n/coverage.test.ts` | 绿 | 绿（随全量套件跑过） |

新增 1 个测试文件、33 条用例；`715 + 33 = 748`，没有别的文件变红。

### 先红后绿的证据链（诚实说明红的形态）

1. 先写 `src/lib/mediaGalleryBlocks.test.ts` 并运行 →
   **FAIL**：`Failed to resolve import "../components/blocks/MediaGalleryBlocks"`。
   与 Task 2 同一形态：渲染器是静态 import（`MEDIA_GALLERY_RENDERERS` 必须存在于模块里），
   模块不存在时整套在 collect 阶段失败，33 条断言一条都跑不到。
2. 实现 `blocks.ts` 三条定义 + `MediaGalleryBlocks.tsx` + `index.tsx` 注册 + CSS 后 → **33 passed**。
3. **额外做了一次变异验证**（避免"一写就绿"的假绿）：把 `settle()` 里的
   `thumbsRef.current[restoreRef.current]?.focus()` 注释掉 → 灯箱的两条焦点用例当场变红
   （`2 failed`），恢复后复绿。说明「Esc / 关闭按钮后焦点回到被点的缩略图」这两条断言真的在断言。
4. CSS 三条用例（正圆头像、`grayscale(1)` + hover 恢复彩色、`prefers-reduced-motion` 无过渡）
   在写 `styles.css` 之前是红的：规则不存在时 `exec()` 返回 `null`。

## 2. 实现内容

### `apps/web/src/lib/blocks.ts`（+107 行，追加在 `RAW_BLOCK_DEFS` 末尾）

| type | name | defaults | schema |
| --- | --- | --- | --- |
| `team` | 团队成员 | `{heading:'', columns:3, items:[]}` | `heading` text；`columns` select 2/3/4；`items` repeater（`avatar` **media** / `name` text / `role` text / `link` text，`maxItems: 12`） |
| `logo-wall` | Logo 墙 | `{heading:'', columns:4, items:[]}` | `heading` text；`columns` select 2/3/4/5/6；`items` repeater（`image` **media** / `link` text / `alt` text，`maxItems: 12`） |
| `gallery` | 图集 | `{heading:'', columns:3, ratio:'4:3', items:[]}` | `heading` text；`columns` select 2/3/4；`ratio` select `1:1` / `4:3` / `16:9`；`items` repeater（`image` **media** / `caption` text，`maxItems: 20`） |

- 三条都是 `group: 'content'`、`variants: ['classic', 'bento']`（与 Task 2 一致）。
- `columns` 的写法沿用 Task 2 / `stats`：选项值 `String(n)`、标签 `t('{count} 列', {count})`，
  `defaults` 里是数字（数字 `3` 归一化后原样保留，选择器 `String()` 后正好对上 `'3'`）。
- `defaults` 的键顺序与 `schema` 的键顺序一致（`heading → columns → [ratio] → items`），
  所以 `normalizeBlockProps(type, createBlock(type).props)` 与原值**逐键相等**（读写幂等，测试有钉）。
- 三个 `heading` 复用既有 hint `留空隐藏标题。`；`items` 的 hint 各自说明上限与 media 缺省行为。

### `apps/web/src/components/blocks/MediaGalleryBlocks.tsx`（新建，364 行）

`MEDIA_GALLERY_RENDERERS: Record<string, (props: { block }) => ReactElement | null>`，三条；
另外导出纯函数 `lightboxStep`。

- **共用外壳** `MediaBlock`：`.pp-mediablock` + 可选 `.pp-mediablock-heading`（`<h2>`）。
  列数**不在组件里算断点**，而是作为 CSS 变量 `--pp-media-columns` 内联到各自的栅格上。
- `columnsOf(block, fallback, min, max)`：`Number(block.props.columns)` 后取整并夹到 `[min, max]`，
  非数字回落到该区块的默认列数（团队 3 / Logo 4 夹 2–6 / 图集 3）。
  没有用 `blockProp(block,'columns',3)`——它是 `typeof` 严格匹配，面板把值写成字符串 `'2'` 后
  会静默回落成 3（Task 2 已经踩过这个坑，这里沿用同样的写法）。
- 条目一律 `blockPropRecord(block,'items')`，再按 `12 / 12 / 20` 截一次（旧配置可能超编）。
- 图片一律 `safeUrl()`（`lib/safeUrl.ts`）后才进 `src`；`javascript:`、`//host`、相对路径都到不了 `<img>`。
- 链接一律 `safeUrl()`；外链 `target="_blank"` + `rel="noreferrer noopener"`，站内路径留在当前标签页。
- 空 `items`：`<div className="pp-media-empty">{t('在右侧添加条目。')}</div>`（复用既有空态样式与既有词条）。

#### `team`

- 头像 `border-radius: 50%`（CSS `.pp-team-avatar`），`img` 用 `object-fit: cover`。
- **缺图 / 图没过白名单**：渲染 `.pp-team-initial`（姓名首字母，`Array.from(name)[0]` 取码点、
  拉丁字母 `toUpperCase()`，主题色底 + 主题笔色），**不渲染 `<img>`**，所以永远不会出现破图图标。
- 头像 `alt=""`：姓名就在头像下面，重复念一遍是噪音（装饰图的正确写法是空 alt，不是省掉属性）。
- 姓名 / 头衔是文本节点，不进 `dangerouslySetInnerHTML`。

#### `logo-wall`

- `filter: grayscale(1)` + `opacity: .7`，`li:hover` 与 `a:hover` / `a:focus-visible` 恢复彩色
  （键盘用户也能看到彩色，不只是鼠标）。
- `alt` 取条目里的 `alt`，缺省是空串（装饰 Logo）——**属性一定存在**，不会出现"漏写 alt"。
- 没有可用图片的条目直接跳过：Logo 墙里留一格空白比少一个 Logo 更刺眼。

#### `gallery` + 原生 `<dialog>` 灯箱

- 缩略图是 `<button type="button">`（原生可聚焦、可 Enter/Space 触发），里面是 `<img>`，
  `alt` 取 `caption`（同一句话也显示在大图下方 —— 宁可重复一次，也不要让读屏念文件名）。
- 比例：`4:3` → CSS 变量 `--pp-gallery-ratio: 4 / 3`（`aspect-ratio` 的写法），
  同时把原始值写进 `data-ratio`；渲染侧再用 `['1:1','4:3','16:9']` 白名单兜一次（坏数据回落 4:3）。
- 灯箱用原生 `<dialog>` + `showModal()`：Esc、焦点陷阱、`::backdrop`、`aria-modal` 都是浏览器给的，
  **没有新增依赖**。
- 状态机：`index: number | null` 是唯一真相，`dialog.open` 跟着它走（一个 effect 负责
  `showModal()` / `close()`）；越界下标（作者在灯箱开着时删条目）一律当作已关闭，不留空白大图。
- 关闭收尾统一在一个 `close` / `cancel` 监听里：`setIndex(null)` + `thumbsRef.current[restoreRef.current]?.focus()`
  —— 焦点回到**被点的那一张**，不是第一张。
- Esc 有两条路径都覆盖：浏览器原生发 `cancel`（我们不 `preventDefault`，让它自己关），
  以及 `onKeyDown` 里显式 `close()`（`happy-dom` 不会自动关，测试要能跑真实路径）。
- 左右切换：`‹` / `›` 按钮 + `ArrowLeft` / `ArrowRight`；只有一张时不渲染这两个按钮
  （不是 disabled，是不存在——没有可去的地方）。

#### `lightboxStep(current, delta, total)`（纯函数，同模块导出）

```
count = Number.isFinite(total) ? trunc(total) : 0;  count <= 1 → 0
from  = Number.isFinite(current) ? trunc(current) : 0
step  = Number.isFinite(delta) ? trunc(delta) : 0
return (((from + step) % count) + count) % count
```

| 场景 | 结果 |
| --- | --- |
| `(0, ±1, 0)` / `(0, 7, 1)` | `0`（空集与单张不越界） |
| `(2, 1, 3)` | `0`（最后一张的下一张是第一张） |
| `(0, -1, 3)` | `2`（第一张的上一张是最后一张） |
| `(0, -4, 3)` / `(1, 7, 3)` | `2` / `2`（一步跨多张也不跳号） |
| `(5, 0, 3)` / `(-1, 0, 3)` | `2` / `2`（越界下标收敛） |
| `(NaN, 1, 3)` / `(0, 1, -3)` | `1` / `0`（坏输入收敛） |

### `apps/web/src/components/blocks/index.tsx`（+2 行）

`import { MEDIA_GALLERY_RENDERERS } from './MediaGalleryBlocks';` + 在 `RENDERERS` 里最后一个展开。
没有改 `BlockView`，也没有为新类型加分支。

### `apps/web/src/styles.css`（+188 行，追加在文件末尾）

段首注释 `媒体区块（团队 / Logo 墙 / 图集，2026-11-03 P2）`，与 Task 2 的营销区块同一格式。

- `.pp-mediablock` / `.pp-mediablock-heading`：外壳与标题行。
- `.pp-team` / `.pp-logo-wall` / `.pp-gallery-grid`：
  `grid-template-columns: repeat(var(--pp-media-columns, N), minmax(0, 1fr))`（N = 3 / 4 / 3）。
- `.pp-team-avatar`：`border-radius: 50%` + `overflow: hidden` + 主题色淡底（`color-mix`）。
- `.pp-logo-wall img`：`filter: grayscale(1)`、`transition: filter/opacity 160ms`；
  `li:hover img` / `a:hover img` / `a:focus-visible img` → `grayscale(0)`。
- `.pp-gallery-thumb`：`aspect-ratio: var(--pp-gallery-ratio, 4 / 3)` + `cursor: zoom-in`，
  hover 只改 `border-color`。
- `.pp-gallery-dialog`：`max-width: min(960px, 92vw)`、`max-height: 92vh`、`::backdrop` 压暗 72%。
- `@media (max-width: 767px)`：三个栅格都收到 2 列（沿用 P1 断点表，未新造断点）。
- `@media (prefers-reduced-motion: reduce)`：`.pp-logo-wall img` 与 `.pp-gallery-thumb` 的过渡去掉。
- 颜色全部走 `var(--ink)` / `var(--muted)` / `var(--line)` / `var(--bg)` / `var(--bg-subtle)` /
  `var(--accent)` / `var(--r-sm|md|lg)` / `var(--serif)`，深浅色主题不需要额外分支。

### i18n

- 新建 `dict/fragments/components_blocks_MediaGalleryBlocks.ts`（11 行）：
  `大图预览` / `查看大图` / `查看大图：{caption}` / `第 {count} 张 / 共 {total} 张` 四条。
- `dict/fragments/lib_blocks.ts` 追加 25 行（日期分组注释 `2026-11-03 媒体型区块（团队 / Logo 墙 / 图集）`）：
  `团队成员` / `Logo 墙` / `姓名` / `头衔` / `Logo` / `1:1 方形` / `4:3 横向` / `16:9 宽幅` +
  3 条 description + 5 条 hint（共 16 个词条、25 行）。
- 复用既有词条（按仓库约定不重复定义）：`标题` / `列数` / `条目` / `说明` / `链接` / `图片` /
  `头像` / `成员` / `图集` / `比例` / `替代文字` / `{count} 列` / `留空隐藏标题。` / `上一张` /
  `下一张` / `关闭预览` / `在右侧添加条目。`。
- 覆盖闸门实测：`blocks.ts` 待迁移 36 条与 HEAD **完全相同**（写了个一次性脚本对比 HEAD blob 与工作区，
  `new pending entries: 0`）；`MediaGalleryBlocks.tsx` 待迁移 `0` / 已包裹 `8`。

## 3. 与 brief 的偏差与判断（6 处）

### 3.1 `logo-wall.columns` 给了 2–6，brief 只固定默认值 4
brief 的表格只规定 `defaults.columns = 4`，没说选项。4 列的 Logo 墙在窄内容区偏宽，
所以选项给 2/3/4/5/6（`defaults` 仍是 4），渲染侧夹在 2–6。测试钉的是默认值与"归一化幂等"，
不锁选项全集，将来加 7 列不用改测试。

### 3.2 `team` 头像 `alt=""`（而不是姓名）
brief 的总则是"所有 `<img>` 必须有 `alt`，缺省空串表示装饰图"。团队成员的头像是装饰图：
姓名 / 头衔已经在同一张卡里以文本呈现，alt 再写一遍姓名会让读屏把每个人念两遍。
所以 `alt=""` **属性存在且为空**（测试断言 `hasAttribute('alt')` 且值为 `''`），符合 WCAG 的装饰图写法。

### 3.3 `gallery` 的 `alt` 用 `caption`
图集条目里唯一的文字就是 `caption`，brief 要求"所有 img 必须有 alt"。同一句话既做 `figcaption`
（大图下方）也做 `alt`，有轻微重复，但比留空更可用（留空等于把图片从读屏里删掉）。

### 3.4 内联 `data:image/…;base64,` 的演示图会被 `safeUrl` 挡掉（**已知行为，不是遗漏**）
按父任务要求，图片一律过 `safeUrl()`（与 `MediaBlocks.tsx` 完全同一条路径），而 `safeUrl` 只放行
`http(s)` 与 `/` 开头的站内路径，不放行 `data:`。保存链路（`normalizeMediaUrl`）确实允许
≤64 KB 的 `data:image/*;base64`，但**同一份 props 还有 8 KB 的 `PROPS_MAX_BYTES` 预算**
（`capPropBytes` 超预算会整条丢键），所以一张 64 KB 的内联图在任何区块里都存不下来。
本任务因此**没有**引入第二个白名单：团队头像回落成姓名首字母、Logo 墙与图集跳过该张图，
都是可读降级，不会出现破图图标。若产品上真要支持内联演示图，应先在 `safeUrl` 层统一决策
（那会同时改变 `image` / `slideshow` 等既有区块的行为），不适合在 Task 3 里单方面放宽。

### 3.5 Esc 与焦点回填做了两条路径
brief 要求"`Esc` 关闭，`dialog.close()` 后 `.focus()`"。浏览器里 Esc 由 UA 发 `cancel` 并自行关闭，
我们只监听 `close` / `cancel` 收尾；但测试环境（`happy-dom`）既不会自己关、也不会发 `close`
（实测：`cancel` 事件不关闭 dialog、Esc 按键不关闭），所以 `onKeyDown` 里另有一条显式 `close()`。
两条路径都收敛到同一个收尾函数，状态与焦点不会分叉。

### 3.6 图片统一 `loading="lazy"`，没有接 `lazy_media` 设置
`MediaBlocks.tsx` 通过 `useAuth()` + `readPerformance(config)` 读 `lazy_media`。这三个区块是内容型
栅格，图片几乎总在首屏之外；为了不把 `session` 依赖引入渲染器（也不再多一个 mock），统一用
`loading="lazy"` + `decoding="async"`。若产品希望这个开关也管内容型区块，改成
`useLazyMedia()` 只是一行替换。

## 4. 触碰的文件

brief 内（5）：
- `apps/web/src/lib/blocks.ts`（+107）
- `apps/web/src/components/blocks/MediaGalleryBlocks.tsx`（新建，364）
- `apps/web/src/components/blocks/index.tsx`（+2）
- `apps/web/src/styles.css`（+188，追加在末尾）
- `apps/web/src/lib/mediaGalleryBlocks.test.ts`（新建，426）

brief 外（2，均为 i18n 硬闸门 / 新文件所必需）：
- `apps/web/src/lib/i18n/dict/fragments/components_blocks_MediaGalleryBlocks.ts`（新建，11）
- `apps/web/src/lib/i18n/dict/fragments/lib_blocks.ts`（+25）

**没有**改 `components/builder/BlockProps.tsx`、`lib/customize.ts`、`lib/safeUrl.ts`、`lib/loading.ts`。

### 共享工作树的处理（`styles.css` 其它会话的改动没有被带上）

开工时 `apps/web/src/styles.css` 已带着**别人未提交的 416 增 / 23 删**（builder 全屏预览、
骨架加载、stat-grid 等，含两个 `@import`）。直接 `git add` 会连它们一起提交。本任务的做法与 Task 2 相同：

1. 我的 CSS 段单独写成一个文件（`.superpowers/sdd/task3-styles-section.css`，LF），
   再用一次性 Node 脚本把它按 **CRLF** 追加到工作区 `styles.css` 末尾（工作树是 CRLF）；
2. 同一脚本拼出「`git show HEAD:apps/web/src/styles.css` + 我这一段」（LF），
   `git hash-object -w --path apps/web/src/styles.css` 写进对象库，再
   `git update-index --cacheinfo 100644,<blob>,apps/web/src/styles.css` 挂上索引
   （blob `33160b4`，188 增 / 0 删，`git diff --cached` 里只有我这一段）；
3. 提交后核对：`git diff --stat -- apps/web/src/styles.css` 仍是 **416 增 / 23 删**（别人的改动原样留在
   工作树、仍未提交），且 `git diff -- apps/web/src/styles.css` 里 `pp-mediablock|pp-team-avatar|
   pp-gallery-dialog` 命中 **0** 次——我的段没有以"未提交改动"的形式泄回工作区。

`lib/blocks.ts`、`components/blocks/index.tsx`、`dict/fragments/lib_blocks.ts` 在开工时是干净的
（`git status` 无输出），改完 `git diff` 也只有我这几段（0 删除），所以这三处是逐个 `git add <path>`。
全程没有 `git add -A` / `git stash` / `git checkout -- .`，也没有用 `Get-Content` / `Set-Content`
改写任何源码（读写走 read/edit/write）。临时脚本放在 `.superpowers/sdd/`（不在 `apps/web/src` 下，
不参与 `import.meta.glob` 与 i18n 审计），探查 `happy-dom` 的探针脚本已删除。

## 5. 测试清单（33 条，`src/lib/mediaGalleryBlocks.test.ts`）

| 分组 | 条数 | 钉住的东西 |
| --- | --- | --- |
| 三条注册表定义 | 7 | name/description 非空、`group:'content'`、`variants`、`defaults` 精确值、defaults ⊆ schema、读→写幂等、`ratio` 三档、repeater 子字段与 `maxItems`（12/12/20）、repeater 清洗（多余键丢掉、15 条截到 12） |
| 渲染器注册 | 2 | 三个 type 都在生产 `BLOCK_RENDERERS` 里；`MEDIA_GALLERY_RENDERERS` 恰好这三条 |
| `lightboxStep` | 5 | 空集 / 单张、前后加减、两端回绕、跨多张、坏输入收敛（含 `NaN` 与负 `total`） |
| 团队 | 4 | 首字母占位（中英文）、有头像时 alt 为空串且渲染 `<img>`、`javascript:` 头像与链接都不落地、超 12 位截断 |
| Logo 墙 | 3 | alt 取值 / 缺省空串、外链 `target` + `rel`、无图条目跳过 |
| 图集 | 7 | 缩略图 src 与 alt、CSS 变量下发（列数 + 比例）、点开 dialog（大图 + 说明）、Esc 关闭 + 焦点回填、按钮与方向键切换含回绕、单图不渲染前后按钮、关闭按钮 + 焦点回填、无图条目跳过 |
| 空状态 | 1 | 三个区块都渲染引导文案 |
| 样式 | 4 | 头像 `border-radius: 50%`、`grayscale(1)` + hover `grayscale(0)`、减少动效 `transition: none`、`aspect-ratio: var(--pp-gallery-ratio…)` 与 `dialog` / `::backdrop` |

## 6. 留给后续任务的

- **`BlockProps.tsx` 的 repeater 不支持 `media` 子字段**：`prop.type === 'media'` 只在顶层走媒体库
  选择器；repeater 行里的 `avatar` / `image` 会退化成普通文本框（值仍是 URL，能填、能存、能渲染，
  但作者拿不到"从媒体库选择"）。这是本任务唯一的功能短板，属于共享编辑器的能力缺口，
  建议单开一条：给 repeater 行的 `media` 字段复用 `MediaPicker`。
- 图集的灯箱是"一次渲染当前一张"。图片很多（20 张）时首屏只加载缩略图，大图切换会各加载一次；
  若要预加载，加 `<link rel="prefetch">` 或在小图 `onLoad` 后建 `Image()`，不必改状态机。
- Task 4 的说服类区块若要复用灯箱，`lightboxStep` 已经是纯函数、无 DOM 依赖，可以直接 import；
  但 `MEDIA_GALLERY_RENDERERS` 的形状是"只导出自己的三条"，不要往里塞别的区块。
- 三个区块都是静态内容，**不要**给它们登记 `lib/loading.ts` 的骨架形状（骨架只属于依赖
  `FeedContext` 的区块，与 Task 2 的结论一致）。
- 窄屏统一 2 列是产品上的临时取舍；若希望图集在手机上保持 1 列，改
  `@media (max-width: 767px)` 那一段即可，渲染器不用动。
