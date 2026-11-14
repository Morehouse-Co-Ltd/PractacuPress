# 02 · 编写主题：组件、页面基地与 JSON 编排

面向主题作者与前端开发者。读完这篇你应该能交付一个主题包：用前端语言写组件，用 JSON 把
组件拼成页面，让站长的页面编排器直接接管；需要接口时再带一个 Go/WASM 后端。

先给结论：

> **主题不是一套写死的页面，而是一套「组件 + 页面基地 + 编排数据」的能力。**
>
> 组件决定「页面上能出现什么」，页面基地决定「整页的骨架与观感」，JSON 决定「这一页由哪些
> 组件、按什么顺序、带什么属性组成」。页面编排器编辑的就是最后那份 JSON，所以主题装进来
> 以后，站长仍然可以拖拽、改文案、加删组件。

## 目录

- [一、能力与边界](#capabilities)
- [二、主题包长什么样](#package)
- [三、写组件：前端扩展包](#components)
- [四、页头、页脚与页面基地](#base)
- [五、页面编排数据（JSON）](#composition)
- [六、让页面编排器适配你的组件](#builder)
- [七、后台左侧 tab 与 Go 后端](#extensions)
- [八、校验与限制](#validation)
- [九、作者自查清单](#checklist)

<a id="capabilities"></a>

## 一、能力与边界

| 能 | 不能 |
| --- | --- |
| 注册新的区块类型（React 渲染器 + 属性面板 schema + 默认落位） | 覆盖或删除内置区块类型 |
| 注入页面基地 CSS、图标字体、设计令牌之外的自定义属性 | 在主题包内直接改 React 路由、中间件或数据库 |
| 提供首页 / 文章页 / 自定义页面的 JSON 编排 | 用主题包静默删除文章、成员、媒体或导航数据 |
| 注册后台页面（`/admin/ext/{path}`）与其左侧 tab | 把后台页面挂到任意 URL（路由由宿主拥有） |
| 提供 `admin/tabs.json` 让服务端按数据生成设置页 | 在后台页面里直接读数据库（必须走 API） |
| 打包 Go/WASM 后端，提供 `/api/v1/plugins/{id}/...` 路由 | 访问文件系统、网络、环境变量或宿主中间件 |

两条硬边界要先记住：

1. **组件是同源代码**。前端扩展与站点同源运行，能读 DOM、Cookie（HttpOnly 除外）和
   localStorage。它**不是沙箱**，权限声明只保证「没声明就不能占用某个槽位/区块」，不阻止
   恶意代码。因此组件包只允许**平台管理员**安装（「扩展」页），不要把来源不明的包装成
   前端扩展。
2. **后端是沙箱**。Go 编译成 `wasip1` WASM，在 wazero 里执行，没有文件、网络与环境变量；
   能力面由 `plugin.json` 的 routes 与 ABI 决定。详见 [05](./05-admin-and-backend.md#backend)
   与 [扩展后端 ABI](../extensions/04-backend-api.md)。

<a id="package"></a>

## 二、主题包长什么样

```text
my-theme.zip
├── theme.json                 # 主题清单（元数据、令牌、页面索引、组件/后端引用）
├── README.md                  # 给人看的说明 + 回链本套文档
├── components/
│   ├── plugin.json            # 前端扩展清单：blocks 声明、权限
│   ├── client.js              # 组件代码：注册区块、注入样式
│   └── client.css             # 可选：页面基地样式
├── pages/
│   ├── home.json              # 首页编排
│   ├── article.json           # 文章页附加区块
│   └── page-about.json        # 自定义页面「关于」
├── admin/                     # 可选
│   ├── tabs.json              # 数据驱动的后台侧栏页
│   └── pages/*.html           # 或自己写的后台页面
└── backend/                   # 可选
    ├── plugin.json            # 后端扩展清单（runtime: wasm）
    ├── theme.wasm             # Go 构建产物
    └── main.go                # 源码
```

`theme.json` 的完整字段表见 [04 主题包格式](./04-package.md#manifest)。最小可导入的主题包
只需要 `theme.json` + `README.md`；只带令牌与版式的旧 `.json` 主题也仍然能导入。

<a id="components"></a>

## 三、写组件：前端扩展包

主题组件就是一个标准的前端扩展包，格式与 [`docs/extensions/06`](../extensions/06-install-and-package.md)
完全一致：`plugin.json` + 一个**经典脚本**（不是 ESM）。区别只在内容——主题的脚本要注册
区块类型，并声明编排器需要的元数据。

### 3.1 `components/plugin.json`

```json
{
  "manifest_version": 1,
  "id": "com.acme.aurora",
  "name": "Aurora 主题组件",
  "version": "1.0.0",
  "description": "Aurora 主题的开屏、卡片墙与订阅条。",
  "engines": { "pp": ">=0.1.0 <1.0.0" },
  "runtime": "none",
  "frontend": {
    "entry": "client.js",
    "styles": ["client.css"],
    "blocks": [
      {
        "type": "aurora.hero",
        "name": "极光开屏",
        "description": "大标题、副标题与两个行动按钮。",
        "group": "shared",
        "variants": ["classic", "bento"],
        "area": "full",
        "defaults": {
          "heading": "写下你的第一行",
          "sub": "一个安静的地方，用来放长文。",
          "primary": "开始阅读",
          "primary_link": "/articles"
        },
        "schema": [
          { "key": "heading", "label": "主标题", "type": "text" },
          { "key": "sub", "label": "副标题", "type": "text" },
          { "key": "primary", "label": "主按钮文字", "type": "text" },
          { "key": "primary_link", "label": "主按钮链接", "type": "text" }
        ]
      }
    ]
  },
  "permissions": ["ui.inject", "ui.block", "ui.style"]
}
```

字段规则：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `type` | 是 | 小写字母、数字、`.`、`-`、`_`；不能与内置区块重名。约定用 `<作者>.<组件>`，例如 `aurora.hero` |
| `name` | 否 | 编排器「添加组件」里显示的名字，≤60 字 |
| `description` | 否 | 一句话说明，≤200 字 |
| `group` | 否 | `shared`（默认）/ `classic` / `nightflight` / `content`；只影响归类，不限制使用 |
| `variants` | 否 | 缺省 `["classic","bento"]`；决定哪些版式的「添加组件」里出现 |
| `area` | 否 | `full` / `main` / `side`，双栏下的默认落位；缺省 `main` |
| `defaults` | 否 | 新插入组件时的初始属性，必须是一层 JSON 对象（值只能是字符串/数字/布尔） |
| `schema` | 否 | 属性面板的字段声明，见 3.3；缺省时组件没有可编辑属性 |

`schema` 的每个字段直接对应 `PropSchema`：`{ key, label, type, hint?, options?, min?, max?, step?, bindable?, itemSchema?, minItems?, maxItems? }`。
支持的 `type`：`text`、`textarea`、`richtext`、`number`、`select`、`toggle`、`color`、
`media`、`repeater`、`itemlist`（只为读旧数据保留）。

### 3.2 `components/client.js`

必须是经典脚本，尾部调用 `window.__PP_PLUGIN_REGISTER__`：

```js
window.__PP_PLUGIN_REGISTER__('com.acme.aurora', '1.0.0', function (require, module) {
  var React = require('react');

  function Hero(props) {
    var block = props.block;
    var p = block.props || {};
    return React.createElement(
      'section',
      { className: 'aurora-hero' },
      React.createElement('h1', null, p.heading || ''),
      p.sub ? React.createElement('p', null, p.sub) : null,
      p.primary
        ? React.createElement(
            'a',
            { className: 'btn btn-primary', href: p.primary_link || '#' },
            p.primary,
          )
        : null,
    );
  }

  module.exports = {
    activate: function (ctx) {
      // 区块渲染器：props.block 是当前区块，props.block.props 是编排里保存的属性。
      ctx.blocks.register('aurora.hero', Hero);

      // 页面基地样式：只在主题启用期间存在，一条 <style data-pp-plugin>。
      ctx.ui.addStyle(
        [
          '.aurora-hero{padding:clamp(48px,9vw,120px) 0;border-bottom:1px solid var(--line);}',
          '.aurora-hero h1{font-family:var(--serif);font-size:clamp(32px,6vw,68px);line-height:1.04;margin:0 0 16px;}',
          '.aurora-hero p{color:var(--muted);font-size:clamp(15px,2vw,20px);max-width:52ch;}',
        ].join('\n'),
      );
    },
  };
});
```

可以 `require` 的模块只有冻结表里的五个：`react`、`react-dom`、`react-dom/client`、
`react/jsx-runtime`、`react-router-dom`。其他一律抛错。

打包建议（esbuild）：

```powershell
# apps/web 的依赖里已有 esbuild
npx esbuild src/index.tsx --bundle --format=iife --global-name=AuroraTheme `
  --external:react --external:react-dom --external:react-dom/client `
  --external:react/jsx-runtime --external:react-router-dom `
  --outfile=components/client.js
# 再在文件尾部拼上 __PP_PLUGIN_REGISTER__ 注册尾
```

> 为什么是经典脚本：宿主用 `<script src>` 加载并冻结模块表，React 只保留页面里的单实例，
> 不引入 `eval`。ESM 的顶层 `import` 会绕过模块表。

### 3.3 属性面板怎么读你的 `schema`

页面编排器的右侧属性面板按 `schema` 逐项渲染：

| `type` | 控件 | 值 |
| --- | --- | --- |
| `text` | 单行输入 | 字符串 |
| `textarea` | 多行输入 | 字符串 |
| `richtext` | Markdown 编辑器 + 预览 | Markdown 字符串（≤8000 字节） |
| `number` | 数字输入（`min` / `max` / `step`） | 数字 |
| `toggle` | 开关 | 布尔 |
| `select` | 下拉（`options: [{value,label}]`） | 字符串 |
| `color` | 颜色选择器 | 十六进制字符串 |
| `media` | 媒体库选择器 | 站内媒体地址或 `/` 开头的路径 |
| `repeater` | 可增删的条目列表（`itemSchema` 递归声明） | 条目数组 |
| `itemlist` | 旧版 JSON 字符串列表 | 尽量改用 `repeater` |

`bindable: true` 只对 `text` / `textarea` / `richtext` 生效：站长可以把字段绑定成
「显示文章标题 / 摘要 / 作者 / 日期」等运行期数据。CSS、HTML、JS 类字段不要开。

### 3.4 组件可以拿到什么

渲染器只接收 `{ block }`，其中：

```ts
interface PluginBlock {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  children?: PluginBlock[];
}
```

不要直接读 `window` 上的后台状态；需要站点数据就调同源 API：

```js
module.exports = {
  activate: function (ctx) {
    ctx.blocks.register('aurora.stats', function (props) {
      var React = require('react');
      var [count, setCount] = React.useState(null);
      React.useEffect(function () {
        ctx.api
          .fetch('/api/v1/articles?limit=1')
          .then(function (res) { return res.json(); })
          .then(function (body) { setCount(body.total ?? 0); })
          .catch(function () {});
      }, []);
      return React.createElement('p', null, count == null ? '…' : count + ' 篇文章');
    });
  },
};
```

`ctx.api.fetch` 只接受 `/api/` 开头的路径，带同源 Cookie，不能跨源。

<a id="base"></a>

## 四、页头、页脚与页面基地

「页面基地」是主题对**整页骨架**的控制，由三部分组成：

1. **设计令牌**（`theme.json` 的 `theme`）：颜色、字体、字号、栏宽、圆角、柔化。
   13 个令牌的语义与 CSS 变量映射见 [03](./03-appearance.md#tokens)。
2. **版式变体**（`theme.json` 的 `variant`）：`classic`（单栏）/ `bento`（双栏）/
   `daylight`（旧卡片）。变体决定 `<html data-variant>`、首页默认编排、可选区块集合与
   双栏落位。
3. **页面基地 CSS**（`components/client.css` 或 `ctx.ui.addStyle`）：页头、导航、页脚、
   开屏、卡片等结构样式。它和令牌一起工作，**不要在组件里写死颜色**，读变量：

```css
/* client.css */
.site-header { border-bottom: 1px solid var(--line); background: var(--bg); }
.site-header .brand-mark { background: var(--accent); color: var(--accent-ink); }
.site-footer { color: var(--muted); border-top: 1px solid var(--line); }
```

页面基地的边界：

- 页头 / 页脚 / 导航的**数据**（Tab、二级入口、页脚栏目、版权）属于站点设计，不属于主题；
  主题只能改它们的外观。
- 不要覆盖 `--danger` / `--warn` / `--ok` 等语义色，也不要改后台的
  `html[data-surface="admin"]` 令牌。
- 媒体查询断点只有一套：480 / 768 / 1024 px（`lib/layout.ts`）。组件里的响应式写法要和它
  一致，别自造阈值。

<a id="composition"></a>

## 五、页面编排数据（JSON）

页面不是 HTML，而是一棵 `BlockInstance` 树。`pages/home.json` 与站点设计里的
`customization.home` **完全同构**，导入后原样写入，页面编排器读的也是它。

### 5.1 最小页面

```json
{
  "blocks": [
    {
      "id": "blk_hero",
      "type": "aurora.hero",
      "title": "极光开屏",
      "props": {
        "heading": "写下你的第一行",
        "sub": "一个安静的地方，用来放长文。",
        "primary": "开始阅读",
        "primary_link": "/articles"
      },
      "animation": "fade-up",
      "hidden": false,
      "area": "full"
    }
  ]
}
```

`id` 只要求同一份编排里唯一；导入时会自动去重，作者可以随意写。

### 5.2 区块的字段

| 字段 | 说明 |
| --- | --- |
| `id` | 编排内唯一；导入时重复会重新生成 |
| `type` | 内置类型或主题注册的类型（`aurora.hero`） |
| `title` | 编排器左树里的显示名，留空用组件名 |
| `props` | 组件属性；键与 `schema` 对应，只允许标量或 repeater 条目数组 |
| `animation` | `none` / `fade` / `fade-up` / `slide-left` / `slide-right` / `zoom` |
| `hidden` | 是否在访客页隐藏（编排器里仍可见） |
| `area` | 双栏落位 `full` / `main` / `side`；缺省按组件声明的 `area` |
| `span` / `offset` | 12 栏栅格占位与偏移（1–12） |
| `width` / `height` | 像素宽高；与 `span` 同时存在时 `span` 优先 |
| `mt` / `mb` | 间距标尺下标 |
| `appearance` | 圆角、阴影、裁剪、背景、内边距、描边（见 [03](./03-appearance.md#components)） |
| `custom_css` | 只作用于这个区块的 CSS 声明（≤4000 字符） |
| `at.tablet` / `at.mobile` | 只覆盖展示层：`span` / `offset` / `appearance` / `animation` / `hidden` / `custom_css` / `width` / `height` / `align` / `gap_scale` / `mt` / `mb` |
| `visible` | 条件显示（角色、登录态、时间窗、设备等） |
| `children` | 容器类区块（`columns` / `grid` / `section` / `container`）的子区块 |

### 5.3 容器与嵌套

```json
{
  "blocks": [
    {
      "id": "blk_cols",
      "type": "columns",
      "title": "两栏",
      "props": {},
      "animation": "none",
      "hidden": false,
      "children": [
        { "id": "blk_a", "type": "text", "title": "左", "props": { "body": "左边" }, "column": 1 },
        { "id": "blk_b", "type": "text", "title": "右", "props": { "body": "右边" }, "column": 2 }
      ]
    }
  ]
}
```

最多 8 层嵌套、每个容器最多 60 个子区块、整份设计最多 400 个区块。

### 5.4 页面索引

`theme.json` 的 `pages` 数组把路由映射到文件：

```json
"pages": [
  { "path": "/", "file": "pages/home.json", "title": "首页", "kind": "home" },
  { "path": "/a/:id", "file": "pages/article.json", "title": "文章页", "kind": "article" },
  { "path": "/about", "file": "pages/page-about.json", "title": "关于", "kind": "page", "slug": "about" }
]
```

- `kind: "home"` 写入 `customization.home`；
- `kind: "article"` 写入 `customization.article`（文章正文之后、评论区之前）；
- `kind: "page"` 按 `slug` 匹配自定义页面：有则替换编排，没有则新建一个页面。

<a id="builder"></a>

## 六、让页面编排器适配你的组件

主题组件不是「能渲染就算完」。页面编排器需要知道四件事，才能把它当一等公民：

| 编排器需要 | 来自哪里 | 不做会怎样 |
| --- | --- | --- |
| 组件出现在「添加组件」里 | `blocks[].variants` 与当前版式匹配 | 站长只能看到内置区块 |
| 插入时有合理初值 | `blocks[].defaults` | 新组件是一片空白，站长不知道怎么填 |
| 属性面板能编辑 | `blocks[].schema` | 右侧面板没有字段，只能改 JSON |
| 双栏下有默认落位 | `blocks[].area` | 组件默认挤进主栏，侧栏空着 |

注册时的元数据以 `plugin.json` 为准，**不读 bundle 自己的说法**：宿主在
`ctx.blocks.register(type, renderer)` 时按清单里同 `type` 的声明补齐 `name / schema /
defaults / area / variants`。所以改元数据要改 `plugin.json`，重新打包安装。

编排器里的实际行为：

- 分组：「添加组件」面板新增「主题组件」一组，来自所有已启用扩展声明的区块；
- 图标与说明：用 `name` / `description`；
- 新插入：`createBlock(type)` 用 `defaults` 初始化 `props`，`title` 取 `name`；
- 属性面板：按 `schema` 逐项渲染（3.3）；
- 读取旧数据：如果编排里出现未注册的类型，数据会保留（`unsupported: true`）但不会渲染；
  组件安装并启用后，同一份数据立即恢复渲染，不需要重新导入主题；
- 保存：编排器写回的仍是同一份 JSON，主题组件与内置区块没有区别。

> 状态：组件元数据（`name / description / group / variants / area / defaults / schema`）
> 与「主题组件」分组已经进入协议；不同发行版对「未注册类型」的显示可能略有差异，
> 以你安装的版本的编辑器为准。

<a id="extensions"></a>

## 七、后台左侧 tab 与 Go 后端

这两块是主题的「服务端半边」，完整说明见 [05 后台侧栏与后端](./05-admin-and-backend.md)：

- **自己写页面**：组件包的 `activate` 里调用
  `ctx.admin.registerPage({ id, path, label, icon, group, order, render })`，后台左侧就会出现
  一个 tab，页面在 `/admin/ext/{path}`；`render()` 返回 React 节点。
- **交数据文件**：`admin/tabs.json` 声明 tab、字段与动作，服务端按数据生成设置页。协议与
  状态见 [05](./05-admin-and-backend.md#tabs)。
- **Go 后端**：`backend/` 是一个标准 WASM 扩展包（`GOOS=wasip1 GOARCH=wasm`），路由由
  `plugin.json` 声明，宿主挂在 `/api/v1/plugins/{id}/...`；组件里用
  `ctx.api.fetch('/api/v1/plugins/com.acme.aurora/stats')` 调用。没有文件、网络与环境变量，
  需要数据要么由前端传进去，要么走宿主既有 API。

<a id="validation"></a>

## 八、校验与限制

### 8.1 主题包

- zip ≤ 32 MiB，解压后 ≤ 64 MiB，文件数 ≤ 300；
- 拒绝路径穿越、绝对路径、符号链接、Windows 保留名与 `:`；
- `theme.json` 必须在 zip 根级，≤256 KiB；
- 页面文件每个 ≤512 KiB，最多 24 个；
- `theme.json` 的 `theme` 仍走旧的主题校验（令牌白名单、数值夹取），见 [03](./03-appearance.md#validation)。

### 8.2 组件清单

- `blocks[].type` 必须匹配小写 kebab/dot，且不能与内置类型重名；
- `variants` 只能是 `classic` / `bento` / `daylight`；
- `area` 只能是 `full` / `main` / `side`；
- `defaults` 必须是一层 JSON 对象，值只能是字符串/数字/布尔；
- `schema` 必须是数组，单条 ≤2 KiB，整体 ≤16 KiB；未知 `type` 的字段会被忽略；
- 每个 `plugin.json` ≤256 KiB；`frontend.entry` 必须存在且是 `.js`。

### 8.3 页面编排

| 限制 | 值 |
| --- | --- |
| 单页区块数 | 400（读取时最多 2000，超出按尾部剔除） |
| 嵌套深度 | 8 |
| 单容器子区块 | 60 |
| 单区块 props | 8 KiB |
| `custom_css` | 4000 字符 |
| 整份站点设计 | 1 MiB（服务端硬上限），前端 512 KiB 软警告 |

### 8.4 安全边界

- 组件是**同源代码**，只允许平台管理员安装；主题包由站点管理员导入，导入前请确认来源。
- 主题的 CSS 可以覆盖页面基地，但不能越过 CSP：不允许内联事件处理器的脚本执行、
  不允许外链未声明的脚本。
- 后端在 wazero 沙箱里运行，内存/超时/请求体都有上限，清单不接受未声明的 route。
- 主题包不能改 `--danger` / `--warn` / `--ok`，也不能改后台与安装向导的令牌。

<a id="checklist"></a>

## 九、作者自查清单

发布前逐条过：

- [ ] `components/plugin.json` 的 `blocks` 声明完整：`name`、`description`、`variants`、`area`、`defaults`、`schema`。
- [ ] 每个 `type` 都调用了 `ctx.blocks.register`，且渲染器能处理 `props` 缺省、空字符串与未绑定值。
- [ ] `schema` 的 `key` 与 `defaults` 一一对应；没有把 `color` 字段写成 `text`。
- [ ] 组件渲染不写死颜色/字体，读 `var(--bg)`、`var(--ink)`、`var(--accent)` 等令牌。
- [ ] `pages/*.json` 能被导入，且导入后首页/文章页/自定义页在编排器里可继续编辑。
- [ ] 双栏主题里给每个组件标了合理的 `area`（`full` / `main` / `side`）。
- [ ] 后台 tab 的 `path` 全小写、唯一；`render()` 有错误边界可捕获的失败提示。
- [ ] 有后端时，`plugin.json` 只声明实际用到的 routes，且组件里的调用路径与之一致。
- [ ] 主题包根目录有 `README.md`，链接回 `docs/themes/README.md` 与 `docs/themes/04-package.md`。
- [ ] 用「导入主题」真导一次：配色、版式、首页编排、组件分组、属性面板都对。
- [ ] 卸载组件扩展后，主题页面的区块不报错（应降级为不渲染，数据仍在）。
