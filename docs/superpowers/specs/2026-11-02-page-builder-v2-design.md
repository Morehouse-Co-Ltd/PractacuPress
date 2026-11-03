# 页面编排 v2 · 设计规格（Schema 地基 / 栅格布局 / 组件扩容 / 数据与交互）

日期：2026-11-02
状态：P0 已确认，P1–P3 待逐期细化
范围：`apps/web` 的页面编排器、区块注册表、归一化与渲染；另涉及 `apps/api` 的传输层与列表端点扩展。
前置：`2026-10-24-page-builder-redesign-design.md`、`2026-11-01-page-customization-blocks-design.md`。

## 0. 决策原则

这份规格里所有取舍按一条线判：

- **为性能与可用性的，改。** 不因为"以前是这样"而保留会拖慢首屏、会让用户踩坑的设计；
  存量配置的兼容靠迁移器兜住，不靠维持旧语义。
- **为用户的，做。** 用户看不见的内部洁癖可以让步，用户摸得到的确定性与反馈不能省。

据此本轮已定死的几条（原先挂在"开放问题"里）：删除根级 24 条上限、拒绝静默截断、
媒体选择器必须能选到 content 图片（改后端判定）、给设计文档加 ETag 与 API 端 gzip、
`width` 一次性折算成栅格 span。

## 1. 背景与目标

页面编排已经是这套 CMS 的第二大卖点（`docs/introduction.md:17,43,79`）：34 个区块、递归容器、
桌面 / 平板 / 手机三端、每个区块六项通用外观、思维链（无代码逻辑）、沙箱扩展。

但 34 个区块里真正"结构化"的很少，而且三端布局是**整棵树复制三份**。想继续往上走，
四个结构性卡点必须先拆：

1. `BlockInstance.props` 只允许标量（`types.ts:799-824`），复杂数据只能塞进 itemlist 的 JSON 字符串
   （每条值截 200 字、最多 30 条，`blocks.ts:1073-1092`）——定价表、FAQ、团队卡这类组件做不精致；
2. 分设备 = `cloneBlocks` 深拷贝三棵树（`ThemeBuilder.tsx:123-152`），改一处三端不同步，
   切设备还会重置撤销栈；
3. 布局只有 `columns`（等宽 2–4 栏）与 `container`（纵向堆叠），`width` 是固定 px
   （`index.tsx:82-89`）——没有栅格 span/offset、没有间距标尺、没有分节；
4. 数据源写死在组件里（`feature-post` 永远取 `all[0]`），而 `/articles` 只有
   `limit / cursor / author_id` 三个参数（`openapi.yaml` `/articles`）——做不出真正的筛选区块。

本轮把这些地基换掉，然后在上面铺组件与数据能力。

## 2. 非目标

- 不做任意绝对定位的自由画布（沿用 `2026-11-01-page-customization-blocks-design.md:23` 的结论）；
- 不引入任何 npm 运行时依赖（前端仍只有 react / react-dom / react-router-dom）；
- 不做 A/B 实验、设计发布态、协作编辑、区块市场（后端无实验表、无设计发布概念，
  分析侧也没有变体维度）；
- 不做区块文案的多语言（服务端无站点语言字段，区块文案是单语；见 §10 第 2 条）；
- 不做服务端渲染或按页拆分的契约改造（1 MiB 单文档全量下发的问题本轮只做"减体积"，
  不做"改传输模型"）；
- 不合并既有的 7 个内容型区块（`feature-post` / `post-list` / `post-grid` / `spotlight` /
  `spotlight-hot` / `popular-content` / `recent-content`）——它们继续按原样渲染，
  新能力由新块承担，旧配置零迁移。

## 3. 需要提前处理的三个后端事实

这三条不是"以后再说"，它们直接决定 P2/P3 能不能落地。

### 3.1 媒体匿名读不覆盖站点设计

区块只存 URL 字符串（`blocks.ts:606-676`）。匿名读 `GET /media/{id}` 时，
`purpose=content` 的资产只有在**某个已发布 content item 的正文里出现过该 asset id**
才放行（`apps/api/internal/infrastructure/contentstore/store.go:346-368`，纯子串匹配）。
结论：**页面编排里用的 content 图片，访客会拿到 404**。

现在图片块只能手填 URL，恰好绕过了这个问题；P2 一上媒体选择器就立刻暴露。

修法（P0 一并做）：在 `apps/api/internal/media/service.go:321-338` 的匿名读判定里增加一条分支——
命中 `content` 资产且正文里查不到时，再对 `site_customization.document` 做同样的子串匹配。
文档仍是不透明字节，不需要解析结构，与现有实现风格一致。文档 ≤1 MiB，命中率低，
只在"正文没命中"时才扫，且结果按资产 id 做短 TTL 记忆化。

### 3.2 内容列表没有筛选参数

`/articles`、`/posts` 只有 `Limit` / `Cursor` / `AuthorID`。P3 的查询块若靠前端过滤，
只能在"取回来的那一页"里筛，结果不准且不解释。真做要给两个列表端点加
`tag` / `category_id` / `since` / `sort` 参数，并同步 `packages/contracts/openapi/openapi.yaml`
（`apps/api/internal/transport/http/gin/openapi_contract_test.go:1-6` 是硬闸门，路由与 YAML 双向必须一致）。

### 3.3 整份设计每次进站全量下发

`GET /sites/{siteID}/customization` 返回整棵树（含全部页面、全部页面草稿）；
API 无 ETag / 无 gzip（压缩只在 Nginx）、1 MiB 硬上限（`site/customization.go:19`）。
同时 `covers` 允许单条 1,200,000 字符的 data URL（`customize.ts:159-161,173-204`）——
两头已经在打架。

结论：**组件越加越多 = 首屏越来越慢**。所以 P0 必须同时把体积预算定下来（§4.5），
P2 的每个新组件都要计入预算。

## 4. P0：Schema 地基

### 4.1 数据模型（全增量）

```ts
// apps/web/src/types.ts —— 只新增，不改既有字段语义
export interface BlockInstance {
  // …既有：id / type / title / props / animation / hidden / area / children /
  //        column / width / height / custom_css / appearance
  /** 只覆盖展示层，不覆盖 props。缺省表示沿用 base。 */
  at?: { tablet?: BlockDisplayOverride; mobile?: BlockDisplayOverride };
  /** 内置条件显示；渲染期求值，不写 DOM 类、刷新后仍然生效。 */
  visible?: BlockVisibility;
  /** 目录 / 跳转锚点（P1）。 */
  anchor?: string;
  /** 栅格占位（P1）；width 保留兼容，同时存在时 span 优先。 */
  span?: BlockSpan;
  /** 栅格起始列偏移（P1）；缺省为 0。 */
  offset?: BlockOffset;
  /** 归一化时无法识别的类型：保留原样、不渲染、保存时写回。 */
  unsupported?: boolean;
}

export type BlockDisplayOverride = Pick<
  BlockInstance,
  'span' | 'appearance' | 'animation' | 'hidden' | 'custom_css' | 'width' | 'height'
> & {
  align?: 'left' | 'center' | 'right';
  gap_scale?: number;
  mt?: number;
  mb?: number;
};

export interface BlockSpan {
  base: number;   // 1–12
  md?: number;    // ≥768
  sm?: number;    // ≥480
}

/** 栅格子区块的起始列偏移，形状与 BlockSpan 相同。 */
export type BlockOffset = BlockSpan;

export interface BlockVisibility {
  devices?: BuilderDevice[];
  roles?: ('guest' | 'member' | 'admin')[];
  /** ISO 日期；含首尾。 */
  from?: string;
  to?: string;
}
```

**关键决定：响应式只覆盖展示层，绝不覆盖 `props`。**
内容只有一份来源，才不会重演"三棵树各改各的"。需要"手机换一张图"这类需求时，
应新增独立的移动端区块并配合 `visible.devices`，而不是让同一块有两份内容。

### 4.2 PropSchema v2

`PropType` 的目标形态是 14 种（`blocks.ts:22`）。**P0 只落地了 `repeater` 与 `media` 两种**
——其余五种没有 P0 消费者，造出来就是没人用的表单分支；它们随 P2 的具体组件一起进场：

| 新类型 | 用途 | 存储形态 | 落地 |
| --- | --- | --- | --- |
| `media` | 媒体库选择器 | `"/api/v1/media/{id}"`、白名单 URL，或 ≤64 KB 的 `data:image/…;base64,`（演示模式） | **P0 ✅** |
| `repeater` | 结构化列表（取代 itemlist） | `Array<Record<string, Scalar>>`，子字段由 `itemSchema` 声明 | **P0 ✅** |
| `richtext` | 段落级富文本 | Markdown 字符串（沿用 `text` 区块的渲染路径） | P2 |
| `page` | 页面引用 | `SitePage.id` | P2 |
| `taxonomy` | 分类 / 标签引用 | `term.id` + `kind` | P2 |
| `icon` | 内置图标名 | 见 `navigation.ts` 的 `NAV_ICON_CHOICES` | P2 |
| `token-color` | 主题令牌色 | 令牌名，渲染时解析成 `var(--…)` | P2 |

`props` 允许对象与数组，但**归一化按 schema 递归白名单清洗**：schema 没声明的键一律丢弃，
不再是整包透传。`itemlist` 保留读取兼容（旧 JSON 字符串会被解析成 `repeater` 的条目数组），
编辑器不再提供它作为新选项。

**白名单会误伤 `bind:` 键**：`props['bind:title']` 这类数据绑定键不在任何 schema 里，
纯白名单会在第一次保存时把它们清掉。归一化因此显式保留 `bind:` 前缀键（挡
`__proto__`/`constructor`/`prototype`，键 ≤120、值 ≤80），并有回归测试钉住。

`repeater` 的子 schema 复用 `PropSchema`，并带 `minItems` / `maxItems` / `itemLabel`；
缺省字段按类型补齐（文本/选择补 `''`、开关补 `false`），以保证"读一次再写一次"字节不变。

**一个永久的护栏**：`repeaterProps.test.ts` 里有一条结构性断言——
**每个区块的 `defaults` 键都必须声明在它的 `schema` 里**，且默认 props 经归一化后原样保留。
这条断言在落地时当场抓到 5 个区块的漂移（4 个键序、1 个空数组被吞成 `undefined`），
以后再加组件，忘了写 schema 就会红。

### 4.3 三个必须一起修的坑

1. **未知区块类型静默丢弃**：`normalizeBlock` 对未知 `type` 返回 `null`（`customize.ts:557`），
   hydration 把归一化结果写回 localStorage（`customizationSync.ts:179-189`），下次保存 PUT 回去
   → 从更新版本导入的区块**永久消失且无提示**。
   修法：未知类型保留在树里并标 `unsupported: true`；编辑器显示"来自更新版本，本版本无法渲染"
   占位；保存时原样写回。导入时若存在 `unsupported` 块，提示"有 N 个区块本版本不认识，已保留"。
2. **上限三套且静默截断**：编辑器按 200 检查（`BlockTreeEditor.tsx:191,490`）、归一化根级砍 24
   （`customize.ts:611`）、子级砍 80（`customize.ts:578`）、深度 8（`blockTree.ts:10`）。
   **已定**：常量收敛到 `blockTree.ts` 一处（`MAX_BLOCKS = 200`、`MAX_BLOCK_DEPTH = 8`、
   `MAX_CHILDREN_PER_CONTAINER = 80`），**删除根级 24 条上限**——它当初只是归一化的实现细节，
   却让用户"加到第 25 块就凭空消失"，纯属可用性事故。
   **实现后的口径**：读路径的裁剪阈值改为 `MAX_READ_BLOCKS = 2000`，它只是防恶意文档把
   浏览器撑爆的上限，**不再是产品上限**；产品上限 200 由编辑器在保存前拦截并提示
   （当前多少、上限多少）。这样"超限"永远是一条明确的提示，而不是一次静默截断。
   子容器 80 与深度 8 仍只在读路径收敛，属于结构性安全阀，暂未做提示——P1 补。
3. **向下拖拽差一格**（审计 W-4，`docs/audit/2026-10-31-audit-report.md:209`）：
   `moveBlock` 在同一父级且原下标小于目标下标时没有补偿（`blockTree.ts:132-144`）。
   修法：同父级 `found.index < target.index` 时 `index -= 1`；补单测覆盖
   `[A,B,C]` → A 拖到 B 之后 = `[B,A,C]`。
   连带修：树面板的「↓ 下移」按钮原本按旧约定传下标，改完会变成空操作，因此新增纯函数
   `stepTarget(location, direction)` 作为"上下移动一格"的唯一翻译层。

### 4.4 迁移

`schema_version = 2` 写在 `SiteCustomization` 顶层（首次出现版本号字段；导出封皮的 `version: 1`
仍只描述文件格式，两者不混用）。

**P0 的迁移只做一件半的事**：盖版本号，并把 `home` / `article` / `pages[].layout` 原样保留。

原计划是"读到无版本号就把三端三棵树折算成一份 base + `at` 覆盖"，这条在实现后被推翻——
`at` 的求值要到 P1 才接进渲染层，先折算会**删掉设备树却没人读 `at`**，等于把所有
分设备布局悄悄退回桌面版。折算逻辑因此保留为导出函数 `foldDeviceLayouts(layout, label, report)`，
由 P1 在渲染层真正求值 `at` 之后调用；它自带结构相同判定、深度上限、结构不同则保留并写报告。

- 迁移是幂等的纯函数，坏数据不抛异常、回退到"原样读取 + 不强写"；
- 旧配置不迁移也能渲染：`readCustomization` 的归一化对 v1 结构保持现有行为；
- 迁移报告 `report` 目前被 `readCustomization` 丢弃——P1 配合迁移确认弹窗再呈现。

### 4.5 体积预算

| 项 | 上限 | 落点 | P0 状态 |
| --- | --- | --- | --- |
| 单键 `props` | 8 KB | 归一化时超限键丢弃 | ✅ 已落地，但**逐键判断**：一个多键区块的整块体积仍可能超 8 KB |
| 整份设计 | 512 KB 软警告 / 1 MiB 硬上限 | `designVolumeReport` 已算，**尚未接到界面** | ⚠️ 只算不报 |
| 区块内 data URL | 仅允许 ≤64 KB 的 `data:image/…;base64,`（演示模式） | `normalizeMediaUrl` | ✅ |
| `covers[].url` 的 data URL | 64 KB（原 1.2 MB） | `customize.ts` 归一化 | ✅ |

1 MiB 目前只有服务端 422 兜底，而 `customizationSync` 一旦收到 403/400/422 会**永久停掉
自动保存**——所以 P1 必须在客户端做保存前预检，否则用户会撞到一个"保存突然不再工作"的状态。

### 4.6 传输层：让首屏真的变快

减体积只是一半，另一半是把每次进站的全量下发变成条件请求。三处改动都在 `apps/api`，
都不新增依赖：

1. **`GET /sites/{siteID}/customization` 加 `ETag` + `If-None-Match` → 304**。
   ETag 取 `document` 的 SHA-256 前 16 字节 + `revision`（`site/handler.go:527-532`）。
   用户改完设计改的是同一份文档，ETag 跟着变；访客二次进站直接 304，省掉整棵树。
   同时补 `Cache-Control: no-cache`（可缓存但必须回源校验），与既有 Nginx 配置兼容。
2. **API 进程加 gzip 中间件**（`compress/gzip` 标准库，约 60 行）。
   现在只有 Docker 部署的 Nginx 压，桌面形态（`PractacuPress.exe` 直连）与
   `docker compose` 之外的部署完全没有压缩——同一份 300 KB 的设计文档在这两种形态下
   是全量明文传输。
3. **媒体下载按用途给缓存策略**（`media/handler.go:182-186`）。
   现在一律 `Cache-Control: private, max-age=300`，连站点 Logo 都不许 CDN 缓存。
   改为：`site` / `avatar` 用途 → `public, max-age=31536000, immutable`；
   `content` / `attachment` 维持 `private`（内容可能被撤下，不能长缓存）。

这三条与 §3.3 的关系：本轮不改传输模型（不按页拆分），但把"同一份文档重复传输"
和"明文传输"这两个最贵的成本先砍掉。

## 5. P1：栅格、间距、覆盖式响应式

### 5.1 布局原语

- `grid`：新增区块，`props.columns` 1–12（默认 12）、`props.gap` 走间距标尺；
  子区块用 `BlockInstance.span`（`base`/`md`/`sm`）与 `offset` 定位，`order` 可选。
  渲染为 CSS Grid，断点用容器查询（`container-type: inline-size`）而不是媒体查询——
  预览 iframe 改宽度时也能正确重排。
- `section`：新增区块，`props.max_width`（narrow 640 / normal 860 / wide 1200 / full）、
  `props.padding_y`（间距标尺）、`props.background`（hex 或主题令牌）、`props.divider`。
- `columns` / `container` 保留：继续按原样渲染，编辑器里标记为"经典容器"，
  P1 之后新拖入的走 `grid` / `section`。
- **`width: px` 一次性折算**：没有 `span` 但有 `width` 的区块，按
  `ceil(width / 容器宽 × 12)` 折算成 span 并**当场写回 `span`、清掉 `width`**；
  首次打开这类设计时弹一次性提示说明"原来的像素宽已折算为栅格列"。
  不保留两套宽度语义并存——那是永久的解释成本。

### 5.2 间距标尺

新增 `SPACING_SCALE = [0,4,8,12,16,24,32,48,64,96]`。**只有新字段走标尺**：
`BlockDisplayOverride.mt/mb`、`grid` 的 `gap`、`section` 的 `padding_y` 存的都是档位下标。

既有的 `appearance.padding` 继续按 px 解释、语义不变（否则等于静默改写老配置），
面板里额外提供同样的档位按钮，点一下填对应的 px 值。
`appearance.padding` 的上限从 64 放宽到 96，与标尺最大值对齐。

### 5.3 响应式覆盖

- `BlockInstance.at.tablet/mobile` 存差异；
- 编辑器切设备时，面板里每条属性显示"继承 / 已覆盖"状态，并提供"恢复继承"；
- `device_split` 保留读取（v1 配置），P1 之后编辑器不再生成它，标记为待弃用；
- 断点统一到一处：`SM = 480`、`MD = 768`、`LG = 1024`。
  顺带修掉思维链 `is_mobile` 用 768、`builderDeviceForWidth` 用 640 的不一致。

### 5.4 内置可见性

`visible` 在 `ScreenRenderer` 的过滤链里求值（`index.tsx:144` 现有 `.filter(!hidden)` 处），
判定顺序：设备 → 角色 → 时间窗。

**明确写进文档：这是排版工具，不是访问控制**——站点设计文档对所有访客是同一份公开 JSON
（草稿页的区块也在里面，服务端不认 `SitePage.status`），用 `visible` 藏内容不构成安全边界。
角色判定沿用前端既有的权限来源（`lib/permissions.ts`），与审计 W-3 指出的
"能力矩阵完全在前端本地"是同一层可信度，不额外承诺服务端强制。

## 6. P2：组件扩容

依赖 P0 的 `repeater` / `media` / `richtext`。优先选**零 JS 或极少 JS** 的实现，
继续不引第三方库：折叠用 `<details>`、灯箱用 `<dialog>`、Tabs 用 `aria-controls` 手写。

| 组件 | type | 依赖 | 说明 |
| --- | --- | --- | --- |
| 定价表 | `pricing` | repeater(features) | 2–4 档，推荐档高亮 |
| FAQ 折叠 | `faq` | repeater(q/a) | 原生 `<details>`，可配默认展开 |
| 功能网格 | `feature-grid` | repeater(icon/title/text) | 2–4 列 |
| 团队 / 成员卡 | `team` | repeater(avatar/name/role/links) + media | 圆形头像走 appearance.radius |
| Logo 墙 | `logo-wall` | repeater(image/link) + media | 灰度 hover 恢复 |
| 证言 | `testimonial` | repeater(quote/name/avatar) | 可轮播（CSS scroll-snap，零 JS） |
| 步骤 / 流程 | `steps` | repeater(title/text) | 纵向或横向 |
| 对比表 | `comparison` | repeater(row) | 需要二维表专用子 schema |
| 图集 | `gallery` | repeater(image/caption) + media | 栅格 + `<dialog>` 灯箱 |
| 图文交替 | `media-text` | media + richtext | 左右交替，`props.side` |
| 倒计时 | `countdown` | 日期 props | 客户端时钟，`useEffect` 起定时器，卸载即清 |
| 卡片组 | `card-grid` | repeater(card) | 通用三件套，比 feature-grid 更自由 |
| 目录 / 锚点 | `anchor-nav` | P1 的 `anchor` | 读同页区块锚点，滚动高亮 |
| 音频 | `audio` | media | 原生 `<audio>`，不自动播放 |

估算体积：14 个组件静态 import，raw 约 +50 KB、gzip 约 +15 KB。预算见 §7。

## 7. P3：数据与交互

### 7.1 统一查询块

新增 `content-query`：

```ts
{
  source: 'latest' | 'popular' | 'pinned' | 'tag' | 'category' | 'author';
  term_id?: string;        // taxonomy 区块选择器
  window?: '7d' | '30d' | 'all';
  sort?: 'newest' | 'oldest' | 'popular';
  layout: 'list' | 'grid' | 'mosaic';
  limit: number;
  show_excerpt: boolean;
  show_meta: boolean;
}
```

渲染复用 `FeedContext` 的取数路径；`source` 需要服务端筛选时走 §3.2 新增的查询参数。
服务端不支持筛选时，编辑器里禁用 `tag` / `category` / `window` 并以提示说明，
**不做"前端假装筛选"**。

### 7.2 交互

- `anchor` + `anchor-nav` 构成目录；
- 动作复用思维链既有的 action 集（`scroll_to_block` / `open_search` / `switch_mode`），
  不新造一套；
- 思维链的 `hide_block` 刷新即失效（`logic.ts:104`）由 `visible` 取代，思维链保留原语义。

### 7.3 表单（P3 最后一个里程碑）

订阅 / 联系表单需要新端点、反滥用（站点已有 CAPTCHA 配置）、通知投递。
按 §0 原则**做**，但排在 P3 末尾，先保证外链 / `mailto:` 降级可用。

## 8. 安全

- 新区块与新 prop 类型一律走 schema 白名单；`media` 只接受 `/api/v1/media/{id}`、
  `http(s)://` 或 `/` 开头的站内路径，`data:` 一律拒绝；
- `richtext` 沿用现有 Markdown → `sanitizeHtml` 链路，不新增 HTML 注入点；
- 折叠 / 灯箱 / Tabs 全部用原生元素 + ARIA，不引入 `execCommand`；
- `visible` 明确非安全边界（§5.4）；
- P3 表单若落地，必须走 CSRF、限流与 CAPTCHA，且不把提交内容拼进 HTML。

## 9. 测试与验收

| 层 | 内容 |
| --- | --- |
| 单测 | `normalizeBlock` 的 schema 白名单递归清洗；`migrateV1ToV2` 幂等与坏数据回退；上限常量行为；`moveBlock` 同父级下移；体积预算；`visible` 求值 |
| 渲染 | 每个新组件的最小组件测试（含深色主题与减少动效） |
| i18n | 新增界面文案全部 `t()` + 英文；`lib/i18n/coverage.test.ts` 是硬闸门 |
| 契约 | 后端改动必须过 `openapi_contract_test.go`（路由与 YAML 双向一致） |
| 浏览器 | 扩展 `apps/web/scripts/e2e-builder-blocks.mjs`：加网格块 → 拖 span → 切手机改覆盖 → 刷新保持 → 截图 |
| 迁移 | 用真实 v1 配置（仓库内 `demoSeed.ts` 的种子）跑一遍迁移，断言渲染结果与原版一致 |

## 10. 已定的取舍

原先挂在这里的五个问题按 §0 的原则全部定死：

1. **表单：做。** P3 最后一个里程碑，新增订阅 / 联系端点，走站点既有的 CAPTCHA 配置 + 限流 +
   CSRF；提交内容只按纯文本存，不进 HTML。降级路径（外链 / `mailto:`）同时保留，
   没配 SMTP 的站点不至于点了没反应。
2. **区块文案双语：本轮不做。** 服务端没有站点语言字段，硬做只能做成"两份页面"，
   是对用户的假承诺。作为独立议题另开规格。
3. **`device_split` 迁移：照 §4.4 折算，并给迁移报告。** 差异越大越要明说——
   P1 首次打开时弹一次对比（哪些区块在手机/平板被单独改过、已折算成覆盖），
   用户确认后再写回。不做"默默改掉"。
4. **`width: px`：一次性折算成 span 并写回**（§5.1），不保留两套宽度语义。
5. **1 MiB 的长期出路**：本轮做 §4.6 的传输层优化（304 + gzip + 媒体缓存），
   不动"单文档全量"的模型；按页拆分是独立议题。

## 11. 分期与验收口径

- **P0**：schema v2 + 迁移 + 三个坑 + 体积预算 + 媒体匿名读 + 传输层（ETag/gzip/媒体缓存）。
  验收：v1 配置渲染不变、新增 schema 类型可用、导入不再丢块、拖拽落点正确、
  二次进站设计文档命中 304。
- **P1**：`grid` / `section` / 间距标尺 / `at` 覆盖 / `visible` / 断点统一。
  验收：同一份布局在手机只改一处不影响桌面；切设备不再重置撤销栈。
- **P2**：14 个组件。验收：每个组件在深色/浅色/移动端可用、可访问性达标、
  bundle 增量在预算内。
- **P3**：`content-query` + 锚点目录 + 后端查询参数。验收：标签/分类筛选结果与
  服务端一致，不是前端过滤。

## 12. P0 实现记录（2026-11-03）

分支 `feat/page-builder-v2-p0`，9 个任务逐个走「实现 → 独立评审 → 修 Critical/Important → 复审」。

| 检查 | 结果 |
| --- | --- |
| `npx vitest run`（apps/web） | 52 文件 / 571 测试通过（基线 497） |
| `npm run typecheck` | 0 错误 |
| `npm run build` | 成功，dist +16.6 KB（预算 40 KB） |
| `go build ./apps/api/...` | 0 错误 |
| `go test ./apps/api/...` | 全部包通过，含五个契约测试（`TestEveryRegisteredRouteIsDocumented` 等） |
| `node scripts/e2e-builder-blocks.mjs` | PASS 37 / FAIL 0，截图在 `apps/web/.tmp/shots-builder/` |
| i18n 覆盖率闸门 | 96.2%，绿 |

**评审真正拦下的问题**（都已修，并留了回归测试）：

1. 拖拽补偿修复会让树面板「↓ 下移」变成空操作 → 新增 `stepTarget` 纯函数 + 3 个用例。
2. schema 白名单会清掉 `bind:` 数据绑定键 → 显式保留 + 回归测试。
3. 空 `repeater` 数组被归一化吞成 `undefined` → 由"defaults 必须存活"的永久护栏抓到。
4. `readCustomization` 丢掉 `schema_version` → 每次读都重跑迁移 → 已落盘。
5. 媒体白名单放行协议相对地址 `//evil.com`；演示模式的内联图被一律拒绝 → 收紧 + 放行 ≤64 KB。
6. gzip 计划的示例代码有两处真 bug（`WriteString` 未接管、缓冲导致 `Written()` 为假会写出第二个响应）→ 实现时修掉。
7. **终审发现问题**：迁移会把三端树折算后删除，而 `at` 要到 P1 才求值 → 折算推迟到 P1；
   读路径的 200 条静默截断改为 2000 条 DoS 阀 + 保存前拦截。

**已知遗留（P1 承接）**：
- `at` / `visible` / `anchor` / `span` / `offset` 只建模并保留，**渲染层一处都还没求值**；
- 迁移报告与导入告警没有 UI；`designVolumeReport` 没有接到界面；
- 1 MiB 硬上限没有客户端预检（撞上会永久停自动保存）；
- `richtext` / `page` / `taxonomy` / `icon` / `token-color` 五种 schema 类型随 P2 组件进场；
- 渲染层仍把 `src` 过 `safeUrl`，而它拒绝 `data:` —— 演示模式选了内联图会存得下、画不出；
- 演示模式的封面提示写"600 KB"，实际受 64 KB 内联上限约束，文案需要改。

**一个作业环境上的事实（与代码无关）**：本分支的多个提交里混入了同一工作树上其他会话
未提交的改动（markdown 编辑器、slash 菜单、注册开关、域名验证等），因此单个提交不能独立
构建或回滚；整棵工作树是自洽的。后续分支建议改用独立 worktree。

## 13. P1 实现记录（2026-11-03）

7 个任务 + 3 轮修复，14 个提交。

| 检查 | 结果 |
| --- | --- |
| `npx vitest run`（apps/web） | 59 文件 / **671 测试通过**（P0 收尾时 571） |
| `npm run typecheck` / `npm run build` | 0 错误 / 构建成功 |
| `go build` / `go test ./apps/api/...` | 通过（本阶段未动后端） |
| i18n 覆盖率闸门 | 绿 |

**交付**：断点统一为 480/768/1024（编排器与逻辑链共用同一张表）；间距标尺 `SPACING_SCALE`；
`at` 在渲染层真正求值；`visible` 内置条件显示（设备/角色/时间窗）；`grid`（12 栏 + span/offset +
容器查询三档）；`section`（宽度档 + 留白 + 底色 + 分隔线）；像素宽在栅格内一次性折算成 span；
v1 三端编排自动折算成 `at`；检查器的「已覆盖 / 恢复继承」与「栅格占位」控件。

**阶段评审判定"不能按已交付上报"，四条 must-fix 已全部修掉**：

1. `columns` 子树绕过条件显示（角色/时间窗在分栏里失效）→ 分栏子区块现在走同一条过滤链。
2. 像素宽折算在栅格外等于纯丢宽（v1 站点读一次就变满宽）→ 只在 `grid` 直接子块上折算。
3. §5.3 的 `device_split` 弃用没做 → 编辑器不再生成三棵树；v2 文档里残留的 `device_split`
   在读取时同样折算。
4. `span`/`offset` 没有编辑入口（栅格对作者等于纵向堆叠）→ 检查器新增「栅格占位」。
   修复时又发现分设备 `offset` 被归一化白名单丢掉（刷新即失），一并补上。

**阶段评审提出的三条遗留，已在收尾轮全部收掉**：

- **栅格档位与覆盖档位的判据不一致** → 统一为**视口宽**：栅格从容器查询换成媒体查询
  （768 / 1024，取自同一张断点表），与 `at` 覆盖同一判据。理由：预览 iframe 本身就是视口，
  容器查询没换来任何好处，却造出第二套"设备"定义。代价：放进窄容器的 grid 不再自动降档，
  要更窄的排版请用 `at` 覆盖——这条已写进 CSS 注释与文档。
- **折算白名单漏字段** → `DISPLAY_KEYS` 补齐 `BlockDisplayOverride` 的全部 12 个键，
  `CONTENT_KEYS` 补上 `visible` / `anchor` / `unsupported` 等 `at` 无法承载的字段；
  并加了一个**编译期守卫**（`Exclude<keyof BlockDisplayOverride, 已有键>` 必须是 `never`），
  以后往覆盖层加字段却忘了同步白名单，`tsc` 直接报错。
  `children` 故意不入 `CONTENT_KEYS`——递归已经逐块比较，整棵子树 JSON 比较会把嵌套的
  展示差异也算成内容差异，反而挡住安全的折算。
- **迁移报告无处呈现** → 新增 `lib/migrationNotice.ts` + 页面编排页的一次性弹窗
  「版面已自动升级」：逐条列出这次被折算/保留了什么，同一份报告只提示一次
  （签名存 localStorage，最多记 20 条）。匿名访客路径只入内存队列，不写 localStorage。

**刻意留到 P2**：`anchor` 与 `anchor-nav`、间距标尺的档位按钮、
`richtext` / `page` / `taxonomy` / `icon` / `token-color` 五种 schema 类型。
