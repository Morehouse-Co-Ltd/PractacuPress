# 04 · 后端扩展接口（WASM 服务端插件）

- 上级文档：[README.md](README.md)
- 源码：`apps/api/internal/plugins/host.go`、`manifest.go`、`contract.go`、`apps/api/internal/transport/http/gin/router.go:241`
- 示例插件：`apps/api/internal/plugins/testdata/hello/backend/main.go`
- 测试：`host_test.go`、`zz_timeout_test.go`、`plugin_route_test.go`
- 状态：🧪 **Spike 已实现，生产未接入**（`cmd/server` 不构造 `plugins.Host`，内容管线不调用 `TransformHTML`）

## 1. 运行模型

```text
Host（进程级）
 └─ Plugin（每插件）
     ├─ wazero.Runtime        独立运行时；内存上限按清单
     ├─ wazero.CompiledModule 安装时编译一次，后续复用
     └─ Manifest              授权来源
          │
          └─ 每次调用：InstantiateModule → 新实例 → 写 stdin → 读 stdout → 关实例
```

| 项 | 事实 |
| --- | --- |
| 隔离粒度 | **每插件一个 wazero runtime**；不是全局 runtime + 每插件内存上限 |
| 模块生命周期 | `Install` 时编译；`Enable` 只改状态；`Remove/Close` 关闭 runtime |
| 调用实例 | **每次调用新建一个模块实例**（`InstantiateModule`），调用结束关闭 |
| 并发 | 宿主读锁内允许多个调用并发；同一插件的多个实例可同时存在。插件不要依赖跨调用全局状态 |
| 宿主函数 | v1 **不注入任何自定义 host function**；只有 wazero 的 WASI preview1 |
| 文件系统 | 没有 preopen，`open` 类调用失败 |
| 网络 | WASI preview1 没有 socket；插件无法联网 |
| 环境变量 | 不传（`WithEnv` 未调用） |
| 参数 | `os.Args = ["pp-plugin"]`（`WithArgs("pp-plugin")`） |
| 时钟 | 开启 `WithSysWalltime` / `WithSysNanotime` / `WithSysNanosleep`；`time.Sleep` 可用（但会被超时打断） |
| 入口 | `_start`（`WithStartFunctions("_start")`）；Go `wasip1` 构建天然满足 |

## 2. 构建产物要求

| 项 | 要求 |
| --- | --- |
| 目标平台 | `GOOS=wasip1`、`GOARCH=wasm` |
| 语言 | 参考实现是 Go；任何能产出 WASI preview1 `.wasm` 且遵守 ABI 的语言都可以 |
| CGO | 必须关闭（`wasip1` 默认不支持 CGO） |
| 入口 | 必须导出 `_start` |
| 文件 | 清单 `backend.entry` 指向 `.wasm`，必须是插件目录内的普通文件 |
| 大小 | 单文件无显式上限，但安装要读进内存并编译；参考插件约 4.4 MiB |
| 依赖 | 不能依赖宿主进程的库/文件；所有逻辑必须编进模块 |
| 构建时机 | **安装器不构建**；发布包必须带预编译产物（安装器只校验/编译） |

参考命令（`scripts/build-plugin-wasm.ps1` 的核心）：

```powershell
$env:GOOS = 'wasip1'
$env:GOARCH = 'wasm'
Push-Location backend
go build -trimpath -ldflags="-s -w" -o hello.wasm .
Pop-Location
```

`go.mod` 需要足够新的 Go 版本（参考插件写的是 `go 1.26`）。最小 `main.go`：

```go
package main

import (
	"encoding/json"
	"io"
	"os"
)

func main() {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		fail("read_error", err.Error())
		return
	}
	// 解析 raw、按 hook/route 分支、向 os.Stdout 写一个 JSON 信封
	_ = raw
	_ = json.Marshal
}

func fail(code, message string) {
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{
		"ok":    false,
		"error": map[string]string{"code": code, "message": message},
	})
}
```

## 3. WASI JSON ABI v1

### 3.1 请求信封（宿主 → 插件 stdin）

一次调用写一个 JSON 对象，然后关闭 stdin。结构对应 `host.go` 的 `wasmRequest`：

```json
{
  "abi": "wasi-json-v1",
  "plugin_id": "com.example.hello",
  "version": "1.0.0",
  "hook": "content.render",
  "route": "/hello",
  "handler": "hello",
  "payload": {},
  "capabilities": ["content.render"]
}
```

| 字段 | 类型 | 出现时机 | 说明 |
| --- | --- | --- | --- |
| `abi` | string | 总是 | 固定 `"wasi-json-v1"` |
| `plugin_id` | string | 总是 | 清单 id |
| `version` | string | 总是 | 清单 version |
| `hook` | string? | 钩子调用 | `content.render`（v1 唯一实际派发的 hook） |
| `route` | string? | 路由调用 | **清单里声明的 path**（如 `/hello`），不是完整 URL |
| `handler` | string? | 路由调用 | 清单 `handler` 原样透传；可为空 |
| `payload` | object? | 总是（有值） | 钩子 payload 或 HTTP payload，见 §4/§5 |
| `capabilities` | string[]? | 总是 | 清单权限去重 + 字母序；与清单一致，不是插件自报 |

`hook` / `route` / `handler` / `payload` / `capabilities` 都带 `omitempty`；实际调用中钩子有 `hook`，路由有 `route`/`handler`，两者至少有一个。

### 3.2 响应信封（插件 → 宿主 stdout）

成功：

```json
{ "ok": true, "result": { "html": "<p>...</p>" } }
```

失败：

```json
{ "ok": false, "error": { "code": "bad_payload", "message": "unexpected end of JSON input" } }
```

结构对应 `wasmResponse`：

| 字段 | 类型 | 必须 | 说明 |
| --- | --- | --- | --- |
| `ok` | bool | 是 | 缺失按 `false` 处理 |
| `result` | any | `ok:true` 时 | 钩子：`{"html": string}`；路由：`{"status": number, "headers": object, "body": string}` |
| `error.code` | string | `ok:false` 时 | 缺省 `plugin_error`；只进宿主日志，不回给客户端 |
| `error.message` | string | `ok:false` 时 | 缺省 `plugin returned an error`；同样不回给客户端 |

宿主对 stdout 的硬性要求：

1. **只能写一个 JSON 值**。前后空白可以，多个对象/日志混在 stdout 会解析失败。
2. **stdout 总大小 ≤ 4 MiB**（`MaxResponseBody`）。超出时宿主丢弃并报错，不截断成合法响应。
3. **stderr 只用于调试**。最多保留 4 KiB；JSON 解析失败时，错误信息里会带 stderr 前 256 字节。stderr 不会回给 HTTP 客户端。
4. **进程必须以 0 退出**（Go `main` 正常返回）。非零退出会让 `InstantiateModule` 返回错误。
5. **不要依赖 stdin 之后的输入**；宿主写完就关。

### 3.3 超时与取消

| 项 | 值 |
| --- | --- |
| 默认超时 | 500 ms（`DefaultTimeout`） |
| 清单覆盖 | `backend.timeout_ms`，1–30000 ms；`0` 用默认 |
| 宿主级覆盖 | `Options.DefaultTimeout`（嵌入方可改；生产未接入） |
| 实现 | `context.WithTimeout` + `WithCloseOnContextDone(true)`；另有一个 goroutine 在 deadline 时关闭该插件 runtime |
| 路由超时结果 | HTTP 502 `plugin_error`，detail 固定 `plugin failed to handle the request` |
| 钩子超时结果 | 跳过该插件，保留上一个插件的 HTML，记录 `slog.Warn` |
| 副作用 | **超时会关闭该插件的 runtime**。此后同一插件再被调用会失败，直到 `Remove` 后重新 `Install`；`State` 仍是 `enabled` |

`zz_timeout_test.go` 用 `?sleep=1` 触发插件内 `time.Sleep(2s)`，验证 300 ms 内返回 502。

## 4. 内容钩子

### 4.1 Hook 表（v1）

| Hook | 触发时机 | 输入 | 期望输出 | 权限 | 失败策略 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| `content.render` | 文章/页面 HTML 渲染后、输出/落库前（宿主方法 `TransformHTML`） | `HookPayload` | `{"html": string}` | `content.render` | 跳过该插件，保留前值，记日志 | 🧪 方法已实现，内容管线未调用 |
| `content.after_create` | 内容创建事务提交后 | 未定义 | 无 | `content.write` | 记录，不回滚 | 🟡 仅白名单，无派发 |
| `content.after_update` | 内容更新事务提交后 | 未定义 | 无 | `content.write` | 记录，不回滚 | 🟡 仅白名单，无派发 |
| `content.after_delete` | 内容删除事务提交后 | 未定义 | 无 | `content.write` | 记录，不回滚 | 🟡 仅白名单，无派发 |

`content.read` 权限存在，但 v1 没有对应 hook。

### 4.2 `content.render`

宿主 `TransformHTML(ctx, payload)` 的行为：

1. 取当前所有 **enabled + 有 backend + hooks 含 `content.render`** 的插件，按**安装顺序**串成链。
2. 对每个插件：
   - 复制 payload，把 `html` 设为上一步的输出；
   - 调 `invokeHook(ctx, plugin, "content.render", payload)`；
   - 解析 `result` 为 `{"html": string}`；
   - `len(html) > 8 MiB` → 跳过该插件（保留前值）；
   - 成功 → 用新 HTML 继续下一个插件。
3. 任何错误（超时、进程失败、非 JSON、`ok:false`、解码失败、超大）都只记录在 `[]HookResult{PluginID, Error}` 里，**不影响最终 HTML**。
4. 返回最终 HTML（即使所有插件失败，也返回调用方传入的 HTML）。

`HookPayload`（`host.go`）：

```json
{
  "html": "<p>body</p>",
  "site_id": "site_1",
  "content_id": "content_1",
  "kind": "article",
  "locale": "zh-CN",
  "actor_role": "author"
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `html` | string? | 当前 HTML；第一个插件收到调用方传入值 |
| `site_id` | string | 必填（无 omitempty）；当前没有生产调用方，测试传 `site_1` |
| `content_id` | string? | 内容 id |
| `kind` | string? | 例如 `article`、`page`；由调用方决定 |
| `locale` | string? | 语言 |
| `actor_role` | string? | 操作者角色 |
| `extra` | object? | 预留扩展位；**当前宿主不填充** |

请求 stdin 示例（真实结构）：

```json
{
  "abi": "wasi-json-v1",
  "plugin_id": "com.example.hello",
  "version": "1.0.0",
  "hook": "content.render",
  "payload": {
    "html": "<p>body</p>",
    "site_id": "site_1",
    "content_id": "content_1",
    "kind": "article",
    "locale": "zh-CN",
    "actor_role": "author"
  },
  "capabilities": [
    "admin.route",
    "content.render",
    "http.route.public",
    "ui.block",
    "ui.inject",
    "ui.style"
  ]
}
```

插件 stdout：

```json
{
  "ok": true,
  "result": {
    "html": "<p>body</p><div data-pp-plugin=\"com.example.hello\" data-pp-site=\"site_1\">Hello from a sandboxed WASM plugin</div>"
  }
}
```

宿主最终 HTML（真实运行结果）：

```html
<p>body</p><div data-pp-plugin="com.example.hello" data-pp-site="site_1">Hello from a sandboxed WASM plugin</div>
```

失败示例：

```json
{ "ok": false, "error": { "code": "bad_payload", "message": "unexpected end of JSON input" } }
```

该失败会被记录为 `HookResult.Error`，文章仍用上一个 HTML 继续。

**危险边界**：如果插件返回 `{"ok":true,"result":{}}` 或 `{"ok":true,"result":null}`，宿主会反序列化出空 HTML，于是**把正文清空**。插件必须返回非空的 `html` 字段；宿主当前不校验这一点。（返回 `{"ok":true}` 且完全没有 `result` 时，`json.Unmarshal(nil, ...)` 会报错，结果是跳过该插件、保留前值，不会清空。）

### 4.3 `content.after_create/update/delete`（未实现）

- 清单接受这三个值，并要求 `content.write`。
- `knownHooks` 只用于校验，没有任何 `Dispatch`/`AfterCreate` 之类的调用代码。
- 因此：插件声明它们不会收到任何调用；也不存在输入/输出 schema。
- 设计文档写的「事务提交后 fire-and-forget、失败不回滚」是**目标语义**，不是当前实现。

## 5. 插件路由

### 5.1 URL 与匹配

```text
/api/v1/plugins/{plugin_id}{route.path}
```

例如：`id=com.example.hello`、`path=/hello` → `/api/v1/plugins/com.example.hello/hello`。

| 项 | 规则 |
| --- | --- |
| 挂载 | gin `v1.Any("/plugins/:pluginID/*path", pluginAuth, pluginRequestInfo, APIHandler)` |
| 方法 | 声明只允许 GET/POST/PUT/PATCH/DELETE；匹配按 `method + path` **精确**比较 |
| 未声明方法 | 返回 **404 `plugin_not_found`**（不是 405）；`HEAD` 也不支持 |
| 路径参数 | 不支持 `:id` / `*` / 正则；`/hello/1` 与 `/hello` 是两个不同 path |
| 尾斜杠 | 不做归一化；`/hello/` 与 `/hello` 不同 |
| 查询串 | 解析成 `payload.query`（`map[string][]string`） |
| 中间件 | 站点解析、站点 IP 策略、全局限流、CORS、gzip、请求超时、安全头都先生效 |

### 5.2 鉴权（进沙箱之前）

路由声明 `auth`，宿主在读取 body/调用 WASM 之前完成鉴权：

| `auth` | 条件 | 失败 |
| --- | --- | --- |
| `public` | 无条件 | — |
| `member` | `RequestInfo.Authenticated == true` | 401 `unauthenticated`，detail `this plugin route requires a member session` |
| `admin` | 已认证，且 `Role ∈ {site_admin, platform_admin}` | 未认证 → 401 `unauthenticated`；角色不足 → 403 `forbidden`，detail 都是 `this plugin route requires a site administrator` |

`RequestInfo` 由 gin 适配器填充：

```go
info := plugins.RequestInfo{}
if resolved, ok := middleware.SiteFrom(c); ok { info.SiteID = resolved.ID }
if principal, ok := middleware.PrincipalFrom(c); ok {
    info.Authenticated = true
    info.UserID = principal.UserID
    info.Role = string(principal.Role)
}
```

- `pluginAuth` 是 `middleware.OptionalAuth`（`AccessTokens != nil` 时）；没有 token 也能进 public 路由。
- `AccessTokens == nil` 时 `pluginAuth` 是空操作；此时 member/admin 路由永远 401。
- 插件只能拿到宿主解析后的 `site_id/user_id/role`；`Authorization` 与 `Cookie` **不会**透传。

### 5.3 请求 payload（`payload` 字段）

宿主把 HTTP 请求压成一个对象：

```json
{
  "body": "",
  "headers": {
    "Accept": "application/json",
    "User-Agent": "curl/8.7.1"
  },
  "method": "GET",
  "path": "/hello",
  "query": {
    "name": ["World"]
  },
  "role": "",
  "site_id": "site_42",
  "user_id": ""
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `method` | string | HTTP 方法 |
| `path` | string | **声明路径**（`route.Path`），不是完整 URL |
| `query` | object | `url.Values`：`map[string][]string` |
| `headers` | object | 白名单请求头，见下 |
| `body` | string | 原始请求体（最多 1 MiB）；不是 JSON 解析后的对象 |
| `site_id` | string | 宿主解析出的站点 id |
| `user_id` | string | 已认证用户 id；匿名为空 |
| `role` | string | 已认证角色；匿名为空 |

请求头白名单（只透传这 5 个，值超过 1024 字节截断，空值不出现）：

```text
Accept, Accept-Language, Content-Type, User-Agent, X-Requested-With
```

`Authorization`、`Cookie`、`X-Forwarded-*`、`X-PP-*` 等一律不传。

请求体限制：

- 读取 `io.LimitReader(body, 1 MiB + 1)`；超过 1 MiB → **413** `request_too_large`，detail `plugin request body exceeds 1 MiB`。
- 读取失败 → 400 `bad_request`，detail `could not read request body`。
- 该限制在鉴权之后执行；未授权请求不会读到 body。

### 5.4 响应结果（`result` 字段）

插件必须返回：

```json
{
  "ok": true,
  "result": {
    "body": "{\"message\":\"hello from com.example.hello\",\"method\":\"GET\",\"site_id\":\"site_42\"}",
    "headers": {
      "Content-Type": "application/json"
    },
    "status": 200
  }
}
```

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `status` | int | 200–599；越界（含 0）由宿主改成 502，但仍写 body |
| `headers` | object | `string → string`；只保留白名单，其余静默丢弃 |
| `body` | string | 原样写出；最大 4 MiB，超出 → 502 |

响应头白名单（大小写不敏感，Go 规范化）：

| 允许 | 说明 |
| --- | --- |
| `Content-Type` | 未设置时宿主补 `application/json; charset=utf-8` |
| `Cache-Control` | 原样 |
| `ETag` | 原样 |
| `Location` | 值必须以 `/` 开头，否则丢弃。**注意**：当前实现对原始键名做 `name == "Location"` 比较，且只检查首字符 `/`；插件返回小写 `location` 或 `//evil.com` 都能绕过（见 [05 H10](05-compatibility-gaps.md)） |
| `Content-Language` | 原样 |
| `X-PP-*` | 任何 `X-PP-` 前缀（规范化后 `X-Pp-*`） |

禁止/丢弃：`Set-Cookie`、`Authorization`、`Content-Encoding`、`Access-Control-*`、`Content-Length` 等。宿主始终补：

```http
X-Content-Type-Options: nosniff
```

然后按 `status` 写 body。

### 5.5 完整 HTTP 示例（参考插件真实输出）

#### 成功

```http
GET /api/v1/plugins/com.example.hello/hello?name=World HTTP/1.1
Host: example.test
Accept: application/json
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Content-Type-Options: nosniff

{"message":"hello from com.example.hello","method":"GET","site_id":"site_42"}
```

（`site_42` 来自宿主注入的 `RequestInfo.SiteID`；真实服务里由站点解析中间件填。）

#### 401：admin 路由、无会话

```http
GET /api/v1/plugins/com.example.hello/admin/ping HTTP/1.1
```

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/problem+json
X-Content-Type-Options: nosniff

{"code":"unauthenticated","detail":"this plugin route requires a site administrator","status":401,"title":"Unauthorized","type":"about:blank"}
```

#### 403：已登录但不是管理员

```http
GET /api/v1/plugins/com.example.hello/admin/ping HTTP/1.1
Authorization: Bearer <member-token>
```

```http
HTTP/1.1 403 Forbidden
Content-Type: application/problem+json

{"code":"forbidden","detail":"this plugin route requires a site administrator","status":403,"title":"Forbidden","type":"about:blank"}
```

#### 401：member 路由、无会话

```json
{"code":"unauthenticated","detail":"this plugin route requires a member session","status":401,"title":"Unauthorized","type":"about:blank"}
```

#### 200：admin 会话

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"message":"admin route reached","role":"site_admin"}
```

#### 404：路径不存在、插件未启用、方法未声明

```http
GET /api/v1/plugins/com.example.hello/nope HTTP/1.1
```

```http
HTTP/1.1 404 Not Found
Content-Type: application/problem+json

{"code":"plugin_not_found","detail":"plugin route is not available","status":404,"title":"Not Found","type":"about:blank"}
```

同一响应也用于：

- 插件不存在；
- 插件未 `Enable`；
- 插件在处理途中被禁用（detail 变成 `plugin was disabled during the request`）；
- 用 `POST` 请求只声明了 `GET` 的路由（真实 smoke 结果是 404，不是 405）。

前缀里没有 id 或没有路径时 detail 是 `unknown plugin route`。

#### 413：请求体超过 1 MiB

仅当该 `method + path` 已声明时才会走到 body 读取；例如声明了 `POST /echo`：

```http
POST /api/v1/plugins/com.example.echo/echo HTTP/1.1
Content-Type: application/octet-stream
Content-Length: 1048577

<1 MiB + 1 字节>
```

```http
HTTP/1.1 413 Request Entity Too Large
Content-Type: application/problem+json

{"code":"request_too_large","detail":"plugin request body exceeds 1 MiB","status":413,"title":"Request Entity Too Large","type":"about:blank"}
```

#### 502：插件超时 / 崩溃 / 非 JSON / `ok:false`

```http
HTTP/1.1 502 Bad Gateway
Content-Type: application/problem+json

{"code":"plugin_error","detail":"plugin failed to handle the request","status":502,"title":"Bad Gateway","type":"about:blank"}
```

宿主**不会**把插件的 `error.code/message`、stderr、WASM 路径回给客户端；这些只进 `slog.Warn`。

#### 502：`result` 结构不对 / 响应超过 4 MiB

```json
{"code":"plugin_error","detail":"plugin returned an invalid response","status":502,"title":"Bad Gateway","type":"about:blank"}
```

```json
{"code":"plugin_error","detail":"plugin response exceeds 4 MiB","status":502,"title":"Bad Gateway","type":"about:blank"}
```

#### 500：请求编码失败（实际不可达）

```json
{"code":"plugin_error","detail":"could not encode request","status":500,"title":"Internal Server Error","type":"about:blank"}
```

> 注意：插件宿主的所有错误都用上面这种**极简 problem**（`type/title/status/code/detail`），与平台其他 API 的 `apperr` 格式（`message/details/request_id`）不同。客户端要按 `Content-Type: application/problem+json` 并容忍两套字段。

## 6. 失败策略与错误码

### 6.1 总表

| 场景 | HTTP | code | detail |
| --- | --- | --- | --- |
| 路径/插件/方法不存在，或插件未启用 | 404 | `plugin_not_found` | `plugin route is not available` |
| 前缀不合法（缺 id/path） | 404 | `plugin_not_found` | `unknown plugin route` |
| 调用中插件被禁用 | 404 | `plugin_not_found` | `plugin was disabled during the request` |
| `member` 未认证 | 401 | `unauthenticated` | `this plugin route requires a member session` |
| `admin` 未认证 | 401 | `unauthenticated` | `this plugin route requires a site administrator` |
| `admin` 角色不足 | 403 | `forbidden` | `this plugin route requires a site administrator` |
| 未知 auth 策略 | 403 | `forbidden` | `unknown route policy`（清单校验后不可达） |
| 读 body 失败 | 400 | `bad_request` | `could not read request body` |
| body > 1 MiB | 413 | `request_too_large` | `plugin request body exceeds 1 MiB` |
| 请求 JSON 编码失败 | 500 | `plugin_error` | `could not encode request` |
| 调用失败/超时/非 JSON/`ok:false` | 502 | `plugin_error` | `plugin failed to handle the request` |
| result 非对象 | 502 | `plugin_error` | `plugin returned an invalid response` |
| result.body > 4 MiB | 502 | `plugin_error` | `plugin response exceeds 4 MiB` |
| 插件返回 status ∉ [200,599] | 502 | — | 不是 problem；body 仍是插件给的 body |

### 6.2 钩子失败策略（fail-open）

| 失败 | 结果 |
| --- | --- |
| 超时 / 实例化失败 / 非零退出 | 跳过该插件，保留前一个 HTML，`HookResult.Error` |
| stdout 非 JSON / 超过 4 MiB | 同上 |
| `ok:false` | 同上（`error.code/message` 进日志） |
| `result` 不是 `{"html": ...}` | 同上（可能得到空 HTML，见 §4.2 警告） |
| 单个结果 HTML > 8 MiB | 跳过该插件，保留前值 |
| 宿主 `TransformHTML` 本身 panic | 无 recover；接入内容管线时必须由调用方保证 |

设计文档里的「连续失败 N 次自动禁用」**没有实现**；`StateFailed` 与 `LastError` 在 `host.go` 中定义但从未被赋值（死代码），因为 `Install` 失败是直接返回 error、不建记录。

## 7. 契约合并

### 7.1 接口

`GET /api/v1/openapi.json`：

- 未接入宿主（`deps.Plugins == nil`）：返回内嵌的 `packages/contracts/openapi/openapi.yaml` 的 JSON 化结果；契约测试用同一份 YAML 校验路由集合，所以内容与仓库契约一致（不是对原文件做字节级透传）。
- 接入宿主：返回基础契约 + 所有 **enabled 且有 backend routes** 的插件 operation。
- 响应头：`Content-Type: application/json; charset=utf-8`、`Cache-Control: public, max-age=300`。
- 合成失败（路径冲突）→ 500 `apperr` problem（detail 不回显插件 id，只进日志）。

### 7.2 合并规则（`contract.go`）

1. 基础文档从内嵌 YAML 解码为 `map[string]any`；保持 `info`、`components`、其余 `paths` 不变。
2. 对每个 enabled 插件的每个 route：
   - 路径 = `"/plugins/" + plugin.id + route.path`；
   - 如果该路径已存在（宿主或其他插件）→ **合成失败**（`contributes a duplicate contract path`）；
   - `operation` = 清单里的 `contract` 对象；
   - 强制 `operation["tags"] = [plugin.id]`；
   - 强制 `operation["x-pp-plugin"] = { id, version, permissions, auth }`；
   - 写入 `paths[fullPath]`。
3. 每个有贡献的插件追加一个顶层 tag：
   ```json
   {
     "name": "com.example.hello",
     "description": "Hello PP (plugin com.example.hello 1.0.0)",
     "x-pp-plugin": true
   }
   ```
4. 顶层追加 `x-pp-plugins`：
   ```json
   [{ "id": "...", "name": "...", "version": "...", "paths": ["..."] }]
   ```
   `paths` 按字母序。
5. 结果 `json.MarshalIndent(document, "", "  ")`，缓存在 `Host.contract`；`Install/Enable/Disable/Remove` 把 `dirty` 置 true，下次请求重新合成。

### 7.3 真实 operation 示例

参考插件的 `GET /hello` 合并后：

```json
{
  "description": "Served by the plugin's sandboxed backend. Demonstrates a plugin-owned, contract-documented route.",
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "properties": {
              "message": { "type": "string" },
              "site_id": { "type": "string" }
            },
            "required": ["message", "site_id"],
            "type": "object"
          }
        }
      },
      "description": "A greeting"
    }
  },
  "summary": "Say hello from a WASM plugin",
  "tags": ["com.example.hello"],
  "x-pp-plugin": {
    "auth": "public",
    "id": "com.example.hello",
    "permissions": [
      "admin.route",
      "content.render",
      "http.route.public",
      "ui.block",
      "ui.inject",
      "ui.style"
    ],
    "version": "1.0.0"
  }
}
```

顶层贡献者：

```json
[
  {
    "id": "com.example.hello",
    "name": "Hello PP",
    "paths": [
      "/plugins/com.example.hello/admin/ping",
      "/plugins/com.example.hello/hello"
    ],
    "version": "1.0.0"
  }
]
```

### 7.4 合并约束

| 规则 | 当前实现 |
| --- | --- |
| 只能新增 path/operation | ✅ 基础契约不变；冲突直接失败 |
| 不能覆盖宿主 operation | ✅ 同路径冲突 |
| 禁止 `$ref` | ✅ 清单校验 |
| 禁止 `servers/security/callbacks/webhooks` | ✅ 清单校验 |
| 每个 operation 必须有 `responses` | ✅ 清单校验 |
| 插件 operation 命名空间 | ✅ `/plugins/{id}` |
| `tags` / `x-pp-plugin` 由宿主控制 | ✅ 覆盖 |
| 顶层 `x-pp-contract-version` | ❌ **未写入**（设计文档要求） |
| 冲突在 `Enable` 时拒绝 | ❌ **只在合成时失败**（`ContractJSON` 返回 error） |
| `components` 命名空间前缀 | ❌ v1 禁止 `$ref`，无需合并 |
| 契约版本与实际 `info.version` 比对 | ❌ `Options.ContractVersion` 由调用方提供 |

缓存细节：`/api/v1/openapi.json` 的 `Cache-Control: public, max-age=300`，客户端/代理可能最多 5 分钟看到旧合成结果；禁用插件后服务端会重新合成，但边缘缓存不会立刻失效。

## 8. 生命周期与宿主接入

### 8.1 Host API

| 方法 | 行为 |
| --- | --- |
| `New(Options)` | 建 Host；`Options`：`HostVersion`、`ContractVersion`、`Logger`、`DefaultTimeout` |
| `Install(dir)` | 校验清单 → 版本检查 → 查重 → 读 `.wasm` → 建 runtime → `CompileModule` → 记录 `installed` |
| `Enable(id)` | 置 `enabled`（幂等）；不重新编译、不重建 runtime |
| `Disable(id)` | 置 `disabled`（幂等）；不关闭 runtime、不清理已编译模块；契约缓存标记 dirty |
| `Remove(id)` | 关闭 runtime、删记录；**不删除磁盘目录** |
| `Close()` | 关闭所有 runtime；幂等 |
| `PublicPlugins()` | enabled + 有 frontend 的 boot 记录 |
| `TransformHTML(ctx, payload)` | `content.render` 链 |
| `APIHandler(prefix)` | 插件 API 的 `http.Handler` |
| `AssetHandler(prefix)` | 前端资产的 `http.Handler` |
| `ContractJSON()` | 合成契约（带缓存） |

状态机：

```text
Install → installed → Enable → enabled → Disable → disabled → Enable → enabled
                          │
                          └─ Remove → 记录消失（磁盘不动）

failed：定义了，但没有任何代码把插件置为 failed。
```

### 8.2 接入生产需要做什么（当前都没做）

1. `cmd/server`：读取插件目录/开关，`plugins.New(...)` → `Install` → `Enable` → 传入 `ginrouter.Dependencies.Plugins`；进程退出时 `Close()`。
2. 内容管线：在文章/页面 HTML 输出前调用 `TransformHTML`，把结果再过 `services/security` 扫描。
3. 管理 API/页面：安装、启停、卸载、权限确认、错误诊断、审计。
4. 按站点启用：给 Host 加 site 维度（当前没有）。
5. 前端：`App.tsx` 启动 `defaultPluginRuntime`，页面挂 `<PluginSlot>`，并把 `siteId` 传进去。
6. 生命周期：drain、失败自动禁用、safe mode、回滚。

开发环境里复现本文 HTTP 示例的最小接线（**示意，不是可直接编译的 composition root**；其他依赖按 `ginrouter.Dependencies` 补齐）：

```go
host, err := plugins.New(plugins.Options{
    HostVersion:     "0.1.0",
    ContractVersion: "1.0.0",
    Logger:          logger,
})
if err != nil {
    return err
}
defer host.Close()

if _, err := host.Install("apps/api/internal/plugins/testdata/hello"); err != nil {
    return err
}
if _, err := host.Enable("com.example.hello"); err != nil {
    return err
}

engine := ginrouter.New(ginrouter.Dependencies{
    Config:  cfg,
    Plugins: host,
    // AccessTokens / Memberships / Content / ... 按需补齐
})
```

然后在同一个进程里：

```powershell
curl.exe http://127.0.0.1:8080/api/v1/plugins
curl.exe http://127.0.0.1:8080/api/v1/plugins/com.example.hello/hello
curl.exe http://127.0.0.1:8080/plugins/com.example.hello/1.0.0/client.js
```

注意：`curl` 的 `Host` 必须能解析到一个站点（生产中间件会先做站点解析）；本地没有站点解析器时，只有像 `plugin_route_test.go` 那样直接构造 engine 才能绕开。

在设计文档的 P1 工作流里，这些是 W1–W6；本仓库目前只有 P0 的库与测试。

## 9. 后端完整示例（参考插件）

`apps/api/internal/plugins/testdata/hello/backend/main.go` 的核心逻辑：

```go
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

type envelope struct {
	ABI     string          `json:"abi"`
	Plugin  string          `json:"plugin_id"`
	Hook    string          `json:"hook"`
	Route   string          `json:"route"`
	Handler string          `json:"handler"`
	Payload json.RawMessage `json:"payload"`
}

func main() {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		fail("read_error", err.Error())
		return
	}
	var request envelope
	if err := json.Unmarshal(raw, &request); err != nil {
		fail("bad_request", err.Error())
		return
	}
	switch {
	case request.Hook == "content.render":
		handleRender(request.Payload)
	case request.Route != "":
		handleRoute(request)
	default:
		fail("unknown_hook", "no hook or route in request")
	}
}

func handleRender(raw json.RawMessage) {
	var payload struct {
		HTML   string `json:"html"`
		SiteID string `json:"site_id"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		fail("bad_payload", err.Error())
		return
	}
	result, _ := json.Marshal(map[string]any{
		"ok": true,
		"result": map[string]any{
			"html": payload.HTML +
				fmt.Sprintf(`<div data-pp-plugin="com.example.hello" data-pp-site="%s">Hello from a sandboxed WASM plugin</div>`, payload.SiteID),
		},
	})
	_, _ = os.Stdout.Write(result)
}
```

路由分支返回：

```go
result, _ := json.Marshal(map[string]any{
	"ok": true,
	"result": map[string]any{
		"status":  200,
		"headers": map[string]string{"Content-Type": "application/json"},
		"body":    `{"message":"hello from com.example.hello","site_id":"site_42"}`,
	},
})
_, _ = os.Stdout.Write(result)
```

错误分支：

```go
func fail(code, message string) {
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{
		"ok": false,
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}
```

参考插件的完整源码见 `apps/api/internal/plugins/testdata/hello/backend/main.go`（含 HTML 转义、路由分支、故意慢路径）。

## 10. 限制与已知差异（后端）

1. **生产未接入**：没有 `cmd/server` 构造 Host，因此下面所有 HTTP 接口在发行版里都不存在。
2. **内容钩子未接内容管线**：`TransformHTML` 只有测试调用；真实文章输出不走插件。
3. **`content.after_*` 没有派发**：清单接受但永远收不到调用。
4. **`StateFailed`/`LastError` 未使用**：安装失败不建记录；管理端无法展示失败插件。
5. **超时即永久失效**：超时关闭 runtime，但 `State` 仍是 enabled；没有自动禁用/重建。
6. **没有每插件限流**：只有 `Config.RateLimitPerMinute` 对应的全局 IP 限流；设计里的 60 req/min/插件/站点未实现。
7. **没有按站点启用**：Host 是进程级单例，插件对所有站点可见。
8. **没有安全扫描**：`TransformHTML` 的输出不会自动过 `services/security`；接入内容管线时必须由调用方补上。
9. **没有签名/哈希校验**：清单里没有哈希字段（`PublicPlugin.ManifestHash` 从未赋值）；安装只校验结构与编译。
10. **路由无语义化的 405**：只支持精确 path；`HEAD` 不支持；未声明方法一律 404；`OPTIONS` 只有在配置了 CORS 中间件时才由中间件处理。
11. **契约冲突只在合成时发现**：`Enable` 不预检；冲突会让 `/api/v1/openapi.json` 返回 500。
12. **没有 `x-pp-contract-version`**：设计文档要求写入顶层，代码没有。
13. **`ok:true` + 空 result 会清空正文**：内容钩子不校验 `html` 非空。
14. **单个插件失败不会通知调用方**：`TransformHTML` 只返回 `[]HookResult`，接入方需要自己记录/告警。
15. **没有 drain**：`Disable/Remove` 拿写锁等待在途调用，但没有超时/优雅停机流程。
16. **资产目录即公开面**：`frontend/` 下任何受支持后缀的文件都能被取到，不限于清单声明的 entry/styles；符号链接也会被 `os.Stat` 跟随。
17. **`Location` 检查可被绕过**：宿主用原始键名比较，且只要求首字符 `/`；插件返回 `location`、`LOCATION` 或 `//evil.com` 即可下发站外重定向（见 [05 H10](05-compatibility-gaps.md)）。

这些差异在 [05-compatibility-gaps.md](05-compatibility-gaps.md) 里有统一编号与证据。
