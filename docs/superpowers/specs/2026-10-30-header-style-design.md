# 页头样式（吸顶 / 顶部透明 / 悬浮胶囊）设计说明

日期：2026-10-30
状态：已实现并验证
范围：`apps/web`（纯前端展示层，不改 OpenAPI 与 Go / Rust）

## 目标

页头有两种状态：页面顶部时融进首屏，向下滚动后变成一条浮在内容上的
圆角胶囊（半透明 + 高斯模糊）。本站把这件事做成可选的页头样式 + 模糊开关：

- 可以选择页头的样式，且样式会在滚动后发生变化；
- 可以单独开关背景高斯模糊并调强度；
- 不破坏现有主题（纸白 / 夜航）、明暗模式与后台固定纸白；
- 默认值保守，老站点升级后观感基本不变。

## 配置（`LayoutSettings`）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `header_style` | `'classic' \| 'transparent' \| 'float'` | `classic` | 页头样式变体 |
| `header_blur` | `boolean` | `true` | 背景是否高斯模糊 |
| `header_blur_amount` | `number` | `10` | 模糊半径，4–24px |
| `header_threshold` | `number` | `8` | 滚动多少像素后切到「滚动后」状态，0–240px |

归一化在 `lib/customize.ts`：未知样式回退 `classic`，数字取整并夹紧范围；随「外观 → 导出配置」
一起迁移。设置入口：后台 → 主题设置 → 导航与页脚 → 页头样式（三张预览卡 + 模糊开关 + 两个数字项）。

## 行为

- `<html data-header-style="…">` 由 `SiteChrome` 写入（离开站点外壳时删除）；页头自身带
  `data-blur="on|off"` 与内联 `--header-blur`。
- 滚动监听（passive）：`window.scrollY > header_threshold` 时给 `.site-header` 加 `is-scrolled`；
  路由切换后重新判断一次。
- **classic**：保持整条吸顶；`is-scrolled` 时加投影。模糊开关控制背景透明度与 `backdrop-filter`。
- **transparent**：页首完全透明（无底色 / 边框 / 模糊）；`is-scrolled` 后恢复半透明或实色底色 + 投影。
- **float**：页首透明；`is-scrolled` 后 `.header-inner` 变成居中的圆角胶囊（宽度上限 1280px，
  窄屏铺满，顶部固定 10px 间距 → 滚动时不改变页头高度，避免整页跳动）；模糊层只出现在滚动后的胶囊上。
  移动端菜单在 float 下也变成同款圆角卡片。
- 页头样式只作用于站点前台；认证页走极简外壳但同样应用样式。

## 文件

| 文件 | 作用 |
| --- | --- |
| `src/types.ts` | `HeaderStyle` + `LayoutSettings` 四个字段 |
| `src/lib/customize.ts` | 默认值、`normalizeHeaderStyle` / `clampNumber`、读取归一化 |
| `src/components/SiteChrome.tsx` | 滚动监听、`data-header-style` / `data-blur` / `--header-blur`、`is-scrolled` |
| `src/styles/header.css` | 三种样式与模糊规则、后台预览卡样式；靠 `html` 前缀覆盖基础规则与夜航覆盖 |
| `src/styles.css` | 新增一行 @import |
| `src/pages/admin/Themes.tsx` | 「页头样式」面板（三选一 + 模糊开关 + 强度 + 阈值） |
| `scripts/e2e-header.mjs` | 24 项端到端断言 + 截图 |

## 验证

- `scripts/e2e-header.mjs`：PASS 24 / FAIL 0（三种样式滚动前/后、模糊开关、阈值、夜航深色、
  后台三选一与选中态）。
- `npm run typecheck`、`npx vitest run`（24 文件 / 201）、smoke 162、`npm run build`、
  `e2e-nightflight.mjs`（全部通过）、`e2e-features.mjs`（43/43）全部通过。
- 对比度审计（`scripts/audit-contrast.mjs`，纸白深色）：站点前台仍为 0 条低对比度。
- 截图：`docs/assets/2026-10-30-header/`。

## 明确不做

- 不做滚动时改变页头高度 / 压缩 logo（会引入布局位移，且与现有导航 padding 冲突）。
- 不为页头单独配置背景图 / 渐变；背景仍然由主题令牌 + 透明度决定。
- 页首透明样式不自动给首屏图片加遮罩：首屏背景是否可读由站点内容决定，后台提示里已说明。
