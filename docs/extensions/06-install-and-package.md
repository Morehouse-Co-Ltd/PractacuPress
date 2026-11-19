# 06 · 扩展包安装、导入与开发手册

- 上级文档：[README.md](README.md)
- 相关：[02-manifest.md](02-manifest.md) · [03-frontend-api.md](03-frontend-api.md) · [04-backend-api.md](04-backend-api.md)
- 适用代码：`apps/api/internal/extensions/`（安装与管理）、`apps/api/internal/plugins/`（宿主）、`apps/web/src/lib/plugins/`、`apps/web/src/lib/extensions/`、`apps/web/src/pages/admin/Extensions.tsx`

> **当前状态（2026-11-13）**：扩展已经从「spike」接入产品。后台「扩展」页可以
> 导入 zip 扩展包、启用/禁用、删除；前端扩展由插件运行时加载，后端扩展在
> API 进程内的 wazero 沙箱里执行；性能面板本身就是一个内置扩展。

## 1. 两种扩展，一个扩展包

| 类型 | 包含 | 运行位置 | 能力 |
| --- | --- | --- | --- |
| **纯前端扩展** | `frontend/client.js` | 浏览器，与页面同源 | 注册后台页面/导航、槽位、区块、样式；可调用同源 `/api` |
| **后端扩展（可带前端）** | `backend/*.wasm`（+ 可选 `frontend/`） | API 进程内 wazero 沙箱 | 插件自有 HTTP 路由（`/api/v1/plugins/{id}/...`）、`content.render` 内容钩子；前端通过 `ctx.api.fetch` 调用 |

纯前端扩展**不是沙箱**：它等同于站点自己的脚本，能读 DOM、Cookie 与非 HttpOnly
存储。后端扩展是真正的隔离边界（无文件、网络、环境变量），但 ABI 能力有限。
两者都只有**平台管理员**能安装。

## 2. 扩展包格式

扩展包是一个 zip，**`plugin.json` 必须在 zip 根级**：

```
my-extension.zip
  plugin.json
  frontend/
    client.js            # 可选；纯前端或后端扩展的前端半边
    client.css           # 可选
  backend/
    main.go              # 可选；仅开发源码，随包分发时可不带
    my-extension.wasm    # backend.entry 指向的 WASI 模块
  README.md              # 可选
```

限制与校验（安装时执行）：

- zip 文件 ≤ 32 MiB，解压后总量 ≤ 64 MiB，文件数 ≤ 200；
- 拒绝路径穿越（`..`）、绝对路径、符号链接与 Windows 保留字符；
- `plugin.json` 必须通过 [`02-manifest.md`](02-manifest.md) 的全部校验；
- 后端 WASM 必须在安装时编译成功（wasm 语法与 ABI 取决于模块自身）；
- 同一 id 再次导入视为升级：先卸载旧版本，替换目录，保留原来的启用/禁用状态。

## 3. `plugin.json` 最小示例

### 3.1 纯前端扩展

```json
{
  "manifest_version": 1,
  "id": "com.example.hello-admin",
  "name": "Hello Admin",
  "version": "1.0.0",
  "description": "在后台注册一个扩展页面。",
  "engines": { "pp": ">=0.1.0 <1.0.0" },
  "runtime": "none",
  "frontend": { "entry": "frontend/client.js" },
  "permissions": ["ui.inject"]
}
```

### 3.2 后端扩展（可带前端）

```json
{
  "manifest_version": 1,
  "id": "com.example.hello",
  "name": "Hello PP",
  "version": "1.0.0",
  "engines": { "pp": ">=0.1.0 <1.0.0" },
  "runtime": "wasm",
  "backend": {
    "entry": "backend/hello.wasm",
    "abi": "wasi-json-v1",
    "timeout_ms": 300,
    "max_memory_mb": 64,
    "hooks": ["content.render"],
    "routes": [
      { "method": "GET", "path": "/hello", "auth": "public" },
      { "method": "GET", "path": "/admin/ping", "auth": "admin" }
    ]
  },
  "frontend": { "entry": "frontend/client.js", "slots": ["article.after"], "blocks": [{ "type": "hello.card", "name": "Hello card" }] },
  "permissions": ["content.render", "http.route.public", "admin.route", "ui.inject", "ui.block"]
}
```

`runtime` 只能是 `none`（不允许 backend）或 `wasm`（必须声明 backend）；权限是闭集，
每个 hook/route/前端能力都要求对应权限，缺一条安装直接失败。

## 4. 前端扩展怎么写

前端产物是**经典脚本**（不是 ES module），尾部调用全局注册函数：

```js
window.__PP_PLUGIN_REGISTER__('com.example.hello-admin', '1.0.0', function (require, module) {
  var React = require('react');

  function Page() {
    return React.createElement('div', { className: 'panel' }, 'Hello from an extension');
  }

  module.exports = {
    activate: function (ctx) {
      ctx.admin.registerPage({
        id: 'hello-admin',
        path: 'hello-admin',            // → /admin/ext/hello-admin
        label: 'Hello Admin',
        icon: 'info',
        group: 'extensions',            // 'overview' 排在仪表盘下方；默认 'extensions'
        order: 10,
        description: '示例页面',
        render: function () { return React.createElement(Page); },
      });
    },
  };
});
```

可用 `ctx`（v1 实际开放）：

| API | 权限 | 说明 |
| --- | --- | --- |
| `ctx.admin.registerPage(page)` | `ui.inject` | 注册后台页面与导航。`page = {id, path, label, icon?, group?, order?, description?, render}`；路径 `/admin/ext/<path>`，宿主负责路由；必须返回 React 节点 |
| `ctx.slots.register(slot, id, render, {order})` | `ui.inject` + 清单 `slots` | 8 个前台槽位闭集 |
| `ctx.blocks.register(type, renderer)` | `ui.block` + 清单 `blocks` | 只能新增区块类型，不能覆盖内置 |
| `ctx.ui.addStyle(css)` | `ui.style` | 注入一个 `<style data-pp-plugin>` |
| `ctx.api.fetch(path, init)` | — | 只接受 `/api/` 前缀，同源 Cookie |
| `ctx.log(...)` | — | 带插件前缀的 debug 日志 |

冻结模块表：`react`、`react-dom`、`react-dom/client`、`react/jsx-runtime`、
`react-router-dom`。其余 `require` 会抛错。用 esbuild/tsx 打包时把这五个 external，
再拼上注册尾部即可。

后台页面是否展示给某个角色由扩展自己决定（如性能面板只允许平台管理员）；宿主只负责
导航与路由。页面组件必须是普通 React 组件，宿主不提供 hooks 之外的全局对象。

## 5. 后端扩展怎么写（Go → WASI）

```powershell
# backend/ 里放 main.go + go.mod（可选）
$env:GOOS = 'wasip1'; $env:GOARCH = 'wasm'
go build -trimpath -ldflags="-s -w" -o backend/hello.wasm .
```

宿主每次调用实例化一次模块，向 stdin 写一个 JSON，要求 stdout 输出一个 JSON：

```jsonc
// stdin
{ "abi": "wasi-json-v1", "plugin_id": "com.example.hello", "version": "1.0.0",
  "route": "/hello", "handler": "hello",
  "payload": { "method": "GET", "path": "/hello", "query": {}, "headers": {},
               "body": "", "site_id": "...", "user_id": "...", "role": "visitor" },
  "capabilities": ["..." ] }

// stdout
{ "status": 200, "headers": { "Content-Type": "application/json" },
  "body": "{\"message\":\"hello\"}" }
```

- 输入/输出限制：请求体 ≤ 1 MiB、响应体 ≤ 4 MiB、stdout ≤ 4 MiB、stderr 只保留 4 KiB；
- 超时默认 500 ms（清单可设 1–30000 ms；`0` 用默认），内存默认 128 MiB（上限 512）；
- 无文件系统、无网络、无环境变量；需要数据就让前端把数据放进请求，或用站点既有 API；
- 路由鉴权由宿主在进沙箱前完成：`public` / `member` / `admin`；
- `content.render` 钩子按插件安装顺序链式执行，失败会被跳过（fail-open），文章不会挂。

完整 ABI 与错误码见 [`04-backend-api.md`](04-backend-api.md)。

## 6. 打包、导入与管理

### 6.1 打包

```powershell
# 仓库根目录
powershell -ExecutionPolicy Bypass -File scripts\package-extension.ps1 -Dir internal\plugins\examples\hello-admin
powershell -ExecutionPolicy Bypass -File scripts\package-extension.ps1 -Dir internal\plugins\examples\hello
# 产物：dist\extensions\<id>-<version>.zip
```

脚本会校验 `plugin.json`、检查前端文件，并在缺少 WASM 时用 Go 现场构建；安装器
**永远不会**执行构建或 `npm install`。

### 6.2 后台导入

`扩展` 页顶部 →「导入扩展」选择 zip。成功后会出现在左侧横条列表里，并自动选中
右侧详情：

- 「启用 / 禁用」：更新启动清单；前端扩展页面刷新后生效，后端路由立即生效；
- 「删除」：卸载并删除磁盘上的扩展目录；
- 内置扩展（如性能面板）由程序发布，显示「内置」徽标，不能删除。

### 6.3 API（平台管理员）

```bash
BASE=http://127.0.0.1:8080/api/v1
TOKEN=<平台管理员 access token>

curl -s "$BASE/extensions" -H "Authorization: Bearer $TOKEN"

curl -s -X POST "$BASE/extensions/import" \
  -H "Authorization: Bearer $TOKEN" \
  -F "package=@dist/extensions/com.example.hello-admin-1.0.0.zip"

curl -s -X PATCH "$BASE/extensions/com.example.hello-admin" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"enabled":false}'

curl -s -X DELETE "$BASE/extensions/com.example.hello-admin" \
  -H "Authorization: Bearer $TOKEN"
```

响应：列表 `{"items":[...]}`，导入/启用 `{"extension":{...}}`，删除 204。
`extension` 里包含 `state/enabled/permissions/frontend/backend/last_error` 等字段，
前端管理页直接消费。

### 6.4 存储

- 扩展目录：`<data>/extensions/<id>/`（`data` 默认是启动器/API 的 data 目录）；
- 启用状态：`<data>/extensions/state.json`，重启后恢复；
- 删除扩展会同时删除目录与状态；备份 `data/` 时扩展会一起备份。

### 6.5 反向代理要求

扩展前端 bundle 通过 `/plugins/<id>/<version>/...` 提供，脚本必须与页面**同源**，否则浏览器
拒绝执行。仓库内已同步：

- Vite 开发服务器：`vite.config.ts` 把 `/plugins` 代理到 API（与 `/api` 相同）；
- Windows 启动器：`isAPIPath` 把 `/plugins/` 转发给本机 API；
- Docker：`deploy/docker/nginx.conf` 增加 `location /plugins/`；
- 生产 Nginx 配置：静态与 API 都走 `location /` 的 API 代理，无需额外配置。

自建反向代理时，请把 `/api/` 与 `/plugins/` 一起转发到 API 进程，并保留 `Host` 头
（站点按 Host 解析）。zip 包里的路径分隔符：Windows PowerShell 的
`Compress-Archive` / .NET Framework 会写成 `\`，API 会把 `\` 规范化为 `/` 后继续校验；
`scripts/package-extension.ps1` 生成的包直接使用 `/`。

## 7. 安全边界与审查清单

1. **只安装可信来源**。前端扩展与后台同源，可读 Cookie、可发同源请求；权限清单
   只防「未声明的组合」，不是沙箱。不可信的第三方代码不要装成前端扩展；原「创作者扩展」
   的后台管理入口已在扩展页改版中移除。
2. 后端扩展在 wazero 沙箱内运行，但没有宿主函数（不能读写数据库/文件），能力面
   由清单与 ABI 决定。
3. 安装包大小、文件数、解压总量、wasm 编译与内存/超时都有上限；路径穿越、符号链接
   会被拒绝。
4. 每次升级前先在测试实例导入一次：坏包只会影响安装本身，不会破坏既有站点数据。

## 8. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 导入 400 `invalid manifest` | `manifest_version` 不是 1、id 不是小写反域名、`runtime`/权限不匹配；错误 details 里有原因 |
| 导入 400 且提示 entry 缺失 | `frontend.entry` / `backend.entry` 必须相对扩展根目录且指向存在的文件 |
| 页面出现「扩展」但后台没有新页面 | 前端 bundle 没有调用 `ctx.admin.registerPage`，或 `group`/`path` 被占用；看浏览器控制台 `[pp plugin ...]` |
| 后端路由 404 | 扩展被禁用，或清单没有声明该 method+path；启用状态在「扩展」页确认 |
| 后端路由 502 | WASM 返回非 2xx-5xx 状态/非法 JSON/超时；查看 API 日志与 `last_error` |
| 改完前端代码页面没变 | 重新打 zip 导入升级（会替换同 id 扩展），再刷新页面 |

## 9. 参考实现

- 纯前端后台页面：[`internal/plugins/examples/hello-admin`](../../internal/plugins/examples/hello-admin/README.md)
- 前端 + Go/WASM 后端：[`internal/plugins/examples/hello`](../../internal/plugins/examples/hello/README.md)（来源与
  `apps/api/internal/plugins/testdata/hello` 相同）
- 宿主实现：`apps/api/internal/plugins/host.go`、`manifest.go`；运行时：
  `apps/web/src/lib/plugins/runtime.ts`、`adminRegistry.ts`
