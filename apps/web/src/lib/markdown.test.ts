import { describe, expect, it } from 'vitest';
import { renderMarkdown, sanitizeHtml, safeUrlAttribute } from './markdown';

function hrefOf(html: string): string | null {
  return new DOMParser().parseFromString(html, 'text/html').querySelector('a')?.getAttribute('href') ?? null;
}

describe('formula Markdown rendering', () => {
  it('renders inline and block formulas as editable safe nodes', () => {
    const html = renderMarkdown('速度是 $v = s/t$。\n\n$$x^2 + y^2 = z^2$$');

    expect(html).toContain('class="pp-math-inline"');
    expect(html).toContain('class="pp-math-block"');
    expect(html).toContain('data-pp-math="v = s/t"');
    expect(html).toContain('data-pp-math="x^2 + y^2 = z^2"');
    expect(html).not.toContain('<script');
  });

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

  it('sanitizes imported formula nodes to text-only content', () => {
    const html = sanitizeHtml(
      '<p class="pp-math-block" data-pp-math="x &lt; y"><strong>unsafe</strong></p>' +
        '<p data-pp-math="should not survive">普通文本</p>',
    );

    const node = new DOMParser()
      .parseFromString(html, 'text/html')
      .querySelector('.pp-math-block');
    expect(node?.textContent).toBe('x < y');
    expect(node?.getAttribute('data-pp-math')).toBeTruthy();
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('should not survive');
  });

  it('round-trips formula attributes idempotently', () => {
    const once = sanitizeHtml(renderMarkdown('速度是 $a < b$。\n\n$$x^2 + y^2 = z^2$$'));

    expect(once).toContain('data-pp-math="a &lt; b"');
    expect(once).toContain('data-pp-math="x^2 + y^2 = z^2"');
    expect(sanitizeHtml(once)).toBe(once);
  });

  it('keeps formula attributes as text even when they carry markup', () => {
    const html = sanitizeHtml('<p class="pp-math-block" data-pp-math="<img src=x onerror=alert(1)>">x</p>');
    const doc = new DOMParser().parseFromString(html, 'text/html');

    expect(doc.querySelector('img, [onerror], script')).toBeNull();
    expect(doc.querySelector('.pp-math-block')?.getAttribute('data-pp-math')).toContain('img');
  });
});

describe('sanitizeHtml URL allowlist', () => {
  // 协议白名单必须在规范化之后判断：DOMParser 已经解码实体，浏览器解析 URL 时
  // 又会丢掉制表符/换行，所以这些写法最终都会变成 javascript:。
  const unsafe: [string, string][] = [
    ['明文协议', 'javascript:alert(1)'],
    ['大写协议', 'JaVaScRiPt:alert(1)'],
    ['前导空格', ' javascript:alert(1)'],
    ['前导制表符', '\tjavascript:alert(1)'],
    ['前导不换行空格', '\u00a0javascript:alert(1)'],
    ['内嵌 NUL', 'java\u0000script:alert(1)'],
    ['内嵌零宽空格', 'java\u200bscript:alert(1)'],
    ['实体制表符', 'java&#9;script:alert(1)'],
    ['实体换行', 'java&#10;script:alert(1)'],
    ['实体回车', 'java&#13;script:alert(1)'],
    ['字面制表符', 'java\tscript:alert(1)'],
    ['字面换行', 'java\nscript:alert(1)'],
    ['制表符在协议末尾', 'javascript\t:alert(1)'],
    ['前导控制字符', '&#1;javascript:alert(1)'],
    ['前导 U+0000', '\u0000javascript:alert(1)'],
    ['实体冒号', 'javascript&colon;alert(1)'],
    ['十六进制实体协议', '&#x6a;avascript:alert(1)'],
    ['十进制实体协议', '&#106;avascript:alert(1)'],
    ['双层转义实体', 'java&amp;#9;script:alert(1)'],
    ['百分号编码协议', '%6a%61vascript:alert(1)'],
    ['vbscript', 'vbscript:msgbox(1)'],
    ['data:text/html', 'data:text/html,<script>alert(1)</script>'],
    ['data:image/svg+xml', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
    ['blob 协议', 'blob:https://example.com/abcd'],
    ['file 协议', 'file:///etc/passwd'],
    ['ftp 协议', 'ftp://example.com/x'],
    ['协议相对地址', '//evil.example/a.png'],
    ['反斜杠地址', '\\\\evil.example/a.png'],
    ['斜杠反斜杠地址', '/\\evil.example/a.png'],
    ['上级目录', '../../etc/passwd'],
    ['首段带冒号', '1javascript:alert(1)'],
  ];

  for (const [label, payload] of unsafe) {
    it(`drops unsafe href (${label})`, () => {
      const html = sanitizeHtml(`<p><a href="${payload}">x</a></p>`);

      expect(hrefOf(html)).toBeNull();
      expect(html.toLowerCase()).not.toContain('javascript:');
      expect(html.toLowerCase()).not.toContain('vbscript:');
      expect(html).not.toContain('alert(1)');
    });
  }

  it('drops the same schemes on src, poster, cite, formaction and data', () => {
    const payload = 'javascript:alert(1)';
    const html = sanitizeHtml(
      `<img src="${payload}" alt="x" />` +
        `<div poster="${payload}"></div>` +
        `<q cite="${payload}">x</q>` +
        `<button formaction="${payload}">x</button>` +
        `<div data="${payload}">x</div>`,
    );

    expect(html.toLowerCase()).not.toContain('javascript');
    expect(html).not.toContain('alert(1)');
    expect(html).toContain('alt="x"');
  });

  it('drops attributes written in upper case', () => {
    const html = sanitizeHtml('<img SRC="https://cdn.example/a.png" ONERROR="alert(1)" />');

    expect(html.toLowerCase()).not.toContain('onerror');
    expect(html).toContain('src="https://cdn.example/a.png"');
  });

  it('removes template content and SVG animation elements', () => {
    const html = sanitizeHtml(
      '<template><img src="https://cdn.example/a.png" onerror="alert(1)" /></template>' +
        '<svg><a href="https://example.com"><animate attributeName="href" values="javascript:alert(1)" /></a></svg>',
    );

    expect(html.toLowerCase()).not.toContain('template');
    expect(html.toLowerCase()).not.toContain('animate');
    expect(html).not.toContain('alert(1)');
  });

  it('keeps a safe xlink:href inside inline SVG', () => {
    const html = sanitizeHtml('<svg><a xlink:href="https://example.com/x">x</a></svg>');

    expect(html).toContain('xlink:href="https://example.com/x"');
  });

  it('keeps base64 raster data URLs inside srcset', () => {
    const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const html = sanitizeHtml(`<img srcset="${gif} 1x, https://cdn.example/a.png 2x" alt="x" />`);

    expect(html).toContain('srcset=');
    expect(html).toContain('https://cdn.example/a.png 2x');
  });

  it('treats a scheme-like word without a colon as a relative path', () => {
    // 没有冒号就不是协议，浏览器会当成站内相对地址解析（/javascript），无法执行。
    expect(safeUrlAttribute('href', 'javascript')).toBe('javascript');
    expect(safeUrlAttribute('href', 'javascript:alert(1)')).toBeNull();
  });

  it('drops javascript: in xlink:href', () => {
    const html = safeUrlAttribute('xlink:href', 'javascript:alert(1)');

    expect(html).toBeNull();
  });

  it('drops javascript: in xlink:href inside inline SVG', () => {
    const html = sanitizeHtml('<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>');

    expect(html.toLowerCase()).not.toContain('javascript');
    expect(html.toLowerCase()).not.toContain('xlink:href');
  });

  it('drops a srcset that mixes a good candidate with javascript:', () => {
    const html = sanitizeHtml(
      '<img src="https://cdn.example/ok.png" srcset="https://cdn.example/ok.png 1x, javascript:alert(1) 2x" alt="x" />',
    );

    expect(html).not.toContain('srcset');
    expect(html).toContain('src="https://cdn.example/ok.png"');
    expect(html).not.toContain('alert(1)');
  });

  it('drops an encoded javascript: candidate inside srcset', () => {
    const html = sanitizeHtml(
      '<img srcset="https://cdn.example/ok.png 1x, java&#9;script:alert(1) 2x" alt="x" />',
    );

    expect(html).not.toContain('srcset');
    expect(html).not.toContain('alert(1)');
  });

  it('keeps a well-formed srcset with descriptors', () => {
    const html = sanitizeHtml(
      '<img src="https://cdn.example/a.png" srcset="https://cdn.example/a.png 1x, https://cdn.example/b.png 2x" alt="x" />',
    );

    expect(html).toContain('srcset="https://cdn.example/a.png 1x, https://cdn.example/b.png 2x"');
  });

  it('keeps base64 raster data URLs but rejects svg data URLs', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(sanitizeHtml(`<img src="${png}" alt="x" />`)).toContain(`src="${png}"`);

    const svg = sanitizeHtml('<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="x" />');
    expect(svg).not.toContain('src=');
  });

  it('drops event handlers, srcdoc and inline style', () => {
    const html = sanitizeHtml(
      '<img src="https://cdn.example/a.png" onerror="alert(1)" />' +
        '<iframe srcdoc="<p>inline</p>"></iframe>' +
        '<script>void 0</script>' +
        '<p style="background:url(javascript:alert(1))">x</p>',
    );

    expect(html.toLowerCase()).not.toContain('onerror');
    expect(html.toLowerCase()).not.toContain('srcdoc');
    expect(html.toLowerCase()).not.toContain('<iframe');
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html.toLowerCase()).not.toContain('style=');
    expect(html).not.toContain('alert(1)');
  });

  it('keeps ordinary links, anchors, relative paths and mailto', () => {
    const html = sanitizeHtml(
      '<p>' +
        '<a href="https://example.com/a?b=1#c">one</a>' +
        '<a href="/posts/hello">two</a>' +
        '<a href="#top">three</a>' +
        '<a href="mailto:hi@example.com">four</a>' +
        '<a href="tel:+8610000000000">five</a>' +
        '<a href="relative/path">six</a>' +
        '<img src="https://cdn.example/x.png" alt="x" />' +
        '</p>',
    );

    expect(html).toContain('href="https://example.com/a?b=1#c"');
    expect(html).toContain('href="/posts/hello"');
    expect(html).toContain('href="#top"');
    expect(html).toContain('href="mailto:hi@example.com"');
    expect(html).toContain('href="tel:+8610000000000"');
    expect(html).toContain('href="relative/path"');
    expect(html).toContain('src="https://cdn.example/x.png"');
  });

  it('is idempotent for already-clean markup', () => {
    const source =
      '<p class="lead" data-block-id="b1"><a href="https://example.com">x</a>' +
      '<code class="language-ts">const a = 1;</code></p>';
    const once = sanitizeHtml(source);

    expect(once).toContain('class="language-ts"');
    expect(once).toContain('data-block-id="b1"');
    expect(sanitizeHtml(once)).toBe(once);
  });

  it('never builds a markdown link from a non-https URL', () => {
    const html = renderMarkdown('[bad](javascript:alert(1)) [worse](java\tscript:alert(1))');

    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href');
  });

  it('keeps table alignment and code language classes', () => {
    const html = renderMarkdown('| a | b |\n| :---: | ---: |\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```');

    expect(html).toContain('class="pp-align-center"');
    expect(html).toContain('class="pp-align-right"');
    expect(html).toContain('class="language-ts"');
  });
});
