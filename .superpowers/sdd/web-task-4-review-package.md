# Web Task 4 review package

## Commits

ff5fa50 feat(web): add repeater property schema and migrate the button block to it

## Diff (contains FOREIGN WIP from other sessions - see scope)

diff --git a/apps/web/src/components/blocks/ActionBlocks.tsx b/apps/web/src/components/blocks/ActionBlocks.tsx
new file mode 100644
index 0000000..12ce589
--- /dev/null
+++ b/apps/web/src/components/blocks/ActionBlocks.tsx
@@ -0,0 +1,81 @@
+import type { ReactElement } from 'react';
+import type { BlockInstance } from '../../types';
+import { blockProp } from '../../lib/blocks';
+import { blockPropRecord } from '../../lib/customize';
+import { isExternalUrl, safeUrl } from '../../lib/safeUrl';
+import { useT } from '../../lib/i18n';
+
+/**
+ * 页面编排器的行动按钮区块。
+ *
+ * 一个区块最多四颗按钮，横向排成一行：对齐与尺寸是区块级属性，每颗按钮的
+ * 样式是条目级属性。链接在渲染前过一遍 `safeUrl()`，只放行 http(s) 与站内
+ * 绝对路径；过滤后没有链接的按钮降级成不可点击的占位（保留样式，不响应点击）。
+ *
+ * 外链是否新窗口打开由 `new_tab` 决定，站内跳转始终留在当前标签页；新窗口
+ * 一律带 `rel="noreferrer noopener"`，防止目标页拿到 window.opener。
+ */
+
+const ALIGNS = ['left', 'center', 'right'] as const;
+const SIZES = ['sm', 'md', 'lg'] as const;
+const STYLES = ['solid', 'outline', 'ghost', 'link'] as const;
+
+type Align = (typeof ALIGNS)[number];
+type Size = (typeof SIZES)[number];
+type BtnStyle = (typeof STYLES)[number];
+
+/** 取白名单里的值；坏的/旧的手写值退回默认档位，不改变排版基调。 */
+function pick<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
+  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
+}
+
+function ButtonBlock({ block }: { block: BlockInstance }): ReactElement {
+  const t = useT();
+  // 面板限 4 个；旧配置可能超编，渲染时再截断一次。
+  const items = blockPropRecord(block, 'buttons').slice(0, 4);
+  const align = pick<Align>(blockProp<string>(block, 'align', 'left'), ALIGNS, 'left');
+  const size = pick<Size>(blockProp<string>(block, 'size', 'md'), SIZES, 'md');
+  const newTab = blockProp(block, 'new_tab', false);
+
+  if (!items.length) {
+    return <div className="pp-media-empty">{t('在右侧添加按钮后显示。')}</div>;
+  }
+
+  return (
+    <div className={`pp-action-buttons pp-action-${align}`}>
+      {items.map((item, index) => {
+        const label = String(item.label ?? '').trim() || t('按钮');
+        const link = safeUrl(item.link);
+        const style = pick<BtnStyle>(String(item.style ?? ''), STYLES, 'solid');
+        const className = `pp-action-btn is-${style} is-${size}`;
+        if (!link) {
+          // 没填链接：只留样式占位，明确不可点击。
+          return (
+            <span key={index} className={className} aria-disabled="true">
+              {label}
+            </span>
+          );
+        }
+        const external = isExternalUrl(link) && newTab;
+        return (
+          <a
+            key={index}
+            className={className}
+            href={link}
+            target={external ? '_blank' : undefined}
+            rel={external ? 'noreferrer noopener' : undefined}
+          >
+            {label}
+          </a>
+        );
+      })}
+    </div>
+  );
+}
+
+export const ACTION_RENDERERS: Record<
+  string,
+  (props: { block: BlockInstance }) => ReactElement | null
+> = {
+  button: ButtonBlock,
+};
diff --git a/apps/web/src/components/builder/BlockProps.tsx b/apps/web/src/components/builder/BlockProps.tsx
index d14b8ea..76fe92d 100644
--- a/apps/web/src/components/builder/BlockProps.tsx
+++ b/apps/web/src/components/builder/BlockProps.tsx
@@ -1,30 +1,155 @@
-import type { BlockInstance } from '../../types';
+import type { BlockInstance, BlockProps as BlockPropsValue, BlockPropValue } from '../../types';
 import { blockDef, blockProp, type PropSchema } from '../../lib/blocks';
+import { BLOCK_DATA_SOURCES, bindKeyOf, boundToken } from '../../lib/blocksData';
+import { blockPropRecord } from '../../lib/customize';
 import { useT } from '../../lib/i18n';
 import { Field, Input, Select, Textarea, Toggle } from '../ui';
 
 /**
  * 区块属性编辑器：完全由 BLOCK_DEFS 里的 schema 驱动。
  * 新增组件不需要改这里——只要在注册表里声明 schema，表单自动生成。
  */
 
+/**
+ * 「显示什么数据」下拉。
+ *
+ * 第一项是「自定义文字」（把绑定清空，回到手写）；其余是当前文章 / 站点的
+ * 数据源。选中后写 `props['bind:' + key]`，输入框变成只读并保留原来的文字——
+ * 拿不到数据时（首页、加载中、404）它就自动回退成这句手写文字。
+ */
+function BindPicker({
+  block,
+  schema,
+  onChange,
+}: {
+  block: BlockInstance;
+  schema: PropSchema;
+  onChange: (key: string, value: BlockPropValue) => void;
+}) {
+  const t = useT();
+  const token = boundToken(block.props, schema.key);
+  return (
+    <Select
+      value={token}
+      aria-label={t('显示什么数据')}
+      title={t('显示什么数据')}
+      onChange={(event) => onChange(bindKeyOf(schema.key), event.target.value)}
+    >
+      <option value="">{t('自定义文字')}</option>
+      {BLOCK_DATA_SOURCES.map((source) => (
+        <option key={source.token} value={source.token}>
+          {source.label}
+        </option>
+      ))}
+    </Select>
+  );
+}
+
 function PropControl({
   block,
   schema,
   onChange,
 }: {
   block: BlockInstance;
   schema: PropSchema;
-  onChange: (key: string, value: string | number | boolean) => void;
+  onChange: (key: string, value: BlockPropValue) => void;
 }) {
   const t = useT();
   const id = `blk-${block.id}-${schema.key}`;
 
+  if (schema.type === 'repeater') {
+    const items = blockPropRecord(block, schema.key);
+    const max = schema.maxItems ?? 30;
+    const min = schema.minItems ?? 0;
+    const commit = (next: Record<string, string | number | boolean>[]) =>
+      onChange(schema.key, next.slice(0, max));
+
+    return (
+      <Field
+        label={schema.label}
+        hint={schema.hint ?? t('最多 {count} 条。', { count: max })}
+        aside={`${items.length}/${max}`}
+      >
+        <div className="itemlist">
+          {items.map((item, index) => (
+            <div className="itemlist-row" key={index}>
+              {(schema.itemSchema ?? []).map((field) => {
+                const label = t('{label} 第 {index} 条 {field}', {
+                  label: schema.label,
+                  index: index + 1,
+                  field: field.label,
+                });
+                const update = (value: string | number | boolean) => {
+                  commit(items.map((entry, i) => (i === index ? { ...entry, [field.key]: value } : entry)));
+                };
+                return (
+                  <label key={field.key} className="itemlist-field">
+                    <span>{field.label}</span>
+                    {field.type === 'select' ? (
+                      <select
+                        value={String(item[field.key] ?? '')}
+                        onChange={(event) => update(event.target.value)}
+                        aria-label={label}
+                      >
+                        <option value="">—</option>
+                        {(field.options ?? []).map((option) => (
+                          <option key={option.value} value={option.value}>
+                            {option.label}
+                          </option>
+                        ))}
+                      </select>
+                    ) : field.type === 'toggle' ? (
+                      <input
+                        type="checkbox"
+                        checked={item[field.key] === true}
+                        onChange={(event) => update(event.target.checked)}
+                        aria-label={label}
+                      />
+                    ) : (
+                      <input
+                        type={field.type === 'color' ? 'color' : 'text'}
+                        value={String(item[field.key] ?? '')}
+                        onChange={(event) => update(event.target.value)}
+                        aria-label={label}
+                      />
+                    )}
+                  </label>
+                );
+              })}
+              <button
+                type="button"
+                className="link-btn"
+                disabled={items.length <= min}
+                onClick={() => commit(items.filter((_, i) => i !== index))}
+              >
+                {t('删除')}
+              </button>
+            </div>
+          ))}
+          <button
+            type="button"
+            className="btn btn-secondary btn-sm"
+            disabled={items.length >= max}
+            onClick={() => {
+              const blank: Record<string, string | number | boolean> = {};
+              for (const field of schema.itemSchema ?? []) {
+                blank[field.key] = field.type === 'toggle' ? false : '';
+              }
+              commit([...items, blank]);
+            }}
+          >
+            {t('添加{label}', { label: schema.itemLabel ?? t('条目') })}
+          </button>
+        </div>
+      </Field>
+    );
+  }
+
   if (schema.type === 'itemlist') {
     const raw = typeof block.props[schema.key] === 'string' ? (block.props[schema.key] as string) : '';
     let items: Record<string, string>[] = [];
     try {
       const parsed = JSON.parse(raw) as unknown;
       if (Array.isArray(parsed)) {
         items = parsed
           .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
@@ -48,36 +173,51 @@ function PropControl({
       <Field
         label={schema.label}
         hint={schema.hint ?? t('最多 {count} 条。', { count: schema.maxItems ?? 30 })}
         aside={`${items.length}/${schema.maxItems ?? 30}`}
       >
         <div className="itemlist">
           {items.map((item, index) => (
             <div className="itemlist-row" key={index}>
-              {(schema.itemFields ?? []).map((field) => (
-                <label key={field.key} className="itemlist-field">
-                  <span>{field.label}</span>
-                  <input
-                    type={field.type === 'color' ? 'color' : 'text'}
-                    value={item[field.key] ?? ''}
-                    onChange={(event) => {
-                      const next = items.map((entry, i) =>
-                        i === index ? { ...entry, [field.key]: event.target.value } : entry,
-                      );
-                      commit(next);
-                    }}
-                    aria-label={t('{label} 第 {index} 条 {field}', {
-                      label: schema.label,
-                      index: index + 1,
-                      field: field.label,
-                    })}
-                  />
-                </label>
-              ))}
+              {(schema.itemFields ?? []).map((field) => {
+                const label = t('{label} 第 {index} 条 {field}', {
+                  label: schema.label,
+                  index: index + 1,
+                  field: field.label,
+                });
+                const update = (value: string) => {
+                  const next = items.map((entry, i) =>
+                    i === index ? { ...entry, [field.key]: value } : entry,
+                  );
+                  commit(next);
+                };
+                return (
+                  <label key={field.key} className="itemlist-field">
+                    <span>{field.label}</span>
+                    {field.type === 'select' ? (
+                      <select value={item[field.key] ?? ''} onChange={(event) => update(event.target.value)} aria-label={label}>
+                        <option value="">—</option>
+                        {(field.options ?? []).map((option) => (
+                          <option key={option.value} value={option.value}>
+                            {option.label}
+                          </option>
+                        ))}
+                      </select>
+                    ) : (
+                      <input
+                        type={field.type === 'color' ? 'color' : 'text'}
+                        value={item[field.key] ?? ''}
+                        onChange={(event) => update(event.target.value)}
+                        aria-label={label}
+                      />
+                    )}
+                  </label>
+                );
+              })}
               <button
                 type="button"
                 className="link-btn"
                 onClick={() => commit(items.filter((_, i) => i !== index))}
               >
                 {t('删除')}
               </button>
             </div>
@@ -161,45 +301,63 @@ function PropControl({
           />
           <code>{String(block.props[schema.key] ?? '')}</code>
         </div>
       </Field>
     );
   }
 
   if (schema.type === 'textarea') {
+    const bound = !!boundToken(block.props, schema.key);
     return (
-      <Field label={schema.label} hint={schema.hint} htmlFor={id}>
+      <Field
+        label={schema.label}
+        hint={bound ? t('由数据自动填充，回到「自定义文字」可以手改。') : schema.hint}
+        htmlFor={id}
+      >
+        {schema.bindable === false ? null : (
+          <BindPicker block={block} schema={schema} onChange={onChange} />
+        )}
         <Textarea
           id={id}
           value={String(block.props[schema.key] ?? '')}
+          disabled={bound}
           onChange={(event) => onChange(schema.key, event.target.value)}
           style={{ minHeight: 76 }}
         />
       </Field>
     );
   }
 
+  const bound = !!boundToken(block.props, schema.key);
   return (
-    <Field label={schema.label} hint={schema.hint} htmlFor={id}>
+    <Field
+      label={schema.label}
+      hint={bound ? t('由数据自动填充，回到「自定义文字」可以手改。') : schema.hint}
+      htmlFor={id}
+    >
+      {schema.bindable === false ? null : (
+        <BindPicker block={block} schema={schema} onChange={onChange} />
+      )}
       <Input
         id={id}
         value={String(block.props[schema.key] ?? '')}
+        disabled={bound}
         onChange={(event) => onChange(schema.key, event.target.value)}
       />
     </Field>
   );
 }
 
 export function BlockProps({
   block,
   onChange,
 }: {
   block: BlockInstance;
-  onChange: (props: Record<string, string | number | boolean>) => void;
+  onChange: (props: BlockPropsValue) => void;
 }) {
   const t = useT();
   const def = blockDef(block.type);
   if (!def) return <p className="field-hint">{t('这个组件类型已不存在，删除它再添加新的。')}</p>;
   if (!def.schema.length) return <p className="field-hint">{t('这个组件没有可配置的属性。')}</p>;
 
   return (
     <div className="form-stack">
diff --git a/apps/web/src/lib/blocks.ts b/apps/web/src/lib/blocks.ts
index 119b2a6..d27c831 100644
--- a/apps/web/src/lib/blocks.ts
+++ b/apps/web/src/lib/blocks.ts
@@ -1,54 +1,80 @@
 import type {
   BlockAnimation,
   BlockArea,
   BlockInstance,
+  BlockProps,
   BuilderDevice,
   LayoutVariant,
   ScreenLayout,
 } from '../types';
 import { t } from './i18n';
 import { liveCatalog } from './i18n/live';
 import { IMAGE_RADIUS_OPTIONS } from './imageRadius';
 
 /**
  * 无代码区块注册表（数据侧）。
  *
  * 每个区块 = 一个默认组件 + 属性模式（schema）+ 默认值。渲染器在
  * `components/blocks/`，后台编辑器的表单由 schema 驱动，因此新增组件
- * 不需要改编辑器代码。属性值只允许标量（itemlist 存 JSON 字符串），
+ * 不需要改编辑器代码。属性值只允许标量或 repeater（条目数组），
  * 保证整份配置可以导入导出。
  */
 
-export type PropType = 'text' | 'textarea' | 'number' | 'select' | 'toggle' | 'color' | 'itemlist';
+export type PropType =
+  | 'text'
+  | 'textarea'
+  | 'number'
+  | 'select'
+  | 'toggle'
+  | 'color'
+  /** 旧的结构化列表：JSON 字符串。只为读取既有配置保留。 */
+  | 'itemlist'
+  /** 结构化列表：值是条目数组，子字段由 itemSchema 递归声明。 */
+  | 'repeater';
 
 export interface PropSchema {
   key: string;
   label: string;
   type: PropType;
   hint?: string;
   options?: { value: string; label: string }[];
   min?: number;
   max?: number;
   step?: number;
   /** itemlist：条目字段，例如 [{ key: 'label', label: '名称' }] */
-  itemFields?: { key: string; label: string; type?: 'text' | 'color' }[];
+  itemFields?: {
+    key: string;
+    label: string;
+    /** select 用于「每个条目的样式/类型」这类有限选项。 */
+    type?: 'text' | 'color' | 'select';
+    /** type === 'select' 时的选项。 */
+    options?: { value: string; label: string }[];
+  }[];
   itemLabel?: string;
   maxItems?: number;
+  /** repeater：每个条目的字段，复用同一套 PropSchema（不允许再嵌 repeater）。 */
+  itemSchema?: PropSchema[];
+  minItems?: number;
+  /**
+   * 这个字段能不能绑定成「显示什么数据」（只对 text / textarea 生效）。
+   * 代码类字段（CSS、HTML、JS）默认关掉：把文章标题塞进样式表没有意义。
+   */
+  bindable?: boolean;
 }
 
 export interface BlockDefinition {
   type: string;
   name: string;
   description: string;
   group: 'classic' | 'nightflight' | 'shared';
   /** 出现在哪些布局变体的“添加组件”菜单里。 */
   variants: LayoutVariant[];
-  defaults: Record<string, string | number | boolean>;
+  defaults: BlockProps;
   schema: PropSchema[];
 }
 
 /**
  * 夜航双栏布局里的默认落位。
  * 用户可以在工坊里逐个区块改（BlockInstance.area），这里只是出厂值。
  */
 const AREA_BY_TYPE: Record<string, BlockArea> = {
@@ -427,16 +453,33 @@ const RAW_BLOCK_DEFS: BlockDefinition[] = [
     defaults: { show_count: true, show_days: true, show_words: true },
     schema: [
       { key: 'show_count', label: t('显示文章数'), type: 'toggle' },
       { key: 'show_days', label: t('显示建站天数'), type: 'toggle' },
       { key: 'show_words', label: t('显示总字数'), type: 'toggle' },
     ],
   },
   /* ---------------- 共用 ---------------- */
+  {
+    type: 'article-content',
+    name: t('文章内容'),
+    description: t('文章正文的占位符：在文章页渲染真实正文，其它页面只显示占位提示。'),
+    group: 'shared',
+    variants: ['classic', 'bento'],
+    // 只有开关，没有正文：正文由当前文章提供，编排可以复用到每一篇文章。
+    defaults: { show_toc: false },
+    schema: [
+      {
+        key: 'show_toc',
+        label: t('显示目录'),
+        type: 'toggle',
+        hint: t('目录来自正文里的二级 / 三级标题；「外观 → 目录」已经打开时不会再重复一遍。'),
+      },
+    ],
+  },
   {
     type: 'popular-content',
     name: t('热门文章'),
     description: t('按站内阅读次数排序，适合放在首页或页面侧栏。'),
     group: 'shared',
     variants: ['classic', 'bento'],
     defaults: { heading: '热门文章', limit: 5, show_summary: true, show_meta: true, show_views: true, show_tags: true },
     schema: [
@@ -587,16 +630,17 @@ const RAW_BLOCK_DEFS: BlockDefinition[] = [
           { value: 'right', label: t('右对齐') },
         ],
       },
       { key: 'max_width', label: t('最大宽度'), type: 'number', min: 320, max: 1100, step: 10 },
       {
         key: 'style_css',
         label: t('作用域 CSS'),
         type: 'textarea',
+        bindable: false,
         hint: t('只写声明，例如 font-size: 18px; letter-spacing: .02em; 不会影响其他区块。'),
       },
     ],
   },
   {
     type: 'image',
     name: t('图片'),
     description: t('图片、说明与链接，可单独设置圆角。'),
@@ -885,22 +929,79 @@ const RAW_BLOCK_DEFS: BlockDefinition[] = [
   {
     type: 'code',
     name: t('自定义代码'),
     description: t('HTML + CSS + JS，在独立 sandbox iframe 中运行。'),
     group: 'shared',
     variants: ['classic', 'bento'],
     defaults: { html: '<div class="box">Hello</div>', css: '.box { font-family: sans-serif; padding: 24px; }', js: '', height: 320 },
     schema: [
-      { key: 'html', label: 'HTML', type: 'textarea', hint: t('只能访问这个 iframe 内部，不能读取后台。') },
-      { key: 'css', label: 'CSS', type: 'textarea' },
-      { key: 'js', label: 'JavaScript', type: 'textarea', hint: t('在 sandbox 中执行，不加载外部脚本。') },
+      { key: 'html', label: 'HTML', type: 'textarea', bindable: false, hint: t('只能访问这个 iframe 内部，不能读取后台。') },
+      { key: 'css', label: 'CSS', type: 'textarea', bindable: false },
+      { key: 'js', label: 'JavaScript', type: 'textarea', bindable: false, hint: t('在 sandbox 中执行，不加载外部脚本。') },
       { key: 'height', label: t('高度'), type: 'number', min: 120, max: 900, step: 20 },
     ],
   },
+  {
+    type: 'button',
+    name: t('按钮'),
+    description: t('一组带样式的行动按钮：站内跳转、外部链接、对齐与尺寸都能改。'),
+    group: 'shared',
+    variants: ['classic', 'bento'],
+    defaults: { buttons: [], align: 'left', size: 'md', new_tab: false },
+    schema: [
+      {
+        key: 'buttons',
+        label: t('按钮'),
+        type: 'repeater',
+        itemLabel: t('按钮'),
+        minItems: 1,
+        maxItems: 4,
+        hint: t(
+          '最多 4 个。链接可填 http(s) 地址或以 / 开头的站内路径；留空则只显示样式、不可点击。',
+        ),
+        itemSchema: [
+          { key: 'label', label: t('文字'), type: 'text' },
+          { key: 'link', label: t('链接'), type: 'text' },
+          {
+            key: 'style',
+            label: t('样式'),
+            type: 'select',
+            options: [
+              { value: 'solid', label: t('实心') },
+              { value: 'outline', label: t('描边') },
+              { value: 'ghost', label: t('幽灵') },
+              { value: 'link', label: t('文字链接') },
+            ],
+          },
+        ],
+      },
+      {
+        key: 'align',
+        label: t('对齐'),
+        type: 'select',
+        options: [
+          { value: 'left', label: t('左对齐') },
+          { value: 'center', label: t('居中') },
+          { value: 'right', label: t('右对齐') },
+        ],
+      },
+      {
+        key: 'size',
+        label: t('尺寸'),
+        type: 'select',
+        options: [
+          { value: 'sm', label: t('小') },
+          { value: 'md', label: t('中') },
+          { value: 'lg', label: t('大') },
+        ],
+      },
+      { key: 'new_tab', label: t('外部链接在新窗口打开'), type: 'toggle' },
+    ],
+  },
 ];
 
 /**
  * 区块目录对外的视图。
  *
  * 目录是模块级常量，`t()` 在 import 时就求值了；用 `liveCatalog` 把中文换成
  * 读取时翻译的 getter，切换语言后调色板与属性面板才会跟着变。
  * `defaults` 是新建区块时写进页面 JSON 的初始内容，属于持久化数据，不参与翻译。
@@ -960,16 +1061,42 @@ export function screenBlocksForDevice(
 /** 判断一份编排是否在任意设备下还有可渲染的区块。 */
 export function screenHasBlocks(layout: ScreenLayout): boolean {
   if (layout.blocks.length) return true;
   return Object.values(layout.devices ?? {}).some(
     (entry) => (entry?.blocks.length ?? 0) > 0,
   );
 }
 
+/** 「文章内容」占位符的类型名。 */
+export const ARTICLE_CONTENT_TYPE = 'article-content';
+
+/** 一棵区块树里有没有「文章内容」占位符（含分栏 / 容器里的嵌套区块）。 */
+function treeHasArticleContent(blocks: BlockInstance[]): boolean {
+  return blocks.some(
+    (block) =>
+      !block.hidden &&
+      (block.type === ARTICLE_CONTENT_TYPE || treeHasArticleContent(block.children ?? [])),
+  );
+}
+
+/**
+ * 这份编排里有没有「文章内容」占位符。
+ *
+ * 文章页据此决定正文画在哪：有占位符就把整份编排放在正文的位置，由占位符
+ * 渲染正文；没有就保持旧行为（正文照旧，编排区块排在评论区之后）。
+ * 分设备编排也要查一遍——手机版里可能只有它。
+ */
+export function hasArticleContent(layout: ScreenLayout): boolean {
+  if (treeHasArticleContent(layout.blocks)) return true;
+  return Object.values(layout.devices ?? {}).some((entry) =>
+    treeHasArticleContent(entry?.blocks ?? []),
+  );
+}
+
 /** 深拷贝一份区块编排，供开启分设备时初始化其它设备。 */
 export function cloneBlocks(blocks: BlockInstance[]): BlockInstance[] {
   return JSON.parse(JSON.stringify(blocks)) as BlockInstance[];
 }
 
 /** 按布局变体生成默认首页编排。 */
 export function defaultHomeLayout(variant: LayoutVariant): ScreenLayout {  if (variant === 'bento') {
     return {
diff --git a/apps/web/src/lib/blocksData.ts b/apps/web/src/lib/blocksData.ts
new file mode 100644
index 0000000..8fdcd55
--- /dev/null
+++ b/apps/web/src/lib/blocksData.ts
@@ -0,0 +1,183 @@
+import type { BlockInstance, BlockProps, Content, ContentKind } from '../types';
+import { t } from './i18n';
+import { liveCatalog } from './i18n/live';
+
+/**
+ * 组件文字「显示什么数据」。
+ *
+ * 组件属性里的文字默认是站长手写的；也可以绑定成当前文章的数据（标题、作者、
+ * 发布时间……）。约定只有两条：
+ *
+ * - 绑定关系存在 `props['bind:' + key]`，值是一个稳定的数据 token（`article.title`）；
+ * - 原来的 `props[key]` 保留为**回退文字**：拿不到数据时照常显示，不会出现空白。
+ *
+ * 因此整份配置仍然只有标量，能照常导入导出（见 `lib/customize.ts` 的归一化）。
+ * 解析函数是纯函数，渲染层只需要在 `BlockView` 里算一次，所有组件都能用。
+ */
+
+export const BIND_PREFIX = 'bind:';
+
+/**
+ * 解析数据时需要的上下文。
+ *
+ * 时间之类的展示文案在 Provider 里预先格式化好，这里只做取值，不做格式化——
+ * 这样纯函数不读全局状态，单测可以完全确定。
+ */
+export interface BlockDataContext {
+  /** 当前文章；首页 / 自定义页没有文章。 */
+  article?: Content | null;
+  kind?: ContentKind;
+  /** 文章地址（站内路径），例如 `/a/abc123`。 */
+  url?: string;
+  authorName?: string;
+  /** 「2026.11.02 09:30」这种已经本地化的发布时间文案。 */
+  publishedLabel?: string;
+  updatedLabel?: string;
+  categoryName?: string;
+  tags?: string[];
+  readingMinutes?: number;
+  /** 阅读量；没有统计数据时缺省，界面上回退到手写文字。 */
+  views?: number;
+  siteName?: string;
+  /** 当前年份，由 Provider 注入（不在这里读系统时间，保证纯函数可测）。 */
+  currentYear?: number;
+}
+
+/** 一个可选的数据源。 */
+export interface BlockDataSource {
+  token: string;
+  label: string;
+}
+
+/**
+ * 数据源目录：token 稳定、只增不改，标签随语言变化。
+ *
+ * `liveCatalog` 把中文换成读取时翻译的 getter：切换语言后属性面板的下拉
+ * 不用重新加载就会跟着变（和 `BLOCK_DEFS` 同一套机制）。
+ */
+const RAW_DATA_SOURCES: BlockDataSource[] = [
+  { token: 'article.title', label: t('文章标题') },
+  { token: 'article.summary', label: t('文章摘要') },
+  { token: 'article.author', label: t('作者') },
+  { token: 'article.published_at', label: t('发布时间') },
+  { token: 'article.updated_at', label: t('更新时间') },
+  { token: 'article.category', label: t('分类') },
+  { token: 'article.tags', label: t('标签') },
+  { token: 'article.reading_time', label: t('阅读时长') },
+  { token: 'article.views', label: t('阅读量') },
+  { token: 'article.url', label: t('文章地址') },
+  { token: 'site.name', label: t('站点名') },
+  { token: 'site.year', label: t('当前年份') },
+];
+
+export const BLOCK_DATA_SOURCES: BlockDataSource[] = liveCatalog(RAW_DATA_SOURCES);
+
+/** `bind:` 前缀的键；组件的回退文字键是去掉前缀后的名字。 */
+export function isBindKey(key: string): boolean {
+  return key.startsWith(BIND_PREFIX);
+}
+
+/** 属性键对应的绑定键，例如 `title` → `bind:title`。 */
+export function bindKeyOf(key: string): string {
+  return `${BIND_PREFIX}${key}`;
+}
+
+/** 读取某个属性当前的绑定 token；没有绑定（或不是字符串）返回空串。 */
+export function boundToken(props: BlockProps, key: string): string {
+  const token = props[bindKeyOf(key)];
+  return typeof token === 'string' ? token : '';
+}
+
+/** 能不能写进 props：防止 `bind:__proto__` 这类键污染原型。 */
+const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
+
+function text(value: unknown): string | undefined {
+  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
+}
+
+function articleUrl(article: Content): string {
+  return `/${article.kind === 'article' ? 'a' : 'p'}/${article.id}`;
+}
+
+/**
+ * 把一个数据 token 解析成可显示的文字。
+ *
+ * 拿不到数据（没有文章、字段为空、token 不认识）一律返回 `undefined`，
+ * 调用方据此回退到站长手写的文字；任何输入都不应该抛异常。
+ */
+export function resolveDataToken(
+  token: string,
+  context?: BlockDataContext | null,
+): string | undefined {
+  if (!token || !context) return undefined;
+  const article = context.article ?? undefined;
+  const tags = context.tags ?? article?.tags ?? [];
+
+  switch (token) {
+    case 'article.title':
+      return text(article?.title);
+    case 'article.summary':
+      return text(article?.summary);
+    case 'article.author':
+      return text(context.authorName) ?? text(article?.author_name);
+    case 'article.published_at':
+      return text(context.publishedLabel);
+    case 'article.updated_at':
+      return text(context.updatedLabel);
+    case 'article.category':
+      return text(context.categoryName);
+    case 'article.tags':
+      return tags.length ? tags.join(' · ') : undefined;
+    case 'article.reading_time':
+      return typeof context.readingMinutes === 'number' && context.readingMinutes > 0
+        ? t('{count} 分钟阅读', { count: context.readingMinutes })
+        : undefined;
+    case 'article.views':
+      return typeof context.views === 'number' && context.views > 0
+        ? String(context.views)
+        : undefined;
+    case 'article.url':
+      return text(context.url) ?? (article ? articleUrl(article) : undefined);
+    case 'site.name':
+      return text(context.siteName);
+    case 'site.year':
+      return typeof context.currentYear === 'number'
+        ? String(context.currentYear)
+        : undefined;
+    default:
+      // 旧配置里可能留着已经下线的 token：安静回退，不要炸。
+      return undefined;
+  }
+}
+
+/**
+ * 计算渲染用的属性：把绑定过的键替换成解析出来的数据。
+ *
+ * 纯函数：不修改入参，返回一份新的 props；绑定解析不到时保留原来的回退文字。
+ * `bind:*` 键原样留在结果里，渲染器只读自己认识的键，不会受影响。
+ */
+export function resolveBoundProps(
+  block: Pick<BlockInstance, 'props'>,
+  context?: BlockDataContext | null,
+): BlockProps {
+  const props: BlockProps = { ...block.props };
+  if (!context) return props;
+
+  for (const [key, value] of Object.entries(block.props)) {
+    if (!isBindKey(key)) continue;
+    const target = key.slice(BIND_PREFIX.length);
+    if (!target || UNSAFE_KEYS.has(target)) continue;
+    if (typeof value !== 'string') continue;
+    const resolved = resolveDataToken(value, context);
+    if (resolved === undefined) continue;
+    props[target] = resolved;
+  }
+  return props;
+}
+
+/** 这份属性里有没有任何绑定；渲染层用它避免无谓地复制 props。空 token 视为没绑定。 */
+export function hasBoundProps(props: BlockProps): boolean {
+  return Object.entries(props).some(
+    ([key, value]) => isBindKey(key) && typeof value === 'string' && value !== '',
+  );
+}
diff --git a/apps/web/src/lib/customize.ts b/apps/web/src/lib/customize.ts
index 05fc831..6c54bf4 100644
--- a/apps/web/src/lib/customize.ts
+++ b/apps/web/src/lib/customize.ts
@@ -1,14 +1,16 @@
 import { useCallback, useMemo } from 'react';
 import type {
   ArticleCover,
   BlockAnimation,
   BlockDisplayOverride,
   BlockInstance,
+  BlockPropRecord,
+  BlockProps,
   BlockSpan,
   BlockVisibility,
   BuilderDevice,
   CommentSettings,
   CustomExtension,
   ExtensionId,
   ExtensionPageScope,
   ExtensionPermission,
@@ -41,16 +43,17 @@ import {
   type ThemePreset,
 } from './theme';
 import {
   BUILTIN_THEME_IDS,
   inferActiveTheme,
   normalizeCustomTheme,
 } from './themes';
 import { BLOCK_TYPES, blockDef, createBlock, defaultHomeLayout, nextBlockId } from './blocks';
+import type { PropSchema } from './blocks';
 import { normalizeBlockAppearance } from './blockAppearance';
 import { MAX_BLOCKS, MAX_BLOCK_DEPTH, MAX_CHILDREN_PER_CONTAINER, clampColumn, countBlocks } from './blockTree';
 import {
   defaultFooterColumns,
   normalizeFooterColumns,
   normalizeNavTabs,
   normalizeSocialLinks,
 } from './navigation';
@@ -668,34 +671,146 @@ function blockDisplayFields(raw: Partial<BlockInstance>): Partial<BlockInstance>
     ...(at ? { at } : {}),
     ...(visible ? { visible } : {}),
     ...(anchor ? { anchor } : {}),
     ...(span ? { span } : {}),
     ...(offset ? { offset } : {}),
   };
 }
 
+/**
+ * 一个 repeater 条目：按 itemSchema 逐字段白名单清洗，返回 null 表示这一条是坏数据。
+ *
+ * 条目里缺的字段补成该类型的空值（文本 / 选项 → `''`，开关 → `false`）：旧 itemlist
+ * 的 JSON 往往只写了填过的那几个字段，不补齐的话同一个条目在两次读入后形状不同，
+ * 表单与导出都会抖动。数字缺省时保持缺省——0 是个有意义的数值，不该替用户编出来。
+ */
+function normalizePropRecord(value: unknown, schema: PropSchema[]): BlockPropRecord | null {
+  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
+  const source = value as Record<string, unknown>;
+  const out: BlockPropRecord = {};
+  for (const field of schema) {
+    if (field.type === 'repeater') continue; // 只允许一层
+    const scalar = scalarValue(source[field.key]);
+    if (scalar !== undefined) {
+      out[field.key] = scalar;
+    } else if (field.type === 'toggle') {
+      out[field.key] = false;
+    } else if (field.type !== 'number') {
+      out[field.key] = '';
+    }
+  }
+  return out;
+}
+
+/**
+ * 读一个 repeater 值。
+ *
+ * 兼容两种来源：新配置（真正的数组）与旧 itemlist 配置（JSON 字符串）。
+ * 空数组 / 全是坏条目时返回 undefined，让「没配过」和「配成空」在存储里长得一样。
+ */
+function normalizeRepeaterValue(
+  value: unknown,
+  schema: PropSchema,
+): BlockPropRecord[] | undefined {
+  const fields = schema.itemSchema ?? [];
+  const max = schema.maxItems ?? 30;
+  let list: unknown[] | null = null;
+  if (Array.isArray(value)) {
+    list = value;
+  } else if (typeof value === 'string' && value) {
+    // 旧配置：itemlist 存的就是 JSON 字符串。
+    try {
+      const parsed = JSON.parse(value) as unknown;
+      if (Array.isArray(parsed)) list = parsed;
+    } catch {
+      list = null;
+    }
+  }
+  if (!list) return undefined;
+  const out = list
+    .slice(0, max)
+    .map((item) => normalizePropRecord(item, fields))
+    .filter((item): item is BlockPropRecord => !!item);
+  return out.length ? out : undefined;
+}
+
+/**
+ * 文字绑定键（`bind:title`）的保留。
+ *
+ * 「显示什么数据」把绑定关系直接存在 `props['bind:' + key]` 里（见 lib/blocksData.ts），
+ * 而这些键不是任何 schema 字段。纯按 schema 清洗会把它们整批丢掉——用户选一次数据源、
+ * 保存、再读一次，绑定就没了。所以这里按前缀单独收一遍，值仍然过同一套标量清洗。
+ */
+const BIND_KEY_PREFIX = 'bind:';
+/** 写进 props 的绑定键不能污染原型；与 blocksData.ts 的 UNSAFE_KEYS 同一份名单。 */
+const UNSAFE_BIND_TARGETS = new Set(['__proto__', 'constructor', 'prototype']);
+
+function boundScalars(source: Record<string, unknown>): BlockProps {
+  const out: BlockProps = {};
+  for (const [key, item] of Object.entries(source)) {
+    if (!key.startsWith(BIND_KEY_PREFIX) || key.length > 120) continue;
+    const target = key.slice(BIND_KEY_PREFIX.length);
+    if (!target || UNSAFE_BIND_TARGETS.has(target)) continue;
+    const scalar = scalarValue(item);
+    if (typeof scalar === 'string' && scalar) out[key] = scalar.slice(0, 80);
+  }
+  return out;
+}
+
+/**
+ * 按注册表 schema 递归白名单清洗属性。
+ *
+ * 未在 schema 里声明的键一律丢弃——服务端只存不解释，白名单只能在前端这一层做。
+ * 不认识的区块类型退化成「只保留标量」，保证从更新版本导入的配置不会丢内容。
+ */
+export function normalizeBlockProps(type: string, value: unknown): BlockProps {
+  const def = blockDef(type);
+  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
+  if (!def) {
+    const out: BlockProps = {};
+    for (const [key, item] of Object.entries(source)) {
+      const scalar = scalarValue(item);
+      if (scalar !== undefined) out[key] = scalar;
+    }
+    return out;
+  }
+  const out: BlockProps = boundScalars(source);
+  for (const field of def.schema) {
+    if (field.type === 'repeater') {
+      const list = normalizeRepeaterValue(source[field.key], field);
+      if (list) out[field.key] = list;
+      continue;
+    }
+    const scalar = scalarValue(source[field.key]);
+    if (scalar !== undefined) out[field.key] = scalar;
+  }
+  return out;
+}
+
+/** 读 repeater 值；坏数据一律返回空数组，渲染器不需要防御。 */
+export function blockPropRecord(block: Pick<BlockInstance, 'props'>, key: string): BlockPropRecord[] {
+  const value = block.props[key];
+  return Array.isArray(value) ? value : [];
+}
+
 function normalizeBlock(
   value: unknown,
   depth = 0,
   seen: Set<string> = new Set(),
   budget: { count: number } = { count: 0 },
 ): BlockInstance | null {
   if (!value || typeof value !== 'object' || depth > MAX_BLOCK_DEPTH) return null;
   if (budget.count >= MAX_BLOCKS) return null;
   const raw = value as Partial<BlockInstance>;
   if (typeof raw.type !== 'string' || !raw.type) return null;
   budget.count += 1;
   const known = BLOCK_TYPES.has(raw.type);
 
-  const props: Record<string, string | number | boolean> = {};
-  for (const [key, item] of Object.entries(raw.props ?? {})) {
-    const value = scalarValue(item);
-    if (value !== undefined) props[key] = value;
-  }
+  const props = normalizeBlockProps(raw.type, raw.props);
 
   let id = typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 80) : nextBlockId();
   if (seen.has(id)) id = nextBlockId();
   seen.add(id);
 
   const children = Array.isArray(raw.children)
     ? raw.children
         .slice(0, MAX_CHILDREN_PER_CONTAINER)
diff --git a/apps/web/src/types.ts b/apps/web/src/types.ts
index f8fab98..005bb8f 100644
--- a/apps/web/src/types.ts
+++ b/apps/web/src/types.ts
@@ -815,26 +815,34 @@ export interface BlockAppearance {
   /** `#rgb` / `#rrggbb` / `#rrggbbaa`；空表示透明。 */
   background?: string;
   /** 0–64 px；0 表示不额外留白。 */
   padding?: number;
   /** 用主题细分割线描一圈边框。 */
   border?: boolean;
 }
 
+/** 一个 repeater 条目：只允许标量与字符串。 */
+export type BlockPropRecord = Record<string, string | number | boolean>;
+
+/** 区块属性值：标量或 repeater 的条目数组。 */
+export type BlockPropValue = string | number | boolean | BlockPropRecord[];
+
+export type BlockProps = Record<string, BlockPropValue>;
+
 /**
  * 无代码区块实例：一个默认组件 + 自己的命名、属性覆盖与入场动画。
- * 属性值只允许标量，保证配置可 JSON 序列化、可导入导出。
+ * 属性值只允许标量或 repeater 的条目数组，保证配置可 JSON 序列化、可导入导出。
  */
 export interface BlockInstance {
   id: string;
   type: string;
   /** 后台里的显示名，方便在长编排里认出它。 */
   title: string;
-  props: Record<string, string | number | boolean>;
+  props: BlockProps;
   animation: BlockAnimation;
   hidden: boolean;
   /**
    * 在夜航双栏布局里的位置：整幅（横跨两栏）/ 主栏 / 侧栏。
    * 缺省时按区块类型的默认值决定（见 lib/blocks.ts 的 resolveArea）。
    */
   area?: BlockArea;
   /** 容器类区块的子区块。没有该字段就是普通平铺区块。 */
