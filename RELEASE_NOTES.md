# Practacu Press 0.1.2-beta 功能更新

> 本文件取代 `docs/releases/2026-11-16-beta-1.2.md` 与 `docs/releases/beta 1.2 release.md`。
> 记录范围：上一轮架构清理与版本口径统一、2026-11-21 的后台与编辑器功能，以及
> 2026-11-22 的日志合并、储存运行期与图形验证更新（见第五节）。

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

### 6. 新建主题固定从空白开始

- 「新建主题」不再提供「沿用当前主题」选项，始终按版式从空白/默认配色开始，不会把
  当前微调过的配色、字体与圆角带进新主题。本轮进一步改为不选择版式的真正空白主题，
  见「二、12」。
- 想保留当前配置时使用「保存为主题」；它明确是保存当前状态，不属于“新建空白主题”。

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

### 11. 打包脚本

- 根目录的 `打包.bat` / `启动.bat` 已下架并加入 `.gitignore`；打包入口统一为
  `scripts\package.ps1`，本机开发入口为 `scripts\dev.ps1`。参数与自检流程保持不变。

### 12. 空白主题与按主题独立的首页 / 文章页编排

- 「选择主题 → 创建主题」改为创建真正的空白主题：弹窗只保留名称与备注，不再询问单栏 /
  双栏或外观功能；主题记录不写配色、字体与版式，组件样式回落到内置「原版」主题，主题详情
  对应显示「未设置」。
- 首页与文章页编排改为按主题保存（`customization.theme_layouts`）：切换主题时整套编排跟着
  切换，切回来能恢复；新增、删除、导入主题都会带着自己的编排。自定义页面、导航与页脚仍是
  站点级。
- 新建的空白主题自带一份空白首页 / 文章页编排，创建后立即套用；旧设计文档没有按主题条目时
  沿用站点级编排，不需要迁移。
- 主题包导出会把空白主题具体化为默认主题样式与当前编排；导入后是一套显式的默认主题副本，
  不再恢复成「未设置」。
- 修复：开机水合不再把当前主题自己的编排投影写回站点级 `home` / `article`；此前切到
  没有自己编排的主题（原版、夜航、旧自定义主题）会显示空首页。各主题已保存的
  `theme_layouts` 条目不受影响。

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
powershell -ExecutionPolicy Bypass -File scripts\package.ps1 --skip-smoke --no-zip --no-pause
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

---

## 五、2026-11-22 更新：日志合并、储存运行期与图形验证

### 1. 网站日志合并，请求日志恢复显示

- 后台 `/admin/activity` 只保留一个面板、一张表：右上角用来源切换「网站日志 / 请求日志」，
  地址栏写入 `?source=request|audit`，刷新、分享与旧书签都能回到同一视图；两个来源各自保留
  筛选、分页、CSV 导出与计数，切换时不会互相污染。
- 请求日志此前打不开的根因：前端固定请求 `limit=200`，而服务端只接受 1–100，直接返回 400。
  新增 `REQUEST_LOG_LIMIT = 100`、`clampRequestLogLimit()` 与单测；页面按上限取数，超出时
  自动收敛，不再把参数错误伪装成“没有日志”。
- 审计表改为「时间 / 操作人 / 动作 / 目标 / 详情」；详情优先展示可读字段，跳过
  `request_id`、`*_id`、`*_token` 等技术键。请求表展示「时间 / 方法 / 路径 / 状态码 / 耗时 /
  请求号」，旧的 `ActivityOperations` 页面与词条删除。
- 「自动备份计划」从网站日志迁到「站点设置 → 数据与备份」，只对平台管理员可见、只读；
  网站日志不再显示与备份无关的部署卡片。

### 2. 储存策略保存即生效，多策略容量切换在服务端执行

- 新增 `GET/PUT /api/v1/system/storage`（平台管理员可写）。保存后写入
  `data/storage-settings.json`（0600、临时文件 + 原子重命名），API 进程立即换用新设置，
  无需重启；该文件优先于 `.env` 里的 `STORAGE_*`。启动时若文件损坏或策略无法构建，服务
  直接报错，不会静默回落到旧目录。
- 四个用途（文章媒体 / 站点图片 / 用户头像 / 用户数据与附件）各自支持：
  - `single`：只用第一套策略；
  - `quota`：按 `entries` 顺序写入，每套设置 `quota_gb`（0 表示不限），写满后按
    `overflow=switch` 切到下一套，或 `overflow=stop` 停止上传。
- 容量判断、条目选择、写入路由都在服务端完成。全部条目写满时上传返回 **507
  `storage_quota_exceeded`**，错误文案为“当前用途的储存空间已满，上传已停止”；读、删会先按
  当前分配查找，再回退到所有已构建策略，旧对象仍然可读。
- 状态接口返回每套策略的 `used_bytes` 与当前写入条目 `current`；Secret Key 与 Access Key
  只返回 `has_access_key` / `has_secret`，不回传值。页面在“立即应用”时可用一次性的
  `s3_secret_key` 提交新密钥，成功后立即从组件状态清空。
- 后台储存页改为服务端状态驱动：首次读取 `/system/storage` 时接管服务端策略与分配，保存后
  自动串行应用，显示已生效 / 待应用 / 构建失败、每用途服务端用量与“当前写入”标记；只改
  Secret 时按“立即应用”强制发送，不会被“设置签名未变”跳过。演示模式不会伪造用量或调用 PUT。
- 备份服务通过运行期 `MediaRootsProvider` 收集当前生效的本地媒体根；`/system/effective-config`
  增加 `storage_live` / `storage_source` / `storage_updated_at`，并覆盖运行期存储位置。

### 3. 本地图形验证

- 服务端随机数改为 `crypto/rand.Int` 拒绝采样，消除取模偏差；每次发题在“滑块 / 点选 / 选择”
  之间均匀抽取，并避免连续两次出现同一种题型（并发下由互斥锁保护）。
- 三类题面重绘：滑块增加渐变天空、山脊、草地、花与鸟；点选增加色块、磨砂面板、点阵与光环；
  选择增加卡片阴影、描边与高亮。顺带修复半透明描边写入 `image.RGBA` 时未预乘导致“浅色
  描边发黑”的问题。
- 前端卡片增加标题、题型提示、完成徽标、骨架屏、成功面板与进度条（`role=progressbar` /
  `aria-valuenow`）；支持暗色与 `prefers-reduced-motion`。坐标计算、容差与既有交互不变。

### 4. 仓库与文档整理

- README 截图从 `github/readme/` 迁到 `.github/readme/`，旧的 `github/` 目录删除；
  `README.md`、`README.en.md` 的图片链接同步更新。
- 根目录 `启动.bat` / `打包.bat` 不再入库（本地副本保留，已加入 `.gitignore`）。启动改用
  `scripts\dev.ps1` + `npm run dev`，打包统一用 `scripts\package.ps1`；README、web/README
  与脚本提示同步改写。
- 契约规模更新为 **159 条路径 / 191 个操作**（`openapi.yaml` 实测），后台 Docs 页与三份
  README 不再显示旧的 83/100 或 124/148。

### 5. 本轮验证

```powershell
gofmt -l cmd internal
go build ./...
go vet ./...
go test -count=1 ./...
cd web
cmd /c "npx.cmd tsc --noEmit"
cmd /c "npx.cmd vitest run"
cmd /c "npx.cmd vite build"
cd ..
node --test scripts/release-version.test.mjs
powershell -ExecutionPolicy Bypass -File scripts\verify.ps1
```

### 6. 本轮已知边界

- 储存策略切换只改变后续写入的路由；**已有文件不会自动搬家**。把某套策略从所有用途移除后，
  它上面的旧对象也不再通过 API 回退读取，需要先自行迁移。
- 用量按“策略目标”统计：同一套策略被多个用途共享时，各用途看到的是同一份用量，配额判断偏
  保守；配额是软上限，按对象写入前的大小判断，不做跨进程预留。
- 命令行维护工具（`cmd/media-gc`、`cmd/backup` 等）仍按 `.env` 构建存储，不读取后台保存的
  `data/storage-settings.json`；运行期热切换只覆盖 `cmd/server`。
- 本地图形验证未单独加限流；单题渲染约 28 ms，公开部署若担心刷题，建议在网关层面对
  `/captcha/local/challenge` 加频率限制。
- 请求日志是内存环形缓冲（最多 500 条，接口单次最多 100 条），进程重启后清空；需要长期留存
  请使用审计日志或外部日志采集。

---

## 六、弱密码确认与主题起点

### 1. 弱密码确认后保存

- 管理员密码、安装向导首个管理员、平台新建站点的初始管理员、管理员创建成员、用户注册、
  找回密码与登录用户自助改密，都允许输入不满足推荐强度的密码。
- 弱密码提交前先弹窗说明问题；用户点「仍然使用这个密码」后，前端重新提交并携带
  `confirm_weak_password: true`，服务端才接受。用户取消则只关闭弹窗，不写任何数据。
- 服务端硬边界不变：空密码、纯空白、超过 128 个码点即使确认也拒绝；未携带确认标志的弱密码
  仍按原 12 位/两类字符/常见口令规则拒绝。
- 新增 `auth.ValidatePasswordForCreation` 统一六个入口；OpenAPI 的注册、重置、改密、
  `NewMember` 与 `CreateSiteOwner` 都记录了 `confirm_weak_password`。演示后端同步了同一套
  行为，避免演示能建、线上建不了。

### 2. 新建主题始终空白

- 创建主题弹窗移除「沿用当前主题」，固定按版式取空白默认配色；「保存为主题」仍保留
  “保存当前配置”的语义。
- 新主题落库时不再读取当前主题的配色、字体或圆角。

### 3. 本轮验证

```powershell
go test -count=1 ./internal/auth ./internal/platformadmin ./internal/transport/http/gin
cd web
cmd /c "npx.cmd tsc --noEmit"
cmd /c "npx.cmd vitest run"
cmd /c "npx.cmd vite build"
cd ..
node --test scripts/release-version.test.mjs
powershell -ExecutionPolicy Bypass -File scripts\verify.ps1 -Task all
```

### 4. 本轮已知边界

- `confirm_weak_password` 记录的是用户意图，不是权限边界：它的作用是让服务端知道“用户看过
  警告并仍然选择这个密码”，不能替代账户安全策略。
- 弱密码的强度风险由确认者承担；已有历史弱密码继续可登录，不做强制迁移。

---

## 七、数据页两个小 tab、页面内恢复与用户组自锁

### 1. 数据与备份拆成两个 tab

- 「站点设置 → 数据与备份」顶部改为两个小 tab：「数据导入导出」与「备份」；`?tab=backup`
  可直接打开备份 tab，命令面板的备份 / 恢复 / 自动备份计划都跳到该地址。
- 「数据导入导出」里，全站导出与导出到 WordPress / Typecho 两张卡片并列，全站导入与从
  WordPress / Typecho 导入两张卡片并列；窄于 1100px 时自动堆叠。所有字段、冲突策略与逐条
  导入报告保持不变。
- 实例备份、自动备份计划与恢复都收进「备份」tab，不再和内容迁移混在同一列。

### 2. 页面内快速恢复 SQLite 备份

- 新增 `POST /api/v1/platform/backups/{backupID}/restore`。备份 tab 里可直接从下拉框选择
  一个 SQLite 备份，确认后恢复；不再需要停服执行命令行。
- 恢复前先校验 manifest、包内每个文件的 SHA-256 与表结构，再自动创建一份安全备份；随后用
  SQLite 在线备份 API 覆盖当前连接、重新应用增量 schema、恢复本地媒体并校验核心表。数据库
  写入失败时自动从安全备份回滚，响应里仍返回安全备份 id，便于人工重试。
- 只有平台管理员可以恢复，且**无条件**要求 `X-PP-Step-Up`：即使站点关闭了高威胁操作保护，
  也必须重新输入一次高危密码。前端用 `ensureStepUp(..., { fresh: true })` 强制重新验证，
  不复用本次浏览器会话里已有的令牌；站点管理员看到说明但按钮不可用。
- 仅支持 SQLite；MySQL / PostgreSQL 请继续使用 `mysqldump` / `pg_dump`。SQLite 连接池必须
  保持默认单连接，否则接口返回 422 `restore_unsupported`。恢复期间请勿关闭服务，恢复后当前
  登录会话可能因账户表被替换而失效，页面提供「重新加载页面」。

### 3. 管理员不能修改自己的用户组

- 站点管理员即使持有 `manage_permission`，也不能修改自己所在组的能力矩阵、后台入口或基础
  角色；改名仍然允许。服务端在保存前比对策略字段，命中时返回
  `403 permission_group_readonly`，避免「给自己提权」或「把自己锁在门外」。
- 前端同步锁定自己的组：能力单元格与后台入口开关禁用并说明原因，「恢复默认」跳过自己的组；
  平台管理员豁免，始终可以修复管理员组。
- 新增服务端测试覆盖自锁、改名放行与平台管理员豁免；前端新增
  `permissionGroupSelfLocked` 单测。

### 4. 本轮验证

```powershell
go test -count=1 ./internal/site ./internal/backup ./internal/infrastructure/db ./internal/transport/http/gin
cd web
cmd /c "npx.cmd tsc --noEmit"
cmd /c "npx.cmd vitest run"
cmd /c "npx.cmd vite build"
cd ..
powershell -ExecutionPolicy Bypass -File scripts\verify.ps1 -Task all
```

### 5. 本轮已知边界

- 页面内恢复只做 SQLite 在线覆盖；MySQL / PostgreSQL 没有同样的在线协议，仍由运维用原生
  dump 工具恢复。
- 回滚只覆盖数据库；若恢复已经替换了本地媒体，随后数据库回滚成功，媒体文件不会自动回退，
  需要从安全备份或原媒体目录人工恢复。
- 恢复会替换账户数据，当前 access token 可能仍能通过签名校验但找不到对应用户；重新加载后
  需要重新登录。

---

## 八、性能面板与数据页视觉改版（纸感仪表盘 v2）

两页保持既有纸感 / 石墨底座（serif 数字、16px 圆角、细线、克制投影），把信息重排成
「状态 → 指标 → 构成 → 明细 → 口径」五层；不改后端契约、不加依赖、不动其它页面。

### 1. 性能面板（`/admin/ext/system`）

- 页头从 5 枚并列徽标降到一个状态胶囊（实时 / 偏旧 / 过期 / 已暂停 + 采样时间 + 数据年龄）
  和一个刷新按钮；「由内置扩展注册」移到页脚脚注。
- 四张指标卡等高同构（`min-height: 268px`，标签 / 主数字 / 副行 / 脚注四段），第 4 张不再
  下半屏空白：仍显示站点运行时长，副行补上服务端真实的**主机运行时长**（`platform.uptime_seconds`）。
- 环形与占比条颜色改为由 `--accent` 经 `color-mix` 派生的单色族，删除全部硬编码色
  （`#b07a2a` / `#2f6f9a` / `#8a6d3b` / `#c9a468`）与对应的深色覆盖；90% 起「偏高」、
  95% 起危险色（`ringTone`，有单测）。
- 曲线加上面积填充、末点圆点、峰值超过 80% 时的告警虚线，图注改为
  「最近 N 秒 · 均 x% / 峰 y%」（新增 `sparklineStats` / `sparklineAreaPath`）。
- 「本软件 vs 其他软件」压成三行三段条 + 一行口径，删掉重复图例；「本软件磁盘占用」从进程
  面板里拆成独立的「数据目录占用」卡，与构成面板并排。
- 表格数字列右对齐 + `tabular-nums`，数量列用 `×N` 弱化；加载态换成四张与最终卡片同高的骨架卡。

### 2. 数据与备份（`/admin/data`）

- 数据导入导出分成「导出 / 导入」两组，卡片统一骨架：图标胶囊 + 标题 + 一句说明 + 底部分动作条，
  字段横排（`auto-fit` 网格），卡片高度约降三分之一；删除卡头裸图标与重复提示语。
- 备份 tab 新增健康条（最近备份 / 备份包数量与合计体积 / 自动计划），计划数据由
  `DataPage` 上提后与计划卡共用一次请求。
- 备份表格改为列表行：文件名（mono，中间省略）+ 时间 / 大小 / 是否含媒体 / 校验短哈希 +
  「下载」「恢复」；**恢复改为行内动作**，删掉下方独立的下拉选择器，复用原有二次确认弹窗与
  强制 `ensureStepUp(..., { fresh: true })`。
- 0 份备份时用 `EmptyState`（含「立即创建备份」），最近一份超过 7 天时健康条转 warn 并说明天数。
- 「从备份恢复」卡改为危险区样式（强调色左边条 + 危险色描边），只保留说明与恢复结果。

### 3. 工程侧

- 新增 `web/src/styles/dataAdmin.css`（`.dio-*` / `.bk-*` / 危险区），`.data-io-grid` 从
  `styles.css` 迁入；新增 `web/src/lib/backupHealth.ts`（最近备份 / 合计体积 / 过期天数 /
  色调）与单测。
- 新增文案全部走 `t()`，英文写进 `features_systemMonitor.ts`、`pages_admin_Data.ts`；
  `coverage.test.ts` 闸门通过。

### 4. 站点运行时长 = 软件累计运行时长

- 第 4 张卡不再拿 `site.created_at` 冒充运行时长：API 新增 `app.uptime_seconds`（本次进程）
  与 `app.total_uptime_seconds`（跨启停累计）。前端大数字取累计值，脚注显示「本次启动 X ·
  主机已运行 Y」；旧后端缺字段时显示 `—`。
- `internal/system/uptime.go`：启动时读 `<data>/runtime/uptime.json` 的累计秒数，运行期间按
  单调时钟往上加，每 60 秒原子落盘（临时文件 + rename），`Sampler` 在 `ctx.Done()` 时补一次
  flush。崩溃最多丢 60 秒；数据目录重建后从 0 开始；状态文件不进备份包，恢复旧备份不会回退。
- `PP_SYSTEM_METRICS=off` 期间不统计；`data` 目录不可用时退化为内存计数。
- 契约与类型同步：`openapi.yaml` 的 `SystemMetrics.app` 与 `web/src/types.ts` 增加两个字段。

### 5. 本轮验证

```powershell
go build ./...
go vet ./...
go test -count=1 ./internal/system/... ./internal/transport/http/gin/... ./internal/packages/contracts/openapi/...
cd web
cmd /c "npx.cmd tsc --noEmit"
cmd /c "npx.cmd vitest run"
cmd /c "npx.cmd vite build"
```

### 6. 本轮已知边界

- 只改前端：接口、SQLite 快照与恢复语义完全未变；备份健康条是既有数据的重新表达，
  没有新增「备份过期」的告警推送。
- 恢复入口从下拉框改为列表行内按钮，操作路径变化：没有 SQLite 备份时不再出现「可恢复」提示，
  而是整块只显示说明。
- 环形配色跟随站点强调色，因此不同站点会看到不同色相（同一站点的三环始终是同一色系）。
- 累计运行时长是实例级、单写者假设：多个 API 进程共用同一个 data 目录时以最后写入者为准；
  上线前的历史运行时间无法补算。
