# 文章写作图表（思维导图 / 逻辑图 / 统计图 / 鱼骨图）· 设计规格

日期：2026-11-01  
状态：已实现并通过验收  
范围：`apps/web` 的富文本编辑器与文章阅读页；后端契约与安全白名单未改。  
前置：`2026-11-01-page-customization-blocks-design.md`（页面编排的通用外观与按钮保留，思维导图从编排迁到写作）。

## 1. 背景与目标

页面编排是「站点版面」工具，思维导图属于**文章内容的表达**。本轮把图表能力从页面编排搬到写作：
在富文本编辑器里插入 **思维导图 / 逻辑图 / 统计图（柱状、折线、环形、饼图）/ 鱼骨图**，存进稿件、随文章发布，阅读页按主题渲染。

## 2. 关键约束（源码现状）

- 文章正文以 Markdown 存盘（编辑器 DOM → `htmlToMarkdown` → 服务端 goldmark → Rust 白名单清洗）。
- 服务端白名单只允许：`a b blockquote br code del em h1-h6 hr i img li ol p pre s strong table tbody td th thead tr ul`，
  属性只有 `class`（全标签）、`a[href,title]`、`img[src,alt,width,height]`；**没有 div/svg/figure，也没有 data-\*、style**；
  链接协议只允许 http/https/mailto，因此 `data:` 图片也被拒绝。
- 结论：**内联 SVG、data-URL 图片、自定义容器都进不了文章正文**。要做到「不改白名单、不加依赖」，图表必须以
  围栏代码块（`pre > code`）的形式存盘，由前端在渲染后**水合（hydrate）**成 SVG。

## 3. 方案

### 3.1 存储格式

````markdown
```pp-diagram
{"type":"mindmap","title":"站点结构","outline":"我的站点\n  写作\n  阅读","layout":"both","line":"curve","palette":"colorful"}
```
````

- goldmark 输出 `<pre><code class="language-pp-diagram">…</code></pre>`，Rust 白名单原样保留（`class` 合法）；
- 正文里只多一段紧凑 JSON（通常 < 1 KB），不把渲染结果写进正文，换主题/换布局随时重渲染；
- 服务端不需要知道图表的含义：**零后端改动**，fail-closed 边界不变。

### 3.2 渲染与水合

- `lib/diagramSpec.ts`：规格类型、白名单归一化、JSON 解析/序列化、`diagramBlockHtml()`（插入用围栏 HTML）、图表数据行解析。
- `lib/diagramSvg.ts`：纯函数 `renderDiagramSvg(spec): string`，四类图共用一套主题令牌与 CSS 类；文本全部转义。
- `lib/diagramHydrate.ts`：
  - `hydrateDiagrams(root)`：把 `pre > code.language-pp-diagram` 换成 `<figure class="pp-diagram pp-diagram-<type>">…svg…</figure>`；
  - `decorateEditorDiagrams(root)`：编辑器内保留隐藏的 `code`（序列化用）+ 可见的 `contenteditable="false"` 预览，
    让作者在正文里直接看到图表；点击预览上的「编辑图表」回到弹窗；
  - `findDiagramBlock(node)`：从光标/选区找到所在图表块，供编辑回填。
- 文章页：`useArticleDiagrams(html)`（`components/ArticleTools.tsx`）在 `rendered_html` 渲染后水合；
  编辑器：挂载、插入、每次 `emit()` 后装饰；`htmlToMarkdown` 仍然只读隐藏的 `code`，围栏原样保存。

### 3.3 四类图

| 类型 | 输入 | 渲染 |
| --- | --- | --- |
| 思维导图 | 缩进大纲（第一行中心主题） | 复用 `lib/mindmap.ts` 的 tidy-tree；两侧/向右、曲线/折线、彩色分支/主题单色 |
| 逻辑图 | 缩进大纲（第一行起点） | 同一棵树，向右/向下流程排版，直角连线 + 箭头 |
| 统计图 | 每行「标签,数值」 | 柱状 / 折线 / 环形 / 饼图；自动配色，数值标签与图例 |
| 鱼骨图 | 缩进大纲（第一行问题，一级分类，二级原因） | 横向鱼骨：主脊 + 上下交替斜骨 + 分类名与原因文字 |

限制（归一化时强制）：大纲 ≤ 4000 字符、图表数据 ≤ 12 项、单标签截断、树深与节点数复用 mindmap 引擎上限（6 层 / 80 节点）。

### 3.4 编辑体验

- 工具栏新增「图表」按钮；斜杠面板新增 `/图表`；
- 弹窗：类型切换 + 对应字段 + **实时预览**；插入即在光标处生成围栏块并立即渲染；
- 光标在已有图表块内时，按钮变成「编辑图表」：回填规格，确认后整块替换；
- 正文中的图表预览右上角悬浮「编辑图表」按钮；删除按普通块操作。

## 4. 非目标

- 不引入图形库 / 图表库 / 拖拽画布；不做实时协作；
- 不支持在图表里嵌图片、链接、脚本；不做导出 PNG/SVG（后续可加，不影响存储格式）；
- 页面编排里的 `chart` 区块保持不变；仅把 `mindmap` 区块从编排移除。

## 5. 验收

1. 工具栏/斜杠面板能插入四类图，正文立即显示，保存为 `pp-diagram` 围栏；
2. 保存、刷新、重新打开编辑器后图表仍在正文里渲染，且可再次编辑；
3. 文章阅读页 `.article-body` 里出现 `.pp-diagram svg`，深色主题可读；
4. 服务端白名单无需改动；`rendered_html` 里是 `pre > code`，水合后变 SVG；
5. typecheck、vitest（新增 spec/svg/水合单测）、build、浏览器 e2e 全绿；构建体积增量可解释。

## 6. 验证记录（2026-11-02）

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 错误 |
| `npx vitest run` | 34 文件 / 404 测试通过（新增 diagramSpec 11、diagramSvg 35、diagramHydrate 6） |
| `go test ./apps/api/internal/content/` | 通过：`pp-diagram` 围栏经 goldmark 后仍是 `pre > code.language-pp-diagram`（新增用例） |
| `npm run build` | 304 modules；dist 1,737,030 B；`index-*.js` 1,224.94 kB（gzip 392.33），对比上一轮 1,712,138 B 增加约 25 KB（+1.5%） |
| `e2e-article-diagrams.mjs` | **PASS 55 / FAIL 0**：四类图插入 → 编辑回填并整块替换 → 保存 → 阅读页四图/无原始 JSON/无复制按钮 → 暗色模式 → 重开编辑器围栏与预览都在 |
| `e2e-builder-blocks.mjs` | **PASS 34 / FAIL 0**：按钮与外观断言不变；组件库与配置里都不再有思维导图 |
| 截图 | `apps/web/.tmp/shots-article-diagrams/`（11 张）、`apps/web/.tmp/shots-builder/`（7 张） |

> Rust 侧新增了两条 sanitizer 用例（保留 `language-pp-diagram` 围栏、仍然拒绝内联 SVG），但本机缺少 MSVC
> `dlltool.exe`，`cargo test` 无法完成编译；用例逻辑与既有白名单一致，需在具备 Rust 工具链的 CI 上跑一次。
