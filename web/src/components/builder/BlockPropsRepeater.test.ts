import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BlockProps } from './BlockProps';
import { createBlock } from '../../lib/blocks';
import type { BlockProps as BlockPropsValue } from '../../types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(block = createBlock('button'), onChange: (props: BlockPropsValue) => void = () => {}) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(createElement(BlockProps, { block, onChange }));
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

function rowInputs(host: HTMLElement) {
  return [...host.querySelectorAll('.itemlist-row input[type="text"]')] as HTMLInputElement[];
}

/**
 * repeater 属性表单：按钮区块用真实的数组而不是 JSON 字符串。
 *
 * 走真实渲染而不是纯函数，因为增 / 删 / 改这条路径全在 JSX 里：
 * 只有点一次「添加」、改一行输入，才能确认写回的是数组、而且只改命中的那一条。
 */
describe('repeater 属性表单', () => {
  it('空按钮列表：显示添加按钮，没有行', () => {
    const host = mount();
    expect(host.querySelectorAll('.itemlist-row').length).toBe(0);
    expect(host.textContent).toContain('添加按钮');
    expect(host.querySelector('.field-aside')?.textContent ?? host.textContent).toContain('0/4');
  });

  it('点添加写入一个空白条目', () => {
    let latest: BlockPropsValue = {};
    const host = mount(createBlock('button'), (props) => {
      latest = props;
    });
    const add = [...host.querySelectorAll('button')].find((node) => node.textContent?.includes('添加'));
    act(() => add?.click());
    expect(latest.buttons).toEqual([{ label: '', link: '', style: '' }]);
  });

  it('编辑某一条的标签只改那一条', () => {
    const block = createBlock('button');
    block.props = {
      buttons: [
        { label: '去', link: '/a', style: 'solid' },
        { label: '二', link: '/b', style: 'ghost' },
      ],
    };
    let latest: BlockPropsValue = {};
    const host = mount(block, (props) => {
      latest = props;
    });
    const inputs = rowInputs(host);
    expect(inputs.map((input) => input.value)).toEqual(['去', '/a', '二', '/b']);
    const first = inputs[0];
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(first, '走了');
      first.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(latest.buttons).toEqual([
      { label: '走了', link: '/a', style: 'solid' },
      { label: '二', link: '/b', style: 'ghost' },
    ]);
  });

  it('minItems 为 1 时最后一条不能删', () => {
    const block = createBlock('button');
    block.props = { buttons: [{ label: '唯一', link: '', style: '' }] };
    const host = mount(block);
    const del = [...host.querySelectorAll('button')].find((node) => node.textContent === '删除');
    expect((del as HTMLButtonElement).disabled).toBe(true);
  });

  it('达到 maxItems 后添加按钮禁用', () => {
    const block = createBlock('button');
    block.props = {
      buttons: Array.from({ length: 4 }, (_, i) => ({ label: `b${i}`, link: '/', style: 'solid' })),
    };
    const host = mount(block);
    const add = [...host.querySelectorAll('button')].find((node) => node.textContent?.includes('添加'));
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect(host.querySelectorAll('.itemlist-row').length).toBe(4);
  });
});
