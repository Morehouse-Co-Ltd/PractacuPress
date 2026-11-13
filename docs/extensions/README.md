# Practacu Press 扩展接口文档

- 日期：2026-11-13
- 适用代码：`apps/api/internal/extensions/`、`apps/api/internal/plugins/`、`apps/web/src/lib/plugins/`、`apps/web/src/lib/extensions/`、`apps/web/src/pages/admin/Extensions.tsx`
- 配套设计：[../design/2026-11-10-pp-plugin-architecture.md](../design/2026-11-10-pp-plugin-architecture.md)、[../plans/2026-11-10-pp-plugin-roadmap.md](../plans/2026-11-10-pp-plugin-roadmap.md)
- 文档口径：**字段、状态码、限额、错误文案一律以当前源码为准。** 设计文档描述的是目标态；两者冲突时本文以代码为准，并在 [05-compatibility-gaps.md](05-compatibility-gaps.md) 的「现状与差距」里逐条列出。

> **先读这一句**：扩展已经接入产品（2026-11-13）。
> 后端 `cmd/server` 会构造插件宿主与扩展管理器，扩展包通过后台「扩展 → 导入扩展」安装；
> 前端 `App.tsx` 启动插件运行时，导入扩展可以注册后台页面（`/admin/ext/<path>`）、槽位、区块与样式；
> 后端 Go/WASM 扩展在 API 进程内的 wazero 沙箱里提供 `/api/v1/plugins/{id}/...` 路由与 `content.render` 钩子。
> **性能面板本身就是内置扩展 `pp.performance`**，与导入扩展走同一套页面注册通道。
> 完整的安装、打包、权限与安全说明见 [06-install-and-package.md](06-install-and-package.md)。
> 站点「创作者扩展」（iframe + HTML/CSS/JS）的数据与前台渲染代码仍然保留，
> 但**后台管理入口已在 2026-11-13 的扩展页改版中删除**：新安装不再提供创建入口，
> 已有配置仍按原样渲染。不可信的第三方 UI 请不要装成前端扩展。

## 1. 文档地图

| 文档 | 内容 | 读者 |
| --- | --- | --- |
| [01-overview.md](01-overview.md) | 两种扩展形态总览、与创作者扩展的关系、信任边界、现状矩阵 | 所有人 |
| [02-manifest.md](02-manifest.md) | `plugin.json` 逐字段说明、校验规则、拒绝条件、semver range 语法 | 插件作者、安装器实现者 |
| [03-frontend-api.md](03-frontend-api.md) | `__PP_PLUGIN_REGISTER__`、冻结模块表、`ctx` API、槽位/区块/样式、权限负向用例 | 前端插件作者 |
| [04-backend-api.md](04-backend-api.md) | WASI JSON ABI v1、`content.render`、插件路由、鉴权、限额、契约合并、失败策略 | 后端插件作者、宿主维护者 |
| [05-compatibility-gaps.md](05-compatibility-gaps.md) | 版本与兼容规则、升级/权限重新同意、**代码与设计文档的差异清单** | 维护者、评审者 |
| [06-install-and-package.md](06-install-and-package.md) | 扩展包格式、zip 导入/启用/删除 API、前端后台页 API、Go/WASM 构建与打包、安全审查清单 | 插件作者、站长、维护者 |

## 2. 30 秒总览

| 形态 | 一句话 | 运行位置 | 隔离 | 当前状态 |
| --- | --- | --- | --- | --- |
| **前端扩展**（T1） | 同源经典脚本，注册 React 槽位/区块/样式/后台页面，可直接调同源 `/api` | 浏览器，与页面同源 | **无沙箱**，等同页面权限 | ✅ 已上线：后台导入 + 启动清单 + 运行时加载 |
| **后端扩展**（T2） | Go/WASI 模块，stdin/stdout JSON 协议，改渲染 HTML、提供插件路由 | API 进程内 wazero | WASM 线性内存 + 每插件 runtime + 超时 | ✅ 已上线：后台导入 + 沙箱路由 + 内容钩子 |
| **创作者扩展**（T0） | 站点里填 HTML/CSS/JS，沙箱 iframe 挂在 8 个 DOM 槽位 | 浏览器 iframe | `sandbox="allow-scripts"` 独立不透明源 | 🟡 数据/渲染保留，后台管理入口已移除 |
| **原生插件**（T3） | 编译期 Go 注册或独立进程 | API 进程内/独立进程 | 同进程同权限 | 💭 仅设计，无代码 |

读完这张表只需要记住两条边界：

1. **前端扩展不是沙箱。** 它能读 DOM、Cookie、`localStorage`、发同源请求；权限清单只防止「未声明的组合」，不防恶意代码。不可信 UI 不要装成前端扩展；原创作者扩展的管理入口已在扩展页改版中移除。
2. **后端扩展是沙箱，但能力极小。** ABI v1 没有文件系统、网络、环境变量，也没有 KV/HTTP 宿主函数；它只能读一次 stdin、写一次 stdout，做纯函数式的 HTML 变换或 HTTP 响应。

## 3. 接口总览（一页表）

| 接口/契约 | 谁提供 | 说明 | 状态 |
| --- | --- | --- | --- |
| `GET /api/v1/plugins` | 宿主路由 | 浏览器 boot manifest（公开、`no-store`） | ✅ 已接入，只列启用中的前端扩展 |
| `GET /api/v1/plugins/{id}{route.path}` | `Host.APIHandler` | 插件路由，支持 GET/POST/PUT/PATCH/DELETE | ✅ 已接入 |
| `GET/HEAD /plugins/{id}/{version}/{file}` | `Host.AssetHandler` | 前端 bundle/CSS/图片，带 ETag/304 | ✅ 已接入（launcher / nginx 需代理 `/plugins/`） |
| `GET /api/v1/openapi.json` | 宿主路由 | 基础契约 + 插件 operation；未接宿主时只返回基础契约 | ✅ 已接入；插件 operation 合并 🧪 |
| `window.__PP_PLUGIN_REGISTER__(id, version, factory)` | 浏览器运行时 | 前端 bundle 的唯一注册入口 | ✅ App 启动时加载 |
| stdin/stdout JSON（`wasi-json-v1`） | WASM 宿主 | 后端调用的唯一 ABI | ✅ 生产已接入 |
| `CustomExtension`（站点配置） | 创作者扩展 | HTML/CSS/JS + 8 槽位 + 6 权限，iframe 沙箱 | 🟡 数据/渲染保留，无管理入口 |
| `GET/POST/PATCH/DELETE /api/v1/extensions...` | 扩展管理器 | 安装/列表/启停/卸载，仅平台管理员 | ✅ 已上线 |
| `content.after_create/update/delete` | — | 清单可声明，没有派发接口 | 🟡 未实现 |

> 「接口存在」和「生产可用」是两件事：`/api/v1/openapi.json` 是产品里真实存在的接口，但只有接上 `Dependencies.Plugins` 才会包含插件 operation；其余插件 HTTP 接口在发行版里根本不会注册。

## 4. 状态图例

本文所有能力表统一使用四种标记：

| 标记 | 含义 | 判定标准 |
| --- | --- | --- |
| ✅ **已落地** | 产品路径可用 | 代码存在，且被生产入口（`cmd/server`、`App.tsx`、管理页）调用 |
| 🧪 **Spike 已实现** | 代码 + 测试可跑，但生产未接入 | 有实现、有测试；`cmd/server` / `App.tsx` / 页面未引用 |
| 🟡 **已设计未实现** | 设计文档有，代码没有 | 只有文档或清单字段，无执行路径 |
| 💭 **仅构想** | 方向性讨论 | 无接口、无字段、无代码 |

> 「清单字段被接受」不等于「功能已实现」。例如 `content.after_create` 能通过清单校验，但宿主没有派发代码；`settings_schema` 能通过校验，但没有设置读写接口。这类情况在文中会单独标注。

## 5. 源码索引

| 主题 | 源码 | 测试 |
| --- | --- | --- |
| 清单结构、权限、槽位、semver、校验 | `apps/api/internal/plugins/manifest.go` | `manifest_test.go` |
| WASM 宿主、生命周期、路由、资产、限额 | `apps/api/internal/plugins/host.go` | `host_test.go`、`zz_timeout_test.go` |
| 契约合并 | `apps/api/internal/plugins/contract.go` | `host_test.go` 的契约用例 |
| 路由接入（可选） | `apps/api/internal/transport/http/gin/router.go:241`、`dependencies.go:117` | `plugin_route_test.go` |
| 参考插件 | `apps/api/internal/plugins/testdata/hello/` | — |
| 前端类型/模块表 | `apps/web/src/lib/plugins/types.ts` | — |
| 槽位/区块注册表 | `apps/web/src/lib/plugins/registry.ts` | `blockRegistry.test.ts` |
| 浏览器运行时 | `apps/web/src/lib/plugins/runtime.ts` | `runtime.test.ts` |
| 槽位 React 组件 | `apps/web/src/components/PluginSlot.tsx` | `runtime.test.ts` |
| 区块解析优先级 | `apps/web/src/components/blocks/index.tsx:254` | `blockRegistry.test.ts` |
| 创作者扩展（T0） | `apps/web/src/lib/extensions.ts`、`components/ExtensionHost.tsx`、`components/ExtensionRuntime.tsx` | `extensions.test.ts` |

## 6. 本地验证命令

```powershell
# 服务端：清单、宿主、超时、路由接入、契约
go test ./apps/api/internal/plugins/... -count=1
go test ./apps/api/internal/transport/http/gin/ -count=1

# 前端：类型与运行时
cd apps/web
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run src/lib/plugins
```

> 当前工作区有大量并行未提交改动；如果 `apps/api/internal/site` 等无关包暂时编不过，`go test ./apps/api/internal/transport/http/gin/` 会先失败。插件协议本身的验证以 `./apps/api/internal/plugins/...` 与 `src/lib/plugins` 为准，完整记录见 [05-compatibility-gaps.md](05-compatibility-gaps.md) §7。

参考插件的 WASM 构建：

```powershell
./scripts/build-plugin-wasm.ps1 -PluginDir apps/api/internal/plugins/testdata/hello
```

该脚本设置 `GOOS=wasip1 GOARCH=wasm`，产出 `backend/hello.wasm`。安装器不执行 `go build`/`npm install`，只接受预编译产物。

## 7. 术语

| 术语 | 含义 |
| --- | --- |
| 宿主（host） | 加载并运行插件的一侧：API 进程（后端）或页面里的 `PluginRuntime`（前端） |
| 清单（manifest） | 插件根目录的 `plugin.json`；宿主唯一的授权来源，不信插件自报 |
| 槽位（slot） | 页面上的命名 UI 座位，例如 `article.after`；前端插件把 React 渲染函数注册进去 |
| 区块（block） | 内容编排里的组件类型，例如 `hello.card`；插件只能新增，不能覆盖内置 |
| 钩子（hook） | 后端插件在内容生命周期上被调用的接缝，v1 只实际派发 `content.render` |
| 能力（capability / permission） | 清单里的权限字符串；安装、注册、调用三处都会校验 |
| T0/T1/T2/T3 | 设计文档的信任分层：站点数据扩展 / 前端运行时插件 / WASM 服务端插件 / 原生插件 |

---

**下一步**：想写插件先看 [02-manifest.md](02-manifest.md)，想接前端看 [03-frontend-api.md](03-frontend-api.md)，想接后端看 [04-backend-api.md](04-backend-api.md)；要判断某项能力现在能不能用，直接查 [05-compatibility-gaps.md](05-compatibility-gaps.md)。
