# 编辑器 Markdown 写作体验（行首标记 / 斜杠面板 / 换行语义）设计

日期：2026-11-02
状态：已确认，进入实现
相关文件：`apps/web/src/components/RichTextEditor.tsx`、`apps/web/src/components/SlashMenu.tsx`、`apps/web/src/lib/htmlToMarkdown.ts`、`apps/web/src/lib/markdownInput.ts`

## 1. 背景

正文编辑器（`RichTextEditor`，文章编辑页与页面编排里的富文本块弹窗共用）是所见即所得的：
作者敲 `## ` 会被立刻转成 `<h2>`，Markdown 前缀本身不留在正文里。这带来三个具体问题：

1. **看不到自己处在什么语法里。** 标题、列表、引用一旦转换完成，作者只能靠字号和缩进判断，
   想确认"这是二级还是三级标题"必须打开源码。需要：光标停在某个块上时，在行首用淡色显示
   该块对应的 Markdown 标记。
2. **`/` 指令面板的位置与滚动不跟手。** 面板用光标矩形做 `position: fixed`，但
   （a）`.slash-menu-list` 有 `max-height` 却没有把高亮项滚进可视区的逻辑，16 条指令里
   ↑↓ 走到折叠线以下就"消失"；（b）光标矩形退化为零尺寸时（空段落、行首、某些浏览器）
   会退回编辑区左上角，面板看起来不在输入处；（c）编辑区自身滚动或窗口缩放时面板不重新定位；
   （d）`top` 被硬夹到 `innerHeight - 360`，小窗口里会压住光标。
3. **换行把段落数弄错。** `lib/htmlToMarkdown.ts` 把 `<br>` 序列化成 `\n\n`，一个段落
   变成两个 Markdown 段落；粘贴纯文本时又按行塞 `<br />`。结果：作者看到的 1 段，
   存进 `source_body` 是 N 段，公开页出现多余段间距——即"行数错位"。

## 2. 目标与非目标

目标

- 光标所在的**块级**元素（标题 / 列表项 / 引用 / 代码块）在行首左侧留白显示淡色 Markdown 标记，
  光标离开即消失；标记不挤动正文、不改变折行、不进入存盘内容。
- `/` 面板始终贴在光标处；↑↓ 选择时列表自动把高亮项滚进可视区；空间不足时翻到光标上方。
- 段内换行不再把一个段落拆成多个 Markdown 段落；导出 `.md` 时再把段内换行补成硬换行。

非目标（本次不做，避免扩大范围）

- 不做整篇"半源码模式"（所有块常显标记）。
- 不显示行内语法标记（`**`、`` ` ``、~~、链接）。见 §7 决策 D2。
- 不引入 CodeMirror/ProseMirror 之类的编辑器内核，继续用 contenteditable + execCommand。
- 不改服务端渲染（goldmark）与清洗白名单。
- 不新增界面文案（不动 i18n 字典）。
- 不给 `lib/markdown.ts` 的预览渲染器补"硬换行"语法支持（见 §6 兼容性）。

## 3. 决策记录

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | 标记摆放 | 浮在行首左侧留白（绝对定位），只显示光标所在块 | 挤进正文会让这一行文字抽动（用户明确不希望），常显又变成半个源码模式 |
| D2 | 标记范围 | 只盖块级前缀 | 行内标记（粗体、代码、链接）要在光标两侧飘符号，噪声远大于收益 |
| D3 | 段内换行 | 方案 A：存储只留单个 `\n`（不拆段），导出 `.md` 时补硬换行 | 符合"写作时不需要断开一行"；公开页按正常中文段落连排 |
| D4 | 标记要不要进 DOM 内容 | 不进：放在 contenteditable **外面**的浮层里 | 若放进编辑区，`innerHTML` 会带上标记文字（污染存盘）、`innerText` 会带上（污染字数）、复制会带上 |

## 4. 设计

### 4.1 行首标记层

分三层，语义与几何彻底分开，几何部分全部可单测：

**语义层** `apps/web/src/lib/editorBlockMarker.ts`

```ts
/** 从光标所在的块元素推出该块在 Markdown 里的行首标记；没有行首语法时返回 null。 */
export function blockMarkerFor(block: Element | null): string | null;
```

规则（与 `htmlToMarkdown` 实际写出的语法对齐，所以 `h2` 显示 `##` 而不是 `#`）：

| 块 | 标记 |
|---|---|
| `h1`…`h6` | `#` 重复 level 次 |
| `ul > li` | `-`；首字符是 ☐/☑ 时 `- [ ]` / `- [x]` |
| `ol > li` | 实际序号 `1.`、`2.`… |
| `blockquote` | `>` |
| `pre` | ` ``` ` |
| `p` / `div` / 表格单元格 / 富文本区块 | `null`（不显示） |

富文本区块用 `closest()` 一次性排除：`a.pp-video`、`a.pp-embed`、`a.pp-linkcard`、
`p.pp-image`、`p.pp-icon-line`、`blockquote.pp-note`、`table.pp-columns`、`table.pp-gallery`、
`table.pp-table`、`table`、`[data-pp-diagram-edit]`。

**几何层** `apps/web/src/lib/caretRect.ts`

```ts
/** 光标/锚点矩形，全部是视口坐标。 */
export interface CaretAnchor { left: number; top: number; bottom: number; height: number }

/** 光标矩形：range 自身矩形 → getClientRects()[0] → 块矩形，逐级降级，不修改 DOM。 */
export function caretAnchor(range: Range, block: HTMLElement | null): CaretAnchor | null;

/** 块的首行行盒（用于把标记对齐到"这一行的第一行"）。 */
export function firstLineAnchor(block: HTMLElement): CaretAnchor | null;

/** 面板落点：优先光标下方，放不下翻到上方，横向夹在边距内。 */
export function placeMenu(
  anchor: CaretAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap?: number,   // 默认 6
  margin?: number // 默认 8
): { left: number; top: number; placement: 'below' | 'above' };
```

`caretAnchor` 刻意**不**靠插入探针 span 来量零尺寸光标：那会改到 DOM 与选区，contenteditable
里风险大于收益。证据链是 range 矩形 → client rects → 块矩形，最后一档标注为近似。

**渲染层**（`RichTextEditor.tsx`）

- 编辑区外面包一层 `.rich-surface-shell`（`position: relative`），浮层 `span.pp-line-marker`
  与 `.rich-surface` 同级，`aria-hidden`、`pointer-events: none`、`user-select: none`。
- 同步时机：`document` 的 `selectionchange`（rAF 合并）、`input`、`click`、`keyup`、编辑区
  `scroll`、`window.resize`；只读（`disabled`）时不渲染。
- 定位：`firstLineAnchor(block)` → 视口坐标减 shell 矩形 → 浮层局部坐标；
  `left` 取正文栏左边缘（`padding-left`）再减去标记宽度（CSS `transform: translateX(-100%)`）。
  行盒滚出编辑区时直接隐藏而不是贴边。
- 变化幅度小于 0.5px 时不 `setState`，避免同一行内输入时的抖动。
- `≤ 760px` 视口隐藏：左留白不够，宁可没有也不能压到正文。

### 4.2 `/` 指令面板

`SlashMenu` 从"父组件算好 `left/top`"改为"父组件给光标锚点，面板自己决定落点"：

- 新增 prop `anchor: CaretAnchor | null`（替换 `position`）。
- `useLayoutEffect` 里量一次自身 `offsetWidth/offsetHeight` → `placeMenu(...)`；
  窗口尺寸变化时重量。
- **滚动跟随**：`activeIndex` 或过滤结果变化后，把高亮项用 `getBoundingClientRect()`
  与 `.slash-menu-list` 的可视区比对，差多少补多少 `scrollTop`。不用 `scrollIntoView`，
  免得把整页一起滚走。
- 打开期间监听 `window` 的 `scroll`（capture）+ `resize`，由 `RichTextEditor` 重算锚点后回传，
  保证编辑区内部滚动时面板跟着光标走。
- 键盘捕获（↑↓ / Enter / Tab / Esc）、`aria-activedescendant`、鼠标 hover 高亮全部保留。

### 4.3 换行语义与导出（方案 A）

**存储侧**

- `htmlToMarkdown.ts`：行内 `<br>` → **`\n`**（不再是 `\n\n`）；`<p>` 不再按 `\n{2,}` 二次拆段，
  段内软换行原样保留为一个 `\n`；块与块之间仍由 `serializeChildren` 用空行连接。
- 粘贴纯文本：单个 `\n` 并成空格，只有 `\n{2,}` 才分段（不再逐行塞 `<br />`）。
- 顺带加固：`htmlToMarkdown` 忽略 `[data-pp-marker]` 元素（浮层万一被挪进编辑区也不会污染存盘）。

**导出侧** 新增 `apps/web/src/lib/markdownExport.ts`

```ts
/** 导出用：把正文里"连续正文行"之间的软换行补成 Markdown 硬换行（行尾两个空格）。 */
export function toExportMarkdown(source: string): string;
```

逐行扫描，维护 `inFence`（``` / ~~~，注意 ``` 后允许语言名）、跳过表格行（`|` 开头或以 `|`
结尾）、列表项、标题、HTML 区块行（`<` 开头）、水平线、空行——这些行原样保留、只清行尾空白；
只有**连续两行普通正文**之间的换行改写成 `  \n`。`pages/admin/Editor.tsx` 的
`exportMarkdown()` 走这个函数；保存仍存原始 Markdown。

## 5. 验收

- `pnpm -C apps/web test`：新增/更新单测
  - `editorBlockMarker.test.ts`：h2/h3/h4、ul/ol/任务列表、blockquote、pre、段落/表格/富文本区块、嵌套列表序号。
  - `caretRect.test.ts`：`placeMenu` 的四条路径（下方、翻上方、左右夹边、小窗口）；
    `caretAnchor` 的降级链（用假 range 对象）。
  - `markdownExport.test.ts`：段内换行补硬换行；围栏代码/表格/列表/HTML 区块不被改写；行尾空白清理。
  - `htmlToMarkdown.test.ts`：`<br>` 只产生一个 `\n`、一个 `<p>` 仍是一个段落。
- `pnpm -C apps/web typecheck`：无错误。
- 真实浏览器：用仓库现有的 CDP 无头 Chrome 脚本（`apps/web/scripts/e2e-*.mjs` 的做法）在编辑区
  验证：面板出现在光标下方且随 ↑↓ 滚动、翻屏位置正确、行首标记与行盒对齐、导出内容含 `  \n`；
  截图落到 `.tmp/shots-editor/`。

## 6. 兼容性与副作用

- `source_body` 格式没有破坏性变化：仍是一段普通 Markdown；只是 `<br>` 不再膨胀成两个段落。
  历史稿件里已经写进 `\n\n` 的"碎段"不会被自动合并（要合并得手工编辑），本次不做迁移。
- 段内 `Shift+Enter` 的换行存盘后重新打开会并回同一段（`renderMarkdown` 用空格连接段落内的行），
  这与"写作时不需要断开一行"一致；导出的 `.md` 仍然断行。
- 预览渲染器 `lib/markdown.ts` 不识别 `  \n` 硬换行，导入此类文件时会连排；公开页走服务端
  goldmark，行为以服务端为准。本次不改渲染器。
- 浮层不进 contenteditable：不影响 `htmlToMarkdown`、字数统计、复制粘贴、撤销栈。

## 7. 风险

- happy-dom 的 `getBoundingClientRect` 恒为零，几何只能测纯函数分支；真实对齐靠 e2e 截图核对。
- 标记浮层依赖 `padding-left` 的可用宽度：窄屏（≤760px）隐藏；`clamp(18px, 3vw, 42px)`
  在 900–1100px 区间大约 27–33px，够放 `####`（≤ 26px），但要在 e2e 里核对一次不被裁切。
- 面板翻转依赖自身高度，首次挂载前用估计高度（276×330）兜底，挂载后一帧内纠正。
