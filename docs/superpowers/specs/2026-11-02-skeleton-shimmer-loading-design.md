# 加载设置：SKELETON / SHIMMER 原位骨架加载（设计）

日期：2026-11-02
状态：已确认（设计方向 B —— 页面内原位骨架，去掉全屏遮罩）

## 背景

后台「主题设置 → 加载动画」目前只有一个全屏遮罩：`LoadingLayer` 在首次加载与站内导航时
盖住整页，显示一个居中图形 + 文案（`spinner / dots / pulse / bar / orbit`）。内容区另有
一组 `Skeleton` 占位（归档、文章页、搜索、个人主页与部分区块），但被遮罩挡住，用户看到的
是「品牌动画 → 整页内容」的硬切换，位置对不上，观感突兀。

本次在加载设置里加入 **SKELETON / SHIMMER 的配合加载方式**：开启后不再显示全屏遮罩，而是
让页面结构先出现，等待数据的内容区域先显示**与最终版式同位置**的骨架占位，数据到达后原地
替换。页面编排（区块树）与主题切换都要自然适配。

## 目标

1. 加载设置新增 3 个预设：`skeleton`、`shimmer`、`skeleton-shimmer`（页面骨架组）。
2. 选中骨架预设并启用加载时，前台改为「原位骨架」：无全屏遮罩、无最短展示计时。
3. 骨架出现在组件最终出现的位置：
   - 固定页面沿用已有原位骨架分支，统一换成新外观；
   - 页面编排页面按区块树渲染，每个依赖内容数据的区块在自己真实的栏位里画对应形状的骨架；
   - 静态区块（标题、文本、按钮、图片等）正常显示，不骨架化。
4. 三种配合动效：
   - `skeleton`：占位块 + 轻微呼吸（pulse）；
   - `shimmer`：占位块 + 横向扫光（sweep）；
   - `skeleton-shimmer`：呼吸 + 扫光叠加。
5. 骨架颜色使用主题令牌；换主题、深浅色、改编排后自动跟随，不需要额外同步逻辑。
6. 后台、安装向导、页面编排预览 iframe 保持现有行为（不进入骨架模式）。
7. 「减少动效」偏好或性能设置关闭动画时，骨架自动静帧。

## 非目标

- 不改后台与安装向导自己的加载态（`PageLoading` / 后台骨架保持现状）。
- 不做每个区块自定义骨架形状的编辑界面。
- 不新增持久化配置字段（只扩展 `preset` 枚举），旧配置无需迁移。
- 不改现有 5 个全屏预设的视觉与行为。
- 不处理 `useAsync` 的历史数据残留（见 `docs/audit/web-findings.md` BUG-4），留待独立修复。

## 数据模型

`apps/web/src/types.ts`

```ts
export type LoadingPreset =
  | 'spinner' | 'dots' | 'pulse' | 'bar' | 'orbit'
  | 'skeleton' | 'shimmer' | 'skeleton-shimmer';
```

`LoadingSettings` 结构不变。`readLoading` 的白名单来自目录，因此：

- 未知 preset 继续回退 `spinner`；
- 旧配置（没有新预设）不受影响；
- 从骨架预设切回全屏预设时，原有的 `text / size / background / min_duration_ms /
  show_on_first_load / show_on_navigation` 值仍保留。

## 模式推导（`apps/web/src/lib/loading.ts`）

新增纯函数，便于单测：

```ts
export const SKELETON_PRESETS = ['skeleton', 'shimmer', 'skeleton-shimmer'] as const;

/** 关闭 / 全屏遮罩 / 原位骨架 */
export function loadingApproach(settings: LoadingSettings): 'off' | 'overlay' | 'skeleton';

/** 骨架动效：呼吸 / 扫光 / 两者 */
export function skeletonMotion(settings: LoadingSettings): 'pulse' | 'sweep' | 'both';
```

- `enabled === false` → `off`；
- preset 属于骨架组 → `skeleton`（不受「首次/切换」两个显示场景开关限制；
  骨架只在真正等待内容时出现）；
- 否则，`show_on_first_load || show_on_navigation` → `overlay`，否则 `off`。
- 动效映射：`skeleton → pulse`，`shimmer → sweep`，`skeleton-shimmer → both`。

`loadingEnabled()` 保留给全屏遮罩路径使用。

## 加载层（`apps/web/src/components/LoadingLayer.tsx`）

- 用 `loadingApproach()` 取代原来的 `loadingEnabled()` 分支。
- `approach === 'skeleton'` 且不在后台/安装向导/预览 iframe 时：
  - 不渲染全屏遮罩，不启动最短展示计时；
  - 在 `<html>` 上写 `data-pp-skeleton="pulse|sweep|both"`，并写 CSS 变量
    `--pp-skel-glint`（强调色跟随主题时用主题 accent，自定义时用设置值）；
  - 通过 `PageSkeletonContext` 把当前动效值传给站点内容（供区块骨架判断是否接管）。
- 离开骨架模式 / 进入后台 / 组件卸载时清除上述属性。
- `approach === 'overlay'` 时保持现有逻辑；`off` 时什么都不显示。
- 站点外壳（`SiteChrome`）立即渲染，内容区由各页面自己的 loading 状态决定骨架。

## 骨架外观与组件

`apps/web/src/components/ui.tsx`

- `Skeleton` 保持现有 API（`lines`），动画改为受 `<html data-pp-skeleton>` 驱动的
  CSS 实现；无该属性时维持现有 shimmer 表现（后台/兼容）。
- 新增轻量变体组件（仅站点前台使用）：
  - `SkeletonLine`（单行，可指定宽度）；
  - `SkeletonCard`（封面块 + 2–3 行）；
  - `SkeletonRow`（日期列 + 标题/摘要行，归档与列表用）；
  - `SkeletonPanel`（侧栏/小卡：标题行 + 若干短行）；
  - `SkeletonGrid`（N 列卡片网格，列数可传）。
- 所有变体只输出带类名的占位元素，不写死颜色，颜色全部来自 CSS 主题令牌。

## 页面编排骨架（区块级）

新增 `apps/web/src/components/blocks/BlockSkeleton.tsx`，由 `BlockView` 决定何时接管：

- 条件：骨架模式开启 + 当前页面有 `FeedProvider` 且 `feed.loading === true` + 区块类型在
  骨架映射表里。
- 接管时仍渲染原来的 `<section class="pp-block" style=…>` 外壳（宽度、最小高度、外观、
  自定义 CSS 全部保留），内部换成骨架；区块的最终栏位（整幅 / 主栏 / 侧栏、columns /
  container 内）由 `ScreenRenderer` 的结构决定，所以位置不变。
- 静态区块与 hero 区块不接管：
  - hero（`classic-hero` / `bento-hero`）保留自身文案，仅把内部「头条卡片」的 loading
    分支换成 `SkeletonCard`，避免把可立即显示的文字也藏起来。
- 形状映射表放在 `apps/web/src/lib/loading.ts`（或同层新文件），按类型归到以下模板：

| 形状 | 区块类型 | 说明 |
| --- | --- | --- |
| `feed` | `feed` | 左侧 3 行文章 + 右侧栏小卡 |
| `list` | `post-list`、`popular-content`、`recent-content` | 标题行 + 若干行 |
| `grid` | `post-grid`、`articles` | 按 `columns`/`limit` 画卡片网格 |
| `feature` | `feature-post` | 大卡：封面块 + 标题/摘要行 |
| `mosaic` | `spotlight`、`spotlight-hot` | 一大两小卡片 |
| `aside` | `stat-list`、`archive` | 小面板：标题行 + 短行 |

（`chart` / `stats` 用独立的分析请求，不由 `FeedContext` 驱动，交由渲染器自身处理；
`author-card`、`tag-cloud`、`search-launcher`、`command-hints`、`category-pills`、`timeline`
等静态区块不骨架化。）

映射表按区块类型字符串维护；未登记的类型不骨架化（渲染器自己决定），避免误伤静态区块。
各模板的行数/列数从区块属性读取并做上下限保护，缺省值给出的骨架高度接近真实内容。

## 固定页面

- 归档 / 文章详情 / 搜索 / 个人主页等已有的 `Skeleton` 分支保留，自动获得新外观；
  归档列表额外换成 `SkeletonRow`，与最终列表项位置对齐。
- 没有异步数据、立即可渲染的页面（登录、404 等）不显示骨架。
- 不新增首屏之外的额外请求；骨架完全由现有 loading 状态驱动。

## 样式（`apps/web/src/styles.css`）

- 新增 `/* ---------- 页面骨架（SKELETON / SHIMMER） ---------- */` 段落：
  - `.pp-skel`、`.pp-skel-line`、`.pp-skel-media`、`.pp-skel-card`、`.pp-skel-row`、
    `.pp-skel-panel`、`.pp-skel-grid`、`.pp-skel-hero`、`.pp-skel-mosaic` 等；
  - 基础色用 `--bg-sunken` / `--bg-subtle` 的混色，保证深浅主题都协调；
  - 扫光用 `--pp-skel-glint`（缺省回退主题 accent 的低透明度）；
  - `html[data-pp-skeleton='pulse']`：占位块呼吸；
  - `html[data-pp-skeleton='sweep']`：扫光带横向扫过；
  - `html[data-pp-skeleton='both']`：两者叠加；
  - `html[data-motion='reduced'][data-pp-skeleton]`：全部 `animation: none`，只留静态占位。
- 骨架尺寸用相对单位（百分比 / `em`），在 320px–1440px 下都近似最终版式；
  不写死像素高度（区块自带的最小高度与内容高度仍由真实区块决定）。
- 保留现有 `.skeleton` 默认样式，避免影响后台。

## 后台加载设置页（`apps/web/src/pages/admin/Loading.tsx`）

- 预设区分两组展示：
  - 「全屏加载」：现有 5 个；
  - 「页面骨架」：SKELETON / SHIMMER / SKELETON + SHIMMER。
- 选中骨架预设时：
  - 隐藏不适用的控件：加载文案、图形尺寸、背景、最短展示、首次加载/站内切换开关；
  - 保留：启用开关、强调色（作为扫光颜色）、附加 CSS，并在图形区下方显示说明
    「骨架会出现在内容最终出现的位置；后台与编排预览不显示」；
  - 预览区换成迷你页面骨架：页头行、标题行、正文行、卡片网格，按当前动效循环播放；
    跟随当前主题色；
  - 隐藏「全屏预览」按钮（骨架模式没有全屏画面）。
- 当前设置侧栏显示「加载方式：页面骨架」「动效：呼吸 / 扫光 / 呼吸 + 扫光」。
- 保存、脏标记、恢复默认（回圆环全屏动画）逻辑不变。
- 非骨架预设的界面与行为保持现状。

## i18n

- `apps/web/src/lib/i18n/dict/fragments/pages_admin_Loading.ts` 增加：分组标题、
  3 个预设名称与说明、骨架模式提示、动效名称、预览说明等。
- `apps/web/src/lib/i18n/dict/fragments/lib_loading.ts` 增加 `lib/loading.ts` 新增的
  中文键（如形状/动效标签若在该文件产生）。
- 覆盖率闸门（`i18n/coverage.test.ts`）保证没有漏译。

## 错误处理与边界

- `document` 不存在（SSR/测试）时，加载层不写属性、不渲染遮罩。
- 从骨架模式切回全屏模式或关闭：立即清除 `data-pp-skeleton` 与 `--pp-skel-glint`，
  下一次导航恢复全屏遮罩逻辑。
- 区块骨架只在 `feed.loading` 为真时出现；请求失败时沿用各页面/区块现有的错误界面。
- 编排预览 iframe（`isPreviewFrame()`）、后台路径、`/setup*` 不受骨架模式影响。
- 减少动效时三种动效都退化为静态占位，不出现扫光/呼吸。

## 测试与验证

单元测试（vitest，`apps/web/src/lib/loading.test.ts`）：

1. `readLoading` 接受三个新预设；未知 preset 仍回退 `spinner`。
2. `loadingApproach`：
   - 关闭 → `off`；
   - 骨架预设 + 两个场景开关都关 → `skeleton`；
   - 全屏预设 + 场景开关至少一个开 → `overlay`；
   - 全屏预设 + 两个场景开关都关 → `off`。
3. `skeletonMotion` 三个映射正确。
4. 区块形状映射：登记的类型有形状、静态类型没有（避免误伤）。

命令验证：

- `pnpm --dir apps/web test`（或仓库根 `make test-web`，以仓库脚本为准）；
- `pnpm --dir apps/web typecheck`；
- `pnpm --dir apps/web build`；
- 浏览器手动检查：首页（经典 / 夜航）、自定义页、文章详情、归档、搜索、个人主页；
  切换主题与深浅色；开启「减少动效」；开启/关闭加载；切换回全屏预设。

## 受影响文件（预估）

- `apps/web/src/types.ts`
- `apps/web/src/lib/loading.ts`、`apps/web/src/lib/loading.test.ts`
- `apps/web/src/components/LoadingLayer.tsx`
- `apps/web/src/components/ui.tsx`
- `apps/web/src/components/blocks/index.tsx`、新增 `BlockSkeleton.tsx`
- `apps/web/src/components/blocks/Classic.tsx`、`Nightflight.tsx`（hero 卡片骨架）
- `apps/web/src/pages/site/Archive.tsx`（列表行骨架）
- `apps/web/src/pages/admin/Loading.tsx`
- `apps/web/src/styles.css`
- `apps/web/src/lib/i18n/dict/fragments/pages_admin_Loading.ts`、`lib_loading.ts`
- 文档：`README.md` / `apps/web/README.md` 中加载动画一句说明

## 验收标准

1. 启用并选择任一骨架预设后，刷新首页：导航先出现，内容区域在原位置显示骨架，
   数据到达后原地替换，全程没有全屏遮罩。
2. 切换主题（含深浅色）后骨架配色跟随；改页面编排后骨架按新区块栏位排列。
3. 三种动效可区分（呼吸 / 扫光 / 叠加）；减少动效时静帧。
4. 关闭加载或切回全屏预设后，行为与现在完全一致。
5. 后台、安装向导、编排预览 iframe 不出现页面骨架模式。
6. `vitest`、`tsc --noEmit`、`vite build` 全绿。
