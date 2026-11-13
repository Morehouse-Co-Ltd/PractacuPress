# P1 Task 1 review package

## Commits

d48ff02 feat(web): evaluate per-device overrides and unify the breakpoint table

## Diff
diff --git a/apps/web/src/components/LogicRuntime.tsx b/apps/web/src/components/LogicRuntime.tsx
index 604088e..9ef4340 100644
--- a/apps/web/src/components/LogicRuntime.tsx
+++ b/apps/web/src/components/LogicRuntime.tsx
@@ -2,16 +2,17 @@ import { useEffect, useRef } from 'react';
 import { useLocation } from 'react-router-dom';
 import type { LogicStep } from '../types';
 import { useAuth } from '../lib/session';
 import { useCustomization } from '../lib/customize';
 import { isPersonalSite } from '../lib/site';
 import { applyMode } from '../lib/theme';
 import { dispatchInterfaceCommand } from '../lib/interfaceCommands';
 import { evaluateChain, type LogicContext, type LogicEvent } from '../lib/logic';
+import { BREAKPOINT_MD } from '../lib/layout';
 
 /**
  * 思维链运行时。
  *
  * 性能纪律：
  * - 只挂“有链条用到”的监听器（滚动 / 悬停 / 点击 / 闲置各至多一个）；
  * - 滚动用 rAF 节流，监听器全部 passive；
  * - 每条链 1.5 秒冷却，防止悬停与滚动把动作放成刷屏；
@@ -108,17 +109,17 @@ export function LogicRuntime() {
 
   useEffect(() => {
     if (!chains.length) return;
 
     const runChains = (event: LogicEvent, first: boolean) => {
       const state = latest.current;
       const ctx: LogicContext = {
         pathname: state.pathname,
-        isMobile: window.innerWidth < 768,
+        isMobile: window.innerWidth < BREAKPOINT_MD,
         loggedIn: state.loggedIn,
         personal: state.personal,
         mode: state.mode,
         scroll: scrollRef.current,
         idleFor: idleRef.current,
         event,
       };
       for (const chain of state.chains) {
@@ -203,17 +204,17 @@ export function LogicRuntime() {
   }, [chains, needs.scroll, needs.idle, needs.pointer, update]);
 
   // 明暗切换求值：模式变化来自配置更新，单独监听。
   useEffect(() => {
     if (!needs.dark || !chains.length) return;
     const state = latest.current;
     const ctx: LogicContext = {
       pathname: state.pathname,
-      isMobile: window.innerWidth < 768,
+      isMobile: window.innerWidth < BREAKPOINT_MD,
       loggedIn: state.loggedIn,
       personal: state.personal,
       mode: state.mode,
       scroll: scrollRef.current,
       idleFor: idleRef.current,
       event: { kind: 'dark' },
     };
     for (const chain of state.chains) {
diff --git a/apps/web/src/components/blocks/index.tsx b/apps/web/src/components/blocks/index.tsx
index 638a28b..b080d77 100644
--- a/apps/web/src/components/blocks/index.tsx
+++ b/apps/web/src/components/blocks/index.tsx
@@ -9,16 +9,17 @@ import type {
 import { builderDeviceForWidth, resolveArea, screenBlocksForDevice } from '../../lib/blocks';
 import { hasBoundProps, resolveBoundProps } from '../../lib/blocksData';
 import { blockAppearanceCss } from '../../lib/blockAppearance';
 import { useInView } from '../../lib/hooks';
 import { playBlockAnimation } from '../../lib/blockAnimations';
 import { styleDeclarations } from '../../lib/blockStyles';
 import { motionReduced } from '../../lib/performance';
 import { BLOCK_SKELETON_SHAPES } from '../../lib/loading';
+import { applyDisplayOverrides } from '../../lib/layout';
 import { useT } from '../../lib/i18n';
 import { usePageSkeleton } from '../SkeletonMode';
 import { useFeed } from './FeedContext';
 import { useBlockDataContext } from './ArticleContext';
 import { BlockSkeleton } from './BlockSkeleton';
 import { CLASSIC_RENDERERS } from './Classic';
 import { NIGHT_RENDERERS } from './Nightflight';
 import { CONTENT_RENDERERS } from './ContentBlocks';
@@ -157,17 +158,19 @@ export function ScreenRenderer({
 }: {
   layout: ScreenLayout;
   variant?: LayoutVariant;
   /** 当前界面；留言箱用它区分不同页面的留言。 */
   scope?: ScreenScope;
 }) {
   const t = useT();
   const device = useViewportDevice();
-  const blocks = screenBlocksForDevice(layout, device).filter((block) => !block.hidden);
+  const blocks = applyDisplayOverrides(screenBlocksForDevice(layout, device), device).filter(
+    (block) => !block.hidden,
+  );
   if (!blocks.length) return null;
   return (
     <ScreenScopeProvider scope={scope ?? { type: 'home', id: 'home' }}>
       {renderBlocks(blocks, variant, t)}
     </ScreenScopeProvider>
   );
 }
 
diff --git a/apps/web/src/lib/blocks.ts b/apps/web/src/lib/blocks.ts
index bf8de11..be23334 100644
--- a/apps/web/src/lib/blocks.ts
+++ b/apps/web/src/lib/blocks.ts
@@ -5,16 +5,17 @@ import type {
   BlockProps,
   BuilderDevice,
   LayoutVariant,
   ScreenLayout,
 } from '../types';
 import { t } from './i18n';
 import { liveCatalog } from './i18n/live';
 import { IMAGE_RADIUS_OPTIONS } from './imageRadius';
+import { BREAKPOINT_LG, BREAKPOINT_MD } from './layout';
 
 /**
  * 无代码区块注册表（数据侧）。
  *
  * 每个区块 = 一个默认组件 + 属性模式（schema）+ 默认值。渲染器在
  * `components/blocks/`，后台编辑器的表单由 schema 驱动，因此新增组件
  * 不需要改编辑器代码。属性值只允许标量或 repeater（条目数组），
  * 保证整份配置可以导入导出。
@@ -1040,20 +1041,20 @@ export function createBlock(type: string, patch?: Partial<BlockInstance>): Block
     title: def?.name ?? type,
     props: { ...(def?.defaults ?? {}) },
     animation: DEFAULT_ANIMATION,
     hidden: false,
     ...patch,
   };
 }
 
-/** 按窗口宽度判断当前设备：桌面 ≥1024，平板 641–1023，手机 ≤640。 */
+/** 按窗口宽度判断当前设备；阈值来自 lib/layout.ts 的唯一断点表。 */
 export function builderDeviceForWidth(width: number): BuilderDevice {
-  if (width <= 640) return 'mobile';
-  if (width < 1024) return 'tablet';
+  if (width < BREAKPOINT_MD) return 'mobile';
+  if (width < BREAKPOINT_LG) return 'tablet';
   return 'desktop';
 }
 
 /** 取某份编排在指定设备下实际渲染的区块。 */
 export function screenBlocksForDevice(
   layout: ScreenLayout,
   device: BuilderDevice,
 ): BlockInstance[] {
diff --git a/apps/web/src/lib/layout.test.ts b/apps/web/src/lib/layout.test.ts
new file mode 100644
index 0000000..d979c10
--- /dev/null
+++ b/apps/web/src/lib/layout.test.ts
@@ -0,0 +1,78 @@
+import { describe, expect, it } from 'vitest';
+import type { BlockInstance } from '../types';
+import {
+  BREAKPOINT_LG,
+  BREAKPOINT_MD,
+  BREAKPOINT_SM,
+  SPACING_SCALE,
+  applyDisplayOverrides,
+  overlayAt,
+  spacingPx,
+} from './layout';
+
+function mk(id: string, extra: Partial<BlockInstance> = {}): BlockInstance {
+  return { id, type: 'text', title: id, props: {}, animation: 'none', hidden: false, ...extra };
+}
+
+describe('断点', () => {
+  it('三档从小到大且与文档一致', () => {
+    expect([BREAKPOINT_SM, BREAKPOINT_MD, BREAKPOINT_LG]).toEqual([480, 768, 1024]);
+  });
+});
+
+describe('spacingPx', () => {
+  it('按档位下标取值', () => {
+    expect(spacingPx(0)).toBe(0);
+    expect(spacingPx(9)).toBe(96);
+  });
+  it('越界、非整数、非数字一律 undefined', () => {
+    expect(spacingPx(-1)).toBeUndefined();
+    expect(spacingPx(99)).toBeUndefined();
+    expect(spacingPx(1.5)).toBeUndefined();
+    expect(spacingPx('3')).toBeUndefined();
+  });
+  it('标尺是只读常量且单调递增', () => {
+    expect(SPACING_SCALE).toEqual([0, 4, 8, 12, 16, 24, 32, 48, 64, 96]);
+  });
+});
+
+describe('overlayAt', () => {
+  it('手机覆盖隐藏时只影响手机', () => {
+    const block = mk('a', { at: { mobile: { hidden: true } } });
+    expect(overlayAt(block, 'mobile').hidden).toBe(true);
+    expect(overlayAt(block, 'desktop').hidden).toBe(false);
+  });
+
+  it('外观对象按字段合并，不整块替换', () => {
+    const block = mk('a', {
+      appearance: { radius: 'md', padding: 12 },
+      at: { tablet: { appearance: { radius: 'xl' } } },
+    });
+    expect(overlayAt(block, 'tablet').appearance).toEqual({ radius: 'xl', padding: 12 });
+  });
+
+  it('递归进子区块', () => {
+    const child = mk('c', { at: { mobile: { hidden: true } } });
+    const parent = mk('p', { children: [child] });
+    const mobile = overlayAt(parent, 'mobile');
+    expect(mobile.children?.[0].hidden).toBe(true);
+    expect(overlayAt(parent, 'desktop').children?.[0].hidden).toBe(false);
+  });
+
+  it('不修改入参', () => {
+    const block = mk('a', { at: { mobile: { span: { base: 6 } } } });
+    overlayAt(block, 'mobile');
+    expect(block.span).toBeUndefined();
+  });
+});
+
+describe('applyDisplayOverrides', () => {
+  it('桌面原样返回（desktop 没有覆盖层）', () => {
+    const blocks = [mk('a', { at: { mobile: { hidden: true } } })];
+    expect(applyDisplayOverrides(blocks, 'desktop')[0].hidden).toBe(false);
+  });
+  it('批量应用手机覆盖', () => {
+    const blocks = [mk('a', { at: { mobile: { hidden: true } } }), mk('b')];
+    expect(applyDisplayOverrides(blocks, 'mobile').map((b) => b.hidden)).toEqual([true, false]);
+  });
+});
diff --git a/apps/web/src/lib/layout.ts b/apps/web/src/lib/layout.ts
new file mode 100644
index 0000000..5d92230
--- /dev/null
+++ b/apps/web/src/lib/layout.ts
@@ -0,0 +1,63 @@
+import type { BlockDisplayOverride, BlockInstance, BuilderDevice } from '../types';
+
+/**
+ * 断点的唯一来源。
+ *
+ * P0 之前仓库里有两套：`builderDeviceForWidth` 用 640、思维链的 `is_mobile` 用 768。
+ * 两套阈值意味着"同一台设备在编排器和逻辑链里身份不同"，这里统一。
+ */
+export const BREAKPOINT_SM = 480;
+export const BREAKPOINT_MD = 768;
+export const BREAKPOINT_LG = 1024;
+
+/** 间距标尺：新字段存的是这个数组的下标，不是像素。 */
+export const SPACING_SCALE: readonly number[] = [0, 4, 8, 12, 16, 24, 32, 48, 64, 96];
+
+/** 档位下标 → 像素；非法档位返回 undefined（调用方按"未设置"处理）。 */
+export function spacingPx(index: unknown): number | undefined {
+  if (typeof index !== 'number' || !Number.isInteger(index)) return undefined;
+  if (index < 0 || index >= SPACING_SCALE.length) return undefined;
+  return SPACING_SCALE[index];
+}
+
+/** 这一层覆盖里真正要写的字段；`desktop` 没有覆盖层。 */
+function overrideOf(block: BlockInstance, device: BuilderDevice): BlockDisplayOverride | undefined {
+  if (device === 'desktop') return undefined;
+  return block.at?.[device];
+}
+
+/**
+ * 把某个设备的覆盖层叠到区块上。
+ *
+ * 只叠展示层（`BlockDisplayOverride` 声明的字段），`props` 永远只有一份——
+ * 这是 P0 定下的规矩，内容双源是三端布局当年失控的根因。
+ */
+export function overlayAt(block: BlockInstance, device: BuilderDevice): BlockInstance {
+  const override = overrideOf(block, device);
+  const children = block.children?.map((child) => overlayAt(child, device));
+  const base: BlockInstance = children && children !== block.children ? { ...block, children } : block;
+  if (!override) return base;
+
+  const next: BlockInstance = { ...base };
+  if (override.span) next.span = override.span;
+  if (override.align) next.align = override.align;
+  if (override.animation) next.animation = override.animation;
+  if (override.hidden !== undefined) next.hidden = override.hidden;
+  if (override.custom_css) next.custom_css = override.custom_css;
+  if (override.width !== undefined) next.width = override.width;
+  if (override.height !== undefined) next.height = override.height;
+  if (override.gap_scale !== undefined) next.gap_scale = override.gap_scale;
+  if (override.mt !== undefined) next.mt = override.mt;
+  if (override.mb !== undefined) next.mb = override.mb;
+  if (override.appearance) next.appearance = { ...base.appearance, ...override.appearance };
+  return next;
+}
+
+/** 批量叠覆盖；渲染入口调用它一次，子树里就不再关心设备。 */
+export function applyDisplayOverrides(
+  blocks: BlockInstance[],
+  device: BuilderDevice,
+): BlockInstance[] {
+  if (device === 'desktop') return blocks;
+  return blocks.map((block) => overlayAt(block, device));
+}
diff --git a/apps/web/src/lib/logic.ts b/apps/web/src/lib/logic.ts
index 4aec233..23fcc08 100644
--- a/apps/web/src/lib/logic.ts
+++ b/apps/web/src/lib/logic.ts
@@ -1,11 +1,12 @@
 import type { LogicChain, LogicStep, ThemeMode } from '../types';
 import { t } from './i18n';
 import { liveCatalog } from './i18n/live';
+import { BREAKPOINT_MD } from './layout';
 
 /**
  * 思维链引擎（无代码逻辑）。
  *
  * 一条链 = 一个触发 + 若干条件 + 若干动作：当触发发生的事情满足全部条件时，
  * 按顺序执行动作。整条链是纯数据，由 `evaluateChain` 求值——
  * 不 eval、不动态生成代码，因此无代码产物不会有脚本注入面，也不会更慢。
  */
@@ -80,19 +81,28 @@ const RAW_LOGIC_TRIGGERS: StepDef[] = [
   { type: 'dark_on', name: t('切到深色'), hint: t('站点切换到深色模式时触发。'), fields: [] },
   { type: 'dark_off', name: t('切到浅色'), hint: t('站点切换到浅色模式时触发。'), fields: [] },
   { type: 'always', name: t('随时'), hint: t('任何一次求值都触发（适合与条件配合）。'), fields: [] },
 ];
 
 /** 目录中文在读取时翻译，切换语言后立即生效（见 i18n/live.ts）。 */
 export const LOGIC_TRIGGERS = liveCatalog(RAW_LOGIC_TRIGGERS);
 
+/**
+ * `is_mobile` / `is_desktop` 的提示文案。
+ *
+ * 阈值与编排器共用同一张断点表（`lib/layout.ts` 的 `BREAKPOINT_MD`），
+ * 文案里的数字由常量拼出，改断点时提示不会和实际行为脱节。
+ */
+const MOBILE_HINT = `视口宽度 < ${BREAKPOINT_MD}px。`;
+const DESKTOP_HINT = `视口宽度 ≥ ${BREAKPOINT_MD}px。`;
+
 const RAW_LOGIC_CONDITIONS: StepDef[] = [
-  { type: 'is_mobile', name: t('是手机访问'), hint: t('视口宽度 < 768px。'), fields: [] },
-  { type: 'is_desktop', name: t('是桌面访问'), hint: t('视口宽度 ≥ 768px。'), fields: [] },
+  { type: 'is_mobile', name: t('是手机访问'), hint: t(MOBILE_HINT), fields: [] },
+  { type: 'is_desktop', name: t('是桌面访问'), hint: t(DESKTOP_HINT), fields: [] },
   { type: 'is_logged_in', name: t('已登录'), hint: t('当前有会话。'), fields: [] },
   { type: 'is_anonymous', name: t('未登录'), hint: t('访客状态。'), fields: [] },
   { type: 'is_personal', name: t('是个人博客'), hint: t('站点形态为个人博客。'), fields: [] },
   { type: 'is_dark', name: t('当前是深色'), hint: t('主题模式为深色。'), fields: [] },
   { type: 'is_light', name: t('当前是浅色'), hint: t('主题模式为浅色。'), fields: [] },
   { type: 'is_home', name: t('在首页'), hint: t('当前路径是首页。'), fields: [] },
 ];
 
diff --git a/apps/web/src/lib/screenLayout.test.ts b/apps/web/src/lib/screenLayout.test.ts
index 24e9c1c..10ec49b 100644
--- a/apps/web/src/lib/screenLayout.test.ts
+++ b/apps/web/src/lib/screenLayout.test.ts
@@ -25,16 +25,22 @@ function layoutWithDevices() {
 
 describe('按设备选择页面编排', () => {
   it('按宽度归类设备', () => {
     expect(builderDeviceForWidth(1440)).toBe('desktop');
     expect(builderDeviceForWidth(900)).toBe('tablet');
     expect(builderDeviceForWidth(390)).toBe('mobile');
   });
 
+  it('编排器与思维链共用同一张断点表（手机阈值 768）', () => {
+    // P1 把 640 收敛到 BREAKPOINT_MD：700px 以前算平板，现在算手机。
+    expect(builderDeviceForWidth(700)).toBe('mobile');
+    expect(builderDeviceForWidth(768)).toBe('tablet');
+  });
+
   it('开启分割后取对应设备，缺失设备回退桌面', () => {
     const layout = layoutWithDevices();
     expect(screenBlocksForDevice(layout, 'desktop')[0].title).toBe('桌面文案');
     expect(screenBlocksForDevice(layout, 'mobile')[0].title).toBe('手机文案');
     expect(screenBlocksForDevice(layout, 'tablet')[0].title).toBe('桌面文案');
   });
 
   it('关闭分割时始终共用 blocks', () => {
diff --git a/apps/web/src/types.ts b/apps/web/src/types.ts
index 005bb8f..5a9db13 100644
--- a/apps/web/src/types.ts
+++ b/apps/web/src/types.ts
@@ -867,16 +867,24 @@ export interface BlockInstance {
   /** 内置条件显示；渲染期求值，刷新后仍然生效。 */
   visible?: BlockVisibility;
   /** 目录 / 跳转锚点。 */
   anchor?: string;
   /** 栅格占位；与 width 同时存在时 span 优先。 */
   span?: BlockSpan;
   /** 栅格起始列偏移。 */
   offset?: BlockSpan;
+  /** 子区块在栅格里的水平对齐（P1）。 */
+  align?: 'left' | 'center' | 'right';
+  /** 栅格间距档位（P1，作用于 grid 容器）。 */
+  gap_scale?: number;
+  /** 上外边距档位（P1，间距标尺的下标）。 */
+  mt?: number;
+  /** 下外边距档位（P1，间距标尺的下标）。 */
+  mb?: number;
 }
 
 /** 夜航双栏布局的落位。 */
 export type BlockArea = 'full' | 'main' | 'side';
 
 /** 页面编排里可单独设置的设备。 */
 export type BuilderDevice = 'desktop' | 'tablet' | 'mobile';
 
