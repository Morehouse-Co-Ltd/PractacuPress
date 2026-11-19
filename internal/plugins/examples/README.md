# pp 插件 / 扩展源目录

这个目录放扩展（插件）源码示例。可安装的扩展包由它打包而来；同样的目录结构也用于
`internal/plugins/testdata/hello/` 的宿主测试夹具。

``` 
<plugin-id>/
  plugin.json          # 清单，唯一入口
  backend/             # 可选，WASM 服务端
    main.go
    hello.wasm         # 构建产物（打包时生成，安装器不构建）
  frontend/            # 可选，浏览器端
    client.js          # 经典脚本 + __PP_PLUGIN_REGISTER__ 工厂
    client.css
  README.md
```

## 示例

| 示例 | 类型 | 演示内容 |
| --- | --- | --- |
| [`hello-admin`](hello-admin/README.md) | 纯前端 | 用 `ctx.admin.registerPage` 在后台注册一个「扩展页面」 |
| [`hello`](hello/README.md) | 前端 + Go/WASM 后端 | 前端槽位/区块 + 沙箱后端路由 + `content.render` 钩子 |

## 打包成可导入的扩展包

```powershell
powershell -ExecutionPolicy Bypass -File scripts\package-extension.ps1 -Dir internal\plugins\examples\hello-admin
powershell -ExecutionPolicy Bypass -File scripts\package-extension.ps1 -Dir internal\plugins\examples\hello
# 产物：dist\extensions\<id>-<version>.zip
```

然后后台「扩展 → 导入扩展」上传 zip。完整格式、权限、前端 API、后端 ABI 与安全边界见
[`docs/extensions/06-install-and-package.md`](../../../docs/extensions/06-install-and-package.md)。

## 构建服务端 WASM

```powershell
./scripts/build-plugin-wasm.ps1 -PluginDir internal/plugins/examples/hello
```

脚本设置 `GOOS=wasip1 GOARCH=wasm`，产出 `backend/hello.wasm`。发布包必须带预编译产物；
安装器不会执行 `go build`/`npm install`（`package-extension.ps1` 只是在**打包阶段**帮忙构建）。

## 构建浏览器 bundle

插件作者需要把 ESM/TSX 打成「经典脚本 + 工厂注册」的形式，并把 React 等宿主模块 external 掉：

```js
// 构建尾部（示意）
window.__PP_PLUGIN_REGISTER__('com.example.hello', '1.0.0', function (require, module) {
  var React = require('react');
  // ...模块体...
  module.exports = { activate: function (ctx) { /* ... */ } };
});
```

必须 external：`react`、`react-dom`、`react-dom/client`、`react/jsx-runtime`、`react-router-dom`。
宿主不提供其他模块；`require` 未登记模块会直接抛错。

## 本地验证

```powershell
./scripts/plugin-spike.ps1
```

该脚本运行 Go 插件宿主测试、路由集成测试、前端 typecheck 与插件运行时测试。
