# Content Rich Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将文章/帖子后台编辑页改造成默认所见即所得的富文本编辑器，统一用 Markdown 保存，并提供 Markdown 文件导入、导出和三档窗口自适应布局。

**Architecture:** `EditorPage` 保留页面元数据、保存和文件操作状态；`RichTextEditor` 负责 contenteditable 表面、选区、粘贴和 HTML→Markdown 输出；`EditorToolbar` 只调用编辑器命令并插入已有安全区块。Markdown 渲染与 HTML 序列化增加公式节点支持，历史 HTML/纯文本通过一个纯边界函数归一化为 Markdown + 编辑器 HTML。后台内容编辑页使用宽版容器，编辑器网格在宽桌面双列、中屏单列、手机端横向工具栏之间切换。

**Tech Stack:** React 19, TypeScript 5.9, Vite 7, browser `contenteditable`, existing Markdown renderer/HTML serializer, CSS media queries, Vitest + happy-dom for serialization tests, Playwright/browser QA for interaction and screenshots.

## Global Constraints

- 本次只改造 `/admin/content/new/:kind` 与 `/admin/content/:kind/:id`，不改造 `/admin/pages/...`。
- 编辑区默认不显示 Markdown 源码；Markdown 只通过本地 `.md` 文件导入与导出。
- 正文保存固定使用 `source_format: 'markdown'`；服务端仍是最终清洗和公开渲染来源。
- 不引入 KaTeX/MathJax；公式使用 `span.pp-math-inline` / `p.pp-math-block` 与 `data-pp-math` 保存原文。
- 保留图片、网址卡、视频卡、表格、分栏、图集、图标、提示框等现有区块和安全白名单。
- 导入文件最大 2 MB；正文仍遵守现有 200000 字符校验。
- 宽桌面编辑区允许超过通用后台 1120px 上限；中屏单列；移动端工具栏横向滚动且页面不得横向溢出。
- 不使用新的 React 状态管理或后端接口；所有变化在现有前端状态和 `DraftInput` 契约内完成。
- 每个任务完成后运行任务列出的验证命令，再创建独立提交。

---

### Task 1: 建立编辑源归一化边界与序列化测试

**Files:**
- Modify: `apps/web/package.json:7-25`
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/src/lib/editorSource.ts`
- Create: `apps/web/src/lib/editorSource.test.ts`
- Create: `apps/web/src/lib/markdown.test.ts`
- Create: `apps/web/src/lib/htmlToMarkdown.test.ts`

**Interfaces:**
- Consumes: existing `SourceFormat`, `renderSource`, `renderMarkdown`, `htmlToMarkdown`.
- Produces: `normalizeEditorSource(format: SourceFormat, source: string): { markdown: string; html: string }`, used by `EditorPage` in Task 4.

- [ ] **Step 1: Add the test command and DOM test environment.**

Add the following entries to `apps/web/package.json` without removing existing scripts or dependencies:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "happy-dom": "^18.0.1",
    "vitest": "^3.2.4"
  }
}
```

Create `apps/web/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    clearMocks: true,
  },
});
```

Run from `apps/web`:

```powershell
npm install
npm run test -- --run
```

Expected: Vitest starts and reports no test files yet; the command exits successfully.

- [ ] **Step 2: Write failing tests for source normalization.**

Create `apps/web/src/lib/editorSource.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeEditorSource } from './editorSource';

describe('normalizeEditorSource', () => {
  it('keeps Markdown source as the editable Markdown value', () => {
    const result = normalizeEditorSource('markdown', '# 标题\n\n**正文**');
    expect(result.markdown).toBe('# 标题\n\n**正文**');
    expect(result.html).toContain('<h1>标题</h1>');
    expect(result.html).toContain('<strong>正文</strong>');
  });

  it('converts historical HTML to Markdown and safe editor HTML', () => {
    const result = normalizeEditorSource('html', '<h2>标题</h2><p>正文<script>alert(1)</script></p>');
    expect(result.markdown).toContain('## 标题');
    expect(result.markdown).toContain('正文');
    expect(result.markdown).not.toContain('script');
    expect(result.html).not.toContain('<script');
  });

  it('converts plain text blocks to Markdown paragraphs', () => {
    const result = normalizeEditorSource('plain', '第一段\n\n第二段');
    expect(result.markdown).toBe('第一段\n\n第二段\n');
    expect(result.html).toContain('<p>第一段</p>');
    expect(result.html).toContain('<p>第二段</p>');
  });
});
```

- [ ] **Step 3: Write failing tests for formula rendering and round-trip.**

Create `apps/web/src/lib/markdown.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

describe('formula Markdown rendering', () => {
  it('renders inline and block formulas as editable safe nodes', () => {
    const html = renderMarkdown('速度是 $v = s/t$。\n\n$$x^2 + y^2 = z^2$$');
    expect(html).toContain('class="pp-math-inline"');
    expect(html).toContain('class="pp-math-block"');
    expect(html).toContain('data-pp-math="v = s/t"');
    expect(html).toContain('data-pp-math="x^2 + y^2 = z^2"');
    expect(html).not.toContain('<script');
  });
});
```

Create `apps/web/src/lib/htmlToMarkdown.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from './htmlToMarkdown';

describe('htmlToMarkdown', () => {
  it('round-trips formulas without exposing the data attribute', () => {
    const markdown = htmlToMarkdown(
      '<p>速度是 <span class="pp-math-inline" data-pp-math="v = s/t">v = s/t</span>。</p>' +
        '<p class="pp-math-block" data-pp-math="x^2 + y^2 = z^2">x^2 + y^2 = z^2</p>',
    );
    expect(markdown).toContain('$v = s/t$');
    expect(markdown).toContain('$$x^2 + y^2 = z^2$$');
    expect(markdown).not.toContain('data-pp-math');
  });

  it('keeps existing special blocks as HTML while serializing normal text', () => {
    const markdown = htmlToMarkdown(
      '<p>正文 <strong>重点</strong></p>' +
        '<a class="pp-embed" href="https://example.com"><strong>网站</strong></a>',
    );
    expect(markdown).toContain('正文 **重点**');
    expect(markdown).toContain('<a class="pp-embed" href="https://example.com"><strong>网站</strong></a>');
  });
});
```

- [ ] **Step 4: Run the focused tests and confirm they fail for the missing APIs.**

Run:

```powershell
npm run test -- --run src/lib/editorSource.test.ts src/lib/markdown.test.ts src/lib/htmlToMarkdown.test.ts
```

Expected: FAIL because `editorSource.ts` and the formula node behavior do not exist yet. Do not change the tests to make the failure pass.

- [ ] **Step 5: Implement the source normalization boundary.**

Create `apps/web/src/lib/editorSource.ts`:

```ts
import type { SourceFormat } from '../types';
import { htmlToMarkdown } from './htmlToMarkdown';
import { renderMarkdown, renderSource } from './markdown';

export interface EditorSource {
  markdown: string;
  html: string;
}

export function normalizeEditorSource(format: SourceFormat, source: string): EditorSource {
  if (format === 'markdown') {
    return { markdown: source, html: renderMarkdown(source) };
  }

  const safeHtml = renderSource(format, source);
  const markdown = htmlToMarkdown(safeHtml);
  return { markdown, html: renderMarkdown(markdown) };
}
```

This keeps the page layer from duplicating the HTML/plain conversion rules and guarantees that historical formats enter the same Markdown-backed editor path.

- [ ] **Step 6: Run the focused tests and commit the test boundary.**

Run:

```powershell
npm run test -- --run src/lib/editorSource.test.ts
```

Expected: the source tests still fail only on formula-related behavior until Task 2; the plain and historical source assertions pass. Commit the test harness and source boundary:

```powershell
git add apps/web/package.json apps/web/package-lock.json apps/web/vitest.config.ts apps/web/src/lib/editorSource.ts apps/web/src/lib/editorSource.test.ts apps/web/src/lib/markdown.test.ts apps/web/src/lib/htmlToMarkdown.test.ts
git commit -m "test: add rich editor serialization boundary"
```

---

### Task 2: Add safe formula nodes and Markdown round-trip behavior

**Files:**
- Modify: `apps/web/src/lib/markdown.ts:12-53, 89-254, 256-270`
- Modify: `apps/web/src/lib/htmlToMarkdown.ts:16-105, 164-247`
- Test: `apps/web/src/lib/markdown.test.ts`
- Test: `apps/web/src/lib/htmlToMarkdown.test.ts`

**Interfaces:**
- Consumes: formula Markdown syntax `$...$` and `$$...$$`.
- Produces: `span.pp-math-inline[data-pp-math]`, `p.pp-math-block[data-pp-math]`, and serializer output that restores the exact delimiters.

- [ ] **Step 1: Add failing edge-case tests for formulas in mixed content.**

Extend `markdown.test.ts` with:

```ts
it('does not parse dollar signs inside code spans as formulas', () => {
  const html = renderMarkdown('使用 `$x$` 作为代码文本。');
  expect(html).toContain('<code>$x$</code>');
  expect(html).not.toContain('pp-math-inline');
});

it('escapes formula text before placing it in HTML', () => {
  const html = renderMarkdown('公式 $a < b$');
  expect(html).toContain('data-pp-math="a &lt; b"');
  expect(html).not.toContain('< b');
});
```

Extend `htmlToMarkdown.test.ts` with:

```ts
it('uses the current visible formula text when an editor node was changed', () => {
  const markdown = htmlToMarkdown(
    '<p><span class="pp-math-inline" data-pp-math="old">new</span></p>',
  );
  expect(markdown).toContain('$old$');
});
```

The last assertion documents that `RichTextEditor.emit` must synchronize `data-pp-math` from edited text before calling the serializer; the serializer itself remains attribute-based and safe.

- [ ] **Step 2: Run the formula tests and confirm the new cases fail.**

Run:

```powershell
npm run test -- --run src/lib/markdown.test.ts src/lib/htmlToMarkdown.test.ts
```

Expected: FAIL on mixed-content and escaping behavior because the renderer has no formula-aware placeholder handling.

- [ ] **Step 3: Add formula node helpers to `markdown.ts`.**

Immediately after `escapeHtml`, add:

```ts
function formulaAttribute(source: string): string {
  return escapeHtml(source.replace(/\r\n/g, '\n').trim());
}

function inlineFormula(source: string): string {
  const value = source.trim();
  return `<span class="pp-math-inline" data-pp-math="${formulaAttribute(value)}">${escapeHtml(value)}</span>`;
}

function blockFormula(source: string): string {
  const value = source.replace(/\r\n/g, '\n').trim();
  return `<p class="pp-math-block" data-pp-math="${formulaAttribute(value)}">${escapeHtml(value)}</p>`;
}
```

Update `inline` so code spans are replaced by placeholders first, formula spans are then replaced by placeholders, and the formula placeholders are restored after emphasis/link processing. Formula recognition must use `/\$([^$\n]+)\$/` and never run against the code placeholder text.

- [ ] **Step 4: Add block formula recognition to `renderMarkdown`.**

In the line loop, after fenced-code handling and before raw HTML/heading handling, recognize a line whose trimmed value starts and ends with `$$`. For a one-line block, pass the inner text to `blockFormula`. For a multi-line block, collect lines until the next trimmed `$$`, join with `\n`, and emit one `blockFormula`. If no closing delimiter exists, leave the source in a normal paragraph so incomplete input is not lost.

Keep block formula parsing before table/list/paragraph parsing, and keep fenced-code parsing first so formulas in code blocks remain code.

- [ ] **Step 5: Teach `htmlToMarkdown` to serialize formula nodes before ordinary blocks.**

Add:

```ts
function formulaSource(element: Element): string {
  return (element.getAttribute('data-pp-math') ?? element.textContent ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
}
```

In `inlineNode`, before the tag switch:

```ts
if (element.matches('.pp-math-inline')) {
  const source = formulaSource(element);
  return source ? `$${source}$` : '';
}
```

In `blockNode`, before the tag switch:

```ts
if (element.matches('.pp-math-block')) {
  const source = formulaSource(element);
  return source ? `$$${source}$$` : '';
}
```

Keep special-block detection before ordinary element handling. `cleanBlockHtml` must not be used for formula nodes, so `data-pp-math` never leaks into exported Markdown.

- [ ] **Step 6: Restrict formula attributes during sanitization.**

In `sanitizeHtml`, for `.pp-math-inline` and `.pp-math-block` elements, normalize `data-pp-math` from text-safe attribute data and replace the visible content with `escapeHtml` output only through DOM text assignment. Do not allow nested elements in a formula node. Remove `data-pp-math` from every other element. This keeps imported raw HTML from creating arbitrary formula attributes.

- [ ] **Step 7: Run all serialization tests and commit.**

Run:

```powershell
npm run test -- --run src/lib/markdown.test.ts src/lib/htmlToMarkdown.test.ts src/lib/editorSource.test.ts
```

Expected: PASS for ordinary Markdown, formula nodes, special HTML blocks, historical HTML, and plain text. Commit:

```powershell
git add apps/web/src/lib/markdown.ts apps/web/src/lib/htmlToMarkdown.ts apps/web/src/lib/markdown.test.ts apps/web/src/lib/htmlToMarkdown.test.ts
git commit -m "feat: preserve formulas in rich editor markdown"
```

---

### Task 3: Connect the rich surface and toolbar commands

**Files:**
- Modify: `apps/web/src/components/RichTextEditor.tsx:22-291`
- Modify: `apps/web/src/components/EditorToolbar.tsx:28-395`
- Modify: `apps/web/src/styles.css:2447-2477, 2532-2640`

**Interfaces:**
- Consumes: formula node helpers from `markdown.ts`, existing `richBlocks` builders, `EditorCommands`.
- Produces: `RichTextEditor` that emits Markdown on input and `EditorToolbar` that inserts/editable formula nodes without losing the current Range.

- [ ] **Step 1: Extend `EditorCommands` with a formula command.**

Add to `RichTextEditor.tsx`:

```ts
formula: (source: string, block: boolean) => void;
```

The command must ignore empty source, trim line endings, and insert either the inline or block node at the saved selection. Block formulas use spacer paragraphs exactly like existing block insertions.

- [ ] **Step 2: Synchronize edited formula nodes before serializing.**

At the start of `emit`, before reading `root.innerHTML`, run:

```ts
root.querySelectorAll<HTMLElement>('[data-pp-math]').forEach((node) => {
  node.dataset.ppMath = (node.textContent ?? '').replace(/\r\n/g, '\n').trim();
});
```

Then compute empty state, word count and `htmlToMarkdown(root.innerHTML)` as before. This keeps direct edits to a formula node reflected in the exported Markdown while still making the serializer read only the dedicated attribute.

- [ ] **Step 3: Add the formula command implementation.**

Import the formula node builders from `markdown.ts` or expose them as named helpers. Add to the `commands` object:

```ts
formula: (source, block) => {
  const value = source.trim();
  if (!value) return;
  insertHtml(block ? blockFormula(value) : inlineFormula(value));
},
```

Use the existing `restoreSelection` and `insertHtml` path so the command works after a dialog has taken focus. Do not use `document.execCommand('insertText')` for formula nodes because that would lose the data attribute.

- [ ] **Step 4: Add the formula toolbar button and dialog.**

Extend the `Dialog` union with `'formula'`, add a toolbar button in the insert group with a `∑` glyph, title `数学公式`, and `onMouseDown={(event) => event.preventDefault()}`. Add `FormulaDialog` with:

- a select for `行内公式` / `块级公式`;
- a text input for inline formula and textarea for block formula;
- a preview that displays the safe formula text inside `.pp-math-inline` or `.pp-math-block`;
- an insert button disabled when the formula is blank;
- `commands.saveSelection()` before opening and `commands.formula(value, block)` on confirmation.

Keep the dialog text explicit that the formula syntax is preserved as `$...$` or `$$...$$`; do not render untrusted HTML from the formula field.

- [ ] **Step 5: Make formula nodes directly editable and non-navigating.**

Keep formula text as text inside the node, allow normal contenteditable editing, and add a double-click handler that focuses/selects the node text. Do not set `contenteditable="false"`, because the zero-dependency design requires the author to edit the formula text directly. Preserve the existing link click prevention, paste-to-plain-text behavior, card Enter behavior, and table Tab behavior.

- [ ] **Step 6: Run typecheck and serialization tests.**

Run:

```powershell
npm run test -- --run
npm run typecheck
```

Expected: serialization tests pass; typecheck may still report stale `EditorPage` references until Task 4, but it must report only the known old `Editor.tsx` API mismatch. Record the exact errors before continuing.

- [ ] **Step 7: Commit the rich surface and toolbar contract.**

```powershell
git add apps/web/src/components/RichTextEditor.tsx apps/web/src/components/EditorToolbar.tsx apps/web/src/styles.css
git commit -m "feat: add formula command to rich editor"
```

---

### Task 4: Replace the Markdown textarea in the content editor page

**Files:**
- Modify: `apps/web/src/pages/admin/Editor.tsx:1-610`
- Modify: `apps/web/src/lib/editorSource.ts`

**Interfaces:**
- Consumes: `normalizeEditorSource`, `RichTextEditor`, `EditorToolbar` through `RichTextEditor`, existing `Backend`, `Content`, `DraftInput`, `useUnsavedWarning`, and workflow actions.
- Produces: a compiling `EditorPage` whose form always saves `source_format: 'markdown'` and whose editor surface never displays Markdown source syntax.

- [ ] **Step 1: Replace stale textarea-specific state and imports.**

Remove imports that only support the old split preview (`useDeferredValue`, `useMemo`, unused `useRef` values, `htmlToText`, old `EditorToolbar` and `EditorActions`). Import:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { RichTextEditor } from '../../components/RichTextEditor';
import { normalizeEditorSource } from '../../lib/editorSource';
```

Keep `useRef` for the hidden Markdown file input. Replace `surface` with:

```ts
const [surface, setSurface] = useState<{ html: string; revision: string }>({
  html: '',
  revision: '0',
});
const [wordCount, setWordCount] = useState(0);
const revisionRef = useRef(0);
const importRef = useRef<HTMLInputElement>(null);
```

Delete `previewOpen`, `bodyRef`, `previewRef`, `deferredBody`, `previewHtml`, `editorActions`, `syncScroll`, and any old textarea-only helpers.

- [ ] **Step 2: Normalize loaded content into one form representation.**

Add:

```ts
const mountSurface = useCallback((html: string) => {
  revisionRef.current += 1;
  setSurface({ html, revision: `r${revisionRef.current}` });
}, []);
```

When a new draft is selected, set `form` and `initial` to `EMPTY` and mount an empty surface. When an existing item is loaded, use the seeded source body when it matches the item, otherwise `item.source_body`; if no source body exists, preserve the current read-only warning. For editable source:

```ts
const normalized = normalizeEditorSource(item.source_format, source);
const next: FormState = {
  title: item.title,
  slug: item.slug,
  summary: item.summary ?? '',
  source_format: 'markdown',
  source_body: normalized.markdown,
};
setForm(next);
setInitial(next);
setLoadedId(item.id);
mountSurface(normalized.html);
```

The effect dependency list must continue to avoid reloading the surface on every keystroke; it should reload only when `item`, `isNew`, `seed`, or `loadedId` changes.

- [ ] **Step 3: Add Markdown import and export handlers.**

Keep the 2 MB file limit and add a clear file read error path:

```ts
const importMarkdown = async (file: File) => {
  if (file.size > 2_000_000) {
    toast.push('error', '文件太大', 'Markdown 文件不应超过 2 MB。');
    return;
  }
  try {
    const body = (await file.text()).slice(0, 200_000);
    update({ source_format: 'markdown', source_body: body });
    mountSurface(normalizeEditorSource('markdown', body).html);
    toast.push('ok', '已导入 Markdown', '内容还没有保存，记得保存草稿。');
  } catch {
    toast.push('error', '导入失败', '无法读取这个 Markdown 文件。');
  }
};
```

Export the current `form.source_body` as UTF-8 Markdown. Use the existing filename sanitation and `URL.revokeObjectURL` cleanup. Do not reset `initial` after export.

- [ ] **Step 4: Replace the old editor split with `RichTextEditor`.**

Inside `.editor-main`, keep title and summary fields, then render:

```tsx
<div className="editor-controls">
  <div className="editor-mode">
    <span>{form.source_body.length.toLocaleString()} 字符</span>
    {form.source_body ? <span>· 约 {wordCount.toLocaleString()} 字</span> : null}
  </div>
  <span className="tiny faint">所见即所得 · 保存时使用 Markdown</span>
</div>

<RichTextEditor
  initialHtml={surface.html}
  revision={surface.revision}
  disabled={!editable}
  onChange={(markdown, stats) => {
    update({ source_format: 'markdown', source_body: markdown });
    setWordCount(stats.text);
  }}
/>
```

Keep the form error callout below the editor. Remove the source pane, preview pane, preview toggle, source-format label, textarea keydown wrapper, and local `dangerouslySetInnerHTML` preview.

- [ ] **Step 5: Add page-level import/export controls.**

In `.admin-page-actions`, add:

```tsx
{editable ? (
  <>
    <Button variant="secondary" size="sm" icon="upload" onClick={() => importRef.current?.click()}>
      导入 Markdown
    </Button>
    <Button
      variant="secondary"
      size="sm"
      icon="download"
      disabled={!form.source_body.trim()}
      onClick={exportMarkdown}
    >
      导出 Markdown
    </Button>
  </>
) : null}
<input
  ref={importRef}
  type="file"
  accept=".md,text/markdown,text/plain"
  hidden
  onChange={(event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void importMarkdown(file);
  }}
/>
```

Keep the existing save button and process controls. On save, send `source_format: 'markdown'`, set the initial snapshot to the normalized payload after a successful update, and keep navigation state populated with the latest Markdown for newly created drafts.

- [ ] **Step 6: Run typecheck and verify the old references are gone.**

Run:

```powershell
npm run typecheck
```

Expected: PASS with no references to `previewOpen`, `editorActions`, `bodyRef`, `previewRef`, `deferredBody`, `previewHtml`, or `syncScroll`. Search:

```powershell
rg "previewOpen|editorActions|bodyRef|previewRef|deferredBody|previewHtml|syncScroll|<textarea" apps/web/src/pages/admin/Editor.tsx
```

Expected: no matches.

- [ ] **Step 7: Commit the page integration.**

```powershell
git add apps/web/src/pages/admin/Editor.tsx apps/web/src/lib/editorSource.ts
git commit -m "feat: make content editing wysiwyg"
```

---

### Task 5: Make the admin editor responsive and use the full desktop width

**Files:**
- Modify: `apps/web/src/components/AdminShell.tsx:175-199`
- Modify: `apps/web/src/styles.css:2164-2198, 2335-2477, 3170-3305`

**Interfaces:**
- Consumes: the new `.editor-workspace`/content editor route state from Task 4.
- Produces: wide desktop editor layout, single-column intermediate layout, touch-safe mobile toolbar and no page-level horizontal overflow.

- [ ] **Step 1: Add a wide content-editor class at the shell boundary.**

In `AdminShell`, derive:

```ts
const isContentEditor = /^\/admin\/content\/(new\/)?[^/]+(?:\/[^/]+)?$/.test(location.pathname);
```

Apply it to the outlet wrapper:

```tsx
<div className={`admin-content fade-up${isContentEditor ? ' admin-content-wide' : ''}`}>
  <Outlet />
</div>
```

This keeps other admin screens at their existing width while allowing the content editor to use the available desktop space.

- [ ] **Step 2: Replace obsolete textarea/preview CSS with rich-surface CSS.**

Keep `.editor-grid`, `.editor-main`, `.editor-side`, `.editor-title-input`, and `.editor-mode`, but update them to include `min-width: 0`. Remove the old `.editor-body`, `.editor-split`, `.editor-pane`, `.editor-pane-head`, `.editor-preview-live`, `.preview-head`, and `.preview-kicker` rules. Add:

```css
.admin-content-wide { max-width: 1500px; }
.editor-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 320px);
  gap: 28px;
  align-items: start;
}
.editor-main,
.editor-side,
.rich-editor { min-width: 0; }
.editor-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.rich-editor { display: flex; flex-direction: column; gap: 10px; }
.rich-surface {
  min-height: clamp(420px, calc(100vh - 330px), 820px);
  padding: 28px clamp(18px, 3vw, 42px) 48px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: #fff;
  color: var(--ink);
  font-family: var(--serif);
  font-size: 17px;
  line-height: 1.9;
  overflow-wrap: anywhere;
  outline: none;
}
.rich-surface:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(31, 92, 74, 0.08);
}
.rich-surface[data-empty="true"]::before {
  content: attr(data-placeholder);
  display: block;
  color: var(--faint);
  pointer-events: none;
}
.rich-editor-note,
.rich-toolbar-hint { font-size: 11px; line-height: 1.6; color: var(--faint); }
.pp-math-inline,
.pp-math-block {
  color: var(--ink);
  font-family: var(--mono);
  background: var(--bg-subtle);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  white-space: pre-wrap;
}
.pp-math-inline { display: inline-block; padding: 0 5px; line-height: 1.45; }
.pp-math-block { display: block; margin: 24px 0; padding: 14px 16px; text-align: center; }
```

- [ ] **Step 3: Implement the three responsive breakpoints.**

Replace the editor-specific parts of the existing responsive rules with:

```css
@media (max-width: 1199px) {
  .editor-grid { grid-template-columns: minmax(0, 1fr); }
  .editor-side { position: static; }
  .rich-surface { min-height: 520px; }
}

@media (max-width: 820px) {
  .editor-grid { gap: 20px; }
  .editor-title-input { font-size: 28px; }
  .rich-surface { min-height: 480px; padding: 22px 18px 38px; font-size: 16px; }
  .admin-page-actions { width: 100%; flex-wrap: wrap; }
}

@media (max-width: 640px) {
  .editor-title-input { font-size: 25px; }
  .editor-controls { align-items: flex-start; }
  .rich-toolbar { overflow: hidden; }
  .rich-toolbar-row { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 2px; scrollbar-width: none; }
  .rich-toolbar-row::-webkit-scrollbar { display: none; }
  .tool-group, .tool-sep, .tool-btn { flex: none; }
  .rich-toolbar-hint { display: none; }
  .rich-surface { min-height: 430px; padding: 18px 14px 32px; font-size: 16px; }
  .editor-side { gap: 12px; }
}
```

Ensure existing global `.admin-main` padding rules remain the source of outer spacing; do not introduce a fixed width or `100vw` inside the editor.

- [ ] **Step 4: Add overflow guards for special blocks.**

Update the rich block styles so tables use `display: block; overflow-x: auto; max-width: 100%;` only when they cannot fit, while `.pp-columns` and `.pp-gallery` use `minmax(0, 1fr)` tracks. Add:

```css
.rich-surface img,
.rich-surface table,
.rich-surface .pp-video,
.rich-surface .pp-embed { max-width: 100%; }
.rich-surface .pp-table { overflow-x: auto; }
.rich-surface a.pp-video,
.rich-surface a.pp-embed { overflow-wrap: anywhere; }
```

- [ ] **Step 5: Run the build and inspect computed layout locally.**

Run:

```powershell
npm run typecheck
npm run build
```

Expected: both commands pass. Start the existing Vite app only if no managed app server is already running, then inspect the content editor at widths 1536, 1024, and 390. Verify the editor grid and toolbar do not introduce a document-level horizontal scrollbar.

- [ ] **Step 6: Commit the responsive layout.**

```powershell
git add apps/web/src/components/AdminShell.tsx apps/web/src/styles.css
git commit -m "feat: make content editor responsive"
```

---

### Task 6: Run browser interaction verification and close the implementation

**Files:**
- Modify: `apps/web/src/lib/markdown.test.ts` only if a browser-discovered serialization regression needs a focused regression case.
- Modify: `apps/web/src/lib/htmlToMarkdown.test.ts` only if a browser-discovered serialization regression needs a focused serialization regression case.
- Create: `artifacts/content-editor-wide.png`, `artifacts/content-editor-tablet.png`, `artifacts/content-editor-mobile.png` as verification artifacts outside source control if the repository ignores `artifacts/`.

**Interfaces:**
- Consumes: the complete content editor from Tasks 1–5.
- Produces: evidence for import/export, WYSIWYG editing, responsive layout and no console errors.

- [ ] **Step 1: Launch or reuse the project web server.**

Use the existing project server convention from `apps/web/README.md`; do not replace the DeepSeek Harness GUI server. If port 80 is occupied, let Vite choose an available port and record the exact URL. Confirm the page loads before interacting.

- [ ] **Step 2: Verify WYSIWYG editing in a new article.**

In the browser:

1. Enter demo mode if setup is required and sign in with the seeded writer/admin account.
2. Open `/admin/content/new/article`.
3. Confirm the editor surface is a contenteditable element and no Markdown textarea or source preview is visible.
4. Type a paragraph, select a phrase, click bold, add a heading, list, link and formula.
5. Confirm the visible result is formatted text/formula nodes and the character count changes.
6. Insert an image, website card, table, columns, icon and note using the existing dialogs; verify each is visible in the editing surface.

Expected: the caret remains usable after each toolbar command; links do not navigate when clicked in the editor; table Tab moves between cells; formula content remains plain safe text inside its formula node.

- [ ] **Step 3: Verify Markdown import and export.**

Create a temporary `sample.md` containing:

```markdown
# 导入标题

这是一段 **粗体**，公式是 $v = s/t$。

- 一项
- 另一项

$$x^2 + y^2 = z^2$$
```

Use the import button and confirm the editor shows formatted content, not the Markdown markers. Export the result and inspect the downloaded file contents. The file must contain headings, emphasis markers, list markers, `$v = s/t$`, and `$$x^2 + y^2 = z^2$$`.

- [ ] **Step 4: Verify save contract and read-only behavior.**

Save the imported draft, inspect the demo backend/local state or request payload, and confirm:

```text
source_format === "markdown"
source_body contains Markdown, not editor HTML
```

Open a published or source-missing content item and confirm the editor cannot modify the body and the existing safety warning remains visible.

- [ ] **Step 5: Verify responsive viewports and overflow.**

Use browser viewport sizes:

```text
1536 × 900  wide desktop
1024 × 768  medium window
390 × 844   mobile
```

At each size assert:

```js
document.documentElement.scrollWidth <= document.documentElement.clientWidth
```

Also confirm that the wide desktop uses the available width, the medium viewport stacks the metadata sidebar below the editor, and the mobile toolbar scrolls inside its own row instead of moving the page horizontally.

- [ ] **Step 6: Capture screenshots and review the browser console.**

Save the three viewport screenshots under `artifacts/` if that directory is ignored. Check for uncaught exceptions, React warnings, failed asset requests, and broken focus after opening/closing dialogs. Fix any issue found before completion; add a focused serialization regression test when the issue is data conversion related.

- [ ] **Step 7: Run the complete verification suite.**

From `apps/web` run:

```powershell
npm run test -- --run
npm run typecheck
npm run build
```

Expected: all Vitest tests pass, TypeScript emits no errors, and Vite produces `dist/` successfully. Collect any still-running background job output before reporting completion.

- [ ] **Step 8: Commit the final verification changes.**

```powershell
git add apps/web/src/lib/markdown.test.ts apps/web/src/lib/htmlToMarkdown.test.ts
git commit -m "test: verify responsive rich content editor"
```

Do not commit screenshots unless the repository explicitly tracks verification artifacts.

---

## Plan Self-Review

- **Spec coverage:** Task 1 covers test infrastructure and historical source normalization; Task 2 covers formula parsing, sanitization and Markdown round-trip; Task 3 covers the contenteditable surface, toolbar, existing special blocks and formula editing; Task 4 covers page integration, import/export, save format and read-only behavior; Task 5 covers the wide desktop container and three responsive breakpoints; Task 6 covers browser interaction, save contract, overflow and screenshots.
- **Placeholder scan:** The plan contains no `TODO`, `TBD`, or unspecified implementation step. Every task identifies exact files, interfaces, commands and expected results.
- **Type consistency:** `normalizeEditorSource` returns `{ markdown, html }`; `RichTextEditor.onChange` returns `(markdown, stats)`; `EditorCommands.formula` accepts `(source: string, block: boolean)`; `EditorPage` passes the exact callback and saves `source_format: 'markdown'`.
- **Dependency check:** `happy-dom` and `vitest` are test-only dependencies. No runtime editor dependency is added, and KaTeX/MathJax remain explicitly excluded.
- **Scope check:** Only the article/post editor, its shared rich editor components, Markdown serializers and responsive shell styles are included. The independent page editor is outside the plan.
