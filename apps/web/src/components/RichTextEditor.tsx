import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import { escapeHtml, renderMarkdown } from '../lib/markdown';
import { htmlToMarkdown } from '../lib/htmlToMarkdown';
import { decorateEditorDiagrams, findDiagramBlock } from '../lib/diagramHydrate';
import type { DiagramSpec } from '../lib/diagramSpec';
import { useBackend } from '../lib/backend';
import { errorText } from '../lib/hooks';
import {
  detectBlockPrefix,
  detectInlineClosure,
  looksLikeMarkdown,
} from '../lib/markdownInput';
import type { BlockKind, InlineClosureMatch } from '../lib/markdownInput';
import { blockMarkerFor } from '../lib/editorBlockMarker';
import { caretAnchor, firstLineAnchor } from '../lib/caretRect';
import type { CaretAnchor } from '../lib/caretRect';
import { imageBlock, noteBlock } from '../lib/richBlocks';
import { useT } from '../lib/i18n';
import { EditorToolbar } from './EditorToolbar';
import { SlashMenu } from './SlashMenu';
import type { SlashItem } from './SlashMenu';

/**
 * 所见即所得编辑器。
 *
 * 作者直接在排版结果上编辑：标题就是标题，图片就是图片，分栏就是两栏。
 * 存盘时才把 DOM 序列化成 Markdown（`lib/htmlToMarkdown`），公开页再由服务端把
 * Markdown 渲染成 HTML 并按白名单清洗。
 *
 * 几个有意的实现选择：
 * - 用 contenteditable + execCommand 而不是自绘光标模型：中文 IME、选区、撤销都由浏览器
 *   处理，比手写 range 映射可靠得多。
 * - 富文本区块（视频卡、嵌入卡、分栏、提示框…）按 class 识别，序列化时原样写成 HTML 区块，
 *   不会退化成纯文字。
 * - 粘贴一律按纯文本处理：从网页复制来的样式会污染排版，也会被服务端清洗掉，不如一开始就说清楚。
 */

/** 斜杠面板里「需要参数」的指令转交工具栏弹窗。 */
export type EditorDialogKind =
  | 'image'
  | 'table'
  | 'columns'
  | 'formula'
  | 'link'
  | 'video'
  | 'diagram';

// 浏览器回车可能产生 div（而不是 p），所以 div 也当作块处理。
const BLOCK_TAGS = 'p,div,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td,th';

/** 光标所在的块级元素；裸文本挂在编辑区根节点上时返回 null。 */
function closestBlock(root: HTMLElement, node: Node | null): HTMLElement | null {
  if (!node || !root.contains(node)) return null;
  let element: HTMLElement | null =
    node.nodeType === Node.TEXT_NODE
      ? (node.parentElement as HTMLElement | null)
      : (node as HTMLElement);
  while (element && element !== root) {
    if (element.matches(BLOCK_TAGS)) return element;
    element = element.parentElement;
  }
  return null;
}

/**
 * 光标所在的「有行首语法」的块：从光标节点往上找第一个有 Markdown 行首的祖先。
 *
 * 不能只看最近块：`blockquote` 里常常包着一个 `p`、`pre` 里包着 `code`，
 * 而这些内层元素本身没有行首语法，只认最近块的话引用和代码块就永远不显示标记。
 */
function markerBlockFor(root: HTMLElement, node: Node | null): HTMLElement | null {
  if (!node || !root.contains(node)) return null;
  let element: HTMLElement | null =
    node.nodeType === Node.TEXT_NODE
      ? (node.parentElement as HTMLElement | null)
      : (node as HTMLElement);
  while (element && element !== root) {
    if (blockMarkerFor(element)) return element;
    element = element.parentElement;
  }
  return null;
}

/** 滚动 / 缩放时锚点常常只差零点几像素：没变就不重排面板。 */
function sameAnchor(a: CaretAnchor | null, b: CaretAnchor | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.bottom - b.bottom) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

/** 与后端媒体白名单一致的图片类型；截图、拖拽文件都走这里判断。 */
const UPLOAD_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const IMAGE_EXTENSION_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * 把剪贴板 / 拖拽里的文件归一成可上传的图片。
 *
 * 有些来源（尤其是从浏览器里拖出的图片）不给 MIME，只能按扩展名补一个；
 * 补不出来的文件直接忽略，交给后面的可读提示，而不是把二进制塞进正文。
 */
function uploadableImage(file: File): File | null {
  if (UPLOAD_IMAGE_TYPES.has(file.type)) return file;
  const extension = (file.name.split('.').pop() ?? '').toLowerCase();
  const inferred = IMAGE_EXTENSION_MIME[extension];
  if (!inferred) return null;
  return new File([file], file.name || `pasted.${extension}`, {
    type: inferred,
    lastModified: file.lastModified,
  });
}

/** 从 DataTransfer 里收集图片文件；`files` 与 `items` 可能重复，按内容去重。 */
function imageFilesFromTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  const collected = new Map<string, File>();
  const add = (file: File | null) => {
    if (!file) return;
    const normalized = uploadableImage(file);
    if (!normalized) return;
    const key = `${normalized.name}:${normalized.size}:${normalized.lastModified}:${normalized.type}`;
    if (!collected.has(key)) collected.set(key, normalized);
  };
  for (const file of Array.from(data.files ?? [])) add(file);
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file') add(item.getAsFile());
  }
  return [...collected.values()];
}

/** 把鼠标落点换算成编辑区里的光标；不支持该 API 的浏览器返回 null。 */
function rangeAtPoint(x: number, y: number): Range | null {
  const doc = document as unknown as {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
  const position = doc.caretPositionFromPoint?.(x, y);
  if (!position) return null;
  const range = document.createRange();
  range.setStart(position.offsetNode, position.offset);
  range.collapse(true);
  return range;
}

/**
 * 保证裸文本有可操作的块：浏览器的 contenteditable 在空文档里输入时可能把
 * 文字直接挂在根节点下，块级转换需要一个段落才能执行。
 */
function ensureBlock(root: HTMLElement, node: Node | null): HTMLElement | null {
  const existing = closestBlock(root, node);
  if (existing) return existing;
  if (!node || !root.contains(node)) return null;
  let child: Node = node;
  while (child.parentNode && child.parentNode !== root) child = child.parentNode;
  if (child.parentNode !== root) return null;

  // 搬动文本节点会让浏览器把光标丢到编辑区根节点上（悬空选区：anchorNode 变成根 DIV），
  // 紧接着的 `/` 面板与行首标记就读不到"当前块"了——空文档里敲第一个字符就属于这种情况。
  // 节点对象本身没换、只是换了父级，所以先记下 (container, offset)，包好段落再原样放回去。
  const selection = window.getSelection();
  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const caret = range ? { container: range.startContainer, offset: range.startOffset } : null;
  const caretInRoot = !!caret && root.contains(caret.container);

  const paragraph = document.createElement('p');
  root.insertBefore(paragraph, child);
  paragraph.appendChild(child);

  if (selection && caret && caretInRoot) {
    const limit =
      caret.container.nodeType === Node.TEXT_NODE
        ? (caret.container as Text).data.length
        : (caret.container as Element).childNodes.length;
    const restored = document.createRange();
    if (caret.container !== root && caret.offset <= limit) {
      restored.setStart(caret.container, caret.offset);
      restored.collapse(true);
    } else {
      // 坐标本来就落在根节点上（浏览器已经丢过一次光标）：放到刚搬进去那段文字的末尾，
      // 那正是作者刚敲下的位置。
      restored.selectNodeContents(paragraph);
      restored.collapse(false);
    }
    selection.removeAllRanges();
    selection.addRange(restored);
  }
  return paragraph;
}

/** 块首到 (node, offset) 之间的文本，用于识别块级前缀。 */
function blockTextBeforeCaret(block: HTMLElement, node: Node, offset: number): string | null {
  if (!block.contains(node)) return null;
  const range = document.createRange();
  try {
    range.setStart(block, 0);
    range.setEnd(node, offset);
  } catch {
    // 悬空选区的 offset 可能越界（DOM 刚被搬动过），这种位置算不出前缀，别让输入中断。
    return null;
  }
  return range.toString();
}

interface TextPoint {
  node: Text;
  offset: number;
}

/** 把「块内文本偏移」换算成真实 DOM 文本坐标。 */
function textPointAt(block: HTMLElement, offset: number): TextPoint | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let last: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (remaining <= text.data.length) return { node: text, offset: remaining };
    remaining -= text.data.length;
    last = text;
  }
  return last ? { node: last, offset: last.data.length } : null;
}

function collapseToBlock(block: HTMLElement | null, where: 'start' | 'end'): void {
  if (!block || !block.isConnected) return;
  const range = document.createRange();
  range.selectNodeContents(block);
  range.collapse(where === 'start');
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** 行内 Markdown 闭合后要插入的 HTML；所有作者文字先转义。 */
function inlineClosureHtml(match: InlineClosureMatch): string {
  switch (match.kind) {
    case 'bold':
      return `<strong>${escapeHtml(match.inner)}</strong>`;
    case 'italic':
      return `<em>${escapeHtml(match.inner)}</em>`;
    case 'code':
      return `<code>${escapeHtml(match.inner)}</code>`;
    case 'strike':
      return `<del>${escapeHtml(match.inner)}</del>`;
    case 'link': {
      const href = match.href ?? '';
      return `<a href="${escapeHtml(href)}">${escapeHtml(match.inner || href)}</a>`;
    }
  }
}

export interface EditorCommands {
  heading: (level: 2 | 3 | 4) => void;
  paragraph: () => void;
  bold: () => void;
  italic: () => void;
  strike: () => void;
  inlineCode: () => void;
  list: (kind: 'ul' | 'ol') => void;
  quote: () => void;
  codeBlock: () => void;
  divider: () => void;
  link: (href: string, text?: string) => void;
  insert: (html: string) => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
  formula: (source: string, block: boolean) => void;
  /**
   * 光标/选区在图表块内时返回它的规格与整块替换函数；否则 null。
   * 工具栏用它实现「编辑图表」而不是再插入一块。
   */
  diagramTarget: () => { spec: DiagramSpec; replace: (html: string) => void } | null;
  /** 打开弹窗之前先记住选区，插入时再恢复。 */
  saveSelection: () => void;
}

export interface EditorStats {
  /** 去掉空白后的字符数，用来显示「约 N 字」。 */
  text: number;
}

export function RichTextEditor({
  initialHtml,
  revision,
  onChange,
  disabled = false,
  placeholder,
  onRequestDialog,
}: {
  initialHtml: string;
  /** 变化时把 initialHtml 重新灌进编辑区（切换稿件、导入 Markdown）。 */
  revision: string;
  onChange: (markdown: string, stats: EditorStats) => void;
  disabled?: boolean;
  placeholder?: string;
  /** 斜杠面板里需要参数的指令：有外部处理器时交给它，否则用内置工具栏弹窗。 */
  onRequestDialog?: (kind: EditorDialogKind) => void;
}) {
  const t = useT();
  const backend = useBackend();
  const placeholderText =
    placeholder ?? t('从这里开始写。选中文字可以加粗、加链接，工具栏能插入图片、表格与分栏。');
  const surfaceRef = useRef<HTMLDivElement>(null);
  // 浮层的定位上下文：标记与编辑区是兄弟节点，这样标记永远不会进 contenteditable 子树。
  const shellRef = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);
  const emitted = useRef('');
  // IME 组字期间不做 Markdown 转换：中文输入法会临时产生不符合语法的中间文本。
  const composing = useRef(false);
  // 工具栏把自己的 open(kind) 注册进来，斜杠面板才能复用现有弹窗。
  const toolbarOpen = useRef<((kind: EditorDialogKind) => void) | null>(null);
  const hintTimer = useRef<number | null>(null);
  const [hint, setHint] = useState('');
  /** 上传失败的持久提示：几秒就消失的 toast 不足以让作者看清原因。 */
  const [uploadError, setUploadError] = useState('');
  const uploading = useRef(false);
  const [marker, setMarker] = useState<{
    text: string;
    /** 相对 shell 的坐标，不是视口坐标。 */
    top: number;
    height: number;
    left: number;
  } | null>(null);
  const [slash, setSlash] = useState<{
    query: string;
    /** 光标锚点（视口坐标）；落点由面板自己算。 */
    anchor: CaretAnchor | null;
  } | null>(null);
  const markerRef = useRef<HTMLSpanElement>(null);
  // 标记画在正文左侧留白里：留白放不下（窄屏的 `####`）就不显示，绝不允许压到正文
  // 或溢出卡片。这里用"量出来再隐藏"而不是猜字号，因为留白宽度随视口连续变化。
  const [markerClipped, setMarkerClipped] = useState(false);
  const [slashActiveId, setSlashActiveId] = useState<string | null>(null);
  const slashOpen = slash !== null;

  const emit = useCallback(() => {
    const root = surfaceRef.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('[data-pp-math]').forEach((node) => {
      node.dataset.ppMath = (node.textContent ?? '').replace(/\r\n/g, '\n').trim();
    });
    const text = (root.innerText ?? '').replace(/\s+/g, '');
    const isEmpty = text.length === 0 && !root.querySelector('img,table,a.pp-video,a.pp-embed,a.pp-linkcard,hr,[data-pp-math]');
    root.dataset.empty = isEmpty ? 'true' : 'false';
    const markdown = htmlToMarkdown(root.innerHTML);
    // 图表代码块在正文里显示成可见预览；隐藏的 code 仍参与上面的序列化。
    decorateEditorDiagrams(root);
    emitted.current = markdown;
    onChange(markdown, { text: text.length });
  }, [onChange]);

  // 切换稿件或导入：整体替换编辑区内容。
  useEffect(() => {
    const root = surfaceRef.current;
    if (!root) return;
    root.innerHTML = initialHtml;
    emitted.current = '';
    // 重新灌入后恢复图表的可见预览（围栏代码块在正文里不能只显示 JSON）。
    decorateEditorDiagrams(root);
    // 让浏览器按内容重新计算空状态。
    const text = (root.innerText ?? '').replace(/\s+/g, '');
    const isEmpty = text.length === 0 && !root.querySelector('img,table,a.pp-video,a.pp-embed,a.pp-linkcard,hr,[data-pp-math]');
    root.dataset.empty = isEmpty ? 'true' : 'false';
    // 整块内容被换掉，旧的光标位置已经没有意义。
    setMarker(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  useEffect(() => {
    // 让 bold / italic 生成 <b>、<i> 而不是带内联样式的 span。
    try {
      document.execCommand('styleWithCSS', false, 'false');
    } catch {
      /* 不支持就算了，属于增强项 */
    }
  }, []);

  const focusSurface = () => {
    surfaceRef.current?.focus();
  };

  const saveSelection = useCallback(() => {
    const root = surfaceRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0) return;
    if (!root.contains(selection.anchorNode)) return;
    savedRange.current = selection.getRangeAt(0).cloneRange();
  }, []);

  const restoreSelection = useCallback(() => {
    const root = surfaceRef.current;
    if (!root) return;
    root.focus();
    const range = savedRange.current;
    if (!range) {
      // 没有记录过选区：把光标放到末尾，至少不会插到文档开头。
      const end = document.createRange();
      end.selectNodeContents(root);
      end.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(end);
      return;
    }
    if (!root.contains(range.commonAncestorContainer)) return;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, []);

  /**
   * 行首淡色标记的同步：只读几何，不碰 DOM 内容。
   *
   * 标记必须留在 contenteditable 外面——进了编辑区子树，`htmlToMarkdown` 存盘、
   * `innerText` 字数、复制粘贴都会带上它。所以这里也刻意不插探针节点去量零尺寸光标。
   */
  const syncMarker = useCallback(() => {
    const root = surfaceRef.current;
    const shell = shellRef.current;
    if (!root || !shell || disabled) {
      setMarker(null);
      return;
    }
    const selection = window.getSelection();
    const anchorNode = selection?.anchorNode ?? null;
    if (!selection || selection.rangeCount === 0 || !anchorNode || !root.contains(anchorNode)) {
      setMarker(null);
      return;
    }
    const block = markerBlockFor(root, anchorNode);
    const text = block ? blockMarkerFor(block) : null;
    if (!block || !text) {
      setMarker(null);
      return;
    }
    const line = firstLineAnchor(block);
    if (!line) {
      setMarker(null);
      return;
    }
    const surfaceRect = root.getBoundingClientRect();
    // 行盒滚出编辑区就干脆不画，而不是贴在上下边框上排队。
    if (line.bottom < surfaceRect.top || line.top > surfaceRect.bottom) {
      setMarker(null);
      return;
    }
    const shellRect = shell.getBoundingClientRect();
    // 标记右边缘贴在正文栏左边缘再退 8px；CSS 的 translateX(-100%) 负责把整块让到留白里。
    const left = (parseFloat(getComputedStyle(root).paddingLeft) || 0) - 6;
    const top = line.top - shellRect.top;
    // 量不到行盒时会降级到整块矩形，那种高度会把标记吊在块中间，按行高压回来。
    const lineHeight = parseFloat(getComputedStyle(block).lineHeight);
    const height =
      Number.isFinite(lineHeight) && lineHeight > 0
        ? Math.min(line.height || lineHeight, lineHeight)
        : line.height;
    setMarker((prev) => {
      // 同一行里打字时行盒会微动，阈值以下的抖动不值得重渲染。
      if (
        prev &&
        prev.text === text &&
        Math.abs(prev.top - top) < 0.5 &&
        Math.abs(prev.left - left) < 0.5 &&
        Math.abs(prev.height - height) < 0.5
      ) {
        return prev;
      }
      return { text, top, height, left };
    });
  }, [disabled]);

  /**
   * 量一次标记宽度：留白（padding-left）放不下就隐藏。
   *
   * 元素始终保留在 DOM 里（只切 visibility），否则 ref 变空就再也量不到，
   * 会在"隐藏 → 重新显示 → 又溢出"之间来回跳。
   */
  useLayoutEffect(() => {
    const element = markerRef.current;
    if (!element) {
      setMarkerClipped(false);
      return;
    }
    setMarkerClipped(element.offsetWidth - marker!.left > 2);
    // marker 每次移动/换字都会是新对象，量测跟着它走即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marker?.text, marker?.left]);

  const run = useCallback(
    (command: string, value?: string) => {
      if (disabled) return;
      focusSurface();
      try {
        document.execCommand(command, false, value);
      } catch {
        /* 命令不被支持时保持原样，不抛给作者 */
      }
      emit();
    },
    [disabled, emit],
  );

  const insertHtml = useCallback(
    (html: string) => {
      if (disabled) return;
      restoreSelection();
      // 区块前后留空段落，Markdown 序列化时自然带空行，也方便继续输入。
      const payload = html.trim().startsWith('<p data-pp-spacer')
        ? html
        : `<p data-pp-spacer="1"><br></p>${html}<p data-pp-spacer="1"><br></p>`;
      document.execCommand('insertHTML', false, payload);
      emit();
    },
    [disabled, emit, restoreSelection],
  );

  /**
   * 粘贴 / 拖拽上传完成后插到「事件发生时的光标处」。
   *
   * 上传是异步的，中间作者可能点过别处；工具栏的 `insertHtml` 用的是上次保存的选区，
   * 在这里不适用。调用方在 paste / drop 当下克隆 Range，完成后再恢复。
   */
  const insertHtmlAtRange = useCallback(
    (html: string, range: Range | null) => {
      if (disabled) return;
      const root = surfaceRef.current;
      if (!root) return;
      root.focus();
      const selection = window.getSelection();
      let target = range && root.contains(range.commonAncestorContainer) ? range : null;
      if (!target) {
        // 找不到落点就放到正文末尾，至少不会插到文档开头。
        target = document.createRange();
        target.selectNodeContents(root);
        target.collapse(false);
      }
      selection?.removeAllRanges();
      selection?.addRange(target);
      const payload = `<p data-pp-spacer="1"><br></p>${html}<p data-pp-spacer="1"><br></p>`;
      document.execCommand('insertHTML', false, payload);
      emit();
    },
    [disabled, emit],
  );

  const commands = useMemo<EditorCommands>(
    () => ({
      saveSelection,
      heading: (level) => {
        focusSurface();
        // 已经是同一级标题就退回正文，和常见编辑器的手感一致。
        const block = document.queryCommandValue('formatBlock').toLowerCase();
        run('formatBlock', block === `h${level}` ? 'P' : `H${level}`);
      },
      paragraph: () => run('formatBlock', 'P'),
      bold: () => run('bold'),
      italic: () => run('italic'),
      strike: () => run('strikeThrough'),
      // 下面两处无选区时插入的是会随稿件存盘的示例文字（`代码`、`在这里写代码`），
      // 属于内容而不是界面文案，规则同 `lib/richBlocks.ts` 的区块构造函数：保持原文，不走 `t()`。
      inlineCode: () => {
        const selected = window.getSelection()?.toString() ?? '';
        insertHtml(`<code>${escapeHtml(selected || '代码')}</code>`);
      },
      list: (kind) => run(kind === 'ul' ? 'insertUnorderedList' : 'insertOrderedList'),
      quote: () => run('formatBlock', 'BLOCKQUOTE'),
      codeBlock: () => {
        const selected = window.getSelection()?.toString() ?? '在这里写代码';
        insertHtml(`<pre><code>${escapeHtml(selected)}</code></pre>`);
      },
      divider: () => insertHtml('<hr />'),
      link: (href, text) => {
        if (!href) return;
        restoreSelection();
        const selection = window.getSelection();
        const hasSelection = !!selection && selection.toString().trim().length > 0;
        if (hasSelection) {
          document.execCommand('createLink', false, href);
        } else {
          const label = escapeHtml(text || href);
          document.execCommand(
            'insertHTML',
            false,
            `<a href="${escapeHtml(href)}">${label}</a>`,
          );
        }
        emit();
      },
      formula: (source, block) => {
        const value = source.replace(/\r\n/g, '\n').trim();
        if (!value || disabled) return;
        const markup = block
          ? `<p class="pp-math-block" data-pp-math="${escapeHtml(value)}">${escapeHtml(value)}</p>`
          : `<span class="pp-math-inline" data-pp-math="${escapeHtml(value)}">${escapeHtml(value)}</span>`;
        if (block) {
          insertHtml(markup);
          return;
        }
        restoreSelection();
        document.execCommand('insertHTML', false, markup);
        emit();
      },
      insert: insertHtml,
      diagramTarget: () => {
        const root = surfaceRef.current;
        if (!root) return null;
        const block = findDiagramBlock(window.getSelection()?.anchorNode ?? null);
        if (!block || !root.contains(block.pre)) return null;
        return {
          spec: block.spec,
          replace: (html: string) => {
            const template = document.createElement('template');
            template.innerHTML = html;
            const node = template.content.firstElementChild;
            if (!node) return;
            block.pre.replaceWith(node);
            decorateEditorDiagrams(root);
            emit();
          },
        };
      },
      undo: () => run('undo'),
      redo: () => run('redo'),
      clear: () => run('removeFormat'),
    }),
    [disabled, emit, focusSurface, insertHtml, restoreSelection, run, saveSelection],
  );

  /* ------------------------- Markdown 输入增强 ------------------------- */

  /** `holdMs = 0` 表示不自动消失（上传进度用），下一次提示或完成时再收掉。 */
  const flashHint = (message: string, holdMs = 1800) => {
    setHint(message);
    if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    hintTimer.current = null;
    if (holdMs <= 0) return;
    hintTimer.current = window.setTimeout(() => {
      hintTimer.current = null;
      setHint('');
    }, holdMs);
  };

  /**
   * 粘贴 / 拖拽图片：走现有两阶段上传（创建会话 → 传字节 → 完成），
   * 成功后插到正文里；失败把原因留在编辑区下方，而不是只闪一下。
   */
  const uploadImages = async (files: File[], range: Range | null) => {
    if (!files.length || disabled) return;
    if (uploading.current) {
      flashHint(t('正在上传图片，请稍候…'), 1800);
      return;
    }
    uploading.current = true;
    setUploadError('');
    const snippets: string[] = [];
    const failures: string[] = [];
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        try {
          const asset = await backend.upload(file, 'content', (percent) => {
            const overall = Math.round(((index + percent / 100) / files.length) * 100);
            flashHint(t('正在上传图片… {percent}%', { percent: overall }), 0);
          });
          if (!asset.url) throw new Error(t('上传结果里没有可用的图片地址。'));
          snippets.push(imageBlock({ src: asset.url, alt: escapeHtml(file.name) }));
          flashHint(
            t('正在上传图片… {percent}%', {
              percent: Math.round(((index + 1) / files.length) * 100),
            }),
            0,
          );
        } catch (err) {
          failures.push(
            `${file.name || t('粘贴的图片')}: ${errorText(err) || t('上传失败。')}`,
          );
        }
      }
      if (snippets.length) {
        insertHtmlAtRange(snippets.join(''), range);
        flashHint(
          snippets.length === 1
            ? t('图片已插入正文')
            : t('已插入 {count} 张图片', { count: snippets.length }),
          2400,
        );
      }
      if (failures.length) {
        setUploadError(`${t('图片上传失败')}：${failures.join('；')}`);
        if (!snippets.length) flashHint(t('图片上传失败，请重试。'), 3200);
      }
    } finally {
      uploading.current = false;
    }
  };

  useEffect(
    () => () => {
      if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    },
    [],
  );

  const handleToolbarReady = useCallback((open: (kind: EditorDialogKind) => void) => {
    toolbarOpen.current = open;
  }, []);

  /** execCommand 之后浏览器有时会把光标留在奇怪的位置，下一帧再收回来。 */
  const restoreCaretAfterCommand = (
    where: 'start' | 'end',
    target?: HTMLElement | null,
  ) => {
    requestAnimationFrame(() => {
      const root = surfaceRef.current;
      if (!root) return;
      const block =
        target && target.isConnected
          ? target
          : closestBlock(root, window.getSelection()?.anchorNode ?? null);
      collapseToBlock(block, where);
    });
  };

  /** 删除块首的字面前缀，并把光标收回块首。 */
  const removeBlockPrefix = (block: HTMLElement, length: number) => {
    const start = textPointAt(block, 0);
    const end = textPointAt(block, length);
    if (start && end) {
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      range.deleteContents();
    }
    collapseToBlock(block, 'start');
  };

  /** 行内 Markdown 闭合后的提示词。 */
  const inlineHint: Record<InlineClosureMatch['kind'], string> = {
    bold: t('粗体'),
    italic: t('斜体'),
    code: t('行内代码'),
    strike: t('删除线'),
    link: t('链接'),
  };

  /** 块级 Markdown 前缀的提示词。 */
  const blockHint: Partial<Record<BlockKind, string>> = {
    h2: t('二级标题'),
    h3: t('三级标题'),
    h4: t('四级标题'),
    ul: t('无序列表'),
    ol: t('有序列表'),
    quote: t('引用'),
    code: t('代码块'),
    task: t('任务列表'),
    hr: t('分割线'),
  };

  const convertedHint = (kind: BlockKind) =>
    kind === 'hr'
      ? t('已插入分割线')
      : t('已转成{target}', { target: blockHint[kind] ?? t('富文本') });

  /** 尝试把块级前缀转成富文本；返回是否发生了转换。 */
  const convertBlockPrefix = (block: HTMLElement, before: string): boolean => {
    const match = detectBlockPrefix(before);
    if (!match) return false;

    const tag = block.tagName.toLowerCase();
    const prefixLength = before.length - match.rest.length;

    if (tag === 'li') {
      // 已经在列表项里：不再套娃列表，只处理任务列表的复选框。
      if (match.kind === 'ul' || match.kind === 'ol') {
        removeBlockPrefix(block, prefixLength);
        restoreCaretAfterCommand('end', block);
        flashHint(convertedHint(match.kind));
        return true;
      }
      if (match.kind === 'task') {
        removeBlockPrefix(block, prefixLength);
        document.execCommand('insertText', false, '☐ ');
        restoreCaretAfterCommand('end', block);
        flashHint(t('已转成任务列表'));
        return true;
      }
      return false;
    }

    // 只在普通段落 / 标题里转换；引用、代码块、表格单元格里不嵌套新块。
    if (!/^(p|div|h[1-6])$/.test(tag)) return false;

    // 分割线 / 代码块要求整块内容就是前缀，否则替换会吞掉后面的文字。
    if (
      (match.kind === 'hr' || match.kind === 'code') &&
      (block.textContent ?? '').trim() !== before.trim()
    ) {
      return false;
    }

    removeBlockPrefix(block, prefixLength);

    if (match.kind === 'h2' || match.kind === 'h3' || match.kind === 'h4') {
      document.execCommand('formatBlock', false, `H${match.kind.slice(1)}`);
      restoreCaretAfterCommand('end');
    } else if (match.kind === 'ul' || match.kind === 'ol') {
      document.execCommand(match.kind === 'ul' ? 'insertUnorderedList' : 'insertOrderedList');
      restoreCaretAfterCommand('end');
    } else if (match.kind === 'quote') {
      document.execCommand('formatBlock', false, 'BLOCKQUOTE');
      restoreCaretAfterCommand('end');
    } else if (match.kind === 'task') {
      document.execCommand('insertText', false, '☐ ');
      document.execCommand('insertUnorderedList');
      restoreCaretAfterCommand('end');
    } else if (match.kind === 'code') {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      // 已输入的内容搬进代码块；围栏的语言名不进入正文。
      code.textContent = match.rest;
      pre.appendChild(code);
      block.replaceWith(pre);
      restoreCaretAfterCommand('end', code);
    } else if (match.kind === 'hr') {
      const paragraph = document.createElement('p');
      paragraph.innerHTML = '<br />';
      const divider = document.createElement('hr');
      block.replaceWith(divider);
      divider.after(paragraph);
      restoreCaretAfterCommand('start', paragraph);
    }

    flashHint(convertedHint(match.kind));
    return true;
  };

  /** 尝试把光标前刚输入的 Markdown 转成富文本；返回是否转换过。 */
  const convertMarkdownInput = (): boolean => {
    const root = surfaceRef.current;
    if (!root || disabled) return false;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return false;
    const node = selection.anchorNode;
    if (!node || !root.contains(node)) return false;

    if (node.nodeType === Node.TEXT_NODE) {
      // 空文档里裸文本可能直接挂在根节点下，先包一层段落。
      const block = ensureBlock(root, node);
      if (block) {
        const before = blockTextBeforeCaret(block, node, selection.anchorOffset);
        if (before !== null && convertBlockPrefix(block, before)) return true;
      }
    }

    // 行内闭合：匹配必须完整落在光标所在的文本节点里。
    if (node.nodeType !== Node.TEXT_NODE) return false;
    const textNode = node as Text;
    const inlineMatch = detectInlineClosure(textNode.data.slice(0, selection.anchorOffset));
    if (!inlineMatch) return false;

    const range = document.createRange();
    range.setStart(textNode, selection.anchorOffset - inlineMatch.raw.length);
    range.setEnd(textNode, selection.anchorOffset);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertHTML', false, inlineClosureHtml(inlineMatch));
    flashHint(t('已转成{target}', { target: inlineHint[inlineMatch.kind] }));
    return true;
  };

  /** 空段落里输入 `/` 时更新斜杠面板；不符合条件就关掉。 */
  const updateSlashMenu = useCallback(() => {
    const root = surfaceRef.current;
    if (!root || disabled) {
      setSlash(null);
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
      setSlash(null);
      return;
    }
    const node = selection.anchorNode;
    if (!node || !root.contains(node)) {
      setSlash(null);
      return;
    }
    // 不强求 anchorNode 是文本节点：空段落里光标常常停在元素边界上（`<p><br>` 之间），
    // 硬性要求文本节点会让这种位置的 `/` 永远打不开面板。块首到该边界的文字照样能算前缀。
    const block = closestBlock(root, node);
    const before = block ? blockTextBeforeCaret(block, node, selection.anchorOffset) : null;
    const query = before?.match(/^\/([^\s]*)$/);
    if (!query) {
      setSlash(null);
      return;
    }

    // 这里只给光标锚点，落点交给面板自己算：零尺寸光标会沿降级链退到块矩形，
    // 不会再跳回编辑区左上角；翻屏与夹边也归面板，避免两边各夹一次。
    const anchor = caretAnchor(selection.getRangeAt(0).cloneRange(), block);
    setSlash((prev) =>
      prev && prev.query === query[1] && sameAnchor(prev.anchor, anchor)
        ? prev
        : { query: query[1], anchor },
    );
  }, [disabled]);

  // 光标移动、编辑区内部滚动、窗口缩放都要重算标记与面板位置。
  // 一次输入常常连带触发好几个事件，用 rAF 合并成一帧。
  useEffect(() => {
    let frame = 0;
    const flush = () => {
      frame = 0;
      syncMarker();
      if (slashOpen) updateSlashMenu();
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(flush);
    };
    document.addEventListener('selectionchange', schedule);
    // scroll 不冒泡：只有捕获阶段才收得到编辑区自身的滚动。
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, [slashOpen, syncMarker, updateSlashMenu]);

  // 切成只读后不再有"当前行"，标记留着只会误导。
  useEffect(() => {
    if (disabled) setMarker(null);
  }, [disabled]);

  /** 斜杠面板选中一项：先删掉 `/query`，再执行指令或转交弹窗。 */
  const applySlashItem = (item: SlashItem) => {
    setSlash(null);
    setSlashActiveId(null);
    const root = surfaceRef.current;
    if (!root || disabled) return;

    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && selection.isCollapsed) {
      const node = selection.anchorNode;
      // 和上面一样按块算：光标停在元素边界上时也要能把 `/query` 删掉。
      if (node && root.contains(node)) {
        const block = closestBlock(root, node);
        const before = block ? blockTextBeforeCaret(block, node, selection.anchorOffset) : null;
        if (block && before !== null && /^\/\S*$/.test(before)) {
          removeBlockPrefix(block, before.length);
        }
      }
    }

    if (item.action.type === 'dialog') {
      // 工具栏的 open() 会自己保存选区；外部处理器则自己负责。
      commands.saveSelection();
      if (onRequestDialog) onRequestDialog(item.action.dialog);
      else toolbarOpen.current?.(item.action.dialog);
      return;
    }

    commands.saveSelection();
    switch (item.action.command) {
      case 'h2':
        commands.heading(2);
        flashHint(t('已转成二级标题'));
        break;
      case 'h3':
        commands.heading(3);
        flashHint(t('已转成三级标题'));
        break;
      case 'h4':
        commands.heading(4);
        flashHint(t('已转成四级标题'));
        break;
      case 'ul':
        commands.list('ul');
        flashHint(t('已转成无序列表'));
        break;
      case 'ol':
        commands.list('ol');
        flashHint(t('已转成有序列表'));
        break;
      case 'quote':
        commands.quote();
        flashHint(t('已转成引用'));
        break;
      case 'code':
        commands.codeBlock();
        flashHint(t('已插入代码块'));
        break;
      case 'divider':
        commands.divider();
        flashHint(t('已插入分割线'));
        break;
      case 'note':
        commands.insert(noteBlock('info'));
        flashHint(t('已插入提示框'));
        break;
    }
  };

  const handleInput = () => {
    if (!disabled && !composing.current) {
      const converted = convertMarkdownInput();
      if (converted) setSlash(null);
      else updateSlashMenu();
    }
    emit();
    syncMarker();
  };

  const handleCompositionEnd = () => {
    composing.current = false;
    // 组字结束后的最终文本要到下一帧才稳定，之后再补一次转换。
    requestAnimationFrame(() => {
      if (composing.current || disabled) return;
      const converted = convertMarkdownInput();
      if (converted) setSlash(null);
      else updateSlashMenu();
      emit();
      syncMarker();
    });
  };

  const handlePaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    // 截图 / 复制的图片文件优先：先上传，插入位置就是粘贴当下的光标。
    const images = disabled ? [] : imageFilesFromTransfer(event.clipboardData);
    if (images.length) {
      event.preventDefault();
      const selection = window.getSelection();
      const range =
        selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
      void uploadImages(images, range);
      return;
    }

    event.preventDefault();
    const text = event.clipboardData.getData('text/plain').replace(/\r\n/g, '\n');
    if (!text) return;
    if (looksLikeMarkdown(text)) {
      // 像 Markdown 的整段粘贴直接转成富文本，和手敲的转换结果一致。
      document.execCommand('insertHTML', false, renderMarkdown(text));
    } else {
      // 只在空行处分段：作者从别处粘来的硬折行只是排版换行，逐行塞 <br /> 会把
      // 一段存成 N 段，公开页于是多出一堆段间距。
      const blocks = text
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\s*\n+\s*/g, ' ')}</p>`)
        .join('');
      document.execCommand('insertHTML', false, blocks);
    }
    emit();
  };

  /** 拖入图片：按落点插到正文里；非图片文件给出可读提示，不让浏览器把文件当文本丢进来。 */
  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (disabled) return;
    const images = imageFilesFromTransfer(event.dataTransfer);
    if (!images.length) {
      if (event.dataTransfer?.files?.length) {
        setUploadError(t('只能上传 PNG / JPEG / WebP / GIF 图片。'));
      }
      return;
    }
    const range = rangeAtPoint(event.clientX, event.clientY);
    void uploadImages(images, range);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;

    // 写作快捷键：与常见编辑器一致；Ctrl/Cmd+S 与 Ctrl/Cmd+Enter 交给外层页面处理。
    if (!event.nativeEvent.isComposing && (event.metaKey || event.ctrlKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      if (!event.shiftKey) {
        if (key === 'b') {
          event.preventDefault();
          commands.bold();
          return;
        }
        if (key === 'i') {
          event.preventDefault();
          commands.italic();
          return;
        }
        if (key === 'k') {
          event.preventDefault();
          toolbarOpen.current?.('link');
          return;
        }
      }
      if (event.shiftKey) {
        if (key === '7') {
          event.preventDefault();
          commands.list('ol');
          return;
        }
        if (key === '8') {
          event.preventDefault();
          commands.list('ul');
          return;
        }
        if (key === '9') {
          event.preventDefault();
          commands.quote();
          return;
        }
      }
    }
    if (!event.nativeEvent.isComposing && (event.metaKey || event.ctrlKey) && event.altKey) {
      // Ctrl/Cmd+Alt+1/2/3 切换标题级别，与常见 Markdown 编辑器一致（正文标题从 h2 起）。
      if (event.key === '1' || event.key === '2' || event.key === '3') {
        event.preventDefault();
        const level = (Number(event.key) + 1) as 2 | 3 | 4;
        commands.heading(level);
        return;
      }
    }

    const card = target.closest?.('a.pp-video, a.pp-embed, a.pp-linkcard');
    if (event.key === 'Enter' && !event.shiftKey && card) {
      // 在卡片里回车不应该把卡片劈成两半：跳出去另起一段。
      event.preventDefault();
      const paragraph = document.createElement('p');
      paragraph.innerHTML = '<br />';
      card.after(paragraph);
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      emit();
      return;
    }

    if (event.key === 'Tab') {
      const cell = target.closest?.('td,th');
      if (!cell) return;
      event.preventDefault();
      const cells = Array.from(
        cell.closest('table')?.querySelectorAll('td,th') ?? [],
      );
      const index = cells.indexOf(cell as HTMLTableCellElement);
      const next = cells[index + (event.shiftKey ? -1 : 1)] as HTMLElement | undefined;
      if (!next) return;
      const range = document.createRange();
      range.selectNodeContents(next);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  };

  /** 点击正文里的图表预览：把光标放进该图表块，再复用工具栏的「编辑图表」弹窗。 */
  const handleSurfaceClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    // 点击也会移动光标（块级元素上点击不一定触发 selectionchange），顺手同步一次。
    syncMarker();
    // 编辑时点击链接不应该跳走。
    if (target.closest('a')) event.preventDefault();
    const edit = target.closest<HTMLElement>('[data-pp-diagram-edit]');
    if (!edit) return;
    event.preventDefault();
    const pre = edit.closest('pre');
    if (!pre) return;
    const range = document.createRange();
    range.selectNodeContents(pre);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    saveSelection();
    toolbarOpen.current?.('diagram');
  };

  return (
    <div className={`rich-editor${disabled ? ' is-readonly' : ''}`}>
      <EditorToolbar commands={commands} disabled={disabled} onReady={handleToolbarReady} />

      <div className="rich-surface-shell" ref={shellRef}>
        <div
          ref={surfaceRef}
          className="article-body rich-surface"
          contentEditable={!disabled}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={t('正文')}
          aria-activedescendant={slash ? (slashActiveId ?? undefined) : undefined}
          aria-controls={slash ? 'pp-slash-menu' : undefined}
          data-placeholder={placeholderText}
          data-empty="true"
          spellCheck={false}
          onInput={handleInput}
          onBlur={() => {
            emit();
            // 光标离开正文就没有"当前行"了，标记跟着收起。
            setMarker(null);
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={syncMarker}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={handleCompositionEnd}
          onClick={handleSurfaceClick}
          onPaste={handlePaste}
          onDragOver={(event) => {
            // 不拦截 dragover 的话，部分浏览器不会把文件拖放交给编辑器。
            if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
          }}
          onDrop={handleDrop}
        />
        {marker ? (
          // 与编辑区同级而不是放在里面：标记一旦进了 contenteditable 子树，
          // 存盘的 Markdown、字数统计、复制粘贴都会带上它。
          <span
            ref={markerRef}
            className="pp-line-marker"
            data-pp-marker="1"
            aria-hidden="true"
            style={{
              top: marker.top,
              height: marker.height,
              left: marker.left,
              visibility: markerClipped ? 'hidden' : 'visible',
            }}
          >
            {marker.text}
          </span>
        ) : null}
      </div>
      <SlashMenu
        open={slashOpen}
        query={slash?.query ?? ''}
        anchor={slash?.anchor ?? null}
        onSelect={applySlashItem}
        onClose={() => setSlash(null)}
        onActiveItemChange={setSlashActiveId}
      />
      {hint
        ? // 提示条同样是 position: fixed，而内容区的 transform 动画会让它改以内容区为
          // 包含块（于是偏到右边去）。挂到 body 下才是真正的屏幕底部居中。
          createPortal(
            <p className="mdhint" role="status" aria-live="polite">
              {hint}
            </p>,
            document.body,
          )
        : null}
      {uploadError ? (
        <p className="rich-editor-note" role="alert" style={{ color: 'var(--danger, #b4322b)' }}>
          {uploadError}
        </p>
      ) : null}
      {disabled ? (
        <p className="rich-editor-note">{t('只读：当前状态不允许修改正文。')}</p>
      ) : (
        <p className="rich-editor-note">
          {t('所见即所得编辑；保存时序列化为 Markdown，公开页由服务端渲染并清洗。')}
          {' '}
          {t('也可以直接粘贴或拖入图片，上传后插入正文。')}
        </p>
      )}
    </div>
  );
}
