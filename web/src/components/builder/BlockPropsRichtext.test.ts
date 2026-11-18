import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BlockProps } from './BlockProps';
import { createBlock } from '../../lib/blocks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `richtext` 属性的表单控件。
 *
 * 走真实渲染而不是看 schema：这里是唯一把「Markdown 原文」交给渲染链路的地方，
 * 预览必须和 `text` 区块用同一套 renderMarkdown + sanitizeHtml。写死一条「脚本被删掉」
 * 的断言，是为了挡住以后有人为预览另写一条轻量渲染路径。
 */

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(type: string, props: Record<string, string>) {
  const block = createBlock(type);
  block.props = { ...block.props, ...props };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(createElement(BlockProps, { block, onChange: () => {} }));
  });
  return { host, id: block.id };
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

function previewToggle(host: HTMLElement): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((node) => node.getAttribute('aria-expanded'));
}

describe('richtext 属性控件', () => {
  it('正文是一个 140px 高的文本域，预览默认收起', () => {
    const { host: view, id } = mount('text', { body: '**粗体**' });
    const area = view.querySelector(`#blk-${id}-body`) as HTMLTextAreaElement;
    expect(area.value).toBe('**粗体**');
    expect(area.style.minHeight).toBe('140px');
    expect(view.querySelector('.richtext-preview')).toBeNull();
    expect(previewToggle(view)?.textContent).toContain('预览');
  });

  it('展开预览走同一套 Markdown + 清洗：脚本与事件处理器都不留', () => {
    const body = '**粗体**\n\n<script>alert(1)</script>\n\n<img src="x" onerror="alert(2)">';
    const { host: view } = mount('text', { body });
    const toggle = previewToggle(view);
    act(() => toggle?.click());
    const preview = view.querySelector('.richtext-preview') as HTMLElement;
    expect(preview.innerHTML).toContain('<strong>粗体</strong>');
    expect(preview.innerHTML).not.toContain('<script');
    expect(preview.innerHTML).not.toContain('onerror');
    expect(previewToggle(view)?.getAttribute('aria-expanded')).toBe('true');
  });

  it('正文为空时不显示预览开关', () => {
    const { host: view } = mount('text', { body: '' });
    expect(previewToggle(view)).toBeUndefined();
  });
});
