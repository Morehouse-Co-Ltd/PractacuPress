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
