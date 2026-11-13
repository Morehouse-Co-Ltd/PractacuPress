# 文章写作图表 · 实施计划

日期：2026-11-01  
状态：已完成（W6–W9 全部完成，验收记录见设计文档 §6）  
设计：`docs/superpowers/specs/2026-11-01-article-diagrams-design.md`  
说明：本计划修正 `2026-11-01-page-customization-blocks-plan.md` 中「思维导图作为页面编排区块」的决定——思维导图迁入文章写作，页面编排保留通用外观与按钮。

## 工作流（写作用域互不重叠）

| 编号 | 承担 | 写作用域 | 依赖 |
| --- | --- | --- | --- |
| W6 基础契约 | Lead | `lib/diagramSpec.ts`、`lib/diagramHydrate.ts`、页面编排 mindmap 移除、CSS、README/文档 | — |
| W7 渲染器 | teammate `diagram-svg` | `lib/diagramSvg.ts`、`lib/diagramSvg.test.ts`、`lib/i18n/.../lib_diagramSvg.ts` | W6 契约 |
| W8 编辑器接线 | Lead | `components/DiagramDialog.tsx`、`components/EditorToolbar.tsx`、`components/RichTextEditor.tsx`、`components/SlashMenu.tsx`、`components/ArticleTools.tsx`、`pages/site/ContentDetail.tsx`、`lib/format.ts`、相关 i18n 片段 | 可与 W7 并行 |
| W9 验收 | teammate `verifier` | `scripts/e2e-article-diagrams.mjs`（新增）、`scripts/e2e-builder-blocks.mjs`（移除 mindmap 断言） | W6–W8 |

## 存储与渲染契约

````markdown
```pp-diagram
{"type":"mindmap","title":"","outline":"中心\n  分支","layout":"both","line":"curve","palette":"colorful"}
```
````

- 服务端 goldmark 渲染为 `<pre><code class="language-pp-diagram">…</code></pre>`，Rust 白名单原样保留；
- 阅读页 `useArticleDiagrams` → `hydrateDiagrams` 替换成 `<figure class="pp-diagram pp-diagram-<type>">` + SVG；
- 编辑器 `decorateEditorDiagrams` 保留隐藏 `code`（`htmlToMarkdown` 序列化用）+ 可见预览；
- 规格类型：mindmap（outline/layout/line/palette）、logic（outline/direction）、chart（kind/unit/items）、fishbone（outline）。

## 验收标准

1. 工具栏「图表」与斜杠 `/图表` 都能打开弹窗，四类图有实时预览，插入后正文立即显示；
2. 保存后 `source_body` 含 ```` ```pp-diagram ```` 围栏，刷新/重开编辑器图表仍显示，点「编辑图表」可回填并整块替换；
3. 文章阅读页 `.article-body` 出现 `.pp-diagram svg`，明暗主题可读；代码复制按钮不会挂到图表上；
4. 页面编排的组件库不再有「思维导图」，按钮与通用外观不受影响；
5. 字数/摘要不把图表 JSON 算进正文；
6. typecheck、vitest（新增 spec/render/hydrate 单测）、build、浏览器 e2e 全绿。
