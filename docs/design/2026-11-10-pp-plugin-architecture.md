# Practacu Press 插件化（pp 插件）可行性与架构设计

- 日期：2026-11-10
- 范围：`apps/api`（Go）、`apps/web`（React）、`packages/contracts`（OpenAPI 3.1）、`services/security`（Rust）、`apps/launcher`（单文件启动器）
- 参考实现：DeepSeek Harness（下称 DSH）`0.2.2-rc.1` 的 Cordis 插件树、Loader、客户端模块系统与插件管理器
- 结论先行：**“插件可以修改一切”在 DSH 里成立，靠的是“插件与宿主同权限 + 每个能力都有可拦截的接缝”，不是靠沙箱。Practacu Press 可以复刻这套扩展性，但必须分层：前端运行时插件与 WASM 服务端插件可以做到热加载和强扩展；真正“改内核”的 Go 原生插件只能作为受信任的一等公民，且需要重启。** 本仓库已用可运行的原型验证了服务端 WASM 插件、插件路由、内容钩子、契约合并、前端运行时加载、槽位/区块注册与权限拒绝。

---

## 1. 我们到底想复刻 DSH 的什么

DSH 的“插件几乎可以修改一切”不是一句口号，而是四个机制叠出来的：

| 机制 | DSH 的做法 | 对 Practacu Press 的含义 |
|---|---|---|
| 依赖注入与生命周期 | Cordis `Context`：插件注册 service、监听事件、`inject` 依赖；`Fiber` 释放时自动回收 effect/监听/service | Go 侧没有等价容器，需要自建 `Host`/`Registry`/`Disposable` 语义 |
| 事件接缝 | `ctx.on('internal/...')`，`waterfall` 可包裹/否决内置行为；`emit/serial/bail/parallel` 多种派发 | 需要把内容渲染、鉴权、路由、合同等改成显式 Hook 链，而不是散落在 handler 里的 if |
| 运行时装配 | `cordis-plugin-loader` 按 `cordis.yml` 加载 npm 包；entry 支持 `config/group/disabled/inject`；HMR 热重载；profile 用 bundle + patch 分层 | 需要插件清单、安装目录、启用状态、版本约束、补丁层；Go 侧只能对 WASM/进程插件做热装卸 |
| 浏览器插件 | 包声明 `dsh.client`；宿主扫描 Loader entry，生成 `window.__DSH_BOOT__`；`/plugins` 提供 bundle；浏览器用冻结模块表的惰性 CJS 工厂加载；`ctx.slots.inject/register` 填 UI 槽位；HMR 在线增删插件 | 需要 boot manifest、版本化 bundle、冻结模块表、槽位/区块/主题/路由注册表与错误隔离 |

DSH 的信任模型同样关键：

- 普通插件是**同进程、同权限**的代码。`dsh-cordis-host-runner` 的 `node:vm` 沙箱在文档里明确写着“不是安全边界”（not a security boundary）；它只隔离全局变量，不隔离能力。
- 安装侧有**构建脚本审批**（`approvedBuilds`）、版本兼容检查（`engines.dsh`）、版本豁免（`compatibility.json`）和安装确认，但这些是供应链/兼容性控制，不是运行时权限沙箱。
- 动态 Cordis 包有逐次运行审批，但那是“模型写的代码要不要跑”的产品决策，不是插件能力模型。
- Loader 配置里的 `!!js` 表达式会执行任意 JS（`new Function`），进一步说明 DSH 把“插件/配置作者”当成受信任的开发者。

**因此，Practacu Press 不能同时承诺“第三方插件可以改一切”和“第三方插件绝对安全”。** 可行的是把“改一切”拆成受信任层级，并按层级给出不同的隔离与审批。

---

## 2. Practacu Press 现状：扩展点与硬编码边界

### 2.1 已经存在的扩展点

| 扩展点 | 位置 | 能力 | 边界 |
|---|---|---|---|
| 站点设计文档 | `apps/api/internal/site/customization.go`、`apps/web/src/lib/customize.ts` | 每站点一份 JSON：主题、区块编排、页面、导航/页脚、自定义扩展等；服务端只做大小/危险 CSS/嵌套深度校验 | 服务端不解释区块语义；文档上限 1 MiB；`custom_extensions` 与 `covers` 被跳过扫描 |
| 主题 | `apps/web/src/lib/theme.ts`、`themes.ts`、`components/blocks/{Classic,Nightflight,Daylight}.tsx` | 配色/排版/版式 preset；自定义主题可导入导出；外观分区可声明 | `LayoutVariant` 是闭合的 `classic \| bento \| daylight`；渲染器是编译期代码 |
| 区块 | `apps/web/src/lib/blocks.ts`（约 2100 行定义）、`components/blocks/index.tsx` | 大量内置区块类型、属性 schema、编辑器检查器、三端布局 | `RENDERERS` 是模块加载时合并的静态对象；未知类型跳过 |
| 页面编排 | `apps/web/src/pages/admin/ThemeBuilder.tsx`、`components/builder/*` | 区块树、拖拽、响应式、预览 | 编排器只认内置区块定义 |
| 创作者扩展 | `apps/web/src/lib/extensions.ts`、`components/ExtensionHost.tsx`、`ExtensionRuntime.tsx`、`pages/admin/Extensions.tsx` | 每站点 HTML/CSS/JS；`sandbox="allow-scripts"` iframe；8 个 DOM 槽位、6 个权限；`postMessage` 桥 | 不能改 React 树、路由、后端；iframe 独立 opaque origin，能力仅 `window.PP` |
| 合同 | `packages/contracts/openapi/openapi.yaml`（115 paths / 137 operations，2026-11-10 统计） | 前端与后端共享的 REST 契约；`/api/v1/openapi.json` 提供内嵌文档 | 手写单一 YAML；严格双向测试：注册路由必须被文档覆盖，文档路由必须存在 |
| 前端路由 | `apps/web/src/App.tsx:541` 起 | 站点前台/写作台/后台三套静态路由 | 路由表硬编码；新增页面必须改 App |
| 后端路由 | `apps/api/internal/transport/http/gin/router.go:159` 起 | 每个业务模块 `Routes(v1, guard, optionalAuth)` 静态挂载 | 路由注册顺序与中间件链固定；`NoRoute` 返回 problem JSON |
| 鉴权 | `apps/api/internal/transport/http/gin/middleware/auth.go` | Bearer + 站点绑定 + live membership；`RequireRole` 四级角色 | 授权动作是 `site.Action` 四个固定值；没有策略插件点 |
| 站点/多租户 | `middleware.ResolveSite`、`site.Service` | 按 Host 解析站点；所有 `/api/v1` 路由绑定站点 | 插件启用也应按站点隔离，目前无此概念 |
| 安全服务 | `services/security`（Rust/gRPC） | 密码哈希、内容安全扫描等 | 独立进程，API 通过 `securityclient` 调用；插件不能绕过它 |
| 前端分发 | `apps/launcher/main.go:37` `//go:embed all:web` | 单 exe 内嵌 `web/dist`，同源代理 API | 产物是构建时冻结的；CSP `script-src 'self' ...` 不允许 `unsafe-eval` |
| 数据库 | `ent` schema + `migrations/{sqlite,mysql,postgres}` | 关系模型、迁移 | 没有运行时 DDL/插件表机制 |

### 2.2 硬编码边界（决定“能改到什么程度”）

1. **Go 进程内没有插件容器。** `router.New` 一次性 `Use` 固定中间件、按固定顺序挂载 handler；业务服务由 `cmd/server/main.go` 手工组装。没有 service registry、没有 dispose、没有配置树。
2. **Go 原生插件不可移植热加载。** 标准库 `plugin` 包只支持 Linux/macOS（不支持 Windows），且要求宿主与插件用完全相同的 Go 工具链/依赖版本；桌面版是 Windows 单 exe，直接排除。任何“运行时加载 .so/.dll 改路由”的方案都不可行。
3. **契约是单文件且强一致。** `openapi_contract_test.go:241` 要求“注册的每条路由都必须出现在 YAML 里”；插件动态加路由会让测试失败，必须改成“基础契约 + 插件片段”的组合模型。
4. **前端是单 bundle、静态路由、静态渲染器表。** 没有模块联邦/运行时 import 机制；没有槽位注册表；`RENDERERS` 是常量对象；主题 variant 是闭合联合类型。
5. **单文件启动器把前端冻结进 exe。** 新插件的前端资源不能靠“重新打包 exe”分发；必须由 API/静态服务器在运行时提供 `/plugins/...`，并让 CSP 允许同源脚本（当前 `script-src 'self'` 已满足，前提是不引入 CDN）。
6. **多租户。** 插件必须能按站点启用/禁用、按站点配置，并确保请求上下文不会把 A 站插件的数据带给 B 站。

### 2.3 现有“创作者扩展”的位置

它不是插件系统，而是**站点级、沙箱化的 UI 片段**：

- 优点：真正不可信代码隔离（无 `allow-same-origin`，拿不到 Cookie/DOM/存储）；权限模型（notify/open_link/navigate/clipboard/theme/storage）已经存在；按页面/槽位匹配。
- 局限：只能出现在 8 个 DOM 锚点；不能注册 React 区块；不能加路由；不能改主题 token；不能碰后端；每次保存重挂 iframe。

**建议保留它作为 T0（不可信 UI 扩展）**，并在新的槽位模型里给它一个适配层（`iframe` 作为 slot renderer 的一种实现），而不是用它承载“改一切”的插件。

---

## 3. 目标模型：四层信任 + 三个平面

### 3.1 四层信任（按“能改什么”和“怎么隔离”分）

| 层级 | 名称 | 运行位置 | 能改什么 | 隔离 | 热加载 | 信任要求 |
|---|---|---|---|---|---|---|
| T0 | 站点数据扩展 | 浏览器 iframe + 站点 JSON | 站点某几个槽位的 HTML/CSS/JS、主题数据、区块属性 | `sandbox="allow-scripts"` 独立源 | 保存即生效 | 不可信，可自助安装 |
| T1 | 前端运行时插件 | 浏览器同源脚本 | 槽位、区块渲染器、主题 token、前端路由、编辑器工具、设置页 | **无沙箱**（同源 DOM/Cookie） | 是（加载/卸载/重激活） | 受信任；安装需审批/签名 |
| T2 | 服务端沙箱插件 | Go 进程内 wazero WASM | 内容钩子、插件路由、站点级 KV、受限 HTTP、设置 | WASM + 每插件 runtime + 能力清单 | 是（编译后启用/停用） | 第三方可用；需权限同意 |
| T3 | 原生服务端插件 | Go 进程内（编译期注册）或独立进程 gRPC | 中间件、鉴权策略、DB 迁移、任意 Go 依赖、安全服务集成 | 进程级（同权限或独立进程） | 否（重启） | 一等公民/审计后 |

> “插件可以修改一切” = T3 的能力上限。产品对外承诺时应写成“**T1/T2 覆盖 80% 扩展场景；T3 用于一等公民深度集成**”，而不是“任何插件都能改内核”。

### 3.2 三个平面

```
┌────────────────────────────────────────────────────────────────────┐
│ 分发平面：插件包 / 清单 / 版本 / 签名 / 安装目录 / 启用状态 / 市场   │
├────────────────────────────────────────────────────────────────────┤
│ 服务端宿主平面：插件 Host、能力网关、Hook 总线、路由、契约组合、审计 │
│   T2 WASM runtime（每插件）        T3 native registry（编译期/进程）  │
├────────────────────────────────────────────────────────────────────┤
│ 浏览器宿主平面：boot manifest、模块表、槽位/区块/主题/路由注册表     │
│   T1 同源 bundle（受信任）          T0 iframe（不可信）               │
└────────────────────────────────────────────────────────────────────┘
```

三个平面共享同一份**插件清单**与**权限词汇表**，但各自的执行模型不同。清单是唯一事实来源；宿主只信清单，不信插件自报。

---

## 4. 插件包与清单

### 4.1 目录布局

```
plugins/hello-pp/
  plugin.json            # 清单（唯一入口）
  backend/
    main.go              # 可选：WASM 源（wasip1）
    hello.wasm           # 构建产物（提交或发布时生成）
  frontend/
    client.js            # 浏览器 bundle（经典脚本 + 注册工厂）
    client.css
  README.md
```

- 安装目录：`data/plugins/<id>/<version>/`（不可变、内容寻址）；启用状态/配置在 `data/plugins/state.json` 或数据库表。
- 一个插件一个目录；升级 = 新版本目录 + 原子切换指针；回滚 = 切回旧指针。
- 不执行 `npm install`/`go build`/任意安装脚本。服务端插件只接受预编译 `.wasm`；前端插件只接受已构建 bundle。这样把供应链风险压到“产物签名/哈希”一层。

### 4.2 清单示例（与 spike 实现一致）

```json
{
  "manifest_version": 1,
  "id": "com.example.hello",
  "name": "Hello PP",
  "version": "1.0.0",
  "engines": { "pp": ">=0.1.0 <1.0.0", "contract": ">=1.0.0 <2.0.0" },
  "runtime": "wasm",
  "backend": {
    "entry": "backend/hello.wasm",
    "abi": "wasi-json-v1",
    "timeout_ms": 300,
    "max_memory_mb": 64,
    "hooks": ["content.render"],
    "routes": [
      {
        "method": "GET",
        "path": "/hello",
        "handler": "hello",
        "auth": "public",
        "contract": {
          "summary": "Say hello from a WASM plugin",
          "responses": { "200": { "description": "A greeting" } }
        }
      }
    ]
  },
  "frontend": {
    "entry": "frontend/client.js",
    "styles": ["frontend/client.css"],
    "slots": ["article.after"],
    "blocks": [{ "type": "hello.card", "name": "Hello card" }]
  },
  "permissions": [
    "content.render", "http.route.public",
    "ui.inject", "ui.block", "ui.style"
  ]
}
```

### 4.3 清单校验规则（已在 spike 落地）

- `manifest_version` 必须为 1；未知字段直接拒绝（`DisallowUnknownFields`）。
- `id` 必须是反向域名风格的小写标识；`version` 必须是 semver。
- `engines.pp` 必填，按宿主版本校验；`engines.contract` 可选，按契约版本校验。
- 所有文件路径必须是插件目录内的相对路径；拒绝绝对路径、`..`、Windows 盘符、反斜杠。
- 权限是闭集；声明了 hook/route/frontend/block 却缺少对应权限时安装失败（不能自授权）。
- 每个插件路由必须带 OpenAPI operation（`responses` 必填）；v1 禁止 `$ref`、`servers`、`security`，避免插件改写宿主契约语义。
- 前端声明的 slot/block 必须在宿主的闭集内；bundle 必须是 `/plugins/` 下的同源路径。
- 设置 schema 必须是 JSON 对象；大小上限 256 KiB。

---

## 5. 服务端宿主（T2 WASM + T3 原生）

### 5.1 进程内 WASM 运行时

选择 **wazero**（纯 Go、无 CGO、跨平台、支持 WASI preview1）而不是 Go `plugin`：

| 方案 | Windows | 热加载 | 隔离 | 能力 | 结论 |
|---|---|---|---|---|---|
| Go `plugin` | ❌ | 有限 | 无 | 任意 Go | 不可用 |
| wazero WASI | ✅ | ✅ | 进程内沙箱 | 受限、需宿主函数 | **T2 首选** |
| 外部进程 gRPC/stdio | ✅ | ✅ | 进程级 | 任意语言 | T3 可选，运维重 |
| goja/Lua/Starlark | ✅ | ✅ | 非安全边界 | 脚本级 | 不推荐做第三方边界 |
| 编译期 Go registry | ✅ | ❌ 重启 | 无 | 任意 Go | **T3 一等公民** |

spike 的实现要点：

- **每插件一个 wazero runtime**：内存上限按清单；超时/取消时关闭该插件 runtime，不会波及其他插件；插件卸载/禁用时关闭整个 runtime。
- **WASI JSON ABI v1**：宿主把一次调用编码成 JSON 写入 stdin；插件从 stdout 返回一个信封：
  ```json
  { "ok": true, "result": { "html": "..." } }
  ```
  失败返回 `{"ok":false,"error":{"code":"...","message":"..."}}`。
- **默认无能力**：没有文件系统、网络、环境变量、时钟之外的宿主函数；插件只能看到本次请求的 stdin 与清单里授予的能力列表。未来 ABI v2 再按能力注入 `host_kv_get`、`host_http_fetch` 等函数。
- **边界**：响应 4 MiB、stderr 4 KiB、content HTML 8 MiB、请求体 1 MiB；超时默认 500 ms（清单可覆盖，最大 30 s）。
- **失败隔离**：内容钩子失败只记录并跳过该插件，文章仍可发布；插件路由失败返回 502 problem JSON，不把 stderr/内部路径回给客户端。生产应再加“连续失败 N 次自动禁用”。
- **编译成本**：参考插件是 4.4 MiB 的 Go/WASI 模块，本机编译约 1.7 s；启用时一次，之后复用 compiled module。可加 wazero compilation cache 落盘，把重启后的首次启用也降下来。

### 5.2 服务端 Hook 总线

v1 只开三类接缝，宁可少而稳定：

| Hook | 时机 | 输入 | 输出 | 失败策略 |
|---|---|---|---|---|
| `content.render` | 文章/页面 HTML 渲染后、落库/输出前 | `html, site_id, content_id, kind, locale, actor_role` | 变换后的 `html` | 跳过该插件，记录告警 |
| `content.after_create/update/delete` | 内容事务提交后 | 内容快照/ID | 无（fire-and-forget） | 记录，不回滚业务 |
| `http.request` | 插件路由 | method/path/query/headers/body/site/actor | status/headers/body | 502 |

后续再加：`authz.decide`（**只允许否决/加严，不允许放行**）、`seo.head`、`feed.item`、`sitemap.url`、`media.after_upload`、`site.customization.validate`、`job.run`、`ws.event`。原则：

- 每个 Hook 有明确的**顺序、超时、失败语义、输出上限**；
- 默认 fail-open（业务继续）还是 fail-closed（拒绝发布）要逐 Hook 决定；内容安全类必须 fail-closed；
- Hook 输入输出都过 JSON schema 校验，不允许插件返回任意 Go 指针/闭包；
- 所有 Hook 调用带 `site_id` 与 `request_id`，便于审计与多租户排查。

### 5.3 插件路由与鉴权

- 路由统一挂在 `/api/v1/plugins/{pluginID}/...`，与宿主 API 命名空间隔离；插件不能注册 `/api/v1/auth/...` 之类宿主路径。
- 清单声明 `auth: public | member | admin`；宿主在进入沙箱**之前**完成鉴权，插件拿到的只是 `{site_id, user_id, role}` 只读上下文。
- 请求头只透传 `Accept/Accept-Language/Content-Type/User-Agent/X-Requested-With`；绝不透传 `Authorization`/`Cookie`。
- 响应头只允许 `Content-Type/Cache-Control/ETag/Location/Content-Language/X-PP-*`；`Location` 必须是站内相对路径；禁止 `Set-Cookie`。
- 每插件路由独立限流（按站点 + 插件 + IP），默认 60 req/min；可配置。
- 插件路由的响应若包含 HTML，必须走与内容相同的安全扫描（Rust 安全服务）后才能作为页面输出；纯 JSON 不经过 HTML 扫描但要做大小/编码校验。

### 5.4 数据与迁移

- **T2 不直接碰数据库**。v1 提供站点级 KV（`plugin_kv(site_id, plugin_id, key, value, expires_at)`），按插件命名空间隔离；需要结构化数据时，宿主提供声明式 collection API（P2），由宿主建表/迁移，插件只能读写自己的命名空间。
- **T3 才能加 Ent schema/迁移**。迁移必须：文件名带插件 id、只允许 `CREATE TABLE/INDEX`、禁止 `DROP/ALTER` 宿主表、在事务中执行、可回滚、先备份。
- 备份/导出：插件数据默认不进站点导出；若需要，清单声明 `export: true`，宿主提供导出钩子。

### 5.5 契约组合

spike 已实现：

- 基础契约仍是 `packages/contracts/openapi/openapi.yaml`，保持单一事实来源。
- 启用插件时，把每个 `route.contract` 作为 operation 合并到 `paths["/plugins/{id}{route.path}"]`；加入 `tags: [pluginID]` 与 `x-pp-plugin: {id, version, permissions, auth}`。
- 冲突检测：同一路径已存在则拒绝启用（插件不能覆盖宿主 operation）。
- `/api/v1/openapi.json` 返回组合后的文档；禁用插件后缓存失效，路径消失。
- 契约测试需要分两层：
  1. 基础路由 ↔ 基础 YAML（保持现有严格双向测试）；
  2. 启用插件后的组合文档 ↔ 实际注册路由（新增测试；插件 operation 必须存在且可解析）。
- 版本：`engines.contract` 只接受兼容 major；v1 内只允许**加法**（新增 path/operation/可选字段），不允许改已有 operation 的语义；破坏性变更走 `/api/v2` 并行提供。`x-pp-contract-version` 写进文档顶层，SDK 生成器按此对齐。
- 组件的 `$ref`：v1 禁止；v2 允许 `#/components/schemas/Pp_<PluginID>_<Name>` 命名空间，宿主在合并时加前缀，避免与宿主 schema 冲突。

### 5.6 生命周期

```
install（校验清单/编译） → installed
  → enable（建 runtime/挂路由/参与 Hook/发布前端 boot 记录） → enabled
  → disable（摘路由/停 Hook/撤销前端记录/关闭 runtime） → disabled
  → enable …（可重复）
  → remove（删目录/清状态/清 KV/审计） → 不存在
```

- 失败状态 `failed` 要保留 `last_error` 与最近日志；管理页可“重试/禁用/卸载”。
- **安全模式**：启动参数/环境变量 `PP_PLUGINS_SAFE_MODE=1` 只加载宿主，不加载任何插件；用于插件导致启动失败时自救。
- 禁用/卸载要先 **drain**：停止新请求，等待在途 Hook/路由完成（有上限），再关 runtime。
- 启动时插件失败不应拖垮宿主：默认“可选插件失败只告警”；清单可声明 `required: true`，但只允许一等公民使用。

### 5.7 T3 原生插件

两条路：

1. **编译期注册（推荐 v1 的一等公民）**：`plugins/native/<id>` Go 包实现 `NativePlugin` 接口，在 `cmd/server` 的 composition root 里显式 `Register`。能力最大、调试最简单；代价是重新构建/发版/重启。
2. **独立进程 gRPC/stdio**：宿主拉子进程，定义 proto；崩溃隔离、可独立升级；代价是运维、序列化、超时、日志、健康检查。更适合“重插件”（全文搜索、AI 推理、外部 CMS 同步）。

不建议做 Go `plugin` `.so` 热加载：Windows 不支持，版本锁定，崩溃即宿主崩溃。

---

## 6. 浏览器宿主（T1 运行时插件）

### 6.1 为什么不用 ESM/import map，而用“经典脚本 + 冻结模块表 + CJS 工厂”

| 方案 | 优点 | 代价/风险 | 结论 |
|---|---|---|---|
| 编译期注册（现状） | 最简单、类型安全、无运行时风险 | 第三方无法安装；每次改动重建 | 保留给内置区块/主题 |
| ESM + import map | 作者体验接近普通前端 | Vite 产物带 hash，模块 URL 不稳定；React 重复实例会让 hooks 崩溃；CSP/跨域/缓存复杂 | 可作为 P2 备选 |
| 经典脚本 + `window.__PP_PLUGIN_REGISTER__(id, version, factory)` + 冻结模块表 | 无 `eval`；React 单实例；SRI 可用；同源 CSP 直接过；与 DSH 客户端模块系统同构 | 作者需要一个小构建包装；不是原生 ESM | **v1 采用** |
| iframe 沙箱 | 真正隔离 | 不能改 React 树/路由/区块；通信成本高 | T0 保留 |

当前启动器 CSP 是 `script-src 'self' https://challenges.cloudflare.com ...`（`apps/launcher/main.go:393` 起），同源 `/plugins/...` 脚本天然允许，不需要 `unsafe-eval`。这是选择经典脚本的关键原因。

### 6.2 加载流程

```text
App 启动
  → GET /api/v1/plugins                    （boot manifest，公开、no-store）
  → 对每个 enabled 插件：
      <script src="/plugins/{id}/{version}/client.js" integrity="sha384-...">
        → 脚本只调用 window.__PP_PLUGIN_REGISTER__(id, version, factory)
      → 宿主用冻结模块表 materialize(factory)
        require('react') → 宿主的 React 实例
      → definition.activate(ctx)
          ctx.slots.register(...)
          ctx.blocks.register(...)
          ctx.ui.addStyle(...)
  → 槽位/区块注册表触发 React 订阅，页面增量渲染
```

- **版本化 URL**：`/plugins/{id}/{version}/...`，可 `immutable` 缓存；升级即换 URL。
- **SRI**：清单可带 `integrity: sha384-...`；没有 SRI 时至少校验同源 + 版本。
- **模块表**：`react`、`react-dom`、`react-dom/client`、`react/jsx-runtime`、`react-router-dom`。插件 bundle 必须 external 这些包；否则 React 双实例会报 hooks 错误。宿主对未登记模块直接抛错（spike 已测）。
- **无 `eval`**：工厂是脚本加载后注册的函数，不是 `new Function(source)`。
- **失败隔离**：脚本加载失败/激活失败 → 状态 `failed`，不阻塞其他插件；槽位渲染各自包 error boundary（spike 已测：一个 renderer 抛错，另一个仍渲染）。
- **卸载**：`definition.deactivate()` → 逆序执行 disposer → 清空该插件的槽位/区块/样式；不要求刷新页面。
- **HMR（P2）**：bundle 重建后换 revision URL，卸载旧实例、加载新实例；槽位注册表天然支持热替换。注意：插件若在模块顶层产生副作用，重载会重复执行；文档要求副作用放在 `activate`。

### 6.3 前端扩展点（v1）

| 扩展点 | API | 说明 |
|---|---|---|
| 槽位 | `ctx.slots.register(name, id, render, {order})` | 命名 seat；v1 开放 `site.header/site.footer/article.after/article.sidebar/home.after/admin.nav/admin.settings/admin.editor.tools`；插件必须先在清单声明 |
| 区块 | `ctx.blocks.register(type, renderer)` | 只能新增类型，不能覆盖内置类型（spike 已测：内置优先） |
| 样式 | `ctx.ui.addStyle(css)` | 注入 `<style data-pp-plugin>`；卸载移除；拒绝 `@import`/`javascript:`/`expression()` |
| 主题 | P2：`ctx.theme.register(tokens)` / `ctx.theme.extend(...)` | 需要先把 `LayoutVariant` 与颜色 token 注册表化 |
| 前端路由 | P2：`ctx.routes.register(path, component)` | 需要先把 App 的静态 `<Routes>` 改为可组合路由表；v1 先不做，避免路由冲突与鉴权绕过 |
| 设置页 | P2：`ctx.settings.register(section)` | 与清单 `settings_schema` 联动，宿主渲染表单，插件只读/写自己的配置 |
| API 调用 | `ctx.api.fetch('/api/...')` | 仅同源 `/api/` 路径；带 `credentials: same-origin`；不暴露 token |
| 日志 | `ctx.log(...)` | 前缀带插件 id；生产应接入宿主日志/遥测 |

**为什么不 v1 就开“前端路由”**：SPA 路由是安全边界（后台入口、鉴权守卫、站点路径冲突）。先让插件通过槽位/区块扩展页面，等有了路由注册表、冲突检测、按角色守卫与 404 优先级，再开放。

### 6.4 与现有创作者扩展的关系

- T0 继续用 iframe；新增一个 `IframeSlot` 适配器，把 `CustomExtension` 映射到新的 slot registry。这样站点可以从“DOM 锚点”平滑迁移到“命名槽位”，而不破坏现有扩展。
- T1 不替代 T0：T0 是“不可信、可自助、样式级”的扩展；T1 是“受信任、需审批、代码级”的插件。
- 管理页要明确区分：**站点扩展**（当前 Extensions 页）与**插件**（新的 Plugins 页），避免站长把两者混为一谈。

---

## 7. 权限、沙箱与供应链

### 7.1 能力清单

v1 权限词汇（spike 已实现）：

| 权限 | 授予什么 | 风险 |
|---|---|---|
| `content.render` | 读/改渲染后的 HTML | XSS/内容注入；必须再过安全扫描 |
| `content.read` | 读内容正文/元数据（未来 Hook） | 数据泄露 |
| `content.write` | 内容生命周期钩子 | 篡改/删除 |
| `http.route.public` | 公开路由 | 滥用/限流 |
| `http.route.member` | 登录成员路由 | 越权/CSRF |
| `admin.route` | 管理员路由 | 最高风险；必须审计 |
| `ui.inject` | 填槽位 | 同源 DOM 权限（T1 本身已全权限） |
| `ui.block` | 注册区块 | 渲染注入 |
| `ui.style` | 注入 CSS | 视觉钓鱼/数据外泄（`url()`） |

下一版应资源化：`network.fetch:api.example.com`、`storage.kv:plugin`、`content.read:article`、`settings.write:own`。权限只增不减；升级若新增权限，必须重新同意。

### 7.2 运行时隔离

- **T2**：WASM 线性内存 + 每插件 runtime + 超时 + 输出上限 + 无宿主函数；这是真的隔离边界（在 wazero 无漏洞的前提下）。仍建议高风险插件跑在独立进程/容器，WASM 不是“绝对安全”。
- **T1**：**不是沙箱**。同源脚本可读 DOM、Cookie（HttpOnly 除外）、localStorage、发同源请求。权限检查只防止“未声明的组合”，不防止恶意代码。必须靠签名/审核/信任分级，不能把 T1 当第三方任意代码执行环境。
- **T0**：iframe `sandbox="allow-scripts"`，无 `allow-same-origin`；这是当前唯一适合“不可信第三方 UI”的边界。
- **T3**：同进程 = 同权限；独立进程 = 进程边界，但仍能访问网络/文件（取决于沙箱配置）。

### 7.3 安全服务不能被绕过

- 任何插件产生的 HTML（内容钩子、插件路由返回的 HTML、区块 SSR）在落库/输出前必须经过 `services/security` 的内容扫描；插件不能调用“跳过扫描”的内部接口。
- 插件路由的鉴权由宿主中间件完成，插件只拿只读上下文；禁止插件设置 `Set-Cookie`、`Authorization`、`Location` 外链。
- 审计：安装/启用/禁用/卸载、权限变更、管理员路由调用、安全扫描拒绝都要写审计日志；日志里不含正文/密钥。
- 密钥：插件配置中的 secret 由宿主加密存储，注入时只给需要的字段；插件日志默认脱敏。

### 7.4 供应链

- 只接受**已构建产物**：WASM 或前端 bundle；安装时不跑 `npm install`/`go build`/postinstall。
- 清单 + 产物哈希 + 可选 Sigstore/cosign 签名；安装页展示发布者、版本、权限、哈希。
- 锁定版本；升级必须显式确认；保留上一版本目录用于回滚。
- SBOM（SPDX/CyCloneDX）与许可证字段；市场审核最低要求。
- 版本兼容：`engines.pp`/`engines.contract` 不满足直接拒绝；确需放行时走“精确版本豁免 + 风险确认”，并记录审计（参考 DSH 的 `compatibility.json`，但不要默认继承）。

---

## 8. 代价与风险

| 风险 | 可能性 | 影响 | 缓解 |
|---|---|---|---|
| T1 插件 = 同源任意代码，等同 XSS/后门 | 高 | 高 | 信任分级、签名、审核、默认只允许官方源；不可信 UI 留在 T0 |
| 供应链投毒（WASM/bundle） | 中 | 高 | 只收产物、哈希锁定、签名、SBOM、可回滚 |
| WASM 运行时漏洞/逃逸 | 低 | 高 | 跟进 wazero 安全更新；高风险插件独立进程/容器；最小宿主函数 |
| 契约漂移/插件路由未文档化 | 高 | 中 | 组合契约测试、`$ref` 禁止、SDK 生成、CI 门禁 |
| Hook 性能拖慢文章渲染 | 中 | 中 | 每 Hook 预算、超时、缓存、只对启用插件调用、异步化 |
| 插件冲突（同 path/block/slot） | 中 | 中 | 命名空间、重复检测、内置优先、启用时预检 |
| 多租户数据串站 | 中 | 高 | 所有插件 API 强制 `site_id`；KV 以 site 为键；跨站测试 |
| 升级破坏兼容 | 高 | 中 | semver + `engines` + 契约 major 并行 + 兼容矩阵 CI |
| 运维复杂度（日志/健康/重启） | 高 | 中 | 管理页、状态机、安全模式、一键禁用、结构化日志 |
| 权限同意疲劳 | 中 | 中 | 粗粒度起步、能力摘要、组织策略、默认拒绝 |
| 插件质量/支持负担 | 高 | 中 | SDK、模板、测试工具、市场审核、弃用策略 |
| 数据库迁移事故 | 中 | 高 | T2 不给 DDL；T3 迁移白名单 + 备份 + 回滚 |

**工程量粗估**（1 名熟悉该仓库的工程师）：

- P0 spike：已完成（约 1 天）。
- P1 可用 MVP（T1 + T2 基础 + 管理页 + 组合契约）：3–5 周。
- P2 第三方安全插件（KV/HTTP/设置/签名/审计/限流/兼容矩阵）：6–8 周。
- P3 市场/原生进程插件/主题与路由扩展：8–12 周。

---

## 9. 分阶段方案

### P0：可行性 spike（本次已完成）

目标：证明关键环节真的能跑，而不是 PPT。

- Go：清单校验、WASM 宿主、内容钩子、插件路由、鉴权、超时、资源限制、资产服务、契约合并。
- React：boot manifest、经典脚本工厂、冻结模块表、槽位注册、区块注册、样式注入、权限拒绝、错误边界、卸载。
- 路由：`Dependencies.Plugins` 可选接入；nil 时行为与契约完全不变。
- 参考插件：`apps/api/internal/plugins/testdata/hello`（Go/WASI 后端 + 手写前端 bundle）。

### P1：基础平台（建议下一个里程碑）

1. **插件包格式与安装器**：`data/plugins/<id>/<version>`、`state.json`、zip/目录安装、哈希校验、卸载/回滚。
2. **管理页**：插件列表、状态、权限摘要、启用/禁用/卸载、失败诊断、安全模式入口；只允许 `site_admin`/`platform_admin`。
3. **宿主接入**：`cmd/server` 通过环境变量/配置启用插件宿主；boot manifest 与插件路由挂载；按站点启用（先单站点，后多站点）。
4. **T1 挂载**：把 `defaultPluginRuntime.start()` 接到 App（feature flag `plugins_enabled`）；先开放 `site.footer`、`article.after`、`admin.settings` 三个槽位；`PluginSlot` + 区块注册表已就绪。
5. **T2 能力**：`content.render` + 插件路由 + 站点 KV + 设置 schema + 限流 + 审计；先只支持官方/签名插件。
6. **契约**：组合文档接入 `/api/v1/openapi.json`；CI 增加“组合契约 ↔ 实际路由”测试；插件 SDK 类型包 `packages/plugin-sdk`。
7. **文档/模板**：`create-pp-plugin` 模板、清单参考、前端 bundle 构建脚本、调试指南。

验收：安装一个官方示例插件（前后端各一处扩展）→ 管理页启用 → 前台出现槽位/区块 → 插件路由可访问 → 契约出现插件 path → 禁用后全部消失；基础契约测试仍全绿。

### P2：第三方安全插件

- WASM ABI v2：宿主函数 `kv_get/kv_set`、`http_fetch`（域名 allowlist）、`settings_get`、`log`、`now`；逐能力注入，不用的函数不链接。
- 声明式 collection API（宿主建表/迁移，插件命名空间读写）。
- 插件签名/发布者、SBOM、版本兼容矩阵、自动更新检查（不自动安装）。
- 审计/指标：每插件 QPS、P95、错误率、超时、Hook 耗时；管理页可见。
- 安全扫描闭环：插件 HTML 输出强制过 Rust 安全服务；失败 fail-closed 可配。
- 多站点启用矩阵与跨站隔离测试。
- 前端：主题 token 注册、设置页注册、编辑器工具槽位；路由注册表设计评审后再开。

### P3：生态与“改内核”

- 插件市场/索引、评分/审核、官方认证。
- T3 原生进程插件（gRPC/stdio）+ 健康检查/崩溃重启；或编译期 native registry 的正式 API。
- 主题/布局注册表、页面模板、前端路由覆盖（带优先级/冲突/守卫）。
- 插件级 DB 迁移框架（白名单、备份、回滚）。
- 兼容性 CI：历史版本宿主 × 插件矩阵；契约 v2 并行。

---

## 10. Spike 验证结果（可复现）

### 10.1 服务端

代码：

- `apps/api/internal/plugins/manifest.go`：清单/权限/路径/契约校验，semver range。
- `apps/api/internal/plugins/host.go`：安装/启用/禁用/卸载、每插件 wazero runtime、WASI JSON ABI、超时、输出上限、路由鉴权、资产服务。
- `apps/api/internal/plugins/contract.go`：基础 OpenAPI + 插件 operation 合并、缓存、冲突检测。
- `apps/api/internal/plugins/testdata/hello/`：参考插件（Go/WASI 后端 + 前端 bundle）。
- `apps/api/internal/transport/http/gin/router.go`：`Dependencies.Plugins` 可选挂载 `/api/v1/plugins`、`/api/v1/plugins/:pluginID/*path`、`/plugins/:pluginID/:version/*path`；`/api/v1/openapi.json` 组合文档。

已验证：

| 验证点 | 测试 | 结果 |
|---|---|---|
| 清单拒绝越权（路由/hook/路径/ABI/契约 `$ref`） | `manifest_test.go` | ✅ |
| 安装/启用/禁用/卸载状态机 | `host_test.go` | ✅ |
| WASM 内容钩子真的执行并改写 HTML | `TestTransformHTMLRunsTheSandboxedHook` | ✅ |
| 插件路由经宿主鉴权后执行 | `TestPluginHTTPRouteIsServed` / `TestPluginRouteAuthIsEnforcedBeforeTheSandbox` | ✅ 401/403/200 |
| 超时能终止 WASI `sleep`，不拖住请求 | `zz_timeout_test.go` | ✅ 300 ms 返回 502 |
| 资产只暴露 `frontend/`，防穿越，ETag/304 | `TestAssetHandlerServesOnlyTheFrontendDirectory` | ✅ |
| 契约合并/禁用后消失 | `TestContractIncludesEnabledPluginRoutes` | ✅ |
| 路由层接入且 nil 时契约不变 | `plugin_route_test.go` + 原有 contract test | ✅ |

命令：

```powershell
go test ./apps/api/internal/plugins/... -count=1
go test ./apps/api/internal/transport/http/gin/ -count=1
```

### 10.2 浏览器

代码：

- `apps/web/src/lib/plugins/types.ts`：清单/上下文/模块表类型。
- `apps/web/src/lib/plugins/registry.ts`：SlotRegistry / BlockRegistry（订阅、排序、去重、按插件清理）。
- `apps/web/src/lib/plugins/runtime.ts`：boot manifest、脚本加载、工厂 materialize、权限检查、样式注入、错误状态、卸载。
- `apps/web/src/components/PluginSlot.tsx`：`useSyncExternalStore` + 独立 error boundary。
- `apps/web/src/components/blocks/index.tsx`：`blockRendererFor()`，内置渲染器优先，插件只能新增类型。

已验证：

| 验证点 | 结果 |
|---|---|
| 加载清单 → 注册工厂 → 槽位渲染 → 卸载清空 | ✅ |
| 未声明 slot / 未声明 `ui.inject` 被拒绝 | ✅ |
| 未声明 block 被拒绝；内置区块不可被覆盖 | ✅ |
| 模块表外 `require('lodash')` 被拒绝 | ✅ |
| 重复插件 id / bundle 版本不匹配被拒绝 | ✅ |
| 样式注入与卸载移除 | ✅ |
| 一个 slot renderer 抛错不影响另一个 | ✅ |

命令：

```powershell
cd apps/web
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run src/lib/plugins
```

全量前端回归：`1127 passed`（91 个测试文件），本次改动未破坏既有区块/主题/路由测试。

### 10.3 Spike 明确没做的事

- 没有把 `defaultPluginRuntime.start()` 接进 `App.tsx`（避免在未完成管理/安全/多租户前默认开启）；目前是库 + 测试 + 可选路由接入。
- 没有插件管理 UI、安装器、签名、市场、按站点启用。
- 没有 WASM 宿主函数（KV/HTTP/设置）；v1 插件只能做纯函数式 HTML 变换和路由。
- 没有前端主题/路由/设置页扩展；只有槽位/区块/样式。
- 没有真实浏览器 E2E（happy-dom 单测 + Go httptest 覆盖了协议与生命周期；浏览器脚本加载用注入 loader 代替）。
- 没有压测/长期运行/内存泄漏验证；WASM 编译缓存、失败自动禁用、drain 都还没做。

---

## 11. 关键决策清单

1. **采用分层模型，不做“所有插件同权限”的一刀切。** T0 不可信 UI、T1 受信任前端、T2 沙箱 WASM、T3 受信任原生。
2. **服务端第三方插件用 WASM，不用 Go `plugin`。** Windows/版本锁定/崩溃隔离三条就足以否决 `.so` 方案。
3. **前端用“经典脚本 + 冻结模块表 + 工厂注册”，不用 ESM/import map 作为 v1。** 复用现有 CSP，避免 React 双实例与构建耦合；代价是作者需要小构建包装。
4. **契约只允许加法，插件 operation 命名空间化。** 插件永远不能覆盖/删除宿主 operation；破坏性变更走 v2 并行。
5. **权限清单从第一天就是强制的。** 安装时校验、启用时再校验、前端注册时再校验；升级新增权限必须重新同意。
6. **T1 不是沙箱。** 文档、管理页、市场文案都必须直说；不可信 UI 继续走 T0 iframe。
7. **先做管理/安全/回滚，再做市场。** 没有安全模式、签名、审计、回滚的插件市场是负债。
8. **把现有创作者扩展迁移到 slot 适配层，而不是废弃。** 它是唯一经过验证的不可信第三方 UI 边界。

---

## 12. 参考资料（本机 DSH 实现）

研究路径：`C:\Users\airfi\AppData\Local\Programs\DeepSeek Harness\resources\app.asar` 内的 `dsh/node_modules/@deepseek-ai/`。重点包：

- `cordis`：Context/Fiber/Service/Events（`src/context.ts`、`fiber.ts`、`events.ts`、`service.ts`、`registry.ts`）。
- `cordis-plugin-loader`：Entry 树、`create/update/remove`、`inject/disabled/group`、HMR、`!!js` 配置表达式。
- `dsh-app-boot` / `dsh`：profile、bundle、patch 分层、`engines.dsh` 准入、required/optional 启动策略。
- `dsh-client-modules`：`dsh.client`、`/plugins` bundle、`window.__DSH_BOOT__`、冻结模块表、惰性 CJS、HMR 在线组合。
- `dsh-client-ui-*`：`ctx.slots.inject/register`、`plugins.detail.*`、`settings.section` 等槽位。
- `dsh-plugin-manager`：安装/更新/卸载、pnpm 构建脚本审批、版本豁免、诊断。
- `dsh-cordis-host-runner`：`node:vm` 动态包，文档明确“不是安全边界”。
- `dsh-user-approval`：一次性审批接缝（敏感工具动作，不是插件权限）。

这些实现共同说明：**“改一切”来自可拦截的服务/事件/槽位 + 运行时装配，而不是来自权限系统；权限系统只决定“谁有资格运行这种代码”。** Practacu Press 的落地重点应放在“接缝设计 + 信任分级”，而不是追求一个万能沙箱。
