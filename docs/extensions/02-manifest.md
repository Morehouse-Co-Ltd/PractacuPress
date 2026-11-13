# 02 · `plugin.json` 清单字段与校验

- 上级文档：[README.md](README.md)
- 源码：`apps/api/internal/plugins/manifest.go`（结构体、权限/槽位白名单、`LoadManifest`、`ValidateManifest`、semver range）
- 测试：`apps/api/internal/plugins/manifest_test.go`

## 1. 文件位置与读取方式

| 项 | 规则 |
| --- | --- |
| 文件名 | 必须是插件目录根下的 `plugin.json`（`ManifestFileName`） |
| 大小 | ≤ 256 KiB（`MaxManifestBytes = 256 << 10`），超过直接拒绝 |
| 编码 | UTF-8 JSON |
| 未知字段 | **零容忍**：`json.Decoder.DisallowUnknownFields()`，任意层级出现未知键都拒绝 |
| 校验时机 | `LoadManifest` 读文件 + 解码 + `ValidateManifest`；`Host.Install` 还会做宿主版本/契约版本/重复 id/WASM 编译检查 |
| 目录参数 | `ValidateManifest(m, dir)` 的 `dir` 非空时，所有声明的文件必须是目录内的**普通文件**；`dir == ""` 只校验形状（测试/工具） |

> 清单是**唯一授权来源**。宿主只信清单里的权限、槽位、区块、路由、钩子声明，不信插件运行时自报。

## 2. 完整示例（参考插件，逐字段真实）

`apps/api/internal/plugins/testdata/hello/plugin.json`：

```json
{
  "manifest_version": 1,
  "id": "com.example.hello",
  "name": "Hello PP",
  "version": "1.0.0",
  "description": "Reference plugin for the plugin-host spike: one content hook, two routes and a browser half.",
  "author": "Practacu Press",
  "license": "MIT",
  "engines": {
    "pp": ">=0.1.0 <1.0.0",
    "contract": ">=1.0.0 <2.0.0"
  },
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
          "description": "Served by the plugin's sandboxed backend. Demonstrates a plugin-owned, contract-documented route.",
          "responses": {
            "200": {
              "description": "A greeting",
              "content": {
                "application/json": {
                  "schema": {
                    "type": "object",
                    "required": ["message", "site_id"],
                    "properties": {
                      "message": { "type": "string" },
                      "site_id": { "type": "string" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      {
        "method": "GET",
        "path": "/admin/ping",
        "handler": "admin",
        "auth": "admin",
        "contract": {
          "summary": "Admin-only plugin route",
          "description": "The host enforces the admin policy before the sandbox is invoked.",
          "responses": {
            "200": { "description": "The caller's role" },
            "401": { "description": "No session" },
            "403": { "description": "Not a site administrator" }
          }
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
    "content.render",
    "http.route.public",
    "admin.route",
    "ui.inject",
    "ui.block",
    "ui.style"
  ]
}
```

这个清单同时声明了：一个内容钩子、两个后端路由、一个前端 bundle、一个 CSS、一个槽位、一个区块。注意它**没有** `settings_schema` 与 `frontend.integrity`。

## 3. 顶层字段

| 字段 | 类型 | 必填 | 源码规则 | 说明 |
| --- | --- | --- | --- | --- |
| `manifest_version` | int | 是 | 必须等于 `1` | 宿主只认这一版（`ManifestVersion = 1`） |
| `id` | string | 是 | 正则 `^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`，且长度 3–64 字节 | 反向域名风格、全小写；如 `com.example.hello` |
| `name` | string | 是 | `TrimSpace` 后非空，≤ 80 个 Unicode 字符 | 展示名 |
| `version` | string | 是 | 正则 `^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$` | 必须是 semver（可带 prerelease/build，不带 `v` 前缀） |
| `engines` | object | 是 | 见 §4 | 宿主与契约版本范围 |
| `runtime` | string | 是 | 只能是 `"wasm"` 或 `"none"` | `wasm` 必须有 `backend`；`none` 不能有 `backend` |
| `backend` | object | 条件 | 见 §5 | `runtime: "wasm"` 时必填 |
| `frontend` | object | 否 | 见 §7 | 浏览器端 bundle 声明 |
| `permissions` | string[] | 否 | 闭集，见 §8；重复值不报错 | 能力授予 |
| `settings_schema` | object | 否 | 见 §9 | 设置表单 schema（当前仅校验/暴露布尔标记） |
| `description` | string | 否 | 无长度/内容校验 | 展示用 |
| `author` | string | 否 | 无长度/内容校验 | 展示用 |
| `license` | string | 否 | 无长度/内容校验 | 展示用 |
| `homepage` | string | 否 | 无 URL 校验 | 展示用；宿主当前不读取 |

**id 细节**：正则要求首字符是小写字母；分隔符只能是 `.` 或 `-`，且分隔符后必须跟 `[a-z0-9]+`。因此 `com.example.hello`、`hello-card` 合法；`Hello`、`com_example`、`-hello`、`com..example` 非法。长度按 Go 的字节长度计算，纯 ASCII 下等于字符数。

**name 细节**：只做 `TrimSpace` 非空与 80 rune 上限；允许中文、空格、标点。

**version 细节**：只做正则匹配，不校验数值范围；`1.000.0`、`1.0.0-rc.1+build.5` 都能通过。范围比较时会剥掉 `-`/`+` 之后的部分，见 §11。

## 4. `engines`

```json
"engines": { "pp": ">=0.1.0 <1.0.0", "contract": ">=1.0.0 <2.0.0" }
```

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `pp` | 是 | 非空；必须是合法 range（§11） |
| `contract` | 否 | 出现时必须是合法 range |

- `engines.pp` 在 `Host.Install` 时与 `Options.HostVersion` 比对；不满足 → 拒绝安装，错误形如 `plugin com.example.hello requires host >=0.1.0 <1.0.0, running 0.0.1`。
- `engines.contract` 在 `Options.ContractVersion` 非空时才比对；不满足 → 拒绝安装。
- `HostVersion`/`ContractVersion` 为空表示**跳过检查**（测试/工具场景）。生产接入时必须传入真实版本，否则兼容检查形同虚设。
- 两个 `Options` 版本值本身必须是可解析的 `major.minor.patch`；传 `"v0.1.0"` 这类值会让 `Satisfies` 返回 false，从而**拒绝所有插件**。
- 只检查 `engines` 的结构与范围语法；`ContractVersion` 不是从内嵌契约里自动读取的，当前由调用方传入（测试里是 `"1.0.0"`，而内嵌契约 `info.version` 是 `0.1.0`，两者并不一致，见 [05-compatibility-gaps.md](05-compatibility-gaps.md) 的 C1）。

## 5. `backend`

```json
"backend": {
  "entry": "backend/hello.wasm",
  "abi": "wasi-json-v1",
  "timeout_ms": 300,
  "max_memory_mb": 64,
  "hooks": ["content.render"],
  "routes": []
}
```

| 字段 | 类型 | 必填 | 规则 | 默认/上限 |
| --- | --- | --- | --- | --- |
| `entry` | string | 是 | 相对路径、禁止绝对路径/反斜杠/冒号/`..` 越界；必须以 `.wasm` 结尾；`dir` 非空时必须是目录内普通文件 | 无 |
| `abi` | string | 是 | 必须精确等于 `"wasi-json-v1"` | 仅此一种 |
| `timeout_ms` | int | 否 | 拒绝 `< 0` 与 `> 30000`；`0` 表示用宿主默认 | 默认 500 ms；最大 30 s |
| `max_memory_mb` | int | 否 | 拒绝 `< 0` 与 `> 512`；`0` 表示用宿主默认 | 默认 128 MB；最大 512 MB |
| `hooks` | string[] | 否 | 闭集：`content.render`、`content.after_create`、`content.after_update`、`content.after_delete`；未知 hook 拒绝 | 每个 hook 都要有对应权限 |
| `routes` | object[] | 否 | 见 §6；`method + path` 不能重复 | — |

补充：

- `timeout_ms` 的校验区间是 **0–30000**（闭区间），不是 1 起步；`0` 合法且表示默认。
- `max_memory_mb` 的校验区间是 **0–512**；传给 wazero 时按 `memoryMB * 16` 页设置线性内存上限（64 KiB/页）。
- `runtime: "none"` 时**不能**出现 `backend`，否则报 `runtime none must not declare a backend`。
- `runtime: "wasm"` 时**必须**有 `backend`，否则报 `runtime wasm requires a backend`。
- 只有 `frontend`、没有 `backend` 的插件必须写 `"runtime": "none"`。

## 6. `backend.routes[]`

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `method` | string | 是 | 只能是 `GET` / `POST` / `PUT` / `PATCH` / `DELETE`；空字符串也会被拒绝（尽管运行时的 `findRoute` 有「空 = GET」的兜底，清单校验先拦下，属于不可达代码） |
| `path` | string | 是 | 必须以 `/` 开头；正则 `^/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,160}$`；不得包含 `..` |
| `handler` | string | 否 | 原样传给插件，便于一个模块服务多个路由；无格式/唯一性校验 |
| `auth` | string | 否 | `public`（默认）/ `member` / `admin`；其他值拒绝 |
| `contract` | object | 是 | OpenAPI operation 对象；见下方约束 |

`contract` 的硬性约束（`validateRoute`）：

1. 必须存在，且 ≤ 64 KiB（`MaxContractBytes`）。
2. 必须是合法 JSON 对象，能解码为 `map[string]any`。
3. **必须包含 `responses` 键**（不校验状态码内容）。
4. 禁止出现 `servers`、`security`、`callbacks`、`webhooks`。
5. **禁止任何层级的 `$ref`**（递归扫描），v1 要求内联 schema。
6. 不校验 `summary`、`parameters`、schema 正确性、状态码范围；这些由作者与评审保证。
7. 允许写 `tags` / `x-pp-plugin`，但合并契约时会被宿主覆盖（`tags: [pluginID]`、`x-pp-plugin: {id, version, permissions, auth}`）。

权限与路由的对应关系在安装时强制：

| `auth` | 必需权限 | 鉴权语义（运行时） |
| --- | --- | --- |
| `public` | `http.route.public` | 不要求会话 |
| `member` | `http.route.member` | 必须有已认证会话（只检查 `Authenticated`，不检查角色） |
| `admin` | `admin.route` | 必须已认证，且角色是 `site_admin` 或 `platform_admin` |

路由的最终 URL 是 `/api/v1/plugins/{id}{path}`。例如 `id = com.example.hello`、`path = /hello` → `/api/v1/plugins/com.example.hello/hello`。路径匹配是**精确匹配**：没有路径参数、通配符、尾斜杠归一化；未声明的方法返回 404 而不是 405。

## 7. `frontend`

```json
"frontend": {
  "entry": "frontend/client.js",
  "styles": ["frontend/client.css"],
  "slots": ["article.after"],
  "blocks": [{ "type": "hello.card", "name": "Hello card" }],
  "integrity": "sha384-..."
}
```

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `entry` | string | 是 | 相对路径、禁止绝对路径/反斜杠/冒号/`..`；必须以 `.js` 结尾；`dir` 非空时必须是普通文件 |
| `styles` | string[] | 否 | 每项必须以 `.css` 结尾、路径规则同上；**只要出现样式就必须有 `ui.style`** |
| `slots` | string[] | 否 | 每项必须在宿主槽位闭集内：`site.header`、`site.footer`、`article.after`、`article.sidebar`、`home.after`、`admin.nav`、`admin.settings`、`admin.editor.tools` |
| `blocks` | object[] | 否 | 每项 `type` 必须匹配 id 正则（小写 kebab/dot）；`type` 不能重复；`name` 可选、无长度校验；**只要出现 blocks 就必须有 `ui.block`** |
| `integrity` | string | 否 | 出现时必须 `sha384-` 前缀；宿主当前只把它传给浏览器的 `script.integrity`，**服务端不做哈希校验** |

关键规则：

- **任何 `frontend` 都要求 `ui.inject`**，即使它只声明 blocks、不声明 slots。`validateFrontend` 的第一步就是检查 `ui.inject`。
- slot 不要求额外权限；`ui.inject` 是槽位总开关。
- `frontend.entry` 在 boot manifest 里会被改写成 `/plugins/{id}/{version}/{basename}`；因为资产处理器用 `frontend/` + 相对路径拼真实文件，**entry 必须直接放在 `frontend/` 目录下**（`frontend/dist/client.js` 会被映射成 `/plugins/.../client.js` 但实际文件在 `frontend/dist/`，最终 404）。`styles` 同样只返回 basename，且当前浏览器运行时不自动加载。
- 一个插件可以只有 `frontend`：`runtime: "none"`、无 `backend`。
- 一个插件也可以只有 `backend`：`runtime: "wasm"`、无 `frontend`。

## 8. `permissions`

闭集（`knownPermissions`），大小写敏感，未知值安装失败：

| 权限 | 授予什么 | 清单里什么时候必须出现 |
| --- | --- | --- |
| `content.read` | 允许 hook 读取正文/元数据 | 当前没有 hook 使用它；保留词汇 |
| `content.render` | 读取并改写渲染后的 HTML | `hooks` 含 `content.render` |
| `content.write` | 内容生命周期钩子 | `hooks` 含任一 `content.after_*` |
| `http.route.public` | 公开插件路由 | 任一 `auth: "public"` 路由 |
| `http.route.member` | 登录成员路由 | 任一 `auth: "member"` 路由 |
| `admin.route` | 管理员路由 | 任一 `auth: "admin"` 路由 |
| `ui.inject` | 填槽位；也是任何 `frontend` 的前置条件 | 有 `frontend` |
| `ui.block` | 注册区块类型 | `frontend.blocks` 非空 |
| `ui.style` | 注入样式；也是声明 `frontend.styles` 的前置条件 | `frontend.styles` 非空 |

补充：

- 权限重复不报错；公开投影（boot manifest / 契约 `x-pp-plugin`）会去重并按字母序排序。
- 权限**只增不减**是设计约束；升级新增权限必须重新同意（当前没有授权持久化/同意页，见 [05-compatibility-gaps.md](05-compatibility-gaps.md)）。
- 有权限但没有对应声明是允许的（例如声明了 `admin.route` 却没有 admin 路由），只是没有效果。

## 9. `settings_schema`

```json
"settings_schema": {
  "type": "object",
  "properties": {
    "headline": { "type": "string", "default": "Hello" }
  },
  "additionalProperties": false
}
```

| 项 | 规则 |
| --- | --- |
| 类型 | 必须是 JSON 对象（能 `json.Unmarshal` 进 `map[string]any`） |
| 大小 | 受整个清单 256 KiB 限制；没有单独的 schema 上限 |
| 内容 | 不校验 JSON Schema 语义；原样保存在清单里 |
| 运行时效果 | 仅让 `PublicPlugin.settings = true`（`len(settings_schema) > 0`）；**没有设置读取/写入接口，也没有管理页表单** |
| 边界情况 | 字面量 `null` 能被 Go 解码进 map 且不报错，但 `len(raw) > 0` 会让 boot manifest 报 `settings: true`；按「未设置」处理更安全 |

## 10. 校验流程与执行顺序

```text
LoadManifest(dir)
  1. 读 <dir>/plugin.json
  2. 文件 > 256 KiB ? 拒绝
  3. json.Decoder.DisallowUnknownFields 解码
  4. ValidateManifest(m, dir)
       manifest_version == 1
       id / name / version
       engines.pp 必填 + 范围语法
       engines.contract 可选 + 范围语法
       runtime ∈ {wasm, none}，backend 存在性匹配
       permissions 全部在闭集
       settings_schema 是对象
       backend: abi / entry 文件 / timeout / memory / routes / hooks
       frontend: ui.inject / entry 文件 / styles 文件+权限 / slots 闭集 / blocks 类型+权限 / integrity
Host.Install(dir)
  5. HostVersion 非空且不满足 engines.pp ? 拒绝
  6. ContractVersion 非空且 engines.contract 存在且不满足 ? 拒绝
  7. id 已安装 ? 拒绝
  8. 有 backend：读 .wasm、建 wazero runtime、CompileModule；失败拒绝
  9. 记入内存注册表，状态 installed
```

## 11. semver range 语法

宿主实现的是一个**很小的子集**（`parseRange` / `Satisfies`），不是完整 npm semver：

```text
range   := constraint (("," | 空白) constraint)*
constraint := (">=" | "<=" | ">" | "<" | "=" | "^" | "~")? major.minor.patch
```

| 写法 | 含义 | 示例 |
| --- | --- | --- |
| `1.2.3` / `=1.2.3` | 精确等于 | `1.2.4` 不满足 |
| `>=1.2.3` | 大于等于 | |
| `>1.2.3` / `<2.0.0` / `<=2.0.0` | 比较 | |
| `^1.2.3` | `>=1.2.3` 且同 major | `1.9.0` 满足；`2.0.0` 不满足 |
| `~1.4.0` | `>=1.4.0` 且同 major.minor | `1.4.9` 满足；`1.5.0` 不满足 |
| 多个约束 | 逻辑 AND | `>=0.1.0 <1.0.0` |
| 逗号 | 等同空格 | `>=1.0.0, <2.0.0` |

**不支持**：`*`、`x`、`1.x`、`1.2`（两位版本）、`1.2.3 - 2.0.0`（连字符范围）、`||`（或）、`latest`、`>= 1.0.0` 中间带空格（会被拆成两个 token，第二个 `1.0.0` 变成精确约束，语义可能出乎意料）。

范围比较前会剥掉版本里的 `-prerelease` 与 `+build`：`1.0.0-beta.1` 在比较时按 `1.0.0` 处理。`Satisfies` 遇到非法版本或非法范围一律返回 `false`。

## 12. 拒绝条件总表

| 条件 | 典型错误文案（`ErrInvalidManifest` 包裹） |
| --- | --- |
| `manifest_version != 1` | `manifest_version must be 1` |
| id 非法/过短/过长 | `id "..." must be a lowercase reverse-DNS identifier` |
| name 空/超长 | `name is required and must be at most 80 characters` |
| version 非 semver | `version "..." is not semver` |
| `engines.pp` 缺失/非法 | `engines.pp is required` / `engines.pp: ...` |
| `engines.contract` 非法 | `engines.contract: ...` |
| `runtime` 非法 | `runtime must be "wasm" or "none"` |
| wasm 无 backend | `runtime wasm requires a backend` |
| none 有 backend | `runtime none must not declare a backend` |
| 未知权限 | `unknown permission "..."` |
| `settings_schema` 非对象 | `settings_schema must be a JSON object` |
| ABI 非 v1 | `backend.abi must be "wasi-json-v1"` |
| entry 绝对路径/穿越/后缀错/不是普通文件 | `backend.entry: "..." must be a relative slash-separated path` / `escapes the plugin directory` / `must end with .wasm` |
| timeout 越界 | `backend.timeout_ms must be between 0 and 30000` |
| memory 越界 | `backend.max_memory_mb must be between 0 and 512` |
| 路由方法非法 | `route method "..." is not allowed` |
| 路由路径非法 | `route path "..." is not a safe absolute path` |
| 路由权限缺失 | `public route /x requires "http.route.public"` 等 |
| 路由 auth 非法 | `route auth must be public, member or admin` |
| 路由无 contract | `route /x has no contract operation` |
| contract 非 JSON / 无 responses / 含禁止键 / 含 `$ref` | `contract is not JSON` / `has no responses` / `may not declare security` / `may not use $ref in v1` |
| 重复路由 | `duplicate route GET /hello` |
| 未知 hook | `unknown hook "..."` |
| hook 缺权限 | `hook "content.render" requires permission "content.render"` |
| frontend 缺 `ui.inject` | `a frontend requires "ui.inject"` |
| styles 缺 `ui.style` | `a stylesheet requires "ui.style"` |
| 未知 slot | `unknown slot "..."` |
| block 类型非法/重复/缺权限 | `block type "..." must be lowercase kebab/dot` / `duplicate block type "..."` / `declaring blocks requires "ui.block"` |
| integrity 非 sha384 | `frontend.integrity must be a sha384 SRI value` |
| 清单有未知字段 | `decode: json: unknown field "..."`（由 `LoadManifest` 包裹） |
| 清单超限 | `manifest exceeds 262144 bytes` |
| 宿主版本不满足 | `plugin X requires host RANGE, running VERSION`（`Install`，非 `ValidateManifest`） |
| 契约版本不满足 | `plugin X requires contract RANGE, running VERSION` |
| 重复安装 / 编译失败 | `X is already installed` / `compile X: ...` |

## 13. 三个可直接用的最小清单

### 13.1 只有前端（无 WASM）

```json
{
  "manifest_version": 1,
  "id": "com.example.badge",
  "name": "阅读徽章",
  "version": "0.1.0",
  "engines": { "pp": ">=0.1.0 <1.0.0" },
  "runtime": "none",
  "frontend": {
    "entry": "frontend/client.js",
    "slots": ["article.after"]
  },
  "permissions": ["ui.inject"]
}
```

### 13.2 只有后端（无前端）

```json
{
  "manifest_version": 1,
  "id": "com.example.ping",
  "name": "Ping",
  "version": "0.1.0",
  "engines": { "pp": ">=0.1.0 <1.0.0" },
  "runtime": "wasm",
  "backend": {
    "entry": "backend/ping.wasm",
    "abi": "wasi-json-v1",
    "routes": [
      {
        "method": "GET",
        "path": "/ping",
        "auth": "public",
        "contract": {
          "summary": "Health ping",
          "responses": { "200": { "description": "pong" } }
        }
      }
    ]
  },
  "permissions": ["http.route.public"]
}
```

### 13.3 带设置 schema 的前后端插件

```json
{
  "manifest_version": 1,
  "id": "com.example.hello-settings",
  "name": "Hello Settings",
  "version": "0.2.0",
  "engines": { "pp": ">=0.1.0 <1.0.0", "contract": ">=1.0.0 <2.0.0" },
  "runtime": "wasm",
  "backend": {
    "entry": "backend/hello.wasm",
    "abi": "wasi-json-v1",
    "hooks": ["content.render"]
  },
  "frontend": {
    "entry": "frontend/client.js",
    "slots": ["site.footer"]
  },
  "permissions": ["content.render", "ui.inject"],
  "settings_schema": {
    "type": "object",
    "properties": { "headline": { "type": "string" } }
  }
}
```

## 14. 常见坑

1. **`runtime: "none"` 仍必须写 `engines.pp`**；`engines` 是必填对象。
2. **只写 `frontend.blocks` 也要 `ui.inject`**；只写 `frontend.styles` 还要额外 `ui.style`。
3. **`backend.routes[].contract` 不是可选的**；没有 operation 就安装失败。
4. **`contract` 不能有 `$ref`**；复杂 schema 必须内联复制。
5. **`method` 不能省略**；省略会得到 `route method "" is not allowed`。
6. **entry 必须直接位于 `frontend/`**，否则资产 URL 与真实路径不一致。
7. **清单任何位置都不能有未知键**；多写一个 `"icon"` 也会被拒绝（顶层字段表里没有这个字段）。
8. **`settings_schema` 被接收不等于设置有实现**；当前只是清单数据。
9. **重复权限无害，重复 block type / method+path 有害**。
10. **id 一旦发布就不要改**；契约路径、资产 URL、启用状态都以 id 为键。
