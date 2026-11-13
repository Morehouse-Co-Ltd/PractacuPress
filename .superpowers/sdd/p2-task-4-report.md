# P2 Task 4 — 说服组件四件套（定价 / FAQ / 证言 / 图文交替）

- 分支：`feat/page-builder-v2-p0`
- 提交：`d542ba5 feat(web): add the pricing, FAQ, testimonial and media-text blocks`
- 状态：**完成**（TDD 红→绿，全量测试绿，`tsc --noEmit` 通过，i18n 闸门通过）

## 1. 交付内容

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `apps/web/src/lib/blocks.ts` | 改 | 四条注册表定义：`pricing` / `faq` / `testimonial` / `media-text` |
| `apps/web/src/components/blocks/ConversionBlocks.tsx` | 新建 | `CONVERSION_RENDERERS` + 纯函数 `splitFeatures` |
| `apps/web/src/components/blocks/index.tsx` | 改 | `...CONVERSION_RENDERERS` 展开进生产 `RENDERERS` |
| `apps/web/src/styles.css` | 改 | 末尾追加「说服区块」样式段（214 行 / 单 hunk） |
| `apps/web/src/lib/conversionBlocks.test.ts` | 新建 | 44 条用例 |
| `apps/web/src/lib/i18n/dict/fragments/lib_blocks.ts` | 改 | 四条定义的文案英译（40 条词条） |
| `apps/web/src/lib/i18n/dict/fragments/components_blocks_ConversionBlocks.ts` | 新建 | 渲染器自己的词条（`推荐`） |

沿用 P2 Task 2/3 的模块形状：数据侧只在 `blocks.ts` 多四条定义，渲染侧只多一个
`*_RENDERERS` 映射文件，CSS 追加一段，i18n 一个片段，一份注册表测试。没有任何
渲染器需要改编辑器代码——属性面板全部由 schema 驱动。

### 四条定义

- `pricing`：`heading` + `items`（`name`/`price`/`period`/`features` textarea/
  `cta_label`/`cta_link`/`featured` toggle，最多 4 档）
- `faq`：`heading` + `open_first` toggle + `items`（`question`/`answer` textarea，最多 20 条）
- `testimonial`：`heading` + `layout` select（grid / carousel）+ `items`
  （`quote` textarea / `name` / `role` / `avatar` media，最多 9 条）
- `media-text`：`image` media / `alt` / `title` / `body` **richtext** /
  `side` select（left / right）/ `cta_label` / `cta_link`

四条都是 `group: 'content'`、`variants: ['classic', 'bento']`。

## 2. 渲染要点与取舍

- **定价**：`featured` 只认真正的布尔 `true`（旧配置里的 `'true'` 字符串不高亮）；
  推荐档加主题色描边 + 同色内阴影与右上角「推荐」角标。价格与周期分两层
  （`clamp(26px, 3.2vw, 34px)` 对 12px），清单按行拆，`-` 开头灰色删除线。
  档位数 1–4 不给「列数」属性：`repeat(auto-fit, minmax(220px, 1fr))` 让两档不会摊成
  两半宽的空卡阵。按钮 `margin-top: auto` 沉底，短清单不会把按钮顶上来。
- **FAQ**：原生 `<details>` + `<summary>`，零 JS、键盘可达；`open_first` 只作用在第一条。
  答案用 `white-space: pre-wrap` 保留换行（作者写多行答案不需要 Markdown）。
- **证言**：`carousel` 用 CSS `scroll-snap-type: x mandatory` + `scroll-snap-align: start`
  横滑，零 JS；滚动容器 `tabIndex={0}` + `role="group"` + `aria-label`，键盘能聚焦后用
  方向键翻。
  **未做分页圆点**：纯 CSS 拿不到滚动位置，要跟随高亮就得挂 `scroll` 监听并引入状态，
  为了一个装饰点不值得（brief 允许省略并说明）。已在此记录。
- **图文交替**：`side` 只调换两栏顺序（`order: 2`），DOM 顺序始终是「图文」，读屏顺序不变；
  `body` 走 `sanitizeHtml(renderMarkdown(body))`，与 `text` 区块完全同一条链路，
  没有第二套渲染；窄屏（≤767px）一栏、图在上文在下，`side` 不再生效。
- **链接**：一律先过 `safeUrl()`（只放行 `http(s)` 与 `/` 开头的站内路径），外链补
  `target="_blank"` + `rel="noreferrer noopener"`；没过白名单的按钮降级成
  `<span aria-disabled="true">`（保留样式、不可点、不改变地址栏），与 `button` 区块同一套处理。
- **图片**：`media` 值先过 `safeUrl` 再进 `src`；头像 `alt=""`（姓名就在旁边，读屏不重复念），
  `media-text` 的 `alt` 取作者填写值；没图/坏地址时直接不画 `<img>`，不留破图。
- **空状态**：`pricing` / `faq` / `testimonial` 没有条目时给作者一句「在右侧添加条目。」
  （复用既有词条）；`media-text` 四样全空时返回 `null`（与 `text` 区块一致，空区块不占版面）。
- **上限二次截断**：旧配置可能超编，渲染时按 4 / 20 / 9 再截一次。

## 3. `splitFeatures(text)` 的规则（纯函数，已单测）

一行一条；行首 `-` 表示「不含」；空白行跳过；行首尾空白去掉；重复标签只保留第一次出现的
那条（含「含 / 不含」冲突时先写的说了算）；只剩一个 `-` 的行没有标签，直接丢掉。
`\r\n` 与 `\n` 都认。标记只吃掉一个 `-`（`--x` 剩下的 `-x` 仍是标签的一部分）。

单测覆盖：空串 / 纯空白 / 空行 / 顺序 / `-` 标记 / 缩进与行尾空格 / 去重（含冲突）/
孤立 `-` / 单字功能。

## 4. 验证

- **基线**：改动前 `npx vitest run` = **64 文件 / 748 用例** 全绿（brief 写的是 63 / ~730，
  实际树里已多一个文件，以实测为准）。
- **改动后**：`npx vitest run` = **65 文件 / 792 用例** 全绿（+1 文件 / +44 用例，
  数量与 `conversionBlocks.test.ts` 的 44 条完全对应，无其它用例被动增删）。
- `npx tsc --noEmit`：通过（exit 0）。
- `npm run i18n:audit`：`ConversionBlocks.tsx` 待迁移 0 / 已包裹 3；`lib/blocks.ts` 仍是
  改动前的 36 条（全部是既有演示文案，本次没有新增待迁移文案）。
- `src/lib/i18n/coverage.test.ts`：3/3 通过（缺英文条目 = `[]`、英文无 CJK、
  占位符一一对应）。

## 5. 共享工作树与暂存方式

工作树是多个会话共用的，`styles.css` 里已有别的会话的改动（12 行处、2389/2392/2400、
6529–6876 一段、7955 处 395 行的骨架屏样式）。做法：

1. 只 `git add` 精确路径，从不用 `-A` / `stash` / `checkout -- .`；
2. `styles.css` 走「HEAD blob + 自己那一段」：`git cat-file blob HEAD:…styles.css`
   → 拼上工作区里本会话的末尾一段（从注释块开头到 EOF）→
   `git hash-object -w --path=…` → `git update-index --cacheinfo`；
3. 核对：暂存区里 `styles.css` 只有 **1 个 hunk / 214 行新增**，工作区未暂存的 diff
   里我这一段已经不在（只剩别的会话的 hunk）；
4. 其余三个被改的文件（`lib/blocks.ts`、`blocks/index.tsx`、`lib_blocks.ts` 片段）
   改动前是干净的，核对后各自只有**一个纯新增 hunk**（+133 / +2 / +40），可以直接 `git add`。

提交 `d542ba5`：7 个文件、1236 insertions、**0 deletions**。提交后工作区仍保留别的会话的
`styles.css` 改动（416 insertions / 23 deletions 未暂存），没有被本次提交带走。

## 6. 已知取舍 / 未做

- 证言横滑没有分页圆点（原因见 §2），如需圆点要引滚动监听 + 状态。
- `<details>` 的展开状态属于浏览器，`open_first` 只控制初始的 `open` 属性：作者手动展开后
  若发生重渲染（如 Feed 数据刷新），第一条会回到 `open_first` 的值。这是"零状态"的代价，
  换成受控状态就得多一份与 DOM 争抢的状态机，取舍是不值得。
- `pricing` 没有「列数」属性（auto-fit 自适应），与 Task 2 的网格区块刻意不同。
- 本任务未跑 `npm run build` 与 e2e——brief 把「构建 + 体积增量 + e2e + 设计文档 §14」
  留给 Task 5 的收口步骤。
