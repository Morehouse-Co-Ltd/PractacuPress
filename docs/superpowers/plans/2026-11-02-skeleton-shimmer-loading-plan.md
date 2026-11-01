# SKELETON / SHIMMER 原位骨架加载 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在加载设置中加入 SKELETON / SHIMMER / SKELETON+SHIMMER 三种原位骨架加载方式，去掉全屏遮罩，让骨架出现在内容最终出现的位置，并适配页面编排与主题切换。

**Architecture:** 用 `loadingApproach()` 把现有单一遮罩模型拆成 `off | overlay | skeleton` 三条路径。骨架模式由 `LoadingLayer` 去掉遮罩、在 `<html>` 写 `data-pp-skeleton` 与 `--pp-skel-glint`，并通过 React Context 让 `BlockView` 在 feed 加载时用区块级骨架接管；固定页面沿用现有 `Skeleton` 分支。样式全部走主题令牌，动效由 HTML 属性驱动 CSS。

**Tech Stack:** React 19 + TypeScript + Vite + Vitest（`apps/web`），样式集中在 `apps/web/src/styles.css`。

**Spec:** `docs/superpowers/specs/2026-11-02-skeleton-shimmer-loading-design.md`

## Global Constraints

- 只扩展 `LoadingPreset` 枚举，不新增持久化字段；旧配置回退 `spinner`。
- 现有 5 个全屏预设的渲染与行为保持不变。
- 骨架模式只作用于站点前台；后台、`/setup*`、编排预览 iframe 不进入。
- `data-motion='reduced'` 时骨架静帧。
- 所有新文案都必须进 i18n 片段（覆盖率测试会检查）。
- 提交粒度：每个任务一次 commit。

## File Structure

- `apps/web/src/types.ts` — `LoadingPreset` 联合类型扩展。
- `apps/web/src/lib/loading.ts` — 预设目录、`loadingApproach`、`skeletonMotion`、区块骨架形状映射（纯函数）。
- `apps/web/src/lib/loading.test.ts` — 上述纯函数的测试。
- `apps/web/src/components/LoadingLayer.tsx` — 模式分流、`<html>` 属性与 CSS 变量、Provider。
- `apps/web/src/components/SkeletonMode.tsx` — `PageSkeletonProvider` / `usePageSkeleton()`。
- `apps/web/src/components/ui.tsx` — `Skeleton` 保持 API，新增 `SkeletonLine` / `SkeletonCard` / `SkeletonRow` / `SkeletonPanel` / `SkeletonGrid`。
- `apps/web/src/components/blocks/BlockSkeleton.tsx` — 区块骨架模板（按 shape 渲染）。
- `apps/web/src/components/blocks/index.tsx` — `BlockView` 在骨架模式下接管 feed 区块。
- `apps/web/src/components/blocks/Classic.tsx` / `Nightflight.tsx` — hero 内部头条卡片 loading 换成 `SkeletonCard`。
- `apps/web/src/pages/site/Archive.tsx` — 列表 loading 换成 `SkeletonRow`。
- `apps/web/src/pages/admin/Loading.tsx` — 预设分组、骨架模式条件 UI、迷你页面骨架预览。
- `apps/web/src/styles.css` — 页面骨架样式与三种动效。
- `apps/web/src/lib/i18n/dict/fragments/pages_admin_Loading.ts`、`lib_loading.ts` — 新文案英文。
- `README.md` / `apps/web/README.md` — 一句话说明。

---

### Task 1: 加载模型与纯函数

**Files:**
- Modify: `apps/web/src/types.ts`（`LoadingPreset`）
- Modify: `apps/web/src/lib/loading.ts`
- Test: `apps/web/src/lib/loading.test.ts`

**Interfaces (Produces):**

```ts
export type SkeletonMotion = 'pulse' | 'sweep' | 'both';
export type SkeletonShape = 'feed' | 'list' | 'grid' | 'feature' | 'mosaic' | 'aside' | 'chart';

export const SKELETON_PRESETS: readonly LoadingPreset[];
export function isSkeletonPreset(preset: LoadingPreset): boolean;
export function loadingApproach(settings: LoadingSettings): 'off' | 'overlay' | 'skeleton';
export function skeletonMotion(settings: LoadingSettings): SkeletonMotion | null;
export const BLOCK_SKELETON_SHAPES: Record<string, SkeletonShape>;
```

- [ ] Step 1: 写失败测试（覆盖 spec「测试与验证」1–4 条）。
- [ ] Step 2: `npm test -- --run src/lib/loading.test.ts` 确认失败。
- [ ] Step 3: 实现类型、目录、纯函数与映射表（shape 值按 spec 表格；未登记类型不给 shape）。
- [ ] Step 4: 再跑测试确认通过。
- [ ] Step 5: `git add` 三个文件并提交 `feat(web): add skeleton loading presets and mode helpers`。

### Task 2: 加载层分流与骨架上下文

**Files:**
- Create: `apps/web/src/components/SkeletonMode.tsx`
- Modify: `apps/web/src/components/LoadingLayer.tsx`

**Interfaces:**
- Consumes: Task 1 的 `loadingApproach`、`skeletonMotion`。
- Produces: `PageSkeletonProvider`（props `motion: SkeletonMotion`）、`usePageSkeleton(): SkeletonMotion | null`。

- [ ] Step 1: 骨架模式下不渲染遮罩、不启动计时；`useEffect` 写 `document.documentElement.dataset.ppSkeleton = motion` 与 `style.setProperty('--pp-skel-glint', accent)`；清理时删除。
- [ ] Step 2: `approach === 'overlay'` 时保持现有首载/导航计时逻辑；`off` 时两者都不出现。
- [ ] Step 3: 在 children 外层包 `PageSkeletonProvider`（仅骨架模式给非 null，其余 null）。
- [ ] Step 4: `npm run typecheck` 通过。
- [ ] Step 5: 提交 `feat(web): switch loading layer to in-place skeleton mode`。

### Task 3: 骨架基础组件与样式

**Files:**
- Modify: `apps/web/src/components/ui.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces (Produces):**
- `SkeletonLine({ width?: string })`
- `SkeletonCard({ lines?: number; media?: boolean })`
- `SkeletonRow()` — 日期列 + 标题/摘要行
- `SkeletonPanel({ lines?: number })`
- `SkeletonGrid({ columns?: number; count?: number })`
- CSS 类：`.pp-skel`、`.pp-skel-line`、`.pp-skel-media`、`.pp-skel-card`、`.pp-skel-row`、`.pp-skel-panel`、`.pp-skel-grid`、`.pp-skel-hero`、`.pp-skel-mosaic`、`.pp-skel-chart`。

- [ ] Step 1: 新增组件；`Skeleton` 保留原签名。
- [ ] Step 2: `styles.css` 追加「页面骨架」段落，颜色用 `var(--bg-sunken)` / `var(--bg-subtle)` 混色，扫光用 `var(--pp-skel-glint, color-mix(in srgb, var(--accent) 30%, transparent))`。
- [ ] Step 3: `html[data-pp-skeleton='pulse'|'sweep'|'both']` 三种动效；`html[data-motion='reduced'][data-pp-skeleton]` 静帧。
- [ ] Step 4: `npm run build` 通过（含 tsc）。
- [ ] Step 5: 提交 `feat(web): add skeleton primitives and in-place skeleton styles`。

### Task 4: 页面编排区块骨架

**Files:**
- Create: `apps/web/src/components/blocks/BlockSkeleton.tsx`
- Modify: `apps/web/src/components/blocks/index.tsx`
- Modify: `apps/web/src/components/blocks/Classic.tsx`、`Nightflight.tsx`（仅 hero 头条卡片 loading 分支）

**Interfaces:**
- Consumes: `usePageSkeleton()`、`BLOCK_SKELETON_SHAPES`、Task 3 组件。
- Produces: `<BlockSkeleton block={block} shape={shape} />`。

- [ ] Step 1: `BlockView` 中 `const motion = usePageSkeleton(); const feed = useFeed();`，条件 `motion && feed.loading && BLOCK_SKELETON_SHAPES[block.type]` 时渲染 `BlockSkeleton`（外壳 section 与原样式保留，嵌套子区块此时不渲染）。
- [ ] Step 2: 按 shape 实现模板，数量/列数从 `blockProp` 读取并 clamp。
- [ ] Step 3: hero 的两个 loading 分支换成 `SkeletonCard`（保留文案）。
- [ ] Step 4: `npm run typecheck` + `npm run build`。
- [ ] Step 5: 提交 `feat(web): render block-shaped skeletons at final layout positions`。

### Task 5: 后台加载设置页

**Files:**
- Modify: `apps/web/src/pages/admin/Loading.tsx`
- Modify: `apps/web/src/lib/i18n/dict/fragments/pages_admin_Loading.ts`
- Modify: `apps/web/src/lib/i18n/dict/fragments/lib_loading.ts`（如有新 t() 键）

- [ ] Step 1: 预设网格按「全屏加载 / 页面骨架」分组；用 `isSkeletonPreset` 判定。
- [ ] Step 2: 骨架模式下隐藏不适用控件，保留启用、强调色、附加 CSS；`全屏预览` 按钮只在全屏预设显示。
- [ ] Step 3: 预览区改为迷你页面骨架（`SkeletonGrid` / `SkeletonRow` / `SkeletonCard` 组合），按当前动效和主题色播放；侧栏显示加载方式与动效。
- [ ] Step 4: 补 i18n；`npm test -- --run src/lib/i18n`（覆盖率闸门）。
- [ ] Step 5: 提交 `feat(web): configure skeleton/shimmer loading in admin`。

### Task 6: 固定页面与文档

**Files:**
- Modify: `apps/web/src/pages/site/Archive.tsx`（loading → `SkeletonRow` ×3）
- Modify: `README.md`、`apps/web/README.md`（加载动画一句）

- [ ] Step 1: 归档 loading 分支换成 3 个 `SkeletonRow`。
- [ ] Step 2: 文档补一句「新增原位骨架加载方式（SKELETON / SHIMMER）」。
- [ ] Step 3: 提交 `docs: document skeleton loading mode`。

### Task 7: 集成验证

- [ ] Step 1: `npm test`（全部）。
- [ ] Step 2: `npm run typecheck`。
- [ ] Step 3: `npm run build`。
- [ ] Step 4: 浏览器验证（无头截图或 dev server）：首页经典/夜航、文章页、归档页、搜索页；换主题、深浅色、reduced-motion；开关加载与切回全屏预设。
- [ ] Step 5: 汇总证据（测试输出、截图路径、已知差异），提交剩余改动。

## Self-Review

- Spec 每个「目标」都有任务：预设/模型 Task 1，无遮罩 Task 2，原位骨架 Task 3/4/6，主题跟随 Task 3，后台 UI Task 5，动效 Task 3，i18n Task 5。
- 非目标（后台骨架、自定义形状编辑、新字段、历史 stale-data）未排任务。
- 接口名前后一致：`loadingApproach`、`skeletonMotion`、`SKELETON_PRESETS`、`usePageSkeleton`、`BLOCK_SKELETON_SHAPES`、`BlockSkeleton`。

## 实现记录（2026-11-02）

- Task 1–6 全部完成；代码留在工作区未提交，和仓库里已有的未提交改动分开，由站长统一审阅。
- 验证结果：
  - `npm test`：34 个测试文件 / 412 个用例全部通过（含 i18n 覆盖率闸门）。
  - `npm run build`（含 `tsc --noEmit`）：通过。Windows 默认临时目录偶发 esbuild 清理
    `Access is denied`，把 `TEMP`/`TMP` 指到仓库 `.tmp/esbuild-tmp` 后构建成功。
  - `node scripts/e2e-skeleton-loading.mjs`：15/15 通过，截图在
    `apps/web/.tmp/shots-skeleton/`。覆盖首页原位骨架、三种动效、reduced-motion、
    深色主题跟随、全屏预设回归、后台加载页分组与预览。
- 实现偏差：
  - 区块形状映射按实际 `useFeed` 调用收敛为 `feed / post-list / post-grid / feature-post /
    spotlight / spotlight-hot / stat-list / archive / articles / popular-content /
    recent-content`；`chart`、`stats` 用独立分析请求，仍由渲染器自己处理。
  - `SkeletonLine` 暂不支持 `className`/`style`，后台迷你预览的眉题/标题行用宽度区分，
    CSS 里的 `.pp-skel-title` / `.pp-skel-eyebrow` 暂未使用。
  - 页面编排里 hero 区块保留自身静态文案，只把头条卡片换成 `SkeletonCard`，
    避免把能立刻显示的文字也藏起来。

