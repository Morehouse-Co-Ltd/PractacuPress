# 封面 / Markdown 输入 / 链接卡片 / 创作者扩展 设计说明

日期：2026-10-30
状态：已实现并验证（本轮）
范围：`apps/web`（纯前端能力，不改 OpenAPI 与 Go API）

## 背景

Practacu Press 的封面一直是由文章 id 程序化生成的装饰图（`components/Cover.tsx`），
编辑器是 contenteditable 的所见即所得（`components/RichTextEditor.tsx`），正文里的链接
只有行内文字链接一种形态，「扩展」页只有 6 个写死的内置开关。本轮把四件事补成真正可用的能力：

1. 文章自定义封面；
2. 在富文本编辑器里直接输入 Markdown 语法快速排版（内容仍是 Markdown + 富文本，不新增源码面板）；
3. 链接支持「文字链接 / 卡片链接」两种显示形态；
4. 创作者制作扩展并导入使用（清单 + 沙箱 iframe + 受限 postMessage API）。

三条边界仍然有效：

- 契约 v0.1.0 没有封面 / 主题 / 页面 / 插件端点，这些配置存在本地 `pp.web.config.v1` 的
  `customization` 里，随「外观 → 导出配置」迁移；**前端不伪造接口**。
- 公开正文只渲染服务端清洗后的 `rendered_html`；演示模式用 `lib/markdown.ts` 渲染同一套语法。
- 新标签不进入安全白名单：所有新正文结构只用现有白名单标签（a / img / strong / em / br / p / table）。

## 1. 文章自定义封面

**数据**（`types.ts` → `ArticleCover`，`SiteCustomization.covers: ArticleCover[]`）

```ts
{ id: string; url: string; alt?: string; position?: 'center' | 'top' | 'bottom'; hidden?: boolean }
```

- 按内容 id 覆盖：列表卡片、首页各区块、文章详情页渲染时先查 `covers`，
  命中且未隐藏就用自定义图片，否则继续用程序化 `Cover`。
- `url` 只接受 `http(s)`、站内 `/` 路径、`data:image/...;base64`。`javascript:` / `data:text/html`
  与超长 data URL（> 1.2M 字符）在 `normalizeCoverUrl` 里直接丢弃（data URL 不能截断）。
- `hidden: true` 表示「不显示封面」，配置保留，可随时恢复。
- 编辑入口：后台创作页右侧「封面」面板——地址输入、上传图片（`backend.upload(file, 'site')`，
  演示模式走 data URL）、焦点位置、隐藏开关、实时预览、清除。
- 只影响展示，不写入文章正文或后端；导出配置时自动带上。

## 2. Markdown 输入增强（富文本编辑器内）

不新增源码 / 分屏面板，保持「所见即所得 + 存 Markdown」的模型，在上层加三件事：

1. **块级自动转换**：在段落开头输入 `# `、`## `、`### `、`#### `、`- `、`* `、`1. `、`> `、
   `[] `、`---` 等 Markdown 前缀后紧跟空格 / 回车，就地把当前段落转成对应富文本结构，
   并去掉字面前缀。
2. **行内自动转换**：`**粗体**`、`*斜体*`、`` `代码` ``、`~~删除线~~`、`[文字](https://…)`
   在闭合符号输入后转换为对应行内节点（链接只接受 http/https）。
3. **斜杠指令**：空段落输入 `/` 弹出指令面板，输入关键字过滤，↑↓ 选择、Enter 插入、Esc 关闭。
   简单块（标题 / 列表 / 引用 / 代码块 / 分割线 / 提示框）直接插入；需要参数的
   （图片、表格、分栏、公式、链接卡片）转交工具栏已有弹窗。

另外：纯 Markdown 文本粘贴时，若检测到 Markdown 结构（标题、列表、代码块、表格等），
按 Markdown 渲染成富文本再插入，而不是先压成纯文本段落。

实现放在 `lib/markdownInput.ts`（纯函数，含 vitest）+ `components/SlashMenu.tsx`，
`RichTextEditor` 只负责在 input / keydown / paste 时调用；IME 组词期间不转换。

## 3. 链接的两种显示形态

工具栏「插入链接」弹窗改成两种模式：

| 模式 | 产出 | 说明 |
| --- | --- | --- |
| 文字链接 | `<a href>` 行内 | 现有行为，选中文字可加链接 |
| 卡片链接 | `<a class="pp-linkcard" href><img class="pp-linkcard-cover"><strong>标题</strong><br><em>域名 · 说明</em></a>` | 独立区块，带封面、标题、说明 |

- 序列化：`lib/htmlToMarkdown.ts` 的区块选择器加入 `a.pp-linkcard`，存盘时原样保留 HTML；
  `lib/markdown.ts` 的原始 HTML 分支继续做白名单过滤。
- 清洗：`class` 与 `a[href]`、`img[src]` 都在安全白名单内，Go / Rust 侧无需改动。
- 卡片字段：网址、标题、说明、封面图（可空；空封面时用域名首字母占位，纯 CSS 实现）。
- 旧的「嵌入卡片」按钮保留（与卡片链接同款渲染，类名不同，向后兼容）。

## 4. 创作者扩展

**清单**（`types.ts` → `CustomExtension`，存在 `SiteCustomization.custom_extensions`）

```ts
{
  id, name, version, author, description, icon?,
  enabled, slots: ExtensionSlot[], pages: ExtensionPageScope[],
  permissions: ExtensionPermission[],
  html, css, js, created_at, updated_at
}
```

- 挂载位置：`site_header` / `site_footer` / `home_top` / `home_bottom` / `article_top` /
  `article_bottom` / `article_side` / `floating`。
- 运行方式：每个扩展一个 `<iframe sandbox="allow-scripts">`（不授予 `allow-same-origin`，
  因此是独立不透明源，拿不到主站 DOM、Cookie、localStorage），`srcdoc` 由宿主拼装：
  CSP `default-src 'none'` + 允许内联样式 / 脚本 + `img-src https: data:`；
  注入扩展的 CSS、HTML、JS 与 `window.PP` 受限桥。
- 桥 API（postMessage，宿主只接受来自该 iframe contentWindow 的消息）：
  `PP.context`（主题令牌、当前页面类型、内容标题）、`PP.notify`、`PP.open`、`PP.navigate`、
  `PP.copy`、`PP.setHeight`、`PP.storage.get/set`；未在 `permissions` 里声明的一律拒绝。
- 管理页 `/admin/extensions` 三个标签：内置扩展（现有 6 个开关）、我的扩展（启用 / 编辑 /
  复制 / 导出 / 删除）、扩展工坊（清单 + HTML/CSS/JS 编辑 + 实时沙箱预览 + 示例模板）。
- 导入：`.json` 清单文件或粘贴 JSON；`normalizeExtension` 校验 id / 槽位 / 页面 / 权限，
  HTML 80K、CSS 40K、JS 80K 上限，最多 20 个扩展；重复 id 覆盖前提示。
- 导出：单个扩展或全部扩展，文件名 `<name>.ppext.json`，可再导入到别的站点。
- 所有扩展管理需要 `manage_site` 能力；扩展只在站点前台运行，不进后台。

## 文件归属（并行开发时互不重叠）

| 范围 | 文件 |
| --- | --- |
| 共享模型（Lead） | `types.ts`、`lib/customize.ts`、`lib/covers.ts`、`styles.css` 的 4 行 @import、`styles/*.css` 文件本身 |
| 封面 | `components/Cover.tsx`、`components/ArticleCoverPanel.tsx`、`pages/admin/Editor.tsx`、`pages/admin/ContentList.tsx`、`pages/site/ContentDetail.tsx`、`components/blocks/{Classic,DataBlocks,Nightflight}.tsx`、`styles/covers.css` |
| Markdown + 链接卡片 | `components/RichTextEditor.tsx`、`components/EditorToolbar.tsx`、`components/SlashMenu.tsx`、`lib/markdownInput.ts`、`lib/richBlocks.ts`、`lib/htmlToMarkdown.ts`、`lib/markdown.ts`、`styles/{editorMarkdown,linkCards}.css` |
| 扩展 | `lib/extensions.ts`、`lib/extensionTemplates.ts`、`components/ExtensionRuntime.tsx`、`components/ExtensionHost.tsx`、`pages/admin/Extensions.tsx`、`components/SiteChrome.tsx`、`styles/extensions.css` |
| 验证 | `scripts/e2e-features.mjs`（新增）、现有 `smoke-logic.ts` 与 vitest |

## 测试

- 纯逻辑：`lib/markdownInput.test.ts`（前缀/行内/粘贴检测）、`lib/extensions.test.ts`
  （清单校验、导入导出、槽位与权限、srcdoc 拼装）、`styles` 消费名由 smoke-logic 兜底。
- 现有 `npm run typecheck`、`npm test`、`scripts/smoke-logic.ts`、`scripts/e2e-nightflight.mjs` 必须继续通过。
- 新增 `scripts/e2e-features.mjs`：演示模式下验证
  ① 创作页设置封面 → 文章详情 / 首页卡片出现自定义封面；
  ② 编辑器输入 Markdown 前缀 → 变成标题 / 列表，`/` 弹出指令面板；
  ③ 插入卡片链接 → 序列化为 `pp-linkcard`，预览出现卡片；
  ④ 扩展页导入示例扩展 → 前台出现沙箱 iframe；禁用后消失。

## 验证结果（2026-10-30 21:33）

| 验证项 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 error |
| `npx vitest run` | 24 文件 / 201 用例全过（新增 covers 25、markdownInput 12、htmlToMarkdown +6、extensions 21） |
| `scripts/smoke-logic.ts`（esbuild + node） | 162 ok / 0 FAIL（顺手修掉 5 条模板陈旧断言） |
| `npm run build` | 成功，182 modules（需把 TMP/TEMP 指到 `.tmp/eb`，见 README 构建注意） |
| `scripts/e2e-nightflight.mjs` | 36 ok / 0 FAIL / 1 既有 skip |
| `scripts/e2e-features.mjs` | PASS 43 / FAIL 0（A 封面 7、B Markdown 7、C 链接卡片 11、D 扩展 15） |

- 结论：四项功能在演示模式下全部走通（安装引导 → 创作 → 保存 → 前台渲染 → 扩展启用 / 禁用）。
- 实现口径：正文标题从二级开始，`# ` → 二级、`## ` → 三级、`### ` / `#### ` → 四级；e2e 按此映射断言。
- 截图：`docs/assets/2026-10-30-features/`（封面面板、前台封面、Markdown 标题、斜杠面板、
  卡片链接、扩展工坊、前台扩展）。

## 明确不做

- 不改 OpenAPI / Go / Rust：没有新端点、没有新白名单标签。
- 不做扩展市场、不做扩展签名 / 服务端分发、不做 zip 二进制包（清单 JSON 就够）。
- 不做 Markdown 源码分屏面板（用户选择的是编辑器内语法转换 + 斜杠指令）。
- 扩展不能注入主站 DOM、不能读登录态、不能加载远程脚本（CSP 限制）。
