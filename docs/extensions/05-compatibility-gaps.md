# 05 · 版本、兼容与现状差距

- 上级文档：[README.md](README.md)
- 相关：[02-manifest.md](02-manifest.md)（字段与 range 语法） · [04-backend-api.md](04-backend-api.md)（契约合并） · [06-install-and-package.md](06-install-and-package.md)（当前产品化落地）
- 本文回答两个问题：**插件怎么与宿主版本对齐**；**哪些设计文档里的能力其实还没有代码**。

> **2026-11-13 更新**：T1（前端扩展）与 T2（WASM 后端扩展）已经从 spike 接入产品
> （`cmd/server` 构造宿主与扩展管理器、`App.tsx` 启动前端运行时、后台可导入 zip）。
> 本文 §4 的「未实现」清单里与安装/启动相关的条目已经过时，请以
> [06-install-and-package.md](06-install-and-package.md) 为准；其余关于版本轴和 ABI
> 细节的描述仍然有效。

## 1. 五个独立的版本轴

| 版本轴 | 出现在哪里 | 谁校验 | 当前值/取值 |
| --- | --- | --- | --- |
| `manifest_version` | `plugin.json` 顶层 | `ValidateManifest` | 只能 `1` |
| `engines.pp` | `plugin.json` | `Host.Install` 对比 `Options.HostVersion` | 必填 range；参考插件 `>=0.1.0 <1.0.0` |
| `engines.contract` | `plugin.json` | `Host.Install` 对比 `Options.ContractVersion` | 可选 range；参考插件 `>=1.0.0 <2.0.0` |
| `backend.abi` | `plugin.json` | `validateBackend` | 只能 `"wasi-json-v1"` |
| OpenAPI 契约版本 | `packages/contracts/openapi/openapi.yaml` 的 `info.version` | 只用于文档/生成；**运行时不读取** | 当前 `0.1.0` |

**重要不一致**：参考插件与设计文档要求 `engines.contract >=1.0.0 <2.0.0`，但仓库内嵌契约的 `info.version` 是 `0.1.0`。测试里把 `Options.ContractVersion` 硬编码成 `"1.0.0"` 才让参考插件通过安装。也就是说：

- 「契约版本」目前是**调用方传给宿主的字符串**，不是从 `openapi.yaml` 推导的；
- 如果生产把 `info.version`（`0.1.0`）传进去，参考插件会被拒绝安装；
- 如果生产不传 `ContractVersion`，检查被跳过，`engines.contract` 形同虚设。

这是**契约版本轴尚未产品化**的直接证据，已列入 §4 的 C1/C3。

## 2. 版本匹配规则

### 2.1 `engines.pp` / `engines.contract`

使用宿主自带的极简 semver range（完整语法与示例见 [02-manifest.md §11](02-manifest.md#11-semver-range-语法)）：

- 支持 `=`、`>`、`>=`、`<`、`<=`、`^`、`~`，多个约束 AND；
- 不支持 `*`、`x`、连字符范围、`||`、缺省补全；
- 版本必须是 `major.minor.patch`；prerelease/build 在比较时被剥掉；
- 安装时检查；`Enable` 不再检查；
- 宿主版本/契约版本为空时跳过检查（测试/工具模式）。

### 2.2 `manifest_version`

宿主只认 `1`。新增字段/改变语义必须提升 `manifest_version`，并在 `ValidateManifest` 里显式支持旧版；当前没有多版本分支。

### 2.3 `backend.abi`

只有 `wasi-json-v1`。清单写其他值直接拒绝。ABI 的请求里也带 `"abi":"wasi-json-v1"`，但宿主不读取插件的 `abi` 回执/协商结果；没有 v2 协商机制。

### 2.4 前端 bundle 版本

`PluginRuntime.activate` 要求 `__PP_PLUGIN_REGISTER__` 注册的 version **与清单完全一致**；资产 URL 也带版本（`/plugins/{id}/{version}/...`），升级即换 URL，旧 URL 随清单版本变化自然失效。

## 3. 兼容承诺（设计目标）

来自设计与路线图，逐条标注实现情况：

| 承诺 | 设计文档 | 代码现状 |
| --- | --- | --- |
| 契约只允许加法（新增 path/operation/可选字段） | ✅ | 🟡 没有自动检测语义变更；只检测 path 冲突（C4） |
| 插件不能覆盖/删除宿主 operation | ✅ | ✅ 同路径冲突直接失败 |
| 破坏性变更走 `/api/v2` 并行 | ✅ | 🟡 没有 v2 路由/契约框架 |
| v1 禁止 `$ref`，v2 才允许命名空间组件 | ✅ | ✅ v1 已强制 |
| 权限只增不减；升级新增权限必须重新同意 | ✅ | 🟡 没有授权持久化、同意页、升级流程（H7） |
| `engines` 不满足直接拒绝 | ✅ | ✅（前提是调用方传版本） |
| 升级 = 新版本目录 + 原子切换；回滚 = 切回旧指针 | ✅ | 🟡 无安装目录/版本目录/指针（I4） |
| 插件不能改宿主中间件/鉴权/DB | ✅ | ✅ T2 无这些能力 |
| 安全扫描不可绕过 | ✅ | 🟡 没有接入（H4） |

## 4. 现状与差距清单

标记：**严重度** 高 = 影响安全或产品可用性；中 = 影响接入/运维；低 = 死代码/文档一致性。
**类别**：接入 / 安全 / 协议 / 前端 / 契约 / 死代码。

### A. 接入与产品化

| ID | 严重度 | 设计文档说法 | 代码事实 | 影响 | 证据 |
| --- | --- | --- | --- | --- | --- |
| I1 | 高 | 服务端宿主、boot manifest、插件路由、组合契约可用 | `cmd/server` 不 import `plugins`；`Dependencies.Plugins` 恒为 nil；只有测试构造 Host | 发行版没有 `/api/v1/plugins`、`/plugins/...`；`openapi.json` 只有基础契约 | `apps/api/internal/transport/http/gin/dependencies.go:117`；全仓库无 `plugins.New` 于 `cmd/` |
| I2 | 高 | 前端运行时挂到 App（feature flag） | `App.tsx` 不调用 `defaultPluginRuntime.start()`；产品页面不渲染 `<PluginSlot>` | 前端插件即使被启用也不会出现在页面 | `grep` 无 `PluginSlot` 产品用法，只有测试 |
| I3 | 高 | `content.render` 接真实内容管线 | 只有 `Host.TransformHTML` 方法与测试调用 | 文章的 HTML 不会被插件改写 | 全仓库 `TransformHTML` 仅测试 |
| I4 | 高 | 安装器、`data/plugins/<id>/<version>`、状态持久化、管理 API/页、按站点启停、回滚、安全模式、审计、drain | 只有内存态 `Host`；`Install(dir)` 直接吃任意目录；无表、无路由、无页面、无配置项 | 无法安装/运营插件；重启即丢状态 | `host.go` 无持久化；`config` 无 `PP_PLUGINS_*` |
| I5 | 中 | `content.after_create/update/delete` 事务提交后触发 | 只在 `knownHooks` 白名单；无派发代码 | 插件收不到内容生命周期事件 | `manifest.go:163`；无 `AfterCreate` 调用 |
| I6 | 中 | 创作者扩展迁移到 slot 适配层 | 无 `IframeSlot`；T0 与 T1 两套运行时 | 站点扩展与插件无法统一编排 | `ExtensionRuntime.tsx` 仍是 DOM 锚点 |

### B. 运行时与协议

| ID | 严重度 | 设计文档说法 | 代码事实 | 影响 | 证据 |
| --- | --- | --- | --- | --- | --- |
| H1 | 高 | 超时关闭 runtime；连续失败自动禁用、可重试 | 超时确实关闭 runtime，但 `State` 仍 enabled；`StateFailed`/`LastError` 从未赋值；`Enable` 不重建 runtime | 一次超时后该插件永久不可用，直到 `Remove`+`Install`；管理端看不到失败态 | `host.go:578-584`、`host.go:314`、`host.go:47` |
| H2 | 中 | 每插件路由 60 req/min（站点+插件+IP） | 只有 `Config.RateLimitPerMinute` 的全局 IP 限流；插件路由继承它 | 单个插件可耗尽全局限额；无法按插件隔离滥用 | `router.go:84`、`middleware/rate_limit.go` |
| H3 | 高 | 按站点启用、KV 按 site 隔离、跨站测试 | Host 是进程级单例，无 `site_id` 维度；`PublicPlugins` 返回所有启用项 | 多租户下 A 站插件对 B 站可见；无法做站点级授权 | `host.go:159`、`PublicPlugins` |
| H4 | 高 | 插件产生的 HTML 必须过 `services/security` | `TransformHTML` 原样返回；没有扫描调用 | 插件内容可绕过宿主清洗（接入后立即成为 XSS 面） | `host.go:438` |
| H5 | 高 | 产物哈希/签名/SBOM/市场审核 | 无签名字段、无哈希校验；`ManifestHash` 从不赋值 | 供应链只靠人工信任 | `host.go:99`、`Install` |
| H6 | 中 | 只暴露声明的 entry/styles | `AssetHandler` 服务整个 `frontend/` 目录（受后缀白名单限制）；`os.Stat` 跟随符号链接 | 未声明的文件也可被下载 | `host.go:797` |
| H7 | 高 | 权限同意、升级新增权限重新同意 | 无授权持久化/同意页/升级流程；每次 `Install` 从清单重读 | 无法实现「重新同意」；权限变更对用户不可见 | 无相关代码 |
| H8 | 中 | drain：停止新请求、等待在途、再关 runtime | `Disable/Remove` 用写锁等待在途调用，但没有超时/优雅停机/排空流程 | 长调用会阻塞管理操作；进程退出无 drain | `host.go:333`、`host.go:352` |
| H9 | 低 | 路由未声明方法应 405 | `v1.Any` + 精确匹配，未声明方法返回 404 | 客户端难以区分「路径不存在」与「方法不允许」 | `host.go:898`、`findRoute` |
| H10 | 高 | 响应头 `Location` 必须是站内相对路径 | 白名单用规范化键判断，但相对路径检查用**原始键名**比较，且只检查首字符 `/`；`location: https://evil` 与 `Location: //evil.com` 都能通过 | 插件可下发站外重定向（开放重定向/钓鱼面） | `host.go:776-784` |

### C. 契约与版本

| ID | 严重度 | 设计文档说法 | 代码事实 | 影响 | 证据 |
| --- | --- | --- | --- | --- | --- |
| C1 | 高 | `engines.contract` 与契约版本对齐 | `Options.ContractVersion` 由调用方给；内嵌契约 `info.version` 是 `0.1.0`；参考插件要求 `>=1.0.0` | 版本轴自相矛盾：按真实契约版本会拒绝参考插件；不传则跳过检查 | `openapi.yaml:4`、`host_test.go:22` |
| C2 | 中 | 组合文档写 `x-pp-contract-version` | 没有写入 | SDK/生成器无法按契约版本对齐 | `contract.go` 无该键 |
| C3 | 中 | 同路径冲突拒绝启用 | 只在 `ContractJSON()` 合成时失败；`Enable` 不预检 | 冲突要等到请求文档时才 500，且错误不回显插件 id | `contract.go:68` |
| C4 | 中 | 契约只允许加法 | 没有 operation 语义 diff；插件升级时可以对自己已发布的 `/plugins/{id}/...` operation 做破坏性 schema 变更，宿主不会发现 | 客户端按旧 schema 生成会静默失效；只能靠评审与 `engines.contract` 自觉 | 无 diff 代码 |
| C5 | 中 | 升级/回滚/版本目录 | 无升级/回滚；`Install` 同 id 直接拒绝 | 升级只能先 `Remove`（清 runtime）再装，且无文件版本管理 | `host.go:253` |

### D. 前端

| ID | 严重度 | 设计文档说法 | 代码事实 | 影响 | 证据 |
| --- | --- | --- | --- | --- | --- |
| F1 | 中 | 前端 `styles` 随 bundle 加载 | boot manifest 只返回 basename；`PluginRuntime` 不读 `manifest.styles` | 参考插件的 `client.css` 不生效；作者只能用 `ctx.ui.addStyle` | `host.go:411`、`runtime.ts:98` |
| F2 | 低 | 模块表含 `react/jsx-dev-runtime` | `runtime.ts` 的 `MODULE_TABLE` 只有 5 项；`types.ts` 常量多列了它 | 开发构建引用它会运行时抛错 | `types.ts:98` vs `runtime.ts:19` |
| F3 | 中 | P1 注入只读主题 token；P2 主题/设置/路由扩展 | `PluginContext` 没有 `theme` / `routes` / `settings` | 插件无法读主题、加页面、建设置页 | `types.ts:48` |
| F4 | 中 | 插件可注册区块并在编排器使用 | 渲染端支持；后台编排器只认静态 `blocks.ts` 定义 | 新区块类型无法在编辑器里插入 | `components/blocks/index.tsx`、`lib/blocks.ts` |
| F5 | 中 | 热加载/HMR；禁用后不刷新 | 注册表支持增量渲染；但没有 boot manifest 重拉/推送；`start()` 只能调用一次，失败不可重试 | 新启用插件不会出现在已打开页面；失败后需新实例 | `runtime.ts:98`、`runtime.ts:199` |
| F6 | 低 | 插件知道当前站点 | `ctx.site.id` 默认 `''`，需嵌入方传 `siteId` | 插件无法按站点取数据 | `runtime.ts:83` |
| F7 | 中 | SRI/哈希锁定 | `integrity` 可选；服务端不校验；无哈希安装 | 供应链校验只剩浏览器可选 SRI | `manifest.go:415`、`AssetHandler` |
| F8 | 低 | 插件状态可诊断 | 只有 `runtime.status()` + `console.error`；无管理页/遥测 | 线上排障困难 | `runtime.ts:282` |
| F9 | 低 | 插件不能覆盖内置区块 | 内置优先；但注册同名内置 type 不报错，只是永远不生效 | 作者会误以为覆盖成功（静默） | `registry.ts:136`、`blocks/index.tsx:254` |

### E. 死代码 / 字段与文档不一致

| ID | 严重度 | 现象 | 影响 | 证据 |
| --- | --- | --- | --- | --- |
| D1 | 低 | `PublicPlugin.ManifestHash` 有字段、永远为空 | boot manifest 无法做清单完整性校验 | `host.go:99` |
| D2 | 低 | `StateFailed` / `LastError` 从未赋值 | 失败态与管理端诊断是空的 | `host.go:47`、`host.go:71` |
| D3 | 低 | `findRoute` 的「空 method = GET」不可达（清单先拒绝空 method） | 协议描述容易误写「method 可省略」 | `manifest.go:325`、`host.go:903` |
| D4 | 低 | `settings_schema: null` 能通过解码，却让 `settings:true` | 空设置被误报为有设置 | `manifest.go:267`、`host.go:427` |
| D5 | 中 | 钩子返回 `{"ok":true,"result":{}}` 或 `result:null` 会把正文清空 | 插件 bug 可静默清空文章 HTML | `host.go:467` |
| D6 | 低 | 插件宿主的 problem 格式与平台 `apperr` 不同 | 客户端要兼容两套字段 | `host.go:967` vs `platform/errors` |
| D7 | 低 | `HookPayload.Extra` 从未填充；`content.read` 无 hook | 字段/权限是预留，不是能力 | `host.go:145`、`manifest.go:130` |
| D8 | 低 | `PublicPlugin.Styles` 是 basename 而非 URL | 前端无法直接按字段加载 | `host.go:413` |
| D9 | 低 | 参考插件 `go.mod` 写 `go 1.26` | 旧工具链无法构建参考插件 | `testdata/hello/backend/go.mod` |
| D10 | 低 | 没有 `packages/plugin-sdk` | 作者只能手写类型/ABI；路线图 W5 未开始 | `packages/` 下只有 `contracts` |

### F. 安全模型提醒（不是 bug，但必须写进产品文案）

| ID | 提醒 |
| --- | --- |
| S1 | T1 前端插件**不是沙箱**：同源脚本可读 DOM/Cookie/localStorage、发同源请求。权限检查只是组合守卫。 |
| S2 | T0 创作者扩展是唯一可自助的不可信 UI 通道；不要用 T1 替代。 |
| S3 | T2 WASM 是隔离边界，但 wazero/宿主函数仍可能有漏洞；高风险插件应独立进程/容器（设计文档建议）。 |
| S4 | 插件路由的鉴权由宿主完成；插件只能信 `payload.role`，不能信请求头。 |

## 5. 代码与设计文档冲突逐条对照

| # | 设计文档表述 | 代码事实 | 处理建议 |
| --- | --- | --- | --- |
| 1 | 「spike 已验证服务端 WASM、插件路由、契约合并」读起来像可用功能 | 全部只在测试/库层；生产入口未接 | 文档与发布说明明确写「P0，未接入」；接入前不要宣传 |
| 2 | 每插件路由独立限流，默认 60 req/min | 只有全局 IP 限流 | 接入前补 per-plugin bucket；否则删掉该承诺 |
| 3 | 同路径冲突拒绝启用 | 合成时才失败，且 `/openapi.json` 返回 500 | 在 `Enable` 调 `ContractJSON` 预检，失败则拒绝启用 |
| 4 | 组合文档写 `x-pp-contract-version` | 未写 | 要么实现，要么从文档删除 |
| 5 | `content.after_*` 事务提交后 fire-and-forget | 无派发 | 要么实现派发（含输入 schema），要么从清单白名单移除 |
| 6 | `settings_schema` → 管理页表单 → 注入插件 | 只存 schema；无表单/读写/注入 | 标为 P2；当前不要把它写成可用能力 |
| 7 | P1 注入只读主题 token | `ctx` 无 `theme` | 与 6 一起标为未实现 |
| 8 | 连续 5 次错误自动 `failed`，一键重试 | 无计数、无 failed、无重试 | 与 H1 一起修 |
| 9 | 插件 HTML 必须过 Rust 安全服务 | 无扫描 | 接入内容管线时同步加；否则不要上线 T2 |
| 10 | 安装目录 `data/plugins/<id>/<version>`、`state.json` | `Install` 接受任意目录，内存态 | P1 W1 实现；当前文档写「开发者可直接 `Host.Install(dir)`」 |
| 11 | 前端 feature flag `plugins_enabled`、4 个先行槽位 | 无 flag、无锚点 | 接入时补 |
| 12 | 升级新增权限重新同意 | 无同意/升级机制 | 先实现授权记录再做市场 |
| 13 | 契约版本 `engines.contract` | 与真实 `info.version: 0.1.0` 不一致；测试硬编码 `1.0.0` | 定义并实现「契约版本」来源（建议独立常量，不用 `info.version`） |
| 14 | T2 可热加载/卸载 | 库层 enable/disable 可用，但无进程接入、无 HMR、超时后死 | 限定为「库层可启停；产品热加载未实现」 |
| 15 | 安全模式 `PP_PLUGINS_SAFE_MODE` | 无配置项 | P1 实现 |
| 16 | T3 原生插件 | 只有设计 | 标为 💭 |
| 17 | 契约只允许加法 | 宿主无法检测同一 operation 的语义变更（只检测 path 冲突） | 把「不改已有 operation 语义」写进发布评审；长期需要契约 diff 工具 |

## 6. 未完成工作清单（按优先级）

### P1（接产品前必须）

1. `cmd/server` 构造 `plugins.Host`，传入真实 `HostVersion` 与**明确来源**的 `ContractVersion`；关闭时 `Close()`。
2. 内容管线接 `TransformHTML`，输出过 `services/security`；失败告警。
3. 决定 `content.after_*`：实现派发或从白名单删除。
4. 安装/启停/卸载的管理 API + 持久化 + 审计；按站点启用。
5. 前端接 `App.tsx`：`start()`、4 个槽位锚点、`siteId`。
6. 修复超时后的死实例：失败计数 + 自动禁用 + 重建 runtime。
7. 契约冲突在 `Enable` 预检；补 `x-pp-contract-version` 与版本来源。

### P2（第三方开放前必须）

8. 每插件限流、权限同意/升级重新同意、签名与哈希、SBOM。
9. KV/HTTP/settings 宿主函数（ABI v2）与对应权限。
10. 失败自动禁用、指标、drain、安全模式、回滚。
11. 多站点隔离测试（A/B 站插件、KV、路由不可见）。
12. 前端主题 token、设置页、编辑器工具；路由注册表单独评审。

### P3（生态）

13. 市场/审核/评分/举报/官方认证。
14. T3 独立进程插件或编译期 native registry。
15. 插件级迁移框架、兼容矩阵 CI、契约 v2。

## 7. 验证记录（2026-11-10）

```powershell
go test ./apps/api/internal/plugins/... -count=1
# ok github.com/practacu/practacu-press/apps/api/internal/plugins 1.891s

go test ./apps/api/internal/transport/http/gin/ -count=1
# 本次未能完成：仓库里有与本工单无关的未提交改动导致构建失败
# apps/api/internal/site/permission.go:398:2: declared and not used: existing
# 该错误不在插件包内；插件路由集成测试 TestPluginHostMountsRoutes 本次无法执行。

cd apps/web
node node_modules/vitest/vitest.mjs run src/lib/plugins
# Test Files 2 passed (2), Tests 12 passed (12)
```

> 记录这次失败是有意的：工作区当时有大量未提交改动（其他工单并行），`gin` 包依赖的 `site` 包暂时编不过。**不要把它误记为插件功能失败，也不要在本工单里修别人的代码。** 若要在干净工作区复验，先解决 `apps/api/internal/site` 的编译错误，再跑上面的命令。

这些测试证明的是**库/协议层可运行**，不是**生产已接入**。判断一个能力是否上线，请以 §4 的 I1/I2/I3 为准。

## 8. 文档维护约定

1. **源码优先**：字段、状态码、错误文案、限额以 `apps/api/internal/plugins/*.go`、`apps/web/src/lib/plugins/*.ts` 为准；设计文档只作背景。
2. **改协议必须同时改三处**：源码 + 本目录文档 + `host_test.go`/`runtime.test.ts` 的负向用例。
3. **新增权限/槽位/hook 是安全评审项**，不是格式改动；同步更新 [02-manifest.md](02-manifest.md) 的闭集表。
4. **不要在产品文案里写「已支持」**，除非 §4 对应项已经变成 ✅。
5. 每次接入一个新环节（Host、内容管线、前端槽位、管理页），回来把对应 I/H/C/F 条目标记更新，而不是删掉历史。
