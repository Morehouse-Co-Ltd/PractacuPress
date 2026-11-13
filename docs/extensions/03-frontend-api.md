# 03 · 前端扩展接口（浏览器运行时插件）

- 上级文档：[README.md](README.md)
- 源码：`apps/web/src/lib/plugins/types.ts`、`registry.ts`、`runtime.ts`、`apps/web/src/components/PluginSlot.tsx`、`apps/web/src/components/blocks/index.tsx`
- 测试：`apps/web/src/lib/plugins/runtime.test.ts`、`blockRegistry.test.ts`
- 状态：🧪 **Spike 已实现，生产未接入**（没有 `App.tsx` 启动调用，也没有页面挂 `<PluginSlot>`）

## 1. 加载时序

```text
App（或任意宿主代码）
  → new PluginRuntime({ endpoint, siteId, ... })       // 可选，默认 defaultPluginRuntime
  → runtime.start()
      1. installGlobal()：把 window.__PP_PLUGIN_REGISTER__ 指向运行时
      2. GET /api/v1/plugins（Accept: application/json; credentials: same-origin）
      3. 逐项 activate(manifest)：
           a. validateManifest：id / version / entry 前缀
           b. assertSameOriginBundle：同源 + 路径以 /plugins/ 开头
           c. 插入 <script src=entry integrity=... async>，10 秒超时
           d. 脚本调用 __PP_PLUGIN_REGISTER__(id, version, factory)
           e. 取出 factory；校验 version 与清单一致
           f. materialize(factory, 冻结模块表) → definition
           g. definition.activate(ctx)（可 async）
           h. 状态置 active；失败则回滚已注册项、状态置 failed、继续下一个插件
```

关键事实：

- **没有 eval / new Function**。脚本加载后只注册一个函数，宿主直接调用它。
- **一个插件一个 factory**。注册后立刻从待注册表删除；没有在加载中的 id 的注册会被忽略（防止脚本「顺手」注入别的插件）。
- **失败隔离**。单个插件加载/激活失败不会中断 `start()` 的循环，也不会影响其他插件。
- **不做 HMR**。`start()` 只拉一次 boot manifest；服务端新启用的插件不会自动出现在已打开的页面。宿主若要热加载，需要自己重新拉清单并调用 `runtime.activate(manifest)`。

## 2. 引导清单接口

### 2.1 请求

```http
GET /api/v1/plugins HTTP/1.1
Host: example.test
Accept: application/json
```

该路由在 `router.go` 的 `/api/v1` 分组内：会经过站点解析、站点 IP 策略（若配置）、全局限流等中间件。响应固定 `Cache-Control: no-store`。

### 2.2 成功响应（参考插件真实输出）

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
```

```json
{
  "plugins": [
    {
      "id": "com.example.hello",
      "name": "Hello PP",
      "version": "1.0.0",
      "description": "Reference plugin for the plugin-host spike: one content hook, two routes and a browser half.",
      "entry": "/plugins/com.example.hello/1.0.0/client.js",
      "styles": ["client.css"],
      "slots": ["article.after"],
      "blocks": [{ "type": "hello.card", "name": "Hello card" }],
      "permissions": [
        "admin.route",
        "content.render",
        "http.route.public",
        "ui.block",
        "ui.inject",
        "ui.style"
      ]
    }
  ]
}
```

字段来源是 `plugins.PublicPlugin`（`host.go`）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 插件 id |
| `name` | string | 清单 name |
| `version` | string | 清单 version |
| `description` | string? | 清单 description |
| `entry` | string | **改写后的同源 URL**：`/plugins/{id}/{version}/{basename(entry)}` |
| `styles` | string[]? | 只有 **basename**（如 `client.css`），不是完整 URL；当前浏览器运行时不消费 |
| `slots` | string[]? | 清单声明的槽位 |
| `blocks` | `{type,name?}`[]? | 清单声明的区块 |
| `permissions` | string[]? | 去重 + 字母序 |
| `integrity` | string? | 清单的 `sha384-...`，浏览器会用于 SRI |
| `settings` | bool? | 仅表示清单有非空 `settings_schema`；没有设置值 |
| `manifest_hash` | string? | **结构体里有，当前从不赋值**（omitempty，所以不会出现） |

响应只包含**已启用且声明了 `frontend`** 的插件（`PublicPlugins()`），且是进程级全量，不按站点过滤。

### 2.3 失败响应

宿主未接入（当前生产默认）时，路由根本没有注册，由 Gin `NoRoute` 返回 problem JSON：

```http
HTTP/1.1 404 Not Found
Content-Type: application/problem+json
```

```json
{
  "type": "https://docs.practacu.press/errors/not_found",
  "title": "Not found",
  "status": 404,
  "code": "not_found",
  "message": "请求的资源不存在",
  "details": {
    "path": "/api/v1/plugins",
    "resource": "route"
  },
  "request_id": "req_01J8Z3Q7K5"
}
```

接入宿主后，站点无法解析时由站点中间件返回 `site_not_found`；这些是宿主级错误（`apperr` 格式），不是插件协议错误（插件宿主用的是另一种极简 problem 格式，见 [04-backend-api.md](04-backend-api.md)）。

## 3. 注册工厂

### 3.1 全局函数签名

```ts
window.__PP_PLUGIN_REGISTER__?: (
  id: string,
  version: string,
  factory: (require: (specifier: string) => unknown, module: { exports: unknown }, exports: unknown) => void,
) => void;
```

bundle 必须是经典脚本，内容只做一件事：

```js
window.__PP_PLUGIN_REGISTER__('com.example.hello', '1.0.0', function (require, module, exports) {
  'use strict';
  var React = require('react');

  function Hello(props) {
    return React.createElement('strong', null, 'Hello ' + (props.block?.props?.name || 'world'));
  }

  module.exports = {
    activate: function (ctx) {
      ctx.slots.register('article.after', 'footer', function () {
        return React.createElement('div', { className: 'pp-hello' }, 'Hello from a plugin');
      });
      ctx.blocks.register('hello.card', Hello);
    },
    deactivate: function () {
      // 可选；返回的 disposer 已经足够，这里是给需要清理定时器/监听的插件用的
    },
  };
});
```

规则：

| 项 | 规则 |
| --- | --- |
| id | 必须与清单一致；运行时只接受当前正在加载的 id |
| version | 必须与清单 `version` **完全一致**，否则 `bundle registered version X, manifest says Y` |
| 导出形态 | `module.exports` 本身，或 `module.exports.default`；必须是对象且有 `activate` 函数 |
| `activate` | 同步或 async 均可；抛错 → 插件 failed |
| `deactivate` | 可选；在 disposer 之前调用 |
| 顶层副作用 | 不禁止，但重载会重复执行；约定把副作用放进 `activate` |
| 模块格式 | 不能是 ESM（`import`/`export`）；宿主用普通 `<script>` 加载 |
| 语言特性 | 不能用 `eval`/`new Function`（启动器 CSP 无 `unsafe-eval`） |

### 3.2 冻结模块表

`runtime.ts` 的 `MODULE_TABLE` 只有 5 项：

| `require(...)` | 实际模块 |
| --- | --- |
| `react` | 宿主 React 实例 |
| `react-dom` | 宿主 ReactDOM |
| `react-dom/client` | 宿主 `createRoot` 等 |
| `react/jsx-runtime` | 宿主 JSX runtime |
| `react-router-dom` | 宿主 React Router |

- 其他任何 specifier（包括 `lodash`、`react/jsx-dev-runtime`）都会抛 `plugin requested a module outside the host table: ...`。
- `types.ts` 里的 `PLUGIN_MODULES` 常量额外列了 `react/jsx-dev-runtime`，但 `runtime.ts` **没有实现它**；构建时请确保 JSX 走 production runtime（`react/jsx-runtime`）。
- 宿主可以在构造 `PluginRuntime` 时通过 `options.modules` 注入额外模块（仅嵌入方可用，产品没有暴露）。
- 这样做的目的是保证 React 单实例；如果插件自带 React，hooks 会报错。

## 4. `ctx` 上下文 API

`PluginContext`（`types.ts`）完整形状：

```ts
interface PluginContext {
  readonly plugin: { id: string; version: string };
  readonly site: { id: string };
  readonly slots: {
    register(slot: string, id: string, render: (props: Record<string, unknown>) => ReactNode, options?: { order?: number }): Disposable;
  };
  readonly blocks: {
    register(type: string, renderer: (props: { block: PluginBlock }) => ReactNode): Disposable;
  };
  readonly ui: {
    addStyle(css: string): Disposable;
  };
  readonly api: {
    fetch(path: string, init?: RequestInit): Promise<Response>;
  };
  readonly log: (...args: unknown[]) => void;
}
```

### 4.1 `ctx.plugin` / `ctx.site`

```js
ctx.plugin; // { id: 'com.example.hello', version: '1.0.0' }
ctx.site;   // { id: '' } —— 默认空；宿主构造时传 siteId 才有值
```

`site.id` 不是由服务端注入的：`PluginRuntimeOptions.siteId` 默认 `''`。产品接入时需要由页面把当前站点 id 传进来。

### 4.2 `ctx.slots.register(slot, id, render, options?)`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `slot` | string | 必须是清单 `frontend.slots` 里声明过的宿主槽位 |
| `id` | string | 插件内唯一的贡献 id；同一插件在同一个 slot 里不能重复 |
| `render` | `(props) => ReactNode` | 渲染函数；宿主传给它的 props 是 `PluginSlot` 的 `props` 或 `{}` |
| `options.order` | number? | 排序值，默认 0；同值按注册先后 |

- 返回 `Disposable`；调用后立即从注册表移除。`deactivate` 时宿主也会统一清理。
- 校验顺序：`ui.inject` 权限 → 清单声明了该 slot → 注册表参数/重复检查。
- 渲染时每个贡献包在独立 error boundary 里；抛错只丢这一块 UI。

示例：

```js
ctx.slots.register('article.after', 'related', function Related(props) {
  return React.createElement('aside', { className: 'pp-related' }, '相关阅读：' + (props.title || '未命名'));
}, { order: 10 });
```

### 4.3 `ctx.blocks.register(type, renderer)`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `type` | string | 必须是清单 `frontend.blocks` 里声明过的类型 |
| `renderer` | React 组件（函数或对象） | 接收 `{ block }`，`block` 形状见下 |

```ts
interface PluginBlock {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  children?: PluginBlock[];
}
```

- 权限：`ui.block`；未声明 → 拒绝。
- 一个类型只能注册一次；第二个注册者会得到 `block type "..." is already registered`。
- **内置类型优先**：`blockRendererFor(type, pluginRenderer)` 的顺序是 `RENDERERS[type] ?? pluginRenderer ?? pluginBlockRegistry.get(type)`。即使插件注册了 `paragraph` 这类内置类型，渲染时仍然用内置组件（注册本身可能成功，但不会生效）。
- 区块视图订阅注册表（`useSyncExternalStore`），所以注册后已挂载的 `BlockView` 会重新解析渲染器，无需刷新页面。
- 插件区块只在前台/预览的 `BlockView` 里渲染；后台编排器是否列出该类型取决于编辑器的区块定义表，当前**不会**自动出现（编辑器只认内置 `blocks.ts` 定义）。这是「能渲染已有 type」与「能在编辑器里插入新 type」的区别。

示例：

```js
function HelloCard(props) {
  var name = props.block && props.block.props && props.block.props.name;
  return React.createElement(
    'div',
    { className: 'pp-hello-card', 'data-pp-plugin': 'com.example.hello' },
    React.createElement('strong', null, 'Hello ' + (name || 'world')),
  );
}

ctx.blocks.register('hello.card', HelloCard);
```

### 4.4 `ctx.ui.addStyle(css)`

| 项 | 规则 |
| --- | --- |
| 权限 | `ui.style` |
| 类型/长度 | 必须是 string；`length > 100_000` 拒绝（错误文案写「empty or too large」，但空字符串实际会通过） |
| 禁止构造 | 正则 `/@import|url\(\s*['"]?\s*javascript:|expression\(/i`；命中即拒绝 |
| 注入位置 | `document.head`，或构造时传入的 `styleRoot` |
| 标记 | `<style data-pp-plugin="{id}">` |
| 卸载 | 返回的 disposer 移除该 `<style>`；`deactivate/dispose` 也会清理 |
| 作用域 | **没有自动作用域**；插件应使用自己的前缀类名，避免污染宿主 |

```js
ctx.ui.addStyle(
  '.pp-hello-card{border:1px solid var(--pp-accent,#1f5c4a);border-radius:8px;padding:12px}' +
  '.pp-hello-footer{font-size:13px;opacity:.8}',
);
```

### 4.5 `ctx.api.fetch(path, init?)`

```js
const response = await ctx.api.fetch('/api/v1/plugins/com.example.hello/hello');
const data = await response.json();
```

| 项 | 规则 |
| --- | --- |
| path | 必须是字符串且以 `/api/` 开头；否则 Promise reject：`plugin api.fetch only accepts same-origin /api paths` |
| 请求 | `fetch(path, { credentials: 'same-origin', ...init })`；`init` 可以覆盖 `credentials` |
| 会话 | 同源 Cookie 会自动带上（这正是 T1「不是沙箱」的体现） |
| 限制 | 没有方法/域名白名单；`init` 里可以传任意 `method/body/headers` |

### 4.6 `ctx.log(...args)`

```js
ctx.log('activate', ctx.site.id); // console.debug('[pp plugin com.example.hello]', 'activate', ...)
```

仅调试用途；没有日志级别、上报或脱敏。

## 5. 槽位清单与命名

宿主闭集（`manifest.go` 的 `knownSlots`，8 个）：

| 槽位 | 预期位置 | 当前是否已挂载 |
| --- | --- | --- |
| `site.header` | 站点页头 | 🟡 未挂载 |
| `site.footer` | 站点页脚 | 🟡 未挂载 |
| `article.after` | 文章正文之后 | 🟡 未挂载（测试里用） |
| `article.sidebar` | 文章侧栏 | 🟡 未挂载 |
| `home.after` | 首页内容之后 | 🟡 未挂载 |
| `admin.nav` | 后台导航 | 🟡 未挂载 |
| `admin.settings` | 后台设置区 | 🟡 未挂载 |
| `admin.editor.tools` | 编辑器工具栏 | 🟡 未挂载 |

命名规则：

- 形如 `<surface>.<position>`，全小写、点分隔；大小写敏感。
- 没有通配符/自定义槽位；插件不能发明新槽位，只能在清单里选择宿主已开放的槽位。
- 清单校验与运行时注册都会检查；两处错误文案不同（服务端 `unknown slot`，浏览器 `did not declare slot`）。

**重要**：槽位存在 ≠ 页面有位置。`PluginSlot` 必须在具体页面里渲染，例如：

```tsx
<PluginSlot name="article.after" props={{ title: article.title }} />
```

当前产品页面没有任何 `<PluginSlot>`；所以即使前端插件成功激活，也不会出现在页面上。接入时需要在 `SiteChrome`、文章详情页、后台壳层逐个加锚点（设计文档 W4 列了 4 个先行槽位）。

## 6. 渲染与错误隔离（`PluginSlot`）

```tsx
import { PluginSlot } from '../components/PluginSlot';

<PluginSlot name="article.after" props={{ title }} runtime={runtime} />
```

- 用 `useSyncExternalStore` 订阅 `runtime.slots`，快照是 `slots.get(name)`；注册/注销立即触发重渲染。
- 每个贡献一个 `PluginBoundary`（class error boundary），渲染失败时该块返回 `null`，其余贡献继续渲染。
- 每个贡献外层是 `<div data-pp-plugin="{pluginID}" style="display:contents">`，方便调试与 CSS 定位，不破坏布局。
- 没有贡献时返回 `null`（不产生空容器）。

这就是「注册/卸载不刷新页面」的实现基础：**页面必须在挂载时订阅注册表**；如果整页重新加载，注册表会重建，插件需要重新激活。

## 7. 权限与负向用例

浏览器端只检查三件事：

| 操作 | 检查 | 失败文案 |
| --- | --- | --- |
| `slots.register` | `permissions` 含 `ui.inject` | `{id} did not declare the ui.inject permission` |
| `slots.register` | `manifest.slots` 含该 slot | `{id} did not declare slot "{slot}"` |
| `blocks.register` | `permissions` 含 `ui.block` | `{id} did not declare the ui.block permission` |
| `blocks.register` | `manifest.blocks` 含该 type | `{id} did not declare block "{type}"` |
| `ui.addStyle` | `permissions` 含 `ui.style` | `{id} did not declare the ui.style permission` |

测试里已覆盖：

```ts
// 清单 slots: [] 却注册 admin.nav
await expect(runtime.activate(demo)).rejects.toThrow('did not declare slot "admin.nav"');

// 清单 permissions: [] 却注册槽位
await expect(runtime.activate(demo)).rejects.toThrow('ui.inject');

// 清单 blocks: [] 却注册区块
await expect(runtime.activate(demo)).rejects.toThrow('did not declare block "demo.card"');

// 未登记模块
require('lodash'); // → plugin requested a module outside the host table: lodash
```

再次强调：**这些检查是「组合守卫」，不是安全边界**。恶意脚本可以直接操作 DOM，不需要走 `ctx`。

## 8. 资产服务

boot manifest 的 `entry` 指向：

```text
/plugins/{id}/{version}/{file}
```

服务端 `Host.AssetHandler` 的行为：

| 项 | 规则 |
| --- | --- |
| 方法 | 仅 `GET` / `HEAD`；其他返回 405 `method not allowed`（纯文本，不是 problem JSON） |
| 启用条件 | 插件必须存在、`enabled`、有 `frontend`、URL 里的 version 与清单完全一致 |
| 文件范围 | 只服务 `{pluginDir}/frontend/` 下的文件；不能访问 `plugin.json`、`backend/*.wasm`、`../` |
| 路径处理 | `path.Clean("/"+file)`；含 `..` 或空路径 → 404 |
| 类型 | 后缀白名单：`.js/.mjs`、`.css`、`.json`、`.svg`、`.png`、`.jpg/.jpeg`、`.webp`、`.woff2`、`.txt/.md`；其他尝试 `mime.TypeByExtension`，仍未知 → 404 |
| 缓存 | `Cache-Control: public, max-age=31536000, immutable`；`ETag: "{version}-{size}-{mtimeNano}"`；支持 `If-None-Match` → 304 |
| 安全头 | `X-Content-Type-Options: nosniff`；`.svg` 额外 `Content-Security-Policy: script-src 'none'` |
| 大小 | 读文件时 `io.LimitReader(..., 16<<20)`：单次响应最多读出 16 MiB，超出部分被静默截断（不是 404） |
| 哈希 | 服务端不校验 SRI；`integrity` 只由浏览器执行 |

### 8.1 成功示例

```http
GET /plugins/com.example.hello/1.0.0/client.js HTTP/1.1
Host: example.test
```

```http
HTTP/1.1 200 OK
Content-Type: text/javascript; charset=utf-8
Cache-Control: public, max-age=31536000, immutable
ETag: "1.0.0-1765-1762740000000000000"
X-Content-Type-Options: nosniff

(function () {
  'use strict';
  window.__PP_PLUGIN_REGISTER__('com.example.hello', '1.0.0', function (require, module, exports) {
    var React = require('react');
    // ...
  });
})();
```

### 8.2 304

```http
GET /plugins/com.example.hello/1.0.0/client.js HTTP/1.1
If-None-Match: "1.0.0-1765-1762740000000000000"
```

```http
HTTP/1.1 304 Not Modified
```

### 8.3 失败

```http
GET /plugins/com.example.hello/9.9.9/client.js HTTP/1.1
```

```http
HTTP/1.1 404 Not Found
Content-Type: text/plain; charset=utf-8

404 page not found
```

版本不匹配、插件未启用、文件不存在、试图访问 `../plugin.json` 或 `backend/hello.wasm` 都是同样的 404。

## 9. 生命周期、卸载与失败状态

| 操作 | 行为 |
| --- | --- |
| `runtime.start()` | 只执行一次；`started` 置 true 后再次调用直接返回。若首次 fetch 失败，`started` 仍为 true，**同一个实例不能重试** |
| `runtime.activate(manifest)` | 可单独调用；已 active/loading 的 id 抛 `already loaded` |
| `runtime.deactivate(id)` | 调 `definition.deactivate?.()` → 逆序执行 disposers → `slots.clearPlugin` / `blocks.clearPlugin` → 状态 `disposed` |
| `runtime.dispose()` | 停用全部插件，清空待注册/loading，恢复或删除全局 `__PP_PLUGIN_REGISTER__` |
| 激活失败 | 回滚已注册项、清空该插件的槽位/区块、状态 `failed`（保留 manifest 与 error）；异常继续抛给调用者 |
| `runtime.status()` | 返回 `{manifest, state, error?}` 快照；state ∈ `pending/active/failed/disposed` |

状态示例：

```js
await runtime.start();
runtime.status();
// [
//   { manifest: { id: 'com.example.demo', ... }, state: 'active' },
//   { manifest: { id: 'com.example.bad', ... }, state: 'failed', error: 'bundle did not register a factory for com.example.bad' }
// ]
```

## 10. 完整示例（参考插件，可直接对照）

`apps/api/internal/plugins/testdata/hello/frontend/client.js`：

```js
(function () {
  'use strict';
  window.__PP_PLUGIN_REGISTER__('com.example.hello', '1.0.0', function (require, module, exports) {
    var React = require('react');

    function HelloCard(props) {
      var name = props.block && props.block.props && props.block.props.name;
      return React.createElement(
        'div',
        { className: 'pp-hello-card', 'data-pp-plugin': 'com.example.hello' },
        React.createElement('strong', null, 'Hello ' + (name || 'world')),
        React.createElement('p', null, 'Rendered by a runtime plugin block.'),
      );
    }

    function ArticleFooter() {
      return React.createElement(
        'aside',
        { className: 'pp-hello-footer', 'data-pp-plugin': 'com.example.hello' },
        'Hello PP is installed. ',
        React.createElement('a', { href: '/api/v1/plugins/com.example.hello/hello' }, 'Plugin route'),
      );
    }

    module.exports = {
      activate: function activate(ctx) {
        ctx.slots.register('article.after', 'footer', ArticleFooter);
        ctx.blocks.register('hello.card', HelloCard);
        ctx.ui.addStyle(
          '.pp-hello-card{border:1px solid var(--pp-accent,#1f5c4a);border-radius:8px;padding:12px}' +
            '.pp-hello-footer{font-size:13px;opacity:.8}',
        );
      },
    };
  });
})();
```

配套 `client.css` 当前**不会自动加载**（见 §12）；需要的样式请放进 `ctx.ui.addStyle`，或由插件自己在 `activate` 里创建 `<link>`（不推荐，绕过 `ui.style` 的检查）。

带 hooks 的写法（函数组件在宿主树里渲染，hooks 可用）：

```js
function Counter() {
  var state = React.useState(0);
  var count = state[0];
  var setCount = state[1];
  return React.createElement(
    'button',
    { type: 'button', onClick: function () { setCount(count + 1); } },
    'clicked ' + count + ' times',
  );
}

ctx.slots.register('site.footer', 'counter', Counter);
```

## 11. 构建 recipe

目标：把 TS/TSX 打成「经典脚本 + 注册工厂」，并把宿主模块 external 掉。

```powershell
# 1) 以 CJS 打 bundle，React 等 external
node node_modules/esbuild/bin/esbuild src/index.tsx `
  --bundle --format=cjs --platform=browser --target=es2020 `
  --external:react --external:react-dom --external:react-dom/client `
  --external:react/jsx-runtime --external:react-router-dom `
  --define:process.env.NODE_ENV='"production"' `
  --outfile=dist/bundle.cjs

# 2) 用一段包装把头尾补上，产出 frontend/client.js
node scripts/wrap-plugin.mjs
```

包装脚本的最小实现：

```js
import { readFileSync, writeFileSync } from 'node:fs';

const id = 'com.example.hello';
const version = '1.0.0';
const bundle = readFileSync('dist/bundle.cjs', 'utf8');

const output =
  `window.__PP_PLUGIN_REGISTER__(${JSON.stringify(id)}, ${JSON.stringify(version)}, function (require, module, exports) {\n` +
  bundle +
  `\n});\n`;

writeFileSync('frontend/client.js', output);
```

检查清单：

- [ ] 产物里没有 `import` / `export`（不能是 ESM）。
- [ ] 产物只 `require` 了那 5 个宿主模块（可以用 `grep -o 'require("[^"]*")'` 自查）。
- [ ] `id` / `version` 与 `plugin.json` 完全一致。
- [ ] 没有 `eval` / `new Function`（CSP 会直接拦）。
- [ ] `entry` 文件直接放在 `frontend/` 下（不能是 `frontend/dist/...`）。
- [ ] `module.exports` 是对象且有 `activate`。
- [ ] 副作用放在 `activate`，方便卸载/重载。

## 12. 限制与已知差异（前端）

1. **没有 HMR/推送**：启用、禁用、升级插件都不会通知已打开的页面；需要宿主重新拉 boot manifest 并 `activate/deactivate`。
2. **boot manifest 的 `styles` 不被消费**：服务端只返回 basename，`PluginRuntime` 完全不读 `manifest.styles`。参考插件的 `client.css` 因此不会生效。
3. **`react/jsx-dev-runtime` 不可用**：`types.ts` 的 `PLUGIN_MODULES` 列了它，`runtime.ts` 的模块表没有；开发构建若引用它会运行时抛错。
4. **`ctx.site.id` 默认为空**：需要嵌入方传 `siteId`。
5. **没有主题 token / 路由 / 设置页 API**：`PluginContext` 只有 `slots/blocks/ui/api/log`。
6. **区块只在渲染端可用**：后台编排器的区块选择表是静态 `blocks.ts`，插件类型不会自动出现在编辑器里；要插入 `hello.card`，目前只能通过已有数据/手工 JSON，产品化需要编辑器扩展点。
7. **槽位没有产品锚点**：8 个槽位都有名字，但页面里没有 `<PluginSlot>`。
8. **SRI 可选且服务端不校验**：`integrity` 只在浏览器侧生效；没有哈希锁定的安装流程。
9. **错误只到 console**：`onError` 默认 `console.error`；没有遥测、上报或管理页状态。
10. **`start()` 不可重试**：首次 fetch 失败后同一实例不能再次 `start()`；要么新建实例，要么直接 `activate`。

这些差异在 [05-compatibility-gaps.md](05-compatibility-gaps.md) 里有统一编号与影响评估。
