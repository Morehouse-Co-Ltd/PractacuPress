# 编辑器 Markdown 写作体验实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让正文编辑器在光标所在块的行首淡色显示 Markdown 标记、让 `/` 指令面板贴光标并跟随滚动选择、并修正"段内换行被拆成多段"的序列化问题。

**Architecture:** 语义（`lib/editorBlockMarker.ts`）与几何（`lib/caretRect.ts`）各自一个纯函数模块；标记浮层挂在 contenteditable **外面**的 `.rich-surface-shell` 里，绝不进入编存内容；`SlashMenu` 改为接收光标锚点、自己决定落点与滚动；`htmlToMarkdown` 把 `<br>` 收成单个 `\n`，导出走新的 `lib/markdownExport.ts`。

**Tech Stack:** React 19 + contenteditable/execCommand、TypeScript 5.9、Vite 7、Vitest 3（happy-dom）、仓库自带的 CDP 无头 Chrome e2e 脚本。

## Global Constraints

- 不新增界面文案，不动 `apps/web/src/lib/i18n/dict/fragments/**`（`i18n:audit` 必须仍然通过）。
- 单测文件名必须是 `src/**/*.test.ts`（`vitest.config.ts` 只收 `.test.ts`，不收 `.tsx`），环境 happy-dom，不能用 JSX。
- 标记浮层不得进入 contenteditable 子树：`htmlToMarkdown(root.innerHTML)`、`innerText` 字数统计、复制粘贴都不能受影响。
- 不改服务端渲染与清洗白名单，不改 `source_body` 的存储格式（仍是 Markdown 文本）。
- 注释与文档用中文，风格沿用现有文件（解释"为什么"，不复述代码）。
- 提交信息用 `feat(web): …` / `fix(web): …` / `test(web): …` 前缀。

---

### Task 1: 标记语义层 `blockMarkerFor`

**Files:**
- Create: `apps/web/src/lib/editorBlockMarker.ts`
- Test: `apps/web/src/lib/editorBlockMarker.test.ts`

**Interfaces:**
- Produces: `blockMarkerFor(block: Element | null): string | null`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { blockMarkerFor } from './editorBlockMarker';

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

function markerOf(host: HTMLElement, selector: string): string | null {
  const node = host.querySelector(selector);
  if (!node) throw new Error(`缺少节点 ${selector}`);
  return blockMarkerFor(node);
}

describe('blockMarkerFor', () => {
  it('uses the same heading levels that htmlToMarkdown writes', () => {
    const host = mount('<h2>二</h2><h3>三</h3><h4>四</h4>');
    expect(markerOf(host, 'h2')).toBe('##');
    expect(markerOf(host, 'h3')).toBe('###');
    expect(markerOf(host, 'h4')).toBe('####');
  });

  it('marks list items, tasks and ordered ordinals', () => {
    const host = mount(
      '<ul><li>甲</li><li>☐ 乙</li><li>☑ 丙</li></ul><ol><li>一</li><li>二</li></ol>',
    );
    const items = host.querySelectorAll('li');
    expect(blockMarkerFor(items[0])).toBe('-');
    expect(blockMarkerFor(items[1])).toBe('- [ ]');
    expect(blockMarkerFor(items[2])).toBe('- [x]');
    expect(blockMarkerFor(items[3])).toBe('1.');
    expect(blockMarkerFor(items[4])).toBe('2.');
  });

  it('marks quotes and code blocks', () => {
    const host = mount('<blockquote><p>引</p></blockquote><pre><code>x</code></pre>');
    expect(markerOf(host, 'blockquote')).toBe('>');
    expect(markerOf(host, 'pre')).toBe('```');
  });

  it('returns null for paragraphs, table cells and rich blocks', () => {
    const host = mount(
      '<p>正文</p><table class="pp-table"><tr><td>格</td></tr></table>' +
        '<a class="pp-linkcard" href="https://example.com">卡</a><div>裸文本</div>',
    );
    expect(markerOf(host, 'p')).toBeNull();
    expect(markerOf(host, 'td')).toBeNull();
    expect(markerOf(host, 'a.pp-linkcard')).toBeNull();
    expect(markerOf(host, 'div')).toBeNull();
  });

  it('tolerates a null block', () => {
    expect(blockMarkerFor(null)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/web test -- editorBlockMarker`
Expected: FAIL，"Cannot find module './editorBlockMarker'"

- [ ] **Step 3: 实现**

```ts
/**
 * 行首标记的语义层：从光标所在的块元素推出它在 Markdown 里的行首写法。
 *
 * 标记必须和 `lib/htmlToMarkdown` 真正写出的语法一致（正文标题从 `##` 起，
 * 因为 `#` 留给页面标题），否则"看到的"和"存下来的"对不上。
 * 富文本区块序列化成 HTML，没有行首语法，一律不给标记。
 */

const HEADING_PREFIX: Record<string, string> = {
  h1: '#',
  h2: '##',
  h3: '###',
  h4: '####',
  h5: '#####',
  h6: '######',
};

/** 存成 HTML 的区块：没有行首语法。 */
const HTML_BLOCK_SELECTOR = [
  'a.pp-video',
  'a.pp-embed',
  'a.pp-linkcard',
  'p.pp-image',
  'p.pp-icon-line',
  'blockquote.pp-note',
  'table',
  '[data-pp-diagram-edit]',
].join(',');

export function blockMarkerFor(block: Element | null): string | null {
  if (!block) return null;
  if (block.closest(HTML_BLOCK_SELECTOR)) return null;

  const tag = block.tagName.toLowerCase();
  const heading = HEADING_PREFIX[tag];
  if (heading) return heading;
  if (tag === 'blockquote') return '>';
  if (tag === 'pre') return '```';

  if (tag === 'li') {
    const list = block.parentElement;
    if (!list) return null;
    const task = (block.textContent ?? '').match(/^\s*([☐☑])/);
    if (task) return `- [${task[1] === '☑' ? 'x' : ' '}]`;
    if (list.tagName.toLowerCase() === 'ol') {
      const ordinal = Array.prototype.indexOf.call(list.children, block) + 1;
      return `${ordinal}.`;
    }
    return '-';
  }

  return null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C apps/web test -- editorBlockMarker`
Expected: PASS（5 个用例）

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/lib/editorBlockMarker.ts apps/web/src/lib/editorBlockMarker.test.ts
git commit -m "feat(web): derive markdown line markers for the editor"
```

---

### Task 2: 几何层 `caretAnchor` / `firstLineAnchor` / `placeMenu`

**Files:**
- Create: `apps/web/src/lib/caretRect.ts`
- Test: `apps/web/src/lib/caretRect.test.ts`

**Interfaces:**
- Produces:
  - `interface CaretAnchor { left: number; top: number; bottom: number; height: number }`
  - `caretAnchor(range: Range, block: HTMLElement | null): CaretAnchor | null`
  - `firstLineAnchor(block: HTMLElement): CaretAnchor | null`
  - `placeMenu(anchor, size, viewport, gap = 6, margin = 8): { left: number; top: number; placement: 'below' | 'above' }`

- [ ] **Step 1: 写失败测试（只测纯函数与降级链，happy-dom 的量测恒为零）**

```ts
import { describe, expect, it } from 'vitest';
import { caretAnchor, placeMenu } from './caretRect';

const viewport = { width: 1200, height: 800 };

describe('placeMenu', () => {
  it('sits below the caret when there is room', () => {
    const anchor = { left: 300, top: 200, bottom: 220, height: 20 };
    expect(placeMenu(anchor, { width: 276, height: 330 }, viewport)).toEqual({
      left: 300,
      top: 226,
      placement: 'below',
    });
  });

  it('flips above when the remaining space below is too small', () => {
    const anchor = { left: 300, top: 600, bottom: 620, height: 20 };
    const placed = placeMenu(anchor, { width: 276, height: 330 }, viewport);
    expect(placed.placement).toBe('above');
    expect(placed.top).toBe(600 - 330 - 6);
  });

  it('clamps inside the viewport margins', () => {
    const near = placeMenu({ left: 1190, top: 100, bottom: 120, height: 20 }, { width: 276, height: 200 }, viewport);
    expect(near.left).toBe(1200 - 276 - 8);
    const left = placeMenu({ left: -40, top: 100, bottom: 120, height: 20 }, { width: 276, height: 200 }, viewport);
    expect(left.left).toBe(8);
  });

  it('never pushes the panel off the top or bottom edge', () => {
    const tall = placeMenu({ left: 100, top: 40, bottom: 60, height: 20 }, { width: 276, height: 760 }, viewport);
    expect(tall.top).toBeGreaterThanOrEqual(8);
    const above = placeMenu({ left: 100, top: 790, bottom: 795, height: 5 }, { width: 276, height: 700 }, viewport);
    expect(above.top).toBeGreaterThanOrEqual(8);
    expect(above.top + 700).toBeLessThanOrEqual(800 - 8);
  });
});

describe('caretAnchor', () => {
  it('falls back to the block rect when the range reports nothing', () => {
    const block = document.createElement('p');
    block.textContent = '正文';
    document.body.appendChild(block);
    const range = document.createRange();
    range.selectNodeContents(block);
    range.collapse(true);
    const anchor = caretAnchor(range, block);
    // happy-dom 的量测恒为零，降级到块矩形后仍然是"有值但零尺寸"
    expect(anchor).not.toBeNull();
    expect(typeof anchor!.left).toBe('number');
  });

  it('returns null without a range', () => {
    expect(caretAnchor(null as unknown as Range, null)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/web test -- caretRect`
Expected: FAIL，"Cannot find module './caretRect'"

- [ ] **Step 3: 实现**

```ts
/**
 * 编辑器的几何层：光标矩形与浮层落点。
 *
 * 全部返回视口坐标，纯函数便于单测（happy-dom 里量测恒为零，只能测分支）。
 * `caretAnchor` 刻意不插入探针节点去"量"零尺寸光标：那会动 DOM 和选区，
 * 在 contenteditable 里风险大于收益，宁可逐级降级到块矩形。
 */

export interface CaretAnchor {
  left: number;
  top: number;
  bottom: number;
  height: number;
}

const MENU_GAP = 6;
const MENU_MARGIN = 8;

function toAnchor(rect: { left: number; top: number; bottom: number; height: number }): CaretAnchor {
  return {
    left: rect.left,
    top: rect.top,
    bottom: rect.bottom,
    height: rect.height || Math.max(0, rect.bottom - rect.top),
  };
}

export function caretAnchor(range: Range | null, block: HTMLElement | null): CaretAnchor | null {
  if (!range) return null;
  const own = range.getBoundingClientRect?.();
  if (own && (own.width > 0 || own.height > 0)) return toAnchor(own);
  const first = range.getClientRects?.()[0];
  if (first && (first.width > 0 || first.height > 0)) return toAnchor(first);
  const fallback = block?.getBoundingClientRect();
  return fallback ? toAnchor(fallback) : null;
}

export function firstLineAnchor(block: HTMLElement): CaretAnchor | null {
  const range = document.createRange();
  range.selectNodeContents(block);
  range.collapse(true);
  return caretAnchor(range, block);
}

export function placeMenu(
  anchor: CaretAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = MENU_GAP,
  margin = MENU_MARGIN,
): { left: number; top: number; placement: 'below' | 'above' } {
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;
  const fitsBelow = below + size.height <= viewport.height - margin;
  const placement: 'below' | 'above' = fitsBelow || above < margin ? 'below' : 'above';
  const preferred = placement === 'below' ? below : above;
  const maxTop = Math.max(margin, viewport.height - margin - size.height);
  const maxLeft = Math.max(margin, viewport.width - margin - size.width);
  return {
    left: Math.min(Math.max(margin, anchor.left), maxLeft),
    top: Math.min(Math.max(margin, preferred), maxTop),
    placement,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C apps/web test -- caretRect`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/lib/caretRect.ts apps/web/src/lib/caretRect.test.ts
git commit -m "feat(web): add caret geometry helpers for the editor overlays"
```

---

### Task 3: 行首标记浮层接进 `RichTextEditor`

**Files:**
- Modify: `apps/web/src/components/RichTextEditor.tsx`
- Modify: `apps/web/src/styles/editorMarkdown.css`（浮层样式）、`apps/web/src/styles.css`（`.rich-surface-shell` 的定位上下文，就近写在 `.rich-editor` 规则旁）

**Interfaces:**
- Consumes: `blockMarkerFor`（Task 1）、`firstLineAnchor`（Task 2）

- [ ] **Step 1: 结构改造** —— 把编辑区包进 shell，浮层与 `.rich-surface` 同级：

```tsx
<div className="rich-surface-shell">
  <div ref={surfaceRef} className="article-body rich-surface" ... />
  {marker ? (
    <span
      className="pp-line-marker"
      aria-hidden="true"
      style={{ top: marker.top, height: marker.height, left: marker.left }}
    >
      {marker.text}
    </span>
  ) : null}
</div>
```

- [ ] **Step 2: 同步逻辑** —— `useEffect` 里挂 `document.addEventListener('selectionchange', …)`（rAF 合并）与
  编辑区 `onScroll`、`window` 的 `resize`；`syncMarker()` 读光标块 → `blockMarkerFor` → `firstLineAnchor`
  → 换算成 shell 局部坐标：

```ts
const syncMarker = useCallback(() => {
  const root = surfaceRef.current;
  const shell = shellRef.current;
  if (!root || !shell || disabled) {
    setMarker((prev) => (prev ? null : prev));
    return;
  }
  const selection = window.getSelection();
  const anchorNode = selection?.anchorNode ?? null;
  if (!selection || selection.rangeCount === 0 || !anchorNode || !root.contains(anchorNode)) {
    setMarker((prev) => (prev ? null : prev));
    return;
  }
  const block = closestBlock(root, anchorNode);
  const text = blockMarkerFor(block);
  if (!block || !text) {
    setMarker((prev) => (prev ? null : prev));
    return;
  }
  const line = firstLineAnchor(block);
  if (!line) { setMarker(null); return; }
  const shellRect = shell.getBoundingClientRect();
  const surfaceRect = root.getBoundingClientRect();
  // 行滚出编辑区就不画，避免贴在边框上。
  if (line.bottom < surfaceRect.top || line.top > surfaceRect.bottom) { setMarker(null); return; }
  const top = line.top - shellRect.top;
  const left = parseFloat(getComputedStyle(root).paddingLeft) - 8;
  setMarker((prev) => {
    if (prev && prev.text === text && Math.abs(prev.top - top) < 0.5 && Math.abs(prev.left - left) < 0.5) {
      return prev;
    }
    return { text, top, height: line.height, left };
  });
}, [disabled]);
```

- [ ] **Step 3: 样式**

```css
.rich-surface-shell { position: relative; display: flex; min-width: 0; }

.pp-line-marker {
  position: absolute;
  display: flex;
  align-items: center;
  transform: translateX(-100%);
  padding-right: 8px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1;
  color: var(--faint, #a8a89f);
  opacity: 0.75;
  pointer-events: none;
  user-select: none;
  white-space: nowrap;
}

@media (max-width: 760px) {
  .pp-line-marker { display: none; }
}
```

- [ ] **Step 4: 手工核对** —— `pnpm -C apps/web dev` 打开 `/admin/content/article/new`（演示模式），
  敲 `## 标题`、`- 列表`、`> 引用`，确认标记只出现在光标所在行、离开即消失、正文不位移。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/RichTextEditor.tsx apps/web/src/styles.css apps/web/src/styles/editorMarkdown.css
git commit -m "feat(web): show the markdown marker of the caret line"
```

---

### Task 4: `/` 面板贴光标 + ↑↓ 滚动跟随 + 上下翻转

**Files:**
- Modify: `apps/web/src/components/SlashMenu.tsx`
- Modify: `apps/web/src/components/RichTextEditor.tsx`（`updateSlashMenu` 改传锚点、滚动/缩放时重算）

**Interfaces:**
- Consumes: `caretAnchor`、`placeMenu`、`CaretAnchor`（Task 2）
- Produces: `SlashMenuProps.anchor: CaretAnchor | null`（替换原 `position`）

- [ ] **Step 1: 先写死复现** —— 现有代码里 `.slash-menu-list` 没有滚动逻辑，↑↓ 到第 10 项以后高亮项离开可视区；
  把这条写进 e2e 脚本（Task 6）作为回归断言。

- [ ] **Step 2: `SlashMenu` 改造**

```tsx
const listRef = useRef<HTMLDivElement>(null);
const [size, setSize] = useState({ width: 276, height: 330 });

useLayoutEffect(() => {
  const el = listRef.current;
  if (!el) return;
  setSize({ width: el.offsetWidth, height: el.offsetHeight });
}, [open, items.length]);

const placed = anchor
  ? placeMenu(anchor, size, { width: window.innerWidth, height: window.innerHeight })
  : { left: 12, top: 12, placement: 'below' as const };

// 键盘/鼠标换高亮时把该项滚进可视区：只动列表自己的 scrollTop，不带动整页。
useEffect(() => {
  const list = listRef.current?.querySelector<HTMLElement>('.slash-menu-list');
  const item = list?.children[activeIndex] as HTMLElement | undefined;
  if (!list || !item) return;
  const itemRect = item.getBoundingClientRect();
  const listRect = list.getBoundingClientRect();
  if (itemRect.top < listRect.top) list.scrollTop -= listRect.top - itemRect.top;
  else if (itemRect.bottom > listRect.bottom) list.scrollTop += itemRect.bottom - listRect.bottom;
}, [activeIndex, query]);
```

- [ ] **Step 3: 锚点在滚动/缩放时重算** —— `RichTextEditor` 打开面板期间（`slash !== null`）监听
  `window` 的 `scroll`（capture）与 `resize`，调用 `updateSlashMenu()` 重算 `anchor`；编辑区
  `onScroll` 同样重算。

- [ ] **Step 4: 手工核对** —— 在长文档底部敲 `/`：面板出现在光标下方；到窗口底部时翻到光标上方；
  ↑↓ 连按 16 次高亮项始终可见。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/SlashMenu.tsx apps/web/src/components/RichTextEditor.tsx
git commit -m "fix(web): anchor the slash menu at the caret and keep the active row visible"
```

---

### Task 5: `htmlToMarkdown` 的换行语义

**Files:**
- Modify: `apps/web/src/lib/htmlToMarkdown.ts`
- Test: `apps/web/src/lib/htmlToMarkdown.test.ts`

**Interfaces:**
- Produces: `<br>` 序列化为单个 `\n`；一个 `<p>` 仍是一个段落；`[data-pp-marker]` 被忽略。

- [ ] **Step 1: 写失败测试**

```ts
it('keeps a soft line break inside one paragraph', () => {
  expect(htmlToMarkdown('<p>第一行<br>第二行</p>')).toBe('第一行\n第二行\n');
});

it('keeps two paragraphs apart', () => {
  expect(htmlToMarkdown('<p>一</p><p>二</p>')).toBe('一\n\n二\n');
});

it('ignores editor markers that leaked into the content', () => {
  expect(htmlToMarkdown('<p><span data-pp-marker="1">##</span>标题</p>')).toBe('标题\n');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/web test -- htmlToMarkdown`
Expected: FAIL（现实现给出 `第一行\n\n第二行\n` 等）

- [ ] **Step 3: 改实现** —— `inlineNode` 的 `case 'br'` 返回 `'\n'`；`blockNode` 的 `case 'p'` 不再
  `split(/\n{2,}/)`，改成保留单个 `\n`（`text.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{2,}/g, '\n').trim()`）；
  两个遍历函数开头都加一句 `if ((node as HTMLElement).hasAttribute?.('data-pp-marker')) return '';`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C apps/web test -- htmlToMarkdown`
Expected: PASS（含既有 12 个用例）

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/lib/htmlToMarkdown.ts apps/web/src/lib/htmlToMarkdown.test.ts
git commit -m "fix(web): keep soft line breaks inside one markdown paragraph"
```

---

### Task 6: 导出时补硬换行

**Files:**
- Create: `apps/web/src/lib/markdownExport.ts`
- Test: `apps/web/src/lib/markdownExport.test.ts`
- Modify: `apps/web/src/pages/admin/Editor.tsx`（`exportMarkdown` 改用 `toExportMarkdown`）

**Interfaces:**
- Produces: `toExportMarkdown(source: string): string`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { toExportMarkdown } from './markdownExport';

describe('toExportMarkdown', () => {
  it('turns soft line breaks inside a paragraph into hard breaks', () => {
    expect(toExportMarkdown('第一行\n第二行\n\n下一段\n')).toBe('第一行  \n第二行\n\n下一段\n');
  });

  it('leaves fenced code alone', () => {
    const source = '```ts\nconst a = 1;\nconst b = 2;\n```\n';
    expect(toExportMarkdown(source)).toBe(source);
  });

  it('leaves lists, headings, tables and html blocks alone', () => {
    const source = '# 标题\n\n- 一\n- 二\n\n| a | b |\n| --- | --- |\n\n<a class="pp-video" href="https://e.com">x</a>\n';
    expect(toExportMarkdown(source)).toBe(source);
  });

  it('trims stray trailing spaces outside paragraphs', () => {
    expect(toExportMarkdown('# 标题   \n\n正文   \n')).toBe('# 标题\n\n正文\n');
  });
});
```

- [ ] **Step 2: 跑测试确认失败** —— `pnpm -C apps/web test -- markdownExport`，预期找不到模块。

- [ ] **Step 3: 实现** —— 逐行扫描：`inFence` 跟踪 ``` / ~~~；标题（`^#{1,6}\s`）、列表（`^\s*(?:[-*+]|\d+\.|\[[ xX]\])\s`）、
  表格（含 `|` 且下一行是分隔行，或整行以 `|` 开头）、HTML 区块（`^\s*<`）、水平线、空行 → 原样输出并清行尾空白；
  连续两个"普通正文行"之间写 `  \n`；文件末尾统一补一个换行。围栏内的行一字不动。

- [ ] **Step 4: 跑测试确认通过** —— `pnpm -C apps/web test -- markdownExport`，预期 PASS。

- [ ] **Step 5: 接进导出按钮** —— `Editor.tsx` 里 `new Blob([toExportMarkdown(form.source_body)], …)`，
  保存链路不动。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/lib/markdownExport.ts apps/web/src/lib/markdownExport.test.ts apps/web/src/pages/admin/Editor.tsx
git commit -m "feat(web): add markdown hard breaks when exporting"
```

---

### Task 7: 粘贴不再逐行断段

**Files:**
- Modify: `apps/web/src/components/RichTextEditor.tsx`（`handlePaste` 的纯文本分支）

- [ ] **Step 1: 改实现** —— 纯文本分支按 `\n{2,}` 分段，段内单个 `\n` 并成空格：

```ts
const blocks = text
  .split(/\n{2,}/)
  .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n+/g, ' ')}</p>`)
  .join('');
```

- [ ] **Step 2: 手工核对** —— 粘贴一段"每行都硬折行"的纯文本：落地是一个段落（不是 N 段），
  字数与段落数正确；粘贴空行分隔的两段仍是两段。

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/components/RichTextEditor.tsx
git commit -m "fix(web): join wrapped pasted lines into one paragraph"
```

---

### Task 8: 全量验收

- [ ] **Step 1:** `pnpm -C apps/web typecheck` → 无错误。
- [ ] **Step 2:** `pnpm -C apps/web test` → 全绿（含既有用例）。
- [ ] **Step 3:** `pnpm -C apps/web run i18n:audit` → 通过（本次未加文案）。
- [ ] **Step 4:** `pnpm -C apps/web build` → 通过。
- [ ] **Step 5:** CDP 无头 Chrome 脚本核对三件事并截图到 `.tmp/shots-editor/`：
  标记与行盒对齐、`/` 面板在光标下方且 ↑↓ 始终可见高亮项、导出内容含 `  \n`。
- [ ] **Step 6:** 提交：`test(web): cover the editor markdown affordances end to end`
