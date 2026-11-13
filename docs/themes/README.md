# 主题文档

这套文档讲清楚三件事：**怎么在后台把主题设好**、**怎么自己写一套能被页面编排继续加工的主题**、**到底哪些外观能改、改在哪、边界在哪**。

三篇都按当前源码写成，凡与旧设计文档冲突的地方以代码为准，冲突点集中列在下面的[文档与代码的冲突](#conflicts)里。

## 三篇文档

| 文档 | 回答的问题 | 主要读者 |
| --- | --- | --- |
| [01 设置主题](./01-setup.md) | 后台从哪进、点哪个键、两套内置主题差在哪、导入 / 导出 / 另存 / 删除 / 恢复默认各自会发生什么 | 站长、运营 |
| [02 编写可编排的主题](./02-authoring.md) | 主题 JSON 的字段、令牌与 CSS 变量的对应、版式变体、默认编排与自定义编排如何共存、从零写一个可导入的示例、校验与限制 | 主题作者、前端开发者 |
| [03 外观清单](./03-appearance.md) | 逐项列出能改的外观（品牌、页头、导航、页脚、文章卡、配色、组件外观、柔化、加载动画），每项标「后台可配 / 仅代码或导 JSON 可改 / 不可改」 | 站长、设计师、主题作者 |

## 一分钟速查

- **内置大主题只有两套**：`default`（原版 · 纸白浅色 · 单栏）与 `night`（夜航 · 冷石墨 · 双栏）。「白昼」已在 2026-11 下架，只留 `daylight` 版式给旧配置读取（见 [01](./01-setup.md#builtin)）。
- **主题 = 配色 + 排版 + 版式变体 + 外观分区绑定**，不包含文章、页面、页面编排、导航、页脚与自定义 CSS。
- **主题文件格式**：外层 `kind / version / exported_at / name / note / variant / theme / appearance`；导入时只认 `name`、`note`、`variant`、`theme`、`appearance`，其余字段忽略。
- **令牌只有 13 个键**，全部落成 CSS 变量：`background → --bg`，其余下划线换连字符（`bg_subtle → --bg-subtle`）。
- **上限**：自定义主题最多 20 套；名称 40 字、备注 160 字；令牌单个值 ≤120 字符；整份站点设计 ≤1 MiB（前端 512 KiB 软警告）。
- **主题不写自定义 CSS**。要写样式只有两条路：改源码，或在「外观 → 自定义 CSS」里写（那是站点配置，不随主题导出）。

## 源码索引

写文档时逐条核对过的文件，改代码后请同步这里：

| 文件 | 作用 |
| --- | --- |
| `apps/web/src/lib/theme.ts` | 配色预设、13 个令牌、`safeCssValue` 校验、`resolveTokens`、`themeCss` 输出、`applyPreset` / `applyMode` |
| `apps/web/src/lib/themes.ts` | 内置大主题、外观分区、`parseThemeFile` / `downloadThemeFile`、`normalizeCustomTheme` |
| `apps/web/src/lib/themeSwitch.ts` | 套用主题的配置补丁与「首页是否还是默认编排」判定 |
| `apps/web/src/lib/themePreference.ts` | 访客的 `pp_theme` Cookie 偏好 |
| `apps/web/src/lib/themeTransition.ts` | 明暗切换的 420ms 过渡与路由 View Transition |
| `apps/web/src/lib/blocks.ts` | `defaultHomeLayout(variant)`、区块注册表、`availableBlocks(variant)` |
| `apps/web/src/lib/layout.ts` | 断点 480 / 768 / 1024、间距标尺、设备覆盖层 `at` 的读写 |
| `apps/web/src/lib/navigation.ts` | 导航与页脚的上限（Tab 8、二级 8、快捷链接 8、页脚 4 栏 × 8 条） |
| `apps/web/src/lib/customize.ts` | 站点设计文档结构、`readCustomization` 归一化、导入导出 |
| `apps/web/src/lib/loading.ts` | 加载动画设置与预设（属于站点配置，不属于主题） |
| `apps/web/src/components/CustomizationLayer.tsx` | 把主题写成 `#pp-theme` 样式表、写 `<html data-mode/data-variant>` |
| `apps/web/src/components/SiteChrome.tsx` | 页头、导航、公告条、页脚的真实 DOM 与数据来源 |
| `apps/web/src/components/blocks/{Classic,Nightflight,Daylight}.tsx` | 三套版式的首页区块实现 |
| `apps/web/src/pages/admin/ChooseTheme.tsx` | 「选择主题」页：应用、创建、导入、导出、删除 |
| `apps/web/src/pages/admin/Themes.tsx` | 「主题设置」页：微调、令牌、外观分区绑定、导航与页脚、加载动画入口 |
| `apps/web/src/pages/admin/ThemeBuilder.tsx` | 「页面编排」工作台 |
| `apps/web/src/pages/admin/Appearance.tsx` | 「外观」页：首屏、品牌副标题、公告条、自定义 CSS（按主题声明的分区裁剪） |
| `apps/web/src/components/theme/ThemeTokensPanel.tsx` | 高级主题令牌的逐项覆盖面板 |

<a id="conflicts"></a>

## 文档与代码的冲突

以下说法出现在 README、`docs/introduction.md`、`apps/web/README.md` 或旧设计稿里，但**与当前代码不符**，本文档一律按代码写：

| 旧说法 | 代码事实 | 依据 |
| --- | --- | --- |
| 「3 套大主题（原版 / 白昼 / 夜航）」 | 只有 2 套内置大主题：`default`、`night`。`daylight` 主题与配色预设已移除，只有 `variant: 'daylight'` 仍被读取 | `lib/themes.ts` 的 `RAW_BUILTIN_THEMES`；`lib/themes.test.ts` 断言 `BUILTIN_THEMES` 长度为 2、`builtinThemeBundle('daylight')` 为 `null` |
| 「8 套配色预设」 | 实际是 7 套（纸白 / 暖砂 / 雾蓝 / 灰绿 / 陶土 / 夜航 / 夜航·浅色），而且**后台没有预设选择器**：预设只由内置主题和导入 JSON 的 `theme.preset` 决定。改三个基色会把 `preset` 置为 `custom` | `lib/theme.ts` 的 `RAW_THEME_PRESETS`；全仓库只有 `presetById` / `applyPreset` / `applyMode` 读它，没有任何页面渲染预设列表 |
| README「主题微调」列出「背景柔光、组件混色、过渡时长、页头模糊」 | 这四项不是四个独立开关，而是 `theme.soften` 下的一个总开关 + 5 个参数；总开关关闭时全部变量归零 | `lib/theme.ts` 的 `themeCss`（`--soften-*` 在 `enabled=false` 时为 0）；`pages/admin/Themes.tsx` 的柔化面板 |
| `docs/superpowers/specs/2026-10-25-theme-marketplace-integration.md`：导入时必须「拒绝包含文章、页面、自定义 CSS 或额外字段的文件」 | 代码实际是**忽略**：`parseThemeFile` 只取 `theme` / `variant` / `name` / `note` / `appearance`，其余字段既不报错也不导入 | `lib/themes.ts` 的 `parseThemeFile` |
| 类型注释写「正文栏宽 640–860 px」 | 实际夹取范围是 **620–900 px**（后台滑杆、归一化、导入同一套） | `lib/theme.ts` 的 `normalizeThemeSettings`；`pages/admin/Themes.tsx` 滑杆 `min=620 max=900` |
| 「白昼」的配色表仍被当作可用主题文档 | 白昼令牌只作为《2026-11-08-daylight-theme.md》的历史资料；当前浅色令牌属于夜航的冷白重配 | `lib/theme.ts` 的 `NIGHT_LIGHT` 注释 |

## 相关文档

- [两套内置主题的结构差异](../design/theme-differences.md)
- [2026-11 主题与阅读体验修订](../design/2026-11-09-theme-refresh.md)
- [白昼（历史文档）](../design/2026-11-08-daylight-theme.md)
- [主题市场接入约定](../superpowers/specs/2026-10-25-theme-marketplace-integration.md)
- [前端说明](../../apps/web/README.md)
