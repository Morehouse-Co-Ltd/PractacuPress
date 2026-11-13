# 页面自定义强化 · 实施计划（按钮 / 思维导图 / 通用外观）

日期：2026-11-01  
状态：已完成（W1–W5 全部完成，验收记录见设计文档 §7）  
设计：`docs/superpowers/specs/2026-11-01-page-customization-blocks-design.md`

> **2026-11-01 修订**：思维导图已从页面编排迁到文章写作（见
> `2026-11-01-article-diagrams-plan.md`）。本计划中的 W2（思维导图区块）作废，
> 通用外观与按钮部分继续有效。

## 工作流（写作用域互不重叠）

| 编号 | 承担 | 写作用域 | 依赖 |
| --- | --- | --- | --- |
| W1 基础层 | Lead | `types.ts`、`lib/blockAppearance.ts`、`lib/safeUrl.ts`、`lib/customize.ts`、`lib/blocks.ts`、`components/blocks/index.tsx`、`components/blocks/MediaBlocks.tsx`、`components/builder/BlockInspector.tsx`、`components/builder/BlockProps.tsx`、`components/builder/BlockTreeEditor.tsx`、`styles.css`、相关 i18n 片段、README/docs | — |
| W2 思维导图 | teammate `mindmap` | `lib/mindmap.ts`、`lib/mindmap.test.ts`、`components/blocks/DiagramBlocks.tsx`、`lib/i18n/dict/fragments/components_blocks_DiagramBlocks.ts` | 可并行（按契约） |
| W3 按钮 | teammate `buttons` | `components/blocks/ActionBlocks.tsx`、`lib/i18n/dict/fragments/components_blocks_ActionBlocks.ts` | 可并行（按契约） |
| W4 验收 | teammate `verifier` | `apps/web/scripts/e2e-builder-blocks.mjs` | W1–W3 完成后运行 |

## W1 基础层任务

1. `types.ts`：`BlockRadius/BlockShadow/BlockCrop/BlockAppearance`，`BlockInstance.appearance?`。
2. `lib/blockAppearance.ts`：预设目录（`liveCatalog` 实时翻译）、`normalizeBlockAppearance`、`blockAppearanceCss`、内边距范围常量。
3. `lib/safeUrl.ts`：抽出 `safeUrl`（http(s) / 站内绝对路径），`MediaBlocks` 复用它。
4. `lib/customize.ts`：`normalizeBlock` 合并 appearance；损坏值丢弃。
5. `components/blocks/index.tsx`：`BlockView` 应用 appearance，注册 `ACTION_RENDERERS`、`DIAGRAM_RENDERERS`。
6. `lib/blocks.ts`：追加 `button`、`mindmap` 定义；`itemFields` 支持 `select` + `options`。
7. `components/builder/BlockProps.tsx`：itemlist 行内渲染 select。
8. `components/builder/BlockInspector.tsx`：新增「外观」分组（圆角/阴影/裁剪/背景色/内边距/主题描边，全部带 id 便于 e2e）。
9. `components/builder/BlockTreeEditor.tsx`：`button → content`、`mindmap → data`。
10. `styles.css`：按钮、思维导图、外观相关类（见 DOM 契约）。
11. i18n 片段：`lib_blocks.ts`、`lib_blockAppearance.ts`、`components_builder_BlockInspector.ts`。
12. README 功能清单补一句；本计划与设计文档落盘。

## 契约（W2/W3 直接按此实现）

### 按钮 DOM

```html
<div class="pp-action-buttons pp-action-left">
  <a class="pp-action-btn is-solid is-md" href="/articles">开始阅读</a>
  <span class="pp-action-btn is-outline is-md" aria-disabled="true">…</span>
</div>
```

导出：`components/blocks/ActionBlocks.tsx` → `export const ACTION_RENDERERS = { button: ButtonBlock }`。

### 思维导图 DOM

```html
<section class="pp-mindmap">
  <h2 class="pp-mindmap-title">标题（可空）</h2>
  <svg class="pp-mindmap-svg" role="img" viewBox="0 0 900 420">
    <path class="pp-mm-edge" d="…"/>
    <g class="pp-mm-node is-root"><rect …/><text …>中心主题</text></g>
  </svg>
</section>
```

导出：`components/blocks/DiagramBlocks.tsx` → `export const DIAGRAM_RENDERERS = { mindmap: MindMapBlock }`。

### 思维导图引擎 API

```ts
export interface MindMapNode { label: string; depth: number; children: MindMapNode[] }
export interface MindMapLayoutNode {
  key: string; label: string; depth: number;
  x: number; y: number; w: number; h: number;
  fontSize: number; branch: number; // branch 用于配色
}
export interface MindMapEdge { key: string; d: string; branch: number }
export interface MindMapLayout { nodes: MindMapLayoutNode[]; edges: MindMapEdge[]; width: number; height: number }
export const MINDMAP_LIMITS: { nodes: number; depth: number; label: number };
export function parseMindMapOutline(outline: string): MindMapNode | null;
export function layoutMindMap(root: MindMapNode, options?: { layout?: 'both' | 'right'; line?: 'curve' | 'elbow' }): MindMapLayout;
```

## 验收

- `cd apps/web; npm run typecheck; npm test; npm run build; npm run i18n:audit`
- `node scripts/serve.mjs --port 8099` 后运行 `node scripts/e2e-builder-blocks.mjs`（PP_E2E_BASE 指到 8099），断言：组件库出现两个组件、预览出现按钮与 SVG 节点、外观（border-radius / box-shadow / overflow + aspect-ratio）落到 `section[data-pp-block]`、刷新后配置仍在、截图落 `.tmp/shots-builder/`。
- Lead 最终 `git diff` 审查 + 手动跑一次上述命令。
