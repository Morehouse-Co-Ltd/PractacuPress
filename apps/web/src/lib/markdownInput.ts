/**
 * Markdown 输入增强的纯函数层。
 *
 * 编辑器是所见即所得的，但作者常常直接敲 Markdown：`## 标题`、`- 列表`、`**重点**`。
 * 这里只负责「识别」——判断光标前面这段文字是否刚构成某个 Markdown 结构，并返回
 * 该做什么。真正的 DOM 操作留在 `RichTextEditor` 里，这样规则可以脱离浏览器单测。
 *
 * 约定：所有函数都接收「光标之前（不含光标）的文字」，返回 null 表示不处理。
 */

export type BlockKind = 'h2' | 'h3' | 'h4' | 'ul' | 'ol' | 'quote' | 'code' | 'task' | 'hr';

export interface BlockPrefixMatch {
  /** 应该把当前块转成什么。 */
  kind: BlockKind;
  /** 前缀之后剩下的文字（列表项 / 标题文字）；刚敲完前缀时为空串。 */
  rest: string;
}

/** Markdown 标题级别到编辑器标题级别的映射：正文里最深只到四级。 */
const HEADING_KIND: Record<number, BlockKind> = {
  1: 'h2',
  2: 'h3',
  3: 'h4',
  4: 'h4',
};

/**
 * 识别块级前缀。
 *
 * 规则（这样才好单测）：
 * - 前缀必须出现在块的开头（本函数拿到的就是「块首到光标」的文字）；
 * - 标题 / 列表 / 引用 / 任务列表的前缀后面必须紧跟至少一个空格；
 * - 分隔线是「整行只有三个及以上短横线」；代码围栏是「整行只有 ``` 加可选语言名」。
 *
 * `#### ` 也落到四级标题：编辑器正文的标题从二级开始（一级留给页面标题）。
 */
export function detectBlockPrefix(textBeforeCaret: string): BlockPrefixMatch | null {
  if (!textBeforeCaret) return null;

  // 代码围栏：``` 或 ```ts，语言名属于围栏本身，不进入代码内容。
  if (/^```[A-Za-z0-9_+-]*\s*$/.test(textBeforeCaret)) {
    return { kind: 'code', rest: '' };
  }

  // 分隔线：整行只有三个及以上短横线（允许行尾空格）。
  if (/^-{3,}\s*$/.test(textBeforeCaret)) {
    return { kind: 'hr', rest: '' };
  }

  // 任务列表：`[ ] ` / `[] `，也接受 `- [ ] ` 这种更完整的写法。
  const task = textBeforeCaret.match(/^(?:-\s)?\[[ xX]?\]\s+([\s\S]*)$/);
  if (task) return { kind: 'task', rest: task[1] };

  // 标题：# / ## / ### / ####，后面必须跟空格。
  const heading = textBeforeCaret.match(/^(#{1,4})\s+([\s\S]*)$/);
  if (heading) return { kind: HEADING_KIND[heading[1].length], rest: heading[2] };

  // 引用。
  const quote = textBeforeCaret.match(/^>\s+([\s\S]*)$/);
  if (quote) return { kind: 'quote', rest: quote[1] };

  // 无序列表（`- ` / `* `）与有序列表（`1. `）。顺序在标题之后没关系，两者不冲突。
  const unordered = textBeforeCaret.match(/^[-*]\s+([\s\S]*)$/);
  if (unordered) return { kind: 'ul', rest: unordered[1] };
  const ordered = textBeforeCaret.match(/^\d+\.\s+([\s\S]*)$/);
  if (ordered) return { kind: 'ol', rest: ordered[1] };

  return null;
}

export type InlineKind = 'bold' | 'italic' | 'code' | 'strike' | 'link';

export interface InlineClosureMatch {
  kind: InlineKind;
  /** 闭合符号内部的文字（链接就是显示文字）。 */
  inner: string;
  /** 链接地址；只接受 http / https。 */
  href?: string;
  /** 完整匹配到的原文，编辑器据此删除旧文字。 */
  raw: string;
}

/** 取匹配在原字符串里的起始位置，用来检查它前面是否还有同类符号。 */
function matchStart(text: string, raw: string): number {
  return text.length - raw.length;
}

/**
 * 识别「刚刚闭合」的行内语法。
 *
 * 只匹配光标前的最后一段，且要求闭合符号就是光标前的最后字符；因此作者敲完
 * `**粗体**` 的第二个 `*` 时会立刻命中，继续正常输入则不会反复触发。
 * 链接只接受 http / https，其他协议（javascript:、data: 等）一律忽略。
 */
export function detectInlineClosure(textBeforeCaret: string): InlineClosureMatch | null {
  if (!textBeforeCaret) return null;

  // 链接优先：`[文字](https://…)` 的内部可能含有星号、反引号。
  const link = textBeforeCaret.match(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/);
  if (link) return { kind: 'link', inner: link[1], href: link[2], raw: link[0] };

  // 行内代码。
  const code = textBeforeCaret.match(/`([^`\n]+)`$/);
  if (code) {
    const start = matchStart(textBeforeCaret, code[0]);
    // 避免把 ``` 围栏的尾部当成行内代码。
    if (textBeforeCaret[start - 1] !== '`') {
      return { kind: 'code', inner: code[1], raw: code[0] };
    }
  }

  // 删除线。
  const strike = textBeforeCaret.match(/~~([^~\n]+)~~$/);
  if (strike) {
    const start = matchStart(textBeforeCaret, strike[0]);
    if (textBeforeCaret[start - 1] !== '~') {
      return { kind: 'strike', inner: strike[1], raw: strike[0] };
    }
  }

  // 粗体必须在斜体之前判断，否则 **x** 会被当成 *x*。
  const bold = textBeforeCaret.match(/\*\*([^*\n]+)\*\*$/);
  if (bold) {
    const start = matchStart(textBeforeCaret, bold[0]);
    const previous = textBeforeCaret[start - 1];
    if (previous !== '*' && previous !== '\\') {
      return { kind: 'bold', inner: bold[1], raw: bold[0] };
    }
  }

  // 斜体：不能是 ** 的一部分，也不能是转义出来的星号。
  const italic = textBeforeCaret.match(/\*([^*\n]+)\*$/);
  if (italic) {
    const start = matchStart(textBeforeCaret, italic[0]);
    const previous = textBeforeCaret[start - 1];
    if (previous !== '*' && previous !== '\\') {
      return { kind: 'italic', inner: italic[1], raw: italic[0] };
    }
  }

  return null;
}

/**
 * 粘贴内容是否「像 Markdown」。
 *
 * 判断刻意保守：纯文本、普通网址、含单个星号的句子都不算，避免把正常文字
 * 误转成 HTML。命中任意一条强结构（标题 / 围栏 / 表格分隔行 / 列表 / 引用 /
 * 链接 / 成对强调）才按 Markdown 处理。
 */
const MARKDOWN_PASTE_PATTERNS: RegExp[] = [
  /^#{1,6}\s+\S/m, // 标题
  /^```/m, // 代码围栏
  /^\s*>\s+\S/m, // 引用
  /^\s*(?:[-*+]|\d+\.)\s+\S/m, // 列表
  /^\s*\[[ xX]?\]\s+\S/m, // 任务列表
  /^[-*_]{3,}\s*$/m, // 分隔线
  /^\|?\s*:?-{2,}:?\s*\|/m, // 表格分隔行
  /!?\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)/, // 图片 / 链接
  /\*\*[^*\n]+\*\*/, // 粗体
  /~~[^~\n]+~~/, // 删除线
  /`[^`\n]+`/, // 行内代码
  /(^|[\s（(])\*(?:[^*\s][^*\n]*[^*\s]|[^*\s])\*/, // 斜体（内部不留空格的星号对）
];

export function looksLikeMarkdown(text: string): boolean {
  if (!text.trim()) return false;
  return MARKDOWN_PASTE_PATTERNS.some((pattern) => pattern.test(text));
}
