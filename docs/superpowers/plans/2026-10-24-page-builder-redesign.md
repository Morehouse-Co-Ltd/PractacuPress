# 页面编排器重做 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把主题工坊改造成三栏实时预览的页面编排器，支持递归嵌套、拖拽、分栏、文本 CSS 和媒体/网站/幻灯片区块。

**Architecture:** 在既有 `BlockInstance` 上增加递归 `children` 和 `column`，用纯函数树操作模块统一增删移动；渲染器递归输出，编辑器左树右属性，中间用同源 iframe 加载真实前台并通过 `postMessage`/`storage` 双向同步。原主题令牌面板迁入外观页，后台固定浅色。

**Tech Stack:** React 19、TypeScript strict、Vite、react-router-dom、Vitest、Playwright、原生 HTML5 拖拽（不新增依赖）。

## Global Constraints

- 不新增任何 npm 运行时依赖。
- 旧 `SiteCustomization` JSON 必须继续可读，没有 `children` 时保持平铺行为。
- 嵌套最大深度 8，整棵树最多 200 个区块；`column` 限定 1–4。
- 文本自定义 CSS 只接受安全声明，不生成全局 `<style>`。
- 所有新增文案使用中文；后台使用浅色外观。
- 每个任务结束运行 `npm run typecheck` 和对应测试；最后运行 `npm run build` 与 Playwright。
- 工作目录：`D:\window\Desktop\Practacu Press\apps\web`。

---

### Task 1: 扩展区块类型与归一化

**Files:**
- Modify: `apps/web/src/types.ts` (BlockInstance)
- Modify: `apps/web/src/lib/customize.ts` (normalizeBlock)
- Modify: `apps/web/src/lib/customize.test.ts` (new test file if absent)
- Create: `apps/web/src/lib/blockTree.ts`
- Create: `apps/web/src/lib/blockTree.test.ts`

**Interfaces:**
- Produces: `BlockInstance.children?: BlockInstance[]`, `BlockInstance.column?: number`.
- Produces: `normalizeBlock` internal recursion, `MAX_BLOCK_DEPTH=8`, `MAX_BLOCKS=200`.
- Produces: tree helpers used by editor and tests.

- [ ] **Step 1: Write failing tests for recursive normalization and tree operations**

```ts
// apps/web/src/lib/blockTree.test.ts
import { describe, expect, it } from 'vitest';
import { createBlock } from './blocks';
import { countBlocks, findBlock, insertBlock, moveBlock, removeBlock, updateBlock } from './blockTree';

const columns = (children = []) => ({ ...createBlock('columns'), children });

describe('blockTree', () => {
  it('finds nested blocks with parent and column', () => {
    const text = createBlock('text');
    const tree = [columns([{ ...text, column: 2 }])];
    const found = findBlock(tree, text.id);
    expect(found?.parent?.type).toBe('columns');
    expect(found?.column).toBe(2);
  });

  it('inserts and removes a nested block', () => {
    const container = columns();
    const image = createBlock('image');
    const inserted = insertBlock([container], { parentId: container.id, column: 2, index: 0 }, image);
    expect(countBlocks(inserted)).toBe(2);
    expect(findBlock(inserted, image.id)?.column).toBe(2);
    expect(findBlock(removeBlock(inserted, image.id), image.id)).toBeNull();
  });

  it('moves a block between columns and reorders siblings', () => {
    const first = createBlock('text');
    const second = createBlock('text');
    const container = columns([first, second]);
    const moved = moveBlock([container], first.id, { parentId: container.id, column: 2, index: 1 });
    expect(findBlock(moved, first.id)?.column).toBe(2);
    expect(moved[0].children?.map((b) => b.id)).toEqual([second.id, first.id]);
  });

  it('updates a nested block without mutating the original', () => {
    const text = createBlock('text');
    const tree = [columns([text])];
    const next = updateBlock(tree, text.id, { title: '新标题' });
    expect(findBlock(next, text.id)?.block.title).toBe('新标题');
    expect(findBlock(tree, text.id)?.block.title).not.toBe('新标题');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- --run src/lib/blockTree.test.ts`  
Expected: FAIL with module not found / exports missing.

- [ ] **Step 3: Implement types and tree helpers**

`types.ts`:
```ts
export interface BlockInstance {
  id: string;
  type: string;
  title: string;
  props: Record<string, string | number | boolean>;
  animation: BlockAnimation;
  hidden: boolean;
  area?: BlockArea;
  /** 容器类区块的子区块。 */
  children?: BlockInstance[];
  /** 分栏容器内的列号，从 1 开始。 */
  column?: number;
}
```

`blockTree.ts`:
```ts
import type { BlockInstance } from '../types';

export const MAX_BLOCK_DEPTH = 8;
export const MAX_BLOCKS = 200;

export interface BlockLocation {
  block: BlockInstance;
  parent: BlockInstance | null;
  index: number;
  column?: number;
  depth: number;
}

export interface DropTarget {
  parentId: string | null;
  column?: number;
  index: number;
}

export function findBlock(blocks: BlockInstance[], id: string): BlockLocation | null {
  const walk = (list: BlockInstance[], parent: BlockInstance | null, depth: number): BlockLocation | null => {
    for (let index = 0; index < list.length; index += 1) {
      const block = list[index];
      if (block.id === id) return { block, parent, index, column: block.column, depth };
      const nested = walk(block.children ?? [], block, depth + 1);
      if (nested) return nested;
    }
    return null;
  };
  return walk(blocks, null, 0);
}

export function countBlocks(blocks: BlockInstance[]): number {
  return blocks.reduce((total, block) => total + 1 + countBlocks(block.children ?? []), 0);
}

export function updateBlock(
  blocks: BlockInstance[],
  id: string,
  patch: Partial<BlockInstance>,
): BlockInstance[] {
  return blocks.map((block) => {
    if (block.id === id) return { ...block, ...patch };
    if (!block.children?.length) return block;
    return { ...block, children: updateBlock(block.children, id, patch) };
  });
}

export function removeBlock(
  blocks: BlockInstance[],
  id: string,
): BlockInstance[] {
  return blocks
    .filter((block) => block.id !== id)
    .map((block) =>
      block.children?.length ? { ...block, children: removeBlock(block.children, id) } : block,
    );
}

export function insertBlock(
  blocks: BlockInstance[],
  target: DropTarget,
  block: BlockInstance,
): BlockInstance[] {
  if (!target.parentId) {
    const next = [...blocks];
    next.splice(Math.max(0, Math.min(target.index, next.length)), 0, block);
    return next;
  }
  return blocks.map((item) => {
    if (item.id === target.parentId) {
      const children = [...(item.children ?? [])];
      children.splice(Math.max(0, Math.min(target.index, children.length)), 0, {
        ...block,
        column: target.column ?? 1,
      });
      return { ...item, children };
    }
    if (!item.children?.length) return item;
    return { ...item, children: insertBlock(item.children, target, block) };
  });
}

export function moveBlock(
  blocks: BlockInstance[],
  id: string,
  target: DropTarget,
): BlockInstance[] {
  const found = findBlock(blocks, id);
  if (!found) return blocks;
  if (target.parentId && (target.parentId === id || findBlock(found.block.children ?? [], target.parentId))) {
    return blocks;
  }
  const without = removeBlock(blocks, id);
  const sameParent = (found.parent?.id ?? null) === target.parentId;
  const index = sameParent && found.index < target.index ? target.index - 1 : target.index;
  return insertBlock(without, { ...target, index }, found.block);
}
```

`customize.ts` recursive normalization:
```ts
function normalizeBlock(value: unknown, depth = 0): BlockInstance | null {
  if (!value || typeof value !== 'object' || depth > 8) return null;
  const raw = value as Partial<BlockInstance>;
  if (typeof raw.type !== 'string' || !BLOCK_TYPES.has(raw.type)) return null;
  const props: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(raw.props ?? {})) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      props[key] = item;
    }
  }
  const children = Array.isArray(raw.children)
    ? raw.children
        .slice(0, 80)
        .map((child) => normalizeBlock(child, depth + 1))
        .filter((item): item is BlockInstance => !!item)
    : undefined;
  const column = typeof raw.column === 'number' ? Math.min(4, Math.max(1, raw.column)) : undefined;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : nextBlockId(),
    type: raw.type,
    title: typeof raw.title === 'string' ? raw.title.slice(0, 80) : (blockDef(raw.type)?.name ?? raw.type),
    props,
    animation: (raw.animation ?? 'none') as BlockInstance['animation'],
    hidden: raw.hidden === true,
    area: raw.area,
    ...(children?.length ? { children } : {}),
    ...(column ? { column } : {}),
  };
}
```
Also cap total after normalize: `normalizeLayout` slice 24 currently; add total cap 200 and 24 root? Keep root max 24, nested max 200 total. Use `countBlocks`.

- [ ] **Step 4: Run tests**

Run: `npm run test -- --run src/lib/blockTree.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/types.ts apps/web/src/lib/blockTree.ts apps/web/src/lib/blockTree.test.ts apps/web/src/lib/customize.ts
git commit -m "feat: add recursive block tree model"
```

---

### Task 2: 注册新组件与作用域 CSS

**Files:**
- Modify: `apps/web/src/lib/blocks.ts`
- Create: `apps/web/src/lib/blockStyles.ts`
- Create: `apps/web/src/lib/blockStyles.test.ts`

**Interfaces:**
- Produces block types: `columns`, `text`, `image`, `video`, `website`, `slideshow`.
- Produces `styleDeclarations(input: string): CSSProperties`.

- [ ] **Step 1: Write failing CSS sanitizer test**

```ts
// apps/web/src/lib/blockStyles.test.ts
import { describe, expect, it } from 'vitest';
import { styleDeclarations } from './blockStyles';

describe('styleDeclarations', () => {
  it('parses safe declarations', () => {
    expect(styleDeclarations('font-size: 18px; letter-spacing:.02em;')).toEqual({
      fontSize: '18px',
      letterSpacing: '.02em',
    });
  });

  it('drops selectors and dangerous values', () => {
    expect(styleDeclarations('} body{display:none; background:url(x)')).toEqual({});
    expect(styleDeclarations('color: expression(alert(1));')).toEqual({});
  });
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `npm run test -- --run src/lib/blockStyles.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement sanitizer**

```ts
import type { CSSProperties } from 'react';

const BLOCKED = /[{}<>@]|expression\(|javascript:|url\(/i;

const camel = (name: string) =>
  name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

export function styleDeclarations(input: string): CSSProperties {
  const style: Record<string, string> = {};
  for (const chunk of input.split(';')) {
    const index = chunk.indexOf(':');
    if (index <= 0) continue;
    const name = chunk.slice(0, index).trim().toLowerCase();
    const value = chunk.slice(index + 1).trim();
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !value || BLOCKED.test(value)) continue;
    style[camel(name)] = value.slice(0, 120);
  }
  return style as CSSProperties;
}
```

- [ ] **Step 4: Add BLOCK_DEFS entries**

Add six definitions with `group: 'shared'`, `variants: ['classic','bento']`:

```ts
{
  type: 'columns',
  name: '分栏容器',
  description: '2–4 栏，可继续嵌套任何区块。',
  group: 'shared',
  variants: ['classic', 'bento'],
  defaults: { columns: 2 },
  schema: [
    {
      key: 'columns',
      label: '栏数',
      type: 'select',
      options: [2, 3, 4].map((n) => ({ value: String(n), label: `${n} 栏` })),
    },
  ],
},
{
  type: 'text',
  name: '文本',
  description: '眉题、标题、正文与局部 CSS。',
  group: 'shared',
  variants: ['classic', 'bento'],
  defaults: { eyebrow: '', title: '新的文本区块', body: '在这里写正文。', align: 'left', max_width: 680, style_css: '' },
  schema: [
    { key: 'eyebrow', label: '眉题', type: 'text' },
    { key: 'title', label: '标题', type: 'textarea' },
    { key: 'body', label: '正文', type: 'textarea' },
    { key: 'align', label: '对齐', type: 'select', options: [
      { value: 'left', label: '左对齐' }, { value: 'center', label: '居中' }, { value: 'right', label: '右对齐' },
    ] },
    { key: 'max_width', label: '最大宽度', type: 'number', min: 320, max: 1100, step: 10 },
    { key: 'style_css', label: '作用域 CSS', type: 'textarea', hint: '只写声明，例如 font-size: 18px; letter-spacing: .02em;' },
  ],
},
{
  type: 'image',
  name: '图片',
  description: '图片、说明与链接。',
  group: 'shared',
  variants: ['classic', 'bento'],
  defaults: { src: '', alt: '', caption: '', link: '', ratio: '16:9', fit: 'cover' },
  schema: [
    { key: 'src', label: '图片地址', type: 'text' },
    { key: 'alt', label: '替代文字', type: 'text' },
    { key: 'caption', label: '说明', type: 'text' },
    { key: 'link', label: '点击链接', type: 'text' },
    { key: 'ratio', label: '比例', type: 'select', options: ['16:9','4:3','1:1','3:2'].map((value) => ({ value, label: value })) },
    { key: 'fit', label: '裁剪', type: 'select', options: [{ value: 'cover', label: '填充' }, { value: 'contain', label: '完整显示' }] },
  ],
},
{
  type: 'video',
  name: '视频',
  description: 'MP4/WebM 视频与封面。',
  group: 'shared',
  variants: ['classic', 'bento'],
  defaults: { src: '', poster: '', caption: '' },
  schema: [
    { key: 'src', label: '视频地址', type: 'text' },
    { key: 'poster', label: '封面地址', type: 'text' },
    { key: 'caption', label: '说明', type: 'text' },
  ],
},
{
  type: 'website',
  name: '网站',
  description: '网站卡片或 iframe 嵌入。',
  group: 'shared',
  variants: ['classic', 'bento'],
  defaults: { url: '', title: '', description: '', image: '', mode: 'card', height: 420 },
  schema: [
    { key: 'url', label: '网址', type: 'text' },
    { key: 'title', label: '标题', type: 'text' },
    { key: 'description', label: '描述', type: 'textarea' },
    { key: 'image', label: '封面地址', type: 'text' },
    { key: 'mode', label: '展示方式', type: 'select', options: [
      { value: 'card', label: '网站卡片' }, { value: 'iframe', label: 'iframe 嵌入' },
    ] },
    { key: 'height', label: 'iframe 高度', type: 'number', min: 240, max: 900, step: 20 },
  ],
},
{
  type: 'slideshow',
  name: '幻灯片',
  description: '手动幻灯片，自动轮播、箭头与圆点。',
  group: 'shared',
  variants: ['classic', 'bento'],
  defaults: { slides: '[]', interval: 5, autoplay: true, height: 440 },
  schema: [
    {
      key: 'slides', label: '幻灯片', type: 'itemlist', itemLabel: '张', maxItems: 10,
      itemFields: [
        { key: 'image', label: '图片地址' },
        { key: 'title', label: '标题' },
        { key: 'text', label: '说明' },
        { key: 'link', label: '链接' },
      ],
    },
    { key: 'interval', label: '轮播间隔（秒）', type: 'number', min: 2, max: 20, step: 1 },
    { key: 'autoplay', label: '自动轮播', type: 'toggle' },
    { key: 'height', label: '高度', type: 'number', min: 240, max: 800, step: 20 },
  ],
},
```

- [ ] **Step 5: Run tests and commit**

Run: `npm run test -- --run src/lib/blockStyles.test.ts`  
Expected: PASS.

```bash
git add apps/web/src/lib/blocks.ts apps/web/src/lib/blockStyles.ts apps/web/src/lib/blockStyles.test.ts
git commit -m "feat: register page builder blocks"
```

---

### Task 3: 递归渲染与新区块渲染器

**Files:**
- Modify: `apps/web/src/types.ts` (BlockInstance already changed)
- Modify: `apps/web/src/components/blocks/index.tsx`
- Create: `apps/web/src/components/blocks/LayoutBlocks.tsx`
- Create: `apps/web/src/components/blocks/MediaBlocks.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- `BlockView` recursively renders `children`.
- `CONTAINER_RENDERERS` keyed by `columns`.
- Renderers consume `BlockInstance`, use `blockItems`, `blockProp`.

- [ ] **Step 1: Implement columns container**

```tsx
// LayoutBlocks.tsx
import type { ReactNode } from 'react';
import type { BlockInstance } from '../../types';
import { blockProp } from '../../lib/blocks';

export function ColumnsBlock({ block, children }: { block: BlockInstance; children?: ReactNode }) {
  const count = Math.min(4, Math.max(2, Number(blockProp(block, 'columns', 2))));
  const visible = (block.children ?? []).filter((child) => !child.hidden);
  return (
    <div className={`pp-columns pp-columns-${count}`} data-pp-columns={count}>
      {Array.from({ length: count }, (_, index) => {
        const column = index + 1;
        const items = visible.filter((child) => (child.column ?? 1) === column);
        return (
          <div className="pp-column" key={column}>
            {items.map((child) => children?.(child))}
          </div>
        );
      })}
    </div>
  );
}
```

In `index.tsx`, pass each child wrapped by column:
```tsx
const CONTAINER_RENDERERS: Record<string, (props: { block: BlockInstance; children?: ReactElement }) => ReactElement> = {
  columns: ({ block, children }) => <ColumnsBlock block={block}>{children}</ColumnsBlock>,
};

function BlockView({ block, area }: { block: BlockInstance; area?: BlockArea }) {
  // ...
  const Container = CONTAINER_RENDERERS[block.type];
  const visibleChildren = (block.children ?? []).filter((child) => !child.hidden);
  const children = visibleChildren.length ? (
    <>
      {[1, 2, 3, 4].map((column) => {
        const items = visibleChildren.filter((child) => (child.column ?? 1) === column);
        if (!items.length) return null;
        return (
          <div className="pp-column" key={column}>
            {items.map((child) => <BlockView key={child.id} block={child} />)}
          </div>
        );
      })}
    </>
  ) : undefined;
  return (
    <section ...>
      {Container ? <Container block={block}>{children}</Container> : Renderer ? <Renderer block={block} /> : null}
    </section>
  );
}
```
`flat()` stays top-level.

- [ ] **Step 2: Implement text/image/video/website/slideshow renderers**

MediaBlocks.tsx must include:
- `TextBlock`: `styleDeclarations(blockProp(block,'style_css',''))`, paragraphs split on newline, no HTML.
- `ImageBlock`: safe URL (`/^https?:|^\//`), ratio class.
- `VideoBlock`: `<video controls preload="metadata" poster=... src=...>`.
- `WebsiteBlock`: card link and iframe mode; sanitize URL; iframe `sandbox` + `referrerPolicy="no-referrer"` + `loading="lazy"`.
- `SlideshowBlock`: `blockItems`, `useState`, `useEffect` interval with `autoplay`, arrows and dots; render first slide fallback.
- Export `MEDIA_RENDERERS` and merge into `RENDERERS`.

- [ ] **Step 3: Add CSS**

Append to `styles.css`:
```css
.pp-columns { display: grid; gap: 22px; align-items: start; }
.pp-columns-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.pp-columns-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.pp-columns-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.pp-column { min-width: 0; display: flex; flex-direction: column; gap: 18px; }
.pp-text-block { margin-inline: auto; white-space: pre-line; }
.pp-media-image { width: 100%; border-radius: var(--r-lg); border: 1px solid var(--line); }
.pp-media-caption { margin-top: 8px; color: var(--muted); font-size: 13px; }
.pp-slideshow { position: relative; overflow: hidden; border-radius: var(--r-lg); }
.pp-slide { position: absolute; inset: 0; opacity: 0; transition: opacity .4s ease; }
.pp-slide.is-active { opacity: 1; }
.pp-slide img { width: 100%; height: 100%; object-fit: cover; }
.pp-slide-copy { position: absolute; inset: auto 0 0; padding: 28px; background: linear-gradient(transparent, rgb(0 0 0 / .65)); color: #fff; }
.pp-slide-nav { position: absolute; inset-inline: 16px; top: 50%; display: flex; justify-content: space-between; }
.pp-slide-dots { position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%); display: flex; gap: 6px; }
@media (max-width: 900px) { .pp-columns-3, .pp-columns-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) { .pp-columns-2, .pp-columns-3, .pp-columns-4 { grid-template-columns: 1fr; } }
```

- [ ] **Step 4: Typecheck and commit**

Run: `npm run typecheck`  
Expected: PASS.

```bash
git add apps/web/src/components/blocks/index.tsx apps/web/src/components/blocks/LayoutBlocks.tsx apps/web/src/components/blocks/MediaBlocks.tsx apps/web/src/styles.css
git commit -m "feat: render nested and media blocks"
```

---

### Task 4: 三栏编排器与真实前台预览

**Files:**
- Rewrite: `apps/web/src/pages/admin/ThemeBuilder.tsx`
- Create: `apps/web/src/components/builder/PreviewFrame.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/AdminShell.tsx`
- Create: `apps/web/src/components/PreviewBridge.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Page tabs: `layout`, `logic`, `pages`.
- `PreviewFrame` props `{ url: string; selectedId: string | null; onSelect(id: string|null): void }`.
- `PreviewBridge` sends/receives `pp:preview-select` / `pp:preview-focus`.
- App storage listener updates config when another document writes.

- [ ] **Step 1: Add preview bridge**

`PreviewBridge.tsx`:
```tsx
import { useEffect } from 'react';

export function PreviewBridge() {
  useEffect(() => {
    if (window.parent === window) return;
    const onClick = (event: MouseEvent) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-pp-block]');
      if (!target) return;
      event.preventDefault();
      window.parent.postMessage({ type: 'pp:preview-select', blockId: target.dataset.ppBlock }, window.location.origin);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; blockId?: string };
      if (data?.type !== 'pp:preview-focus' || !data.blockId) return;
      const target = document.querySelector<HTMLElement>(`[data-pp-block="${data.blockId}"]`);
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target?.classList.add('pp-preview-focus');
      window.setTimeout(() => target?.classList.remove('pp-preview-focus'), 1200);
    };
    document.addEventListener('click', onClick);
    window.addEventListener('message', onMessage);
    return () => {
      document.removeEventListener('click', onClick);
      window.removeEventListener('message', onMessage);
    };
  }, []);
  return null;
}
```
Mount it in `App.tsx` inside `BrowserRouter` (next to `AnalyticsTracker`).

- [ ] **Step 2: PreviewFrame**

Props and behavior:
- iframe `title="页面预览"` `src={url}`.
- device width state `'desktop' | 'tablet' | 'mobile'`; widths 100%, 768, 390.
- `onLoad` sends `pp:preview-focus` for selected id.
- `window.addEventListener('message')` filters origin and calls `onSelect`.
- toolbar: device buttons, refresh key (`setNonce`), open new window.

- [ ] **Step 3: App storage sync**

```tsx
useEffect(() => {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== 'pp.web.config.v1') return;
    const next = loadConfig();
    if (next) setConfig(next);
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}, []);
```
Import `loadConfig` from `lib/runtime`; use the literal storage key `pp.web.config.v1`.

- [ ] **Step 4: Rewrite ThemeBuilder shell**

- Remove `tokens` tab and token controls (moved in Task 8).
- State: `tab: 'layout' | 'logic' | 'pages'`, `target`, `selectedId`, `previewUrl`.
- Preview URL: `target === 'home' ? '/' : `/${targetPage.slug}``.
- Render left `BlockTreeEditor` (Task 5; temporarily wrap existing `BlockList`), center `PreviewFrame`, right inspector (existing `BlockProps` + animation + title).
- Keep `ChainEditor` and `PAGE_TEMPLATES`.
- Add `aria-label` and responsive CSS.
- Update nav label in `AdminShell.tsx`: `主题工坊` → `页面编排`; page title.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`  
Expected: PASS.

```bash
git add apps/web/src/pages/admin/ThemeBuilder.tsx apps/web/src/components/builder/PreviewFrame.tsx apps/web/src/components/PreviewBridge.tsx apps/web/src/App.tsx apps/web/src/components/AdminShell.tsx apps/web/src/styles.css
git commit -m "feat: add three-pane page builder with live preview"
```

---

### Task 5: 递归树编辑器与拖拽

**Files:**
- Create: `apps/web/src/components/builder/BlockTreeEditor.tsx`
- Modify: `apps/web/src/pages/admin/ThemeBuilder.tsx`
- Modify: `apps/web/src/components/builder/BlockList.tsx` (reuse palette/row helpers or retire)
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- `BlockTreeEditor` props:
  ```ts
  {
    blocks: BlockInstance[];
    selectedId: string | null;
    onSelect(id: string | null): void;
    onChange(blocks: BlockInstance[]): void;
  }
  ```
- Drag payload `application/x-pp-block` = block id.
- Uses `findBlock`, `moveBlock`, `removeBlock`, `insertBlock`, `updateBlock`.

- [ ] **Step 1: Implement recursive row rendering**

- `TreeRow` component recurses `block.children`.
- Columns container row renders column headers 1..N with drop zones.
- Each row `draggable`, `onDragStart` sets id, `onDragOver` prevents default, `onDrop` calls `moveBlock`.
- Drop on column zone inserts with target parent/column/index end.
- Buttons: move up/down (within siblings), hide, delete, add child (only for columns).
- Empty tree shows add prompt.

- [ ] **Step 2: Implement palette**

- `availableBlocks(variant)` sorted groups: Layout (columns/text), Media (image/video/slideshow/website), Content.
- Click adds to selected columns column 1 or root end.
- Drag from palette sets payload `application/x-pp-new` = type.
- Drop on root/tree/column inserts `createBlock(type)`.

- [ ] **Step 3: Wire to ThemeBuilder**

Replace left panel with `BlockTreeEditor`; when selected block changes, right inspector shows.
- If selected block is columns, show column count and per-column add buttons in inspector.

- [ ] **Step 4: Add CSS**

```css
.builder-workspace { display: grid; grid-template-columns: 280px minmax(0,1fr) 320px; gap: 18px; align-items: start; }
.builder-tree, .builder-inspector, .builder-preview { min-width: 0; }
.builder-preview-frame { background: var(--bg-sunken); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 12px; }
.builder-preview-frame iframe { display: block; width: 100%; height: 72vh; border: 0; background: #fff; border-radius: var(--r-md); margin-inline: auto; }
.tree-row { display: flex; gap: 8px; align-items: center; padding: 6px 8px; border-radius: var(--r-sm); }
.tree-row.is-selected { background: var(--accent-soft); }
.tree-row.is-hidden { opacity: .45; }
.tree-children { margin-left: 16px; padding-left: 10px; border-left: 1px dashed var(--line); }
.tree-drop { min-height: 28px; border: 1px dashed transparent; border-radius: var(--r-sm); }
.tree-drop.is-over { border-color: var(--accent); background: var(--accent-soft); }
@media (max-width: 1100px) { .builder-workspace { grid-template-columns: 240px minmax(0,1fr); } .builder-inspector { grid-column: 1 / -1; } }
@media (max-width: 760px) { .builder-workspace { grid-template-columns: 1fr; } }
```

- [ ] **Step 5: Typecheck + unit test tree move via existing tests**

Run: `npm run typecheck && npm run test -- --run src/lib/blockTree.test.ts`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/builder/BlockTreeEditor.tsx apps/web/src/pages/admin/ThemeBuilder.tsx apps/web/src/components/builder/BlockList.tsx apps/web/src/styles.css
git commit -m "feat: add recursive drag and drop block editor"
```

---

### Task 6: 区块检查器、撤销重做与文本 CSS

**Files:**
- Modify: `apps/web/src/components/builder/BlockProps.tsx`
- Create: `apps/web/src/lib/useBuilderHistory.ts`
- Modify: `apps/web/src/pages/admin/ThemeBuilder.tsx`
- Modify: `apps/web/src/components/builder/BlockTreeEditor.tsx`

**Interfaces:**
- `useBuilderHistory<T>(initial: T)` returns `{ value, set, undo, redo, canUndo, canRedo, reset }`.
- Inspector shows title, animation, column, `BlockProps`, reset/delete.
- `BlockProps` renders `textarea` for style_css; sanitizer applied by renderer.

- [ ] **Step 1: Implement history hook**

- 50 entries max; `set` pushes current and sets next; `undo/redo` adjust index; `reset` for target switch.
- Use it for `home` and each page layout? Simpler: builder state holds `blocks` for current target; history resets on target switch.

- [ ] **Step 2: Wire inspector**

- title `Input`; animation `Select`; area select for root blocks; column select for children (1..columns).
- `BlockProps` for schema.
- For `columns` selected: select 2/3/4, list each column children with buttons to add text/columns/image/video.
- Reset props / delete block.
- Text block shows an explanatory hint for style_css; sanitizer in renderer.

- [ ] **Step 3: Undo/redo buttons and keyboard**

- Toolbar buttons; `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`.
- 300ms debounce only for preview broadcast (config write can be immediate; use existing update).

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck`  
Expected: PASS.

```bash
git add apps/web/src/components/builder/BlockProps.tsx apps/web/src/lib/useBuilderHistory.ts apps/web/src/pages/admin/ThemeBuilder.tsx apps/web/src/components/builder/BlockTreeEditor.tsx
git commit -m "feat: add builder inspector and history"
```

---

### Task 7: 迁移主题令牌到外观，后台固定浅色

**Files:**
- Create: `apps/web/src/components/theme/ThemeTokensPanel.tsx`
- Modify: `apps/web/src/pages/admin/ThemeBuilder.tsx` (remove tokens tab)
- Modify: `apps/web/src/pages/admin/Appearance.tsx`
- Modify: `apps/web/src/lib/theme.ts` (themeCss admin surface)
- Modify: `apps/web/src/components/AdminShell.tsx` / `SiteChrome.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- `ThemeTokensPanel` owns preset/mode/fonts/token/typography controls; props `{ theme, onChange }`.
- `themeCss` emits `html[data-surface='admin']` paper-light overrides.

- [ ] **Step 1: Extract token panel**

Move `TokenRow`, `MODES`, `FONTS`, token controls from ThemeBuilder into `ThemeTokensPanel.tsx`. It must include:
- mode options, presets grid, font, size, width, radius, advanced token toggles, reset.
- Existing IDs/classes preserved.

- [ ] **Step 2: Add to Appearance**

Inside Appearance, after theme presets section, add `<details className="panel"> <summary>高级主题令牌</summary> <ThemeTokensPanel .../> </details>`.
- Keep basic background/ink/accent.
- Remove link "去主题工坊改令牌"; replace with "页面编排" link.

- [ ] **Step 3: Admin surface**

- In `AdminShell`, `useEffect(() => { document.documentElement.dataset.surface = 'admin'; return () => delete ...; }, [])`.
- In `SiteChrome` same for `'site'` (and preview path).
- In `themeCss`, append:
```css
html[data-surface='admin'] {
  --bg: #ffffff;
  --ink: #14140f;
  --bg-subtle: #fafaf7;
  --bg-sunken: #f5f5f0;
  --ink-soft: #4f4f47;
  --muted: #83837a;
  --faint: #a8a89f;
  --line: #e7e7e1;
  --line-strong: #d3d3ca;
  --accent: #1f5c4a;
  --accent-soft: #eef4f0;
  --accent-ink: #ffffff;
  --prose: #26261f;
}
```
Use `presetTokens('paper','light')` to build lines instead of hardcoding if convenient.

- [ ] **Step 4: Typecheck + visual check**

Run: `npm run typecheck`  
Expected: PASS. Verify admin remains light when theme mode is dark.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/theme/ThemeTokensPanel.tsx apps/web/src/pages/admin/ThemeBuilder.tsx apps/web/src/pages/admin/Appearance.tsx apps/web/src/lib/theme.ts apps/web/src/components/AdminShell.tsx apps/web/src/components/SiteChrome.tsx apps/web/src/styles.css
git commit -m "refactor: move theme tokens into appearance"
```

---

### Task 8: 幻灯片、网站与媒体端到端验证

**Files:**
- `apps/web/src/components/blocks/MediaBlocks.tsx`
- `apps/web/.tmp/qa_page_builder.py` (new Playwright script)

**Interfaces:**
- Slideshow manual items; website card/iframe; image/video render.

- [ ] **Step 1: Implement/verify slideshow**

- Auto-advance each `interval` seconds when `autoplay` true; pause on hover.
- Arrows and dots; `aria-label` for controls; empty slides fallback.
- Add CSS for controls.

- [ ] **Step 2: Implement/verify website iframe**

- Card: domain, title, description, cover; opens new tab.
- iframe: only when mode `iframe`; sanitized http(s), `sandbox`, `referrerPolicy`, height.

- [ ] **Step 3: Write Playwright QA**

Script must:
1. Open demo app with a config containing home blocks (columns with text/image/video/website/slideshow).
2. Verify nested rendering and no horizontal overflow at 1536/1024/390.
3. Open `/admin/theme`, add a columns block, select it, add text child, edit title/style_css, verify preview iframe updates.
4. Click preview block and verify selection (postMessage).
5. Verify slideshow next arrow changes active slide.
6. Verify admin body background is light with dark theme mode.
7. Collect console errors (ignore dev-only `/__pp/runtime` 404) and fail on unexpected.

- [ ] **Step 4: Run QA**

Run:
```powershell
python apps\web\.tmp\qa_page_builder.py
```
Expected: all checks print OK; exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/blocks/MediaBlocks.tsx apps/web/src/styles.css apps/web/.tmp/qa_page_builder.py
git commit -m "test: verify page builder media and nesting"
```

---

### Task 9: 最终回归与文档

**Files:**
- Modify: `apps/web/README.md`
- Modify: `README.md` (brief)
- Reuse: existing QA scripts.

- [ ] **Step 1: Update docs**

Document:
- 页面编排 three-pane editor, drag/drop, nested columns;
- new block types;
- preview click; dark admin behavior;
- theme tokens moved to Appearance.

- [ ] **Step 2: Full frontend verification**

Run:
```powershell
npm run typecheck
npm run test -- --run
npm run build
```
Expected: typecheck pass, 11+ tests pass, build pass.

- [ ] **Step 3: Browser regression**

Run existing demo QA `qa_dashboard_ranges.py` and `qa_new_features.py`; fix any regression.
Run new `qa_page_builder.py`.

- [ ] **Step 4: Commit**

```bash
git add README.md apps/web/README.md
git commit -m "docs: document page builder"
```
