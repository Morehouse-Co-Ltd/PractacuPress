import type { SourceFormat } from '../types';

/**
 * 演示数据与编辑器预览使用的渲染器。
 *
 * 真实内容一律以服务端返回的 `rendered_html` 为准；服务端会先用 goldmark 把
 * Markdown 转成 HTML，再交给安全服务按白名单清洗。这里的实现保持同一套语法与
 * 同一批类名，目的是让「写作 → 预览 → 发布」三处看起来一致。
 *
 * 所有作者输入先转义再拼装；原文里的 HTML 区块会经过 sanitizeHtml 过滤。
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function unescapeHtml(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function normalizeFormulaSource(input: string): string {
  return input.replace(/\r\n/g, '\n').trim();
}

function formulaAttribute(source: string): string {
  return escapeHtml(normalizeFormulaSource(source));
}

export function inlineFormula(source: string): string {
  const value = normalizeFormulaSource(source);
  return `<span class="pp-math-inline" data-pp-math="${formulaAttribute(value)}">${escapeHtml(value)}</span>`;
}

export function blockFormula(source: string): string {
  const value = normalizeFormulaSource(source);
  return `<p class="pp-math-block" data-pp-math="${formulaAttribute(value)}">${escapeHtml(value)}</p>`;
}

/** 代码片段与公式先占位，避免其中的星号、下划线被当成强调语法。 */
function inline(text: string): string {
  const codes: string[] = [];
  let source = text.replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  const formulas: string[] = [];
  // Avoid treating the inner dollar signs of $$...$$ as an inline formula.
  source = source.replace(
    /(^|[^$])\$([^$\n]+)\$(?!\$)/g,
    (_, prefix: string, formula: string) => {
      formulas.push(inlineFormula(formula));
      return `${prefix}\u0001${formulas.length - 1}\u0001`;
    },
  );

  let s = escapeHtml(source);

  // 图片先于链接：![]() 的后半段和 []() 完全一样。
  s = s.replace(
    /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
    '<img src="$2" alt="$1" loading="lazy" />',
  );
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
  );
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s（(])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  s = s.replace(/\u0000(\d+)\u0000/g, (_, index: string) => `<code>${escapeHtml(codes[Number(index)])}</code>`);
  s = s.replace(/\u0001(\d+)\u0001/g, (_, index: string) => formulas[Number(index)]);
  return s;
}

/** GFM 表格的分隔行：|---|:---:|---:| */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('-')) return false;
  if (!/^\|?[\s:|-]+\|?$/.test(trimmed)) return false;
  return trimmed.split('|').filter((cell) => cell.trim()).every((cell) => /^:?-{2,}:?$/.test(cell.trim()));
}

function splitRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

function alignClass(cell: string): string {
  const trimmed = cell.trim();
  if (/^:-+:$/.test(trimmed)) return ' class="pp-align-center"';
  if (/^-+:$/.test(trimmed)) return ' class="pp-align-right"';
  return '';
}

/**
 * 一行以 `<` 开头的连续内容按原始 HTML 区块处理。
 *
 * 浏览器里交给 sanitizeHtml 过滤；没有 DOM 的环境（脚本、测试）退化为纯文本，
 * 避免为了预览引入一个 Node 端 DOM 依赖。
 */
function rawHtmlBlock(lines: string[]): string {
  const raw = lines.join('\n');
  if (typeof DOMParser === 'undefined') return `<p>${escapeHtml(raw)}</p>`;
  return sanitizeHtml(raw);
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let quote: string[] = [];
  let inCode = false;
  let codeLines: string[] = [];
  let codeLang = '';
  let htmlLines: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(`</${list}>`);
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    out.push(`<blockquote><p>${inline(quote.join(' '))}</p></blockquote>`);
    quote = [];
  };
  const flushHtml = () => {
    if (!htmlLines.length) return;
    out.push(rawHtmlBlock(htmlLines));
    htmlLines = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
    flushHtml();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.trimEnd();

    if (line.trim().startsWith('```')) {
      if (inCode) {
        out.push(
          `<pre><code${codeLang ? ` class="language-${escapeHtml(codeLang)}"` : ''}>${escapeHtml(
            codeLines.join('\n'),
          )}</code></pre>`,
        );
        inCode = false;
        codeLines = [];
        codeLang = '';
      } else {
        flushAll();
        inCode = true;
        codeLang = line.trim().slice(3).trim();
      }
      continue;
    }
    if (inCode) {
      codeLines.push(raw);
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.startsWith('$$')) {
      if (trimmed.length > 4 && trimmed.endsWith('$$')) {
        const value = trimmed.slice(2, -2);
        if (value.trim()) {
          flushAll();
          out.push(blockFormula(value));
          continue;
        }
      } else if (trimmed === '$$') {
        let close = index + 1;
        while (close < lines.length && lines[close].trim() !== '$$') close += 1;
        if (close < lines.length) {
          const value = lines.slice(index + 1, close).join('\n');
          if (value.trim()) {
            flushAll();
            out.push(blockFormula(value));
            index = close;
            continue;
          }
        }
      }
    }

    // 原始 HTML 区块：直到空行为止，整段交给白名单过滤。
    if (line.trimStart().startsWith('<')) {
      flushParagraph();
      flushList();
      flushQuote();
      htmlLines.push(raw);
      continue;
    }
    flushHtml();

    if (!line.trim()) {
      flushAll();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushAll();
      out.push('<hr />');
      continue;
    }

    // 表格：当前行有分隔符，且下一行是 |---|---| 形式。
    if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      flushAll();
      const header = splitRow(line);
      const alignments = splitRow(lines[index + 1]);
      const body: string[][] = [];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].includes('|') && lines[cursor].trim()) {
        body.push(splitRow(lines[cursor]));
        cursor += 1;
      }
      index = cursor - 1;

      const head = header
        .map((cell, cellIndex) => `<th${alignClass(alignments[cellIndex] ?? '')}>${inline(cell)}</th>`)
        .join('');
      const rows = body
        .map(
          (row) =>
            `<tr>${header
              .map(
                (_, cellIndex) =>
                  `<td${alignClass(alignments[cellIndex] ?? '')}>${inline(row[cellIndex] ?? '')}</td>`,
              )
              .join('')}</tr>`,
        )
        .join('');
      out.push(
        `<table class="pp-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`,
      );
      continue;
    }

    const quoteLine = line.match(/^>\s?(.*)$/);
    if (quoteLine) {
      flushParagraph();
      flushList();
      quote.push(quoteLine[1]);
      continue;
    }
    flushQuote();

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      flushParagraph();
      const wanted: 'ul' | 'ol' = ul ? 'ul' : 'ol';
      if (list !== wanted) {
        flushList();
        out.push(`<${wanted}>`);
        list = wanted;
      }
      const body = (ul ?? ol)![1];
      const task = body.match(/^\[( |x|X)\]\s+(.*)$/);
      if (task) {
        // 复选框用字符表示：真实渲染同样不能用 input（白名单里没有表单元素）。
        out.push(`<li>${task[1].toLowerCase() === 'x' ? '☑' : '☐'} ${inline(task[2])}</li>`);
      } else {
        out.push(`<li>${inline(body)}</li>`);
      }
      continue;
    }
    flushList();

    paragraph.push(line.trim());
  }

  if (inCode) {
    out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  }
  flushAll();
  return out.join('\n');
}

/**
 * URL 解析器会丢掉的字符：C0 控制符、制表符/换行、DEL 与各类 Unicode 空白。
 *
 * DOMParser 已经把实体解码了，`java&#9;script:` 到这一步是 `java<TAB>script:`；
 * 浏览器在解析协议之前同样会丢掉制表符与换行，所以必须先把这些字符删掉再判断，
 * 否则只要在 `java` 与 `script:` 之间塞一个制表符就能绕过协议检查。
 */
const URL_STRIP_CHARS = /[\u0000-\u001f\u007f\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/g;

/** 内联图片数据只收 base64 的栅格图；`data:image/svg+xml` 可以内嵌脚本，一律拒绝。 */
const DATA_IMAGE_URL = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=]+$/;

interface UrlRule {
  /** 允许 mailto: / tel:（只给链接类属性）。 */
  mail: boolean;
  /** 允许 `data:image/...;base64,`（只给图片类属性）。 */
  dataImage: boolean;
}

/** 需要按 URL 白名单校验的属性；不在表里的属性不当作 URL 处理。 */
const URL_ATTRIBUTES: Record<string, UrlRule> = {
  href: { mail: true, dataImage: false },
  'xlink:href': { mail: true, dataImage: false },
  cite: { mail: true, dataImage: false },
  action: { mail: true, dataImage: false },
  formaction: { mail: true, dataImage: false },
  src: { mail: false, dataImage: true },
  poster: { mail: false, dataImage: true },
  srcset: { mail: false, dataImage: true },
  background: { mail: false, dataImage: false },
  data: { mail: false, dataImage: false },
};

/**
 * 值里还残留 `&#9;` / `&colon;` 这类字符引用时直接拒绝。
 *
 * 正常解析下 DOMParser 已经把实体解码了；走到这一步还留着实体写法，说明被转义了
 * 不止一层，下游任何一次再解码都可能把它变成 `javascript:`。带分号才拦命名实体，
 * 免得误伤 `?a=1&tab=2` 这种查询串。
 */
const URL_ENTITY_LEFTOVER = /&(?:#\d{1,8}|#[xX][0-9a-fA-F]{1,8};?|(?:colon|tab|newline|sol|bsol|nbsp);)/i;

/** 删掉会被 URL 解析器吞掉的字符，并去掉首尾空白。 */
function normalizeUrl(value: string): string {
  return value.replace(URL_STRIP_CHARS, '').trim();
}

/**
 * 规范化之后的白名单判断：只放行 http(s)、链接类的 mailto/tel、图片类的
 * base64 数据图、`#` 片段与站内相对路径。
 */
function isAllowedUrl(value: string, rule: UrlRule): boolean {
  // 空白不参与判断：浏览器不会因为中间多一个空格就改变协议。
  const target = value.replace(/\s+/g, '');
  if (!target) return true;
  if (target.startsWith('#')) return true;
  if (URL_ENTITY_LEFTOVER.test(target)) return false;
  // 反斜杠在 URL 里等价于斜杠：`\\evil.example` 与 `//evil.example` 一样是跨站地址。
  if (target.includes('\\')) return false;
  // 协议相对地址（`//evil.example/a.png`）会跳到站外，站内内容不需要它。
  if (target.startsWith('//')) return false;

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name === 'http' || name === 'https') return true;
    if (rule.mail && (name === 'mailto' || name === 'tel')) return true;
    if (name === 'data') return rule.dataImage && DATA_IMAGE_URL.test(target.toLowerCase());
    return false;
  }

  // 没有协议：相对地址。首段带冒号会被解析成未知协议（`1javascriptx:...`），一并拒绝。
  // 只看 `#` 之前的部分：片段里的冒号与协议无关。
  const head = (target.split('#')[0] ?? '').split(/[/?]/)[0] ?? '';
  if (head.includes(':')) return false;
  // `..` 段会离开当前站点路径，预览与发布都不需要。
  if (/(^|\/)\.\.(\/|$)/.test(target)) return false;
  return true;
}

/**
 * 按 HTML 规范里 srcset 的切法取出候选 URL：URL 是一段非空白字符，
 * 末尾的逗号表示候选到此结束，否则后面跟的是 `1x` / `640w` 描述符。
 * 这样 `data:image/png;base64,AAA` 中间的逗号不会被当成分隔符。
 */
function srcsetUrls(value: string): string[] {
  const urls: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index])) index += 1;
    if (index >= value.length) break;
    const start = index;
    while (index < value.length && !/\s/.test(value[index])) index += 1;
    const url = value.slice(start, index);
    if (url.endsWith(',')) {
      urls.push(url.replace(/,+$/, ''));
      continue;
    }
    urls.push(url);
    while (index < value.length && value[index] !== ',') index += 1;
    index += 1;
  }
  return urls;
}

/**
 * URL 属性的白名单校验。
 *
 * 返回要写回属性的值；返回 null 表示整个属性必须删掉；非 URL 属性原样返回。
 * 返回的是规范化之后的值，保证「校验过的字符串」与「序列化出去的字符串」一致。
 */
export function safeUrlAttribute(name: string, value: string): string | null {
  const rule = URL_ATTRIBUTES[name];
  if (!rule) return value;
  const normalized = normalizeUrl(value);
  if (name === 'srcset') {
    const candidates = srcsetUrls(normalized);
    // 混入一个坏候选项就整条丢弃：srcset 是资源列表，宁可退回到 src。
    if (!candidates.length) return null;
    if (!candidates.every((url) => isAllowedUrl(url, rule))) return null;
    return normalized.replace(/\s+/g, ' ');
  }
  return isAllowedUrl(normalized, rule) ? normalized : null;
}

/**
 * 白名单清洗：只保留无需脚本就能安全展示的标签与属性。
 *
 * - 事件处理器（`on*`）、`srcdoc`、内联 `style` 一律删掉；
 * - URL 属性（href/src/xlink:href/poster/background/cite/action/formaction/data/srcset）
 *   走 {@link safeUrlAttribute} 的协议白名单，校验前先做规范化；
 * - `<template>` 的内容不在文档树里，`querySelectorAll` 遍历不到，直接整块删掉；
 *   同理删掉 SVG 的 SMIL 动画元素，它们可以在运行时改写 href；
 * - 公式节点只保留纯文本，最后再对 `data-pp-math` 做一次转义。
 */
export function sanitizeHtml(input: string): string {
  if (typeof DOMParser === 'undefined') return escapeHtml(input);

  const doc = new DOMParser().parseFromString(input, 'text/html');
  doc
    .querySelectorAll(
      'script,style,iframe,object,embed,form,link,meta,base,video,audio,source,template,animate,set',
    )
    .forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'style') {
        el.removeAttribute(attr.name);
        continue;
      }
      const safe = safeUrlAttribute(name, attr.value);
      if (safe === null) el.removeAttribute(attr.name);
      else if (safe !== attr.value) el.setAttribute(attr.name, safe);
    }

    const tag = el.tagName.toLowerCase();
    const isInlineFormula = tag === 'span' && el.classList.contains('pp-math-inline');
    const isBlockFormula = tag === 'p' && el.classList.contains('pp-math-block');
    if (isInlineFormula || isBlockFormula) {
      const rawSource = el.getAttribute('data-pp-math') ?? el.textContent ?? '';
      const value = normalizeFormulaSource(unescapeHtml(rawSource));
      // Formula nodes contain text only; this also removes any nested markup.
      el.textContent = value;
      if (value) el.setAttribute('data-pp-math', value);
      else el.removeAttribute('data-pp-math');
    } else {
      el.removeAttribute('data-pp-math');
    }
  });
  return doc.body.innerHTML.replace(/data-pp-math="([^"]*)"/g, (_, value: string) => {
    return `data-pp-math="${escapeHtml(unescapeHtml(value))}"`;
  });
}

export function renderPlain(source: string): string {
  return source
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br />')}</p>`)
    .join('\n');
}

export function renderSource(format: SourceFormat, source: string): string {
  switch (format) {
    case 'html':
      return sanitizeHtml(source);
    case 'plain':
      return renderPlain(source);
    default:
      return renderMarkdown(source);
  }
}

/** 从渲染结果里取第一张图，作为分享卡片与 SEO 的默认封面。 */
export function firstImage(html: string): string {
  const match = html.match(/<img[^>]+src="([^"]+)"/i);
  return match ? unescapeHtml(match[1]) : '';
}

/** 去掉标签后的纯文本，用于自动摘要与字数统计。 */
export function htmlToText(html: string): string {
  return unescapeHtml(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
