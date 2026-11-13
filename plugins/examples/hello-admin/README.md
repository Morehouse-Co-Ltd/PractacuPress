# Hello Admin（纯前端扩展示例）

在后台注册一个「扩展页面」，页面里显示实时时间。它没有后端代码，用来演示最小
可用的扩展包结构。

## 打包与安装

```powershell
# 仓库根目录
powershell -ExecutionPolicy Bypass -File scripts\package-extension.ps1 -Dir plugins\examples\hello-admin
# 产物：dist\extensions\com.example.hello-admin-1.0.0.zip
```

后台：`扩展 → 导入扩展`，选择上面生成的 zip。导入成功后：

- 导航出现「扩展页面 → Hello Admin」（也可以直接访问 `/admin/ext/hello-admin`）；
- 在「扩展」页里可以看到它的版本、权限（`ui.inject`）、前端入口，并可启用/禁用/删除。

## 文件结构

```
hello-admin/
  plugin.json          # 清单：runtime = "none"，只声明 frontend
  frontend/client.js   # 经典脚本 + __PP_PLUGIN_REGISTER__ 工厂
```

## 关键点

- `client.js` 是**经典脚本**，不能写 `import`；React 通过工厂的 `require('react')` 取得，
  由宿主保证单实例。
- 页面用 `ctx.admin.registerPage(...)` 注册；`path` 会成为 `/admin/ext/<path>`，
  `group: 'extensions'` 表示放在「扩展页面」导航组（`'overview'` 会排在仪表盘下方）。
- 前端扩展与页面同源、拥有页面权限：只安装可信来源的扩展。详见
  [`docs/extensions/06-install-and-package.md`](../../../docs/extensions/06-install-and-package.md)。
