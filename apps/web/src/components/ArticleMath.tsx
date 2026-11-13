import { useEffect } from 'react';
import 'katex/dist/katex.min.css';
import type { KatexOptions } from 'katex';
import './reading.css';

/**
 * 文章正文的本地公式渲染。
 *
 * - 作者端 Markdown 渲染器会输出 `.pp-math-inline` / `.pp-math-block` 占位节点
 *   （带 `data-pp-math` 源文），这里把它们水合成 KaTeX；
 * - 真实后端只做 GFM，`$...$` / `$$...$$` 会留在文本节点里，这里也做一次安全识别。
 *
 * KaTeX 与字体都随构建打包，不走 CDN；`import('katex')` 是动态导入，没有公式的
 * 页面不会下载渲染引擎（FSD A-14）。公式颜色继承正文 `currentColor`，明暗主题
 * 共用一套令牌。
 */

type KatexModule = typeof import('katex');

let katexPromise: Promise<KatexModule> | null = null;

function loadKatex(): Promise<KatexModule> {
  if (!katexPromise) katexPromise = import('katex');
  return katexPromise;
}

/** 看起来像 LaTeX 才把 `$...$` 当公式，避免把价格、普通美元金额误渲染。 */
const FORMULA_HINT = /\\[a-zA-Z]+|[\^_=<>]|\d\s*[+\-*/]\s*\d|[{}\u0370-\u03ff]/;

export function looksLikeFormula(source: string): boolean {
  const value = source.trim();
  if (!value || value.length > 600) return false;
  return FORMULA_HINT.test(value);
}

/** 正文根节点：优先用文章内容区块的标记，旧渲染路径回退到第一个 `.article-body`。 */
export function articleContentRoot(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('[data-pp-article-body]') ??
    document.querySelector<HTMLElement>('.article-body')
  );
}

function katexOptions(displayMode: boolean): KatexOptions {
  return {
    displayMode,
    throwOnError: false,
    strict: 'ignore',
    trust: false,
    output: 'html',
  };
}

function renderFormula(katex: KatexModule, source: string, displayMode: boolean): string | null {
  try {
    return (katex.default ?? katex).renderToString(source, katexOptions(displayMode));
  } catch {
    // 非法 LaTeX 保留原文，不让整篇文章渲染失败。
    return null;
  }
}

function textHasDollar(node: Text): boolean {
  return typeof node.nodeValue === 'string' && node.nodeValue.includes('$');
}

function isSkippedText(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent) return true;
  return !!parent.closest('pre, code, script, style, textarea, svg, .katex, .pp-math-rendered');
}

function mathTextNodes(root: HTMLElement): Text[] {
  if (typeof document.createTreeWalker !== 'function') return [];
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node as Text;
      if (!textHasDollar(text) || isSkippedText(text)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let current = walker.nextNode();
  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }
  return nodes;
}

function placeholderNodes(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-pp-math]')).filter(
    (node) => !node.classList.contains('pp-math-rendered'),
  );
}

function hydratePlaceholders(katex: KatexModule, nodes: HTMLElement[]): void {
  for (const node of nodes) {
    const source = (node.getAttribute('data-pp-math') ?? node.textContent ?? '').trim();
    if (!source) continue;
    const displayMode = node.classList.contains('pp-math-block');
    const html = renderFormula(katex, source, displayMode);
    if (!html) continue;
    node.innerHTML = html;
    node.classList.add('pp-math-rendered');
    node.setAttribute('role', 'math');
    node.setAttribute('title', source);
  }
}

/**
 * 把 `$...$` / `$$...$$` 文本片段替换成 KaTeX 节点。
 *
 * 只处理单个文本节点内的公式：跨段落的 `$$` 块由作者端 Markdown 渲染器负责，
 * 真实后端不会把多行公式拼进一个文本节点。这样不会为了公式去猜 HTML 结构。
 */
function hydrateMathText(katex: KatexModule, nodes: Text[]): void {
  const pattern = /\$\$([^$]+)\$\$|\$([^$\n]+)\$/g;
  for (const node of nodes) {
    if (!node.isConnected) continue;
    const text = node.nodeValue ?? '';
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    let last = 0;
    let changed = false;
    const fragment = document.createDocumentFragment();

    while ((match = pattern.exec(text))) {
      const isBlock = match[1] !== undefined;
      const source = (isBlock ? match[1] : match[2] ?? '').trim();
      if (!source) continue;
      if (!isBlock && !looksLikeFormula(source)) continue;
      const html = renderFormula(katex, source, isBlock);
      if (!html) continue;

      if (match.index > last) fragment.append(text.slice(last, match.index));
      const span = document.createElement('span');
      span.className = isBlock
        ? 'pp-math-block pp-math-rendered'
        : 'pp-math-inline pp-math-rendered';
      span.setAttribute('data-pp-math', source);
      span.setAttribute('role', 'math');
      span.setAttribute('title', source);
      span.innerHTML = html;
      fragment.append(span);
      last = match.index + match[0].length;
      changed = true;
    }

    if (!changed) continue;
    if (last < text.length) fragment.append(text.slice(last));
    node.parentNode?.replaceChild(fragment, node);
  }
}

/**
 * 在指定根节点里水合公式；没有公式时直接返回 false，不加载 KaTeX 引擎。
 *
 * 从 hook 里拆出来是为了能在测试里直接验证 DOM 结果，也让「先检查、后加载」
 * 的顺序一目了然。`alive` 用来避免组件卸载后仍向旧 DOM 写入。
 */
export async function hydrateArticleMath(
  root: HTMLElement,
  alive: () => boolean = () => true,
): Promise<boolean> {
  const placeholders = placeholderNodes(root);
  const texts = mathTextNodes(root);
  if (!placeholders.length && !texts.length) return false;

  try {
    const katex = await loadKatex();
    if (!alive()) return false;
    hydratePlaceholders(katex, placeholders);
    hydrateMathText(katex, texts);
    return true;
  } catch {
    // 引擎加载失败时保留公式原文，不影响正文阅读。
    return false;
  }
}

/**
 * 在文章正文里水合公式；没有公式时不加载 KaTeX 引擎。
 * 依赖 `html` 重新运行：正文重新渲染后旧的 KaTeX 节点会被 React 覆盖。
 */
export function useArticleMath(html: string | undefined): void {
  useEffect(() => {
    const root = articleContentRoot();
    if (!root) return;
    let alive = true;
    void hydrateArticleMath(root, () => alive);
    return () => {
      alive = false;
    };
  }, [html]);
}
