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

### 7. 后台搜索：修复 + 以后新增功能也不会漏

- 修复：命令面板此前被无条件挂载，进入后台就直接弹出；“现在只在打开时渲染，并有回归测试锁定
  默认关闭 / Ctrl+K 开关 / 权限过滤 / 搜索后跳转。
- 索引从“页面级导航”扩到 110 条具体功能（回收站、sitemap、robots、CORS、S3、备份、OAuth、
  订阅者、操作日志、平台总览等），带权限过滤、中文原文关键词（英文界面可输中文搜索）。
- 选中后跳到对应页面并滚动到匹配区块短暂高亮；异步渲染的页面会重试定位。
- 新增路由覆盖测试：直接解析 `App.tsx` 的 `/admin` 子路由，新增后台页面没有登记索引时测试失败，
  并提示补 `ADMIN_FEATURE_INDEX` 或说明原因加入白名单——以后加功能不会悄悄搜不到。

### 8. 「访问洞察」并入「访问记录」

- 仪表盘「访问记录」卡片右上角新增「更多」，弹窗展示完整的访问洞察（时间范围、来源、设备、
  来源主机 Top、留存）。
- 侧栏移除独立的「访问洞察」入口；`/admin/insights` 重定向到 `/admin?insights=1` 并自动打开弹窗，
  旧书签仍可用；关闭弹窗时清掉该参数，其他 query 保留。
- 命令面板里的访问统计/来源/设备/留存条目改为指向 `?insights=1`，点击直接打开弹窗。

### 9. 下拉菜单入场动画

- 站点导航的二级下拉菜单改为从上到下淡入（`translateY(-6px)` → `0`），
  `prefers-reduced-motion: reduce` 下关闭动画。

### 10. 已写入表格的修改与设置

- 光标进入富文本表格时出现「表格工具」条：上方/下方插入行、左侧/右侧插入列、删除当前行/
  当前列、切换表头、左/中/右对齐、删除表格。
- 合并单元格、单行、单列等边界会安全禁用对应按钮；分栏与图集这类“用表格排版”的区块不显示
  工具条；操作后光标留在原单元格并立即保存。
- 对齐只写 `pp-align-left|center|right` class（服务端白名单保留），不依赖会被清洗掉的行内样式。

### 11. 一键打包脚本

- `打包.bat` 支持 `--arch amd64|arm64`、`--skip-smoke`、`--no-zip`、`--release-dir`、`--port`、
  `--no-pause`、`--help`，并原样透传 PowerShell 参数；失败保留窗口并返回真实退出码，成功打印
  `release\PractacuPress` 与 zip 路径。双击仍是原来的“一条命令出包”。

## 三、验证

```powershell
go build ./...
go test ./...
cd web
cmd /c "npm run typecheck"
cmd /c "npm test"
cmd /c "npm run build"
cd ..
node --test scripts/release-version.test.mjs
powershell -ExecutionPolicy Bypass -File scripts\verify.ps1
.\打包.bat --skip-smoke --no-zip --no-pause
```

## 四、已知边界

- `docs/` 目录仍按仓库策略不入库（`.gitignore`），设计/审计类文档只保留在本地。
- 后台搜索只覆盖后台路由与动作，不检索文章、成员等内容数据；新增页面由路由覆盖测试把关，
  新增“页面里的细节功能”仍需在 `ADMIN_FEATURE_INDEX` 补一条（否则只能搜到页面本身）。
- 折叠文本的展开状态由 `open` 属性决定，读者点击也能展开；服务端不保存前端展开状态。
- 下拉动画只覆盖自绘菜单（站点导航二级菜单）；后台 `Select` 是原生 `<select>`，选项列表由
  操作系统绘制，CSS 无法驱动其出现动画。
- 表格工具条不支持列宽拖拽：列宽无法可靠写回 Markdown/HTML 白名单；合并单元格时增删行列
  会安全禁用。
