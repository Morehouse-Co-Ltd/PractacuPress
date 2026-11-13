# Web Task 5 review package

## Commits

93311f1 feat(web): add the media property type and a media library picker

## Diff

diff --git a/apps/web/src/components/builder/BlockProps.tsx b/apps/web/src/components/builder/BlockProps.tsx
index 76fe92d..553774b 100644
--- a/apps/web/src/components/builder/BlockProps.tsx
+++ b/apps/web/src/components/builder/BlockProps.tsx
@@ -1,14 +1,16 @@
+import { useState } from 'react';
 import type { BlockInstance, BlockProps as BlockPropsValue, BlockPropValue } from '../../types';
 import { blockDef, blockProp, type PropSchema } from '../../lib/blocks';
 import { BLOCK_DATA_SOURCES, bindKeyOf, boundToken } from '../../lib/blocksData';
 import { blockPropRecord } from '../../lib/customize';
 import { useT } from '../../lib/i18n';
-import { Field, Input, Select, Textarea, Toggle } from '../ui';
+import { Button, Field, Input, Select, Textarea, Toggle } from '../ui';
+import { MediaPicker } from './MediaPicker';
 
 /**
  * 区块属性编辑器：完全由 BLOCK_DEFS 里的 schema 驱动。
  * 新增组件不需要改这里——只要在注册表里声明 schema，表单自动生成。
  */
 
 /**
  * 「显示什么数据」下拉。
@@ -51,16 +53,17 @@ function PropControl({
   onChange,
 }: {
   block: BlockInstance;
   schema: PropSchema;
   onChange: (key: string, value: BlockPropValue) => void;
 }) {
   const t = useT();
   const id = `blk-${block.id}-${schema.key}`;
+  const [pickerOpen, setPickerOpen] = useState(false);
 
   if (schema.type === 'repeater') {
     const items = blockPropRecord(block, schema.key);
     const max = schema.maxItems ?? 30;
     const min = schema.minItems ?? 0;
     const commit = (next: Record<string, string | number | boolean>[]) =>
       onChange(schema.key, next.slice(0, max));
 
@@ -140,16 +143,38 @@ function PropControl({
           >
             {t('添加{label}', { label: schema.itemLabel ?? t('条目') })}
           </button>
         </div>
       </Field>
     );
   }
 
+  if (schema.type === 'media') {
+    return (
+      <Field label={schema.label} hint={schema.hint} htmlFor={id}>
+        <div className="media-field">
+          <Input
+            id={id}
+            value={String(block.props[schema.key] ?? '')}
+            onChange={(event) => onChange(schema.key, event.target.value)}
+          />
+          <Button variant="secondary" size="sm" onClick={() => setPickerOpen(true)}>
+            {t('从媒体库选择')}
+          </Button>
+        </div>
+        <MediaPicker
+          open={pickerOpen}
+          onClose={() => setPickerOpen(false)}
+          onPick={(url) => onChange(schema.key, url)}
+        />
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
diff --git a/apps/web/src/components/builder/MediaPicker.tsx b/apps/web/src/components/builder/MediaPicker.tsx
new file mode 100644
index 0000000..24ec4fc
--- /dev/null
+++ b/apps/web/src/components/builder/MediaPicker.tsx
@@ -0,0 +1,78 @@
+import { useEffect, useState } from 'react';
+import type { Asset } from '../../types';
+import { useBackend } from '../../lib/backend';
+import { useT } from '../../lib/i18n';
+import { Button, Modal } from '../ui';
+
+/**
+ * 媒体库选择器。
+ *
+ * 只列已扫描通过（`scan_status === 'clean'`）的资产：拒绝与待审的资产连管理员
+ * 也不该拖进版面。返回值是资产的展示地址，区块里只存这个字符串。
+ */
+export function MediaPicker({
+  open,
+  onClose,
+  onPick,
+}: {
+  open: boolean;
+  onClose: () => void;
+  onPick: (url: string) => void;
+}) {
+  const t = useT();
+  const backend = useBackend();
+  const [assets, setAssets] = useState<Asset[]>([]);
+  const [error, setError] = useState('');
+  const [loading, setLoading] = useState(false);
+
+  useEffect(() => {
+    if (!open) return;
+    let alive = true;
+    setLoading(true);
+    setError('');
+    backend
+      .listAssets()
+      .then((items) => {
+        if (!alive) return;
+        setAssets(items.filter((asset) => asset.scan_status === 'clean' && asset.url));
+      })
+      .catch(() => {
+        if (alive) setError(t('读不到媒体库，检查登录状态或后端是否在线。'));
+      })
+      .finally(() => {
+        if (alive) setLoading(false);
+      });
+    return () => {
+      alive = false;
+    };
+  }, [open, backend, t]);
+
+  return (
+    <Modal open={open} title={t('从媒体库选择')} onClose={onClose}>
+      {loading ? <p className="field-hint">{t('正在读取媒体库…')}</p> : null}
+      {error ? <p className="field-hint">{error}</p> : null}
+      {!loading && !error && assets.length === 0 ? (
+        <p className="field-hint">{t('媒体库还是空的，先去「媒体」页上传图片。')}</p>
+      ) : null}
+      <div className="media-picker-grid">
+        {assets.map((asset) => (
+          <button
+            key={asset.id}
+            type="button"
+            className="media-picker-item"
+            onClick={() => {
+              onPick(asset.url ?? '');
+              onClose();
+            }}
+          >
+            <img src={asset.url} alt={asset.file_name ?? ''} loading="lazy" />
+            <span>{asset.file_name ?? asset.id}</span>
+          </button>
+        ))}
+      </div>
+      <Button variant="secondary" onClick={onClose}>
+        {t('取消')}
+      </Button>
+    </Modal>
+  );
+}
diff --git a/apps/web/src/lib/blocks.ts b/apps/web/src/lib/blocks.ts
index d27c831..bf8de11 100644
--- a/apps/web/src/lib/blocks.ts
+++ b/apps/web/src/lib/blocks.ts
@@ -25,17 +25,19 @@ export type PropType =
   | 'textarea'
   | 'number'
   | 'select'
   | 'toggle'
   | 'color'
   /** 旧的结构化列表：JSON 字符串。只为读取既有配置保留。 */
   | 'itemlist'
   /** 结构化列表：值是条目数组，子字段由 itemSchema 递归声明。 */
-  | 'repeater';
+  | 'repeater'
+  /** 媒体库选择器：值只接受站内媒体地址、http(s) 或 / 开头的站内路径。 */
+  | 'media';
 
 export interface PropSchema {
   key: string;
   label: string;
   type: PropType;
   hint?: string;
   options?: { value: string; label: string }[];
   min?: number;
@@ -662,17 +664,22 @@ const RAW_BLOCK_DEFS: BlockDefinition[] = [
         key: 'source',
         label: t('图片来源'),
         type: 'select',
         options: [
           { value: 'url', label: t('图片地址') },
           { value: 'color', label: t('纯色块') },
         ],
       },
-      { key: 'src', label: t('图片地址'), type: 'text' },
+      {
+        key: 'src',
+        label: t('图片地址'),
+        type: 'media',
+        hint: t('可以从媒体库选，也可以填外部图片地址。'),
+      },
       { key: 'color', label: t('纯色'), type: 'color', hint: t('纯色模式下作为界面背景或占位块。') },
       { key: 'alt', label: t('替代文字'), type: 'text' },
       { key: 'caption', label: t('说明'), type: 'text' },
       { key: 'link', label: t('点击链接'), type: 'text' },
       {
         key: 'ratio',
         label: t('比例'),
         type: 'select',
diff --git a/apps/web/src/lib/customize.ts b/apps/web/src/lib/customize.ts
index cfbf4c8..bb563e4 100644
--- a/apps/web/src/lib/customize.ts
+++ b/apps/web/src/lib/customize.ts
@@ -753,16 +753,31 @@ const UNSAFE_BIND_TARGETS = new Set(['__proto__', 'constructor', 'prototype']);
 function boundScalar(key: string, value: unknown): string | null {
   if (!key.startsWith(BIND_KEY_PREFIX) || key.length > 120) return null;
   const target = key.slice(BIND_KEY_PREFIX.length);
   if (!target || UNSAFE_BIND_TARGETS.has(target)) return null;
   const scalar = scalarValue(value);
   return typeof scalar === 'string' && scalar ? scalar.slice(0, 80) : null;
 }
 
+/**
+ * 媒体地址白名单。
+ *
+ * 只接受站内媒体端点、http(s) 绝对地址与 / 开头的站内路径；
+ * `data:` 与 `javascript:` 一律拒绝——区块里的内联图片会把 1 MiB 的设计预算瞬间撑爆。
+ */
+export function normalizeMediaUrl(value: unknown): string | undefined {
+  if (typeof value !== 'string') return undefined;
+  const url = value.trim();
+  if (!url || url.length > 2048) return undefined;
+  if (url.startsWith('/api/v1/media/') || url.startsWith('/')) return url.slice(0, 2048);
+  if (/^https?:\/\//i.test(url)) return url.slice(0, 2048);
+  return undefined;
+}
+
 /**
  * 按注册表 schema 递归白名单清洗属性。
  *
  * 未在 schema 里声明的键一律丢弃——服务端只存不解释，白名单只能在前端这一层做。
  * 不认识的区块类型退化成「只保留标量」，保证从更新版本导入的配置不会丢内容。
  *
  * 输出按「写入时的键顺序」排列，而不是 schema 顺序：blocks.ts 里 defaults 的字面量
  * 顺序与 schema 顺序并不总是一致（bento-hero、spotlight、stats 都是如此），按 schema
@@ -788,16 +803,26 @@ export function normalizeBlockProps(type: string, value: unknown): BlockProps {
       if (bound !== null) out[key] = bound;
       continue;
     }
     if (field.type === 'repeater') {
       const list = normalizeRepeaterValue(item, field);
       if (list) out[key] = list;
       continue;
     }
+    if (field.type === 'media') {
+      // 空值是新建区块的默认状态：保留成空串，否则读一次就少一个键。
+      if (typeof item === 'string' && !item.trim()) {
+        out[key] = '';
+        continue;
+      }
+      const media = normalizeMediaUrl(item);
+      if (media) out[key] = media;
+      continue;
+    }
     const scalar = scalarValue(item);
     if (scalar !== undefined) out[key] = scalar;
   }
   return out;
 }
 
 /** 读 repeater 值；坏数据一律返回空数组，渲染器不需要防御。 */
 export function blockPropRecord(block: Pick<BlockInstance, 'props'>, key: string): BlockPropRecord[] {
diff --git a/apps/web/src/lib/mediaProps.test.ts b/apps/web/src/lib/mediaProps.test.ts
new file mode 100644
index 0000000..de9ca10
--- /dev/null
+++ b/apps/web/src/lib/mediaProps.test.ts
@@ -0,0 +1,32 @@
+import { describe, expect, it } from 'vitest';
+import { normalizeBlockProps, normalizeMediaUrl } from './customize';
+
+describe('normalizeMediaUrl', () => {
+  it('接受站内媒体地址、绝对 http(s) 与站内路径', () => {
+    expect(normalizeMediaUrl('/api/v1/media/abc')).toBe('/api/v1/media/abc');
+    expect(normalizeMediaUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
+    expect(normalizeMediaUrl('/img/a.png')).toBe('/img/a.png');
+  });
+
+  it('拒绝 data URL、javascript 与相对路径', () => {
+    expect(normalizeMediaUrl('data:image/png;base64,AAAA')).toBeUndefined();
+    expect(normalizeMediaUrl('javascript:alert(1)')).toBeUndefined();
+    expect(normalizeMediaUrl('img/a.png')).toBeUndefined();
+    expect(normalizeMediaUrl('')).toBeUndefined();
+  });
+});
+
+describe('image 区块的 src', () => {
+  it('走 media 白名单', () => {
+    const props = normalizeBlockProps('image', { src: 'data:image/png;base64,AAAA', alt: '图' });
+    expect(props.src).toBeUndefined();
+    expect(props.alt).toBe('图');
+  });
+
+  // 新建图片区块的默认 src 是空串。空串不是可展示的媒体地址，但它必须留在
+  // props 里：否则同一份默认值读一次就少一个键，表单与导出都会抖动。
+  it('空 src 读入后仍然保留', () => {
+    const props = normalizeBlockProps('image', { src: '   ', alt: '' });
+    expect(props.src).toBe('');
+  });
+});
diff --git a/apps/web/src/styles.css b/apps/web/src/styles.css
index 5d0bb8f..65780b2 100644
--- a/apps/web/src/styles.css
+++ b/apps/web/src/styles.css
@@ -5229,16 +5229,47 @@ kbd {
   background: var(--bg);
   padding: 6px 8px;
   font-size: 12.5px;
   color: var(--ink);
   font-family: inherit;
 }
 .itemlist-field input[type="color"] { width: 46px; height: 30px; padding: 2px; cursor: pointer; }
 
+/* 媒体选择：输入框 + 「从媒体库选择」按钮，弹窗里是干净的资产缩略图网格。 */
+.media-field { display: flex; gap: 8px; align-items: center; }
+.media-field input { flex: 1; }
+.media-picker-grid {
+  display: grid;
+  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
+  gap: 8px;
+  max-height: 320px;
+  overflow: auto;
+  margin: 12px 0;
+}
+.media-picker-item {
+  display: flex;
+  flex-direction: column;
+  gap: 4px;
+  padding: 6px;
+  border: 1px solid var(--line);
+  border-radius: 8px;
+  background: var(--bg-subtle);
+  cursor: pointer;
+  text-align: left;
+}
+.media-picker-item img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; border-radius: 6px; }
+.media-picker-item span {
+  font-size: 11px;
+  color: var(--muted);
+  overflow: hidden;
+  text-overflow: ellipsis;
+  white-space: nowrap;
+}
+
 /* 令牌 */
 .token-list { display: flex; flex-direction: column; gap: 8px; }
 .token-row {
   display: flex;
   align-items: center;
   gap: 14px;
   justify-content: space-between;
   border: 1px solid var(--line);
