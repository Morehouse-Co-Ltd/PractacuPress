# pp 插件化实施路线图

- 日期：2026-11-10
- 配套设计：[2026-11-10-pp-plugin-architecture.md](../design/2026-11-10-pp-plugin-architecture.md)
- 目标：把已通过 spike 验证的机制，按“可运维、可回滚、可审计”的顺序落成产品能力。
- 非目标（P1 不做）：插件市场、任意 Go 原生热加载、前端路由覆盖、插件 DDL、跨站点插件数据共享。

## 里程碑与出口条件

| 里程碑 | 主题 | 估算 | 出口条件 |
|---|---|---|---|
| P0 | 可行性 spike | 已完成 | 服务端 WASM + 路由 + 钩子 + 契约；前端加载 + 槽位 + 区块；测试全绿 |
| P1 | 最小可用闭环 | 3–5 周 | 管理员能安装/启用/禁用/卸载一个官方示例插件；前台出现槽位与区块；插件路由与契约可见；基础契约测试不变 |
| P2 | 第三方安全插件 | 6–8 周 | 签名插件可安装；能力同意；KV/HTTP/设置可用；审计/限流/指标；失败自动禁用；多站点隔离测试 |
| P3 | 生态与深度集成 | 8–12 周 | 市场/索引；T3 进程插件；主题/路由注册；插件迁移框架；兼容矩阵 CI |

估算按 1 名熟悉仓库的工程师计；并行可压缩，但不建议压缩安全/契约评审。

## P1 工作流

### W1. 插件包与状态（5–7 人日）

- 定义 `data/plugins/` 布局：`<id>/<version>/plugin.json`、`frontend/`、`backend/`、`README.md`。
- 状态存储：新增 `plugin_installations` 表（id, version, state, enabled, installed_at, last_error, manifest_hash, site_scope）或 `state.json`（单站点先用文件，多站点必须进 DB）。
- 安装器：目录/zip → 校验清单 → 校验哈希 → 写入不可变版本目录 → 记录；拒绝符号链接/路径穿越/超大包。
- 卸载/回滚：保留上一版本；卸载前 drain；清 KV 需二次确认。
- 校验：复用 `apps/api/internal/plugins/manifest.go`；补 `manifest_hash` 与包级 SHA-256。

验收：坏包/越权包/版本不兼容包都被拒绝；好包安装后 `GET /api/v1/admin/plugins` 可见。

### W2. 宿主接入与生命周期（6–8 人日）

- `cmd/server`：配置项 `PP_PLUGINS_ENABLED`、`PP_PLUGINS_DIR`、`PP_PLUGINS_SAFE_MODE`；启动时加载已启用插件；失败降级为可选。
- 管理 API：`GET /api/v1/admin/plugins`、`POST .../{id}/enable|disable|uninstall|retry`，仅 `site_admin`/`platform_admin`。
- 生命周期：install/enable/disable/remove + `failed` + `last_error`；drain 在途请求；每插件 runtime 关闭。
- 安全模式：启动失败时提示并允许“以安全模式重启”。
- 审计：所有变更写 `audit`（动作、插件 id、版本、权限、操作者、request_id）。

验收：启用→前台生效；禁用→路由/钩子/前端记录全部消失；卸载→目录与状态清理；安全模式可启动。

### W3. T2 能力 v1（6–8 人日）

- `content.render` 接入真实内容管线：文章/页面 HTML 输出前调用 `Host.TransformHTML`；失败跳过并记录；输出再过 `services/security` 扫描。
- 插件路由接入：`/api/v1/plugins/{id}/*` + `/plugins/{id}/{version}/*`；限流 60 req/min/插件/站点；请求/响应头白名单；body/响应大小上限。
- 站点 KV：`plugin_kv(site_id, plugin_id, key, value, expires_at)` + 宿主 API（只对 WASM 未来 ABI 开放；P1 可先不开放，只留表）。
- 设置：清单 `settings_schema` → 管理页自动表单 → 存储在站点配置的 `plugins[id].settings`，校验后注入插件。
- 失败策略：连续 5 次错误自动 `failed`；管理页一键重试/禁用。

验收：参考插件 `content.render` 在真实文章页生效；插件路由 401/403/200 正确；超时 502；HTML 被安全服务扫描。

### W4. T1 前端挂载（5–7 人日）

- 在 `App.tsx` 用 feature flag 挂 `defaultPluginRuntime.start()`；失败只告警，不影响站点。
- 先开放槽位：`site.header`、`site.footer`、`article.after`、`admin.settings`。
- 把 `PluginSlot` 接到 `SiteChrome`、`ContentDetailPage`、`AdminShell` 的对应位置；`blockRendererFor` 已接入 `BlockView`。
- 前端 bundle 构建模板：esbuild `--format=cjs --external:react --external:react-dom ...` + 注册 footer；给 `create-pp-plugin` 用。
- 卸载/切换站点时 `runtime.dispose()`；避免 HMR/StrictMode 重复激活。
- 主题 token：把当前 CSS 变量以只读对象注入 `ctx.theme`（P1 只读；注册新 token 放 P2）。

验收：启用示例插件后前台出现页脚/文章后槽位与自定义区块；禁用后 DOM 干净；控制台无 React 双实例警告。

### W5. 契约与 SDK（4–6 人日）

- `/api/v1/openapi.json` 返回组合文档；管理页可查看“本插件贡献的 path”。
- CI 新增组合契约测试：启用测试插件 → 组合文档 ↔ 实际路由双向一致；冲突 path 必须失败。
- `packages/plugin-sdk`：TypeScript 清单/上下文/模块类型；Go `pluginabi` 包（请求/响应结构、常量）；版本号与契约版本对齐。
- 文档：清单字段表、权限表、Hook 表、bundle 构建、调试、发布检查清单。
- 兼容性：`engines.pp`/`engines.contract` 检查；安装页展示不兼容原因。

验收：新增插件路由不改基础 YAML 也能被 `/api/v1/openapi.json` 与 docs 页看到；契约测试全绿；SDK 能被示例插件引用。

### W6. 安全与运维（4–6 人日，与 W2/W3 并行）

- 权限同意页：安装前展示权限、发布者、哈希；升级新增权限必须重新同意。
- 签名：先支持 `sha256` 清单 + 可选 Sigstore；没有签名的包默认只能装到“开发者模式”。
- 审计/指标：插件安装/启停/路由调用/超时/错误；管理页展示最近错误。
- 安全模式、批量禁用、日志导出。
- 跨站隔离测试：A 站启用插件，B 站不可见；A 站 KV 不被 B 站读到；插件路由的 `site_id` 不可伪造。

验收：安全评审通过；渗透测试用例（路径穿越、头注入、超大响应、超时、越权、跨站）全绿。

## P2 工作流（摘要）

1. **WASM ABI v2**：`kv_get/kv_set`、`http_fetch`（域名 allowlist）、`settings_get`、`log`、`now`；按能力注入；ABI 版本协商。
2. **声明式 collection**：`plugin_collections` 宿主建表/迁移；插件只能 CRUD 自己的命名空间；导出/备份策略。
3. **签名与发布**：Sigstore/cosign、SBOM、发布者账户、版本撤回（yank）。
4. **可观测**：每插件 QPS/P95/错误率/超时/Hook 耗时；告警阈值；管理页图表。
5. **失败自愈**：连续失败自动禁用 + 通知；半开重试；drain 超时。
6. **多站点**：`plugin_site_enablement` 表；按站点设置；平台管理员跨站视图；缓存按站点 key。
7. **前端扩展**：主题 token 注册、设置页注册、编辑器工具槽位；路由注册表设计评审（冲突/守卫/404 优先级）后再开。
8. **兼容矩阵 CI**：最近 3 个宿主版本 × 官方插件；契约 v1/v2 并行。

## P3 工作流（摘要）

- 插件市场/索引、审核流程、评分/举报、官方认证。
- T3 原生进程插件：proto、健康检查、崩溃重启、资源限制、日志聚合；或编译期 native registry 正式 API。
- 插件级 DB 迁移框架：白名单、备份、回滚、dry-run。
- 主题/布局注册表、页面模板、前端路由覆盖（带 `ui.override` 权限与冲突策略）。
- 兼容性承诺与弃用政策：契约 major、插件 API major、至少 N 个版本的并行支持。

## 测试门禁（每个 PR）

```powershell
# Go
go build ./...
go vet ./...
go test ./apps/api/internal/plugins/... -count=1
go test ./apps/api/internal/transport/http/gin/ -count=1

# Web
cd apps/web
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run
```

新增门禁：

- 组合契约测试（启用/禁用插件）；
- 权限负向测试（未声明 slot/block/route/hook 必须失败）；
- 路径穿越/头注入/超大响应/超时；
- 跨站隔离测试；
- 插件卸载后无残留（路由、槽位、样式、定时器）。

## 决策点

| 时点 | 决策 | 建议 |
|---|---|---|
| P1 开始前 | 第三方插件是否允许 T1（同源代码） | 先只允许官方/签名插件；不可信 UI 留在 T0 |
| P1 结束 | 是否开放插件路由给第三方 | 先官方；P2 加签名/限流/审计后再开放 |
| P2 中 | 是否支持前端路由 | 先设计冲突/守卫；没有把握就继续用槽位+区块 |
| P2 结束 | 是否做市场 | 先有签名、审计、回滚、兼容矩阵，再做市场 |
| P3 | 是否做 Go 原生插件 | 优先独立进程；`.so` 方案不采纳 |

## 第一批具体任务（可直接开工）

1. 新增 `apps/api/internal/plugins/store.go` + Ent schema `PluginInstallation`（或先文件状态），实现安装/启用/禁用/卸载。
2. `cmd/server` 读取 `PP_PLUGINS_*`，构造 `plugins.Host`，传入 `ginrouter.Dependencies`；启动失败降级。
3. `ginrouter` 增加管理路由 `GET/POST /api/v1/admin/plugins...`，写审计。
4. 内容管线接 `TransformHTML`（文章/页面），输出过 Rust 安全扫描。
5. `App.tsx` feature flag 挂 `PluginRuntime`，接 4 个槽位。
6. `packages/plugin-sdk` 初版 + `create-pp-plugin` 模板（esbuild 脚本 + 注册 footer）。
7. 组合契约 CI 测试 + 权限负向测试。
8. 管理页“插件”Tab：列表/状态/权限/启停/卸载/错误。
