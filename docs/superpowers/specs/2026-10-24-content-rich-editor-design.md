# 文章与帖子富文本编辑器设计

**版本：** v1

**日期：** 2026-10-24

**状态：** 已确认设计，待实现计划

## 1. 范围与目标

本次改造只覆盖后台文章/帖子编辑页：

- `/admin/content/new/:kind`
- `/admin/content/:kind/:id`

独立页面编辑器 `/admin/pages/...` 暂不改造。

编辑页默认使用所见即所得的富文本编辑面。作者在排版结果上直接输入和修改，不在编辑区看到 Markdown 语法。Markdown 只作为文件导入与导出格式，正文保存时统一使用 `source_format: markdown`。

现有图片、网址卡、视频卡、表格、分栏、图集、图标、提示框等富文本区块全部保留。现有服务端清洗、内容状态机、保存接口和未保存提醒继续沿用。

## 2. 已确认的产品决策

### 2.1 Markdown 导入与导出

- 导入：通过隐藏的文件选择器读取本地 `.md` 文件，单文件限制 2 MB，读取失败时显示错误提示。
- 导入成功后，正文立即替换为渲染后的富文本，表单变为未保存状态；不会自动覆盖标题、摘要或 slug。
- 导出：下载当前编辑区最新序列化得到的 Markdown，文件名优先使用 slug，其次使用标题，无法生成有效名称时使用 `untitled.md`。
- 导出内容不使用旧的 textarea 值，而是使用富文本编辑器每次输入后产生的最新 Markdown。

### 2.2 保存格式与历史兼容

- Markdown 内容直接渲染为编辑器 HTML。
- 历史 HTML 内容先经过现有清洗逻辑，再转成编辑器 HTML；保存时转成 Markdown。
- 历史纯文本内容按段落渲染，再转成 Markdown。
- 加载历史 HTML/纯文本时，编辑页在内存中将 `source_format` 视为 `markdown`；保存后正式统一为 Markdown。
- 如果真实后端响应没有 `source_body`，编辑页继续只读并提示无法安全编辑，避免以空内容覆盖原文。

### 2.3 公式

- 支持 Markdown 行内公式 `$...$` 与块级公式 `$$...$$`。
- 为保持当前项目零新增依赖，公式以独立、可编辑的公式节点显示，并保留原始公式文本；不承诺 KaTeX/MathJax 级别的复杂排版。
- 公式节点可以通过工具栏插入和修改：行内公式使用 `span.pp-math-inline`，块级公式使用 `p.pp-math-block`，原始公式放在 `data-pp-math` 属性中，可见内容按安全文本展示；HTML → Markdown 序列化只读取该属性并还原为原始 `$...$` 或 `$$...$$` 语法。
- 公式文本作为文本内容处理，不允许注入 HTML 或脚本。

## 3. 架构与模块边界

### 3.1 `EditorPage`

`apps/web/src/pages/admin/Editor.tsx` 继续负责页面级状态与后端交互：

- 标题、slug、摘要、正文 Markdown、保存初始快照。
- 根据稿件状态决定编辑权限。
- 加载稿件并将源格式归一化为富文本初始 HTML。
- 处理 Markdown 文件导入、Markdown 文件导出。
- 调用 `createDraft` / `updateDraft` 保存 Markdown。
- 处理流程动作、错误提示、未保存离开提醒和 toast。

编辑页不再维护 Markdown textarea、实时预览 split pane 或旧版文本工具栏状态。

### 3.2 `RichTextEditor`

`apps/web/src/components/RichTextEditor.tsx` 是富文本表面：

- 使用 `contenteditable`，由浏览器处理选区、中文输入法和原生撤销。
- 只在 `revision` 改变时整体灌入 `initialHtml`；普通输入只通过 `onChange` 向页面发送 Markdown 与统计信息，不重新灌 DOM。
- 负责粘贴纯文本、区块回车行为、表格 Tab 导航、链接点击拦截和只读状态。
- 通过 `EditorCommands` 暴露格式命令和区块插入命令。
- 输出 `onChange(markdown, stats)`，其中 Markdown 由 `htmlToMarkdown` 生成。

### 3.3 `EditorToolbar`

`apps/web/src/components/EditorToolbar.tsx` 继续承载格式按钮和插入对话框，但统一接收 `EditorCommands`：

- 格式按钮调用富文本命令，不再操作 textarea 的字符串选区。
- 插入图片、视频、网址卡、表格、分栏、图集、图标、提示框时先保存当前 Range，弹窗关闭后恢复并插入 HTML。
- 增加 Markdown 导入/导出由页面级操作提供；工具栏只负责发出回调或按钮事件，不直接拥有稿件状态。
- 增加公式插入/修改入口：行内公式使用 `span.pp-math-inline`，块级公式使用 `p.pp-math-block`，原始公式通过 `data-pp-math` 保存并按安全文本展示。

### 3.4 `markdown.ts` 与 `htmlToMarkdown.ts`

- `renderSource` 继续作为源格式到 HTML 的入口。
- Markdown 渲染器增加公式识别，并生成编辑器可识别的公式节点。
- HTML 序列化器优先识别公式节点和特殊富文本区块，再处理普通段落、标题、列表、引用、代码、表格、图片与链接。
- 序列化结果必须删除编辑器临时属性，不把 `contenteditable`、内联样式或编辑器空状态写入 Markdown。
- 公式、网址、图片等属性值都按文本/URL规则转义，不能通过导入 Markdown 注入脚本。

## 4. 数据流

### 4.1 加载已有稿件

```text
Content.source_format + Content.source_body
        │
        ├─ markdown → renderMarkdown
        ├─ html     → sanitizeHtml → htmlToEditorMarkup
        └─ plain    → renderPlain → htmlToEditorMarkup
        │
        ▼
RichTextEditor.initialHtml + revision
        │
        ▼
作者在 contenteditable 中直接编辑
        │
        ▼
htmlToMarkdown(root.innerHTML)
        │
        ▼
EditorPage.form.source_body
```

加载阶段生成 `initial` 快照时同时使用归一化后的 Markdown，避免仅因为历史格式转换就误报未保存。

### 4.2 Markdown 导入

```text
文件选择器
  → 文件大小校验
  → File.text()
  → 长度限制
  → renderMarkdown
  → RichTextEditor revision 重灌
  → form.source_body 更新
  → dirty = true
```

导入不会改变标题、摘要、slug 和稿件状态。

### 4.3 保存与导出

保存请求固定发送：

```ts
{
  title,
  slug,
  summary,
  source_format: 'markdown',
  source_body: latestMarkdown,
}
```

导出直接以 `latestMarkdown` 创建 `text/markdown;charset=utf-8` Blob 并下载。保存成功后更新初始快照，导出不清除未保存状态。

## 5. 响应式布局

### 5.1 宽桌面

约 1280px 以上：

- 为内容编辑页启用宽版后台内容容器，编辑工作区可随可用宽度扩展。
- 主编辑区使用 `minmax(0, 1fr)`，右侧稿件信息约 300px。
- 右侧面板吸顶，工具栏和编辑区不会被固定宽度挤压。

### 5.2 中等窗口

约 900–1279px：

- 编辑页切换为单列，正文和工具栏优先，稿件信息与流程动作放在正文之后。
- 表格、分栏和媒体区块允许在自身容器内换行或滚动，不制造页面级横向滚动。

### 5.3 移动窗口

约 640px 以下：

- 缩小外层留白和标题字号。
- 工具栏保持固定触控尺寸并横向滚动，隐藏非必要说明文字。
- 保存、导入、导出和流程操作允许换行。
- 右侧元信息恢复普通文档流，避免吸顶遮挡正文。
- 编辑表面使用响应式最小高度，不固定整页高度；页面滚动由外层负责。

所有编辑器网格子项设置 `min-width: 0`，文本和媒体设置换行/最大宽度约束；验收时检查 `scrollWidth <= clientWidth`。

## 6. 错误处理与安全

- 文件超过 2 MB、读取失败或内容超过正文上限时，通过现有 toast 和表单错误区域提示，不改变当前正文。
- 空标题、空正文、标题/摘要/正文超限、slug 非法继续使用现有校验。
- 富文本初始 HTML 只来自现有安全渲染路径；预览和编辑区不执行脚本、iframe、事件属性或危险协议。
- 公开页面仍只使用服务端返回的 `rendered_html`，本地富文本编辑器不能替代服务端清洗。
- 插入链接、图片、视频和网址卡时继续限制 `http/https`，编辑器内部不允许点击链接跳转。

## 7. 测试与验收

### 7.1 序列化回归

覆盖以下 Markdown → HTML → Markdown 场景：

- 标题、段落、换行、粗体、斜体、删除线、行内代码。
- 有序/无序列表、任务列表、嵌套列表、引用和代码块。
- 链接、图片、规则线、规整表格。
- 图片、网址卡、视频卡、分栏、图集、图标和提示框。
- 行内公式和块级公式，确认公式原文无损。

### 7.2 编辑器交互

- 新建文章/帖子并直接输入富文本。
- 加载已有 Markdown、HTML、纯文本稿件。
- 导入 `.md`、编辑、导出 `.md` 并检查下载内容。
- 工具栏格式化、插入所有现有特殊区块和公式。
- 保存草稿后 `source_format` 为 `markdown`，未保存提醒和只读稿件行为正确。

### 7.3 构建与浏览器验证

- TypeScript 类型检查通过。
- 生产构建通过。
- 宽桌面、中屏、手机三个视口下完成浏览器交互检查。
- 检查正文可聚焦输入、工具栏可用、侧栏按断点切换、没有页面横向溢出。
- 记录关键视口截图和浏览器控制台错误，作为最终验证证据。

## 8. 非目标

- 本次不改造独立页面编辑器。
- 不引入协同编辑、版本比较或实时多人光标。
- 不引入 KaTeX/MathJax；公式只要求语法无损、可编辑和独立节点展示。
- 不修改后端 OpenAPI 契约和服务端安全白名单。
