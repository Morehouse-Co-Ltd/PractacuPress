# Hello（前端 + Go/WASM 后端扩展示例）

这是插件协议的参考实现，包含：

- **前端**：注册一个区块 `hello.card`、文章底部槽位 `article.after`，并通过
  `ctx.api.fetch` 调用自己后端路由；
- **后端**：Go 编译成 `wasip1` WASM，在 wazero 沙箱里运行；提供
  `GET /api/v1/plugins/com.example.hello/hello`（public）与
  `.../admin/ping`（admin）两个路由，并实现 `content.render` 钩子。

`backend/hello.wasm` 不提交，打包时由脚本用 Go 现场构建。

## 打包与安装

```powershell
# 仓库根目录；会构建 backend/hello.wasm 再压成 zip
powershell -ExecutionPolicy Bypass -File scripts\package-extension.ps1 -Dir plugins\examples\hello
# 产物：dist\extensions\com.example.hello-1.0.0.zip
```

后台：`扩展 → 导入扩展` 选择 zip。启用后：

- 前端：文章页底部出现 Hello PP 的说明与「Plugin route」链接；
- 后端：`GET /api/v1/plugins/com.example.hello/hello` 返回沙箱生成的 JSON；
  `GET /api/v1/plugins/com.example.hello/admin/ping` 需要站点管理员会话。

## 自己写一个 Go 后端扩展

```go
// backend/main.go  （GOOS=wasip1 GOARCH=wasm go build -o <name>.wasm .）
package main

import (
    "encoding/json"
    "fmt"
    "io"
    "os"
)

func main() {
    raw, _ := io.ReadAll(os.Stdin)
    var request map[string]any
    _ = json.Unmarshal(raw, &request)
    // request: {abi, plugin_id, version, route, handler, payload, capabilities}
    response := map[string]any{
        "status":  200,
        "headers": map[string]string{"Content-Type": "application/json"},
        "body":    `{"message":"hello"}`,
    }
    out, _ := json.Marshal(response)
    fmt.Print(string(out))
}
```

清单 `plugin.json` 里声明 `runtime: "wasm"`、`backend.entry`、路由与所需权限。
ABI、超时与权限细节见 [`docs/extensions/04-backend-api.md`](../../../docs/extensions/04-backend-api.md)
和 [`06-install-and-package.md`](../../../docs/extensions/06-install-and-package.md)。
