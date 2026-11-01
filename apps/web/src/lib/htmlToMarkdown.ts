/**
 * HTML → Markdown 序列化。
 *
 * 编辑器是所见即所得的：作者看到的是排版后的 HTML，但存盘、导出、导入都走 Markdown。
 * 这里把编辑区的 DOM 还原成 Markdown：
 *
 * - 常规结构（标题、段落、列表、引用、代码块、图片、链接、表格）写成 Markdown 语法；
 * - 分栏、图集、视频卡片、嵌入卡片、提示框、图标这类「富文本区块」没有对应的 Markdown
 *   语法，原样写成一段 HTML。服务端用 goldmark（WithUnsafe）渲染 Markdown，再按白名单
 *   清洗，所以这些 HTML 区块能被原样保留下来。
 *
 * 顺序很重要：先判断片段整体是否是某个富文本区块（按 class 匹配），否则它的内部文本会被
 * 拆成普通段落，块就没了。
 */

const BLOCK_SELECTOR = [
  'a.pp-video',
  'a.pp-embed',
  'a.pp-linkcard',
  'p.pp-image',
  'p.pp-icon-line',
  'blockquote.pp-note',
  'table.pp-columns',
  'table.pp-gallery',
  'table.pp-table',
].join(',');

const INLINE_ESCAPE = /[\\`*_[\]<>]/g;

function escapeText(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(INLINE_ESCAPE, '\\$&');
}

function formulaSource(element: Element): string {
  return (element.getAttribute('data-pp-math') ?? element.textContent ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
}

function blockFormulaMarkdown(source: string): string {
  if (!source) return '';
  return source.includes('\n') ? `$$\n${source}\n$$` : `$$${source}$$`;
}

function inlineChildren(element: Element): string {
  let out = '';
  element.childNodes.forEach((node) => {
    out += inlineNode(node);
  });
  return out;
}

function inlineNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? '');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const element = node as HTMLElement;
  if (element.matches('.pp-math-inline')) {
    const source = formulaSource(element);
    return source ? `$${source}$` : '';
  }
  if (element.matches(BLOCK_SELECTOR)) return cleanBlockHtml(element);
  const tag = element.tagName.toLowerCase();

  switch (tag) {
    case 'strong':
    case 'b': {
      const inner = inlineChildren(element);
      return inner.trim() ? `**${inner}**` : '';
    }
    case 'em':
    case 'i': {
      const inner = inlineChildren(element);
      return inner.trim() ? `*${inner}*` : '';
    }
    case 'del':
    case 's': {
      const inner = inlineChildren(element);
      return inner.trim() ? `~~${inner}~~` : '';
    }
    case 'code': {
      const text = (element.textContent ?? '').replace(/\u00a0/g, ' ');
      return text ? `\`${text}\`` : '';
    }
    case 'br':
      // 段内换行按段落处理：Markdown 没有可靠的软换行，宁可分成两段也不丢内容。
      return '\n\n';
    case 'a': {
      const href = element.getAttribute('href') ?? '';
      const text = inlineChildren(element).trim();
      if (!href) return text;
      return `[${text || href}](${href})`;
    }
    case 'img': {
      const src = element.getAttribute('src') ?? '';
      if (!src) return '';
      return `![${escapeText(element.getAttribute('alt') ?? '')}](${src})`;
    }
    case 'div':
    case 'section':
    case 'article':
      // 浏览器有时会包一层；这里当透明容器处理，段落分隔由调用方决定。
      return inlineChildren(element);
    default:
      return inlineChildren(element);
  }
}

/** 去掉编辑器专用属性，保证存下来的 HTML 干净、可重复序列化。 */
function cleanBlockHtml(element: Element): string {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.removeAttribute('contenteditable');
  clone.removeAttribute('data-pp-block');
  const all = [clone, ...Array.from(clone.querySelectorAll('*'))];
  for (const node of all) {
    node.removeAttribute('contenteditable');
    node.removeAttribute('style');
    node.removeAttribute('data-pp-block');
    node.removeAttribute('data-empty');
    node.removeAttribute('data-pp-math');
  }
  return clone.outerHTML.replace(/>\s+</g, '><').trim();
}

function listOf(element: Element, depth: number): string {
  const ordered = element.tagName.toLowerCase() === 'ol';
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  let index = 1;

  for (const child of Array.from(element.children)) {
    if (child.tagName.toLowerCase() !== 'li') continue;
    const nested = Array.from(child.children).filter((node) =>
      ['ul', 'ol'].includes(node.tagName.toLowerCase()),
    );
    // 去掉嵌套列表后再取本行文本，否则子项会混进来。
    const clone = child.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('ul,ol').forEach((node) => node.remove());
    const text = inlineChildren(clone).trim().replace(/\n+/g, ' ');
    const marker = ordered ? `${index}. ` : '- ';
    const task = text.match(/^([☑☐])\s*(.*)$/);
    const body = task ? `[${task[1] === '☑' ? 'x' : ' '}] ${task[2]}` : text;
    lines.push(`${indent}${marker}${body}`);
    index += 1;
    for (const sub of nested) lines.push(listOf(sub, depth + 1));
  }
  return lines.join('\n');
}

/** 只有规整的表格才写成管道语法；有合并单元格就退回 HTML。 */
function pipeTable(element: Element): string | null {
  if (element.querySelector('[colspan],[rowspan]')) return null;
  const rows = Array.from(element.querySelectorAll('tr')).map((row) =>
    Array.from(row.children).map((cell) =>
      inlineChildren(cell)
        .trim()
        .replace(/\n+/g, ' ')
        .replace(/\|/g, '\\|'),
    ),
  );
  if (!rows.length) return null;
  const width = rows[0].length;
  if (width === 0 || rows.some((row) => row.length !== width)) return null;

  const [head, ...body] = rows;
  const separator = head.map(() => '---');
  return [
    `| ${head.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function codeFence(element: Element): string {
  const code = element.querySelector('code');
  const language = (code?.className ?? '').match(/language-([\w-]+)/)?.[1] ?? '';
  const text = (code?.textContent ?? element.textContent ?? '').replace(/\n+$/, '');
  return ['```' + language, text, '```'].join('\n');
}

function blockNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = escapeText(node.textContent ?? '').trim();
    return text ? text : '';
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const element = node as HTMLElement;
  if (element.matches('.pp-math-block')) {
    return blockFormulaMarkdown(formulaSource(element));
  }
  if (element.matches(BLOCK_SELECTOR)) return cleanBlockHtml(element);

  const tag = element.tagName.toLowerCase();

  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    const text = inlineChildren(element).trim().replace(/\n+/g, ' ');
    return text ? `${'#'.repeat(level)} ${text}` : '';
  }

  switch (tag) {
    case 'p': {
      const text = inlineChildren(element).trim();
      if (!text) return '';
      // 段内换行被序列化成 \n\n，这里还原成多个段落，避免出现四个换行。
      return text
        .split(/\n{2,}/)
        .map((part) => part.trim())
        .filter(Boolean)
        .join('\n\n');
    }
    case 'ul':
    case 'ol':
      return listOf(element, 0);
    case 'blockquote': {
      const body = serializeChildren(element);
      if (!body) return '';
      return body
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
    }
    case 'pre':
      return codeFence(element);
    case 'hr':
      return '---';
    case 'table': {
      const pipe = pipeTable(element);
      return pipe ?? cleanBlockHtml(element);
    }
    case 'img': {
      const src = element.getAttribute('src') ?? '';
      return src ? `![${escapeText(element.getAttribute('alt') ?? '')}](${src})` : '';
    }
    case 'div':
    case 'section':
    case 'article':
      return serializeChildren(element);
    case 'br':
      return '';
    default: {
      const text = inlineNode(element).trim();
      return text;
    }
  }
}

function serializeChildren(parent: Element): string {
  const blocks: string[] = [];
  parent.childNodes.forEach((child) => {
    const chunk = blockNode(child);
    if (chunk) blocks.push(chunk);
  });
  return blocks.join('\n\n');
}

/** 把编辑区的一段 HTML 还原成 Markdown。 */
export function htmlToMarkdown(html: string): string {
  if (!html.trim()) return '';
  if (typeof DOMParser === 'undefined') return html;

  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const markdown = serializeChildren(doc.body)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return markdown ? `${markdown}\n` : '';
}
