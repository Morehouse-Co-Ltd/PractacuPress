# 01 · 两种扩展形态总览与边界

- 上级文档：[README.md](README.md)
- 相关：[02-manifest.md](02-manifest.md) · [03-frontend-api.md](03-frontend-api.md) · [04-backend-api.md](04-backend-api.md)

## 1. 一句话区分

Practacu Press 的「扩展」不是一个东西，而是三条互不替代的通道：

| 通道 | 作者交付什么 | 宿主怎么跑 | 能改什么 | 不能做什么 |
| --- | --- | --- | --- | --- |
| **前端扩展（T1）** | 一个经典脚本 bundle + `plugin.json` 的 `frontend` 段 | 浏览器同源 `<script>`，`window.__PP_PLUGIN_REGISTER__` 注册工厂，React 渲染 | 槽位 UI、新区块类型、注入 CSS、调同源 `/api` | 不能改路由、不能改主题 token、不能碰后端、不是沙箱 |
| **后端扩展（T2）** | 一个 `GOOS=wasip1` 的 `.wasm` + `plugin.json` 的 `backend` 段 | API 进程内 wazero，每插件独立 runtime，stdin/stdout JSON | 渲染后的 HTML、`/api/v1/plugins/{id}/...` 路由 | 不能访问文件/网络/环境变量、不能直接读写数据库、不能改宿主中间件 |
| **创作者扩展（T0）** | 站点后台里的 HTML / CSS / JS 三段文本 | 浏览器 `sandbox="allow-scripts"` iframe（无 `allow-same-origin`） | 8 个固定 DOM 槽位里的内容、6 种受限桥能力 | 不能改 React 树、不能加区块类型/路由、不能碰后端、拿不到主站 DOM/Cookie |

三者的共同点是「按站点或按安装授权、由宿主提供接缝」；不同点是**信任模型完全不同**，因此接口也完全不同。前端扩展与后端扩展共享同一份 `plugin.json` 与同一套权限词汇；创作者扩展不读 `plugin.json`，它的清单就是站点配置里的 `CustomExtension` 对象。

## 2. 形态一：前端扩展（浏览器运行时插件）

### 2.1 定义

前端扩展是一个**同源经典脚本**（classic script，不是 ESM），通过全局函数注册一个 CJS 风格的工厂：

```js
window.__PP_PLUGIN_REGISTER__('com.example.hello', '1.0.0', function (require, module, exports) {
  var React = require('react');
  module.exports = {
    activate: function (ctx) {
      ctx.slots.register('article.after', 'footer', function () {
        return React.createElement('div', null, 'Hello');
      });
    },
  };
});
```

宿主在 `activate(ctx)` 时把槽位渲染函数、区块渲染函数、样式登记到运行时注册表；页面里已有的 `<PluginSlot>` 与区块视图通过 `useSyncExternalStore` 订阅注册表，因此**注册/注销会就地增量渲染，不需要刷新页面**（前提是页面已经挂了对应的槽位组件，见 §2.4）。

### 2.2 它能做什么（v1 实际开放的接口）

| 能力 | API | 权限 | 说明 |
| --- | --- | --- | --- |
| 填槽位 | `ctx.slots.register(slot, id, render, {order})` | `ui.inject` + 清单声明该 slot | 8 个宿主槽位闭集 |
| 新区块类型 | `ctx.blocks.register(type, renderer)` | `ui.block` + 清单声明该 type | 只能新增，内置类型优先 |
| 注入样式 | `ctx.ui.addStyle(css)` | `ui.style` | 一条 `<style data-pp-plugin>`，卸载移除 |
| 调同源 API | `ctx.api.fetch('/api/...')` | 无单独权限 | 只接受 `/api/` 前缀，带同源 Cookie |
| 日志 | `ctx.log(...)` | 无 | `console.debug`，前缀插件 id |
| 读上下文 | `ctx.plugin` / `ctx.site` | 无 | `{id, version}` / `{id}` |

未开放：主题 token 注册、前端路由注册、设置页注册、编辑器工具注册、HMR。设计文档把它们放在 P2/P3，代码里没有对应 API（`PluginContext` 只有 `slots` / `blocks` / `ui` / `api` / `log`）。

### 2.3 边界与信任

- **不是沙箱。** 同源脚本可以读 `document`、Cookie（HttpOnly 除外）、`localStorage`、发任意同源请求，也可以访问 `window` 上的其他对象。权限检查只保证「插件没有声明就不能占用某个槽位/区块/样式」，不阻止恶意代码。
- **不能跨源加载 bundle。** `assertSameOriginBundle` 校验 `entry` 与页面同源且路径以 `/plugins/` 开头；这是硬性拒绝。
- **不能加载未登记模块。** 工厂只能 `require` 冻结模块表里的 5 个包；其他一律抛错。这是为了避免 React 双实例与供应链扩散，不是安全边界。
- **没有服务端能力。** 想改文章 HTML 或加后端路由，必须用后端扩展；前端扩展通过 `ctx.api.fetch` 调宿主 API 或插件路由。

### 2.4 当前接入状态（重要）

| 环节 | 状态 | 证据 |
| --- | --- | --- |
| 运行时库（加载/注册/卸载/错误隔离） | 🧪 Spike 已实现 | `apps/web/src/lib/plugins/runtime.ts` + `runtime.test.ts` |
| 槽位注册表 / 区块注册表 | 🧪 Spike 已实现 | `registry.ts`、`PluginSlot.tsx`、`blockRegistry.test.ts` |
| 启动入口 | 🟡 未接入 | 全仓库没有调用 `defaultPluginRuntime.start()`；`App.tsx` 无引用 |
| 页面槽位锚点 | 🟡 未接入 | 全仓库没有渲染 `<PluginSlot>` 的产品页面，只有测试 |
| 区块渲染接入 | 🧪 已接到 `BlockView` | `components/blocks/index.tsx:138` 订阅 `pluginBlockRegistry` |
| 安装器/管理页/按站点启用 | 🟡 未实现 | 无对应路由、页面、存储 |

结论：前端扩展的**协议已经可用**（你可以在测试或自己的宿主里跑通），但**产品页面还不会加载任何插件**。在接入之前，`GET /api/v1/plugins` 在生产进程里也不存在（见 §4.2）。

## 3. 形态二：后端扩展（WASM 服务端插件）

### 3.1 定义

后端扩展是一个预编译的 WebAssembly 模块，必须用 Go `wasip1` 构建：

```powershell
$env:GOOS = "wasip1"; $env:GOARCH = "wasm"
go build -o backend/hello.wasm .
```

宿主为每个插件创建一个独立 wazero runtime，每次调用实例化一次模块，把请求 JSON 写进 stdin、从 stdout 读一个 JSON 信封。ABI 名为 `wasi-json-v1`。

### 3.2 它能做什么（v1 实际开放）

| 能力 | 接口 | 权限 | 说明 |
| --- | --- | --- | --- |
| 改渲染 HTML | `content.render` 钩子 | `content.render` | 链式：上一个插件的输出是下一个的输入 |
| 提供 HTTP 路由 | `backend.routes` + `/api/v1/plugins/{id}{path}` | `http.route.public` / `http.route.member` / `admin.route` | 鉴权由宿主在进沙箱前完成 |
| 读内容生命周期事件 | `content.after_create/update/delete` | `content.write` | **清单接受，但没有派发代码**（见 §3.4） |

未开放：站点 KV、`http_fetch`、`settings_get`、`log`、`now` 等宿主函数；数据库/迁移；文件与网络；中间件/鉴权策略；主题/SEO/feed/sitemap 钩子。ABI v2 才计划这些。

### 3.3 边界与信任

- **真正的隔离边界（在 wazero 无漏洞的前提下）。** 没有 preopen 文件系统、没有环境变量、没有 socket；插件只能看到本次调用的 stdin 和清单授予的能力列表。
- **有资源边界。** 每插件独立 runtime，内存上限 `max_memory_mb`（默认 128 MB，上限 512 MB），调用超时默认 500 ms（清单可设 `0` 用默认，或 `1–30000 ms`），stdout 上限 4 MiB，stderr 保留 4 KiB，内容 HTML 结果上限 8 MiB，请求体上限 1 MiB。
- **不能自授权。** 清单声明 hook/route 却缺少对应权限，安装直接失败。
- **失败策略是 fail-open（内容钩子）/ 502（路由）。** 一个插件失败不会让文章发布失败；路由失败返回统一 problem JSON，不把 stderr 或内部路径回给客户端。

### 3.4 当前接入状态

| 环节 | 状态 | 证据 |
| --- | --- | --- |
| 清单校验 + 安装/启用/禁用/卸载 | 🧪 Spike 已实现 | `manifest.go`、`host.go`、`host_test.go` |
| WASM 调用 + `content.render` | 🧪 Spike 已实现 | `Host.TransformHTML` + 测试 |
| 插件路由 + 鉴权 + 限额 | 🧪 Spike 已实现（库级） | `Host.APIHandler` + `host_test.go` |
| 浏览器资产服务 | 🧪 Spike 已实现（库级） | `Host.AssetHandler` + 测试 |
| 契约合并 | 🧪 Spike 已实现（库级） | `contract.go` + 测试 |
| 生产进程构造宿主 | 🟡 未接入 | `cmd/server` 不 import `plugins`，`Dependencies.Plugins` 恒为 nil |
| 内容管线调用 `TransformHTML` | 🟡 未接入 | 除测试外无调用方 |
| `content.after_*` 派发 | 🟡 未实现 | 只在 `knownHooks` 白名单里，无执行代码 |
| 安装器 / 管理 API / 按站点启用 / 签名 / 审计 | 🟡 未实现 | 无路由、无表、无页面 |

因此：**插件协议是 spike 级真实可跑的，但当前发行版不会加载任何后端插件。** 生产里 `/api/v1/plugins`、`/api/v1/plugins/{id}/...`、`/plugins/{id}/{version}/...` 都不存在，`/api/v1/openapi.json` 也不含插件 operation。

## 4. 现有「创作者扩展」在体系中的位置（T0）

### 4.1 它是什么

创作者扩展是**站点级、不可信、可自助安装的 UI 片段**，已经上线：

- 入口：后台 `/admin/extensions`（`ExtensionsPage`）；前台由 `ExtensionRuntime` 在真实 DOM 锚点处用 `createPortal` 挂载 iframe。
- 存储：站点外观/自定义配置 JSON 里的 `custom_extensions: CustomExtension[]`，单站最多 20 个（`MAX_CUSTOM_EXTENSIONS = 20`）。
- 执行：`ExtensionHost` 用 `srcdoc` 构造文档，`<iframe sandbox="allow-scripts">`——没有 `allow-same-origin`，因此是独立的不透明源，拿不到主站 DOM、Cookie、`localStorage`。
- 样式：文档内联 reset + 扩展 CSS；CSP 为 `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src https: data:; font-src data:`。
- 通信：宿主与 iframe 只通过 `postMessage` 桥；宿主校验 `event.source === iframe.contentWindow`、`pp === true`、`id` 匹配，再按消息类型查权限。
- 生命周期：保存后 `updated_at` 变化 → `key` 变化 → iframe 重新挂载；**不会刷新整个页面**，只重载该扩展的 iframe。

### 4.2 它的接口（与插件接口无关，但常被混为一谈）

| 维度 | 取值 |
| --- | --- |
| DOM 槽位（8） | `site_header`、`site_footer`、`home_top`、`home_bottom`、`article_top`、`article_bottom`、`article_side`、`floating` |
| 页面范围（5） | `all`、`home`、`article`、`list`、`search` |
| 权限（6） | `notify`、`open_link`、`navigate`、`clipboard`、`theme`、`storage` |
| 单扩展内容上限 | HTML 80,000 字符、CSS 40,000、JS 80,000 |
| 清单字段上限 | name 60、version 24、author 60、description 400、icon 4 |
| 导入/导出格式 | `.ppext.json`，`format: "practacu-extension"` / `"practacu-extensions"`，version 1 |
| 沙箱桥 | `PP.getContext()`、`PP.getTheme()`、`PP.notify()`、`PP.open()`、`PP.navigate()`、`PP.copy()`、`PP.setHeight()`、`PP.storage.get/set()` |

设计文档建议未来加一个 `IframeSlot` 适配器，把 `CustomExtension` 映射到新的命名槽位注册表。**该适配器尚未实现**；当前 T0 与 T1 是两套独立运行时（DOM 锚点 vs. React 槽位）。

### 4.3 为什么保留它

- 它是目前唯一经过验证的**不可信第三方 UI 边界**（无同源权限）。
- T1 前端插件一旦接入就是同源任意代码，不适合自助安装。
- 二者是不同轴：T0 解决「站长想贴一小段 HTML/JS」；T1/T2 解决「开发者想扩展系统能力」。

### 4.4 选择建议

```text
需要改页面上的某一块展示？
├─ 是站长自己写一小段 HTML/CSS/JS，且来源不完全可信
│   → 创作者扩展（T0，已上线）
└─ 是开发者交付可复用组件，需要 React/主题能力
    → 前端扩展（T1，协议可用、待接入）
需要改文章 HTML、加后端路由、接第三方服务？
├─ 需要文件/网络/数据库
│   → 目前没有安全通道；T3 原生插件仅设计
└─ 纯函数式 HTML 变换 / 简单 HTTP 响应
    → 后端扩展（T2，协议可用、待接入）
```

## 5. 三平面与加载流程

```text
① 分发平面（未实现）
   data/plugins/<id>/<version>/plugin.json + frontend/ + backend/
   → 安装器校验清单/哈希 → 记录启用状态
        │
        ├──────────────────────────────┐
        ▼                              ▼
② 服务端宿主平面（库已实现）      ③ 浏览器宿主平面（库已实现）
   GET /api/v1/plugins               GET /api/v1/plugins（boot manifest）
   → PublicPlugins()                 → <script src="/plugins/{id}/{ver}/client.js">
   → Host.APIHandler                   → __PP_PLUGIN_REGISTER__(id, ver, factory)
   → Host.AssetHandler                 → materialize(factory, 冻结模块表)
   → Host.TransformHTML                → definition.activate(ctx)
   → ContractJSON                      → SlotRegistry / BlockRegistry 通知 React
```

当前真实情况：②③ 的每个箭头都在代码里，但 ① 不存在，且 ②③ 没有被生产入口调用。**所以本文的 HTTP 示例需要用 `go test` 或自建宿主复现，不能对着已安装的发行版直接 curl。**

### 5.1 同一个插件的两半如何协作

一个插件可以同时有 `frontend` 与 `backend`（参考插件 `com.example.hello` 就是如此）：

```text
前端槽位/区块                     后端 WASM
  ctx.slots.register(...)           content.render：改写文章 HTML
  ctx.api.fetch('/api/v1/plugins/com.example.hello/hello')
        │                                    ▲
        └──────── HTTP（宿主鉴权后）─────────┘
```

- 前端不能直接调用 WASM 函数；它只能通过**插件路由**（`/api/v1/plugins/{id}/...`）或宿主 API 与后端交互。
- 路由的 `auth` 由宿主的 gin 中间件在进入 WASM 之前完成；WASM 只拿到 `site_id/user_id/role`。
- 前端与后端共享 `plugin.json` 的 `permissions`，但**各自只用到其中一部分**：`ui.*` 给前端，`content.*`/`http.route.*`/`admin.route` 给后端。
- 两半的失败互不影响：前端激活失败只影响 UI；后端钩子失败只跳过该插件；后端路由失败返回 502。

## 6. 能力与现状矩阵

| 能力 | 设计文档 | 代码 | 状态 |
| --- | --- | --- | --- |
| `plugin.json` 严格校验（未知字段/权限/路径/semver） | ✅ | ✅ | 🧪 |
| 安装/启用/禁用/卸载（内存态） | ✅ | ✅ | 🧪 |
| 每插件 WASM runtime + 内存/超时 | ✅ | ✅ | 🧪 |
| `content.render` 链式变换 | ✅ | ✅ | 🧪（未接内容管线） |
| `content.after_create/update/delete` | ✅ | 仅白名单 | 🟡 |
| 插件路由 + public/member/admin 鉴权 | ✅ | ✅ | 🧪 |
| 请求/响应头白名单 | ✅ | ✅ | 🧪 |
| 请求体 1 MiB / 响应 4 MiB / HTML 8 MiB | ✅ | ✅ | 🧪 |
| 插件资产 `/plugins/...`（ETag/304/穿越防护） | ✅ | ✅ | 🧪 |
| 契约合并 + 冲突检测 | ✅ | ✅（合并时检测） | 🧪 |
| 前端 boot manifest | ✅ | ✅ | 🧪 |
| 冻结模块表 + 无 eval | ✅ | ✅ | 🧪 |
| 槽位/区块/样式注册 + 权限拒绝 | ✅ | ✅ | 🧪 |
| 错误边界/卸载清理 | ✅ | ✅ | 🧪 |
| 主题 token / 前端路由 / 设置页扩展 | P2/P3 | 无 | 🟡 |
| 站点 KV / HTTP fetch / 设置注入 | P2 | 无 | 🟡 |
| 安装器 / 管理页 / 按站点启停 / 回滚 | P1 | 无 | 🟡 |
| 签名 / 哈希校验 / SBOM / 市场 | P1–P3 | 无 | 🟡 |
| 审计 / 指标 / 失败自动禁用 / drain | P1–P2 | 无 | 🟡 |
| 安全服务扫描插件 HTML | P1 | 无 | 🟡 |
| T3 原生插件 | P3 | 无 | 💭 |
| 创作者扩展（T0） | 已存在 | ✅ | ✅ |

## 7. 多租户与站点边界（现状）

- 宿主是**进程级单例**，`Install/Enable/PublicPlugins` 没有 `site_id` 参数；因此「A 站启用、B 站不可见」**没有实现**。
- 插件路由能从 gin 上下文拿到 `SiteID` 并传给插件 payload，但宿主不按站点过滤插件；同一进程内所有站点共享同一份启用集合。
- 创作者扩展是**按站点配置**的（存在站点 customization 里），这是 T0 与 T1/T2 当前最大的行为差异。
- 设计文档要求插件启用按站点隔离、KV 以 site 为键、跨站测试；这些都在 P1/P2，未落地。

## 8. 边界清单（评审时逐条确认）

1. 前端扩展 = 同源任意代码；**不要**对第三方开放自助安装。
2. 后端扩展 v1 = 纯函数；**不要**在文档或市场文案里承诺 KV/网络/DB，直到 ABI v2 落地。
3. 创作者扩展是唯一可自助的不可信 UI 通道；保留它，不要用 T1 替代。
4. 任何插件产生的 HTML 在真实产品里都必须再过 `services/security`；当前代码没有这一步（见 [05-compatibility-gaps.md](05-compatibility-gaps.md)）。
5. 在 `cmd/server` 构造宿主、在内容管线调用 `TransformHTML`、在页面挂 `<PluginSlot>` 之前，所有插件能力都只是开发者可复现的 spike，不是产品功能。
