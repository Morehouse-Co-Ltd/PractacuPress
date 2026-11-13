# 02 · 如何写出后期可通过页面编排的主题

面向主题作者与前端开发者。目标：看完能写出一份**能被「导入主题」接受、并且在页面编排里继续加工**的主题 JSON，同时清楚它**不能**做什么。

结论先放这里：**主题给的是「一套观感 + 一个版式入口」，编排给的是「页面上长什么区块」。** 主题不携带区块，也不携带导航、页脚、文章与 CSS。

## 目录

- [一、主题能装什么、不能装什么](#model)
- [二、数据结构](#structure)
- [三、令牌与 CSS 变量](#tokens)
- [四、版式变体](#variant)
- [五、桌面 / 平板 / 手机三端怎么表达](#devices)
- [六、主题默认编排与页面编排如何共存](#coexist)
- [七、从零写一个可导入的主题 JSON](#json)
- [八、校验与限制](#validation)
- [九、作者自查清单](#checklist)

<a id="model"></a>

## 一、主题能装什么、不能装什么

| 能 | 不能 |
| --- | --- |
| 13 个配色令牌（含亮/暗两套来源） | 文章、帖子、评论、媒体 |
| 标题字体（衬线 / 无衬线）、正文字号、正文栏宽、圆角基准 | 首页 / 文章页的区块编排 |
| 柔化与过渡（开关、强度、时长、页头模糊、柔光渐变、组件混色） | 导航 Tab、二级入口、快捷链接 |
| 一个版式变体（`classic` / `bento` / 旧配置的 `daylight`） | 页脚栏目、版权、备案号 |
| 声明自己需要哪些「外观」分区 | 自定义 CSS、`<style>`、`<script>`、HTML |
| 名称、备注 | 页面、模板、广告位、域名与访问限制 |

主题文件里塞进文章或页面不会生效：`parseThemeFile` 只读 `theme`、`variant`、`name`、`note`、`appearance` 五个字段，其余**静默忽略**（见[第八节](#validation)）。

<a id="structure"></a>

## 二、数据结构

### 2.1 文件外层

`选择主题 → 导出当前主题` 生成的文件长这样（`lib/themes.ts` 的 `downloadThemeFile`）：

```json
{
  "kind": "pp-theme",
  "version": 1,
  "exported_at": "2026-11-10T12:00:00.000Z",
  "name": "夜航 · 摄影版",
  "note": "冷石墨底，强调色偏青。",
  "variant": "bento",
  "theme": { "...": "见 2.3" },
  "appearance": { "sections": ["hero", "branding", "announcement", "custom_css"] }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `kind` | 否 | 导出时写 `"pp-theme"`；**导入不校验**，可以为任意值或省略 |
| `version` | 否 | 导出时写 `1`；导入不校验 |
| `exported_at` | 否 | ISO 时间，只作记录，导入时忽略 |
| `name` | 否 | 主题名，≤40 字；缺省为「导入的主题」 |
| `note` | 否 | 备注，≤160 字 |
| `variant` | 否 | 版式变体，见[第四节](#variant)；非法值退 `classic` |
| `theme` | **是** | 主题本体，缺了会报「文件里没有可识别的主题配置。」 |
| `appearance` | 否 | `{ "sections": [...] }`；缺省表示四个分区全开 |

### 2.2 主题对象（`SiteTheme`）

存进 `customization.themes` 之后，一条自定义主题是：

```ts
interface SiteTheme {
  id: string;            // 导入时总是新生成；文件里的 id 会被丢弃
  name: string;
  note: string;
  variant: LayoutVariant;
  theme: ThemeSettings;
  appearance?: { sections: AppearanceSectionId[] };
}
```

`id` 的规则：必须匹配 `/^[a-z0-9][a-z0-9_-]*$/i`，否则重新生成一个 `theme_xxxx`；与内置主题重名（`default` / `night`）时改写成 `custom_<id>`。

### 2.3 主题本体（`ThemeSettings`）

| 字段 | 类型 | 缺省 | 范围 / 取值 | 说明 |
| --- | --- | --- | --- | --- |
| `preset` | string | `"paper"` | ≤40 字符 | 已知预设 id 时整组令牌来自预设；未知值（约定写 `"custom"`）时由三基色推导 |
| `mode` | `"light"` \| `"dark"` | `"light"` | 只有 `"dark"` 被识别，其余一律 `light` | 站点默认模式；访客 Cookie 可覆盖 |
| `background` | string | `"#ffffff"` | 十六进制（3/4/6/8 位） | 只在 `preset` 未知时参与推导 / 作为主题卡片预览 |
| `ink` | string | `"#14140f"` | 同上 | 同上 |
| `accent` | string | `"#1f5c4a"` | 同上 | 同上 |
| `tokens` | object | 无 | 13 个白名单键，值 ≤120 字符 | 逐项覆盖，优先级最高 |
| `heading_font` | `"serif"` \| `"sans"` | `"serif"` | 只有 `"sans"` 被识别 | `sans` 时把 `--serif` 指向 `--sans` |
| `body_size` | number | `17.5` | 14–20，按 0.5 取整 | 文章与自定义页面正文字号 |
| `content_width` | number | `720` | 620–900，整数 | 正文栏宽 |
| `radius` | number | `6` | 0–12，整数 | 圆角基准 |
| `soften` | object | 见下 | — | 柔化与过渡 |

`soften` 的缺省值（`DEFAULT_SOFTEN`）：

```json
{
  "enabled": false,
  "strength": 45,
  "transition_ms": 240,
  "gradient": true,
  "blend_components": true,
  "blur": 8
}
```

`enabled` 必须是布尔 `true` 才开启；`gradient` / `blend_components` 只有显式写 `false` 才关闭（缺省视为 `true`）。数值会被夹取：`strength` 0–100、`transition_ms` 0–1200、`blur` 0–24。

### 2.4 主题里没有「页脚 / 导航 / 默认区块编排」

写主题时最常问的三个东西，都不在 `SiteTheme` 里：

| 想要 | 实际在哪 | 主题能做的 |
| --- | --- | --- |
| 页脚栏目、版权、快捷链接 | `customization.layout.footer_*` / `social_links` | 只影响它们的颜色、分隔线、圆角 |
| 导航 Tab、二级入口 | `customization.layout.nav_tabs`（`undefined` = 自动生成） | 只能通过版式变体影响版式（双栏下变居中胶囊） |
| 默认首页区块 | 代码里 `defaultHomeLayout(variant)` | 只能选变体；不能自带区块列表 |

这是刻意的边界：一份主题导入后不应该改动站点的内容与信息架构。主题作者要影响页面，只有一个杠杆——**选版式变体**，再让令牌把该变体下的所有组件都照顾好。

<a id="tokens"></a>

## 三、令牌与 CSS 变量

### 3.1 13 个令牌

主题最终只产出一张 CSS 变量表，全部组件都读这些变量，所以**主题不要写死颜色**，写令牌就行。

| 令牌键 | CSS 变量 | 语义 | 界面上的名字 |
| --- | --- | --- | --- |
| `background` | `--bg` | 全站背景 | 页面底色 |
| `ink` | `--ink` | 标题与强调文字 | 主文字 |
| `accent` | `--accent` | 链接、当前状态、焦点环 | 强调色 |
| `bg_subtle` | `--bg-subtle` | 卡片与浮层 | 卡片底 |
| `bg_sunken` | `--bg-sunken` | 输入框、代码块、次级块 | 下沉底 |
| `ink_soft` | `--ink-soft` | 文章正文 | 正文色 |
| `muted` | `--muted` | 说明与 meta | 次要文字 |
| `faint` | `--faint` | 时间、计数 | 弱化文字 |
| `line` | `--line` | 区块之间的细线 | 分隔线 |
| `line_strong` | `--line-strong` | 深色下的分层描边（1px） | 卡片描边 |
| `accent_soft` | `--accent-soft` | 强调色的低透明度底 | 强调浅底 |
| `accent_ink` | `--accent-ink` | 主色按钮 / 胶囊上的文字 | 强调色上的文字 |
| `prose` | `--prose` | 文章页正文（对比度要求最高） | 阅读正文 |

命名约定只有一条例外：**`background` 输出成 `--bg`**（全站样式消费 `--bg`，而数据模型保留语义化的 `background`）；其余键把下划线换成连字符。新增令牌时要同步 `lib/theme.ts` 的 `CSS_TOKEN_NAME` 与 `THEME_TOKEN_KEYS`。

### 3.2 解析顺序

`resolveTokens(theme, mode)` 的优先级是**预设 → 自定义推导 → 令牌覆盖**：

1. `presetTokens(theme.preset, mode)` 命中已知预设就用它（例如 `paper`、`night`，见 3.4）；
2. 没命中，用 `background` / `ink` / `accent` 三个颜色推导其余 10 个；
3. 最后把 `theme.tokens` 里通过校验的键盖上去。

第 2 步的推导公式（`deriveFromBase`，直接可抄）：

```css
--bg-subtle:   color-mix(in srgb, var(--bg) 96%, var(--ink));
--bg-sunken:   color-mix(in srgb, var(--bg) 92%, var(--ink));
--ink-soft:    color-mix(in srgb, var(--ink) 78%, var(--bg));
--muted:       color-mix(in srgb, var(--ink) 58%, var(--bg));
--faint:       color-mix(in srgb, var(--ink) 42%, var(--bg));
--line:        color-mix(in srgb, var(--ink) 10%, var(--bg));
--line-strong: color-mix(in srgb, var(--ink) 18%, var(--bg));
--accent-soft: color-mix(in srgb, var(--accent) 9%, var(--bg));
--accent-ink:  color-mix(in srgb, var(--accent) 22%, #000000);
--prose:       color-mix(in srgb, var(--ink) 88%, var(--bg));
```

### 3.3 除了令牌，`themeCss` 还会输出这些变量

| 变量 | 来源 | 能否通过主题改 |
| --- | --- | --- |
| `--article-width` | `content_width` | 能（620–900） |
| `--article-size` | `body_size` | 能（14–20） |
| `--soften-strength` / `--soften-ms` / `--soften-blur` | `soften.*`，关闭时全部为 0 | 能 |
| `--r-sm` / `--r-md` / `--r-lg` | `radius - 2` / `radius` / `min(16, radius + 4)` | 能（0–12） |
| `--r-pill` | 固定 `999px` | 不能 |
| `--shadow-hero` | 固定 `0 24px 60px -30px rgb(0 0 0 / .65)` | 不能 |
| `--shell` | 固定 `min(100%, 1760px)` | 不能（会覆盖 `styles.css` 里的 1200px 默认值） |
| `--serif` | `heading_font: "sans"` 时输出 `var(--sans)` | 只能二选一 |

**不随主题变的变量**（写死在 `styles.css` 的 `:root`）：`--danger` / `--danger-soft` / `--warn` / `--warn-soft` / `--ok` / `--ok-soft`（语义色）、`--shadow-pop`（浮层阴影）、`--sans` / `--serif` / `--mono` 的字体栈本体，以及夜航作用域里的 `--nf-*`。所以主题**改不了**错误红、成功绿、弹窗阴影和字体族——字体只有衬线 / 无衬线两档。

### 3.4 已知的预设 id

| id | 名字 | 主推模式 | 一句话 |
| --- | --- | --- | --- |
| `paper` | 纸白 | light | 白底墨字，克制的绿 |
| `sand` | 暖砂 | light | 米色纸张与赭石强调色 |
| `mist` | 雾蓝 | light | 偏冷的灰蓝底 |
| `sage` | 灰绿 | light | 带一点草色的纸面 |
| `clay` | 陶土 | light | 暖红强调色 |
| `night` | 夜航 | dark | 冷石墨 + 电光蓝，浅色为同一套设计的冷白重配 |
| `dawn` | 夜航 · 浅色 | light | 与 `night` 同一套令牌，只是主推浅色 |

注意两件事：

- **后台没有预设选择器**。预设只由内置主题与导入文件里的 `preset` 决定；你写 `"preset": "sand"` 会真的得到暖砂，但站长在界面上点不出来。
- 写了已知预设，`background` / `ink` / `accent` 三个字段就**不参与渲染**了。想让三基色生效，必须写一个未知的 `preset`（约定 `"custom"`）。

### 3.5 主题卡预览的小陷阱

「选择主题」页的主题缩略图（`ThemePreview`）直接用 `theme.background` / `theme.ink` / `theme.accent` 画，而真实站点用 `resolveTokens`。所以如果你写 `preset: "paper"` 却把 `background` 乱填成 `#101010`，**卡片看起来是黑的，站点却是纸白**。保持三个基色与预设一致，或干脆用 `custom`。

<a id="variant"></a>

## 四、版式变体

`variant` 是主题对页面结构的唯一影响，它决定三件事：首页默认编排、可选区块集合、双栏落位。

| 变体 | 界面叫法 | 首页默认编排（`defaultHomeLayout`） | 结构 |
| --- | --- | --- | --- |
| `classic` | 单栏 | `classic-hero` → `feed` → `join-band` | 单列顺序排列 |
| `bento` | 双栏 | `bento-hero` → `category-pills` → `spotlight` → `post-grid` → `author-card` → `stat-list` → `tag-cloud` → `archive` | `pp-screen-bento`：`full` 铺满，其余分主栏 / 侧栏 |
| `daylight` | 卡片 | `daylight-front` → `daylight-topics` → `daylight-stories` → `daylight-briefs` → `join-band` | 单列，`dl-` 组件；仅旧配置 |

补充规则：

- **不存在自定义变体**。`normalizeVariant` 只接受这三个值，其它任何字符串（包括新造的 `"magazine"`）一律退成 `classic`。
- 新建主题的弹窗只给「单栏 / 双栏」，`daylight` 只能从旧配置或手写 JSON 进来；写进来仍然能被读取与渲染，但主题库里不会有对应的内置匹配。
- 双栏的落位由区块的 `area` 决定（`full` / `main` / `side`），缺省按类型给默认值（`bento-hero`、`category-pills` 是 `full`；`author-card`、`tag-cloud`、`stat-list`、`archive`、`search-launcher`、`command-hints` 是 `side`；其余 `main`）。
- 变体也写到 `<html data-variant>`，所以页头、浮层这些在首页容器之外的元素也会跟着变（例如双栏下导航变成居中胶囊）。
- 「添加组件」面板按变体过滤（`availableBlocks`）：`classic` 只给 `classic` + 共享组件，`bento` 只给 `bento` + 共享组件，`daylight` 给「`daylight` 专用 + 同时属于 `classic` 和 `bento` 的通用组件」。

一个现实约束：**变体不能扩充**。你不能在主题 JSON 里声明「我的首页默认区块是这三块」——首页默认编排是代码里的 `defaultHomeLayout(variant)`，主题只能选它，不能改它（见[第六节](#coexist)）。

<a id="devices"></a>

## 五、桌面 / 平板 / 手机三端怎么表达

**主题 JSON 里没有任何设备字段。** 没有 `responsive`、没有 `breakpoints`、没有 `mobile_*`。这是刻意的：主题是站点级观感，三端差异属于编排。

真正表达三端差异的地方有三处：

### 5.1 区块的 `at` 覆盖层（P1 起的主路径）

每个区块可以有 `at.tablet` / `at.mobile`，只覆盖**展示层**，不动内容：

```json
{
  "id": "blk_x1",
  "type": "post-grid",
  "title": "文章卡网格",
  "props": { "limit": 6 },
  "animation": "fade-up",
  "hidden": false,
  "span": 8,
  "at": {
    "tablet": { "span": 12, "appearance": { "padding": 20 } },
    "mobile": { "hidden": true }
  }
}
```

`at` 里能写的键：`span`、`offset`、`appearance`、`animation`、`hidden`、`custom_css`、`width`、`height`、`align`、`gap_scale`、`mt`、`mb`。取哪一层由 `styles.css` 的媒体查询按视口决定，JS 里没有第二处阈值判断。

### 5.2 旧的 `device_split`（只读）

旧配置里可能有 `device_split: true` 与 `devices.desktop / tablet / mobile` 三棵独立区块树。读入、渲染、预览都还支持，但编排器**不再生成**它（`ThemeBuilder.tsx` 注释：P1 §5.3 起设备差异写进 `at`）。

### 5.3 CSS 断点

`lib/layout.ts` 是唯一断点来源：`BREAKPOINT_SM = 480`、`BREAKPOINT_MD = 768`、`BREAKPOINT_LG = 1024`。样式表里的三端规则与 `builderDeviceForWidth` 用同一组数字。

### 主题作者能做什么

- 选对变体（双栏在窄屏会折成单列，单栏本来就没有折叠问题）；
- 让令牌在两端都成立：深色底 + 低对比正文在手机户外屏会更糟，别把 `prose` 调到刚好及格；
- 字号 / 栏宽不要顶到上限：`body_size` 20 配 `content_width` 900 在手机上会被媒体查询压回，但 900 宽的长行在平板横屏会很难读；
- 柔化强度别开满：`strength` 接近 100 时背景光晕在窄屏会盖住内容边缘；
- **不要**指望在主题里写媒体查询——主题没有 CSS 出口。真要写响应式样式，只能改源码，或在「外观 → 自定义 CSS」里写（那是站点配置，不随主题导出）。

<a id="coexist"></a>

## 六、主题默认编排与页面编排如何共存

一句话规则：**主题给默认，编排一旦存在就覆盖，永不回退。**

数据上是两个平行字段：

| 字段 | 谁写 | 含义 |
| --- | --- | --- |
| `layout.variant` | 主题（套用 / 导入 / 创建 / 删除时） | 用哪套版式 |
| `home` | 页面编排（以及切换主题时的一次性同步） | 首页实际渲染的区块 |

### 6.1 默认值从哪来

`defaultHomeLayout(variant)` 是**代码里的常量函数**，每次调用都新建区块（`createBlock` 会生成新的随机 id）。所以默认编排不是「存在配置里的一份快照」，而是「读不到编排时现算的一份」。

读入路径（`readCustomization`）里：

```text
home = normalizeScreenLayout(raw.home)
home = home.blocks.length ? home : defaultHomeLayout(variant)
```

即：**配置里有非空编排就用配置，没有就用当前变体的默认**。

### 6.2 套用主题时的同步条件

只有一种情况主题会「接管」首页（`themeApplyPatch`）：

```text
主题 variant ≠ 当前 variant
且 当前 home 与 defaultHomeLayout(当前 variant) 等价（比较时忽略所有 id）
```

也就是说：**你排过首页，切主题就只换皮肤；你没排过，切主题连默认组件一起换。** 这条规则同样适用于创建主题与删除当前主题，**但不适用于导入主题**（导入只换 `theme` / `variant` / `active_theme`，不动 `home`）。

### 6.3 想拿回主题默认编排

三条路，效果相同、入口不同：

1. `/admin/theme` 顶部「恢复默认」→ 首页按**当前**变体重建；
2. `选择主题` → 卡片上的编辑按钮（笔形）→ 进编排台再恢复默认；
3. 「外观 → 恢复默认站点设置」勾「首页编排」。

「恢复默认」是重建，不是回退：它会把 `home` 写成一份新的默认编排（新 id），可以 `Ctrl/Cmd + Z` 撤销，但离开编排台后旧编排就没了。

### 6.4 主题作者该怎么设计

- **别把「首页该长什么样」写进主题的期望里。** 站长随时会重排；主题的价值在于让任何编排都好看——令牌覆盖得越全，编排里的组件越不容易露出硬编码色。
- **给默认编排兜底。** 至少确认三套默认编排（单栏 / 双栏 / 旧卡片）在你的配色下都可读：双栏的侧栏卡片用 `bg_subtle`，单栏的 `feed` 行用 `line` 分隔，卡片标题靠 `ink`。
- **文章页与自定义页面不读主题编排**：文章页正文列宽/字号来自 `--article-width` / `--article-size`，其余区块由 `article` 编排（或页面模板）决定。

<a id="json"></a>

## 七、从零写一个可导入的主题 JSON

### 7.1 最小示例

下面这份只写了四个字段（其余全部走缺省），是能通过 `parseThemeFile` 并真正改变站点观感的最小集合：

```json
{
  "name": "最小主题",
  "variant": "classic",
  "theme": {
    "preset": "custom",
    "background": "#faf7f2",
    "ink": "#1b1a17",
    "accent": "#b4552d"
  }
}
```

逐段解释：

- `name`：主题名。缺失时叫「导入的主题」。
- `variant`：选单栏。缺失时 `classic`。
- `theme.preset: "custom"`：**这是关键**。写任何未知值都等价；它让 `resolveTokens` 走「三基色推导」分支。如果这里写 `"paper"`，你下面三个颜色会被预设覆盖，等于白写。
- `background` / `ink` / `accent`：三个基色，必须是十六进制（3/4/6/8 位）。其余 10 个令牌会由 3.2 的公式算出。
- 没写的字段走缺省：`mode: "light"`、`heading_font: "serif"`、`body_size: 17.5`、`content_width: 720`、`radius: 6`、`soften.enabled: false`。

导入后 `themeCss` 实际产出的 `:root`（已用当前代码跑过）：

```css
:root {
  --bg: #faf7f2;
  --ink: #1b1a17;
  --accent: #b4552d;
  --bg-subtle: color-mix(in srgb, var(--bg) 96%, var(--ink));
  --bg-sunken: color-mix(in srgb, var(--bg) 92%, var(--ink));
  --ink-soft: color-mix(in srgb, var(--ink) 78%, var(--bg));
  --muted: color-mix(in srgb, var(--ink) 58%, var(--bg));
  --faint: color-mix(in srgb, var(--ink) 42%, var(--bg));
  --line: color-mix(in srgb, var(--ink) 10%, var(--bg));
  --line-strong: color-mix(in srgb, var(--ink) 18%, var(--bg));
  --accent-soft: color-mix(in srgb, var(--accent) 9%, var(--bg));
  --accent-ink: color-mix(in srgb, var(--accent) 22%, #000000);
  --prose: color-mix(in srgb, var(--ink) 88%, var(--bg));
  --article-width: 720px;
  --article-size: 17.5px;
  --soften-strength: 0;
  --soften-ms: 0ms;
  --soften-blur: 0px;
  --r-sm: 4px;
  --r-md: 6px;
  --r-lg: 10px;
  --r-pill: 999px;
  --shadow-hero: 0 24px 60px -30px rgb(0 0 0 / .65);
  --shell: min(100%, 1760px);
}
```

### 7.2 完整示例

要交一套「能直接卖」的主题，至少把这些都写全：

```json
{
  "kind": "pp-theme",
  "version": 1,
  "name": "青灰双栏",
  "note": "冷灰双栏，适合摄影与长文混排。",
  "variant": "bento",
  "theme": {
    "preset": "custom",
    "mode": "dark",
    "background": "#0e1114",
    "ink": "#eef1f4",
    "accent": "#5ac8b0",
    "heading_font": "sans",
    "body_size": 18,
    "content_width": 760,
    "radius": 10,
    "tokens": {
      "bg_subtle": "color-mix(in srgb, var(--bg) 94%, var(--ink))",
      "line": "color-mix(in srgb, var(--ink) 12%, var(--bg))"
    },
    "soften": {
      "enabled": true,
      "strength": 60,
      "transition_ms": 300,
      "gradient": true,
      "blend_components": true,
      "blur": 12
    }
  },
  "appearance": { "sections": ["hero", "branding", "custom_css"] }
}
```

逐段解释：

| 片段 | 作用 |
| --- | --- |
| `kind` / `version` | 约定字段。导入不校验，但请保留，方便将来市场与备份工具识别 |
| `name` / `note` | 主题库卡片上显示的名字与一句话说明 |
| `variant: "bento"` | 选双栏。导入后「添加组件」面板只给双栏可用的区块 |
| `preset: "custom"` + 三个基色 | 冷灰底、近白字、青色强调；10 个派生令牌自动算 |
| `mode: "dark"` | 新访客默认看到深色；访客仍可自己切浅色，但 `custom` 没有第二套令牌，浅色只会改 `data-mode` 作用域里的少数固定规则 |
| `heading_font: "sans"` | 标题走无衬线，`--serif` 被指向 `--sans` |
| `body_size: 18` / `content_width: 760` | 阅读列比默认宽一点、字大一点 |
| `radius: 10` | `--r-sm 8` / `--r-md 10` / `--r-lg 14`，卡片和按钮都变圆 |
| `tokens.bg_subtle` | 覆盖推导值，把卡片压得更贴近底色（94% 而不是 96%） |
| `tokens.line` | 分隔线稍微亮一点（12% 而不是 10%） |
| `soften` | 开启柔化：60 强度、300ms 过渡、12px 页头模糊、柔光与混色都开 |
| `appearance.sections` | 「外观」页只显示首屏、品牌副标题与自定义 CSS 三块；公告条被隐藏（数据不丢） |

### 7.3 在已知预设上做小改

这是最常见的场景：想要夜航的整套令牌，只把分隔线调亮。

```json
{
  "name": "夜航 · 亮线",
  "variant": "bento",
  "theme": {
    "preset": "night",
    "mode": "dark",
    "background": "#0b0d11",
    "ink": "#f2f4f8",
    "accent": "#6e9bff",
    "tokens": { "line": "#2a3140", "line_strong": "#3a4354" }
  }
}
```

三个基色在这里不参与渲染，但**要和预设一致**——主题卡预览用的是它们（见 3.5）。`tokens` 里的两个值都是十六进制，能通过白名单。

### 7.4 三种可导入的形态

`parseThemeFile` 不是只认自己的导出格式，它接受三种：

| 形态 | 必需结构 | `variant` 从哪读 | `name` 从哪读 |
| --- | --- | --- | --- |
| 主题导出文件（推荐） | 顶层 `theme` | `variant` → `layout_variant` → `layout.variant` | `name` → `site` |
| 完整站点设计导出 | `customization.theme` | 同上（含 `customization.layout.variant`） | 同上 |
| 手写的最小对象 | 顶层 `theme` | 缺省 `classic` | 缺省「导入的主题」 |

第三种形态只要求 `theme` 是个对象：

```json
{ "theme": { "preset": "custom", "background": "#101014", "ink": "#f4f4f6", "accent": "#8b7bff" } }
```

从完整站点设计导出里导入时，**只取主题**：`pages`、`home`、`layout.nav_tabs`、`custom_css`、文章都不会被读进来。`appearance` 只从**顶层**读，所以把分区声明藏在 `customization.appearance` 里不会生效。

### 7.5 导入那一刻发生了什么

1. 生成新的主题 id（文件里的 `id` 忽略）；
2. `name` / `note` 截断，`variant` 归一化，`theme` 走 `normalizeThemeSettings`，`appearance` 走 `normalizeAppearance`；
3. 进确认弹窗；确认后写入 `customization.themes`、整份替换 `theme`、切 `layout.variant`、设 `active_theme`；
4. **不动 `home`**（与点卡片套用不同）；
5. 保存到服务端站点设计（自动防抖，1 MiB 上限）。

<a id="validation"></a>

## 八、校验与限制

### 8.1 令牌值的白名单

每个令牌值都会被拼进 `:root { --token: VALUE; }`，所以只放行三种形状，**整串匹配**，不做修补：

| 放行 | 例子 |
| --- | --- |
| 十六进制颜色 3/4/6/8 位 | `#fff`、`#ffff`、`#ffffff`、`#ffffffff` |
| 裸变量引用 | `var(--bg)`、`var(--accent-soft)` |
| 指定函数式颜色 | `color-mix(...)`、`rgb(...)`、`rgba(...)`、`hsl(...)`、`hsla(...)` |

拒绝的情况（任何一条命中就丢掉这个键，退回上一层解析结果）：

- 出现 `;`、`{`、`}`、`<`、`>`、引号、反斜杠、`@`——防止提前闭合声明块注入任意全局 CSS；
- 含 `url(`、`!important`、`/*`——即使字符都合法也挡；
- `var()` 带兜底值（`var(--bg, #fff)`）；
- 括号不配平、出现多余的 `)`；
- 命名颜色（`red`）、位数不对的十六进制（`#fffff`）、未知函数（`expression(...)`）；
- 超过 **120 字符**；
- 非字符串（数字、`null`、数组）。

被拒的值不会报错，只会在 `normalizeThemeTokens` 里被丢掉；如果 13 个键全被丢，`tokens` 变成 `undefined`。

### 8.2 数值与枚举

| 字段 | 越界处理 |
| --- | --- |
| `body_size` | 夹到 14–20，按 0.5 取整；非数字退回 17.5 |
| `content_width` | 夹到 620–900，四舍五入取整 |
| `radius` | 夹到 0–12，取整 |
| `soften.strength` / `transition_ms` / `blur` | 分别夹到 0–100 / 0–1200 / 0–24 |
| `mode` | 只有 `"dark"` 被接受，其余（含 `"neon"`）一律 `"light"` |
| `heading_font` | 只有 `"sans"` 被接受，其余 `"serif"` |
| `variant` | 只有 `classic` / `bento` / `daylight`，其余 `classic` |
| `appearance.sections` | 只保留四个合法 id，去重，未知项丢弃；空数组合法（= 外观页什么都不显示） |

### 8.3 未知字段

全部**静默忽略**，不报错、不写回。这意味着：

- 拼错字段名（`"softening"`、`"articleWidth"`）不会报错，只会「什么都没发生」——排错时优先怀疑拼写；
- 别的版本导出的新字段不会破坏导入，但也带不进来；
- 文件里塞 `pages`、`home`、`custom_css` 既不会生效，也不会被拒绝（与主题市场规格里「必须拒绝额外字段」的要求不一致，以代码为准）。

### 8.4 id、名称与数量

| 限制 | 值 | 行为 |
| --- | --- | --- |
| 自定义主题总数 | 20 | 创建 / 导入 / 另存会被拒；读取时超过 20 条直接截断 |
| 主题名 | ≤40 字 | 超出截断；创建时重名报错，另存与导入不查重 |
| 备注 | ≤160 字 | 超出截断 |
| `preset` | ≤40 字符 | 超出截断 |
| id 格式 | `^[a-z0-9][a-z0-9_-]*$/i` | 不合规重新生成；与内置主题撞名改成 `custom_<id>` |

### 8.5 体积上限

- 主题文件本身**没有独立的字节上限**，解析是整串 `JSON.parse`；
- 但主题最终存进站点设计文档，而整份文档受服务端 **1 MiB** 限制（`site.MaxCustomizationBytes`），前端另有 512 KiB 软警告线；
- 所以一套塞满 20 个主题的站点设计仍然可能超限。主题里只放令牌，别塞 base64 图片。

### 8.6 主题做不了的事（安全边界）

- 不能写自定义 CSS（`custom_css` 不在 `SiteTheme` 里）；
- 不能写 HTML / JS / 字体文件；
- 不能改 `--danger` / `--warn` / `--ok` 等语义色；
- 不能改后台与安装向导的外观（它们有自己的 `data-surface` 令牌）；
- 不能改社交抓取器看到的 meta（见 [03](./03-appearance.md#meta)）；
- 不能在导入时「顺手」改文章、页面、导航、页脚——这些字段根本不会进入解析结果。

<a id="checklist"></a>

## 九、作者自查清单

发布一套主题前，逐条过：

- [ ] `preset` 要么是已知 id，要么是 `"custom"`；如果是 `"custom"`，三个基色都是合法十六进制。
- [ ] 三个基色与 `preset` 一致（否则主题卡预览会骗人）。
- [ ] 13 个令牌不用全写，但 `bg_subtle` 与 `bg` 在深色下能区分（不然卡片会糊在背景里），`prose` 与 `background` 的对比度够。
- [ ] `body_size` 在 14–20、`content_width` 在 620–900、`radius` 在 0–12。
- [ ] `tokens` 里没有 `url(`、`!important`、命名颜色、带兜底的 `var()`。
- [ ] `variant` 是 `classic` 或 `bento`（除非确实要交付旧的白昼版式）。
- [ ] `appearance.sections` 只写四个合法 id；想全开就别写这个字段。
- [ ] 名称 ≤40 字、备注 ≤160 字，且名称不与其他自定义主题重复。
- [ ] 用「导入主题」真导一次，确认预览卡片的配色、版式、深浅色都对。
- [ ] 导入后去看一眼首页与文章页：双栏注意侧栏卡片，单栏注意 `feed` 的分隔线与行距。
- [ ] 在「主题设置 → 高级主题令牌」里检查一遍解析结果（每行右侧 `code` 就是最终生效值）。
- [ ] 打开「主题设置 → 文章外观」（仅双栏可见）确认「封面在上 / 模糊背景」两套外观都不难看。
- [ ] 预期被主题隐藏的外观分区，在「外观」页确实消失了，且数据没丢。
