# 页面自定义强化 · 设计规格（按钮 / 思维导图 / 通用外观）

日期：2026-11-01  
状态：已实现并通过验收  
范围：`apps/web` 的页面编排器、区块注册表与渲染；不动后端契约与鉴权。

> **2026-11-01 修订**：思维导图不属于站点版面，已从页面编排迁到**文章写作**（设计见
> `2026-11-01-article-diagrams-design.md`）。本轮的通用外观与按钮保持有效；下文 §3.3 的
> 「思维导图区块」作废，`lib/mindmap.ts` 引擎改为被文章图表复用。

## 1. 背景与目标

页面编排已经有 20 多个区块、递归容器、三端独立布局与思维链，但仍有三个缺口：

1. **没有按钮**：行动号召只能借用文本块里的链接或固定模板，无法自由配色/描边/尺寸；
2. **没有图示类组件**：思维导图这类「结构化信息」只能拆成列表或手写 HTML；
3. **组件缺少通用外观**：圆角、阴影、裁剪只能靠 `custom_css` 手写声明，普通站长找不到入口。

本轮在**不引入任何运行时依赖、不改后端契约**的前提下补齐这三件事。

## 2. 非目标

- 不做任意绝对定位的自由画布（与「区块树 + 三端独立编排」的既定模型冲突）；
- 不引入第三方图表/思维导图/UI 库；
- 不执行用户提供的后端代码（站点设计仍是 1 MiB 以内的不透明 JSON，安全边界不变）；
- 不重做主题中心，不改既有区块的默认观感与数据结构。

## 3. 数据模型

### 3.1 通用外观

`BlockInstance` 增加一个可选对象，全部字段都是**受限枚举或标量**，随区块一起序列化：

```ts
export type BlockRadius = 'none' | 'sm' | 'md' | 'lg' | 'xl' | 'full';
export type BlockShadow = 'none' | 'sm' | 'md' | 'lg' | 'glow';
export type BlockCrop = 'none' | 'clip' | '16:9' | '4:3' | '3:2' | '1:1' | '2:1';

export interface BlockAppearance {
  radius?: BlockRadius;
  shadow?: BlockShadow;
  /** clip = 裁掉溢出；比例 = aspect-ratio + 裁掉溢出（相框裁剪）。 */
  crop?: BlockCrop;
  /** #rgb / #rrggbb / #rrggbbaa；其余一律丢弃。 */
  background?: string;
  /** 0–64 px。 */
  padding?: number;
  /** 主题细分割线描边。 */
  border?: boolean;
}

export interface BlockInstance {
  // …既有字段
  appearance?: BlockAppearance;
}
```

语义：

| 字段 | 落点 | 说明 |
| --- | --- | --- |
| `radius` | 最外层 `<section class="pp-block">` 的 `border-radius` | 档位换算：sm 8 / md 12 / lg 16 / xl 24 / full 999（px） |
| `shadow` | 同层 `box-shadow` | 用 `color-mix(in srgb, var(--ink) …)` 与 `var(--accent)`，明暗主题自适应 |
| `crop` | 同层 `overflow` / `aspect-ratio` | 比例档位同时设置 `overflow: hidden`；文字块慎用固定比例（面板里有提示） |
| `background` | 同层 `background-color` | 空 = 透明 |
| `padding` | 同层 `padding` | 0 = 不额外留白；配合背景可当卡片 |
| `border` | 同层 `border` | `1px solid var(--line)` |

应用顺序（后者覆盖前者）：`width/height` → `appearance` → `custom_css`。既有的手写声明仍然有最终话语权，旧配置零迁移。

### 3.2 按钮区块（`button`）

- `props.buttons` 存 itemlist JSON（1–4 个）：`label`、`link`、`style`（solid / outline / ghost / link）；
- 全局：`align`（left/center/right）、`size`（sm/md/lg）、`new_tab`；
- 链接只接受 `http(s)://` 或 `/` 开头的站内路径，其余丢弃；外链 `target=_blank` + `rel="noreferrer noopener"`；无合法链接时渲染不可点击的 `<span aria-disabled>`；
- 为支持逐项样式，`PropSchema.itemFields` 扩展 `type?: 'text' | 'color' | 'select'`（附 `options`），属性表单自动生成 select。

### 3.3 思维导图区块（`mindmap`）

- `props.outline`：缩进大纲文本，第一行是中心主题；两个空格或 Tab 表示下一层；允许 `-`/`*`/`#` 前缀；
- `props.layout`（both / right）、`props.line_style`（curve / elbow）、`props.palette`（colorful / theme）；
- 纯函数引擎 `lib/mindmap.ts`：
  - `parseMindMapOutline(outline)`：限制 80 节点、深度 6、单标签 60 字，坏数据返回 `null`；
  - `layoutMindMap(root, { layout, line })`：tidy-tree 布局，输出节点矩形、贝塞尔/折线路径与画布尺寸；两侧展开时按子树高度平衡分配左右；
- 渲染为**纯 SVG**（主题令牌 + `fill-opacity`，明暗自适应），`useMemo` 记忆化；无定时器、无事件监听、无新依赖；
- 无障碍：`role="img"` + `aria-label` + `<title>`。

### 3.4 契约与接线

- 注册表 `lib/blocks.ts` 追加两个 `BlockDefinition`（定义里所有中文走 `t()`，由 `liveCatalog` 实时翻译）；
- 渲染器分别落在 `components/blocks/ActionBlocks.tsx`、`components/blocks/DiagramBlocks.tsx`，在 `components/blocks/index.tsx` 注册；
- 组件库分组：按钮 → 内容，思维导图 → 数据与代码；
- 归一化 `lib/customize.ts` 增加 appearance 校验；未知枚举/坏色值直接丢弃，不报错；
- i18n：新增文案全部补英文片段（`lib/i18n/coverage.test.ts` 是硬闸门）。

## 4. 性能与安全

- **零新增依赖**：前端仍只有 react / react-dom / react-router-dom；
- 思维导图渲染成本 O(n) 且只在 outline/布局参数变化时重算，上限 80 节点；SVG 节点数 = 节点 + 连线，远低于一次列表请求；
- 外观全部是内联样式，不生成全局 `<style>`，不影响其他区块；
- 继续沿用既有 URL 白名单与「只写声明」的作用域 CSS 规则；不新增任何 HTML 注入点；
- 后端无需改动：`GET/PUT /sites/{siteID}/customization` 对文档按对象 + 1 MiB 校验并原样保存，新区块天然兼容。

## 5. 验收标准

1. 组件库能看到「按钮」「思维导图」，点击/拖入即可在真实预览里出现；
2. 按钮的文案、链接、样式、对齐、尺寸、新窗口打开可改，外链带 `noopener`；
3. 思维导图按缩进大纲渲染，两侧/向右、曲线/折线、彩色/单色可切换，深色主题下文字可读；
4. 任意区块可设圆角、阴影、裁剪、背景、内边距、描边，刷新/换设备后保持；
5. 旧配置不白屏、既有区块观感不变；`custom_css` 仍可覆盖外观；
6. `tsc --noEmit`、`vitest run`、`vite build`、i18n 覆盖率测试全部通过；
7. 无头浏览器验收脚本截图证明上述 1–4。

## 6. 测试

- 单测：`blockAppearance` 归一化/样式映射；`mindmap` 解析（缩进、列表符号、上限）与布局（节点边界、连线数、两侧分配）；`customize` 对坏 appearance 的收敛；
- 浏览器：`apps/web/scripts/e2e-builder-blocks.mjs`（复用现有 CDP 零依赖方案）走演示站点 → 页面编排 → 添加两个区块 → 改外观 → 断言计算样式与截图。

## 7. 验证记录（2026-11-01）

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 错误 |
| `npx vitest run` | 31 文件 / 352 测试通过（含 i18n 覆盖率闸门） |
| `npm run i18n:audit` | 覆盖率 96.3%，本轮新增文案全部已包裹并有英文 |
| `npm run build` | 304 modules；dist 1,712,138 B（基线 1,691,021 B，+21 KB / +1.25%；gzip 378.9 → 384.6 KB） |
| `node scripts/e2e-builder-blocks.mjs` | PASS 36 / FAIL 0：按钮与导图渲染、外观计算样式、落盘与刷新保持全通过；截图在 `apps/web/.tmp/shots-builder/` |

结论：无新增运行时依赖，后端未改动，构建体积增量约 1.25%，满足「性能高、不臃肿、不背离初心」的约束。
