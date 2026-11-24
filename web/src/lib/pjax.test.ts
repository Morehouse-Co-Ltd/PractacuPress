import { describe, expect, it } from 'vitest';
import { resolvePjaxTarget } from './pjax';

function anchor(href: string): HTMLAnchorElement {
  const element = document.createElement('a');
  element.href = href;
  return element;
}

describe('resolvePjaxTarget', () => {
  const current = 'http://localhost:8080/articles';

  it('accepts same-origin page links', () => {
    expect(resolvePjaxTarget(anchor('/a/post-1?from=home#top'), current)?.pathname).toBe(
      '/a/post-1',
    );
  });

  it('rejects external, API, plugin and crawler targets', () => {
    expect(resolvePjaxTarget(anchor('https://example.com/post'), current)).toBeNull();
    expect(resolvePjaxTarget(anchor('/api/v1/articles'), current)).toBeNull();
    expect(resolvePjaxTarget(anchor('/plugins/demo/1/client.js'), current)).toBeNull();
    expect(resolvePjaxTarget(anchor('/sitemap.xml'), current)).toBeNull();
  });

  it('leaves downloads, new tabs and opted-out links to the browser', () => {
    const download = anchor('/files/report.pdf');
    download.setAttribute('download', '');
    expect(resolvePjaxTarget(download, current)).toBeNull();

    const blank = anchor('/post');
    blank.target = '_blank';
    expect(resolvePjaxTarget(blank, current)).toBeNull();

    const optedOut = anchor('/post');
    optedOut.dataset.pjax = 'off';
    expect(resolvePjaxTarget(optedOut, current)).toBeNull();
  });

  it('does not hijack in-page anchors or a link to the current page', () => {
    expect(resolvePjaxTarget(anchor('#section'), current)).toBeNull();
    expect(resolvePjaxTarget(anchor('/articles#section'), current)).toBeNull();
    expect(resolvePjaxTarget(anchor('/articles'), current)).toBeNull();
  });
});
