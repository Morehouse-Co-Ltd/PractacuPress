import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from './htmlToMarkdown';
import { linkCardBlock } from './richBlocks';
import { renderMarkdown } from './markdown';

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

  it('preserves multiline block formula delimiters', () => {
    const markdown = htmlToMarkdown(
      '<p class="pp-math-block" data-pp-math="x^2\ny^2">x^2\ny^2</p>',
    );

    expect(markdown).toContain('$$\nx^2\ny^2\n$$');
  });

  it('uses the formula attribute as the serialization source', () => {
    const markdown = htmlToMarkdown(
      '<p><span class="pp-math-inline" data-pp-math="old">new</span></p>',
    );

    expect(markdown).toContain('$old$');
  });

  it('keeps existing special blocks as HTML while serializing normal text', () => {
    const markdown = htmlToMarkdown(
      '<p>正文 <strong>重点</strong></p>' +
        '<a class="pp-embed" href="https://example.com"><strong>网站</strong></a>',
    );

    expect(markdown).toContain('正文 **重点**');
    expect(markdown).toContain(
      '<a class="pp-embed" href="https://example.com"><strong>网站</strong></a>',
    );
  });

  it('keeps a soft line break inside one paragraph', () => {
    // 段内换行只是一行文字里的断行，存成空行会把一段拆成两段（段落数错位）。
    expect(htmlToMarkdown('<p>第一行<br>第二行</p>')).toBe('第一行\n第二行\n');
  });

  it('keeps two paragraphs apart', () => {
    expect(htmlToMarkdown('<p>一</p><p>二</p>')).toBe('一\n\n二\n');
  });

  it('ignores editor overlays that leaked into the content', () => {
    expect(htmlToMarkdown('<p><span data-pp-marker="1">##</span>标题</p>')).toBe('标题\n');
  });
});

describe('link cards', () => {
  const card = () =>
    linkCardBlock({
      url: 'https://example.com/articles/hello',
      title: '一篇文章的标题',
      description: '一句话说明',
      cover: 'https://img.example.com/cover.png',
    });

  it('serializes a card as an HTML block instead of a markdown link', () => {
    const markdown = htmlToMarkdown(`<p>正文</p>${card()}`);

    expect(markdown).toContain('正文');
    expect(markdown).toContain('class="pp-linkcard"');
    expect(markdown).toContain('href="https://example.com/articles/hello"');
    expect(markdown).toContain('pp-linkcard-cover');
    expect(markdown).not.toContain('[一篇文章的标题](https://example.com/articles/hello)');
  });

  it('round-trips card HTML through markdown without losing the block', () => {
    const first = htmlToMarkdown(card());
    const html = renderMarkdown(first);

    // 渲染器把原始 HTML 区块交给 sanitizeHtml，class 与 img 都应保留。
    expect(html).toContain('class="pp-linkcard"');
    expect(html).toContain('href="https://example.com/articles/hello"');
    expect(html).toContain('class="pp-linkcard-cover"');
    expect(html).toContain('<strong>一篇文章的标题</strong>');
    expect(html).toContain('example.com · 一句话说明');

    // 再序列化一次应该与第一次完全一致（往返无损）。
    expect(htmlToMarkdown(html)).toBe(first);
  });

  it('uses the plain variant without a cover image', () => {
    const markdown = htmlToMarkdown(
      linkCardBlock({ url: 'https://example.com', title: '无封面', description: '' }),
    );

    expect(markdown).toContain('class="pp-linkcard pp-linkcard-plain"');
    expect(markdown).not.toContain('pp-linkcard-cover');
    expect(markdown).toContain('<strong>无封面</strong>');
    expect(markdown).toContain('<em>example.com</em>');
  });

  it('keeps a card that the editor nested inside a paragraph', () => {
    // contenteditable 的 insertHTML 可能把内联的 <a> 塞进段落里。
    const markdown = htmlToMarkdown(
      '<p><a class="pp-linkcard" href="https://example.com/x"><strong>标题</strong><br /><em>example.com</em></a></p>',
    );

    expect(markdown).toContain('class="pp-linkcard"');
    expect(markdown).toContain('href="https://example.com/x"');
    expect(markdown).not.toContain('](https://example.com/x)');
  });

  it('does not break the legacy video and embed cards', () => {
    const markdown = htmlToMarkdown(
      '<a class="pp-video" href="https://example.com/v"><strong>视频</strong></a>' +
        '<a class="pp-embed" href="https://example.com/e"><strong>嵌入</strong></a>',
    );
    const html = renderMarkdown(markdown);

    expect(html).toContain('class="pp-video"');
    expect(html).toContain('class="pp-embed"');
    expect(html).toContain('href="https://example.com/v"');
    expect(html).toContain('href="https://example.com/e"');
  });

  it('escapes every author supplied field', () => {
    const html = linkCardBlock({
      url: 'https://example.com/?a=1&b=2',
      title: '<script>alert(1)</script>',
      description: '"引号" 与 <b>标签</b>',
      cover: 'https://img.example.com/x.png?x="1"&y=2',
    });

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;b=2');
    expect(html).toContain('&quot;引号&quot;');
  });
});
