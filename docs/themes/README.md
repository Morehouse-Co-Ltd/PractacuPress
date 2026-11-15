# 主题开发文档

这套文档面向两类人：**装主题的站长**和**写主题的开发者**。写主题的模型只有一句话：

> **主题 = 组件 + 页面基地 + 用 JSON 把组件拼成页面的编排数据。**
>
> 组件用前端语言写（React / HTML / CSS / JS 都可以），页面基地负责页头、页脚与整页骨架，
> 页面本体不是写死的 HTML，而是一份 **JSON 编排**；页面编排器读同一份 JSON，所以
> 主题装进来以后仍然可以继续拖拽、改文案、调布局。需要自己的接口时，主题可以再带一个
> 用 Go 写的 WASM 后端；后台左侧 tab 可以自己写页面，也可以交一份数据文件让服务端生成。

这与旧文档（主题只有 13 个配色令牌）已经是两代东西。旧版把主题限制成「配色 + 版式」，
新版允许主题携带真正的前端组件与页面数据；凡与旧设计稿冲突的地方以本文档为准，
冲突点集中列在[文档与代码的冲突](#conflicts)。

<a id="docs"></a>

## 文档索引

| 文档 | 回答的问题 | 读者 |
| --- | --- | --- |
| [01 安装与设置](./01-setup.md) | 后台从哪进、怎么创建 / 导入 / 导出主题包、套用后动了什么 | 站长、运营 |
| [02 编写主题](./02-authoring.md) | 组件怎么写、页面基地是什么、JSON 怎么拼页面、编排器怎样识别主题组件、后台 tab 与 Go 后端怎么接 | 主题作者、前端开发者 |
| [03 外观与令牌](./03-appearance.md) | 13 个配色令牌、排版与版式变量、哪些外观能改、边界在哪 | 设计师、主题作者 |
| [04 主题包格式](./04-package.md) | zip 里到底有哪些文件、`theme.json` 每个字段、导入导出流程、校验与安全边界 | 主题作者、运维 |
| [05 后台侧栏与后端](./05-admin-and-backend.md) | 后台左侧 tab 的两种定制方式、数据文件协议、Go/WASM 后端怎么构建与调用 | 全栈开发者 |
| [06 主题自带预览](./06-preview.md) | 主题怎么写主题库封面与详情里的迷你页面、「预览主题」弹窗里的真实前台、字段、限制与安全边界 | 主题作者、设计师 |

外部参考：

- [扩展开发手册](../extensions/README.md)：前端扩展（T1）与后端扩展（T2）的完整 ABI、权限与安装
- [扩展包安装与打包](../extensions/06-install-and-package.md)：`plugin.json` 字段、zip 打包、`/api/v1/plugins/{id}/...`
- [前端说明](../../apps/web/README.md)：路由、组件与构建方式
- [主题市场接入约定](../superpowers/specs/2026-10-25-theme-marketplace-integration.md)：市场接口的预留字段

<a id="model"></a>

## 一分钟速查

- **主题包是一个 zip**，不是一份 JSON：`theme.json` + `components/` + `pages/` + 可选 `admin/`、`backend/`、`README.md`。
- **组件是前端扩展**：一个经典脚本，调用 `ctx.blocks.register(type, renderer, meta)` 注册区块类型；样式用 `ctx.ui.addStyle(css)` 注入。
- **页面是 JSON**：`pages/*.json` 里是一棵 `BlockInstance` 树，和页面编排器保存的 `home` / `article` / `pages` 完全同构。
- **预览分两层**：卡片、详情与导入确认是 `theme.json` 的 `preview` 画出的迷你页；「预览主题」弹窗用同源 iframe 渲染真实前台（首页 / 文章列表），关闭即还原。
- **预览是主题自己写的**：`theme.json` 的 `preview` 决定主题库卡片与详情面板里的迷你页面；不写就按版式画通用结构图（见 [06](./06-preview.md)）。
- **编排器能适配**：组件的 `meta` 里声明 `name / description / group / variants / area / defaults / schema`，编排器的「添加组件」、属性面板、默认落位都从这同一份声明来。
- **后台侧栏**：`ctx.admin.registerPage` 注册一个自己写的后台页面；或提供 `admin/tabs.json`，由服务端按数据生成设置页（数据文件协议见 [05](./05-admin-and-backend.md)）。
- **后端**：Go `GOOS=wasip1 GOARCH=wasm` 构建，`plugin.json` 声明 routes，页面通过 `ctx.api.fetch('/api/v1/plugins/{id}/...')` 调用；没有文件、网络与环境变量。
- **套用主题包会写入**：`theme`（配色/排版）、`layout.variant`、`appearance`、`home` / `article` / 自定义页面编排、主题库条目；**不会**删除文章、成员、媒体或导航数据。
- **主题包最多 20 套**自定义主题；单包 zip ≤ 32 MiB、解压 ≤ 64 MiB、文件 ≤ 300 个。
- **安全边界**：组件与后端扩展只允许**平台管理员**安装；主题包本身由站点管理员导入。组件是同源代码，等同站点自己的脚本；后端在 wazero 沙箱里运行。

<a id="layout"></a>

## 主题包里有什么

```text
my-theme.zip
├── theme.json                 # 主题清单：名称、令牌、预览、版式、页面索引、组件与后端引用
├── README.md                  # 主题说明；链接回本套开发文档
├── components/
│   ├── plugin.json            # 前端扩展清单（block 声明 + 权限）
│   ├── client.js              # 组件代码（经典脚本，注册区块类型）
│   └── client.css             # 可选：页面基地样式
├── pages/
│   ├── home.json              # 首页编排
│   ├── article.json           # 文章页附加区块编排
│   └── page-about.json        # 自定义页面「关于」的编排
├── admin/                     # 可选
│   ├── tabs.json              # 数据驱动的后台侧栏页
│   └── pages/*.html           # 或自己写的后台页面
└── backend/                   # 可选
    ├── plugin.json            # 后端扩展清单（runtime: wasm）
    ├── theme.wasm             # Go 构建产物
    └── main.go                # 源码（随包分发，便于审计）
```

各字段的完整定义见 [04 主题包格式](./04-package.md#manifest)。

<a id="conflicts"></a>

## 文档与代码的冲突

旧文档与旧设计稿里有一部分结论已经被这次的主题模型推翻。按代码和本套文档为准：

| 旧说法 | 现在的事实 | 依据 |
| --- | --- | --- |
| 「主题只包含 13 个令牌，不能写 HTML / CSS / JS」 | 主题可以带 `components/` 前端扩展：注册区块、注入样式、注册后台页面；页面基地就是主题自己的 CSS | `lib/plugins/`、`internal/plugins/manifest.go`、本套 02 |
| 「主题不能携带页面编排」 | 主题包可以带 `pages/*.json`，导入时写入站点设计；页面编排器继续编辑同一份数据 | `docs/themes/02-authoring.md#composition` |
| 「导入主题不改 `home`」 | 旧 JSON 主题导入确实不改；**主题包导入**会按 `pages/home.json` 写入首页编排（确认弹窗会说明） | `01-setup.md#import` |
| 「主题文件是 `practacu-theme-*.json`」 | 新导出是 `practacu-theme-*.zip`；旧 `.json` 仍然可以导入（只含令牌与版式） | `04-package.md#export` |
| 「主题市场只接受配色、排版与版式」 | 市场接口尚未接入；接入后将按主题包 v2 校验（含组件与后端） | `04-package.md#market` |
| 「页面编排只能添加内置区块」 | 主题组件注册后会出现在「添加组件 → 主题组件」分组；属性面板读组件声明的 `schema` | `02-authoring.md#builder` |
| 「后台侧栏由程序固定」 | 主题可以注册后台页面（`/admin/ext/{path}`），或用 `admin/tabs.json` 让服务端生成设置页 | `05-admin-and-backend.md` |

<a id="source"></a>

## 源码索引

写文档时逐条核对过的文件，改代码后请同步这里：

| 文件 | 作用 |
| --- | --- |
| `apps/web/src/lib/plugins/types.ts` | 扩展清单、`PluginContext`、区块注册与后台页面注册的类型 |
| `apps/web/src/lib/plugins/registry.ts` | 槽位注册表、区块注册表（含主题组件的元数据） |
| `apps/web/src/lib/plugins/runtime.ts` | 扩展加载、权限检查、`activate(ctx)` |
| `apps/web/src/lib/plugins/adminRegistry.ts` | 后台页面注册表（左侧 tab 的来源） |
| `apps/web/src/lib/blocks.ts` | 内置区块定义、`availableBlocks(variant)`、`blockDef`、`createBlock` |
| `apps/web/src/components/blocks/index.tsx` | `BlockView`：内置与主题组件的统一渲染入口 |
| `apps/web/src/components/builder/BlockTreeEditor.tsx` | 「添加组件」面板与分组 |
| `apps/web/src/pages/admin/ThemeBuilder.tsx` | 页面编排工作台 |
| `apps/web/src/pages/admin/ChooseTheme.tsx` | 选择主题：创建、导入主题包、导出主题包、删除、卡片操作 |
| `apps/web/src/pages/admin/Themes.tsx` | 主题设置：微调、令牌、外观分区、导航与页脚 |
| `apps/web/src/lib/theme.ts` | 令牌、`resolveTokens`、`themeCss` |
| `apps/web/src/lib/themePreview.ts` | 主题自带预览的归一化、兜底与配色解析 |
| `apps/web/src/components/theme/ThemePreview.tsx` | 主题预览迷你页面渲染器 |
| `apps/web/src/lib/themePreviewLive.ts` | 真实前台预览的会话交接与文档级认领 |
| `apps/web/src/components/theme/ThemeLivePreview.tsx` | 真实前台预览的 iframe、页面 / 宽度切换与加载态 |
| `apps/web/src/lib/themes.ts` | 内置主题、主题库、`parseThemeFile` / `downloadThemeFile`（旧 JSON） |
| `apps/web/src/lib/themePackage.ts` | 主题包 zip 的读取、校验、组装与导出 |
| `apps/web/src/lib/customize.ts` | 站点设计文档结构、`readCustomization`、页面编排归一化 |
| `apps/api/internal/plugins/manifest.go` | `plugin.json` 校验、区块声明（`BlockSpec`） |
| `apps/api/internal/plugins/host.go` | 扩展宿主：公开清单、WASM 路由、内容钩子 |
| `apps/api/internal/extensions/` | 扩展包安装、启用、删除 |
| `apps/api/internal/themes/` | 主题包安装、导出、删除（站点级） |
| `packages/contracts/openapi/` | 主题与扩展接口的契约 |

<a id="links"></a>

## 主题包里的 README 该写什么

导出的主题包会自带一份 `README.md`，它必须能让拿到 zip 的人找到本套文档。模板：

```markdown
# <主题名>

<一句话说明>

## 安装
1. 平台管理员：在「扩展」页导入 `components/` 与 `backend/`（如果有）。
2. 站点管理员：在「选择主题 → 导入主题」选择本 zip。

## 开发文档
- 主题开发文档：<站点地址>/docs/themes/README.md（仓库内：docs/themes/README.md）
- 主题包格式：<站点地址>/docs/themes/04-package.md
- 主题自带预览：<站点地址>/docs/themes/06-preview.md
- 扩展与后端 ABI：<站点地址>/docs/extensions/README.md

## 版本
- 主题包版本：2
- 适用 Practacu Press：>=0.1.0
```

站点没有在线的 `/docs/themes/` 路由时，把链接写成仓库相对路径（`docs/themes/...`），
并在主题市场页面提供同一组链接。
