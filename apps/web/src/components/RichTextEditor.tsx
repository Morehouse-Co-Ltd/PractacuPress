import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ClipboardEvent as ReactClipboardEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { escapeHtml, renderMarkdown } from '../lib/markdown';
import { htmlToMarkdown } from '../lib/htmlToMarkdown';
import {
  detectBlockPrefix,
  detectInlineClosure,
  looksLikeMarkdown,
} from '../lib/markdownInput';
import type { BlockKind, InlineClosureMatch } from '../lib/markdownInput';
import { noteBlock } from '../lib/richBlocks';
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
export type EditorDialogKind = 'image' | 'table' | 'columns' | 'formula' | 'link' | 'video';

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
  const paragraph = document.createElement('p');
  root.insertBefore(paragraph, child);
  paragraph.appendChild(child);
  return paragraph;
}

/** 块首到 (node, offset) 之间的文本，用于识别块级前缀。 */
function blockTextBeforeCaret(block: HTMLElement, node: Node, offset: number): string | null {
  if (!block.contains(node)) return null;
  const range = document.createRange();
  range.setStart(block, 0);
  range.setEnd(node, offset);
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
  const placeholderText =
    placeholder ?? t('从这里开始写。选中文字可以加粗、加链接，工具栏能插入图片、表格与分栏。');
  const surfaceRef = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);
  const emitted = useRef('');
  // IME 组字期间不做 Markdown 转换：中文输入法会临时产生不符合语法的中间文本。
  const composing = useRef(false);
  // 工具栏把自己的 open(kind) 注册进来，斜杠面板才能复用现有弹窗。
  const toolbarOpen = useRef<((kind: EditorDialogKind) => void) | null>(null);
  const hintTimer = useRef<number | null>(null);
  const [hint, setHint] = useState('');
  const [slash, setSlash] = useState<{
    query: string;
    position: { left: number; top: number };
  } | null>(null);
  const [slashActiveId, setSlashActiveId] = useState<string | null>(null);

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
    emitted.current = markdown;
    onChange(markdown, { text: text.length });
  }, [onChange]);

  // 切换稿件或导入：整体替换编辑区内容。
  useEffect(() => {
    const root = surfaceRef.current;
    if (!root) return;
    root.innerHTML = initialHtml;
    emitted.current = '';
    // 让浏览器按内容重新计算空状态。
    const text = (root.innerText ?? '').replace(/\s+/g, '');
    const isEmpty = text.length === 0 && !root.querySelector('img,table,a.pp-video,a.pp-embed,a.pp-linkcard,hr,[data-pp-math]');
    root.dataset.empty = isEmpty ? 'true' : 'false';
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
      undo: () => run('undo'),
      redo: () => run('redo'),
      clear: () => run('removeFormat'),
    }),
    [disabled, emit, focusSurface, insertHtml, restoreSelection, run, saveSelection],
  );

  /* ------------------------- Markdown 输入增强 ------------------------- */

  const flashHint = (message: string) => {
    setHint(message);
    if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => {
      hintTimer.current = null;
      setHint('');
    }, 1800);
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
  const updateSlashMenu = () => {
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
    if (!node || !root.contains(node) || node.nodeType !== Node.TEXT_NODE) {
      setSlash(null);
      return;
    }
    const block = closestBlock(root, node);
    const before = block ? blockTextBeforeCaret(block, node, selection.anchorOffset) : null;
    const query = before?.match(/^\/([^\s]*)$/);
    if (!query) {
      setSlash(null);
      return;
    }

    const range = selection.getRangeAt(0).cloneRange();
    let rect = range.getBoundingClientRect();
    if (!rect.left && !rect.top && !rect.bottom) rect = root.getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 292));
    const top = Math.min(Math.max(8, rect.bottom + 6), Math.max(8, window.innerHeight - 360));
    setSlash({ query: query[1], position: { left, top } });
  };

  /** 斜杠面板选中一项：先删掉 `/query`，再执行指令或转交弹窗。 */
  const applySlashItem = (item: SlashItem) => {
    setSlash(null);
    setSlashActiveId(null);
    const root = surfaceRef.current;
    if (!root || disabled) return;

    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && selection.isCollapsed) {
      const node = selection.anchorNode;
      if (node && root.contains(node) && node.nodeType === Node.TEXT_NODE) {
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
    });
  };

  const handlePaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain').replace(/\r\n/g, '\n');
    if (!text) return;
    if (looksLikeMarkdown(text)) {
      // 像 Markdown 的整段粘贴直接转成富文本，和手敲的转换结果一致。
      document.execCommand('insertHTML', false, renderMarkdown(text));
    } else {
      const blocks = text
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br />')}</p>`)
        .join('');
      document.execCommand('insertHTML', false, blocks);
    }
    emit();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
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

  return (
    <div className={`rich-editor${disabled ? ' is-readonly' : ''}`}>
      <EditorToolbar commands={commands} disabled={disabled} onReady={handleToolbarReady} />

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
        onBlur={emit}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={handleCompositionEnd}
        onClick={(event) => {
          // 编辑时点击链接不应该跳走。
          if ((event.target as HTMLElement).closest('a')) event.preventDefault();
        }}
        onPaste={handlePaste}
        onDrop={(event) => event.preventDefault()}
      />
      <SlashMenu
        open={!!slash}
        query={slash?.query ?? ''}
        position={slash?.position ?? null}
        onSelect={applySlashItem}
        onClose={() => setSlash(null)}
        onActiveItemChange={setSlashActiveId}
      />
      {hint ? (
        <p className="mdhint" role="status" aria-live="polite">
          {hint}
        </p>
      ) : null}
      {disabled ? (
        <p className="rich-editor-note">{t('只读：当前状态不允许修改正文。')}</p>
      ) : (
        <p className="rich-editor-note">
          {t('所见即所得编辑；保存时序列化为 Markdown，公开页由服务端渲染并清洗。')}
        </p>
      )}
    </div>
  );
}
