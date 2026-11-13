# Web Task 2 review package

## Commits

2775d8f fix(web): paint nothing for blocks from a newer schema
f8515d3 fix(web): keep unknown block types and drop the silent root-level cap

## Diff (4 files; CONTAINS FOREIGN WIP - see scope note)

diff --git a/apps/web/src/components/blocks/index.tsx b/apps/web/src/components/blocks/index.tsx
index 671e6b8..0e27053 100644
--- a/apps/web/src/components/blocks/index.tsx
+++ b/apps/web/src/components/blocks/index.tsx
@@ -1,29 +1,38 @@
-import { useEffect, useRef, useState, type ReactElement } from 'react';
+import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
 import type {
   BlockArea,
   BlockInstance,
   BuilderDevice,
   LayoutVariant,
   ScreenLayout,
 } from '../../types';
 import { builderDeviceForWidth, resolveArea, screenBlocksForDevice } from '../../lib/blocks';
+import { hasBoundProps, resolveBoundProps } from '../../lib/blocksData';
+import { blockAppearanceCss } from '../../lib/blockAppearance';
 import { useInView } from '../../lib/hooks';
 import { playBlockAnimation } from '../../lib/blockAnimations';
 import { styleDeclarations } from '../../lib/blockStyles';
 import { motionReduced } from '../../lib/performance';
+import { BLOCK_SKELETON_SHAPES } from '../../lib/loading';
 import { useT } from '../../lib/i18n';
+import { usePageSkeleton } from '../SkeletonMode';
+import { useFeed } from './FeedContext';
+import { useBlockDataContext } from './ArticleContext';
+import { BlockSkeleton } from './BlockSkeleton';
 import { CLASSIC_RENDERERS } from './Classic';
 import { NIGHT_RENDERERS } from './Nightflight';
 import { CONTENT_RENDERERS } from './ContentBlocks';
 import { ColumnsBlock, ContainerBlock } from './LayoutBlocks';
 import { MEDIA_RENDERERS } from './MediaBlocks';
 import { DATA_RENDERERS } from './DataBlocks';
 import { ENGAGE_RENDERERS } from './EngageBlocks';
+import { ACTION_RENDERERS } from './ActionBlocks';
+import { ARTICLE_RENDERERS } from './ArticleBlocks';
 import { ScreenScopeProvider, type ScreenScope } from './ScreenScope';
 
 /**
  * 界面渲染器：把一份组件编排画出来。
  *
  * - 每个区块包一层 <section data-pp-block="id">，思维链通过这个属性找到它；
  * - 入场动画是 CSS 类（transform/opacity），首次进入视口时播放一次；
  * - prefers-reduced-motion 时自动降级（见 styles.css）；
@@ -35,62 +44,89 @@ import { ScreenScopeProvider, type ScreenScope } from './ScreenScope';
 
 const RENDERERS: Record<string, (props: { block: BlockInstance }) => ReactElement | null> = {
   ...CLASSIC_RENDERERS,
   ...NIGHT_RENDERERS,
   ...CONTENT_RENDERERS,
   ...MEDIA_RENDERERS,
   ...DATA_RENDERERS,
   ...ENGAGE_RENDERERS,
+  ...ACTION_RENDERERS,
+  ...ARTICLE_RENDERERS,
 };
 
 function BlockView({ block, area }: { block: BlockInstance; area?: BlockArea }) {
+  // 未知类型的区块（新版本导出的设计）仍保留在持久化数据里，避免被静默销毁，
+  // 但绝不能画出来——包括外层 <section> 的边距和间距，否则访客会看到一块空档。
+  // 这里在 hooks 之前提前 return：同一次挂载期间 unsupported 不会变（由规范化只写一次），
+  // 提前返回不会造成 hooks 调用顺序在多次渲染间变化，因此是安全的。
+  if (block.unsupported === true) return null;
   const ref = useRef<HTMLElement>(null);
   const seen = useInView(ref);
-  const Renderer = RENDERERS[block.type];
-  const isColumns = block.type === 'columns';
-  const isContainer = block.type === 'container';
-  const anim = block.animation && block.animation !== 'none' ? block.animation : '';
-  const visibleChildren = (block.children ?? []).filter((child) => !child.hidden);
+  const motion = usePageSkeleton();
+  const feed = useFeed();
+  const dataContext = useBlockDataContext();
+  // 组件文字可以绑定「显示什么数据」：在这里统一解析一次，所有渲染器都拿到
+  // 已经换成真实数据的 props，不用逐个改渲染器。没有绑定时沿用原对象，避免
+  // 每次渲染都产生新 props 触发子树重算。
+  const displayBlock = useMemo(
+    () =>
+      hasBoundProps(block.props)
+        ? { ...block, props: resolveBoundProps(block, dataContext) }
+        : block,
+    [block, dataContext],
+  );
+  const Renderer = RENDERERS[displayBlock.type];
+  const isColumns = displayBlock.type === 'columns';
+  const isContainer = displayBlock.type === 'container';
+  const anim = displayBlock.animation && displayBlock.animation !== 'none' ? displayBlock.animation : '';
+  const visibleChildren = (displayBlock.children ?? []).filter((child) => !child.hidden);
   const hasNestedLayer = !isColumns && !isContainer && visibleChildren.length > 0;
+  // 骨架模式 + 内容还在加载 + 该区块依赖 FeedContext：外壳保留，内部只画骨架。
+  // 未登记的类型（标题/文本/按钮/hero 等）照常渲染，不会把能立刻显示的内容藏起来。
+  const skeletonShape = motion && feed.loading ? BLOCK_SKELETON_SHAPES[displayBlock.type] : undefined;
 
   useEffect(() => {
     if (!seen || !anim || !ref.current || motionReduced()) return;
     playBlockAnimation(ref.current, anim);
   }, [seen, anim]);
 
   return (
     <section
       ref={ref}
       className={`pp-block${hasNestedLayer ? ' has-nested-layer' : ''}${
         seen && anim ? ` pp-anim pp-anim-${anim} is-in` : ''
       }${anim ? ' pp-anim-ready' : ''}`}
-      data-pp-block={block.id}
-      data-block-type={block.type}
+      data-pp-block={displayBlock.id}
+      data-block-type={displayBlock.type}
       data-block-area={area}
-      aria-label={block.title || undefined}
+      aria-label={displayBlock.title || undefined}
       style={{
-        width: block.width ? `${block.width}px` : undefined,
-        minHeight: block.height ? `${block.height}px` : undefined,
+        width: displayBlock.width ? `${displayBlock.width}px` : undefined,
+        minHeight: displayBlock.height ? `${displayBlock.height}px` : undefined,
         maxWidth: '100%',
-        ...styleDeclarations(block.custom_css),
+        // 预设外观先落，手写 CSS 后落：高级用户永远可以覆盖面板里的选择。
+        ...blockAppearanceCss(displayBlock.appearance),
+        ...styleDeclarations(displayBlock.custom_css),
       }}
     >
-      {isColumns ? (
-        <ColumnsBlock block={block} renderChild={(child) => <BlockView key={child.id} block={child} />} />
+      {skeletonShape ? (
+        <BlockSkeleton block={displayBlock} shape={skeletonShape} />
+      ) : isColumns ? (
+        <ColumnsBlock block={displayBlock} renderChild={(child) => <BlockView key={child.id} block={child} />} />
       ) : isContainer ? (
         <ContainerBlock>
           {visibleChildren.map((child) => (
             <BlockView key={child.id} block={child} />
           ))}
         </ContainerBlock>
       ) : Renderer ? (
-        <Renderer block={block} />
+        <Renderer block={displayBlock} />
       ) : null}
-      {hasNestedLayer ? (
+      {!skeletonShape && hasNestedLayer ? (
         <div className="pp-nested-layer">
           {visibleChildren.map((child) => (
             <BlockView key={child.id} block={child} />
           ))}
         </div>
       ) : null}
     </section>
   );
diff --git a/apps/web/src/lib/customize.ts b/apps/web/src/lib/customize.ts
index 54bfa1f..6abfac8 100644
--- a/apps/web/src/lib/customize.ts
+++ b/apps/web/src/lib/customize.ts
@@ -37,17 +37,18 @@ import {
   type ThemePreset,
 } from './theme';
 import {
   BUILTIN_THEME_IDS,
   inferActiveTheme,
   normalizeCustomTheme,
 } from './themes';
 import { BLOCK_TYPES, blockDef, createBlock, defaultHomeLayout, nextBlockId } from './blocks';
-import { MAX_BLOCKS, MAX_BLOCK_DEPTH, clampColumn, countBlocks } from './blockTree';
+import { normalizeBlockAppearance } from './blockAppearance';
+import { MAX_BLOCKS, MAX_BLOCK_DEPTH, MAX_CHILDREN_PER_CONTAINER, clampColumn, countBlocks } from './blockTree';
 import {
   defaultFooterColumns,
   normalizeFooterColumns,
   normalizeNavTabs,
   normalizeSocialLinks,
 } from './navigation';
 import { DEFAULT_PERMISSIONS, normalizePermissions } from './permissions';
 import { t } from './i18n';
@@ -215,16 +216,142 @@ function normalizeCovers(value: unknown): ArticleCover[] {
       ...(text(entry.alt, '', 160) ? { alt: text(entry.alt, '', 160) } : {}),
       ...(position ? { position } : {}),
       ...(hidden ? { hidden: true } : {}),
     });
   }
   return covers;
 }
 
+/* ------------------------------------------------------------------ *
+ * 自定义 CSS 的内容校验
+ * ------------------------------------------------------------------ */
+
+/** 自定义 CSS 长度上限（服务端同名字段按「高危串 + 长度」再做一次校验）。 */
+export const MAX_CUSTOM_CSS_CHARS = 20_000;
+
+/**
+ * 自定义 CSS 里不能出现的高危构造。
+ *
+ * H-1 之后这份样式会被服务端分发给每个访客（`SiteChrome` 原样放进 `<style>`），
+ * 所以它必须只是样式：`@import` 与 `url()` 里的脚本/HTML 协议会把样式变成外联或
+ * 执行面。匹配前按 CSS 解析器的顺序规范化（去注释 → 解转义 → 去空白 → 小写），
+ * 否则在 `@im` 与 `port` 中间夹一段注释、或用 `\40 import` 这类转义写法，
+ * 都能绕过按字面量匹配的检查。
+ *
+ * 只拦高危串：`url(https://…)`、`position: fixed`、`@media` 等合法样式必须保留，
+ * 所以这里不做整体白名单。
+ */
+const HIGH_RISK_CSS_PATTERNS: [string, RegExp][] = [
+  ['@import', /@import/],
+  ['expression(', /expression\(/],
+  ['behavior:', /behavior:/],
+  ['-moz-binding', /-moz-binding/],
+  ['url(javascript:', /url\(["']?javascript:/],
+  ['url(data:text/', /url\(["']?data:text\//],
+];
+
+const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;
+const CSS_ESCAPE = /\\([0-9a-fA-F]{1,6}\s?|.)/g;
+
+/** 解析 CSS 转义：`\2f` 这样的十六进制转义与 `\x` 单字符转义。 */
+function decodeCssEscapes(value: string): string {
+  return value.replace(CSS_ESCAPE, (_match: string, body: string) => {
+    const trimmed = body.trim();
+    if (!trimmed) return body;
+    const code = Number.parseInt(trimmed, 16);
+    if (!Number.isFinite(code)) return body;
+    if (code < 0 || code > 0x10ffff) return '\ufffd';
+    return String.fromCodePoint(code);
+  });
+}
+
+function normalizeCssForScan(value: string): string {
+  return decodeCssEscapes(value.replace(CSS_COMMENT, ''))
+    .toLowerCase()
+    .replace(/[\s\u0000-\u001f\u007f]/g, '');
+}
+
+/** 命中的高危构造文案；没有命中返回空串（测试与导入提示共用）。 */
+export function highRiskCustomCssMarker(value: unknown): string {
+  if (typeof value !== 'string' || !value) return '';
+  const normalized = normalizeCssForScan(value);
+  for (const [marker, pattern] of HIGH_RISK_CSS_PATTERNS) {
+    if (pattern.test(normalized)) return marker;
+  }
+  return '';
+}
+
+/**
+ * 把样式表切成顶层规则：到顶层的 `;`（@import 这类语句）或配平的 `{...}`（普通规则
+ * 与 @media 等块）为止。引号、注释里的符号不参与配平。
+ */
+function splitTopLevelCssRules(source: string): string[] {
+  const rules: string[] = [];
+  let start = 0;
+  let depth = 0;
+  let quote = '';
+  let index = 0;
+  while (index < source.length) {
+    const char = source[index];
+    if (quote) {
+      if (char === '\\') {
+        index += 2;
+        continue;
+      }
+      if (char === quote) quote = '';
+      index += 1;
+      continue;
+    }
+    if (char === '"' || char === "'") {
+      quote = char;
+      index += 1;
+      continue;
+    }
+    if (char === '/' && source[index + 1] === '*') {
+      const end = source.indexOf('*/', index + 2);
+      index = end === -1 ? source.length : end + 2;
+      continue;
+    }
+    if (char === '{') {
+      depth += 1;
+    } else if (char === '}') {
+      depth = Math.max(0, depth - 1);
+      if (depth === 0) {
+        rules.push(source.slice(start, index + 1));
+        start = index + 1;
+      }
+    } else if (char === ';' && depth === 0) {
+      rules.push(source.slice(start, index + 1));
+      start = index + 1;
+    }
+    index += 1;
+  }
+  if (start < source.length) rules.push(source.slice(start));
+  return rules.map((rule) => rule.trim()).filter(Boolean);
+}
+
+/**
+ * 读入 / 导出时使用的自定义 CSS 规范化：含高危构造的顶层规则整条丢弃，其余原样保留。
+ *
+ * 服务端还有一层同样的检查；两层是有意的：前端保证渲染与导出不会带毒，服务端保证
+ * 绕过前端直接 PUT（或旧客户端）也不会把毒文档分发给访客。
+ */
+export function sanitizeCustomCss(value: unknown, max = MAX_CUSTOM_CSS_CHARS): string {
+  if (typeof value !== 'string' || !value) return '';
+  const source = value.slice(0, max);
+  if (!source.trim()) return '';
+  // 干净样式原样返回，避免无意义地重排操作者手写的格式。
+  if (!highRiskCustomCssMarker(source)) return source;
+  const kept = splitTopLevelCssRules(source).filter((rule) => !highRiskCustomCssMarker(rule));
+  const result = kept.join('\n').trim();
+  if (!result || highRiskCustomCssMarker(result)) return '';
+  return result.slice(0, max);
+}
+
 /* ------------------------------------------------------------------ *
  * 创作者扩展（沙箱）
  * ------------------------------------------------------------------ */
 
 export const MAX_CUSTOM_EXTENSIONS = 20;
 export const EXTENSION_LIMITS = {
   html: 80_000,
   css: 40_000,
@@ -422,18 +549,19 @@ function normalizeBlock(
   value: unknown,
   depth = 0,
   seen: Set<string> = new Set(),
   budget: { count: number } = { count: 0 },
 ): BlockInstance | null {
   if (!value || typeof value !== 'object' || depth > MAX_BLOCK_DEPTH) return null;
   if (budget.count >= MAX_BLOCKS) return null;
   const raw = value as Partial<BlockInstance>;
-  if (typeof raw.type !== 'string' || !BLOCK_TYPES.has(raw.type)) return null;
+  if (typeof raw.type !== 'string' || !raw.type) return null;
   budget.count += 1;
+  const known = BLOCK_TYPES.has(raw.type);
 
   const props: Record<string, string | number | boolean> = {};
   for (const [key, item] of Object.entries(raw.props ?? {})) {
     if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
       props[key] =
         typeof item === 'number'
           ? Math.min(1e6, Math.max(-1e6, item))
           : typeof item === 'boolean'
@@ -443,22 +571,42 @@ function normalizeBlock(
   }
 
   let id = typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 80) : nextBlockId();
   if (seen.has(id)) id = nextBlockId();
   seen.add(id);
 
   const children = Array.isArray(raw.children)
     ? raw.children
-        .slice(0, 80)
+        .slice(0, MAX_CHILDREN_PER_CONTAINER)
         .map((child) => normalizeBlock(child, depth + 1, seen, budget))
         .filter((child): child is BlockInstance => !!child)
     : [];
 
   const area = raw.area === 'full' || raw.area === 'main' || raw.area === 'side' ? raw.area : undefined;
+  if (!known) {
+    // 不认识的类型：保留形状，不解释 props，渲染器会跳过它。
+    const unsupportedProps: Record<string, string | number | boolean> = {};
+    for (const [key, item] of Object.entries(raw.props ?? {})) {
+      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
+        unsupportedProps[key] = item;
+      }
+    }
+    return {
+      id,
+      type: raw.type.slice(0, 64),
+      title: text(raw.title, '', 80) || raw.type.slice(0, 64),
+      props: unsupportedProps,
+      animation: animation(raw.animation),
+      hidden: bool(raw.hidden, false),
+      unsupported: true,
+      ...(children.length ? { children } : {}),
+    };
+  }
+  const appearance = normalizeBlockAppearance(raw.appearance);
   return {
     id,
     type: raw.type,
     title: text(raw.title, '', 80) || blockDef(raw.type)?.name || raw.type,
     props,
     animation: animation(raw.animation),
     hidden: bool(raw.hidden, false),
     ...(area ? { area } : {}),
@@ -468,54 +616,67 @@ function normalizeBlock(
       ? { width: Math.min(1600, Math.round(raw.width)) }
       : {}),
     ...(typeof raw.height === 'number' && raw.height > 0
       ? { height: Math.min(2400, Math.round(raw.height)) }
       : {}),
     ...(typeof raw.custom_css === 'string' && raw.custom_css
       ? { custom_css: raw.custom_css.slice(0, 4000) }
       : {}),
+    ...(appearance ? { appearance } : {}),
   };
 }
 
 function normalizeBlockList(value: unknown): BlockInstance[] {
   const raw = Array.isArray(value) ? value : [];
   const blocks = raw
-    .slice(0, 24)
     .map((block) => normalizeBlock(block))
     .filter((block): block is BlockInstance => !!block);
   if (countBlocks(blocks) <= MAX_BLOCKS) return blocks;
 
   // 极端配置里根级区块本身很少，但子树可能超限；从尾部逐棵剔除到预算内。
   const trimmed: BlockInstance[] = [];
   let total = 0;
   for (const block of blocks) {
     const size = countBlocks([block]);
     if (total + size > MAX_BLOCKS) continue;
     trimmed.push(block);
     total += size;
   }
   return trimmed;
 }
 
-function normalizeLayout(value: unknown): ScreenLayout {
+export function normalizeScreenLayout(value: unknown): ScreenLayout {
   const raw = value as ScreenLayout | undefined;
   const blocks = normalizeBlockList(raw?.blocks);
   if (!raw?.device_split || !raw.devices || typeof raw.devices !== 'object') {
     return { blocks };
   }
   const devices: NonNullable<ScreenLayout['devices']> = {};
   for (const device of ['desktop', 'tablet', 'mobile'] as const) {
     const entry = raw.devices[device];
     if (!entry || !Array.isArray(entry.blocks)) continue;
     devices[device] = { blocks: normalizeBlockList(entry.blocks) };
   }
   return { blocks, device_split: true, devices };
 }
 
+/** 编排的区块总量；编辑器保存前用它挡住超限，而不是让归一化静默截断。 */
+export function blockBudgetStatus(layout: ScreenLayout): {
+  total: number;
+  limit: number;
+  over: boolean;
+} {
+  const perDevice = Object.values(layout.devices ?? {}).map((entry) =>
+    countBlocks((entry as { blocks: BlockInstance[] }).blocks),
+  );
+  const total = Math.max(countBlocks(layout.blocks), 0, ...perDevice);
+  return { total, limit: MAX_BLOCKS, over: total > MAX_BLOCKS };
+}
+
 const STEP_KINDS = new Set(['trigger', 'condition', 'action']);
 
 function normalizeStep(value: unknown): LogicStep | null {
   if (!value || typeof value !== 'object') return null;
   const raw = value as Partial<LogicStep>;
   if (!raw.kind || !STEP_KINDS.has(raw.kind) || typeof raw.type !== 'string') return null;
   const config: Record<string, string | number | boolean> = {};
   for (const [key, item] of Object.entries(raw.config ?? {})) {
@@ -600,18 +761,18 @@ function normalizeVerificationProvider(value: unknown): HumanVerificationProvide
 /** 把任意（可能是旧版本或导入的）配置收敛成可用的结构。 */
 export function readCustomization(config: Pick<WebConfig, 'customization'>): SiteCustomization {
   const raw = config.customization;
   if (!raw) return DEFAULT_CUSTOMIZATION;
   const theme = normalizeThemeSettings(raw.theme);
   const layout = raw.layout ?? DEFAULT_LAYOUT;
   const variant = layout.variant === 'bento' ? 'bento' : 'classic';
   const extensions = raw.extensions ?? DEFAULT_EXTENSIONS;
-  const home = normalizeLayout(raw.home);
-  const article = normalizeLayout(raw.article);
+  const home = normalizeScreenLayout(raw.home);
+  const article = normalizeScreenLayout(raw.article);
   // 旧配置没有备案开关时按“已填写就显示”处理，避免已有备案信息突然消失。
   const icp = text(layout.icp, '', 80);
   const police = text(layout.police, '', 80);
   const filingFilled = !!(icp.trim() || police.trim());
   const chains = Array.isArray(raw.logic?.chains)
     ? raw.logic.chains.map(normalizeChain).filter((c): c is LogicChain => !!c)
     : [];
   const themes: SiteTheme[] = [];
@@ -718,17 +879,19 @@ export function readCustomization(config: Pick<WebConfig, 'customization'>): Sit
       canonical_base: text(raw.seo?.canonical_base, '', 300).replace(/\/+$/, ''),
       publisher: text(raw.seo?.publisher, '', 120),
       verification: {
         google: text(raw.seo?.verification?.google, '', 120),
         baidu: text(raw.seo?.verification?.baidu, '', 120),
         bing: text(raw.seo?.verification?.bing, '', 120),
       },
     },
-    custom_css: text(raw.custom_css, '', 20000),
+    // 自定义 CSS 是唯一会原样进入全站 <style> 的字段：读入时就把高危规则剔掉，
+    // 保证随后写回服务端的副本、导出文件与渲染都走同一份干净内容。
+    custom_css: sanitizeCustomCss(raw.custom_css),
   };
 }
 
 function isPageLike(value: unknown): value is SitePage {
   if (!value || typeof value !== 'object') return false;
   const page = value as Partial<SitePage>;
   return typeof page.id === 'string' && typeof page.title === 'string' && typeof page.slug === 'string';
 }
@@ -737,17 +900,17 @@ function isPageLike(value: unknown): value is SitePage {
 function pageTextBlock(markdown: string, title = '') {
   const block = createBlock('text');
   block.title = title || '正文';
   block.props = { ...block.props, eyebrow: '', title: '', body: markdown };
   return block;
 }
 
 function normalizePage(page: SitePage): SitePage {
-  const layout = page.layout ? normalizeLayout(page.layout) : undefined;
+  const layout = page.layout ? normalizeScreenLayout(page.layout) : undefined;
   const legacyBody = text(page.body, '', 50000).trim();
   // 页面内容现在统一由「页面编排」的区块承载。旧版页面只有 Markdown 正文，
   // 首次读取时把它搬进一个「文本」区块，之后前台不再单独渲染 body。
   const migrated =
     layout && layout.blocks.length
       ? layout
       : legacyBody
         ? { blocks: [pageTextBlock(legacyBody)] }
@@ -939,17 +1102,18 @@ export function createCustomizationWithPages(): SiteCustomization {
 }
 
 /** 导出为 JSON 文件：外观、页面与扩展一并带走。 */
 export function downloadCustomization(customization: SiteCustomization, siteName: string): void {
   const payload = {
     version: 1,
     exported_at: new Date().toISOString(),
     site: siteName,
-    customization,
+    // 导出也走一遍规范化：手改过的本地配置可能带着还没被读入清洗的样式。
+    customization: { ...customization, custom_css: sanitizeCustomCss(customization.custom_css) },
   };
   const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
   const url = URL.createObjectURL(blob);
   const link = document.createElement('a');
   link.href = url;
   link.download = `practacu-customization-${new Date().toISOString().slice(0, 10)}.json`;
   link.click();
   URL.revokeObjectURL(url);
diff --git a/apps/web/src/lib/customizeBlocks.test.ts b/apps/web/src/lib/customizeBlocks.test.ts
new file mode 100644
index 0000000..e63388b
--- /dev/null
+++ b/apps/web/src/lib/customizeBlocks.test.ts
@@ -0,0 +1,52 @@
+import { describe, expect, it } from 'vitest';
+import { blockBudgetStatus, normalizeScreenLayout } from './customize';
+
+function textBlock(id: string) {
+  return { id, type: 'text', title: id, props: { body: 'hi' }, animation: 'none' as const, hidden: false };
+}
+
+describe('normalizeScreenLayout', () => {
+  it('保留不认识的区块类型并打上 unsupported', () => {
+    const layout = normalizeScreenLayout({
+      blocks: [{ id: 'x1', type: 'pricing-v9', title: '价格', props: { plan: 'A' } }],
+    });
+    expect(layout.blocks).toHaveLength(1);
+    expect(layout.blocks[0].type).toBe('pricing-v9');
+    expect(layout.blocks[0].unsupported).toBe(true);
+    expect(layout.blocks[0].props).toEqual({ plan: 'A' });
+  });
+
+  it('根级不再截断到 24 个', () => {
+    const blocks = Array.from({ length: 30 }, (_, i) => textBlock(`b${i}`));
+    const layout = normalizeScreenLayout({ blocks });
+    expect(layout.blocks).toHaveLength(30);
+  });
+
+  it('容器子区块仍受 80 条上限约束', () => {
+    const children = Array.from({ length: 90 }, (_, i) => textBlock(`c${i}`));
+    const layout = normalizeScreenLayout({
+      blocks: [
+        { id: 'box', type: 'container', title: 'box', props: {}, animation: 'none', hidden: false, children },
+      ],
+    });
+    expect(layout.blocks[0].children).toHaveLength(80);
+  });
+
+  it('没有任何 type 的条目直接丢弃', () => {
+    const layout = normalizeScreenLayout({ blocks: [{ id: 'bad' }, textBlock('ok')] });
+    expect(layout.blocks.map((block) => block.id)).toEqual(['ok']);
+  });
+});
+
+describe('blockBudgetStatus', () => {
+  it('超过 200 个区块时报告超限', () => {
+    const blocks = Array.from({ length: 201 }, (_, i) => textBlock(`b${i}`));
+    const status = blockBudgetStatus({ blocks });
+    expect(status.over).toBe(true);
+    expect(status.limit).toBe(200);
+  });
+
+  it('正常编排不超限', () => {
+    expect(blockBudgetStatus({ blocks: [textBlock('a')] }).over).toBe(false);
+  });
+});
diff --git a/apps/web/src/types.ts b/apps/web/src/types.ts
index ea40b93..85d2063 100644
--- a/apps/web/src/types.ts
+++ b/apps/web/src/types.ts
@@ -66,16 +66,40 @@ export interface Site {
   slug: string;
   name: string;
   domain: string;
   visibility_mode: VisibilityMode;
   publish_mode: PublishMode;
   disabled: boolean;
   /** 设置接口接受 description，但 Site 响应未声明；连接真实后端时可能缺失。 */
   description?: string;
+  /**
+   * 站点是否开放自助注册（O-3）。
+   *
+   * 缺失时按开放处理：旧后端与升级前保存的配置都不带这个字段，误关注册比多显示
+   * 一个注册入口代价大得多。
+   */
+  registration_open?: boolean;
+}
+
+/** 主域名的 TXT 归属验证信息（V-12）。 */
+export interface SiteDomainVerification {
+  domain: string;
+  verified: boolean;
+  verification_token: string;
+  /** TXT 记录名，例如 _practacu-verify.press.example.com。 */
+  record_name: string;
+  /** 记录类型，后端固定返回 TXT。 */
+  record_type: string;
+}
+
+/** 立即验证主域名归属的结果。 */
+export interface SiteDomainVerificationResult {
+  verified: boolean;
+  domain: string;
 }
 
 export interface Member {
   user_id: string;
   display_name: string;
   role: Role;
   status: 'active' | 'invited' | 'suspended';
   email?: string;
@@ -732,16 +756,47 @@ export type CapabilityId =
 export interface PermissionGroup {
   /** 该组账户可以进入管理后台。游客没有账户，此字段恒为 false。 */
   admin_access: boolean;
   capabilities: Record<CapabilityId, boolean>;
 }
 
 export type PermissionSettings = Record<PermissionGroupId, PermissionGroup>;
 
+/** 组件通用外观：圆角档位。 */
+export type BlockRadius = 'none' | 'sm' | 'md' | 'lg' | 'xl' | 'full';
+
+/** 组件通用外观：阴影档位。 */
+export type BlockShadow = 'none' | 'sm' | 'md' | 'lg' | 'glow';
+
+/**
+ * 组件通用外观：裁剪方式。
+ * `clip` 只裁掉溢出内容；比例值额外设置 aspect-ratio，相当于一个相框。
+ */
+export type BlockCrop = 'none' | 'clip' | '16:9' | '4:3' | '3:2' | '1:1' | '2:1';
+
+/**
+ * 组件通用外观。
+ *
+ * 全部字段都是受限枚举或标量，随区块一起 JSON 序列化；渲染时只变成最外层
+ * `<section class="pp-block">` 上的内联样式，不生成全局样式表，因此不会影响
+ * 其他区块，也仍然允许 `custom_css` 覆盖。
+ */
+export interface BlockAppearance {
+  radius?: BlockRadius;
+  shadow?: BlockShadow;
+  crop?: BlockCrop;
+  /** `#rgb` / `#rrggbb` / `#rrggbbaa`；空表示透明。 */
+  background?: string;
+  /** 0–64 px；0 表示不额外留白。 */
+  padding?: number;
+  /** 用主题细分割线描一圈边框。 */
+  border?: boolean;
+}
+
 /**
  * 无代码区块实例：一个默认组件 + 自己的命名、属性覆盖与入场动画。
  * 属性值只允许标量，保证配置可 JSON 序列化、可导入导出。
  */
 export interface BlockInstance {
   id: string;
   type: string;
   /** 后台里的显示名，方便在长编排里认出它。 */
@@ -759,16 +814,23 @@ export interface BlockInstance {
   /** 在分栏容器里的列号，从 1 开始；根级区块忽略。 */
   column?: number;
   /** 编排器里直接拖拽调整的宽度（px）；缺省表示撑满可用宽度。 */
   width?: number;
   /** 编排器里直接拖拽调整的最小高度（px）。 */
   height?: number;
   /** 组件级 CSS 声明，只作用于这个区块本身。 */
   custom_css?: string;
+  /** 通用外观（圆角、阴影、裁剪、背景、内边距、描边）；缺省表示出厂观感。 */
+  appearance?: BlockAppearance;
+  /**
+   * 归一化时无法识别的区块类型：保留原样、不渲染、保存时写回。
+   * 这样从更新版本导出的设计不会因为本版本不认识而在下一次保存时永久消失。
+   */
+  unsupported?: boolean;
 }
 
 /** 夜航双栏布局的落位。 */
 export type BlockArea = 'full' | 'main' | 'side';
 
 /** 页面编排里可单独设置的设备。 */
 export type BuilderDevice = 'desktop' | 'tablet' | 'mobile';
 
@@ -1110,72 +1172,83 @@ export interface PerformanceSettings {
   /** 数据库最大空闲连接数；0 表示按驱动默认。 */
   db_max_idle_conns: number;
   /** 数据库连接最长生命周期（秒）。 */
   db_conn_max_lifetime: number;
 }
 
 export type StorageDriver = 'local' | 's3';
 
+/** 存储用途：文章媒体、站点图片、用户头像、用户数据/附件。 */
+export type StorageScope = 'content' | 'site' | 'avatar' | 'attachment';
+
 /**
- * 媒体存储策略。
+ * 一套命名的储存策略。
  *
  * 浏览器只能记录部署意图：真正用到哪种存储由 API 进程启动时的 `STORAGE_*`
- * 环境变量决定。后台把选择翻译成可直接粘贴的 `.env` 片段，切换后需要重启
- * API，已有文件不会自动搬家。云对象存储兼容任何 S3 实现（AWS S3、MinIO、
- * 阿里云 OSS、腾讯云 COS 等）；公开读权限与防盗链由桶策略或 CDN 决定。
+ * 环境变量决定。后台把「策略 + 用途分配」翻译成可直接粘贴的 `.env` 片段，
+ * 切换后需要重启 API，已有文件不会自动搬家。云对象存储兼容任何 S3 实现
+ * （AWS S3、MinIO、阿里云 OSS、腾讯云 COS 等）；公开读权限与防盗链由桶策略
+ * 或 CDN 决定。
  */
-/** 存储用途：文章媒体、站点图片、用户头像、用户数据/附件。 */
-export type StorageScope = 'content' | 'site' | 'avatar' | 'attachment';
-
-/** 单个用途的存储目标；`inherit` 表示沿用上面的全局存储。 */
-export interface StorageScopeSettings {
-  driver: 'inherit' | StorageDriver;
-  /** driver=local 时的本地目录；inherit 时忽略。 */
+export interface StorageStrategy {
+  /** 稳定 id，只允许小写字母、数字、下划线与连字符；用途用它引用策略。 */
+  id: string;
+  /** 展示名，必填且唯一，最多 40 个字符。 */
+  name: string;
+  /** 本地存储或 S3 兼容云对象存储。 */
+  driver: StorageDriver;
+  /** driver=local 时的本地目录；相对路径基于 API 进程的工作目录。 */
   local_dir: string;
-  /** driver=s3 时的桶名；inherit 时忽略。 */
+  /** driver=s3 时的桶名；云策略必填。 */
   s3_bucket: string;
-  /** driver=s3 时的对象键前缀；inherit 时忽略。 */
+  /** driver=s3 时的对象键前缀，同一桶多站点时用来隔离。 */
   s3_prefix: string;
-}
-
-export interface StorageSettings {
-  /** 本地磁盘或 S3 兼容对象存储。 */
-  driver: StorageDriver;
-  /** 本地存储根目录；相对路径基于 API 进程的工作目录。 */
-  local_dir: string;
   /** S3 兼容端点；AWS 留空，MinIO / OSS / COS 填各自地址。 */
   s3_endpoint: string;
   /** 区域；SDK 对 MinIO 也要求一个值，留空时按 us-east-1 处理。 */
   s3_region: string;
-  /** 桶名；s3 模式下必填。 */
-  s3_bucket: string;
-  /** 对象键前缀，同一桶多站点时用来隔离。 */
-  s3_prefix: string;
+  /**
+   * 访问密钥 ID。可以保存在本地安装配置里；密钥（secret）不保存，
+   * 只存在于页面的组件状态，用于生成 `.env` 片段。
+   */
+  s3_access_key: string;
   /**
    * 期望的公开访问前缀（例如 CDN 域名）。
    *
    * 仅用于前端记录与排查，API 不读取这个值；公开读权限由桶策略或 CDN 决定。
    */
   s3_public_base_url: string;
-  /**
-   * 访问密钥 ID。可以保存在本地安装配置里；密钥（secret）不保存，
-   * 只存在于页面的组件状态，用于生成 `.env` 片段。
-   */
-  s3_access_key: string;
+}
+
+/**
+ * 媒体储存设置。
+ *
+ * `strategies` 是用户自己增删改的命名策略；`scopes` 把四个用途各自指向一套
+ * 策略的 id。旧版配置（全局 driver + 分用途覆盖）由 `normalizeStorage()`
+ * 迁移成这个形状，因此页面永远只需要处理这里的一种模型。
+ */
+export interface StorageSettings {
+  /** 至少一套，最多 8 套。 */
+  strategies: StorageStrategy[];
+  /** 值 = strategies 里某个策略的 id；四个键必须齐全且都是合法 id。 */
+  scopes: Record<StorageScope, string>;
   /** 仅前端提示：期望的单文件上限（MB）。真正的上限由 API 与安全服务决定。 */
   max_upload_mb: number;
-  /**
-   * 分用途覆盖：文章媒体、站点图片、用户头像、用户数据/附件。
-   * 旧配置没有这个字段时全部沿用全局存储。
-   */
-  scopes: Record<StorageScope, StorageScopeSettings>;
 }
 
-export type LoadingPreset = 'spinner' | 'dots' | 'pulse' | 'bar' | 'orbit';
+export type LoadingPreset =
+  | 'spinner'
+  | 'dots'
+  | 'pulse'
+  | 'bar'
+  | 'orbit'
+  | 'skeleton'
+  | 'shimmer'
+  | 'skeleton-shimmer';
 
 /** 站点前台加载动画。 */
 export interface LoadingSettings {
   enabled: boolean;
   preset: LoadingPreset;
   text: string;
   /** 强调色跟随主题，或使用自定义颜色。 */
   accent_mode: 'theme' | 'custom';
@@ -1205,16 +1278,31 @@ export interface WebConfig {
   created_at: string;
   docs_url: string;
   /** 旧配置没有这个字段，按社区站点处理。 */
   site_kind?: SiteKind;
   /** 站长登录邮箱：只用于个人博客的登录提示与前端校验，不是凭据。 */
   owner_email?: string;
   /** 后台入口地址别名，例如 /manage；缺省为 /admin。 */
   admin_path?: string;
+  /**
+   * 匿名访客的只读配置：由启动探测（`lib/visitorBootstrap.ts`）构造，只存在内存里。
+   *
+   * 带这个标记的配置不写回 localStorage，也不参与「安装校验 / 设计水合 / 设计回写」，
+   * 避免把访客浏览器误当成一次真实安装。
+   */
+  visitor?: boolean;
+  /** 匿名访客的站点名：真实 Site 对象要登录后才能拿到，访客用 setup/status 的结果。 */
+  visitor_site_name?: string;
+  /**
+   * 匿名访客看到的注册开关（来自 setup/status 的 registration_open）。
+   *
+   * 缺省表示旧后端：按开放处理；false 时前台隐藏注册入口、注册页显示关闭提示。
+   */
+  visitor_registration_open?: boolean;
   /** 主题、页面与扩展。旧配置缺省时按默认外观处理。 */
   customization?: SiteCustomization;
   /** 邮箱之外的登录方式。旧配置缺省时全部关闭。 */
   auth?: AuthSettings;
   /** 服务端邮件（SMTP）的非机密配置；密码不在这里。 */
   mail?: MailSettings;
   /** 访问限制（浏览器端）与网关配置生成。旧配置缺省时关闭保护。 */
   access?: AccessSettings;
