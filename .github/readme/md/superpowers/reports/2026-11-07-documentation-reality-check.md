# 当前实现与文档差异（2026-11-07 复核）

**目的：** 在补全 P1/P2 基础缺口的同时，把文档、后台「调用接口」页与代码现实对齐。本文只记录
可复核的事实，不把计划、演示数据或前端本地策略写成服务端能力。

## 1. 契约规模

以仓库中的 `packages/contracts/openapi/openapi.yaml` 为准：

| 指标 | 当前值 | 核对方式 |
| --- | --- | --- |
| 路径数 | **83** | 统计 `paths:` 下的顶层路径键（无重复） |
| 操作数 | **100** | 统计 GET 42 / POST 43 / PATCH 10 / PUT 2 / DELETE 3 |
| 契约版本 | OpenAPI 3.1.0 / API 0.1.0 | `info.version` |

复算命令（PowerShell，仓库根目录）：

```powershell
$lines = Get-Content packages/contracts/openapi/openapi.yaml
$inPaths = $false; $paths = @(); $ops = 0
foreach ($l in $lines) {
  if ($l -match '^paths:\s*$') { $inPaths = $true; continue }
  if ($inPaths -and $l -match '^\S') { $inPaths = $false }
  if ($inPaths -and $l -match '^  (/[^:]+):\s*$') { $paths += $Matches[1] }
  if ($inPaths -and $l -match '^\s{4}(get|post|put|patch|delete|head|options|trace):\s*$') { $ops++ }
}
"paths=$($paths.Count) operations=$ops"
```

契约测试会同时检查两个方向：服务端注册的每条路由都必须在契约里（运维页 `/api/v1/docs` 等
显式豁免），契约里的每条路由也必须有服务端实现。见
`apps/api/internal/transport/http/gin/openapi_contract_test.go`。

## 2. 旧文档里已过时的结论

| 旧结论 | 当前事实 | 证据 |
| --- | --- | --- |
| README 写 51 条路径 / 64 个操作 | 当前 83 条路径 / 100 个操作 | 上文统计脚本 |
| 举报没有 handler | `/reports` 全套已存在：提交、队列、认领、结案 | `apps/api/internal/moderation`、`apps/web/src/pages/admin/Reports.tsx` |
| 没有审计端点 | `GET /sites/{siteID}/audit-logs` 已存在，后台读服务端记录 | `apps/api/internal/audit`、`apps/web/src/pages/admin/Activity.tsx` |
| 邮箱验证未实现 | 注册后发验证邮件；`/auth/email/verify` 与 `/me/email/verification` 已接入 | `apps/api/internal/auth`、`apps/web/src/pages/site/VerifyEmail.tsx` |
| WebSocket 未启用 | 前端用一次性票据连接 `/ws`，断线用 `/events` 补偿，失败降级轮询 | `apps/web/src/lib/realtime.tsx`、`realtimeCore.ts` |
| sitemap / robots 只能手动放 | Go API 在站点根路径按 Host 输出 `/sitemap.xml` 与 `/robots.txt` | `router.go`、`sitefiles.go` |
| 没有 `/api/v1/docs` | 自托管参考页与 `openapi.json` 已内嵌 | `router.go`、`apidocs/` |
| 平台站点 / 多站点未落地 | `/platform/sites` 列表、新建、详情、进入、域名验证与交接令牌已存在 | `apps/api/internal/platformadmin`、`apps/web/src/pages/admin/Platform.tsx` |
| 内容只能读 `rendered_html`，编辑会空白覆盖 | 作者 / 审核者读取时返回 `source_body`；编辑器已支持已有稿件编辑与版本回滚 | `Content.source_body` 契约字段、`Editor.tsx` |
| 主题 / 页面 / 扩展只存在本地 | 站点设计通过 `GET/PUT /sites/{siteID}/customization` 同步，带 revision 乐观并发 | `customizationSync.ts`、契约 `SiteCustomization` |
| 注册关闭是纯前端策略 | `Site.registration_open` 已由服务端保存，关闭后注册接口返回 403 | `site/handler.go`、`Settings.tsx` |

## 3. 仍然存在的边界

- **站点形态与权限组**：`site_kind`、`permissions.ts` 仍是前端策略层；服务端按四级固定角色授权。
- **手机验证码 / 第三方登录**：只有配置记录与演示模拟，没有短信或 OAuth 端点。
- **作者字段**：内容列表与搜索不内嵌 `author` 对象，需要按 `author_id` 另取 `GET /users/{userID}`。
- **邮件通知**：找回密码与邮箱验证已发信；评论回复、审核结果等通知邮件模板未接入。
- **SEO**：标签由前端写入 `<head>`；不执行 JS 的抓取器只能看到 `index.html` 默认值。
- **多副本**：WebSocket 票据与 hub 在进程内存，限流按副本计数。
- **搜索**：只有 `q` / `kind` / `limit`，没有分页游标；实现是 LIKE，不是 FTS5。
- **未实现**：OAuth 适配器、短信验证码、前端 SDK 生成、MSI 安装包。
- **未实跑验证**：MySQL / PostgreSQL、S3 真实端点、Docker 镜像构建（开发机无相应环境）。

## 4. 已同步的文档

- 根目录 `README.md`、`README.en.md`：契约规模、邮件与 sitemap/robots 限制、报告入口。
- `docs/introduction.md`：中英文契约规模、现状与限制、报告入口。
- `apps/web/README.md`：注册开关、站点设计同步、实时通道、契约对齐与已知限制。
- `apps/web/src/pages/admin/Docs.tsx` 与 i18n 片段：端点表、按「已实现 / 仅演示 / 已知限制」
  重写的能力清单。
- `docs/specs/2026-10-21-practacu-press-functional-spec.md`：状态与第 9 章实现证据、汇总计数。

历史报告 [2026-10-20 交付状态报告](2026-10-20-delivery-status.md) 继续保留，但只作为当时的快照，
不再作为当前状态的依据。
