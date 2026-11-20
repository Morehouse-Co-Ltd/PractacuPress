# Practacu Press 0.1.2-beta 功能更新

> 本文件取代 `docs/releases/2026-11-16-beta-1.2.md` 与 `docs/releases/beta 1.2 release.md`。
> 记录范围：上一轮架构清理与版本口径统一，以及 2026-11-21 这一轮的后台与编辑器功能。

## 版本口径

只有两种版本，比较一律使用整数 `version_code`，字符串只用于展示与生成 tag：

| 通道 | 格式 | 示例 | version_code |
| --- | --- | --- | --- |
| 稳定版 | `MAJOR.MINOR.PATCH` | `0.1.2` | `10299` |
| 测试版 | `MAJOR.MINOR.PATCH-beta[.N]` | `0.1.2-beta`、`0.1.2-beta.2` | `10201`、`10202` |

```
version_code = MAJOR*1_000_000 + MINOR*10_000 + PATCH*100 + STAGE
STAGE = 99（稳定版） | N（测试版序号 1..98）
```

当前构建：`0.1.2-beta`（`version_code: 10201`），来源 `web/public/version.json`，
`web/package.json` 必须与它一致（`appVersion.test.ts` 把关）。

三份实现必须同步修改：

- `internal/version/`（Go）
- `web/src/lib/version.ts`（前端）
- `scripts/lib/version.mjs`（发布脚本）

发布链路（`.github/workflows/release.yml`、`deploy/docker/api.Dockerfile`、三个
`package-*.mjs`）都在 `npm run build` **之前**写版本清单，保证 Vite 内联的版本与
站点 `/version.json` 一致。

## 一、上一轮的架构清理

- 删除启动器与外部 Rust/gRPC 安全服务的全部残留：systemd 单元、nginx 注释、迁移脚本
  注释、Go 注释、OpenAPI 描述、前端“启动器/安全服务”文案。
- 安装向导移除已经不可达的启动器分支；系统监控只保留服务端真实会返回的进程角色。
- 文档与 README 中指向已删除 `docs/` 的引用改为真实存在的路径。

## 二、本轮新增功能

### 1. 后台功能搜索（Ctrl/Cmd+K）

- 顶栏新增搜索入口，弹层内输入即可过滤后台全部导航项与设置子页、扩展页。
- `↑` / `↓` 选择、`Enter` 打开、`Esc` 关闭；支持鼠标。
- 过滤逻辑在 `web/src/lib/adminSearch.ts`（有单测）：前缀优先、包含其后，匹配当前语言
  文案、中文原文与路由。

### 2. 编辑器提示 / 警告卡片

- 富文本工具栏与 `/` 菜单新增「提示卡片」「警告卡片」，写入
  `<blockquote class="pp-note pp-note-info|warn">`。
- 已有 `.pp-note` 样式扩展出 info / warn / ok 三种色调；服务端白名单保留 `pp-` 类名。

### 3. 折叠文本

- 富文本工具栏与 `/` 菜单新增「折叠文本」，写入
  `<details class="pp-collapse"><summary>标题</summary><p>正文</p></details>`。
- 服务端清洗白名单新增 `details` / `summary` 标签与 `open` 属性（仅 details），
  goldmark 的 `WithUnsafe` 让 Markdown 里的这段 HTML 原样进入清洗流程。
- HTML ↔ Markdown 序列化把 `details.pp-collapse` 当作整体区块保留，不会拆成段落丢失。

### 4. 源码模式快捷输入与代码索引

- HTML 与 Markdown 源码框上方各有一条快捷插入栏：提示、警告、折叠、引用、代码块。
- 两个源码框共用带行号的编辑器：行号随输入更新、与滚动同步、当前行高亮；
  行号不进入复制内容，Tab 与快捷键行为不变。

### 5. 权限页与下拉框样式

- 能力矩阵表头的用户组名称编辑改为内联编辑卡片（标签、自适应输入框、保存/取消、
  保存中禁用态），Enter 保存 / Esc 取消行为不变。
- 全局 `.select` / `.select-wrap` 统一高度、圆角、边框、chevron 与 focus-visible 状态，
  亮色与暗色后台同步适配。

### 6. 新建主题默认空白

- 「新建主题」默认从空白主题开始，不再默认复制当前主题；其余字段（名称、说明、版式、
  分区）保持不变。

## 三、验证

```powershell
go build ./...
go test ./internal/security/ ./internal/content/ ./internal/version/
cd web
cmd /c "npm run typecheck"
cmd /c "npm test"
npm run build
node --test scripts/release-version.test.mjs
```

## 四、已知边界

- `docs/` 目录仍按仓库策略不入库（`.gitignore`），设计/审计类文档只保留在本地。
- 后台搜索只覆盖后台路由与动作，不检索文章、成员等内容数据。
- 折叠文本的展开状态由 `open` 属性决定，读者点击也能展开；服务端不保存前端展开状态。
